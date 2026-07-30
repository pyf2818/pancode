# pancode 优化方案（第一性原理）

> 2026-07-30 · 基于 v2.3.0 全量代码审计
> 覆盖：前端样式·效果·体验 / 后端稳定·安全 / 用户体感·便捷

---

## 0. 第一性原理：pancode 的本质

剥掉所有表象，pancode 有三个不可简约的事实：

1. **本地优先（Local-first）**：跑在用户机器上，操作用户的真实文件，用用户的 LLM Key。
   → 安全模型不是"防多租户互相伤害"，而是"防 Agent 误伤用户、防本机能力被滥用"。
2. **价值闭环**：`用户意图 → Agent 感知/决策/执行 → 用户审查 → Agent 沉淀学习 → 下次更懂`。
   → 每一次优化，要么收紧这个闭环，要么是噪音。
3. **三根支柱**：Editor（人写代码）、Agent（AI 写代码）、Evolution（让 AI 越来越懂）。三者必须协调一致。

**判据**：任何改动，如果它让"意图 → 结果"闭环更快 / 更安全 / 更可信任，就是对的；否则是装饰。
这条判据是下文所有 P0/P1 排序的唯一依据。

---

## A. 后端稳定 · 安全（最高优先）

> 理由：本地优先产品的命门是"信任"。Agent 能写盘、能执行命令——一旦失控或崩溃，
> 用户损失的是真实代码。稳定性与安全是闭环能持续运转的地基。

### A1. 认证模型重构 【P0】
**问题**：存在两套互不相干的认证。
- `AUTH_TOKEN`（`server/index.js:31`，每次启动随机）才是真正的 API 闸门。
- `auth.js` 的用户注册/登录返回 `userToken`，**但该 token 从未被主鉴权中间件校验**——`/api/auth/*` 全在 `NO_AUTH` 白名单（`index.js:117`），`auth.verify` 仅用于 `/api/auth/status` 显示用户名。
- 后果：用户账号系统是"装饰性"的，任何人拿到 `AUTH_TOKEN`（本机 `/api/bootstrap` 可领）即可访问全部受保护 API。

**方案**（二选一，推荐前者）：
- **方案 A（推荐）**：让登录真正成为闸门。登录成功后下发 `AUTH_TOKEN` 作为会话凭证；未登录时除 `/api/auth/*`、`/api/health`、`/api/bootstrap`（仅 127.0.0.1）外全部 401。保留多用户但每个用户隔离自己的工作区记忆。
- **方案 B**：移除 `auth.js` 用户系统，明确"单用户本机工具"定位，避免误导。

### A2. 收紧 API 白名单 【P0】
**问题**：以下敏感端点在 `NO_AUTH` 白名单（`index.js:117`），无 token 即可访问：
| 端点 | 风险 |
| --- | --- |
| `GET /api/fs/browse` | 可枚举**任意系统目录**（不受 `safePath` 约束，`index.js:315`） |
| `GET /api/raw` | 读工作区内任意文件 |
| `GET /api/models` | 用服务端 Key 代理调外部 LLM，可被滥用消耗 quota |
| `GET /api/state` | 泄露工作区全量文件快照 |
| `GET /api/skills/all`、`/api/plans` | 泄露项目数据 |

**方案**：除 `health/version/bootstrap/auth/*` 外全部要求 token；`/api/fs/browse` 额外限制只能浏览工作区及其上级目录（防全盘枚举）。

### A3. 全局兜底 + 优雅关闭 【P0】
**问题**：
- `server/` 内**无** `process.on("unhandledRejection"/"uncaughtException")`。一个未捕获的 Promise reject 会让进程直接退出（Node 15+ 默认行为）。`agent-llm.js` 内大量 `.catch(()=>{})` 静默吞错（`agent-llm.js:846-855`），掩盖问题。
- `shutdown`（`index.js:762`）未 kill `term.current` 子进程 → 孤儿进程；未中止进行中的 Agent。

