/* ============================================================
   电脑控制工具族的端到端验收（desktop_* 全家 + 常驻 UIA worker）。

   靶子怎么选的（这条踩过一次真实的坑，别再犯）：
   · 记事本不能用。Win11 的 notepad.exe 是 stub，真窗口属另一个 pid；更糟的是它会**恢复用户上次的
     会话标签**，于是"按 pid 找不到自己起的窗口"，而万一按标题找到了，写进去的就是用户自己的文档。
   · 所以靶子是探针自己起的 WinForms 窗口：一个 PowerShell 进程 = 一个窗口 = 一个 pid，
     标题带本进程 pid 保证唯一，控件（Edit/Button/Text）在 UIA 里都规规矩矩可见。
   · 全程只对这个窗口动手，收尾自己关、自己兜底杀。

   覆盖三件读代码看不出来的事：
   1) 常驻 worker 起不起得来（PS 5.1 读无 BOM 的 UTF-8 脚本会按 936 代码页解析，
      中文注释能把整份脚本打成 ParserError —— 这条静默红过一轮）；
   2) 截图有没有拿到真实分辨率（不设 DPI 感知的进程量到的矩形是虚拟化的，点哪偏哪）；
   3) 中文进出 UIA 是不是原样（stdin 代码页 / base64 / ValuePattern 三处都能把字糊掉）。
   ============================================================ */
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const sb = require("./_sandbox").create({ tag: "computer", ws: false });

const worker = require("../server/computer/uia-worker");
const shots = require("../server/computer/shots");
const handlers = require("../server/tools/desktop-tools");

