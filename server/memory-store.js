/* ============================================================
   长期记忆系统 — 结构化存储 + 检索 + 衰减裁剪
   记忆条目：{ id, type, topic, content, ts, accessCount, lastAccessAt, valueScore, source, archived }
   类型：preference / lesson / pattern / decision / error / skill
   衰减模型：有效强度 = valueScore × 遗忘曲线 R（Ebbinghaus 简化版，半衰期随访问次数增长）
   裁剪策略：prune() 主动淘汰低强度条目（软归档 → 二次确认删除），高价值/归纳产物 sticky 豁免
   存储：.pancode/memory/{workspaceHash}.json
   ============================================================ */
"use strict";
const fs = require("fs");
const log = require("./logger");
const path = require("path");

const TYPES = new Set(["preference", "lesson", "pattern", "decision", "error", "skill"]);
const MAX_ENTRIES = 200;

/* 遗忘曲线：R = exp(-ageDays / stabilityDays)，稳定度随访问次数与价值增长 */
function decayWeight(e) {
  const vs = e.valueScore != null ? e.valueScore : 2;        // 旧数据无价值分按 2（中等）兜底
  const base = 7 * (1 + Math.min(e.accessCount || 0, 8));    // 半衰期 7~63 天（被反复引用的记忆记得牢）
  const stability = base * (vs >= 4 ? 2 : 1);                // 高价值条目半衰期翻倍
  const anchor = e.lastAccessAt || e.ts || Date.now();       // 用最后访问时间做锚点，杜绝 update/去重刷 ts 逃避老化
  const ageDays = Math.max(0, (Date.now() - anchor) / 86400000);
  return vs * Math.exp(-ageDays / stability);
}

/* 一次性对话特征：疑问句、纯指令短句、招呼语。
   这类文本既不该当记忆正文，更不该当主题名——主题名会原样出现在溯源卡上，
   用户看到的就满屏是"启动项目""项目有没有问题"，像它把每句话都记了一遍。
   写入端（evolution / auto memory / 主题命名）三家共用这一把尺子，别再各写一份。
   minLen 可覆盖那条"太短即垃圾"的地板：主题名本来就该短（≤12 字的名词短语，
   "打包降级""探针数据根"都是合法主题），只有正文才用默认 6 字地板。 */
function isJunkPhrase(s, minLen) {
  const t = String(s || "").trim();
  if (!t || t.length < (minLen == null ? 6 : minLen)) return true;
  if (/[？?]\s*$/.test(t) || /吗[。.!！~～]?\s*$/.test(t)) return true;
  if (/^(为什么|怎么|如何|是否|能不能|可不可以|怎样|咋|哪些|哪个)/.test(t)) return true;
  if (/(有没有|是不是|行不行|对不对|可不可以|怎么样了|可以吗|在哪)/.test(t)) return true;
  if (/^(继续|你好|启动项目|测试一下|开始吧|好的|嗯|行|再来|重来|停|提交)$/i.test(t)) return true;
  return false;
}

/* 未访问过的非 sticky 条目按类型 TTL（天）：错误易过时，偏好较持久 */
const TYPE_TTL = { error: 60, preference: 180, lesson: 90, pattern: 90, decision: 90, skill: 90 };
/* 注入侧的三道降噪闸（#31）：强度地板、同主题限量、每类的取用上限。
   地板从 1 提到 1.5 是配合写入端"自动沉淀一律给 3 分"一起设计的：
   新写入的记忆要活到 3 分被反复确认过才会长期占上下文，一次性闲聊会自己滑出去。 */
const CTX_MIN_STRENGTH = 1.5;
const CTX_MAX_PER_TOPIC = 2;
/* 高价值 / 归纳产物 / 显式 sticky 条目豁免主动裁剪（仍会被 200 上限挤出） */
function isSticky(e) { return e.sticky === true || e.source === "consolidate" || (e.valueScore || 0) >= 4; }

