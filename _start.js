/* detached 后台启动：spawn server/index.js 后父进程立即退出，
   服务进程独立存活（Windows 下规避 Start-Process 子进程被回收的问题）。
   日志写入 _srv.log / _srv.err（已 .gitignore）。 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = __dirname;
const entry = path.join(root, "server", "index.js");
const out = fs.openSync(path.join(root, "_srv.log"), "a");
const err = fs.openSync(path.join(root, "_srv.err"), "a");

const child = spawn(process.execPath, [entry], {
  cwd: root,
  detached: true,
  stdio: ["ignore", out, err],
  windowsHide: true,
});
child.unref();
console.log("[pancode] 已后台启动 (pid " + child.pid + ")，日志: _srv.log / _srv.err");