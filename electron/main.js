/* ============================================================
   pancode 桌面版入口（Electron 主进程）
   原理：和 VS Code 一样 —— 同一进程内拉起 Node 后端，
   再用 Chromium 窗口加载本地页面，网页秒变桌面应用。
   ============================================================ */
"use strict";
const { app, BrowserWindow, shell, nativeTheme, Tray, nativeImage, Notification, dialog, Menu, ipcMain, clipboard } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");
const taskWatch = require("./task-watch");
const closePolicy = require("./close-policy");
const frameTrust = require("./frame-trust");

/* 桌面版默认独立端口，避免与网页版(8766)冲突 */
const PORT = Number(process.env.PORT || 8767);
process.env.PORT = String(PORT);

/* Windows 下不设这个，系统通知会被当成"未关联应用的通知"直接丢弃，气泡根本不弹。
   必须与 package.json 的 build.appId 一致：electron-builder 给开始菜单快捷方式写的是 appId，
   两边不一致时任务栏分组/图标会退回 Electron 默认原子图。 */
app.setAppUserModelId("com.pancode.app");

/* 启动期配置文件只读一次：GPU 与沙箱两个开关都必须在 app.ready 之前同步决定，
   过窗口就不生效了（backend 起来以后再读，appendSwitch 已经晚了）。 */
const startupCfg = (() => {
  try {
    const root = process.env.PANCODE_DATA_DIR || path.join(__dirname, "..");
    return JSON.parse(fs.readFileSync(path.join(root, "pancode.config.json"), "utf8")) || {};
  } catch (e) { return {}; }   /* 没有配置文件 / 读不动 = 全走默认 */
})();

/* GPU 策略：默认交给 Chromium 自检（真桌面 GPU 上合成动画/模糊才有硬件加速，
   无条件禁用曾把整台应用压进软件光栅化，设置面板一次切换要 200-320ms）。
   虚拟机/远程桌面等无 GPU 环境才回退：PANCODE_GPU=0 或配置 desktop.gpu:"off"。 */
const gpuPref = (() => {
  if (process.env.PANCODE_GPU === "0") return "off";
  if (process.env.PANCODE_GPU === "1") return "on";
  if (startupCfg.desktop && startupCfg.desktop.gpu === "off") return "off";
  return "on";
})();
if (gpuPref === "off") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
}
/* 渲染进程沙箱：以前无条件 no-sandbox，等于把所有页面都跑在"能直接调系统调用"的进程里。
   这里根本不需要禁：渲染端 nodeIntegration=false、contextIsolation=true，
   preload 只 require("electron") 递红绿灯指令——沙箱开着的 preload 一样能拿到 ipcRenderer。
   （实测见 scripts/_verify_desktop.js：沙箱=开时窗口显形、页面加载、红绿灯 IPC 真的往返。）
   留一条回退给起不来的环境（受限组策略 / 某些杀软会拦 sandbox 进程）：
   PANCODE_SANDBOX=0 或配置 desktop.sandbox:"off"。默认是**开**。 */
const sandboxPref = (() => {
  if (process.env.PANCODE_SANDBOX === "0") return "off";
  if (process.env.PANCODE_SANDBOX === "1") return "on";
  if (startupCfg.desktop && startupCfg.desktop.sandbox === "off") return "off";
  return "on";
})();
if (sandboxPref === "off") app.commandLine.appendSwitch("no-sandbox");
console.log("[pc] 渲染进程沙箱=" + (sandboxPref === "off" ? "关" : "开") + " GPU=" + (gpuPref === "off" ? "关" : "开"));

let win = null;
let tray = null;
let trayOk = false;          // 托盘没建成时绝不能"关窗不退出"——那会变成看不见又关不掉的后台进程
let pageReady = false;       // 渲染端页面加载完没有（托盘"打开某条会话"要等它）
let pendingOpenConv = "";    // 页面还没好时先记下要点开的会话，did-finish-load 里补发
let quitting = false;        // 只有走「退出并终止所有任务」才置位
let winIpcBound = false;     // ipcMain 是进程级单例：这个标志必须是模块级的，绑在 createWindow 里等于每次重建窗口都再叠一组监听
let lastRows = [];
let lastTrayDump = "";       // 上次打给探针的托盘菜单快照，用来去重
let pollTimer = null;
/* 开机自启（登录项）拉起来的那一次带 --hidden：窗口照建、页面照加载（WS/任务都不断），只是不显形。 */
let startHidden = process.argv.includes("--hidden");
let startedHidden = false;   // 这次启动还没显过形：第一次唤回要顺带最大化（隐藏时不敢 maximize，它会把窗口带出来）
let hidNotified = false;     // 「已挂到后台」的提示一个进程只弹一次

/* 启动底色跟随系统主题（对齐 styles.css --bg：dark #0a0e13 / light #fafdfb），避免开窗闪错色 */
const bgFor = () => (nativeTheme.shouldUseDarkColors ? "#0a0e13" : "#fafdfb");

