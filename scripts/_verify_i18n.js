/* ============================================================
   中英文切换覆盖率体检（Playwright + 沙箱服务端）
   ------------------------------------------------------------
   要解决的问题：原先"不够全面"是一句感觉，没有数。这条探针把它变成一个可复跑的数：
   切到 EN 之后，把界面上**真的看得见**的中文文案逐条抓出来，按所在面板归类。

   五条设计取舍：
     ① 只算 chrome，不算数据。聊天正文、文件名、编辑器内容、用户自己写的 Skill/规则
        正文都是数据，翻它们是错的（用户不会希望自己的对话被换成英文）。
        这些区域靠 data-i18n-skip 显式豁免 —— 是"标出来"而不是"藏起来"，
        所以另有一条断言反向数这些标记在不在。
     ② 正向对照先跑 ZH 态：同一把尺子在中文态必须抓到一大堆中文，
        否则 EN 态抓到 0 条只说明尺子坏了。
     ③ 字典 zh/en 键数必须齐，en 侧不允许还留着中文值。
     ④ 每个界面在扫之前先断言"它真的显形了"（有尺寸、没被内联样式或 class 藏起来）。
        扫描器扫的是整个 document，隐藏容器既不报错也不计数 —— 上一版就是靠这条
        才查出"命令面板从来没被真正打开过"，并当场抓出一条真漏翻。
     ⑤ 探针够不着的界面（要有脏文件、要有真引擎才存在的节点）交给静态门读源码，
        不假装运行期测得到：check-keys / scan-shadow / scan-mixed / scan-attr 四条。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({
  tag: "i18n",
  wsFiles: { "src/app.js": "export const a = 1;\n", "README.md": "# demo\n" },
});

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.I18N_PORT || 8832);
const WS_DIR = SANDBOX.wsDir;
const HOME = path.join(SANDBOX.root, "home");
fs.mkdirSync(HOME, { recursive: true });
const OUT = path.join(ROOT, "scripts", "_verify_out");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 300); } catch (e) { return String(v).slice(0, 300); } };

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (token) headers["x-user-token"] = token;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 20000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, json: { raw: buf.slice(0, 200) } }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function boot() {
  const env = SANDBOX.env({ PORT: String(PORT), PANCODE_PROBE: "1", HOME, USERPROFILE: HOME });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], { cwd: ROOT, env, windowsHide: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const waitFor = async (sub, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (out.includes(sub)) return true; await wait(150); }
    return false;
  };
  return { child, out: () => out, waitFor };
}

/* 页内扫描器：抓"看得见的中文"。
   可见性判据用 rect + display/visibility + opacity，不用 offsetParent（fixed 元素 offsetParent 为 null）。
   豁免靠 data-i18n-skip 的整个子树：聊天流、编辑器、文件树里的文件名、任何渲染用户内容的容器。 */
