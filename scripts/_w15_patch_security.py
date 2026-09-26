# -*- coding: utf-8 -*-
# W15: server/security.js 全量重写 — 黑名单语义化（防 base64/变量拼接/引号/全角绕过）
import io, os

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
p = os.path.join(BASE_DIR, "server", "security.js")

content = r'''/* ============================================================
   pancode 命令安全检查（集中管理，避免散落各处且易绕过）
   - base 黑名单：用户手敲 & AI 命令都拦（fork 炸弹 / 格式化 / 递归删根 / 下载执行 / 关机 / 写设备…）
   - strict 沙箱：AI 触发的命令额外拦（sudo / 系统目录写入 / 全局安装 / 批量删工作区 …）
   - W15 语义层（strict 强化）：Unicode 归一 / 引号拼接还原 / 变量宏展开 /
     base64 解码递归检查 / 解释器管道检测——防编码与拼接绕过。
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

/* W15 新增：编码执行类模式（归一化文本上跑） */
const ENCODED_EXEC = [
  /\bbase64\b[^|]*\|\s*(sh|bash|zsh|ksh|dash|powershell|pwsh)\b/i,   // base64 -d | sh
  /\b(sh|bash|zsh|ksh|dash)\b[^|]*\|\s*base64\b/i,                    // sh | base64（混淆外传）
  /\bpowershell\b[^|]*\s-enc(odedcommand)?\b/i,                       // powershell -enc
  /\bcertutil\b[^|]*-decode\b/i,                                      // certutil 解码执行链
  /\beval\b[^|]*\bbase64\b/i,                                         // eval $(... base64 ...)
];

/* W15：解释器管道——任意管道段的首命令是解释器即拦（与 BASE "| sh" 同语义，覆盖任意位置） */
const INTERPRETERS = new Set(["sh", "bash", "zsh", "ksh", "dash", "powershell", "pwsh", "cmd"]);
function hasInterpreterPipe(cmd) {
  const segs = String(cmd).split(/(?<!\|)\|(?!\|)/); // 排除 || 逻辑或
  for (const seg of segs) {
    const m = seg.trim().match(/^([a-z0-9_.\/\\-]+)\b/i);
    if (m) {
      const head = m[1].toLowerCase().replace(/^\.?\//, "").replace(/^%[a-z0-9_]+%$/, "");
      if (INTERPRETERS.has(head)) return true;
    }
  }
  return false;
}

/* W15：Unicode 归一（全角→半角 NFKC）+ 去零宽/控制字符 */
function normalizeCmd(cmd) {
  let s = String(cmd || "");
  try { s = s.normalize("NFKC"); } catch (e) {}
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  return s;
}

/* W15：去除成对引号（保留内容）——还原 r"m"、r'e' 拼接绕过（仅 strict 层用） */
function stripQuoteJoins(cmd) {
  return String(cmd)
    .replace(/"([^"]*)"/g, "$1")
    .replace(/'([^']*)'/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
}

/* W15：变量宏展开——收集 VAR=value 赋值，替换 $VAR / ${VAR} / %VAR%（2 轮收敛，仅 strict 层用） */
function macroExpandVars(cmd, depth) {
  depth = depth || 0;
  let s = String(cmd);
  const assigns = {};
  const reAssign = /(?:^|[;&]\s*|\|\|\s*)([A-Za-z_]\w*)=([^\s|;&]+)/g;
  let m;
  while ((m = reAssign.exec(s)) !== null) assigns[m[1]] = m[2];
  const keys = Object.keys(assigns);
  if (!keys.length || depth >= 2) return s;
  for (const k of keys) {
    const v = assigns[k];
    s = s.split("${" + k + "}").join(v).split("$" + k).join(v).split("%" + k + "%").join(v);
  }
  return macroExpandVars(s, depth + 1);
}

/* W15：提取疑似 base64 常量（≥24 位）尝试解码；解码后剔除 UTF-16LE 空字节再返回文本数组 */
const B64_RE = /[A-Za-z0-9+/=]{24,}/g;
function decodeBase64Candidates(cmd) {
  const out = [];
  const s = String(cmd || "");
  const cands = s.match(B64_RE) || [];
  for (const c of cands.slice(0, 5)) { // 最多解 5 个候选，防滥用
    try {
      const buf = Buffer.from(c, "base64");
      if (!buf.length) continue;
      let text = buf.toString("utf8");
      const compact = text.replace(/\x00+/g, ""); // PowerShell -enc 是 UTF-16LE
      const printable = (compact.replace(/[^\x20-\x7e\u4e00-\u9fa5]/g, "").length) / Math.max(compact.length, 1);
      if (printable > 0.7 && compact.trim()) out.push(compact);
    } catch (e) {}
  }
  return out;
}

/* 递归检查（深度限 2：解码产物本身可能还是编码链） */
function _check(cmd, strict, depth) {
  const raw = String(cmd || "");
  const norm = normalizeCmd(raw);
  const hit = (why) => ({ blocked: true, reason: why });

  // 1) 原文跑 BASE（保持既有语义）
  for (const re of BASE) if (re.test(raw)) return hit("命中基础危险命令黑名单（fork 炸弹 / 格式化 / 递归删除根 / 下载执行 / 关机 / 写设备等），已拦截。这只是本地安全策略，并非沙箱限制——命令本身是在用户本机真实执行的，请改用安全的替代方案。");

  // 2) 解释器管道（任意段首 = 解释器）
  if (hasInterpreterPipe(norm)) return hit("检测到把内容管道进解释器直接执行（| sh / bash / powershell 等），该模式常被用于绕过命令审查，已拦截。请改用先落盘脚本、人工审阅后再执行的方式。");

  // 3) 编码执行模式
  for (const re of ENCODED_EXEC) if (re.test(norm)) return hit("检测到编码执行链（base64/powershell -enc/certutil 解码后执行），可用于绕过命令审查，已拦截。请改用明文命令。");

  if (strict) {
    // 4) 语义归一文本再跑 BASE+STRICT：防全角/零宽/引号拼接/变量拼接绕过
    const expanded = stripQuoteJoins(macroExpandVars(norm));
    for (const re of BASE) if (re.test(expanded)) return hit("命中基础危险命令黑名单（语义归一后匹配，疑似编码/拼接绕过），已拦截。这只是本地安全策略，并非沙箱限制——请改用安全的替代方案。");
    for (const re of STRICT) if (re.test(expanded)) return hit("命中 AI 命令安全黑名单（sudo / 系统目录写入 / 全局安装 / 批量删除等），已拦截。这只是本地安全策略，并非沙箱环境——请改用无需提权或全局写入的替代方案。");
  }

  // 5) base64 候选解码递归（深度 ≤2）
  if (depth < 2) {
    for (const dec of decodeBase64Candidates(norm)) {
      const sub = _check(dec, strict, depth + 1);
      if (sub.blocked) return hit("命令中包含 base64 编码内容，解码后命中危险黑名单（" + (sub.reason || "").slice(0, 40) + "…），已拦截。请改用明文命令。");
    }
  }
  return { blocked: false };
}

function check(displayCmd, strict) {
  return _check(displayCmd, !!strict, 0);
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

module.exports = { check, normalizeCmd, stripQuoteJoins, macroExpandVars, decodeBase64Candidates, hasInterpreterPipe, setAuditDir, writeAudit, checkHooks };
'''

io.open(p + ".new", "w", encoding="utf-8", newline="").write(content)
print("security.js -> .new written")
