/* ============================================================
   P1-6 提示词装配回归：把 system 前缀按「变化频率」分桶，运行态改发到历史末尾。

   这里守的是三条不变式（前缀缓存收益成立的前提）：
     1. 用户输入只影响 turn 桶，identity/stable 桶逐字节不变
        —— 上游按字节匹配前缀，越靠前的段常变，后面整段前缀就每轮作废。
     2. 运行态（会话目标 / 计划实时进度 / 模式约束）绝不进 system，
        且每轮重算：以前它是本轮开始时冻结进 system 的，Agent 连跑 20 轮
        看到的还是第 0 轮进度，等于不知道自己做到哪了。
     3. _runtimeContext 幂等：同状态两次调用返回同一字符串，
        调用方据此决定要不要重建消息（别每轮都追加一条）。

   外加一条落盘回归：CONV_MAX_MSGS 曾被上一条声明的行尾注释吞掉，
   于是每次落盘都抛 ReferenceError，被 try/catch 压成一句 console.warn，
   表现是"会话存档静默不更新"。测试必须断言文件真的写出来了，
   只断言"没抛错"抓不到它。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LlmAgent } = require("../server/agent-llm");

const CONV_MAX_MSGS_KEPT = 80;   // 与 server/agent-llm.js 里的落盘裁剪上限一致

function makeAgent(cfgExtra, stubs) {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = Object.assign({
    llm: { contextWindow: 100000 },
    context: { budgetTokens: 1000000, autoCompact: false },
    memory: { enabled: false },
    permissions: { mode: "ask", allow: [], deny: [] },
    persona: { active: "default" },
    repoMap: false,
  }, cfgExtra || {});
  a.history = [];
  a.emitted = [];
  a.emit = (m) => a.emitted.push(m);
  a._traceEvent = () => {};
  // 进化反哺依赖 soul/progression 存储，本测试不关心它的内容， stub 成"抛错"即可
  // （buildAugmentParts 里那段是 try/catch 包裹的，失败只少一条 stable 注入）
  a.soul = { get: () => { throw new Error("stub"); } };
  a.progression = { get: () => { throw new Error("stub"); } };
  // 生产里这几个 store 一定存在；给一组"什么都不命中"的默认替身，
  // 免得每个用例都要重复 stub，也让"只关心某一桶"的用例保持干净。
  a.personaText = () => "";
  a.skills = { match: () => [], formatForContext: () => "", recordUse: () => {}, list: () => [] };
  a.loadRulesParts = () => ({ stable: [], conditional: [] });
  a._touchedPaths = () => [];
  Object.assign(a, stubs || {});
  return a;
}

/* 记忆/技能/规则的常用替身：
   memory 与「无条件规则」是 stable 桶，rules 的按需命中部分和 skills 是 turn 桶。
   loadRulesParts 的返回形状必须与真实实现一致（{label,content,why} 的块数组），
   因为 buildAugmentParts 会把它交给 rulesLib.assemble 去拼。 */
function dataStubs() {
  return {
    memory: {
      formatForContext: () => "项目记忆正文",
      list: () => [],
      topForContext: () => [],
    },
    userMemory: { formatForContext: () => "用户级记忆正文" },
    skills: {
      match: (t) => (/部署/.test(t) ? [{ id: "s1" }] : []),
      formatForContext: () => "技能正文",
      recordUse: () => {},
    },
    loadRulesParts: () => ({
      stable: [{ label: "AGENTS.md", content: "规则正文", why: "根级规则" }],
      conditional: [{ label: ".pancode/rules/x.md", content: "按需规则正文", why: "命中 src/x.js" }],
    }),
  };
}

