/* ============================================================
   P0 内核修复回归（对标 deepseek-harness / ZCode 的三条不变式）
   - token 估算对 CJK 计权：中文载荷不能再被低估（低估 → 压缩触发过晚 → 上游 400）
   - 压缩选区按「轮次组」切：绝不产出没有 assistant.tool_calls 配对的孤儿 role:"tool"
   - shrink 检查：摘要没让历史变小就不替换（否则「压缩」退化成放大器）
   - 存档修复：半截轮次（中断时留下的 dangling tool_calls）加载时补保守结果
   - 权限链：不可逆操作不能被 mode==="auto" 的放行分支绕过
   纯函数 + Object.create 原型直调，不碰磁盘也不连 LLM。
   ============================================================ */
const { LlmAgent, _ctx } = require("../server/agent-llm");

const { estTextTokens, groupHistoryByToolPairing, repairToolPairing } = _ctx;

/* ---------- 测试装配 ---------- */
function makeAgent(cfgExtra) {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = Object.assign({
    llm: { contextWindow: 100000 },
    context: { budgetTokens: 1000000, autoCompact: true },
    memory: { enabled: false },
    permissions: { mode: "ask", allow: [], deny: [] },
  }, cfgExtra || {});
  a.history = [];
  a._lastPrompt = 0;
  a._lastPromptLen = 0;
  a._usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  a.emitted = [];
  a.emit = (m) => a.emitted.push(m);
  a._traceEvent = () => {};
  a._consolidateMemory = () => {};
  return a;
}

/** 校验一条历史里 tool_call / tool result 严格成对且顺序合法 */
function pairingErrors(history) {
  const errs = [];
  const open = [];
  let declared = new Set();
  for (const m of history) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const t of m.tool_calls) declared.add(t.id);
    }
  }
  for (const m of history) {
    if (m.role === "tool") {
      if (!declared.has(m.tool_call_id)) errs.push("孤儿 tool 结果 " + m.tool_call_id);
      while (open.length && !open.includes(m.tool_call_id)) open.shift();
      if (!open.length) errs.push("tool 结果出现在任何请求之前：" + m.tool_call_id);
      else open.splice(open.indexOf(m.tool_call_id), 1);
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      // 上一批还没收干就又来了新的 assistant —— 说明有 call 没拿到结果
      if (open.length) errs.push("未收到结果的 call: " + open.join(","));
      for (const t of m.tool_calls) open.push(t.id);
      continue;
    }
    if (open.length && (m.role === "user" || m.role === "system")) {
      errs.push("未收到结果的 call: " + open.join(","));
      open.length = 0;
    }
  }
  if (open.length) errs.push("结尾仍有未配对 call: " + open.join(","));
  return errs;
}

const T = (id, name, args) => ({ id, type: "function", function: { name: name || "read_file", arguments: JSON.stringify(args || {}) } });
const asst = (content, calls) => { const m = { role: "assistant", content: content || "" }; if (calls) m.tool_calls = calls; return m; };
const tool = (id, content) => ({ role: "tool", tool_call_id: id, content: content == null ? "ok" : content });

/* ============================================================
   1. token 估算：CJK 权重
   ============================================================ */
