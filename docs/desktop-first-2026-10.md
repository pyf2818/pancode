# 桌面优先：单根切换 vs 多根授权，以及任务生命周期缺口（2026-10-04）

> 前提：产品定位改为**桌面通用 AI 助手**，IDE 降为其中一个模块。
> 本文只做两件事：① 把"文件访问根"这个决策的现状证据和改动面摊开；② 按新定位重排后续顺序。
> 所有行号是写作时实测的，改代码前请先复核。

## 0. 结论先行

1. **真正的障碍不是"少了一个目录参数"，是三件事叠在一起**：全局单例的 `FileStore`、
   同一个工作区存在**两种互不相同的分片键**、权限规则的 glob 匹配的是**裸参数文本**而不是解析后的绝对路径。
   直接给工具加 `path` 绝对路径，会让已有 allow/deny 规则**静默失效**（锚定 `^` 的 glob 不命中即放行/拦截判断改变）。
2. **建议走"会话级多根授权"，但分三阶段做**，第一阶段完全不碰 UI，只把"根"从全局单例变成数据。
   理由：`/api/fs/browse` 已经能列全盘符和任意目录（`server/index.js:649-673`），
   也就是说"选任意目录"这件事在界面上早就存在，缺的只是 Agent 侧的授权概念——
   多根不是新增风险面，而是**把已有的事实显式化**。
3. **必须一起补的一处安全缺口**：`safePath()` 是纯词法判定，全仓 `server/` 下 **0 处** `realpath`/`lstat`/`readlink`。
   工作区里一个指向 `C:\Users\<you>\.ssh` 的目录软链，`list()`（`files.js:135` 用 `fs.statSync`）会跟随并读出来。
   单根时这是低概率隐患；一旦鼓励用户"把常用目录都授权进来"，它就成了主路径。
4. **和"根"同等重要、且现在完全缺失的一条链路：派出去 → 离开 → 回来查 → 被通知。**
   这条链路目前有 5 个硬断点（§2），其中"关窗口即杀后端"和"同会话重复发消息被静默丢弃"会让
   桌面助手的用法直接失效。它应该排在多数 P2 项之前。

---

## 1. 文件访问根：现状证据

### 1.1 一个全局单例，切换即整体重建

```js
// server/index.js:80-81  模块级单变量
let WS_DIR, files, git, term, procs;
// server/index.js:169-177  mountWorkspace()：切根时全部替换
if (files) files.stopWatch();
if (procs) { try { procs.stopAll(); } catch (e) {} }
WS_DIR = abs;
files = new FileStore(WS_DIR, path.join(configMod.ROOT, ".pancode", "audit"));
git   = new GitLayer(WS_DIR, files);
term  = new TerminalLayer(WS_DIR, broadcast, ...);
procs = new ProcessLayer(WS_DIR, broadcast, ...);
buildEngine();
```

- 切换前置条件：**所有引擎 `running` 必须为假**（`index.js:597-598`），否则拒绝切换。
- 切换后 `broadcast(hello)` 把**所有连接窗口一起**迁到新根（`index.js:602`）——没有"这个窗口看 A 根、那个看 B 根"的概念。
- 多根数据结构（`allowedRoots`/`extraRoot`/`roots`）在 `server/**` 下 **0 处命中**。
- `code-index` 与 LSP 不跟着重建：索引按目录 md5 命中另一份磁盘缓存（`code-index.js:149-151`），LSP 是全局单实例（`index.js:1811`）。

### 1.2 同一个工作区有两种身份（历史数据已经因此丢过）

| 存储 | 键算法 | 证据 |
|---|---|---|
| automations / 下发给前端的 `wsId` | 自研 base36 字符哈希 `_wsIdHash(WS_DIR)` | `index.js:238`、`:94`、`:252` |
| memory / skills / plans / soul / progression / goals / workflows / **conversations** | `md5(path.resolve(config.ROOT, cfg.workspace))` | `agent-llm.js:927-929`、`config.js:370-395` |
| code-index | `md5(wsAbs)`（不 resolve ROOT） | `code-index.js:149-151` |

而且真源有两条链：`_wsIdHash` 吃**运行态绝对路径** `WS_DIR`，Agent/config 侧吃**配置值** `cfg.workspace`
再 `path.resolve(ROOT, …)`。

> **2026-10-04 实测更正**：上表按 `agent-llm.js` 的**兜底分支**归了类，而真跑起来走的是 `index.js:94-119`
> 注入的共享实例——memory / skills / plans / soul / progression / automations 全部用 **base36** 键，
> 只有 conversations / goals / code-index / orch-history 用 md5。所以分歧比这张表写的更大，
> 而且同一目录的两套名字**都在被写**。仓库 `.pancode/` 里当场能数到（当时配置的工作区是 `E:\...\ai-ppt-generator`）：
>
> | 目录 | base36 名 | md5 名 | 谁在用 |
> |---|---|---|---|
> | `memory/` | `fgkhkc.json` 6.3 KB（10-04 仍在写） | `c36f4041….json` 37 KB（09-09） | Agent 实例读前者，`config.memoryPath` 给后者 |
> | `soul/` | `fgkhkc.json` 669 B | `c36f4041….json` 8.9 KB | 两份灵魂并存，界面与模型看的不是同一份 |
> | `plans/` | `fgkhkc.json` | `c36f4041….json` | 同上 |
> | `progression/` | 无 | `c36f4041….json` | Agent 那份从没落过盘：`progressionStore` 只由 HTTP 侧惰性新建 |
>
> 即 §1.2 的"md5 这一系内部自洽"只对**未被注入时**的兜底路径成立。

而前端注释直接承认这个分歧造成过事故：

```js
// public/app.js:2211
if (ev.wsId) _wsId = ev.wsId;   // 稳定工作区 ID：消除刷新前后存储 key 不一致（聊天记录丢失根因）
```

**含义**：一个目录两套键不是"归属不统一"这么温和——它表现为**同一份资产有两个文件**，
UI 读写一份、Agent 读写另一份，谁都不报错。风险在两处：① 前端那句注释本身就是事故修复痕迹——
"相对/绝对"分歧曾经**真的丢过聊天记录**，说明"两条链一定同源"这个前提历史上被破坏过；
② 引入多根时"用哪个字符串当键"必须一次定死，否则同一目录在不同代码路径落到不同分片，
表现为"我的记忆时灵时不灵"——本项目最忌的静默失效。
**结论：统一键的优先级高于多根本身**，它是纯修复、可独立验收、完全不碰 UI。

### 1.3 两套同名 `.pancode`：只有一个根写进用户目录

写进**用户工作区**的只有两类资产：
- 规则：`rulePath()` 只认 `.pancode/rules/*.md`，用 `files.write()` 落盘（`index.js:1605-1609`、`:1669-1671`）
- 专家包：`new ExpertStore(path.join(WS_DIR, ".pancode", "experts"), homedir/.pancode/experts)`（`index.js:104`）

其余全部落在**数据根** `config.ROOT/.pancode/**`（memory、plans、conversations、agent-traces、audit、
`spill/<convId>`、artifacts、code-index、users/sessions）。spill 的注释明确写了为什么放数据根
（"运行残留不该出现在用户仓库里、更不该被 git 追踪"，`agent-llm.js:2456-2464`）。

**含义**：多根之后"这份资产属于哪个根"要重新定义。审计/trace/spill 现在**不含根归属**，
事后无法从路径反推是哪个目录产生的。

### 1.4 权限规则匹配裸参数文本（多根会让既有规则语义漂移）

```js
// server/agent-llm.js:1494-1501
_hookSubject(toolName, args) → run_command/start_process: args.command
                              write_file/delete_file: args.path   // 原样，无 resolve/绝对化
// :1483  LlmAgent._globToRe(p).test(subj)；不中时 :1485 退化为前缀匹配
// server/rules.js:49-61  globToRe：^…$ 锚定、** 跨 /、* 不跨 /
```

判定链（`agent-llm.js:1505-1535`）：deny → allow（`irreversible` 关掉这两道）→ 会话授权 → `isReadOnly` → `mode==="auto"` 放行。

**含义**：`deny: "src/**"` 这类既有条目只在模型恰好传相对路径时成立。允许绝对路径或第二根路径后，
锚定 glob 一律不命中 → **拒绝规则静默失效**。所以多根的前置条件是：subject 先规范化成"根标识 + 根内相对路径"，
再喂给规则引擎。

### 1.5 其余硬绑单根的地方

| 子系统 | 绑法 | 证据 |
|---|---|---|
| 文件沙箱 | 单一 `this.dir`，词法前缀判定 | `files.js:98-105` |
| 配额 | `MAX_FILES=500 / MAX_WATCH_DIRS=200` 按**单根**算 | `files.js:18-19` |
| Git | 要求 `rev-parse --show-toplevel === 工作区`，父目录仓库/子目录仓库直接判不可用 | `git.js:54-62` |
| 终端/进程 | `spawn(..., { cwd: this.dir })`，工具 schema **没有目录字段** | `terminal.js:132-138`、`processes.js:59`、`agent-llm.js:339-343`、`:635-638` |
| 命令约束 | 只有正则黑名单，无路径约束 | `security.js:13-41` |
| 规则读取 | `absRoot = this.files.dir` 单根枚举 | `agent-llm.js:1724-1733` |
| 仓库结构/索引 | `files.list()` 单根、`_repoCache` 单实例 | `repo-map.js:56-58`、`agent-llm.js:1134` |
| Electron | 96 行，仅拉后端+开一个窗口；**无 `dialog`/`Tray`/`Notification`/单实例锁**；关窗即 `app.quit()` | `electron/main.js:7`、`:28-31`、`:96` |

---

## 2. 任务生命周期：「派出去 → 离开 → 回来查 → 被通知」的 5 个断点

| # | 断在哪 | 证据 |
|---|---|---|
| 1 | **提交入口只有 websocket**：`chat` 与 `goal.set` 两处，没有脱离连接的提交方式；同一会话再来一条时 `handleChat` **静默 return**，既不排队也不报错 | `index.js:1856`、`:1887`；`agent-llm.js:2698` |
| 2 | **离开即失效**：goal 续跑是裸 `setTimeout(..., 800)` 挂在事件循环上，`_goalState`（轮次/停滞判定）纯内存不落盘；重启后 `_goal` 文本能恢复，但**没有任何调用点重新 kick** | `agent-llm.js:3086-3088`、`:3064-3065`、`:1430-1434`、`:953` |
| 3 | **关窗即终结**：`app.on("window-all-closed", () => app.quit())`，后端与 Agent 同进程（`main.js:28-31`） | `electron/main.js:96` |
| 4 | **回来查不到**：`broadcast` 只发给当时在线的 clients、无重连回放；`helloPayload` 不含进行中/已结束任务；没有任务记录表，只有会话 history 与 trace | `index.js:56-59`、`:240-256` |
| 5 | **通知这一环不存在**：最细粒度收尾事件是 `agent.done`；前端无 Web Notification / 标题闪烁 / favicon 角标；Electron 无 Tray/Notification；`goal.settled` 只有一句页内 toast | `agent-llm.js:3053`、`public/app.js:2473-2483`、`:2525-2528` |

