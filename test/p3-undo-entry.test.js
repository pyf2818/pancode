/* ============================================================
   P-H3 撤销入口（undo UI）的服务端那半边
   引擎里的检查点机制早就有了，这次补的是"能不能被界面正确读出来、按下去对不对"：
     · 卡片上那颗按钮的判据是"这一步真的把检查点压进了栈"，
       而不是前端另抄一份"哪些工具算写盘"的名字表 —— 后者一定会漂；
     · 撤销栈的视图新的在前，且不把改动前的全文搬进 HTTP；
     · 每一步带着 convId，跨会话的撤销请求必须被挡下（在 A 会话点撤销不该回滚 B 会话的活）。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LlmAgent, _ctx } = require("../server/agent-llm");
const { AgentBase } = require("../server/agent-base");
const agentTools = require("../server/tools/agent-tools");
const shadow = require("../server/shadow-git");
const { FileStore } = require("../server/files");

/* 只读栈、不碰盘 → 拿原型造一个最小实例就够，不必 boot 一个真引擎 */
function viewOf(stack, wsDir) {
  const eng = Object.create(LlmAgent.prototype);
  eng._undoStack = stack;
  eng.files = { dir: wsDir || "C:/ws/proj" };
  return eng;
}
const CK = (label, entries, convId) => ({ label, entries, at: 1000, convId: convId || "" });
const E = (p, existed, dir) => ({ path: p, beforeExisted: existed, beforeContent: existed ? "x" : null, store: null, dir });

describe("撤销栈视图", () => {
  it("新的在前，并带着栈内下标（撤销就是按这个顺序从顶上往下撤）", () => {
    const eng = viewOf([CK("写入 a.js", [E("a.js", false)]), CK("编辑 b.js", [E("b.js", true)])]);
    const steps = eng.undoSteps();
    expect(steps.map((s) => s.label)).toEqual(["编辑 b.js", "写入 a.js"]);
    expect(steps.map((s) => s.i)).toEqual([1, 0]);
  });

  it("空栈给空数组而不是 undefined（前端据此决定按钮出不出现）", () => {
    expect(viewOf([]).undoSteps()).toEqual([]);
  });

  it("分得清「改回原样」与「删掉这个新建的文件」", () => {
    const eng = viewOf([CK("批量编辑", [E("a.js", true), E("new/never.txt", false)])]);
    const acts = eng.undoSteps()[0].files.map((f) => f.action);
    expect(acts).toEqual(["改回原样", "删掉这个新建的文件"]);
  });

  it("不把改动前的内容搬进视图（一个检查点可能存着几 MB 旧文本）", () => {
    const eng = viewOf([CK("写入", [E("big.js", true)])]);
    expect(JSON.stringify(eng.undoSteps())).not.toMatch(/beforeContent/);
  });

  it("旧数据缺 convId / entries 也不炸，并回落到当前工作区的目录名", () => {
    const eng = viewOf([{ label: "老检查点", at: 5 }, CK("跨根改动", [E("c.js", true), E("d.js", true)], "c1")]);
    const steps = eng.undoSteps();
    expect(steps[0].convId).toBe("c1");
    expect(steps[0].files).toHaveLength(2);
    expect(steps[0].files[0].root).toBe("proj");
    expect(steps[1]).toMatchObject({ label: "老检查点", convId: "", files: [] });
  });
});

describe("检查点归属", () => {
  it("压栈时带上 convId 与时间，撤销入口才知道这一步是谁干的", () => {
    const eng = viewOf([]);
    eng._shadowCommit = () => {};            // 探针不真起 shadow git
    eng._pushCheckpoint([E("a.js", false)], "写入 a.js");
    expect(eng._undoStack).toHaveLength(1);
    expect(eng._undoStack[0]).toMatchObject({ label: "写入 a.js", convId: "" });
    expect(eng._undoStack[0].at).toBeGreaterThan(0);
  });

  it("空条目不压栈（被拒绝的写、没命中的编辑不该留下「可撤销」的假象）", () => {
    const eng = viewOf([]);
    eng._shadowCommit = () => {};
    eng._pushCheckpoint([], "什么都没写");
    eng._pushCheckpoint(null, "什么都没写");
    expect(eng._undoStack).toHaveLength(0);
  });
});

