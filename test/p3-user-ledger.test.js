/* 「用户要求沿革」台账的纯判据（server/user-ledger.js）。
   这一层错了不会报错，只会让长任务越压越大、最后断路器把自动摘要关掉 —— 所以行数、字节、
   条数守恒三件事都要能红。压缩里的接线在 test/p1-compact-budget.test.js 那一节。 */
const {
  oneLine, findLedger, stripLedger, parseLedger, assemble, buildLedger, pickKeepUsers, budgetsOf,
  USER_LEDGER_PREFIX, ONE_LINE_MAX, KEEP_RATIO, LEDGER_RATIO,
} = require("../server/user-ledger");

const est = (t) => Math.ceil(String(t).length / 4);        // 与引擎同口径的粗算（字符/4）
const U = (text) => ({ role: "user", content: text });
const users = (n, maker) => Array.from({ length: n }, (_, i) => U(maker ? maker(i) : "第 " + i + " 个要求"));

describe("oneLine：一行就是一条，不许换行", () => {
  it("换行与多余空白压成空格", () => {
    expect(oneLine("修复\n  筛选   bug\n并补测试")).toBe("修复 筛选 bug 并补测试");
  });
  it("超长截断到上限并以省略号收尾（台账一行不能被撑成一段）", () => {
    const s = oneLine("x".repeat(500));
    expect(s.length).toBe(ONE_LINE_MAX);
    expect(s.endsWith("…")).toBe(true);
  });
  it("空内容不成行", () => {
    expect(oneLine("")).toBe("");
    expect(oneLine("   \n  ")).toBe("");
    expect(oneLine(null)).toBe("");
  });
});

describe("台账的查找 / 剥离 / 解析", () => {
  const text = assemble(3, ["最早的一条", "中间的一条"]);
  const hist = [
    { role: "system", content: "[历史摘要] 别的" },
    { role: "system", content: text },
    U("当前要求"),
  ];
  it("找得到那条 system 台账，并给出下标", () => {
    const f = findLedger(hist);
    expect(f.index).toBe(1);
    expect(f.text.startsWith(USER_LEDGER_PREFIX)).toBe(true);
  });
  it("strip 之后历史里不再有任何台账（别处误用时不会留下两条）", () => {
    expect(findLedger(stripLedger(hist))).toBe(null);
    expect(stripLedger(hist).length).toBe(2);
  });
  it("没有台账就是 null / 空解析", () => {
    expect(findLedger([U("只有用户消息")])).toBe(null);
    expect(parseLedger("")).toEqual({ folded: 0, lines: [] });
    expect(parseLedger("[历史摘要] 不是台账")).toEqual({ folded: 0, lines: [] });
  });
  it("assemble → parseLedger 往返还原样（条数与每一行）", () => {
    expect(parseLedger(text)).toEqual({ folded: 3, lines: ["最早的一条", "中间的一条"] });
    expect(parseLedger(assemble(0, ["甲"]))).toEqual({ folded: 0, lines: ["甲"] });
  });
});

describe("buildLedger：有上限，且只折最旧的", () => {
  it("没有任何被降级的要求 → 不产出台账（不凭空多一条 system 消息）", () => {
    expect(buildLedger({ folded: 0, lines: [] }, [], { est })).toBe("");
  });
  it("新折进去的按时间顺序排在旧台账行之后", () => {
    const out = buildLedger({ folded: 1, lines: ["旧的"] }, [U("新的")], { est, budgetTokens: 9999 });
    const p = parseLedger(out);
    expect(p.lines).toEqual(["旧的", "新的"]);
    expect(p.folded).toBe(1);
  });
  it("超预算时从最旧那头折进条数，行数变少、folded 变大", () => {
    const dropped = users(20, (i) => "要求" + i + "-" + "y".repeat(60));
    const out = buildLedger({ folded: 0, lines: [] }, dropped, { est, budgetTokens: 120 });
    const p = parseLedger(out);
    expect(p.lines.length).toBeLessThan(20);
    expect(p.lines.length).toBeGreaterThan(0);
    expect(p.folded).toBe(20 - p.lines.length);
    expect(est(out)).toBeLessThanOrEqual(120 + 40);       // 上限是硬约束（头部标题行那点固定开销除外）
  });
  it("至少留最新一行，哪怕预算给到 0", () => {
    const out = buildLedger({ folded: 0, lines: [] }, [U("唯一的一条要求")], { est, budgetTokens: 0 });
    expect(out).toContain("唯一的一条要求");
    expect(parseLedger(out).lines.length).toBe(1);
  });
  it("重复折同一批不会把条数算两遍（folded 只增不重）", () => {
    const dropped = users(30, (i) => "要求" + i + "：" + "z".repeat(80));
    const once = parseLedger(buildLedger({ folded: 0, lines: [] }, dropped, { est, budgetTokens: 200 }));
    const twice = parseLedger(buildLedger(once, [], { est, budgetTokens: 200 }));
    expect(twice.lines).toEqual(once.lines);
    expect(twice.folded).toBe(once.folded);
  });
});

describe("pickKeepUsers：留最近几条原文", () => {
  it("预算够 → 全留，且顺序不变（时间序）", () => {
    const list = users(4);
    const r = pickKeepUsers(list, 99999, est);
    expect(r.keep).toEqual(list);
    expect(r.dropped).toEqual([]);
  });
  it("预算不够 → 从最新往旧累加，dropped 是更旧的那些且仍是时间序", () => {
    const list = users(10, (i) => "M" + i + " " + "a".repeat(200));
    const r = pickKeepUsers(list, 120, est);
    expect(r.keep.length).toBeLessThan(10);
    expect(r.keep.map((m) => m.content.slice(0, 2))).toEqual(r.keep.map((m) => m.content.slice(0, 2)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
    expect(r.dropped.concat(r.keep).map((m) => m.content)).toEqual(list.map((m) => m.content));  // 守恒：一条不多一条不少
  });
  it("预算给 0 也至少留最近 3 条，别让\"用户到底要什么\"整个看不见", () => {
    const r = pickKeepUsers(users(8), 0, est);
    expect(r.keep.length).toBe(3);
    expect(r.keep[2].content).toContain("第 7 个要求");
    expect(r.dropped.length).toBe(5);
  });
  it("非 user 消息不参与（工具结果不能靠这条路留原文）", () => {
    const r = pickKeepUsers([{ role: "tool", content: "x" }, U("要求")], 9999, est);
    expect(r.keep.length).toBe(1);
    expect(r.dropped.length).toBe(0);
  });
});

describe("budgetsOf：预算跟着保留量走，不写死条数", () => {
  it("128K 档与 8K 档都能算出各自的额度", () => {
    expect(budgetsOf(2400)).toEqual({ keepUsersTokens: Math.round(2400 * KEEP_RATIO), ledgerTokens: Math.round(2400 * LEDGER_RATIO) });
    expect(budgetsOf(0)).toEqual({ keepUsersTokens: 0, ledgerTokens: 0 });
    expect(budgetsOf(undefined).keepUsersTokens).toBe(0);
    expect(KEEP_RATIO + LEDGER_RATIO).toBeLessThan(0.5);   // 用户侧合计不许吃掉一半保留量
  });
});
