/* 任务表 + 忙时排队的真实服务验证：起一个沙箱实例（独立数据根 + 独立工作区 + 本地假网关），
 * 用 WebSocket 走真实前端路径，验证七件事（正文按 ①…⑨ 分段，撞车那段是 ⑨）——
 *   一、同一会话正在跑时再发消息：不再静默丢弃，而是收到 chat.queued，并在上一轮结束后自动放行；
 *   二、任务表按工作区分片落盘，状态随事件推进（running → waiting → done）；
 *   三、断线重连的 hello 带上任务表（关窗回来能查）；
 *   四、进程被杀时还挂着的 running，重启后必须改判 interrupted（不假装还在跑）；
 *   五、重启后 Goal 接续：先报"被打断在第 N 轮"，用户点头才续跑，不自动起跑；
 *   六、自动化（定时器）也走同一张表：先落 running 再翻 done——桌面端的通知只认"翻面"那一刻；
 *        自动化行属工作区（换用户也看得见），别人的会话行不串进来；
 *   七、定时器点火时不碰用户正在流的那条会话（各走各的引擎）。
 * 全程不碰开发者真实的 .pancode。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const PORT = 8814;
const ROOT = path.resolve(__dirname, "..");
const SANDBOX = path.join(ROOT, "scripts", "_verify_out", "tasks-sandbox");
const DATA_DIR = path.join(SANDBOX, "data");
const WS_DIR = path.join(SANDBOX, "ws");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 假网关：带"慢"字的请求拖 1.8s（制造"会话正忙"的窗口），
   并把 prompt 里的【回X】标记回显进答案，好区分这句话是哪一路请求产生的 ---------- */
function startGateway() {
  const srv = http.createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", async () => {
      if (!/chat\/completions$/.test(rq.url || "")) { rs.writeHead(404); return rs.end(); }
      let j = {};
      try { j = JSON.parse(body || "{}"); } catch (e) {}
      const asText = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""));
      const all = (j.messages || []).map(asText).join("\n");
      /* 运行态尾部是引擎自己追加的一条 user 角色消息（_runtimeContext），所以"最后一条 user"
         不等于"人说的那句话"——按标记取最近一条带【回X】的用户消息，才能把答案归到正确的请求上。 */
      const tagged = (j.messages || []).filter((m) => m.role === "user").map(asText).filter((s) => /【回[^\]】]+】/.test(s)).pop() || "";
      if (/慢/.test(all)) await wait(1800);
      rs.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const mk = tagged.match(/【回([^\]】]+)】/);
      const sent = "回复·" + (mk ? mk[1] : "默认");
      rs.write('data: {"choices":[{"index":0,"delta":{"content":"' + sent + '"}}]}\n\n');
      rs.write("data: [DONE]\n\n");
      rs.end();
    });
  });
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({ srv, base: "http://127.0.0.1:" + srv.address().port + "/v1" })));
}

/* ---------- 键算法独立复算（不 import ws-key，免得探针和产品同时错成一个样子还看不出来） ---------- */
function canonical(p) {
  const abs = path.resolve(p).replace(/[\\/]+$/, "");
  return crypto.createHash("md5").update(process.platform === "win32" ? abs.toLowerCase() : abs).digest("hex");
}

let TOKEN = "";
let crashLog = "";    // 服务端 stdout/stderr 尾巴：抛异常时要能看见它死在哪句
function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (TOKEN) headers["x-user-token"] = TOKEN;
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

function boot(gatewayBase) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "pancode.config.json"), JSON.stringify({
    workspace: WS_DIR,
    llm: { baseURL: gatewayBase, apiKey: "sk-sandbox", model: "mock-task", contextWindow: 32000 },
    agentMode: "auto",
    permissions: { mode: "auto", allow: [], deny: [] },
  }), "utf8");
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), PANCODE_DATA_DIR: DATA_DIR, CURSORWEB_WORKSPACE: WS_DIR,
      AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out = (out + c).slice(-20000); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-20000); });
  return { child, log: () => out };
}

async function waitHealth() {
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const r = await req("GET", "/api/health"); if (r.json && r.json.ok) return true; } catch (e) {}
  }
  return false;
}

