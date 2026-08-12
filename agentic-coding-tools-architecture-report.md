# 智能体式编程工具（Agentic Coding Tools）架构技术报告

> 目标：为构建一个类 Cursor / Windsurf 的 Web 端 AI 编程工具，提炼成熟产品的**可复制工程模式**，而非市场宣传。
> 研究日期：2026-08-12
> 范围：Cursor、Windsurf/Codeium Cascade、Cline/Roo Code、Aider、GitHub Copilot、Zed、OpenCode、Goose、Continue.dev，以及 Web 编辑器技术栈（Monaco / CodeMirror 6 / Eclipse Theia）。

---

## 一、Executive Summary（核心结论）

把所有产品的工程实践收敛后，可以归纳出一套"通用架构骨架"，任何类 Cursor 的 Web 工具都应照此搭建：

1. **Agent loop**：几乎都采用 **ReAct（推理-行动-观察）循环 + 工具调用（function calling）**，并叠加一个**显式"规划模式"**（plan mode）作为安全边界。Cursor、Copilot、Cline、Windsurf Cascade 都在"直接写代码"之前先让用户看计划。最激进的架构（Claude Code）**刻意不做索引**，改用 agent 每次按需搜索——这对 Web 工具是重要反例。
2. **Tool system**：工具集高度同质化——`read_file` / `write_file` / `edit_file`（或 `replace_in_file`）/ `grep` / `glob` / `list_files` / `bash` / `web_fetch`，外加 MCP 可扩展。关键不是"有哪些工具"，而是**如何定义、校验、审批**。
3. **Context management**：两条路线——**离线索引（RAG/向量）**（Cursor、Windsurf、Copilot @workspace）与**按需检索（agentic search）**（Claude Code 范式、Aider repo map）。Aider 的 **repo map（基于图排序的符号大纲）** 是最轻量、最可复制的方案。
4. **Edit application**：三种格式之争——**整文件重写（whole-file）**、**search/replace 块（Aider/Claude Code/Cline）**、**unified diff 补丁**。业界共识：**search/replace 比 diff 更可靠，整文件最贵但最稳**；用"大模型起草 + 小模型快速应用（fast-apply）"是低成本高可靠性的关键技巧。
5. **Editor 架构**：Web 端首选 **Monaco（你已在用，且是 VS Code 同款内核）** 做编辑器控件；需要极致体积/可控性时选 **CodeMirror 6**；想要"完整 Web IDE + VS Code 扩展兼容"选 **Eclipse Theia**。LSP/DAP 负责语言智能与调试，通过 WebSocket/JSON-RPC 与后端通信。

---

## 二、产品 × 能力对比表

下表按你要求的六个维度逐行对比。✓=支持/采用，△=部分/变体，—=无/不适用。

