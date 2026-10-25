"use strict";
/* ============================================================
   pancode · VS Code 扩展（W24 脚手架）
   ------------------------------------------------------------
   做一件事：命令面板执行 "pancode: 打开工作台" →
     1) 探测本地服务（默认 127.0.0.1:8766，可配 pancode.port；8767 桌面版也会试）
     2) 没起 → 在集成终端里 npm start（目录取 pancode.serverDir / 插件自带仓库 / 工作区），
        轮询健康检查直到就绪（上限 60s）
     3) 起来后开一个 Webview 面板 iframe 加载 pancode 界面

   鉴权说明：pancode 前端自带注册/登录，Webview 里直接走它的登录流程；
   服务只绑 127.0.0.1，凭据不出本机。

   本地开发：仓库根 ide/vscode/ 下 F5（Extension Development Host），
   或 `npm run package`（需 vsce）打包 .vsix 后 `code --install-extension pancode-vscode-0.1.0.vsix`。
   ============================================================ */
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

const BOOT_TIMEOUT_MS = 60000;

function candidateServerDirs() {
  const cfgDir = String(vscode.workspace.getConfiguration("pancode").get("serverDir") || "");
  const out = [];
  if (cfgDir) out.push(cfgDir);
  // 插件目录往上找仓库根（开发态直接 F5 时生效）
  out.push(path.join(__dirname, "..", ".."));
  const wf = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (wf) out.push(wf.uri.fsPath);
  return out.filter((d) => {
    try { return fs.existsSync(path.join(d, "package.json")) && fs.existsSync(path.join(d, "server")); } catch (e) { return false; }
  });
}

async function healthy(port) {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/api/health", { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch (e) { return false; }
}

async function findLivePort(cfgPort) {
  if (await healthy(cfgPort)) return cfgPort;
  if (cfgPort !== 8767 && await healthy(8767)) return 8767;   // 桌面版内置端口
  return null;
}

function activate(context) {
  const disposable = vscode.commands.registerCommand("pancode.open", async () => {
    const cfgPort = Number(vscode.workspace.getConfiguration("pancode").get("port")) || 8766;
    let port = await findLivePort(cfgPort);

    if (!port) {
      const dirs = candidateServerDirs();
      if (!dirs.length) {
        vscode.window.showErrorMessage("pancode：没找到服务目录。请在设置里填 pancode.serverDir（pancode 仓库根）。");
        return;
      }
      const term = vscode.window.createTerminal({ name: "pancode server" });
      term.show(true);
      term.sendText("cd \"" + dirs[0] + "\" && npm start");
      vscode.window.showInformationMessage("pancode：正在启动服务（npm start）…");
      const startedAt = Date.now();
      while (Date.now() - startedAt < BOOT_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 1200));
        port = await findLivePort(cfgPort);
        if (port) break;
      }
    }

    if (!port) {
      vscode.window.showErrorMessage("pancode：服务 60 秒内没就绪。看一下 pancode server 终端里的报错。");
      return;
    }

    const url = "http://127.0.0.1:" + port + "/";
    const panel = vscode.window.createWebviewPanel("pancode", "pancode", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.iconPath = vscode.Uri.file(path.join(__dirname, "icon.png"));
    panel.webview.html = [
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\">",
      "<style>html,body{margin:0;height:100%;background:#1e1e1e}iframe{border:0;width:100%;height:100vh;display:block}</style>",
      "</head><body><iframe src=\"" + url + "\" allow=\"clipboard-read; clipboard-write\"></iframe></body></html>",
    ].join("");
    panel.webview.onDidReceiveMessage(() => {});   // 预留：后续把命令回传接进来
  });
  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = { activate, deactivate };
