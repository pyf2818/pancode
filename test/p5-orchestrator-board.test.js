/* ============================================================
   P5 · 编排的三条改道
   1) 声明了同一批文件的步骤自动改串行（不靠跑到一半被撞回）
   2) 下游拿到的是结构化简报 + 共享白板，不再整段吞上游原文
   3) 交回父智能体的汇报按步分行，改动归属看得见
   ------------------------------------------------------------
   runSubAgent 用假实现：这里验的是编排器发出去什么、收回来什么。
   真子智能体的认领与隔离在 test/p5-sub-parallel.test.js，整条链路在
   scripts/_verify_subboard.js。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

let tmp, dataDir, Orchestrator;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p5orch-"));
  dataDir = path.join(tmp, "data");
  const wsDir = path.join(tmp, "ws");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "pancode.config.json"), JSON.stringify({ workspace: wsDir }), "utf8");
  process.env.PANCODE_DATA_DIR = dataDir;
  ({ Orchestrator } = require("../server/orchestrator"));
});

afterAll(() => {
  delete process.env.PANCODE_DATA_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

/** 假 agent：记下每次派发的 task/opts，并按 impl 造返回与出参 */
function fakeAgent(impl) {
  return {
    emitted: [],
    emit(e) { this.emitted.push(e); },
    seen: [],
    async runSubAgent(task, opts) {
      this.seen.push({ task, opts, at: Date.now() });
      return impl(task, opts, this.seen.length - 1);
    },
  };
}

const text = (n) => "上游的长篇输出，用来撑爆注入。".repeat(n);

describe("撞车预防（声明式 writes）", () => {
  it("同批两个步骤声明同一个文件 → 自动补依赖，分层后就绪一先一后", async () => {
    const a = fakeAgent(async () => "ok");
    await new Orchestrator(a).run({
      title: "撞车",
      steps: [
        { id: "s1", name: "改入口", task: "一", writes: ["server/index.js"] },
        { id: "s2", name: "也改入口", task: "二", writes: ["server/index.js"] },
      ],
    });
    const start = a.emitted.find((e) => e.type === "orch.start");
    const byId = {};
    start.steps.forEach((s) => { byId[s.id] = s; });
    expect(byId.s1.layer).toBe(0);
    expect(byId.s2.layer).toBe(1);
    expect(byId.s2.depends_on).toContain("s1");
    expect(a.emitted.some((e) => e.type === "term.line" && /自动改成串行/.test(e.text || ""))).toBe(true);
  });

  it("反面对照：声明互不相交的两个步骤仍在同一批并行（不许把并行改成一律排队）", async () => {
    const a = fakeAgent(async () => { await new Promise((r) => setTimeout(r, 80)); return "ok"; });
    await new Orchestrator(a).run({
      title: "不撞车",
      steps: [
        { id: "p1", name: "左", task: "一", writes: ["a.js"] },
        { id: "p2", name: "右", task: "二", writes: ["b.js"] },
      ],
    });
    const start = a.emitted.find((e) => e.type === "orch.start");
    expect(start.steps.find((s) => s.id === "p2").layer).toBe(0);
    expect(start.steps.find((s) => s.id === "p2").parallel).toBe(true);
    /* 派发动作必须真的同时发生：假实现每次要跑 80ms，串行排队的话第二次派发会晚 80ms 以上。
       只断言 layer/parallel 是"计划长这样"，断不到"真的这么跑了"。 */
    expect(a.seen.length).toBe(2);
    expect(Math.abs(a.seen[1].at - a.seen[0].at)).toBeLessThan(40);
  });

  it("已经有依赖关系时不重复补边（补了会造出环）", () => {
    const o = new Orchestrator({ emit() {} });
    const steps = [
      { id: "x", name: "X", writes: ["a.js"] },
      { id: "y", name: "Y", writes: ["a.js"], depends_on: ["x"] },
    ];
    expect(o._serializeWriteClashes(steps)).toEqual([]);
    expect(steps[1].depends_on).toEqual(["x"]);
  });

  it("路径写法不同也算撞车（反斜杠 / ./ 前缀 / 空声明）", () => {
    const o = new Orchestrator({ emit() {} });
    const steps = [{ id: "a", name: "A", writes: ["src/x.js"] }, { id: "b", name: "B", writes: [".\\src\\x.js"] }];
    const added = o._serializeWriteClashes(steps);
    expect(added.length).toBe(1);
    expect(added[0]).toEqual({ from: "b", to: "a", files: ["src/x.js"] });
    const empty = [{ id: "c", name: "C" }, { id: "d", name: "D", writes: [] }];
    expect(o._serializeWriteClashes(empty)).toEqual([]);
  });
});

