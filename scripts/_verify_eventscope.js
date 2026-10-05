/* 事件广播的用户隔离实测（B1，阶段三-1 那条"broadcast 仍发给所有连接"的残留边界）。
   两个真用户 + 两条同用户连接连同一个真服务端，断言：
     · A 的对话流、审批卡、reset 只到 A 自己的连接，B 一条都收不到；
     · 实例级事件（system.perf / 自动化）照旧人人可见——不然桌面端后台任务的进度就从窗口里消失了；
     · B 拿 A 的审批 id 点头，动不了 A 那一张卡（放行仍必须由 A 自己确认）。
   全程一次性沙箱数据根，绝不碰开发者的 .pancode。
   用法：node scripts/_verify_eventscope.js
*/
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "eventscope" });

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.EVENTSCOPE_PORT || 8829);
const CONV = "conv-scope-test";

let pass = 0, fail = 0;
const fails = [];
let log = "";                 // 服务端 stdout/stderr 尾巴（模块级，好让顶层 catch 也能打出来）
const CONNS = [];             // 已建立的连接，失败时用来打印"各自收到了哪些事件类型"
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
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 20000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, raw: buf }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("请求超时")));
    if (data) r.write(data);
    r.end();
  });
}

/* ---------- 假网关：【工】→ 回一个 write_file 工具调用；带 tool 结果的那一轮 → 收尾正文 ---------- */
function startGateway() {
  return new Promise((res) => {
    const srv = http.createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c) => (body += c));
      rq.on("end", () => {
        if (!/chat\/completions$/.test(rq.url || "")) { rs.writeHead(404); return rs.end(); }
        let j = {};
        try { j = JSON.parse(body || "{}"); } catch (e) {}
        const msgs = j.messages || [];
        const asText = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""));
        /* 引擎会在尾部追加一条 user 角色的运行态上下文（_runtimeContext），所以"最后一条 user"
           不是人说的那句话——按【回X】标记取最近一条带标记的，才能把回答归到正确的请求上（与 _verify_tasks 同一坑）。 */
        const tagged = msgs.filter((m) => m.role === "user").map(asText).filter((s) => /【回[^\]】]*】/.test(s)).pop() || "";
        const userText = tagged;
        const alreadyRanTool = msgs.some((m) => m.role === "tool");
        rs.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const send = (obj) => rs.write("data: " + JSON.stringify(obj) + "\n\n");
        const tagM = userText.match(/【回([^\]】]*)】/);
        const tag = tagM ? tagM[1] : "默认";
        if (/【工】/.test(userText) && !alreadyRanTool) {
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_sb_1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "scope/probe.txt", content: "written-by-A\n" }) } }] } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          rs.write("data: [DONE]\n\n"); return rs.end();
        }
        send({ choices: [{ index: 0, delta: { content: "回答·" + tag } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        rs.write("data: [DONE]\n\n");
        rs.end();
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, base: "http://127.0.0.1:" + srv.address().port + "/v1" }));
  });
}

/* ---------- WS 客户端：记录整条事件流，好做"B 一条都没收到"这种否定断言 ---------- */
async function connect(token, label) {
  const ws = new WebSocket("ws://127.0.0.1:" + PORT + "?token=" + encodeURIComponent(token));
  const events = [];
  const waiters = [];
  ws.on("message", (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch (e) { return; }
    ev._label = label;
    events.push(ev);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(ev)) { waiters[i].resolve(ev); waiters.splice(i, 1); }
    }
  });
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); setTimeout(() => reject(new Error("WS 连接超时")), 8000); });
  const conn = {
    label, events, ws,
    send: (o) => ws.send(JSON.stringify(o)),
    has: (fn) => events.some(fn),
    count: (fn) => events.filter(fn).length,
    waitFor: (match, ms) => new Promise((resolve2, reject2) => {
      const hit = events.find(match);
      if (hit) return resolve2(hit);
      const t = setTimeout(() => reject2(new Error((label || "?") + " 等事件超时 " + (ms || 8000) + "ms")), ms || 8000);
      waiters.push({ match, resolve: (ev) => { clearTimeout(t); resolve2(ev); } });
    }),
  };
  CONNS.push(conn);
  return conn;
}

async function register(user) {
  const r = await req("POST", "/api/auth/register", { username: user, password: "test1234" });
  if (!r.json || !r.json.token) throw new Error("注册失败 " + user + ": " + JSON.stringify(r.json || r.raw).slice(0, 200));
  return r.json.token;
}

/* 否定断言之前先打一个"水印"：等对方连接收到一条**必定会发**的实例级事件（system.perf 每秒一条），
   且这条必须是本轮新到的。TCP 单连接内有序，收到更晚的那条就证明之前排队的都已送达——
   否则"B 没收到"会被读成通过，其实只是消息还没到（这条实测踩过：负控制退回无差别广播时探针仍然全绿）。 */
async function watermark(conn, ms) {
  const mark = conn.events.length;
  try {
    await conn.waitFor((e) => conn.events.indexOf(e) >= mark && e.type === "system.perf", ms || 6000);
    return true;
  } catch (e) { return false; }
}