**方案**：
- 加 `process.on("unhandledRejection"/"uncaughtException")` → 记日志 + 广播 `op.error` 到前端，不杀进程。
- `shutdown` 序列：abort Agent → kill 所有终端子进程 → 关 WS → 停 watch → `server.close` → 3s 兜底。

### A4. 内存治理 【P0】
**问题**：长期运行内存只增不减的 4 个点：
| 位置 | 问题 |
| --- | --- |
| `agent-llm.js:225` `conversations` | 多对话历史，无上限、无淘汰 |
| `files.js:75` `_selfWrites` | 只 `set` 不 `delete`，每次写文件追加 |
| `auth.js:13` `sessions` | 24h 过期但仅惰性清理，未登录用户 token 永不清 |
| `files.js:120` `_binCache` | 删除的文件 key 不清 |

**方案**：`conversations` 加 LRU 上限（如 20）；`_selfWrites` 改 TTL/Set；`sessions`/`_binCache` 定时清扫。统一一个 `createLruMap(max)` 工具。

### A5. 并发安全 【P1】
**问题**：所有 store 都是"读 JSON → 改内存 → 整体覆盖写"，无锁。并发请求会丢更新：
- `auth.js` users.json 并发注册丢更新；
- `memory-store.js` 并发写覆盖；
- `skill-store.js` `_saveMarket` 先写后删，中途崩溃留半成品。

**方案**：写操作串行化（每个 store 一个异步写队列 `enqueue(fn)`），或文件级乐观锁（读时记 mtime，写时校验）。`_saveMarket` 改"先全写成功再删旧"。

### A6. 命令安全升级 【P1】
**问题**：`security.js` 正则黑名单可被 base64 解码、变量拼接绕过；`auto` 模式下黑名单是唯一防线。
**方案**（第一性：本地优先下命令安全 = 防 Agent 失控造成不可逆损害）：
- `run_command` 默认限制 `cwd` 在工作区内；
- 危险操作（删除/覆盖/全局安装）即使 auto 模式也强制二次确认；
- 所有 `run_command` 落审计日志（`.pancode/audit/`），可追溯。

### A7. 同步阻塞 + 残留文件 【P1】
**问题**：
- `git.js` 用 `spawnSync`/`execFileSync` 同步阻塞事件循环，大仓库卡顿。
- `config.js:52` `writeJsonSafe` rename 失败后 tmp 不清理 → 根目录已出现 `pancode.config.json.47148.tmp`。
**方案**：git 操作改异步；`writeJsonSafe` 失败后清理 tmp；启动时扫描清理残留 `.tmp`。

### A8. CORS + 输入校验 【P2】
**问题**：无 CORS 中间件（默认同源，但应显式）；`req.body` 字段粗暴 `String()` 强转无 schema。
**方案**：显式配 CORS（同源或白名单）；关键路由加轻量校验。

---

## B. 前端样式 · 效果 · 体验

### B1. z-index 层级系统 【P0】
**问题**：弹窗 z-index 散落内联（70/80/90），已踩过"编辑灵魂被图鉴遮罩挡住"的坑（`.evo-codex-mask:80` 盖住 `#evoDetailModal:70`）。
**方案**：建立 z-index token，集中管理：
```
--z-dropdown:100; --z-panel:200; --z-modal:300;
--z-overlay:400; --z-toast:500; --z-codex:350;
```
所有弹窗按语义取 token，禁止内联 z-index。

### B2. 状态管理集中化 【P1】
**问题**：`app.js` 2879 行单文件、106 个函数，全局 `state` + 散落的 `previewOn/previewZoom/evoData/models` 等，"改一处忘另一处"频发。
**方案**：引入轻量集中 store（不必上框架）：一个 `Store` 模块 + 订阅，UI 按域订阅。先收编预览/进化树/聊天三块状态。

### B3. app.js 渐进模块化 【P2】✅ 已完成
**问题**：2879 行单文件难维护、难协作。
**方案**：按域拆分（chat / files / preview / evolution / settings / terminal），ES module 或 IIFE 命名空间。**渐进式**，不一次性重写。