describe("buildAugmentParts：按变化频率分桶", () => {
  it("persona 落进 identity 且是唯一内容", () => {
    const a = makeAgent({}, { personaText: () => "【专家设定】全栈" });
    const p = a.buildAugmentParts("随便聊聊");
    expect(p.identity).toEqual(["【专家设定】全栈"]);
    expect(p.stable).toEqual([]);
    expect(p.turn).toEqual([]);
  });

  it("无条件规则与记忆进 stable，按需规则与 Skill 进 turn，互不串桶", () => {
    const a = makeAgent({ memory: { enabled: true }, rules: { enabled: true } }, dataStubs());
    const p = a.buildAugmentParts("帮我部署一下");
    expect(p.stable.join("\n")).toContain("规则正文");
    expect(p.stable.join("\n")).toContain("项目记忆正文");
    expect(p.stable.join("\n")).toContain("用户级记忆正文");
    expect(p.stable.join("\n")).not.toContain("按需规则正文");
    expect(p.turn.join("\n")).toContain("按需规则正文");
    expect(p.turn.join("\n")).toContain("技能正文");
    expect(p.identity).toEqual([]);
  });

  it("用户输入只换 turn 桶：identity/stable 逐字节不变（前缀缓存成立的根据）", () => {
    const a = makeAgent({ memory: { enabled: true }, rules: { enabled: true } }, dataStubs());
    const p1 = a.buildAugmentParts("第一条消息");
    const p2 = a.buildAugmentParts("换一个话题，讲讲部署");
    expect(JSON.stringify(p1.identity)).toBe(JSON.stringify(p2.identity));
    expect(JSON.stringify(p1.stable)).toBe(JSON.stringify(p2.stable));
    // 命中 Skill 的那条才多出技能段
    expect(p1.turn.join("\n")).not.toContain("技能正文");
    expect(p2.turn.join("\n")).toContain("技能正文");
  });

  it("buildSystemAugment 的段序是 identity → 规则 → 记忆（硬约束统摄参考项）", () => {
    const a = makeAgent({ memory: { enabled: true }, rules: { enabled: true } }, Object.assign(
      { personaText: () => "〔人格〕" }, dataStubs()));
    const s = a.buildSystemAugment("部署");
    expect(s.indexOf("〔人格〕")).toBeGreaterThanOrEqual(0);
    expect(s.indexOf("规则正文")).toBeGreaterThan(s.indexOf("〔人格〕"));
    expect(s.indexOf("规则正文")).toBeLessThan(s.indexOf("项目记忆正文"));
    expect(s.indexOf("项目记忆正文")).toBeLessThan(s.indexOf("技能正文"));
  });

  it("仓库结构属于 stable，不随本轮输入抖动", () => {
    const a = makeAgent({ repoMap: true }, dataStubs());
    a.history = [{ role: "user", content: "hi" }];
    // files.list 供 repoOverview 用；无文件时返回空串，只断言它没被塞进 turn 桶
    const p = a.buildAugmentParts("");
    expect(p.turn.join("\n")).not.toContain("【仓库结构】");
  });
});

