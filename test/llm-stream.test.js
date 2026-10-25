/* ============================================================
   llm.js SSE 流式解析器单测 —— 此前只有 classifyLlmError 有直接测试，
   帧解析 / 坏帧跳过 / usage 提取 / tool_calls 增量拼装全靠一条 E2E 兜着。
   全部打真 HTTP 上游（本地起 SSE 服务），不打桩 llm.js —— 打桩它就测不到自己。
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

let tmp;
let chatStream;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmsse-"));
  fs.writeFileSync(path.join(tmp, "pancode.config.json"), JSON.stringify({ workspace: tmp }), "utf8");
  process.env.PANCODE_DATA_DIR = tmp;
  ({ chatStream } = require("../server/llm"));
});
afterAll(() => {
  delete process.env.PANCODE_DATA_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

/* 起一个按脚本应答的 SSE 上游。script 是数组：每次 POST 按序取一个应答器 */
function upstream(scripts) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end", () => {
      try { hits.push(JSON.parse(buf)); } catch (e) { hits.push({ unparseable: buf.slice(0, 100) }); }
      const answer = scripts.shift();
      if (!answer) { res.writeHead(500); return res.end('{"error":"脚本不够用"}'); }
      answer(req, res);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port, hits })));
}
const sse = (res, obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
const chunk = (res, delta, finish) => sse(res, { choices: [{ delta: delta || {}, finish_reason: finish || null }] });
const endOk = (res) => { res.write("data: [DONE]\n\n"); try { res.end(); } catch (e) {} };
const cfgOf = (port) => ({
  baseURL: "http://127.0.0.1:" + port + "/v1", apiKey: "k", model: "m",
  connectTimeout: 15000, idleTimeout: 5000,
});

describe("内容流 / 推理流 / usage 尾包", () => {
  it("onContent 按序收到每一段，尾包 choices 为空时 usage 仍被提取", async () => {
    const u = await upstream([(req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      chunk(res, { reasoning: "想一下" });
      chunk(res, { content: "你" });
      chunk(res, { content: "好" }, "stop");
      sse(res, { choices: [], usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } });
      endOk(res);
    }]);
    try {
      const seen = [];
      const r = await chatStream(cfgOf(u.port), [{ role: "user", content: "hi" }], [],
        { onContent: (t) => seen.push(t), onReasoning: () => {} });
      expect(seen).toEqual(["你", "好"]);
      expect(r.content).toBe("你好");
      expect(r.reasoning).toBe("想一下");
      expect(r.finish).toBe("stop");
      expect(r.usage).toEqual({ prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 });
    } finally { u.srv.close(); }
  });
});

describe("tool_calls 增量拼装", () => {
  it("按 index 分槽、乱序到达按序输出、arguments 分片拼回", async () => {
    const u = await upstream([(req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // index 1 先到、index 0 后到；输出必须仍按 0,1 排
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", type: "function", function: { name: "run_command", arguments: '{"comma' } }] } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'nd":"ls"}' } }] } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.js"' } }] } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] });
      endOk(res);
    }]);
    try {
      const r = await chatStream(cfgOf(u.port), [{ role: "user", content: "go" }], [], {});
      expect(r.toolCalls.map((t) => t.name)).toEqual(["read_file", "run_command"]);
      expect(JSON.parse(r.toolCalls[0].arguments)).toEqual({ path: "a.js" });
      expect(JSON.parse(r.toolCalls[1].arguments)).toEqual({ command: "ls" });
    } finally { u.srv.close(); }
  });

  it("name 在后续 chunk 重发时覆盖而不是拼接（修复前会拼成 read_fileread_file）", async () => {
    const u = await upstream([(req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: '{"path"' } }] } }] });
      // 个别网关每个 chunk 都重发完整 name
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read_file", arguments: ":\"a.js\"}" } }] }, finish_reason: "tool_calls" }] });
      endOk(res);
    }]);
    try {
      const r = await chatStream(cfgOf(u.port), [{ role: "user", content: "go" }], [], {});
      expect(r.toolCalls[0].name).toBe("read_file");
      expect(JSON.parse(r.toolCalls[0].arguments)).toEqual({ path: "a.js" });
    } finally { u.srv.close(); }
  });

  it("arguments 以对象而非字符串到达的网关也能拼（Stringify 后累积）", async () => {
    const u = await upstream([(req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: { path: "a.js" } } }] }, finish_reason: "tool_calls" }] });
      endOk(res);
    }]);
    try {
      const r = await chatStream(cfgOf(u.port), [{ role: "user", content: "go" }], [], {});
      expect(JSON.parse(r.toolCalls[0].arguments)).toEqual({ path: "a.js" });
    } finally { u.srv.close(); }
  });
});

describe("坏帧与半截流", () => {
  it("坏 JSON 帧计数跳过，好帧照常解析", async () => {
    const u = await upstream([(req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      chunk(res, { content: "前半" });
      res.write("data: {\"choices\":[{\"delta\":{\"content\":\"坏\"  \n\n");   // 缺右括号
      chunk(res, { content: "后半" }, "stop");
      endOk(res);
    }]);
    try {
      const r = await chatStream(cfgOf(u.port), [{ role: "user", content: "hi" }], [], {});
      expect(r.content).toBe("前半后半");
      expect(r.parseErrors).toBeGreaterThanOrEqual(1);
    } finally { u.srv.close(); }
  });

  it("流被掐断（无 finish_reason）必须报错，不许当正常完成", async () => {
    const u = await upstream([(req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      chunk(res, { content: "说到一半" });
      setTimeout(() => { try { res.destroy(); } catch (e) {} }, 30);
    }]);
    try {
      await expect(chatStream(cfgOf(u.port), [{ role: "user", content: "hi" }], [], {})).rejects.toThrow();
    } finally { u.srv.close(); }
  });
});

describe("429 限流：按 Retry-After 退避后重试", () => {
  it("第一次 429（Retry-After: 1），重试成功；上游确实收到两次请求", async () => {
    const u = await upstream([
      (req, res) => { res.writeHead(429, { "Retry-After": "1" }); res.end('{"error":"rate"}'); },
      (req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        chunk(res, { content: "好了" }, "stop");
        endOk(res);
      },
    ]);
    try {
      const backoffs = [];
      const r = await chatStream(cfgOf(u.port), [{ role: "user", content: "hi" }], {},
        { onBackoff: (b) => backoffs.push(b) });
      expect(r.content).toBe("好了");
      expect(u.hits.length).toBe(2);
      expect(backoffs.length).toBe(1);
      expect(backoffs[0].attempt).toBe(1);
    } finally { u.srv.close(); }
  }, 15000);
});
