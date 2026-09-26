# Pancode × WorkBuddy 对齐升级方案

> 日期：2026-09-25
> 目标：以 WorkBuddy（腾讯全场景 AI 办公工作台）为对标基准，给 Pancode 设计一套"向其对齐、可整合升级"的结构化方案。
> 方法：WorkBuddy 官方文档（Overview / Quickstart / Create-Task）+ 平台可观察架构归纳 + 本项目代码实测核对（已落地项以 grep/Read 复验，避免"自报完成"误判）。
> 基线参考：`agentic-coding-tools-architecture-report.md`（行业最佳实践 A–F）、`docs/gap-analysis-2026-08-12.md`（P0/P1/P2 落地复验）、`docs/optimization-plan.md`（19 项已落地）。

---

## 0. 调研结论：WorkBuddy 的设计理念与架构（对标基准）

### 0.1 设计理念
- **一句话任务 → 自主规划执行 → 交付可验收结果**：从"对话给建议"升级为"实际干活、交付产物"。
- **三大交互区域**：侧边栏（任务列表，按文件夹分组、可搜索）/ 对话区（任务标题栏 + 消息流 + 输入框）/ 结果区（产物、全部文件、变更、预览 四视图）。
- **三种工作模式**：`Agent`（说做就做）、`Plan`（先想后做，安全边界）、`Ask`（只聊不动）。
- **多任务并行**：可同时发起和管理多个任务。
- **本地文件操作**：读取授权的电脑文件夹，批量处理；结果可验收。

### 0.2 整体架构（从产品与实现归纳，不触及内部实现细节）
- **桌面壳 + 前后端分离**：Electron 类桌面壳，内置后端服务；前端现代组件化 + CSS 变量主题系统（light/dark 随宿主 IDE 主题自适应）。
- **Agent 引擎**：后端跑 ReAct + 工具调用循环；长任务/自动化在**隔离上下文或后台 agent** 中执行，不阻塞主进程。
- **扩展三件套**：
  - **Skills**：用户级（`~/.workbuddy/skills/`）+ 项目级（`.workbuddy/skills/`），`SKILL.md` 驱动；具备**触发式自动调用**、**导入安全审计（P0/P1/P2 风险分级）**、**市场发现（find-skills）**。
  - **MCP**：工具扩展事实标准，配置集中在 `~/.workbuddy/mcp.json`，零依赖 stdio JSON-RPC。
  - **Connectors & Experts**：Connector = 外部应用/服务/API/MCP 接入；Expert = 专家角色/方法论/工作流；两者分品类管理。
- **记忆三层**：云端画像（自动摘要）+ 跨会话检索（`conversation_search`）；用户级本地记忆（`~/.workbuddy/MEMORY.md`）；工作区级记忆（按项目）。
- **自动化**：一次性 + 周期性任务，独立调度器，未来运行不依赖当前会话。
- **可视化与产物**：内联 SVG/HTML 图表（`show_widget`）；结果以**产物卡片 + 实时预览面板**交付（`present_files`）。
- **安全与权限**：工具级批准、危险操作先说清后果、Plan 模式作安全边界、hooks 拦截、沙箱开关。

### 0.3 功能模块划分（归纳）
对话/任务管理 · Agent 引擎 · Skills · MCP/连接器/专家 · 记忆 · 自动化 · 可视化 · 产物系统 · 身份系统 · 安全权限 · 主题系统。

---

## 1. Pancode 现状基线（已具备，方案中不再重复造轮子）

> 以下均经代码复验（`gap-analysis-2026-08-12.md` + 本次 grep/Read），标记为 ✅。

