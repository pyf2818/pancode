/* ============================================================
   多根路径解析层（阶段二-2）
   ------------------------------------------------------------
   工具拿到一个路径，这里回答三件事：它属于哪个已授权根、在该根内的相对路径是什么、
   该用哪个 FileStore 实例。判定顺序始终是"先门（授权清单）后屋（工具规则）"。

   四条规矩，都是防"静默失效"的：
   1. 落不进任何已授权根 → 明确拒绝，并说清楚要用户去加授权。**绝不退回到当前工作区**：
      那等于把一次越界读悄悄变成读另一个目录的同名文件——模型和用户都不会知道。
   2. 每次解析都现查授权清单。撤销授权或降级只读之后，即使缓存里的 FileStore 还活着，
      也必须立刻够不着——撤销的实效不能靠"实例刚好被回收"来实现。
   3. 额外根不 startWatch、也不进前端快照。阶段一 4′ 实测过：snapshotFiles 每个根最多读 500 个
      文件全文进内存，N 个根就是 N×500。所以"全量快照"这项待遇只给当前根。
   4. 不带 root 的路径行为与单根时代逐字一致（当前根就是默认根），这是这一层的回归底线。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const wsKey = require("./ws-key");
const { FileStore } = require("./files");

const MAX_LIVE = 6;   // 同时存活的额外根实例上限（每个 FileStore 都带 watcher/定时器）

/* Windows 盘符写法（E:\、E:/）与 UNC（\\srv\share）都算"绝对"，
   不能只靠 path.isAbsolute：它在 POSIX 上对 E:\x 判 false，而模型就是会这么写。 */
function isAbsoluteish(p) {
  const s = String(p == null ? "" : p);
  return path.isAbsolute(s) || /^[\\/]{2}[^\\/]/.test(s) || /^[A-Za-z]:[\\/]/.test(s);
}

function looksLikeRootId(s) { return /^[0-9a-f]{32}$/i.test(String(s || "").trim()); }

class RootStore {
  /* grants: RootGrants 实例；dataRoot: 数据根（相对写法的绝对化基准）；auditDir: 文件审计目录（全根共用一份） */
  constructor(opts) {
    this._grants = opts.grants;
    this._dataRoot = opts.dataRoot;
    this._auditDir = opts.auditDir || null;
    this._activeDir = null;
    this._stores = new Map();      // rootId -> FileStore（LRU：命中即移到队尾）
    this._owned = new Map();       // rootId -> 由本层创建的实例（活动根是外部 adopt 进来的，不归我们回收）
  }

  /* 活动工作区由 index.js 自己 new FileStore（还要挂 watch、推快照），这里只认账不重建，
     否则同一个目录出现两个 watcher，外部改动会被推两遍。 */
  setActive(dir, store) {
    this._activeDir = dir ? path.resolve(dir) : null;
    if (this._activeDir && store) {
      const id = wsKey.shardKey(this._activeDir, this._dataRoot);
      this._stores.delete(id);
      this._stores.set(id, store);
      this._owned.delete(id);        // adopt 进来的实例不归本层回收
    }
  }

  activeDir() { return this._activeDir; }

  /* 当前根的描述（不带 root 时的默认归属） */
  active() {
    const dir = this._activeDir;
    if (!dir) return null;
    const id = wsKey.shardKey(dir, this._dataRoot);
    return { id, dir, store: this._storeFor(id, dir), writable: true };
  }

  /* 实例缓存：LRU + 封顶。被挤出去的额外根实例要 stopWatch（它同时清掉自写表定时器，不然会漏）。 */
  _storeFor(id, dir) {
    const hit = this._stores.get(id);
    if (hit) { this._stores.delete(id); this._stores.set(id, hit); return hit; }
    const st = new FileStore(dir, this._auditDir);
    this._stores.set(id, st);
    this._owned.set(id, true);
    if (this._stores.size > MAX_LIVE) {
      for (const oldId of this._stores.keys()) {
        if (oldId === id) continue;
        if (!this._owned.has(oldId)) continue;     // 活动根那个不能停
        const old = this._stores.get(oldId);
        try { if (old && typeof old.stopWatch === "function") old.stopWatch(); } catch (e) {}
        this._stores.delete(oldId);
        this._owned.delete(oldId);
        break;
      }
    }
    return st;
  }

