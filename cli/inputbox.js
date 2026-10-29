/* ============================================================
   pancode-cli · 输入框（OpenAnLan Terminal 视觉）
   ------------------------------------------------------------
   — ⊂ pancode ──────────────────────────────────────
     › [输入或占位符]
   ──────────────────────────────────────────────────
     ? for shortcuts · ↑↓ history · Enter 发送 · \ 续行 · ^C 清空 / Esc 取消

   OpenAnLan 风格：
     - promptBorder 色水平线边框（#4fc3f7 浅蓝青）
     - › prompt 模式指示符 / ! bash 模式
     - ⊂ 品牌符号嵌在边框左端
     - Ctrl+K 命令面板 · Ctrl+R 历史搜索 · Ctrl+O transcript
     - Ctrl+X E 外部编辑器 · Ctrl+L 重绘
   用 readline raw mode + ANSI 重绘，不依赖 ink。
   ============================================================ */
"use strict";

const readline = require("readline");
const S = require("./style");
const { COMMANDS } = require("./commands");

/* 斜杠命令过滤：value 形如 /word 时返回匹配列表，否则 null */
function slashMatches(value) {
  const m = value.match(/^\/(\w*)$/);
  if (!m) return null;
  const q = m[1].toLowerCase();
  return COMMANDS.filter((c) => !c.isHidden && c.name.startsWith(q))
    .map((c) => ({ cmd: "/" + c.name, desc: c.desc || "", expand: c.expand || null }));
}

const TITLE = " ⊂ pancode ";
const PLACEHOLDER = "尝试输入问题，或 /help 看命令";
const FOOTER = S.dim("  ? shortcuts · ↑↓ history · ^K palette · ^R search · ^O transcript · ^X E editor · \\ 续行 · ^C 清空/中断 · Esc 退出");

/* 截断到指定显示宽度（防折行）。原先自己实现了一份：先 replace 掉 ANSI 再逐字符切，
   等于把颜色整条丢掉；现在统一走 style 的 ANSI 感知版本。 */
function truncateAnsi(str, maxW) {
  return S.truncateCols(str, maxW);
}

/* 边框色：OpenAnLan promptBorder = #4fc3f7 */
const BD = S.promptBorder;

function boxTop(width) {
  /* — ⊂ pancode ──...—  标题嵌在左端，水平线边框 */
  const inner = width - 2;
  const titleLen = S.stripLen(TITLE);
  const dashAfter = Math.max(0, inner - titleLen);
  return BD("—") + BD(TITLE) + BD("—".repeat(dashAfter)) + BD("—");
}
function boxBottom(width) {
  return BD("—" + "—".repeat(Math.max(0, width - 2)) + "—");
}

/* 模式指示符：OpenAnLan
   prompt → › (默认前景色)   bash → ! (bashBorder) */
function modeIndicator(mode) {
  if (mode === "bash") return S.bashBorder("! ");
  return S.text("› ");
}

/* 渲染整个输入框（覆盖前一次） */
function render(state) {
  const cols = process.stdout.columns || 80;
  const w = Math.min(cols, 100);
  const lines = [];

  lines.push(boxTop(w));

  /* 输入行：模式指示符 + 内容 / 占位符 */
  const indicator = modeIndicator(state.mode || "prompt");
  let contentLine;
  if (state.value.length === 0) {
    contentLine = indicator + S.dim(PLACEHOLDER);
  } else {
    const parts = state.value.split("\n");
    contentLine = parts.map((p, i) => (i === 0 ? indicator : "  ") + p).join("\n");
  }
  lines.push(contentLine);

  lines.push(boxBottom(w));

  /* 状态行（OpenAnLan StatusBar: ❰ ⊂ model · workspace · ▰▱▱ N% ❱） */
  if (state.status) {
    lines.push(statusLine(state.status));
  }

  /* 斜杠命令列表（输入 / 时弹出，对齐前端 slashMenu） */
  if (state.slash && state.slash.length) {
    const sel = state.slashIdx || 0;
    const maxShow = 8;
    const start = Math.floor(sel / maxShow) * maxShow;
    const visible = state.slash.slice(start, start + maxShow);
    visible.forEach((it, i) => {
      const idx = start + i;
      const isSel = idx === sel;
      const prefix = isSel ? S.accent("▸ ") : S.dim("  ");
      /* 先按列补齐再上色：cmd.padEnd(14) 是在带 ANSI 的字符串上算长度，
         转义序列被当成字符数，等于永远补不齐，描述列从此左摇右摆。 */
      const cmd = isSel ? S.accent(S.mod.bold(S.padCols(it.cmd, 14))) : S.text(S.padCols(it.cmd, 14));
      const desc = S.dim(S.truncateCols(it.desc || "", Math.max(0, w - 2 - 14)));
      lines.push(prefix + cmd + desc);
    });
  }

  lines.push(truncateAnsi(FOOTER, w));

  const out = lines.join("\n");
  return out;
}

