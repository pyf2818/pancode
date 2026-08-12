/* 最小 MCP stdio 服务器（仅用于测试 pancode 的 MCP 客户端）。
   协议：stdin/stdout 上换行分隔的 JSON-RPC 2.0。
   暴露一个工具 echo：把传入 text 原样回显。 */
"use strict";
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function handle(msg) {
  if (msg.id === undefined) return; // 通知（如 notifications/initialized）无需回复
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "回显传入的文本（测试用）", inputSchema: { type: "object", properties: { text: { type: "string", description: "要回显的文本" } }, required: ["text"] } },
    ] } });
  } else if (msg.method === "tools/call") {
    const args = (msg.params && msg.params.arguments) || {};
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo: " + (args.text || "") }], isError: false } });
  }
}
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
