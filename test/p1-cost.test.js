/* P1-B4 · 成本换算层。
   重点是三条"不许悄悄猜"的口径：没配单价就不许出现金额；
   缺 output 价不许按 input 半价估；跨月/跨天的桶按本地日界切。 */
const C = require("../server/cost");

const RATES = [
  { match: "deepseek-chat", input: 2, output: 8 },
  { match: "deepseek", input: 1, output: 2 },
  { match: "/gpt-4o(-mini)?/i", input: 0.15, output: 0.6, currency: "USD" },
];

describe("matchRate：命中哪一条", () => {
  it("不区分大小写的子串命中", () => {
    expect(C.matchRate("DeepSeek-Chat", RATES).input).toBe(2);
    expect(C.matchRate("gpt-4o-mini", RATES).currency).toBe("USD");
  });
  it("/正则/ 写法也认（与 hooks、权限规则的习惯一致）", () => {
    expect(C.matchRate("openai/gpt-4o-2024", RATES).input).toBe(0.15);
    expect(C.matchRate("xgpt-4ox", RATES)).toBeTruthy();     // 子串式正则：不必整词匹配
  });
  it("顺序即优先级：靠前的专用条目赢过靠后的通用别名", () => {
    expect(C.matchRate("deepseek-chat", RATES).output).toBe(8);
    expect(C.matchRate("deepseek-reasoner", RATES).output).toBe(2);
  });
  it("没命中给 null，而不是给个 0 元", () => {
    expect(C.matchRate("qwen-max", RATES)).toBeNull();
    expect(C.matchRate("", RATES)).toBeNull();
    expect(C.matchRate("x", [])).toBeNull();
  });
  it("坏正则当不命中（不许把配置错误变成崩溃）", () => {
    expect(C.matchRate("abc", [{ match: "/[/", input: 1, output: 1 }])).toBeNull();
  });
});

describe("costOf：token → 金额", () => {
  it("按百万 token 计价，input/output 分开", () => {
    const r = C.costOf("deepseek-chat", { prompt_tokens: 1000000, completion_tokens: 500000 }, { rates: RATES });
    expect(r.input).toBeCloseTo(2, 6);
    expect(r.output).toBeCloseTo(4, 6);
    expect(r.total).toBeCloseTo(6, 6);
    expect(r.currency).toBe("CNY");
  });
  it("小用量也算得出（一次对话 2k/300 token 是几分钱，不是 0）", () => {
    const r = C.costOf("deepseek-chat", { prompt_tokens: 2000, completion_tokens: 300 }, { rates: RATES });
    expect(r.total).toBeCloseTo(0.0064, 6);
  });
  it("缺 output 价时那一侧算 0，不按 input 半价猜", () => {
    const r = C.costOf("deepseek-chat", { prompt_tokens: 1000000, completion_tokens: 1000000 }, { rates: [{ match: "deepseek-chat", input: 2 }] });
    expect(r.input).toBeCloseTo(2, 6);
    expect(r.output).toBe(0);
  });
  it("总开关关掉 / 没配 rates → 没有金额（面板该显示未配置而不是 ¥0）", () => {
    expect(C.costOf("deepseek-chat", { prompt_tokens: 1 }, { rates: RATES, enabled: false })).toBeNull();
    expect(C.costOf("deepseek-chat", { prompt_tokens: 1 }, {})).toBeNull();
    expect(C.costOf("qwen", { prompt_tokens: 1 }, { rates: RATES })).toBeNull();
  });
  it("负数与非法数字不进金额（供应商偶尔回 null usage）", () => {
    const r = C.costOf("deepseek-chat", { prompt_tokens: -5, completion_tokens: "abc" }, { rates: RATES });
    expect(r.total).toBe(0);
  });
});

describe("账本：按天分桶与汇总", () => {
  it("dayKey 用本地日界，不用 UTC", () => {
    const d = new Date(2026, 9, 14, 23, 30, 0);      // 本地 10-14 深夜：UTC 可能已是 10-15
    expect(C.dayKey(d.getTime())).toBe(d.getFullYear() + "-10-14");
  });
  it("同一天的多次请求累加进同一个模型条目，日 total 跟着涨", () => {
    const store = { v: 1, days: {} };
    const ts = new Date(2026, 9, 14, 10, 0, 0).getTime();
    const cfg = { rates: RATES };
    C.accumulate(store, { ts, model: "deepseek-chat", usage: { prompt_tokens: 1000000, completion_tokens: 0 }, cost: C.costOf("deepseek-chat", { prompt_tokens: 1000000, completion_tokens: 0 }, cfg) });
    C.accumulate(store, { ts: ts + 60000, model: "deepseek-chat", usage: { prompt_tokens: 500000, completion_tokens: 0 }, cost: C.costOf("deepseek-chat", { prompt_tokens: 500000, completion_tokens: 0 }, cfg) });
    const day = store.days[C.dayKey(ts)];
    expect(day.models["deepseek-chat"].prompt).toBe(1500000);
    expect(day.total).toBeCloseTo(3, 6);
  });
  it("没配单价的模型也记账（token 数在，金额是 0，且 priced=false）", () => {
    const store = { v: 1, days: {} };
    const ts = new Date(2026, 9, 14, 10, 0, 0).getTime();
    C.accumulate(store, { ts, model: "qwen-max", usage: { prompt_tokens: 1000, completion_tokens: 10 }, cost: null });
    const s = C.summarize(store, { days: 30 });
    expect(s.total).toBe(0);
    expect(s.priced).toBe(false);
    expect(s.prompt).toBe(1000);
  });
  it("summarize 只取最近 N 天并倒序", () => {
    const store = { v: 1, days: {} };
    for (let i = 0; i < 5; i++) {
      const ts = new Date(2026, 9, 10 + i, 12, 0, 0).getTime();
      C.accumulate(store, { ts, model: "m", usage: { prompt_tokens: 1000000 }, cost: { total: 1, currency: "CNY" } });
    }
    const s = C.summarize(store, { days: 3 });
    expect(s.days.length).toBe(3);
    expect(s.days[0].day > s.days[1].day).toBe(true);
    expect(s.total).toBe(3);
  });
  it("summarize 对空账本不崩", () => {
    expect(C.summarize({}, { days: 7 })).toEqual({ days: [], models: {}, total: 0, priced: false, prompt: 0, completion: 0 });
  });
});

describe("fmtMoney：显示口径", () => {
  it("不足 1 元留 4 位小数（显示 ¥0.00 会让人以为面板坏了）", () => {
    expect(C.fmtMoney(0.0064, "CNY")).toBe("¥0.0064");
    expect(C.fmtMoney(0, "CNY")).toBe("¥0.0000");
  });
  it("金额大时收小数位", () => {
    expect(C.fmtMoney(1234.5678, "CNY")).toBe("¥1234.57");
    expect(C.fmtMoney(12.3456, "CNY")).toBe("¥12.346");
  });
  it("币种符号来自配置，未知币种写代码", () => {
    expect(C.fmtMoney(1, "USD")).toBe("$1.000");
    expect(C.fmtMoney(1, "JPY")).toBe("JPY 1.000");
  });
});
