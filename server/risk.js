/* ============================================================
   改动风险热力图（pancode 原创能力，主流 agentic IDE 均无）
   ------------------------------------------------------------
   问题：Agent 一口气改 15 个文件、+400 −220，用户面对的是"一堆绿色红色数字"，
   而不是"哪里最可能出事"。审阅成本随改动数线性上升，于是大家干脆闭眼点接受。
   做法：对每个改动文件算一个纯静态、零 LLM、可解释的风险分，把"该重点看哪几处"
   变成一等的界面信号；同时把分数回灌给 Agent，让它在高风险改动后主动补验证。
   ============================================================ */
"use strict";

/* 敏感路径：命中即视为"出事会影响鉴权/部署/依赖/数据" */
const SENSITIVE = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)(auth|security|permission|privilege|session|token|credential|password|crypt|encrypt)\w*/i,
  /(^|\/)(config|settings?|constants?)\.(js|ts|json|py|go|rb|php|yaml|yml|toml)$/i,
  /(^|\/)(package\.json|package-lock\.json|pom\.xml|build\.gradle|go\.mod|requirements\.txt|Cargo\.toml|composer\.json)$/i,
  /(^|\/)(dockerfile|docker-compose|Makefile|Jenkinsfile)$/i,
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)(migrations?|database|db)\//i,
  /(^|\/)(router|routes?|server|app|main|index|store)\.(js|ts|jsx|tsx|py|go|rb|php)$/i,
];

/* 看起来像测试 / 文档 / 快照：这类改动风险天然低 */
const LOW_RISK = [
  /(^|\/)(tests?|__tests__|spec|cypress|playwright)\//i,
  /\.(test|spec)\.[jt]sx?$/i,
  /(^|\/)(README|CHANGELOG|LICENSE|docs?|\.md$)/i,
  /\.md$/i,
  /(^|\/)__snapshots__\//i,
];

function reMatches(list, p) {
  for (const re of list) if (re.test(p)) return true;
  return false;
}

/* 抽取"对外接口"签名：函数/类/导出名。签名集合变化 = 可能波及调用方 */
const SIG_RE = [
  /(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let)\s+)([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*(?:function|class)\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*(?:func|type)\s+([A-Za-z_]\w*)/g,
  /(?:^|\n)\s*def\s+([A-Za-z_]\w*)/g,
];
function signatures(src) {
  const out = new Set();
  const s = String(src || "");
  if (!s) return out;
  for (const re of SIG_RE) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) && out.size < 4000) out.add(m[1]);
  }
  return out;
}

/**
 * @param {object} i
 * @param {string} i.path   相对路径
 * @param {string} i.base   基线内容
 * @param {string} i.cur    当前内容
 * @param {number} i.add    新增行
 * @param {number} i.del    删除行
 * @param {string} i.status A/M/D
 * @param {number} i.changedFiles 本次改动文件总数（爆炸半径）
 * @param {boolean} i.hasTestTouch 本次改动集里是否含测试文件
 */
function assess(i) {
  const path = String(i.path || "").replace(/\\/g, "/");
  const add = i.add || 0, del = i.del || 0;
  const reasons = [];
  let score = 0;

  if (reMatches(LOW_RISK, path)) {
    // 测试/文档本身：只保留体量信号
    if (add + del > 400) { score += 1; reasons.push("测试/文档体量偏大（" + (add + del) + " 行）"); }
    return { level: "low", score, reasons, path };
  }

  if (reMatches(SENSITIVE, path)) { score += 3; reasons.push("敏感路径（鉴权 / 配置 / 依赖 / 部署 / 入口）"); }

  if (i.status === "D") { score += 3; reasons.push("删除整个文件，不可自动恢复"); }

  if (del > 40 && del > add * 2) { score += 2; reasons.push("大段删除（+" + add + " / −" + del + "），易误删既有逻辑"); }
  else if (del > 120) { score += 1; reasons.push("删除行数较多（−" + del + "）"); }

  const bulk = add + del;
  if (bulk > 300) { score += 2; reasons.push("单文件改动体量过大（" + bulk + " 行）"); }
  else if (bulk > 120) { score += 1; reasons.push("单文件改动体量偏大（" + bulk + " 行）"); }

  if (i.status !== "D") {
    const b = signatures(i.base), c = signatures(i.cur);
    const gone = [], added = [];
    for (const x of b) if (!c.has(x)) gone.push(x);
    for (const x of c) if (!b.has(x)) added.push(x);
    if (gone.length) { score += 2; reasons.push("移除/改名了对外符号：" + gone.slice(0, 6).join("、") + (gone.length > 6 ? " 等 " + gone.length + " 个" : "") + "（调用方可能失效）"); }
    else if (added.length > 3) { score += 1; reasons.push("新增 " + added.length + " 个对外符号"); }
  }

  if ((i.changedFiles || 1) > 8) { score += 1; reasons.push("本次任务共改 " + i.changedFiles + " 个文件，跨面较大"); }
  if (bulk > 0 && !i.hasTestTouch) { score += 1; reasons.push("改动集中没有配套测试变更"); }

  const level = score >= 6 ? "high" : score >= 3 ? "mid" : "low";
  return { level, score, reasons, path };
}

/** 汇总一组风险为整体等级 + 需要重点看的文件 */
function summarize(risks) {
  const list = risks || [];
  const high = list.filter((r) => r && r.level === "high");
  const mid = list.filter((r) => r && r.level === "mid");
  const total = list.reduce((s, r) => s + (r ? r.score : 0), 0);
  return {
    level: high.length ? "high" : mid.length ? "mid" : "low",
    score: total,
    high: high.map((r) => r.path),
    mid: mid.map((r) => r.path),
    focus: high.concat(mid).sort((a, b) => b.score - a.score).slice(0, 5)
      .map((r) => ({ path: r.path, level: r.level, score: r.score, reasons: r.reasons })),
  };
}

/** 给 Agent 看的纯文本摘要（回灌进工具结果，促使它自己补验证） */
function forAgent(sum) {
  if (!sum || sum.level === "low") return "";
  const lines = ["[改动风险评估] 整体：" + (sum.level === "high" ? "高" : "中") + "（累计分 " + sum.score + "）"];
  for (const f of sum.focus) lines.push(" - " + f.path + "：" + f.reasons.join("；"));
  lines.push(sum.level === "high"
    ? "建议：先针对上述文件跑测试或 get_diagnostics 验证，再决定是否继续；必要时向用户说明风险并请求确认。"
    : "建议：对上述文件跑一次 get_diagnostics 或相关测试确认没有连带破坏。");
  return lines.join("\n");
}

module.exports = { assess, summarize, forAgent, SENSITIVE, LOW_RISK, signatures };
