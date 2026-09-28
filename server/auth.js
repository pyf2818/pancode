/* ============================================================
   用户认证系统 - 注册 / 登录 / 会话管理
   存储：数据根 .pancode/users.json（与 config.ROOT 同源，打包态由桌面端注入 PANCODE_DATA_DIR）
   密码：scrypt（异步，避免阻塞事件循环）+ 随机 salt，比对走 timingSafeEqual
   会话：token → .pancode/sessions.json 持久化。
        旧实现只把会话放在内存 Map 里，服务一重启所有 token 作废 →
        前端 localStorage 里的"记住我"变成一张废票，用户每次重启都要重新登录。
        现在会话落盘 + 30 天滑动过期，重启后仍然认得你。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const safeWrite = require("./safe-write");

const DATA_ROOT = require("./config").ROOT;
const USERS_FILE = path.join(DATA_ROOT, ".pancode", "users.json");
const SESS_FILE = path.join(DATA_ROOT, ".pancode", "sessions.json");

const SESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 天不用才失效
const TOUCH_PERSIST_MS = 60 * 60 * 1000;        // 活跃期最多每小时落一次盘，避免每次请求都写文件
const USER_RE = /^[^<>:"/\\|?*\u0000-\u001f]{2,32}$/;

const sessions = new Map(); // token -> { username, ts, lastSeen }

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}
function loadUsers() { return readJson(USERS_FILE) || {}; }
/* 返回落盘 promise：注册必须等写完成再回话——hasUsers / 重名检查都是读盘判定，
   异步未落盘就返回会让同一秒内的第二次同名注册也"成功"。 */
function saveUsers(users) { return safeWrite.saveJson(USERS_FILE, users); }

/* 会话落盘。
   关键：登录 / 登出 / 删用户必须"等写完再回话"——旧写法带 500ms 合并窗，
   用户注册完立刻关窗口（Electron 常态）就永远丢了这个会话，下次开机又要重新登录。
   只有 verify 里的滑动续期才用合并窗（那是每小时一次的后台动作，丢了无害）。 */
function snapshot() {
  const out = {};
  const now = Date.now();
  for (const [tok, s] of sessions) { if (s && now - s.ts < SESS_TTL_MS) out[tok] = s; }
  return out;
}
function writeSessions() { return safeWrite.saveJson(SESS_FILE, snapshot()); }
let _sessTimer = null;
function touchPersist() {
  if (_sessTimer) return;
  _sessTimer = setTimeout(() => { _sessTimer = null; writeSessions().catch(() => {}); }, 500);
  if (_sessTimer.unref) _sessTimer.unref();
}
/* 进程退出前的同步兜底：不等异步队列，直接把当前会话写下去 */
function flushSessions() {
  try {
    fs.mkdirSync(path.dirname(SESS_FILE), { recursive: true });
    fs.writeFileSync(SESS_FILE, JSON.stringify(snapshot(), null, 2), "utf8");
    return true;
  } catch (e) { return false; }
}
function loadSessions() {
  const disk = readJson(SESS_FILE);
  if (!disk || typeof disk !== "object") return;
  const now = Date.now();
  for (const tok of Object.keys(disk)) {
    const s = disk[tok];
    if (!s || !s.username || !s.ts || now - s.ts > SESS_TTL_MS) continue;
    sessions.set(tok, { username: String(s.username), ts: Number(s.ts), lastSeen: Number(s.lastSeen) || Number(s.ts) });
  }
}
loadSessions();

