"use strict";
/* 交互工具：ask_user_choice */
module.exports = {
  ask_user_choice: async (agent, args) => {
    if (!args.question || !Array.isArray(args.options) || args.options.length < 2) {
      return "错误: ask_user_choice 需要 question（字符串）和 options（至少 2 个选项的数组）。";
    }
    const opts = args.options.slice(0, 6).map((o) => ({ label: String(o.label || ""), description: String(o.description || "") }));
    const t = agent.tool("ask", "用户决策", args.question.slice(0, 80));
    t.body(args.question + "\n" + opts.map((o, i) => (i + 1) + ". " + o.label).join("\n"));
    const result = await agent.requestChoice(args.question, opts);
    if (result.choice == null) {
      t.done(false, "用户未选择");
      return "用户未做出选择（超时或取消）。请直接在回复中向用户提问，或自行选择一个合理方案继续。";
    }
    t.done(true, "用户选择了: " + result.choice);
    return "用户选择了: " + result.choice + "\n请根据该选择继续执行。";
  },
};
