# pancode 对齐热门 Agent 产品 · 五维差距清单与落地路线

- 日期：2026-10-11
- 范围：`server/`（22 个模块）+ `public/`（前端，约 218KB 主逻辑）+ 构建/CI/测试体系
- 对标对象：Claude Code、Codex CLI、Cline、Cursor、Aider、Copilot CLI
- 材料来源（三份，均落盘可查）：
  1. 稳定性与工程化审计（子代理，全程只读）—— 21 条发现 + 11 条「已做对」
  2. 安全性只读审计（子代理，全程只读）—— 2 blocker + 4 high + 10 medium + 7 low + 18 条「已做对」
  3. 竞品能力基线调研（子代理，联网）—— `ai-coding-agent-baseline.md`（18KB，六家 × 六维度 + 14×5 横向对比表 + Top15 工程模式）
- **主会话对两份审计的关键条目逐条看代码复核，未采信转述**；竞品报告中 Claude Code / Cline / Cursor / Aider 为官方文档全文级，**Codex CLI 与 Copilot CLI 因官方站 fetch 被拒为 snippet 级，引用时已标注**。

---

## 0. 一句话结论

**pancode 的差距不是缺功能，而是「边界没被当事实对待」。**

这句话有两层意思：

- 好的地方比想象中多。写入抗撕裂（98 处统一走 `server/safe-write.js`）、多根授权的最长前缀匹配、命令黑名单的语义层（NFKC 归一 + 零宽字符 + 宏展开 2 轮收敛 + base64 递归复检）、irreversible 守卫的执行顺序、检索式上下文注入、压缩事件闭环、CJK 加权 token 估算、CI 双平台矩阵 —— 这些不是「玩具级」项目的做法，是有经验积累的代码。
- 差的地方集中在同一个模式：**每一条都有一条「只在某个分支上成立」的保证**。流式取消只在连接阶段成立；strict 归一化只在 strict 路径生效；`security.check` 只在一个调用点被调用；文件操作守卫只在 AI 路径生效。用户正常使用看不出问题，**一旦撞到那条没覆盖的路径，失败是静默的**。

整体评级：**单机自用级 Beta，未到可无人值守长跑级**。安全上「本机恶意进程」防线尚可，「任何能连到本机端口的主体」接近于零。

---

## 1. 差距总表（五维 × 分级）

### 1.1 稳定性

| 级别 | 编号 | 缺口 | 证据 |
|---|---|---|---|
| **blocker** | S-B1 | 流阶段无取消，点「停止」后正在跑的那次生成必然跑完 | `server/llm.js:76` AbortController 只管连接，`:101` 响应头到达即 `clearTimeout(connTimer)`，此后全仓无 abort 调用方；读循环 `:195-242` 无取消入口（`:185` 的 `reader.cancel()` 只在空闲超时触发）。agent 侧 `abort(convId)`(`server/agent-llm.js:1286-1293`) 只置 flag，检查点在 `:2730`/`:3220`/`:3375` |
| **blocker** | S-B2 | 半截 JSON 静默丢弃 | `server/llm.js:146` `try { j = JSON.parse(data); } catch (e) { return; }` —— 同文件对空闲超时/网络错误都有清晰路径，唯独解析失败是黑洞，无计数无日志 |
| **blocker** | S-B3 | 服务端异常只回前端、不落日志、无 requestId | `server/index.js:1995-2002 safe()` catch 后只 `ws.send(op.error)`，服务端一行日志不写；全仓 grep `reqId\|traceId\|correlationId` 零命中；`index.js` 38 处空 catch + 41 处吞错式 catch |
| **high** | S-B4 | 429 退避是模块级全局单值 | `server/llm.js` 的 `_backoffUntil` 不按 userKey/model 分桶 —— 任一会话触发 429，全机全部会话一起退避；退避期间也不可中断 |
| **high** | S-H1 | 长回复结束时主线程冻结 | `public/app.js:2386-2400` `msg.end` 走同步 `renderChatMD(b.buf)`，刻意绕开了 W9 的 MD Worker（`:1815-1852`）。流式过程中是 Worker 的，结束那一下反而同步 |
| **high** | S-H2 | 会话快照无上限、无 LRU、失败静默 | `public/app.js:3629 saveConvDom` 每会话完整 innerHTML 塞 localStorage，`:3630`/`:3631` 同样空 catch。撑爆 5MB 后被吞 →「刷新后历史全没了」且无提示 |
| **high** | S-H3 | safe-write 失败静默 + 孤儿 tmp 只清 1 个 | `server/safe-write.js` 失败只 `console.warn` + `return false`，调用方普遍不检查返回值；`cleanupTmpOrphans`(`server/index.js:2332-2343`) 只清 `pancode.config.json.*.tmp` 一个文件 |
| **high** | S-H4 | 重连/刷新后服务端 in-flight 增量不可恢复 | 无断点续传；刷新即丢正在生成的内容 |
| medium | S-M1 | 事件监听 110 加 / 3 摘 | `public/app.js` 85 处 addEventListener 对 2 处 remove |
| medium | S-M2 | `_currentConv` 是引擎级共享可变字段 | `public/app.js:3137`，靠约定而非结构保证 |
| medium | S-M3 | 事件作用域只到 userKey，不按会话 | `server/event-scope.js` |
| medium | S-M4 | 错误分类靠正则兜边界样本 | 唯一真相源已建立（`server/app-error.js` `classifyLlmError`），但上游没有结构化错误码可依赖，只能正则 |
| medium | S-M5 | 静态检查形同虚设 | `tsconfig` `allowJs:true, checkJs:false, strict:false`，无 typecheck script；`no-empty` 配 `allowEmptyCatch:true` 豁免 282 处；`public/` 完全不 lint（`package.json:28` `"lint": "npx eslint server/ test/ --quiet"`）；`public/js/core.js`/`cmdk.js`/`evolution-codex.js` 在 ignorePatterns |
| medium | S-M6 | CI 不跑 lint / tsc | `.github/workflows/ci.yml` 36 行，双平台矩阵 + `npm ci → test:unit → test:verify → smoke → test:fileops`，**没有 lint 步骤** |
| medium | S-M7 | 双验证体系并存 | 25+ 个 `scripts/_verify_*.js`（`package.json:14` 用 `&&` 串一条链）与 vitest 并存，还有大量 `_*_patch_*.py`；且 `package.json:31 "test"` **不含 `test:unit`** |
| medium | S-M8 | 无 CHANGELOG / MIGRATION | — |
| medium | S-M9 | 无成本换算、无 `/metrics` | grep `totalTokens` 全 server 仅 `server/agent-llm.js:2939` emit `agent.usage` 一处 —— 有 token 统计，无成本换算 |
| medium | S-M10 | 入库杂物 | `.merkle-snapshot.json` 与 `_start.js` 已被 git 跟踪 |
| low | S-L1 | 首屏 26 个 `<script>` 无 defer/async | `public/index.html:650-674`，含 3.47MB monaco，无 code-splitting、无 CSP |
| low | S-L2 | TaskBoard 无耗时聚合 | — |
| low | S-L3 | vitest 无 coverage | — |

### 1.2 安全性

| 级别 | 编号 | 缺口 | 证据 |
|---|---|---|---|
| **blocker** | C-B1 | `/api/auth/register` 无「是否已有用户」门禁，攻击链直通任意命令执行 | `server/index.js:379` 把 `/api/auth/register` 放进 NO_AUTH 白名单；`server/auth.js:98-111 register()` 只在 `:102` 查重名，**无 `hasUsers()` 门禁**（`hasUsers()` 在 `:147` 确实存在，但只给 `/api/auth/status` 用）。完整链路：注册拿令牌 → `/api/config` 改 `permissions.mode:auto` + `strictCommand:false` + `deny:[]` → WS `term.exec` 或 `mcp.servers:[{command}]` → 任意命令执行 |
| **blocker** | C-B2 | 令牌走 query string | `server/index.js:390 req.query.userToken`、`:1990` WS `searchParams.get("token")` → 进浏览器历史 / Referer / 日志 |
| **high** | C-H1 | `start_process` 完全绕过命令黑名单 | `server/processes.js:51-82 start()` 只校验进程名正则 `/^[a-zA-Z0-9_-]{1,40}$/`(`:55`) 就 `spawn(cmd.exe, ["/d","/s","/c", command])`(`:58-60`)，**根本没 require security**。`security.check` 全仓仅 `server/terminal.js:118` 一处调用。`server/tools/process-tools.js:47-58 start_process` 只过 `_gate`（deny/allow/审批），不碰黑名单 |
| **high** | C-H2 | 用户手敲终端比 AI 更不受保护 | `server/security.js:120-149 _check(cmd, strict, depth)`：`:126` BASE 只对原文 `re.test(raw)`；`:134 if (strict)` 块内才做 `stripQuoteJoins(macroExpandVars(norm))` 后重跑。`server/index.js:2126-2135 term.exec` 调 `term.run(tabId, m.cmd.slice(0,500))` **不传 strict** → 归一化不生效 → 用户比 AI 更容易绕过 BASE 黑名单 |
| **high** | C-H3 | `permissions.mode` 不校验取值 + auto 近乎全放行 | `server/config.js:281` 任意字符串即收；默认 deny 为空；切 auto 只有一行 writeAudit，无二次确认 |
| **high** | C-H4 | `/api/workspace` 指向任意目录且自动获得可写权 | `root-grants.ensure` 在 `mountWorkspace` 里自动登记可写根；`/api/fs/browse` 可枚举全盘 |
| medium | C-M1 | WS 文件指令绕过 irreversible 守卫与 undo 检查点 | `server/index.js:2146-2187` 五个 case（`file.save/create/delete/rename/mkdir`）全部 `safe(() => { files.xxx(...); ... })` 直调，**不过 `_gate`、不压 `_undoStack`**；`server/files.js:217-226 remove()` 仅 `:219` 拦「删工作区根目录」，`:224` `fs.rmSync(abs,{recursive:true})`，**无回收站、无二次确认** |
| medium | C-M2 | `web_fetch` 无 SSRF 防护 + 注入面 | 可打 127.0.0.1 与云元数据地址；返回内容直接进模型，无边界标记 |
| medium | C-M3 | `create_skill` 契约空 `{}` → 持久化提示注入 | 写正文会在后续会话被 `use_skill` 读进上下文 |
| medium | C-M4 | 配置与数据根同在工作区 | `server/config.js:22` ROOT 默认 = 项目根；授权项目根即可让 AI 读密钥 / 改配置 |
| medium | C-M5 | 会话令牌明文落盘 | `server/auth.js:38-58` 以令牌原文作 JSON key |
| medium | C-M6 | 权限规则对命令类用无边界前缀；deny 对 MCP 参数里的路径完全无效 | `_hookSubject` 对 `mcp__*` 只送工具名 + 参数 JSON |
| low | C-L1 | `persona.systemPrompt` 可无审计覆盖 | — |
| low | C-L2 | MCP `command` 仅 trim，不过 `security.check` | — |
| low | C-L3 | 三个端点在 NO_AUTH | `/api/index/search`（匿名可语义检索全仓源码）、`/api/index/build`（匿名可触发全量索引）、`/api/preview/docx`（匿名可解析任意文档），见 `server/index.js:382-385` |
| low | C-L4 | 审计日志 actor 是静态字符串且记完整命令行 | — |
| low | C-L5 | `git push` 无 dry-run | — |
| low | C-L6 | `lsp-bridge` 的 `root` 参数直接当 cwd，不过 `safePath` | — |
| low | C-L7 | `run_command` 被标 microcompact | 清输出后模型可能重跑有副作用的命令 |

