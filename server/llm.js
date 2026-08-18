/* ============================================================
   pancode LLM 客户端 —— OpenAI 兼容 /chat/completions
   - 原生 fetch（Node ≥ 18），零第三方依赖
   - SSE 流式解析：content 增量 + reasoning 增量 + tool_calls 聚合
   - 兼容 OpenAI / DeepSeek / Moonshot / 通义 / vLLM / Ollama 等网关
   - 429 自动重试 + 指数退避
   ============================================================ */
"use strict";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 全局退避协调：跨并发会话共享的 429/限流退避窗口。
   任一会话命中限流都把退避窗口往后推，避免多个会话在同一时刻同时重试把网关打爆。 */
let _backoffUntil = 0;
function getBackoffUntil() { return _backoffUntil; }
function extendBackoff(ms) { _backoffUntil = Math.max(_backoffUntil, Date.now() + ms); }
async function waitBackoff() {
  const until = _backoffUntil;
  if (until > Date.now()) { await sleep(until - Date.now()); }
}

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
  // 真实 token 用量统计：主流 OpenAI 兼容网关（OpenAI / DeepSeek / Moonshot / 通义）支持
  // stream_options.include_usage；返回的最终 chunk 会携带 usage。若网关不支持该字段（400），
  // 下面的错误分支会自动去掉该字段重试一次，保证向后兼容。
  if (cfg.llm && cfg.llm.streamOptions !== false) body.stream_options = { include_usage: true };

  // 跨会话退避：若处于退避窗口内，先等窗口过期再发起，避免并发会话同时重试放大限流
  await waitBackoff();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + cfg.apiKey,
    },
    body: JSON.stringify(body),
  });

  // 429 限流自动重试（指数退避）；同步把退避窗口推向未来，跨会话共享
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = res.headers.get("retry-after");
    const waitSec = retryAfter ? parseInt(retryAfter) : Math.min(30, Math.pow(2, attempt) * 3);
    extendBackoff(waitSec * 1000 + 500);
    if (cb && cb.onReasoning) cb.onReasoning("[限流重试] 第" + (attempt + 1) + "次重试，等待" + waitSec + "秒…");
    await sleep(waitSec * 1000);
    return chatStream(cfg, messages, tools, cb, attempt + 1);
  }

  // 部分网关不支持 stream_options → 去掉该字段重试一次（保持兼容）
  if (res.status === 400 && /stream_options/i.test(await res.text().catch(() => "")) && body.stream_options && attempt < MAX_RETRIES) {
    delete body.stream_options;
    return chatStream(cfg, messages, tools, cb, attempt + 1);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("LLM 请求失败 HTTP " + res.status + ": " + txt.slice(0, 400));
  }

  const acc = { content: "", reasoning: "", toolCalls: [], finish: null, usage: null };
  const tcMap = new Map(); // index -> {id, name, arguments}

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf8");
  let buf = "";

  const handleData = (data) => {
    if (data === "[DONE]") return;
    let j;
    try { j = JSON.parse(data); } catch (e) { return; }
    const choice = j.choices && j.choices[0];
    if (!choice) {
      // OpenAI 流式用量通常在 choices 为空的尾包里携带 usage
      if (j && j.usage) acc.usage = j.usage;
      return;
    }
    const delta = choice.delta || {};
    if (choice.finish_reason) acc.finish = choice.finish_reason;
    if (j.usage) acc.usage = j.usage;

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
        if (t.function) {
          if (t.function.name) slot.name += t.function.name;
          // arguments 可能以字符串分片流式到达；个别网关也可能直接给对象，统一转为字符串累积
          if (typeof t.function.arguments === "string") slot.arguments += t.function.arguments;
          else if (t.function.arguments != null) slot.arguments += JSON.stringify(t.function.arguments);
        }
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

module.exports = { chatStream, ping, getBackoffUntil, extendBackoff };
