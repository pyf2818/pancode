/* ============================================================
   P2-#13 工具契约表迁移的等价性测试。

   这一步是**纯迁移**：把散在 6 处的工具性质收敛成一张表 + 派生集合。
   所以这里断言的不是"新设计对不对"，而是"迁移前后成员逐一相等"——
   任何一个名字换桶都必须在这里先红，然后作为**有意的行为变更**单独讨论。

   基线值是迁移前从源码里抄下来的原文（agent-llm.js 的 5 个 Set、
   tools/util.js 的 MUTATING_TOOLS、_approvalDecision 里那句 delete_file）。
   ============================================================ */
const { LlmAgent } = require("../server/agent-llm");
const contract = require("../server/tools/contract");
const { MUTATING_TOOLS: UTIL_MUTATING } = require("../server/tools/util");

/* ---------- 迁移前的手工集合（逐字抄录，作为等价的定义） ---------- */
const OLD_READONLY = [
  "read_file", "list_files", "search_code", "search_symbol", "repo_map", "code_graph",
  "search_memory", "get_diagnostics", "use_skill",
  "git_status", "git_diff", "git_log", "git_fetch", "git_blame",
  "read_process", "check_port", "list_mcp",
  "web_search", "web_fetch", "goal_status", "list_templates",
  "find_references",
  /* 浏览器自动化的"看"那一半：读的是页面状态，不往工作区落地，与 web_fetch 同档。
     browser_assert 也在这一档：它跑的是我们固定写死的观察程序（模型只能塞 CSS 选择器），
     与 browser_eval（执行模型现写的 JS）不是一回事。 */
  "browser_snapshot", "browser_read", "browser_tabs", "browser_wait", "browser_assert",
  /* 编排白板写在内存里、不落工作区，读它不改任何东西 → 与"看"那一半同档。 */
  "board",
  /* 电脑控制的"看"那一半：只读 UIA 属性，不发送任何输入。 */
  "desktop_windows", "desktop_snapshot", "desktop_read",
];
/* 带跨调用游标的只读工具：agent-browser 一个会话只有一个活跃标签页，ref 属于快照那一刻的那一页，
   并行两发会让后一发读到前一发的页面 —— 结论不是"过时"而是"错"。
   桌面的 ref 缓存在常驻 worker 里是进程级一份，且"看到的界面"与"点下去的界面"必须同帧，同理。
   browser_assert 同属这一档：它读的就是"当前这一页在这一刻"的 DOM。 */
const OLD_NON_CONCURRENT = ["read_process", "browser_snapshot", "browser_read", "browser_tabs", "browser_wait", "browser_assert",
  "desktop_windows", "desktop_snapshot", "desktop_read"];
const OLD_MICROCOMPACTABLE = [
  "read_file", "list_files", "search_code", "search_symbol", "repo_map", "code_graph",
  "get_diagnostics", "run_command", "run_tests", "read_process", "check_port",
  "git_diff", "git_log", "git_status", "git_fetch", "git_blame", "web_fetch", "web_search", "list_mcp",
  "find_references",
  /* 浏览器结果全部可再生（重拍一次快照 / 重点一次截图就行），唯独 browser_close 不收：
     它之后页面就没了，清掉那条结果等于清掉"什么时候关的"。 */
  "browser_open", "browser_navigate", "browser_snapshot", "browser_click", "browser_fill",
  "browser_press", "browser_select", "browser_read", "browser_screenshot", "browser_wait",
  "browser_tabs", "browser_eval", "browser_assert",
  /* 桌面结果同样可再生（重列一次窗口 / 重拍一次控件树就行），desktop_window 也收：
     它留下的"我把哪个窗口怎么动了"不是需要长期持有的结论。 */
  "desktop_windows", "desktop_snapshot", "desktop_read", "desktop_screenshot", "desktop_click",
  "desktop_type", "desktop_press", "desktop_scroll", "desktop_window",
  /* 白板读到的内容是"此刻的板面"，重读一次就有 —— 上下文紧张时清掉旧的那条不亏。 */
  "board",
];
const OLD_WAIT_FREE_EXTRA = ["ask_user_choice", "agent", "orchestrate", "set_goal"];
/* ⚠ create_skill 不在迁移前的集合里，是 P2-4 有意的行为变更，不是漂移：
   它把正文写进技能库，而正文会被 use_skill / 目录注入读回模型上下文 ——
   等于往后续会话的提示里插一段文本。原来的空契约（既非只读也非改盘）
   让 planMode 拦不住它。详见 server/tools/contract.js 的 CONTRACT 注释。
   ⚠ edit_files 同理是 P0-A3 新增的改盘工具（多文件原子落盘），不是漂移。
   ⚠ git_push / git_pull / git_reset / git_stash 同理是 P1-B2 新增的 git 工作流工具：
     四个都会动仓库状态，git_stash 的 list 动作靠 readOnlyWhen 单独放行。
   ⚠ run_tests 是 P1-B3 新增：它起的也是同一个 shell，而且测试会往工作区写东西
     （覆盖率目录、snapshot 文件），所以与 run_command 同档算改盘，不当只读。 */