/* 关窗偏好读的是同进程后端的 cfg（设置界面写的也是同一份），不走 HTTP——闸门后面主进程没 token */
const DESKTOP_DEFAULTS = { closeAction: "ask", launchAtLogin: false, notifyOnDone: true };
const desktopPrefs = () => {
  try {
    if (backend && typeof backend.desktopPrefs === "function") return Object.assign({}, DESKTOP_DEFAULTS, backend.desktopPrefs() || {});
  } catch (e) { /* 后端还没就绪 → 走默认 */ }
  return Object.assign({}, DESKTOP_DEFAULTS);
};
const desktopPref = () => closePolicy.normalizePref(desktopPrefs().closeAction);
const setDesktopPref = (v) => {
  try { return (backend && typeof backend.setDesktopPref === "function") ? backend.setDesktopPref(v) : ""; }
  catch (e) { return ""; }
};
const setDesktopPrefs = (patch) => {
  try { return (backend && typeof backend.setDesktopPrefs === "function") ? backend.setDesktopPrefs(patch) : null; }
  catch (e) { return null; }
};

/* 开机自启 = 系统登录项。只有安装版才写：开发态写进去的是 node_modules 里的 electron.exe，
   换目录或卸载后就是一条开机报错的死项。--hidden 让登录拉起的那次只驻留托盘。 */
const loginItemPlatform = () => process.platform === "win32" || process.platform === "darwin";
const loginItemQuery = () => (process.platform === "win32" ? { path: process.execPath, args: ["--hidden"] } : {});
function syncLoginItem(why) {
  if (!app.isPackaged || !loginItemPlatform()) return;
  const want = desktopPrefs().launchAtLogin === true;
  let now = false;
  try { now = !!app.getLoginItemSettings(loginItemQuery()).openAtLogin; } catch (e) { now = false; }
  if (now === want) return;
  try {
    app.setLoginItemSettings(Object.assign({ openAtLogin: want }, loginItemQuery()));
    console.log("[pc] 开机自启=" + (want ? "开" : "关") + "（" + (why || "同步") + "）");
  } catch (e) {
    console.error("[electron] 开机自启写入失败：" + (e && e.message ? e.message : e));
  }
}

/* 在 Electron 主进程内直接拉起后端（同进程，无需额外 node） */
let backend = null;      // server/index.js 导出的 { shutdown }：退出时要显式收口，而不是让进程带着未落盘的会话消失
let shutDone = false;
function startServer() {
  backend = require(path.join(__dirname, "..", "server", "index.js"));
  /* 设置界面 / 托盘改的是本进程里的 cfg：落盘后立刻把系统登录项与托盘菜单同步过来，
     否则用户勾了「开机自启」要等下一次轮询才看得到状态。 */
  try {
    if (backend && typeof backend.onDesktopChange === "function") {
      backend.onDesktopChange(() => { syncLoginItem("设置"); refreshTray(); });
    }
  } catch (e) { /* 订阅不上不影响其余功能 */ }
}

/* 轮询健康检查，等后端就绪再加载页面，避免白屏 */
function waitForServer(retries = 80) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get(
        { host: "127.0.0.1", port: PORT, path: "/api/health", timeout: 500 },
        (res) => {
          res.resume();
          res.statusCode === 200 ? resolve() : retry(n);
        }
      );
      req.on("error", () => retry(n));
      req.on("timeout", () => { req.destroy(); retry(n); });
    };
    const retry = (n) =>
      n <= 0 ? reject(new Error("后端启动超时")) : setTimeout(() => tick(n - 1), 250);
    tick(retries);
  });
}

/* ---------- 来源边界（审查项 F13） ----------
   界面里会渲染模型输出、docx 预览（sandbox iframe）、以及各种链接。窗口是无边框的，
   红绿灯是唯一出口，所以"谁能发这条 IPC"必须问得出答案，而不是"反正 preload 只暴露四个方法"。
   判据本体在 electron/frame-trust.js（有单测），这里只接主进程才有的两样东西：帧对象与 shell。 */
const APP_ORIGIN = `http://127.0.0.1:${PORT}`;
let shownFailPage = false;    // 后端启动失败，当前主框面是我们自己写的 data: 错误页

const isAppUrl = (u) => frameTrust.isAppUrl(APP_ORIGIN, u, shownFailPage);

function fromAppFrame(event) {
  let url = "";
  try { url = String((event && event.senderFrame && event.senderFrame.url) || (event && event.sender && event.sender.getURL()) || ""); }
  catch (e) { return false; }   // 帧已销毁 → 按不可信处理
  return isAppUrl(url);
}

/* 拒绝把主框面开走的导航（页面上一个没有 target 的 <a>、一段 location.assign 都算）。
   以前只有 setWindowOpenHandler 管"开新窗"，当前窗口被导航走是没人拦的。 */
