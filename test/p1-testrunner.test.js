/* ============================================================
   P1-B3 · 测试运行器解析层单测。
   vitest / node --test(spec) / node --test(tap) 三段输出是从这台机器真跑出来的；
   强调这点是因为写这一版时踩到的正是形状假设：node --test 走管道时给的**不是**
   大家以为的 TAP，只按 TAP 写解析器就一个失败位置都提不出来。
   jest 那段按其公开输出形状手写（本机没装 jest，未本地复核），
   所以只钉"计数 + 用例名 + 栈位置"这三条稳定项。
   ============================================================ */
const TR = require("../server/test-runner");

const VITEST_OUT = [
  " RUN  v5.0.0 E:/VStudio_Project/ai/pancode",
  "",
  " ❯ test/calibrate.test.js (3 tests | 2 failed) 6ms",
  "   ❯ calibrate (3)",
  "     × adds numbers 4ms",
  "     ✓ passes 0ms",
  "",
  " FAIL  test/calibrate.test.js > calibrate > adds numbers",
  "AssertionError: expected 2 to be 3 // Object.is equality",
  "",
  "- Expected",
  "+ Received",
  "",
  " ❯ test/calibrate.test.js:5:19",
  "      3| describe(\"calibrate\", () => {",
  "",
  " FAIL  test/calibrate.test.js > calibrate > strings",
  "AssertionError: expected 'a' to be 'b' // Object.is equality",
  "",
  " ❯ test/calibrate.test.js:8:17",
  "",
  " Test Files  1 failed (1)",
  "      Tests  2 failed | 1 passed (3)",
  "   Duration  292ms (import 51%, worker 25%)",
  "",
].join("\n");

const NODE_SPEC_OUT = [
  "✖ adds numbers (1.0793ms)",
  "✔ passes (0.1295ms)",
  "ℹ tests 2",
  "ℹ pass 1",
  "ℹ fail 1",
  "ℹ duration_ms 101.0582",
  "",
  "✖ failing tests:",
  "",
  "test at C:\\Users\\me\\AppData\\Local\\Temp\\ntcal\\a.test.js:3:1",
  "✖ adds numbers (1.0793ms)",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "",
  "  2 !== 3",
  "",
  "      at TestContext.<anonymous> (C:\\Users\\me\\AppData\\Local\\Temp\\ntcal\\a.test.js:3:37)",
  "}",
].join("\n");

/* tap 里反斜杠是 YAML 双写的（真实输出如此，不是笔误） */
const NODE_TAP_OUT = [
  "TAP version 13",
  "not ok 1 - adds numbers",
  "  ---",
  "  location: 'C:\\\\Users\\\\me\\\\ntcal\\\\a.test.js:3:1'",
  "  error: |-",
  "    Expected values to be strictly equal:",
  "",
  "  expected: 3",
  "  actual: 2",
  "  ...",
  "ok 2 - passes",
  "# tests 2",
  "# pass 1",
  "# fail 1",
].join("\n");

const JEST_OUT = [
  "FAIL test/sum.test.js",
  "  ● calibrate › adds numbers",
  "",
  "    expect(received).toBe(expected)",
  "",
  "      at Object.<anonymous> (test/sum.test.js:4:11)",
  "",
  "Tests:       1 failed, 2 passed, 3 total",
  "Time:        1.234 s",
].join("\n");

describe("detect：从 package.json 认测试命令", () => {
  it("scripts.test 是 primary，其它 test* 键进候选；pretest 不算", () => {
    const d = TR.detect({ scripts: { test: "vitest run", "test:e2e": "node e2e.js", pretest: "tsc", build: "tsc" } });
    expect(d.primary.key).toBe("test");
    expect(d.scripts.map((s) => s.key)).toEqual(["test", "test:e2e"]);
  });
  it("没有 test 时退到第一个 test* 脚本", () => {
    expect(TR.detect({ scripts: { "test:unit": "vitest run" } }).primary.key).toBe("test:unit");
  });
  it("四种框架各认各的命令文本（不看依赖名），认不出算 generic", () => {
    const fw = (test) => TR.detect({ scripts: { test } }).primary.framework;
    expect(fw("vitest run")).toBe("vitest");
    expect(fw("jest --ci")).toBe("jest");
    expect(fw("node --test test/")).toBe("node-test");
    expect(fw("python -m pytest -q")).toBe("pytest");
    expect(fw("node scripts/run.js")).toBe("generic");
  });
  it("&& 串起来的多段命令一律 generic（追加文件参数会拼到最后一段）", () => {
    const d = TR.detect({ scripts: { test: "vitest run && npm run lint" } });
    expect(d.primary.framework).toBe("generic");
    expect(d.primary.chained).toBe(true);
  });
  it("没有 package.json / 没有测试脚本时不编造命令", () => {
    expect(TR.detect(null).primary).toBeNull();
    expect(TR.detect({ scripts: { start: "node server" } }).scripts).toEqual([]);
  });
});

