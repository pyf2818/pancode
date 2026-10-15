/* ============================================================
   全局授权根清单（阶段二的地基）
   ------------------------------------------------------------
   回答的是「这个 Agent 被允许碰机器上的哪些目录」——和 allow/deny 工具规则
   是两个轴：规则管"在这个目录里能干什么"，这份清单管"能不能进这个门"。

   用户拍板的粒度是**全局一份**（类操作系统的权限面板），不是每会话各配一组，
   所以文件落在数据根而不是工作区：<数据根>/.pancode/roots.json
   （数据根与工作区两套同名 .pancode/ 是本项目老踩的坑，这里只认数据根。）

   - 条目 id 直接复用 ws-key 的分片键：`E:\P`、`e:\p\`、相对写法规范化后是同一个目录，
     也就同一条授权。本模块不再自己算哈希（ws-key 有防回归测试，扫到第二个键源就红）。
   - 撤销授权只删这一行，**绝不删目录本身**：那是用户的数据。
   - 目录不见了不静默摘除：标 stale 报给用户看。他可能只是挂了个外接盘。
   ============================================================ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const wsKey = require("./ws-key");
const safeWrite = require("./safe-write");

const LABEL_MAX = 60;
const TOUCH_MIN_MS = 60000;   // lastUsedAt 一小时写一次就够：每次工具调用都刷盘会把盘打热

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };

/* "打开这个文件夹"不该等于"AI 现在能往这个文件夹里以及它下面的一切写文件"。
   这个判断是给"要不要先问一句"用的，所以宁可多列出一些：
   盘符/文件系统根、用户家目录本身、系统与程序目录、以及任何祖先命中这些的目录。
   漏判的代价是用户没被问就交出了整个树；误报的代价是多弹一次确认。

   三条判据要分开，不能混成一张名字表 —— 混了会在 Windows 上把每一个项目都当成敏感目录
   （默认装法下几乎所有项目都在 C:\Users\<名字>\ 下面）：
   - SYSTEM_NAMES 命中目录自身或任一祖先就算敏感（系统目录及其下面的东西）。
   - POSIX_SYSTEM_NAMES 只认"紧贴根目录"的那一层（/etc、/usr、/bin …）。
     否则 ~/proj/lib 这种项目内子目录也会被当成系统目录。
   - PROFILE_DATA_NAMES 只在目录正好躺在某个用户目录直下时才算敏感（Downloads/Desktop 这类）。
     ~/Documents/某个项目 是正常项目目录，不该拦；~/Downloads 才是。 */
const SYSTEM_NAMES = new Set([
  "windows", "system32", "syswow64", "program files", "program files (x86)",
  "programdata", "$recycle.bin", "system volume information",
]);
const POSIX_SYSTEM_NAMES = new Set([
  "etc", "var", "usr", "bin", "sbin", "lib", "lib64", "opt", "proc", "sys",
  "boot", "dev", "private", "library",
]);
/* 用户目录的容器名：命中说明它的下一层是"某个人"的家目录 */
const PROFILE_CONTAINER_NAMES = new Set(["users", "home", "user home"]);
const PROFILE_DATA_NAMES = new Set([
  "documents", "downloads", "desktop", "pictures", "music", "videos",
  "onedrive", "appdata", "my documents",
]);

