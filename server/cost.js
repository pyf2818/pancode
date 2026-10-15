/* ============================================================
   P1-B4 · Token 成本换算（纯函数层）

   已有的是什么：agent-llm 里 `_usage` / `_usageByConv` 累计的是**token 数**，
   trace 面板显示的也是 token 数（`public/js/trace.js`）。缺的是把 token 变成钱，
   以及"这个月到底花了多少"这件事在重启后还看得见。

   这一层只做换算，不碰磁盘也不碰配置对象——于是三处消费点（实时事件、
   /api/cost、落盘的 usage.json）拿到的是同一个口径的数。

   两条刻意的取舍：
   1) **不内置任何默认单价。** 模型价格随供应商、地区、时间变，猜一个数打在面板上
      比留空更糟——用户会拿它做决定。没配置就显示"未配置单价"，只显示 token。
   2) **单价按百万 token 计**（input / output 分开），这是主流供应商的标价方式，
      也是用户最容易从账单上抄对的形式。
   ============================================================ */
"use strict";

/* 命中规则：match 是不区分大小写的子串（"deepseek-chat" 命中 "deepseek"），
   也接受 /正则/ 写法（与 hooks/权限规则里已有的习惯一致）。
   顺序即优先级：第一条命中就用，所以"贵的专用模型"要排在"便宜的通用别名"前面。 */
function matchRate(model, rates) {
  const m = String(model || "").toLowerCase();
  const list = Array.isArray(rates) ? rates : [];
  for (const r of list) {
    if (!r || !r.match) continue;
    const pat = String(r.match);
    if (/^\/.*\/[i]*$/.test(pat)) {
      try { if (new RegExp(pat.slice(1, pat.lastIndexOf("/")), "i").test(model || "")) return r; } catch (e) { /* 坏正则当不命中 */ }
      continue;
    }
    if (m.indexOf(pat.toLowerCase()) >= 0) return r;
  }
  return null;
}

/* 一边的单价（元/百万 token）→ 该侧金额。缺 output 价时按 input 价的一半估？
   不估。缺任何一个就当这条不可用，宁可不显示钱。 */
function priceSide(tokens, perMTok) {
  const t = Number(tokens) || 0, p = Number(perMTok);
  if (!Number.isFinite(p) || p < 0 || t <= 0) return 0;
  return (t / 1e6) * p;
}

/* costOf(model, usage, cfg) → null | { input, output, total, currency, match, perInput, perOutput }
   usage 用 LLM 返回的那份 { prompt_tokens, completion_tokens }（口径一致，别再估一遍）。 */
function costOf(model, usage, cfg) {
  const c = cfg || {};
  if (c.enabled === false) return null;
  const r = matchRate(model, c.rates);
  if (!r) return null;
  const p = Number(usage && usage.prompt_tokens) || 0;
  const o = Number(usage && usage.completion_tokens) || 0;
  const input = priceSide(p, r.input);
  const output = priceSide(o, r.output);
  return {
    input, output, total: input + output,
    currency: r.currency || c.currency || "CNY",
    match: r.match, perInput: Number(r.input) || 0, perOutput: Number(r.output) || 0,
  };
}

/* 本地日界：跨月的账单要按用户所在时区切，用 toISOString() 会在 UTC 偏一整天。 */
function dayKey(ts) {
  const d = new Date(ts == null ? Date.now() : Number(ts));
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/* 累加进按天分桶的账本。形状刻意保持扁平可读：
   { v:1, days:{ "2026-10-14": { models:{ "deepseek-chat": { prompt, completion, cost, currency } }, total } } }
   每天留 total 是为了面板不必重算就能画"近 7 天花费"。 */
function accumulate(store, rec) {
  const day = dayKey(rec.ts);
  const days = store.days || (store.days = {});
  const d = days[day] || (days[day] = { models: {}, total: 0 });
  const model = String(rec.model || "unknown");
  const m = d.models[model] || (d.models[model] = { prompt: 0, completion: 0, cost: 0, currency: rec.cost && rec.cost.currency || "" });
  m.prompt += Number(rec.usage && rec.usage.prompt_tokens) || 0;
  m.completion += Number(rec.usage && rec.usage.completion_tokens) || 0;
  if (rec.cost) { m.cost += rec.cost.total || 0; m.currency = rec.cost.currency || m.currency; }
  d.total += rec.cost ? rec.cost.total || 0 : 0;
  return { day, model };
}

/* summarize(store, { days: N }) → { days:[{day, total, models}], models:{...}, total, priced }
   priced = 是否有任何一条被单价覆盖过（面板据此区分"花了 0 元"与"没配单价"）。 */
function summarize(store, opts) {
  const limit = Math.max(1, Math.min(366, Number(opts && opts.days) || 30));
  const all = Object.keys((store && store.days) || {}).sort().reverse().slice(0, limit);
  const models = {};
  let total = 0, priced = false, prompt = 0, completion = 0;
  const list = all.map((day) => {
    const d = store.days[day];
    Object.keys(d.models || {}).forEach((k) => {
      const v = d.models[k];
      const a = models[k] || (models[k] = { prompt: 0, completion: 0, cost: 0, currency: v.currency });
      a.prompt += v.prompt || 0; a.completion += v.completion || 0; a.cost += v.cost || 0;
      if (v.cost) priced = true;
    });
    total += d.total || 0;
    return { day, total: d.total || 0, models: d.models || {} };
  });
  Object.keys(models).forEach((k) => { prompt += models[k].prompt; completion += models[k].completion; });
  return { days: list, models, total, priced, prompt, completion };
}

/* fmtMoney(x) → "¥1.2345"；金额小于 1 元时留 4 位小数（自用一次对话常常是几分钱，
   四舍五入成 "¥0.00" 会让人以为面板坏了）。 */
const SYMBOLS = { CNY: "¥", USD: "$", EUR: "€" };
function fmtMoney(amount, currency) {
  const cur = String(currency || "CNY").toUpperCase();
  const sym = SYMBOLS[cur] || cur + " ";
  const n = Number(amount) || 0;
  const digits = Math.abs(n) < 1 ? 4 : Math.abs(n) < 100 ? 3 : 2;
  return sym + n.toFixed(digits);
}

module.exports = { matchRate, costOf, accumulate, summarize, dayKey, fmtMoney, priceSide };