const SCAN_SRC = `
window.__i18nScan = function () {
  /* 只认汉字本身。全角加号、破折号、省略号这类标点不是"没翻译"，
     把它们算进来的话，这个数就永远降不到 0，也就失去了当门的作用。 */
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const hits = [];
  const seen = new Set();
  const rectOf = (el) => el.getBoundingClientRect();
  const vis = (el) => {
    const r = rectOf(el);
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.05) return false;
    return true;
  };
  const pathOf = (el) => {
    const parts = [];
    let n = el;
    for (let i = 0; i < 5 && n && n !== document.body; i++) {
      let s = n.tagName ? n.tagName.toLowerCase() : "";
      if (n.id) s += "#" + n.id;
      else if (n.className && typeof n.className === "string") s += "." + n.className.trim().split(/\s+/).slice(0, 2).join(".");
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(">");
  };
  /* 这段中文属于"数据"还是"界面"？看它有没有落在某个 data-i18n-skip 子树里 */
  const skipped = (el) => !!el.closest("[data-i18n-skip]");
  const push = (txt, el, where) => {
    const s = String(txt).replace(/\s+/g, " ").trim();
    if (!s || !CJK.test(s)) return;
    /* 语言开关本身写的是"切去哪"那种语言的名字（EN 态显示「中」），它不是漏翻。 */
    if (where === "text" && el.closest && el.closest("#btnLangToggle")) return;
    const key = where + "|" + s;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ text: s.slice(0, 60), where, path: pathOf(el) });
  };
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const el = n.parentElement;
    if (!el) continue;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA") continue;
    if (skipped(el)) continue;
    if (!vis(el)) continue;
    push(n.nodeValue, el, "text");
  }
  document.querySelectorAll("[title],[placeholder],[aria-label]").forEach((el) => {
    if (skipped(el) || !vis(el)) return;
    if (el.title) push(el.title, el, "title");
    if (el.placeholder) push(el.placeholder, el, "placeholder");
    if (el.getAttribute("aria-label")) push(el.getAttribute("aria-label"), el, "aria-label");
  });
  return { hits: hits, total: hits.length, skipRegions: document.querySelectorAll("[data-i18n-skip]").length };
};
`;

const SECTIONS = ["appearance", "general", "model", "agent", "perms", "mcp", "data", "about",
  "experts", "soul", "memory", "sediment", "rules", "skills", "evolution", "automations", "audit"];

