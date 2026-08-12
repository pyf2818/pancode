# Pancode 调研报告落地缺口分析

> 日期：2026-08-12
> 对照对象：
> - `agentic-coding-tools-architecture-report.md`（架构技术报告，19 条最佳实践 A–F）
> - `docs/agent-design-research.md`（Phase 1 设计调研，P0/P1/P2 清单）
> - `docs/optimization-plan.md`（19 项优化方案，自报已全部 ✅）
> 方法：先读报告，再用 grep/Read 在 `server/`、`public/` 实际核对代码落地情况，避免"自报完成"误判。

---

## 一、已经具备的能力（常被误认为缺口，实际已落地）

| 报告条目 | 落地证据 | 状态 |
|---|---|---|
| 架构 A1 ReAct + function calling | `agent-llm.js` `TOOLS` 数组 + `chatStream(..., TOOLS)` 工具结果回灌 | ✅ |
| 架构 A3 错误回灌自纠 | SYSTEM_PROMPT #3「失败就继续修复」；`run_command` 返回输出/错误；`apply_edit` 严格拒绝回灌 | ✅ |
| 架构 B5 7 最小工具集 | 实际 **13 个工具**：list_files/read_file/write_file/apply_edit/delete_file/search_code/run_command/repo_map/search_symbol/search_memory/create_skill/create_plan/update_plan | ✅ 超出预期 |
| 架构 C8 Aider 式 Repo Map | `server/repo-map.js` + `repo_map` 工具（agent-llm.js:142，handler :929）+ `search_symbol` | ✅ |
| 架构 C9 embedding 索引 | `server/code-index.js` 向量/BM25，`search_code` 语义优先 | ✅ |
| 架构 D12/D13/D15 search/replace + 严格校验 + 逐块审批 | `server/patch.js` 逐字唯一校验；`#patchModal` hunk 级接受/拒绝 | ✅ |
| 架构 E17 Agent 循环放后端 | `agent-llm.js` 后端编排 | ✅ |
| agent-design P0-2 权限三档 | ask/semi/auto 模式（app.js:77-80，后端应用）| ✅ |
| agent-design P0-3 上下文预算条 + compact | `compactHistory()` + `autoCompact:true`（预算 1M tokens）+ 前端 `refreshCtx` 条 | ✅ |
| agent-design P1-4 `.pancode/rules` 规则层 | `loadRules()` 读 `.pancode/rules/*.md` 注入 | ✅ |
| agent-design P1-5 auto memory | `MemoryStore` + `/api/memory` CRUD + `search_memory` 工具 | ✅ |
| agent-design P1-6 智能体设定 | `PERSONAS` 预设（fullstack/frontend/backend）+ 设置面板 | ✅ |
| optimization-plan 全部 19 项 | 自报 ✅；会话持久化/终端隔离/C7/C8 已在增量中落地 | ✅（A1/A2 见下方风险） |
| 增量 #3 LSP 桥接 + 轻量向量索引 | `lsp-bridge.js` + `lsp-client.js` + `code-index.js` | ✅ |
| 增量 #6 终端多标签 + 设置持久化 + Agent 全局 CLI 路径 | commit `6bc2fce` | ✅ |
| agent-design P0-1 图片粘贴/拖入附件前端 | `app.js:2155` paste、`2163` drop、`1991-2070` pendingAttach 图片 chips，随 chat WS `attachments` 发出 | ✅ |
| 架构 A2 真实 Plan Mode 硬开关 | `config.js` `planMode` + `agent-llm.js` 拦截 write_file/apply_edit/delete_file/run_command + 注入只读指令 + 前端 `btnPlanMode` 开关（2026-08-12 实现） | ✅ |
| optimization-plan A1/A2 登录闸门 + 收紧白名单 | `index.js:141-166` NO_AUTH 白名单 + 401 中间件 `userAuthed` + bootstrap 仅 127.0.0.1 + CORS 环回 | ✅ 已复验 |
| 架构 C11 / agent-design P0-1 `@file`/`@folder` 提及注入 | `agent-llm.js:680` `_resolveMentions` 解析并读取文件内容 / 列出目录，注入「引用上下文」 | ✅ |

---

## 二、真正的缺口（按优先级与 ROI 排序）

### P0 —— 调研明确标为"行业底线"，当前未做或仅半做

**① MCP 接入（架构 B7 / 行业可扩展事实标准）✅ 已落地（2026-08-12，commit `0a448f3`）**
- 现状：工具系统为"内置工具"硬编码，无 MCP 动态加载。
- 报告依据：Cursor/Cline/Copilot/Continue/Zed/Goose 均把 MCP 作为工具扩展标准；Copilot 每会话上限 128 工具（过多需用户筛）。
- 缺口（已实现）：`mcpServers` 配置 + `saveMcpServers` 持久化、`McpClient/McpManager` 零依赖 stdio JSON-RPC 客户端、工具动态注册为 `mcp__<server>__<tool>` 注入 Agent 工具集、设置面板增删改 + 连接状态徽标 + WS 实时刷新；Plan Mode 下禁用 MCP 工具。
- 验证：后端 `verify-mcp.js`（`MCP OK=true`，initialize→tools/list→tools/call 全链路）；前端 `verify-mcp-ui.js`（Playwright 真实 UI 驱动，`MCP UI OK=true`）。
- 价值：**高**（决定能否接入用户既有的外部工具/服务生态）。