function guardNavigation(event, targetUrl, kind) {
  const dec = frameTrust.navigationAction(APP_ORIGIN, targetUrl, shownFailPage);
  if (dec.action === "allow") return;
  event.preventDefault();
  if (dec.action === "external") {
    console.log("[pc] " + kind + " 外部链接交给系统浏览器：" + String(targetUrl).slice(0, 120));
    Promise.resolve(shell.openExternal(String(targetUrl))).catch(() => {});
  } else {
    console.log("[pc] " + kind + " 拒绝非白名单协议：" + (dec.protocol || String(targetUrl).slice(0, 120)));
  }
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "pancode",
    /* 窗口/任务栏图标：无边框窗口不管开发态还是打包态都不会退回 exe 内嵌图标——
       不设就显示 Electron 默认原子（2026-10-19 实锤：exe 嵌了新图标、任务栏仍是原子）。
       与托盘同一个文件（托盘那段的教训：直接喂 ico 在部分 Windows 主题下拿空图，用 png 缩）。 */
    icon: path.join(__dirname, "..", "assets", "icon-1024.png"),
    backgroundColor: bgFor(),
    autoHideMenuBar: true,
    /* 无边框：页面自己就是标题栏。留着原生边框会出现两条标题栏——
       上面一条是系统的（在深色主题下就是一坨黑），下面一条是页面里的 .traffic 红绿灯。
       红绿灯从装饰变成真控件走 preload（contextIsolation 下渲染进程没有别的通道）。 */
    frame: false,
    show: false,               // 先最大化再显形：否则开窗瞬间能看到"小窗→铺满"的一次跳变
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: sandboxPref !== "off",
      preload: path.join(__dirname, "preload.js"),
    }
  });

  /* 红绿灯的三条指令。close 走 win.close()，让既有的"关窗 ≠ 退出"策略原样生效
     （托盘在的时候藏窗口、后端继续跑任务；没托盘才真退）。
     ⚠ 这里原先写的是 `ipcMain.off("pc-win:minimize")`，想防住重复注册——但
     `off`/`removeListener` **必须传 listener**，不传就抛 ERR_INVALID_ARG_TYPE，
     createWindow 从这一行整段中断：`ready-to-show` 没挂上，**窗口永远不显形**，
     而后端已经起来了（health 正常、`wsClients` 恒 0），实测打包产物正是这个症状。
     正确做法：`on` 只绑一次（下面的 flag），`handle` 用 `removeHandler`（它不需要 listener）。 */
  if (!winIpcBound) {
    winIpcBound = true;
    ipcMain.on("pc-win:minimize", (e) => {
      if (!fromAppFrame(e)) return;
      if (win && !win.isDestroyed()) win.minimize();
    });
    ipcMain.on("pc-win:toggle-max", (e) => {
      if (!fromAppFrame(e)) return;
      if (!win || win.isDestroyed()) return;
      if (win.isMaximized()) win.unmaximize(); else win.maximize();
    });
    ipcMain.on("pc-win:close", (e) => {
      if (!fromAppFrame(e)) return;
      if (win && !win.isDestroyed()) win.close();
    });
    // ipcMain 是进程级单例：handler 也只注册一次，靠闭包动态读模块变量 win
    ipcMain.handle("pc-win:is-max", (e) => {
      if (!fromAppFrame(e)) return false;
      return !!(win && !win.isDestroyed() && win.isMaximized());
    });
  }
  const pushMax = () => {
    if (win && !win.isDestroyed()) win.webContents.send("pc-win:max", win.isMaximized());
  };
  win.on("maximize", pushMax);
  win.on("unmaximize", pushMax);
  win.once("ready-to-show", () => {
    if (!win || win.isDestroyed()) return;
    /* 登录项拉起来的那次带 --hidden：只在托盘真的在时才静默（没有托盘还藏着窗口，
       用户就再也找不到它了）。maximize() 会把隐藏窗口带出来，所以这条路上两个都不调。 */
    if (startHidden && trayOk) {
      startHidden = false;
      startedHidden = true;
      console.log("[pc] 静默启动到托盘（--hidden）");
      return;
    }
    startHidden = false;
    win.maximize();
    win.show();
    /* 这一行是给验收用的心跳：后端能在窗口没显形的时候也回 health（3.2.1 第一次就这么漏掉了
       一个 createWindow 中途抛错的缺陷——health 一切正常、界面根本没弹出来）。
       探针断言"看到这行才算窗口真的显形"，顺带断这条链路里没有 unhandledRejection。 */
    console.log("[pc] 窗口已显形 maximized=" + win.isMaximized());
  });
  /* 比"显形"再往前一步：页面（HTML + JS）真的加载完了。
     不用 WS 连接数当判据是因为全新数据根下应用会先出登录页，不连 WS 是设计行为，
     那测的是登录态而不是"界面起没起来"。 */
  win.webContents.once("did-finish-load", () => {
    pageReady = true;
    console.log("[pc] 页面加载完成");
    /* 托盘点了某条任务但窗口当时还没起来（被销毁过 / 冷启动）：等页面就绪再补发一次 */
    if (pendingOpenConv) {
      const id = pendingOpenConv; pendingOpenConv = "";
      try { win.webContents.send("pc-open-conv", id); } catch (e) { /* 页面正好被关，放弃这一次 */ }
    }
  });
  win.webContents.once("did-navigate", () => { pageReady = false; });

  /* 外部链接交给系统默认浏览器打开。只放行 http(s)/mailto：openExternal 会把任意
     scheme 交给系统处理器，file:/smb:/自定义协议都可能是提权入口（win上加 \\.\ 一类
     设备路径甚至能直接崩 shell）。docx 预览里被塞进来的奇怪链接也走这道闸。
     白名单与下面的同窗口导航共用 frame-trust 那一份，不再各写一遍。 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    const dec = frameTrust.navigationAction(APP_ORIGIN, url, shownFailPage);
    if (dec.action === "external") {
      Promise.resolve(shell.openExternal(String(url))).catch(() => {});
    } else if (dec.action !== "allow") {
      console.log("[pc] 拒绝打开非白名单链接:", dec.protocol || String(url).slice(0, 120));
    }
    return { action: "deny" };
  });
  /* 同窗口导航（F13）：没有 target 的 <a>、window.location 改写都会走到这里。
     放走一次就等于把整个应用换成外部页面——红绿灯、WS、令牌全在别人的页面里跑。 */
  win.webContents.on("will-navigate", (e, url) => guardNavigation(e, url, "窗口导航"));

  /* 探针用：沙箱开启后红绿灯那条 IPC 链路是否真的还能往返。
     这条只能由主进程发起——判据要穿过 preload 暴露的真桥、ipcRenderer.invoke、
     再到主进程带 senderFrame 校验的 handler，最后把值回读给主进程。
     只在环境变量存在时生效，正常启动路径不受影响。 */
  const probeIpcMs = Number(process.env.PANCODE_PROBE_IPC_MS || 0);
  if (probeIpcMs > 0) {
    setTimeout(async () => {
      if (!win || win.isDestroyed()) { console.log("[pc] IPC 往返失败：窗口没了"); return; }
      try {
        const has = await win.webContents.executeJavaScript(
          "!!(window.pancodeWin && typeof window.pancodeWin.isMaximized === 'function')", true);
        const max = has ? await win.webContents.executeJavaScript("window.pancodeWin.isMaximized()", true) : null;
        console.log("[pc] IPC 往返 " + (has && typeof max === "boolean" ? "ok" : "失败") + " bridge=" + has + " isMax=" + max);
      } catch (e) {
        console.log("[pc] IPC 往返失败：" + (e && e.message ? e.message : e));
      }
    }, probeIpcMs);
  }

  win.on("closed", () => { win = null; });

  /* 关窗去向：问 / 挂后台 / 直接退出。判据全在 electron/close-policy.js（那边有单测），这里只管执行。
     - 挂后台用 hide() 而不是 destroy：渲染进程留着，任务流与系统通知不断线，从托盘唤回是瞬开。
     - 没有托盘时绝不挂后台（decideClose 里 trayOk=false 一律放行关闭），
       否则会留下一个"看不见又关不掉"的后台进程——这是以前"关窗 ≠ 退出"这条承诺唯一的破口。
     - 对话框必须用**异步**版：`showMessageBoxSync` 会把 Electron 主循环整段卡住，
       而后端就跑在同一个进程里——问一句话的功夫，正在跑的任务就停了。
       异步版靠"先 preventDefault 按住这次关闭，答完再决定"来保证不会先把窗口关掉。 */
  const applyClose = (dec) => {
    if (dec.rememberPref) {
      setDesktopPref(dec.rememberPref);
      console.log("[pc] 关窗选择已记住：" + dec.rememberPref);
    }
    if (dec.action === "hide") {
      if (win && !win.isDestroyed()) win.hide();
      console.log("[pc] 已挂到后台，任务继续跑");
      /* 第一次挂后台最容易"人找不到窗口了"：明说窗口去哪了、点哪能回来。一个进程只弹一次。 */
      if (!hidNotified) {
        hidNotified = true;
        trayNote("pancode 已挂到后台", "任务继续跑。点这条通知或托盘图标随时唤回窗口。", showWindow);
      }
      return;
    }
    if (dec.action === "quit") {
      quitting = true;
      console.log("[pc] 按选择直接退出");
      app.quit();
    }
    // cancel：什么都不做，窗口留着
  };
  /* 答完之后的处理抽出来：真对话框和探针注入走同一条路。
     上一版没抽这层，结果"记住我的选择"坏了很久都没人发现 —— 读返回值时把 Electron 的
     checkboxChecked 拼成了另一个同族字段名，永远是 undefined，勾了也不落盘，
     而判据本身（close-policy.js）有单测、一直是绿的。集成点不测，就等于没修。 */
  const handleCloseAnswer = (res) => {
    if (!res) return;
    const dec = closePolicy.decideClose({
      pref: desktopPref(), quitting, trayOk, choice: res.response, remember: res.checkboxChecked === true,
    });
    applyClose(dec);
  };
  win.on("close", (e) => {
    const pref = desktopPref();
    if (quitting || !trayOk || pref !== "ask") {
      const dec = closePolicy.decideClose({ pref, quitting, trayOk });
      if (dec.action === "allow") return;         // 放行：窗口真关（无托盘时 window-all-closed 会带走进程）
      e.preventDefault();
      applyClose(dec);
      return;
    }
    e.preventDefault();                            // 这次关闭先按住，等用户答完再决定
    /* 探针用：不弹原生模态框（没人能自动化点它），直接把答案喂进同一条处理路径 */
    const probeAns = process.env.PANCODE_PROBE_CLOSE_ANSWER;
    if (probeAns !== undefined && probeAns !== "") {
      console.log("[pc] 探针注入关窗答案 " + probeAns + "（记住=" + (process.env.PANCODE_PROBE_CLOSE_REMEMBER === "1") + "）");
      handleCloseAnswer({ response: Number(probeAns), checkboxChecked: process.env.PANCODE_PROBE_CLOSE_REMEMBER === "1" });
      return;
    }
    const box = closePolicy.closeDialog(taskWatch.countRunning(lastRows));
    const host = win && !win.isDestroyed() ? win : undefined;
    Promise.resolve(dialog.showMessageBox(host, box)).then(handleCloseAnswer).catch((err) => {
      console.error("[electron] 关窗对话框没弹出来（" + (err && err.message) + "），这次不关，避免误杀后台任务");
    });
  });

  /* 探针专用：到点直接关窗，用来验「关窗 ≠ 退出」这条承诺（scripts/_verify_desktop.js）。
     只在环境变量存在时生效，正常启动路径完全不受影响。
     支持逗号分隔的多个时刻：「记住我的选择」那条路要关两次窗——第一次问、答完并落盘，
     第二次**不该再问**。单个时刻只能验到第一次，第二次才是那个真正的判据。 */
  const probeCloseMs = String(process.env.PANCODE_PROBE_CLOSE_MS || "")
    .split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  for (const ms of probeCloseMs) {
    setTimeout(() => {
      try {
        /* 先唤回再关：用户第二次点 ✕ 之前一定是从托盘把窗口捞回来的，
           藏着直接 close() 不是真实路径（hide 状态下 close 事件的行为和可见态不一样）。 */
        showWindow();
        if (win && !win.isDestroyed()) win.close();
      } catch (e) {}
    }, ms);
  }

  /* 探针用：静默启动（--hidden）之后，从托盘唤回窗口的那一步。
     原生托盘点击合成不了，这里直接调 showWindow 同一条链，验"藏着的窗口能被重新显形"。 */
  const probeShowMs = Number(process.env.PANCODE_PROBE_SHOW_MS || 0);
  if (probeShowMs > 0) {
    setTimeout(() => {
      showWindow();
      console.log("[pc] 探针唤回窗口 visible=" + !!(win && !win.isDestroyed() && win.isVisible())
        + " maximized=" + !!(win && !win.isDestroyed() && win.isMaximized()));
    }, probeShowMs);
  }

  /* 窗口可能在后端就绪之前就被关掉（用户抢那 1–2 秒，或探针到点关窗）。
     `isDestroyed()` 判活只挡得住"已经关掉"，挡得住检查那一瞬、挡不住紧随其后的销毁——
     实测探针把窗关掉时 loadURL 仍会以 "Object has been destroyed" 拒绝。
     所以每一次加载都要自己收口：被中断的加载不是崩溃，不该变成 unhandledRejection。 */
  const winAlive = () => !!(win && !win.isDestroyed());
  const loadOrFail = (u, why) => {
    try {
      return Promise.resolve(win.loadURL(u)).catch((e) => {
        console.log("[pc] 页面加载中断（" + why + "）：" + (e && e.message ? e.message : e));
      });
    } catch (e) { console.log("[pc] 页面加载失败（" + why + "）：" + e.message); return Promise.resolve(); }
  };
  try {
    await waitForServer();
    if (winAlive()) await loadOrFail(`http://127.0.0.1:${PORT}/`, "主界面");
  } catch (e) {
    console.log("[pc] 后端启动失败：" + (e && e.message ? e.message : e));
    if (winAlive()) {
      /* 错误页也是"我们自己的框面"：无边框窗口只有红绿灯能关，
         把它标成可信来源，否则后端起不来时窗口连关都关不掉。 */
      shownFailPage = true;
      await loadOrFail(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(`<body style="background:${bgFor()};color:${nativeTheme.shouldUseDarkColors ? "#ccc" : "#333"};font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0"><div><h3>pancode 后端启动失败</h3><p>${e.message}</p></div></body>`),
        "错误页"
      );
    }
  }
}

