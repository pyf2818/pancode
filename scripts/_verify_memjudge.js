/* 记忆判断层实测（P6：正文不再每轮摊开，取不取由模型判断）
   ————————————————————————————————————————————
   单测钉的是判据本身（isGuardEntry / formatIndex / 台账形状）；这里钉的是**装配层真跑起来以后**：
     ① 上下文里只有「硬提醒 + 索引」，普通记忆的整段正文一个字都不进；
     ② 两块逐字节不随本轮输入变（这是提示词前缀缓存的前提，不是"感觉应该能缓存"）；
     ③ 只给指针的那次检索不加强度，真取回的那次才加，而且一轮只加一次；
     ④ 取回通道真的能拿到全文，id 抄错时诚实说没找到；
     ⑤ 旧的"整段正文注入"口真的从存储层撤掉了 —— 留着它就会从后门复发。
   全程沙箱数据根，一个字节都不落开发者的 .pancode。
   用法：node scripts/_verify_memjudge.js
*/
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "memjudge" });

const Module = require("module");
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const memDir = path.join(SANDBOX.dataDir, ".pancode", "memory");

/* 正文分两段写：钩子只截开头 44 字，所以"整段正文有没有进来"必须拿落在 44 字之后的 TAIL 判。
   用开头那几个字判，索引行里也有，等于没判。 */
const HOOK = "本项目 dev 固定跑 5178 端口，换端口要同步改 electron 配置，";
const PAD = "配".repeat(20);
const TAIL = "整段正文MARKER不该出现在上下文";
const LONG_BODY = HOOK + PAD + TAIL;

const mockLlm = {
  LlmAbortedError: class extends Error {},
  LlmError: class extends Error {},
  async chatStream(cfg, messages, tools, cb) {
    const act = (plan && plan[roundIdx]) || { content: "本轮收尾完成。" };
    roundIdx++;
    if (act.toolCalls) return { content: "", reasoning: "", toolCalls: act.toolCalls, finish: "tool_calls" };
    if (cb && cb.onContent) cb.onContent(act.content || "");
    return { content: act.content || "本轮收尾完成。", reasoning: "", toolCalls: [], finish: "stop" };
  },
  async ping() { return true; },
};
class AgentBase {
  constructor(ctx) { this.ctx = ctx; this.cfg = ctx.cfg; this.files = ctx.files; this.term = ctx.term; this.evts = []; this.cards = []; }
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
const { LlmAgent } = require(path.join(ROOT, "server", "agent-llm.js"));
const memoryTools = require(path.join(ROOT, "server", "tools", "memory-tools.js"));
const { MemoryStore, GUARD_MAX_CHARS, IDX_MAX_CHARS } = require(path.join(ROOT, "server", "memory-store.js"));
Module._load = origLoad;

let plan = null, roundIdx = 0;
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 320); } catch (e) { return String(v).slice(0, 320); } };

function mkAgent(memCfg) {
  const a = new LlmAgent({
    cfg: {
      llm: { baseURL: "http://fake", apiKey: "k", model: "memjudge", maxToolRounds: 8, contextWindow: 32000 },
      permissions: { mode: "auto", allow: [], deny: [] },
      persona: {}, rules: { enabled: false }, context: {}, computer: {},
      memory: Object.assign({ enabled: true, autoSettle: false }, memCfg || {}),
    },
    files: { list: () => [], read: () => "", write() {}, exists: () => true, remove() {}, search: () => [], dir: SANDBOX.wsDir },
    term: { run: async () => ({ out: "", code: 0 }) },
  });
  a.running = false;
  /* 用户级库在生产里位于 ~/.pancode/memory（与 _memDir 不同目录），
     search_memory 的 global 扫描会把 _memDir 下每个 .json 都当成"别的工作区分片"，
     所以探针这边也不能把它塞进 memDir，否则会被自己数成第二个项目。 */
  a.userMemory = new MemoryStore(path.join(SANDBOX.dataDir, "mj-user-memory.json"));
  return a;
}
/* 记忆块按块切出来单独判：索引行自带正文开头 44 字，
   在整段文本上判 contains/not-contains 会把"常驻"和"只在索引"混成一锅。 */
