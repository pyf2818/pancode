"use strict";
/* ============================================================
   Anthropic Messages API 原生适配层（W20）
   ------------------------------------------------------------
   为什么要原生：OpenAI 兼容网关转译 Anthropic 会丢三样东西——
   thinking 增量、tool_use 的分块流式、以及 prompt caching 的
   cache_control 断点（省钱大头，稳定前缀必须显式打点）。
   这里实现与 server/llm.js 完全同契约的 chatStream：

     入参：cfg / messages(OpenAI 格式) / tools(OpenAI 格式) / cb / attemptOrOpts
     返回：{ content, reasoning, toolCalls:[{id,name,arguments}], finish, usage }

   协议要点（Anthropic Messages streaming）：
     · system 是顶级字段（可带 cache_control 断点），不进 messages
     · assistant 的 tool_calls → tool_use 块（input 是对象，不是字符串）
     · role:"tool" → user 消息里的 tool_result 块（连续的合并进同一条 user）
     · 流事件：message_start(usage.input) → content_block_start/delta/stop
       → message_delta(stop_reason + usage.output) → message_stop
       · delta 类型：text_delta / thinking_delta / input_json_delta(tool 参数分片)
     · 工具与系统都打 cache_control 断点（1.1 计费下命中 5 折、写 1.25 倍，
       pancode 的前缀缓存纪律（系统块拆分、稳定前缀在前）正好吃满）

   启用方式（二选一，llm.js 顶部分发）：
     "llm": { "provider": "anthropic", "baseURL": "https://api.anthropic.com", ... }
     或 baseURL 含 anthropic.com 自动识别
   ============================================================ */
const { LlmAbortedError, sleepAbortable, parseRetryAfter } = require("./llm");

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_RETRIES = 3;

/* ---------- OpenAI → Anthropic 消息形状转换（纯函数，单测直接钉） ---------- */

/* user content: 字符串 | [{type:"text"}|{type:"image_url"}] → Anthropic 块数组 */
function userBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === "text" && p.text != null) out.push({ type: "text", text: String(p.text) });
    if (p.type === "image_url" && p.image_url && p.image_url.url) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(String(p.image_url.url));
      if (m) out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    }
  }
  return out;
}

/* messages → { system:[{type:text,...,cache_control}], messages:[...] }
   规则见文件头。连续 user 合并、连续 tool_result 合并，保证角色交替稳定。 */
function toAnthropicMessages(messages) {
  const sysTexts = [];
  const out = [];
  const lastIsUserToolResult = () => out.length && out[out.length - 1].role === "user" && out[out.length - 1]._tr;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (m.role === "system" || m.role === "developer") {
      if (m.content) sysTexts.push(String(m.content));
      continue;
    }
    if (m.role === "user") {
      const blocks = userBlocks(m.content);
      if (!blocks.length) continue;
      if (out.length && out[out.length - 1].role === "user" && !out[out.length - 1]._tr) out[out.length - 1].content.push(...blocks);
      else out.push({ role: "user", content: blocks });
      continue;
    }
    if (m.role === "assistant") {
      const blocks = [];
      const txt = typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.filter((p) => p && p.type === "text").map((p) => p.text).join("") : "";
      if (txt) blocks.push({ type: "text", text: txt });
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!tc || !tc.function) continue;
        let input = {};
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch (e) { input = {}; }
        blocks.push({ type: "tool_use", id: String(tc.id || ""), name: String(tc.function.name || ""), input });
      }
      if (blocks.length) out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: String(m.tool_call_id || ""), content: String(m.content == null ? "" : m.content) };
      if (lastIsUserToolResult()) out[out.length - 1].content.push(block);
      else out.push({ role: "user", content: [block], _tr: true });
    }
  }
  for (const m of out) delete m._tr;
  /* system 打成一个带 cache_control 断点的块：断点含它之前的全部前缀，
     pancode 的系统块本来就是"稳定在前、易变在后"，一个断点吃满稳定前缀 */
  const system = sysTexts.length ? [{ type: "text", text: sysTexts.join("\n\n"), cache_control: { type: "ephemeral" } }] : undefined;
  return { system, messages: out };
}

/* OpenAI 工具定义 → Anthropic tools；最后一个打 cache_control（断点覆盖 tools+system） */
function toAnthropicTools(tools) {
  const out = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || !t.function) continue;
    out.push({
      name: String(t.function.name || ""),
      description: String(t.function.description || ""),
      input_schema: (t.function.parameters && typeof t.function.parameters === "object")
        ? t.function.parameters : { type: "object", properties: {} },
    });
  }
  if (out.length) out[out.length - 1].cache_control = { type: "ephemeral" };
  return out;
}