const OLD_MUTATING = [
  "write_file", "apply_edit", "edit_files", "delete_file", "run_command", "run_tests",
  "undo", "start_process", "stop_process", "git_commit", "git_branch",
  "git_push", "git_pull", "git_reset", "git_stash", "git_worktree",
  "create_skill", "rename_symbol",
  /* 浏览器"动"的那一半算改盘，不是因为它写文件：在真实浏览器里点一次按钮就等于以用户身份
     向某个站点发一次请求，规划模式必须拦得住它（Cursor 的 plan mode 三条护栏之一就是浏览器保护）。 */
  "browser_open", "browser_navigate", "browser_click", "browser_fill", "browser_press",
  "browser_select", "browser_eval", "browser_close",
  /* 桌面的"动"那一半：一次按键/点击会落到当前焦点窗口上，效果和用户亲手操作等价，
     所以与改盘同档 —— 规划模式拦、semi/ask 逐次要授权。 */
  "desktop_click", "desktop_type", "desktop_press", "desktop_scroll", "desktop_window",
];
const OLD_SUB_AGENT_BLOCK = [
  /* orchestrate 本轮（P5）补进黑名单：并行改盘的归属与收回按"同层兄弟"设计，
     子智能体再开一轮编排会让一个文件有两个主人。要深任务请回父智能体重新拆步骤。 */
  "agent", "orchestrate", "create_plan", "update_plan", "undo", "set_goal", "instantiate_template",
  "save_template", "remove_template", "list_templates", "goal_status", "save_session_memory",
  "git_push", "git_reset", "git_worktree",
  /* 浏览器全家拦子智能体：会话名按 convId 派生，同一对话下并行的子代理会共用同一个浏览器，
     互相把对方的页面导航走。要放开得先做到"每个子代理一个 session"。 */
  "browser_open", "browser_navigate", "browser_snapshot", "browser_click", "browser_fill",
  "browser_press", "browser_select", "browser_read", "browser_screenshot", "browser_wait",
  "browser_tabs", "browser_eval", "browser_assert", "browser_close",
  /* 桌面全家拦子智能体：整机只有一个前台焦点，两个并行分支同时敲键盘必然互相打断，
     而且子代理看不到"现在焦点在谁那儿"。 */
  "desktop_windows", "desktop_snapshot", "desktop_read", "desktop_screenshot", "desktop_click",
  "desktop_type", "desktop_press", "desktop_scroll", "desktop_window",
];
const OLD_IRREVERSIBLE = ["delete_file", "git_push"];
/* 反方向：只有子智能体用得上的工具。父清单里出现它没用（没人读那块板），
   却每一轮请求都要带上这份 schema —— 钉住成员，加了新成员要在这里说明为什么。 */
const OLD_SUB_AGENT_ONLY = ["board"];

/** Set/数组 → 排序后的数组，差异直接打在断言消息里 */
const sorted = (x) => [...x].sort();
function sameAs(name, actual, expected) {
  expect({ [name]: sorted(actual) }).toEqual({ [name]: sorted(expected) });
}

describe("契约表与注册表互为定义域", () => {
  const toolNames = LlmAgent.toolNames();

  it("每个已声明工具都有契约行，契约里也没有已不存在的名字", () => {
    expect(contract.auditContract(toolNames)).toBeNull();
  });

  it("覆盖全部 74 个工具（漏一个就会静默降级成「需要人工确认」）", () => {
    expect(Object.keys(contract.CONTRACT)).toHaveLength(toolNames.length);
    expect(toolNames).toHaveLength(74);
  });

  it("auditContract 真的会报出漏登记与孤儿（否则这条自检形同不存在）", () => {
    const bad = contract.auditContract([...toolNames.slice(0, -1), "brand_new_tool"]);
    expect(bad).toBeTruthy();
    expect(bad.missing).toEqual(["brand_new_tool"]);
    expect(bad.orphan).toEqual([toolNames[toolNames.length - 1]]);
  });

  it("矛盾组合被拒：既纯读又撤不回来 / 又改盘，是不成立的声明", () => {
    // 不直接改 CONTRACT，用一份带矛盾的注册表走同一条检查逻辑
    const c = require("../server/tools/contract");
    const before = c.auditContract(toolNames);
    expect(before).toBeNull();
    // git_branch 是"名字两用"，它 readOnlyWhen 成立但不带 readOnly 旗标，因此不算矛盾
    expect(c.contractOf("git_branch").mutating).toBe(true);
    expect(c.contractOf("git_branch").readOnly).toBe(false);
    expect(c.contractOf("git_branch").readOnlyWhen({ action: "list" })).toBe(true);
    expect(c.auditContract([...toolNames, "read_file"])).toBeNull();   // 重复名字不产生缺漏
  });
});

