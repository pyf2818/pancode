/* ============================================================
   P6 追加：「本次任务改了几个文件」必须按任务口径算
   ------------------------------------------------------------
   起因是一台开发机上只说一句"你好"，终端就报出「[沉淀] 本次任务改动 46 个文件」。
   那 46 是 `git status` 的行数：pushChanges() 返回的是整棵脏工作树（里面装着
   别的会话、并行 agent、以及用户自己在编辑器里改的东西），而沉淀句和 IDE 的
   任务进度胶囊都拿它的长度当"本轮产出"说话。

   钉三件事：
     1. _writeCount —— 任务口径的来源：只数这个会话真写过的路径，跨会话不串
     2. pushChanges —— 仓库口径（list）一个字都不能变（SCM 面板/状态栏要的就是它），
        新加的 task 只数"仓库脏文件 ∩ 本会话写过"，且 add/del 同口径求和
     3. 两处措辞层（沉淀句、IDE 胶囊）改吃任务口径；SCM 那条路径仍吃 ev.list
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AgentBase } = require("../server/agent-base");
const { LlmAgent } = require("../server/agent-llm");

describe("_writeCount — 任务口径只数本会话写过的路径", () => {
  function bare() {
    const a = Object.create(LlmAgent.prototype);
    a._convWrites = new Map();
    a.git = { baseline: async () => "base" };
    return a;
  }

  it("没写过东西就是 0（哪怕工作区脏成一片）", () => {
    const a = bare();
    a._currentConv = "c1";
    expect(a._writeCount("c1")).toBe(0);
  });

  it("记三个不同路径就是 3，同一个记两次仍是 3", () => {
    const a = bare();
    a._currentConv = "c1";
    a._recordWrite("src/a.js");
    a._recordWrite("src/b.js");
    a._recordWrite("src/c.js");
    a._recordWrite("src/a.js");
    expect(a._writeCount("c1")).toBe(3);
  });

  it("按会话分开：A 写了 2 个不该让 B 也背上 2 个", () => {
    const a = bare();
    a._currentConv = "c1";
    a._recordWrite("src/a.js");
    a._recordWrite("src/b.js");
    a._currentConv = "c2";
    a._recordWrite("src/z.js");
    expect(a._writeCount("c1")).toBe(2);
    expect(a._writeCount("c2")).toBe(1);
  });

  it("不传会话号时按当前会话算（沉淀句那条路径就是这么调的）", () => {
    const a = bare();
    a._currentConv = "c1";
    a._recordWrite("src/a.js");
    expect(a._writeCount()).toBe(1);
  });

  it("空路径/非字符串不占名额（工具偶尔会传 undefined 进来）", () => {
    const a = bare();
    a._currentConv = "c1";
    a._recordWrite("");
    a._recordWrite(null);
    a._recordWrite(42);
    expect(a._writeCount("c1")).toBe(0);
  });

  it("会话记录被 LRU 清掉之后，计数跟着归零（不留幽灵产出）", () => {
    const a = bare();
    a._currentConv = "c1";
    a._recordWrite("src/a.js");
    a._convWrites.delete("c1");
    expect(a._writeCount("c1")).toBe(0);
  });
});

describe("pushChanges — 仓库口径不动，新加的 task 只数交集", () => {
  let root, list, base, calls;
  const engine = () => {
    const events = [];
    const a = new AgentBase({
      emit: (ev) => events.push(ev),
      cfg: {},
      files: { safePath: (rel) => path.join(root, rel), read: (rel) => fs.readFileSync(path.join(root, rel), "utf8") },
      git: {
        changes: async () => list.slice(),
        baseline: async (rel) => { calls[rel] = (calls[rel] || 0) + 1; return base[rel]; },
      },
      term: null, roots: null,
    });
    a._currentConv = "c1";
    return { a, events };
  };
  const dirty = (...ps) => { list = ps.map((p) => ({ path: p, status: "M" })); };
  /* pushChanges 只读 _convWrites 这张表，写它的责任在 LlmAgent._recordWrite（上面那组已单独测）。
     这里直接铺表，是为了让这一组只钉一件事：交集算得对不对。 */
  const wrote = (a, conv, ...ps) => {
    if (!a._convWrites) a._convWrites = new Map();
    const m = a._convWrites.get(conv) || new Map();
    ps.forEach((p) => m.set(p, { isNew: false, ts: Date.now() }));
    a._convWrites.set(conv, m);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "taskscope-"));
    calls = {}; base = {};
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} });

  const write = (rel, content, oldLines) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    base[rel] = oldLines == null ? "" : oldLines.join("\n");
  };

  it("工作区脏 46 个、本会话只写过其中 2 个：list 仍是 48 项，一个字都没被裁掉", async () => {
    const all = [];
    for (let i = 0; i < 46; i++) all.push("dirt/f" + i + ".js");
    dirty(...all, "src/a.js", "src/b.js");
    write("src/a.js", "l1\nl2\n", ["l1"]);
    write("src/b.js", "x1\n", []);
    all.forEach((p) => write(p, "z\n", ["z0"]));
    const { a, events } = engine();
    wrote(a, "c1", "src/a.js");
    wrote(a, "c1", "src/b.js");
    const listOut = await a.pushChanges(false);
    const ev = events.filter((e) => e.type === "changes").pop();
    expect(listOut.length).toBe(48);          // 仓库口径：SCM 面板看到的还是整棵脏树
    expect(ev.task.files).toBe(2);            // 任务口径：只有本会话写过的两个
  });

  it("changes 事件带 task，且 task 只数交集（写过但已不在脏树里的不算产出）", async () => {
    dirty("src/a.js", "dirt/x.js", "dirt/y.js");
    write("src/a.js", "l1\nl2\nl3\n", ["l1"]);
    write("dirt/x.js", "z\n", ["z0"]);
    write("dirt/y.js", "z\n", ["z0"]);
    const { a, events } = engine();
    wrote(a, "c1", "src/a.js");
    wrote(a, "c1", "src/gone.js");            // 写过又被撤销/删掉 → 不在脏树里
    await a.pushChanges(false);
    const ev = events.filter((e) => e.type === "changes").pop();
    expect(ev.list.length).toBe(3);
    expect(ev.task.files).toBe(1);
  });

  it("一句「你好」那一轮：没有写记录 → task.files 是 0，而 list 照旧报整棵脏树", async () => {
    dirty("dirt/x.js", "dirt/y.js");
    write("dirt/x.js", "z\n", ["z0"]);
    write("dirt/y.js", "z\n", ["z0"]);
    const { a, events } = engine();
    await a.pushChanges(false);
    const ev = events.filter((e) => e.type === "changes").pop();
    expect(ev.list.length).toBe(2);
    expect(ev.task.files).toBe(0);
    expect(ev.task.add).toBe(0);
    expect(ev.task.del).toBe(0);
  });

  it("task 的 add/del 只加交集里的行（不能文件按任务、行数按仓库）", async () => {
    dirty("src/a.js", "src/b.js");
    /* 基线与新版都带尾换行：这是仓库里绝大多数文件的真实形状。
       （基线没尾换行而新版有 → diffStat 会报 +4，那是"\ No newline at end of file"
         被算成多出一行，属于既有口径，不是本次要钉的东西。） */
    write("src/a.js", "n1\nn2\nn3\n", ["o1", ""]);      // +3 −1
    write("src/b.js", "b1\n", []);                       // +1 −0
    const { a, events } = engine();
    wrote(a, "c1", "src/a.js");
    await a.pushChanges(false);
    const ev = events.filter((e) => e.type === "changes").pop();
    expect(ev.list.length).toBe(2);
    expect(ev.task.files).toBe(1);
    expect(ev.task.add).toBe(3);
    expect(ev.task.del).toBe(1);
  });

  it("会话隔离：c1 写过、当前会话是 c2 → c2 的产出是 0", async () => {
    dirty("src/a.js");
    write("src/a.js", "l1\nl2\n", ["l1"]);
    const { a, events } = engine();
    wrote(a, "c1", "src/a.js");          // 记在 c1 名下
    a._currentConv = "c2";
    await a.pushChanges(false);
    const ev = events.filter((e) => e.type === "changes").pop();
    expect(ev.convId).toBe("c2");
    expect(ev.task.files).toBe(0);
  });

  it("演示引擎（没有 _convWrites）不许因此炸掉 —— 基类路径也要发得出 task", async () => {
    dirty("dirt/x.js");
    write("dirt/x.js", "z\n", ["z0"]);
    const { a, events } = engine();
    expect(a._convWrites).toBeFalsy();
    await a.pushChanges(false);
    const ev = events.filter((e) => e.type === "changes").pop();
    expect(ev.task).toMatchObject({ files: 0, add: 0, del: 0, entries: [] });
  });

  it("task.entries 给的是本轮那几个文件（带各自增删行），不是整棵脏树", async () => {
    dirty("src/a.js", "src/b.js", "dirt/x.js");
    write("src/a.js", "n1\nn2\nn3\n", ["o1", ""]);
    write("src/b.js", "b1\n", ["b0", ""]);
    write("dirt/x.js", "z\n", ["z0", ""]);
    const { a, events } = engine();
    wrote(a, "c1", "src/a.js", "src/b.js");
    await a.pushChanges(false);
    const ev = events.filter((e) => e.type === "changes").pop();
    expect(ev.task.entries.map((e) => e.path).sort().join(",")).toBe("src/a.js,src/b.js");
    expect(ev.task.entries.find((e) => e.path === "src/a.js")).toMatchObject({ add: 3, del: 1 });
    expect(ev.list.length).toBe(3);            // 仓库口径的整张表仍然完整在场
  });
});

describe("措辞层改吃任务口径，SCM 那条路径不许跟着改", () => {
  /* 结构判据一律先剥注释：注释里写着"以前用 changes.length"，不剥就是注释把判据点红 */
  const codeOf = (p) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("沉淀句不再拿 pushChanges 的长度说话", () => {
    const src = codeOf("server/agent-llm.js");
    expect(src).not.toMatch(/sediment\.push\("改动 " \+ changes\.length/);
    expect(src).toMatch(/sediment\.push\("改动 " \+ wroteN \+ " 个文件"\)/);
    expect(src).toMatch(/const wroteN = this\._writeCount\(convId\)/);
  });

  it("IDE 胶囊优先用任务口径", () => {
    const src = codeOf("public/app.js");
    expect(src).toMatch(/state\.lastTaskTotals \|\| state\.lastChangeTotals/);
  });

  it("IDE 仍把仓库口径的整张表交给改动面板（SCM 不能被任务口径缩小）", () => {
    const src = codeOf("public/app.js");
    expect(src).toMatch(/renderChanges\(ev\.list\)/);
    expect(src).toMatch(/state\.lastChangeTotals = \{/);
  });
});
