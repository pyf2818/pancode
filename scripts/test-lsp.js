/* LSP 桥接层测试：
   1) LSP stdio 分帧编解码（含半包/粘包）
   2) 端到端：前端 WS -> 桥接 -> mock 语言服务器 -> 诊断/补全 回传
*/
"use strict";
const assert = require("assert");
const http = require("http");
const path = require("path");
const { WebSocket } = require("ws");
const { LspManager, LspParser, encodeLsp } = require("../server/lsp-bridge");
const auth = require("../server/auth");

let pass = 0;
function ok(name) { console.log("  ✓ " + name); pass++; }

/* ---------- 1) 分帧编解码 ---------- */
(function testFraming() {
  const p = new LspParser();
  const got = [];
  p.onMessage = (m) => got.push(m);
  // 粘包：两条消息连在一起
  const a = { jsonrpc: "2.0", id: 1, method: "initialize" };
  const b = { jsonrpc: "2.0", method: "window/logMessage", params: { message: "hi" } };
  p.push(Buffer.concat([encodeLsp(a), encodeLsp(b)]));
  assert.strictEqual(got.length, 2, "粘包应解析出 2 条");
  assert.strictEqual(got[0].id, 1);
  assert.strictEqual(got[1].method, "window/logMessage");
  // 半包：一条消息分两次到达
  const c = { jsonrpc: "2.0", id: 2, result: { ok: true } };
  const full = encodeLsp(c);
  const part1 = full.slice(0, 10), part2 = full.slice(10);
  p.push(part1); assert.strictEqual(got.length, 2, "半包第一段不应解析出消息");
  p.push(part2); assert.strictEqual(got.length, 3, "半包补齐后应解析出第 3 条");
  assert.strictEqual(got[2].id, 2);
  ok("LSP 分帧编解码（粘包/半包）");
})();

/* ---------- 2) 端到端桥接 ---------- */
(async function testBridge() {
  const reg = auth.register("lsp_test", "test1234");
  const { token } = auth.login("lsp_test", "test1234");

  const cfg = { lsp: { enabled: true, servers: { mock: { command: process.execPath, args: [path.join(__dirname, "_mock_lsp.js")], enabled: true } } } };
  const mgr = new LspManager(cfg);
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => mgr.handleUpgrade(req, socket, head));

  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/lsp?lang=mock&root=%2Ftmp&token=${encodeURIComponent(token)}`);
  const env = [];           // 收到的 {type, ...} 信封
  const msgs = [];          // 其中的 LSP msg
  let initResolved = false, diagGot = false, compGot = false;

  await new Promise((res, rej) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "lsp.send", msg: { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: "file:///tmp", capabilities: {} } } }));
    });
    ws.on("message", (raw) => {
      const e = JSON.parse(raw.toString());
      env.push(e);
      if (e.type === "lsp.msg" && e.msg) {
        msgs.push(e.msg);
        if (e.msg.id === 1 && e.msg.result) initResolved = true;
        if (e.msg.method === "textDocument/publishDiagnostics") diagGot = true;
      }
      // 收到 initialize 响应后，再发 initialized 触发诊断，并发起一次补全
      if (initResolved && !ws._sentFollowup) {
        ws._sentFollowup = true;
        ws.send(JSON.stringify({ type: "lsp.send", msg: { jsonrpc: "2.0", method: "initialized", params: {} } }));
        ws.send(JSON.stringify({ type: "lsp.send", msg: { jsonrpc: "2.0", id: 2, method: "textDocument/completion", params: { textDocument: { uri: "file:///mock/x.py" }, position: { line: 0, character: 0 } } } }));
      }
      if (e.type === "lsp.msg" && e.msg && e.msg.id === 2 && e.msg.result) compGot = true;
      if (initResolved && diagGot && compGot) res();
    });
    ws.on("error", rej);
    setTimeout(() => rej(new Error("超时：未收到完整的 LSP 交互")), 6000);
  });

  assert.ok(initResolved, "应收到 initialize 响应");
  assert.ok(diagGot, "应收到 publishDiagnostics 推送");
  assert.ok(compGot, "应收到 completion 响应");
  ok("端到端桥接：initialize + 诊断推送 + 补全 全链路打通");

  ws.close(); server.close();
  // 清理测试用户
  try { require("fs").unlinkSync(path.join(__dirname, "..", ".pancode", "users.json")); } catch (e) {}
  console.log(`\nLSP 测试通过：${pass} 项 ✅`);
  process.exit(0);
})().catch((e) => { console.error("LSP 测试失败:", e); process.exit(1); });
