/* ============================================================
   阶段三-1 任务表 + 忙时排队回归。

   要治的是「派出去的活凭空消失」这条链的前半段：
     ① 同一会话正在跑时，旧实现 `if (runningConvs.has(convId)) return;` —— 用户点了发送，
        界面没有任何回执，消息静默丢弃。
     ② 关窗 / 断线回来，前端只能靠"这个标签页里刚才看不看得到"猜任务还在不在；
        服务端压根没有一份「哪个会话在跑/排队/刚结束」的表。

   注意 TaskBoard 落盘走 safe-write 的异步队列（POST/emit 返回 ≠ 文件已写），
   所有读盘断言都要轮询等，否则测的是竞态。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { TaskBoard } = require("../server/tasks");
const { LlmAgent } = require("../server/agent-llm");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-tasks-"));
  return path.join(dir, "tasks.json");
}
/* 异步落盘：等到文件里能读到期望内容为止（超时返回 false，让断言真的变红） */
async function untilRead(p, pred, ms) {
  const deadline = Date.now() + (ms || 3000);
  while (Date.now() < deadline) {
    try { if (pred(JSON.parse(fs.readFileSync(p, "utf8")))) return true; } catch (e) {}
    await wait(60);
  }
  return false;
}

describe("TaskBoard：行状态", () => {
  it("begin 建行、同会话复用同一行并刷新起点", () => {
    const b = new TaskBoard(tmpFile());
    const r1 = b.begin("u1", "c1", "重构 a.js");
    b.note("u1", "c1", { status: "waiting", waitingFor: "delete_file" });
    const r2 = b.begin("u1", "c1", "再来一轮");
    expect(b.list("u1").length).toBe(1);
    expect(r2.startedAt).toBeGreaterThanOrEqual(r1.startedAt);
    expect(r2.status).toBe("running");
    expect(r2.title).toBe("再来一轮");
    expect(r2.waitingFor === undefined || r2.waitingFor === "").toBeTruthy();
  });

  it("不同用户互不可见，list 按 userKey 过滤", () => {
    const b = new TaskBoard(tmpFile());
    b.begin("u1", "c1", "甲的活");
    b.begin("u2", "c1", "乙的活");
    expect(b.list("u1").map((r) => r.title)).toEqual(["甲的活"]);
    expect(b.list("u2").map((r) => r.title)).toEqual(["乙的活"]);
    expect(b.list().length).toBe(2);          // 不带 userKey = 全部（切换工作区时广播用）
  });

  it("进行中的排在前面，其余按最后事件倒序", () => {
    // Date.now 是毫秒精度，同毫秒的操作会打平——用假时钟把顺序钉死，否则这条测试是掷硬币
    const realNow = Date.now;
    let t = 1000;
    Date.now = () => ++t;
    try {
      const b = new TaskBoard(tmpFile());
      b.begin("u1", "old", "早就收口");
      b.end("u1", "old", "done");
      b.begin("u1", "run", "还在跑");
      b.begin("u1", "new", "刚结束");
      b.end("u1", "new", "done");
      expect(b.list("u1").map((r) => r.convId)).toEqual(["run", "new", "old"]);
    } finally {
      Date.now = realNow;
    }
  });

  it("snapshot 只带状态与标题，绝不把历史消息塞进握手", () => {
    const b = new TaskBoard(tmpFile());
    b.begin("u1", "c1", "x".repeat(200));
    const s = b.snapshot("u1")[0];
    expect(Object.keys(s).sort()).toEqual(
      ["convId", "endedAt", "lastEventAt", "origin", "queueLen", "startedAt", "status", "title", "tools", "turns"].sort());
    expect(s.title.length).toBeLessThanOrEqual(80);
    expect(s.origin).toBe("chat");
  });

  it("自动化任务是工作区级的：别的用户也看得见，普通会话的行不外泄", () => {
    const b = new TaskBoard(tmpFile());
    b.begin("automation", "auto-7", "自动化：每日备份", "automation");
    b.begin("u1", "c1", "甲的私活");
    b.begin("u2", "c2", "乙的私活");
    /* 这条测的是"看得见哪些行"，不是排序：三次 begin() 若正好跨了同一毫秒与跨了不同毫秒，
       startedAt 倒序会给出的先后不一样（进行中的行都算"最新"）。排序另有上一条测试专门钉。 */
    expect(b.snapshot("u2").map((r) => r.convId).sort()).toEqual(["auto-7", "c2"]);
    expect(b.snapshot("u2").some((r) => r.title === "甲的私活")).toBe(false);
    expect(b.snapshot("u2").find((r) => r.convId === "auto-7").origin).toBe("automation");
  });

  it("封顶 30 行时只丢最旧的收口行，进行中的一行都不许掉", () => {
    const b = new TaskBoard(tmpFile());
    for (let i = 0; i < 40; i++) { b.begin("u1", "c" + i, "任务" + i); b.end("u1", "c" + i, "done"); }
    b.begin("u1", "live", "还在跑");
    for (let i = 0; i < 20; i++) { b.begin("u1", "d" + i, "补" + i); }
    const rows = b.list("u1");
    expect(rows.length).toBeLessThanOrEqual(30);
    expect(rows.some((r) => r.convId === "live")).toBe(true);
  });

  it("inc 只更新已在跑的行的计数，行不存在时不凭空建", () => {
    const b = new TaskBoard(tmpFile());
    expect(b.inc("u1", "nope", "tools")).toBe(null);
    b.begin("u1", "c1", "t");
    b.note("u1", "c1", { status: "waiting" });
    const r = b.inc("u1", "c1", "tools", true);
    expect(r.tools).toBe(1);
    expect(r.status).toBe("running");   // waiting 被工具完成事件拉回运行中
  });
});

