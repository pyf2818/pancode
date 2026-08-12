/* 轻量代码向量索引测试：
   1) chunkFile 分块（函数级 / 窗口退化）
   2) 对临时工作区建索引（无 embedding → BM25 兜底）
   3) 检索能命中相关片段
*/
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildIndex, search, chunkFile } = require("../server/code-index");

let pass = 0;
function ok(n) { console.log("  ✓ " + n); pass++; }

/* 1) 分块 */
(function testChunk() {
  const src = [
    "function foo() {", "  return 1;", "}", "",
    "class Bar {", "  method() { return 2; }", "}", "",
    "const baz = 42;", "export const qux = () => 3;",
  ].join("\n");
  const chunks = chunkFile("a.js", src);
  assert.ok(chunks.length >= 3, "应至少分出 3 个声明片段，实际 " + chunks.length);
  assert.ok(chunks.every((c) => c.path === "a.js" && c.startLine > 0 && c.text.length > 0), "片段字段应齐全");
  ok("chunkFile 函数级分块（" + chunks.length + " 块）");
})();

/* 2) 建索引 + 检索 */
(async function testIndex() {
  const dir = path.join(os.tmpdir(), "pc_idx_" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "calc.py"), [
    "def add(a, b):", "    return a + b", "",
    "def multiply(a, b):", "    return a * b", "",
    "class Calculator:", "    def power(self, x, n):", "        return x ** n",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "util.js"), [
    "function parseJson(text) {", "  return JSON.parse(text);", "}", "",
    "function formatDate(d) {", "  return d.toISOString();", "}",
  ].join("\n"));
  // 无 embedding 配置 → BM25 兜底
  const built = await buildIndex({ wsDir: dir, fileStore: null, cfg: { embedding: { endpoint: "" } } });
  assert.strictEqual(built.ok, true);
  assert.ok(built.count > 0, "索引片段数应 > 0");
  ok("buildIndex 构建索引（" + built.count + " 块，" + (built.useVector ? "vector" : "bm25") + " 模式）");

  const r1 = await search({ wsDir: dir, query: "parse json string", k: 5 });
  assert.strictEqual(r1.ok, true);
  assert.ok(r1.results.length > 0, "检索应返回结果");
  // 相关片段（parseJson）应在前列
  const top = r1.results[0];
  assert.ok(/parseJson|parse/.test(top.title + top.snippet), "top 结果应与 JSON 解析相关，实际: " + top.title);
  ok("search 命中相关片段（top=" + top.path + " · " + top.title + " · score=" + top.score + "）");

  const r2 = await search({ wsDir: dir, query: "multiply numbers", k: 5 });
  assert.ok(r2.results.some((x) => /multiply/.test(x.title)), "应命中 multiply");
  ok("search 多查询命中（multiply）");

  // 清理
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n代码索引测试通过：${pass} 项 ✅`);
  process.exit(0);
})().catch((e) => { console.error("代码索引测试失败:", e); process.exit(1); });
