"use strict";
/* 记忆 / Skill 工具：search_memory / save_session_memory / create_skill */
module.exports = {
  search_memory: async (agent, args) => {
    const t = agent.tool("read", "搜索记忆", args.query);
    const results = agent.memory.search(args.query, { type: args.type, limit: 10 });
    const txt = results.length
      ? results.map((e) => "[" + e.type + "] " + (e.topic ? e.topic + "：" : "") + e.content).join("\n")
      : "无相关记忆";
    t.body(txt);
    t.done(true, results.length + " 条记忆");
    return txt;
  },

  create_skill: async (agent, args) => {
    const t = agent.tool("edit", "创建 Skill", args.name);
    const sk = agent.skills.add({
      name: args.name,
      description: args.description || "",
      trigger: args.trigger || "",
      body: args.body || "",
    });
    if (sk && !sk._duplicate) {
      t.done(true, "Skill 已创建: " + sk.name);
      return "Skill 创建成功: " + sk.name + " (id: " + sk.id + ")";
    }
    t.done(false, sk && sk._duplicate ? "同名 Skill 已存在" : "创建失败");
    return sk && sk._duplicate ? "同名 Skill 已存在: " + sk.name : "Skill 创建失败";
  },

  save_session_memory: async (agent, args) => {
    const decisions = Array.isArray(args.decisions) ? args.decisions : [];
    const lessons = Array.isArray(args.lessons) ? args.lessons : [];
    const rejected = Array.isArray(args.rejected) ? args.rejected : [];
    let saved = 0;
    decisions.forEach((d) => { if (agent.memory.add("decision", "会话决策", String(d).trim())) saved++; });
    lessons.forEach((l) => { if (agent.memory.add("lesson", "经验教训", String(l).trim())) saved++; });
    rejected.forEach((r) => { if (agent.memory.add("error", "被拒操作/反例", String(r).trim())) saved++; });
    let skillName = null;
    if (args.skill && args.skill.name) {
      const sk = agent.skills.add({
        name: args.skill.name,
        description: args.skill.description || "",
        trigger: args.skill.trigger || "",
        body: args.skill.body || "",
      });
      if (sk && !sk._duplicate) skillName = sk.name;
    }
    const summary = "已沉淀 " + saved + " 条记忆"
      + (decisions.length ? "（决策 " + decisions.length + "）" : "")
      + (lessons.length ? "（经验 " + lessons.length + "）" : "")
      + (rejected.length ? "（反例 " + rejected.length + "）" : "")
      + (skillName ? "；已存 Skill：" + skillName : "");
    if (saved === 0 && !skillName) return "没有可沉淀的内容（decisions/lessons/rejected 均为空且无 skill）";
    agent.emit({ type: "session.memory.saved", count: saved, skill: skillName });
    return summary;
  },
};