(async () => {
  const gw = await startGateway();
  /* _sandbox 先写了一份"全关"的配置；这里要真 LLM 引擎指向假网关，所以覆盖一次。
     注意两件事（都是实测踩出来的）：
       · 不能设 CURSORWEB_ENGINE=demo——那会把引擎强制成演示引擎，工具调用轮就跑不出来；
       · agentMode 必须是 "agent"：agentMode:"ask" 是"只问不干活"的档位，工具直接被拦成
         「Ask 模式禁止工具调用」，压根走不到审批；要逐次确认靠的是 permissions.mode="ask"。 */
  fs.writeFileSync(path.join(SANDBOX.dataDir, "pancode.config.json"), JSON.stringify({
    workspace: SANDBOX.wsDir,
    llm: { baseURL: gw.base, apiKey: "sk-sandbox", model: "mock-scope", contextWindow: 32000 },
    agentMode: "agent",
    permissions: { mode: "ask", allow: [], deny: [] },
    timeouts: { approvalSec: 120 },
  }), "utf8");

  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: SANDBOX.env({ PORT: String(PORT), AGENT_FAST: "1", NODE_NO_WARNINGS: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (c) => { log = (log + c).slice(-20000); });
  server.stderr.on("data", (c) => { log = (log + c).slice(-20000); });

  let up = false;
  for (let i = 0; i < 100 && !up; i++) { await wait(200); try { const h = await req("GET", "/api/health"); up = !!(h.json && h.json.ok); } catch (e) {} }
  if (!up) { console.error("[eventscope] 服务端没起来：\n" + log.slice(-2500)); process.exit(1); }
  console.log("[eventscope] 服务端已起（引擎=" + ((await req("GET", "/api/health")).json.engine || {}).mode + "，数据根=" + SANDBOX.dataDir + "）");

  const stamp = Date.now();
  const tokA = await register("_scope_a_" + stamp);
  const tokB = await register("_scope_b_" + stamp);
  const a1 = await connect(tokA, "A1");
  const a2 = await connect(tokA, "A2");   // 同一个人的第二个窗口（同 token）
  const b = await connect(tokB, "B");
  await Promise.all([a1.waitFor((e) => e.type === "hello"), a2.waitFor((e) => e.type === "hello"), b.waitFor((e) => e.type === "hello")]);

  section("① A 的对话流不该出现在 B 的窗口");
  a1.send({ type: "chat", text: "随便说一句【回甲】", convId: CONV });
  const deltaA = await a1.waitFor((e) => e.type === "msg.delta" && /回答·甲/.test(e.text || ""), 15000);
  ok("A 收到自己的流式回答", !!deltaA, JSON.stringify(deltaA).slice(0, 160));
  await a1.waitFor((e) => e.type === "msg.end" && e.convId === CONV, 15000).catch(() => {});
  await watermark(b);
  ok("同用户的第二个窗口也收到（多开不裂）", a2.has((e) => e.type === "msg.delta" && /回答·甲/.test(e.text || "")), "A2 事件数=" + a2.count((e) => e.type === "msg.delta"));
  ok("B 一条 A 的对话流都没收到", b.count((e) => String(e.type).startsWith("msg.")) === 0,
    "B 收到 " + b.count((e) => String(e.type).startsWith("msg.")) + " 条：" + JSON.stringify(b.events.filter((e) => String(e.type).startsWith("msg.")).slice(0, 2)).slice(0, 220));
  ok("B 仍然收到实例级事件（system.perf，证明它不是没连上）", b.has((e) => e.type === "system.perf"), "B 事件类型：" + [...new Set(b.events.map((e) => e.type))].join(","));

  section("② 反过来：B 的对话也不该串给 A");
  b.send({ type: "chat", text: "B 自己问一句【回乙】", convId: "conv-b" });
  await b.waitFor((e) => e.type === "msg.delta" && /回答·乙/.test(e.text || ""), 15000);
  ok("B 收到自己的回答", true);
  await watermark(a1);
  ok("A 没收到 B 的任何回答", !a1.has((e) => /回答·乙/.test(JSON.stringify(e))) && !a2.has((e) => /回答·乙/.test(JSON.stringify(e))),
    "A1 里命中 " + a1.count((e) => /回答·乙/.test(JSON.stringify(e))) + " 条");

  section("③ ask 模式：审批卡只弹给发起的那个人");
  a1.send({ type: "chat", text: "写个文件【工】【回丙】", convId: CONV });
  const pend = await a1.waitFor((e) => e.type === "tool.pending" && e.tool === "write_file", 15000);
  ok("A 弹出 write_file 审批卡", !!pend, JSON.stringify(pend).slice(0, 200));
  await watermark(b);
  ok("B 没看到这张卡", b.count((e) => e.type === "tool.pending") === 0,
    "B 收到 " + b.count((e) => e.type === "tool.pending") + " 张：" + JSON.stringify(b.events.filter((e) => e.type === "tool.pending").slice(0, 1)).slice(0, 200));

  section("④ 别人拿你的审批 id 点头，动不了你这张卡");
  b.send({ type: "tool.approve", id: pend.id, tool: pend.tool });   // B 试图替 A 批准
  await wait(1200);
  const stillPending = !fs.existsSync(path.join(SANDBOX.wsDir, "scope", "probe.txt"));
  ok("B 点头之后文件没被写出来（A 的卡仍未放行）", stillPending);
  a1.send({ type: "tool.approve", id: pend.id, tool: pend.tool });   // A 自己批
  await a1.waitFor((e) => e.type === "msg.delta" && /回答·丙/.test(e.text || ""), 20000);
  ok("A 自己批准后工具真跑了", fs.existsSync(path.join(SANDBOX.wsDir, "scope", "probe.txt")));
  ok("A 的这条流仍没漏给 B", !b.has((e) => e.type === "msg.delta" && /回答·丙/.test(e.text || "")));

  section("⑤ 一个人点「新对话」不该把别人的界面清掉");
  const resetsBefore = b.count((e) => e.type === "agent.reset");
  a1.send({ type: "reset" });
  await a1.waitFor((e) => e.type === "agent.reset", 8000);
  /* A2 是同一个用户的另一条连接，理论上同一次循环就发了，但两边收到消息的先后是异步的——
     不等一下就断言会把"确实收到了"读成"没收到"。 */
  await a2.waitFor((e) => e.type === "agent.reset", 5000).catch(() => {});
  ok("A 的两个连接都收到 agent.reset", a1.has((e) => e.type === "agent.reset") && a2.has((e) => e.type === "agent.reset"),
    "A1=" + a1.count((e) => e.type === "agent.reset") + " A2=" + a2.count((e) => e.type === "agent.reset"));
  // reset 分支在 agent.reset 之后还会发一条全局 fs.sync：B 收到它就证明之前那次广播确实该轮到 B
  await watermark(b);
  ok("B 没收到 agent.reset", b.count((e) => e.type === "agent.reset") === resetsBefore, "B 侧多了 " + (b.count((e) => e.type === "agent.reset") - resetsBefore) + " 条");

  section("⑥ 后台自动化仍要对所有人可见（anon 引擎不隔离）");
  const au = await req("POST", "/api/automations", {
    name: "探针自动化·隔离验证",
    prompt: "这是定时器派出去的活【回自】",
    scheduleType: "once",
    scheduledAt: new Date(Date.now() + 3600000).toISOString(),
  }, tokA);
  const auId = au.json && au.json.automation && au.json.automation.id;
  ok("自动化建出来了", !!auId, JSON.stringify(au.json).slice(0, 160));
  await req("POST", "/api/automations/" + auId + "/run", null, tokA);
  let autoLine = null;
  try { autoLine = await b.waitFor((e) => e.type === "term.line" && /\[自动化\] 开始执行/.test(e.text || ""), 12000); } catch (e) {}
  ok("登录用户的窗口看得见后台开跑（隔离没把 anon 一起关掉）", !!autoLine, JSON.stringify(autoLine || { types: [...new Set(b.events.map((e) => e.type))] }).toString().slice(0, 200));

  section("⑦ 卫生：没有内部异常广播");
  ok("全程没有 op.error", a1.count((e) => e.type === "op.error") + b.count((e) => e.type === "op.error") + a2.count((e) => e.type === "op.error") === 0,
    JSON.stringify([...a1.events, ...b.events, ...a2.events].filter((e) => e.type === "op.error").slice(0, 2)).slice(0, 260));
  ok("服务端日志没有异常栈", !/at Object\.<anonymous>|UnhandledPromiseRejection/.test(log), log.split("\n").filter(Boolean).slice(-3).join(" / ").slice(0, 240));

  [a1, a2, b].forEach((c) => { try { c.ws.close(); } catch (e) {} });
  server.kill();
  await wait(400);
  gw.srv.close();

  console.log("\n" + (fail === 0 ? "\x1b[32m" : "\x1b[31m") + "ALL PASS：" + pass + " 通过 / " + fail + " 失败\x1b[0m");
  if (fail) { console.log(fails.map((f) => "  - " + f).join("\n")); process.exit(1); }
  process.exit(0);
})().catch((e) => {
  console.error("[eventscope] FAIL:", (e && e.stack) || e);
  for (const c of CONNS) {
    console.error("  [" + c.label + "] 收到 " + c.events.length + " 条：" +
      [...new Set(c.events.map((x) => x.type))].join(","));
    for (const ev of c.events.filter((x) => String(x.type).startsWith("tool."))) console.error("  [" + c.label + "] tool* " + JSON.stringify(ev).slice(0, 300));
    const interesting = c.events.filter((x) => x.type !== "system.perf" && x.type !== "agent.trace").slice(-3);
    for (const ev of interesting) console.error("  [" + c.label + "] " + JSON.stringify(ev).slice(0, 300));
  }
  console.error("  [服务端日志尾巴] " + log.split("\n").filter(Boolean).slice(-8).join(" / ").slice(0, 1200));
  process.exit(1);
});
