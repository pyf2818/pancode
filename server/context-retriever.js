/* ============================================================
   上下文检索器 — 从历史任务中智能提取相关上下文
   不再全量注入 history，而是按相关性检索：
   1. 关键词提取 → 文件片段检索
   2. 历史任务摘要 → 相关经验注入
   3. 仓库结构 → 相关模块聚焦
   ============================================================ */
"use strict";

class ContextRetriever {
  constructor(memoryStore, files) {
    this.memory = memoryStore;
    this.files = files;
  }

  /* ---------- 从用户消息中提取关键词 ---------- */
  extractKeywords(text) {
    if (!text) return [];
    // 去掉常见停用词，提取有意义的词
    const stopWords = new Set([
      "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个", "上", "也",
      "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好", "自己", "这", "他",
      "请", "帮", "帮忙", "一下", "可以", "吗", "呢", "把", "被", "让", "给", "从", "用", "以",
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
      "may", "might", "can", "shall", "need", "must",
      "it", "its", "this", "that", "these", "those", "i", "you", "he", "she", "we", "they",
      "and", "or", "but", "not", "no", "if", "then", "else", "when", "where", "how", "what",
      "which", "who", "whom", "why", "all", "each", "every", "both", "few", "more", "most",
      "some", "any", "in", "on", "at", "to", "for", "of", "with", "by", "from", "as",
    ]);
    return text
      .replace(/@(file|folder):[^\s]+/g, "") // 去掉 @file/@folder 引用
      .split(/[\s,.;:!?\-_/\\(){}[\]"']+/)
      .map((w) => w.toLowerCase().trim())
      .filter((w) => w.length >= 2 && !stopWords.has(w))
      .filter((w, i, arr) => arr.indexOf(w) === i); // 去重
  }

  /* ---------- 从文件列表中检索相关文件 ---------- */
  findRelatedFiles(keywords, maxFiles) {
    maxFiles = maxFiles || 8;
    if (!keywords.length || !this.files) return [];

    const allFiles = this.files.list();
    const scored = allFiles.map((f) => {
      const name = f.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (name.includes(kw)) score += 3;
      }
      // 优先源码文件
      if (/\.(js|ts|jsx|tsx|py|go|rs|java|css|html|vue|svelte)$/i.test(f)) score += 1;
      // 优先配置文件
      if (/package\.json|tsconfig|\.env|docker/i.test(f)) score += 0.5;
      return { path: f, score };
    }).filter((s) => s.score > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxFiles).map((s) => s.path);
  }

  /* ---------- 构建智能上下文注入（替代全量 history 注入） ---------- */
  buildSmartContext(userText, opts) {
    opts = opts || {};
    const parts = [];
    const keywords = this.extractKeywords(userText);

    // 1. 相关文件摘要（不超过 4000 字符）
    if (keywords.length) {
      const related = this.findRelatedFiles(keywords, 5);
      if (related.length) {
        const snippets = [];
        for (const f of related) {
          try {
            const content = this.files.read(f);
            const lines = content.split("\n");
            // 取前 30 行作为摘要
            snippets.push("=== " + f + " (" + lines.length + " 行) ===\n" + lines.slice(0, 30).join("\n"));
          } catch (e) {}
        }
        if (snippets.length) {
          const text = snippets.join("\n\n");
          parts.push("【相关文件摘要】\n" + text.slice(0, 4000));
        }
      }
    }

    // 2. 相关记忆：只给指针，正文一律不摊进上下文（P6：模型自己判断要不要取）
    // 排序仍按「关键词命中 + 价值/新鲜度」，因为它给的是索引给不出的信息——
    // 【记忆索引】按有效强度排，这一行按"本轮这句话像哪几条"排，模型据此决定查不查。
    // 排除硬提醒那几条（它们的正文已经在上下文里了），并带 noTouch：
    // 只是把 id 列出来不算用过，加分会养出"关键词撞车 → 长期常驻"的正反馈。
    if (this.memory && keywords.length) {
      const guardIds = new Set(this.memory.guardForContext ? this.memory.guardForContext(999).map((e) => e.id) : []);
      let memories = this.memory.search(keywords.join(" "), { limit: 12, noTouch: true })
        .filter((m) => !m.archived && !guardIds.has(m.id));
      memories = this.rankMemories(memories, keywords).slice(0, 4);
      if (memories.length) {
        const memText = memories.map((m) => "- #" + m.id + " [" + m.type + "] " + (m.topic || "（无主题）")).join("\n");
        parts.push("【与本轮关键词相关的记忆（只给编号，正文没写在这里）】\n"
          + memText + "\n"
          + "要读哪条就调 search_memory 把上面的 id 抄进 ids；不相关就当作没看见，别为了用上记忆而查记忆。");
      }
    }

    return parts.join("\n\n");
  }

  /* P2 语义记忆回退排序：无 embedding 端点时，用「关键词相关度 + 价值分 + 指数新鲜度」加权，
     逼近语义优先级，避免陈旧/低价值记忆排在前面（真·向量检索需 embedding API，作为后续增强）。
     新鲜度用指数函数 exp(-age/30) 替代台阶函数：30 天不再一刀切清零，越旧权重平滑下降。 */
  rankMemories(memories, keywords) {
    if (!memories || !memories.length) return [];
    const now = Date.now();
    const TYPE_WEIGHT = { lesson: 1.5, decision: 1.2, pattern: 1, preference: 0.8, error: 0.8, default: 1 };
    const kwset = new Set((keywords || []).map((k) => String(k).toLowerCase()));
    return memories.map((m) => {
      const content = String(m.content || "").toLowerCase();
      const topic = String(m.topic || "").toLowerCase();
      let rel = 0;
      for (const kw of kwset) if (content.includes(kw) || topic.includes(kw)) rel += 1;
      const ageDays = (now - (m.lastAccessAt || m.ts || now)) / (1000 * 60 * 60 * 24);
      const recency = Math.exp(-Math.max(0, ageDays) / 30);        // 30 天半衰期
      const imp = (m.valueScore != null ? m.valueScore : 2) * 0.5;  // 写入端价值分（0-6）折半参与竞争
      return { m, score: rel * 2 + recency + imp };
    }).filter((x) => x.score >= 2)   // 过滤低分条目：纯类型保底分不再让无关旧记忆进入注入
      .sort((a, b) => b.score - a.score).map((x) => x.m);
  }

  /* ---------- 从对话历史中提取任务摘要（用于 compact） ---------- */
  summarizeTask(history) {
    if (!history || !history.length) return "";
    const text = history.map((m) => {
      if (m.role === "user") return "用户: " + (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 200);
      if (m.role === "assistant") return "AI: " + (typeof m.content === "string" ? m.content : "").slice(0, 300);
      return "";
    }).filter(Boolean).join("\n");
    return text.slice(0, 1500);
  }
}

module.exports = { ContextRetriever };