/* ---------- 状态行 ----------
   原先这里写着 info.ctxPct / info.tokens 两段，但 cli.js 是去问 engine.getContextUsage()
   ——引擎根本没这个方法（全仓只有调用点，没有定义），而引擎真正发水位的 context.usage
   事件又被渲染器 break 丢掉。两头都接不上，进度条从上线起一次都没显形过。
   现在水位由 render.js 收下、经 getStatus() 传进来。 */

/* 会自动放行写盘或执行的档：必须在屏幕上常驻，不能只躺在 /permissions 里。
   dontAsk 尤其危险——它既不弹审批也不排队，直接放行。 */
const AUTO_PERMS = { acceptEdits: 1, auto: 1, smart: 1, dontAsk: 1 };

function statusLine(info) {
  info = info || {};
  const parts = [];
  parts.push(S.dim("❰"));
  /* 运行态放最左：按下 Enter 之后用户第一眼找的就是"这儿还在动吗"。
     只有真在跑才占位——空闲时挂一句"AI 空闲"是噪声，还会让状态行左右跳。 */
  const st = info.state;
  if (st && st.running) {
    parts.push(S.warn(S.mod.bold((st.glyph || "·") + " ") + (st.text || "运行中")));
    parts.push(S.dim("·"));
  }
  if (info.model) parts.push(S.accent(S.MOON) + " " + S.accentShim(S.mod.bold(info.model)));
  if (info.workspace) { parts.push(S.dim("·")); parts.push(S.inactive(info.workspace)); }
  const perm = info.perm || "ask";
  parts.push(S.dim("·"));
  /* 只加色不加粗：⚠ + 错误色已经足够刺眼，再套一层 bold 只是让字节里多一段
     转义序列（判据想确认"这段是错误色"，中间夹个 bold 就得去猜嵌套形状）。 */
  parts.push(AUTO_PERMS[perm] ? S.err("⚠ " + perm) : S.inactive(perm));
  const ctx = info.ctx;
  if (ctx && ctx.budget) {
    const pct = Math.max(0, Math.min(100, Math.round(ctx.used / ctx.budget * 100)));
    const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
    parts.push(S.dim("·"));
    parts.push(S.ctxColor(pct)("▰".repeat(filled) + "▱".repeat(10 - filled)));
    /* est=true 表示这个 used 是估算值（引擎随事件带过来的口径），
       估的就要标成估的：一个不带记号的 32% 会被当成实测。 */
    parts.push(S.dim((ctx.est ? "≈" : "") + pct + "%"));
  }
  parts.push(S.dim("❱"));
  return parts.join(" ");
}

