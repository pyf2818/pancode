/* ============================================================
   P2-C2 · 跨文件改名的文本层：整词命中 + 字面量/注释屏蔽 + 倒序替换
   没有解析器（仓库纪律：不引需要编译的 tree-sitter），
   所以这一层的正确性必须靠可证伪的断言钉住，而不是"看起来对"。
   ============================================================ */
const R = require("../server/refactor");

const mask = (t, lang) => R.maskNonCode(t, lang);
const hits = (t, name, lang) => R.findHits(t, R.maskNonCode(t, lang), name);

describe("findHits — 整词边界", () => {
  it("同名前后缀不算命中", () => {
    const t = "getUser();\ngetUserName();\nmyGetUser;\nconst getUserInfo = 1;\ngetUser\n";
    const h = hits(t, "getUser", "js");
    expect(h.map((x) => x.line)).toEqual([1, 5]);
  });
  it("行号与原文行内容对得上", () => {
    const t = "let a = 1;\nconst getUser = (id) => db.get(id);\nlet b = getUser(2);\n";
    const h = hits(t, "getUser", "js");
    expect(h.length).toBe(2);
    expect(h[0].line).toBe(2);
    expect(h[0].def).toBe(true);
    expect(h[0].lineText).toContain("(id) => db.get(id)");
    expect(h[1].line).toBe(3);
    expect(h[1].def).toBe(false);
  });
  it("obj.getUser 算成员访问（方法改名必须带上它）", () => {
    const h = hits("api.getUser(1);\ngetUser(2);\n", "getUser", "js");
    expect(h.map((x) => x.member)).toEqual([true, false]);
  });
  it("$ 是标识符字符：a$b 与 a 不是同一个名字", () => {
    expect(hits("const a$b = 1;\nconst a = 2;\n", "a", "js").map((x) => x.line)).toEqual([2]);
  });
});

describe("maskNonCode — 字符串 / 注释 / 模板 / 正则", () => {
  it("屏蔽后长度不变（位置一一对应，命中偏移才能回到原文）", () => {
    const t = 'const x = "abc";\n// comment\n/* block */\n`tpl`;\n';
    expect(mask(t, "js").length).toBe(t.length);
  });
  it("行注释、块注释、单双引号里的同名不算命中", () => {
    const t = "// getUser 说明\n/* getUser\n   还在注释里 */\nconst s = 'getUser';\nconst d = \"getUser\";\nconst real = getUser();\n";
    expect(hits(t, "getUser", "js").map((x) => x.line)).toEqual([6]);
  });
  it("模板串整段是字面量，但 ${} 插值里算代码", () => {
    const t = "const s = `getUser ${getUser(x)} getUser`;\n";
    const h = hits(t, "getUser", "js");
    expect(h.length).toBe(1);
    expect(t.slice(h[0].at, h[0].at + 7)).toBe("getUser");
    expect(h[0].lineText.slice(h[0].at - 12, h[0].at)).toContain("${");
  });
  it("正则字面量里的同名不算命中，除号不误判成正则", () => {
    const t = "const re = /getUser/;\nconst q = a / b;\ngetUser();\n";
    expect(hits(t, "getUser", "js").map((x) => x.line)).toEqual([3]);
  });
  it("转义引号不会提前结束字符串", () => {
    const t = "const s = 'it\\'s getUser here';\ngetUser();\n";
    expect(hits(t, "getUser", "js").map((x) => x.line)).toEqual([2]);
  });
  it("Python：# 注释与三引号 docstring 屏蔽", () => {
    const t = '# getUser\n"""getUser\n说明"""\ndef getUser():\n    pass\n';
    expect(hits(t, "getUser", "py").map((x) => x.line)).toEqual([4]);
  });
  it("doc 语言不屏蔽（里面本来就没有代码语义）", () => {
    expect(hits("见 `getUser` 函数\n", "getUser", "doc").length).toBe(1);
  });
});

describe("applyHits — 倒序替换", () => {
  it("多处命中全部替换，且偏移不互相打乱", () => {
    const t = "getUser(1);\nconst v = getUser(2) + getUser(3);\n";
    const h = hits(t, "getUser", "js");
    expect(h.length).toBe(3);
    const out = R.applyHits(t, h, "loadUser");
    expect(out).toBe("loadUser(1);\nconst v = loadUser(2) + loadUser(3);\n");
    expect(hits(out, "getUser", "js").length).toBe(0);
  });
  it("注释里的同名保持原样（改完代码注释不会跟着悄悄变）", () => {
    const t = "// getUser 旧名\ngetUser();\n";
    expect(R.applyHits(t, hits(t, "getUser", "js"), "loadUser")).toBe("// getUser 旧名\nloadUser();\n");
  });
});

describe("scanFiles — 文件级取舍与计数", () => {
  const FS = {
    "a.js": "getUser();\n",
    "notes.md": "讲一下 getUser 的用法\n",
    "b.txt": "getUser\n",
    "big.js": "getUser();\n".repeat(200000),
    "bin.js": "getUser();\n\0binary\n",
  };
  const read = (p) => (Object.prototype.hasOwnProperty.call(FS, p) ? FS[p] : null);
  const all = Object.keys(FS);

  it("代码文件计入命中；文档默认只报数量不改", () => {
    const r = R.scanFiles(read, all, "getUser", {});
    const a = r.files.find((f) => f.path === "a.js");
    expect(a.hits.length).toBe(1);
    const md = r.files.find((f) => f.path === "notes.md");
    expect(md.doc).toBe(true);
    expect(md.hits.length).toBe(0);
    expect(md.rawHits).toBe(1);
  });
  it("includeDocs 之后文档才进改名清单", () => {
    const r = R.scanFiles(read, all, "getUser", { includeDocs: true });
    expect(r.files.find((f) => f.path === "notes.md").hits.length).toBe(1);
  });
  it("二进制与超大文件直接跳过（一个 lock 文件不该吃掉整轮）", () => {
    const r = R.scanFiles(read, all, "getUser", {});
    expect(r.files.some((f) => f.path === "bin.js")).toBe(false);
    expect(r.files.some((f) => f.path === "big.js")).toBe(false);
  });
  it("字面量里的同名计入 skipped（模型要知道自己少改了几处）", () => {
    const r = R.scanFiles(() => 'const s = "getUser";\ngetUser();\n', ["x.js"], "getUser", {});
    expect(r.files[0].hits.length).toBe(1);
    expect(r.skipped).toBe(1);
  });
  it("includeLiterals 之后字符串里的也改", () => {
    const r = R.scanFiles(() => 'const s = "getUser";\ngetUser();\n', ["x.js"], "getUser", { includeLiterals: true });
    expect(r.files[0].hits.length).toBe(2);
    expect(r.skipped).toBe(0);
  });
  it("读不到的文件静默跳过，不抛", () => {
    expect(() => R.scanFiles(() => { throw new Error("EACCES"); }, ["x.js"], "getUser", {})).not.toThrow();
  });
});

describe("标识符规则", () => {
  it("合法标识符通过，带路径 / 空格 / 数字开头的拒绝", () => {
    ["getUser", "_x", "$y", "a1_b"].forEach((s) => expect(R.IDENT_RE.test(s)).toBe(true));
    ["a-b", "a b", "1a", "", "src/getUser", "中文"].forEach((s) => expect(R.IDENT_RE.test(s)).toBe(false));
  });
});
