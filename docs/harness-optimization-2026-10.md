# Harness 代际跃迁方案：对标 deepseek-harness 与 ZCode

> 调研日期：2026-10-02
> 对标对象：`deepseek-ai/deepseek-harness`（"Everything is a Plugin"，61 packages TS monorepo）+ `zai-org/ZCode`（Z.ai coding agent harness）
> 本地留证：两份仓库浅克隆于 `E:\tmp\harness-study\{deepseek-harness,ZCode}`（研究期临时目录，非本项目依赖）
> 方法：逐文件精读竞品内核 + 逐行核对 pancode `server/agent-llm.js` / `config.js` / `memory-store.js` 现状
> 产出：6 个维度共 31 条可落地改动，含 P0 缺陷 4 个

---

## 0. 结论先行

**pancode 的功能矩阵不缺东西，缺的是"控制流的所有权"。**

两个竞品读了之后，最不该抄的是它们的包数量、TS 类型体操、事件溯源全栈。最该抄的是一条共同原则，它被写成了制度：

> ZCode `apps/zcode-cli/AGENTS.md`「长程任务优先」：核心 agent loop **不用 tool call 次数做硬停止**。资源与安全边界应由 token/context limit 自动 compact、用户取消、权限拒绝、工具超时、输出截断、provider retry 上限等**明确条件**承担。

对照 pancode 现状：`config.js:27` 是 `maxToolRounds: 100`，`agent-llm.js:2274-2277` 到点就 `say("已达到单任务最大工具调用轮数…请再发一条消息")`。这就是差距的本质——**pancode 的边界是"次数"，竞品的边界是"状态"**。次数会误伤能干活的任务，状态不会。

其余差距按同一模式归类，全部是"缺少不变式与失败分类"，而不是"缺少功能"：

| 维度 | pancode 现状 | 竞品的不变式 |
|---|---|---|
| 长任务 | 内存计数器 + 裸调 `handleChat` 续跑 | 续跑权限是进程局部的、先落盘再续跑、进模型前二次校验归属 |
| 上下文 | 一条 `min(window, window*0.9)` 阈值 + 保留 10 条 + 关键词挑旧消息 | 阈值先扣输出预留再扣 headroom；按 token 从尾累加且**绝不拆散 tool_call/tool 对**；摘要必须真的更小 |
| 记忆 | 规则原文 + 记忆 + 计划进度 + 技能目录混成 system 块；目标与计划进度是**本轮开始时冻结**的 | 运行时状态走尾部快照、每轮刷新，不重写前缀；增强块按变化频率分桶 |
| 工具调用 | 同一步多调用**串行**；参数错/拒绝/超时都拼成中文字符串 | 只读并行+独占 barrier，结果按模型序提交；policy 拒绝与通道故障是两种结构化判决 |
| 工具设计 | 工具是 `TOOLS` 数组里的 description 字符串 + `execTool` switch | 工具是带 14 项元数据的契约，副作用范围显式声明，权限读声明不猜调用点 |
| Token | 中文按 `len/4` 估算（1 字仅计 0.25 token）；摘要请求冷启整条前缀 | 中文字符 ×2 权重（=0.5 token/字）；摘要复用真实前缀；超长结果落 artifact 只回预览 |

**顺带查出 4 个 P0 缺陷**（§7），其中 `delete_file` 在全自动模式下不弹确认这一条，与 `agent-llm.js:1338` 自己写的注释意图直接相反。

---

## 1. 长任务处理

### 1.1 Goal 续跑：从"计数器"升级为"带 revision 的状态机 + 归属栅栏"

**竞品做法**

deepseek-harness 把 goal 拆成两半，边界极干净：

- 持久半：`packages/goal/goal/src/types.ts:45-69` —— `GoalPhase = active|paused|blocked|complete`，`GoalRef = {id, revision}`，revision 是 compare-and-set 身份，每次持久变更自增。
- 非持久半：`types.ts:72,98` —— `GoalActivation = 'armed'|'disarmed'`，注释明写「Process-local continuation eligibility; **never persisted**」。插件加载时遍历现存 agent 全部 `disarm`（`goal-round-driver/src/index.ts:429-432`）。理由：resume/fork/冷启动的会话，绝不该被上一个进程残留的自动续跑权限驱动。

续跑驱动器（`packages/goal/goal-round-driver/src/index.ts`）的时序，每一条都对应一类真实事故：

1. 只在 agent 真空闲时触发：`:103-109` 要求 exact live agent + `status==='idle'` + 无竞争排队项。
2. **先落盘再续跑**：`:142-154` 若 `needsCheckpoint` 就 `await sessions.flush()`，flush 失败则 disarm 并停止自动续跑（宁可不跑，不要跑丢）。
3. 预约下一轮：`:174-190` 造一条带 `source:{kind:'goal', goalId, revision, round}` 的 user message 入队，登记 `RoundAttempt{phase:'queued'}`。
4. **两道归属校验**：`:345-358` 在 `agent/pre-step` 进 `next()` 前校验 `validReservation`（含 `source.round === goal.roundsStarted + 1`），`:411-423` `await next()` 之后**再校验一次**；任一次不过就 reject，并把别人的排队消息 `restoreOtherClaimed` 送回 inbox（`:127-135`）。
5. 轮次上限：`:166-172` `roundsStarted >= maxGoalRounds` → block，reason code `'round-limit'`。

反「假完成」硬门禁：`packages/goal/tool-goal/src/index.ts:39,115-123,305-312` —— `blockedAfterConsecutiveRounds` 默认 **3**，且把策略写进 system prompt：「blocked 只在同一阻塞条件持续 ≥3 个连续轮后出现；**difficulty、uncertainty、或还有有用工作可做，都不算 blocked**」；执行期同样拦：轮数不足 3 就报 blocked 直接抛 `GOAL_TOOL_BLOCK_THRESHOLD`。另外 `:279-285` **模型不能 resume 自己 paused 的 goal**（必须用户来）。

续跑提示词本身也值得抄（`goal-round-driver/src/prompt.ts:12-26`）：

> 把当前 workspace、工具结果、持久 session 状态当权威，**inspect them instead of assuming earlier narration is still current**；宣告完成前先取证、读当前 goal、标记 complete；还有活就把 goal 留在 active 等下一轮。

**pancode 落点**

现状 `agent-llm.js:1255-1259` `_loadGoal/_saveGoal` 只存 `{goal, ts}`；`:86-87` `GOAL_MAX_TURNS=40`/`GOAL_MAX_STALL=3`；`:2529-2552` 续跑是内存计数 + 裸调 `this.handleChat("【Goal 自动续跑 · 第 N 轮】…")`。

改法（按投入产出排序）：

1. `.pancode/goals/<ws>.json` 扩成 `{id, revision, objective, phase, maxRounds, roundsStarted, blockedReason, blockedSince}`；`revision` 每次写自增，`set_goal`/`goal_status`/`update_goal` 要求回填精确 `id+revision`。
2. `armed` 只存进程内。`_loadGoal()` 读到 `phase==='active'` 时**不自动续跑**，改为提示「检测到未完成目标（已推进 N/40 轮），是否继续？」——这条同时修掉现在"重启即无感续跑"的越权风险。
3. 续跑前 `flushConversations()`（`:892` 已有），失败就停，不硬撑。
4. 加 `blocked` 阈值：连续 3 轮同一阻塞原因才准宣告 blocked，且"难/不确定/还有活干"不算。
5. 续跑 prompt 补上 harness 那句「工作区与持久状态是权威，别假设你先前的叙述仍然成立」。

### 1.2 主循环停止条件：把 `maxToolRounds` 从"刹车"改成"仪表盘"

**竞品做法**：ZCode `runtime/methods/turn-loop.ts:47` 是 `while(true)`，全仓库找不到主循环上的 maxTurns；停止条件散在 6 个明确处，其中烧钱类死循环由**断路器**兜（见 §2.7）。deepseek-harness 同理，轮次预算挂在 goal 的 `maxGoalRounds`（会话级），而不是循环级。

**pancode 落点**：`agent-llm.js:2274-2277` 改为三段式——
- `rounds === 0.6*max`：只 emit 一个提示胶囊，不停；
- `rounds >= max`：走已有的 `requestApproval`（`:1408`）问用户「已跑 N 轮仍未收敛，是否继续再给 20 轮」，批准则 `max += 20`；
- 真停的条件交给状态：连续 3 轮零改动零新结果（已有 `GOAL_MAX_STALL`，但目前只在 goal 路径生效，应提到主循环）、rapid-refill 断路器、provider 重试上限。

### 1.3 崩溃/中断修复：补齐 dangling tool_calls（P0，见 §7.1）

**竞品做法**：`packages/core/session/src/repair.ts`。`:53-98` `openTurnClosers()` 从尾部扫出未闭合的 turn/step，先补缺失 tool result，再补 `step/end`、`turn/end`；seq 从最后真实事件续，**时间戳复用最后真实时间**（`:86-87` 注释：不臆造"未来"时间）。`:32-41` 两种 cause 各有**决策指导**性质的文案：

- 已记录 started：「its outcome is unknown… **retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.**」
- 未 started：「interrupted before the Harness recorded it as started. Retry it if it is still needed.」

`:105-197` `ToolCallRecovery` 只在 `surfaceOp==='append'` 且 turn/step 匹配时才消解 pending；合成的 tool 消息 id 确定性生成 `${cause}-tool-result-${callId}-${seq}`。

**pancode 落点**：`_loadConversations`（`:811-846`）目前只 `_sanitizeHistory`（`:66-73`，只修 name/arguments 形状）。新增 `_repairToolPairing(history)`，在加载后、发请求前跑，用上面两段原文回填缺失的 `role:'tool'` 消息。

### 1.4 停滞检测：从"计数器"到"稳定签名 + 精确命中 + 警告预算"

**竞品做法**

ZCode `runtime/helpers/model-anomaly.ts`：

```ts
function buildRepeatedToolCallSignature(toolName, input) {
  return `${JSON.stringify(toolName)}:${stableJson(input)}`;   // :111-113
}
function stableJson(value) { /* 递归 + Object.keys(...).sort() */ }  // :115-127
```

三个设计点：**稳定 JSON**（`{a,b}` 与 `{b,a}` 必须同签名，否则永远检测不到重复）；**只在 `streakCount !== threshold` 时动作**（`:43`，即精确在阈值那一次触发一次，不每次都念）；**警告本身有预算**（`:47` `anomalyWarningsInjected < 3/turn`，否则死循环的 agent 会不断吸入自己的警告，警告又变成新的历史负担）。

提示词原文（`:93-109`）：

> You have called ${toolName} with the same input ${observedCount} times in a row. Do not repeat the exact same tool call again unless the user explicitly asked you to retry it unchanged. Use the existing result to take a different next step, explain the blocker, or ask the user for guidance.

deepseek-harness `packages/guard/repeat-tool-reminder/src/index.ts` 补了两条更细的：`:53` 分级阈值 `[3,5,8]`，`:70-86` 首阈值温和、后续列出 tool 名/连续次数/规范化参数；`:196-214` 挂在 `tools/post-execute` 且**被 deny/被 block 的调用也计数**（`:193-195` 注释：「a model hammering a denied call is exactly the loop worth breaking」）；`:236-239` **用户插话就清空整条链**（「跨用户插话的重复不是循环」）。

**pancode 落点**：`agent-llm.js:2386-2398` 现在是指纹 `name + JSON.stringify(args)`（键序不稳定）+ 连续计数 ≥4 就阻断。四处要改：`JSON.stringify` 换成递归排序的 `stableStringify`；分级提醒（3 提醒 / 5 强提醒 / 8 阻断）而不是 4 直接断；被权限拦掉的调用也要计数；本轮有真实用户输入时重置链。

### 1.5 后台任务完成通知：批量合并成一条模型轮

**竞品做法**：ZCode `runtime/command-queue.ts:184-203` 的 `dequeueNextBatch()` —— 只有**同优先级的 `task-notification` 会被打包成一批**，其它模式一律单条出队。注释性理由：3 个后台 bash 同时跑完，应该在一条模型轮里收到 3 条通知，而不是排 3 轮、烧 3 次完整上下文。队列优先级只有三档 `now|next|later`（`:10-17`）。

**pancode 落点**：pancode 的长驻进程是 `start_process` + `read_process` **轮询**模型（`tools/processes.js`），Agent 得自己想着去查。改造：`server/scheduler.js` 里给进程加"完成即入队一条通知"的车道，主循环轮首 drain（抄 `turn-loop.ts:56` 的位置：drain 后若 >0 就清空重复调用计数，`:62-64`）。

### 1.6 ralph：每轮零上下文重启 + 有界结构化交接

**竞品做法**：`packages/workflow/tool-ralph/src/index.ts`。与 goal 正交——goal 是"同一上下文反复自激"，ralph 是"每轮全新 child + 有界交接"，把记忆外置到工作区以避免污染累积。

- `:88-175` 循环脚本是**部署侧固定的 JS 字符串，模型不可改**；`:149-173` 每轮 `await agent(prompt, {schema: reportSchema})`，把上一轮 report `JSON.stringify` 塞进本轮 prompt。
- 交接 schema：`:89-100` `{status: continue|complete|blocked, summary, evidence[], nextSteps[], blocker}`；`:110-147` 做**状态与字段的交叉校验**（continue 必须有 nextSteps 且 blocker 空；complete 必须有 evidence 且 nextSteps 空；blocked 必须有具体 blocker），最后限制 `serialized.length <= maxHandoffChars`（默认 16384）。
- `:157` prompt 里明写：「**The shared workspace and its current working tree are the long-term memory and source of truth**… Treat the previous report only as a bounded handoff; confirm it against the workspace」。
- 结束态四种：`complete` / `blocked` / `budget-limited` / `round-failed`（child 没给出结构化报告）。
- `:177-182` 工具描述里加了「Completion and blockers are **worker reports, not independent evaluation**」，并把用量约束写明只在人类显式要求时启用。

**pancode 落点**：等价物是 `orchestrator.js`。值得抄的最小版是**把交接契约做成校验函数**（`tool-ralph/index.ts:110-147` 可直译成 JS），`agent`/`orchestrate` 的子智能体返回必须过这个门，不过就当 `round-failed` 处理。pancode 现在收的是自由中文汇报，父 Agent 无从判断子任务到底完成了没有。

### 1.7 子智能体的结算诚实性

**竞品做法**：`packages/subagent/subagent/src/continuation-messages.ts:106-127` 的六种结束文案 —— `finished` / `was stopped before it finished` / `ran out of room` / `declined the task` / `failed before it finished` / 未知结尾「ended abnormally (…) before it finished」——**绝不把不可名状的结束报成成功**。`:26-38` 注释更狠：agent 消息与 runtime 结算记录是两个不同 source kind，因为「a transcript that merged them would credit the child with words it never wrote」。