> 审计方声明的局限：`npm audit` 因沙箱禁写 npm 缓存而失败，**依赖漏洞未验证**；全程静态阅读，未起服务。

### 1.3 流畅性

| 级别 | 编号 | 缺口 | 证据 / 竞品做法 |
|---|---|---|---|
| high | F-H1 | repo map 无依赖图排序，优先级 = 目录遍历序 | `server/repo-map.js:56-91 buildRepoIndex` 线性遍历 `files.list()` 顺序（`:58`/`:61-63`），输出 `index.files.slice(0, maxFiles=60)`(`:102`) + 每文件 `slice(0, maxSym=30)`(`:106`) + 整体 `maxChars=6000`(`:98`)。**大项目里最相关的文件根本进不了预算**。Aider 是 tree-sitter 抽签名 + 依赖图排序 + 在 `--map-tokens` 预算内动态伸缩 |
| high | F-H2 | 无虚拟列表，全量 innerHTML 重建 | 长会话滚动必然掉帧 |
| medium | F-M1 | 无显式 prompt 缓存机制与命中可视化 | Aider 有 `--cache-prompts` + `--cache-keepalive-pings N`（Anthropic 缓存 5 分钟）。pancode 的分桶注入（identity/stable/turn，`server/agent-llm.js:2041 buildAugmentParts`）实际已在为前缀缓存设计，但**没有面向用户的缓存命中可视化** |
| medium | F-M2 | 重连后增量不可恢复 | 同 S-H4 |
| medium | F-M3 | 无耗时聚合，用户看不到「哪一步慢」 | Aider 有 `/tokens` `/think-tokens` `/map` |
| low | F-L1 | 首屏无 code-splitting，3.47MB monaco 直接进主包 | `public/index.html:650-674` |

### 1.4 功能完善

| 级别 | 编号 | 缺口 | 证据 / 竞品做法 |
|---|---|---|---|
| high | P-H1 | 次数硬刹车，无 60% 预警、无续轮询问 | `server/agent-llm.js:3221-3222` 到点 `say(...)` 让用户重发消息。对照 Claude Code：`max_turns` 到点可「批准一次续跑」；Aider 有 `/architect` 切模型 |
| high | P-H2 | undo 检查点纯内存，重启即丢 | `server/agent-llm.js:983 _undoStack`、`:1335-1381 _pushCheckpoint/_undoLast`、栈深 50，跨根写记录 store/dir、还原失败退还检查点 —— **机制本身设计得不错**，但纯内存。Cline 用**独立 shadow git 仓库**（不动真实历史、每次 tool use 后全量 commit 含未跟踪文件、跨编辑器会话持久）；Aider 每次编辑自动 commit + `/undo` 撤销上一次 aider commit |
| high | P-H3 | 无法在回滚时顺手压缩上下文 | Claude Code 的 `/rewind` 菜单里直接做双向定向压缩（Summarize from / up to here）+ 可写引导语；快照保留最近 100 个、随会话保存、`--resume` 后仍可 rewind、默认 30 天清理 |
| medium | P-M1 | 无 worktree 隔离 | grep `worktree` 全 server 仅 1 命中（`agent-llm.js:3255` 一条注释）。Cursor 子 agent 可隔离为独立 git worktree 或云端 VM + 仓库克隆 |
| medium | P-M2 | 无 reasoning effort 配置 | grep `reasoning_effort` 同上，仅注释。Codex CLI 有 `model_reasoning_effort`；Cursor subagent frontmatter 支持 `model:[effort=high]` |
| medium | P-M3 | 子 agent 无跨会话续接标识 | Cursor 返回 agent ID 可续上下文；Claude Code 有 resume / fork / 嵌套 |
| medium | P-M4 | 审批不落盘、不附评论 | Claude Code 审批持久化到 `.claude/settings.local.json`，且**审批可附评论，No + 评论 = 把拒绝理由喂回模型继续**。pancode 审批只到会话结束 |
| medium | P-M5 | Plan Mode 形态偏轻 | Cursor 最重：澄清提问 → 研究 → **可编辑方案** → 评审 → build，外加三条护栏（浏览器 / 文件删除 / 外部文件保护） |
| medium | P-M6 | 无 hooks 事件体系 | Claude Code 30+ hook 事件；Cline 把 `.clineignore` 明确**不是安全边界**，迁到 PreToolUse hook 脚本强制 |
| low | P-L1 | 命令面板覆盖有限 | 存在但未成体系 |

### 1.5 体验便捷

| 级别 | 编号 | 缺口 | 说明 |
|---|---|---|---|
| medium | E-M1 | 历史丢失无任何提示 | S-H2 的次生伤害：用户刷新后发现历史全没了，只知道「没了」不知道「为什么」 |
| medium | E-M2 | 错误提示不落到用户可见处 | 429 限流目前只到工具栏文字（`public/app.js setRunning`），无独立倒计时组件。toast 基建在 `public/js/utils.js:48-54`，加一个成本极低 |
| medium | E-M3 | 工作区可指任意目录但无引导 | `/api/workspace` 能指任意目录即获得可写权（C-H4），用户对「授权即写权」无感知 |
| low | E-L1 | 快捷键已较完整（不需补） | `public/app.js:4034` Ctrl+S、`:4039` Ctrl+Shift+P 命令面板、`:4040` Ctrl+P 文件面板、`:4041` Ctrl+W 关标签、`:4042` Ctrl+.、`:3607` 终端 Ctrl+C kill；另 `cmdk.js:83`、`workbench.js:1075`、`patch-review.js:137`；命令面板 `cmdk.js:13` 已有「提交当前改动（Git）」 |

---

## 2. 已做对的地方（务必保留，不要在重构中改坏）

这部分是从两份审计的「做对的 N 条」+ 主会话复核中挑出的、有具体证据的条目。**它们是这套代码区别于玩具项目的根本原因。**

### 2.1 稳定性 / 工程化

1. **写入路径统一抗撕裂** —— `server/safe-write.js` 按路径串行化 + atomicWrite 6 次重试退避（`100 * 3^(n-1)`），全仓 98 处统一走它。这是很多项目做不到的事。
2. **LLM 流读取基本功扎实** —— TextDecoder `{stream:true}` 保证 UTF-8 跨 chunk 安全；连接超时 `max(15s, connectTimeout)` 与空闲超时 `max(20s, idleTimeout)` 分离；**有实质内容时不当作失败**，避免重试导致前端内容重复。
3. **WS 心跳处理了真实网络陷阱** —— `server/index.js:2317-2330` `_alive` + ping/pong + terminate + `unref()`，注释点明「TCP 半开时 readyState 仍是 1，broadcast 只看 readyState 会让发送成功却无人收到」；前端另有 30s `_wsLastMsg` 双保险。
4. **zombie 任务识别** —— `server/tasks.js` 用「上次落盘仍标 running → interrupted」的廉价且正确的判据，不依赖额外心跳文件。
5. **MD 渲染 Worker 化 + 竞态防护** —— `public/app.js:1815-1852` + `public/js/md-worker.js`，65ms 节流、过期帧丢弃、`if (b.buf !== src) return` 竞态防护、Worker 失败回退同步。（**但 msg.end 漏了，见 S-H1**）
6. **上下文水位分母与引擎同源** —— `server/index.js:2051-2064 _ctxLimit()` 直接取 `_compactSpec().thresholdTokens`，不会出现「前端显示 80% 但引擎按另一套算」。
7. **压缩 / 用量事件闭环** —— `context.microcompact{cleared, tokensSaved, before, after, budget}`、`agent.usage`（`server/agent-llm.js:2939`）。
8. **39 个 vitest + CI 双平台矩阵**，且串行化决策有注释交代原因（Windows 下 5 worker 并发使 git 子进程超时）。

