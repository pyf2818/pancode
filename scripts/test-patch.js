/* 补丁引擎单测：验证 applyEditsToString / parsePatchText / diffStat
   运行：node scripts/test-patch.js */
"use strict";
const assert = require("assert");
const { applyEditsToString, parsePatchText, diffStat, PatchEngine } = require("../server/patch");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

console.log("== diffStat ==");
ok("新增 2 行删除 1 行", (() => {
  const s = diffStat("a\nb\nc", "a\nx\ny\nc");
  return s.add === 2 && s.del === 1;
})());

console.log("== applyEditsToString：基础替换 ==");
{
  const r = applyEditsToString("function f(){\n  return 1;\n}", [{ old_string: "return 1;", new_string: "return 2;" }]);
  ok("替换成功", r.modified === "function f(){\n  return 2;\n}" && r.edits[0].ok);
}

console.log("== applyEditsToString：old_string 不存在 ==");
{
  const r = applyEditsToString("abc", [{ old_string: "xyz", new_string: "q" }]);
  ok("标记失败且有错误", !r.edits[0].ok && /不存在/.test(r.edits[0].error));
}

console.log("== applyEditsToString：old_string 不唯一 ==");
{
  const r = applyEditsToString("a\na\nb", [{ old_string: "a", new_string: "Z" }]);
  ok("标记失败且提示不唯一", !r.edits[0].ok && /不唯一/.test(r.edits[0].error));
}

console.log("== applyEditsToString：多片段顺序应用 ==");
{
  const r = applyEditsToString("x=1;\ny=2;\nz=3;", [
    { old_string: "x=1;", new_string: "x=10;" },
    { old_string: "z=3;", new_string: "z=30;" },
  ]);
  ok("两处都改好", r.modified === "x=10;\ny=2;\nz=30;" && r.edits.every((e) => e.ok));
}

console.log("== applyEditsToString：新建（空 old_string） ==");
{
  const r = applyEditsToString("", [{ old_string: "", new_string: "hello\nworld" }]);
  ok("整文件写入", r.modified === "hello\nworld");
}

console.log("== parsePatchText：Aider 块 ==");
{
  const text = `src/app.js
<<<<<<< SEARCH
const a = 1;
=======
const a = 2;
>>>>>>> REPLACE
src/util.js
<<<<<<< SEARCH
export function hello(){
  return "hi";
}
=======
export function hello(){
  return "hello";
}
>>>>>>> REPLACE`;
  const files = parsePatchText(text);
  ok("解析出 2 个文件", files.length === 2);
  ok("文件1路径正确", files[0].path === "src/app.js");
  ok("文件2片段正确", files[1].edits[0].new_string === 'export function hello(){\n  return "hello";\n}');
}

console.log("== PatchEngine：暂存 + 应用 ==");
{
  // 用一个内存版 FileStore 替身
  const mem = {};
  const fakeStore = {
    exists: (p) => Object.prototype.hasOwnProperty.call(mem, p),
    read: (p) => mem[p],
    write: (p, c) => { mem[p] = c; },
  };
  const eng = new PatchEngine(fakeStore);
  mem["a.txt"] = "line1\nline2\n";
  const r1 = eng.stage("c1", { path: "a.txt", edits: [{ old_string: "line2", new_string: "LINE2" }] });
  ok("stage 成功", r1.ok && r1.staged.length === 1);
  ok("stage 后磁盘未变", mem["a.txt"] === "line1\nline2\n");
  const applied = eng.apply("c1", []);
  ok("apply 写入磁盘", mem["a.txt"] === "line1\nLINE2\n" && applied[0] === "a.txt");
  ok("apply 后清空暂存", eng.list("c1").length === 0);
}

console.log("== PatchEngine：拒绝 ==");
{
  const mem = { "b.txt": "x" };
  const fakeStore = { exists: (p) => p in mem, read: (p) => mem[p], write: (p, c) => { mem[p] = c; } };
  const eng = new PatchEngine(fakeStore);
  eng.stage("c2", { path: "b.txt", edits: [{ old_string: "x", new_string: "y" }] });
  eng.reject("c2", []);
  ok("拒绝后磁盘不变", mem["b.txt"] === "x");
  ok("拒绝后暂存清空", eng.list("c2").length === 0);
}

console.log("== PatchEngine：逐 hunk 部分应用 ==");
{
  const mem = { "c.txt": "A\nB\nC\nD\n" };
  const fakeStore = { exists: (p) => p in mem, read: (p) => mem[p], write: (p, c) => { mem[p] = c; } };
  const eng = new PatchEngine(fakeStore);
  // 三个片段：改 B、改 C、改 A，各自唯一
  eng.stage("c3", { path: "c.txt", edits: [
    { old_string: "B", new_string: "b" },
    { old_string: "C", new_string: "c" },
    { old_string: "A", new_string: "a" },
  ] });
  // 只接受第 0 和第 2 个 hunk（B 和 A），拒绝第 1 个（C）
  const applied = eng.apply("c3", ["c.txt"], { "c.txt": [0, 2] });
  ok("应用了选中文件", applied.length === 1 && applied[0] === "c.txt");
  ok("仅选中 hunk 生效（B→b, A→a, C 保留）", mem["c.txt"] === "a\nb\nC\nD\n");
}

console.log("== PatchEngine：空 hunk 选择 = 整文件拒绝 ==");
{
  const mem = { "d.txt": "X\nY\n" };
  const fakeStore = { exists: (p) => p in mem, read: (p) => mem[p], write: (p, c) => { mem[p] = c; } };
  const eng = new PatchEngine(fakeStore);
  eng.stage("c4", { path: "d.txt", edits: [{ old_string: "X", new_string: "Z" }] });
  const applied = eng.apply("c4", ["d.txt"], { "d.txt": [] });
  ok("空选择不写盘", applied.length === 0 && mem["d.txt"] === "X\nY\n");
  ok("空选择后暂存清空", eng.list("c4").length === 0);
}

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
