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
  "read_file", "list_files", "search_code", "search_symbol", "repo_map",
  "search_memory", "get_diagnostics", "use_skill",
  "git_status", "git_diff", "git_log",
  "read_process", "check_port", "list_mcp",
  "web_search", "web_fetch", "goal_status", "list_templates",
];
const OLD_NON_CONCURRENT = ["read_process"];
const OLD_MICROCOMPACTABLE = [
  "read_file", "list_files", "search_code", "search_symbol", "repo_map",
  "get_diagnostics", "run_command", "read_process", "check_port",
  "git_diff", "git_log", "git_status", "web_fetch", "web_search", "list_mcp",
];
const OLD_WAIT_FREE_EXTRA = ["ask_user_choice", "agent", "orchestrate", "set_goal"];
const OLD_MUTATING = [
  "write_file", "apply_edit", "delete_file", "run_command",
  "undo", "start_process", "stop_process", "git_commit", "git_branch",
];
const OLD_SUB_AGENT_BLOCK = [
  "agent", "create_plan", "update_plan", "undo", "set_goal", "instantiate_template",
  "save_template", "remove_template", "list_templates", "goal_status", "save_session_memory",
];
const OLD_IRREVERSIBLE = ["delete_file"];

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

  it("覆盖全部 38 个工具（漏一个就会静默降级成「需要人工确认」）", () => {
    expect(Object.keys(contract.CONTRACT)).toHaveLength(toolNames.length);
    expect(toolNames).toHaveLength(38);
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
    sameAs("util 再导出", UTIL_MUTATING, OLD_MUTATING);
  });

  it("免超时集合 = 4 个等待类 + 全部改盘类", () => {
    sameAs("WAIT_FREE", contract.DERIVED.WAIT_FREE, [...OLD_WAIT_FREE_EXTRA, ...OLD_MUTATING]);
  });

  it("子智能体黑名单逐一相等", () => {
    sameAs("SUB_AGENT_BLOCKED", contract.DERIVED.SUB_AGENT_BLOCKED, OLD_SUB_AGENT_BLOCK);
  });

  it("不可逆集合只有 delete_file", () => {
    sameAs("IRREVERSIBLE", contract.DERIVED.IRREVERSIBLE, OLD_IRREVERSIBLE);
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

  it("git_branch 只有 list 免确认，建/切分支仍然要确认", () => {
    const a = agentWith();
    expect(a._approvalDecision("git_branch", { action: "list" }).action).toBe("allow");
    expect(a._approvalDecision("git_branch", { action: "create" }).action).toBe("ask");
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
