/* ============================================================
   pancode Git 层 —— 对齐 VS Code 源代码管理
   - 工作区若是 Git 仓库：Diff 基线 = HEAD 版本，状态 = git status
   - 不是 Git 仓库 / 未安装 git：自动降级为启动时内存快照
   - W12：所有 git 子进程调用改为异步（execFile + promisify），不再阻塞事件循环；
          并发上限由信号量控制，避免大仓库/高频调用压垮机器。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync, execFile } = require("child_process");
const { promisify } = require("util");

const execFileP = promisify(execFile);

/* 同一个目录可以有很多种写法：Windows 的 8.3 短名（C:\Users\ANLAN0~1\…）、大小写、
   分隔符、git 自己输出的正斜杠。`path.resolve` 只处理分隔符与相对段，不比短名也不折大小写，
   于是"目录明明就是那个仓库"却被判成两个地方 → GitLayer 整体不启用，
   diff 基线、改动面板、提交全部静默退化成快照模式（实测踩过：临时目录就是短名）。 */
function sameDir(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    let s = String(p);
    try { s = fs.realpathSync.native(path.resolve(s)); } catch (e) { /* 掉盘/非 Windows：退回词法归一 */ }
    return s.replace(/[\\/]+$/, "").toLowerCase();
  };
  return norm(a) === norm(b);
}

/* 一票否决：仓库根就是用户主目录。
   "家目录里躺着一个误建的 .git" 不是假想（实测这台机器就有，而且一次提交都没有）。
   认了它，主目录下的每个普通文件夹都会被判成"仓库子目录"，
   于是 git_commit 会把文件提交进家目录仓库 —— 打开一个非项目文件夹绝不该有这种后果。 */
function isHomeRepo(top, home) {
  try { return sameDir(top, home || require("os").homedir()); } catch (e) { return false; }
}

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

/* 一票否决之二：祖先仓库把本工作区整个 ignore 掉了。
   这时 `git status` 永远列不出这里的任何改动（实测：pancode 自己的 .gitignore 写着 workspace/，
   于是 smoke/fileops 两个夹具的"改动文件数"直接变成 0），而快照模式本来什么都对。
   认了这种仓库 = 把改动面板、diff 基线、提交全部换成静默空集 —— 宁可退回快照。 */
function isIgnoredHere(dir) {
  try {
    execFileSync("git", ["check-ignore", "-q", "."], { cwd: dir, encoding: "utf8", timeout: 8000, windowsHide: true });
    return true;                                   // 退出码 0 = 被忽略
  } catch (e) {
    return !!(e && e.status === 1) ? false : true; // 1 = 没被忽略；其它（128 等）保守当作"被忽略"，别赌
  }
}

class GitLayer {
  constructor(wsDir, fileStore) {
    this.dir = wsDir;
    this.fileStore = fileStore;
    this.available = false;  // git 命令 + 是否为仓库
    this.branch = "";
    this.prefix = "";        // 工作区相对仓库根的位置（"web/app/"，正斜杠带尾斜杠）；仓库根本身 = ""
    this.snapshot = {};      // 降级方案：启动时快照
    this._init();
  }

  /* 工作区里的相对路径 → 仓库根视角的路径。
     ⚠ 只有 revspec 形式（`git show HEAD:<path>`）用的是这个坐标系。
     `-- <pathspec>` 那类（diff / add / checkout）**是相对当前工作目录**的，
     而我们所有子进程都以 this.dir 为 cwd —— 那里必须原样传工作区相对路径，
     加了前缀反而变成 web/app/web/app/main.js 这种不存在的路径（实测：diff 直接空、add 报 pathspec 不匹配）。 */
  _toRepo(rel) {
    const s = String(rel == null ? "" : rel).replace(/\\/g, "/").replace(/^\/+/, "");
    return this.prefix && !s.startsWith(this.prefix) ? this.prefix + s : s;
  }