| 产品 | Agent Loop 形态 | 暴露给 Agent 的工具 | 上下文获取策略 | 编辑应用方式 | 编辑/审批 UX | 编辑器底座 |
|------|----------------|-------------------|--------------|------------|------------|-----------|
| **Cursor** | ReAct + 显式 Plan Mode；本地 Agent + 云端 Background Agent（远程 VM） | 搜文件/文件夹、Web 搜索、读规则、读文件（含图片）、**编辑文件（自动应用）**、跑 shell、浏览器截图、图像生成、提问、检查点 | 双索引：**语义向量（tree-sitter 分块 + 定制 embed + Turbopuffer）** + **本地正则 trigram 索引**；Merkle 树增量同步；`.cursor/rules` | Composer/Agent 内多文件编辑，自动 apply；diff 预览；检查点可回滚 | 工具调用透明显示；shell 需批准；检查点快照 | VS Code fork（Electron + Monaco） |
| **Windsurf / Cascade** | **Plan-then-Execute**：规划层（SWE-1）出步骤 → 用户批准 → 生成层写码+跑命令；"Flow State"跨模式保留会话上下文 | Cascade 同 Cursor 类工具集；Supercomplete（下一处编辑预测，本地索引训练） | **本地语义嵌入索引**（按函数 768 维）；AST 语义图 + M-Query 检索（优于余弦）；会话级 RAG（编辑/终端/光标轨迹）；Memories 持久化 | 多文件协同编辑，diff 预览，逐个/批量接受拒绝 | Flows 时间线可视化每步；可批准/拒绝/修改 | Code-OSS（VS Code 开源底座） |
| **Cline / Roo Code** | ReAct + **Plan Mode / Act Mode** 切换（Cline）；Roo 增加自定义 Modes（Code/Architect/Ask/Debug）+ **Boomerang 子任务编排** | `read_file`、`write_to_file`、`replace_in_file`、`search_files`(ripgrep)、`list_files`、`execute_command`、`ask_followup_question`、`attempt_completion`、browser、MCP | 显式 @-上下文 + 自动把相关文件纳入；规则来自 `.clinerules`/`.cursorrules` | **`replace_in_file`：old_string→new_string 片段替换**，生成统一 diff 预览（`@cline/ui` 渲染） | **每次动作显式 human 批准**；可 Auto-Approve | VS Code / JetBrains 扩展（后移植到 Zed/Neovim/CLI） |
| **Aider** | ReAct（每轮一工具调用）；**`/architect` 两阶段**（规划模型 + 编辑模型）；git 驱动 | 读/写文件、bash、grep、git；模型通过 repo map 决定读哪些文件 | **Repo Map**：tree-sitter 抽符号大纲 → 基于图引用频度的注意力排序 → 固定 token 预算（默认 ~1k）；增量更新 | **search/replace 块（默认 diff 格式）** / whole / udiff / patch / architect | 每轮自动 git commit（"aider:" 前缀）；`/undo`、`/diff` | 终端工具（无 GUI） |
| **GitHub Copilot** | **三步走迭代环**：上下文分析 → 实施（推测解码端点应用修改）→ 校验自纠（编译/lint/测试失败自动修） | 内置 ~20 工具：`read_file`、`edit_file`、`run_in_terminal`、`search_workspace` 等 + **MCP 扩展**（上限 128 工具/会话） | 工作区**结构摘要**（非全量代码）+ 语义索引（RAG，@workspace）；`.github/copilot-instructions.md` 常驻 | Edit 模式（指定文件集内联改）+ Agent 模式（自主多文件）；推测解码端点应用 | 工具调用透明显示；terminal 需批准；**Undo Last Edit** 回滚 | VS Code / 各 IDE 扩展（Extension Host） |
| **Zed** | **并行智能体（Parallel Agents）**：同一窗口多 thread 并发；`spawn_agent` 子代理；git worktree 隔离；前台+后台（Container Use 沙箱） | 内置 Write/Ask/Minimal profiles + 工具；后台走 Container Use（Dagger 容器 + worktree） | 内建 Tree-sitter 解析树、依赖图、协作会话；**AI 为架构一等公民**（非扩展） | Agent Panel 内编辑，git worktree 隔离合并 | Threads Sidebar 监控每线程；Custom Profiles 控制工具开关 | 自研 Rust + GPUI（开源 GPLv3）；CRDT 协作 |
| **OpenCode** | ReAct（Go 实现，Bubble Tea TUI）；`internal/llm` 编排；非交互模式自动批准 | `glob`、`grep`、`ls`、`view`、`write`、`edit`、`patch`、`bash`、`fetch`、`sourcegraph`、`agent`(子任务) + MCP | 命令式（模型按需调用工具）；`Initialize Project` 生成 OpenCode.md 记忆 | `write` 整写、`edit` 片段、`patch` 应用 diff；File Change Tracking 可视化 | 权限模型；非交互全自动 | 终端 CLI/TUI（**已归档，迁移至 charmbracelet/crush**） |
| **Goose (Block)** | ReAct（Rust）；支持 **ACP（Agent Client Protocol）**；"Unrolled agent loop" | 扩展式：shell、filesystem、http 等（extension 机制）；Hooks；recipe | 由 extension/recipe 提供；`.goosehints` / `AGENTS.md` 注入指令 | 由工具实现（extension 暴露的 edit 能力） | 工具策略（tool policy）管理 | 桌面（Electron）+ CLI（Rust） |
| **Continue.dev** | ReAct（SDK）；**Chat / Plan / Agent 三模式**（Plan 只读、Agent 全工具） | Agent 模式：文件编辑、搜索、终端/bash 等工具 + **MCP Tools**；工具策略可设自动/排除 | **Context Providers**（@-mention）：代码库检索、当前文件、高亮代码、文档等 | 编辑工具直接改文件；错误回传模型 | 默认每次工具调用请求批准（Continue/Cancel）；tool policy 自动放行 | VS Code / JetBrains 扩展 + CLI |

**横向结论**：工具集、编辑格式、上下文策略正在收敛；真正的差异在 (a) 索引 vs 按需检索、(b) 规划/审批的严格程度、(c) 多智能体编排（Zed 并行、Roo Boomerang、OpenCode `agent`、Copilot 子代理）。

