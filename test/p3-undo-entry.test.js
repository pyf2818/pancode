/* ============================================================
   P-H3 撤销入口（undo UI）的服务端那半边
   引擎里的检查点机制早就有了，这次补的是"能不能被界面正确读出来、按下去对不对"：
     · 卡片上那颗按钮的判据是"这一步真的把检查点压进了栈"，
       而不是前端另抄一份"哪些工具算写盘"的名字表 —— 后者一定会漂；
     · 撤销栈的视图新的在前，且不把改动前的全文搬进 HTTP；
     · 每一步带着 convId，跨会话的撤销请求必须被挡下（在 A 会话点撤销不该回滚 B 会话的活）。
   ============================================================ */
const path = require("path");
const { LlmAgent } = require("../server/agent-llm");
const { AgentBase } = require("../server/agent-base");

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
