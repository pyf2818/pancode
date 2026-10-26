# pancode

> [English](README.md) | 中文

> 本地优先的 **AI 编程工作台** —— 可写编辑器真实读写磁盘、终端真实执行命令、Agent 通过**真实 LLM 工具调用循环**自主完成编程任务。不是演示玩具。

**让 AI 成为你的编程伙伴：真实、高效、可控、且越用越懂你。**

---

## 📌 关于 pancode

pancode 是一套从运行时到工作台均为自主实现的本地优先 AI 编程系统。它的核心是一个自研的 Agent 运行时：以 ReAct 循环驱动「思考 → 调工具 → 看结果 → 再思考」，在单一进程里同时承载 HTTP/WebSocket 网关、文件系统协议、命令执行、上下文压缩、记忆/进化与多智能体编排；前端则是一套采用 Monaco 作为编辑内核、全 SVG 图标、深浅主题一致的浏览器工作台；桌面端通过 Electron 把后端与工作区一并打包为安装程序，打开即用、无需登录。

整个项目不依赖任何现成 Agent 框架——安全模型、工具契约、补丁审阅、上下文预算、编排调度、记忆沉淀全部是自主设计与实现。编辑器选用 Monaco 仅作为交互内核，与 Agent 运行时、后端服务是并列的组件关系，而非「建立在某个编辑器之上」的封装层。

---

## ✨ 为什么是 pancode（世界一流特性矩阵）

对照 Cursor / Windsurf / Cline / Aider / Copilot 等一流产品，pancode 把「成熟产品的可复制工程模式」几乎全部落地，并在**本地优先**前提下做到开箱即用。

| 维度 | 能力 |
| --- | --- |
| **功能** | 真实 LLM 工具循环（ReAct）、Plan Mode 规划/执行分离、Aider 式 search/replace 补丁 + 逐 hunk 审阅、LSP 实时诊断、MCP 外部工具扩展、多智能体编排、目标驱动（Goal）+ 工作流模板、完整 Git 基线/Git 还原 |
| **便捷人性化** | 命令面板（Ctrl/⌘+Shift+P）、首次引导、深浅主题、中英 i18n、免登录（本机自动身份，打开即用）、会话持久化与按会话隔离、多会话网格视图、轮次折叠收纳、聊天历史复用/复制、模式秒切（Ctrl/⌘+.）、上下文占用实时条、审批流（120s 超时 + 记住此操作） |
| **美观** | 统一 SVG 图标体系、双窗口 VS Code 风格布局、实时预览面板、启动 splash、结构化弹窗与 toast、深浅主题一致 |
| **智能** | 仓库地图（Repo Map）、语义代码索引（向量/BM25 + 实时增量）、@file/@folder 引用注入、上下文预算 + 自动压缩、错误回灌自纠、智能上下文检索 |
| **用户数据** | 结构化长期记忆（偏好/经验/约定/反例）、自动沉淀与记忆归纳、灵魂（价值观/边界/原则）演进、进化阶段与路线、Skills 市场、会话级结算沉淀 |
| **一站式** | 编辑器 + AI 对话 + 集成终端 + 源代码管理 + 实时预览 + 技能市场 + 进化树 + 会话管理，全部聚合同一工作台；桌面版（Electron）可打包为安装程序 |

---

## 🤖 智能编程内核

### 真实 LLM 工具循环（ReAct）
标准「思考 → 调工具 → 看结果 → 再思考」循环，直到任务完成。完整工具集：

`list_files` · `read_file` · `write_file` · `apply_edit` · `delete_file` · `search_code` · `run_command` · `repo_map` · `search_symbol` · `search_memory` · `get_diagnostics` · `undo` · `create_skill` · `create_plan` / `update_plan` · `list_templates` / `instantiate_template` / `save_template` / `remove_template` · `set_goal` / `goal_status` · `save_session_memory` · `agent`

