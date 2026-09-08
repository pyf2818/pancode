"use strict";
/* Agent 工具：agent / orchestrate / undo */
const { Orchestrator } = require("../orchestrator");

module.exports = {
  undo: async (agent, args) => {
    const t = agent.tool("edit", "撤销上一步", "undo");
    const r = agent._undoLast();
    if (!r.ok) {
      if (r.reason === "empty") { t.done(false, "无可撤销", false); return "当前没有可撤销的改动（还没有执行过写入 / 编辑 / 删除操作，或进程重启后检查点已清空）。"; }
      t.done(false, "撤销失败", false);
      return "撤销失败：" + (r.reason || "未知错误");
    }
    t.body("已撤销：" + r.label + "\n恢复文件：" + r.restored.join(", "));
    t.done(true, "已撤销 " + r.restored.length + " 个文件", false);
    return "已撤销操作「" + r.label + "」，恢复 " + r.restored.length + " 个文件：" + r.restored.join(", ");
  },

  agent: async (agent, args) => {
    const t = agent.tool("agent", "子智能体", args.task);
    agent.state(true, "子智能体执行中");
    try {
      const result = await agent.runSubAgent(args.task, { subagent_type: args.subagent_type });
      t.body((result || "(子智能体无返回)").slice(0, 6000));
      t.done(true, "子智能体完成");
      agent.state(false, "AI 思考中");
      return "子智能体已完成子任务「" + args.task + "」，汇报如下：\n\n" + (result || "(无返回)");
    } catch (e) {
      t.done(false, "子智能体失败");
      agent.state(false, "AI 思考中");
      return "子智能体执行失败：" + e.message;
    }
  },

  orchestrate: async (agent, args) => {
    const t = agent.tool("agent", "多 Agent 编排", args.title || "编排");
    agent.state(true, "编排执行中");
    try {
      const orch = new Orchestrator(agent);
      const result = await orch.run({ title: args.title, steps: args.steps });
      t.body((result.fullReport || result.summary || "").slice(0, 8000));
      t.done(result.ok !== false, result.summary || "编排完成");
      agent.state(false, "AI 思考中");
      return result.summary + "\n\n" + (result.fullReport || "").slice(0, 6000);
    } catch (e) {
      t.done(false, "编排失败");
      agent.state(false, "AI 思考中");
      return "多 Agent 编排执行失败：" + e.message;
    }
  },
};
