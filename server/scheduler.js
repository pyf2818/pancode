/* ============================================================
   W4 · Scheduler — 自动化任务（一次性 + 周期，独立调度）
   ------------------------------------------------------------
   对齐 WorkBuddy Automations：任务定义持久化、独立调度器触发、
   运行历史落盘；未来运行不依赖当前会话（server 存活即调度）。

   - 存储：ROOT/.pancode/automations/<wsHash>/<id>.json
     {id, name, prompt, scheduleType: "cron"|"once", cron?, scheduledAt?,
      status: "active"|"paused"|"done"|"missed", createdAt, lastRunAt,
      nextRunAt, lastStatus}
   - 运行历史：<dir>/<id>/runs/<ts>.json，每任务封顶 20 条（防撑爆磁盘）
   - 执行：复用 LlmAgent.runSubAgent —— 工作区快照隔离 + 改动收回暂存
     （无人值守的写操作不直接落盘，进「改动审阅」队列等用户批准）+
     子智能体工具黑名单收敛。引擎不可用（无 LLM）时记录失败原因，不中断调度。
   - 补偿语义：错过多个周期的周期任务 → 每次到点只补跑一次，nextRunAt 从
     当前时间重算（爆炸收敛）；once 任务错过（server 停机期间过期）→ 标记
     missed 不再执行。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { parseCron, cronNext } = require("./cron-lite");
const safeWrite = require("./safe-write"); // { atomicWrite, enqueueWrite, saveJson }

const RUNS_CAP = 20;
const ID_RE = /^[a-z0-9_\-]+$/i;

class AutomationStore {
  constructor(dir) {
    this._dir = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  }

  _file(id) { return path.join(this._dir, id + ".json"); }
  _runsDir(id) { return path.join(this._dir, id, "runs"); }

  _readTask(id) {
    try { return JSON.parse(fs.readFileSync(this._file(id), "utf8")); } catch (e) { return null; }
  }

  list() {
    let files = [];
    try { files = fs.readdirSync(this._dir).filter((f) => /^.+\.json$/i.test(f)); } catch (e) { return []; }
    const out = [];
    for (const f of files) {
      const t = this._readTask(f.replace(/\.json$/i, ""));
      if (t) out.push(t);
    }
    out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return out;
  }

  get(id) { return ID_RE.test(String(id || "")) ? this._readTask(id) : null; }

  /* 创建任务；校验失败返回 {error}，成功返回任务对象（async：await 落盘后回读校验） */
  async create(input) {
    const name = String(input && input.name || "").trim();
    const prompt = String(input && input.prompt || "").trim();
    const scheduleType = input && input.scheduleType === "once" ? "once" : input && input.scheduleType === "cron" ? "cron" : null;
    if (!name) return { error: "任务名称不能为空" };
    if (name.length > 100) return { error: "任务名称过长（≤100 字符）" };
    if (!prompt) return { error: "任务提示词（prompt）不能为空" };
    if (prompt.length > 4000) return { error: "任务提示词过长（≤4000 字符）" };
    if (!scheduleType) return { error: "scheduleType 必须为 cron 或 once" };
    let nextRunAt = null;
    if (scheduleType === "cron") {
      if (!parseCron(input.cron)) return { error: "无效的 cron 表达式（5 字段：分 时 日 月 周，如 0 */2 * * *）" };
      nextRunAt = cronNext(input.cron, new Date());
      if (!nextRunAt) return { error: "cron 表达式在 366 天内无可执行时刻（如 2 月 30 日）" };
    } else {
      const at = new Date(input.scheduledAt || "");
      if (isNaN(at.getTime())) return { error: "scheduledAt 必须是合法的 ISO 时间" };
      if (at.getTime() <= Date.now() + 5000) return { error: "scheduledAt 必须是未来时间" };
      nextRunAt = at;
    }
    const task = {
      id: "a_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6),
      name, prompt, scheduleType,
      cron: scheduleType === "cron" ? String(input.cron).trim() : undefined,
      scheduledAt: scheduleType === "once" ? nextRunAt.toISOString() : undefined,
      status: "active",
      createdAt: Date.now(),
      lastRunAt: null, lastStatus: null,
      nextRunAt: nextRunAt.getTime(),
    };
    await safeWrite.saveJson(this._file(task.id), task);
    // safeWrite 吞错只记日志 → 回读校验持久化是否真实成功（EPERM 等）
    if (!this._readTask(task.id)) return { error: "任务持久化失败（写入被拦截，查看 server 日志）" };
    return { task };
  }

  /* 更新：仅允许 status / name / prompt（async：落盘后返回，测试可确定性断言） */
  async update(id, patch) {
    const t = this.get(id);
    if (!t) return { error: "任务不存在" };
    if (patch && typeof patch.name === "string" && patch.name.trim()) t.name = patch.name.trim().slice(0, 100);
    if (patch && typeof patch.prompt === "string" && patch.prompt.trim()) t.prompt = patch.prompt.trim().slice(0, 4000);
    if (patch && (patch.status === "active" || patch.status === "paused")) {
      t.status = patch.status;
      if (patch.status === "active" && t.scheduleType === "cron" && !t.nextRunAt) {
        const nx = cronNext(t.cron, new Date());
        if (nx) t.nextRunAt = nx.getTime();
      }
    }
    await safeWrite.saveJson(this._file(id), t);
    return { task: t };
  }

  /* 删除（async）：AV 瞬时锁可能让 rmSync EPERM → 退避重试，并验证删净后才返回 ok */
  async remove(id) {
    const t = this.get(id);
    if (!t) return { error: "任务不存在" };
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 500 * i)); // 0.5/1/1.5/2/2.5s
      try {
        fs.rmSync(this._file(id), { force: true });
        fs.rmSync(path.join(this._dir, id), { recursive: true, force: true });
      } catch (e) { continue; }
      gone = !this.get(id); // 回读验证
    }
    if (!gone) return { error: "删除失败（文件被占用，稍后重试）" };
    return { ok: true };
  }

  /* 写入一条运行记录并封顶（async：落盘后返回，读己之写有保证） */
  async appendRun(id, rec) {
    const rd = this._runsDir(id);
    try { fs.mkdirSync(rd, { recursive: true }); } catch (e) {}
    const file = path.join(rd, (rec.startedAt || Date.now()) + ".json");
    await safeWrite.saveJson(file, rec);
    let files = [];
    try { files = fs.readdirSync(rd).filter((f) => f.endsWith(".json")); } catch (e) {}
    if (files.length > RUNS_CAP) {
      files.sort();
      for (const f of files.slice(0, files.length - RUNS_CAP)) {
        try { fs.rmSync(path.join(rd, f), { force: true }); } catch (e) {}
      }
    }
  }

  runs(id, limit) {
    const rd = this._runsDir(id);
    let files = [];
    try { files = fs.readdirSync(rd).filter((f) => f.endsWith(".json")); } catch (e) { return []; }
    files.sort().reverse();
    const out = [];
    for (const f of files.slice(0, Math.min(limit || 20, RUNS_CAP))) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(rd, f), "utf8"))); } catch (e) {}
    }
    return out;
  }
}

