/* ============================================================
   P6-#9 压缩时带回「压缩前读过的文件」原文快照
   （对齐 openanlan：compact 后保留最近读过的若干文件，而不是让模型重读一遍）。
   钉三件事：
     1. 攒快照的规则：同段重读不占两个名额、失败/中断的结果不进快照、超过 5 条丢最老
     2. 回放从最新往回收、单条封顶、总预算按窗口比例
     3. 只有"真的压成了"才清快照 —— 放弃压缩时历史没动，快照必须留着
   ============================================================ */
const { LlmAgent } = require("../server/agent-llm");
const { KEPT_READS_MAX, KEPT_READS_PER_FILE } = require("../server/agent-helpers");

const reads = (a, conv) => (a._recentReads && a._recentReads[conv]) || [];

function bare() {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = { llm: { contextWindow: 100000 }, context: { autoCompact: true } };
  a.emit = () => {};
  a._traceEvent = () => {};
  return a;
}

describe("_noteFileRead — 攒快照", () => {
  it("记下路径与当时的原文", () => {
    const a = bare();
    a._noteFileRead("c1", { path: "src/a.js" }, "这是 a.js 的正文");
    expect(reads(a, "c1")).toHaveLength(1);
    expect(reads(a, "c1")[0].path).toBe("src/a.js");
    expect(reads(a, "c1")[0].text).toContain("这是 a.js 的正文");
  });

  it("同一段重读只留最新一份（不占两个名额）", () => {
    const a = bare();
    a._noteFileRead("c1", { path: "src/a.js", startLine: 10 }, "旧版");
    a._noteFileRead("c1", { path: "src/a.js", startLine: 10 }, "新版");
    const l = reads(a, "c1");
    expect(l).toHaveLength(1);
    expect(l[0].text).toBe("新版");
  });

  it("同文件不同段算两条：一个函数与另一段行区间是两份不同的上下文", () => {
    const a = bare();
    a._noteFileRead("c1", { path: "src/a.js", symbol: "foo" }, "foo 函数体");
    a._noteFileRead("c1", { path: "src/a.js", startLine: 200 }, "第 200 行起");
    expect(reads(a, "c1")).toHaveLength(2);
  });

  it("失败/中断/超时的结果不进快照：那会让模型把错误文本当文件正文", () => {
    const a = bare();
    a._noteFileRead("c1", { path: "x.js" }, "错误: 文件不存在");
    a._noteFileRead("c1", { path: "y.js" }, "[已中断] 用户停止了本次任务，工具未执行。");
    a._noteFileRead("c1", { path: "z.js" }, "[超时] 工具 read_file 执行超过 120 秒");
    a._noteFileRead("c1", { path: "" }, "空路径");
    a._noteFileRead("c1", {}, "没给 path 参数");
    expect(reads(a, "c1")).toHaveLength(0);
  });

  it("超过 5 条丢最老的（与 openanlan 的「最近 ≤5 个」同一口径）", () => {
    const a = bare();
    for (let i = 0; i < KEPT_READS_MAX + 3; i++) a._noteFileRead("c1", { path: "f" + i + ".js" }, "正文" + i);
    const l = reads(a, "c1");
    expect(l).toHaveLength(KEPT_READS_MAX);
    expect(l[0].path).toBe("f3.js");                 // 前两条已被挤掉
    expect(l[l.length - 1].path).toBe("f7.js");
  });

  it("按会话分开攒：同台引擎跑多个会话，A 的文件不该进 B 的压缩", () => {
    const a = bare();
    a._noteFileRead("cA", { path: "a.js" }, "A 的正文");
    a._noteFileRead("cB", { path: "b.js" }, "B 的正文");
    expect(reads(a, "cA").map((r) => r.path)).toEqual(["a.js"]);
    expect(reads(a, "cB").map((r) => r.path)).toEqual(["b.js"]);
  });
});

describe("_keptReadsBlock / _keptReadsBudget — 回放", () => {
  it("预算随窗口取 10%（token × 0.4 字符近似），两端夹住", () => {
    const mk = (tokens) => { const a = bare(); a._ctxLimit = () => tokens; return a._keptReadsBudget(); };
    expect(mk(100000)).toBe(40000);
    expect(mk(8000)).toBe(3200);
    expect(mk(1000)).toBe(2000);                     // 下限：小模型更需要别失忆
  });

  it("从最新往回收：预算只够一条时留下的是最后读的那个", () => {
    const a = bare();
    a._ctxLimit = () => 8000;                        // 预算 3200 字符
    a._noteFileRead("c1", { path: "老.js" }, "x".repeat(2500));
    a._noteFileRead("c1", { path: "新.js" }, "y".repeat(2500));
    const b = a._keptReadsBlock("c1");
    expect(b.count).toBe(1);
    expect(b.text).toContain("新.js");
    expect(b.text).not.toContain("老.js");
  });

  it("单条封顶 8000 字符并明说被截了（不假装给全）", () => {
    const a = bare();
    a._ctxLimit = () => 100000;
    a._noteFileRead("c1", { path: "big.js" }, "z".repeat(KEPT_READS_PER_FILE + 4000));
    const b = a._keptReadsBlock("c1");
    expect(b.count).toBe(1);
    expect(b.text).toContain("这条快照本身也被截到 " + KEPT_READS_PER_FILE + " 字符");
  });

  it("没有快照就返回空，引擎据此不注入这一条", () => {
    const a = bare();
    expect(a._keptReadsBlock("没有这个会话")).toEqual({ text: "", count: 0 });
  });

  it("回执里点名这是「当时的快照、要动手前先复核」，不是本轮新读的", () => {
    const a = bare();
    a._ctxLimit = () => 100000;
    a._noteFileRead("c1", { path: "src/a.js" }, "正文");
    const b = a._keptReadsBlock("c1");
    expect(b.text).toContain("不是本轮新读的");
    expect(b.text).toContain("先用 read_file 复核");
  });
});

