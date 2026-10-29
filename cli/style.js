/* ============================================================
   pancode-cli · ANSI 样式层
   ------------------------------------------------------------
   主题：亮青绿（对齐 IDE 侧「矩阵」主题色板）
     主色   #00d4aa  亮青绿  — 品牌、prompt 边框、AI 前缀
     霓虹   #00ffcc  亮青绿  — 计划模式、记忆、自动接受
     辉光   #7fffd4  浅青绿  — 建议、shimmer、用户标签
     暗边   #0d4a40  暗青绿  — 边框、subtle
     正文   #d6fff4  月白偏青
     成功   #69f0ae  芽绿    — diff add、工具成功（与主色拉开：G 高 B 低）
     错误   #ff5252  红      — diff remove、工具失败
     警告   #ffd28c  琥珀    — running、警告
   终端能力：truecolor > ansi256 > ansi16 > 无色
   ============================================================ */
"use strict";

/* ---------- 终端能力探测 ---------- */
const chalkLevel = (() => {
  if (process.env.NO_COLOR) return 0;
  if (process.stdout.isTTY === false) return 0;
  /* 优先用 Node.js 内置的颜色深度探测（Node ≥ 12） */
  if (typeof process.stdout.getColorDepth === "function") {
    try {
      const depth = process.stdout.getColorDepth();
      if (depth >= 24) return 3;   // truecolor
      if (depth >= 8) return 2;    // 256 色
      if (depth >= 4) return 1;    // 16 色
      return 0;
    } catch (_) {}
  }
  const t = process.env.TERM || "";
  // tmux 降级到 256（不透传 truecolor SGR）
  if (process.env.TMUX && !process.env.CLAUDE_CODE_TMUX_TRUECOLOR) return 2;
  // VS Code xterm.js 提升
  if (process.env.TERM_PROGRAM === "vscode") return 3;
  // Windows Terminal / ConEmu / Git Bash — 支持 truecolor
  if (process.env.WT_SESSION) return 3;
  if (process.env.ConEmuANSI === "ON") return 3;
  if (process.env.TERM_PROGRAM === "WindowsTerminal") return 3;
  if (/xterm-256|screen-256/.test(t)) return 2;
  if (/xterm|color|ansi|cygwin|tmux|screen/i.test(t)) return 1;
  // Windows 下 isTTY=true 但 TERM 未设——给 16 色（比无色好）
  return process.stdout.isTTY ? 1 : 0;
})();

