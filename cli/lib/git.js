/* ============================================================
   pancode-cli · Git 操作层（自包含版）
   - diff / status / checkout / clean
   ============================================================ */
"use strict";
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

class GitLayer {
  constructor(root) {
    this.root = path.resolve(root);
    this.enabled = fs.existsSync(path.join(this.root, ".git"));
  }

  _run(args) {
    if (!this.enabled) return "";
    try {
      return execSync("git " + args, {
        cwd: this.root,
        encoding: "utf8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (e) {
      return "";
    }
  }

  status() {
    if (!this.enabled) return { enabled: false };
    const out = this._run("status --porcelain");
    const files = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2).trim();
      const file = line.slice(3).trim();
      files.push({ status, file });
    }
    return { enabled: true, files };
  }

  diff() {
    if (!this.enabled) return "";
    return this._run("diff HEAD");
  }

  diffFile(relPath) {
    if (!this.enabled) return "";
    return this._run("diff HEAD -- " + JSON.stringify(relPath));
  }

  checkout(relPath) {
    if (!this.enabled) return false;
    this._run("checkout -- " + JSON.stringify(relPath));
    return true;
  }

  clean() {
    if (!this.enabled) return false;
    this._run("clean -fd");
    return true;
  }

  isClean() {
    if (!this.enabled) return true;
    return this._run("status --porcelain") === "";
  }
}

module.exports = { GitLayer };
