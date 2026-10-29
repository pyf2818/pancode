/* ============================================================
   pancode-cli · 工作区分片键（自包含版）
   md5(规范化绝对路径) → 唯一分片键
   ============================================================ */
"use strict";
const crypto = require("crypto");
const path = require("path");

const IS_WIN = process.platform === "win32";

function md5(s) { return crypto.createHash("md5").update(s).digest("hex"); }

function normalizeDir(p, root) {
  let abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root || process.cwd(), p);
  abs = abs.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(abs)) abs += path.sep;
  return IS_WIN ? abs.toLowerCase() : abs;
}

function shardKey(p, root) { return md5(normalizeDir(p, root)); }

module.exports = { shardKey, normalizeDir };
