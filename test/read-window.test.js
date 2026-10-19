/* read_file 精准取段：symbol / 行区间 / 超 1MB 自动退段。
   ————————————————————————————————————————————
   这一项要治的是"大文件读一眼就断片"：以前整读要么撑爆上下文后被头尾截断砍掉中段
   （模型看到的是一份拼出来的假全景，它不知道自己缺了中间），要么撞 FILE_TOO_LARGE
   之后只能自己写脚本按行 dump。现在一次调用拿到"第几行到第几行、总共几行、下一段从哪续"。
   所以判据的重点不在"读到内容"，而在**回执里的数字与真实行号一致**——
   数字错了，模型就会拿着错行号去写 old_string。 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FileStore } = require("../server/files");
const tools = require("../server/tools/file-tools");

let dir, store, agent;

function fakeAgent(wsDir, index) {
  const card = () => ({ body() {}, done() {} });
  const st = new FileStore(wsDir, null);
  return {
    files: st,
    emit() {}, tool: card, fileChanged() {}, pushChanges() {},
    _repoIndex: () => index || { files: [] },
    _storeForTest: st,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-rw-"));
  agent = fakeAgent(dir);
  store = agent._storeForTest;
});
afterEach(() => {
  try { store.close && store.close(); } catch (e) { /* 已关 */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* Windows 句柄未放 */ }
});

const write = (rel, text) => fs.writeFileSync(path.join(dir, rel), text, "utf8");

describe("行区间取段", () => {
  it("给的行号范围与回执说的完全一致", async () => {
    write("a.js", Array.from({ length: 500 }, (_, i) => "L" + (i + 1)).join("\n"));
    const out = await tools.read_file(agent, { path: "a.js", startLine: 200, endLine: 204 });
    const lines = out.split("\n");
    expect(lines[0]).toContain("共 500 行，本次返回第 200–204 行");
    expect(lines.slice(1, 6).join("\n")).toBe(["L200", "L201", "L202", "L203", "L204"].join("\n"));
    expect(out).toContain("续读用 read_file { path: a.js, startLine: 205 }");
  });

  it("只给 startLine 时按默认 400 行给，并说明读到哪", async () => {
    write("b.js", Array.from({ length: 1000 }, (_, i) => "x" + i).join("\n"));
    const out = await tools.read_file(agent, { path: "b.js", startLine: 100 });
    expect(out.split("\n")[0]).toContain("本次返回第 100–499 行");
  });

  it("读到文件尾就不谎称「还有后续」", async () => {
    write("c.js", "1\n2\n3");
    const out = await tools.read_file(agent, { path: "c.js", startLine: 2, lineCount: 9 });
    expect(out).toContain("共 3 行，本次返回第 2–3 行");
    expect(out).not.toContain("续读用");
  });

  it("区间越界时直说到第几行为止，不返回空面", async () => {
    write("d.js", "1\n2\n3");
    const out = await tools.read_file(agent, { path: "d.js", startLine: 99 });
    expect(out).toContain("第 99 行起没有内容");
    expect(out).toContain("文件到第 3 行为止");
  });
});

describe("symbol 取段", () => {
  const SRC = [
    "// 注释里有 { 不算数",
    "const s = \"} 字符串里的花括号\";",
    "function target(a, b) {",
    "  if (a) { return b + \"}\"; }",
    "  return { done: true };",
    "}",
    "function other() { return 1; }",
  ].join("\n");

  it("按块尾收整个函数：花括号在字符串和注释里都不算配对", async () => {
    write("e.js", SRC);
    agent._repoIndex = () => ({ files: [{ path: "e.js", symbols: [{ name: "target", kind: "function", line: 3 }] }] });
    const out = await tools.read_file(agent, { path: "e.js", symbol: "target" });
    const body = out.split("\n").slice(1).join("\n");
    expect(body).toBe(SRC.split("\n").slice(2, 6).join("\n"));
    expect(out).toContain("function target 起自第 3 行（索引），本次返回第 3–6 行");
    expect(out).toContain("共 7 行");
  });

  it("符号其实属于别的文件时，把真实位置报回来而不是读错文件", async () => {
    // f.js 里没有 a 的定义（有就该优先读本文件的定义，那是更贴近"我要这个函数"的语义）
    write("f.js", "// 这里什么都没有\n");
    agent._repoIndex = () => ({ files: [{ path: "elsewhere.js", symbols: [{ name: "a", kind: "const", line: 9 }] }] });
    const out = await tools.read_file(agent, { path: "f.js", symbol: "a" });
    expect(out).toContain("elsewhere.js:9");
    expect(out).not.toContain("什么都没有");
  });

  it("索引没跟上（符号行已不存在）时承认索引过期，而不是回一句空", async () => {
    write("g.js", "短");
    agent._repoIndex = () => ({ files: [{ path: "g.js", symbols: [{ name: "gone", kind: "function", line: 4000 }] }] });
    const out = await tools.read_file(agent, { path: "g.js", symbol: "gone" });
    expect(out).toContain("读不到内容");
    expect(out).toContain("repo_map");
  });

  it("符号名压根不在文件里时给出下一步，不闷声读全文", async () => {
    write("h.js", "line1\nline2");
    const out = await tools.read_file(agent, { path: "h.js", symbol: "nope" });
    expect(out).toContain("没找到定义行");
    expect(out).not.toContain("line1");
  });

  it("索引没覆盖这个文件时靠文本扫到定义行（symbol 不能只活在索引里）", async () => {
    write("i.js", "// 无关注释\nconst helper = 1;\nexport function picked(a) {\n  return helper + a;\n}\n");
    // _repoIndex 返回空索引：模拟 FileStore 500 文件上限把大仓截断后的情形
    const out = await tools.read_file(agent, { path: "i.js", symbol: "picked" });
    expect(out).toContain("本次返回第 3–5 行");
    expect(out).toContain("文本定位");
    expect(out.split("\n")[1]).toBe("export function picked(a) {");
  });

  it("只有调用点而没有定义时不猜，把出现过的行号交回去", async () => {
    write("j.js", "function real() {\n  return ghost();\n}\n");
    const out = await tools.read_file(agent, { path: "j.js", symbol: "ghost" });
    expect(out).toContain("没找到定义行");
    expect(out).toContain("第 2 行出现过");
    expect(out).not.toContain("function real()");
  });
});

describe("超过 1MB 整读闸的大文件", () => {
  it("整读被挡时自动退成第 1–400 行，并说清是闸挡的", async () => {
    const big = Array.from({ length: 30000 }, (_, i) => "BIG" + i + " " + "z".repeat(40)).join("\n");
    expect(Buffer.byteLength(big)).toBeGreaterThan(1024 * 1024);
    write("big.js", big);
    const out = await tools.read_file(agent, { path: "big.js" });
    expect(out.split("\n")[0]).toContain("整读上限 1MB 已触发");
    expect(out).toContain("本次返回第 1–400 行");
    expect(out).toContain("BIG0");
    expect(out).not.toContain("BIG29999");
  });

  it("大文件也能直接读到中间某一段（这才是取段的正事）", async () => {
    const big = Array.from({ length: 30000 }, (_, i) => "M" + i).join("\n");
    write("big2.js", big);
    const out = await tools.read_file(agent, { path: "big2.js", startLine: 20000, lineCount: 2 });
    expect(out).toContain("本次返回第 20000–20001 行");
    // 第 1 行是 M0，所以第 20000 行是 M19999 —— 行号与内容必须这样对得上
    expect(out.split("\n")[1]).toBe("M19999");
  });
});
