/* ============================================================
   托盘「点一条任务 → 跳到那条会话」的渲染端验收（#33）

   主进程那半边由 scripts/_verify_desktop.js 验（菜单装配 + openConversation + 唤回可见），
   但它验不到渲染端：沙箱里那个 Electron 窗口停在登录页，pc-open-conv 发进去也只是
   被 openConv 里的 try/catch 悄悄吃掉。**通道名写错、回调没注册、跳转后 pane 挂错**
   这三类都只有真页面 + 真登录态才测得到，所以这里用 Playwright 起一个假 pancodeWin 桥
   （addInitScript 抢在 app.js 之前，走的就是 preload 那份同名 API 的形状），
   让真实的 app.js 自己去注册回调，再由探针按下"托盘里那一条"。

   沙箱第一行：任何 server 模块 require 之前先 create()，否则数据根落到真实 %AppData%/.pancode。
   ============================================================ */
"use strict";
const sb = require("./_sandbox").create({
  tag: "trayjump",
  config: {
    agentMode: "auto",
    llm: { baseURL: "", apiKey: "", model: "sandbox-model", contextWindow: 128000 },
    permissions: { mode: "auto", allow: [], deny: [] },
  },
});
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const PORT = 8842;
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

const child = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: sb.env({ PORT: String(PORT), AGENT_FAST: "1", CURSORWEB_ENGINE: "demo", NODE_NO_WARNINGS: "1" }),
  stdio: ["ignore", "pipe", "pipe"],
});
let childLog = "";
child.stdout.on("data", (d) => { childLog += d; });
child.stderr.on("data", (d) => { childLog += d; });

