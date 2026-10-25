/* ============================================================
   P0 回归 · 子智能体参数解析的形状契约
   ------------------------------------------------------------
   修复前：_runSubAgentInner 按 tc.args 读参数，而 llm.js 返回的
   toolCalls 形状是 {id, name, arguments(字符串)} —— args 字段不存在，
   真实模型驱动下所有工具恒收到 {}，子智能体 12 轮耗尽报失败。
   单测全部没红，是因为子智能体路径的桩也返回了同一个错误形状
   （args: {...}），而主循环路径的桩一直是对的 —— 漂移就这样被遮住。
   这里两头钉死，任何一头变形都会红：
     ① 真 llm.chatStream 打真 SSE 上游（不打桩 llm.js），断言返回形状
        确实是 arguments 字符串、且流式分片拼装正确；
     ② 用该真实形状驱动 _runSubAgentInner，断言工具真拿到解析后的参数
        （修复前这里收到的是 {}）；
     ③ 坏 JSON 不静默成空参：回灌参数解析错误让模型自纠，工具不执行。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

let tmp, dataDir, wsDir;
let LlmAgent, FileStore, chatStream;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p0sub-"));
  dataDir = path.join(tmp, "data");
  wsDir = path.join(tmp, "ws");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "pancode.config.json"), JSON.stringify({ workspace: wsDir }), "utf8");
  process.env.PANCODE_DATA_DIR = dataDir;
  const llm = require("../server/agent-llm");
  LlmAgent = llm.LlmAgent;
  ({ FileStore } = require("../server/files"));
  ({ chatStream } = require("../server/llm"));
});

afterAll(() => {
  delete process.env.PANCODE_DATA_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

/** 造一个能跑 runSubAgent 的裸对象（与 p5-sub-parallel 同款装配） */
function mkAgent() {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = { llm: { contextWindow: 128000 }, permissions: { mode: "auto" }, memory: { enabled: false }, timeouts: { toolSec: 120 } };
  a.files = new FileStore(wsDir);
  a.staged = [];
  a.emitted = [];
  a.applied = [];
  a.patch = { stage: (conv, args) => { a.staged.push(args); return { ok: true, staged: [{ path: args.path }] }; } };
  a.emit = (m) => a.emitted.push(m);
  a._traceEvent = () => {};
  a._currentConv = "default";
  a._abort = false;
  a.fileChanged = () => {};
  a.experts = null;
  a.tool = () => ({ body() {}, image() {}, done() {}, end() {}, delta() {}, start() {} });
  a.state = () => {};
  a.say = async () => {};
  a.thinkStart = () => ({});
  a.msgStart = () => ({});
  a._runToolGuarded = async (name, args) => {
    a.applied.push({ name, args });
    if (name === "write_file") { a.files.write(args.path, args.content); return "已写入 " + args.path; }
    return "(桩 " + name + ")";
  };
  return a;
}

describe("① llm.chatStream 的 toolCalls 形状契约（真 SSE 上游，不打桩）", () => {
  it("流式分片拼装后返回 {id,name,arguments:JSON字符串}——子智能体消费的就是这个形状", async () => {
    const argJson = JSON.stringify({ path: "ok.js", content: "子智能体真参数" });
    const parts = [argJson.slice(0, 12), argJson.slice(12, 30), argJson.slice(30)]; // 故意切三段
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const sse = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file", arguments: parts[0] } }] } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: parts[1] } }] } }] });
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: parts[2] } }] }, finish_reason: "tool_calls" }] });
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const r = await chatStream(
        { baseURL: "http://127.0.0.1:" + srv.address().port + "/v1", apiKey: "k", model: "m", connectTimeout: 15000, idleTimeout: 5000 },
        [{ role: "user", content: "hi" }], [], {}
      );
      expect(r.toolCalls).toHaveLength(1);
      const tc = r.toolCalls[0];
      expect(tc.name).toBe("write_file");
      expect(typeof tc.arguments).toBe("string");   // 形状契约：arguments 是 JSON 字符串
      expect(JSON.parse(tc.arguments)).toEqual({ path: "ok.js", content: "子智能体真参数" });
    } finally {
      srv.close();
    }
  });
});

describe("② 真实形状驱动子智能体（修复前工具恒收到 {}）", () => {
  it("工具拿到解析后的参数并真实落盘", async () => {
    const a = mkAgent();
    let n = 0;
    a._chatStream = async () => {
      n++;
      if (n === 1) return { content: "", toolCalls: [{ id: "s1", name: "write_file", arguments: JSON.stringify({ path: "ok.js", content: "真实形状驱动" }) }] };
      return { content: "子智能体完成" };
    };
    const report = {};
    await a.runSubAgent("写 ok.js", { report });
    expect(a.applied).toEqual([{ name: "write_file", args: { path: "ok.js", content: "真实形状驱动" } }]);
    expect(a.staged.map((s) => s.path)).toContain("ok.js"); // 改动被收回并暂存待审阅
  });

  it("assistant 回传的 arguments 原样透传（不 stringify 两遍）", async () => {
    const a = mkAgent();
    const raw = JSON.stringify({ path: "echo.js", content: "x" });
    let seen = null;
    a._chatStream = async (messages) => {
      const asst = [...messages].reverse().find((m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length);
      if (asst) seen = asst.tool_calls[0].function.arguments;
      a.n = (a.n || 0) + 1;
      if (a.n === 1) return { content: "", toolCalls: [{ id: "e1", name: "write_file", arguments: raw }] };
      return { content: "完成" };
    };
    await a.runSubAgent("回传", {});
    expect(seen).toBe(raw); // 字符串透传；修复前这里恒为 "{}"
  });
});

describe("③ 坏 JSON 不静默成空参", () => {
  it("解析失败回灌错误给模型，工具不执行", async () => {
    const a = mkAgent();
    const toolMsgs = [];
    a._chatStream = async (messages) => {
      for (const m of messages) if (m.role === "tool") toolMsgs.push(m.content);
      a.n = (a.n || 0) + 1;
      if (a.n === 1) return { content: "", toolCalls: [{ id: "b1", name: "write_file", arguments: '{"path": ' }] };
      return { content: "收到纠错" };
    };
    await a.runSubAgent("坏参数", {});
    expect(a.applied).toEqual([]);                          // 工具从未被执行
    expect(toolMsgs.join("\n")).toContain("参数解析失败");   // 错误确实回灌给了模型
  });
});
