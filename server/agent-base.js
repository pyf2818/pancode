/* ============================================================
   pancode Agent 基类 —— LLM 引擎与演示引擎的共享原语
   think / say / tool 卡片 / 状态机 / 文件变更与改动推送
   ============================================================ */
"use strict";
const { langOf } = require("./files");

const FAST = process.env.AGENT_FAST === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? 0 : ms));

function diffStat(oldStr, newStr) {
  /* 两侧都先归一成 LF 再切行：base 是从磁盘/Git 读回来的原文（Windows 上是 CRLF），
     编辑器与 Agent 写的是 LF —— 直接 split("\n") 会让每一行都不相等，
     实测 4 行真改动被算成 +1287 −1287。前端 public/js/utils.js 里那份是同一把尺子，同步过。 */
  const cut = (s) => String(s).replace(/\r\n/g, "\n").split("\n");
  const cnt = (arr) => { const m = {}; arr.forEach((l) => (m[l] = (m[l] || 0) + 1)); return m; };
  const A = cnt(cut(oldStr)), B = cnt(cut(newStr));
  let add = 0, del = 0;
  for (const l in B) { const d = B[l] - (A[l] || 0); if (d > 0) add += d; }
  for (const l in A) { const d = A[l] - (B[l] || 0); if (d > 0) del += d; }
  return { add, del };
}

class AgentBase {
  constructor(ctx) {
    this.emit = ctx.emit;        // 广播
    this.files = ctx.files;      // FileStore（当前工作区）
    this.roots = ctx.roots || null;  // 多根解析：路径属于哪个已授权根（老 ctx 没有就是 null，退回单根行为）
    this.git = ctx.git;          // GitLayer
    this.term = ctx.term;        // TerminalLayer
    /* 任务计划原先只挂在 LlmAgent 上，于是没配 API Key 的装机（开箱就是演示引擎）里
       engine.plan 是 undefined：/api/plans 恒回"引擎未就绪"、计划面板永远空白。
       计划是"项目级"资产（index.js 按工作区建一份跨用户共享），跟引擎是不是真 LLM 无关。 */
    this.plan = ctx.sharedPlan || null;
    this.running = false;
    this.round = 0;
    this.seq = 0;
  }

  id() { return "e" + Date.now().toString(36) + (++this.seq); }

  /* ---------- 流式思考（演示引擎打字机；LLM 引擎直接透传增量） ---------- */
  thinkStart() {
    const id = this.id();
    /* round 与 tool.start 同口径：前端按轮次把思考/工具步骤收进同一个可折叠轮组 */
    this.emit({ type: "think.start", id, round: this.round });
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
    /* 这一步到底有没有产生可撤销的检查点，不看"工具名字表"而看撤销栈真的长没长：
       名字与写盘的对应关系散在好几个 handler 里（edit_files 整批只推一个检查点、
       只读工具一个都不推、被拒绝规则拦下时也不推），任何一份前端名字表都会先漂。
       栈深差值是唯一不会说谎的判据。 */
    const depth0 = (this._undoStack || []).length;
    this.emit({ type: "tool.start", id, kind, name, target, round: this.round });
    return {
      body: (text) => this.emit({ type: "tool.body", id, text: String(text).slice(0, 8000) }),
      /* 截图通道：只发"图在会话截图目录里的相对路径"，字节由前端向 /api/shot 取。
         不走工具结果正文，是因为 role:"tool" 的内容只能装字符串 —— 像素进不了模型，
         而这图本来就是给人看的证据，不该按 token 计价。 */
      image: (rel) => this.emit({ type: "tool.image", id, path: String(rel || "").slice(0, 300) }),
      done: (ok, label, open) => this.emit({
        type: "tool.end", id, ok, label, open: !!open,
        /* 只看栈长没长，不再叠一个 "&& ok"：检查点既然压进去了就有东西要撤，
           工具在写完之后才失败（批量编辑改到一半）时把按钮藏掉才是问题。
           什么都没写的失败自然栈深不变，也就不会有按钮。 */
        undoable: (this._undoStack || []).length > depth0,
      }),
    };
  }

  state(running, label) {
    this.running = running;
    /* 默认状态语由前端按当前界面语言渲染（labelKey）；调用方给了自定义 label 才照发。
       否则服务端写死的"AI 空闲"会把英文界面钉回中文。 */
    this.emit({
      type: "agent.state", running,
      label: label || null,
      labelKey: label ? null : (running ? "running" : "aiIdle"),
    });
  }

  /* 单个文件内容变化 → 推给前端 */
  async fileChanged(rel) {
    let content = null;
    try { content = this.files.read(rel); } catch (e) { /* 已删除 */ }
    const base = await this.git.baseline(rel);
    this.emit({
      type: "file.changed", path: rel,
      content, deleted: content === null,
      original: base === null ? "" : base,
      isNew: base === null,
      lang: langOf(rel),
    });
  }