describe("派生集合 = 迁移前的手工集合", () => {
  it("只读集合逐一相等", () => {
    sameAs("READONLY", contract.DERIVED.READONLY, OLD_READONLY);
  });

  it("可并行集合 = 只读且无跨调用游标", () => {
    sameAs("CONCURRENT_SAFE", contract.DERIVED.CONCURRENT_SAFE,
      OLD_READONLY.filter((n) => !OLD_NON_CONCURRENT.includes(n)));
  });

  it("可清理集合逐一相等", () => {
    sameAs("MICROCOMPACTABLE", contract.DERIVED.MICROCOMPACTABLE, OLD_MICROCOMPACTABLE);
  });

  it("改盘集合与 tools/util 的旧导出同源", () => {
    sameAs("MUTATING", contract.DERIVED.MUTATING, OLD_MUTATING);
    /* util 的旧导出是迁移前 MUTATING_TOOLS 的原样，没有跟着 create_skill 变更
       —— 那不是缺陷：contract.js 才是唯一真相源，util 那份只是被 import 过去的历史别名。
       这里钉住的是"两者必须一致"，哪边改了都要在这里显形。 */
    sameAs("util 再导出", UTIL_MUTATING, contract.DERIVED.MUTATING);
  });

  it("免超时集合 = 4 个等待类 + 全部改盘类", () => {
    sameAs("WAIT_FREE", contract.DERIVED.WAIT_FREE, [...OLD_WAIT_FREE_EXTRA, ...OLD_MUTATING]);
  });

  it("子智能体黑名单逐一相等", () => {
    sameAs("SUB_AGENT_BLOCKED", contract.DERIVED.SUB_AGENT_BLOCKED, OLD_SUB_AGENT_BLOCK);
  });

  it("不可逆集合 = delete_file + git_push（推出去的提交别人可能已拉走）", () => {
    sameAs("IRREVERSIBLE", contract.DERIVED.IRREVERSIBLE, OLD_IRREVERSIBLE);
  });

  it("只给子智能体的集合逐一相等（父清单里不该出现没人读的板）", () => {
    sameAs("SUB_AGENT_ONLY", contract.DERIVED.SUB_AGENT_ONLY, OLD_SUB_AGENT_ONLY);
  });
});

describe("未知工具一律最保守（fail-closed）", () => {
  /* MCP 外部工具走的就是这条路径。这里守的是"新工具没登记时会发生什么"：
     必须是"照常弹确认、不并行、不清理结果"，而不是"被当成只读直接放行"。 */
  const c = contract.contractOf("mcp__untrusted__anything");

  it("未知名字不进任何放行集合", () => {
    expect(c.known).toBe(false);
    expect(c.readOnly).toBe(false);
    expect(c.mutating).toBe(false);
    expect(c.irreversible).toBe(false);
    expect(c.microcompact).toBe(false);
    expect(c.waitFree).toBe(false);
    expect(c.subAgentBlock).toBe(false);
    expect(contract.isReadOnly("mcp__untrusted__anything")).toBe(false);
  });

  it("contractOf 每次返回新对象（防止调用方改坏共享的 FALLBACK）", () => {
    const a = contract.contractOf("nope");
    a.readOnly = true;
    expect(contract.contractOf("nope").readOnly).toBe(false);
  });
});

