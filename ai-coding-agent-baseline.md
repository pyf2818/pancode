# 主流 AI 编码 Agent 产品能力基线（对标 pancode）

> 说明：Claude Code / Cline / Cursor / Aider 为官方文档全文核实；Codex CLI 与 GitHub Copilot CLI 官方站 fetch 被拒（403 / ECONNRESET / 正文截断），结论来自官方站摘要 + 仓库代码片段，已在文中标注可信度。

## 1. Claude Code

**A 权限与安全**（code.claude.com/docs/en/sandboxing、/permissions）
- 沙箱只包 shell 子进程：macOS 内置 Seatbelt，Linux/WSL2 靠 bubblewrap + socat + 可选 seccomp，**原生 Windows 不沙箱（须 WSL2）**。写限于工作目录 + `--add-dir`；读默认覆盖整机（含 `~/.ssh`、`~/.aws/credentials`）；网络无直连，全部经本机 proxy 按 `network.allowedDomains` 逐 host 比对，默认空集。
- **沙箱失败默认降级为「不沙箱继续跑」**，硬失败须 `sandbox.failIfUnavailable=true`。
- 内置 Read/Edit/Write/WebFetch、hooks、本地 MCP、LSP、插件 monitor 都在**沙箱之外**，只受权限规则管——`denyRead` 不拦 Read 工具。
- 权限求值 **deny → ask → allow，首次匹配即定，不看具体度**：宽 deny（`Bash(aws *)`）压过窄 allow。裸工具名 deny 会把工具**从模型上下文里摘掉**；`Tool(param:value)` 仅 deny/ask 可用，且**禁止匹配 Bash.command、file_path、url 等主内容字段**（复合命令可绕过）。
- 6 种模式：default / acceptEdits / plan / auto（后台 classifier 代审批）/ dontAsk / bypassPermissions；组织可用 `permissions.disableBypassPermissionsMode` 关掉。
- 审批持久化到 **git 仓库根** `.claude/settings.local.json`；**文件修改的批准只到会话结束、不落盘**。审批可附评论，No + 评论 = 把拒绝理由喂回模型继续。
- 4 级配置（user / project / local / managed）列表式合并、被 watch 热重载，managed 最高且无法被本地放宽。

**B 上下文管理**（/memory）
- CLAUDE.md 从文件系统根到 cwd 全部**拼接**；子目录的 CLAUDE.md **懒加载**（首次在该目录读/写文件才载入一次）。
- 建议单文件 <200 行，超出拆 `.claude/rules/`（glob 匹配时加载、软链接跨项目共享）；`@import` 递归最深 4 跳，指向工作目录外算 external、首次弹审批。
- **Auto memory**（agent 自写笔记）独立通道：按仓库存、跨 worktree 共享、每会话只载前 200 行 / 25KB。
- auto-compact 接近上限自动压缩；`/rewind` 菜单内直接 "Summarize from / up to here" 双向定向压缩，并可在 `add context (optional)` 栏写引导语。
- CLAUDE.md 是**上下文不是强制配置**，硬约束只能靠 PreToolUse hook。

**C 工具体系**
- 内置读写编辑 / Glob / Grep / NotebookEdit / WebFetch / WebSearch / Task-Agent / Skill / Bash；Read 超 2000 行或 1MB 截断。
- 30+ hook 事件（SessionStart/End、UserPromptSubmit、Stop/StopFailure、PreToolUse/PostToolUse、SubagentStart/Stop、PreCompact、Notification、ConfigChange 等），PreToolUse 可硬阻断。
- MCP + Plugins + Skills + slash commands + 自定义 subagent（YAML frontmatter：name / description / tools / model / effort / permissionMode / hooks / skills / omitClaudeMd）。

**D 可观测性与可控性**
- `/permissions`、`/sandbox` 列出规则及其来源文件，**Claude 工作时也能改，改动从同一回合的下一次 tool call 生效**（v2.1.234+）。
- Checkpointing：每个「开启回合的 prompt」对其间所有编辑工具改动做快照，保留最近 100 个；`/rewind`（空输入双击 Esc）可选 Restore code / conversation / both。限制：Bash 造成的文件改动不跟踪、后台子 agent 的编辑不恢复、外部与并发会话改动不跟踪、symlink/hardlink 跳过（提示 skipped N files）。快照随会话保存，`--resume` 后仍可 rewind；默认 30 天清理（`cleanupPeriodDays`）。

