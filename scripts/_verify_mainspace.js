/* ============================================================
   审查项 F19 验收：视口变窄时，先让辅助栏，别挤中间那块主任务空间
   ————————————————————————————————————————————————————
   截图证据（docs/audit-2026-10-29/）说的是两件事：
     · agents-light-900.png：左右栏（250 + 430，可拖到 360 + 620）都开着，
       中间正文列只剩 200px —— 一行三五个字，连"Agent 会话"都一个字竖着一行。
     · dark-1100.png：顶部标题同样被挤成竖排。
   这一支量的就是这两件事有没有修好，并且钉住三条口径：
     ① 主任务空间有下限（正文列 / 输入区），不足时是**辅助栏让步**；
     ② 让步是临时的：用户拖出来的宽度偏好（localStorage）不许被改写，窗口拉回去要还原；
     ③ 窄视口与 125% / 150% 缩放下，主操作仍然可见、可读（不竖排），
        并且双主题下的对比度与键盘可达/可访问名称一起量。
   900 是浏览器窄视口边界，不据此断言桌面原生窗口必须支持 900 宽。
   ============================================================ */
"use strict";
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const PORT = 8911;
const SANDBOX = require("./_sandbox").create({
  tag: "mainspace",
  wsFiles: { "src/app.js": "export const a = 1;\n", "README.md": "# demo\n" },
  config: { agentMode: "auto", permissions: { mode: "auto", allow: [], deny: [] } },
});

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const fails = [];
const metrics = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
function measure(name, value, unit) { metrics.push({ name, value, unit }); console.log("  \x1b[36m◦\x1b[0m " + name + "：\x1b[1m" + value + "\x1b[0m " + unit); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 320); } catch (e) { return String(v).slice(0, 320); } };

function req(method, urlPath, body, token) {
  const data = body == null ? null : JSON.stringify(body);
  const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
  if (token) headers["x-user-token"] = token;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 30000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, json: { raw: buf.slice(0, 200) } }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

/* 页面里跑的一段：量主任务空间 + 竖排 + 可见性前提。
   "截图/判据前先确认被测面板真的显形"是这里的硬前提：offsetParent 为空就直接报 visible:false。 */
const MEASURE_SRC = () => {
  window.__m = () => {
    const vis = (el) => !!el && !!el.offsetParent && el.getBoundingClientRect().width > 0;
    const center = document.getElementById("agCenter");
    const sessions = document.getElementById("agSessions");
    const right = document.getElementById("agRight");
    const composer = document.getElementById("chatInputAgents");
    const name = document.querySelector(".ag-head-name");
    const sub = document.querySelector(".ag-head-sub");
    /* 一个字竖着一行的形状：宽度小到只装得下一个字，而高度却是好几行 */
    const stacked = (el) => {
      if (!vis(el)) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      const lines = Math.round(r.height / line);
      const oneCharW = parseFloat(cs.fontSize) * 1.6;
      return { w: Math.round(r.width), h: Math.round(r.height), lines: lines, narrow: r.width < oneCharW * 3 };
    };
    return {
      centerVisible: vis(center),
      centerW: center ? Math.round(center.getBoundingClientRect().width) : 0,
      sessionsShown: vis(sessions) && !sessions.hasAttribute("data-auto-hide"),
      rightShown: vis(right) && !right.hasAttribute("data-auto-hide"),
      sessionsW: sessions ? Math.round(sessions.getBoundingClientRect().width) : 0,
      rightW: right ? Math.round(right.getBoundingClientRect().width) : 0,
      composerW: composer ? Math.round(composer.getBoundingClientRect().width) : 0,
      composerVisible: vis(composer),
      name: stacked(name),
      sub: stacked(sub),
      bodyOverflowX: document.body.scrollWidth - document.documentElement.clientWidth,
      /* 主操作：发送按钮 + 模式切换，窄视口下必须还在 */
      send: (() => {
        const b = document.querySelector("#chatInputAgents #btnSend, #chatInputAgents .cm-send, #btnSend");
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { vis: vis(b), w: Math.round(r.width), h: Math.round(r.height), name: (b.getAttribute("aria-label") || b.textContent || b.title || "").trim() };
      })(),
    };
  };
  window.__contrast = (sel) => {
    const bgOf = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const m = /rgba?\(([^)]+)\)/.exec(c || "");
        if (m) {
          const parts = m[1].split(",").map((x) => parseFloat(x));
          if (parts.length < 4 || parts[3] > 0.02) return parts.slice(0, 3);
        }
        n = n.parentElement;
      }
      const root = getComputedStyle(document.documentElement).backgroundColor;
      const mm = /rgba?\(([^)]+)\)/.exec(root || "");
      return mm ? mm[1].split(",").slice(0, 3).map((x) => parseFloat(x)) : [255, 255, 255];
    };
    const lum = (rgb) => {
      const v = rgb.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    const out = [];
    document.querySelectorAll(sel).forEach((el) => {
      if (!el.offsetParent) return;
      const cs = getComputedStyle(el);
      const fg = /rgba?\(([^)]+)\)/.exec(cs.color);
      if (!fg) return;
      out.push({
        tag: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className ? "." + String(el.className).split(" ")[0] : ""),
        text: (el.textContent || "").trim().slice(0, 14),
        ratio: Math.round(ratio(fg[1].split(",").slice(0, 3).map((x) => parseFloat(x)), bgOf(el)) * 100) / 100,
        size: Math.round(parseFloat(cs.fontSize) * 10) / 10,
      });
    });
    return out;
  };
};

