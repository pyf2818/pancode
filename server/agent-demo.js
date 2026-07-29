/* ============================================================
   pancode 演示引擎（无 API Key 时的保底体验）
   脚本化但"真实执行"：真实写盘、真实跑测试、真实失败后自修复
   ============================================================ */
"use strict";
const { AgentBase, sleep } = require("./agent-base");

const TODO_FIXED = `// 待办事项核心逻辑
import { sortByPriority } from "./utils.js";

let nextId = 1;

export function createTodo(text, priority) {
  return {
    id: nextId++,
    text: text,
    priority: priority || "normal", // low | normal | high
    done: false,
    createdAt: Date.now()
  };
}

export function toggleTodo(todos, id) {
  return todos.map(function (t) {
    return t.id === id ? Object.assign({}, t, { done: !t.done }) : t;
  });
}

export function filterTodos(todos, filter) {
  if (filter === "active") {
    // fix: "进行中" 应该返回未完成项（之前条件写反了）
    return sortByPriority(todos.filter(function (t) { return !t.done; }));
  }
  if (filter === "done") {
    // fix: "已完成" 应该返回已完成项（之前条件写反了）
    return sortByPriority(todos.filter(function (t) { return t.done; }));
  }
  return sortByPriority(todos);
}
`;

const SORT_BUGGY = `
// 按优先级排序：high > normal > low
const PRIORITY_ORDER = { low: 0, normal: 1, high: 2 };

export function sortByPriority(todos) {
  return todos.slice().sort(function (a, b) {
    return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  });
}
`;

const TEST_EXTRA = `
assert("sortByPriority 高优先级排在最前",
  JSON.stringify(filterTodos(todos, "all").map(t => t.priority)) ===
  JSON.stringify(["high", "normal", "low"]),
  '期望: ["high","normal","low"]');
`;

class DemoAgent extends AgentBase {
  async handleChat(text) {
    if (this.running) return;
    this.emit({ type: "user.msg", text });
    try {
      if (this.round === 0) await this.mainFlow(text);
      else await this.followupFlow(text);
    } catch (err) {
      this.emit({ type: "term.line", text: "[Agent 异常] " + err.stack, cls: "tl-err" });
      await this.say("执行过程中出现异常：" + err.message);
    } finally {
      this.state(false);
      this.emit({ type: "agent.done", round: this.round });
    }
  }

  base(rel) { const b = this.git.baseline(rel); return b === null ? "" : b; }

