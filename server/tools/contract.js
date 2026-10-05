/* ============================================================
   工具契约表（P2-#13）：每个工具一行，把"它是什么性质的操作"声明成数据。

   为什么值得单独一个文件：这 38 个工具的性质以前散在 5 个手工 Set 里
   （agent-llm 的 READONLY_TOOLS / NON_CONCURRENT_READS / MICROCOMPACTABLE_TOOLS /
   WAIT_FREE_TOOLS / SUB_AGENT_BLOCK，外加 tools/util 的 MUTATING_TOOLS 和
   _approvalDecision 里一句 `toolName === "delete_file"`），
   任何一个新增工具都要人记着去 6 个地方登记。漏一处的后果不是报错，是静默劣化：
     - 漏 READONLY    → 纯读工具每轮白弹一次人工确认
     - 漏 MUTATING    → 规划模式不再拦它（本来"只能出计划"的约束被绕开）
     - 漏 SUB_AGENT_BLOCK → 子智能体拿到会污染主流程的工具
     - 漏 irreversible → 全自动模式下静默删文件，且不会有任何异常

   所以这里的规则是**默认关闭（fail-closed）**：没写进表 = 不是只读、不是可并行、
   结果不可清理。写错表的风险由 auditContract() 兜：启动自检 + 单测逐个桶比对成员，
   名字漂了就响亮报错，而不是等到用户被弹确认才发现。

   ⚠ 这个表是权限判定的输入，因此它的内容**绝不进模型可见的工具定义**。
     模型看到的仍然只有 TOOLS 里的 description/parameters（见 ZCode 的同类纪律）。
   ============================================================ */
"use strict";

/* 每一行的字段含义（都默认 false，除非显式声明）：
   readOnly        纯读：不改工作区、不执行命令、不向外部发送数据 → 直接放行
   stateful        只读但带跨调用游标 → 不可与同批的其它调用并行
   mutating        会改动工作区 / 执行命令 → 规划模式禁止、改盘后做风险回灌、不设执行超时
   irreversible    撤不回来 → 即使 auto 模式、即使命中 allow 也强制人工确认
   microcompact    结果可再生，压缩时可整段清掉（写类/计划类结果承载"我改了什么"，不算可再生）
   waitFree        不设执行超时：等用户输入 / 可能弹审批门 / 本身是长编排
   subAgentBlock   不进子智能体工具集（会自我嵌套或污染主流程）
   readOnlyWhen    名字两用时的判定：满足才算纯读（git_branch 的 list 动作）
*/
const CONTRACT = {
  // —— 文件读 ——
  list_files:      { readOnly: true, microcompact: true },
  read_file:       { readOnly: true, microcompact: true },
  search_code:     { readOnly: true, microcompact: true },
  repo_map:        { readOnly: true, microcompact: true },
  search_symbol:   { readOnly: true, microcompact: true },
  get_diagnostics: { readOnly: true, microcompact: true },

  // —— 文件写 ——
  write_file:  { mutating: true },
  apply_edit:  { mutating: true },
  delete_file: { mutating: true, irreversible: true },
  undo:        { mutating: true, subAgentBlock: true },

  // —— 命令与进程 ——
  run_command:   { mutating: true, microcompact: true },
  start_process: { mutating: true },
  stop_process:  { mutating: true },
  read_process:  { readOnly: true, stateful: true, microcompact: true },
  check_port:    { readOnly: true, microcompact: true },

  // —— Git ——
  git_status: { readOnly: true, microcompact: true },
  git_diff:   { readOnly: true, microcompact: true },
  git_log:    { readOnly: true, microcompact: true },
  git_commit: { mutating: true },
  // git_branch 一个名字同时承载"看分支"和"建/切分支"，只能按参数判：
  // 读的一面给免确认，mutating 的一面照旧保留（规划模式仍拦、审批仍走）。
  git_branch: { mutating: true, readOnlyWhen: (args) => args && args.action === "list" },

  // —— 记忆与知识 ——
  search_memory:       { readOnly: true },
  save_session_memory: { subAgentBlock: true },

  // —— 技能 ——
  create_skill: { /* 写进技能库；今天既不算只读也不在 MUTATING 里，见文件末"已知偏差" */ },
  use_skill:    { readOnly: true },

  // —— 计划与目标 ——
  create_plan: { subAgentBlock: true },
  update_plan: { subAgentBlock: true },
  set_goal:    { waitFree: true, subAgentBlock: true },
  goal_status: { readOnly: true, subAgentBlock: true },

  // —— 模板 ——
  list_templates:        { readOnly: true, subAgentBlock: true },
  instantiate_template:  { subAgentBlock: true },
  save_template:         { subAgentBlock: true },
  remove_template:       { subAgentBlock: true },

  // —— 编排 ——
  agent:       { waitFree: true, subAgentBlock: true },
  // orchestrate 今天不在子智能体黑名单里（agent 在）。让子智能体再开一轮编排
  // 看起来是原设计的漏登记，但那是既有行为，纯迁移不顺手改 —— 见文件末"已知偏差 4"。
  orchestrate: { waitFree: true },

  // —— 网络 ——
  web_search: { readOnly: true, microcompact: true },
  web_fetch:  { readOnly: true, microcompact: true },

  // —— 外部 MCP ——
  list_mcp: { readOnly: true, microcompact: true },

  // —— 交互 ——
  ask_user_choice: { waitFree: true },
};