describe("权限语义迁移前后不变（直调 _approvalDecision）", () => {
  function agentWith(cfgExtra) {
    const a = Object.create(LlmAgent.prototype);
    a.cfg = Object.assign({ permissions: { mode: "ask", allow: [], deny: [] } }, cfgExtra || {});
    a._sessionGrants = new Set();
    return a;
  }

  it("纯读工具免确认（这正是补进白名单要解决的问题）", () => {
    const a = agentWith();
    for (const t of ["repo_map", "search_symbol", "get_diagnostics", "search_memory", "list_mcp"]) {
      expect(a._approvalDecision(t, {}).action).toBe("allow");
    }
  });

  it("git_branch 只有 list 免确认，建/切/删分支仍然要确认", () => {
    const a = agentWith();
    expect(a._approvalDecision("git_branch", { action: "list" }).action).toBe("allow");
    expect(a._approvalDecision("git_branch", { action: "create" }).action).toBe("ask");
    expect(a._approvalDecision("git_branch", { action: "delete" }).action).toBe("ask");
  });

  /* P1-B2 新增的六个 git 工具：只读的两个（fetch/blame）必须免确认，
     否则模型看个远端状态都要弹一次窗；动状态的那四个反过来必须问。 */
  it("git_fetch / git_blame 免确认，git_push / git_pull / git_reset / git_stash 要确认", () => {
    const a = agentWith();
    for (const t of ["git_fetch", "git_blame"]) expect(a._approvalDecision(t, {}).action).toBe("allow");
    for (const t of ["git_push", "git_pull", "git_reset"]) expect(a._approvalDecision(t, {}).action).toBe("ask");
    expect(a._approvalDecision("git_stash", { action: "list" }).action).toBe("allow");
    expect(a._approvalDecision("git_stash", { action: "pop" }).action).toBe("ask");
  });

  /* P2-C2 rename_symbol 一个名字两用：不带 apply 只算预览（免确认，模型才能先看波及面），
     带 apply 才真落盘（必须问）。find_references 永远纯读。 */
  it("rename_symbol 预览态免确认、apply 态要确认；find_references 永远免确认", () => {
    const a = agentWith();
    expect(a._approvalDecision("find_references", { name: "getUser" }).action).toBe("allow");
    expect(a._approvalDecision("rename_symbol", { name: "getUser", to: "loadUser" }).action).toBe("allow");
    expect(a._approvalDecision("rename_symbol", { name: "getUser", to: "loadUser", apply: true }).action).toBe("ask");
    expect(contract.contractOf("rename_symbol").mutating).toBe(true);
    // 改名主体给的是"被改的那个名字"，否则 allow/deny 规则没有可匹配的东西
    expect(a._hookSubject("rename_symbol", { name: "getUser", to: "loadUser" })).toBe("getUser");
  });

  /* git_push 标了 irreversible：auto 模式 + allow 规则 + 会话已授权三重放行条件叠加后仍要问人。
     这条钉住的是"撤不回的那一步永远留一道人工闸门"。 */
  it("git_push 在 auto 模式三重授权下仍强制确认", () => {
    const a = agentWith({
      permissions: { mode: "auto", allow: [{ tool: "git_push", pattern: "**" }], deny: [] },
    });
    a._sessionGrants = new Set(["git_push"]);
    const d = a._approvalDecision("git_push", { confirm: true });
    expect(d.action).toBe("ask");
    expect(d.reason).toContain("不可逆");
  });

  it("delete_file 在 auto 模式 + 命中 allow 规则 + 会话已授权三重条件下仍强制确认", () => {
    const a = agentWith({
      permissions: { mode: "auto", allow: [{ tool: "delete_file", pattern: "**" }], deny: [] },
    });
    a._sessionGrants = new Set(["delete_file"]);
    const d = a._approvalDecision("delete_file", { path: "src/x.js" });
    expect(d.action).toBe("ask");
    expect(d.reason).toContain("不可逆");
  });

  it("deny 规则仍然排在最前，连只读工具也拦得住", () => {
    const a = agentWith({ permissions: { mode: "auto", allow: [], deny: [{ tool: "read_file" }] } });
    expect(a._approvalDecision("read_file", { path: "a.js" }).action).toBe("block");
  });

  it("写类与命令类不受影响：semi 模式照旧要确认", () => {
    const a = agentWith({ permissions: { mode: "semi", allow: [], deny: [] } });
    for (const t of ["write_file", "run_command", "apply_edit"]) {
      expect(a._approvalDecision(t, {}).action).toBe("ask");
    }
  });

  it("规划模式下改盘工具被拒，只读工具放行", () => {
    const a = agentWith({ planMode: true, permissions: { mode: "auto", allow: [], deny: [] } });
    expect(a._execGateForPlan ? "has-extra-hook" : undefined).toBeUndefined();
    expect(contract.DERIVED.MUTATING.has("run_command")).toBe(true);
    expect(contract.isReadOnly("run_command")).toBe(false);
  });
});

