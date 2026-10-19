/* ============================================================
   W3 三层记忆单测
   - MemoryStore.search static raw 选项：返回 [{entry, score}]
   - searchAll 只读性（P0 防回归）：跨片检索不改动任何分片文件、不触发 prune
   - searchAll 合并排序 + __src 标注 + 坏分片跳过
   - memory-tools：search_memory scope=global（当前项目+其他分片+用户级）
   - memory-tools：save_session_memory scope=user（沉淀到用户级）
   - buildSystemAugment：用户级记忆注入块（mock 依赖直调）
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { MemoryStore } = require("../server/memory-store");
const memoryTools = require("../server/tools/memory-tools");
const { LlmAgent } = require("../server/agent-llm");

let tmp, memDir;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w3-mem-"));
  memDir = path.join(tmp, "memory");
  fs.mkdirSync(memDir, { recursive: true });
});
afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}, 30000);   // Windows Defender 逐文件扫描可超默认 10s（对齐 W4 惯例）

function seedShard(name, entries) {
  const p = path.join(memDir, name);
  fs.writeFileSync(p, JSON.stringify(entries), "utf8");
  return p;
}

describe("MemoryStore.search — raw 选项", () => {
  it("raw 返回 [{entry, score}] 且 score 降序", () => {
    const p = path.join(memDir, "raw-a.json");
    const m = new MemoryStore(p);
    m.add("lesson", "部署", "用 docker compose 部署服务");
    m.add("lesson", "测试", "vitest 跑单测前先 build");
    const raw = m.search("docker", { raw: true });
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBeGreaterThanOrEqual(1);
    expect(raw[0].entry).toBeTruthy();
    expect(typeof raw[0].score).toBe("number");
    for (let i = 1; i < raw.length; i++) expect(raw[i - 1].score).toBeGreaterThanOrEqual(raw[i].score);
    try { fs.unlinkSync(p); } catch (e) {}
  });
});

describe("MemoryStore.searchAll — 只读性（P0：跨片检索不得改动分片）", () => {
  it("检索前后所有分片文件字节级不变", () => {
    const pa = seedShard("aaaa1111.json", [
      { id: "a1", type: "decision", topic: "会话决策", content: "数据库选型用 sqlite", ts: Date.now(), accessCount: 3, lastAccessAt: Date.now(), valueScore: 4 },
      { id: "a2", type: "lesson", topic: "经验教训", content: "CRLF 隔离用 core.autocrlf false", ts: Date.now(), accessCount: 0, lastAccessAt: Date.now() - 86400000 * 100, valueScore: 2 },
    ]);
    const pb = seedShard("bbbb2222.json", [
      { id: "b1", type: "preference", topic: "偏好", content: "sqlite 单文件足够", ts: Date.now(), accessCount: 1, lastAccessAt: Date.now(), valueScore: 3 },
    ]);
    const beforeA = fs.readFileSync(pa, "utf8");
    const beforeB = fs.readFileSync(pb, "utf8");
    const hits = MemoryStore.searchAll(
      [{ path: pa, label: "项目 aaaa1111" }, { path: pb, label: "项目 bbbb2222" }],
      "sqlite",
      { limit: 10, perStore: 5 }
    );
    expect(hits.length).toBe(2);
    expect(fs.readFileSync(pa, "utf8")).toBe(beforeA);   // 只读：分片 A 未被写
    expect(fs.readFileSync(pb, "utf8")).toBe(beforeB);   // 只读：分片 B 未被写
    /* 归一排序：a1（关键词+topic 命中+高强度）应排在前面 */
    expect(hits[0].__src).toBe("项目 aaaa1111");
    expect(hits[0].content).toContain("sqlite");
    expect(hits[1].__src).toBe("项目 bbbb2222");
  });

  it("坏 JSON 分片跳过不炸；空数组/缺 path 项容错", () => {
    const pbad = path.join(memDir, "bad.json");
    fs.writeFileSync(pbad, "{not-json", "utf8");
    const pgood = seedShard("good3333.json", [
      { id: "g1", type: "error", topic: "反例", content: "不要在 heredoc 里裸写反引号", ts: Date.now(), accessCount: 1, lastAccessAt: Date.now(), valueScore: 2 },
    ]);
    const hits = MemoryStore.searchAll(
      [null, { path: pbad, label: "坏片" }, { path: pgood, label: "好片" }, {}],
      "heredoc",
      {}
    );
    expect(hits.length).toBe(1);
    expect(hits[0].__src).toBe("好片");
  });
});