/* ---------- 托盘：窗口关掉后端继续跑（用户的决定：派出去的活不能因为关窗就死） ---------- */

/* 托盘图标用 png 再缩到 16px：直接喂 ico 在部分 Windows 主题下会拿到空图，托盘静默消失。
   ⚠ 空图这件事以前**完全没有痕迹**：3.2.x 的包里根本没有 assets/（build.files 白名单漏了它），
   托盘于是变成一个"点得到但看不见"的空图标，日志里一个字都没有，用户看到的就是"托盘没图标"。
   读不到就大声记一行，并且打一行成功心跳给验收探针断言用。 */
function trayIcon() {
  const p = path.join(__dirname, "..", "assets", "icon-1024.png");
  let img = null;
  try { img = nativeImage.createFromPath(p); } catch (e) { img = null; }
  if (!img || img.isEmpty()) {
    console.error("[electron] 托盘图标读不到：" + p + " —— 托盘会变成看不见的空图标。"
      + "打包态请检查 package.json 里 build.files 是否包含 assets/**。");
    return img || nativeImage.createEmpty();
  }
  const small = img.resize({ width: 16, height: 16 });
  const sz = small.getSize();
  console.log("[pc] 托盘图标 ok " + sz.width + "x" + sz.height);
  return small;
}