describe("estTextTokens / _estTokens — 中文载荷不再被低估", () => {
  it("纯 ASCII 仍按 len/4", () => {
    expect(estTextTokens("abcdefgh")).toBe(2);
  });

  it("单个汉字按 2 个估算字符计（=0.5 token/字），而不是 0.25", () => {
    expect(estTextTokens("中")).toBe(1);          // ceil(2/4)
    expect(estTextTokens("四个字")).toBe(2);       // ceil(6/4)
    expect(estTextTokens("一二三四五六七八九十")).toBe(5); // 10 字 → ceil(20/4)
  });

  it("全角标点与谚文、假名同样计权", () => {
    for (const s of ["，。！？", "abcdef", "カタカナ", "한글글자"]) {
      expect(estTextTokens(s)).toBeGreaterThanOrEqual(estTextTokens("abcdef"));
    }
  });

  it("空串与 null 不抛错", () => {
    expect(estTextTokens("")).toBe(0);
    expect(estTextTokens(null)).toBe(0);
    expect(estTextTokens(undefined)).toBe(0);
  });

  it("_estTokens：同长度中文历史估算值 ≥ 英文，且 tool_calls 参数也计权", () => {
    const a = makeAgent();
    const cn = a._estTokens([{ role: "user", content: "请帮我把这个模块重构一下并补上单元测试" }]);
    const en = a._estTokens([{ role: "user", content: "refactor" }]);
    expect(cn).toBeGreaterThan(en);
    const withArgs = a._estTokens([asst("", [T("c1", "write_file", { path: "a.js", content: "中文中文中文中文" })])]);
    const without = a._estTokens([asst("", [])]);
    expect(withArgs).toBeGreaterThan(without);
  });

  it("多模态数组内容里的 text 段同样走 CJK 权重", () => {
    const a = makeAgent();
    const arr = a._estTokens([{ role: "user", content: [{ type: "text", text: "十二个汉字写在这里了哈" }] }]);
    expect(arr).toBe(a._estTokens([{ role: "user", content: "十二个汉字写在这里了哈" }]));
  });
});

/* ============================================================
   2. 轮次分组：tool 对的边界
   ============================================================ */
describe("groupHistoryByToolPairing — 组边界即配对边界", () => {
  it("一条 assistant + 它的 3 个并行 tool 结果 = 1 组", () => {
    const h = [
      { role: "user", content: "读三个文件" },
      asst("", [T("a"), T("b"), T("c")]),
      tool("a"), tool("b"), tool("c"),
    ];
    const g = groupHistoryByToolPairing(h);
    expect(g.map((x) => x.items.length)).toEqual([1, 4]);
  });

  it("结果只回来一半时，剩余 call 仍留在同一组内（不会被切成两半）", () => {
    const h = [asst("", [T("a"), T("b")]), tool("a"), { role: "user", content: "停" }];
    const g = groupHistoryByToolPairing(h);
    expect(g[0].items.length).toBe(2);   // assistant + tool(a)
    expect(g[1].items[0].role).toBe("user");
  });

  it("孤儿 tool 结果单独成组，不并入前一组", () => {
    const h = [{ role: "user", content: "u" }, tool("ghost")];
    const g = groupHistoryByToolPairing(h);
    expect(g.length).toBe(2);
    expect(g[1].items[0].tool_call_id).toBe("ghost");
  });

  it("分组是无损的：摊平后与原数组逐元素同引用", () => {
    const h = [{ role: "user", content: "u" }, asst("", [T("a"), T("b")]), tool("a"), tool("b"), asst("done")];
    const flat = _ctx.flattenGroups(groupHistoryByToolPairing(h));
    expect(flat.length).toBe(h.length);
    for (let i = 0; i < h.length; i++) expect(flat[i]).toBe(h[i]);
  });
});

/* ============================================================
   3. 压缩选区 + shrink 检查
   ============================================================ */
describe("_selectRetainByTokens — 保留侧永远是完整轮次组", () => {
  const long = (n) => "x".repeat(n);

  function build(nRounds) {
    const h = [];
    for (let i = 0; i < nRounds; i++) {
      h.push({ role: "user", content: "第" + i + "轮请求" + long(400) });
      h.push(asst("思考" + long(400), [T("r" + i + "a"), T("r" + i + "b")]));
      h.push(tool("r" + i + "a", long(1200)));
      h.push(tool("r" + i + "b", long(1200)));
    }
    return h;
  }

  it("任何保留预算下，切点都不会落在 tool 对中间", () => {
    const a = makeAgent();
    const h = build(8);
    for (const budget of [1, 200, 900, 3000, 99999]) {
      const sel = a._selectRetainByTokens(h, budget);
      expect(pairingErrors(sel.recent)).toEqual([]);
      expect(pairingErrors(sel.head)).toEqual([]);
      expect(sel.head.length + sel.recent.length).toBe(h.length);
    }
  });

  it("预算越大保留越多，且至少留两组原文", () => {
    const a = makeAgent();
    const h = build(8);
    const small = a._selectRetainByTokens(h, 100);
    const big = a._selectRetainByTokens(h, 20000);
    expect(big.recent.length).toBeGreaterThan(small.recent.length);
    expect(small.recentGroups).toBeGreaterThanOrEqual(2);
  });
});

