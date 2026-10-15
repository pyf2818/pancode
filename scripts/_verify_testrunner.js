/* ============================================================
   P1-B3 回归：run_tests 端到端（检测 → 收窄 → 真跑 → 结构化回执）
   为什么必须真跑：解析层的形状问题（vitest 的前导空格、node --test 走管道时其实是 spec
   而不是 TAP）在读代码时全都看不出来 —— 单元测试用的夹具本身就是从这里这种真跑抓出来的，
   本探针再补一段"通过 / 失败 / 改好之后复跑"的真实闭环，防止 handler 与解析层脱节。

   沙箱：全程在 _sandbox 的临时目录里造被测项目，绝不在仓库根跑 npm test
   （那会自指：探针触发回归链 → 回归链跑探针）。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "testrun" });

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);

const TR = require("../server/test-runner");
const { TOOL_HANDLERS } = require("../server/tools/index.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  ❌ " + name + (extra ? "  " + extra : "")); }
}

/* 假 agent：files / term / _gate 是三处真实依赖，其余是 handler 会碰到的空壳。
   term.run 真的起进程（cmd /c，cwd 对被测目录），返回形状与 TerminalLayer 一致。 */
function mkAgent(dir) {
  const a = {
    dir, gates: [], approve: true, cmds: [],
    files: { dir, read: (rel) => { try { return fs.readFileSync(path.join(dir, rel), "utf8"); } catch (e) { return null; } } },
    term: {
      run: async (tab, command) => {
        a.cmds.push(command);
        const com = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
        const argz = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
        try {
          const r = await execFileP(com, argz, { cwd: dir, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 90000, windowsHide: true });
          return { code: 0, out: String(r.stdout || "") + String(r.stderr || ""), blocked: false, timedOut: false };
        } catch (e) {
          if (e.code === undefined && !e.stdout && !e.stderr) return { code: -1, out: String(e.message), blocked: false, timedOut: true };
          return { code: typeof e.code === "number" ? e.code : 1, out: String(e.stdout || "") + String(e.stderr || "") + String(e.message || ""), blocked: false, timedOut: false };
        }
      },
    },
    async _gate(name, args, danger) { a.gates.push({ name, args, danger }); return a.approve ? { blocked: false, approved: true } : { blocked: false, approved: false }; },
    tool() { const c = { body: "", done: null, sum: "" }; a.last = c; return { body(t) { c.body = String(t || ""); }, done(d, s) { c.done = d; c.sum = String(s || ""); } }; },
    state() {},
    pushChanges() { return []; },
    emit() {},
  };
  return a;
}

const write = (dir, rel, content) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
};

const PASS_TEST = 'const { test } = require("node:test");\nconst assert = require("node:assert");\ntest("加法没问题", () => { assert.strictEqual(1 + 1, 2); });\n';
const FAIL_TEST = 'const { test } = require("node:test");\nconst assert = require("node:assert");\ntest("减法算错了", () => {\n  assert.strictEqual(5 - 3, 1);\n});\n';
const FIXED_TEST = 'const { test } = require("node:test");\nconst assert = require("node:assert");\ntest("减法算错了", () => {\n  assert.strictEqual(5 - 3, 2);\n});\n';

