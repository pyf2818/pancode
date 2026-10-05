/* ============================================================
   Skill 的读路径与"改内置"（#43：内置技能改完保存，提示"不存在"）

   四个池子里内置那一份（代码里的 BUILTIN_WORKFLOWS + 安装包的 builtin-skills/*.md）
   以前只有 builtinWorkflows 这个 getter 认得：getById / update / exportMarkdown
   全都只查三个可写池。于是——
     · 详情弹窗对内置项也显示「保存修改」，PUT 打到内置 id 上必然 404「Skill 不存在」；
     · GET /api/skills/content 按 id 查不到就兜底 findByName("")，
       而空串对任何 name 都 includes → 返回池里第一条，内置详情页显示的是别人的正文；
     · 导出内置项报「技能不存在」。
   修法：读路径认得内置（getById 兜到内置）；写路径明确"内置不可就地改，改 = 另存我的副本"
   （forkBuiltin），并把空查询这个假命中堵掉。

   既有的 w1-skills.test.js 三处 new SkillStore 都把 builtinDir 传 null，
   内置池从来没进过单测视野——这也是它能一直 404 而没人发现的原因。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-skilluse-"));
process.env.PANCODE_DATA_DIR = path.join(tmp, "data");   // 必须早于任何 server 模块的 require
const { SkillStore } = require("../server/skill-store");

const REPO_BUILTIN = path.join(__dirname, "..", "server", "builtin-skills");
const marketDir = path.join(tmp, "market");
const userDir = path.join(tmp, "user");
let store;

beforeAll(() => {
  store = new SkillStore(marketDir, path.join(tmp, "local.json"), REPO_BUILTIN, userDir);
});
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

/* 夹具前提：内置目录真的被读进来了，否则下面所有"内置查得到"的断言都是空转 */
test("内置池真的装载了（安装包随附的 .md + 代码里的 Workflow）", () => {
  const files = fs.readdirSync(REPO_BUILTIN).filter((f) => f.endsWith(".md"));
  expect(files.length).toBeGreaterThan(0);
  const bk = store.builtinWorkflows;
  expect(bk.length).toBeGreaterThanOrEqual(files.length);
  expect(bk.every((s) => !!s.id)).toBe(true);   // 没有 id 的内置项在三个可写池里永远查不到
});

describe("读路径按 id 认得内置项", () => {
  test("builtin-skills/*.md 能 getById", () => {
    const one = store.builtinWorkflows.find((s) => /^builtin_/.test(s.id));
    expect(one).toBeTruthy();
    const got = store.getById(one.id);
    expect(got).toBeTruthy();
    expect(got.name).toBe(one.name);
    expect(got.body.length).toBeGreaterThan(0);
  });

  test("代码内置 Workflow（wf_i）也能 getById", () => {
    const wf = store.builtinWorkflows.find((s) => /^wf_/.test(s.id));
    expect(wf).toBeTruthy();
    expect(store.getById(wf.id)).toBeTruthy();
    expect(store.isBuiltin(wf.id)).toBe(true);
  });

  test("导得出去（以前 exportMarkdown 对内置返回 null → 界面报「技能不存在」）", () => {
    const one = store.builtinWorkflows[0];
    const r = store.exportMarkdown(one.id);
    expect(r && r.content).toContain(one.name);
  });

  test("可写池里的 id 不被误判为内置", () => {
    const mine = store.add({ name: "我自己的一条", description: "d", body: "正文", category: "other" }, "manual");
    expect(mine.id).toBeTruthy();
    expect(store.isBuiltin(mine.id)).toBe(false);
  });
});

describe("findByName：空查询不许命中", () => {
  test.each([["空串", ""], ["一串空格", "   "], ["null", null], ["undefined", undefined]])("%s → null", (_t, q) => {
    /* 旧实现 all.find(s => s.name.toLowerCase().includes("")) 恒为 true，
       于是"没查到"这条兜底路径实际返回的是池里第一条——详情页正文张冠李戴。 */
    expect(store.findByName(q)).toBeNull();
  });
  test("正常名字仍然命中（含内置）", () => {
    const one = store.builtinWorkflows.find((s) => /^builtin_/.test(s.id));
    expect(store.findByName(one.name).id).toBe(one.id);
  });
});

describe("改内置 = 另存我的副本（forkBuiltin）", () => {
  const one = () => store.builtinWorkflows.find((s) => /^builtin_/.test(s.id));
  let forked = null;

  test("内置项不许就地 update", () => {
    expect(store.update(one().id, { body: "偷改内置" })).toBeNull();
  });

  test("forkBuiltin 产出一条可写的我的副本", () => {
    const src = one();
    forked = store.forkBuiltin(src.id, { body: "我改过的正文", description: "我改过的描述" });
    expect(forked).toBeTruthy();
    expect(forked.id).toBeTruthy();
    expect(forked.id).not.toBe(src.id);
    expect(store.getById(forked.id).body).toBe("我改过的正文");
    expect(store.isBuiltin(forked.id)).toBe(false);
  });

  test("内置那份原文没被动过", () => {
    expect(store.getById(one().id).body).not.toBe("我改过的正文");
  });

  test("副本落盘，重启后还在", () => {
    expect(fs.existsSync(path.join(marketDir, forked.id + ".md"))).toBe(true);
    const again = new SkillStore(marketDir, path.join(tmp, "local.json"), REPO_BUILTIN, userDir);
    expect(again.getById(forked.id).body).toBe("我改过的正文");
  });

  test("再改一次同名副本：不生出第二条", () => {
    const src = one();
    const before = store.list({ limit: 500 }).filter((s) => s.name === forked.name).length;
    store.forkBuiltin(src.id, { body: "第二次改的正文" });
    const after = store.list({ limit: 500 }).filter((s) => s.name === forked.name);
    expect(before).toBe(1);
    expect(after).toHaveLength(1);
    expect(store.getById(after[0].id).body).toBe("第二次改的正文");
  });

  test("不存在的 id 既不是内置也 fork 不出东西", () => {
    expect(store.forkBuiltin("builtin_没有这条", { body: "x" })).toBeNull();
    expect(store.isBuiltin("builtin_没有这条")).toBe(false);
  });
});
