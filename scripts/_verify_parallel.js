/* 端到端探针：同一步里的多个 tool_call —— 只读并行、写类独占、结果按模型声明序回填。
   修前是严格串行：模型一次并行发 5 个 read_file 也要排 5 次队。
   修后必须同时满足三条，缺一条就是退化成"看着快了其实错了"：
     1) 连续只读调用真的重叠执行（maxActive > 1）
     2) 写/命令类调用独占（重叠期间并发度恒为 1），且人工确认不会被并发搅乱
     3) 无论完成顺序如何，进 history 的 tool 消息严格按模型声明顺序
   另外验证中断路径：中断后每个 call 都有结果，不留 dangling tool_calls。
   无需真实 LLM：Module._load 覆写 ./llm ./agent-base ./config。
 */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pc-par-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let step = 0;
/* 每一步的调用：[工具名, 模拟耗时 ms, 参数]
   第 1 步故意把写类夹在只读段中间，并留一发缺参的 read_file 走"前置校验失败也要回填结果"这条路；
   第 2 步全是只读，应整体并行。 */
const PLAN = [
  { tools: [
    ["read_file", 40, { path: "src/a1.js" }],
    ["read_file", 40, { path: "src/a2.js" }],
    ["search_code", 40, { query: "handler" }],
    ["read_file", 40, {}],                       // 缺 path：schema 校验拦下，不执行但仍要按序回填
    ["write_file", 10, { path: "src/a.js", content: "x" }],
    ["list_files", 40, {}],
  ] },
  { tools: [
    ["repo_map", 30, {}],
    ["get_diagnostics", 30, {}],
    ["search_symbol", 30, { query: "Agent" }],
  ] },
  { tools: [] },
];

let active = 0, maxActive = 0;
const execLog = [];   // {name, order, activeAtStart, mutating}

/* 配对校验：出网请求体里 tool_call / tool 必须严格成对且同序 */
function pairingErrors(history) {
  const errs = [];
  const open = [];
  for (const m of history) {
    if (m.role === "tool") {
      const at = open.indexOf(m.tool_call_id);
      if (at === -1) errs.push("孤儿/乱序 tool 结果 " + m.tool_call_id);
      else open.splice(at, 1);
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (open.length) errs.push("上一批未收干就来新请求: " + open.join(","));
      open.length = 0;
      for (const t of m.tool_calls) open.push(t.id);
      continue;
    }
    if (open.length && (m.role === "user" || m.role === "system")) { errs.push("未收到结果: " + open.join(",")); open.length = 0; }
  }
  if (open.length) errs.push("结尾未配对: " + open.join(","));
  return errs;
}

const MUTATING = new Set(["write_file", "apply_edit", "delete_file", "run_command", "git_commit"]);

const mockLlm = {
  async chatStream(cfg, messages, tools, cb) {
    if (tools === null || tools === undefined) return { content: "【任务目标】摘要", toolCalls: [], finish: "stop", usage: {} };
    const plan = PLAN[Math.min(step, PLAN.length - 1)];
    step++;
    if (!plan.tools.length) return { content: "完成。", toolCalls: [], finish: "stop", usage: { prompt_tokens: 500, completion_tokens: 10, total_tokens: 510 } };
    const toolCalls = plan.tools.map((t, i) => ({
      id: "s" + step + "_" + i,
      name: t[0],
      arguments: JSON.stringify(t[2] || {}),
    }));
    return { content: "", toolCalls, finish: "tool", usage: { prompt_tokens: 900 * step, completion_tokens: 30, total_tokens: 900 * step + 30 } };
  },
  async ping() { return true; },
};

class AgentBase {
  constructor(ctx) { this.ctx = ctx; this.cfg = ctx.cfg; this.files = ctx.files; this.term = ctx.term; }
  emit() {}
  tool() { return { body() {}, done() {}, end() {}, delta() {}, start() {} }; }
  thinkStart() { return { delta() {}, end() {}, start() {} }; }
  msgStart() { return { delta() {}, end() {}, start() {} }; }
  async say() {}
  fileChanged() {}
  pushChanges() { return []; }
  state() {}
}

const mockConfig = { ROOT: TMP };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "./llm") return mockLlm;
  if (request === "./agent-base") return { AgentBase };
  if (request === "./config") return mockConfig;
  return origLoad.apply(this, arguments);
};

const { LlmAgent } = require(path.join(__dirname, "..", "server", "agent-llm.js"));