/* ---------- ansi16 最近色映射 ---------- */
const ANSI16_COLORS = [
  [0, 0, 0],       [128, 0, 0],     [0, 128, 0],     [128, 128, 0],
  [0, 0, 128],     [128, 0, 128],   [0, 128, 128],   [192, 192, 192],
  [128, 128, 128], [255, 0, 0],     [0, 255, 0],     [255, 255, 0],
  [0, 0, 255],     [255, 0, 255],   [0, 255, 255],   [255, 255, 255],
];
function nearestAnsi16(r, g, b) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < 16; i++) {
    const [cr, cg, cb] = ANSI16_COLORS[i];
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/* ---------- 颜色构造器 ----------
   每个色都把自己的 RGB 挂在 .rgb 上：判据要能读回通道值来验"这确实是青绿"，
   而不是去解析转义串——转义串的形状随终端色深变（truecolor / 256 / 16），
   按它断言等于把判据绑在探针自己的运行环境上。 */
function rgb(r, g, b) {
  let made;
  if (chalkLevel === 0) made = { fg: (s) => String(s), bg: (s) => String(s) };
  else if (chalkLevel >= 3) {
    const fg = `\x1b[38;2;${r};${g};${b}m`;
    const bg = `\x1b[48;2;${r};${g};${b}m`;
    made = { fg: (s) => fg + String(s) + reset, bg: (s) => bg + String(s) + reset };
  } else if (chalkLevel >= 2) {
    // 256 色近似：16 + 36*r6 + 6*g6 + b6
    const c6 = (v) => (v < 48 ? 0 : v < 115 ? 1 : v < 155 ? 2 : v < 195 ? 3 : v < 235 ? 4 : 5);
    const code = 16 + 36 * c6(r) + 6 * c6(g) + c6(b);
    made = { fg: (s) => `\x1b[38;5;${code}m${s}${reset}`, bg: (s) => `\x1b[48;5;${code}m${s}${reset}` };
  } else {
    // ansi16 回退：找最近的命名色
    const code = nearestAnsi16(r, g, b);
    /* 0-7: 前景 30-37 / 背景 40-47；8-15(bright): 前景 90-97 / 背景 100-107 */
    const fgCode = code < 8 ? 30 + code : 82 + code;
    const bgCode = code < 8 ? 40 + code : 92 + code;
    made = { fg: (s) => `\x1b[${fgCode}m${s}${reset}`, bg: (s) => `\x1b[${bgCode}m${s}${reset}` };
  }
  made.rgb = [r, g, b];
  return made;
}

const reset = "\x1b[0m";
function ansi(code) {
  if (chalkLevel === 0) return (s) => String(s);
  return (s) => `\x1b[${code}m${s}${reset}`;
}

/* ---------- 亮青绿调色板 ----------
   色值对齐 IDE 侧已有的「矩阵」主题色板（#050807 底 / #00d4aa 主 / #00ffcc 亮），
   两个产品同一套视觉语言，改一处就能对上另一处。
   注意主色与"成功"色都是绿的：主色走青（B 高），成功色走芽绿（G 高、B 低），
   不然"这一步成功了"和"这是品牌色"在屏幕上分不出来。 */
const P = {
  openanlan:    rgb(0, 212, 170),     // #00d4aa 主色 亮青绿
  openanlanShim:rgb(214, 255, 244),   // #d6fff4 月白偏青（正文）
  autoAccept:   rgb(0, 255, 204),     // #00ffcc 霓虹亮青绿
  permission:   rgb(0, 212, 170),     // #00d4aa
  suggestion:   rgb(127, 255, 212),   // #7fffd4 辉光浅青绿（aquamarine）
  remember:     rgb(0, 255, 204),     // #00ffcc
  planMode:     rgb(0, 255, 204),     // #00ffcc
  promptBorder: rgb(0, 212, 170),     // #00d4aa
  bashBorder:   rgb(13, 74, 64),      // #0d4a40 暗青绿边
  subtle:       rgb(13, 74, 64),      // #0d4a40
  text:         rgb(214, 255, 244),   // #d6fff4 正文
  inverseText:  rgb(233, 255, 248),   // 用户消息（近白）
  inactive:     rgb(77, 138, 124),    // #4d8a7c 暗青灰
  success:      rgb(105, 240, 174),   // #69f0ae 芽绿（与主色拉开：G 高、B 低）
  error:        rgb(255, 82, 82),     // #ff5252
  warning:      rgb(255, 210, 140),   // #ffd28c 琥珀
  diffAdded:    rgb(105, 240, 174),   // #69f0ae
  diffRemoved:  rgb(255, 82, 82),     // #ff5252
  diffAddedDim: rgb(30, 120, 78),     // 暗青绿
  diffRemovedDim:rgb(120, 40, 40),    // 暗红
  diffAddedWord:rgb(150, 255, 205),   // 亮芽绿
  diffRemovedWord:rgb(255, 120, 120), // 亮红
  diffText:     rgb(214, 255, 244),   // 正文
  userBg:       rgb(8, 40, 35),       // 深夜青
  msgActionBg:  rgb(12, 56, 48),      // 深青
  selectionBg:  rgb(40, 64, 60),      // 中性深青灰
  selectionFg:  rgb(232, 255, 246),   // 浅青白
  fastMode:     rgb(255, 210, 140),   // 琥珀
  briefLabelYou:rgb(127, 255, 212),   // 辉光浅青绿
  // 子 Agent 8 色：蓝紫那几支往青绿侧靠，保留彼此可辨
  subRed:    rgb(255, 82, 82),
  subBlue:   rgb(0, 212, 170),        // 主色
  subGreen:  rgb(105, 240, 174),      // 芽绿
  subYellow: rgb(255, 210, 140),
  subPurple: rgb(160, 130, 240),
  subOrange: rgb(255, 180, 130),
  subPink:   rgb(230, 150, 210),
  subCyan:   rgb(0, 255, 204),        // 霓虹
};

/* ---------- 基础修饰 ---------- */
const mod = {
  dim:    ansi(2),
  bold:   ansi(1),
  italic: ansi(3),
  underline: ansi(4),
  inverse: ansi(7),
};

/* ---------- 兼容旧 API 的 c 对象 ---------- */
const c = {
  dim:     mod.dim,
  bold:    mod.bold,
  italic:  mod.italic,
  cyan:    P.openanlan.fg,      // 主色 #4fc3f7
  green:   P.success.fg,
  red:     P.error.fg,
  yellow:  P.warning.fg,
  blue:    P.suggestion.fg,     // 辉光浅翠
  magenta: P.subPurple.fg,
  gray:    mod.dim,
  bgCyan:  P.openanlan.bg,
  bgGreen: P.success.bg,
  bgRed:   P.error.bg,
  bgYellow:P.warning.bg,
};

/* ---------- 语义色别名（对齐 OpenAnLan Terminal theme keys） ---------- */
const accent      = P.openanlan.fg;   // 主色 #4fc3f7
const accentShim  = P.suggestion.fg;  // 辉光 #81d4fa
const neon        = P.autoAccept.fg;  // 霓虹 #00e5ff
const thinkFg     = mod.dim;          // 思考块 dim
const ok          = P.success.fg;     // #69f0ae
const err         = P.error.fg;       // #ff5252
const warn        = P.warning.fg;     // #ffd28c
const dim         = mod.dim;
const border      = P.subtle.fg;      // #1a3a5c 暗蓝边
const promptBorder= P.promptBorder.fg;// #4fc3f7
const bashBorder  = P.bashBorder.fg;  // #1a3a5c
const text        = P.text.fg;        // 浅灰白
const inverseText = P.inverseText.fg; // 纯白
const inactive    = P.inactive.fg;    // 暗蓝灰

/* ---------- 终端符号（对齐 OpenAnLan CLI） ---------- */
const MOON = "⊂";         // U+2282 — AI 前缀（OpenAnLan 风格）
const MOON_BAR = "›";     // U+203A — 用户前缀
const TEARDROP = "●";     // U+25CF — 工具 loader
const CIRCLE = "●";       // U+25CF — 工具 loader (非 darwin)
const ARROW_DOWN = "↓";   // token 计数前
const ARROW_UP = "↑";     // requesting
const NEST = "⎿";         // U+23BF — AI 响应缩进
const THINKING = "∴";     // U+2234 — 思考块
const BLOCKQUOTE_BAR = "▎"; // U+258E

/* 状态类符号：一律 BMP 单色字符。
   原先这里混着 📷 📦  🎯  ⏳  这类星平面 emoji——它们在终端里占 2 列，
   而宽度尺子按 1 列算，凡是带 emoji 的行回删/折行行数都会偏少，留下半行鬼影；
   另外 emoji 的渲染完全取决于字体，同一行在 Windows Terminal 和 VS Code 里宽窄不一。 */
const PLAN = "≡";         // U+2261 — 计划
const ORCH = "⎇";         // U+2347 — 多 Agent 编排
const SKILL = "✦";        // U+2726 — 技能沉淀
const MEMORY = "◉";       // U+25C9 — 记忆
const GOAL = "◎";         // U+25CE — 目标
const PATCH = "±";        // U+00B1 — 待审阅补丁
const FILE_EDIT = "✎";    // U+270E — 文件改动
const FILE_DEL = "⊘";     // U+2298 — 文件删除
const ARTIFACT = "▣";     // U+25A3 — 交付物
const SHOT = "⊡";         // U+22A1 — 截图
const BUDGET = "⊟";       // U+229F — 预算
const QUEUE = "⋯";        // U+22EF — 排队
const RETRY = "↻";        // U+21BB — 重试
const COMPACT = "↺";      // U+21BA — 上下文压缩
const REWIND = "↶";       // U+21B6 — 回退

/* ---------- 缩进 ---------- */
function indent(text, n) {
  const pad = "  ".repeat(n || 1);
  return String(text).split("\n").map((l) => pad + l).join("\n");
}

/* ---------- 胶囊角标 ---------- */
function badge(text, color) {
  const fn = color || accent;
  return fn(" " + String(text) + " ");
}

/* ---------- 可见长度 = 显示列数 ----------
   名字叫 stripLen，但它返回的是**列数**不是字符数。原因：全仓 12 处调用点
   （box/banner/代码块边框/斜杠菜单/命令面板/光标定位）拿它去算 `" ".repeat(w - len)`，
   要的都是列数；用字符数会让每个含中文的框右边界错位（实测差 7 列）。
   留着这个名字是历史包袱，改语义比改 12 个调用点更不容易再错。
   要真的字符数请写 `s.replace(/\x1b\[[0-9;]*m/g, "").length`。 */
function stripLen(s) {
  return displayWidth(s);
}

/* ---------- 显示宽度（CJK/全角/emoji 占 2 列，组合符号占 0 列） ---------- */
function displayWidth(s) {
  const str = String(s).replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) || 0;
    /* 组合附加符、零宽字符、变体选择符、ZWJ：终端不占列，算进去会把整行宽度撑虚 */
    if (
      (code >= 0x0300 && code <= 0x036f) ||  /* 组合用附加符号 */
      (code >= 0x200b && code <= 0x200f) ||  /* 零宽空格/方向标记 */
      code === 0x200d ||                      /* ZWJ（emoji 序列的连接符） */
      (code >= 0x20d0 && code <= 0x20f0) ||  /* 组合用符号 */
      (code >= 0xfe00 && code <= 0xfe0f) ||  /* 变体选择符 */
      (code >= 0xe0100 && code <= 0xe01ef)    /* 补充变体选择符 */
    ) continue;
    /* 星平面 emoji（📷 📦 📊 🎯 🧠 等）在现代终端里一律占 2 列。
       只认 >=0x1F000 这一段：BMP 里的 ⎿ ✎ ▰ ● ⊂ 这些是窄的，扩进去反而会新错。 */
    if (code >= 0x1f000 && code <= 0x1faff) { w += 2; continue; }
    /* CJK 统一表意、全角标点、CJK 兼容、韩文、日文假名 → 2 列 */
    if (
      (code >= 0x1100 && code <= 0x115f) ||  /* 韩文 Jamo */
      (code >= 0x2e80 && code <= 0x303e) ||  /* CJK 标点/部首 */
      (code >= 0x3040 && code <= 0x33bf) ||  /* 假名/兼容 */
      (code >= 0x3400 && code <= 0x4dbf) ||  /* CJK 扩展A */
      (code >= 0x4e00 && code <= 0x9fff) ||  /* CJK 统一表意 */
      (code >= 0xa000 && code <= 0xa4cf) ||  /* 彝文 */
      (code >= 0xac00 && code <= 0xd7a3) ||  /* 韩文音节 */
      (code >= 0xf900 && code <= 0xfaff) ||  /* CJK 兼容表意 */
      (code >= 0xfe30 && code <= 0xfe6f) ||  /* CJK 兼容形式 */
      (code >= 0xff00 && code <= 0xff60) ||  /* 全角ASCII */
      (code >= 0xffe0 && code <= 0xffe6)     /* 全角符号 */
    ) w += 2;
    else w += 1;
  }
  return w;
}

