/* ============================================================
   P1-7 / P1-8 单测：压缩预算算术 + microcompact（不调模型的廉价通道）
   - _compactSpec：窗口先扣「输出预留」再扣 headroom，保留量必小于触发线
   - microcompact：只清陈旧的、可再生的只读结果；最近 5 轮、失败/被拒结果、
     写类结果一律不动；收益不足 256 token 整体回滚；二次运行幂等
   ============================================================ */
const { LlmAgent } = require("../server/agent-llm");

const CLEARED = "[旧工具结果已清理]";

function agent(cfgExtra) {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = Object.assign({
    llm: { contextWindow: 128000 },
    context: { budgetTokens: 1000000, autoCompact: true },
    memory: { enabled: false },
    permissions: { mode: "ask", allow: [], deny: [] },
  }, cfgExtra || {});
  a.history = [];
  a._lastPrompt = 0;
  a._lastPromptLen = 0;
  a.emitted = [];
  a.emit = (m) => a.emitted.push(m);
  a._traceEvent = () => {};
  a._consolidateMemory = () => {};
  return a;
}

const T = (id, name) => ({ id, type: "function", function: { name, arguments: "{}" } });
const asst = (calls, content) => { const m = { role: "assistant", content: content || "" }; if (calls) m.tool_calls = calls; return m; };
const tool = (id, text) => ({ role: "tool", tool_call_id: id, content: text });
const BIG = (n) => "这是工具读回来的正文内容。".repeat(n);

/** 造 N 轮"一次 user + 一次 assistant(工具调用) + 结果"，可选并行度 */
function rounds(n, opts) {
  const o = opts || {};
  const h = [];
  for (let r = 0; r < n; r++) {
    if (r === 0 || o.userEachRound) h.push({ role: "user", content: "第 " + r + " 轮请求" });
    const calls = (o.tools || ["read_file"]).map((name, i) => T("c" + r + "_" + i, name));
    h.push(asst(calls));
    calls.forEach((c, i) => h.push(tool(c.id, (o.text && o.text(r)) || BIG(o.size || 60))));
  }
  return h;
}

/* ============================================================
   _compactSpec
   ============================================================ */
