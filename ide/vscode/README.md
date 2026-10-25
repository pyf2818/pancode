# pancode · VS Code 扩展

在 VS Code 里一键打开本地 pancode AI 编程工作台（编辑器 + AI 对话 + 集成终端同屏）。

## 使用

1. 命令面板（Ctrl/Cmd+Shift+P）→ **pancode: 打开工作台**
2. 插件自动探测 `127.0.0.1:8766`（可配 `pancode.port`；桌面版内置端口 8767 也会尝试）
3. 服务没起时，自动在集成终端 `npm start` 并轮询就绪（上限 60 秒）
4. 就绪后开 Webview 面板加载 pancode 界面，登录流程与浏览器一致（服务只绑本机回环）

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `pancode.serverDir` | `""` | pancode 仓库根目录（含 package.json 与 server/）。留空按 插件仓库根 → 当前工作区 找 |
| `pancode.port` | `8766` | 服务端口 |

## 开发与打包

```bash
cd ide/vscode
npm install -g @vscode/vsce   # 一次性
vsce package                  # 产出 pancode-vscode-0.1.0.vsix
code --install-extension pancode-vscode-0.1.0.vsix
```

开发态直接在仓库根按 F5（Extension Development Host）即可试。

> 说明：这是脚手架版本（健康检查 + 自动起服 + Webview 加载），
> 命令回传（从 pancode 界面调 VS Code 命令）预留了 `onDidReceiveMessage` 通道，后续按需接。