**pancode 落点**：`runSubAgent`（`:1164-1243`）返回 `finalText`，若子智能体被 abort 返回 `(子智能体已随主任务中断)`，若跑满轮次没结论则返回最后一次 content 原文——**后者会被父 Agent 当成功解读**。加一个 `{status, text}` 结构，`status` 取 `finished|stopped|out_of_rounds|failed`。

---

## 2. 上下文窗口管理

### 2.1 阈值算术：先扣输出预留，再扣 headroom

**竞品做法（两家数字不同，结构相同）**

ZCode `compact/policy.ts:6-14,67-88`：

```ts
export const DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

outputReserve   = min(maxOutputTokens ?? 32_000, 21_000)
effectiveWindow = max(0, contextWindow - outputReserve)
threshold       = max(0, effectiveWindow - 13_000)     // 200K 模型 → 166_000
```

根因注释（`:69-72`），**这一句值整个方案的钱**：

> provider 的 context window 是 input + output **共享**窗口；自动压缩只能让出输入侧，因此阈值分母必须先扣掉当前模型允许的 output token，而不是继续吃完整 contextWindow。

deepseek-harness `packages/compaction/compaction-basic/src/config.ts:20-23,153-217`：`thresholdRatio=0.8`、`retainRatio=0.16`、`headroomTokens` 默认 **65536**、`maxTokens` 默认取 headroom；
`messageBudget = contextWindow - reservedCompletionTokens` → `pressureBudget = messageBudget - headroomTokens` → `thresholdTokens = floor(min(contextWindow*0.8, pressureBudget))` → `retainTokens = floor(messageBudget*0.16)`；并硬校验 `retainTokens >= thresholdTokens` 直接抛错（`:198-204`），预留吃满窗口时抛**带修复指引**的错误（`:173-190`）。每个 provider/model 可单独覆写（`:46-50,118-139`），未知配置 key 在加载期拒绝（`:330-334`「Reject stale or misspelled keys before defaults can hide them」）。

**pancode 落点**：`agent-llm.js:1733` 与 `:2281`。顺带说一句：`:2281` 写的是 `Math.min(this._ctxBudget(), Math.round(this._ctxBudget() * 0.9))` —— 这个 min 恒等于右值，是个没意义的表达式，读起来像是想表达别的意图。两处统一改成一个 `_compactSpec()` 纯函数，返回 `{thresholdTokens, retainTokens, outputReserve, headroom}`，并像竞品那样：`retainTokens >= thresholdTokens` 就抛错而不是默默跑出一个永不收敛的循环。

### 2.2 选区算法：按 token 从尾累加，绝不拆散 tool_call/tool 对

**竞品做法**

`packages/compaction/compaction-basic/src/region.ts:117-155` `selectCompactRange()`：

1. `:126-129` 先断言 token-meter 的 surface 与 session.surface 完全一致，否则抛错（防用陈旧计价选区）；
2. `:131` 若节点 0 是 system message，**永不纳入压缩区**（`:99-113`）；
3. `:133-140` 从尾向前累加逐节点定价，到 `>= retainTokens` 停 → `keepFromIdx`；
4. `:143-147` **关键**：向前退到 `toolPairingBalancedBefore(...)` 为真的位置，即保留侧起点必须是一个 step 的 tool-call/result 对之外的平衡边界，绝不拆散一对；退无可退则返回 null；
5. `:337-358` 校验侧再查 `balancedBefore(start)` 与 `balancedAfter(end)`，错误消息直接说明「would split a step's tool-call/result pair」。

ZCode 的分组更朴素但同样稳：`compact/rounds.ts:1-35` 以「assistant 消息起始」为一轮边界分组，`runtime/helpers/compact-selection.ts:30-57` 保留最近 N **组**（不是 N 条），且 `maxGroupsToPreserve = groups.length - 1` —— **永远至少留一组去摘要**。

**pancode 落点**：`agent-llm.js:1740-1743`。现在是 `keep = 10` **条**，且 `history.length - keep` 一刀切。这里藏着 §7.2 那个 P0。改法：把 `history` 按 `assistant.tool_calls` 起始分组，按 token 预算从尾累加保留组数，边界永远落在组间。

### 2.3 砍掉"关键词保留旧消息"，改成 pruner 先跑一遍

**竞品做法**：harness 摘要后不靠关键词留旧消息，未决意图由摘要模板的 `Pending Jobs` / `Next Step` 段承接。而"旧的巨大工具结果"由**不调模型的廉价通道**先清掉：

- harness `compaction-basic/src/index.ts:323-327`：达到阈值后**先跑 `toolResultPruner.prSession()` 再重测**，第二次仍不达标才摘要——注释意图是"模型免费的第一遍优先于摘要"。
- ZCode `compact/microcompact.ts` 更完整，全部常量：

```ts
export const MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE = "[Old tool result content cleared]";
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5;      // 单位是"组"，并行调用算一组
const DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES = 60;
export const DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS = 256;
export const DEFAULT_MICROCOMPACT_THRESHOLD_RATIO = 0.9;
export const DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2_000;
export const DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS =
  ["Read","Bash","Grep","Glob","WebFetch","WebSearch","Edit","Write","ApplyPatch"];
```

阈值取 `min(0.9*fullThreshold, fullThreshold - 2000)`（`:77-81`，**取更保守的那个**）；双触发 `TimeBased`（距上次 assistant 完成 >60min，即"用户回来了先清场"）或 `TokenPressure`（`:171-195`）；候选需 `toolName ∈ 白名单 && !isError && !已是占位 && !含媒体块`（`:249-256`）；**`savings < 256` 整体回滚**返回原始 messages（`:148-153`，省得太少就不折腾，避免无意义的前缀失效）。

**pancode 落点**：`agent-llm.js:1744-1751` 的 `isCritical` 关键词正则（`/(错误|error|失败|exception|已写入|...)/i`）+「user 消息永远保留」两条一起删掉——后者是长任务越跑越挤的直接原因（几十条历史 user 消息永久在场）。改为：先做 microcompact（只清旧的工具结果文本，保留最近 5 组），重测，仍超再做摘要。

### 2.4 摘要必须真的更小（shrink 检查）

**竞品做法**：`region.ts:417-422` —— `if (meter.estimateMessage(checkpointMessage) >= prepared.shadowedRouteTokenCount) throw`。理由直白：啰嗦的模型可能写出比原文更长的摘要，不检查的话"压缩"变成放大器。

**pancode 落点**：`agent-llm.js:1760` 已经算了 `after`，但 `:1775` 无条件 `return newHist`。加一行：`if (after >= used) { emit 诊断; return history; }`。

### 2.5 摘要请求要复用 KV 前缀

**竞品做法**：`region.ts:544-563` `buildSummarizationInput()` 重放"最后一次路由请求的可缓存前缀"= surface 节点 0 的 system + header.tools + 被遮罩区域自身派生的 messages；摘要指令作为**最后一条 user message** 追加（`summarizer.ts:25-31` 注释）。`:532-543` 说明动机：DeepSeek 是自动前缀缓存（无 `cache_control`），**独立 system 的摘要调用会冷启整条前缀**。摘要调用走 `ctx.llm.stream()` 一次性请求、`purpose:'compaction'`，不进 agent loop（`index.ts:237-257`，`summarizer.ts:120-181`）。

失败姿态（`summarizer.ts:196-211`）：`error`/`aborted`/`max-tokens`（「incomplete checkpoint」）**都抛错**，绝不接受半截摘要；`:213-221` 摘要里出现 image 直接 `UNSUPPORTED_CONTENT` 拒绝。

**pancode 落点**：`_summarize`（`:1709-1725`）现在是 `chatStream(this.cfg.llm, [新 system, txt], null, null)` —— 新 system + 把历史压成 12000 字符 + tools 传 null。这是最贵的写法。改成 `[SYSTEM_PROMPT 原文, ...待压区间(保留原形状), 摘要指令作为最后一条 user]`，`tools` 与主请求一致。

**一处真实的张力要说明**：带 tools 会复用缓存，但摘要请求不该能调工具。ZCode 的答案是分层兜：`compact-active.ts:251-257` 只在工具数超过 `COMPACT_TOOL_KEEP_MAX_COUNT = 100` 时才清空 compactTools（「massive MCP 工具会把 compact summary request 的 provider context 撑爆」），并在 `compact-active-helpers.ts:93-121` **硬禁**：摘要里出现任何 toolCall 就 throw `ModelError("Tool use is not allowed during compaction")`，`retryable:false`，且 deny 的 context 形状与权限系统的 deny 同构。pancode 照此：带 tools + 事后校验并拒绝。

### 2.6 摘要提示词与压缩后重建

**竞品做法（这部分是最可直接搬运的资产）**

ZCode `compact/prompt.ts`。`NO_TOOLS_PREAMBLE`（`:1-8`）：

```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.
```

九段结构（`:14-109`）：Primary Request and Intent / Key Technical Concepts / Files and Code Sections / Errors and Fixes / Problem Solving / **All user messages** / **Pending Tasks** / **Current Work** / **Optional Next Step**。规则含「保留精确路径、命令、错误串、数值、函数签名」「不要提及本次摘要或上下文被压缩过」「遇到已存在的 `<compacted-summary>` 要合并而非照抄」。

两个"防漂移"设计点名值得单独学：**第 6 段"列出全部非 tool-result 的 user 消息"** = 用户意图的不可变账本；**第 9 段要求"直接引用最近对话原文"** = 防止压缩本身改写任务定义。安全约束被点名两次（分析清单 + 第 6 段），因为**权限边界必须在压缩后继续生效**：

> Note any security-relevant instructions or constraints the user stated… These MUST be preserved verbatim in the summary so they continue to apply after compaction.

压缩后新历史的四段布局（ZCode `helpers/compact.ts:72-88`）：

```
[ canonical prefix ] + [ summary(user) ] + [ preservedEntries ] + [ postCompactReminderEntries ]
```

`:157-166` 被保留的 assistant entry 上的 provider token usage 要 `invalidateRuntimeTokenUsage` —— **旧 usage 不再描述新历史，留着会让下一次锚点算错**。

`buildCompactSummaryMessage`（`prompt.ts:133-165`）的续跑文案：

> This session is being continued from a previous conversation that ran out of context… If you need specific details from before compaction… read the full transcript at: `${transcriptPath}` … Recent messages are preserved verbatim … Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar.

最后一段（`suppressFollowup`，自动压缩专用）防止 Agent 停下来向用户复述摘要。

**post-reminders：pancode 完全没有的一段**（ZCode `runtime/helpers/compact-post-reminders.ts`）。预算 `maxFiles ?? 5`、`maxFileApproxTokens ?? 5_000`、`maxTotalApproxTokens ?? 50_000`（`:20-22`）；选件按 `readAt` 倒序（`:31`）、跳过 `/.git/`（`:115-118`）、**跳过 preservedEntries 里已经有 Read 调用的文件**（`:25,74-86`，避免同一文件既在保留原文里又以 reminder 重复）。超预算的文件**降级为一行提示而不是丢弃**（`:57-59`）：

```
Note: ${path} was read before the last conversation was summarized, but the contents are too large to include. Use Read tool if you need to access it.
```

未超预算的文件**重建为"看起来像原始 tool result"的形状**（`:61-68`）：

```
Called the Read tool with the following input: {"file_path":"...","offset":N,"limit":M}
Result of calling the Read tool:
1\t<line>
```

为什么这么写：让模型把它当成"我自己调过 Read 的结果"而不是"系统硬塞给我的文件内容"——这既维护心理模型一致性，又满足 Edit 需要 read-state 的执行期约束（见 §5.5）。

计划文件重注入（`plan-file-continuity.ts:92-102`）：

```
A plan file exists from plan mode at: ${path}

Plan contents:

${content}

If this plan is relevant to the current work and not already complete, continue working on it.
```

计划文件在 `<workspaceRoot>/.zcode/plans/plan-<sessionId>.md`，原子写。**计划不靠上下文存活，靠磁盘 + 一条引用 reminder 存活。**

**pancode 落点**：`_summarize` 的五段模板（`:1714-1720`）扩成九段（重点补 `All user messages` / `Pending Tasks` / `Current Work` / `Next Step 需引用原文` / 安全约束逐字保留）；`compactHistory` 的 `newHist`（`:1755-1759`）改成四段布局，摘要落 `role:'user'` + `<compacted-summary>` 标签（harness `region.ts:410-413` 用 user 而非 system，理由：多数 provider 对中段 system 行为不一致）+ 续跑 preamble；补 post-reminders（pancode 已有 `codeIndex`/`_repoCache`，读文件状态可从 `patch` 暂存记录反推）。

### 2.7 降级阶梯与两个断路器

**竞品做法（ZCode 这块是全仓库工程密度最高的部分，`compact-active.ts:259-482`）**

四层降级：

- 第 0 层：初始选择就按**缺口**扩保留（`compact-selection.ts:103-139`）。缺口从 provider 错误文本反解：`message.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i)`（`compact-active.ts:400-410`），且 `getPromptTooLongTokenGap`（`:370-398`）用深度 6 + WeakSet 防环遍历 `cause|lastError|error`，每层探 `message|errorDetails|details|body`。`countRecentGroupsToCoverTokenGap`（`:245-266`）若需要保留几乎全部组，**退让为 `floor(groupCount/2)`**。
- 第 1 层：摘要请求本身超窗 → 先扩保留。
- 第 2 层：保留已到上限 → 截断待摘要集合。但 `canUseCompactSummaryTruncationFallback` **排除 Auto 和 Reactive**（`:688-690`）——自动压缩时静默丢旧轮次 = 静默丢用户内容，只有用户显式 `/compact` 才允许。切完首条若是 assistant（provider 非法起点）则插一条 marker，且重试前先剥掉旧 marker 避免堆积（`:292-294`）。最终失败文案明确 `retryable: false`，注释（`compact-active-helpers.ts:37-39`）：**「compact 内部已完成最多 3 次截断重试；最终仍超窗时不能再被 auto compact 外层重试放大成 3x3」**——重试预算必须显式声明。
- 第 3 层：媒体过大 → 剥媒体重试一次（`helpers/compact-media.ts:84-100`，image/video/file 换成 `[image]/[video]/[document]`；`:91-93` 注释「retry 媒体瘦身漏掉 video 会让大体积 base64 原样穿过」）。

超窗不一定 throw，还要读 finishReason：`compact-active-helpers.ts:44-65` 里有个专门的补丁——

```ts
// GLM/Z.AI compact 可能以 length + 空文本完成，真实含义是没有可保存的 summary；
// 仅在 compact 路径把它归类为超窗压力，复用已有 prompt-too-long 降输入重试。
function isCompactEmptyLengthFinish(result) {
  return result.finishReason.trim().toLowerCase() === "length" && result.text.trim().length === 0;
}
```

两个断路器：