describe("compactHistory 真的把快照带回去", () => {
  /* 造一个"必然走到摘要"的引擎：microThreshold 抬到天上跳过便宜的那一遍，
     水位固定报高，摘要由桩函数给。 */
  function compactor(summaryText) {
    const a = bare();
    const emitted = [];
    a.emit = (m) => emitted.push(m);
    a.currentConv = () => "c1";
    a._ctxLimit = () => 100000;
    a._dropCtxAnchor = () => {};
    a._decision = () => {};
    a._compactSpec = () => ({
      // microThreshold 必须低于 used：compactHistory 第一步就是「没过线直接返回」，
      // 想跳过便宜那一遍是靠 microcompactHistory 自己清 0 条（这里没有 tool 消息）
      thresholdTokens: 1000, microThreshold: 900, retainTokens: 200, window: 100000, misconfigured: false,
    });
    a._ctxUsed = () => 5000;
    a._summarize = async () => summaryText;
    a.emitted = emitted;
    return a;
  }
  const longHistory = () => {
    const h = [];
    for (let i = 0; i < 12; i++) {
      h.push({ role: "user", content: "第" + i + "个问题：" + "话".repeat(600) });
      h.push({ role: "assistant", content: "第" + i + "个回答：" + "答".repeat(600) });
    }
    return h;
  };

  it("新历史里出现一条 system 快照，内容就是压缩前读过的原文", async () => {
    const a = compactor("摘要：前面聊了很多。");
    a._noteFileRead("c1", { path: "src/keepme.js" }, "MARKER-正文-9155");
    const out = await a.compactHistory(longHistory());
    const block = out.filter((m) => m.role === "system").map((m) => m.content).find((c) => /压缩前你读过的文件/.test(c));
    expect(block).toBeTruthy();
    expect(block).toContain("MARKER-正文-9155");
    expect(a.emitted.find((m) => m.type === "context.compact").keptFiles).toBe(1);
  });

  it("压成之后清掉快照：否则下次压缩会把同一份原文再注入一遍", async () => {
    const a = compactor("摘要：前面聊了很多。");
    a._noteFileRead("c1", { path: "src/keepme.js" }, "正文一份");
    await a.compactHistory(longHistory());
    expect(reads(a, "c1")).toHaveLength(0);
  });

  it("反向对照：摘要不比原文短而放弃压缩时，历史没动，快照必须留着", async () => {
    const a = compactor("啰嗦摘要".repeat(6000));         // 故意比原文更长 → 走 _compactAbandoned
    a._noteFileRead("c1", { path: "src/keepme.js" }, "还没进历史");
    const out = await a.compactHistory(longHistory());
    expect(out.some((m) => /压缩前你读过的文件/.test(String(m.content || "")))).toBe(false);
    expect(reads(a, "c1")).toHaveLength(1);
  });

  it("空间不够时先丢快照，压缩本身必须成（否则水位原地不动，下一轮再放弃一次，最后撞上游 400）", async () => {
    const a = compactor("摘要：前面聊了很多。");
    // 塞满 5 条 × 8000 字符的快照：比这份历史本身还大，带上它一定过不了 shrink 检查
    for (let i = 0; i < 5; i++) a._noteFileRead("c1", { path: "src/f" + i + ".js" }, "S".repeat(8000));
    const out = await a.compactHistory(longHistory());
    expect(out.some((m) => /压缩前你读过的文件/.test(String(m.content || "")))).toBe(false);
    const ev = a.emitted.find((m) => m.type === "context.compact");
    expect(ev).toBeTruthy();                 // 压缩仍然成功
    expect(ev.keptFiles).toBe(0);
    expect(ev.readsDropped).toBeGreaterThan(0);
    // 被挤掉的快照不能顺手删掉：下次压缩空间宽裕还想用
    expect(reads(a, "c1")).toHaveLength(5);
  });

  it("没有读过任何文件时不多塞一条空 system", async () => {
    const a = compactor("摘要：前面聊了很多。");
    const out = await a.compactHistory(longHistory());
    expect(out.some((m) => /压缩前你读过的文件/.test(String(m.content || "")))).toBe(false);
    expect(a.emitted.find((m) => m.type === "context.compact").keptFiles).toBe(0);
  });
});
