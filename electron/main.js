/* ============================================================
   pancode 桌面版入口（Electron 主进程）
   原理：和 VS Code 一样 —— 同一进程内拉起 Node 后端，
   再用 Chromium 窗口加载本地页面，网页秒变桌面应用。
   ============================================================ */
"use strict";
const { app, BrowserWindow, shell } = require("electron");
const http = require("http");
const path = require("path");

/* 桌面版默认独立端口，避免与网页版(8766)冲突 */
const PORT = Number(process.env.PORT || 8767);
process.env.PORT = String(PORT);

/* 虚拟机/远程桌面等无独立 GPU 环境下回退软件渲染，避免 GPU 进程崩溃 */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");

let win = null;

/* 在 Electron 主进程内直接拉起后端（同进程，无需额外 node） */
function startServer() {
  require(path.join(__dirname, "..", "server", "index.js"));
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
    backgroundColor: "#1e1e1e",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  /* 外部链接交给系统默认浏览器打开 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => { win = null; });

  try {
    await waitForServer();
    await win.loadURL(`http://127.0.0.1:${PORT}/`);
  } catch (e) {
    await win.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(`<body style="background:#1e1e1e;color:#ccc;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0"><div><h3>pancode 后端启动失败</h3><p>${e.message}</p></div></body>`)
    );
  }
}

app.whenReady().then(() => {
  startServer();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
