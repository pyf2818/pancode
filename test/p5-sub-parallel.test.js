/* ============================================================
   P5 · 子智能体并行改盘：按文件认领、逐文件隔离、共享白板
   ------------------------------------------------------------
   改造前：一个「可能写盘」的子智能体要拿整工作区内容快照 + 一支全局互斥锁。
   于是同层并行只对只读步骤成立，两个写手永远排队；>15MB 的仓库快照直接返回 null
   （等于完全没隔离，且没人说）。
   改造后：改盘按文件认领，只给认领过的文件拍改前快照。
   ------------------------------------------------------------
   这里跑的是产品代码（runSubAgent / _claimForSub / _isolateSubRun）+ 真 FileStore。
   只把两处换成桩：模型说话（_chatStream）与工具执行（_runToolGuarded）——
   桩的作用是使"这次调用到底有没有执行"可数；真 write_file 落盘、审批门、暂存队列
   由 scripts/_verify_subboard.js 在真工作区里验。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

let tmp, dataDir, wsDir;
let LlmAgent, FileStore, currentSub, subContext, agentTools, subWriteTargets;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p5sub-"));
  dataDir = path.join(tmp, "data");
  wsDir = path.join(tmp, "ws");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "pancode.config.json"), JSON.stringify({ workspace: wsDir }), "utf8");
  process.env.PANCODE_DATA_DIR = dataDir;
  // vitest 每文件独立模块图：require 前必须已设好 PANCODE_DATA_DIR，config.ROOT 在加载时就固定
  const llm = require("../server/agent-llm");
  LlmAgent = llm.LlmAgent;
  subWriteTargets = llm._ctx.subWriteTargets;
  ({ FileStore } = require("../server/files"));
  ({ currentSub, subContext } = require("../server/sub-context"));
  agentTools = require("../server/tools/agent-tools");
});

afterAll(() => {
  delete process.env.PANCODE_DATA_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
function gate() {
  let release;
  const p = new Promise((r) => { release = r; });
  return { wait: () => p, go: () => release() };
}

/** 造一个能跑 runSubAgent 的裸对象：真文件存储 + 假模型 + 数得清的桩工具 */
function mkAgent(seed) {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = { llm: { contextWindow: 128000 }, permissions: { mode: "auto" }, memory: { enabled: false }, timeouts: { toolSec: 120 } };
  a.files = new FileStore(wsDir);
  a.staged = [];
  a.emitted = [];
  a.applied = [];
  a.patch = { stage: (conv, args) => { a.staged.push(args); return { ok: true, staged: [{ path: args.path }] }; } };
  a.emit = (m) => a.emitted.push(m);
  a._traceEvent = () => {};
  a._currentConv = "default";
  a._abort = false;
  a.fileChanged = () => {};
  a.experts = null;
  a.tool = () => ({ body() {}, image() {}, done() {}, end() {}, delta() {}, start() {} });
  a.state = () => {};
  a.say = async () => {};
  a.thinkStart = () => ({});
  a.msgStart = () => ({});
  for (const [p, c] of Object.entries(seed || {})) a.files.write(p, c);
  /* 默认桩：write_file 真落盘、其余只登记。run_command 那格用来模拟"命令改盘"——
     它按不到文件寻址，正好用来验"无法归因"那条口径。 */
  a._runToolGuarded = async (name, args) => {
    a.applied.push({ name, path: args.path || args.__p || null });
    if (name === "write_file") { a.files.write(args.path, args.content); return "已写入 " + args.path; }
    if (name === "delete_file") { a.files.remove(args.path); return "已删除 " + args.path; }
    if (name === "run_command" && args.__p) { a.files.write(args.__p, "命令造的"); return "命令写了 " + args.__p; }
    return "(桩 " + name + ")";
  };
  return a;
}

const termLines = (a) => a.emitted.filter((e) => e.type === "term.line").map((e) => e.text).join("\n");