/* ---------- 按显示列数截断（ANSI 感知：转义序列不占列，也不被丢掉） ----------
   截断类地方以前要么用 String.slice(0, n)（按字符切，中文切一半、实际列数超预算），
   要么先 replace 掉 ANSI 再切（把颜色整个丢了）。两种都会让右边框歪。 */
function truncateCols(s, maxCols, ellipsis) {
  const str = String(s == null ? "" : s);
  if (displayWidth(str) <= maxCols) return str;
  const tail = ellipsis == null ? "…" : ellipsis;
  const budget = Math.max(0, maxCols - displayWidth(tail));
  let w = 0, out = "", i = 0;
  while (i < str.length) {
    if (str.charCodeAt(i) === 0x1b && str[i + 1] === "[") {
      /* 整段 CSI 原样保留，不计列 */
      let j = i + 2;
      while (j < str.length && !/[\x40-\x7e]/.test(str[j])) j++;
      out += str.slice(i, Math.min(j + 1, str.length));
      i = j + 1;
      continue;
    }
    const ch = String.fromCodePoint(str.codePointAt(i));
    const cw = displayWidth(ch);
    if (w + cw > budget) break;
    out += ch; w += cw;
    i += ch.length;
  }
  /* 补一次复位：否则被截内容留下的前景色会一路染到行尾 */
  return out + tail + "\x1b[0m";
}

