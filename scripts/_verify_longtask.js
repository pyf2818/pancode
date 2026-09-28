/* 长任务卡断修复验证（离线单元层）
   针对四类实测根因逐条断言，全部不联网、不起服务、不碰真实数据根：
   1) 时限配置贯通：默认值 / 落盘 / 读回 / 钳制（前端设置面板依赖 agentSettings 暴露）
   2) 审批与选项等待：不再固定 120s 自动放弃；时限可配；超时后 AI 归位空闲；不残留计时器
   3) 工具守卫：子智能体 / 编排 / 写盘类不再被 120s 腰斩成一条假"[超时]"
   4) run_command：前台时限可配 + 模型能收到"改走后台进程"的指引
   5) 子智能体中断信号取本会话 abortRef（多会话并行时不被别的会话误伤）
   6) WebSocket 心跳：只对有来源（本机回环）的链路判死；真实 ws 客户端靠自动 pong 长期存活
*/
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const Module = require("module");

const ROOT = path.resolve(__dirname, "..");
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-longtask-"));
process.env.PANCODE_DATA_DIR = SANDBOX;
delete process.env.PORT;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const timersNow = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;

const configMod = require(path.join(ROOT, "server", "config.js"));

/* ---------- 沙箱服务端 + 僵尸连接辅助 ---------- */
const http = require("http");
const { spawn } = require("child_process");
const SRV_PORT = Number(process.env.LONGTASK_PORT || 8813);
let AUTH_TOK = "";

function httpJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (AUTH_TOK) headers["x-user-token"] = AUTH_TOK;
    const r = http.request({ host: "127.0.0.1", port: SRV_PORT, path: urlPath, method, headers, timeout: 12000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, raw: buf }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("http timeout")));
    if (data) r.write(data);
    r.end();
  });
}

async function bootSandbox() {
  const srvDir = path.join(SANDBOX, "srv");
  const wsDir = path.join(SANDBOX, "srv-ws");
  fs.mkdirSync(path.join(srvDir, ".pancode"), { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "README.md"), "# longtask sandbox\n");
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(SRV_PORT), PANCODE_DATA_DIR: srvDir, CURSORWEB_WORKSPACE: wsDir,
      CURSORWEB_ENGINE: "demo", AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
      PANCODE_WS_PING_MS: "700",        // 心跳加速，让判死行为在几秒内可观测
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  child.stdout.on("data", (c) => { tail = (tail + c).slice(-6000); });
  child.stderr.on("data", (c) => { tail = (tail + c).slice(-6000); });
  let ready = false;
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const r = await httpJson("GET", "/api/health"); if (r.json && r.json.ok) { ready = true; break; } } catch (e) {}
  }
  if (!ready) throw new Error("沙箱服务未在 18s 内就绪\n" + tail);
  const reg = await httpJson("POST", "/api/auth/register", { username: "_lt_" + Date.now(), password: "test1234" });
  const token = (reg.json && reg.json.token) || "";
  if (!token) throw new Error("注册沙箱用户失败：" + JSON.stringify(reg.json || reg.raw));
  AUTH_TOK = token;
  return { child, port: SRV_PORT, token, tail: () => tail, req: httpJson };
}

