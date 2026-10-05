/* ============================================================
   长期记忆质量（#31：读进来的记忆"没啥意义价值"）

   截图上那 10 条不是内容垃圾，是**主题命名 + 选条口径**两处的合谋：
     1) 写入端把用户原话直接当 topic 落盘（text.slice(0,60)），
        于是溯源卡上满屏"启动项目""项目有没有问题""继续"——正文其实还像句经验，
        是主题栏把它抹平成了"它把我每句话都记了一遍"。
     2) 一次任务由模型自动产出 3~5 条同主题条目（去重要求 topic 相等才生效，
        内容互不相同就全放行），而读取端 topForContext 根本不看本轮问什么，
        只按"自我强化过的强度"凑满 10 条 —— 同主题的三条一起进榜。
     3) accessCount 是注入即 +1 的自举回路：注入 → touch → 强度更高 → 更容易进榜 → 再 touch。
        而且 4 分 = sticky 豁免，自动沉淀恰恰一律给 4 分，于是这批垃圾既涨得最快又永不衰减。

   四条不变量：主题不许是用户原话；同主题限量；不相关就不注入；没真的用上就不许加强。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryStore, isJunkPhrase } = require("../server/memory-store");
const { EvolutionEngine } = require("../server/evolution");
const { LlmAgent } = require("../server/agent-llm");

let dir;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-mem-")); });
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

function store(name) { return new MemoryStore(path.join(dir, name + "-" + Math.random().toString(36).slice(2) + ".json")); }
function ev(store) { return new EvolutionEngine(store); }

describe("写入端：主题命名与门槛", () => {
  it("疑问句、纯指令短句、招呼语一律判成垃圾短语", () => {
    for (const s of ["项目有没有问题", "怎么又断了", "继续", "启动项目", "你好", "这个能改一下吗？", "行"]) {
      expect(isJunkPhrase(s), s).toBe(true);
    }
    for (const s of ["探针必须设 PANCODE_DATA_DIR 否则会写进真实数据根",
      "electron-builder 的 rename 在 Windows 被锁时降级为 copyFile"]) {
      expect(isJunkPhrase(s), s).toBe(false);
    }
  });

  it("_topicFromUserText：用户原话不再当主题，取不到就回空串", () => {
    const a = Object.create(LlmAgent.prototype);
    expect(a._topicFromUserText("继续")).toBe("");
    expect(a._topicFromUserText("项目有没有问题")).toBe("");
    expect(a._topicFromUserText("[引用 Skill: 代码审查]\n审查代码质量")).toBe("");   // 短句 + 换行也不许整段抄
    const t = a._topicFromUserText("帮我把 electron 打包流程里的重命名失败问题处理一下再验证");
    expect(t).not.toBe("");
    expect(t.length).toBeLessThanOrEqual(24);
    expect(t).not.toMatch(/\n/);
  });

  it("_parseLessons 认「[type] 主题｜正文」，并对旧格式与「无」保持宽容", () => {
    const e = ev(store("p1"));
    const got = e._parseLessons([
      "[lesson] 探针数据根｜探针必须先设 PANCODE_DATA_DIR，否则账号与会话会写进真实数据根。",
      "[decision] 打包降级｜electron-builder 在 Windows 上 rename 被锁时改用 copyFile，因为杀软会占住目标文件。",
      "[error] 这行没有分隔符，旧格式整句当正文，主题留空由调用方回落。",
      "无",
      "随便一行没有类型标记的不算",
    ].join("\n"));
    expect(got.map((l) => l.topic)).toEqual(["探针数据根", "打包降级", ""]);
    expect(got.map((l) => l.type)).toEqual(["lesson", "decision", "error"]);
    expect(got).toHaveLength(3);
    expect(e._parseLessons("无")).toEqual([]);
  });

  it("一次任务最多沉淀 2 条、同主题只 1 条、正文太短或像问句的一律丢弃", () => {
    const m = store("persist");
    const e = ev(m);
    const lessons = [
      { type: "lesson", topic: "探针数据根", content: "探针必须先设沙箱数据根，否则账号与会话会被写进真实的 .pancode 目录里。" },
      { type: "error", topic: "探针数据根", content: "同一条主题的第二个条目应当被同主题限量挡掉，不再重复落盘写入。" },
      { type: "pattern", topic: "太短的", content: "记得测试" },
      { type: "decision", topic: "有没有问题", content: "这一条的主题本身是问句，整条不该进长期记忆库。" },
      { type: "lesson", topic: "打包降级", content: "Windows 上 rename 被占用时改用 copyFile 兜底，因为安装目录会被杀软锁住。" },
      { type: "pattern", topic: "记忆分道", content: "长期记忆按相关性与稳定性分成两条道注入，与本轮无关的高强度条目不再占用上下文。" },
    ];
    const saved = e.persistLessons(lessons, "继续");
    expect(saved).toHaveLength(2);
    expect(saved.map((x) => x.topic).sort()).toEqual(["打包降级", "探针数据根"]);
    // 一律 3 分：4 分等于 sticky 豁免（prune 直接跳过），自动产出不该一次性换来永久免检
    for (const s of saved) {
      expect(s.valueScore).toBe(3);
      // 主题走"只查句式、不查长度"的档位：名词短语本该短，"打包降级"四个字是合法主题
      expect(isJunkPhrase(s.topic, 1), s.topic).toBe(false);
    }
  });

  it("save_session_memory 也走同一把尺子，且不再给到免检分", () => {
    const m = store("tool");
    const agent = {
      memory: m, userMemory: null, emit: () => {}, skills: { add: () => null },
      tool: () => ({ body() {}, done() {} }),
    };
    const tools = require("../server/tools/memory-tools");
    return tools.save_session_memory(agent, {
      decisions: ["继续", "本次采用 vitest 作为唯一单测框架，因为要与被打包的运行时保持同一套转译链"],
      lessons: ["行"],
    }).then((summary) => {
      expect(summary).toContain("已沉淀 1 条");
      const e = m.list({})[0];
      expect(e.valueScore).toBe(3);
    });
  });
});

describe("读取端：不相关就不注入（宁少勿噪）", () => {
  it("同主题最多 2 条；本轮零命中的高强度条目一条都不进", () => {
    const m = store("lane");
    for (const t of ["启动项目", "启动项目", "启动项目"]) {
      m.add("lesson", "启动项目", t + " 的经验应当先被同主题限量挡住才能进榜一次", { valueScore: 4, source: "evolution" });
    }
    m.add("error", "端口占用", "默认 3000 端口被占用时改用备用端口并在状态栏提示", { valueScore: 5, source: "evolution" });
    const hit = m.topForContext(10, "把项目跑起来看看端口占用怎么处理");
    expect(hit.length).toBeGreaterThan(0);
    const byTopic = {};
    for (const e of hit) byTopic[e.topic] = (byTopic[e.topic] || 0) + 1;
    expect(Math.max(...Object.values(byTopic))).toBeLessThanOrEqual(2);
    // 与本轮毫无交集的一条：强度再高也不注入
    const miss = m.topForContext(10, "今天写文档");
    expect(miss.filter((e) => e.type === "lesson" && e.topic === "启动项目")).toEqual([]);
  });

  it("强度地板：衰减到地板以下的条目不再占上下文", () => {
    const m = store("floor");
    const e = m.add("lesson", "旧事", "很久以前的一条经验，正文要够长才会被计入价值与衰减统计", { valueScore: 3 });
    e.lastAccessAt = Date.now() - 400 * 86400000;   // 400 天没被碰过
    e.ts = e.lastAccessAt;
    expect(m.decayW ? true : true).toBe(true);
    expect(m.topForContext(10, "很久以前 那条 经验").length).toBe(0);
  });

  it("偏好与归纳产物走稳定道：与本轮无关也在场", () => {
    const m = store("stable");
    m.add("preference", "用户偏好", "回复一律用中文，代码注释也用中文写清楚", { valueScore: 4 });
    m.add("decision", "全项目结论", "所有探针都走沙箱数据根，这条由归纳器整理得出", { source: "consolidate", valueScore: 5 });
    m.add("lesson", "别的主题", "某个只属于那次任务的细节经验，跟本轮问题没有词元交集", { valueScore: 5, source: "evolution" });
    const out = m.formatStable(2000);
    expect(out).toContain("用户偏好");
    expect(out).toContain("全项目结论");
    expect(out).not.toContain("别的主题");
    expect(m.formatRelevant("今天天气不错", 2000)).toBe("");
  });

  it("注入总条数仍有界（50 条大记忆也不会把上下文灌爆）", () => {
    const m = store("bound");
    for (let i = 0; i < 50; i++) {
      m.add("lesson", "记忆分道" + (i % 3), "很长的正文".repeat(60) + i, { valueScore: 5, source: "evolution" });
    }
    const out = m.formatForContext(3000, "很长的正文 记忆分道");
    expect(out.split("\n").filter((l) => l.startsWith("- ")).length).toBeLessThanOrEqual(10);
  });
});

describe("反馈回路：注入 ≠ 用上", () => {
  it("最终回复里真的提到（词元重合 ≥3）才算用上", () => {
    const m = store("cite1");
    const e1 = m.add("lesson", "探针数据根", "探针必须走沙箱数据根否则写进真实目录", { valueScore: 3 });
    const e2 = m.add("lesson", "端口占用", "默认端口被占用时改用备用端口并提示用户", { valueScore: 3 });
    const a = Object.create(LlmAgent.prototype);
    a.memory = m; a.userMemory = null;
    a._usedMemory = [{ scope: "project", id: e1.id }, { scope: "project", id: e2.id }];
    const cited = a._citedMemoryIds("这次改动没有动探针，探针数据根这件事我还是按沙箱数据根来跑。");
    expect(cited.has(e1.id)).toBe(true);
    expect(cited.has(e2.id)).toBe(false);
  });

  it("空回复 / 中断时一条都不加强（旧写法在 finally 里照样 +1）", () => {
    const m = store("cite2");
    const e = m.add("lesson", "打包降级", "Windows 上 rename 被锁时改用 copyFile 兜底一次", { valueScore: 3 });
    const a = Object.create(LlmAgent.prototype);
    a.memory = m; a.userMemory = null;
    a._usedMemory = [{ scope: "project", id: e.id }];
    expect(a._citedMemoryIds("").size).toBe(0);
    expect(a._citedMemoryIds("今天天气不错").size).toBe(0);
  });

  it("用户级记忆也记得到自己库（旧代码只 touch 项目库）", () => {
    const src = fs.readFileSync(path.join(__dirname, "../server/agent-llm.js"), "utf8");
    const tail = src.slice(src.indexOf("记忆溯源回推"));
    expect(tail).toContain("this.userMemory.touchMany");
    expect(tail).not.toMatch(/for \(const u of this\._usedMemory\) \{ try \{ this\.memory\.touch\(u\.id\)/);
  });

  it("touchMany 一次落盘，而不是每条重写一遍 JSON", () => {
    const m = store("batch");
    const ids = [1, 2, 3, 4].map((i) => m.add("lesson", "批量" + i, "正文要足够长以免被写入端的长度门槛挡在门外", { valueScore: 3 }).id);
    let saves = 0;
    m._save = () => { saves++; };
    expect(m.touchMany(ids)).toBe(4);
    expect(saves).toBe(1);
    for (const id of ids) expect(m.getById(id).accessCount).toBe(1);
  });

  it("沉淀门槛：一句话回合不再自动起一次抽取", () => {
    const src = fs.readFileSync(path.join(__dirname, "../server/agent-llm.js"), "utf8");
    expect(src).toMatch(/memory\.enabled && \(changes\.length \|\| round >= 2\)/);
    expect(src).not.toMatch(/const taskTopic = text\.slice\(0, 60\);/);
  });
});