**E 交互体验**：Plan mode（只读探索 → 生成可评审方案）；Shift+Tab 快速切档；`/rewind` 把「试错—撤销」成本压到接近零；审批框 Tab 写评论。

**F 工程化**
- Subagents：内置 Explore / Plan（只读，且跳过 CLAUDE.md 与 git status 快照）/ general-purpose / claude；可前台/后台、可 resume、可 fork 会话、可嵌套派发；独立上下文 + 独立工具集 + 独立权限模式 + 独立 hooks/skills/memory。各 subagent description 总和超 15000 token 启动告警。
- 之上还有后台 agent 视图、跨会话消息、**agent teams**（captain/member DAG + requirements → implementation → verification → review → integration 质量门 + 合约修订 + 归档）、Skills / Plugins / headless / SDK / channels / scheduled tasks / goals。

## 2. OpenAI Codex CLI（snippet 级，正文 403）

**A**：两个正交旋钮——`sandbox_mode`（read-only / workspace-write / danger-full-access）× `approval_policy`（untrusted / on-failure / on-request / never）；出厂默认 workspace-write + on-request，workspace-write 下网络默认关。实现：macOS Seatbelt（只用 `/usr/bin/sandbox-exec` 防 PATH 注入）、Linux bubblewrap + `no_new_privs` + seccomp（`codex-rs/linux-sandbox/src/landlock.rs`）、**Windows 已有原生沙箱**（不必 WSL）。`writable_roots` 追加可写目录、protected paths（`.git` 等元数据）只读；execpolicy 规则把特定命令提到沙箱外。**新版 permission profiles（`default_permissions` + `[permissions]`）与旧 `sandbox_mode` / `sandbox_workspace_write.*` 互斥不叠加**。
**B**：AGENTS.md 在启动时构建一次指令链（`CODEX_HOME`，默认 `~/.codex`）：全局 `AGENTS.override.md` > `AGENTS.md`，再自 FS 根向项目路径拼接；fallback 文件名可配 `project_doc_fallback_filenames`；超长文件会被静默截断（社区 issue）。
**C/E**：TUI ask/execute + plan mode（Shift+Tab）；subagent 工作流并行 spawn 再汇总；MCP（`codex mcp`）；`--full-auto` / `--yolo`。
**D**：`~/.codex/config.toml` 全量键参考，项目级 `.codex/config.toml` **仅在信任该项目时加载**；`model_reasoning_effort`、profile（`--profile deep-review`）、企业策略服务端下发。
**F**：Rust 重写（codex-rs），沙箱/权限为结构化类型（`FileSystemSandboxPolicy` / `NetworkSandboxPolicy` / `PROTECTED_METADATA_PATH_NAMES`），headless/CI 友好。

## 3. Cline

**A**：默认「每个动作都要显式批准」。Auto Approve 按工具类别开关（Read project / all、Edit project / all、safe commands / all commands、browser、MCP、notifications）；**「safe command」不是固定白名单，而是模型自己打标**，官方原文承认 "these are examples, not guarantees"；YOLO Mode 一键全放行（含 Plan → Act 切换）。
**B**：Plan / Act 双模式；Memory Bank；`.clinerules` + Skills + Plugins + MCP + **Hooks（8 类事件：TaskStart / TaskResume / TaskCancel / TaskComplete / PreToolUse / PostToolUse / UserPromptSubmit / PreCompact）**；`.clineignore` 将废弃，官方明确它**不是安全边界**（显式 @ 或 shell 仍能读到），改由 PreToolUse hook 脚本强制（`PreToolUse_ClineignoreGuard.sh`）。
**C**：同一 core 覆盖 Desktop / TUI / CLI / VS Code / Cursor / Windsurf / JetBrains / Antigravity / Zed / Neovim(ACP) / SDK / Kanban（每卡独立 worktree + auto-commit + 依赖链）。
**D**：Checkpoints——**独立 shadow Git 仓库**（不动真实历史），每次 tool use 后全量 commit 快照（含 Git 未跟踪文件），跨编辑器会话持久；三种恢复粒度 Restore Files / Restore Task Only / Restore Files & Task。企业版接 OpenTelemetry / Datadog / Grafana / Splunk。
**E**：逐工具审批队列、需审批通知、批准倒计时提示。
**F**：**权限逃逸口——批准 `spawn_agent` 等于批准该子 agent 之后的一切操作，子 agent 内部不再询问、不继承 Auto Approve 设置**（官方要求「批准前先读任务」）。Plan mode 子 agent 会拒绝 `rm` / `git commit`，但 `python -c` 仍可写文件。子 agent 还能再派子 agent；token 与成本计入主会话。