已经存在但**没接完的半条通道**：`Scheduler` 能真后台跑（`setInterval` 30s tick → `runSubAgent`），
但① 跑的是 `runSubAgent` 而非 `handleChat`，② 绑在 anon 引擎上（`index.js:109`）不是登录用户实例，
③ `onFire` 从未赋值（`scheduler.js:159`），④ 产物只写进 `.pancode/automations/<id>/runs/<ts>.json`，
用户不主动打开自动化面板就永远看不到（`automations.js:135` 提示"稍后刷新历史查看结果"）。

**编排/子智能体也全是同步等待**：`orchestrator.js:88,132,165` `await Promise.all` / `await runSubAgent`，
无 DAG、无队列、无后台化。

---

## 3. 三条路线对比

| | A 单根 + 明确切换 | **B 会话级多根授权（建议）** | C 全盘授权 |
|---|---|---|---|
| 用户能做什么 | 只有"当前打开的那个目录"里的事；跨目录任务一律做不到 | "把这些文件夹授权给这个任务"，一次授权长期可用，按会话/全局分档 | 什么都能做 |
| 改动面 | 仅 UI 提示 + 现状已支持 | 先做 §4 阶段一（键统一 + subject 绝对化 + symlink），再给 `FileStore`/规则/索引/git 加 rootId | 去掉 `safePath` 判定即可 |
| 破坏的不变式 | 无 | 分片键（必须一次迁完）、allow/deny 语义 | 整个沙箱模型 |
| 权限爆炸半径 | 最小 | 中：每个根仍是独立沙箱，可逐根撤销 | 最大：一个坏文件内容 + 一次注入 = 全机 |
| 与"桌面助手"定位契合 | 差（本质仍是 IDE） | 好 | 看似最灵活，实则把安全边界推给模型判断 |
| 回滚难度 | — | 低（阶段一本身与多根无关，是纯修复） | **不可回滚**（用户数据可能已被动过） |

C 明确不建议：本项目的权限模型建立在"有一个可信边界"上（`safePath` 拒越界、规则按路径 deny、
`irreversible` 强制确认）。C 一旦成立，这三条同时失去意义，而我们**没有任何机制能替代它**。

---

## 4. 建议的落地顺序（三阶段，每阶段独立可验收）

### 阶段一：把"根"从全局单例变成数据（不碰 UI，不含多根）

1. **统一分片键**：一个函数、一处实现，其余全部改调它。注意 automations（base36）与
   memory/plans/conversations（md5）现在是**同一目录的两套文件名**，统一成一套需要一次
   只读探测 + 落盘迁移（保留旧文件不删，先双读单写），并把"同一目录只应有一个键"写成回归测试。
2. **subject 绝对化**：`_hookSubject` 把 `args.path` 解析成"根内相对路径"再喂规则引擎；
   allow/deny 匹配失败时**不再退化成前缀匹配**（`agent-llm.js:1485` 那条退化路径本身就是误放行来源）。
3. **symlink 解析**：`safePath` 加 `realpath` 归属校验；`list()` 不跟随指向根外的软链。
4. **配额按根算**：`MAX_FILES`/`MAX_WATCH_DIRS` 从全局常量改成每根预算。
   （落地时实测：这条在单根下已经天然成立，真问题是多根的**跨根合计**——已改挂阶段二，见 §4 落地记录 4′。）

这一步的验收口径与是否多根无关——它是"单根也要修"的正确性问题。

#### 阶段一落地记录（2026-10-04）

**1′ 统一分片键 —— 已落地**（`server/ws-key.js`，15 单测 + 17 项真实服务探针）

