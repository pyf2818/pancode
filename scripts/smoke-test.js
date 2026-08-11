/* ============================================================
   端到端烟测：启动服务 → WebSocket 触发 Agent → 断言完整闭环
   运行：npm run smoke
   ============================================================ */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = 8790;
const root = path.join(__dirname, "..");
const WS = path.join(root, "workspace");

function log(s) { console.log("[smoke] " + s); }
function fail(s) { console.error("[smoke] FAIL: " + s); process.exit(1); }

/* workspace 被 .gitignore 忽略无法用 git 还原，故 smoke 自带 bug 态 fixture，
   启动服务前重建，保证每次从已知状态开始（确定性）。 */
function prepareFixture() {
  const files = {
    "package.json": JSON.stringify({ name: "demo", type: "module" }),
    "README.md": "# Todo App\n已知问题：filterTodos 的 active/done 分支条件反转",
    "src/todo.js": `// 待办事项核心逻辑
let nextId = 1;

export function createTodo(text, priority) {
  return { id: nextId++, text: text, priority: priority || "normal", done: false, createdAt: Date.now() };
}

export function toggleTodo(todos, id) {
  return todos.map(function (t) { return t.id === id ? Object.assign({}, t, { done: !t.done }) : t; });
}

export function filterTodos(todos, filter) {
  if (filter === "active") return todos.filter(function (t) { return t.done; });
  if (filter === "done") return todos.filter(function (t) { return !t.done; });
  return todos;
}
`,
    "src/utils.js": "// 工具函数基线",
    "tests/run-tests.js": `import { createTodo, toggleTodo, filterTodos } from "../src/todo.js";

function assert(cond, name, msg) {
  if (cond) console.log("  ✓ " + name);
  else { console.error("  ✗ " + name + (msg ? ": " + msg : "")); }
}

const todos = [createTodo("A", "low"), createTodo("B", "high"), createTodo("C", "normal")];

assert(filterTodos(todos, "active").length === 3, "active 筛选返回未完成项");
assert(filterTodos(todos, "done").length === 0, "done 筛选返回已完成项");
assert(filterTodos(todos, "all").length === 3, "all 返回全部");
`,
    "tests/todo.test.js": `import { createTodo, toggleTodo, filterTodos } from "../src/todo.js";

function assert(cond, name, msg) {
  if (cond) console.log("  ✓ " + name);
  else { console.error("  ✗ " + name + (msg ? ": " + msg : "")); }
}

const todos = [createTodo("A", "low"), createTodo("B", "high"), createTodo("C", "normal")];

assert(filterTodos(todos, "active").length === 3, "active 筛选返回未完成项");
assert(filterTodos(todos, "done").length === 0, "done 筛选返回已完成项");
`,
  };
  for (const rel of Object.keys(files)) {
    const p = path.join(WS, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, files[rel], "utf8");
  }
  // 清理沙箱残留（todo-app 等历史夹具）
  for (const dir of ["todo-app"]) {
    fs.rmSync(path.join(WS, dir), { recursive: true, force: true });
  }
  log("已重建 bug 态演示夹具（workspace/）");
}

(async () => {
  prepareFixture();
  log("启动测试服务 (AGENT_FAST=1, PORT=" + PORT + ") ...");
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), AGENT_FAST: "1", CURSORWEB_ENGINE: "demo",
      CURSORWEB_WORKSPACE: "workspace",   // 强制用自带演示夹具，不受用户打开的文件夹影响
    }),
  });
  server.stderr.on("data", (b) => process.stderr.write("[server] " + b));

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 10000);
    server.stdout.on("data", (b) => {
      if (String(b).includes("已启动")) { clearTimeout(timer); resolve(); }
    });
  }).catch((e) => fail(e.message));
  log("服务已启动");

  const WebSocket = require("ws");
  /* A2 升级后 WS 需 userToken（bootstrap token 已不再用于业务 WS） */
  const tokRes = await fetch("http://localhost:" + PORT + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "_smoke_" + Date.now(), password: "test1234" }),
  }).then((r) => r.json());
  const token = tokRes && tokRes.token;
  if (!token) fail("注册测试用户失败: " + JSON.stringify(tokRes));
  const ws = new WebSocket("ws://localhost:" + PORT + "?token=" + encodeURIComponent(token));

  /* demo 引擎语义：读 bug → 写修复 → 跑测试验证通过（不要求「首次执行失败」）。
     CURSORWEB_ENGINE=demo 下复现完整工具闭环：read → edit(修复/新建/补测试) → terminal(验证) */
  const seen = { toolEdit: 0, toolTerminalOk: false, changes: 0, done: false, testPassLine: false };

  ws.on("open", () => {
    log("WebSocket 已连接，发送重置 + 演示任务");
    ws.send(JSON.stringify({ type: "reset" }));
    setTimeout(() => ws.send(JSON.stringify({ type: "chat", text: "修复筛选 bug 并支持优先级排序，自己跑测试验证" })), 300);
  });

  ws.on("message", (raw) => {
    const ev = JSON.parse(raw.toString());
    if (ev.type === "tool.start" && ev.kind === "edit") seen.toolEdit++;
    if (ev.type === "tool.end" && ev.ok && /通过/.test(ev.label || "")) seen.toolTerminalOk = true;
    if (ev.type === "term.line" && (/0 失败/.test(ev.text) || /✓/.test(ev.text))) seen.testPassLine = true;
    if (ev.type === "changes") seen.changes = ev.list.length;
    if (ev.type === "agent.done") { seen.done = true; finish(); }
  });

  const timeout = setTimeout(() => fail("60 秒内未完成 Agent 闭环"), 60000);

  function finish() {
    clearTimeout(timeout);
    log("Agent 闭环完成，开始断言...");
    if (seen.toolEdit < 1) fail("未观察到编辑工具调用（Agent 应修复代码）");
    if (!seen.testPassLine) fail("未观察到测试输出（应含 ✓ 或 0 失败）");
    if (!seen.toolTerminalOk) fail("未观察到终端验证通过（tool.end label 含「通过」）");
    if (seen.changes < 1) fail("改动文件数 " + seen.changes + " < 1（Agent 应至少改动一个文件）");
    log("断言通过: 读代码 -> 修复/新增/补测试 -> 终端验证通过, 改动 " + seen.changes + " 个文件");
    ws.send(JSON.stringify({ type: "reset" }));
    setTimeout(() => {
      ws.close();
      server.kill();
      log("PASS: 端到端闭环验证成功, workspace 已还原");
      process.exit(0);
    }, 500);
  }
})();
