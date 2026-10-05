/* 端到端探针：system 前缀在多轮之间必须逐字节稳定，运行态只动尾巴。
   这条测的是 P1-6 的真实收益 —— 上游前缀缓存按字节命中，
   只要有一段常变内容混在 system 里，它之后的整段前缀每轮都作废。
   修前的形态：aug（记忆+规则+计划+技能+仓库结构）拼成一块，
   其中"计划进度"和"目标"是**本轮开始时冻结**的，于是
     ① 前缀里嵌着每轮都该变的东西，模型连跑 20 轮看到的还是第 0 轮进度；
     ② 一旦让它每轮重算，整条前缀就每轮失效。
   修后：稳定段在前，运行态作为一条 user 消息发到历史末尾，且每轮刷新。
 */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pc-pctx-"));
const rounds = [];   // 每一轮实际发给 LLM 的 messages（原样引用，稍后比对）

let turn = 0;
let planDone = 0;

const mockLlm = {
  async chatStream(cfg, messages, tools, cb) {
    if (tools === null || tools === undefined) return { content: "【任务目标】摘要", toolCalls: [], finish: "stop", usage: {} };
    rounds.push(JSON.parse(JSON.stringify(messages)));
    turn++;
    if (turn === 1) {
      return { content: "", toolCalls: [{ id: "p1", name: "create_plan", arguments: JSON.stringify({ title: "改造内核", tasks: ["读代码", "写实现", "补测试"] }) }], finish: "tool", usage: { prompt_tokens: 2000, completion_tokens: 20, total_tokens: 2020 } };
    }
    if (turn <= 4) {
      // 每轮标掉一步计划进度 —— 这正是"运行态必须跟着变"的那部分
      return { content: "", toolCalls: [{ id: "u" + turn, name: "update_plan", arguments: JSON.stringify({ taskIndex: turn - 2, status: "done" }) }], finish: "tool", usage: { prompt_tokens: 2000 + turn * 100, completion_tokens: 20, total_tokens: 2020 } };
    }
    return { content: "全部完成。", toolCalls: [], finish: "stop", usage: { prompt_tokens: 2600, completion_tokens: 30, total_tokens: 2630 } };
  },
  async ping() { return true; },
};

