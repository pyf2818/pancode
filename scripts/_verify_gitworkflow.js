/* ============================================================
   P1-B2 回归：Git 工作流工具（git_fetch / git_push / git_pull / git_stash / git_blame / git_reset + git_branch delete）

   为什么单独一个探针：这六个工具的承诺全是"撤不回来"那一类，而它们的正确性没法靠读代码确认——
   "默认只预演"这句话写在 handler 里，只有真的建一个远端、跑完之后再数远端有几个提交，
   才知道它到底推没推。所以本探针全部拿真仓库跑（沙箱内，进程退出连根删）。

   三条最值钱的断言：
     1) 不带 confirm 的 git_push 之后，裸远端的提交数仍是 0（预演不许有任何写副作用）；
     2) 带 confirm 的 git_push 一定经过 _gate 且 danger="high"（auto 档也要问人）；
     3) git_reset --hard 被拒时 _gate 一次都没调（拒绝发生在弹卡片之前，不闪一下确认框）。
   每条否定断言前都先跑一遍正向对照（git_status / 远端提交数），否则"没写"可能只是"没跑"。

   ⚠ git_branch 的 delete 动作是这个探针的另一个由头：修之前 handler 把任何非 list 动作
     一律送进 checkout()，于是"删分支"实际执行的是"切到那个分支"——断言里专门有一步验当前分支没被动过。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "gitflow" });

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileP = promisify(execFile);

const { GitLayer } = require("../server/git.js");
const gitTools = require("../server/tools/git-tools.js");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  ❌ " + name + (extra ? "  " + extra : "")); }
}

const G = (cwd, ...args) => execFileP("git", args, { cwd, encoding: "utf8", windowsHide: true })
  .then((r) => String(r.stdout))
  .catch((e) => { throw new Error("git " + args.join(" ") + " 失败: " + ((e.stderr || e.stdout || e.message || "").toString().trim().split("\n")[0])); });

async function remoteCount(dir) {
  try { return (await G(dir, "rev-list", "--count", "--all")).trim(); } catch (e) { return "ERR"; }
}
async function headSha(dir) { return (await G(dir, "rev-parse", "HEAD")).trim(); }
async function curBranch(dir) { return (await G(dir, "rev-parse", "--abbrev-ref", "HEAD")).trim(); }

/* 最小 FileStore：GitLayer 只在快照降级路径用它，这里仓库都是真 Git */
function mockStore(files) {
  const map = new Map(Object.entries(files));
  return { list: () => [...map.keys()], read: (r) => map.get(r), isBinary: () => false, write: (r, c) => map.set(r, c), remove: (r) => map.delete(r) };
}

/* 替身 agent：handler 只用到 git / tool / _gate / pushChanges 四样。
   gates 与 cards 是两个观测孔——前者验"该问的问了、不该问的没问"，后者验卡片摘要说的和返回给模型的一致。 */
function mkAgent(git) {
  const a = {
    git, cards: [], gates: [], approve: true,
    tool(kind, title, sub) {
      const c = { kind, title, sub: String(sub || ""), body: "", done: null, sum: "" };
      a.cards.push(c);
      return { body(t) { c.body = String(t || ""); }, done(done, sum) { c.done = done; c.sum = String(sum || ""); } };
    },
    async _gate(name, args, danger) {
      a.gates.push({ name, args, danger });
      if (!a.approve) { a.approve = true; return { blocked: false, approved: false }; }   // 一次性拒绝，随后自动恢复
      return { blocked: false, approved: true };
    },
    pushChanges() { return []; },
    emit() {},
  };
  a.gated = (name) => a.gates.filter((g) => g.name === name);
  a.lastCard = () => a.cards[a.cards.length - 1] || {};
  return a;
}

async function initRepo(dir, files) {
  await G(dir, "init", "-q");
  await G(dir, "symbolic-ref", "HEAD", "refs/heads/main");   // 不依赖各机器的 init.defaultBranch
  await G(dir, "config", "user.email", "t@t.io");
  await G(dir, "config", "user.name", "t");
  await G(dir, "config", "commit.gpgsign", "false");
  await G(dir, "config", "core.autocrlf", "false");          // 隔离 Windows CRLF，否则内容断言会误判
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    await G(dir, "add", rel);
  }
  await G(dir, "commit", "-q", "-m", "init");
}

