/* ============================================================
   打包产物验收（#37：重新打包 exe 之后"装进去的到底是哪一版"）

   只看 release/ 里有没有 exe 是不够的，两件事必须分开证：
     A 产物跑得起来：直接起 win-unpacked/pancode.exe（沙箱数据根 + 独立端口），
       轮询 /api/health，再从**它自己 serve 出来的** /styles.css、/app.js、/ 断言
       本轮的改动确实在服务（包里的 public/ 是构建时拷的，源码改了没打进包就是两套代码）。
     B 包内内容是这一轮：按 asar 头部的 offset/size **直读字节**比对。
       ⚠ 绝不用 `asar extract-file`：它按 basename 写进当前工作目录，
       曾经把仓库根的 package.json 覆盖成包内裁剪版（见记忆 asar-extract-clobbers-repo）。
       Node API 的 `extractFile` 虽然只返回 Buffer，但对 public/js/* 这类路径在这台 Windows 上
       会报 not found，所以下面自己解析头部——顺带这条路径不再依赖 asar 包。

   跑法：npm run dist 完成后  node scripts/_verify_pkg.js
   会真的弹一个应用窗口（探针钩子 6 秒后自动关窗），这是预期行为。
   ============================================================ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
/* 解包目录默认在 release/win-unpacked；npm run dist 现在把中间产物放工作区外
   （IDE 的文件监听会握着 release 里的句柄，改名/删除就 EPERM/EBUSY，见 scripts/dist.js），
   并在 release/.unpacked-path 留个记号。没记号才回落到老路径。 */
function defaultUnpacked() {
  try {
    const p = fs.readFileSync(path.join(REPO, "release", ".unpacked-path"), "utf8").trim();
    if (p && fs.existsSync(p)) return path.resolve(p);
  } catch (e) {}
  return path.join(REPO, "release", "win-unpacked");
}
const UNPACKED = process.argv[2] ? path.resolve(process.argv[2]) : defaultUnpacked();
const EXE = path.join(UNPACKED, "pancode.exe");
const ASAR = path.join(UNPACKED, "resources", "app.asar");
const PORT = Number(process.env.PORT || 8877);
/* 发行门禁：没有产物就是红，不是"打个 SKIP 然后 exit 0"。
   本地没包可验时仍然可以普通跑（打「未测」后退出 0，分层运行器会把这一步记成 SKIP），
   但 verify:release / PANCODE_RELEASE=1 这一条路必须拦住，否则"验包"就成了装饰。 */
const RELEASE_GATE = process.env.PANCODE_RELEASE === "1" || process.argv.includes("--release");
const MANIFEST = path.join(REPO, "release", "build-manifest.json");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 300); } catch (e) { return String(v).slice(0, 300); } };

/* ---------------- asar 头部解析（只读，不落任何文件） ---------------- */

/* ============================================================
   ELECTRON_RUN_AS_NODE 必须摘掉，否则验包必假失败
   ------------------------------------------------------------
   这个变量存在时，Electron 会把自己当普通 Node 跑：不起 Chromium、
   不进 app 生命周期，require("electron") 拿到的是路径字符串而不是 app 对象，
   electron/main.js 第一行 app.setAppUserModelId(...) 就 TypeError，进程秒退。
   症状极具迷惑性：包内内容检查全过（包是对的），但"exe 能起来"永远失败。
   注意设成空字符串没用 —— Electron 只看变量**是否存在**。
   ============================================================ */
