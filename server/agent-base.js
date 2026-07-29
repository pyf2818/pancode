/* ============================================================
   pancode Agent 基类 —— LLM 引擎与演示引擎的共享原语
   think / say / tool 卡片 / 状态机 / 文件变更与改动推送
   ============================================================ */
"use strict";
const { langOf } = require("./files");

const FAST = process.env.AGENT_FAST === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? 0 : ms));

function diffStat(oldStr, newStr) {
  const cnt = (arr) => { const m = {}; arr.forEach((l) => (m[l] = (m[l] || 0) + 1)); return m; };
  const A = cnt(String(oldStr).split("\n")), B = cnt(String(newStr).split("\n"));
  let add = 0, del = 0;
  for (const l in B) { const d = B[l] - (A[l] || 0); if (d > 0) add += d; }
  for (const l in A) { const d = A[l] - (B[l] || 0); if (d > 0) del += d; }
  return { add, del };
}

class AgentBase {
  constructor(ctx) {
    this.emit = ctx.emit;        // 广播
    this.files = ctx.files;      // FileStore
    this.git = ctx.git;          // GitLayer
    this.term = ctx.term;        // TerminalLayer
    this.running = false;
    this.round = 0;
    this.seq = 0;
  }

  id() { return "e" + Date.now().toString(36) + (++this.seq); }

  /* ---------- 流式思考（演示引擎打字机；LLM 引擎直接透传增量） ---------- */
  thinkStart() {
    const id = this.id();
    this.emit({ type: "think.start", id });
    return {
      delta: (text) => this.emit({ type: "think.delta", id, text }),
      end: () => this.emit({ type: "think.end", id }),
    };
  }
  async think(text) {
    const t = this.thinkStart();
    for (let i = 0; i < text.length; i += 4) { t.delta(text.slice(i, i + 4)); await sleep(14); }
    t.end();
  }

  msgStart() {
    const id = this.id();
    this.emit({ type: "msg.start", id });
    return {
      delta: (text) => this.emit({ type: "msg.delta", id, text }),
      end: () => this.emit({ type: "msg.end", id }),
    };
  }
  async say(text) {
    const m = this.msgStart();
    for (let i = 0; i < text.length; i += 3) { m.delta(text.slice(i, i + 3)); await sleep(16); }
    m.end();
  }

  tool(kind, name, target) {
    const id = this.id();
    this.emit({ type: "tool.start", id, kind, name, target });
    return {
      body: (text) => this.emit({ type: "tool.body", id, text: String(text).slice(0, 8000) }),
      done: (ok, label, open) => this.emit({ type: "tool.end", id, ok, label, open: !!open }),
    };
  }

  state(running, label) {
    this.running = running;
    this.emit({ type: "agent.state", running, label: label || (running ? "AI 运行中" : "AI 空闲") });
  }

  /* 单个文件内容变化 → 推给前端 */
  fileChanged(rel) {
    let content = null;
    try { content = this.files.read(rel); } catch (e) { /* 已删除 */ }
    const base = this.git.baseline(rel);
    this.emit({
      type: "file.changed", path: rel,
      content, deleted: content === null,
      original: base === null ? "" : base,
      isNew: base === null,
      lang: langOf(rel),
    });
  }

  /* 全量改动列表（基于 Git/快照基线） → 推给前端 */
  pushChanges(card) {
    const list = [];
    for (const ch of this.git.changes()) {
      let cur = "", base = this.git.baseline(ch.path);
      if (ch.status !== "D") { try { cur = this.files.read(ch.path); } catch (e) { continue; } }
      const st = diffStat(base === null ? "" : base, cur);
      list.push({ path: ch.path, status: ch.status, add: st.add, del: st.del });
    }
    this.emit({ type: "changes", list, card: !!card });
    return list;
  }

  /* 工具审批：基类默认无操作（真实 LLM 引擎 LlmAgent 覆写以支持人工确认） */
  resolveApproval() { return false; }
}

module.exports = { AgentBase, diffStat, sleep, FAST };
