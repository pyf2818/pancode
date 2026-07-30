/* ============================================================
   pancode 安全写入工具（Phase 3 · A5 并发安全）
   - atomicWrite：写临时文件 → rename 顶替，进程崩溃也不会截断 JSON
   - enqueueWrite：按"绝对路径"串行化写入，防止并发请求 / async 窗口覆盖丢更新
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const queues = new Map(); // 绝对路径 -> Promise chain

/* 原子写：临时文件写成功后 rename 顶替目标文件；rename 失败（如覆盖已存在文件）降级直写，并尽力清理孤儿 tmp */
function atomicWrite(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, data, "utf8");
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    fs.writeFileSync(p, data, "utf8");   // 降级：直接覆盖写（牺牲原子性保成功）
  }
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}  // 尽力清理临时文件
}

/* 按路径串行化：同一文件的多次写入排队执行，避免交错覆盖 */
function enqueueWrite(p, fn) {
  const prev = queues.get(p) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (queues.get(p) === next) queues.delete(p);
  });
  queues.set(p, next);
  return next;
}

/* 便捷方法：序列化 → 串行 → 原子落盘 */
function saveJson(p, obj) {
  let data;
  try { data = JSON.stringify(obj, null, 2); }
  catch (e) { console.warn("[safe-write] 序列化失败:", p, e.message); return Promise.resolve(); }
  return enqueueWrite(p, () => {
    try { atomicWrite(p, data); }
    catch (e) { console.warn("[safe-write] 写入失败:", p, e.message); }
  });
}

module.exports = { atomicWrite, enqueueWrite, saveJson };