describe("_compactSpec — 阈值先扣输出预留再扣 headroom", () => {
  it("128K 默认档：阈值 < 窗口，且给输出与工具结果留出余量", () => {
    const s = agent(). _compactSpec();
    expect(s.reservedCompletion).toBe(12800);          // 10% of 128000
    expect(s.headroom).toBe(5120);
    expect(s.messageBudget).toBe(115200);
    expect(s.thresholdTokens).toBe(102400);            // min(0.8*128000, 115200-5120)
    expect(s.retainTokens).toBe(18432);                // 16% of messageBudget
    expect(s.thresholdTokens).toBeLessThan(s.window);
  });

  it("旧算法的错处复现：min(window, window*0.9) 恒等于右值，等于完全没扣输出预留", () => {
    const a = agent();
    const s = a._compactSpec();
    const legacy = Math.min(a._ctxBudget(), Math.round(a._ctxBudget() * 0.9));
    expect(legacy).toBe(115200);                       // 就是 window*0.9
    expect(s.thresholdTokens).toBeLessThan(legacy);    // 新阈值必须更低（把输出侧让出来）
  });

  it("maxOutputTokens 配得越大，触发线越低", () => {
    const small = agent({ llm: { contextWindow: 128000, maxOutputTokens: 2048 } })._compactSpec();
    const large = agent({ llm: { contextWindow: 128000, maxOutputTokens: 30000 } })._compactSpec();
    expect(large.thresholdTokens).toBeLessThan(small.thresholdTokens);
    expect(large.reservedCompletion).toBe(30000);
  });

  it("输出预留被夹在 [1024, 25% 窗口]：窗口极小时不让它吃掉整条窗口", () => {
    const tiny = agent({ llm: { contextWindow: 4000, maxOutputTokens: 999999 } })._compactSpec();
    expect(tiny.reservedCompletion).toBe(1000);        // 25% of 4000
    const small = agent({ llm: { contextWindow: 128000, maxOutputTokens: 1 } })._compactSpec();
    expect(small.reservedCompletion).toBe(1024);       // 下限
  });

  it("budgetTokens 小于窗口时以用户预算为准（1M 默认不该压过 32K 模型）", () => {
    const s = agent({ llm: { contextWindow: 32768 }, context: { budgetTokens: 1000000, autoCompact: true } })._compactSpec();
    expect(s.thresholdTokens).toBe(Math.floor(32768 * 0.8));
    const tight = agent({ llm: { contextWindow: 128000 }, context: { budgetTokens: 20000, autoCompact: true } })._compactSpec();
    expect(tight.thresholdTokens).toBe(16000);         // 20000*0.8 而不是 128000*0.8
  });

  it("microThreshold 严格低于摘要触发线，且取比例/绝对余量里更保守的一个", () => {
    const s = agent()._compactSpec();
    expect(s.microThreshold).toBeLessThan(s.thresholdTokens);
    // 128K 档：0.9 比例线 92160 比「留 2000 余量」的 100400 更低 → 取更保守的比例线
    expect(s.microThreshold).toBe(Math.round(s.thresholdTokens * 0.9));
    expect(s.microThreshold).toBeLessThan(s.thresholdTokens - 2000 + 1);
    const tiny = agent({ llm: { contextWindow: 6000 }, context: { budgetTokens: 6000, autoCompact: true } })._compactSpec();
    expect(tiny.microThreshold).toBeLessThan(tiny.thresholdTokens);
    expect(tiny.microThreshold).toBeGreaterThan(0);
  });

  it("保留量 ≥ 触发线时退让到一半并置 misconfigured，不再制造「压完还超限」的死循环", () => {
    // 用户把 budgetTokens 配得远小于模型窗口：16% 的窗口保留量放不进这么小的预算线
    const s = agent({ llm: { contextWindow: 128000 }, context: { budgetTokens: 2000, autoCompact: true } })._compactSpec();
    expect(s.misconfigured).toBe(true);
    expect(s.retainTokens).toBe(Math.floor(s.thresholdTokens / 2));
    expect(s.retainTokens).toBeLessThan(s.thresholdTokens);
  });

  it("脏配置不产生非法数：窗口/预算为 0、负数、字符串时仍是正整数", () => {
    for (const cfg of [
      { llm: { contextWindow: 0 }, context: { budgetTokens: 0, autoCompact: true } },
      { llm: { contextWindow: -5 }, context: { budgetTokens: -1, autoCompact: true } },
      { llm: { contextWindow: "abc" }, context: { budgetTokens: null, autoCompact: true } },
    ]) {
      const s = agent(cfg)._compactSpec();
      expect(Number.isFinite(s.thresholdTokens) && s.thresholdTokens > 0).toBe(true);
      expect(Number.isFinite(s.retainTokens) && s.retainTokens > 0).toBe(true);
      expect(s.retainTokens).toBeLessThan(s.thresholdTokens);
    }
  });
});

/* ============================================================
   microcompactHistory
   ============================================================ */
