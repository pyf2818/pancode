/* ============================================================
   pancode LLM 客户端 —— OpenAI 兼容 /chat/completions
   - 原生 fetch（Node ≥ 18），零第三方依赖
   - SSE 流式解析：content 增量 + reasoning 增量 + tool_calls 聚合
   - 兼容 OpenAI / DeepSeek / Moonshot / 通义 / vLLM / Ollama 等网关
   - 429 自动重试 + 指数退避
   ============================================================ */
"use strict";
const log = require("./logger");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 可中断的等待：用户点停止时，正在退避的 30 秒不该把停止按钮的响应也一起拖住。
   abort 后 resolve(false)，调用方据此判断"没等完就别继续了"。 */
function sleepAbortable(ms, signal) {
  if (!signal) return sleep(ms).then(() => true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(true); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(false); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/* retry-after → 秒。支持三种上游写法：秒数、HTTP-date、小数秒。
   parseInt 遇到 "Wed, 21 Oct 2015 07:28:00 GMT" 得到 NaN，遇到 "3.5" 丢掉小数；
   这里统一转成秒，失败返回 NaN 让调用方回退到指数退避。 */
function parseRetryAfter(v) {
  if (v == null) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  const n = Number(s);
  if (Number.isFinite(n)) return n;                       // 秒 / 小数秒
  const t = Date.parse(s);                               // HTTP-date
  if (Number.isFinite(t)) return Math.max(0, (t - Date.now()) / 1000);
  return NaN;
}

/* SSE 解析失败统计（原来半截 JSON 被裸 return 静默丢弃 → "内容凭空少一段"且事后无法复盘）。
   这里补三层可观测性：每次失败落一行 warning（截断样本）、本次请求失败数随返回值带出、
   进程级累计数供 /metrics 之类的地方读。计数不清零是故意的：它是"这台机器上出过多少次"的指标。 */
const _sseParse = { total: 0, last: null };
function getSseParseStats() { return { total: _sseParse.total, last: _sseParse.last }; }

/* ============================================================
   退避协调（修 S-B4：全局单值让不相关的调用方互相拖累）
   ------------------------------------------------------------
   原来只有模块级一个 _backoffUntil，任何会话/任何模型命中限流都会把
   窗口推后，其他所有人一起等 —— 而限流通常是**按模型或按 API key**
   计的：A 模型被限流不该让正在用 B 模型的人陪着停。

   改成按"端点 + 模型"分桶，桶内仍然全局共享（同一把钥匙的并发请求
   一起退避才是我们要的），桶间互不影响。
   + 没有退避的桶要能被回收，否则长时间运行会攒出无限多个桶。
   ============================================================ */
const _backoffBuckets = new Map();     // key -> { until, at }
const BACKOFF_BUCKET_TTL_MS = 5 * 60 * 1000;
const BACKOFF_MAX_BUCKETS = 64;

function backoffKey(cfg) {
  const base = String((cfg && cfg.baseURL) || (cfg && cfg.llm && cfg.llm.baseURL) || "");
  const model = String((cfg && cfg.model) || (cfg && cfg.llm && cfg.llm.model) || "");
  // 端点里可能带 key（少数厂商把 key 放 path 里），入桶前先抹掉，
  // 否则 Map 的 key 会把密钥留在内存 dump 里。
  // 末尾的版本号/chat/completions 段要反复剥：/v1/chat/completions 与 /v1 是同一个桶。
  let safe = base.replace(/[?#].*$/, "").replace(/\/+$/, "");
  for (let i = 0; i < 6; i++) {
    // 每轮剥掉末尾的版本号/chat/completions 段：
    // /v1/chat/completions 与 /v1 必须归到同一个桶，否则同一把 API key 的
    // 并发请求会各退各的，等于没退。剥 6 轮足够覆盖 v1/beta/openai/chat/completions。
    const next = safe.replace(/\/(?:v\d+(?:beta\d*)?|chat|completions|api|openai|compatible-mode\/v1)$/i, "");
    if (next === safe) break;
    safe = next;
  }
  return safe.replace(/\/+$/, "") + "|" + model;
}
function _sweepBuckets(now) {
  for (const [k, b] of _backoffBuckets) {
    if (b.until <= now && now - b.at > BACKOFF_BUCKET_TTL_MS) _backoffBuckets.delete(k);
  }
}
function getBackoffUntil(cfg) {
  if (!cfg) return 0;
  const b = _backoffBuckets.get(backoffKey(cfg));
  return b ? b.until : 0;
}
function extendBackoff(ms, cfg) {
  const now = Date.now();
  _sweepBuckets(now);
  const k = backoffKey(cfg);
  const cur = _backoffBuckets.get(k);
  const until = Math.max(cur ? cur.until : 0, now + ms);
  _backoffBuckets.set(k, { until, at: now });
  while (_backoffBuckets.size > BACKOFF_MAX_BUCKETS) {
    // 淘汰最早设立的那个（最可能早就退完了）
    let oldestK = null, oldestAt = Infinity;
    for (const [kk, bb] of _backoffBuckets) {
      if (bb.at < oldestAt) { oldestAt = bb.at; oldestK = kk; }
    }
    if (oldestK == null) break;
    _backoffBuckets.delete(oldestK);
  }
  return until;
}
async function waitBackoff(signal, cfg) {
  const b = cfg ? _backoffBuckets.get(backoffKey(cfg)) : null;
  const until = b ? b.until : 0;
  if (until > Date.now()) { await sleepAbortable(until - Date.now(), signal); }
}
/* 只读诊断：桶数与各桶剩余（不泄露 key 原文以外的任何东西），给 /metrics 之类的地方用。 */
function backoffStats() {
  const now = Date.now();
  _sweepBuckets(now);
  return {
    buckets: _backoffBuckets.size,
    entries: Array.from(_backoffBuckets.entries()).map(([k, b]) => ({
      key: k, leftMs: Math.max(0, b.until - now)
    }))
  };
}

/* 中断信号：chatStream 的最后一个参数 opts 携带。
   以前 AbortController 只管连接阶段（响应头一到就 clearTimeout），流开始后 ctl.signal
   全仓再没有 abort 调用方 —— 用户点停止，正在跑的那次生成必然跑完，token 白烧。
   现在 ctl 活到整个流结束：opts.signal 一进来就挂 abort 监听，读循环每轮先看它。 */
function isAbortErr(e) { return !!e && (e.name === "AbortError" || /aborted|abort/i.test(String(e.message || ""))); }

/* 中断专用的错误类型：靠它把"用户主动停止"与"网络/超时故障"分开 ——
   前者不该弹错误卡、不该进重试、该静默收场；后者一切照旧。 */
class LlmAbortedError extends Error {
  constructor(msg) { super(msg || "LLM 请求已被取消"); this.name = "LlmAbortedError"; this.aborted = true; }
}

/**
 * 发起一次流式对话。
 * @param {object} cfg  { baseURL, apiKey, model, temperature }
 * @param {Array}  messages  OpenAI 格式消息
 * @param {Array}  tools     OpenAI 格式工具定义
 * @param {object} cb  { onContent(text), onReasoning(text), onBackoff({waitSec,attempt,maxAttempts}) }
 * @param {number|object} attemptOrOpts  内部重试次数；也可用 { attempt, signal } 形式传中断信号
 * @returns {Promise<{content, reasoning, toolCalls:[{id,name,arguments}], finish}>}
 */
/* 把实际请求的地址挂到错误对象上（而不是拼进 message）：设置面板要告诉用户"到底请求了哪个地址"，
   但 agent-llm 的错误分类是按 message 里的数字判定 429/401/404 的，地址里的端口号会干扰它。 */
function withEndpoint(err, url) { err.endpoint = url; return err; }

async function chatStream(cfg, messages, tools, cb, attemptOrOpts) {
  /* W20：Anthropic 原生协议分发 —— provider 显式声明或 baseURL 指向 anthropic.com 时，
     走 messages API 适配层（thinking 增量 / tool_use 流式 / prompt caching 断点，
     这些经 OpenAI 兼容网关转译会丢）。惰性 require 避免加载环。 */
  {
    const c = cfg || {};
    if (c.provider === "anthropic" || /(^|\.)anthropic\.com/i.test(String(c.baseURL || ""))) {
      return require("./llm-anthropic").chatStream(cfg, messages, tools, cb, attemptOrOpts);
    }
  }
  /* 两种调用形状都留着：内部递归传数字 attempt；外部（agent 层）传 { attempt, signal }。
     历史调用点有 5 个（ping / _summarize / 子智能体 / 主循环 / index.js 连通性测试），
     统一改成对象会波及全部调用点，而递归路径需要继续用数字。 */
  let attempt = 0, extSignal = null;
  if (typeof attemptOrOpts === "number") attempt = attemptOrOpts;
  else if (attemptOrOpts && typeof attemptOrOpts === "object") {
    attempt = attemptOrOpts.attempt || 0;
    extSignal = attemptOrOpts.signal || null;
  }
  const MAX_RETRIES = 3;
  const url = cfg.baseURL.replace(/\/+$/, "") + "/chat/completions";
  const body = {
    model: cfg.model,
    messages,
    stream: true,
    temperature: cfg.temperature,
  };
  // P-M2：reasoning effort 透传（OpenAI / DeepSeek / 通义等支持）
  if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
  if (tools && tools.length) { body.tools = tools; body.tool_choice = "auto"; }
  // 真实 token 用量统计：主流 OpenAI 兼容网关（OpenAI / DeepSeek / Moonshot / 通义）支持
  // stream_options.include_usage；返回的最终 chunk 会携带 usage。若网关不支持该字段（400），
  // 下面的错误分支会自动去掉该字段重试一次，保证向后兼容。
  if (cfg.llm && cfg.llm.streamOptions !== false) body.stream_options = { include_usage: true };

  // 同桶退避：同一端点+模型的其他请求正在被限流时，先等窗口过期再发起，
  // 避免并发同时重试放大限流；不同模型/端点的桶互不影响（修 S-B4）。
  // 等待本身可中断：用户点停止时不该还要干等完整个退避窗口
  await waitBackoff(extSignal, cfg);
  if (extSignal && extSignal.aborted) throw new LlmAbortedError();

  // 请求超时保护（分两段，避免长生成被整体超时误杀——goal 长任务中途历史变大后
  // 单轮生成常超 120s，旧的"整条流 120s 超时"是"跑一段时间就报模型无法连接"的主要来源）：
  // 1) 连接 + 首字：默认 60s，超时视为服务无响应
  // 2) 流进行中：改为空闲超时（默认 90s 无任何数据才算挂起），有数据持续流动则不限总时长
  const connectMs = Math.max(15000, Number(cfg.connectTimeout) || 60000);
  const idleMs = Math.max(5000, Number(cfg.idleTimeout) || 90000);
  /* ctl 的生命周期改成"整个请求"（原来只到响应头）：这样 extSignal 一 abort，
     fetch 的 body 流会立刻以 AbortError 结束，读循环自然被唤醒 —— 不需要在读循环里另开轮询。
     两段超时仍然分开：连接计时器照旧在拿到响应头后清除，避免长生成被整体超时误杀。 */
  const ctl = new AbortController();
  let connTimedOut = false;   // 连接超时与用户中断都会 abort ctl，必须能区分：前者报"超时"，后者报"已取消"
  const connTimer = setTimeout(() => { connTimedOut = true; ctl.abort(); }, connectMs);
  let unlinkExt = null;
  if (extSignal) {
    if (extSignal.aborted) { clearTimeout(connTimer); throw new LlmAbortedError(); }
    const onExt = () => ctl.abort();
    extSignal.addEventListener("abort", onExt, { once: true });
    // 请求结束（含所有抛出路径）都要摘掉监听，否则长会话里 listener 会越积越多
    unlinkExt = () => extSignal.removeEventListener("abort", onExt);
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json" },
        // 本地服务（Ollama / LM Studio）可以根本没有密钥：与其发 "Bearer undefined"，不如不带这个头
        cfg.apiKey ? { "Authorization": "Bearer " + cfg.apiKey } : {}
      ),
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(connTimer);
    if (unlinkExt) unlinkExt();
    /* 中断优先于一切：extSignal 触发时 ctl.abort() 也会让 fetch 抛 AbortError，
       若不先判，下面 isTimeout 那条会把"用户主动停止"报成"连接超时"——
       用户点了停止却收到一句"网络不稳"，是这个分支存在的意义。 */
    if ((extSignal && extSignal.aborted) || (isAbortErr(e) && !connTimedOut)) {
      throw new LlmAbortedError();
    }
    // 网络层错误（ECONNRESET / ENOTFOUND / timeout / socket hang up）→ 抛出可重试错误
    // 真正的错因挂在 e.cause 上：fetch 自己只会给一句 "fetch failed"
    const c = (e && e.cause) || {};
    const nm = String(c.code || c.message || (e && e.message) || e);
    const isTimeout = (ctl.signal.aborted && connTimedOut) || (e && e.name === "TimeoutError") || /timeout|timed out/i.test(nm);
    if (isTimeout) throw new Error("LLM 连接超时（" + (connectMs / 1000) + "s 内未收到响应），可能网络不稳或模型服务无响应");
    // 地址挂在 err.endpoint 上、不拼进 message：agent 的错误分类是按消息里的数字判的
    // （429→限流、401→密钥、404→模型不存在），而内网地址/端口里出现这三个数字太常见了。
    throw withEndpoint(new Error("LLM 网络错误: " + nm), url);
  }
  clearTimeout(connTimer);   // 响应已到达 → 流式阶段交给下面的空闲超时管理

  // 429 限流自动重试（指数退避）；同步把退避窗口推向未来，
  // 按「端点+模型」分桶 —— 同一把钥匙的并发请求一起退避，不同模型互不拖累（修 S-B4）
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = res.headers.get("retry-after");
    // retry-after 可能是秒（"30"）、HTTP-date，或是小数（"3.5"）：都按"秒"解析，
    // 解析不出来才退回指数退避。以前只用 parseInt，HTTP-date 会被算成 NaN。
    let waitSec = parseRetryAfter(retryAfter);
    if (!Number.isFinite(waitSec) || waitSec <= 0) waitSec = Math.min(30, Math.pow(2, attempt) * 3);
    /* 封顶 120 秒：以前上游给多大就睡多大，一个畸形/恶意的 Retry-After: 3600 会让这一口裸睡一小时，
       还把同端点+模型的退避桶一起推后（其它会话在 waitBackoff 里陪着等）。
       120 秒足够跨过常见的 60 秒 RPM 窗口，再长就该让它失败、由上层换模型或人来处理。 */
    waitSec = Math.min(120, Math.max(1, waitSec));
    // 抖动：多个会话的退避窗口同时到期时，同步重试会把网关再打一次。
    // ±20% 抖动把重试时刻摊开；+500ms 兜底，避免窗口末尾贴着边界重试。
    const jitterMs = waitSec * 1000 * (0.8 + Math.random() * 0.4);
    extendBackoff(jitterMs + 500, cfg);
    if (cb && cb.onReasoning) cb.onReasoning("[限流重试] 第" + (attempt + 1) + "次重试，等待" + Math.round(waitSec) + "秒…");
    // 退避进度透出给 UI：原先只往 onReasoning 塞一句，混在思考流里看不见，
    // 用户看到的是"界面卡住 30 秒然后报错"。
    if (cb && cb.onBackoff) cb.onBackoff({ waitSec: Math.round(waitSec), attempt: attempt + 1, maxAttempts: MAX_RETRIES });
    // 退避等待可中断：否则用户点停止后还得干等完整个退避窗口（最长 30s）才收场
    const waited = await sleepAbortable(waitSec * 1000, extSignal);
    if (!waited) { if (unlinkExt) unlinkExt(); throw new LlmAbortedError(); }
    return chatStream(cfg, messages, tools, cb, { attempt: attempt + 1, signal: extSignal });
  }

  // 部分网关不支持 stream_options → 去掉该字段重试一次（保持兼容）
  if (res.status === 400 && /stream_options/i.test(await res.text().catch(() => "")) && body.stream_options && attempt < MAX_RETRIES) {
    delete body.stream_options;
    if (unlinkExt) unlinkExt();   // 递归前摘掉本层的 ext 监听，否则每重试一次就多挂一个
    return chatStream(cfg, messages, tools, cb, { attempt: attempt + 1, signal: extSignal });
  }

  /* ⚠ unlinkExt 的位置是有讲究的，不能随手挪：
     - 在这里（!res.ok 分支内）摘是安全的 —— 下一行就抛错，压根不会进读循环。
     - 但绝不能摘在 !res.ok 之前：那样等于在读循环开始前就把 abort 监听摘了，
       extSignal 再也传不到 ctl，fetch 的 body 永远等不到唤醒 —— 用户点停止，
       读循环会一直挂着（token 双烧且请求不收尾）。
     - 读循环那段由 finally 兜住（见下方），不必在这里操心。 */
  if (!res.ok) {
    if (unlinkExt) unlinkExt();
    const txt = await res.text().catch(() => "");
    // 只补提示语，不改 "LLM 请求失败 HTTP <code>" 这个前缀：agent-llm 的错误分类靠消息里的状态码判定
    const hint = res.status === 404 ? "（地址或模型名不存在：检查接口地址是否少了 /v1 这类版本段、模型 ID 是否拼错）"
      : (res.status === 401 || res.status === 403) ? "（密钥不对，或这个密钥没有该模型的权限）"
      /* 5xx 一律是「服务商那侧」的失败：请求已正常到达网关，是网关转发给真正推理引擎时挂了。
         常见三因：上游超时（思考型模型首字慢，网关等不到）、提示超过上游上下文窗口（Ollama 默认 num_ctx 很小）、
         网关的模型映射/渠道配错。 pancode 侧能看的只有网关包好的壳，原始错误在服务商后台日志里。 */
      : res.status >= 500 ? "（网关到推理引擎失败：多为上游超时 / 提示超过上游上下文窗口 / 模型映射或渠道配错 —— 原始错误在服务商后台日志里，与本机网络无关）" : "";
    throw withEndpoint(new Error("LLM 请求失败 HTTP " + res.status + hint + ": " + txt.slice(0, 400)), url);
  }

  const acc = { content: "", reasoning: "", toolCalls: [], finish: null, usage: null, parseErrors: 0 };
  let parseErrors = 0;          // 本次请求内被跳过的坏帧数（随 acc 带出，便于调用方告警）
  /* 流式协议的两个终态信号之一：finish_reason（业务终态）或 [DONE] 哨兵（传输终态）。
     有些网关只发 [DONE] 不发 finish_reason，认前者会误杀它们，所以两个都算"说完了"。
     但"连接自然走到尽头、两个都没有"一定是半截 —— 那正是审查项 F07 实测到的形态：
     工具参数看着完整，其实是流被掐在最后一帧之前，调用方却拿到一次"正常结束"。 */
  let sawDoneSentinel = false;
  const tcMap = new Map(); // index -> {id, name, arguments}

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf8");
  let buf = "";

  const handleData = (data) => {
    if (data === "[DONE]") { sawDoneSentinel = true; return; }
    let j;
    try {
      j = JSON.parse(data);
    } catch (e) {
      // 半截 JSON 以前在这里裸 return：一个字节都不剩，用户看到的是"回复凭空少了一段"，
      // 而日志里什么都没有，事后完全无法复盘。改成：计数 + 落一行可定位的 warning。
      // 注意这不代表要抛错——网关偶尔会吐出非 JSON 的 keep-alive/注释行，
      // 那时照常跳过；只有"看起来是 JSON 却解析失败"才值得告警（首尾都像花括号）。
      _sseParse.total++;
      const looksJson = /^\s*[\[{]/.test(data);
      const sample = String(data).replace(/\s+/g, " ").slice(0, 120);
      const rec = { at: Date.now(), len: data.length, looksJson, sample, err: String(e && e.message || e) };
      _sseParse.last = rec;
      if (looksJson) {
        log.tag("llm").warn("SSE 帧 JSON 解析失败（已跳过该帧，回复可能少一段）: " +
          rec.err + " | len=" + rec.len + " | 样本=" + sample);
      }
      acc.parseErrors = (parseErrors = parseErrors + 1);
      return;
    }
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
          // name 只在该 tool_call 的首个 delta 出现一次：直接覆盖。若网关在后续 chunk
          // 重发完整 name，追加会拼成 "read_fileread_file" 导致工具不存在（404 类错误）。
          if (t.function.name) slot.name = t.function.name;
          // arguments 可能以字符串分片流式到达；个别网关也可能直接给对象，统一转为字符串累积
          if (typeof t.function.arguments === "string") slot.arguments += t.function.arguments;
          else if (t.function.arguments != null) slot.arguments += JSON.stringify(t.function.arguments);
        }
      }
    }
  };

  // 空闲超时：每次成功读到数据都重置计时器；流进行中卡死（不报错也不吐字）超过 idleMs 才判定挂起。
  // 与"整条请求超时"不同——长生成只要持续吐字就不会被误杀（goal 长任务的关键修复）。
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      reader.cancel().catch(() => {});
      throwIdle();
    }, idleMs);
  };
  let _idleErr = null;
  function throwIdle() {
    if (_idleErr) return;
    _idleErr = new Error("LLM 流空闲超时（" + Math.round(idleMs / 1000) + "s 无数据），流可能已挂起");
  }
  armIdle();
  /* 只有拿到协议终态才算这一口真的说完了（终态定义见上方 sawDoneSentinel 处）。
     旧判据是「finish || content || toolCalls」—— 半截正文、半截工具参数都算数，于是流被
     空闲超时或网络掐断时，调用方拿到的是"看起来正常结束"的一次生成：没有 tool_calls 就
     直接收尾，任务停在计划 3/9 却被记成完成（用户截图里那条即此形）。
     下面几处都只认终态，其余一律抛错，交给 agent 层的重试梯子。 */
  const trulyDone = () => !!acc.finish || sawDoneSentinel;
  /* 整段读循环放进 try/finally：ext 监听必须活到请求真正结束为止。
     之前我把 unlinkExt() 撒在各个分支上（429 递归前、stream_options 递归前、!res.ok 前），
     漏一处就等于中途把监听摘了 —— 表现是"停止按钮偶尔没反应"，而且极难定位。
     finally 一处兜住所有抛出行，正常读完也走这里。 */
  try {
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      /* 中断必须排在所有"当正常完成"分支之前。位置放错的话，用户点了停止
         反而会拿到一句"[SSE 流中断，已保留已收到的部分结果]"并把半截回复当成完成 ——
         那正是"停止按钮形同虚设"的可见形态。 */
      if ((extSignal && extSignal.aborted) || (isAbortErr(e) && !connTimedOut)) {
        if (idleTimer) clearTimeout(idleTimer);
        throw new LlmAbortedError();
      }
      if (_idleErr) {
        // 空闲超时触发的 cancel 会 reject read()：只有真拿到 finish_reason 才算说完，否则报空闲超时
        if (trulyDone()) {
          if (idleTimer) clearTimeout(idleTimer);
          if (cb && cb.onReasoning) cb.onReasoning("[SSE 流空闲超时，收尾时已收到 finish_reason，按完成处理]");
          break;
        }
        if (idleTimer) clearTimeout(idleTimer);
        throw _idleErr;
      }
      // SSE 流中途断开（ECONNRESET / socket hang up / 网络抖动）
      // 同上：没有 finish_reason 的半截内容不是完成，抛出去让上层重试，别把断句当答案
      if (trulyDone()) {
        if (idleTimer) clearTimeout(idleTimer);
        if (cb && cb.onReasoning) cb.onReasoning("[SSE 流中断，收尾时已收到 finish_reason，按完成处理]");
        break;
      }
      if (idleTimer) clearTimeout(idleTimer);
      throw new Error("SSE 流中断: " + (e && e.message || e));
    }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const { done, value } = chunk;
    if (done) {
      if (idleTimer) clearTimeout(idleTimer);
      /* done:true 也可能是"刚被中断、流就此收尾"：fetch 的 body 在 abort 后
         会干净地返回 done，而不是抛错。这一条漏了的话，用户点停止后拿到的是
         一份看起来完整、其实被腰斩的回复。 */
      if (extSignal && extSignal.aborted) throw new LlmAbortedError();
      // 空闲超时触发的 cancel 会让 read() 以 done:true 结束而非抛错，在此显式提示
      if (_idleErr) {
        if (trulyDone()) {
          if (cb && cb.onReasoning) cb.onReasoning("[SSE 流空闲超时，收尾时已收到 finish_reason，按完成处理]");
        } else {
          throw _idleErr;
        }
      }
      /* 干净地读到流尽头、却没有任何协议终态 = 上游把这一口掐了（网关重启、代理超时、
         响应被截断都会这样）。这里必须抛、不能 break：break 之后 return 的 acc 带着
         "形状完整的半截工具调用"，agent 层会照着它真的去执行工具（审查项 F07 实测形态：
         finish 为 null、toolCalls 却有 1 条，参数还正好是完整 JSON，谁都看不出它是半截）。 */
      if (!trulyDone()) {
        throw withEndpoint(new Error("LLM 流提前结束：未收到 finish_reason / [DONE] 结束标记"
          + "（已收到 " + acc.content.length + " 字正文、" + tcMap.size + " 个工具调用片段），本次结果不完整"), url);
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
    armIdle();   // 有数据到达 → 重置空闲计时
  }
  } finally {
    if (unlinkExt) unlinkExt();
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  acc.toolCalls = Array.from(tcMap.keys()).sort((a, b) => a - b).map((k) => tcMap.get(k));
  acc.parseErrors = parseErrors;
  // 本次请求里有过坏帧 → 补一句，让用户在思考流里看见"网关吐了坏数据"这件事，
  // 而不是只在服务端日志里躺着（用户看到的现象是"回复少了内容"，需要能自查）。
  if (parseErrors && cb && cb.onReasoning) {
    cb.onReasoning("[SSE 有 " + parseErrors + " 帧解析失败已跳过：网关返回了不完整的 JSON，回复可能少内容]");
  }
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

module.exports = {
  chatStream, ping, getBackoffUntil, extendBackoff, parseRetryAfter, getSseParseStats,
  LlmAbortedError, sleepAbortable,
  backoffKey, backoffStats,
};