### 2.2 安全性

1. **仅回环监听 + `/api/bootstrap` 校验 remoteAddress**；CORS / Origin 收紧挡跨站.
2. **WS 与 LSP 均鉴权且按 userKey 隔离**。
3. **口令用 scrypt + 16 字节盐 + `timingSafeEqual`**。
4. **`safePath` 双重真实路径校验** —— 大小写 / 软链 / junction 全覆盖；`server/files.js:162` 用 `lstat` 跳过符号链接（**软链逃逸已修**）。
5. **多根授权最长前缀 + 二次校验可写档位**。
6. **`canonicalRulePath` + `_subjectPaths` 覆盖 apply_edit 的全部 patch 文件**（**权限匹配裸参数已修**）。
7. **deny hooks 在执行之前**；`grantSession` 拒绝 `*` 通配.
8. **irreversible 守卫顺序正确** —— `server/agent-llm.js:1721` 在 `:1723` 的 auto 判断**之前**。
9. **命令黑名单语义层扎实** —— NFKC 归一、零宽字符、宏展开 2 轮收敛、base64 递归复检（深度 ≤ 2）；且**审批卡展示串与实际 spawn 串是同一变量，无 TOCTOU**. 这是很多项目会写错的地方，这里没写错.
10. **敏感值永不写 config.json**，只落 `.env`，且 export/import 拒收；二进制双保险；前端普遍 `esc()` 转义；Skill 导入有 P0 审计门；优雅关闭 3 秒兜底.

### 2.3 Agent 设计（**本轮新增核实，两份审计都没抓到**）

1. **子智能体的工具审批不绕过 `_gate`** —— 这是 pancode **强于 Cline** 的一点.
   调用链（全 grep 实测）：`runSubAgent`(`server/agent-llm.js:1421`) → `_runToolGuarded(tc.name, tc.args)`(`:1483`) → `execTool`(`:2669`) → `TOOL_HANDLERS[name]`(`:2714-2716`)。`_gate` 不在 `execTool` 里，而是**各工具 handler 内部自调**，全仓 7 处：`tools/file-tools.js:94`(write_file)/`:202`(delete_file)、`tools/process-tools.js:7`(run_command)/`:49`(start_process)、`tools/git-tools.js:34`(git_commit)/`:55`(git_branch)，定义在 `server/agent-llm.js:1742`。
   审批卡也能正常发出：`runSubAgent` 在 `:1441-1449` 只把 `this.tool/thinkStart/msgStart/state/say` 换成 no-op dummy，**`this.emit` 未被替换**，而 `requestApproval`(`:1777-1794`) 走的正是 `this.emit({type:"tool.pending"})`(`:1792`)。
   对照 Cline：官方文档承认 `spawn_agent` 一旦批准，**该子 agent 之后的一切操作不再询问、不继承 Auto Approve** —— 是个自认的权限逃逸口。pancode 不会重演。
2. **「停止」能传到子智能体** —— `subAborted`(`:1426`) 取**会话级** `abortRef`，注释明说不能用引擎级 `this._abort`（多会话并行会互相误伤）。
3. **改盘型子智能体独占、只读型真并行** —— `mayMutate` 判定(`:1453`) + `_acquireSubLock`，只让可能改盘的子智能体串行（`:1451-1452` 注释）。
4. **子智能体不静默污染共享工作区** —— `_workspaceSnapshot()`(`:1459`) 运行前全工作区快照，结束后把「真实落盘」的改动回滚并重放进审阅队列（`:1457-1458`）。
5. **检索式上下文注入而非无脑全加** —— `server/context-retriever.js:64 buildSmartContext`（top5 文件 / 每文件前 30 行 / 整体截 4000 字符 / 记忆 score>=2 才注入）+ 记忆双道（`server/agent-llm.js:2088-2114`，稳定 1200 + 相关 1800）+ 预算硬顶（`:226-229` 与 `_compactSpec():2270`）+ 三级压缩（microcompact → `_summarize` 九段式状态快照 → `_spillToolResult` 落盘 `.pancode/spill/`；九段模板与「连续压不动就停手」的断路器见 `server/agent-llm.js` 的 `COMPACT_SECTIONS` / `_compactAbandoned`）。
6. **分桶注入为前缀缓存而设计** —— `buildAugmentParts`(`:2041`) 分 identity / stable / turn 三桶，逐条 push(`:3187-3194`).
7. **CJK 加权 token 估算** —— `server/agent-llm.js:89-97` `Math.ceil((cjk*2 + (len-cjk))/4)`，中文场景下不会系统性低估。
8. **Goal 自动续跑已存在** —— `server/agent-llm.js:1359-1365`（`【Goal 自动续跑 · 第 N 轮】`）+ `server/index.js:2079` 首启 prompt.
9. **工具执行超时已有硬边界** —— `server/tools/process-tools.js:21-23` `sec = Math.max(15, Math.min(7200, round(args.timeout || defSec)))`，默认 600s，错误文案明确提示上限 7200 秒.
10. **`CLAUDE.md` 有工程规范**；`server/tools/contract.js:164-166` 对 microcompact 范围（run_command 是否算只读）写明了权衡理由 ——「真正稳的做法是限定到只读工具，要重新量压缩收益，另开一项」，**把未决问题写清楚而不是含糊过去**。

---

## 3. 落地路线

排序原则：**先修「用户能感知的错误行为」，再修「能被别人利用的洞」，最后补工程化。** 同一批改动尽量落在同一文件，减少回归面。

### P0 · 半天到 1 天（可直接动手，收益立竿见影）

| 项 | 动作 | 触及文件 |
|---|---|---|
| S-B2 | `handleData` 解析失败：计数 + 落 trace，不再裸 return | `server/llm.js:146` |
| S-B3 | `safe()` 补 `server/logger.js` 日志 + 生成 requestId 并回传前端 | `server/index.js:1995-2002` |
| S-H3 | `cleanupTmpOrphans` 扩到全部 `*.tmp`；safe-write 失败上抛到调用方可见处 | `server/index.js:2332-2343`、`server/safe-write.js` |
| S-M10 | 从 git 移除 `.merkle-snapshot.json`、`_start.js` | — |
| C-B1 | `register()` 加 `hasUsers()` 门禁：**已有用户时禁止注册**，改为管理员邀请制 | `server/auth.js:98-111` |
| C-B2 | 令牌从 query string 改走 header（WS 改用首帧鉴权或 `Sec-WebSocket-Protocol`） | `server/index.js:390`、`:1990` |
| E-M2 | 加 toast 基建 + 429 倒计时提示 | `public/js/utils.js:48-54` |

### P1 · 1 周（两处真正的 blocker + 两个高危洞）

| 项 | 动作 | 触及文件 |
|---|---|---|
| **S-B1** | **取消链路贯通读循环**：`AbortController` 生命周期延到流结束，`chatStream` 接受外部 signal；agent 侧 abort 时同步 abort 当前请求 | `server/llm.js:76/101/195-242`、`server/agent-llm.js:1286-1293` |
| **C-H1** | `processes.start()` 与 `start_process` 补 `security.check`，与 `terminal.js:118` 对齐 | `server/processes.js:51-82`、`server/tools/process-tools.js:47-58` |
| C-H2 | `term.exec` 传 `strict=true`；或把归一化提到 strict 之外（更彻底但影响面大，建议先改 WS 路径） | `server/index.js:2126-2135`、`server/security.js:120-149` |
| C-M1 | WS 五类文件指令接入 `_gate` + 压 `_undoStack`；`files.remove()` 加回收站目录 | `server/index.js:2146-2187`、`server/files.js:217-226` |
| S-H1 | `msg.end` 改走 Worker + 增量分段 | `public/app.js:2386-2400` |
| S-H2 | localStorage 会话快照加 LRU + 容量水位 + **失败提示**（对应 E-M1） | `public/app.js:3629-3631` |
| S-B4 | 429 退避按 userKey/model 分桶，退避可中断 | `server/llm.js` `_backoffUntil` |
| P-H1 | 次数刹车加 60% 预警 +「再跑一轮」询问 | `server/agent-llm.js:3221-3222` |

### P2 · 2 周（工程化 + 功能补齐）

| 项 | 动作 |
|---|---|
| C-H3 | `permissions.mode` 白名单校验；切 auto 二次确认 |
| C-H4 | `/api/workspace` 增加显式「可写根」确认步骤；`/api/fs/browse` 限定在已授权根内 |
| C-M2 | `web_fetch` 加 SSRF 防护（禁 127.0.0.0/8、::1、169.254.169.254 等）+ 返回内容加边界标记 |
| C-M3 | `create_skill` 补契约（对齐 `tools/contract.js` 其余条目） |
| C-M5 / C-M4 | 令牌改哈希落盘；配置根与数据根分离（对齐 Codex 的 writable_roots） |
| P-H2 | undo 检查点落盘（**建议直接照搬 Cline 的 shadow git 仓库方案**：不动真实历史、每次 tool use 后全量 commit 含未跟踪文件、跨会话持久） |
| F-H1 | repo map 加依赖图排序（Aider 方案），并把预算做成可配置 |
| S-M5 | `tsconfig` 开 `checkJs`（先从 `server/` 起）；`lint` 扩到 `public/` 并去掉 `allowEmptyCatch` 豁免；解除 `public/js/core.js`/`cmdk.js`/`evolution-codex.js` 的 ignore |
| S-M6 | CI 补 lint + typecheck 步骤 |
| P-H3 / P-M1 / P-M2 | 回滚菜单内定向压缩；子 agent worktree 隔离；reasoning effort 配置 |
| S-H4 | 断线续传，或在重连时明确提示「本次生成已中断」 |

