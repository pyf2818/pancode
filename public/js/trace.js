/* pancode Agent Trace 模块 —— 从 app.js 抽出
   依赖: $ (core.js), escHtml/fmtTok (utils.js)
   加载顺序: core.js → utils.js → trace.js → app.js */
"use strict";

/* ----- Agent Trace 面板：渲染 agent 内部事件流（llm.round / tool.* / usage） ----- */
const TRACE_LABELS = {
  "llm.round": "llm.round", "tool.call": "tool.call", "tool.arg_err": "arg_err",
  "tool.loop": "loop", "tool.failstreak": "failstreak", "usage": "usage",
};
const traceState = { rounds: 0, tools: 0, tokens: 0, cost: 0, currency: "", loops: 0, errors: 0, seq: 0, lastReq: 0 };

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
  /* 参照行：把累计 token 折算成"相当于多少次单轮问答"。
     只标 token 数，用户没法判断多不多；折算成他自己的行为（轮次）就有尺子了。
     用最近一次请求的实际 prompt 体积当"一轮"的量 —— 那是真实值，不是猜的。 */
  const ref = $("traceTokensRef");
  if (!ref) return;
  const per = traceState.lastReq || 0;
  if (!per || !traceState.tokens) { ref.textContent = ""; return; }
  const n = Math.max(1, Math.round(traceState.tokens / per));
  ref.textContent = t("traceSentRef", { n });
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

/* F18：面板上的数字一律由"事件源"算出来，不由 DOM 数格子，也不由"回调进来过几次"累加。
   旧形态是每来一条事件就把全局计数器 +1，而历史回看走的也是同一条累加路 ——
   于是 A→B→A 会把 A 的历史再数一遍、两次重连各拉一次历史也是同样结果（数字只会虚高）。
   现在：
     traceStore = 当前呈现的那条会话的事件数组（按 eid 去重）+ 最后一包实时 usage；
     所有数字 = traceAgg(traceStore) 纯函数算出来的；
     任何变化（新事件 / 换会话 / 历史到齐）都只调 tracePaint() 重新投影一遍。
   异步守卫：切会话时给这次拉取编号，回来时编号或会话已经变了就直接丢，
   晚到的 A 历史永远盖不到正在看的 B 上。 */
const TRACE_CAP = 200;        // 列表最多画这么多行
const TRACE_STORE_CAP = 2000; // 事件数组的上限（防长任务把内存吃穿）
const traceStore = { conv: null, events: [], ids: null, live: null, loadSeq: 0 };

function traceIdOf(ev) {
  if (!ev) return "";
  if (ev.eid) return String(ev.eid);
  /* 老落盘文件里没有 eid（改版之前写的），退回"类型:时间:序号"这个组合作为身份。
     注意口径：这是同一份数据里的老格式，不是另一种真相 —— 能认出来就不要再数第二遍。 */
  return (ev.type || "") + ":" + (ev.t || 0) + ":" + (ev.seq || 0);
}
function tracePush(ev) {
  if (!ev) return false;
  if (!traceStore.ids) traceStore.ids = new Set();
  const id = traceIdOf(ev);
  if (traceStore.ids.has(id)) return false;
  traceStore.ids.add(id);
  traceStore.events.push(ev);
  if (traceStore.events.length > TRACE_STORE_CAP) {
    // 丢最老的：集合里对应的身份也要一起摘掉，否则后面来同一条会被当成重复而吞掉
    const dropped = traceStore.events.shift();
    traceStore.ids.delete(traceIdOf(dropped));
  }
  return true;
}
/* 数字的口径（一次说清，别在两个地方各自解释）：
   rounds=llm.round 条数，tools=tool.call 条数，loops=tool.loop+tool.failstreak，
   errors=tool.arg_err；tokens/钱：优先用服务端按会话累计的那一包（live），
   没有 live（回看历史）才把每请求 usage 加起来。 */
function traceAgg() {
  const a = { rounds: 0, tools: 0, loops: 0, errors: 0, tokens: 0, cost: 0, currency: "", lastReq: 0 };
  for (const ev of traceStore.events) {
    if (ev.type === "llm.round") a.rounds++;
    else if (ev.type === "tool.call") a.tools++;
    else if (ev.type === "tool.loop" || ev.type === "tool.failstreak") a.loops++;
    else if (ev.type === "tool.arg_err") a.errors++;
    else if (ev.type === "usage" && ev.data) {
      a.tokens += (ev.data.total_tokens || 0);
      if (ev.data.cost > 0) { a.cost += ev.data.cost; a.currency = ev.data.costCurrency || ev.data.currency || a.currency || "CNY"; }
    }
  }
  if (traceStore.live) {
    a.tokens = traceStore.live.total_tokens || a.tokens;
    if (traceStore.live.cost > 0) { a.cost = traceStore.live.cost; a.currency = traceStore.live.costCurrency || a.currency || "CNY"; }
  }
  if (traceStore.lastReq) a.lastReq = traceStore.lastReq;
  return a;
}
function tracePaint() {
  const a = traceAgg();
  traceState.rounds = a.rounds; traceState.tools = a.tools; traceState.loops = a.loops;
  traceState.errors = a.errors; traceState.tokens = a.tokens; traceState.cost = a.cost;
  traceState.currency = a.currency; traceState.lastReq = a.lastReq;
  traceState.seq = traceStore.events.length;
  setTraceText("traceRounds", a.rounds);
  setTraceText("traceTools", a.tools);
  setTraceText("traceLoops", a.loops);
  setTraceText("traceErrors", a.errors);
  paintUsage();
  setTraceText("agTraceCount", t("nEvents", { n: traceStore.events.length }));
  tracePaintList();
}
/* 列表也是投影：把数组里最后 TRACE_CAP 条画出来，多的按同口径截掉。 */
function tracePaintList() {
  const list = $("traceList"); if (!list) return;
  const rows = traceStore.events.slice(-TRACE_CAP);
  list.innerHTML = "";
  for (const ev of rows) list.appendChild(traceRow(ev));
  if (!rows.length) paintTraceEmpty();
  list.scrollTop = list.scrollHeight;
}
function traceRow(ev) {
  const isHistory = !!ev._history;
  const stamp = (((ev.t || Date.now()) % 60000) / 1000).toFixed(1) + "s";
  const row = document.createElement("div");
  row.className = "trace-row tr-" + String(ev.type || "").replace(/\./g, "-") + (isHistory ? " tr-history" : "");
  row.innerHTML = '<span class="tr-time">' + stamp + '</span>' +
    '<span class="tr-badge">' + escHtml(TRACE_LABELS[ev.type] || ev.type || "") + '</span>' +
    '<span class="tr-detail">' + escHtml(traceDetail(ev)) + '</span>';
  return row;
}

