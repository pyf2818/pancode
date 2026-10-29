/* ============================================================
   pancode-cli · 输出仲裁层
   ------------------------------------------------------------
   终端上只有一个光标。以前有两拨人各写各的：
     · 渲染器：事件来了就往 stdout 追一行（append）
     · 输入框：就地擦掉重画一帧（in-place）
   两者共用光标却互不知情。后果是异步事件（沉淀 / 预算 / 上下文压缩 / 排队提示）
   一旦落在输入框画好之后，就把帧咬出一个洞；上一版为了躲这个洞，在每轮末尾
   死等 800ms —— 那是拿睡眠赌异步完成，沉淀里还有三个 LLM 调用，慢的时候远超 0.8 秒。

   现在所有输出都走这一层：屏幕上只有一块"活动区"（流式正文 + 输入框帧），
   要写一行就 **擦活动区 → 写在它上方 → 把活动区画回去**。
   写的一方不需要知道帧存在，也就不用在渲染层塞"本轮有没有改盘工具"这类补丁。
   ============================================================ */
"use strict";

const S = require("./style");

/* 活动区 = 流式正文尾巴 + 输入框帧。
   两者都"就地重画"，所以必须当成一块来擦：光标只能有一个，
   各擦各的必然把对方咬穿（上一版的洞就是这么来的）。 */
function createScreen(stdout) {
  /* 没显式给流时每次现取 process.stdout —— 探针会把 stdout 换成假 TTY，
     在这里捕获引用的话，换流之后的输出就绕开仲裁层自己跑了。 */
  const out = () => stdout || process.stdout;
  /* frame = { erase(), draw() }：erase 把光标回到帧顶并清到屏幕末尾；
     draw 重新画整帧并把光标放回输入位。两者都不做对方该做的事，
     调用方一律成对使用（aboveFrame 就是这个配对）。 */
  let frame = null;
  /* live = 正在长出来的那段流式正文（不含结尾换行）。
     它以前由渲染器自己数行数往上擦 —— 那是把"帧"的存在当已知前提写的代码，
     输入框一常驻，数出来的行数就把框本身算进去了。 */
  let live = "";

  function raw(s) { out().write(String(s)); }
  function rawLine(s) { out().write(String(s) + "\n"); }
  function cols() { return out().columns || 80; }

  function erase() {
    /* 先擦下面的帧：frame.erase() 把光标带回帧顶（它只按自己记的行数上移，不受上方影响），
       再按流式正文占的物理行继续上移。顺序反了就站在帧中间数上面的行数，全错。 */
    if (frame) frame.erase();
    if (live) {
      const n = S.screenRows(live, cols());
      /* 有帧时正文之后补过一个换行，正文占满 n 行，要上移 n 行才回到正文第一行；
         没有帧就没有"之下"要留给谁，不补那个换行——光标本就停在正文最后一行，只上移 n-1。
         差的就是那一个换行：补着擦少一行、不补着擦多一行，两边必须同一个口径。 */
      const up = frame ? n : Math.max(0, n - 1);
      if (up > 0) raw("\x1b[" + up + "A");
      raw("\r\x1b[J");
    }
  }
  function paint() {
    if (live) {
      raw(live);
      /* 帧要落在正文之下，靠的就是这个换行；没有帧就没有"之下"，不补 */
      if (frame) raw("\n");
    }
    if (frame) frame.draw();
  }

  /* 在"活动区已擦除"的状态下执行一段直接写操作，做完把活动区画回去。
     可重入：已经在活动区上方写作时（inside=true）嵌套调用不再擦第二次，
     否则内层的 line() 会把刚擦出来的位置再往上挪一遍，帧就画歪了。 */
  let inside = false;
  /* 弹窗（审批/选择）独占屏幕的那段时间：渲染器一个字节都不往上面写 */
  let suspended = false;
  function aboveFrame(fn) {
    if ((!frame && !live) || inside) return fn();
    inside = true;
    erase();
    try { return fn(); } finally { inside = false; paint(); }
  }

  return {
    /* 一行普通输出：落在活动区上方 */
    line(text) { aboveFrame(() => rawLine(text)); },
    /* 不带换行的一段输出：一次性写完后自己补换行的那种（term.line）走这里 */
    write(text) { aboveFrame(() => raw(text)); },
    /* 流式正文换了内容：擦掉旧的尾巴、写新的、把帧放回原位。
       擦用的是**上一次**的 live，所以先擦再赋值 —— 反过来会把刚写出去的行当成旧的擦掉。 */
    setLive(text) {
      const next = text == null ? "" : String(text);
      if (inside) { live = next; return; }
      erase();
      live = next;
      paint();
    },
    /* 内容没变、只是动画要走下一格（状态行 spinner）：原地重擦重画 */
    refresh() {
      if (inside || (!frame && !live)) return;
      inside = true;
      try { erase(); paint(); } finally { inside = false; }
    },
    aboveFrame,
    /* 要独占 stdin 的界面（审批 / ask_choice 选择）：活动区整块让出去，问完再收回。
       运行期输入框常驻之后这才第一次成为问题——以前跑到一半根本没有框。
       怎么让由帧自己定（光标与 raw mode 在它手里），仲裁层只转发并记这段时间。 */
    exclusive(fn) {
      if (!frame || !frame.exclusive) return fn();
      suspended = true;
      const back = (v) => { suspended = false; return v; };
      const boom = (e) => { suspended = false; throw e; };
      let p;
      try { p = frame.exclusive(fn); } catch (e) { suspended = false; throw e; }
      /* 同步返回（没有 promise）时立刻复位，别把这一次当成一直在弹窗 */
      if (!p || typeof p.then !== "function") return back(p);
      return p.then(back, boom);
    },
    isSuspended() { return suspended; },
    setFrame(f) { frame = f || null; },
    clearFrame() { frame = null; },
    hasFrame() { return !!frame; },
  };
}

module.exports = { createScreen };
