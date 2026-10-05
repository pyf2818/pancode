/* ============================================================
   阶段三-3 Goal 续跑状态持久化 + 重启接续。

   要治的：目标文本本来就落盘，但**续跑进度**（第几轮 / 停滞判据）只在内存里。
   进程一重启，Goal 静默停在最后一轮——用户既不知道它停了，也没地方接回去。

   刻意**不自动续跑**：重启后擅自继续改盘、跑命令，是用户没点头的事。
   只做两件事——把"跑到第 N 轮被打断"如实落盘并说出口，以及给一条显式的接续入口。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { LlmAgent } = require("../server/agent-llm");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pancode-goal-")), "goal.json");
}
function agent(goalPath) {
  const a = Object.create(LlmAgent.prototype);
  a._goalPath = goalPath;
  a._goal = null;
  a._goalState = {};
  return a;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function untilRead(p, pred, ms) {
  const deadline = Date.now() + (ms || 3000);
  while (Date.now() < deadline) {
    try { if (pred(JSON.parse(fs.readFileSync(p, "utf8")))) return true; } catch (e) {}
    await wait(60);
  }
  return false;
}

describe("目标与进度一起落盘", () => {
  it("_saveGoal 写的不再只有目标文本，还带每会话的续跑进度", async () => {
    const p = tmpFile();
    const a = agent(p);
    a._goal = "把所有测试跑绿";
    a._goalState = { c1: { turns: 3, stall: 1, lastSig: "src/a.js:2:1" }, c2: undefined };
    a._saveGoal();
    expect(await untilRead(p, (d) => d.goal === "把所有测试跑绿" && d.states && d.states.c1 && d.states.c1.turns === 3)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(raw.states.c2 === undefined).toBe(true);        // 收口的会话不该被留成"待接续"
    expect(raw.states.c1.lastSig).toBe("src/a.js:2:1");    // 停滞判据也得存，回来才接得上
  });

  it("_loadGoal 同时恢复目标文本与进度", async () => {
    const p = tmpFile();
    const a = agent(p);
    a._goal = "重构再验一遍";
    a._goalState = { cX: { turns: 7, stall: 0, lastSig: "sig" } };
    a._saveGoal();
    expect(await untilRead(p, (d) => d.states && d.states.cX)).toBe(true);

    const b = agent(p);                          // 相当于重启后的新实例
    b._goal = b._loadGoal();                     // 与构造器同一走法：_loadGoal 只返回目标文本，_goalState 是它顺手恢复的
    expect(b._goal).toBe("重构再验一遍");
    expect(b._goalState.cX.turns).toBe(7);
    expect(b._goalState.cX.lastSig).toBe("sig");
    expect(b._pendingGoals().map((o) => o.convId)).toEqual(["cX"]);   // 一重启就能报出"这个会话被打断在第 7 轮"
  });

  it("文件不存在 / 坏掉：目标是 null、进度是空表，绝不抛", () => {
    const a = agent(path.join(tmpFile(), "..", "missing.json"));
    expect(a._loadGoal()).toBe(null);
    expect(a._goalState).toEqual({});

    const p = tmpFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{坏一半", "utf8");
    const b = agent(p);
    expect(b._loadGoal()).toBe(null);
    expect(b._goalState).toEqual({});
  });

  it("老格式（只有 goal，没有 states）读得进来，不炸", () => {
    const p = tmpFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ goal: "旧版目标", ts: 1 }), "utf8");
    const a = agent(p);
    expect(a._loadGoal()).toBe("旧版目标");
    expect(a._goalState).toEqual({});
  });
});

describe("_pendingGoals：只报真被打断的", () => {
  it("没有目标 → 空", () => {
    const a = agent(tmpFile());
    a._goal = null;
    a._goalState = { c1: { turns: 4 } };
    expect(a._pendingGoals()).toEqual([]);
  });

  it("第 0 轮（还没跑过就算设了目标）不算被打断", () => {
    const a = agent(tmpFile());
    a._goal = "G";
    a._goalState = { c1: { turns: 0, stall: 0, lastSig: "" } };
    expect(a._pendingGoals()).toEqual([]);
  });

  it("跑过至少一轮且未收口 → 报出会话与轮次", () => {
    const a = agent(tmpFile());
    a._goal = "G";
    a._goalState = { c1: { turns: 5, stall: 2, lastSig: "x" }, c2: undefined, c3: { turns: 1 } };
    const out = a._pendingGoals();
    expect(out.map((o) => o.convId).sort()).toEqual(["c1", "c3"]);
    expect(out.find((o) => o.convId === "c1")).toMatchObject({ turns: 5, stall: 2 });
  });
});
