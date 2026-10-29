/* ============================================================
   P6-#8 技能目录（对齐 openanlan / Claude Code 的 skill_listing attachment）。

   这一步补的是一个**发现性**漏洞，不是预算数字：
   引擎只按触发词把 top-3 技能塞进 turn 桶（agent-llm.js 的 skills.match(userText, 3)），
   而工具面只有 use_skill（按名字取正文），没有任何"列一下都有什么"的入口。
   于是"装了技能但触发词没写对"= 那个技能对模型永远不存在。

   所以这里钉三件事：
     1. 目录确实进了 stable 桶（进 stable 而不是 turn：每轮重算会打碎缓存前缀）
     2. 预算阶梯真的逐级降，且内置项永不降
     3. 装不下时**如实报数**，不假装列全了
   ============================================================ */
const { LlmAgent } = require("../server/agent-llm");
const { SkillStore } = require("../server/skill-store");

const LONG = "这是一段刻意写长的技能描述，用来验证降级阶梯是否真的起作用。".repeat(6);
const call = (entries, budget) => SkillStore.prototype.formatCatalog.call({}, entries, budget);

describe("formatCatalog：预算阶梯", () => {
  const entries = [
    { skill: { name: "内置A", description: LONG }, builtin: true },
    { skill: { name: "技能B", description: LONG, trigger: "部署、上线、发布" }, builtin: false },
    { skill: { name: "技能C", description: LONG }, builtin: false },
  ];

  it("预算宽裕时全部走第 0 级：描述满 160 字、触发词在列", () => {
    const out = call(entries, 100000);
    expect(out).toContain("技能B");
    expect(out).toContain("（触发词：部署、上线、发布）");
    // 第 0 级的描述截到 160 字，所以一行长度必然远超短描述档
    const rowB = out.split("\n").find((l) => l.startsWith("- 技能B"));
    expect(rowB.length).toBeGreaterThan(150);
  });

  it("中等预算降到第 1 级：只留 60 字描述，触发词整段不再出现", () => {
    const out = call(entries, 400);
    const rowB = out.split("\n").find((l) => l.startsWith("- 技能B"));
    expect(rowB.length).toBeGreaterThan(20);
    expect(rowB.length).toBeLessThan(90);
    expect(out).not.toContain("触发词：");
    expect(out).not.toMatch(/因预算未列出/);   // 降档不等于丢弃，这里三条都在
  });

  it("极小预算降到第 2 级并如实报数；内置那条永不参与降级", () => {
    const out = call(entries, 120);
    expect(out).toContain("（另有 2 条技能因预算未列出）");
    const rowA = out.split("\n").find((l) => l.startsWith("- 内置A"));
    expect(rowA.length).toBeGreaterThan(150);   // 内置仍按第 0 级给全
  });

  it("没有技能时返回空串（引擎据此整块不注入，不会留下光秃秃的标题）", () => {
    expect(call([], 10000)).toBe("");
  });

  it("末尾的用法提示始终在：目录不是必用清单，要用先 use_skill 取正文", () => {
    expect(call(entries, 100000)).toContain("use_skill(name)");
  });
});

describe("allForListing：池子合并与优先级", () => {
  const fake = {
    _marketSkills: [{ name: "同名技能", description: "市场版" }],
    _mergedUserSkills: () => [{ name: "用户版", description: "d" }],
    _localSkills: [{ name: "同名技能", description: "本地版应被丢掉" }, { name: "关掉的", description: "d", disabled: true }],
    _builtinSkills: [{ name: "内置读码", description: "d" }],
  };
  const list = SkillStore.prototype.allForListing.call(fake);

  it("名字撞车按 市场 > 用户 > 本地 取舍，与 findByName 同一条优先级", () => {
    const dup = list.filter((e) => e.skill.name === "同名技能");
    expect(dup).toHaveLength(1);
    expect(dup[0].skill.description).toBe("市场版");
  });

  it("面板里关掉的技能不进目录（与 match() 的语义一致：关 = 别主动推给我）", () => {
    expect(list.some((e) => e.skill.name === "关掉的")).toBe(false);
  });

  it("内置项被标出来，供阶梯那一层豁免降级", () => {
    expect(list.filter((e) => e.builtin).length).toBeGreaterThan(0);
    expect(list.find((e) => e.skill.name === "内置读码").builtin).toBe(true);
    expect(list.find((e) => e.skill.name === "用户版").builtin).toBe(false);
  });
});

