/* 会话收尾自动结算实测（决策链 → 长期记忆）
   ————————————————————————————————————————————
   单测钉的是 _settleFromDecisions 的判读；这里钉的是**它真的在 handleChat 收尾被调到**，
   以及那条"[沉淀] 决策链沉淀 N 条"里的 N 等于盘上记忆库里确实多出来的条数。
   两段合起来才封住三个坑：
     1) 钩子写在函数里但没人调 —— 只有跑真循环才发现；
     2) N 数的是"add() 返回了 truthy"，而 add() 命中去重也返回旧条目 —— 数字会虚高；
     3) 模型自己已经 save_session_memory 过，收尾又补一遍近似条目（淹库）。
   全程用沙箱数据根：记忆与决策链都往那里写，一个字节都不落开发者的 .pancode。
   用法：node scripts/_verify_settle.js
*/
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "settle" });

const Module = require("module");
const path = require("path");
const fs = require("fs");

const memDir = path.join(SANDBOX.dataDir, ".pancode", "memory");
let plan = null, roundIdx = 0;
let contentSeen = "";

const mockLlm = {
  LlmAbortedError: class extends Error {},
  LlmError: class extends Error {},
  async chatStream(cfg, messages, tools, cb) {
    const act = (plan && plan[roundIdx]) || { content: "本轮收尾完成。" };
    roundIdx++;
    if (act.throw) throw new Error(act.throw);
    if (act.toolCalls) {
      return { content: "", reasoning: "", toolCalls: act.toolCalls, finish: "tool_calls" };
    }
    contentSeen = act.content || "本轮收尾完成。";
    if (cb && cb.onContent) cb.onContent(contentSeen);
    return { content: contentSeen, reasoning: "", toolCalls: [], finish: "stop" };
  },
  async ping() { return true; },
};
class AgentBase {
  constructor(ctx) { this.ctx = ctx; this.cfg = ctx.cfg; this.files = ctx.files; this.term = ctx.term; this.evts = []; this.cards = []; }
  /* emit 必须在构造期就存在：LlmAgent 构造里做的是 this.emit.bind(this)，
     少了这一步就只剩一句 "Cannot read properties of undefined (reading 'bind')"。 */
  emit(ev) { this.evts.push(ev); }
  tool(kind, name, target) {
    const rec = { kind, name, target, body: "", ok: null, label: "" };
    this.cards.push(rec);
    return { body: (t) => { rec.body = String(t); }, done: (o, l) => { rec.ok = o; rec.label = l; }, image() {}, end() {}, start() {}, delta() {} };
  }
  thinkStart() { return { delta() {}, end() {} }; }
  msgStart() { return { delta() {}, end() {} }; }
  async say() {}
  state() {}
  fileChanged() {}
  pushChanges() { return []; }
  resolveApproval() {}
}
const mockConfig = { ROOT: SANDBOX.dataDir };
const origLoad = Module._load;
Module._load = function (request) {
  const base = String(request).split(/[\\/]/).pop();
  if (base === "llm") return mockLlm;
  if (base === "config") return mockConfig;
  if (base === "agent-base") return { AgentBase };
  return origLoad.apply(this, arguments);
};
const { LlmAgent } = require(path.join(__dirname, "..", "server", "agent-llm.js"));
const DL = require(path.join(__dirname, "..", "server", "decision-log.js"));
Module._load = origLoad;
/* 装载钩子撤掉以后再引：memory-store 经 logger 会去要 config，
   在钩子还挂着时引它拿到的是 {ROOT} 那份假配置，日志路径会指错地方。 */
const { MemoryStore, isGuardEntry } = require(path.join(__dirname, "..", "server", "memory-store.js"));

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function mkAgent(cfgMem) {
  const a = new LlmAgent({
    cfg: {
      llm: { baseURL: "http://fake", apiKey: "k", model: "settle-test", maxToolRounds: 8, contextWindow: 32000 },
      permissions: { mode: "auto", allow: [], deny: [] },
      persona: {}, rules: { enabled: false }, context: {}, computer: {},
      memory: Object.assign({ enabled: true, autoSettle: true }, cfgMem || {}),
    },
    files: { list: () => [], read: () => "", write() {}, exists: () => true, remove() {}, search: () => [], dir: SANDBOX.wsDir },
    term: { run: async () => ({ out: "", code: 0 }) },
  });
  a.running = false;
  return a;
}

/* 记忆库是 saveJson 异步排队落盘的（safe-write），读之前得等它追上：
   不等就会看到"沉淀 2 条"而文件里 0 条 —— 那是落盘还没到，不是产品没写。 */
