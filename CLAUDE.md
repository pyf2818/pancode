# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

pancode 是基于 Monaco Editor 的 Web AI 编程工作台。服务端为 Node.js + Express + WebSocket，前端为 Monaco + 原生 JS（无前端框架）。支持任意本地文件夹作为工作区，Agent 通过 OpenAI 兼容协议进行真实工具调用循环。

## 常用命令

```bash
npm install              # 安装依赖
npm start                # 启动服务（http://localhost:8766）
npm run desktop          # 启动 Electron 桌面窗口（内置后端，端口 8767）
npm run dist             # 打包 Windows 安装程序（需 electron-builder）

# 测试
npm run test:verify      # 验证富文本渲染 / 仓库地图 / 工具调用 / Agent 流程
npm run smoke            # 端到端烟测（启动 → Agent 闭环 → 断言 → 还原）
npm run test:fileops     # 文件操作测试
npm run test:integration # 集成测试
npm run test:patch       # 补丁功能测试
npm run test:lsp         # LSP 诊断测试
npm run test:code-index  # 代码索引测试
npm test                 # 运行全部测试套件（首尾带 .pancode 数据根指纹，见下）
```

### 写探针的硬规矩（新增 scripts/*.js 时必读）

1. 探针第一行 `require("./_sandbox").create({ tag: "…" })`，且必须排在任何 `require("../server/…")` 之前——
   `config` / `dotenv` / `code-index` 在模块加载时就把数据根固化了，晚设等于没设
   （`_sandbox` 会直接抛错，不跟你客气）。
2. 带 `AGENT_FAST=1` 或 `CURSORWEB_ENGINE=demo` 却没设 `PANCODE_DATA_DIR` 的服务端**拒启**
   （`server/config.js` 里的「探针护栏」）。产品路径一个标记都不设，所以这条只咬探针。
3. 为什么值得这么麻烦：真实数据根被探针写花过——`users.json` 里攒了 107 个探针账号、
   会话 TTL 清理真删过开发者的对话、`.pancode/code-index` 落过 21 个测试分片。
   `test/probe-sandbox.test.js` 守第 1/2 条，`scripts/_verify_dataroot.js` 在链尾实测"这一串探针有没有动真实盘"。
4. 用 Playwright 验界面时，断言只能读**计算后的真实状态**，三条实测踩过的坑：
   - `transition` 中的属性（opacity / width / color）同步读 `getComputedStyle` 只会读到过渡起点，
     改完 class 必须等一个过渡周期再断言，否则"聚焦变亮"这种永远判不过；
   - `addInitScript` 在**每个 frame** 里都会跑一遍，应用里的沙箱 iframe 读 `localStorage` 直接抛
     SecurityError，不 try/catch 就会把它记成产品报错；
   - 渲染端的接线可以造假依赖来测：先注入假的 `window.pancodeWin`（把调用记进 spy 数组）再断言，
     这样浏览器探针能覆盖"preload → 页面"这一半，主进程那一半交给 `_verify_desktop.js` 真起 Electron。
   - `public/app.js` 的 `state` 是**顶层 `const`**（全局词法绑定），`window.state` 恒为 undefined：
     拿它当"hello 到没到"的判据会永远等不到（实测烧掉一次 20s 超时，还差点误判成服务端卡住）。
     页面里要读它得写 `typeof state === "undefined" ? null : state`。

## 架构概览

### 服务端 (`server/`)

单入口 `server/index.js` 启动 Express HTTP + WebSocket 网关，所有模块通过 `mountWorkspace()` 按工作区实例化。

**分层架构（自底向上）：**

