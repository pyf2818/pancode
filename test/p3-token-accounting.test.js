/* ============================================================
   上下文水位与 token 计数口径（#32：问两个问题就 200k，这不合理）

   200k 那个数本身是真的，但它被放在了"窗口占用"的位置上读：
     · trace 面板的 tokens 取的是"累计发出去多少 token"（计费口径）——
       每一轮工具调用都要把 system 前缀 + 全量历史重发一遍，两个问题跑十几轮，
       累计破 20 万完全正常；而窗口分母只有 10 万量级。
     · 同时分子还有一处真·重复累加：实测锚点记在 this.history 上，
       任务跑的却是 handleChat 里的局部 history，压缩/截断换了引用后两者分家，
       slice 起点错位会把已经数过的消息再估一遍。
     · 分母更是有三个数各说各话：模型窗口 128000 / ctx.query 自己乘 0.9 得 115200 /
       真正触发压缩的线 102400 —— 于是进度条永远到不了 100%，Agent 却在一遍遍压缩。

   这一组测试钉住修好之后的四条不变量。
   ============================================================ */
const { LlmAgent } = require("../server/agent-llm");

function makeAgent(cfgExtra) {
  // 与 p0 同一套轻量构造：Object.create 不走构造函数，正是"字段缺省变 NaN"的现场
  const a = Object.create(LlmAgent.prototype);
  a.cfg = Object.assign({
    llm: { contextWindow: 128000 },
    context: { budgetTokens: 1000000, autoCompact: true },
    memory: { enabled: false },
    permissions: { mode: "ask", allow: [], deny: [] },
  }, cfgExtra || {});
  a.history = [];
  a._lastPrompt = 0; a._lastPromptLen = 0; a._lastPromptArr = null; a._ctxPrefix = 0;
  a._usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  a._usageByConv = {};
  a.emitted = [];
  a.emit = (m) => a.emitted.push(m);
  a._traceEvent = () => {};
  a._traceEnqueue = () => {};
  return a;
}

function hist(n, chars) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ role: i % 2 ? "assistant" : "user", content: "x".repeat(chars || 400) });
  return out;
}

describe("分母只有一个：进度条与压缩判定同源", () => {
  it("_ctxLimit() 就是 _compactSpec().thresholdTokens", () => {
    const a = makeAgent({ llm: { contextWindow: 128000 } });
    expect(a._ctxLimit()).toBe(a._compactSpec().thresholdTokens);
    // 128000 窗口：扣输出预留 12800、headroom 5120 → 压缩线 102400，不是 128000 也不是 115200
    expect(a._ctxLimit()).toBe(102400);
  });

  it("服务端查询分支不再自己乘系数（index.js 里不该再有 ×0.9 的第二套口径）", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../server/index.js"), "utf8");
    const ctxQuery = src.slice(src.indexOf('case "ctx.query"'), src.indexOf('case "goal.set"'));
    expect(ctxQuery).toContain("uEng._ctxLimit()");
    expect(ctxQuery).not.toMatch(/_ctxBudget\(\)\s*\*\s*0\.9/);
  });
});

