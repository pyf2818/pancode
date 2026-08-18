/* 子项4 端到端 WS 往返验证：
   引擎 emit tool.pending → WS 广播 → 客户端收到 → 客户端回 tool.approve
   → WS 处理器 engine.resolveApproval → execTool 继续 → 文件落盘 / 删除生效
   用内存 mock 的文件层，专注验证「WS 审批往返」这一新集成链路。
*/
"use strict";
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const { LlmAgent } = require("../../server/agent-llm");

// ---- 内存 mock 文件层 ----
const store = {};
const files = {
  exists: (p) => Object.prototype.hasOwnProperty.call(store, p),
  read: (p) => { if (!Object.prototype.hasOwnProperty.call(store, p)) throw new Error("ENOENT: " + p); return store[p]; },
  write: (p, c) => { store[p] = String(c); },
  remove: (p) => { delete store[p]; },
  list: () => Object.keys(store),
  search: () => [],
};
const git = { baseline: () => null, changes: () => [], snapshot: () => {} };
const term = { run: () => Promise.resolve({ code: 0, out: "MOCK", blocked: false, timedOut: false }) };

const TOKEN = "secret-token";
const clients = new Set();
function broadcast(ev) {
  const msg = JSON.stringify(ev);
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

const cfg = { llm: { maxToolRounds: 20 } };
const engine = new LlmAgent({ emit: broadcast, files, git, term, cfg });

const server = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://localhost");
  if (u.searchParams.get("token") !== TOKEN) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.type === "tool.approve" && typeof engine.resolveApproval === "function" && m.id) engine.resolveApproval(m.id, true);
    else if (m.type === "tool.reject" && typeof engine.resolveApproval === "function" && m.id) engine.resolveApproval(m.id, false);
  });
});

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const url = "ws://127.0.0.1:" + port + "/?token=" + TOKEN;
  const client = new WebSocket(url);
  const got = [];
  client.on("message", (d) => { got.push(JSON.parse(d)); });
  client.on("open", async () => {
    try {
      console.log("[RT 1] write_file 经 WS 批准 → 落盘");
      const p1 = engine.execTool("write_file", { path: "rt/a.txt", content: "roundtrip ok" });
      // 客户端收到 tool.pending 后回 approve
      await waitFor(() => got.find((e) => e.type === "tool.pending" && e.tool === "write_file"));
      const pend = got.filter((e) => e.type === "tool.pending" && e.tool === "write_file").pop();
      ok("客户端收到 tool.pending", !!pend);
      client.send(JSON.stringify({ type: "tool.approve", id: pend.id }));
      await p1;
      ok("批准后文件落盘", store["rt/a.txt"] === "roundtrip ok");
      await waitFor(() => got.some((e) => e.type === "tool.end"));
      ok("客户端收到 tool.start", got.some((e) => e.type === "tool.start"));
      ok("客户端收到 tool.end(完成)", got.some((e) => e.type === "tool.end" && e.ok === true));

      console.log("[RT 2] delete_file 经 WS 拒绝 → 保留");
      store["rt/b.txt"] = "keep";
      got.length = 0;
      const p2 = engine.execTool("delete_file", { path: "rt/b.txt" });
      await waitFor(() => got.find((e) => e.type === "tool.pending" && e.tool === "delete_file"));
      const pend2 = got.filter((e) => e.type === "tool.pending" && e.tool === "delete_file").pop();
      client.send(JSON.stringify({ type: "tool.reject", id: pend2.id }));
      await p2;
      ok("拒绝后文件仍存在", store["rt/b.txt"] === "keep");
      await waitFor(() => got.some((e) => e.type === "tool.end"));
      ok("客户端收到 tool.end(失败)", got.some((e) => e.type === "tool.end" && e.ok === false));

      console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
    } catch (e) {
      console.error("测试异常:", e); fail++;
    } finally {
      client.close(); server.close(); process.exit(fail === 0 ? 0 : 1);
    }
  });
  client.on("error", (e) => { console.error("WS 错误:", e.message); process.exit(2); });
});

function waitFor(fn, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fn()) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error("waitFor 超时")); }
    }, 20);
  });
}
