/* ============================================================
   用户认证系统 - 注册 / 登录 / 会话管理
   存储：.pancode/users.json
   密码：SHA-256 + salt（本机工具，无需 bcrypt 重量级依赖）
   会话：token 随机生成，存入内存 Map（重启失效）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const USERS_FILE = path.join(__dirname, "..", ".pancode", "users.json");
const sessions = new Map(); // token -> { username, ts }

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch (e) { return {}; }
}
function saveUsers(users) {
  try {
    fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (e) {}
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function genSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function genToken() {
  return crypto.randomBytes(24).toString("hex");
}

/* ---------- 注册 ---------- */
function register(username, password) {
  if (!username || username.length < 2) return { ok: false, error: "用户名至少 2 个字符" };
  if (!password || password.length < 4) return { ok: false, error: "密码至少 4 个字符" };
  const users = loadUsers();
  if (users[username]) return { ok: false, error: "用户名已存在" };
  const salt = genSalt();
  users[username] = { salt, hash: hashPassword(password, salt), ts: Date.now() };
  saveUsers(users);
  const token = genToken();
  sessions.set(token, { username, ts: Date.now() });
  return { ok: true, token, username };
}

/* ---------- 登录 ---------- */
function login(username, password) {
  const users = loadUsers();
  const u = users[username];
  if (!u) return { ok: false, error: "用户名或密码错误" };
  if (hashPassword(password, u.salt) !== u.hash) return { ok: false, error: "用户名或密码错误" };
  const token = genToken();
  sessions.set(token, { username, ts: Date.now() });
  return { ok: true, token, username };
}

/* ---------- 验证会话 ---------- */
function verify(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  // 24 小时过期
  if (Date.now() - s.ts > 24 * 60 * 60 * 1000) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/* ---------- 登出 ---------- */
function logout(token) {
  return sessions.delete(token);
}

/* ---------- 是否有用户 ---------- */
function hasUsers() {
  return Object.keys(loadUsers()).length > 0;
}

/* 定时清扫过期会话（避免未登录 / 长期未活动 token 永驻内存，A4） */
const _sessSweep = setInterval(() => {
  const now = Date.now();
  for (const [tok, s] of sessions) {
    if (!s || now - s.ts > 24 * 60 * 60 * 1000) sessions.delete(tok);
  }
}, 10 * 60 * 1000);
if (_sessSweep && _sessSweep.unref) _sessSweep.unref();

module.exports = { register, login, verify, logout, hasUsers };