---

## 三、分维度深入分析

### 3.1 Agent Loop 设计

**ReAct 是事实标准。** 所有产品都是"模型产出 reasoning + 一个 tool call → 执行工具 → 把结果反馈回模型 → 再决策"的循环（来源：Cursor Agent 文档把 Agent 定义为 Instructions+Tools+Model 的编排 [cursor.com/docs/agent/chat/summarization]；Copilot 文档明确"system prompt 告诉 Copilot 不断迭代自己输出直到终态" [github.blog/ai-and-ml/github-copilot/agent-mode-101]）。

**安全边界 = 显式规划模式（plan-then-act）。**
- Cursor：Plan Mode 让你在 agent 写任何代码前审阅其做法 [cursor.com/zh-Hant/help/ai-features/agentic-coding]。
- Cline：Plan Mode（只读探索）/ Act Mode（全工具）切换 [docs.cline.bot/cline-overview]。
- Windsurf Cascade：**规划层先分解任务成有序步骤 → 你批准/裁剪 → 生成层才写码** [pickuma.com/for-dev/windsurf-ide-review-ai-native-code-editor]。其架构优势是"计划常驻面板，不随会话变长而漂移"。
- Aider：`/architect` 两阶段——规划模型产出自然语言方案，编辑模型再执行（双模型校验）[deepwiki.com/dwash96/aider-ce/5.1-edit-strategies-overview]。

**循环如何"有界/安全"**：
- 工具调用次数无硬上限（Cursor 明确说"单个任务内工具调用次数无上限"），但靠**审批闸门**和**检查点**兜底。
- Cursor 检查点（checkpoint）= 一次 Agent 会话内的代码库快照，可回滚 [cursor.com/docs/agent/chat/summarization]。
- Copilot "Undo Last Edit" 回退到上次编辑前 [baoyu.ai/translations/introducing-copilot-agent-mode]。
- Aider 每个成功循环自动 git commit，`/undo` 回滚 [marovi.ai/Aider/zh]。

**重要反例——Claude Code 式"不索引、靠 agent 搜索"**：Anthropic 早期用 RAG+本地向量库，后放弃，因为"agentic search 普遍更好，且更简单、无安全/隐私/陈旧/可靠性问题" [atlan.com/know/ai-agent/ai-agent-harness/cursor-vs-windsurf-vs-claude-code-data-context]。对 Web 工具启示：**索引不是必需的前置投资**，先让 agent 会 grep/glob，再按需加索引。

### 3.2 Tool System（工具系统）

**共性工具清单（几乎人人都有）**：
```
read_file / view          # 读文件（常带 offset/limit 分页）
write_file / write         # 整文件覆盖
edit_file / replace_in_file / edit  # 片段替换
grep / search_files        # 内容搜索（ripgrep 风格）
glob / list_files / ls     # 文件发现
bash / run_in_terminal / execute_command  # shell
web_fetch / fetch          # 联网
ask_followup_question     # 向人澄清
attempt_completion        # 结束信号
```

**关键工程点**：
- **结构化 schema**：每个工具都有 name + description + JSON 参数 schema，description 里写"何时/如何用它"（Copilot 明确每个工具给 LLM 详细使用说明 [baoyu.ai/translations/introducing-copilot-agent-mode]）。
- **MCP 是可扩展性事实标准**：Cursor、Cline、Copilot、Continue、Zed、Goose 都支持 MCP 把外部工具/服务接入同一套权限模型 [atlan.com/...；docs.continue.dev/customize/mcp-tools]。
- **工具数量上限**：Copilot 每会话最多 **128 工具**，超过要用户挑选——因为工具列表随每次请求发给 LLM，过多会劣化选择质量 [deepwiki.com/nakamacchi/ghc-practical-guide/3.2-technical-architecture]。
- **校验与审批**：
  - Cline：**每次动作显式 human 批准**（Continue/Cancel），可设 Auto-Approve [docs.cline.bot]。
  - Continue：默认每工具调用请求批准，可用 tool policy 把特定工具设为自动/排除 [docs.continue.dev/ide-extensions/agent/quick-start]。
  - Copilot：terminal 工具需批准，编辑/读自动；UI 透明展示每次调用 [baoyu.ai/...]。
  - Windsurf：每步在 Flows 面板可见，可批准/拒绝/修改 [myengineeringpath.dev/tools/windsurf-ai]。
