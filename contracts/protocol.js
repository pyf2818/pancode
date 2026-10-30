"use strict";
/* ============================================================
   协议契约（F20-1）：WebSocket 两端之间跑什么消息，写在这一份声明里。
   ————————————————————————————————————————————————————
   为什么要有这一份：这一层的 bug 不看契约是抓不到的 ——
     · 服务端新增一种事件、前端没有对应 case，界面只是"少了个反应"，测试全绿；
     · 前端还留着早已不存在的 case，读代码的人以为还有这条路（F18 的 trace 就是这么烂掉的）；
     · 一帧里少了个字段（convId、eid），只在特定分支下显形。
   scripts/_verify_contract.js 拿这份声明和真东西对账：
     ① server/index.js 的 switch (m.type) 与 public/app.js 的 switch (ev.type) 必须与这里逐条一致；
     ② 现场跑一条真会话，抓到的每一帧类型都必须在这里在册；
     ③ tier="core" 的那些类型，required 里声明的字段必须在真帧里真的出现。
   tier 口径（说清楚哪些是字段级、哪些只到类型级，不假装全覆盖）：
     · core = 承载正确性的帧（对话流、工具流、状态、压缩、落盘、审批），字段级检查；
     · edge = 只做类型级在册检查（少一帧只是体验缺失，不改变数据）。
   ============================================================ */

