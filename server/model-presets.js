/* ============================================================
   模型上下文窗口预设表
   ------------------------------------------------------------
   动因（实测）：
     配置里 contextWindow 写的是 128000，而 agnes-3.0-flash 的真实窗口是
     512K —— 只用了 1/4。于是压缩触发线 thresholdTokens 被压到 102400，
     实际每轮涨 3000~8000 tokens，12~34 轮就触顶压缩。体感就是
     "问两个问题就要满了"。

     换模型后这个数不会自己变（设置里「模型 ID」与「上下文窗口」是两个
     独立输入框），于是用户每换一个模型就要重新踩一遍这个坑。

   为什么需要这张表：
     上游 /v1/models 不返回窗口元数据（实测 apihub.agnes-ai.cn 返回的
     9 个模型都没有 context 字段），所以只能靠本地这张表带出来。
     记不准的模型允许手改 —— 这里的值只是"默认值"，不是硬约束。

   数值口径：各模型的**输入+输出共享窗口**（与上游报错的
   "maximum context length" 同一口径）。压缩阈值还会再扣掉输出预留
   与 headroom，所以实际能塞进历史的消息比这里的数略小。
   ============================================================ */
"use strict";

/* 窗口单位：token。按「模型 id 子串 → 窗口」匹配，命中第一条即止。
   顺序即优先级：更具体的模式排在前面（"agnes-3.0" 要在 "agnes" 之前）。 */
const PRESETS = [
  // —— 本机在用 ——
  { match: "agnes-3.0-flash", contextWindow: 524288, note: "Agnes 3.0 Flash · 512K" },
  { match: "agnes-3.0", contextWindow: 524288, note: "Agnes 3.0 系列 · 512K" },
  { match: "agnes-2.5", contextWindow: 262144, note: "Agnes 2.5 · 256K" },

  // —— 常见长上下文模型 ——
  { match: "gpt-5", contextWindow: 400000, note: "GPT-5 · 400K" },
  { match: "gpt-4.1", contextWindow: 1047576, note: "GPT-4.1 · 1M" },
  { match: "gpt-4o", contextWindow: 128000, note: "GPT-4o · 128K" },
  { match: "o3", contextWindow: 200000, note: "o3 · 200K" },
  { match: "o1", contextWindow: 200000, note: "o1 · 200K" },
  { match: "claude-opus-4", contextWindow: 200000, note: "Claude Opus 4 · 200K" },
  { match: "claude-sonnet-4", contextWindow: 200000, note: "Claude Sonnet 4 · 200K" },
  { match: "claude-3-7", contextWindow: 200000, note: "Claude 3.7 · 200K" },
  { match: "claude-3-5", contextWindow: 200000, note: "Claude 3.5 · 200K" },
  { match: "claude", contextWindow: 200000, note: "Claude · 200K" },
  { match: "deepseek", contextWindow: 131072, note: "DeepSeek · 128K" },
  { match: "qwen3", contextWindow: 131072, note: "Qwen3 · 128K" },
  { match: "qwen", contextWindow: 131072, note: "Qwen · 128K" },
  { match: "kimi", contextWindow: 262144, note: "Kimi · 256K" },
  { match: "moonshot", contextWindow: 131072, note: "Moonshot · 128K" },
  { match: "glm-4.6", contextWindow: 200000, note: "GLM-4.6 · 200K" },
  { match: "glm", contextWindow: 128000, note: "GLM · 128K" },
  { match: "minimax", contextWindow: 1000000, note: "MiniMax · 1M" },
  { match: "gemini-2.5", contextWindow: 1048576, note: "Gemini 2.5 · 1M" },
  { match: "gemini", contextWindow: 1048576, note: "Gemini · 1M" },
  { match: "llama-3.1", contextWindow: 131072, note: "Llama 3.1 · 128K" },
  { match: "grok", contextWindow: 131072, note: "Grok · 128K" },
  { match: "doubao", contextWindow: 256000, note: "Doubao · 256K" },
];

/* 兜底：没命中任何预设、也没探测到时用哪个数。
   和 config.js 出厂的 llm.contextWindow 必须是同一个数 —— 前端的"这个窗口用户没动过"
   判据（换模型时自动带出预设值）靠两者相等才成立，改一处不改另一处会让那条自动带出失效。
   256K 是当下接入面（Agnes/Kimi/Doubao 一档）的常见量级；配小了只是早压缩（不报错），
   配大了才会撞上游 400，所以命中预设表的模型一律以预设为准，探测得到的也以探测为准。 */
const DEFAULT_CONTEXT_WINDOW = 256000;

/* 按模型 id 猜窗口。命中返回 { contextWindow, note, matched }，
   没命中返回 { contextWindow: DEFAULT, note: "", matched: false }。 */
function presetFor(model) {
  const m = String(model || "").toLowerCase();
  for (const p of PRESETS) {
    if (m.indexOf(p.match.toLowerCase()) >= 0) {
      return { contextWindow: p.contextWindow, note: p.note, matched: true };
    }
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, note: "", matched: false };
}

/* 完整预设表（给前端下拉用） */
function listPresets() {
  return PRESETS.map((p) => ({ match: p.match, contextWindow: p.contextWindow, note: p.note }));
}

module.exports = { presetFor, listPresets, PRESETS, DEFAULT_CONTEXT_WINDOW };
