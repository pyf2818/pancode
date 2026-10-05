/* ============================================================
   pancode 桌面版入口（Electron 主进程）
   原理：和 VS Code 一样 —— 同一进程内拉起 Node 后端，
   再用 Chromium 窗口加载本地页面，网页秒变桌面应用。
   ============================================================ */
"use strict";
const { app, BrowserWindow, shell, nativeTheme, Tray, nativeImage, Notification, dialog, Menu, ipcMain } = require("electron");
const http = require("http");
const path = require("path");
const taskWatch = require("./task-watch");

/* 桌面版默认独立端口，避免与网页版(8766)冲突 */
const PORT = Number(process.env.PORT || 8767);
process.env.PORT = String(PORT);

/* Windows 下不设这个，系统通知会被当成"未关联应用的通知"直接丢弃，气泡根本不弹 */
app.setAppUserModelId("com.pancode.desktop");

/* 虚拟机/远程桌面等无独立 GPU 环境下回退软件渲染，避免 GPU 进程崩溃 */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");

let win = null;
let tray = null;
let trayOk = false;          // 托盘没建成时绝不能"关窗不退出"——那会变成看不见又关不掉的后台进程
let quitting = false;        // 只有走「退出并终止所有任务」才置位
let winIpcBound = false;     // ipcMain 是进程级单例：这个标志必须是模块级的，绑在 createWindow 里等于每次重建窗口都再叠一组监听
let lastRows = [];
let pollTimer = null;

/* 启动底色跟随系统主题（对齐 styles.css --bg：dark #0a0e13 / light #fafdfb），避免开窗闪错色 */
const bgFor = () => (nativeTheme.shouldUseDarkColors ? "#0a0e13" : "#fafdfb");

/* 在 Electron 主进程内直接拉起后端（同进程，无需额外 node） */
let backend = null;      // server/index.js 导出的 { shutdown }：退出时要显式收口，而不是让进程带着未落盘的会话消失
let shutDone = false;
function startServer() {
  backend = require(path.join(__dirname, "..", "server", "index.js"));
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

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "pancode",
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
    ipcMain.on("pc-win:minimize", () => { if (win && !win.isDestroyed()) win.minimize(); });
    ipcMain.on("pc-win:toggle-max", () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMaximized()) win.unmaximize(); else win.maximize();
    });
    ipcMain.on("pc-win:close", () => { if (win && !win.isDestroyed()) win.close(); });
    // ipcMain 是进程级单例：handler 也只注册一次，靠闭包动态读模块变量 win
    ipcMain.handle("pc-win:is-max", () => !!(win && !win.isDestroyed() && win.isMaximized()));
  }
  const pushMax = () => {
    if (win && !win.isDestroyed()) win.webContents.send("pc-win:max", win.isMaximized());
  };
  win.on("maximize", pushMax);
  win.on("unmaximize", pushMax);
  win.once("ready-to-show", () => {
    if (!win || win.isDestroyed()) return;
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
  win.webContents.once("did-finish-load", () => console.log("[pc] 页面加载完成"));

  /* 外部链接交给系统默认浏览器打开 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => { win = null; });

  /* 探针专用：到点直接关窗，用来验「关窗 ≠ 退出」这条承诺（scripts/_verify_desktop.js）。
     只在环境变量存在时生效，正常启动路径完全不受影响。 */
  const probeCloseMs = Number(process.env.PANCODE_PROBE_CLOSE_MS || 0);
  if (probeCloseMs > 0) {
    setTimeout(() => { try { if (win && !win.isDestroyed()) win.close(); } catch (e) {} }, probeCloseMs);
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
      await loadOrFail(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(`<body style="background:${bgFor()};color:${nativeTheme.shouldUseDarkColors ? "#ccc" : "#333"};font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0"><div><h3>pancode 后端启动失败</h3><p>${e.message}</p></div></body>`),
        "错误页"
      );
    }
  }
}