function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    // 同步版 scryptSync 单次 ~80-150ms，会把整个服务卡住（本地工具上就是一次"点了没反应"）
    crypto.scrypt(password, salt, 64, (err, buf) => (err ? reject(err) : resolve(buf.toString("hex"))));
  });
}
function genSalt() { return crypto.randomBytes(16).toString("hex"); }
function genToken() { return crypto.randomBytes(24).toString("hex"); }
function safeEq(a, b) {
  const ba = Buffer.from(String(a), "hex"), bb = Buffer.from(String(b), "hex");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function validate(username, password) {
  if (!username) return "请填写用户名";
  if (!USER_RE.test(username)) return "用户名需为 2-32 个字符，不能含 < > : \" / \\ | ? * 与控制字符";
  if (!password || password.length < 4) return "密码至少 4 个字符";
  if (password.length > 128) return "密码最长 128 个字符";
  return null;
}

function newSession(username) {
  const token = genToken();
  const now = Date.now();
  sessions.set(token, { username, ts: now, lastSeen: now });
  return token;
}

async function register(username, password) {
  const bad = validate(username, password);
  if (bad) return { ok: false, error: bad };
  const users = loadUsers();
  if (users[username]) return { ok: false, error: "用户名已存在，直接登录即可" };
  const salt = genSalt();
  let hash;
  try { hash = await hashPassword(password, salt); } catch (e) { return { ok: false, error: "密码处理失败：" + e.message }; }
  users[username] = { salt, hash, ts: Date.now() };
  const token = newSession(username);
  // 账号与会话都落盘完成后才回话，客户端拿到 token 的那一刻起它就是可恢复的
  await Promise.all([saveUsers(users), writeSessions()]);
  return { ok: true, token, username };
}

/* ---------- 登录 ---------- */
async function login(username, password) {
  const users = loadUsers();
  const u = users[String(username || "")];
  if (!u) return { ok: false, error: "用户名或密码错误", noUser: true };
  let hash;
  try { hash = await hashPassword(String(password || ""), u.salt); } catch (e) { return { ok: false, error: "登录处理失败：" + e.message }; }
  if (!safeEq(hash, u.hash)) return { ok: false, error: "用户名或密码错误" };
  const token = newSession(username);
  await writeSessions();
  return { ok: true, token, username };
}

/* ---------- 验证会话（每次请求都会走，保持纯内存 O(1)） ---------- */
function verify(token) {
  if (!token) return null;
  const s = sessions.get(String(token));
  if (!s) return null;
  const now = Date.now();
  if (now - s.ts > SESS_TTL_MS) { sessions.delete(String(token)); touchPersist(); return null; }
  // 滑动续期：跨小时才合并落一次盘，活跃会话不会被 30 天期限悄悄切掉
  if (now - s.lastSeen > TOUCH_PERSIST_MS) { s.lastSeen = now; s.ts = now; touchPersist(); }
  else s.lastSeen = now;
  return s;
}

/* ---------- 登出 ---------- */
function logout(token) {
  const had = sessions.delete(String(token || ""));
  if (had) writeSessions().catch(() => {});
  return had;
}

/* ---------- 是否有用户 ---------- */
function hasUsers() { return Object.keys(loadUsers()).length > 0; }

/* ---------- 用户列表（账户管理面板用，绝不返回 salt / hash） ---------- */
function listUsers() {
  const users = loadUsers();
  return Object.keys(users).map((name) => ({
    username: name,
    ts: users[name] && users[name].ts || 0,
    activeSessions: [...sessions.values()].filter((s) => s && s.username === name).length,
  })).sort((a, b) => b.ts - a.ts);
}

/* ---------- 删除用户 ----------
   同时吊销该用户名下的所有会话。找不到用户返回 false。异步：等盘写完再回话。 */
async function removeUser(username) {
  const users = loadUsers();
  if (!username || !users[username]) return false;
  delete users[username];
  for (const [tok, s] of sessions) if (s && s.username === username) sessions.delete(tok);
  touchPersist();
  const r = await saveUsers(users);
  return r !== false;
}

/* 定时清扫过期会话（避免长期未用的 token 永驻内存与磁盘，A4） */
const _sessSweep = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [tok, s] of sessions) {
    if (!s || now - s.ts > SESS_TTL_MS) { sessions.delete(tok); changed = true; }
  }
  if (changed) writeSessions().catch(() => {});
}, 30 * 60 * 1000);
if (_sessSweep && _sessSweep.unref) _sessSweep.unref();

module.exports = { register, login, verify, logout, hasUsers, removeUser, listUsers, flushSessions, USERS_FILE, SESS_FILE };
