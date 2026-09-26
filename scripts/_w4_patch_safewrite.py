# -*- coding: utf-8 -*-
# W4 fix: server/safe-write.js — atomicWrite 加退避重试（Windows 新建即改写 EPERM 竞态）
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
p = os.path.join(BASE, "server", "safe-write.js")
src = io.open(p, "r", encoding="utf-8").read()

old = '''/* 原子写：临时文件写成功后 rename 顶替目标文件；rename 失败（如覆盖已存在文件）降级直写，并尽力清理孤儿 tmp */
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
}'''

new = '''/* 原子写：临时文件写成功后 rename 顶替目标文件；rename 失败（如覆盖已存在文件）降级直写，并尽力清理孤儿 tmp。
   Windows 下「刚创建即被改写」可能撞上杀软/句柄瞬时锁（EPERM）→ 退避重试 3 次（60/180/540ms，同步忙等保持阻塞语义）。 */
function atomicWrite(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const until = Date.now() + 60 * Math.pow(3, attempt - 1);
      while (Date.now() < until) { /* 同步退避 */ }
    }
    const tmp = p + "." + process.pid + ".tmp";
    try {
      fs.writeFileSync(tmp, data, "utf8");
      try {
        fs.renameSync(tmp, p);
      } catch (e) {
        fs.writeFileSync(p, data, "utf8");   // 降级：直接覆盖写（牺牲原子性保成功）
      }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}  // 尽力清理临时文件
      return; // rename 或降级写成功
    } catch (e) {
      lastErr = e; // tmp 写与降级写均被锁 → 退避后重试
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
    }
  }
  throw lastErr || new Error("atomicWrite failed");
}'''

n = src.count(old)
assert n == 1, "safe-write.js: expect 1 occurrence, got %d" % n
src = src.replace(old, new)
newp = p + ".new"
io.open(newp, "w", encoding="utf-8", newline="").write(src)
print("safe-write.js -> .new written")
