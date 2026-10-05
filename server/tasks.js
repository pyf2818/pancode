/* ============================================================
   服务端任务表：回答「我现在派出去的活，到哪一步了」。
     - 关窗前派出的任务、断线期间的任务，重新连上时靠这份表回看
     - hello 带上进行中与最近收口的行，前端不再只能靠"当前标签页里看不看得到"
     - 进程重启时把上一轮还挂着的 running 标成 interrupted：那是事实，不假装还在跑
   文件：<数据根>/.pancode/tasks/<工作区分片键>.json（键一律走 ws-key）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const safeWrite = require("./safe-write");

const MAX_ROWS = 30;
const LIVE = ["running", "queued", "waiting"];
const titleOf = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);

class TaskBoard {
  constructor(filePath) {
    this._path = filePath;
    this.rows = [];
    this._load();
  }

  _load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this._path, "utf8")); } catch (e) { return; }
    const list = Array.isArray(d && d.tasks) ? d.tasks : [];
    // 落盘只可能发生在进程还活着的时候；重启后仍标着 running/waiting 的行，其实是上次退出留下的僵尸状态
    this._interrupted = 0;
    this.rows = list.map((r) => {
      if (r && LIVE.indexOf(r.status) >= 0) { this._interrupted++; return Object.assign({}, r, { status: "interrupted", endedAt: r.endedAt || r.lastEventAt || Date.now() }); }
      return r;
    }).filter((r) => r && r.id);
  }

  get interruptedCount() { return this._interrupted || 0; }

  _find(userKey, convId) {
    const id = userKey + "/" + convId;
    return this.rows.find((r) => r.id === id) || null;
  }

  /* 一次派活：同一 convId 复用同一行，把这轮的开始时间/标题刷成新的。
     waitingFor / error 必须显式清掉——上一轮"等你确认"的状态串到新一轮是假的阻塞提示。
     origin："chat" = 用户发的；"automation" = 定时器跑的（属于工作区，不是某个人）。 */
  begin(userKey, convId, title, origin) {
    const id = userKey + "/" + convId;
    const now = Date.now();
    let r = this.rows.find((x) => x.id === id);
    if (r) {
      Object.assign(r, { title: titleOf(title), status: "running", startedAt: now, endedAt: 0, lastEventAt: now, turns: 0, tools: 0, waitingFor: "", error: "", origin: origin || r.origin || "chat" });
    } else {
      r = { id, userKey, convId, title: titleOf(title), status: "running", startedAt: now, endedAt: 0, lastEventAt: now, turns: 0, tools: 0, queueLen: 0, origin: origin || "chat" };
      this.rows.push(r);
    }
    this._trim();
    this._save();
    return r;
  }

  /* 局部刷一行；行不存在就按 begin 建出来（续跑 / 恢复路径里可能没有配对的 begin） */
  note(userKey, convId, patch) {
    let r = this._find(userKey, convId);
    if (!r) { if (patch && patch.status === "running") r = this.begin(userKey, convId, (patch && patch.title) || ""); else return null; }
    Object.assign(r, patch || {}, { lastEventAt: Date.now() });
    if (LIVE.indexOf(r.status) < 0) r.endedAt = r.endedAt || Date.now();
    this._save();
    return r;
  }

  /* 计数 +1（工具完成数 / 续跑轮次）。行不存在时不新建——计数类更新只对已在跑的任务有意义。 */
  inc(userKey, convId, field, backToRunning) {
    const r = this._find(userKey, convId);
    if (!r) return null;
    r[field] = (r[field] || 0) + 1;
    r.lastEventAt = Date.now();
    if (backToRunning && r.status === "waiting") r.status = "running";
    this._save();
    return r;
  }

  end(userKey, convId, status, patch) {
    const r = this._find(userKey, convId);
    if (!r) return null;
    Object.assign(r, patch || {}, { status, endedAt: Date.now(), lastEventAt: Date.now() });
    this._save();
    return r;
  }

  /* 按用户取：进行中的排前面，其余按最后事件倒序 */
  list(userKey) {
    const mine = this.rows.filter((r) => !userKey || r.userKey === userKey);
    return mine.sort((a, b) => {
      const la = LIVE.indexOf(a.status) >= 0 ? 0 : 1, lb = LIVE.indexOf(b.status) >= 0 ? 0 : 1;
      if (la !== lb) return la - lb;
      return (b.lastEventAt || 0) - (a.lastEventAt || 0);
    });
  }

  /* hello 用的精简载荷：只带状态与标题，别把历史消息塞进握手。
     自动化任务是工作区级的（跟编排历史一样），所以人人都看得见，不只发起者。 */
  snapshot(userKey) {
    const mine = this.rows.filter((r) => !userKey || r.userKey === userKey || r.origin === "automation");
    return mine.sort((a, b) => {
      const la = LIVE.indexOf(a.status) >= 0 ? 0 : 1, lb = LIVE.indexOf(b.status) >= 0 ? 0 : 1;
      if (la !== lb) return la - lb;
      return (b.lastEventAt || 0) - (a.lastEventAt || 0);
    }).slice(0, MAX_ROWS).map((r) => ({
      convId: r.convId, title: r.title, status: r.status, origin: r.origin || "chat",
      startedAt: r.startedAt, endedAt: r.endedAt, lastEventAt: r.lastEventAt,
      turns: r.turns || 0, tools: r.tools || 0, queueLen: r.queueLen || 0,
    }));
  }

  _trim() {
    if (this.rows.length <= MAX_ROWS) return;
    const live = this.rows.filter((r) => LIVE.indexOf(r.status) >= 0);
    const settled = this.rows.filter((r) => LIVE.indexOf(r.status) < 0)
      .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
    this.rows = live.concat(settled.slice(0, Math.max(0, MAX_ROWS - live.length)));
  }

  _save() {
    safeWrite.saveJson(this._path, { v: 1, updated: Date.now(), tasks: this.rows });
  }
}

module.exports = { TaskBoard, MAX_ROWS, LIVE_STATUSES: LIVE };
