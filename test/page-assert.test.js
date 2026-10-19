/* 页面断言的判读层单测（server/computer/page-assert.js）。
   ————————————————————————————————————————————
   这条工具存在的理由就是"别再靠肉眼读快照然后脑补通过"，所以判据本身更不能靠肉眼。
   真浏览器那一段在 scripts/_verify_browser.js；这里钉的是离线就能判对错的三件事：
   1) 缺 expected 之类的"写漏"必须在校验阶段就被拦下 —— 默认值会让最想验的那条永远绿；
   2) 元素不存在时不许算通过（哪怕期望是"包含空字符串"）；
   3) 选择器是数据不是代码：模型塞进来的引号/括号只能让它自己查不到元素，不能变成页面里的代码。 */
const PA = require("../server/computer/page-assert");

describe("validate：清单先过闸", () => {
  it("正常清单一条不漏地收下来，顺序与编号一致", () => {
    const { items, bad } = PA.validate([
      { kind: "text", sel: "#out", expected: "已提交：abc" },
      { kind: "count", sel: ".row", expected: 3 },
      { kind: "url", expected: "fixture.html", contains: true },
    ]);
    expect(bad).toEqual([]);
    expect(items.map((i) => i.kind)).toEqual(["text", "count", "url"]);
  });

  it("kind 不认识时报出可选值而不是闷声跳过", () => {
    const { items, bad } = PA.validate([{ kind: "appears", sel: "#x" }]);
    expect(items).toHaveLength(0);
    expect(bad[0]).toContain("kind 不认识");
    expect(bad[0]).toContain("visible");
  });

  it("text 不给 expected 直接拒（缺期望值的那条最容易一路绿过去）", () => {
    const { bad } = PA.validate([{ kind: "text", sel: "#out" }]);
    expect(bad[0]).toContain("缺 expected");
  });

  it("attr 不给属性名直接拒", () => {
    const { bad } = PA.validate([{ kind: "attr", sel: "#btn", expected: "true" }]);
    expect(bad[0]).toContain("缺 attr");
  });

  it("attr 只给 name 也收得下：name 是属性别名，转发时不能丢（丢了就是校验过、执行必败）", () => {
    const { items, bad } = PA.validate([{ kind: "attr", sel: "#btn", name: "data-id", expected: "b1" }]);
    expect(bad).toEqual([]);
    expect(items[0].attr).toBe("data-id");
  });

  it("url / title 不需要选择器，别的都需要", () => {
    expect(PA.validate([{ kind: "title", expected: "x" }]).bad).toEqual([]);
    expect(PA.validate([{ kind: "visible" }]).bad[0]).toContain("缺 sel");
  });

  it("坏项会让整批不执行，而不是跳过坏项继续验剩下的", () => {
    const { items, bad } = PA.validate([
      { kind: "text", sel: "#good", expected: "a" },
      { kind: "nope", sel: "#x" },
    ]);
    expect(bad).toHaveLength(1);
    /* handler 里 bad 非空就 return：模型拿到的是一份"少了几条的通过回执"最危险 */
    expect(items).toHaveLength(1);
  });
});

