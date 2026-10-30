/* ============================================================
   审查项 F08：停止的作用域必须等于用户点的那一下
   旧 abort() 有三处越界：
     · this.running = false 是实例级的 —— 停 A 顺带把 B 也说成"没在跑"，
       状态栏 / 托盘轮询 / 切工作区判据全跟着错；
     · 清空 this.pending 不看归属 —— B 正在等的那张审批被 A 的停止顺手拒掉；
     · 无参调用既不等于"当前会话"也不等于"全部"，只置了一个没人读的旧标志。
   ============================================================ */
const { LlmAgent, _ctx } = require("../server/agent-llm");
const { convContext } = _ctx;

function mk() {
  const a = Object.create(LlmAgent.prototype);
  a.running = false;
  a.runningConvs = new Set();
  a._convAborts = {};
  a._currentConv = "default";
  a.pending = new Map();
  a.settled = {};
  a.emitted = [];
  a.emit = (e) => a.emitted.push(e);
  a._goal = "";
  a._goalState = {};
  a._saveGoal = () => {};
  a.cfg = { timeouts: {} };
  return a;
}
/* 起一个"在跑"的会话：真 abortRef 盒子 + 一张挂在它上面的待确认卡。
   回执记在旁路 map 里 —— 塞回同一个 pending 会多出没有 resolve 的条目，
   被测的 _dropPending 遍历到它就 TypeError（那是测试夹具的错，不是产品的）。 */
function live(a, convId, pendingId) {
  const ctl = new AbortController();
  const ref = { get value() { return ctl.signal.aborted; }, set value(v) { if (v) ctl.abort(); }, signal: ctl.signal };
  a._convAborts[convId] = ref;
  a.runningConvs.add(convId);
  a.running = true;
  if (pendingId) {
    a.pending.set(pendingId, {
      convId, timer: setTimeout(() => {}, 60000),
      resolve: (v) => { a.settled[pendingId] = v; },
    });
  }
  return ref;
}
const settled = (a, id) => a.settled[id];

describe("按会话停止", () => {
  it("停 A 不动 B：B 的取消信号没被掐，审批卡还在等", () => {
    const a = mk();
    const refA = live(a, "A", "ap_A");
    const refB = live(a, "B", "ap_B");
    a.abort("A");
    expect(refA.value).toBe(true);
    expect(refB.value).toBe(false);
    expect(settled(a, "ap_A")).toMatchObject({ approved: false });
    expect(a.pending.has("ap_B")).toBe(true);
  });

  it("running 由「还有没有会话在跑」推导，不被一次停止一票否决", () => {
    const a = mk();
    live(a, "A", "ap_A");
    live(a, "B", "ap_B");
    a.abort("A");
    expect(a.running).toBe(true);          // B 还在跑
    a.abort("B");
    expect(a.running).toBe(false);         // 都停了才是 false
  });

  it("被停的那张卡会广播收尾，前端不会永远显示等待确认", () => {
    const a = mk();
    live(a, "A", "ap_A");
    a.abort("A");
    const end = a.emitted.find((e) => e.type === "tool.end");
    expect(end).toBeTruthy();
    expect(end.id).toBe("ap_ap_A");
    expect(end.ok).toBe(false);
    expect(end.label).toBe("已中断");
  });

  it("停一个不存在的会话不会误伤任何在跑的会话", () => {
    const a = mk();
    const refB = live(a, "B", "ap_B");
    a.abort("ghost");
    expect(refB.value).toBe(false);
    expect(a.pending.has("ap_B")).toBe(true);
    expect(a.running).toBe(true);
  });
});

describe("停全部", () => {
  it("无上下文调用 abort() = 停全部（服务退出 / 切工作区走这一条）", () => {
    const a = mk();
    const refA = live(a, "A", "ap_A");
    const refB = live(a, "B", "ap_B");
    a.abort();
    expect(refA.value).toBe(true);
    expect(refB.value).toBe(true);
    expect(a.running).toBe(false);
    expect(settled(a, "ap_A")).toMatchObject({ approved: false });
    expect(settled(a, "ap_B")).toMatchObject({ approved: false });
  });

  it("在会话上下文里 abort() 只停当前这一个", async () => {
    const a = mk();
    live(a, "A", "ap_A");
    const refB = live(a, "B", "ap_B");
    const refA = a._convAborts.A;
    await convContext.run({ convId: "A", abortRef: refA, getHist: () => [] }, () => { a.abort(); });
    expect(refA.value).toBe(true);
    expect(refB.value).toBe(false);
    expect(a.pending.has("ap_B")).toBe(true);
  });

  it("停止会把自驱目标摘掉，否则 800ms 后 Goal 续跑又把任务叫醒", () => {
    const a = mk();
    live(a, "A", null);
    a._goal = "把重构做完";
    a._goalState = { A: { turns: 3 } };
    let saved = 0;
    a._saveGoal = () => { saved++; };
    a.abort("A");
    expect(a._goal).toBe("");
    expect(a._goalState.A).toBe(undefined);
    expect(saved).toBe(1);
    expect(a.emitted.some((e) => e.type === "goal.settled" && e.cleared)).toBe(true);
  });
});

describe("审批归属", () => {
  it("审批卡记下的是发起它的会话（否则上面的按会话收口无从判起）", async () => {
    const a = mk();
    a.files = { dir: "C:/ws/proj" };
    a._undoStack = [];
    a._shadowRepoReady = false;
    a.currentConv = LlmAgent.prototype.currentConv;
    await convContext.run({ convId: "C-7", abortRef: { value: false }, getHist: () => [] }, () => {
      a._pushCheckpoint([{ path: "x.js", beforeExisted: false, beforeContent: null, dir: "C:/ws/proj" }], "写入 x.js");
    });
    expect(a._undoStack[0].convId).toBe("C-7");
  });
});