### Plan Mode（规划/执行分离）
开启后 Agent 仅可读 / 检索 / 规划，**禁止**任何写文件、执行命令或调用外部 MCP 工具，直到你审阅计划并切回执行模式。这是行业公认的安全边界（Cursor / Cline / Windsurf 同范式）。

### 可靠编辑：补丁 + 逐 hunk 审阅 + 撤销
- 编辑以 **Aider 式 search/replace 文本块**为单位，比整文件覆盖更精准、更安全。
- 改动先进入**审阅面板**，你在 diff 视图中逐文件 / 逐片段（hunk）**接受 / 拒绝**后才落盘。
- 每次改盘前自动记录检查点，`undo` 工具可**单步回滚**（后进先出）。

### LSP 实时诊断
后端桥接语言服务器（stdio JSON-RPC），把编译 / 类型 / 语法错误实时呈现，并暴露 `get_diagnostics` 工具让 Agent **据此自我修正**。

### MCP 外部工具扩展
零依赖 stdio JSON-RPC 客户端，接入本地 / 第三方工具服务器（文件系统、数据库、API 网关…）。server 暴露的工具自动注册为 `mcp__<server>__<tool>` 提供给 Agent；Plan Mode 下自动禁用。在「Agent 设置 → MCP」中可视化增删与连接状态管理。

### 多智能体编排
`agent` 工具派发一个聚焦子智能体，在同一工作区内读 / 搜 / 写 / 改 / 运行命令完成子任务并返回中文汇报。编排以有向无环图呈现：**竖向泳道**表达层级先后，节点间贝塞尔连线刻画依赖，子任务输出默认展开；最终结论以独立**结论卡**（带边框与「结论」角标）与思考链路拉开量级，并提供**复制 / 重新生成 / 分支**三个常用操作。串行派发 + 轮数上限防失控，真实改动工作区并刷新编辑器与索引。

---

## 🧠 越用越懂你（记忆 · 进化 · 技能）

- **结构化长期记忆**：按类型（偏好 / 经验 / 约定 / 反例）存储，从你的纠正中自动分类沉淀，并支持记忆归纳防膨胀；`search_memory` 供 Agent 参考历史经验。
- **灵魂演进**：任务完成后提议微调 Agent 的价值观 / 边界 / 原则（待你确认才生效）。
- **进化系统**：基于沉淀计算阶段与 XP，并反哺 Agent 行为偏好（工匠重质量、学者重文档、伙伴重默契）。
- **Skills 市场**：把一类问题的解决方案沉淀为可复用模板，按触发词自动匹配注入。
- **会话结算**：`save_session_memory` 把本次有效决策 / 经验教训 / 被拒操作结构化固化为长期资产。

---

## 🧭 双窗口模式

| 窗口 | 用途 |
| --- | --- |
| **Editor Window** | VS Code 风格编辑器：文件树 CRUD、可写编辑器（Ctrl+S 保存）、全文搜索、源代码管理、集成终端、AI 侧栏、实时预览（编辑与预览**双向滚动同步**） |
| **Agents Window** | 对话工作台：AI 思考流、工具调用卡片、实时终端、改动文件 Diff 报告、任务计划、多智能体编排图、多会话网格视图 |

两个窗口自由切换，对话 / 终端 / 状态完全同步。

---

## 🚀 快速开始

```bash
npm install
npm start            # 网页版：http://localhost:8766
```

要求 **Node.js ≥ 24**（`agent-browser@0.39` 要求 ≥ 24；测试链的 vitest 5 要求 ≥ 22.12）。

### 桌面版（Electron）

```bash
# 安装 Electron（国内建议走镜像）
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install

npm run desktop      # 启动桌面窗口（内置后端，独立端口 8767）
npm run dist         # 打包 Windows 安装程序（NSIS，可自选安装目录 → release/）
```

### 配置模型（真实 LLM 引擎）

点击右上角「模型设置」，填入任意 **OpenAI 兼容 API**（OpenAI / DeepSeek / Moonshot / 通义 / Ollama / vLLM…），Agent 立即获得完整工具集。更换模型时上下文窗口会按 `model-presets.js` 的 26 条预设自动带出，无需手填。

