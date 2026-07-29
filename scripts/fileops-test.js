/* ============================================================
   v2.0 文件操作协议测试：
   create → save → rename → search → delete → reset 全链路
   运行：npm run test:fileops
   ============================================================ */
"use strict";
const { spawn } = require("child_process");
const path = require("path");

const PORT = 8791;
const root = path.join(__dirname, "..");

function log(s) { console.log("[fileops] " + s); }
function fail(s) { console.error("[fileops] FAIL: " + s); process.exit(1); }

(async () => {
  log("启动测试服务 (PORT=" + PORT + ") ...");
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), AGENT_FAST: "1", CURSORWEB_ENGINE: "demo",
      CURSORWEB_WORKSPACE: "workspace",   // 强制用自带演示夹具，不受用户打开的文件夹影响
    }),
  });
  server.stderr.on("data", (b) => process.stderr.write("[server] " + b));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 10000);
    server.stdout.on("data", (b) => { if (String(b).includes("已启动")) { clearTimeout(timer); resolve(); } });
  }).catch((e) => fail(e.message));

  const health = await fetch("http://localhost:" + PORT + "/api/health").then((r) => r.json());
  const pkgVersion = require("../package.json").version;
  if (!health.ok || health.version !== pkgVersion) fail("health 异常: " + JSON.stringify(health));
  log("health OK, engine=" + health.engine.mode);

  const WebSocket = require("ws");
  const ws = new WebSocket("ws://localhost:" + PORT);
  let files = {};
  const waiters = [];
  ws.on("message", (raw) => {
    const ev = JSON.parse(raw.toString());
    if (ev.type === "hello" || ev.type === "fs.sync") files = ev.files;
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(ev)) { waiters[i].resolve(ev); waiters.splice(i, 1); }
    }
  });
  const waitFor = (match, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("等待事件超时")), ms || 5000);
    waiters.push({ match, resolve: (ev) => { clearTimeout(t); resolve(ev); } });
  });
  const send = (o) => ws.send(JSON.stringify(o));

  await waitFor((ev) => ev.type === "hello");
  log("hello 收到，共 " + Object.keys(files).length + " 个文件");

  // 1. 创建
  send({ type: "file.create", path: "tmp/hello.js", content: "// v2 test\n" });
  await waitFor((ev) => ev.type === "fs.sync" && ev.files["tmp/hello.js"]);
  if (files["tmp/hello.js"].content !== "// v2 test\n") fail("create 内容不符");
  if (!files["tmp/hello.js"].isNew) fail("新文件应标记 isNew");
  log("create OK（含 isNew 标记）");

  // 2. 保存（编辑器写盘）
  send({ type: "file.save", path: "tmp/hello.js", content: "console.log('saved');\n" });
  await waitFor((ev) => ev.type === "file.saved" && ev.path === "tmp/hello.js");
  log("save OK");

  // 3. 重命名
  send({ type: "file.rename", path: "tmp/hello.js", newPath: "tmp/world.js" });
  await waitFor((ev) => ev.type === "fs.sync" && ev.files["tmp/world.js"] && !ev.files["tmp/hello.js"]);
  if (files["tmp/world.js"].content !== "console.log('saved');\n") fail("rename 后内容丢失");
  log("rename OK");

  // 4. 服务端搜索
  send({ type: "search", query: "saved" });
  const sr = await waitFor((ev) => ev.type === "search.result");
  if (!sr.results.some((r) => r.path === "tmp/world.js")) fail("搜索未命中新文件");
  log("search OK（" + sr.results.length + " 处命中）");

  // 5. 路径逃逸防护
  send({ type: "file.save", path: "../evil.txt", content: "x" });
  const err = await waitFor((ev) => ev.type === "op.error");
  if (!/越界/.test(err.error)) fail("路径逃逸未被拦截: " + err.error);
  log("路径防逃逸 OK");

  // 6. 删除 + 还原
  send({ type: "file.delete", path: "tmp/world.js" });
  await waitFor((ev) => ev.type === "fs.sync" && !ev.files["tmp/world.js"]);
  log("delete OK");
  send({ type: "reset" });
  await waitFor((ev) => ev.type === "agent.reset");
  log("reset OK");

  ws.close();
  server.kill();
  log("PASS: 文件操作协议全链路验证成功");
  process.exit(0);
})().catch((e) => fail(e.stack));