let pass = 0; let fail = 0; const fails = [];
function section(t) { console.log("\n\x1b[36m" + t + "\x1b[0m"); }
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name + (detail ? "  \x1b[90m" + detail + "\x1b[0m" : "")); }
  else { fail++; fails.push(name + (detail ? " —— " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? "  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkAgent(computerOverride) {
  const events = [];
  const gates = [];
  return {
    cfg: { computer: Object.assign({ desktop: true }, computerOverride || {}) },
    _currentConv: "compProbe",
    _convIdNow() { return this._currentConv; },   // 手搓 agent 需自带：tools 层已改走 agent._convIdNow() 取执行会话
    _gate: async (name, args, danger) => { gates.push({ name, danger }); return { blocked: false, approved: true }; },
    state() {},
    tool(kind, name, target) {
      const rec = { kind, name, target, body: "", label: "", ok: null, image: null };
      events.push(rec);
      return {
        body: (t) => { rec.body = String(t); },
        done: (o, label) => { rec.ok = o; rec.label = label; },
        image: (rel) => { rec.image = rel; },
        end() {}, start() {},
      };
    },
    events, gates,
  };
}

const pickRef = (text, kw) => (text.match(new RegExp(kw + "[^\\n]*?ref=(e\\d+)")) || [])[1];

/* 靶窗：Edit + Button + Text 三件套，初值全用中文。
   ⚠ 和真 worker 一样要"带 BOM 落盘 + -File 执行"：中文脚本走 `powershell -Command "<串>"`
   在非 UTF-8 代码页的机器上会被重新编码一次（第一版探针就是这么红的 —— 窗口根本没起来，
   而界面上一句原因都看不到）。落盘 + BOM 之后，脚本内容和 worker 收到的完全同源，
   顺手把 stderr 收到文件里，起不来时能直接看到原因。 */
const TITLE = "pancode靶窗-" + process.pid;
const TARGET_PS_TEXT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$f = New-Object System.Windows.Forms.Form",
  "$f.Text = '" + TITLE + "'",
  "$f.Width = 460",
  "$f.Height = 300",
  "$f.StartPosition = 'CenterScreen'",
  /* 单行 Edit + 多行 Document 都要有：实测 WinForms 的**多行** TextBox 在 UIA 里报 Document，
     只有 can=scroll、没有 ValuePattern —— 往它写值必然退回 SetFocus+SendInput（这条要测）；
     而"不抢焦点直接赋值"的 ValuePattern 路径只有**单行** Edit 支持（那条也要测）。 */
  "$one = New-Object System.Windows.Forms.TextBox",
  "$one.SetBounds(12,12,420,24)",
  "$one.Text = '单行：预览面板与涟漪'",
  "$tb = New-Object System.Windows.Forms.TextBox",
  "$tb.Multiline = $true",
  "$tb.SetBounds(12,44,420,88)",
  "$tb.Text = '多行初值'",
  "$btn = New-Object System.Windows.Forms.Button",
  "$btn.SetBounds(12,142,180,30)",
  "$btn.Text = '打个标记'",
  "$lbl = New-Object System.Windows.Forms.Label",
  "$lbl.SetBounds(210,146,200,24)",
  "$lbl.Text = '未点击'",
  "$btn.Add_Click({ $lbl.Text = '已点击' })",
  "$f.Controls.Add($one)",
  "$f.Controls.Add($tb)",
  "$f.Controls.Add($btn)",
  "$f.Controls.Add($lbl)",
  "$f.Show()",
  "[System.Windows.Forms.Application]::Run($f)",
].join("\n");
const TARGET_PS_FILE = path.join(sb.root, "target.ps1");
const TARGET_ERR_LOG = path.join(sb.root, "target-err.log");
fs.writeFileSync(TARGET_PS_FILE, "﻿" + TARGET_PS_TEXT, "utf8");

function findWindowLine(listText, pid) {
  return listText.split("\n").find((l) => {
    const m = l.match(/pid=(\d+)/);
    return m && Number(m[1]) === pid && /\[ref=(e\d+)\]/.test(l);
  }) || null;
}

(async () => {
  /* GitHub runner 上没有交互桌面会话：UIA 枚举不到真窗口、截图是一片黑，
     由此产生的红与产品无关。这里如实打 SKIP 后退出，不算"通过"——本地 verify:all 才跑全这条。 */
  if (process.env.CI) {
    console.log("SKIP：CI runner 无交互桌面，桌面控制栈不在 CI 上验收（本地 npm run verify:all 跑全）");
    sb.cleanup(); process.exit(0); return;
  }
  if (process.platform !== "win32") {
    console.log("SKIP：桌面控制只在 Windows 上可用，当前平台 " + process.platform);
    sb.cleanup(); process.exit(0); return;
  }

  const A = mkAgent();
  let target = null;

  section("① worker 冷启动与屏幕度量（DPI 感知）");
  let r = await worker.request("ping", {});
  ok("常驻 PowerShell worker 起得来", r.ok, r.error || "");
  ok("虚拟桌面量到了", r.ok && r.data.virtualScreen.w >= 800, r.data && r.data.virtualScreen.w + "×" + r.data.virtualScreen.h);
  const sc = await worker.request("screen", {});
  const pri = sc.ok && sc.data.screens.find((s) => s.primary);
  ok("主屏边界拿得到（多屏/缩放的坐标基准）", !!pri && pri.w >= 800, pri && pri.w + "×" + pri.h);

  r = await handlers.desktop_screenshot(A, { name: "整屏" });
  const card = A.events[A.events.length - 1];
  ok("整屏截图成功且回执说明模型不看像素", /只有用户能看见/.test(r) && !!card.image, card.image || r.slice(0, 80));
  const abs = card.image && path.join(shots.root(), card.image);
  const png = abs && fs.existsSync(abs) ? fs.statSync(abs) : null;
  ok("截图真的落盘且不是空文件", !!png && png.size > 20000, png ? Math.round(png.size / 1024) + "KB" : "(没落成)");
  const probe = await worker.request("shot", { path: path.join(sb.root, "dpi-check.png") });
  ok("GDI 截图尺寸 == 系统虚拟桌面尺寸（DPI 感知设上了，坐标不会点偏）",
    probe.ok && probe.data.w === sc.data.virtualW && probe.data.h === sc.data.virtualH,
    probe.ok ? probe.data.w + "×" + probe.data.h + " vs " + sc.data.virtualW + "×" + sc.data.virtualH : probe.error);

  section("② 窗口枚举格式");
  r = await handlers.desktop_windows(A, {});
  ok("每行都是 [ref=eN] + 标题 + 控件类型 + pid + 矩形（与控件树同一个形状）",
    /桌面窗口 \d+ 个/.test(r) && /\[ref=e\d+\].*· pid=\d+ · .*×/.test(r), (r.split("\n")[1] || "").slice(0, 100));

  section("③ 起探针自己的靶窗（绝不拿用户手上的窗口当测试对象）");
  /* ⚠ 不能用 windowsHide:true：它写的是 STARTUPINFO.wShowWindow=SW_HIDE，
     而 WinForms 首次显示走 SW_SHOWDEFAULT，会照着这个旗标把窗**建 Hidden**。
     窗口其实建出来了、进程也在泵消息，但 UIA 的根子项只收可见顶层窗口 —— 于是列表里怎么都找不到它。
     想不弹控制台就传 -WindowStyle Hidden（它只 ShowWindow(GetConsoleWindow(), SW_HIDE)，不碰子窗）。 */
  const errFd = fs.openSync(TARGET_ERR_LOG, "w");
  const tk = spawn("powershell.exe", ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", TARGET_PS_FILE],
    { stdio: ["ignore", "ignore", errFd] });
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(400);
    const rr = await handlers.desktop_windows(A, {});
    const line = findWindowLine(rr, tk.pid);
    if (line) target = { ref: (line.match(/\[ref=(e\d+)\]/) || [])[1], line };
  }
  const whyNot = target ? "" : ("靶窗没起来，stderr: " + (fs.readFileSync(TARGET_ERR_LOG, "utf8").slice(-260) || "(空)")
    + "；已排除 windowsHide 把窗建成 Hidden 的情况");
  ok("按 pid 认出靶窗（不是按标题猜，桌面上可能正好有同名窗口）", !!target && !!target.ref,
    target ? target.line.slice(0, 110) : whyNot);

  if (target) {
    section("④ 读控件树");
    /* 窗口刚能被枚举到的那一两秒里，WinForms 的 Button 在 UIA 里还报成 Pane（连 can=invoke 都没有），
       实测机器忙（前面刚跑过截图）时要 1~3s 才落成 Button。靶窗存在≠控件树已稳定，
       所以先有界地等它落定再断言 —— 断言的内容一个字没减（四种控件仍必须齐全）。 */
    let tree = await handlers.desktop_snapshot(A, { window_ref: target.ref, max_depth: 8, max_nodes: 120 });
    for (let i = 0; i < 12 && !/Button "打个标记/.test(tree); i++) {
      await sleep(500);
      tree = await handlers.desktop_snapshot(A, { window_ref: target.ref, max_depth: 8, max_nodes: 120 });
    }
    r = tree;
    ok("控件树读出来了", /控件树 \d+ 个/.test(r), (r.match(/控件树 (\d+) 个/) || [])[1] + " 个控件");
    const editRef = pickRef(r, 'Edit "单行');
    const docRef = pickRef(r, "Document");
    const btnRef = pickRef(r, 'Button "打个标记"');
    const lblRef = pickRef(r, 'Text "未点击"');
    ok("读到四种控件：单行 Edit / 多行 Document / Button / Text",
      !!editRef && !!docRef && !!btnRef && !!lblRef, [editRef, docRef, btnRef, lblRef].join(" "));
    ok("每行带 can= 能力提示，模型据此决定用哪种动作", /can=/.test(r),
      (r.split("\n").find((l) => /Button "打个标记/.test(l)) || "").slice(0, 110));
    /* 这条是设计的地基：多行框在 UIA 里是 Document 且没有 value 能力，
       所以往它写值必然要退回按键 + 抢焦点。断言的不是"我们想这样"，而是"Windows 就是这样"。 */
    ok("多行 TextBox 报 Document、没有 value 能力（这就是它必须退回按键输入的原因）",
      /Document[^\n]*can=/.test(r) && !/Document[^\n]*value/.test(r),
      (r.split("\n").find((l) => /Document/.test(l)) || "").slice(0, 110));

    section("⑤ 中文往返：单行走 ValuePattern，多行退回 SendInput");
    r = await handlers.desktop_read(A, { ref: editRef });
    ok("读到单行框里的中文初值（没被代码页糊掉）", /单行：预览面板与涟漪/.test(r), JSON.stringify(r.slice(0, 40)));
    const NEW = "改过之后：中文①②③ 与全角标点";
    r = await handlers.desktop_type(A, { ref: editRef, text: NEW });
    ok("单行框走 ValuePattern（不抢焦点、不动鼠标）", /ValuePattern/.test(r) && /没抢焦点/.test(r), r.slice(0, 110));
    const back = await handlers.desktop_read(A, { ref: editRef });
    ok("回读与写入逐字一致（base64 传参 + UTF-8 全链路没糊）", back === NEW, JSON.stringify(back.slice(0, 60)));
    r = await handlers.desktop_type(A, { ref: docRef, text: "多行里追加中文" });
    ok("没有 value 能力的多行框自动退回 SendInput 并说明要焦点", /SendInput/.test(r) && /拿到焦点/.test(r), r.slice(0, 120));
    /* SendInput 打给"当前前台窗口"。靶窗建好不等于在前台——跑在这条探针前面的
       浏览器/桌面探针、或用户自己在点的程序，都会在这一秒把前台抢走，于是按键落到别处，
       多行框里剩的是初值。这不是产品缺陷，是探针自己制造的随机红（随机红也是红）：
       先把靶窗带到前台并确认它真的拿到了前台，再按；没抢到就再要一次。 */
    let dback = await handlers.desktop_read(A, { ref: docRef });
    for (let tryN = 0; tryN < 3 && !/多行里追加中文/.test(dback); tryN++) {
      const act = await handlers.desktop_window(A, { window_ref: target.ref, action: "activate" });
      await sleep(500);
      const wf = await handlers.desktop_windows(A, {});
      const line = findWindowLine(wf, tk.pid) || "";
      ok("第 " + (tryN + 1) + " 次补焦点：靶窗已在前台", /当前前台/.test(line), line.slice(0, 120) || act.slice(0, 60));
      await handlers.desktop_type(A, { ref: docRef, text: "多行里追加中文" });
      dback = await handlers.desktop_read(A, { ref: docRef });
    }
    ok("多行框里真的写进了中文", /多行里追加中文/.test(dback), JSON.stringify(dback.slice(0, 40)));

    section("⑥ 点按钮：走 InvokePattern，真的触发了控件逻辑");
    r = await handlers.desktop_click(A, { ref: btnRef });
    ok("点击走的是控件模式而非坐标", /InvokePattern/.test(r), r.slice(0, 110));
    ok("回执明确说了没动鼠标", /没动鼠标/.test(r), r.slice(0, 90));
    const lbl = await handlers.desktop_read(A, { ref: lblRef });
    ok("标签真的从「未点击」变成「已点击」（证明动作落到控件上）", /已点击/.test(lbl), JSON.stringify(lbl.slice(0, 30)));

    section("⑦ 单窗口截图：区域取自控件矩形");
    const before = A.events.length;
    r = await handlers.desktop_screenshot(A, { window_ref: target.ref, name: "靶窗" });
    const c2 = A.events[before];
    ok("单窗口截图成功", /已截图/.test(r) && !!c2.image, c2.image || r.slice(0, 90));
    ok("截图落在会话目录而不是工作区", !!c2.image && c2.image.indexOf("compProbe/") === 0, c2.image || "");
    ok("/api/shot 能解析这个相对路径", !!shots.resolveRel(c2.image), c2.image || "");

    section("⑧ 错误与边界：全部是散文回执，不抛异常");
    r = await handlers.desktop_read(A, { ref: "e99999" });
    ok("不存在的 ref 回的是可执行建议（教模型去重新快照）", /失败/.test(r) && /desktop_snapshot/.test(r), r.slice(0, 130));
    r = await handlers.desktop_snapshot(A, {});
    ok("没给目标时说明要 window_ref 或 title", /失败/.test(r) && /window_ref|title/.test(r), r.slice(0, 120));
    r = await handlers.desktop_snapshot(A, { title: "这个标题世界上不存在" });
    ok("标题匹配不到时如实说找不到，不返回空树糊弄", /找不到/.test(r), r.slice(0, 120));
    r = await handlers.desktop_type(A, { ref: editRef, text: "" });
    ok("空文本直接拒，不发任何按键", /需要 text/.test(r), r.slice(0, 60));
    r = await handlers.desktop_type(A, { ref: editRef, text: "x".repeat(2500) });
    ok("超长文本在工具层就拦下（不制造按键风暴）", /最多 2000/.test(r), r.slice(0, 70));
    r = await handlers.desktop_window(A, { ref: target.ref, action: "teleport" });
    ok("非法窗口动作列出可用动作", /不支持的动作|失败/.test(r), r.slice(0, 120));
    r = await handlers.desktop_click(A, { ref: "e1; Get-Process" });
    ok("带分号的脏 ref 被参数校验挡下（没拼进命令）", /参数不对/.test(r), r.slice(0, 110));

    section("⑨ 审批门：动桌面的每一步都要过闸");
    const names = A.gates.map((g) => g.name);
    ok("click / type 各自请求过授权", names.includes("desktop_click") && names.includes("desktop_type"), names.join(","));
    r = await handlers.desktop_click(A, { x: 5, y: 5 });
    ok("坐标点击单独标 danger=high（它会搬走用户真实光标）",
      A.gates.filter((g) => g.name === "desktop_click").some((g) => g.danger === "high"),
      A.gates.filter((g) => g.name === "desktop_click").map((g) => g.danger).join("/"));
    ok("坐标点击的回执警告了会移动真实光标", /移动.*真实光标/.test(r), r.slice(0, 110));
    const rejected = { ...A, _gate: async () => ({ blocked: false, approved: false }) };
    ok("用户拒绝时一个字都不发", /拒绝了这次输入/.test(await handlers.desktop_type(rejected, { ref: editRef, text: "不该出现" })));
    ok("用户拒绝点击时不执行", /拒绝了这次桌面点击/.test(await handlers.desktop_click(rejected, { ref: btnRef })));
    const blocked = { ...A, _gate: async () => ({ blocked: true, reason: "命中拒绝规则" }) };
    ok("拒绝规则拦下时不执行窗口操作", /被拒绝规则拦截/.test(await handlers.desktop_window(blocked, { ref: target.ref, action: "close" })));

    section("⑩ 总开关与降级");
    const OFF = mkAgent({ desktop: false });
    r = await handlers.desktop_windows(OFF, {});
    ok("computer.desktop=false 时把原因回给模型", /已关闭/.test(r), r.slice(0, 100));
    ok("关闭时只建一张卡并标成未启用", OFF.events.length === 1 && OFF.events[0].ok === false && OFF.events[0].label === "未启用",
      JSON.stringify(OFF.events.map((e) => e.label)));
    const st = worker.status();
    ok("脚本落盘副本存在（asar 里 powershell 读不到，必须落盘）", !!st.script && fs.existsSync(st.script), st.script || "");
    ok("落盘副本带 UTF-8 BOM（不带就会被 PS 5.1 按 936 代码页打成 ParserError）",
      (() => { try { return fs.readFileSync(st.script)[0] === 0xEF; } catch (e) { return false; } })());

    section("⑪ 收尾：WM_CLOSE 关掉自己起的靶窗");
    r = await handlers.desktop_window(A, { ref: target.ref, action: "close" });
    ok("发出关闭请求", /已请求关闭窗口/.test(r), r.slice(0, 100));
    await sleep(1500);
    const chk = await handlers.desktop_windows(A, {});
    ok("列表里不再有那个靶窗", !findWindowLine(chk, tk.pid), "pid=" + tk.pid);
  } else {
    ok("控件树读出来了", false, "靶窗没起来，④—⑪ 整段跳过");
  }

  /* 兜底：探针自己起的进程自己收干净，不管前面走到哪一步 */
  try { process.kill(tk.pid); } catch (e) { /* 已经自己退了 */ }

  section("⑫ worker 停止后能再拉起");
  worker.stop("探针收尾");
  await sleep(600);
  r = await worker.request("ping", {});
  ok("stop 之后下一次请求会重新起进程", r.ok, r.error || "");
  worker.stop("探针结束");

  console.log("\n\x1b[1m电脑控制验收：\x1b[0m " + pass + " 通过 / " + fail + " 失败");
  if (fails.length) console.log("\x1b[31m失败项：\x1b[0m\n  - " + fails.join("\n  - "));
  await sleep(300);
  sb.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\x1b[31m探针异常：\x1b[0m" + e.stack);
  worker.stop("异常收尾");
  sb.cleanup();
  process.exit(1);
});
