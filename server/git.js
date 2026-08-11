/* ============================================================
   pancode Git 层 —— 对齐 VS Code 源代码管理
   - 工作区若是 Git 仓库：Diff 基线 = HEAD 版本，状态 = git status
   - 不是 Git 仓库 / 未安装 git：自动降级为启动时内存快照
   ============================================================ */
"use strict";
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

class GitLayer {
  constructor(wsDir, fileStore) {
    this.dir = wsDir;
    this.fileStore = fileStore;
    this.available = false;  // git 命令 + 是否为仓库
    this.branch = "";
    this.snapshot = {};      // 降级方案：启动时快照
    this._init();
  }

  _git(args, opts) {
    return execFileSync("git", args, Object.assign({
      cwd: this.dir, encoding: "utf8", timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    }, opts));
  }

  _init() {
    try {
      // 仅当 workspace 自身是 git 仓库根（而非其上级仓库的子目录）才算可用——
      // 否则会误把父仓库的 status/changes 当作 workspace 的（子目录被 .gitignore 忽略时尤其致命）。
      const inside = this._git(["rev-parse", "--is-inside-work-tree"]).trim();
      const top = inside === "true" ? this._git(["rev-parse", "--show-toplevel"]).trim() : "";
      if (inside === "true" && path.resolve(top) === path.resolve(this.dir)) {
        this.available = true;
        try { this.branch = this._git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(); }
        catch (e) { this.branch = "main"; }
      }
    } catch (e) { this.available = false; }
    // 无论是否有 git，都保留一份快照兜底（git 仓库中未跟踪文件也需要基线）
    for (const rel of this.fileStore.list()) {
      try { this.snapshot[rel] = this.fileStore.read(rel); } catch (e) {}
    }
  }

  /* 取某文件的 diff 基线内容；null 表示新增文件（无基线） */
  baseline(rel) {
    if (this.available) {
      const r = spawnSync("git", ["show", "HEAD:" + rel], {
        cwd: this.dir, encoding: "utf8", timeout: 8000,
      });
      if (r.status === 0) return r.stdout;
      // HEAD 中不存在（新文件）→ 尝试快照，再没有就是全新文件
      return this.snapshot[rel] !== undefined ? this.snapshot[rel] : null;
    }
    return this.snapshot[rel] !== undefined ? this.snapshot[rel] : null;
  }

  /* 变更列表：[{path, status}]  status: M 修改 / A 新增 / D 删除 */
  changes() {
    const out = [];
    if (this.available) {
      let txt = "";
      try { txt = this._git(["status", "--porcelain", "-uall"]); } catch (e) { return out; }
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
    // 快照比对降级
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
  discardAll() {
    if (this.available) {
      try {
        this._git(["checkout", "--", "."]);
        this._git(["clean", "-fd"]);
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

  info() {
    return { git: this.available, branch: this.available ? this.branch : "无 Git（快照模式）" };
  }
}

module.exports = { GitLayer };
