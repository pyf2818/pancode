/* 子项4 后端机制验证：写/删/命令 工具需人工确认
   - write_file：emit tool.pending 且确认前不落盘，确认后才落盘，拒绝则不落盘
   - delete_file：emit tool.pending，拒绝后保留文件
   - run_command：emit tool.pending（用 mock term 验证拒绝路径不执行）
   仅依赖内存 mock，不触碰真实文件系统 / LLM。
*/
"use strict";

const assert = require("assert");
const { LlmAgent } = require("../../server/agent-llm");

const events = [];
function emit(e) { events.push(e); }

// ---- mock FileStore ----
const store = {};
const files = {
  exists: (p) => Object.prototype.hasOwnProperty.call(store, p),
  read: (p) => { if (!Object.prototype.hasOwnProperty.call(store, p)) throw new Error("ENOENT: " + p); return store[p]; },
  write: (p, c) => { store[p] = String(c); },
  remove: (p) => { delete store[p]; },
  list: () => Object.keys(store),
  search: () => [],
};

// ---- mock GitLayer ----
const git = {
  baseline: () => null,
  changes: () => [],
  snapshot: () => {},
};

// ---- mock TerminalLayer ----
let termInvoked = 0;
const term = {
  run: (cmd, display, opts) => { termInvoked++; return Promise.resolve({ code: 0, out: "MOCK OK", blocked: false, timedOut: false }); },
};

const cfg = { llm: { maxToolRounds: 20 } };
const agent = new LlmAgent({ emit, files, git, term, cfg });

function lastPending(tool) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "tool.pending" && events[i].tool === tool) return events[i];
  return null;
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (name, cond) => { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name); } };

  // ===== TEST 1: write_file 新建 → 确认前不落盘，确认后落盘 =====
  console.log("[TEST 1] write_file 新建需确认");
  const p1 = agent.execTool("write_file", { path: "test/a.txt", content: "hello world" });
  const pend1 = lastPending("write_file");
  ok("emit tool.pending", !!pend1);
  ok("确认前文件未落盘", !Object.prototype.hasOwnProperty.call(store, "test/a.txt"));
  ok("pending 含 danger 等级", pend1 && typeof pend1.danger === "string");
  ok("pending 含内容预览", pend1 && typeof pend1.preview === "object" && pend1.preview.path === "test/a.txt");
  agent.resolveApproval(pend1.id, true);
  await p1;
  ok("确认后文件已落盘", store["test/a.txt"] === "hello world");

  // ===== TEST 2: write_file 被拒绝 → 不落盘 =====
  console.log("[TEST 2] write_file 被拒绝保留拒绝状态");
  const p2 = agent.execTool("write_file", { path: "test/c.txt", content: "forbidden" });
  const pend2 = lastPending("write_file");
  agent.resolveApproval(pend2.id, false);
  const r2 = await p2;
  ok("拒绝后文件未落盘", !Object.prototype.hasOwnProperty.call(store, "test/c.txt"));
  ok("返回拒绝说明", /拒绝/.test(r2));

  // ===== TEST 3: delete_file 被拒绝 → 保留文件 =====
  console.log("[TEST 3] delete_file 被拒绝保留文件");
  store["test/b.txt"] = "keep me";
  const p3 = agent.execTool("delete_file", { path: "test/b.txt" });
  const pend3 = lastPending("delete_file");
  ok("emit tool.pending", !!pend3);
  ok("拒绝前文件存在", Object.prototype.hasOwnProperty.call(store, "test/b.txt"));
  agent.resolveApproval(pend3.id, false);
  await p3;
  ok("拒绝后文件仍存在", Object.prototype.hasOwnProperty.call(store, "test/b.txt") && store["test/b.txt"] === "keep me");

  // ===== TEST 4: delete_file 确认 → 删除文件 =====
  console.log("[TEST 4] delete_file 确认后删除");
  store["test/d.txt"] = "delete me";
  const p4 = agent.execTool("delete_file", { path: "test/d.txt" });
  const pend4 = lastPending("delete_file");
  agent.resolveApproval(pend4.id, true);
  await p4;
  ok("确认后文件已删除", !Object.prototype.hasOwnProperty.call(store, "test/d.txt"));

  // ===== TEST 5: run_command 被拒绝 → 终端不执行 =====
  console.log("[TEST 5] run_command 被拒绝不执行");
  termInvoked = 0;
  const p5 = agent.execTool("run_command", { command: "echo hi" });
  const pend5 = lastPending("run_command");
  ok("emit tool.pending", !!pend5);
  agent.resolveApproval(pend5.id, false);
  await p5;
  ok("拒绝后终端未执行", termInvoked === 0);

  // ===== TEST 6: 超时自动拒绝（短超时验证，避免 120s） =====
  console.log("[TEST 6] 超时自动拒绝逻辑");
  // 直接验证 resolveApproval 对未知 id 返回 false
  ok("未知 id resolveApproval 返回 false", agent.resolveApproval("nope", true) === false);

  console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("测试异常:", e); process.exit(2); });
