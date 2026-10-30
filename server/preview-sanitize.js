/* ============================================================
   文档预览 HTML 清洗（审查项 F06）

   为什么不用"正则挑出 href 再改"那一版：
     mammoth 把 docx 转成 HTML 后，链接是模型可控的内容 —— 一份别人发来的
     文档里就能埋一条 `<a href="jav&#x0a;ascript:alert(1)">`。旧实现只做了
     `trim()` + 一个 `^scheme:` 正则，而浏览器解析 URL 时会自己吃掉
     实体与制表/换行：`jav&#x0a;ascript:` 在正则眼里没有冒号前缀、判成"相对路径"放行，
     在浏览器眼里却是 javascript:。判据和真实语义对不上，等于没拦。
     前端还是 innerHTML 直接塞进应用自己的文档里 —— 点一下就在 pancode 源内执行，
     手里带着 userToken，等于把 Agent 交出去。

   这一版换两条腿：
     1) 白名单重建：不认识的标签/属性一律丢掉，而不是"认识的危险名单再去掉"。
     2) 协议判定先做归一化（解实体 → 去掉全部空白与控制字符）再看 scheme，
        和浏览器的口径对齐；不确定的就落到 "#"。
   前端那一侧同时把预览挪进 sandbox iframe（见 public/app.js 的 showBinPreview），
   两边各挡一层：清洗漏了也不会拿到应用源的身份。
   ============================================================ */
"use strict";

/* 文档预览需要的排版标签。刻意不含 script/style/iframe/object/embed/form/input/svg/math
   —— 这些是"能执行或能外联"的那一类，正文里出现也不该出现。 */
const ALLOWED = new Set([
  "p", "br", "hr", "div", "span", "pre", "code", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "small", "big",
  "sup", "sub", "abbr", "cite", "q",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "a", "img", "figure", "figcaption",
]);
const VOID = new Set(["br", "hr", "img", "col"]);
/* 这些标签不只是"不许留标签"，它们的**内容也不是文档正文**：
   script/style 里的字符是代码，原样留成文字会在预览里显示成一段莫名其妙的东西，
   而 iframe/object 的内容是替代文字、模板内容是待展开的片段。
   所以遇到它们要一路跳到配对闭合标签，而不是只丢掉尖括号。 */
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "xmp", "head", "title"]);
/* 每个标签允许留下的属性；没列出来的标签只保留 GLOBAL_ATTRS 里那几个排版属性。 */
const ATTRS = {
  a: ["href", "title"],
  img: ["src", "alt", "title", "width", "height"],
  td: ["colspan", "rowspan"], th: ["colspan", "rowspan"],
  col: ["span"], ol: ["start", "reversed"],
};
const GLOBAL_ATTRS = ["style", "class", "dir", "lang", "align", "colspan", "rowspan", "start", "span", "title", "alt"];

const NAMED = { tab: "\t", newline: "\n", nbsp: " ", colon: ":", semi: ";", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/* 实体解码：只处理数字实体与几个真正会影响 scheme 判定的名字。
   多解一个字符不会放行危险内容，漏解一个却会让 jav&#x0a;ascript: 蒙混过关。 */
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g, (m, body) => {
    if (body[0] === "#") {
      const cp = (body[1] === "x" || body[1] === "X") ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const k = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, k) ? NAMED[k] : m;
  });
}

/* 与浏览器对齐的 URL 归一化：解实体 → 去掉所有空白与控制字符（U+0000–U+0020、U+007F）。
   做完这一步再看 scheme，才不会出现在正则里是相对路径、在浏览器里是 javascript: 的分歧。 */
