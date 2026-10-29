/* ============================================================
   pancode-cli · 命令面板（Ctrl+K）
   ------------------------------------------------------------
   模糊搜索所有斜杠命令，↑↓ 选择，Enter 执行。
   吸收自 openanlan CommandPalette.tsx：
     单线边框 + ⚡ 标题 + 查询输入 + 光标 + 最多 10 条匹配
   ============================================================ */
"use strict";

const S = require("./style");
const { COMMANDS } = require("./commands");

async function commandPalette(opts) {
  opts = opts || {};
  const extra = opts.extra || [];  /* 额外条目 {label, hint, action} */

  const items = [
    ...COMMANDS.filter((c) => !c.isHidden).map((c) => ({
      label: "/" + c.name,
      hint: c.desc + (c.aliases ? " (/" + c.aliases.join(" /") + ")" : ""),
      action: () => opts.onCommand(c),
    })),
    ...extra.map((e) => ({ label: e.label, hint: e.hint || "", action: e.action })),
  ];

  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: null, terminal: true });
    let query = "";
    let selected = 0;
    let scroll = 0;
    const MAX_SHOW = 10;
    let firstDraw = true;

    try { process.stdin.setRawMode(true); } catch (_) {}
    process.stdin.resume();

    function filtered() {
      const q = query.toLowerCase();
      if (!q) return items;
      return items.filter((it) => it.label.toLowerCase().includes(q) || it.hint.toLowerCase().includes(q));
    }

    function draw() {
      const cols = process.stdout.columns || 80;
      const w = Math.min(cols, 70);
      const list = filtered();
      if (selected >= list.length) selected = Math.max(0, list.length - 1);
      const start = Math.floor(selected / MAX_SHOW) * MAX_SHOW;
      const visible = list.slice(start, start + MAX_SHOW);

      /* 上移到框顶再清屏：draw 结束时光标在查询行（框顶下 1 行），
         非首次重画需上移 1 行到 top border，再 \r\x1b[J 清到末尾 */
      if (!firstDraw) process.stdout.write("\x1b[1A");
      firstDraw = false;
      process.stdout.write("\r\x1b[J");
      const top = S.promptBorder("┌─ " + S.accent("⚡ Command Palette") + " " + "─".repeat(Math.max(0, w - 20)) + "┐");
      process.stdout.write(top + "\n");

      /* 查询行 */
      const qLine = S.promptBorder("│") + " " + S.accent(query) + S.dim("█") + " ".repeat(Math.max(0, w - 2 - query.length - 1)) + S.promptBorder("│");
      process.stdout.write(qLine + "\n");
      process.stdout.write(S.promptBorder("├" + "─".repeat(w - 2) + "┤") + "\n");

      /* 列表 */
      if (visible.length === 0) {
        const empty = S.promptBorder("│") + S.dim("  无匹配") + " ".repeat(Math.max(0, w - 8)) + S.promptBorder("│");
        process.stdout.write(empty + "\n");
      } else {
        visible.forEach((it, i) => {
          const idx = start + i;
          const isSel = idx === selected;
          const prefix = isSel ? S.accent("▸ ") : "  ";
          const label = isSel ? S.accent(S.mod.bold(it.label)) : S.text(it.label);
          /* 描述列按显示列数截：原先用 it.label.length（字符数）算预算、又用 slice 切，
             中文标签会让提示文字超出边框并把整行挤到折行。 */
          const hint = S.dim(S.truncateCols(it.hint || "", Math.max(0, w - 6 - S.displayWidth(it.label))));
          const line = prefix + label + " " + hint;
          const padded = line + " ".repeat(Math.max(0, w - 2 - S.stripLen(line)));
          process.stdout.write(S.promptBorder("│") + padded + S.promptBorder("│") + "\n");
        });
      }

      const bot = S.promptBorder("└" + "─".repeat(w - 2) + "┘");
      process.stdout.write(bot + "\n");
      process.stdout.write(S.dim("  ↑↓ navigate · Enter select · Esc close") + "\n");

      /* 光标到查询行 */
      const totalLines = 3 + Math.min(MAX_SHOW, Math.max(1, visible.length)) + 2;
      process.stdout.write("\x1b[" + (totalLines - 2) + "A\r\x1b[" + (2 + query.length) + "C");
    }

    function close(result) {
      /* 光标在查询行，上移 1 到框顶，清到末尾 */
      process.stdout.write("\x1b[1A\r\x1b[J");
      rl.input.removeListener("keypress", onKeypress);
      rl.close();
      try { process.stdin.setRawMode(false); } catch (_) {}
      resolve(result);
    }

    draw();

    const onKeypress = (ch, key) => {
      if (!key) return;
      if (key.name === "escape" || (key.ctrl && key.name === "c")) { close(null); return; }
      if (key.name === "up") { const l = filtered().length; if (l) { selected = (selected - 1 + l) % l; draw(); } return; }
      if (key.name === "down") { const l = filtered().length; if (l) { selected = (selected + 1) % l; draw(); } return; }
      if (key.name === "return") {
        const list = filtered();
        if (list[selected]) { close(list[selected]); }
        return;
      }
      if (key.name === "backspace") { if (query.length > 0) { query = query.slice(0, -1); selected = 0; draw(); } return; }
      if (ch && !key.ctrl && !key.meta && ch >= " ") { query += ch; selected = 0; draw(); return; }
    };

    rl.input.on("keypress", onKeypress);
  });
}

module.exports = { commandPalette };