function isSensitiveRoot(dir) {
  let abs;
  try { abs = path.resolve(dir); } catch (e) { return false; }
  let parsed;
  try { parsed = path.parse(abs); } catch (e) { return false; }
  // 盘符根 / 文件系统根：C:\ 、/
  if (parsed.root === abs) return true;
  // 家目录本身，以及它的任意祖先（C:\Users 底下是整台机器上所有用户的文件）
  let home = "";
  try { home = path.resolve(os.homedir()); } catch (e) {}
  if (home) {
    const nh = wsKey.normalizeDir(home, home);
    const na = wsKey.normalizeDir(abs, home);
    if (na === nh || nh.startsWith(na + path.sep)) return true;
  }
  // 环境变量指向的系统目录（Windows 上这几个值最常被手滑选到）
  for (const k of ["SystemRoot", "windir", "ProgramFiles", "ProgramData", "ProgramW6432"]) {
    const v = process.env[k];
    if (!v) continue;
    try {
      const nv = wsKey.normalizeDir(path.resolve(v), path.resolve(v));
      const na = wsKey.normalizeDir(abs, nv);
      if (na === nv || nv.startsWith(na + path.sep)) return true;
    } catch (e) {}
  }

  const segs = abs.split(/[\\/]+/).filter(Boolean);
  if (!segs.length) return true;
  const own = segs[segs.length - 1].toLowerCase();

  // 目录自己就叫系统目录，或就是用户目录容器本身（/root、C:\Users）
  if (SYSTEM_NAMES.has(own) || POSIX_SYSTEM_NAMES.has(own) && segs.length === 1) return true;
  if (PROFILE_CONTAINER_NAMES.has(own)) return true;
  // 数据目录：只有在某个用户目录（含 users\<名字> 这一层）直下才算
  if (PROFILE_DATA_NAMES.has(own)) {
    const parent = segs.slice(0, -1);
    if (parent.some((s) => PROFILE_CONTAINER_NAMES.has(s.toLowerCase()))) return true;
  }
  // 祖先里有系统目录（C:\Windows\System32\drivers 之类）
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i].toLowerCase();
    if (SYSTEM_NAMES.has(s)) return true;
    if (i === 0 && POSIX_SYSTEM_NAMES.has(s)) return true;
  }
  return false;
}

/* 目录边界包含判定：授权了 E:\proj 不能顺带覆盖 E:\proj-secret。
   比较用规范化后的形态（绝对化 + 去尾分隔符 + Windows 折大小写），与键同源。 */
function contains(grantDirNorm, targetNorm) {
  if (!grantDirNorm || !targetNorm) return false;
  if (grantDirNorm === targetNorm) return true;
  const withSep = grantDirNorm.endsWith(path.sep) ? grantDirNorm : grantDirNorm + path.sep;
  return targetNorm.startsWith(withSep);
}

class RootGrants {
  /* filePath：<数据根>/.pancode/roots.json；dataRoot：把相对写法绝对化用 */
  constructor(filePath, dataRoot) {
    this._path = filePath;
    this._dataRoot = dataRoot || path.dirname(path.dirname(filePath));
    this.rows = [];
    this._load();
  }

