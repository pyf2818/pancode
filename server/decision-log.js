/* ============================================================
   P3-D1 可审计决策链
   与 .pancode/audit/*.log 的分工（为什么不复用那份）：
     audit 记的是"发生了什么动作"——谁写了哪个文件、跑了哪条命令，一行一句人话，
       格式已被 _verify_multiroot / root-store 等探针钉住，改不得；
     这里记的是"当时是怎么判断的"——门为什么放行/被哪条规则拦、用户批了还是拒了、
       超时算谁的决定、用户在候选方案里选了哪个、上下文为什么被压掉。
   所以它是结构化 JSONL，按 convId 能把一整局的决策顺序还原出来。
   追加写、永不抛错：这是观测面，观测面写不进去绝不能把工具链卡住。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const log = require("./logger");

let _dir = null;
function setDecisionDir(dir) { _dir = dir || null; }
function decisionDir() { return _dir; }

const today = () => new Date().toISOString().slice(0, 10);
const str = (v, n) => (v == null ? "" : String(v)).replace(/\r?\n/g, " ").slice(0, n == null ? 300 : n);

/* 一条决策。kind 决定它在界面上归到哪一栏：
   gate=权限门 / approval=用户点了什么 / choice=用户在候选方案里选了哪个 /
   grant=本会话免确认授权 / compact=上下文压缩 / mode=模式与专家切换 / hook=用户 hooks 规则。
   action 一律用固定动词表，界面按它上色，不做文本猜测。 */
const KINDS = ["gate", "approval", "choice", "grant", "compact", "mode", "hook"];
const ACTIONS = ["allow", "block", "ask", "approved", "rejected", "timeout", "picked", "cancelled",
  "granted", "kept", "compressed", "abandoned", "switched", "none"];

function normalize(rec) {
  const r = rec || {};
  return {
    ts: typeof r.ts === "number" && Number.isFinite(r.ts) ? r.ts : Date.now(),
    convId: str(r.convId || "default", 80),
    kind: KINDS.includes(r.kind) ? r.kind : "gate",
    action: ACTIONS.includes(r.action) ? r.action : "none",
    tool: str(r.tool, 60),
    subject: str(r.subject, 240),
    reason: str(r.reason, 500),
    mode: str(r.mode, 20),
    irreversible: !!r.irreversible,
    detail: typeof r.detail === "string" ? r.detail.slice(0, 500) : (r.detail == null ? "" : JSON.stringify(r.detail).slice(0, 500)),
  };
}

function fileFor(date) { return path.join(_dir, (/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today()) + ".jsonl"); }

/* 追加一条决策并回传规范化后的记录（写失败也回传，调用方拿到的顺序与界面一致）。 */
function recordDecision(rec) {
  const out = normalize(rec);
  if (!_dir) return out;
  try {
    fs.mkdirSync(_dir, { recursive: true });
    fs.appendFileSync(fileFor(today()), JSON.stringify(out) + "\n");
  } catch (e) {
    // 观测面失败只告警：绝不能因为日志写不进去就把工具链/审批门卡住
    log.tag("decision").warn("写入失败: " + e.message);
  }
  return out;
}

/* 读某一天的决策（默认今天）。半行（崩溃时截断的最后一行）跳过而不是让整份读不出来。 */
function readDecisions(opts) {
  opts = opts || {};
  if (!_dir) return [];
  const f = fileFor(opts.date || today());
  let raw = "";
  try { raw = fs.readFileSync(f, "utf8"); } catch (e) { return []; }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (opts.convId && String(r.convId) !== String(opts.convId)) continue;
      if (opts.kind && r.kind !== opts.kind) continue;
      rows.push(r);
    } catch (e) { /* 半行/脏数据：丢掉这一条，其余照旧 */ }
  }
  const limit = Math.max(1, Math.min(2000, opts.limit || 300));
  return rows.length > limit ? rows.slice(-limit) : rows;
}

function decisionDates() {
  if (!_dir) return [];
  try {
    return fs.readdirSync(_dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map((f) => f.replace(/\.jsonl$/, "")).sort().reverse();
  } catch (e) { return []; }
}

module.exports = { setDecisionDir, decisionDir, recordDecision, readDecisions, decisionDates, normalize, KINDS, ACTIONS };
