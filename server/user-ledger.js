/* ============================================================
   「用户要求沿革」台账 —— 长任务里用户消息的有界滚动摘要（纯函数，单独成文件就是为了能单测）

   问题：压缩时"用户消息永远原文保留"（旧写法 `criticalKept = head.filter(role==="user")`）。
   七八小时的任务里 Goal 自动续跑每一轮还额外注入一条长用户消息，于是保留侧单调涨，
   迟早 `after >= beforeEst` 判成"摘要不比原文短"——压缩白做一次，连续两次就触发断路器，
   自动摘要从此对该会话关闭，上下文一路涨到上游 400。**表现就是任务跑着跑着断了，
   而这正是"越长的任务越容易断"那条反馈的后半截。**

   现在的规则：最近的若干条用户要求留原文（预算按保留量的比例给），更早的折成一行进这份台账；
   台账本身有字节上限，超了就从最旧那头折叠成一个条数，不再留文字。
   全文并没有丢：摘要模板要求逐条列【全部用户消息】，被丢弃的原文正是在那一次的摘要输入里。

   台账是一条 system 消息（不是 user/assistant/tool），所以它不参与工具配对，
   不会造出"孤儿 tool 结果"那种上游必拒的形状。
   ============================================================ */
"use strict";

const USER_LEDGER_PREFIX = "[用户要求沿革] ";
const LEDGER_TITLE = "以下是这个任务里更早的用户要求（每条只留一行，最近的原文仍在下面）：";
const ONE_LINE_MAX = 120;          // 一条要求折成一行时最多留这么多字
const KEEP_RATIO = 0.18;           // 留原文的用户消息预算 = 保留量 × 这个比例
const LEDGER_RATIO = 0.12;         // 台账本身的预算 = 保留量 × 这个比例（超过就折最旧的）

/* 一行：压掉换行和多余空白，截到 ONE_LINE_MAX，末尾用「…」表示截断。 */
function oneLine(content) {
  const s = String(content == null ? "" : content).replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > ONE_LINE_MAX ? s.slice(0, ONE_LINE_MAX - 1) + "…" : s;
}

/* 从整段历史里找那条台账消息。它每轮压缩后被放在摘要之后，随着轮次推进会落进可压区，
   必须在它被摘要掉之前读出来 —— 电话游戏丢的就是这一份。 */
function findLedger(history) {
  const list = Array.isArray(history) ? history : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.role === "system" && typeof m.content === "string" && m.content.indexOf(USER_LEDGER_PREFIX) === 0) {
      return { index: i, text: m.content };
    }
  }
  return null;
}

function stripLedger(history) {
  const list = Array.isArray(history) ? history : [];
  return list.filter((m) => !(m && m.role === "system" && typeof m.content === "string" && m.content.indexOf(USER_LEDGER_PREFIX) === 0));
}

/* 解析旧台账 → { folded, lines }。认不出的行照原样留着，不做二次猜测。 */
function parseLedger(text) {
  const out = { folded: 0, lines: [] };
  const s = String(text || "");
  if (s.indexOf(USER_LEDGER_PREFIX) !== 0) return out;
  for (const raw of s.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.indexOf("· ") === 0) { out.lines.push(line.slice(2)); continue; }
    const m = line.match(/更早 (\d+) 条已折叠/);
    if (m) out.folded = Number(m[1]) || 0;
  }
  return out;
}

/* 头部那行"更早 N 条已折叠"由条数决定，所以拼完整文本要留到最后一步。 */
function assemble(folded, lines) {
  const head = USER_LEDGER_PREFIX + LEDGER_TITLE;
  const foldLine = folded > 0 ? "（更早 " + folded + " 条已折叠，只在这些行之外）" : "";
  const body = lines.map((l) => "· " + l).join("\n");
  return [head, foldLine, body].filter(Boolean).join("\n");
}

/* prev = parseLedger 的结果；droppedUsers = 这一轮要从原文降级成一行的那些用户消息（时间顺序）。
   est(text) 由调用方注入（引擎用 _estTokens，单测用一个字数近似）。
   返回 "" 表示没有台账可写。 */
function buildLedger(prev, droppedUsers, opts) {
  const o = opts || {};
  const est = typeof o.est === "function" ? o.est : (t) => Math.ceil(String(t || "").length / 4);
  const budget = Number(o.budgetTokens) || 0;
  const p = prev || { folded: 0, lines: [] };
  const lines = p.lines.slice();
  let folded = p.folded | 0;
  for (const m of droppedUsers || []) {
    const l = oneLine(m && m.content);
    if (l) lines.push(l);
  }
  /* 超预算就从最旧那头折进条数，至少留最新一行。 */
  while (lines.length > 1 && est(assemble(folded, lines)) > budget) {
    lines.shift();
    folded++;
  }
  if (!lines.length && !folded) return "";
  return assemble(folded, lines);
}

/* 哪些旧用户消息还留原文：从最新往旧累加，用完预算就停。
   返回值按时间顺序（keep 是原文顺序，dropped 同样保持顺序，台账行才不会出现倒序）。 */
function pickKeepUsers(headUsers, budgetTokens, est) {
  const list = (Array.isArray(headUsers) ? headUsers : []).filter((m) => m && m.role === "user");
  const keep = [];
  let acc = 0;
  const budget = Math.max(0, Number(budgetTokens) || 0);
  for (let i = list.length - 1; i >= 0; i--) {
    const cost = est(String(list[i].content || ""));
    if (acc + cost > budget && keep.length >= 3) break;   // 至少留最近 3 条，别让"要求"整个看不见
    acc += cost;
    keep.unshift(list[i]);
  }
  const dropped = list.filter((m) => keep.indexOf(m) < 0);
  return { keep, dropped };
}

function budgetsOf(retainTokens) {
  const r = Math.max(0, Number(retainTokens) || 0);
  return { keepUsersTokens: Math.round(r * KEEP_RATIO), ledgerTokens: Math.round(r * LEDGER_RATIO) };
}

module.exports = {
  USER_LEDGER_PREFIX, LEDGER_TITLE, ONE_LINE_MAX, KEEP_RATIO, LEDGER_RATIO,
  oneLine, findLedger, stripLedger, parseLedger, assemble, buildLedger, pickKeepUsers, budgetsOf,
};
