/* ============================================================
   外部改盘的增量同步（#36：fs.watch 触发的那一路）

   钉的是两件"错了不报错、只是慢慢烂掉"的事：
     ① 在别的编辑器/测试里改一个**既有文件**，服务端不该把整棵树（≤500 个文件）
        逐个 readFileSync 再整包广播出去 —— 七八小时任务里这是几十次起步，
        表现就是"越跑越卡"。判据用客户端能观察到的最强证据：那一条 fs.sync 里只有被改的那个路径。
     ② 新增/删除/改名必须仍走全量。前端的增量分支（app.js 的 syncFiles）只覆盖传入路径、
        不会删掉消失的文件，这里一旦错判成增量，界面上就留着一个点得开的幽灵文件，
        而且没有任何报错。
   所以这不是"越快越好"的探针，它两头都断：快的那头断增量，对的那头断全量。

   沙箱第一行：任何 server 模块 require 之前先 create()，否则数据根落到真实目录。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const wsFiles = { "README.md": "# 外部改盘探针用\n\n一些中文内容。\n" };
for (let i = 0; i < 40; i++) wsFiles["src/f" + String(i).padStart(2, "0") + ".js"] = "export const n" + i + " = " + i + ";\n";

const sb = require("./_sandbox").create({
  tag: "fswatch",
  wsFiles,
  config: {
    agentMode: "auto",
    llm: { baseURL: "", apiKey: "", model: "sandbox-model", contextWindow: 128000 },
    permissions: { mode: "auto", allow: [], deny: [] },
  },
});
const { spawn } = require("child_process");
const WebSocket = require("ws");

const PORT = 8843;
const ROOT = path.resolve(__dirname, "..");
const WS = sb.wsDir;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: sb.env({ PORT: String(PORT), AGENT_FAST: "1", CURSORWEB_ENGINE: "demo", NODE_NO_WARNINGS: "1" }),
  stdio: ["ignore", "pipe", "pipe"],
});
let childLog = "";
child.stdout.on("data", (d) => { childLog += d; });
child.stderr.on("data", (d) => { childLog += d; });

async function waitServer(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) return true; } catch (e) {}
    await wait(200);
  }
  return false;
}

(async () => {
  if (!await waitServer(25000)) { console.log(childLog.slice(-2000)); throw new Error("服务端没起来（端口 " + PORT + "）"); }

  const base = `http://127.0.0.1:${PORT}`;
  const authOpts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "fswatch_" + Date.now(), password: "test1234" }) };
  await fetch(base + "/api/auth/register", authOpts).catch(() => {});
  const token = await fetch(base + "/api/auth/login", authOpts).then((r) => r.json()).then((j) => j.token || "").catch(() => "");
  if (!token) throw new Error("沙箱注册/登录没拿到 token");

  const ws = new WebSocket("ws://localhost:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
  const evs = [];
  ws.on("message", (raw) => { try { evs.push(JSON.parse(raw.toString())); } catch (e) {} });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); setTimeout(() => rej(new Error("WS 连接超时")), 10000); });

  const hello = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) { const e = evs.find((x) => x.type === "hello"); if (e) return e; await wait(120); }
    return null;
  })();
  section("① 前提：这一路真的连上了，而且手里有一份全量");
  ok("收到 hello（没有它下面全是空转）", !!hello, childLog.slice(-400));
  const N = hello ? Object.keys(hello.files).length : 0;
  ok("hello 带的是全量 41 个文件（阳性对照：判\"只发 1 个\"之前先确认 41 个进得来）", N === 41, "实际 " + N + " 个");

  /* 每次外部改盘后取"下一条 fs.sync"，并把游标推进，避免同一条被两节重复计数 */
  let cursor = 0;
  async function nextSync(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 5000)) {
      for (let i = cursor; i < evs.length; i++) if (evs[i].type === "fs.sync") { cursor = i + 1; return evs[i]; }
      await wait(100);
    }
    return null;
  }
  const keysOf = (ev) => Object.keys((ev && ev.files) || {});
  const isFull = (ev) => !!ev && ev.incremental !== true;

  section("② 改一个既有文件的内容：只读它那一个");
  const NEW = "export const n7 = 777; // 外部改的\n";
  fs.writeFileSync(path.join(WS, "src", "f07.js"), NEW, "utf8");
  const s1 = await nextSync(6000);
  ok("收到 fs.sync", !!s1, "6s 内没有事件 · " + childLog.slice(-300));
  ok("这一条是增量（带 incremental）", !!s1 && s1.incremental === true, J(s1));
  ok("增量里只有被改的那一个路径 —— 没重读整棵树", !!s1 && keysOf(s1).length === 1 && keysOf(s1)[0] === "src/f07.js", "路径 " + keysOf(s1).join(","));
  ok("内容确实是盘上那份新的", !!s1 && s1.files["src/f07.js"] && s1.files["src/f07.js"].content === NEW, J(s1 && s1.files["src/f07.js"]));

  section("③ 新建 / 删除：必须回到全量（前端增量分支不删幽灵文件）");
  fs.writeFileSync(path.join(WS, "src", "brand-new.js"), "export const fresh = 1;\n", "utf8");
  const s2 = await nextSync(6000);
  ok("新建文件后收到 fs.sync", !!s2, childLog.slice(-300));
  ok("新建走的是全量", !!s2 && isFull(s2), J({ inc: s2 && s2.incremental, n: keysOf(s2).length }));
  ok("全量里看得见这个新文件", !!s2 && !!s2.files["src/brand-new.js"], "路径数 " + keysOf(s2).length);

  fs.unlinkSync(path.join(WS, "src", "brand-new.js"));
  const s3 = await nextSync(6000);
  ok("删除后收到 fs.sync 且是全量", !!s3 && isFull(s3), J({ inc: s3 && s3.incremental, n: keysOf(s3).length }));
  ok("全量里这个文件真的没了（幽灵文件就是这么防住的）", !!s3 && !s3.files["src/brand-new.js"], keysOf(s3).filter((p) => p.includes("brand")).join(","));

  section("④ 删完之后仍要恢复增量，而不是一路全量下去");
  fs.writeFileSync(path.join(WS, "src", "f21.js"), "export const n21 = 2121;\n", "utf8");
  const s4 = await nextSync(6000);
  ok("这一次又是增量", !!s4 && s4.incremental === true, J({ inc: s4 && s4.incremental, n: keysOf(s4).length }));
  ok("增量里只有 src/f21.js", !!s4 && keysOf(s4).length === 1 && keysOf(s4)[0] === "src/f21.js", keysOf(s4).join(","));

  section("⑤ 总账：整轮只在该全量的时候全量");
  const all = evs.filter((e) => e.type === "fs.sync");
  const fulls = all.filter(isFull);
  ok("新建那条全量读的是 42 个文件（41 + 新增那个）", !!s2 && keysOf(s2).length === 42, "实际 " + keysOf(s2).length);
  ok("删除那条全量读的是 41 个", !!s3 && keysOf(s3).length === 41, "实际 " + keysOf(s3).length);
  ok("全量恰好 2 次（只有新建与删除；两次内容改动都没走全量）", fulls.length === 2,
    "实际 " + fulls.length + " 次：" + all.map((e) => (isFull(e) ? "全" + keysOf(e).length : "增" + keysOf(e).length)).join(","));
  ok("事件条数在防抖能接受的范围内（4～6 条，多出来的是同一次写被拆成两拍）",
    all.length >= 4 && all.length <= 6, "实际 " + all.length + " 条");

  ws.close();
  child.kill();
  console.log("\n" + (fail ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m") + " — 通过 " + pass + " / 失败 " + fail);
  if (fail) for (const f of fails) console.log("  · " + f);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("VERIFY_FAIL", e && e.message ? e.stack : e);
  try { child.kill(); } catch (err) {}
  process.exit(1);
});

function J(v) { try { return JSON.stringify(v && { inc: v.incremental, keys: Object.keys(v.files || {}) }).slice(0, 200); } catch (e) { return String(v); } }
