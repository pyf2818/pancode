"use strict";
/* ============================================================
   页面行为断言的纯逻辑层（browser_assert 用）。
   ————————————————————————————————————————————
   为什么单独一个文件而不是埋在 handler 里：
   1) 判据要能离线单测。埋在 handler 里就只能靠真浏览器跑一遍才知道「包含/相等」判错没有，
      而这条工具存在的意义恰恰是"别再靠肉眼读快照" ——判据本身更不能靠肉眼。
   2) 页面里执行的那段 JS 必须是**我们写的固定程序**：模型能影响的只有 kind / sel / attr 三个数据位，
      它们一律经 JSON.stringify 成为字面量。断言的数学全在 Node 侧做，
      这样选择器写错只会得到"没有这个元素"，不会得到"执行了模型给的代码"。
   3) 与 test-runner.js 同一分工：那一层把 `npm test` 的输出版成 file:line，这一层把
      页面状态版成「期望 / 实得」，两边都不让模型自己脑补"应该算通过了吧"。
   ============================================================ */
const MAX_ASSERTS = 20;            // 一次最多验 20 条：再多这条回执比它替代的 snapshot 还长
const ACTUAL_MAX = 300;            // 实得值截这么长（比对够用，不把整页文字拖回上下文）
const KINDS = ["exists", "visible", "text", "value", "attr", "count", "checked", "enabled", "url", "title"];
/* 不给 expected 就没法判的几类：省略 expected 时不能猜"那就算存在吧"，
   那种默认值会让一条写漏的断言永远通过（假绿比红更糟）。 */
const NEEDS_EXPECTED = ["text", "value", "attr", "count", "url", "title"];
const NO_SEL = ["url", "title"];

/* 固定观察程序：读 DOM 返回 JSON 数组，顺序与 items 一致。
   ⚠ 只取 kind / sel / attr 三个字段，**在函数内部**做这件事而不是指望调用方先过滤：
   expected / contains 这些判据留在 Node 侧，页面上多一份就多一处能被内容影响的地方。 */
function assertProbeScript(items) {
  const data = (Array.isArray(items) ? items : []).map((i) => ({
    kind: String((i && i.kind) || ""), sel: String((i && i.sel) || ""), attr: String((i && i.attr) || ""),
  }));
  return "(()=>{const q=(s)=>{try{return document.querySelector(s)}catch(e){return null}};" +
    "const vis=(e)=>{if(!e)return false;const cs=getComputedStyle(e);" +
    "if(cs.display==='none'||cs.visibility==='hidden')return false;" +
    "const r=e.getBoundingClientRect();return (r.width>0&&r.height>0&&(e.offsetParent!==null||cs.position==='fixed'));};" +
    "const g=(e,n)=>{const v=e.getAttribute(n);return v===null?null:String(v)};" +
    "const out=" + JSON.stringify(data) + ".map((it)=>{const o={kind:it.kind,sel:it.sel};" +
    "if(it.kind==='url'){o.url=location.href;return o;}" +
    "if(it.kind==='title'){o.text=document.title;return o;}" +
    "if(it.kind==='count'){o.count=document.querySelectorAll(it.sel).length;return o;}" +
    "const e=q(it.sel);o.found=!!e;if(!e)return o;" +
    "if(it.kind==='text')o.text=String(e.textContent||'').replace(/\\s+/g,' ').trim();" +
    "if(it.kind==='value')o.value=e.value===undefined?null:String(e.value);" +
    "if(it.kind==='attr')o.attr=g(e,it.attr||'');" +
    "if(it.kind==='visible'||it.kind==='checked'||it.kind==='enabled'){o.visible=vis(e);o.checked=!!e.checked;o.enabled=e.disabled!==true;}" +
    "return o;});return JSON.stringify(out);})()";
}

const trunc = (v) => {
  const s = v === null || v === undefined ? String(v) : String(v);
  return s.length > ACTUAL_MAX ? s.slice(0, ACTUAL_MAX) + "…" : s;
};

/* 一条观察值 vs 一条期望。判不过时 actual 必须带出去：
   模型看不到实得值就只能再截一次图猜，那是白烧一轮。 */
