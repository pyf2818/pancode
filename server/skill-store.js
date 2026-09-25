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
const os = require("os");

/* ---------- W1：导入安全审计（对齐 skills-security-check 流程） ----------
   扫描 Skill 全文（description/body 内嵌命令与代码），分级：
   P0 = 任意代码执行 / 系统破坏 / 凭据窃取 → 拒绝导入，用户显式确认（force）才放行
   P1 = 网络外发 / 提权 / 全局安装 / 系统目录写入 → 允许但附警告
   P2 = 通过
   注：正则清单防不住 base64 混淆等语义级绕过（W15 语义解析范围），故 P0 保留人工裁决出口。 */
const AUDIT_PATTERNS = [
  { level: "P0", re: /require\s*\(\s*["']child_process["']\s*\)/i, desc: "调用 child_process 子进程模块（任意命令执行能力）" },
  { level: "P0", re: /\beval\s*\(/, desc: "使用 eval 动态执行代码" },
  { level: "P0", re: /new\s+Function\s*\(/, desc: "使用 new Function 动态构造执行" },
  { level: "P0", re: /(curl|wget)[^|]*\|\s*(sh|bash|zsh|powershell)\b/i, desc: "下载内容直接管道执行（curl|sh 类）" },
  { level: "P0", re: /\b(rm\s+-[a-z]*r[a-z]*f|del\s+\/[fsq]|rd\s+\/s|mkfs\b|format\s+[a-z]:|dd\s+if=)/i, desc: "递归删除 / 格式化 / 写设备等破坏性命令" },
  { level: "P0", re: /readFile\S*\([^)]*\.env|cat\s+\.env|type\s+\.env/i, desc: "疑似读取 .env 凭据文件" },
  { level: "P1", re: /\b(fetch\s*\(|axios[.(]|XMLHttpRequest|http\.request|urllib\.request)/, desc: "包含网络请求（数据可能外发）" },
  { level: "P1", re: /\b(sudo\b|chmod\s+\+?x|icacls\b)/i, desc: "提权 / 修改执行权限命令" },
  { level: "P1", re: /\bnpm\s+(install|i)\s+-g\b|\bpip\s+install\s+(-g|--user)\b/i, desc: "全局安装依赖" },
  { level: "P1", re: /(\/etc\/|C:\\\\Windows|\\Windows\\|\/System\/|regedit\b|reg\s+add)/i, desc: "写入 / 修改系统目录或注册表" },
  { level: "P1", re: /powershell\s+-enc|base64\s+-d\b|atob\s*\(/i, desc: "编码 / 混淆执行痕迹" },
];

function auditSkill(text) {
  const s = String(text || "");
  const findings = [];
  for (const p of AUDIT_PATTERNS) {
    const m = p.re.exec(s);
    if (m) findings.push({ level: p.level, desc: p.desc, snippet: s.slice(Math.max(0, m.index - 20), m.index + m[0].length + 40).replace(/\s+/g, " ").slice(0, 120) });
  }
  const order = { P0: 3, P1: 2, P2: 1 };
  let level = "P2";
  for (const f of findings) if (order[f.level] > order[level]) level = f.level;
  return { level, findings };
}

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
  text = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
  if (skill.risk_level) lines.push("risk_level: " + skill.risk_level);
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
    risk_level: skill.risk_level || "",       // W1：风险等级（服务端审计结果为准，自声明仅展示）
    scope: skill.scope || "",                 // W1：user=用户级（跨项目），空=项目级
    source: source || skill.source || "manual",
    ts: skill.ts || Date.now(),
    deprecated: skill.deprecated || false,
  };
}

class SkillStore {
  constructor(marketDir, localPath, builtinDir, userDir) {
    this._marketDir = marketDir;
    this._localPath = localPath;
    this._builtinDir = builtinDir || null;   // 打包内置 skills（只读，asar 内）
    this._userDir = userDir || path.join(os.homedir(), ".pancode", "skills"); // W1：用户级（跨项目）
    this._marketSkills = [];
    this._localSkills = [];
    this._builtinSkills = [];
    this._userSkills = [];
    this._load();
  }

  _load() {
    // 市场 Skills（.md 文件，用户可写）
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
    // 工作区 Skills（JSON，Agent 沉淀）
    this._localSkills = [];
    try {
      this._localSkills = JSON.parse(fs.readFileSync(this._localPath, "utf8")) || [];
    } catch (e) {}
    // 打包内置 Skills（.md，只读；asar 内随安装包分发，EXE 下也能展示）
    this._builtinSkills = [];
    if (this._builtinDir) {
      try {
        const files = fs.readdirSync(this._builtinDir).filter((f) => f.endsWith(".md"));
        for (const f of files) {
          try {
            const text = fs.readFileSync(path.join(this._builtinDir, f), "utf8");
            const { meta, body } = parseFrontmatter(text);
            this._builtinSkills.push(normalize({ ...meta, body, id: "builtin_" + f.replace(/\.md$/, "") }, "builtin"));
          } catch (e) {}
        }
      } catch (e) {}
    }
    // W1：用户级 Skills（~/.pancode/skills/*.md，跨项目；同名时项目级优先）
    this._userSkills = [];
    try {
      fs.mkdirSync(this._userDir, { recursive: true });
      const ufiles = fs.readdirSync(this._userDir).filter((f) => f.endsWith(".md"));
      for (const f of ufiles) {
        try {
          const text = fs.readFileSync(path.join(this._userDir, f), "utf8");
          const { meta, body } = parseFrontmatter(text);
          this._userSkills.push(normalize({ ...meta, body, scope: "user", id: "user_" + f.replace(/\.md$/, "") }, "manual"));
        } catch (e) {}
      }
    } catch (e) {}
  }

  /* W1：项目级与用户级合并去重（同名项目级覆盖用户级） */
  _mergedUserSkills() {
    const marketNames = new Set(this._marketSkills.map((s) => s.name));
    return this._userSkills.filter((s) => !marketNames.has(s.name) && !s.deprecated);
  }

  _saveUser() {
    try {
      fs.mkdirSync(this._userDir, { recursive: true });
      const existing = new Set(fs.readdirSync(this._userDir).filter((f) => f.endsWith(".md")));
      const current = new Set();
      for (const s of this._userSkills) {
        const fname = s.id.replace(/^user_/, "") + ".md";
        current.add(fname);
        try { fs.writeFileSync(path.join(this._userDir, fname), serializeFrontmatter(s), "utf8"); } catch (e) {} /* W1：单文件锁（EPERM）不拖垮整批 */
      }
      for (const f of existing) if (!current.has(f)) { try { fs.unlinkSync(path.join(this._userDir, f)); } catch (e) {} }
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
        try { fs.writeFileSync(path.join(this._marketDir, fname), serializeFrontmatter(s), "utf8"); } catch (e) {} /* W1：单文件锁（EPERM）不拖垮整批 */
      }
      for (const f of existing) if (!current.has(f)) { try { fs.unlinkSync(path.join(this._marketDir, f)); } catch (e) {} }
    } catch (e) {}
  }

  _saveLocal() {
    require("./safe-write").saveJson(this._localPath, this._localSkills);
  }

  /* ---------- CRUD ---------- */
  add(skill, source, opts) {
    if (!skill || !skill.name) return null;
    opts = opts || {};
    /* W1：重名池按 scope 区分——项目级 add 允许与用户级同名（这正是覆盖路径），
       用户级 add 仍查全池（避免装出一个永远被项目级遮蔽的影子技能） */
    const dupPool = opts.scope === "user" ? [...this._marketSkills, ...this._userSkills, ...this._localSkills] : [...this._marketSkills, ...this._localSkills];
    if (dupPool.some((s) => s.name === skill.name && !s.deprecated)) return { ...dupPool.find((s) => s.name === skill.name && !s.deprecated), _duplicate: true };
    /* W1：装前安全审计——P0 需用户显式确认（force），P1 附警告入库 */
    const audit = auditSkill((skill.name || "") + "\n" + (skill.description || "") + "\n" + (skill.body || ""));
    if (audit.level === "P0" && !opts.force) return { _auditRejected: audit };
    const entry = normalize(skill, source || "manual");
    entry.risk_level = audit.level;   // 审计结果为准
    entry._audit = audit;
    if (opts.scope === "user") {
      entry.scope = "user";
      entry.id = "user_" + (skill.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
      this._userSkills.push(entry);
      this._saveUser();
    } else {
      this._marketSkills.push(entry);
      this._saveMarket();
    }
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
    idx = this._userSkills.findIndex((s) => s.id === id);
    if (idx !== -1) { this._userSkills.splice(idx, 1); this._saveUser(); return true; }
    return false;
  }

  getById(id) { return this._marketSkills.find((s) => s.id === id) || this._localSkills.find((s) => s.id === id) || this._userSkills.find((s) => s.id === id) || null; }

  list(opts) {
    opts = opts || {};
    const all = [...this._marketSkills, ...this._mergedUserSkills(), ...this._localSkills];
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
    const all = [...this._marketSkills, ...this._mergedUserSkills(), ...this._localSkills, ...BUILTIN_WORKFLOWS, ...this._builtinSkills];
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
    const all = [...this._marketSkills, ...this._mergedUserSkills(), ...this._localSkills, ...BUILTIN_WORKFLOWS, ...this._builtinSkills];
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
    const all = [...this._marketSkills, ...this._localSkills, ...this._builtinSkills];
    return { total: all.length, market: this._marketSkills.length, local: this._localSkills.length, builtin: BUILTIN_WORKFLOWS.length + this._builtinSkills.length };
  }
  get size() { return this._marketSkills.length + this._localSkills.length + BUILTIN_WORKFLOWS.length + this._builtinSkills.length; }
  get builtinWorkflows() {
    if (!this._normalizedBuiltin) {
      this._normalizedBuiltin = BUILTIN_WORKFLOWS.map((w, i) => normalize({ ...w, id: "wf_" + i }, "workflow"));
    }
    return [...this._normalizedBuiltin, ...this._builtinSkills.map((s) => ({ ...s, source: "workflow" }))];
  }
}

module.exports = { SkillStore, auditSkill, BUILTIN_WORKFLOWS, parseFrontmatter, serializeFrontmatter };
