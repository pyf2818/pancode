/* pancode Agent Trace 模块 —— 从 app.js 抽出
   依赖: $ (core.js), escHtml/fmtTok (utils.js)
   加载顺序: core.js → utils.js → trace.js → app.js */
"use strict";

/* ----- Agent Trace 面板：渲染 agent 内部事件流（llm.round / tool.* / usage） ----- */
const TRACE_LABELS = {
  "llm.round": "llm.round", "tool.call": "tool.call", "tool.arg_err": "arg_err",
  "tool.loop": "loop", "tool.failstreak": "failstreak", "usage": "usage",
};
const traceState = { rounds: 0, tools: 0, tokens: 0, cost: 0, currency: "", loops: 0, errors: 0, seq: 0 };

/* 金额显示口径与 server/cost.js 的 fmtMoney 一致（不足 1 元留 4 位小数）。
   浏览器与 Node 之间没有共享模块，改规则时两处一起改。 */
function fmtMoney(n, currency) {
  const cur = String(currency || "CNY").toUpperCase();
  const sym = cur === "CNY" ? "¥" : cur === "USD" ? "$" : cur === "EUR" ? "€" : cur + " ";
  const v = Number(n) || 0;
  return sym + v.toFixed(Math.abs(v) < 1 ? 4 : Math.abs(v) < 100 ? 3 : 2);
}
/* 一个格子同时说"用了多少 token"和"花了多少钱"，没配单价时只显示 token
   （显示 ¥0 会被读成"这次免费"，而真实含义是"我不知道价"）。 */
function paintUsage() {
  setTraceText("traceTokens", fmtTok(traceState.tokens) + (traceState.cost > 0 ? " · " + fmtMoney(traceState.cost, traceState.currency) : ""));
}

function traceDetail(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "llm.round": return "round " + (d.rounds || "?") + " · " + (d.tools || 0) + " tools · finish: " + (d.finish || "");
    case "tool.call": return (d.name || "?") + " · " + (d.len != null ? (Math.round(d.len / 100) / 10 + "k") : "") + " chars";
    case "tool.arg_err": return (d.name || "?") + " · 参数解析失败 → 回传模型纠正";
    case "tool.loop": return (d.name || "?") + " 已连续 " + (d.count || "?") + " 次相同调用 → 死循环已阻断";
    case "tool.failstreak": return "连续 " + (d.streak || "?") + " 次工具报错 → 注入反思";
    case "usage": return "prompt " + (d.prompt_tokens || 0) + " / completion " + (d.completion_tokens || 0) + " / total " + (d.total_tokens || 0)
      + (d.cost > 0 ? " · " + fmtMoney(d.cost, d.costCurrency || d.currency) : "");
    default: return JSON.stringify(d);
  }
}

function setTraceText(id, v) { const el = $(id); if (el) el.textContent = v; }

function onTraceEvent(ev, isHistory) {
  if (!ev) return;
  const list = $("traceList"); if (!list) return;
  if (ev.type === "llm.round") traceState.rounds++;
  else if (ev.type === "tool.call") traceState.tools++;
  else if (ev.type === "tool.loop" || ev.type === "tool.failstreak") traceState.loops++;
  else if (ev.type === "tool.arg_err") traceState.errors++;
  // 落盘的 jsonl 记的是「单次请求」的 usage，实时 agent.usage 记的是「本会话累计」——
  // 两种口径喂同一个格子就会看人下菜：刚跑完显示累计、切回旧会话显示最后一包。
  // 统一成累加：回放把每包加起来，实时那路服务端已按会话分桶，直接覆盖。
  else if (ev.type === "usage" && ev.data) {
    traceState.tokens += (ev.data.total_tokens || 0);
    if (ev.data.cost > 0) { traceState.cost += ev.data.cost; traceState.currency = ev.data.costCurrency || traceState.currency || "CNY"; }
  }
  setTraceText("traceRounds", traceState.rounds);
  setTraceText("traceTools", traceState.tools);
  setTraceText("traceLoops", traceState.loops);
  setTraceText("traceErrors", traceState.errors);
  paintUsage();
  setTraceText("agTraceCount", t("nEvents", { n: ++traceState.seq }));
  /* 局部变量别叫 t：这个函数下面还要用全局 t() 取字典，同名 const 会让整段进 TDZ */
  const empty = list.querySelector(".trace-empty"); if (empty) empty.remove();
  const stamp = (((ev.t || Date.now()) % 60000) / 1000).toFixed(1) + "s";
  const row = document.createElement("div");
  row.className = "trace-row tr-" + ev.type.replace(/\./g, "-") + (isHistory ? " tr-history" : "");
  row.innerHTML = '<span class="tr-time">' + stamp + '</span>' +
    '<span class="tr-badge">' + escHtml(TRACE_LABELS[ev.type] || ev.type) + '</span>' +
    '<span class="tr-detail">' + escHtml(traceDetail(ev)) + '</span>';
  list.appendChild(row);
  while (list.children.length > 200) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}
function clearTrace() {
  traceState.rounds = traceState.tools = traceState.loops = traceState.errors = traceState.seq = 0;
  traceState.tokens = 0; traceState.cost = 0; traceState.currency = "";
  const list = $("traceList"); if (list) list.innerHTML = "";
  paintTraceEmpty();
  setTraceText("traceRounds", "0"); setTraceText("traceTools", "0"); setTraceText("traceLoops", "0");
  setTraceText("traceErrors", "0"); setTraceText("traceTokens", "0"); setTraceText("agTraceCount", t("nEvents", { n: 0 }));
  setTraceText("traceCtx", "—");
}
/* 实时那路：服务端已按会话分桶，直接覆盖（与上面回放口径一致）。
   u.cost 只有配了单价才存在；没配就保持只显示 token。 */
function onUsageEvent(u) {
  if (!u) return;
  traceState.tokens = u.total_tokens || traceState.tokens;
  if (u.cost > 0) { traceState.cost = u.cost; traceState.currency = u.costCurrency || "CNY"; traceState.costModel = u.costModel || ""; }
  paintUsage();
}
/* 跨会话回看：从服务端拉取某会话落盘的 trace 历史并渲染（dimmed），然后 live 事件继续追加 */
async function loadTraceHistory(convId) {
  const list = $("traceList"); if (!list || !convId) return;
  try {
    const r = await fetch("/api/agent/trace/history?conv=" + encodeURIComponent(convId));
    const j = await r.json();
    if (!j || !j.ok || !Array.isArray(j.events)) return;
    for (const ev of j.events) onTraceEvent(ev, true);
    list.scrollTop = list.scrollHeight;
  } catch (e) { /* 静默：历史缺失不应影响实时面板 */ }
}
/* W26 空态行：列表为空时放一句说明。clearTrace / 初始 / 换语言三处都会调。 */
function paintTraceEmpty() {
  const list = $("traceList"); if (!list) return;
  if (list.children.length) return;
  const hint = document.createElement("div");
  hint.className = "trace-empty";
  hint.textContent = t("traceEmptyHint");
  list.appendChild(hint);
}
/* 「N 事件」是界面文案不是计数值：换语言后要立刻跟着改，否则英文界面钉着中文 */
if (typeof onLang === "function") onLang(() => { setTraceText("agTraceCount", t("nEvents", { n: traceState.seq })); paintTraceEmpty(); });
paintTraceEmpty();   // 初始（reload 后 restoreConv 不走 clearTrace，这里兜住）
if (typeof onLang === "function") onLang(() => setTraceText("agTraceCount", t("nEvents", { n: traceState.seq })));