describe("build：收窄范围怎么拼", () => {
  const det = (scripts) => TR.detect({ scripts });
  it("vitest / jest / node --test 把文件作为位置参数追加", () => {
    expect(TR.build(det({ test: "vitest run" }), { files: ["test/a.test.js"] }).command).toBe("vitest run test/a.test.js");
    expect(TR.build(det({ test: "jest" }), { files: ["a.test.js"] }).command).toBe("jest a.test.js");
    expect(TR.build(det({ test: "node --test" }), { files: ["t/a.test.js", "t/b.test.js"] }).command).toBe("node --test t/a.test.js t/b.test.js");
  });
  it("带空格的路径包引号（这条命令最终交给 cmd.exe）", () => {
    expect(TR.build(det({ test: "vitest run" }), { files: ["test dir/a b.test.js"] }).command).toBe('vitest run "test dir/a b.test.js"');
  });
  it("不合规的文件名一律丢：上级 / 绝对 / 盘符 / shell 元字符 / 反斜杠 / 通配尾", () => {
    for (const bad of ["../secret.js", "/abs/a.js", "C:/ws/a.js", "a.js; rm -rf /", "a.js|more", "a.test.*", "src\\a.js", 'a".js']) {
      expect(TR.safeRelPath(bad)).toBe(false);
    }
    for (const good of ["test/a.test.js", "src/x-y.test.ts", "test/用例1.test.js"]) expect(TR.safeRelPath(good)).toBe(true);
    const p = TR.build(det({ test: "vitest run" }), { files: ["../x.js", "test/a.test.js"] });
    expect(p.files).toEqual(["test/a.test.js"]);
    expect(p.dropped).toBe(1);
  });
  it("generic 脚本带 files 时整串跑并把原因说清楚", () => {
    const p = TR.build(det({ test: "node scripts/run.js" }), { files: ["a.js"] });
    expect(p.scoped).toBe(false);
    expect(p.command).toBe("node scripts/run.js");
    expect(p.note).toContain("整串跑");
  });
  it("显式 script 选别的脚本；选错时把可选键报出来", () => {
    const d = det({ test: "vitest run", "test:lsp": "node scripts/test-lsp.js" });
    expect(TR.build(d, { script: "test:lsp" }).command).toBe("node scripts/test-lsp.js");
    const miss = TR.build(d, { script: "test:nope" });
    expect(miss.missing).toBe(true);
    expect(miss.note).toContain("test:lsp");
  });
  it("显式 command 覆盖检测（没有 package.json 的项目也能跑）", () => {
    const p = TR.build({ scripts: [], primary: null }, { command: "pytest -q" });
    expect(p.command).toBe("pytest -q");
    expect(p.framework).toBe("pytest");
  });
});