describe("下游拿到的上下文（结构化简报 + 白板）", () => {
  it("注入的是带状态与改动清单的简报，且上游原文被截住", async () => {
    const a = fakeAgent(async (task, opts) => {
      if (opts.stepId === "u") {
        opts.report.changedFiles = ["m1.js", "m2.js"];
        return text(400);                       // 一万多字的上游原文
      }
      return "下游结论";
    });
    await new Orchestrator(a).run({
      title: "注入",
      steps: [
        { id: "u", name: "上游", task: "干活" },
        { id: "d", name: "下游", task: "接着干", depends_on: ["u"] },
      ],
    });
    const injected = a.seen[1].task;
    expect(injected).toContain("【前置步骤结果】");
    expect(injected).toContain("— 上游（u）· 完成 · 改动 2 个文件：m1.js, m2.js —");
    expect(injected).toContain("接着干");
    /* 以前这里塞的是 slice(0,8000)：一万字原文整段进下游 prompt。
       现在只留 1200，超出部分必须真的不在。 */
    expect(injected.length).toBeLessThan(2200);
    expect(text(400).slice(0, 2000).length).toBeGreaterThan(injected.length);
  });

  it("兄弟写在白板上的结论会发给下游，且不会把自己写的那条再发回给自己", async () => {
    const a = fakeAgent(async (task, opts) => {
      opts.board.post(opts.stepId, "blocker", "老认证中间件", "它没有 refresh，别再往上加");
      opts.report.changedFiles = [];
      return "结论";
    });
    await new Orchestrator(a).run({
      title: "白板",
      steps: [
        { id: "w1", name: "查认证", task: "一" },
        { id: "w2", name: "查会话", task: "二" },
        { id: "w3", name: "汇总", task: "三", depends_on: ["w1"] },
      ],
    });
    const w2task = a.seen.find((s) => s.opts.stepId === "w2").task;
    expect(w2task).toContain("【共享白板·兄弟步骤】");
    expect(w2task).toContain("它没有 refresh");
    const w3task = a.seen.find((s) => s.opts.stepId === "w3").task;
    expect(w3task).toContain("老认证中间件");
    /* w1 派发时白板还是空的 —— 不许把"没有内容"这件事伪装成一段空标题 */
    expect(a.seen[0].task).not.toContain("【共享白板");
  });

  it("失败的下游简报里写的是失败，不许把崩掉的步骤说成完成", async () => {
    const a = fakeAgent(async (task, opts) => {
      if (opts.stepId === "bad") throw new Error("子智能体炸了");
      opts.report.changedFiles = ["z.js"];
      return "好";
    });
    await new Orchestrator(a).run({
      title: "失败简报",
      steps: [
        { id: "bad", name: "炸的那步", task: "一" },
        { id: "after", name: "接它的", task: "二", depends_on: ["bad"] },
      ],
    });
    const t = a.seen.find((s) => s.opts.stepId === "after").task;
    expect(t).toContain("— 炸的那步（bad）· 失败");
    expect(t).toContain("子智能体炸了");
  });
});

describe("交回父智能体的汇报", () => {
  it("每步一行：状态 / 耗时 / 改动归属 / 结论摘要", async () => {
    const a = fakeAgent(async (task, opts) => {
      if (opts.stepId === "s2") {
        opts.report.changedFiles = ["a.js", "b.js"];
        opts.report.conflicts = [{ path: "c.js", by: "s1" }];
        return "第二步的结论" + text(60);
      }
      return "第一步的结论";
    });
    const r = await new Orchestrator(a).run({
      title: "汇报",
      steps: [{ id: "s1", name: "一", task: "一" }, { id: "s2", name: "二", task: "二" }],
    });
    expect(r.modelReport).toContain("- s2 二（完成");
    expect(r.modelReport).toContain("改动 2 个文件：a.js, b.js");
    expect(r.modelReport).toContain("有 1 次改盘被并行冲突挡回：c.js");
    expect(r.modelReport).toContain("未改盘");
    /* 模型序要 bounded：整段原文只留在给人看的 fullReport 里 */
    expect(r.modelReport.length).toBeLessThan(r.fullReport.length);
    expect(r.fullReport).toContain(text(60).slice(0, 200));
  });

  it("runSubAgent 不回填 report 时（旧实现/假实现）不许炸，也不编造改动数", async () => {
    const a = fakeAgent(async () => "只有文本");
    const r = await new Orchestrator(a).run({ title: "无出参", steps: [{ id: "x", name: "X", task: "一" }] });
    expect(r.modelReport).toContain("未改盘");
    expect(r.results.x.changedFiles).toEqual([]);
    expect(r.ok).not.toBe(false);
  });

  it("自动串行这件事要进历史，回放时看得见本来不是这么排的", async () => {
    const a = fakeAgent(async () => "ok");
    const r = await new Orchestrator(a).run({
      title: "留档撞车",
      steps: [
        { id: "h1", name: "H1", task: "一", writes: ["k.js"] },
        { id: "h2", name: "H2", task: "二", writes: ["k.js"] },
      ],
    });
    const { histGet } = require("../server/orchestrator");
    const rec = histGet(r.runId);
    expect(rec).toBeTruthy();
    expect(rec.serialized[0]).toEqual({ from: "h2", to: "h1", files: ["k.js"] });
    expect(rec.board).toEqual([]);
  });
});
