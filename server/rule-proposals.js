/* ============================================================
   P3-D3 自进化规则 · 规则提案（server/rule-proposals.js）

   「自进化」最容易做成两种自欺：
     1) 再叫一次 LLM 从对话里「总结点规则」——产出看着像道理、每次还都不一样，
        没人能验证它凭什么成立；
     2) 直接把建议写进 .pancode/rules——等于没有 human 签字就往硬约束里塞东西。
   这里两者都不做：提案只从**已经落盘的重复证据**里长出来，一次 LLM 调用都不发起；
   且必须用户在面板点「采纳」才落成规则文件，落的是 rules.js 认识的 frontmatter，
   并先经 rule-history 快照，因此可停用、可改、可回滚。

   证据全部来自既有账本，本模块只做归组与措辞：
     · memory    —— MemoryStore：同主题攒到 ≥2 条 lesson / error / pattern
     · rejection —— 决策链 kind=approval action=rejected：同一工具被连拒 ≥2 次
     · deny      —— 决策链 kind=gate  action=block：同一条 allow/deny 拒绝规则被撞 ≥2 次
     · hook      —— 决策链 kind=hook   action=block：同一条用户 hooks 规则拦下同一工具 ≥2 次
   门槛定在 2：一次是偶然，重复两次才说明它是一条稳定的边界而不是某一轮的即兴偏好。

   存储：<数据根>/.pancode/rule-proposals/<工作区分片键>.json ——
   分片键与记忆/技能同源（wsKey），换工作区不串台。
   adopted / dismissed 是人的决定，按住不再冒出来；
   pending 若证据消失（记忆被裁剪、决策滚出观察窗口）就自动下架——
   不再重复发生的事不该继续挂着一条提案，界面也不留一排永远点不动的死条目。
   ============================================================ */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const safeWrite = require("./safe-write");

const MIN_REPEAT = 2;      // 重复几次才提案
const MAX_EVIDENCE = 3;    // 一条提案最多带几条证据（再多只是刷屏）
const MAX_KEEP = 200;      // 提案账本上限：已决定的条目留痕，但不无限增长
const MEM_TYPES = ["lesson", "error", "pattern"];
const STATUS = ["pending", "adopted", "dismissed"];

/* 证据文本统一压成一行并截断：这些串会进面板，也会拼进规则正文 */
function flat(v, n) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n == null ? 160 : n);
}

function idOf(key) { return "rp" + crypto.createHash("md5").update(String(key)).digest("hex").slice(0, 10); }

const SRC_LABEL = { memory: "重复经验", rejection: "反复被拒", deny: "拒绝规则", hook: "hooks 拦截" };

const COPY = {
  /* 同一主题的两条教训 → 说明这条约定每次都得起作用，该从「记忆里被检索到」
     升级成「每轮强制注入」：记忆是概率在场，规则是必然在场。 */
  memory: {
    title: (t) => t,
    statement: (t, n, ev) => "同类教训在「" + t + "」下已经攒到 " + n + " 条：\n"
      + ev.map((e) => "- " + e.text).join("\n")
      + "\n按上面这些执行，不要等用户再提醒一次。",
  },
  /* 用户连续拒同一类操作 = 他不想看到这个动作发生。这是最硬的一种偏好信号，
     比记忆里的 preference 明确（拒绝是当场发生的）。 */
  rejection: {
    title: (t) => t + " 需先征得同意",
    statement: (t, n, ev) => "用户已经连着拒绝过 " + n + " 次「" + t + "」这类操作（"
      + ev.map((e) => e.text).filter(Boolean).slice(0, 2).join(" / ") + "）。\n"
      + "在用户本轮明确点名之前，不要主动发起这类动作；判断确实必要时，"
      + "先用一句话说清打算做什么、为什么，然后停下来等答复。",
  },
  /* allow/deny 规则被撞：说明模型还在往同一条边界上撞。绕过路径（换工具、换写法）
     是真实风险，所以措辞要把「不许换个方式再做一次」写进去。 */
  deny: {
    title: (t) => "拒绝规则 " + t + " 是硬边界",
    statement: (t, n, ev) => "拒绝规则「" + t + "」已经被撞上 " + n + " 次（"
      + ev.map((e) => e.text).filter(Boolean).slice(0, 2).join(" / ") + "）。\n"
      + "这条规则划出的范围是硬边界：不要换工具、换路径写法或拆成多步绕过；"
      + "确实需要越界时先停下来问用户。",
  },
  hook: {
    title: (t) => "hooks 规则限制 " + t,
    statement: (t, n, ev) => "用户在配置里设的 hooks 规则已经拦下「" + t + "」" + n + " 次（"
      + ev.map((e) => e.text).filter(Boolean).slice(0, 2).join(" / ") + "）。\n"
      + "这些拦截代表用户预先写死的禁区，不要重试同一动作，改走只读方式或先与用户确认。",
  },
};

/* 从「命中拒绝规则 run_command rm*」里取出规则标签；标签本身是分组键，必须稳定 */
function denyRuleLabel(reason) {
  const m = /命中拒绝规则\s+(.+)$/.exec(String(reason || ""));
  return m ? flat(m[1], 80) : "";
}