/* 服务端 → 前端 */
const SERVER_EVENTS = [
  { type: "hello", dir: "s2c", tier: "core", desc: "连接建立后的首帧：会话列表、模型、引擎身份与树的首屏" },
  { type: "fs.sync", dir: "s2c", tier: "core", desc: "文件树全量/增量同步" },
  { type: "file.data", dir: "s2c", tier: "core", desc: "按需读回来的单个文件正文" },
  { type: "file.baseline", dir: "s2c", tier: "core", desc: "对照用的基线内容（diff 的另一边）" },
  { type: "file.error", dir: "s2c", tier: "core", desc: "文件级失败（不存在/二进制/读不出）" },
  { type: "tree.data", dir: "s2c", tier: "edge", desc: "目录分页翻出来的一页条目" },
  { type: "fs.renamed", dir: "s2c", tier: "edge", desc: "改名/移动后通知前端换路径" },
  { type: "engine.info", dir: "s2c", tier: "edge", desc: "引擎身份与能力（模式、模型、是否需 Key）" },
  { type: "agent.state", dir: "s2c", tier: "core", desc: "AI 在跑还是空闲（带会话归属与文案 key）" },
  { type: "agent.backoff", dir: "s2c", tier: "edge", desc: "限流退避倒计时" },
  { type: "agent.budget", dir: "s2c", tier: "edge", desc: "本轮预算/轮数水位" },
  { type: "user.msg", dir: "s2c", tier: "core", desc: "服务端替前端回显的user 消息（断线补流用）" },
  { type: "op.error", dir: "s2c", tier: "core", desc: "操作级失败（一句话的错误条）" },
  { type: "chat.rejected", dir: "s2c", tier: "core", desc: "这条 chat 被拒（没进队列，必须让用户知道）" },
  { type: "agent.error", dir: "s2c", tier: "core", desc: "Agent 运行期错误（可恢复与致命都从这里走）" },
  { type: "file.saved", dir: "s2c", tier: "core", desc: "文件已落盘确认" },
  { type: "search.result", dir: "s2c", tier: "edge", desc: "全文搜索结果" },
  { type: "think.start", dir: "s2c", tier: "edge", desc: "思考区开始" },
  { type: "think.delta", dir: "s2c", tier: "edge", desc: "思考区流式增量" },
  { type: "think.end", dir: "s2c", tier: "edge", desc: "思考区结束" },
  { type: "msg.start", dir: "s2c", tier: "core", desc: "一条 AI 正文开始（前端据此开一块独立缓冲）" },
  { type: "msg.delta", dir: "s2c", tier: "core", desc: "AI 正文流式增量" },
  { type: "msg.end", dir: "s2c", tier: "core", desc: "一条 AI 正文收尾：现场实测只带 id，正文以服务端已累计的增量为准" },
  { type: "tool.start", dir: "s2c", tier: "core", desc: "一次工具调用开始" },
  { type: "tool.body", dir: "s2c", tier: "edge", desc: "工具执行的中间输出" },
  { type: "tool.image", dir: "s2c", tier: "edge", desc: "工具产出的图片" },
  { type: "tool.end", dir: "s2c", tier: "core", desc: "工具调用结束（成功/失败都算结束）" },
  { type: "tool.pending", dir: "s2c", tier: "core", desc: "等用户审批的工具卡" },
  { type: "tool.ask_choice", dir: "s2c", tier: "edge", desc: "工具向用户要一个选项" },
  { type: "term.cmd", dir: "s2c", tier: "edge", desc: "终端面板：要执行的命令行" },
  { type: "term.line", dir: "s2c", tier: "edge", desc: "终端面板：一行输出" },
  { type: "term.exit", dir: "s2c", tier: "core", desc: "终端面板：进程退出码" },
  { type: "agent.trace", dir: "s2c", tier: "core", desc: "轨迹事件（投影按它重建，字段见 lifecycle 契约）" },
  { type: "agent.usage", dir: "s2c", tier: "core", desc: "本次用量（token/费用/上下文水位）" },
  { type: "file.changed", dir: "s2c", tier: "edge", desc: "磁盘上的文件被外部改了" },
  { type: "editor.open", dir: "s2c", tier: "edge", desc: "让编辑器打开某个文件" },
  { type: "editor.diff", dir: "s2c", tier: "edge", desc: "编辑器里展示一段 diff" },
  { type: "changes", dir: "s2c", tier: "edge", desc: "本轮改动的文件清单" },
  { type: "artifacts", dir: "s2c", tier: "edge", desc: "本轮产物列表" },
  { type: "patch.review", dir: "s2c", tier: "core", desc: "补丁审阅卡（同意/拒绝的入口）" },
  { type: "patch.applied", dir: "s2c", tier: "core", desc: "补丁已写入" },
  { type: "patch.rejected", dir: "s2c", tier: "core", desc: "补丁被拒" },
  { type: "agent.done", dir: "s2c", tier: "core", desc: "这一轮跑完（前端的「还在跑」必须靠它落地）" },
  { type: "agent.reset", dir: "s2c", tier: "core", desc: "会话重置" },
  { type: "orch.start", dir: "s2c", tier: "edge", desc: "编排开始" },
  { type: "orch.step.start", dir: "s2c", tier: "edge", desc: "编排某步开始" },
  { type: "orch.step.done", dir: "s2c", tier: "edge", desc: "编排某步完成" },
  { type: "orch.step.fail", dir: "s2c", tier: "core", desc: "编排某步失败（不能盖成 done）" },
  { type: "orch.done", dir: "s2c", tier: "edge", desc: "编排结束" },
  { type: "conv.switched", dir: "s2c", tier: "edge", desc: "服务端确认切到另一个会话" },
  { type: "plan.created", dir: "s2c", tier: "edge", desc: "任务计划建立" },
  { type: "plan.updated", dir: "s2c", tier: "core", desc: "任务计划进度更新" },
  { type: "agent.settings", dir: "s2c", tier: "edge", desc: "运行设置回传（权限档、模型等）" },
  { type: "system.perf", dir: "s2c", tier: "edge", desc: "实例级性能心跳（人人可见，不按会话收窄）" },
  { type: "mcp.servers", dir: "s2c", tier: "edge", desc: "MCP 服务器清单" },
  { type: "context.usage", dir: "s2c", tier: "core", desc: "上下文占用与预算" },
  { type: "context.compact", dir: "s2c", tier: "core", desc: "真的压缩了上下文（评测要先证明它发生）" },
  { type: "context.compact_breaker", dir: "s2c", tier: "core", desc: "压缩连续失败后停用（熔断要让用户看到）" },
  { type: "memory.recall", dir: "s2c", tier: "edge", desc: "记忆召回结果" },
  { type: "goal.set", dir: "s2c", tier: "edge", desc: "目标已登记" },
  { type: "goal.continue", dir: "s2c", tier: "edge", desc: "目标继续推进" },
  { type: "goal.settled", dir: "s2c", tier: "core", desc: "目标收口（完成/放弃/被打断，终态）" },
  /* —— 下面十种是这次建契约时才发现"代码里在发、清单上没有"的：
     前六种连前端都没接（现状见 UNHANDLED 的说明），后四种由 public/js/lsp-client.js 接。 —— */
  { type: "chat.queued", dir: "s2c", tier: "edge", desc: "这条排到第几位（服务端任务表接，前端靠 term.line 看见）" },
  { type: "chat.dequeued", dir: "s2c", tier: "edge", desc: "排队的那条开始执行（同上）" },
  { type: "chat.rewound", dir: "s2c", tier: "edge", desc: "为重跑而回退历史（前端无界面反馈）" },
  { type: "context.microcompact", dir: "s2c", tier: "core", desc: "微压缩：清掉旧工具结果省下的 token" },
  { type: "goal.pending", dir: "s2c", tier: "edge", desc: "开机时发现上次被打断的目标" },
  { type: "goal.resumed", dir: "s2c", tier: "edge", desc: "目标续跑开始" },
  { type: "lsp.ready", dir: "s2c", tier: "edge", desc: "语言服务器起来了" },
  { type: "lsp.msg", dir: "s2c", tier: "edge", desc: "语言服务器的 LSP 消息原样转发" },
  { type: "lsp.error", dir: "s2c", tier: "edge", desc: "该语言未启用 LSP 或进程报错" },
  { type: "lsp.exit", dir: "s2c", tier: "edge", desc: "语言服务器进程退出" },
];

