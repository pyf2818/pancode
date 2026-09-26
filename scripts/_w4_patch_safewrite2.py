# -*- coding: utf-8 -*-
# W4 fix v2: safe-write.js — atomicWrite 改 async 长退避（不阻塞事件循环，永不抛错）
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
p = os.path.join(BASE, "server", "safe-write.js")
src = io.open(p, "r", encoding="utf-8").read()

old_start = src.find("/* 原子写")
old_end = src.find("/* 按路径串行化")
assert old_start >= 0 and old_end > old_start, "anchors not found"

new_block = '''/* 原子写（async）：临时文件写成功后 rename 顶替目标文件；rename 失败（如覆盖已存在文件）降级直写。
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

'''

# 注入 sleep 定义（放在 queues 声明后）
anchor_q = 'const queues = new Map(); // 绝对路径 -> Promise chain'
assert src.count(anchor_q) == 1
src = src.replace(anchor_q, anchor_q + '\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));')

src = src[:old_start] + new_block + src[old_end:]

# saveJson 内部改为 async 调用
old_save = '''  return enqueueWrite(p, () => {
    try { atomicWrite(p, data); }
    catch (e) { console.warn("[safe-write] 写入失败:", p, e.message); }
  });'''
new_save = '''  return enqueueWrite(p, async () => { await atomicWrite(p, data); });'''
assert src.count(old_save) == 1
src = src.replace(old_save, new_save)

newp = p + ".new"
io.open(newp, "w", encoding="utf-8", newline="").write(src)
print("safe-write.js v2 -> .new written")
