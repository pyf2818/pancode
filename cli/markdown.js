/* ============================================================
   pancode-cli · Markdown 终端渲染
   ------------------------------------------------------------
   marked v14 + 自定义 renderer 输出 ANSI。
   渲染规则吸收自 openanlan utils/markdown.ts formatToken：
     h1 → bold italic underline    h2+ → bold
     code(block) → cli-highlight + 边框
     codespan → permission 色（主色深天蓝）
     blockquote → ▎ dim 前缀 + italic 正文
     list → 缩进 + • / N.            strong → bold   em → italic
     link → OSC 8 超链接（若终端支持）
   ============================================================ */
"use strict";

const { marked } = require("marked");
const hl = require("cli-highlight");
const S = require("./style");

/* 本模块渲染出来的块要留出的左侧前缀宽度（AI 回复的 "⊂ " 占 2 列）。
   代码块边框和分隔线是按终端列宽算的：不预留就会被前缀推出 2 列，
   整块框线在真实终端里折行，右边界全歪——所以宽度口径必须一起交进来。 */
let INDENT = 0;
function withIndent(n, fn) {
  const prev = INDENT;
  INDENT = n || 0;
  try { return fn(); } finally { INDENT = prev; }
}
function availCols() { return Math.max(20, Math.min(process.stdout.columns || 80, 100) - INDENT); }

function hlLang(lang) {
  const l = String(lang || "").toLowerCase();
  if (l === "sh" || l === "shell") return "bash";
  if (l === "py") return "python";
  if (l === "ts") return "typescript";
  if (l === "js" || l === "jsx") return "javascript";
  if (l === "yml") return "yaml";
  return l || "plaintext";
}

function highlightCode(code, lang) {
  try {
    return hl.highlight(String(code), {
      language: hlLang(lang),
      theme: {
        keyword:   "cyan",
        string:    "green",
        comment:   "gray",
        number:    "yellow",
        function:  "blue",
        class:     "magenta",
        operator:  "cyan",
        variable:  "white",
        builtin:   "cyan",
        tag:       "magenta",
        attr:      "cyan",
        punct:     "gray",
      },
    });
  } catch (e) {
    return String(code);
  }
}

/* OSC 8 超链接（终端支持时点击可跳转） */
function hyperlink(href, text) {
  if (S.chalkLevel >= 1 && process.env.TERM_PROGRAM) {
    return `\x1b]8;;${href}\x1b\\${text}\x1b]8;;\x1b\\`;
  }
  return text + S.dim(" (" + href + ")");
}

/* 自定义 renderer：方法内 this.parser.parse / parseInline 处理子 tokens */
const renderer = {
  heading({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    if (depth === 1) return "\n" + S.mod.bold(S.mod.italic(S.mod.underline(text))) + "\n";
    const prefix = depth <= 2 ? "" : "  ";
    return "\n" + prefix + S.c.bold(text) + "\n";
  },
  paragraph({ tokens }) {
    return this.parser.parseInline(tokens) + "\n";
  },
  code({ text, lang }) {
    const code = highlightCode(text, lang);
    const w = availCols() - 4;
    /* 语言标签要占掉上边框的一段：原先是 top + tag 直接拼在 ┐ 后面，
       第一行比其他行宽 4 列（实测 [84,80,80,80]），整块框的右上角凸出来。 */
    const tag = lang ? " " + S.dim(lang) + " " : "";
    const tagCols = S.displayWidth(tag);
    const top = S.border("  ┌") + tag + S.border("─".repeat(Math.max(2, w - tagCols)) + "┐");
    const bot = S.border("  └" + "─".repeat(w) + "┘");
    /* 超宽行必须先按列截断：以前只把 padding 夹到 0，长代码行会把右边界推出去
       并让终端折行，一整块框线从此全歪。 */
    const body = code.split("\n").map((l) => {
      const cut = S.truncateCols(l, w - 1);
      return S.border("  │") + " " + cut + " ".repeat(Math.max(0, w - S.stripLen(cut) - 1)) + S.border("│");
    }).join("\n");
    return "\n" + top + "\n" + body + "\n" + bot + "\n";
  },
  codespan({ text }) {
    /* OpenAnLan: permission 色（主色浅蓝青） */
    return S.P.permission.fg("`" + text + "`");
  },
  list({ items, ordered }) {
    const out = items.map((item, i) => {
      const txt = this.parser.parseInline(item.tokens);
      const mark = ordered ? (i + 1) + "." : "•";
      return "  " + S.accent(mark) + " " + txt;
    });
    return out.join("\n") + "\n";
  },
  listitem({ tokens }) {
    return this.parser.parseInline(tokens);
  },
  strong({ tokens }) {
    return S.c.bold(this.parser.parseInline(tokens));
  },
  em({ tokens }) {
    return S.mod.italic(this.parser.parseInline(tokens));
  },
  del({ tokens }) {
    return S.dim(this.parser.parseInline(tokens));
  },
  link({ tokens, href }) {
    const text = this.parser.parseInline(tokens);
    if (/^mailto:/.test(href)) return text;
    return hyperlink(href, text);
  },
  blockquote({ tokens }) {
    /* OpenAnLan: ▎ dim 前缀 + italic 正文 */
    const text = this.parser.parse(tokens);
    return text.split("\n").map((l) => S.dim(S.BLOCKQUOTE_BAR + " ") + S.mod.italic(l)).join("\n") + "\n";
  },
  hr() {
    /* 分隔线跟着块宽走：S.hr() 是按整终端宽画的，加上 2 列前缀就折行 */
    return S.dim("─".repeat(availCols())) + "\n";
  },
  table({ header, rows }) {
    /* 逐列按显示列数对齐。原先是 join(" | ") 直接摊：每列宽度=各自内容宽度，
       中文一多整张表就是锯齿，分隔线也只是把表头长度抄一遍。 */
    const head = header.map((h) => this.parser.parseInline(h.tokens));
    const body = rows.map((r) => r.map((cell) => this.parser.parseInline(cell.tokens)));
    const widths = head.map((_, i) => {
      let w = S.displayWidth(head[i] || "");
      body.forEach((row) => { w = Math.max(w, S.displayWidth(row[i] || "")); });
      return w;
    });
    const line = (cells, paint) => {
      const s = cells.map((c, i) => S.padCols(c || "", widths[i])).join(" | ");
      return paint ? paint(s) : s;
    };
    return line(head, S.c.bold) + "\n" + S.dim(widths.map((w) => "-".repeat(w)).join("-|-")) +
      "\n" + body.map((r) => line(r)).join("\n") + "\n";
  },
  br() {
    return "\n";
  },
  checkbox({ checked }) {
    return checked ? S.ok("[x] ") : S.dim("[ ] ");
  },
};

marked.use({ renderer, gfm: true, breaks: false });

function renderMd(text, opts) {
  const indent = (opts && opts.indent) || 0;
  try {
    return withIndent(indent, () => marked.parse(String(text || "")).trim());
  } catch (e) {
    return String(text || "");
  }
}

module.exports = { renderMd, highlightCode, availCols };