/* ---------- 主输入函数 ---------- */
async function inputBox(opts) {
  opts = opts || {};
  const history = opts.history || [];
  const onCommandPalette = opts.onCommandPalette;  /* Ctrl+K */
  const onHistorySearch = opts.onHistorySearch;      /* Ctrl+R */
  const onTranscript = opts.onTranscript;            /* Ctrl+O */
  const onExternalEditor = opts.onExternalEditor;    /* Ctrl+X E */
  const getStatus = opts.getStatus || (() => null);   /* 状态行信息 */
  /* 运行期 Ctrl+C 的落点：输入框常驻之后，^C 不能再靠"关掉输入"来中断——
     引擎那一轮是在后台跑的，得显式叫它停。isRunning/onInterrupt 由上层给。 */
  const isRunning = opts.isRunning || (() => false);
  const onInterrupt = opts.onInterrupt || (() => {});
  /* 输出仲裁层（cli/screen.js）。给了它，输入框就把自己的帧交出去，
     渲染器的异步事件行会被插到帧上方而不是把帧咬穿；没给（老调用方/测试）则退回
     "帧只在自己重绘时存在"的旧行为。 */
  const screen = opts.screen || null;
  let histIdx = history.length;

  /* 非 TTY 降级 */
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve, reject) => {
      rl.question(S.accent("› "), (ans) => { rl.close(); resolve(ans); });
      rl.input.on("keypress", (ch, key) => {
        if (key && key.ctrl && key.name === "c") { rl.close(); reject(new Error("aborted")); }
      });
    });
  }

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: null,
      terminal: true,
    });
    let value = "";
    let cursor = 0;
    let mode = "prompt";
    let aborted = false;
    /* 面板类分支要 await 外部交互，期间按键先咽掉，避免叠起第二个面板 */
    let busy = false;
    async function withBusy(fn) {
      busy = true;
      try { process.stdin.setRawMode(false); } catch (_) {}
      try { return await fn(); } finally {
        try { process.stdin.setRawMode(true); } catch (_) {}
        busy = false;
      }
    }

    /* 上一帧：{ lines: 逻辑行数组, row: 光标所在逻辑行, col: 光标在该行内的显示列 }
       擦除与定位都按当前列宽把它换算成物理行——见 redraw 上方的注释。 */
    const state = { frame: null };
    let slashList = null;   /* null = 隐藏，[] = 空匹配也隐藏 */
    let slashIdx = 0;

    function updateSlash() {
      const m = slashMatches(value);
      if (m && m.length) { slashList = m; if (slashIdx >= m.length) slashIdx = 0; }
      else { slashList = null; slashIdx = 0; }
    }

    /* ---------- 帧的物理行模型 ----------
       终端把超过列宽的一行折成多个物理行，而光标移动只能按物理行算。
       原先 moveCursor 用 `col = 2 + displayWidth(整行)` 再 Math.min(col, cols) 夹一下：
       输入超过一行宽度时光标就落到错误的列上，且下一帧擦除按逻辑行数上移，
       会把旧帧的尾巴留在屏幕上。
       现在每次重绘都记下上一帧的逻辑行与光标行列，擦除/定位一律按**当前**列宽换算物理行。 */
    function physRowsAbove(lines, row, col, cols) {
      let n = 0;
      for (let i = 0; i < Math.min(row, lines.length); i++) {
        n += Math.max(1, Math.ceil(S.displayWidth(lines[i]) / cols));
      }
      return n + Math.floor(col / cols);
    }
    function frameRows(lines, cols) {
      /* 和擦除侧共用同一把尺子：S.screenRows 已经是"逐逻辑行按列宽折行"的口径 */
      return S.screenRows(lines.join("\n"), cols);
    }
    function eraseFrame() {
      const cols = process.stdout.columns || 80;
      const f = state.frame;
      if (!f) return;
      const up = physRowsAbove(f.lines, f.row, f.col, cols);
      if (up > 0) process.stdout.write("\x1b[" + up + "A");
      process.stdout.write("\r\x1b[J");
    }

    /* 画一帧并把光标放回输入位。约定：调用时光标必须在帧顶（eraseFrame 之后），
       它自己不再擦 —— 擦与画分开，仲裁层才能在"帧上方插一行"时只借画这一步。 */
    function paintFrame() {
      const cols = process.stdout.columns || 80;
      updateSlash();  /* 每次重绘前同步斜杠列表状态 */
      const rendered = render({ value, mode, slash: slashList, slashIdx, status: getStatus() });
      process.stdout.write(rendered);
      const lines = rendered.split("\n");
      /* 内容行是第 2 行（第 1 行是 boxTop）；多行输入时目标行 = 1 + 换行数 */
      const before = value.slice(0, cursor);
      const row = 1 + (before.match(/\n/g) || []).length;
      /* 列偏移：指示符宽度(2) + 当前行已输入部分的显示宽度；超宽部分交给物理行换算 */
      const col = 2 + S.displayWidth(before.split("\n").pop());
      /* 写完最后一行后光标停在帧的最后一个物理行上，上移到目标物理行 */
      const up = Math.max(0, frameRows(lines, cols) - 1 - physRowsAbove(lines, row, col, cols));
      if (up > 0) process.stdout.write("\x1b[" + up + "A");
      process.stdout.write("\r\x1b[" + (col % cols + 1) + "C");
      state.frame = { lines, row, col };
    }

    function redraw() {
      eraseFrame();
      paintFrame();
    }

    /* 引擎在跑的过程中弹审批/选择：那要用 @inquirer 读键盘，而 raw mode 与 keypress
       监听器此刻都攥在这个框里。让 stdin 还不够——aboveFrame 的擦除是 \r\x1b[J（清到屏幕
       末尾），留着帧就会把 inquirer 刚画出来的四个选项一起擦没。所以整块收掉、问完再画回来。 */
    async function exclusive(fn) {
      if (busy) return await fn();
      busy = true;
      eraseFrame();
      state.frame = null;
      if (screen) screen.clearFrame();
      try { process.stdin.setRawMode(false); } catch (_) {}
      try {
        return await fn();
      } finally {
        try { process.stdin.setRawMode(true); } catch (_) {}
        process.stdin.resume();
        redraw();
        if (screen) screen.setFrame({ erase: eraseFrame, draw: paintFrame, exclusive });
        busy = false;
      }
    }

    function finish(val) {
      rl.input.removeListener("keypress", onKeypress);
      process.stdout.removeListener("resize", onResize);
      /* 先收帧再擦：擦完之后已经没有帧可画了，留着会让仲裁层往不存在的位置重画 */
      if (screen) screen.clearFrame();
      rl.close();
      try { process.stdin.setRawMode(false); } catch (_) {}
      eraseFrame();
      if (aborted) reject(new Error("aborted"));
      else resolve(val);
    }

    /* 窗口尺寸变了：上一帧是按旧列宽画出去、也可能已被终端重排，
       按新列宽重算物理行再擦，然后整帧重画。原先这里什么都没有——
       拖窄一次窗口，之后每一帧的擦除行数都从此错位。 */
    function onResize() { try { redraw(); } catch (_) {} }

    /* 检测 bash 模式：! 开头 */
    function updateMode() {
      mode = value.startsWith("!") ? "bash" : "prompt";
    }

    try { process.stdin.setRawMode(true); } catch (_) {}
    process.stdin.resume();

    redraw();
    /* 帧交出去之后，任何走仲裁层的输出都会先擦帧、写行、再画帧 */
    if (screen) screen.setFrame({ erase: eraseFrame, draw: paintFrame, exclusive });
    process.stdout.on("resize", onResize);

    /* Ctrl+C 的语义必须挂在 readline 的 SIGINT 上，不能只在 keypress 里判 key.name==='c'：
       readline 自己会处理这个键，没有 'SIGINT' 监听器时它直接把这次输入关掉——
       实测 ^C 之后 keypress 不再送达，"有内容先清空"那行代码根本没机会跑。
       规则：有内容 → 清空当前输入；空行且这一轮在跑 → 中断它（输入框留着）；
       空行且空闲 → 取消这一次输入（上层再决定退不退）。 */
    rl.on("SIGINT", () => {
      if (value.length) { value = ""; cursor = 0; updateMode(); redraw(); return; }
      /* 空行 + 正在跑：这一键是"停下手头那轮"，输入框原样留着 */
      if (isRunning()) { onInterrupt(); redraw(); return; }
      aborted = true;
      finish();
    });

    /* keypress 处理函数引用——finish 时必须移除，否则每次 inputBox 调用
       都往 process.stdin 叠一个监听器，旧监听器仍会触发并调 setRawMode(false)，
       把新输入框的 raw mode 关掉，导致按键不进新框 → 无法回复 */
    const onKeypress = async (ch, key) => {
      if (!key) return;
      /* 面板/搜索/编辑器这几个分支是 async 的：keypress 不会等它，
         连按两次 ^K 会叠起两个面板（第二个盖在第一个上，退出后 raw mode 状态说不清）。 */
      if (busy) return;

      /* Esc：先关斜杠菜单，菜单没开才当作"取消本次输入"。
         原先顺序反了——Esc 无条件 abort，下面菜单里那条 escape 分支永远进不去。 */
      if (key.name === "escape") {
        if (slashList) { slashList = null; slashIdx = 0; redraw(); return; }
        aborted = true;
        finish();
        return;
      }

      /* Ctrl+C 走上面的 SIGINT，不在这里重复处理 */

      /* Ctrl+K 命令面板 */
      if (key.ctrl && key.name === "k" && onCommandPalette) {
        const result = await withBusy(() => onCommandPalette());
        if (result && result.text) { value = result.text; cursor = value.length; }
        redraw();
        return;
      }

      /* Ctrl+R 历史搜索 */
      if (key.ctrl && key.name === "r" && onHistorySearch) {
        const result = await withBusy(() => onHistorySearch(history));
        if (result) { value = result; cursor = value.length; }
        redraw();
        return;
      }

      /* Ctrl+O transcript */
      if (key.ctrl && key.name === "o" && onTranscript) {
        await withBusy(() => onTranscript());
        redraw();
        return;
      }

      /* Ctrl+X E 外部编辑器 */
      if (key.ctrl && key.name === "x" && onExternalEditor) {
        const result = await withBusy(() => onExternalEditor(value));
        if (result != null) { value = result; cursor = value.length; }
        redraw();
        return;
      }

      /* Ctrl+L 重绘：只重画输入框这一帧。
         原先是 \x1b[2J 全屏清除——把用户刚读到的对话一起抹掉了，
         "屏幕花了"的救急键不该顺手销毁内容。 */
      if (key.ctrl && key.name === "l") {
        state.frame = null;
        redraw();
        return;
      }

      /* 斜杠命令列表导航（列表可见时拦截 ↑↓/Enter/Tab/Esc） */
      if (slashList) {
        if (key.name === "up") {
          slashIdx = (slashIdx - 1 + slashList.length) % slashList.length;
          redraw();
          return;
        }
        if (key.name === "down") {
          slashIdx = (slashIdx + 1) % slashList.length;
          redraw();
          return;
        }
        if (key.name === "return" || key.name === "tab") {
          const it = slashList[slashIdx];
          if (it) {
            if (key.name === "tab") {
              /* Tab：补全命令名 + 空格，继续输参数 */
              value = it.cmd + " ";
              cursor = value.length;
              updateMode();
              slashList = null; slashIdx = 0;
              redraw();
              return;
            }
            /* Enter：对齐前端 pickSlash
               - expand 命令（/fix /refactor 等）：填入展开文本，可编辑后 Enter 发送
               - 普通命令：直接提交执行 */
            if (it.expand) {
              value = it.expand;
              cursor = value.length;
              updateMode();
              slashList = null; slashIdx = 0;
              redraw();
              return;
            }
            value = it.cmd;
            cursor = value.length;
            slashList = null; slashIdx = 0;
            finish(value);
            return;
          }
        }
        /* 这里原来还有一条 escape 关菜单的分支：文件顶部那串按键处理先判 escape 并 abort，
           它永远轮不到。现在关菜单的逻辑已经挪到顶部那条 escape 分支里了。 */
      }

      /* Enter */
      if (key.name === "return") {
        if (value.endsWith("\\")) {
          value = value.slice(0, -1) + "\n";
          cursor = value.length;
          updateMode();
          redraw();
          return;
        }
        finish(value);
        return;
      }

      /* ↑ / ↓ 历史 */
      if (key.name === "up" && !key.shift) {
        if (histIdx > 0) { histIdx--; value = history[histIdx] || ""; cursor = value.length; updateMode(); redraw(); }
        return;
      }
      if (key.name === "down" && !key.shift) {
        if (histIdx < history.length) { histIdx++; value = histIdx === history.length ? "" : history[histIdx] || ""; cursor = value.length; updateMode(); redraw(); }
        return;
      }

      /* 左右移动 */
      if (key.name === "left") { if (cursor > 0) { cursor--; redraw(); } return; }
      if (key.name === "right") { if (cursor < value.length) { cursor++; redraw(); } return; }

      /* Home / End */
      if (key.name === "home" || (key.ctrl && key.name === "a")) { cursor = 0; redraw(); return; }
      if (key.name === "end" || (key.ctrl && key.name === "e")) { cursor = value.length; redraw(); return; }

      /* Backspace */
      if (key.name === "backspace") {
        if (cursor > 0) { value = value.slice(0, cursor - 1) + value.slice(cursor); cursor--; updateMode(); redraw(); }
        return;
      }

      /* Delete */
      if (key.name === "delete" || (key.ctrl && key.name === "d")) {
        if (cursor < value.length) { value = value.slice(0, cursor) + value.slice(cursor + 1); updateMode(); redraw(); }
        return;
      }

      /* 这里原本挂着一支 Shift+Enter 换行：它排在普通 return 分支之后，永远轮不到；
         而且就算挪到前面也没用——多数终端（含 Windows Terminal 的默认协议）
         把 Shift+Enter 发成和 Enter 一样的 \r，Node 的 readline 分不出来。
         续行统一走行尾 \ ，那条在任何终端里都成立。 */

      /* 普通字符 */
      if (ch && !key.ctrl && !key.meta && ch.length > 0 && ch >= " ") {
        value = value.slice(0, cursor) + ch + value.slice(cursor);
        cursor++;
        updateMode();
        redraw();
        return;
      }
    };

    rl.input.on("keypress", onKeypress);
  });
}

module.exports = { inputBox, render, boxTop, boxBottom, statusLine, AUTO_PERMS };
