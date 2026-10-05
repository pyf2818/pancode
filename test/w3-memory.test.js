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

describe("buildSystemAugment — 记忆分道注入（#31）", () => {
  function augAgent(userJson, projJson) {
    const agent = Object.create(LlmAgent.prototype);
    agent.cfg = { memory: { enabled: true }, rules: { enabled: false }, repoMap: false };
    agent.userMemory = userJson ? new MemoryStore(path.join(memDir, userJson)) : null;
    agent.memory = new MemoryStore(path.join(memDir, projJson));
    agent.plan = { formatForContext: () => "" };
    agent.skills = { match: () => [], formatForContext: () => "", recordUse: () => {} };
    agent.soul = { get: () => ({}) };
    agent.progression = { get: () => ({ path: "" }) };
    agent._evolutionBias = () => null;
    agent._currentConv = "t";
    return agent;
  }

  it("用户级在前；项目 lesson 只在本轮词元命中时才进上下文", () => {
    const agent = augAgent("user.json", "proj.json");
    agent.userMemory.add("preference", "命名约定", "变量名用中文");
    agent.memory.add("lesson", "测试约定", "本项目用 vitest 跑单测");
    const hit = agent.buildSystemAugment("帮我把 vitest 的用例补全");
    expect(hit).toContain("【用户级记忆");
    expect(hit).toContain("变量名用中文");
    expect(hit).toContain("【与本轮相关的项目记忆");
    expect(hit.indexOf("【用户级记忆")).toBeLessThan(hit.indexOf("【与本轮相关的项目记忆"));

    /* 本轮问的跟这条毫无交集 → 一个字都不注入。
       旧口径是"按强度凑满 10 条"，于是任何高强度条目都会跟着进来，
       用户看到的"读进来的长期记忆没啥意义"就是这么来的。 */
    const miss = agent.buildSystemAugment("把首页按钮的圆角改成 8px");
    expect(miss).not.toContain("【与本轮相关的项目记忆");
    expect(miss).not.toContain("vitest");
    // 偏好是无条件在场的：本轮问得不相关也照样跟着，这是它和 lesson 的分工
    expect(miss).toContain("变量名用中文");
  });

  it("稳定道只收偏好/归纳产物/sticky，普通的 lesson 不会因为强度高就常驻", () => {
    const agent = augAgent(null, "proj3.json");
    agent.memory.add("lesson", "测试约定", "本项目用 vitest 跑单测", { valueScore: 5 });
    agent.memory.add("decision", "打包方案", "electron-builder 改名被锁时降级为 copyFile", { source: "consolidate", valueScore: 5 });
    const out = agent.buildSystemAugment("今天天气不错");
    expect(out).toContain("【项目记忆（长期约定，参考）】");
    expect(out).toContain("打包方案");
    expect(out).not.toContain("vitest");
  });

  it("userMemory 未注入时不产生用户级块；一条都不该在场时项目块整块消失", () => {
    const agent = augAgent(null, "proj2.json");
    agent.memory.add("lesson", "经验", "本项目用 vitest");
    const out = agent.buildSystemAugment("");
    expect(out).not.toContain("【用户级记忆");
    expect(out).not.toContain("【项目记忆（长期约定");
    expect(out).not.toContain("【与本轮相关的项目记忆");
  });
});
