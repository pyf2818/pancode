/* ============================================================
   pancode-cli · 终端命令执行（自包含版）
   - spawn 真实执行
   - 超时控制
   ============================================================ */
"use strict";
const { spawn } = require("child_process");

const IS_WIN = process.platform === "win32";

class TerminalLayer {
  constructor(root) {
    this.root = root;
  }

  run(command, opts) {
    opts = opts || {};
    const timeoutMs = (opts.timeout || 60) * 1000;
    return new Promise((resolve) => {
      let shell, args;
      if (IS_WIN) {
        shell = "cmd.exe";
        args = ["/c", command];
      } else {
        shell = "bash";
        args = ["-c", command];
      }
      const child = spawn(shell, args, {
        cwd: this.root,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch (e) {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, 3000);
      }, timeoutMs);

      child.stdout.on("data", (d) => { stdout += d.toString(); });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          ok: !timedOut && code === 0,
          code: timedOut ? -1 : code,
          stdout: stdout.slice(0, 50000),
          stderr: stderr.slice(0, 20000),
          timedOut,
        });
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, code: -1, stdout: "", stderr: String(e.message), timedOut: false });
      });
    });
  }
}

module.exports = { TerminalLayer };