describe("TaskBoard：落盘与重启", () => {
  it("落盘文件按分片键路径写，内容能读回来", async () => {
    const p = tmpFile();
    const b = new TaskBoard(p);
    b.begin("u1", "c1", "重构 a.js");
    b.inc("u1", "c1", "tools");
    b.end("u1", "c1", "done");
    expect(await untilRead(p, (d) => Array.isArray(d.tasks) && d.tasks.length === 1 && d.tasks[0].status === "done")).toBe(true);
    const back = new TaskBoard(p);
    expect(back.list("u1").map((r) => [r.convId, r.status, r.tools])).toEqual([["c1", "done", 1]]);
  });

  it("重启后仍挂着 running / waiting 的行必须改判为 interrupted，并计数给启动日志", async () => {
    const p = tmpFile();
    const b = new TaskBoard(p);
    b.begin("u1", "live", "被重启打断");
    b.begin("u1", "wait", "等确认时被打断");
    b.note("u1", "wait", { status: "waiting", waitingFor: "delete_file" });
    b.begin("u1", "fine", "本来就收口了");
    b.end("u1", "fine", "done");
    expect(await untilRead(p, (d) => d.tasks && d.tasks.length === 3)).toBe(true);

    const back = new TaskBoard(p);
    const byId = {};
    for (const r of back.list("u1")) byId[r.convId] = r;
    expect(byId.live.status).toBe("interrupted");
    expect(byId.wait.status).toBe("interrupted");
    expect(byId.fine.status).toBe("done");                 // 收口过的不许被误改
    expect(back.interruptedCount).toBe(2);
  });

  it("文件坏掉 / 不存在都不抛，退化成空表", () => {
    const p = tmpFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ 不是 JSON", "utf8");
    expect(() => new TaskBoard(p)).not.toThrow();
    expect(new TaskBoard(p).list().length).toBe(0);
    expect(new TaskBoard(path.join(p, "..", "nope", "x.json")).list().length).toBe(0);
  });
});

describe("自动化调度接入任务表：必须先 running 再翻面", () => {
  const { Scheduler } = require("../server/scheduler");

  function fakeStore(task) {
    return {
      list: () => [task],
      get: (id) => (id === task.id ? task : null),
      appendRun: async () => {},
      _file: () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pancode-sched-")), "run.json"),
    };
  }

  it("onStart 先于 onFire，且顺序与结果一起交给回调", async () => {
    const seq = [];
    const task = { id: "a1", name: "每日备份", prompt: "跑一下", status: "active", scheduleType: "once", nextRunAt: Date.now() - 1 };
    const s = new Scheduler(fakeStore(task), () => ({ runSubAgent: async () => "完成" }), {});
    s.onStart = (id, t) => seq.push(["start", id, t.name]);
    s.onFire = (id, rec) => seq.push(["fire", id, rec.ok]);
    await s.fire("a1");
    expect(seq).toEqual([["start", "a1", "每日备份"], ["fire", "a1", true]]);
  });

  it("引擎缺失时收口成失败，但一样先落 running（否则通知永远等不到翻面）", async () => {
    const seq = [];
    const task = { id: "a2", name: "无引擎", prompt: "x", status: "active", scheduleType: "once", nextRunAt: Date.now() - 1 };
    const s = new Scheduler(fakeStore(task), () => null, {});
    s.onStart = () => seq.push("start");
    s.onFire = (id, rec) => seq.push(rec.ok === false ? "fail:" + rec.error : "ok");
    await s.fire("a2");
    expect(seq[0]).toBe("start");
    expect(seq[1]).toMatch(/^fail:/);
  });

  it("回调抛异常绝不能拖垮任务执行本身", async () => {
    const task = { id: "a3", name: "炸回调", prompt: "x", status: "active", scheduleType: "once", nextRunAt: Date.now() - 1 };
    const s = new Scheduler(fakeStore(task), () => ({ runSubAgent: async () => "结果" }), {});
    s.onStart = () => { throw new Error("崩"); };
    s.onFire = () => { throw new Error("崩"); };
    const rec = await s.fire("a3");
    expect(rec && rec.ok).toBe(true);
  });
});

