# pancode

> 本地优先的 **AI 编程工作台** —— 基于 Monaco（VS Code 同款内核），编辑器真实读写磁盘、终端真实执行命令、Agent 通过**真实 LLM 工具调用循环**自主编程。不是演示玩具。

**让 AI 成为你的编程伙伴：真实、高效、可控、且越用越懂你。**

---

## ✨ 为什么是 pancode（世界一流特性矩阵）

对照 Cursor / Windsurf / Cline / Aider / Copilot 等一流产品，pancode 把"成熟产品的可复制工程模式"几乎全部落地，并在**本地优先**前提下做到开箱即用。

| 维度 | 能力 |
| --- | --- |
| **功能** | 真实 LLM 工具循环（ReAct）、Plan Mode 规划/执行分离、Aider 式 search/replace 补丁 + 逐 hunk 审阅、LSP 实时诊断、MCP 外部工具扩展、多智能体编排、目标驱动（Goal）+ 工作流模板、完整 Git 基线/Git 还原 |
| **便捷人性化** | 命令面板（Ctrl/⌘+Shift+P）、首次引导、深浅主题、中英 i18n、登录注册、会话持久化与按会话隔离、聊天历史复用/复制、模式秒切（Ctrl/⌘+.）、上下文占用实时条、审批流（120s 超时 + 记住此操作） |
| **美观** | 统一 SVG 图标体系、双窗口 VS Code 风格布局、实时预览面板、启动 splash、结构化弹窗与 toast、深浅主题一致 |
| **智能** | 仓库地图（Repo Map）、语义代码索引（向量/BM25 + 实时增量）、@file/@folder 引用注入、上下文预算 + 自动压缩、错误回灌自纠、智能上下文检索 |
| **用户数据** | 结构化长期记忆（偏好/经验/约定/反例）、自动沉淀与记忆归纳、灵魂（价值观/边界/原则）演进、进化阶段与路线、Skills 市场、会话级结算沉淀 |
| **一站式** | 编辑器 + AI 对话 + 集成终端 + 源代码管理 + 实时预览 + 技能市场 + 进化树 + 会话管理，全部聚合同一工作台；桌面版（Electron）可打包为安装程序 |

---

## 🚀 快速开始

```bash
npm install
npm start            # 网页版：http://localhost:8766
```

要求 Node.js ≥ 18。编辑器内核经 CDN/本地 vendor 加载（需联网或已 vendored）。

### 桌面版（Electron）

```bash
# 安装 Electron（国内建议走镜像）
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install

npm run desktop      # 启动桌面窗口（内置后端，独立端口 8767）
npm run dist         # 打包 Windows 安装程序（NSIS，可自选安装目录 → release/）
```

### 配置模型（真实 LLM 引擎）