- **把工具结果回灌模型**：Continue 明确"工具返回数据自动作为 context item 喂回模型，多数错误也被捕获回传，让 agent 自行决定下一步" [docs.continue.dev/ide-extensions/agent/quick-start]——这是 loop 鲁棒性的关键。

### 3.3 Context Management（上下文管理）

**路线 A：离线索引（RAG/向量）**
- **Cursor 双索引（最完整公开逆向）：**
  - *语义索引*：tree-sitter 解析 → 顶层 function/class/method 各成 chunk（小兄弟节点合并，≤1500 字节）→ 定制 embed 模型（**用 agent 会话轨迹训练，非代码相似度**）→ 存入 Turbopuffer（每仓库一个 namespace）。
  - *Merkle 树*：打开项目建 Merkle 树，**只 re-embed 变更文件**，异步后台同步；用 simhash 复用队友索引（中位库 7.87s→525ms）。
  - *本地正则索引*：trigram/sparse n-gram，**每次编辑后保持最新**（避免正则漏掉模型刚写的代码）。
  - *查询时*：语义查询走 Turbopuffer（带 Merkle 访问控制证明），正则走本地索引先筛再精确匹配；检索结果**以文件形式呈现供 agent 按需读取，而非预注入**。实测 MCP 工具 A/B 让 agent token 减少 ~46.9% [lumina.shawnxie.top/...；www.besthub.dev/articles/how-cursor-instantly-understands-massive-codebases-8cd15ec339b1；towardsdatascience.com/how-cursor-actually-indexes-your-codebase]。
- **Windsurf**：本地语义嵌入（每函数 768 维），AST 语义图，自研 **M-Query 检索**（精度优于余弦相似度）；**会话级 RAG** 同时追踪"编辑/终端输出/光标轨迹"三信号；**Memories** 跨会话持久化项目知识（类似 CLAUDE.md 但由编辑器管理、本地存储）[baeseokjae.github.io/posts/windsurf-cascade-deep-dive-2026；myengineeringpath.dev/tools/windsurf-ai]。
- **Copilot**：工作区结构摘要（非全量代码）+ 本地语义索引 RAG（@workspace / #codebase）+ `.github/copilot-instructions.md` 常驻 [deepwiki.com/nakamacchi/ghc-practical-guide/3.2-technical-architecture]。

**路线 B：按需检索（最轻量、最可复制）**
- **Aider Repo Map（强烈推荐复刻）：**
  - 会话开始遍历工作树，用 **tree-sitter 解析每个源文件，抽定义与引用的结构化大纲**。
  - 按**基于图的重要性评分**（文件符号被项目其他处引用频次）对大纲排序。
  - 取排名最高的塞进一个**与提示其余部分共享的固定 token 预算**（默认 `--map-tokens` 1k，随模型上下文窗口缩放）。
  - 地图在轮次间**增量更新**（新/改文件浮顶），文件加入/移出聊天时失效。
  - 设计**与模型无关**：无论面向哪个模型发同一张图 [aider.chat/docs/repomap.html；aider.chat/2023/10/22/repomap.html；marovi.ai/Aider/zh]。
- **@-mentions / 显式上下文**：Cursor 的 `@`、Continue 的 Context Providers（`@` 代码库检索/当前文件/高亮代码/文档）、Copilot 的 `#file`、Windsurf 的 `.windsurfrules` [docs.continue.dev；vscode.com.tw/blogs/2025/02/24/introducing-copilot-agent-mode]。
- **Auto-context / 自动收纳相关文件**：Cline 自动把相关文件纳入上下文；Continue 自动把高亮代码、当前文件作为 context。

**对 Web 工具的建议**：先用 Aider 式 repo map（tree-sitter + 图排序 + token 预算）做"零基础设施"的上下文，再按需叠加 embedding 索引。检索结果一律"以文件形式按需读取"，别预注入整库。

### 3.4 Edit Application（编辑应用）

**三种格式（来自 Aider 排行榜与 dreaming.press 综述）**[deepwiki.com/dwash96/aider-ce/5.1-edit-strategies-overview；dreaming.press/posts/coding-agent-edit-formats-diff-vs-whole-file]：

| 格式 | 机制 | Token 成本 | 应用可靠性风险 |
|------|------|----------|--------------|
| **Whole-file** | 模型重出整个文件 | 高（随文件大小线性增长），易静默丢无关代码 | 最低（无需解析 diff），但易丢代码 |
| **Unified diff** | 模型出 `@@` hunk 补丁 | 低 | 中（上下文行/位置易漂移） |
| **Search/Replace** | "精确匹配这段 → 换成那段" | 低~中 | 中（search 块必须逐字唯一，否则失败） |