**落地**：采用「经典脚本 + 全局命名空间」（非 ESM——被抽模块含顶层事件绑定，需加载即执行）。
`public/js/` 新增 6 个模块，`app.js` 3110 → 1945 行（-37%）：
| 模块 | 内容 |
|---|---|
| `core.js` | 全局 `$` / `esc`，最先加载 |
| `evolution-codex.js` | 进化图鉴：树/SVG/时间线/节点详情/灵魂编辑 |
| `settings.js` | 模型设置、Agent 设置、工作流、沉淀、打开文件夹、欢迎语 |
| `skill-market.js` | Skill 市场列表/详情/导入/删除 |
| `cmdk.js` | 命令面板（Ctrl/⌘+Shift+P） |
| `onboard.js` | 首次引导 |

`index.html` 按依赖顺序在 `app.js` 之前注入。纯搬运，**零行为变更**。

### B4. 浅色主题完整性审计 【P1】
**问题**：SVG 内多处硬编码颜色（`fill="#fff"`、`#1a8c6e`、`#eef0f2`），浅色下部分元素对比度不足或不可读。
**方案**：SVG 颜色改用 `currentColor` + CSS 变量驱动；逐屏走查浅色模式。

### B5. 加载与动效体验 【P2】
- **首屏**：Monaco loader 同步阻塞白屏 → 加骨架屏/splash。
- **动效统一**：建立 motion token（`--ease`、`--dur-fast/normal/slow`），统一面板展开/tab 切换/消息入场。
- **a11y**：补 `aria-label`、键盘焦点环、弹窗 focus trap（技术用户也受益键盘流）。

---

## C. 用户体感 · 便捷

### C1. 意图→结果闭环提速 【P0】
- **输入增强**：`@文件` 引用、`/命令`、历史快搜。
- **Agent 进度可视化**：现有 think/tool 卡片，加"整体进度"（计划步骤 X/Y + 当前阶段）。
- **审批流**：`tool.pending` 120s 超时；加"批量批准同类"、"记住此操作允许"（写入 allow 清单）。

### C2. 错误恢复体感 【P0】
**问题**：LLM 429/网络错误时用户只看到断流，不知原因。
**方案**：错误分类提示（配额耗尽 / 网络中断 / Key 无效 / 模型不存在）+ 一键重试按钮。

### C3. 命令面板 + 快捷键体系 【P1】
**问题**：技术用户期望 `Ctrl+Shift+P` 命令面板（VS Code 习惯）；快捷键散落。
**方案**：加命令面板（聚合所有操作）；集中 keymap + 可配置。

### C4. 首次引导 【P1】
**问题**：新用户不知如何配 LLM、如何开始。
**方案**：首启检测——无 Key → 引导配置 or 一键演示引擎；配好 → 引导发第一条消息。

### C5. 进化树反哺 Agent（闭环关键）【P1】
**问题**：`progression` 目前只是展示，`path` 乘子影响属性计算但属性**不影响 Agent 行为**。
**方案**（第一性：进化必须真实改变行为才算进化）：
- 灵魂/记忆已注入 Agent（好）；
- 让 `path` 影响 Agent 系统提示词偏向（工匠→更重质量检查、学者→更重文档沉淀）；
- 让进化阶段解锁能力（如阶段≥2 才允许 auto 模式、阶段≥3 解锁 Goal 持续执行）。

### C6. 工作区会话持久化 【P2】✅ 已完成
**问题**：前端 localStorage 只存了聊天 **DOM 快照**，刷新后"看得见历史但 AI 不记得"；服务端 `conversations` 是纯内存 Map，进程重启即全丢。

