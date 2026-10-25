/* ============================================================
   演示引擎的结果可信性（回归）
   没配 Key 时用户看到的第一屏就是它。它真实执行测试，所以：
   · 复测仍失败时绝不能说"任务完成 / 全部通过"
   · 改 utils.js 不能把已有的 clamp 抹掉（旧实现拿 git 基线当底稿，
     非 git 沙箱里基线是空串，整份文件被覆盖）
   · 重复跑不能把 sortByPriority 追加两遍
   ============================================================ */
process.env.AGENT_FAST = "1";       // agent-base 在 require 时读取，sleep 归零

const { DemoAgent } = require("../server/agent-demo");

function memStore(files) {
  const map = new Map(Object.entries(files));
  return {
    dir: "/ws/demo",
    exists: (p) => map.has(p),
    read: (p) => (map.has(p) ? map.get(p) : ""),
    write: (p, c) => { map.set(p, c); },
    remove: (p) => { map.delete(p); },
    _map: map,
  };
}

const BASE_FILES = () => ({
  "README.md": "# Todo\n已知问题：active/done 筛选条件反转。\n",
  "src/todo.js": [
    "// buggy version",
    "export function filterTodos(todos, filter) {",
    '  if (filter === "active") return todos.filter(function (t) { return t.done; });',
    '  if (filter === "done") return todos.filter(function (t) { return !t.done; });',
    "  return todos;",
    "}",
    "",
  ].join("\n"),
  "src/utils.js": [
    "export function clamp(n, lo, hi) {",
    "  return Math.max(lo, Math.min(hi, n));",
    "}",
    "",
  ].join("\n"),
  "tests/todo.test.js": [
    'const { filterTodos } = require("../src/todo.js");',
    'assert("clamp 边界钳制可用", clamp(9, 0, 5) === 5, "clamp 坏了");',
    "",
  ].join("\n"),
});

function makeAgent(runCodes) {
  const store = memStore(BASE_FILES());
  const said = [];
  const runs = [];
  const a = new DemoAgent({
    emit() {}, files: store, git: { baseline: async () => null }, term: null,
  });
  a.think = async () => {};
  a.say = async (text) => { said.push(text); };
  a.tool = () => ({ body() {}, done() {} });
  a.state = () => {};
  a.fileChanged = async () => {};
  a.pushChanges = () => ["src/todo.js", "src/utils.js", "tests/todo.test.js"];
  a.term = {
    run: async (...args) => {
      runs.push(args);
      const code = runCodes[Math.min(runs.length - 1, runCodes.length - 1)];
      return { code, out: code === 0 ? "5/5 passed" : "FAIL: 排序方向相反" };
    },
  };
  return { a, store, said, runs, last: () => said[said.length - 1] || "" };
}

afterAll(() => { delete process.env.AGENT_FAST; });

describe("复测失败时的最终结论", () => {
  it("两次都失败 → 明说还没完成，不出现「任务完成 / 全部通过」", async () => {
    const { a, last } = makeAgent([1, 1]);
    await a.mainFlow("修一下待办筛选");
    expect(last()).toContain("还没完成");
    expect(last()).toContain("exit code 1");
    expect(last()).not.toMatch(/任务完成|全部测试通过/);
  });

  it("第一次失败、复测通过 → 才可以说任务完成", async () => {
    const { a, last } = makeAgent([1, 0]);
    await a.mainFlow("修一下待办筛选");
    expect(last()).toContain("任务完成");
    expect(last()).toContain("全部测试通过");
  });

  it("第一次就通过 → 不再走「修排序方向」那一步（只跑一次测试）", async () => {
    const { a, runs, last } = makeAgent([0]);
    await a.mainFlow("修一下待办筛选");
    expect(runs).toHaveLength(1);
    expect(last()).toContain("任务完成");
  });
});

describe("改文件不许毁掉原有内容", () => {
  it("utils.js 里已有的 clamp 仍在（非 git 沙箱基线为空时也不能整份覆盖）", async () => {
    const { a, store } = makeAgent([0]);
    await a.mainFlow("修一下待办筛选");
    expect(store.read("src/utils.js")).toContain("export function clamp");
    expect(store.read("src/utils.js")).toContain("function sortByPriority");
  });

  it("tests/todo.test.js 里原有的断言仍在", async () => {
    const { a, store } = makeAgent([0]);
    await a.mainFlow("修一下待办筛选");
    expect(store.read("tests/todo.test.js")).toContain("clamp 边界钳制可用");
    expect(store.read("tests/todo.test.js")).toContain("sortByPriority 高优先级排在最前");
  });

  it("同一工作区跑第二遍不重复追加（sortByPriority / PRIORITY_ORDER 只声明一次）", async () => {
    const { a, store } = makeAgent([0]);
    await a.mainFlow("第一遍");
    await a.mainFlow("第二遍");
    const utils = store.read("src/utils.js");
    expect(utils.match(/function sortByPriority/g)).toHaveLength(1);
    expect(utils.match(/const PRIORITY_ORDER/g)).toHaveLength(1);
    expect(store.read("tests/todo.test.js").match(/sortByPriority 高优先级排在最前/g)).toHaveLength(1);
  });
});
