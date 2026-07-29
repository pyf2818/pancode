/* ============================================================
   自我进化系统 — 任务完成后自动提取经验教训
   1. 任务完成 → 分析执行过程 → 提取关键决策/错误/模式
   2. 写入长期记忆 → 下次类似任务时自动注入上下文
   3. 定期归类整理 → 按主题聚合经验
   ============================================================ */
"use strict";

class EvolutionEngine {
  constructor(memoryStore) {
    this.memory = memoryStore;
  }

  /* ---------- 任务完成后：从对话历史中提取经验 ---------- */
  async extractLessons(llmChatFn, llmCfg, history, taskResult) {
    if (!history || history.length < 2) return [];

    // 构建分析请求
    const taskSummary = history.slice(-10).map((m) => {
      if (m.role === "user") return "用户: " + (typeof m.content === "string" ? m.content : "").slice(0, 200);
      if (m.role === "assistant") return "AI: " + (typeof m.content === "string" ? m.content : "").slice(0, 300);
      if (m.role === "tool") return "工具结果: " + (typeof m.content === "string" ? m.content : "").slice(0, 150);
      return "";
    }).filter(Boolean).join("\n");

    const prompt = `分析以下编程任务的执行过程，提取可复用的经验教训。
输出格式（每行一条，以 [类型] 开头，类型只能是 lesson/pattern/error/decision）：
[lesson] 从这次任务中学到的具体经验
[pattern] 发现的代码模式或最佳实践
[error] 遇到的错误及解决方案
[decision] 关键的技术决策及原因

要求：
- 每条不超过 150 字
- 只提取有价值的经验，不要泛泛而谈
- 最多输出 5 条
- 如果任务很简单没有特别值得记录的，输出"无"

任务执行过程：
${taskSummary}

任务结果：${taskResult || "成功完成"}`;

    try {
      const r = await llmChatFn(llmCfg, [
        { role: "system", content: "你是一个经验提取器。从编程任务执行过程中提取有价值的经验教训。只输出经验条目，不要解释。" },
        { role: "user", content: prompt },
      ]);
      return this._parseLessons(r.content || "");
    } catch (e) {
      return [];
    }
  }

  /* ---------- 解析 LLM 输出的经验条目 ---------- */
  _parseLessons(text) {
    const lessons = [];
    const lines = text.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const m = line.match(/^\[(lesson|pattern|error|decision)\]\s*(.+)$/i);
      if (m) {
        lessons.push({ type: m[1].toLowerCase(), content: m[2].trim() });
      }
    }
    return lessons;
  }

  /* ---------- 将提取的经验写入记忆 ---------- */
  persistLessons(lessons, taskTopic) {
    const saved = [];
    for (const l of lessons) {
      if (!l.content || l.content.length < 10) continue;
      const entry = this.memory.add(l.type, taskTopic || "编程任务", l.content, {
        source: "evolution",
      });
      if (entry) saved.push(entry);
    }
    return saved;
  }

  /* ---------- 完整流程：提取 + 持久化 ---------- */
  async processTaskCompletion(llmChatFn, llmCfg, history, taskTopic, taskResult) {
    const lessons = await this.extractLessons(llmChatFn, llmCfg, history, taskResult);
    const saved = this.persistLessons(lessons, taskTopic);
    return { extracted: lessons.length, saved: saved.length, lessons: saved };
  }

  /* ---------- 生成进化报告（供 UI 展示） ---------- */
  getReport() {
    const all = this.memory.list({ limit: 50 });
    const byType = {};
    for (const e of all) {
      byType[e.type] = byType[e.type] || [];
      byType[e.type].push(e);
    }
    return {
      total: all.length,
      byType: Object.keys(byType).map((type) => ({
        type,
        count: byType[type].length,
        recent: byType[type].slice(0, 3).map((e) => ({
          topic: e.topic,
          content: e.content.slice(0, 100),
          ts: e.ts,
        })),
      })),
    };
  }
}

module.exports = { EvolutionEngine };