function showWindow() {
  if (quitting) return;                 // 正在退出时不复活窗口，否则退出流程会被一张新窗口拖住
  if (win && !win.isDestroyed()) {
    /* 静默启动时没最大化（maximize 会把隐藏窗口带出来），第一次唤回补上 */
    if (startedHidden) { startedHidden = false; win.maximize(); }
    win.show(); win.focus(); return;
  }
  startHidden = false;                  // 窗口重建属于"用户要看它"，不再静默
  createWindow();
}

/* 托盘点某条任务 = 唤回窗口并跳到那条会话。
   窗口可能正藏着（挂后台是常态）、可能已被销毁要重建、也可能页面还没加载完 ——
   最后那种只能先记下，等 did-finish-load 再补发，否则 IPC 发进一个还没接听的渲染进程。 */
function openConversation(convId) {
  if (!convId) return;
  /* 这一行同时是验收心跳：托盘点击没有真鼠标，能证明的边界到"主进程确实把这一条送进渲染进程"为止，
     渲染端跳转由 scripts/_verify_trayjump.js 用假 pancodeWin 桥在真实 app.js 上验。 */
  console.log("[pc] 托盘跳会话 " + convId + "（页面就绪=" + pageReady + "）");
  showWindow();
  if (!win || win.isDestroyed()) return;
  console.log("[pc] 唤回窗口后可见=" + win.isVisible());
  if (!pageReady || win.webContents.isLoading()) { pendingOpenConv = convId; return; }
  try { win.webContents.send("pc-open-conv", convId); } catch (e) { pendingOpenConv = convId; }
}