1. 失败断路器 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`（`policy.ts:13,90-155`，reason 之一 `circuit_breaker`）。
2. **成功但没用的断路器**（`turn-loop-state.ts:21-22,154-168`）：`RAPID_REFILL_TOOL_TURN_THRESHOLD = 3`、`MAX_CONSECUTIVE_RAPID_REFILLS = 3`，`toolTurnsSinceCompact` 只在完整工具批次结束 +1。用户文案（`model-errors.ts:52`）：

> Autocompact stopped because the context refilled within fewer than 3 tool turns after compaction 3 times in a row. A file or tool output may be too large. Read it in smaller chunks, or start a new session.

这条防的是"压缩→立刻又满→再压缩"的死循环烧钱。朴素实现只有 failure breaker，没有 **success-that-doesn't-help** breaker。此外 `compact-active.ts:569-572` 记录 `willRetriggerNextTurn`——压缩质量本身是要有反馈量的。

还有两种终态语义：`no-op 不是失败`（`compact-active.ts:217-238`：「刚压缩过或历史太少时，/compact 是健康 no-op，不能暴露成系统故障」→ 返回 `{outcome:'skipped'}`）；`reactive` 的"本轮只试一次"作用域从 turn 收窄到 model step（`turn-loop-state.ts:180-186` 注释：旧 guard 活在整个用户 turn，导致后续真实 overflow 无法再次 reactive compact）。

**pancode 落点**：`agent-llm.js:2293-2326` 现在只有一个 `attempt<3` 的 LLM 重试 + `:2309-2313` 一次 force 压缩 + `:2066-2076` `_aggressiveTrim` 逐条 splice（同样有拆散 tool 对的风险）。改造清单：加 microcompact 层；`_aggressiveTrim` 改成按组丢弃且只丢工具结果；加 success breaker；压缩失败分类（cancelled/busy/persistence/commit/changed/summary，harness `:416-434`）；`:2293` 的重试与压缩重试要互相声明不可叠加。

### 2.8 token 计量：中文权重 + usage 锚点方向

**竞品做法**：ZCode `context/utils.ts:12-18` 的完整函数：

```ts
// 中文字符通常比英文字符占用更多 token，因此按两个估算字符计入。
const chineseChars = (text.match(/[一-鿿]/g) || []).length;
const otherChars = text.length - chineseChars;
return Math.ceil((chineseChars * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
```

即中文按 **0.5 token/字** 计（`DIVISOR` 为共享常量），英文按 0.25。计量用**混合锚点**（`compact.ts:313-340`）：反向扫描 `findLatestCommittedAssistantUsage` 拿 provider 真值 + 之后新增消息本地增量估算；注释 `:326-328`：「usage 归属于已提交 assistant，反向扫描可随 history replacement 自然移动，**不再依赖可能失效的绝对 message cursor**」。估算器本身修了三处（`compact/manual.ts:102-138`）：assistant 的 toolCalls（name + JSON.stringify(input)）计入；reasoning block 计入文本；`JSON.stringify` 抛错降级 `"{}"`（「异常输入不能让本地预算估算中断 compact」）。

harness 的计价更细（`packages/llm/token-meter/src/estimate.ts`）：4 char/token、每块 4 token 结构开销、每条 message 4 token role 开销、**tools schema 单独计价**；快照带 `baseline.kind === 'usage' | 'estimated'` 与有符号 `surfaceDeltaTokens`。

**pancode 落点**：`_estTokens`（`:1676-1689`）用 `length/4`，中英一视同仁 —— 中文 1 字实际 ≈0.6~1 token（随上游 tokenizer 而变），**pancode 只按 0.25 计，对以中文为主的载荷系统性低估 2~4 倍**。pancode 的规则、记忆、注释、回复全是中文，这直接导致压缩触发过晚、进度条虚低（`:1682-1685` 已经把 tool_calls 参数计入，方向对，权重错）。改：中文（含全角标点、CJK 区间）按 ×2 计 —— 注意改完仍偏保守 1.2~2 倍，但**误差方向必须从"低估"翻到"高估"**：低估会让 pancode 撞上游 400，高估只是早一点压缩。`_lastPrompt/_lastPromptLen` 换成"反向找最近一条带 usage 的 assistant"，消掉 `:1031,2285,2315,2075` 四处手工归零。

### 2.9 上下文用量分解：可观测性仪表盘

**竞品做法**：ZCode `runtime/methods/context-usage.ts:119-253`，七个类目：`System prompt` / `Meta user context` / `Skills` / `Tool prompt` / `System tool schemas` / `MCP tool schemas` / `Messages`，`.filter(c => c.tokens > 0)` 后逐个算百分比。切分判据用 `injectionTarget × source` 双轴（`:131-141`）。`Messages` **故意排除**已被 sections 统计过的 system role 与 meta-user 包装（`:147-155`），带一个例外回补：`inputPresentation === "task_notification"`（注释 `:149`：「新轮通知带 wrapper，但并未计入 ContextBuilder sections；按可信来源计回 Messages，避免漏算」）。每个 contributor 带 `tokenMethod` / `confidence` / `tokenizer`，顶层挂两条自我警告（`:248-251`）：

> 当前 token 来自本地估算，不是 provider count；tool schema 的真实 token 取决于 provider 序列化。
> Messages 分类不重复计算 system role 或 meta user context，因为它们已按 sections 单独统计。

**pancode 落点**：现在只有一个总数进度条。pancode 的 `aug`（`:1566+`）本来就是分段拼的，把每段字符数记下来 emit 出去即可，成本极低，价值是直接告诉用户"这次变慢是 MCP 工具 schema 占了 30%"。
---

## 3. 长期记忆

**先说一句判断**：pancode 的 `memory-store.js` 有竞品**没有**的东西——Ebbinghaus 衰减（`:20-30` `decayWeight`，半衰期 7~63 天随访问次数增长，高价值 ×2）、`valueScore`、`isSticky` 豁免、`prune()` 软归档、`_rescueCorrupt()` 坏文件留证备份并从 markdown 行捞回内容（`:52-66`）。这套不要推倒。harness 甚至根本没有独立记忆子系统。**要补的是三条纪律**。

### 3.1 规则分层与增量对账

**竞品做法**：`packages/context/agent-instructions/src/`

- 候选集配置：`config.ts:11-13` —— `projectRootMarkers=['.git']`、`instructionFileCandidates=['AGENTS.md','CLAUDE.md']`、`localInstructionFileCandidates=['AGENTS.local.md','CLAUDE.local.md']`（本地覆盖层，同目录排在基础文件之后）。
- 发现顺序：`files.ts:272-314` —— `$DSH_HOME/AGENTS.md`（**用户全局**）→ `findProjectRoot`（`:181-196` 向上走到第一个含 marker 的目录）→ `ancestorChain(projectRoot, cwd)`（`:204-217` 由宽到窄）逐目录探。
- 读取上限：`readBounded()`（`:334-364`）先用 `size` 快速拒绝，再**流式累计字节超 `maxSourceBytes`（默认 1 MiB）即弃**；渲染层再受 `maxBytes` 约束。
- 同目录去重：`dedupInstructionFilesByDirectory()`（`:375-391`）trimmed 内容摘要相同只留最早候选；**跨目录即使相同也不折叠**。
- 三态探测：`:74-78` `ScopeInstructionProbe = present | absent | unavailable`——「确认不存在」与「provider 暂时读不到」严格分开。
- **增量对账**：`state.ts:247-434` `reconcileInstructionContext()` 只对必要 scope 探测；**元数据快路径**（`:376-390`）缓存的 `version` 与 `digest` 都命中且先前已渲染 → 完全不重读文件内容（`:55-64` 注释「instruction prose is deliberately not retained」）；**失败回滚**（`:352-365`）同目录任一成员 `unavailable` → 丢弃整组新条目、恢复先前版本缓存，注释理由：「cache warmth must never decide whether a sibling transition is emitted」；渲染后无变化就什么都不追加（`:424-429`）。
- 模型可见来源带变更集：`state.ts:37-46` `{kind:'agent-instructions', baseline?, baselineIdentity?, changes:[{action:'set'|'replace'|'remove', scope, path, digest}]}`。
- 当前可见状态从 **surface 折叠**得出（`:136-157`）——压缩后不再可见的旧 baseline 自然失效，不需要额外失效协议。
- 触发时机：首轮 baseline（`index.ts:140-188`）；**文件被触碰后重扫**（`:74-82` `FILE_TOUCH_TOOL_NAMES = {'read','write','edit'}` + `:343-359` `tools/result` 监听，PTC 嵌套调用的触碰向上传给父 exec）；若 step 还开着就推迟到 `step/end` 再排队（`:296-313`，避免在 step 中途改 inbox）；去抖用每 agent 一条 `projectionTails` 串行链（`:103,266-284`，注释：「Emit listeners are not awaited, so each projection must compose against the inbox produced by earlier file results」）。

**pancode 落点**：`loadRules()`（现 `agent-llm.js:1723-1797`，P1 后已改名并拆成 `loadRulesParts`）已经有"就近覆盖 + 子目录 AGENTS.md 只在碰到时注入"的好直觉，但有四个洞：① 没有用户全局层（`~/.pancode/AGENTS.md`）；② ~~`files.list()` 全量扫描 + 每轮全量重读，没有 digest 缓存~~ **← 这条判断错了**：`buildAugmentParts` 实测每个任务只调一次（`agent-llm.js:2751`，在工具循环之前），不是每轮重读，所以 digest 缓存的收益不值"规则改了不生效"的风险，P1 里明确砍掉（见 §11）；③ 无字节上限（`MAX_TOTAL=12000` 是渲染上限，读取不设限，一个 50MB 的 AGENTS.md 会先被完整读进内存）——**并且更糟**：它作为第一个块会把渲染预算一次吃光，`assemble` 立即 `break`，导致这条规则和它后面的所有规则一起消失（实测见 §11）；④ 读失败与不存在不区分，都会"这轮没有这条规则"，导致规则文本在模型眼前闪断。

### 3.2 运行时状态不进 system 前缀

**竞品做法**：`packages/core/agent-loop/src/runtime-context.ts:114-163` `RuntimeContextProjection` —— 记住"surface 上最后一条 `source.kind==='runtime-context'` 的文本"，只在内容变化时造一条**新 user message 追加到尾部**；`current.length===0` 时写成「Current runtime context: none. Earlier runtime-context snapshots no longer apply.」（`:20`）；`:134-143` 监听事件，若该节点被压缩吞掉则置 null。贡献者：sandbox 模式、审批策略（`docs/subsystems/approval.zh.md:49`「两种策略都会把各自完整的当前含义贡献给**缓存安全**的运行时上下文快照」）、plan mode、persona、subagent 委托策略。

**pancode 落点**：`agent-llm.js:2232-2252`。当前是 `sysBlocks = [SYSTEM_PROMPT, aug(动态), smartCtx(动态), 模式约束(变), goal(变)]`。`aug` 里含 rules（随 touchedPaths 变）+ memory（随归纳变）+ plan（随进度变）+ skills（随匹配变）。**结论：第 2 块每轮都在变，后面全部白烧**。这是 pancode 单轮成本的最大可控项，改法见 §6.1。

### 3.3 记忆的"不该存什么"与"会过期"

**竞品做法**：ZCode 把记忆规则写进 system prompt（`context/sections/memory.ts:26-49`，一文件一事实 + YAML frontmatter `name/description/metadata.type` + `[[wikilink]]` + `MEMORY.md` 索引），并在 subagent 版补两段 pancode 完全没有的纪律。

`subagent/persistent-memory-prompt.ts:79-87` 负向清单：

> - Code patterns, conventions, architecture, file paths, or project structure — these can be derived by reading the current project state.
> - Git history, recent changes, or who-changed-what — `git log` / `git blame` are authoritative.
> - Debugging solutions or fix recipes — the fix is in the code; the commit message has the context.
> - Anything already documented in AGENTS.md files.
> - Ephemeral task details: in-progress work, temporary state, current conversation context.
>
> These exclusions apply even when the user explicitly asks to save. If they ask to save a PR list or activity summary, ask what was *surprising* or *non-obvious* about it — that is the part worth keeping.

`:116-132` 可信度衰减教育，pancode 最缺的一段：

> Memory records can become stale over time. Use memory as context for what was true at a given point in time. Before answering… verify that the memory is still correct and up-to-date… If a recalled memory conflicts with current information, **trust what you observe now** — and update or remove the stale memory rather than acting on it.
>
> A memory that names a specific function, file, or flag is a claim that it existed *when the memory was written*. It may have been renamed, removed, or never merged. Before recommending it: if it names a file path, check the file exists; if it names a function or flag, grep for it.
>
> **"The memory says X exists" is not the same as "X exists now."**

`:134-137` 记忆/计划/任务三分法（memory 只放跨会话有用的；对齐方案用 Plan；本会话进度用 Tasks）。`:35` 还有一条防止经典退化的：

> Record from failure **AND** success: if you only save corrections, you will avoid past mistakes but drift away from approaches the user has already validated, and may grow overly cautious.

防膨胀：`memory/index-content.ts:1-14` `MEMORY_INDEX_LINE_LIMIT = 200` / `MEMORY_INDEX_CHARACTER_LIMIT = 25_000`，超限**不静默截断**而是把警告写回模型可见文本（`:30-37`）：

> WARNING: MEMORY.md is ${lineCount} lines and ${formatBytes(charCount)}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.

截断按行截到 200 行，再按字符截到最后一个 `\n`，**不在行中间切**。

**pancode 落点**：`SYSTEM_PROMPT` 里的记忆相关只有 `:689` 一条「用 save_session_memory 把决策/教训/反例沉淀」+ `search_memory` 描述。把上面三段（负向清单、staleness、failure AND success）搬进 `agent-llm.js:671-702` 的【工作准则】。`memory-store.js:14` `MAX_ENTRIES = 200` 已有硬上限，但超限是静默挤出（`:31` 注释），改成 harness 式"写回警告给模型"。

### 3.4 记忆抽取：后台 agent + ROI 门 + 缓存复用

**竞品做法**：ZCode `memory/extraction.ts` + `runtime/helpers/project-memory-extraction.ts`。

六道前置门（顺序重要，`project-memory-extraction.ts:32-81`）：`shuttingDown` → `memory.extractionEnabled === false`（`:37` 注释：「必须在读取快照或访问文件前返回，避免后台副作用」）→ 项目记忆根 → **`isRemoteWorkspace()` 直接不抽** → 缺 store/port → 无 latestMessageId。`isMainMemoryTaskType`（`project-memory.ts:19-27`）只有 `undefined|interactive|fork|selection_side_chat|workflow_parent` 有记忆——**子 agent 与抽取任务自身没有记忆**（防递归）。

两个 ROI skip 判据（`extraction.ts:228-276`）：`MINIMUM_USER_WORDS = 3`——必须存在 `role==='user' && !synthetic && !model-only` 且 text 词数 ≥3 的非 tool-result 用户消息（**"用户只说了个 ok"就不花一次模型调用去抽记忆**）；`direct-memory-write`——扫描窗口内 assistant 若已有 Write/Edit 且 file_path 落在记忆根内，说明主 agent 自己写了，别再抽。

调度：单飞 + latest-wins coalesce（`:85-179`，`if (running) { latestPending = acquisition; return; }`）；cursor 语义——skip 决策也推进 cursor，**只有 error 不推进**（`:118`）。

抽取 agent 提示词原文（`extraction.ts:51-65`），三句高价值：

> You have a limited turn budget. Edit requires a prior Read of the same file, so the efficient strategy is: **turn 1 — issue all Read calls in parallel** for every file you might update; **turn 2 — issue all Write/Edit calls in parallel**. Do not interleave reads and writes across multiple turns.
>
> You MUST only use content from the last ~${messageCount} messages… **Do not waste any turns attempting to investigate or verify that content further** — no grepping source files, no reading code to confirm a pattern exists, no git commands.
>
> **Apply the memory types, what-not-to-save criteria, and frontmatter format from the Memory section of your system prompt — it is already in your context above.**

第三句是关键成本设计：抽取 agent **复用主 agent 的完整 system 前缀**，所以 `memory-agent-loop.ts:70-71` 有这条决策注释：

```ts
// Memory agent 的 provider request 必须保留 Main 的真实工具目录；执行权限只在 tool-use 边界收窄。
tools: input.tools as ModelToolContract[],
```

→ provider 请求里的 tools 与主 agent 逐字节相同，**prompt cache 命中**；收窄发生在 tool_use 分发时（`:121-163`）：`Agent`/`mcp__*`/`sideEffectScope==='network'` 拒；`Write`/`Edit` 仅当 `.md` + 路径安全；`Bash` 必须过**与主链同一个**只读分类器（`:144` 注释：「避免在此处二次收窄安全 env、redirect 和后台执行」）。删记忆文件的能力是**单独造的窄门**（`isContainedMarkdownBashRemoval` `:182-211`：argv[0]==="rm"、无 redirect/env、递归 flag 一律拒、glob 拒、非绝对拒、必须 `.md`、必须在 root 内），而不是给 Bash 开口子。

executor 构造三处细节（`project-memory-agent.ts:99-129`）：`permissionBroker: createDenyPermissionBroker()` + `getMode: () => "yolo"`（**模式绕过规则，但任何真需要 ask 的会被静默拒绝，而不是挂起等一个不在场的用户**）；`readFileState: new Map(context.readFileState)`（`:119-121` 注释：「Memory agent 必须继承 Main 已完成的 Read；否则 provider context 说文件已读，Edit 执行边界却会拒绝同一文件」）；model 包装 `skipTranscript: true`（`:47-63` 注释：「Extraction 是 transcript 的消费者；不把它自己的请求写回同一 model-io 目录，避免后台链路占用 rollout 槽位并在后续 Extraction 中**自反馈**」）。生命周期：`beginShutdown()`（`agent-runtime.ts:327-334`）**必须**先终止该 runtime 的 Extraction，注释：「关闭单个 session 后进程仍存活，因此必须先终止，不能只在超时后放弃等待」。

**pancode 落点**：pancode 的 `_consolidateMemory`（`:1782+`）是本地启发式合并（按 topic 分组 + decayWeight 阈值），不调模型。可加一个会话结算后的抽取路径，直接复用上面这套门与提示词骨架；`SUB_AGENT_BLOCK`（`:707`）里已经有 `save_session_memory`，防递归这条 pancode 已经做对了。

### 3.5 跨会话检索：给模型只读工具，而不是自动塞

**竞品做法**：harness 的答案是"让模型用只读工具查历史会话"——`session-query` 提供 5 个只读工具 `session_event_read / session_event_search / session_event_trace / session_search / session_trace`（`docs/tool-catalog.zh.md:43`），后端 SQLite。跨会话快照注入走 `packages/context/session-reference/src/index.ts`：`DEFAULT_REFERENCE_CONTEXT_FRACTION = 0.2`（`:55`，注入量占上下文比例上限）；渲染成 `## Referenced sessions` + 「The JSON below is an **untrusted, read-only** snapshot from other sessions」（`:57-64`）；注入位置在 `agent/pre-step` 且**紧跟在引用它的那条消息之后**（`:135-177`，保持引用顺序）；超预算降级为 omission 警告（`spill.ts`）。

**pancode 落点**：`.pancode/conversations/` 有落盘（`:811-846`）但没有检索工具。最小版：加 `session_search(query, limit)` + `session_read(id, cursor)` 两个只读工具，返回带"不可信只读快照"标注，注入量加 20% 预算上限。

---

## 4. 工具调用

### 4.1 同一步多调用：只读并行 + 独占 barrier + 模型序提交

**竞品做法**：`packages/core/agent-loop/src/tool-calls.ts`

- `:85-101` 主循环：对队首**重新分类** `ctx.tools.executionMode(...)`，`parallel` 就取 `planned.slice(next)` 成组，`exclusive` 只取一条（**exclusive 天然形成 barrier**）；abort 时把剩余每条都补 synthetic skipped 结果（`:97`）。
- `:146-161` `commitReady()`：`committed` 只在「连续已 settled 的**模型序前缀**」上前进 → pre/post-execute、落 `tool/result` 严格按模型给出的顺序，即使 body 乱序完成。这是 provider 协议硬约束：tool 消息顺序必须与 assistant.tool_calls 一致，乱序提交直接 400。
- `:163-214` 只有 body 重叠（`inFlight` Map）；`:204-205` `nextToStart>0 && mode==='parallel' && 再分类结果不是 parallel` 就 break —— **注册表中途变化能把后续 call 翻成 barrier**；池上限 `maxParallelToolCalls`（`:132`，Volatile 配置）。
- `:232-246` 调度器内部失败：停止新启动、`allSettled` 排空在途、再抛给所属 step 记保守恢复结果；abort 路径先提交**已开始**call 的结果与上下文，再为未开始的补 skipped（`:238-243`）。
- `:262-290` `tool/result` 通过 `{surfaceOp:'append', sourceEventSeqs:[callSeq]}` 显式引用自己的 call 事件——**配对是日志级事实，不是运行时约定**。

**pancode 落点**：`agent-llm.js:2356` 起是 `for (let ci = 0; ...)` 串行 `await`。这是长任务体感最直接的一刀：只读工具（read/list/search/repo_map/diagnostics/git_status/glob）并行，写类/命令类串行。元数据来源见 §5.1（需要给工具加 `concurrentSafe`）。改法保持 harness 的"分段 + 模型序提交"：结果先按 call 序占位，乱序完成只填槽位，入 `history` 严格按前缀推进。

### 4.2 参数容错与"错误再注入"通道结构化

**竞品做法**：

- harness `packages/core/tools/src/index.ts:104-111` `parseArguments()`：`JSON.parse` 失败**保留原始字符串**继续走（工具自己校验 schema），空串映射 `{}`。`:1441-1444` 参数必须 lossless JSON，`:1476-1480` catch 后转成 `isError` 结果**不抛给 loop**（模型收到可读错误）。`:1578-1587` 未知工具在 **dispatch 阶段**才报（注释 `:1400-1406`：真正未知的名字保留在 dispatch 报，以便 policy listener 仍能看到这个名字，观测完整性优先于早退）。
- **判决类型**：`:604-621` `PreToolDecision{deny{reason,info?}, cancel, ask{reason?,displayReason?}}` 与 `PostToolDecision{accept{content?|value?}, block{feedback}}`；`:1787-1794` `block` → `isError` 且 **content 就是纠正反馈**（这是"错误再注入"的正式通道）；`:1796-1798` `accept.content` 与 `accept.value` 互斥；`:1803-1806` **不允许把失败结果的 value 替换掉**。
- `:1832-1862` `createSuccessResult()`：`snapshotToolValue` → `validateJsonSchemaValue(tool.output.schema, ...)` → 违规抛 `ToolOutputError`（`:528-538` 文案 `tool "x" returned invalid output: a; b; c`）→ `output.render(args, value)` 生成模型可见 content。**canonical value 与模型文本投影分离。**
- `:1864-1883` 结果防伪：`WeakMap<result, token>` 判别结果是否本次 dispatch 认证，around-dispatch 包装器伪造的成功结果**会被重新按工具自己的 output 契约校验**。
- `:1885-1901` `materializeFinalResult()`：只有 `content/meta/additionalContexts/isError/error` 能持久，`value` 只在执行期存在（`:573-576` 注释「Execution-local canonical value; deliberately omitted from durable events」）。
- `:1919-1983` 取消语义两码：`ABORTED`（body 起过）与 `ABORTED_BEFORE_DISPATCH`（body 未起），`:1541-1557` 由 `bodyInvoked` 决定选哪个；`:1928-1955` `fuseToolSignals` 融合 caller 与 wrapper 两个 signal，dispatch 结束后 dispose 监听器。
- `:1694-1714` 观察者隔离：先 `Object.freeze(exec)`，逐个 callback try/catch + `Promise.resolve(...).catch(reportFailure)`，**监听器异常永远不会改变结果**。

**pancode 落点**：`:2360-2384` 参数解析失败与 schema 校验失败都做得不错（显式回灌原文前 500 字符 + 修正指引，且已避免静默成 `{}`）。缺的是**判决分类**：`:1373-1386` `_gate` 返回 `{blocked, approved, reason}`，最终在 `execTool` 里拼成中文塞进 tool 消息。结果就是模型分不清"用户说不"（应当换方案）与"工具坏了"（应当重试）。改法：`_runToolGuarded` 返回 `{kind:'ok'|'policy-deny'|'user-reject'|'timeout'|'error', text, retryable}`，`_wrapToolData` 把这个 kind 显式打进头部标记。harness `:1752-1766` 的四种 deny reason 文案可直接直译。

### 4.3 畸形 tool_call 的形状修复

**竞品做法**：ZCode 把校验放在模型侧与执行侧之间：`runtime/helpers/model-tool-call-validation.ts` + `tool/executor/validation.ts` + `input-validation-model-content.ts`（校验失败也有一段专门的模型可见文本）；`runtime/methods/streaming-tool-coordinator.ts` 处理流式增量 tool call 的部分到达。harness 侧则是 `_sanitizeToolCall` 的正式版：`tools/index.ts:1391-1395` 里 `rootCallId = exec.rootCallId ?? callId`，`:1904-1907` `token = Symbol(...)` **调用方无法伪造**；PTC 子调用 id `${parentCallId}:ptc:${n}`（`ptc.ts:545`）可从 id 反查归属且永不与模型 id 撞。

**pancode 落点**：`:58-73` `_sanitizeToolCall/_sanitizeHistory`（保留原始 id 以免破坏配对、空 arguments 兜底 `{}`、name 兜底 `unknown`）是好的，`:2335-2348` 的注释还记录了 SenseNova 网关严格校验的实战经验。补两点：入 `history` 的每个 tool 消息带上 `tool_call_id` 并在落盘时一并持久（现在落盘的是原始形状，够用但脆弱）；abort 时给"已开始但未完成"与"未开始"两类 call 分别补合成结果（配合 §1.3 的 repair）。

### 4.4 失败尝试只进日志，不进历史

**竞品做法**：`packages/core/agent-loop/src/agent.ts:444-490`。流式边收边 `live.push(chunk)`；失败/abort 时——abort 且有部分内容 → `append('assistant/message', {..., interrupted:true})`；否则 → `append('assistant/attempt', {turn, step, stream})`，**失败尝试只记原始流、不进 surface**（模型看不到半截回答，但日志可重放取证）。`:476-481` settlement 自身失败 → `AggregateError([error, settlementError])`，不吞。`:503-505` `finish.kind==='max-tokens'` → 返回 `{kind:'max-tokens'}`，goal 驱动器据此 disarm（`:329-331`）。

**pancode 落点**：`:2295-2326` 的重试里 `r` 被覆盖，`messages` 未污染，行为大致正确。但"输出被 max_tokens 截断"这件事 pancode 没有上报给 goal 续跑逻辑，应当像 harness 那样让 max-tokens 结束成为**disarm 信号**而不是继续下一轮。

---

## 5. 工具设计

### 5.1 把工具从"description 字符串"升级为"契约对象"

**竞品做法**：ZCode `apps/zcode-cli/packages/core/src/tool/types.ts`

`ToolMetadata`（`:68-97`）14 项：

| 字段 | 用途 |
|---|---|
| `name` / `description` | provider 可见 |
| `modelInstructions?: readonly string[]` | 模型侧补充指引（与 description 分通道） |
| `allowedInPlanMode` | Plan 模式可见性，**声明式**而非调用点判断 |
| `readOnly` / `destructive` / `concurrentSafe` | 并行分组与权限 |
| `requiresUserInteraction` | 交互类工具 |
| `timeoutMs` / `maxOutputBytes` | 预算 |
| `sideEffectScope`: `none\|workspace\|git\|network\|system` | AGENTS.md 明令：「权限系统、sandbox 和审批流程应**读取这些声明，不依赖调用点临时猜测**」 |
| `riskLevel` / `needsApproval` | 审批 |
| `providerVisible` | 别名/兼容工具不暴露给模型 |
| `stopTurnOnSuccess` | `:83-88` 注释：「终态工具一旦成功即挂 turnControl 终止 turn。这是工具的**内在能力声明**（像 concurrentSafe/destructive），由 executor 读取，而不是在调用点按工具名猜测」 |

`ToolEntry`（`:278-363`）的钩子链是重点，尤其 **`resolveInput` 的位置**（`:313-330`，注释就是设计文档）：

> 把模型发出的入参**归一化成将要发生的执行事实**。executor 在 `validateInput` 之后、PreToolUse hook 之前调用，返回值直接替换 `executionInput`。位置就是全部的意义。此后 hook、项目权限规则、权限事件载荷、`prepareApproval`、handler 读到的都是同一份归一化输入，于是三件事一次到位：1) 策略不被绕开——一条扫描脚本的 PreToolUse hook 在 saved run 上也能看到真正的脚本；2) 跨版本可见；**3) 确认与执行同字节——只解析一次，那份字节一路带到 handler，不存在批准 A 跑 B。**

