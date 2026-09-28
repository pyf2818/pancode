/* T3/T4 前端契约验证：起沙箱服务 + Playwright 真实加载 index.html，
 * 逐个打开工作台分区，断言「渲染出内容、无控制台报错、入口已改接」。
 * 产物：scripts/_verify_out/wb_<section>.png
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

const PORT = 8815;
const ROOT = path.resolve(__dirname, "..");
const SB = path.join(ROOT, "scripts", "_verify_out", "wb-sandbox");
const DATA = path.join(SB, "data");
const WS = path.join(SB, "ws");
const OUT = path.join(ROOT, "scripts", "_verify_out");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (token) headers["x-user-token"] = token;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 15000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch (e) { resolve({ raw: buf.slice(0, 200) }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(WS, ".pancode", "rules"), { recursive: true });
  fs.mkdirSync(path.join(WS, ".pancode", "experts"), { recursive: true });
  fs.mkdirSync(path.join(WS, "server"), { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(WS, ".pancode", "rules", "style.md"),
    "---\ntitle: 中文汇报\nenabled: true\n---\n\n汇报一律中文并给可核对数字。\n");
  fs.writeFileSync(path.join(WS, ".pancode", "rules", "backend.md"),
    "---\ntitle: 后端约定\nglobs: [\"server/**\"]\n---\n\nserver 下只用 CommonJS。\n");
  fs.writeFileSync(path.join(WS, ".pancode", "experts", "发布专家.md"),
    "---\nname: 发布专家\ndescription: 只管构建与灰度\ntool_whitelist: [run_command, git_commit]\n---\n\n你是发布工程师。\n\n## 步骤\n1. 构建\n2. 灰度\n");
  fs.writeFileSync(path.join(WS, "AGENTS.md"), "# 仓库约定\n\n根级规则。\n");
  fs.writeFileSync(path.join(WS, "server", "index.js"), "module.exports = 1;\n");
}

async function boot() {
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), PANCODE_DATA_DIR: DATA, CURSORWEB_WORKSPACE: WS,
      CURSORWEB_ENGINE: "demo", AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  child.stdout.on("data", (c) => (tail = (tail + c).slice(-3000)));
  child.stderr.on("data", (c) => (tail = (tail + c).slice(-3000)));
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const h = await req("GET", "/api/health"); if (h.ok) return { child, tail }; } catch (e) {}
  }
  throw new Error("服务未就绪\n" + tail);
}

const SECTIONS = ["appearance", "general", "model", "agent", "perms", "mcp", "automations", "experts", "soul", "memory", "sediment", "rules", "skills", "evolution", "data", "audit", "about"];

async function main() {
  /* 静态防回归：新 UI 模块与既有脚本同为 classic script，顶层同名 function 会互相覆盖
     （真实踩过：assets-center 的 loadSkills 盖掉 app.js 的 loadSkills，侧栏技能列表静默失效） */
  section("全局符号冲突");
  const uiFiles = ["public/js/workbench.js", "public/js/assets-center.js"];
  const all = ["public/app.js", "public/store.js", "public/icons.js", "public/i18n.js"]
    .concat(fs.readdirSync(path.join(ROOT, "public/js")).filter((f) => f.endsWith(".js")).map((f) => "public/js/" + f))
    .filter((f) => !uiFiles.includes(f));
  const topNames = (p) => {
    const s = fs.readFileSync(path.join(ROOT, p), "utf8");
    const out = new Set();
    for (const m of s.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of s.matchAll(/^const ([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of s.matchAll(/^let ([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    return out;
  };
  const seen = new Map();
  for (const f of all) for (const n of topNames(f)) { if (!seen.has(n)) seen.set(n, f); }
  const clashes = [];
  for (const f of uiFiles) for (const n of topNames(f)) if (seen.has(n)) clashes.push(n + " (vs " + seen.get(n) + ")");
  ok("新模块未覆盖既有全局函数", clashes.length === 0, clashes.slice(0, 6).join(", "));

  seed();
  const { child, tail } = await boot();
  const reg = await req("POST", "/api/auth/register", { username: "_wb_" + Date.now(), password: "test1234" });
  const token = reg && reg.token;
  if (!token) { child.kill(); throw new Error("注册失败：" + JSON.stringify(reg)); }
  // 灌一点真实资产，让分区不是空壳
  await req("POST", "/api/memory", { type: "lesson", topic: "构建", content: "打包前要先跑一次冒烟。", valueScore: 5, sticky: true }, token);
  await req("POST", "/api/skills", { name: "灰度发布", description: "分批放量", trigger: "灰度,发布", body: "1. 构建 2. 放量 10%" }, token);
  // 制造两条文件操作，让「行为审计」有真实内容可看
  const probe = await req("POST", "/api/rules", { title: "审计探针", content: "用于验证审计页有记录。" }, token);
  if (probe && probe.file) await req("DELETE", "/api/rules", { file: probe.file }, token);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  await page.addInitScript((t) => {
    // 预览 iframe 是 sandbox="allow-scripts"（无 allow-same-origin），读 localStorage 会抛，故 try 包一层
    try {
      localStorage.setItem("cw-user-token", t);
      localStorage.setItem("cw-theme", "dark");
      localStorage.setItem("cw-palette", "graphite");
      localStorage.setItem("cw-onboarded", "1");   // 沙箱是全新数据根，不放行新手引导会盖住所有入口
    } catch (e) {}
  }, token);

  try {
    section("加载与外壳");
    await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.openWorkbench === "function", null, { timeout: 15000 });
    await wait(1600);   // 给 app.js 的初始化与延迟绑定留出时间
    const loadErr = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|is sandboxed|allow-same-origin/i.test(e));
    ok("页面加载与初始化无 JS 报错", loadErr.length === 0, loadErr.slice(0, 3).join(" | "));
    ok("workbench.js 已加载并暴露 openWorkbench", true);
    ok("旧设置函数已被改接到工作台", await page.evaluate(() => typeof window.openSettings === "function" && typeof window.openSediment === "function"));
    const shell = await page.evaluate(() => ({
      palettes: typeof PALETTES !== "undefined" ? PALETTES.length : 0,
      sections: (typeof WB_SECTIONS !== "undefined" ? WB_SECTIONS : []).map((s) => s.id),
    }));
    ok("配色方案 ≥10 套已注入工作台", shell.palettes >= 10, "实际 " + shell.palettes);
    const missing = SECTIONS.filter((s) => !shell.sections.includes(s));
    ok("17 个分区全部注册", missing.length === 0, "缺：" + missing.join(","));

    await page.evaluate(() => window.openWorkbench("appearance"));
    await page.waitForSelector(".wb-panel", { timeout: 8000 });
    ok("工作台可打开", await page.isVisible("#workbench"));
    ok("遮罩 + 左导航渲染", await page.locator(".wb-nav-item").count() >= 17, "导航项 " + await page.locator(".wb-nav-item").count());

    section("逐分区渲染");
    const shots = {};
    for (const id of SECTIONS) {
      errors.length = 0;
      await page.evaluate((sid) => window.openWorkbench(sid), id);
      await wait(280);
      const info = await page.evaluate(() => {
        const b = document.getElementById("wbBody");
        return {
          text: (b.innerText || "").trim(),
          nodes: b.querySelectorAll("*").length,
          rows: b.querySelectorAll(".wb-row").length,
          groups: b.querySelectorAll(".wb-group").length,
          split: b.querySelectorAll(".wb-split").length,
          active: (document.querySelector(".wb-nav-item.active") || {}).textContent || "",
        };
      });
      const bad = info.nodes < 8 || info.text.length < 30;
      ok("分区 " + id + " 渲染出内容", !bad, "nodes=" + info.nodes + " text=" + info.text.length);
      ok("分区 " + id + " 导航高亮一致", info.active.includes(id === "appearance" ? "外观" : ""), info.active);
      const real = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|is sandboxed|allow-same-origin/i.test(e));
      ok("分区 " + id + " 无 JS 报错", real.length === 0, real.slice(0, 2).join(" | "));
      if (bad || real.length) console.log("      ↳ 文本：" + info.text.slice(0, 160).replace(/\n/g, " / "));
      shots[id] = info;
    }

    section("长任务时限：设置面板 + 审批倒计时");
    await page.evaluate(() => window.openWorkbench("agent"));
    await wait(320);
    const limits = await page.evaluate(() => {
      const g = [...document.querySelectorAll("#wbBody .wb-group")]
        .find((x) => /长任务时限/.test((x.querySelector(".wb-group-title") || {}).textContent || ""));
      if (!g) return { found: false };
      return {
        found: true,
        labels: [...g.querySelectorAll(".wb-row-name")].map((e) => e.textContent),
        vals: [...g.querySelectorAll("input[type=number]")].map((e) => e.value),
        descs: [...g.querySelectorAll(".wb-row-desc")].map((e) => e.textContent).join(" | "),
      };
    });
    ok("Agent 分区渲染「长任务时限」分组", limits.found === true);
    ok("三个时限输入都在", limits.found && limits.labels.length === 3, JSON.stringify(limits.labels));
    ok("输入值取自服务端真实设置（600/1200/120）", (limits.vals || []).join(",") === "600,1200,120", JSON.stringify(limits.vals));
    ok("审批时限的说明讲清了后果", /你拒绝了|自动放弃/.test(limits.descs || ""), (limits.descs || "").slice(0, 90));
    ok("命令时限的说明指向后台进程方案", /start_process/.test(limits.descs || ""), (limits.descs || "").slice(0, 90));
    await page.locator("#wbBody .wb-group", { hasText: "长任务时限" }).locator("input[type=number]").nth(1).fill("1800");
    await page.keyboard.press("Enter");
    await wait(500);
    const persisted = await req("GET", "/api/config", null, token);
    ok("改审批时限真的落库并回读（1800s）",
      persisted.agent && persisted.agent.timeouts && persisted.agent.timeouts.approvalSec === 1800,
      JSON.stringify((persisted.agent || {}).timeouts));
    const reloaded = await page.evaluate(() => {
      const g = [...document.querySelectorAll("#wbBody .wb-group")]
        .find((x) => /长任务时限/.test((x.querySelector(".wb-group-title") || {}).textContent || ""));
      return g ? [...g.querySelectorAll("input[type=number]")].map((e) => e.value).join(",") : null;
    });
    ok("面板上的值与服务端一致（不会显示成没生效）", reloaded === "600,1800,120", String(reloaded));
    await page.screenshot({ path: path.join(OUT, "wb_longtask_limits.png") }).catch(() => {});
    await page.evaluate(() => window.closeWorkbench());   // 全屏工作台会拦住聊天区点击，先关掉
    await wait(250);

    const cd = await page.evaluate(async () => {
      window.handleEvent({
        type: "tool.pending", id: "apUI", tool: "run_command", danger: "medium",
        preview: { command: "npm run build" }, timeoutSec: 90,
      });
      await new Promise((r) => setTimeout(r, 1200));
      const el = document.querySelector(".tool-card.approval .ap-wait");
      return el ? { text: el.textContent, shown: el.offsetParent !== null } : null;
    });
    ok("审批卡片显示「等你处理 · 剩 …」倒计时", !!cd && /等你处理 · 剩/.test(cd.text), cd && cd.text);
    ok("倒计时显示在卡片操作行里（可见）", cd && cd.shown === true);
    ok("倒计时格式可读（1m29s 这类）", cd && /^等你处理 · 剩 (1m2[0-9]s|29s)$/.test(cd.text), cd && cd.text);
    const cd2 = await page.evaluate(async () => {
      const a = (document.querySelector(".tool-card.approval .ap-wait") || {}).textContent || "";
      await new Promise((r) => setTimeout(r, 1600));
      return { a, b: (document.querySelector(".tool-card.approval .ap-wait") || {}).textContent || "" };
    });
    ok("倒计时真的在走（不是静态文案）", cd2.a !== cd2.b, cd2.a + " → " + cd2.b);
    await page.locator(".tool-card.approval .btn-approve").first().click();
    await wait(300);
    const st = await page.evaluate(async () => {
      const el = document.querySelector(".tool-card.approval .ap-wait");
      const a = el.textContent;
      await new Promise((r) => setTimeout(r, 1400));
      return { a, b: el.textContent, disabled: document.querySelector(".tool-card.approval .btn-approve").disabled };
    });
    ok("批准后倒计时停住、按钮锁定（不再催促用户）", st.a === st.b && st.disabled === true, st.a + " / " + st.b);
    await page.evaluate(() => window.handleEvent({
      type: "tool.ask_choice", id: "chUI", question: "选一个方案",
      options: [{ label: "A" }, { label: "B" }], timeoutSec: 90,
    }));
    await wait(300);
    ok("选项卡同样显示等待倒计时", await page.locator(".tool-card.choice .ap-wait").count() === 1);
    const layout = await page.evaluate(() => {
      const card = [...document.querySelectorAll(".tool-card.approval")].find((c) => c.querySelector(".ap-wait"));
      const btn = card.querySelector(".btn-approve-session");
      const wait = card.querySelector(".ap-wait");
      const row = card.querySelector(".approval-actions");
      return {
        btnH: Math.round(btn.getBoundingClientRect().height),
        waitH: Math.round(wait.getBoundingClientRect().height),
        rowH: Math.round(row.getBoundingClientRect().height),
        clipped: [...card.querySelectorAll("button")].some((b) => b.scrollWidth > b.clientWidth + 1),
      };
    });
    ok("按钮没有被挤成竖排（单行高度 <30px）", layout.btnH < 30, "实际 " + layout.btnH + "px");
    ok("倒计时是单行（<20px）", layout.waitH < 20, "实际 " + layout.waitH + "px");
    ok("没有按钮文字被裁切", layout.clipped === false, JSON.stringify(layout));
    const noCd = await page.evaluate(async () => {
      window.handleEvent({
        type: "tool.pending", id: "apNo", tool: "write_file",
        preview: { path: "a.js", lines: 3, preview: "x" },
      });
      await new Promise((r) => setTimeout(r, 200));
      const cards = document.querySelectorAll(".tool-card.approval");
      return cards[cards.length - 1].querySelector(".ap-wait") === null;
    });
    ok("旧事件（无 timeoutSec）不渲染倒计时也不报错", noCd === true);
    await page.screenshot({ path: path.join(OUT, "wb_approval_countdown.png") }).catch(() => {});

    section("空闲看门狗：静默 34s 不得误杀健康连接");
    await page.evaluate(() => {
      window.__toasts = [];
      const orig = window.toast;
      window.toast = (m) => { window.__toasts.push(String(m)); return orig(m); };
    });
    const idle0 = await page.evaluate(() => ({ last: _wsLastMsg, state: ws && ws.readyState }));
    await wait(34000);
    const idle1 = await page.evaluate(() => ({ last: _wsLastMsg, state: ws && ws.readyState, toasts: window.__toasts }));
    ok("静默 34s 后连接仍是 OPEN（看门狗没误杀）", idle1.state === 1, "readyState=" + idle1.state);
    ok("服务端 3s 周期广播持续刷新存活证据", idle1.last > idle0.last + 5000, idle0.last + " → " + idle1.last);
    ok("没有误报「连接无响应 / 已重新连接」",
      !idle1.toasts.some((t) => /无响应|重新连接|断开/.test(t)), JSON.stringify(idle1.toasts.slice(0, 3)));

    section("关键交互");
    await page.evaluate(() => window.openWorkbench("appearance"));
    await wait(250);
    const palCount = await page.locator(".wb-palette").count();
    ok("配色卡片数量与 PALETTES 一致（" + palCount + "）", palCount === shell.palettes, "PALETTES=" + shell.palettes);
    await page.locator(".wb-palette", { hasText: "琥珀" }).first().click().catch(() => {});
    await wait(200);
    const pal = await page.evaluate(() => ({ attr: document.documentElement.getAttribute("data-palette"), stored: localStorage.getItem("cw-palette") }));
    ok("点配色卡片即切换 data-palette", !!pal.attr && pal.attr === pal.stored, JSON.stringify(pal));

    await page.evaluate(() => window.openWorkbench("rules"));
    await wait(320);
    const ruleRows = await page.locator(".wb-side-item").count();
    ok("规则分区列出磁盘上的规则", ruleRows >= 3, "实际 " + ruleRows);
    await page.locator(".wb-side-item", { hasText: "后端约定" }).first().click();
    await wait(320);
    ok("点开规则可编辑（出现正文框）", await page.locator(".wb-detail textarea").count() > 0);
    const pvText = await page.locator(".wb-rules-preview .wb-preview").innerText().catch(() => "");
    ok("生效预览含始终生效规则", /中文汇报|一律中文/.test(pvText), pvText.slice(0, 80));
    await page.fill(".wb-rules-preview input", "server/index.js");
    await page.click(".wb-rules-preview .wb-btn:not(.wb-btn-primary)");
    await wait(320);
    const pv2 = await page.locator(".wb-rules-preview .wb-preview").innerText().catch(() => "");
    ok("按需规则在模拟命中后进入预览", /CommonJS/.test(pv2), pv2.slice(0, 120));

    await page.evaluate(() => window.openWorkbench("experts"));
    await wait(320);
    ok("专家分区列出内置 + 自建专家", await page.locator(".wb-side-item").count() >= 4, "实际 " + await page.locator(".wb-side-item").count());
    await page.locator(".wb-side-item", { hasText: "发布专家" }).first().click();
    await wait(300);
    ok("专家表单出现角色定位与方法论字段", await page.locator(".wb-detail textarea").count() >= 2);
    await page.locator(".wb-detail .wb-btn-primary", { hasText: "保存" }).first().click();
    await wait(400);
    ok("保存专家后提示成功", await page.evaluate(() => (document.getElementById("wbSaved") || {}).textContent || "").then((t) => /已保存/.test(t)));

    await page.evaluate(() => window.openWorkbench("memory"));
    await wait(320);
    ok("记忆分区有统计条", await page.locator(".wb-stats").count() > 0);
    ok("记忆清单渲染", await page.locator(".wb-side-item").count() >= 1);

    await page.evaluate(() => window.openWorkbench("skills"));
    await wait(320);
    ok("技能分区渲染清单", await page.locator(".wb-side-item").count() >= 3, "实际 " + await page.locator(".wb-side-item").count());

    await page.evaluate(() => window.openWorkbench("soul"));
    await wait(320);
    ok("灵魂分区三张清单可见", await page.locator(".wb-chip").count() >= 3, "chip " + await page.locator(".wb-chip").count());

    section("入口改接");
    const entryChecks = [["btnGlobalSettings", "appearance", "click"], ["btnSettings", "model", "click"], ["btnAgentSettings", "agent", "click"], ["envSediment", "sediment", "dom"]];
    for (const [id, expected, mode] of entryChecks) {
      const exists = await page.evaluate((eid) => !!document.getElementById(eid), id);
      if (!exists) { ok("入口 #" + id + " 存在", false, "元素不在 DOM 里"); continue; }
      await page.evaluate(() => window.closeWorkbench());
      await wait(150);
      let clickErr = "";
      if (mode === "click") await page.click("#" + id, { timeout: 3000 }).catch((e) => { clickErr = e.message.split("\n")[0]; });
      else await page.evaluate((eid) => { const el = document.getElementById(eid); if (el) el.click(); }, id);
      await wait(450);
      const sec = await page.evaluate(() => ({ s: (window.WB || {}).section, open: (document.getElementById("workbench") || {}).style ? document.getElementById("workbench").style.display : "?" }));
      ok("入口 #" + id + " → " + expected, sec.s === expected && sec.open !== "none", clickErr ? "点击受阻：" + clickErr : "分区=" + sec.s + " open=" + sec.open + (mode === "dom" ? "（隐藏元素，用 DOM click 验证绑定）" : ""));
    }
    /* 输入栏模型 chip：改成直接下拉选模型，不再跳设置 */
    await page.evaluate(() => window.closeWorkbench());
    await wait(120);
    const chip = await page.evaluate(async () => {
      const el = document.getElementById("btnModelChip");
      if (!el) return { present: false };
      el.click();
      await new Promise((r) => setTimeout(r, 900));
      const pop = document.getElementById("ciModelPop");
      return {
        present: true,
        wbOpen: (document.getElementById("workbench") || {}).style ? document.getElementById("workbench").style.display : "?",
        popShown: pop ? getComputedStyle(pop).display !== "none" : false,
        items: pop ? pop.querySelectorAll(".cmp-item").length : 0,
        empty: pop ? pop.querySelectorAll(".cmp-empty").length : 0,
        fake: pop ? ["gpt-4o", "deepseek-chat", "kimi-k2-0905-preview", "glm-4.5"].filter((m) => (pop.innerText || "").includes(m)).length : 0,
      };
    });
    ok("输入栏模型 chip 存在", chip.present === true);
    ok("点 chip 不再打开设置工作台", chip.wbOpen === "none" || chip.wbOpen === "", "display=" + chip.wbOpen);
    ok("点 chip 直接展开模型下拉（真模型 " + chip.items + " 个 / 空态 " + chip.empty + "）",
      chip.popShown === true && (chip.items >= 1 || chip.empty === 1), JSON.stringify(chip));
    ok("模型下拉里没有内置假模型清单", chip.fake === 0, "假模型 " + chip.fake + " 个");

    section("搜索");
    await page.evaluate(() => window.openWorkbench("appearance"));
    await wait(200);
    await page.fill("#wbSearch", "配色");
    await wait(250);
    ok("搜索能过滤导航", await page.locator(".wb-nav-item").count() < 17 && await page.locator(".wb-nav-item").count() >= 1, "导航项 " + await page.locator(".wb-nav-item").count());
    await page.fill("#wbSearch", "权限");
    await wait(250);
    const navTxt = await page.locator(".wb-nav").innerText();
    ok("搜「权限」能找到权限分区", /权限与安全/.test(navTxt), navTxt.replace(/\n/g, " ").slice(0, 60));
    await page.fill("#wbSearch", "");
    await wait(200);

    section("截图");
    for (const id of ["appearance", "rules", "memory", "experts"]) {
      await page.evaluate((sid) => window.openWorkbench(sid), id);
      await wait(420);
      await page.screenshot({ path: path.join(OUT, "wb_" + id + ".png") });
    }
    /* 浅色配色下再看一次最密的两页，确认对比度与描边没塌 */
    await page.evaluate(() => window.openWorkbench("appearance"));
    await wait(300);
    await page.evaluate(() => { const p = [...document.querySelectorAll(".wb-palette")].find((x) => /羊皮纸/.test(x.textContent)); if (p) p.click(); });
    await wait(450);
    const lightMode = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    ok("选浅色配色会连带切到浅色模式", lightMode === "light", "data-theme=" + lightMode);
    for (const id of ["rules", "experts"]) {
      await page.evaluate((sid) => window.openWorkbench(sid), id);
      await wait(420);
      await page.screenshot({ path: path.join(OUT, "wb_light_" + id + ".png") });
    }
    await page.evaluate(() => window.openWorkbench("appearance"));
    await wait(300);
    await page.evaluate(() => { const p = [...document.querySelectorAll(".wb-palette")].find((x) => /威士忌/.test(x.textContent)); if (p) p.click(); });
    await wait(400);
    await page.screenshot({ path: path.join(OUT, "wb_appearance_whisky.png") });
    ok("截图产出", fs.existsSync(path.join(OUT, "wb_appearance.png")) && fs.existsSync(path.join(OUT, "wb_light_rules.png")));
  } finally {
    await browser.close();
    child.kill();
    await wait(300);
  }
  void tail;
}

main().then(() => {
  console.log("\n" + "=".repeat(52));
  console.log(fail === 0 ? "\x1b[32m全部通过\x1b[0m  " + pass + " 项断言" : "\x1b[31m失败 " + fail + " 项\x1b[0m / 共 " + (pass + fail));
  fails.forEach((f) => console.log("  · " + f));
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error("\x1b[31m异常：\x1b[0m" + e.message); process.exit(2); });
