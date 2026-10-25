/* ============================================================
   用户认证系统 - 注册 / 登录 / 会话管理
   存储：数据根 .pancode/users.json（与 config.ROOT 同源，打包态由桌面端注入 PANCODE_DATA_DIR）
   密码：scrypt（异步，避免阻塞事件循环）+ 随机 salt，比对走 timingSafeEqual
   会话：token → .pancode/sessions.json 持久化。
        旧实现只把会话放在内存 Map 里，服务一重启所有 token 作废 →
        前端 localStorage 里的"记住我"变成一张废票，用户每次重启都要重新登录。
        现在会话落盘 + 30 天滑动过期，重启后仍然认得你。
         落盘的 key 是 token 的哈希而不是 token 本身：拿到 sessions.json
         （备份、同步盘、误传、以后接上的任何"导出诊断"功能）不等于拿到可用凭据。
         哈希只在本机 auth.js 里算，没有别的用处，本身不是可撤销凭据。
   ============================================================ */
"use strict";
const fs = require("fs");
const log = require("./logger");
const path = require("path");
const crypto = require("crypto");
const safeWrite = require("./safe-write");

const DATA_ROOT = require("./config").ROOT;
const USERS_FILE = path.join(DATA_ROOT, ".pancode", "users.json");
const SESS_FILE = path.join(DATA_ROOT, ".pancode", "sessions.json");

const SESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 天不用才失效
const TOUCH_PERSIST_MS = 60 * 60 * 1000;        // 活跃期最多每小时落一次盘，避免每次请求都写文件
const USER_RE = /^[^<>:"/\\|?*\u0000-\u001f]{2,32}$/;

/* 内存表的 key 是 token 的哈希，不是 token 本身。
   落盘与内存用同一个 key，所以重启后认得旧 token；读 sessions.json 的人拿到的
   是一堆 sha256，没有 token 就无法构造出任何一次可用的请求。

   为什么是普通 sha256 而不是加 pepper 或慢哈希：
   - 加 pepper 会直接毁掉这个功能本身。pepper 得存在某个进程能读到的地方，
     换进程就换一个值，重启后算出来的 key 全对不上，"记住我"又变废票
     （而重启不掉登录恰恰是 sessions.json 存在的唯一理由）。
   - 慢哈希（bcrypt/scrypt）会把这张表从 O(1) 热路径变成每次 API 调用 80ms+。
   - 这两者要防的其实都不是"读到这个文件的人"。token 是 192 位随机数（genToken），
     没有可字典可猜的东西，离线爆破不存在；真正要防的就是"文件本身就是凭据"，sha256 已经切断。 */
function tokenKey(tok) {
  return crypto.createHash("sha256").update(String(tok)).digest("hex");
}

const sessions = new Map(); // tokenKey(token) -> { username, ts, lastSeen }

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
  for (const [key, s] of sessions) { if (s && now - s.ts < SESS_TTL_MS) out[key] = s; }
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
  for (const key of Object.keys(disk)) {
    const s = disk[key];
    if (!s || !s.username || !s.ts || now - s.ts > SESS_TTL_MS) continue;
    /* 盘上的是哈希，直接当 key 收下 —— 不在这里再算一次 sha256，
       那样等于对哈希再哈希一次，两边对不上，所有旧会话当场全废。 */
    sessions.set(key, { username: String(s.username), ts: Number(s.ts), lastSeen: Number(s.lastSeen) || Number(s.ts) });
  }
}
/* 盘上如果还是旧格式（key 就是 token 本身），读回来的会话要就地转成哈希。
   不转的话用户升级后会静默掉线一次（token 还留在老 token 的位置上，
   而 verify 只按哈希找），"记住我"变成废票 —— 这正是 sessions.json 最初要避免的事。
   转完立刻重写一次盘，转换只发生一次。 */