其它钩子：`validateInput`、`resolveModelContract`（`:304-308`「当前 turn 模型能力对 provider descriptor 与 executor schema 的**同源投影**」）、`formatModelContent`、`resolveTimeoutBudgetMs`、`resolvePermissionCapability`、`resolvePermissionRulePolicy`、`prepareApproval`（`:347-357` 注释：「ask 的最后一次话语权，由工具持有。运行在权限服务已决定要问之后，所以**只能把 ask 收窄为 proceed 或补充预览，永远不能把 allow 变成 ask**；同步、不做 I/O——需要在批准前读世界的话， belongs in `resolveInput`」）。

harness 侧对偶：模型可见投影是**白名单**——`tools/index.ts:1281-1294` `schemaOf()` 只出 `{name, description, parameters, deferLoading?}`；`:259-266` `timeoutMs` 注释「**NEVER sent to the model**」；`:267-280` `isConcurrencySafe` 注释「This metadata is never model-visible」，且只有严格 `true` 算并行；`:281-298` `presentCall/presentResult` 注释「Pure and side-effect-free: a UI may call it during live streaming **AND a session-log replay**, so it must depend only on `args`」。

**pancode 落点**：`TOOLS` 数组（`agent-llm.js:90-660`）只有 `{name, description, parameters}`；行为元数据散在三个 Set：`MUTATING_TOOLS`（用于 `:2259` plan 裁工具、`:1196` 子锁）、`WAIT_FREE_TOOLS`（`:1967` 免超时）、`SUB_AGENT_BLOCK`（`:707`）。权限判定用 `_hookSubject`（`:1319-1327`）**从 args 里猜字段**（`args.command`/`args.path`/`args.message`/`args.name`）——这正是 ZCode 制度禁止的"调用点临时猜测"。