function judge(a, o) {
  o = o || {};
  const strCmp = (got, what) => {
    const want = String(a.expected === undefined ? "" : a.expected);
    if (typeof got !== "string") return { pass: false, actual: o.found === false ? "没有这个元素" : "(" + what + "读不出来)", wantDesc: "「" + want + "」" };
    if (a.contains === true) return { pass: got.includes(want), actual: trunc(got), wantDesc: "包含「" + want + "」" };
    return { pass: got === want, actual: trunc(got), wantDesc: "等于「" + want + "」" };
  };
  const wantBool = a.expected !== false;
  switch (a.kind) {
    case "exists":
      return { pass: !!o.found === wantBool, actual: o.found ? "在" : "不在", wantDesc: wantBool ? "存在" : "不存在" };
    case "visible":
      return { pass: !!o.found && (o.visible === true) === wantBool, actual: o.found ? (o.visible ? "可见" : "在但不可见") : "没有这个元素", wantDesc: wantBool ? "可见" : "不可见" };
    case "checked":
      return { pass: !!o.found && (o.checked === true) === wantBool, actual: o.found ? (o.checked ? "已勾" : "未勾") : "没有这个元素", wantDesc: wantBool ? "已勾" : "未勾" };
    case "enabled":
      return { pass: !!o.found && (o.enabled === true) === wantBool, actual: o.found ? (o.enabled ? "可用" : "禁用") : "没有这个元素", wantDesc: wantBool ? "可用" : "禁用" };
    case "count": {
      const want = Number(a.expected);
      return { pass: Number.isFinite(want) && o.count === want, actual: o.count === undefined ? "(读不出来)" : String(o.count), wantDesc: "元素数 = " + a.expected };
    }
    case "text": return strCmp(o.text, "文本");
    case "value": return strCmp(o.value, "值");
    case "attr": return strCmp(o.attr, "属性");
    case "url": return strCmp(o.url, "地址");
    case "title": return strCmp(o.text, "标题");
    default: return { pass: false, actual: "(不认识的断言 kind)", wantDesc: "" };
  }
}

/* 回执里那一行的名字：模型写的 name 优先，没有就按形状拼一句。 */
function descOf(a) {
  const named = a.name ? String(a.name).slice(0, 60) + " · " : "";
  if (a.kind === "url") return named + "地址";
  if (a.kind === "title") return named + "标题";
  if (a.kind === "count") return named + "数量 " + a.sel;
  const at = a.kind === "attr" ? "[" + String(a.attr || a.name || "") + "]" : "";
  return named + a.kind + " " + a.sel + at;
}

/* 清单校验：坏项一律先挑出来、整批不执行。
   为什么不做"跳过坏项继续验其余"：模型会看到一份少了两条的通过回执，
   而少的恰好是它最想验的那条。 */
function validate(list) {
  const items = []; const bad = [];
  (Array.isArray(list) ? list : []).forEach((a, i) => {
    const kind = String((a && a.kind) || "");
    const sel = a && a.sel !== undefined ? String(a.sel) : "";
    if (!KINDS.includes(kind)) { bad.push((i + 1) + ") kind 不认识：" + (kind || "(空)") + "，可选 " + KINDS.join(" / ")); return; }
    if (!sel && !NO_SEL.includes(kind)) { bad.push((i + 1) + ") " + kind + " 缺 sel（CSS 选择器）"); return; }
    if (sel.length > 300) { bad.push((i + 1) + ") sel 太长（" + sel.length + " 字符），换一个短的"); return; }
    if (NEEDS_EXPECTED.includes(kind) && a.expected === undefined) { bad.push((i + 1) + ") " + kind + " 缺 expected（不给你就拿它跟什么比）"); return; }
    if (kind === "attr" && !a.attr && !a.name) { bad.push((i + 1) + ") attr 缺 attr（要读哪个属性名）"); return; }
    items.push({ kind, sel, attr: String(a.attr || ""), label: descOf(a), src: a });
  });
  return { items, bad };
}

module.exports = { MAX_ASSERTS, KINDS, NEEDS_EXPECTED, NO_SEL, assertProbeScript, judge, descOf, validate, trunc, ACTUAL_MAX };
