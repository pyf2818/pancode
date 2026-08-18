/* ============================================================
   pancode 智能变更摘要 —— P9 智能体验 / P10 文档整合 共享内核
   ------------------------------------------------------------
   设计原则：
   - 纯函数、零副作用、可单测（不读文件、不发网络、不写盘）
   - 输入统一为 changes = [{ path, status }]
       status ∈ "M"(修改) / "A"(新增) / "D"(删除)
   - summarize(changes) 产出：分组、中文总览、建议、changelog markdown 草案
   - docDraft(changes)  产出：README / 文档风格片段（草稿，待人工润色）
   - 所有产出均为"生成草稿，绝不静默落盘"，由调用方决定是否采用
   ============================================================ */
"use strict";

/* ---------- 分类规则 ---------- */
const SRC_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte",
  "py", "java", "go", "rs", "cpp", "cc", "c", "h", "hpp", "cs",
  "rb", "php", "scala", "kt", "swift", "dart", "lua", "r", "pl",
  "ex", "exs", "erl", "sql", "graphql", "sh", "bash", "zsh", "ps1",
  "css", "scss", "less", "html", "htm", "xml",
]);
const DOC_EXT = new Set([
  "md", "markdown", "txt", "rst", "adoc", "textile",
]);
const CONFIG_EXT = new Set([
  "json", "jsonc", "yml", "yaml", "toml", "ini", "cfg", "conf",
  "properties", "env", "lock",
]);

function classify(p) {
  const lower = String(p || "").toLowerCase();
  if (!lower) return "other";
  const segs = lower.split("/");
  const base = segs[segs.length - 1] || "";
  const ext = base.includes(".") ? base.split(".").pop() : "";

  // 1) 测试优先：目录或文件名含 test / spec
  if (
    segs.includes("test") || segs.includes("tests") ||
    segs.includes("__tests__") || segs.includes("spec") ||
    /(^|[_.\-])(test|spec)([_.\-]|$)/.test(base) ||
    base.startsWith("test_") || base.startsWith("spec_")
  ) return "test";

  // 2) 文档：docs 目录 / README / CHANGELOG / 文档扩展名
  if (
    segs.includes("docs") || segs.includes("doc") || segs.includes("documentation") ||
    /^(readme|changelog|changes|news|contributing|authors|license)/.test(base) ||
    DOC_EXT.has(ext)
  ) return "doc";

  // 3) 配置：配置文件扩展名 / 工程元数据目录 / 无扩展名的构建文件
  if (
    segs.includes(".github") || segs.includes(".workbuddy") || segs.includes(".vscode") ||
    CONFIG_EXT.has(ext) ||
    /^(makefile|dockerfile|\.env|procfile|\.editorconfig|\.gitignore|\.gitattributes)/.test(base)
  ) return "config";

  // 4) 源码：已知源码扩展名
  if (SRC_EXT.has(ext)) return "src";

  // 5) 其他：资源、二进制、未知
  return "other";
}

const GROUP_LABEL = { src: "源码", test: "测试", doc: "文档", config: "配置", other: "其他" };
const GROUP_ORDER = ["src", "test", "doc", "config", "other"];
const STAT_LABEL = { A: "新增", M: "修改", D: "删除" };

/* ---------- 中文总览 ---------- */
function buildOverview(total, stat, groups) {
  const parts = [];
  parts.push("本次共 " + total + " 个文件变更");
  const ss = [];
  if (stat.A) ss.push(stat.A + " 新增");
  if (stat.M) ss.push(stat.M + " 修改");
  if (stat.D) ss.push(stat.D + " 删除");
  if (ss.length) parts.push("（" + ss.join(" / ") + "）");
  const gparts = GROUP_ORDER.filter((g) => groups[g].length)
    .map((g) => GROUP_LABEL[g] + " " + groups[g].length);
  if (gparts.length > 1) parts.push("，其中 " + gparts.join("、") + "。");
  else if (gparts.length === 1) parts.push("，全部为" + gparts[0] + "。");
  else parts.push("。");
  return parts.join("");
}

/* ---------- 下一步建议（主动建议，对齐 P9 目标） ---------- */
function buildSuggestions(groups, list) {
  const tips = [];
  const total = list.length;
  if (!total) return ["暂无改动。"];
  if (groups.src.length + groups.test.length === 0 && groups.other.length > 0) {
    tips.push("本次主要是资源 / 其他文件变更，确认是否需要纳入本次提交。");
  }
  if (groups.doc.length && total === groups.doc.length) {
    tips.push("纯文档变更，可直接提交，无需运行测试。");
  }
  if (groups.test.length) {
    tips.push("已包含测试（" + groups.test.length + " 个），建议运行测试套件验证改动。");
  } else if (groups.src.length >= 3) {
    tips.push("源码改动较多（" + groups.src.length + " 个）但未见测试，建议补充关键路径的测试覆盖。");
  }
  if (groups.config.length) {
    tips.push("涉及配置（" + groups.config.length + " 个），注意向后兼容与环境差异。");
  }
  if (groups.src.length) {
    const added = groups.src.filter((c) => c.status === "A").length;
    if (added) tips.push("新增源码 " + added + " 个，确认已加入构建 / 索引，避免成为孤儿文件。");
  }
  const dels = list.filter((c) => c.status === "D").length;
  if (dels) {
    tips.push("存在删除文件（" + dels + " 个），提交前确认无残留引用。");
  }
  if (!tips.length) tips.push("改动已就绪，填写合适的提交信息即可提交。");
  return tips;
}