function buckets(a, userText) {
  const p = a.buildAugmentParts(userText);
  const all = p.stable.concat(p.turn).join("\n\n");
  const cut = (mark) => {
    const i = all.indexOf(mark);
    if (i < 0) return "";
    const rest = all.slice(i + mark.length);
    const nxt = rest.search(/\n【/);
    return (nxt < 0 ? rest : rest.slice(0, nxt)).trim();
  };
  return {
    guard: cut("【记忆·硬提醒"),
    index: cut("【记忆索引"),
    all,
    memBlocks: p.stable.filter((s) => /【记忆/.test(s)).join("\n"),
    ledger: a._usedMemory || [],
  };
}

(async () => {
  /* ---------- 造一个"有反例、有权衡、有普通长正文"的库 ---------- */
  const A = mkAgent();
  A.memory.clear();
  const g1 = A.memory.add("error", "被拒操作/反例", "不要擅自 git commit，用户会单独下令");
  const g2 = A.memory.add("decision", "方案权衡", "选按行区间取段而不是一次读整份：整份读进来会把中段挤掉");
  const g3 = A.memory.add("preference", "图标约定", "界面图标不要用 emoji，一律用描边 SVG");
  const lesson = A.memory.add("lesson", "端口约定", LONG_BODY, { valueScore: 5 });
  const plainPref = A.memory.add("preference", "汇报", "结论放在最前面，细节放在后面，中间不要夹大段代码", { valueScore: 4 });
  const archived = A.memory.add("lesson", "旧约定", "很久以前定下的端口，正文要够长才不会被长度门槛挡在门外", { valueScore: 4 });
  A.memory.update(archived.id, { archived: true });
  A.userMemory.clear();
  const ug = A.userMemory.add("error", "被拒操作/反例", "不要用 run_command 拼 sed 做跨文件改名");

  section("① 常驻块：只有被否过的做法与禁忌，且有硬上限");
  const b1 = buckets(A, "帮我把端口约定改一下");
  ok("出现【记忆·硬提醒】块", b1.guard.length > 0, "块为空");
  ok("被拒过的做法真的常驻（正向对照，否则下面的否定判据全是假绿）",
    /不要擅自 git commit/.test(b1.guard), b1.guard.slice(0, 120));
  ok("方案权衡常驻", /选按行区间取段/.test(b1.guard), b1.guard.slice(0, 120));
  ok("写成禁忌的偏好常驻", /不要用 emoji/.test(b1.guard), b1.guard.slice(0, 120));
  ok("用户级反例也在常驻块里，且排在项目级之前",
    /不要用 run_command 拼 sed/.test(b1.guard) && b1.guard.indexOf("用户级：") < b1.guard.indexOf("本项目："),
    b1.guard.slice(0, 160));
  ok("常驻正文合计不超 " + GUARD_MAX_CHARS + " 字",
    A.memory.formatGuard().length <= GUARD_MAX_CHARS, "实际 " + A.memory.formatGuard().length + " 字");

  section("② 索引块：一行一条带 #id，整段正文不在上下文里");
  ok("出现【记忆索引】块", b1.index.length > 0, "块为空");
  ok("普通长正文的条目在索引里看得见（主题在）", /端口约定/.test(b1.index), b1.index.slice(0, 200));
  ok("索引给得出可抄的 #id", b1.index.includes("#" + lesson.id), b1.index.slice(0, 200));
  ok("整段正文没进上下文（TAIL 不出现在任何块）", !b1.all.includes(TAIL),
    b1.all.match(/.{0,40}MARKER.{0,40}/) ? b1.all.match(/.{0,40}MARKER.{0,40}/)[0] : "");
  ok("索引有硬上限（不超 " + IDX_MAX_CHARS + " 字 + 一行尾注）",
    A.memory.formatIndex().length <= IDX_MAX_CHARS + 60, "实际 " + A.memory.formatIndex().length + " 字");
  ok("已归档条目不出现在索引里", !b1.index.includes("#" + archived.id), b1.index.slice(0, 200));
  ok("常驻过的条目不在索引里重复列（两块加起来才是目录）",
    [g1, g2, g3, ug].every((e) => !b1.index.includes("#" + e.id)),
    b1.index.slice(0, 200));

  section("③ 逐字节不随本轮输入变（前缀缓存的根据）");
  const t1 = buckets(A, "帮我把端口约定改一下").memBlocks;
  const t2 = buckets(A, "今天天气不错，顺便看看图标").memBlocks;
  const t3 = buckets(A, "").memBlocks;
  ok("同一局里换三条不同的用户输入，记忆块一字不差", t1 === t2 && t2 === t3 && t1.length > 0,
    "长度 " + t1.length + "/" + t2.length + "/" + t3.length);

  section("④ 台账只记真的在场的那几条");
  ok("台账只有常驻条目，且都标 via=guard",
    b1.ledger.length > 0 && b1.ledger.every((u) => u.via === "guard"), J(b1.ledger.map((u) => [u.id, u.via])));
  ok("只在索引里的条目不算「读过」", !b1.ledger.some((u) => u.id === lesson.id), J(b1.ledger.map((u) => u.id)));
  ok("用户级条目在台账里 scope 仍是 user",
    b1.ledger.some((u) => u.id === ug.id && u.scope === "user"), J(b1.ledger.filter((u) => u.scope === "user").map((u) => u.id)));

  section("⑤ 检索指针：给编号不给正文，也不算一次复习");
  const before = A.memory.getById(lesson.id).accessCount;
  const ctx1 = A.contextRetriever.buildSmartContext("端口约定 dev 5178 换端口", { files: A.files });
  ok("本轮关键词命中时在上下文里给一条指针", /与本轮关键词相关的记忆/.test(ctx1), ctx1.slice(0, 200));
  ok("指针带的是 #id，不是正文", ctx1.includes("#" + lesson.id) && !ctx1.includes(TAIL), ctx1.slice(0, 240));
  ok("指针块明确指路 search_memory", /search_memory/.test(ctx1), ctx1.slice(0, 240));
  const ctx2 = A.contextRetriever.buildSmartContext("端口约定 dev 5178 换端口", { files: A.files });
  ok("只给指针的检索不加强度（连搜两次一次分都不涨）",
    A.memory.getById(lesson.id).accessCount === before,
    "搜前 " + before + "，搜后 " + A.memory.getById(lesson.id).accessCount);
  /* 反向对照：不带 noTouch 就是真复习，会加分。
     少了这条，上面那句也可能只是因为压根没命中。 */
  A.memory.search("端口约定 dev 5178 换端口", { limit: 5 });
  ok("反向对照：真取用（不带 noTouch）确实会加分",
    A.memory.getById(lesson.id).accessCount === before + 1, "应为 " + (before + 1) + "，实际 " + A.memory.getById(lesson.id).accessCount);
  ok("常驻过的条目不再出现在指针里", !new RegExp("#" + g1.id).test(ctx1), ctx1.slice(0, 240));

  section("⑥ 取回通道：search_memory 的 ids 与 query");
  const toolAgent = mkAgent();
  toolAgent.memory = A.memory; toolAgent.userMemory = A.userMemory;
  toolAgent.noteMemoryUse = (entries, scope) => {
    toolAgent._usedMemory = toolAgent._usedMemory || [];
    for (const e of entries || []) toolAgent._usedMemory.push({ id: e.id, scope, via: "pull" });
  };
  const pullBefore = A.memory.getById(lesson.id).accessCount;
  const gotIds = await memoryTools.search_memory(toolAgent, { ids: [lesson.id, "#" + archived.id, "mNoSuchId999"] });
  ok("按 id 取回了整段正文（TAIL 这次应当在）", gotIds.includes(TAIL), gotIds.slice(0, 200));
  ok("取回真算一次用：accessCount 加了一档",
    A.memory.getById(lesson.id).accessCount === pullBefore + 1,
    "取回前 " + pullBefore + "，取回后 " + A.memory.getById(lesson.id).accessCount);
  ok("抄错的 id 如实报出来，不静默少一条", /没找到/.test(gotIds) && /mNoSuchId999/.test(gotIds), gotIds.slice(0, 260));
  ok("归档条目取回时会点明它已归档", /已归档/.test(gotIds), gotIds.slice(0, 260));
  ok("回执提醒「这是历史结论，不是本轮事实」", /历史结论/.test(gotIds), gotIds.slice(-160));
  ok("台账把自查条目标成 via=pull", (toolAgent._usedMemory || []).some((u) => u.via === "pull"), J(toolAgent._usedMemory));
  const byQuery = await memoryTools.search_memory(toolAgent, { query: "端口约定" });
  ok("关键词搜出来的行首也带 #id（可二次精确取）", /- ?#|^#\w+/m.test(byQuery) || byQuery.includes("#" + lesson.id), byQuery.slice(0, 200));
  ok("搜不到时不冒充「库里没有」，而是指路换词或翻索引",
    /别把「没搜到」讲成|换个说法|记忆索引/.test(await memoryTools.search_memory(toolAgent, { query: "完全不存在的词啊zzz" })),
    "见上一条判据");
  const nothing = await memoryTools.search_memory(toolAgent, {});
  ok("ids 与 query 都不给时拒答并说清怎么给", /要么带 ids|要么带 query/.test(nothing), nothing.slice(0, 160));

  /* 跨工作区（scope=global）那条路：命中的是别的项目的分片，台账不许记成"本项目"。
     模型侧看得到行首 [项目 xxxx·type] 前缀，但回显卡只认 scope，写错就是界面在替来源撒谎。 */
  const otherShard = path.join(memDir, "othrwsmj.json");
  fs.writeFileSync(otherShard, JSON.stringify([
    { id: "xsec1", type: "lesson", topic: "隔壁项目的坑", content: "rename 被杀软锁住时改用 copyFile 兜底一次", ts: Date.now(), accessCount: 3, lastAccessAt: Date.now(), valueScore: 5 },
  ]), "utf8");
  const cross = await memoryTools.search_memory(toolAgent, { query: "copyFile 兜底", scope: "global" });
  ok("global 检索把别的工作区的命中点上来源", /\[项目 othrwsmj·/.test(cross), cross.slice(0, 220));
  ok("跨工作区那条在台账里记成 other，不再冒充本项目",
    (toolAgent._usedMemory || []).some((u) => u.id === "xsec1" && u.scope === "other"),
    J((toolAgent._usedMemory || []).filter((u) => u.id === "xsec1")));
  ok("跨片检索没写回那个分片（只读）",
    JSON.parse(fs.readFileSync(otherShard, "utf8"))[0].accessCount === 3, "被改了就是越权写盘");
  fs.unlinkSync(otherShard);

  section("⑦ 真跑一局：常驻 + 自查两条来源在收尾事件里分得开");
  const B = mkAgent();
  B.memory = A.memory;
  B.conversations.set("default", { history: [], round: 1, ts: Date.now(), changes: [] });
  const pullTarget = lesson.id;
  plan = [
    { toolCalls: [{ id: "t1", name: "search_memory", arguments: JSON.stringify({ ids: [pullTarget] }) }] },
    { content: "端口这件事我照 5178 来，改完同步动了 electron 配置。" },
  ];
  roundIdx = 0;
  await B.handleChat("端口约定是什么来着");
  await wait(300);
  const recall = B.evts.filter((e) => e.type === "memory.recall").pop();
  ok("收尾发了 memory.recall", !!recall, J(B.evts.map((e) => e.type)));
  const vias = (recall && recall.entries || []).map((e) => e.via);
  ok("台账里同时有常驻与自查两类", vias.includes("guard") && vias.includes("pull"), J(vias));
  ok("自查的那条就是模型自己点的 id",
    (recall.entries || []).some((e) => e.id === pullTarget && e.via === "pull"), J(recall.entries));

  section("⑧ 旧注入口已撤（后门封死）");
  const storeSrc = fs.readFileSync(path.join(ROOT, "server", "memory-store.js"), "utf8");
  /* 判的是"还有没有这个方法"，不是"还有没有这个词"——撤除说明里会提到旧名字，
     拿词形判会把自己写的注释当成证据。 */
  const defined = (n) => new RegExp("^\\s{2}" + n + "\\s*\\(", "m").test(storeSrc);
  ok("存储层不再有 stableForContext / relevantForContext / formatStable / formatRelevant",
    !["stableForContext", "relevantForContext", "formatStable", "formatRelevant"].some(defined),
    ["stableForContext", "relevantForContext", "formatStable", "formatRelevant"].filter(defined).join(", "));
  ok("存储层不再有 formatForContext / topForContext",
    !["formatForContext", "topForContext"].some(defined), ["formatForContext", "topForContext"].filter(defined).join(", "));
  const agentSrc = fs.readFileSync(path.join(ROOT, "server", "agent-llm.js"), "utf8");
  ok("装配层不再调用任何整段正文注入口（skills 的同名方法不算）",
    !/(memory|userMemory)\.(formatStable|formatRelevant|formatForContext|topForContext)\(/.test(agentSrc),
    "agent-llm.js 里仍有旧调用");
  const off = buckets(mkAgent({ enabled: false }), "随便").memBlocks;
  ok("长期记忆开关关掉后两块整块消失", off === "", off.slice(0, 120));

  console.log("\n" + (fail ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m")
    + " 记忆判断层探针：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { console.log(fails.map((f) => "  · " + f).join("\n")); process.exitCode = 1; }
})().catch((e) => {
  console.log("\n\x1b[31m崩\x1b[0m " + (e && e.stack || e));
  process.exitCode = 1;
});