describe("分子不许重复计数：实测锚点依附到具体数组", () => {
  it("同一份历史、锚点有效时 = 实测 + 之后新增的估算", () => {
    const a = makeAgent();
    const h = hist(10);
    a._accumUsage({ prompt_tokens: 5000, completion_tokens: 10, total_tokens: 5010 }, h, "c1");
    expect(a._ctxUsed(h)).toBe(5000 + a._estTokens([]));     // 长度对齐：新增 0 条
    h.push({ role: "user", content: "y".repeat(4000) });
    expect(a._ctxUsed(h)).toBeGreaterThan(5000);
    expect(a._ctxUsed(h)).toBeLessThan(5000 + a._estTokens(h));  // 绝不能把 10 条老消息再估一遍
  });

  it("历史被换成新引用（压缩 / 截断）后：退回「固定前缀 + 当前历史估算」，既不归零也不翻倍", () => {
    const a = makeAgent();
    const h = hist(40, 2000);
    a._accumUsage({ prompt_tokens: 60000, completion_tokens: 10, total_tokens: 60010 }, h, "c1");
    const prefix = a._ctxPrefix;
    expect(prefix).toBeGreaterThan(0);
    const compacted = hist(6, 2000);                          // 压缩后的新数组
    const used = a._ctxUsed(compacted);
    expect(used).toBe(prefix + a._estTokens(compacted));
    // 反向对照：旧实现会把 60000（已含 40 条的实测包）直接当作压缩后的占用 → 压了个寂寞
    expect(used).toBeLessThan(60000);
    expect(a._ctxUsed([])).toBe(prefix);
  });

  it("_estTokens 高估到超过实测 prompt 时，前缀取 0 而不是负数（负数会把水位算漏）", () => {
    const a = makeAgent();
    const h = hist(20, 2000);
    a._accumUsage({ prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 }, h, "c1");
    expect(a._ctxPrefix).toBe(0);
    // 锚点还有效时走实测那一支；一旦历史换新引用，退回 0 + 估算，不能减去一个负前缀
    const h2 = hist(20, 2000);
    expect(a._ctxUsed(h2)).toBe(a._estTokens(h2));
  });

  it("用 Object.create 造的实例（没有 _ctxPrefix 字段）也不能出 NaN", () => {
    const a = makeAgent();
    delete a._ctxPrefix; delete a._lastPromptArr;
    const h = hist(4);
    expect(a._ctxUsed(h)).toBe(a._estTokens(h));
    expect(Number.isFinite(a._ctxUsed(h))).toBe(true);
  });
});

describe("累计用量按会话分桶，不再跨会话串号", () => {
  it("agent.usage 事件带的是本会话的量，引擎总量另走 all", () => {
    const a = makeAgent();
    const h = hist(4);
    a._accumUsage({ prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }, h, "cA");
    a._accumUsage({ prompt_tokens: 1200, completion_tokens: 100, total_tokens: 1300 }, h, "cA");
    a._accumUsage({ prompt_tokens: 700, completion_tokens: 50, total_tokens: 750 }, h, "cB");
    const evs = a.emitted.filter((e) => e.type === "agent.usage");
    expect(evs[evs.length - 1].usage.total_tokens).toBe(750);      // cB 只看自己的
    expect(evs[evs.length - 1].all.total_tokens).toBe(3150);       // 引擎级总量
    expect(evs[evs.length - 1].request.total).toBe(750);    // 单请求，供"这一包到底多大"
    expect(a._usageByConv.cA.total_tokens).toBe(2400);
  });

  it("删除会话时把它的用量桶一起清掉（否则面板能读到已删会话的累计）", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../server/agent-llm.js"), "utf8");
    expect(src).toMatch(/delete this\._usageByConv\[String\(convId\)\]/);
  });
});

describe("microcompact 就地清理后，水位必须真的掉下来", () => {
  it("清理了旧工具结果却仍按清理前的实测判位 → 会白花一次模型摘要", async () => {
    const a = makeAgent({ llm: { contextWindow: 200000 }, context: { budgetTokens: 20000, autoCompact: true } });
    // 摘要线 16000、micro 线 14000；最近 5 个工具轮受保护，所以要铺 8 轮才有 3 轮可清
    const h = [];
    for (let i = 0; i < 8; i++) {
      h.push({ role: "user", content: "读第 " + i + " 个文件" });
      h.push({ role: "assistant", content: "", tool_calls: [{ id: "t" + i, type: "function", function: { name: "read_file", arguments: "{}" } }] });
      h.push({ role: "tool", tool_call_id: "t" + i, content: "结".repeat(3000) });
      h.push({ role: "assistant", content: "读完了" });
    }
    a._accumUsage({ prompt_tokens: 17000, completion_tokens: 10, total_tokens: 17010 }, h, "c1");
    expect(a._ctxUsed(h)).toBe(17000);                 // 清理前走的是实测那一支
    a._summarize = async () => { throw new Error("不该调用模型摘要"); };
    const out = await a.compactHistory(h, {});
    expect(out).toBe(h);                               // 免费的那一遍就够了
    const mc = a.emitted.find((e) => e.type === "context.microcompact");
    expect(mc).toBeTruthy();
    // 锚点必须作废：不清的话 _ctxUsed 仍返回 17000，判位会越过免费的这一遍去调模型
    expect(a._lastPrompt).toBe(0);
    expect(a._ctxPrefix).toBeGreaterThan(0);
    expect(a._ctxUsed(h)).toBeLessThan(17000);
  });
});