describe("并行不再排队（按文件认领取代全局锁）", () => {
  it("两个改不同文件的写盘子智能体同时在跑（旧锁会把峰值压成 1）", async () => {
    const a = mkAgent({ "x.js": "X0", "y.js": "Y0" });
    let live = 0, peak = 0;
    a._chatStream = async () => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.n === 1) {
        live++; peak = Math.max(peak, live);
        await tick(25);
        return { toolCalls: [{ id: "t" + me.owner, name: "write_file", arguments: JSON.stringify({ path: me.label === "A" ? "x.js" : "y.js", content: me.label + "写的" }) }] };
      }
      live--;
      return { content: me.label + " 完成" };
    };
    const ra = {}, rb = {};
    await Promise.all([a.runSubAgent("任务A", { label: "A", report: ra }), a.runSubAgent("任务B", { label: "B", report: rb })]);
    expect(peak).toBe(2);
    /* 各自只收回自己那一个文件：两个都回到原文，且审阅队列里是两条互不相干的改动 */
    expect(a.files.read("x.js")).toBe("X0");
    expect(a.files.read("y.js")).toBe("Y0");
    expect(ra.changedFiles).toEqual(["x.js"]);
    expect(rb.changedFiles).toEqual(["y.js"]);
    expect(a.staged.map((s) => s.path).sort()).toEqual(["x.js", "y.js"]);
    expect(a._claims.size).toBe(0);          // 收尾释放认领，否则后来的步骤永远写不了
    expect(termLines(a)).toContain("已收回");
  });

  it("同批两个步骤要写同一个文件：后到的那次连工具都不被执行，回执里说清被谁挡", async () => {
    const a = mkAgent({ "shared.js": "原文" });
    const held = gate(), bumped = gate();
    const seenMsgs = [];
    a._chatStream = async (messages) => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.label === "A") {
        if (me.n === 1) return { toolCalls: [{ id: "a1", name: "write_file", arguments: JSON.stringify({ path: "shared.js", content: "A写的" }) }] };
        held.go();                            // A 已认领 shared.js，放 B 进来撞
        await bumped.wait();
        return { content: "A 完成" };
      }
      await held.wait();
      if (me.n === 1) return { toolCalls: [{ id: "b1", name: "write_file", arguments: JSON.stringify({ path: "shared.js", content: "B写的" }) }] };
      seenMsgs.push(messages[messages.length - 1].content);
      bumped.go();
      return { content: "B 完成" };
    };
    const ra = {}, rb = {};
    await Promise.all([a.runSubAgent("任务A", { label: "A", report: ra }), a.runSubAgent("任务B", { label: "B", report: rb })]);
    /* B 那次 write_file 没被执行：桩只记被执行的调用 */
    expect(a.applied.filter((x) => x.name === "write_file" && x.path === "shared.js").length).toBe(1);
    expect(ra.conflicts || []).toEqual([]);
    expect(rb.conflicts.length).toBe(1);
    expect(rb.conflicts[0]).toEqual({ path: "shared.js", by: "A" });
    expect(seenMsgs[0]).toContain("改盘冲突");
    expect(seenMsgs[0]).toContain("depends_on");
    /* A 的写仍被收回，盘上回到原文 */
    expect(a.files.read("shared.js")).toBe("原文");
    expect(termLines(a)).toContain("挡回");
  });

  const caseIt = process.platform === "win32" ? it : it.skip;
  caseIt("Windows 上认领键折大小写：换个大小写来写同一个文件照样被挡", async () => {
    const a = mkAgent({ "Shared.js": "原文" });
    const held = gate(), bumped = gate();
    a._chatStream = async () => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.label === "A") {
        if (me.n === 1) return { toolCalls: [{ id: "a1", name: "write_file", arguments: JSON.stringify({ path: "shared.js", content: "A写的" }) }] };
        held.go();                            // A 已认领，放 B 用另一种大小写进来撞
        await bumped.wait();
        return { content: "A 完成" };
      }
      await held.wait();
      if (me.n === 1) return { toolCalls: [{ id: "b1", name: "write_file", arguments: JSON.stringify({ path: "Shared.js", content: "B写的" }) }] };
      bumped.go();
      return { content: "B 完成" };
    };
    const ra = {}, rb = {};
    await Promise.all([a.runSubAgent("任务A", { label: "A", report: ra }), a.runSubAgent("任务B", { label: "B", report: rb })]);
    expect(a.applied.filter((x) => x.name === "write_file").length).toBe(1);   // B 那次没被执行
    expect(rb.conflicts.length).toBe(1);
    expect(rb.conflicts[0]).toEqual({ path: "shared.js", by: "A" });
    expect(a._claims.size).toBe(0);
  });

  it("前一步收尾后认领就释放：后来的步骤能正常写同一个文件", async () => {
    const a = mkAgent({ "one.js": "原文" });
    a._chatStream = async (messages) => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.n === 1) return { toolCalls: [{ id: "o1", name: "write_file", arguments: JSON.stringify({ path: "one.js", content: "第一遍" }) }] };
      return { content: "好" };
    };
    await a.runSubAgent("第一遍改", { label: "第一步" });
    expect(a.files.read("one.js")).toBe("原文");        // 已收回
    const r2 = {};
    await a.runSubAgent("第二遍改", { label: "第二步", report: r2 });
    expect(r2.conflicts || []).toEqual([]);
    expect(a.files.read("one.js")).toBe("原文");
  });

  it("只读子智能体根本不取认领，两个并行步骤不互相登记", async () => {
    const a = mkAgent({ "z.js": "Z0" });
    a._subToolset = () => [{ function: { name: "read_file" } }, { function: { name: "list_files" } }];
    a._chatStream = async () => { const me = currentSub(); me.n = (me.n || 0) + 1; return { content: me.label + "读完了" }; };
    const r1 = {}, r2 = {};
    await Promise.all([a.runSubAgent("读一遍", { label: "R1", report: r1 }), a.runSubAgent("再读一遍", { label: "R2", report: r2 })]);
    expect(r1.changedFiles).toEqual([]);
    expect(r2.changedFiles).toEqual([]);
    expect(a._claims ? a._claims.size : 0).toBe(0);
    expect(a.files.read("z.js")).toBe("Z0");
  });
});

