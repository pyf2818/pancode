"use strict";
/* ============================================================
   W18 · 命令沙箱运行器（对齐 Codex 的 sandbox 思路，本地优先版）
   ------------------------------------------------------------
   背景：run_command 此前只有"策略层"防护（黑名单 + 审批门 + 审计），
   security.js 的注释自己就承认"这是安全策略，不是沙箱"——黑名单永远
   可能被绕过（换后缀、换解释器、编码混淆），提示注入一次得手就是
   任意代码执行。Codex 的答案是 OS 级沙箱（Seatbelt / landlock /
   Windows 原生）；纯 Node 没有等价物，这里给三档后端：

     · docker —— 硬隔离（推荐）：命令在一次性容器里跑，只有工作区
       是可写挂载，网络默认关。系统能伤不到，工作区照常干活。
     · wsl    —— 软隔离：命令在 WSL 发行版里跑。注意 /mnt/c 之类的
       挂载仍能写宿主盘，挡的是"Windows 侧直接执行"，不是全隔离。
     · policy —— 现状（默认）：黑名单 + 审批门 + 审计，无真隔离。

   默认 policy（不改变任何现有行为）；backend:"auto" 会探测 docker →
   wsl → policy 依次降级。显式写 "docker"/"wsl" 时探测失败会退回 policy
   并在审计里说明——绝不"配了沙箱却静默裸跑"。

   配置（pancode.config.json）：
     "sandbox": { "backend": "docker", "image": "node:20-slim",
                  "network": false }
   ============================================================ */
const { execSync } = require("child_process");
const log = require("./logger");

const DEFAULT_IMAGE = "node:20-slim";

/* sh 单引号安全包裹：'…' 内的 ' 换成 '\'' —— docker/wsl 侧统一用 sh -c */
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/* Windows 路径 → docker -v 挂载写法：E:\a\b → E:/a/b（Docker Desktop 接受正斜杠盘符） */
function dockerPath(p) {
  return String(p).replace(/\\/g, "/");
}

/* 探测器（可注入以便单测） */
function detectDocker() {
  try {
    execSync("docker info --format {{.ServerVersion}}", { stdio: "ignore", timeout: 4000, windowsHide: true });
    return true;
  } catch (e) { return false; }
}
function detectWsl() {
  try {
    /* wsl.exe 的输出是 UTF-16LE，按字节解会满屏 \x00 —— 显式按 utf16le 解 */
    const out = execSync("wsl.exe -l -q", { timeout: 4000, windowsHide: true, encoding: "utf16le" }) || "";
    return out.split(/\r?\n/).some((l) => l.trim().length > 0);
  } catch (e) { return false; }
}

/* 解析生效后端。cfg.sandbox = { backend, image, network }；detectors 供测试注入。
   返回 { backend, reason }，backend ∈ docker|wsl|policy。 */
function resolveBackend(cfg, detectors) {
  const d = detectors || { docker: detectDocker, wsl: detectWsl };
  const sc = (cfg && cfg.sandbox) || {};
  const want = String(sc.backend || "policy").toLowerCase();
  if (want === "policy" || want === "") return { backend: "policy", reason: "配置为 policy（默认）：黑名单+审批门，无真隔离" };
  if (want === "docker") {
    if (d.docker()) return { backend: "docker", reason: "docker 可用，硬隔离" };
    return { backend: "policy", reason: "配置了 docker 但 docker 不可用，退回 policy（绝不静默裸跑）" };
  }
  if (want === "wsl") {
    if (d.wsl()) return { backend: "wsl", reason: "wsl 可用，软隔离（/mnt 仍可写宿主盘）" };
    return { backend: "policy", reason: "配置了 wsl 但 wsl 不可用，退回 policy（绝不静默裸跑）" };
  }
  if (want === "auto") {
    if (d.docker()) return { backend: "docker", reason: "auto：探测到 docker" };
    if (d.wsl()) return { backend: "wsl", reason: "auto：无 docker，探测到 wsl（软隔离）" };
    return { backend: "policy", reason: "auto：docker/wsl 都不可用" };
  }
  return { backend: "policy", reason: "未认识的 backend 值：" + want };
}

/* 工作区绝对路径 → wsl 内路径。走 wslpath 子进程拿权威答案，失败时按 E:\a\b → /mnt/e/a/b 猜。 */
function wslPathOf(winPath, runWslpath) {
  const guess = (() => {
    const m = /^([a-z]):[\/\\](.*)$/i.exec(String(winPath));
    if (!m) return null;
    return "/mnt/" + m[1].toLowerCase() + "/" + m[2].replace(/\\/g, "/");
  })();
  if (!runWslpath) return guess;   // 纯函数模式（单测用）：不碰子进程
  try {
    const out = execSync("wsl.exe wslpath -a " + shQuote(String(winPath)), { timeout: 4000, windowsHide: true, encoding: "utf8" });
    const s = String(out || "").trim();
    if (s) return s;
  } catch (e) { /* 探测失败用猜测值 */ }
  return guess;
}

/* 把一条命令包进生效后端。返回 { command, backend, sandboxed, note }。
   policy 后端原样返回 —— 这个函数永远不抛错：沙箱是加固件，不能变成新的故障点。 */
function wrap(command, opts) {
  const o = opts || {};
  const cfg = o.cfg || {};
  const sc = (cfg.sandbox) || {};
  let resolved;
  try { resolved = resolveBackend(cfg, o.detectors); }
  catch (e) { resolved = { backend: "policy", reason: "后端解析异常退回 policy：" + e.message }; }
  const note = resolved.reason;
  if (resolved.backend === "policy" || !o.workspace) {
    return { command: String(command), backend: "policy", sandboxed: false, note };
  }
  try {
    if (resolved.backend === "docker") {
      const image = String(sc.image || DEFAULT_IMAGE);
      const net = sc.network === true ? [] : ["--network", "none"];
      const cmd = "docker run --rm -i" +
        " -v " + shQuote(dockerPath(o.workspace) + ":/ws") +
        " -w /ws " + net.join(" ") + " " + image + " sh -c " + shQuote(String(command));
      return { command: cmd, backend: "docker", sandboxed: true, note: note + "（镜像 " + image + (sc.network === true ? "，网络放开" : "，网络关闭") + "）" };
    }
    if (resolved.backend === "wsl") {
      const wpath = wslPathOf(o.workspace, o.liveWslpath !== false);
      /* 内层用双引号包路径（外层已单引号），避免 shQuote 嵌套转义把命令弄成天书 */
      const cmd = "wsl.exe -e sh -c " + shQuote('cd "' + (wpath || ".") + '" && ' + String(command));
      return { command: cmd, backend: "wsl", sandboxed: true, note: note + "（工作区映射 " + wpath + "）" };
    }
  } catch (e) {
    log.tag("sandbox").warn("沙箱包装失败，按 policy 执行：" + e.message);
    return { command: String(command), backend: "policy", sandboxed: false, note: "沙箱包装异常退回 policy：" + e.message };
  }
  return { command: String(command), backend: "policy", sandboxed: false, note };
}

module.exports = { resolveBackend, wrap, wslPathOf, shQuote, detectDocker, detectWsl, DEFAULT_IMAGE };
