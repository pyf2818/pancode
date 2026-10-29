"use strict";
/* ============================================================
   模型真实上下文窗口 · 在线探测
   ------------------------------------------------------------
   动因：model-presets.js 那张本地表到不了「本地 llama.cpp / 自建 one-api
   网关上挂的自定义 GGUF 模型」——它们的窗口完全由「你启动推理服务时
   -c/--ctx-size 设了多少」决定，本地表猜不到。而手填窗口又极容易填错：
   把云端 512K 的值抄到本地 163K 的模型上，压缩线被推到 ~41 万 token，
   多轮 agent 一涨过真实窗口，上游就回 400/500，表现正是「经常响应出错」。

   解法：引擎启动时直接问本网关的 /v1/models，读条目里的 n_ctx（one-api /
   new-api 会把它写进模型元数据；部分 llama.cpp 版本也在 /v1/models 里带）。
   探测到就信它（这是该部署实际加载的窗口，最权威）；探测不到（多为云端，
   网关不返回窗口字段）就退回 model-presets 的预设，再退回出厂默认窗口兜底。

   单位：token。数值口径与上游报错的 "maximum context length" 同一口径
   （input+output 共享窗口）。 */
const configMod = require("./config");

/* 拉取 /v1/models 的原始条目（不裁成只留 ID），便于从里面抠窗口字段。
   失败只回 { ok:false }，绝不抛异常——调用方据此静默退回兜底。 */
async function fetchModelsRaw(baseURL, apiKey) {
  const base = configMod.normalizeBaseURL(baseURL);
  if (!base) return { ok: false, entries: [], error: "还没填接口地址" };
  let target;
  try { target = new URL(base + "/models"); }
  catch (e) { return { ok: false, entries: [], error: "接口地址不是合法 URL" }; }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, entries: [], error: "接口地址必须以 http:// 或 https:// 开头" };
  }
  const headers = { "Accept": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
  let r;
  try { r = await fetch(target, { headers, signal: AbortSignal.timeout(20000) }); }
  catch (e) { return { ok: false, entries: [], error: "连不上 " + target.origin }; }
  if (!r.ok) return { ok: false, entries: [], error: "HTTP " + r.status };
  const data = await r.json().catch(() => null);
  const raw = Array.isArray(data && data.data) ? data.data
    : (Array.isArray(data && data.models) ? data.models
    : (Array.isArray(data) ? data : []));
  return { ok: true, entries: raw, attempted: target.origin + target.pathname };
}

/* 从单条模型条目里尽可能多地识别上下文窗口字段，返回第一个合理的（floor）。
   候选顺序即优先级：推理窗口优先于训练窗口（n_ctx_train 通常 ≥ 推理窗口，
   只作次选，避免把 262K 训练窗口当成 163K 推理窗口用）。 */
function extractNctx(m) {
  if (!m || typeof m !== "object") return 0;
  const meta = (m.meta && typeof m.meta === "object") ? m.meta : {};
  const cand = [
    Number(m.n_ctx),
    Number(meta.n_ctx),
    Number(m.context_length),
    Number(meta.context_length),
    Number(m.context_window),
    Number(m.max_context),
    Number(m.n_ctx_train),     // 次选：训练窗口通常 ≥ 推理窗口
    Number(meta.n_ctx_train),
  ];
  for (const v of cand) {
    if (Number.isFinite(v) && v >= 1024 && v <= 10000000) return Math.floor(v);
  }
  return 0;
}

/* 探测指定模型「在本网关」上的真实上下文窗口（token）。未探测到返回 0。
   - 先按模型 id 精确/包含匹配；命中即取该条的窗口。
   - 网关只暴露一个模型（很多本地部署就这样）时，直接信它。 */
async function probeContextWindow(baseURL, apiKey, model) {
  const got = await fetchModelsRaw(baseURL, apiKey);
  if (!got.ok || !got.entries.length) return 0;
  const id = String(model || "").toLowerCase();
  for (const m of got.entries) {
    const mid = String((typeof m === "string" ? m : (m && (m.id || m.name))) || "").toLowerCase();
    if (!mid) continue;
    const hit = id && (mid === id || mid.indexOf(id) >= 0 || id.indexOf(mid) >= 0);
    if (hit) {
      const n = extractNctx(m);
      if (n > 0) return n;
    }
  }
  // 网关只挂了一个模型：即便 id 没对上，也大概率是它
  if (got.entries.length === 1) {
    const n = extractNctx(got.entries[0]);
    if (n > 0) return n;
  }
  return 0;
}

module.exports = { probeContextWindow, fetchModelsRaw, extractNctx };
