"use strict";
/* ============================================================
   权限 / 生命周期 / 存储三条边界的契约（F20-1）
   ————————————————————————————————————————————————————
   和 protocol.js 同一个道理：这四条边界都是"两端各写一遍、谁也没对账"的地方。
   F18 就是一个实证 —— 写入端按用户分目录、读取端永远读匿名根目录，
   两边各自都能跑，历史轨迹却一条也回不来。这类问题不靠人眼，靠对账。
   scripts/_verify_contract.js 会：
     · 把这里的清单和代码里真实出现的取值/键名/目录逐条比（两个方向都比）；
     · 对"声明了却没被任何一端用到"的条目也报红（陈旧声明和缺声明一样有害）。
   ============================================================ */

/* ---------- 权限档 ----------
   同一套字符串出现在三处：服务端的唯一清单（server/config.js 的 PERMISSION_MODES）、
   判据（server/permission-core.js）、界面给的选项（public/app.js 里带 data-i18n="permOpt*" 的 option）。
   少一处就会出现"界面能选、服务端不认"或反过来的静默失灵。 */
const PERMISSION_MODES = [
  { mode: "ask", isDefault: true, desc: "每一步都问（服务端 permissions.mode 的默认值）" },
  { mode: "semi", desc: "半自动：安全操作免确认，写操作仍问" },
  { mode: "acceptEdits", desc: "只免「文件改动」这一格，其余照问" },
  { mode: "smart", desc: "智能判定：这一步交给分类器决定问不问" },
  { mode: "auto", desc: "全自动：只有不可逆守卫还拦" },
  { mode: "dontAsk", desc: "任何本来要问人的出口都变成拒绝" },
];

/* ---------- Agent 生命周期 ----------
   agent.state 不带枚举，带一个 running 布尔 + 一个 i18n 文案 key。
   文案 key 是跨端字符串：服务端写死、前端拿去 t()、i18n 两份字典都要有。
   少一份字典，界面就显示成字面量 key —— 这正是没有契约时会发生的事。 */
const LIFECYCLE = {
  /* 服务端在 agent.state 里可能给出的 labelKey */
  stateLabelKeys: ["running", "aiIdle", "rateLimitRetry"],
  /* 一轮运行的收口事件：跑到哪一步都必须有一个终点，否则前端"还在跑"永远不落 */
  terminalEvents: ["agent.done", "agent.reset", "chat.rejected", "goal.settled", "term.exit"],
};

/* ---------- 存储 ---------- */
const STORAGE = {
  /* 前端 localStorage 里固定名字的键（动态键见 dynamicKeyPrefixes） */
  localStorageKeys: [
    "cw-user-token", "cw-user-name", "cw-theme", "cw-palette", "cw-lang",
    "cw-fontsize", "cw-ui-fontsize", "cw-onboarded", "cw-grid-mode", "cw-gh-stars",
    "cw-sidebar-w", "cw-preview-w", "cw-panel-h",
    "cw-chat-w", "cw-chat-collapsed",
    "cw-ag-sessions-w", "cw-ag-sessions-collapsed", "cw-ag-right-w", "cw-ag-right-collapsed",
    "ag-changed-h", "ag-term-h",
  ],
  /* 按工作区/会话派生的键前缀：静态清单抓不到，契约里单独登记，
     探针据此知道"这些是有意为之的动态键"，而不是漏登记。 */
  dynamicKeyPrefixes: ["cw-palette-", "cw-conv-v1:", "cw-conv-active:", "cw-convdom-v1:"],
  /* 数据根（<ROOT>/.pancode/）下的子目录：登记「哪些文件里真的拼了这个路径」。
     两个方向都比 —— 声明的文件里没这个串（作废声明）红；代码里拼了个没登记的目录（新边界没人看着）也红。
     agent-traces 特意登记两个文件：F18 就是写的人按用户分目录、读的人永远读根目录，
     两边各自都「能跑」，历史轨迹却一条回不来。这一条钉的就是那类不对称。 */
  dataDirs: [
    { dir: "conversations", files: ["server/agent-llm.js"], desc: "对话分片" },
    { dir: "agent-traces", files: ["server/agent-llm.js", "server/index.js"], desc: "Agent 轨迹（登录用户再按 userKey 分子目录）" },
    { dir: "artifacts", files: ["server/artifacts.js"], desc: "本轮产物清单" },
    { dir: "audit", files: ["server/index.js"], desc: "审计流水" },
    { dir: "automations", files: ["server/index.js"], desc: "自动化定义" },
    { dir: "builtin-skills", files: ["server/agent-llm.js", "server/index.js"], desc: "内置技能" },
    { dir: "code-index", files: ["server/code-index.js"], desc: "代码索引" },
    { dir: "decisions", files: ["server/index.js"], desc: "决策记录" },
    { dir: "experts", files: ["server/index.js"], desc: "专家配置" },
    { dir: "goals", files: ["server/agent-llm.js"], desc: "目标状态" },
    { dir: "memory", files: ["server/agent-llm.js", "server/index.js", "server/config.js"], desc: "记忆（user / project 两把）" },
    { dir: "orch-history", files: ["server/orchestrator.js"], desc: "编排历史" },
    { dir: "plans", files: ["server/agent-llm.js", "server/index.js"], desc: "任务计划" },
    { dir: "progression", files: ["server/agent-llm.js", "server/index.js", "server/config.js"], desc: "进度档位" },
    { dir: "rule-proposals", files: ["server/index.js"], desc: "规则提案" },
    { dir: "rules", files: ["server/config.js"], desc: "规则" },
    { dir: "rules-history", files: ["server/rule-history.js"], desc: "规则历史" },
    { dir: "runs", files: ["server/scheduler.js"], desc: "定时任务运行记录" },
    { dir: "skills", files: ["server/agent-llm.js", "server/index.js", "server/config.js", "server/skill-store.js"], desc: "技能目录" },
    { dir: "soul", files: ["server/agent-llm.js", "server/index.js", "server/config.js"], desc: "人格设定" },
    { dir: "spill", files: ["server/agent-llm.js"], desc: "超大工具结果的落盘处（正文不进上下文，只留路径）" },
    { dir: "shadow-git", files: ["server/shadow-git.js"], desc: "影子检查点（撤销/回滚用的第二把 git 仓）" },
    { dir: "tasks", files: ["server/index.js"], desc: "任务台账" },
    { dir: "workflows", files: ["server/agent-llm.js", "server/index.js"], desc: "工作流" },
    { dir: "trash", files: ["server/files.js"], desc: "删除落点（回收站）" },
  ],
};

module.exports = { PERMISSION_MODES, LIFECYCLE, STORAGE };