/* tool() 是卡片事件的唯一出口：undoable 必须只反映"栈真的长了" */
function fakeAgent() {
  const a = Object.create(AgentBase.prototype);
  const evs = [];
  a.emit = (e) => evs.push(e);
  a.id = () => "call_1";
  a.round = 0;
  a._undoStack = [];
  return { a, evs, end: () => evs.filter((e) => e.type === "tool.end")[0] };
}

describe("卡片上的可撤销旗标", () => {
  it("只读工具（没压检查点）不给旗标", () => {
    const { a, evs, end } = fakeAgent();
    const t = a.tool("read", "读取文件", "a.js");
    t.done(true, "2 行");
    expect(end(evs).undoable).toBeFalsy();
  });

  it("这一步真的压了检查点才给旗标", () => {
    const { a, evs, end } = fakeAgent();
    const t = a.tool("edit", "创建文件", "a.js");
    a._undoStack.push(CK("创建 a.js", [E("a.js", false)]));   // 模拟 handler 里的 _pushCheckpoint
    t.done(true, "已写入");
    expect(end(evs).undoable).toBe(true);
  });

  it("写完之后才失败也照样给旗标 —— 检查点已经在了，藏着按钮才是问题", () => {
    const { a, evs, end } = fakeAgent();
    const t = a.tool("edit", "批量编辑", "3 个文件");
    a._undoStack.push(CK("批量编辑", [E("a.js", true)]));
    t.done(false, "第 3 个文件失败");
    expect(end(evs).undoable).toBe(true);
  });

  it("被拒绝规则拦下（什么都没写）不给旗标", () => {
    const { a, evs, end } = fakeAgent();
    const t = a.tool("edit", "写入被拒", "secret.txt");
    t.done(false, "被拒绝规则拦截");
    expect(end(evs).undoable).toBeFalsy();
  });

  it("没有撤销栈的引擎（演示引擎）不炸", () => {
    const { a, evs, end } = fakeAgent();
    delete a._undoStack;
    const t = a.tool("edit", "创建文件", "a.js");
    t.done(true, "已写入");
    expect(end(evs).undoable).toBeFalsy();
  });
});

describe("路径来源", () => {
  it("undoSteps 用的工作区名来自 files.dir，而不是硬编码", () => {
    const eng = viewOf([CK("跨根写入", [E("x.js", true, "D:/other/repo")])], "C:/ws/mine");
    const s = eng.undoSteps()[0];
    expect(s.files[0].root).toBe(path.basename("D:/other/repo"));
  });
});

/* 内存栈空了（重启 / 换进程）之后，影子仓里那条真检查点要成为用户的入口。
   关键是"什么都不许露错"：把初始全量快照当成一步暴露出去，用户点一下就把工作区抹回开机那一刻。
   这里用真影子仓 + 真 FileStore，为的就是把 undoSteps → _undoLast → 磁盘 这条链一次跑通。 */
