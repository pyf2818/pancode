/* pancode Agent Trace 模块 —— 从 app.js 抽出
   依赖: $ (core.js), escHtml/fmtTok (utils.js)
   加载顺序: core.js → utils.js → trace.js → app.js */
"use strict";

/* ----- Agent Trace 面板：渲染 agent 内部事件流（llm.round / tool.* / usage） ----- */
const TRACE_LABELS = {
  "llm.round": "llm.round", "tool.call": "tool.call", "tool.arg_err": "arg_err",
  "tool.loop": "loop", "tool.failstreak": "failstreak", "usage": "usage",
};
const traceState = { rounds: 0, tools: 0, tokens: 0, loops: 0, errors: 0, seq: 0 };

function traceDetail(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "llm.round": return "round " + (d.rounds || "?") + " · " + (d.tools || 0) + " tools · finish: " + (d.finish || "");
    case "tool.call": return (d.name || "?") + " · " + (d.len != null ? (Math.round(d.len / 100) / 10 + "k") : "") + " chars";
    case "tool.arg_err": return (d.name || "?") + " · 参数解析失败 → 回传模型纠正";
    case "tool.loop": return (d.name || "?") + " 已连续 " + (d.count || "?") + " 次相同调用 → 死循环已阻断";
    case "tool.failstreak": return "连续 " + (d.streak || "?") + " 次工具报错 → 注入反思";
    case "usage": return "prompt " + (d.prompt_tokens || 0) + " / completion " + (d.completion_tokens || 0) + " / total " + (d.total_tokens || 0);
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
  else if (ev.type === "usage" && ev.data) traceState.tokens = ev.data.total_tokens || traceState.tokens;
  setTraceText("traceRounds", traceState.rounds);
  setTraceText("traceTools", traceState.tools);
  setTraceText("traceLoops", traceState.loops);
  setTraceText("traceErrors", traceState.errors);
  setTraceText("traceTokens", fmtTok(traceState.tokens));
  setTraceText("agTraceCount", (++traceState.seq) + " 事件");
  const t = (((ev.t || Date.now()) % 60000) / 1000).toFixed(1) + "s";
  const row = document.createElement("div");
  row.className = "trace-row tr-" + ev.type.replace(/\./g, "-") + (isHistory ? " tr-history" : "");
  row.innerHTML = '<span class="tr-time">' + t + '</span>' +
    '<span class="tr-badge">' + escHtml(TRACE_LABELS[ev.type] || ev.type) + '</span>' +
    '<span class="tr-detail">' + escHtml(traceDetail(ev)) + '</span>';
  list.appendChild(row);
  while (list.children.length > 200) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}
function clearTrace() {
  traceState.rounds = traceState.tools = traceState.loops = traceState.errors = traceState.seq = 0;
  traceState.tokens = 0;
  const list = $("traceList"); if (list) list.innerHTML = "";
  setTraceText("traceRounds", "0"); setTraceText("traceTools", "0"); setTraceText("traceLoops", "0");
  setTraceText("traceErrors", "0"); setTraceText("traceTokens", "0"); setTraceText("agTraceCount", "0 事件");
}
function onUsageEvent(u) { if (!u) return; traceState.tokens = u.total_tokens || traceState.tokens; setTraceText("traceTokens", fmtTok(traceState.tokens)); }
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