async function waitServer(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  if (!await waitServer(25000)) { console.log(childLog.slice(-2000)); throw new Error("服务端没起来（端口 " + PORT + "）"); }

  const base = `http://127.0.0.1:${PORT}`;
  const user = "trayjump_" + Date.now();
  const authOpts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: "test1234" }) };
  await fetch(base + "/api/auth/register", authOpts).catch(() => {});
  const token = await fetch(base + "/api/auth/login", authOpts).then((r) => r.json()).then((j) => j.token || "").catch(() => "");
  if (!token) throw new Error("沙箱注册/登录没拿到 token");

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const warns = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
    if (m.type() === "warning") warns.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  /* 抢在 app.js 之前把桥搭好：形状照 electron/preload.js 那份 contextBridge 抄，
     只多留一个 __trayOpen 把手——app.js 注册的回调从这里被按下去。 */
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("cw-user-token", t);
      localStorage.setItem("cw-onboarded", "1");
    } catch (e) { return; }         // 沙箱 iframe 读 localStorage 会抛 SecurityError，那不是产品报错
    window.__trayOpen = null;
    window.pancodeWin = {
      minimize() {}, toggleMax() {}, close() {},
      isMaximized() { return Promise.resolve(false); },
      onMaxChange() { return () => {}; },
      onOpenConv(fn) { window.__trayBridge = fn; },
    };
    window.pancodeDesktop = { platform: "win32" };
  }, token);

  await page.goto(base + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => !!document.getElementById("chatInputBox"), { timeout: 20000 });
  await page.waitForTimeout(1500);

  section("① 真页面上，app.js 确实把回调注册进了 pc-open-conv 这条通道");
  const wired = await page.evaluate(() => ({
    hasBridge: typeof window.__trayBridge === "function",
  }));
  ok("app.js 在 pancodeWin.onOpenConv 存在时注册了跳转回调", wired.hasBridge === true, JSON.stringify(wired));

  section("② 造两条真会话：A 里跑一段活，B 是新建的空会话");
  const MARK = "托盘跳转验收-" + Date.now();
  const idA = await page.evaluate(async (mark) => {
    document.getElementById("chatInput").value = mark;
    window._doSend();
    await new Promise((r) => setTimeout(r, 1200));
    const list = JSON.parse(localStorage.getItem(window.convListKey()) || "[]");
    return { id: window.convActiveKey ? localStorage.getItem(window.convActiveKey()) : "", n: list.length };
  }, MARK);
  ok("会话 A 有内容了（列表里至少一条）", idA.n >= 1, JSON.stringify(idA));
  await page.evaluate(() => document.getElementById("btnNewConv").click());
  await page.waitForTimeout(800);
  const two = await page.evaluate(() => {
    const list = JSON.parse(localStorage.getItem(window.convListKey()) || "[]");
    return { ids: list.map((x) => x.id), active: localStorage.getItem(window.convActiveKey()), n: list.length };
  });
  ok("新建会话后有两条，且当前停在新的那条", two.n >= 2 && two.active === two.ids[0], JSON.stringify(two));
  const convA = idA.id, convB = two.active;
  ok("A、B 是两个不同的会话", !!convA && !!convB && convA !== convB, JSON.stringify({ convA, convB }));

  section("③ 从编辑器模式按托盘跳转：切回 Agents + 打开 A + 内容真的在屏上");
  await page.evaluate(() => document.getElementById("btnModeEditor").click());
  await page.waitForTimeout(500);
  const inEditor = await page.evaluate(() => ({
    editor: getComputedStyle(document.getElementById("editorWindow")).display,
    agents: getComputedStyle(document.getElementById("agentsWindow")).display,
  }));
  ok("先确认确实离开了 Agents（否则这条跳转断言是空的）",
    inEditor.editor === "flex" && inEditor.agents === "none", JSON.stringify(inEditor));

  const jump = await page.evaluate(async (id) => {
    window.__trayBridge(id);                       // = 托盘里点了这一条
    await new Promise((r) => setTimeout(r, 1500));
    /* 挂载规则：chatStream 下永远只留当前那一条会话的 .conv-pane（其余卸下但留着）。
       所以"pane 在不在 + 里面有没有那句话"就是"真的切到了这条会话"的硬证据。 */
    const pane = document.querySelector("#chatStream .conv-pane");
    return {
      editor: getComputedStyle(document.getElementById("editorWindow")).display,
      agents: getComputedStyle(document.getElementById("agentsWindow")).display,
      agentsActive: document.getElementById("btnModeAgents").classList.contains("active"),
      active: localStorage.getItem(window.convActiveKey()),
      mounted: document.querySelectorAll("#chatStream .conv-pane").length,
      shownText: pane ? pane.innerText.slice(0, 200) : "",
    };
  }, convA);
  ok("跳转后回到 Agents 模式（窗口显形 + 页签高亮）",
    jump.agents === "flex" && jump.editor === "none" && jump.agentsActive === true, JSON.stringify(jump).slice(0, 220));
  ok("跳转后当前会话就是 A", jump.active === convA, JSON.stringify({ want: convA, got: jump.active }));
  ok("A 的那条消息真的渲染出来了（不是只改了个 id）",
    jump.mounted === 1 && jump.shownText.indexOf(MARK) >= 0, JSON.stringify(jump).slice(0, 260));
  await page.screenshot({ path: path.join(OUT, "trayjump-into-A.png") });

  section("④ 边界：跳到自己、跳到一个不存在的会话都不许把应用弄坏");
  /* 下面两条比的是"按下前后自己有没有变"，不是"等于 convA"——
     写成等于 convA 的话它们只是③的复读，跳转整体坏掉时它们跟着红，看着像独立判据其实不是。 */
  const selfJump = await page.evaluate(async (id) => {
    const before = localStorage.getItem(window.convActiveKey());
    window.__trayBridge(id);
    await new Promise((r) => setTimeout(r, 600));
    return { before, after: localStorage.getItem(window.convActiveKey()), agents: getComputedStyle(document.getElementById("agentsWindow")).display };
  }, convA);
  ok("再点一次同一条：停在原处，不重复加载", selfJump.before === selfJump.after && selfJump.before === convA, JSON.stringify(selfJump));

  const emptyJump = await page.evaluate(async () => {
    const before = localStorage.getItem(window.convActiveKey());
    window.__trayBridge("");                        // 主进程那边也可能递空 id（老版本、异常行）
    await new Promise((r) => setTimeout(r, 400));
    return { before, after: localStorage.getItem(window.convActiveKey()) };
  });
  ok("空 id 被挡在门外（不改当前会话）", emptyJump.before === emptyJump.after, JSON.stringify(emptyJump));

  const ghost = await page.evaluate(async (id) => {
    const before = document.querySelectorAll(".conv-pane").length;
    window.__trayBridge(id);
    await new Promise((r) => setTimeout(r, 800));
    return { before, after: document.querySelectorAll(".conv-pane").length, active: localStorage.getItem(window.convActiveKey()), alive: !!document.getElementById("chatInput") };
  }, "c-不存在-" + Date.now());
  ok("跳到不存在的会话不抛错、应用还活着", ghost.alive === true, JSON.stringify(ghost));

  /* 反向对照：这一整轮里如果 openConv 真的抛过，app.js 现在会喊出来。
     没有这一条，前面所有 try/catch 吞掉的失败都会被当成通过。 */
  ok("没有任何「托盘跳会话失败」的告警", !warns.some((w) => /托盘跳会话失败/.test(w)), warns.slice(0, 3).join(" | "));
  ok("整轮下来没有页面报错", errors.length === 0, JSON.stringify(errors.slice(0, 5)));

  await browser.close();
  child.kill();
  console.log("\n" + (fail ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m") + " — 通过 " + pass + " / 失败 " + fail);
  if (fail) for (const f of fails) console.log("  · " + f);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("VERIFY_FAIL", e && e.message ? e.stack : e);
  try { child.kill(); } catch (err) {}
  process.exit(1);
});
