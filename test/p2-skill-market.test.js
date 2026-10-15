/* ============================================================
   P2-C3 技能市场（服务端那半边）
   钉住的都是"读起来像在工作、其实从未工作"的静默失效：
   - rate() 曾经不存在 → POST /api/skills/market/:id/rate 恒 400
   - categories 曾经没有 getter → JSON 里这个键被丢掉 → 前端筛选器永不出现
   - disabled / use_count / rating 曾经不写回 frontmatter → 重启即失忆
   排序必须按数值：use_count 从 .md 读回来是字符串，"3" 会赢过 "10"。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

const { SkillStore, serializeFrontmatter, parseFrontmatter } = require("../server/skill-store");

let tmp;
let seq = 0;
function freshStore() {
  const d = path.join(tmp, "s" + (++seq));
  fs.mkdirSync(path.join(d, "market"), { recursive: true });
  fs.mkdirSync(path.join(d, "user"), { recursive: true });
  return new SkillStore(path.join(d, "market"), path.join(d, "local.json"), null, path.join(d, "user"));
}
/* 用同一个目录新建 store = 模拟一次进程重启 */
function restart(st) {
  return new SkillStore(st._marketDir, path.join(st._marketDir, "..", "local.json"), null, st._userDir);
}
function marketFile(st, id) { return fs.readFileSync(path.join(st._marketDir, id + ".md"), "utf8"); }

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skm-")); });
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

describe("评分", () => {
  it("rate() 真的存在，并把分数写进磁盘", () => {
    const st = freshStore();
    const s = st.add({ name: "打分对象", category: "test", body: "b" }, "manual");
    expect(typeof st.rate).toBe("function");
    expect(st.rate(s.id, 4).rating).toBe(4);
    expect(marketFile(st, s.id)).toMatch(/^rating: 4$/m);
  });

  it("重启后评分还在", () => {
    const st = freshStore();
    const s = st.add({ name: "跨重启", category: "test", body: "b" }, "manual");
    st.rate(s.id, 5);
    expect(restart(st).getById(s.id).rating).toBe(5);
  });

  it("越界与非法值：夹到 0–5，未知 id 返回 null 而不是抛", () => {
    const st = freshStore();
    const s = st.add({ name: "夹一下", category: "test", body: "b" }, "manual");
    expect(st.rate(s.id, 99).rating).toBe(5);
    expect(st.rate(s.id, -3).rating).toBe(0);
    expect(st.rate(s.id, "abc").rating).toBe(0);
    expect(st.rate("sk_not_exist", 3)).toBeNull();
  });

  it("0 分是「取消评分」，不在 .md 里留一行 rating: 0", () => {
    const st = freshStore();
    const s = st.add({ name: "取消评分", category: "test", body: "b" }, "manual");
    st.rate(s.id, 3);
    st.rate(s.id, 0);
    expect(marketFile(st, s.id)).not.toMatch(/^rating:/m);
    expect(st.getById(s.id).rating).toBe(0);
  });
});