describe("栈空时的撤销入口（影子快照）", () => {
  let box;
  afterEach(() => {
    if (!box) return;
    try { box.eng.files.close && box.eng.files.close(); } catch (e) { /* 已关 */ }
    try { fs.rmSync(box.root, { recursive: true, force: true }); } catch (e) { /* Windows 句柄未放 */ }
    box = null;
  });

  function boot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-undo-entry-"));
    const ws = path.join(root, "demo");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "a.txt"), "v1", "utf8");
    const ready = shadow.ensureShadowRepo(path.join(root, "data"), ws);
    expect(ready.ok).toBe(true);
    const eng = Object.create(LlmAgent.prototype);
    eng.files = new FileStore(ws);
    eng._undoStack = [];
    eng._shadowRepoReady = true;
    eng._shadowGitDir = ready.dir;
    eng.emitted = [];
    eng.emit = (e) => eng.emitted.push(e);
    eng.fileChanged = () => {};
    eng.pushChanges = () => {};
    box = { root, ws, eng };
    return box;
  }

  it("只有初始全量快照时不给入口（宁可不给，也不给一个抹掉全部的一步）", () => {
    const { eng, ws } = boot();
    expect(eng.undoSteps()).toEqual([]);
    const r = eng._undoLast();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/没有可回退的检查点/);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("v1");
  });

  it("真检查点亮出来：带着 conv 归属、i=-1、以及会动哪些文件", () => {
    const { eng, ws } = boot();
    fs.writeFileSync(path.join(ws, "a.txt"), "v2", "utf8");
    fs.writeFileSync(path.join(ws, "new.txt"), "created", "utf8");
    eng._shadowCommit("原子编辑 2 个文件", [{ path: "a.txt" }, { path: "new.txt" }], "c-9");
    const steps = eng.undoSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ i: -1, fromShadow: true, label: "原子编辑 2 个文件", convId: "c-9" });
    const acts = {};
    steps[0].files.forEach((f) => { acts[f.path] = f.action; });
    expect(acts["a.txt"]).toBe("改回原样");
    expect(acts["new.txt"]).toBe("删掉这个新建的文件");
  });

  it("点下去走的是同一条 _undoLast：真回到 v1，回执报检查点标签而不是 HEAD~1", () => {
    const { eng, ws } = boot();
    fs.writeFileSync(path.join(ws, "a.txt"), "v2", "utf8");
    eng._shadowCommit("写入 a.txt", [{ path: "a.txt" }], "c-1");
    const r = eng._undoLast();
    expect(r.ok).toBe(true);
    expect(r.label).toBe("写入 a.txt");
    expect(r.restored).toEqual(["a.txt"]);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("v1");
    expect(eng.emitted.some((e) => e.type === "term.line" && /\[撤销\].*写入 a\.txt/.test(e.text))).toBe(true);
  });

  it("退到底以后不再给第二次入口（连着点不会退到初始快照）", () => {
    const { eng, ws } = boot();
    fs.writeFileSync(path.join(ws, "a.txt"), "v2", "utf8");
    eng._shadowCommit("写入 a.txt", [{ path: "a.txt" }], "c-1");
    expect(eng._undoLast().ok).toBe(true);
    expect(eng.undoSteps()).toEqual([]);
    const again = eng._undoLast();
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/没有可回退的检查点/);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("v1");
  });

  it("内存栈还有东西时不掺影子那一步（用户看到的「上一步」仍是本次运行的）", () => {
    const { eng, ws } = boot();
    fs.writeFileSync(path.join(ws, "a.txt"), "v2", "utf8");
    eng._shadowCommit("写入 a.txt", [{ path: "a.txt" }], "c-1");
    eng._undoStack.push(CK("刚写的 b.txt", [E("b.txt", false)]));
    const steps = eng.undoSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0].fromShadow).toBeUndefined();
    expect(steps[0].label).toBe("刚写的 b.txt");
  });

  /* 影子仓按工作区分片：同一台机器上两个用户共用一份。
     撤销栈本身是按用户各一份的，亮出来的这一步也必须按用户筛，
     否则"另一个用户读到的是空栈"这条既有不变量会被从后门破掉。 */
  it("归属别的用户的检查点对本引擎不可见，也按不下去", () => {
    const { eng, ws } = boot();
    fs.writeFileSync(path.join(ws, "a.txt"), "v2", "utf8");
    eng._userKey = "u-me";
    eng._shadowCommit("写入 a.txt", [{ path: "a.txt" }], "c-1");
    expect(eng.undoSteps()).toHaveLength(1);
    eng._userKey = "u-someone-else";
    expect(eng.undoSteps()).toEqual([]);
    const r = eng._undoLast();
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("v2");
  });
});

/* undo 工具的回执是模型判断"撤销到底做没做全"的唯一依据。
   shadow 那条回退路径除了把旧内容写回来，还会删掉那一步新建的文件 ——
   只报 restored 就等于删了文件却不吭声，界面上的数字也比真动过的少。 */