**落地**：
1. **服务端落盘**（`agent-llm.js`）：`conversations` Map 持久化到 `.pancode/conversations/<wsHash>.json`。
   - 构造时 `_loadConversations()` 恢复全部对话 + 上次活跃对话；
   - 每轮对话结束（`handleChat` 的 `finally`）、切换会话、`newchat`、`reset` 时落盘；
   - 写入走 `safe-write.saveJson`（原子写 + 按路径串行），600ms 防抖；
   - 裁剪策略：最多 20 个对话 × 每对话最近 80 条消息，防文件膨胀；
   - `SIGINT/SIGTERM` 优雅关闭时 `flushConversations()` **同步刷盘**，防抖来不及也不丢。
2. **前后端会话对齐**（`app.js`）：`send()` 统一为 `chat` / `newchat` 自动注入 `convId`；`openConv` 发 `switchConv`、`deleteConv` 发 `dropConv`；WS `onopen`（含断线重连）自动同步当前 `convId`。
3. **协议补全**（`index.js`）：新增 `switchConv`（回 `conv.switched`，带恢复的消息条数）与 `dropConv`；`switchConversation` 加同 ID 幂等保护。

**效果**：刷新 / 重启服务后，选中任一历史会话，AI 上下文一并恢复；前端终端提示「已恢复 AI 上下文（N 条消息）」。

### C7. 聊天 UX 增强 【P2】✅ 已完成
**问题**：聊天交互细节缺失——历史消息难复用、发出内容复制麻烦、模式切换无快捷键、上下文占用不透明、Skill 市场展示噪音、工作流"补充文档"图标缺失、还原工作区一键即回退无二次确认。

**落地（commit 9e8e22b）**：
1. **历史消息复用**（`app.js`）：输入框 ↑/↓ 浏览当前会话已发消息并填入；↓ 回到最新时清空；`sentUserMsgs[convId]` 按会话缓冲。
2. **消息快捷复制**：已发/收到消息悬停出现复制按钮（`addMsgCopyBtn`，`navigator.clipboard` + `execCommand` 兜底）。
3. **模式快捷键**：`Ctrl/Cmd+.` 切换 Editor（正常）↔ Agents（agent）模式并 toast；说明写入 `settings.js` 欢迎语。
4. **上下文实时显示**（`refreshCtx`）：底部条显示「N 条消息 · Xk/Mk tokens（Y%）」，与后端 `context.usage` 对齐，流式增长用 `content.length/4` 估算。
5. **Skill 市场去噪**（`skill-market.js`）：移除 3 处"引用 N 次"展示，保留"引用到对话"动作。
6. **工作流图标修复**（`icons.js`）：补 `md`（文档）/ `copy`（复制）图标，修复"补充文档"因 `icon:"md"` 无图标而空白。
7. **还原工作区二次确认**：`btnReset` 改为自定义 `showConfirm` 弹窗（列未保存文件数），确认后才执行。

### C8. 会话级工作态隔离 【P2】✅ 已完成
**问题**：C6 只隔离了聊天历史。计划、实时终端日志、文件改动三块仍是**全局共享**——多会话下 A 会话做的事会串到 B 会话的面板里，且无法按会话分别审视"这次会话到底改了什么"。

**落地（commit 8282ca2）**：
1. **维度统一为 convId**：计划 `PlanStore`（`plan-store.js`）`create/getActive/recent/formatForContext` 全接口加 `convId` 过滤；旧无 `convId` 数据首次访问归并当前会话不丢。
2. **文件改动按会话快照**（`agent-llm.js`）：`convChanges[convId]` 存该会话完成任务时的 `git.changes()` 快照；`_snapshotCurrent` / `_persistConversations` / `flushConversations` 序列化带 `changes`，`_loadConversations` 恢复，`dropConversation` 清理。
3. **实时终端按会话缓冲**（`app.js`）：`termBuffers[convId]` 缓冲终端日志；`termLine/termPrompt` 改写写入对应缓冲；切换会话仅切换显示内容（共享同一个 OS shell）。
4. **前后端联动**（`index.js`）：`GET /api/plans` 支持 `?convId`；`POST /api/plans` 补 `convId: engine._currentConv`；`switchConv` 推送该会话 changes；`reset/newchat` 仅清空当前会话 changes（不回退文件）。

