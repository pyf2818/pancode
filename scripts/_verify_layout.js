/* ============================================================
   界面残缺 / 挤兑 / 看不清 全站体检（Playwright，真实页面 + 沙箱服务）
   针对用户反馈"设置里很多都出现内容挤兑残缺、看不到内容"，逐分区量化四类缺陷：
     A 横向溢出：元素内容比容器宽且不可横向滚动 → 右侧内容被切掉
     B 塌陷容器：列表/详情容器高度 < 14px 或完全没有内容 → 看到一条空框
     C 文字对比：前景/背景相对亮度比 < 2.1 → "看不到内容"
     D 越界：元素超出视口右边界
   覆盖：17 个设置分区 × 深/浅两套模式（1440 与 1100 两档宽度）、登录卡、输入栏、终端。
   ============================================================ */
"use strict";
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SB = path.join(ROOT, "scripts", "_verify_out", "layout-sandbox");
const DATA = path.join(SB, "data");
const WS = path.join(SB, "ws");
const OUT = path.join(ROOT, "scripts", "_verify_out");
const PORT = 8817;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 一个最普通的本地 HTTP 模型服务：只提供 /v1/models 与 /v1/chat/completions。
   设置里的「拉取模型」应当直接认它——不需要用户再架什么网关。 */
function startMockUpstream() {
  const hits = [];
  const srv = http.createServer((rq, rs) => {
    rq.on("data", () => {});
    rq.on("end", () => {
      hits.push({ url: rq.url, auth: rq.headers.authorization || "" });
      const send = (code, type, text) => { rs.writeHead(code, { "Content-Type": type }); rs.end(text); };
      if (rq.url === "/v1/models") return send(200, "application/json", JSON.stringify({ data: [{ id: "mock-b" }, { id: "mock-a" }] }));
      if (rq.url === "/v1/chat/completions") return send(200, "text/event-stream", 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      send(404, "application/json", JSON.stringify({ error: "no such path" }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      base: "http://127.0.0.1:" + srv.address().port,
      hits,
      close: () => new Promise((d) => srv.close(d)),
    }));
  });
}

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
  fs.writeFileSync(path.join(WS, ".pancode", "experts", "发布专家.md"),
    "---\nname: 发布专家\ndescription: 只管构建与灰度\ntool_whitelist: [run_command, git_commit]\n---\n\n你是发布工程师。\n");
  fs.writeFileSync(path.join(WS, "AGENTS.md"), "# 仓库约定\n\n根级规则。\n");
  fs.writeFileSync(path.join(WS, "server", "index.js"), "module.exports = 1;\n");
  /* 演示引擎的 bug 态夹具（与 smoke-test 同一套）：缺它引擎会在第一个工具上抛错 */
  const fix = {
    "package.json": JSON.stringify({ name: "demo", type: "module" }),
    "README.md": "# Todo App\n已知问题：filterTodos 的 active/done 分支条件反转",
    "src/todo.js": "// 待办事项核心逻辑\nlet nextId = 1;\n\nexport function createTodo(text, priority) {\n  return { id: nextId++, text: text, priority: priority || \"normal\", done: false, createdAt: Date.now() };\n}\n\nexport function toggleTodo(todos, id) {\n  return todos.map(function (t) { return t.id === id ? Object.assign({}, t, { done: !t.done }) : t; });\n}\n\nexport function filterTodos(todos, filter) {\n  if (filter === \"active\") return todos.filter(function (t) { return t.done; });\n  if (filter === \"done\") return todos.filter(function (t) { return !t.done; });\n  return todos;\n}\n",
    "src/utils.js": "// 工具函数基线",
    "tests/run-tests.js": "import { createTodo, filterTodos } from \"../src/todo.js\";\nfunction assert(cond, name, msg) { if (cond) console.log(\"  \\u2713 \" + name); else console.error(\"  \\u2717 \" + name + (msg ? \": \" + msg : \"\")); }\nconst todos = [createTodo(\"A\", \"low\"), createTodo(\"B\", \"high\"), createTodo(\"C\", \"normal\")];\nassert(filterTodos(todos, \"active\").length === 3, \"active 筛选返回未完成项\");\nassert(filterTodos(todos, \"done\").length === 0, \"done 筛选返回已完成项\");\n",
    "tests/todo.test.js": "import { createTodo, filterTodos } from \"../src/todo.js\";\nfunction assert(cond, name) { if (cond) console.log(\"  \\u2713 \" + name); else console.error(\"  \\u2717 \" + name); }\nconst todos = [createTodo(\"A\", \"low\"), createTodo(\"B\", \"high\"), createTodo(\"C\", \"normal\")];\nassert(filterTodos(todos, \"all\").length === 3, \"all 返回全部\");\n",
  };
  for (const rel of Object.keys(fix)) {
    const p = path.join(WS, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, fix[rel], "utf8");
  }
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
  child.stdout.on("data", (c) => { tail = (tail + c).slice(-4000); });
  child.stderr.on("data", (c) => { tail = (tail + c).slice(-4000); });
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const r = await req("GET", "/api/health"); if (r && r.ok) return { child, tail: () => tail }; } catch (e) {}
  }
  throw new Error("服务未在 18s 内就绪\n" + tail);
}

/* ---------- 页面内体检函数（注入执行） ---------- */
const AUDIT_SRC = `
window.__audit = function (scopeSel) {
  const LUM = (c) => { const v = [c[0], c[1], c[2]].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const RATIO = (a, b) => { const l1 = LUM(a), l2 = LUM(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  function parse(str) {
    if (!str) return null;
    str = String(str).trim();
    if (str === "transparent") return null;
    let m = str.match(/^rgba?\\(([^)]+)\\)/);
    if (m) { const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number);
      return { rgb: [p[0], p[1], p[2]], a: p[3] == null ? 1 : p[3] }; }
    m = str.match(/^color\\(srgb ([^)]+)\\)/);
    if (m) { const p = m[1].split(/[\\s\\/]+/).filter(Boolean).map(Number);
      return { rgb: [Math.round(p[0] * 255), Math.round(p[1] * 255), Math.round(p[2] * 255)], a: p[3] == null ? 1 : p[3] }; }
    m = str.match(/^#([0-9a-f]{3,8})$/i);
    if (m) { let h = m[1]; if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
      return { rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)],
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }; }
    return null;
  }
  function bgOf(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      // 渐变卡面（登录卡就是 linear-gradient）无法用单一底色判对比，跳过而不是误报
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.6) return c.rgb;
      n = n.parentElement;
    }
    const r = parse(getComputedStyle(document.documentElement).backgroundColor);
    return r ? r.rgb : null;
  }
  const path = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 4) {
      let s = n.tagName.toLowerCase();
      if (n.id) s += "#" + n.id;
      else if (n.className && typeof n.className === "string") s += "." + n.className.trim().split(/\\s+/)[0];
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(" > ");
  };
  const scope = document.querySelector(scopeSel);
  const out = { overflow: [], collapsed: [], lowContrast: [], offscreen: [], empty: [] };
  if (!scope) { out.missing = scopeSel; return out; }
  const sw = scope.clientWidth, sh = scope.clientHeight;
  const all = [scope].concat([...scope.querySelectorAll("*")]);
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || !el.getClientRects().length) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const scrollableX = /(auto|scroll)/.test(cs.overflowX);
    /* 有意省略 ≠ 溢出：overflow:hidden + text-overflow:ellipsis 且元素带 title，
       用户悬停就能看到被截断的整串（长路径、长标题本来就得这么排）。
       "截了又没地方看全"才是要抓的缺陷 —— 那种情况下面照旧报。 */
    const recoverableEllipsis = cs.overflowX === "hidden" && cs.textOverflow === "ellipsis" &&
      !!String(el.getAttribute("title") || "").trim();
    if (!scrollableX && !recoverableEllipsis && el.scrollWidth > el.clientWidth + 3 && el.clientWidth > 0)
      out.overflow.push({ p: path(el), sw: el.scrollWidth, cw: el.clientWidth });
    if (r.right > window.innerWidth + 2 || r.left < -2)
      out.offscreen.push({ p: path(el), right: Math.round(r.right), left: Math.round(r.left) });
    // 塌陷：列表/详情类容器几乎没高度也没文字
    const cls = (el.className && typeof el.className === "string") ? el.className : "";
    if (/(wb-side-list|wb-detail|cmp-list|wb-list|wb-stats)/.test(cls)) {
      const txt = (el.innerText || "").trim();
      if (r.height < 16 && !txt) out.collapsed.push({ p: path(el), h: Math.round(r.height) });
      else if (!el.children.length && !txt) out.empty.push({ p: path(el) });
    }
    // 文字对比：只看直接持有文本的叶子
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).length;
    if (own) {
      const fg = parse(cs.color);
      if (own && fg && fg.a > 0.6) {
        const bg = bgOf(el);
        if (bg) {
          const ratio = RATIO(fg.rgb, bg);
          if (ratio < 2.1) out.lowContrast.push({ p: path(el), ratio: Math.round(ratio * 100) / 100, t: el.textContent.trim().slice(0, 24) });
        }
      }
    }
  }
  out.scopeBox = { sw, sh };
  return out;
};

/* 左槽 0..26px 内真实画出来的竖线：绝对定位伪元素细条 + 只有左边有颜色的 border
   （四周等宽的那叫边框，不算线）。用来证明"多条线重叠遮挡"是否还在。 */
window.__railLines = function (root) {
  const alpha = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c || ""); if (!m) return 1; const p = m[1].split(","); return p.length < 4 ? 1 : Number(p[3]); };
  const rr = root.getBoundingClientRect();
  const out = [];
  const push = (x, w, h, owner) => {
    const rel = x - rr.left;
    if (w >= 1 && w <= 4 && h >= 10 && rel >= -1 && rel <= 26) out.push({ owner, x: Math.round(rel), w: Math.round(w), h: Math.round(h) });
  };
  const scan = (el, tag) => {
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    if (bl >= 1 && bl !== (parseFloat(cs.borderTopWidth) || 0) && alpha(cs.borderLeftColor) > 0.04) push(b.left, bl, b.height, tag + "·border-left");
    for (const pe of ["::before", "::after"]) {
      const pc = getComputedStyle(el, pe);
      if (!pc.content || pc.content === "none" || pc.position !== "absolute") continue;
      const w = parseFloat(pc.width) || 0;
      if (w <= 0) continue;
      const h = parseFloat(pc.height) || (b.height - (parseFloat(pc.top) || 0) - (parseFloat(pc.bottom) || 0));
      push(b.left + (parseFloat(pc.left) || 0), w, h, tag + pe);
    }
  };
  scan(root, ".step-flow");
  root.querySelectorAll("*").forEach((e) => scan(e, "." + String(e.className || e.tagName).split(" ")[0]));
  return out;
};
`;