  /* 授权变了就丢掉对应实例：撤销/改读写性之后不该继续用旧实例的手。
     注意这只是"顺手"，真正的拦截靠 resolve 每次都现查清单（见文件头规矩 2）。 */
  invalidate(rootId) {
    const st = this._stores.get(rootId);
    if (st && this._owned.has(rootId)) {
      try { if (typeof st.stopWatch === "function") st.stopWatch(); } catch (e) {}
      this._stores.delete(rootId);
      this._owned.delete(rootId);
    }
    return !!st;
  }

  closeAll() {
    for (const [id, st] of this._stores) {
      if (!this._owned.has(id)) continue;
      try { if (typeof st.stopWatch === "function") st.stopWatch(); } catch (e) {}
    }
    this._stores.clear();
    this._owned.clear();
  }

  liveCount() { return this._stores.size; }

  /* 找到 abs 落在哪个已授权根里。findFor 已经取"最具体的那个"（子目录的只读赢过父目录的可写）。 */
  _grantFor(abs) { return this._grants.findFor(abs); }

  /* 摊开可选项给模型：它认的是路径与名字，32 位 id 只在确实要精确指认时才用得上 */
  _choices() {
    const act = wsKey.shardKey(this._activeDir || "", this._dataRoot);
    const list = this._grants.list();
    if (!list.length) return "（当前没有任何授权目录）";
    return list.map((r) => (r.label ? r.label + " = " : "") + r.path +
      (r.id === act ? "【当前工作区】" : "") + (r.writable ? "" : "（只读）")).join("；");
  }

  /* 给"按根注入规则/仓库结构"用：按 id 取实例。授权已撤销就返回 null——
     调用方（agent 的会话根集合）必须把它摘掉，不能让撤销过的目录继续往提示词里塞规则。 */
  storeById(rootId) {
    const id = String(rootId || "").toLowerCase();
    const g = this._grants.get(id);
    if (!g) return null;
    const activeId = this._activeDir ? wsKey.shardKey(this._activeDir, this._dataRoot) : "";
    const row = this._grants.list().find((r) => r.id === id) || {};
    if (row.stale) return null;   // 目录当前不在盘上：读它的规则只会得到一堆空，不如干脆不注入
    return { store: this._storeFor(g.id, g.path), entry: Object.assign({}, g, { active: activeId === g.id }) };
  }

