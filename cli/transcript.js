/* ============================================================
   pancode-cli · Transcript 模式（Ctrl+O）
   ------------------------------------------------------------
   滚动查看完整对话记录（用户消息 + AI 回复 + 工具调用）。
   less/tmux copy-mode 风格按键：
     ↑↓ jk 滚动 · PageUp/Down 半页 · Ctrl+U/D 全页
     g/G 顶/底 · / 搜索 · n/N 下/上个匹配 · q 退出
   吸收自 openanlan transcript 模式 + ScrollKeybindingHandler。
   ============================================================ */
"use strict";

const S = require("./style");

async function transcript(lines) {
  if (!lines || !lines.length) {
    process.stdout.write(S.dim("  无对话记录\n"));
    return;
  }

  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: null, terminal: true });
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;
    let top = 0;          /* 顶部行号 */
    let searchQ = "";
    let searchMode = false;
    let matchIdx = -1;

    try { process.stdin.setRawMode(true); } catch (_) {}
    process.stdin.resume();

    /* 进入交替屏幕缓冲区——退出时恢复原画面（banner/对话不被清掉） */
    process.stdout.write("\x1b[?1049h");

    function visibleRange() {
      const h = rows - 2;  /* 留 2 行给状态栏 */
      return { start: top, end: Math.min(top + h, lines.length), h };
    }

    function findMatches(q) {
      if (!q) return [];
      const ql = q.toLowerCase();
      const result = [];
      lines.forEach((l, i) => { if (l.toLowerCase().includes(ql)) result.push(i); });
      return result;
    }

    function draw() {
      const { start, end, h } = visibleRange();
      process.stdout.write("\x1b[2J\x1b[H");

      for (let i = start; i < end; i++) {
        const line = lines[i] || "";
        const truncated = line.length > cols ? line.slice(0, cols - 1) + "…" : line;
        process.stdout.write(truncated + "\n");
      }
      /* 填充空行 */
      for (let i = end - start; i < h; i++) process.stdout.write("\n");

      /* 状态栏 */
      const pct = Math.round((end / lines.length) * 100);
      const parts = [
        S.dim("transcript"),
        S.dim("·"),
        S.dim(lines.length + " 行"),
        S.dim("·"),
        S.dim(pct + "%"),
      ];
      if (searchQ) {
        const ms = findMatches(searchQ);
        parts.push(S.dim("·"), S.dim("/" + searchQ), S.dim((matchIdx >= 0 ? (matchIdx + 1) : 0) + "/" + ms.length));
      }
      if (searchMode) parts.push(S.dim("·"), S.accent("搜索: " + searchQ + "█"));
      parts.push(S.dim("·"), S.dim("q 退出 · / 搜索 · g/G 顶/底"));
      process.stdout.write(parts.join(" ") + "\n");
    }

    function scroll(delta) {
      const { h } = visibleRange();
      top = Math.max(0, Math.min(lines.length - h, top + delta));
      draw();
    }

    function gotoMatch(dir) {
      const ms = findMatches(searchQ);
      if (!ms.length) return;
      if (matchIdx < 0) matchIdx = 0;
      else matchIdx = (matchIdx + dir + ms.length) % ms.length;
      const target = ms[matchIdx];
      const { h } = visibleRange();
      top = Math.max(0, Math.min(lines.length - h, target - Math.floor(h / 2)));
      draw();
    }

    draw();

    const onKeypress = (ch, key) => {
      if (!key) return;

      if (searchMode) {
        if (key.name === "escape" || (key.ctrl && key.name === "c")) { searchMode = false; searchQ = ""; matchIdx = -1; draw(); return; }
        if (key.name === "return") { searchMode = false; matchIdx = -1; gotoMatch(1); return; }
        if (key.name === "backspace") { if (searchQ.length > 0) { searchQ = searchQ.slice(0, -1); draw(); } return; }
        if (ch && !key.ctrl && !key.meta && ch >= " ") { searchQ += ch; draw(); return; }
        return;
      }

      if (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c")) { process.stdout.write("\x1b[?1049l"); rl.input.removeListener("keypress", onKeypress); rl.close(); try { process.stdin.setRawMode(false); } catch (_) {} resolve(); return; }
      if (ch === "/") { searchMode = true; searchQ = ""; matchIdx = -1; draw(); return; }
      if (ch === "n") { gotoMatch(1); return; }
      if (ch === "N" || (key.shift && ch === "n")) { gotoMatch(-1); return; }

      if (key.name === "up" || ch === "k") { scroll(-1); return; }
      if (key.name === "down" || ch === "j") { scroll(1); return; }
      if (key.name === "pageup") { scroll(-Math.floor(rows / 2)); return; }
      if (key.name === "pagedown") { scroll(Math.floor(rows / 2)); return; }
      if (key.ctrl && key.name === "u") { scroll(-rows); return; }
      if (key.ctrl && key.name === "d") { scroll(rows); return; }
      if (key.ctrl && key.name === "b") { scroll(-rows); return; }
      if (key.ctrl && key.name === "f") { scroll(rows); return; }
      if (ch === "g") { top = 0; draw(); return; }
      if (ch === "G" || (key.shift && ch === "g")) { const { h } = visibleRange(); top = Math.max(0, lines.length - h); draw(); return; }
      if (key.name === "home") { top = 0; draw(); return; }
      if (key.name === "end") { const { h } = visibleRange(); top = Math.max(0, lines.length - h); draw(); return; }
    };

    rl.input.on("keypress", onKeypress);
  });
}

module.exports = { transcript };
