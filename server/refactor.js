/* ============================================================
   P2-C2 · 跨文件重构的底层：整词命中 + 字面量/注释屏蔽 + 倒序替换

   为什么不是"真符号级"改名：这个仓库不引需要编译的解析器
   （server/code-index.js:7 的既有纪律），repo-map 只有按行的正则符号表，
   server/ 里没有任何 references / callGraph（grep 过，零命中）。
   所以这里做的是能站得住的那一档：标识符边界匹配 + 字面量与注释屏蔽，
   落盘交给 edit_files 的原子通道（见 server/tools/refactor-tools.js）。

   工具链只做"文本层"的判断，判断不准时一律偏向"少屏蔽"：
   少屏蔽 = 多改一处，预览里看得见；多屏蔽 = 漏改，没人会发现。
   ============================================================ */
"use strict";

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/;
const ID_CHAR = /[A-Za-z0-9_$]/;
const MAX_BYTES = 1500 * 1024;          // 超过就不扫：一个 lock 文件能吃掉整轮时间
const DOC_EXT = /^(md|markdown|txt|json|jsonc|ya?ml|toml|csv|lock|ini|cfg|conf|svg|xml|html|htm|css|scss|less|log)$/i;
const JS_EXT = /^(js|mjs|cjs|jsx|ts|tsx|vue)$/i;
const PY_EXT = /^(py|rb|sh|bash|zsh|pl)$/i;
const C_EXT = /^(go|java|kt|kts|rs|c|h|cpp|hpp|cc|cs|swift|m|scala|dart|php)$/i;
const DECL_WORDS = "(?:function|class|const|let|var|def|fn|struct|interface|type|enum|sub)";

/* 语言只决定"注释和字符串长什么样"；认不出的一律按 doc 处理（默认不参与改名）。 */
function langOf(p) {
  const ext = String(p).split(".").pop() || "";
  if (JS_EXT.test(ext)) return "js";
  if (PY_EXT.test(ext)) return "py";
  if (C_EXT.test(ext)) return "c";
  if (DOC_EXT.test(ext)) return "doc";
  return "doc";
}
const isDoc = (p) => langOf(p) === "doc";
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* 把字符串 / 模板 / 注释区间盖成空格，长度与位置一一对应，
   于是"在屏蔽结果里搜到的命中"必然落在代码区。
   JS 模板串的 ${…} 插值回到代码态；正则字面量按"前一个有效字符"启发式识别。 */
function maskNonCode(text, lang) {
  if (lang === "doc") return String(text);
  const src = String(text);
  const n = src.length;
  const out = new Array(n);
  const isPy = lang === "py";
  const isC = lang === "c";
  let inBlock = false;
  let lastCode = "";
  let i = 0;
  const blankTo = (from, to) => { for (let k = from; k < to && k < n; k++) out[k] = src[k] === "\n" ? "\n" : " "; };
  while (i < n) {
    if (inBlock) {
      if (src[i] === "*" && src[i + 1] === "/") { inBlock = false; blankTo(i, i + 2); i += 2; continue; }
      out[i] = src[i] === "\n" ? "\n" : " "; i++; continue;
    }
    const c = src[i], d = src[i + 1];
    if (!isPy && c === "/" && d === "/") { const e = src.indexOf("\n", i); blankTo(i, e < 0 ? n : e); i = e < 0 ? n : e; continue; }
    if (isPy && c === "#") { const e = src.indexOf("\n", i); blankTo(i, e < 0 ? n : e); i = e < 0 ? n : e; continue; }
    if (!isPy && c === "/" && d === "*") { inBlock = true; blankTo(i, i + 2); i += 2; continue; }
    if (isC && c === "/" && d === "*") { inBlock = true; blankTo(i, i + 2); i += 2; continue; }
    if (c === "`" && !isPy && !isC) {
      /* 模板串：串本身是字面量，但 ${…} 里是代码，必须原样留着 ——
         改名漏掉插值里的调用，比多改一处严重得多。
         每个下标都要落值（out 里留空洞会让 join 之后的长度与原文错位，
         命中偏移就再也回不到原文了）。 */
      let k = i + 1, depth = 0;
      out[i] = " ";
      while (k < n) {
        if (src[k] === "\\") { out[k] = " "; if (k + 1 < n) out[k + 1] = " "; k += 2; continue; }
        if (depth === 0) {
          if (src[k] === "`") { out[k] = " "; k++; break; }
          if (src[k] === "$" && src[k + 1] === "{") { out[k] = " "; out[k + 1] = " "; depth = 1; k += 2; continue; }
          out[k] = src[k] === "\n" ? "\n" : " "; k++; continue;
        }
        if (src[k] === "{") depth++;
        else if (src[k] === "}") depth--;
        out[k] = src[k]; k++;
      }
      i = k; continue;
    }
    if (c === "'" || c === '"') {
      const triple = isPy && src[i + 1] === c && src[i + 2] === c;
      const open = triple ? 3 : 1;
      let k = i + open, closed = -1;
      while (k < n) {
        if (src[k] === "\\") { k += 2; continue; }
        if (triple) { if (src[k] === c && src[k + 1] === c && src[k + 2] === c) { closed = k; break; } k++; continue; }
        if (src[k] === c) { closed = k; break; }
        if (src[k] === "\n") break;                   // 单引号串不跨行：没闭合就当不是串
        k++;
      }
      if (closed < 0) { out[i] = c; lastCode = c; i++; continue; }
      blankTo(i, closed + open);
      i = closed + open; continue;
    }
    if (!isPy && !isC && c === "/" && looksLikeRegex(lastCode)) {
      let k = i + 1, cls = false, closed = -1;
      while (k < n) {
        if (src[k] === "\\") { k += 2; continue; }
        if (src[k] === "\n") break;                   // 换行未闭合 = 不是正则，是除号
        if (src[k] === "[") cls = true;
        else if (src[k] === "]") cls = false;
        else if (src[k] === "/" && !cls) { closed = k; break; }
        k++;
      }
      if (closed >= 0) {
        let e = closed + 1; while (e < n && /[a-z]/i.test(src[e])) e++;
        blankTo(i, e); i = e; continue;
      }
    }
    out[i] = c;
    if (!/\s/.test(c)) lastCode = c;
    i++;
  }
  return out.join("");
}
/* 除号还是正则字面量：看前一个有效字符。`)/.test(` 之后是方法调用，
   `= /x/`、`(/x/`、`return /x/` 里才是字面量。 */
