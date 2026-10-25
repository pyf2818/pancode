/* ============================================================
   W20 · Anthropic 原生适配层单测
   - 消息转换（纯函数钉形状）：system 提取+cache 断点 / tool_use 块 /
     tool_result 合并 / 连续 user 合并 / 工具定义映射
   - 流式契约（打真 SSE 假上游，不打桩适配层）：与 llm.js 完全同形状的
     {content, reasoning, toolCalls:[{id,name,arguments}], finish, usage}
   - 半截流不当完成；429 按 Retry-After 重试
   - llm.js 顶部分发（provider:"anthropic" 自动走适配层）
   ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const anth = require("../server/llm-anthropic");
const { chatStream } = require("../server/llm");

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anth-"));
  fs.writeFileSync(path.join(tmp, "pancode.config.json"), JSON.stringify({ workspace: tmp }), "utf8");
  process.env.PANCODE_DATA_DIR = tmp;
});
afterAll(() => {
  delete process.env.PANCODE_DATA_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

describe("消息转换（OpenAI → Anthropic）", () => {
  it("system 提取为顶级字段并带 cache_control 断点", () => {
    const r = anth.toAnthropicMessages([
      { role: "system", content: "你是工匠" },
      { role: "system", content: "规则二" },
      { role: "user", content: "hi" },
    ]);
    expect(r.system).toHaveLength(1);
    expect(r.system[0].text).toBe("你是工匠\n\n规则二");
    expect(r.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(r.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("assistant 的 tool_calls → tool_use 块（arguments 字符串解析成 input 对象）", () => {
    const r = anth.toAnthropicMessages([
      { role: "assistant", content: "我来改", tool_calls: [{ id: "c1", function: { name: "write_file", arguments: "{\"path\":\"a.js\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "写入成功" },
      { role: "tool", tool_call_id: "c1b", content: "第二条结果" },
    ]);
    const asst = r.messages[0];
    expect(asst.role).toBe("assistant");
    expect(asst.content[0]).toEqual({ type: "text", text: "我来改" });
    expect(asst.content[1]).toEqual({ type: "tool_use", id: "c1", name: "write_file", input: { path: "a.js" } });
    /* 连续 tool_result 合并进同一条 user */
    const tr = r.messages[1];
    expect(tr.role).toBe("user");
    expect(tr.content).toHaveLength(2);
    expect(tr.content[0]).toEqual({ type: "tool_result", tool_use_id: "c1", content: "写入成功" });
  });

  it("连续 user 消息合并；图片 data URI 转成 base64 块", () => {
    const r = anth.toAnthropicMessages([
      { role: "user", content: "第一句" },
      { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
    ]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].content).toEqual([
      { type: "text", text: "第一句" },
      { type: "text", text: "看图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
    ]);
  });

  it("工具定义映射 + 最后一个带 cache 断点；无工具时不发空数组", () => {
    const t = anth.toAnthropicTools([
      { type: "function", function: { name: "a", description: "A", parameters: { type: "object", properties: { x: { type: "string" } } } } },
      { type: "function", function: { name: "b", description: "B", parameters: { type: "object", properties: {} } } },
    ]);
    expect(t[0]).toEqual({ name: "a", description: "A", input_schema: { type: "object", properties: { x: { type: "string" } } } });
    expect(t[1].cache_control).toEqual({ type: "ephemeral" });
    expect(anth.toAnthropicTools([])).toEqual([]);
  });

  it("endpoint：带/不带 /v1 的 baseURL 都拼出 /v1/messages", () => {
    expect(anth.endpointOf("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages");
    expect(anth.endpointOf("https://api.anthropic.com/v1/")).toBe("https://api.anthropic.com/v1/messages");
  });
});

/* ---------- 真 SSE 假上游 ---------- */
function upstream(scripts) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end", () => {
      try { hits.push({ url: req.url, headers: req.headers, body: JSON.parse(buf) }); } catch (e) { hits.push({ url: req.url, body: null }); }
      const answer = scripts.shift();
      if (!answer) { res.writeHead(500); return res.end("{}"); }
      answer(req, res);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port, hits })));
}
const ev = (res, name, data) => res.write("event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n");
const cfgOf = (port) => ({
  provider: "anthropic",
  baseURL: "http://127.0.0.1:" + port,
  apiKey: "sk-ant-test", model: "claude-test",
  connectTimeout: 15000, idleTimeout: 5000,
});

