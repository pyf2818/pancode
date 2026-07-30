/* ============================================================
   任务计划存储 — Agent 面对复杂任务时创建计划并实时跟进

   计划结构:
     { id, title, status: "active"|"completed"|"abandoned",
       tasks: [{ id, text, status: "pending"|"in_progress"|"done"|"skipped", note }],
       ts, completedAt }

   存储: .pancode/plans/{workspaceHash}.json
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

class PlanStore {
  constructor(filePath) {
    this._path = filePath;
    this._plans = [];
    this._load();
  }

  _load() {
    try { this._plans = JSON.parse(fs.readFileSync(this._path, "utf8")) || []; } catch (e) { this._plans = []; }
  }
  _save() {
    require("./safe-write").saveJson(this._path, this._plans);
  }

  /* ---------- 创建计划（绑定会话 convId） ---------- */
  create(convId, title, taskTexts) {
    const id = "plan_" + Date.now().toString(36);
    const plan = {
      id,
      convId: convId || "default",
      title: title || "任务计划",
      status: "active",
      ts: Date.now(),
      completedAt: null,
      tasks: (taskTexts || []).map((t, i) => ({
        id: id + "_t" + i,
        text: typeof t === "string" ? t : t.text || String(t),
        status: "pending",
        note: "",
        ts: Date.now(),
      })),
    };
    this._plans.push(plan);
    this._save();
    return plan;
  }

  /* ---------- 更新任务状态 ---------- */
  updateTask(planId, taskIndex, status, note) {
    const plan = this._plans.find((p) => p.id === planId);
    if (!plan || !plan.tasks[taskIndex]) return null;
    plan.tasks[taskIndex].status = status;
    if (note !== undefined) plan.tasks[taskIndex].note = note;
    plan.tasks[taskIndex].ts = Date.now();
    // 检查是否全部完成
    if (plan.tasks.every((t) => t.status === "done" || t.status === "skipped")) {
      plan.status = "completed";
      plan.completedAt = Date.now();
    }
    this._save();
    return plan;
  }

  /* ---------- 获取当前活跃计划（按会话） ---------- */
  getActive(convId) {
    const cid = convId || "default";
    const scoped = this._plans.find((p) => p.status === "active" && p.convId === cid);
    if (scoped) return scoped;
    // 兼容旧数据：无 convId 的活跃计划首次访问时归并到当前会话
    const legacy = this._plans.find((p) => p.status === "active" && p.convId == null);
    if (legacy) { legacy.convId = cid; this._save(); return legacy; }
    return null;
  }

  /* ---------- 完成计划 ---------- */
  complete(planId) {
    const plan = this._plans.find((p) => p.id === planId);
    if (!plan) return null;
    plan.status = "completed";
    plan.completedAt = Date.now();
    plan.tasks.forEach((t) => { if (t.status === "pending" || t.status === "in_progress") t.status = "done"; });
    this._save();
    return plan;
  }

  /* ---------- 获取最近计划（按会话） ---------- */
  recent(convId, limit) {
    const cid = convId || "default";
    return this._plans
      .filter((p) => p.convId === cid || (p.convId == null && cid === "default"))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit || 5);
  }

  /* ---------- 格式化注入 LLM 上下文（按会话） ---------- */
  formatForContext(convId) {
    const active = this.getActive(convId);
    if (!active) return "";
    let text = "【当前任务计划】" + active.title + "\n";
    active.tasks.forEach((t, i) => {
      const icon = t.status === "done" ? "✅" : t.status === "in_progress" ? "🔄" : t.status === "skipped" ? "⏭️" : "⬜";
      text += (i + 1) + ". " + icon + " " + t.text;
      if (t.note) text += " (" + t.note + ")";
      text += "\n";
    });
    const done = active.tasks.filter((t) => t.status === "done").length;
    text += "进度: " + done + "/" + active.tasks.length + " 完成\n";
    return text;
  }

  get size() { return this._plans.length; }
}

module.exports = { PlanStore };
