/* 补丁引擎单测（Vitest 版）—— 从 scripts/test-patch.js 迁移核心断言 */

const { applyEditsToString, parsePatchText, diffStat } = require("../server/patch");

describe("diffStat", () => {
  it("新增 2 行删除 1 行", () => {
    const s = diffStat("a\nb\nc", "a\nx\ny\nc");
    expect(s.add).toBe(2);
    expect(s.del).toBe(1);
  });
});

describe("applyEditsToString", () => {
  it("基础替换", () => {
    const r = applyEditsToString("function f(){\n  return 1;\n}", [{ old_string: "return 1;", new_string: "return 2;" }]);
    expect(r.modified).toBe("function f(){\n  return 2;\n}");
    expect(r.edits[0].ok).toBe(true);
  });

  it("old_string 不存在 → 标记失败", () => {
    const r = applyEditsToString("abc", [{ old_string: "xyz", new_string: "q" }]);
    expect(r.edits[0].ok).toBe(false);
    expect(r.edits[0].error).toMatch(/不存在/);
  });

  it("old_string 不唯一 → 标记失败", () => {
    const r = applyEditsToString("a\na\nb", [{ old_string: "a", new_string: "Z" }]);
    expect(r.edits[0].ok).toBe(false);
    expect(r.edits[0].error).toMatch(/不唯一/);
  });

  it("多片段顺序应用", () => {
    const r = applyEditsToString("x=1;\ny=2;\nz=3;", [
      { old_string: "x=1;", new_string: "x=10;" },
      { old_string: "z=3;", new_string: "z=30;" },
    ]);
    expect(r.modified).toBe("x=10;\ny=2;\nz=30;");
    expect(r.edits.every((e) => e.ok)).toBe(true);
  });

  it("新建（空 old_string）", () => {
    const r = applyEditsToString("", [{ old_string: "", new_string: "hello\nworld" }]);
    expect(r.modified).toBe("hello\nworld");
  });
});

describe("parsePatchText", () => {
  it("解析多文件 search/replace 块", () => {
    const text = "src/a.js\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\nsrc/b.js\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE";
    const files = parsePatchText(text);
    expect(files.length).toBe(2);
    expect(files[0].path).toBe("src/a.js");
    expect(files[0].edits[0].old_string).toBe("old");
    expect(files[0].edits[0].new_string).toBe("new");
    expect(files[1].path).toBe("src/b.js");
  });
});

describe("PatchEngine apply 冲突检测", () => {
  it("返回 { applied, conflicts } 结构", () => {
    const { PatchEngine } = require("../server/patch");
    const fakeFiles = {
      exists: () => true,
      read: () => "original content",
      write: () => {},
    };
    const engine = new PatchEngine(fakeFiles);
    engine.stage("conv1", { path: "test.js", old_string: "original", new_string: "modified" });
    const result = engine.apply("conv1", ["test.js"]);
    expect(result).toHaveProperty("applied");
    expect(result).toHaveProperty("conflicts");
    expect(result.applied).toContain("test.js");
    expect(result.conflicts).toEqual([]);
  });

  it("检测 stage 后文件被改动 → 冲突", () => {
    const { PatchEngine } = require("../server/patch");
    let fileContent = "original content";
    const fakeFiles = {
      exists: () => true,
      read: () => fileContent,
      write: (p, c) => { fileContent = c; },
    };
    const engine = new PatchEngine(fakeFiles);
    engine.stage("conv1", { path: "test.js", old_string: "original", new_string: "modified" });
    // 模拟其他会话改了文件
    fileContent = "completely different content";
    const result = engine.apply("conv1", ["test.js"]);
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toContain("test.js");
  });
});