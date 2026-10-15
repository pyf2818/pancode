/* pancode 纯工具函数模块 —— 从 app.js 抽出，零状态依赖
   加载顺序：core.js → icons.js → utils.js → app.js */
"use strict";

function diffStat(a, b) {
  /* 两侧都按 \r?\n 切：original 是服务端读回来的原文（Windows 上是 CRLF），
     编辑器与 Agent 写的是 LF —— 直接 split("\n") 会让每一行都算"改过"，
     实测 4 行真改动被报成 +1287 −1287。 */
  const cut = (s) => String(s).replace(/\r\n/g, "\n").split("\n");
  const cnt = (arr) => { const m = {}; arr.forEach((l) => (m[l] = (m[l] || 0) + 1)); return m; };
  const A = cnt(cut(a)), B = cnt(cut(b));
  let add = 0, del = 0;
  for (const l in B) { const d = B[l] - (A[l] || 0); if (d > 0) add += d; }
  for (const l in A) { const d = A[l] - (B[l] || 0); if (d > 0) del += d; }
  return { add, del };
}

function fmtSize(n) {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

/* 主题：cw-theme 存偏好（auto|light|dark），getTheme() 返回解析后的实际主题。
   auto 档跟随系统（Electron 中 prefers-color-scheme 由 nativeTheme 驱动）。 */
function getThemePref() { return localStorage.getItem("cw-theme") || "auto"; }

function getSystemTheme() {
  try { return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"; }
  catch (e) { return "dark"; }
}

function getTheme() {
  const pref = getThemePref();
  return pref === "auto" ? getSystemTheme() : pref;
}

function extOf(p) { return String(p).split(".").pop().toLowerCase(); }

function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function monacoLangOf(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return ({ js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    json: "json", html: "html", htm: "html", css: "css", scss: "scss", md: "markdown", py: "python",
    sh: "shell", yml: "yaml", yaml: "yaml", txt: "plaintext" })[ext] || "plaintext";
}

function fmtTok(n) { n = n || 0; return n >= 1000 ? (Math.round(n / 100) / 10) + "k" : "" + n; }

function toast(msg) {
  let t = $("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 1800);
}

/* ============================================================
   持续型提示（修 E-M2：限流退避原来只有工具栏一行静态文字，
   用户既看不到还剩几秒，也不知道这是自动重试不是卡死）
   —— 与 toast() 分开的原因：toast 复用同一个 DOM 节点且 1.8s 自动消失，
   倒计时要活几十秒、期间每 200ms 刷新一次，还会挡在输入区正中间。
   用独立节点 + 自己的定时器，两者互不打断。
   ============================================================ */
let _holdTimer = null;
function toastHold(msg, opts) {
  const o = opts || {};
  let t = $("toastHold");
  if (!t) {
    t = document.createElement("div");
    t.id = "toastHold"; t.className = "toast toast-hold";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  const holdMs = Number(o.holdMs) || 0;
  const hideIn = Number(o.hideInMs) || 0;
  clearTimeout(_holdTimer);
  if (hideIn > 0) _holdTimer = setTimeout(() => toastHoldHide(), hideIn);
  return t;
}
function toastHoldHide() {
  clearTimeout(_holdTimer); _holdTimer = null;
  const t = $("toastHold");
  if (t) t.classList.remove("show");
}

/* 限流倒计时：waitSec 秒内每 250ms 刷新一次剩余秒数，归零后自己收起。
   服务端每次真的开始重试会再发一条 agent.backoff，toastHoldHide 先行，
   所以"重试第 2 次"会重新起一个倒计时，不会出现两个数字叠着。 */
function toastCountdown(totalSec, label) {
  const total = Math.max(1, Math.ceil(Number(totalSec) || 1));
  const until = Date.now() + total * 1000;
  const step = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (left <= 0) { toastHoldHide(); return; }
    toastHold((label || "被限流") + "，" + left + " 秒后自动重试（与历史长度无关，压缩无用）");
    setTimeout(step, 250);
  };
  step();
}

/* ============================================================
   带容量上限的存储（修 S-H3：会话快照无上限 + 写失败被空 catch 吞掉）
   ------------------------------------------------------------
   两个问题，一个根：cw-convdom-* 每存一次就把整棵消息树的 HTML
   写进 localStorage，且失败是 try{...}catch(e){} 静默吞掉。
   浏览器 localStorage 一般 5~10MB，写满后 setItem 抛
   QuotaExceededError —— 而这里什么都不做，于是「聊天记录不保存了」
   这个故障要到用户重启、发现历史全没了才知道。

   做法：LRU 记账（一个 pancode:lsorder 索引）+ 写失败时先淘汰最老
   的会话快照重试一次，仍失败才提示（提示只弹一次，不刷屏）。
   ============================================================ */
const LS_MAX_BYTES = 4 * 1024 * 1024;   // 自设上限，低于浏览器配额，留出余量
const LS_PREFIXES = ["cw-convdom-v1:", "pancode:pinned:"];
let _lsOrder = null;
function _lsOrderKey() { return "pancode:lsorder"; }
function lsOrder() {
  if (_lsOrder) return _lsOrder;
  try { _lsOrder = JSON.parse(localStorage.getItem(_lsOrderKey())) || []; }
  catch (e) { _lsOrder = []; }
  if (!Array.isArray(_lsOrder)) _lsOrder = [];
  return _lsOrder;
}
function _lsSaveOrder() {
  try { localStorage.setItem(_lsOrderKey(), JSON.stringify(_lsOrder)); } catch (e) {}
}
/* 记一次访问：把 key 移到队尾（队头 = 最老）。
   只记可淘汰的那些——偏好类 key（cw-theme 之类）本来就永远不会被牺牲，
   进索引只会把索引撑大、并让"最老"算错。 */
function lsTouch(key) {
  if (!LS_PREFIXES.some((p) => String(key).indexOf(p) === 0)) return;
  const o = lsOrder();
  const i = o.indexOf(key);
  if (i >= 0) o.splice(i, 1);
  o.push(key);
  while (o.length > 400) o.shift();      // 索引自身也收敛，别变成新的泄漏点
  _lsSaveOrder();
}
/* 只淘汰我们自己写的会话快照，绝不动 cw-theme / cw-fontsize 这类偏好。 */
function lsEvictOldest() {
  const o = lsOrder();
  while (o.length) {
    const victim = o.shift();
    if (!victim) break;
    if (!LS_PREFIXES.some((p) => victim.indexOf(p) === 0)) continue;
    try { localStorage.removeItem(victim); _lsSaveOrder(); return victim; } catch (e) {}
  }
  return null;
}
let _lsWarned = false;
function lsWarnFull(err) {
  if (_lsWarned) return;
  _lsWarned = true;
  toastHold("浏览器存储已满，更早的聊天记录可能无法保存（可在设置里清理旧会话）", { hideInMs: 6000 });
  if (window.console && console.warn) console.warn("[ls] 存储写满：", err);
}
/* 带淘汰重试的写入。返回是否成功——调用方据此知道「这条没存上」。 */
function lsSet(key, val) {
  try { localStorage.setItem(key, val); lsTouch(key); return true; }
  catch (e) {
    lsEvictOldest();
    try { localStorage.setItem(key, val); lsTouch(key); return true; }
    catch (e2) { lsWarnFull(e2); return false; }
  }
}
function lsGet(key) { try { lsTouch(key); return localStorage.getItem(key); } catch (e) { return null; } }

function colorizeDiffText(text) {
  return text.split("\n").map((l) => {
    if (l.startsWith("+")) return '<span class="add">' + esc(l) + "</span>";
    if (l.startsWith("-")) return '<span class="del">' + esc(l) + "</span>";
    return esc(l);
  }).join("\n");
}

function showConfirm(title, msg, onOk) {
  const m = $("confirmModal");
  if (!m) { if (confirm(msg.replace(/<[^>]+>/g, ""))) onOk(); return; }
  $("confirmTitle").textContent = title;
  $("confirmMsg").innerHTML = msg;
  replaceIcons(m);
  m.style.display = "flex";
  const ok = $("confirmOk"), cancel = $("confirmCancel");
  const cleanup = () => { m.style.display = "none"; ok.onclick = null; cancel.onclick = null; };
  ok.onclick = () => { cleanup(); onOk(); };
  cancel.onclick = cleanup;
}

/* model URI → 工作区相对路径。
   不能写 `uri.toString().replace("inmemory:///", "")`：Monaco 会把空 authority 规整掉，
   toString() 实际给出 "inmemory:/src/a.js"，那个 replace 匹配不上 ——
   于是补全请求里的 "File:" 一直是带 scheme 的垃圾串（模型看到的文件名是错的）。
   取 uri.path 这一段才是稳的。 */
function uriToRelPath(uri) {
  if (!uri) return "";
  try { if (typeof uri.path === "string" && uri.path) return uri.path.replace(/^\/+/, ""); } catch (e) {}
  const s = String(uri.toString ? uri.toString() : uri);
  return s.replace(/^[a-zA-Z]+:\/\//, "").replace(/^\/+/, "");
}

/* ============================================================
   事件监听器清理封装（P0-A2）
   —— 返回 disposer 函数，便于统一清理，避免内存泄漏
   ============================================================ */
function onEvent(el, type, handler, opts) {
  if (!el || !type || !handler) return function() {};
  try { el.addEventListener(type, handler, opts); } catch (e) {}
  return function off() {
    try { if (el && el.removeEventListener) el.removeEventListener(type, handler, opts); } catch (e) {}
  };
}
const on = onEvent;

function offEvent(el, type, handler, opts) {
  if (!el || !type || !handler) return;
  try { if (el.removeEventListener) el.removeEventListener(type, handler, opts); } catch (e) {}
}
const off = offEvent;

function onceEvent(el, type, handler, opts) {
  if (!el || !type || !handler) return function() {};
  let disposed = false;
  const wrapped = function(e) {
    if (disposed) return;
    disposed = true;
    try { el.removeEventListener(type, wrapped, opts); } catch (ex) {}
    return handler.call(this, e);
  };
  try { el.addEventListener(type, wrapped, opts); } catch (e) {}
  return function off() {
    if (disposed) return;
    disposed = true;
    try { if (el && el.removeEventListener) el.removeEventListener(type, wrapped, opts); } catch (e) {}
  };
}
const once = onceEvent;

function disposeAll(disposers) {
  if (!Array.isArray(disposers)) return;
  for (let i = 0; i < disposers.length; i++) {
    const d = disposers[i];
    if (typeof d === "function") { try { d(); } catch (e) {} }
  }
}