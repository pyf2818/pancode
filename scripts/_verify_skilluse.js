/* ============================================================
   显式选用 Skill 的端到端验收（#43：用技能不该靠输入框输入或展示内容）
   手法同 _verify_promptctx.js：进程内把 ./llm 换成假网关，
   直接看"真的发给模型的那份 messages"长什么样——这是唯一能证明
   "正文进了上下文、又没混进用户那句话"的观测点。

   旧行为：前端在发送前把整份 Skill 正文前置拼进消息文本，
   于是气泡里糊一大段模板（用户看到的就是"用技能还得先往输入框里塞东西"），
   而这份模板还会作为用户消息永久留在历史里。
   新行为：消息只带 skillId，服务端把正文注入这一轮的模型上下文，
   用户那句话原样不动，气泡上方只多一枚"✦ 技能名"标记。
   ============================================================ */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

/* 沙箱数据根：这条探针会真构造 LlmAgent（SkillStore / 会话持久化都会落盘），
   不隔离就是往开发者的真实 .pancode 里写东西。判据走 scripts/_sandbox，别自己抄 mkdtemp。 */
const sb = require("./_sandbox").create({ tag: "skilluse", ws: false });
const TMP = sb.root;

const rounds = [];

const mockLlm = {
  async chatStream(cfg, messages, tools, cb) {
    if (tools === null || tools === undefined) return { content: "摘要", toolCalls: [], finish: "stop", usage: {} };
    rounds.push(JSON.parse(JSON.stringify(messages)));
    return { content: "按 Skill 的步骤做完了。", toolCalls: [], finish: "stop", usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } };
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

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "./llm") return mockLlm;
  if (request === "./agent-base") return { AgentBase };
  if (request === "./config") return { ROOT: TMP };
  return origLoad.apply(this, arguments);
};

const { LlmAgent } = require(path.join(__dirname, "..", "server", "agent-llm.js"));
Module._load = origLoad;

const events = [];
function makeAgent() {
  const a = new LlmAgent({
    cfg: {
      llm: { baseURL: "http://x", apiKey: "y", model: "m", maxToolRounds: 4, contextWindow: 200000 },
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
  a.emit = (ev) => { events.push(ev); };
  return a;
}

/* 整份 messages 里某个标记出现了几次 */
function countIn(messages, needle) {
  let n = 0;
  for (const m of messages) {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
    let k = c.indexOf(needle);
    while (k !== -1) { n++; k = c.indexOf(needle, k + needle.length); }
  }
  return n;
}
function userMsgs(messages) {
  return messages.filter((m) => m.role === "user" && typeof m.content === "string");
}

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

(async () => {
  const a = makeAgent();
  const builtin = a.skills.builtinWorkflows.find((s) => /^builtin_/.test(s.id));
  if (!builtin) { console.error("FAIL: 内置 skills 没装载，探针无从判据"); process.exit(1); }
  const bodyHead = String(builtin.body || "").trim().slice(0, 24);

  section("① 带 skillId 发送：正文进上下文，用户那句话不动");
  const said = "帮我把这段代码过一遍";
  await a.handleChat(said, { convId: "c1", skillId: builtin.id });
  ok("假网关真的收到了请求（" + rounds.length + " 轮）", rounds.length >= 1);
  const r0 = rounds[0] || [];
  ok("模型看到了这份 Skill 的正文", bodyHead.length > 0 && countIn(r0, bodyHead) === 1,
    "命中 " + countIn(r0, bodyHead) + " 次");
  ok("正文以「本轮采用 Skill」的名义注入，而不是混在用户话里",
    countIn(r0, "【本轮采用 Skill：" + builtin.name + "】") === 1, "");
  const u = userMsgs(r0);
  ok("发给模型的用户消息里，用户原话一字不动地在", u.some((m) => m.content.includes(said)), "");
  ok("旧格式（把正文前置拼进消息）已经绝迹", countIn(r0, "[引用 Skill:") === 0, "");
  const ev = events.filter((e) => e.type === "user.msg");
  ok("回显给界面的 user.msg 带着技能名", ev.length === 1 && ev[0].skill === builtin.name, JSON.stringify(ev[0] || {}));
  ok("回显的 text 就是用户原话（不含正文）",
    ev.length === 1 && ev[0].text === said && !String(ev[0].text || "").includes(bodyHead), (ev[0] || {}).text);

  section("② 第二轮不再重复注入（正文只随那条用户消息进历史）");
  await a.handleChat("再看一下测试覆盖", { convId: "c1" });
  const r1 = rounds[rounds.length - 1];
  ok("整份上下文里正文仍然只有一份", countIn(r1, bodyHead) === 1, "命中 " + countIn(r1, bodyHead) + " 次");
  ok("第二轮没再打 skill 标记", countIn(r1, "【本轮采用 Skill") === 1, "");

  section("③ 计数：真的用了才 +1");
  const mine = a.skills.add({ name: "探针专用技能", description: "只给这条探针用", body: "探针正文内容若干字", category: "test" }, "manual");
  ok("可写池里建出了副本", !!(mine && mine.id), JSON.stringify(mine || {}));
  const before = a.skills.getById(mine.id).useCount || 0;
  await a.handleChat("用我的技能做一遍", { convId: "c2", skillId: mine.id });
  ok("用了一次，useCount 加一", a.skills.getById(mine.id).useCount === before + 1,
    "实际 " + a.skills.getById(mine.id).useCount);

  section("④ 空文本 + 只选技能：也该发得出去");
  const roundsBefore = rounds.length;
  await a.handleChat("", { convId: "c3", skillId: builtin.id });
  ok("没有输入框文字也走完了这一轮", rounds.length > roundsBefore, rounds.length + " vs " + roundsBefore);
  const r3 = rounds[rounds.length - 1];
  ok("模型收到的是「按 Skill 步骤开始」这句兜底", countIn(r3, "请按上面这份 Skill 的步骤开始处理当前任务。") === 1, "");

  section("⑤ 技能已不存在：明确回执，不静默吞掉");
  const roundsBefore2 = rounds.length;
  await a.handleChat("", { convId: "c4", skillId: "sk_根本没有这条" });
  const errs = events.filter((e) => e.type === "op.error");
  ok("给了 op.error 回执", errs.length >= 1, JSON.stringify(errs.slice(-1)));
  ok("这一轮没有真的发给模型", rounds.length === roundsBefore2, rounds.length + " vs " + roundsBefore2);
  ok("会话没被留在 running 状态（否则下次发送会一直排队）", !a.runningConvs.has("c4"), [...a.runningConvs].join(","));
  await a.handleChat("还能正常发", { convId: "c4" });
  ok("紧接着的普通消息照常走通", rounds.length > roundsBefore2, "");

  console.log("\n\x1b[1mSkill 选用验收：\x1b[0m " + pass + " 通过 / " + fail + " 失败");
  if (fails.length) console.log("\x1b[31m失败项：\x1b[0m\n  - " + fails.join("\n  - "));
  sb.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\x1b[31m探针异常：\x1b[0m" + e.stack);
  sb.cleanup();
  process.exit(1);
});