const CLOSE_PREF_LABEL = { ask: "每次询问", background: "挂到后台", quit: "直接退出" };

/* 托盘里的「后台与关闭」：关窗行为 + 两个开关，全在托盘上就能改，不用先唤回窗口再翻设置。
   写的是同一份 cfg（与设置界面同源），落盘后 config 的钩子会把系统登录项一起同步。 */
function trayPrefsItem() {
  const p = desktopPrefs();
  const cur = closePolicy.normalizePref(p.closeAction);
  const setClose = (v) => {
    setDesktopPref(v);
    console.log("[pc] 托盘改关窗偏好：" + v);
    refreshTray();
  };
  const setBool = (k, v) => {
    setDesktopPrefs({ [k]: v });
    console.log("[pc] 托盘改 " + k + "=" + v);
    syncLoginItem("托盘");
    refreshTray();
  };
  return {
    label: "后台与关闭（关窗：" + CLOSE_PREF_LABEL[cur] + "）",
    submenu: [
      { label: "关闭窗口时", enabled: false },
      { label: "每次询问（答完可记住）", type: "radio", checked: cur === "ask", click: () => setClose("ask") },
      { label: "挂到后台（任务继续跑）", type: "radio", checked: cur === "background", click: () => setClose("background") },
      { label: "直接退出", type: "radio", checked: cur === "quit", click: () => setClose("quit") },
      { type: "separator" },
      /* 开发态不写登录项（写进去的是 node_modules 里的 electron.exe），所以只给安装版可点 */
      { label: "开机自启（静默到托盘）", type: "checkbox", checked: p.launchAtLogin === true,
        enabled: app.isPackaged && loginItemPlatform(), click: (it) => setBool("launchAtLogin", it.checked) },
      { label: "任务收口时弹通知", type: "checkbox", checked: p.notifyOnDone !== false,
        click: (it) => setBool("notifyOnDone", it.checked) },
    ],
  };
}

function trayMenu() {
  const t = [{ label: taskWatch.trayStatusLine(lastRows), enabled: false }];
  /* 分组列表：卡住要批的排最前。挂后台的人回到托盘第一眼要看到的是"有一条等你"，
     而不是"最近发生了什么"。点一条 = 唤回窗口 + 打开那条会话。 */
  for (const sec of taskWatch.traySections(lastRows)) {
    t.push({ type: "separator" });
    t.push({ label: sec.title, enabled: false });
    for (const it of sec.items) {
      t.push({ label: it.label, enabled: !it.disabled, click: () => openConversation(it.convId) });
    }
  }
  t.push({ type: "separator" });
  t.push({ label: "打开 pancode 窗口", click: showWindow });
  t.push(trayPrefsItem());
  t.push({ label: "打开工作区文件夹", click: openWorkspaceDir });
  t.push({ label: "复制诊断信息（反馈问题用）", click: copyDiagnostics });
  t.push({ type: "separator" });
  t.push({ label: "退出 pancode（终止所有任务）", click: () => quitWithTasks() });
  return Menu.buildFromTemplate(t);
}

function openWorkspaceDir() {
  let dir = "";
  try { dir = (backend && backend.workspaceDir && backend.workspaceDir()) || ""; } catch (e) { dir = ""; }
  if (!dir) { trayNote("后端还没就绪", "工作区路径要等引擎起来才知道，稍后再试一次。"); return; }
  Promise.resolve(shell.openPath(dir)).then((err) => {
    if (err) trayNote("打不开工作区文件夹", String(err).slice(0, 160));
  });
}

/* 内测阶段最缺的不是日志系统，是"用户怎么把现场交给我"。
   日志环是内存的（重启即空），所以这里趁进程还活着把 warn/error 抄成一段文本进剪贴板。
   注意任务标题是用户原话的前 80 字 —— 复制出来的东西含它，通知里明说一句。 */