describe("parse：把真实输出读成结构化结果", () => {
  it("vitest：计数、两个失败位置、耗时全对上", () => {
    const r = TR.parse("vitest", VITEST_OUT, 1);
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(2);
    expect(r.passed).toBe(1);
    expect(r.durationMs).toBe(292);
    expect(r.failures.length).toBe(2);
    expect(r.failures[0].test).toBe("calibrate › adds numbers");
    expect(r.failures[0].at.file).toBe("test/calibrate.test.js");
    expect(r.failures[0].at.line).toBe(5);
    expect(r.failures[0].message).toContain("expected 2 to be 3");
    expect(r.failures[1].at.line).toBe(8);
  });

  it("node --test 的 spec reporter（走管道时的默认）能提出位置与消息", () => {
    const r = TR.parse("node-test", NODE_SPEC_OUT, 1);
    expect(r.failed).toBe(1);
    expect(r.passed).toBe(1);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0].test).toBe("adds numbers");
    expect(r.failures[0].at.line).toBe(3);
    expect(r.failures[0].message).toContain("AssertionError");
  });

  it("node --test 的 tap reporter 也能读（只认一种就全瞎）", () => {
    const r = TR.parse("node-test", NODE_TAP_OUT, 1);
    expect(r.failed).toBe(1);
    expect(r.failures[0].at.file).toBe("C:/Users/me/ntcal/a.test.js");
    expect(r.failures[0].at.line).toBe(3);
    expect(r.failures[0].message).toContain("期望 3，实际 2");
  });

  it("jest：计数 + 用例名 + 栈位置", () => {
    const r = TR.parse("jest", JEST_OUT, 1);
    expect(r.failed).toBe(1);
    expect(r.passed).toBe(2);
    expect(r.failures[0].test).toBe("calibrate › adds numbers");
    expect(r.failures[0].at.line).toBe(4);
    expect(r.durationMs).toBeCloseTo(1234, 0);
  });

  it("绝对路径按 cwd 折回工作区相对坐标（点得动才叫位置）", () => {
    const posix = "not ok 1 - x\n  ---\n  location: '/work/proj/test/a.test.js:7:3'\n  ...\n# fail 1\n";
    const r = TR.parse("node-test", posix, 1, { cwd: "/work/proj" });
    expect(r.failures[0].at.file).toBe("test/a.test.js");
  });

  it("退出码是唯一裁判：输出写着 0 failed 但退出码非 0 仍算未通过", () => {
    const r = TR.parse("vitest", " Tests  0 failed | 5 passed (5)\n", 1);
    expect(r.ok).toBe(false);
    expect(r.failed).toBe(0);
    expect(TR.format(r, {}).split("\n")[0]).toContain("测试未通过");
  });

  it("全绿时读得出通过数，回执写【测试通过】", () => {
    const out = " ✓ test/a.test.js (3 tests) 5ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration  88ms\n";
    const r = TR.parse("vitest", out, 0);
    expect(r.ok).toBe(true);
    expect(r.passed).toBe(3);
    expect(TR.format(r, {})).toContain("【测试通过】vitest：3 个用例通过");
  });

  it("「没找到测试文件」不许被当成测试失败（否则模型去改本来没坏的代码）", () => {
    const r = TR.parse("vitest", " No test files found, exiting with code 1\n", 1);
    expect(r.noTestsFound).toBe(true);
    expect(TR.format(r, {})).toContain("一个测试文件都没匹配到");
  });

  it("ANSI 转义与 CRLF 不影响解析", () => {
    const ESC = String.fromCharCode(27);
    const noisy = VITEST_OUT.replace(/\n/g, "\r\n").replace(/FAIL/g, ESC + "[31mFAIL" + ESC + "[39m");
    expect(TR.parse("vitest", noisy, 1).failures.length).toBe(2);
  });

  it("认不出形状时如实说没解析出来，而不是编一个位置", () => {
    const r = TR.parse("generic", "make: *** [Makefile:12: check] Error 1\n", 2);
    expect(r.ok).toBe(false);
    expect(r.unrecognized).toBe(true);
    expect(TR.format(r, {})).toContain("没能从输出里解析出具体失败位置");
  });

  it("失败超过 12 条只列前 12 条并说明还有多少", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      " FAIL  test/a.test.js > case " + i + "\nAssertionError: boom " + i + "\n ❯ test/a.test.js:" + (i + 1) + ":1").join("\n");
    const r = TR.parse("vitest", many + "\n Tests  15 failed (15)\n", 1);
    expect(r.failures.length).toBe(12);
    expect(r.moreFailures).toBe(3);
    expect(TR.format(r, {})).toContain("另有 3 条未列出");
  });

  it("回执不超预算（模型的上下文比日志值钱）", () => {
    const r = TR.parse("vitest", VITEST_OUT + "\n" + "x".repeat(40000), 1);
    expect(TR.format(r, { budget: 6000 }).length).toBeLessThanOrEqual(6100);
  });
});
