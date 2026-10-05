/* 端到端探针：真实 ReAct 循环里，发给 LLM 的每一个请求体都必须 tool 配对。
   单元测只验证 history 形状；这里验证的是真正出网的 messages 数组
   ——「压缩后重建请求」和「加载旧存档」两条路径都覆盖。
   无需真实 LLM / 浏览器：Module._load 覆写 ./llm ./agent-base ./config。

   断言：
     A. 全程每一次 chatStream 收到的请求体都不含孤儿 tool 消息
     B. 本轮确实触发过自动压缩（否则 A 什么都没测到）
     C. 存档里中断留下的半轮，加载后被补成保守的「未收到结果」且请求体合法
   修复前的真实故障形态：压缩时把命中「已写入」关键词的 role:"tool" 单独留下
   （带不回它的 assistant.tool_calls）→ 压缩后第一次请求 400。
 */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pc-ctxpair-"));
const requests = [];          // 每一次发给 LLM 的 messages（已剥掉前导 system 块）
let phaseAReqs = 0;           // 长任务阶段的请求数（数组会在 C 阶段前清空，单独记账）
let compacted = 0;

/* ---------- 配对校验：与 test/p0-harness-fixes.test.js 同一判据 ---------- */
function pairingErrors(history) {
  const errs = [];
  const declared = new Set();
  for (const m of history) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) for (const t of m.tool_calls) declared.add(t.id);
  }
  const open = [];
  for (const m of history) {
    if (m.role === "tool") {
      if (!declared.has(m.tool_call_id)) errs.push("孤儿 tool 结果 " + m.tool_call_id);
      const at = open.indexOf(m.tool_call_id);
      if (at === -1) errs.push("结果没有对应的进行中请求：" + m.tool_call_id);
      else open.splice(at, 1);
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (open.length) errs.push("未收到结果的 call: " + open.join(","));
      open.length = 0;
      for (const t of m.tool_calls) open.push(t.id);
      continue;
    }
    if (open.length && (m.role === "user" || m.role === "system")) {
      errs.push("未收到结果的 call: " + open.join(","));
      open.length = 0;
    }
  }
  if (open.length) errs.push("结尾仍有未配对 call: " + open.join(","));
  return errs;
}

/* ---------- 假 LLM ---------- */
let turn = 0;
const BIG = "这是文件正文，中文居多用来验证 CJK 计权。".repeat(60);
const mockLlm = {
  async chatStream(cfg, messages, tools, cb) {
    if (tools === null || tools === undefined) {
      // 压缩摘要请求：返回一个明显更短的文本，让 shrink 判定通过
      return { content: "【任务目标】继续读文件\n【已改文件】无", reasoning: "", toolCalls: [], finish: "stop", usage: {} };
    }
    // 记录请求体的「历史段」：剥掉前导 system 块（那部分是拼装用的，不参与配对）
    let i = 0;
    while (i < messages.length && messages[i].role === "system") i++;
    requests.push(JSON.parse(JSON.stringify(messages.slice(i))));

    turn++;
    const idbase = "call_r" + turn;
    if (turn <= 4) {
      // 每轮两个并行调用 —— 正是旧选区算法最容易切半的地方
      return {
        content: "", reasoning: "",
        toolCalls: [
          { id: idbase + "a", name: "read_file", arguments: JSON.stringify({ path: "src/a" + turn + ".js" }) },
          { id: idbase + "b", name: "run_command", arguments: JSON.stringify({ command: "node t" + turn + ".js" }) },
        ],
        finish: "tool",
        usage: { prompt_tokens: 900 * turn, completion_tokens: 40, total_tokens: 900 * turn + 40 },
      };
    }
    return { content: "任务完成。", reasoning: "", toolCalls: [], finish: "stop", usage: { prompt_tokens: 3600, completion_tokens: 20, total_tokens: 3620 } };
  },
  async ping() { return true; },
};

class AgentBase {
  constructor(ctx) { this.ctx = ctx; this.cfg = ctx.cfg; this.files = ctx.files; this.term = ctx.term; }
  emit(ev) { if (ev && ev.type === "context.compact") compacted++; }
  tool() { return { body() {}, done() {}, end() {}, delta() {}, start() {} }; }
  thinkStart() { return { delta() {}, end() {}, start() {} }; }
  msgStart() { return { delta() {}, end() {}, start() {} }; }
  async say() {}
  fileChanged() {}
  pushChanges() { return []; }
  state() {}
  resolveApproval() {}
}

const mockConfig = { ROOT: TMP };

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./llm") return mockLlm;
  if (request === "./agent-base") return { AgentBase };
  if (request === "./config") return mockConfig;
  return origLoad.apply(this, arguments);
};

const { LlmAgent } = require(path.join(__dirname, "..", "server", "agent-llm.js"));