describe("compactHistory — 触发、配对、shrink", () => {
  const filler = (n) => "内容内容内容".repeat(n);

  function bigHistory() {
    const h = [{ role: "user", content: "最初的需求：" + filler(300) }];
    for (let i = 0; i < 6; i++) {
      h.push(asst("我在做第 " + i + " 步" + filler(200), [T("t" + i)]));
      h.push(tool("t" + i, "已写入 src/mod" + i + ".js" + filler(200)));  // 命中旧版关键词保留规则
      h.push({ role: "user", content: "第 " + i + " 次追加要求" });
    }
    return h;
  }

  it("未达阈值时原样返回（不产生请求）", async () => {
    const a = makeAgent();
    let called = 0;
    a._summarize = async () => { called++; return "摘要"; };
    const small = [{ role: "user", content: "短" }, asst("短的回复")];
    expect(await a.compactHistory(small)).toBe(small);
    expect(called).toBe(0);
  });

  it("autoCompact=false 时完全不压", async () => {
    const a = makeAgent({ context: { budgetTokens: 1000, autoCompact: false } });
    const h = bigHistory();
    expect(await a.compactHistory(h)).toBe(h);
  });

  it("压缩后的历史仍然严格成对（旧实现会把「已写入」的 tool 结果单独留下）", async () => {
    const a = makeAgent({ llm: { contextWindow: 4000 } });
    a._summarize = async () => "【任务目标】重构模块\n【已改文件】src/mod0.js";
    const out = await a.compactHistory(bigHistory());
    expect(out).not.toBe(bigHistory());
    expect(pairingErrors(out)).toEqual([]);
    // 摘要必须占位
    expect(out[0].role).toBe("system");
    expect(out[0].content).toContain("[历史摘要]");
  });

  it("压缩后仍保留用户意图（user 消息一条不少）", async () => {
    const a = makeAgent({ llm: { contextWindow: 4000 } });
    a._summarize = async () => "摘要";
    const h = bigHistory();
    const out = await a.compactHistory(h);
    const before = h.filter((m) => m.role === "user").length;
    expect(out.filter((m) => m.role === "user").length).toBe(before);
  });

  it("shrink 检查：摘要比原文还长时放弃替换", async () => {
    const a = makeAgent({ llm: { contextWindow: 4000 } });
    const h = bigHistory();
    const before = a._estTokens(h);
    a._summarize = async () => "啰嗦".repeat(before);   // 摘要故意比原文更大
    const out = await a.compactHistory(h, { force: true });
    expect(out).toBe(h);
    const warn = a.emitted.find((e) => e.type === "term.line" && /压缩无收益/.test(e.text));
    expect(warn).toBeTruthy();
  });

  it("收益判定与上游水位分开：used 用实测、after 用同口径估算", async () => {
    const a = makeAgent({ llm: { contextWindow: 4000 } });
    a._lastPrompt = 3000; a._lastPromptLen = 1;   // 实测锚点在前
    a._summarize = async () => "简短摘要";
    const out = await a.compactHistory(bigHistory());
    const ev = a.emitted.find((e) => e.type === "context.compact");
    expect(ev).toBeTruthy();
    expect(ev.after).toBeLessThan(ev.before);
  });
});

/* ============================================================
   4. 存档修复
   ============================================================ */
