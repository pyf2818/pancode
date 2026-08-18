/* 验证 ⑫ 会话结束沉淀记忆（save_session_memory 工具）
 * 用 LlmAgent 原型 + 最小 mock 驱动 execTool，覆盖：
 *   决策/经验/反例 三类分类落库、Skill 顺带沉淀、空输入不写入
 */
"use strict";
const { LlmAgent } = require("../../server/agent-llm");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

(async () => {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = { planMode: false };
  a.emit = () => {};
  const mem = [];
  a.memory = {
    add: (type, topic, content) => {
      if (!content || !content.trim()) return null;
      mem.push({ type, topic, content: content.trim() });
      return { id: "m" + mem.length };
    },
  };
  const skills = [];
  a.skills = {
    add: (s) => { skills.push(s); return { name: s.name, _duplicate: false }; },
  };

  console.log("== ⑫ 会话结束沉淀记忆 ==");

  const r = await a.execTool("save_session_memory", {
    decisions: ["聊天记录持久化用 SQLite 而非 JSON"],
    lessons: ["gap 报告『未做』项不可信，先读代码复核"],
    rejected: ["不要直接整文件覆盖 Monaco，用 apply_edit 片段"],
    skill: { name: "pancode-agent-tool", description: "加工具三步法", trigger: "给 agent 加工具", body: "..." },
  });
  ok("返回含沉淀计数", /已沉淀 3 条记忆/.test(r));
  ok("含 Skill 名", /pancode-agent-tool/.test(r));
  ok("决策→decision 类", mem.some((m) => m.type === "decision" && m.content.includes("SQLite")));
  ok("经验→lesson 类", mem.some((m) => m.type === "lesson" && m.content.includes("不可信")));
  ok("反例→error 类", mem.some((m) => m.type === "error" && m.content.includes("apply_edit")));
  ok("Skill 已存", skills.length === 1 && skills[0].name === "pancode-agent-tool");

  const empty = await a.execTool("save_session_memory", {});
  ok("空输入不写入", /没有可沉淀的内容/.test(empty));
  const empty2 = await a.execTool("save_session_memory", { decisions: ["  "], lessons: [], rejected: [] });
  ok("空白条目忽略", /没有可沉淀的内容/.test(empty2));

  console.log("\n⑫ SESSION MEMORY OK=" + (fail === 0) + "  (pass=" + pass + ", fail=" + fail + ")");
  process.exit(fail === 0 ? 0 : 1);
})();
