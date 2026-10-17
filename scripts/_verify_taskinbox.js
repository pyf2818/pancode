/* ============================================================
   任务收件箱（Agents 左栏「任务」页）验收探针
   ------------------------------------------------------------
   三条口径（都是前几轮踩出来的）：
     ① 每张截图、每条"看到了"之前，先断言目标真的显形（有尺寸、没被 hidden 藏起来）。
     ② 状态驱动的界面要主动把状态切出来：waiting / failed / interrupted 这些行
        在演示引擎下不会自然发生，所以除了真跑一轮（证明数据真能到），
        还要喂一份假 rows 把四种分组都摆出来量颜色与文案。
     ③ 每条否定断言配阳性对照：说"切去 CODE 就不打网络"之前，先证明在 Agents 时确实在打。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({
  tag: "taskinbox",
  wsFiles: { "src/app.js": "export const a = 1;\n", "README.md": "# demo\n" },
});

const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.TI_PORT || 8851);
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
/* 截图写不出去要吭声：以前挂过 .catch(()=>{})，屏幕上看到的其实是上一轮的旧图 */
async function shot(page, file) {
  try { await page.screenshot({ path: path.join(OUT, file) }); }
  catch (e) { ok("截图写出 " + file, false, String((e && e.message) || e).slice(0, 160)); }
}
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
  const env = SANDBOX.env({ PORT: String(PORT), HOME, USERPROFILE: HOME });
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