建议的收敛动作：把 TOOLS 每项扩成 `{name, description, parameters, modelInstructions, readOnly, concurrentSafe, destructive, sideEffectScope, needsApproval, allowedInPlanMode, allowedForSubagent, timeoutSec, maxOutputBytes, approvalSubject(args)}`。`_hookSubject` 从工具声明里取；`SUB_AGENT_BLOCK`/`MUTATING_TOOLS`/`WAIT_FREE_TOOLS` 三个集合全部退化为字段查询。**收益**：新增一个工具不用再改 5 个地方（漏改就是 bug），且 §4.1 的并行分组有元数据可用。这是本方案的结构性前置项。

顺带一条 ZCode 的细节值得学（`agent.ts:120-124`）：灰度关闭某能力时，**把指向它的 prompt bullet 一起删掉**，注释：「关闭时十个工具不注册，但这条 bullet 仍在 Agent 的 provider 描述里写着『CreateWorkflow 是强制的』，于是模型被指向一个根本不存在的工具，只会白白撞一次 tool_not_found」→ **工具可见性和指向它的提示词必须同源开关**。pancode 对应风险：`Ask` 模式 `baseTools = []`（`:2258`）但 `SYSTEM_PROMPT` 仍带全文，里面 `:680`「每次有意义的修改之后，必须用 run_command 运行测试」、`:684-685`「用 start_process / 优先用 git_status」等指引仍然在场。

### 5.2 输出上限：从"一个全局截断"到"每工具有独立契约 + 落 artifact"

**竞品做法（数值齐全，可直接对照）**

| 机制 | 数值与位置 |
|---|---|
| 默认结果预算 | ZCode `executor/result-serialization.ts:30-37`：`maxInlineBytes: 100_000`、`maxModelBytes: 100_000`、`strategy:"truncate"`、`preview.direction:"head"`；工具可用 `entry.resultBudget` 覆写 |
| Read | ZCode `contracts/src/tools/read.ts:16-17`：`READ_MAX_OUTPUT_TOKENS = 25_000`、`READ_DEFAULT_MAX_LINES = 2_000`；`read-text.ts:18` 部分读目标 = `floor(25000*0.85)`；超限文案给出**下一步的具体参数**（`:184-186`）：`Use Read with offset ${nextOffset} and limit ${READ_DEFAULT_MAX_LINES} to continue, or use a search tool` |
| Read(harness) | `fs/tool-fs/src/read-render.ts:11,14`：`READ_MAX_LINE_LENGTH = 2000`、`READ_MAX_BYTES = 50*1024`；`read.ts:109-113` 用 `truncatedByBytes = lines.length < input.limit && endLine < totalLines` **区分"被字节裁"与"读完"** |
| Grep | ZCode `handlers/grep.ts:23-24`：`MAX_GREP_MODEL_BYTES = 20_000`、`DEFAULT_GREP_TIMEOUT_MS = 30_000`；harness `grep.ts:29,35`：`GREP_MAX_MATCHES = 250`、`GREP_MAX_LINE_BYTES = 2000`（切字节保留 UTF-8 边界） |
| Glob | ZCode `glob.ts:20-21`：`MAX_GLOB_RESULTS = 100`、`MAX_GLOB_MODEL_BYTES = 100_000`；harness `glob.ts:25` 同名 100 + 超量可选**按顶层均匀采样**（`sampleOverCapGlobResults`，且是必填配置项——部署必须显式选择） |
| Bash | ZCode `bash.ts:70-71`：`MAX_INLINE_OUTPUT_BYTES = 30_000`、`MAX_RUNTIME_PERSISTED_OUTPUT_BYTES = 5GB` |
| 搜索原始输出 | harness `search-core.ts:36`：`RAW_OUTPUT_MAX_BYTES = 20_000_000`，超过 → `SEARCH_RAW_OUTPUT_OVERFLOW` **报错而非静默截断**；`:50` stderr 上限 64KB（`:47` 注释「a diagnostic excerpt only… never shown on success」）；`:65` `SEARCH_META_MAX_BYTES = 65_536` |
| TaskOutput | ZCode `task-output.ts:29-38`：`DEFAULT_LENGTH = 32_000`、`MAX_LENGTH = 160_000`、`PERSIST_THRESHOLD_CHARS = 100_000`、`RESULT_BUDGET_BYTES = 400_000`、`POLL_INTERVAL_MS = 100`；`truncateTaskOutput`（`:199-210`）**保留尾部**并把全文路径写在**最前面**：`[Truncated. Full output: ${outputPath}]`（日志尾部信息量大，但指针要在开头就能看见） |

统一裁剪库：harness `packages/util/output-retention/src/index.ts`。`:2-31` 模块注释划界：库只回答"留了什么、省了多少"，**文件分组、行号、退出码、provider 错误、每行预览裁剪、spill 文件、模型可见文本都归工具**；`:10-15` 关键语义约束：`truncated` 意为"因预算省略了本可得的内容"，**不是**"上游不完整"（混合语义会让模型把"权限被拒"当成"文件就这么长"）。两种 retainer：`ItemRetainer`（有序逻辑单元）、`TextRetainer`（字节流，`head|tail|headTail`，UTF-8 边界）。诚实性设计：`:403-417` `describeOmitted` 三态 `none|exact(n)|unknown`，`:405-407` 注释——**`unknown` 不印数字，因为「任何『Omitted N bytes』都会是谎言」**。

落盘信封（`result-persistence-format.ts:27-42`）：

```
<persisted-output>
Output too large (${formatBytes(originalBytes)}). Full output saved to: ${persistedPath}

Preview (first ${formatBytes(previewChars)}):
${preview}
...
</persisted-output>
```

`PERSISTED_OUTPUT_PREVIEW_CHARS = 2_000`；预览截断**优先在换行处收尾**（`:56-58`：`newlineIndex > maxChars*0.5 ? newlineIndex : maxChars`）。harness 的对偶是 `packages/spill/spill-policy/src/index.ts`：`maxInlineTokens` 未配即整体禁用（`:49-54`）；`:78-88` 图片在全文里转成可读指针 `[Image: <路径>; <mediaType>; WxH. Use read_image to view it.]`；`:111-114` 先按"全文字节 + 全部图片数"构造**最坏通知**并计价，剩下的才给预览；`:133-150` 挂在 `tools/post-execute` 且 `{prepend:true}`，**显式跳过 `read` 工具**（`:135`，read 自己有 offset/limit 语义，不该再被 spill 化）——即"裁剪策略必须有工具级豁免通道"。

空输出占位（`result-serialization.ts:58-62`）：

```ts
// Bash 空输出也需要通用占位，避免模型把静默成功误读成缺失工具结果。
const emptyContent = `(${entry.metadata.name} completed with no output)`;
```

**pancode 落点**：`_truncateToolResult`（`:1979-1993`）一个函数管所有工具，`MAX = 24000/8000/4000` 按水位分级，`head 0.75 + tail 0.25`，无指针、无 omitted 三态、无工具级差异、无豁免。**最大收益的一条**：加 `.pancode/spill/<convId>/<tool>-<callId>.txt` + `<persisted-output>` 信封，`read_file`/`apply_edit` 豁免。现在模型遇到长输出只能重跑命令。

### 5.3 分页参数：超限报错而不是静默夹

**竞品做法**：harness `fs/tool-fs/src/read.ts:55-60` —— `offset` 1-based 默认 1；`limit` 默认 = 配置上限；`limit > maxLimit` **直接报错**。理由：静默夹会让模型以为读全了。描述里把默认值写进文本（`:71-83`）：`offset: '1-based first line to return. Defaults to 1.'`、`limit: 'Maximum number of lines to return. Defaults to ${caps.limit}.'`，并显式对比 shell：「Use the read tool — **not shell commands like cat**」。

ZCode 的 `READ_PROVIDER_DESCRIPTION`（`read.ts:57-68`）多三条 pancode 该抄的：

> - Reading a directory, a missing file, or an empty file returns an error or system reminder rather than content.
> - **Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.**

`grep.ts:25` 的措辞也是范本：「Content search built on ripgrep. **Prefer this over `grep`/`rg` via Bash** — results integrate with the permission UI and file links.」

**pancode 落点**：`read_file`（`:102-109`）描述是「读取指定文件的**完整内容**」，无 offset/limit。这是长文件直接爆上下文的入口，也是 `:1990` 截断文案里那句"请分页查看"无法兑现的原因（工具本身没有分页参数）。

### 5.4 Edit 可靠性：8 级匹配阶梯 + read-state 契约

**竞品做法（这是 pancode 编辑成功率的天花板所在）**

ZCode `tool/edit-matchers.ts:1-69`，匹配策略按**由严到宽**阶梯尝试：

```
exact → quote_normalized → line_number_prefix_stripped → escape_normalized
     → unicode_escape_normalized → line_trimmed → indentation_flexible → block_anchor
```

- `BROAD_MATCHERS = {line_trimmed, indentation_flexible, block_anchor}`，`:62` **`replaceAll` 时跳过宽匹配**（宽匹配 + 全量替换是事故配方）；
- `BLOCK_ANCHOR_MIN_SIMILARITY = 0.8`；
- `line_number_prefix_stripped` 专治"模型把 `cat -n` 的行号前缀抄进 old_string"；
- `quote_normalized` + `preserveQuoteStyle`（`:82-105`）处理弯引号 `‘’“”`——匹配时归一化，写回时**保留文件原有的引号风格**；
- `:132-144` `toMatchResult`：候选值去重后 `length !== 1` → 返回 `ambiguous`（不是"取第一个"）；
- harness 侧对偶是 `escape_normalized` 用 `unescapeVisibleCharacters`，`:170-172` 注释「Unicode 转义回退允许 `\uXXXX` 匹配文件中的真实字符，这里直接返回文件中的真实片段，后续 replacement 会按真实片段写入」。

**read-state 契约**（`handlers/edit.ts:52-65,415-465`）：

```
- You must Read the file in this conversation before editing, or the call will fail.
- `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise.
  Strip the Read line prefix (line number + tab) before matching.
```

三条失败文案精确对应三种状态：`EDIT_NOT_READ_MESSAGE`（"File has not been read yet. Read it first before writing to it."）、`EDIT_STALE_MESSAGE`（"File has been modified since read, **either by the user or by a linter**. Read it again…"）、`NON_UNIQUE_OLD_STRING_MESSAGE`（"…Provide more surrounding context or set replace_all to true."）。判定细节：`isPartialView` 为真也拒编辑（`:429`）；`isStrictFullRead`（offset ≤1 且无 limit）且内容全等则豁免 stale（`:437-441`）；mtime 比较**归一到整数毫秒**再判前进，注释（`:449-451`）「亚毫秒级精度，只在当前文件的整数毫秒晚于 Read 记录或大小变化时判 stale，**减少误报**」；成功结果尾部加 `EDIT_FRESHNESS_SUFFIX`「(file state is current in your context — no need to Read it back)」。

配套的浪费调用拦截（`read.ts:55-56`）：

```ts
const FILE_UNCHANGED_STUB =
  "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.";
