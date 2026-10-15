/* P1-B1：写盘之后，LSP 诊断必须回到模型眼前。
   ————————————————————————————————————————————
   波浪线只有人看得见，模型看不见。它写完就接着往下推，直到 run_command 撞车才发现语法错——
   来回一趟就是几轮预算和一截上下文。所以 write_file / edit_files 的回执里要带【LSP 诊断】。
   这条链路只在"有语言服务器"时才成立，真机上装没装 pyright 是环境问题、不是代码问题，
   所以这里用一个假 manager 把**接线**钉住：有诊断就拼、没有就不吵、manager 缺席也不炸。
   全程用内存 store，一个字节都不落盘。 */
/* vitest 配了 globals:true，且本仓 server 侧全是 CommonJS——用 require 才能保证
   这里设的假 manager 与被测模块里的 getActiveManager 是同一份实例
   （用 import()/await import() 会拿到另一份模块图，测试表现为"诊断永远为空"地假绿）。 */
const path = require("node:path");
const os = require("node:os");
const { setActiveManager } = require("../server/lsp-bridge");
const tools = require("../server/tools/file-tools");

function fakeStore(dir, files) {
  const map = new Map(Object.entries(files || {}));
  return {
    dir,
    exists: (p) => map.has(p),
    read: (p) => (map.has(p) ? map.get(p) : ""),
    write: (p, c) => { map.set(p, c); },
    remove: (p) => { map.delete(p); },
    _map: map,
  };
}

function fakeAgent(files) {
  const store = fakeStore(path.join(os.tmpdir(), "pc-diag-" + process.pid), files);
  const card = () => ({ body() {}, done() {} });
  return {
    files: store,
    emit() {}, tool: card, fileChanged() {}, pushChanges() {}, _recordWrite() {},
    _snapshotBefore: (p, s) => ({ path: p, beforeExisted: s.exists(p), beforeContent: s.exists(p) ? s.read(p) : null, store: null, dir: s.dir }),
    _pushCheckpoint() {},
    _gate: async () => ({ blocked: false, approved: true }),
    _store: store,
  };
}

/* LSP 的 Diagnostic：severity 1=错误 2=警告，range 是 0-based */
const diagOf = (msgs) => ({ scope: "file", items: msgs.map((m) => ({
  severity: m.sv, message: m.msg, source: m.src || "pyright",
  range: { start: { line: (m.line || 1) - 1, character: 0 } },
})) });

let mgr = null;
afterEach(() => { mgr = null; setActiveManager(null); });

describe("diagBlock 回灌（经写盘工具）", () => {
  it("write_file 的回执里带上诊断条目与行列", async () => {
    const agent = fakeAgent({ "a.py": "x = 1\n" });
    mgr = { getDiagnostics: () => diagOf([{ sv: 1, msg: "Expected expression", line: 2 }]) };
    setActiveManager(mgr);
    const out = await tools.write_file(agent, { path: "a.py", content: "def f(:\n" });
    expect(out).toContain("写入成功");
    expect(out).toContain("【LSP 诊断】1 个错误、0 个警告");
    expect(out).toContain("Expected expression");
    expect(out).toContain("2:1");                     // 行列来自 range（0-based → 显示 1-based）
    expect(out).toContain("建议修复上述错误后再继续。");
  });

  it("没有诊断时不往回执里塞空段落（回执长度是要钱的）", async () => {
    const agent = fakeAgent({ "b.py": "x = 1\n" });
    mgr = { getDiagnostics: () => ({ scope: "file", items: [] }) };
    setActiveManager(mgr);
    const out = await tools.write_file(agent, { path: "b.py", content: "x = 2\n" });
    expect(out).not.toContain("【LSP 诊断】");
  });

  it("语言服务器缺席时写入照样成功，不抛错也不谎报", async () => {
    const agent = fakeAgent({ "c.py": "x = 1\n" });
    setActiveManager(null);                            // 没装 pyright / LSP 未起
    const out = await tools.write_file(agent, { path: "c.py", content: "x = 2\n" });
    expect(out).toContain("写入成功");
    expect(out).not.toContain("【LSP 诊断】");
  });

  it("getDiagnostics 自己炸了也不能把写入结果吞掉", async () => {
    const agent = fakeAgent({ "d.py": "x = 1\n" });
    mgr = { getDiagnostics: () => { throw new Error("lsp died"); } };
    setActiveManager(mgr);
    const out = await tools.write_file(agent, { path: "d.py", content: "x = 2\n" });
    expect(out).toContain("写入成功: d.py");
  });

  it("edit_files 一批改多个文件时，诊断按文件点名、只等一次 LSP", async () => {
    const agent = fakeAgent({ "e1.py": "A1\n", "e2.py": "B1\n" });
    let calls = 0;
    mgr = {
      getDiagnostics: (dir, rel) => {
        calls++;
        return rel === "e2.py" ? diagOf([{ sv: 2, msg: "unused variable 'b'", line: 3, src: "ruff" }]) : { scope: "file", items: [] };
      },
    };
    setActiveManager(mgr);
    const out = await tools.edit_files(agent, { ops: [
      { path: "e1.py", old_string: "A1", new_string: "A2" },
      { path: "e2.py", old_string: "B1", new_string: "B2" },
    ] });
    expect(out).toContain("已原子写入 2 个文件");
    expect(out).toContain("【LSP 诊断】0 个错误、1 个警告");
    expect(out).toContain("e2.py");                    // 点名是哪个文件的问题
    expect(out).toContain("unused variable");
    /* 一次调用只等一轮：每个文件各等 400ms 的话，批量编辑会比单文件慢 N 倍 */
    expect(calls).toBe(2);
  });

  it("跨根写的文件不在当前工作区，不拿工作区的诊断去冒充它", async () => {
    const agent = fakeAgent({ "f.py": "A\n" });
    const seen = [];
    mgr = { getDiagnostics: (dir, rel) => { seen.push(dir + "|" + rel); return { scope: "file", items: [] }; } };
    setActiveManager(mgr);
    await tools.write_file(agent, { path: "f.py", content: "B\n" });
    expect(seen[0]).toBe(agent.files.dir + "|f.py");   // 问的是这个 store 自己的目录
  });
});