| 维度 | 已落地能力 | 证据 |
|---|---|---|
| Agent 引擎 | ReAct + 23 工具，错误回灌自纠 | `agent-llm.js` `TOOLS` + `chatStream` |
| 安全边界 | 真实 Plan Mode 硬开关（后端拦截 mutating 工具） | `config.js planMode` + 后端拦截 |
| 扩展 | MCP 接入（动态注册 `mcp__*` 工具） | `mcp.js` + commit `0a448f3` |
| 上下文 | Aider 式 Repo Map + 实时增量代码索引 + `@file/@folder` 注入 | `repo-map.js`/`code-index.js`/`_resolveMentions` |
| 编辑可靠性 | search/replace 严格逐字校验 + 逐块审批 + `/undo` 检查点栈 | `patch.js` + `_undoStack` |
| 连续性 | 会话持久化 + 会话级工作态隔离（计划/终端/改动按 convId） | `C6`/`C8` |
| 权限 | 三档（ask/semi/auto）+ allow/deny 清单 + 命令黑名单 | `agmMode`/`security.js` |
| 安全地基 | 登录闸门 + NO_AUTH 白名单收紧 + CORS 环回 + 全局异常兜底 + 优雅关闭 | `index.js:141`/`:1277` |
| 前端工程 | z-index token 系统 + dark/light 双主题 + `public/js/` 15 模块拆分 | `styles.css` / `public/js/` |
| 工具工程 | `server/tools/` 按域拆 14 个工具文件 | `server/tools/*.js` |
| 编排 | 子智能体串行编排（收敛工具白名单、防递归） | `runSubAgent` |
| 闭环 | workflow/goal 目标驱动 + 会话结算沉淀记忆 + LSP diagnostics 喂 Agent | `workflow-store.js`/`save_session_memory`/`get_diagnostics` |
| 输入 | 图片粘贴/拖入附件 + 命令面板（cmdk） | `app.js` paste/drop + `cmdk.js` |

### 仍偏弱 / 真实缺口（本次实测）
- ❌ **`fast-apply` 小模型**：全仓无实现，`grep` 空（P1 遗留）。
- ❌ **`server/git.js:21/48` 仍用 `execFileSync`/`spawnSync`**：大仓库同步阻塞事件循环 → 卡顿真隐患。
- ❌ **前端仍是原生 JS（无构建步骤）**：`app.js` 虽拆模块仍 175KB，重渲染（Monaco/大消息流）在主线程。
- ❌ **无 Connectors/Experts 维度**：仅 MCP，缺"外部服务接入"与"专家角色"两类一等公民。
- ❌ **无自动化**：无一次性/周期任务调度。
- ❌ **无内联可视化**：聊天区不能渲染架构图/数据图。
- ❌ **产物系统较基础**：结果区缺"产物卡片 + 实时预览面板"的办公级体验。
- ❌ **Skills 无触发式/安全审计/市场分类**：`skill-store.js` 为基础模板库。
- ❌ **记忆无跨会话检索**：`memory-store.js` 仅当前工作区，无全局搜索。
- ❌ **多任务仅单工作区**：侧边栏无"按文件夹分组的任务列表 + 并行"。

---

## 2. 对齐升级方案（模块清单 · 优先级 · 关键实施要点）

> 优先级定义：**P0**=稳定性/安全命门；**P1**=对齐 WorkBuddy 核心价值、ROI 高；**P2**=生态/高级增强。
> 模块编号 `W1…W15`，并在末尾给分阶段路线图。

### 2.1 可借鉴与复用的功能模块及改进点

#### W1 · Skills 体系升级（触发式 + 安全审计 + 市场分类 + 用户/项目级隔离）— P1
- **对标**：WorkBuddy Skills 的触发自动调用、导入安全审计（P0/P1/P2 风险分级）、用户级/项目级存储、`find-skills` 市场。
- **现状**：`skill-store.js` 为基础模板库；无触发、无审计、无隔离层级。
- **关键实施要点**：
  1. 在 `SKILL.md` frontmatter 增加 `trigger`（关键词/场景向量）+ `risk_level`（P0/P1/P2）。
  2. 新增导入安全审计函数 `auditSkill(skillPath)`：扫描脚本/references/assets 中的危险操作（eval、child_process 任意执行、网络外发、文件越权），输出风险报告，**P0 需用户显式确认才装**（对齐 `skills-security-check` 流程）。
  3. 存储分层：用户级 `~/.pancode/skills/`（跨项目）+ 项目级 `.pancode/skills/`；加载优先级项目级 > 用户级。
  4. 市场分类：按"领域（前端/后端/DevOps/测试/文档）"打标，设置面板分标签展示（复用 `skill-market.js`）。
