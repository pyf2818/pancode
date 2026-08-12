/* 验证 ⑧ /undo 检查点：单步回滚
   - 用真实 LlmAgent.prototype 的 _snapshotBefore / _pushCheckpoint / _undoLast
   - 以临时目录模拟 FileStore，避免启动整个服务
   - 覆盖：编辑回滚、新建文件撤销(删除)、删除文件撤销(重建)、多文件补丁回滚、空栈 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

let ok = true;
function assert(cond, msg) {
  if (!cond) { ok = false; console.error("  ✗ " + msg); }
  else console.log("  ✓ " + msg);
}

let LlmAgent;
try {
  ({ LlmAgent } = require("../server/agent-llm"));
} catch (e) {
  console.error("无法加载 agent-llm.js：", e.message);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "undo-"));
const join = (p) => path.join(tmp, p);
const files = {
  dir: tmp,
  exists: (p) => fs.existsSync(join(p)),
  read: (p) => fs.readFileSync(join(p), "utf8"),
  write: (p, c) => { fs.mkdirSync(path.dirname(join(p)), { recursive: true }); fs.writeFileSync(join(p), c, "utf8"); },
  remove: (p) => { fs.rmSync(join(p), { force: true }); },
};
const agent = Object.create(LlmAgent.prototype);
agent._undoStack = [];
agent.files = files;
agent.fileChanged = () => {};
agent.emit = () => {};
agent.pushChanges = () => {};

// 工具 case 的等价操作：先压检查点再改盘
function opWrite(p, content) {
  agent._pushCheckpoint([agent._snapshotBefore(p)], "写入 " + p);
  files.write(p, content);
}
function opRemove(p) {
  agent._pushCheckpoint([agent._snapshotBefore(p)], "删除 " + p);
  files.remove(p);
}

console.log("[1] 编辑回滚");
files.write("b.txt", "orig");
opWrite("b.txt", "changed");
assert(files.read("b.txt") === "changed", "编辑后内容=changed");
let r = agent._undoLast();
assert(r.ok && r.restored.includes("b.txt"), "undo 恢复 b.txt");
assert(files.read("b.txt") === "orig", "回滚后内容恢复为 orig");

console.log("[2] 新建文件撤销=删除");
opWrite("c.txt", "new");
assert(files.exists("c.txt"), "c.txt 已创建");
r = agent._undoLast();
assert(r.ok, "undo 成功");
assert(!files.exists("c.txt"), "撤销后 c.txt 被删除（回到新建前）");

console.log("[3] 删除文件撤销=重建");
files.write("a.txt", "aaa");
opRemove("a.txt");
assert(!files.exists("a.txt"), "a.txt 已删除");
r = agent._undoLast();
assert(r.ok && r.restored.includes("a.txt"), "undo 重建 a.txt");
assert(files.exists("a.txt") && files.read("a.txt") === "aaa", "重建内容=aaa");

console.log("[4] 多文件补丁回滚");
files.write("x.txt", "x0");
files.write("y.txt", "y0");
agent._pushCheckpoint([agent._snapshotBefore("x.txt"), agent._snapshotBefore("y.txt")], "应用补丁 2 文件");
files.write("x.txt", "x1");
files.write("y.txt", "y1");
assert(files.read("x.txt") === "x1" && files.read("y.txt") === "y1", "补丁已应用");
r = agent._undoLast();
assert(r.ok && r.restored.length === 2, "undo 恢复 2 个文件");
assert(files.read("x.txt") === "x0" && files.read("y.txt") === "y0", "两个文件均回滚");

console.log("[5] 空栈");
r = agent._undoLast();
assert(!r.ok && r.reason === "empty", "无检查点时返回 empty");

console.log("[6] 连续单步回滚顺序（LIFO）");
files.write("s.txt", "v1");
opWrite("s.txt", "v2");          // 检查点 A
opWrite("s.txt", "v3");          // 检查点 B
assert(files.read("s.txt") === "v3", "当前 v3");
agent._undoLast();               // 撤销 B -> v2
assert(files.read("s.txt") === "v2", "撤销 B 后 v2");
agent._undoLast();               // 撤销 A -> v1
assert(files.read("s.txt") === "v1", "再撤销 A 后 v1");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(ok ? "\nUNDO CHECKPOINT OK=true" : "\nUNDO CHECKPOINT OK=false");
process.exit(ok ? 0 : 1);