### P3 · 长期

- `scripts/_verify_*.js` 迁 vitest，收敛双验证体系（S-M7）
- 补 CHANGELOG / MIGRATION（S-M8）
- 成本换算 + `/metrics`（S-M9），可复用已有的 `agent.usage` 事件
- 审批落盘 + 审批附评论（No + 评论喂回模型，P-M4）
- Plan Mode 对齐 Cursor 的四段式 + 三条护栏（P-M5）
- hooks 事件体系（P-M6），至少 PreToolUse / PostToolUse / Stop
- 前端 code-splitting + CSP（S-L1、F-L1）
- CI 补 `npm run test:unit`（现在 `package.json:31 "test"` 不含它，属 S-M7 一部分）

### 3.9 本轮实际落地（2026-10-14 收口）

上面 P0→P3 的编号是**缺口清单**，不是施工单。这一节只记本轮真正做了什么、验收卡在哪一层，避免下一轮把已完成的当欠账、或把探针没覆盖的当已完备。

验收一律两层：`npm run test:unit`（52 文件 / 967 通过 / 1 skip）+ `npm run test:verify`（38 支探针脚本串行跑 39 次，`_verify_dataroot.js` 在链首尾各跑一次守数据根）。最终一次 `npm run verify:all`（test:summary → test:verify → `_verify_desktop.js` → verify:ui → verify:workflow-ui）**五阶段全绿：30 个带计数的阶段合计 851 条断言、0 失败**，链尾数据根指纹与链首一致（228 个文件 / `c2020df0da1a7e4d`，即全程没碰过真实对话与记忆）。**带界面的项另有浏览器探针**（Playwright 起真服务端 + 真磁盘 + 真 WS 会话），因为仓库里没有 jsdom —— 读代码看不出渲染层的账，本轮就有功能断言全绿而按钮被卡片右边缘切掉半截的实例（撤销按钮，实测行溢出 37px，改成图标按钮后由探针量宽守住）。

| 项 | 落点 | 验收探针 |
|---|---|---|
| P0-A1 结构化日志 + reqId | `server/logger.js`；`safe()` 统一带 reqId，`GET /api/logs` 按 reqId 回捞；未捕获异常栈也进这里 | `_verify_logger.js` |
| P0-A2 监听器清理 | 会话/面板销毁时成对摘除，作用域随 convId 收口 | `_verify_listeners.js`、`test/p3-event-scope.test.js` |
| P0-A3 `edit_files` 多文件原子 | 唯一对外承诺是**全或无**：任一文件没命中就整批不落盘 | `_verify_editfiles.js` |
| P1-B1 实时诊断面板 | `public/js/diagnostics.js` + `get_diagnostics` 工具复用同一个 LSP 实例缓存（`server/index.js:2375`） | `_verify_diagnostics.js` |
| P1-B2 Git 工作流工具 | `git_fetch/push/pull/stash` 等进契约表 | `_verify_gitworkflow.js`、`verify-git-async.js` |
| P1-B3 测试运行器 | `server/test-runner.js` + `run_tests`；与 `run_command` 同档（起的同一个 shell） | `_verify_testrunner.js` |
| P1-B4 Token 成本面板 | `server/cost.js` + `server/usage-store.js`；验的是"三处同一个口径" | `_verify_cost.js`、`test/p1-cost.test.js` |
| P1-B5 规则版本化 | `server/rule-history.js`：写前快照 / 列表 / diff / 回滚 | `_verify_rulehistory.js` |
| P1-B6 上下文压缩增强 | 压缩后重建请求不再 400（保留 `tool` 时必须带回它的 `assistant.tool_calls`） | `_verify_ctxpair.js`、`test/p1-compact-budget.test.js` |
| P2-C1 多智能体 DAG 可视化 | 编排要有"图"的样子：谁等谁、谁和谁同批并行 | `_verify_layout.js`、`_verify_agentflow.js` |
| P2-C2 跨文件重构 | `server/refactor.js` + `find_references`（纯读）/ `rename_symbol`（不带 `apply` 只出预览） | `_verify_refactor.js`、`test/p2-refactor.test.js` |
| P2-C3 技能市场增强 | `public/js/skill-market.js` | `_verify_skillmarket.js`、`test/p2-skill-market.test.js` |
| P3-D1 可审计决策链 | `server/decision-log.js` + `GET /api/decisions`、`/api/decisions/dates` | `_verify_decisions.js`、`test/p3-decision-chain.test.js` |
| P3-D2 代码知识图谱 | `server/code-graph.js` + `public/js/dep-graph.js`（repo map 的依赖图排序一并收掉 F-H1） | `_verify_codegraph.js`、`test/p3-code-graph.test.js` |
| P3-D3 自进化规则 | `server/rule-proposals.js`：从记忆 / 拒绝 / deny 规则 / hook 四类证据里出提案，采纳走与 `POST /api/rules` **同一条**落盘 + 快照路径 | `_verify_ruleevo.js`（49 项）、`test/p3-rule-evolution.test.js` |
| P-M1 git worktree 隔离 | `server/git.js` 的 `worktrees/addWorktree/removeWorktree` + `git_worktree` 工具；副本一律落 `.worktrees/` 并写进 `<git common dir>/info/exclude`（**不是** `.gitignore`，那会脏工作区） | `_verify_worktree.js`（44 项）、`test/git-worktree.test.js` |
| P-H3 撤销入口 | `GET/POST /api/undo`（按 userKey 取引擎，与 Agent 同一实例）+ 卡片上的图标按钮；`undoable` 由检查点栈深差判定，不靠前端工具名白名单 | `_verify_undo.js`（45 项）、`test/p3-undo-entry.test.js` |

**明确没做、不要当成已完成**：

- **P-H2 undo 检查点落盘**：`_undoStack` 仍是纯内存（`server/agent-llm.js:1242`），重启即丢。P-H3 补的是**入口**，不是持久化 —— 按钮的 tooltip 和撤销栈空时的提示都按这个口径写。
- **`/metrics`**：无。成本只有面板与账本，没有对外抓取端点。
- **CHANGELOG / MIGRATION（S-M8）**：仍无。
- **S-M7 双验证体系合并**：`_verify_*.js` 没有迁进 vitest，两层各自跑。
- §4.1 那三项（团队协作 / 远程开发 / 插件扩展层）按既定结论**不做**。

**过程里实测抓到的五条真缺陷**（都不是"断言写错了"，而是跑出来的）：

1. `config.readJsonSafe` 在同毫秒写入时信了盘上的旧文件，导致 `saveDesktop` 覆盖掉刚排队的 `saveAgentSettings`（`test/p3-close-policy.test.js` 用强制同毫秒状态复现）。
2. `_verify_layout.js` 用固定 420ms 轮询测渲染中的 DOM，技能页偶发 `det=-1` —— 量到的是渲染中途的 DOM（改成最多 6s 轮询到节点出现）。
3. **卡片行加控件把按钮挤出边界**：`.tool-head` 行尾本来已有 轮次/耗时/结果 三样，再加一颗带文字的撤销按钮后整行 flex 溢出 37px，屏幕上"撤销这"被切半 —— 而"按钮出现了 / 只点得动最新那张 / 点下去真回滚了"三条断言全绿（`locator.click()` 会自动滚动，所以照点照成功）。改成图标按钮 + `title`/`aria-label`，并在探针里量 `scrollWidth-clientWidth` 与 `rect.right` 对比面板右缘，另加一条"把面板压窄必须测得出溢出"的正向对照。
4. **C-B2 的鉴权迁移漏了四个调用点**：`_verify_desktop.js` / `_verify_eventscope.js` / `_verify_bootperf.js` / `test-lsp.js` 仍在用 `?token=` 连 WS。后三个之所以一直绿，是因为 `_sandbox` 给探针的服务端开了 `PANCODE_ALLOW_TOKEN_QUERY=1` 这扇兼容门 —— 也就是**整条 verify 链跑的都不是正式前端的鉴权路径**；只有桌面探针起的是真 Electron + 真服务端，于是它在 `verify:all` 阶段直接 `socket hang up`。四处已全部改走 `bearer.` 子协议，兼容门随之从 `_sandbox.js` 摘掉。
5. **桌面探针读日志快照读早了**：`_verify_desktop.js` 判托盘那行用的是 `/（在跑 [1-9]）/.test(out)` 一次性快照，而主进程按几秒一轮才刷这行 —— 单独跑两次全绿、进全量链就红。改成 `waitForMarker(正则, 20000)` 轮询到出现为止（该助手原本只收子串，现同时收 RegExp）。

### 3.10 中英文切换全量键化（2026-10-15 收口）

起因是一句"切换还不够全面"。把它变成了一个可复跑的数：**切到 EN 后，界面上真的看得见的中文还剩几条**。

**口径先划清**（否则"全翻"是个做不完 also 不该做完的目标）：

| 类 | 判据 | 处理 |
|---|---|---|
| ① 界面外壳 | 写死在 `index.html` / JS 里的标签、按钮、提示、状态栏 | 一律 `t()` 或 `data-i18n*` |
| ② 运行时提示 | 服务端推来的 label、审批卡、限流重试、步数动词、错误 toast | 参数化的走 `labelKey` + `labelVars`；固定串走 `tr()`（按 `LANGS.zh` 的值反查键，查不到就原样留着） |
| ③ 数据 | 聊天正文、文件名、编辑器内容、用户自己写的 Skill/规则正文、工作流提示词模板 | **显式豁免**（`data-i18n-skip` 标出来，不是藏起来），另有断言反向数这些标记在不在 |