/* 取契约。未知名字一律按"最保守"处理：不是只读、不可并行、结果不可清理。
   MCP 外部工具走的正是这条路径 —— 它们今天就不在 READONLY 里，会照常弹确认。
   每次都返回新对象：这张表是权限判定的输入，共享一个默认对象意味着
   任何一处 `c.readOnly = true` 都会改掉所有未登记工具的判定。 */
const EMPTY = {};

function contractOf(name) {
  const c = CONTRACT[name] || EMPTY;
  return {
    known: !!CONTRACT[name],
    readOnly: !!c.readOnly,
    stateful: !!c.stateful,
    mutating: !!c.mutating,
    irreversible: !!c.irreversible,
    microcompact: !!c.microcompact,
    waitFree: !!c.waitFree || !!c.mutating,   // 改盘类一律不设执行超时
    subAgentBlock: !!c.subAgentBlock,
    readOnlyWhen: typeof c.readOnlyWhen === "function" ? c.readOnlyWhen : null,
  };
}

/* 这个工具此刻是否算纯读。名字两用的（git_branch）按参数判。
   权限免确认与并行调度共用这一条判据，两处不会各写一份 while 条件而漂移。 */
function isReadOnly(name, args) {
  const c = contractOf(name);
  if (c.readOnly) return true;
  return c.readOnlyWhen ? !!c.readOnlyWhen(args) : false;
}

const names = (fn) => Object.keys(CONTRACT).filter((n) => fn(contractOf(n)));

/* 派生集合：下游代码继续按 Set 用，语义与迁移前逐一相等（由单测钉住）。 */
const DERIVED = {
  READONLY: new Set(names((c) => c.readOnly)),
  CONCURRENT_SAFE: new Set(names((c) => c.readOnly && !c.stateful)),
  MUTATING: new Set(names((c) => c.mutating)),
  IRREVERSIBLE: new Set(names((c) => c.irreversible)),
  MICROCOMPACTABLE: new Set(names((c) => c.microcompact)),
  WAIT_FREE: new Set(names((c) => c.waitFree)),
  SUB_AGENT_BLOCKED: new Set(names((c) => c.subAgentBlock)),
};

/* 启动自检：TOOLS 注册表与契约表必须互为定义域。
   - missing：声明了工具却没有契约行 → 它会被静默当成"非只读、需确认"，
     或者更糟：以后有人加写类工具忘了登记 mutating，规划模式就不拦了。
   - orphan：契约里有名字但工具早就删了 → 白占一行，还会骗过后人。
   返回 null 表示干净；否则返回可直接打进日志/抛错的结构。 */
function auditContract(toolNames) {
  const declared = new Set(toolNames || []);
  const missing = [...declared].filter((n) => !CONTRACT[n]);
  const orphan = Object.keys(CONTRACT).filter((n) => !declared.has(n));
  const contradictions = Object.keys(CONTRACT).filter((n) => {
    const c = contractOf(n);
    // 既是纯读又标了"撤不回来"是不成立的组合，出现即说明表被改坏了
    return (c.readOnly && c.irreversible) || (c.readOnly && c.mutating);
  });
  if (!missing.length && !orphan.length && !contradictions.length) return null;
  return { missing, orphan, contradictions };
}

/* 已知偏差（照实记录，不在"纯迁移"这一步偷偷改行为）：
   1. create_skill 会把技能写进本地库，但迁移前它既不在 READONLY 也不在 MUTATING，
      所以规划模式其实拦不住它。修它 = 收紧一个现存能力，需要单独确认。
   2. run_command 被标了 microcompact（与迁移前一致）：清掉的是"很久以前的命令输出"，
      模型要看就重跑一次 —— 而重跑一条有副作用的命令并不总是安全的。
      真正稳的做法是把 microcompact 限定到只读工具，那要重新量一次压缩收益，另开一项。
   3. web_fetch / web_search 归 readOnly：它们会向外发请求（只读地取），
      与"不向外部发送数据"的安全准则措辞不完全一致，同样是既有判定，先保持。
   4. orchestrate 不在子智能体黑名单里，而 agent 在 —— 于是子智能体理论上能再开一轮编排。
      迁移前就是这样（多半是当时把 agent 加进 BLOCK 时漏了这个对偶名字），
      收紧它会让"子代理里再编排"这条路径失效，属于行为变更，单独确认后再改。 */

module.exports = { CONTRACT, contractOf, isReadOnly, DERIVED, auditContract };
