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
   subAgentOnly    反过来：只给子智能体用，父智能体的工具清单里不出现
                   （白板这类工具对父流程没用，却每次请求都占一份 token）
   readOnlyWhen    名字两用时的判定：满足才算纯读（git_branch 的 list 动作）
   maxResultSizeChars 低水位时这个工具的结果在上下文里最多占多少字符。
     不写 = 沿用通用值 24000（与加这个字段之前的行为逐字相同）；写 Infinity =
     该工具自己已经限了体量，通用截断不要再补一刀。水位升高时仍会按 8000/4000 收。
   interruptBehavior 用户按停止时，这一发**已经在跑**的工具要不要继续等：
     block（缺省：等它返回，写盘/不可逆动作必须这样，否则留下半截状态）
     cancel（停止等待、结果按已中断回填，后台可能仍在推进 —— 与既有"[超时]"同一种诚实）
   openWorld         会向这台机器之外发请求、或操作真实外部界面（网络 / 浏览器 / 桌面）。
     今天没有消费方，是给权限分类器与 dontAsk 档准备的输入：外部可见、影响撤不回的动作，
     判据要和"只在这台机器里动"分开。
*/
const DEFAULT_RESULT_CEILING = 24000;

const CONTRACT = {
  /* —— 文件读 ——
     read_file 给到 100000 而不是通用 24000：它自己已经按行范围/分段限体量
     （file-tools.js 的 SYMBOL_MAX_LINES=1200 行是设计上限，一次函数体轻松超过 24k 字符），
     通用刀砍在合法输出上，等于让"按符号取一段"退化成"再读一次"。
     检索类相反：命中列表的边际收益掉得很快，20k 之后的行基本是噪声，值得单独收一刀。 */
  list_files:      { readOnly: true, microcompact: true },
  read_file:       { readOnly: true, microcompact: true, maxResultSizeChars: 100000 },
  search_code:     { readOnly: true, microcompact: true, maxResultSizeChars: 20000 },
  repo_map:        { readOnly: true, microcompact: true },
  search_symbol:   { readOnly: true, microcompact: true, maxResultSizeChars: 20000 },
  code_graph:      { readOnly: true, microcompact: true, maxResultSizeChars: 20000 },
  get_diagnostics: { readOnly: true, microcompact: true },



  // —— 文件写 ——
  write_file:  { mutating: true },
  apply_edit:  { mutating: true },
  edit_files:  { mutating: true },
  delete_file: { mutating: true, irreversible: true },
  undo:        { mutating: true, subAgentBlock: true },

  /* P2-C2 跨文件重构。rename_symbol 一个名字两用：不带 apply 只算一份预览（纯读、免确认），
     带 apply 才真落盘 —— 与 git_push 的 dry-run 同一套纪律。
     mutating 必须保留：规划模式要拦它、改完要回灌诊断、不设执行超时。
     落盘整批走 edit_files，所以一次改名只有"一个"检查点，/undo 一次撤掉全部文件。 */
  find_references: { readOnly: true, microcompact: true },
  rename_symbol:   { mutating: true, readOnlyWhen: (args) => !args || args.apply !== true },

  /* —— 命令与进程 ——
     两条与"停止要立刻见效"有关的判断：
     · 上限给到 30000（比通用 24000 宽）：本文件上面那条 spill 注释自己说了，
       重跑一次构建日志往往比省下的那点 token 更贵，所以这一类结果值得多留一点头尾。
     · interruptBehavior: cancel —— mutating 一律派生成 waitFree（不设执行超时），
       于是"按了停止但命令还在跑"时，超时那条逃生舱是不存在的；标 cancel 才停得下来。
       代价说清楚：停止只是不再等它，进程可能仍在后台推进（与"[超时]"同一种诚实）。 */
  run_command:   { mutating: true, microcompact: true, maxResultSizeChars: 30000, interruptBehavior: "cancel" },
  /* P1-B3 run_tests 与 run_command 同档：它起的也是同一个 shell，
     而且测试常往工作区写东西（覆盖率目录、snapshot 文件），所以是 mutating 而不是只读；
     结果体量大且一次性，microcompact 与 run_command 一样开。
     cancel 的理由更强：一次测试跑 20 分钟，用户按停止不该还要等它跑完。 */
  run_tests:     { mutating: true, microcompact: true, maxResultSizeChars: 30000, interruptBehavior: "cancel" },
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

  /* P1-B2 工作流。三条判断值得记下来：
     · git_fetch 只动 .git 里的远端跟踪引用、不碰工作区，所以它是纯读；
     · git_push 标 irreversible 不为"删数据"，而为"推出去撤不回"——别人可能已经拉走。
       这一标的实际效果是：即使权限档位是 auto 也会停下来问人（_approvalDecision 的不可逆守卫在放行之前），
       正是想要的；顺带不进子智能体工具集，自主跑的分支不该有推送能力。
     · git_reset 同理拦子智能体：soft/mixed 之外服务层已经硬拒 hard，但指针一动，
       后面所有"相对 HEAD 的理解"都变了，交给一个看不到全局的分支去做不明智。 */
  git_fetch:  { readOnly: true, microcompact: true },
  git_blame:  { readOnly: true, microcompact: true },
  git_push:   { mutating: true, irreversible: true, subAgentBlock: true },
  git_pull:   { mutating: true },
  git_reset:  { mutating: true, subAgentBlock: true },
  git_stash:  { mutating: true, readOnlyWhen: (args) => args && args.action === "list" },

  /* P-M1 worktree 副本。一个名字三种动作，所以与 git_branch / git_stash 同一形状：
     list 算纯读（免确认），add/remove 留 mutating。
     remove 会连着删掉副本里未提交的改动 —— 没在契约里标 irreversible，因为标了之后
     "开一份副本"这种纯增动作也会在全自动档被强制打断；改由 handler 对 remove 单传 danger:"high"，
     与 git_branch delete 的既有做法一致。
     subAgentBlock：子智能体看不到用户手上还有什么活，让它去建/删检出等于让它替用户决定哪份可以扔。 */
  git_worktree: { mutating: true, subAgentBlock: true, readOnlyWhen: (args) => args && args.action === "list" },

  // —— 记忆与知识 ——
  search_memory:       { readOnly: true },
  save_session_memory: { subAgentBlock: true },

  // —— 技能 ——
  /* create_skill 会往技能库落盘，而技能正文会被 use_skill / 目录注入读回上下文，
     所以它不是"写一份普通文件"，而是"往后续会话的提示里插一段自己控制的文本"。
     标 mutating 的三个后果都是想要的：规划模式拦它、改盘后做风险回灌、不设执行超时。
     真正的注入防线在 P2-4 落盘的 memory-tools.js 审计 + use_skill 边界标记里，
     这里是第二道 —— 漏掉 mutating 的话规划模式会直接放行一条持久化注入通道。 */
  create_skill: { mutating: true },
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
  /* orchestrate 补进子智能体黑名单（收掉原"已知偏差 3"）：
     迁移前它能被子智能体调用，于是"子代理里再开一轮编排"是条没人测过的路径 ——
     P5 之后并行改盘按文件认领、隔离按同层设计，嵌套编排会让归属和收回都失去唯一真相源。
     与 agent 同一个理由：要深就回父智能体重新拆步骤，而不是让分支自己再生分支。 */
  orchestrate: { waitFree: true, subAgentBlock: true },
  /* 共享白板：写在内存里、不落工作区 → 按"纯读"那一档放行（不弹确认、可与别的只读调用并行）。
     只给子智能体：父智能体拿到它只会往一块没人读的板上写字，那份 schema 每轮都白占 token。 */
  board:       { readOnly: true, microcompact: true, subAgentOnly: true },

  // —— 网络 ——（openWorld：请求发到这台机器之外，影响不在本地留痕）
  web_search: { readOnly: true, microcompact: true, openWorld: true },
  web_fetch:  { readOnly: true, microcompact: true, openWorld: true },


  /* —— 浏览器自动化（agent-browser / CDP）——
     判读走无障碍树文本，像素只落盘给人看，所以工具结果仍是字符串（不必动消息层）。
     · readOnly 的四个（快照/读正文/等待/标签列表）等价于 web_fetch 那一档：只向外取，不落地到工作区；
       但它们全部带 stateful —— agent-browser 一个会话只有一个"活跃标签页"，ref 属于快照那一刻的
       那一页，并行两发会让后一发读到前一发的页面，结论直接是错的。
     · 会改动页面状态的一律 mutating：规划模式要拦它（Cursor 的 plan mode 三条护栏里就有浏览器保护），
       且 semi/ask 档下逐次向用户要授权 —— 在真实浏览器里点按钮等于以用户身份发请求。
     · 全家拦子智能体：会话名按 convId 派生，同一对话下的并行子代理会共用同一个浏览器、
       互相把对方的页面导航走。要放开得先做到"每个子代理一个 session"，那是另一件事。
     · browser_eval 额外在 handler 里显式要授权（它能以页面身份发任意请求），
       browser_close 即使是 mutating 也必须拦子代理：子代理收尾会把主流程正在用的浏览器一起关掉。 */
  browser_open:     { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },
  browser_navigate: { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },
  browser_snapshot: { readOnly: true, stateful: true, microcompact: true, subAgentBlock: true, openWorld: true, maxResultSizeChars: 20000 },
  browser_click:    { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },
  browser_fill:     { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },
  browser_press:    { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },
  browser_select:   { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },
  browser_read:     { readOnly: true, stateful: true, microcompact: true, subAgentBlock: true, openWorld: true },

  /* browser_assert 与 browser_eval 都走 eval，但性质不同，判读值得单列一行：
     eval 执行的是模型现写的 JS（能以页面身份发任意请求 → mutating + 逐次授权）；
     assert 执行的是我们固定写死的一段"读观察值"程序，模型只能塞进 CSS 选择器和期望值
     （它们经 JSON.stringify 成为字面量，塞不进代码），所以它是只读 —— 但同样 stateful：
     读的是"当前活跃标签页在这一刻"的 DOM，和别的手势并发就会验到别人的页面。
     拦子智能体的理由与全家一致：会话名按 convId 派生，两个分支共用同一个浏览器。 */
  browser_assert:   { readOnly: true, stateful: true, microcompact: true, subAgentBlock: true, openWorld: true },
  browser_tabs:     { readOnly: true, stateful: true, microcompact: true, subAgentBlock: true, openWorld: true },
  browser_wait:     { readOnly: true, stateful: true, microcompact: true, subAgentBlock: true, openWorld: true },
  browser_screenshot: { microcompact: true, subAgentBlock: true, openWorld: true },
  browser_eval:     { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },
  browser_close:    { mutating: true, subAgentBlock: true, openWorld: true },


  /* —— 电脑控制（UI Automation，常驻 PowerShell worker）——
     判读同样是文本（控件树），所以工具结果通道不用动。
     · 三个"看"的算 readOnly：列窗口 / 读控件树 / 取控件文本都只读 UIA 属性，不改任何东西；
       带 stateful —— worker 里的 ref 缓存是**进程级一份**，ref 的有效期跟着界面走，
       并行两发读不同窗口没问题，但和写类操作并发就会让"我看到的界面"和"我点下去的界面"错位。
     · 五个"动"的全算 mutating：规划模式拦、semi/ask 逐次要授权。
       坐标点击与按键是真会抢走用户鼠标键盘的动作，handler 里另传 danger 让审批卡标红。
     · desktop_window 的 close 走 WM_CLOSE（等同用户点叉），有未保存提示的会弹那个提示，
       所以不标 irreversible —— 标了反而会让 activate/move 这些纯增动作也在 auto 档被拦。
     · 全家拦子智能体：桌面只有一个前台焦点，两个并行分支同时敲键盘必然互相打断，
       而且谁都看不到"现在焦点在谁那儿"。 */
  desktop_windows:   { readOnly: true, stateful: true, microcompact: true, subAgentBlock: true, openWorld: true },
  desktop_snapshot:  { readOnly: true, stateful: true, microcompact: true, subAgentBlock: true, openWorld: true, maxResultSizeChars: 20000 },
  desktop_read:      { readOnly: true, stateful: true, microcompact: true, subAgentBlock: true, openWorld: true },
  desktop_screenshot: { microcompact: true, subAgentBlock: true, openWorld: true },
  desktop_click:     { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },
  desktop_type:      { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },
  desktop_press:     { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },
  desktop_scroll:    { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },
  desktop_window:    { mutating: true, microcompact: true, subAgentBlock: true, openWorld: true },


  // —— 外部 MCP ——
  /* tool_search 只是把已在内存里的工具定义抄给模型看（并把它排进下一轮的工具列表），
     本身不连服务器、不发请求 → 纯读。真正连外的 mcp__* 不在表里，走 contractOf 的
     fail-closed 默认（需要人工确认），这条纪律迁移前后一致。 */
  list_mcp:    { readOnly: true, microcompact: true },
  tool_search: { readOnly: true, microcompact: true },

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
    subAgentOnly: !!c.subAgentOnly,
    readOnlyWhen: typeof c.readOnlyWhen === "function" ? c.readOnlyWhen : null,
    // 未登记 / 未声明 = 通用值，行为与加这三个字段之前逐字相同
    maxResultSizeChars: typeof c.maxResultSizeChars === "number" ? c.maxResultSizeChars : DEFAULT_RESULT_CEILING,
    interruptBehavior: c.interruptBehavior === "cancel" ? "cancel" : "block",
    openWorld: !!c.openWorld,
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
  SUB_AGENT_ONLY: new Set(names((c) => c.subAgentOnly)),
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
    /* 既是纯读又标了"撤不回来"是不成立的组合，出现即说明表被改坏了；
       irreversible 配 cancel 同样不成立：撤不回的东西不能放弃等待它跑完。 */
    return (c.readOnly && c.irreversible) || (c.readOnly && c.mutating)
      || (c.irreversible && c.interruptBehavior === "cancel");
  });
  /* 新字段的形状检查：写错一个数字/字符串不会报错，只会静默改变截断与停止行为，
     所以宁可启动就响亮失败（与本文件"漏登记是静默劣化"的立场一致）。 */
  const malformed = Object.keys(CONTRACT).filter((n) => {
    const raw = CONTRACT[n];
    const ceil = raw.maxResultSizeChars;
    const badCeil = ceil !== undefined && !(typeof ceil === "number" && (ceil === Infinity || ceil > 0));
    const badInterrupt = raw.interruptBehavior !== undefined
      && raw.interruptBehavior !== "cancel" && raw.interruptBehavior !== "block";
    return badCeil || badInterrupt;
  });
  if (!missing.length && !orphan.length && !contradictions.length && !malformed.length) return null;
  return { missing, orphan, contradictions, malformed };
}


/* 已知偏差（照实记录，不在"纯迁移"这一步偷偷改行为）：
   1. run_command 被标了 microcompact（与迁移前一致）：清掉的是"很久以前的命令输出"，
      模型要看就重跑一次 —— 而重跑一条有副作用的命令并不总是安全的。
      真正稳的做法是把 microcompact 限定到只读工具，那要重新量一次压缩收益，另开一项。
   2. web_fetch / web_search 归 readOnly：它们会向外发请求（只读地取），
      与"不向外部发送数据"的安全准则措辞完全一致（同为 P2-3 已补的 SSRF 边界），先保持判定不变。
   3. （已收口，P5）orchestrate 过去不在子智能体黑名单里而 agent 在，于是子智能体能再开一轮编排。
      现在与 agent 同档拦掉：并行改盘的归属与收回按"同层兄弟"设计，嵌套编排会让一份文件的归属有两个主人。
      这是行为变更，改在这里而不是顺手混进迁移那一步 —— 需要深任务请回父智能体重新拆步骤。 */

module.exports = { CONTRACT, contractOf, isReadOnly, DERIVED, auditContract, DEFAULT_RESULT_CEILING };
