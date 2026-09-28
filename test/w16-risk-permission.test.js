/* ============================================================
   v3.1 新增内核能力单测
   - risk.assess：敏感路径 / 大段删除 / 体量 / 对外符号消失 / 爆炸半径 / 缺测试 的信号叠加与降级
   - risk.summarize + risk.forAgent：整体等级与回灌给 Agent 的文本
   - LlmAgent._globToRe：* 不跨层级、** 跨层级、字面转义
   - LlmAgent._validateArgs：缺必填 / 类型不符 / 枚举越界 / 合法放行
   ============================================================ */
const risk = require("../server/risk");
const { LlmAgent } = require("../server/agent-llm");

const A = (o) => risk.assess(Object.assign({ path: "src/a.js", base: "", cur: "", add: 0, del: 0, status: "M", changedFiles: 1, hasTestTouch: true }, o));

describe("risk.assess", () => {
  it("无信号的普通改动 = low", () => {
    const r = A({ add: 3, del: 1 });
    expect(r.level).toBe("low");
    expect(r.score).toBe(0);
  });

  it("敏感路径单独命中即可升到 mid", () => {
    const r = A({ path: "server/auth.js", add: 10, del: 2 });
    expect(r.score).toBeGreaterThanOrEqual(3);
    expect(r.level).toBe("mid");
    expect(r.reasons.join()).toContain("敏感路径");
  });

  it("敏感路径 + 对外符号消失 + 大段删除 = high", () => {
    const r = A({
      path: "server/security.js",
      base: "function checkToken(a){return 1}\nconst x=1;\nconst y=2;\nconst z=3;",
      cur: "function verifyToken(a){return 1}",
      add: 1, del: 45, changedFiles: 12, hasTestTouch: false,
    });
    expect(r.level).toBe("high");
    const txt = r.reasons.join("；");
    expect(txt).toContain("敏感路径");
    expect(txt).toContain("移除/改名了对外符号");
    expect(txt).toContain("checkToken");
    expect(txt).toContain("大段删除");
    expect(txt).toContain("跨面较大");
    expect(txt).toContain("没有配套测试");
  });

  it("测试与文档目录只保留体量信号", () => {
    expect(A({ path: "src/a.test.js", add: 200, del: 100 }).level).toBe("low");
    expect(A({ path: "docs/guide.md", add: 200, del: 100 }).level).toBe("low");
    const big = A({ path: "tests/big.test.js", add: 500, del: 0 });
    expect(big.level).toBe("low");
    expect(big.score).toBe(1);
  });

  it("整文件删除按高风险计", () => {
    const r = A({ path: "src/legacy.js", status: "D", add: 0, del: 300 });
    expect(r.reasons.join()).toContain("删除整个文件");
  });

  it("只新增符号不扣分，删除符号才提示调用方失效", () => {
    const added = A({ path: "src/lib.js", base: "export function a(){}", cur: "export function a(){}\nexport function b(){}", add: 1 });
    expect(added.reasons.join()).not.toContain("调用方可能失效");
    const gone = A({ path: "src/lib.js", base: "export function a(){}\nexport function b(){}", cur: "export function a(){}", add: 0, del: 1 });
    expect(gone.reasons.join()).toContain("b");
  });
});

describe("risk.summarize / forAgent", () => {
  it("取最高等级并列出重点文件", () => {
    const risks = [
      A({ path: "src/a.js", add: 2 }),
      A({ path: "server/auth.js", add: 130, del: 120, changedFiles: 12, hasTestTouch: false, base: "export function k(){}", cur: "" }),
    ];
    const sum = risk.summarize(risks);
    expect(sum.level).toBe("high");
    expect(sum.high.length).toBe(1);
    expect(sum.focus[0].path).toBe("server/auth.js");
    const txt = risk.forAgent(sum);
    expect(txt).toContain("改动风险评估");
    expect(txt).toContain("get_diagnostics");
  });

  it("整体 low 时不给 Agent 追加噪音", () => {
    expect(risk.forAgent(risk.summarize([A({ path: "README.md", add: 2 })]))).toBe("");
  });
});

