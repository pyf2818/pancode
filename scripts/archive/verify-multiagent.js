/* 验证 ⑩ 多智能体编排（agent 工具 / runSubAgent）
   - 用真实 LlmAgent.prototype.runSubAgent，但注入假 _chatStream（无需真实 LLM）
   - 覆盖：子智能体执行工具并返回结果、工具白名单排除 agent/plan/undo、轮数上限收敛 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

let ok = true;
function assert(cond, msg) {
  if (!cond) { ok = false; console.error("  ✗ " + msg); }
  else console.log("  ✓ " + msg);
}

async function main() {
  let LlmAgent;
  try { ({ LlmAgent } = require("../../server/agent-llm")); }
  catch (e) { console.error("无法加载 agent-llm.js：", e.message); process.exit(1); }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sub-"));
  const join = (p) => path.join(tmp, p);
  const files = {
    dir: tmp,
    exists: (p) => fs.existsSync(join(p)),
    read: (p) => fs.readFileSync(join(p), "utf8"),
    write: (p, c) => { fs.mkdirSync(path.dirname(join(p)), { recursive: true }); fs.writeFileSync(join(p), c, "utf8"); },
    remove: (p) => { fs.rmSync(join(p), { force: true }); },
  };
  files.write("x.txt", "hello-subagent");

  function makeAgent() {
    const a = Object.create(LlmAgent.prototype);
    a._undoStack = [];
    a.cfg = { planMode: false, permissions: { mode: "auto" } };
    a.files = files;
    a.fileChanged = () => {};
    a.emit = () => {};
    a.pushChanges = () => {};
    return a;
  }

  console.log("[1] 子智能体执行工具并返回结果");
  {
    const a = makeAgent();
    let calls = 0;
    const captured = [];
    a._chatStream = async (messages, tools) => {
      captured.push(tools.map((t) => t.function.name));
      calls++;
      if (calls === 1) return { content: "", toolCalls: [{ id: "t1", name: "read_file", args: { path: "x.txt" } }] };
      return { content: "子智能体汇报：已读取 x.txt 内容为 hello-subagent", toolCalls: [] };
    };
    const out = await a.runSubAgent("读取 x.txt 并汇报");
    assert(calls === 2, "两轮结束（一次工具 + 一次收尾）");
    assert(/hello-subagent/.test(out), "子智能体返回包含读取到的内容");
    assert(out.includes("汇报"), "返回为收尾汇报文本");
    const blocked = captured[0].filter((n) => ["agent", "create_plan", "update_plan", "undo"].includes(n));
    assert(blocked.length === 0, "子智能体工具集排除了 agent/plan/undo（白名单生效）");
  }

  console.log("[2] 轮数上限收敛（防止失控循环）");
  {
    const a = makeAgent();
    let calls = 0;
    a._chatStream = async () => { calls++; return { content: "", toolCalls: [{ id: "x", name: "read_file", args: { path: "x.txt" } }] }; };
    const out = await a.runSubAgent("无限循环", { maxRounds: 5 });
    assert(calls === 5, "严格按 maxRounds=5 收敛，未死循环");
    assert(typeof out === "string", "正常返回字符串");
  }

  console.log("[3] 子智能体真实写盘（改动落到父工作区）");
  {
    const a = makeAgent();
    let calls = 0;
    a._chatStream = async () => {
      calls++;
      if (calls === 1) return { content: "", toolCalls: [{ id: "w1", name: "write_file", args: { path: "sub_out.txt", content: "written-by-sub" } }] };
      return { content: "已创建 sub_out.txt", toolCalls: [] };
    };
    await a.runSubAgent("创建 sub_out.txt");
    assert(files.exists("sub_out.txt") && files.read("sub_out.txt") === "written-by-sub", "子智能体的写操作落到工作区");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(ok ? "\nMULTI-AGENT OK=true" : "\nMULTI-AGENT OK=false");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
