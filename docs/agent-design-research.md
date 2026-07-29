# 成熟 AI 编程 Agent 设计调研

> 调研时间：2026-07-29
> 目的：为 pancode 的 **Phase 1（Agent 框架）** 提供行业对标与设计输入。
> 覆盖维度：权限模式、附件上传、记忆、上下文、自我进化、灵魂设定。
> 样本产品：Cursor、Claude Code、Windsurf(Cascade)、Cline、Aider、GitHub Copilot、OpenAI Codex、VS Code Autopilot。

---

## 0. 一句话结论

行业已经形成高度一致的共识：

1. **权限**：默认"询问"，提供多档模式 + OS 级沙箱兜底，**分层防御**（规则层 + 沙箱层 + 网络隔离层）是标配。
2. **附件**：图片/文件/语音是多模态上下文入口；`@提及` 是精准注入上下文的主通道。
3. **记忆**：区分"人写的规则（版本化、强制）"与"自动记忆（本地、易漂移）"，持久知识优先沉淀为规则/AGENTS.md。
4. **上下文**：`@精准注入 > 全量`，配自动压缩 + 预算可视化 + prompt cache。
5. **自我进化**：把"重复纠正"提炼成规则，把"可复用流程"沉淀成工作流/Skill，让 Agent 自我积累。
6. **灵魂设定**：`CLAUDE.md / .cursorrules / copilot-instructions` 本质是"人格+价值观+禁忌+工作流"，支持多 Persona 切换。

---

## 1. 权限模式（多档 + 沙箱 + 分层防护）

| 产品 | 模式/档位 | 关键机制 |
|---|---|---|
| **Cursor** | 三模式：`Run in Sandbox`(默认) / `Ask Every Time` / `Run Everything` | 默认在受限沙箱跑命令（限制文件系统与网络）；另有 6 个**独立保护开关**：File-Deletion / Dotfile / External-File / Browser / MCP Allowlist；3.6 新增 **Auto-Review**：分类子 agent 对每次工具调用判 allow / sandbox / redirect / escalate |
| **Claude Code** | 五模式：`default` / `acceptEdits` / `plan` / `auto` / `bypassPermissions`（`--dangerously-skip-permissions`） | `Shift+Tab` 实时切换；`settings.json` 写 `allow`/`deny` 规则（如 `Bash(git *)`、`Bash(rm -rf *)`）；`PreToolUse` Hook 拦截危险操作 |
| **Cline / Roo** | `YOLO` 模式 + 细粒度权限 | 逐条确认：读文件 / 终端 / 浏览器 / MCP 各有开关；`Plan & Act` 先计划后执行 |
| **VS Code Autopilot** | 三档：`Default` / `Bypass` / `Autopilot`(预览) | Bypass 自动批准所有调用并自动重试；Autopilot 额外"自动回答阻塞问题 + 循环到 `task_complete`" |
| **OpenAI Codex** | 沙箱隔离优先 | 权限档 `:read-only` / `:workspace` / `:danger-full-access`；本地用 bubblewrap + seccomp 做 OS 级强制 |
| **pancode(现状)** | 单一"写操作人工确认" | 已实现 `write_file/delete_file/run_command` 弹确认卡 + 终端 BASE/STRICT 黑名单沙箱 |

**行业共识（值得 pancode 采纳）**
- 默认姿态是"问"，不是"放行"。
- **沙箱是底层安全网**：即使规则缺失或被注入，OS 层仍能兜底（这正是我们 Phase 0 终端沙箱的方向）。
- **分层防御**：规则层（allow/deny/ask）+ 沙箱层（文件系统/网络隔离）+ 网络隔离层（防数据外泄）。
- 提供 `Ask / Auto(允许安全操作) / Full(全自动)` 三档模式，而非只有"开/关"。

**→ pancode Phase 1 建议**
- 新增权限模式：① 询问模式(默认) ② 半自动(允许读/测试/安全命令，写操作仍确认) ③ 全自动(需明确危险开关仍拦截)。
- 增加 `allow`/`deny` 规则配置（命令级 + 文件级），复用现有安全黑名单作为 deny 兜底。
- 保留并强化终端沙箱；未来可加"命令级自动放行白名单"（类似 Cursor 的 Add to allowlist）。

---

## 2. 附件上传（图片 / 文件 / 语音 = 多模态上下文）

| 产品 | 附件能力 |
|---|---|
| **Cursor** | 拖放 / `Ctrl+V` 粘贴截图；语音输入；`@提及`：`@file` `@folder` `@Docs`(已索引文档) `@Terminals`(终端输出) `@Past Chats`(历史对话) `@Commit`/`@Branch`(Git 差异) `@Browser`(内置浏览器)；输入框旁"上下文环"显示窗口占用 |
| **Claude Code** | 图片 `Ctrl+V`(Mac) / `Alt+V`(WSL·Win) / 拖放 / 路径引用；支持 PNG/JPEG/GIF/WebP；单张 ≤5MB、>1568px 自动降采样；token≈宽×高/750 |
| **Windsurf/Cline** | 设计稿→代码、视觉 bug 调试、架构图识别；Cline 还能控浏览器自动操作 |
| **GitHub Copilot** | 聊天可贴图、引用文件/Selection |

