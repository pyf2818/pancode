/* ============================================================
   pancode-cli · LLM 客户端（自包含版）
   OpenAI 兼容 /chat/completions，SSE 流式解析
   - content 增量 + reasoning 增量 + tool_calls 聚合
   - 429 自动重试（有界）+ 可中断退避 + 外部取消信号
   - 与 server/llm.js 同一套"协议终态"纪律：没拿到结束标记不算说完
   ============================================================ */
"use strict";

class LlmAbortedError extends Error {
  constructor(msg) { super(msg || "LLM 请求已被取消"); this.name = "LlmAbortedError"; this.aborted = true; }
}

function isAbortErr(e) { return !!e && (e.name === "AbortError" || /aborted|abort/i.test(String(e && e.message || e))); }

/* 退避等待可中断：干等 3~30 秒期间用户点了停止，不该等完才收场 */
function sleepAbortable(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { done(true); }, ms);
    function done(v) {
      clearTimeout(t);
      if (signal) { try { signal.removeEventListener("abort", onAbort); } catch (e) {} }
      resolve(v);
    }
    const onAbort = () => done(false);
    if (signal) {
      if (signal.aborted) return done(false);
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

const MAX_RETRIES = 3;   // 429 / 不认 stream_options 的重试上限（审查项 F11：以前声明了却没用，递归无界）

/**
 * 发起一次流式对话
 * @param {object} cfg  { baseURL, apiKey, model, temperature }
 * @param {Array}  messages  OpenAI 格式消息
 * @param {Array}  tools     OpenAI 格式工具定义
 * @param {object} cb  { onContent(text), onReasoning(text) }
 * @param {object} opts { signal, attempt } —— signal 是引擎的取消信号（停止按钮）
 * @returns {Promise<{content, reasoning, toolCalls, finish, usage}>}
 */
async function chatStream(cfg, messages, tools, cb, opts) {
  cb = cb || {};
  opts = opts || {};
  const attempt = opts.attempt || 0;
  const extSignal = opts.signal || null;
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
  let connTimer = null;
  let idleTimer = null;
  let _idleErr = null;

  /* 外部取消（停止按钮）接到本地 ctl 上。以前独立引擎建了 AbortController 却没传进来，
     "停止"只是把 running 置了个位，流照读、工具照跑（审查项 F11）。
     监听统一在下面的 finally 里摘 —— 分支上散落 unlink 迟早漏一处，
     漏的那处表现是"停止按钮偶尔没反应"。 */
  let unlinkExt = null;
  if (extSignal) {
    if (extSignal.aborted) throw new LlmAbortedError();
    const onExt = () => ctl.abort();
    extSignal.addEventListener("abort", onExt, { once: true });
    unlinkExt = () => { try { extSignal.removeEventListener("abort", onExt); } catch (e) {} };
  }

  const acc = { content: "", reasoning: "", toolCalls: [], finish: null, usage: null };
  const tcMap = new Map();
  /* 协议终态：finish_reason（业务）或 [DONE]（传输）任一即可。
     只有"两个都没等到"才是被掐断的半截 —— 半截不能当完成交付（与 server/llm.js 同一条纪律）。 */
  let sawDoneSentinel = false;
  const trulyDone = () => !!acc.finish || sawDoneSentinel;

  const handleData = (data) => {
    if (data === "[DONE]") { sawDoneSentinel = true; return; }
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
          // name 只在该 tool_call 的首个 delta 出现一次：直接覆盖，追加会拼成 "read_fileread_file"
          if (t.function.name) slot.name = t.function.name;
          if (typeof t.function.arguments === "string") slot.arguments += t.function.arguments;
          else if (t.function.arguments != null) slot.arguments += JSON.stringify(t.function.arguments);
        }
      }
    }
  };

  // 空闲超时：每次读到数据都重置；卡死超过 idleMs 判定挂起（长生成只要持续吐字不会被误杀）
  const armIdle = (reader) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      reader.cancel().catch(() => {});
      if (!_idleErr) _idleErr = new Error("LLM 流空闲超时（" + Math.round(idleMs / 1000) + "s 无数据），流可能已挂起");
    }, idleMs);
  };

  try {
    connTimer = setTimeout(() => { connTimedOut = true; ctl.abort(); }, connectMs);
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
      if (extSignal && extSignal.aborted) throw new LlmAbortedError();
      if (isAbortErr(e) && !connTimedOut) throw new LlmAbortedError();
      const isTimeout = (ctl.signal.aborted && connTimedOut) || /timeout|timed out/i.test(String(e && e.message || e));
      if (isTimeout) throw new Error("LLM 连接超时（" + (connectMs / 1000) + "s 内未收到响应）");
      throw new Error("LLM 网络错误: " + String(e && e.message || e));
    }
    clearTimeout(connTimer); connTimer = null;

    /* 429 限流重试：有界（attempt < MAX_RETRIES），退避可被停止打断。
       以前这里无条件递归、MAX_RETRIES 根本没用上 —— 上游一直回 429 就一直重投。 */
    if (res.status === 429 && attempt < MAX_RETRIES) {
      let waitSec = 3;
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) {
        const n = Number(retryAfter);
        if (Number.isFinite(n) && n > 0) waitSec = Math.min(30, n);
      }
      if (cb.onReasoning) cb.onReasoning("[限流重试] 第" + (attempt + 1) + "次，等待" + Math.round(waitSec) + "秒…");
      const waited = await sleepAbortable(waitSec * 1000, extSignal || ctl.signal);
      if (!waited) throw new LlmAbortedError();
      return chatStream(cfg, messages, tools, cb, { attempt: attempt + 1, signal: extSignal });
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      const hint = res.status === 404 ? "（地址或模型名不存在）"
        : (res.status === 401 || res.status === 403) ? "（密钥不对）"
        : res.status === 429 ? "（限流重试已达上限 " + MAX_RETRIES + " 次）"
        : res.status >= 500 ? "（服务商内部错误）" : "";
      throw new Error("LLM 请求失败 HTTP " + res.status + hint + ": " + txt.slice(0, 400));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf8");
    let buf = "";
    armIdle(reader);

    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        /* 中断排在所有"当正常完成"的分支之前：位置放错，用户点停止反而会拿到
           一份看起来完整、其实被腰斩的回复。 */
        if ((extSignal && extSignal.aborted) || (ctl.signal.aborted && !connTimedOut)) throw new LlmAbortedError();
        if (_idleErr) {
          if (trulyDone()) { if (cb.onReasoning) cb.onReasoning("[SSE 流空闲超时，收尾时已收到结束标记，按完成处理]"); break; }
          throw _idleErr;
        }
        if (trulyDone()) { if (cb.onReasoning) cb.onReasoning("[SSE 流中断，收尾时已收到结束标记，按完成处理]"); break; }
        throw new Error("SSE 流中断: " + String(e && e.message || e));
      }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const { done, value } = chunk;
      if (done) {
        if ((extSignal && extSignal.aborted) || (ctl.signal.aborted && !connTimedOut)) throw new LlmAbortedError();
        if (_idleErr) {
          if (trulyDone()) { if (cb.onReasoning) cb.onReasoning("[SSE 流空闲超时，收尾时已收到结束标记，按完成处理]"); }
          else throw _idleErr;
        }
        /* 干净读到流尽头却没有任何结束标记 = 上游把这一口掐了。
           这里必须抛：break 之后 return 的 acc 带着"形状完整的半截工具调用"，
           上层会照着它真的去执行工具（审查项 F07 在独立 CLI 上的同一形态）。 */
        if (!trulyDone()) {
          throw new Error("LLM 流提前结束：未收到 finish_reason / [DONE] 结束标记"
            + "（已收到 " + acc.content.length + " 字正文、" + tcMap.size + " 个工具调用片段），本次结果不完整");
        }
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) handleData(line.slice(5).trim());
      }
      armIdle(reader);
    }
  } finally {
    if (unlinkExt) unlinkExt();
    if (connTimer) clearTimeout(connTimer);
    if (idleTimer) clearTimeout(idleTimer);
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

module.exports = { chatStream, ping, LlmAbortedError, sleepAbortable, MAX_RETRIES };