**落到的数**：字典 `public/i18n.js` **zh 1607 / en 1607**，悬空引用 0、en 侧留中文 0、半英半中行 0、`t()` 被局部变量遮蔽 0。运行期扫描覆盖 **26 个界面**（主界面 + 17 个设置分区 + 6 个弹窗 + Ctrl+P 文件跳转面板 + 标签页）× 中英两态：**EN 态残留 0 条**，同一把尺子在中文态抓到 **2317 条**（正向对照，防止"0"是尺子坏了）。验收门 `_verify_i18n.js` **17 条断言**，其中 4 条是不开浏览器的静态前置，已并入 `test:verify`（现 45 次探针调用）。

**这一轮实测抓出来的五条**（都是跑出来的，不是读代码读出来的）：

1. **批量 codemod 造出的 `t()` 遮蔽**：`const t = document.createElement("div")`（`renderTabs`）、`applyTheme(t)`、`.forEach(([v, t])`、`const t = evoData.tree` 等把全局 `t()` 顶掉，调用即 `TypeError` —— 而分区渲染外层有 `try/catch`，抛错被吞成一句"这一页加载失败"，"全程无 JS 报错"断言看不见。加了 acorn 作用链扫描 `i18n-scan-shadow.js` 当门，逐处改名（本轮又多抓一处：`app.js:1236` 的 `const t`）。
2. **整类漏网的 JS 现造节点属性**：`title="中文"` / `placeholder="中文"` / `aria-label="中文"` 写在字符串拼接里，原有 codemod 只处理 `>中文<`，于是 **25 处**从没被键化过（脏标签 tooltip、审批卡"本会话都允许"、模型下拉刷新、技能市场风险徽标、成长树 aria-label…）。新增 `i18n-scan-attr.js` 静态门（含 `index.html`：中文属性必须配 `data-i18n-*`），零容忍，已全部键化。
3. **探针自己把命令面板藏了**：`setModal()` 给 `#cmdk` 塞过内联 `display:none`，而 `openCmdk()` 只摘 `hidden` 类不清内联样式（`styles.css:1469`）—— 所以"弹窗/命令面板"那一条扫描**一直是空的**，扫的是隐藏容器。修好后当场抓到一条真漏翻：`#cmdkInput` 的 `aria-label="命令搜索"` 有 `data-i18n-ph` 却没有 `data-i18n-aria`。
4. **截图证据可以是假的**：`page.evaluate("() => …")` 传的是**字符串**，Playwright 按表达式求值，只造出函数并不调用 —— 三张"英文界面留证图"全是同一个主界面；改成传函数后，命令面板那张仍和技能页一模一样（被前一步留下的 Settings 盖住）。现在每张截图前都断言目标真的显形（`#workbench` 显式可见 + `WB.section` 对得上 / `#cmdk` 无 `hidden` 且有尺寸）。
5. **`wbComp*` 14 条是重建的，不是恢复的**：批量改写期间的待办台账丢了这批键的原文，磁盘、git、会话记录三处都取不到，只能按该分区的注释与入参反推措辞。**这一节的英文文案保真度低于其余部分**，且该分区正被并行的电脑控制改造同时改动，下一轮目视应优先看它。

**明确没做、别当成已完成**：

- `server/risk.js` 的 `riskReasons`（约 10 条、参数化拼接）：SCM 风险点的 tooltip 正文，要翻得先给它铺 `labelKey`/`labelVars` 通道，本轮未做 —— 英文界面下这句仍是中文。
- `server/tools/memory-tools.js:103` 的 `"项目 " + 分片 id`：那是**给模型的检索回执正文**，属③类，按口径留中文（`i18n-check-keys.js` 把它报成"1 条无字典对应"，是提示不是失败）。
- 粗扫 `public` 下 JS 字符串字面量仍有约 700 处含中文，绝大多数是③类数据、兜底串与注释，**未逐条 triage**；这一层要收口得先有"按可达界面驱动"的清单，而不是再堆一次正则。
- 语言切换只重绘"注册过钩子"的动态区域（状态栏、诊断、工作台、终端页签…）。JS 现造且**缓存**的节点（附件芯片、模型下拉）在打开状态下切语言不会立刻换字，重开即正常。

### 3.11 齿轮抽屉 / GitHub 反馈 / 开发者信息（2026-10-15）

三条界面需求一起做的，顺手把 §3.10 那套门用上了 —— 新代码从第一行就得过门，不然当场红。

| 需求 | 落点 | 关键取舍 |
|---|---|---|
| 齿轮先出小窗、子项抽屉式展开 | 新文件 `public/js/gear-menu.js` + `styles.css` 的 `.gm*`；`workbench.js` 的 `wbWireEntries` 不再把齿轮绑到全屏工作台 | 常用项提到第一层（外观 / 语言 / Agent 模式 / 模型 / GitHub / 快捷键 / 反馈 / 关于），行尾直接显示**当前值**；全屏工作台仍从底部「全部设置」进。gear-menu 没加载成功时退回原行为，不让设置入口变死按钮。展开用 `grid-template-rows:0fr→1fr`，不重画列表（重画会让过渡变成闪一下） |
| GitHub 信息 + 点亮星星 + 一键反馈 | 同上（`GH_URLS` / `fb*`） | 星数读 `api.github.com/repos/pyf2818/pancode`，6 小时缓存；**读不到显示「星数暂不可读」而不是 0**。反馈窗拼 `issues/new?title=&body=` 交给系统浏览器，正文自动带版本 / OS / 引擎 / 工作区 / 语言；截图走粘贴或拖入，提交前把图写回剪贴板并明说"到 GitHub 页面 Ctrl+V"。**应用里不落任何令牌**（用户已选定：预填链接 + 真实星数 + 打开仓库页，不做"真点亮 / 真建单"） |
| 关于页开发者信息 | `wbRenderAbout` 新增两组 | 开源仓库（星数 + 仓库主页 + 问题列表 + 反馈）与开发者（潘裕丰 · 个人独立开发者 / QQ 邮箱 / 微信号，点击即复制）。EN 态名字走罗马字 `Pan Yufeng`，不在英文界面留汉字 |

**顺带抓出来的两条真缺陷**：

1. **模式徽标与切换提示整块是硬编码中文**：`setAgentModeUI` 里 `badge.textContent = "规划中" / "仅问答"` 和两条 tooltip，以及 `window.setAgentMode` 的 `toast(t("模式 → ") + 中文 tip)` —— 后者是**半英半中拼接**，而 `i18n-scan-mixed.js` 逐行看，中文在另一行的对象字面量里，它看不见。是抽屉探针切到 Plan 之后在截图里肉眼发现的；上一轮"26 个界面 0 残留"并不算错，因为那颗徽标**只有非 agent 模式才存在**，扫描面根本没覆盖到。现已整句键化（8 个键），并把"切一次 plan 再扫"写进 `_verify_i18n.js`（扫描面 26 → 27 个界面）。
2. **探针自己会跨语言串味**：终端日志和 `#toast` 节点在切语言后仍留着上一语言写下的字（toast 复用同一个节点、1.8s 后只摘 `.show`，`textContent` 一直在）。第一次把模式切换加进扫描面时，EN 态报出 54 条"残留"，全是中文态写下的日志行。现在扫描前先擦日志行（保留 `.term-intro` 那句外壳文案）并清 `#toast`。

**新增验收**：`scripts/_verify_gearmenu.js` **47 条断言**，已并入 `test:verify`（现 46 次调用）。三条口径值得抄给别的探针：① 出网的一律打桩看字符串（`window.open` 与 `navigator.clipboard` 都拦下来，逐字段断言拼出的 issue URL 和复制的那两串）；② 点下去要读回真实状态（`data-theme` / `getLang()` / `state.agentMode`），不测"按钮存在"；③ 每节自己把界面摆回起点 —— 上一节以 Esc 收起结尾，下一节直接点抽屉里的行会等到超时。

**契约改了，门也跟着改（不是把红点抹掉）**：`_verify_workbench.js` 原有一条 `入口 #btnSettings → model`，齿轮改成抽屉后它红了 —— 这是它该红，因为它守的就是旧契约。现在换成两条：「齿轮先出小抽屉、且不直接开工作台」+「抽屉底部『全部设置』→ model」。只留前一条会漏掉"全部设置进不去"，只留后一条会漏掉"齿轮又退回直接开工作台"。该探针 133 项断言全过。

**已知遗留（本轮之前就有，已实测归因）**：预览 iframe 是 `sandbox="allow-scripts"`（无 `allow-same-origin`），里面有脚本读 `localStorage` → `SecurityError`。判据：加载完一次没点就有 1 条，点齿轮后新增 0 条。`_verify_gearmenu.js` 只对这一条消息精确豁免，没有放宽成"忽略所有报错"。

---

### 3.12 任务计划 dock 到输入框上方 / 编排历史按会话分开 / 步骤胶囊那行数字（2026-10-15）

用户三条一起提的，其中一条是截图报的 bug（`步骤 0 · 1 个文件已修改 +1291 −1287`）。

