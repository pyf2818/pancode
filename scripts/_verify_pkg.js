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
const UNPACKED = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO, "release", "win-unpacked");
const EXE = path.join(UNPACKED, "pancode.exe");
const ASAR = path.join(UNPACKED, "resources", "app.asar");
const PORT = Number(process.env.PORT || 8877);

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

/* ---------------- asar 头部解析（只读，不落任何文件） ---------------- */
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
    console.log("\x1b[33mSKIP:\x1b[0m 没找到打包产物 " + EXE + "（先跑 npm run dist）");
    process.exit(0);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-pkg-"));
  const wsDir = path.join(dataDir, "workspace");
  fs.mkdirSync(wsDir, { recursive: true });
  const repoVersion = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;

  section("A 产物跑得起来（真起打包后的 exe）");
  const child = spawn(EXE, [], {
    cwd: UNPACKED,
    env: Object.assign({}, process.env, {
      PANCODE_DATA_DIR: dataDir,            // 沙箱数据根：绝不碰真实用户数据
      CURSORWEB_WORKSPACE: wsDir,
      PORT: String(PORT),
      PANCODE_PROBE_CLOSE_MS: "6000",       // 探针钩子：到点关窗（关窗 ≠ 退出，进程仍要自己收掉）
      NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errLog = "";
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

  if (bootMs > 0) {
    const html = await (await fetch(`http://127.0.0.1:${PORT}/`)).text();
    /* 断的是壳：首页确实把这一轮的界面挂上去了。
       注意别用 `chatInputBox`——那是 app.js 运行时建的分隔层（`inputBox.id = "chatInputBox"`），
       HTML 里根本没有，我第一次就是被这条误判成"界面没打进去"。 */
    ok("首页把界面与脚本挂上了（不是回一个空壳/错误页）",
      html.includes('id="chatInputEditor"') && /<script[^>]+src="[^"]*app\.js/.test(html),
      html.slice(0, 120));
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
    ok("包内 memory-store.js 有分道注入（#31 stable / relevant）",
      !!mem && mem.includes("stableForContext") && mem.includes("relevantForContext"), "");
    const pkg = src("package.json");
    ok("包内 package.json 版本 = 仓库版本 " + repoVersion,
      !!pkg && JSON.parse(pkg).version === repoVersion, pkg && JSON.parse(pkg).version);
    ok("包内**没有**探针与沙箱残骸（scripts/ 不在 files 白名单里）",
      src("scripts/_verify_bootperf.js") === null, "");
    ar.close();
  }

  /* 收尾：关窗不等于退出（这是产品承诺），所以进程树要显式收掉，别留一个驻留托盘的实例。 */
  try {
    if (process.platform === "win32" && child.pid) {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else child.kill();
  } catch (e) { /* 已经自己退了 */ }
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}

  console.log("\n" + (fail ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m") + " — 通过 " + pass + " / 失败 " + fail);
  if (fail) for (const f of fails) console.log("  · " + f);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("VERIFY_FAIL", e && e.stack ? e.stack : e);
  process.exit(1);
});
