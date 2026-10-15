/* 事件监听器泄漏实测（P0-A2 / S-M1）
   ————————————————————————————————————————————
   守的问题：全仓 addEventListener 一百多处、removeEventListener 只有 3 处。
   不是每一处都是泄漏——绑在"随节点一起消失"的元素上的监听器，节点被换掉就连带回收了；
   真会造成无量级增长的是**绑在 window / document 这种活一整天的对象上、又写在会重复执行的路径里**的那些
   （每次开弹窗加一条 document.click、每次重渲染加一条……）。
   所以这里量的不是"代码里写了几次 add"，而是**跑一轮真实交互之后 window/document 上还活着几条**：
     1) 页面最早期劫持 addEventListener / removeEventListener，只统计 window 与 document，net 计数（加 +1、摘 −1）；
     2) 启动后取基线；
     3) 把会重复的动作各做 N 遍（模型下拉开关、@ 菜单、/ 菜单、命令面板、切视图模式、拖分栏复位）；
     4) 断言净增长为 0 —— 重复动作若每遍都留下一条摘不掉的监听，这里就红。
   全程一次性沙箱数据根，绝不碰开发者的 .pancode。
   用法：node scripts/_verify_listeners.js
*/
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "listeners" });

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.LISTENERS_PORT || 8833);
const ROUNDS = 12;

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
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (x) { resolve({ status: res.statusCode, raw: buf.slice(0, 200) }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("http timeout")));
    if (data) r.write(data);
    r.end();
  });
}

/* 在页面任何脚本之前注入：只统计 window/document 上的净存活监听数。
   net 而不是 gross 是关键——"加了 200 次也摘了 200 次"不是泄漏，
   而按 add 计数的话它会被误报成泄漏，这条门就没法长住。 */
const INSTRUMENT = function () {
  var c = { net: {}, adds: 0 };
  window.__lc = c;
  var proto = EventTarget.prototype;
  var origAdd = proto.addEventListener, origRem = proto.removeEventListener;
  var isGlobal = function (t) { return t === window || t === document; };
  var key = function (t, type) { return (t === window ? "window" : "document") + "·" + type; };
  proto.addEventListener = function (type, fn, opts) {
    if (isGlobal(this)) { var k = key(this, type); c.net[k] = (c.net[k] || 0) + 1; c.adds++; }
    return origAdd.call(this, type, fn, opts);
  };
  proto.removeEventListener = function (type, fn, opts) {
    if (isGlobal(this)) { var k = key(this, type); c.net[k] = (c.net[k] || 0) - 1; }
    return origRem.call(this, type, fn, opts);
  };
};