| 需求 | 落点 | 关键取舍 |
|---|---|---|
| 任务计划从左侧栏挪到输入框上方，一个按钮打开看进程 | `index.html` 删掉 `#agSessions` 里那一段，新增 `#planBar` / `#planPop` / `#btnPlanToggle`；`app.js` 的 `renderPlan` 加 `paintPlanBar`、`clearPlanPanel` 连带收起；`styles.css` 的 `.plan-bar*` / `.pb-*` / `.plan-pop` | 常驻那一行就带 `x/y · 进度条 · %`，点开才摊清单：`bottom:100%` 向上弹、42vh 上限内部滚动、点外面收起、`aria-expanded` 跟着翻。不在侧栏留第二个入口（省空间就是要省），也不做成跳全屏 |
| 编排历史不同对话记录应该显示不一样 | `server/orchestrator.js` 落盘记录加 `conv`（新 `agent.currentConv()`：`convContext` 优先、回落 `_currentConv`），`histList` 透出；`app.js` `renderOrchHistory` 默认只摊本会话 | 字段上线前的老记录没有 `conv` → 只出现在「本工作区全部」，本会话视图不冒充是它的。切换行只在**确实存在别的会话记录**时才摆，否则白占一行；全部视图每条多一行归属会话标题（`orchConvTitle`，取不到退回 convId）。`openConv` / `startNewConv` 现在都跟着重拉一次（以前整轮只在启动和编排完成时拉，换会话列表纹丝不动） |
| 步骤胶囊的数字不对 | `public/js/utils.js` 的 `diffStat`、`app.js` 的 `renderStepPill` | 见下四条 |

**步骤胶囊拆出来四个缺陷，每个都先实测再动手**：

1. **口径混着用**：步数是**本会话**的，改动数是**全工作区待提交**的（跨会话不清零），两个口径拼在一句里读起来就像"这一步改了 1291 行"。现在 `if (!sp.n)` 直接不显示 —— 本轮一步没跑就不该有这颗胶囊。
2. **`diffStat` 被 Windows 行尾骗**：`original` 是服务端读回来的原文（CRLF），编辑器和 Agent 写的是 LF，`split("\n")` 之后每一行都不相等 → 实测 4 行真改动报成 `+1287 −1287`。现在两侧都先 `\r\n → \n` 再切。
3. **「步骤详情」下拉是自造的**：`positionStepDropdown` 里写 `style.zIndex = "var(--z-pop)"` —— 内联样式不解析 CSS 变量，那层 z-index 从来没生效过；状态文案还是硬编码中文。整段删掉，改成点胶囊 = 滚到本轮第一条步骤并闪一下（`jumpToFirstStep`），跟主流 agent 的进度条同一个语义。
4. **分母可以小于分子**：计划 2 步却干了 3 步是常态（临时补一次读、一次改），照抄 plan 步数会读出 `Steps 3/2` 这种不可能的进度。现在取 `max(total, n)`。

**顺带抓出来的四条（都是"读代码看不出、扫描也扫不到"的那类）**：

1. **Agents 窗口从来没被 i18n 扫过**：`_verify_i18n.js` 的可见性判据是"rect 有尺寸"，而 `#agentsWindow` 平时 `display:none` → 那扇窗里的界面一条都没进过扫描面。切过去扫第一遍就抓到两条硬编码：侧栏会话分组标题 `CONV_GROUP_LABELS = ["今天","昨天","本周","更早"]` 是**模块加载时求值的常量数组**（切语言不会重算，且它在 `#agSessionList` 的 `data-i18n-skip` 子树里，静态门也看不见），以及 `trace.js` 的 `N 事件`。扫描面 27 → 28 个界面，EN 态残留回到 0。
2. **`renderEnvPanel` 抄的是旧语言**：它把 `#sbBranch` 的文案原样抄进 `#envBranch`，而 `onLang` 回调里 `renderEnvPanel()` 排在 `sbBranch` 重绘**之前** → 英文界面留下一条「无 Git（快照基线）」。顺序换了并留了注释说明为什么不能换回去。
3. **`onLang` 的注册点必须落在 `let` 之后**：`onLang(fn)` 会**立刻**调一次 `fn` 再挂进钩子表，而外面那层 `try/catch` 只包住这一次立即调用。把 `if (currentPlan) renderPlan(...)` 写在 `let currentPlan` 之前，第一次调用抛 TDZ 被静默吞掉、钩子照样挂上 —— 表现是"切语言偶尔不刷新"，读代码完全看不出为什么。
4. **`trace.js` 里 `const t` 是颗地雷**：那个函数下面有 `const t = …秒数`，与全局 `t()` 同名。当时还没调字典所以 `i18n-scan-shadow.js` 不报（它查的是"调了 `t()` 又被局部遮住"），但一加 `t("nEvents")` 就整段进 TDZ。局部量改名 `stamp`。

**新增验收**：`scripts/_verify_plandock.js`，51 条断言，已并入 `test:verify`（现 47 次调用）。④ 那节打桩 `GET /api/plans?convId=`，断言"切会话时问的就是那个会话的 convId、两条计划互不串、别的会话推来的 `plan.created` 不盖掉当前这条"。⑦ 那节反过来——**不打桩，走真 HTTP + 真 WS**：沙箱没配 API Key，起的就是内置演示引擎，正好是被修的那条路径。`_verify_layout.js` 的编排历史那节从"灌一条"改成"灌三条（本会话 / 别的会话 / 无 conv 的老记录）"，156 项全过。

**顺着 ④ 那句"为什么必须打桩"查出四个洞，同轮补齐（2026-10-15 第二批）**：

1. **演示引擎下任务计划整条不可用**：`PlanStore` 在 `buildEngine` 里是跨用户共享的（`_engineAssets.plan`），但只有 `LlmAgent` 把它接到 `this.plan`（`server/agent-llm.js:1646`）。没配 API Key 的装机 —— 桌面端开箱就是这个 —— `engine.plan` 是 undefined，`/api/plans` 一律回"引擎未就绪"、计划条永远不出现。现在挪进 `AgentBase` 构造（`this.plan = ctx.sharedPlan || null`）：计划是"项目级"资产，跟引擎是不是真 LLM 无关。
2. **`update_plan_task` 前端发了服务端没人接**：全仓只有 `public/app.js` 一处发它，WS 分支里没这个 case —— 点计划条目打勾只是画在界面上，刷新按服务端为准又弹回。现在接住、落 `PlanStore.updateTask`，再把 `plan.updated` 按发起者 userKey 推回。
3. **手动"+"新建计划走的也是死消息**：`btnNewPlan` 发 `{type:"tool_call"}`，服务端 WS 分支同样从没接过 `tool_call` —— 点它只会在控制台留一条没人理的广播。当天先改成走真 `POST /api/plans`，随后按用户判断**整个入口撤下**：计划是 Agent 面对复杂任务时自己建的东西，输入框上方留一个"手填步骤"的加号是把编排器当待办清单用。`/api/plans` 两条路由的 broadcast 顺手补上 `tokenUserKey(tokenOf(req))` —— 不带 key 是发给所有连接的，别人的计划会串进你的窗口。
4. **`diffStat` 的 CRLF 缺陷服务端也有一份，而且那份才是主源**：`server/agent-base.js` 里那把尺子是改动数的单一实现（`agent-base.js` 的 changes 事件、`patch.js` 的审阅统计都用它），前端 `public/js/utils.js` 只是同逻辑的第二份。上一轮只修了前端那份 —— 用户截图那个 `+1291 −1287` 走的正是服务端。两边现在都先 `\r\n → \n` 再切行。

**打包为什么改道（`npm run dist` 现走 `scripts/dist.js`）**：electron-builder 的 Windows 流程是"在 `release/win-unpacked.tmp` 铺好整棵树 → 删旧 `win-unpacked` → 把 `.tmp` 改名过去"，改名/删除要求树里没有文件被别的进程以"不许删"的方式打开。实测用 Restart Manager 查到握着 `release/win-unpacked.tmp/resources/default_app.asar` 的是 **IDE 自己（Qoder）**——它监听工作区、会打开新出现的文件。于是连撞两次：

```
⨯ EPERM: rename 'release\win-unpacked.tmp' -> 'release\win-unpacked'
⨯ EBUSY: unlink  'release\win-unpacked.tmp\resources\default_app.asar'
```

而且那个删不掉的 `.tmp` 会让**之后每一次**打包都失败（它开头就要清同名残留）。现在 `scripts/dist.js` 把中间目录放到系统临时目录（不在任何监听根里），跑完只把 `Setup <ver>.exe` / `.blockmap` / `latest.yml` 拷回 `release/`，解包目录的位置写进 `release/.unpacked-path`，`_verify_pkg.js` 自动读这个记号。代价是 `release/win-unpacked` 不再是常驻产物 —— 换来的是打包在这台机器上从"必红"变回可重复。

---

### 3.13 Agents 左栏改成「任务 / 会话」收件箱（2026-10-17）

**为什么改这一处**：`server/tasks.js` 那张任务表早就在记"谁在跑、谁卡在审批、上次哪条没跑完"，事件流一路喂着它，`/api/tasks` 与握手里的 `hello.tasks` 也都通着 —— 但**前端一行都没接**，全项目只有 Electron 托盘那行"在跑 N"读它。也就是说桌面外壳已经知道的答案，界面反而答不出来。这一轮把这份既有数据接成左栏的一等公民，后端只补了两个字段（`snapshot()` 里的 `waitingFor` / `error`，见 `server/tasks.js:120`）。

**形态**：`#agSessions` 顶上换成一段 segmented 控件（任务 / 会话），默认落在**任务**；会话列表原样搬进第二页，`#btnNewConv` 跟着页签走（任务页不收"+"，不在任务页发新建会话的指令）。编排历史仍留在侧栏底部，不在这两页里。卡片点一下 = `openConv(convId)`，当前会话那张标 `current` 并给一个 chevron。