describe("judge：观察值 vs 期望", () => {
  it("默认按完全相等，contains:true 才放行子串", () => {
    const o = { found: true, text: "已提交：abcdef" };
    expect(PA.judge({ kind: "text", expected: "已提交：abc" }, o).pass).toBe(false);
    expect(PA.judge({ kind: "text", expected: "已提交：abc", contains: true }, o).pass).toBe(true);
    expect(PA.judge({ kind: "text", expected: "已提交：abcdef" }, o).pass).toBe(true);
  });

  it("元素不存在时任何内容断言都不算过，并说清是没找到", () => {
    const o = { found: false };
    const j = PA.judge({ kind: "text", sel: "#out", expected: "" }, o);
    expect(j.pass).toBe(false);
    expect(j.actual).toContain("没有这个元素");
  });

  it("exists:false 是「确实没有」才算过；元素在但 hidden 不等于不存在", () => {
    expect(PA.judge({ kind: "exists", expected: false }, { found: false }).pass).toBe(true);
    expect(PA.judge({ kind: "exists", expected: false }, { found: true }).pass).toBe(false);
    const vis = { found: true, visible: false };
    expect(PA.judge({ kind: "exists" }, vis).pass).toBe(true);
    expect(PA.judge({ kind: "visible" }, vis).pass).toBe(false);
    expect(PA.judge({ kind: "visible", expected: false }, vis).pass).toBe(true);
  });

  it("count 用数字比，字符串期望不会被当成通过", () => {
    expect(PA.judge({ kind: "count", sel: ".row", expected: 3 }, { count: 3 }).pass).toBe(true);
    expect(PA.judge({ kind: "count", sel: ".row", expected: "3" }, { count: 3 }).pass).toBe(true);
    expect(PA.judge({ kind: "count", sel: ".row", expected: 2 }, { count: 3 }).pass).toBe(false);
    expect(PA.judge({ kind: "count", sel: ".row", expected: 3 }, {}).pass).toBe(false);
  });

  it("checked / enabled 读的是控件状态而不是文本", () => {
    expect(PA.judge({ kind: "checked" }, { found: true, checked: true }).pass).toBe(true);
    expect(PA.judge({ kind: "checked" }, { found: true, checked: false }).pass).toBe(false);
    expect(PA.judge({ kind: "enabled", expected: false }, { found: true, enabled: false }).pass).toBe(true);
  });

  it("attr 读不到属性时判不过，并说清读不出来（属性不存在≠属性为空串）", () => {
    const j = PA.judge({ kind: "attr", sel: "#a", attr: "href", expected: "x" }, { found: true, attr: null });
    expect(j.pass).toBe(false);
    expect(j.actual).toContain("读不出来");
  });

  it("count 探针标了坏选择器时，actual 指向选择器本身而不是元素", () => {
    const j = PA.judge({ kind: "count", sel: ".x[", expected: 1 }, { error: "bad_selector" });
    expect(j.pass).toBe(false);
    expect(j.actual).toContain("选择器");
  });

  it("实得值过长会截断，但绝不悄悄改短到看起来一样", () => {
    const long = "Z".repeat(PA.ACTUAL_MAX + 500);
    const j = PA.judge({ kind: "text", sel: "#p", expected: "Z" }, { found: true, text: long });
    expect(j.pass).toBe(false);
    expect(j.actual.length).toBeLessThanOrEqual(PA.ACTUAL_MAX + 1);
    expect(j.actual.endsWith("…")).toBe(true);
  });
});

describe("探针程序：选择器是数据不是代码", () => {
  it("恶意选择器原样嵌得进去、也原样解析得回来（证明它只是数据）", () => {
    const evil = '");alert(1);//';
    const items = [{ kind: "text", sel: evil, expected: "x" }];
    const script = PA.assertProbeScript(items);
    /* 判据用"能 JSON.parse 回同一个值"而不是死盯反斜杠：
       只要这段字面量还能被解析回原字符串，它就一定没提前闭合 map(...)。 */
    const start = script.indexOf("const out=") + "const out=".length;
    const end = script.indexOf(".map((it)=>");
    expect(end).toBeGreaterThan(start);
    const embedded = JSON.parse(script.slice(start, end));
    expect(embedded).toEqual([{ kind: "text", sel: evil, attr: "" }]);
    expect(embedded[0].sel).toBe(evil);
    expect(script.slice(0, 7)).toBe("(()=>{c");
  });

  it("kind / sel / attr 之外的字段不会进页面程序", () => {
    const script = PA.assertProbeScript([{ kind: "text", sel: "#a", expected: "绝不能带进页面", contains: true }]);
    expect(script).not.toContain("绝不能带进页面");
    expect(script).toContain("\"sel\":\"#a\"");
  });

  it("count 的查询有 try 兜底：非法选择器只废那一条，不废整批", () => {
    const script = PA.assertProbeScript([{ kind: "count", sel: ".row", expected: 3 }]);
    expect(script).toContain("try{o.count=document.querySelectorAll");
  });
});