  /* git 输出的仓库根路径 → 工作区相对路径（前端、FileStore、改动面板说的都是这个坐标系） */
  _fromRepo(p) {
    const s = String(p || "").replace(/\\/g, "/");
    return this.prefix && s.startsWith(this.prefix) ? s.slice(this.prefix.length) : s;
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
      /* 工作区是仓库的子目录（monorepo 里只打开 web/app）以前等于 git 能力整体缺席：
         判据只认"工作区==仓库根"。现在认"工作区落在某个仓库里"，代价是所有路径都要换算
         （git 输出的永远是仓库根相对路径，而 FileStore / 改动面板 / 提交接口说的是工作区相对路径）。
         实测过的两条换算依据：
           - `status --porcelain -uall -- .` 从子目录跑：只列本子目录，但路径仍是仓库根相对的；
             `--relative` 在 porcelain 模式下直接输出空，不能用。
           - `add -A -- .` / `checkout -- .` / `clean -fd` 从子目录跑都天然只作用于本子目录。 */
      if (inside === "true" && top && !isHomeRepo(top)) {
        const isRoot = sameDir(top, this.dir);
        let prefix = "";
        if (!isRoot) {
          try {
            prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
              cwd: this.dir, encoding: "utf8", timeout: 8000, windowsHide: true,
            }).trim().replace(/\\/g, "/");
          } catch (e) { prefix = ""; }
        }
        if ((isRoot || (prefix && prefix !== "/")) && (isRoot || !isIgnoredHere(this.dir))) {
          this.available = true;
          this.prefix = isRoot ? "" : prefix;
          try {
            this.branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
              cwd: this.dir, encoding: "utf8", timeout: 8000, windowsHide: true,
            }).trim();
          } catch (e) { this.branch = "main"; }
        }
      }
    } catch (e) { this.available = false; }
    // 无论是否有 git，都保留一份快照兜底（git 仓库中未跟踪文件也需要基线）
    for (const rel of this.fileStore.list()) {
      try { this.snapshot[rel] = this.fileStore.read(rel); } catch (e) {}
    }
  }

  /* 取某文件的 diff 基线内容；null 表示新增文件（无基线）。入参是**工作区相对路径**。 */
  async baseline(rel) {
    if (this.available) {
      try {
        return await _git(this.dir, ["show", "HEAD:" + this._toRepo(rel)], { maxBuffer: 64 * 1024 * 1024 });
      } catch (e) {
        // HEAD 中不存在（新文件）→ 尝试快照，再没有就是全新文件
        return this.snapshot[rel] !== undefined ? this.snapshot[rel] : null;
      }
    }
    return this.snapshot[rel] !== undefined ? this.snapshot[rel] : null;
  }

  /* 启动快照里的内容（不发子进程）。undefined = 启动时这个文件不存在。
     给批量快照用：未跟踪/被忽略的文件走的就是这条路，没必要先起一发必定失败的 `git show`。 */
  snapshotOf(rel) {
    return this.snapshot[rel];
  }

  /* 一次性拿到 HEAD 里已有的文件集合（工作区相对路径）。
     ⚠ 坐标系与 changes() 相反：`ls-files -- .` 输出的是**相对 cwd** 的路径
     （实测子目录里得到 b.txt / deep/c.txt），而 `status --porcelain` 输出的是仓库根相对路径。
     所以这里绝不能再套 _fromRepo，剥前缀会剥出错误路径。 */
  async trackedSet() {
    if (!this.available) return null;
    let txt = "";
    try { txt = await _git(this.dir, ["ls-files", "-c", "--", "."]); } catch (e) { return null; }
    const set = new Set();
    for (const line of txt.split("\n")) {
      const p = line.trim().replace(/"/g, "");
      if (p) set.add(p.replace(/\\/g, "/"));
    }
    return set;
  }

  /* 批量快照的取基线策略（首屏 22s 空白的根治点）：
     以前 snapshotFiles 对**每个文件** await 一次 baseline(rel)，也就是一发
     `git show HEAD:<path>` 子进程。实测 126ms/次 × 127 个文件 = 22.3s 才有第一屏。
     而其中真正需要读 HEAD 的只有"改过的少数几个"：
       · 已跟踪且 status 没报 → 工作区内容就等于基线，直接用 content，不发进程；
       · 已跟踪且报 M/D      → 才真需要 `git show`（通常个位数）；
       · 未跟踪 / 被忽略      → 旧代码也是先起一发必定失败的 git show 再回落到启动快照，
                                这里直接读快照，结果逐字相同，少 N 次失败子进程。
     没有 git 时返回 null，调用方整体走快照口径（与旧行为一致）。 */
  async baselinePlanner() {
    const tracked = await this.trackedSet();
    if (!tracked) return null;
    const changed = new Set((await this.changes()).map((c) => c.path));
    const self = this;
    return async function pick(rel, content) {
      if (!tracked.has(rel)) return self.snapshotOf(rel) === undefined ? null : self.snapshotOf(rel);
      if (!changed.has(rel)) return content;
      return await self.baseline(rel);
    };
  }

  /* 变更列表：[{path, status}]  status: M 修改 / A 新增 / D 删除
     path 一律是**工作区相对路径**（子目录工作区要把仓库根前缀剥掉），
     并且只列工作区之内的改动——仓库里别处的改动不归这个面板管。 */
  async changes() {
    const out = [];
    if (this.available) {
      let txt = "";
      try { txt = await _git(this.dir, ["status", "--porcelain", "-uall", "--", "."]); } catch (e) { return out; }
      for (const line of txt.split("\n")) {
        if (!line.trim()) continue;
        const xy = line.slice(0, 2);
        let p = line.slice(3).trim().replace(/"/g, "");
        if (p.includes(" -> ")) p = p.split(" -> ")[1];
        let status = "M";
        if (xy.includes("D")) status = "D";
        else if (xy.includes("?") || xy.includes("A")) status = "A";
        out.push({ path: this._fromRepo(p).replace(/\\/g, "/"), status });
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

  /* 同步方法：仅返回已知状态（不触发任何子进程，零阻塞）。
     sub = 工作区在仓库里的位置（"web/app/"）；非空说明打开的是子目录，
     界面要说清楚"这里的改动只代表这个子目录，仓库别处看不见"。 */
  info() {
    return {
      git: this.available,
      branch: this.available ? this.branch : "无 Git（快照模式）",
      sub: this.available ? this.prefix : "",
    };
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
      /* pathspec 是"相对当前工作目录"的，而 cwd 就是工作区 → 直接传工作区相对路径。
         `add -A -- .` 因此天然只吃本工作区之内的改动（实测），不会把仓库别处别人暂存的东西卷进来。 */
      if (targets) await _git(this.dir, ["add", "--", ...targets]);
      else await _git(this.dir, ["add", "-A", "--", "."]);
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

  /* 改动概览（--stat）；rel 提供时输出该文件的完整 diff 文本。
     参数以前叫 `path`，把模块级的那个 `path` 遮掉了：`path.isAbsolute(rel)` 直接抛
     "path.isAbsolute is not a function"，再被 catch 吞成一句看不懂的"git 错误"——改名修掉。 */
  async diff(rel) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库（快照模式下可用 git_status 的快照差异）" };
    try {
      if (rel) {
        const r = String(rel).replace(/\\/g, "/").replace(/^\/+/, "");
        if (/^\.\./.test(r) || path.isAbsolute(r)) return { ok: false, error: "非法路径" };
        const txt = (await _git(this.dir, ["diff", "HEAD", "--", r])).trim();
        return { ok: true, diff: txt || "(该文件相对 HEAD 无文本差异)" };
      }
      const stat = (await _git(this.dir, ["diff", "HEAD", "--stat", "--", "."])).trim();
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

module.exports = { GitLayer, sameDir, isHomeRepo, isIgnoredHere };
