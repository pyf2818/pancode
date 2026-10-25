"use strict";
/* ============================================================
   演示引擎的示例项目种子（W26）
   ------------------------------------------------------------
   为什么存在：演示引擎的闭环剧本（agent-demo.js）读 README/src/tests、
   真实运行 tests/run-tests.js —— 空工作区上第一跑就是一串 ENOENT，
   观感是"演示坏了"（2026-10 评审实测踩中）。现在服务启动时若
   工作区为空且当前是演示引擎，自动铺这套示例项目。
   内容与 agent-demo 的叙事严格对齐：
     · README 备案了 filterTodos 条件写反 + 缺排序（剧本的"病灶"）
     · utils.js 故意没有 sortByPriority（剧本第一遍测试挂 1/5）
     · tests/run-tests.js 5 项断言与剧本的"5/5 通过"标签一致
   只在完全空的工作区铺：绝不覆盖用户已有文件。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const log = require("./logger");

const README = `# todo-mini 示例项目

一个极简待办管理模块，用来演示 pancode Agent 的完整闭环。

## 已知问题
- filterTodos 的筛选逻辑有 bug：传 done=true 时返回的却是未完成项（条件写反了）。
- 不支持按优先级排序。

## 结构
- src/todo.js —— 核心逻辑（增删改查、筛选）
- src/utils.js —— 通用工具函数
- tests/todo.test.js —— 测试
`;

const TODO_JS = `// 待办核心逻辑：演示项目的"病灶"文件
const todos = [];
let nextId = 1;

function addTodo(text, priority) {
  const item = { id: nextId++, text, priority: priority || 2, done: false, createdAt: Date.now() };
  todos.push(item);
  return item;
}

// 已知 bug：done 参数的条件写反了（README 已备案）
function filterTodos(done) {
  return todos.filter((t) => (done ? t.done === false : t.done === true));
}

function listTodos() { return todos.slice(); }

module.exports = { addTodo, filterTodos, listTodos };
`;

const UTILS_JS = `// 通用工具函数
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

module.exports = { clamp };
`;

const TODO_TEST = `const { addTodo, filterTodos } = require('../src/todo');
addTodo('买牛奶', 'high'); addTodo('写周报', 'low'); addTodo('交水电费', 'normal');
const undone = filterTodos(true);
console.log('filterTodos(true) 应返回全部未完成(3)，实得', undone.length);
if (undone.length !== 3) { console.error('FAIL filterTodos'); process.exit(1); }
console.log('PASS');
`;

const RUN_TESTS = `// 演示闭环的测试入口：真实进程运行，退出码即结果（5 项，与演示剧本的"5/5"对齐）
const fs = require('fs');
const path = require('path');
let failed = 0, total = 0;
function test(name, fn) { total++; try { fn(); console.log('  ✓', name); } catch (e) { failed++; console.error('  ✗', name, '—', e.message); } }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const todoSrc = read('src/todo.js');
test('filterTodos(done=true) 应筛出未完成项（条件未写反）', () => {
  assert(!/done\\s*\\?\\s*t\\.done\\s*===\\s*false\\s*:\\s*t\\.done\\s*===\\s*true/.test(todoSrc.replace(/\\s+/g, ' ')), '筛选条件仍是写反的');
});
const utilsSrc = read('src/utils.js');
test('utils.js 提供 sortByPriority', () => assert(/function\\s+sortByPriority/.test(utilsSrc), '未找到 sortByPriority'));
test('sortByPriority 高优先级排在最前（降序 b-a）', () => assert(/PRIORITY_ORDER\\[b\\.priority\\]\\s*-\\s*PRIORITY_ORDER\\[a\\.priority\\]/.test(utilsSrc), '排序方向是升序，high 会排最后'));
test('clamp 边界钳制可用', () => assert(/function\\s+clamp[\\s\\S]*Math\\.min\\([\\s\\S]*Math\\.max\\(/.test(utilsSrc), 'clamp 实现不完整'));
test('todo.test.js 覆盖排序用例', () => assert(/sortByPriority/.test(read('tests/todo.test.js')), '测试文件里没有排序用例'));

console.log(failed ? 'FAIL ' + failed + '/' + total : 'PASS ' + total + '/' + total);
process.exit(failed ? 1 : 0);
`;

const FILES = {
  "README.md": README,
  "src/todo.js": TODO_JS,
  "src/utils.js": UTILS_JS,
  "tests/todo.test.js": TODO_TEST,
  "tests/run-tests.js": RUN_TESTS,
};

/* 工作区是否为空（忽略 .pancode / 隐藏文件）。异常一律按"非空"处理——
   种子是体验兜底，绝不能因为判断失误覆盖用户文件。 */
function workspaceEmpty(wsDir) {
  try {
    return fs.readdirSync(wsDir).filter((n) => !n.startsWith(".")).length === 0;
  } catch (e) { return false; }
}

/* 演示引擎 + 空工作区 → 铺示例项目。任何失败只记日志不抛——种子不能变成启动故障点。 */
function seedDemoWorkspace(wsDir, isDemo) {
  try {
    if (!isDemo || !wsDir || !workspaceEmpty(wsDir)) return false;
    for (const [rel, content] of Object.entries(FILES)) {
      const abs = path.join(wsDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
    log.tag("workspace").info("空工作区 + 演示引擎：已铺示例项目（todo-mini），直接发任务即可体验完整闭环");
    return true;
  } catch (e) {
    log.tag("workspace").warn("示例项目铺设失败（不影响启动）：" + e.message);
    return false;
  }
}

module.exports = { seedDemoWorkspace, FILES };