describe("undo 工具回执要报全动过的文件", () => {
  function undoAgent(ret) {
    const cards = [];
    return {
      cards,
      tool: () => {
        const c = { bodyText: "", label: "" };
        cards.push(c);
        return { body: (x) => { c.bodyText = String(x); }, done: (ok, label) => { c.label = label; } };
      },
      _undoLast: () => ret,
    };
  }

  it("恢复 + 删除两类都写出来，计数是两者之和", async () => {
    const a = undoAgent({ ok: true, label: "shadow-git HEAD~1", restored: ["src/a.js", "src/b.js"], removed: ["src/new.js"] });
    const out = await agentTools.undo(a, {});
    expect(out).toContain("恢复 2 个文件：src/a.js, src/b.js");
    expect(out).toContain("删掉那一步新建的 1 个文件：src/new.js");
    expect(a.cards[0].label).toBe("已撤销 3 个文件");
    expect(a.cards[0].bodyText).toContain("src/new.js");
  });

  it("内存栈那条路径没有删除项，措辞与以前一致", async () => {
    const a = undoAgent({ ok: true, label: "写入 a.js", restored: ["a.js"] });
    const out = await agentTools.undo(a, {});
    expect(out).toContain("恢复 1 个文件：a.js");
    expect(out).not.toContain("删掉那一步新建的");
    expect(a.cards[0].label).toBe("已撤销 1 个文件");
  });

  it("部分回退失败时不许报成功（reason 原样带回去）", async () => {
    const a = undoAgent({ ok: false, reason: "shadow-git: 有 2 个文件没能恢复", restored: ["a.js"], removed: [] });
    const out = await agentTools.undo(a, {});
    expect(out).toContain("有 2 个文件没能恢复");
    expect(a.cards[0].label).toBe("撤销失败");
  });

  /* "没得撤"有两种，说的话不一样：一种是这台引擎压根没有影子快照，
     一种是快照里只剩初始全量快照/回退记录。旧文案一句"重启后检查点已清空"把两种糊在一起，
     而后者其实只是"到底了"，不是"重启就全没了"。 */
  it("没有影子快照 vs 已到退到底，两种空栈分开说", async () => {
    const noRepo = undoAgent({ ok: false, reason: "empty" });
    const out1 = await agentTools.undo(noRepo, {});
    expect(out1).toContain("没有可用的影子快照");
    expect(out1).not.toMatch(/重启后检查点已清空/);

    const atBottom = undoAgent({ ok: false, reason: "影子仓里没有可回退的检查点（只剩初始全量快照或回退记录）" });
    const out2 = await agentTools.undo(atBottom, {});
    expect(out2).toContain("初始全量快照与回退记录都不算一步");
  });
});

/* ============================================================
   审查项 F04：撤销归属判据必须在核心里，不能只写在某个入口上
   以前 HTTP 的 /api/undo 记得"别替别的会话撤销"，而模型可调的 undo 工具
   直接 _undoLast() —— 同一条规则在两个入口上厚薄不一，绕过的恰好是没人盯着的那个。
   ============================================================ */