/* ---------------- 内核排队 ---------------- */

function makeAgent() {
  const a = Object.create(LlmAgent.prototype);
  a._convQueues = {};
  a.runningConvs = new Set();
  a.events = [];
  a.emit = (ev) => { a.events.push(ev); };
  return a;
}
const types = (a, t) => a.events.filter((e) => e.type === t);

describe("同一会话忙时：排队而不是静默丢弃", () => {
  it("排队带位置回执，按 FIFO 放行", () => {
    const a = makeAgent();
    a.runningConvs.add("c1");
    expect(a._queueChat("c1", "第一条", { convId: "c1" })).toBe(true);
    expect(a._queueChat("c1", "第二条", { convId: "c1" })).toBe(true);
    const q = types(a, "chat.queued");
    expect(q.map((e) => e.position)).toEqual([1, 2]);
    expect(q[0].convId).toBe("c1");
    // 回执必须让用户看得见：结构化事件之外还要有一条终端提示
    const lines = types(a, "term.line").map((e) => e.text);
    expect(lines.some((t) => /排到第 1 位/.test(t))).toBe(true);

    const calls = [];
    a.handleChat = (text, opts) => { calls.push([text, opts.convId]); };
    expect(a._drainChatQueue("c1")).toBe(true);
    expect(a._drainChatQueue("c1")).toBe(true);
    expect(a._drainChatQueue("c1")).toBe(false);           // 空队列不再放行
    expect(types(a, "chat.dequeued").map((e) => e.remaining)).toEqual([1, 0]);
  });

  it("放行要等一个 tick 才真正起跑（避免在上一轮的收尾里重入）", async () => {
    const a = makeAgent();
    const calls = [];
    a.handleChat = (text) => calls.push(text);
    a._queueChat("c1", "排队的活", {});
    a._drainChatQueue("c1");
    expect(calls.length).toBe(0);                           // 同步阶段绝不能已经开跑
    await wait(20);
    expect(calls).toEqual(["排队的活"]);
  });

  it("超过 5 条明确拒绝并给出原因，不再无声吞掉", () => {
    const a = makeAgent();
    for (let i = 0; i < 5; i++) expect(a._queueChat("c1", "第" + i + "条", {})).toBe(true);
    expect(a._queueChat("c1", "第6条", {})).toBe(false);
    const rej = types(a, "chat.rejected");
    expect(rej.length).toBe(1);
    expect(rej[0].reason).toMatch(/排了 5 条/);
    expect(rej[0].convId).toBe("c1");
    expect(types(a, "term.line").some((e) => /没发出去/.test(e.text))).toBe(true);   // 拒绝也要说出口
  });

  it("handleChat 撞上正在跑的会话时：不开第二轮，只排队", async () => {
    const a = makeAgent();
    a.runningConvs.add("c1");
    a.cfg = {};
    a.conversations = new Map();
    a.convChanges = {};
    await a.handleChat("重复点发送", { convId: "c1" });
    expect(a.runningConvs.size).toBe(1);                        // 没有第二个"运行中"被登记
    expect(a._convQueues.c1.length).toBe(1);                    // 消息进了队列而不是被丢掉
    expect(types(a, "chat.queued").length).toBe(1);
  });

  it("删会话时把它排队的后续消息一起清掉", () => {
    const a = makeAgent();
    a.conversations = new Map([["c1", { history: [], round: 0 }]]);
    a.convChanges = { c1: [] };
    a._persistConversations = () => {};
    a._queueChat("c1", "排在后面的", {});
    a.dropConversation("c1");
    expect(a._convQueues.c1 === undefined).toBe(true);
    expect(a._drainChatQueue("c1")).toBe(false);
  });
});
