/* 验证 ⑬ LSP 诊断喂给 Agent：
   - LspManager 能缓存 textDocument/publishDiagnostics
   - getDiagnostics 按文件 / 工作区两种粒度返回，且 Windows/Unix 路径归一化一致
   直接调用与 parser.onMessage 相同的 _storeDiagnostics 入口，等价于真实代理路径。 */
"use strict";
const { LspManager } = require("../server/lsp-bridge");

let ok = true;
function assert(cond, msg) {
  if (!cond) { ok = false; console.error("  ✗ " + msg); }
  else console.log("  ✓ " + msg);
}

const WS = process.platform === "win32" ? "E:/tmp/pancode_ws" : "/tmp/pancode_ws";
const mgr = new LspManager({});

// 模拟语言服务器推送的诊断（与 parser.onMessage 拦截逻辑一致）
mgr._storeDiagnostics("javascript", "file:///" + WS.replace(/\\/g, "/") + "/src/a.js", [
  { severity: 1, range: { start: { line: 0, character: 2 } }, message: "Cannot find name 'foo'", source: "ts" },
  { severity: 2, range: { start: { line: 5, character: 0 } }, message: "unused var", source: "ts" },
]);
mgr._storeDiagnostics("python", "file:///" + WS.replace(/\\/g, "/") + "/src/b.py", [
  { severity: 1, range: { start: { line: 3, character: 1 } }, message: "undefined name 'bar'" },
]);
// 空诊断：文件已无错误，但应保留条目（模型可见“该文件无错误”）
mgr._storeDiagnostics("python", "file:///" + WS.replace(/\\/g, "/") + "/src/clean.py", []);

console.log("[1] 工作区级诊断汇总");
const wsDiag = mgr.getDiagnostics(WS);
assert(wsDiag.ok && wsDiag.scope === "workspace", "scope=workspace");
assert(wsDiag.errors === 2, "errors=2（a.js 1 + b.py 1）");
assert(wsDiag.warnings === 1, "warnings=1（a.js 1）");
assert(wsDiag.files.length === 3, "files=3（含 clean.py 空诊断）");
const paths = wsDiag.files.map((f) => f.path);
assert(paths[0] === "src/a.js", "路径归一化为相对路径: " + paths[0]);
assert(wsDiag.files.find((f) => f.path === "src/clean.py").items.length === 0, "clean.py 保留空诊断条目");

console.log("[2] 单文件诊断");
const fDiag = mgr.getDiagnostics(WS, "src/a.js");
assert(fDiag.scope === "file", "scope=file");
assert(fDiag.language === "javascript", "language=javascript");
assert(fDiag.items.length === 2, "items=2");
assert(fDiag.items[0].message === "Cannot find name 'foo'", "首条为 foo 未定义");

console.log("[3] 不存在的文件返回空");
const none = mgr.getDiagnostics(WS, "src/nope.js");
assert(none.scope === "file" && none.items.length === 0, "未知文件 items=[]");

console.log("[4] 跨工作区隔离");
const other = mgr.getDiagnostics("E:/tmp/other_ws");
assert(other.files.length === 0, "其它工作区无诊断");

console.log("[5] 清空");
mgr.clearDiagnostics();
assert(mgr.getDiagnostics(WS).files.length === 0, "clearDiagnostics 后为空");

console.log(ok ? "\nLSP DIAGNOSTICS OK=true" : "\nLSP DIAGNOSTICS OK=false");
process.exit(ok ? 0 : 1);
