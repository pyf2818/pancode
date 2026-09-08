"use strict";
/* 共享工具：从 agent-llm.js 抽出的行级 diff / 诊断格式化 / 变更工具集合。
   供 server/tools/ 下各 domain handler 复用。 */

/** 变更类工具集合（规划模式拦截 / 守卫超时豁免） */
const MUTATING_TOOLS = new Set([
  "write_file", "apply_edit", "delete_file", "run_command",
  "undo", "start_process", "stop_process", "git_commit", "git_branch",
]);

/** 行级 diff（LCS）：计算 after 相对 before 新增的行号（1-indexed） */
function computeDiffLines(before, after) {
  const b = before.split("\n");
  const a = after.split("\n");
  if (b.length > 2000 || a.length > 2000) return [];
  const m = b.length, n = a.length;
  const dp = Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (b[i - 1] === a[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = dp[i - 1][j] > dp[i][j - 1] ? dp[i - 1][j] : dp[i][j - 1];
    }
  }
  const added = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && b[i - 1] === a[j - 1]) { i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { added.unshift(j); j--; }
    else { i--; }
  }
  return added;
}

/** 把一条 LSP Diagnostic 格式化为可读文本 */
function fmtDiag(x) {
  const sev = x.severity === 1 ? "错误"
    : x.severity === 2 ? "警告"
    : x.severity === 3 ? "信息" : "提示";
  const ln = (x.range && x.range.start) ? (x.range.start.line + 1) + ":" + (x.range.start.character + 1) : "?";
  const src = x.source ? " [" + x.source + "]" : "";
  let code = "";
  if (x.code != null) code = " (" + (typeof x.code === "object" && x.code.value != null ? x.code.value : x.code) + ")";
  return "- [" + sev + "] " + ln + src + code + " " + x.message;
}

module.exports = { MUTATING_TOOLS, computeDiffLines, fmtDiag };