(async () => {
  const env = SANDBOX.env({ PORT: String(PORT), HOME: path.join(SANDBOX.root, "home"), USERPROFILE: path.join(SANDBOX.root, "home") });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], { cwd: ROOT, env, windowsHide: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (out.includes("已启动")) break; await wait(150); }
  if (!out.includes("已启动")) throw new Error("服务端没起来：" + out.slice(-400));

  const reg = await req("POST", "/api/auth/register", { username: "_ms_" + Date.now(), password: "test1234" });
  const token = reg.json && reg.json.token;
  if (!token) throw new Error("注册失败：" + J(reg.json));

  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const pageErr = [];

  async function openPage(theme, width, prefs) {
    const p = await browser.newPage({ viewport: { width, height: 900 } });
    p.on("pageerror", (e) => pageErr.push(theme + "@" + width + ": " + String(e && e.message)));
    await p.addInitScript((cfg) => {
      try {
        localStorage.setItem("cw-user-token", cfg.token);
        localStorage.setItem("cw-theme", cfg.theme);
        localStorage.setItem("cw-palette", cfg.theme === "light" ? "celadon" : "graphite");
        localStorage.setItem("cw-onboarded", "1");
        for (const k in cfg.prefs || {}) localStorage.setItem(k, String(cfg.prefs[k]));
      } catch (e) {}
    }, { token, theme, prefs: prefs || {} });
    await p.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load", timeout: 30000 });
    await p.waitForFunction(() => typeof switchMode === "function", null, { timeout: 30000 });
    await p.evaluate(() => { try { switchMode("agents"); } catch (e) {} });
    await p.waitForTimeout(700);
    await p.evaluate(MEASURE_SRC);
    return p;
  }

  try {
    /* ---------- ① 宽度阶梯：中间那块永远有下限 ---------- */
    section("① 1440 / 1280 / 1100 / 900：主任务空间有下限，让步的是辅助栏");
    const MIN_MAIN = 480;
    for (const width of [1440, 1280, 1100, 900]) {
      const p = await openPage("dark", width, { "cw-ag-sessions-w": 360, "cw-ag-right-w": 620 });   // 用户把两栏都拖到最宽
      const m = await p.evaluate(() => window.__m());
      measure(width + " 宽 · 正文列", m.centerW, "px");
      ok("前提：agents 那一列真的显形（看不见就别判）", m.centerVisible && m.composerVisible, J(m));
      ok(width + " 宽下正文列不小于 " + MIN_MAIN + "px（两栏都拖到最宽也不挤中间）",
        m.centerW >= MIN_MAIN, "实测 " + m.centerW + "px，左栏 " + m.sessionsW + " 右栏 " + m.rightW);
      ok(width + " 宽下输入区跟着中间走（不是被两栏吃掉）", m.composerW >= MIN_MAIN - 40, "输入区 " + m.composerW + "px");
      ok(width + " 宽下标题没有被挤成竖排（" + J(m.name) + "）",
        !!m.name && m.name.lines <= 1 && !m.name.narrow, J({ name: m.name, sub: m.sub }));
      ok(width + " 宽下整页没有横向溢出", m.bodyOverflowX <= 1, "溢出 " + m.bodyOverflowX + "px");
      await p.close();
    }

    /* ---------- ② 让步顺序与偏好保留 ---------- */
    section("② 让步的是辅助栏，而且只是临时的（用户偏好不许被改写）");
    const pref = { "cw-ag-sessions-w": 360, "cw-ag-right-w": 620 };
    const p900 = await openPage("dark", 900, pref);
    const narrow = await p900.evaluate(() => window.__m());
    ok("900 宽时至少有一侧辅助栏让开了（不是两栏都占着挤中间）",
      !narrow.rightShown || !narrow.sessionsShown, J({ 左: narrow.sessionsShown, 右: narrow.rightShown, 中间: narrow.centerW }));
    const kept = await p900.evaluate(() => ({
      s: localStorage.getItem("cw-ag-sessions-w"), r: localStorage.getItem("cw-ag-right-w"),
    }));
    ok("临时收起没有改写用户拖出来的宽度偏好", kept.s === "360" && kept.r === "620", J(kept));
    await p900.setViewportSize({ width: 1600, height: 900 });
    await p900.waitForTimeout(400);
    const wide = await p900.evaluate(() => window.__m());
    ok("窗口拉回宽处，两栏按原偏好还原（620 / 360 都回来了）",
      wide.rightShown && wide.sessionsShown && wide.rightW === 620 && wide.sessionsW === 360,
      J({ 右栏: wide.rightW, 左栏: wide.sessionsW, 右在: wide.rightShown, 左在: wide.sessionsShown }));
    await p900.close();

    /* ---------- ③ 缩放 125% / 150% ---------- */
    section("③ 125% / 150% 缩放：主操作与标题仍然可读");
    /* 浏览器缩放的布局效果等价于"物理窗口不变、CSS 视口变窄"：1280 物理宽在 125% 下
       给到 1024 CSS px、150% 下给到 853 CSS px。CSS 的 style.zoom 只压布局、
       既不触发 resize 也不改窗口度量，量到的是"协调器没被叫起来"而不是布局本身，
       所以这里直接开在等价的 CSS 视口宽度上。 */
    for (const [zoom, cssW] of [["1.25", 1024], ["1.5", 853]]) {
      const p = await openPage("dark", cssW, { "cw-ag-sessions-w": 300, "cw-ag-right-w": 460 });
      const m = await p.evaluate(() => window.__m());
      measure(zoom + " 缩放（等价 " + cssW + " CSS 宽）· 正文列", m.centerW, "px");
      ok(zoom + " 缩放下正文列仍有 480px 下限（让步的是辅助栏）", m.centerW >= 480,
        J({ w: m.centerW, 左: m.sessionsW, 右: m.rightW, 左在: m.sessionsShown, 右在: m.rightShown }));
      ok(zoom + " 缩放下标题看得见且不竖排", !!m.name && m.name.lines <= 1, J(m.name));
      ok(zoom + " 缩放下发送主操作还在且可名", !!m.send && m.send.vis && m.send.w >= 20 && !!m.send.name, J(m.send));
      await p.close();
    }

    /* ---------- ④ 双主题对比度（含原生下拉 option） ---------- */
    section("④ 双主题对比度：正文标题、次要状态、原生下拉的 option");
    for (const theme of ["dark", "light"]) {
      const p = await openPage(theme, 1280, {});
      const head = await p.evaluate(() => window.__contrast(".ag-head-name, .ag-head-sub"));
      const bad = head.filter((x) => x.ratio < (x.size >= 18 ? 3 : 4.5));
      measure(theme + " · 标题/状态对比度", head.map((x) => x.tag + " " + x.ratio).join(" ; "), "");
      ok(theme + " 主题下标题与状态文字达到可用对比度", bad.length === 0, J(bad));
      /* 原生 select 的 option 由操作系统画，Chromium 下取的是 option 自己的 computed style ——
         只量 select 本体等于没量（历史上浅色主题下 option 白字白底就是这么漏掉的）。 */
      await p.evaluate(() => { try { openWorkbench("automations"); } catch (e) {} });
      await p.waitForTimeout(500);
      const opts = await p.evaluate(() => {
        const sel = document.getElementById("autoType");
        if (!sel) return [];
        const cs = getComputedStyle(sel);
        const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c || ""); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); if (p.length >= 4 && p[3] <= 0.02) return null; return p.slice(0, 3); };
        const lum = (rgb) => { const v = rgb.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
        const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
        return Array.from(sel.options).slice(0, 4).map((o) => {
          const oc = getComputedStyle(o);
          const fg = parse(oc.color);
          /* option 的 background 在 Chromium 下恒为 transparent —— 以前把它当 [0,0,0] 用，
             于是浅色主题量出 1.7（那是"深绿字压在黑底上"，屏幕上根本没有这个底）。
             透明就退回宿主的那层：下拉展开时 option 画在系统菜单底色上，这里取 select 自己的底色。 */
          const bg = parse(oc.backgroundColor) || parse(cs.backgroundColor) || parse(getComputedStyle(document.documentElement).backgroundColor) || [255, 255, 255];
          return {
            text: o.textContent.trim().slice(0, 10),
            ratio: fg ? Math.round(ratio(fg, bg) * 100) / 100 : 0,
            raw: oc.color + " on " + oc.backgroundColor + " (框:" + cs.backgroundColor + ")",
          };
        });
      });
      measure(theme + " · 原生 option 对比度", opts.map((o) => o.text + " " + o.ratio + " [" + o.raw + "]").join(" ; "), "");
      ok(theme + " 主题下原生下拉的 option 也能看清（不是只量了框）",
        opts.length > 0 && opts.every((o) => o.ratio >= 4.5), J(opts));
      await p.close();
    }

    /* ---------- ⑤ 键盘可达与可访问名称 ---------- */
    section("⑤ 键盘：Tab 能走到输入区与主操作，且它们有可访问名称");
    const pk = await openPage("dark", 1280, {});
    await pk.evaluate(() => { document.body.focus(); });
    const trail = [];
    for (let i = 0; i < 45; i++) {
      await pk.keyboard.press("Tab");
      const cur = await pk.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return "";
        return ((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) ||
          (el.textContent || "").trim().slice(0, 20) || el.id || el.tagName).toString();
      });
      trail.push(cur);
      if (/发送|send/i.test(cur)) break;
    }
    const kb = await pk.evaluate(() => {
      const composer = document.getElementById("chatInputAgents");
      return {
        composerHasControl: !!(composer && composer.querySelector("textarea,[contenteditable=true],.cm-content")),
        named: Array.from(document.querySelectorAll("#chatInputAgents button")).every((b) =>
          !!(b.getAttribute("aria-label") || (b.textContent || "").trim() || b.title)),
      };
    });
    measure("键盘：走到主操作按了几次 Tab", trail.length, "次");
    /* 真按 Tab（Playwright 驱动焦点环），不是在页面里 nextElementSibling.focus() ——
       后者量的是"DOM 里挨着"，不是"键盘够得着"。 */
    ok("主操作在键盘路径上够得着", trail.some((s) => /发送|send/i.test(s)), J(trail.slice(-6)));
    ok("输入区里有可聚焦的编辑控件", kb.composerHasControl === true, J(kb));
    ok("agents 输入区里的按钮都有可访问名称（图标按钮也不能只剩图标）", kb.named === true, J(kb));
    await pk.close();

    /* ---------- ⑥ 编辑模式顶部（dark-1100 那一屏） ---------- */
    section("⑥ 编辑模式 1100 宽：顶部主操作不被无关状态挤成竖排");
    const pe = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    pe.on("pageerror", (e) => pageErr.push("editor@1100: " + String(e && e.message)));
    await pe.addInitScript((tk) => { try { localStorage.setItem("cw-user-token", tk); localStorage.setItem("cw-onboarded", "1"); localStorage.setItem("cw-theme", "dark"); localStorage.setItem("cw-palette", "graphite"); } catch (e) {} }, token);
    await pe.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load", timeout: 30000 });
    await pe.waitForFunction(() => typeof switchMode === "function", null, { timeout: 30000 });
    await pe.evaluate(() => { try { switchMode("editor"); } catch (e) {} });
    await pe.waitForTimeout(800);
    const tb = await pe.evaluate(() => {
      const vis = (el) => !!el && !!el.offsetParent;
      const rows = Array.from(document.querySelectorAll("#titlebar *")).filter((el) => {
        if (!vis(el)) return false;
        const cs = getComputedStyle(el);
        if (cs.display === "none") return false;
        const txt = (el.textContent || "").trim();
        return txt.length > 0 && el.children.length === 0;
      }).map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
        return { txt: (el.textContent || "").trim().slice(0, 12), w: Math.round(r.width), h: Math.round(r.height), lines: Math.round(r.height / line) };
      });
      const stacked = rows.filter((x) => x.lines >= 3 && x.h > 30);
      const btns = Array.from(document.querySelectorAll("#titlebar button")).filter(vis).map((b) => {
        const r = b.getBoundingClientRect();
        return { id: b.id || b.className, w: Math.round(r.width), h: Math.round(r.height) };
      });
      return { stacked, btns, rows: rows.length };
    });
    measure("编辑模式 1100 · 顶部文字节点", tb.rows, "个");
    ok("顶部没有哪个文字节点被挤成三行以上（竖排单字）", tb.stacked.length === 0, J(tb.stacked.slice(0, 3)));
    ok("顶部按钮都还有可点的尺寸（≥20×20）", tb.btns.length > 0 && tb.btns.every((b) => b.w >= 20 && b.h >= 20), J(tb.btns.slice(0, 4)));
    await pe.close();

    ok("全程页面没有报错", pageErr.length === 0, pageErr.slice(0, 3).join(" | "));
  } catch (e) {
    ok("探针整条链路没抛错", false, (e && e.stack ? e.stack : String(e)).slice(0, 400));
  } finally {
    console.log("\n\x1b[1m量到的数\x1b[0m");
    for (const m of metrics) console.log("  " + m.name + " = " + m.value + " " + m.unit);
    console.log("\n共 " + (pass + fail) + " 条，红 " + fail + " 条");
    if (fail) { console.log("\n失败明细："); fails.forEach((f, i) => console.log("  " + (i + 1) + ". " + f)); }
    try { await browser.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    SANDBOX.cleanup();
    process.exit(fail ? 1 : 0);
  }
})();