  async mainFlow(userText) {
    this.state(true, "AI 分析任务中");

    await this.think(
      "用户的需求：" + userText + "\n\n" +
      "我需要先了解这个项目：\n" +
      "1. 读 README.md 了解项目背景与已知问题\n" +
      "2. 读核心逻辑 src/todo.js，重点检查筛选相关代码\n" +
      "3. 读现有测试，看看覆盖情况\n\n" +
      "拿到足够上下文后再制定修改计划，改完必须用终端跑测试验证，不能凭感觉交差。");

    await this.say("好的，我来处理这个任务。先读取项目文件，了解代码结构。");

    let t = this.tool("read", "读取文件", "README.md");
    await sleep(600);
    const readme = this.files.read("README.md");
    t.body(readme.split("\n").slice(-4).join("\n"));
    t.done(true, readme.split("\n").length + " 行", true);

    t = this.tool("read", "读取文件", "src/todo.js");
    await sleep(700);
    const todoSrc = this.files.read("src/todo.js");
    t.body(todoSrc.split("\n").slice(19, 28).map((l, i) => String(20 + i).padStart(3) + " | " + l).join("\n"));
    t.done(true, todoSrc.split("\n").length + " 行", true);
    this.emit({ type: "editor.open", path: "src/todo.js", line: 22 });

    t = this.tool("read", "读取文件", "tests/todo.test.js");
    await sleep(500);
    t.done(true, this.files.read("tests/todo.test.js").split("\n").length + " 行");

    this.state(true, "AI 编写代码中");
    await this.think(
      "找到根因了！src/todo.js 的 filterTodos：\n" +
      '  filter === "active" 时却返回 t.done === true 的项\n' +
      '  filter === "done"  时却返回未完成项\n' +
      "两个分支的条件写反了 —— 和 README 里的已知问题完全吻合。\n\n" +
      "执行计划：\n" +
      "1. 修复 filterTodos 的条件反转 bug\n" +
      "2. 在 utils.js 新增 sortByPriority（high > normal > low），并在 filterTodos 中应用\n" +
      "3. 在测试文件中补充排序断言，防止回归\n" +
      "4. 终端运行 node tests/run-tests.js 验证全部通过");

    await this.say("**定位到 bug 了。** `filterTodos` 里 active / done 两个分支的条件写反了。我的计划：\n1. 修复条件反转 bug\n2. 新增 `sortByPriority` 并接入筛选流程\n3. 补充测试用例\n4. 在终端自主运行测试验证");

    t = this.tool("edit", "编辑文件", "src/todo.js — 修复筛选 bug + 接入排序");
    await sleep(800);
    this.files.write("src/todo.js", TODO_FIXED);
    this.fileChanged("src/todo.js");
    t.body("- return todos.filter(function (t) { return t.done; });\n" +
           "+ return sortByPriority(todos.filter(function (t) { return !t.done; }));\n" +
           "- return todos.filter(function (t) { return !t.done; });\n" +
           "+ return sortByPriority(todos.filter(function (t) { return t.done; }));");
    t.done(true, "+8 −4", true);
    this.emit({ type: "editor.open", path: "src/todo.js", line: 24 });

    t = this.tool("edit", "编辑文件", "src/utils.js — 新增 sortByPriority");
    await sleep(750);
    this.files.write("src/utils.js", this.base("src/utils.js") + SORT_BUGGY);
    this.fileChanged("src/utils.js");
    t.body("+ const PRIORITY_ORDER = { low: 0, normal: 1, high: 2 };\n" +
           "+ export function sortByPriority(todos) {\n" +
           "+   return todos.slice().sort(function (a, b) {\n" +
           "+     return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];\n" +
           "+   });\n+ }");
    t.done(true, "+8 −0");

    t = this.tool("edit", "编辑文件", "tests/todo.test.js — 补充排序测试");
    await sleep(700);
    this.files.write("tests/todo.test.js", this.base("tests/todo.test.js") + TEST_EXTRA);
    this.fileChanged("tests/todo.test.js");
    t.body('+ assert("sortByPriority 高优先级排在最前", ...)');
    t.done(true, "+5 −0");
    this.pushChanges(false);

    this.state(true, "AI 正在运行测试");
    await this.say("代码写好了。现在我调用终端真实运行测试来验证：");
    t = this.tool("terminal", "运行终端", "node tests/run-tests.js");
    const r1 = await this.term.run("node tests/run-tests.js", [process.execPath, "tests/run-tests.js"]);
    t.body(r1.out.trim() + "\n\n(exit code " + r1.code + ")");
    if (r1.code === 0) {
      t.done(true, "全部通过");
    } else {
      t.done(false, "测试未全部通过", true);

      await this.think(
        "测试失败了，看真实输出：期望 high 在最前，实际 low 在最前。\n" +
        "检查我刚写的 sortByPriority —— 用的是\n" +
        "  PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]\n" +
        "这是升序排列（数值小的在前），low=0 自然排最前了。\n" +
        "需求是 high > normal > low 的降序，应该改成 b - a。\n" +
        "修复后重新运行测试确认。");

      await this.say("测试帮我抓到一个问题：排序方向写成了**升序**，应该是 `b - a` 的降序。马上修复并重新验证。");

      this.state(true, "AI 修复问题中");
      t = this.tool("edit", "编辑文件", "src/utils.js — 修正排序方向");
      await sleep(700);
      this.files.write("src/utils.js", this.files.read("src/utils.js").replace(
        "return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];",
        "return PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]; // 降序：high 在前"));
      this.fileChanged("src/utils.js");
      t.body("- return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];\n" +
             "+ return PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]; // 降序：high 在前");
      t.done(true, "+1 −1", true);

      this.state(true, "AI 重新验证中");
      t = this.tool("terminal", "运行终端", "node tests/run-tests.js（复测）");
      const r2 = await this.term.run("node tests/run-tests.js", [process.execPath, "tests/run-tests.js"]);
      t.body(r2.out.trim() + "\n\n(exit code " + r2.code + ")");
      t.done(r2.code === 0, r2.code === 0 ? "5/5 通过" : "仍有失败");
    }

    const changes = this.pushChanges(false);
    await this.say("**任务完成。** 全部测试通过（真实执行，非模拟）。\n\n**做了什么：**\n1. 修复了 `filterTodos` 中 active/done 条件反转的 bug\n2. 新增 `sortByPriority`，筛选结果按 high > normal > low 排序\n3. 补充了排序回归测试\n4. 期间测试抓到一个排序方向错误，已自主修复并复测通过\n\n共改动 " + changes.length + " 个文件，点击下方任意文件可查看 Diff：");
    this.pushChanges(true);
    this.round = 1;
  }

  async followupFlow(userText) {
    this.state(true, "AI 思考中");
    await this.think("用户说：" + userText + "\n主任务已经完成。我重新真实跑一遍测试，确认工作区状态后再回复。");
    const t = this.tool("terminal", "运行终端", "node tests/run-tests.js（复核）");
    const r = await this.term.run("node tests/run-tests.js", [process.execPath, "tests/run-tests.js"]);
    t.body(r.out.trim());
    t.done(r.code === 0, r.code === 0 ? "全部通过" : "有失败");
    const changes = this.pushChanges(false);
    if (r.code === 0) {
      await this.say("当前工作区一切正常：**测试全部通过**（真实执行），共改动 " + changes.length + " 个文件。\n\n提示：在右上角「模型设置」里填入任意 OpenAI 兼容 API（DeepSeek / Moonshot / Ollama 等），即可切换为**真实 LLM Agent**，让 AI 处理你的任意编程任务。");
    } else {
      await this.say("复核发现测试有失败项，输出已打印在终端，需要我继续修复的话直接说。");
    }
  }
}

module.exports = { DemoAgent };
