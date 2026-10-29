/* ============================================================
   pancode-cli · LLM 配置向导（/llm add）
   ------------------------------------------------------------
   交互式流程：
     1. 输入 baseURL（回车保留当前）
     2. 输入 API Key（回车保留当前，输入留空可跳过）
     3. 自动拉取 /v1/models 模型列表
     4. ↑↓ 选择模型（或手动输入）
     5. 输入配置名 → 保存为 profile → 应用
   ============================================================ */
"use strict";

const S = require("./style");
const config = require("./config-loader");

/* ---------- 拉取模型列表 ---------- */
async function fetchModels(baseURL, apiKey, opts) {
  opts = opts || {};
  const base = config.normalizeBaseURL(baseURL);
  /* OpenAI 兼容：GET /v1/models；有些网关 baseURL 已含 /v1，有些没有 */
  let url = base.replace(/\/+$/, "");
  if (!/\/v\d+$/.test(url)) url += "/v1";
  url += "/models";

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 10000);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: "HTTP " + res.status + " " + res.statusText, body: body.slice(0, 200) };
    }
    const json = await res.json();
    /* OpenAI 格式：{ data: [{ id, ... }] }；有些网关直接返回数组 */
    let list;
    if (Array.isArray(json)) list = json;
    else if (json && Array.isArray(json.data)) list = json.data;
    else if (json && Array.isArray(json.models)) list = json.models;
    else list = [];
    const ids = list.map((m) => (typeof m === "string" ? m : (m && m.id) || (m && m.name) || "")).filter(Boolean).sort();
    return { ok: true, models: ids, raw: list };
  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: "请求超时（10s）" };
    return { ok: false, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 统一输入函数（raw stdin 直读，不依赖 readline，消除双监听器冲突） ----------
    mask=false 普通回显；mask=true 密码回显 * */
function askRaw(question, defaultVal, mask) {
  return new Promise((resolve) => {
    const hint = defaultVal
      ? S.dim(mask ? "（回车保留 …" + String(defaultVal).slice(-4) + "）" : "（回车保留 " + defaultVal + "）")
      : (mask ? S.dim("（留空跳过）") : "");
    process.stdout.write(S.accent("› ") + question + " " + hint + " ");

    let rawOk = false;
    try { if (process.stdin.isTTY) { process.stdin.setRawMode(true); rawOk = true; } } catch (_) {}
    process.stdin.resume();

    let buf = "";
    const onData = (ch) => {
      /* 逐字符处理——粘贴时 stdin 一次发一整块，不能当单字符比 */
      for (const c of ch.toString()) {
        if (c === "\r" || c === "\n") {
          cleanup();
          process.stdout.write("\n");
          const v = buf.trim();
          resolve(v || (defaultVal != null ? defaultVal : ""));
          return;
        } else if (c === "\u0003") {
          cleanup();
          resolve(null);
          return;
        } else if (c === "\u007f" || c === "\b") {
          if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); }
        } else if (c >= " " && c !== "\x1b") {
          buf += c;
          process.stdout.write(mask ? "*" : c);
        }
      }
    };
    function cleanup() {
      process.stdin.removeListener("data", onData);
      if (rawOk) { try { process.stdin.setRawMode(false); } catch (_) {} }
    }
    process.stdin.on("data", onData);
  });
}

/* 兼容旧调用：ask(rl, question, defaultVal) → askRaw(question, defaultVal, false) */
function ask(rl, question, defaultVal) { return askRaw(question, defaultVal, false); }
function askSecret(rl, question, defaultVal) { return askRaw(question, defaultVal, true); }