**典型用法（图片价值最高）**
- 视觉 bug：截图直接贴，省去文字描述。
- 设计→代码：Figma/截图 → 实现组件，再贴渲染图对比迭代。
- 架构图：流程图/白板草图 → 生成接口或实现。

**→ pancode Phase 1 建议**
- 聊天输入框支持 **图片粘贴/拖放**，转 base64 或临时文件后作为多模态上下文发给模型（需模型支持视觉）。
- 实现 **`@file` / `@folder` / `@terminal`** 提及：把指定上下文注入 prompt。
- 加"上下文预算条"提示占用，接近上限时触发自动压缩。

---

## 3. 记忆（持久化、跨会话）

| 产品 | 机制 | 加载方式 |
|---|---|---|
| **Claude Code** | ① `CLAUDE.md`（人写，分层：managed→`~/.claude`→项目→`.local`）② `auto memory`（Claude 自写，从更正/偏好中学习，首 200 行/25KB 加载） | 每次会话开头自动加载，视为"上下文"非"强制配置" |
| **Windsurf** | `Cascade Memories`（自动生成，存 `~/.codeium/windsurf/memories/`，per-workspace，不入库）+ `Rules`（`.windsurf/rules/`，激活模式：`always_on`/`glob`/`model_decision`/`manual`） | 自动检索相关记忆；规则按 frontmatter 激活 |
| **Cursor** | `.cursor/rules/*.mdc`：`description`/`globs`/`alwaysApply`；4 激活模式（always/auto-attached/agent-requested/manual） | AI 读 description 决定是否加载全文 |
| **Copilot** | `.github/copilot-instructions.md` + `.github/instructions/*.instructions.md`（`applyTo` glob） | Chat/Review/Agent 自动套用 |
| **Cline** | `.clinerules/`（`paths` frontmatter 限定文件） | 合并为统一规则集 |
| **pancode(现状)** | 无（仅有会话内上下文） | — |

**关键区分**
- **规则（人写）**：版本化、团队共享、强制遵循 → 适合"编码规范/架构约束"。
- **记忆（自动）**：本地、易漂移、不入库 → 适合"一次性事实/偏好"。
- 共识：**持久知识优先写成规则或 AGENTS.md**，不要依赖自动记忆。

**→ pancode Phase 1 建议**
- 引入 `.pancode/rules/*.md`（支持 `globs`/`alwaysApply`）作为"强制规则层"。
- 引入 **auto memory**：Agent 在对话中发现用户更正/偏好时，自动写入 `memory/`(类似我们已有的 workspace memory)，下次会话加载。
- 明确区分"规则(强制)"与"记忆(参考)"两种加载语义。

---

## 4. 上下文（检索 / 压缩 / 预算）

| 产品 | 做法 |
|---|---|
| **Cursor** | `@提及` 精准注入；上下文环可视化占用；接近满时自动把早期对话压缩成摘要 |
| **Claude Code** | `/compact` 手动压缩；`/clear` 清空上下文；subagents 各自独立上下文（防主会话膨胀）；停留同会话享 prompt cache（省 50–60%）；`/init` 自动生成 CLAUDE.md |
| **Cline** | 完整上下文窗口从头开始；usage 可视化 |
| **Aider** | `repo map`（静态代码分析，无 RAG/向量库）做上下文索引 |
| **Windsurf** | 持久记忆减少重复读码，降低延迟 |

**共识**
- `@精准注入 > 全量塞入`。
- 自动压缩 + `/clear` 是控制成本的刚需。
- token 预算与成本意识（便宜模型给子 agent、避免无谓联网搜索）。

**→ pancode Phase 1 建议**
- 实现 `@file/@folder` 注入 + **上下文预算条**。
- 对话接近上限时自动 `compact`（摘要化早期消息）。
- 可选 `repo map`（轻量静态分析）作为无 RAG 的上下文索引。
- 复用我们已有的 workspace memory 作为跨会话"项目记忆"。

---

## 5. 自我进化（规则生成 / 自学习 / 工作流沉淀）

| 产品 | 自进化机制 |
|---|---|
| **Claude Code** | `auto memory`：从你的更正自动写笔记；`Hooks`(守门)/`Skills`(知识包)/`Agents`(并行) 三层把经验固化；`/goal` 目标驱动跑到条件满足 |
| **Windsurf** | `Memories` 自动生成 + "create a memory of …"；Rules 手动沉淀 |
| **Cursor** | 把重复 prompt 提炼成 rule；Auto-Review 用分类子 agent 持续学习判罚策略 |
| **OpenAI Codex** | `/goal` 设完成条件，Agent 跑到满足为止 |
| **VS Code Autopilot** | `task_complete` 工具决定何时停止（去"退出摩擦"） |
| **Cline** | 系统提示公开、社区快速吸收新模型；`Skills`? 复用 Claude 系机制 |

