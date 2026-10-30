/* ============================================================
   F22 验收：真实模型评测要量到它声称的东西
   ————————————————————————————————————————————————————
   审查里点名的四条，逐条钉住（都是"看起来在测、其实没测到"的那类）：
     ① 子 Agent / apply-edit 不能只看最终文件内容 —— 必须断言那条工具真的被发起并成功收尾；
     ② 压缩场景必须先证明 context.compact 真的发生，再谈"压缩之后任务还在推进"；
     ③ 任一 agent.error 就提前 return，会把"报过错但恢复了"判死、也把"没走工具"放过 ——
        最终结果与中途失败要分开记；
     ④ 无 Key 时报"未测"，不能算进通过率（exit 0 只说明没把 CI 拖红）。
   外加：每次跑要留下一行机器可读的度量（TTFT / 端到端 / 工具数 / 中途错误 / 成本）。
   ①-③ 是源码级判据（评测脚本本身的逻辑口径），④ 与度量行是真跑一遍无 Key 分支量出来的。
   用法：node scripts/_verify_nightly_eval.js
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "scripts", "nightly-real-llm.js"), "utf8");

let pass = 0, fail = 0;
const fails = [];
const metrics = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
function measure(name, value, unit) { metrics.push({ name, value: String(value), unit }); console.log("  \x1b[36m◦\x1b[0m " + name + "：\x1b[1m" + value + "\x1b[0m " + unit); }
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 300); } catch (e) { return String(v).slice(0, 300); } };

section("① 工具路径要断言，不能只看盘上文件");
/* 事件流上要能取到"这一轮发起过哪些工具、各自成功没有"——
   只 assert 文件存在的话，主模型自己 write_file 也能让"子智能体场景"绿。 */
const hasFacts = /function facts\(/.test(SRC);
ok("有 facts() 这一层从事件流算出来的事实（不是每处现写 filter）", hasFacts, "");
ok("场景② 断言发起了 agent 工具", /toolNames\("agent"\)/.test(SRC), "");
ok("场景② 断言那次调用成功收尾", /toolOk\("agent"\)/.test(SRC), "");
ok("场景② 还断言文件不是主循环自己写的", /mainWrote/.test(SRC), "");
ok("场景③ 断言发起了 apply_edit（不只看盘上内容变了）", /toolNames\("apply_edit"\)/.test(SRC) && /toolOk\("apply_edit"\)/.test(SRC), "");
ok("场景① 断言越界副作用（提示只读就不许动文件）",
  /write_file"\).length === 0/.test(SRC) && /apply_edit"\).length === 0/.test(SRC), "");

section("② 压缩场景先证明压缩真发生过");
ok("facts 里能取到 compact 事件（context.compact / microcompact）",
  /compact:\s*evs\.filter\([\s\S]{0,120}context\.compact[\s\S]{0,60}microcompact/.test(SRC), "");
ok("场景④ 第一条判据就是「真的触发了上下文压缩」", /这一轮真的触发了上下文压缩/.test(SRC), "");

section("③ 中途失败与最终结果分开记");
/* 旧口径：events.some(e => e.type === "agent.error") 为真就 ok(...) 并 return ——
   一次可恢复的报错会把整个场景判死，同时"没有 agent.error"又被当成通过。 */
ok("旧的「任一 agent.error 即 return」已删除",
  !/const errored = events\.some\(\(e\) => e\.type === "agent\.error"\);/.test(SRC), "");
ok("收口判据看的是最后一个事件（fatalAtEnd），不是「有没有出现过错误」", /fatalAtEnd/.test(SRC), "");
ok("中途错误单独计数并打出来（midErrors）", /midErrors/.test(SRC) && /中途 agent\.error/.test(SRC), "");

section("④ 无 Key 与度量行（真跑一遍这一分支）");
const clean = {};
for (const k of ["PANCODE_NIGHTLY_BASE_URL", "PANCODE_NIGHTLY_KEY", "PANCODE_NIGHTLY_MODEL", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL", "PANCODE_NIGHTLY_DEMO"]) {
  if (process.env[k]) clean[k] = process.env[k];
}
const env = Object.assign({}, process.env);
for (const k of Object.keys(clean)) delete env[k];
const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "nightly-real-llm.js")], { cwd: ROOT, encoding: "utf8", env, timeout: 60000 });
const out = (r.stdout || "") + (r.stderr || "");
measure("无 Key 分支的退出码", r.status, "");
measure("无 Key 分支打了多少判据", /共 (\d+) 条/.exec(out) ? RegExp.$1 : "没打", "条");
ok("无 Key：exit 0（不把 CI 拖红）", r.status === 0, J({ status: r.status, out: out.slice(-200) }));
ok("无 Key：话要说成「未测」，不许出现「通过 / PASS」当结论",
  /未测/.test(out) && !/RESULT: PASS/.test(out), out.slice(-240));
ok("无 Key：机器可读的 0 条判据（通过率分母里不含它）", /共 0 条，红 0 条/.test(out), out.slice(-240));
ok("每次都留一行 METRIC（含 ttft / e2e / toolCalls / midErrors / cost）",
  /METRIC/.test(SRC) && ["ttftMs", "e2eMs", "toolCalls", "midErrors", "cost"].every((k) => SRC.includes(k)), "");
ok("度量落盘是可选的，且默认不写进工作树", /PANCODE_NIGHTLY_REPORT/.test(SRC), "");

console.log("\n\x1b[1m量到的数\x1b[0m");
for (const m of metrics) console.log("  " + m.name + " = " + m.value + " " + m.unit);
console.log("\n共 " + (pass + fail) + " 条，红 " + fail + " 条");
if (fail) { console.log("\n失败明细："); fails.forEach((f, i) => console.log("  " + (i + 1) + ". " + f)); }
process.exit(fail ? 1 : 0);