describe("并行时只收回自己认领的（不互抹）", () => {
  it("兄弟写的文件一个字都不动，无法归因的新文件只报数不删除", async () => {
    const a = mkAgent({ "base.js": "B0" });
    const aIn = gate(), bHolds = gate();
    a._chatStream = async () => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.label === "A") {
        if (me.n === 1) { aIn.go(); await bHolds.wait(); return { toolCalls: [{ id: "a1", name: "run_command", arguments: JSON.stringify({ __p: "命令造的.txt", command: "造个文件" }) }] }; }
        return { content: "A 完成" };
      }
      await aIn.wait();
      /* B 晚一步进来 → A 起跑时拍的整盘快照作废，两人都降级成逐文件口径 */
      if (me.n === 1) return { toolCalls: [{ id: "b1", name: "write_file", arguments: JSON.stringify({ path: "sibling.js", content: "B 的改动" }) }] };
      bHolds.go();
      return { content: "B 完成" };
    };
    const ra = {}, rb = {};
    await Promise.all([a.runSubAgent("A 跑命令", { label: "A", report: ra }), a.runSubAgent("B 写文件", { label: "B", report: rb })]);
    /* B 认领过的文件按自己的改前快照收回 */
    expect(rb.changedFiles).toEqual(["sibling.js"]);
    expect(a.files.exists("sibling.js")).toBe(false);
    /* A 用命令造的文件不归 A 认领：并行时不删（删错比留着更糟），但要如实报出来 */
    expect(a.files.exists("命令造的.txt")).toBe(true);
    expect(ra.unattributed).toContain("命令造的.txt");
    expect(termLines(a)).toContain("无法归因");
    a.files.remove("命令造的.txt");
  });

  it("独占跑的那一步仍走整盘快照：命令造出来的文件也收得回来", async () => {
    const a = mkAgent({ "base.js": "B0" });
    a._chatStream = async () => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.n === 1) return { toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ __p: "命令造的.txt", command: "造个文件" }) }] };
      return { content: "完成" };
    };
    const r = {};
    await a.runSubAgent("独自跑命令", { label: "独占", report: r });
    expect(a.files.exists("命令造的.txt")).toBe(false);
    /* changedFiles 记的是"盘上真变了"，不是"我认领过"：命令造的那个文件没走认领，
       但整盘比对发现了它 —— 这里报空就等于把发生过的事说没了。 */
    expect(r.changedFiles).toEqual(["命令造的.txt"]);
    expect(r.rolledBack).toBe(1);
    expect(a.staged.length).toBe(1);
    expect(termLines(a)).toContain("独占");
  });

  it("回滚写回的正是改前内容（暂存里的 old/new 与盘上一致）", async () => {
    const a = mkAgent({ "d.js": "改前的内容\r\n第二行\r\n" });
    a._chatStream = async () => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.n === 1) return { toolCalls: [{ id: "d1", name: "write_file", arguments: JSON.stringify({ path: "d.js", content: "改后的内容" }) }] };
      return { content: "好" };
    };
    await a.runSubAgent("改 d.js", { label: "改盘" });
    expect(a.staged[0].edits[0].old_string).toBe("改前的内容\r\n第二行\r\n");
    expect(a.staged[0].edits[0].new_string).toBe("改后的内容");
    expect(a.files.read("d.js")).toBe("改前的内容\r\n第二行\r\n");
  });

  it("认领过但内容没变的不算「改动」（那个数字要量它声称的事）", async () => {
    const a = mkAgent({ "same.js": "本来就是这段" });
    a._chatStream = async () => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.n === 1) return { toolCalls: [{ id: "s1", name: "write_file", arguments: JSON.stringify({ path: "same.js", content: "本来就是这段" }) }] };
      return { content: "好" };
    };
    const r = {};
    await a.runSubAgent("原样写一遍", { label: "原样", report: r });
    expect(r.changedFiles).toEqual([]);
    expect(r.claimed).toEqual(["same.js"]);    // 认领确实发生过，只是没改出内容
    expect(r.rolledBack).toBe(0);
    expect(a.staged.length).toBe(0);        // 没真改动就别往审阅队列里塞一条空的
  });

  it("子智能体自己删掉的既有文件被重建回去（删除最危险，只还原不进审阅队列）", async () => {
    const a = mkAgent({ "gone.js": "还在这里" });
    a._chatStream = async () => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.n === 1) return { toolCalls: [{ id: "g1", name: "delete_file", arguments: JSON.stringify({ path: "gone.js" }) }] };
      return { content: "删了" };
    };
    await a.runSubAgent("删文件", { label: "删除者" });
    expect(a.files.exists("gone.js")).toBe(true);
    expect(a.files.read("gone.js")).toBe("还在这里");
  });
});