**数据边界：** 应用是本地优先的（文件、对话、记忆都留在本机 `.pancode`），但接远程模型时，提示词、被选中的代码、工具结果与文件片段**会发送给你配置的服务商**；API Key 只存本地，不会回显到界面。代码不能出机器时，请把 base URL 指向本机运行时（Ollama / vLLM）。

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1 \
OPENAI_API_KEY=sk-xxx \
OPENAI_MODEL=deepseek-chat \
npm start
```

不配置 Key 时自动启用**演示引擎**，可开箱体验完整闭环（读代码 → 编辑 → 跑测试真实失败 → 自主修复 → 复测通过 → Diff 报告）。

---

## 🗂️ 项目结构

```
pancode/
├── server/                      # 后端：单进程 Node.js（HTTP + WebSocket + 文件系统 + Agent 运行时）
│   ├── index.js                 # 入口：HTTP/WS 网关、鉴权、路由装配、hello 下发 ctxLimit
│   ├── agent-base.js            # Agent 共享原语：思考流 / 消息流 / 工具卡片
│   ├── agent-llm.js             # 真实 LLM 引擎：ReAct 工具循环 + 仓库地图 + 记忆/进化
│   ├── agent-demo.js            # 离线演示引擎（无 Key 跑完整闭环）
│   ├── orchestrator.js          # 多智能体编排：DAG、分层、依赖、工作区隔离
│   ├── context-retriever.js     # 智能上下文检索（预算 + 自动压缩）
│   ├── security.js              # 命令与提示注入安全层（六层归一/宏展开/沙箱）
│   ├── safe-write.js            # 抗杀软/并发的落盘队列（指数退避，永不抛错）
│   ├── sandbox.js               # 命令沙箱：policy（默认）/ docker（硬隔离）/ wsl（软隔离）
│   ├── net-guard.js             # 出网域名黑白名单 + 连接期 IP 钉住
│   ├── memory-store.js          # 结构化长期记忆（偏好/经验/约定/反例）
│   ├── soul-store.js / evolution.js / progression*.js  # 灵魂/进化/阶段
│   ├── skill-store.js / builtin-skills/  # Skills 市场 + 内置技能包
│   ├── code-index.js / repo-map.js / code-graph.js  # 语义索引 / 仓库地图 / 代码图
│   ├── lsp-bridge.js            # LSP 诊断桥（stdio JSON-RPC 代理）
│   ├── mcp.js                   # 零依赖 MCP 客户端
│   ├── model-presets.js         # 26 条模型上下文窗口预设 + /api/llm/presets
│   ├── scheduler.js / cron-lite.js  # 任务调度（5 字段 cron + 快照隔离子代理）
│   ├── computer/                # 计算机使用：浏览器 / UIA / 视觉 / 截图断言
│   ├── tools/                   # 23+ 工具实现（文件/补丁/终端/Git/LSP…）
│   ├── config.js / files.js / git.js / processes.js / auth.js / cost.js / logger.js …
│   └── *.test.js                # 80+ 后端单测（P0–P5 分级，vitest）
├── public/                      # 前端：Chromium 渲染，Monaco 编辑内核，全 SVG 图标
│   ├── index.html               # 双窗口布局骨架（Editor / Agents 切换）
│   ├── app.js                   # 主控制器：对话/编排/预览/网格视图/会话
│   ├── store.js                 # 前端状态（ctxLimit、orchestration 作用域…）
│   ├── i18n.js                  # 中英双语（中文默认，切换即生效）
│   ├── icons.js                 # 统一 SVG 图标体系（BADGES 类型徽章）
│   ├── styles.css               # 设计 token / 深浅主题 / 编排 overlay / 结论卡
│   └── js/
│       ├── workbench.js         # 编辑器工作台（Monaco + 文件树 + 预览滚动同步）
│       ├── terminal-mod.js      # 集成终端
│       ├── md-worker.js         # Markdown 渲染 Worker（65ms 节流 + 快照校验）
│       ├── visualizer.js        # 多智能体编排图可视化（竖向泳道 + 贝塞尔连线）
│       ├── trace.js             # Agent trace 面板（发出的 / 水位 / ≈N 轮）
│       ├── skill-market.js / automations.js / global-settings.js / gear-menu.js
│       ├── lsp-client.js / diagnostics.js / dep-graph.js
│       ├── assets-center.js / commit.js / processes.js / patch-review.js
│       ├── onboard.js / cmdk.js / evolution-codex.js / utils.js / core.js
│       └── settings.js
├── electron/                    # 桌面壳：Electron-builder（NSIS）打包
│   ├── main.js                  # 主进程：窗口 / 协议 / 内置后端拉起
│   ├── preload.js               # 安全桥接
│   ├── close-policy.js          # 关闭策略（避免误关丢失会话）
│   └── task-watch.js            # 任务看门狗
├── scripts/                     # 构建 / 验证 / 探针（50+ 验收脚本）
│   ├── dist.js                  # 打包（ELECTRON_MIRROR + 清代理，避开 502）
│   ├── _verify_*.js             # 链路探针（渲染/编排/预览/网格/i18n/压缩…）
│   └── _smoke_ui.js / _verify_pkg.js
├── docs/                        # 设计研究 / 优化计划 / 差距分析
├── research/                    # 竞品架构与基线报告
├── test/                        # 端到端 + 单元（P0–P5 分级）
├── tests/                       # e2e-workspace 烟测
├── ide/vscode/                  # VS Code 扩展脚手架
├── assets/                      # 图标（icon.svg / icon-1024.png / icon.ico「清雅薄荷」）
├── pancode.config.json          # 配置形态样例
├── package.json / tsconfig.json
├── README.md / README.zh-CN.md
└── CHANGELOG.md
```

---

## ⚙️ 工程化与真实性（第一性原理）

1. **文件是唯一真相** —— 所有内容以磁盘 `workspace/` 为准；编辑器可写（Ctrl+S）、文件树支持新建 / 重命名 / 删除；外部改动通过 `fs.watch` 实时同步进 UI；路径全部经防逃逸校验。
2. **最短反馈回路** —— 终端命令真实 spawn 执行（带超时与输出上限保护，Ctrl+C 可中断）；改动基于 **Git HEAD 基线**计算（非 Git 目录自动降级为启动快照）；一键还原 = `git checkout` + `git clean`。
3. **可插拔智能** —— LLM 层只依赖 OpenAI 兼容协议，任何模型即插即用；引擎异常自动分类提示（配额 / 网络 / Key / 模型），无 Key 不阻塞体验。
4. **安全模型（本地优先）** —— Agent 能写盘 / 执行命令，因此以「防 Agent 误伤用户、防本机能力被滥用」为命门：权限三档（ask / semi / auto）+ allow / deny 规则、命令安全沙箱、危险操作二次确认、审计日志、API 鉴权闸门（NO_AUTH 白名单 + 401）。

---

## 🔧 配置

### pancode.config.json（节选）
```json
{
  "workspace": "你的工作区路径",
  "recentWorkspaces": ["..."],
  "llm": { "baseURL": "...", "model": "..." },
  "permissions": { "mode": "ask", "allow": [], "deny": [] },
  "persona": { "active": "default", "systemPrompt": "" },
  "rules": { "enabled": true },
  "context": { "budgetTokens": 1000000, "autoCompact": true },
  "memory": { "enabled": true },
  "planMode": false,
  "lsp": { "enabled": true, "servers": {} },
  "mcp": { "servers": [] }
}
```

### 环境变量
```bash
PORT=8766                  # 服务端口
HOST=127.0.0.1             # 监听地址
AUTH_TOKEN=your-token      # 认证令牌
CURSORWEB_WORKSPACE=/path  # 工作目录
OPENAI_BASE_URL=url        # LLM API 地址
OPENAI_API_KEY=key         # LLM API 密钥
OPENAI_MODEL=model         # LLM 模型名称
```

> 也可在「模型设置」「Agent 设置」图形界面中完成上述大部分配置，保存后立即广播到所有窗口。

---

## 🧪 测试

```bash
npm run test:unit       # vitest 单测（1300+ 项 / 72 个文件，含沙箱/Anthropic 适配/net-guard/SSE 解析）
npm run test:verify     # 55 个真探针（跑在活服务器上）：渲染 / 仓库地图 / 工具 / Agent 流 / 并行 / 隔离 / 浏览器…
node scripts/smoke-test.js        # 端到端：启动服务 → Agent 闭环 → 断言失败/修复/通过/Diff → 还原
npm run test:nightly    # 真实模型夜间回归（read-echo / subagent / apply-edit / compaction）
                        # 无 Key 只打印 SKIP 并 exit 0 —— SKIP 不算通过，别把它报成"夜间回归绿了"
