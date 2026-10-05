/* 桌面端任务观察纯函数回归：关窗续跑能不能验收，关键就在这几条判断——
   通知只在"进行中 → 收口"的那一次跳出来，托盘那行要说清现在有几件事在跑。 */
const { isLive, countRunning, justSettled, notifyText, trayStatusLine } = require("../electron/task-watch");

const row = (convId, status, extra) => Object.assign({ convId, status, title: "任务" + convId }, extra || {});

describe("countRunning / isLive", () => {
  it("running / queued / waiting 都算未收口，done / failed / aborted / interrupted 不算", () => {
    const rows = [row("a", "running"), row("b", "queued"), row("c", "waiting"),
      row("d", "done"), row("e", "interrupted")];
    expect(countRunning(rows)).toBe(3);
    expect(isLive(row("x", "done"))).toBe(false);
    expect(isLive(null)).toBe(false);
    expect(countRunning(null)).toBe(0);
  });
});

describe("justSettled：只报状态真正翻面的那一条", () => {
  it("进行中 → done 报一次", () => {
    const out = justSettled([row("a", "running")], [row("a", "done")]);
    expect(out.map((r) => r.convId)).toEqual(["a"]);
  });

  it("连续两次都是 done 不再报（否则每 3s 弹一次）", () => {
    const now = [row("a", "done")];
    expect(justSettled([row("a", "done")], now)).toEqual([]);
  });

  it("上一轮没有这条记录时不打扰（可能是别的窗口开的任务）", () => {
    expect(justSettled([], [row("z", "done")])).toEqual([]);
  });

  it("waiting → running 不算收口；running → failed 算", () => {
    expect(justSettled([row("a", "waiting")], [row("a", "running")])).toEqual([]);
    expect(justSettled([row("a", "running")], [row("a", "failed", { error: "网关 500" })])
      .map((r) => r.convId)).toEqual(["a"]);
  });

  it("多条同时收口就一次报多条", () => {
    const prev = [row("a", "running"), row("b", "queued"), row("c", "done")];
    const next = [row("a", "done"), row("b", "aborted"), row("c", "done")];
    expect(justSettled(prev, next).map((r) => r.convId).sort()).toEqual(["a", "b"]);
  });
});

describe("notifyText：文案跟着状态走", () => {
  it("完成 / 出错 / 中断 各有自己的说法，出错还带上原因", () => {
    expect(notifyText(row("a", "done")).title).toBe("任务已完成");
    expect(notifyText(row("a", "done")).body).toBe("任务a");
    expect(notifyText(row("a", "failed", { error: "x".repeat(200) })).body.length).toBeLessThanOrEqual(140);
    expect(notifyText(row("a", "failed", { error: "网关 500" })).body).toMatch(/网关 500/);
    expect(notifyText(row("a", "aborted")).title).toBe("任务已中断");
  });

  it("没有标题时退回会话号，绝不弹空白气泡", () => {
    expect(notifyText({ convId: "c-9", status: "done", title: "   " }).body).toBe("c-9");
  });
});

describe("trayStatusLine：托盘那行得是真话", () => {
  it("没有进行中任务时直说", () => {
    expect(trayStatusLine([row("a", "done")])).toMatch("没有进行中的任务");
    expect(trayStatusLine([])).toMatch("没有进行中的任务");
  });

  it("一条时报标题，等确认时换成「等你确认」", () => {
    expect(trayStatusLine([row("a", "running")])).toBe("1 个任务进行中：任务a");
    expect(trayStatusLine([row("a", "waiting")])).toBe("1 个任务等你确认：任务a");
  });

  it("多条时报数量", () => {
    expect(trayStatusLine([row("a", "running"), row("b", "queued")])).toBe("2 个任务进行中");
  });
});
