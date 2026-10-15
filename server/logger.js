/* 结构化日志器（P0-A1）
   ————————————————————————————————————————————
   为什么要有这个文件：服务端原先只有 console.*，一行日志里没有级别、没有模块、没有
   "这次操作"的编号。于是前端弹一条"服务内部异常"，后台几十行 console 谁也对不上是哪一次；
   用户截图里的 reqId（见 ws-safe.js）更没法拿来查。

   这里定三件事：
     1) 每行带 {时间, 级别, 模块标签, reqId, 正文, 结构化上下文}；PANCODE_LOG_JSON=1 时整行 JSON。
     2) reqId 走 AsyncLocalStorage 传播——一次 WS 指令 / 一次 HTTP 请求内，
        无论中间 await 了多少层，日志都自动带上同一个 reqId，不需要层层传参。
     3) 最近 RING_MAX 条留在内存环里，/api/logs 直接读——实时诊断面板（P1）就靠它，
        不引第三方日志栈，也不往磁盘写。

   级别：PANCODE_LOG=debug|warn|error，默认 info。低于阈值的仍然入环（面板要能回看历史），
   只是不打到 stdout——"降噪"和"丢信息"是两件事。 */
"use strict";

const { AsyncLocalStorage } = require("async_hooks");

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL = process.env.PANCODE_LOG === "debug" ? 0 : process.env.PANCODE_LOG === "warn" ? 2 : process.env.PANCODE_LOG === "error" ? 3 : 1;
const JSON_MODE = process.env.PANCODE_LOG_JSON === "1";

let _reqSeq = 0;
function newReqId() {
  _reqSeq = (_reqSeq % 1000000) + 1;
  return "r" + Date.now().toString(36) + "-" + _reqSeq.toString(36);
}

const RING_MAX = 2000;
const ring = new Array(RING_MAX);
let ringHead = 0;
let ringLen = 0;
function pushRing(entry) {
  ring[ringHead] = entry;
  ringHead = (ringHead + 1) % RING_MAX;
  if (ringLen < RING_MAX) ringLen++;
}
/* 读环。可以按级别/模块/reqId 过滤——诊断面板一次拉全量再本地筛，
   命令行排障则直接按 reqId 捞那一次操作。返回顺序是"旧→新"，limit 取的是最近 limit 条。 */
function readRing(opts) {
  const o = (opts && typeof opts === "object") ? opts : { limit: opts };
  const minLevel = o.level != null ? (LEVELS[o.level] == null ? 0 : LEVELS[o.level]) : 0;
  const limit = o.limit || 200;
  const take = Math.min(limit, ringLen);
  const out = [];
  /* 从"最近 limit 条"这一段的头部（最旧的）开始扫，逐条 push，顺序天然就是旧→新 */
  for (let i = ringLen - take; i < ringLen; i++) {
    const e = ring[(ringHead - ringLen + i + RING_MAX) % RING_MAX];
    if (!e || LEVELS[e.level] < minLevel) continue;
    if (o.module && e.module !== o.module) continue;
    if (o.reqId && e.reqId !== o.reqId) continue;
    if (o.q && String(e.msg + " " + JSON.stringify(e.ctx || "")).indexOf(o.q) < 0) continue;
    out.push(e);
  }
  return out;
}

/* ALS 里同时放标签和 reqId：tag() 派生子标签时要继承当前 reqId，
   runWithReqId() 绑定 reqId 时要继承当前标签，两边都不能把它俩冲掉。 */
const store = new AsyncLocalStorage();
function currentTag() {
  const s = store.getStore();
  return (s && s.tag) || "core";
}
function currentReqId() {
  const s = store.getStore();
  return (s && s.reqId) || null;
}

function fmtCtx(ctx) {
  if (!ctx) return "";
  try { return JSON.stringify(ctx); } catch (e) { return "{ctx}"; }
}

