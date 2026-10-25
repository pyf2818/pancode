/* ============================================================
   undo 持久化用的影子 git 仓库
   ------------------------------------------------------------
   影子仓只服务一件事：内存撤销栈空了（重启 / 跨会话）时，还能把
   「上一个检查点」退回去。它必须满足三条硬约束：

   1. 一个工作区一份仓。以前按 path.basename(workspace) 分片，
      两个同名项目（E:\a\demo 与 D:\b\demo）会共用一份仓，第二家
      初始化时改掉 core.worktree，第一家此后 commit/undo 全落在
      别人的目录上。现在用 ws-key 的规范化全路径分片。
   2. 用之前先验身份。仓里 core.worktree 指的不是本项目时，宁可禁用
      undo 持久化，也不能在别人的目录里 reset。
   3. 回退只碰这个 commit 真正动过的路径。旧实现 reset --hard +
      clean -fd 会把工作区里所有未提交改动和未跟踪文件一起抹掉——
      那不是"撤销一步"，是把用户这一段时间的手工工作全删了。
   回退成功后 HEAD 也退一格（--soft，不动工作区），否则下一份检查点会
   盖在被撤销的提交上，再撤一次就把刚撤掉的内容装回来。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const wsKey = require("./ws-key");

const GIT_TIMEOUT = 15000;

function run(args, opts) {
  return execFileSync("git", args, Object.assign({ stdio: "pipe", timeout: GIT_TIMEOUT, windowsHide: true }, opts || {}));
}

function repoArgs(gitDir, worktree) {
  return ["--git-dir", gitDir, "--work-tree", worktree];
}

function shadowRoot(dataRoot) {
  return path.join(path.resolve(dataRoot), ".pancode", "shadow-git");
}

/* 规范化全路径分片：同名不同地的项目各拿各的仓 */
function shadowDirFor(dataRoot, filesDir) {
  return path.join(shadowRoot(dataRoot), wsKey.shardKey(filesDir, dataRoot));
}

/* 老版本按 basename 分的目录：只用于迁移，认领前必须验 core.worktree */
function legacyShadowDirFor(dataRoot, filesDir) {
  return path.join(shadowRoot(dataRoot), path.basename(path.resolve(filesDir)));
}

function readWorktree(gitDir) {
  try {
    return String(run(["-C", gitDir, "config", "--get", "core.worktree"], { encoding: "utf8" }) || "").trim();
  } catch (e) { return ""; }
}

function worktreeMatches(gitDir, filesDir) {
  const got = readWorktree(gitDir);
  if (!got) return false;
  const want = wsKey.normalizeDir(filesDir);
  const have = wsKey.normalizeDir(path.isAbsolute(got) ? got : path.resolve(gitDir, got));
  return have === want;
}

