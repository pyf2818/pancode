/* ============================================================
   Skill 生态系统 v2 - Markdown + YAML frontmatter 标准

   Skill 文件格式（.md）:
     ---
     name: React 组件性能优化
     description: 使用 memo/useMemo/useCallback 优化渲染性能
     category: frontend
     tags: [react, performance, optimization]
     trigger: 性能,慢,卡顿,渲染,重渲染
     author: user
     version: 1.0.0
     ---

     ## 解决方案
     1. 分析重渲染组件
     2. 用 React.memo 包裹纯展示组件
     3. 用 useMemo 缓存计算值
     4. 用 useCallback 缓存回调

     ## 验证
     npm test && npm run build

   三种存储:
     1. 市场 Skills  -> .pancode/skills/market/*.md  (用户创建/导入)
     2. 工作区 Skills -> .pancode/skills/{wsHash}.json (Agent 沉淀)
     3. 内置 Workflow -> 代码内置

   使用方式:
     1. 输入框上方 @skill 选择器 -> 引用到对话
     2. 自动匹配 - Agent 分析意图后注入上下文
     3. /skill <名称> - 在对话中直接触发
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---------- 内置 Workflow 模板 ---------- */
const BUILTIN_WORKFLOWS = [
  {
    name: "修复 Bug",
    description: "标准 Bug 修复流程：复现->定位->修复->验证->总结",
    category: "debug",
    tags: ["bug", "fix", "修复", "错误"],
    trigger: "bug,fix,修复,错误,异常,报错,broken",
    body: "## 解决方案\n1. 分析 bug 现象和复现步骤\n2. 阅读相关源码，定位根因\n3. 修复代码，最小改动原则\n4. 运行相关测试验证修复\n5. 确认无回归，总结根因与改动\n\n## 验证\n运行测试套件，确认全部通过",
    source: "workflow",
  },
  {
    name: "实现新功能",
    description: "标准功能开发流程：计划->实现->测试->文档",
    category: "workflow",
    tags: ["feature", "功能", "开发", "需求"],
    trigger: "功能,feature,需求,新增,添加,实现",
    body: "## 解决方案\n1. 分析需求，列出涉及的文件/接口/数据结构\n2. 阅读现有代码，理解现有模式和约定\n3. 创建新文件或修改现有代码\n4. 编写或更新测试\n5. 运行测试确认通过\n6. 更新文档和关键注释\n\n## 验证\n测试通过 + lint 无报错",
    source: "workflow",
  },
  {
    name: "重构模块",
    description: "安全重构流程：基线->改造->验证->对比",
    category: "refactor",
    tags: ["refactor", "重构", "优化", "清理"],
    trigger: "重构,refactor,优化,清理,简化,提取",
    body: "## 解决方案\n1. 运行测试建立基线（全部通过）\n2. 阅读目标模块，规划重构方案\n3. 逐步重构，保持对外行为不变\n4. 运行测试确认无回归\n5. 给出前后对比：可读性/性能/结构改进\n\n## 验证\n测试全部通过，行为与重构前一致",
    source: "workflow",
  },
  {
    name: "补充测试",
    description: "为现有代码补充测试覆盖率",
    category: "test",
    tags: ["test", "测试", "coverage", "覆盖"],
    trigger: "测试,test,coverage,覆盖,单测,用例",
    body: "## 解决方案\n1. 分析现有测试覆盖情况，识别缺口\n2. 阅读目标代码，理解行为和边界条件\n3. 编写缺失的测试用例\n4. 运行测试确认全部通过\n5. 检查覆盖率是否达标（≥80%）\n\n## 验证\n测试通过 + 覆盖率 ≥ 80%",
    source: "workflow",
  },
  {
    name: "代码审查",
    description: "审查代码质量、潜在 bug、安全风险",
    category: "workflow",
    tags: ["review", "审查", "代码质量", "安全"],
    trigger: "审查,review,代码质量,安全,风险",
    body: "## 解决方案\n1. 阅读目标文件/PR 的全部改动\n2. 按优先级检查：正确性->安全->性能->可维护性\n3. 修复发现的问题\n4. 运行测试确认修复无副作用\n5. 输出审查报告：问题清单 + 改进建议\n\n## 验证\n审查报告输出 + 发现问题已修复",
    source: "workflow",
  },
  {
    name: "配置 CI/CD",
    description: "添加或修复持续集成/部署配置",
    category: "devops",
    tags: ["ci", "cd", "pipeline", "部署"],
    trigger: "ci,cd,pipeline,部署,deploy,github actions",
    body: "## 解决方案\n1. 分析项目类型和构建工具\n2. 检查现有 CI 配置和 package.json scripts\n3. 创建或修复 CI 配置文件\n4. 本地验证构建命令可执行\n5. 确认 CI 配置语法正确\n\n## 验证\n构建命令本地执行成功",
    source: "workflow",
  },
];