class Scheduler {
  /* store: AutomationStore；getEngine: () => agent（需有 runSubAgent，可为 null） */
  constructor(store, getEngine, opts) {
    this._store = store;
    this._getEngine = getEngine || (() => null);
    this._opts = opts || {};
    this._running = new Set();   // 正在执行的任务 id（防重叠）
    this._timer = null;
    this.onFire = null;          // 可选回调（UI 通知用）
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick(), (this._opts.tickMs || 30) * 1000);
    if (this._timer.unref) this._timer.unref();
    // 启动补偿：错过的 once 标记 missed；到点的周期任务由 tick 首轮兜住
    for (const t of this._store.list()) {
      if (t.status === "active" && t.scheduleType === "once" && t.nextRunAt && t.nextRunAt <= Date.now()) {
        t.status = "missed"; t.nextRunAt = null;
        safeWrite.saveJson(this._store._file(t.id), t);
      }
    }
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /* 单次扫描（tick 与测试共用）：到点且未在跑的任务触发 fire（异步不阻塞） */
  checkOnce(now) {
    now = now || Date.now();
    const fired = [];
    for (const t of this._store.list()) {
      if (t.status !== "active" || this._running.has(t.id)) continue;
      if (!t.nextRunAt || t.nextRunAt > now) continue;
      fired.push(t.id);
      this.fire(t.id); // 异步，内部自带防重叠与持久化
    }
    return fired;
  }

  tick() { return this.checkOnce(); }

  /* 执行一个任务：隔离运行 + 记录 + 推进 nextRunAt */
  async fire(id) {
    const t = this._store.get(id);
    if (!t || this._running.has(id)) return null;
    this._running.add(id);
    const startedAt = Date.now();
    let rec = { startedAt, finishedAt: null, ok: false, output: "", error: null };
    try {
      const eng = this._getEngine();
      if (!eng || typeof eng.runSubAgent !== "function") {
        rec.error = "执行引擎不可用（需要 LLM 引擎）";
      } else {
        const out = await eng.runSubAgent("【自动化任务·" + t.name + "】\n" + t.prompt, { maxRounds: this._opts.maxRounds || 20 });
        rec.ok = true;
        rec.output = String(out || "(无返回)").slice(0, 8000);
      }
    } catch (e) {
      rec.error = (e && e.message) || String(e);
    }
    rec.finishedAt = Date.now();
    await this._store.appendRun(id, rec);
    // 推进调度状态（重新读盘：执行期间任务可能被改）
    const cur = this._store.get(id);
    if (cur) {
      cur.lastRunAt = startedAt;
      cur.lastStatus = rec.ok ? "ok" : "fail";
      if (cur.scheduleType === "once") {
        cur.status = "done"; cur.nextRunAt = null;
      } else {
        const nx = cronNext(cur.cron, new Date());
        cur.nextRunAt = nx ? nx.getTime() : null;
      }
      await safeWrite.saveJson(this._store._file(id), cur); // 推进落盘后再释放 _running，防崩溃后重复触发
    }
    this._running.delete(id);
    if (typeof this.onFire === "function") { try { this.onFire(id, rec); } catch (e) {} }
    return rec;
  }
}

module.exports = { AutomationStore, Scheduler, RUNS_CAP };
