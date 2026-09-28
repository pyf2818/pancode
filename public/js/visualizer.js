/* ============================================================
   W5 · Visualizer — 消息流内联可视化
   ------------------------------------------------------------
   - Agent 输出 ```widget / ```svg / ```diagram 代码块时，
     renderChatMD 调用 renderWidgetCard 生成沙箱 iframe 卡片内联渲染。
   - 安全：iframe sandbox="allow-scripts"（无 allow-same-origin）——
     LLM 生成的 HTML/SVG 是半可信内容，绝不允许触达主页面 DOM/存储。
   - 下载：opaque origin 读不了 contentDocument → 原文存 JS 注册表
     （按 id 取，LRU 封顶防泄漏）；SVG 可下 .svg / .png，HTML 可新窗打开。
   - 主题：bridge 读 prefers-color-scheme + 监听父页 postMessage；
     父侧用 MutationObserver 监听 <html data-theme> 变化广播（零侵入 app.js）。
   ============================================================ */
"use strict";

const WG_REGISTRY = new Map();  // wgId -> { body, lang }
const WG_REG_MAX = 30;
let wgSeq = 0;

/* widget 内嵌页样式：透明背景 + 深浅色自适应（currentColor 优先） */
const WG_CSS =
  "html,body{margin:0;padding:0;background:transparent}" +
  "body{font-family:inherit;color:CanvasText;padding:8px 10px}" +
  "svg{max-width:100%;height:auto;display:block;margin:0 auto}" +
  "table{border-collapse:collapse;font-size:12px}" +
  "td,th{border:1px solid rgba(128,128,128,.4);padding:4px 8px}" +
  "@media (prefers-color-scheme: dark){body{color:#e8e8e8}}";

/* 注入 iframe 的自适应高度桥 */
const WG_BRIDGE = '<script>(function(){var P=function(){try{var h=Math.ceil(Math.max(document.body?document.body.scrollHeight:0,document.documentElement?document.documentElement.scrollHeight:0));parent.postMessage({__wgH:h},"*")}catch(e){}};' +
  'window.addEventListener("load",P);window.addEventListener("resize",P);' +
  'window.addEventListener("message",function(e){var d=e.data;if(d&&d.__wgTheme){document.documentElement.style.colorScheme=d.__wgTheme;}});' +
  'if(document.readyState!=="loading")P();})();<\/script>';

/* 由 renderChatMD 调用：把 widget 代码块原文渲染为沙箱卡片 */
function renderWidgetCard(body, lang) {
  body = String(body || "");
  if (body.length > 60 * 1024) return '<div class="msg-widget wg-err">可视化内容过大（>60KB），已跳过渲染</div>';
  const id = "wg" + (++wgSeq) + "_" + Math.random().toString(36).slice(2, 6);
  WG_REGISTRY.set(id, { body, lang: String(lang || "widget") });
  if (WG_REGISTRY.size > WG_REG_MAX) {
    const first = WG_REGISTRY.keys().next().value;
    WG_REGISTRY.delete(first);
  }
  const isSvg = /^\s*<svg[\s>]/i.test(body);
  const doc = "<!DOCTYPE html><html><head><meta charset='utf-8'><style>" + WG_CSS + "</style></head><body>" + body + WG_BRIDGE + "</body></html>";
  const srcdoc = doc.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const head = '<div class="wg-head"><span class="wg-title">' + (isSvg ? "可视化 · SVG" : "可视化 · HTML") + "</span>" +
    '<span style="flex:1"></span>' +
    (isSvg
      ? '<button class="wg-btn" data-wg="' + id + '" data-act="svg" type="button">下载 SVG</button>' +
        '<button class="wg-btn" data-wg="' + id + '" data-act="png" type="button">下载 PNG</button>'
      : '<button class="wg-btn" data-wg="' + id + '" data-act="open" type="button">新窗口打开</button>') +
    "</div>";
  return '<div class="msg-widget" data-wgbox="' + id + '">' + head +
    '<iframe class="wg-frame" sandbox="allow-scripts" srcdoc="' + srcdoc + '" style="height:80px"></iframe></div>';
}

/* 高度自适应：iframe 桥回报高度 → 调整（封顶 480px，超出内部滚动） */
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.__wgH == null) return;
  const frames = document.querySelectorAll(".wg-frame");
  for (const f of frames) {
    if (f.contentWindow === e.source) {
      f.style.height = Math.min(Math.max(48, Number(d.__wgH) || 80), 480) + "px";
      break;
    }
  }
});

/* 主题广播：html[data-theme] 变化 → 通知所有 widget iframe */
const _wgThemeOb = new MutationObserver(() => {
  const t = document.documentElement.getAttribute("data-theme") || "light";
  document.querySelectorAll(".wg-frame").forEach((f) => {
    try { f.contentWindow.postMessage({ __wgTheme: t }, "*"); } catch (e) {}
  });
});
_wgThemeOb.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

/* 下载工具 */
function _wgDownload(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}
function _wgSvgBlob(body) {
  let svg = body.trim();
  if (!/^<\?xml/i.test(svg)) svg = '<?xml version="1.0" encoding="UTF-8"?>\n' + svg;
  return new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
}
function _wgSvgToPng(body, cb) {
  const url = URL.createObjectURL(_wgSvgBlob(body));
  const img = new Image();
  img.onload = () => {
    const w = img.naturalWidth || 800, h = img.naturalHeight || 480;
    const scale = Math.min(2, 1600 / Math.max(w, 1));
    const cv = document.createElement("canvas");
    cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#ffffff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(url);
    cv.toBlob((b) => cb(b), "image/png");
  };
  img.onerror = () => { URL.revokeObjectURL(url); cb(null); };
  img.src = url;
}

/* 事件委托：下载按钮（一次性绑定） */
document.addEventListener("click", (e) => {
  const btn = e.target && e.target.closest && e.target.closest(".wg-btn");
  if (!btn) return;
  const rec = WG_REGISTRY.get(btn.dataset.wg);
  if (!rec) { toast("可视化内容已过期，请让 AI 重新生成"); return; }
  const act = btn.dataset.act;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  if (act === "svg") { _wgDownload(_wgSvgBlob(rec.body), "diagram-" + stamp + ".svg"); toast("已下载 SVG"); }
  else if (act === "png") {
    _wgSvgToPng(rec.body, (b) => { if (b) { _wgDownload(b, "diagram-" + stamp + ".png"); toast("已下载 PNG"); } else toast("PNG 转换失败"); });
  } else if (act === "open") {
    const blob = new Blob([rec.body], { type: "text/html;charset=utf-8" });
    _wgDownload; // no-op 引用规避 lint
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
});
