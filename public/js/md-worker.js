/* W9 · markdown 渲染经典 Worker（零构建依赖，自包含副本）
   职责：流式 msg.delta 的全量 markdown 重渲染移出主线程，消除长回复打字期卡顿。
   语义对齐说明：
   - esc 与 js/core.js 同实现（& < > 三替换）；
   - renderChatMD 与 app.js 主线程版逐行同构；renderWidgetCard 在 Worker 内不存在，
     typeof 守卫自然走「普通代码块」分支 —— 与 W5 约定一致（widget 块流式期按代码预览，
     msg.end 由主线程同步渲染升级为沙箱卡片）。
   协议：postMessage({ id, src }) → postMessage({ id, html })；挂掉由主线程 onerror 兜底回退。 */
"use strict";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* 与主线程同口径的围栏识别：行首可带空白，反引号可多于三个，闭合不少于开围栏。 */
const FENCE_OPEN = /^[ \t\u00a0\u3000\u200b\ufeff]*(`{3,})(\w*)[ \t]*$/;
const FENCE_CLOSE = /^[ \t\u00a0\u3000\u200b\ufeff]*(`{3,})[ \t]*$/;
function fenceOpen(line) {
  const m = String(line).match(FENCE_OPEN);
  return m ? { ticks: m[1].length, lang: m[2] || "" } : null;
}
function fenceCloses(line, ticks) {
  const m = String(line).match(FENCE_CLOSE);
  return !!m && m[1].length >= ticks;
}

function renderChatMD(src) {
  if (!src) return "";
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let listBuf = [], inList = false, inOrdered = false;
  const flushList = () => {
    if (!listBuf.length) return;
    const tag = inOrdered ? "ol" : "ul";
    html += "<" + tag + ">" + listBuf.map((x) => "<li>" + inlineMD(x) + "</li>").join("") + "</" + tag + ">";
    listBuf = []; inList = false; inOrdered = false;
  };
  const inlineMD = (t) => {
    let h = esc(t);
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return h;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    /* 与主线程同口径：围栏前允许空格 / NBSP / 全角空格（模型输出常见）。
       只认行首三反引号时，这类块会整段退化成普通段落。 */
    const fence = fenceOpen(line);
    if (fence) {
      flushList();
      const lang = fence.lang;
      const code = [];
      i++;
      let closed = false;
      while (i < lines.length && !fenceCloses(lines[i], fence.ticks)) { code.push(lines[i]); i++; }
      if (i < lines.length) { closed = true; i++; }
      if (closed && /^(widget|svg|diagram)$/i.test(lang) && typeof renderWidgetCard === "function") {
        html += renderWidgetCard(code.join("\n"), lang);
        continue;
      }
      html += '<div class="code-block"><div class="code-head"><span class="code-lang">' + esc(lang || "code") +
        '</span><button class="copy-btn" type="button">复制</button></div><pre class="' + esc(lang) +
        '">' + esc(code.join("\n")) + "</pre></div>";
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushList(); const lv = h[1].length; html += "<h" + lv + ">" + inlineMD(h[2]) + "</h" + lv + ">"; i++; continue; }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { flushList(); html += "<blockquote>" + inlineMD(bq[1]) + "</blockquote>"; i++; continue; }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) { if (!inList || inOrdered) { flushList(); inList = true; inOrdered = false; } listBuf.push(ul[1]); i++; continue; }
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) { if (!inList || !inOrdered) { flushList(); inList = true; inOrdered = true; } listBuf.push(ol[1]); i++; continue; }
    if (line.trim() === "") { flushList(); i++; continue; }
    flushList();
    html += "<p>" + inlineMD(line) + "</p>";
    i++;
  }
  flushList();
  return html;
}

self.onmessage = (e) => {
  const d = e.data || {};
  if (typeof d.id !== "number") return;
  let html = "";
  try { html = renderChatMD(d.src); } catch (err) { html = ""; }
  self.postMessage({ id: d.id, html: html });
};