  _load() {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this._path, "utf8")); } catch (e) { return; }
    const list = Array.isArray(d && d.roots) ? d.roots : [];
    // 老文件里可能缺 id（手工改过 / 别的版本写的）：按路径补算一次，不丢条目
    this.rows = list.filter((r) => r && r.path).map((r) => Object.assign({}, r, {
      id: r.id || wsKey.shardKey(r.path, this._dataRoot),
      writable: r.writable !== false,
    }));
  }

  _save() {
    return safeWrite.saveJson(this._path, { v: 1, updated: Date.now(), roots: this.rows });
  }

  /* 带实时体检的列表：stale / moved 是"此刻盘上的样子"，不落盘成永久状态。
     moved = 目录还在，但已经不是当初授权的那个（被删后重建，或软链改指了别处）——
     这时候"用户授权的是哪个目录"已经不确定了，得让人看见，不能当作没事发生。 */
  list() {
    return this.rows.map((r) => {
      const existsNow = isDir(r.path);
      let moved = false;
      if (existsNow && r.realPath) {
        try { moved = fs.realpathSync(r.path) !== r.realPath; } catch (e) { moved = true; }
      }
      return Object.assign({}, r, { stale: !existsNow, moved });
    });
  }

  get(id) { return this.rows.find((r) => r.id === id) || null; }

  /* 授权一个目录。同一目录重复授权 = 更新（改可写性/别名），不会长出第二条。 */
  async add(input) {
    const raw = String((input && input.path) || "").trim();
    if (!raw) return { error: "目录路径不能为空" };
    const abs = path.resolve(this._dataRoot, raw);
    if (!isDir(abs)) return { error: "目录不存在或不是一个文件夹：" + abs };
    const id = wsKey.shardKey(abs, this._dataRoot);
    const writable = !(input && input.writable === false);
    let realPath = "";
    try { realPath = fs.realpathSync(abs); } catch (e) {}
    const label = String((input && input.label) || "").slice(0, LABEL_MAX);
    const existing = this.get(id);
    if (existing) {
      Object.assign(existing, {
        path: abs, writable,
        label: label || existing.label,
        source: (input && input.source) || existing.source || "manual",
        realPath: realPath || existing.realPath,
      });
    } else {
      this.rows.push({ id, path: abs, writable, label, source: (input && input.source) || "manual", grantedAt: Date.now(), lastUsedAt: 0, realPath });
    }
    await this._save();
    return { root: this.get(id) };
  }

  async setWritable(id, writable) {
    const r = this.get(id);
    if (!r) return { error: "没有这条授权：" + id };
    r.writable = !!writable;
    await this._save();
    return { root: r };
  }

  /* 撤销授权：只删清单里这一行。目录和里面的文件一个都不碰。 */
  async remove(id) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    if (this.rows.length === before) return { error: "没有这条授权：" + id };
    await this._save();
    return { ok: true };
  }

  /* 这个绝对路径落在哪个被授权的根里？返回带 writable 的条目，够不着就是 null。
     取"最具体的那个"（最长前缀）：同时授权了 E:\proj 和 E:\proj\sub 时，
     子目录上的只读约束不该被父目录的可写盖掉。 */
  findFor(absPath) {
    const target = wsKey.normalizeDir(absPath, this._dataRoot);
    let best = null;
    for (const r of this.rows) {
      const grant = wsKey.normalizeDir(r.path, this._dataRoot);
      if (!contains(grant, target)) continue;
      if (!best || grant.length > best._grantLen) { best = Object.assign({}, r, { _grantLen: grant.length }); }
    }
    if (!best) return null;
    delete best._grantLen;
    return best;
  }

  /* 写操作能不能落到这个路径：先要有根授权，再看那个根是不是可写 */
  canWrite(absPath) {
    const r = this.findFor(absPath);
    if (!r) return { ok: false, reason: "该路径不在任何已授权的目录里：" + absPath };
    if (!r.writable) return { ok: false, reason: "「" + (r.label || r.path) + "」是只读授权" };
    return { ok: true, root: r };
  }

  /* 记一笔"最近用过"，给 UI 排序用。节流：一小时内不重复落盘。 */
  touch(absPath) {
    const r = this.findFor(absPath);
    if (!r) return false;
    const now = Date.now();
    if (now - (r.lastUsedAt || 0) < TOUCH_MIN_MS) return false;
    const row = this.get(r.id);
    row.lastUsedAt = now;
    this._save();
    return true;
  }

  /* 活动工作区必须在清单里，否则它一出门就"没被授权"。每次挂载都保证这一条存在，
     且不覆盖用户改过的可写性。 */
  async ensure(dir, label) {
    const id = wsKey.shardKey(dir, this._dataRoot);
    const r = this.get(id);
    if (r) {
      if (label && !r.label) { r.label = String(label).slice(0, LABEL_MAX); await this._save(); }
      return r;
    }
    const res = await this.add({ path: dir, writable: true, source: "workspace", label });
    return res.root || null;
  }

  /* 这个目录要不要先问一句才给可写权？（静态：只看路径，不看清单）
     供 POST /api/workspace 在"这个目录还没被授权过"时决定是否拦一次。 */
  static isSensitiveRoot(dir) { return isSensitiveRoot(dir); }
  /* 实例方法别名：index.js 里 rootGrants 是 RootGrants 实例，调 isSensitiveRoot 时
     走这里委托到静态实现，避免调用方要记得用 RootGrants.isSensitiveRoot。 */
  isSensitiveRoot(dir) { return RootGrants.isSensitiveRoot(dir); }
}

module.exports = { RootGrants, contains, isSensitiveRoot };
