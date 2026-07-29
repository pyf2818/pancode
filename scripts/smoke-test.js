/* ============================================================
   端到端烟测：启动服务 → WebSocket 触发 Agent → 断言完整闭环
   运行：npm run smoke
   ============================================================ */
"use strict";
const { spawn } = require("child_process");
const path = require("path");

const PORT = 8790;
const root = path.join(__dirname, "..");

function log(s) { console.log("[smoke] " + s); }
function fail(s) { console.error("[smoke] FAIL: " + s); process.exit(1); }

(async () => {
  log("启动测试服务 (AGENT_FAST=1, PORT=" + PORT + ") ...");
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
    server.stdout.on("data", (b) => {
      if (String(b).includes("已启动")) { clearTimeout(timer); resolve(); }
    });
  }).catch((e) => fail(e.message));
  log("服务已启动");

  const WebSocket = require("ws");
  const ws = new WebSocket("ws://localhost:" + PORT);

  const seen = { toolTerminalOk: false, toolFail: false, changes: 0, done: false, testPassLine: false };

  ws.on("open", () => {
    log("WebSocket 已连接，发送重置 + 演示任务");
    ws.send(JSON.stringify({ type: "reset" }));
    setTimeout(() => ws.send(JSON.stringify({ type: "chat", text: "修复筛选 bug 并支持优先级排序，自己跑测试验证" })), 300);
  });

  ws.on("message", (raw) => {
    const ev = JSON.parse(raw.toString());
    if (ev.type === "tool.end" && ev.ok === false) seen.toolFail = true;
    if (ev.type === "tool.end" && ev.ok && /通过/.test(ev.label || "")) seen.toolTerminalOk = true;
    if (ev.type === "term.line" && /0 失败/.test(ev.text)) seen.testPassLine = true;
    if (ev.type === "changes") seen.changes = ev.list.length;
    if (ev.type === "agent.done") { seen.done = true; finish(); }
  });

  const timeout = setTimeout(() => fail("60 秒内未完成 Agent 闭环"), 60000);

  function finish() {
    clearTimeout(timeout);
    log("Agent 闭环完成，开始断言...");
    if (!seen.toolFail) fail("未观察到首次测试失败（自主修复前置条件）");
    if (!seen.testPassLine) fail("未观察到真实测试全部通过的输出");
    if (seen.changes < 3) fail("改动文件数 " + seen.changes + " < 3");
    log("断言通过: 首次失败 -> 自主修复 -> 复测通过, 改动 " + seen.changes + " 个文件");
    ws.send(JSON.stringify({ type: "reset" }));
    setTimeout(() => {
      ws.close();
      server.kill();
      log("PASS: 端到端闭环验证成功, workspace 已还原");
      process.exit(0);
    }, 500);
  }
})();
