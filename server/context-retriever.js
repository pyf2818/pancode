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

    // 2. 相关记忆检索（P2 语义记忆回退：关键词召回 + 新鲜度/重要性加权重排）
    if (this.memory && keywords.length) {
      let memories = this.memory.search(keywords.join(" "), { limit: 12 });
      memories = this.rankMemories(memories, keywords).slice(0, 5);
      if (memories.length) {
        const memText = memories.map((m) => {
          const age = Math.floor((Date.now() - (m.ts || Date.now())) / (1000 * 60 * 60 * 24));
          return "- [" + m.type + "] " + (m.topic ? m.topic + "：" : "") + m.content.slice(0, 200) + (age > 0 ? " (" + age + "天前)" : "");
        }).join("\n");
        parts.push("【相关记忆】\n" + memText);
      }
    }

    return parts.join("\n\n");
  }

  /* P2 语义记忆回退排序：无 embedding 端点时，用「关键词相关度 + 新鲜度 + 重要性」加权，
     逼近语义优先级，避免陈旧/低价值记忆排在前面（真·向量检索需 embedding API，作为后续增强）。 */
  rankMemories(memories, keywords) {
    if (!memories || !memories.length) return [];
    const now = Date.now();
    const TYPE_WEIGHT = { lesson: 3, decision: 2.5, pattern: 2, preference: 1, default: 1 };
    const kwset = new Set((keywords || []).map((k) => String(k).toLowerCase()));
    return memories.map((m) => {
      const content = String(m.content || "").toLowerCase();
      const topic = String(m.topic || "").toLowerCase();
      let rel = 0;
      for (const kw of kwset) if (content.includes(kw) || topic.includes(kw)) rel += 1;
      const ageDays = (now - (m.ts || now)) / (1000 * 60 * 60 * 24);
      const recency = ageDays <= 1 ? 2 : ageDays <= 7 ? 1 : ageDays <= 30 ? 0.3 : 0;
      const imp = TYPE_WEIGHT[m.type] || TYPE_WEIGHT.default;
      return { m, score: rel * 2 + recency + imp };
    }).sort((a, b) => b.score - a.score).map((x) => x.m);
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