describe("_runtimeContext：运行态发到末尾而不是 system", () => {
  it("无目标、无计划、无模式约束时返回空串（不凭空追加消息）", () => {
    const a = makeAgent();
    a._goal = "";
    a.plan = { getActive: () => null };
    expect(a._runtimeContext("c1")).toBe("");
  });

  it("会话目标被 <runtime_context> 包裹，并声明「以本条为准」", () => {
    const a = makeAgent();
    a._goal = "把内核跑通";
    a.plan = { getActive: () => null };
    const rc = a._runtimeContext("c1");
    expect(rc.startsWith("<runtime_context>")).toBe(true);
    expect(rc.endsWith("</runtime_context>")).toBe(true);
    expect(rc).toContain("【本次会话目标】把内核跑通");
    expect(rc).toContain("以本条为准");
  });

  it("计划进度：done 与 skipped 都算完成，待办列在后面", () => {
    const a = makeAgent();
    a._goal = "";
    a.plan = {
      getActive: () => ({
        title: "改造",
        tasks: [
          { text: "A", status: "done" },
          { text: "B", status: "skipped" },
          { text: "C", status: "in_progress" },
          { text: "D", status: "pending" },
        ],
      }),
    };
    const rc = a._runtimeContext("c1");
    expect(rc).toContain("已完成 2/4 步");
    expect(rc).toContain("C");
    expect(rc).toContain("D");
    expect(rc).not.toContain("待办：A");
  });

  it("待办超过 6 步只列前 6 条（运行态自己不能变成新的上下文大户）", () => {
    const a = makeAgent();
    a._goal = "";
    a.plan = {
      getActive: () => ({
        title: "长计划",
        tasks: Array.from({ length: 9 }, (_, i) => ({ text: "步" + (i + 1), status: "pending" })),
      }),
    };
    const rc = a._runtimeContext("c1");
    expect(rc).toContain("已完成 0/9 步");
    expect(rc).toContain("步6");
    expect(rc).not.toContain("步7");
  });

  it("全部步骤完成后不再罗列待办", () => {
    const a = makeAgent();
    a._goal = "";
    a.plan = {
      getActive: () => ({ title: "收尾", tasks: [{ text: "A", status: "done" }] }),
    };
    expect(a._runtimeContext("c1")).toContain("全部步骤已完成");
  });

  it("Ask 与规划模式的约束发在运行态里，不进 system", () => {
    const ask = makeAgent({ agentMode: "ask" });
    ask._goal = "";
    ask.plan = { getActive: () => null };
    expect(ask._runtimeContext("c1")).toContain("Ask（仅问答）模式已开启");

    const plan = makeAgent({ planMode: true });
    plan._goal = "";
    plan.plan = { getActive: () => null };
    expect(plan._runtimeContext("c1")).toContain("规划模式已开启");
  });

  it("同状态两次调用逐字节相同；进度一变就必须变（调用方据此重建消息）", () => {
    const a = makeAgent();
    a._goal = "G";
    let done = 0;
    a.plan = {
      getActive: () => ({
        title: "T",
        tasks: [{ text: "A", status: done ? "done" : "pending" }, { text: "B", status: "pending" }],
      }),
    };
    const first = a._runtimeContext("c1");
    expect(a._runtimeContext("c1")).toBe(first);
    done = 1;
    expect(a._runtimeContext("c1")).not.toBe(first);
    expect(a._runtimeContext("c1")).toContain("已完成 1/2 步");
  });

  it("getActive 按传入的 convId 取计划，不能串会话", () => {
    const a = makeAgent();
    a._goal = "";
    a._currentConv = "会话A";
    const seen = [];
    a.plan = {
      getActive: (cid) => {
        seen.push(cid);
        return cid === "会话B" ? { title: "B 的计划", tasks: [{ text: "x", status: "pending" }] } : null;
      },
    };
    expect(a._runtimeContext("会话B")).toContain("B 的计划");
    expect(a._runtimeContext(undefined)).not.toContain("B 的计划");
    expect(seen).toEqual(["会话B", "会话A"]);
  });
});

