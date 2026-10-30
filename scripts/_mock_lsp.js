/* 用于 LSP 桥接测试的 mock 语言服务器（stdio + LSP JSON-RPC）。
   仅实现测试所需的最小子集：initialize / initialized / completion / shutdown / exit。 */
"use strict";
let buf = Buffer.alloc(0);
function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  let sep;
  while ((sep = buf.indexOf("\r\n\r\n")) !== -1) {
    const header = buf.slice(0, sep).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) { buf = Buffer.alloc(0); break; }
    const len = parseInt(m[1], 10);
    const start = sep + 4;
    if (buf.length < start + len) break;
    const body = buf.slice(start, start + len).toString("utf8");
    buf = buf.slice(start + len);
    try { handle(JSON.parse(body)); } catch (e) {}
  }
});
function handle(msg) {
  if (msg.id !== undefined && msg.id !== null && msg.method === "initialize") {
    /* _mock 这一段是给 scripts/test-lsp.js 看的"子进程现场"：
       它收到的 rootUri/rootPath 是不是桥接层重写后的授权根、自己的 cwd 落在哪、
       环境里有没有混进 OPENAI_API_KEY / PANCODE_* —— 这些只能由子进程自己报告，
       桥接层里读到的都算"自己说自己对"。 */
    const p = msg.params || {};
    send({ jsonrpc: "2.0", id: msg.id, result: {
      capabilities: { textDocumentSync: 1, hoverProvider: true, completionProvider: { triggerCharacters: ["."] }, definitionProvider: true },
      _mock: {
        rootUri: p.rootUri || null,
        rootPath: p.rootPath || null,
        folders: Array.isArray(p.workspaceFolders) ? p.workspaceFolders.map((f) => f.uri) : null,
        cwd: process.cwd(),
        leakedApiKey: process.env.OPENAI_API_KEY || "",
        leakedSecrets: Object.keys(process.env).filter((k) => /API_?KEY|TOKEN|SECRET/i.test(k)),
        pancodeVars: Object.keys(process.env).filter((k) => /^PANCODE_/i.test(k)),
        hasPath: !!process.env.PATH,
      },
    } });
  } else if (msg.method === "initialized") {
    // 模拟语言服务器主动推送一条诊断
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///mock/x.py", diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: "mock syntax error" }] } });
  } else if (msg.id !== undefined && msg.id !== null && msg.method === "textDocument/completion") {
    send({ jsonrpc: "2.0", id: msg.id, result: { isIncomplete: false, items: [{ label: "mockComp", kind: 1, insertText: "mockComp()" }] } });
  } else if (msg.id !== undefined && msg.id !== null && msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
  } else if (msg.method === "exit") {
    process.exit(0);
  }
}