function migratePlainKeys() {
  const disk = readJson(SESS_FILE);
  if (!disk || typeof disk !== "object") return;
  const KEY_RE = /^[0-9a-f]{64}$/;
  const plain = Object.keys(disk).filter((k) => !KEY_RE.test(k));
  if (!plain.length) return;
  const now = Date.now();
  const rebuilt = {};
  for (const key of Object.keys(disk)) {
    const s = disk[key];
    if (!s || !s.username || !s.ts || now - s.ts > SESS_TTL_MS) continue;
    rebuilt[KEY_RE.test(key) ? key : tokenKey(key)] =
      { username: String(s.username), ts: Number(s.ts), lastSeen: Number(s.lastSeen) || Number(s.ts) };
  }
  sessions.clear();
  for (const [key, s] of Object.entries(rebuilt)) sessions.set(key, s);
  log.tag("auth").info("已把 " + plain.length + " 个旧格式会话（明文 token）就地改为哈希存储");
  /* 同步落盘，不走异步队列：这次转换的目的是"盘上不再有明文 token"，
     走异步就存在一个窗口 —— 迁移完成后进程若被杀，明文还留在盘上。 */
  try {
    fs.mkdirSync(path.dirname(SESS_FILE), { recursive: true });
    fs.writeFileSync(SESS_FILE, JSON.stringify(rebuilt, null, 2), "utf8");
  } catch (e) {
    /* 写不下去不算致命：内存里已经是哈希形态，本进程内验签正常。
       下次启动还会再迁移一次。不能在这里抛 —— 会把整个服务拖不起来。 */
    log.tag("auth").error("会话迁移后的重写失败（内存中已是哈希形态，下次启动会重试）：" + e.message);
  }
}
loadSessions();
migratePlainKeys();

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
  sessions.set(tokenKey(token), { username, ts: now, lastSeen: now });
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
  const key = tokenKey(token);
  const s = sessions.get(key);
  if (!s) return null;
  const now = Date.now();
  if (now - s.ts > SESS_TTL_MS) { sessions.delete(key); touchPersist(); return null; }
  // 滑动续期：跨小时才合并落一次盘，活跃会话不会被 30 天期限悄悄切掉
  if (now - s.lastSeen > TOUCH_PERSIST_MS) { s.lastSeen = now; s.ts = now; touchPersist(); }
  else s.lastSeen = now;
  return s;
}

/* ---------- 登出 ---------- */
function logout(token) {
  const had = !!(token && sessions.delete(tokenKey(token)));
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
  for (const [key, s] of sessions) if (s && s.username === username) sessions.delete(key);
  touchPersist();
  const r = await saveUsers(users);
  return r !== false;
}

/* 定时清扫过期会话（避免长期未用的 token 永驻内存与磁盘，A4） */
const _sessSweep = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [key, s] of sessions) {
    if (!s || now - s.ts > SESS_TTL_MS) { sessions.delete(key); changed = true; }
  }
  if (changed) writeSessions().catch(() => {});
}, 30 * 60 * 1000);
if (_sessSweep && _sessSweep.unref) _sessSweep.unref();

/* ---------- 本机自动身份（个人模式，W25） ----------
   pancode 是个人本机产品，注册/登录门槛是多余的；但 userToken 闸门本身必须保留
   （它挡着 DNS rebinding / 恶意网页直接调 API —— 见 index.js 的鉴权注释）。
   折中：由"仅本机回环可达"的 /api/auth/auto 静默发身份——
     · 没有任何用户 → 创建 local 用户（密码随机且不外泄，谁也无法"登录"它），签发 token
     · 恰好一个用户 → 直接给它签发 token（免密；单账号即机主，这是个人模式的本意）
     · 多个用户     → 拒绝（multiUser），前端回退登录弹窗 —— 多账号语义下免密等于冒充。
   调用方（index.js）负责再验一次 TCP 层 remoteAddress。 */
async function autoIdentity() {
  const users = loadUsers();
  const names = Object.keys(users);
  if (names.length > 1) return { ok: false, multiUser: true };
  let username = names[0];
  const created = !username;
  if (created) {
    username = "local";
    const salt = genSalt();
    const hash = await hashPassword(genToken() + genToken(), salt);
    users[username] = { salt, hash, ts: Date.now() };
    await saveUsers(users);
  }
  const token = newSession(username);
  await writeSessions();
  return { ok: true, token, username, created };
}

module.exports = { register, login, verify, logout, hasUsers, removeUser, listUsers, flushSessions, autoIdentity, USERS_FILE, SESS_FILE, tokenKey };