/* ---------- WebSocket：走前端真实消息路径 ---------- */
const WebSocket = require("ws");
async function connect() {
  const c = await new Promise((resolve, reject) => {
    // 注意：upgrade 有登录闸门，无 token 的连接会被服务端直接 destroy socket（探针因此必须带 token）
    const ws = new WebSocket("ws://localhost:" + PORT + "?token=" + encodeURIComponent(TOKEN));
    const events = [];
    const waiters = [];
    ws.on("message", (raw) => {
      const ev = JSON.parse(raw.toString());
      events.push(ev);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(ev)) { waiters[i].resolve(ev); waiters.splice(i, 1); }
      }
    });
    ws.on("open", () => resolve({
      ws, events,
      send: (o) => ws.send(JSON.stringify(o)),
      waitFor: (match, ms) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("等待事件超时：" + (ms || 6000) + "ms 内没等到")), ms || 6000);
        waiters.push({ match, resolve: (ev) => { clearTimeout(t); res(ev); } });
      }),
    }));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS 连接超时")), 8000);
  });
  // hello 是服务端异步拼装的（要快照整个工作区），open ≠ 已收到：不等一下就等于拿没到的数据做断言
  c.hello = await c.waitFor((e) => e.type === "hello", 15000);
  return c;
}

const tasksFile = () => path.join(DATA_DIR, ".pancode", "tasks", canonical(WS_DIR) + ".json");
async function readRows(pred, ms) {
  const deadline = Date.now() + (ms || 5000);
  while (Date.now() < deadline) {
    try {
      const d = JSON.parse(fs.readFileSync(tasksFile(), "utf8"));
      if (pred(d.tasks || [])) return d.tasks;
    } catch (e) {}
    await wait(80);
  }
  return null;
}