describe("microcompactHistory — 只清「可再生且陈旧」的只读结果", () => {
  it("最近 5 轮保留原文，更旧的可读结果被换成占位", () => {
    const a = agent();
    const h = rounds(9, { userEachRound: true, tools: ["read_file"] });
    const r = a.microcompactHistory(h);
    expect(r.cleared).toBeGreaterThanOrEqual(4);
    const cleared = h.filter((m) => m.role === "tool" && String(m.content).startsWith(CLEARED));
    expect(cleared.length).toBe(r.cleared);
    // 最近 5 轮的结果必须还是原文
    const lastToolTexts = h.filter((m) => m.role === "tool").slice(-5).map((m) => String(m.content));
    for (const t of lastToolTexts) expect(t.startsWith(CLEARED)).toBe(false);
  });

  it("一次并行调用属于同一轮：整组一起保留，不会被拆着清", () => {
    const a = agent();
    const h = rounds(8, { tools: ["read_file", "search_code", "repo_map"], userEachRound: true });
    a.microcompactHistory(h);
    const groups = [];
    let cur = null;
    for (const m of h) {
      if (m.role === "assistant" && m.tool_calls) { cur = []; groups.push(cur); }
      else if (m.role === "tool" && cur) cur.push(String(m.content).startsWith(CLEARED));
    }
    for (const g of groups) {
      expect(new Set(g).size).toBe(1);   // 同组要么全清要么全留
    }
    // 最后 5 组保留
    for (const g of groups.slice(-5)) expect(g[0]).toBe(false);
  });

  it("写类工具的结果不动：它承载的是「我改了什么」，不可再生", () => {
    const a = agent();
    const h = rounds(9, { userEachRound: true, tools: ["apply_edit"] });
    const r = a.microcompactHistory(h);
    expect(r.cleared).toBe(0);
    expect(r.tokensSaved).toBe(0);
    expect(h.every((m) => m.role !== "tool" || !String(m.content).startsWith(CLEARED))).toBe(true);
  });

  it("失败 / 被拒 / 超时 / 结果未知的工具结果一律保留（自我纠错依据）", () => {
    for (const bad of ["命令执行失败：exit 1", "命中安全黑名单，已拦截", "用户已拒绝", "[超时] 工具执行超过 120 秒", "[未收到结果] 上次中断"]) {
      const a = agent();
      const h = rounds(9, { userEachRound: true, tools: ["run_command"] });
      h.forEach((m, i) => { if (m.role === "tool" && i < h.length - 8) h[i] = tool(m.tool_call_id, bad + "\n" + BIG(60)); });
      a.microcompactHistory(h);
      expect(h.some((m) => m.role === "tool" && String(m.content).startsWith(CLEARED))).toBe(false);
    }
  });

  it("非白名单工具名不清（宁可少省也不误删上下文）", () => {
    const a = agent();
    const h = rounds(9, { userEachRound: true, tools: ["create_plan"] });
    expect(a.microcompactHistory(h).cleared).toBe(0);
  });

  it("收益不足 256 token 时整体回滚：报告 cleared=0 且历史真的没动", () => {
    const a = agent();
    const h = rounds(9, { userEachRound: true, tools: ["read_file"], size: 1 });  // 每条结果都很短
    const snapshot = JSON.stringify(h);
    const r = a.microcompactHistory(h);
    expect(r.cleared).toBe(0);
    expect(r.tokensSaved).toBe(0);
    expect(JSON.stringify(h)).toBe(snapshot);
  });

  it("幂等：连跑两次，第二次没有任何新增收益", () => {
    const a = agent();
    const h = rounds(10, { userEachRound: true, tools: ["read_file"] });
    const first = a.microcompactHistory(h);
    expect(first.cleared).toBeGreaterThan(0);
    const second = a.microcompactHistory(h);
    expect(second.cleared).toBe(0);
    expect(second.tokensSaved).toBe(0);
  });

  it("占位文本不会比原文更大：短结果一律不动", () => {
    const a = agent();
    const h = rounds(9, { userEachRound: true, tools: ["read_file"], size: 60 });
    // 手工把最旧几条换成很短的结果，其余保持大
    h.forEach((m, i) => { if (m.role === "tool" && i < h.length - 8) h[i] = tool(m.tool_call_id, "ok"); });
    a.microcompactHistory(h);
    expect(h.some((m) => m.role === "tool" && String(m.content).startsWith(CLEARED))).toBe(false);
  });

  it("消息条数与数组身份不变（只就地换内容），配对关系完好", () => {
    const a = agent();
    const h = rounds(8, { tools: ["read_file", "search_symbol"], userEachRound: true });
    const len = h.length;
    const idsBefore = h.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    a.microcompactHistory(h);
    expect(h.length).toBe(len);
    expect(h.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(idsBefore);
    expect(h.filter((m) => m.role === "assistant").length).toBe(len - h.filter((m) => m.role === "tool").length - h.filter((m) => m.role === "user").length);
  });

  it("占位里点名是哪个工具、怎么取回来", () => {
    const a = agent();
    const h = rounds(9, { userEachRound: true, tools: ["read_file"] });
    a.microcompactHistory(h);
    const ph = h.find((m) => m.role === "tool" && String(m.content).startsWith(CLEARED));
    expect(ph).toBeTruthy();
    expect(String(ph.content)).toContain("read_file");
    expect(String(ph.content)).toContain("重新调用");
  });

  it("多模态（数组 content）结果不碰", () => {
    const a = agent();
    const h = rounds(9, { userEachRound: true, tools: ["read_file"] });
    h.forEach((m, i) => { if (m.role === "tool" && i < h.length - 8) h[i] = { role: "tool", tool_call_id: m.tool_call_id, content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] }; });
    a.microcompactHistory(h);
    expect(h.some((m) => m.role === "tool" && String(m.content).startsWith(CLEARED))).toBe(false);
  });
});