(async () => {
  section("起沙箱服务 + 注册测试账号");
  const wsDir = SANDBOX.wsDir;
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "a.txt"), "seed\n", "utf8");
  fs.writeFileSync(path.join(SANDBOX.dataDir, "pancode.config.json"), JSON.stringify({
    workspace: wsDir, llm: { baseURL: "http://127.0.0.1:1/v1", apiKey: "sk-sandbox", model: "mock" },
    agentMode: "agent", permissions: { mode: "ask", allow: [], deny: [] },
  }), "utf8");
  let out = "";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    /* CURSORWEB_ENGINE=demo：走内置演示引擎。这里要量的是前端渲染路径会不会堆积监听，
       不需要真模型；接一个假网关反而多一层 SSE 时序，把"渲染"这件事糊掉。 */
    env: SANDBOX.env({ PORT: String(PORT), NODE_NO_WARNINGS: "1", AGENT_FAST: "1", CURSORWEB_ENGINE: "demo" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => { out = (out + c).slice(-40000); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-40000); });
  let up = false;
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const h = await req("GET", "/api/health"); if (h.json && h.json.ok) { up = true; break; } } catch (x) {}
  }
  if (!up) { child.kill(); throw new Error("服务未就绪\n" + out.slice(-1200)); }
  const reg = await req("POST", "/api/auth/register", { username: "_lc_" + Date.now(), password: "test1234" });
  const token = reg.json && reg.json.token;
  if (!token) throw new Error("注册失败：" + JSON.stringify(reg.json));

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  await page.addInitScript(INSTRUMENT);
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("cw-user-token", t);
      /* 新手引导只在首次出现，它那一遍性的监听不是本探针要量的对象；
         留着它反而会吃掉后面所有点击（实测 #onboardModal 会拦截指针事件）。 */
      localStorage.setItem("cw-onboarded", "1");
    } catch (e) {}
  }, token);
  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => {
    const st = (typeof state !== "undefined" && state) || window.state;   // state 是词法全局，window.state 恒为 undefined
    return !!(st && st.monacoReady === true);
  }, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);
  /* 登录弹窗自带 document 级监听，它自己的开合不该算进"重复动作"的账 */
  await page.evaluate(() => {
    const b = document.querySelector("#loginModal button.primary"); if (b) b.click();
    ["onboardModal", "authModal"].forEach((id) => { const m = document.getElementById(id); if (m) m.style.display = "none"; });
  });
  await page.waitForTimeout(600);

  const baseline = await page.evaluate(() => ({ net: Object.assign({}, window.__lc.net), adds: window.__lc.adds }));
  ok("仪表装上了（启动期已统计到 window/document 监听）",
    Object.keys(baseline.net).length > 0, JSON.stringify(baseline.net).slice(0, 200));
  console.log("    基线：" + JSON.stringify(baseline.net));

  section("重复动作 " + ROUNDS + " 轮");
  /* 每个动作都必须在页面上"真的发生了"才算数——否则一条从不执行的交互会让门永远绿。
     所以这里同时数两件事：注册次数的净增长，和动作实际生效的次数。 */
  await page.evaluate(() => { window.__acts = { model: 0, at: 0, slash: 0, cmdk: 0, mode: 0 }; });
  const seen = async (fnBody) => page.evaluate(fnBody);
  await page.evaluate(() => {
    window.__popVisible = () => {
      const p = document.getElementById("ciModelPop");
      const menus = Array.from(document.querySelectorAll(".at-menu")).filter((m) => m.style.display === "block");
      const ck = document.getElementById("cmdk");
      return {
        model: !!(p && getComputedStyle(p).display !== "none"),
        at: menus.length > 0, cmdk: !!(ck && !ck.classList.contains("hidden")),
      };
    };
  });
  for (let i = 0; i < ROUNDS; i++) {
    // 1) 模型下拉：开 → 点空白处关
    await page.evaluate(() => document.getElementById("btnModelChip").click());
    if (await seen(() => window.__popVisible().model)) await page.evaluate(() => window.__acts.model++);
    await page.waitForTimeout(50);
    await page.mouse.click(8, 300);
    await page.waitForTimeout(50);
    // 2) @ 提及菜单：输入触发 → Esc 收
    await page.click("#chatInput");
    await page.type("#chatInput", "@");
    await page.waitForTimeout(90);
    if (await seen(() => window.__popVisible().at)) await page.evaluate(() => window.__acts.at++);
    await page.keyboard.press("Escape");
    await page.evaluate(() => { const t = document.getElementById("chatInput"); if (t) t.value = ""; });
    // 3) / 命令菜单
    await page.type("#chatInput", "/");
    await page.waitForTimeout(90);
    if (await seen(() => window.__popVisible().at)) await page.evaluate(() => window.__acts.slash++);
    await page.keyboard.press("Escape");
    await page.evaluate(() => { const t = document.getElementById("chatInput"); if (t) t.value = ""; });
    // 4) 命令面板开合
    await page.keyboard.press("Control+Shift+p");
    await page.waitForTimeout(90);
    if (await seen(() => window.__popVisible().cmdk)) await page.evaluate(() => window.__acts.cmdk++);
    await page.keyboard.press("Escape");
    // 5) 视图模式来回切
    const switched = await page.evaluate(() => {
      const a = document.getElementById("btnModeAgents"), b = document.getElementById("btnModeEditor");
      if (!a || !b) return false;
      a.click(); b.click(); return true;
    });
    if (switched) await page.evaluate(() => window.__acts.mode++);
    await page.waitForTimeout(50);
  }
  const acts = await page.evaluate(() => window.__acts);
  console.log("    实际生效次数：" + JSON.stringify(acts) + "（每类都应 ≈ " + ROUNDS + "）");
  ok("这些动作真的驱动起来了（动作没跑起来的门等于没有门）",
    acts.model >= ROUNDS * 0.8 && acts.at >= ROUNDS * 0.8 && acts.slash >= ROUNDS * 0.8 &&
    acts.cmdk >= ROUNDS * 0.8 && acts.mode >= ROUNDS * 0.8, JSON.stringify(acts));
  await page.waitForTimeout(400);

  /* 上面那些是"一次性的开合"。真正会长量级的是每次都要重画的路径：
     聊天气泡（一轮回答里 msg.delta / tool 卡 / msg.end 各画一次）、编辑器标签页（开一个 tab 建一个 model）。
     所以再用演示引擎真跑几轮对话（不经网络、走的是同一套渲染代码），并反复开关同一个文件的标签页。 */
  section("再压两类高频重画路径：对话渲染 / 编辑器标签页");
  const domBefore = await page.evaluate(() => ({
    nodes: document.querySelectorAll("#chatSlotEditor *").length,
    models: window.monaco && monaco.editor.getModels ? monaco.editor.getModels().length : -1,
  }));
  const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); setTimeout(() => reject(new Error("WS 连接超时")), 8000); });
  for (let i = 0; i < 6; i++) {
    const conv = "lc-conv-" + i;
    await new Promise((resolve, reject) => {
      const onMsg = (raw) => {
        let ev; try { ev = JSON.parse(raw.toString()); } catch (x) { return; }
        if (ev.type === "agent.done" && ev.convId === conv) { ws.off("message", onMsg); resolve(); }
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({ type: "chat", text: "给 a.txt 做一次自我介绍（探针第 " + i + " 轮）", convId: conv }));
      setTimeout(() => reject(new Error("第 " + i + " 轮对话没在 30s 内收口")), 30000);
    });
  }
  await page.waitForTimeout(500);
  const drewBubbles = await page.evaluate(() => document.querySelectorAll("#chatStream .msg, #chatStream .bubble, #chatSlotEditor .msg").length);
  ok("演示引擎真的把气泡画进聊天区了", drewBubbles > 0, "聊天区消息节点 " + drewBubbles + " 个");
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll(".ft-item, .file-item, [data-path]")).find((x) => /a\.txt/.test(x.dataset.path || x.textContent || ""));
      if (row) row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await page.waitForTimeout(70);
    await page.keyboard.press("Control+w");
    await page.waitForTimeout(70);
  }
  const domAfter = await page.evaluate(() => ({
    nodes: document.querySelectorAll("#chatSlotEditor *").length,
    models: window.monaco && monaco.editor.getModels ? monaco.editor.getModels().length : -1,
  }));
  console.log("    聊天区节点 " + domBefore.nodes + " → " + domAfter.nodes + "；Monaco model " + domBefore.models + " → " + domAfter.models);
  ok("反复开合同一个文件的标签页没有堆积 Monaco model",
    domBefore.models < 0 || domAfter.models <= domBefore.models + 2,
    domBefore.models + " → " + domAfter.models);
  try { ws.close(); } catch (x) {}

  /* 最后一类：整块面板的开/关。工作台、Diff 审阅、预览都是"每次打开都可能重新挂一批监听"的形态，
     也是量级最容易失控的地方（一次开合 = 一批监听，乘上会话寿命就是几千条）。 */
  section("再压面板开合：工作台 / Diff 审阅 / 预览 / 拖动分栏");
  const MOCK_DIFF = {
    convId: "lc-diff", files: [{
      path: "a.txt", lang: "text", add: 1, del: 0,
      original: "seed\n", hunks: [{ index: 0, old_string: "seed\n", new_string: "seed2\n", accepted: true }],
    }],
  };
  const opened = await page.evaluate((m) => {
    const r = { wb: 0, patch: 0 };
    for (let i = 0; i < 8; i++) {
      if (typeof window.openWorkbench === "function" && typeof window.closeWorkbench === "function") {
        window.openWorkbench("model");
        const wb = document.getElementById("workbench");
        if (wb && wb.style.display !== "none") r.wb++;
        window.closeWorkbench();
      }
      if (typeof window.openPatchReview === "function") { window.openPatchReview(m); r.patch++; }
      const pm = document.getElementById("patchModal");
      if (pm) pm.style.display = "none";
    }
    return r;
  }, MOCK_DIFF);
  ok("工作台与 Diff 审阅都真的开合了 8 次", opened.wb >= 8 && opened.patch >= 8, JSON.stringify(opened));
  /* 真的按住分栏条拖 12 次：mousemove/mouseup 是绑在 window 上的，这条路径最容易留下摘不掉的尾巴 */
  for (let i = 0; i < 12; i++) {
    const bar = await page.$("#panelResizer");
    if (!bar) break;
    const box = await bar.boundingBox();
    if (!box) break;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 40, { steps: 4 });
    await page.mouse.up();
  }
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({ net: Object.assign({}, window.__lc.net), adds: window.__lc.adds }));
  const growth = {};
  Object.keys(after.net).forEach((k) => { const d = after.net[k] - (baseline.net[k] || 0); if (d !== 0) growth[k] = d; });
  const grew = Object.keys(growth).filter((k) => growth[k] > 0);
  console.log("    " + ROUNDS + " 轮里 window/document 上新增注册 " + (after.adds - baseline.adds) + " 次");
  console.log("    净增长：" + JSON.stringify(growth));
  ok(ROUNDS + " 轮重复动作后 window/document 上没有残留监听",
    grew.length === 0 && grew.reduce((s, k) => s + growth[k], 0) === 0,
    "净增长 " + JSON.stringify(growth) + "；页面异常 " + JSON.stringify(errors.slice(0, 3)));
  ok("页面自身没有抛错（劫持计数不能把应用点崩）", errors.length === 0, JSON.stringify(errors.slice(0, 4)));

  await browser.close();
  child.kill();
  console.log("\n" + (fail ? "\x1b[31mHAS FAIL\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { for (const f of fails) console.log("  - " + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\x1b[31mFAIL:\x1b[0m " + (e && e.stack || e)); try { child.kill(); } catch (x) {} process.exit(1); });
