/* CLI 终端界面实测（批 1：列宽口径）
   ————————————————————————————————————————————
   守的问题：终端里没有"像素"这回事，一切布局都建立在"这一串字占几列"上。
   pancode-cli 原先有两把尺子——stripLen 数**字符**、displayWidth 数**列**——
   而 12 处 padding 全用了前者。中文一个字占 2 列，于是每一个含中文的框
   右边界都错位（实测 style.box() 五行边界 78/82/78/85/78，纯 ASCII 对照全等）。
   同一类错还有：banner 第二行硬编码 62 补空格、cmd.padEnd(14) 在带 ANSI 的串上算长度、
   代码块超宽行只把 padding 夹到 0、emoji 被算成 1 列导致回删行数偏少。

   这里量的不是"代码里写了什么"，而是**渲染器真正写出去的字节里，每一行的右边界落在第几列**。
   全程不起引擎、不打 LLM、不碰开发者数据根（_sandbox 只做兜底隔离）。
   用法：node scripts/_verify_cliui.js
*/
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "cliui" });

/* style.js 的色深是在 require 那一刻按 stdout 能力定的：探针的 stdout 是管道，
   isTTY=false → chalkLevel=0 → 全仓不产生任何转义序列，于是"保留 ANSI""用错误色"
   这类判据会集体空转（绿得毫无意义）。这里在 require cli/style 之前把终端能力打开，
   让探针量的是真终端里那一串字节。 */
process.env.FORCE_COLOR = "3";
process.stdout.isTTY = true;

const fs = require("fs");
const path = require("path");

const S = require("../cli/style");
const { renderMd } = require("../cli/markdown");
const { render: renderInputBox } = require("../cli/inputbox");
const { banner } = require("../cli/cli");

/* 结论一律写到"真"stdout：⑭ 那段会把 process.stdout 临时换成假终端，
   用 console.log 的话，换的期间打印的判定结果会被喂进假终端的字节流里，
   屏幕上什么都看不到，还会把被测量的字节污染掉。 */
const REAL_OUT = process.stdout;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; REAL_OUT.write("  \x1b[32m✓\x1b[0m " + name + "\n"); }
  else {
    fail++; fails.push(name + (detail ? " — " + detail : ""));
    REAL_OUT.write("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "") + "\n");
  }
}
function section(t) { REAL_OUT.write("\n\x1b[1m" + t + "\x1b[0m\n"); }

/* 剥掉 ANSI，只留可见字符 */
const bare = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
/* 一行的右边界 = 它占的列数 */
const edge = (line) => S.displayWidth(line);
/* 一组边框行是否落在同一列 */
function edgesOf(text) { return String(text).split("\n").map(edge); }
function allEqual(list) { return new Set(list).size === 1; }
function spread(list) { return Math.max(...list) - Math.min(...list); }

/* 捕获 stdout 的写入（banner 这类直接写 process.stdout 的函数靠它量） */
function capture(fn) {
  const real = process.stdout.write.bind(process.stdout);
  const buf = [];
  process.stdout.write = (c) => { buf.push(String(c)); return true; };
  try { fn(); } finally { process.stdout.write = real; }
  return buf.join("");
}

/* 屏幕模型：按终端规则把字节流还原成"最后屏幕上剩什么"。
   字节流里出现过某段文字 ≠ 用户看得见它 —— 活动区每一段都是先擦再写，
   中间稿全都躺在字节历史里。判据要问显示结果，就只能自己把光标走一遍。
   只认这里会用到的几种序列：CSI A/B/C/D（移光标）、J/K（清到末尾 / 清到行尾）、\r、\n、退格。 */