async function sweep(page, label) {
  return await page.evaluate(async (lb) => {
    const r = window.__i18nScan();
    r.hits.forEach((h) => (h.panel = lb));
    return r;
  }, label);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  /* ⓪ 静态前置：这四条不靠跑，跑不到的界面照样能查出问题。
     特别是"局部变量遮住全局 t()"这一类 —— 分区渲染外层有 try/catch，
     抛错会被吞成一句"这一页加载失败"，下面的"全程无 JS 报错"断言根本看不见。
     i18n-scan-attr 查的是 JS 现造节点上的 title/placeholder/aria-label：
     这类节点要有未保存改动、要有真引擎才存在，运行期扫描够不着，只能读源码。 */
  section("⓪ 静态前置：字典三方对齐 / 无 t() 遮蔽 / 无半英半中 / 无硬编码界面属性");
  const { execFileSync } = require("child_process");
  ["i18n-check-keys.js", "i18n-scan-shadow.js", "i18n-scan-mixed.js", "i18n-scan-attr.js"].forEach((name) => {
    let code = 0, out = "";
    try { out = execFileSync(process.execPath, [path.join(ROOT, "scripts", name)], { cwd: ROOT, encoding: "utf8" }); }
    catch (e) { code = e.status == null ? 1 : e.status; out = String((e.stdout || "") + (e.stderr || "")); }
    ok(name, code === 0, out.trim().split("\n").slice(-2).join(" / ").slice(0, 170));
  });
  const { child, waitFor, out } = boot();
  if (!(await waitFor("已启动", 25000))) throw new Error("服务端没起来：" + out().slice(-400));
  const reg = await req("POST", "/api/auth/register", { username: "_i18n_" + Date.now(), password: "test1234" });
  const token = reg && reg.json && reg.json.token;
  if (!token) throw new Error("注册失败：" + J(reg.json));
  /* 种子数据用拉丁文：市场里的技能名/描述是「内容」不是「界面文案」，
     中文种子会让 EN 态扫描把测试数据误判成残留（真正要测的是技能面板那层外壳）。 */
  await req("POST", "/api/skills", { name: "Canary release", description: "Roll out in batches then roll back", trigger: "canary,release", body: "1. build 2. rollout" }, token);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const jsErrors = [];
  page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
  page.on("pageerror", (e) => jsErrors.push("pageerror: " + e.message));

  const open = async (lang) => {
    await page.addInitScript((cfg) => {
      try {
        localStorage.setItem("cw-user-token", cfg.token);
        localStorage.setItem("cw-lang", cfg.lang);
        localStorage.setItem("cw-theme", "dark");
        localStorage.setItem("cw-palette", "graphite");
        localStorage.setItem("cw-onboarded", "1");
      } catch (e) {}
    }, { token, lang });
    await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
    await wait(1800);
    await page.evaluate(SCAN_SRC);
  };

  /* 逐个面板走一遍，把每个界面都打开后再扫（隐藏容器里的文案不算"看得见"） */
  const MODALS = ["命令面板", "快捷键", "提交弹窗", "技能弹窗", "首次引导", "确认框"];
  const MODAL_IDS = ["cmdk", "shortcutsModal", "commitModal", "skillModal", "onboardModal", "confirmModal"];
  const setModal = async (i) => {
    await page.evaluate((idx) => {
      const hide = (id) => { const el = document.getElementById(id); if (el) el.style.display = "none"; };
      /* #cmdk 的显隐是 class 控制的（styles.css:1469 #cmdk.hidden{display:none}），
         openCmdk() 只摘 class、不清内联 style —— 给它塞过 display:none 之后，
         面板"打开"了却仍是隐藏的，那一条扫描扫的是空气（实测到：截图断言才抓出来）。 */
      const cmdk = document.getElementById("cmdk");
      if (cmdk) { cmdk.style.display = ""; cmdk.classList.add("hidden"); }
      ["shortcutsModal", "commitModal", "skillModal", "onboardModal", "confirmModal"].forEach(hide);
      const show = (id) => { const e2 = document.getElementById(id); if (e2) e2.style.display = "flex"; };
      if (idx === 0) { if (typeof window.openCmdk === "function") window.openCmdk(); }
      else if (idx === 1) show("shortcutsModal");
      else if (idx === 2) show("commitModal");
      else if (idx === 3) show("skillModal");
      else if (idx === 4) { if (typeof window.showOnboarding === "function") window.showOnboarding(); else show("onboardModal"); }
      else if (idx === 5) {
        /* 确认框的标题/正文是 JS 塞的，不给内容就扫不到那句最危险的文案（"此操作不可撤销"）。
           按当前语言喂内容：喂死中文的话，中文态留下的字会让英文态误报成残留。 */
        const en = (typeof window.getLang === "function" && window.getLang() === "en");
        const t = document.getElementById("confirmTitle"), m = document.getElementById("confirmMsg");
        /* 只覆写"我们自己塞的那次"，真动过的内容不动；否则中文态留下的字会让英文态误报 */
        if (t && (!t.textContent || t.dataset.i18nSeed)) { t.textContent = en ? "Restore workspace" : "还原工作区"; t.dataset.i18nSeed = "1"; }
        if (m && (!m.textContent || m.dataset.i18nSeed)) { m.textContent = en ? "All uncommitted changes will be discarded. This cannot be undone." : "会丢弃全部未提交改动，此操作不可撤销。"; m.dataset.i18nSeed = "1"; }
        show("confirmModal");
      }
    }, i);
    await wait(200);
  };
  const sweepAll = async () => {
    const all = [];
    const vacuous = [];
    const add = async (lb) => { const r = await sweep(page, lb); all.push(...r.hits); return r.total; };
    /* 两样东西会跨语言串味，扫之前先擦：
       ① 终端日志 —— 日志按"写下时的语言"留着（与聊天历史同一口径），中文态写下的行
          不该在英文态被数成残留；只删日志行，保留 .term-intro 那句外壳提示。
       ② #toast —— toast 复用同一个节点、1.8s 后只摘 .show，textContent 一直留在那。
       放在"主界面"这一扫之前，而不是模式切换之前：模式切换本身就会写日志与弹 toast。 */
    await page.evaluate(() => {
      document.querySelectorAll("#termLines .tl").forEach((n) => { if (!n.querySelector(".term-intro")) n.remove(); });
      const el = document.getElementById("toast");
      if (el) { el.classList.remove("show"); el.textContent = ""; }
    });
    await add("主界面");
    /* Agents 窗口平时 display:none，扫描器按"有尺寸"判可见 → 不切过去等于整扇窗没测。
       本轮实测就是靠切过去才看见侧栏分组标题钉着「今天」、Trace 计数写着「0 事件」。 */
    const agentsOn = await page.evaluate(() => {
      if (typeof window.switchMode !== "function") return false;
      window.switchMode("agents");
      window.renderPlan({ id: "i18n-probe", convId, title: "Probe plan", status: "active",
        tasks: [{ text: "Alpha", status: "done" }, { text: "Beta", status: "pending" }] });
      if (typeof window.togglePlanPop === "function") window.togglePlanPop();
      const p = document.getElementById("planPop");
      const r = p ? p.getBoundingClientRect() : { width: 0, height: 0 };
      return r.width > 0 && r.height > 0;
    });
    await wait(420);
    if (!agentsOn) vacuous.push("Agents 窗口的任务计划弹层");
    await add("Agents 窗口（含任务计划弹层）");
    await page.evaluate(() => {
      if (window.clearPlanPanel) window.clearPlanPanel();
      if (window.switchMode) window.switchMode("editor");
    });
    await wait(300);
    /* 输入栏那颗「规划中」徽标只有切到 plan/ask 才存在，模式提示 toast 也只闪几秒。
       不主动切一次就永远扫不到 —— 本轮正是靠抽屉的实测才发现它是硬编码中文 + 半英半中拼接。 */
    await page.evaluate(async () => { if (typeof window.setAgentMode === "function") await window.setAgentMode("plan"); });
    await wait(420);
    if (!(await page.evaluate(() => !!document.querySelector(".ci-mode-badge")))) vacuous.push("模式徽标");
    await add("模式徽标与切换提示");
    await page.evaluate(async () => { if (typeof window.setAgentMode === "function") await window.setAgentMode("agent"); });
    await wait(300);
    for (const id of SECTIONS) {
      await page.evaluate((sid) => window.openWorkbench && window.openWorkbench(sid), id);
      await wait(300);
      /* 分区外层是 try/catch：渲染抛错只会留下一句"这一页加载失败"，
         而扫描器扫的是整个 document，照样能数出一堆可见文案 —— 于是"这一页全绿"是假的。
         所以每开一页先量一次"这一页真的显形了"，没显形的记下来。 */
      const shown = await page.evaluate((sid) => {
        const wb = document.getElementById("workbench");
        if (!wb || wb.style.display === "none") return false;
        /* WB 是 workbench.js 顶层 const —— 词法全局，不是 window 属性（探针的老坑），只能直接引用 */
        const cur = (typeof WB !== "undefined" && WB) ? WB.section : null;
        if (cur !== sid) return false;
        const body = document.getElementById("wbBody");
        return !!body && (body.textContent || "").trim().length > 8;
      }, id);
      if (!shown) vacuous.push("分区/" + id);
      await add("设置/" + id);
    }
    await page.evaluate(() => window.closeWorkbench && window.closeWorkbench());
    await wait(300);
    /* 弹窗层单独扫一遍：它们平时 display:none，不打开就等于没测 */
    for (let i = 0; i < MODALS.length; i++) {
      await setModal(i);
      const shown = await page.evaluate((id) => {
        const el = document.getElementById(id);
        return !!el && el.style.display !== "none" && !el.classList.contains("hidden") &&
          el.getBoundingClientRect().height > 0;
      }, MODAL_IDS[i]);
      if (!shown) vacuous.push("弹窗/" + MODALS[i]);
      await add("弹窗/" + MODALS[i]);
    }
    await setModal(-1);
    /* 文件跳转面板（Ctrl+P）是 JS 现造出来挂到 body 上的，index.html 里根本没有这个节点 */
    await page.evaluate(() => { if (typeof window.openFilePalette === "function") window.openFilePalette(); });
    await wait(250);
    const opened = await page.evaluate(() => {
      const el = document.getElementById("filePalette");
      return !!el && el.getBoundingClientRect().height > 0;
    });
    if (!opened) vacuous.push("文件跳转面板");
    await add("文件跳转面板");
    await page.evaluate(() => { const el = document.getElementById("filePalette"); if (el) el.remove(); });
    /* 标签页上那颗"未保存"圆点要有脏文件才存在（renderTabs 里现造）。
       本轮刚把它的 title 键化，不喂一个脏状态就永远只有静态门看着它。 */
    const dirtied = await page.evaluate(() => {
      const st = (typeof state !== "undefined" && state) || window.state;
      if (!st) return false;
      const p = (st.openTabs && st.openTabs[0]) || (st.files && Object.keys(st.files)[0]);
      if (!p) return false;
      if (!st.openTabs || st.openTabs.indexOf(p) < 0) { try { openFile(p); } catch (e) { return false; } }
      st.dirty.add(p);
      renderTabs();
      return !!document.querySelector(".tab-dot");
    });
    if (!dirtied) vacuous.push("脏标签圆点");
    await add("标签页");
    await page.evaluate(() => {
      const st = (typeof state !== "undefined" && state) || window.state;
      if (st && st.dirty) { st.dirty.clear(); renderTabs(); }
    });
    return { hits: all, openedPalette: opened, vacuous };
  };

  try {
    section("① 正向对照：同一把尺子在中文态必须抓到一大堆中文");
    await open("zh");
    const sweepZh = await sweepAll();
    const zh = sweepZh.hits;
    ok("中文态扫得到成量中文（尺子有效）", zh.length > 200, "实测 " + zh.length + " 条");
    ok("文件跳转面板真的被打开过（否则那一条扫描是空的）", sweepZh.openedPalette === true,
      "这个面板是 JS 现造的，没开起来就等于没测");
    ok("每一个界面都真的显形了（扫描不是扫了个隐藏容器）", sweepZh.vacuous.length === 0,
      "没显形：" + sweepZh.vacuous.join(" / "));
    ok("数据区已显式标成豁免（聊天流 / 编辑器 / 文件树文件名）",
      (await page.evaluate(() => document.querySelectorAll("[data-i18n-skip]").length)) >= 3,
      "标记数=" + (await page.evaluate(() => document.querySelectorAll("[data-i18n-skip]").length)));

    section("② EN 态：界面上还剩多少可见中文");
    await page.evaluate(() => window.setLang("en"));
    await wait(600);
    const en = (await sweepAll()).hits;
    const byPanel = {};
    for (const h of en) { byPanel[h.panel] = (byPanel[h.panel] || 0) + 1; }
    console.log("  \x1b[33mEN 态残留中文 " + en.length + " 条（中文态 " + zh.length + " 条）\x1b[0m");
    Object.keys(byPanel).sort((a, b) => byPanel[b] - byPanel[a]).slice(0, 14).forEach((k) => {
      console.log("    " + String(byPanel[k]).padStart(4) + "  " + k);
    });
    if (process.env.I18N_DUMP) {
      fs.writeFileSync(path.join(OUT, "i18n_en_left.json"), JSON.stringify(en, null, 1), "utf8");
      console.log("  明细已写到 scripts/_verify_out/i18n_en_left.json");
    }
    ok("EN 态界面文案零残留中文", en.length === 0,
      "还剩 " + en.length + " 条，例：" + en.slice(0, 6).map((h) => h.text).join(" / "));

    /* 截图留证：扫描器判的是"有没有中文"，判不出"英文串把版面撑破了没有"。
       这三张（主界面 / 最挤的技能分区 / 命令面板）要人眼过一遍。
       每张都先断言"目标真的显形了"再截 —— 上一版这里三条 evaluate 传的是字符串
       （Playwright 把字符串当表达式求值，`() => {...}` 只造出个函数、并不调用它），
       三张图全是主界面；改成函数后又发现命令面板被前一张留下的 Settings 遮着，
       截出来照样和技能页一模一样。截图不校验目标可见，等于给自己发假证据。 */
    const shots = [
      ["i18n_en_main",
        () => { if (window.closeWorkbench) window.closeWorkbench(); },
        () => { const el = document.getElementById("workbench"); return !el || el.style.display === "none"; }],
      ["i18n_en_skills",
        () => { if (window.openWorkbench) window.openWorkbench("skills"); },
        () => { const el = document.getElementById("workbench"); return !!el && el.style.display !== "none"; }],
      ["i18n_en_cmdk",
        () => {
          if (window.closeWorkbench) window.closeWorkbench();
          if (typeof window.openCmdk === "function") window.openCmdk();
        },
        () => { const el = document.getElementById("cmdk"); return !!el && !el.classList.contains("hidden") && el.getBoundingClientRect().width > 0; }],
    ];
    for (const [name, act, shown] of shots) {
      await page.evaluate(act);
      await wait(500);
      ok("截图目标真的显形了：" + name, await page.evaluate(shown), "没显形的那张图等于没测");
      await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: false });
    }
    await page.evaluate(() => { window.closeWorkbench && window.closeWorkbench(); });
    await wait(200);

    section("③ 字典本身");
    const dict = await page.evaluate(() => {
      /* 语言开关本身与语言选择器里的「中文」写的都是各语言自己的名字（按钮写"切去哪"、
         选项写"我是谁"），翻成 Chinese 反而更难认 —— 这两处 en 侧留中文是对的。 */
      const ALLOW = { langToggle: 1, gmLangZh: 1 };
      return {
        zh: Object.keys(window.LANGS.zh || {}).length,
        en: Object.keys(window.LANGS.en || {}).length,
        zhInEn: Object.keys(window.LANGS.en || {}).filter((k) => !ALLOW[k] && /[一-鿿]/.test(String(window.LANGS.en[k]))),
      };
    });
    ok("zh / en 键数一致", dict.zh === dict.en, "zh=" + dict.zh + " en=" + dict.en);
    ok("en 侧没有留着中文值", dict.zhInEn.length === 0, dict.zhInEn.slice(0, 8).join(" "));

    section("④ 切换本身");
    const btn = await page.evaluate(() => {
      const b = document.getElementById("btnLangToggle");
      return { txt: b && b.textContent.trim(), lang: localStorage.getItem("cw-lang"), htmlLang: document.documentElement.lang };
    });
    ok("EN 态下按钮显示「中」（切回去的那个动作）", btn.txt === "中", J(btn));
    await page.evaluate(() => window.setLang("zh"));
    await wait(400);
    const back = await page.evaluate(() => ({ txt: (document.getElementById("btnLangToggle") || {}).textContent, ph: (document.getElementById("chatInput") || {}).placeholder }));
    ok("切回中文后按钮与输入框同步", /[A-Za-z]{2}/.test(String(back.txt)) && /[一-鿿]/.test(String(back.ph)), J(back));

    const real = jsErrors.filter((e) => !/favicon|net::ERR|Failed to load resource/i.test(e));
    ok("全程无 JS 报错", real.length === 0, real.slice(0, 3).join(" | "));
    await page.screenshot({ path: path.join(OUT, "i18n_en.png") });
  } catch (e) {
    ok("探针自身跑通（未中途抛错）", false, String((e && e.stack) || e).slice(0, 400));
  } finally {
    await browser.close();
    child.kill();
    try { SANDBOX.cleanup(); } catch (e) {}
  }
  console.log("\n[i18n] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { console.log(fails.map((f) => "  - " + f).join("\n")); process.exit(1); }
}

main().catch((e) => { console.error("FATAL", e); try { SANDBOX.cleanup(); } catch (x) {} process.exit(1); });