function hasHead(gitDir) {
  try { run(["-C", gitDir, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" }); return true; }
  catch (e) { return false; }
}

function initRepo(gitDir, filesDir) {
  fs.mkdirSync(gitDir, { recursive: true });
  run(["init", "--bare", "--quiet", gitDir]);
  run(["-C", gitDir, "config", "core.bare", "false"]);
  run(["-C", gitDir, "config", "core.worktree", path.resolve(filesDir)]);
  run(["-C", gitDir, "config", "user.name", "pancode"]);
  run(["-C", gitDir, "config", "user.email", "pancode@local"]);
  run(["-C", gitDir, "config", "commit.gpgsign", "false"]);
  run(["-C", gitDir, "config", "core.excludesFile", path.join(gitDir, "info", "exclude")]);
  run([...repoArgs(gitDir, filesDir), "add", "-A"]);
  run([...repoArgs(gitDir, filesDir), "commit", "-m", "pancode shadow init", "--allow-empty", "--quiet"]);
}

/* 准备（必要时初始化）影子仓。返回 { ok, dir, reason, adopted }：
   ok=false 时调用方必须禁用 shadow 回退，而不是"换个目录也要凑合用"。 */
function ensureShadowRepo(dataRoot, filesDir) {
  const want = path.resolve(filesDir);
  const dir = shadowDirFor(dataRoot, want);
  const legacy = legacyShadowDirFor(dataRoot, want);
  let adopted = false;

  if (!fs.existsSync(dir) && legacy !== dir && fs.existsSync(legacy) && worktreeMatches(legacy, want)) {
    try { fs.renameSync(legacy, dir); adopted = true; }
    catch (e) { /* 搬不动就用老目录，但下面仍要验身份 */ }
  }
  const use = fs.existsSync(dir) ? dir : (legacy !== dir && fs.existsSync(legacy) && worktreeMatches(legacy, want) ? legacy : dir);

  try {
    if (fs.existsSync(use)) {
      const isRepo = (() => { try { run(["-C", use, "rev-parse", "--git-dir"], { encoding: "utf8" }); return true; } catch (e) { return false; } })();
      if (isRepo && !worktreeMatches(use, want)) {
        return { ok: false, dir: use, reason: "影子仓的 worktree 指向别处，已禁用（拒绝在别人的目录里回退）" };
      }
      if (isRepo && hasHead(use)) return { ok: true, dir: use, adopted };
    }
    initRepo(use, want);
    if (!hasHead(use) || !worktreeMatches(use, want)) {
      return { ok: false, dir: use, reason: "影子仓初始化后身份校验未通过" };
    }
    return { ok: true, dir: use, adopted };
  } catch (e) {
    return { ok: false, dir: use, reason: "影子仓初始化失败：" + e.message };
  }
}

/* HEAD 相对父提交改了哪些路径。--no-renames 让改名退化成 A+D，
   回退按 A=删、D/M/T=从父提交取回，处理逻辑不必猜相似度。 */
function changedAtHead(gitDir, worktree) {
  const buf = run([...repoArgs(gitDir, worktree), "diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--no-renames", "HEAD"],
    { encoding: "buffer" });
  const parts = String(buf.toString("utf8")).split("\0");
  const out = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (!status) break;
    const p = parts[i++];
    if (!p) break;
    out.push({ status: status[0], path: p.replace(/\\/g, "/") });
  }
  return out;
}

/* 回退一个检查点：只动 HEAD 这个 commit 改过的路径。
   A（本检查点新建）= 删掉；M/D/T = 从 HEAD~1 取回。
   工作区里其余未提交改动、未跟踪文件一律不碰。
   返回 { ok, restored, removed, failed, reason }。 */
function restoreLast(gitDir, worktree, files) {
  try { run(["-C", gitDir, "rev-parse", "--verify", "HEAD~1"], { encoding: "utf8" }); }
  catch (e) { return { ok: false, reason: "没有更早的检查点", restored: [], removed: [], failed: [] }; }

  let changes;
  try { changes = changedAtHead(gitDir, worktree); }
  catch (e) { return { ok: false, reason: "读取检查点变更失败：" + e.message, restored: [], removed: [], failed: [] }; }

  const restored = [], removed = [], failed = [];
  for (const ch of changes) {
    if (ch.status === "A") {
      try {
        files.safePath(ch.path);                 // 词法 + 软链校验，绝不越过工作区
        if (files.exists(ch.path)) { files.remove(ch.path); removed.push(ch.path); }
      } catch (e) { failed.push({ path: ch.path, error: e.message }); }
      continue;
    }
    try {
      files.safePath(ch.path);
      run(["--literal-pathspecs", ...repoArgs(gitDir, worktree), "checkout", "HEAD~1", "--", ch.path]);
      restored.push(ch.path);
    } catch (e) { failed.push({ path: ch.path, error: e.message }); }
  }
  if (failed.length) {
    return { ok: false, restored, removed, failed, reason: "有 " + failed.length + " 个文件没能恢复" };
  }
  /* 全成功才把 HEAD 也退一格。只还原工作区、不动 HEAD 的话，下一次检查点会盖在
     被撤销的提交上面 —— 再撤销一次就把刚撤掉的内容又装回来（历史与工作区错位）。 */
  try { run(["-C", gitDir, "reset", "--soft", "HEAD~1"]); }
  catch (e) { return { ok: false, restored, removed, failed: [], reason: "内容已还原但 HEAD 未能前移：" + e.message }; }
  return { ok: true, restored, removed, failed: [] };
}

/* 提交一次快照。
   paths 是数组时只记这些路径（调用方给的是这次真正写过的文件）：all-in 会把
   用户自己的未提交改动、未跟踪文件一起卷进检查点，下一次撤销就把它们当"agent 新建"
   删掉。paths 省略 = 全量（初始化用），空数组 = 本工作区没什么可记（跨根操作）。
   失败交给调用方降级，不影响主流程。 */
function commit(gitDir, worktree, label, paths) {
  const scoped = Array.isArray(paths);
  const list = scoped
    ? paths.map((p) => String(p || "").replace(/\\/g, "/"))
      .filter((p) => p && !path.isAbsolute(p) && p.split("/").indexOf("..") < 0)
    : [];
  if (scoped && !list.length) return false;
  /* 先把索引对齐 HEAD：上一次 checkout HEAD~1 -- <path> 会留下 staged 状态，
     直接 commit 会把它一起带进这次检查点。 */
  run(["-C", gitDir, "reset", "--quiet"]);
  if (scoped) {
    run(["--literal-pathspecs", ...repoArgs(gitDir, worktree), "add", "-A", "--", ...list]);
  } else {
    run([...repoArgs(gitDir, worktree), "add", "-A"]);
  }
  run([...repoArgs(gitDir, worktree), "commit", "-m", String(label || "checkpoint"), "--allow-empty", "--quiet"]);
  return true;
}

module.exports = {
  shadowDirFor, legacyShadowDirFor, ensureShadowRepo, worktreeMatches,
  changedAtHead, restoreLast, commit, initRepo,
};