/* ---------- changelog markdown 草案 ---------- */
function buildChangelog(list, groups, stat) {
  const lines = [];
  lines.push("## 变更摘要（草稿 · 由 pancode 生成）");
  lines.push("");
  const ss = [];
  if (stat.A) ss.push(A_lbl(stat.A, "新增"));
  if (stat.M) ss.push(A_lbl(stat.M, "修改"));
  if (stat.D) ss.push(A_lbl(stat.D, "删除"));
  lines.push("共 " + list.length + " 个文件" + (ss.length ? "：" + ss.join(" / ") : "") + "。");
  lines.push("");
  for (const g of GROUP_ORDER) {
    if (!groups[g].length) continue;
    lines.push("### " + GROUP_LABEL[g] + "（" + groups[g].length + "）");
    for (const c of groups[g]) {
      lines.push("- [" + (STAT_LABEL[c.status] || c.status) + "] " + c.path);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}
function A_lbl(n, w) { return n + " " + w; }

/* ---------- 提交信息草稿（overview 作标题 + 分组清单作正文） ---------- */
function buildCommitMsg(list, groups, stat) {
  const lines = [];
  lines.push(buildOverview(list.length, stat, groups).replace(/。\s*$/, "")); // 去掉句尾句号，作提交标题
  lines.push("");
  for (const g of GROUP_ORDER) {
    if (!groups[g].length) continue;
    lines.push(GROUP_LABEL[g] + "（" + groups[g].length + "）：");
    for (const c of groups[g]) lines.push("- [" + (STAT_LABEL[c.status] || c.status) + "] " + c.path);
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/* ---------- 文档草稿（README 风格片段，P10） ---------- */
function buildDocDraft(list, groups, stat) {
  const lines = [];
  lines.push("### 改动清单（自动生成 · 草稿待润色）");
  lines.push("");
  const ss = [];
  if (stat.A) ss.push(stat.A + " 新增");
  if (stat.M) ss.push(stat.M + " 修改");
  if (stat.D) ss.push(stat.D + " 删除");
  lines.push("> 共 " + list.length + " 个文件（" + (ss.join(" / ") || "无") + "）");
  lines.push("");
  if (groups.src.length) {
    lines.push("**源码**");
    for (const c of groups.src) lines.push("- " + emoji(c.status) + " `" + c.path + "`：" + verb(c.status));
    lines.push("");
  }
  if (groups.test.length) {
    lines.push("**测试**");
    for (const c of groups.test) lines.push("- " + emoji(c.status) + " `" + c.path + "`：" + verb(c.status));
    lines.push("");
  }
  if (groups.doc.length) {
    lines.push("**文档**");
    for (const c of groups.doc) lines.push("- " + emoji(c.status) + " `" + c.path + "`：" + verb(c.status));
    lines.push("");
  }
  if (groups.config.length) {
    lines.push("**配置**");
    for (const c of groups.config) lines.push("- " + emoji(c.status) + " `" + c.path + "`：" + verb(c.status));
    lines.push("");
  }
  if (groups.other.length) {
    lines.push("**其他**");
    for (const c of groups.other) lines.push("- " + emoji(c.status) + " `" + c.path + "`：" + verb(c.status));
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}
function emoji(s) { return s === "A" ? "🆕" : s === "D" ? "🗑️" : "✏️"; }
function verb(s) { return s === "A" ? "新增" : s === "D" ? "移除" : "更新"; }

/* ============================================================
   对外纯函数
   ============================================================ */
function summarize(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const groups = { src: [], test: [], doc: [], config: [], other: [] };
  const stat = { A: 0, M: 0, D: 0 };
  for (const c of list) {
    const g = classify(c.path);
    groups[g].push(c);
    if (stat[c.status] !== undefined) stat[c.status]++;
  }
  const total = list.length;
  return {
    total,
    stat,
    groups,
    overview: buildOverview(total, stat, groups),
    suggestions: buildSuggestions(groups, list),
    changelog: buildChangelog(list, groups, stat),
    commitMsg: buildCommitMsg(list, groups, stat),
  };
}

function docDraft(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const groups = { src: [], test: [], doc: [], config: [], other: [] };
  const stat = { A: 0, M: 0, D: 0 };
  for (const c of list) {
    const g = classify(c.path);
    groups[g].push(c);
    if (stat[c.status] !== undefined) stat[c.status]++;
  }
  return buildDocDraft(list, groups, stat);
}

module.exports = { classify, summarize, docDraft };