/* 纯函数：证据 → 候选提案。不碰磁盘、不碰 LLM，同输入必同输出（单元测试钉这个）。 */
function candidates(opts) {
  const o = opts || {};
  const out = [];

  const byTopic = new Map();
  for (const e of o.entries || []) {
    if (!e || e.archived) continue;
    if (MEM_TYPES.indexOf(e.type) < 0) continue;
    const topic = flat(e.topic, 24);
    if (!topic) continue;
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(e);
  }
  for (const [topic, arr] of byTopic) {
    if (arr.length < MIN_REPEAT) continue;
    const desc = arr.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    out.push(pack("memory", topic, desc.map((e) => ({ text: flat(e.content, 160), ts: e.ts || 0 }))));
  }

  const groups = new Map();
  const push = (source, subject, d) => {
    const key = source + "|" + subject;
    if (!groups.has(key)) groups.set(key, { source, subject, items: [] });
    groups.get(key).items.push(d);
  };
  for (const d of o.decisions || []) {
    if (!d) continue;
    if (d.kind === "approval" && d.action === "rejected") {
      const tool = flat(d.tool, 60);
      if (tool) push("rejection", tool, d);
    } else if (d.kind === "gate" && d.action === "block") {
      const label = denyRuleLabel(d.reason);
      if (label) push("deny", label, d);
    } else if (d.kind === "hook" && d.action === "block") {
      const tool = flat(d.tool, 60);
      if (tool) push("hook", tool, d);
    }
  }
  for (const g of groups.values()) {
    if (g.items.length < MIN_REPEAT) continue;
    const desc = g.items.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    out.push(pack(g.source, g.subject, desc.map((d) => ({
      text: flat([d.tool, d.subject].filter(Boolean).join(" · "), 120), ts: d.ts || 0,
    }))));
  }

  return out.sort((a, b) => b.lastTs - a.lastTs || b.count - a.count);
}

/* 同样的证据文字排三行，读起来像渲染坏了两次。
   合并成一行带 ×N：次数本来就是这条提案的核心信息，摊成多行反而看不见。 */
function dedupeEvidence(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const text = String(r.text || "");
    const hit = by.get(text);
    if (!hit) by.set(text, { text, ts: r.ts || 0, times: 1 });
    else { hit.times++; hit.ts = Math.max(hit.ts, r.ts || 0); }
  }
  return [...by.values()]
    .sort((a, b) => b.ts - a.ts)
    .map((x) => ({ text: x.text + (x.times > 1 ? " ×" + x.times : ""), ts: x.ts }));
}

function pack(source, subject, evidence) {
  const ev = dedupeEvidence(evidence).slice(0, MAX_EVIDENCE);
  const tsList = (evidence || []).map((e) => e.ts || 0);
  return {
    key: source + "|" + subject,
    source,
    title: COPY[source].title(subject),
    statement: COPY[source].statement(subject, tsList.length, ev),
    evidence: ev,
    count: tsList.length,
    lastTs: Math.max.apply(null, tsList),
    firstTs: Math.min.apply(null, tsList),
  };
}

class ProposalStore {
  constructor(filePath) {
    this._path = filePath;
    this._items = [];
    this._flush = Promise.resolve();
    this._load();
  }

  /* 坏文件按空处理：提案是可再生的观测产物（下一次扫描就会重新长出来），
     不值得像记忆库那样做抢救式解析——那套 markdown 捞回的复杂度在这里没有对应收益。 */
  _load() {
    try {
      const arr = JSON.parse(fs.readFileSync(this._path, "utf8"));
      this._items = Array.isArray(arr) ? arr.filter((x) => x && x.key) : [];
    } catch (e) { this._items = []; }
  }
  /* 返回落盘 promise：账本是异步排队写的，测试与"重启后仍在"的断言要能等它收口 */
  _save() { this._flush = safeWrite.saveJson(this._path, this._items); return this._flush; }

  get(id) { return this._items.find((x) => x.id === id) || null; }

  list(opts) {
    const o = opts || {};
    let pool = this._items.slice();
    if (o.status) pool = pool.filter((x) => x.status === o.status);
    if (o.source) pool = pool.filter((x) => x.source === o.source);
    return pool.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).slice(0, o.limit || 100);
  }

  counts() {
    const c = { pending: 0, adopted: 0, dismissed: 0, total: this._items.length };
    for (const x of this._items) if (c[x.status] != null) c[x.status]++;
    return c;
  }

  /* 用本轮扫出的候选刷新一遍：
     · 新证据 → 建 pending
     · 已有（任何状态）→ 只刷证据与次数，状态绝不回翻（用户说过「忽略」的不能再冒出来催）
     · pending 且本轮没扫到 → 下架；adopted/dismissed 留痕
     返回新增条数，供调用方（和测试）判断这一轮到底长出了什么。 */
  sync(list) {
    const now = Date.now();
    const seen = new Set();
    let added = 0;
    for (const cand of list || []) {
      seen.add(cand.key);
      const hit = this._items.find((x) => x.key === cand.key);
      if (hit) {
        Object.assign(hit, cand, { updatedAt: now });
        continue;
      }
      this._items.push(Object.assign({}, cand, {
        id: idOf(cand.key), key: cand.key, status: "pending", createdAt: now, updatedAt: now,
      }));
      added++;
    }
    this._items = this._items.filter((x) => seen.has(x.key) || x.status !== "pending");
    if (this._items.length > MAX_KEEP) {
      this._items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      this._items = this._items.slice(0, MAX_KEEP);
    }
    this._save();
    return added;
  }

  setStatus(id, status, extra) {
    if (STATUS.indexOf(status) < 0) return null;
    const hit = this.get(id);
    if (!hit) return null;
    hit.status = status;
    hit.decidedAt = Date.now();
    hit.updatedAt = hit.decidedAt;
    if (extra && typeof extra === "object") Object.assign(hit, extra);
    this._save();
    return hit;
  }

  get size() { return this._items.length; }
}

module.exports = {
  ProposalStore, candidates, denyRuleLabel, idOf, flat,
  MIN_REPEAT, MAX_EVIDENCE, MAX_KEEP, STATUS, SRC_LABEL, MEM_TYPES,
};