/* ============================================================
   判断层口径（记忆不再每轮摊开）
   ------------------------------------------------------------
   常驻的只有两样，而且都必须进 stable 桶（字节随本轮输入抖的东西不配叫常驻）：
     ① 硬提醒：被用户/规则否过的做法、方案权衡、写成禁忌的偏好 —— 少量、短。
        这一道不是"方便"，是补"模型不知道自己不知道"那个洞：上一局被否掉的方案，
        这一局如果全靠模型自己去查，它就会原样再提一遍。
     ② 索引：一行一条，只给钩子和 #id，正文一律不进上下文。
        要不要看全文是模型的判断，判据是这条索引行；取用走 search_memory。
   ------------------------------------------------------------
   预算按这份库实测定的：80 条（未归档 39 条）、正文合计 8564 字、平均 107 字/条。
   旧口径最坏每轮自动带 3800 字正文，其中大部分与本轮无关。
   ============================================================ */
const GUARD_MAX = 4;
const GUARD_MAX_CHARS = 300;
const IDX_MAX_LINES = 40;
const IDX_MAX_CHARS = 1500;
const IDX_HOOK_CHARS = 44;
/* 只有这两个"类别 + 主题"的组合算硬提醒。别按 type 整类放行：
   type=error 里混着自动沉淀的普通踩坑，那些进索引就够，天天占着上下文是噪声。 */