describe("repairToolPairing — 中断留下的半轮", () => {
  it("缺失的 tool 结果被补成「结果未知」，垫在该轮结果末尾（不重排真实结果）", () => {
    const h = [{ role: "user", content: "u" }, asst("", [T("a"), T("b")]), tool("a")];
    const r = repairToolPairing(h);
    expect(r.fixed).toBe(1);
    expect(r.history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(r.history[2].tool_call_id).toBe("a");   // 真实结果位置不动
    expect(r.history[3].tool_call_id).toBe("b");   // 合成结果按声明顺序垫在后面
    expect(r.history[3].content).toContain("结果未知");
    expect(r.history[3].content).toContain("不要盲目重试");
    expect(pairingErrors(r.history)).toEqual([]);
  });

  it("全部结果都缺时逐条补齐，id 与 assistant 声明一一对应", () => {
    const h = [asst("", [T("x"), T("y"), T("z")])];
    const r = repairToolPairing(h);
    expect(r.fixed).toBe(3);
    expect(r.history.slice(1).map((m) => m.tool_call_id)).toEqual(["x", "y", "z"]);
  });

  it("孤儿 tool 结果被丢弃（它的 assistant 早被压缩吞掉了）", () => {
    const h = [{ role: "user", content: "u" }, tool("ghost")];
    const r = repairToolPairing(h);
    expect(r.droppedOrphans).toBe(1);
    expect(r.history.length).toBe(1);
  });

  it("已经配对完好的一段历史，逐元素不变（同引用、不重排）", () => {
    const h = [asst("", [T("a")]), tool("a"), asst("done")];
    const r = repairToolPairing(h);
    expect(r.fixed).toBe(0);
    expect(r.droppedOrphans).toBe(0);
    expect(r.history.length).toBe(h.length);
    for (let i = 0; i < h.length; i++) expect(r.history[i]).toBe(h[i]);
  });

  it("补出来的消息保留原始 id，不会与真实结果重复", () => {
    const h = [asst("", [T("a"), T("b")]), tool("b"), tool("a")];   // 结果乱序但齐全
    const r = repairToolPairing(h);
    expect(r.fixed).toBe(0);
    expect(r.history.length).toBe(3);
  });

  it("空输入 / 非数组不抛错", () => {
    expect(repairToolPairing([]).history).toEqual([]);
    expect(repairToolPairing(null).history).toEqual([]);
    expect(repairToolPairing(undefined).fixed).toBe(0);
  });
});

/* ============================================================
   5. 权限链：不可逆操作不被模式绕过
   ============================================================ */
describe("_approvalDecision — 删除文件在任何档位都要人工确认", () => {
  const mk = (extra) => {
    const a = makeAgent(extra);
    return a;
  };

  it("auto 模式：delete_file 仍然 ask（修复前这里直接 allow）", () => {
    const a = mk({ permissions: { mode: "auto", allow: [], deny: [] } });
    const d = a._approvalDecision("delete_file", { path: "src/a.js" });
    expect(d.action).toBe("ask");
    expect(d.reason).toContain("不可逆");
  });

  it("auto + 命中 allow 规则：delete_file 仍然 ask", () => {
    const a = mk({ permissions: { mode: "auto", allow: [{ tool: "delete_file", pattern: "src/**" }], deny: [] } });
    expect(a._approvalDecision("delete_file", { path: "src/a.js" }).action).toBe("ask");
  });

  it("auto + 会话内已授权 delete_file：仍然 ask", () => {
    const a = mk({ permissions: { mode: "auto", allow: [], deny: [] } });
    a._sessionGrants = new Set(["delete_file"]);
    expect(a._approvalDecision("delete_file", { path: "src/a.js" }).action).toBe("ask");
  });

  it("deny 规则优先于不可逆兜底：命中即硬拦截", () => {
    const a = mk({ permissions: { mode: "auto", allow: [], deny: [{ tool: "delete_file", pattern: "**" }] } });
    expect(a._approvalDecision("delete_file", { path: "src/a.js" }).action).toBe("block");
  });

  it("不可逆兜底不牵连别的工具：auto 下 write_file / run_command 照常放行", () => {
    const a = mk({ permissions: { mode: "auto", allow: [], deny: [] } });
    expect(a._approvalDecision("write_file", { path: "x.js" }).action).toBe("allow");
    expect(a._approvalDecision("run_command", { command: "npm test" }).action).toBe("allow");
  });

  it("ask / semi 档位的既有行为不受影响", () => {
    const a = mk({ permissions: { mode: "ask", allow: [], deny: [] } });
    expect(a._approvalDecision("read_file", { path: "x.js" }).action).toBe("allow");
    expect(a._approvalDecision("search_code", { query: "x" }).action).toBe("allow");
    expect(a._approvalDecision("delete_file", { path: "x.js" }).action).toBe("ask");
    const s = mk({ permissions: { mode: "semi", allow: [], deny: [] } });
    expect(s._approvalDecision("write_file", { path: "x.js" }).action).toBe("ask");
    expect(s._approvalDecision("delete_file", { path: "x.js" }).action).toBe("ask");
  });

  /* P1-12 修掉的缺口：只读放行原先散在 _approvalDecision 的硬编码 if 链里，
     只登了 12 个名字，repo_map / search_symbol / get_diagnostics / search_memory
     这些纯读工具漏在外面 → 每轮白弹一次人工确认。现在统一由 READONLY_TOOLS 派生。
     这条用例守的是"漏登记就红"：新增只读工具必须进集合（或显式承认它需要确认）。 */
  it("纯只读工具一律直接放行（不再依赖散落的 if 链）", () => {
    const a = mk({ permissions: { mode: "ask", allow: [], deny: [] } });
    for (const t of ["repo_map", "search_symbol", "get_diagnostics", "search_memory", "use_skill", "goal_status", "list_templates", "read_file", "list_files", "search_code", "git_status", "git_diff", "git_log", "read_process", "check_port", "list_mcp", "web_search", "web_fetch"]) {
      expect(a._approvalDecision(t, {}).action).toBe("allow");
    }
  });

  it("一把名字两用 / 会改盘的工具不因集合而漏网", () => {
    const a = mk({ permissions: { mode: "ask", allow: [], deny: [] } });
    expect(a._approvalDecision("git_branch", { action: "list" }).action).toBe("allow");
    expect(a._approvalDecision("git_branch", { action: "create", name: "x" }).action).toBe("ask");
    for (const t of ["write_file", "apply_edit", "delete_file", "run_command", "undo", "git_commit", "start_process", "stop_process", "create_plan", "agent", "orchestrate"]) {
      expect(["ask", "block"]).toContain(a._approvalDecision(t, {}).action);
    }
  });

  it("_isConcurrentSafe：只读并行，但带游标的读与一切写类独占", () => {
    const a = mk();
    expect(a._isConcurrentSafe("read_file")).toBe(true);
    expect(a._isConcurrentSafe("search_code")).toBe(true);
    expect(a._isConcurrentSafe("repo_map")).toBe(true);
    expect(a._isConcurrentSafe("read_process")).toBe(false);   // 按"上次读到哪"推进游标
    for (const t of ["write_file", "apply_edit", "run_command", "git_branch", "agent", "mcp__db__query", "undo"]) {
      expect(a._isConcurrentSafe(t)).toBe(false);
    }
  });
});

/* ============================================================
   6. 硬裁剪也按组走
   ============================================================ */
describe("_aggressiveTrim — 逐条删会变成交割时的 400", () => {
  it("裁剪后仍严格成对，且不删含 user 的组", () => {
    const a = makeAgent({ llm: { contextWindow: 8000 } });
    const h = [{ role: "user", content: "首条需求" + "字".repeat(2000) }];
    for (let i = 0; i < 10; i++) {
      h.push(asst("中间过程" + i, [T("k" + i), T("k" + i + "b")]));
      h.push(tool("k" + i, "Y".repeat(4000)));
      h.push(tool("k" + i + "b", "Z".repeat(4000)));
      h.push({ role: "user", content: "追加要求 " + i });
    }
    const users = h.filter((m) => m.role === "user").length;
    a._aggressiveTrim(h);
    expect(pairingErrors(h)).toEqual([]);
    expect(h.filter((m) => m.role === "user").length).toBe(users);  // 用户意图一条不许掉
    expect(h.length).toBeLessThan(41);
    expect(a._lastPrompt).toBe(0);
  });
});