- **Aider `diff` 格式（search/replace 块）确切语法**（git merge-conflict 风格标记）[deepwiki.com/dwash96/aider-ce/5.1-edit-strategies-overview]：
  ```
  path/to/file.py
  <<<<<<< SEARCH
  # 原代码片段（必须逐字、唯一）
  =======
  # 新代码片段
  >>>>>>> REPLACE
  ```
  Aider 用 `find_original_update_blocks()` 解析，带模糊匹配回退。
- **Aider 还支持** `whole`（整文件）、`udiff`（标准统一 diff，借模型训练熟悉度）、`patch`（git patch）、`architect`（两阶段）。格式按模型能力选（model-settings.yml）：如 gpt-4o→diff，claude-3.5→diff/editor-diff，gpt-3.5→whole，gpt-4.1→patch，deepseek-r1→architect [deepwiki.com/...]。
- **Cline `replace_in_file`**：`old_string`→`new_string` 片段替换；渲染成统一 diff 预览（旧版 `@cline/ui` 的 `makeUnifiedDiff` 曾误把片段当整文件锚定第 1 行，后修复为片段用中性 `@@ … @@`）[github.com/cline/cline 近期提交 #13151]。
- **Cursor/Composer**：多文件编辑后自动 apply，diff 预览 + 检查点回滚。
- **Copilot**：经"推测解码端点（speculative decoder endpoint）"应用修改，性能优化中 [baoyu.ai/translations/introducing-copilot-agent-mode]。

**关键最佳实践——fast-apply（小模型应用）**：整文件格式总是能 apply 但贵；diff 便宜但常因模型上下文与文件不一致而失败。解法：**让大模型"偷懒"起草松散编辑，交给一个便宜的 7B 级小模型以数千 token/秒做机械合并**。这是降低编辑失败率、提升吞吐的工程杠杆 [dreaming.press/posts/coding-agent-edit-formats-diff-vs-whole-file]。

**diff 如何展示给用户并审批**：几乎都做"统一 diff 预览 + 逐文件/逐块接受拒绝"。Cursor 检查点、Copilot Undo Last Edit、Cline 显式批准、Windsurf Flows、Continue 批准 spinner，都是同一范式。

### 3.5 编辑器架构参考（Web 端）

**VS Code 本身怎么工作（作为对照）**[theia faq 佐证通用架构]：
- **Monaco**：核心编辑器控件（语法高亮、IntelliSense、diff）。
- **Extension Host**：插件在独立进程跑，UI/核心通过 RPC 通信，保证插件崩了不拖垮编辑器。
- **LSP（Language Server Protocol）**：编辑器↔语言服务器（gopls、pyright…）解耦，提供补全/跳转/诊断。
- **DAP（Debug Adapter Protocol）**：统一调试抽象。
- **Electron**：桌面壳（主进程 + 渲染进程）。

**Web 端三类选项对比**：

| 方案 | 是什么 | 优点 | 缺点 / 适用 |
|------|--------|------|-----------|
| **Monaco** (github.com/microsoft/monaco-editor) | VS Code 同款编辑器控件，纯前端 | 与 VS Code 体验一致；TS 类型、diff、多语言开箱即用；你已在用 | 体积大（~数 MB）；本质是"控件"不是 IDE，文件/终端/Git 需自己搭；V8 下性能很好 |
| **CodeMirror 6** (codemirror.net) | 轻量模块化编辑器框架 | 体积极小、可深度定制、移动端友好、可控性高 | 需自己拼装 LSP/补全/UI；生态不如 Monaco 全；适合"编辑器即核心、要极致控制"的场景 |
| **Eclipse Theia** (theia-ide.org) | 完整 Web IDE 框架（TypeScript+Node，复用 Monaco/LSP/DAP，**非 VS Code fork**） | 一套代码跑浏览器+桌面；**兼容 VS Code 扩展（Open VSX）**；模块化可白标；EPL-2.0 可商用 | 最重；要自己托管后端（LSP/DAP/终端/文件系统）；适合"要做完整 IDE 产品"而非"嵌入一个编辑器" |

**对类 Cursor Web 工具的具体建议**：
1. **编辑器控件**：继续用 **Monaco**（你已用，且与 VS Code 语义一致，迁移成本低）。需要更轻/更可控时可混用 CodeMirror 6 做特定面板。
2. **语言智能**：通过 **LSP**（如 `vscode-languageclient` 的 Web 移植，或 `monaco-languageclient`）连接语言服务器；诊断可像 OpenCode 那样直接作为 `diagnostics` 工具暴露给 agent [github.com/opencode-ai/opencode]。
3. **架构分层**：前端 Monaco + 后端（Node/Go/Rust）跑 LSP/DAP/终端/文件系统抽象，前后端 **WebSocket/JSON-RPC** 通信（Theia 即此模式 [wenku.csdn.net/doc/1d4cm8qpkg]）。Agent 循环放后端，前端只负责渲染 diff 与审批。
4. **不要重造 VS Code**：若目标是"嵌入代码编辑器 + AI agent"，Monaco + 自研后端足够；只有要做"完整可扩展 IDE"才上 Theia。

### 3.6 System Prompt / 指令工程（公开结构）

- **Cursor**：Agent = **Instructions（system prompt + rules）+ Tools + Model** 三段编排，并"为每个前沿模型专门调指令与工具" [cursor.com/docs/agent/chat/summarization]。规则来自 `.cursor/rules`。
- **Cline**：系统提示指导模型"先思考、逐步用工具、以 `attempt_completion` 收尾"；Plan Mode 时只允许只读工具。规则来自 `.clinerules`。
- **Aider**：每种 edit format 有独立 prompt 文件（`editblock_prompts.py`、`udiff_prompts.py`、`wholefile_prompts.py`、`architect_prompts.py`）；architect 模式拆"规划提示 + 编辑提示"两份 [deepwiki.com/dwash96/aider-ce/5.1-edit-strategies-overview]。
- **Copilot**：后端 system prompt + 工具描述；工作区结构摘要 + 机器上下文（OS）随请求注入 [baoyu.ai/translations/introducing-copilot-agent-mode]。
- **Windsurf**：`.windsurfrules`（项目级指令）+ **Memories**（自动提取持久化）+ Cascade 内置 flow 上下文 [myengineeringpath.dev/tools/windsurf-ai]。
- **Zed**：**Rules Library** 与 Custom Profiles 配合，按前台/后台 agent 切换工具开关 [zed.dev/blog/container-use-background-agents]。
- **Goose**：`AGENTS.md` / `.goosehints` / `CLAUDE.md` 注入指令；支持 **ACP** [github.com/block/goose]。
- **Continue**：system prompt 可自定义，Context Providers 决定注入内容；支持 chatmode 文件 [docs.continue.dev]。

**共性模板**（可复制）：
```
SYSTEM: 你是编码 agent。只能经工具改文件。每步先 reasoning 再调一个工具。
TOOLS: [read_file, edit_file, grep, glob, bash, web_fetch, ask_followup, attempt_completion]
RULES: (项目级 .rules 文件注入：技术栈、约定、禁区)
LOOP: 调用工具 → 观察结果 → 必要时再调，直到 attempt_completion。
SAFETY: bash/写操作需用户批准；编辑以 diff 预览；提供 undo。
```

---

## 四、可复制的最佳实践（实现指引）

下面是可照做的工程清单，按优先级排序。

### A. Agent Loop（先做最小可用）
1. **用 ReAct + function calling**：维护 `messages` 列表，每轮把工具结果 `tool` role 回灌。循环直到模型返回 `attempt_completion` 或达步数上限（建议 50~200 步，可配）。
2. **加显式 Plan Mode**：用一个 system prompt 开关，plan 模式只允许 read/grep/glob，禁止 write/bash；用户批准后切 act。参考 Cursor/Cline/Windsurf。
3. **错误回灌**：工具错误（编译失败、测试红、命令非零退出）**捕获后作为 observation 返回**，让模型自纠——这是 Copilot "验证-自修"环的核心 [github.blog/.../agent-mode-101]。
4. **Undo/检查点**：每次"应用编辑"前对受影响文件做快照（git stash 或内存快照），提供 `/undo` 或 "Undo Last Edit"。低成本高信任。

### B. Tool System
5. **工具用 JSON Schema 定义**，description 写清"何时用、怎么用"。先实现 7 个最小集：`read_file`(带 offset/limit)、`write_file`、`edit_file`(old→new)、`grep`、`glob`、`bash`、`attempt_completion`。
6. **审批模型**：默认写/命令需批准；提供 tool policy 让常用工具（如 read/grep）自动放行。不要让 terminal 静默执行。
7. **接 MCP**：把工具系统做成"内置工具 + MCP 动态加载"，复用生态。注意工具总数上限（参考 Copilot 128），过多时让用户筛。

### C. Context Management（推荐路线：先轻后重）
8. **第一步：Aider 式 Repo Map**（零基础设施、可复制）：
   - 用 tree-sitter 对每个源文件抽顶层定义（function/class/method）及引用。
   - 建"文件-文件"依赖图（import/引用边），按符号被引用频次做图排序（PageRank 类）。
   - 取 Top-N 塞进固定 token 预算（如 1k~4k），随模型上下文窗口缩放。
   - 文件变更时增量重算，加/移出聊天时失效。
   - 来源：aider.chat/docs/repomap.html。
9. **第二步（按需）：加embedding 索引**——tree-sitter 分块（≤1500 字节）→ embed → 向量库。但**检索结果以文件形式按需读取，不预注入整库**（Cursor 范式，省 ~47% token [lumina.shawnxie.top/...]）。
10. **本地正则/triigram 索引**：保证"模型刚写的代码"能被自身 grep 到——Cursor 因向量索引有滞后而补了一层本地实时索引，这点很关键。
11. **@-mention + 项目规则文件**（`.rules`/`.cursorrules` 风格）作为常驻上下文。

### D. Edit Application（最关键的正确性杠杆）
12. **默认用 search/replace（Aider 块语法）或 old→new 片段替换**，不要用裸 unified diff 作为主格式——可靠性更高。
13. **实现 apply 校验**：search 块必须**逐字且唯一**；不匹配或多次出现则拒绝并让模型修正（Claude Code 式严格）。可加模糊匹配回退（Aider 式）降低失败率。
14. **fast-apply 小模型**：大模型起草编辑，7B 级小模型做机械 apply/merge，提升吞吐与成功率 [dreaming.press/...]。
15. **diff 预览 + 逐块审批**：统一 diff 渲染（可复用 `@pierre/diffs` 类库或自研），用户逐文件/逐块接受。

### E. 编辑器（Web）
16. **继续 Monaco** 做编辑/ diff 控件；LSP 经 `monaco-languageclient` + WebSocket 后端提供诊断，并把 `diagnostics` 暴露给 agent（OpenCode 范式）。
17. **Agent 循环放后端**，前端只渲染 diff 与审批 UI，避免把大上下文塞进浏览器主线程。
18. 若未来要"完整 Web IDE + VS Code 插件兼容"，再用 Theia（EPL-2.0，可商用白标）[theia-ide.org/docs/faq]。

### F. 多智能体（进阶）
19. **并行/子代理**：Zed 的 `spawn_agent` + git worktree 隔离、Roo 的 Boomerang、OpenCode 的 `agent` 工具都证明"大任务拆子任务、各自干净上下文、结果合并"优于单上下文硬撑 [zed.dev/blog/parallel-agents；github.com/RooCodeInc/Roo-Code]。Web 工具可在后端用 worktree/沙箱实现隔离。

---

## 五、推荐研究的开源仓库（带 URL）

| 仓库 | 语言 | 为什么值得读 | 看什么 |
|------|------|------------|--------|
| **Aider** — github.com/Aider-AI/aider | Python | repo map + 多 edit format 的"教科书"实现 | `aider/coders/`(editblock/wholefile/udiff/architect)、`aider/repomap.py`、`aider/prompts/` |
| **Cline** — github.com/cline/cline | TS | 最流行的 tool-use agent 扩展；现已抽成 SDK（`apps/`、`sdk/`） | `sdk/` 的 agent core、工具定义、`@cline/ui` 的 diff 渲染 |
| **Roo Code** — github.com/RooCodeInc/Roo-Code | TS | Cline fork；自定义 Modes + Boomerang 子任务 + 文件编辑策略 | modes 配置、Boomerang 编排、edit strategy |
| **Continue.dev** — github.com/continuedev/continue | TS | 跨 IDE 扩展 + Context Providers + Agent/Plan/Chat 三模式 | `context/` providers、`agent` 模式、MCP 集成 |
| **OpenCode** — github.com/opencode-ai/opencode（已归档→ github.com/charmbracelet/crush） | Go | 终端 agentic CLI 的清晰模块化架构 | `internal/llm`、`internal/lsp`、`internal/session`、`internal/tui` |
| **Goose** — github.com/block/goose | Rust | 扩展式 agent（shell/fs/http）+ ACP + Hooks | `crates/`、extension 机制、`.goosehints` |
| **Zed** — github.com/zed-industries/zed | Rust | CRDT 协作 + 并行智能体 + AI 为架构一等公民 | `crates/agent`、`crates/collab`(CRDT)、`crates/gpui` |
| **VS Code** — github.com/microsoft/vscode | TS | 编辑器/Extension Host/LSP/DAP 参照实现 | `src/vs/editor`(Monaco 同源)、extension API、LSP 客户端 |
| **Monaco** — github.com/microsoft/monaco-editor | TS | 你的编辑器控件源码 | diff 编辑器、language features |
| **CodeMirror 6** — github.com/codemirror/dev | TS | 轻量编辑器替代方案 | `@codemirror/*` 模块 |
| **Eclipse Theia** — github.com/eclipse-theia/theia | TS | 完整 Web IDE 框架 + VS Code 扩展兼容 | `packages/`、LSP/DAP 集成、Agent Client Protocol |
| **Agent Client Protocol** — github.com/agentclientprotocol/agentclientprotocol | — | agent 与 IDE 间通信标准（Zed/Cline/Goose 都在用） | 协议规范 |

---

## 六、来源引用

- Aider Repo Map：https://aider.chat/docs/repomap.html ；博客 https://aider.chat/2023/10/22/repomap.html
- Aider Edit Strategies（DeepWiki）：https://deepwiki.com/dwash96/aider-ce/5.1-edit-strategies-overview
- Aider 编辑格式综述：https://marovi.ai/Aider/zh ；https://dreaming.press/posts/coding-agent-edit-formats-diff-vs-whole-file
- Cursor 索引逆向（双索引/Merkle/向量）：https://www.besthub.dev/articles/how-cursor-instantly-understands-massive-codebases-8cd15ec339b1 ；https://lumina.shawnxie.top/article/how-does-cursor-index-your-codebase-3945000b ；https://towardsdatascience.com/how-cursor-actually-indexes-your-codebase/
- Cursor Agent 文档：https://cursor.com/docs/agent/chat/summarization ；Background Agents https://prod.cursor.com/cn/help/ai-features/background-agents ；Agentic Coding https://cursor.com/zh-Hant/help/ai-features/agentic-coding
- Windsurf/Cascade：https://pickuma.com/for-dev/windsurf-ide-review-ai-native-code-editor ；https://baeseokjae.github.io/posts/windsurf-cascade-deep-dive-2026 ；https://myengineeringpath.dev/tools/windsurf-ai ；https://dev.to/stacknotice/windsurf-ide-complete-guide-2026-4p3p ；https://bundl.run/apps/windsurf
- Cline：https://github.com/cline/cline ；文档 https://docs.cline.bot/cline-overview
- Roo Code：https://github.com/RooCodeInc/Roo-Code （文档站 docs.roocode.com 已于 2026-05-15 关停，社区 fork 见 Zoo-Code）
- Continue.dev：https://docs.continue.dev/ ；Agent Quick Start https://docs.continue.dev/ide-extensions/agent/quick-start
- GitHub Copilot Agent Mode：https://github.blog/ai-and-ml/github-copilot/agent-mode-101-all-about-github-copilots-powerful-mode ；中文翻译 https://baoyu.ai/translations/introducing-copilot-agent-mode ；架构(DeepWiki) https://deepwiki.com/nakamacchi/ghc-practical-guide/3.2-technical-architecture
- Zed：Parallel Agents https://zed.dev/blog/parallel-agents ；Container Use 后台 agent https://zed.dev/blog/container-use-background-agents ；CRDT https://zed.dev/blog/crdts ；首页 https://zed.dev/
- OpenCode：https://github.com/opencode-ai/opencode （已归档→ https://github.com/charmbracelet/crush ）
- Goose：https://github.com/block/goose
- 编辑器对比：Monaco https://github.com/microsoft/monaco-editor ；CodeMirror https://codemirror.net ；Theia https://theia-ide.org/ 与 FAQ http://theia-ide.org/docs/faq
- 索引 vs 按需检索（Claude Code 反例）：https://atlan.com/know/ai-agent/ai-agent-harness/cursor-vs-windsurf-vs-claude-code-data-context

---

### 落地一句话建议
**最小可行路径**：Monaco（你已用）做前端 + 后端 ReAct agent（7 工具 + 审批）+ Aider 式 repo map 做上下文 + search/replace 块做编辑（加 fast-apply 小模型）+ diff 预览审批 + git 检查点。先把这条跑通，再按需叠加 embedding 索引与并行子代理。
