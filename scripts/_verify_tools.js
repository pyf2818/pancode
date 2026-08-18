/* 验证 agent-llm.js 的 TOOLS 常量已定义，并被正确传入 chatStream（ReAct 循环可运行）
   通过 Module._load 覆写 ./llm ./agent-base ./config 的 require，无需真实 LLM / 文件系统。 */
const Module = require("module");
const path = require("path");
const fs = require("fs");

let toolsSeen = null;
let rounds = 0;

/* 当前 TOOLS 全集（随 Phase 2 扩容，保持与 agent-llm.js 同步） */
const EXPECT_TOOLS = [
  "list_files", "read_file", "write_file", "apply_edit", "delete_file",
  "search_code", "run_command", "repo_map", "search_symbol",
  "search_memory", "get_diagnostics", "undo",
  "create_skill", "create_plan", "update_plan",
  "list_templates", "instantiate_template", "save_template", "remove_template",
  "set_goal", "goal_status", "save_session_memory", "agent", "local_agent",
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
  emit(ev) { if (ev && ev.type === "agent.trace") { (this.__trace = this.__trace || []).push(ev.event || ev); } }
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

  /* P2 可观测：agent.trace 必须随 ReAct 循环实时 emit（Trace 面板依赖此事件） */
  const trace = a.__trace || [];
  if (trace.length < 2) errs.push("agent.trace 事件未实时 emit（Trace 面板收不到数据），实际 " + trace.length);
  else {
    const types = trace.map((e) => e.type);
    if (!types.includes("llm.round")) errs.push("缺少 llm.round trace 事件");
    if (!types.includes("tool.call")) errs.push("缺少 tool.call trace 事件");
    for (const e of trace) {
      if (typeof e.seq !== "number" || typeof e.t !== "number" || !e.data) errs.push("trace 事件结构异常: " + e.type);
    }
  }

  /* P2 可观测：trace 落盘持久化——flush 后磁盘 JSONL 必须存在且有内容（跨会话回看依赖） */
  await a._flushTrace();
  const traceFile = path.join(mockConfig.ROOT, ".pancode", "agent-traces", "default.jsonl");
  let diskLines = 0;
  try { diskLines = fs.readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean).length; } catch (e) {}
  if (diskLines < 2) errs.push("trace 未落盘到磁盘（diskLines=" + diskLines + "）");
  try { fs.unlinkSync(traceFile); } catch (e) {}   // 清理测试产物

  if (errs.length) { console.error("FAIL:\n - " + errs.join("\n - ")); process.exit(1); }
  console.log("PASS: TOOLS 已定义（" + toolsSeen.length + " 个工具），ReAct 循环正常启动并通过工具调用跑到结束；agent.trace 实时 emit " + trace.length + " 条并已落盘 " + diskLines + " 行 JSONL（llm.round / tool.call 等）。");
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
