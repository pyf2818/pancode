# -*- coding: utf-8 -*-
# W4 fix v3: scheduler.js remove() 异步重试 + atomicWrite 加长退避
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# ---- scheduler.js: remove() 加重试 ----
p1 = os.path.join(BASE, "server", "scheduler.js")
s1 = io.open(p1, "r", encoding="utf-8").read()

old_rm = '''  remove(id) {
    const t = this.get(id);
    if (!t) return { error: "任务不存在" };
    try { fs.rmSync(this._file(id), { force: true }); } catch (e) {}
    try { fs.rmSync(path.join(this._dir, id), { recursive: true, force: true }); } catch (e) {}
    return { ok: true };
  }'''
new_rm = '''  /* 删除（async）：AV 瞬时锁可能让 rmSync EPERM → 退避重试，并验证删净后才返回 ok */
  async remove(id) {
    const t = this.get(id);
    if (!t) return { error: "任务不存在" };
    let gone = false;
    for (let i = 0; i < 6 && !gone; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 500 * i)); // 0.5/1/1.5/2/2.5s
      try {
        fs.rmSync(this._file(id), { force: true });
        fs.rmSync(path.join(this._dir, id), { recursive: true, force: true });
      } catch (e) { continue; }
      gone = !this.get(id); // 回读验证
    }
    if (!gone) return { error: "删除失败（文件被占用，稍后重试）" };
    return { ok: true };
  }'''
assert s1.count(old_rm) == 1, "scheduler remove anchor: %d" % s1.count(old_rm)
s1 = s1.replace(old_rm, new_rm)
io.open(p1 + ".new", "w", encoding="utf-8", newline="").write(s1)

# ---- safe-write.js: 退避加长到 6 次（~10.9s 总跨度） ----
p2 = os.path.join(BASE, "server", "safe-write.js")
s2 = io.open(p2, "r", encoding="utf-8").read()
old_aw = "  for (let attempt = 0; attempt < 5; attempt++) {\n    if (attempt > 0) await sleep(100 * Math.pow(3, attempt - 1)); // 100/300/900/2400"
new_aw = "  for (let attempt = 0; attempt < 6; attempt++) {\n    if (attempt > 0) await sleep(100 * Math.pow(3, attempt - 1)); // 100/300/900/2400/7200"
assert s2.count(old_aw) == 1, "safe-write anchor: %d" % s2.count(old_aw)
s2 = s2.replace(old_aw, new_aw)
old_cmt = "异步指数退避重试（100/300/900/2400ms，总跨度 ~3.7s），不阻塞事件循环。"
new_cmt = "异步指数退避重试（100/300/900/2400/7200ms，总跨度 ~10.9s），不阻塞事件循环。"
assert s2.count(old_cmt) == 1
s2 = s2.replace(old_cmt, new_cmt)
io.open(p2 + ".new", "w", encoding="utf-8", newline="").write(s2)

# ---- index.js: DELETE 路由 await remove ----
p3 = os.path.join(BASE, "server", "index.js")
s3 = io.open(p3, "r", encoding="utf-8").read()
old_del = '''app.delete("/api/automations/:id", (req, res) => {
  try {
    const r = automationStore.remove(req.params.id);'''
new_del = '''app.delete("/api/automations/:id", async (req, res) => {
  try {
    const r = await automationStore.remove(req.params.id);'''
assert s3.count(old_del) == 1, "index delete anchor: %d" % s3.count(old_del)
s3 = s3.replace(old_del, new_del)
io.open(p3 + ".new", "w", encoding="utf-8", newline="").write(s3)

print("3 patches -> .new written")