function normalizeUrl(raw) {
  return decodeEntities(raw).replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
}
function safeHref(raw) {
  const s = String(raw == null ? "" : raw);
  const u = normalizeUrl(s);
  if (!u) return "#";
  if (u.startsWith("#")) return "#";                       // 页内锚点：不给它携带任何 scheme
  const colon = u.indexOf(":");
  const slash = u.indexOf("/");
  const scheme = colon > 0 && (slash < 0 || colon < slash) ? u.slice(0, colon + 1) : "";
  /* 放行时回的是**原样**（只去首尾空白），不是归一化后的那一份：
     normalizeUrl 为了判 scheme 把整串转成小写并抠掉了控制字符 —— 拿它当结果会把
     大小写敏感的查询参数（token、签名、Base64 片段）一起改坏，链接直接失效。
     归一化只用于判定，不用于交付。 */
  if (scheme === "http:" || scheme === "https:" || scheme === "mailto:") return s.trim();
  // 相对链接也不能原样放行：预览在应用源里，相对路径会解析成 pancode 自己的接口地址
  return "#";
}
/* img 的 src：mammoth 把文档内嵌图片转成 data:image/...;base64 —— 那是预览的正常内容。
   其余一律丢（外联 img 既是隐私面也是跟踪面）。 */