describe("memory-tools.search_memory — scope=global", () => {
  it("结果带来源前缀（当前项目/其他分片/用户级），本地实例未落盘更新也可见", () => {
    const pCur = path.join(memDir, "cur4444.json");
    const pOther = seedShard("othr5555.json", [
      { id: "o1", type: "lesson", topic: "经验", content: "patch 脚本必须换入 .new 文件", ts: Date.now(), accessCount: 2, lastAccessAt: Date.now(), valueScore: 3 },
    ]);
    const local = new MemoryStore(pCur);
    local.add("decision", "会话决策", "换入文件用 rm 加 cp 链");   // 只在内存，未强制落盘时 _save 已写，但语义上用内存实例
    const userMem = new MemoryStore(path.join(memDir, "user.json"));
    userMem.add("preference", "偏好", "代码用中文变量命名");

    const agent = {
      memory: local,
      userMemory: userMem,
      _memDir: memDir,
      tool: () => ({ body() {}, done() {} }),
    };
    return memoryTools.search_memory(agent, { query: "换入", scope: "global" }).then((txt) => {
      expect(txt).toContain("[当前项目·");
      expect(txt).toContain("rm 加 cp");
    });
  });

  it("默认（无 scope）行为不变：只查当前工作区", () => {
    const pCur = path.join(memDir, "cur6666.json");
    const local = new MemoryStore(pCur);
    local.add("lesson", "经验", "scoped 检索默认只看本区");
    const agent = {
      memory: local,
      userMemory: new MemoryStore(path.join(memDir, "user.json")),
      _memDir: memDir,
      tool: () => ({ body() {}, done() {} }),
    };
    return memoryTools.search_memory(agent, { query: "scoped" }).then((txt) => {
      expect(txt).toContain("本区");
      expect(txt).not.toContain("用户级·");
    });
  });
});

describe("memory-tools.save_session_memory — scope=user", () => {
  it("scope=user 沉淀到用户级实例，项目记忆不受影响", () => {
    const local = new MemoryStore(path.join(memDir, "cur7777.json"));
    const userMem = new MemoryStore(path.join(memDir, "user2.json"));
    const agent = {
      memory: local,
      userMemory: userMem,
      skills: { add: () => null },
      emit: () => {},
      tool: () => ({ body() {}, done() {} }),
    };
    return memoryTools.save_session_memory(agent, {
      scope: "user",
      decisions: ["用户偏好第一性原理汇报"],
    }).then((summary) => {
      expect(summary).toContain("用户级");
      expect(userMem.list({})).toHaveLength(1);
      expect(local.list({})).toHaveLength(0);
    });
  });

  it("无 userMemory 兜底回项目级（独立构造 agent 不炸）", () => {
    const local = new MemoryStore(path.join(memDir, "cur8888.json"));
    const agent = { memory: local, emit: () => {}, tool: () => ({ body() {}, done() {} }) };
    return memoryTools.save_session_memory(agent, { scope: "user", lessons: ["这条应当落在项目记忆库里"] }).then((summary) => {
      expect(summary).not.toContain("用户级");
      expect(local.list({})).toHaveLength(1);
    });
  });
});

