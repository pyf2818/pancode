/* LSP 桥接层测试：
   1) LSP stdio 分帧编解码（含半包/粘包）
   2) 端到端：前端 WS -> 桥接 -> mock 语言服务器 -> 诊断/补全 回传
   3) 审查项 F13 的边界：root 必须是已授权工作区、initialize 里的 rootUri 由桥接层做主、
      子进程环境不带本机凭据。这三条都由 mock 自己回报现场，不在桥接层里自说自话。
*/
"use strict";
/* 数据根必须先指到临时目录再 require auth：auth 的 users.json / sessions.json 取 config.ROOT，
   不设的话这个脚本会把 lsp_test 写进真实仓库的 .pancode/users.json，收尾还整个 unlink 那个文件。 */
const TMP_ROOT = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "pancode-lsp-test-"));
process.env.PANCODE_DATA_DIR = TMP_ROOT;

const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocket } = require("ws");
const { LspManager, LspParser, encodeLsp } = require("../server/lsp-bridge");
const auth = require("../server/auth");

let pass = 0;
function ok(name) { console.log("  ✓ " + name); pass++; }
function bad(name, detail) { console.error("  ✗ " + name + (detail ? " — " + detail : "")); process.exitCode = 1; }

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

/* ---------- 2) 端到端桥接 + F13 边界 ---------- */
(async function testBridge() {
  // register / login 自 A2 起是 async（scrypt 不阻塞事件循环）：漏 await 会拿到 Promise，token=undefined
  const reg = await auth.register("lsp_test", "test1234");
  const logged = reg && reg.ok ? reg : await auth.login("lsp_test", "test1234");
  const token = logged && logged.token;
  if (!token) { console.error("FAIL - 测试账号注册/登录失败:", logged && logged.error); process.exit(1); }

  /* 授权根：只用这一个目录，别的一律不在清单里。
     realpathSync 一次：Windows 的 temp 常是 8.3 短名，拿短名去比真实路径会误判成越界。 */
  const GRANTED_DIR = path.join(TMP_ROOT, "ws");
  fs.mkdirSync(GRANTED_DIR, { recursive: true });
  const GRANTED = fs.realpathSync(GRANTED_DIR);
  const FOREIGN = fs.realpathSync(TMP_ROOT);      // 授权根**的父目录**：一定不在 GRANTED 下面

  /* 本机放一把**假**密钥：老写法是整份 process.env 直接继承，子进程一报就是一个真泄漏。
     值本身无所谓，判据看的是"这个名字有没有出现在子进程里"。 */
  process.env.OPENAI_API_KEY = "sk-probe-must-not-leak";
  process.env.PANCODE_PROBE_FAKE = "1";

  const cfg = { lsp: { enabled: true, servers: { mock: { command: process.execPath, args: [path.join(__dirname, "_mock_lsp.js")], enabled: true } } } };
  const mgr = new LspManager(cfg, {
    findRoot: (p) => (p && p.replace(/[\\/]+$/, "").toLowerCase() === GRANTED.toLowerCase() ? { path: GRANTED, writable: true } : null),
    defaultRoot: () => GRANTED,
  });
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => mgr.handleUpgrade(req, socket, head));

  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;

  /* 令牌走 Sec-WebSocket-Protocol，与 public/js/lsp-client.js 同一个路径（C-B2）：
     /lsp 的 handleUpgrade 默认已不收 ?token=，挂 query 会被直接 socket.destroy()。 */
  const url = (root) => `ws://127.0.0.1:${port}/lsp?lang=mock&root=${encodeURIComponent("file:///" + GRANTED.replace(/\\/g, "/"))}${root ? "&x=" + root : ""}`;
  const env = [];           // 收到的 {type, ...} 信封
  const msgs = [];          // 其中的 LSP msg
  let initResolved = false, diagGot = false, compGot = false, initResult = null;

  /* 客户端故意把 rootUri 写成 C:/Windows：桥接层要把它按**已授权的 root** 重写，
     语言服务器扫到的范围才真的等于授权范围（F13）。 */
  const evilUri = "file:///C:/Windows";
  const ws = new WebSocket(url(), ["bearer." + encodeURIComponent(token)]);
  await new Promise((res, rej) => {
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "lsp.send", msg: { jsonrpc: "2.0", id: 1, method: "initialize", params: { rootUri: evilUri, capabilities: {} } } }));
    });
    ws.on("message", (raw) => {
      const e = JSON.parse(raw.toString());
      env.push(e);
      if (e.type === "lsp.msg" && e.msg) {
        msgs.push(e.msg);
        if (e.msg.id === 1 && e.msg.result) { initResolved = true; initResult = e.msg.result; }
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
    setTimeout(() => rej(new Error("超时：未收到完整的 LSP 交互")), 8000);
  });

  assert.ok(initResolved, "应收到 initialize 响应");
  assert.ok(diagGot, "应收到 publishDiagnostics 推送");
  assert.ok(compGot, "应收到 completion 响应");
  ok("端到端桥接：initialize + 诊断推送 + 补全 全链路打通");

  /* ---- F13：三条边界判据，全部读 mock 自己回报的现场 ---- */
  const m = (initResult && initResult._mock) || {};
  const norm = (s) => String(s || "").replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  const grantedUriNorm = norm("file:///" + GRANTED.replace(/\\/g, "/"));

  if (!m.rootUri) bad("initialize 的 rootUri 由桥接层重写为授权根", "mock 没回报 _mock 现场（脚本与 mock 版本不匹配）");
  else {
    ok("客户端把 rootUri 写成 C:/Windows，语言服务器收到的是被重写后的授权根",
      norm(m.rootUri) === grantedUriNorm, "实际：" + m.rootUri);
    ok("workspaceFolders 也一起钉住（只留授权根那一条）",
      Array.isArray(m.folders) && m.folders.length === 1 && norm(m.folders[0]) === grantedUriNorm,
      JSON.stringify(m.folders));
    ok("rootPath 是授权根的本地路径",
      !!m.rootPath && norm(m.rootPath) === norm(GRANTED), "实际：" + m.rootPath);
  }
  ok("子进程 cwd 落在授权根里（不再是 process.cwd()/客户端路径）",
    !!m.cwd && norm(m.cwd).indexOf(norm(GRANTED)) === 0, "cwd=" + m.cwd);

  /* 环境：本机故意放一把假密钥，子进程报回来里有就是泄漏。 */
  const leaked = (m.leakedSecrets || []).concat(m.leakedApiKey ? ["OPENAI_API_KEY"] : []);
  ok("语言服务器子进程没有继承本机凭据（OPENAI_API_KEY / *TOKEN* / *SECRET*）",
    leaked.length === 0, "泄漏：" + leaked.join(","));
  ok("也没有把 PANCODE_* 数据根/探针开关带进去",
    (m.pancodeVars || []).length === 0, "带进去的：" + (m.pancodeVars || []).join(","));
  ok("摘凭据的同时没把 PATH 摘掉（全摘光=语言服务器起不来，那是另一种回归）",
    m.hasPath === true, "hasPath=" + m.hasPath);

  ws.close();

  /* ---- F13：授权范围外的 root 直接被拒，且不spawn ---- */
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/lsp?lang=mock&root=${encodeURIComponent("file:///" + FOREIGN.replace(/\\/g, "/"))}`,
    ["bearer." + encodeURIComponent(token)]);
  const env2 = [];
  await new Promise((res) => {
    ws2.on("message", (raw) => { env2.push(JSON.parse(raw.toString())); });
    ws2.on("close", res);
    ws2.on("error", res);
    setTimeout(res, 3000);
  });
  const err2 = env2.find((e) => e.type === "lsp.error");
  ok("未授权的 root：连接被拒绝并给出可读原因", !!err2 && /已授权/.test(err2.message || ""),
    JSON.stringify(env2).slice(0, 200));
  ok("未授权的 root：没有任何 lsp.ready（= 没起语言服务器）", !env2.some((e) => e.type === "lsp.ready"),
    JSON.stringify(env2).slice(0, 200));

  try { ws.close(); } catch (e) {}
  try { ws2.close(); } catch (e) {}
  server.close();
  await new Promise((r) => setTimeout(r, 300));   // 让 mock 子进程收完 SIGTERM 再删临时目录
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) {}
  if (process.exitCode) { console.error("\nLSP 测试有失败项 ❌"); process.exit(1); }
  console.log(`\nLSP 测试通过：${pass} 项 ✅`);
  process.exit(0);
})().catch((e) => { console.error("LSP 测试失败:", e); process.exit(1); });