describe("LlmAgent._globToRe", () => {
  const re = LlmAgent._globToRe;
  it("* 不跨路径层级，** 跨层级", () => {
    expect(re("src/*.js").test("src/a.js")).toBe(true);
    expect(re("src/*.js").test("src/deep/a.js")).toBe(false);
    expect(re("src/**/*.js").test("src/deep/a.js")).toBe(true);
  });
  it("字面量里的正则元字符不会被当模式", () => {
    expect(re("a.test.js").test("axtestxjs")).toBe(false);
    expect(re("a.test.js").test("a.test.js")).toBe(true);
  });
  it("? 匹配单个非分隔符字符", () => {
    expect(re("a?.js").test("ab.js")).toBe(true);
    expect(re("a?.js").test("abc.js")).toBe(false);
  });
});

describe("LlmAgent._validateArgs", () => {
  const agent = Object.create(LlmAgent.prototype);
  it("未声明的工具直接放行（MCP 动态工具走这条）", () => {
    expect(agent._validateArgs("mcp__x__y", { anything: 1 })).toBe(null);
  });
  it("缺必填参数被拦下并给出 schema 形状", () => {
    const err = agent._validateArgs("read_file", {});
    expect(err).toContain("参数校验未通过");
    expect(err).toContain("path");
    expect(err).toContain("本次调用未执行");
  });
  it("空字符串等同缺必填", () => {
    expect(agent._validateArgs("write_file", { path: "a.js", content: "" })).toContain("content");
  });
  it("类型不符被拦下", () => {
    const err = agent._validateArgs("create_plan", { title: "t", tasks: "not-an-array" });
    expect(err).toContain("类型应为 array");
  });
  it("合法参数放行", () => {
    expect(agent._validateArgs("read_file", { path: "src/a.js" })).toBe(null);
    expect(agent._validateArgs("write_file", { path: "a.js", content: "x" })).toBe(null);
  });
  it("参数不是对象时报错而不是崩溃", () => {
    expect(agent._validateArgs("read_file", [])).toContain("数组");
    expect(agent._validateArgs("read_file", null)).toContain("需要一个 JSON 对象");
  });
});

describe("LlmAgent._matchPermRule", () => {
  const agent = Object.create(LlmAgent.prototype);
  it("旧版字符串规则仍然按子串命中（向后兼容）", () => {
    expect(agent._matchPermRule("run_command", "npm run test", ["npm run"])).toBeTruthy();
    expect(agent._matchPermRule("run_command", "rm -rf /", ["npm run"])).toBeFalsy();
  });
  it("结构化规则按 工具 × glob 命中", () => {
    const rules = [{ tool: "write_file", pattern: "src/**" }];
    expect(agent._matchPermRule("write_file", "src/a/b.js", rules)).toBeTruthy();
    expect(agent._matchPermRule("write_file", "server/a.js", rules)).toBeFalsy();
    expect(agent._matchPermRule("run_command", "src/a.js", rules)).toBeFalsy();
  });
  it("命令前缀式规则可用", () => {
    const rules = [{ tool: "run_command", pattern: "git push*" }];
    expect(agent._matchPermRule("run_command", "git push origin main", rules)).toBeTruthy();
    expect(agent._matchPermRule("run_command", "git commit -m x", rules)).toBeFalsy();
  });
  it("* 通配所有工具", () => {
    expect(agent._matchPermRule("delete_file", "danger.txt", [{ tool: "*", pattern: "danger*" }])).toBeTruthy();
    expect(agent._matchPermRule("run_command", "danger.txt", [{ tool: "*", pattern: "danger*" }])).toBeTruthy();
    expect(agent._matchPermRule("run_command", "safe.txt", [{ tool: "*", pattern: "danger*" }])).toBeFalsy();
  });
});