**三类可沉淀资产**
1. **规则/约束**：重复纠正 → 写入 `.pancode/rules`。
2. **知识包/Skill**：可复用流程 → 固化为步骤模板（我们已有 Skill 机制可借鉴）。
3. **工作流**：多步任务 → 固化为可触发的工作流（slash command / `/goal`）。

**→ pancode Phase 1 建议**
- 增加"**把本次会话有效决策 / 被拒操作沉淀为规则或记忆**"的轻量入口（如会话结束时提示"是否将 X 存入记忆"）。
- 引入可复用**工作流模板**（类似 Cursor 的 Automations / Claude 的 `/goal`）。

---

## 6. 灵魂设定（Persona / System Prompt / 自定义 Agent）

| 产品 | 实现 |
|---|---|
| **Cursor** | `.cursorrules`(旧) → `.cursor/rules/*.mdc`；可多规则组合 |
| **Claude Code** | `CLAUDE.md`(人格+价值观+工作流) + `--append-system-prompt` + 自定义 `/agents`（`.claude/agents/`，项目/用户级） |
| **Windsurf** | `global_rules.md` + `.windsurf/rules/`；Rules 即人格约束 |
| **Copilot** | `.github/copilot-instructions.md`(仓库级人格) |
| **Cline** | 系统提示公开可改；`.clinerules/` 项目人格 |
| **OpenAI Codex** | 沙箱内的系统提示 + 权限档 |

**"灵魂"的构成**
> 持久化的**角色定位 + 价值观/原则 + 禁忌(不要做什么) + 工作流偏好**；支持多 Persona 切换（如"严谨后端工程师""重设计感的前端""安全第一的 SRE"）。

**→ pancode Phase 1 建议**
- 增加"**智能体设定**"面板：可视化编辑 system prompt / 人格预设，存为 `.pancode/agents/*.md`。
- 提供 2–3 个开箱预设（通用全栈 / 前端设计向 / 后端严谨向）。
- 与"规则层"解耦：人格=风格与原则，规则=硬约束。

---

## 7. 综合对比矩阵

| 维度 | Cursor | Claude Code | Windsurf | Cline | Aider | Codex | **pancode 现状** |
|---|---|---|---|---|---|---|---|
| 权限模式 | 3 档+沙箱+6开关+Auto-Review | 5 档+allow/deny+Hooks | Memories+Rules | YOLO+细粒度 | `--yes` | 沙箱档 | 写确认+终端黑名单 |
| 附件上传 | 图/语音/@提及 | 图(粘贴/路径) | 图/文档 | 图/浏览器 | 文件 | — | 仅文本 |
| 记忆 | .cursor/rules | CLAUDE.md+auto memory | Memories+Rules | .clinerules | repo map | — | 无 |
| 上下文 | @提及+压缩+环 | /compact+/clear+subagent | 持久记忆 | 全量 | repo map | 沙箱 | 仅会话内 |
| 自我进化 | rule 提炼 | auto memory+Skills | Memories | 社区 | 静态分析 | /goal | 无 |
| 灵魂设定 | .cursorrules | CLAUDE.md+/agents | global_rules | .clinerules | — | 系统提示 | 无 |

---

## 8. 对 pancode Phase 1 的落地清单（建议优先级）

**P0（体验与对齐行业底线）**
1. 聊天框支持**图片粘贴/拖放** + `@file/@folder/@terminal` 提及注入。
2. 权限模式三档：`询问` / `半自动` / `全自动`，并配 `allow`/`deny` 规则。
3. **上下文预算条** + 接近上限自动 `compact`。

**P1（记忆与人格）**
4. `.pancode/rules/*.md` 规则层（globs/alwaysApply 激活）。
5. **auto memory**：会话中发现的偏好/更正自动写入 `memory/`，跨会话加载。
6. **智能体设定面板**：可编辑人格预设，存 `.pancode/agents/*.md`。

**P2（自我进化）**
7. 会话结束"沉淀为规则/记忆"的轻量入口。
8. 可复用**工作流模板**（目标驱动 `/goal` 式）。

**安全基线（贯穿）**
- 始终保留 Phase 0 的写操作确认 + 终端沙箱作为兜底；全自动模式也保留"高危命令/越界写"硬拦截。

---

## 参考来源（2026-07 检索）
- Every Dev — Every Major AI Coding Tool Now Has a No-Approval Mode
- ai-tldr — Coding Agent Permissions: Approvals, Allowlists, and YOLO Mode
- blog.vibecoder.me — Cursor Auto-Review Mode (3.6)
- slashskill — Vibe Coding Best Practices in 2026
- Anthropic Docs — Claude Code Memory (CLAUDE.md + auto memory)
- besthub.dev — Taming Claude Code (Hooks/Skills/Agents)
- toolhalla.ai — Cursor vs Windsurf vs Cline 2026
- aicodingcompare — GitHub Copilot vs Cursor vs Windsurf 2026
- agentrulegen — Cursor Rules vs CLAUDE.md vs Copilot Instructions
- docs.windsurf.com / docs.devin.ai — Cascade Memories & Rules
- cursor.com/docs — Agent Prompting / @ Mentions / 图像输入
- felloai.com / claudecodetips.com — Claude Code 图像粘贴全平台指南