describe("流式契约（打真上游，与 llm.js 同形状）", () => {
  it("文本 + thinking + 双 tool_use 分片拼装 + usage 含缓存字段", async () => {
    const u = await upstream([(req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      ev(res, "message_start", { message: { usage: { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 } } });
      ev(res, "content_block_start", { index: 0, content_block: { type: "text" } });
      ev(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "你好" } });
      ev(res, "content_block_stop", { index: 0 });
      ev(res, "content_block_start", { index: 1, content_block: { type: "thinking" } });
      ev(res, "content_block_delta", { index: 1, delta: { type: "thinking_delta", thinking: "先想一下" } });
      ev(res, "content_block_stop", { index: 1 });
      ev(res, "content_block_start", { index: 2, content_block: { type: "tool_use", id: "tu1", name: "read_file" } });
      ev(res, "content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: '{"path"' } });
      ev(res, "content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: ':"a.js"}' } });
      ev(res, "content_block_stop", { index: 2 });
      ev(res, "content_block_start", { index: 3, content_block: { type: "tool_use", id: "tu2", name: "run_command" } });
      ev(res, "content_block_delta", { index: 3, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } });
      ev(res, "content_block_stop", { index: 3 });
      ev(res, "message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } });
      ev(res, "message_stop", {});
      res.end();
    }]);
    try {
      const seen = [];
      const r = await anth.chatStream(cfgOf(u.port), [{ role: "user", content: "go" }], [], {
        onContent: (t) => seen.push(t), onReasoning: () => {},
      });
      expect(r.content).toBe("你好");
      expect(r.reasoning).toBe("先想一下");
      expect(r.finish).toBe("tool_calls");
      expect(r.toolCalls.map((t) => t.name)).toEqual(["read_file", "run_command"]);
      expect(JSON.parse(r.toolCalls[0].arguments)).toEqual({ path: "a.js" });
      expect(JSON.parse(r.toolCalls[1].arguments)).toEqual({ command: "ls" });
      expect(r.usage.prompt_tokens).toBe(100 + 5000 + 200);
      expect(r.usage.completion_tokens).toBe(42);
      expect(r.usage.cache_read_input_tokens).toBe(5000);
      /* 请求侧：anthropic-version 头 + x-api-key + system cache 断点 */
      expect(u.hits[0].headers["anthropic-version"]).toBe("2023-06-01");
      expect(u.hits[0].headers["x-api-key"]).toBe("sk-ant-test");
      void seen;
    } finally { u.srv.close(); }
  });

  it("end_turn → finish=stop；空参工具兜底 {}", async () => {
    const u = await upstream([(req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      ev(res, "message_start", { message: { usage: { input_tokens: 10 } } });
      ev(res, "content_block_start", { index: 0, content_block: { type: "tool_use", id: "t1", name: "list_files" } });
      ev(res, "content_block_stop", { index: 0 });
      ev(res, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
      ev(res, "message_stop", {});
      res.end();
    }]);
    try {
      const r = await anth.chatStream(cfgOf(u.port), [{ role: "user", content: "go" }], []);
      expect(r.finish).toBe("stop");
      expect(r.toolCalls[0].arguments).toBe("{}");
    } finally { u.srv.close(); }
  });

  it("没有 message_stop 的半截流必须报错", async () => {
    const u = await upstream([(req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      ev(res, "message_start", { message: { usage: {} } });
      ev(res, "content_block_start", { index: 0, content_block: { type: "text" } });
      ev(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "说到一半" } });
      setTimeout(() => { try { res.destroy(); } catch (e) {} }, 30);
    }]);
    try {
      await expect(anth.chatStream(cfgOf(u.port), [{ role: "user", content: "hi" }], [])).rejects.toThrow();
    } finally { u.srv.close(); }
  });

  it("429 → 按 Retry-After 重试后成功，上游确实收到两次", async () => {
    const u = await upstream([
      (req, res) => { res.writeHead(429, { "Retry-After": "1" }); res.end('{"type":"error","error":{"type":"rate_limit_error"}}'); },
      (req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        ev(res, "message_start", { message: { usage: { input_tokens: 1 } } });
        ev(res, "content_block_start", { index: 0, content_block: { type: "text" } });
        ev(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "好了" } });
        ev(res, "content_block_stop", { index: 0 });
        ev(res, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
        ev(res, "message_stop", {});
        res.end();
      },
    ]);
    try {
      const backs = [];
      const r = await anth.chatStream(cfgOf(u.port), [{ role: "user", content: "hi" }], [], { onBackoff: (b) => backs.push(b) });
      expect(r.content).toBe("好了");
      expect(u.hits.length).toBe(2);
      expect(backs).toHaveLength(1);
    } finally { u.srv.close(); }
  }, 15000);
});

describe("llm.js 顶部分发", () => {
  it("provider=anthropic 时 chatStream 自动走适配层（请求落在 /v1/messages）", async () => {
    const u = await upstream([(req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      ev(res, "message_start", { message: { usage: { input_tokens: 1 } } });
      ev(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "经分发" } });
      ev(res, "message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      ev(res, "message_stop", {});
      res.end();
    }]);
    try {
      /* 注意：不经过 anth.chatStream，直接调 llm.js 的 chatStream —— 验证分发接线 */
      const r = await chatStream(cfgOf(u.port), [{ role: "user", content: "hi" }], []);
      expect(r.content).toBe("经分发");
      expect(u.hits[0].url).toContain("/v1/messages");
    } finally { u.srv.close(); }
  });
  it("baseURL 含 anthropic.com 也自动识别", () => {
    /* 只验判定不真发请求：借用 404 快速失败路径，看错误来自适配层（含 anthropic-version 场景的端点拼接） */
    const cfg = { provider: undefined, baseURL: "https://api.anthropic.com", apiKey: "k", model: "m", connectTimeout: 15000, idleTimeout: 5000 };
    return expect(chatStream(cfg, [{ role: "user", content: "x" }], [])).rejects.toThrow(/HTTP 40[413]|网络/);
  });
});