describe("buildSystemAugment — 记忆判断层（正文不摊开，只留硬提醒 + 索引）", () => {
  function augAgent(userJson, projJson) {
    const agent = Object.create(LlmAgent.prototype);
    agent.cfg = { memory: { enabled: true }, rules: { enabled: false }, repoMap: false };
    agent.userMemory = userJson ? new MemoryStore(path.join(memDir, userJson)) : null;
    agent.memory = new MemoryStore(path.join(memDir, projJson));
    agent.plan = { formatForContext: () => "" };
    agent.skills = { match: () => [], formatForContext: () => "", recordUse: () => {}, list: () => [] };
    agent.soul = { get: () => ({}) };
    agent.progression = { get: () => ({ path: "" }) };
    agent._evolutionBias = () => null;
    agent._currentConv = "t";
    return agent;
  }
  /* 断言必须分块做：索引行本身就带正文开头 44 字的钩子，
     整段文本上判 not.toContain(正文) 会误判成"正文进来了"，判 toContain 会误判成"常驻"。 */
  function buckets(out) {
    const cut = (mark) => {
      const i = out.indexOf(mark);
      if (i < 0) return "";
      const rest = out.slice(i + mark.length);
      const nxt = rest.search(/\n【/);
      return (nxt < 0 ? rest : rest.slice(0, nxt)).trim();
    };
    return { guard: cut("【记忆·硬提醒"), index: cut("【记忆索引") };
  }

  /* 钩子只截正文开头 44 字，所以"正文有没有摊开"必须拿落在 44 字之后的那段来判：
     用前半句判会两边都命中（索引行里就有它），判据等于没判。 */
  const BODY = "本项目用 vitest 跑单测，跑之前要先装依赖，这条只在索引里留一行钩子，" + "补".repeat(20);
  const TAIL = "整段正文MARKER";

  it("用户级在前；反例正文进常驻块，普通 lesson 的整段正文不进任何块", () => {
    const agent = augAgent("user.json", "proj.json");
    // 写成禁忌的偏好才算常驻（含"不要"），普通偏好只进索引
    agent.userMemory.add("preference", "命名约定", "变量名不要用英文缩写，一律用中文，函数名也照此办理");
    agent.memory.add("error", "被拒操作/反例", "不要擅自 git commit，用户会单独下令");
    agent.memory.add("lesson", "测试约定", BODY + TAIL);
    const b = buckets(agent.buildSystemAugment("帮我把 vitest 的用例补全"));
    expect(b.guard).toContain("不要擅自 git commit");
    expect(b.guard).toContain("用户级：");
    expect(b.guard.indexOf("用户级：")).toBeLessThan(b.guard.indexOf("本项目："));
    expect(b.guard).not.toContain("vitest");
    // 钩子在（主题 + 开头），整段正文不在
    expect(b.index).toContain("测试约定");
    expect(b.index).toContain("本项目用 vitest 跑单测");
    expect(b.index).not.toContain(TAIL);
    // 常驻过的条目不许在索引里再列一遍
    expect(b.index).not.toContain("命名约定");

    /* 换一轮毫不相关的输入，常驻与索引都不受影响。
       旧口径在这里会说"lesson 一个字都不注入"——那是"本轮命中才注入正文"时代的判据，
       P6 起正文从不按命中注入，所以这条判据换成"整段正文不在任何块里"（上面 TAIL 那条）。 */
    const b2 = buckets(agent.buildSystemAugment("把首页按钮的圆角改成 8px"));
    expect(b2.guard).toBe(b.guard);
    expect(b2.index).toBe(b.index);
  });

  it("常驻只有被否/权衡/禁忌三类；普通 lesson 强度再高也不进常驻块", () => {
    const agent = augAgent(null, "proj3.json");
    const lesson = agent.memory.add("lesson", "测试约定", BODY + TAIL, { valueScore: 5 });
    agent.memory.add("decision", "方案权衡", "选 copyFile 而不是 rename 兜底：杀软会锁住目标文件", { valueScore: 5 });
    const b = buckets(agent.buildSystemAugment("今天天气不错"));
    expect(b.guard).toContain("方案权衡");
    expect(b.guard).not.toContain("vitest");
    // 但它必须在索引里看得见，且带得上可抄的 #id
    expect(b.index).toContain("#" + lesson.id);
    expect(b.index).toContain("测试约定");
    expect(b.index).not.toContain(TAIL);
  });

  it("写成禁忌的偏好才常驻；不含禁忌词的偏好只在索引", () => {
    const agent = augAgent(null, "proj4.json");
    agent.memory.add("preference", "汇报", "回复一律用简体中文，代码注释同样用中文写清楚，中英混排MARKER不算违规");
    agent.memory.add("preference", "图标", "界面图标不要用 emoji，一律用描边 SVG");
    const b = buckets(agent.buildSystemAugment("随便"));
    expect(b.guard).toContain("不要用 emoji");
    expect(b.guard).not.toContain("描边 SVG之外");
    expect(b.guard).not.toContain("中英混排MARKER");   // 落在钩子之后 → 只有常驻才会露出来
    expect(b.index).toContain("汇报");
  });

  it("userMemory 未注入时不产生用户级段；空库时两块整块消失", () => {
    const agent = augAgent(null, "proj2.json");
    const out = agent.buildSystemAugment("");
    expect(out).not.toContain("用户级：");
    expect(out).not.toContain("用户级（跨项目）");
    expect(out).not.toContain("【记忆·硬提醒");
    expect(out).not.toContain("【记忆索引");
  });

  it("记忆两块逐字节不随本轮输入变（提示词前缀缓存成立的根据）", () => {
    const agent = augAgent("user5.json", "proj5.json");
    agent.userMemory.add("preference", "禁忌", "回复不要用 emoji");
    agent.memory.add("lesson", "测试约定", "本项目用 vitest 跑单测");
    agent.memory.add("error", "被拒操作/反例", "不要用 run_command 拼 sed 改名");
    const memBlocks = (text) => agent.buildAugmentParts(text).stable.filter((s) => /【记忆/.test(s)).join("\n");
    const a = memBlocks("帮我把首页圆角改成 8px");
    const b = memBlocks("vitest 的用例还没补，顺手看看端口占用");
    expect(a).not.toBe("");
    expect(b).toBe(a);
  });

  it("台账只记常驻那几条；正文没进上下文就不许说「读过了」", () => {
    const agent = augAgent("user6.json", "proj6.json");
    const guard = agent.memory.add("error", "被拒操作/反例", "不要擅自 push，推之前要用户点头");
    const plain = agent.memory.add("lesson", "测试约定", "本项目用 vitest 跑单测");
    agent.buildAugmentParts("随便问点什么");
    const ids = agent._usedMemory.map((u) => u.id);
    expect(ids).toContain(guard.id);
    expect(ids).not.toContain(plain.id);
    expect(agent._usedMemory.every((u) => u.via === "guard")).toBe(true);
  });
});