function looksLikeRegex(lastCode) {
  return !lastCode || !/[)\]}\w$.]/.test(lastCode);
}

/* 整词命中：前后都不能是标识符字符（所以 getUser 不会命中 getUserName）。
   附带行号、原文行、是否 obj.name 形式的成员访问、是否声明处。 */
function findHits(src, masked, name) {
  const hits = [];
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  const lineOf = (at) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= at) lo = m; else hi = m - 1; }
    return lo;
  };
  let from = 0;
  while (from <= masked.length - name.length) {
    const at = masked.indexOf(name, from);
    if (at < 0) break;
    from = at + name.length;
    const b = masked[at - 1], a = masked[at + name.length];
    if (b !== undefined && ID_CHAR.test(b)) continue;
    if (a !== undefined && ID_CHAR.test(a)) continue;
    const li = lineOf(at);
    const s = lineStarts[li];
    const nl = src.indexOf("\n", s);
    const e = nl < 0 ? src.length : nl;
    const lineText = src.slice(s, e);
    const before = masked.slice(s, at);
    let back = at - 1;
    while (back >= s && /\s/.test(masked[back])) back--;
    hits.push({
      at, len: name.length, line: li + 1, lineText,
      member: masked[back] === ".",
      def: new RegExp(DECL_WORDS + "\\s+$").test(before),
    });
  }
  return hits;
}

/* 倒序替换：正序会把后面所有命中的偏移全部打乱。 */
function applyHits(src, hits, to) {
  let res = src;
  for (let k = hits.length - 1; k >= 0; k--) {
    const h = hits[k];
    res = res.slice(0, h.at) + to + res.slice(h.at + h.len);
  }
  return res;
}

/* 扫一批文件：返回每个文件的命中清单，以及"字面量/注释/文档里还有多少同名文本"。
   两类计数分开报，是因为它们对应两个不同的决定：
     hits        —— 改名会动的地方（代码区）
     skipped     —— 改名不会动、但模型应当知道它们存在的数量
   不屏蔽再扫一遍减去屏蔽后的数量，就是 skipped 的来源；粗暴但不会漏报。 */
function scanFiles(readFile, files, name, opts) {
  const o = opts || {};
  const listed = [];
  let skipped = 0;
  for (const p of files) {
    let text;
    try { text = readFile(p); } catch (e) { continue; }
    if (text == null || text.indexOf("\0") >= 0) continue;       // 读不到 / 二进制
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) continue;
    const lang = langOf(p);
    const doc = lang === "doc";
    if (doc && !o.includeDocs) {
      const raw = findHits(text, text, name).length;
      if (raw) { listed.push({ path: p, lang, doc: true, hits: [], rawHits: raw }); skipped += raw; }
      continue;
    }
    const masked = o.includeLiterals ? text : maskNonCode(text, lang);
    const hits = findHits(text, masked, name);
    if (!hits.length) continue;
    listed.push({ path: p, lang, doc, hits, text });
    if (!o.includeLiterals) skipped += Math.max(0, findHits(text, text, name).length - hits.length);
  }
  return { files: listed, skipped };
}

module.exports = {
  IDENT_RE, ID_CHAR, MAX_BYTES, langOf, isDoc, esc,
  maskNonCode, looksLikeRegex, findHits, applyHits, scanFiles,
};
