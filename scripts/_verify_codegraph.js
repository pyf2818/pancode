/* ============================================================
   P3-D2 代码知识图谱 —— 端到端验收（真服务 + 真工作区 + 真浏览器）
   三层各验一件事：
     ① /api/graph 的数对得上工作区里真实写的 import 关系（含根级文件与副作用导入这两个
        以前解析不上的形状）；
     ② code_graph 工具走的是真 ReAct 循环，Agent 能直接问到影响面；
     ③ 底栏「依赖」页签真的画出来、能点、换文件会跟着重画。
   还钉住一条：面板与 Agent 用的是同一份索引——写完新文件后两边的答案必须一起变，
   否则"面板说没牵连、Agent 说有一串"这种两套真相迟早会骗到人。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({
  tag: "codegraph",
  wsFiles: {
    "src/leaf.js": "export function leaf() { return 1; }\n",
    "src/mid.js": 'import { leaf } from "./leaf";\nexport function mid() { return leaf(); }\n',
    "src/top.js": 'import { mid } from "./mid";\nexport function top() { return mid(); }\n',
    "src/cyc-a.js": 'import "./cyc-b.js";\nexport const a = 1;\n',
    "src/cyc-b.js": 'import "./cyc-a.js";\nexport const b = 2;\n',
    "src/solo.js": "export const solo = 1;\n",
    "main.js": 'require("./server.js");\n',
    "server.js": "const x = 1;\nmodule.exports = x;\n",
  },
});

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.GRAPH_PORT || 8828);
const WS_DIR = SANDBOX.wsDir;
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
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 15000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, json: { raw: buf.slice(0, 200) } }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

/* ---------- 假网关：让真 ReAct 循环去调 code_graph / write_file ---------- */
function startGateway() {
  return new Promise((res) => {
    const srv = http.createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c) => (body += c));
      rq.on("end", () => {
        if (!/chat\/completions$/.test(rq.url || "")) { rs.writeHead(404); return rs.end(); }
        let j = {}; try { j = JSON.parse(body || "{}"); } catch (e) {}
        const asText = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""));
        const msgs = j.messages || [];
        const hit = msgs.filter((m) => m.role === "user").map(asText).filter((s) => /【场景[^\]】]*】/.test(s)).pop() || "";
        const scene = (hit.match(/【场景([^\]】]*)】/) || [])[1] || "";
        let lastUserIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { lastUserIdx = i; break; }
        const alreadyRan = lastUserIdx >= 0 && msgs.slice(lastUserIdx + 1).some((m) => m.role === "tool");
        rs.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const send = (o) => rs.write("data: " + JSON.stringify(o) + "\n\n");
        const endText = (t) => {
          send({ choices: [{ index: 0, delta: { content: t } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          rs.write("data: [DONE]\n\n"); rs.end();
        };
        const toolCall = (name, args) => {
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_cg_" + scene, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          rs.write("data: [DONE]\n\n"); rs.end();
        };
        if (alreadyRan) return endText("场景 " + scene + " 跑完");
        if (scene === "影响面") return toolCall("code_graph", { mode: "impact", target: "src/leaf.js", depth: 3 });
        if (scene === "概览") return toolCall("code_graph", { mode: "overview" });
        if (scene === "符号") return toolCall("code_graph", { mode: "symbol", target: "leaf" });
        if (scene === "加依赖") return toolCall("write_file", { path: "src/extra.js", content: 'import { leaf } from "./leaf";\nexport const extra = leaf();\n' });
        return endText("没有匹配的场景：" + scene);
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, base: "http://127.0.0.1:" + srv.address().port + "/v1" }));
  });
}

let currentConv = "";
const events = [];
const waiters = [];