npm test                # 完整套件：单测 + 探针 + smoke + integration/patch/lsp/code-index
```

CI（`.github/workflows/ci.yml`）：lint → 单测 → 探针 → smoke → 文件操作，Windows 单环境先稳住链路（Node 24，与 `engines` 一致）。55 支探针里 **53 支在 runner 上跑到底**，另外 2 支打 `SKIP` —— `_verify_computer`（UIA + 屏幕截图）与 `_verify_browser`（agent-browser 驱动本机 Chrome/Edge）都要一个交互桌面会话，runner 上没有；本地 `npm run verify:all` 才跑全 55 支外加 Electron 壳那几项。跳过的只报跳过，不算通过。`nightly.yml` 每晚用真实 LLM 跑回归（需配 `NIGHTLY_LLM_KEY` secret，未配则优雅跳过并打 `RESULT: SKIP`——SKIP 不算通过）。

---

## 📚 研究与方法论

- `agentic-coding-tools-architecture-report.md` —— 对标 Cursor/Windsurf/Cline/Aider/Copilot/Zed/OpenCode/Goose/Continue 的架构技术报告（19 条可复制最佳实践 A–F）。
- `docs/agent-design-research.md` —— Phase 1 设计调研（P0/P1/P2 清单）。
- `docs/optimization-plan.md` —— 19 项优化方案（已落地）及增量增强。
- `docs/gap-analysis-2026-08-12.md` —— 代码级交叉核对，确认工程缺口基本清零，剩余硬缺口仅 fast-apply（依赖外部小模型端点）。

---

## 📜 版本

当前：**v3.7.1** —— 体验与观感收口：多会话网格视图重做（一屏更多卡片、间距收敛、点击稳定）、任务计划胶囊宽度收口（不再超过主对话区）、上下文窗口放开至模型真实上限（agnes-3.0-flash 实测 512K，`model-presets.js` 26 条预设自动带出，压缩线随窗口缩放，告别「两个问题就满」）、Agent trace 口径优化（区分「发出的」计费量与「水位」占用量并给出「≈ N 轮问答」参照）、多智能体编排可视化重做（竖向泳道 + 贝塞尔连线 + 输出默认展开 + 跨会话历史可见 + 结论卡 + 复制/重新生成/分支）、文件预览与编辑器**双向滚动同步**、全新「清雅薄荷」图标（SVG→PNG/ICO 七尺寸）。验证口径：vitest 1300+ 项 + 55 支探针 + smoke 全绿，安装包 `pancode Setup 3.7.1.exe`（Electron-builder NSIS）26/26 校验通过。

更早：**v3.0.0** —— 完成代际跃迁：Plan Mode、MCP、LSP 诊断、实时增量代码索引、逐 hunk 补丁审阅、/undo 检查点、多智能体编排、目标驱动 + 工作流模板、会话结算记忆、会话持久化与按会话隔离、命令面板、首次引导、深浅主题、中英 i18n 等。详见 `docs/` 与 `CHANGELOG.md`。

## 📄 许可证

MIT License —— 详见 [LICENSE](LICENSE) 文件。

---

**pancode** —— 真实、高效、可控，越用越懂你的 AI 编程伙伴。
