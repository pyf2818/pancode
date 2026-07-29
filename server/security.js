/* ============================================================
   pancode 命令安全检查（集中管理，避免散落各处且易绕过）
   - base 黑名单：用户手敲 & AI 命令都拦（fork 炸弹 / 格式化 / 递归删根 / 下载执行 / 关机 / 写设备…）
   - strict 沙箱：AI 触发的命令额外拦（sudo / 系统目录写入 / 全局安装 / 批量删工作区 …）
   返回 { blocked, reason }
   ============================================================ */
"use strict";

const BASE = [
  /:\s*\(\)\s*\{[^}]*\|[^}]*\}\s*;?/,            // fork bomb :(){ :|:& };
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+[\/~]/,        // rm -rf / 或 ~
  /\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+[\/~]/,
  /\bmkfs\b/,                                     // 格式化
  /\bformat\s+[a-z]:/i,                           // Windows format c:
  /\bdd\b[^|]*\bof=\/dev\//,                      // dd 写设备
  /\bdd\b[^|]*\bif=\//,                           // dd 读设备轰炸
  /\bshred\b/, /\bwipefs\b/,
  /\bshutdown\b/, /\breboot\b/, /\bhalt\b/, /\bpoweroff\b/,
  /\binit\s+0\b/, /\btelinit\s+0\b/,
  /\bcurl\b[^|]*\|\s*(sh|bash)\b/,               // curl ... | sh
  /\bwget\b[^|]*\|\s*(sh|bash)\b/,               // wget ... | sh
  /\|\s*(sh|bash)\s*$/,                           // ... | sh
  />\s*\/dev\/[a-z]+/,                            // > /dev/sda
  /\bdel\s+\/f\s+\/s\s+\/q/i,                    // Windows del /f /s /q
  /\brd\s+\/s\s+\/q/i,                            // Windows rd /s /q
];

const STRICT = [
  /\bsudo\b/,                                     // AI 不应提权
  /\bchmod\s+-R\s+777\s+[\/~]/,                   // 破坏权限
  /\bchown\s+-R\b/,
  /\bnpm\s+(install|i)\s+-g\b/, /\byarn\s+(add\s+-g|global\s+add)\b/, /\bpip\s+install\s+(-g|--user)\b/,
  /\b(cat|echo|printf)\b[^|]*>\s*\/etc\//,        // 写系统配置
  /\bmv\b[^|]*\s+\/+(etc|usr|System|Windows)\b/,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\*/,            // 批量删工作区
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\.\./,          // 越级删
];

function check(displayCmd, strict) {
  const cmd = String(displayCmd || "");
  for (const re of BASE) {
    if (re.test(cmd)) return { blocked: true, reason: "命中基础危险命令黑名单（fork 炸弹 / 格式化 / 递归删除根 / 下载执行 / 关机 / 写设备等）" };
  }
  if (strict) {
    for (const re of STRICT) {
      if (re.test(cmd)) return { blocked: true, reason: "AI 命令需经更严格沙箱，已拦截（sudo / 系统目录 / 全局安装 / 批量删除等）" };
    }
  }
  return { blocked: false };
}

module.exports = { check };
