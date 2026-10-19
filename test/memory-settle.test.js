/* 会话结算：把"这一局到底否过什么、定了什么"沉进长期记忆。
   ————————————————————————————————————————————
   要治的是自评里那条真缺口 —— 决策链早就落进 .pancode/decisions 了，但只有人在界面上回看，
   模型从不吸取；而 save_session_memory 全靠提示词第 10 条驱动，模型不调就什么都没留下。
   判据挑最容易被糊弄的三处钉：
   1) "沉淀 N 条"必须等于库里确实多出来的条数（add() 命中去重也返回 truthy，顺手 ++ 就是假数字）；
   2) 同一局重复结算不许再堆一份近似条目；
   3) 方案权衡缺任何一段（选了谁 / 没选谁 / 为什么）就不写 —— 只记结论的话下次照样重提被否的方案。 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LlmAgent } = require("../server/agent-llm");
const { MemoryStore } = require("../server/memory-store");
const DL = require("../server/decision-log");
const memoryTools = require("../server/tools/memory-tools");

let TMP, store, agent;

function mkAgent(cfgMem) {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = { memory: Object.assign({ enabled: true, autoSettle: true }, cfgMem || {}), llm: {} };
  a.memory = store;
  a.userMemory = null;
  a._currentConv = "c1";
  a._trace = [];
  a._traceEvent = (t, d) => { a._trace.push({ t, d }); };
  a.emit = () => {};
  a.skills = { add: () => null };
  return a;
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pc-settle-"));
  store = new MemoryStore(path.join(TMP, "memory.json"));
  DL.setDecisionDir(path.join(TMP, "decisions"));
  agent = mkAgent();
});
afterEach(() => {
  DL.setDecisionDir(null);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* Windows 句柄未放 */ }
});

const rec = (r) => DL.recordDecision(Object.assign({ convId: "c1" }, r));
const topics = () => store.list({ archived: "all", limit: 200 }).map((e) => e.topic);
const contents = () => store.list({ archived: "all", limit: 200 }).map((e) => e.content);

describe("自动结算（读决策链，不花 LLM 调用）", () => {
  it("用户拒过的操作变成一条反例，正文带得上次到底想干什么", () => {
    rec({ kind: "approval", action: "rejected", tool: "write_file", subject: "src/override.js", reason: "用户说不要整文件覆盖" });
    const r = agent._settleFromDecisions("c1");
    expect(r.added).toBe(1);
    expect(topics()).toContain("被拒操作/反例");
    expect(contents().join(" ")).toContain("write_file");
    expect(contents().join(" ")).toContain("不要整文件覆盖");
  });

  it("被 deny 规则拦下也算一次否决", () => {
    rec({ kind: "gate", action: "block", tool: "run_command", subject: "rm -rf build", reason: "命中拒绝规则 高危删除" });
    expect(agent._settleFromDecisions("c1").added).toBe(1);
    expect(contents().join(" ")).toContain("高危删除");
  });

  it("用户在候选里选定的方案记成方案权衡，并把被否的那个一起写进去", () => {
    rec({ kind: "choice", action: "picked", subject: "用 SQLite 存聊天记录", detail: "JSON 文件", reason: "并发写要上锁" });
    const r = agent._settleFromDecisions("c1");
    expect(r.added).toBe(1);
    const txt = contents().join(" ");
    expect(txt).toContain("用 SQLite 存聊天记录");
    expect(txt).toContain("JSON 文件");
    expect(txt).toContain("并发写要上锁");
  });

  it("同一局连着结算两次，第二次一条都不加（去重命中不许再数进 N 里）", () => {
    rec({ kind: "approval", action: "rejected", tool: "delete_file", subject: "a.txt" });
    const first = agent._settleFromDecisions("c1");
    expect(first.added).toBe(1);
    const second = agent._settleFromDecisions("c1");
    expect(second.added).toBe(0);
    expect(second.why).toBe("all_duplicate");
    expect(store.size).toBe(1);
  });

  it("同一个对象被连拒五次只沉一条，不是五条", () => {
    for (let i = 0; i < 5; i++) rec({ kind: "approval", action: "rejected", tool: "write_file", subject: "same.js" });
    const r = agent._settleFromDecisions("c1");
    expect(r.rejected).toBe(5);
    expect(r.added).toBe(1);
    expect(store.size).toBe(1);
  });

  it("模型自己结算过就跳过，不重复补一份", () => {
    rec({ kind: "approval", action: "rejected", tool: "write_file", subject: "x.js" });
    agent.markSessionSettled();
    const r = agent._settleFromDecisions("c1");
    expect(r).toEqual({ added: 0, why: "model_settled" });
    expect(store.size).toBe(0);
  });

  it("开关关掉时什么都不做（memory.autoSettle=false）", () => {
    const a = mkAgent({ autoSettle: false });
    rec({ kind: "approval", action: "rejected", tool: "write_file", subject: "y.js" });
    expect(a._settleFromDecisions("c1").why).toBe("autoSettle_off");
  });

  it("这一局没被否过也没选人 → 说什么都不沉，而不是写一条空话", () => {
    rec({ kind: "grant", action: "granted", tool: "run_command" });
    const r = agent._settleFromDecisions("c1");
    expect(r).toEqual({ added: 0, why: "no_decisions" });
    expect(store.size).toBe(0);
  });

  it("只取本会话的决策，别的会话不许混进来", () => {
    rec({ convId: "other", kind: "approval", action: "rejected", tool: "write_file", subject: "别局的.js" });
    expect(agent._settleFromDecisions("c1").why).toBe("no_decisions");
  });
});