  /* 全量改动列表（基于 Git/快照基线） → 推给前端，并附每个文件的改动风险分。

     这条以前是 8 小时任务的隐形杀手：每个改盘类工具跑完都调一次，而它对**全部累计脏文件**
     逐个 `git show HEAD:<path>`（实测 126ms/次）+ 读全文 + 评分，串行。50 个脏文件 × 200 次
     工具调用 = 一万次子进程、二十多分钟纯等待，而且成本随任务时长线性涨 —— 表现就是"越跑越慢、
     最后像卡死"。现在：① 并发跑（上限 8，不至于把 git 压垮）；② 按"内容长度 + mtime"缓存每个
     文件的结果，只重算这次真被碰过的那几个；③ 脏文件集合一变或缓存超过 15 秒就整体重算一次，
     所以外部改文件、终端里 commit 最多迟到 15 秒，不会永远看不见。 */
  async pushChanges(card, hintPaths) {
    const risk = require("./risk");
    const changed = await this.git.changes();
    const now = Date.now();
    if (!this._chCache) this._chCache = new Map();
    if (now - (this._chCacheAt || 0) > 15000) this._chCache.clear();
    this._chCacheAt = now;
    const seen = new Set(changed.map((c) => c.path));
    for (const k of Array.from(this._chCache.keys())) if (!seen.has(k)) this._chCache.delete(k);
    const need = new Set(Array.isArray(hintPaths) ? hintPaths.filter(Boolean) : []);

    const one = async (ch) => {
      let stamp = "gone";
      try {
        const s = require("fs").statSync(this.files.safePath(ch.path));
        stamp = s.size + ":" + Math.round(s.mtimeMs);
      } catch (e) { /* 文件被删了就是 gone */ }
      const hit = this._chCache.get(ch.path);
      if (hit && hit.stamp === stamp && !need.has(ch.path)) return hit.entry;
      let cur = "", base = await this.git.baseline(ch.path);
      if (ch.status !== "D") { try { cur = this.files.read(ch.path); } catch (e) { return null; } }
      const st = diffStat(base === null ? "" : base, cur);
      const entry = { path: ch.path, status: ch.status, add: st.add, del: st.del, base: base === null ? "" : base, cur };
      this._chCache.set(ch.path, { stamp, entry });
      return entry;
    };
    /* 小并发：串行是 N×126ms，全并发会把 git 子进程一次拉满，8 是够用的折中。
       结果按下标回填而不是 push —— 并发完成顺序不定，列表顺序要跟着 git 的口径走。 */
    const pre = new Array(changed.length).fill(null);
    let next = 0;
    const worker = async () => { while (next < changed.length) { const i = next++; pre[i] = await one(changed[i]); } };
    await Promise.all(Array.from({ length: Math.min(8, changed.length) }, worker));
    const hasTestTouch = pre.some((p) => p && /\.(test|spec)\.[jt]sx?$|(^|\/)(tests?|__tests__|spec)\//i.test(p.path));
    const list = [], risks = [];
    for (const p of pre) {
      if (!p) continue;
      const r = risk.assess({
        path: p.path, base: p.base, cur: p.cur, add: p.add, del: p.del, status: p.status,
        changedFiles: changed.length, hasTestTouch,
      });
      risks.push(r);
      list.push({ path: p.path, status: p.status, add: p.add, del: p.del, risk: r.level, riskScore: r.score, riskReasons: r.reasons });
    }
    const riskSummary = risk.summarize(risks);
    this._lastRiskSummary = riskSummary;
    this.convRisk = this.convRisk || {};
    const _cid = this._convIdNow();
    this.convRisk[_cid] = riskSummary;
    this.emit({ type: "changes", list, card: !!card, risk: riskSummary, convId: _cid });
    return list;
  }

  /* 当前会话 id。真实引擎（LlmAgent）的工具跑在 AsyncLocalStorage 里，会覆写此方法
     取"正在执行的那条会话"；基类/演示引擎没有并行，引擎级 _currentConv 就是真相。
     pushChanges 这类深层路径必须走这个口径 —— 多会话并行时 this._currentConv 是前台那条，
     会把 A 会话的改动归属到 B 头上（风险摘要错桶 + changes 事件错会话）。 */
  _convIdNow() { return this._currentConv || "default"; }

  /* 工具审批：基类默认无操作（真实 LLM 引擎 LlmAgent 覆写以支持人工确认） */
  resolveApproval() { return false; }

  /* W27 · 对话 rewind 的基类实现（演示引擎用）：演示引擎没有可截断的持久历史，
     "重跑"就是按原文再发一遍（round 已 >0 时 demo 引擎会走复核分支，真实跑测试）。 */
  async rewindAndRun(text, opts) {
    const o = opts || {};
    return this.handleChat(text, { convId: o.convId });
  }
}

module.exports = { AgentBase, diffStat, sleep, FAST };
