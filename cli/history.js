/* ============================================================
   pancode-cli · 历史搜索（Ctrl+R）
   ------------------------------------------------------------
   反向增量搜索输入历史，匹配项高亮，Enter 执行，
   Ctrl+R 下一个匹配，Esc 取消。
   吸收自 openanlan HistorySearch 模式。
   ============================================================ */
"use strict";

const S = require("./style");

async function historySearch(history) {
  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: null, terminal: true });
    let query = "";
    let matchIdx = -1;  /* 当前匹配在 matches 中的位置 */

    try { process.stdin.setRawMode(true); } catch (_) {}
    process.stdin.resume();

    function matches() {
      if (!query) return [];
      const q = query.toLowerCase();
      const result = [];
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].toLowerCase().includes(q)) result.push(history[i]);
      }
      return result;
    }

    function draw() {
      const cols = process.stdout.columns || 80;
      const w = Math.min(cols, 80);
      process.stdout.write("\r\x1b[J");

      /* 搜索行 */
      const label = S.dim("reverse-i-search: ");
      const qPart = S.accent(query) + S.dim("█");
      process.stdout.write(label + qPart + "\n");

      /* 匹配预览 */
      const ms = matches();
      if (ms.length > 0) {
        if (matchIdx < 0 || matchIdx >= ms.length) matchIdx = 0;
        const m = ms[matchIdx];
        const q = query.toLowerCase();
        const idx = m.toLowerCase().indexOf(q);
        const before = m.slice(0, idx);
        const hit = S.accent(S.mod.bold(m.slice(idx, idx + query.length)));
        const after = m.slice(idx + query.length);
        const preview = before + hit + after;
        /* preview 里带着命中高亮的 ANSI 序列：原先 preview.length 把转义符算进长度、
           slice 还可能从一条转义序列中间切开，中文历史行更是按字符切出双倍宽度。 */
        const truncated = S.truncateCols(preview, w - 4);
        process.stdout.write(S.dim("  › ") + truncated + "\n");
        process.stdout.write(S.dim("  match " + (matchIdx + 1) + "/" + ms.length) + "\n");
      } else {
        process.stdout.write(S.err("  无匹配") + "\n\n");
      }

      process.stdout.write(S.dim("  Ctrl+R next · Enter accept · Esc cancel") + "\n");

      /* 光标回搜索行：写了 4 行（各以 \n 结尾），光标在第 5 行，上移 4 到第 1 行。
         列偏移按显示列数算——搜中文时 query.length 只有实际宽度的一半。 */
      process.stdout.write("\x1b[4A\r\x1b[" + (S.stripLen(label) + S.displayWidth(query) + 1) + "C");
    }

    function close(result) {
      process.stdout.write("\r\x1b[J");
      rl.input.removeListener("keypress", onKeypress);
      rl.close();
      try { process.stdin.setRawMode(false); } catch (_) {}
      resolve(result);
    }

    draw();

    const onKeypress = (ch, key) => {
      if (!key) return;
      if (key.name === "escape" || (key.ctrl && key.name === "c")) { close(null); return; }
      if (key.ctrl && key.name === "r") { const ms = matches(); if (ms.length) { matchIdx = (matchIdx + 1) % ms.length; } draw(); return; }
      if (key.name === "return") {
        const ms = matches();
        if (ms.length > 0 && matchIdx >= 0) close(ms[matchIdx]);
        else close(null);
        return;
      }
      if (key.name === "backspace") { if (query.length > 0) { query = query.slice(0, -1); matchIdx = -1; draw(); } return; }
      if (ch && !key.ctrl && !key.meta && ch >= " ") { query += ch; matchIdx = -1; draw(); return; }
    };

    rl.input.on("keypress", onKeypress);
  });
}

module.exports = { historySearch };