function onTraceEvent(ev, isHistory) {
  if (!ev) return;
  const list = $("traceList"); if (!list) return;
  /* 按会话归属过滤：后台会话那一轮的事件要留在它自己的账上，
     正在看的这块面板不能替它计数（以前没有 convId，只能来一条数一条）。 */
  const cid = ev.convId || (typeof convId !== "undefined" ? convId : null);
  if (traceStore.conv && cid && cid !== traceStore.conv) return;
  if (!traceStore.conv && cid) traceStore.conv = cid;
  if (isHistory) ev._history = true;
  if (!tracePush(ev)) return;   // 同一条事件（重连后补发、历史与实时交错）只算一次
  tracePaint();
}
function clearTrace() {
  traceStore.conv = null; traceStore.events = []; traceStore.ids = new Set();
  traceStore.live = null; traceStore.lastReq = 0;
  traceState.rounds = traceState.tools = traceState.loops = traceState.errors = traceState.seq = 0;
  traceState.tokens = 0; traceState.cost = 0; traceState.currency = "";
  const list = $("traceList"); if (list) list.innerHTML = "";
  paintTraceEmpty();
  setTraceText("traceRounds", "0"); setTraceText("traceTools", "0"); setTraceText("traceLoops", "0");
  setTraceText("traceErrors", "0"); setTraceText("traceTokens", "0"); setTraceText("agTraceCount", t("nEvents", { n: 0 }));
  traceState.lastReq = 0;
  const ref0 = $("traceTokensRef"); if (ref0) ref0.textContent = "";
  setTraceText("traceCtx", "—");
}
/* 实时那路：服务端已按会话分桶，直接覆盖（与上面回放口径一致）。
   u.cost 只有配了单价才存在；没配就保持只显示 token。 */
function onUsageEvent(u, ev) {
  if (!u) return;
  /* 累计包也进仓（不是就地改全局数）：这样换会话、重画、补历史之后，
     这一包的数值仍然能被同一条规则重算出来，而不是"看谁最后写"。 */
  traceStore.live = u;
  if (ev && ev.request && Number(ev.request.prompt) > 0) traceStore.lastReq = Number(ev.request.prompt);
  tracePaint();
}
/* 跨会话回看：拉某会话落盘的 trace 历史。**整份替换**当前投影（不是往上面再叠一层），
   并带异步守卫：回来的时候会话或编号变了就直接丢。 */
async function loadTraceHistory(targetConv) {
  const list = $("traceList"); if (!list || !targetConv) return;
  const seq = ++traceStore.loadSeq;
  const mine = seq;
  clearTrace();
  traceStore.conv = targetConv;
  try {
    const r = await fetch("/api/agent/trace/history?conv=" + encodeURIComponent(targetConv));
    const j = await r.json();
    if (traceStore.loadSeq !== mine) return;                 // 已经切到别的会话/又发起了一次拉取
    if (!j || !j.ok || !Array.isArray(j.events)) return;
    for (const ev of j.events) onTraceEvent(ev, true);        // 去重 + 每次入仓都重新投影
    list.scrollTop = list.scrollHeight;
  } catch (e) { /* 静默：历史缺失不应影响实时面板 */ }
}
/* W26 空态行：列表没有任何真实行时显示一句说明。clearTrace / 初始 / 换语言三处都会调；
   已有 .trace-empty 时更新文案（W28 终审:旧守卫 children.length 让切语言永远刷不了文案）。 */
function paintTraceEmpty() {
  const list = $("traceList"); if (!list) return;
  if (list.querySelector(".trace-row")) return;   // 有真实 trace 行 = 不需要空态
  let hint = list.querySelector(".trace-empty");
  if (!hint) {
    hint = document.createElement("div");
    hint.className = "trace-empty";
    list.appendChild(hint);
  }
  hint.textContent = t("traceEmptyHint");
}
/* 「N 事件」是界面文案不是计数值：换语言后要立刻跟着改，否则英文界面钉着中文 */
if (typeof onLang === "function") onLang(() => { setTraceText("agTraceCount", t("nEvents", { n: traceState.seq })); paintTraceEmpty(); });
paintTraceEmpty();   // 初始（reload 后 restoreConv 不走 clearTrace，这里兜住）