(async () => {
  console.log("[P1-B2] Git 工作流工具验证（真仓库 + 真裸远端）");

  const work = SANDBOX.scratch("gw-work");
  const remote = SANDBOX.scratch("gw-remote");
  await initRepo(work, { "a.txt": "line1\nline2\nline3\n", "src/b.js": "console.log(1)\n" });
  await G(remote, "init", "-q", "--bare");
  /* 裸仓库的 HEAD 默认仍指 master（不随推送变），clone 过去会得到"没有分支的工作区"。
     这里把它掰到 main，让后面那个"从另一处推提交"的夹具真的能检出分支。 */
  await G(remote, "symbolic-ref", "HEAD", "refs/heads/main");

  const g = new GitLayer(work, mockStore({ "a.txt": "line1\nline2\nline3\n", "src/b.js": "console.log(1)\n" }));
  const a = mkAgent(g);
  ok("真实仓库 available=true", g.available === true, "branch=" + g.branch);

  const run = (name, args) => gitTools[name](a, args || {});

  /* ---------- 1. 没有远端时：说清"只能本地提交"，且一次确认都不弹 ---------- */
  const status = await run("git_status");
  ok("正向对照：git_status 认出仓库与分支", /Git · 分支 main/.test(status), status.split("\n")[0]);
  const gates0 = a.gates.length;
  ok("没有远端时 git_fetch 报「没有配置远端」", /fetch 失败/.test(await run("git_fetch", {})) && a.lastCard().done === false);
  ok("没有远端时 git_push 预演直接失败", /推送预演失败/.test(await run("git_push", {})));
  ok("只读与预演路径不弹确认（fetch/dry-run 共 0 次 gate）", a.gates.length === gates0, "gate=" + a.gates.length);

  /* ---------- 2. 配上远端：fetch 只动 .git ---------- */
  await G(work, "remote", "add", "origin", remote);
  const fetched = await run("git_fetch", {});
  ok("git_fetch 成功并回报领先/落后", /已 fetch origin/.test(fetched) && /落后 \d+/.test(fetched), fetched.split("\n")[0]);
  ok("git_fetch 仍是只读（没弹确认）", a.gates.length === gates0);

  /* ---------- 3. push：默认预演，真推要 confirm + 人工闸门 ---------- */
  const dry = await run("git_push", {});
  ok("git_push 不带 confirm 时只预演", /【未推送，仅预演】/.test(dry), dry.split("\n")[0].slice(0, 60));
  ok("关键：预演之后远端提交数仍为 0（预演不许有写副作用）", (await remoteCount(remote)) === "0", "远端=" + await remoteCount(remote));
  ok("预演不弹确认", a.gates.filter((x) => x.name === "git_push").length === 0);

  const hiGate = () => a.gates.filter((x) => x.name === "git_push" && x.danger === "high").length;
  const pushed = await run("git_push", { confirm: true });
  ok("git_push confirm:true 走高危闸门（danger=high，auto 档也问人）", hiGate() === 1 && /已推送到 origin\/main/.test(pushed), pushed.slice(0, 60));
  ok("真推之后远端确实有 1 个提交", (await remoteCount(remote)) === "1", "远端=" + await remoteCount(remote));
  ok("首推自动建立上游跟踪（之后 pull 才有依据）", !!(await g.branchState()).upstream);

  fs.writeFileSync(path.join(work, "c.txt"), "second\n", "utf8");
  await G(work, "add", "c.txt"); await G(work, "commit", "-q", "-m", "second");
  a.approve = false;
  const denied = await run("git_push", { confirm: true });
  ok("用户拒绝后一个字都没推", /拒绝了这次推送/.test(denied) && (await remoteCount(remote)) === "1", "远端=" + await remoteCount(remote));
  const approved = await run("git_push", { confirm: true });
  ok("再次批准后推到 2 个提交", /已推送到/.test(approved) && (await remoteCount(remote)) === "2", "远端=" + await remoteCount(remote));

  /* ---------- 4. git_branch delete：曾经被静默执行成 checkout 的那条 ---------- */
  /* 逐行取分支名：先按行切，再剥掉行首的 "* " / "  " 标记。
     ⚠ 别把空白全局抹掉再 split —— 那样整个列表会粘成一个元素，
     而 Array.includes 比的是元素相等不是子串，断言会静默变成永假（探针自己踩过）。 */
  const branches = async () => (await G(work, "branch", "--list")).split(/\r?\n/).map((l) => l.replace(/^[* ]+/, "").trim()).filter(Boolean);
  /* 夹具要点：同指针的分支在 git 眼里就是"已合并"（--merged 会列出它），未合并那道闸测不出来。
     所以先真的在 feat/x 上落一个 main 没有的提交，再切回来。 */
  await G(work, "checkout", "-q", "-b", "feat/x");
  fs.writeFileSync(path.join(work, "feature.txt"), "只在 feat/x 上\n", "utf8");
  await G(work, "add", "feature.txt"); await G(work, "commit", "-q", "-m", "feature");
  await G(work, "checkout", "-q", "main");
  const b0 = await run("git_branch", { action: "list" });
  ok("正向对照：git_branch list 列出两条分支且免确认", /feat\/x/.test(b0) && /main/.test(b0) && a.gates.filter((x) => x.args && x.args.action === "list").length === 0);

  const gatesBeforeBranch = a.gates.length;
  const delUnmerged = await run("git_branch", { action: "delete", name: "feat/x" });
  ok("删除未合并分支被拒并提示带 force", /还没合并/.test(delUnmerged) && /force:true/.test(delUnmerged), delUnmerged.split("\n")[0].slice(0, 60));
  ok("删除分支走高危闸门", a.gates.length === gatesBeforeBranch + 1 && a.gates[a.gates.length - 1].danger === "high");
  ok("关键：被拒之后分支还在、当前分支仍是 main（修前这里等于切了过去）", (await branches()).includes("feat/x") && (await curBranch(work)) === "main", "HEAD=" + await curBranch(work) + " 列表=" + JSON.stringify(await branches()));
  const delCurrent = await run("git_branch", { action: "delete", name: "main" });
  ok("删不掉自己所在的分支", /不能删除当前所在分支/.test(delCurrent));
  await G(work, "merge", "-q", "--no-edit", "feat/x");
  const delMerged = await run("git_branch", { action: "delete", name: "feat/x" });
  ok("合并之后不带 force 也能删（-d 走通）", /已删除分支: feat\/x/.test(delMerged) && !(await branches()).includes("feat/x"), delMerged);
  const bogus = await run("git_branch", { action: "rename", name: "feat/x" });
  ok("未知动作直接说明支持哪些（不落到 checkout）", /只支持 list \/ create \/ switch \/ delete/.test(bogus));
  await G(work, "push", "-q", "origin", "main");

  /* ---------- 5. pull：只快进；脏与分叉都把决定交回给人 ---------- */
  fs.writeFileSync(path.join(work, "a.txt"), "line1\nlocal-edit\nline3\n", "utf8");
  const dirtyPull = await run("git_pull", {});
  ok("工作区不干净时 pull 先拒绝并指路 git_stash", /未拉取/.test(dirtyPull) && /git_stash/.test(dirtyPull), dirtyPull.split("\n")[0].slice(0, 70));
  await G(work, "checkout", "-q", "--", "a.txt");

  const other = SANDBOX.scratch("gw-other");
  await G(other, "clone", "-q", remote, ".");
  await G(other, "config", "user.email", "o@t.io");
  await G(other, "config", "user.name", "other");
  fs.writeFileSync(path.join(other, "from-remote.txt"), "来自别处的提交\n", "utf8");
  await G(other, "add", "from-remote.txt"); await G(other, "commit", "-q", "-m", "from-remote"); await G(other, "push", "-q", "origin", "main");
  const ff = await run("git_pull", {});
  ok("干净时 pull 快进成功", /已拉取（--ff-only 快进）/.test(ff), ff.split("\n")[0]);
  ok("快进后远端的文件出现在本地", fs.existsSync(path.join(work, "from-remote.txt")));

  fs.writeFileSync(path.join(work, "local-only.txt"), "本地独有的提交\n", "utf8");
  await G(work, "add", "local-only.txt"); await G(work, "commit", "-q", "-m", "local-diverge");
  /* 远端此时与本地只差"本地这一条"，还谈不上分叉 —— 让另一台（other）也落一条并提交上去，
     两边各有一个对方没有的提交，才凑出 git 会说 "Not possible to fast-forward" 的那个状态。 */
  fs.writeFileSync(path.join(other, "second-remote.txt"), "远端又前进了一次\n", "utf8");
  await G(other, "add", "second-remote.txt"); await G(other, "commit", "-q", "-m", "second-remote"); await G(other, "push", "-q", "origin", "main");
  const shaBefore = await headSha(work);
  const div = await run("git_pull", {});
  ok("分叉时不代为合并，只报领先/落后", /已分叉/.test(div) && /本地领先 1、落后 1/.test(div), div.split("\n")[0].slice(0, 70));
  ok("关键：分叉拒绝后没有产生 merge commit（HEAD 未动）", (await headSha(work)) === shaBefore);
  ok("分叉之后本地仍是那条独有提交", fs.existsSync(path.join(work, "local-only.txt")));

  /* ---------- 6. stash：push/list/pop 与"没有 clear" ---------- */
  const emptyStack = await run("git_stash", {});
  ok("空栈如实说空（list 免确认）", /暂存栈是空的/.test(emptyStack) && a.gates.filter((x) => x.name === "git_stash").length === 0);
  fs.writeFileSync(path.join(work, "a.txt"), "line1\nwip-line\nline3\n", "utf8");
  const stashed = await run("git_stash", { action: "push", message: "wip 验收" });
  ok("stash push 后工作区回到提交态", /git stash push 完成/.test(stashed) && fs.readFileSync(path.join(work, "a.txt"), "utf8").includes("line2"), stashed.slice(0, 50));
  ok("stash push 弹了确认", a.gates.filter((x) => x.name === "git_stash").length === 1);
  const listing = await run("git_stash", { action: "list" });
  ok("list 条目带上用户写的说明", /暂存栈（1 条）/.test(listing) && /wip 验收/.test(listing), listing.split("\n")[1] || "");
  const popped = await run("git_stash", { action: "pop" });
  ok("pop 把改动放回工作区", /完成/.test(popped) && fs.readFileSync(path.join(work, "a.txt"), "utf8").includes("wip-line"));
  await G(work, "checkout", "-q", "--", "a.txt");
  const cleared = await run("git_stash", { action: "clear" });
  ok("clear 不存在（一次误触抹掉全部历史暂存，不给这个键）", /只支持 push \/ pop \/ list \/ apply \/ drop/.test(cleared) && a.lastCard().done === false);

  /* ---------- 7. blame：改别人代码前的上下文 ---------- */
  const bl = await run("git_blame", { path: "a.txt", line: 1, lineEnd: 2 });
  ok("blame 给出提交、作者与日期", /来自 1 个提交/.test(bl) && /\bt\b/.test(bl) && /[0-9a-f]{8}/.test(bl), bl.split("\n")[1] || "");
  const blTooBig = await run("git_blame", { path: "a.txt", line: 1, lineEnd: 400 });
  ok("一次最多 120 行（否则输出把上下文挤爆）", /一次最多看 120 行/.test(blTooBig));

  /* ---------- 8. reset：hard 连闸门都不弹，soft/mixed 不动文件 ---------- */
  const gatesBeforeReset = a.gates.length;
  const hard = await run("git_reset", { mode: "hard", target: "HEAD~1" });
  ok("reset --hard 直接拒绝", /拒绝执行 git reset --hard/.test(hard));
  ok("关键：拒绝发生在弹卡片之前（gate 次数没涨）", a.gates.length === gatesBeforeReset, "gate=" + a.gates.length);

  const sha2 = await headSha(work);
  fs.writeFileSync(path.join(work, "keep-me.txt"), "这份改动不能丢\n", "utf8");
  await G(work, "add", "keep-me.txt"); await G(work, "commit", "-q", "-m", "keep");
  const mixed = await run("git_reset", { mode: "mixed", target: "HEAD~1" });
  ok("mixed 回退指针并经过高危闸门", /已 git reset --mixed/.test(mixed) && a.gated("git_reset").length === 1 && a.gated("git_reset")[0].danger === "high");
  ok("关键：mixed 之后文件内容还在（只是没提交）", fs.readFileSync(path.join(work, "keep-me.txt"), "utf8").includes("这份改动不能丢"));
  ok("HEAD 确实退回了上一个提交", (await headSha(work)) === sha2);
  ok("mixed 把改动退回工作区（暂存区已清空）", !(await G(work, "diff", "--cached", "--name-only")).includes("keep-me.txt"));

  await G(work, "add", "keep-me.txt"); await G(work, "commit", "-q", "-m", "keep-again");
  const soft = await run("git_reset", { mode: "soft", target: "HEAD~1" });
  ok("soft 同样回退指针", /已 git reset --soft/.test(soft) && (await headSha(work)) === sha2);
  ok("关键：soft 之后改动留在暂存区（与 mixed 的差别就在这）", (await G(work, "diff", "--cached", "--name-only")).includes("keep-me.txt"));

  const badRef = await run("git_reset", { mode: "mixed", target: "--help" });
  ok("目标引用不接受开关（防参数注入）", /非法提交引用/.test(badRef));

  console.log("\n[P1-B2] 结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e && e.stack || e); process.exit(1); });