/* ---------- 模型选择列表（↑↓ + Enter） ---------- */
function selectModel(models) {
  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: null, terminal: true });
    let selected = 0;
    let scroll = 0;
    const MAX_SHOW = 12;
    let customMode = false;
    let customInput = "";
    let prevRows = 0;
    let cursorRow = 0;  /* 光标在框内的行号（0-indexed），供下次 draw 上移用 */

    try { process.stdin.setRawMode(true); } catch (_) {}
    process.stdin.resume();

    function draw() {
      const cols = process.stdout.columns || 80;
      const w = Math.min(cols, 72);
      /* 上移到框顶：光标在框内 cursorRow 行，上移 cursorRow 即可。
         之前用 prevRows 是错的——customMode 下光标被移到输入行（非框底），
         再上移 prevRows 会冲到框上方。 */
      if (cursorRow > 0) process.stdout.write("\x1b[" + cursorRow + "A");
      process.stdout.write("\r\x1b[J");
      let linesWritten = 0;
      process.stdout.write(S.promptBorder("┌─ ") + S.accent("选择模型") + S.dim("（共 " + models.length + " 个）") + " ".repeat(Math.max(0, w - 20)) + S.promptBorder("┐") + "\n"); linesWritten++;

      if (customMode) {
        process.stdout.write(S.promptBorder("│") + S.accent("手动输入：") + customInput + S.dim("█") + " ".repeat(Math.max(0, w - 12 - customInput.length - 2)) + S.promptBorder("│") + "\n"); linesWritten++;
      } else {
        const start = scroll;
        const visible = models.slice(start, start + MAX_SHOW);
        visible.forEach((m, i) => {
          const idx = start + i;
          const isSel = idx === selected;
          const prefix = isSel ? S.accent("▸ ") : "  ";
          const label = isSel ? S.accent(S.mod.bold(m)) : S.text(m);
          const pad = " ".repeat(Math.max(0, w - 2 - S.stripLen(prefix + label)));
          process.stdout.write(S.promptBorder("│") + prefix + label + pad + S.promptBorder("│") + "\n"); linesWritten++;
        });
        /* 滚动提示 */
        if (models.length > MAX_SHOW) {
          const info = S.dim("  " + (scroll + 1) + "–" + Math.min(scroll + MAX_SHOW, models.length) + " / " + models.length);
          process.stdout.write(S.promptBorder("│") + info + " ".repeat(Math.max(0, w - 2 - S.stripLen(info))) + S.promptBorder("│") + "\n"); linesWritten++;
        }
      }
      process.stdout.write(S.promptBorder("└") + "─".repeat(Math.max(0, w - 2)) + S.promptBorder("┘") + "\n"); linesWritten++;
      process.stdout.write(S.dim("  ↑↓ 选择 · Enter 确认 · Tab 手动输入 · Esc 取消") + "\n"); linesWritten++;
      prevRows = linesWritten;

      /* 光标归位到输入行（customMode 时） */
      if (customMode) {
        /* 光标在内容下方新行，上移到第 2 行（手动输入行，0-indexed=1） */
        const up = linesWritten - 1;
        cursorRow = 1;  /* 光标在框内第 1 行（输入行） */
        process.stdout.write("\x1b[" + up + "A\r\x1b[" + (10 + customInput.length + 1) + "C");
      } else {
        /* 非自定义模式：每行以 \n 结尾，光标在内容下方新行，cursorRow = linesWritten */
        cursorRow = linesWritten;
      }
    }

    function close(val) {
      /* 上移到框顶：光标在框内 cursorRow 行，上移 cursorRow 即可 */
      if (cursorRow > 0) process.stdout.write("\x1b[" + cursorRow + "A");
      process.stdout.write("\r\x1b[J");
      rl.input.removeListener("keypress", onKeypress);
      rl.close();
      try { process.stdin.setRawMode(false); } catch (_) {}
      resolve(val);
    }

    draw();

    const onKeypress = (ch, key) => {
      if (!key) return;
      if (key.name === "escape" || (key.ctrl && key.name === "c")) { close(null); return; }
      if (customMode) {
        if (key.name === "return") { close(customInput.trim() || null); return; }
        if (key.name === "backspace") { customInput = customInput.slice(0, -1); draw(); return; }
        if (ch && !key.ctrl && !key.meta && ch >= " ") { customInput += ch; draw(); return; }
        return;
      }
      if (key.name === "tab") { customMode = true; customInput = models[selected] || ""; draw(); return; }
      if (key.name === "up") { if (models.length) { selected = (selected - 1 + models.length) % models.length; if (selected < scroll) scroll = selected; draw(); } return; }
      if (key.name === "down") { if (models.length) { selected = (selected + 1) % models.length; if (selected >= scroll + MAX_SHOW) scroll = selected - MAX_SHOW + 1; draw(); } return; }
      if (key.name === "return") { close(models[selected] || null); return; }
    };

    rl.input.on("keypress", onKeypress);
  });
}