class AgentBase {
  constructor(ctx) { this.ctx = ctx; this.cfg = ctx.cfg; this.files = ctx.files; this.term = ctx.term; }
  emit() {}
  tool() { return { body() {}, done() {}, end() {}, start() {} }; }
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

/* 把 messages 拆成 [system 前缀] / [其余] */
function splitSystem(messages) {
  let i = 0;
  while (i < messages.length && messages[i].role === "system") i++;
  return { prefix: messages.slice(0, i), rest: messages.slice(i) };
}

(async () => {
  const errs = [];
  const a = new LlmAgent({
    cfg: {
      llm: { baseURL: "http://x", apiKey: "y", model: "m", maxToolRounds: 8, contextWindow: 200000 },
      permissions: { mode: "auto", allow: [], deny: [] },
      persona: { active: "fullstack", systemPrompt: "" },
      rules: { enabled: false },
      memory: { enabled: false },
      context: { budgetTokens: 1000000, autoCompact: false },
      repoMap: false,
      workspace: "workspace",
      timeouts: { toolSec: 30, approvalSec: 60 },
    },
    files: { dir: TMP, list: () => ["src/a.js"], read: () => "x", write: () => {}, exists: () => true, remove: () => {}, search: () => [] },
    term: { run: async () => ({ out: "ok", code: 0 }) },
  });
  a.running = false;
  a._goal = "把内核上下文层改造到可无人值守";
  await a.handleChat("开始改造，目标已经给你了");

  if (rounds.length < 3) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    console.error("FAIL: 只跑了 " + rounds.length + " 轮，探针无法验证多轮稳定性");
    process.exit(1);
  }

  /* 0) 自检：计划工具必须真的执行过。
        上一版探针把参数名写成 steps/task_index，被 schema 校验拦下 —— 轮次照样跑、
        runtime_context 照样在，但进度恒为 0，断言 3 会误报成"产品没刷新运行态"。
        先坐实"工具确实执行、计划确实建了"，后面的进度断言才有意义。 */
  {
    const conv0 = a.conversations.get(a._currentConv);
    const blocked = ((conv0 && conv0.history) || []).filter((m) => m.role === "tool" && /参数校验未通过/.test(String(m.content || "")));
    if (blocked.length) errs.push("探针自己的工具调用被参数校验拦下 " + blocked.length + " 次，运行态断言失去依据（检查 create_plan/update_plan 的参数名）");
    if (!a.plan.size) errs.push("create_plan 没有落库，计划进度断言无从验证");
  }

  /* 1) system 前缀逐字节稳定 */
  const prefixes = rounds.map((m) => splitSystem(m).prefix);
  const first = JSON.stringify(prefixes[0]);
  prefixes.forEach((p, i) => {
    if (JSON.stringify(p) !== first) errs.push("第 " + (i + 1) + " 轮的 system 前缀与第 1 轮不一致（前缀缓存会整段失效）");
  });
  // 运行态不该出现在 system 块里
  for (const p of prefixes) {
    const joined = p.map((m) => String(m.content)).join("\n");
    if (/【本次会话目标】|【当前执行计划|实时进度/.test(joined)) errs.push("运行态仍混在 system 块里，会推翻整条前缀缓存");
  }

  /* 2) 运行态恰好出现一次，且在末尾 */
  rounds.forEach((m, i) => {
    const rcIdx = m.findIndex((x) => /<runtime_context>/.test(String(x.content || "")));
    if (rcIdx === -1) { errs.push("第 " + (i + 1) + " 轮末尾没有运行态快照"); return; }
    if (rcIdx !== m.length - 1) errs.push("第 " + (i + 1) + " 轮运行态不在最末尾（它是第 " + rcIdx + " 条，共 " + m.length + " 条）");
    if (m[rcIdx].role !== "user") errs.push("运行态快照的 role 应为 user，实际 " + m[rcIdx].role);
    const all = m.filter((x) => /<runtime_context>/.test(String(x.content || "")));
    if (all.length !== 1) errs.push("第 " + (i + 1) + " 轮出现了 " + all.length + " 份运行态快照（应每轮只留最新一份）");
  });

  /* 3) 计划进度跟着轮次走，不是本轮开始时的冻结值 */
  const progressOf = (m) => {
    const rc = m.find((x) => /<runtime_context>/.test(String(x.content || "")));
    if (!rc) return null;
    const mm = String(rc.content).match(/已完成 (\d+)\/(\d+) 步/);
    // null = 这一轮的快照里没有计划进度行（第 1 轮计划还没建、最后一轮计划已完成）；
    // 不能记成 0，否则序列里的 0 分不清"没进度"和"进度被冻结"。
    return mm ? Number(mm[1]) : null;
  };
  const seq = rounds.map(progressOf);
  const seenProgress = seq.filter((v) => v !== null);
  if (new Set(seenProgress).size < 2) {
    errs.push("运行态里的计划进度全程没变（" + JSON.stringify(seq) + "）—— 说明它仍是本轮开始时的冻结快照");
  }
  if (seenProgress.length && Math.max(...seenProgress) < Math.min(...seenProgress)) errs.push("进度出现倒退");
  // 分母必须恒定：变了说明计划被反复重建，运行态在给自己造假进度
  const totals = new Set(rounds.map((m) => {
    const rc = m.find((x) => /<runtime_context>/.test(String(x.content || "")));
    const mm = rc && String(rc.content).match(/已完成 \d+\/(\d+) 步/);
    return mm ? Number(mm[1]) : null;
  }).filter((v) => v !== null));
  if (totals.size > 1) errs.push("计划总步数在轮次间变化（" + [...totals].join(",") + "）—— 计划被反复重建");
  // 目标必须在运行态里点名，模型才可能"围绕目标推进"
  const lastRc = String((rounds[rounds.length - 1].find((x) => /<runtime_context>/.test(String(x.content || ""))) || {}).content || "");
  if (!lastRc.includes("把内核上下文层改造到可无人值守")) errs.push("会话目标没有出现在运行态快照里");

  /* 4) 运行态不进 history（它是 model-only 的，不能污染存档与 UI） */
  const conv = a.conversations.get(a._currentConv);
  const hist = (conv && conv.history) || [];
  if (hist.some((m) => /<runtime_context>/.test(String(m.content || "")))) {
    errs.push("运行态快照被写进了持久化 history（应保持 model-only，不污染存档与界面）");
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

  if (errs.length) { console.error("FAIL:\n - " + errs.join("\n - ")); process.exit(1); }
  console.log("PASS: " + rounds.length + " 轮请求，system 前缀逐字节一致；运行态每轮刷新且只在末尾出现一次"
    + "（进度序列 " + seq.filter((v) => v !== null).join("→") + "）；未落入持久化 history。");
})().catch((e) => { console.error("FAIL:", (e && e.stack) || e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
