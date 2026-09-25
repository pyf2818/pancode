/* ============================================================
   pancode 命令安全检查（集中管理，避免散落各处且易绕过）
   - base 黑名单：用户手敲 & AI 命令都拦（fork 炸弹 / 格式化 / 递归删根 / 下载执行 / 关机 / 写设备…）
   - strict 沙箱：AI 触发的命令额外拦（sudo / 系统目录写入 / 全局安装 / 批量删工作区 …）
   返回 { blocked, reason }
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

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
    if (re.test(cmd)) return { blocked: true, reason: "命中基础危险命令黑名单（fork 炸弹 / 格式化 / 递归删除根 / 下载执行 / 关机 / 写设备等），已拦截。这只是本地安全策略，并非沙箱限制——命令本身是在用户本机真实执行的，请改用安全的替代方案。" };
  }
  if (strict) {
    for (const re of STRICT) {
      if (re.test(cmd)) return { blocked: true, reason: "命中 AI 命令安全黑名单（sudo / 系统目录写入 / 全局安装 / 批量删除等），已拦截。这只是本地安全策略，并非沙箱环境——命令本身是在用户本机真实执行的，请改用无需提权或全局写入的替代方案。" };
    }
  }
  return { blocked: false };
}

/* ---------------- W14：统一审计写入 + 用户 hooks 规则 ---------------- */

let _auditDir = null;
function setAuditDir(dir) { _auditDir = dir || null; }

/* 审计写入（追加当日 .pancode/audit/<日期>.log）。审计失败只告警，绝不阻塞工具链。 */
function writeAudit(source, detail) {
  if (!_auditDir || !detail) return;
  try {
    fs.mkdirSync(_auditDir, { recursive: true });
    const f = path.join(_auditDir, new Date().toISOString().slice(0, 10) + ".log");
    fs.appendFileSync(f, new Date().toISOString() + " | " + source + " | "
      + String(detail).replace(/\r?\n/g, " ").slice(0, 500) + "\n");
  } catch (e) { console.warn("[pancode][audit] 写入失败:", e.message); }
}

/* hooks.pre 规则匹配：tool 匹配（"*" 或精确或省略）+ subject 匹配（/正则/ 或包含子串，省略=仅按 tool）。
   返回 { action: "deny", reason } 或 { action: "none" } */
function checkHooks(rules, toolName, subject) {
  for (const h of rules || []) {
    if (!h || h.action !== "deny") continue;
    if (h.tool && h.tool !== "*" && h.tool !== toolName) continue;
    if (h.match) {
      try {
        const re = /^\/(.+)\/([a-z]*)$/.exec(h.match); /* 支持 /pattern/ 与 /pattern/flags 两种形式 */
        if (re) {
          if (!new RegExp(re[1], re[2] || "i").test(String(subject))) continue;
        } else if (!String(subject).toLowerCase().includes(h.match.toLowerCase())) continue;
      } catch (e) { continue; }
    }
    return { action: "deny", reason: h.reason || "" };
  }
  return { action: "none" };
}

module.exports = { check, setAuditDir, writeAudit, checkHooks };
