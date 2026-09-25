"use strict";
/* 记忆 / Skill 工具：search_memory / save_session_memory / create_skill */
const fs = require("fs");
const path = require("path");
const { MemoryStore } = require("../memory-store.js");

module.exports = {
  search_memory: async (agent, args) => {
    const t = agent.tool("read", "搜索记忆", args.query);
    let results, note = "";
    if (args.scope === "global") {
      /* W3：跨会话检索——当前工作区（内存实例，含未落盘更新）+ 其他工作区分片 + 用户级（只读惰性） */
      const shards = [];
      try {
        for (const f of fs.readdirSync(agent._memDir || ".")) {
          if (!f.endsWith(".json")) continue;
          const p = path.join(agent._memDir, f);
          if (p === agent.memory._path) continue;   // 当前分片由内存实例负责
          shards.push({ path: p, label: "项目 " + f.replace(".json", "").slice(0, 8) });
        }
      } catch (e) {}
      if (agent.userMemory) shards.push({ path: agent.userMemory._path, label: "用户级" });
      const local = agent.memory.search(args.query, { type: args.type, limit: 6, raw: true })
        .map((x) => { x.entry.__score = x.score; x.entry.__src = "当前项目"; return x.entry; });
      const remote = agent.userMemory && agent.userMemory._path === (agent.memory._path || "") ? []
        : MemoryStore.searchAll(shards, args.query, { type: args.type, limit: 12, perStore: 5 });
      results = [...local, ...remote].sort((a, b) => (b.__score || 0) - (a.__score || 0)).slice(0, 12);
      note = "（跨会话检索：当前项目 + 其他工作区 + 用户级）";
    } else {
      results = agent.memory.search(args.query, { type: args.type, limit: 10 });
    }
    const txt = results.length
      ? results.map((e) => "[" + (e.__src ? e.__src + "·" : "") + e.type + "] " + (e.topic ? e.topic + "：" : "") + e.content).join("\n")
      : "无相关记忆";
    t.body(txt);
    t.done(true, results.length + " 条记忆" + note);
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
    // W3：scope=user 时沉淀到用户级记忆（跨项目偏好/约定，如"我惯用中文变量名"）
    const mem = (args.scope === "user" && agent.userMemory) ? agent.userMemory : agent.memory;
    const scopeTag = mem === agent.userMemory ? "（用户级，跨项目生效）" : "";
    let saved = 0;
    // 价值分级：决策/教训 4 分（高），被拒反例 2 分（中）
    const VS = { decision: 4, lesson: 4, error: 2 };
    decisions.forEach((d) => { if (mem.add("decision", "会话决策", String(d).trim(), { valueScore: 4 })) saved++; });
    lessons.forEach((l) => { if (mem.add("lesson", "经验教训", String(l).trim(), { valueScore: 4 })) saved++; });
    rejected.forEach((r) => { if (mem.add("error", "被拒操作/反例", String(r).trim(), { valueScore: 2 })) saved++; });
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
    const summary = "已沉淀 " + saved + " 条记忆" + scopeTag
      + (decisions.length ? "（决策 " + decisions.length + "）" : "")
      + (lessons.length ? "（经验 " + lessons.length + "）" : "")
      + (rejected.length ? "（反例 " + rejected.length + "）" : "")
      + (skillName ? "；已存 Skill：" + skillName : "");
    if (saved === 0 && !skillName) return "没有可沉淀的内容（decisions/lessons/rejected 均为空且无 skill）";
    agent.emit({ type: "session.memory.saved", count: saved, skill: skillName });
    return summary;
  },
};