async function readMem() {
  for (let i = 0; i < 40; i++) {
    let files = [];
    try { files = fs.readdirSync(memDir).filter((f) => f.endsWith(".json")); } catch (e) { await wait(150); continue; }
    const all = [];
    for (const f of files) {
      try { const j = JSON.parse(fs.readFileSync(path.join(memDir, f), "utf8")); if (Array.isArray(j)) all.push(...j); } catch (e) { /* 半截 JSON：下一轮再读 */ }
    }
    if (all.length) return all;
    await wait(150);
  }
  return [];
}
const termText = (a) => a.evts.filter((e) => e.type === "term.line").map((e) => e.text).join("\n");
const N_IN_LINE = (t) => { const m = /决策链沉淀 (\d+) 条/.exec(t); return m ? Number(m[1]) : -1; };

(async () => {
  DL.setDecisionDir(path.join(SANDBOX.dataDir, ".pancode", "decisions"));

  /* ① 被否过的做法：收尾自动沉，且那条提示里的数字与盘上一致 */
  DL.recordDecision({ convId: "default", kind: "approval", action: "rejected", tool: "write_file", subject: "src/override.js", reason: "用户不接受整文件覆盖" });
  DL.recordDecision({ convId: "default", kind: "choice", action: "picked", subject: "按行区间读文件", detail: "整份读进来再截断", reason: "截断会丢掉中段" });
  plan = [
    { toolCalls: [{ id: "t1", name: "read_file", arguments: JSON.stringify({ path: "a.js" }) }] },
    { toolCalls: [{ id: "t2", name: "read_file", arguments: JSON.stringify({ path: "b.js" }) }] },
    { content: "两处都读完了。" },
  ];
  roundIdx = 0;
  const A = mkAgent();
  /* 收尾沉淀的门槛是"这一局改过盘，或至少跑到第 2 轮之后"（见 handleChat 里
     `changes.length || round >= 2`）。这条探针不真改盘，所以把这一局放到"已经第 2 轮"的状态——
     要满足的是门槛本身，不是绕过门槛：伪造 changes 就等于把要测的那道门拆掉。 */
  A.conversations.set("default", { history: [], round: 2, ts: Date.now(), changes: [] });
  await A.handleChat("读两个文件");
  await wait(400);
  const tA = termText(A);
  ok("收尾提示里出现了「决策链沉淀 N 条」", /决策链沉淀/.test(tA), tA.replace(/\n/g, " / ").slice(0, 160));
  const n = N_IN_LINE(tA);
  const mem1 = await readMem();
  const rejected1 = mem1.filter((e) => e.topic === "被拒操作/反例");
  const tradeoff1 = mem1.filter((e) => e.topic === "方案权衡");
  ok("报出的 N 等于库里确实多出来的条数（不是 add() 返回了几次）", n === rejected1.length + tradeoff1.length,
    "N=" + n + " 反例=" + rejected1.length + " 权衡=" + tradeoff1.length);
  ok("被拒的做法带上了工具、对象与理由", rejected1.some((e) => /write_file/.test(e.content) && /src\/override\.js/.test(e.content) && /整文件覆盖/.test(e.content)),
    JSON.stringify(rejected1.map((e) => e.content)));
  ok("用户选定的方案记成方案权衡，并把被否的那个一起留在句子里",
    tradeoff1.some((e) => /按行区间读文件/.test(e.content) && /整份读进来再截断/.test(e.content) && /丢掉/.test(e.content)),
    JSON.stringify(tradeoff1.map((e) => e.content)));
  /* 沉淀的主题名就是常驻的判据（GUARD_KEYS 认的是 type+topic 这一对）。
     两边各自改一次就会静默脱钩：下一局的硬提醒整块空掉，被否过的方案原样再提一遍，
     而每一侧的单测都还是绿的。所以这里钉"沉下来的那批，装配层真的会常驻"。 */
  ok("自动沉淀的主题名与常驻判据同源（isGuardEntry 认得它们）",
    rejected1.length > 0 && tradeoff1.length > 0
    && rejected1.concat(tradeoff1).every((e) => isGuardEntry(e)),
    JSON.stringify(rejected1.concat(tradeoff1).map((e) => [e.type, e.topic, isGuardEntry(e)])));
  /* 这份临时库必须开在 memDir 之外：readMem() 是把 memDir 下所有 .json 合起来数的，
     往里塞一支"只为验判据"的分片，后面几条计数判据就全被自己污染了。 */
  const mStore = new MemoryStore(path.join(SANDBOX.dataDir, "guard-check.json"));
  rejected1.concat(tradeoff1).forEach((e) => mStore.add(e.type, e.topic, e.content, { valueScore: e.valueScore || 3 }));
  ok("这一批在 formatGuard 里真占到了位置（不是只有索引那一行）",
    mStore.formatGuard().length > 0 && /write_file|按行区间读文件/.test(mStore.formatGuard()),
    mStore.formatGuard().slice(0, 120));

  /* ② 反向对照：开关关掉以后一条都不该沉 */
  const before2 = (await readMem()).length;
  DL.recordDecision({ convId: "default", kind: "approval", action: "rejected", tool: "delete_file", subject: "tmp/keep.txt", reason: "这个文件还要用" });
  plan = [
    { toolCalls: [{ id: "t1", name: "read_file", arguments: JSON.stringify({ path: "c.js" }) }] },
    { toolCalls: [{ id: "t2", name: "read_file", arguments: JSON.stringify({ path: "d.js" }) }] },
    { content: "读完了。" },
  ];
  roundIdx = 0;
  const B = mkAgent({ autoSettle: false });
  /* 反向对照必须同样迈过门槛，否则"没沉淀"是门没开造成的，不是开关造成的 —— 空过的对照等于没对照。 */
  B.conversations.set("default", { history: [], round: 2, ts: Date.now(), changes: [] });
  await B.handleChat("再读两个文件");
  await wait(400);
  ok("autoSettle=false 时收尾不再自动补（提示里也没有那句）", !/决策链沉淀/.test(termText(B)), termText(B).replace(/\n/g, " / ").slice(0, 140));
  const mem2 = await readMem();
  ok("关掉开关后库里确实没多出「被拒操作/反例」条目",
    mem2.filter((e) => /tmp\/keep\.txt/.test(e.content || "")).length === 0, "总量 " + mem2.length + "（此前 " + before2 + "）");

  /* ③ 模型自己已经结算过：收尾要让路，不重复堆近似条目 */
  DL.recordDecision({ convId: "default", kind: "approval", action: "rejected", tool: "run_command", subject: "npm run dist", reason: "打包目录被 IDE 句柄占用" });
  plan = [
    { toolCalls: [{ id: "t1", name: "save_session_memory", arguments: JSON.stringify({
      decisions: ["server 层一律用 CommonJS 模块写法，不再混 ESM"],
      tradeoffs: [{ chosen: "按行区间读", rejected: "整份读进来再截断", why: "截断会把中段丢掉，模型误以为看了全文" }],
    }) }] },
    { toolCalls: [{ id: "t2", name: "read_file", arguments: JSON.stringify({ path: "e.js" }) }] },
    { content: "已结算。" },
  ];
  roundIdx = 0;
  const C = mkAgent();
  C.conversations.set("default", { history: [], round: 2, ts: Date.now(), changes: [] });
  await C.handleChat("收尾并结算本次会话");
  await wait(500);
  const tC = termText(C);
  ok("显式结算成功后收尾不再自动沉（不重复堆近似条目）", !/决策链沉淀/.test(tC), tC.replace(/\n/g, " / ").slice(0, 160));
  const mem3 = await readMem();
  const own = mem3.filter((e) => e.topic === "方案权衡" && /模型误以为看了全文/.test(e.content || ""));
  ok("tradeoffs 三段齐全时真的写进库，正文同时含所选/所否/理由", own.length >= 1, JSON.stringify(own.map((e) => e.content)));
  const decC = mem3.filter((e) => e.topic === "会话决策");
  ok("decisions 也照旧落库", decC.some((e) => /CommonJS/.test(e.content || "")), JSON.stringify(decC.map((e) => e.content)));

  /* ④ 残缺的权衡不写：只留结论等于什么都没记住 */
  plan = [
    { toolCalls: [{ id: "t1", name: "save_session_memory", arguments: JSON.stringify({
      tradeoffs: [{ chosen: "甲方案", rejected: "乙方案" }],
    }) }] },
    { toolCalls: [{ id: "t2", name: "read_file", arguments: JSON.stringify({ path: "f.js" }) }] },
    { content: "好。" },
  ];
  roundIdx = 0;
  const D = mkAgent();
  D.conversations.set("default", { history: [], round: 2, ts: Date.now(), changes: [] });
  await D.handleChat("试一条缺理由的权衡");
  await wait(400);
  const bodyD = JSON.stringify((D.cards.find((c) => c.name === "沉淀会话记忆" || /沉淀/.test(c.name || "")) || {}).body || "");
  const mem4 = await readMem();
  ok("缺 why 的 tradeoff 不落库（否则下次照样重提被否方案）", !mem4.some((e) => /「甲方案」/.test(e.content || "")), bodyD.slice(0, 160));

  console.log("\n" + (fail ? "FAIL " + fail + " 项:\n - " + fails.join("\n - ")
    : "PASS: 收尾自动结算 " + pass + " 项全过（N 与盘上一致、开关能关、显式结算优先、缺段不写）"));
  DL.setDecisionDir(null);
  SANDBOX.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FAIL 探针异常: " + (e && e.stack || e)); DL.setDecisionDir(null); SANDBOX.cleanup(); process.exit(1); });