function imgSrc(raw) {
  const u = normalizeUrl(raw == null ? "" : String(raw));
  if (u.startsWith("data:image/png;base64,") || u.startsWith("data:image/jpeg;base64,")
    || u.startsWith("data:image/gif;base64,") || u.startsWith("data:image/webp;base64,")
    || u.startsWith("data:image/svg+xml;base64,")) return String(raw);
  return "";
}
/* style 值清洗：只挡"能外联或能执行"的关键字，排版（对齐、字号、颜色）原样保留。 */
function styleValue(raw) {
  const v = decodeEntities(String(raw == null ? "" : raw));
  if (/url\s*\(|expression\s*\(|javascript\s*:|@import|behavior\s*:|-moz-binding/i.test(v)) return "";
  return v.replace(/[<>]/g, "").slice(0, 400);
}

function escAttr(v) {
  return String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* href 专用：值本身已经是"属性里取出来的那一份"，& 多半是 &amp; 这样的合法实体，
   再转义一次会变成 &amp;amp; 把链接改坏。这里只堵会破坏引号边界的字符。 */
function escHref(v) {
  return String(v).replace(/["<>&\u0000-\u001f\u007f]/g, (c) => (c === '"' ? "&quot;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : ""));
}

const TAG_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/\s*([a-zA-Z][^\s>]*)\s*>|<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

function attrsOf(chunk) {
  const out = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(chunk))) out.push({ name: String(m[1]).toLowerCase(), value: m[2] != null ? m[2] : (m[3] != null ? m[3] : (m[4] != null ? m[4] : "")) });
  return out;
}

function rebuildTag(name, attrChunk, selfClose) {
  const lower = String(name).toLowerCase();
  if (!ALLOWED.has(lower)) return "";
  const allow = new Set((ATTRS[lower] || []).concat(GLOBAL_ATTRS));
  const parts = [];
  for (const a of attrsOf(attrChunk || "")) {
    if (a.name.startsWith("on")) continue;                       // 事件处理器一律丢
    if (!allow.has(a.name)) continue;
    if (a.name === "href") { parts.push('href="' + escHref(safeHref(a.value)) + '"'); continue; }
    if (a.name === "src") {
      const s = imgSrc(a.value);
      if (!s) continue;
      parts.push('src="' + escAttr(s) + '"');
      continue;
    }
    if (a.name === "style") {
      const s = styleValue(a.value);
      if (s) parts.push('style="' + escAttr(s) + '"');
      continue;
    }
    if (a.name === "class" || a.name === "title" || a.name === "alt" || a.name === "dir" || a.name === "lang") {
      parts.push(a.name + '="' + escAttr(a.value).slice(0, 300) + '"');
      continue;
    }
    if (/^(colspan|rowspan|start|span|width|height)$/.test(a.name)) {
      const n = parseInt(a.value, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 10000) parts.push(a.name + '="' + n + '"');
      continue;
    }
    if (a.name === "reversed") parts.push("reversed");
  }
  if (lower === "a") parts.push('target="_blank" rel="noopener noreferrer"');
  return "<" + lower + (parts.length ? " " + parts.join(" ") : "") + (selfClose || VOID.has(lower) ? " />" : ">");
}

/* 主入口：把任意 HTML 重建成"只含排版标签、链接与图片都被管住"的一份。
   不认识的标签整个丢掉（连它自己的尖括号），但保留其中的文字 ——
   文档正文比"某个标签没在白名单里"重要得多，丢文字会让用户以为文档内容被吃了。 */
function sanitizePreviewHtml(html) {
  const src = String(html == null ? "" : html);
  let out = "";
  let cursor = 0;
  const stack = [];
  let skip = null;      // 正在整体丢弃的标签名（script/style/iframe/…），连内容一起跳到配对闭合
  let skipDepth = 0;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(src))) {
    const whole = m[0];
    if (skip) {
      /* 跳到配对闭合为止，中间的文本一个字都不进输出。
         嵌套同名（<style><style>）按深度计，免得内层闭合把外层提前放出来。 */
      if (m[1] && String(m[1]).toLowerCase() === skip) {
        if (--skipDepth <= 0) { skip = null; skipDepth = 0; }
      } else if (!m[1] && String(m[2] || "").toLowerCase() === skip) {
        skipDepth++;
      }
      cursor = TAG_RE.lastIndex;
      continue;
    }
    out += textOf(src.slice(cursor, m.index));
    cursor = TAG_RE.lastIndex;
    if (whole.startsWith("<!")) continue;                        // 注释 / CDATA / DOCTYPE 全丢
    if (m[1]) {                                                 // 闭合标签
      const close = String(m[1]).toLowerCase();
      if (DROP_WITH_CONTENT.has(close)) continue;
      if (!ALLOWED.has(close)) continue;
      const top = stack[stack.length - 1];
      if (top === close) { stack.pop(); out += "</" + close + ">"; }
      else if (stack.includes(close)) {
        while (stack.length && stack[stack.length - 1] !== close) { out += "</" + stack.pop() + ">"; }
        stack.pop(); out += "</" + close + ">";
      }
      continue;
    }
    const name = String(m[2]);
    const chunk = m[3] || "";
    const selfClose = /\/\s*$/.test(chunk);
    const lower = name.toLowerCase();
    if (DROP_WITH_CONTENT.has(lower)) {
      if (!selfClose) { skip = lower; skipDepth = 1; }
      continue;
    }
    const rendered = rebuildTag(lower, chunk.replace(/\/\s*$/, ""), selfClose);
    if (!rendered) continue;
    out += rendered;
    if (!selfClose && !VOID.has(lower)) stack.push(lower);
  }
  if (!skip) out += textOf(src.slice(cursor));
  while (stack.length) out += "</" + stack.pop() + ">";
  return out;
}

/* 文本节点：转义掉裸 < > &，实体原样保留（mammoth 输出的正文里本来就带实体的形式）。 */
function textOf(t) {
  return String(t).replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* 给"确实被改掉"的链接留一个可数的痕迹：清洗不该是静默的，
   否则用户永远不会知道那份文档里埋了什么。 */
function auditPreview(html) {
  const src = String(html == null ? "" : html);
  const hrefs = [...src.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((x) => x[1] != null ? x[1] : x[2]);
  const risky = hrefs.filter((h) => {
    const u = normalizeUrl(h);
    if (!u || u.startsWith("#")) return false;
    const colon = u.indexOf(":"), slash = u.indexOf("/");
    const scheme = colon > 0 && (slash < 0 || colon < slash) ? u.slice(0, colon + 1) : "";
    return scheme !== "http:" && scheme !== "https:" && scheme !== "mailto:";
  });
  return { links: hrefs.length, rewritten: risky.length, samples: risky.slice(0, 3).map((s) => String(s).slice(0, 60)) };
}

module.exports = { sanitizePreviewHtml, normalizeUrl, auditPreview, ALLOWED };