- **为什么 A 不选 B**：自研 YAML 风险标记 vs 直接跑脚本——选"先声明风险等级 + 装前审计"，因本地优先产品命门是"Agent 误伤用户"，宁可装时多一步也不裸跑。

#### W2 · Connectors & Experts 维度（连接器注册表 + 专家角色）— P1/P2
- **对标**：WorkBuddy 把"外部服务接入（Connector）"和"专家角色（Expert）"做成两类一等公民，区别于 MCP 工具。
- **现状**：只有 MCP。
- **关键实施要点**：
  1. **Connectors 注册表**：在 `pancode.config.json` 增加 `connectors` 段，描述外部 API/服务的 `baseUrl`/`auth`/`scopes`；复用 MCP 的 stdio/HTTP 通道，但 UI 上归类为"已连接的服务"并支持一键授权（OAuth/Token），对应设置面板新增"连接器"页（参考 `global-settings.js`）。
  2. **Experts 角色**：把现有 `PERSONAS`（fullstack/frontend/backend）升级为 `experts/` 包——每个含 `role`/`methodology`/`tool_whitelist`，可在对话中 `@专家` 或切换当前会话专家；专家可作为子 agent 的"人设"复用 `runSubAgent` 收敛白名单机制。
- **价值**：让 Pancode 从"编码 agent"演进为"可接外部服务 + 可切换专家"的办公级工作台，对齐 WorkBuddy 生态位。
- **落地决策（2026-09-26）**：
  1. **Connectors：不做**。MCP（`cfg.mcp.servers` + 连接状态徽标 + hooks 拦截 `mcp__*` + 审批规则）已 100% 覆盖"外部服务接入"全链路；再建 Connectors 注册表 = 同一能力的重复抽象，违反第一性原理。MCP 即 Pancode 的 Connectors。
  2. **Experts：已落地（最小完整闭环）**——
     - 专家包 = md 文件（frontmatter: name/description/tool_whitelist + 正文第一段=role、其余=methodology）；name 缺失回退文件名。
     - 三层来源 project(`<工作区>/.pancode/experts/`) > user(`~/.pancode/experts/`) > builtin（内置三角色升级为 role+methodology，id 不变零迁移）；agent 可直接 write_file 沉淀项目专家。
     - `personaText(userText)`：`@专家名/id` 单条消息切换（精确命中才生效） > custom > active（内置 id 或专家包 id）。
     - `runSubAgent(opts.expert)`：子智能体按专家 role/methodology 执行，工具按白名单收敛（先排 SUB_AGENT_BLOCK 再取交集，白名单无法解锁受限工具；全不命中回退防呆）；`agent`/`orchestrate` 工具均透传 expert。
     - 设置面板预设下拉动态渲染「专家包」optgroup；同 value 选项更新标签防重复（内置被覆盖时标签同步）。
     - 明确不做：专家审计（无外部市场来源，专家即用户/agent 自写；若未来引入专家市场再复用 auditSkill）、专家管理面板（md 文件即接口）。

#### W3 · 三层记忆 + 跨会话检索（conversation_search）— P1
- **对标**：WorkBuddy 云端画像 + 跨会话检索 + 用户级/工作区级记忆。
- **现状**：`memory-store.js` 仅当前工作区 `.pancode/memory`，无全局层、无语义检索。
- **关键实施要点**：
  1. 新增**用户级记忆** `~/.pancode/MEMORY.md`（跨项目偏好/约定），加载时与项目级 `.pancode/memory` 合并注入 system prompt。
  2. 新增**跨会话索引**：把每次会话结算（`save_session_memory`）的 decisions/lessons 写入可检索结构（复用 `code-index.js` 的 BM25/向量），提供 `search_memory` 跨全部历史会话查询（当前该工具仅查当前工作区）。
  3. 查询走"文件形式按需读取"，不预注入整库（对齐 Cursor 范式，省 token）。