/* 前端 → 服务端 */
const CLIENT_EVENTS = [
  { type: "chat", dir: "c2s", tier: "core", desc: "发一句话给 Agent" },
  { type: "rewind", dir: "c2s", tier: "edge", desc: "回退到某个检查点" },
  { type: "ctx.query", dir: "c2s", tier: "edge", desc: "问一次上下文里有什么" },
  { type: "goal.set", dir: "c2s", tier: "edge", desc: "设定目标" },
  { type: "goal.resume", dir: "c2s", tier: "edge", desc: "继续被打断的目标" },
  { type: "goal.clear", dir: "c2s", tier: "edge", desc: "清掉目标" },
  { type: "compact.now", dir: "c2s", tier: "edge", desc: "手动压缩上下文" },
  { type: "term.exec", dir: "c2s", tier: "core", desc: "在终端面板执行一条命令" },
  { type: "term.open", dir: "c2s", tier: "edge", desc: "开一个终端会话" },
  { type: "term.close", dir: "c2s", tier: "edge", desc: "关一个终端会话" },
  { type: "term.kill", dir: "c2s", tier: "core", desc: "杀掉终端里正在跑的进程" },
  { type: "file.save", dir: "c2s", tier: "core", desc: "把编辑器内容写到磁盘" },
  { type: "file.create", dir: "c2s", tier: "core", desc: "新建文件" },
  { type: "file.delete", dir: "c2s", tier: "core", desc: "删除文件（进回收站）" },
  { type: "file.rename", dir: "c2s", tier: "core", desc: "改名/移动" },
  { type: "file.mkdir", dir: "c2s", tier: "core", desc: "新建目录" },
  { type: "tree.load", dir: "c2s", tier: "core", desc: "按偏移翻目录树的一页" },
  { type: "file.read", dir: "c2s", tier: "core", desc: "按需读一个文件的正文" },
  { type: "file.baseline", dir: "c2s", tier: "core", desc: "按需取一个文件的基线" },
  { type: "search", dir: "c2s", tier: "edge", desc: "全文搜索" },
  { type: "reset", dir: "c2s", tier: "core", desc: "重置会话" },
  { type: "newchat", dir: "c2s", tier: "edge", desc: "开一条新会话" },
  { type: "abort", dir: "c2s", tier: "core", desc: "中止正在跑的一轮" },
  { type: "tool.approve", dir: "c2s", tier: "core", desc: "批准一个待审工具" },
  { type: "tool.reject", dir: "c2s", tier: "core", desc: "拒绝一个待审工具" },
  { type: "tool.choice_result", dir: "c2s", tier: "edge", desc: "回答工具要的那个选项" },
  { type: "patch.approve", dir: "c2s", tier: "core", desc: "同意补丁" },
  { type: "patch.reject", dir: "c2s", tier: "core", desc: "拒绝补丁" },
  { type: "update_plan_task", dir: "c2s", tier: "edge", desc: "改任务计划里某一项的状态" },
];

