/* ============================================================
   工作流模板存储 — 把反复出现的任务流程沉淀为可复用模板

   内置模板（BUILTINS）覆盖常见研发流程；用户也可把当前计划
   存为自定义模板（save_template），下次用 instantiate_template
   一键实例化为可执行的 plan，配合 set_goal 实现「目标驱动」。

   模板结构:
     { name, description, title, tasks: [string], builtin }

   存储: .pancode/workflows/{workspaceHash}.json（仅自定义模板）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

/* 内置工作流模板（标题/步骤中的 {goal} 会在实例化时被目标文本替换） */
const BUILTINS = [
  {
    name: "ship",
    description: "一站式交付：从目标到提交沉淀的端到端全流程（推荐）",
    title: "一站式交付：{goal}",
    tasks: [
      "明确目标与验收标准",
      "调研相关代码与现状",
      "设计实现方案并列出影响面",
      "编写核心实现",
      "补充测试并确保全部通过",
      "更新文档与使用说明",
      "自检改动并提交（git）",
      "沉淀经验教训与可复用模板",
    ],
  },
  {
    name: "review",
    description: "代码审查：按优先级输出问题清单与改进建议",
    title: "代码审查：{goal}",
    tasks: ["确定审查范围与关注点", "检查正确性与潜在缺陷", "检查安全与性能风险", "检查可读性与可维护性", "按优先级汇总问题清单与建议"],
  },
  {
    name: "feature",
    description: "通用功能开发：从调研到自测落地的完整闭环",
    title: "实现功能：{goal}",
    tasks: ["调研相关代码与现状", "设计实现方案", "编写核心实现", "补充单元测试", "自测与修复", "更新相关文档/说明"],
  },
  {
    name: "bugfix",
    description: "缺陷修复：定位根因并验证修复",
    title: "修复缺陷：{goal}",
    tasks: ["复现并定位问题", "分析根因", "制定修复方案", "实施修复", "补充回归测试", "验证修复结果"],
  },
  {
    name: "refactor",
    description: "代码重构：在保持行为不变前提下改善结构",
    title: "重构：{goal}",
    tasks: ["梳理当前结构与风险点", "设计目标结构", "分步重构", "确保测试通过", "检查性能与可读性"],
  },
  {
    name: "test",
    description: "新增/补全测试：覆盖关键路径",
    title: "为 {goal} 编写测试",
    tasks: ["确定测试边界与用例", "搭建测试脚手架", "编写测试用例", "运行并修复失败项"],
  },
  {
    name: "docs",
    description: "文档编写：从大纲到校对",
    title: "编写文档：{goal}",
    tasks: ["梳理文档大纲", "撰写正文", "补充示例", "校对与格式检查"],
  },
];

class WorkflowStore {
  constructor(filePath) {
    this._path = filePath;
    this._custom = [];
    this._load();
  }

  _load() {
    try { this._custom = JSON.parse(fs.readFileSync(this._path, "utf8")) || []; } catch (e) { this._custom = []; }
  }
  _save() { require("./safe-write").saveJson(this._path, this._custom); }

  /* 列出全部模板（内置 + 自定义），供 list_templates 工具返回 */
  list() {
    const builtins = BUILTINS.map((b) => ({ ...b, builtin: true }));
    const custom = this._custom.map((c) => ({ ...c, builtin: false }));
    return builtins.concat(custom);
  }

  /* 按名称查找（大小写不敏感），找不到返回 null */
  find(name) {
    const lower = String(name || "").trim().toLowerCase();
    if (!lower) return null;
    const b = BUILTINS.find((x) => x.name === lower);
    if (b) return { ...b, builtin: true };
    const c = this._custom.find((x) => x.name.toLowerCase() === lower);
    return c ? { ...c, builtin: false } : null;
  }

  /* 保存为自定义模板（同名则覆盖）；tasks 为空返回 null */
  save(name, description, title, tasks) {
    if (!name || !Array.isArray(tasks) || tasks.length === 0) return null;
    const lower = String(name).trim().toLowerCase();
    const rec = {
      name: lower,
      description: description || "",
      title: title || ("执行：" + lower),
      tasks: tasks.slice(),
    };
    const existing = this._custom.find((x) => x.name.toLowerCase() === lower);
    if (existing) Object.assign(existing, rec);
    else this._custom.push(rec);
    this._save();
    return { ...rec, builtin: false };
  }

  /* 删除自定义模板（内置不可删）；成功返回 true */
  remove(name) {
    const lower = String(name || "").trim().toLowerCase();
    const before = this._custom.length;
    this._custom = this._custom.filter((x) => x.name.toLowerCase() !== lower);
    const ok = this._custom.length !== before;
    if (ok) this._save();
    return ok;
  }
}

/* 把 {goal} 占位符替换成实际目标文本 */
function fillGoal(text, goal) {
  if (typeof text !== "string") return text;
  return goal ? text.replace(/\{goal\}/g, goal) : text;
}

module.exports = { WorkflowStore, BUILTINS, fillGoal };
