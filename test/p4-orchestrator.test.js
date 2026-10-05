/* ============================================================
   多 Agent 编排回归（#45：编排不稳定 + 编排历史看不到子任务与结果）
   - 拓扑分层：依赖串行、无依赖并行、循环依赖不死锁
   - 前置输出注入：后续步骤的 task 带【前置步骤结果】
   - 失败传播：子智能体抛错 → step.fail + orch.done ok=false
   - 空计划：不再静默"无步骤"，返回 ok=false + op.error
   - 历史落盘：stepMeta 带 task；histList 步骤带 task/output 摘要
   - 连续两次 append 不丢记录（saveJson 异步排队，读端必须走内存权威）
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

let tmp, dataDir, wsDir;
let Orchestrator, histAppend, histList;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-"));
  dataDir = path.join(tmp, "data");
  wsDir = path.join(tmp, "ws");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "pancode.config.json"),
    JSON.stringify({ workspace: wsDir }), "utf8");
  process.env.PANCODE_DATA_DIR = dataDir;
  // vitest 每个测试文件是独立模块图；require 前必须已设好 PANCODE_DATA_DIR，
  // config.ROOT 在模块加载时就固定了
  ({ Orchestrator, histAppend, histList } = require("../server/orchestrator"));
});

afterAll(() => {
  delete process.env.PANCODE_DATA_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

function fakeAgent(runImpl) {
  return {
    emitted: [],
    emit(e) { this.emitted.push(e); },
    async runSubAgent(task, opts) { return runImpl(task, opts); },
  };
}

describe("Orchestrator.run — 执行语义", () => {
  it("依赖步骤串行且前置输出注入后续任务", async () => {
    const seen = [];
    const a = fakeAgent(async (task) => { seen.push(task); return "S1 的结论"; });
    const r = await new Orchestrator(a).run({
      title: "依赖链",
      steps: [
        { id: "s1", name: "分析", task: "分析问题" },
        { id: "s2", name: "实现", task: "实现方案", depends_on: ["s1"] },
      ],
    });
    expect(seen.length).toBe(2);
    expect(seen[0]).toContain("分析问题");
    expect(seen[1]).toContain("实现方案");
    expect(seen[1]).toContain("【前置步骤结果】");
    expect(seen[1]).toContain("S1 的结论");
    expect(r.ok).not.toBe(false);
    expect(r.results.s2.status).toBe("done");
  });

  it("无依赖步骤并行执行（同层）", async () => {
    let live = 0, peak = 0;
    const a = fakeAgent(async () => {
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 30));
      live--;
      return "ok";
    });
    await new Orchestrator(a).run({
      title: "并行",
      steps: [
        { id: "a", name: "A", task: "任务A" },
        { id: "b", name: "B", task: "任务B" },
      ],
    });
    expect(peak).toBe(2);
  });

  it("子智能体失败 → 步骤 fail、汇总 ok=false，不影响后续独立步骤", async () => {
    const a = fakeAgent(async (task) => {
      if (task.includes("必炸")) throw new Error("子智能体崩了");
      return "正常完成";
    });
    const r = await new Orchestrator(a).run({
      title: "含失败",
      steps: [
        { id: "bad", name: "炸", task: "必炸的步骤" },
        { id: "good", name: "好", task: "正常步骤" },
      ],
    });
    expect(r.results.bad.status).toBe("fail");
    expect(r.results.good.status).toBe("done");
    expect(r.ok).toBe(false);
    const failEv = a.emitted.find((e) => e.type === "orch.step.fail");
    expect(failEv.error).toContain("子智能体崩了");
    expect(a.emitted.some((e) => e.type === "orch.done" && e.ok === false)).toBe(true);
  });

  it("循环依赖不死锁（兜底塞最后一层）", async () => {
    const a = fakeAgent(async () => "done");
    const r = await new Orchestrator(a).run({
      title: "环",
      steps: [
        { id: "x", name: "X", task: "X", depends_on: ["y"] },
        { id: "y", name: "Y", task: "Y", depends_on: ["x"] },
      ],
    });
    expect(Object.keys(r.results).sort()).toEqual(["x", "y"]);
  });

  it("空计划不再静默成功：ok=false + op.error 事件", async () => {
    const a = fakeAgent(async () => "x");
    const r = await new Orchestrator(a).run({ title: "空", steps: [] });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("steps 为空");
    expect(a.emitted.some((e) => e.type === "op.error")).toBe(true);
    // 没跑过任何子智能体
    expect(a.emitted.some((e) => e.type === "orch.start")).toBe(false);
  });
});

describe("编排历史 — 子任务与结果可见", () => {
  it("stepMeta 带 task 原文；histList 步骤带 task/output 摘要", async () => {
    const long = "很长的任务描述".repeat(30);
    const a = fakeAgent(async () => "结论：" + "很长的输出".repeat(60));
    const r = await new Orchestrator(a).run({
      title: "留档验证",
      steps: [{ id: "s1", name: "干活", task: long, agent_type: "coder" }],
    });
    expect(r.ok).not.toBe(false);
    const runs = histList().filter((x) => x.title === "留档验证");
    expect(runs.length).toBe(1);
    const st = runs[0].steps[0];
    expect(st.name).toBe("干活");
    expect(st.agent_type).toBe("coder");
    expect(st.task.length).toBeGreaterThan(0);
    expect(st.task.length).toBeLessThanOrEqual(160);
    expect(long.startsWith(st.task)).toBe(true);
    expect(st.output.length).toBeGreaterThan(0);
    expect(st.output.length).toBeLessThanOrEqual(120);
  });

  it("连续两次编排落盘不互相覆盖（异步落盘排队期读端不回旧文件）", async () => {
    const a = fakeAgent(async () => "x");
    await new Orchestrator(a).run({ title: "第一场", steps: [{ id: "p1", name: "P1", task: "一" }] });
    await new Orchestrator(a).run({ title: "第二场", steps: [{ id: "p2", name: "P2", task: "二" }] });
    const titles = histList().map((x) => x.title);
    expect(titles).toContain("第一场");
    expect(titles).toContain("第二场");
  });
});