```

**pancode 落点**：`apply_edit`（`:126-145`）要求 old_string 逐字唯一，靠 `patch.js` 的 Aider 式块。要补的是：① 匹配失败时的**阶梯回退**（至少 4 级：exact / 弯引号归一 / 行号前缀剥离 / 逐行 trim），且**明确报告用了哪一级**（用了宽匹配就该警告）；② 与 §2.6 联动的 **read-state 表**（`Map<path,{content,readAt,isPartialView,mtimeMs}>`，`_loadConversations` 时恢复），让 Edit 的"未读先拒 / 已变更拒 / 部分读拒"三条成立——这也是压缩后能把"最近读过的文件"重注入的前提；③ `FILE_UNCHANGED_STUB` 这条零成本高收益的浪费调用拦截。

### 5.5 Bash/命令安全：从黑名单到"argv 级分类器"

**竞品做法**：harness 的 bash 描述是六句可核对的纪律（`shell/tool-bash/src/index.ts:90-98`）：每次全新 shell（`pass workdir instead of using cd`）/ 托管 `$DSH_*` 环境变量 / 长输出裁成 tail 且**全文保存路径会报告** / 删除或移动前先核对解析后的绝对路径、不要对未检查的计算路径执行 / 未 set 变量展开成空串所以用 `${VAR:?}` / 沙箱拒绝的固定文案 `[sandbox: file access denied under <mode> mode]` 且「a policy denial: **do not retry another way**」。

ZCode 更硬：`tool/handlers/bash-readonly-policy-*.ts` 一整族（`argv-direct`/`argv-flags`/`argv-git`/`argv-io`/`argv.ts`/`callbacks`/`commands`/`flags-file`/`flags-git`），把"这条命令是不是只读"做成**按 argv 逐位、按 flag 逐个**的分类器，而不是子串黑名单。分类器在主链与 memory agent 之间**复用同一个**（`memory-agent-loop.ts:144` 注释：「避免在此处二次收窄安全 env、redirect 和后台执行」）。

**pancode 落点**：`security.js` 是黑名单 + `_matchRule` 子串/正则（`agent-llm.js:1263-1274`）。`:1338` 的 W14 注释说明作者已经意识到"子串规则不够"。建议至少把 `run_command` 的判定升级为 argv 级（`string-argv` 手拆即可，无需依赖），并把"只读命令"集合显式化——它同时服务于 §3.4 的抽取 agent、§4.1 的并行分组、§7.4 的权限修复。

---

## 6. Token 降本

### 6.1 system 提示分三段 + cache breakpoint 打在最后一非 system 消息

**竞品做法**：ZCode `context/builder.ts`。

`ContextSection` 三轴（`types.ts:52-54,62-71`）：`injectionTarget ∈ {system, meta_user}`、`cacheHint ∈ {stable, dynamic}`，外加每段自带 `chars/tokens/preview`。

`orderSectionsForInjection`（`:310-325`）四段稳定顺序：**system-stable → system-dynamic → meta_user-stable → meta_user-dynamic**。

`assembleSystemMessages`（`:230-277`）产出**至多三条 system 消息**，每条都带 `cacheControl: {type:'ephemeral'}`：① `cli_prefix` 单独一条（短引导身份）；② `cacheHint==='stable'` 合并一条；③ `dynamic` 合并一条，且刻意前置 `\n\n`（`:270-271` 注释：「ZCode by design：Main Agent 的 dynamic system block 自带左边界，所有 provider 保持一致」——**字节层面的稳定性**）。

`build()` 里三条互斥路径（`:87-173`）：`customSystemPrompt` 整段替换（且**跳过默认体系与 systemContext**，`:125-127` 注释：否则用户提供 custom prompt 后仍会混入 Session Guidance/output style 等动态段）；`workflowActor` 走第三条路径（基座段 + 子代理契约 + persona 叠加，`:118-122`）；两者同在**大声失败**（`:93-97`）。`:100-105` 还有一条身份正确性考量：workflow 子代理不加 "You are ZCode, an interactive coding agent"，因为「对一个只对脚本说话、可能连读文件工具都没有的子代理是错的身份，且走在正确身份段前面」。

`buildContextMetaUserBody`（`:327-336`）的固定包装值得抄：

```
As you answer the user's questions, you can use the following context:
${内容}

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
```

cache breakpoint：`provider-request-messages.ts:292-314` `finalizeLatestNonSystemMessageCacheControl` —— 先 `clearNonSystemMessageCacheControl` 清掉所有非 system 消息上的残留，再把 breakpoint 打在**最后一条非 system 消息**；`skipCacheWrite` 时前移一位（`:301-305` 注释：「但不作为 cache write breakpoint，marker 应前移到 compact prompt 前的真实上下文」）。

turn-loop 里的顺序保障（`turn-loop.ts:120-172`）：**reminder 注入在 provider projection 之前**，所以 `applyCacheControl:true` 是在最终历史上算的；`:170-171` 注释「provider-visible user ordering projection 会改变最终 latest user 落点，cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点」；`outputTokenRecoveryActive`（输出截断续写）时**跳过所有 reminder 注入**（`:120,126,139`），因为重注入会让 provider 可见前缀字节变化，打断命中且造成重复。

MCS（mid-conversation system，`provider-mid-conversation-system.ts`）：哪些内容走"中途 system 消息"而不是塞 system——由 `system-reminder/source.ts` 的 `isMidConversationSystemSource(source)` 决定；`:59-72` 只有当锚点是 `tool` 或 `user` 时才落成 system 块；`:143-162` 位置非法就**降级**为 `<system-reminder>` 包裹的 user 消息（注释：「降级必须自行转义，不能假设 producer 已处理」）；`:112-117` pending reminder 要等到 assistant 或系统边界再落点，「避免插入同一组 tool results 中间导致 provider-visible 顺序非法」。

reminder 冒泡（`provider-request-messages.ts:106-178`）：`reorderAttachmentLikeEntries` **从尾向前**扫，把 attachment-like 条目攒起来，遇到"呈现的用户输入"或气泡停止点（system/assistant/tool/tool-result-user）就整体前移——效果是"所有系统注入统一紧贴最新真实用户消息之前"，历史中段因此稳定。两类**不冒泡**：`NON_BUBBLING_ATTACHMENT_SOURCES = {goal_state_change}`（`:43-46` 注释：「State changes must keep their causal position relative to older target continuations」）与 `channel === "history_continuity"`（压缩后重注入的读文件状态，`:148,166`——位置必须稳定，否则压缩刚重建的历史会被挪动）。

**pancode 落点**：`agent-llm.js:2232-2252`。当前问题不是"没有分段"，而是**分段顺序把动态段放在了中段**，导致每次变都废掉后续所有前缀。三步改：① `aug` 内部按 stable/dynamic 二分（规则原文+技能清单=stable 只要 digest 不变；记忆 top+计划进度+goal=dynamic）；② 把 goal/plan/mode/进度这类"每轮都可能变"的状态从 system 移到尾部一条 `[运行时状态]` user 快照（抄 `runtime-context.ts:114-163`，只在变化时追加新的一条 + 写"更早的快照不再适用"）；③ 若上游是 Anthropic 协议则打 `cache_control`，DeepSeek 类自动前缀缓存则只需保证前缀字节稳定。

### 6.2 中文 token 权重（同 §2.8，单列为降本项）

`_estTokens` 对中文低估 2~4 倍 → 压缩触发晚 → 每轮真实付费输入比 pancode 以为的大得多，且最终由上游 400 而不是 pancode 自己收尾。改 `context/utils.ts` 式权重一行代码，是所有改动里成本最低的一条。

### 6.3 Progressive disclosure：技能/记忆的元数据常驻，正文按需

**竞品做法**：ZCode `context/sections/skills.ts` 只注入 `skills_listing`（meta_user 目标，`:175-187` 且**只在 Skill 工具真的注册时才注入**——`skillToolAvailable()` `:225-228` 判据来自 `guidanceToolNames`，注释 `:176-178`：「一个 Skill 工具未注册的工作流子代理被告知『以下技能可经 Skill 工具使用』，只会让它相信自己有一个没有的工具」）；`skillMetadataBudget` 控制清单预算；正文由 `handlers/skill.ts`（`MAX_SKILL_BYTES = 100_000`）按需读；`agent/loaded-skills.ts` 从 provider 可见历史判断"本会话是否已加载过某技能"，`types.ts:259-264` 的 `hasLoadedSkill` 探针注释关键：「由 runtime 用 provider 可见历史回答，所以 **compaction 之后答案随历史一起变回否**」。

harness 的对偶是 `deferLoading?: true`（`tools/schema.ts:499-500`，`defineTool` 透传，且 `schemaOf` 会把它带给 provider）——工具 schema 延迟加载。

**pancode 落点**：~~`buildSystemAugment` 每轮把匹配到的 3 个 skill 的 body 全文塞进 system~~
**这条判断错了，实测后撤回。** pancode 在两个 store 里早就做对了渐进披露：
`skill-store.js:403-413` 的 `formatForContext` 只输出 `- 名称 v版本：描述(≤160字)（触发词：…）`，
末尾还显式写「上面只是技能目录。决定采用其中某个时，先调用 `use_skill(name)` 取回完整步骤」；
`memory-store.js:283-297` 只注入 top-10 × 每条 160 字摘录（带强度/类型/年龄），全文靠 `search_memory`。
`test/p1-prompt-assembly.test.js` 里用**真实 store** 量过并钉成断言：50 条各 5000 字的记忆注入 ≤3020 字符、
1 万字正文的技能目录 <900 字符且不含正文前 60 字、8 个长技能同时命中目录 <1200 字符。
所以 P1-#10 无需改动，只需把"有界"这件事从实现细节升级成被测试守住的契约。
竞品里仍值得借鉴的一点：ZCode `loaded-skills.ts` 用 **provider 可见历史**判断"本会话是否已加载过某技能"，
compaction 之后答案随历史一起变——pancode 目录里没有这个状态，同一会话里已经 `use_skill` 取回过的技能，
下一个任务仍会再提示"先调用 use_skill 取回"（多一次往返，不影响正确性）。

### 6.4 其他降本点

- webfetch 缓存：ZCode `handlers/webfetch-cache.ts:8` `const fetchCache = new Map<string, CacheEntry>()`（同 URL 复用）。pancode `web_fetch` 无缓存。
- 子智能体只回结论 + 成本账单：ZCode `handlers/agent.ts:130-172` `formatModelContent` 压成"正文 + agentId + `<usage>subagent_tokens/tool_uses/duration_ms</usage>`"，父代理**看不到子代理 transcript**。pancode `runSubAgent` 返回 `finalText` 且子代理的中间过程不进父历史（这点已经是省的），但缺 usage 归集。
- harness `docs/subsystems/token-meter.zh.md` 的 `TokenMeasurement`：`baseline.kind==='usage'|'estimated'` + 有符号 `surfaceDeltaTokens` + 逐节点 `nodes[]`。`region.ts:376-382` 说明"双价"协议：摘要定价用固定启发式（O(1) 折叠与自 append 保持 agreement），而 retention/选区/shrink 比较都读**路由价**。pancode 只用一套估算，长期看会出现"摘要说省了但实际更长"——`§2.4 shrink 检查`必须先补。

---

## 7. 架构稳定性 + P0 缺陷

### 7.1 P0 缺陷（读码即得，建议立即修）

**① 全自动模式下 `delete_file` 不弹确认**（与代码注释意图相反）

`agent-llm.js:1338-1354`。`:1338` 注释写的是：

```js
// W14：删除文件不可逆——即使 auto 全自动模式、即使命中 allow 也强制人工确认
const irreversible = toolName === "delete_file";
const allowHit = irreversible ? null : this._matchPermRule(toolName, subject, perm.allow);
if (allowHit) return { action: "allow", ... };
if (!irreversible && this._sessionGrants && this._sessionGrants.has(toolName)) { ... }
...
if (mode === "auto") return { action: "allow" };   // ← delete_file 在这里被放行
```

前两道 `allow` 出口对 `irreversible` 关闭了，但函数末尾 `mode === "auto"` 没有同样的守卫，`delete_file` 走到 `:1354` 直接返回 allow。`permissions.mode === "auto"` 时删除文件**不落任何人工确认**。修法：`:1354` 之前加 `if (irreversible) return { action: "ask", reason: "删除不可逆" };`。这正是 ZCode 的写法——`permission/service.ts:130` 注释「声明 alwaysAsk 的工具必须经过用户确认，**不能被权限模式的放行分支绕过**」。

**② 自动压缩可能拆散 `tool_calls` / `tool` 配对**

`compactHistory`（`:1740-1743`）按**条数**切：`recent = history.slice(len-10)`、`head = slice(0, len-10)`，`head` 里保留 `criticalKept`。若切点落在"assistant 带 N 个 tool_calls"与其后 N 条 tool 消息之间，`criticalKept` 里可能留下一条 `role:'tool'` 而它的 `assistant.tool_calls` 被摘要吞掉；`_aggressiveTrim`（`:2068-2072`）逐条 `splice` 同样有此风险。OpenAI 兼容网关对不成对的 tool_call_id 直接 400。修法：选区边界对齐到"assistant 起始组"（§2.2）。

**③ 会话恢复不做 tool_call 配对修复**

`_loadConversations`（`:811-846`）只 `_sanitizeHistory`（`:66-73`，修 name/arguments 形状）。若进程在"已 push assistant.tool_calls、尚未 push tool 结果"时退出（典型场景：工具卡在人工确认，`approvalSec` 默认 1200 秒 —— `config.js:57`；用户此时刷新/重启），`flushConversations`（`:892-913`）会把带 dangling 的历史落盘，恢复后第一次请求即 400。**该结论由代码路径推得，修复前建议先写一条复现用例实测**（本项目的验收惯例是探针实测，不是读码即信）。修法见 §1.3。

**④ Ask 模式下 prompt 与工具集不自洽**

`:2258` `asking → baseTools = []`，但 `SYSTEM_PROMPT`（`:671-702`）仍完整在场，其中 `:680`「每次有意义的修改之后，必须用 run_command 运行测试」、`:684`「需要 dev server 时用 start_process」、`:686`「先用 create_plan 拆解」全部指向不存在的工具。`Ask` 模式另有 `:2239` 一条"严禁调用任何工具"对冲，但冲突提示仍在花钱。修法：按 `allowedInPlanMode`/只读性给 TOOLS 打标签，提示词与工具集**同源生成**（ZCode `agent.ts:120-124` 的教训）。

### 7.2 制度性约束（把工程纪律写进 AGENTS.md）

ZCode `apps/zcode-cli/AGENTS.md` 三条硬约束，且在代码里可验证地被遵守：

1. **单个源文件默认不超过 400 行；超过时必须优先按高内聚低耦合拆分模块**。实际效果：`tool/executor/permission-rules-persistence.ts:1-3` 留着拆分注释「拆分原因：permission-flow.ts 引入 responder 竞速后超过单文件 400 行上限」。我抽查的文件里最大 431 行。
2. **长程任务优先，不用 tool call 次数做硬停止**（见 §0、§1.2）。
3. **大体积 tool 结果不应直接回灌模型上下文；应落盘或进入 artifact/storage，只返回摘要、预览和可追踪引用** + **tool 的副作用范围应显式声明，权限系统/sandbox/审批读取这些声明，不依赖调用点临时猜测**（见 §5.1、§5.2）。

另有两条注释规范值得直接搬：**「bugfix 之后写下 bug 的原因在注释里」**、**「常量应提取为命名变量，不要在业务逻辑中散落字面量」**。这两条的实际产出就是我上面引用的一大堆"根因注释"——它们让这套系统可以被第二个人接手。

**pancode 落点**：`server/agent-llm.js` 2563 行、`server/index.js` 2156 行。**这不是洁癖问题，而是执行障碍**——§2 里任何一条压缩改动都要在 2500 行文件里做外科手术，而压缩恰恰是最需要反复调参的部分。建议按 harness 的包边界做一次拆分：`agent/loop.js`（主循环）、`agent/compact.js`（预算+microcompact+摘要+重建）、`agent/tools.js`（契约表 + execTool 分派）、`agent/permissions.js`（决策链）、`agent/subagent.js`、`agent/prompt.js`（三段装配）。拆分本身不改行为，用现有 `scripts/verify-*.js` 与 `test:unit` 290 项守住。

### 7.3 持久化的两条纪律（不抄全套事件溯源）

harness 用全事件溯源 + `session-format-v{n}-to-v{n+1}` 每版本一个包 + `docs/persistence-changes/` schema 快照。pancode 是 JSON 快照 + 防抖 + TTL + `safeWrite`。**不建议抄全套**，成本远超收益。但两条可立即落地：

- **写意图 → 提交 两阶段**：`compaction` 的 `start` marker 当锁。harness `region.ts:210` 先落 `compaction/start` **再异步摘要**，注释 `:159-163`：「the durable opening marker is the compaction lock before summarization yields」；`:308-320` 用"最后一条 start 是否被 end 匹配"判定锁；`:322-334` 异步决策后**重查锁**。ZCode 的对偶是 `compact-persistence.ts:289-382`（summary + part + N 条 reminder 任一步失败就把已写的全删）+ `:200-279` `recoverInterruptedCompactTimelines`（resume 时把 `Started|Retrying` 收敛成 `Completed` 或 `Interrupted`），注释 `:284-286`：「进程在 retry 间隔退出时，resume 必须把它和 started 一样收敛」。pancode 的 `compactHistory` 完全在内存里做（`:1727-1776`），崩在中间会留下"部分压缩"。
- **三可见性轴**：`compact-persistence.ts:324-330` 每条消息带 `semantics: {origin, kind:"compact_summary", uiVisibility:"hidden", providerVisibility:"visible", transcriptVisibility:"hidden"}`，reminder 再带 `visibility:"model-only"`（`:418`）。pancode 的 `[历史摘要]` 走 `role:'system'` 且会在 UI 里出现（`:1756` + emit `context.compact`），模型/UI/存档三种可见性混在一起。

### 7.4 错误分类与重试预算

**竞品做法**：`CoreError` + 显式 `retryable`；`retryable:false` 的关键用途是**阻止嵌套自缩放**（`compact-active-helpers.ts:37-39`）。重试状态本身要持久化：`packages/llm/llm-retry/src/index.ts:125-138` 注册投影 `key:'llmRetry'`，`step/start` 或 `turn/end` 重置；`:149-192` **先 append `llm/retry` 再 sleep**，醒来才 append `llm/retry-started`（模块注释 `:3-4`：「Each scheduled retry is durable before its cancellable wait」）；`:215-241` 尊重 `providerRetryAfterMs`，超 `maxDelayMs` 时 normal 模式放弃、always 模式退回本地指数退避（`:57-62` 带 jitter）；`:243-258` listener 先检查 `lifetime.signal.aborted`，防止 waterfall 捕获的过期 `next()` 在插件销毁后再进入下游。

**pancode 落点**：`:2293-2327` 的重试用 `attempt<3` + `Math.pow(2,attempt)*5`，上下文超限判断用正则 `/4\d\d/` 且 `/context|token|length|exceed|maximum|.../i`（`:2309-2310`）——脆弱（依赖错误文本措辞），且压缩重试 `continue` 会消耗 `attempt` 预算，两条路径的预算关系没有声明。改：把 LLM 错误在 `llm.js` 里分类成 `{code, retryable, contextOverflow, providerRetryAfterMs}` 再交给循环；显式规定"压缩重试不占用传输重试预算，但压缩重试自身上限 3 且不可与外层相乘"。

### 7.5 权限建议与会话免确认的时序

ZCode `permission/` 一条链的完整顺序（`service.ts` + `executor/permission-flow.ts`）：

`alwaysAsk 兜底（不被模式放行绕过，:130）` → `plan 分支（plan 模式必须继续拦下一切写入，草稿也是写入，:198-201）` → `deny 阻断` → `ask 阻断` → **会话免确认**（`:363-364`：「阻断分支之后、ask 之前。命中即放行，不发 permission 事件、不弹窗；与 gate 本身一样**不看模式**（yolo/plan/build 一致）」）→ **修订免确认**（`:373-377`：「事实来自 `resolveInput` 回填的 `predecessor`（journal 的 `parent_session_id`/`stopReason`），**不是内存表**：重启、冷恢复后依然成立，也没有可播种、可撤销的东西。别的会话的 run、用户停过的 run 照常 ask：钥匙是 run 的归属，不是字段的在场」）→ `项目 allow 规则` → `mode`。

配套：`permission-suggestions.ts` 把"以后都允许"的选项由工具自己生成（`ToolPermissionRulePolicy.suggestedPermissionUpdates`，`types.ts:369-375`）；`permission-input-recheck.ts` 在用户批准**之后、执行之前**再校验一次输入（防 TOCTOU）；`permission-responder-race.ts` 处理多端同时应答；`permission-rules-persistence.ts` 独立成文件。

**pancode 落点**：`_approvalDecision`（`:1330-1357`）顺序是 `deny → (irreversible 跳过 allow) → allow → sessionGrants → 只读白名单 → mode`。要改三处：① 修 §7.1① 的 auto 兜底；② `sessionGrants` 从内存 Set（`:1366-1371`）改成落盘的会话事实，重启后仍然成立；③ 只读工具白名单在 `:1347-1352` 硬编码了 11 个名字，应由 §5.1 的 `readOnly` 字段派生（新增只读工具时忘记加进这里 = 每次都要人工确认，属于静默劣化）。

---

## 8. 分期路线

判据：**先让 pancode 不再 400 和不再误删，再降成本，再提能力**。

### P0 — 正确性与安全（1~2 天，改动全部 <200 行）

| # | 改动 | 位置 | 验收 |
|---|---|---|---|
| 1 | `delete_file` 在 auto 模式强制 ask | `agent-llm.js:1354` 前加守卫 | 新增 `scripts/verify-perm-auto-delete.js`：`mode=auto` 下派 `delete_file`，断言 emit 了 `tool.pending` 且未落盘 |
| 2 | 压缩选区对齐 tool_call 组 | `:1740-1743`、`:2068-2072` | 单元：构造"并行 3 call"历史，压缩后断言每个 `assistant.tool_calls` 的每个 id 都能在 history 里找到同 id 的 `role:'tool'` |
| 3 | 加载会话时修复 dangling tool_calls | 新增 `_repairToolPairing`，`_loadConversations` 调用 | 探针：写死一份含 dangling 的 `.pancode/conversations/*.json`，启动后断言请求体合法且模型收到"结果未知"文案 |
| 4 | 中文 token 权重 ×2 | `_estTokens` `:1676-1689` | 对照真实 `prompt_tokens`：一段 500 字中文，估算误差从 ~4x 收敛到 ~1.2x |
| 5 | shrink 检查：摘要没变小就不替换 | `:1760` 后 | 单测：喂一个"摘要返回超长文本"的假 chatStream，断言 history 原样返回 |

### P1 — 降本与提速（3~5 天）

| # | 改动 | 位置 |
|---|---|---|
| 6 | system 三段装配（stable/dynamic 排序 + 状态移到尾部快照） | `buildAugmentParts` / `_runtimeContext` —— ✅ 见 §11 |
| 7 | microcompact（不调模型的廉价通道，先清旧工具结果，savings<256 回滚） | `microcompactHistory` —— ✅ |
| 8 | 阈值算术重写 `min(0.8W, W-maxTokens-headroom)` + retainTokens 按 token | `_compactSpec` —— ✅ |
| 9 | 工具结果落 `<persisted-output>` artifact + 按水位分级预览 | `_boundToolResult` / `_spillToolResult` —— ✅ |
| 10 | 技能/记忆 progressive disclosure（aug 只放清单 + `read_skill`） | 实测 pancode 早已如此，改动取消；改为用真实 store 把"有界"钉成断言（§6.3、§11）—— ✅ |
| 11 | ~~规则 digest 增量对账~~（实测每任务只调一次，砍掉）+ 用户全局层 + 读取字节上限 + stable/conditional 分桶 | `loadRulesParts` —— ✅ 2026-10-03 |
| 12 | 只读工具并行 + 模型序提交 | 主循环段调度 —— ✅ 见 §11 |

### P2 — 能力代际（1~2 周，依赖 P1 的字段化前置）

| # | 改动 | 位置 |
|---|---|---|
| 13 | 工具契约字段化：**已落地 8 项**（`readOnly`/`stateful`/`mutating`/`irreversible`/`microcompact`/`waitFree`/`subAgentBlock`/`readOnlyWhen`），6 处手工名单退化为派生集合；`sideEffectScope` 与 `resolveInput` 未做（见 §12"已知偏差"） | `server/tools/contract.js`（新）+ `agent-llm.js` 消费点 |
| 14 | `agent-llm.js` 按 §7.2 拆 6 个模块 | — |
| 15 | 摘要九段模板 + 四段重建 + post-reminders（最近读文件重注入 + 计划文件续跑） | `agent/compact.js` |
| 16 | 四层降级阶梯 + 两个断路器 + 压缩终态五分类 | `agent/compact.js` |
| 17 | Goal 状态机（revision/phase/armed 不持久 + 先 flush + blocked≥3 轮） | `agent-llm.js:1255-1259,2529-2552` |
| 18 | Edit 8 级匹配阶梯 + read-state 契约 + `FILE_UNCHANGED_STUB` | `patch.js`、`file-tools.js` |
| 19 | 记忆抽取后台 agent（ROI 门 + latest-wins coalesce + 复用主前缀 + deny-by-default） | 新增 `memory-extraction.js` |
| 20 | 提示词补"不该存什么 / 记忆会过期 / 记录成功确认"三段纪律 | `SYSTEM_PROMPT` |
| 21 | `session_search`/`session_read` 只读跨会话检索 + 20% 注入预算 | `tools/` |
| 22 | 上下文用量七类目仪表盘 + 不确定性自我声明 | `context-usage` + 前端进度条 |

### 明确不建议抄的（防止过度工程）

- **全套事件溯源 + 每版本迁移包**（harness `session-format-v0-to-v4` + 1.4MB schema 快照）。pancode 的多用户/多工作区规模不需要，代价是重写整个存储层。只抄 §7.3 的两条纪律。
- **PTC（programmatic tool calling，模型写代码调工具）**。设计漂亮（一次往返替代 N 次，`tools/src/ptc.ts`），但要求 provider 支持受控代码运行时 + 一整套 SDK 目录注入（`extensions/tool-cordis/src/api-catalog.ts` 573KB 就是生成的 API 目录），pancode 要服务任意 OpenAI 兼容后端，性价比在 P2 之后再评估。
- **Cordis 插件框架 / waterfall hook 体系**。pancode 是单进程本地应用，`_runToolGuarded` 一层足够；引入 hook 总线只会让 2500 行变 5000 行。§5.1 的"字段化契约"已覆盖 80% 收益。
- **`ralph` 的 256 轮预算与独立 provider 强制**（`requireFreshProvider` 要求 `capabilities.outputSchema===true`）。pancode 面对 heterogeneous gateway，多数不支持 structured output。
- **Ebbinghaus 衰减**别删——这是 pancode 领先两个竞品的部分。

---

## 9. 一句话总结

pancode 与这两家的差距不在"有没有 plan mode / MCP / 多智能体 / 记忆"，pancode 全都有；差距在**每一处边界是否被当作事实来对待**：续跑权限是否持久、压缩边界是否配对、摘要是否真的更小、批准的是不是执行的那一份、删除是否绕过模式。把 P0 那五条修掉，pancode 就从"功能齐全但会在长任务里 400"进到"可以无人值守跑 40 轮"——后者才是这两个 harness 真正的护城河。

---

## 10. P0 落地记录（2026-10-02）

**验收口径**：`test:unit` 322 项（基线 290 + 新增 32）+ `test:verify` 11 个真实探针（原 10 + 新增 `_verify_ctxpair.js`），全绿。

| 项 | 改动 | 落点 |
|---|---|---|
| P0-4 | `_estTokens` 对 CJK 按 2 个估算字符计（新增 `estTextTokens`） | `server/agent-llm.js` |
| P0-2 | 压缩选区改「按 token 预算保留完整轮次组」（新增 `groupHistoryByToolPairing` / `_selectRetainByTokens`）；`_aggressiveTrim` 改整组丢弃 | `compactHistory` / `_aggressiveTrim` |
| P0-5 | shrink 检查：`after >= before` 同口径估算时放弃替换并 emit 诊断 | `compactHistory` |
| P0-1 | 不可逆工具在 `mode` 放行分支之前强制 ask | `_approvalDecision` |
| P0-3 | 新增 `repairToolPairing`，`_loadConversations` 时为 dangling call 补保守结果、丢弃孤儿结果 | 模块级 + `_loadConversations` |

### 缺陷 ② 的反向对照（这条不是推测，是实测）

`compactHistory` 的旧 `isCritical` 会命中「已写入」等关键词、把 `role:"tool"` 结果单独留下，但**永远带不回它对应的 `assistant.tool_calls`**（`isCritical` 对 assistant 恒为 false）——所以每一次命中都在生产一枚必然不成对的孤儿消息。

验证方法：临时把旧 `isCritical` 还原，跑 `scripts/_verify_ctxpair.js`（它校验的是真正出网的 `messages`，不是内部 history 数组），实测报：

```
FAIL:
 - 第 4 次请求体配对非法：孤儿 tool 结果 call_r1b；结果没有对应的进行中请求：call_r1b
 - 第 5 次请求体配对非法：… 孤儿 tool 结果 call_r2b …
```

撤销临时还原后同一探针 PASS（6 次出网请求体、中途压缩 2 次全部合法）。
探针里工具输出刻意含「已写入」——**去掉它探针就失去牙齿**，这个耦合关系写在探针注释里了，改动模拟数据时注意。

### 修的过程中新发现的两个缺口（已写进测试，归入 P1）

1. **只读工具白名单是硬编码的 11 个名字**（`_approvalDecision`），`repo_map` / `search_symbol` / `get_diagnostics` / `search_memory` 这些纯读工具不在其中 → 每轮都弹一次人工确认。`test/p0-harness-fixes.test.js` 里有一条**断言现状**的用例并标了注释，P1 把白名单换成 `readOnly` 字段派生时应改为断言 `allow`。
2. **中文 token 低估会让所有下游阈值一起失真**：`_truncateToolResult` 的水位分级（4000/8000/24000）读的就是 `_estTokens`，修完权重后截断会比以前更早收紧。P1-#8 重写预算算术时要一起看。

### 未做（按设计留给 P1/P2，不是遗漏）

- 阈值算术重写（`min(0.8W, W-maxTokens-headroom)`）= P1-#8；本次只换了保留量口径（固定 10 条 → `budget × 0.16` 的完整组）。
- 摘要九段模板 / post-reminders / 四层降级阶梯 / 两个断路器 = P1-#7、P2-#15、#16。
- 运行时 abort 留下半批 tool_calls 的修复（本次只覆盖**加载存档**这条路径）。
- 只读工具并行执行 = P1-#12，依赖 P2-#13 的 `concurrentSafe` 字段化。

---

## 11. P1 落地记录（2026-10-03）

**验收口径**：`test:unit` **376 项 / 16 文件**全绿（基线 290 → P0 后 322 → P1 后 376；本次新增 4 个文件共 86 项：`p0-harness-fixes` 34、`p1-compact-budget` 23、`p1-spill` 12、`p1-prompt-assembly` 17）。`test:verify` **13 个真实探针**全绿（新增 `_verify_parallel.js`、`_verify_promptctx.js`）。内核 `server/agent-llm.js` 累计 **+588 / −136**。

| 项 | 改动 | 落点 |
|---|---|---|
| P1-#8 | 阈值算术重写：`messageBudget = window − reservedCompletion`、`pressureBudget = messageBudget − headroom`、`threshold = min(0.8·cap, pressureBudget)`、`retain = 0.16·messageBudget`；`llm.maxOutputTokens` 成为本地预留量（窗口是输入+输出**共享**的） | `_compactSpec()` / `server/config.js` |
| P1-#7 | microcompact（**不调模型**的通道）：清掉过期的只读工具结果，保留最近 5 **轮**；省不足 256 token 就整体回滚；幂等；保护错误结果与多模态结果 | `microcompactHistory` / `compactHistory` 两层 |
| P1-#9 | 超长工具结果收口：头尾保留 + 全文落盘 `<数据根>/.pancode/spill/<会话>/`，`<persisted-output>` 信封里报**精确省略字符数**与取回方式；按上下文水位（60%/80%）分三档收紧预览；单会话 60 个文件封顶；目录不可写时降级为"只给预览且如实说明" | `_boundToolResult` / `_spillToolResult` / `_pruneSpill` |
| P1-#12 | 同一步多个 tool_call：连续只读段 `Promise.all` 并行、写类/命令类独占屏障、结果**恒按模型声明序**回填；中断时把剩余槽位全部填上结果 | 主循环重构 + `_isConcurrentSafe` / `_execToolIntoSlot` |
| P1-#6 | system 按**变化频率**分桶（identity → stable → turn），运行态（会话目标 / 计划实时进度 / 模式约束）移出前缀，改为每轮重算后发到历史末尾一条 `user` 消息，并声明"与更早快照冲突以本条为准" | `buildAugmentParts` / `_runtimeContext` / `rebuildMessages` |
| P0 遗留缺口 1 | `_approvalDecision` 的只读白名单从硬编码 11 个名字换成 18 项 `READONLY_TOOLS`（补 `repo_map`/`search_symbol`/`get_diagnostics`/`search_memory`…）；`read_process` 因带游标单独排除在并行之外 | `_approvalDecision` |

> **这条改动扩大了自动放行面**：上述纯读工具在 ask 模式下不再逐个弹确认。判据是"不写盘、不执行命令、不碰外部服务"，但它是**放行策略**而非显示策略，值得复核。

### 实测抓到的两个自伤缺陷（不是推测）

**① `CONV_MAX_MSGS` 被上一行的行尾注释吞掉** —— 我在 P0 编辑常量区时把两条声明并成了一行：

```js
const CONV_MAX = 20;   // 最多保留 20 个对话（与内存 LRU 上限一致）const CONV_MAX_MSGS = 80;  // ← 整条被注释吃掉
```

后果是每次会话落盘都抛 `ReferenceError`，而 `flushConversations`/`_persistConversations` 的 `try/catch` 把它压成一句 `console.warn` —— 表现是**会话存档静默不再更新**，界面看不出任何异常。`git show HEAD:server/agent-llm.js` 可确认这两行在 HEAD 里本来是分开的，所以这是本次优化引入的回归，不是产品既有缺陷。

发现路径不是读代码，是新探针 `_verify_promptctx.js` 跑起来往 stdout 里吐了 `[pancode] 会话上下文落盘失败: CONV_MAX_MSGS is not defined`。
反向对照：把这一行重新并回去，`p1-prompt-assembly` 里 3 条落盘用例立即失败（断言的是"文件真的写出来了 + 截到 80 条"，不是"没抛错"——只断言后者抓不到被 catch 吞掉的回归）。

**② 探针自己失去牙齿** —— `_verify_promptctx.js` 第一版把计划工具参数写成 `steps` / `task_index`，真实 schema 要 `tasks` / `taskIndex`，于是调用被参数校验拦下、计划从未落库；轮次照样跑满 5 轮、`<runtime_context>` 照样在末尾，只有断言 ③ 报"进度全程没变"，看起来像**产品没刷新运行态**。修完参数名后我在探针里加了自检层（第 0 步）：一旦本轮有 tool 结果含「参数校验未通过」或 `create_plan` 未落库，直接判定"运行态断言失去依据"，而不是让模拟数据悄悄退化成假绿。

同一类问题在 P0 的 `_verify_ctxpair.js` 上已经发生过一次（模拟输出不含关键词 → 压缩不触发 → 修前修后都 PASS）。**写探针时必须顺手验证它能 FAIL**，这两条现在都有反向对照记录。

### P1-#6 的反向对照

临时把运行态改回塞进 `sysBlocks`，`_verify_promptctx.js` 实测报：

```
FAIL:
 - 第 2/3/4/5 轮的 system 前缀与第 1 轮不一致（前缀缓存会整段失效）
 - 运行态仍混在 system 块里，会推翻整条前缀缓存（×5）
 - 第 1 轮运行态不在最末尾（它是第 5 条，共 7 条）
 - 运行态快照的 role 应为 user，实际 system
```

还原后：`PASS: 5 轮请求，system 前缀逐字节一致；运行态每轮刷新且只在末尾出现一次（进度序列 0→1→2）；未落入持久化 history。`

进度序列里的 `0` 与"没有计划行"是分开的两种取值（`null` 不参与序列），第一版把它们都记成 0，读起来像"最后一轮进度倒回 0"——实际是三步计划全部完成后 `getActive` 返回 null、运行态不再报进度行，属预期行为。断言里另外加了"分母必须恒定"，用来抓"计划被反复重建"这种自造假进度。
### P1-#11 规则装配（2026-10-03 续）

`loadRules` 拆成 `loadRulesParts()` → `{stable, conditional}`，并按测量结果**砍掉了原计划里的 digest 缓存**：
`buildAugmentParts` 实测每个任务只调一次（`agent-llm.js:2751`，在工具循环之前），不是"每轮全量重读"——
我方案里 §4 那句判断是错的，读了 `agent-llm.js` 的调用位置才发现。既然每任务一次，
缓存几个小文件的收益远不值它带来的"规则改了却不生效"风险，所以不做。

真正做了的四件事：

| 改动 | 为什么 |
|---|---|
| 无条件规则进 `stable`、按路径命中的进 `conditional` | 同会话连发多条消息时，stable 段逐字节不变；旧实现把两者混在一段，每条消息整段规则前缀重来 |
| 单文件注入上限 8000 字符 + 磁盘读取上限 256KB | 见下面的缺陷 ③ |
| 用户全局层 `~/.pancode/AGENTS.md`（排项目级之前，只读） | 跨项目个人约定以前无处安放；沉淀到数据根 `.pancode/rules` 的老路径 Agent 根本不读 |
| `stable`/`turn` 桶内**每块单独成一条 system 消息** | 旧代码把整桶 `join` 成一条，桶内任一项变了就作废整条；拆开只从变化那条起失效 |

顺带把预算数字收归一处：`RULE_MAX_STABLE`/`RULE_MAX_CONDITIONAL`/`RULE_MAX_FILE_CHARS`/`RULE_READ_CAP`
从 `agent-llm.js` 导出，`/api/rules` 的面板分母和 `/api/rules/preview` 都读同一份。
面板原先硬编码 `max: 12000`，探针也硬编码 `r.json.max === 12000` —— 两处第二真相源，
改预算时它们会一起悄悄失真。探针现在断言的是"两个端点报同一个分母"，而不是某个具体数字。

### 实测抓到的第三个缺陷：只读规则来源点进详情全是报错（既有缺陷，非本次引入）

写探针断言"AGENTS.md / Cursor .mdc / 用户全局 这三类只读行应能读回正文"时实测：

```
✗ 只读来源可读回正文：根级 AGENTS.md — {"ok":false,"error":"非法规则路径"}
✗ 只读来源可读回正文：Cursor 规则 .mdc — {"ok":false,"error":"非法规则路径"}
✗ 只读来源可读回正文：用户全局 ~/.pancode/AGENTS.md — {"ok":false,"error":"非法规则路径"}
```

根因：`/api/rules/content` 复用了写入通道的 `rulePath()`，它只认 `.pancode/rules/*.md`。
而面板对**每一行**都会打这个端点，所以规则面板里 AGENTS.md、CLAUDE.md、Cursor 规则的详情
一直显示"非法规则路径"——这条早于本次优化就存在，只是没人点开过只读行。
（我新增的用户全局行本来会继承同一个错误。）

修法：只读通道与写入通道**分源**。新增 `rules.resolveReadableRule()` 做形状白名单
（四种来源 + `~/.pancode/AGENTS.md`，绝对路径 / 盘符 / 任何 `..` 段 / 非规则形状一律拒），
PUT/DELETE 仍然只走严格的 `rulePath`。`test/p1-rules.test.js` 里 14 条伪装路径逐条断言被拒，
并单列了反斜杠用例——Windows 下 `..\..\AGENTS.md` 不能绕过判定。

### P1 收尾状态

`test:unit` **402 项 / 17 文件**、`test:verify` **13 个探针**、`verify:ui` 全绿（基线 290 → P0 后 322 → P1 收口 402）。

一条诚实记录：中途 `npm run test:verify` 出现过一次 `exit=1` 而逐个跑 13 个探针全是 0，
紧接着连续两轮整链跑也全 0。症状指向探针之间 8811 端口的沙箱服务尚未完全退出就起了下一个
（前一次我刚手工跑过 `_verify_assets.js`）。这是探针自带的端口复用竞争，**没有查到根因就先记在这里**，
下次复现时优先看 `_verify_assets.js` / `_verify_auth.js` 的 child kill 与就绪探测时序。

### 未做（按设计留给 P2）

- ~~**P1-#10 渐进披露**~~：实测后确认 pancode 的记忆与技能注入本来就只给目录 + 摘录，
  全文各自走 `search_memory` / `use_skill` 按需取回。这轮没写实现，而是补了 4 条**用真实 store**
  的量测断言把"有界"钉住（记忆注入 ≤3020 字符、技能目录 <900 字符等，见 §6.3）。
  真正还差的是"本会话已经取回过就不再提示去取"这个状态（ZCode `loaded-skills.ts` 那条），归 P2。
- P2-#14 拆分 `agent-llm.js`、#15 九段摘要、#16 降级阶梯与断路器、#17–#22 见 §8。
- ~~P2-#13 工具契约字段化~~ —— ✅ 已落地，见 §12。
- ~~`read_process` 之外的"有状态只读工具"需要同时进两个 Set~~ —— 契约表的 `stateful` 一个字段解决，见 §12。
- 用户全局层目前是**面板只读、不能编辑**。要给它做编辑入口得先定"跨项目偏好写错了会影响所有仓库"的确认策略，不在这次范围内。

---

## 12. P2-#13 工具契约字段化（2026-10-04）

### 做了什么

新增 `server/tools/contract.js`：38 个工具一人一行，声明 `readOnly / stateful / mutating / irreversible / microcompact / waitFree / subAgentBlock / readOnlyWhen`。
派生出 7 个集合，替换掉原来散在 **6 处**的手工名单：

| 迁移前 | 位置 | 迁移后 |
|---|---|---|
| `READONLY_TOOLS`（18 个名字） | `agent-llm.js` | `DERIVED.READONLY` |
| `NON_CONCURRENT_READS`（`read_process`） | `agent-llm.js` | 契约的 `stateful` 字段 |
| `MICROCOMPACTABLE_TOOLS`（15 个） | `agent-llm.js` | `DERIVED.MICROCOMPACTABLE` |
| `WAIT_FREE_TOOLS`（4 个 + 展开一次并集） | `agent-llm.js` | `DERIVED.WAIT_FREE`（mutating 自动带 waitFree） |
| `SUB_AGENT_BLOCK`（11 个） | `agent-llm.js` | `DERIVED.SUB_AGENT_BLOCKED` |
| `MUTATING_TOOLS`（9 个） | `tools/util.js` | `DERIVED.MUTATING`，util 只留转发 |
| `toolName === "delete_file"` | `_approvalDecision` | 契约的 `irreversible` 旗标 |
| `toolName === "git_branch" && args.action === "list"` | `_approvalDecision` | 契约的 `readOnlyWhen`，入口统一成 `TOOL.isReadOnly(name, args)` |

`_assertToolCoverage()` 现在顺带跑 `auditContract()`：漏登记、孤儿名字、以及"既纯读又改盘/不可逆"这种自相矛盾的声明，启动就在日志里点名。
未知名字（MCP 外部工具走这条）**fail-closed**：不是只读、不可并行、结果不可清理。

### 等价性优先于设计正确性

这是一次**纯迁移**，所以 `test/p2-tool-contract.test.js` 断言的不是"新表好不好"，而是"派生集合与迁移前 6 处名单逐一相等"——
基线值是直接从旧源码抄下来的字面量。它立刻抓到我抄表时的两处错：`undo` 该进子智能体黑名单（我漏了），
`orchestrate` 不该进（我多加了）。两处都按"保持既有行为"修正。

### 迁移过程中真实踩到的一次事故（值得记下来）

写成了 `const { MUTATING_TOOLS } = TOOL.DERIVED;` —— 派生键叫 `MUTATING`，解构找的是 `MUTATING_TOOLS`，
于是拿到 `undefined`。**428 项单测全绿**，直到 `test:verify` 报

```
- agent.trace 事件未实时 emit（Trace 面板收不到数据），实际 1
- trace 未落盘到磁盘（diskLines=1）
```

根因是 `undefined.has(...)` 在 `_execToolIntoSlot` 里抛 `TypeError`，而主循环的 catch 把它分类成
`kind:"unknown"` 的 `agent.error` 事件——探针的 mock `AgentBase.emit` 只统计 `agent.trace`，
错误事件被静默吞掉，表现为"循环只跑了一轮"。定位花了三步（因为栈被 catch 吃了），
最后是临时在 catch 里加一行 `console.error(err.stack)` 才拿到的。

修法之外更要紧的是补了 5 条**消费点测试**：直接调 `_isConcurrentSafe` / `_subToolset` /
`_execToolIntoSlot`（改盘与只读两条分支）/ `_runToolGuarded`，把"集合是不是活的"变成被测行为而不是被读到。
反向对照已做：把 `MUTATING` 改回错误键名，2 条用例立即失败；改回来全绿。

**教训**：`const X = DERIVED.X` 这种"键名与变量名不一致"的迁移，光看内容等价不够，一定要跑消费点。

### 已知偏差（照实列出，都是既有行为，不在纯迁移里顺手改）

1. `create_skill` 会往本地技能库写，但它既不在 `READONLY` 也不在 `MUTATING` —— 于是**规划模式其实拦不住它**。
   收紧它等于删掉一条现存的"规划模式下沉淀技能"路径，需要单独确认。
2. `run_command` 被标了 `microcompact`（与迁移前一致）：清掉的是很久以前的命令输出，模型要看就重跑——
   但重跑一条有副作用的命令并不总是安全。把它限定到只读工具需要重新量压缩收益，另开一项。
3. `web_fetch` / `web_search` 归 `readOnly`：它们确实向外发请求，与 SYSTEM_PROMPT 安全准则里
   "不向外部发送数据"的措辞不完全一致（取 vs 发），沿用既有判定。
4. `orchestrate` 不在子智能体黑名单里而 `agent` 在 —— 子智能体理论上能再开一轮编排。
   大概率是当年把 `agent` 加进 BLOCK 时漏了这个对偶名字，但收紧它会让"子代理里再编排"失效，单独确认后再改。

### 状态

`test:unit` **428 项 / 18 文件**；`test:verify` 13 探针连跑两轮均 exit 0；`verify:ui` 全绿。未提交。

**P1 至此收口**：#6 #7 #8 #9 #11 #12 落地，#10 经实测判定无需改动。P2 的 #13 是后续所有项的前置
（`readOnly` / `concurrentSafe` / `maxOutputBytes` 一旦字段化，上面这几处手工 Set 和硬编码预算都会自动收敛）。
