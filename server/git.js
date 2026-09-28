/* ============================================================
   pancode Git 层 —— 对齐 VS Code 源代码管理
   - 工作区若是 Git 仓库：Diff 基线 = HEAD 版本，状态 = git status
   - 不是 Git 仓库 / 未安装 git：自动降级为启动时内存快照
   - W12：所有 git 子进程调用改为异步（execFile + promisify），不再阻塞事件循环；
          并发上限由信号量控制，避免大仓库/高频调用压垮机器。
   ============================================================ */
"use strict";
const path = require("path");
const { execFileSync, execFile } = require("child_process");
const { promisify } = require("util");

const execFileP = promisify(execFile);

/* W12：git 子进程并发上限——避免同时拉起过多 git 进程拖垮机器 */
const MAX_GIT = 6;
let _gitInflight = 0;
const _gitQueue = [];
function _gitAcquire() {
  return new Promise((resolve) => {
    if (_gitInflight < MAX_GIT) { _gitInflight++; resolve(); }
    else _gitQueue.push(resolve);
  });
}
function _gitRelease() {
  _gitInflight--;
  if (_gitQueue.length) { _gitInflight++; _gitQueue.shift()(); }
}

/* 异步执行单个 git 命令；非 0 退出会抛错（error.stdout/stderr 可用）。 */
async function _git(dir, args, opts) {
  await _gitAcquire();
  try {
    const { stdout } = await execFileP("git", args, Object.assign({
      cwd: dir, encoding: "utf8", timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }, opts || {}));
    return stdout;
  } finally { _gitRelease(); }
}

class GitLayer {
  constructor(wsDir, fileStore) {
    this.dir = wsDir;
    this.fileStore = fileStore;
    this.available = false;  // git 命令 + 是否为仓库
    this.branch = "";
    this.snapshot = {};      // 降级方案：启动时快照
    this._init();
  }

