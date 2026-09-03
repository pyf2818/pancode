/* ============================================================
   Agent Team — 多智能体协作团队

   预设 8 个专业角色，用户可通过 @ 召唤任意组合协作。
   所有被召唤的 agent 共享同一份上下文（工作区 + 对话历史 +
   其他成员的输出），形成协作流水线。

   存储: .pancode/teams/{workspaceHash}.json
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

/* 预设智能体角色 */
const PRESET_AGENTS = [
  {
    id: "architect", name: "架构师", icon: "🎯", color: "#a78bfa",
    desc: "系统架构设计、技术选型、模块划分",
    systemPrompt: "你是一位资深软件架构师。你的职责是：分析需求、设计系统架构、做技术选型、划分模块边界、识别风险点。" +
      "你擅长从全局视角规划方案，输出清晰的架构设计文档和接口定义。" +
      "请聚焦架构层面，不要写具体实现代码。输出要结构化、有层次。",
    tools: ["read_file", "search_code", "search_symbol", "repo_map", "list_files", "web_search", "web_fetch"],
  },
  {
    id: "frontend", name: "前端工程师", icon: "🎨", color: "#60a5fa",
    desc: "UI 实现、交互逻辑、样式编写",
    systemPrompt: "你是一位前端工程师。你的职责是：实现 UI 界面、编写交互逻辑、处理样式和响应式布局。" +
      "你精通 HTML/CSS/JS、主流框架和组件设计。请根据架构师的设计方案或直接需求，写出高质量的前端代码。" +
      "修改文件后请确保代码可运行、无语法错误。",
    tools: ["read_file", "write_file", "search_code", "search_symbol", "repo_map", "list_files", "run_command"],
  },
  {
    id: "backend", name: "后端工程师", icon: "⚙️", color: "#34d399",
    desc: "API 设计、数据库、业务逻辑",
    systemPrompt: "你是一位后端工程师。你的职责是：设计 API、实现业务逻辑、处理数据模型和数据库交互。" +
      "你精通 Node.js/Python/Go 等后端技术栈。请根据需求写出健壮的后端代码，注意错误处理和安全性。",
    tools: ["read_file", "write_file", "search_code", "search_symbol", "repo_map", "list_files", "run_command"],
  },
  {
    id: "tester", name: "测试工程师", icon: "🧪", color: "#fbbf24",
    desc: "编写和运行测试、质量保证",
    systemPrompt: "你是一位测试工程师。你的职责是：编写单元测试/集成测试、运行测试套件、分析失败原因、保障代码质量。" +
      "你精通各种测试框架和断言库。请根据功能实现编写对应的测试用例，运行测试并修复发现的问题。",
    tools: ["read_file", "write_file", "search_code", "search_symbol", "repo_map", "list_files", "run_command"],
  },
  {
    id: "reviewer", name: "代码审查员", icon: "🔍", color: "#f87171",
    desc: "代码审查、安全检查、最佳实践",
    systemPrompt: "你是一位严谨的代码审查员。你的职责是：审查代码质量、检查安全漏洞、识别性能问题、确保最佳实践。" +
      "请逐文件审查改动，按严重程度分类输出问题清单和改进建议。不要直接修改代码，只输出审查意见。",
    tools: ["read_file", "search_code", "search_symbol", "repo_map", "list_files"],
  },
  {
    id: "devops", name: "运维工程师", icon: "🚀", color: "#22d3ee",
    desc: "部署、CI/CD、监控配置",
    systemPrompt: "你是一位运维工程师。你的职责是：配置部署流程、编写 CI/CD 脚本、设置监控和日志。" +
      "你精通 Docker/K8s/CI-CD 等运维工具链。请根据项目需求配置自动化流程。",
    tools: ["read_file", "write_file", "search_code", "list_files", "run_command"],
  },
  {
    id: "doc", name: "文档工程师", icon: "📝", color: "#fde047",
    desc: "文档编写、API 文档、用户指南",
    systemPrompt: "你是一位文档工程师。你的职责是：编写技术文档、API 文档、用户指南和 README。" +
      "你擅长把复杂技术概念用清晰的语言表达。请根据代码和需求编写结构化文档。",
    tools: ["read_file", "write_file", "search_code", "search_symbol", "repo_map", "list_files"],
  },
  {
    id: "pm", name: "项目经理", icon: "📋", color: "#c084fc",
    desc: "任务拆分、进度跟踪、风险管控",
    systemPrompt: "你是一位项目经理。你的职责是：分析需求、拆分任务、评估工作量、跟踪进度、识别风险。" +
      "请把复杂需求拆解为可执行的任务列表，标注优先级和依赖关系。不要写代码，只做项目管理和协调。",
    tools: ["read_file", "search_code", "repo_map", "list_files", "web_search"],
  },
];

class TeamStore {
  constructor(filePath) {
    this._path = filePath;
    this._teams = [];
    this._load();
  }

  _load() {
    try { this._teams = JSON.parse(fs.readFileSync(this._path, "utf8")) || []; } catch (e) { this._teams = []; }
  }
  _save() { require("./safe-write").saveJson(this._path, this._teams); }

  /* 列出预设智能体 */
  static presets() { return PRESET_AGENTS; }
  static presetById(id) { return PRESET_AGENTS.find((a) => a.id === id); }

  /* 列出所有团队 */
  list() { return this._teams; }

  /* 创建团队 */
  create(name, memberIds) {
    const team = {
      id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: name || "新团队",
      members: (memberIds || []).map((id) => {
        const p = TeamStore.presetById(id);
        return p ? { id: p.id, name: p.name, icon: p.icon, color: p.color } : null;
      }).filter(Boolean),
      messages: [],
      ts: Date.now(),
    };
    this._teams.push(team);
    this._save();
    return team;
  }

  /* 按 ID 查找 */
  find(id) { return this._teams.find((t) => t.id === id); }

  /* 添加消息 */
  addMessage(teamId, msg) {
    const team = this.find(teamId);
    if (!team) return null;
    msg.ts = Date.now();
    team.messages.push(msg);
    this._save();
    return msg;
  }

  /* 添加/移除成员 */
  addMember(teamId, agentId) {
    const team = this.find(teamId);
    if (!team) return null;
    if (team.members.find((m) => m.id === agentId)) return team;
    const p = TeamStore.presetById(agentId);
    if (!p) return team;
    team.members.push({ id: p.id, name: p.name, icon: p.icon, color: p.color });
    this._save();
    return team;
  }
  removeMember(teamId, agentId) {
    const team = this.find(teamId);
    if (!team) return null;
    team.members = team.members.filter((m) => m.id !== agentId);
    this._save();
    return team;
  }

  /* 删除团队 */
  remove(teamId) {
    const before = this._teams.length;
    this._teams = this._teams.filter((t) => t.id !== teamId);
    const ok = this._teams.length !== before;
    if (ok) this._save();
    return ok;
  }
}

module.exports = { TeamStore, PRESET_AGENTS };