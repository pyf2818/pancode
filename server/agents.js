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

/* 非交互式调用本机已安装的 Agent CLI，把任务结果返回给 pancode 的主 Agent（联立进 Agent 循环）。
   - agentId: claude / codex / gemini / aider
   - task: 交给该 CLI 的 prompt（在当前工作区目录运行）
   - cwd: 工作区目录
   - pathsMap: 可选的绝对路径配置（同 detectAgents）
   返回 Promise<{ ok, code, output, error }>。未安装 / 启动失败 / 超时都会以 ok:false 返回，绝不抛异常。 */
function runAgent(agentId, task, cwd, pathsMap) {
  const detected = detectAgents(pathsMap);
  const rec = detected.find((x) => x.id === agentId);
  if (!rec || !rec.installed || !rec.path) {
    return Promise.resolve({
      ok: false,
      error: "本地 Agent「" + agentId + "」未安装（侧边栏「本地 Agent」可检测；请在 PATH 或设置里配置绝对路径后重试）",
    });
  }
  // 各 CLI 的非交互调用 flag（一次性把 task 作为 prompt 传入，不进入交互 TUI）
  const FLAGS = { claude: ["-p"], codex: ["exec"], gemini: ["-p"], aider: ["--message"] };
  const flags = FLAGS[agentId] || ["-p"];
  const argList = [...flags, task];
  const work = cwd || process.cwd();
  return new Promise((resolve) => {
    let proc;
    try {
      if (os.platform() === "win32") {
        // Windows 下 npm 全局装的 CLI 多为 .cmd，必须经 cmd /c 解析
        const line = `"${rec.path}" ${argList.map(quoteArg).join(" ")}`;
        proc = spawn("cmd.exe", ["/c", line], { cwd: work, windowsHide: true, env: process.env });
      } else {
        proc = spawn(rec.path, argList, { cwd: work, env: process.env });
      }
    } catch (e) {
      return resolve({ ok: false, error: "启动失败: " + e.message });
    }
    let out = "", err = "";
    if (proc.stdout) proc.stdout.on("data", (d) => (out += d));
    if (proc.stderr) proc.stderr.on("data", (d) => (err += d));
    const to = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (e) {}
      resolve({ ok: false, error: "调用超时（300s）", output: (out + err).trim().slice(0, 16000) });
    }, 300000);
    proc.on("error", (e) => { clearTimeout(to); resolve({ ok: false, error: "进程错误: " + e.message }); });
    proc.on("close", (code) => {
      clearTimeout(to);
      const output = (out + (err ? "\n[stderr]\n" + err : "")).trim();
      resolve({ ok: code === 0, code: code === null ? -1 : code, output: output.slice(0, 16000) });
    });
  });
}

/* 给 shell 参数加引号（Windows cmd /c 场景）：无空格/特殊字符则不包；否则双引号包裹，内部 " 转义为 \" */
function quoteArg(s) {
  const str = String(s == null ? "" : s);
  if (/^[A-Za-z0-9_./:\\-]+$/.test(str)) return str;
  return '"' + str.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

module.exports = { detectAgents, launchAgent, runAgent, AGENTS };