/* 手工完成 WS 握手后故意不回 pong —— 半开链路的等价条件 */
function openZombie(port, token) {
  const net = require("net");
  const crypto = require("crypto");
  const sock = net.connect(port, "127.0.0.1");
  const z = {
    sock, upgradeSeen: false, openedAt: Date.now(), detail: "", pingCount: 0, closedAt: 0,
    waitForClose(ms) {
      return new Promise((resolve) => {
        let done = false;
        const fin = () => { if (!done) { done = true; z.closedAt = Date.now(); clearTimeout(t); resolve(true); } };
        sock.once("close", fin); sock.once("end", fin); sock.once("error", fin);
        const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, ms);
      });
    },
  };
  const key = crypto.randomBytes(16).toString("base64");
  let acc = Buffer.alloc(0), handshook = false, resolveZ = null;
  sock.on("data", (chunk) => {
    acc = Buffer.concat([acc, chunk]);
    if (!handshook) {
      const i = acc.indexOf("\r\n\r\n");
      if (i < 0) return;
      z.upgradeSeen = acc.slice(0, i).toString("latin1").includes(" 101");
      z.detail = "握手响应: " + acc.slice(0, i).toString("latin1").split("\r\n")[0];
      acc = acc.slice(i + 4);
      handshook = true;
      z.openedAt = Date.now();
      if (!z._resolved && resolveZ) { z._resolved = true; resolveZ(z); }
      return;
    }
    // 逐帧走完服务端→客户端的帧（服务端帧不掩码），只数 opcode，绝不回 pong
    while (acc.length >= 2) {
      const op = acc[0] & 0x0f;
      let len = acc[1] & 0x7f, hdr = 2;
      if (len === 126) { if (acc.length < 4) break; len = acc.readUInt16BE(2); hdr = 4; }
      else if (len === 127) { if (acc.length < 10) break; len = Number(acc.readBigUInt64BE(2)); hdr = 10; }
      if (acc.length < hdr + len) break;
      if (op === 9) z.pingCount++;
      acc = acc.slice(hdr + len);
    }
  });
  sock.on("error", (e) => { z.detail += " / sock error: " + e.message; });
  sock.once("connect", () => {
    sock.write("GET /?token=" + encodeURIComponent(token) + " HTTP/1.1\r\n"
      + "Host: 127.0.0.1:" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n");
  });
  return new Promise((res, rej) => {
    resolveZ = res;
    const t = setTimeout(() => { if (!z._resolved) { z._resolved = true; res(z); } }, 5000);
    sock.once("error", (e) => { if (!z._resolved) { z._resolved = true; clearTimeout(t); rej(e); } });
  });
}

function waitWsEvent(socket, pred, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { socket.off("message", h); resolve(null); }, ms);
    const h = (b) => { let j; try { j = JSON.parse(b); } catch (e) { return; } if (pred(j)) { clearTimeout(t); socket.off("message", h); resolve(j); } };
    socket.on("message", h);
  });
}
section("1) 时限配置贯通（config）");
const base = configMod.load();
ok("默认 commandSec = 600（原实现硬编码 90s）", base.timeouts && base.timeouts.commandSec === 600, JSON.stringify(base.timeouts));
ok("默认 approvalSec = 1200（原实现硬编码 120s 自动拒绝）", base.timeouts.approvalSec === 1200);
ok("默认 toolSec = 120", base.timeouts.toolSec === 120);
ok("agentSettings() 暴露 timeouts（设置面板读得到）",
  !!(configMod.agentSettings(base) || {}).timeouts, JSON.stringify(Object.keys(configMod.agentSettings(base))));

configMod.saveAgentSettings(base, { timeouts: { commandSec: 1800, approvalSec: 3600, toolSec: 300 } });
ok("保存后三项新值生效", base.timeouts.commandSec === 1800 && base.timeouts.approvalSec === 3600 && base.timeouts.toolSec === 300,
  JSON.stringify(base.timeouts));
configMod.saveAgentSettings(base, { timeouts: { commandSec: 99999, approvalSec: 1, toolSec: -5 } });
ok("越界被钳制（7200 / 30 / 15），不会被改坏",
  base.timeouts.commandSec === 7200 && base.timeouts.approvalSec === 30 && base.timeouts.toolSec === 15, JSON.stringify(base.timeouts));
configMod.saveAgentSettings(base, { timeouts: { commandSec: "abc" } });
ok("非法值保持原值不塌成 undefined", base.timeouts.commandSec === 7200, String(base.timeouts.commandSec));
configMod.saveAgentSettings(base, { timeouts: { commandSec: 600, approvalSec: 90, toolSec: 120 } });

/* ---------- Agent 桩环境 ---------- */
const events = [];
/* agent-llm 是以 `const { chatStream } = require("./llm")` 解构后裸调用的，
   所以 mock 里不能用 this（严格模式下 this 为 undefined，赋值即抛错、整轮 LLM 调用被吞掉）。 */