/* ---------- 托盘：窗口关掉后端继续跑（用户的决定：派出去的活不能因为关窗就死） ---------- */

/* 托盘图标用 png 再缩到 16px：直接喂 ico 在部分 Windows 主题下会拿到空图，托盘静默消失 */
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon-1024.png"));
  if (img.isEmpty()) return img;
  return img.resize({ width: 16, height: 16 });
}

function showWindow() {
  if (quitting) return;                 // 正在退出时不复活窗口，否则退出流程会被一张新窗口拖住
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  createWindow();
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: taskWatch.trayStatusLine(lastRows), enabled: false },
    { type: "separator" },
    { label: "打开 pancode 窗口", click: showWindow },
    { label: "退出 pancode（终止所有任务）", click: () => quitWithTasks() },
  ]);
}

function refreshTray() {
  if (!tray || !trayOk) return;
  try {
    tray.setToolTip("pancode — " + taskWatch.trayStatusLine(lastRows));
    tray.setContextMenu(trayMenu());
  } catch (e) { /* 托盘刷新失败不影响后端 */ }
}

/* 「退出并终止所有任务」：还有任务在跑时先确认，别让人一键把干到一半的活悄悄掐了 */
function quitWithTasks() {
  const n = taskWatch.countRunning(lastRows);
  if (n > 0) {
    const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
      type: "warning",
      buttons: ["仍要退出", "继续等它跑完"],
      defaultId: 1,
      cancelId: 1,
      message: "还有 " + n + " 个任务在跑",
      detail: "退出会中断这些任务，并终止后端与它起的全部子进程。",
    });
    if (choice !== 0) return;
  }
  quitting = true;
  app.quit();
}

/* 轮询任务表：托盘那行要说真话，收口那一刻要弹通知。
   有活时 3s，没事时 15s——窗口关了也得知道定时器（自动化）跑完了。 */
function pollTasks() {
  const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/tasks", timeout: 2000 }, (res) => {
    let buf = "";
    res.on("data", (c) => (buf += c));
    res.on("end", () => {
      let rows = [];
      try { rows = (JSON.parse(buf || "{}").tasks) || []; } catch (e) {}
      const settled = taskWatch.justSettled(lastRows, rows);
      lastRows = rows;
      refreshTray();
      for (const r of settled) {
        if (!Notification.isSupported()) break;
        const t = taskWatch.notifyText(r);
        new Notification({ title: t.title, body: t.body, silent: false }).show();
      }
      scheduleNext(taskWatch.countRunning(rows) ? 3000 : 15000);
    });
  });
  req.on("error", () => scheduleNext(8000));           // 后端还没起来 / 正在重启，稍后再试
  req.on("timeout", () => { req.destroy(); scheduleNext(8000); });
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
  } catch (e) {
    trayOk = false;   // 无托盘环境（精简 Linux / 远程桌面）：退回"关窗即退出"，不能留个关不掉的后台
    console.error("[electron] 托盘创建失败，关闭窗口将同时退出应用：", e.message);
  }
}

app.whenReady().then(() => {
  /* 单实例：托盘驻留后用户很可能再点一次桌面图标。不加这把锁，第二个实例会在同端口
     再起一个后端（EADDRINUSE），或直接出现两份互相看不见的工作状态。 */
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on("second-instance", () => { showWindow(); });

  /* 打包态：server 的所有数据/配置都写入可写目录（asar 只读，__dirname 落在 app.asar 内会 EPERM 崩主进程）。
     由桌面端注入 PANCODE_DATA_DIR = userData；开发态不注入，保持项目根（config.js 兜底到 __dirname 上级）。 */
  if (app.isPackaged) {
    process.env.PANCODE_DATA_DIR = app.getPath("userData");
  }
  startServer();
  createWindow();
  createTray();
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
    try { backend.shutdown("electron-quit"); } catch (err) {}
    setTimeout(() => app.quit(), 1200);   // shutdown 内部 3s 兜底退出，这里先让事件循环收尾
  }
});