function flat(a) { const o = []; for (const k in a) if (Array.isArray(a[k])) a[k].forEach((x) => o.push(k + ": " + (x.p || "") + " " + (x.sw ? x.sw + ">" + x.cw : "") + (x.ratio ? " 对比 " + x.ratio : "") + (x.h ? " 高 " + x.h : ""))); return o; }

async function main() {
  seed();
  fs.mkdirSync(OUT, { recursive: true });
  const { child, tail } = await boot();
  const reg = await req("POST", "/api/auth/register", { username: "_layout_" + Date.now(), password: "test1234" });
  const token = reg && reg.token;
  if (!token) { child.kill(); throw new Error("注册失败：" + JSON.stringify(reg)); }
  await req("POST", "/api/memory", { type: "lesson", topic: "构建", content: "打包前先跑一次冒烟。", valueScore: 5, sticky: true }, token);
  await req("POST", "/api/skills", { name: "灰度发布", description: "分批放量", trigger: "灰度,发布", body: "1. 构建 2. 放量 10%" }, token);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const jsErrors = [];
  async function openPage(theme, width) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
    page.on("pageerror", (e) => jsErrors.push("pageerror: " + e.message));
    await page.addInitScript((cfg) => {
      try {
        localStorage.setItem("cw-user-token", cfg.token);
        localStorage.setItem("cw-theme", cfg.theme);
        localStorage.setItem("cw-palette", cfg.theme === "light" ? "celadon" : "graphite");
        localStorage.setItem("cw-onboarded", "1");
      } catch (e) {}
    }, { token, theme });
    await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
    await wait(1600);
    await page.evaluate(AUDIT_SRC);
    return page;
  }

  const SECTIONS = ["appearance", "general", "model", "agent", "perms", "mcp", "data", "about",
    "experts", "soul", "memory", "sediment", "rules", "skills", "evolution", "automations", "audit"];
  const defects = {};
  const H401 = [];
  let page = null;
  try {
    for (const theme of ["dark", "light"]) {
      for (const width of [1440, 1100]) {
        const key = theme + "@" + width;
        page = await openPage(theme, width);
        page.on("response", (r) => {
          if (r.status() === 401) H401.push(r.request().method() + " " + r.url().replace(/^https?:\/\/127\.0\.0\.1:\d+/, ""));
        });
        await page.evaluate(() => window.openWorkbench("appearance"));
        await wait(400);
        const bad = [];
        for (const id of SECTIONS) {
          await page.evaluate((sid) => window.openWorkbench(sid), id);
          await wait(320);
          const a = await page.evaluate((sel) => window.__audit(sel), "#wbBody");
          const hard = (a.overflow || []).concat(a.collapsed || [], a.lowContrast || [], a.offscreen || [], a.empty || []);
          if (hard.length) { bad.push(id + " → " + hard.slice(0, 3).map((h) => (typeof h === "string" ? h : JSON.stringify(h))).join(" ; ").slice(0, 220)); defects[key + "/" + id] = hard; }
        }
        ok("设置工作台 " + key + " 全部 17 分区无溢出/塌陷/低对比", bad.length === 0, "\n      " + bad.slice(0, 8).join("\n      "));
        if (theme === "light" && width === 1440) await page.screenshot({ path: path.join(OUT, "layout_workbench_light.png") }).catch(() => {});
        if (theme === "dark" && width === 1100) await page.screenshot({ path: path.join(OUT, "layout_workbench_narrow.png") }).catch(() => {});
        await page.close();
      }
    }

    /* ---------- 终端在浅色下必须仍是黑底 ---------- */
    section("终端配色");
    for (const theme of ["light", "dark"]) {
      page = await openPage(theme, 1440);
      const t = await page.evaluate(() => {
        const el = document.getElementById("terminal");
        const cs = getComputedStyle(el);
        const line = document.querySelector("#termLines .tl") || document.getElementById("termLines");
        const fg = line ? getComputedStyle(line).color : "";
        const m = (s) => {
          let r = /rgba?\(([^)]+)\)/.exec(s);
          if (r) return r[1].split(/[\s,\/]+/).filter(Boolean).slice(0, 3).map(Number);
          r = /color\(srgb ([^)]+)\)/.exec(s);
          if (r) return r[1].split(/[\s\/]+/).filter(Boolean).slice(0, 3).map((x) => Math.round(parseFloat(x) * 255));
          r = /^#([0-9a-f]{3})$/i.exec(s);
          if (r) { const h = r[1].split("").map((c) => c + c).join(""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
          r = /^#([0-9a-f]{6})$/i.exec(s);
          if (r) return [0, 2, 4].map((i) => parseInt(r[1].slice(i, i + 2), 16));
          return null;
        };
        const bg = m(cs.backgroundColor);
        const lum = (c) => { const v = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
        const f = m(fg);
        return { bg, fgRaw: fg, lum: bg ? Math.round(lum(bg) * 1000) / 1000 : null,
          ratio: bg && f ? Math.round(((Math.max(lum(bg), lum(f)) + 0.05) / (Math.min(lum(bg), lum(f)) + 0.05)) * 100) / 100 : null };
      });
      const darkish = t.lum != null && t.lum < 0.06;
      ok(theme + " 模式终端底色仍是深底（亮度 " + t.lum + " < 0.06）", darkish, JSON.stringify(t));
      ok(theme + " 模式终端文字对比 ≥ 5:1（实测 " + t.ratio + "）", t.ratio >= 5, JSON.stringify(t));
      await page.screenshot({ path: path.join(OUT, "layout_terminal_" + theme + ".png") }).catch(() => {});
      await page.close();
    }

    /* ---------- 登录卡 ---------- */
    section("登录 / 注册卡");
    page = await openPage("light", 1440);
    const auth = await page.evaluate(async () => {
      window.showAuthModal();
      await new Promise((r) => setTimeout(r, 300));
      const m = document.getElementById("authModal");
      const card = m.querySelector(".auth-card");
      const cs = getComputedStyle(card);
      const a = window.__audit("#authModal");
      const rect = card.getBoundingClientRect();
      return {
        shown: getComputedStyle(m).display !== "none",
        overflow: a.overflow, low: a.lowContrast, collapsed: a.collapsed,
        anim: cs.animationName, radius: cs.borderRadius, overflowCss: cs.overflow,
        box: { w: Math.round(rect.width), h: Math.round(rect.height) },
        fields: card.querySelectorAll("input").length,
        remember: !!card.querySelector("#authRemember") && card.querySelector("#authRemember").checked,
      };
    });
    ok("登录卡显示且无溢出/低对比", auth.shown && !auth.overflow.length && !auth.low.length,
      JSON.stringify({ o: auth.overflow, l: auth.low }).slice(0, 400));
    ok("登录卡入场动画生效（旧写法多一个右括号导致整条声明失效）", auth.anim && auth.anim !== "none", String(auth.anim));
    ok("登录卡裁切生效（光晕不再溢出圆角）", auth.overflowCss === "hidden", auth.overflowCss + " / " + auth.radius);
    ok("用户名 + 密码 + 记住我三个控件都在", auth.fields === 3, "input " + auth.fields);
    ok("记住我默认勾选（重启后仍保持登录）", auth.remember === true);
    /* 切到注册态：文案与按钮同步 */
    const reg2 = await page.evaluate(async () => {
      document.getElementById("authSwitch").click();
      await new Promise((r) => setTimeout(r, 150));
      return { title: document.getElementById("authTitle").textContent, submit: document.getElementById("authSubmit").textContent };
    });
    ok("切到注册态后标题与按钮同步", /创建账号/.test(reg2.title) && reg2.submit === "注册", JSON.stringify(reg2));
    await page.screenshot({ path: path.join(OUT, "layout_auth_light.png") }).catch(() => {});
    await page.close();

    /* ---------- 输入栏：模式切换已撤，模型下拉可用 ---------- */
    section("输入栏");
    for (const width of [1440, 1100]) {
      page = await openPage("dark", width);
      const bar = await page.evaluate(async () => {
        const box = document.getElementById("chatInputBox");
        const a = window.__audit("#chatInputBox");
        const chip = document.getElementById("btnModelChip");
        chip.click();
        await new Promise((r) => setTimeout(r, 900));
        const pop = document.getElementById("ciModelPop");
        return {
          modeSeg: !!document.getElementById("modeSeg"),
          perm: !!document.getElementById("ciPerm"),
          chip: !!chip, chipTxt: chip ? chip.textContent.trim() : "",
          popShown: pop ? getComputedStyle(pop).display !== "none" : false,
          items: pop ? pop.querySelectorAll(".cmp-item").length : 0,
          empty: pop ? pop.querySelectorAll(".cmp-empty").length : 0,
          manual: pop ? pop.querySelectorAll(".cmp-manual").length : 0,
          fake: pop ? ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "deepseek-chat", "deepseek-reasoner", "kimi-k2-0905-preview", "qwen-max", "glm-4.5"]
            .filter((m) => (pop.innerText || "").includes(m)).length : 0,
          foot: pop ? (pop.querySelector(".cmp-gear") || {}).textContent : "",
          badge: !!document.getElementById("ciModeBadge"),
          overflow: a.overflow.length, low: a.lowContrast.length, off: a.offscreen.length,
          h: Math.round(box.getBoundingClientRect().height),
        };
      });
      ok("输入栏 " + width + "px：Agent/Plan/Ask 三档按钮已撤下", bar.modeSeg === false);
      ok("输入栏 " + width + "px：权限档位仍在（改盘确认还要用）", bar.perm === true);
      ok("输入栏 " + width + "px：模型下拉可直接展开", bar.chip && bar.popShown, JSON.stringify(bar).slice(0, 160));
      ok("输入栏 " + width + "px：下拉只列网关真返回的模型（" + bar.items + " 个）或诚实空态（" + bar.empty + "）",
        bar.items >= 1 || bar.empty === 1, JSON.stringify(bar).slice(0, 200));
      ok("输入栏 " + width + "px：未配网关时不再塞内置假模型清单", bar.fake === 0, "假模型出现 " + bar.fake + " 个：" + JSON.stringify(bar).slice(0, 200));
      ok("输入栏 " + width + "px：空态给了手填入口", bar.empty === 0 || bar.manual === 1, JSON.stringify({ empty: bar.empty, manual: bar.manual }));
      ok("输入栏 " + width + "px：下拉底部保留模型设置入口", /模型设置/.test(String(bar.foot)), String(bar.foot));
      ok("输入栏 " + width + "px：无溢出/低对比/越界", bar.overflow === 0 && bar.low === 0 && bar.off === 0, JSON.stringify(bar).slice(0, 200));
      const ph = await page.evaluate(() => {
        const ta = document.getElementById("chatInput");
        const cs = getComputedStyle(ta);
        const lh = parseFloat(cs.lineHeight);
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre-wrap;width:" + ta.clientWidth + "px;"
          + "font:" + cs.font + ";line-height:" + lh + "px;";
        probe.textContent = ta.placeholder;
        document.body.appendChild(probe);
        const need = Math.round(probe.getBoundingClientRect().height / lh);
        probe.remove();
        const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const cap = Math.floor((ta.clientHeight - pad) / lh);
        return { need, cap, h: ta.clientHeight, w: ta.clientWidth };
      });
      ok("输入栏 " + width + "px：空态放得下整句提示语（需 " + ph.need + " 行 / 有 " + ph.cap + " 行）",
        ph.cap >= ph.need, JSON.stringify(ph));
      await page.screenshot({ path: path.join(OUT, "layout_inputbar_" + width + ".png") }).catch(() => {});
      await page.close();
    }
    /* 徽标：切到 Plan 才出现，切回 Agent 自动消失 */
    page = await openPage("dark", 1440);
    const badge = await page.evaluate(async () => {
      await window.setAgentMode("plan");
      await new Promise((r) => setTimeout(r, 250));
      const b1 = document.getElementById("ciModeBadge");
      const shown = b1 ? b1.textContent : "";
      await window.setAgentMode("agent");
      await new Promise((r) => setTimeout(r, 250));
      return { shown, gone: !document.getElementById("ciModeBadge") };
    });
    ok("Plan 模式在输入栏出现小徽标（撤掉三档按钮后仍有可见提示）", /规划中/.test(badge.shown), JSON.stringify(badge));
    ok("切回 Agent 后徽标自动消失", badge.gone === true);
    await page.close();

    /* ---------- 接口失败不留白（用户截图就是这个：左列表塌成一条、右侧整块空白） ---------- */
    section("接口失败 / 空数据时的兜底显示");
    page = await openPage("dark", 1440);
    for (const [id, api] of [["skills", "/api/skills/managed"], ["rules", "/api/rules"], ["memory", "/api/memory"], ["experts", "/api/experts"]]) {
      await page.route("**" + api + "**", (route) => route.abort());
      await page.evaluate((sid) => window.openWorkbench(sid), id);
      await wait(500);
      const s = await page.evaluate(() => {
        const body = document.querySelector("#wbBody");
        const lst = document.querySelector("#wbBody .wb-side-list");
        const det = document.querySelector("#wbBody .wb-detail");
        return {
          bodyTxt: body ? (body.innerText || "").trim() : "",
          lstTxt: lst ? (lst.innerText || "").trim() : "",
          lstH: lst ? Math.round(lst.getBoundingClientRect().height) : 0,
          detTxt: det ? (det.innerText || "").trim() : "",
        };
      });
      const visible = /失败|失效|错误|重试/.test(s.bodyTxt);
      ok(id + " 接口失败时页面写明原因（不留白）", visible, JSON.stringify(s).slice(0, 200));
      if (s.lstH) ok(id + " 左列表失败态不塌成一条", s.lstTxt.length >= 2 && s.lstH >= 28, JSON.stringify(s).slice(0, 160));
      await page.unroute("**" + api + "**");
    }
    /* 空数据（接口正常但一条都没有）也要有可见空态 */
    const empt = await page.evaluate(async () => {
      const out = [];
      for (const sid of ["skills", "rules", "memory", "experts"]) {
        window.openWorkbench(sid);
        await new Promise((r) => setTimeout(r, 420));
        const det = document.querySelector("#wbBody .wb-detail");
        const lst = document.querySelector("#wbBody .wb-side-list");
        out.push({ sid, det: det ? (det.innerText || "").trim().length : -1, lst: lst ? (lst.innerText || "").trim().length : -1 });
      }
      return out;
    });
    ok("资产分区右侧详情区始终有内容（占位或表单，不留空框）",
      empt.every((e) => e.det > 0), JSON.stringify(empt));
    await page.screenshot({ path: path.join(OUT, "layout_skills_placeholder.png") }).catch(() => {});
    await page.close();

    /* ---------- Skill 选择器 ---------- */
    section("输入栏 Skill 选择器");
    page = await openPage("dark", 1440);
    const skl = await page.evaluate(async () => {
      const btn = document.getElementById("btnSkillPick");
      if (!btn) return { present: false };
      btn.click();
      await new Promise((r) => setTimeout(r, 700));
      const pop = document.getElementById("ciSkillPop");
      // getComputedStyle 返回的是活对象：取值要当场落成字符串
      const disp = getComputedStyle(pop).display;
      const rect = pop.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      const items = pop.querySelectorAll(".ci-skill-opt").length;
      const first = pop.querySelector(".ci-skill-opt");
      const search = document.getElementById("ciSkillSearch");
      let filtered = items;
      let afterClear = items;
      if (search) {
        search.value = "test";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
        filtered = pop.querySelectorAll(".ci-skill-opt").length;
        search.value = "";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 200));
        afterClear = pop.querySelectorAll(".ci-skill-opt").length;
      }
      return {
        present: true,
        display: disp,
        w: Math.round(rect.width), h: Math.round(rect.height),
        top: Math.round(rect.top), bottom: Math.round(rect.bottom),
        right: Math.round(rect.right), vw: window.innerWidth,
        vh: window.innerHeight,
        inView: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.height > 40,
        anchored: rect.bottom <= btnRect.top + 2 && Math.abs(rect.left - btnRect.left) < 40,
        items, filtered, afterClear,
        firstName: first ? (first.textContent || "").trim() : "",
        txt: (pop.innerText || "").trim().slice(0, 60),
      };
    });
    ok("Skill 按钮存在", skl.present === true);
    ok("点 Skill 弹出可选窗口", skl.display !== "none" && skl.h > 40, JSON.stringify(skl));
    ok("Skill 窗口落在可视区内（不被输入栏裁掉）", skl.inView === true, JSON.stringify(skl));
    ok("窗口贴着 Skill 按钮向上弹出", skl.anchored === true, JSON.stringify({ bottom: skl.bottom, top: skl.top, vh: skl.vh }));
    ok("窗口右侧不顶出可视区（列表项不被裁掉）", skl.right <= skl.vw - 8, JSON.stringify({ right: skl.right, vw: skl.vw }));
    ok("Skill 窗口里有可选项（" + skl.items + " 个）", skl.items >= 1, JSON.stringify(skl).slice(0, 220));
    ok("顶部搜索框按名称/分类筛掉无关项（" + skl.items + " → " + skl.filtered + "）",
      skl.filtered >= 1 && skl.filtered < skl.items, JSON.stringify({ items: skl.items, filtered: skl.filtered }));
    ok("清空搜索后全部项回来（" + skl.afterClear + " 项）", skl.afterClear === skl.items, JSON.stringify({ items: skl.items, afterClear: skl.afterClear }));
    await page.screenshot({ path: path.join(OUT, "layout_skill_pop.png") }).catch(() => {});
    const pick = await page.evaluate(() => {
      const pop = document.getElementById("ciSkillPop");
      const first = pop.querySelector(".ci-skill-opt");
      if (first) first.click();
      const tag = document.getElementById("ciSkillActive");
      return {
        picked: !!tag && tag.style.display !== "none" && (tag.textContent || "").trim().length > 1,
        tagTxt: tag ? (tag.textContent || "").trim() : "",
        popClosed: getComputedStyle(pop).display === "none",
      };
    });
    ok("点选一项后引用生效（输入栏出现 Skill 标签）", pick.picked === true, JSON.stringify(pick));
    ok("点选后窗口自动收起", pick.popClosed === true, JSON.stringify(pick.popClosed));
    await page.close();

    /* 窄窗口：Skill 窗口要么收窄要么反向对齐，总之不能把列表裁掉 */
    page = await openPage("dark", 1100);
    const sklNarrow = await page.evaluate(async () => {
      document.getElementById("btnSkillPick").click();
      await new Promise((r) => setTimeout(r, 600));
      const pop = document.getElementById("ciSkillPop");
      const rect = pop.getBoundingClientRect();
      return {
        w: Math.round(rect.width), right: Math.round(rect.right), top: Math.round(rect.top),
        vw: window.innerWidth, vh: window.innerHeight,
        items: pop.querySelectorAll(".ci-skill-opt").length,
        firstVisible: (() => { const f = pop.querySelector(".ci-skill-opt"); if (!f) return false; const r = f.getBoundingClientRect(); return r.right <= window.innerWidth && r.width > 60; })(),
      };
    });
    ok("1100px 宽：Skill 窗口仍在可视区内且列表完整", sklNarrow.right <= sklNarrow.vw - 8 && sklNarrow.top >= 0 && sklNarrow.items >= 1, JSON.stringify(sklNarrow));
    ok("1100px 宽：首个选项没被右边界裁掉", sklNarrow.firstVisible === true, JSON.stringify(sklNarrow));
    await page.screenshot({ path: path.join(OUT, "layout_skill_pop_1100.png") }).catch(() => {});
    page = await openPage("dark", 1440);   // 后面的滚动按钮体检继续用默认宽度

    /* ---------- 滚动到顶/底按钮：必须钉在整个对话窗口上，不跟着内容滚 ---------- */
    section("对话窗口滚动按钮");
    const scr = await page.evaluate(async () => {
      const stream = document.getElementById("chatStream");
      const btns = document.getElementById("chatScrollBtns");
      // 灌足够多的内容制造溢出
      for (let i = 0; i < 40; i++) {
        const d = document.createElement("div");
        d.className = "msg msg-ai";
        d.textContent = "填充行 " + i + " ——————————————————————————————";
        stream.appendChild(d);
      }
      stream.scrollTop = stream.scrollHeight / 2;
      await new Promise((r) => setTimeout(r, 500));
      const r1 = btns.getBoundingClientRect();
      const sr = stream.getBoundingClientRect();
      stream.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 400));
      const r2 = btns.getBoundingClientRect();
      stream.scrollTop = stream.scrollHeight;
      await new Promise((r) => setTimeout(r, 400));
      const r3 = btns.getBoundingClientRect();
      return {
        visible: getComputedStyle(btns).opacity,
        pinned: Math.abs(r1.top - r2.top) < 4 && Math.abs(r2.top - r3.top) < 4,
        insideViewport: r3.bottom <= sr.bottom + 2 && r3.top >= sr.top - 2,
        parent: btns.parentElement.id,
        tops: [Math.round(r1.top), Math.round(r2.top), Math.round(r3.top)],
      };
    });
    ok("滚动按钮钉在对话窗口上（内容滚动时位置不变）", scr.pinned === true, JSON.stringify(scr));
    ok("滚动按钮始终落在可视区内", scr.insideViewport === true, JSON.stringify(scr));
    ok("滚动按钮不挂在滚动容器 #chatStream 内部", scr.parent !== "chatStream", "父节点=" + scr.parent);
    await page.screenshot({ path: path.join(OUT, "layout_scroll_btns.png") }).catch(() => {});
    await page.close();

    /* ---------- 步骤流：一条时间轴，左槽不许有多条竖线互相重叠 ---------- */
    section("步骤流时间轴（深/浅两套）");
    const buildRun = async (theme) => {
      const p = await openPage(theme, 1440);
      const res = await p.evaluate(async () => {
        const pane = window.chatPane();
        Array.from(pane.children).forEach((c) => { if (!c.id) c.remove(); });   // 保留 #stepPill
        window.addUserMsg("列出 workspace/ 的文件并跑一次测试");
        const think = document.createElement("div");
        think.className = "think-block open";
        think.innerHTML = '<div class="think-head">' + ico("bulb") + '<span class="tk-label">已思考 · 先看目录结构</span></div><div class="think-body">按目录逐层看</div>';
        window.appendChatBlock(think);
        for (let i = 0; i < 7; i++) {
          const el = document.createElement("div");
          el.className = "tool-card step " + (i === 6 ? "k-terminal" : "k-read") + (i === 3 ? " open" : "");
          el.innerHTML = '<div class="tool-head"><span class="t-state ' + (i === 6 ? "run" : "ok") + '">' + ico("circleCheck") + "</span>" +
            '<span class="t-kind">' + ico("files") + '</span><span class="t-name">浏览目录</span>' +
            '<span class="t-target"><code>workspace/</code></span><span class="t-dur">0.4s</span>' +
            '<span class="t-status ' + (i === 6 ? "running" : "done") + '">' + (i === 6 ? "执行中" : "完成") + '</span></div><div class="tool-body">a.js b.js</div>';
          window.appendChatBlock(el);
        }
        const ap = document.createElement("div");
        ap.className = "tool-card approval open k-edit";
        ap.innerHTML = '<div class="tool-head"><span class="t-kind">' + ico("edit") + '</span><span class="t-name">需要确认：写文件</span><span class="t-target">server/x.js</span></div><div class="tool-body approval-body">路径：server/x.js</div>';
        window.appendChatBlock(ap);
        const row = document.createElement("div");
        row.className = "msg-row ans-row";
        row.innerHTML = '<div class="msg msg-ai">已完成，共 12 个文件。</div>';
        pane.appendChild(row);

        // msgIn 动画带 translateY(8px)/blur，等它跑完再量几何与截图
        await new Promise((r) => setTimeout(r, 1400));
        const g = pane.querySelector(":scope > .step-flow");
        const gr = g.getBoundingClientRect();
        return {
          groups: pane.querySelectorAll(":scope > .step-flow").length,
          groupChildren: g ? g.children.length : 0,
          answerOutside: row.parentElement === pane,
          lines: window.__railLines(g),
          railW: g ? parseFloat(getComputedStyle(g, "::before").width) : 0,
          railX: g ? parseFloat(getComputedStyle(g, "::before").left) : 0,
          railH: g ? gr.height - (parseFloat(getComputedStyle(g, "::before").top) || 0) - (parseFloat(getComputedStyle(g, "::before").bottom) || 0) : 0,
          groupH: Math.round(gr.height),
          stateBg: g ? getComputedStyle(g.querySelector(".t-state")).backgroundColor : "",
          stepBorderL: g ? getComputedStyle(g.querySelector(".tool-card.step")).borderLeftWidth : "",
        };
      });
      await p.screenshot({ path: path.join(OUT, "layout_stepflow_" + theme + ".png") }).catch(() => {});
      await p.close();
      return res;
    };
    for (const theme of ["dark", "light"]) {
      const t = await buildRun(theme);
      const owners = t.lines.map((l) => l.owner + "@" + l.x).join(", ");
      ok("[" + theme + "] 连续过程归入同一条时间轴分组", t.groups === 1, "分组数=" + t.groups);
      ok("[" + theme + "] 9 个过程块（1 思考 + 7 步骤 + 1 审批）全在分组里", t.groupChildren === 9, "子节点=" + t.groupChildren);
      ok("[" + theme + "] 最终回答独立于过程分组", t.answerOutside === true);
      ok("[" + theme + "] 左槽只剩 1 条竖线（重构前 ≥3 条互相遮挡）", t.lines.length === 1, t.lines.length + " 条：" + owners);
      ok("[" + theme + "] 这条线就是分组时间轴（宽 " + t.railW + "px @ x=" + t.railX + "）",
        t.lines.length === 1 && /\.step-flow/.test(t.lines[0].owner) && t.railW === 2, JSON.stringify(t.lines));
      ok("[" + theme + "] 时间轴贯穿整段过程（线高 " + Math.round(t.railH) + " / 组高 " + t.groupH + "）",
        t.railH >= t.groupH * 0.72, "占比=" + (t.railH / t.groupH).toFixed(2));
      ok("[" + theme + "] 步骤行不再自绘 border-left", parseFloat(t.stepBorderL) < 2, "border-left=" + t.stepBorderL);
      ok("[" + theme + "] 状态圆点有底色遮住穿过的线（不是线压图标）",
        !!t.stateBg && t.stateBg !== "rgba(0, 0, 0, 0)" && !/rgba\([^)]*,\s*0\)$/.test(t.stateBg), t.stateBg);
    }

    /* ---------- 真发一条消息：走 WS 事件流的步骤流 ---------- */
    section("真实运行一轮（WS 事件流）");
    page = await openPage("dark", 1440);
    const started = Date.now();
    const sent = await page.evaluate(async () => {
      await fetch("/api/agent-settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: { mode: "auto" } }),
      });
      document.getElementById("ciPerm").value = "auto";
      document.getElementById("btnSkillPick").click();                 // 先真的选一个 Skill
      await new Promise((r) => setTimeout(r, 500));
      const opt = document.querySelector("#ciSkillPop .ci-skill-opt");
      const pickedName = opt ? String((opt.querySelector(".ci-skill-opt-name") || {}).textContent || "").trim() : "";
      if (opt) opt.click();
      document.getElementById("chatInput").value = "列出 workspace 的文件并说明各自作用";
      window._doSend();
      return pickedName;
    });
    ok("真实运行前成功选用了 Skill", sent.length > 1, "Skill=" + sent);
    const live = await page.evaluate(async () => {
      const deadline = Date.now() + 60000;
      let steps = 0, running = 1, done = false;
      for (;;) {
        await new Promise((r) => setTimeout(r, 500));
        const pane = window.chatPane();
        steps = pane.querySelectorAll(".tool-card.step").length;
        running = pane.querySelectorAll(".t-state.run").length;
        done = !!pane.querySelector(".msg-row.ans-row") && steps >= 2 && !running;
        if (done || Date.now() > deadline) break;
      }
      const pane = window.chatPane();
      const gs = Array.from(pane.querySelectorAll(":scope > .step-flow"));
      const user = pane.querySelector(".msg-user");
      return {
        done, steps, running,
        groups: gs.length,
        stepsInGroups: gs.reduce((a, g) => a + g.querySelectorAll(".tool-card.step").length, 0),
        perGroup: gs.map((g) => {
          const r = g.getBoundingClientRect();
          return {
            lines: window.__railLines(g).length,
            onlyRail: window.__railLines(g).every((l) => /\.step-flow/.test(l.owner)),
            railH: r.height - (parseFloat(getComputedStyle(g, "::before").top) || 0) - (parseFloat(getComputedStyle(g, "::before").bottom) || 0),
            groupH: Math.round(r.height),
          };
        }),
        userTxt: user ? (user.textContent || "").trim().slice(0, 60) : "",
        userFull: user ? (user.textContent || "").trim() : "",
        userChip: user ? String((user.querySelector(".msg-skill") || {}).textContent || "") : "",
        skillInBody: /【本轮采用 Skill|\[引用 Skill/.test(user ? (user.textContent || "") : ""),
        answer: (() => { const a = pane.querySelector(".msg-row.ans-row .msg-ai"); return a ? (a.textContent || "").trim().slice(0, 40) : ""; })(),
      };
    });
    const el = ((Date.now() - started) / 1000).toFixed(1);
    ok("演示引擎真跑完一轮（" + live.steps + " 步 / " + el + "s）", live.done === true, JSON.stringify(live).slice(0, 300));
    /* #43 之后的契约：选 Skill 不该往用户那句话里塞正文。
       气泡上只留一枚"✦ 技能名"标记，用户原话原样显示；旧写法是
       "[引用 Skill: 名]\n<整份正文>\n\n---\n\n<原话>"，气泡被模板糊满。 */
    ok("用户气泡上方有 Skill 标记，且带的是选中的那个名字",
      live.userChip === "✦ " + sent, JSON.stringify({ chip: live.userChip, picked: sent }));
    ok("用户原话原样在气泡里（没被 Skill 正文糊住）",
      live.userFull.endsWith("列出 workspace 的文件并说明各自作用"), live.userTxt);
    ok("正文没被拼进用户消息（旧格式与新格式都不许出现）", live.skillInBody === false, live.userTxt);
    ok("真实事件流下每张步骤卡都在时间轴分组里（" + live.stepsInGroups + "/" + live.steps + "）",
      live.groups >= 1 && live.stepsInGroups === live.steps, JSON.stringify({ groups: live.groups, in: live.stepsInGroups, steps: live.steps }));
    ok("真实运行后每个分组的左槽依然只有 1 条竖线",
      live.perGroup.every((g) => g.lines === 1 && g.onlyRail), JSON.stringify(live.perGroup));
    ok("时间轴贯穿整段真实步骤", live.perGroup.every((g) => g.railH >= g.groupH * 0.72),
      JSON.stringify(live.perGroup.map((g) => g.railH + "/" + g.groupH)));
    await page.screenshot({ path: path.join(OUT, "layout_stepflow_live.png") }).catch(() => {});

    /* 用户报的第 1 条：任务结束了、AI 已空闲，进度胶囊的圈圈还在转。
       轮询要等到 agent.state(false) 真的落到前端，再读胶囊的收尾状态——否则测的是"事件还没到"而不是"没清"。 */
    const pillEnd = await page.evaluate(async () => {
      const deadline = Date.now() + 8000;
      while (state.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const p = document.getElementById("stepPill");
      return {
        idle: !state.running,
        busy: p ? String(p.dataset.busy || "") : "no-pill",
        spin: !!document.querySelector("#stepPill .sp-spin"),
        icon: !!document.querySelector("#stepPill svg"),
        txt: p ? (p.textContent || "").replace(/\s+/g, " ").trim() : "",
        leftRunning: window.chatPane().querySelectorAll(".t-state.run").length,
        hdr: ((document.getElementById("sbAgentTxt") || {}).textContent || "").trim(),
      };
    });
    ok("跑完后顶部状态确为空闲（胶囊收尾的前提）", pillEnd.idle === true, JSON.stringify(pillEnd).slice(0, 200));
    ok("跑完后进度胶囊不再空转（无转圈圈、busy 已清）",
      pillEnd.spin === false && pillEnd.busy !== "1", JSON.stringify({ spin: pillEnd.spin, busy: pillEnd.busy }));
    ok("跑完后胶囊换成完成/失败图标", pillEnd.icon === true && /步骤/.test(pillEnd.txt), pillEnd.txt);
    ok("收尾时界面里不留「执行中」的步骤卡", pillEnd.leftRunning === 0, "残留 " + pillEnd.leftRunning + " 张");

    /* 用户报「长期记忆没显示具体内容，只显示我发送的某些消息」：
       旧卡片只渲染 topic，而旧条目的 topic 是当年拿用户原话切片落盘的——回显卡满屏"用户说过的话"。
       新契约：content 随台账走、卡片正文行显示记忆内容；topic 与正文开头重复时不再重复显示。 */
    const recall = await page.evaluate(() => {
      renderRecallCard({ type: "memory.recall", entries: [
        { scope: "project", id: "p1", type: "lesson", topic: "端口约定", content: "dev 服务器固定跑 5178 端口，换端口要同步改 electron 配置", valueScore: 4, accessCount: 2 },
        { scope: "user", id: "u1", type: "preference", topic: "启动项目", content: "启动项目后要先装依赖再跑 dev，否则端口会冲突", valueScore: 3, accessCount: 0 },
        { scope: "project", id: "p2", type: "decision", topic: "只有标题没有正文", content: "", valueScore: 2, accessCount: 0 },
      ] });
      const cards = document.querySelectorAll(".recall-card");
      const card = cards[cards.length - 1];
      if (!card) return { found: false };
      card.classList.add("open");
      const rows = [...card.querySelectorAll(".rc-row")];
      const topic = (r) => (r.querySelector(".rc-topic") || {}).textContent || "";
      const content = (r) => (r.querySelector(".rc-content") || {}).textContent || "";
      return {
        found: true, rows: rows.length,
        head: (card.querySelector(".rc-title") || {}).textContent || "",
        t0: topic(rows[0]), c0: content(rows[0]),
        t1: topic(rows[1]), c1: content(rows[1]),
        c2: content(rows[2]),
        scope1: rows[1] ? rows[1].querySelector(".rc-scope.user") != null : false,
      };
    });
    ok("记忆回显卡渲染出来（3 条明细，标题计数正确）",
      recall.found === true && recall.rows === 3 && /3 条/.test(recall.head), JSON.stringify(recall).slice(0, 240));
    ok("回显卡正文行显示记忆内容（不再只有 topic）",
      recall.c0 === "dev 服务器固定跑 5178 端口，换端口要同步改 electron 配置", JSON.stringify(recall).slice(0, 300));
    ok("像样的 topic 保留显示", recall.t0 === "端口约定", "t0=" + recall.t0);
    ok("topic 与正文开头重复（旧的原话切片）不再重复显示", recall.t1 === "", "t1=" + recall.t1);
    ok("无正文的条目不出空内容行", recall.c2 === "", "c2=" + recall.c2);
    ok("跨项目记忆仍带用户级标色", recall.scope1 === true, "scope1=" + recall.scope1);

    /* #45：编排历史侧栏要能看到"分发出去的子 agent 任务与结果"。
       mock /api/orch/history 灌一条三步记录（成功/失败/进行中），断言步骤行渲染出 task 与 output 摘要。 */
    const orchUi = await page.evaluate(async () => {
      const runs = [{ id: "orch-test", title: "探针编排", ok: false, elapsed: 3.2, ts: Date.now(),
        counts: { done: 1, fail: 1, total: 3 }, summary: "编排「探针编排」完成：1 成功，1 失败",
        steps: [
          { id: "s1", name: "检索", status: "done", layer: 0, agent_type: "general", task: "在仓库里找出所有入口文件", output: "找到 3 个入口：server/index.js、electron/main.js、public/index.html" },
          { id: "s2", name: "评审", status: "fail", layer: 0, agent_type: "reviewer", task: "评审上一步结果", output: "子智能体超时" },
          { id: "s3", name: "补位", status: "running", layer: 1, agent_type: "general", task: "修复评审意见", output: "" },
        ] }];
      const realFetch = window.fetch;
      window.fetch = () => Promise.resolve(new Response(JSON.stringify({ ok: true, runs }), { headers: { "Content-Type": "application/json" } }));
      try { await renderOrchHistory(); } finally { window.fetch = realFetch; }
      const items = [...document.querySelectorAll("#agOrchHistory .ag-orch-item")];
      const it = items.find((x) => (x.textContent || "").includes("探针编排"));
      if (!it) return { found: false, items: items.length };
      const steps = [...it.querySelectorAll(".ag-orch-step")];
      return {
        found: true, items: items.length, steps: steps.length,
        task0: (steps[0].querySelector(".ag-orch-step-task") || {}).textContent || "",
        out0: (steps[0].querySelector(".ag-orch-step-out") || {}).textContent || "",
        failDot: !!it.querySelector(".ag-orch-step.fail"),
      };
    });
    ok("编排历史条目渲染（3 个子任务行）", orchUi.found === true && orchUi.steps === 3, JSON.stringify(orchUi).slice(0, 240));
    ok("子任务行显示派发的任务原文（task）", /入口文件/.test(orchUi.task0), "task=" + orchUi.task0);
    ok("子任务行显示结果摘要（output）", /server\/index\.js/.test(orchUi.out0), "out=" + orchUi.out0);
    ok("失败子任务带失败状态点", orchUi.failDot === true, "failDot=" + orchUi.failDot);

    /* 诊断：胶囊有没有被谁裁掉（临时输出，确认后转断言） */
    await page.evaluate(() => {
      const pill = document.getElementById("stepPill");
      // 复刻用户截图里的长内容（步骤 x/y + 文件数 + +增 -删 + 失败数），短内容裁不裁看不出来
      pill.style.display = "";
      pill.innerHTML = '<span class="sp-steps"><i class="sp-spin"></i>步骤 <b>2</b>/50</span>' +
        '<span class="sp-sep"></span><span class="sp-files">50 个文件已修改</span>' +
        '<span class="sp-stat"><b class="add">+41017</b> <b class="del">−7751</b></span>' +
        '<span class="sp-sep"></span><span class="sp-fail">3 步失败</span>';
      const r = pill.getBoundingClientRect();
      const cs = getComputedStyle(pill);
      const anc = [];
      let n = pill.parentElement;
      while (n && n !== document.documentElement) {
        const c = getComputedStyle(n);
        const ar = n.getBoundingClientRect();
        if (c.overflow !== "visible" || c.overflowY !== "visible" || c.overflowX !== "visible") {
          anc.push({ el: n.id || String(n.className).slice(0, 28), ox: c.overflowX, oy: c.overflowY,
            top: Math.round(ar.top), bottom: Math.round(ar.bottom), h: Math.round(ar.height) });
        }
        n = n.parentElement;
      }
      const out = {
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        scrollH: pill.scrollHeight, clientH: pill.clientHeight, scrollW: pill.scrollWidth, clientW: pill.clientWidth,
        maxW: cs.maxWidth, ovf: cs.overflow, ws: cs.whiteSpace, align: cs.alignSelf, pos: cs.position,
        text: (pill.textContent || "").replace(/\s+/g, " ").trim(),
        ancestors: anc,
      };
      renderStepPill();   // 还原成真实内容
      return out;
    });

    /* ---------- 层叠泄漏：聊天栏的高 z-index 浮层不许盖到设置台上面 ---------- */
    section("浮层不越界（设置台右上角碎片）");
    const leak = await page.evaluate(async () => {
      const pill = document.getElementById("stepPill");
      if (!pill) return { noPill: true };
      const r = pill.getBoundingClientRect();
      const c = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      const hit = (p) => document.elementFromPoint(p.x, p.y);
      const onPill = !!(hit(c) && hit(c).closest && hit(c).closest("#stepPill"));   // 前提：这个点真的落在胶囊上
      window.openWorkbench("agent");
      await new Promise((res) => setTimeout(res, 1200));
      const top1 = hit(c);
      const pillCovered = !!(top1 && top1.closest && top1.closest("#workbench"));
      // Skill 下拉：开着的时候也不能漏到设置台之上
      document.getElementById("btnSkillPick").click();
      await new Promise((res) => setTimeout(res, 400));
      const pop = document.getElementById("ciSkillPop");
      const pr = pop.getBoundingClientRect();
      const pc = { x: Math.round(pr.left + pr.width / 2), y: Math.round(pr.top + Math.min(60, pr.height / 2)) };
      const top2 = document.elementFromPoint(pc.x, pc.y);
      const popCovered = !!(top2 && top2.closest && top2.closest("#workbench"));
      const zPill = getComputedStyle(pill).zIndex;
      const zWb = getComputedStyle(document.getElementById("workbench")).zIndex;
      // 同类泄漏不止设置台：所有 --z-modal 遮罩层（diff / 技能 / 文件夹 …）都要压住栏内浮层
      closeWorkbench();
      const sk = document.getElementById("skillModal");
      sk.style.display = "flex";
      await new Promise((res) => setTimeout(res, 300));
      const top3 = hit(c);
      const modalCovered = !!(top3 && top3.closest && top3.closest("#skillModal"));
      sk.style.display = "none";
      return {
        onPill, pillCovered, popCovered, modalCovered, zPill, zWb, c,
        topCls: top1 ? String(top1.id || top1.className || top1.tagName).slice(0, 40) : "",
      };
    });
    ok("前提成立：胶囊那个点确实命中胶囊（不是空测）", leak.onPill === true, JSON.stringify(leak));
    ok("打开设置台后聊天栏浮层被压住（右上角不再浮碎片）", leak.pillCovered === true, "命中：" + leak.topCls);
    ok("Skill 下拉在设置台之下（同样不泄漏）", leak.popCovered === true, JSON.stringify(leak.popCovered));
    ok("--z-modal 那层遮罩（技能弹窗）同样压得住栏内浮层", leak.modalCovered === true, JSON.stringify(leak.modalCovered));
    ok("层叠值：设置台 " + leak.zWb + " > 栏内浮层 " + leak.zPill, Number(leak.zWb) > Number(leak.zPill), JSON.stringify({ zWb: leak.zWb, zPill: leak.zPill }));
    await page.screenshot({ path: path.join(OUT, "layout_wb_no_leak.png") }).catch(() => {});
    const back = await page.evaluate((p) => {
      document.getElementById("ciSkillPop").style.display = "none";
      closeWorkbench();
      return new Promise((res) => setTimeout(() => {
        const pill = document.getElementById("stepPill");
        const hit = document.elementFromPoint(p.c.x, p.c.y);
        res({
          pillStillThere: getComputedStyle(pill).display !== "none",
          backOnPill: !!(hit && hit.closest && hit.closest("#stepPill")),
        });
      }, 400));
    }, leak);
    ok("关闭设置台后胶囊回到对话区可见（没被误伤）", back.backOnPill === true && back.pillStillThere === true, JSON.stringify(back));
    await page.close();

    /* ---------- 进度胶囊不许被 flex 压扁 ---------- */
    section("进度胶囊完整可见");
    page = await openPage("dark", 1440);
    const pill = await page.evaluate(() => {
      const p = document.getElementById("stepPill");
      if (!p) return { missing: true };
      p.style.display = "";
      p.innerHTML = '<span class="sp-steps"><i class="sp-spin"></i>步骤 <b>2</b>/50</span>' +
        '<span class="sp-sep"></span><span class="sp-files">50 个文件已修改</span>' +
        '<span class="sp-stat"><b class="add">+41017</b> <b class="del">−7751</b></span>' +
        '<span class="sp-sep"></span><span class="sp-fail">3 步失败</span>';
      // 灌满内容制造溢出：胶囊是 flex 子节点，只有内容超出滚动区时才会暴露被压扁的问题
      const stream = document.getElementById("chatStream");
      const pane = window.chatPane();
      for (let i = 0; i < 40; i++) {
        const d = document.createElement("div");
        d.className = "msg msg-ai";
        d.textContent = "填充行 " + i;
        pane.appendChild(d);
      }
      stream.scrollTop = stream.scrollHeight;
      const r = p.getBoundingClientRect();
      const sr = stream.getBoundingClientRect();
      const out = {
        h: Math.round(r.height), need: p.scrollHeight, w: Math.round(r.width),
        clippedV: p.scrollHeight - p.clientHeight, clippedH: p.scrollWidth - p.clientWidth,
        shrink: getComputedStyle(p).flexShrink, overflow: getComputedStyle(p).overflow,
        inside: r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1,
      };
      renderStepPill();
      return out;
    });
    ok("胶囊没被 flex 压扁（高 " + pill.h + " / 需要 " + pill.need + "）", pill.missing !== true && pill.h >= pill.need - 1, JSON.stringify(pill));
    ok("胶囊纵向没有被裁（clip " + pill.clippedV + "px）", pill.clippedV <= 1, JSON.stringify(pill));
    ok("胶囊不参与收缩（flex-shrink=" + pill.shrink + "）", pill.shrink === "0", JSON.stringify(pill));
    ok("胶囊在对话区可视范围内", pill.inside === true, JSON.stringify(pill));

    /* ---------- 配色：深浅两侧各记各的，切回去不该丢 ---------- */
    section("配色记忆（切深浅不跳回默认）");
    const pal = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      applyTheme("dark"); applyPalette("midnight");
      await wait(60);
      const dark1 = document.documentElement.getAttribute("data-palette");
      applyTheme("light");
      await wait(60);
      const lightPal = document.documentElement.getAttribute("data-palette");
      const lightUsable = lightPal === "celadon" || lightPal === "parchment" || lightPal === "linen" || lightPal === "rose" || lightPal === "contrast";
      applyPalette("parchment");
      await wait(60);
      applyTheme("dark");
      await wait(60);
      const dark2 = document.documentElement.getAttribute("data-palette");
      applyTheme("light");
      await wait(60);
      const light2 = document.documentElement.getAttribute("data-palette");
      // 真正生效的证据：底色变量必须跟着配色变，而不是只改了个属性
      const bgLight = getComputedStyle(document.body).backgroundColor;
      applyTheme("dark");
      await wait(60);
      const bgDark = getComputedStyle(document.body).backgroundColor;
      return { dark1, lightPal, lightUsable, dark2, light2, keptDark: dark2 === "midnight", keptLight: light2 === "parchment", bgLight, bgDark, bgChanged: bgLight !== bgDark };
    });
    ok("深色侧选了「午夜」", pal.dark1 === "midnight", JSON.stringify(pal));
    ok("切到浅色后浅色侧自己成套（" + pal.lightPal + "）", pal.lightUsable === true, JSON.stringify(pal));
    ok("切回深色仍是「午夜」，没跳回默认石墨", pal.keptDark === true, JSON.stringify(pal));
    ok("浅色侧选的「羊皮纸」也记住了", pal.keptLight === true, JSON.stringify(pal));
    ok("底色真的跟着主题变（不是只改属性）", pal.bgChanged === true, JSON.stringify({ bgLight: pal.bgLight, bgDark: pal.bgDark }));

    /* ---------- 三个曾经没有遮罩样式的弹窗 ---------- */
    section("提交 / 快捷键 / 自动化 弹窗可见性");
    const modals = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const probe = async (open, id) => {
        open();
        await wait(800);
        const m = document.getElementById(id);
        const cs = getComputedStyle(m);
        // getComputedStyle 是活对象：所有取值当场落成原始值，后面隐藏元素才不会读到 "none"
        const pos = cs.position, disp = cs.display, z = cs.zIndex;
        const r = m.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        const box = m.querySelector(".set-box, .confirm-box, .cmdk-box, .wb") || m.firstElementChild;
        const br = box ? box.getBoundingClientRect() : r;
        const out = { id, pos, disp, z, w: Math.round(br.width), h: Math.round(br.height),
          hitIn: !!(hit && m.contains(hit)),
          inView: br.top >= -1 && br.left >= -1 && br.bottom <= window.innerHeight + 1 && br.right <= window.innerWidth + 1 };
        m.style.display = "none";
        return out;
      };
      const a = await probe(() => openCommit(), "commitModal");
      const b = await probe(() => openShortcuts(), "shortcutsModal");
      const c = await probe(() => { document.getElementById("automationsModal").style.display = "flex"; }, "automationsModal");
      return [a, b, c];
    });
    modals.forEach((m) => {
      ok("#" + m.id + " 是居中遮罩层（" + m.pos + " / z " + m.z + "）", m.pos === "fixed" && Number(m.z) >= 300, JSON.stringify(m));
      ok("#" + m.id + " 打开后中心点命中弹窗自己（不是看不见）", m.hitIn === true, JSON.stringify(m));
      ok("#" + m.id + " 完整落在视口内（" + m.w + "×" + m.h + "）", m.inView === true && m.w > 200 && m.h > 60, JSON.stringify(m));
      ok("#" + m.id + " 打开状态下 display 为 flex", m.disp === "flex", JSON.stringify(m));
    });

    /* ---------- 模型分区：一个模块 + 没有内置假模型 + 填完就能拉 ---------- */
    section("模型配置模块");
    const mock = await startMockUpstream();
    const mdl = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.openWorkbench("model");
      await wait(1500);
      const body = document.getElementById("wbBody");
      const txt = (body.innerText || "").replace(/\s+/g, " ");
      const fake = ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "deepseek-chat", "deepseek-reasoner", "kimi-k2-0905-preview", "qwen-max", "glm-4.5"]
        .filter((m) => txt.includes(m));
      const pull = [...body.querySelectorAll("button")].find((b) => /拉取模型/.test(b.textContent));
      if (pull) { pull.click(); await wait(1500); }
      const afterPull = (document.getElementById("wbBody").innerText || "").replace(/\s+/g, " ");
      const groups = body.querySelectorAll(".wb-group").length;
      const need = ["接口地址", "API Key", "拉取模型", "测试模型", "存为配置", "已保存的配置"];
      const inp = [...body.querySelectorAll("input")];
      return { groups, missing: need.filter((k) => !txt.includes(k)), fake, saysGateway: /网关/.test(txt), pullText: pull ? pull.textContent : "", afterPull: afterPull.slice(0, 220), chips: body.querySelectorAll(".wb-model-chip").length, none: body.querySelectorAll(".wb-model-none").length,
        hasUrlInp: inp.some((i) => /api\.openai\.com/.test(i.placeholder || "")), hasKeyInp: inp.some((i) => /^sk-|已保存/.test(i.placeholder || "")) };
    });
    ok("模型分区一屏含 6 个关键控件（拉取/测试/保存/已存配置都在）", mdl.missing.length === 0, "缺：" + mdl.missing.join("、"));
    ok("接口地址与 API Key 两个输入框真的被画出来了", mdl.hasUrlInp === true && mdl.hasKeyInp === true, JSON.stringify(mdl).slice(0, 220));
    ok("界面里不再出现内置假模型名", mdl.fake.length === 0, "出现：" + mdl.fake.join("、"));
    ok("沙箱没填地址时拉取给出真实空态（不是假清单）", mdl.none >= 1 && mdl.chips === 0, JSON.stringify(mdl).slice(0, 260));
    ok("提示文案里不再出现「网关」这种莫名词汇", mdl.saysGateway === false, mdl.afterPull);

    /* 用户报的第 2 条：「设置了大模型配置，拉取模型失败，这个不需要网关啊」。
       这里填完两个输入框就立刻点按钮（不给它落盘的时间），要求直接列出模型。 */
    const typed = await page.evaluate(async (base) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const body = document.getElementById("wbBody");
      const inputs = [...body.querySelectorAll("input.wb-input")];
      const urlInp = inputs.find((i) => /api\.openai\.com/.test(i.placeholder || ""));
      const keyInp = inputs.find((i) => /^sk-|已保存/.test(i.placeholder || ""));
      if (!urlInp || !keyInp) return { err: "找不到输入框", inputs: inputs.map((i) => i.placeholder) };
      urlInp.value = base + "/v1/chat/completions";   // 故意用"多填了路径"的写法
      keyInp.value = "sk-typed-1234";
      const pull = [...body.querySelectorAll("button")].find((b) => /拉取模型/.test(b.textContent));
      pull.click();
      await wait(3000);
      const b2 = document.getElementById("wbBody");
      return {
        chips: [...b2.querySelectorAll(".wb-model-chip")].map((x) => x.textContent.trim()),
        none: [...b2.querySelectorAll(".wb-model-none")].map((x) => (x.textContent || "").trim()),
      };
    }, mock.base);
    ok("填完地址立刻点「拉取模型」就能列出模型（用表单当前值，不等保存落盘）",
      typed.chips && typed.chips.join(",") === "mock-a,mock-b", JSON.stringify(typed).slice(0, 240));
    const authHit = mock.hits.filter((h) => h.url === "/v1/models").pop();
    ok("拉取时带上的是表单里刚粘的密钥", authHit && authHit.auth === "Bearer sk-typed-1234", JSON.stringify(authHit));
    ok("密钥没有出现在被请求的 URL 里", authHit && !/sk-typed/.test(authHit.url), authHit && authHit.url);

    /* 拉不到时的文案必须点名"请求了哪个地址"，而不是笼统一句失败 */
    const bad = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const body = document.getElementById("wbBody");
      const target = [...body.querySelectorAll("input")].find((i) => /^http:\/\/127\.0\.0\.1:/.test(i.value));
      if (!target) return { err: "找不到地址输入框" };
      target.value = "http://127.0.0.1:1/v1";
      const pull = [...body.querySelectorAll("button")].find((b) => /拉取模型/.test(b.textContent));
      pull.click();
      await wait(3000);
      const b2 = document.getElementById("wbBody");
      return {
        none: [...b2.querySelectorAll(".wb-model-none")].map((x) => (x.textContent || "").trim()),
        chips: b2.querySelectorAll(".wb-model-chip").length,
        txt: (b2.innerText || "").replace(/\s+/g, " "),
      };
    });
    ok("拉不到时点名请求过的地址", /127\.0\.0\.1:1\/v1\/models/.test((bad.none || []).join(" ")), JSON.stringify(bad).slice(0, 260));
    ok("失败后不再谎报模型数量", bad.chips === 0, JSON.stringify(bad).slice(0, 200));
    ok("整屏文案仍然没有「网关」", /网关/.test(bad.txt || "") === false, String(bad.txt || "").slice(0, 200));
    await mock.close();
    await page.screenshot({ path: path.join(OUT, "layout_model_module.png") }).catch(() => {});

    /* ---------- 后端缺接口（404）时的提示 ---------- */
    section("后端 404 的提示文案");
    await page.route("**/api/rules*", (route) => route.fulfill({
      status: 404, contentType: "text/html", body: "<html><head><title>Cannot GET /api/rules</title></head><body>Cannot GET /api/rules</body></html>",
    }));
    const notFound = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.openWorkbench("rules");
      await wait(1500);
      const body = document.getElementById("wbBody");
      const t = (body.innerText || "").replace(/\s+/g, " ");
      return { t: t.slice(0, 260), saysMissing: /后端没有这个接口/.test(t), saysRestart: /重启/.test(t), blamesLogin: /重新登录/.test(t) };
    });
    ok("404 说清是「后端没有这个接口」", notFound.saysMissing === true, notFound.t);
    ok("404 给出可执行动作（重启服务）", notFound.saysRestart === true, notFound.t);
    ok("404 不再误导用户去重新登录", notFound.blamesLogin === false, notFound.t);
    await page.unroute("**/api/rules*");
    await page.close();

    section("脚本错误");
    ok("全程无 JS 报错", jsErrors.filter((e) => !/401|Failed to load resource/.test(e)).length === 0,
      jsErrors.filter((e) => !/401|Failed to load resource/.test(e)).slice(0, 4).join(" | "));
    ok("全程没有 401（登录态从加载到操作一路有效）", H401.length === 0,
      H401.length + " 次：" + [...new Set(H401)].slice(0, 6).join(" | "));
  } finally {
    await browser.close();
    child.kill();
    await wait(200);
    fs.rmSync(SB, { recursive: true, force: true });
  }

  console.log("");
  if (fail) { console.log("\x1b[31mFAIL " + fail + "/" + (pass + fail) + " 项\x1b[0m"); fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
  console.log("\x1b[32mPASS 界面体检 " + pass + "/" + (pass + fail) + " 项\x1b[0m");
  process.exit(0);
}
main().catch((e) => { console.error("体检异常：" + (e && e.stack || e)); process.exit(1); });