(async () => {
  console.log("[P1-B3] run_tests 端到端验证");
  ok("工具已注册进分发表（漏这一步就是模型能看见但一调就报未知工具）", typeof TOOL_HANDLERS.run_tests === "function");

  /* ---------- 1. 有失败用例：拿得到 file:line，且坐标是工作区相对的 ---------- */
  const ws = SANDBOX.scratch("ws");
  write(ws, "package.json", JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }, null, 2));
  write(ws, "test/add.test.js", PASS_TEST);
  write(ws, "test/sub.test.js", FAIL_TEST);
  const a = mkAgent(ws);
  const r1 = await TOOL_HANDLERS.run_tests(a, {});
  ok("检测到 node --test 并如实报未通过", /【测试未通过】/.test(r1) && /node --test/.test(r1), r1.split("\n")[0]);
  ok("报出失败个数与用例名", /1 个失败/.test(r1) && /减法算错了/.test(r1));
  const loc = /(\d+)\)\s+(\S+?):(\d+)/.exec(r1);
  ok("给出可定位的 file:line", !!loc && loc[2] === "test/sub.test.js" && loc[3] === "3", loc && loc[2] + ":" + loc[3]);
  ok("关键：位置是工作区相对坐标（绝对路径点不动）", !loc || !/^[A-Za-z]:\//.test(loc[2].replace(/\\/g, "/")) && !loc[2].startsWith("/"));
  ok("跑测试也要过闸门", a.gates.length === 1 && a.gates[0].name === "run_tests");
  ok("卡片摘要与回执同一结论", a.last.done === false && /1 个失败/.test(a.last.sum), a.last.sum);

  /* ---------- 2. 修好之后复跑：同一个工具给出通过 ---------- */
  write(ws, "test/sub.test.js", FIXED_TEST);
  const r2 = await TOOL_HANDLERS.run_tests(a, {});
  ok("改对了就说通过（不许因为缓存/解析而含糊）", /【测试通过】/.test(r2) && /3 个用例通过|2 个用例通过/.test(r2), r2.split("\n")[0]);

  /* ---------- 3. 收窄：只跑通过的那个文件，范围真的变小了 ---------- */
  write(ws, "test/sub.test.js", FAIL_TEST);
  const r3 = await TOOL_HANDLERS.run_tests(a, { files: ["test/add.test.js"] });
  ok("files 收窄后只跑了通过的那个（不是整串跑）", /【测试通过】/.test(r3) && /1 个用例通过/.test(r3), r3.split("\n")[0]);
  ok("收窄命令带上了文件名", a.cmds[a.cmds.length - 1].includes("test/add.test.js"), a.cmds[a.cmds.length - 1]);
  const r3b = await TOOL_HANDLERS.run_tests(a, { files: ["../etc/passwd", "test/add.test.js"] });
  ok("不合规则的路径被丢掉并说明，仍照跑合规的那个", /已被忽略/.test(r3b) && /【测试通过】/.test(r3b), r3b.slice(0, 44));

  /* ---------- 4. 用户拒绝 = 一个字都不执行 ---------- */
  const marker = path.join(ws, "ran-marker.txt");
  const a2 = mkAgent(ws);
  a2.approve = false;
  const denied = await TOOL_HANDLERS.run_tests(a2, { command: "echo hi > ran-marker.txt" });
  ok("拒绝后回执写明未执行", /拒绝了这次 run_tests/.test(denied), denied.slice(0, 50));
  ok("关键：进程真的没起（标记文件不存在）", !fs.existsSync(marker));
  a2.approve = true;
  await TOOL_HANDLERS.run_tests(a2, { command: "echo hi > ran-marker.txt" });
  ok("正向对照：同样这条命令批准后确实跑了", fs.existsSync(marker));

  /* ---------- 5. 没有可认的测试命令：报菜单而不是空转 ---------- */
  /* ⚠ 夹具一律写 "node --test"（自动发现），不写 "node --test test/"：
     Node 24 把目录参数当成一个文件去 require，直接 "Cannot find module" 退出 1，
     于是被测项目里的测试一个都没跑，而 run_tests 只能如实报"未通过"。
     这不是工具的错，是脚本写法本身在 CI 里也一样挂 —— 探针要验的是工具，不是这个坑。 */
  const bare = SANDBOX.scratch("bare");
  write(bare, "package.json", JSON.stringify({ name: "x", scripts: { start: "node server.js", "test:unit": "node --test" } }, null, 2));
  write(bare, "test/one.test.js", PASS_TEST);
  const a3 = mkAgent(bare);
  const r5 = await TOOL_HANDLERS.run_tests(a3, {});
  ok("没有 scripts.test 时用第一个 test* 脚本", /【测试通过】/.test(r5), r5.split("\n")[0]);
  const r5b = await TOOL_HANDLERS.run_tests(a3, { script: "test:nope" });
  ok("script 选错时把可选键报出来", /跑不了测试/.test(r5b) && /test:unit/.test(r5b), r5b.split("\n").slice(0, 2).join(" | "));
  const a4 = mkAgent(SANDBOX.scratch("empty"));
  const r5c = await TOOL_HANDLERS.run_tests(a4, {});
  ok("没有 package.json 时指向 run_command（而不是谎报通过）", /没有 package.json/.test(r5c) && a4.gates.length === 0, r5c.slice(0, 40));

  /* ---------- 6. 退出码是唯一裁判：输出自称全绿但退出码非 0 ---------- */
  const liar = SANDBOX.scratch("liar");
  write(liar, "package.json", JSON.stringify({ scripts: { test: 'node -e "console.log(\'Tests  0 failed | 9 passed (9)\');process.exit(1)"' } }, null, 2));
  const a5 = mkAgent(liar);
  const r6 = await TOOL_HANDLERS.run_tests(a5, {});
  ok("关键：输出里写着 0 failed 但退出码 1 → 仍报未通过", /【测试未通过】/.test(r6), r6.split("\n")[0]);

  /* ---------- 7. && 链脚本：不许把文件拼到最后一段后面 ---------- */
  const chained = SANDBOX.scratch("chained");
  write(chained, "package.json", JSON.stringify({ scripts: { test: "node --test && echo done" } }, null, 2));
  write(chained, "test/one.test.js", PASS_TEST);
  const a6 = mkAgent(chained);
  const r7 = await TOOL_HANDLERS.run_tests(a6, { files: ["test/one.test.js"] });
  const cmd7 = a6.cmds[a6.cmds.length - 1];
  ok("链式脚本整串跑（不追加文件），并在回执里说明原因", /整串跑/.test(r7) && cmd7 === "node --test && echo done", cmd7);
  ok("链式脚本仍能判出通过与否", /【测试通过】/.test(r7), r7.split("\n")[0]);

  /* ---------- 8. 解析层与 handler 同源（同一份框架表） ---------- */
  ok("detect 能认出四种框架 + generic", ["vitest", "jest", "node-test", "pytest", "generic"].every((k) => k === "generic" || TR.FRAMEWORKS[k]), Object.keys(TR.FRAMEWORKS).join(","));

  console.log("\n[P1-B3] 结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e && e.stack || e); process.exit(1); });
