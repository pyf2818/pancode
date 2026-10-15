/* ============================================================
   P1-B4 · 用量账本（.pancode/usage.json）

   为什么要落盘：面板要回答的是"今天/这个月花了多少钱"，
   而 agent 内存里的 `_usage` 一重启就归零 —— 和 undo 检查点、会话记忆当年一样，
   "只在内存里"的统计等于没有统计。

   三条硬约束（都是这个仓库里踩过的坑）：
   1) 数据根走 `configMod.ROOT`，与审计日志、trace 同一来源；
      绝不用工作区目录拼路径 —— 两套同名 `.pancode/` 会让写入端和读取端各说各话。
   2) 落盘只用 `safeWrite.saveJson`（排队 + 退避重试），并且**节流**：
      一次工具轮就写一次盘会在慢盘上堆成几十份整表重写。
   3) 读到坏 JSON 不静默覆盖：备份成 usage.json.corrupt-<ts> 再从头记。
      账本被一次崩溃写花之后，最坏的处理是"看起来是空的，于是新数据把旧的抹了"。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const configMod = require("./config");
const safeWrite = require("./safe-write");
const COST = require("./cost");

const FLUSH_MS = 5000;         // 两次落盘之间至少隔这么久（内存账一直是实时的）
const KEEP_DAYS = 180;         // 只留最近半年：自用级面板不需要十年历史，也防文件无限长

function filePath() {
  return path.join(configMod.ROOT, ".pancode", "usage.json");
}

function empty() { return { v: 1, updated: 0, days: {} }; }

function loadFromDisk() {
  const p = filePath();
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch (e) { return empty(); }        // 不存在 = 正常首启
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object" || !j.days || typeof j.days !== "object") throw new Error("形状不对");
    return { v: 1, updated: j.updated || 0, days: j.days };
  } catch (e) {
    /* 坏文件挪开而不是就地覆盖：留着它用户还能手工查，直接盖掉就等于抹了账 */
    try {
      const bak = p + ".corrupt-" + Date.now();
      fs.renameSync(p, bak);
      const log = require("./logger");
      log.tag("usage").warn("usage.json 读不出来，已备份成 " + path.basename(bak) + " 并从今天重新记（" + e.message + "）");
    } catch (e2) {
      try { require("./logger").tag("usage").warn("usage.json 坏了且没备份成功: " + e2.message); } catch (e3) {}
    }
    return empty();
  }
}

/* 只保留最近 KEEP_DAYS 天（按日界字符串比较即可，键是 YYYY-MM-DD 定宽） */
function trimDays(days) {
  const keys = Object.keys(days).sort();
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000);
  const cutKey = COST.dayKey(cutoff.getTime());
  for (const k of keys) if (k < cutKey) delete days[k];
  return days;
}

class UsageStore {
  constructor() {
    this.store = null;
    this._dirty = false;
    this._timer = null;
    this._lastWrite = 0;
  }

  _ensure() {
    if (!this.store) this.store = loadFromDisk();
    return this.store;
  }

  /* 记一笔。cost 由调用方算好传入（换算只认 server/cost.js 那一个口径）。 */
  add(rec) {
    const s = this._ensure();
    COST.accumulate(s, rec);
    s.updated = Date.now();
    this._dirty = true;
    const since = Date.now() - this._lastWrite;
    if (since >= FLUSH_MS) this.flush();
    else if (!this._timer) {
      this._timer = setTimeout(() => { this._timer = null; this.flush(); }, FLUSH_MS - since);
      if (this._timer.unref) this._timer.unref();     // 别让一个待写的定时器拖住退出
    }
  }

  flush() {
    if (!this._dirty || !this.store) return Promise.resolve();
    this._dirty = false;
    this._lastWrite = Date.now();
    trimDays(this.store.days);
    const p = filePath();
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) { /* saveJson 里还会兜一次 */ }
    return safeWrite.saveJson(p, this.store);
  }

  summary(days) {
    return COST.summarize(this._ensure(), { days });
  }

  /* 今天这一笔一笔的合计（面板顶部"今天花了多少"） */
  today() {
    const s = this._ensure();
    const d = (s.days || {})[COST.dayKey()];
    return d ? { day: COST.dayKey(), total: d.total || 0, models: d.models || {} } : { day: COST.dayKey(), total: 0, models: {} };
  }

  /* 设置里改了单价之后要让历史账按新价重算：旧账记的是**当时**算出的金额，
     单价一改就整表按 token 数重算，否则"改了价格面板不动"会被当成 bug。 */
  reprice(rates, currency) {
    const s = this._ensure();
    let changed = 0;
    Object.keys(s.days || {}).forEach((day) => {
      const d = s.days[day];
      d.total = 0;
      Object.keys(d.models || {}).forEach((model) => {
        const m = d.models[model];
        const cost = COST.costOf(model, { prompt_tokens: m.prompt, completion_tokens: m.completion }, { rates, currency });
        m.cost = cost ? cost.total : 0;
        m.currency = cost ? cost.currency : "";
        d.total += m.cost;
        changed++;
      });
    });
    if (changed) { this._dirty = true; this.flush(); }
    return changed;
  }
}

const singleton = new UsageStore();
module.exports = {
  store: singleton,
  add: (rec) => singleton.add(rec),
  flush: () => singleton.flush(),
  summary: (days) => singleton.summary(days),
  today: () => singleton.today(),
  reprice: (rates, currency) => singleton.reprice(rates, currency),
  filePath,
  KEEP_DAYS,
};
