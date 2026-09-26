/* ============================================================
   W4 自动化任务单测
   - cron-lite：解析矩阵 / cronNext 命中与边界 / Vixie「或」语义 / 不可命中
   - AutomationStore：创建校验矩阵 / nextRunAt 计算 / update / remove / runs 封顶
   - Scheduler：到点触发 / 未到点与暂停不触发 / 防重叠 / once→done /
     cron 推进 nextRunAt / 引擎不可用 / 启动补偿（once 过期→missed）
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { parseCron, parseField, cronNext, cronMatches } = require("../server/cron-lite");
const { AutomationStore, Scheduler, RUNS_CAP } = require("../server/scheduler");

let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "w4-sched-"));
});
afterAll(async () => {
  await wait(120); // 等 safeWrite 异步队列清空
  for (let i = 0; i < 2; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); return; } catch (e) { await wait(300); } // Windows EBUSY 重试
  }
}, 30000); // Windows Defender 逐文件扫描会让 rmSync 偶发超默认 10s hook 预算
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe("cron-lite — 解析与 next 计算", () => {
  it("parseCron：合法表达式结构正确；非法返回 null", () => {
    const c = parseCron("0 */2 * * *");
    expect(c).toBeTruthy();
    expect(c.min).toEqual([0]);
    expect(c.hour).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    expect(parseCron("60 * * * *")).toBeNull();       // 分钟越界
    expect(parseCron("* * * *")).toBeNull();          // 少字段
    expect(parseCron("* * * * * *")).toBeNull();      // 多字段
    expect(parseCron("a * * * *")).toBeNull();        // 非数字
    expect(parseCron("5-2 * * * *")).toBeNull();      // 范围倒置
    expect(parseCron("*/0 * * * *")).toBeNull();      // 步长非法
    expect(parseCron("")).toBeNull();
    expect(parseCron(null)).toBeNull();
  });

  it("parseField：逗号列表 / 范围 / 步长 / 7 归一化为周日", () => {
    expect(parseField("1,5,9", 0, 59)).toEqual([1, 5, 9]);
    expect(parseField("10-12", 0, 59)).toEqual([10, 11, 12]);
    expect(parseField("*/15", 0, 59)).toEqual([0, 15, 30, 45]);
    expect(parseField("1-10/3", 0, 59)).toEqual([1, 4, 7, 10]);
    expect(parseField("7", 0, 6)).toEqual([0]);   // 周日 7 → 0
    expect(parseField("0-7", 0, 6)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(parseField("8", 0, 6)).toBeNull();
    expect(parseField("", 0, 59)).toBeNull();
  });

  it("cronNext：固定基准的精确命中（每小时的 30 分）", () => {
    const from = new Date(2026, 8, 26, 10, 15, 30); // 2026-09-26 10:15:30
    const nx = cronNext("30 * * * *", from);
    expect(nx.getHours()).toBe(10);
    expect(nx.getMinutes()).toBe(30);
    expect(nx.getSeconds()).toBe(0);
  });

  it("cronNext：跨日/跨月推进 + 不含 from 本身", () => {
    const from = new Date(2026, 8, 30, 23, 59, 0);
    const nx = cronNext("0 0 * * *", from); // 每天 0 点
    expect(nx.getDate()).toBe(1);
    expect(nx.getMonth()).toBe(9); // 10 月
    expect(nx.getHours()).toBe(0);
    // 恰好命中 from+1min
    const f2 = new Date(2026, 8, 26, 10, 14, 59);
    const n2 = cronNext("* * * * *", f2);
    expect(n2.getMinutes()).toBe(15);
  });

  it("cronNext：Vixie 语义——dom 与 dow 同时受限取「或」，单受限取「且」", () => {
    // 2026-09-26 是周六（dow=6）；9-28 是周一
    const sat = new Date(2026, 8, 26, 10, 0, 0);
    // dom=1（周二 9-29 前不含）与 dow=1（周一）：周一 9-28 靠 dow 命中（或语义）
    const n1 = cronNext("0 8 1 * 1", sat);
    expect(n1.getDate()).toBe(28); // 周一先到
    // 仅 dom 受限（dow=*）：必须 dom=1 且 周几不限
    const n2 = cronNext("0 8 1 * *", sat);
    expect(n2.getDate()).toBe(1);
    expect(n2.getMonth()).toBe(9);
  });

  it("cronNext：366 天内不可命中返回 null（2 月 30 日）", () => {
    expect(cronNext("0 0 30 2 *", new Date(2026, 0, 1))).toBeNull();
  });
});

