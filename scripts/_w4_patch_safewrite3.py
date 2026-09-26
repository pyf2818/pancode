# -*- coding: utf-8 -*-
# W4 fix v2b: safe-write.js 全文件重写（async 长退避版）
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
p = os.path.join(BASE, "server", "safe-write.js")

content = '''/* ============================================================
   pancode 安全写入工具（Phase 3 · A5 并发安全）
   - atomicWrite：写临时文件 → rename 顶替，进程崩溃也不会截断 JSON
   - enqueueWrite：按"绝对路径"串行化写入，防止并发请求 / async 窗口覆盖丢更新
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const queues = new Map(); // 绝对路径 -> Promise chain
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 原子写（async）：临时文件写成功后 rename 顶替目标文件；rename 失败（如覆盖已存在文件）降级直写。
   Windows 下「刚创建即被改写」常撞上杀软/句柄瞬时锁（EPERM，可持续数秒）→
   异步指数退避重试（100/300/900/2400ms，总跨度 ~3.7s），不阻塞事件循环。
   永不抛错：成功返回 true，最终失败返回 false（调用方按需校验），杜绝 unhandled rejection。 */
async function atomicWrite(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(100 * Math.pow(3, attempt - 1)); // 100/300/900/2400
    const tmp = p + "." + process.pid + ".tmp";
    try {
      fs.writeFileSync(tmp, data, "utf8");
      try {
        fs.renameSync(tmp, p);
      } catch (e) {
        fs.writeFileSync(p, data, "utf8");   // 降级：直接覆盖写（牺牲原子性保成功）
      }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}  // 尽力清理临时文件
      return true;
    } catch (e) {
      lastErr = e; // tmp 写与降级写均被锁 → 退避后重试
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
    }
  }
  console.warn("[safe-write] 写入失败（重试后仍被锁）:", p, lastErr && lastErr.message);
  return false;
}

/* 按路径串行化：同一文件的多次写入排队执行，避免交错覆盖。fn 可为异步。 */
function enqueueWrite(p, fn) {
  const prev = queues.get(p) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (queues.get(p) === next) queues.delete(p);
  });
  queues.set(p, next);
  return next;
}

/* 便捷方法：序列化 → 串行 → 原子落盘（resolve 后可读己之写） */
function saveJson(p, obj) {
  let data;
  try { data = JSON.stringify(obj, null, 2); }
  catch (e) { console.warn("[safe-write] 序列化失败:", p, e.message); return Promise.resolve(); }
  return enqueueWrite(p, async () => { await atomicWrite(p, data); });
}

module.exports = { atomicWrite, enqueueWrite, saveJson };
'''

io.open(p + ".new", "w", encoding="utf-8", newline="").write(content)
print("safe-write.js v2b full rewrite -> .new written")