/* ---------- 按显示列数右侧补空格（String.padEnd 是按字符补，中文会短半格） ---------- */
function padCols(s, cols) {
  const str = String(s == null ? "" : s);
  const need = cols - displayWidth(str);
  return need > 0 ? str + " ".repeat(need) : str;
}

/* ---------- 多行文本占用的屏幕行数（考虑折行） ---------- */
function screenRows(text, cols) {
  cols = cols || process.stdout.columns || 80;
  const lines = String(text).split("\n");
  let rows = 0;
  for (const line of lines) {
    const dw = displayWidth(line);
    rows += Math.max(1, Math.ceil(dw / cols));
  }
  return rows;
}

/* ---------- 单行边框卡片 ---------- */
function box(title, body, opts) {
  opts = opts || {};
  const w = Math.min(process.stdout.columns || 80, 100) - 2;
  const bd = opts.border || border;
  const top = bd("┌" + "─".repeat(Math.max(2, w - 2)) + "┐");
  const bot = bd("└" + "─".repeat(Math.max(2, w - 2)) + "┘");
  const titleLine = title ? "  " + badge(title, opts.titleColor || accent) : "";
  const mid = bd("│") + titleLine + " ".repeat(Math.max(0, w - 2 - stripLen(titleLine))) + bd("│");
  const bodyLines = String(body || "").split("\n").map((l) =>
    bd("│") + " " + l + " ".repeat(Math.max(0, w - 2 - stripLen(l) - 1)) + bd("│"));
  return [top, mid, bd("├") + "─".repeat(Math.max(2, w - 2)) + bd("┤"), ...bodyLines, bot].join("\n");
}