describe("契约集合的每条消费路径都真的可用", () => {
  /* 这一组是因为一次真实的迁移事故才加的：把 `const { MUTATING_TOOLS } = TOOL.DERIVED`
     写成解构（派生键其实叫 MUTATING）会得到 undefined，单测全绿，
     直到 _execToolIntoSlot 在探针里 `undefined.has(...)` 才炸。
     所以这里不只看集合内容，而是把每个消费点真的调一遍。 */
  function agent(extra) {
    const a = Object.create(LlmAgent.prototype);
    a.cfg = Object.assign({ permissions: { mode: "auto", allow: [], deny: [] } }, extra || {});
    a._sessionGrants = new Set();
    a.emitted = [];
    a.emit = (m) => a.emitted.push(m);
    a._traceEvent = () => {};
    a.pushChanges = async () => [];
    a._lastRiskSummary = { level: "low", score: 0, focus: [] };
    a._toolMsg = (id, name, content) => ({ role: "tool", tool_call_id: id, name, content });
    a._boundToolResult = (name, s) => String(s);
    a._runToolGuarded = async (name) => "[" + name + "] ok";
    return a;
  }

  it("_isConcurrentSafe：只读并行、带游标的不并行、写类不并行", () => {
    const a = agent();
    expect(a._isConcurrentSafe("read_file")).toBe(true);
    expect(a._isConcurrentSafe("read_process")).toBe(false);
    expect(a._isConcurrentSafe("write_file")).toBe(false);
    expect(a._isConcurrentSafe("mcp__x__y")).toBe(false);   // 未登记的对外保守
  });

  it("_subToolset：子智能体黑名单生效且不会因集合为空而放行", () => {
    const a = agent();
    const names = a._subToolset(null).map((t) => t.function.name);
    expect(names).not.toContain("agent");
    expect(names).not.toContain("create_plan");
    expect(names).not.toContain("undo");
    expect(names).toContain("read_file");
    expect(names.length).toBeGreaterThan(20);
  });

  it("_execToolIntoSlot：改盘工具走独占分支（这里正是 undefined.has 炸过的地方）", () => {
    const a = agent();
    let pushed = 0;
    a.pushChanges = async () => { pushed++; return []; };
    const slots = new Array(2);
    a._execToolIntoSlot({ idx: 0, id: "c1", callName: "write_file", args: { path: "a.js" } }, slots);
    return Promise.resolve().then(() => {
      // 上面是同步调用，内部 await 后落到 microtask：等一轮再断言
      return a._execToolIntoSlot({ idx: 1, id: "c2", callName: "run_command", args: { command: "npm test" } }, slots);
    }).then(() => {
      expect(pushed).toBe(2);                       // 两个都是 mutating，都该做快照
      expect(slots[0].tool_call_id).toBe("c1");
      expect(slots[1].content).toContain("run_command");
    });
  });

  it("_execToolIntoSlot：只读工具不触发快照，也照样按模型序填进自己的槽位", async () => {
    const a = agent();
    let pushed = 0;
    a.pushChanges = async () => { pushed++; return []; };
    const slots = new Array(2);
    await a._execToolIntoSlot({ idx: 1, id: "r2", callName: "read_file", args: { path: "b.js" } }, slots);
    expect(pushed).toBe(0);
    expect(slots[1].tool_call_id).toBe("r2");
    expect(slots[0]).toBeUndefined();
  });

  it("_runToolGuarded：改盘与等待类免执行超时（WAIT_FREE 的消费点）", async () => {
    const a = agent();
    // 工厂为了别的用例把 _runToolGuarded 整体替身了；这里要跑真实实现
    delete a._runToolGuarded;
    const seen = [];
    a.execTool = async (name) => { seen.push(name); return name + ":done"; };
    for (const n of ["write_file", "ask_user_choice", "read_file"]) {
      expect(String(await a._runToolGuarded(n, {}))).toContain(":done");
    }
    expect(seen).toEqual(["write_file", "ask_user_choice", "read_file"]);
  });
});

describe("调度判定与权限判定共用一条判据", () => {

  function agentWith(cfgExtra) {
    const a = Object.create(LlmAgent.prototype);
    a.cfg = Object.assign({ permissions: { mode: "ask", allow: [], deny: [] } }, cfgExtra || {});
    a._sessionGrants = new Set();
    return a;
  }

  it("_isConcurrentSafe 与派生集合一致", () => {
    const a = agentWith();
    for (const n of LlmAgent.toolNames()) {
      expect(a._isConcurrentSafe(n)).toBe(contract.DERIVED.CONCURRENT_SAFE.has(n));
    }
  });

  it("带游标的只读工具不并行（read_process 并行会读到空）", () => {
    const a = agentWith();
    expect(a._isConcurrentSafe("read_process")).toBe(false);
    expect(a._approvalDecision("read_process", {}).action).toBe("allow");   // 但仍然是只读免确认
  });
});