**刷新口径**：事件驱动（`app.js` 的 `handleEvent` 第一行调 `tiOnEvent`，400ms 合并，一轮里 `tool.end` 能连来几十条）+ 6 秒兜底轮询，两条都过 `tiVisible()`：页签不在任务、窗口不在 Agents、`document` 不可见 —— 任一不满足就不打网络。这条不是洁癖：`_verify_taskinbox.js` ⑥ 用 7 秒静默窗口量过，CODE 模式下 0 次请求，切回来立刻有。

**顺带抓出的四条"切语言刷成假状态"**（都是截图目视看到的，四条扫描器量不到）：

| 现象 | 根因 | 收口 |
|---|---|---|
| 已登录，切一次语言顶栏变回「未登录 / Not logged in」 | `#tbUserTxt` 挂了 `data-i18n`，而 `applyI18n()` 会把每个 `[data-i18n]` 的 `textContent` **无条件**刷成词条 —— JS 写的用户名被静态扫描抹掉 | 摘掉 `data-i18n`，文案归 `setAuthUserUI()` 所有，空值走 `t("notLoggedIn")`，并注册 `onLang` 重画 |
| 英文界面顶栏漏「AI 分析任务中」 | 演示引擎 `state(true, "AI 分析任务中")` 是服务端中文，`tr()` 查不到键时**原样返回**，`||` 链就此短路 | `paintState()` 判定"没查到"就退回通用文案；中文态仍显示服务端那句具体的话 |
| 英文界面编排历史空态是中文 | 空态本身走了 `t()`，但 `renderOrchHistory()` 没挂在 `onLang` 上；且它装在 `data-i18n-skip` 容器里，中文扫描按设计跳过 → **扫描器的盲区** | `onLang` 里补一条重画；探针改成"只切语言、不手动重画"来量这条钩子 |
| 开机就挣两条 401 | `tiSetPane` 在脚本加载时抢跑 `fetch("/api/tasks")`，`onLang` 注册即执行又抢跑一次 `/api/orch/history`，那一刻 `AUTH.token` 还是空串 | `tiFetch` 无 token 直接返回；编排历史那条加"已经画过东西才重画"的门。回归由 `_verify_uitaste` 的"整轮零页面报错"守住 |

同类隐患用一次性静态扫描列了全表（`data-i18n` 元素 ∩ JS 直接写它的 `textContent`）：除上面三处，还有 `#btnAutoNew`（写死中文"收起表单"）、`#orchTitle`（中文兜底）、`#onboardNext`（最后一步的"完成"被刷回"下一步"）、登录框五个字段（`AUTH_TEXT` 在脚本加载时算死，切语言后停在旧语言）。全部改成现取词条 + 开着的时候随 `onLang` 重画。

**验证**：`scripts/_verify_taskinbox.js` 39 条断言，已接进 `test:verify`（47 → 48 步）。全链 48 步一次跑绿，`_verify_layout` 156、`_verify_plandock` 51、`_verify_gearmenu` 47、`_verify_i18n` 17、`_verify_uitaste` 45 都没被侧栏改版碰坏。

**这一轮新学的两条探针纪律**（写进记忆页 `pancode-probe-discipline.md`）：
1. **截图写完要认文件名唯一**：⑤ 里两行都往 `taskinbox_en.png` 写，第二行是切回中文之后写的 —— 于是"英文零中文"那条断言全绿，而屏幕上那张"英文截图"整页中文。目视复核抓到的是**证据本身是假的**。现在截图统一走 `shot()`，写失败会吭声，且每张文件名各自唯一。
2. **状态驱动的假数据会被真轮询冲掉**：喂进 `TI.rows` 的六行假状态，6 秒兜底轮询一到就换成服务端真数据。所以"摆状态 + 量"必须在**同一次 `page.evaluate` 里**做完，中间让出一个 tick 就量到的是真数据（④ 一开始正是这样过了，⑤ 第一版这样红了）。

---

### 3.14 收件箱当天撤下 + 「无故中断」的真身（2026-10-17，同一天）

**用户反馈原文**：「不好用啊侧边任务栏，感觉没必要，还有长任务很不稳定。经常无故中断」。上一节（§3.13）那套「任务 / 会话」分段当天撤掉，只保留 `TaskBoard` 与 `/api/tasks`（托盘那行"在跑 N"一直在读它，那是另一个东西）。**留下的判据**：他的任务表里四条标题是「还没完成」「完成了吗」「还有残留任务未完成」「继续」—— 一个人反复追问任务为什么停，不是想要一块看状态的面板。

**「无故中断」查到了实处，是三条叠在一起**（截图里那行「已思考 · [SSE 流空闲超时，已保留已收到的部分结果]」是钥匙）：

1. **半截流被当成说完了**。`server/llm.js` 三处收口判据是 `acc.finish || acc.content || acc.toolCalls.length` —— 只要吐过一点内容就算正常完成。流被空闲超时或网络掐断时返回"成功"，而这一口没有 `tool_calls`，ReAct 循环 `if (!r.toolCalls.length) break;` 直接收尾：**任务停在计划 3/9，引擎认为自己做完了**。现在三处统一只认 `finish_reason`（`trulyDone()`），其余一律抛错交给重试梯子；重试前把上一张卡 `end()` 掉并置空，避免半句和整句挤在同一张气泡里。空闲窗口下限从 20s 放到 5s（默认仍 90s），让慢网关能调、探针也能测。
2. **失败被盖成完成**。出错时引擎先发 `agent.error`、`finally` 里无条件再发 `agent.done`，`server/index.js` 的 `observeTask` 于是把刚标的 `failed` 改回 `done`，只清了 `waitingFor` 没清 `error` —— 任务表、托盘、系统通知三处一起说谎。现在 `agent.done` 遇到已判失败的行保持 `failed`（下一轮 `begin()` 会重置，不会串台），干净收口时才把 `error` 擦净。
3. **停在半路是静默的**。普通模式（没开 Goal）跑到一半自己停下、计划还有步骤没勾掉时，界面什么都不说。现在收口前留一行终端 + 一句人话：「我先停在这里：计划还有 N 步没完成 —— …」，并告诉他想要一路自己跑就点 Goal。**不自动续跑**：那是 Goal 的职责，普通模式下自作主张会烧钱。

**反向对照都做过**（不然这 17 条断言不算数）：把判据放回旧写法 → 探针 6 条红，且任务表原样重现用户那条 `status:"done", error:""`；把 `keep` 拿掉 → 3 条红。过程中还修了探针自己的一处假绿：`runRound` 一见 `agent.error` 就返回，抢在 `agent.done` 盖状态之前读表，②那组当时测不到东西 —— 收口一律以 `agent.done` 为准。

**新探针**：`scripts/_verify_streambreak.js` 17 条，真服务端 + 真引擎 + 真任务表 + 一个会说坏话的假 SSE 上游（不打桩 `llm.js`，打桩它就测不到自己）。`test:verify` 48 步全绿，`test:unit` 53 文件 / 993 条全绿。

### 3.15 关窗「记住我的选择」、托盘重做、8 小时那一档的审计（2026-10-17）

**用户原话**：「还有优化点击关闭的提示窗口及逻辑，现在好像无法记住选择，设计丰富后台托盘功能；全面检查agent操作流程，一定要确保稳定、高效，这是关键能力，能持续完成七八小时以上的长任务」。

**① 「记住我的选择」坏在一个字段名上。** `electron/main.js` 读对话框返回值那行写的是 `res.checkboxValue`，而 Electron 的字段叫 `checkboxChecked` —— 永远是 `undefined`，勾了也不落盘，于是每次关窗都问一遍。**讽刺之处是判据一直是绿的**：`close-policy.js` 的 `decideClose({ remember: true })` 有单测、18 条全过，坏的只是它上游那一行取值。**集成点不测，就等于没修**——这条已经进了探针纪律。

**② 又抓到一处「注释写了、代码没做」。** 主进程里"显式给了 `PANCODE_DATA_DIR` 就把 userData 一起搬过去"那段挂在 `if (app.isPackaged)` 里面，dev 态探针根本走不到：渲染进程的 localStorage、缓存、着色器全写进真实的 `%AppData%\pancode`，注释里那句"否则沙箱数据根就是假话"当时是真话没执行；更糟的是它和装着的那个实例抢同一把单实例锁，用户开着 pancode 时探针会被锁直接弹掉。现在搬出 `isPackaged`，给了就听。

**③ 托盘：从"一行状态"改成"回得去现场"。** 菜单按 **等你批 → 在跑 → 上次没跑完 → 最近收口** 四组排（要人动手的永远在最前），每组封顶 6 条、多出来的并成「还有 N 条…」；一条任务项只写"点开它能得到什么"——要批什么、为什么出错、跑了多久，不写工具数这种没人用来决策的数字。**点一条 = 唤回窗口 + 跳到那条会话**：主进程 `openConversation()` → `pc-open-conv` → `app.js` 切 Agents + `openConv(id)`。窗口可能藏着、可能已被销毁要重建、也可能页面还没加载完 —— 第三种先记 `pendingOpenConv`，等 `did-finish-load` 补发，否则 IPC 发进一个还没接听的渲染进程。底部三条动作：打开工作区文件夹、复制诊断信息（版本 / 引擎 / 任务表 / warn 以上日志，并明说"任务标题取自你的指令原文"）、退出（有活先确认）。

**④ 8 小时那一档：以前是做不到，被一行代码挡死的。**

