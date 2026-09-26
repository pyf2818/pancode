/* ============================================================
   W2 Experts 单测
   - parseExpertMd：frontmatter 解析 / role·methodology 切分 / CRLF / 坏包拒绝
   - ExpertStore：三层合并（project > user > builtin）/ byIdOrName / 坏文件跳过 / 缺目录容错
   - personaText：内置 id / 专家包 id / custom 兼容 / @专家单条切换（id+名）/ 未命中忽略
   - buildSystemAugment：专家注入在首位 / @切换覆盖 active
   - _subToolset：白名单收敛 / BLOCK 不可解锁 / 全不命中回退
   - _subSystemPrompt：专家模式含 role+methodology
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { ExpertStore, BUILTIN_EXPERTS, parseExpertMd, formatExpertPrompt } = require("../server/expert-store");
const { LlmAgent } = require("../server/agent-llm");

let tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w2-exp-")); // 模块级创建：describe 收集期的 makeAgent 也要用
afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

function writeExpert(dir, file, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), text, "utf8");
}

/* 构造带 mock 依赖的最小 agent（复用 W3 的 Object.create 模式） */
function makeAgent(cfgExtra) {
  const agent = Object.create(LlmAgent.prototype);
  agent.cfg = Object.assign({ persona: { active: "default", systemPrompt: "" }, rules: { enabled: false }, memory: { enabled: false }, repoMap: false }, cfgExtra || {});
  agent.experts = new ExpertStore(path.join(tmp, "proj-exp"), path.join(tmp, "user-exp"));
  agent.plan = { formatForContext: () => "" };
  agent.skills = { match: () => [], formatForContext: () => "", recordUse: () => {} };
  agent.soul = { get: () => ({}) };
  agent.progression = { get: () => ({ path: "" }) };
  agent.memory = { formatForContext: () => "", list: () => [] };
  agent.userMemory = null;
  agent._evolutionBias = () => null;
  agent._currentConv = "t";
  return agent;
}

describe("parseExpertMd — 专家包解析", () => {
  it("完整解析：frontmatter 元数据 + 正文切分 role/methodology", () => {
    const text = [
      "---",
      "name: 代码审查专家",
      "description: 对抗性审查",
      "tool_whitelist: [read_file, search_code, repo_map]",
      "---",
      "你是一位严苛的代码审查专家，专注找问题。",
      "",
      "## 方法论",
      "1. 先读全上下文再评判",
      "2. 对抗性审查：假设代码有错",
    ].join("\n");
    const e = parseExpertMd(text, "code-review", "project");
    expect(e).toBeTruthy();
    expect(e.id).toBe("code-review");
    expect(e.name).toBe("代码审查专家");
    expect(e.description).toBe("对抗性审查");
    expect(e.role).toBe("你是一位严苛的代码审查专家，专注找问题。");
    expect(e.methodology).toContain("## 方法论");
    expect(e.methodology).toContain("对抗性审查：假设代码有错");
    expect(e.tool_whitelist).toEqual(["read_file", "search_code", "repo_map"]);
    expect(e.source).toBe("project");
  });

  it("无 frontmatter：正文第一段=role，其余=methodology；CRLF 归一化", () => {
    const e = parseExpertMd("角色甲。\r\n\r\n方法论乙。\r\n步骤丙。", "x", "user");
    expect(e.name).toBe("x"); // 无 frontmatter 时 id 兜底为 name
    expect(e.role).toBe("角色甲。");
    expect(e.methodology).toBe("方法论乙。\n步骤丙。");
  });

  it("单段正文：全当 role，methodology 为空", () => {
    const e = parseExpertMd("你是一位测试专家。", "t", "user");
    expect(e.role).toBe("你是一位测试专家。");
    expect(e.methodology).toBe("");
  });

  it("坏包拒绝：空文本 / 无 name 且无 id → null；有 id 时回退文件名为 name", () => {
    expect(parseExpertMd("", "a", "user")).toBeNull();
    expect(parseExpertMd("   \n  ", "a", "user")).toBeNull();
    expect(parseExpertMd("---\ndescription: 没名字\n---\n正文", null, "user")).toBeNull();
    const e = parseExpertMd("---\ndescription: 没写名字\n---\n正文角色。", "fid", "user");
    expect(e.name).toBe("fid"); // name 缺失回退文件名
    expect(e.role).toBe("正文角色。");
  });
});

