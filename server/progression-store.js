/* ============================================================
   进度持久化：仅保存"用户主动设定"的部分（进化路线 path）。
   XP / 阶段 / 属性 等都由数据推导，不持久化，保证可重算、不漂移。
   存储：.pancode/progression/{workspaceHash}.json
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const DEFAULT = { path: null };

class ProgressionStore {
  constructor(filePath) {
    this._path = filePath;
    this._data = null;
    this._load();
  }
  _load() {
    try { this._data = JSON.parse(fs.readFileSync(this._path, "utf8")); }
    catch (e) { this._data = JSON.parse(JSON.stringify(DEFAULT)); }
    if (this._data.path === undefined) this._data.path = null;
  }
  _save() {
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2), "utf8");
    } catch (e) {}
  }
  get() { return JSON.parse(JSON.stringify(this._data)); }
  setPath(p) {
    this._data.path = (p && typeof p === "string" && p.trim()) ? p.trim() : null;
    this._save();
    return this.get();
  }
}

module.exports = { ProgressionStore };