describe("预算随上下文窗口缩放", () => {
  const withWindow = (tokens) => {
    const a = Object.create(LlmAgent.prototype);
    a._ctxLimit = () => tokens;
    return a._skillCatalogBudget();
  };

  it("常规窗口取 1%（token × 0.04 字符近似）", () => {
    expect(withWindow(100000)).toBe(4000);
    expect(withWindow(200000)).toBe(8000);   // 与 openanlan 的缺省 8000 字符同一量级
  });

  it("两端都夹住：小窗口不低于 1200，百万窗口不超 16000", () => {
    expect(withWindow(8000)).toBe(1200);
    expect(withWindow(1000000)).toBe(16000);
  });

  it("窗口取不到时退回 8000 token 的口径，不返回 0 让目录整块消失", () => {
    const a = Object.create(LlmAgent.prototype);
    a._ctxLimit = () => 0;
    expect(a._skillCatalogBudget()).toBe(1200);
  });
});

describe("目录真的进了 stable 桶", () => {
  function agent(skills) {
    const a = Object.create(LlmAgent.prototype);
    a.cfg = {
      llm: { contextWindow: 100000 }, context: { budgetTokens: 1000000, autoCompact: false },
      memory: { enabled: false }, permissions: { mode: "ask", allow: [], deny: [] },
      persona: { active: "default" }, repoMap: false,
    };
    a.history = [];
    a.emit = () => {};
    a._traceEvent = () => {};
    a.soul = { get: () => { throw new Error("stub"); } };
    a.progression = { get: () => { throw new Error("stub"); } };
    a.personaText = () => "";
    a.loadRulesParts = () => ({ stable: [], conditional: [] });
    a._touchedPaths = () => [];
    a.skills = skills;
    return a;
  }
  const withCatalog = {
    match: () => [], recordUse: () => {},
    formatCatalog: () => "- 部署技能：一句话",
  };

  it("stable 里出现【技能目录】，内容就是 formatCatalog 的返回", () => {
    const p = agent(withCatalog).buildAugmentParts("随便聊聊");
    const block = p.stable.find((s) => /【技能目录/.test(s));
    expect(block).toBeTruthy();
    expect(block).toContain("- 部署技能：一句话");
  });

  it("目录为空就不注入：不留一个只有标题的空块", () => {
    const p = agent(Object.assign({}, withCatalog, { formatCatalog: () => "" })).buildAugmentParts("随便聊聊");
    expect(p.stable.some((s) => /【技能目录/.test(s))).toBe(false);
  });

  it("反向对照：老替身里没有 formatCatalog（终端独立引擎就是这种形状），主流程不炸也不注入", () => {
    const p = agent({ match: () => [], formatForContext: () => "", recordUse: () => {}, list: () => [] })
      .buildAugmentParts("随便聊聊");
    expect(p.stable.some((s) => /【技能目录/.test(s))).toBe(false);
  });

  it("formatCatalog 抛错只少这一条注入，其余 stable 桶照常（与规则/仓库结构同一口径）", () => {
    const p = agent({ match: () => [], recordUse: () => {}, formatCatalog: () => { throw new Error("boom"); } })
      .buildAugmentParts("随便聊聊");
    expect(Array.isArray(p.stable)).toBe(true);
    expect(p.stable.some((s) => /【技能目录/.test(s))).toBe(false);
  });
});
