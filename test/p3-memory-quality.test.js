/* ============================================================
   长期记忆质量（#31：读进来的记忆"没啥意义价值"）

   截图上那 10 条不是内容垃圾，是**主题命名 + 选条口径**两处的合谋：
     1) 写入端把用户原话直接当 topic 落盘（text.slice(0,60)），
        于是溯源卡上满屏"启动项目""项目有没有问题""继续"——正文其实还像句经验，
        是主题栏把它抹平成了"它把我每句话都记了一遍"。
     2) 一次任务由模型自动产出 3~5 条同主题条目（去重要求 topic 相等才生效，
        内容互不相同就全放行），而当时的读取端根本不看本轮问什么，
        只按"自我强化过的强度"凑满 10 条 —— 同主题的三条一起进榜。
     3) accessCount 是注入即 +1 的自举回路：注入 → touch → 强度更高 → 更容易进榜 → 再 touch。
        而且 4 分 = sticky 豁免，自动沉淀恰恰一律给 4 分，于是这批垃圾既涨得最快又永不衰减。

   四条不变量：主题不许是用户原话；同主题限量；正文不许每轮自动摊开（P6 起只剩硬提醒常驻）；
   没真的用上就不许加强。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MemoryStore, isJunkPhrase, GUARD_MAX_CHARS, IDX_MAX_CHARS } = require("../server/memory-store");
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

describe("读取端：正文不摊开，常驻只剩硬提醒（P6）", () => {
  /* 旧判据"本轮零命中就不注入"已经没有对应物：正文不再按命中注入。
     换成三条更好量的：① 只有反例/权衡/禁忌常驻；② 常驻与索引都有硬上限；
     ③ 同主题限量仍在（防一条主题霸满索引）。 */
  it("同主题最多 2 条：索引与常驻都受同一把闸管", () => {
    const m = store("lane");
    for (let i = 0; i < 3; i++) {
      m.add("error", "被拒操作/反例", "被否过的做法第 " + i + " 条，正文要够长才不会被长度门槛挡在门外", { valueScore: 5 });
    }
    m.add("lesson", "启动项目", "启动项目要先装依赖再跑 dev，否则端口会撞", { valueScore: 5 });
    const guard = m.guardForContext(999);
    const topics = {};
    for (const e of guard) topics[e.topic] = (topics[e.topic] || 0) + 1;
    expect(Math.max(...Object.values(topics))).toBeLessThanOrEqual(2);
    const idx = m.indexForContext(999);
    const it = {};
    for (const e of idx) it[e.topic] = (it[e.topic] || 0) + 1;
    expect(Math.max(...Object.values(it))).toBeLessThanOrEqual(2);
  });

  it("强度地板：衰减到地板以下的条目连索引都不上", () => {
    const m = store("floor");
    const e = m.add("lesson", "旧事", "很久以前的一条经验，正文要够长才会被计入价值与衰减统计", { valueScore: 3 });
    e.lastAccessAt = Date.now() - 400 * 86400000;   // 400 天没被碰过
    e.ts = e.lastAccessAt;
    expect(m.indexForContext(999).length).toBe(0);
    expect(m.guardForContext(999).length).toBe(0);
    expect(m.formatIndex(2000)).toBe("");
  });

  it("常驻只收反例/方案权衡/禁忌偏好；普通偏好与归纳产物不再无条件占上下文", () => {
    const m = store("stable");
    m.add("preference", "禁忌", "界面图标不要用 emoji，一律用描边 SVG", { valueScore: 4 });
    m.add("decision", "全项目结论", "所有探针都走沙箱数据根，这条由归纳器整理得出", { source: "consolidate", valueScore: 5 });
    m.add("lesson", "别的主题", "某个只属于那次任务的细节经验，正文再长也只进索引", { valueScore: 5, source: "evolution" });
    const g = m.formatGuard(2000);
    expect(g).toContain("不要用 emoji");
    expect(g).not.toContain("全项目结论");        // 归纳产物不再算硬提醒
    expect(g).not.toContain("别的主题");
    const idx = m.formatIndex(2000);
    expect(idx).toContain("全项目结论");
    expect(idx).toContain("别的主题");
  });

  it("常驻与索引各有硬上限（几十条互不相同的大记忆也灌不爆上下文）", () => {
    const m = store("bound");
    /* 正文用 ASCII 词拼：内容词元互不相交，才不会在 add() 的模糊去重那一步被合并成几条，
       这个用例要量的是"条目真的很多时输出仍有界"，不是去重。 */
    for (let i = 0; i < 50; i++) {
      m.add("lesson", "记忆分道" + i, ("step" + i + " act" + i + " ").repeat(30), { valueScore: 5, source: "evolution" });
    }
    for (let i = 0; i < 20; i++) {
      m.add("error", "被拒操作/反例", ("reject" + i + " forbid" + i + " ").repeat(12), { valueScore: 5 });
    }
    expect(m.size).toBeGreaterThan(60);
    expect(m.formatGuard().length).toBeLessThanOrEqual(GUARD_MAX_CHARS + 10);   // +10 给末尾的 "..."
    expect(m.formatIndex().length).toBeLessThanOrEqual(IDX_MAX_CHARS + 60);
    // 索引被截时必须说清还剩多少条，否则模型会以为目录就是全部
    expect(m.formatIndex()).toMatch(/另有 \d+ 条未列出/);
    // 同主题限量同样生效：常驻块里同一条主题最多 2 行
    expect(m.guardForContext(999).length).toBeLessThanOrEqual(2);
  });

  it("索引行给得出可抄的 #id，且与常驻块互不重复", () => {
    const m = store("iddedup");
    const g = m.add("error", "被拒操作/反例", "不要在没有探针的情况下宣布界面改完");
    const l = m.add("lesson", "探针约定", "新探针第一行必须起沙箱数据根");
    const idx = m.formatIndex(2000);
    expect(idx).toContain("#" + l.id);
    expect(idx).not.toContain("#" + g.id);
    expect(m.findByIds([g.id, "#" + l.id]).map((e) => e.id)).toEqual([g.id, l.id]);
    expect(m.findByIds(["不存在的那个id"])).toEqual([]);
  });

  it("只给指针的检索不加强度：关键词撞车不该让一条记忆长生（#31 回路）", () => {
    const m = store("notouch");
    const e = m.add("lesson", "端口占用", "默认 3000 端口被占用时改用备用端口并在状态栏提示", { valueScore: 3 });
    const before = e.accessCount;
    const hits = m.search("端口占用 备用端口", { limit: 5, noTouch: true });
    expect(hits.length).toBeGreaterThan(0);
    expect(m.getById(e.id).accessCount).toBe(before);
    // 反向对照：不带 noTouch 才是真的取用，要计一次复习
    m.search("端口占用 备用端口", { limit: 5 });
    expect(m.getById(e.id).accessCount).toBe(before + 1);
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