/* ---------------- #39：工具预览分级必须读"当前会话真正在用的那份历史" ---------------- */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _ctx } = require("../server/agent-llm");
const { convContext } = _ctx;

function histOf(rounds, chars) {
  const out = [];
  for (let i = 0; i < rounds; i++) {
    out.push({ role: "user", content: "问 " + i });
    out.push({ role: "assistant", content: "y".repeat(chars) });
  }
  return out;
}

/* 分级结论从提示语里把那个数取出来比对，而不是 toContain("4000 字符")：
   "24000 字符" 里就含着 "4000 字符"，那样写两条断言会同时为真，等于没测。 */
function tierOf(s) {
  const m = String(s).match(/收起到 (\d+) 字符/);
  return m ? Number(m[1]) : null;
}

const SPILL_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pc-spill-"));
afterAll(() => { try { fs.rmSync(SPILL_ROOT, { recursive: true, force: true }); } catch (e) {} });

describe("预览分级读当前会话的水位，不读 this.history", () => {
  /* 200000 窗口 + budgetTokens 20000 → 压缩线 16000（>80% 收 4000，>60% 收 8000，否则 24000）。
     旧写法固定读 this.history（引擎上那一份"最近被前台会话用过的历史"），
     于是并行跑的后台会话被按别人的水位收成 4000 字预览，模型凭空少拿一半信息，
     提示里还多出一句不属于本会话的"当前水位约 x%"。 */
  function setup() {
    const a = makeAgent({ llm: { contextWindow: 200000 }, context: { budgetTokens: 20000, autoCompact: true } });
    a._spillRoot = SPILL_ROOT;                 // 绝不写真实数据根
    a._currentConv = "bg";
    a.emitted = [];
    a.history = histOf(200, 400);
    // 夹具本身要成立：前台这份确实是 >80% 的高水位，否则下面"档位不同"的断言是空的
    expect(a._ctxUsed(a.history) / a._ctxLimit()).toBeGreaterThan(0.8);
    return a;
  }
  const BIG = "z".repeat(30000);

  it("后台会话按自己的低水位放行更多原文", async () => {
    const a = setup();
    const own = histOf(2, 40);
    const inBg = await convContext.run({ convId: "bg", getHist: () => own }, () => a._boundToolResult("read_file", BIG));
    const byStale = a._boundToolResult("read_file", BIG);          // 没有 convContext → 退回 this.history
    expect(tierOf(inBg)).toBe(24000);
    expect(tierOf(byStale)).toBe(4000);
    // 真正多留下的就是这两档的差：头 70% + 尾 30%
    expect(inBg).toContain("原 30000 字符，中间 6000 字符未随本条结果返回");
    expect(byStale).toContain("原 30000 字符，中间 26000 字符未随本条结果返回");
  });

  it("压缩换了 history 引用之后，预览分级跟着新水位走", async () => {
    const a = setup();
    const before = a.history;
    const compacted = histOf(3, 40);                                // 压缩后的新数组
    const r1 = await convContext.run({ convId: "c", getHist: () => before }, () => a._boundToolResult("run_command", BIG));
    const r2 = await convContext.run({ convId: "c", getHist: () => compacted }, () => a._boundToolResult("run_command", BIG));
    expect(tierOf(r1)).toBe(4000);
    expect(tierOf(r2)).toBe(24000);
  });

  it("没有 convContext（子智能体/单测直调）时退回 this.history，不抛错", () => {
    const a = setup();
    expect(() => a._boundToolResult("read_file", "短结果不需要截断")).not.toThrow();
    expect(a._boundToolResult("read_file", "短结果不需要截断")).toBe("短结果不需要截断");
  });

  it("getHist 返回非数组时不能把水位算成 NaN（NaN 参与比较恒 false → 分级静默失灵）", async () => {
    const a = setup();
    const r = await convContext.run({ convId: "x", getHist: () => null }, () => a._boundToolResult("read_file", BIG));
    expect(r).toContain("水位约");
    expect(r).not.toContain("NaN");
    expect(tierOf(r)).toBe(4000);          // 退回 this.history 的那一档，而不是因为 NaN 落到 24000
  });
});