function screenModel(bytes, cols) {
  cols = cols || (process.stdout.columns || 80);
  const src = String(bytes).replace(/\x1b\[[0-9;]*m/g, "");
  const lines = [];
  const row = (r) => { while (lines.length <= r) lines.push([]); return lines[r]; };
  let r = 0, c = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\x1b" && src[i + 1] === "[") {
      /* 从 ESC 的下一位开始匹配：正则锚在 "[" 上，从 ESC 本身切永远匹配不到，
         匹配不到就会把整条指令当普通字符写上屏幕（第一版就是这么假绿的）。 */
      const m = /^\[(\d*)([A-Za-z])/.exec(src.slice(i + 1));
      if (m) {
        const n = m[1] === "" ? 0 : Number(m[1]);
        if (m[2] === "A") r = Math.max(0, r - n);
        else if (m[2] === "B") r += n;
        else if (m[2] === "C") c += n;
        else if (m[2] === "D") c = Math.max(0, c - n);
        else if (m[2] === "J") {
          row(r).length = c;
          for (let k = lines.length - 1; k > r; k--) lines.splice(k, 1);
        } else if (m[2] === "K") row(r).length = c;
        /* m[0] 不含 ESC，外层 for 还会 +1：所以总共跳过 m[0].length + 1 - 1 */
        i += m[0].length;
        continue;
      }
    }
    if (ch === "\r") { c = 0; continue; }
    if (ch === "\n") { r++; c = 0; row(r); continue; }
    if (ch === "\x08") { c = Math.max(0, c - 1); continue; }
    /* 一个中文/emoji 占 2 列：按字符数走光标的话，帧的擦除行数在这台模型上永远对不上，
       量出来的"叠了 17 个框"是模型的错，不是产品的。列数口径必须和被测代码同一个尺子。 */
    const w = S.displayWidth(ch);
    if (c + w > cols) { r++; c = 0; row(r); }
    const target = row(r);
    for (let k = 0; k < Math.max(1, w); k++) target[c + k] = k === 0 ? ch : "";
    c += Math.max(1, w);
  }
  return lines.map((l) => l.map((x) => (x == null ? " " : x)).join("").replace(/\s+$/, ""));
}

/* 判据自己也得有区分力：样例里必须真的带转义序列，否则"保留 ANSI"那条是空测 */
const ANSI_SAMPLE = "\x1b[31m红字\x1b[0m和ascii";

section("① 尺子本身：displayWidth 要按终端实际占的列数算");
ok("探针跑在有色终端口径下（否则下面所有 ANSI 判据都是空测）",
  S.chalkLevel >= 1, "chalkLevel=" + S.chalkLevel);
/* 色深随环境变（本机管道下 FORCE_COLOR=3 只给到 256 色），所以"用了哪个色"
   不能硬写转义串——拿调色板自己产生的前缀去比，才是判据真正想说的东西。 */
const ERR_OPEN = S.err("X").slice(0, S.err("X").indexOf("X"));
ok("ASCII 按 1 列", S.displayWidth("abc") === 3, "实测 " + S.displayWidth("abc"));
ok("CJK 按 2 列", S.displayWidth("中文") === 4, "实测 " + S.displayWidth("中文"));
ok("全角标点按 2 列", S.displayWidth("：（）") === 6, "实测 " + S.displayWidth("：（）"));
ok("星平面 emoji 按 2 列（渲染器用它打状态行）",
  ["📷", "📦", "📊", "🎯", "🧠"].every((e) => S.displayWidth(e) === 2),
  "实测 " + ["📷", "📦", "📊", "🎯", "🧠"].map((e) => e + "=" + S.displayWidth(e)).join(" "));
ok("BMP 符号仍按 1 列（⎿  ▰ 是窄的，扩进去会新错）",
  S.displayWidth("⎿") === 1 && S.displayWidth("▰") === 1,
  "⎿=" + S.displayWidth("⎿") + " ▰=" + S.displayWidth("▰"));
ok("组合附加符占 0 列", S.displayWidth("e\u0301") === 1, "实测 " + S.displayWidth("e\u0301"));
ok("变体选择符 / 零宽占 0 列",
  S.displayWidth("\uFE0F") === 0 && S.displayWidth("\u200B") === 0,
  "VS16=" + S.displayWidth("\uFE0F") + " ZWSP=" + S.displayWidth("\u200B"));
ok("ZWJ emoji 序列不重复计列", S.displayWidth("👨\u200D👩\u200D👧") === 6,
  "实测 " + S.displayWidth("👨\u200D👩\u200D👧") + "（3 个 emoji×2 列，两个 ZWJ 计 0）");
ok("样例串确实带转义序列（否则下面的 ANSI 判据是空测）", ANSI_SAMPLE.indexOf("\x1b[") >= 0);
ok("stripLen 与 displayWidth 同口径（12 处 padding 都靠它）",
  S.stripLen(ANSI_SAMPLE) === S.displayWidth(ANSI_SAMPLE) && S.stripLen(ANSI_SAMPLE) === 11,
  "stripLen=" + S.stripLen(ANSI_SAMPLE) + " displayWidth=" + S.displayWidth(ANSI_SAMPLE) +
  "（可见串是「红字和ascii」= 3 个中文 6 列 + ascii 5 列 = 11）");

section("② 截断与补位：按列，不按字符，也不丢颜色");
const t1 = S.truncateCols("中文中文中文", 5);
ok("truncateCols 结果不超预算", S.displayWidth(t1) <= 5, "实测 " + S.displayWidth(t1) + " 列：" + bare(t1));
const t2 = S.truncateCols(ANSI_SAMPLE, 4);
ok("truncateCols 保留 ANSI（不是先剥色再切）", t2.indexOf("\x1b[") >= 0, JSON.stringify(t2));
ok("truncateCols 截完补复位，颜色不染到行尾", /\x1b\[0m$/.test(t2), JSON.stringify(t2.slice(-8)));
const t3 = S.truncateCols(ANSI_SAMPLE, 99);
ok("没超预算时原样返回", t3 === ANSI_SAMPLE, JSON.stringify(t3));
ok("padCols 按列补齐（含中文）", S.displayWidth(S.padCols("中文", 10)) === 10,
  "实测 " + S.displayWidth(S.padCols("中文", 10)));
ok("padCols 超预算不强缩（交回调用方截断）", S.padCols("中文中文", 3) === "中文中文");

section("③ style.box()：含中文的框，右边界必须落在同一列");
const cjkBox = edgesOf(S.box("技能市场", "本地已装 3 个技能"));
ok("box 中文标题+中文正文：右边界全等", allEqual(cjkBox),
  "各行列数 " + JSON.stringify(cjkBox) + "（错位 " + spread(cjkBox) + " 列）");
const asciiBox = edgesOf(S.box("skills", "3 installed"));
ok("box ASCII 对照：右边界全等", allEqual(asciiBox), JSON.stringify(asciiBox));
ok("两种语言的框同宽（说明补的是列不是字符）",
  Math.max(...cjkBox) === Math.max(...asciiBox), "中文框 " + Math.max(...cjkBox) + " / ASCII 框 " + Math.max(...asciiBox));

section("④ banner：三行边框对齐（原先第二行硬编码 62 补空格）");
const bannerOut = capture(() => banner());
/* banner 自己先写了一个 "\n"，split 出来首行是空串——它不是边框行，别拿进比较 */
const bannerEdges = edgesOf(bannerOut).filter((e) => e > 0);
ok("banner 每行右边界全等", allEqual(bannerEdges) && bannerEdges.length === 4,
  "各行列数 " + JSON.stringify(bannerEdges) + "（应是 4 行边框）");
ok("banner 不超出终端列宽", Math.max(...bannerEdges) <= (process.stdout.columns || 80),
  "最宽 " + Math.max(...bannerEdges) + " 列");

section("⑤ markdown 渲染：代码块边框与表格列宽");
const md = renderMd([
  "```js",
  "// 中文注释：这一行里有全角标点，宽度是（）：：",
  "const x = " + "1".repeat(300),
  "```",
].join("\n"));
const mdEdges = edgesOf(md).filter((e) => e > 0);
ok("代码块含中文注释与超长行：右边界全等", allEqual(mdEdges),
  "各行列数 " + JSON.stringify(mdEdges) + "（错位 " + spread(mdEdges) + " 列）");
ok("超长代码行被截断而不是把边框推出去",
  bare(md).split("\n").every((l) => S.displayWidth(l) <= (process.stdout.columns || 80)),
  "最宽行 " + Math.max(...bare(md).split("\n").map(S.displayWidth)) + " 列");
const tbl = renderMd("| 名称 | 数量 |\n| ---- | ---- |\n| 技能 | 3 |\n| 规则 | 12 |");
const tblLines = bare(tbl).split("\n").filter((l) => l.trim());
const pipes = tblLines.map((l) => l.indexOf("|"));
ok("表格每行的列分隔符落在同一列", allEqual(tblLines.map((l) => S.displayWidth(l.slice(0, l.indexOf("|", 1))))),
  JSON.stringify(tblLines.map((l) => S.displayWidth(l.slice(0, l.indexOf("|", 1))))));
ok("表格分隔线长度与表头同宽",
  tblLines.length >= 2 && S.displayWidth(tblLines[1]) === S.displayWidth(tblLines[0]),
  "表头 " + S.displayWidth(tblLines[0]) + " 分隔线 " + (tblLines[1] ? S.displayWidth(tblLines[1]) : "无"));

section("⑥ 输入框整帧：不折行、边框等宽");
const frame = renderInputBox({
  value: "帮我改一下这个", mode: "prompt", slash: null, slashIdx: 0,
  status: { model: "agnes-3.0-flash", workspace: "pancode" },
});
const frameCols = process.stdout.columns || 80;
ok("输入框每一行都不超过终端列宽（超了就折行，回删行数从此全错）",
  bare(frame).split("\n").every((l) => S.displayWidth(l) <= frameCols),
  "最宽 " + Math.max(...bare(frame).split("\n").map(S.displayWidth)) + " / 可用 " + frameCols);
const frameLines = edgesOf(frame);
ok("输入框上下边框等宽", frameLines[0] === frameLines[2],
  "顶边第 " + frameLines[0] + " 列，底边第 " + frameLines[2] + " 列");
/* 斜杠菜单：描述列必须从同一列开始（cmd.padEnd 在带 ANSI 的串上算长度时永远补不齐） */
const DESCS = ["管理工具权限", "查看计划", "预览"];
const menuLines = bare(renderInputBox({
  value: "/pe", mode: "prompt",
  slash: [
    { cmd: "/permissions", desc: "管理工具权限" },
    { cmd: "/plan", desc: "查看计划" },
    { cmd: "/preview", desc: "预览" },
  ],
  slashIdx: 0, status: null,
})).split("\n");
const descStarts = DESCS.map((d) => {
  const l = menuLines.find((x) => x.indexOf(d) >= 0);
  return l == null ? -1 : S.displayWidth(l.slice(0, l.indexOf(d)));
});
ok("斜杠菜单三条描述都显形了（否则起始列判据是空测）", descStarts.every((v) => v >= 0), JSON.stringify(descStarts));
ok("斜杠菜单的描述列都从同一列开始", descStarts.every((v) => v === descStarts[0]),
  "各条起始列 " + JSON.stringify(descStarts));

section("⑦ 反向对照：源码里不能再出现按字符数截宽度预算的写法");
const cliDir = path.resolve(__dirname, "..", "cli");
const cliFiles = fs.readdirSync(cliDir).filter((f) => f.endsWith(".js"));
const charSliceUsers = [];
for (const f of cliFiles) {
  const src = fs.readFileSync(path.join(cliDir, f), "utf8");
  src.split("\n").forEach((l, i) => {
    if (/\.slice\(0,\s*[^)]*\bw\b/.test(l) && !/truncateCols/.test(l)) charSliceUsers.push(f + ":" + (i + 1));
  });
}
ok("没有按字符数截宽度预算里的中文（要走 truncateCols）", charSliceUsers.length === 0, charSliceUsers.join(" "));
/* 曾经这里还有一条"对上色结果用 padEnd"的形状判据，实测它会把 String(i+1).padStart(3)
   这种无害写法也抓进来（正则跨不过嵌套括号）。补位错位的真判据在 ⑥：
   描述列是不是从同一列开始——量字节，不猜形状。 */

section("⑧ 事件层：未登记事件不外泄，且读的是引擎真发的字段");
const { createRenderer } = require("../cli/render");
const evRender = createRenderer({});
const evOut = capture(() => {
  /* 载荷形状照 server 的 emit 点抄，不猜：
     plan = { title, tasks:[{text,status}] }；context.compact = { before, after, budget, keptFiles }；
     orch.step.done = { name, elapsed, changed[], conflicts }；tool.end = { id, ok, label } */
  evRender.handleEvent({ type: "plan.created", plan: { title: "拆分渲染层", tasks: [
    { text: "列宽口径统一", status: "done" }, { text: "事件白名单", status: "in_progress" }, { text: "帧模型", status: "pending" }] } });
  evRender.handleEvent({ type: "plan.updated", plan: { title: "拆分渲染层", tasks: [
    { text: "列宽口径统一", status: "done" }, { text: "事件白名单", status: "done" }, { text: "帧模型", status: "in_progress" }] } });
  evRender.handleEvent({ type: "orch.start", title: "并行改造", steps: [{ id: 1, name: "a" }, { id: 2, name: "b" }] });
  evRender.handleEvent({ type: "orch.step.start", stepId: 1, name: "a", layer: 0, parallel: true });
  evRender.handleEvent({ type: "orch.step.done", stepId: 1, name: "a", elapsed: 12.3, changed: ["x.js", "y.js", "z.js"], conflicts: 0 });
  evRender.handleEvent({ type: "orch.step.fail", stepId: 2, name: "b", elapsed: 3, error: "上游 500 超时" });
  evRender.handleEvent({ type: "orch.done", ok: false, elapsed: 15300, steps: [
    { id: 1, name: "a", status: "done" }, { id: 2, name: "b", status: "failed" }] });
  evRender.handleEvent({ type: "skill.created", name: "终端列宽口径", id: "sk1", level: "P2", findings: [1, 2] });
  evRender.handleEvent({ type: "session.memory.saved", count: 3, skill: "sk1" });
  evRender.handleEvent({ type: "patch.review", convId: "c1", files: [{ path: "a.js" }, { path: "b.js" }] });
  evRender.handleEvent({ type: "goal.set", goal: "把渲染层改成单一帧模型", convId: "c1" });
  evRender.handleEvent({ type: "editor.diff", path: "a.js", added: [1, 2, 3, 4] });
  evRender.handleEvent({ type: "term.cmd", tabId: "t1", text: "npm run test:verify" });
  evRender.handleEvent({ type: "term.exit", tabId: "t1" });
  evRender.handleEvent({ type: "context.usage", used: 41000, budget: 128000, est: false });
  evRender.handleEvent({ type: "context.compact", before: 96000, after: 52000, budget: 128000, keptFiles: 3, readsDropped: 0 });
  evRender.handleEvent({ type: "goal.settled", cleared: true, convId: "c1" });
  evRender.handleEvent({ type: "tool.start", id: "t9", name: "run_command", target: "npm test" });
  evRender.handleEvent({ type: "tool.end", id: "t9", ok: false, label: "已中断" });
  /* 真·未知事件：引擎以后再加任何一种，都不许出现在屏幕上 */
  evRender.handleEvent({ type: "zzz.future.event", whatever: 1 });
  evRender.handleEvent({ type: "another.unknown_thing" });
});
const evLines = bare(evOut).split("\n");
const leakedNames = evLines.filter((l) => /zzz\.future\.event|another\.unknown_thing|"type":|mcp\.tools_unlocked/.test(l));
ok("未登记事件不再把内部事件名印到界面", leakedNames.length === 0, leakedNames.join(" / "));
const anyEventName = evLines.filter((l) => /^\s*·\s*[a-z][a-z_.]+$/.test(l));
ok("没有残留 '· 事件名' 这种裸协议行", anyEventName.length === 0, anyEventName.join(" / "));
ok("plan 事件按真实载荷渲染进度（done/total）",
  evLines.some((l) => /拆分渲染层\s+1\/3/.test(l)) && evLines.some((l) => /2\/3/.test(l)),
  evLines.filter((l) => /拆分渲染层/.test(l)).join(" ⏎ "));
ok("in_progress 那一步被单独摊出来", evLines.some((l) => /事件白名单/.test(l) && l.indexOf("⎿") >= 0));
ok("压缩行报得出真实腾出量（原先读引擎没发的 ev.freed）",
  evLines.some((l) => /96k→52k（腾出 34%）/.test(l)), evLines.filter((l) => /上下文压缩/.test(l)).join(" ⏎ "));
ok("压缩带回已读文件时说得出数量", evLines.some((l) => /带回 3 个已读文件/.test(l)));
ok("按停止清除目标时不谎报成收口",
  evLines.some((l) => /目标已按停止清除/.test(l)) && !evLines.some((l) => /目标收口/.test(l)),
  evLines.filter((l) => /目标/.test(l)).join(" ⏎ "));
ok("编排步骤报得出耗时与归属文件数", evLines.some((l) => /12\.3s · 改 3 文件/.test(l)),
  evLines.filter((l) => /12\.3s/.test(l)).join(" ⏎ "));
ok("编排收口区分成败", evLines.some((l) => /1 步失败/.test(l)), evLines.filter((l) => /编排收口/.test(l)).join(" ⏎ "));
ok("工具失败给出原因而不是重印一遍标题",
  evLines.some((l) => /失败 · 已中断/.test(l)) && !evLines.some((l) => /● Bash npm test/.test(l)),
  evLines.filter((l) => /失败|Bash/.test(l)).join(" ⏎ "));
ok("水位被渲染层收下（供状态行常驻显示）",
  evRender.getStatus() && evRender.getStatus().used === 41000, JSON.stringify(evRender.getStatus()));
/* 只禁星平面 emoji（>=U+1F000）——和 displayWidth 的口径保持一致。
   ✦ ✎  这类刻意挑的 BMP 窄符号按 1 列算，把它们一起报红等于判据和自己的尺子打架。 */
const emoji = evLines.join("\n").match(/[\u{1F000}-\u{1FAFF}]/gu);
ok("事件渲染里不留 emoji（宽度与字体都随终端变）", !emoji, emoji ? [...new Set(emoji)].join("") : "");

section("⑨ 反向对照：白名单与真实字段口径不许倒退");
{
  const src = codeOf("cli/render.js");
  ok("default 分支不再打印事件名", !/out\(S\.dim\("  · " \+ ev\.type\)\)/.test(src),
    "仍能匹配到 out(\"  · \" + ev.type)");
  ok("渲染器不再引用引擎没发的 freed 字段", !/ev\.freed/.test(src));
  ok("context.usage 不再是空 case（要么显示要么进状态行）",
    /lastUsage\s*=\s*\{/.test(src), "没看到 lastUsage 赋值");
  ok("goal.settled 区分 cleared 分支", /ev\.cleared/.test(src));
}

section("⑩ 状态行：权限档常驻 + 上下文水位接得上真实事件");
const { statusLine } = require("../cli/inputbox");
const ask = bare(statusLine({ model: "agnes-3.0-flash", workspace: "pancode", perm: "ask" }));
ok("ask 档不刺眼（默认档不该一直报警）", !/⚠/.test(ask), ask);
["acceptEdits", "auto", "smart", "dontAsk"].forEach((p) => {
  const line = bare(statusLine({ model: "m", workspace: "w", perm: p }));
  ok("自动放行档 " + p + " 在状态行常驻并带警示", /⚠/.test(line) && line.indexOf(p) >= 0, line);
  const colored = statusLine({ model: "m", workspace: "w", perm: p });
  ok("危险档用的是错误色（不是靠文字自证）", colored.indexOf(ERR_OPEN + "⚠") >= 0,
    JSON.stringify(colored.slice(0, 30)));
});
const withCtx = bare(statusLine({ model: "m", workspace: "w", perm: "semi", ctx: { used: 41000, budget: 128000, est: false } }));
ok("水位算得出百分比", /32%/.test(withCtx), withCtx);
ok("进度条实心格数与百分比同口径", "▰".repeat(3) === withCtx.match(/▰+/)[0], withCtx);
const estCtx = bare(statusLine({ model: "m", workspace: "w", perm: "semi", ctx: { used: 41000, budget: 128000, est: true } }));
ok("估算口径的水位带 ≈ 记号（不带记号会被读成实测）", /≈32%/.test(estCtx), estCtx);
ok("没有 context.usage 时不硬画进度条",
  bare(statusLine({ model: "m", workspace: "w", perm: "ask" })).indexOf("▰") < 0);
/* 结构判据一律先剥注释：我在产品代码的注释里写了"原先读的是 ev.freed / engine.getContextUsage()"，
   不剥注释就是注释把判据点红——报的是"这句话存在"，不是"这个行为存在"。 */
function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function codeOf(p) {
  return stripComments(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));
}
const cliSrc = codeOf("cli/cli.js");
ok("cli.js 不再问引擎要那个不存在的方法", !/getContextUsage/.test(cliSrc), "仍能匹配到 getContextUsage");
ok("cli.js 的水位改从渲染器取", /renderer\.getStatus/.test(cliSrc));

section("⑪ AI 回复的续行归属（悬挂缩进）");
const mdRender = createRenderer({});
const mdOut = capture(() => {
  mdRender.handleEvent({ type: "msg.start", id: "m1" });
  mdRender.handleEvent({ type: "msg.delta", id: "m1", text:
    "你好！我是 Pancode 的工作助手。\n有什么我可以帮你的吗？比如：\n- 修改/新增某个功能\n- 排查某个报错\n- 跑一遍测试看结果\n直接告诉我想做什么就行。" });
  mdRender.handleEvent({ type: "msg.end", id: "m1" });
});
const mdRaw = bare(mdOut);
/* 屏幕上真正剩下的是什么，得按"擦除之后"算：流式期间 msg.delta 把原文直接写出去（顶格），
   msg.end 用 \x1b[NA + \r\x1b[J 把它整块擦掉再重画。取最后一个擦除之后的内容，
   才是用户眼睛看到的那一帧——不然这里量的是已经被擦掉的中间态。 */
const mdLines = mdRaw.split(/\r\x1b\[J/).pop().split("\n");
const body = mdLines.filter((l) => /工作助手|排查某个报错|跑一遍测试|直接告诉我/.test(l));
ok("首行挂 ⊂ 前缀", body.some((l) => l.trimStart().startsWith("⊂")), JSON.stringify(body[0]));
ok("续行不是顶到最左边（看得出这些话属于谁）",
  body.filter((l) => l.trim() && !l.trimStart().startsWith("⊂")).every((l) => /^ {2,}\S/.test(l)),
  body.filter((l) => l.trim() && !l.trimStart().startsWith("⊂")).map((l) => JSON.stringify(l.slice(0, 8))).join(" "));
ok("终帧里没有顶格裸写的流式残留（擦除重画真的生效）",
  !mdLines.some((l) => /^- /.test(l)), mdLines.filter((l) => /^- /.test(l)).join(" ⏎ "));
ok("空行不补尾随空格", !mdOut.split("\n").some((l) => l !== "" && bare(l).trim() === ""));
const wideRender = createRenderer({});
const wideOut = capture(() => {
  wideRender.handleEvent({ type: "msg.start", id: "m2" });
  wideRender.handleEvent({ type: "msg.delta", id: "m2", text:
    "看这段：\n\n```js\n// 中文注释占位\nconst a = 1;\n```\n\n---\n\n列表：\n1. 第一项\n2. 第二项" });
  wideRender.handleEvent({ type: "msg.end", id: "m2" });
});
const cols = process.stdout.columns || 80;
const wideLines = bare(wideOut).split(/\r\x1b\[J/).pop().split("\n");
ok("带代码块与分隔线的回复没有一行超出终端列宽（超了就折行，回删行数从此全错）",
  wideLines.every((l) => S.displayWidth(l) <= cols),
  "最宽 " + Math.max(...wideLines.map(S.displayWidth)) + " / 可用 " + cols);
const codeEdges = wideLines.filter((l) => l.trim().endsWith("┐") || l.trim().endsWith("│") || l.trim().endsWith("┘"))
  .map((l) => S.displayWidth(l.trimEnd()));
ok("代码块三边右边界全等（含 2 列前缀）", codeEdges.length > 0 && new Set(codeEdges).size === 1,
  JSON.stringify(codeEdges));

/* 顶层 await 会让 Node 把这份文件当 ES 模块重解析（require 当场失效），
   所以"真驱动输入框"这一段必须待在 async 函数里，跑完再收尾。 */
async function boxDrive() {
section("⑫ 改动列表按任务口径，不再靠渲染层自己压");
const chRender = createRenderer({});
const chOut = capture(() => {
  chRender.handleEvent({ type: "user.msg", text: "你好" });
  /* 引擎给的两种口径同时喂进去：list 是整棵脏树（46 项），task 是本轮真写的（1 项） */
  chRender.handleEvent({
    type: "changes",
    convId: "c1",
    list: Array.from({ length: 46 }, (_, i) => ({ path: "dirt/f" + i + ".js", add: 1, del: 1 })),
    task: { files: 1, add: 3, del: 1, entries: [{ path: "src/a.js", status: "M", add: 3, del: 1 }] },
  });
});
const chLines = bare(chOut).split("\n");
ok("屏幕上只出现本轮真写的文件", chLines.some((l) => /src\/a\.js/.test(l)) && !chLines.some((l) => /dirt\/f/.test(l)),
  chLines.filter((l) => /dirt\/f/.test(l)).slice(0, 2).join(" ⏎ "));
ok("该文件的增删行按任务口径报", chLines.some((l) => /\+3/.test(l) && /-1/.test(l)),
  chLines.filter((l) => /src\/a\.js/.test(l)).join(" ⏎ "));
const noTask = capture(() => {
  const r2 = createRenderer({});
  r2.handleEvent({ type: "changes", convId: "c1", list: [{ path: "dirt/x.js", add: 1, del: 0 }] });
});
ok("没有 task 时宁可什么都不列（不退回整棵脏树）", bare(noTask).indexOf("dirt/x.js") < 0, bare(noTask));

section("⑬ 配色：整体必须是亮青绿，且各语义色彼此可辨");
{
  const lum = (c) => (c[0] + c[1] + c[2]) / 3;
  const dist = (a, b) => Math.round(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2));
  const pri = S.P.openanlan.rgb;
  ok("主色是青绿（G、B 明显压过 R）", pri[1] > pri[0] + 60 && pri[2] > pri[0] + 40, "rgb(" + pri + ")");
  ["autoAccept", "suggestion", "promptBorder", "planMode", "remember", "bashBorder", "subtle", "text", "inactive"]
    .forEach((k) => {
      const c = S.P[k].rgb;
      ok("色板 " + k + " 留在青绿系（G ≥ R 且 B ≥ R）", c[1] >= c[0] && c[2] >= c[0], k + "=rgb(" + c + ")");
    });
  ok("成功色与主色可辨（两个都是绿的，糊在一起就分不出品牌色和成功色）",
    dist(S.P.success.rgb, pri) > 60, "距离 " + dist(S.P.success.rgb, pri));
  ok("错误色仍是红（危险提示不跟着换色系）",
    S.P.error.rgb[0] > S.P.error.rgb[1] + 80 && S.P.error.rgb[0] > S.P.error.rgb[2] + 80, "rgb(" + S.P.error.rgb + ")");
  ok("警告色与主色可辨", dist(S.P.warning.rgb, pri) > 90, "距离 " + dist(S.P.warning.rgb, pri));
  ok("diff 增删两色可辨", dist(S.P.diffAdded.rgb, S.P.diffRemoved.rgb) > 120,
    "距离 " + dist(S.P.diffAdded.rgb, S.P.diffRemoved.rgb));
  ok("正文在暗底上够亮", lum(S.P.text.rgb) > 200, "亮度均值 " + Math.round(lum(S.P.text.rgb)));
  ok("边框比正文暗至少 100（框线不会和字糊在一起）",
    lum(S.P.text.rgb) - lum(S.P.subtle.rgb) > 100, "差 " + Math.round(lum(S.P.text.rgb) - lum(S.P.subtle.rgb)));
}

/* 真驱动输入框 */
section("⑭ 输入框真驱动：假 TTY 喂按键，量它写出的字节");
{
  const { PassThrough } = require("stream");
  const { inputBox } = require("../cli/inputbox");
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));

  function fakeTTY() {
    const input = new PassThrough();
    input.isTTY = true;
    input.setRawMode = () => input;
    const output = new PassThrough();
    output.isTTY = true;
    output.columns = 80;
    output.rows = 24;
    return { input, output };
  }

  /* 把 process.stdin / process.stdout 换成假终端：inputBox 直接读这两个全局，
     不换掉就只能测它的纯函数，测不到"按键 → 字节"这一层。
     Node 24 的 process.stdin 是只有 getter 的属性，直接赋值会抛，得走 defineProperty。
     换的这段时间里探针自己一律用 realWrite 输出。 */
  const inDesc = Object.getOwnPropertyDescriptor(process, "stdin");
  const outDesc = Object.getOwnPropertyDescriptor(process, "stdout");
  const useTTY = (t) => {
    Object.defineProperty(process, "stdin", { value: t.input, configurable: true });
    Object.defineProperty(process, "stdout", { value: t.output, configurable: true });
  };
  const restoreTTY = () => {
    Object.defineProperty(process, "stdin", inDesc);
    Object.defineProperty(process, "stdout", outDesc);
  };
  async function drive(fn, boxOpts) {
    const t = fakeTTY();
    const chunks = [];
    t.output.on("data", (c) => chunks.push(Buffer.from(c)));
    useTTY(t);
    let bytes = "";
    try {
      const p = inputBox(Object.assign({ history: [], getStatus: () => ({ model: "m", workspace: "w", perm: "ask" }) }, boxOpts || {}));
      const settled = { done: false, val: null, err: null };
      p.then((v) => { settled.done = true; settled.val = v; }, (e) => { settled.done = true; settled.err = e.message; });
      await fn(t, settled, () => Buffer.concat(chunks).toString("utf8"));
      await tick(30);
      bytes = Buffer.concat(chunks).toString("utf8");
      return { bytes, settled, t };
    } finally {
      restoreTTY();
    }
  }

  /* 1) 打字 → 帧里出现内容 */
  const r1 = await drive(async (t) => { t.input.write("帮我改渲染层"); await tick(20); t.input.write("\r"); });
  ok("输入中文后帧里真的画出该内容", bare(r1.bytes).indexOf("帮我改渲染层") >= 0);
  ok("Enter 之后按输入内容 resolve", r1.settled.done && r1.settled.val === "帮我改渲染层",
    JSON.stringify(r1.settled));

  /* 2) 有内容时 Ctrl+C = 清空，不是退出：清空后再按 Enter，resolve 出来的是空串。
        旧行为是 ^C 直接 finish → 整个 REPL 主循环 break，程序结束。 */
  const r2 = await drive(async (t, s) => {
    t.input.write("写一半的话"); await tick(30);
    t.input.write("\x03"); await tick(30);
    ok("^C 之后程序还活着（promise 未 settle）", s.done === false, JSON.stringify(s));
    t.input.write("\r"); await tick(30);
  });
  ok("^C 清空生效：随后 Enter 交出的是空串", r2.settled.done && r2.settled.val === "",
    JSON.stringify(r2.settled));
  ok("^C 之后旧内容不再留在帧里", bare(r2.bytes).lastIndexOf("写一半的话") < bare(r2.bytes).lastIndexOf("❰"),
    "帧里最后一次出现该文本的位置对不上重画后的帧");
  /* 3) 空行时 Ctrl+C = 取消（reject aborted） */
  const r3 = await drive(async (t) => { t.input.write("\x03"); });
  ok("空行时按 ^C 才取消", r3.settled.done && r3.settled.err === "aborted", JSON.stringify(r3.settled));

  /* 4) resize 之后要重新擦并重画 */
  const r4 = await drive(async (t) => {
    t.input.write("拖窗口之前的文字"); await tick(20);
    t.output.columns = 40;
    t.output.emit("resize");
    await tick(30);
    t.input.write("\r");
  });
  ok("resize 触发后重新擦除并重画（有 \\x1b[J 且重画了新帧）",
    /\x1b\[J/.test(r4.bytes) && bare(r4.bytes).indexOf("拖窗口之前的文字") >= 0);

  /* 5) 输入超过一行宽度：光标定位要按物理行算 */
  const r5 = await drive(async (t) => {
    t.input.write("x".repeat(150)); await tick(20);
    t.input.write("\r");
  });
  const cursorMoves = [...r5.bytes.matchAll(/\x1b\[(\d+)A/g)].map((m) => Number(m[1]));
  ok("超宽输入的光标上移行数大于 0（说明按物理行折行算了，不是夹在列宽里）",
    Math.max(0, ...cursorMoves) >= 2, "上移序列 " + JSON.stringify(cursorMoves));

  /* ---------- ⑮ 输出仲裁层 ---------- */
  section("⑮ 输出仲裁层：屏幕上只有一块活动区（流式尾巴 + 输入框帧）");
  {
    const { createScreen } = require("../cli/screen");
    const calls = [];
    const mkFrame = () => ({
      erase: () => calls.push("erase"),
      draw: () => { calls.push("draw"); process.stdout.write("⟦帧⟧"); },
    });

    /* 1) 有帧时写一行 = 擦 → 写 → 画回去 */
    const sc1 = createScreen();
    sc1.setFrame(mkFrame());
    const b1 = capture(() => sc1.line("正文A"));
    ok("line() 先擦活动区、写完把帧画回去", calls.join(",") === "erase,draw", calls.join(","));
    ok("事件行落在帧之上（字节顺序：正文 → 帧）",
      b1.indexOf("正文A") >= 0 && b1.indexOf("⟦帧⟧") > b1.indexOf("正文A"), JSON.stringify(b1));

    /* 2) 反向对照：没有帧也没有流式尾巴时，一个字节的擦除都不该产生 */
    calls.length = 0;
    const sc2 = createScreen();
    const b2 = capture(() => sc2.line("裸写"));
    ok("无帧时不产生任何擦除/重画（--once 单次模式不受影响）",
      calls.length === 0 && /\x1b\[J/.test(b2) === false, calls.join(",") + " | " + JSON.stringify(b2));

    /* 3) 重入：擦除期间再写一行不再擦第二次，否则帧会被画歪 */
    calls.length = 0;
    const sc3 = createScreen();
    sc3.setFrame(mkFrame());
    capture(() => sc3.aboveFrame(() => { calls.push("inside"); sc3.line("内层行"); }));
    ok("aboveFrame 里再走 line() 不重复擦帧（可重入：整段只擦一次、只画一次）",
      calls.filter((c) => c === "erase").length === 1 && calls.filter((c) => c === "draw").length === 1 &&
      calls.join(",") === "erase,inside,draw", calls.join(","));

    /* 4) 流式尾巴：换新的一段时擦的是上一段，画完尾巴下面还是帧 */
    calls.length = 0;
    const sc4 = createScreen();
    sc4.setFrame(mkFrame());
    capture(() => sc4.setLive("第一稿"));
    const b4 = capture(() => sc4.setLive("第二稿"));
    ok("setLive 擦掉上一段再写新段（尾巴不会越长越花）",
      /\x1b\[1A\r\x1b\[J/.test(b4) && bare(b4).indexOf("第一稿") < 0 && bare(b4).indexOf("第二稿") >= 0,
      JSON.stringify(b4));
    ok("流式尾巴画在帧之上",
      bare(b4).indexOf("第二稿") < b4.indexOf("⟦帧⟧"), JSON.stringify(b4));
    const b5 = capture(() => sc4.setLive(""));
    ok("收掉尾巴时连它占的行一起擦（不留半截正文）",
      /\x1b\[1A\r\x1b\[J/.test(b5) && bare(b5).indexOf("第二稿") < 0 && bare(b5).indexOf("⟦帧⟧") >= 0,
      JSON.stringify(b5));

    /* 5) 屏幕上到底剩什么。逐段刷新在字节流里会留下一长串中间稿，
          只有按终端规则把光标走一遍，才量得出用户眼睛看见的是几行。
          管道 / --once 走的就是这条没有帧的路。 */
    const nfRender = createRenderer({});
    const nfOut = capture(() => {
      nfRender.resetRound();
      nfRender.handleEvent({ type: "msg.start", id: "mn" });
      ["好的，", "我来处理", "这个任务。"].forEach((seg) => {
        nfRender.handleEvent({ type: "msg.delta", id: "mn", text: seg });
      });
    });
    const nfScreen = screenModel(nfOut, process.stdout.columns || 80);
    const nfHits = nfScreen.filter((l) => l.indexOf("好的") >= 0);
    ok("无帧时逐段刷新后，屏幕上只剩最后一稿（不是一摞阶梯状残行）",
      nfHits.length === 1 && /好的，我来处理这个任务。/.test(nfHits[0]), JSON.stringify(nfScreen));
    const nfEnd = capture(() => nfRender.handleEvent({ type: "msg.end", id: "mn" }));
    const nfScreen2 = screenModel(nfOut + nfEnd, process.stdout.columns || 80);
    ok("msg.end 重排版之后，流式中间稿一行都不剩",
      nfScreen2.filter((l) => l.indexOf("好的") >= 0).length === 1,
      JSON.stringify(nfScreen2));
    ok("重排版后正文仍挂在 ⊂ 上（擦掉重来没把归属一起擦掉）",
      nfScreen2.some((l) => /^\s*⊂/.test(l)), JSON.stringify(nfScreen2.slice(0, 3)));
  }

  /* ---------- ⑯ 运行期输入框常驻 + 可见流式（真驱动） ---------- */
  section("⑯ 运行期：输入框常驻、正文逐段显形、状态行报运行态");
  {
    const { createScreen } = require("../cli/screen");
    const screen = createScreen();
    const renderer = createRenderer({ screen });
    /* 和 cli.js 的 REPL 完全同一套接线：状态行问渲染器要运行态和水位 */
    const boxStatus = () => ({
      model: "agnes-3.0-flash", workspace: "pancode", perm: "ask",
      ctx: renderer.getStatus(), state: renderer.getState(),
    });

    /* 提交之后 REPL 立刻再弹一个框（这一轮还在后台跑），所以"框还在不在"问的是第二个框 */
    let secondSettled = true;
    let aliveDuringRun = null;
    let tailFrame = null;
    let screenDuring = null;
    const r6 = await drive(async (t, settled, bytes) => {
      t.input.write("帮我改渲染层"); await tick(20);
      t.input.write("\r");
      await tick(20);
      const p2 = inputBox({ history: [], screen, getStatus: boxStatus });
      secondSettled = false;
      p2.then(() => { secondSettled = true; }, () => { secondSettled = true; });
      await tick(20);
      /* 引擎这一轮的四拍：开始跑 → 思考 → 两个流式增量 → 一条异步事件 */
      renderer.resetRound();
      renderer.handleEvent({ type: "user.msg", text: "帮我改渲染层" });
      renderer.handleEvent({ type: "agent.state", running: true, label: "AI 思考中", convId: "c" });
      await tick(160);                            /* 让 spinner 至少走一格 */
      aliveDuringRun = secondSettled === false;
      renderer.handleEvent({ type: "msg.start", id: "m9" });
      renderer.handleEvent({ type: "msg.delta", id: "m9", text: "先擦帧" });
      await tick(10);
      renderer.handleEvent({ type: "msg.delta", id: "m9", text: "再画回去" });
      renderer.handleEvent({ type: "term.line", text: "[Agent] 沉淀完成" });
      /* 必须在收口之前取：^C 关框会把帧擦掉，之后再量屏幕上就没有框了。
         tailFrame 问"最后一次擦除之后写了什么"，screenDuring 问"光标走完一遍之后屏幕上剩什么"。 */
      const nowBytes = bytes();
      tailFrame = bare(nowBytes).split(/\r\x1b\[J/).pop();
      screenDuring = screenModel(nowBytes, 80);
      /* 收口与关框都留在这段驱动里：drive 一返回就把 stdout 换回真流，
         那之后再动渲染器会把字节泼到探针自己的输出上。 */
      renderer.handleEvent({ type: "agent.state", running: false, labelKey: "aiIdle", convId: "c" });
      renderer.handleEvent({ type: "agent.done", convId: "c" });
      t.input.write("\x03"); await tick(20); t.input.write("\x03"); await tick(20);
    }, { screen, getStatus: boxStatus });

    ok("提交之后输入框没有被销毁（新一轮还在跑，框照旧在）", aliveDuringRun === true,
      "aliveDuringRun=" + JSON.stringify(aliveDuringRun));
    ok("异步事件落在框上方时，整帧被完整重画（框头/输入行/状态行/脚注都在）",
      ["⊂ pancode", "尝试输入问题", "❰", "shortcuts"].every((k) => tailFrame.indexOf(k) >= 0),
      JSON.stringify((tailFrame || "").slice(-160)));
    ok("最后一条事件行就写在帧之上",
      tailFrame.indexOf("[Agent] 沉淀完成") >= 0 && tailFrame.indexOf("[Agent] 沉淀完成") < tailFrame.indexOf("⊂ pancode"),
      JSON.stringify((tailFrame || "").slice(0, 120)));
    ok("运行态文案来自 agent.state（不是渲染器自己编的）",
      /AI 思考中/.test(tailFrame), JSON.stringify((tailFrame.match(/❰[^❱]*❱/) || [""])[0]));
    ok("有帧时正文与框共存（流式尾巴排在事件行之后、帧之前）",
      tailFrame.indexOf("先擦帧再画回去") > tailFrame.indexOf("[Agent] 沉淀完成") &&
      tailFrame.indexOf("先擦帧再画回去") < tailFrame.indexOf("⊂ pancode"),
      JSON.stringify((tailFrame || "").slice(0, 120)));
    ok("有帧时 spinner 不写裸行（不再往正文里插 \\x1b[K 那一格）",
      r6.bytes.indexOf("\x1b[K") < 0, "出现次数 " + (r6.bytes.match(/\x1b\[K/g) || []).length);
    ok("流式正文逐段显形（第一段的字确实到过屏幕）",
      bare(r6.bytes).indexOf("先擦帧") >= 0, bare(r6.bytes).slice(-60));
    /* 重画会不会把框叠出来、正文会不会留中间稿，只有还原到屏幕上看得出：
       字节流里每一帧、每一稿都留着底（前面那些判据量的都是"写到屏幕上"的东西）。 */
    const boxRows = screenDuring.map((l, i) => l.indexOf("⊂ pancode") >= 0 ? i : -1).filter((i) => i >= 0);
    const streamRows = screenDuring.map((l, i) => l.indexOf("先擦帧再画回去") >= 0 ? i : -1).filter((i) => i >= 0);
    const termRows = screenDuring.map((l, i) => l.indexOf("[Agent] 沉淀完成") >= 0 ? i : -1).filter((i) => i >= 0);
    ok("还原到屏幕：整块活动区只有一份框（逐段刷新不会把输入框叠成摞）",
      boxRows.length === 1, "框顶出现在第 " + JSON.stringify(boxRows) + " 行，共 " + screenDuring.length + " 行");
    ok("还原到屏幕：流式正文只剩最后一稿一份",
      streamRows.length === 1, "正文出现在第 " + JSON.stringify(streamRows) + " 行");
    ok("还原到屏幕：异步事件行也只有一份，且排在正文之上、框之下",
      termRows.length === 1 && termRows[0] < streamRows[0] && streamRows[0] < boxRows[0],
      "事件行 " + JSON.stringify(termRows) + " 正文 " + JSON.stringify(streamRows) + " 框顶 " + JSON.stringify(boxRows));

    /* 状态行按运行态显隐，空闲时不占位 */
    const busy = bare(statusLine({ model: "m", workspace: "w", perm: "ask",
      state: { running: true, text: "AI 思考中", glyph: "⠙" } }));
    ok("运行期状态行带动画格与阶段文案", /⠙ AI 思考中/.test(busy), busy);
    const idle = bare(statusLine({ model: "m", workspace: "w", perm: "ask",
      state: { running: false, text: "AI 空闲", glyph: "" } }));
    ok("空闲时状态行不挂「运行中」（否则一直在动反而看不出差别）",
      idle.indexOf("AI 空闲") < 0 && idle.indexOf("⠙") < 0, idle);
    const noState = bare(statusLine({ model: "m", workspace: "w", perm: "ask" }));
    ok("没有 state 时状态行照旧（老调用方不受影响）",
      noState.indexOf("❰") === 0 && noState.indexOf("⊂ m") >= 0 && noState.indexOf("运行") < 0, noState);

    /* 限流退避：文案与倒计时都从 agent.state / agent.backoff 的载荷来 */
    const rl = createRenderer({});
    capture(() => rl.handleEvent({
      type: "agent.state", running: true, labelKey: "rateLimitRetry",
      labelVars: { s: 5, a: 2, n: 3 }, convId: "c" }));
    const rlText = rl.getState().text;
    capture(() => rl.handleEvent({ type: "agent.state", running: false, labelKey: "aiIdle", convId: "c" }));
    ok("限流状态语把变量填进去了（不是原样的 {s}）",
      rlText === "被限流，等待 5s 后重试（2/3）", JSON.stringify(rlText));
    const bkOut = capture(() => {
      const bk = createRenderer({});
      bk.handleEvent({ type: "agent.backoff", waitSec: 5, attempt: 2, maxAttempts: 3 });
      bk.handleEvent({ type: "agent.backoff", waitSec: 0, done: true });
    });
    ok("退避行报得出剩余秒数与第几次", /等 5s · 第 2\/3 次/.test(bare(bkOut)), bare(bkOut));
    ok("done=true 只负责收浮层，不再多印一行假警告",
      bare(bkOut).split("被限流").length === 2, JSON.stringify(bare(bkOut)));
  }

  section("⑰ 反向对照：REPL 不许再把输入框扣到本轮结束");
  {
    /* 整段源码先剥注释再判形状（注释里提到"原先 await / setTimeout(800)"不该把自己判红），
       但切"REPL 区"要按原始文本找那道 main 分界。 */
    const rawCli = fs.readFileSync(path.join(__dirname, "..", "cli", "cli.js"), "utf8");
    const replSrc = stripComments(rawCli.split("/* ---------- main")[0]);
    ok("TTY 主循环不再 await 这一轮（引擎自己排队，框才能常驻）",
      !/await engine\.handleChat/.test(replSrc) && /if \(!process\.stdin\.isTTY\) await run;/.test(replSrc),
      "仍能匹配到 await engine.handleChat");
    ok("REPL 不再用 setTimeout 赌异步事件跑完", !/setTimeout\(r,\s*800\)/.test(replSrc));
    ok("REPL 把同一个 screen 交给渲染器和输入框",
      /createRenderer\(\{[\s\S]{0,140}screen,/.test(replSrc) && /inputBox\(\{[\s\S]{0,140}screen,/.test(replSrc));
    ok("^C 在运行期走中断而不是退出", /onInterrupt/.test(replSrc) && /isRunning/.test(replSrc));
    ok("审批/选择走 screen.exclusive（不再和输入框抢 stdin、抢屏幕）",
      /onApprove: \(ev\) => screen\.exclusive\(/.test(replSrc) && /onChoice: \(ev\) => screen\.exclusive\(/.test(replSrc));
    const rsrc = codeOf("cli/render.js");
    ok("agent.state 不再是空 case", !/case "agent\.state":\s*\{\s*break;/.test(rsrc));
    ok("msg.end 不再自己数行数往上擦（改由活动区收口）",
      rsrc.indexOf('"\\x1b[" + rows + "A"') < 0 && /screen\.setLive\(""\)/.test(rsrc));
    ok("流式尾巴交出去时带上 ⊂ 前缀（正文不会裸写）", /screen\.setLive\(S\.accent\(S\.MOON\)/.test(rsrc));
  }

  section("⑱ 运行期弹审批：屏幕与键盘整块让出去，问完收回来");
  {
    const { createScreen } = require("../cli/screen");
    const screen = createScreen();
    const renderer = createRenderer({ screen });
    const boxStatus = () => ({ model: "m", workspace: "w", perm: "ask", state: renderer.getState() });
    let during = null, after = null, hadFrameDuring = null, suspDuring = null;
    await drive(async (t, settled, bytes) => {
      t.input.write("打字打到一半"); await tick(20);
      let mark = 0;
      /* 引擎跑到审批：onApprove 用 screen.exclusive 把这一段时间整个让给 @inquirer */
      await screen.exclusive(async () => {
        mark = bytes().length;
        hadFrameDuring = screen.hasFrame();
        suspDuring = screen.isSuspended();
        process.stdout.write("是否批准执行？\n");        /* 模拟审批面板 */
        renderer.handleEvent({ type: "term.line", text: "[Agent] 沉淀中" });
        renderer.handleEvent({ type: "agent.state", running: true, label: "等你确认：Write src/a.js", convId: "c" });
        await tick(160);                                /* 让 spinner 至少想走一格 */
        /* 必须在 exclusive 返回之前取：它一返回帧就画回来了，那之后的字节不属于"弹窗期间" */
        during = bare(bytes().slice(mark));
      });
      renderer.handleEvent({ type: "term.line", text: "[Agent] 已批准" });
      after = bare(bytes().slice(mark));
      renderer.handleEvent({ type: "agent.state", running: false, labelKey: "aiIdle", convId: "c" });
      t.input.write("\x03"); await tick(20); t.input.write("\x03"); await tick(20);
    }, { screen, getStatus: boxStatus });

    ok("弹窗期间输入框整块让位（帧不在、isSuspended 为真）",
      hadFrameDuring === false && suspDuring === true,
      "hasFrame=" + hadFrameDuring + " suspended=" + suspDuring);
    ok("弹窗期间不重画输入框（留着帧的话 \\r\\x1b[J 会把四个选项一起擦没）",
      during.indexOf("⊂ pancode") < 0 && during.indexOf("是否批准执行") >= 0, JSON.stringify(during));
    ok("弹窗期间 spinner 一个字节都不写（\\r\\x1b[K 擦的会是 inquirer 那一行）",
      during.indexOf("\x1b[K") < 0, JSON.stringify(during));
    ok("引擎这段时间的事件行照样打出来", during.indexOf("[Agent] 沉淀中") >= 0, JSON.stringify(during));
    ok("问完输入框画回来、打字内容还在",
      after.indexOf("⊂ pancode") >= 0 && after.indexOf("打字打到一半") >= 0, JSON.stringify(after.slice(-140)));
    ok("exclusive 返回后 isSuspended 复位", screen.isSuspended() === false);
  }
}
}

function finish() {
  REAL_OUT.write("\n[cliui] 结果：" + pass + " 通过 / " + fail + " 失败\n");
  if (fail) fails.forEach((f) => REAL_OUT.write("  - " + f + "\n"));
  try { SANDBOX.cleanup(); } catch (e) {}
  process.exit(fail ? 1 : 0);
}

boxDrive().then(finish).catch((e) => {
  ok("⑭ 真驱动整段跑通", false, (e && e.stack ? String(e.stack).split("\n")[0] : String(e)));
  finish();
});