describe("认领键与工具集收敛", () => {
  it("subWriteTargets 覆盖三种形状并去重，命令类返回空（认领不了）", () => {
    expect(subWriteTargets("write_file", { path: "a.js" })).toEqual(["a.js"]);
    expect(subWriteTargets("delete_file", { path: "b.js" })).toEqual(["b.js"]);
    expect(subWriteTargets("apply_edit", { path: "c.js", edits: [{ old_string: "x" }] })).toEqual(["c.js"]);
    expect(subWriteTargets("apply_edit", { edits: [{ path: "d.js" }, { path: "e.js" }] })).toEqual(["d.js", "e.js"]);
    expect(subWriteTargets("edit_files", { ops: [{ path: "f.js" }, { path: "f.js" }, { path: "g.js" }] })).toEqual(["f.js", "g.js"]);
    expect(subWriteTargets("run_command", { command: "del x" })).toEqual([]);
    expect(subWriteTargets("rename_symbol", { name: "a", apply: true })).toEqual([]);
    expect(subWriteTargets("write_file", null)).toEqual([]);
  });

  it("跨根同名文件不互相顶掉（root 前缀进键）", () => {
    const here = subWriteTargets("write_file", { path: "src/a.js" });
    const there = subWriteTargets("write_file", { path: "src/a.js", root: "other" });
    expect(here).toEqual(["src/a.js"]);
    expect(there).toEqual(["@other/src/a.js"]);
  });

  it("绝对路径折回工作区相对键，工作区外的保持原样", () => {
    const a = mkAgent({});
    expect(a._claimKey(path.join(wsDir, "src", "x.js"))).toBe("src/x.js");
    expect(a._claimKey("./y.js")).toBe("y.js");
    expect(a._claimKey("z\\w.js")).toBe("z/w.js");
    expect(a._claimKey(path.resolve(os.tmpdir(), "别处.js"))).toBe(path.resolve(os.tmpdir(), "别处.js").replace(/\\/g, "/"));
  });

  it("orchestrate 不再进子智能体工具集，board 反而只在子集里", () => {
    const a = Object.create(LlmAgent.prototype);
    const sub = a._subToolset().map((t) => t.function.name);
    expect(sub).not.toContain("orchestrate");
    expect(sub).not.toContain("agent");
    expect(sub).toContain("board");
    const parent = LlmAgent.toolsForMode({}).map((t) => t.function.name);
    expect(parent).toContain("orchestrate");
    expect(parent).not.toContain("board");
  });

  it("toolsForMode 的旧判定没被重构改掉：ask 档空、规划档拦改盘放行只读", () => {
    expect(LlmAgent.toolsForMode({ asking: true })).toEqual([]);
    const plan = LlmAgent.toolsForMode({ planMode: true }).map((t) => t.function.name);
    expect(plan).not.toContain("write_file");
    expect(plan).toContain("read_file");
    expect(plan).not.toContain("board");
  });

  it("子智能体提示词把并行的规矩写进去了（它看不到契约表，只能靠这段话）", () => {
    const a = Object.create(LlmAgent.prototype);
    const p = a._subSystemPrompt("coder", null);
    expect(p).toContain("同批还有兄弟在并行");
    expect(p).toContain("board");
    expect(p).toContain("挡回");
  });
});