describe("ExpertStore — 三层合并与查找", () => {
  beforeEach(() => {
    fs.rmSync(path.join(tmp, "proj-exp"), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, "user-exp"), { recursive: true, force: true });
  });

  it("内置基线：3 个内置专家，id 与旧 PERSONAS 键一致，byIdOrName 支持 id 与中文名", () => {
    const s = new ExpertStore(null, null);
    expect(BUILTIN_EXPERTS.map((e) => e.id).sort()).toEqual(["backend", "frontend", "fullstack"]);
    expect(s.byIdOrName("fullstack").name).toBe("全栈工程师");
    expect(s.byIdOrName("全栈工程师").id).toBe("fullstack");
    expect(s.byIdOrName("不存在的专家")).toBeNull();
    expect(s.byIdOrName("")).toBeNull();
    expect(s.byIdOrName(null)).toBeNull();
  });

  it("用户级覆盖内置（同 id fullstack.md），项目级覆盖用户级", () => {
    writeExpert(path.join(tmp, "user-exp"), "fullstack.md", "---\nname: 我的全栈\n---\n用户级角色。\n\n用户级方法论。");
    writeExpert(path.join(tmp, "proj-exp"), "fullstack.md", "---\nname: 项目全栈\n---\n项目级角色。\n\n项目级方法论。");
    const s = new ExpertStore(path.join(tmp, "proj-exp"), path.join(tmp, "user-exp"));
    const top = s.byIdOrName("fullstack");
    expect(top.name).toBe("项目全栈");
    expect(top.source).toBe("project");
    // 用户级仍可按名找到？——同名 id 已被项目级遮蔽，list 只保留一份
    expect(s.list().filter((e) => e.id === "fullstack")).toHaveLength(1);
    // 其他内置不受影响
    expect(s.byIdOrName("frontend").source).toBe("builtin");
  });

  it("list 合并视图：项目+用户+内置去重，不重不漏", () => {
    writeExpert(path.join(tmp, "user-exp"), "reviewer.md", "---\nname: 审查专家\n---\n审查角色。");
    writeExpert(path.join(tmp, "proj-exp"), "doc-writer.md", "---\nname: 文档专家\n---\n文档角色。");
    const s = new ExpertStore(path.join(tmp, "proj-exp"), path.join(tmp, "user-exp"));
    const ids = s.list().map((e) => e.id);
    expect(ids).toContain("reviewer");
    expect(ids).toContain("doc-writer");
    expect(ids).toContain("fullstack");
    expect(new Set(ids).size).toBe(ids.length); // 无重复
  });

  it("坏文件跳过 + 缺目录不炸", () => {
    writeExpert(path.join(tmp, "user-exp"), "broken.md", "===非法frontmatter\n没有名字");
    writeExpert(path.join(tmp, "user-exp"), "good.md", "---\nname: 好专家\n---\n角色。");
    const s = new ExpertStore(path.join(tmp, "no-such-dir"), path.join(tmp, "user-exp"));
    const names = s.list().map((e) => e.name);
    expect(names).toContain("好专家");
    expect(names).not.toContain("没有名字");
  });
});

describe("personaText — 人格/专家注入", () => {
  beforeEach(() => {
    fs.rmSync(path.join(tmp, "proj-exp"), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, "user-exp"), { recursive: true, force: true });
  });

  it("active=fullstack（内置 id）→ 专家设定头 + role/methodology", () => {
    const a = makeAgent({ persona: { active: "fullstack", systemPrompt: "" } });
    const out = a.personaText("");
    expect(out).toContain("【专家设定·全栈工程师】");
    expect(out).toContain("资深全栈工程师");
    expect(out).toContain("契约、错误码与前端调用");
  });

  it("active=default → 空串（向后兼容）；active=custom → 【人格设定】不变", () => {
    expect(makeAgent({ persona: { active: "default" } }).personaText("")).toBe("");
    const c = makeAgent({ persona: { active: "custom", systemPrompt: "你是一只猫" } });
    expect(c.personaText("")).toBe("【人格设定】\n你是一只猫");
  });

  it("active=专家包 id → 专家包内容注入", () => {
    writeExpert(path.join(tmp, "user-exp"), "reviewer.md", "---\nname: 审查专家\n---\n你是审查者。\n\n先读后判。");
    const a = makeAgent({ persona: { active: "reviewer", systemPrompt: "" } });
    const out = a.personaText("");
    expect(out).toContain("【专家设定·审查专家】");
    expect(out).toContain("你是审查者。");
    expect(out).toContain("先读后判。");
  });

  it("@专家单条切换：中文名与 id 均可，覆盖 active；未命中 @ 忽略", () => {
    writeExpert(path.join(tmp, "user-exp"), "reviewer.md", "---\nname: 审查专家\n---\n你是审查者。\n\n先读后判。");
    const a = makeAgent({ persona: { active: "fullstack", systemPrompt: "" } });
    const byName = a.personaText("@审查专家 帮我审查这段代码");
    expect(byName).toContain("【专家设定·审查专家（仅本条消息生效）】");
    expect(byName).toContain("你是审查者。");
    expect(byName).not.toContain("全栈工程师");
    const byId = a.personaText("@reviewer 审查一下");
    expect(byId).toContain("审查专家");
    // 未命中：回落到 active
    const miss = a.personaText("@张三 你好");
    expect(miss).toContain("【专家设定·全栈工程师】");
    // 无 @：active 正常
    expect(a.personaText("普通消息")).toContain("全栈工程师");
  });
});

