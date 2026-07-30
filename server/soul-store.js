/* ============================================================
   灵魂(Soul)系统 — Agent 的人格 / 价值观 / 边界 / 原则
   以及「任务完成后 Agent 自动微调提案」（待用户确认才写入）
   存储：.pancode/soul/{workspaceHash}.json
   与记忆(memory)、技能(skill) 同工作区哈希、同目录算法。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const DEFAULT_SOUL = {
  name: "pan",
  vibe: "warm",
  emoji: "🧬",
  // 价值观：Agent 做决策时优先考虑的原则
  values: [
    "真实优先：文件是唯一真相，不伪造结果、不假装执行",
    "用户掌控：危险操作先确认，尊重用户的否决权",
    "持续进化：每次任务都沉淀经验，越来越懂用户",
  ],
  // 边界：Agent 绝不做的事
  boundaries: [
    "不泄露用户的密钥、令牌等敏感信息",
    "不未经确认就执行不可逆的删除 / 强制推送",
    "不替用户做重大架构决策而不说明理由",
  ],
  // 原则：通用工作准则
  principles: [
    "先理解再动手：动手改代码前先读懂上下文",
    "小步验证：改完即测，失败就修，形成闭环",
  ],
  // 待确认提案（Agent 运行时提议的灵魂微调，需用户确认才生效）
  proposals: [],
};

class SoulStore {
  constructor(filePath) {
    this._path = filePath;
    this._data = null;
    this._load();
  }

  _load() {
    try {
      this._data = JSON.parse(fs.readFileSync(this._path, "utf8"));
    } catch (e) {
      this._data = JSON.parse(JSON.stringify(DEFAULT_SOUL));
    }
    // 补全缺省字段
    for (const k of Object.keys(DEFAULT_SOUL)) {
      if (this._data[k] === undefined) this._data[k] = JSON.parse(JSON.stringify(DEFAULT_SOUL[k]));
    }
  }

  _save() {
    require("./safe-write").saveJson(this._path, this._data);
  }

  /* ---------- 读取 ---------- */
  get() { return JSON.parse(JSON.stringify(this._data)); }

  /* ---------- 更新（手动编辑 / 确认提案后写入） ---------- */
  update(patch) {
    if (!patch || typeof patch !== "object") return this.get();
    const textFields = ["name", "vibe", "emoji"];
    for (const f of textFields) {
      if (typeof patch[f] === "string" && patch[f].trim()) this._data[f] = patch[f].trim();
    }
    for (const listField of ["values", "boundaries", "principles"]) {
      if (Array.isArray(patch[listField])) {
        this._data[listField] = patch[listField]
          .map((x) => String(x).trim())
          .filter((x) => x.length > 0);
      }
    }
    this._save();
    return this.get();
  }

  /* ---------- 提案：Agent 任务完成后提议微调 ---------- */
  addProposal(proposal) {
    if (!proposal || !proposal.content || !proposal.content.trim()) return null;
    const id = "sp" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const entry = {
      id,
      target: proposal.target || "principles", // values / boundaries / principles
      content: proposal.content.trim().slice(0, 300),
      reason: (proposal.reason || "").trim().slice(0, 300),
      ts: Date.now(),
      status: "pending", // pending | accepted | rejected
    };
    this._data.proposals.unshift(entry);
    // 只保留最近 30 条提案
    if (this._data.proposals.length > 30) this._data.proposals = this._data.proposals.slice(0, 30);
    this._save();
    return entry;
  }

  listProposals() { return this._data.proposals.slice(); }

  resolveProposal(id, accept) {
    const p = this._data.proposals.find((x) => x.id === id);
    if (!p) return null;
    p.status = accept ? "accepted" : "rejected";
    p.resolvedAt = Date.now();
    if (accept && (p.target === "values" || p.target === "boundaries" || p.target === "principles")) {
      // 接受后把内容追加进对应列表
      const list = this._data[p.target] || [];
      if (!list.includes(p.content)) list.push(p.content);
      this._data[p.target] = list;
    }
    this._save();
    return p;
  }

  get size() {
    return (this._data.values.length + this._data.boundaries.length + this._data.principles.length);
  }
}

module.exports = { SoulStore, DEFAULT_SOUL };
