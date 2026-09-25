/* ============================================================
   W13 fast-apply 单测：确定性模糊匹配（fuzzy 机械 merge）
   - 步骤 A 空白归一化：缩进差异 / CRLF / 尾随空格
   - 步骤 B 行级 LCS 滑窗：行内容小改 / 行数漂移；短块(<3行)不启用
   - 安全约束：不唯一拒绝 / 低于阈值拒绝 / 空 old 整文件重写不受影响
   - 乐观锁：fuzzy 暂存后无关行变更不误报 conflict；目标区块被改才 conflict
   ============================================================ */
const { applyEditsToString, parsePatchText, fuzzyFindBlock, PatchEngine } = require("../server/patch");

/* 内存 FileStore 桩 */
function mockFileStore(files) {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    read: (p) => { if (!(p in files)) throw new Error("不存在: " + p); return files[p]; },
    write: (p, c) => { files[p] = c; },
    remove: (p) => { delete files[p]; },
  };
}

describe("fuzzyFindBlock — 步骤 A 空白归一化", () => {
  it("缩进差异（文件 tab vs old 4 空格）命中 ratio=1", () => {
    const file = "function a() {\n\treturn 1;\n}\n\nfunction b() {\n\treturn 2;\n}\n";
    const old = "function b() {\n    return 2;\n}";
    const r = fuzzyFindBlock(file, old);
    expect(r).not.toBeNull();
    expect(r.ratio).toBe(1);
    expect(file.split("\n")[r.start]).toContain("function b()");
  });

  it("CRLF 文件 vs LF old 命中", () => {
    const file = "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n";
    const r = fuzzyFindBlock(file, "const a = 1;\nconst b = 2;\nconst c = 3;");
    expect(r).not.toBeNull();
    expect(r.ratio).toBe(1);
  });

  it("归一化意义下多处命中 → 拒绝（不唯一）", () => {
    const file = "if (x) {\n  work();\n}\nmid\nif (x) {\n  work();\n}\n";
    const r = fuzzyFindBlock(file, "if (x) {\nwork();\n}");
    expect(r).toBeNull();
  });
});

describe("fuzzyFindBlock — 步骤 B 行级 LCS 滑窗", () => {
  it("old 行内容与文件有小差异（≥3 行）→ 命中且标注 ratio", () => {
    const file = "start\nconst total = compute(a, b);\nlog(total);\nreturn total;\nend";
    const old = "const total = compute(x, y);\nlog(result);\nreturn sum;";
    const r = fuzzyFindBlock(file, old);
    expect(r).not.toBeNull();
    expect(r.ratio).toBeGreaterThanOrEqual(0.85);
  });

  it("行数漂移 ±2 内命中", () => {
    const file = "a1\na2\nb1\nb2\nb3\nb4\nc1\nc2";
    const old = "b1\nb2\nb3";
    const r = fuzzyFindBlock(file, old);
    expect(r).not.toBeNull();
  });

  it("完全不相关内容 → null（阈值拦截）", () => {
    const file = "alpha\nbravo\ncharlie\ndelta\necho";
    const r = fuzzyFindBlock(file, "完全\n不同\n的内容");
    expect(r).toBeNull();
  });

  it("短 old（<3 行）内容小改不启用滑窗 → null（防误匹配）", () => {
    const file = "start\nconst aa = 1;\nend";
    const r = fuzzyFindBlock(file, "const bb = 2;");
    expect(r).toBeNull();
  });
});

