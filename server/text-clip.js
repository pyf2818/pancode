"use strict";
/* ============================================================
   文本截断的唯一口径
   ------------------------------------------------------------
   以前编排简报、步骤结论、记忆正文与索引、白板条目各写各的 .slice()，
   两个后果：
   1) .slice() 按 UTF-16 码元切。emoji 与 CJK 扩展 B（𠀀 这类）正好跨在切口上时，
      留下一半个代理 —— 交给模型的是 U+FFFD 乱码，写进记忆条目的还是坏字符。
   2) 截在 markdown 代码围栏中间时，那个 ``` 一直没闭合；后面拼接进去的段落
      会被渲染进代码块（编排简报把白板条目接在结论后面、记忆把索引接在常驻后面，
      都吃过这一刀）。
   所以两处都在这一份里收口：切口避开代理对，多行文本的未闭合围栏补上结束行。
   单行文本不补围栏：调用点刚做过 replace(/\s+/g," ")，硬塞换行会把一行拆成两行。
   ============================================================ */

function clipText(text, maxChars, opts) {
  const s = String(text == null ? "" : text);
  const cap = Math.floor(Number(maxChars));
  if (!Number.isFinite(cap) || cap < 0 || s.length <= cap) return s;
  let cut = cap;
  // 切口前一位是高代理（\ud800–\udbf7 区间的首代理）时退一格，别把一对劈开
  const last = s.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  let head = s.slice(0, cut);
  if (opts && opts.fence === false) return head;
  if (head.indexOf("\n") >= 0) {
    const fences = head.match(/^\s{0,3}(`{3,})/gm);
    if (fences && fences.length % 2 === 1) head += "\n```";
  }
  return head;
}

module.exports = { clipText };