describe("buildSystemAugment — 专家注入位置", () => {
  beforeEach(() => {
    fs.rmSync(path.join(tmp, "proj-exp"), { recursive: true, force: true });
    fs.rmSync(path.join(tmp, "user-exp"), { recursive: true, force: true });
  });

  it("专家 active 时【专家设定】位于 system augment 首位", () => {
    const a = makeAgent({ persona: { active: "fullstack", systemPrompt: "" }, memory: { enabled: true } });
    a.memory = { formatForContext: () => "项目记忆内容", list: () => [] };
    const out = a.buildSystemAugment("");
    expect(out.startsWith("【专家设定·全栈工程师】")).toBe(true);
    expect(out.indexOf("【专家设定")).toBeLessThan(out.indexOf("项目记忆内容"));
  });

  it("@切换覆盖 active 专家（buildSystemAugment 透传 userText）", () => {
    writeExpert(path.join(tmp, "user-exp"), "reviewer.md", "---\nname: 审查专家\n---\n你是审查者。");
    const a = makeAgent({ persona: { active: "fullstack", systemPrompt: "" } });
    const out = a.buildSystemAugment("@审查专家 审查代码");
    expect(out.startsWith("【专家设定·审查专家（仅本条消息生效）】")).toBe(true);
  });
});

describe("_subToolset / _subSystemPrompt — 子智能体收敛", () => {
  const agent = makeAgent();

  it("无专家：全量 TOOLS 减 SUB_AGENT_BLOCK（agent/create_plan/undo 等被排除）", () => {
    const names = agent._subToolset(null).map((t) => t.function.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).not.toContain("agent");
    expect(names).not.toContain("create_plan");
    expect(names).not.toContain("undo");
    expect(names).not.toContain("save_session_memory");
  });

  it("专家白名单：交集收敛；白名单含 BLOCK 工具也无法解锁；全不命中回退全量", () => {
    const strict = agent._subToolset({ name: "只读专家", tool_whitelist: ["read_file", "search_code", "agent"] });
    const strictNames = strict.map((t) => t.function.name);
    expect(strictNames.sort()).toEqual(["read_file", "search_code"]);
    // 白名单全不命中 → 回退未收敛集（防呆）
    const fallback = agent._subToolset({ name: "空专家", tool_whitelist: ["no_such_tool"] });
    expect(fallback.length).toBe(agent._subToolset(null).length);
  });

  it("_subSystemPrompt：专家模式含角色与方法论；普通模式为通用约束", () => {
    const e = { name: "审查专家", role: "你是审查者。", methodology: "先读后判。" };
    const withExp = agent._subSystemPrompt("general", e);
    expect(withExp).toContain("【专家设定·审查专家】");
    expect(withExp).toContain("你是审查者。");
    expect(withExp).toContain("先读后判。");
    expect(withExp).toContain("不要向用户追问");
    const base = agent._subSystemPrompt("general", null);
    expect(base).toContain("子智能体");
    expect(base).not.toContain("专家设定");
  });

  it("formatExpertPrompt：role+methodology 平铺；空对象容错", () => {
    expect(formatExpertPrompt({ role: "A", methodology: "B" })).toBe("A\nB");
    expect(formatExpertPrompt({ role: "A" })).toBe("A");
    expect(formatExpertPrompt(null)).toBe("");
  });
});
