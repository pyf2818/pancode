/* ============================================================
   自我进化系统 — 任务完成后自动提取经验教训
   1. 任务完成 → 分析执行过程 → 提取关键决策/错误/模式
   2. 写入长期记忆 → 下次类似任务时自动注入上下文
   3. 定期归类整理 → 按主题聚合经验
   ============================================================ */
"use strict";

const { isJunkPhrase } = require("./memory-store");

class EvolutionEngine {
  constructor(memoryStore) {
    this.memory = memoryStore;
  }

  /* ---------- 任务完成后：从对话历史中提取经验 ----------
     提取提示词（#31 重写）：旧版只说"提取有价值的经验，最多 5 条"，于是模型一次给 3~5 行
     不同类型，主题全靠调用方塞进来的用户原话，同一次任务的三条同主题条目一起进榜。
     现在把"能不能改变下次做法""主题必须是名词性短语""不许出现对话指代"三件事写进格式本身，
     并收口到 3 条——与手动沉淀面板（distill）同一套纪律：那边一直比自动路径严，
     而自动用得恰恰是最松的一档，这就是这批垃圾的源头。 */
  async extractLessons(llmChatFn, llmCfg, history, taskResult) {
    if (!history || history.length < 2) return [];

    // 构建分析请求
    const taskSummary = history.slice(-10).map((m) => {
      if (m.role === "user") return "用户: " + (typeof m.content === "string" ? m.content : "").slice(0, 200);
      if (m.role === "assistant") return "AI: " + (typeof m.content === "string" ? m.content : "").slice(0, 300);
      if (m.role === "tool") return "工具结果: " + (typeof m.content === "string" ? m.content : "").slice(0, 150);
      return "";
    }).filter(Boolean).join("\n");

    const prompt = `分析以下编程任务的执行过程，只提取「下次遇到同类任务会因此改变做法」的经验。
每行一条，严格用这个格式（类型在方括号里，主题与正文用全角竖线分开）：
[lesson] 主题｜正文
[pattern] 主题｜正文
[error] 主题｜正文
[decision] 主题｜正文

要求：
- 类型只能是 lesson / pattern / error / decision
- 主题 ≤12 个字的中文名词短语，例："探针数据根隔离"、"Electron 打包改名被锁"；
  严禁照抄用户的原话或问句（"启动项目"、"有没有问题"这种一律不许当主题）
- 正文 ≤150 字，陈述句，写清「什么情况 → 该怎么做 → 为什么」；
  不许出现"你/我/本次对话/刚才"这类对话指代
- 最多 3 条，宁缺毋滥；任务很简单、没有值得复用的结论时，只输出「无」

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

  /* ---------- 解析 LLM 输出的经验条目 ----------
     认两种写法：新格式 "[type] 主题｜正文"，以及旧格式 "[type] 正文"（没有竖线时主题留空，
     由 persistLessons 决定回落什么——关键是绝不回落到用户原话）。 */
  _parseLessons(text) {
    const lessons = [];
    for (const raw of String(text || "").split("\n")) {
      const line = raw.trim();
      if (!line || /^无[。.]?$/.test(line)) continue;
      const m = line.match(/^\[(lesson|pattern|error|decision)\]\s*(.+)$/i);
      if (!m) continue;
      const type = m[1].toLowerCase();
      let body = m[2].trim();
      let topic = "";
      const sep = body.search(/[｜|]/);
      if (sep > 0 && sep <= 24) {
        topic = body.slice(0, sep).replace(/^[\s《】【\[\]，。;；:]+/g, "").replace(/[\s，。;；:]+$/g, "").trim();
        body = body.slice(sep + 1).trim();
      }
      if (!body) continue;
      lessons.push({ type, topic, content: body });
      if (lessons.length >= 3) break;
    }
    return lessons;
  }

  /* ---------- 将提取的经验写入记忆 ---------- */
  persistLessons(lessons, taskTopic) {
    const saved = [];
    /* 自动沉淀一律 3 分（#31）。4 分在记忆库里等于拿到 sticky 豁免——prune() 遇 直接跳过，
       永远裁不掉；一次任务由模型自动产出的条目不该有这个待遇。"被反复确认"才升级：
       MemoryStore.add() 的重复路径取 max(旧, 新)，同一条经验第二次被提取出来时自然升到 4。 */
    const SCORE = { lesson: 3, pattern: 3, decision: 3, error: 3 };
    const seenTopic = new Set();
    for (const l of lessons || []) {
      const content = String((l && l.content) || "").trim();
      if (content.length < 20) continue;                  // "记得测试"这种一句废话不值得占长期记忆
      if (isJunkPhrase(content)) continue;                // 正文本身是问句/指令短句 → 不是经验
      const topic = String((l && l.topic) || taskTopic || "编程任务").replace(/\s+/g, " ").slice(0, 24);
      if (isJunkPhrase(topic, 1)) continue;               // 主题仍是问句/指令短句 → 弃（主题本该短，只查句式）
      if (seenTopic.has(topic)) continue;                 // 同一次任务同主题最多一条
      seenTopic.add(topic);
      const entry = this.memory.add(l.type, topic, content, {
        source: "evolution",
        valueScore: SCORE[l.type] || 2,
      });
      if (entry) saved.push(entry);
      if (saved.length >= 2) break;                       // 一次任务最多沉淀 2 条
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