describe("save_session_memory 的方案权衡入口", () => {
  /* 这里不许给 markSessionSettled 塞假实现：真要验的是"工具调了引擎那个方法、
     引擎随即把这一局标出来"，伪造一个只会测到测试自己搭的接线。 */
  function toolAgent() { return mkAgent(); }

  it("三段齐全才写，正文一句里同时有「选了谁 / 没选谁 / 为什么」", async () => {
    const a = toolAgent();
    const out = await memoryTools.save_session_memory(a, {
      tradeoffs: [{ chosen: "按行区间读", rejected: "整文件 dump 到临时脚本", why: "中段被截断会丢全局视角" }],
    });
    expect(out).toContain("已沉淀 1 条记忆");
    const txt = contents().join(" ");
    expect(txt).toContain("选「按行区间读」而不是「整文件 dump 到临时脚本」");
    expect(txt).toContain("丢全局视角");
    expect(topics()).toContain("方案权衡");
  });

  it("缺 why 的那条不写，并告诉模型是它少填了哪一段", async () => {
    const a = toolAgent();
    const out = await memoryTools.save_session_memory(a, {
      tradeoffs: [
        { chosen: "按行区间读", rejected: "整文件 dump", why: "中段被截断会丢掉全局视角" },
        { chosen: "走 A 方案", rejected: "走 B 方案" },
      ],
    });
    expect(out).toContain("权衡 2");
    expect(out).toContain("1 条缺 chosen/rejected/why");
    expect(store.size).toBe(1);
    expect(contents().join(" ")).not.toContain("「走 A 方案」");
  });

  it("显式结算会把这一局标出来，收尾自动结算随即让路", async () => {
    const a = toolAgent();
    await memoryTools.save_session_memory(a, { decisions: ["本项目 server 层一律用 CommonJS 模块写法"] });
    expect(a._settledConvs["c1"]).toBeTypeOf("number");
    rec({ kind: "approval", action: "rejected", tool: "write_file", subject: "z.js" });
    expect(a._settleFromDecisions("c1")).toEqual({ added: 0, why: "model_settled" });
    expect(topics()).not.toContain("被拒操作/反例");
  });

  it("什么都没填时说的是「没成句」而不是假装成功", async () => {
    const a = toolAgent();
    const out = await memoryTools.save_session_memory(a, { tradeoffs: [{ chosen: "短", rejected: "也短" }] });
    expect(out).toContain("没有可沉淀的内容");
    expect(out).toContain("补齐那三段");
  });
});
