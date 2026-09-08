"use strict";
/* 模板工具：list_templates / instantiate_template / save_template / remove_template */
const { fillGoal } = require("../workflow-store");

module.exports = {
  list_templates: async (agent, args) => {
    const all = agent.workflows.list();
    if (!all.length) return "暂无可用模板";
    const builtins = all.filter((t) => t.builtin);
    const custom = all.filter((t) => !t.builtin);
    let txt = "内置模板（" + builtins.length + "）:\n";
    builtins.forEach((t) => { txt += "  - " + t.name + "：" + t.description + "（" + t.tasks.length + " 步）\n"; });
    if (custom.length) {
      txt += "自定义模板（" + custom.length + "）:\n";
      custom.forEach((t) => { txt += "  - " + t.name + "：" + t.description + "（" + t.tasks.length + " 步）\n"; });
    }
    return txt;
  },

  instantiate_template: async (agent, args) => {
    const tpl = agent.workflows.find(args.name);
    if (!tpl) return "未找到模板：" + args.name + "（可用 list_templates 查看）";
    const goal = args.goal || "";
    const title = fillGoal(tpl.title, goal);
    const tasks = tpl.tasks.map((x) => fillGoal(x, goal));
    const plan = agent.plan.create(agent._currentConv, title, tasks);
    if (plan) {
      agent.emit({ type: "plan.created", plan, convId: plan.convId });
      return "已用模板「" + tpl.name + "」生成计划：" + title + "（" + plan.tasks.length + " 步）";
    }
    return "计划生成失败";
  },

  save_template: async (agent, args) => {
    let tasks = args.tasks;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      const active = agent.plan.getActive(agent._currentConv);
      if (!active) return "没有活跃计划，且未提供 tasks，无法保存模板";
      tasks = active.tasks.map((t) => t.text);
    }
    const rec = agent.workflows.save(args.name, args.description, args.title, tasks);
    if (rec) return "已保存模板：" + rec.name + "（" + rec.tasks.length + " 步）";
    return "模板保存失败（需提供 name 与步骤）";
  },

  remove_template: async (agent, args) => {
    const ok = agent.workflows.remove(args.name);
    if (ok) return "已删除自定义模板：" + args.name;
    return "未找到自定义模板：" + args.name + "（内置模板不可删）";
  },
};
