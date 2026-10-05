/* ============================================================
   界面验收探针（#33 #34 #35 #36 —— 用户 2026-10-05 提的 7 条里的 UI 四项）

   盯的都是"读代码看不出来"的那类问题，必须真渲染才算数：
     · #35 顶部项目切换下拉打开是一块透明的——根因是 background 读了从未定义的
       var(--bg-elev)，CSS 遇到未定义 var() 会静默丢掉整条声明，不报错也不降级。
       所以这里断言的是**计算后的实际底色**，不是源码里写了什么。
     · #33 上下文水位在环形进度、悬停提示、环境面板、压缩卡上一律只许给百分比。
     · #34 输入框那圈流动光：空闲/聚焦/运行三态的 opacity 与转速必须真的不同
       （::after 的动画只有 computed style 能看到，肉眼在静态截图上看不出来）。
     · #36 会话头图标：旧的渐变底 + 白 P 方块换成描边轨道标记，
       断言它没有背景色块、且运行态真的在转。
   另加一条浅色配色回归：换到 celadon/light 后下拉仍必须是不透明的。
   ⑧ 是本轮补的：全量首屏快照改走批量基线（planner）之后，界面这一侧的回归——
   2.4MB 文件 + 两个窗口并发连，首屏要出得来、已打开的窗口不能跟着冻。
   （实测踩到的边界：>1MB 的文本被 FileStore 直接挡在索引外，所以这里用的是 900KB。）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const sb = require("./_sandbox").create({
  tag: "uitaste",
  config: {
    agentMode: "auto",
    llm: { baseURL: "", apiKey: "", model: "sandbox-model", contextWindow: 128000 },
    context: { budgetTokens: 1000000, autoCompact: true },
    permissions: { mode: "auto", allow: [], deny: [] },
  },
});

const { chromium } = require("playwright");
const PORT = Number(process.env.PORT || 8836);
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

const REPO = path.resolve(__dirname, "..");
const child = spawn(process.execPath, ["server/index.js"], {
  cwd: REPO,
  env: sb.env({ PORT: String(PORT), AGENT_FAST: "1", CURSORWEB_ENGINE: "demo", NODE_NO_WARNINGS: "1" }),
  stdio: ["ignore", "pipe", "pipe"],
});
let childLog = "";
child.stdout.on("data", (d) => { childLog += d; });
child.stderr.on("data", (d) => { childLog += d; });

async function waitServer(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* 解析 rgb()/rgba() 串：透明（alpha=0）就是"这块底色等于没写" */
function parseColor(c) {
  const m = String(c || "").match(/rgba?\(([^)]+)\)/);
  if (!m) return { r: -1, g: -1, b: -1, a: 1 };
  const p = m[1].split(",").map((x) => parseFloat(x));
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
function lum(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }

(async () => {
  if (!await waitServer(20000)) {
    console.log(childLog.slice(-2000));
    throw new Error("服务端没起来（端口 " + PORT + "）");
  }

  /* 登录弹窗会吃掉所有点击（实测：#btnOpenFolder 明明可见可点，却被 #authModal 拦死）。
     与 verify-ui.js 同一手法：先在沙箱数据根里注册一个一次性账号，把 token 预置进
     localStorage，页面起来就已是登录态。账号留着也无害——数据根本来就是临时目录。 */
  const base = `http://127.0.0.1:${PORT}`;
  const user = "uitaste_" + Date.now();
  const authOpts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: "test1234" }) };
  await fetch(base + "/api/auth/register", authOpts).catch(() => {});
  const token = await fetch(base + "/api/auth/login", authOpts).then((r) => r.json()).then((j) => j.token || "").catch(() => "");

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  if (token) await page.addInitScript((t) => {
    /* init script 会在每个 frame 里跑一遍，应用里的 srcdoc/沙箱 iframe 读 localStorage
       会直接抛 SecurityError——那是探针自己的副作用，不是产品报错，别把它算进断言。 */
    try {
      localStorage.setItem("cw-user-token", t);
      // 新手引导弹窗同样会吃掉全部点击（实测第二道拦路的就是 #onboardModal）
      localStorage.setItem("cw-onboarded", "1");
    } catch (e) {}
  }, token);

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => !!document.getElementById("chatInputBox"), { timeout: 20000 });
  await page.waitForTimeout(1200);

  /* ---------------- ① #35 顶部项目切换下拉 ---------------- */
  section("① 顶部项目切换下拉：打开必须是不透明的一块面板");
  await page.click("#btnOpenFolder");
  await page.waitForTimeout(400);
  const dd = await page.evaluate(() => {
    const el = document.getElementById("wsDropdown");
    if (!el) return null;
    const cs = getComputedStyle(el);
    const item = el.querySelector(".ws-item");
    return {
      bg: cs.backgroundColor, borderColor: cs.borderTopColor, z: cs.zIndex,
      boxShadow: cs.boxShadow.slice(0, 40),
      itemFg: item ? getComputedStyle(item).color : "",
      count: el.querySelectorAll(".ws-item").length,
    };
  });
  ok("下拉真的打开了且有内容", !!dd && dd.count >= 1, JSON.stringify(dd));
  const ddBg = parseColor(dd && dd.bg);
  ok("底色不是透明的（旧写法读了未定义的 --bg-elev，整条 background 被静默丢掉）",
    dd && ddBg.a > 0.9, dd && dd.bg);
  ok("底色与文字色有对比（不是同色糊成一片）",
    dd && Math.abs(lum(ddBg) - lum(parseColor(dd.itemFg))) > 60,
    dd && JSON.stringify({ bg: dd.bg, fg: dd.itemFg }));
  ok("层级走 token（不再手写 99999）", dd && dd.z === "480", dd && dd.z);
  await page.screenshot({ path: path.join(OUT, "uitaste-dropdown.png") });

  section("①-b 换到浅色配色后仍然是不透明的");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.palette = "celadon";
  });
  await page.waitForTimeout(250);
  const ddLight = await page.evaluate(() => {
    const el = document.getElementById("wsDropdown");
    return el ? { bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el.querySelector(".ws-item")).color } : null;
  });
  const lb = parseColor(ddLight && ddLight.bg);
  ok("浅色下拉底色仍不透明", ddLight && lb.a > 0.9, ddLight && ddLight.bg);
  ok("浅色下文字与底色仍有对比", ddLight && Math.abs(lum(lb) - lum(parseColor(ddLight.fg))) > 60,
    ddLight && JSON.stringify(ddLight));
  await page.screenshot({ path: path.join(OUT, "uitaste-dropdown-light.png") });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.palette = "graphite";
    const m = document.getElementById("wsDropdown"); if (m) m.remove();
  });
  await page.waitForTimeout(200);

  /* ---------------- ② #33 水位只给百分比 ---------------- */
  section("② 上下文水位：环形、悬停、环境面板、压缩卡都只许给百分比");
  const ctx = await page.evaluate(() => {
    window.updateCtxBar(96000, 102400, false);
    const pct = document.getElementById("ctxPct");
    const env = document.getElementById("envCtxTxt");
    return {
      pct: pct ? pct.textContent : "",
      title: (document.querySelector("#ctxBarWrap") || {}).title || "",
      env: env ? env.textContent : "",
      offset: (document.querySelector(".ctx-fg") || {}).style ? document.querySelector(".ctx-fg").style.strokeDashoffset : "",
    };
  });
  ok("环形显示带百分号（旧写法写的是裸数字，单位丢了）", /^\d+%$/.test(ctx.pct), ctx.pct);
  ok("环形数字就是百分比本身", ctx.pct === "94%", ctx.pct);
  ok("悬停提示里没有 96,000 / 102,400 这种具体数值",
    !/\d{1,3}(,\d{3})+/.test(ctx.title) && !/\d{4,}\s*\/\s*\d{4,}/.test(ctx.title), ctx.title);
  ok("环境面板也只给百分比", /^\d+%$/.test(ctx.env), ctx.env);
  ok("环形进度跟着百分比真的动了（94% 时描边偏移≈2.9）",
    ctx.offset && Math.abs(parseFloat(ctx.offset) - 47.752 * 0.06) < 0.5, ctx.offset);

  const card = await page.evaluate(() => {
    window.renderCompactCard({
      before: 96000, after: 24000, budget: 102400, dropped: 12, keptCritical: 5, keptRecent: 8,
      summary: "【任务目标】无\n【已定决策】无", forced: true,
    });
    const el = document.querySelector(".compact-card");
    return el ? { text: el.innerText.replace(/\s+/g, " "), stat: el.querySelector(".cc-stat").innerText, badge: el.querySelector(".cc-badge").innerText } : null;
  });
  ok("压缩卡出现且给的是水位百分比", !!card && /→/.test(card.stat) && (card.stat.match(/%/g) || []).length === 2,
    card && card.stat);
  ok("压缩卡不含整块 token 数值（96000/24000 这种）",
    !!card && !/\b\d{4,}\b/.test(card.text.replace(/%/g, "")), card && card.text.slice(0, 120));
  ok("压缩卡不再报「丢弃 N 条 / 保留 N 条」的具体数量",
    !!card && !/(丢弃|保留)\s*\d+\s*条/.test(card.text), card && card.text.slice(0, 160));
  ok("压缩卡徽章给的是腾出的百分比", !!card && /%\s*空间/.test(card.badge), card && card.badge);
  await page.screenshot({ path: path.join(OUT, "uitaste-compact.png") });

  /* ---------------- ③ #34 输入框能量边框 ---------------- */
  section("③ 输入框边框：三态（空闲 / 聚焦 / 运行）的动效参数必须真的不同");
  const anim = await page.evaluate(async () => {
    const el = document.getElementById("chatInputBox");
    const read = () => {
      const cs = getComputedStyle(el, "::after");
      return { name: cs.animationName, dur: cs.animationDuration, opacity: parseFloat(cs.opacity || "0"), mask: cs.webkitMaskImage ? "yes" : (cs.maskComposite || cs.webkitMaskComposite) };
    };
    // opacity 是 transition 过来的（--dur-normal=.25s），同步读只会读到过渡起点
    const settle = () => new Promise((r) => setTimeout(r, 450));
    el.classList.remove("busy", "focused");
    await settle();
    const idle = read();
    el.classList.add("focused");
    await settle();
    const focused = read();
    el.classList.add("busy");
    await settle();
    const busy = read();
    el.classList.remove("focused", "busy");
    return { idle, focused, busy };
  });
  ok("有一圈 ::after 在跑 pcSpin 动画", anim.busy.name === "pcSpin", JSON.stringify(anim.busy));
  ok("空闲时几乎看不见（opacity 0）", anim.idle.opacity === 0, JSON.stringify(anim.idle));
  ok("聚焦时显形并提速", anim.focused.opacity > 0.3 && anim.focused.dur !== anim.idle.dur,
    JSON.stringify({ idle: anim.idle.dur, focused: anim.focused }));
  ok("运行时最亮且转得最快", anim.busy.opacity > anim.focused.opacity &&
    parseFloat(anim.busy.dur) < parseFloat(anim.focused.dur),
    JSON.stringify({ focusedDur: anim.focused.dur, busy: anim.busy }));
  ok("只描边框一圈（中心被 mask 挖掉，不会糊住输入区）",
    /exclude|xor/.test(String(anim.busy.mask)) || anim.busy.mask === "yes", JSON.stringify(anim.busy.mask));

  /* ---------------- ④ #36 会话头图标 ---------------- */
  section("④ 会话头图标：没有渐变底色方块，运行态轨道真的在转");
  const av = await page.evaluate(() => {
    const box = document.querySelector(".ag-avatar");
    if (!box) return null;
    const cs = getComputedStyle(box);
    const svg = box.querySelector("svg");
    const orbits = box.querySelectorAll(".ag-orbit ellipse");
    const core = box.querySelector(".ag-core");
    const node = box.querySelector(".ag-node");
    const readOrbit = () => {
      const g = box.querySelector(".ag-orbit");
      const c = getComputedStyle(g);
      return { name: c.animationName, dur: c.animationDuration, op: parseFloat(c.opacity) };
    };
    const idleOrbit = readOrbit();
    box.classList.add("busy");
    const busyOrbit = readOrbit();
    const busyCore = getComputedStyle(core).animationName;
    box.classList.remove("busy");
    return {
      bg: cs.backgroundColor, bgImg: cs.backgroundImage, shadow: cs.boxShadow, radius: cs.borderRadius,
      glyphColor: cs.color, shapes: { ellipses: orbits.length, core: !!core, node: !!node },
      hasLetter: /P/.test(svg ? svg.textContent : ""),
      idleOrbit, busyOrbit, busyCore,
      // 旧写法留着的 ::after 高光层（自创装饰，本次一并去掉）
      afterBg: getComputedStyle(box, "::after").backgroundImage,
    };
  });
  ok("头像不再是带底色的方块（背景透明、无渐变、无投影）",
    !!av && parseColor(av.bg).a === 0 && av.bgImg === "none" && av.shadow === "none",
    av && JSON.stringify({ bg: av.bg, bgImg: av.bgImg, shadow: av.shadow }));
  ok("不再有一层白高光盖在上面", !!av && (av.afterBg === "none" || !av.afterBg), av && av.afterBg);
  ok("是描边 SVG：两条轨道 + 核心 + 信号点", !!av && av.shapes.ellipses === 2 && av.shapes.core && av.shapes.node,
    av && JSON.stringify(av.shapes));
  ok("图形里没有字母 P", !!av && av.hasLetter === false, av && String(av.hasLetter));
  ok("空闲时轨道静止", !!av && av.idleOrbit.name === "none", av && JSON.stringify(av.idleOrbit));
  ok("运行态轨道转起来（agentRotate）", !!av && av.busyOrbit.name === "agentRotate", av && JSON.stringify(av.busyOrbit));
  ok("运行态核心会呼吸", !!av && av.busyCore === "agentGlow", av && av.busyCore);

  section("⑤ 运行态联动：setRunning 把输入框和头像一起点起来");
  const link = await page.evaluate(async () => {
    window.setRunning(true, "AI 思考中", window.state && window.state.convId);
    await new Promise((r) => setTimeout(r, 60));
    const onRun = {
      box: document.getElementById("chatInputBox").classList.contains("busy"),
      av: document.querySelector(".ag-avatar").classList.contains("busy"),
    };
    window.setRunning(false, null, window.state && window.state.convId);
    await new Promise((r) => setTimeout(r, 60));
    return { onRun, offBox: document.getElementById("chatInputBox").classList.contains("busy"), offAv: document.querySelector(".ag-avatar").classList.contains("busy") };
  });
  ok("任务开始：输入框与头像同时进忙态", link.onRun.box && link.onRun.av, JSON.stringify(link));
  ok("任务结束：两者同时退出（不会一直亮着骗人）", !link.offBox && !link.offAv, JSON.stringify(link));

  section("⑥ 切到 AGENT 窗口看运行态（截图给人眼复核）");
  await page.evaluate(async () => {
    document.getElementById("btnModeAgents").click();
    window.setRunning(true, "AI 思考中", window.state && window.state.convId);
    await new Promise((r) => setTimeout(r, 500));   // 让边框过渡跑起来再截
  });
  const vis = await page.evaluate(() => {
    const box = document.querySelector(".ag-avatar").getBoundingClientRect();
    const cs = getComputedStyle(document.querySelector(".ag-avatar"));
    return { w: Math.round(box.width), h: Math.round(box.height), visible: box.width > 0 && box.height > 0, color: cs.color };
  });
  ok("会话头标记在 AGENT 窗口里真的占位可见", vis.visible && vis.w > 20 && vis.h > 20, JSON.stringify(vis));
  await page.screenshot({ path: path.join(OUT, "uitaste-agent-busy.png") });
  await page.evaluate(() => window.setRunning(false, null, window.state && window.state.convId));

  /* ---------------- ⑦ 桌面窗口控制接线（红绿灯） ----------------
     主进程那一半由 _verify_desktop.js 真起 Electron 覆盖（frame:false + preload 已经在
     真实窗口里跑通过）。这里补的是渲染端那一半：preload 递进来一个假 window.pancodeWin，
     页面就该①亮出红绿灯②点它们真的把指令递出去。浏览器里（没有 pancodeWin）必须保持隐藏，
     否则用户会去点三个假按钮。 */
  section("⑦ 红绿灯：桌面端点亮并真的发指令，浏览器端保持隐藏");
  const deskPage = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await deskPage.addInitScript(() => {
    window.__winCalls = [];
    window.pancodeWin = {
      minimize: () => window.__winCalls.push("minimize"),
      toggleMax: () => window.__winCalls.push("toggleMax"),
      close: () => window.__winCalls.push("close"),
      isMaximized: () => Promise.resolve(false),
      onMaxChange: () => () => {},
    };
    try { localStorage.setItem("cw-onboarded", "1"); } catch (e) {}
  });
  await deskPage.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load", timeout: 30000 });
  await deskPage.waitForTimeout(1500);
  const d1 = await deskPage.evaluate(async () => {
    const t = document.querySelector(".traffic");
    const before = getComputedStyle(t).display;
    document.querySelector(".t-red").click();
    document.querySelector(".t-yellow").click();
    document.querySelector(".t-green").click();
    await new Promise((r) => setTimeout(r, 60));
    return {
      before, desktop: document.body.classList.contains("pc-desktop"),
      drag: getComputedStyle(document.getElementById("titlebar")).webkitAppRegion,
      btnDrag: getComputedStyle(document.querySelector(".tb-open")).webkitAppRegion,
      calls: window.__winCalls, redTitle: document.querySelector(".t-red").title,
    };
  });
  ok("有 preload 时 body 进 pc-desktop 态", d1.desktop === true, JSON.stringify(d1));
  ok("红绿灯显形（浏览器里是 display:none）", d1.before === "flex", d1.before);
  ok("点三个点分别发出 close / minimize / toggleMax",
    JSON.stringify(d1.calls) === JSON.stringify(["close", "minimize", "toggleMax"]), JSON.stringify(d1.calls));
  ok("标题栏可拖（-webkit-app-region: drag）", d1.drag === "drag", d1.drag);
  ok("标题栏里的按钮退出拖拽区（否则点了没反应）", d1.btnDrag === "no-drag", d1.btnDrag);
  ok("红点有说明：关闭不等于杀任务", /后台/.test(d1.redTitle || ""), d1.redTitle);
  await deskPage.close();
  const plain = await page.evaluate(() => ({
    desktop: document.body.classList.contains("pc-desktop"),
    display: getComputedStyle(document.querySelector(".traffic")).display,
  }));
  ok("浏览器里（没有 preload）红绿灯仍然隐藏，不骗人去点",
    plain.desktop === false && plain.display === "none", JSON.stringify(plain));

  /* ---------------- ⑧ 首屏：慢加载不冻结，两个窗口并发都出得来 ----------------
     这一节盯的是本轮两处改动的爆炸半径，不是基线算法本身（那在 `_verify_bootperf.js`）：
       · `snapshotFiles` / `snapshotFilesIncremental` 改走 `git.baselinePlanner()`，
         读的是 `trackedSet()` / `changes()` / `snapshotOf()` 三个既有方法拼出来的闭包；
         一旦 `trackedSet()` 的路径坐标系弄错（`ls-files` 输出是 **cwd 相对**，不能剥前缀），
         所有文件都会被当成"未跟踪"→ 基线取快照 → 改动面板与 diff 全错，但界面看起来一切正常。
       · `convContext` 里新挂了 `getHist`，它包住的正是工具执行与 emit 的整条路径。
     所以断的是"真渲染出来的首屏"：塞一个 2.4MB 文本进工作区（全量 hello 会带上它，
     旧写法要为每个文件发一发 `git show` 子进程），再开第二个窗口并发连。 */
  section("⑧ 首屏：大文件工作区 + 两窗口并发，仍然秒开且没冻住");
  const BIGFILE = "slow.txt";
  /* 900KB 而不是更大：`server/files.js` 的 MAX_FILE = 1MB，超过就**根本不进文件索引**
     （按文本读必乱码 + 吃内存），我第一次写 2.4MB 时文件树里压根没有它，waitForFunction 直接超时。
     首屏真正怕的是"文件个数 × 每文件一次子进程"，那一路由 `_verify_bootperf.js`（152 文件）钉；
     这里补的是界面这一侧：大文本进得了 hello、树里看得见、两个窗口并发连都不卡。 */
  const PAD = "PANCODE-BOOT-PAD\n";
  fs.writeFileSync(path.join(sb.wsDir, BIGFILE), PAD.repeat(56000));

  async function boot(page) {
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load", timeout: 30000 });
    // 首屏"有东西"的判据：hello 的 files 落进 state，并且文件树真的渲染出了条目
    try {
      await page.waitForFunction((name) => {
        /* `state` 是 app.js 顶层的 `const` → 全局词法绑定，**不挂在 window 上**
           （`window.state` 是 undefined，用它当判据会永远等不到；这里踩过一次超时）。 */
        const s = typeof state === "undefined" ? null : state;
        return !!(s && s.files && s.files[name]) && document.querySelectorAll(".ft-item").length > 0;
      }, BIGFILE, { timeout: 20000 });
    } catch (e) {
      /* 超时时把两边都打出来：state 里到底有没有这个文件、树里到底渲染了什么、服务端说了什么。
         没有这一段的话"首屏没出来"只能靠猜（我第一次就误判成 FileStore 的 1MB 上限）。 */
      const dbg = await page.evaluate(() => {
        const s = typeof state === "undefined" ? null : state;
        const f = (s && s.files) || {};
        return {
          n: Object.keys(f).length,
          keys: Object.keys(f).slice(0, 8),
          items: document.querySelectorAll(".ft-item").length,
          tree: document.getElementById("fileTree") ? document.getElementById("fileTree").innerHTML.slice(0, 160) : "",
          ws: (s && s.workspace) || null,
          booted: !!(s && s.booted),
        };
      }).catch((x) => ({ evalFailed: String(x && x.message) }));
      console.log("  \x1b[31m✗\x1b[0m boot 诊断：" + JSON.stringify(dbg));
      console.log("    服务端日志尾：" + childLog.slice(-500).replace(/\n/g, " | "));
      throw e;
    }
    return Date.now() - t0;
  }

  const pA = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const pB = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  for (const p of [pA, pB]) {
    await p.addInitScript((t) => {
      try {
        localStorage.setItem("cw-user-token", t);
        localStorage.setItem("cw-onboarded", "1");
      } catch (e) {}
      window.__winCalls = [];
      window.pancodeWin = {
        minimize: () => window.__winCalls.push("minimize"),
        toggleMax: () => window.__winCalls.push("toggleMax"),
        close: () => window.__winCalls.push("close"),
        isMaximized: () => Promise.resolve(false),
        onMaxChange: () => () => {},
      };
    }, token);
  }
  /* 先按下两个窗口的启动，再去量"已经打开的那个窗口此刻还响应不响应"——
     顺序反过来就变成了"加载完了看看有没有卡"，那测不到并发。 */
  const bootA = boot(pA), bootB = boot(pB);
  const responsive = await page.evaluate(async () => {
    const t0 = performance.now();
    const dd = document.getElementById("wsDropdown");
    const hidden = !dd || getComputedStyle(dd).display === "none";
    if (hidden) document.getElementById("btnOpenFolder").click();
    await new Promise((r) => setTimeout(r, 150));
    const el = document.getElementById("wsDropdown");
    const shown = !!el && getComputedStyle(el).display !== "none";
    if (hidden && shown) document.getElementById("btnOpenFolder").click();
    return { ms: Math.round(performance.now() - t0), shown };
  }).catch((e) => ({ ms: -1, shown: false, err: String(e && e.message) }));
  const [tA, tB] = await Promise.all([bootA, bootB]);
  ok("两个窗口并发连，都出得了首屏", tA > 0 && tB > 0, JSON.stringify({ tA, tB }));
  ok("首屏（含 900KB 文本的全量 hello）在 3s 内可见 —— 实测 " + tA + "ms / " + tB + "ms",
    tA < 3000 && tB < 3000, JSON.stringify({ tA, tB }));
  ok("另一个窗口正在起首屏时，已打开的窗口点击照常响应",
    responsive.shown === true && responsive.ms >= 0 && responsive.ms < 1500, JSON.stringify(responsive));

  /* 全量快照这一路真正要保证的是三件事：文件列出、内容全文读到、基线判对。
     服务端走 planner 还是走 `git.baseline` 回退分支，取决于这个沙箱工作区是不是仓库，
     所以把 `wsIsGitRepo` 打进 detail：别让人以为这里覆盖了仓库分支
     （`ls-files` 的坐标系只对 planner 才有意义，那部分由 `_verify_bootperf.js` 钉）。 */
  const bootState = await pA.evaluate((name) => {
    const s = typeof state === "undefined" ? null : state;
    const f = (s && s.files) || {};
    return {
      total: Object.keys(f).length,
      has: !!f[name],
      len: f[name] ? String(f[name].content || "").length : -1,
      first: f[name] ? String(f[name].content || "").slice(0, 15) : "",
      isNew: f[name] ? !!f[name].isNew : null,
      inTree: Array.from(document.querySelectorAll(".ft-item"))
        .some((el) => (el.textContent || "").includes(name)),
    };
  }, BIGFILE);
  const isRepo = fs.existsSync(path.join(sb.wsDir, ".git"));
  ok("大文件出现在文件树里", bootState.has && bootState.total >= 1, JSON.stringify(bootState));
  ok("文件树里看得见它（不只在 state 里）", bootState.inTree === true, JSON.stringify(bootState));
  ok("内容全文读到（900KB 一个字节不少）",
    bootState.len === PAD.length * 56000 && bootState.first === PAD.slice(0, 15),
    JSON.stringify({ len: bootState.len, want: PAD.length * 56000, first: bootState.first, wsIsGitRepo: isRepo }));
  ok("启动之后才冒出来的文件认成新增（基线没把它当成'已有内容'）",
    bootState.isNew === true, JSON.stringify(bootState));

  await pA.screenshot({ path: path.join(OUT, "uitaste-bigfile-boot.png") });
  await pA.close();
  await pB.close();
  try { fs.unlinkSync(path.join(sb.wsDir, BIGFILE)); } catch (e) {}

  section("⑨ 控制台");
  ok("整轮下来没有页面报错", errors.length === 0, JSON.stringify(errors.slice(0, 5)));
  await page.screenshot({ path: path.join(OUT, "uitaste-main.png") });

  await browser.close();
  child.kill();
  console.log("\n" + (fail ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m") + " — 通过 " + pass + " / 失败 " + fail);
  if (fail) for (const f of fails) console.log("  · " + f);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("VERIFY_FAIL", e && e.message ? e.stack : e);
  try { child.kill(); } catch (err) {}
  process.exit(1);
});