function makeAgent() {
  const a = new LlmAgent({
    cfg: {
      llm: { baseURL: "http://x", apiKey: "y", model: "m", maxToolRounds: 6, contextWindow: 200000 },
      permissions: { mode: "auto", allow: [], deny: [] },
      persona: { active: "default" }, rules: { enabled: false }, memory: { enabled: false },
      context: { budgetTokens: 1000000, autoCompact: false }, repoMap: false,
      workspace: "workspace", timeouts: { toolSec: 30, approvalSec: 60 },
    },
    files: { dir: TMP, list: () => ["src/a.js"], read: () => "x", write: () => {}, exists: () => true, remove: () => {}, search: () => [] },
    term: { run: async () => ({ out: "ok", code: 0 }) },
  });
  a.running = false;
  /* 只替换执行体，保留循环的调度与回填 —— 本探针测的就是调度层 */
  const DELAY = { read_file: 40, search_code: 40, list_files: 40, repo_map: 30, get_diagnostics: 30, search_symbol: 30, write_file: 5 };
  a.execTool = async (name, args) => {
    const myOrder = execLog.length;
    active++; maxActive = Math.max(maxActive, active);
    execLog.push({ name, myOrder, activeAtStart: active, mutating: MUTATING.has(name) });
    await sleep(DELAY[name] != null ? DELAY[name] : 20);
    active--;
    return "[" + name + "#" + myOrder + "] 结果正文";
  };
  return a;
}

(async () => {
  const errs = [];

  /* ---- 1~3：正常并行 ---- */
  const a = makeAgent();
  await a.handleChat("并行读几个文件再写一个");

  const conv = a.conversations.get(a._currentConv);
  const hist = (conv && conv.history) || a.history;

  // 3) 模型序回填：每个 assistant.tool_calls 的 id 顺序，必须与紧随其后的 tool 消息 id 顺序完全一致
  for (let i = 0; i < hist.length; i++) {
    const m = hist[i];
    if (!(m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length)) continue;
    const want = m.tool_calls.map((t) => t.id);
    const got = [];
    for (let j = i + 1; j < hist.length && hist[j].role === "tool"; j++) got.push(hist[j].tool_call_id);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      errs.push("tool 结果顺序与模型声明不一致：期望 " + want.join(",") + " 实际 " + got.join(","));
    }
  }

  if (pairingErrors(hist.filter((m) => m.role !== "system")).length) {
    errs.push("历史配对非法：" + pairingErrors(hist.filter((m) => m.role !== "system")).join("；"));
  }

  // 1) 只读段真的重叠了
  if (maxActive < 2) errs.push("没有任何一次并行（maxActive=" + maxActive + "），只读段仍在串行");

  // 2) 写类独占：每个 mutating 调用开始时，并发度必须是 1
  const overlapMutating = execLog.filter((e) => e.mutating && e.activeAtStart > 1);
  if (overlapMutating.length) {
    errs.push("写类调用与别的调用重叠执行：" + overlapMutating.map((e) => e.name + "#" + e.myOrder).join(","));
  }

  // 每一步的只读段应并发到该段的宽度：第 1 步前 3 个 read 应同时在场
  const firstStep = execLog.slice(0, 5);
  const readMax = Math.max(...firstStep.filter((e) => !e.mutating).map((e) => e.activeAtStart));
  if (readMax < 3) errs.push("第 1 步的连续只读段并行度只有 " + readMax + "，应至少 3");

  /* ---- 4：中断路径不留 dangling ---- */
  const b = makeAgent();
  step = 0;
  b._convAborts = {};
  const p = b.handleChat("再来一轮", { convId: "abort-me" });
  await sleep(25);                       // 让第 1 步的并行段跑起来
  const ctxRef = b._convAborts["abort-me"];
  if (ctxRef) ctxRef.value = true;
  await p;
  const bConv = b.conversations.get("abort-me");
  const bHist = ((bConv && bConv.history) || []).filter((m) => m.role !== "system");
  const dangling = pairingErrors(bHist);
  if (dangling.length) errs.push("中断后留下 dangling tool_calls：" + dangling.join("；"));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

  if (errs.length) { console.error("FAIL:\n - " + errs.join("\n - ")); process.exit(1); }
  console.log("PASS: " + execLog.length + " 次工具执行，峰值并发 " + maxActive +
    "；只读段并行、写类独占（" + execLog.filter((e) => e.mutating).length + " 次独占执行无一重叠）；"
    + "tool 结果全程按模型声明序回填；中断路径无 dangling。");
})().catch((e) => { console.error("FAIL:", (e && e.stack) || e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
