/* ============================================================
   pancode-cli · LLM 客户端（自包含版）
   OpenAI 兼容 /chat/completions，SSE 流式解析
   - content 增量 + reasoning 增量 + tool_calls 聚合
   - 429 自动重试 + 指数退避
   ============================================================ */
"use strict";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class LlmAbortedError extends Error {
  constructor(msg) { super(msg || "LLM 请求已被取消"); this.name = "LlmAbortedError"; this.aborted = true; }
}

function isAbortErr(e) { return !!e && (e.name === "AbortError" || /aborted|abort/i.test(String(e.message || ""))); }

/**
 * 发起一次流式对话
 * @param {object} cfg  { baseURL, apiKey, model, temperature }
 * @param {Array}  messages  OpenAI 格式消息
 * @param {Array}  tools     OpenAI 格式工具定义
 * @param {object} cb  { onContent(text), onReasoning(text) }
 * @returns {Promise<{content, reasoning, toolCalls, finish, usage}>}
 */
async function chatStream(cfg, messages, tools, cb) {
  cb = cb || {};
  const MAX_RETRIES = 3;
  const url = cfg.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    temperature: cfg.temperature != null ? cfg.temperature : 0.2,
  };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }

  const connectMs = 60000;
  const idleMs = 90000;
  const ctl = new AbortController();
  let connTimedOut = false;
  const connTimer = setTimeout(() => { connTimedOut = true; ctl.abort(); }, connectMs);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json" },
        cfg.apiKey ? { "Authorization": "Bearer " + cfg.apiKey } : {}
      ),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(connTimer);
    if (isAbortErr(e) && !connTimedOut) throw new LlmAbortedError();
    const isTimeout = (ctl.signal.aborted && connTimedOut) || /timeout|timed out/i.test(String(e && e.message || e));
    if (isTimeout) throw new Error("LLM 连接超时（" + (connectMs / 1000) + "s 内未收到响应）");
    throw new Error("LLM 网络错误: " + String(e && e.message || e));
  }
  clearTimeout(connTimer);

  /* 429 限流重试 */
  if (res.status === 429) {
    let waitSec = 3;
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) {
      const n = Number(retryAfter);
      if (Number.isFinite(n) && n > 0) waitSec = Math.min(30, n);
    }
    if (cb.onReasoning) cb.onReasoning("[限流重试] 等待" + Math.round(waitSec) + "秒…");
    await sleep(waitSec * 1000);
    return chatStream(cfg, messages, tools, cb);
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const hint = res.status === 404 ? "（地址或模型名不存在）"
      : (res.status === 401 || res.status === 403) ? "（密钥不对）"
      : res.status >= 500 ? "（服务商内部错误）" : "";
    throw new Error("LLM 请求失败 HTTP " + res.status + hint + ": " + txt.slice(0, 400));
  }

  const acc = { content: "", reasoning: "", toolCalls: [], finish: null, usage: null };
  const tcMap = new Map();
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf8");
  let buf = "";

  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { reader.cancel().catch(() => {}); }, idleMs);
  };
  armIdle();

  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (isAbortErr(e)) throw new LlmAbortedError();
        if (acc.finish) break;
        throw new Error("SSE 流中断: " + String(e && e.message || e));
      }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const { done, value } = chunk;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) handleData(line.slice(5).trim());
      }
      armIdle();
    }
  } finally {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function handleData(data) {
    if (data === "[DONE]") return;
    let j;
    try { j = JSON.parse(data); } catch (e) { return; }
    const choice = j.choices && j.choices[0];
    if (!choice) {
      if (j && j.usage) acc.usage = j.usage;
      return;
    }
    const delta = choice.delta || {};
    if (choice.finish_reason) acc.finish = choice.finish_reason;
    if (j.usage) acc.usage = j.usage;

    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning) { acc.reasoning += reasoning; if (cb.onReasoning) cb.onReasoning(reasoning); }

    if (delta.content) { acc.content += delta.content; if (cb.onContent) cb.onContent(delta.content); }

    if (Array.isArray(delta.tool_calls)) {
      for (const t of delta.tool_calls) {
        const idx = t.index || 0;
        if (!tcMap.has(idx)) tcMap.set(idx, { id: "", name: "", arguments: "" });
        const slot = tcMap.get(idx);
        if (t.id) slot.id = t.id;
        if (t.function) {
          if (t.function.name) slot.name = t.function.name;
          if (typeof t.function.arguments === "string") slot.arguments += t.function.arguments;
          else if (t.function.arguments != null) slot.arguments += JSON.stringify(t.function.arguments);
        }
      }
    }
  }

  acc.toolCalls = Array.from(tcMap.keys()).sort((a, b) => a - b).map((k) => tcMap.get(k));
  return acc;
}

/* 快速连通性检查 */
async function ping(cfg) {
  const r = await chatStream(
    Object.assign({}, cfg, { temperature: 0 }),
    [{ role: "user", content: "reply with: ok" }],
    null, null
  );
  return { ok: true, sample: r.content.slice(0, 60) };
}

module.exports = { chatStream, ping, LlmAbortedError };