## 4. Cursor

**A**：读文件与代码搜索**免批准**；`.cursorignore` 屏蔽；**写工作区文件立即落盘、无需批准**（配置文件除外，官方要求自备版本控制）；终端命令默认需批准；MCP 连接需批准且每次调用仍需单独批准（可允许列表预批）。网络只允许 GitHub / 直链 / 搜索服务商。
**B**：Workspace Trust 支持但默认关闭（`security.workspace.trust.enabled` 才开，MDM 可强制）；读取权限 System / Workspace 两档（Workspace 档下工作区外读取需批准，Grep 结果不越界）。
**C**：Agent + Plan Mode + subagents（`.cursor/agents/`，**兼容 `.claude/agents/` 与 `.codex/agents/`，冲突时 .cursor > .claude > .codex**；frontmatter 支持 `model: claude-opus-5[effort=high,context=300k]`、`readonly: true`、`is_background`）+ 内置 Explore / Browser + Cloud Agents + MCP + headless CLI（`agent -p`、`--output-format stream-json`）。
**D**：**Auto-review 三层兜底**——允许列表内直接跑 → 其他 shell 尽量沙箱内跑 → 沙箱跑不了的交**后端 LLM 分类器**评审（分类器可本地跑只读 ReadFile/Grep/Glob/ListDir 研判；当前 Gemini 3.5 Flash Lite，备 Claude 4.5 Haiku，可在企业管理端禁用）。**官方明确声明分类器不是安全边界**（best-effort）。`permissions.json` 的 `autoRun.allow_instructions` / `block_instructions` 为自然语言规则，个人 + 项目 + 团队 dashboard 合并，团队 dashboard 最高且本地文件被忽略。
**E**：Plan Mode = 澄清提问 → 研究代码库 → 生成**可在 build 前编辑**的方案 → 评审 → build；三条额外护栏（浏览器保护、文件删除保护含 `rm`、外部文件保护）即使 Auto-review 也可能仍要求批准。旧 `Ask Every Time` 在 3.5 废弃、3.6 上线 Auto-review 为推荐默认。
**F**：macOS `sandbox-exec` + Seatbelt（限制整个子进程树），Linux 用户命名空间（Landlock，回退 bubblewrap）；注入 `CURSOR_SANDBOX`、`CURSOR_ORIG_UID` / `CURSOR_ORIG_GID`、`CURSOR_SANDBOX_LANDLOCK_STATUS`（`fully_enforced` / `bubblewrap`）。`sandbox.json`（`readBoundary` / `additionalReadPaths` / 网络域名 / 可写路径 / 共享构建缓存），内置约 110 条默认网络域名名单，网络三档；团队管理员策略叠加、本地文件无法削弱。子 agent 可隔离为**独立 git worktree 或云端专属 VM + 仓库克隆**，改动留各自分支待父合并，返回 agent ID 可「恢复该 agent」续上下文；`/autopilot` 可直接接手 PR。

## 5. Aider

