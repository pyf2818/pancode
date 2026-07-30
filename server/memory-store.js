/* ============================================================
   长期记忆系统 — 结构化存储 + 检索 + 自动淘汰
   记忆条目：{ id, type, topic, content, ts, accessCount }
   类型：preference / lesson / pattern / decision / error / skill
   存储：.pancode/memory/{workspaceHash}.json
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const TYPES = new Set(["preference", "lesson", "pattern", "decision", "error", "skill"]);
const MAX_ENTRIES = 200;

class MemoryStore {
  constructor(filePath) {
    this._path = filePath;
    this._entries = [];
    this._load();
  }

  /* ---------- 持久化 ---------- */
  _load() {
    try { this._entries = JSON.parse(fs.readFileSync(this._path, "utf8")); } catch (e) { this._entries = []; }
  }
  _save() {
    require("./safe-write").saveJson(this._path, this._entries);
  }

  /* ---------- 写入 ---------- */
  add(type, topic, content, meta) {
    if (!content || !content.trim()) return null;
    if (!TYPES.has(type)) type = "lesson";
    // 去重：同 topic + 同 content 前 80 字符不重复存
    const dup = this._entries.find(
      (e) => e.topic === topic && e.content.slice(0, 80) === content.trim().slice(0, 80)
    );
    if (dup) { dup.ts = Date.now(); dup.accessCount = (dup.accessCount || 0) + 1; this._save(); return dup; }
    const id = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const entry = { id, type, topic: topic || "", content: content.trim(), ts: Date.now(), accessCount: 0 };
    if (meta && typeof meta === "object") Object.assign(entry, meta);
    this._entries.push(entry);
    // 自动淘汰：超过上限时删除最老 + 最少访问的条目
    if (this._entries.length > MAX_ENTRIES) {
      this._entries.sort((a, b) => (a.accessCount - b.accessCount) || (a.ts - b.ts));
      this._entries = this._entries.slice(-MAX_ENTRIES);
    }
    this._save();
    return entry;
  }

  /* ---------- 检索（关键词匹配 + 类型过滤 + 时间加权） ---------- */
  search(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 10;
    const type = opts.type || null;
    const keywords = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!keywords.length) return this._recent(limit, type);

    let pool = this._entries;
    if (type) pool = pool.filter((e) => e.type === type);

    const scored = pool.map((e) => {
      const text = (e.topic + " " + e.content).toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) score += 2;
        if (e.topic.toLowerCase().includes(kw)) score += 3; // topic 命中权重更高
      }
      // 时间衰减：越近越高
      const age = (Date.now() - e.ts) / (1000 * 60 * 60 * 24);
      score *= Math.max(0.3, 1 - age / 180);
      // 访问次数加权
      score += Math.min(e.accessCount || 0, 5) * 0.5;
      return { entry: e, score };
    }).filter((s) => s.score > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => { s.entry.accessCount = (s.entry.accessCount || 0) + 1; return s.entry; });
  }

  _recent(limit, type) {
    let pool = this._entries;
    if (type) pool = pool.filter((e) => e.type === type);
    return pool.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  /* ---------- 查询 ---------- */
  list(opts) {
    opts = opts || {};
    let pool = this._entries;
    if (opts.type) pool = pool.filter((e) => e.type === opts.type);
    return pool.sort((a, b) => b.ts - a.ts).slice(0, opts.limit || 50);
  }

  getById(id) { return this._entries.find((e) => e.id === id) || null; }

  /* ---------- 删除 / 清理 ---------- */
  remove(id) {
    const idx = this._entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this._entries.splice(idx, 1);
    this._save();
    return true;
  }

  clear(type) {
    if (type) this._entries = this._entries.filter((e) => e.type !== type);
    else this._entries = [];
    this._save();
  }

  /* ---------- 格式化输出（注入到 LLM 上下文） ---------- */
  formatForContext(maxChars) {
    maxChars = maxChars || 3000;
    const recent = this._recent(20);
    if (!recent.length) return "";
    const lines = recent.map((e) => {
      const age = Math.floor((Date.now() - e.ts) / (1000 * 60 * 60 * 24));
      const ageStr = age === 0 ? "今天" : age + "天前";
      return "- [" + e.type + "] " + (e.topic ? e.topic + "：" : "") + e.content.slice(0, 200) + " (" + ageStr + ")";
    });
    let out = lines.join("\n");
    if (out.length > maxChars) out = out.slice(0, maxChars) + "\n...";
    return out;
  }

  get size() { return this._entries.length; }
}

module.exports = { MemoryStore, TYPES };