describe("渐进披露实测（P1-#10：目录常驻、正文按需）", () => {
  /* 优化方案 §6.3 原本把这条列为待做，实测后发现 pancode 早就做对了：
     记忆只注入 top-10 × 160 字摘录，技能只注入 名称/描述/触发词 + 一句"要用的话调 use_skill 取正文"。
     这里用真实的两个 store 量一遍，把"有界"钉成断言——以后谁把全文塞回 aug，这条会红。 */
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-disc-")); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

  it("50 条各 5000 字的记忆：注入量仍有界，且不含任何整段正文", () => {
    const { MemoryStore } = require("../server/memory-store");
    const ms = new MemoryStore(path.join(dir, "mem.json"));
    const long = [];
    for (let i = 0; i < 50; i++) {
      const content = ("纪要" + i + "　").repeat(1250);      // ≈5000 字符
      long.push(content);
      ms.add("lesson", "主题" + i, content);
    }
    expect(ms.size).toBe(50);
    const out = ms.formatForContext(3000);
    expect(out.length).toBeLessThanOrEqual(3020);
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(10);   // 只 top 10
    // 每条摘录被切到 160 字，绝不把 5000 字的正文带进上下文
    for (const body of long.slice(0, 10)) expect(out).not.toContain(body.slice(0, 400));
    // 但取回通道在：类型/主题/强度/年龄都在目录里，模型才知道该不该去 search_memory
    expect(out).toMatch(/\(高\)|\(中\)/);
    expect(out).toContain("[lesson]");
  });

  it("记忆条数不足 10 时按实际条数注入，不硬凑", () => {
    const { MemoryStore } = require("../server/memory-store");
    const ms = new MemoryStore(path.join(dir, "mem2.json"));
    ms.add("preference", "语言", "汇报一律用中文");
    expect(ms.formatForContext(3000).split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
  });

  it("技能的 1 万字正文不进目录，目录显式指路 use_skill", () => {
    const { SkillStore } = require("../server/skill-store");
    const ss = new SkillStore(path.join(dir, "market.json"), path.join(dir, "local.json"),
      path.join(dir, "builtin"), path.join(dir, "user.json"));
    const body = "步骤说明：先核对现状，再落改动，最后自测。".repeat(400);   // ≈1 万字
    const rec = ss.add({ name: "发布流程", description: "把改动发到测试环境", trigger: "部署,发布", body }, "manual");
    expect(rec && rec._auditRejected).toBeFalsy();
    const matched = ss.match("帮我把这次改动部署上去", 3);
    expect(matched.map((s) => s.name)).toContain("发布流程");
    const out = ss.formatForContext(matched);
    expect(out).not.toContain(body.slice(0, 60));
    expect(out).toContain("use_skill");
    expect(out.length).toBeLessThan(900);
    // 描述再长也被切：目录只给 160 字
    expect(out).not.toContain("把改动发到测试环境".repeat(30));
  });

  it("多个长技能同时命中时目录仍有界（最坏情况不吞掉整段前缀）", () => {
    const { SkillStore } = require("../server/skill-store");
    const ss = new SkillStore(path.join(dir, "m2.json"), path.join(dir, "l2.json"),
      path.join(dir, "builtin"), path.join(dir, "u2.json"));
    for (let i = 0; i < 8; i++) {
      ss.add({ name: "技能" + i, description: "描述".repeat(600), trigger: "部署", body: "正文".repeat(5000) }, "manual");
    }
    const out = ss.formatForContext(ss.match("部署一下", 3));
    expect(out.length).toBeLessThan(1200);
  });
});

describe("会话落盘裁剪（CONV_MAX_MSGS 回归）", () => {

  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-conv-")); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

  /* flushConversations 内部先 _snapshotCurrent()：用 this.history 覆盖当前会话的 history。
     所以测试必须以 this.history 为真值来搭，直接往 Map 里塞会在快照那一步被抹掉。 */
  function agentWith(history, extra) {
    const a = makeAgent();
    a._currentConv = "c1";
    a.round = 3;
    a.convChanges = {};
    a.history = history;
    a.conversations = new Map(Object.entries(extra || {}));
    a._convPath = path.join(dir, "conversations.json");
    a._convSaveTimer = null;
    return a;
  }

  it("flushConversations 真的把文件写出来（常量丢失时会抛错并被 try/catch 静默吞掉）", () => {
    const warn = console.warn;
    const swallowed = [];
    console.warn = (...args) => swallowed.push(args.join(" "));
    try {
      agentWith([{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }]).flushConversations();
    } finally { console.warn = warn; }
    expect(swallowed).toEqual([]);
    expect(fs.existsSync(path.join(dir, "conversations.json"))).toBe(true);
    const data = JSON.parse(fs.readFileSync(path.join(dir, "conversations.json"), "utf8"));
    expect(data.current).toBe("c1");
    expect(data.conversations[0].history).toHaveLength(2);
  });

  it("单会话超过上限时只保留最近 80 条", () => {
    const long = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "m" + i }));
    const a = agentWith(long);
    a.flushConversations();
    const data = JSON.parse(fs.readFileSync(a._convPath, "utf8"));
    const kept = data.conversations[0].history;
    expect(kept).toHaveLength(CONV_MAX_MSGS_KEPT);
    expect(kept[0].content).toBe("m120");
    expect(kept[kept.length - 1].content).toBe("m199");
  });

  it("空历史会话不落盘（别在存档里堆空壳）", () => {
    const a = agentWith([{ role: "user", content: "有内容" }], {
      c2: { history: [], round: 0, ts: Date.now(), changes: [] },
    });
    a.flushConversations();
    const data = JSON.parse(fs.readFileSync(a._convPath, "utf8"));
    expect(data.conversations.map((c) => c.id)).toEqual(["c1"]);
  });

  it("history 不是数组时按空处理，不抛错也不写空档", () => {
    const a = agentWith(null);
    a._convPath = path.join(dir, "conv2.json");
    const warn = console.warn;
    const swallowed = [];
    console.warn = (...args) => swallowed.push(args.join(" "));
    try { a.flushConversations(); } finally { console.warn = warn; }
    expect(swallowed).toEqual([]);
    expect(fs.existsSync(a._convPath)).toBe(false);
  });
});