/* ---------- YAML frontmatter 解析/序列化 ---------- */
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  const lines = m[1].split("\n");
  for (const line of lines) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1], val = kv[2].trim();
    // 解析数组 [a, b, c]
    if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      meta[key] = val;
    }
  }
  return { meta, body: m[2].trim() };
}

function serializeFrontmatter(skill) {
  const lines = ["---"];
  lines.push("name: " + (skill.name || "未命名"));
  if (skill.description) lines.push("description: " + skill.description);
  if (skill.category) lines.push("category: " + skill.category);
  if (skill.tags && skill.tags.length) lines.push("tags: [" + skill.tags.join(", ") + "]");
  if (skill.trigger) lines.push("trigger: " + skill.trigger);
  if (skill.author) lines.push("author: " + skill.author);
  if (skill.version) lines.push("version: " + (skill.version || "1.0.0"));
  lines.push("---");
  lines.push("");
  lines.push(skill.body || "");
  return lines.join("\n");
}

/* ---------- Skill 标准化 ---------- */
function normalize(skill, source) {
  return {
    id: skill.id || ("sk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
    name: skill.name || "未命名 Skill",
    description: skill.description || "",
    category: skill.category || "other",
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    trigger: skill.trigger || "",
    body: skill.body || skill.steps || "",
    author: skill.author || "user",
    version: skill.version || "1.0.0",
    useCount: skill.useCount || 0,
    source: source || skill.source || "manual",
    ts: skill.ts || Date.now(),
    deprecated: skill.deprecated || false,
  };
}

class SkillStore {
  constructor(marketDir, localPath) {
    this._marketDir = marketDir;
    this._localPath = localPath;
    this._marketSkills = [];
    this._localSkills = [];
    this._load();
  }

  _load() {
    // 市场 Skills（.md 文件）
    this._marketSkills = [];
    try {
      fs.mkdirSync(this._marketDir, { recursive: true });
      const files = fs.readdirSync(this._marketDir).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        try {
          const text = fs.readFileSync(path.join(this._marketDir, f), "utf8");
          const { meta, body } = parseFrontmatter(text);
          this._marketSkills.push(normalize({ ...meta, body, id: f.replace(/\.md$/, "") }, "manual"));
        } catch (e) {}
      }
    } catch (e) {}
    // 工作区 Skills（JSON）
    this._localSkills = [];
    try {
      this._localSkills = JSON.parse(fs.readFileSync(this._localPath, "utf8")) || [];
    } catch (e) {}
  }

  _saveMarket() {
    try {
      fs.mkdirSync(this._marketDir, { recursive: true });
      const existing = new Set(fs.readdirSync(this._marketDir).filter((f) => f.endsWith(".md")));
      const current = new Set();
      for (const s of this._marketSkills) {
        const fname = s.id + ".md";
        current.add(fname);
        fs.writeFileSync(path.join(this._marketDir, fname), serializeFrontmatter(s), "utf8");
      }
      for (const f of existing) if (!current.has(f)) fs.unlinkSync(path.join(this._marketDir, f));
    } catch (e) {}
  }

  _saveLocal() {
    try {
      fs.mkdirSync(path.dirname(this._localPath), { recursive: true });
      fs.writeFileSync(this._localPath, JSON.stringify(this._localSkills, null, 2), "utf8");
    } catch (e) {}
  }

  /* ---------- CRUD ---------- */
  add(skill, source) {
    if (!skill || !skill.name) return null;
    const all = [...this._marketSkills, ...this._localSkills];
    if (all.some((s) => s.name === skill.name && !s.deprecated)) return { ...all.find((s) => s.name === skill.name), _duplicate: true };
    const entry = normalize(skill, source || "manual");
    this._marketSkills.push(entry);
    this._saveMarket();
    return entry;
  }

  addLocal(skill) {
    if (!skill || !skill.name) return null;
    const entry = normalize(skill, "auto");
    const existing = this._localSkills.find((s) => s.name === entry.name);
    if (existing) { existing.body = entry.body; existing.description = entry.description; existing.ts = Date.now(); this._saveLocal(); return existing; }
    this._localSkills.push(entry);
    this._saveLocal();
    return entry;
  }

  update(id, patch) {
    const skill = this._marketSkills.find((s) => s.id === id) || this._localSkills.find((s) => s.id === id);
    if (!skill) return null;
    Object.assign(skill, patch, { ts: Date.now() });
    if (this._marketSkills.includes(skill)) this._saveMarket(); else this._saveLocal();
    return skill;
  }

  remove(id) {
    let idx = this._marketSkills.findIndex((s) => s.id === id);
    if (idx !== -1) { this._marketSkills.splice(idx, 1); this._saveMarket(); return true; }
    idx = this._localSkills.findIndex((s) => s.id === id);
    if (idx !== -1) { this._localSkills.splice(idx, 1); this._saveLocal(); return true; }
    return false;
  }

  getById(id) { return this._marketSkills.find((s) => s.id === id) || this._localSkills.find((s) => s.id === id) || null; }

  list(opts) {
    opts = opts || {};
    const all = [...this._marketSkills, ...this._localSkills].filter((s) => !s.deprecated);
    let pool = all;
    if (opts.category) pool = pool.filter((s) => s.category === opts.category);
    if (opts.source) pool = pool.filter((s) => s.source === opts.source);
    if (opts.search) {
      const q = opts.search.toLowerCase();
      pool = pool.filter((s) => (s.name + " " + s.description + " " + (s.tags || []).join(" ")).toLowerCase().includes(q));
    }
    return pool.sort((a, b) => (b.useCount - a.useCount) || (b.ts - a.ts)).slice(0, opts.limit || 50);
  }

  /* ---------- 智能匹配 ---------- */
  match(taskText, maxResults) {
    maxResults = maxResults || 3;
    if (!taskText) return [];
    const text = taskText.toLowerCase();
    const all = [...this._marketSkills, ...this._localSkills, ...BUILTIN_WORKFLOWS].filter((s) => !s.deprecated);
    const scored = all.map((s) => {
      let score = 0;
      const triggers = String(s.trigger || "").toLowerCase().split(/[,;，；\s]+/).filter(Boolean);
      for (const t of triggers) { if (t.length >= 2 && text.includes(t)) score += 5; }
      for (const tag of (s.tags || [])) { if (text.includes(tag.toLowerCase())) score += 3; }
      if (text.includes(s.name.toLowerCase())) score += 4;
      const words = (s.description || "").toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
      for (const w of words) { if (text.includes(w)) score += 1; }
      score += Math.min(s.useCount || 0, 50) * 0.1;
      if (s.source === "workflow") score += 1;
      return { skill: s, score };
    }).filter((s) => s.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map((s) => s.skill);
  }

  findByName(name) {
    const q = name.toLowerCase().trim();
    const all = [...this._marketSkills, ...this._localSkills, ...BUILTIN_WORKFLOWS];
    return all.find((s) => s.name.toLowerCase() === q) || all.find((s) => s.name.toLowerCase().includes(q)) || null;
  }

  recordUse(id) {
    const skill = this.getById(id);
    if (skill) { skill.useCount = (skill.useCount || 0) + 1; skill.ts = Date.now(); if (this._marketSkills.includes(skill)) this._saveMarket(); else this._saveLocal(); }
  }

  /* ---------- 格式化注入 LLM 上下文 ---------- */
  formatForContext(matchedSkills) {
    if (!matchedSkills || !matchedSkills.length) return "";
    return matchedSkills.map((s) => {
      let text = "### Skill: " + s.name + (s.version ? " v" + s.version : "") + "\n";
      if (s.description) text += s.description + "\n";
      if (s.body) text += s.body + "\n";
      return text;
    }).join("\n---\n\n");
  }

  /* ---------- Agent 自动沉淀 ---------- */
  async autoExtract(llmChatFn, llmCfg, history, taskTopic) {
    if (!history || history.length < 3) return null;
    const taskSummary = history.slice(-8).map((m) => {
      if (m.role === "user") return "用户: " + (typeof m.content === "string" ? m.content : "").slice(0, 200);
      if (m.role === "assistant") return "AI: " + (typeof m.content === "string" ? m.content : "").slice(0, 300);
      if (m.role === "tool") return "工具: " + (typeof m.content === "string" ? m.content : "").slice(0, 100);
      return "";
    }).filter(Boolean).join("\n");

    const prompt = `分析以下编程任务，判断是否值得沉淀为可复用的 Skill。

任务主题：${taskTopic || "编程任务"}

执行过程：
${taskSummary}

判断标准：
- 常见的、有固定模式的问题 -> 值得沉淀
- 一次性的、非常特定的任务 -> 不值得

如果值得沉淀，输出 Markdown 格式的 Skill（包含 YAML frontmatter）：
---
name: Skill名称
description: 一句话描述
category: frontend|backend|test|refactor|debug|devops|perf|security|config|other
tags: [关键词1, 关键词2]
trigger: 触发关键词1,关键词2
---

## 解决方案
1. 步骤一
2. 步骤二
3. 步骤三

## 验证
验证方法

如果不值得，只输出：NO`;

    try {
      const r = await llmChatFn(llmCfg, [
        { role: "system", content: "你是一个 Skill 提取器。只输出 Markdown 格式的 Skill 或 NO。" },
        { role: "user", content: prompt },
      ]);
      const content = (r.content || "").trim();
      if (!content || content === "NO" || !content.startsWith("---")) return null;
      const { meta, body } = parseFrontmatter(content);
      if (!meta.name) return null;
      return this.addLocal({ ...meta, body });
    } catch (e) { return null; }
  }

  /* ---------- 导出为 Markdown 文件 ---------- */
  exportMarkdown(id) {
    const skill = this.getById(id);
    if (!skill) return null;
    return { filename: skill.id + ".md", content: serializeFrontmatter(skill) };
  }

  /* ---------- 从 Markdown 文件导入 ---------- */
  importMarkdown(text) {
    const { meta, body } = parseFrontmatter(text);
    if (!meta.name) return null;
    return this.add({ ...meta, body }, "import");
  }

  get stats() {
    const all = [...this._marketSkills, ...this._localSkills];
    return { total: all.length, market: this._marketSkills.length, local: this._localSkills.length, builtin: BUILTIN_WORKFLOWS.length };
  }
  get size() { return this._marketSkills.length + this._localSkills.length + BUILTIN_WORKFLOWS.length; }
  get builtinWorkflows() { return BUILTIN_WORKFLOWS; }
}

module.exports = { SkillStore, BUILTIN_WORKFLOWS, parseFrontmatter, serializeFrontmatter };