**② ③ ④ 已落地（见上方「已经具备的能力」）**
- ② 图片附件前端：已实测存在 paste/drop/chips 链路（2026-08-12 复核，原报告误判为缺口）。
- ③ 真实 Plan Mode 硬开关：`config.js planMode` + 后端拦截 mutating 工具 + 前端 `btnPlanMode`（2026-08-12 实现）。
- ④ 身份认证明实化复验：NO_AUTH 白名单 + 401 中间件 + bootstrap 仅 127.0.0.1 已落地并复验（2026-08-12 复核）。

### P1 —— 体验与正确性增强

**⑤ fast-apply 小模型（架构 D14）**
- 现状：整文件/片段 apply 由大模型直接出；未用 7B 级小模型做机械 merge。
- 价值：中（提升吞吐与 apply 成功率，属"低成本高可靠杠杆"，非阻塞）。

**⑥ 实时增量代码索引（架构 C10）✅ 已落地（2026-08-12，commit `4c831f4`）**
- 现状：`code-index.js` 一次性构建，编辑后不实时重算；`search_code` 退化为 grep/BM25。模型刚写的代码可能 grep 不到——Cursor 因此专门补了一层本地实时索引。
- 实现：`server/code-index.js` 新增 `queueFileUpdate`（700ms 防抖合并）/ `removeFile` / `flushUpdate`，仅对变更文件重算分块并合并进现有索引（vector 模式按需补嵌新分块），无索引时静默 no-op；在 `agent-llm.js` 的 write_file / apply_edit(applyPatch) / delete_file 与 `index.js` 的 file.save/create/delete/rename WS 协议挂载，文件落盘即刷新语义索引。
- 顺带修复潜在 bug：`buildIndex` 未把 embedding 配置写入 `meta.embedding`，导致 `search` 的向量查询路径永远取不到端点而退化 BM25——现已在 meta 持久化 endpoint+model。
- 验证：`scripts/verify-incremental-index.js`（构建→更新/新增/删除单文件→检索断言新 token 命中、旧 token 消失、count 稳定、无索引工作区 no-op）`INCREMENTAL INDEX OK=true`；`scripts/test-code-index.js` 回归 4/4 通过。
- 价值：中（模型刚写的代码立即可被 search_code 检索到）。

**⑦ @提及 真正解析注入（架构 C11 / agent-design P0-1）→ 已落地**
- 现状：`agent-llm.js:680` `_resolveMentions` 已解析 `@file:`/`@folder:` 并读取内容/列出目录注入「引用上下文」（2026-08-12 复核，原报告误判为缺口）。

**⑧ 显式 /undo 检查点（架构 A4）**：**✅ 已落地**。在 `agent-llm.js` 实现检查点栈 `_undoStack`：`write_file` / `delete_file` 改盘前、`applyPatch`（审阅接受后真正落盘）前，分别用 `_snapshotBefore` 记录受影响文件的「改动前内容 + 是否存在」。新增 `undo` 工具（已加入 `TOOLS`，并列入 `MUTATING_TOOLS` 故规划模式下禁用），调用 `_undoLast` 按 LIFO 单步回滚：被编辑/删除的文件分别还原内容 / 重建，新建的文件则删除；回滚同时刷新语义索引（queueFileUpdate/removeFile）与前端的 editor.open。栈深上限 50。验证脚本 `scripts/verify-undo.js` 覆盖编辑回滚、新建撤销(删除)、删除撤销(重建)、多文件补丁、空栈、连续 LIFO 全绿。注意：检查点为进程内内存态，进程重启后清空（符合"检查点"语义，未做持久化）。

**⑨ allow/deny 规则可视化配置 UI（agent-design P0-2 收尾）✅ 已落地（复核为误判）**
- 现状（2026-08-12 复核）：**其实已实现**。Agent 设置面板（`index.html` 权限模式区）提供 `agmMode` 模式下拉 + `agmAllow` / `agmDeny` 两个文本域（每行一条，支持子串或 `/正则/`，allow 在 semi 模式生效、deny 全模式硬拦截）；`settings.js` 的 `openAgentSettings` 读取、`agmSave` 写回 `{permissions:{mode,allow,deny}}`；后端 `config.js saveAgentSettings` 持久化、`agent-llm.js _approvalDecision/_matchRule` 按命令/文件路径 subject 匹配放行或拦截。即"命令级 + 文件级 allow/deny 可视化配置"已具备。
- 价值：中。

### P2 —— 进阶（按需，非当前必需）