describe("记忆溯源台账：content 必须随台账走（回显卡要能看到记了什么）", () => {
  const entry = (id, scope, extra) => Object.assign(
    { id, type: "lesson", topic: "主题" + id, content: "经验正文" + id, valueScore: 3, accessCount: 1 },
    extra || {});
  const memStubs = (projectEntries, userEntries) => ({
    memory: {
      formatStable: () => "stable 注入文本",
      formatRelevant: () => "relevant 注入文本",
      stableForContext: () => projectEntries.filter((e) => e._stable),
      relevantForContext: () => projectEntries.filter((e) => !e._stable),
      list: () => [],
      _tokenizeText: () => new Set(),
    },
    userMemory: {
      formatStable: () => "用户级 stable 注入文本",
      stableForContext: () => userEntries.filter((e) => e._stable),
      relevantForContext: () => userEntries.filter((e) => !e._stable),
      list: () => [],
      _tokenizeText: () => new Set(),
    },
  });

  it("台账条目带 content 摘要（≤120 字、压平空白），前端回显卡才有正文可显", () => {
    // 用户级记忆只有稳定道（buildAugmentParts 不给 userMemory 走 relevant）
    const proj = [
      entry("p1", "project", { content: "  a\n\n  b   c  " + "x".repeat(130), _stable: true }),
      entry("p2", "project", { _stable: false }),
    ];
    const user = [entry("u1", "user", { _stable: true })];
    const a = makeAgent({ memory: { enabled: true } }, memStubs(proj, user));
    a.buildAugmentParts("问题");
    const used = a._usedMemory;
    expect(used.length).toBe(3);
    for (const u of used) {
      expect(typeof u.content).toBe("string");
      expect(u.content.length).toBeGreaterThan(0);
      expect(u.content).not.toMatch(/\n/);
      expect(u.content.length).toBeLessThanOrEqual(120);
    }
    // scope 传递不破：用户级仍是 user，且注入文本本身不受影响
    expect(used.filter((u) => u.scope === "user").map((u) => u.id)).toEqual(["u1"]);
    expect(used.find((u) => u.id === "u1").content).toBe("经验正文u1");
  });

  it("条目没有 content 时不炸，content 为空串", () => {
    const proj = [entry("p2", "project", { content: undefined, _stable: true })];
    const a = makeAgent({ memory: { enabled: true } }, memStubs(proj, []));
    a.buildAugmentParts("问题");
    expect(a._usedMemory.length).toBe(1);
    expect(a._usedMemory[0].content).toBe("");
  });
});
