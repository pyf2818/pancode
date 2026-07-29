/* ============================================================
   pancode LLM 客户端 —— OpenAI 兼容 /chat/completions
   - 原生 fetch（Node ≥ 18），零第三方依赖
   - SSE 流式解析：content 增量 + reasoning 增量 + tool_calls 聚合
   - 兼容 OpenAI / DeepSeek / Moonshot / 通义 / vLLM / Ollama 等网关
   - 429 自动重试 + 指数退避
   ============================================================ */
"use strict";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 发起一次流式对话。
 * @param {object} cfg  { baseURL, apiKey, model, temperature }
 * @param {Array}  messages  OpenAI 格式消息
 * @param {Array}  tools     OpenAI 格式工具定义
 * @param {object} cb  { onContent(text), onReasoning(text) }
 * @param {number} attempt  当前重试次数（内部用）
 * @returns {Promise<{content, reasoning, toolCalls:[{id,name,arguments}], finish}>}
 */
async function chatStream(cfg, messages, tools, cb, attempt) {
  attempt = attempt || 0;
  const MAX_RETRIES = 3;
  const url = cfg.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    temperature: cfg.temperature,
  };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + cfg.apiKey,
    },
    body: JSON.stringify(body),
  });

  // 429 限流自动重试（指数退避）
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = res.headers.get("retry-after");
    const waitSec = retryAfter ? parseInt(retryAfter) : Math.min(30, Math.pow(2, attempt) * 3);
    if (cb && cb.onReasoning) cb.onReasoning("[限流重试] 第" + (attempt + 1) + "次重试，等待" + waitSec + "秒…");
    await sleep(waitSec * 1000);
    return chatStream(cfg, messages, tools, cb, attempt + 1);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("LLM 请求失败 HTTP " + res.status + ": " + txt.slice(0, 400));
  }

  const acc = { content: "", reasoning: "", toolCalls: [], finish: null };
  const tcMap = new Map(); // index -> {id, name, arguments}

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf8");
  let buf = "";

  const handleData = (data) => {
    if (data === "[DONE]") return;
    let j;
    try { j = JSON.parse(data); } catch (e) { return; }
    const choice = j.choices && j.choices[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (choice.finish_reason) acc.finish = choice.finish_reason;

    // 推理内容（DeepSeek-R1 / o 系列风格字段兼容）
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning) { acc.reasoning += reasoning; if (cb && cb.onReasoning) cb.onReasoning(reasoning); }

    if (delta.content) { acc.content += delta.content; if (cb && cb.onContent) cb.onContent(delta.content); }

    if (Array.isArray(delta.tool_calls)) {
      for (const t of delta.tool_calls) {
        const idx = t.index || 0;
        if (!tcMap.has(idx)) tcMap.set(idx, { id: "", name: "", arguments: "" });
        const slot = tcMap.get(idx);
        if (t.id) slot.id = t.id;
        if (t.function && t.function.name) slot.name += t.function.name;
        if (t.function && typeof t.function.arguments === "string") slot.arguments += t.function.arguments;
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) handleData(line.slice(5).trim());
    }
  }

  acc.toolCalls = Array.from(tcMap.keys()).sort((a, b) => a - b).map((k) => tcMap.get(k));
  return acc;
}

/* 快速连通性检查（供设置面板"测试连接"用） */
async function ping(cfg) {
  const r = await chatStream(
    Object.assign({}, cfg, { temperature: 0 }),
    [{ role: "user", content: "reply with: ok" }],
    null, null
  );
  return { ok: true, sample: r.content.slice(0, 60) };
}

module.exports = { chatStream, ping };