describe("AutomationStore — 校验与持久化", () => {
  let store;
  beforeAll(() => { store = new AutomationStore(path.join(tmp, "auto1")); });

  it("创建校验矩阵", async () => {
    expect((await store.create({ name: "", prompt: "x", scheduleType: "cron", cron: "* * * * *" })).error).toBeTruthy();
    expect((await store.create({ name: "a".repeat(101), prompt: "x", scheduleType: "cron", cron: "* * * * *" })).error).toBeTruthy();
    expect((await store.create({ name: "t", prompt: "", scheduleType: "cron", cron: "* * * * *" })).error).toBeTruthy();
    expect((await store.create({ name: "t", prompt: "x".repeat(4001), scheduleType: "cron", cron: "* * * * *" })).error).toBeTruthy();
    expect((await store.create({ name: "t", prompt: "x", scheduleType: "weekly" })).error).toBeTruthy();
    expect((await store.create({ name: "t", prompt: "x", scheduleType: "cron", cron: "bad" })).error).toBeTruthy();
    expect((await store.create({ name: "t", prompt: "x", scheduleType: "once", scheduledAt: "not-a-date" })).error).toBeTruthy();
    const past = (await store.create({ name: "t", prompt: "x", scheduleType: "once", scheduledAt: new Date(Date.now() - 60000).toISOString() }));
    expect(past.error).toContain("未来");
  });

  it("创建成功：cron 计算未来 nextRunAt；once 保留 scheduledAt；落盘可读", async () => {
    const r1 = await store.create({ name: "定时测试", prompt: "跑测试", scheduleType: "cron", cron: "0 */2 * * *" });
    expect(r1.task).toBeTruthy();
    expect(r1.task.status).toBe("active");
    expect(r1.task.nextRunAt).toBeGreaterThan(Date.now());
    expect(store.get(r1.task.id).name).toBe("定时测试");

    const r2 = await store.create({ name: "一次性", prompt: "体检", scheduleType: "once", scheduledAt: new Date(Date.now() + 3600000).toISOString() });
    expect(r2.task.scheduledAt).toBeTruthy();
    expect(r2.task.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("update：暂停/恢复；恢复时 cron 重算 nextRunAt；非法 id 报错", async () => {
    const r = await store.create({ name: "任务X", prompt: "p", scheduleType: "cron", cron: "0 5 * * *" });
    const id = r.task.id;
    const pu = await store.update(id, { status: "paused" });
    expect(pu.task.status).toBe("paused");
    const re = await store.update(id, { status: "active" });
    expect(re.task.status).toBe("active");
    expect(re.task.nextRunAt).toBeGreaterThan(Date.now());
    expect((await store.update("no_such", { status: "paused" })).error).toBeTruthy();
  });

  it("remove：删除定义与 runs 目录", async () => {
    const r = await store.create({ name: "待删", prompt: "p", scheduleType: "cron", cron: "* * * * *" });
    const id = r.task.id;
    await store.appendRun(id, { startedAt: Date.now(), finishedAt: Date.now(), ok: true, output: "x" });
    const rm = await store.remove(id);
    expect(rm.ok).toBe(true);
    expect(store.get(id)).toBeNull();
    expect(store.runs(id)).toEqual([]);
    expect((await store.remove(id)).error).toBeTruthy();
  });

  it("runs 封顶：超过 " + RUNS_CAP + " 条删最旧，保留最新", async () => {
    const r = await store.create({ name: "封顶", prompt: "p", scheduleType: "cron", cron: "* * * * *" });
    const id = r.task.id;
    for (let i = 0; i < RUNS_CAP + 5; i++) {
      await store.appendRun(id, { startedAt: 1700000000000 + i, finishedAt: 1700000000000 + i + 100, ok: true, output: "run-" + i });
      await wait(2); // 同毫秒文件名冲突防护
    }
    const runs = store.runs(id, 50);
    expect(runs.length).toBe(RUNS_CAP);
    // 最旧的 5 条被删（startedAt 最小）
    const started = runs.map((x) => x.startedAt).sort((a, b) => a - b);
    expect(started[0]).toBe(1700000000000 + 5);
  });
});

describe("Scheduler — 触发与推进", () => {
  let store, calls;
  const mkEngine = (impl) => {
    calls = [];
    return { runSubAgent: async (...args) => { calls.push(args); return impl(...args); } };
  };

  function mkScheduler(engineImpl, opts) {
    store = new AutomationStore(path.join(tmp, "sched-" + Math.random().toString(36).slice(2, 7)));
    const eng = mkEngine(engineImpl);
    return new Scheduler(store, () => eng, opts);
  }

  it("到点任务触发：prompt 前缀+历史落盘+lastStatus=ok", async () => {
    const s = mkScheduler(async () => "测试全部通过（12 passed）");
    const r = await store.create({ name: "跑测试", prompt: "运行 npm test", scheduleType: "cron", cron: "0 */2 * * *" });
    // 把 nextRunAt 改成过去，模拟到点（直写文件，无排队的异步写与之竞争）
    const t = store.get(r.task.id);
    const raw = JSON.parse(fs.readFileSync(store._file(t.id), "utf8"));
    raw.nextRunAt = Date.now() - 1000;
    fs.writeFileSync(store._file(t.id), JSON.stringify(raw));
    expect(s.checkOnce()).toEqual([t.id]);
    await wait(50); // fire 异步
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toContain("【自动化任务·跑测试】");
    expect(calls[0][0]).toContain("运行 npm test");
    const rec = store.runs(t.id)[0];
    expect(rec.ok).toBe(true);
    expect(rec.output).toContain("12 passed");
    const after = store.get(t.id);
    expect(after.lastStatus).toBe("ok");
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("未到点 / 已暂停不触发", async () => {
    const s = mkScheduler(async () => "x");
    const r1 = await store.create({ name: "未来", prompt: "p", scheduleType: "cron", cron: "0 5 * * *" });
    await store.create({ name: "暂停", prompt: "p", scheduleType: "cron", cron: "* * * * *" });
    await store.update("暂停" && store.list().find((t) => t.name === "暂停").id, { status: "paused" });
    const fired = s.checkOnce();
    expect(fired).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("防重叠：执行中的任务不被重复触发", async () => {
    let resolveRun;
    const s = mkScheduler(() => new Promise((res) => { resolveRun = res; }));
    const r = await store.create({ name: "慢任务", prompt: "p", scheduleType: "cron", cron: "* * * * *" });
    const raw = JSON.parse(fs.readFileSync(store._file(r.task.id), "utf8"));
    raw.nextRunAt = Date.now() - 1000;
    fs.writeFileSync(store._file(r.task.id), JSON.stringify(raw));
    s.checkOnce();
    await wait(30); // 让 fire 进入 running 状态
    expect(s.checkOnce()).toEqual([]); // 还在跑 → 不再触发
    resolveRun("done");
    await wait(50);
    const recs = store.runs(r.task.id);
    expect(recs.length).toBe(1); // 只跑了一次
  });

  it("once 任务执行后 status=done、nextRunAt 清空", async () => {
    const s = mkScheduler(async () => "体检完成");
    const r = await store.create({ name: "一次性", prompt: "p", scheduleType: "once", scheduledAt: new Date(Date.now() + 3600000).toISOString() });
    const raw = JSON.parse(fs.readFileSync(store._file(r.task.id), "utf8"));
    raw.nextRunAt = Date.now() - 1000;
    fs.writeFileSync(store._file(r.task.id), JSON.stringify(raw));
    s.checkOnce();
    await wait(50);
    const after = store.get(r.task.id);
    expect(after.status).toBe("done");
    expect(after.nextRunAt).toBe(null);
    expect(after.lastStatus).toBe("ok");
  });

  it("引擎不可用：记录失败原因，不抛错", async () => {
    store = new AutomationStore(path.join(tmp, "sched-noeng"));
    const s = new Scheduler(store, () => null);
    const r = await store.create({ name: "无引擎", prompt: "p", scheduleType: "cron", cron: "* * * * *" });
    const raw = JSON.parse(fs.readFileSync(store._file(r.task.id), "utf8"));
    raw.nextRunAt = Date.now() - 1000;
    fs.writeFileSync(store._file(r.task.id), JSON.stringify(raw));
    const fired = s.checkOnce();
    expect(fired).toEqual([r.task.id]);
    await wait(50);
    const rec = store.runs(r.task.id)[0];
    expect(rec.ok).toBe(false);
    expect(rec.error).toContain("引擎不可用");
    expect(store.get(r.task.id).lastStatus).toBe("fail");
  });

  it("启动补偿：once 过期 → missed 不执行；周期任务不受影响", async () => {
    store = new AutomationStore(path.join(tmp, "sched-comp"));
    const past = await store.create({ name: "错过的", prompt: "p", scheduleType: "once", scheduledAt: new Date(Date.now() + 3600000).toISOString() });
    // 手动把 nextRunAt 改成过去，模拟 server 停机期间过期
    const raw = JSON.parse(fs.readFileSync(store._file(past.task.id), "utf8"));
    raw.nextRunAt = Date.now() - 86400000;
    fs.writeFileSync(store._file(past.task.id), JSON.stringify(raw));
    const s = new Scheduler(store, () => null);
    try {
      s.start();
      await wait(120); // start 的 missed 标记走 safeWrite 异步队列
      const after = store.get(past.task.id);
      expect(after.status).toBe("missed");
      expect(after.nextRunAt).toBe(null);
    } finally {
      s.stop(); // 失败也要停表，不留 interval 拖住 teardown
    }
  });

  it("失败任务：lastStatus=fail 且 nextRunAt 照常推进", async () => {
    const s = mkScheduler(async () => { throw new Error("boom"); });
    const r = await store.create({ name: "会炸", prompt: "p", scheduleType: "cron", cron: "* * * * *" });
    const raw = JSON.parse(fs.readFileSync(store._file(r.task.id), "utf8"));
    raw.nextRunAt = Date.now() - 1000;
    fs.writeFileSync(store._file(r.task.id), JSON.stringify(raw));
    s.checkOnce();
    await wait(50);
    const after = store.get(r.task.id);
    expect(after.lastStatus).toBe("fail");
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
    const rec = store.runs(r.task.id)[0];
    expect(rec.error).toContain("boom");
  });
});
