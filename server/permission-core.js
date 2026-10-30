/* ============================================================
   权限决策的唯一梯子（审查项 F05 收口）

   为什么要有这个文件：同一条"这一步到底要不要问人"的判断，以前只存在于
   LlmAgent._approvalDecisionRaw 里。桌面端走它，独立 CLI 引擎（cli/lib/engine.js）
   却完全没走 —— 配置默认档写着 permissions.mode="ask"，实际却是写文件、
   跑命令一律直通执行。"默认要问"这件事只存在于配置文件里，不存在于执行路径上。

   所以把梯子（分支顺序 + 每个分支的措辞）抽到这一份，两个引擎共用：
     · 各入口只负责把自己那套"事实"算出来（规则命中没有、是不是只读、可不可逆），
       以参数交给 decide()；
     · 顺序与结论只在这里有一份，加一档模式不必担心某个入口忘记改。

   本文件刻意保持纯函数、零运行时依赖（只用 rules.js 的 glob 编译器），
   这样 CLI 侧 require 它不会把 express / fs 监视这些服务端重资产一起拖进来。
   ============================================================ */
"use strict";
const rulesLib = require("./rules");
const { pathPrefixHit } = require("./agent-helpers");

/* 文本主体命中：/regex/ 语法或大小写不敏感子串。与迁移前 LlmAgent._matchRule 逐字一致。 */
function matchTextRule(text, rules) {
  if (!rules || !rules.length || !text) return false;
  const t = String(text);
  for (const r of rules) {
    if (!r) continue;
    if (r.length >= 2 && r.startsWith("/") && r.endsWith("/")) {
      try { if (new RegExp(r.slice(1, -1), "i").test(t)) return true; } catch (e) {}
    } else if (t.toLowerCase().includes(r.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/* 规则命中判定。规则可以是：
     "npm run"                    → 旧版子串 / /regex/ 语法（保持兼容）
     { tool:"run_command", pattern:"npm run test*", action:"allow" }
     { tool:"write_file",  pattern:"src/**" }
   tool 支持 "*" 与逗号分隔多工具。kind: "path" | "text"。 */
function matchPermRule(toolName, subject, rules, kind) {
  if (!rules || !rules.length) return null;
  const subj = String(subject || "");
  for (const r of rules) {
    if (!r) continue;
    if (typeof r === "string") {
      if (matchTextRule(subj, [r])) return r;
      if (r.length >= 2 && r.startsWith("/") && r.endsWith("/")) continue;
      // 旧配置里也有人写 "run_command:npm" 这种，兼容一下
      const colon = r.indexOf(":");
      if (colon > 0 && (r.slice(0, colon).trim() === toolName || r.slice(0, colon).trim() === "*")) return r;
      continue;
    }
    const toolSpec = String(r.tool || "*").trim();
    const tools = toolSpec.split(",").map((x) => x.trim()).filter(Boolean);
    const toolOk = tools.some((t) => t === "*" || t === toolName || (t.endsWith(":") && toolName === t.slice(0, -1)) || (t.endsWith("*") && toolName.startsWith(t.slice(0, -1))));
    if (!toolOk) continue;
    if (r.pattern) {
      const p = String(r.pattern);
      if (p === "*" || p === "**") return r;
      if (rulesLib.globToRe(p).test(subj)) return r;
      /* glob 不中时的退化按主体种类分流：
         路径类 → 只在分隔符边界上退化为前缀（"src" 命中 "src/x"，不命中 "src-eval/x"）。
           迁移前是无边界 startsWith，于是 allow 规则 "src" 会连带放行 "src-eval/x.js"，
           放行面的误命中比拒绝面的漏命中更危险。
         命令类 → 保持原来的前缀判定（"git push" 本就该拦住 "git push --force"）。 */
      if (kind === "path") { if (pathPrefixHit(p, subj)) return r; }
      else if (subj.toLowerCase().startsWith(p.toLowerCase().replace(/\*+$/g, "").trim())) return r;
      continue;
    }
    return r;   // 只约束了工具名
  }
  return null;
}

/* 决策梯子。入参是调用方算好的"事实"，不是原始 args —— 各引擎的主体规范化方式不同
   （桌面端要多根归属、CLI 只有一个根），但**分支顺序必须相同**，所以顺序在这。
   ⚠ 顺序即语义，挪动任何一条都要连同桌面/CLI 两侧的测试一起复核：
     deny 早于 allow（用户说"别碰 src"，就不该放行一个同时改 src 的补丁）；
     不可逆守卫早于任何"模式放行"（否则 auto 档会静默删文件）。 */
function decide(c) {
  const mode = c.mode || "ask";
  if (c.denyReason) return { action: "block", reason: c.denyReason };
  // allow 覆盖与会话授权都不给不可逆操作开后门（W14）
  if (!c.irreversible && c.allowReason) return { action: "allow", reason: c.allowReason };
  if (!c.irreversible && c.sessionGranted) return { action: "allow", reason: "本会话已授权" };
  if (c.readOnly) return { action: "allow", reason: "只读操作，免确认" };
  /* 每个出口都带 reason：决策链要能回答"这一步为什么没问我"，
     光有 action:"allow" 等于把问题原样搬进日志再让人自己猜。 */
  if (c.irreversible) return { action: "ask", reason: c.irreversibleReason || "该操作不可逆，需人工确认" };
  /* acceptEdits：只免"文件改动"这一格的确认。判据是 isPath && mutating ——
     run_command / git_* / 浏览器 / 桌面这些算不出路径，照样问人。 */
  if (mode === "acceptEdits" && c.isPath && c.mutating) return { action: "allow", reason: "权限档为「接受编辑」，文件改动免确认" };
  if (mode === "auto") return { action: "allow", reason: "权限档为「全自动」" };
  /* smart：确定性几道都过了，剩下这一发交模型。本函数是同步的，
     所以只出一个哨兵，真正等模型的地方在调用方的 gate 里。 */
  if (mode === "smart") return { action: "classify", reason: "权限档为「智能判定」，这一步交分类器" };
  if (mode === "semi") return { action: "ask", reason: "权限档为「半自动」，写操作需确认" };
  if (mode === "acceptEdits") return { action: "ask", reason: "权限档为「接受编辑」：这一步不是文件改动，仍需确认" };
  if (mode === "dontAsk") return { action: "ask", reason: "权限档为「不再询问」，但本步本来要问你" };
  return { action: "ask", reason: "权限档为「每次都问」" }; // ask
}

/* dontAsk（openanlan 同名档）：任何"本来要问人"的出口都变成拒绝。
   包一层而不是在每个出口前加分支 —— 这条链上有好几个 ask 出口（不可逆守卫、各档兜底），
   漏改一个的下场是"无人可问的场景里弹出一张没人能点的卡"，任务就此冻死。
   这一档是给后台自动化 / goal 长任务用的，不是给坐在屏幕前的人用的。 */
function applyDontAsk(dec, mode) {
  if (dec.action === "ask" && (mode || "ask") === "dontAsk") {
    return { action: "block", reason: "权限档为「不再询问」：" + dec.reason + "；本档不弹确认，已拒绝" };
  }
  return dec;
}

module.exports = { matchTextRule, matchPermRule, decide, applyDontAsk };