describe("分类计数与状态字段", () => {
  it("categories 是真对象，且把内置工作流一起算进来", () => {
    const st = freshStore();
    st.add({ name: "A 前端", category: "frontend", body: "b" }, "manual");
    st.add({ name: "B 前端", category: "frontend", body: "b" }, "manual");
    st.add({ name: "C 没分类", body: "b" }, "manual");
    st.addLocal({ name: "D 沉淀", category: "backend", body: "b" });
    const cats = st.categories;
    expect(cats.frontend).toBe(2);
    expect(cats.backend).toBe(1);
    expect(cats.other).toBe(1);
    // 内置那批和池子里的技能在侧栏同一屏展示，chip 上的总数必须与屏内条数同源
    expect(Object.values(cats).reduce((a, b) => a + b, 0)).toBe(4 + st.builtinWorkflows.length);
  });

  it("手写 .md 里的数字字段按数值读，不按字典序", () => {
    const d = path.join(tmp, "hand");
    fs.mkdirSync(path.join(d, "market"), { recursive: true });
    fs.writeFileSync(path.join(d, "market", "ten.md"), "---\nname: use10\ncategory: test\nuse_count: 10\n---\n\n正文\n", "utf8");
    fs.writeFileSync(path.join(d, "market", "three.md"), "---\nname: use3\ncategory: test\nuse_count: 3\n---\n\n正文\n", "utf8");
    const st = new SkillStore(path.join(d, "market"), path.join(d, "local.json"), null, path.join(d, "user"));
    const rows = st.list({ sort: "usage" });
    expect(rows[0].name).toBe("use10");
    expect(rows[0].useCount).toBe(10);
  });

  it("disabled: true 读回来是真布尔，缺省字段的老文件不会被当成停用", () => {
    const d = path.join(tmp, "old");
    fs.mkdirSync(path.join(d, "market"), { recursive: true });
    const fm = (name) => "---\nname: " + name + "\ncategory: test\ntrigger: 停用,测试\n";
    fs.writeFileSync(path.join(d, "market", "off.md"), fm("offOne") + "disabled: true\n---\n\n正文\n", "utf8");
    fs.writeFileSync(path.join(d, "market", "plain.md"), fm("plainOld") + "---\n\n正文\n", "utf8");
    const st = new SkillStore(path.join(d, "market"), path.join(d, "local.json"), null, path.join(d, "user"));
    expect(st.findByName("offOne").disabled).toBe(true);
    expect(st.findByName("plainOld").disabled).toBe(false);
    expect(st.findByName("plainOld").rating).toBe(0);
    /* 正向对照：同触发词的未停用那条必须真被匹配到，
       否则"停用的那条没出现"测的只是"两条都没出现"。 */
    const hits = st.match("帮我做停用测试", 10).map((s) => s.name);
    expect(hits).toContain("plainOld");
    expect(hits).not.toContain("offOne");
  });

  it("停用状态能扛住重启：这正是以前丢掉的那部分", () => {
    const st = freshStore();
    const s = st.add({ name: "会被关掉", category: "test", body: "b" }, "manual");
    st.update(s.id, { disabled: true });
    expect(restart(st).getById(s.id).disabled).toBe(true);
  });

  it("用量也扛重启：以前 recordUse 攒的次数第二天全归零", () => {
    const st = freshStore();
    const s = st.add({ name: "被用过", category: "test", body: "b" }, "manual");
    st.recordUse(s.id); st.recordUse(s.id);
    expect(restart(st).getById(s.id).useCount).toBe(2);
  });
});

describe("排序视角", () => {
  /* 名字取 ASCII 首字母 A/M/Z，与"分高/最新/用得多"三个不同维度错开，
     这样四个 sort 断言的期望值各不相同，任何一条退化成默认序都会被抓到。 */
  function seeded() {
    const st = freshStore();
    const a = st.add({ name: "Zeta 用得多", category: "frontend", body: "b" }, "manual");
    const b = st.add({ name: "Alpha 分高", category: "test", body: "b" }, "manual");
    const c = st.add({ name: "Mid 最新", category: "test", body: "b" }, "manual");
    st.recordUse(a.id); st.recordUse(a.id); st.recordUse(a.id);
    st.recordUse(c.id);
    st.rate(b.id, 5);
    st._marketSkills.forEach((s) => { s.ts = 1000; });
    st._marketSkills.find((s) => s.id === c.id).ts = 99999;
    return { st, a, b, c };
  }
  const first = (st, sort) => st.list({ sort })[0].name;

  it("usage / rating / recent / name 各给各的顺序", () => {
    const { st } = seeded();
    expect(first(st, "usage")).toBe("Zeta 用得多");
    expect(first(st, "rating")).toBe("Alpha 分高");
    expect(first(st, "recent")).toBe("Mid 最新");
    expect(first(st, "name")).toBe("Alpha 分高");
  });

  it("不认识的 sort 值退回默认（用量），不抛也不给空列表", () => {
    const { st } = seeded();
    expect(st.list({ sort: "bogus" }).length).toBe(3);
    expect(st.list({}).length).toBe(3);
    expect(first(st, "bogus")).toBe("Zeta 用得多");
  });

  it("评分并列时用量兜底，顺序稳定可复现", () => {
    const { st, a, c } = seeded();
    st.rate(a.id, 2); st.rate(c.id, 2);
    const tied = st.list({ sort: "rating" }).filter((s) => s.rating === 2);
    expect(tied[0].id).toBe(a.id);   // a 三次 > c 一次
    expect(tied[1].id).toBe(c.id);
  });

  it("序列化再解析不丢评分与用量", () => {
    const text = serializeFrontmatter({ name: "往返", category: "test", body: "正文", useCount: 7, rating: 4, disabled: true, ts: 123 });
    const back = parseFrontmatter(text);
    expect(back.meta.use_count).toBe("7");
    expect(back.meta.rating).toBe("4");
    expect(back.meta.disabled).toBe("true");
    expect(back.meta.ts).toBe("123");
  });

  it("没有评分/用量的新技能：frontmatter 保持干净，不写 0 值行", () => {
    const st = freshStore();
    const s = st.add({ name: "新来的", category: "test", body: "b" }, "manual");
    const text = marketFile(st, s.id);
    expect(text).not.toMatch(/^rating:/m);
    expect(text).not.toMatch(/^use_count:/m);
    expect(text).not.toMatch(/^disabled:/m);
  });
});
