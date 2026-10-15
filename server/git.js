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

/* 给用户和模型看的输出必须 stdout+stderr 合起来读：
   git 把 push / fetch / pull / stash 的结果消息一律写在 stderr（"To …"、"[new branch] …"、
   "Saved working directory…"）。只取 stdout 等于把这些整段丢掉 ——
   实测后果是 push 预演永远回报"(无变化)"、新分支认不出来（newBranch 恒 false），
   而那正是这个工具存在的意义。解析型命令（log/status/rev-parse）继续用 _git，别混。 */
async function _gitSay(dir, args, opts) {
  await _gitAcquire();
  try {
    const r = await execFileP("git", args, Object.assign({
      cwd: dir, encoding: "utf8", timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }, opts || {}));
    return (String(r.stdout || "") + String(r.stderr || "")).trim();
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

/* P-M1：worktree 副本的统一落点（<仓库根>/.worktrees/<名字>）。
   点开头不是随手起的：FileStore.isIgnored 与代码索引按设计跳过一切点开头目录，
   于是主工作区里开出的副本不会被当成"本项目的另一份同名文件"混进搜索结果与改动列表。 */
const WORKTREE_DIR = ".worktrees";

/* parent 里面有没有装着 child（含相等）。两边都归一到绝对路径 + 正斜杠 + 去尾分隔符，
   Windows 再折一次大小写 —— 与 sameDir 同一套口径，否则"路径明明在里面"会被判成在外面。
   ⚠ 不能直接 realpath：child 常常是"还没建出来的目标目录"（开副本时就是这种时刻），
   realpath 对不存在的路径会抛，于是同一目录的短名与长名被比成两个地方，
   表现为"副本目录会落到仓库外面"这种莫名其妙的拒绝。所以逐级往上找到存在的祖先展开，
   再把剩下的段拼回去。 */
function dirContains(parent, child) {
  if (!parent || !child) return false;
  const win = process.platform === "win32";
  const norm = (p) => {
    const abs = path.resolve(String(p));
    const tail = [];
    let cur = abs, real = "";
    for (let i = 0; i < 16 && cur; i++) {
      try { real = fs.realpathSync.native(cur); break; } catch (e) { /* 不存在：再往上找一层 */ }
      const up = path.dirname(cur);
      if (up === cur) break;
      tail.unshift(path.basename(cur));
      cur = up;
    }
    if (!real) real = abs;
    let s = path.join(real, ...tail).replace(/\\/g, "/").replace(/\/+$/, "");
    return win ? s.toLowerCase() : s;
  };
  const a = norm(parent), b = norm(child);
  return b === a || b.startsWith(a + "/");
}

class GitLayer {
  constructor(wsDir, fileStore) {
    this.dir = wsDir;
    this.fileStore = fileStore;
    this.available = false;  // git 命令 + 是否为仓库
    this.branch = "";
    this.top = "";           // 仓库根绝对路径（工作区是子目录时与 this.dir 不同）
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
        this.top = top;                          // 仓库根：worktree 副本一律开在它下面
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
     push 走网络，_git 默认 15s 太短，这里单独给 60s。
     setUpstream 用于"这个分支还没有上游"的第一次推送（-u 建立跟踪，之后才能直接 pull）。 */
  async push(setUpstream) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库，无法推送" };
    try {
      const remotes = (await _git(this.dir, ["remote"])).trim().split("\n").filter(Boolean);
      if (!remotes.length) return { ok: false, noRemote: true, error: "这个仓库还没有远端（git remote 为空），只能本地提交" };
      const branch = (await _git(this.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      if (!branch || branch === "HEAD") return { ok: false, error: "当前处于游离 HEAD，请先切到一个分支再推送" };
      const remote = remotes.indexOf("origin") >= 0 ? "origin" : remotes[0];
      let out;
      const args = ["push"];
      if (setUpstream) args.push("-u");
      args.push(remote, branch);
      try {
        out = (await _gitSay(this.dir, args, { timeout: 60000 })).trim();
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

  /* ============ P1-B2 · Git 工作流：同步 / 暂存 / 追责 / 回退 ============ */

  /* 分支与上游的现状。单独拿出来是因为"推什么"必须先问清三件事：
     有没有 remote、当前分支是不是游离 HEAD、有没有上游跟踪——
     这三条任缺一样，直接 push 都是一句看不懂的 git 报错。 */
  async branchState() {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    let remotes = [];
    try { remotes = (await _git(this.dir, ["remote"])).trim().split("\n").filter(Boolean); } catch (e) {}
    let branch = "";
    try { branch = (await _git(this.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(); } catch (e) { return { ok: false, error: (e.stderr || e.message || "").toString().slice(0, 300) }; }
    let upstream = "";
    try { upstream = (await _git(this.dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim(); } catch (e) { upstream = ""; }
    let ahead = 0, behind = 0;
    if (upstream) {
      try {
        const counts = (await _git(this.dir, ["rev-list", "--count", "--left-right", "HEAD..." + upstream])).trim().split(/\s+/);
        ahead = parseInt(counts[0], 10) || 0; behind = parseInt(counts[1], 10) || 0;
      } catch (e) {}
    }
    return {
      ok: true, remotes, branch, detached: branch === "HEAD",
      upstream, ahead, behind, canPush: remotes.length > 0 && branch !== "HEAD",
    };
  }

  /* 只读地看清"这次 push 会发生什么"（修 C-L5：原先 push 没有 dry-run，
     第一次点就是真推）。git 的 --dry-run 不做任何写入，输出与真推同形。 */
  async pushDryRun() {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    const st = await this.branchState();
    if (!st.ok) return st;
    if (!st.remotes.length) return { ok: false, noRemote: true, error: "这个仓库没有远端，只能本地提交" };
    if (st.detached) return { ok: false, error: "当前处于游离 HEAD，请先切到分支" };
    const remote = st.remotes.indexOf("origin") >= 0 ? "origin" : st.remotes[0];
    try {
      const out = await _gitSay(this.dir, ["push", "--dry-run", remote, st.branch], { timeout: 60000 });
      const lines = String(out).split(/\r?\n/).filter((l) => l.trim());
      const newBranch = /\[new branch\]/.test(out);
      return { ok: true, dryRun: true, remote, branch: st.branch, upstream: st.upstream, ahead: st.ahead, behind: st.behind, newBranch, report: lines.join(" ").slice(0, 500) };
    } catch (e) {
      const t = ((e.stderr || "") + " " + (e.stdout || "")).toString().trim();
      return { ok: false, error: (t || e.message || "dry-run 失败").slice(0, 300) };
    }
  }

  /* 抓取远端引用，不动工作区（fetch 是这套里唯一可以无条件放心的网络操作） */
  async fetch(remote) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    const st = await this.branchState();
    if (!st.remotes.length) return { ok: false, noRemote: true, error: "没有配置远端（git remote 为空）" };
    const r = String(remote || "").trim();
    if (r && !/^[A-Za-z0-9._\-]{1,40}$/.test(r)) return { ok: false, error: "非法远端名：" + r };
    const target = r || (st.remotes.indexOf("origin") >= 0 ? "origin" : st.remotes[0]);
    try {
      const out = await _gitSay(this.dir, ["fetch", "--prune", target], { timeout: 90000 });
      return { ok: true, remote: target, report: String(out).slice(0, 400) };
    } catch (e) {
      const t = ((e.stderr || "") + " " + (e.stdout || "")).toString().trim();
      return { ok: false, error: (t || e.message || "fetch 失败").slice(0, 300) };
    }
  }

  /* 拉取。刻意只允许 --ff-only：
     merge commit 会替用户做"把两条历史缝起来"这个决定，rebase 会改写已有提交——
     两者都不是 Agent 该在别人的工作目录里顺手做的事。分叉时就如实报分叉。 */
  async pull() {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    const st = await this.branchState();
    if (!st.upstream) return { ok: false, noUpstream: true, error: "当前分支 " + st.branch + " 没有上游跟踪分支，先让用户建立跟踪或指定远端" };
    const ch = await this.changes();
    if (ch.length) return { ok: false, dirty: true, error: "工作区有 " + ch.length + " 个未提交改动，先提交或 git_stash 起来再拉（否则 pull 会半途拒绝、留下混乱状态）" };
    try {
      const out = await _gitSay(this.dir, ["pull", "--ff-only"], { timeout: 90000 });
      this.branch = (await _git(this.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      return { ok: true, ffOnly: true, report: String(out).split(/\r?\n/).slice(0, 12).join("\n").slice(0, 800) };
    } catch (e) {
      const t = ((e.stderr || "") + " " + (e.stdout || "")).toString().trim();
      if (/Not possible to fast-forward|divergent branches/i.test(t)) {
        /* 数字要重新问一遍：pull 自己已经 fetch 过了，方法开头那份 branchState 是拉取之前的现状，
           拿它回报"落后 0"会把一个真分叉说成"本地只是领先"——用户据此决定的可是要不要合并历史。 */
        const fresh = await this.branchState();
        const ahead = fresh.ok ? fresh.ahead : st.ahead, behind = fresh.ok ? fresh.behind : st.behind;
        return { ok: false, diverged: true, ahead, behind, error: "本地与远端已分叉（本地领先 " + ahead + "、落后 " + behind + "）。合并或改历史需要用户自己做，Agent 不代为决定。" };
      }
      return { ok: false, error: (t || e.message || "pull 失败").slice(0, 300) };
    }
  }

  /* 暂存栈：push / pop / list / apply / drop。
     存在的意义是让"先拉最新代码再改"这类动作不必拿用户的未提交改动去冒险。 */
  async stash(action, message) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    const a = String(action || "list").toLowerCase();
    /* 没有 clear：一次误触就把用户所有历史暂存抹掉，而这从来不是"往下推进任务"需要的动作。 */
    if (["push", "pop", "list", "apply", "drop"].indexOf(a) < 0) return { ok: false, error: "git_stash 只支持 push / pop / list / apply / drop，收到：" + a };
    const args = ["stash"];
    if (a === "push") { args.push("push", "-u"); const m = String(message || "").slice(0, 200); if (m) args.push("-m", m); }
    else if (a === "list") args.push("list");
    else args.push(a);                       // pop / apply / drop —— 默认作用于栈顶
    if (a === "push" && !(await this.changes()).length) return { ok: false, empty: true, error: "没有可暂存的改动" };
    try {
      const out = await _gitSay(this.dir, args);
      const list = a === "list" ? String(out).trim().split(/\r?\n/).filter(Boolean) : null;
      return { ok: true, action: a, report: String(out).slice(0, 500), list };
    } catch (e) {
      const t = ((e.stderr || "") + " " + (e.stdout || "")).toString().trim();
      return { ok: false, error: (t || e.message || "stash 失败").slice(0, 300) };
    }
  }

  /* 逐行追责：这段代码是谁在哪次提交动过的。
     模型改别人的逻辑前最需要这个上下文（改完跑挂了，得知道原作者的意图在哪个提交里）。 */
  async blame(rel, line1, line2) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    const p = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!p) return { ok: false, error: "blame 需要文件路径" };
    const from = Math.max(1, parseInt(line1, 10) || 1);
    const to = Math.max(from, parseInt(line2, 10) || from + 20);
    if (to - from > 120) return { ok: false, error: "一次最多看 120 行（当前 " + (to - from + 1) + " 行）" };
    try {
      const out = await _git(this.dir, ["blame", "--line-porcelain", "-L", from + "," + to, "--", p], { timeout: 30000 });
      const lines = String(out).split(/\r?\n/);
      /* --line-porcelain 每条记录是"表头行 + 元数据行 + 内容行"，元数据行不带 sha 前缀
         （"author Tom" / "author-time 1730..." / "summary init"）。
         早先按 l.slice(0,8) 反查归属，等于拿 "author T" 去查 sha 表 —— 永远查不到，
         于是这个工具输出的是"一列 sha + 一串问号"，作者和提交说明全丢（探针实测抓到）。
         改成"表头开一段，后续元数据归这一段"，与 porcelain 的排版一致。 */
      const bySha = new Map();
      const order = [];
      let cur = null;
      for (const l of lines) {
        const m = /^([0-9a-f]{40}) \d+ \d+/.exec(l);
        if (m) {
          const short = m[1].slice(0, 8);
          cur = bySha.get(short);
          if (!cur) { cur = { sha: short }; bySha.set(short, cur); order.push(cur); }
          continue;
        }
        if (!cur) continue;
        let mm;
        if ((mm = /^author (.+)/.exec(l))) cur.author = mm[1];
        else if ((mm = /^author-time (\d+)/.exec(l))) cur.ts = parseInt(mm[1], 10);
        else if ((mm = /^summary (.+)/.exec(l))) cur.summary = mm[1];
      }
      const commits = order.slice(0, 20);
      return { ok: true, path: p, from, to, commits };
    } catch (e) {
      const t = ((e.stderr || "") + " " + (e.stdout || "")).toString().trim();
      return { ok: false, error: (t || e.message || "blame 失败").slice(0, 300) };
    }
  }

  /* 回退指针。只放 soft / mixed ——
     --hard 会连工作区一起抹掉，用户没保存的改动当场消失，这不是 Agent 该按的一个键。
     目标也只收提交引用，不接受任何带 - 开头的开关，避免把参数当成引用注入。 */
  async reset(mode, target) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    const m = String(mode || "mixed").toLowerCase();
    if (m === "hard") return { ok: false, refused: true, error: "Agent 不能执行 git reset --hard：它会抹掉工作区里未提交的改动。这一步必须用户自己做。" };
    if (["soft", "mixed"].indexOf(m) < 0) return { ok: false, error: "只支持 soft / mixed，收到：" + m };
    const t = String(target || "").trim();
    if (!t) return { ok: false, error: "reset 需要一个目标提交（如 HEAD~1）" };
    if (/^-/.test(t) || !/^[\w.\-/~^{}+]{1,80}$/.test(t)) return { ok: false, error: "非法提交引用：" + t };
    try {
      let shaBefore = "";
      try { shaBefore = (await _git(this.dir, ["rev-parse", "HEAD"])).trim(); } catch (e) {}
      await _git(this.dir, ["reset", "--" + m, t]);
      const shaAfter = (await _git(this.dir, ["rev-parse", "HEAD"])).trim();
      return { ok: true, mode: m, from: shaBefore.slice(0, 8), to: shaAfter.slice(0, 8), keptFiles: m === "soft" ? "改动全部保留在暂存区" : "改动保留在工作区（未暂存）" };
    } catch (e) {
      const err = (e.stderr || e.stdout || e.message || "").toString().slice(0, 300);
      return { ok: false, error: err };
    }
  }

  /* 删分支。未合并的分支默认拒——删掉一条还没进主干的分支等于删掉没人看过的代码。 */
  async deleteBranch(name, force) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    const b = String(name || "").trim();
    if (!/^[A-Za-z0-9._\-/]{1,80}$/.test(b) || b.startsWith("-") || b.includes("..")) return { ok: false, error: "非法分支名：" + b };
    if (b === this.branch) return { ok: false, error: "不能删除当前所在分支 " + b + "，先切走" };
    if (!force) {
      try {
        const merged = (await _git(this.dir, ["branch", "--merged", "HEAD", "--list", b])).trim();
        if (!merged) return { ok: false, unmerged: true, error: "分支 " + b + " 还没合并进当前分支。确认要删请显式带 force。" };
      } catch (e) {}
    }
    try {
      const out = await _gitSay(this.dir, ["branch", force ? "-D" : "-d", b]);
      return { ok: true, branch: b, forced: !!force, report: String(out).slice(0, 200) };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.stdout || e.message || "").toString().slice(0, 300) };
    }
  }

  /* ============ P-M1 · worktree 隔离副本 ============
     为什么是 worktree，而不是"切个分支"或"再克隆一份"：
       · 切分支带不走两份现实——一个工作树只有一个 HEAD，用户当前未提交的改动会被一起卷进新分支；
       · 克隆一份要重下全部对象、另配 remote，还要重新授权一个新目录当工作根；
       · worktree 与主检出共享同一个对象库，开一份只是多一个目录：两边改动互不可见，
         主工作区照常跑它的服务，Agent 在副本里放手改。
     副本一律落在 <仓库根>/.worktrees/<名字> 下：仓库内意味着它天然落在已授权根之内，
     不需要为它新开一次目录授权；点开头又让 FileStore / 代码索引按设计跳过它，
     不会把副本里的文件当成"本项目的另一份同名文件"混进搜索结果。 */
  /* 共享的那份 .git。linked worktree 里 `rev-parse --git-dir` 给的是 .git/worktrees/<名>，
     而排除表与 .worktrees 的落点都必须认公共的那一份，否则会出现
     "在副本里开副本"（<repo>/.worktrees/live/.worktrees/xxx）这种荒谬路径。
     结果缓存住：这是请求路径上的同步子进程，一次挂载问一回就够。 */
  _commonGitDir() {
    if (this._commonCache !== undefined) return this._commonCache;
    let d = "";
    try {
      d = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: this.dir, encoding: "utf8", timeout: 8000, windowsHide: true,
      }).trim();
    } catch (e) { d = ""; }
    this._commonCache = d ? path.resolve(this.dir, d) : "";
    return this._commonCache;
  }

  /* 仓库主检出的根目录 = 公共 .git 的上一层 */
  _mainRoot() {
    const c = this._commonGitDir();
    if (c) return path.resolve(c, "..");
    return path.resolve(this.top || this.dir);
  }

  /* 仓库本地的排除表（.git/info/exclude）里补一行 .worktrees/。
     不补的话 git status 从此永远报一条 "?? .worktrees/" —— 用户的改动面板凭空多一条假改动，
     而且 git_commit 的 -A 会把整个副本提交进仓库。
     写 exclude 而不是写 .gitignore：exclude 是仓库本地文件，"开个副本"不该在用户的
     版本库里产生一条待提交的改动。 */
  _excludeWorktrees() {
    try {
      const info = path.join(this._commonGitDir() || path.resolve(this.dir, ".git"), "info");
      fs.mkdirSync(info, { recursive: true });
      const f = path.join(info, "exclude");
      let raw = "";
      try { raw = fs.readFileSync(f, "utf8"); } catch (e) {}
      if (raw.split(/\r?\n/).some((l) => l.trim() === WORKTREE_DIR + "/")) return true;
      fs.writeFileSync(f, (raw && !/\n$/.test(raw) ? raw + "\n" : raw) + "\n" + WORKTREE_DIR + "/\n", "utf8");
      return true;
    } catch (e) { return false; }
  }

  /* worktree list --porcelain 的块状输出 → 结构化清单。
     第一条就是主检出（共享 .git 的那份），据此标 main；current 用"当前工作区是否落在它里面"，
     因为工作区可能是仓库的子目录，直接比相等会漏。 */
  async worktrees() {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    try {
      const raw = await _git(this.dir, ["worktree", "list", "--porcelain"]);
      const list = [];
      let cur = null;
      for (const line of String(raw).split(/\r?\n/)) {
        if (!line.trim()) { if (cur) list.push(cur); cur = null; continue; }
        const sp = line.indexOf(" ");
        const key = sp < 0 ? line.trim() : line.slice(0, sp);
        const val = sp < 0 ? "" : line.slice(sp + 1).trim();
        if (key === "worktree") cur = { path: path.resolve(val) };
        else if (!cur) continue;
        else if (key === "HEAD") cur.head = val.slice(0, 8);
        else if (key === "branch") cur.branch = val.replace(/^refs\/heads\//, "");
        else if (key === "bare") cur.bare = true;
        else if (key === "detached") cur.detached = true;
      }
      if (cur) list.push(cur);
      const mainPath = list.length ? list[0].path : "";
      const out = list.map((w, i) => Object.assign({}, w, {
        main: i === 0 || sameDir(w.path, mainPath),
        current: false,
        exists: fs.existsSync(w.path),
      }));
      /* current 只能有一份。副本就开在主检出的目录里面（.worktrees/），
         于是"工作区在这份的路径之下"对主检出和副本同时成立 —— 直接按包含关系标会出现
         工作区已经切进副本、主检出那行却还挂着「当前工作区在这份里」。
         取路径最长（最具体）的那一份。 */
      let best = null;
      for (const w of out) {
        if (!dirContains(w.path, this.dir)) continue;
        if (!best || w.path.length > best.path.length) best = w;
      }
      if (best) best.current = true;
      return { ok: true, worktrees: out, dir: WORKTREE_DIR, repoRoot: this._mainRoot() };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.stdout || e.message || "").toString().slice(0, 300) };
    }
  }

  /* 开一份独立副本。名字既是分支名也是目录名，所以按最严的那个形状校验：
     放开 / 或 .. 等于允许把目录建到仓库外的任何位置（这个路径会直接交给 git 落盘）。 */
  async addWorktree(name, opts) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    const n = String(name || "").trim();
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(n) || n === "." || n === ".." || n.startsWith("-")) {
      return { ok: false, error: "副本名只能用字母、数字、点、下划线、短横（1–40 位），收到：" + n };
    }
    const root = this._mainRoot();
    const dest = path.resolve(root, WORKTREE_DIR, n);
    if (!dirContains(root, dest)) return { ok: false, error: "副本目录会落到仓库外面，已拒绝：" + dest };
    if (fs.existsSync(dest)) return { ok: false, error: "这个名字的副本已经存在，换一个或先移除：" + dest };
    const base = String((opts && opts.base) || "").trim();
    /* 基线是"提交引用"而不是分支名，HEAD~1 / v1.2^{} 这种形状必须放行 ——
       判据与 git_reset 用同一把尺子（首字符不许是 -，也不许有 ..）。 */
    if (base && (/^-/.test(base) || base.includes("..") || !/^[\w.\-/~^{}+]{1,80}$/.test(base))) {
      return { ok: false, error: "非法基线引用：" + base };
    }
    let hasBranch = false;
    try { await _git(this.dir, ["rev-parse", "--verify", "--quiet", "refs/heads/" + n]); hasBranch = true; } catch (e) {}
    try {
      /* 已有同名分支就直接检出它（一条分支同时只能被一个 worktree 检出，git 会自己拒绝撞车的）；
         没有才 -b 新建，基线缺省是当前 HEAD。 */
      const args = hasBranch
        ? ["worktree", "add", dest, n]
        : ["worktree", "add", "-b", n, dest].concat(base ? [base] : []);
      const report = await _gitSay(this.dir, args);
      this._excludeWorktrees();
      return {
        ok: true, path: dest, branch: n, reusedBranch: hasBranch, base: base || "HEAD",
        worktreeDir: WORKTREE_DIR, report: String(report).slice(0, 300),
      };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.stdout || e.message || "").toString().slice(0, 300) };
    }
  }

  /* 移除副本。git 自己在有未提交/未跟踪文件时会拒（返回 dirty 让上层问一句要不要强删），
     这里再加两道本层才有的闸：只准删 .worktrees 下面的（主检出一律碰不到），
     以及当前正在用的那份不许删（删自己 = 把工作区从脚下抽走）。 */
  async removeWorktree(target, force) {
    if (!this.available) return { ok: false, error: "当前工作区不是 Git 仓库" };
    const raw = String(target || "").trim();
    if (!raw) return { ok: false, error: "要移除哪个副本？给名字或路径" };
    const root = this._mainRoot();
    const dest = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, WORKTREE_DIR, raw);
    if (!dirContains(path.resolve(root, WORKTREE_DIR), dest)) {
      return { ok: false, error: "只允许移除 " + WORKTREE_DIR + "/ 下的副本，收到：" + dest };
    }
    if (dirContains(dest, this.dir)) return { ok: false, error: "当前工作区就在这份副本里，先切走再移除" };
    if (!fs.existsSync(dest)) {
      try { await _git(this.dir, ["worktree", "prune"]); } catch (e) {}
      return { ok: false, gone: true, error: "目录已经不在了（可能被手工删了），登记信息已顺手清理：" + dest };
    }
    try {
      const report = await _gitSay(this.dir, force ? ["worktree", "remove", "--force", dest] : ["worktree", "remove", dest]);
      const parent = path.resolve(root, WORKTREE_DIR);
      try { if (fs.existsSync(parent) && !fs.readdirSync(parent).length) fs.rmdirSync(parent); } catch (e) {}
      return { ok: true, removed: dest, forced: !!force, report: String(report).slice(0, 200) };
    } catch (e) {
      const err = (e.stderr || e.stdout || e.message || "").toString().slice(0, 300);
      return { ok: false, dirty: /use --force/.test(err), error: err };
    }
  }
}

module.exports = { GitLayer, sameDir, dirContains, isHomeRepo, isIgnoredHere, WORKTREE_DIR };