- 键算法只有一处：`md5(规范化绝对路径)`。规范化 = 绝对化 + 去尾分隔符 + Windows 忽略大小写，
  所以 `E:\P`、`e:\p\`、相对写法解析后是同一个目录 → 同一个键。POSIX 不折大小写（那是文件系统语义）。
- 调用点全部改调它：`config.js` 4 个分片路径、`index.js:buildEngine` 8 个 store、`agent-llm.js` 构造器
  （改为按**实际挂载根** `ctx.files.dir` 取键，不再按配置值二次解析）、`orchestrator.histPath`、`code-index`。
- 迁移规矩：**不删、不盖、不静默改内容**。canonical 缺席 → 把最新的 legacy 改名成 canonical（纯 move，
  用户看到的内容一字不变）；canonical 与 legacy 同时在 → 谁都不动，只记 drift；多份 legacy → 搬最新的，
  其余留在原地。改名失败（Windows 句柄锁）退回该 legacy 继续读写，挂载绝不因此失败。
  挂载日志会打出归并了哪些文件、还留着哪些老键名等人合并。
- 顺手收掉一个同源缺陷：`progressionStore` 以前只由 HTTP 侧惰性 `new`（用 config 路径），
  Agent 侧走注入实例，两边指向不同文件；现在与 `soulStore` 一样在 `buildEngine` 里指同一实例。
- **前端 `wsId` 故意不换**：它是浏览器 localStorage 的会话存储 key 后缀（`cw-conv-v1:<id>`），
  换算法等于让老用户的历史列表凭空消失。`ws-key.legacyStorageId()` 显式承担这个用途，与磁盘键再无关系。
- 防回归：单测扫 `server/**`，除 `ws-key.js` 外任何人再对路径做 `createHash("md5")` 或用 `*31+` 多项式哈希即红。

**附：验收链体检（改键时被这些"永远跑不到"的红灯挡着，一并修了）**

`npm test` 的链条是 `test:verify && smoke && fileops && integration && patch && lsp && code-index`，
`integration` 一旦红，后面三节**从来没跑过**。实测：

| 现象 | 真因 | 处理 |
|---|---|---|
| `test:integration` 报 `Cannot find module _verify_ws_chat.js` | 三个集成脚本在 d52ccb8 移进 `scripts/archive/`，runner 还指老路径 | runner 改指 `archive/` |
| `_verify_sediment` "记忆已写入并可读回" FAIL | `/api/sediment` 的 `memory` 早已是结构化条目数组，脚本还按拼接字符串判 | 断言按真实结构判 |
| `test:patch` 3 条 FAIL | `PatchEngine.apply()` W13 起返回 `{applied,conflicts}`，脚本还按数组取下标（内容断言其实全过） | 解构后再断言，`applied[0]` 为 undefined 反向确认过 |
| `test:lsp` `socket hang up` | ① `_mock_lsp.js` 也被归档了；② `auth.register/login` 自 A2 起是 async，脚本没 await → token undefined → 桥接层 `socket.destroy()` | await 两个调用；mock 移回 `scripts/` |
| `test:lsp` 更狠的一条 | 它不设 `PANCODE_DATA_DIR` 就 require auth，把 `lsp_test` 写进**开发者真实** `.pancode/users.json`，成功收尾还 `unlinkSync` 整个文件（账号全没；`users.json.bak` 就是痕迹） | 数据根指向临时目录，清理改为删临时目录 |
| `test:fileops` "等待事件超时" | 夹具复用：上一轮中断留下 `workspace/tmp/world.js`，`rename` 撞「目标已存在」只回 `op.error`，而脚本等的是 `fs.sync` | 开跑前清自己的临时目录；超时消息带上期间收到的 `op.error` |

`.pancode/users.json` 里现有 60 个 `_fileops_*` / `shot_*` / `w4ui_*` 探针账号——**所有 spawn 服务端的探针都在往真实数据根写**。
探针统一改走 `PANCODE_DATA_DIR` 沙箱是下一步该收的账（`_verify_*` 那批已经这么做了）。
> 这笔账在 **12′** 收了（共享夹具 + 启动护栏 + 链尾数据根指纹）。顺带把当时的清点数字更新一下：
> 到 12′ 实测 110 条账号里 107 条是探针留下的——中间又攒了 47 条，正是这条"待收的账"的复利。

**2′ subject 规范化 —— 已落地**（`apply_edit` 此前完全不受路径规则约束；allow 改为"本次触碰的全部路径都要被覆盖"）

**3′ symlink 越界 —— 已落地**（`safePath` 走 `realpath` 归属校验、`list()` 不跟随软链、`exists()` 对拒绝路径按不存在回答）

**4′ 配额按根算 —— 实测后判定：单根下是伪需求，改挂到阶段二**
原写法（"全局常量改成每根预算"）经实测不成立：`MAX_FILES`/`MAX_WATCH_DIRS` 虽然写在 `files.js` 模块顶层，
但计数用的是 `list()` 里的局部 `out` 和**实例自己的** `this.watchers`，所以每个 `FileStore` 实例天然独立配额——
两个临时目录各 520 个文件，实测各自 `list()=500 truncated=true`，`a.watchers !== b.watchers`。
真正会失控的是**跨根合计**：`snapshotFiles()` 把每个根的最多 500 个文件全文读进内存，
N 个根就是 N×500，单根时代碰不到、多根一开就是新的内存面。
所以这一条应在阶段二落地成"**全局总预算 + 每根份额**"（含 `snapshotFiles` 只发增量/按需拉全文），而不是现在动常量。

### 阶段二：会话级授权根

5. `FileStore` 接受 `rootId`，工具入参改成 `{ root, path }`（或允许绝对路径 + 根校验），schema 里让模型必须显式表态。
6. 规则 / repo_map / code-index / git 按根各一份实例；git 改用 discovered toplevel，允许"工作区是仓库子目录"。
7. 数据根的资产加 rootId 归属（audit / trace / spill / conversations 都要能回答"这行是哪个目录产生的"）。
8. 授权管理 UI：加根、逐根撤销、区分只读授权与可写授权。

### 阶段三：后台任务与通知（可与阶段一并行开工）

9. **任务表**：`taskId → { convId, roots, status, startedAt, lastEvent }` 落盘，`hello` 带上进行中/最近结束的任务。
10. **`handleChat` 不再静默丢弃**：同会话忙时排队并回执"已排队"，或明确拒绝并给原因。
11. **goal 续跑状态持久化** + 进程启动时恢复未收口的任务（现在是重启即停在最后一轮）。
12. **收尾事件 → 系统通知**：接 Electron `Notification` + `Tray` 角标；`window-all-closed` 不再 `app.quit()`，
    改为"最小化到托盘，后端继续跑"，并给一个显式的"退出并终止所有任务"。
13. 把 `Scheduler` 那条半通道接完：绑用户引擎、`onFire` 推流、结果进任务表并可通知。

#### 阶段三落地记录（2026-10-04）

**9′+10′ 任务表 + 忙时排队 —— 已落地**（`server/tasks.js`，15 单测 + 13 项真实服务探针）

- **任务表**：`<数据根>/.pancode/tasks/<工作区分片键>.json`，一行 = 一个（用户, 会话）的当前任务：
  `{ title, status, startedAt, endedAt, lastEventAt, turns, tools, queueLen, waitingFor }`。
  状态由内核事件流单向驱动（`user.msg`→running、`tool.pending`→waiting、`tool.end`→计数、
  `agent.done`→done、`agent.error`→failed），挂在 `ensureUserEngine` 的 `emit` 包装里，
  不新增上报通道、不碰 Agent 主循环；`try/catch` 兜住，任务表绝不反过来打坏主链路。
- **重启判定**：`TaskBoard` 加载时把仍标着 `running / waiting / queued` 的行改判 `interrupted` 并计数打日志。
  落盘只可能发生在进程活着时，所以那些行一定是上次退出留下的僵尸状态——**不假装还在跑**。
  已收口的行不动。封顶 30 行，裁剪只丢最旧的收口行，进行中一行都不许掉。
- **hello 带上 `tasks`**：按连接的 userKey 过滤（`helloPayload(eng, userKey)`），重连/刷新即可回看。
- **忙时不再静默丢弃**：旧代码是 `if (runningConvs.has(convId)) return;`——用户点了发送、消息凭空消失。
  现在进 per-conv 队列（上限 5，超出明确拒绝），回执两条：结构化事件 `chat.queued/dequeued/rejected`
  供以后做 UI，外加一条 `term.line`（复用现有终端面，不新造交互）。上一轮 `agent.done` 后 FIFO 放行，
  且**排队的用户消息优先于 Goal 自动续跑**。删会话会连带清掉它的队列。
- 排队放行走 `setTimeout(…, 0)`：必须在上一轮的收尾之外起跑，否则在同一轮 finally 里重入。
- 探针用本地假网关（带"慢"的回复拖 1.8s）造出"会话正忙"的真实窗口，逐项验：排队回执 → 放行原文 →
  分片文件名 = 工作区键 → 重连 hello 带表 → **杀进程后重启改判 interrupted**。
- 已知边界：`broadcast(ev)` 仍发给所有连接（多用户下同工作区会互相看到事件），这是阶段二之前就在的既有行为，
  任务表本身按 userKey 过滤，但事件流未过滤——做阶段二多用户隔离时要一并收。

**11′ goal 续跑状态持久化 + 启动时接续未收口任务 —— 已落地**（7 单测 + `_verify_tasks.js` 第 ⑥ 段 4 项）

- `_saveGoal` 现在连同**续跑进度**一起落盘：`{ goal, ts, states: { <convId>: { turns, stall, lastSig } } }`；
  `_loadGoal` 一并恢复。收口与清除都会把状态置空，所以重启后剩下的就是真被打断的。
- **刻意不自动续跑**：重启后擅自继续改盘/跑命令是用户没点头的事。改成"连上就说一句 + 显式 `goal.resume`"：
  连接建立后对每个未收口目标发 `goal.pending` + 一条终端提示（"跑到第 N 轮被进程退出打断，要不要继续？"），
  用户点「继续」才重新起跑，且提示词里带上已跑轮次，让它先核对前几轮成果、别重复劳动。
- 探针顺手挖出一个**早就存在的失忆 bug**：构造器里 `_goalPath` 先用**无用户后缀**的路径读了一遍目标，
  下一行才把路径换成 `<分片键>__<userKey>.json`。结果登录用户的目标**存进 A 文件、重启读 B 文件**——
  目标从来没被恢复成功过。现在把 `_loadGoal()` 挪到路径定型之后，第 ⑥ 段用"按用户在盘上摆好遗留状态"验住它。
  这条属于"读代码看着对、只有跨重启才暴露"的那类，正是本项目最忌的静默失效。

**12′+ 关窗续跑 / 托盘 / 系统通知 —— 已落地**（`electron/main.js` + `electron/task-watch.js`，11 单测 + 11 项真实 Electron 探针）

- **关窗 ≠ 退出**：`window-all-closed` 不再 `app.quit()`，后端继续跑；托盘驻留，点图标重开窗口。
  兜底：托盘创建失败（精简 Linux / 远程桌面）时退回"关窗即退出"，**绝不留下一个看不见又关不掉的后台进程**，
  并把退回原因打进主进程日志、由探针断言。
- **单实例锁**：`requestSingleInstanceLock()` + `second-instance` → 唤起已有窗口。
  没这把锁，托盘驻留后用户再点图标会在同端口再起一个后端（EADDRINUSE）或出现两份互看不见的工作状态。
- **系统通知**：主进程轮询 `GET /api/tasks`（有活 3s、没事 15s），`justSettled(prev,next)` 只在
  「进行中 → 收口」那一次弹气泡——每 3s 弹一次会把人淹死，而"上一轮没有记录"（别的窗口开的任务）不打扰。
  `app.setAppUserModelId` 是 Windows 通知能弹出来的前提，漏了它气泡会被系统直接丢弃。
- **退出必收口**：`server/index.js` 导出 `shutdown`；`before-quit` 触发它（中止各用户引擎、刷盘会话、
  杀终端/MCP 子进程）。托盘「退出 pancode（终止所有任务）」在仍有 N 个任务时先弹系统确认框，默认按钮是
  "继续等它跑完"。
- 顺带修掉一个会让任务表形同虚设的缺陷：**演示引擎（没配 API Key 的装机开箱就是它）的事件不带 convId**，
  任务表按会话归属直接空表。现在 `DemoAgent.handleChat(text, opts)` 自己带上，`observeTask` 另有
  `_currentConv` 兜底。
- 探针 `_verify_desktop.js` 真起一个 Electron（沙箱数据根 + 沙箱工作区 + 独立端口 8815 + 探针钩子
  `PANCODE_PROBE_CLOSE_MS` 到点自动关窗），实测：任务跑到一半 → 窗口关闭 → **进程仍存活、`/api/health`
  仍应答、`agent.done` 照样回来、任务表最终落 `done`**。没有 electron 时脚本 SKIP 而非假通过。
- **只有人眼能验收的两件事**：托盘图标长什么样、通知气泡实际弹不弹。请在桌面端 `npm run desktop` 亲眼确认一次。

**13′ 自动化调度接入任务表与通知 —— 已落地**（3 条 Scheduler 单测 + `_verify_tasks.js` 第 ⑦⑧⑨ 段 15 项）

- 那条半通道接完了：`Scheduler` 新增 `onStart`（紧随 `_running.add(id)` 触发），配合原有 `onFire`；
  绑定在 `buildEngine` 里——开跑 `taskBoard.begin("automation", "auto-<id>", "自动化：<名称>", "automation")`
  并广播一条 `term.line`，收口 `end(... "done" / "failed")` 再广播一条。过程事件仍走既有广播面，不新造 UI。
- **必须先有 running 那一面**：桌面端弹气泡靠的是"两次轮询之间状态翻了面"（有活时 3s 一轮）。
  若开跑与收口挤进同一次快照，通知就静默丢失。Scheduler 单测第一条就钉这个顺序（`onStart` 早于 `onFire`），
  第二条钉"引擎不可用也要先落 running 再标 failed"，第三条钉"回调抛错不能打断自动化本身"。
- 行 id 用 `"auto-" + 任务 id` 而不是时间戳：同一个自动化反复跑复用同一行，`onStart` 与 `onFire` 必然对得上，
  任务表也不会被几十条运行历史撑满（封顶 30 行是留给"最近的事"的）。
- 自动化行带 `origin: "automation"`，`snapshot(userKey)` 在本人行之外**始终带上所有 automation 行**——
  它是替**整个工作区**干活的（同编排历史一个性质），不该只对发起人可见；普通会话行仍按 userKey 过滤。
- ⑦⑧ 段实测：`POST /api/automations/:id/run` 点火 → 表里先 `running` 后 `done`、`GET /api/tasks`（托盘轮询那条通道）
  看得见、终端两条痕都在、换一个用户连上来 `hello.tasks` 仍带着它、而前一个用户的会话行没有串进来、运行历史照常落盘
  （任务表是"现在到哪了"，不替代历史）。
- **顺带把"调度器借用谁的引擎"钉成一条断言**，并且**与计划里"绑用户引擎"的写法相反**：调度器仍用 anon 引擎，
  不借任何登录用户的。原因是 `runSubAgent` 会临时把 `msgStart / tool` 句柄换成 no-op
  （本意是子智能体不吵主界面）。业务 WS 有登录闸门（`upgrade` 里无 token 直接 `socket.destroy()`），
  所以 anon 引擎平时没人当会话用，两者不同台、够不到用户正在流的那条会话。⑨ 段是这条的回归护栏，
  并做过**负控**：临时把调度器改成取"最后一个用户引擎"，用户这条会话的回答被整段吞掉
  （`msg.delta` 全文为空字符串），断言立刻变红；改回来变绿。
- 探针自身的坑：假网关原先取"最后一条 role=user 的消息"判定回复内容，实测那往往是引擎每轮追加的
  **运行态尾部快照**（`_runtimeContext`，role 也是 user），不是人说的话。改成按标记取最近一条带 `【回X】` 的
  用户消息，才把回复正确归到请求上。同批把 ⑥ 段的 `goal.pending` 等待改成"先看已收到的、再等"——
  它紧跟 hello 发出，只等未来的报文会偶发等不到（负控跑那次就红了这一条）。

---

#### 阶段二落地记录（2026-10-04）

**5′ 全局授权根清单：存储、判定与 API —— 已落地**（`server/root-grants.js`，14 单测 + 28 项真实服务探针）

- 文件 `<数据根>/.pancode/roots.json`，**全局一份、跨工作区共用**——这是用户拍板的那条粒度
  （类操作系统的权限面板），不是每会话各配一组。注意它落在**数据根**而不是工作区：
  两套同名 `.pancode/` 是本项目的老坑，清单管的是"这台机器上允许碰哪些目录"，天然不属于某个目录。
- 两个轴分开，不互相冒充：清单管**能不能进这个门**，`allow/deny` 工具规则管**进门之后能干什么**。
- 条目 id 就是 `ws-key` 的分片键，本模块不出现第二个哈希源（`p2-ws-key.test.js` 的扫描会自动覆盖新文件）。
  于是 `E:\P`、`e:\p\`、大小写混写、相对写法 → 规范化成同一条授权；探针④实测"换写法不长出第二条"。
- **目录边界包含**：授权 `E:\proj` 不顺带覆盖 `E:\proj-secret`（只在分隔符边界上算前缀）。
  父子目录都授权时取**最具体**的那条：子目录的只读约束赢过父目录的可写——否则"这个子项目别乱改"会被父目录盖掉。
- **撤销授权只删清单里那一行**，目录与其中文件一个都不碰（探针⑦专门读回被授权目录里的文件确认）。
  这条是"撤销权限"和"删除数据"最容易被顺手写成一个操作的地方。
- 目录不见了**标 `stale` 不静默摘除**（用户可能只是拔了外接盘）；目录还在但 `realpath` 变了**标 `moved`**
  （被删后重建、或软链改指别处——"当初授权的是哪个目录"已经不确定，得让人看见）。
- `mountWorkspace` 会 `ensure` 当前工作区进清单（`source:"workspace"`、首次可写），
  且**不覆盖用户改过的只读**——否则每次挂载都把用户的收紧抹平。
- 4 个端点：`GET /api/roots`（含 `activeId` 供前端单独标当前工作区）、`POST /api/roots`、
  `POST /api/roots/:id/writable`、`DELETE /api/roots/:id`。全部在登录闸门之后（探针②实测无 token 一律 401）——
  授权目录是敏感操作，不能匿名调。
- **当前状态说清楚**：这一步只有数据和判定，**还没有消费方**。#23 才把文件工具接到清单上，
  所以"只读授权"此刻只有数据含义、没有拦截含义。别把它当成已经拦住了。

**6′ 多根路径解析层 + 跨根读取 —— 已落地（只到"读"，写明确不开放）**
（`server/root-store.js`，19 单测 + 25 项真链路探针 `_verify_multiroot.js`）

- 新增一层集中回答三件事：**这个路径属于哪个已授权根**、**在该根内的相对路径是什么**、**该用哪个 FileStore 实例**。
  工具不再各自判越界。`root` 参数认三种写法：授权名、目录绝对路径、32 位分片键；不填 `root` 而直接写绝对路径也认
  （落在哪个根就归哪个根）。**不带 root 的相对路径 = 当前工作区，与单根时代逐字一致**——这条是回归底线，
  探针②与全套老探针一起守着。
- **拒绝时绝不回退**：没授权过的路径一律拒，回执里摊开可选项、要求由用户去加授权，并且明写
  "不要绕路改用别的目录、也不要在已授权目录里造一个同名文件硬凑"。探针③专门用两个根里的**同名文件**
  （`leak.txt`）验这一点：读未授权那份必须拒，且回执里绝不能出现当前根那份的内容——
  "越界读悄悄变成读另一个文件的同名内容"是这类改造最阴的错法。
- **撤销/降级即时生效**：每次解析都现查授权清单。测试先让那个 FileStore 实例进缓存（断言 `liveCount` 涨过），
  再撤销授权，下一次调用就够不着——证明拦截不是靠"实例刚好被回收"实现的。
- **这一版只开跨根读取（`read_file` / `list_files`），写入一律拒**，包括对可写的其他根。
  理由不是偷懒，是现在放开会不安全：`allow` 规则的主体是**根内相对路径**，当前根写下的 `src/**` 会顺带替另一个
  项目的 `src/**` 背书。所以探针⑤断言"回执说跨根写入还没开放"**且盘上确实没多出文件**；
  ④ 只读根写入的拒绝理由是"只读"（先命中授权位），⑤ 可写其他根的拒绝理由是"未开放"。
- **下一段的判据已经想清楚，写在这里免得重新推**（配合 #24 规则按根各一份）：给每个被触碰路径出两份形态
  —— `relForm`（根内相对，等于今天的主体）与 `absForm`（根限定的绝对路径；当前根时 `absForm === relForm`）。
  `deny` 命中任一份即拦（保护面只增不减），`allow` 必须命中 `absForm` 才算被授权（不许跨根背书）。
  单根时代两份相同 → 现有行为逐字不变，这是这条设计能安全落地的原因。
- 实例管理：活动根 **adopt** `index.js` 已经 `new` 出来的那个 FileStore（再造一个就有两份 `fs.watch`，
  外部改动会被推两遍）；额外根懒建 + LRU 封顶 6，被挤掉时 `stopWatch()`（它同时清自写表定时器）。
  **额外根不 startWatch、也不进 `snapshotFiles`**——阶段一 4′ 实测的"每个根最多 500 个文件全文进内存"
  这条内存面就是靠这里挡住，不是靠常量。
- 探针⑧是接线自检：`root` 参数真的出现在出网 schema 里、提示词里那句新规矩真的进了 system 正文。
  这类改动最常见的失效方式是"改了常量没接线"，所以断言取的是**实际出网的内容**，不是源码文本。
- 探针⑨：`delete_file` 是不可逆操作、必走人工确认，探针代替用户点头之后仍然删不掉别的根——
  即使用户批准，未接线的工具仍由 `safePath` 兜住。`apply_edit` 同理（原文一字未动）。
- 未做的部分（别误以为已完成）：~~跨根写入~~（**下一条 8′ 做掉了**）、`apply_edit`/`delete_file`/`search_code` 的 root 参数
  （`delete_file` 已在 8′ 接线，`apply_edit`/`search_code` 仍未接）、`run_command` 在额外根里执行（需要先定风险面）、
  ~~授权管理 UI（计划项 8）~~（**10′ 做掉了**）。
  规则按根各一份**已由下一条 7′ 做掉**，git/repo_map 的按根见 7′ 里"现状分三类"那节。

**7′ 规则按根各一份 + 已授权目录进提示词 —— 已落地**（9 单测 + `_verify_multiroot.js` 第 ⑩ 段 8 项）

- 计划项 6 拆开后其实分三类，各自现状不同，这里说清楚（**别把"能按根"当成"已按根"**）：
  - **code-index**：本来就走 `ws-key` 分片键，一个目录一个索引文件，阶段一统一键时顺手就对了。
    这次只是补了一条断言把事实钉住（`wsIndexFile(A) ≠ wsIndexFile(B)`，文件名就是分片键）。
  - **repo_map**：`buildRepoIndex(files)` 收的是 FileStore 实例，"能按根"成立；
    但**额外根的仓库结构没有注入**——每条消息都为邻居项目带一份结构太贵。要做应该跟着"这一轮真的在改它"走，
    留给 #25 之后一起定。
  - **规则**：这次做掉。`loadRulesParts` 内部改成遍历"规则层"，每层一个 FileStore；
    `git` 仍未按根（额外根各自的 GitLayer 与"工作区是仓库子目录"的 toplevel 发现是同一件事，见下）。
- **单根逐字不变**是这条的前置条件，不是附带好处：当前根永远排在层的第一位且不带前缀，
  所以只用一个根时装配结果与迁移前逐字节相同——测试直接把"迁移前的调用形状"（裸 `{files}`，
  `/api/rules` 预览用的就是这个）与新版结果做 JSON 全等比对。前缀缓存（P1-6）不会因为上了多根而整体作废。
- **注入时机是"碰过之后"**：`locate()` 在解析到非当前根时记一笔 `_sessionRoots`，
  **下一条消息**才带上那个根自己的规矩（本轮的 system 早就装配完了）。探针按这个事实断，不假装即时。
  反过来也断：只授权、没碰过的根，它的规则不会凭空进每条消息。
- 撤销授权或目录掉盘 → 那个根的规则立刻停装，并且会话集合里的残留自清（`storeById` 返回 null 时摘掉）。
  这一条是防"权限撤了但它的约定还在替模型做主"。
- 上限 `EXTRA_ROOTS_MAX = 3`（按最近使用取末尾几个），**超出必须说出来**：往 conditional 里推一条
  "另有 N 个授权目录的规则未注入"，并告诉模型自己去 `read_file` 那个目录的 `AGENTS.md` / `.pancode/rules/*.md`。
  静默少装是最难查的那种失灵。
- 同名的规则文件靠**前缀标签**区分（`另一个项目/AGENTS.md`），两条都在、内容不串；
  用户全局层（`~/.pancode/AGENTS.md`）只注入一次，不因为多装了一层就重复一遍。
- 顺手补了一块：`buildAugmentParts` 的 stable 桶里列出**已授权的其他目录**（名字 = 路径 + 读写档位）。
  不列出来，模型根本不知道自己够得着别的项目，这能力等于不存在；
  这一段只在授权清单真的变动时才变，留在 stable 里不拖累前缀缓存。
- **这一步是 #25 的前置**：跨根写入之前，必须保证"另一个项目的规矩"不会由当前项目的规矩替它做主。
  剩下的 #25 判据（deny 命中任一份形态、allow 只认根限定的绝对路径）已经写在 6′ 那节末尾。
- **一处已知失真，别当成 bug 顺手"修反"**：`/api/rules` 的生效预览是用裸 `{files}` 调 `loadRulesParts` 的
  （`server/index.js:1856`），它只反映**当前根**的规则，也就是一条新会话的默认状态。
  某个会话真的跨根碰过文件后，模型看到的规则会比面板多——面板此时并不失真（它没说谎），
  但"与 Agent 严格同源"这句注释已经不完整。要收口就得让预览知道是哪条会话（带 convId 取该会话的
  `_sessionRoots`），或者在面板上标明"仅当前工作区的规则"。已并入 #26（授权管理 UI）的范围一起定。
- git 那块仍未动，且它和计划项 6 里"允许工作区是仓库子目录"是同一件事：现在 `GitLayer` 只在
  `path.resolve(top) === path.resolve(this.dir)` 时启用（`server/git.js:62`），
  工作区是仓库子目录时 git 能力整体缺席。真按根开 git 还要处理 `--show-prefix` 的路径换算，单独排。

**8′ 跨根写入：allow 不跨根背书 —— 已落地**（16 单测 `test/root-permission.test.js` + `_verify_multiroot.js` 51 项真链路）

- 6′ 那节末尾预留的判据这次落地成**三份形态**（`_subjectForms`）：`rel`（参数原样的根内相对）、
  `abs`（根限定的绝对路径；**当前根时与 `rel` 逐字相同**，所以单根判定不变）、`shape`（归属到它自己那个根之后的相对形状）。
  分工刻意不对称：**deny 看全部三份**（保护面只增不减），**allow 只认 `abs`**。
  allow 不许看 `shape`/`rel` 的理由就是这一版要开的能力：规则写的是 `src/**` 这种相对形状，
  拿它放行就是"A 项目的 src 可以改"顺手替 B 项目的 src 做了主。
- **反向对照也做了**：allow 写成那个目录自己的绝对路径（`E:/proj/other/src/**`）确实能放行跨根写，
  而且**不反过来**放行当前项目自己的 `src/a.js`。只测"不背书"这一半，测试红了也说明不了判据在工作。
- 这轮实测到的一条**假阴性**，记下来免得下次重踩：把 allow 换成按 `rel` 判，探针和单测**全都不会红**——
  因为 `canonicalRulePath` 只抹盘符、不抹中间路径，绝对写法算出的 `rel` 是 `Users/.../other/src/a.js` 这种长串，
  裸 `src/**` 本来就命不中。真正会跨根背书的是 `shape` 那一份。所以负控制要挑 `shape` 来做，
  实测挑它：探针 5 项红、单测 4 项红。
- **顺手关掉一个 fail-open**（不是 speculation，实测可达）：`path` 写成 `"."` 或 `"/"` 时三份形态会被全部抹空，
  而 `[].every()` 恒为 `true` —— 只要配了任何 allow 规则，这次写入就直接判成"已被授权"、连问都不问。
  加了 `candidates.length` 守卫，补一条单测钉住（同一形状的空数组在 `_rawSubjectPaths` 之外没有第二处来源）。
- **跨根写/删不惊动前端**：编辑器和改动面板按"工作区相对路径"认文件，跨根同名会撞车（改 B 的 `src/a.js`
  却把 A 的 `src/a.js` 刷新一遍）。所以非活动根只发一条 `[跨根写入] 另一个项目:docs/new.txt → <绝对目录>` 终端痕，
  回执里明写"不在当前工作区，编辑器与改动面板不跟踪它"。探针⑤c 断的是**这一轮广播出去的事件流里没有**
  `file.changed`/`editor.open`/`editor.diff`，不是断文案。
- 检查点带上了自己的 FileStore（`_snapshotBefore(p, store)`）：`/undo` 撤销跨根改动时放回**它自己那个根**，
  当前工作区里不会冒出同名文件（探针⑨断言 `ACTIVE/victim.txt` 不存在）。同时纯跨根的撤销不再调 `pushChanges`——
  那个方法列的是当前工作区的 git 差异，白跑一遍全量 diff 还要读每个改动文件的全文。
- **不可逆不因跨根而免确认**（W14 那条在这里同样生效）：`delete_file` 跨根仍强制人工确认，
  探针⑨先代拒（盘上文件还在）后代批（确实删掉了、回执带目录名）。
  `apply_edit` 仍未接 root，所以它改不动别的根（原文一字未动）——这一条是断言"没接线也拦得住"，不是断言"已支持"。
- 提示词同步改了：明写只读授权不许写不许删、被拒不许绕路、**当前项目的 allow 规则不替其他项目背书**。
  探针⑧取的是**实际出网的 system 正文**，所以这几句是真装上了，不是只改了常量。
- 权限档位与多根的相互关系在这里定一次：`semi`/`ask` 下跨根写照常弹确认卡，卡上显示 `另一个项目:src/a.js`
  这种带根名的主体；`auto` 下靠 abs 判据（本项目规则默认不放行跨根，所以 auto 模式是"允许但按当前根规则问不到"）。
- 仍未做：`run_command` 在额外根里执行（命令的工作目录仍锚在当前根，这是刻意选择，风险面要单独定）、
  `apply_edit`/`search_code` 的 root 参数、~~授权管理 UI（#26）~~（**10′ 做掉了**）、
  ~~git 按根（#27）~~（**11′ 做掉了仓库发现那一半，per-root GitLayer 刻意不做，理由在 11′**）。

**9′ 跑验收链路时顺手抓出的四处失灵（都不属于 #25，但都是"桌面优先"会踩到的）**

把这轮的 `verify:all` 完整跑了一遍，链路里红的那几项经查全是**既有缺陷**、不是 #25 带进来的（客户端这轮没动过）。
逐个记下来，免得下次又当成 flaky 放过：

- **审计日志答不出"改了哪个项目"**：`.pancode/audit` 是**全根共用一份**，而 `FileStore._audit` 只写相对路径。
  跨根写一开，两个项目里的 `src/a.js` 在日志里长得一模一样。改成每行带 `| root=<目录>`；
  探针⑤与 1 条单测同时钉住"同名的两份写各归各家"。负控制：抹掉 `root=` 后探针 2 项红、单测 1 项红。
- **没配 API Key 的机器上看不到任何工作流模板**：`/api/templates` 取的是 `engine.workflows`，
  而那份 store **只在 `LlmAgent` 构造函数里挂**（`agent-llm.js:1007`）；演示引擎下它是 undefined →
  端点回空数组 → 前端工作流面板**静默退化**成快捷提示词列表。桌面端第一次启动就是这个状态。
  改成直接取工作区级的 `_engineAssets.workflow`。负控制很干净：改回 `engine.workflows` 后
  C4a–C4d 四项在演示引擎下全红（`实际 6 项 / 分组只有"快捷提示词"`）。
- **每次刷新都要重新登录**（这条最凶）：`app.js` 在脚本加载期的 IIFE 里就 `fetch("/api/orch/history")`，
  那一刻 `AUTH.token` 还是空串 → 全局 fetch 包装不加 Authorization → 服务端 401 `code:"NO_AUTH"` →
  而那个包装的 401 分支会**抹掉 `userAuth.token` + 清 localStorage** 并弹登录窗。
  修法两处：编排历史改到 `startApp()`（鉴权就绪后）拉；401 只有在这次请求**本来带了 token**时才当作会话过期。
- **Windows 短名路径让 git 能力整体静默消失**：`GitLayer` 用 `path.resolve(top) === path.resolve(dir)` 判仓库根，
  而 `git rev-parse --show-toplevel` 回长名（`C:\Users\anlan0725\…`），工作区写成 8.3 短名
  （`C:\Users\ANLAN0~1\…`，`os.tmpdir()` 给的就是这个）时两串永不相等 → `available=false` →
  diff 基线、改动面板、提交全退化成快照模式，而且没有任何提示。改为 `sameDir()`
  （realpath + 折大小写 + 去尾分隔符）。新增 `test/git-toplevel.test.js` 5 项，
  并**明确钉住**"工作区是仓库子目录时仍然不启用"——那是 #27 的边界，不许被这条修复顺手放宽。
- 探针卫生（这是本项目反复踩的坑，本轮又抓到一个）：`_verify_workflow_ui.js` 与 `verify-ui.js` 同进程拉服务端
  却**不设 `PANCODE_DATA_DIR`**，于是一边往开发者真实的 `users.json` 塞账号，一边按 TTL **删掉了真实对话**
  （本轮第一次运行实测：`已按 TTL 清理 1 个 30 天未活跃的对话`、并挂载了开发者上次打开的 `ai-ppt-generator`）。
  两个脚本现在都用沙箱数据根 + 沙箱工作区（带自己的 git 仓库，C10–C13 才有真实改动可断）。
  仍有 11 个 `_w*` / `verify-search.js` 这类一次性探针没沙箱化，列在这里备查。
- 命令面板曾有两份：`Ctrl+Shift+P` 同时绑在 `app.js` 的旧面板（`#cmdPalette`，`z-index:99999`，
  运行时 append 到 body）和 `js/cmdk.js` 的新面板上。一次按键叠出两个面板，后插的那份盖住前一份，
  Playwright 报的就是"`#cmdPalette` subtree intercepts pointer events"——但这是**真人也会遇到的遮挡**。
  旧面板独有的 8 条命令（新建文件夹 / 关闭标签 / 新建对话 / 五条 AI 命令）已并入 cmdk，旧面板与其 CSS 删除。

**10′ 授权目录管理 UI（阶段二-4）—— 已落地**（`_verify_roots_ui.js` 25 项真实浏览器断言）

- 落点是**「设置 · 权限与安全」的第一组**，不新开导航项：两个轴（能不能进门 / 进门后能干什么）
  属于同一块心智面板，拆成两节反而要用户自己去拼。所以「授权目录」排在「审批策略」**之前**，
  探针①断的就是这个顺序（写第一版时它异步填内容，结果整组掉到页面最后面——顺序只能靠"先占位再填"）。
- 一行 = 名字 + 路径 + 徽标（当前工作区 / 只读 / 不在盘上 / 已被移走）+ 读写开关 + 撤销。
  控件全部复用现有的 `.wb-switch` / `.wb-icon-btn` / `.wb-badge`，没有新造视觉层。
- **当前工作区不给撤销按钮**（`disabled` + title 说明）：撤了等于 Agent 什么都碰不到，
  而且下次挂载会被 `ensure` 原样加回来——给个能点的 X 只会让人以为"撤销成功了怎么还在"。
- **撤销走 confirm，且文案写死"只删这一行，不动目录和文件"**；探针⑤点完之后回读盘上：
  清单里那行没了，`other-project/b.js` 内容与存在性一字未动。
- 「添加目录」复用**同一个**目录浏览器（`/api/fs/browse`），但给它加了"挑一个目录交给调用方"的模式：
  标题与主按钮文案换成「授权此文件夹」。这条必须显式区分——用户点"添加授权目录"时如果顺手把工作区切了，
  就是数据事故。探针④两头都断：新目录进清单**且** `GET /api/workspace` 的 `current` 一字未变；
  负控制（把 pick 分支短路掉）实测就是红在"工作区被换成了 added-by-ui"。
- 顺手修掉这条链路上撞出来的两个真缺陷：
  1. **目录选择器在设置台里根本点不到**：`#folderModal` 是 `--z-modal:300`，设置台是 `--z-wb:410`，
     从设置里唤起时整块被压住，鼠标全落到底下（探针报 "workbench subtree intercepts pointer events"）。
     这不是新代码独有的——「通用 · 切换工作区」早就踩在同一个坑里。加了 `--z-picker:470` 专给这一类子层。
  2. **浏览器会把用户正在输入的路径抹掉**：`fmBrowse` 无条件把响应写回 `#fmPath`，
     而打开弹窗时那发"列根目录"的请求往往比人慢一步回来 → 输入框被清空、主按钮退回禁用。
     现在按序号丢弃过期响应，且输入框有焦点且有内容时不覆盖。
- 布局探针（`_verify_layout.js`）第一次跑就红在我这一组：长路径 `scrollWidth 432 > clientWidth 399`。
  修法不是把容器加宽（Windows 长路径永远塞不下），而是 `min-width:0` 让 flex 子项真的可缩 +
  给名字与路径补 `title`，并**把探针的判据讲清楚**：`overflow:hidden + text-overflow:ellipsis + title 带全量`
  属于"截了还能看全"，不算缺陷；没有 title 的截断照旧报（负控制实测：去掉 title 立刻回红）。
- 规则「生效预览」那句"这就是模型本轮真正读到的规则块"在多根之后不再完整——预览是用裸 `{files}`
  （只有当前根）调装配函数的。这一版按 7′ 记的方案收口：**把话说全**，明写"这里只装当前工作区的规则，
  会话真读过别的授权目录之后模型看到的会更多，能进哪几扇门去「权限与安全 · 授权目录」看"。
  没有偷偷把预览做成会话感知（那需要 `/api/rules` 带 convId 去取引擎的 `_sessionRoots`），
  那是后续可选项，不是这一节的正确性前提。
- 探针⑦断"全程没有 4xx 与 JS 报错"：授权清单四个端点都在登录闸门后，匿名访问必须 401（准备段单独验）。
- 仍未做：`run_command` 在额外根里执行、`apply_edit`/`search_code` 的 root 参数、~~git 按根（#27）~~（**11′**）。

**11′ git 用 discovered toplevel + 仓库结构按根各一份（阶段二-3b）—— 已落地**（15 单测 + 探针 ⑩ 三条 + workflow-ui 25 项）

- **工作区是仓库子目录时 git 能力不再整体缺席**：判据从"工作区 == 仓库根"放宽到"工作区落在某个仓库里"，
  monorepo 里只打开 `web/app` 也能看改动、取基线、选择性提交。启动日志与提交弹窗都要标 scope
  （`Git: 已启用（基线 = HEAD，工作区在仓库的 ws/ 子目录）`、`分支：master · 无远端 · 只含 ws/ 子目录`），
  否则用户看到的是"变化比仓库少"，只会以为工具漏了文件。
- **两个坐标系，实测出来的，别凭直觉写**：
  - `-- <pathspec>` 那类（`diff` / `add` / `checkout`）**相对当前工作目录**，而所有子进程都以工作区为 cwd
    → 必须原样传工作区相对路径。加了前缀就变成 `web/app/web/app/main.js`：`diff` 直接空、`add` 报 pathspec 不匹配。
  - `git show HEAD:<path>` 这类 **revspec 相对仓库根** → 必须加前缀，否则会取到仓库根那个同名文件（"同名巧合"）。
  - `status --porcelain -uall -- .` 从子目录跑只列本子目录，但输出仍是仓库根相对 → 出口统一剥前缀。
  - `--relative` 在 porcelain 模式下**输出空**，不能用（试过一次才知道）。
  - `add -A -- .` / `checkout -- .` / `clean -fd` 从子目录天然只作用于本子目录（实测过：仓库别处的未跟踪文件没被删）。
- **两条一票否决，都是实测踩出来的，不是假想**：
  1. 仓库根就是**用户主目录**（这台机器 `~/.git` 真的存在，还一次提交都没有）。认了它，
     主目录下每个普通文件夹都会被判成"仓库子目录"，一次 `git_commit` 就把文件提交进家目录仓库。
  2. 祖先仓库把本工作区**整个 ignore 掉**（pancode 自己的 `.gitignore` 就写着 `workspace/`）。
     这时 `git status` 永远列不出这里的任何改动 —— 认了它等于把改动面板/基线/提交换成**静默空集**，
     而快照模式本来什么都对。这条是落地当场把 `smoke` 与 `test:fileops` 两个夹具弄红才发现的
     （"改动文件数 0 < 1"），所以判据不是理论洁癖，是有回归网兜着的。
- 顺手修了一个一直存在的漏判：`GitLayer#diff(path)` 的参数名把模块级 `path` 遮掉了，
  于是 `git diff <某个文件>` 每次都在 `path.isAbsolute(...)` 上抛 "not a function"，
  再被 `catch` 吞成一句看不懂的"git 错误"。改名即修，补一条单测钉住（含"绝对路径仍被拒"的老语义）。
- **仓库结构（repo_map）按根各一份**：7′ 留的那个决定这次收了——只装**本会话真碰过**的根，
  复用规则那批层（`_ruleLayers()`）与 `EXTRA_ROOTS_MAX` 截断，没碰过的邻居项目不占每条消息；
  撤销授权后立刻停装（探针⑩三条：只装当前根一份 / 碰过之后带上 `【仓库结构 · 备忘（只看）/】` / 撤销后停装）。
- **一条探针伪影值得记**：一轮对话会发好几次请求（摘要 / 工具轮 / 收尾），而一次请求的 system 又是**好几条消息**。
  按消息收集再取"第一条"或"最长的一条"都会数错注入块（数出来永远是 0）。
  现在按请求聚合、并取最长那份（完整装配）来数，`_verify_multiroot.js` 的 `res.one` 就是这个意思。
- **任务标题里"按根各一份"的另一半——per-root `GitLayer`——刻意不做**，理由写在这里免得下次又当成漏项：
  今天没有任何消费方。改动面板与提交弹窗按 #25 的决定**只跟当前工作区**（跨根文件走终端痕），
  `git_commit`/`git_status` 也还没有 `root` 参数。没有消费方就先去建"每个授权根一个 GitLayer"的缓存，
  等于造一段没人调用的代码，还要顺带背住 N 份 `fs` 子进程与 watcher 的开销。
  真要跨根 git（例如"把刚才在 B 项目里的改动单独提交"）应当连着 `git_*` 的 root 参数一起做，那时才有落点。
- 验收：`vitest` 29 文件 / 583 通过（git 单测 15 项，含两条否决与两个坐标系的负控制）、
  `test:verify` 18 个探针全绿（`_verify_multiroot.js` 56 项）、`verify:ui`、
  `verify:workflow-ui` 25 项（夹具已改成"仓库根在上一层"的形态）、smoke/fileops/integration/patch/lsp/code-index/summary/desktop 全 OK。

**12′ 探针沙箱收口（#28）—— 已落地**（`scripts/_sandbox.js` + `server/config.js` 护栏 + `_verify_dataroot.js` 指纹 + 14 项守卫）

前面每一轮都在"给某个探针补沙箱"，这一轮把这件事从**逐个脚本的记忆**变成**结构**：

- 先量化伤害，再动手。用只读指纹（size+mtime）逐个跑了一遍，实测在真实 `.pancode` 上留痕的：
  `fileops-test` 3 处（users.json / sessions.json / 当日 audit）、`integration-runner` 5 处
  （再多带 tasks 与 memory 分片）、`test-code-index` 落 1 个索引分片、`_verify_tools` 改 2 处
  （artifacts + memory）；`_verify_render / repo_map / agentflow / ctxpair / parallel / promptctx / choice` 是 0 处（全 mock 了）。
  `verify-git-async` 不碰数据根，但把临时 git 仓库造在**仓库根**，异常路径不回收——现场留着两个空壳 `w12-snap-*`。
- `scripts/_sandbox.js`：一份夹具管两种形态（同进程 require 型 / spawn 子进程型），`create()` 立即改
  `PANCODE_DATA_DIR`（+ 默认 `CURSORWEB_WORKSPACE`），`env(…)` 给 spawn，退出时尽力删；
  `ws:false` 留给"工作区必须是真实目录"的探针（语义检索就是这种）。
  **它自带两条运行时判据**，不是文档式约定：require 顺序错了就抛（`config/dotenv/index/code-index` 都在模块加载时固化 ROOT，
  晚设等于没设），一个进程 create 第二次也抛。
- 服务端护栏（`server/config.js`）：带 `AGENT_FAST=1` 或 `CURSORWEB_ENGINE=demo` 却没数据根 → **拒启**。
  这两个标记产品路径一个都不设（grep 全仓实测），归档的 W 轮老探针又不带标记，所以护栏只咬"现役写法"的探针，
  开发态与打包态不受影响（四条反向断言钉着）。
- 光靠静态扫脚本会被"绕开服务端"的那类骗过去——`_verify_tools` 就是拿 `mockConfig.ROOT = 仓库根` 写花的，
  脚本里根本没有 `server/index.js` 字样。所以补了 `scripts/_verify_dataroot.js`：`test:verify` 链首 `mark`、链尾 `check`，
  真实数据根动一个文件就红在链尾。**实测数字：修完之后整串跑完 = 128 个文件、指纹一字未动**（修之前是每轮 3–5 处）。
- `verify-search` 原来把**工作区**也指到仓库的 `server/`（引擎有权往真实源码里写）。改成"把 `server/` 拷进沙箱当工作区"：
  BM25 命中的还是同一批真实源码（3351 片段 / 12 条结果不变），但引擎再也够不着工作树。
- W 轮一次性探针（11 个 `.js`）移到 `scripts/archive/legacy-w/` 并留 README 说明。
  **刻意没有逐个给它们补沙箱**：它们测的是十轮之前的代码形态，今天大概率跑不通；
   blind 改完既验不了"我修好了"也分不清"本来就是坏的"。它们一条 npm 链都不引用，移出顶层后连守卫扫描也不覆盖——
  归档目录里放的是"历史证据"，不是"待跑的测试"。
- 顺手证伪一条老注释：`verify-git-async` 写着"os.tmpdir() 对 git spawn 会 EBUSY"，
  实际把临时仓库放临时目录建、`git init/add/commit` 全过（21 项断言绿），`test/git-toplevel.test.js` 本来就是这么跑的。
  旧断言删掉，别再拿它当"必须在盘内造垃圾"的理由。**它此前还不挂在任何 npm 脚本上**（没人跑 = 注释才敢烂两个月），
  现在补进 `test:verify` 第 4 位，从此也被链尾指纹盯着。
- **仍然没做的部分（同样写在这里免得被当成漏项）**：`_verify_tasks / auth / desktop / layout / longtask / workbench / assets / wskey / roots`
  这 9 个探针用的是 `scripts/_verify_out/<name>-sandbox` 这种**固定路径**沙箱——数据根是隔离的（链尾指纹证明了），
  但代价是上一轮的状态会带到这一轮（`fileops-test` 当年就栽在残留 `tmp/world.js` 上），而且这个目录已经堆到 65MB。
  改成走 `_sandbox` 是纯收益，但要动 9 个现役全绿的探针，本轮没做；下次谁再被"复用的沙箱状态"坑一次，就顺手收一个。
- 待你拍板的残留（本轮只测量，没删）：真实 `users.json` 110 条里**107 条是探针账号**（`_fileops_*` / `verify_*` / `w4ui_*` …，
  只有 `安安` 明显是真人），`.pancode/code-index` 24 个分片里 **21 个的 `meta.ws` 指向临时目录**（`pc_idx_*` / `pc-inc-*`）。
  这两样都是删了就不回来的用户数据根内容，`users.json.bak` 一律没碰。
- 验收：`vitest` 30 文件 / **597 通过 | 1 跳过**（新增 `test/probe-sandbox.test.js` 14 项，三条负控制分别把
  "探针不要沙箱 / 夹具不拦顺序 / 护栏关掉" 各打红一遍后复原）、`test:verify` 19 探针（含新挂进来的 git 异步）+ 链尾指纹 0 变动、
  `smoke` / `test:fileops` / `test:integration` / `test:patch` / `test:lsp` / `test:code-index` / `test:summary` /
  `verify:ui` / `verify:workflow-ui` 25 项 / `_verify_desktop.js` 11 项 / `verify:search` / `verify:git-async` 21 项全绿。

**13′ 事件广播按用户隔离（阶段三-1 那条残留边界收口）—— 已落地**（`server/event-scope.js` 7 单测 + `_verify_eventscope.js` 17 项真链路）

`broadcast(ev)` 原来无差别发给所有连接。桌面端"一台机开多个窗口 / 多个账号"是常规形态，于是：
A 的逐字回答出现在 B 的屏幕上、A 的审批卡弹在 B 那里、A 点「新对话」把 B 正在流的那条回答的 UI 状态清掉
（`agent.reset` 会重置 `state.round / answerBlock / thinkCount`）。

- **规则只做一条**（`server/event-scope.js`）：调用点给 `userKey` 就只发那个用户的连接，不给或是 `anon` 就广播。
  刻意不建"事件类型白名单表"——那张表每次加工具都要改，而且漏一条就是静默串人。
- **`anon` 必须继续广播**：后台自动化跑在 anon 引擎上（`engine = ensureUserEngine("anon")`），
  它不属于任何登录用户；一并隔离掉，定时任务的进度就从用户窗口里消失了。探针⑥专门钉这条。
- **身份用 `userKey`（token 的 8 位哈希）而不是用户名**：`userEngines` 本来就按它分会话，
  "某引擎的事件发给持有该引擎的连接"是自洽的；换成用户名会让同一个人的两个窗口互相插入对方引擎的流。
- 仍保持全局的：`fs.sync` / `file.saved`（工作区是实例级共享，别的窗口该跟着刷新）、`engine.info` /
  `agent.settings`（配置是全实例的）、`system.perf`、`mcp.servers`、切换工作区后的 `hello`、兜底 `op.error`。
- **诚实记录一件事**：B 拿 A 的审批 id 点头**本来就动不了** A 那张卡（`resolveApproval` 打在各自引擎上），
  探针④钉的是这个既有行为；这次真正修掉的是"卡片显示在别人屏幕上"这一层。别把它写成"别人能替你批准删文件"。
- **两条实测教训（都是负控制抓出来的）**：
  1. **否定断言必须先打水印**。"B 没收到"这种断言，在消息还在路上时会读成通过——
     退回无差别广播跑第一版探针竟然全绿就是证据。现在每条否定断言前先 `watermark(conn)`：
     等对方连接收到一条**必定会发**的实例级事件（`system.perf` 每秒一条）且是本轮新到的；
     TCP 单连接内有序，收到更晚的那条就证明之前排队的都已送达。加水印后两处负控制才都变红。
  2. **`agentMode:"ask"` 不是"逐次确认"**，那是"只问不干活"的档位，工具直接被拦成
     「Ask 模式禁止工具调用」，根本走不到审批；要弹确认卡靠的是 `permissions.mode:"ask"`。
     配置探针时两者写反会得到"A 也没弹卡、B 也没弹卡"的假绿。
- 相邻缺陷记在这里没动（不属于这一条）：`POST /api/plans`、`/api/plans/:id/complete` 用的是全局 `engine`
  （anon），绕开了按用户的引擎——所以这两个端点的事件只能保持广播。真要按人隔离计划，得先把它们接到
  `ensureUserEngine(reqUserKey)` 上，那是另一件事。
- 验收：`vitest` 31 文件 / **604 通过 | 1 跳过**、`test:verify` 20 探针 + 链尾数据根指纹 0 变动、
  smoke / fileops / integration / patch 19 / lsp 2 / code-index 4 / summary 43 / `verify:ui` /
  `verify:workflow-ui` 25 / `_verify_desktop.js` 11 / `verify-git-async` 21 全绿。

**14′ 界面与统计口径收口（用户 2026-10-05 提的 7 条里的 3/4/5/6）—— 已落地**（`_verify_uitaste.js` 真渲染探针 38 项 + `test/css-tokens.test.js` 5 项）

三条是同一类病：**CSS 与统计口径写错了但不会报错**，所以只能靠机扫和真渲染验收。

- **⑤ 顶部项目切换下拉是透明的**：根因不是配色，`.ws-dropdown` / `#filePalette` / `#inlineEditBox`
  读的是 `var(--bg-elev)`，而这个 token 全仓库从来没定义过。CSS 遇到未定义 var() 会**静默丢掉整条声明**
  ——不报错、不降级、DevTools 里也不显眼。同批机扫出 6 个名字 20 处：`--sans`（真名 `--ui`）、
  `--error`（真名 `--err`）、`--bg-hover`（真名 `--hover`）都是拼写分叉，一直在静默失效
  （认证页丢 sans 字体、停止按钮 hover 不红、悬浮态没底色）。修法：拼错的改回真名，
  确实缺的语义面（`--bg-elev` / `--bg-bar` / `--accent-grad`）补进派生层，
  `z-index:99999` 收成 `--z-float:480`。防复发：`test/css-tokens.test.js` 机扫自有资产里所有
  `var(--x)`，未定义即红，并带一条"临时插一个假 token 必须被抓到"的反向自证。
- **③ 水位只给百分比**：环形进度以前写的是裸数字（`"42"`，单位 `%` 从来没拼上去）；
  悬停提示写 `上下文 96,000 / 102,400 tokens`；环境面板写 `94% · 94k/102k`；压缩卡写 `94k→23k` 加
  「丢弃 12 条 / 保留 5 条」。现在四处统一成百分比，压缩卡改显「水位 94% → 23%、腾出 71% 空间」。
- **④ 输入框能量边框**：`conic-gradient` + mask 挖空中心只留 1px 一圈，`--pc-spin` 必须走
  `@property` 注册才能被动画插值（不注册的话整条 animation 静默失效——和上面那条未定义 var() 是
  同一类"错了也不告诉你"）。三态：空闲不可见 / 聚焦 .55 且 5.5s / 运行时 .95 且 2.6s，
  与 `setRunning` 联动，`prefers-reduced-motion` 下停转。
- **⑥ 会话头图标**：去掉渐变底 + 白 P 的方块（与标题栏品牌图形重复，且浅色档整块发白），
  换成两条交叉轨道 + 核心 + 信号点的纯描边标记，全部 `currentColor` 跟配色；
  跑任务时轨道转、核心与信号点交替呼吸。
- **探针抓出来的两个自写缺陷**（读代码都看不出）：`.focused::after` 的 opacity 是 transition 过来的，
  同步读 computed style 只会读到过渡起点 0；`addInitScript` 会在每个 frame 跑一遍，
  应用里的沙箱 iframe 读 localStorage 直接抛 SecurityError，被误记成产品报错。
- 桌面端顺带收口：`.traffic` 三个点在浏览器里 `display:none`（假按钮别诱导人点），
  只有 preload 递进 `window.pancodeWin` 才显形并接上 close / minimize / toggleMax。

**15′ 长期记忆改成按质量选（#31）—— 已落地**（记忆相关 4 个测试文件合计 38 项，含 `test/w3-memory.test.js` 按新口径重写 3 项）

用户看到的是"读进来的长期记忆没啥意义价值"。实测下来内容其实像句经验，**垃圾的是主题命名与选条口径**：

- 写入端 `taskTopic = text.slice(0, 60)` 把用户原话直接当主题落盘，溯源卡显示的就是这一栏
  （"启动项目""项目有没有问题""继续"满屏都是这么来的），还绕过了 `_resolveMentions` 的 `clean`。
- 触发门槛只有 `history.length >= 2`：**"继续"两个字也算一次任务**，照样起一次 LLM 抽取，
  一次产出 3~5 条同主题条目（去重要求 topic 相等才生效，内容不同就全放行）。
- 读取端 `topForContext(10)` 根本不看本轮问什么，只按遗忘曲线强度凑满 10 条，同主题三条一起霸榜。
- `accessCount` 是**注入即 +1** 的自举回路（注入 → touch → 强度更高 → 更容易进榜 → 再 touch），
  而 `valueScore ≥ 4` 又等于 sticky 免检（`prune()` 直接 continue）——自动沉淀恰恰一律给 4 分，
  所以这批垃圾既涨得最快又永不衰减。面板上点「立即整理」对它们完全无效，这是实测出来的。

改法（四处同时收，缺一处都会漏）：
- 主题：抽取器自己产出 ≤12 字名词短语（`[type] 主题｜正文`），解析容错旧格式；
  用户原话只作回落且必须过 `isJunkPhrase` 与 10 字地板；`_topicFromUserText` 取不到就返回空串。
- 门槛：正文 ≥20 字、问句/指令短句黑名单、一次任务最多沉淀 2 条、同主题最多 1 条；
  触发条件改成"改过盘或真的跑过工具轮次"；`save_session_memory` 与自动沉淀共用同一把尺子。
- 价值分：自动产出一律 **3 分**（不再一次性免检），`add()` 的重复路径取 max，
  被第二次确认时才升到 4——把"sticky"变回挣来的待遇而不是默认赠送。
- 读取端分两条道：**常驻道**（偏好/禁忌 + 归纳产物，与本轮无关，进 stable 保持前缀缓存字节稳定）、
  **相关道**（lesson/pattern/decision/error，必须与本轮原话有词元交集，进 turn）。
  强度地板 1 → 1.5，同主题每轮最多 2 条，总上限仍 10 条。
- 回路：注入只记台账不加分，**最终回复里词元重合 ≥3 才算用上**；空回复/中断一条都不加；
  用户级记忆此前永远不会被 touch（只 touch 项目库）也一并修掉，`touchMany` 合成一次落盘。
- 存量：`scripts/_verify_memclean.js` 默认只报告，`--apply` 先备份再降级（不删原文）。
  实测真实数据根 8 个分片里命中 55 条（28 条"主题是用户原话"+ 8 条"自动沉淀拿免检分"+ 19 条同类）。
- 面板文案与徽章同步改口径（`常驻` / `按相关性`），否则界面在替旧规则撒谎。

**16′ token 统计口径（#32：问两个问题就 200k）—— 已落地**（`test/p3-token-accounting.test.js` 9 项，含一条「反向对照」：旧写法会把已测过的整包当成压缩后的占用）

结论：**200k 那个数是真的，但它被放在了"窗口占用"的位置上读**。它是计费累计
（每一轮工具调用都要把 system 前缀 + 全量历史重发一遍，两个问题跑十几轮，累计破 20 万很正常），
而窗口分母只有 10 万量级。同时查出三处真缺陷：

- **分子重复累加**：实测锚点 `_lastPromptLen` 记在 `this.history` 上，而任务跑的是 `handleChat`
  里的局部 `history`——压缩/截断换了引用后两者分家，`slice` 起点错位会把已经数过的消息再估一遍。
  现在锚点记下依附的数组对象，换引用即过期，退回「实测时量出的固定前缀 `_ctxPrefix` + 当前历史估算」：
  既不翻倍也不凭空归零（旧代码归零后进度条突然见底、下一轮真值回来又跳上去）。
- **分母有三个数打架**：模型窗口 128000 / `ctx.query` 自己乘 0.9 得 115200 / 真正触发压缩的线 102400。
  统一走 `_ctxLimit() = _compactSpec().thresholdTokens`，进度条到 100% 就是真的踩线了。
- **microcompact 就地改写老消息后水位不降**：数组引用和长度都没变，`_ctxUsed` 仍返回清理前的实测值，
  于是"免费的这一遍"永远判定不够，白花一次模型摘要。现在清理成功即作废实测锚点（保留前缀）。
- 面板侧：`agent.usage` 改成**按会话分桶**（以前发的是引擎级、跨会话单调累加，切会话不清零），
  jsonl 落盘是单请求、实时是累计却喂同一个格子（切回旧会话就换口径）——现在回放累加、实时覆盖，
  标签从 `tokens` 改成「累计」并新增一格「水位」（与环形进度同一个分子/分母）。
- 记在这里没动：`_boundToolResult` 的分级预览仍按 `this._estTokens(this.history)` 取水位，
  并行会话下会读到别的会话的历史。失败方向是"收得更紧"，不影响正确性，属于另一件事。

**17′ v3.2.0 桌面安装包（#37）—— 已产出**（`release/pancode Setup 3.2.0.exe`，98 MB）

无边框全屏：`frame: false` + `show:false` → `ready-to-show` 里先 `maximize()` 再 `show()`
（否则开窗瞬间能看见"小窗→铺满"的跳变），`backgroundColor` 跟主题所以顶部不再是一条黑边。
左上角红绿灯走 preload：`contextIsolation` 下渲染进程没有别的通道，`ipcMain` 接
minimize / toggle-max / close，**close 仍走 `win.close()`**，让既有的"关窗 ≠ 退出"策略原样生效。
`_verify_desktop.js` 11 项在真实 Electron 里跑通（frameless 之后窗口照常加载、任务照跑、
关窗后进程与后端存活、托盘没退化）；包内 9 项关键改动用 asar 头部偏移直读复核到位。
**没用 `asar extract-file` 验包**（它按 basename 写进当前目录，曾经把仓库根的 package.json 覆盖成
包内裁剪版）：改成自己读 asar 头部拿 offset/size、按偏移直读字节比对内容，跑完 `git status` 确认
`package.json` 没被覆写。旧包按「只留最新」的口径删掉（3.0.0 / 3.1.0 两套 exe + blockmap）。

本轮总验收（2026-10-05）：`vitest` 34 文件 / **633 通过 | 1 跳过**、`test:verify` 22 个探针全绿 0 失败、
链尾真实数据根指纹一字未动（154 个文件）、`_verify_desktop.js` 11 项在真实 Electron 下通过。

**18′ 首屏 22 秒空白（#30 / #38）—— 已落地**（`server/git.js` 的 `baselinePlanner()` + `_verify_bootperf.js` 16 项）

根因不在渲染端：`hello` 里带全量 `files`，而 `snapshotFiles` 对**每个文件** await 一次
`git.baseline(rel)`，也就是发一发 `git show HEAD:<path>` 子进程。实测 126ms × 127 文件 = 22.3s——
窗口早开好了，里面是空的。

- 现在换成**一次 `ls-files` + 一次 `status`** 定盘：未跟踪的走启动快照、没改过的基线就是自身内容（零子进程）、
  只有真被修改的文件才发 `git show`。
- ⚠ `ls-files -- .` 输出的是 **cwd 相对**路径，**不能再套 `_fromRepo` 剥前缀**（与 `status --porcelain` 相反，
  后者输出仓库根相对）。这里踩过：套上之后子目录工作区里所有文件都"查无此文件"→ 全部误判成新增。
- 探针的第一优先级不是"快了"而是**等价**：两种口径对同一个 152 文件沙箱仓库逐文件比 `original`/`isNew`，
  逐字节相同才算过。理由——这份快照是"一键还原"的依据，改快了但算错基线比慢更糟。
  三条边界单独钉住：启动前就存在的未跟踪文件（两条口径都得"有基线、非新增"）、启动后新建的文件
  （两条都得 `null`）、没动过的文件（新口径不再发子进程）。
- 实测（同一沙箱、152 个文件、真 git 仓库，`_verify_bootperf.js` 里并排跑两种算法）：
  逐文件 `git show` **11736ms** → 批量 **308ms**（约 38×）；端到端 `hello` 到达 **289ms** 且带着全部 152 个文件。
- 探针已接进 `npm run test:verify` 链（`_verify_uitaste.js` 之后），不再是一次性脚本。

**19′ 工具预览分级读错历史数组（#39）—— 已落地**（`server/agent-llm.js` 的 `_liveHistory()` + `test/p3-token-accounting.test.js` 13 项）

16′ 结尾记下的那条"顺带"这次收了：`_boundToolResult` 的分级截断（水位 >60%/>80% 时把预览上限从 24000
收到 8000/4000）分子取的是 `this._estTokens(this.history)`。两个问题都在：
读的是**引擎上那份"最近被前台会话用过的历史"**（并行/后台会话按别人的水位收原文），
而且压缩后 `this.history` 换了引用、它还是旧数组，估出来的量与新历史无关。

- 现在分子与进度条同一个口径：`this._ctxUsed(this._liveHistory())`，
  `_liveHistory()` 优先取 `convContext` 里的 `getHist()`（`handleChat` 现在把局部 `history` 以
  `getHist: () => history` 挂进 store，这正是"局部变量 vs 实例字段"两者唯一的公共锚点），
  没有 store（子智能体、单测直调）或非数组时退回 `this.history`。
- 负控做过：把 `_liveHistory` 第一行改成 `const ctx = null` 之后，两条分档断言立刻红（11 通过 / 2 失败），
  改回来 13 项全绿——这两条不是空断言。
- 顺手抓到一处**测试自己的坑**：`expect(r).toContain("4000 字符")` 会被 `"24000 字符"` 满足，
  两条断言同时为真等于没测。现在从提示语里正则取出那个数（`tierOf()`）比数值，
  并且夹具自己带一条 `expect(_ctxUsed/_ctxLimit).toBeGreaterThan(0.8)`——
  前台那份历史要真是高水位，分档才有意义（第一版就因为它其实只有 46%，两条都在 24000 档上假绿过一轮）。

**20′ v3.2.1 桌面安装包（#37 重打包）—— 已产出并验收**（`release/pancode Setup 3.2.1.exe`，98.1 MB）

前一条改的是服务端首屏路径、后一条改的是引擎里的历史引用，都属于"打包时必须确认进去了"的那类，
所以这轮不再靠手工比对包内文件，把验收层固化成 `scripts/_verify_pkg.js`（`npm run verify:pkg`，16 项）：

- **A 产物跑得起来**：真起 `release/win-unpacked/pancode.exe`（沙箱数据根 + 独立端口 +
  `PANCODE_PROBE_CLOSE_MS` 到点关窗），轮询 `/api/health`，再从**它自己 serve 出来的** `/styles.css`、
  `/app.js`、`/` 断本轮改动确实在服务——包里的 `public/` 是构建时拷的，源码改了没打进包就是两套代码。
  实测：exe 起来到后端可访问 **820ms**；`health.workspace` 断言保证探针挂的是沙箱目录，不是用户真实工作区。
- **B 包内内容就是这一轮**：按 asar 头部的 offset/size **直读字节**（9 条：`baselinePlanner`/`trackedSet`、
  `_liveHistory` + `getHist: () => history`、`preload.js` 的 `pancodeWin`、`frame: false`、
  `--bg-elev`、`ag-orbit` 且无 `pcGradAgAvatar`、记忆分道、包内 `package.json` 版本 == 仓库版本、
  `scripts/` 不在包内）。**仍然没用 `asar extract-file`**（它按 basename 写进当前目录，曾覆写过仓库根 package.json）。
- ⚠ 探针自己的两个坑，都记在 `CLAUDE.md`：`chatInputBox` 是 `app.js` 运行时建的分隔层、HTML 里没有，
  拿它断"界面打进去没"会误报；`public/app.js` 顶层的 `state` 是全局词法绑定，`window.state` 恒 undefined，
  用它当"hello 到没到"的判据会永远等不到（为此烧掉两次 20s 超时，一度误判成服务端卡死——
  单独跑 `_diag` 才分清：写 900KB 文本之后 hello 仍然 10ms 到达，产品端没问题）。
- ⚠ `server/files.js` 的 `MAX_FILE = 1MB`：**超过 1MB 的文本根本不进文件索引**（也就不会出现在首屏 hello 里）。
  界面探针最初用 2.4MB 就是这个原因等不到，现在用 900KB。
- `_verify_uitaste.js` 加了第 ⑧ 段（45 项）：900KB 文本 + 两个窗口并发连，
  断首屏 3s 内可见、树里看得见、内容一字节不少、启动后新建的文件仍判成"新增"，
  以及**另一个窗口正在起首屏时已打开的窗口点击照常响应**（Electron 只有一个渲染进程，冻了就是整个应用冻）。
- `git-toplevel.test.js` 在本机并行跑会红两条：每个用例都要真起 git 子进程建仓库，单跑 1.6–5.7s、
  并行时超过默认 5s 上限。改成该文件 `vi.setConfig({ testTimeout: 30000 })`（只抬上限，不放宽断言），
  全量 `vitest` 从"34 文件里 1 红"变成 34 文件全绿。旧包 3.2.0 按「只留最新」删掉。

本轮总验收（2026-10-05 收盘）：`vitest` 34 文件 / **637 通过 | 1 跳过**（0 失败）、
`test:verify` **23 个探针全绿**（含新接入的 `_verify_bootperf.js` 16 项、`_verify_uitaste.js` 45 项）、
`verify:pkg` **16 项全绿**（真起了打包后的 exe）。

**21′ 存量垃圾记忆真的清出去了（#31 的收尾）—— 已落盘**

`_verify_memclean.js --apply` 在真实数据根跑完：**158 条 → 118 条**（含归档 20），
"自动沉淀却拿免检分"的条目**归零**（独立读盘复核过，不信脚本自己的报告）。每个动过的分片留
`.pre-clean-<时间戳>.bak`，回滚就是拷回去。用户级库（跨项目偏好）按默认没碰。

写这一条主要是为了记下抓出的**两个脚本自身的缺陷**，都是产品代码看着正常、一次性脚本跑一遍才露馅：

1. **`--apply` 第一版等于白跑**：`MemoryStore._save()` 走 `safe-write` 的异步串行队列（Windows 被锁还
   要退避到 ~3.7s），脚本在 `clean()` 之后同步 `inspect()` 读到的是旧内容，末尾 `process.exit()`
   又把排着没跑的写整批丢掉。发现方式很便宜：**对同一批分片重跑一遍，报告里居然是一模一样的数字**。
   现在改成轮询等落盘（上限 12s），断言只看读回来的内容。
2. **旧断言是假绿**：`after.willInject <= s.willInject` 挂着"注入量降下来了"的名字，但降级不动强度、
   prune 这一轮也未必收口它们，`37 → 37` 时它照样成立。改成断真正承诺的事——**盘上没有任何命中项仍免检**。
3. 顺带把指标名改对：那一直是"过了强度地板 1.5 的**候选数**"，不是注入数（注入还要过同主题 ≤2 与总量 ≤10）。
   名字写错让我把 37 读成"清理没效果"，白排查一轮。

还有一处判据偏差留在这里（不扩大范围，先记着）：清理判据只命中 40 条消失项里的 9 条，
剩下 31 条是 `"继续执行计划（下一步：…）"`、`"[GOAL MODE] 请创建计划并持续执行…"` 这种
**整段用户原话当主题**的长句——`isJunkPhrase` 的句式表按短句设计，长原话没进去。
它们是被产品自己的 `prune()` 收掉的，不是这支脚本干的；写入端闸门（#31）已经不让新的一批进来了。


---

## 5. 后续顺序重排（对照 `harness-optimization-2026-10.md` §8 的 P2 清单）

| 新序 | 项 | 变化与理由 |
|---|---|---|
| 1 | **§4 阶段一**（键统一 / subject 绝对化 / symlink / 配额） | 新增，且是一切的前置；单根状态下也是真 bug |
| 2 | **§4 阶段三 9–12**（任务表、排队语义、续跑持久化、通知与托盘） | 新增项。桌面助手的核心体验差异；现在 5 个断点里有 3 个会让用法直接失效 |
| 3 | #17 目标驱动状态机（armed/暂停/收口显式化） | 前移：与上一条是同一块地，合并做省一次重构 |
| 4 | §4 阶段二（多根授权） | 原方案里没有，按新定位是必需能力 |
| 5 | #21 `session_search` / `session_read` | 前移：跨会话找回任务是助手形态的高频动作 |
| 6 | #19 记忆抽取 agent + #20 记忆纪律提示 | 前移：助手的长期价值主要来自"它记得你"，不是"它会改代码" |
| 7 | #22 用量看板 | 不变，成本可见性对无人值守跑任务很重要 |
| 8 | #16 降级阶梯 + 两个断路器 | 不变：长任务稳定性兜底，仍应在编辑可靠性之前 |
| 9 | #15 九段摘要 + post-reminders | 不变 |
| 10 | #18 edit matchers + read-state 契约 | **后移**：纯 IDE 精修，助手场景占比下降 |
| 11 | #14 拆分 `agent-llm.js` | 建议**提到阶段一同批做**：键、subject、根归属这些改动都要在这个 4000+ 行文件里动刀，先拆再改会更省 |

`#13 工具契约字段化` 已完成（§12），顺带留下 4 条待拍板的偏差，其中两条在桌面形态下会变严重：
- `create_skill` 规划模式拦不住 → 通用助手语境下是用户能踩到的信任 bug，建议**随阶段一一起补**。
- `orchestrate` 不在子智能体黑名单 → 子代理可再开一轮编排；后台化之后会变成嵌套任务失控，建议在阶段三前定。

---

## 6. 明确不要做的

- **不要**为了多根而引入事件溯源式的全量状态机或插件框架（沿用上轮结论）。
- **不要**同时开放"全盘授权"和路径型 deny 规则——后者在前者存在时不再可信。
- **不要**在阶段一之前动 `FileStore` 的构造签名；键没统一时动它会把数据丢失风险从"记忆"扩大到"会话"。
- **不要**把通知做成页内 toast 的升级版（角标 + 系统通知 + 可从托盘回到具体会话，三者缺一不可）。

## 7. 需要你先定的三件事

1. 路线选 A 还是 B（我建议 B，但**阶段一独立成立**，可以先做阶段一再决定要不要继续）。
2. 关窗口之后 Agent 该不该继续跑（我建议该，并配一个显式的"终止所有任务"）。
3. 授权粒度：**全局一份授权根清单**（简单，像系统级权限）还是**每个会话各自一组**（可控，但每次新任务可能要问）。