describe("applyEditsToString — fuzzy 降级", () => {
  it("精确命中时不标 fuzzy", () => {
    const r = applyEditsToString("hello\nworld\n", [{ old_string: "world", new_string: "there" }]);
    expect(r.edits[0].ok).toBe(true);
    expect(r.edits[0].fuzzy).toBeFalsy();
    expect(r.modified).toBe("hello\nthere\n");
  });

  it("缩进差异 → fuzzy 成功替换并标记 ratio", () => {
    const file = "class Foo {\n\tdef bar(self):\n\t\tpass\n}\n";
    const r = applyEditsToString(file, [{ old_string: "class Foo {\n    def bar(self):\n        pass\n}", new_string: "class Foo {\n    def bar(self):\n        return 1\n}" }]);
    expect(r.edits[0].ok).toBe(true);
    expect(r.edits[0].fuzzy).toBe(true);
    expect(r.modified).toContain("return 1");
    expect(r.modified).toContain("class Foo {");
  });

  it("CRLF 保持：fuzzy 替换后新行也带 CR", () => {
    const file = "line1\r\nline2\r\nline3\r\ntail";
    const r = applyEditsToString(file, [{ old_string: "line1\nline2\nline3", new_string: "line1\nNEW\nline3" }]);
    expect(r.edits[0].ok).toBe(true);
    expect(r.edits[0].fuzzy).toBe(true);
    expect(r.modified).toBe("line1\r\nNEW\r\nline3\r\ntail");
  });

  it("彻底不匹配仍失败（报错文案更新）", () => {
    const r = applyEditsToString("aaa\nbbb\nccc", [{ old_string: "xxx\nyyy", new_string: "zzz" }]);
    expect(r.edits[0].ok).toBe(false);
    expect(r.edits[0].error).toContain("模糊匹配未命中");
  });

  it("空 old_string 整文件重写不受 fuzzy 影响", () => {
    const r = applyEditsToString("old content", [{ old_string: "", new_string: "brand new" }]);
    expect(r.edits[0].ok).toBe(true);
    expect(r.modified).toBe("brand new");
  });

  it("Aider patch 文本块走 fuzzy（parsePatchText 链路）", () => {
    const text = "src/a.js\n<<<<<<< SEARCH\nconst x = 1;\nconst y = 2;\nconst z = 3;\n=======\nconst x = 10;\nconst y = 20;\nconst z = 30;\n>>>>>>> REPLACE";
    const specs = parsePatchText(text);
    expect(specs).toHaveLength(1);
    /* 文件里是缩进版（LLM 常犯的缩进差）→ fuzzy 兜住 */
    const file = "function f() {\n  const x = 1;\n  const y = 2;\n  const z = 3;\n}";
    const r = applyEditsToString(file, specs[0].edits);
    expect(r.edits[0].ok).toBe(true);
    expect(r.modified).toContain("const x = 10;");
  });
});

describe("PatchEngine 全链路 — stage(模糊) → apply 乐观锁", () => {
  it("fuzzy 暂存后无关行变更 → apply 不误报 conflict", () => {
    const files = { "a.js": "header\nconst x = 1;\nconst y = 2;\nconst z = 3;\nfooter" };
    const eng = new PatchEngine(mockFileStore(files));
    const res = eng.stage("c1", { path: "a.js", edits: [{ old_string: "const x = 1;\nconst y = 2;\nconst z = 3;", new_string: "const x = 100;\nconst y = 200;\nconst z = 300;" }] });
    expect(res.ok).toBe(true);
    expect(res.staged[0].hunks[0].fuzzy).toBe(false);   // 逐字存在 → 精确命中，不走 fuzzy
    /* 真 fuzzy 场景：缩进差异版 */
    const files2 = { "b.js": "function f() {\n\tconst p = 1;\n\tconst q = 2;\n}" };
    const eng2 = new PatchEngine(mockFileStore(files2));
    const res2 = eng2.stage("c2", { path: "b.js", edits: [{ old_string: "const p = 1;\nconst q = 2;", new_string: "const p = 11;\nconst q = 22;" }] });
    /* 2 行 short old：文件里逐字存在（含缩进的行内容 trim 后不同）……实际文件行含 \t 前缀，
       old 无缩进 → 精确 indexOf 失败 → 步骤 A 归一化命中（行数=2，步骤 A 不限行数） */
    expect(res2.ok).toBe(true);
    expect(res2.staged[0].hunks[0].fuzzy).toBe(true);
    /* stage 后文件被无关改动（header 变了）→ 乐观锁 fuzzy 重定位仍命中 → 不冲突 */
    files2["b.js"] = "// header comment\nfunction f() {\n\tconst p = 1;\n\tconst q = 2;\n}";
    const ap = eng2.apply("c2", ["b.js"]);
    expect(ap.conflicts).toHaveLength(0);
    expect(ap.applied).toContain("b.js");
    expect(files2["b.js"]).toContain("const p = 11;");
  });

  it("目标区块被破坏 → conflict（fuzzy 重定位失败）", () => {
    const files = { "c.js": "function f() {\n\tconst p = 1;\n\tconst q = 2;\n}" };
    const eng = new PatchEngine(mockFileStore(files));
    const res = eng.stage("c3", { path: "c.js", edits: [{ old_string: "const p = 1;\nconst q = 2;", new_string: "const p = 9;\nconst q = 9;" }] });
    expect(res.ok).toBe(true);
    files["c.js"] = "function f() {\n\tconst p = 111111;\n\tconst q = 2;\n}";   // 区块内容已变
    const ap = eng.apply("c3", ["c.js"]);
    expect(ap.conflicts).toContain("c.js");
  });

  it("auto 模式端到端：apply_edit 工具链 stage+apply 落盘", () => {
    const files = { "d.js": "function g() {\n\treturn 1;\n}" };
    const eng = new PatchEngine(mockFileStore(files));
    const res = eng.stage("c4", { path: "d.js", edits: [{ old_string: "return 1;", new_string: "return 42;" }] });
    expect(res.ok).toBe(true);
    const ap = eng.apply("c4", ["d.js"]);
    expect(ap.applied).toContain("d.js");
    expect(files["d.js"]).toContain("return 42;");
  });
});
