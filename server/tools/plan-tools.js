"use strict";
/* 计划工具：create_plan / update_plan / set_goal / goal_status */
const { fillGoal } = require("../workflow-store");

module.exports = {
  create_plan: async (agent, args) => {
    const plan = agent.plan.create(agent._currentConv, args.title, args.tasks);
    if (plan) {
      agent.emit({ type: "plan.created", plan, convId: plan.convId });
      return "计划已创建: " + plan.title + " (" + plan.tasks.length + " 个任务)";
    }
    return "计划创建失败";
  },

  update_plan: async (agent, args) => {
    const active = agent.plan.getActive(agent._currentConv);
    if (!active) return "没有活跃的计划";
    const plan = agent.plan.updateTask(active.id, args.taskIndex, args.status, args.note);
    if (plan) {
      agent.emit({ type: "plan.updated", plan, convId: plan.convId });
      const task = plan.tasks[args.taskIndex];
      return "任务 " + (args.taskIndex + 1) + " 状态更新为: " + args.status + (args.note ? " (" + args.note + ")" : "");
    }
    return "任务更新失败";
  },

  set_goal: async (agent, args) => {
    const goal = (args.goal || "").trim();
    if (!goal) {
      agent._goal = null; agent._saveGoal();
      agent.emit({ type: "goal.set", goal: null });
      return "已清除会话目标";
    }
    agent._goal = goal; agent._saveGoal();
    agent.emit({ type: "goal.set", goal });
    let extra = "";
    if (args.template) {
      const tpl = agent.workflows.find(args.template);
      if (tpl) {
        const title = fillGoal(tpl.title, goal);
        const tasks = tpl.tasks.map((x) => fillGoal(x, goal));
        const plan = agent.plan.create(agent._currentConv, title, tasks);
        if (plan) {
          agent.emit({ type: "plan.created", plan, convId: plan.convId });
          extra = "；已用模板「" + tpl.name + "」生成执行计划（" + plan.tasks.length + " 步）";
        }
      } else {
        extra = "（提示：模板「" + args.template + "」未找到，已仅设定目标）";
      }
    }
    return "已设定会话目标：" + goal + extra;
  },

  goal_status: async (agent, args) => {
    if (!agent._goal) return "当前未设定会话目标（可用 set_goal 设定）";
    const active = agent.plan.getActive(agent._currentConv);
    let txt = "【会话目标】" + agent._goal + "\n";
    if (active) {
      const done = active.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
      txt += "【执行计划】" + active.title + "（" + done + "/" + active.tasks.length + " 完成）\n";
      active.tasks.forEach((t, i) => {
        const icon = t.status === "done" ? "✅" : t.status === "in_progress" ? "🔄" : t.status === "skipped" ? "⏭️" : "⬜";
        txt += "  " + (i + 1) + ". " + icon + " " + t.text + "\n";
      });
    } else {
      txt += "【执行计划】尚未创建（可用 instantiate_template 或 create_plan）";
    }
    return txt;
  },
};
