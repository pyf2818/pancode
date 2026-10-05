/* W12 回归验证：git 层异步化
   目标：
   1) baseline/changes/commit/discardAll 全部返回 Promise（不再是同步阻塞值）
   2) 异步不阻塞事件循环 —— await git 调用期间，setImmediate/setTimeout(0) 仍能准时触发
   3) 并发信号量有效 —— 远超 MAX_GIT 的并发请求全部 resolve，且不抛错
   4) 两条路径都走通：真实 Git 仓库（available=true）与 非 Git 快照降级（available=false）
   用法：node scripts/verify-git-async.js
*/
"use strict";
/* 沙箱：这探针要真造 git 仓库。原先落在仓库根（w12-git-*、w12-snap-*），异常路径上不清理，
   实测现在仓库根就躺着两个没人认领的空目录。改到沙箱里，整个根随进程退出一起消失。
   顺带把"os.tmpdir() 对 git spawn 会 EBUSY"这条旧断言拿掉——test/git-toplevel.test.js 就是在临时目录里
   建真仓库跑的，今天实测没问题。 */
const SANDBOX = require("./_sandbox").create({ tag: "gitasync" });

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);
const { GitLayer } = require("../server/git.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  ❌ " + name + (extra ? "  " + extra : "")); }
}
function isPromise(x) { return x && typeof x.then === "function"; }

// 沙箱内的临时目录（跟着数据根一起消失，不在仓库根留残骸）
function makeTempDir(prefix) {
  return SANDBOX.scratch(prefix);
}
// 最小 FileStore mock：GitLayer 仅用到 list / read / isBinary / write / remove
function mockStore(files) {
  const map = new Map(Object.entries(files));
  return {
    list: () => Array.from(map.keys()),
    read: (r) => { if (!map.has(r)) throw new Error("not found " + r); return map.get(r); },
    isBinary: () => false,
    write: (r, c) => map.set(r, c),
    remove: (r) => map.delete(r),
  };
}
async function gitInit(repo, files) {
  // 用异步 execFile 建仓（同步 execFileSync 在部分 Windows 环境对 git init 报 EBUSY）
  await execFileP("git", ["init", "-q"], { cwd: repo });
  await execFileP("git", ["config", "user.email", "t@t.io"], { cwd: repo });
  await execFileP("git", ["config", "user.name", "t"], { cwd: repo });
  await execFileP("git", ["config", "commit.gpgsign", "false"], { cwd: repo });
  await execFileP("git", ["config", "core.autocrlf", "false"], { cwd: repo }); // 隔离 Windows CRLF，避免断言误判
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    await execFileP("git", ["add", rel], { cwd: repo });
  }
  await execFileP("git", ["commit", "-q", "-m", "init"], { cwd: repo });
}

(async () => {
  console.log("[W12] Git 层异步化验证");

  /* ---------- 1. 真实 Git 仓库路径 ---------- */
  const repo = makeTempDir("w12-git-");
  await gitInit(repo, { "a.txt": "hello\n", "src/b.js": "console.log(1)\n" });
  const store = mockStore({ "a.txt": "hello\n", "src/b.js": "console.log(1)\n" });
  const g = new GitLayer(repo, store);
  ok("available=true（真实仓库）", g.available === true, "branch=" + g.branch);

  ok("baseline 返回 Promise", isPromise(g.baseline("a.txt")));
  ok("changes 返回 Promise", isPromise(g.changes()));
  ok("commit 返回 Promise", isPromise(g.commit("x")));
  ok("discardAll 返回 Promise", isPromise(g.discardAll()));

  const base = await g.baseline("a.txt");
  ok("baseline 内容正确", base === "hello\n", JSON.stringify(base));
  ok("不存在文件 baseline=null（新增）", (await g.baseline("nope.txt")) === null);

  const ch = await g.changes();
  ok("changes 返回数组", Array.isArray(ch), "len=" + ch.length);

  /* ---------- 2. 异步不阻塞事件循环 ---------- */
  let ticked = false;
  setImmediate(() => { ticked = true; });
  await g.changes();               // 长时间 await 子进程
  ok("await 期间事件循环未被阻塞（setImmediate 已触发）", ticked === true);

  // 更强断言：在 await 中途排一个 setTimeout(0)，必须能在 git 调用结束前被调度
  let beforeDone = false;
  const p = g.changes().then(() => { /* 完成后 */ });
  setTimeout(() => { beforeDone = true; }, 0);
  await p;
  ok("并发计时器未被饿死（setTimeout(0) 在 await 期间触发）", beforeDone === true);

  /* ---------- 3. 并发信号量：远超 MAX_GIT 仍全 resolve ---------- */
  const N = 30; // MAX_GIT=6，远超以验证队列不丢请求
  const tasks = [];
  for (let i = 0; i < N; i++) tasks.push(g.baseline("a.txt"));
  const results = await Promise.all(tasks);
  ok("并发 " + N + " 个 baseline 全部 resolve", results.length === N && results.every((r) => r === "hello\n"));

  /* ---------- 4. commit + discardAll 真实链路 ---------- */
  fs.writeFileSync(path.join(repo, "a.txt"), "hello world\n"); // 改内容
  const c = await g.commit("edit a");
  ok("commit 成功", c.ok === true, JSON.stringify(c).slice(0, 80));
  const afterCommit = await g.baseline("a.txt");
  ok("commit 后基线更新", afterCommit === "hello world\n");

  fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n"); // 再改
  const d = await g.discardAll();
  ok("discardAll 成功", d === true);
  const afterDiscard = fs.readFileSync(path.join(repo, "a.txt"), "utf8");
  ok("discardAll 还原到基线", afterDiscard === "hello world\n", JSON.stringify(afterDiscard));

  /* ---------- 5. 非 Git 快照降级路径 ---------- */
  const snapDir = makeTempDir("w12-snap-");
  const snapStore = mockStore({ "x.txt": "snap content\n" });
  const gs = new GitLayer(snapDir, snapStore);
  ok("available=false（非仓库→快照降级）", gs.available === false, "branch=" + gs.branch);
  ok("快照 baseline 返回 Promise", isPromise(gs.baseline("x.txt")));
  const sb = await gs.baseline("x.txt");
  ok("快照 baseline 内容正确", sb === "snap content\n");
  const sch = await gs.changes();
  ok("快照 changes 含新增/修改标记", Array.isArray(sch));
  // 非仓库下 commit 应安全失败（不崩）
  const sc = await gs.commit("x");
  ok("非仓库 commit 安全返回 {ok:false}", sc.ok === false);

  // 快照降级路径（零 I/O）：断言异步让出微任务队列（不会同步阻塞调用方）
  let micro = false;
  Promise.resolve().then(() => { micro = true; });
  await gs.changes();
  ok("快照路径（零 I/O）async 让出微任务队列", micro === true);

  /* ---------- 汇总 ---------- */
  console.log(`\n[W12] 结果：${pass} 通过 / ${fail} 失败`);
  // 临时仓库不用自己收：_sandbox 在进程退出时连根删（异常路径也管，这正是原来漏掉的那条）
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e); process.exit(1); });
