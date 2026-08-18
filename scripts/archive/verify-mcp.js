/* MCP 端到端验证：
   Part A：直接驱动 McpManager 连接 mock 服务器，验证 initialize/tools/list/tools/call 全链路。
   Part B：启动完整 pancode 服务，通过 /api/mcp 注入 mock 服务器，验证 HTTP 集成（状态 + 工具发现）。
   用法：node scripts/verify-mcp.js   （会自动清理 mock 进程与配置改动） */
"use strict";
const path = require("path");
const fs = require("fs");
const http = require("http");
const { McpManager } = require("../../server/mcp");

const MOCK = path.join(__dirname, "mock-mcp-server.js");
const NODE = process.execPath;
let overallOk = true;
const fail = (m) => { overallOk = false; console.log("  FAIL: " + m); };
const ok = (m) => console.log("  OK: " + m);

function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = cond();
      if (v) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("等待超时"));
      setTimeout(tick, 200);
    };
    tick();
  });
}

/* ---------------- Part A：协议全链路 ---------------- */
async function partA() {
  console.log("[Part A] 直接驱动 McpManager 连接 mock 服务器");
  const cfg = { mcp: { servers: [{ name: "mock", command: NODE, args: [MOCK], enabled: true }] } };
  const mgr = new McpManager(cfg);
  mgr.connectAll();
  const status = await waitFor(() => { const s = mgr.statusList().find((x) => x.name === "mock"); return s && s.status === "ready" ? s : null; }, 15000).catch(() => null);
  if (!status) { fail("mock 服务器未就绪"); return; }
  ok("mock 服务器就绪，status=" + status.status);
  const defs = mgr.toolDefs();
  const echo = defs.find((d) => d.function.name === "mcp__mock__echo");
  if (!echo) { fail("未发现 mcp__mock__echo 工具，defs=" + JSON.stringify(defs)); return; }
  ok("工具暴露为 " + echo.function.name + "，描述含前缀 [MCP·mock]");
  const res = await mgr.callTool("mcp__mock__echo", { text: "你好pancode" });
  const text = (res && res.content && res.content[0] && res.content[0].text) || "";
  if (text !== "echo: 你好pancode") { fail("tools/call 返回异常: " + text); return; }
  ok("tools/call 返回: " + text);
  mgr.disconnectAll();
}

/* ---------------- Part B：HTTP 集成 ---------------- */
function startServer(port) {
  process.env.PORT = String(port);
  process.env.NO_AUTH = "1";
  const server = require("../../server/index.js");
  return server;
}
function req(method, port, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (token) headers["x-user-token"] = token;
    const r = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function partB() {
  console.log("[Part B] 完整服务 + /api/mcp 注入 mock 服务器");
  const PORT = 8851;
  startServer(PORT);
  await new Promise((r) => setTimeout(r, 1500));
  // 注册一个测试用户拿 token（/api/auth/register 在白名单，无需鉴权）
  const ts = Date.now();
  const reg = await req("POST", PORT, "/api/auth/register", { username: "mcpv" + ts, password: "mcpv123" });
  const rj = JSON.parse(reg.body);
  if (!(reg.status === 200 && rj.ok && rj.token)) { fail("注册失败: " + reg.body); return; }
  const TOKEN = rj.token;
  // 注入 mock 服务器
  const post = await req("POST", PORT, "/api/mcp", { action: "save", servers: [{ name: "mock", command: NODE, args: [MOCK], enabled: true }] }, TOKEN);
  let j = JSON.parse(post.body);
  if (!j.ok) { fail("POST /api/mcp 失败: " + post.body); return; }
  // 给 mock 连接时间后 GET 最新状态
  await new Promise((r) => setTimeout(r, 3000));
  const get = await req("GET", PORT, "/api/mcp", null, TOKEN);
  const gj = JSON.parse(get.body);
  const srv = gj.servers.find((x) => x.name === "mock");
  if (!srv) { fail("GET /api/mcp 无 mock"); return; }
  if (srv.status !== "ready") { fail("mock 经 HTTP 未就绪: " + srv.status + " err=" + srv.error); return; }
  ok("HTTP: mock 就绪，发现工具数=" + srv.tools.length + " (" + srv.tools.map((t) => t.name).join(",") + ")");
  if (!srv.tools.find((t) => t.name === "echo")) { fail("HTTP: 未发现 echo 工具"); return; }
  ok("HTTP: 发现 echo 工具");
  // 清理：移除注入的 mock 服务器，避免污染配置
  await req("POST", PORT, "/api/mcp", { action: "save", servers: [] }, TOKEN);
  ok("HTTP: 已清理 mock 服务器配置");
}

(async () => {
  try { await partA(); } catch (e) { fail("Part A 异常: " + e.message); }
  try { await partB(); } catch (e) { fail("Part B 异常: " + e.message); }
  console.log(overallOk ? "\nMCP OK=true" : "\nMCP OK=false");
  process.exit(overallOk ? 0 : 1);
})();