function copyDiagnostics() {
  let snap = null;
  try { snap = backend && backend.diagSnapshot ? backend.diagSnapshot() : null; } catch (e) { snap = null; }
  if (!snap) { trayNote("诊断信息没取到", "后端还没就绪，稍后再试一次。"); return; }
  const L = [];
  L.push("pancode 诊断快照 " + new Date().toISOString());
  L.push("版本 " + snap.version + " / API " + snap.apiStamp + " / Electron " + process.versions.electron + " / Node " + process.versions.node);
  L.push("平台 " + process.platform + " " + process.arch + " / 窗口 " + (win && !win.isDestroyed() ? "在" : "已关（挂后台）") + " / 托盘 " + (trayOk ? "在" : "无"));
  L.push("工作区 " + (snap.workspace || "?") + " / 关窗偏好 " + desktopPref() + " / 连接数 " + snap.wsClients);
  const e = snap.engine || {};
  L.push("引擎 " + (e.mode || "?") + " 模型 " + (e.model || "-") + " 地址 " + (e.baseURL || "-"));
  const rows = snap.tasks || [];
  L.push("");
  L.push("任务（标题取自你的指令原文，分享前可自行删改）：");
  if (!rows.length) L.push("  （空）");
  for (const r of rows.slice(0, 20)) {
    L.push("  [" + r.status + "] " + String(r.title || "").slice(0, 60) + " | 工具 " + (r.tools || 0)
      + (r.origin === "automation" ? " | 自动化" : "")
      + (r.waitingFor ? " | 等你批：" + String(r.waitingFor).slice(0, 40) : "")
      + (r.error ? " | 错：" + String(r.error).replace(/\s+/g, " ").slice(0, 120) : ""));
  }
  const logs = snap.logs || [];
  L.push("");
  L.push("最近告警/错误（内存环，最多 150 条，重启即空）：");
  if (!logs.length) L.push("  （没有 warn 以上级别的日志）");
  for (const g of logs.slice(-60)) {
    L.push("  " + new Date(g.ts || g.at || Date.now()).toISOString() + " [" + (g.level || "?") + "/" + (g.mod || g.module || "?") + "] "
      + String(g.msg || g.message || "").replace(/\s+/g, " ").slice(0, 200));
  }
  const text = L.join("\n");
  try { clipboard.writeText(text); } catch (err) { trayNote("剪贴板写入失败", String((err && err.message) || err).slice(0, 120)); return; }
  console.log("[pc] 诊断信息已复制到剪贴板（" + text.length + " 字，任务 " + rows.length + " 条，日志 " + logs.length + " 条）");
  trayNote("诊断信息已复制", "共 " + text.length + " 字（含最近告警）。直接粘贴给开发者即可。");
}

function trayNote(title, body, onClick) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true });
    /* 挂后台的提示必须能点回去：通知本身就是"窗口在哪"的答案，点了没反应等于没提示 */
    if (typeof onClick === "function") n.on("click", onClick);
    n.show();
  } catch (e) { /* 通知发不出去就算了，不影响菜单动作 */ }
}

/* 菜单快照：子菜单也要摊开，否则「后台与关闭」里的四个开关在探针眼里只是一个标题。
   勾选态用 ✓ / ○ 标出来——radio 选的是哪一档、checkbox 开没开，全在日志里可判。 */
function menuDump(items) {
  return (items || []).map((it) => {
    const mark = (it.type === "checkbox" || it.type === "radio") ? (it.checked ? "✓" : "○") : "";
    const label = mark + (it.label || "—");
    return it.submenu ? label + " ▸ [" + menuDump(it.submenu.items) + "]" : label;
  }).join(" | ");
}

function refreshTray() {
  if (!tray || !trayOk) return;
  try {
    tray.setToolTip("pancode — " + taskWatch.trayStatusLine(lastRows));
    const menu = trayMenu();
    tray.setContextMenu(menu);
    /* 托盘菜单是原生弹层：Playwright 点不到、截图也拍不进（它在窗口之外）。
       所以探针能断言的最强证据是"这一份菜单项确实被装配出来了"——分组顺序、每组条数上限、
       底部几条动作项，全在这一行里。只在 PANCODE_PROBE_TRAY_DUMP=1 时打印，
       且只在内容真的变了时打印，免得 3 秒一轮把日志刷满。 */
    if (process.env.PANCODE_PROBE_TRAY_DUMP) {
      const dump = menuDump(menu.items);
      if (dump !== lastTrayDump) { lastTrayDump = dump; console.log("[pc] 托盘菜单：" + dump); }
    }
  } catch (e) { /* 托盘刷新失败不影响后端 */ }
}

/* 「退出并终止所有任务」：还有任务在跑时先确认，别让人一键把干到一半的活悄悄掐了。
   对话框必须用异步版：后端与主进程同进程，showMessageBoxSync 会把主循环连同
   正在流式的任务整段卡住，直到用户点掉对话框。加一个重入闸，连点两次也只弹一张。 */
let quitDialogOpen = false;
async function quitWithTasks() {
  if (quitting || quitDialogOpen) return;
  const n = taskWatch.countRunning(lastRows);
  if (n > 0) {
    quitDialogOpen = true;
    let choice = 1;
    try {
      const box = {
        type: "warning",
        buttons: ["仍要退出", "继续等它跑完"],
        defaultId: 1,
        cancelId: 1,
        message: "还有 " + n + " 个任务在跑",
        detail: "退出会中断这些任务，并终止后端与它起的全部子进程。",
      };
      const res = win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, box)
        : await dialog.showMessageBox(box);
      choice = res && res.response;
    } catch (e) {
      choice = 1;   // 对话框本身失败时不替用户做"退出"的决定
    } finally {
      quitDialogOpen = false;
    }
    if (choice !== 0) return;
  }
  quitting = true;
  app.quit();
}

/* 任务表读的是**同进程的后端**，不走 HTTP。
   ⚠ 以前这里每 3 秒 `http.get("/api/tasks")` 一次，而那个端点在登录闸门后面、主进程手里没有
   userToken → 恒 401 → `rows` 永远是空数组。后果是托盘状态行永远报"没有任务在跑"，
   任务收口的系统通知也一次都没弹出来过——窗口挂后台的人恰恰是最需要这两样的人。
   计数变化时打一行心跳，验收探针就断这一行（它能证明"真的数到了任务"，而不是"轮询没报错"）。 */