const TIER_CORE = SERVER_EVENTS.concat(CLIENT_EVENTS).filter((e) => e.tier === "core").map((e) => e.type);

/* tier="core" 的字段级要求。这里的每一条都是从真帧上量出来的（CONTRACT_DUMP=1 会打出
   现场每一类帧"每帧都有的字段"），不是照着想象写的 —— 探针拿真帧的字段集合来对，缺一个就红。
   还没被现场驱动到的 core 类型不硬填字段，改登记在 UNVERIFIED_CORE 里说明为什么没核对。 */
const REQUIRED_FIELDS = {
  hello: ["type", "tree", "wsId", "engine"],
  "fs.sync": ["type", "files", "incremental"],
  "file.data": ["type", "path", "content"],
  "file.baseline": ["type", "path", "original", "isNew"],
  "file.saved": ["type", "path"],
  "user.msg": ["type", "convId", "text"],
  "agent.state": ["type", "running", "convId"],
  "msg.start": ["type", "convId", "id"],
  "msg.delta": ["type", "convId", "id", "text"],
  "msg.end": ["type", "convId", "id"],
  "tool.start": ["type", "convId", "id", "name"],
  "tool.end": ["type", "convId", "id", "ok"],
  "tool.pending": ["type", "id", "tool", "convId"],
  "term.exit": ["type", "tabId"],
  "agent.trace": ["type", "convId", "event"],
  "agent.done": ["type", "convId", "round"],
  "agent.reset": ["type"],
  "agent.usage": ["type", "convId", "usage", "cost"],
  "file.error": ["type", "path", "error"],
  "context.usage": ["type", "used", "budget"],
};

/* 现场没驱动到的 core 类型：字段级契约这一轮没核对，只做类型级在册。
   每一条都要写清"为什么这一轮没抓到"，好让下一个人知道该去驱动哪条路，而不是以为已经覆盖了。 */
const UNVERIFIED_CORE = [
  "op.error",                 /* 试了 tree.load 打不存在的目录：服务端把它当空页回，不发错误帧 */
  "chat.rejected",            /* 要同一会话排到队列上限（CONV_QUEUE_MAX）才发，一轮抓不到 */
  "agent.error",              /* 要让上游真报错；本探针用的是听话的假网关 */
  "context.compact", "context.compact_breaker", "context.microcompact",  /* 沙箱会话太小，压不动 */
  "plan.updated", "patch.review", "patch.applied", "patch.rejected", "orch.step.fail", "goal.settled",
];

/* 前端不处理、服务端另有人接或干脆没人接的类型 —— 这一轮建契约时量出来的现状。
   写在这里不是为它们开脱，是为了让"没人接"这件事在纸面上而不是在运行时消失：
   界面能看见的等价反馈是什么，一条条写清楚。 */
const UNHANDLED = {
  "chat.rewound": "只在服务端内部用于重跑前清历史；前端没有对应反馈（靠 term.line 的行）",
  "context.microcompact": "省了多少 token 前端不显示，只有 term.line 一句话",
  "goal.pending": "开机续跑提示目前走 term.line，没有独立界面反馈",
  "goal.resumed": "同上",
};

module.exports = { SERVER_EVENTS, CLIENT_EVENTS, TIER_CORE, REQUIRED_FIELDS, UNVERIFIED_CORE, UNHANDLED };