- **价值**：让"越用越懂你"从单工作区升级为跨项目长期伙伴。

#### W4 · 自动化任务（一次性 + 周期，独立调度）— P2
- **对标**：WorkBuddy 一次性/周期自动化，独立调度器，未来运行不依赖当前会话。
- **现状**：无。
- **关键实施要点**：
  1. 新增 `server/scheduler.js`：基于 `node-cron` 类轻量实现（或自研 `setInterval` + 持久化 next-run），任务定义存 `.pancode/automations/<hash>.json`（`{name, prompt, scheduleType, rrule|scheduledAt, status}`）。
  2. 触发时在**隔离上下文**跑（复用 `runSubAgent` 收敛白名单），结果写入 `.pancode/automations/<hash>/runs/`，前端侧边栏可查看运行历史。
  3. 编码场景化模板：定时跑测试/ lint、夜间依赖审计、周期性代码健康报告。
- **注意**：自动化写盘必须走 `safePath` + 审计日志；周期任务默认 `semi` 权限（写操作需确认），避免无人值守误伤。

#### W5 · 内联可视化（Visualizer / 图表 / 架构图）— P2
- **对标**：WorkBuddy `show_widget` 在对话区渲染 SVG/HTML 图表。
- **现状**：聊天区仅 Markdown + 代码块。
- **关键实施要点**：
  1. 新增 `public/js/visualizer.js`：识别 Agent 返回的 ```` ```widget ```` 代码块（SVG/HTML 片段），在消息流内联渲染（不进 `<body>` 全屏，避免破坏布局）。
  2. Agent 工具新增 `render_diagram`（传描述→返回 SVG），用于画架构图/流程图/数据图；UI 配套"下载为 PNG/SVG"按钮。
  3. 主题联动：SVG 用 `currentColor` + CSS 变量，随 light/dark 切换（收口 B4）。

#### W6 · 产物系统升级（Artifact 卡片 + 实时预览面板 + 四视图）— P1
- **对标**：WorkBuddy 结果区"产物 / 全部文件 / 变更 / 预览"四视图 + `present_files` 卡片化交付。
- **现状**：结果区有文件/变更/预览，但缺"产物卡片"聚合与统一预览面板。
- **关键实施要点**：
  1. 定义"产物"语义：Agent 完成任务时把交付物（报告/图表/生成的文件集合）标记为 artifact，存 `.pancode/artifacts/<convId>/`。
  2. 前端结果区加 **产物视图**：卡片化展示（图标 + 标题 + 类型 + 打开/下载），点击在**内置预览面板**（HTML 用 iframe/object，图片/PDF 原生）打开（复用现有 preview 区并升级为面板）。
  3. 四视图统一：`产物` / `全部文件` / `变更(diff)` / `预览`，顶部 tab 切换（对齐 `index.html` 结果区结构）。
- **价值**：把"交付可验收结果"从文字变成可点开的产物，对齐 WorkBuddy 核心差异点。

#### W7 · 多任务 / 多工作区并行管理（侧边栏任务列表分组 + 并行）— P2
- **对标**：WorkBuddy 侧边栏按文件夹分组任务列表、可搜索、多任务并行。
- **现状**：会话列表在单工作区内，无跨工作区/分组。
- **关键实施要点**：
  1. 侧边栏任务列表按**工作区目录分组 + 搜索框**（复用现有 conv 列表 UI 扩展）。
  2. 支持在多个工作区各开一个 Agent 会话并行的后端隔离（每工作区独立 `mountWorkspace()` 实例已具备，前端加切换）。
- **ROI**：P2，因单工作区已满足核心场景，属办公级体验增强。

#### W8 · 三模式 UI 收口（Agent / Plan / Ask 显式切换）— P1
- **对标**：WorkBuddy 三模式，尤其 `Ask`（只读问答、不动手）。
- **现状**：有 Editor/Agents + Plan Mode 开关，但没有显式"Ask 只读问答"模式（Plan 偏探索但 UI 术语不一）。
- **关键实施要点**：
  1. 在 `app.js` 顶部模式切换统一为三档：`Agent`（全工具）/ `Plan`（只读探索 + 后端拦截 mutating）/ `Ask`（纯问答，禁用所有写/执行工具，连 `run_command` 都不进）。
  2. 三档后端以 `config.js` 单一 `mode` 字段驱动，避免现有 Editor/Agents 与 planMode 双开关语义混淆。
- **为什么 A 不选 B**：复用现有 planMode 拦截机制扩展为三态，而非新增独立开关——降低状态不一致 bug。

### 2.2 前后端架构调整建议

#### W9 · 前端工程化（构建步骤 + 组件化 + 重渲染移 Web Worker）— P2
- **对标**：WorkBuddy 现代组件框架 + 主线程不阻塞。
- **现状**：原生 JS、无打包，`app.js` 175KB、`styles.css` 126KB。
- **关键实施要点**：
  1. 引入 **Vite** 做开发/打包（不强制改框架，先把 `public/js/*` 当 ES module 入口打包，消除全局命名空间耦合）。
  2. 把 Monaco 渲染、大消息流 diff、代码索引结果渲染移入 **Web Worker / OffscreenCanvas**，主线程只做 UI 调度（对齐"进程不卡顿"）。
  3. 渐进式：先加构建链跑通现有脚本，再按组件抽离，避免一次性重写风险。
- **取舍**：上框架（React）vs 纯 Vite+原生——选**Vite+原生模块化**优先，因现有 15 模块已成型，重写框架成本高风险大，违背"小步可验"。

#### W11 · 进程隔离（Agent 循环移子进程 / Worker，长任务不阻塞主服务）— P1
- **对标**：WorkBuddy 长任务/自动化在隔离上下文跑，不阻塞主进程。
- **现状**：Agent 循环在 `index.js` 主进程跑；`subagent` 串行也在主进程。
- **关键实施要点**：
  1. 把 `agent-llm.js` 的循环通过 **child_process（fork）或 worker_threads** 跑，主进程只做 WS 网关 + 文件 API，Agent 子进程通过 IPC 回报 think/tool/result 流。
  2. 好处：LLM 长循环崩溃不影响文件服务；主进程事件循环不被重计算阻塞（直接缓解"卡顿"）。
  3. 优雅关闭：`shutdown()` 先 `agentChild.kill()` 再关 WS（已在 `index.js` 优雅关闭基础上补 agent 子进程）。
- **优先级 P1**：稳定性对齐的关键一步，但工作量中，建议先于 W9 做（收益更直接）。

#### W12 · git.js 异步化（消除同步阻塞）— P1（稳定性硬伤）
- **现状**：`server/git.js:21` `execFileSync`、`:48` `spawnSync` 同步阻塞事件循环，大仓库必卡顿。
- **关键实施要点**：
  1. 全部改为 `util.promisify(execFile)` / `spawn` 异步，I/O 等待让出事件循环。
  2. `git.changes()`/`git.discardAll()` 等高频调用加超时与并发上限，避免同时 N 个 git 进程压垮机器。
  3. 回归脚本复用 `scripts/test-*.js` 思路，新增 `scripts/verify-git-async.js` 断言异步不阻塞（用大仓 mock 测延迟）。
- **为什么必做**：这是目前最确定的"卡顿源"，对齐"进程稳定运行不卡顿"第一条。

### 2.3 前端样式设计

#### W10 · 主题系统完善（IDE 主题自适应 + SVG currentColor 收口 + 浅色审计收尾）— P1
- **现状**：`styles.css` 已有 `:root[data-theme="dark"/"light"]` + z-index token；但 SVG 内仍有硬编码颜色（B4 遗留），浅色对比度不足。
- **关键实施要点**：
  1. **IDE 主题自适应**：启动时读取宿主主题（`prefers-color-scheme` + 桌面端 `main.js` 注入 `data-theme`），切换时广播到所有面板（含新开的 preview iframe）。
  2. **SVG 收口**：所有图标/图（`.evo-*`、进化图鉴、图表）改用 `currentColor` 或 CSS 变量，杜绝 `#fff`/`#1a8c6e` 硬编码（逐屏走查 light 模式对比度 ≥ 4.5:1）。
  3. **设计 token 沉淀**：在 `:root` 显式定义色板（`--bg0..4`/`--text`/`--text-dim`/`--accent`/`--border`/`--danger`/`--warn`），全站引用，禁止散落十六进制。
  4. **动效 token**：补 `--ease`/`--dur-fast|normal|slow`，统一面板展开/tab/消息入场（对齐 `B5`，提升质感）。
- **价值**：从"能用"到"办公级精致"，且 light/dark 随宿主切换不掉链子。

### 2.4 功能完善且易用（UX）

- **W6/W7/W8** 已覆盖产物、多任务、三模式等核心易用性。补充：
- **W13 · fast-apply 小模型（编辑应用可靠性/吞吐）— P1（依赖外部小模型端点）**
  - 现状：整文件/片段 apply 由大模型直接出，未用 7B 级小模型做机械 merge。
  - 要点：配置一个廉价 apply 端点（如本地 Ollama 小模型或兼容端点），大模型起草松散编辑 → 小模型机械 merge，提升 apply 成功率与吞吐；无端点时降级为现有大模型 apply（向后兼容）。
  - 价值：降低"diff 应用失败→重跑"的体感卡顿与 token 浪费。
- **首次上手再打磨（C4 已做，此处补）**：把"配 LLM → 选工作区 → 发第一条消息"做成可跳过的引导，并把**演示引擎**入口前置（无 Key 也能完整体验闭环），对齐 WorkBuddy"开箱即干"。
- **错误恢复（C2 已做）**：补"配额耗尽/网络中断/Key 无效/模型不存在"分类提示的**一键重试**在产物区也生效。

### 2.5 进程稳定运行不卡顿（措施汇总）
- **W12** git.js 异步化（消除同步阻塞，最高优先）。
- **W11** Agent 循环移子进程/Worker（长任务不拖垮文件服务）。
- **W9** 重渲染移 Web Worker（Monaco/大消息流不占主线程）。
- **已落地保留**：`unhandledRejection/uncaughtException` 兜底（不杀进程只广播）、优雅关闭（`shutdown` kill 终端子进程 + 关 WS + 停 watch）、内存 LRU（`conversations` 上限 20、`_selfWrites` TTL、`sessions` 定时清扫）——见 `index.js:1277`、`auth.js:97`。
- **监控**：前端状态栏加"事件循环延迟（ELD）"探针（每 5s `setTimeout` 偏差），超阈值提示"主进程繁忙"，让用户感知卡顿源。

### 2.6 安全配置与权限控制（措施汇总）
- **W14 · 权限增强：hooks 系统 + 沙箱选项 + 危险操作二次确认 UI — P1**
  - 现状：`security.js` 正则黑名单（base/strict）+ `agmMode` 三档 + allow/deny。
  - 要点：
    1. **Hooks**：新增 `pre_tool`/`post_tool` 钩子（`pancode.config.json` 配置），可在工具执行前拦截/改写（如"所有 `write_file` 到 `node_modules` 直接拒"），对齐 WorkBuddy hooks 机制。
    2. **沙箱选项**：暴露 `dangerouslyDisableSandbox` 语义的反面——默认沙箱（cwd 限工作区），提供明确开关让用户知晓风险（不默认开启）。
    3. **二次确认 UI**：危险操作（删除/覆盖/全局安装）即使 `auto` 模式也弹 `showConfirm` 列明后果（复用 C7-7 的二次确认弹窗），并把操作写 `.pancode/audit/` 审计日志。
- **W15 · 安全收口：审计日志持久化 + 命令黑名单语义化 — P2**
  - 要点：黑名单从"正则字符串匹配"升级为**分词 + AST 语义解析**（防 base64/变量拼接绕过）；所有 `run_command`/写文件落审计日志（已部分在 A6 规划，此收口持久化与可视化查询）。
  - 保留：登录闸门 + NO_AUTH 白名单收紧 + CORS 环回 + `/api/fs/browse` 限工作区及上级（防全盘枚举）。

---

## 3. 模块清单与优先级总表

| 编号 | 模块 | 维度 | 优先级 | 关键文件 |
|---|---|---|---|---|
| W1 | Skills 体系升级（触发/审计/市场/分层） | 复用·改进 | P1 | `skill-store.js`/`skill-market.js` |
| W2 | Connectors & Experts 维度 | 复用·改进 | P1/P2 | `pancode.config.json`/`global-settings.js`/`PERSONAS` |
| W3 | 三层记忆 + 跨会话检索 | 复用·改进 | P1 | `memory-store.js`/`code-index.js` |
| W4 | 自动化任务调度 | 高级 | P2 | 新增 `server/scheduler.js` |
| W5 | 内联可视化 | 高级 | P2 | 新增 `public/js/visualizer.js` |
| W6 | 产物系统升级（卡片+预览+四视图） | UX | P1 | `index.html` 结果区/`preview` |
| W7 | 多任务/多工作区并行 | UX | P2 | 侧边栏/`mountWorkspace` |
| W8 | 三模式 UI 收口（Agent/Plan/Ask） | UX·安全 | P1 | `app.js`/`config.js` |
| W9 | 前端工程化（Vite+Worker） | 架构 | P2 | `public/js/*`/`app.js` |
| W10 | 主题系统完善 + SVG 收口 | 样式 | P1 | `styles.css` |
| W11 | 进程隔离（Agent 移子进程） | 稳定 | P1 | `agent-llm.js`/`index.js` |
| W12 | git.js 异步化 | 稳定 | P1 | `server/git.js` |
| W13 | fast-apply 小模型 | 正确·吞吐 | P1 | `agent-llm.js` apply 链路 |
| W14 | 权限增强（hooks+沙箱+二次确认） | 安全 | P1 | `security.js`/`config.js` |
| W15 | 安全收口（审计+语义黑名单） | 安全 | P2 | `security.js`/`.pancode/audit/` |

---

## 4. 分阶段路线图

- **阶段一 · 稳定与对齐地基（2–3 天）**：`W12` git 异步化 → `W11` Agent 进程隔离（轻量 fork）→ `W10` 主题/SVG 收口 → `W14` 权限 hooks + 二次确认。先把"不卡顿 + 不失控"钉死。
- **阶段二 · 办公级工作台能力（1–2 周）**：`W8` 三模式 → `W6` 产物系统 → `W1` Skills 升级 → `W3` 记忆检索 → `W13` fast-apply → `W15` 安全收口。让 Pancode 在"交付产物 + 越用越懂"上对齐 WorkBuddy。
- **阶段三 · 生态与高级（按需）**：`W2` Connectors/Experts → `W4` 自动化 → `W5` 可视化 → `W7` 多任务 → `W9` 前端工程化。补齐生态位与长期体验。

---

## 5. 关键决策记录（为什么 A 不选 B）

1. **Skills 先"声明风险等级 + 装前审计"而非裸跑** → 本地优先产品命门是"Agent 误伤用户"，安全优先于便利。
2. **三模式复用 planMode 拦截机制扩展为三态，而非新增独立开关** → 避免双开关语义不一致 bug。
3. **前端先上 Vite+原生模块化，不强行换框架** → 现有 15 模块已成型，重写框架成本高风险大，违背"小步可验"。
4. **Agent 循环先移子进程（W11）再谈前端工程化（W9）** → 进程隔离对"不卡顿"收益更直接、风险更可控。
5. **git.js 异步化列为 P1 硬伤** → 同步 `execFileSync` 是大仓库卡顿的确定源，必须先解。

---

## 6. 完成判据（交付前自检）
- P0/P1 是否关闭或有缓解方案（W12/W11/W10/W14 为阶段一必交）。
- 无 `TODO`/`stub`/`test.skip` 占位。
- 每个关键决策"为什么 A 不选 B"已记录（见第 5 节）。
- 验证三件套全绿：`npm run test:verify` + `npm run smoke` + 关键新模块 Playwright 探针（如 `verify-git-async.js`、`verify-skills-audit.js`）。