| 症状 | 根因 | 现在 |
| --- | --- | --- |
| 跑到半小时像"卡死"后静收 | `setTimeout(cfg.agentMaxMs ‖ 30*60*1000)`，而 `agentMaxMs` 这个配置键**从来不存在**（注释还写着"可配置"）—— 一律 30 分钟硬墙钟 | `server/run-watchdog.js` 纯判据：**停滞** 6 分钟才中断（一直有进展就永远不断），墙钟兜底 8 小时；两个键都进了 `config.js` DEFAULTS 与 `saveAgentSettings` 的校验 |
| 越跑越慢，最后不动了 | `pushChanges` 每个改盘工具都对**全部累计脏文件**逐个 `git show` + 读全文 + 评分（实测 126ms/文件）——50 脏文件 × 200 次工具 = 一万次子进程，成本随任务时长线性涨 | 按 `size:mtime` 增量缓存 + 只重算这次碰过的（`hintPaths` 强制重算）+ 8 路并发；脏文件集合一变或 15 秒 TTL 整体重算，外部 commit 最多迟到 15 秒 |
| 出错就一刀切重试 3 次 | 密钥/模型写错这种重试多少次都不可能对 | 按错误分级：鉴权/模型类 1 次、配额 3 次、其余 5 次，指数退避封顶 24 秒 |
| 进程被强杀丢整段进度 | 只有收口才落盘 | 每轮跑完就 checkpoint 落盘（防抖写，不是每轮一次全量序列化） |
| 点「停止」之后 Goal 还在自动续跑 | 中断没清目标 | `abort()` 清 `_goal` + 状态位 + 发 `goal.settled` |
| 一条会话压缩失败，别的会话从此不压缩 | 熔断位挂在引擎级 `this._compactStopped`（对象恒真） | 熔断按会话分桶；取 id 走 `currentConv()`（AsyncLocalStorage 优先）而不是 `_currentConv` —— 并行时后者会被别的会话切走，用它记账等于把 A 的断路器扣到 B 头上。`test/p1-compact-budget.test.js` 加了一条"cA 压不动不许关掉 cB" |
| 跑前解析 @文件/技能抛错，那条会话永远"在跑" | 预跑窗口没有 catch，`runningConvs` 没清 | 抽 `abortEarly()`：清 running、清中断位、恢复 `_currentConv`、发 `agent.error` + `agent.done` |

**⑤ 这一轮的判据分三层，每层都能红。**
- `test/p3-longrun.test.js` 22 条：看门狗判定（31 分钟有进展不许掐、7 分钟停滞必须掐、非法配置退回下限）、托盘分组纯函数、`pushChanges` 缓存五例（真临时文件 + 计数假 git，验"第二次一个子进程都不起"），外加**三处通道字面量一致**（主进程 `send("pc-open-conv")` ↔ preload 监听 ↔ `app.js` 注册 `onOpenConv`）——任意一处改名，运行期一声不响，只有这里钉得住。
- `test/p3-close-policy.test.js` 18 条：钉住主进程必须读 `checkboxChecked`、不许再出现 `checkboxValue`。
- `scripts/_verify_desktop.js` 起**三个真 Electron 实例**（41 条，全绿）：A 关窗=挂后台（顺带断托盘菜单快照真的含这条任务、点击真的把藏着的窗口唤回成 `可见=true`、收口后从「在跑」搬进「最近收口」）；B 关窗=问，**关两次窗**——第一次注入答复 + 勾记住 → 配置文件里 `desktop.closeAction` 真的变成 background → 第二次「注入答复」那一行不再出现而「挂到后台」累计两次。只验第一次的话，"记住"这两个字没有任何判据；C 关窗=直接退出，进程与端口必须真的没了（否则"有托盘就永远挂后台"会变成看不见又关不掉的幽灵进程）。
  **反向对照做过**：把那行改回 `res.checkboxValue` 重跑 → B 红 3 条，最关键的是「注入答复出现 2 次」——正是用户投诉的那个现象第一次有了能红的判据。顺带发现「挂后台累计 2 次」在坏版本下也是绿的（问一次照样会挂后台），所以它只是陪跑，真正的刀是计数那一条。
- 新探针 `scripts/_verify_trayjump.js` 13 条补渲染端那一层：桌面沙箱的窗口停在登录页，`pc-open-conv` 发进去只会被 `openConv` 的 `try/catch` 悄悄吃掉，所以这里用 Playwright 抢在 `app.js` 之前搭一个假 `pancodeWin` 桥（形状照 preload 抄），在真页面 + 真登录态里按下"托盘那一条"，断言回到 Agents、当前会话切过去、**那条消息真的渲染在屏上**，再加自跳 / 空 id / 不存在的 id 三个边界。反向对照：把 `app.js` 那个处理函数短路成直接 `return` → 5 条红；这一拆顺手抓到两条"假独立"判据 —— 「再点一次同一条」「空 id 被挡在门外」当时写成 `active === convA`，只有上一条跳转成功才可能红，等于在复读③那一节，改成"同一次 evaluate 里取按下前 / 按下后"才是自己的判据。顺手把吞掉的异常改成 `console.warn("[ui] 托盘跳会话失败 …")`，并把"没有这条告警"做成断言——不然 `try/catch` 一吞，探针测的只是"没崩"。

**⑥ 仍然欠着的，写清楚不装。** ① `fs.watch` 的全量快照仍是每次全读，超大仓 + 8 小时会先撞上它；② 保留的用户消息还没有滚动摘要，压缩只能整段折；③ 渲染端会话视图缓存进 localStorage，配额满时按最老淘汰（只淘汰快照、不动偏好，`lsWarnFull` 会 toast 一次）—— 8 小时那一档最先碰到的会是这条，但那只是视图缓存，文字历史在服务端。①② 是这一轮明确没做的两项，不是没发现。


---

## 4. 与竞品的定位差异（不是所有「差距」都该补）

对标时有三处 **pancode 的选择是合理的**，不应照抄竞品：

1. **不做 OS 级沙箱不代表不安全。** Claude Code 自己的沙箱也只包 shell，且失败默认降级为不沙箱继续跑（要硬失败得显式设 `sandbox.failIfUnavailable=true`）。pancode 走「权限规则 + 命令语义黑名单 + 审批」这条路，对单机桌面场景是合理取舍。**真正要补的是 C-B1 / C-H1 / C-H2 这三条「规则存在但没在所有路径上生效」的洞，而不是引入一个半成品沙箱.**
2. **不做 LLM 分类器审批是对的。** Cursor 的 auto-review 依赖后端 LLM 分类器，官方自己明说「不是安全边界」；Cline 的 Auto Approve safe command 是模型自己打标，官方承认「examples, not guarantees」。pancode 的 deny/allow/审批三段式在语义上更硬。
3. **子智能体的权限模型比 Cline 严格。** 见 §2.3 第 1 条，不要为了「并行更快」把它改成「一次批准、一路放行」。

### 4.1 P2 里三项「已评估、决定不做」（2026-10-14）

补齐 P0→P2 时对这三项各做过一轮方案设计，结论是**不做**，理由是定位而不是工作量。记在这里，避免下一轮对标把它们当成"漏了"再捡起来。

| 项 | 竞品对应 | 决定不做的理由 |
|---|---|---|
| 团队协作（多人共享会话 / 协同编辑） | Cursor Bugbot、Cline 的云端共享会话 | pancode 已定死**单机桌面优先**（见 [desktop-first-2026-10.md](desktop-first-2026-10.md)）。多人共享的第一件事是"谁的数据根"——现在 `.pancode/` 与用户令牌都是单用户假设（记忆、规则、审计、会话全按 userKey 分目录），加协作者等于把授权模型和数据根模型一起重做，而这两块正是本轮刚收口的 C-H4 / C-M4 / C-M5。**收益不抵返工**。 |
| 远程开发（SSH / 云端容器工作区） | Cursor 的 remote-SSH、Codespaces | 同上，且更贵：远程即第二套文件系统，`FileStore`、`GitLayer`、code-index、LSP bridge 全都按"本地目录"写的，跨机要做流式与一致性，任何一处漏了就是静默读到旧内容。pancode 的差异化在"本机 Agent 用得放心"，不在"能在别处用"。 |
| 插件扩展层（第三方插件市场 / 沙箱化 API） | VS Code 扩展、Cline 的 MCP 市场 | 已有两条**够用**的扩展通道：MCP 工具（`server/mcp-bridge.js`，外部进程、天然隔离）与 Skill（`create_skill` / `use_skill`，声明式、进契约表）。再加一层"进程内插件 API"会把权限模型从"工具契约 + 审批"换成"任意代码 + 沙箱"，正是 §4 第 1 条里拒绝走的那条路。**要扩能力就加 MCP server，不加插件宿主。** |

其余 P2 项（多智能体 DAG 可视化、跨文件重构、技能市场增强）与 P3 全部照原计划推进。

---

## 5. 复核与免责

- 本文中所有 `file:line` 引用均由主会话逐条读代码确认，**未采信子代理转述**。
- 三份审计子代理全程只读，未修改任何文件。
- 安全审计的 `npm audit` 因沙箱限制未执行，**依赖漏洞维度未覆盖**。
- 竞品报告中 Codex CLI / Copilot CLI 为 snippet 级（官方站 fetch 被拒），其结论可信度低于其余四家.
- 之前的 [gap-analysis-2026-08-12.md](gap-analysis-2026-08-12.md) 记录 P0/P1/P2 缺口已全部清零（仅剩 fast-apply 依赖外部小模型端点）；**本文是新一轮「对齐竞品」的清单，与旧文档不冲突，两份应并存**.