  /* 启动期一次性探测（同步可接受：仅在 boot 跑一次，且快） */
  _init() {
    try {
      const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: this.dir, encoding: "utf8", timeout: 8000, windowsHide: true,
      }).trim();
      const top = inside === "true"
        ? execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: this.dir, encoding: "utf8", timeout: 8000, windowsHide: true,
        }).trim()
        : "";
      if (inside === "true" && path.resolve(top) === path.resolve(this.dir)) {
        this.available = true;
        try {
          this.branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: this.dir, encoding: "utf8", timeout: 8000, windowsHide: true,
          }).trim();
        } catch (e) { this.branch = "main"; }
      }
    } catch (e) { this.available = false; }
    // 无论是否有 git，都保留一份快照兜底（git 仓库中未跟踪文件也需要基线）
    for (const rel of this.fileStore.list()) {
      try { this.snapshot[rel] = this.fileStore.read(rel); } catch (e) {}
    }
  }

  /* 取某文件的 diff 基线内容；null 表示新增文件（无基线） */
  async baseline(rel) {
    if (this.available) {
      try {
        return await _git(this.dir, ["show", "HEAD:" + rel], { maxBuffer: 64 * 1024 * 1024 });
      } catch (e) {
        // HEAD 中不存在（新文件）→ 尝试快照，再没有就是全新文件
        return this.snapshot[rel] !== undefined ? this.snapshot[rel] : null;
      }
    }
    return this.snapshot[rel] !== undefined ? this.snapshot[rel] : null;
  }

  /* 变更列表：[{path, status}]  status: M 修改 / A 新增 / D 删除 */
  async changes() {
    const out = [];
    if (this.available) {
      let txt = "";
      try { txt = await _git(this.dir, ["status", "--porcelain", "-uall"]); } catch (e) { return out; }
      for (const line of txt.split("\n")) {
        if (!line.trim()) continue;
        const xy = line.slice(0, 2);
        let p = line.slice(3).trim().replace(/"/g, "");
        if (p.includes(" -> ")) p = p.split(" -> ")[1];
        let status = "M";
        if (xy.includes("D")) status = "D";
        else if (xy.includes("?") || xy.includes("A")) status = "A";
        out.push({ path: p.replace(/\\/g, "/"), status });
      }
      return out;
    }
    // 快照比对降级（纯内存，同步即可）
    const live = new Set(this.fileStore.list());
    for (const rel of live) {
      if (this.fileStore.isBinary && this.fileStore.isBinary(rel)) continue; // 二进制不参与文本 diff
      const base = this.snapshot[rel];
      if (base === undefined) { out.push({ path: rel, status: "A" }); continue; }
      let cur = "";
      try { cur = this.fileStore.read(rel); } catch (e) { continue; }
      if (cur !== base) out.push({ path: rel, status: "M" });
    }
    for (const rel in this.snapshot) {
      if (!live.has(rel)) out.push({ path: rel, status: "D" });
    }
    return out;
  }

  /* 丢弃全部更改，回到基线（对齐 VS Code 的 discard changes） */
  async discardAll() {
    if (this.available) {
      try {
        await _git(this.dir, ["checkout", "--", "."]);
        await _git(this.dir, ["clean", "-fd"]);
        return true;
      } catch (e) { /* 落到快照方案 */ }
    }
    const live = new Set(this.fileStore.list());
    for (const rel in this.snapshot) {
      try { this.fileStore.write(rel, this.snapshot[rel]); } catch (e) {}
    }
    for (const rel of live) if (this.snapshot[rel] === undefined) {
      // 二进制文件（Word/图片等）从不进文本快照，绝不能当"新增文件"误删
      if (this.fileStore.isBinary && this.fileStore.isBinary(rel)) continue;
      try { this.fileStore.remove(rel); } catch (e) {}
    }
    return true;
  }

  /* 同步方法：仅返回已知状态（不触发任何子进程，零阻塞） */
  info() {
    return { git: this.available, branch: this.available ? this.branch : "无 Git（快照模式）" };
  }

  /* 提交改动：git add + git commit -m <message>
     - files 省略 / 为空：git add -A（全量，向后兼容）
     - files 为路径数组：仅暂存这些文件（按文件选择性提交）
     安全：files 必须经过 changes() 白名单校验，拒绝 ../ 逃逸与绝对路径，杜绝越权/注入。
     message 作为独立参数传入（非 shell 拼接），无注入风险。
     返回 { ok, summary, committed }；无可提交改动时为 { ok:false, nothing:true }。 */
  async commit(message, files) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库，无法提交" };
    const msg = (message || "").trim() || "chore: 通过 pancode 提交改动";
    // 选择性提交：仅接受当前真实改动集合内的路径
    let targets = null;
    if (Array.isArray(files) && files.length) {
      const allowed = new Set((await this.changes()).map((c) => c.path));
      const clean = files.filter((f) => typeof f === "string" && allowed.has(f) && !/^\.\./.test(f) && !path.isAbsolute(f));
      if (!clean.length) return { ok: false, error: "未选择任何有效文件" };
      targets = clean;
    }
    try {
      if (targets) await _git(this.dir, ["add", "--", ...targets]);
      else await _git(this.dir, ["add", "-A"]);
      let out = "";
      try { out = (await _git(this.dir, ["commit", "-m", msg])).trim(); }
      catch (e) {
        const t = (e.stderr || e.stdout || e.message || "").toString();
        if (/nothing to commit/i.test(t)) return { ok: false, nothing: true };
        throw e;
      }
      // 统计本次提交涉及的文件数
      let committed = 0;
      try {
        committed = (await _git(this.dir, ["show", "--stat", "--oneline", "HEAD", "-1"]))
          .split("\n").filter((l) => /\|\s*\d+/.test(l)).length;
      } catch (e) {}
      return { ok: true, summary: out, committed };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.stdout || e.message || "").toString().slice(0, 300) };
    }
  }

  /* 已配置的远端名列表（界面据此决定"推送"是否可用） */
  async remotes() {
    if (!this.available) return [];
    try { return (await _git(this.dir, ["remote"])).trim().split("\n").filter(Boolean); }
    catch (e) { return []; }
  }

  /* 推送到远端。没有 remote / 上游时把话说清楚，而不是静默失败——
     界面上的按钮写的是"提交或推送"，之前根本没有推送实现，点了自然没反应。
     push 走网络，_git 默认 15s 太短，这里单独给 60s。 */  async push() {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库，无法推送" };
    try {
      const remotes = (await _git(this.dir, ["remote"])).trim().split("\n").filter(Boolean);
      if (!remotes.length) return { ok: false, noRemote: true, error: "这个仓库还没有远端（git remote 为空），只能本地提交" };
      const branch = (await _git(this.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (!branch || branch === "HEAD") return { ok: false, error: "当前处于游离 HEAD，请先切到一个分支再推送" };
      const remote = remotes.indexOf("origin") >= 0 ? "origin" : remotes[0];
      let out;
      try {
        out = (await _git(this.dir, ["push", remote, branch], { timeout: 60000 })).trim();
      } catch (e) {
        const t = ((e.stderr || "") + " " + (e.stdout || "")).toString().trim();
        if (/rejected|non-fast-forward/i.test(t)) return { ok: false, rejected: true, error: "远端有更新的提交，推送被拒绝：先拉取（git pull）合并后再推" };
        if (/Could not resolve host|unable to access|Connection refused|timed out|The requested URL returned error/i.test(t)) {
          return { ok: false, network: true, error: "连不上远端 " + remote + "：" + (t.split("\n").pop() || e.message).slice(0, 200) };
        }
        return { ok: false, error: (t || e.message || "推送失败").slice(0, 300) };
      }
      return { ok: true, remote, branch, summary: out.split("\n").slice(-3).join(" ").slice(0, 300) };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.stdout || e.message || "").toString().slice(0, 300) };
    }
  }

  /* ============ Agent Git 工具集（结构化封装，数组传参无 shell 注入） ============ */

  /* 最近提交历史 */
  async log(n) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    const count = Math.min(Math.max(Number(n) || 15, 1), 100);
    try {
      const out = (await _git(this.dir, ["log", "--oneline", "--decorate", "-" + count])).trim();
      return { ok: true, log: out };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.message || "").toString().slice(0, 300) };
    }
  }

  /* 改动概览（--stat）；path 提供时输出该文件的完整 diff 文本 */
  async diff(path) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库（快照模式下可用 git_status 的快照差异）" };
    try {
      if (path) {
        const rel = String(path).replace(/\\/g, "/").replace(/^\/+/, "");
        if (/^\.\./.test(rel) || path.isAbsolute(rel)) return { ok: false, error: "非法路径" };
        const txt = (await _git(this.dir, ["diff", "HEAD", "--", rel])).trim();
        return { ok: true, diff: txt || "(该文件相对 HEAD 无文本差异)" };
      }
      const stat = (await _git(this.dir, ["diff", "HEAD", "--stat"])).trim();
      return { ok: true, stat: stat || "(相对 HEAD 无已跟踪改动；新文件请看 git_status)" };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.message || "").toString().slice(0, 300) };
    }
  }

  /* 分支清单（当前分支带 * 标记） */
  async branches() {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    try {
      const out = (await _git(this.dir, ["branch", "--list"])).trim();
      return { ok: true, branches: out, current: this.branch };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.message || "").toString().slice(0,300) };
    }
  }

  /* 创建 / 切换分支。name 严格校验，杜绝引用注入 */
  async checkout(name, create) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    const b = String(name || "").trim();
    if (!/^[A-Za-z0-9._\-/]{1,80}$/.test(b) || b.startsWith("-") || b.includes("..")) {
      return { ok: false, error: "非法分支名：" + b };
    }
    try {
      const ch = await this.changes();
      if (ch.length) return { ok: false, error: "存在未提交改动，请先 git_commit 或让用户还原后再切换分支" };
      const args = create ? ["checkout", "-b", b] : ["checkout", b];
      await _git(this.dir, args);
      this.branch = (await _git(this.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      return { ok: true, branch: this.branch, created: !!create };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.stdout || e.message || "").toString().slice(0, 300) };
    }
  }
}

module.exports = { GitLayer };
