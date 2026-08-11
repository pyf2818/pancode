/* 验证 agent-llm.js 的 TOOLS 常量已定义，并被正确传入 chatStream（ReAct 循环可运行）
   通过 Module._load 覆写 ./llm ./agent-base ./config 的 require，无需真实 LLM / 文件系统。 */
const Module = require("module");
const path = require("path");

let toolsSeen = null;
let rounds = 0;

/* 当前 TOOLS 全集（随 Phase 2 扩容，保持与 agent-llm.js 同步） */
const EXPECT_TOOLS = [
  "list_files", "read_file", "write_file", "delete_file",
  "search_code", "run_command", "repo_map", "search_symbol",
  "search_memory", "create_skill", "create_plan", "update_plan",
].sort();

const mockLlm = {
  async chatStream(cfg, messages, tools, cb) {
    toolsSeen = tools; // 关键断言点：tools 必须已定义且为 12 个函数
    if (rounds === 0) {
      rounds = 1;
      if (cb && cb.onReasoning) cb.onReasoning("思考：需要先读文件");
      return {
        content: "", reasoning: "思考：需要先读文件",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: JSON.stringify({ path: "app.js" }) }],
        finish: "tool",
      };
    }
    if (cb && cb.onContent) cb.onContent("已读取并完成任务。");
    return { content: "已读取并完成任务。", reasoning: "", toolCalls: [], finish: "stop" };
  },
  async ping() { return true; },
};

class AgentBase {
  constructor(ctx) { this.ctx = ctx; this.cfg = ctx.cfg; this.files = ctx.files; this.term = ctx.term; }
  emit() {}
  tool() { return { body() {}, done() {} }; }
  thinkStart() { return { delta() {}, end() {} }; }
  msgStart() { return { delta() {}, end() {} }; }
  async say() {}
  fileChanged() {}
  pushChanges() { return []; }
  state() {}
  resolveApproval() {}
}

const mockConfig = { ROOT: path.resolve(__dirname, "..") };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./llm") return mockLlm;
  if (request === "./agent-base") return { AgentBase };
  if (request === "./config") return mockConfig;
  return origLoad.apply(this, arguments);
};

const { LlmAgent } = require(path.join(__dirname, "..", "server", "agent-llm.js"));

(async () => {
  const ctx = {
    cfg: {
      llm: { baseURL: "http://x", apiKey: "y", model: "m", maxToolRounds: 5 },
      permissions: { mode: "auto", allow: [], deny: [] },
      persona: { active: "fullstack" },
      rules: { enabled: false },
      memory: { enabled: false },
      context: { budgetTokens: 1000, autoCompact: false },
      workspace: "workspace",
    },
    files: { list: () => [], read: () => "console.log(1);", write: () => {}, exists: () => true, remove: () => {}, search: () => [] },
    term: { run: async () => ({ out: "", code: 0 }) },
  };
  const a = new LlmAgent(ctx);
  a.running = false;
  await a.handleChat("请读取 app.js 并说明作用");

  const errs = [];
  if (!Array.isArray(toolsSeen)) errs.push("TOOLS 未定义或非数组");
  else {
    if (toolsSeen.length !== EXPECT_TOOLS.length) errs.push("TOOLS 数量应为 " + EXPECT_TOOLS.length + "，实际 " + toolsSeen.length);
    const names = toolsSeen.map((t) => t.function && t.function.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(EXPECT_TOOLS)) errs.push("TOOLS 名称不符: " + names.join(","));
    // 校验 schema 形态
    for (const t of toolsSeen) {
      if (t.type !== "function" || !t.function || !t.function.parameters) errs.push("工具 schema 形态错误: " + t.function && t.function.name);
    }
  }
  if (rounds < 1) errs.push("chatStream 未被调用（ReAct 未启动）");

  if (errs.length) { console.error("FAIL:\n - " + errs.join("\n - ")); process.exit(1); }
  console.log("PASS: TOOLS 已定义（" + toolsSeen.length + " 个工具），ReAct 循环正常启动并通过工具调用跑到结束。");
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