const GUARD_KEYS = [["error", "被拒操作/反例"], ["decision", "方案权衡"]];
const TABOO_RE = /(不要|不得|禁止|不许|不准|别|从不|避免|never|don'?t)/i;

/* 判据只写这一处：注入端、索引去重、记忆面板"为什么这条常驻"共用同一把尺子 */
function isGuardEntry(e) {
  if (!e || e.archived) return false;
  for (const [t, topic] of GUARD_KEYS) if (e.type === t && e.topic === topic) return true;
  return e.type === "preference" && TABOO_RE.test(String(e.topic || "") + " " + String(e.content || ""));
}

class MemoryStore {
  constructor(filePath) {
    this._path = filePath;
    this._entries = [];
    this._load();
    this.prune();   // 启动即裁剪一次：低强度记忆随进程重启自然消退（衰减机制的落地入口）
  }

  /* ---------- 持久化 ---------- */
  _load() {
    try {
      this._entries = JSON.parse(fs.readFileSync(this._path, "utf8"));
      if (!Array.isArray(this._entries)) throw new Error("not-an-array");
    } catch (e) {
      // 文件损坏（历史上「沉淀」曾往 JSON 追加 markdown 导致整库被静默清零）：
      // 先把坏文件留证备份，再尝试从 markdown 行里捞回可读内容，绝不无声丢数据。
      this._entries = this._rescueCorrupt();
    }
  }
  _rescueCorrupt() {
    let raw = "";
    try { raw = fs.readFileSync(this._path, "utf8"); } catch (e) { return []; }
    try {
      const bak = this._path + ".corrupt-" + Date.now() + ".bak";
      fs.writeFileSync(bak, raw, "utf8");
      log.tag("memory").warn("记忆库 JSON 损坏，已备份为 " + bak);
    } catch (e) {}
    const out = [];
    for (const line of raw.split("\n")) {
      const m = line.match(/^- \*\*(.+?)\*\*（(.+?)）：(.+)$/);   // 旧版沉淀写坏的 markdown 行
      if (!m) continue;
      const content = m[3].trim();
      if (!content || out.some((x) => x.content === content)) continue;
      out.push({
        id: "rescued-" + out.length, type: "decision", topic: m[1], content,
        ts: Date.parse(m[2] + "T12:00:00") || Date.now(), lastAccessAt: Date.now(),
        accessCount: 1, valueScore: 5, source: "sediment", sticky: true,
      });
    }
    return out;
  }
  _save() {
    require("./safe-write").saveJson(this._path, this._entries);
  }

  /* 记忆被真正读进上下文 = 一次访问信号：加强它（半衰期随访问次数增长），
     让"常被用上的记忆"活得更久、"从来没人看"的更快衰减。 */
  touch(id) {
    const e = this._entries.find((x) => x.id === id);
    if (!e) return false;
    e.accessCount = (e.accessCount || 0) + 1;
    e.lastAccessAt = Date.now();
    this._save();
    return true;
  }

  /* 批量复习：一次任务注入十来条，逐条 touch 就是逐条全量重写 JSON（N 次落盘）。
     合成一次：省 IO，且同一轮的复习时间戳一致，溯源卡上才看得出"这批是一起进的"。 */
  touchMany(ids) {
    let n = 0;
    for (const id of ids || []) {
      const e = this._entries.find((x) => x.id === id);
      if (!e) continue;
      e.accessCount = (e.accessCount || 0) + 1;
      e.lastAccessAt = Date.now();
      n++;
    }
    if (n) this._save();
    return n;
  }

  /* ---------- 写入 ---------- */
  add(type, topic, content, meta) {
    if (!content || !content.trim()) return null;
    if (!TYPES.has(type)) type = "lesson";
    const clean = content.trim();
    // 精确去重：同 topic + 同 content 前 80 字符 → 强化而非新建
    const dup = this._entries.find(
      (e) => e.topic === topic && e.content.slice(0, 80) === clean.slice(0, 80)
    );
    if (dup) {
      dup.accessCount = (dup.accessCount || 0) + 1;
      dup.lastAccessAt = Date.now();
      // 再次提及视为价值信号：取最高分
      const vs = (meta && meta.valueScore) || dup.valueScore;
      if (vs != null) dup.valueScore = Math.max(dup.valueScore || 2, vs);
      this._save();
      return dup;
    }
    // 模糊去重：同 topic 下词元 Jaccard ≥ 0.5 的既有条目 → 合并（保留双方表述，避免近似记忆堆叠）
    const tokens = this._tokenizeText(clean);
    const near = this._entries.find((e) =>
      e.topic === topic && this._jaccard(tokens, this._tokenizeText(e.content)) >= 0.5
    );
    if (near) {
      const seen = this._tokenizeText(near.content);
      const extra = clean.split(/[\s，。；：,;:、！？()\[\]{}「」"'`]+/).filter((w) => w && !seen.has(w));
      near.content = (near.content + "；" + extra.join("；")).slice(0, 400);
      near.accessCount = (near.accessCount || 0) + 1;
      near.lastAccessAt = Date.now();
      const vs = (meta && meta.valueScore) || near.valueScore;
      if (vs != null) near.valueScore = Math.max(near.valueScore || 2, vs);
      this._save();
      return near;
    }
    const id = "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const entry = { id, type, topic: topic || "", content: clean, ts: Date.now(), accessCount: 0, lastAccessAt: Date.now() };
    if (meta && typeof meta === "object") Object.assign(entry, meta);
    entry.valueScore = entry.valueScore != null ? entry.valueScore : 2; // 旧调用方未传价值分按中等兜底
    this._entries.push(entry);
    // 硬上限淘汰：按有效强度排序保留，低强度条目出局
    if (this._entries.length > MAX_ENTRIES) {
      this._entries.sort((a, b) => decayWeight(a) - decayWeight(b));
      this._entries = this._entries.slice(this._entries.length - MAX_ENTRIES);
    }
    this._save();
    return entry;
  }

  /* 词元化：英文按词切、中文按 2 字滑窗切，供 Jaccard 相似度比较 */
  _tokenizeText(text) {
    const t = String(text || "").toLowerCase();
    const words = t.match(/[a-z0-9_.]{2,}/g) || [];
    const cjk = t.replace(/[a-z0-9_.\s]/g, "").match(/[一-鿿]{2}/g) || [];
    return new Set([...words, ...cjk]);
  }
  _jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    return inter / (a.size + b.size - inter);
  }

  /* ---------- 检索（关键词匹配 + 类型过滤 + 时间加权） ---------- */
  search(query, opts) {
    opts = opts || {};
    const limit = opts.limit || 10;
    const type = opts.type || null;
    const keywords = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!keywords.length) return this._recent(limit, type);

    let pool = this._entries.filter((e) => !e.archived);
    if (type) pool = pool.filter((e) => e.type === type);

    const scored = pool.map((e) => {
      const text = (e.topic + " " + e.content).toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (text.includes(kw)) score += 2;
        if (e.topic.toLowerCase().includes(kw)) score += 3; // topic 命中权重更高
      }
      // W3：hitsOnly（跨片检索用）要求至少一个关键词真命中——decayWeight 是无条件加项，
      // 不过滤会让高强度但毫不相关的条目占掉 limit 名额
      if (opts.hitsOnly && score === 0) return null;
      // 有效强度（价值 × 遗忘曲线）：关键词命中的同时，被反复引用/高价值的记忆排前
      score += decayWeight(e);
      return { entry: e, score };
    }).filter(Boolean);

    scored.sort((a, b) => b.score - a.score);
    if (opts.raw) return scored.slice(0, limit);   // W3：searchAll 用，返回 [{entry, score}] 供跨片归一排序
    const hits = scored.slice(0, limit).map((s) => s.entry);
    /* noTouch：只给"指针"的调用方（相关记忆那行只报 id，正文没进模型上下文）
       不该算一次复习。按命中就加分，等于让关键词字面撞车把记忆养成长驻——
       正是 #31 那个正反馈。真被读进来的算法见 agent-llm 收尾的 _citedMemoryIds。 */
    if (hits.length && !opts.noTouch) {
      // 命中即"复习"：刷新最后访问时刻（衰减锚点），并落盘——否则进程重启后访问记录丢失
      for (const e of hits) {
        e.accessCount = (e.accessCount || 0) + 1;
        e.lastAccessAt = Date.now();
      }
      this._save();
    }
    return hits;
  }

  _recent(limit, type) {
    let pool = this._entries.filter((e) => !e.archived);
    if (type) pool = pool.filter((e) => e.type === type);
    return pool.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  /* ---------- 查询 ---------- */
  list(opts) {
    opts = opts || {};
    let pool = this._entries;
    if (opts.type) pool = pool.filter((e) => e.type === opts.type);
    if (opts.source) pool = pool.filter((e) => e.source === opts.source);
    // archived 默认排除（与注入端同口径）；传 "all" 看全部，传 true 只看归档
    if (opts.archived === "all") { /* 不过滤 */ }
    else if (opts.archived === true) pool = pool.filter((e) => !!e.archived);
    else pool = pool.filter((e) => !e.archived);
    if (opts.sticky !== undefined) pool = pool.filter((e) => !!e.sticky === !!opts.sticky);
    return pool.sort((a, b) => b.ts - a.ts).slice(0, opts.limit || 50);
  }

  getById(id) { return this._entries.find((e) => e.id === id) || null; }

  /* 面板用：暴露内部有效强度（遗忘曲线 × 价值分），让"哪条快被忘了"是看得见的 */
  static strength(entry) { return decayWeight(entry); }
  static ttlOf(type) { return TYPE_TTL[type] || 90; }

  /* ---------- 编辑 ---------- */
  update(id, patch) {
    const e = this._entries.find((x) => x.id === id);
    if (!e) return null;
    if (patch.topic !== undefined) e.topic = String(patch.topic).trim();
    if (patch.content !== undefined) e.content = String(patch.content).trim();
    if (patch.type && TYPES.has(patch.type)) e.type = patch.type;
    if (patch.archived !== undefined) e.archived = !!patch.archived;
    if (patch.sticky !== undefined) e.sticky = !!patch.sticky;
    if (patch.valueScore !== undefined) e.valueScore = Math.max(1, Math.min(5, Number(patch.valueScore) || 2));
    e.ts = Date.now();
    this._save();
    return e;
  }

  /* ---------- 衰减裁剪：主动淘汰低强度条目（替代"只在超 200 条上限时才删"） ----------
     规则（sticky 条目豁免，只被硬上限挤出，不主动删除）：
     1) 有效强度 < 0.5 → 直接删除（价值低且已充分遗忘）
     2) 有效强度 < 1.5 且从未被访问（accessCount=0）且超过类型 TTL → 直接删除
     3) 其余低强度（< 2.5）条目 → 标记 archived（注入/检索排除，暂不删除，二次确认后再清）
     返回本次删除条数，供调用方 emit 摘要。 */
  prune() {
    let removed = 0, archived = 0;
    for (const e of this._entries) {
      if (isSticky(e)) continue;
      const w = decayWeight(e);
      const anchor = e.lastAccessAt || e.ts;
      const ageDays = (Date.now() - anchor) / 86400000;
      const ttl = TYPE_TTL[e.type] || 90;
      if (w < 0.5 || (w < 1.5 && (e.accessCount || 0) === 0 && ageDays > ttl)) {
        this.remove(e.id);
        removed++;
      } else if (w < 2.5 && !e.archived) {
        e.archived = true;
        archived++;
      }
    }
    if (removed || archived) this._save();
    return { removed, archived };
  }

  /* 清除归档标记的条目（二次确认：被标记后仍存活超过一轮的任务收口才真正删除） */
  purgeArchived() {
    const before = this._entries.length;
    this._entries = this._entries.filter((e) => !e.archived);
    const removed = before - this._entries.length;
    if (removed) this._save();
    return removed;
  }

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

  /* ---------- 选条（#31 的降噪闸 + P6 的判断层） ----------
     记忆最容易自伤的地方是"越存越像噪音"：旧实现只看遗忘曲线强度、且固定取满 10 条，
     于是同一主题连着三条一起进榜、跟本轮问题八竿子不着的高强度条目也进榜，
     用户读到的就是"它记了一堆我当初随口说的话"。

     两道闸留着：强度地板（低于它连索引都不上）与同主题限量（防霸榜）。
     分道口径改了：不再按"本轮问什么"挑正文注入，而是
       · guard（常驻提醒）= 被否过的做法 / 方案权衡 / 写成禁忌的偏好，只给正文；
       · index（索引）= 其余全部，只给一行目录和 #id，正文由模型自己调 search_memory 取。
     所以选条不再看本轮输入——常驻的东西如果每轮内容不一样，前缀缓存就白做了，
     而"这轮该看哪条"已经交给模型（索引行 + search_memory），不在这里判。 */
  _isStableEntry(e) {
    return e.type === "preference" || e.source === "consolidate" || e.source === "sediment" || e.sticky === true;
  }

  _ctxCandidates() {
    const out = [];
    for (const e of this._entries) {
      if (e.archived) continue;
      const w = decayWeight(e);
      if (w < CTX_MIN_STRENGTH) continue;
      out.push({ e, w, stable: this._isStableEntry(e) });
    }
    return out;
  }

  /* 排序：有效强度为主，长期资产（偏好/归纳产物/sticky）略优先；同主题最多 CTX_MAX_PER_TOPIC 条。
     ×3 是去掉恒为 1 的旧相关性权重后按等比例留下的，改它会改选条结果。 */
  _ctxPick(cands, n) {
    const list = cands.slice().sort((a, b) =>
      (b.w * 3 + (b.stable ? 0.5 : 0)) - (a.w * 3 + (a.stable ? 0.5 : 0)));
    const perTopic = new Map();
    const out = [];
    for (const x of list) {
      const key = x.e.topic || "(无主题)";
      if ((perTopic.get(key) || 0) >= CTX_MAX_PER_TOPIC) continue;
      perTopic.set(key, (perTopic.get(key) || 0) + 1);
      out.push(x.e);
      if (out.length >= n) break;
    }
    return out;
  }

  _formatLines(entries, maxChars) {
    if (!entries.length) return "";
    const lines = entries.map((e) => {
      const w = decayWeight(e);
      const tier = w >= 4 ? "高" : "中";
      const age = Math.floor((Date.now() - (e.lastAccessAt || e.ts)) / (1000 * 60 * 60 * 24));
      const ageStr = age === 0 ? "今天" : age + "天前";
      return "- (" + tier + ") [" + e.type + "] " + (e.topic ? e.topic + "：" : "") + e.content.slice(0, 160) + " (" + ageStr + ")";
    });
    let out = lines.join("\n");
    if (maxChars && out.length > maxChars) out = out.slice(0, maxChars) + "\n...";
    return out;
  }

  /* ---------- 判断层的两块：硬提醒 + 索引（正文不在此列） ----------
     旧的 stableForContext / relevantForContext / formatStable / formatRelevant /
     topForContext / formatForContext 一并撤掉：正文一旦有现成的取回口，
     "每轮自动摊开"就会从那个口回来。常驻只剩下面两条。 */
  guardForContext(n) {
    return this._ctxPick(this._ctxCandidates().filter((x) => isGuardEntry(x.e)), n || GUARD_MAX);
  }

  formatGuard(maxChars) {
    return this._formatLines(this.guardForContext(), maxChars || GUARD_MAX_CHARS);
  }

  /* 索引里不重复列已经常驻的那几条 */
  indexForContext(n) {
    const guard = new Set(this.guardForContext(999).map((e) => e.id));
    return this._ctxPick(this._ctxCandidates().filter((x) => !guard.has(x.e.id)), n || IDX_MAX_LINES);
  }

  /* 一行一条：#id + 类型 + 主题 + 钩子。给 id 是为了让"取这一条"变成一次精确调用，
     而不是让模型去猜关键词——猜错就查不到，查不到就等于没这条记忆。 */
  formatIndex(maxChars) {
    const list = this.indexForContext();
    if (!list.length) return "";
    const budget = maxChars || IDX_MAX_CHARS;
    const lines = [];
    let used = 0;
    for (const e of list) {
      const topic = String(e.topic || "").replace(/\s+/g, " ").trim().slice(0, 18);
      const hook = String(e.content || "").replace(/\s+/g, " ").trim().slice(0, IDX_HOOK_CHARS);
      const line = "- #" + e.id + " [" + e.type + "]" + (topic ? " " + topic + "：" : "") + hook;
      if (used + line.length > budget) break;
      used += line.length;
      lines.push(line);
    }
    const hidden = list.length - lines.length;
    if (hidden > 0) lines.push("- …另有 " + hidden + " 条未列出，用 search_memory 按关键词取");
    return lines.join("\n");
  }

  /* 按 id 精确取正文（search_memory 的 ids 入口）。归档条目也算命中但要点明它已归档，
     否则模型会拿一条被治理掉的旧结论当现行约定用。 */
  findByIds(ids) {
    const want = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x || "").trim().replace(/^#/, "")).filter(Boolean);
    const out = [];
    for (const id of want) {
      const e = this._entries.find((x) => x.id === id);
      if (e) out.push(e);
    }
    return out;
  }

  get size() { return this._entries.length; }

  /* ---------- W3：跨工作区 / 用户级检索（只读） ----------
     items: [{ path, label }] —— 各记忆分片（{wsHash}.json）与用户级（user.json）。
     关键约束：绝不能 new MemoryStore(p)——构造会 prune() 触发别的分片裁剪写盘（P0 数据破坏）。
     用 Object.create 绕构造惰性读入，并遮蔽 _save 为 no-op（search 的"命中即复习"不落盘，
     跨区检索不改变任何分片状态）；当前活动分片由调用方用内存实例补查（含未落盘更新）。 */
  static searchAll(items, query, opts) {
    opts = opts || {};
    const limit = opts.limit || 12;
    const perStore = opts.perStore || 5;
    const merged = [];
    for (const it of items || []) {
      if (!it || !it.path) continue;
      let entries;
      try { entries = JSON.parse(fs.readFileSync(it.path, "utf8")); } catch (e) { continue; }   // 坏分片跳过
      if (!Array.isArray(entries) || !entries.length) continue;
      const tmp = Object.create(MemoryStore.prototype);
      tmp._path = it.path;
      tmp._entries = entries;
      tmp._save = () => {};   // 只读模式：复习只改内存对象，不写回任何文件
      for (const { entry, score } of tmp.search(query, { type: opts.type, limit: perStore, raw: true, hitsOnly: true })) {
        entry.__score = score;
        entry.__src = it.label || path.basename(it.path, ".json");
        merged.push(entry);
      }
    }
    merged.sort((a, b) => b.__score - a.__score);
    return merged.slice(0, limit);
  }
}

module.exports = { MemoryStore, TYPES, decayWeight, isSticky, isJunkPhrase, isGuardEntry,
  GUARD_MAX_CHARS, IDX_MAX_CHARS };
