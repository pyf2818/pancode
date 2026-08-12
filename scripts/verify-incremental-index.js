/* 增量代码索引验证：构建 → 更新/新增/删除单文件 → 检索确认增量生效
   运行：node scripts/verify-incremental-index.js
   不依赖网络/浏览器；直接驱动 server/code-index.js 的增量 API。
   注意：用互不重叠的唯一哨兵 token（如 alphaone），避免 BM25 把 "token"
   这种公共子串误判为命中。 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildIndex, search, getIndex, queueFileUpdate, removeFile } = require("../server/code-index");

let ok = true;
const fail = (m) => { ok = false; console.log("  FAIL: " + m); };
const good = (m) => console.log("  OK: " + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const countOf = async (ws, q) => (await search({ wsDir: ws, query: q, k: 20 })).count;
const idxCount = (ws) => { const i = getIndex(ws); return i ? i.meta.count : -1; };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-inc-"));
  try {
    fs.writeFileSync(path.join(tmp, "A.js"), "function alphaone() { return 1; }\nfunction betatwo() { return 2; }\n");
    fs.writeFileSync(path.join(tmp, "B.js"), "function gammathree() { return 3; }\n");

    const built = await buildIndex({ wsDir: tmp, cfg: { embedding: { endpoint: "" } } });
    if (!built.ok) { fail("buildIndex 失败: " + built.error); return finish(); }
    good("初始构建 " + built.count + " 块（" + (built.useVector ? "vector" : "bm25") + "），meta.count=" + idxCount(tmp));
    if (idxCount(tmp) !== 3) fail("初始 meta.count 应为 3，实际 " + idxCount(tmp)); else good("初始 meta.count=3");

    if ((await countOf(tmp, "alphaone")) !== 1) fail("初始 alphaone 应命中 1，实际 " + (await countOf(tmp, "alphaone"))); else good("初始 alphaone 命中");
    if ((await countOf(tmp, "gammathree")) !== 1) fail("初始 gammathree 应命中 1，实际 " + (await countOf(tmp, "gammathree"))); else good("初始 gammathree 命中");

    // 更新 A.js：删除 betatwo，新增 deltafour（alphaone 不变）
    fs.writeFileSync(path.join(tmp, "A.js"), "function alphaone() { return 1; }\nfunction deltafour() { return 9; }\n");
    queueFileUpdate(tmp, "A.js");
    await sleep(1100);

    if ((await countOf(tmp, "betatwo")) !== 0) fail("更新后 betatwo 应消失，实际 " + (await countOf(tmp, "betatwo"))); else good("更新后旧 token betatwo 已消失");
    if ((await countOf(tmp, "deltafour")) !== 1) fail("更新后新 token deltafour 应命中 1，实际 " + (await countOf(tmp, "deltafour"))); else good("更新后新 token deltafour 命中");
    if ((await countOf(tmp, "alphaone")) !== 1) fail("未改动 alphaone 应仍在 1，实际 " + (await countOf(tmp, "alphaone"))); else good("未改动 alphaone 仍在");
    if (idxCount(tmp) !== 3) fail("更新后 meta.count 应为 3，实际 " + idxCount(tmp)); else good("更新后 meta.count=3（A:2 + B:1）");

    // 删除 B.js
    fs.unlinkSync(path.join(tmp, "B.js"));
    removeFile(tmp, "B.js");
    if ((await countOf(tmp, "gammathree")) !== 0) fail("删除后 gammathree 应消失，实际 " + (await countOf(tmp, "gammathree"))); else good("删除后 gammathree 已消失");
    if (idxCount(tmp) !== 2) fail("删除后 meta.count 应为 2，实际 " + idxCount(tmp)); else good("删除后 meta.count=2（仅 A:2）");

    // 新增 C.js
    fs.writeFileSync(path.join(tmp, "C.js"), "function epsilonfive() { return 4; }\n");
    queueFileUpdate(tmp, "C.js");
    await sleep(1100);
    if ((await countOf(tmp, "epsilonfive")) !== 1) fail("新增文件 epsilonfive 应命中 1，实际 " + (await countOf(tmp, "epsilonfive"))); else good("新增文件 C.js 立即可检索 epsilonfive");
    if (idxCount(tmp) !== 3) fail("新增后 meta.count 应为 3，实际 " + idxCount(tmp)); else good("新增后 meta.count=3（A:2 + C:1）");

    // 无索引工作区：queueFileUpdate 应静默 no-op（不崩溃）
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "pc-noi-"));
    fs.writeFileSync(path.join(tmp2, "X.js"), "function nopexyz() {}\n");
    let threw = false;
    try { queueFileUpdate(tmp2, "X.js"); await sleep(900); } catch (e) { threw = true; }
    if (threw) fail("无索引工作区 queueFileUpdate 不应抛错"); else good("无索引工作区 queueFileUpdate 静默 no-op（不崩溃）");
    if (getIndex(tmp2)) fail("无索引工作区不应生成索引"); else good("无索引工作区未生成索引");
    fs.rmSync(tmp2, { recursive: true, force: true });

    finish();
  } catch (e) {
    fail("异常: " + e.message);
    finish();
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
})();

function finish() {
  console.log(ok ? "\nINCREMENTAL INDEX OK=true" : "\nINCREMENTAL INDEX OK=false");
  process.exit(ok ? 0 : 1);
}