describe("共享白板 handler", () => {
  /* handler 只需要 agent.tool()/agent.state() 两个门面；真正的归属由 subContext 决定 */
  const stubAgent = () => ({ tool: () => ({ body() {}, done() {} }), state() {} });

  it("不在编排里时诚实说没人读，不假装记下了", async () => {
    const out = await agentTools.board(stubAgent(), { action: "write", text: "一条结论" });
    expect(out).toContain("没有正在进行的编排");
  });

  it("同一步写完能被兄弟读到，渲染时又能排掉自己写的那条", async () => {
    const { Blackboard } = require("../server/blackboard");
    const board = new Blackboard("run-x");
    const s1 = { label: "步骤一", from: "s1", board, owned: new Set(), conflicts: [], report: {} };
    const w = await subContext.run(s1, () => agentTools.board(stubAgent(),
      { action: "write", kind: "finding", key: "auth.js", text: "会话令牌在 cookie 里" }));
    expect(w).toContain("已写上白板");
    const s2 = { label: "步骤二", from: "s2", board, owned: new Set(), conflicts: [], report: {} };
    const readOut = await subContext.run(s2, () => agentTools.board(stubAgent(), { action: "read" }));
    expect(readOut).toContain("会话令牌在 cookie 里");
    expect(readOut).toContain("auth.js");
    expect(board.render("s1")).toBe("");            // s1 不必重读自己刚写的那条
    expect(board.render("s2")).toContain("auth.js");
    expect(board.from("s1").length).toBe(1);
  });

  it("空白板写空正文被拒（不许留一条没人看得懂的空条目）", async () => {
    const { Blackboard } = require("../server/blackboard");
    const board = new Blackboard("r");
    const out = await subContext.run({ label: "x", from: "x", board, owned: new Set(), conflicts: [] },
      () => agentTools.board(stubAgent(), { action: "write", text: "   " }));
    expect(out).toContain("正文是空的");
    expect(board.items.length).toBe(0);
  });
});
