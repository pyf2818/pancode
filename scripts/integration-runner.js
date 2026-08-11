/* ============================================================
   集成测试编排：自起服务 → 跑 integration 组脚本 → 杀服务
   组：_verify_ws_chat（WS端到端） / _verify_vendor（静态资源） / _verify_sediment（会话沉淀）
   服务用独立端口（PANCODE_TEST_PORT），避免与用户运行中的 8766 冲突
   ============================================================ */
"use strict";
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const root = path.join(__dirname, "..");

const PORT = 8795;
const WAIT_MS = 8000;

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, Object.assign({ cwd: root, stdio: "inherit" }, opts));
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(cmd + " 退出码 " + code))));
    c.on("error", reject);
  });
}

(async () => {
  console.log("[integration] 启动测试服务 (PORT=" + PORT + ") ...");
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), AGENT_FAST: "1", CURSORWEB_ENGINE: "demo",
      CURSORWEB_WORKSPACE: "workspace",
      PANCODE_TEST_PORT: String(PORT),
    }),
    stdio: ["ignore", "pipe", "inherit"],
  });
  let booted = false;
  server.stdout.on("data", (b) => {
    if (!booted && String(b).includes("已启动")) booted = true;
  });

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("服务启动超时")), 10000);
      const check = setInterval(() => { if (booted) { clearInterval(check); clearTimeout(t); resolve(); } }, 300);
    });
    console.log("[integration] 服务已启动");

    const scripts = ["_verify_ws_chat.js", "_verify_vendor.js", "_verify_sediment.js"];
    for (const s of scripts) {
      console.log("\n[integration] === " + s + " ===");
      await run(process.execPath, [path.join(__dirname, s)], { env: Object.assign({}, process.env, { PANCODE_TEST_PORT: String(PORT) }) });
    }
    console.log("\n[integration] ALL PASS：集成测试全部通过");
    process.exit(0);
  } catch (e) {
    console.error("[integration] FAIL: " + e.message);
    process.exit(1);
  } finally {
    server.kill();
  }
})();