(async () => {
  section("起沙箱服务（8 个文件、一条环、一个孤岛、一个根级入口）");
  const gw = await startGateway();
  fs.writeFileSync(path.join(SANDBOX.dataDir, "pancode.config.json"), JSON.stringify({
    workspace: WS_DIR,
    llm: { baseURL: gw.base, apiKey: "sk-sandbox", model: "mock-cg", contextWindow: 32000 },
    agentMode: "agent",
    permissions: { mode: "auto", allow: [], deny: [] },
  }, null, 2), "utf8");
  let out = "";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT, env: SANDBOX.env({ PORT: String(PORT), NODE_NO_WARNINGS: "1", AGENT_FAST: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => { out = (out + c).slice(-40000); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-40000); });
  let up = false;
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const h = await req("GET", "/api/health"); if (h.json && h.json.ok) { up = true; break; } } catch (e) {}
  }
  if (!up) { child.kill(); gw.srv.close(); throw new Error("服务未就绪\n" + out.slice(-1200)); }
  const reg = await req("POST", "/api/auth/register", { username: "_cg_" + Date.now(), password: "test1234" });
  const token = reg.json && reg.json.token;
  if (!token) { child.kill(); gw.srv.close(); throw new Error("注册失败：" + J(reg.json)); }

  const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
  ws.on("message", (raw) => {
    let ev; try { ev = JSON.parse(raw.toString()); } catch (e) { return; }
    events.push(ev);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].match(ev)) { waiters[i].resolve(ev); waiters.splice(i, 1); }
  });
  const waitFor = (match, ms) => new Promise((resolve, reject) => {
    const hit = events.find(match);
    if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error("等事件超时 " + (ms || 8000) + "ms")), ms || 8000);
    waiters.push({ match, resolve: (ev) => { clearTimeout(t); resolve(ev); } });
  });
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); setTimeout(() => reject(new Error("WS 超时")), 8000); });
  await waitFor((e) => e.type === "hello", 15000);
  const send = (o) => ws.send(JSON.stringify(o));
  async function runScene(scene, ms) {
    const conv = "cg-" + scene + "-" + Date.now();
    const before = events.length;
    currentConv = conv;
    send({ type: "chat", text: "【场景" + scene + "】请按这个场景调用工具", convId: conv });
    let done = null;
    try {
      done = await waitFor((e) => e.type === "agent.done" && e.convId === conv && events.indexOf(e) >= before, ms || 25000);
    } catch (e) { return { done: null, conv, evs: [] }; }
    await wait(200);
    return { done, conv, evs: events.slice(before).filter((e) => e.convId === conv) };
  }
  const toolBody = (evs, re) => {
    const t = evs.find((e) => e.type === "tool.end" && re.test(e.label || "") || (e.type === "tool.body" && re.test(e.text || "")));
    return evs.filter((e) => e.type === "tool.body").map((e) => e.text || "").join("\n") + "\n" + (t ? t.label || "" : "");
  };

  try {
    section("① /api/graph 的数对得上真实文件");
    const g0 = await req("GET", "/api/graph", null, token);
    /* 这个工作区该有的边就 5 条：leaf←mid、mid←top、cyc-a↔cyc-b（2 条）、main→server。
       数对了才是好消息——多一条就是凭空造边，少一条就是"看不出牵连"。 */
    ok("接口返回 ok 且边数正好是 5（不多不少）", g0.json.ok === true && g0.json.edges === 5, J({ edges: g0.json.edges, files: g0.json.files }));
    const hubs = g0.json.hubs || [];
    const hubPaths = hubs.map((h) => h.path);
    ok("leaf 进得了枢纽表（被 mid 依赖）", hubPaths.includes("src/leaf.js"), J(hubPaths));
    ok("枢纽表按被依赖数降序（不是一串并列乱序）",
      hubs.every((h, i) => i === 0 || hubs[i - 1].in >= h.in), J(hubs.map((h) => h.path + ":" + h.in)));
    ok("循环依赖被抓出来：cyc-a ↔ cyc-b",
      (g0.json.cycles || []).some((c) => c.join(",").includes("cyc-a.js") && c.join(",").includes("cyc-b.js")), J(g0.json.cycles));
    ok("孤岛 src/solo.js 被算成孤岛", g0.json.orphanCount === 1 && (g0.json.orphans || []).includes("src/solo.js"), J(g0.json.orphans));
    ok("根级入口 main.js → server.js 这条边在（以前根级相对导入一条都解析不上）",
      (g0.json.hubs || []).some((h) => h.path === "server.js"), J(hubPaths));

    const leaf = await req("GET", "/api/graph?file=src/leaf.js&depth=3", null, token);
    const imp = (leaf.json.node && leaf.json.node.impact) || [];
    ok("leaf 的直接依赖者是 mid", (leaf.json.node.importers || []).join() === "src/mid.js", J(leaf.json.node));
    ok("depth=3 时 top 以 L2 出现在牵连清单里",
      imp.some((r) => r.path === "src/top.js" && r.depth === 2 && r.via === "src/mid.js"), J(imp));
    ok("leaf 自己正向依赖为空（它是叶子）", (leaf.json.node.deps || []).length === 0, J(leaf.json.node.deps));
    const top = await req("GET", "/api/graph?file=src/top.js", null, token);
    ok("top 的牵连为空（没人 import 入口），但它的 deps 有 mid",
      (top.json.node.impact || []).length === 0 && (top.json.node.deps || []).join() === "src/mid.js", J(top.json.node));
    const ghost = await req("GET", "/api/graph?file=" + encodeURIComponent("src/不存在.js"), null, token);
    ok("查不存在的文件：known=false + 空列表，而不是 500",
      ghost.json.ok === true && ghost.json.node.known === false && (ghost.json.node.importers || []).length === 0, J(ghost.json.node));
    const anon = await req("GET", "/api/graph?file=src/leaf.js");
    ok("依赖图接口不是裸奔的（未登录 401）", anon.status === 401, J(anon.json));

    section("② code_graph 工具走真 ReAct 循环");
    const r1 = await runScene("影响面");
    ok("工具真跑到了（正向对照：impact 那张卡出现了）",
      r1.evs.some((e) => e.type === "tool.start" && /影响面/.test(e.name || "")), J(r1.evs.map((e) => e.type + ":" + (e.name || e.label || ""))));
    const body1 = toolBody(r1.evs, /影响/);
    ok("回执里点名了 mid(L1) 与 top(L2)，并说明这是超集",
      /src\/mid\.js/.test(body1) && /src\/top\.js/.test(body1) && /L1/.test(body1) && /经由/.test(body1), body1.slice(0, 240));
    const r2 = await runScene("概览");
    const body2 = toolBody(r2.evs, /概览/);
    ok("overview 给的是形状（枢纽 / 循环 / 孤岛都说到）",
      /枢纽/.test(body2) && /循环依赖/.test(body2) && /孤岛/.test(body2), body2.slice(0, 240));
    const r3 = await runScene("符号");
    const body3 = toolBody(r3.evs, /符号|使用/);
    ok("symbol 模式报出定义位置与引用它的文件",
      /leaf/.test(body3) && /src\/leaf\.js/.test(body3) && /引用/.test(body3), body3.slice(0, 240));

    section("③ 面板与 Agent 同源：写完新文件，两边的答案一起变");
    const before = await req("GET", "/api/graph?file=src/leaf.js", null, token);
    const r4 = await runScene("加依赖");
    ok("write_file 真的落了盘", fs.existsSync(path.join(WS_DIR, "src", "extra.js")), J(r4.evs.map((e) => e.label || e.type)));
    await wait(500);
    const after = await req("GET", "/api/graph?file=src/leaf.js", null, token);
    ok("新文件的 import 进了图（leaf 多了一个直接依赖者 extra.js）",
      !(before.json.node.importers || []).includes("src/extra.js") && (after.json.node.importers || []).includes("src/extra.js"),
      "before:" + J(before.json.node.importers) + " after:" + J(after.json.node.importers));

    section("浏览器：底栏「依赖」页签");
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    await page.addInitScript((t) => {
      try {
        localStorage.setItem("cw-user-token", t);
        localStorage.setItem("cw-theme", "dark");
        localStorage.setItem("cw-palette", "graphite");
        localStorage.setItem("cw-onboarded", "1");
      } catch (e) {}
    }, token);
    await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.DepGraph, null, { timeout: 15000 });
    await wait(1500);
    ok("底栏多出「依赖」页签", (await page.locator("#bpTabDep").count()) === 1 && await page.isVisible("#bpTabDep"));
    /* 启动时编辑器会恢复上次打开的文件（这里是 main.js），所以第一屏就是它的上下游。
       整仓形状那条分支单独用"没有活动文件"这个真实可达状态去验（关掉最后一个标签页就是它）。 */
    await page.click("#bpTabDep");
    await wait(900);
    const firstText = await page.locator("#depBody").innerText();
    ok("点开页签就有内容（不是空白面板），且是当前文件的上下游",
      /谁依赖它/.test(firstText) && /牵连范围/.test(firstText), firstText.replace(/\n/g, " / ").slice(0, 180));
    /* 关掉最后一个标签页是"没有活动文件"的真实用户路径（app.js 会把 activeFile 置 null），
       整仓形状那条分支就这样到达，不去手改前端状态造假象。 */
    await page.click("#tabbar .tab-close");
    await wait(1000);
    ok("关掉最后一个标签页后给整仓形状（枢纽 + 循环），而不是空白",
      (await page.locator(".dg-hub").count()) >= 1 && (await page.locator(".dg-cycle").count()) >= 1,
      (await page.locator("#depBody").innerText()).replace(/\n/g, " / ").slice(0, 160));
    await page.screenshot({ path: path.join(OUT, "graph_overview.png") });

    /* 换文件不点页签——靠编辑器 model 变化自己重画。这条同时验两件事：
       面板不会停在刚才那个文件上，以及 onDidChangeModel 那个订阅真的接上了。 */
    await page.evaluate(() => window.openFile("src/leaf.js", 1));
    await wait(1200);
    const depText = await page.locator("#depBody").innerText();
    ok("打开 leaf 后页签自己换成了它的上下游", /谁依赖它/.test(depText) && /src\/mid\.js/.test(depText), depText.replace(/\n/g, " / ").slice(0, 200));
    ok("牵连清单带层数标记（L1/L2）", /L1/.test(depText) && /L2/.test(depText), "");
    ok("文案不夸大：说的是「可能一起受影响」而不是「这些文件都用到了它」", /口径是文件级|可能一起受影响/.test(depText), depText.slice(-200));
    await page.screenshot({ path: path.join(OUT, "graph_file.png") });

    await page.locator(".dg-depth", { hasText: "1 层" }).click();
    await wait(800);
    const oneLayer = await page.locator("#depBody").innerText();
    ok("切到 1 层只剩直接依赖者（L2 消失）", /L1/.test(oneLayer) && !/L2/.test(oneLayer), oneLayer.replace(/\n/g, " / ").slice(0, 180));
    await page.locator(".dg-depth", { hasText: "3 层" }).click();
    await wait(800);
    ok("切回 3 层又看到传递依赖", /L2/.test(await page.locator("#depBody").innerText()), "");

    await page.locator(".dg-chip", { hasText: "src/mid.js" }).first().click();
    await wait(1100);
    /* app.js 的 state 是顶层 const，不是 window 属性——window.state 取到 undefined，
       拿来断言会永远"不等"（这条以前就是这么假失败的）。 */
    const switched = await page.evaluate(() => (typeof state !== "undefined" && state ? state.activeFile : null));
    ok("点一个依赖 chip 跳到那个文件", switched === "src/mid.js", String(switched));
    await wait(700);
    const midText = await page.locator("#depBody").innerText();
    ok("换文件后面板跟着重画（不是停在 leaf）", /它依赖谁/.test(midText) && /src\/leaf\.js/.test(midText), midText.replace(/\n/g, " / ").slice(0, 180));

    await page.evaluate(() => window.openFile("src/solo.js", 1));
    await wait(1100);
    const soloText = await page.locator("#depBody").innerText();
    ok("孤岛文件说得清：没有依赖者，并解释可能原因", /没有文件依赖它|没有 import/.test(soloText), soloText.replace(/\n/g, " / ").slice(0, 200));

    await page.click("#bpTabProb");
    await wait(500);
    ok("切到「问题」页签时依赖面板收起（三者互斥）",
      !(await page.isVisible("#depBody")) && await page.isVisible("#problemsBody"));
    await page.click("#bpTabDep");
    await wait(600);
    ok("再切回来仍有内容（页签不是只能用一次）", (await page.locator("#depBody .dg-sec").count()) >= 2, "");

    const real = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|is sandboxed|allow-same-origin/i.test(e));
    ok("浏览器侧无 JS 报错", real.length === 0, real.slice(0, 3).join(" | "));
    section("④ 服务端侧的静默失败检查");
    ok("整轮没有出现未捕获异常", !/UNCAUGHT|TypeError: |ReferenceError: /.test(out),
      (out.match(/.{0,160}(TypeError|ReferenceError|UNCAUGHT).{0,160}/) || [""])[0]);
    await browser.close();
  } catch (e) {
    ok("探针自身跑通（未中途抛错）", false, String(e && e.stack || e).slice(0, 400));
  } finally {
    try { ws.close(); } catch (e) {}
    child.kill();
    gw.srv.close();
  }
  console.log("\n[P3-D2] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e && e.stack || e); process.exit(1); });