function electronEnv(extra) {
  const env = Object.assign({}, process.env, extra || {});
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function readArchive(archive) {
  const fd = fs.openSync(archive, "r");
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  const headerPickleSize = head.readUInt32LE(4);
  const pickle = Buffer.alloc(headerPickleSize);
  fs.readSync(fd, pickle, 0, headerPickleSize, 8);
  const strSize = pickle.readUInt32LE(4);
  const json = JSON.parse(pickle.slice(8, 8 + strSize).toString("utf8"));
  const dataStart = 8 + headerPickleSize;             // 文件内容紧跟在头部之后
  return {
    entries: json,
    read(rel) {
      const parts = String(rel).split("/");
      let node = json;
      for (const p of parts) {
        if (!node || !node.files || !node.files[p]) return null;
        node = node.files[p];
      }
      if (node.unpacked) {
        const loose = path.join(path.dirname(archive), "app.asar.unpacked", rel);
        return fs.existsSync(loose) ? fs.readFileSync(loose) : null;
      }
      const buf = Buffer.alloc(Number(node.size));
      fs.readSync(fd, buf, 0, Number(node.size), dataStart + Number(node.offset));
      return buf;
    },
    close() { fs.closeSync(fd); },
  };
}

(async () => {
  if (!fs.existsSync(EXE)) {
    const why = "没找到打包产物 " + EXE + "（先跑 npm run dist；release/.unpacked-path 指向的解包目录是 " + UNPACKED + "）";
    if (RELEASE_GATE) {
      console.log("\x1b[31m✗ 发行验收缺件：\x1b[0m" + why);
      console.log("共 1 条，红 1 条");
      process.exit(1);
    }
    console.log("\x1b[33m未测（SKIP）：\x1b[0m" + why);
    console.log("这一支什么都没验 —— 不是通过，是没测。发行门禁下这一步会直接红（PANCODE_RELEASE=1）。");
    console.log("共 0 条，红 0 条");
    process.exit(0);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-pkg-"));
  const wsDir = path.join(dataDir, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });
  const repoVersion = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

  section("M 这份产物是谁打出来的：构建清单与哈希对账");
  /* 没有清单 = 不知道这份 exe 对应哪一版代码，B 段再绿也只能说"包里有些本轮的字符串"。
     所以这一段先跑：它回答"验的是不是刚打的那一份"。 */
  const crypto = require("crypto");
  const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  if (!fs.existsSync(MANIFEST)) {
    ok("release/build-manifest.json 存在", false, "缺清单：重新跑 npm run dist（scripts/dist.js 现在必写这份）");
  } else {
    const mf = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
    ok("清单版本与源码版本一致 " + mf.version, mf.version === repoVersion, JSON.stringify({ 清单: mf.version, 源码: repoVersion }));
    ok("清单记下了来源 commit", !!mf.sourceCommit && /^[0-9a-f]{40}$/.test(mf.sourceCommit), String(mf.sourceCommit));
    if (RELEASE_GATE) ok("发行构建的工作树是干净的", mf.worktreeClean === true, "脏文件 " + mf.dirtyFiles + " 个：" + J(mf.dirtySample));
    for (const a of (mf.artifacts || [])) {
      const p = path.join(REPO, "release", a.file);
      if (!fs.existsSync(p)) { ok("清单里的产物真的在 release/：" + a.file, false, "文件不存在"); continue; }
      const now = sha256(p);
      ok(a.file + " 的 sha256 与清单一致", now === a.sha256 && fs.statSync(p).size === a.bytes,
        JSON.stringify({ 清单: String(a.sha256).slice(0, 12), 现在: now.slice(0, 12), 清单字节: a.bytes, 现在字节: fs.statSync(p).size }));
    }
    /* 清单记的 buildDir 是**输出根**，验的是它下面的 win-unpacked —— 两者不是同一个路径，
       直接拿字符串等比会永远红（第一版就是这么错的）。 */
    const expectUnpacked = mf.buildDir ? path.resolve(String(mf.buildDir), "win-unpacked") : null;
    ok("清单里的解包目录就是这一次在验的那个",
      expectUnpacked && expectUnpacked.replace(/\\/g, "/").toLowerCase() === UNPACKED.replace(/\\/g, "/").toLowerCase(),
      J({ 清单: expectUnpacked, 在验: UNPACKED }));
  }

  section("A 产物跑得起来（真起打包后的 exe）");
  const child = spawn(EXE, [], {
    cwd: UNPACKED,
    env: electronEnv({
      PANCODE_DATA_DIR: dataDir,            // 沙箱数据根：绝不碰真实用户数据
      CURSORWEB_WORKSPACE: wsDir,
      PORT: String(PORT),
      PANCODE_PROBE_CLOSE_MS: "6000",       // 探针钩子：到点关窗（关窗 ≠ 退出，进程仍要自己收掉）
      NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errLog = "";
  child.stdout.on("data", (d) => { errLog += d; });
  child.stderr.on("data", (d) => { errLog += d; });

  async function up(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return Date.now() - t0; } catch (e) {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return -1;
  }
  const bootMs = await up(60000);
  ok("打包后的 exe 能起来并且后端可访问（" + bootMs + "ms）", bootMs > 0, errLog.slice(-400));

  /* ⚠ 这两条是这轮补上的真门槛。上一版只断到 health 通为止，结果放行了一个
     "health 全绿、窗口从未出现"的包：`ipcMain.off(...)` 少传 listener 抛错，
     createWindow 中断在 ready-to-show 之前，后端照跑、界面根本不弹。
     所以要看主进程自己喊的"已显形"，还要看这路上没有未捕获的异步异常。 */
  const tMark = Date.now();
  const bothShown = () => errLog.includes("[pc] 窗口已显形") && errLog.includes("[pc] 页面加载完成");
  while (Date.now() - tMark < 20000 && !bothShown()) await new Promise((r) => setTimeout(r, 150));
  /* 两条心跳要**同时**在场才算过：只等"已显形"会放行一个"显形了但停在错误页"的包
     （ready-to-show 只保证第一帧，那一帧可以是"后端启动失败"那块兜底页）。 */
  ok("exe 的窗口真的显形、页面真的加载完成（两条心跳都在）", bothShown(), errLog.slice(-500));
  const crashes = (errLog.match(/(unhandledRejection|uncaughtException)[^\n]*/g) || []).slice(0, 2);
  ok("主进程这一路没有未捕获的异步异常", crashes.length === 0, crashes.join(" | "));

  if (bootMs > 0) {
    const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    /* 断的是壳：首页确实把这一轮的界面挂上去了。
       注意别用 `chatInputBox`——那是 app.js 运行时建的分隔层（`inputBox.id = "chatInputBox"`），
       HTML 里根本没有，我第一次就是被这条误判成"界面没打进去"。 */
    ok("首页把界面与脚本挂上了（不是回一个空壳/错误页）",
      html.includes('id="chatInputEditor"') && /<script[^>]+src="[^"]*app\.js/.test(html),
      html.slice(0, 120));
    /* 登录页（hello 还没来）阶段标题栏读的是这个占位：以前硬编码着 "todo-app"，
       等于开机先报一个不存在的项目名。 */
    ok("首页没有把项目名写死在壳里", !html.includes("todo-app"), "");
    const css = await (await fetch(`http://127.0.0.1:${PORT}/styles.css`)).text();
    ok("服务出来的 styles.css 含本轮补上的 --bg-elev（#35 下拉透明）",
      css.includes("--bg-elev") && css.includes("--bg-bar"), "");
    ok("服务出来的 styles.css 含输入框能量边框的动画（#34）", css.includes("pcSpin"), "");
    const appjs = await (await fetch(`http://127.0.0.1:${PORT}/app.js`)).text();
    ok("服务出来的 app.js 含水位格 traceCtx（#33 只显百分比）", appjs.includes("traceCtx"), "");
    const ctx = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json().catch(() => ({}));
    ok("health 回的就是这个包里的版本号 " + repoVersion, ctx.version === repoVersion, JSON.stringify(ctx).slice(0, 200));
    /* 沙箱护栏：打包后的 exe 也必须听 PANCODE_DATA_DIR / CURSORWEB_WORKSPACE。
       这条要是不成立，探针就是在用户真实工作区上跑，后面所有断言都不可信。 */
    const wsSeen = String(ctx.workspace || "");
    ok("exe 挂的是探针给的工作区（不是用户真实目录）",
      wsSeen && path.resolve(wsSeen) === path.resolve(wsDir), wsSeen);
  }

  section("B 包内内容就是这一轮的代码（asar 偏移直读，不落盘）");
  if (!fs.existsSync(ASAR)) {
    ok("resources/app.asar 存在", false, "没找到 " + ASAR);
  } else {
    const ar = readArchive(ASAR);
    const src = (rel) => { const b = ar.read(rel); return b ? b.toString("utf8") : null; };
    const git = src("server/git.js");
    ok("包内 server/git.js 有批量基线规划器（#38 首屏 22s）",
      !!git && git.includes("baselinePlanner") && git.includes("trackedSet"), String(git && git.length));
    ok("包内 server/git.js 仍带 _toRepo/_fromRepo 两套坐标系换算",
      !!git && git.includes("_toRepo") && git.includes("_fromRepo"), "");
    const al = src("server/agent-llm.js");
    ok("包内 server/agent-llm.js 有 _liveHistory（#39 预览分级读对会话）",
      !!al && al.includes("_liveHistory") && al.includes("getHist: () => history"), String(al && al.length));
    const pre = src("electron/preload.js");
    ok("包内有 electron/preload.js 且暴露 pancodeWin（红绿灯的渲染端那一半）",
      !!pre && pre.includes("pancodeWin"), "");
    const mainjs = src("electron/main.js");
    ok("包内 main.js 是 frameless 的那一版", !!mainjs && /frame:\s*false/.test(mainjs), "");
    const idx = src("public/index.html");
    ok("包内 index.html 用的是新会话头标记（#36，不再有渐变 P）",
      !!idx && idx.includes("ag-orbit") && !idx.includes("pcGradAgAvatar"), "");
    const mem = src("server/memory-store.js");
    /* 判"方法还在不在"要用定义形状判，不能 includes(名字)：撤除说明里就写着旧名字，
       按词判会把自家注释当成"没撤干净"的证据。 */
    const defined = (n) => new RegExp("^\\s{2}" + n + "\\s*\\(", "m").test(mem || "");
    ok("包内 memory-store.js 是判断层那一版（P6：常驻只剩硬提醒 + 索引）",
      !!mem && !defined("stableForContext") && !defined("relevantForContext")
      && !defined("formatStable") && !defined("formatRelevant") && !defined("topForContext") && !defined("formatForContext")
      && defined("guardForContext") && defined("formatIndex"), "");
    const al2 = src("server/agent-llm.js");
    ok("包内 agent-llm.js 装的是索引常驻那块，而不是整段正文注入",
      !!al2 && al2.includes("【记忆索引") && al2.includes("formatGuard")
      && !/(memory|userMemory)\.(formatStable|formatRelevant|formatForContext|topForContext)\(/.test(al2), "");
    const pkg = src("package.json");
    ok("包内 package.json 版本 = 仓库版本 " + repoVersion,
      !!pkg && JSON.parse(pkg).version === repoVersion, pkg && JSON.parse(pkg).version);
    /* 托盘图标的根因就在这条上：3.2.x 的 build.files 白名单里没有 assets/**，
       asar 里根本没有 icon-1024.png，`nativeImage.createFromPath` 拿到空图，
       托盘变成一个"点得到但看不见"的空图标，而且日志里一个字都没有。 */
    const icon = src("assets/icon-1024.png");
    ok("包内有 assets/icon-1024.png（托盘图标）", !!icon && icon.length > 1000, icon ? icon.length + " 字节" : "不在包里");
    const cp = src("electron/close-policy.js");
    ok("包内有关窗判据模块 close-policy.js（#41）",
      !!cp && cp.toString("utf8").includes("decideClose"), "");
    ok("包内**没有**探针与沙箱残骸（scripts/ 不在 files 白名单里）",
      src("scripts/_verify_bootperf.js") === null, "");
    ar.close();
  }

  section("C 关窗偏好=quit 时，进程要真的自己退干净（不留看不见又关不掉的后台）");
  /* A 段那个实例必须先收掉：Electron 的单实例锁按 userData 算，两个实例并存时第二个会被锁
     直接弹掉（连后端都不起），C 段就什么都验不到——第一次跑就是这么红两条的。 */
  try {
    if (process.platform === "win32" && child.pid) {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else child.kill();
  } catch (e) { /* 已经自己退了 */ }
  await new Promise((r) => setTimeout(r, 1500));
  /* 这条只能对打包产物验：它测的是"close → 判据 → app.quit → before-quit 收口 → 进程结束"
     整条链能不能走通。before-quit 里那句 preventDefault + 1.2s 定时器一旦收不了尾，
     用户点「直接退出」就会看到一个退不掉的进程——而且没有任何报错。 */
  const data2 = fs.mkdtempSync(path.join(os.tmpdir(), "pc-pkgquit-"));
  const ws2 = path.join(data2, "workspace");
  fs.mkdirSync(ws2, { recursive: true });
  fs.writeFileSync(path.join(data2, "pancode.config.json"),
    JSON.stringify({ workspace: ws2, desktop: { closeAction: "quit" } }), "utf8");
  const PORT2 = PORT + 1;
  const child2 = spawn(EXE, [], {
    cwd: UNPACKED,
    env: electronEnv({
      PANCODE_DATA_DIR: data2, CURSORWEB_WORKSPACE: ws2, PORT: String(PORT2),
      PANCODE_PROBE_CLOSE_MS: "5000",     // 到点等价于用户点红叉：偏好已写死 quit，不该弹框
      NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out2 = "";
  child2.stdout.on("data", (d) => { out2 += d; });
  child2.stderr.on("data", (d) => { out2 += d; });
  let exited = false;
  child2.on("exit", () => { exited = true; });
  const up2 = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if ((await fetch(`http://127.0.0.1:${PORT2}/api/health`)).ok) return true; } catch (e) {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  const booted2 = await up2(60000);
  ok("第二个实例起来了（closeAction=quit）", booted2, out2.slice(-300));
  const tExit = Date.now();
  while (Date.now() - tExit < 45000 && !exited) await new Promise((r) => setTimeout(r, 250));
  ok("关窗之后进程自己结束（探针全程没有 kill 它）", exited === true, out2.slice(-500));
  ok("退出走的是「按选择直接退出」那条分支，没有被模态框卡住",
    /按选择直接退出/.test(out2) && !/关窗选择已记住/.test(out2), out2.slice(-300));
  let stillUp = false;
  try { stillUp = (await fetch(`http://127.0.0.1:${PORT2}/api/health`)).ok; } catch (e) {}
  ok("退出后端口不再应答（后端与子进程一起收干净）", stillUp === false);
  try { fs.rmSync(data2, { recursive: true, force: true }); } catch (e) {}

  /* 收尾：关窗不等于退出（这是产品承诺），所以进程树要显式收掉，别留一个驻留托盘的实例。 */
  try {
    if (process.platform === "win32" && child.pid) {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else child.kill();
  } catch (e) { /* 已经自己退了 */ }
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  console.log("\n" + (fail ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m") + " — 通过 " + pass + " / 失败 " + fail);
  console.log("共 " + (pass + fail) + " 条，红 " + fail + " 条");
  if (fail) for (const f of fails) console.log("  · " + f);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("VERIFY_FAIL", e && e.stack ? e.stack : e);
  process.exit(1);
});
