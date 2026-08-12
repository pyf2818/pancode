/* ============================================================
   pancode · 本地 Agent 检测与一键调用（server/agents.js）
   ------------------------------------------------------------
   检测本机 PATH 上已安装的 AI 编程 Agent CLI（Claude Code / Codex /
   Gemini CLI / Aider），并提供「一键在终端启动并进入当前工作区」能力。
   纯本地工具，无外部依赖；launch 仅在本机新开终端窗口运行用户已安装的 CLI。
   ============================================================ */
"use strict";
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");

/* 已知 Agent CLI：cmd 用于检测与启动，name 用于展示 */
const AGENTS = [
  { id: "claude", cmd: "claude", name: "Claude Code" },
  { id: "codex", cmd: "codex", name: "OpenAI Codex" },
  { id: "gemini", cmd: "gemini", name: "Gemini CLI" },
  { id: "aider", cmd: "aider", name: "Aider" },
];

/* 跨平台 which：返回可执行文件绝对路径或 null */
function which(cmd) {
  try {
    const probe = os.platform() === "win32" ? "where" : "command -v";
    const out = require("child_process")
      .execSync(`${probe} ${cmd}`, { windowsHide: true, timeout: 5000 })
      .toString()
      .trim();
    const line = out.split(/\r?\n/)[0];
    return line || null;
  } catch (e) {
    return null;
  }
}

/* 检测全部已知 Agent 的安装状态。
   pathsMap（可选）：{ claude:/abs/path, codex:..., gemini:..., aider:... }
   若某个 Agent 配置了有效的全局绝对路径，则优先使用该路径（即使不在 PATH 上）。 */
function detectAgents(pathsMap) {
  const paths = (pathsMap && typeof pathsMap === "object") ? pathsMap : {};
  return AGENTS.map((a) => {
    let bin = null;
    const cfgPath = paths[a.id];
    if (cfgPath && typeof cfgPath === "string" && cfgPath.trim()) {
      const p = cfgPath.trim();
      try { if (fs.existsSync(p)) bin = p; } catch (e) {}
    }
    if (!bin) bin = which(a.cmd);   // 退回到 PATH 探测
    return { id: a.id, cmd: a.cmd, name: a.name, installed: !!bin, path: bin || null };
  });
}

/* 在当前工作区启动指定 Agent（新开终端窗口，不阻塞服务端进程）。
   execPath：已解析的可执行路径（配置的绝对路径或 PATH 上的命令）；path 可能含空格，统一加引号。 */
function launchAgent(execPath, cwd) {
  const platform = os.platform();
  const work = cwd || process.cwd();
  const bin = `"${execPath}"`;
  try {
    if (platform === "win32") {
      // 新开 cmd 窗口：先 cd 到工作区再运行 agent（/k 保持窗口）
      spawn("cmd.exe", ["/c", "start", "cmd", "/k", `cd /d "${work}" && ${bin}`], {
        detached: true, windowsHide: false, stdio: "ignore",
      });
    } else if (platform === "darwin") {
      const script = `tell app "Terminal" to do script "cd '${work}' && ${bin}"`;
      spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
    } else {
      const term = which("gnome-terminal") ? "gnome-terminal" : which("xterm") ? "xterm" : null;
      if (term) spawn(term, ["--", "bash", "-c", `cd "${work}" && ${bin}; exec bash`], { detached: true, stdio: "ignore" });
      else spawn("bash", ["-c", `cd "${work}" && ${bin}; exec bash`], { detached: true, stdio: "ignore" });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { detectAgents, launchAgent, AGENTS };