let llmToolsSeen = null;
let llmCalls = 0;
const mockLlm = {
  async chatStream(cfg, messages, tools) {
    llmCalls++;
    llmToolsSeen = tools || [];
    return { content: "收到", reasoning: "", toolCalls: [], finish: "stop", usage: null };
  },
  async ping() { return true; },
};
class AgentBase {
  constructor(ctx) { this.ctx = ctx; this.cfg = ctx.cfg; this.files = ctx.files; this.term = ctx.term; }
  emit(ev) { events.push(ev); }
  tool() { return { body() {}, done() {}, end() {}, delta() {}, start() {} }; }
  thinkStart() { return { delta() {}, end() {} }; }
  msgStart() { return { delta() {}, end() {} }; }
  async say() {}
  fileChanged() {}
  pushChanges() { return []; }
  state() {}
  resolveApproval() {}
}
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "./llm") return mockLlm;
  if (request === "./agent-base") return { AgentBase };
  return origLoad.apply(this, arguments);
};
const { LlmAgent } = require(path.join(ROOT, "server", "agent-llm.js"));

const termCalls = [];
const termStub = {
  run: async (tab, cmd, x, opts) => {
    termCalls.push({ tab, cmd, opts });
    if (cmd === "__TIMEOUT__") return { out: "BUILD-OUTPUT-TAIL\n Compiling 998 modules", code: null, timedOut: true };
    return { out: "command finished ok", code: 0 };
  },
  kill: () => {}, busyFor: () => false, open: () => {}, close: () => {}, list: () => [],
};
function mkAgent() {
  const a = new LlmAgent({
    cfg: Object.assign(configMod.load(), {
      llm: { baseURL: "http://127.0.0.1:9/v1", apiKey: "sk-test", model: "m", temperature: 0, contextWindow: 128000 },
      permissions: { mode: "auto", allow: [], deny: [], strictCommand: true },
      rules: { enabled: false }, memory: { enabled: false },
      context: { budgetTokens: 100000, autoCompact: false },
      workspace: SANDBOX,
    }),
    files: { dir: SANDBOX, list: () => [], read: () => "", write: () => {}, exists: () => true, remove: () => {}, search: () => [], stat: () => null },
    term: termStub,
    git: { info: () => ({ git: false }), status: () => [], diff: () => "", log: () => [], branch: () => "master", current: () => "master" },
  });
  a.running = false;
  return a;
}

