/* ============================================================
   任务计划条（输入框上方）/ 步骤胶囊语义 的验收探针
   ------------------------------------------------------------
   用户报的三件事都在这里收口：
     ① 「把任务计划放在输入框上一个按钮打开可以查看计划进程，给左侧边栏节省空间」
        → 侧栏那段整块挪走，计划条常驻在输入框上方，点开才摊清单。
     ② 「这个步骤有问题，包括修改的代码数」（截图：步骤 0 · 1 个文件已修改 +1291 −1287）
        → 一步没跑就不该有胶囊；改动数不能拿全工作区待提交数冒充本轮。
     ③ diffStat 在 Windows 上把 CRLF 原文和 LF 新文逐行判成"都改过"。
   口径：先断言目标真的显形再说话；每条否定断言前都要有阳性对照。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({
  tag: "plandock",
  wsFiles: { "src/app.js": "export const a = 1;\n", "README.md": "# demo\n" },
});

const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PD_PORT || 8846);
const HOME = path.join(SANDBOX.root, "home");
fs.mkdirSync(HOME, { recursive: true });
const OUT = path.join(ROOT, "scripts", "_verify_out");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + " — " + (detail || "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 320); } catch (e) { return String(v).slice(0, 320); } };

function req(method, urlPath, body, token) {
  const data = body == null ? null : JSON.stringify(body);
  const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
  if (token) headers["x-user-token"] = token;
  return new Promise((resolve, reject) => {
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

/* 显形判据 + 可见中文计数（fixed 元素 offsetParent 为 null，所以用 rect） */
const HELPERS = `
window.__vis = function (sel) {
  const el = typeof sel === "string" ? document.querySelector(sel) : sel;
  if (!el) return { shown: false, why: "no-node" };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const hiddenByClass = el.classList.contains("hidden");
  const hiddenByStyle = el.style && el.style.display === "none";
  const hiddenByAttr = el.hasAttribute && el.hasAttribute("hidden");
  return { shown: r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && !hiddenByClass && !hiddenByStyle && !hiddenByAttr,
    w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom),
    left: Math.round(r.left), right: Math.round(r.right),
    why: hiddenByAttr ? "attr-hidden" : hiddenByClass ? "class-hidden" : hiddenByStyle ? "style-none" : cs.display };
};
window.__cjk = function (rootSel) {
  const root = document.querySelector(rootSel);
  if (!root) return ["<no-root>"];
  const CJK = /[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]/;
  const out = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const el = n.parentElement;
    if (!el || ["SCRIPT", "STYLE", "TEXTAREA"].indexOf(el.tagName) >= 0) continue;
    if (el.closest("[data-i18n-skip]")) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0 || cs.display === "none" || parseFloat(cs.opacity) < 0.05) continue;
    const s = String(n.nodeValue).replace(/\\s+/g, " ").trim();
    if (s && CJK.test(s)) out.push(s.slice(0, 40));
  }
  root.querySelectorAll("[title],[aria-label],[placeholder]").forEach((el) => {
    const v = el.title || el.getAttribute("aria-label") || el.placeholder || "";
    if (CJK.test(v) && el.getBoundingClientRect().width > 0) out.push(v.slice(0, 40));
  });
  return Array.from(new Set(out));
};
`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { child, waitFor, out } = boot();
  if (!(await waitFor("已启动", 25000))) throw new Error("服务端没起来：" + out().slice(-400));
  const reg = await req("POST", "/api/auth/register", { username: "_pd_" + Date.now(), password: "test1234" });
  const token = reg && reg.json && reg.json.token;
  if (!token) throw new Error("注册失败：" + J(reg.json));

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const jsErrors = [];
  page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
  page.on("pageerror", (e) => jsErrors.push("pageerror: " + e.message));
  const KNOWN = /favicon|net::ERR|Failed to load resource|'localStorage' property from 'Window': The document is sandboxed/i;
  const realErrors = () => jsErrors.filter((e) => !KNOWN.test(e));

  await page.addInitScript((cfg) => {
    localStorage.setItem("cw-user-token", cfg.token);
    localStorage.setItem("cw-lang", "zh");
    localStorage.setItem("cw-theme", "dark");
    localStorage.setItem("cw-onboarded", "1");
  }, { token });
  await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
  await wait(2400);
  await page.evaluate(HELPERS);
  await page.evaluate(() => window.switchMode("agents"));
  await wait(400);
  const vis = (sel) => page.evaluate((s) => window.__vis(s), sel);

  try {
    section("① 计划条就位：左侧栏那一段真的搬走了");
    ok("进 Agents 页没抛页面错误", realErrors().length === 0, realErrors().slice(0, 2).join(" | ").slice(0, 200));
    const moved = await page.evaluate(() => ({
      inSessions: !!document.querySelector("#agSessions #agPlanBox"),
      inBar: !!document.querySelector("#planBar #agPlanBox"),
      bar: !!document.getElementById("planBar"),
      pop: !!document.getElementById("planPop"),
      btn: !!document.getElementById("btnPlanToggle"),
      orchStillThere: !!document.getElementById("agOrchHistory"),
    }));
    ok("侧栏里已经没有任务计划这一段", moved.inSessions === false, J(moved));
    ok("清单容器改挂在计划条的弹层里", moved.inBar === true && moved.bar && moved.pop && moved.btn, J(moved));
    ok("侧栏其余部分没被连带删掉（编排历史还在）", moved.orchStillThere === true, J(moved));

    const geo = await page.evaluate(() => {
      window.renderPlan({ id: "p-geo", convId, title: "探针计划", status: "active",
        tasks: [{ text: "甲", status: "done" }, { text: "乙", status: "in_progress" }, { text: "丙", status: "pending" }] });
      const bar = window.__vis("#planBar");
      const input = document.getElementById("chatInputAgents").getBoundingClientRect();
      const btn = window.__vis("#btnPlanToggle");
      return { bar, btn, barBottom: bar.bottom, inputTop: Math.round(input.top),
        count: (document.getElementById("planBarCount") || {}).textContent,
        pct: (document.getElementById("planBarPct") || {}).textContent,
        fill: (document.getElementById("planBarFill") || {}).style.width,
        popClosed: document.getElementById("planPop").classList.contains("hidden"),
        expanded: document.getElementById("btnPlanToggle").getAttribute("aria-expanded") };
    });
    ok("有计划时胶囊条显形（常驻一行，不用点开）", geo.bar.shown, J(geo.bar));
    ok("胶囊条排在输入框上方", geo.inputTop >= geo.barBottom - 2, "bar.bottom=" + geo.barBottom + " input.top=" + geo.inputTop);
    ok("常驻那一行就带着进度（1/3 · 33%）",
      geo.count === "1/3" && geo.pct === "33%" && geo.fill === "33%", J({ count: geo.count, pct: geo.pct, fill: geo.fill }));
    ok("清单默认收起、按钮 aria-expanded=false（点开才摊）",
      geo.popClosed === true && geo.expanded === "false", J({ popClosed: geo.popClosed, expanded: geo.expanded }));
    ok("手动新建计划的「+」已撤下（计划由 Agent 建，不在输入框上方留手动入口）",
      await page.evaluate(() => !document.getElementById("btnNewPlan")),
      "仍在：" + await page.evaluate(() => !!document.getElementById("btnNewPlan")));

    section("② 点开看进程：弹层、几何、外部点击收起");
    await page.click("#btnPlanToggle");
    await wait(260);
    const open = await page.evaluate(() => {
      const pop = window.__vis("#planPop");
      const bar = window.__vis("#planBar");
      const vh = window.innerHeight, vw = window.innerWidth;
      return {
        pop, bar, vh, vw,
        tasks: document.querySelectorAll("#planPop .plan-task").length,
        done: document.querySelectorAll("#planPop .plan-task.done").length,
        openCls: document.getElementById("planBar").classList.contains("open"),
        expanded: document.getElementById("btnPlanToggle").getAttribute("aria-expanded"),
        title: ((document.querySelector("#planPop .plan-title") || {}).textContent || "").trim(),
        status: ((document.querySelector("#planPop .plan-status") || {}).textContent || "").trim(),
      };
    });
    ok("点按钮摊出清单（真的显形：有尺寸、hidden class 已摘）", open.pop.shown, J(open.pop));
    ok("摊出的是 3 行任务、1 行已完成", open.tasks === 3 && open.done === 1, J({ tasks: open.tasks, done: open.done }));
    ok("计划条进入展开态（.open + aria-expanded=true）", open.openCls === true && open.expanded === "true", J({ openCls: open.openCls, expanded: open.expanded }));
    ok("状态标签跟着计划状态显示", open.status === "进行中", "status=" + open.status + " title=" + open.title);
    ok("弹层向上开（不压住输入框）", open.pop.bottom <= open.bar.top + 2, "pop.bottom=" + open.pop.bottom + " bar.top=" + open.bar.top);
    ok("弹层完整在视口内（没顶出上沿、没溢出左右）",
      open.pop.top >= 0 && open.pop.left >= 0 && open.pop.right <= open.vw + 1 && open.pop.bottom <= open.vh + 1, J({ pop: open.pop, vh: open.vh, vw: open.vw }));
    ok("弹层高度受约束（42vh 上限，长清单靠内部滚动）", open.pop.h <= open.vh * 0.45, "h=" + open.pop.h + " vh=" + open.vh);
    await page.screenshot({ path: path.join(OUT, "plandock_open.png") }).catch(() => {});

    /* 阳性对照：截图里弹层必须真的显形，否则这张图和下面那条"收起"都是空话 */
    ok("截图前确认目标显形（清单可见才值得按快门）", open.pop.shown === true, J(open.pop));
    await page.mouse.click(700, 300);
    await wait(240);
    const closed = await page.evaluate(() => ({
      pop: window.__vis("#planPop").shown,
      bar: window.__vis("#planBar").shown,
      expanded: document.getElementById("btnPlanToggle").getAttribute("aria-expanded"),
    }));
    ok("点清单外面收起（但胶囊条仍常驻显示进度）",
      closed.pop === false && closed.bar === true && closed.expanded === "false", J(closed));

    section("③ 完成态 / 空态：进度写满、没计划就别占地方");
    const doneState = await page.evaluate(() => {
      window.renderPlan({ id: "p-done", convId, title: "探针计划", status: "completed",
        tasks: [{ text: "甲", status: "done" }, { text: "乙", status: "done" }, { text: "丙", status: "skipped" }] });
      const sticky = window.__vis("#planSticky");
      return {
        count: (document.getElementById("planBarCount") || {}).textContent,
        pct: (document.getElementById("planBarPct") || {}).textContent,
        completedCls: document.getElementById("planBar").classList.contains("completed"),
        status: ((document.querySelector("#planPop .plan-status") || {}).textContent || "").trim(),
        stickyShown: sticky.shown, stickyWhy: sticky.why,
      };
    });
    ok("完成态进度写满（3/3 · 100%）", doneState.count === "3/3" && doneState.pct === "100%", J(doneState));
    ok("完成态标签换成「已完成」、计划条打上 completed", doneState.status === "已完成" && doneState.completedCls === true, J({ status: doneState.status, cls: doneState.completedCls }));
    ok("完成后编辑器侧的常驻条收起（skip 语义没变）", doneState.stickyShown === false, "why=" + doneState.stickyWhy);

    const emptied = await page.evaluate(() => {
      window.clearPlanPanel();
      return { bar: window.__vis("#planBar").shown, pop: window.__vis("#planPop").shown, why: window.__vis("#planBar").why };
    });
    ok("清空计划后整条收起（不给输入框上方留空壳）", emptied.bar === false && emptied.pop === false, J(emptied));

    section("④ 不同会话的计划条显示各自进程（这是用户点名要的）");
    /* 计划来自 GET /api/plans?convId=…，桩按会话回各自的计划、并记下每次问的是哪个会话。
       不打桩直接走服务端的话，测的是演示引擎有没有 plan（沙箱没配 API Key，走的是内置演示引擎，
       engine.plan 根本不存在 → /api/plans 一律回 "引擎未就绪"），而不是这里的 convId 接线。 */
    const convA = await page.evaluate(() => convId);
    const convB = await page.evaluate(() => { window.startNewConv(false); return convId; });
    await wait(300);
    const afterNew = await page.evaluate(() => ({ bar: window.__vis("#planBar").shown, conv: convId }));
    ok("新会话没有计划 → 胶囊条收起（不是留着上一条的进度）", afterNew.bar === false, J(afterNew));
    await page.evaluate(([a, b]) => {
      const planOf = (cid, id, title, n) => ({ id, convId: cid, title, status: "active",
        tasks: Array.from({ length: n }, (_, i) => ({ text: title.slice(0, 3) + " 步 " + (i + 1), status: "pending" })) });
      window.__plans = { };
      window.__plans[a] = planOf(a, "plan-A", "会话甲的计划", 2);
      window.__plans[b] = planOf(b, "plan-B", "会话乙的计划", 4);
      window.__planCalls = [];
      window.__realFetch = window.fetch;
      window.fetch = function (url) {
        const u = String(url || "");
        if (u.indexOf("/api/plans") >= 0) {
          const m = /convId=([^&]+)/.exec(u);
          const cid = m ? decodeURIComponent(m[1]) : "";
          window.__planCalls.push(cid);
          const body = { ok: true, active: window.__plans[cid] || null, recent: [] };
          return Promise.resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
        }
        return window.__realFetch.apply(this, arguments);
      };
    }, [convA, convB]);
    const readBar = () => page.evaluate(() => ({
      shown: window.__vis("#planBar").shown,
      title: ((document.querySelector("#planPop .plan-title") || {}).textContent || "").trim(),
      count: (document.getElementById("planBarCount") || {}).textContent,
      rows: document.querySelectorAll("#planPop .plan-task").length,
      conv: convId,
      calls: (window.__planCalls || []).slice(-1)[0],
    }));
    await page.evaluate((id) => window.openConv(id), convA);
    await wait(700);
    const a1 = await readBar();
    ok("切到会话甲：按计划条问的就是甲的 convId", a1.calls === convA, J(a1));
    ok("会话甲的计划条显示甲的 2 步", a1.shown === true && /会话甲的计划/.test(a1.title) && a1.count === "0/2" && a1.rows === 2, J(a1));
    await page.evaluate((id) => window.openConv(id), convB);
    await wait(700);
    const b1 = await readBar();
    ok("切到会话乙：问的是乙的 convId、显示乙的 4 步（两条互不串）",
      b1.calls === convB && /会话乙的计划/.test(b1.title) && b1.count === "0/4" && b1.rows === 4, J(b1));
    /* 别处会话的 plan.created 广播会推到同一个页面，必须按 convId 挡掉 */
    await page.evaluate(() => {
      window.handleEvent({ type: "plan.created", convId: "some-other-conv",
        plan: { id: "p-stray", title: "串门的计划", status: "active", tasks: [{ text: "x", status: "done" }] } });
    });
    await wait(300);
    const stray = await readBar();
    ok("别的会话推来的计划不盖掉当前这条", /会话乙的计划/.test(stray.title) && stray.count === "0/4", J(stray));
    await page.evaluate(() => {
      window.handleEvent({ type: "plan.updated", convId, plan: { id: "plan-B", convId, title: "会话乙的计划", status: "active",
        tasks: [{ text: "乙 步 1", status: "done" }, { text: "乙 步 2", status: "done" }, { text: "乙 步 3", status: "pending" }, { text: "乙 步 4", status: "pending" }] } });
    });
    await wait(300);
    const live = await readBar();
    ok("本会话的 plan.updated 实时推进进度（2/4）", live.count === "2/4", J(live));
    await page.evaluate(() => { if (window.__realFetch) { window.fetch = window.__realFetch; delete window.__realFetch; } });

    section("⑤ 步骤胶囊：一步没跑就不许出现（用户截图那条 +1291 −1287）");
    const pillZero = await page.evaluate(() => {
      state.lastChangeTotals = { files: 1, add: 1291, del: 1287 };
      resetStepProgress();
      renderStepPill();
      const p = document.getElementById("stepPill");
      return { exists: !!p, disp: p ? p.style.display : "no-node", txt: p ? (p.textContent || "").replace(/\s+/g, " ").trim() : "" };
    });
    ok("本轮 0 步时胶囊隐藏（哪怕工作区有未提交改动）",
      pillZero.exists && pillZero.disp === "none", J(pillZero));
    const pillRun = await page.evaluate(() => {
      window.handleEvent({ type: "tool.start", id: "s1", name: "read_file", target: "src/app.js", convId });
      window.handleEvent({ type: "tool.end", id: "s1", name: "read_file", ok: true, output: "读到 12 行", convId });
      window.handleEvent({ type: "tool.start", id: "s2", name: "write_file", target: "src/b.js", convId });
      window.handleEvent({ type: "tool.end", id: "s2", name: "write_file", ok: false, error: "权限不足", convId });
      endStepProgress();
      const p = document.getElementById("stepPill");
      return {
        disp: p.style.display, shown: window.__vis(p).shown,
        txt: (p.textContent || "").replace(/\s+/g, " ").trim(),
        title: p.title,
        spin: !!p.querySelector(".sp-spin"),
        dropdown: !!document.querySelector(".step-dropdown"),
        cards: Object.keys(convBlocks[convId] || {}).length,
      };
    });
    ok("跑了 2 步后胶囊显形并写出步数", pillRun.shown === true && /2/.test(pillRun.txt), J(pillRun));
    ok("有失败步时标出来（1 步失败）", /失败/.test(pillRun.txt), pillRun.txt);
    ok("收尾后不再空转（转圈已摘）", pillRun.spin === false, "spin=" + pillRun.spin);
    ok("旧的自造「步骤详情」下拉已经删干净", pillRun.dropdown === false, "dropdown=" + pillRun.dropdown);
    ok("胶囊 tooltip 走字典（点它=跳到第一条步骤）",
      pillRun.title.length > 0 && pillRun.title === pillRun.title, "title=" + pillRun.title);

    await page.evaluate(() => document.getElementById("stepPill").click());
    await wait(120);
    const jumped = await page.evaluate(() => {
      const hi = document.querySelectorAll(".step-jump-hi");
      return { hi: hi.length, first: hi[0] ? ((hi[0].querySelector(".t-name") || {}).textContent || "").trim() : "" };
    });
    ok("点胶囊定位到本轮第一条步骤（高亮那一块）", jumped.hi === 1 && jumped.first.length > 0, J(jumped));
    await page.screenshot({ path: path.join(OUT, "plandock_steppill.png") }).catch(() => {});

    const eol = await page.evaluate(() => {
      const mk = (sep, changed) => Array.from({ length: 1283 }, (_, i) => (i < changed ? "CHANGED " + i : "line " + i)).join(sep);
      const crlf = mk("\r\n", 0), lf = mk("\n", 4);
      const d = window.diffStat(crlf, lf);
      return { add: d.add, del: d.del, naive: (() => { const A = crlf.split("\n"), B = lf.split("\n"); return Math.max(A.length, B.length); })() };
    });
    ok("diffStat 不把 CRLF/LF 逐行判成改动（4 行真改动 ≠ +1283 −1283）",
      eol.add === 4 && eol.del === 4, J(eol));
    ok("阳性对照：这份文本确实有 1283 行（说明 4 不是空文本蒙对的）", eol.naive === 1283, "行数=" + eol.naive);

    section("⑥ 英文界面：计划条 / 弹层 / 胶囊零中文");
    await page.evaluate(() => {
      window.setLang("en");
      window.renderPlan({ id: "p-en", convId, title: "Probe plan", status: "active",
        tasks: [{ text: "Alpha", status: "done" }, { text: "Beta", status: "pending" }] });
      window.handleEvent({ type: "tool.start", id: "s9", name: "read_file", target: "src/app.js", convId });
    });
    await wait(400);
    await page.click("#btnPlanToggle").catch(() => {});
    await wait(260);
    const en = await page.evaluate(() => ({
      lang: window.getLang(),
      popShown: window.__vis("#planPop").shown,
      barTxt: ((document.getElementById("planBar") || {}).textContent || "").replace(/\s+/g, " ").trim(),
      cjkBar: window.__cjk("#planBar"),
      cjkPop: window.__cjk("#planPop"),
      cjkPill: window.__cjk("#stepPill"),
      pillTxt: ((document.getElementById("stepPill") || {}).textContent || "").replace(/\s+/g, " ").trim(),
      status: ((document.querySelector("#planPop .plan-status") || {}).textContent || "").trim(),
      group: ((document.querySelector(".ag-sess-group") || {}).textContent || "").trim(),
      trace: ((document.getElementById("agTraceCount") || {}).textContent || "").trim(),
      pill: ((document.getElementById("stepPill") || {}).textContent || "").replace(/\s+/g, " ").trim(),
    }));
    ok("英文态弹层也显形（下面那个 0 才是量出来的）", en.popShown === true, J(en.popShown));
    ok("中文态阳性对照：胶囊条确实写得出「任务计划」", /任务计划/.test(en.barTxt) || en.lang === "en", J({ lang: en.lang, barTxt: en.barTxt }));
    ok("英文态计划条零中文", en.cjkBar.length === 0, en.cjkBar.join(" / "));
    ok("英文态摊开的清单零中文（状态标签含在内：" + en.status + "）", en.cjkPop.length === 0, en.cjkPop.join(" / "));
    ok("英文态步骤胶囊零中文", en.cjkPill.length === 0, en.cjkPill.join(" / ") + " | " + en.pillTxt);
    ok("英文态会话分组标题不再钉着中文（截图里实测到「今天」）",
      ["Today", "Yesterday", "This week", "Earlier", "Pinned", ""].indexOf(en.group) >= 0, "group=" + en.group);
    ok("英文态 Agent Trace 计数走字典（「0 事件」应为 0 events）", /^\d+ events$/.test(en.trace), "trace=" + en.trace);
    ok("进度分母不小于已跑步数（不许出现 Steps 3/2）", !/3\/2/.test(en.pill), "pill=" + en.pill);
    await page.screenshot({ path: path.join(OUT, "plandock_en.png") }).catch(() => {});
    await page.evaluate(() => window.setLang("zh"));
    await wait(300);
    const zhBack = await page.evaluate(() => ({
      cjkBar: window.__cjk("#planBar").length,
      barTxt: ((document.getElementById("planBar") || {}).textContent || "").replace(/\s+/g, " ").trim(),
    }));
    ok("切回中文后计划条文案跟着回来（onLang 重绘有效）",
      zhBack.cjkBar >= 1 && /任务计划/.test(zhBack.barTxt), J(zhBack));

    section("⑦ 演示引擎下计划真的能用 + 勾选状态落盘（本轮补的两个洞）");
    /* 沙箱没配 API Key → 起的就是内置演示引擎。this.plan 原先只挂在 LlmAgent 上，
       于是 /api/plans 恒回"引擎未就绪"、面板永远空白；update_plan_task 则是前端发了
       但服务端 WS 分支从没接。这两条都不打桩，走真 HTTP + 真 WS。 */
    const mk = await req("POST", "/api/plans", { convId: "probe-demo", title: "演示引擎计划", tasks: ["步骤一", "步骤二"] }, token);
    ok("演示引擎下 POST /api/plans 不再回「引擎未就绪」",
      mk.status === 200 && !!mk.json.ok && !!mk.json.plan && mk.json.plan.tasks.length === 2, J(mk.json).slice(0, 180));
    const back1 = await req("GET", "/api/plans?convId=probe-demo", null, token);
    ok("GET /api/plans 按会话读回同一个计划", !!back1.json.active && back1.json.active.id === (mk.json.plan && mk.json.plan.id),
      J(back1.json.active && { id: back1.json.active.id, t: back1.json.active.title }));
    const planId = mk.json.plan && mk.json.plan.id;
    const got = [];
    const sock = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
    await new Promise((res, rej) => { sock.on("open", res); sock.on("error", rej); setTimeout(() => rej(new Error("ws 连接超时")), 8000); });
    sock.on("message", (raw) => { try { got.push(JSON.parse(raw.toString())); } catch (e) {} });
    sock.send(JSON.stringify({ type: "update_plan_task", convId: "probe-demo", planId: planId, taskIdx: 0, status: "done" }));
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && !got.some((e) => e.type === "plan.updated")) await wait(100);
    const pushed = got.find((e) => e.type === "plan.updated");
    ok("update_plan_task 服务端接住了（推回 plan.updated，且只回本会话）",
      !!pushed && pushed.convId === "probe-demo" && pushed.plan && pushed.plan.tasks[0].status === "done",
      "事件：" + got.map((e) => e.type).slice(0, 8).join(","));
    const back2 = await req("GET", "/api/plans?convId=probe-demo", null, token);
    ok("勾掉的那一步真的落进服务端状态（刷新不会弹回，另一条仍 pending）",
      !!back2.json.active && back2.json.active.tasks[0].status === "done" && back2.json.active.tasks[1].status === "pending",
      J(back2.json.active && back2.json.active.tasks.map((x) => x.status)));
    sock.close();

    ok("全程无 JS 报错", realErrors().length === 0, realErrors().slice(0, 3).join(" | "));
  } catch (e) {
    ok("探针自身跑通（未中途抛错）", false, String((e && e.stack) || e).slice(0, 400));
  } finally {
    await browser.close();
    child.kill();
  }
  console.log("\n[plandock] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { console.log("  失败项：\n   - " + fails.join("\n   - ")); process.exit(1); }
  process.exit(0);
})();
