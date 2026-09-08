/* 回归验证 ask_user_choice 链路：
   1) execTool 触发后必须 emit tool.ask_choice（含 id/question/options）
   2) 用户选择 → resolveChoice 解除等待 → 返回所选方案
   3) abort() 中断 → pending 解除 + 广播合成 tool.end（前端卡片收尾）
   4) 参数非法 → 返回错误提示而不挂起 */
const path = require("path");
const Module = require("module");

let toolsSeen = [];
const events = [];

const mockLlm = {
  async chatStream() { return { content: "", toolCalls: [], finish: "stop" }; },
  async ping() { return true; },
};
class AgentBase {
  constructor(ctx) { this.ctx = ctx; this.cfg = ctx.cfg; this.files = ctx.files; this.term = ctx.term; }
  emit(ev) { events.push(ev); }
  tool(kind, name, target) { return { body() {}, done() {} }; }
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
  const a = new LlmAgent({
    cfg: {
      llm: { baseURL: "http://x", apiKey: "y", model: "m" },
      permissions: { mode: "auto", allow: [], deny: [] },
      persona: { active: "fullstack" },
      rules: { enabled: false }, memory: { enabled: false },
      context: { budgetTokens: 1000000, autoCompact: false },
      workspace: "workspace",
    },
    files: { list: () => [], read: () => "", write: () => {}, exists: () => true, remove: () => {}, search: () => [] },
    term: { run: async () => ({ out: "", code: 0 }) },
  });
  a.running = false;

  const errs = [];
  const find = (t) => events.filter((e) => e.type === t);

  /* 1) 正常选择流程 */
  const p1 = a.execTool("ask_user_choice", {
    question: "用哪种方案？",
    options: [{ label: "方案A", description: "快" }, { label: "方案B", description: "稳" }],
  });
  await new Promise((r) => setTimeout(r, 30));
  const asks = find("tool.ask_choice");
  if (!asks.length) errs.push("FAIL: 未 emit tool.ask_choice");
  else {
    const ev = asks[asks.length - 1];
    if (!ev.id || ev.question !== "用哪种方案？" || !Array.isArray(ev.options) || ev.options.length !== 2)
      errs.push("FAIL: tool.ask_choice 载荷不完整: " + JSON.stringify(ev));
    const ok = a.resolveChoice(ev.id, "方案A");
    if (!ok) errs.push("FAIL: resolveChoice 未找到 pending");
    const r1 = await p1;
    if (!/方案A/.test(String(r1))) errs.push("FAIL: 选择结果未回传 Agent: " + r1);
  }

  /* 2) abort 中断收尾 */
  events.length = 0;
  const p2 = a.execTool("ask_user_choice", { question: "q2", options: [{ label: "x" }, { label: "y" }] });
  await new Promise((r) => setTimeout(r, 30));
  a.abort();
  const r2 = await p2;
  if (!/未做出选择/.test(String(r2))) errs.push("FAIL: abort 后未正确解除等待: " + r2);
  const ends = find("tool.end").filter((e) => String(e.id).startsWith("choice_"));
  if (!ends.length) errs.push("FAIL: abort 未广播合成 tool.end 供前端收尾");

  /* 3) 参数非法不挂起 */
  const r3 = await Promise.race([
    a.execTool("ask_user_choice", { question: "q3", options: [{ label: "only-one" }] }),
    new Promise((r) => setTimeout(() => r("HANG"), 1500)),
  ]);
  if (r3 === "HANG") errs.push("FAIL: 非法参数导致挂起");
  else if (!/错误/.test(String(r3))) errs.push("FAIL: 非法参数未返回错误提示: " + r3);

  if (errs.length) { console.log(errs.join("\n")); process.exit(1); }
  console.log("PASS ask_user_choice: emit载荷完整 / 用户选择回传 / abort广播收尾 / 非法参数不挂起");
  process.exit(0);
})();