/* ============================================================
   compactHistory 里两层的配合
   ============================================================ */
describe("compactHistory — 先走免费的 microcompact，再决定要不要花钱摘要", () => {
  const big = (n) => "读回来的文件正文，中文字数很多。".repeat(n);

  function history(nRounds) {
    const h = [];
    for (let r = 0; r < nRounds; r++) {
      h.push({ role: "user", content: "第 " + r + " 个要求" });
      h.push(asst([T("q" + r), T("w" + r)]));
      h.push(tool("q" + r, big(80)));
      h.push(tool("w" + r, big(80)));
    }
    return h;
  }

  it("水位只在 micro 线与摘要线之间时：清理了旧结果，但一次模型都没调", async () => {
    // 20000 预算 → 摘要线 16000、micro 线 14000；下面造的历史实测约 15400，正好落在这两条线之间
    const a = agent({ llm: { contextWindow: 200000 }, context: { budgetTokens: 20000, autoCompact: true } });
    let summarizeCalls = 0;
    a._summarize = async () => { summarizeCalls++; return "摘要"; };
    const h = history(10);
    const before = a._estTokens(h);
    const spec = a._compactSpec();
    expect(before).toBeGreaterThan(spec.microThreshold);
    expect(before).toBeLessThan(spec.thresholdTokens);
    const out = await a.compactHistory(h);
    expect(out).toBe(h);                       // 没有换成新数组 = 没走摘要
    expect(summarizeCalls).toBe(0);
    expect(a._estTokens(out)).toBeLessThan(before);
    const ev = a.emitted.find((e) => e.type === "context.microcompact");
    expect(ev).toBeTruthy();
    expect(ev.cleared).toBeGreaterThan(0);
    expect(ev.saved).toBeGreaterThan(0);
  });

  it("micro 那一遍不够时，才升级去调模型摘要", async () => {
    const a = agent({ llm: { contextWindow: 200000 }, context: { budgetTokens: 6000, autoCompact: true } });
    let summarizeCalls = 0;
    a._summarize = async () => { summarizeCalls++; return "【任务目标】继续"; };
    const h = history(8);
    const out = await a.compactHistory(h);
    expect(summarizeCalls).toBe(1);
    expect(out).not.toBe(h);                    // 摘要走的是「换新数组」，与就地清理区分开
    expect(out[0].role).toBe("system");
    expect(out[0].content).toContain("[历史摘要]");
    expect(a._estTokens(out)).toBeLessThan(a._estTokens(h));
  });

  it("force（手动 /compact）跳过 micro 直接摘要：用户明说要压就别手软", async () => {
    const a = agent({ llm: { contextWindow: 200000 }, context: { budgetTokens: 6000, autoCompact: true } });
    let summarizeCalls = 0;
    a._summarize = async () => { summarizeCalls++; return "短摘要"; };
    await a.compactHistory(history(8), { force: true });
    expect(summarizeCalls).toBe(1);
    expect(a.emitted.some((e) => e.type === "context.microcompact")).toBe(false);
  });

  it("autoCompact=false 时 microcompact 也不越权执行", async () => {
    const a = agent({ context: { budgetTokens: 100, autoCompact: false } });
    a._summarize = async () => "x";
    const h = history(6);
    const snapshot = JSON.stringify(h);
    expect(await a.compactHistory(h)).toBe(h);
    expect(JSON.stringify(h)).toBe(snapshot);
  });
});