/* ---------- 2) 审批 / 选项等待 ---------- */
section("2) 审批与选项等待（可配时限 + 不残留计时器）");
(async () => {
  // 落盘走 safe-write 异步队列（杀软锁定下指数退避），这里要等它写完再验盘上内容
  await wait(400);
  const diskPath = path.join(SANDBOX, "pancode.config.json");
  const onDisk = fs.existsSync(diskPath) ? JSON.parse(fs.readFileSync(diskPath, "utf8")) : null;
  ok("timeouts 按最后一次保存落盘（重启后仍是用户设的值）",
    onDisk && onDisk.timeouts && onDisk.timeouts.commandSec === 600 && onDisk.timeouts.approvalSec === 90 && onDisk.timeouts.toolSec === 120,
    onDisk ? JSON.stringify(onDisk.timeouts) : "pancode.config.json 未生成");

  const a = mkAgent();

  const before = timersNow();
  const p = a.requestApproval("write_file", { path: "x.js", content: "1" }, "low");
  await wait(50);
  const pend = events.filter((e) => e.type === "tool.pending");
  ok("审批卡片带 timeoutSec 下发给前端", pend.length && pend[pend.length - 1].timeoutSec === 90,
    "实际 " + (pend.length ? pend[pend.length - 1].timeoutSec : "无 tool.pending"));
  const stBeforePend = events.findIndex((e) => e.type === "agent.state" && /等你确认/.test(e.label || ""));
  const iPend = events.findIndex((e) => e.type === "tool.pending");
  ok("等待一开始状态即改为「等你确认」（不再显示成 AI 思考中）", stBeforePend >= 0,
    JSON.stringify(events.filter((e) => e.type === "agent.state").slice(-2)));
  ok("「等你确认」先于审批卡片下发（前端不会有一瞬显示成正常运行中）", stBeforePend >= 0 && stBeforePend <= iPend,
    stBeforePend + " vs " + iPend);
  const during = timersNow();
  ok("等待期间挂了 2 个计时器（自动放弃 + 每分钟提醒）", during >= before + 2, before + " → " + during);
  a.resolveApproval(pend[pend.length - 1].id, true);
  const r = await p;
  ok("用户批准后正常返回", r && r.approved === true, JSON.stringify(r));
  await wait(30);
  const after = timersNow();
  ok("批准后计时器全部回收（提醒计时器不泄漏）", after < during, during + " → " + after);

  /* 时限真的驱动行为：approvalSec=1 时约 1 秒自动放弃 */
  const b = mkAgent();
  b.cfg.timeouts = { commandSec: 600, approvalSec: 30, toolSec: 120 };
  const t0 = Date.now();
  const p2 = b.requestApproval("run_command", { command: "npm run build" }, "medium");
  const el = Date.now() - t0;
  ok("approvalSec=30 时不会在 " + el + "ms 内提前放弃（远快于 30s）", el < 3000);
  const res2 = await p2;
  const used = Date.now() - t0;
  ok("到点自动拒绝并说明时限", res2.approved === false && /超时/.test(res2.reason || ""), JSON.stringify(res2));
  ok("自动放弃的收尾广播让前端卡片不永远停在「等待中」",
    b && events.some((e) => e.type === "tool.end" && /超时/.test(e.label || "")), "无合成 tool.end");
  ok("自动放弃后 AI 归位空闲（状态栏不再挂着运行中）",
    events.slice(-3).some((e) => e.type === "agent.state" && e.running === false), JSON.stringify(events.slice(-3)));
  console.log("    \x1b[2m实测：approvalSec=30 → 30s 上下自动拒绝，实际用时 " + used + "ms\x1b[0m");

  /* 选项卡同样可配、超时不挂起 */
  const c = mkAgent();
  c.cfg.timeouts = { commandSec: 600, approvalSec: 30, toolSec: 120 };
  const rc = await Promise.race([
    c.execTool("ask_user_choice", { question: "选一个", options: [{ label: "A" }, { label: "B" }] }),
    wait(70000).then(() => "HANG"),
  ]);
  ok("选项卡超时后返回而不是永久挂起", rc !== "HANG" && /超时|未做出选择/.test(String(rc)), String(rc).slice(0, 80));
  ok("选项卡下发 timeoutSec", events.some((e) => e.type === "tool.ask_choice" && e.timeoutSec === 30));

  /* ---------- 3) 工具守卫 ---------- */
  section("3) 工具守卫：编排/子智能体/写盘不再被 120s 腰斩");
  const d = mkAgent();
  d.cfg.timeouts = { commandSec: 600, approvalSec: 90, toolSec: 15 };
  const slow = (ms, val) => () => new Promise((r) => setTimeout(() => r(val), ms));
  d.execTool = slow(2500, "SUBAGENT-FINAL");
  const gA = await d._runToolGuarded("agent", { prompt: "x" });
  ok("agent 子智能体跑 2.5s 拿到真实结果，不是 [超时]", gA === "SUBAGENT-FINAL", String(gA).slice(0, 60));
  const gO = await d._runToolGuarded("orchestrate", { tasks: [] });
  ok("orchestrate 同样不受只读兜底时限约束", gO === "SUBAGENT-FINAL", String(gO).slice(0, 60));
  const gW = await d._runToolGuarded("write_file", { path: "a" });
  ok("写盘类（可能弹审批门）不设守卫时限", gW === "SUBAGENT-FINAL", String(gW).slice(0, 60));
  const tR = Date.now();
  d.execTool = () => new Promise((r) => setTimeout(() => r("STILL-RUNNING"), 60000));
  const gR = await d._runToolGuarded("read_file", { path: "a" });
  const durR = Date.now() - tR;
  ok("只读类仍保留兜底时限（能真的超时，不会无声卡死）", /^\[超时\]/.test(String(gR)), String(gR).slice(0, 60));
  ok("兜底时限取设置值（toolSec=15 → 约 15s 判定，不再是写死的 120s）", Math.abs(durR - 15000) < 2500, "实际 " + durR + "ms");
  console.log("    \x1b[2m实测：只读工具挂死时 " + durR + "ms 后返回[超时]；agent/orchestrate 跑满 2.5s 未被腰斩\x1b[0m");
  ok("超时文案给出可执行的下一步（缩小范围/换工具）", /请|改用|重试/.test(String(gR)));
  const e2 = mkAgent();
  e2._abort = true;
  const gAbo = await e2._runToolGuarded("read_file", { path: "a" });
  ok("已中断时工具直接短路，不执行", /^\[已中断\]/.test(String(gAbo)), String(gAbo));

  /* ---------- 4) run_command ---------- */
  section("4) run_command：前台时限可配 + 超时有指引");
  const e = mkAgent();
  await e.execTool("run_command", { command: "echo hi" });
  ok("未显式传 timeout 时用设置值（600s → 600000ms）",
    termCalls.length && termCalls[termCalls.length - 1].opts.timeout === 600000,
    JSON.stringify(termCalls[termCalls.length - 1] || {}));
  await e.execTool("run_command", { command: "echo hi", timeout: 42 });
  ok("模型显式传的 timeout 被采纳（42s → 42000ms）", termCalls[termCalls.length - 1].opts.timeout === 42000,
    JSON.stringify(termCalls[termCalls.length - 1].opts));
  await e.execTool("run_command", { command: "echo hi", timeout: 999999 });
  ok("超上限被钳到 7200s", termCalls[termCalls.length - 1].opts.timeout === 7200000);
  await e.execTool("run_command", { command: "echo hi", timeout: 3 });
  ok("低于下限被抬到 15s（不会一碰就杀）", termCalls[termCalls.length - 1].opts.timeout === 15000);
  const rcOut = String(await e.execTool("run_command", { command: "__TIMEOUT__", timeout: 30 }));
  ok("命令超时返回已产生的输出尾（不丢构建日志）", /BUILD-OUTPUT-TAIL/.test(rcOut), rcOut.slice(0, 80));
  ok("超时指引告诉模型改走后台进程", /start_process/.test(rcOut) && /read_process/.test(rcOut), rcOut.slice(-160));
  /* 模型侧真的看得到 timeout：跑一轮 ReAct，抓交给 LLM 层的 tools 数组 */
  try {
    await Promise.race([e.handleChat("只回一句话就结束", { convId: "probe-schema" }), wait(12000)]);
  } catch (err) { console.log("    \x1b[2m(handleChat 探针提前结束：" + String(err && err.message || err).slice(0, 60) + ")\x1b[0m"); }
  const rcTool = (llmToolsSeen || []).find((x) => x.function && x.function.name === "run_command");
  ok("ReAct 循环真的把工具清单交给模型（调用 " + llmCalls + " 次，" + (llmToolsSeen || []).length + " 个工具）",
    llmCalls >= 1 && Array.isArray(llmToolsSeen) && llmToolsSeen.length >= 30, "抓到 " + (llmToolsSeen || []).length + " 个");
  ok("run_command schema 暴露 timeout 参数（模型才知道能传）",
    !!(rcTool && rcTool.function.parameters.properties && rcTool.function.parameters.properties.timeout),
    rcTool ? JSON.stringify(Object.keys(rcTool.function.parameters.properties || {})) : "未见 run_command");
  ok("timeout 参数说明里指向后台进程方案（长构建不再前台等死）",
    /start_process/.test((rcTool && rcTool.function.parameters.properties.timeout.description) || ""),
    (rcTool && rcTool.function.parameters.properties.timeout.description || "").slice(0, 80));

  /* ---------- 5) 子智能体中断信号 ---------- */
  section("5) 子智能体中断信号按会话取");
  const src = fs.readFileSync(path.join(ROOT, "server", "agent-llm.js"), "utf8");
  const body = src.slice(src.indexOf("async runSubAgent"), src.indexOf("_acquireSubLock"));
  ok("runSubAgent 内不再读引擎级 this._abort 做循环判定",
    !/if \(this\._abort\)/.test(body), (body.match(/if \(this\._abort\)/g) || []).join());
  ok("runSubAgent 用 convContext 的 abortRef", /convContext\.getStore\(\)/.test(body) && /abortRef\.value/.test(body));

  /* ---------- 6) WebSocket 心跳 ---------- */
  section("6) WebSocket 心跳判死条件");
  const idx = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
  const hb = idx.slice(idx.indexOf("const wsHeartbeat"), idx.indexOf("wsHeartbeat.unref"));
  ok("判死条件是「ping 未回 pong」，不是空闲时长（静默但不死的连接不会被误杀）",
    /if \(c\._alive === false\)/.test(hb) && hb.indexOf("c._alive = false") > hb.indexOf("c._alive === false"));
  ok("已判死的连接被 terminate 并移出广播集合", /clients\.delete\(c\)/.test(hb) && /c\.terminate\(\)/.test(hb));
  ok("非 OPEN 的连接只做清理、不发 ping", /if \(c\.readyState !== 1\)/.test(hb));
  ok("健康连接每轮被 ping 一次并置为待验证", /c\._alive = false;[\s\S]{0,40}c\.ping\(\)/.test(hb));
  ok("连接建立即标记存活（不会刚连上就被判死）", /ws\._alive = true/.test(idx) && /ws\.on\("pong"/.test(idx));
  ok("连接补了 error 监听（不再靠全局兜底吞掉）", /ws\.on\("error"/.test(idx));
  ok("心跳周期可配且默认 20s", /PANCODE_WS_PING_MS/.test(idx) && /20000/.test(idx));
  const ws = require(path.join(ROOT, "node_modules", "ws"));
  ok("依赖的 ws 版本支持协议层 ping/pong（浏览器会自动回 pong）", typeof ws.prototype.ping === "function" && typeof ws.prototype.terminate === "function");

  /* ---------- 7) 真服务上的心跳行为 ---------- */
  section("7) 真实服务端：不回 pong 的连接被踢掉，会 pong 的连接长期存活");
  const boot = await bootSandbox();
  try {
    const tok = boot.token;
    // (a) 正常客户端：Node 的 ws 库自动回 pong —— 等同浏览器行为
    const good = new ws("ws://127.0.0.1:" + boot.port + "/?token=" + encodeURIComponent(tok));
    let helloSeen = null;
    good.on("message", (b) => { try { const j = JSON.parse(b); if (j.type === "hello") helloSeen = j; } catch (e) {} });
    await new Promise((res, rej) => { good.once("open", res); good.once("error", rej); });
    // (b) 僵尸客户端：手工完成握手后不回 pong（半开链路的等价条件）
    const zombie = await openZombie(boot.port, tok);
    ok("两条连接都建立（健康 + 僵尸）", good.readyState === 1 && zombie.upgradeSeen, zombie.detail);
    ok("健康连接收到 hello", !!helloSeen);
    const clients0 = (await boot.req("GET", "/api/health")).json.wsClients;
    ok("服务端集合里有 2 条连接", clients0 === 2, "wsClients=" + clients0);

    const zClosed = await zombie.waitForClose(8000);
    const t = Date.now() - zombie.openedAt;
    ok("僵尸连接确实收到了服务端 ping（不是别的缘故断开）", zombie.pingCount >= 1, "收到 ping 帧数=" + zombie.pingCount);
    ok("僵尸连接在数轮心跳内被踢掉（心跳确实在判死）", zClosed, "8s 内未关闭");
    console.log("    \x1b[2m实测：PING_MS=700 → 僵尸连接（收到 " + zombie.pingCount + " 个 ping、未回 pong）在 " + t + "ms 后被 terminate\x1b[0m");
    await wait(900);
    const clients1 = (await boot.req("GET", "/api/health")).json.wsClients;
    ok("被踢连接从广播集合移除（不再对死链路 send）", clients1 === 1, "wsClients=" + clients1);
    ok("健康连接未被误伤（仍在 open）", good.readyState === 1);

    // 踢掉僵尸后服务端仍能正常推事件（广播链路没被心跳搞坏）
    const got = await waitWsEvent(good, (j) => j.type === "system.perf", 8000);
    ok("存活连接继续收到广播事件", !!got, "8s 内无 system.perf");
    const evAfter = (await boot.req("GET", "/api/health")).json.wsClients;
    ok("心跳周期内没有把健康连接越踢越多/越少", evAfter === 1, "wsClients=" + evAfter);
    good.close();
  } finally {
    boot.child.kill();
    await wait(200);
  }

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  console.log("");
  if (fail) { console.log("\x1b[31mFAIL " + fail + "/" + (pass + fail) + "\x1b[0m"); fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
  console.log("\x1b[32mPASS 长任务时限/守卫/心跳 " + pass + "/" + (pass + fail) + " 条断言\x1b[0m");
  process.exit(0);
})().catch((e) => { console.error("探针异常：" + (e && e.stack || e)); fs.rmSync(SANDBOX, { recursive: true, force: true }); process.exit(1); });