describe("撤销归属判据下沉到 _undoLast（两个入口都绕不过）", () => {
  let box;
  afterEach(() => {
    if (!box) return;
    try { box.eng.files.close && box.eng.files.close(); } catch (e) { /* 已关 */ }
    try { fs.rmSync(box.root, { recursive: true, force: true }); } catch (e) { /* Windows 句柄未放 */ }
    box = null;
  });

  function boot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-undo-owner-"));
    const ws = path.join(root, "demo");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "a.txt"), "别人的活", "utf8");
    const ready = shadow.ensureShadowRepo(path.join(root, "data"), ws);
    expect(ready.ok).toBe(true);
    const eng = Object.create(LlmAgent.prototype);
    eng.files = new FileStore(ws);
    eng._undoStack = [];
    eng._shadowRepoReady = true;
    eng._shadowGitDir = ready.dir;
    eng._userKey = "u-test";
    eng.emitted = [];
    eng.emit = (e) => eng.emitted.push(e);
    eng.fileChanged = () => {};
    eng.pushChanges = () => {};
    box = { root, ws, eng };
    return box;
  }
  /* 手工压一支内存检查点：把 a.txt 从"别人的活"改成"我写的"，归属记在 ownerConv 名下 */
  function pushWrite(eng, ownerConv, writer) {
    eng._undoStack.push({
      label: "写入 a.txt", at: Date.now(), convId: ownerConv, writer: writer || null,
      entries: [{ path: "a.txt", beforeExisted: true, beforeContent: "别人的活", store: null, dir: eng.files.dir }],
    });
    eng.files.write("a.txt", "我写的");
  }
  const read = (ws) => fs.readFileSync(path.join(ws, "a.txt"), "utf8");

  it("栈顶属于别的会话时，显式带 convId 的撤销被挡下且不弹栈", () => {
    const { eng, ws } = boot();
    pushWrite(eng, "conv-B");
    const r = eng._undoLast({ convId: "conv-A" });
    expect(r.ok).toBe(false);
    expect(r.cross).toBe(true);
    expect(r.reason).toMatch(/另一个会话/);
    expect(eng._undoStack).toHaveLength(1);          // 没被悄悄弹掉，B 自己还能撤
    expect(read(ws)).toBe("我写的");                  // 盘上一点没动
  });

  it("同一会话来撤就正常执行（守卫不是把撤销整个关掉）", () => {
    const { eng, ws } = boot();
    pushWrite(eng, "conv-B");
    const r = eng._undoLast({ convId: "conv-B" });
    expect(r.ok).toBe(true);
    expect(read(ws)).toBe("别人的活");
  });

  it("模型工具那条路径（没有显式 convId，只有 AsyncLocalStorage 上下文）同样被挡住", () => {
    const { eng, ws } = boot();
    pushWrite(eng, "conv-B");
    const { convContext } = _ctx;
    const r = convContext.run({ convId: "conv-A" }, () => eng._undoLast());
    expect(r.cross).toBe(true);
    expect(read(ws)).toBe("我写的");
  });

  it("不带会话上下文的调用保持原行为（空串按「不是别的会话」放行，别把历史用法判死）", () => {
    const { eng, ws } = boot();
    pushWrite(eng, "conv-B");
    expect(eng._undoLast().ok).toBe(true);
    expect(read(ws)).toBe("别人的活");
  });

  it("栈顶归属为空（用户在编辑器里自己存的）时允许撤销", () => {
    const { eng, ws } = boot();
    pushWrite(eng, "");
    expect(eng._undoLast({ convId: "conv-A" }).ok).toBe(true);
    expect(read(ws)).toBe("别人的活");
  });

  it("内存栈空、退影子那一步时归属判据同样生效", () => {
    const { eng, ws } = boot();
    eng.files.write("a.txt", "改过了");
    eng._shadowCommit("写入 a.txt", [{ path: "a.txt" }], "conv-B");
    const r = eng._undoLast({ convId: "conv-A" });
    expect(r.ok).toBe(false);
    expect(r.cross).toBe(true);
    expect(read(ws)).toBe("改过了");
  });

  it("_pushCheckpoint 把子智能体写者署名记进栈（F03 的否决判据靠这一笔才有信号）", () => {
    const { eng } = boot();
    const { subContext } = require("../server/sub-context");
    const w = { id: "sub-1" };
    eng._pushCheckpoint([{ path: "a.txt", beforeExisted: true, beforeContent: "别人的活", dir: eng.files.dir }], "写入 a.txt");
    expect(eng._undoStack[0].writer).toBe(null);
    subContext.run({ writer: w }, () => eng._pushCheckpoint(
      [{ path: "a.txt", beforeExisted: true, beforeContent: "别人的活", dir: eng.files.dir }], "子步骤写入"));
    expect(eng._undoStack[1].writer).toBe(w);
  });
});