/* ---------- diff 着色 ---------- */
function colorizeDiff(text) {
  return String(text).split("\n").map((l) => {
    if (/^\+/.test(l) && !/^\+\+/.test(l)) return P.diffAdded.fg(l);
    if (/^-/.test(l) && !/^--/.test(l)) return P.diffRemoved.fg(l);
    return dim(l);
  }).join("\n");
}

/* diff 行级背景色（对齐 openanlan diffAdded/diffRemoved） */
function diffLineBg(line, kind) {
  if (kind === "add")    return P.diffAdded.bg(line);
  if (kind === "remove") return P.diffRemoved.bg(line);
  return line;
}

/* ---------- 工具种类色 ---------- */
function toolKindColor(kind) {
  if (kind === "read")     return P.suggestion.fg;  // 辉光浅蓝
  if (kind === "edit")     return warn;             // 琥珀
  if (kind === "terminal") return ok;               // 翠绿
  if (kind === "search")   return P.subPurple.fg;   // 靛紫
  if (kind === "git")      return P.subOrange.fg;   // 浅琥珀
  return accent;
}

/* ---------- 状态色 ---------- */
function statusColor(s) {
  if (s === "done")    return ok;
  if (s === "fail")    return err;
  if (s === "running") return warn;
  if (s === "pending") return dim;
  return dim;
}

/* ---------- 上下文进度条色 ---------- */
function ctxColor(pct) {
  if (pct >= 80) return err;
  if (pct >= 50) return warn;
  return accent;
}

/* ---------- 清屏 / 分隔线 ---------- */
function clear() { process.stdout.write("\x1b[2J\x1b[H"); }

function hr() {
  const w = Math.min(process.stdout.columns || 80, 100);
  return dim("─".repeat(w));
}

/* ---------- Spinner 帧序列（12 帧来回循环） ---------- */
const SPINNER_CHARS = process.platform === "darwin"
  ? ["·", "✢", "✳", "✶", "✻", "✽"]
  : ["·", "✢", "*", "✶", "✻", "✽"];
const SPINNER_FRAMES = [...SPINNER_CHARS, ...[...SPINNER_CHARS].reverse()];

module.exports = {
  chalkLevel,
  // 色板
  P, c, mod,
  // 语义色
  accent, accentShim, neon, thinkFg, ok, err, warn, dim, border,
  promptBorder, bashBorder, text, inverseText, inactive,
  // 符号
  MOON, MOON_BAR, TEARDROP, CIRCLE, ARROW_DOWN, ARROW_UP, NEST, THINKING, BLOCKQUOTE_BAR,
  PLAN, ORCH, SKILL, MEMORY, GOAL, PATCH, FILE_EDIT, FILE_DEL, ARTIFACT, SHOT, BUDGET,
  QUEUE, RETRY, COMPACT, REWIND,
  // 工具
  indent, badge, box, stripLen, displayWidth, screenRows, truncateCols, padCols, colorizeDiff, diffLineBg,
  toolKindColor, statusColor, ctxColor,
  clear, hr,
  // spinner
  SPINNER_FRAMES,
  // 能力
  supports: chalkLevel > 0,
  chalkLevel,
};