(async () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(WS_DIR, { recursive: true });
  fs.writeFileSync(path.join(WS_DIR, "a.js"), "export const a = 1;\n", "utf8");
  const { srv, base } = await startGateway();
  let b = boot(base);
  if (!await waitHealth()) { b.child.kill(); srv.close(); throw new Error("服务启动超时：" + b.log().slice(-1500)); }
  const reg = await req("POST", "/api/auth/register", { username: "_tasks_" + Date.now(), password: "test1234" });
  TOKEN = (reg.json && reg.json.token) || "";
  if (!TOKEN) { b.child.kill(); srv.close(); throw new Error("注册失败：" + JSON.stringify(reg.json || reg.raw)); }

  let c = await connect();
  try {
    section("① 会话正忙时再发一条：排队并有回执");
    const conv = "c-task-" + Date.now();
    c.send({ type: "chat", text: "慢一点：先做个自我介绍", convId: conv });
    await c.waitFor((e) => e.type === "user.msg" && e.convId === conv, 12000);
    c.send({ type: "chat", text: "第二条：排在后面的这句", convId: conv });
    let queued = null;
    try { queued = await c.waitFor((e) => e.type === "chat.queued" && e.convId === conv, 4000); } catch (e) {}
    ok("第二条收到 chat.queued（不再是静默丢弃）", !!queued, queued === null && "没等到");
    ok("回执带队列位置", !!queued && queued.position === 1, queued && JSON.stringify(queued).slice(0, 160));

    section("② 上一轮收口后自动放行，顺序不乱");
    /* 等一条事件的统一姿势：先看已经收到的（服务端常常抢先发完，waiters 只在"未来"的报文上匹配），
       再补一次等待；等不到就返回 null 继续跑——整条链 hard-fail 在一个事件上，后面几段就再也看不到结论了。 */
    const maybe = async (match, ms) => {
      const hit = c.events.find(match);
      if (hit) return hit;
      try { return await c.waitFor(match, ms); } catch (e) { return null; }
    };
    const done1 = await maybe((e) => e.type === "agent.done" && e.convId === conv, 20000);
    ok("第一轮正常收口", !!done1);
    const dq = await maybe((e) => e.type === "chat.dequeued" && e.convId === conv, 6000);
    ok("排队的第二条被放行（chat.dequeued）", !!dq && dq.remaining === 0, dq && JSON.stringify(dq).slice(0, 160));
    const user2 = await maybe((e) => e.type === "user.msg" && e.convId === conv && /排在后面的/.test(e.text || ""), 12000);
    ok("放行后跑的是那条排队的原文", !!user2);
    await maybe((e) => e.type === "agent.done" && e.convId === conv && e !== done1, 20000);

    section("③ 任务表落盘：分片文件名 = 工作区键");
    const rows = await readRows((t) => t.some((r) => r.convId === conv && r.status === "done"), 6000);
    ok("tasks/<分片键>.json 里这一轮标为 done", !!rows, "实际文件：" + tasksFile());
    const row = (rows || []).find((r) => r.convId === conv) || {};
    ok("标题取的是本轮（第二条），不是上一轮", /排在后面的/.test(row.title || ""), JSON.stringify(row.title));
    ok("开始/结束时间都记了", (row.startedAt || 0) > 0 && (row.endedAt || 0) >= (row.startedAt || 0), JSON.stringify(row).slice(0, 200));

    section("④ 重连的 hello 带上任务表");
    c.ws.close();
    await wait(300);
    c = await connect();
    const hello = c.hello;
    ok("hello.tasks 是数组且含刚收口的那条", Array.isArray(hello && hello.tasks)
      && (hello.tasks || []).some((t) => t.convId === conv && t.status === "done"), JSON.stringify(hello && hello.tasks || null).slice(0, 220));

    section("⑤ 进程中途被杀 → 重启后改判 interrupted");
    const conv2 = "c-kill-" + Date.now();
    c.send({ type: "chat", text: "慢一点：这句还没说完", convId: conv2 });
    await c.waitFor((e) => e.type === "user.msg" && e.convId === conv2, 12000);
    const running = await readRows((t) => t.some((r) => r.convId === conv2 && r.status === "running"), 4000);
    ok("运行中能在表里查到（这就是「派出去」的凭据）", !!running);
    c.ws.close();
    b.child.kill();
    await wait(900);
    b = boot(base);
    if (!await waitHealth()) throw new Error("重启失败：" + b.log().slice(-1200));
    c = await connect();
    const h2 = c.hello;
    const dead = (h2.tasks || []).find((t) => t.convId === conv2);
    ok("重启后那条未收口的任务是 interrupted，不是 running", !!dead && dead.status === "interrupted", JSON.stringify(dead));
    ok("上一轮已 done 的任务不被误改", (h2.tasks || []).some((t) => t.convId === conv && t.status === "done"),
      JSON.stringify((h2.tasks || []).map((t) => [t.convId, t.status])));
    ok("启动日志报告了未收口任务数", /未收口/.test(b.log()), b.log().slice(-300));

    section("⑥ 重启后 Goal 接续：先说清楚，再由用户点头");
    /* 换一个全新用户来验：同一 userKey 的引擎已被缓存，_loadGoal 只在构造时读一次盘。
       直接按"上次退出后遗留在盘上的样子"摆文件，比编排一次真实崩溃更可控。 */
    const reg2 = await req("POST", "/api/auth/register", { username: "_tasks2_" + Date.now(), password: "test1234" });
    TOKEN = (reg2.json && reg2.json.token) || TOKEN;
    const uKey = "u" + crypto.createHash("md5").update(TOKEN).digest("hex").slice(0, 8);
    const goalFile = path.join(DATA_DIR, ".pancode", "goals", canonical(WS_DIR) + "__" + uKey + ".json");
    fs.mkdirSync(path.dirname(goalFile), { recursive: true });
    fs.writeFileSync(goalFile, JSON.stringify({
      goal: "把探针的验收补齐", ts: Date.now(),
      states: { "c-goal": { turns: 3, stall: 0, lastSig: "a.js:1:0" } },
    }), "utf8");
    c.ws.close();
    await wait(200);
    c = await connect();
    // hello 之后这两条是同一段代码紧跟着发的，但它们是两条独立报文：只能等，不能假定已入列
    // goal.pending 紧跟 hello 发出：它往往已经在 events 里了，只等"未来的"报文会永远等不到。
    const pend = await maybe((e) => e.type === "goal.pending" && e.convId === "c-goal", 5000);
    ok("连上来就报出「这个会话的 Goal 被打断在第 3 轮」", !!pend && pend.turns === 3,
      JSON.stringify(c.events.filter((e) => e.type.indexOf("goal") === 0)).slice(0, 200));
    // 这两条是服务端紧挨着发的：goal.pending 一到，term.line 往往已经在 events 里了，
    // 只等"未来的"报文会永远等不到——先看已收到的，再补一次等待。
    const hasLine = async () => {
      if (c.events.some((e) => e.type === "term.line" && /要不要继续/.test(e.text || ""))) return true;
      try { return !!(await c.waitFor((e) => e.type === "term.line" && /要不要继续/.test(e.text || ""), 3000)); } catch (e) { return false; }
    };
    ok("同时给一句终端提示（不自动跑，等用户决定）", await hasLine());
    ok("重启后没有擅自把上一轮的 Goal 接着跑下去",
      !c.events.some((e) => e.type === "user.msg" && /Goal 续跑/.test(e.text || "")));

    c.send({ type: "goal.resume", convId: "c-goal" });
    const resumed = await (async () => { try { return await c.waitFor((e) => e.type === "user.msg" && /Goal 续跑/.test(e.text || ""), 12000); } catch (e) { return null; } })();
    ok("点「继续」后才重新起跑，并带上已跑轮次提醒它别重复劳动", !!resumed && /上次被进程退出打断，已跑 3 轮/.test(resumed.text),
      resumed && String(resumed.text).slice(0, 120));

    section("⑦ 定时器跑的活也进任务表：开跑有 running，收口才翻面");
    /* 桌面端通知全靠"两次轮询之间状态翻了面"。所以自动化必须先在表里留下一行 running，
       再翻成 done —— 若开跑与收口挤在同一次快照里，通知就静默丢失。
       scheduledAt 摆到一小时后：本轮只验手动 /run 这条路径，不让 30s tick 干扰断言。 */
    const au = await req("POST", "/api/automations", {
      name: "探针自动化·整理工作区",
      prompt: "慢一点：这是定时器派出去的活",
      scheduleType: "once",
      scheduledAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const auId = au.json && au.json.automation && au.json.automation.id;
    ok("自动化任务建出来了", !!auId, JSON.stringify(au.json).slice(0, 160));
    await req("POST", "/api/automations/" + auId + "/run");
    /* 触发是异步的（fire 立即返回）：先看在手，再等 —— 只等"未来的"报文会永远等不到已在列的那条 */
    const lineOf = async (re, ms) => {
      const hit = c.events.find((e) => e.type === "term.line" && re.test(e.text || ""));
      if (hit) return hit;
      try { return await c.waitFor((e) => e.type === "term.line" && re.test(e.text || ""), ms); } catch (e) { return null; }
    };
    const started = await lineOf(/\[自动化\] 开始执行/, 8000);
    ok("开跑即在终端留痕（前端不用猜后台发生了什么）", !!started && /整理工作区/.test(started.text), JSON.stringify(started || null).slice(0, 160));
    const auRunning = await readRows((t) => t.some((r) => r.convId === "auto-" + auId && r.status === "running"), 3500);
    ok("收口前查到的是 running（这一面是通知的前提）", !!auRunning,
      "表里：" + JSON.stringify((auRunning || []).map((r) => [r.convId, r.status])));
    const auRowLive = (auRunning || []).find((r) => r.convId === "auto-" + auId) || {};
    ok("标题标得出来是哪条自动化在跑", /自动化：.*整理工作区/.test(auRowLive.title || ""), JSON.stringify(auRowLive.title));
    ok("来源标为 automation（会话级行与它分开）", auRowLive.origin === "automation", JSON.stringify(auRowLive).slice(0, 200));
    /* 轮询一次真实接口：托盘走的就是这条 HTTP 通道，而不是进程内的 TaskBoard 实例 */
    const snap1 = await req("GET", "/api/tasks");
    const s1 = (snap1.json.tasks || []).find((r) => r.convId === "auto-" + auId) || {};
    ok("/api/tasks 能看到它（托盘轮询的那条通道）", s1.status === "running" || s1.status === "done", JSON.stringify(s1).slice(0, 200));
    const finished = await lineOf(/\[自动化\]「.*整理工作区」跑完了/, 20000);
    ok("收口再留一条痕", !!finished, finished === null && "没等到");
    const done = await readRows((t) => t.some((r) => r.convId === "auto-" + auId && (r.status === "done" || r.status === "failed")), 6000);
    const auRow = (done || []).find((r) => r.convId === "auto-" + auId) || {};
    ok("running → done 真的翻了面（不是只有痕没有状态）", auRow.status === "done", JSON.stringify(auRow).slice(0, 220));
    const hist = await req("GET", "/api/automations/" + auId + "/runs");
    ok("运行历史照常落盘，任务表没把它替掉", !!(hist.json.runs || []).length, JSON.stringify(hist.json).slice(0, 160));

    section("⑧ 自动化行是工作区级的：别人连上来也看得见");
    /* 当前 TOKEN 已换成第二个用户：上一段那些会话行属于第一个用户。
       这一条同时验两件事——后台替整个工作区干的活人人都看得见，
       而别人干的会话不能串进我的列表。 */
    c.ws.close();
    await wait(250);
    c = await connect();
    const h3 = c.hello;
    const seen = (h3.tasks || []).find((t) => t.convId === "auto-" + auId);
    ok("hello.tasks 里带着那条自动化（换个用户也看得见）", !!seen && seen.origin === "automation",
      JSON.stringify((h3.tasks || []).map((t) => [t.convId, t.origin, t.status])).slice(0, 260));
    const nonAuto = (h3.tasks || []).filter((t) => t.origin !== "automation").map((t) => t.convId);
    ok("别人的会话行没有串进来（只剩这个用户自己那条 Goal 会话）",
      nonAuto.indexOf(conv) < 0 && nonAuto.indexOf(conv2) < 0 && nonAuto.indexOf("c-goal") >= 0,
      "属于新用户可见的会话行：" + JSON.stringify(nonAuto) + "，前一个用户的：" + conv + " / " + conv2);

    section("⑨ 定时器点火时，正在流式的用户会话不受影响");
    /* 回归护栏。调度器用的是 anon 引擎，而业务 WS 是登录后才接的（server/index.js 的 upgrade 闸门：
       无 token 直接 destroy socket），每个登录用户各自一台引擎——所以定时器 runSubAgent 里那套
       「把 msgStart/tool 句柄临时换成 no-op」的静默逻辑够不到用户正在流的那条会话。
       哪天把调度器改成借用某个用户的引擎，这条会立刻红：用户的回答会被静默吞掉。 */
    const convB = "c-clash-" + Date.now();
    c.send({ type: "chat", text: "慢一点：这是用户正在看的会话【回用户】", convId: convB });
    await c.waitFor((e) => e.type === "user.msg" && e.convId === convB, 12000);
    const au2 = await req("POST", "/api/automations", {
      name: "探针自动化·撞车",
      prompt: "慢一点：定时器派出去的活【回定时】",
      scheduleType: "once",
      scheduledAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const auId2 = au2.json && au2.json.automation && au2.json.automation.id;
    await req("POST", "/api/automations/" + auId2 + "/run");  // 就在用户这条会话还在流的时候点火
    const doneB = await (async () => { try { return await c.waitFor((e) => e.type === "agent.done" && e.convId === convB, 30000); } catch (e) { return null; } })();
    ok("用户这条会话照常收口", !!doneB, doneB === null && "30s 内没等到 agent.done");
    const streamed = c.events.filter((e) => e.type === "msg.delta").map((e) => e.text || "").join("");
    ok("定时器没有吞掉用户的回答（msg.delta 里读得到它）", /回复·用户/.test(streamed),
      "这条连接收到的正文：" + JSON.stringify(streamed.slice(0, 120)));
    const auSettled = await readRows((t) => t.some((r) => r.convId === "auto-" + auId2 && (r.status === "done" || r.status === "failed")), 15000);
    const auRow2 = (auSettled || []).find((r) => r.convId === "auto-" + auId2) || {};
    ok("自动化自己那行照常收口（跑不动也如实标 failed）",
      auRow2.status === "done" || auRow2.status === "failed", JSON.stringify(auRow2).slice(0, 220));
    ok("定时器的输出没有渗进用户的会话流（那是另一台引擎的活）",
      !/回复·定时/.test(streamed) && auRow2.convId === "auto-" + auId2, JSON.stringify(streamed.slice(0, 100)));
  } finally {
    crashLog = b.log();
    try { c.ws.close(); } catch (e) {}
    b.child.kill();
    srv.close();
  }

  console.log("\n" + (fail ? "\x1b[31mHAS FAIL\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { for (const f of fails) console.log("  - " + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\x1b[31mFAIL:\x1b[0m " + (e && e.stack || e)); if (crashLog) console.error("--- 服务端输出末尾 ---\n" + crashLog.slice(-1600)); process.exit(1); });