**A**：**无沙箱、无审批**，安全网就是 git。
**B**：repo map = tree-sitter 抽取的文件清单 + 关键类/函数签名，用**图排序算法**（源文件为节点、有依赖的文件连边）在 `--map-tokens`（默认 1k）预算内挑最相关部分，随对话动态伸缩（未加入文件时会大幅扩张）；chat history 自动裁剪；`/drop` 手动踢文件。
**C**：40+ 斜杠命令（`/add` `/drop` `/read-only` `/architect` `/ask` `/code` `/context` `/lint` `/test` `/run` `/undo` `/tokens` `/think-tokens` `/map` `/copy-context` `/web` 等）；编辑格式可切换；`--cache-prompts` + `--cache-keepalive-pings N` 心跳保活（Anthropic 缓存 5 分钟，每条消息后最多发 N 次）；多模型分工（主模型 / `--editor-model` / `--weak-model` 兼写 commit 信息）；`/think-tokens` 单独控思考预算。
**D**：`/tokens`、`/diff`、`/settings`、`/usage`；公开的 edit / refactor 榜单。
**E**：prompt-toolkit（emacs 键位，`--vim` 切 vi）；多行消息支持 `{tag … tag}` 带 tag 形式；`--no-stream` 才能看到成本与缓存统计。
**F**：**每次编辑自动 commit**（约定式提交信息），编辑脏文件前先单独 commit 用户已有改动（dirty commit），`/undo` 撤销上次 aider commit；可 `--no-auto-commits` / `--no-dirty-commits` / `--git-commit-verify`（默认 `--no-verify` 跳过 pre-commit hook）；归属标记 "(aider)" / co-authored-by 可关；`.aider.conf.yml` 可放 home 或仓库根；支持无 git 运行（但失去安全网）。

## 6. GitHub Copilot CLI（snippet 级，官方正文抓不到）

ask/execute + plan mode（Shift+Tab）；custom instructions 分 user / repo / 路径特定三层、CLI 自动合并，`copilot init` 初始化；`copilot mcp`、custom agents、skills。权限：只读操作（搜索、读文件、只读命令）自动放行，破坏性 shell / 改文件 / 访问 URL 需显式批准；`--allow-all`（`--yolo`）= `--allow-all-tools --allow-all-paths --allow-all-urls`，`--allow-all-paths` 直接关掉路径校验；会话内 `/allow-all [off|auto|show]`。沙箱：local sandboxing（macOS Seatbelt / Linux Bubblewrap / Windows 容器，**deny-by-default 文件系统策略** + 网络白名单 + 凭据清洗），`/sandbox` 斜杠命令或 app 设置授予额外路径、调整网络、开关沙箱；另有 Cloud sandboxing 跑整个会话。`copilot help` 覆盖 billing / config / commands / environment / logging / monitoring / permissions / providers / sandbox。

---

## 横向对比表

| 能力 | Claude Code | Codex CLI | Cline | Cursor | Aider |
|---|---|---|---|---|---|
| OS 级沙箱 | ✅ Seatbelt / bwrap(WSL2) | ✅ Seatbelt / bwrap+seccomp / Win 原生 | ❌ 靠 git + 逐次审批 | ✅ Seatbelt / Landlock-bwrap | ❌ |
| 规则化权限 | ✅ deny→ask→allow，6 模式 + managed | ✅ sandbox×approval 双轴 + execpolicy | ⚠️ Auto Approve 开关（LLM 打标） | ✅ 三档 Run Mode + 允许列表 + 自然语言规则 | ❌ |
| 审批粒度 | 每工具 + 参数级 | 每命令 + 逃逸重试 | 每工具类 | 每终端命令 + 每次 MCP 调用 | 无 |
| 组织侧硬管控 | ✅ managed + MDM + 禁 bypass | ✅ 服务端下发 | ✅ SSO / RBAC / 模型封禁 | ✅ dashboard 策略，本地不可削弱 | ❌ |
| 代码库自动索引 | ❌（Grep + CLAUDE.md） | ❌（AGENTS.md） | ❌ | ❌（靠 Explore 子 agent） | ✅ repo map 图排序 + 1k 预算 |
| 指令文件 | CLAUDE.md 祖先链拼接 + rules + auto memory | AGENTS.md 启动一次拼接 | .clinerules + Memory Bank | .cursorignore + rules | conventions 文件 |
| 上下文压缩 | ✅ auto-compact + 定向 summarize | — | — | — | chat history 裁剪 |
| Prompt 缓存利用 | ✅ | ✅ | ✅ | ✅ | ✅ + keepalive 心跳 |
| 撤销 / 回滚 | ✅ checkpoint（100 个）+ 定向压缩 | ❌ 靠 git | ✅ shadow-git checkpoint | ⚠️ worktree 隔离为主 | ✅ 每次 auto commit + /undo |
| 计划模式 | ✅ | ✅ | ✅ | ✅（最重，可编辑方案） | ⚠️ architect 模式 |
| 子 agent / 并行 | ✅ subagents + background + agent teams | ✅ 并行 subagents | ✅ spawn_agent + Agent Teams | ✅ 前后台 + worktree/VM 隔离 | ❌ |
| Headless / CI | ✅ headless / SDK / channels | ✅ flags | ✅ CLI / SDK / Scheduling | ✅ `agent -p` | ✅ `--no-stream` / 脚本化 |
| 企业可观测 | OpenTelemetry | 日志 / 结构化配置 | ✅ OTel + Datadog + Grafana + Splunk | ✅ dashboard + 模型禁用 | ❌ |