function pollTasks() {
  if (!backend || typeof backend.taskRows !== "function") { scheduleNext(1000); return; }
  let rows = [];
  try { rows = backend.taskRows() || []; } catch (e) { rows = []; }
  const had = taskWatch.countRunning(lastRows);
  const have = taskWatch.countRunning(rows);
  const settled = taskWatch.justSettled(lastRows, rows);
  lastRows = rows;
  refreshTray();
  if (had !== have) console.log("[pc] 托盘状态：" + taskWatch.trayStatusLine(rows) + "（在跑 " + have + "）");
  const notifyDone = desktopPrefs().notifyOnDone !== false;
  for (const r of settled) {
    if (!notifyDone || !Notification.isSupported()) break;
    const t = taskWatch.notifyText(r);
    const n = new Notification({ title: t.title, body: t.body, silent: false });
    /* 点通知 = 回到那条会话：窗口挂着后台时，这是最短的一条路 */
    n.on("click", () => openConversation(r.convId));
    n.show();
    console.log("[pc] 任务收口通知 " + (r.convId || "?") + " [" + r.status + "]");
  }
  scheduleNext(have ? 3000 : 15000);
}

function scheduleNext(ms) {
  if (pollTimer) clearTimeout(pollTimer);
  if (quitting) return;
  pollTimer = setTimeout(pollTasks, ms);
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
    trayOk = true;
    tray.on("click", showWindow);
    refreshTray();
    scheduleNext(3000);
    /* 探针专用：到点走一遍"点了托盘里某条任务"的真处理函数。
       原生菜单收不到合成鼠标事件，所以这里直接调 click 里那同一个函数——
       验的是 openConversation 这条链（唤回窗口 + 发通道），不是另写一条测试路径。 */
    const clickMs = Number(process.env.PANCODE_PROBE_TRAY_CLICK_MS || 0);
    if (clickMs > 0) {
      setTimeout(() => {
        const row = lastRows.find((r) => taskWatch.isLive(r)) || lastRows[0];
        if (!row) { console.log("[pc] 探针模拟托盘点击：任务表还是空的"); return; }
        console.log("[pc] 探针模拟托盘点击 " + row.convId + " [" + row.status + "]");
        openConversation(row.convId);
      }, clickMs);
    }
  } catch (e) {
    trayOk = false;   // 无托盘环境（精简 Linux / 远程桌面）：退回"关窗即退出"，不能留个关不掉的后台
    console.error("[electron] 托盘创建失败，关闭窗口将同时退出应用：", e.message);
  }
}

/* 打包态：server 的所有数据/配置都写入可写目录（asar 只读，__dirname 落在 app.asar 内会 EPERM 崩主进程），
   默认取 userData。**显式给了 PANCODE_DATA_DIR 就听它的，并把 userData 一起搬过去**——
   两件事都是实测逼出来的：① 不搬的话验收探针直接写在用户真实的 %AppData%\pancode 上，
   "沙箱数据根"那句是假话；② userData 相同 ⇒ 单实例锁相同 ⇒ 探针想验第二个实例
   （关窗偏好=quit 那条路）会被锁直接弹掉，永远验不到。必须在 whenReady 之前做。
   ⚠ 这一段以前挂在 `if (app.isPackaged)` 里面：dev 态探针给了 PANCODE_DATA_DIR 却只搬后端、
   不搬 userData，于是渲染进程 localStorage / 缓存 / GPU 着色器全落进真实的 %AppData%\pancode，
   而且和装着的那个实例抢同一把单实例锁。注释写着的事实，代码里根本没执行。 */
{
  const given = process.env.PANCODE_DATA_DIR;
  if (given) {
    try { app.setPath("userData", given); } catch (e) { console.error("[electron] userData 改不动：" + e.message); }
  } else if (app.isPackaged) {
    process.env.PANCODE_DATA_DIR = app.getPath("userData");
  }
}

app.whenReady().then(() => {
  /* 单实例：托盘驻留后用户很可能再点一次桌面图标。不加这把锁，第二个实例会在同端口
     再起一个后端（EADDRINUSE），或直接出现两份互相看不见的工作状态。 */
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", () => { showWindow(); });

  startServer();
  createWindow();
  createTray();
  syncLoginItem("启动");
  console.log("[pc] 系统通知=" + (Notification.isSupported() ? "可用" : "不可用"));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/* 关窗 ≠ 退出：后端继续跑，任务照旧推进，收口时弹系统通知，托盘里能看到状态。
   只有走托盘「退出并终止所有任务」（quitting）或没有托盘时才真正退出。 */
app.on("window-all-closed", () => {
  if (quitting || !trayOk) app.quit();
});

/* macOS 的 Cmd+Q 不走 window-all-closed，必须显式接住退出前的收口 */
app.on("before-quit", (e) => {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (backend && typeof backend.shutdown === "function" && !shutDone) {
    e.preventDefault();
    shutDone = true;
    /* 后端 shutdown 现在返回"数据已落盘"的信号（预算 2.5s）。原先这里拍死一个 1200ms
       的闹钟就 app.quit()，等于把还没写完的会话/登录态连同进程一起掐掉。 */
    const go = () => { try { app.quit(); } catch (err) {} };
    let done = null;
    try { done = backend.shutdown("electron-quit"); } catch (err) {}
    if (done && typeof done.then === "function") done.then(go, go);
    setTimeout(go, 5000);   // 兜底：后端收口挂住时仍要退出，不能让窗口关不掉
  }
});