- **config.js** — 配置中心：`env` > `pancode.config.json` > `DEFAULTS` 三层合并。LLM 密钥运行时存在内存 + `.env`，不写入配置文件。
- **files.js** — 文件层：`safePath()` 防目录逃逸，完整 CRUD，二进制文件检测（扩展名 + 内容嗅探），`fs.watch` 监听外部变更。
- **git.js** — Git 层：仅当工作区自身是 Git 仓库根时才启用（避免子目录误读父仓库状态）。Diff 基线 = `HEAD`，不可用时降级为启动快照。
- **terminal.js** — 终端层：真实 spawn 执行命令，支持多标签、超时、Ctrl+C 中断。
- **llm.js** — LLM 客户端：原生 fetch，SSE 流式解析（content + reasoning + tool_calls 聚合），429 自动指数退避重试。
- **agent-llm.js** — 真实 LLM 引擎：标准 ReAct 循环（思考 → 调工具 → 看结果 → 再思考）。定义了 14 个 OpenAI 兼容工具（`list_files` / `read_file` / `write_file` / `search_code` / `run_command` / `repo_map` / `search_symbol` 等）。
- **agent-demo.js** — 演示引擎：无 API Key 时自动启用，可完整体验闭环（读代码 → 编辑 → 跑测试 → 修复 → Diff）。
- **agent-base.js** — Agent 共享原语（思考流 / 消息流 / 工具卡片）。

**Phase 2 增强模块：**

- **memory-store.js** / **context-retriever.js** — 结构化长期记忆 + 智能上下文注入
- **soul-store.js** — AI 人格（name / vibe / values / boundaries / principles），支持微调提案
- **skill-store.js** — Skill 系统：一类问题的解决方案沉淀为可复用模板
- **evolution.js** — 自我进化：任务完成后自动提取经验教训
- **plan-store.js** / **workflow-store.js** — 任务计划 / 工作流
- **repo-map.js** — 仓库地图：按语言正则提取符号索引，支持 JS/TS/Python/Go/Java/Rust
- **lsp-bridge.js** — 真实 LSP 桥接：按需 spawn 语言服务器，诊断注入 Agent 上下文
- **code-index.js** — 轻量代码向量索引（BM25 词法兜底，可插拔 embedding）
- **mcp.js** — MCP（Model Context Protocol）外部工具服务器管理器
- **auth.js** — 用户认证（注册/登录/token 验证），服务端 WS 和 REST 敏感端点统一鉴权
- **patch.js** — 补丁审阅引擎：Agent 修改先存为补丁，用户逐文件接受/拒绝

**鉴权体系：**

- `NO_AUTH` 白名单端点（health / version / login / register / 代码索引等）无需鉴权
- 业务端点要求 `x-user-token`（登录后下发）
- 本地 `bootstrap` 端点仅限 127.0.0.1 领取 AUTH_TOKEN
- CORS 收紧：仅允许本机回环访问

### 前端 (`public/`)

- **app.js** — 主应用逻辑（约 2000 行），双窗口模式（Editor / Agents），对话历史持久化，富文本渲染（完整 Markdown + 代码块复制），Monaco 编辑器集成（可写、脏标记、Ctrl+S 保存）
- **main.js** — Electron 主进程入口
- **store.js** — 前端状态集中化
- **styles.css** — 响应式布局、富文本样式
- **i18n.js** — 中英文切换

**关键前端架构：** `chatStream` 共享 DOM 节点，两个窗口（Editor Window + Agents Window）通过同一个 `chatStream` 搬运对话内容，消息 `msg.start` 在首次出现位置锚定 `answerBlock`。

### Electron (`electron/`)

桌面版壳，内置后端（独立端口 8767），Windows NSIS 安装包。

### 工作区 (`workspace/`)

Agent 的工作目录（示例 todo-app 项目）。

### 配置与持久化

- `pancode.config.json` — 运行时配置（端口、工作区、LLM、权限、人格等）
- `.pancode/` — 运行时数据目录（记忆 / 规则 / Skill / 灵魂 / 进度，按工作区 MD5 哈希分文件）
- `.env` — 敏感配置（API Key 等），已 .gitignore

## 关键设计原则

1. **文件是唯一真相** — 所有内容以磁盘 `workspace/` 为准，编辑器可写，外部改动通过 `fs.watch` 实时同步
2. **最短反馈回路** — 终端命令真实 spawn 执行，改动基于 Git HEAD 基线计算，一键还原 = `git checkout` + `git clean`
3. **可插拔智能** — LLM 层只依赖 OpenAI 兼容协议，无 Key 时演示引擎保底
4. **路径安全** — 所有文件操作经 `safePath()` 防逃逸校验，二进制文件检测防止误读
5. **服务端权威** — WebSocket 和 REST 统一鉴权，敏感操作（写文件/执行命令）需用户批准