点击右上角「模型设置」，填入任意 **OpenAI 兼容 API**（OpenAI / DeepSeek / Moonshot / 通义 / Ollama / vLLM…），Agent 立即获得完整工具集。

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1 \
OPENAI_API_KEY=sk-xxx \
OPENAI_MODEL=deepseek-chat \
npm start
```

不配置 Key 时自动启用**演示引擎**，可开箱体验完整闭环（读代码 → 编辑 → 跑测试真实失败 → 自主修复 → 复测通过 → Diff 报告）。

---

## 🧭 双窗口模式

| 窗口 | 用途 |
| --- | --- |
| **Editor Window** | VS Code 风格编辑器：文件树 CRUD、可写编辑器（Ctrl+S 保存）、全文搜索、源代码管理、集成终端、AI 侧栏、实时预览 |
| **Agents Window** | 对话工作台：AI 思考流、工具调用卡片、实时终端、改动文件 Diff 报告、任务计划 |

两个窗口自由切换，对话 / 终端 / 状态完全同步。

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
`agent` 工具派发一个聚焦子智能体，在同一工作区内读 / 搜 / 写 / 改 / 运行命令完成子任务并返回中文汇报（串行、轮数上限防失控，真实改动工作区并刷新编辑器与索引）。

---

## 🧠 越用越懂你（记忆 · 进化 · 技能）

- **结构化长期记忆**：按类型（偏好 / 经验 / 约定 / 反例）存储，从你的纠正中自动分类沉淀，并支持记忆归纳防膨胀；`search_memory` 供 Agent 参考历史经验。
- **灵魂演进**：任务完成后提议微调 Agent 的价值观 / 边界 / 原则（待你确认才生效）。
- **进化系统**：基于沉淀计算阶段与 XP，并反哺 Agent 行为偏好（工匠重质量、学者重文档、伙伴重默契）。
- **Skills 市场**：把一类问题的解决方案沉淀为可复用模板，按触发词自动匹配注入。
- **会话结算**：`save_session_memory` 把本次有效决策 / 经验教训 / 被拒操作结构化固化为长期资产。

---

## ⚙️ 工程化与真实性（第一性原理）

1. **文件是唯一真相** —— 所有内容以磁盘 `workspace/` 为准；编辑器可写（Ctrl+S）、文件树支持新建 / 重命名 / 删除；外部改动通过 `fs.watch` 实时同步进 UI；路径全部经防逃逸校验。
2. **最短反馈回路** —— 终端命令真实 spawn 执行（带超时与输出上限保护，Ctrl+C 可中断）；改动基于 **Git HEAD 基线**计算（非 Git 目录自动降级为启动快照）；一键还原 = `git checkout` + `git clean`。
3. **可插拔智能** —— LLM 层只依赖 OpenAI 兼容协议，任何模型即插即用；引擎异常自动分类提示（配额 / 网络 / Key / 模型），无 Key 不阻塞体验。
4. **安全模型（本地优先）** —— Agent 能写盘 / 执行命令，因此以"防 Agent 误伤用户、防本机能力被滥用"为命门：权限三档（ask / semi / auto）+ allow / deny 规则、命令安全沙箱、危险操作二次确认、审计日志、API 鉴权闸门（NO_AUTH 白名单 + 401）。

---

## 🗂️ 项目结构

```
server/
  index.js         入口：HTTP + WebSocket 网关、文件操作协议、API/版本端点、MCP/LSP 接入
  config.js        配置中心（env > pancode.config.json > 默认值）
  files.js         文件层：安全路径、CRUD、搜索、fs.watch
  git.js           Git 层：HEAD 基线 / 快照降级、状态、还原
  terminal.js      终端层：真实执行、超时、中断
  llm.js           LLM 客户端：SSE 流式 + 工具调用解析（零依赖）
  agent-base.js    Agent 共享原语（思考流 / 消息流 / 工具卡片）
  agent-llm.js     真实 LLM 引擎（ReAct 工具循环 + 仓库地图 + 多智能体 + 记忆/进化）
  patch.js         Aider 式 search/replace 补丁解析与暂存/审阅
  repo-map.js      仓库地图：符号索引、检索增强、结构概览
  code-index.js    语义代码索引（向量/BM25 + 实时增量）
  lsp-bridge.js    真实 LSP 桥接层（后端 stdio JSON-RPC 代理 + 诊断缓存）
  mcp.js           MCP 客户端与管理器（零依赖 stdio JSON-RPC）
  memory-store.js  结构化长期记忆
  soul-store.js / progression.js / evolution.js  灵魂 / 进化 / 自动提炼
  skill-store.js   Skills 市场
  plan-store.js / workflow-store.js  计划 / 工作流模板
  context-retriever.js  智能上下文检索
public/            前端（Monaco + 原生 JS，全 SVG 图标，模块化 js/）
  app.js           主应用逻辑（对话、编辑器、预览、终端、会话）
  styles.css       样式（设计 token、深浅主题、富文本、弹窗、命令面板、引导）
  i18n.js / icons.js / js/core.js / js/settings.js / js/cmdk.js / js/onboard.js / js/skill-market.js / js/evolution-codex.js / js/lsp-client.js
workspace/       Agent 的工作目录（示例项目）
scripts/         验证脚本（渲染 / 仓库地图 / 工具 / Agent 流 / patch / LSP / MCP / 多智能体 / 索引 / 会话记忆 / 增量索引…）
docs/            架构竞品研究、优化方案、缺口分析
tests/           端到端烟测
```

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
npm run test:verify     # 离线验证：渲染 / 仓库地图 / 工具 / Agent 流
node scripts/smoke-test.js        # 端到端：启动服务 → Agent 闭环 → 断言失败/修复/通过/Diff → 还原
node scripts/verify-mcp.js        # MCP 全链路（initialize→tools/list→tools/call）
node scripts/verify-multiagent.js # 多智能体编排
node scripts/verify-undo.js       # 撤销检查点
npm test                        # 完整套件（需 LLM Key 以跑 smoke）
```

---

## 📚 研究与方法论

- `agentic-coding-tools-architecture-report.md` —— 对标 Cursor/Windsurf/Cline/Aider/Copilot/Zed/OpenCode/Goose/Continue 的架构技术报告（19 条可复制最佳实践 A–F）。
- `docs/agent-design-research.md` —— Phase 1 设计调研（P0/P1/P2 清单）。
- `docs/optimization-plan.md` —— 19 项优化方案（已落地）及增量增强。
- `docs/gap-analysis-2026-08-12.md` —— 代码级交叉核对，确认工程缺口基本清零，剩余硬缺口仅 fast-apply（依赖外部小模型端点）。

---

## 📜 版本

当前：**v3.0.0** —— 在 v2.3.0 之上完成代际跃迁：Plan Mode、MCP、LSP 诊断、实时增量代码索引、逐 hunk 补丁审阅、/undo 检查点、多智能体编排、目标驱动 + 工作流模板、会话结算记忆、会话持久化与按会话隔离、命令面板、首次引导、登录注册、深浅主题、中英 i18n 等。详见 `docs/`。

## 📄 许可证

MIT License —— 详见 [LICENSE](LICENSE) 文件。

---

**pancode** —— 真实、高效、可控，越用越懂你的 AI 编程伙伴。