/* ---------- 完整向导 ---------- */
async function wizard(cfg) {
  try {
    process.stdout.write(S.accent("\n╭─ LLM 配置向导 ───────────────────────╮\n"));
    process.stdout.write(S.dim("  │  输入 URL + Key → 拉取模型 → 选择  │\n"));
    process.stdout.write(S.accent("╰──────────────────────────────────────╯\n\n"));

    /* 1. baseURL */
    const curURL = (cfg.llm && cfg.llm.baseURL) || "";
    const baseURL = await askRaw("API Base URL", curURL, false);
    if (!baseURL) { process.stdout.write(S.err("  URL 不能为空\n")); return null; }

    /* 2. API Key */
    const curKey = (cfg.llm && cfg.llm.apiKey) || "";
    const apiKey = await askRaw("API Key", curKey, true);
    if (apiKey === null) { process.stdout.write(S.dim("  已取消\n")); return null; }

    /* 3. 拉取模型列表 */
    process.stdout.write(S.dim("  正在拉取模型列表…\n"));
    const r = await fetchModels(baseURL, apiKey);
    if (!r.ok) {
      process.stdout.write(S.err("  拉取失败：" + r.error + "\n"));
      if (r.body) process.stdout.write(S.dim("  响应：" + r.body + "\n"));
      /* 允许手动输入 */
      const manual = await askRaw("手动输入模型名", "", false);
      if (!manual) { process.stdout.write(S.dim("  已取消\n")); return null; }
      return await finalize(cfg, baseURL, apiKey, manual);
    }

    if (!r.models.length) {
      process.stdout.write(S.warn("  ⚠ 返回的模型列表为空\n"));
      const manual = await askRaw("手动输入模型名", "", false);
      if (!manual) { process.stdout.write(S.dim("  已取消\n")); return null; }
      return await finalize(cfg, baseURL, apiKey, manual);
    }

    process.stdout.write(S.ok("  ✓ 拉取到 " + r.models.length + " 个模型\n\n"));

    /* 4. 选择模型 */
    const model = await selectModel(r.models);
    if (!model) { process.stdout.write(S.dim("  已取消\n")); return null; }

    /* 5. 保存 */
    return await finalize(cfg, baseURL, apiKey, model);
  } catch (e) {
    process.stdout.write(S.err("  向导出错：" + e.message + "\n"));
    return null;
  }
}

async function finalize(cfg, baseURL, apiKey, model) {
  /* 配置名 */
  const defaultName = baseURL.replace(/^https?:\/\//, "").slice(0, 28);
  const name = await askRaw("配置名", defaultName, false);

  /* 保存为 profile */
  const profile = config.upsertLlmProfile(cfg, { name, baseURL, apiKey, model });

  /* 立即应用 */
  config.saveLlm(cfg, { baseURL, apiKey, model });

  process.stdout.write(S.ok("\n  ✓ 已保存并应用\n"));
  process.stdout.write(S.dim("    名称：") + name + "\n");
  process.stdout.write(S.dim("    URL： ") + baseURL + "\n");
  process.stdout.write(S.dim("    模型：") + model + "\n");
  process.stdout.write(S.dim("    Key：  …") + apiKey.slice(-4) + "\n");
  process.stdout.write(S.dim("    ID：  ") + profile.id + "\n\n");

  return profile;
}

/* ---------- 测试连接 ---------- */
async function testConnection(cfg) {
  const baseURL = (cfg.llm && cfg.llm.baseURL) || "";
  const apiKey = (cfg.llm && cfg.llm.apiKey) || "";
  if (!baseURL) return { ok: false, error: "未配置 baseURL" };
  process.stdout.write(S.dim("  测试 " + baseURL + " …\n"));
  const r = await fetchModels(baseURL, apiKey, { timeout: 8000 });
  if (r.ok) {
    process.stdout.write(S.ok("  ✓ 连接成功，" + r.models.length + " 个模型可用\n"));
    if (r.models.length) {
      process.stdout.write(S.dim("  前 10 个：\n"));
      r.models.slice(0, 10).forEach((m) => process.stdout.write(S.indent(S.dim("  • ") + m, 1) + "\n"));
    }
  } else {
    process.stdout.write(S.err("  ✗ " + r.error + "\n"));
  }
  return r;
}

module.exports = { fetchModels, wizard, testConnection, selectModel };