function formatEntry(level, mod, msg, ctx, reqId) {
  const ts = new Date().toISOString();
  if (JSON_MODE) {
    return JSON.stringify({ ts, level, module: mod || "core", reqId: reqId || null, msg: String(msg), ctx: ctx && Object.keys(ctx).length ? ctx : undefined });
  }
  let line = ts + " " + String(level).padEnd(5) + " [" + (mod || "core") + "] ";
  line += msg;
  const c = fmtCtx(ctx);
  if (c && c !== "{}") line += " " + c;
  if (reqId) line += " reqId=" + reqId;
  return line;
}

/* 第一个参数允许直接扔一个 Error：正文取它的 message，堆栈首行进上下文。
   不这样做的话，调用方要么自己拆（到处重复），要么把整个 Error 交给 JSON.stringify（变成 {}）。 */
function normalize(msg, ctx) {
  if (msg instanceof Error) {
    const head = String(msg.stack || "").split("\n")[1];
    const c = Object.assign({}, ctx || {});
    if (msg.code != null) c.code = msg.code;
    if (head) c.at = head.trim();
    return { msg: msg.message || String(msg), ctx: c };
  }
  return { msg, ctx };
}

function write(level, mod, msg, ctx, reqId, writeFn) {
  const n = normalize(msg, ctx);
  const rid = reqId || currentReqId();
  const entry = { ts: new Date().toISOString(), level, module: mod || "core", reqId: rid, msg: String(n.msg), ctx: n.ctx && Object.keys(n.ctx).length ? n.ctx : undefined };
  pushRing(entry);
  if (LEVELS[level] < MIN_LEVEL) return;
  writeFn(formatEntry(level, mod, n.msg, n.ctx, rid));
}

/* 派生一个带标签的记录器：log.tag("ws").warn(...)。
   再 .tag("sub") 得到 "ws/sub"，方便一个模块内部继续分层。 */
function withTag(tagName) {
  const t = {
    debug: (m, c) => write("debug", tagName, m, c, null, console.debug),
    info: (m, c) => write("info", tagName, m, c, null, console.info),
    warn: (m, c) => write("warn", tagName, m, c, null, console.warn),
    error: (m, c) => write("error", tagName, m, c, null, console.error),
    tag: (sub) => withTag(tagName + "/" + sub),
    /* 把这一条（及其后续异步链）钉在一个 reqId 上 */
    run: (rid, fn) => store.run({ tag: tagName, reqId: rid }, fn),
    withReqId: (rid) => ({
      debug: (m, c) => write("debug", tagName, m, c, rid, console.debug),
      info: (m, c) => write("info", tagName, m, c, rid, console.info),
      warn: (m, c) => write("warn", tagName, m, c, rid, console.warn),
      error: (m, c) => write("error", tagName, m, c, rid, console.error),
    }),
  };
  return t;
}

const log = {
  debug: (m, c) => write("debug", currentTag(), m, c, null, console.debug),
  info: (m, c) => write("info", currentTag(), m, c, null, console.info),
  warn: (m, c) => write("warn", currentTag(), m, c, null, console.warn),
  error: (m, c) => write("error", currentTag(), m, c, null, console.error),
  tag: withTag,
  newReqId,
  readRing,
  reqId: currentReqId,
  /* 兼容先前写好的两个入口：runInTag 只换标签、保住 reqId；runWithReqId 只换 reqId、保住标签 */
  runInTag: (tagName, fn) => store.run({ tag: tagName, reqId: currentReqId() }, fn),
  runWithReqId: (rid, fn) => store.run({ tag: currentTag(), reqId: rid }, fn),
  level: () => (MIN_LEVEL === 0 ? "debug" : MIN_LEVEL === 2 ? "warn" : MIN_LEVEL === 3 ? "error" : "info"),
  jsonMode: () => JSON_MODE,
  ringMax: RING_MAX,
};

module.exports = log;
