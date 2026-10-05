/* ============================================================
   pancode 桌面端预加载（contextIsolation 下渲染进程唯一的出口）
   窗口是无边框的（frame:false），最小化/最大化/关闭必须由这里递出去——
   渲染进程拿不到 remote，也不该拿到 nodeIntegration。
   ============================================================ */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pancodeWin", {
  minimize: () => ipcRenderer.send("pc-win:minimize"),
  toggleMax: () => ipcRenderer.send("pc-win:toggle-max"),
  close: () => ipcRenderer.send("pc-win:close"),
  isMaximized: () => ipcRenderer.invoke("pc-win:is-max"),
  /* 主进程在最大化/还原时推一把，渲染端据此换绿色按钮的图标
     （不接住的话绿灯永远画"最大化"，用户点了还原也看不出来）。 */
  onMaxChange: (fn) => {
    const wrapped = (_e, max) => { try { fn(!!max); } catch (e) {} };
    ipcRenderer.on("pc-win:max", wrapped);
    return () => ipcRenderer.removeListener("pc-win:max", wrapped);
  },
});

contextBridge.exposeInMainWorld("pancodeDesktop", { platform: process.platform });