## 可直接借鉴的工程模式 Top 15

1. **沙箱能力与审批时机拆成两个正交旋钮**，并在沙箱不可用时提供「硬失败」开关（默认降级不沙箱是最大的安全坑）—— Claude Code sandboxing / Codex agent-approvals-security
2. **权限求值 deny → ask → allow，首次匹配即定、不按具体度**：宽 deny 必须压过窄 allow，禁止「在 deny 里开洞」—— Claude Code permissions
3. **裸工具名 deny = 把工具定义从模型上下文里摘掉**，而不是拦截调用，直接消灭绕过面—— Claude Code permissions
4. **参数级匹配只允许 deny/ask，且禁止匹配 Bash.command、file_path、url 等主内容字段**（复合命令可绕过）—— Claude Code permissions
5. **沙箱只包 shell**；内置文件/网络工具走独立权限域，且必须在文档里明说差异，别给用户虚假的安全感—— Claude Code sandboxing
6. **审批持久化锚定 git 仓库根**（工作树自动解析到主 checkout），**文件修改的批准只到会话结束、不落盘**——把不可逆副作用与可逆偏好分开—— Claude Code permissions
7. **审批可附评论**：No + 评论 = 把拒绝理由喂回模型并继续，而不是终止回合—— Claude Code permissions
8. **权限面板热更新**：agent 运行中也能改规则，改动从下一次 tool call 生效（不必等回合结束）—— Claude Code permissions
9. **指令文件按「FS 根 → cwd 拼接 + 子目录懒加载」**，超长内容拆成带 glob frontmatter 的路径作用域规则—— Claude Code memory
10. **agent 自写记忆走独立通道**，与用户指令分离，按仓库存、每会话限额加载（200 行 / 25KB）—— Claude Code memory
11. **Checkpoint 与 rewind 合一**：回滚菜单内直接提供双向定向压缩（Summarize from / up to here）并可写引导语，一处解决「回退」与「省 context」—— Claude Code checkpointing
12. **自动批准三层兜底**（允许列表 → 沙箱内跑 → LLM 分类器评审），并在文档中明示分类器不是安全边界—— Cursor auto-review
13. **子 agent 配置目录做多生态兼容 + 明确优先级**（.cursor > .claude > .codex），让同一套 agent 资产跨工具复用—— Cursor subagents
14. **「忽略文件」类配置不当安全边界**：改用 PreToolUse hook 脚本强制（Cline 已从 `.clineignore` 迁到 `PreToolUse_ClineignoreGuard.sh`）；同理 `spawn_agent` 的批准必须让子 agent 继承同一审批策略，不能变成权限逃逸口 —— Cline
15. **无沙箱产品用 git 当安全网**：每次编辑自动 commit + 编辑脏文件前先单独 commit 脏改动 + `/undo` 回滚；再叠 prompt cache 心跳保活降本 —— Aider git / caching
