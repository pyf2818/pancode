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

/* ============================================================
   P1-B6 · 摘要这一遍：九段模板、失败不再等于失忆、断路器
   单测把模型换成假实现（_chatStream 注入），验的是我们喂出去的指令
   和换回来的历史形状 —— 真模型的质量不在这里断言。
   ============================================================ */
describe("compactHistory — 摘要模板与断路器（P1-B6）", () => {
  const SECTIONS = ["【任务目标】", "【全部用户消息】", "【已定决策】", "【已改文件】", "【验证状态】",
    "【待办任务】", "【当前工作】", "【下一步】", "【安全约束】"];
  const SUMMARY_PREFIX = "[历史摘要] ";
  const big = (n) => "读回来的文件正文，中文字数很多。".repeat(n);
  const goodSummary = SECTIONS.map((s) => s + "一条够短的事实").join("\n");

  /* 大历史：只有 user 消息 + 写类工具结果（写类不在 microcompact 白名单里，
     所以这一份是「便宜的那一遍完全帮不上」的夹具，摘要线必然被走到）。
     每轮的工具结果带 ROUND-n 标记，这样"留头留尾"能被逐轮验出来。 */
  function heavy(nRounds) {
    const h = [];
    for (let r = 0; r < nRounds; r++) {
      h.push({ role: "user", content: "第 " + r + " 个要求" });
      h.push(asst([T("h" + r, "write_file")]));
      h.push(tool("h" + r, "ROUND-" + r + " " + big(120)));
    }
    return h;
  }

  function fakeModel(reply) {
    const box = { calls: 0, system: "", user: "", msgs: null };
    box.install = (a) => {
      a._chatStream = async (messages) => {
        box.calls++; box.msgs = messages;
        box.system = messages[0].content; box.user = messages[1].content;
        return { content: typeof reply === "function" ? reply(box) : reply };
      };
    };
    return box;
  }

  const overBudget = (extra) => Object.assign({ llm: { contextWindow: 200000 }, context: { budgetTokens: 6000, autoCompact: true } }, extra || {});

  function pairErrors(h) {
    const called = new Set(), answered = new Set(), errs = [];
    h.forEach((m) => (m.tool_calls || []).forEach((c) => called.add(c.id)));
    h.forEach((m) => { if (m.role === "tool") answered.add(m.tool_call_id); });
    h.forEach((m) => { if (m.role === "tool" && !called.has(m.tool_call_id)) errs.push("孤儿 tool 结果 " + m.tool_call_id); });
    called.forEach((id) => { if (!answered.has(id)) errs.push("有 call 没结果 " + id); });
    return errs;
  }

  it("指令里九段一个小标题都不能少，并明说没有内容也要写「无」", async () => {
    const a = agent(overBudget());
    const m = fakeModel(goodSummary); m.install(a);
    await a.compactHistory(heavy(6), { force: true });
    expect(m.calls).toBe(1);
    for (const s of SECTIONS) expect(m.system).toContain(s);
    expect(m.system).toContain("一段都不能少");
    expect((m.system.match(/【[^】]{2,8}】/g) || []).length).toBe(9);
  });

  it("摘要原文留头也留尾：【当前工作】【下一步】来自最后几轮，不能被切掉", () => {
    const a = agent(overBudget());
    const msgs = [];
    for (let r = 0; r < 40; r++) msgs.push({ role: "user", content: "ROUND-" + r + "-" + "补".repeat(500) });
    const txt = a._summaryTranscript(msgs);
    expect(txt).toContain("ROUND-0-");
    expect(txt).toContain("ROUND-39-");    // 旧算法取前 12000 字，最后几轮在这里已经被切没
    expect(txt).toContain("已省略");
    expect(txt.length).toBeLessThan(13000);
    // 反向对照：短到不用截时原样给出，不塞"已省略"这种噪音
    expect(a._summaryTranscript([{ role: "user", content: "就一句话" }])).toBe("user: 就一句话");
  });

  it("上一版摘要被认出来单独并入，不再「摘要的摘要」", async () => {
    const a = agent(overBudget());
    const m = fakeModel(goodSummary); m.install(a);
    const h = heavy(6);
    h.unshift({ role: "system", content: SUMMARY_PREFIX + "【任务目标】更早那段的事实：先加日志再改调用点" });
    await a.compactHistory(h, { force: true });
    expect(m.user).toContain("已有摘要：");
    expect(m.system).toContain("禁止出现「摘要的摘要」");
    /* 旧摘要只以「已有摘要」的身份出现一次；再出现在新内容里就是被二次摘要进去了 */
    expect(m.user.split("先加日志再改调用点").length - 1).toBe(1);
  });

  it("模型回空或调用炸了：绝不拿占位符替换真实历史（旧实现会把历史压成一句失败提示）", async () => {
    const a = agent(overBudget());
    fakeModel("").install(a);
    const h = heavy(6);
    const snap = JSON.stringify(h);
    expect(await a.compactHistory(h, { force: true })).toBe(h);
    expect(JSON.stringify(h)).toBe(snap);
    const warn = a.emitted.find((e) => e.type === "term.line" && /摘要没能生成/.test(e.text || ""));
    expect(warn).toBeTruthy();

    const b = agent(overBudget());
    b._chatStream = async () => { throw new Error("上游 503"); };
    const h2 = heavy(6);
    expect(await b.compactHistory(h2, { force: true })).toBe(h2);
  });

  it("摘要消息尾部挂着压缩提醒：不复述、不重做、不停下来问是否继续", async () => {
    const a = agent(overBudget());
    fakeModel(goodSummary).install(a);
    const out = await a.compactHistory(heavy(6), { force: true });
    expect(out[0].role).toBe("system");
    expect(out[0].content).toContain(SUMMARY_PREFIX);
    expect(out[0].content).toContain(goodSummary);
    for (const phrase of ["不要向用户复述", "不要重做", "也不要停下来问「是否继续」", "别凭摘要里的印象猜"]) {
      expect(out[0].content).toContain(phrase);
    }
    expect(pairErrors(out)).toEqual([]);   // 提醒挂在同一条消息里，没有多出任何不成对的消息
  });

  it("断路器：连续两次自动压缩压不动，就不再花第三次模型调用", async () => {
    const a = agent(overBudget());
    a._currentConv = "cA";                     // 断路器按会话分桶，这里显式站在某一条会话里
    const m = fakeModel(""); m.install(a);
    const h = heavy(6);
    expect(a._estTokens(h)).toBeGreaterThan(a._compactSpec().thresholdTokens);  // 夹具自检：确实超线
    const snap = JSON.stringify(h);
    await a.compactHistory(h);
    await a.compactHistory(h);
    expect(m.calls).toBe(2);
    expect(a._compactStopped.cA).toBe(true);
    expect(a.emitted.some((e) => e.type === "context.compact_breaker")).toBe(true);
    const line = a.emitted.filter((e) => e.type === "term.line" && /暂停自动摘要/.test(e.text || "")).pop();
    expect(line).toBeTruthy();
    expect(line.text).toContain("/compact");
    await a.compactHistory(h);                    // 第三次：省掉这一次模型调用
    expect(m.calls).toBe(2);
    expect(JSON.stringify(h)).toBe(snap);         // 停手不等于偷偷改历史
  });

  it("断路器只管压不动的那条会话：另一条照样该压（一个引擎服务这个用户的所有会话）", async () => {
    const a = agent(overBudget());
    const m = fakeModel(""); m.install(a);
    a._currentConv = "cA";
    await a.compactHistory(heavy(6));
    await a.compactHistory(heavy(6));
    expect(a._compactStopped.cA).toBe(true);
    const before = m.calls;
    a._currentConv = "cB";                        // 切到另一条并行会话
    await a.compactHistory(heavy(6));
    expect(m.calls).toBe(before + 1);             // cA 的断路器不许把 cB 也关掉
    expect(a._compactStopped.cA).toBe(true);
    expect(a._compactStopped.cB).toBeFalsy();
  });

  it("手动 /compact 会复位断路器：压成功一次，自动那一遍重新开工", async () => {
    const a = agent(overBudget());
    a._currentConv = "cA";
    const box = { calls: 0 };
    let mode = "fail";
    a._chatStream = async () => { box.calls++; return { content: mode === "fail" ? "" : goodSummary }; };
    const h = heavy(6);
    await a.compactHistory(h);
    await a.compactHistory(h);
    expect(a._compactStopped.cA).toBe(true);
    mode = "ok";
    const out = await a.compactHistory(h, { force: true });   // 用户明确要压，就真压
    expect(out).not.toBe(h);
    expect(a._compactStopped.cA).toBe(false);
    const before = box.calls;
    await a.compactHistory(h);                                // 自动那一遍恢复工作
    expect(box.calls).toBe(before + 1);
  });

  it("压下来一次就把连续计数清零，不会攒到断路器上", async () => {
    const a = agent(overBudget());
    a._currentConv = "cA";
    const box = { calls: 0 };
    let reply = "啰嗦".repeat(40000);              // 第一次：摘要比原文还长 → 无收益
    a._chatStream = async () => { box.calls++; return { content: reply }; };
    const h = heavy(6);
    await a.compactHistory(h);
    expect(a._compactNoop.cA).toBe(1);
    expect(a._compactStopped.cA).toBeFalsy();         // 一次失败不该就停手
    reply = goodSummary;                           // 第二次：真的压下来了
    const out = await a.compactHistory(h);
    expect(out).not.toBe(h);
    expect(a._compactNoop.cA).toBe(0);
  });

  /* ============================================================
     沿革台账接进压缩之后要验的四件事（马拉松那一档）。
     旧的"用户消息一律原文保留"不会报错，它只是让保留侧单调涨：
     涨到某一次 after >= beforeEst，就判成"摘要不比原文短"，连续两次触发断路器，
     自动摘要对这个会话永久关闭 —— 八小时任务就是在这里断的。
     ============================================================ */
  const { USER_LEDGER_PREFIX, parseLedger } = require("../server/user-ledger");
  /* 一轮 = 一条长用户消息（Goal 自动续跑那种长度）+ 一个写类工具结果（便宜的那一遍帮不上） */
  function marathon(n, from) {
    const h = [];
    for (let i = from || 0; i < (from || 0) + n; i++) {
      h.push({ role: "user", content: "M" + i + " " + "这条要求由 Goal 自动续跑注入，带着目标与上一轮的判断，写得很长。".repeat(8) });
      h.push(asst([T("g" + i, "write_file")]));
      h.push(tool("g" + i, "ROUND-" + i + " " + big(80)));
    }
    return h;
  }
  const ledgersIn = (h) => h.filter((m) => m && m.role === "system" && String(m.content || "").indexOf(USER_LEDGER_PREFIX) === 0);

  it("马拉松：反复压缩每一次都在缩，用户侧的保留量始终有界", async () => {
    const a = agent(overBudget());
    a._currentConv = "cRun";
    a._chatStream = async () => ({ content: goodSummary });
    const spec = a._compactSpec();
    const bud = require("../server/user-ledger").budgetsOf(spec.retainTokens);
    let h = marathon(10);
    let seen = 10;
    for (let pass = 0; pass < 4; pass++) {
      const before = a._estTokens(h);
      const out = await a.compactHistory(h);                        // 自动那一遍（不 force，断路器该响就得响）
      expect(out).not.toBe(h);
      const after = a._estTokens(out);
      expect(after).toBeLessThan(before);                            // 每一次都真的压下去了，不是"成功的无用功"
      expect(a._compactStopped.cRun).toBeFalsy();
      const led = ledgersIn(out);
      expect(led.length).toBe(1);
      /* 台账自己有硬上限；用户原文的条数也不随总轮数线性涨（旧写法是"见过几条留几条"）。
         比"每一次都比上一次小"更该断的是这个：最近几轮的原文本来就该占位，
         不该跟着涨的是**被永久保留的那一侧**。 */
      expect(a._estTokens([led[0]])).toBeLessThanOrEqual(bud.ledgerTokens + 60);
      expect(out.filter((m) => m.role === "user").length).toBeLessThanOrEqual(14);
      expect(out.filter((m) => m.role === "user").length).toBeLessThan(seen);
      h = out.concat(marathon(4, 10 + pass * 4));                    // 接着跑几轮，攒新的长要求
      seen += 4;
    }
    expect(a.emitted.filter((e) => e.type === "context.compact_breaker").length).toBe(0);
  });

  it("台账只有一条，且用户要求要么留原文、要么在台账里、要么计入折叠条数", async () => {
    const a = agent(overBudget());
    a._currentConv = "cLedger";
    a._chatStream = async () => ({ content: goodSummary });
    let h = marathon(12);
    let seen = 12;
    for (let pass = 0; pass < 3; pass++) {
      h = await a.compactHistory(h);
      const led = ledgersIn(h);
      expect(led.length).toBe(1);                                    // 第二条就是"没剥离旧台账"的接线事故
      const p = parseLedger(led[0].content);
      expect(p.lines.length).toBeGreaterThan(0);
      const keptUsers = h.filter((m) => m.role === "user").length;
      expect(keptUsers + p.lines.length + p.folded).toBe(seen);       // 守恒：静默丢掉任何一条这里就红
      h = h.concat(marathon(5, 12 + pass * 5));
      seen += 5;
    }
  });

  it("台账不参与工具配对，压缩后第一次请求照样严格成对", async () => {
    const a = agent(overBudget());
    a._currentConv = "cPair";
    a._chatStream = async () => ({ content: goodSummary });
    const out = await a.compactHistory(marathon(14));
    expect(pairErrors(out)).toEqual([]);
    const led = ledgersIn(out);
    expect(led.length).toBe(1);
    expect(led[0].content).not.toMatch(/^\s*(assistant|tool):/);      // 台账是我们写的 system，不是转录片段
    expect(out[0].role).toBe("system");                                // 摘要仍然在最前
    expect(out[1]).toBe(led[0]);                                       // 台账紧跟摘要，不混进原文中间
    expect(out.some((m) => m.role === "user" && /M13 /.test(String(m.content)))).toBe(true);  // 最近那条必须还是原文
  });

  it("没有更早的用户要求时不许凭空多一条台账 system 消息", async () => {
    const a = agent(overBudget());
    a._currentConv = "cNone";
    a._chatStream = async () => ({ content: goodSummary });
    const out = await a.compactHistory(heavy(6));                      // heavy 的用户消息都很短，预算装得下
    expect(ledgersIn(out).length).toBe(0);
  });

  /* 长任务里工具结果会被 microcompact 换成一行占位，于是"保留侧的大头"只剩用户消息。
     这条夹具就是把那个状态直接摆出来：25 条长用户要求（每条 ~270 token）+ 已清理的只读工具结果。
     旧写法在这儿的下场是 after >= beforeEst（摘要那点字数根本换不回 25 条原文），
     判成"摘要不比原文短"→ 连续两次触发断路器 → 这个会话从此不自动压缩，
     水位一路涨到上游 400。这一条就是那半句"越长的任务越容易断"的判据。 */
  function postMicro(n) {
    const h = [];
    for (let i = 0; i < n; i++) {
      h.push({ role: "user", content: "M" + i + " " + "这条要求由 Goal 自动续跑注入，带着目标与上一轮的判断，写得很长。".repeat(30) });
      h.push(asst([T("r" + i, "read_file")]));
      h.push(tool("r" + i, "[已清理 24000 字符的工具结果（read_file）：src/f" + i + ".js]"));
    }
    return h;
  }

  it("工具结果清光之后：靠台账才压得动，旧写法在这里会把自动压缩永久关掉", async () => {
    const a = agent(overBudget());
    a._currentConv = "cMicro";
    a._chatStream = async () => ({ content: goodSummary });
    const h0 = postMicro(25);
    const before = a._estTokens(h0);
    const out = await a.compactHistory(h0);                             // 自动那一遍：不 force，断路器该响就得响
    expect(out).not.toBe(h0);                                           // 旧写法在这里直接返回同一个数组
    expect(a._estTokens(out)).toBeLessThan(before);
    expect(a._compactStopped.cMicro).toBeFalsy();
    expect(a.emitted.filter((e) => e.type === "context.compact_breaker").length).toBe(0);
    const led = ledgersIn(out);
    expect(led.length).toBe(1);
    const p = parseLedger(led[0].content);
    const kept = out.filter((m) => m.role === "user").length;
    expect(p.lines.length + p.folded).toBeGreaterThan(0);               // 确实折掉了东西，不是全留着
    expect(kept + p.lines.length + p.folded).toBe(25);                   // 守恒：一条都不会静默消失
    /* 再来一轮长的，第二次压缩照样压得动（旧写法第二遍就会去碰断路器） */
    const h1 = out.concat(postMicro(8));
    const before1 = a._estTokens(h1);
    const out1 = await a.compactHistory(h1);
    if (out1 !== h1) expect(a._estTokens(out1)).toBeLessThan(before1);
    expect(a._compactStopped.cMicro).toBeFalsy();
    const led1 = ledgersIn(out1);
    expect(led1.length).toBeLessThanOrEqual(1);                          // 两条台账 = 旧的那条没被剥离
  });
});