const HELPERS = `
window.__vis = function (sel) {
  const el = typeof sel === "string" ? document.querySelector(sel) : sel;
  if (!el) return { shown: false, why: "no-node" };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const hid = el.classList.contains("hidden") || (el.style && el.style.display === "none") || (el.hasAttribute && el.hasAttribute("hidden"));
  return { shown: r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && !hid,
    w: Math.round(r.width), h: Math.round(r.height), why: hid ? "hidden" : cs.display };
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
  const USER = "_ti_" + Date.now();
  const reg = await req("POST", "/api/auth/register", { username: USER, password: "test1234" });
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
    localStorage.setItem("cw-user-name", cfg.user);
    localStorage.setItem("cw-lang", "zh");
    localStorage.setItem("cw-theme", "dark");
    localStorage.setItem("cw-onboarded", "1");
    localStorage.removeItem("cw-ag-pane");
  }, { token, user: USER });
  await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
  await wait(2400);
  await page.evaluate(HELPERS);
  await page.evaluate(() => window.switchMode("agents"));
  await wait(500);
  const vis = (sel) => page.evaluate((s) => window.__vis(s), sel);

  try {
    section("① 分段控件就位：默认落在任务，会话没被删只是换了页");
    ok("进 Agents 页没抛页面错误", realErrors().length === 0, realErrors().slice(0, 2).join(" | ").slice(0, 200));
    const seg = await page.evaluate(() => ({
      tasksTab: !!document.getElementById("segTasks"), sessionsTab: !!document.getElementById("segSessions"),
      tasksActive: (document.getElementById("segTasks") || {}).classList ? document.getElementById("segTasks").classList.contains("active") : false,
      ariaSel: (document.getElementById("segTasks") || {}).getAttribute ? document.getElementById("segTasks").getAttribute("aria-selected") : "",
      label: ((document.getElementById("segTasks") || {}).textContent || "").trim(),
      inbox: window.__vis("#agPaneTasks"), sessPane: window.__vis("#agPaneSessions"),
      newConv: window.__vis("#btnNewConv"),
      listStillThere: !!document.getElementById("agSessionList"),
      orchStillThere: !!document.getElementById("agOrchHistory"),
    }));
    ok("左栏顶上有「任务 / 会话」两段，默认选中任务", seg.tasksActive === true && seg.ariaSel === "true" && seg.label === "任务", J(seg));
    ok("任务页显形、会话页收起", seg.inbox.shown === true && seg.sessPane.shown === false, J({ inbox: seg.inbox, sess: seg.sessPane }));
    ok("任务页不收「新建会话」的 + （不在任务页发会话的指令）", seg.newConv.shown === false, J(seg.newConv));
    ok("会话列表与编排历史都还在（只是换了页，不是删了）", seg.listStillThere && seg.orchStillThere, J(seg));
    await shot(page, "taskinbox_zh_tasks.png");

    await page.click("#segSessions");
    await wait(300);
    const back = await page.evaluate(() => ({
      inbox: window.__vis("#agPaneTasks").shown, sess: window.__vis("#agPaneSessions").shown,
      newConv: window.__vis("#btnNewConv").shown, aria: document.getElementById("segSessions").getAttribute("aria-selected"),
      rows: document.querySelectorAll("#agSessionList .ag-sess-item, #agSessionList .ag-sess-name").length,
    }));
    ok("切到会话页：会话列表显形、+ 回来", back.sess === true && back.inbox === false && back.newConv === true && back.aria === "true", J(back));
    ok("阳性对照：会话页真的列出了会话（不是空容器）", back.rows >= 1, "行数=" + back.rows);
    await page.click("#segTasks");
    await wait(250);

    section("② 空态");
    const empty = await page.evaluate(() => ({
      txt: ((document.querySelector("#agPaneTasks .ti-empty") || {}).textContent || "").replace(/\s+/g, " ").trim(),
      shown: window.__vis("#agPaneTasks .ti-empty").shown,
    }));
    ok("没有任务时给出话说得清的空态（不是一条白缝）", empty.shown === true && /还没有派出去的活/.test(empty.txt), J(empty));

    section("③ 真跑一轮：任务表 → 收件箱（端到端，不打桩）");
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); setTimeout(() => rej(new Error("ws 超时")), 8000); });
    const seen = [];
    ws.on("message", (raw) => { try { seen.push(JSON.parse(raw.toString()).type); } catch (e) {} });
    let conv = await page.evaluate(() => convId);
    if (!conv) { await page.evaluate(() => startNewConv(false)); conv = await page.evaluate(() => convId); }
    ok("当前会话有 id（收件箱的 current 标记要靠它对上服务端行）", !!conv, "convId=" + conv);
    await page.evaluate(() => { window.__apiTasks = 0; const real = window.fetch; window.fetch = function (u) { if (String(u).indexOf("/api/tasks") >= 0) window.__apiTasks++; return real.apply(this, arguments); }; });
    ws.send(JSON.stringify({ type: "chat", text: "列出 workspace 的文件并说明各自作用", convId: conv }));
    let apiRows = null;
    for (let i = 0; i < 40; i++) {
      const r = await req("GET", "/api/tasks", null, token);
      apiRows = (r.json && r.json.tasks) || [];
      if (apiRows.length) break;
      await wait(500);
    }
    ok("服务端任务表真的记下了这一轮（标题=用户那句话）", !!apiRows && apiRows.length >= 1 && /列出 workspace/.test(apiRows[0].title || ""), J(apiRows && apiRows[0]));
    ok("快照带上了「为什么不动」的两个字段", !!apiRows && "waitingFor" in apiRows[0] && "error" in apiRows[0], J(Object.keys(apiRows[0] || {})));
    const hit = await page.evaluate(async () => {
      await tiFetch();
      const cards = [...document.querySelectorAll("#agPaneTasks .ti-card")];
      return {
        n: cards.length,
        shown: cards.length ? window.__vis(cards[0]).shown : false,
        title: cards.length ? ((cards[0].querySelector(".ti-title") || {}).textContent || "").trim() : "",
        meta: cards.length ? ((cards[0].querySelector(".ti-meta") || {}).textContent || "").trim() : "",
        dotBg: cards.length ? getComputedStyle(cards[0].querySelector(".ti-dot")).backgroundColor : "",
        current: cards.length ? cards[0].classList.contains("current") : false,
        heads: [...document.querySelectorAll("#agPaneTasks .ti-head-t")].map((h) => h.textContent.trim()),
        polled: window.__apiTasks,
      };
    });
    ok("收件箱里真的出现了这张卡（有尺寸、标题对得上）", hit.shown === true && /列出 workspace/.test(hit.title), J(hit));
    ok("当前会话那条标成 current（一眼知道在看哪条）", hit.current === true, "current=" + hit.current);
    ok("分组标题按状态出现（在跑 / 最近收口 之一）", hit.heads.length >= 1, "分组：" + hit.heads.join("、"));
    ok("阳性对照：在 Agents 任务页时确实打了 /api/tasks", hit.polled >= 1, "计数=" + hit.polled);
    ws.close();

    section("④ 状态驱动的四种分组：喂假 rows 把 waiting / failed / interrupted 摆出来");
    // 6 秒兜底轮询会把假 rows 换回服务端真数据（这是产品该有的行为），所以每次量之前重新摆一遍
    await page.evaluate(() => {
      window.__stage = function () {
        TI.rows = [
          { convId: "c-run", title: "重构预览面板", status: "running", origin: "chat", startedAt: Date.now() - 134000, turns: 3, tools: 7, queueLen: 0, waitingFor: "", error: "" },
          { convId: "c-wait", title: "删除 build 目录", status: "waiting", origin: "chat", startedAt: Date.now() - 9000, turns: 1, tools: 0, waitingFor: "rm -rf build", error: "" },
          { convId: "c-auto", title: "每日回归", status: "queued", origin: "automation", startedAt: Date.now() - 2000, turns: 0, tools: 0, queueLen: 2, waitingFor: "", error: "" },
          { convId: "c-int", title: "上次跑到一半退出", status: "interrupted", origin: "chat", startedAt: Date.now() - 88000, turns: 2, tools: 4, waitingFor: "", error: "" },
          { convId: "c-fail", title: "跑测试并修失败", status: "failed", origin: "chat", startedAt: Date.now() - 40000, endedAt: Date.now() - 12000, turns: 4, tools: 9, waitingFor: "", error: "3 个用例仍失败" },
          { convId: "c-done", title: "写 README", status: "done", origin: "chat", startedAt: Date.now() - 60000, endedAt: Date.now() - 30000, turns: 2, tools: 3, waitingFor: "", error: "" },
        ];
        tiRender();
        return TI.rows.length;
      };
    });
    const staged = await page.evaluate(() => {
      window.__stage();
      const cards = [...document.querySelectorAll("#agPaneTasks .ti-card")];
      const pick = (st) => cards.find((c) => c.classList.contains("st-" + st));
      const noteOf = (c) => (c ? ((c.querySelector(".ti-note") || {}).textContent || "").trim() : "");
      const dotOf = (c) => (c ? getComputedStyle(c.querySelector(".ti-dot")).backgroundColor : "");
      // 颜色不许写死 rgb 比对（六套主题各有一套）：把 CSS 变量当场解析成 rgb 再对上
      const rgbOf = (name) => {
        const d = document.createElement("div");
        d.style.color = "var(" + name + ")";
        document.body.appendChild(d);
        const v = getComputedStyle(d).color;
        d.remove();
        return v;
      };
      return {
        heads: [...document.querySelectorAll("#agPaneTasks .ti-head-t")].map((h) => h.textContent.trim()),
        waitNote: noteOf(pick("waiting")), waitDot: dotOf(pick("waiting")),
        failNote: noteOf(pick("failed")), failDot: dotOf(pick("failed")),
        runDot: dotOf(pick("running")), intDot: dotOf(pick("interrupted")),
        intNote: noteOf(pick("interrupted")),
        waitH: Math.round((pick("waiting") || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
        intH: Math.round((pick("interrupted") || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
        warnVar: rgbOf("--warn"), errVar: rgbOf("--err"), accentVar: rgbOf("--accent-hi"),
        autoBadge: ((pick("queued") || { querySelector: () => null }).querySelector(".ti-badge") || {}).textContent || "",
        runDur: ((pick("running") || {}).querySelector(".ti-meta") || {}).textContent || "",
        allShown: cards.length && cards.every((c) => window.__vis(c).shown),
        n: cards.length,
      };
    });
    ok("四种分组都摆出来（在跑 / 等你处理 / 上次没跑完 / 最近收口）",
      ["在跑", "等你处理", "上次没跑完", "最近收口"].every((h) => staged.heads.indexOf(h) >= 0), "分组：" + staged.heads.join("、"));
    ok("waiting 卡直接说清等你批什么", /等你确认：rm -rf build/.test(staged.waitNote), staged.waitNote);
    ok("点色真的跟着状态走（在跑=主色、等批=琥珀、失败=红），且琥珀≠红",
      staged.waitDot === staged.warnVar && staged.failDot === staged.errVar && staged.runDot === staged.accentVar && staged.warnVar !== staged.errVar,
      J({ wait: staged.waitDot, warn: staged.warnVar, fail: staged.failDot, err: staged.errVar, run: staged.runDot, accent: staged.accentVar }));
    ok("failed 卡带失败原因一行", /3 个用例仍失败/.test(staged.failNote), staged.failNote);
    ok("interrupted 不假装还在跑：写明是进程退出没收口，点色也不是在跑的主色",
      /没跑完|退出/.test(staged.intNote) && staged.intDot !== staged.accentVar, "note=" + staged.intNote + " dot=" + staged.intDot + " 主色=" + staged.accentVar);
    // 说明文案写成小作文会把卡片撑成三行（截图目视抓到的），量一下不该比同结构的卡高出一截
    ok("中断说明一句话说完，卡片没被撑高", staged.intH <= staged.waitH + 8, "int=" + staged.intH + "px wait=" + staged.waitH + "px note=" + staged.intNote);
    ok("自动化任务带「自动化」标（工作区级，不是某个人的会话）", staged.autoBadge.trim() === "自动化", "badge=" + staged.autoBadge);
    ok("在跑那条显示耗时（2m14s 这一类，不是空）", /\d+m\d+s|\d+\.\d+s/.test(staged.runDur), "meta=" + staged.runDur.trim());
    ok("六张卡全部真的显形（下面那条 0 中文才是量出来的）", staged.allShown === true && staged.n === 6, J({ n: staged.n, allShown: staged.allShown }));
    await shot(page, "taskinbox_states.png");

    section("⑤ 英文界面零中文");
    await page.evaluate(() => window.setLang("en"));
    await wait(200);
    const en = await page.evaluate(() => {
      window.__stage();
      return {
        heads: [...document.querySelectorAll("#agPaneTasks .ti-head-t")].map((h) => h.textContent.trim()),
        cjk: window.__cjk("#agSessions"),
        tab: (document.getElementById("segTasks") || {}).textContent.trim(),
        note: ((document.querySelector("#agPaneTasks .st-waiting .ti-note") || {}).textContent || "").trim(),
        intNote: ((document.querySelector("#agPaneTasks .st-interrupted .ti-note") || {}).textContent || "").trim(),
        emptyOrNot: document.querySelectorAll("#agPaneTasks .ti-card").length,
      };
    });
    ok("英文态分组标题翻过去了", en.emptyOrNot === 6 && en.heads.indexOf("Running") >= 0 && en.heads.indexOf("Needs you") >= 0, "heads=" + en.heads.join("、") + " 卡数=" + en.emptyOrNot);
    ok("英文态页签与等批文案跟着翻", en.tab === "Tasks" && /^Waiting on you:/.test(en.note), "tab=" + en.tab + " note=" + en.note);
    ok("英文态中断文案翻过去了", /^Interrupted/.test(en.intNote), en.intNote);
    ok("英文态整扇左栏零可见中文（含卡片与 tooltip）", en.cjk.length === 0, en.cjk.join(" / "));
    await page.evaluate(() => window.__stage());
    await shot(page, "taskinbox_en.png");
    const zh = await page.evaluate(() => {
      // 摆完立刻量：中间只要让出一个 tick，事件驱动的刷新就把假 rows 换回服务端真数据了（④ 同一条口径）
      window.setLang("zh");
      window.__stage();
      return {
        n: window.__cjk("#agSessions").length,
        heads: [...document.querySelectorAll("#agPaneTasks .ti-head-t")].map((h) => h.textContent.trim()),
        note: ((document.querySelector("#agPaneTasks .st-waiting .ti-note") || {}).textContent || "").trim(),
      };
    });
    ok("中文态同一把尺子量到成量中文（说明上面那个 0 不是尺子坏了）", zh.n >= 4, "中文条数=" + zh.n);
    ok("切回中文后标题与文案也翻回来了", zh.heads.indexOf("在跑") >= 0 && /等你确认：rm -rf build/.test(zh.note), J(zh));
    await shot(page, "taskinbox_zh_states.png");

    section("⑥ 不打无用的网络：切去 CODE 模式后不再轮询");
    const idle = await page.evaluate(async () => {
      window.__apiTasks = 0;
      window.switchMode("editor");
      await new Promise((r) => setTimeout(r, 7000));
      return { polled: window.__apiTasks };
    });
    ok("切到 CODE 模式这 7 秒一次都没轮询（6 秒的轮询在空转前该被问一句要不要打）", idle.polled === 0, "计数=" + idle.polled);
    await page.evaluate(() => window.switchMode("agents"));
    await wait(7000);
    const active = await page.evaluate(() => window.__apiTasks);
    ok("阳性对照：切回 Agents 任务页后轮询又跑起来了", active >= 1, "计数=" + active);

    section("⑦ 切语言会不会把旁边几块刷成假状态（截图目视抓到的三条，点名量）");
    const chip = await page.evaluate(() => {
      const g = () => ((document.getElementById("tbUserTxt") || {}).textContent || "").trim();
      window.setLang("en"); const en = g();
      window.setLang("zh"); const zh = g();
      return { en, zh };
    });
    ok("已登录时切语言，顶栏不会退回「未登录 / Not logged in」",
      chip.en.indexOf("_ti_") === 0 && chip.zh.indexOf("_ti_") === 0, J(chip));

    const pill = await page.evaluate(() => {
      const g = () => ((document.getElementById("tbAgentState") || {}).textContent || "").trim();
      window.setLang("en");
      paintState(true, "AI 分析任务中"); const runEn = g();
      paintState(false, ""); const idleEn = g();
      window.setLang("zh");
      paintState(true, "AI 分析任务中"); const runZh = g();
      paintState(false, "");
      return { runEn, idleEn, runZh };
    });
    ok("演示引擎那句中文状态不会漏到英文顶栏（查不到键就退回通用文案）",
      !/[\u4e00-\u9fff]/.test(pill.runEn) && !!pill.runEn, J(pill));
    ok("英文态空闲也是英文", !/[\u4e00-\u9fff]/.test(pill.idleEn) && /AI Idle/i.test(pill.idleEn), "idle=" + pill.idleEn);
    ok("中文态仍显示服务端那句具体话，没被通用文案抹平", /AI 分析任务中/.test(pill.runZh), "zh=" + pill.runZh);

    const orch = await page.evaluate(async () => {
      const g = () => (((document.querySelector("#agOrchHistory .ag-orch-empty") || {}).textContent) || "").replace(/\s+/g, " ").trim();
      await renderOrchHistory();                     // 先按当前语言画一次，模拟开机
      window.setLang("en");                          // 只切语言、不手动重画 —— 量的是 onLang 那条钩子有没有接上
      await new Promise((r) => setTimeout(r, 400));
      const en = g();
      window.setLang("zh");
      await new Promise((r) => setTimeout(r, 400));
      return { en, zh: g() };
    });
    ok("编排历史空态在英文界面是英文（这块挂在 data-i18n-skip 容器里，中文扫描量不到，只能点名量）",
      /No orchestration runs yet/.test(orch.en) && !/[\u4e00-\u9fff]/.test(orch.en), J(orch));
    ok("中文态编排历史空态仍是中文", /还没有编排记录/.test(orch.zh), "zh=" + orch.zh);

    ok("全程无 JS 报错", realErrors().length === 0, realErrors().slice(0, 3).join(" | "));
  } catch (e) {
    ok("探针自身跑通（未中途抛错）", false, String((e && e.stack) || e).slice(0, 400));
  } finally {
    await browser.close();
    child.kill();
  }
  console.log("\n[taskinbox] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { console.log("  失败项：\n   - " + fails.join("\n   - ")); process.exit(1); }
  process.exit(0);
})();