  /* args: { root?, path }；mutation=true 时要求该根是可写授权。
     返回 { ok, store, rel, abs, root:{id,dir,label,writable,active}, error } */
  resolve(args, mutation) {
    const rawPath = String((args && args.path == null ? "" : args.path) || "");
    if (!rawPath.trim()) return { ok: false, error: "路径为空" };
    let rootArg = String((args && args.root || "")).trim();   // "active"/"."/"当前" 归一化成"不填"
    const activeDir = this._activeDir;
    if (!activeDir) return { ok: false, error: "还没有挂载任何目录" };

    let entry = null;   // { dir, id, label, writable, active }
    let absPath = null;

    if (rootArg && !looksLikeRootId(rootArg) && /^(active|\.|当前|workspace)$/i.test(rootArg)) rootArg = "";
    if (looksLikeRootId(rootArg)) {
      const g = this._grants.get(rootArg.toLowerCase());
      if (!g) return { ok: false, error: "没有找到 id=" + rootArg + " 的授权目录。当前已授权：" + this._choices() };
      entry = { dir: g.path, id: g.id, label: g.label, writable: g.writable, active: wsKey.shardKey(activeDir, this._dataRoot) === g.id };
    } else if (rootArg && isAbsoluteish(rootArg)) {
      const g = this._grantFor(path.resolve(this._dataRoot, rootArg));
      if (!g) return { ok: false, error: "这个目录没有被授权：" + path.resolve(this._dataRoot, rootArg) };
      entry = { dir: g.path, id: g.id, label: g.label, writable: g.writable, active: wsKey.shardKey(activeDir, this._dataRoot) === g.id };
    } else if (rootArg) {
      /* 给了 root 但既不是 32 位分片键也不是绝对目录：多半是模型把目录名/别名抄来了。
         按授权项的名字或目录末段匹配一次，匹配不到就把可选项摊开给它，别让它猜。 */
      const list = this._grants.list();
      const low = rootArg.toLowerCase();
      const hit = list.find((r) => (r.label || "").toLowerCase() === low || path.basename(r.path).toLowerCase() === low);
      if (!hit) return { ok: false, error: "不认识这个授权名：" + rootArg + "。当前已授权：" + this._choices() };
      entry = { dir: hit.path, id: hit.id, label: hit.label, writable: hit.writable, active: wsKey.shardKey(activeDir, this._dataRoot) === hit.id };
    } else if (isAbsoluteish(rawPath)) {
      absPath = path.resolve(this._dataRoot, rawPath);
      const g = this._grantFor(absPath);
      if (!g) return { ok: false, error: this._outsideMessage(absPath) };
      entry = { dir: g.path, id: g.id, label: g.label, writable: g.writable, active: wsKey.shardKey(activeDir, this._dataRoot) === g.id };
    } else {
      const id = wsKey.shardKey(activeDir, this._dataRoot);
      const g = this._grants.get(id);
      entry = { dir: activeDir, id, label: (g && g.label) || "当前工作区", writable: g ? g.writable : true, active: true };
    }

    if (mutation && !entry.writable) {
      return { ok: false, error: "「" + (entry.label || entry.dir) + "」是只读授权，不能写入 " + (absPath || rawPath) +
        "。要允许改动，请让用户在「设置 · 授权目录」里把这个根改成可写。" };
    }
    /* 根还在不在：授权过但盘没挂上，要说清楚是"目录不在"，不是"你没权限" */
    try { if (!require("fs").statSync(entry.dir).isDirectory()) throw new Error("not a dir"); }
    catch (e) { return { ok: false, error: "已授权的目录当前不在盘上：" + entry.dir + "（盘没挂上或已被移走？）" }; }

    const store = this._storeFor(entry.id, entry.dir);
    let rel = rawPath;
    if (absPath) {
      const r = path.relative(entry.dir, absPath);
      if (!r || r.startsWith("..") || path.isAbsolute(r)) {
        return { ok: false, error: this._outsideMessage(absPath) };
      }
      rel = r.replace(/\\/g, "/");
    } else if (path.isAbsolute(rawPath)) {
      rel = rawPath;   // 交给 FileStore 的 safePath 做最后的词法+软链校验
    }
    return { ok: true, store, rel, root: entry, abs: absPath || path.resolve(entry.dir, rel) };
  }

  _outsideMessage(absPath) {
    return "路径不在任何已授权的目录内：" + absPath +
      "。当前已授权：" + this._choices() +
      "。要访问别处，必须由用户先把那个目录加入授权（设置 · 授权目录）；" +
      "不要绕路改用别的目录、也不要在已授权目录里造一个同名文件硬凑。";
  }

  /* 给模型看的一句话摘要（工具描述与错误回执共用），不带 id 的长列表会把它绕晕 */
  summary() {
    return this._grants.list().map((r) => ({
      id: r.id, path: r.path, label: r.label, writable: r.writable, stale: r.stale,
      active: !!this._activeDir && wsKey.shardKey(this._activeDir, this._dataRoot) === r.id,
    }));
  }
}

module.exports = { RootStore, isAbsoluteish, looksLikeRootId, MAX_LIVE };