function baseCtx() {
  return {
    cfg: {
      llm: { baseURL: "http://x", apiKey: "y", model: "m", maxToolRounds: 10, contextWindow: 4000 },
      permissions: { mode: "auto", allow: [], deny: [] },
      persona: { active: "fullstack" },
      rules: { enabled: false },
      memory: { enabled: false },
      // 预算刻意压得很小，逼循环在中途触发自动压缩
      context: { budgetTokens: 1200, autoCompact: true },
      repoMap: false,
      workspace: "workspace",
      timeouts: { toolSec: 30, approvalSec: 60 },
    },
    files: {
      // 真实服务里 files.dir 就是挂载根、与 cfg.workspace 指向同一个目录；替身必须守这个不变量，
      // 否则分片键会按替身里那个"更可信"的 files.dir 走，存档就写到别处去了。
      dir: path.resolve(TMP, "workspace"),
      list: () => ["src/a1.js", "src/a2.js"],
      read: () => BIG,
      write: () => {}, exists: () => true, remove: () => {}, search: () => [],
    },
    // 输出刻意带「已写入」：这正是旧版 isCritical 关键词命中、把 tool 结果单独
    // 留在压缩产物里的触发条件。去掉它，本探针就失去了牙齿。
    term: { run: async () => ({ out: "已写入 dist/bundle.js，测试通过\n", code: 0 }) },
  };
}

/* 把带「半轮」的存档写成 pancode 真实落盘的样子。
   路径必须问 ws-key 要：探针自己再算一遍哈希就等于又养一套键，键一统一就静默失配。 */
function seedDanglingConversation(convId) {
  const file = require(path.join(__dirname, "..", "server", "ws-key.js"))
    .forWorkspace(path.resolve(TMP, "workspace"), TMP)
    .file(path.join(TMP, ".pancode", "conversations"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = Date.now();
  const body = {
    v: 1, updated: t, current: convId,
    conversations: [{
      id: convId, round: 3, ts: t, changes: [],
      history: [
        { role: "user", content: "上次让你重构，你跑到一半服务重启了" },
        { role: "assistant", content: "", tool_calls: [
          { id: "old1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/a1.js\"}" } },
          { id: "old2", type: "function", function: { name: "run_command", arguments: "{\"command\":\"node x.js\"}" } },
        ] },
        // 只有 old1 回来了 —— old2 是中断留下的 dangling call
        { role: "tool", tool_call_id: "old1", content: BIG.slice(0, 200) },
        // 再混一枚孤儿结果：它的 assistant 早被更早的一次压缩吞了
        { role: "tool", tool_call_id: "ghost", content: "没人请求过这条结果" },
      ],
    }],
  };
  fs.writeFileSync(file, JSON.stringify(body), "utf8");
  return body;
}

(async () => {
  const errs = [];

  /* ---- A + B：正常长任务，中途必然压缩 ---- */
  const a = new LlmAgent(baseCtx());
  a.running = false;
  await a.handleChat("把 src 下的模块逐个读一遍并跑测试");

  if (!requests.length) errs.push("chatStream 一次都没被调用");
  requests.forEach((msgs, idx) => {
    const bad = pairingErrors(msgs);
    if (bad.length) errs.push("第 " + (idx + 1) + " 次请求体配对非法：" + bad.join("；"));
  });
  if (!compacted) errs.push("本轮没有触发自动压缩，A 的断言等于没测（把 budgetTokens 调大或把正文加长）");

  /* ---- C：旧存档半轮恢复 ---- */
  phaseAReqs = requests.length;
  requests.length = 0;
  const convId = "dangling-" + Date.now();
  seedDanglingConversation(convId);
  const b = new LlmAgent(baseCtx());
  b.running = false;
  const loaded = b.conversations.get(convId);
  if (!loaded) errs.push("预置存档没被加载回来（分片路径与 Agent 读的不是同一个）");
  else {
    const stillDangling = pairingErrors(loaded.history);
    if (stillDangling.length) errs.push("加载后仍是半轮：" + stillDangling.join("；"));
    const synth = loaded.history.filter((m) => m.role === "tool" && /未收到结果/.test(String(m.content)));
    if (synth.length !== 1) errs.push("应当恰好补回 1 条「未收到结果」（old2），实际 " + synth.length);
    else if (synth[0].tool_call_id !== "old2") errs.push("补错了 id：" + synth[0].tool_call_id);
    if (loaded.history.some((m) => m.tool_call_id === "ghost")) errs.push("孤儿结果 ghost 应被丢弃");
  }
  // 直接指定 convId 再发一次请求，验证出网的请求体真的合法
  b._currentConv = convId;
  await b.handleChat("继续", { convId });
  requests.forEach((msgs, idx) => {
    const bad = pairingErrors(msgs);
    if (bad.length) errs.push("恢复旧存档后第 " + (idx + 1) + " 次请求体配对非法：" + bad.join("；"));
  });
  if (!requests.some((msgs) => msgs.some((m) => /未收到结果/.test(String(m.content || ""))))) {
    errs.push("修复出来的「未收到结果」没有出现在出网的请求里（说明修复没进到真实链路）");
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

  if (errs.length) { console.error("FAIL:\n - " + errs.join("\n - ")); process.exit(1); }
  const nReq = phaseAReqs + requests.length;
  console.log("PASS: 校验 " + nReq + " 次真实出网请求体（长任务 " + phaseAReqs + " + 旧存档恢复 " + requests.length
    + "），tool_call / tool 结果全程严格成对；中途自动压缩 " + compacted + " 次；"
    + "旧存档半轮（1 个 dangling call 已补保守结果 + 1 枚孤儿结果已丢弃）并进入真实请求链路。");
})().catch((e) => { console.error("FAIL:", (e && e.stack) || e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