**关键约束 —— 不物理回退**：
- 切换会话 / 清空会话记录：**只切换"显示哪份改动快照/终端日志"，绝不执行 `git checkout` / `git reset`**。
- 唯一会物理回退的是「还原工作区」按钮（`reset` → `git.discardAll`，`git.js:92` 的 `checkout -- .` + `clean -fd`），且带二次确认弹窗（C7-7）。
- 因此多会话并排时，每份会话看到的是自己当次的改动清单，互不影响工作区真实文件。

---

## 优先级总览与路线图

| 优先级 | 项 | 方向 | 价值 |
| --- | --- | --- | --- |
| **P0** | A1 认证重构 | 安全 | 修复"装饰性账号" |
| **P0** | A2 收紧白名单 | 安全 | 防本机滥用 |
| **P0** | A3 全局兜底+优雅关闭 | 稳定 | 防进程被杀/孤儿 |
| **P0** | A4 内存治理 | 稳定 | 防长跑泄漏 |
| **P0** | B1 z-index 系统 | 体验 | 根治遮挡 bug |
| **P0** | C1 闭环提速 | 体感 | 核心价值 |
| **P0** | C2 错误恢复 | 体感 | 可信任 |
| **P1** | A5 并发安全 | 稳定 | 防丢更新 |
| **P1** | A6 命令安全升级 | 安全 | 防失控 |
| **P1** | A7 同步阻塞+残留 | 稳定 | 卡顿/垃圾 |
| **P1** | B2 状态集中化 | 体验 | 可维护 |
| **P1** | B4 浅色审计 | 体验 | 完整性 |
| **P1** | C3 命令面板 | 体感 | 效率 |
| **P1** | C4 首次引导 | 体感 | 上手 |
| **P1** | C5 进化反哺 | 体感 | 闭环 |
| **P2** | A8 CORS+校验 | 安全 | 规范 |
| **P2** | B3 模块化 | 体验 | 可维护 |
| **P2** | B5 加载/动效/a11y | 体验 | 质感 |
| **P2** | C6 会话持久化 | 体感 | 连续性 |

### 建议节奏
- **第一阶段（地基）**：A1+A2+A3+A4+B1+C2 —— 修安全与稳定命门，1~2 天。
- **第二阶段（闭环）**：C1+C5+B2 —— 让价值闭环提速且进化真实生效。
- **第三阶段（打磨）**：A5~A8+B3~B5+C3+C4+C6 —— 体验质感与可维护性。

---

## 完成状态

全部 19 项已落地：

| 阶段 | 条目 | 状态 |
|---|---|---|
| 第一阶段（地基） | A1 登录闸门 / A2 路径穿越 / A3 全局兜底 / A4 内存治理 / B1 首屏 / C2 引导 | ✅ |
| 第二阶段（闭环） | C1 闭环提速 / C5 进化反哺 Agent / B2 状态集中化 | ✅ |
| 第三阶段（打磨） | A5 并发安全 / A6 审计 / A7 限流 / A8 CORS+校验 / B4 视觉一致 / B5 加载动效 a11y / C3 命令面板 / C4 首次引导 | ✅ |
| 收尾（P2 补完） | **B3 app.js 模块化** / **C6 会话持久化** | ✅ |

### 增量增强（v2.3.x，在 19 项方案外追加）

| 提交 | 条目 | 内容 | 状态 |
|---|---|---|---|
| `9e8e22b` | **C7 聊天 UX 增强** | 历史 ↑/↓ 复用、消息快捷复制、`Ctrl/⌘+.` 切模式、上下文实时条、Skill 去"引用 N 次"、工作流图标修复、还原二次确认 | ✅ |
| `8282ca2` | **C8 会话级工作态隔离** | 计划/终端/文件改动按 convId 隔离显示、跨重启保留、**不物理回退** | ✅ |