**⑩ 多智能体/子代理编排（架构 F19）**：**✅ 已落地（单工作区子智能体，非 worktree 隔离）**。新增 `agent` 工具 + `runSubAgent` 方法（OpenCode `agent` 工具范式）：父智能体派发一个聚焦子智能体，在**同一工作区**内读/搜/写/改/运行命令完成子任务并返回中文汇报。`runSubAgent` 收敛工具白名单（排除 `agent` 自身防递归、排除 `create_plan`/`update_plan`/`undo` 防污染主流程），轮数上限 24（默认 12）防失控；运行期临时把 `tool/state/say` 等 UI 句柄替换为 no-op（静默主界面），但真实改动工作区并刷新编辑器与语义索引；结束后复原句柄。子智能体共享父的 `files/patch/_undoStack`，因此其写盘也会在父的 undo 栈留下检查点（可撤销）。验证脚本 `scripts/verify-multiagent.js` 覆盖执行工具返回结果、白名单、轮数收敛、真实写盘全绿。说明：当前为串行单子智能体（未做 worktree 级隔离/真正并行），满足"编排"核心诉求；后续如需并行可再加。

**⑪ 工作流模板 / goal 式目标驱动（agent-design P2-8）**：**✅ 已落地**。新增 `server/workflow-store.js`（`WorkflowStore`：5 个内置模板 feature/bugfix/refactor/test/docs + 自定义模板持久化到 `.pancode/workflows/<hash>.json`，`{goal}` 占位符替换）。`agent-llm.js` 新增 6 个只读/元操作工具：`list_templates`（列内置+自定义）、`instantiate_template`（模板→可执行 plan，`{goal}` 注入标题/步骤）、`save_template`（当前活跃计划或显式步骤沉淀为模板，可一键复用）、`remove_template`（仅自定义可删）、`set_goal`（设定会话目标并持久化到 `.pancode/goals/<hash>.json`；可选 `template` 一键生成执行计划；空值清除）、`goal_status`（查看目标+计划进度）。`set_goal` 会把目标注入每轮 system prompt 实现「目标驱动」；子智能体黑名单屏蔽全部 6 个元操作工具（防污染主流程）。均不触碰用户业务代码，规划模式也安全。验证脚本 `scripts/verify-workflow-goal.js`（21 项全绿）。

**⑫ 会话结束"沉淀为规则/记忆"轻量入口（agent-design P2-7）**：`create_skill` 是隐式沉淀，缺显式"本次会话有效决策/被拒操作是否存入记忆"的收尾提示。

**⑬ LSP diagnostics 真正喂给 Agent（架构 E16 收尾）**：**✅ 已落地**。后端 `lsp-bridge.js` 在代理 `textDocument/publishDiagnostics` 时把诊断存入 `LspManager._diagnostics`（按归一化绝对路径缓存，Windows/Unix 一致），并通过 `setActiveManager/getActiveManager` 单例访问器暴露给 Agent。新增只读工具 `get_diagnostics`：传 `path` 返回单文件诊断，不传返回整个工作区汇总（含错误/警告计数）。模型可据此自我修正编译/类型错误。纯只读、规划模式下也安全（不在 MUTATING_TOOLS 内）。验证脚本 `scripts/verify-lsp-diagnostics.js` 全绿。

---

## 三、建议推进节奏

> 更新（2026-08-12）：原 P0 中 ② 前端附件、③ Plan Mode、④ 身份复验经代码复核均为**已落地**（②③为新实现/确认，④为确认）。⑦ @提及注入亦确认已落地。**① MCP 已于 2026-08-12 实现并验证**（commit `0a448f3`），故 P0 全部清零。**⑥ 实时增量代码索引已于 2026-08-12 实现并验证**（commit `4c831f4`）。**⑨ allow/deny UI 复核为误判，实际已实现**（设置面板 agmAllow/agmDeny + 后端 _matchRule 已落地）。剩余未做项见下。

1. ~~**① MCP（唯一剩余 P0）**：决定生态扩展性，工作量较大，单独排期。**→ 已完成。**~~
2. ~~**⑥ 实时增量代码索引（P1）**：文件落盘即刷新语义索引，模型新写代码可立即检索。**→ 已完成。**~~
3. ~~**⑨ allow/deny 可视化配置 UI（P1）**：权限三档 + 允许/拒绝清单，设置面板已具备，后端已执行。**→ 复核为误判，实际已完成。**~~
4. **P1 真正剩余**：⑤ fast-apply（需小模型端点，依赖外部）。**⑧ /undo 检查点已于 2026-08-12 完成。**
5. **P2 全部按需**（⑩ 多智能体编排、⑪ 工作流模板/goal、⑫ 会话结束沉淀记忆、⑬ LSP diagnostics 喂给 Agent），属"锦上添花"。**→ ⑬ 已完成（2026-08-12）；⑩ 已完成（2026-08-12）；⑪ 已完成（2026-08-12）。**

> 说明：本报告最初为纯交叉核对（未改代码）；2026-08-12 已据此实现并验证 **③ 真实 Plan Mode 硬开关**、**① MCP 外部工具接入**、**⑥ 实时增量代码索引** 三项；并复核确认 **⑨ allow/deny UI** 早已落地（报告误判为缺口）。P0 缺口已全部清零，P1 中 ⑥ 与 ⑨ 均已完成。