/* baseURL → /v1/messages 全地址（兼容带不带 /v1 的两种写法） */
function endpointOf(baseURL) {
  const b = String(baseURL || "").replace(/\/+$/, "");
  return /\/v1$/.test(b) ? b + "/messages" : b + "/v1/messages";
}

const FINISH_MAP = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", refusal: "stop" };

/* ---------- 流式请求（与 llm.js 同契约） ---------- */
async function chatStream(cfg, messages, tools, cb, attemptOrOpts) {
  let attempt = 0, extSignal = null;
  if (typeof attemptOrOpts === "number") attempt = attemptOrOpts;
  else if (attemptOrOpts && typeof attemptOrOpts === "object") {
    attempt = attemptOrOpts.attempt || 0;
    extSignal = attemptOrOpts.signal || null;
  }
  if (extSignal && extSignal.aborted) throw new LlmAbortedError();

  const url = endpointOf(cfg.baseURL);
  const conv = toAnthropicMessages(messages);
  const aTools = toAnthropicTools(tools);
  const body = {
    model: cfg.model,
    max_tokens: Math.max(1024, Number(cfg.maxTokens) || 8192),
    stream: true,
    messages: conv.messages,
  };
  if (conv.system) body.system = conv.system;
  if (aTools.length) body.tools = aTools;
  if (cfg.temperature != null) body.temperature = cfg.temperature;
  /* W28 终审:thinking 与工具循环当前互斥 —— 启用 thinking 时带 tool_use 的下一轮
     请求必须回传上一条 assistant 的 thinking 块（toAnthropicMessages 还不保存它们），
     温度也必须省略。所以:带工具的请求一律不发 thinking;纯对话才开，且
     budget 不得 ≥ max_tokens（Anthropic 直接 400），温度一并省略。 */
  if (cfg.reasoningEffort && !aTools.length) {
    const budget = Math.min(4096, Math.max(1024, (Number(cfg.maxTokens) || 8192) - 1024));
    if (budget >= 1024 && (Number(cfg.maxTokens) || 8192) > budget) {
      body.thinking = { type: "enabled", budget_tokens: budget };
      delete body.temperature;
    }
  }

  const connectMs = Math.max(15000, Number(cfg.connectTimeout) || 60000);
  const idleMs = Math.max(5000, Number(cfg.idleTimeout) || 90000);
  const ctl = new AbortController();
  let connTimedOut = false;
  const connTimer = setTimeout(() => { connTimedOut = true; ctl.abort(); }, connectMs);
  let unlinkExt = null;
  if (extSignal) {
    const onExt = () => ctl.abort();
    extSignal.addEventListener("abort", onExt, { once: true });
    unlinkExt = () => extSignal.removeEventListener("abort", onExt);
  }

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json", "x-api-key": String(cfg.apiKey || ""), "anthropic-version": ANTHROPIC_VERSION },
        cfg.authToken ? { Authorization: "Bearer " + cfg.authToken } : {}   // 兼容 Claude Code 网关型 OAuth 入口
      ),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(connTimer);
    if (unlinkExt) unlinkExt();
    if ((extSignal && extSignal.aborted) || (e && e.name === "AbortError" && !connTimedOut)) throw new LlmAbortedError();
    throw new Error("LLM 网络错误: " + String((e && e.cause && e.cause.code) || e.message || e));
  }
  clearTimeout(connTimer);

  /* 429 / 529 overloaded：按 Retry-After 退避重试（与 llm.js 同策略，消息里保留状态码供错误分类） */
  if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
    let waitSec = parseRetryAfter(res.headers.get("retry-after"));
    if (!Number.isFinite(waitSec) || waitSec <= 0) waitSec = Math.min(30, Math.pow(2, attempt) * 3);
    waitSec = Math.min(120, Math.max(1, waitSec));
    if (cb && cb.onBackoff) cb.onBackoff({ waitSec: Math.round(waitSec), attempt: attempt + 1, maxAttempts: MAX_RETRIES });
    if (cb && cb.onReasoning) cb.onReasoning("[限流重试] 第" + (attempt + 1) + "次重试，等待" + Math.round(waitSec) + "秒…");
    const waited = await sleepAbortable(waitSec * 1000, extSignal);
    if (!waited) { if (unlinkExt) unlinkExt(); throw new LlmAbortedError(); }
    if (unlinkExt) unlinkExt();
    return chatStream(cfg, messages, tools, cb, { attempt: attempt + 1, signal: extSignal });
  }
  if (!res.ok) {
    if (unlinkExt) unlinkExt();
    const txt = await res.text().catch(() => "");
    const hint = res.status === 404 ? "（模型名或地址不对：Anthropic 地址应类似 https://api.anthropic.com，模型形如 claude-sonnet-4-5）"
      : (res.status === 401 || res.status === 403) ? "（x-api-key 不对，或该 key 没有此模型权限）" : "";
    const err = new Error("LLM 请求失败 HTTP " + res.status + hint + ": " + txt.slice(0, 400));
    err.endpoint = url;
    throw err;
  }

  /* ---------- SSE 读循环 ---------- */
  const acc = { content: "", reasoning: "", toolCalls: [], finish: null, usage: null };
  const blocks = new Map();      // index -> {type,id,name,json}
  let inTokens = 0, cacheRead = 0, cacheCreate = 0, outTokens = 0;
  let sawStop = false, streamErr = null;
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { ctl.abort(); }, idleMs);
  };

  const finishBlock = (idx) => {
    const b = blocks.get(idx);
    if (b && b.type === "tool_use") {
      acc.toolCalls.push({ id: b.id || "tu_" + idx, name: b.name || "", arguments: b.json && b.json.trim() ? b.json : "{}" });
      blocks.delete(idx);
    }
  };
  const onEvent = (name, data) => {
    armIdle();
    if (name === "message_start") {
      const u = (data.message && data.message.usage) || {};
      inTokens = Number(u.input_tokens) || 0;
      cacheRead = Number(u.cache_read_input_tokens) || 0;
      cacheCreate = Number(u.cache_creation_input_tokens) || 0;
      return;
    }
    if (name === "content_block_start") {
      const cbk = data.content_block || {};
      blocks.set(data.index, { type: cbk.type, id: cbk.id, name: cbk.name, json: "" });
      return;
    }
    if (name === "content_block_delta") {
      const d = data.delta || {};
      const b = blocks.get(data.index);
      if (d.type === "text_delta" && d.text) { acc.content += d.text; if (cb && cb.onContent) cb.onContent(d.text); }
      else if (d.type === "thinking_delta" && d.thinking) { acc.reasoning += d.thinking; if (cb && cb.onReasoning) cb.onReasoning(d.thinking); }
      else if (d.type === "input_json_delta" && b) { b.json += d.partial_json || ""; }
      else if (d.type === "signature_delta" && b) { b.signature = (b.signature || "") + (d.signature || ""); }
      return;
    }
    if (name === "content_block_stop") { finishBlock(data.index); return; }
    if (name === "message_delta") {
      if (data.delta && data.delta.stop_reason) acc.finish = FINISH_MAP[data.delta.stop_reason] || "stop";
      const u = data.usage || {};
      outTokens = Number(u.output_tokens) || outTokens;
      return;
    }
    if (name === "message_stop") { sawStop = true; return; }
    if (name === "error") { streamErr = new Error("Anthropic 流错误: " + JSON.stringify(data.error || {}).slice(0, 300)); return; }
    if (name === "ping") { return; }
  };

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf8");
    let buf = "", eventName = null;
    armIdle();   // W28 终审:首个事件到来前也可能挂死 —— header 已到但上游不发字节，与 llm.js 同契约
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("event: ")) eventName = line.slice(7).trim();
        else if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (payload !== "[DONE]") {
            try { onEvent(eventName || "data", JSON.parse(payload)); }
            catch (e) { /* 坏帧跳过，与 llm.js 同策略 */ }
          }
          eventName = null;
        } else if (line === "") { eventName = eventName; }   // 空行=事件分隔
      }
    }
    /* 收尾：没有 message_stop 的半截流不当完成（与 llm.js 的 trulyDone 纪律一致） */
    if (streamErr) throw streamErr;
    if (!sawStop) throw new Error("Anthropic 流未正常结束（无 message_stop，可能被网关掐断）");
    acc.usage = {
      prompt_tokens: inTokens + cacheRead + cacheCreate,
      completion_tokens: outTokens,
      total_tokens: inTokens + cacheRead + cacheCreate + outTokens,
      cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate,
    };
    return acc;
  } catch (e) {
    if ((extSignal && extSignal.aborted) || e instanceof LlmAbortedError) throw new LlmAbortedError();
    if (e.name === "AbortError" && !connTimedOut && !sawStop) throw new Error("Anthropic 流读取中止（空闲 " + Math.round(idleMs / 1000) + "s 或被上游断开）");
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (unlinkExt) unlinkExt();
  }
}

module.exports = { chatStream, toAnthropicMessages, toAnthropicTools, userBlocks, endpointOf, FINISH_MAP, ANTHROPIC_VERSION };
