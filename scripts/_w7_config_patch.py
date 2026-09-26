# -*- coding: utf-8 -*-
"""P1 修复：config.js writeJsonSafe 走 safe-write 队列（AV 锁定下同步原子写全链失败实证）"""
import io, os, sys, shutil, subprocess

TARGET = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server", "config.js"))

def patch_once(s, old, new, tag, expect=1):
    n = s.count(old)
    if n != expect:
        print("FAIL[%s]: anchor count=%d (expect %d)" % (tag, n, expect))
        sys.exit(1)
    print("OK[%s]" % tag)
    return s.replace(old, new, 1)

with io.open(TARGET, "r", encoding="utf-8") as f:
    src = f.read()

# A: 引入 safe-write（顶部 require 区）
a_old = 'const { setEnvVar } = require("./dotenv");'
a_new = 'const { setEnvVar } = require("./dotenv");\nconst { saveJson } = require("./safe-write");'

# B: writeJsonSafe 全量替换为 fire-and-forget 转发（语义：best-effort 持久化，不阻断主流程）
b_old = '''/* 皮实的配置写入：
   直接覆盖写可能被安全软件/环境钩子拦截（EPERM），
   失败后降级为「写临时文件 → rename 顶替」，再失败只警告不抛错——
   配置持久化永远不该阻断主流程（比如打开文件夹）。 */
function writeJsonSafe(p, obj) {
  const data = JSON.stringify(obj, null, 2);
  try { fs.writeFileSync(p, data, "utf8"); return true; } catch (e) {}
  try {
    const tmp = p + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.warn("[config] 配置持久化失败（不影响本次会话）:", e.message);
    return false;
  }
}'''
b_new = '''/* 皮实的配置写入（W7 补漏 · P1）：
   同步直写/tmprename 在杀软持续锁定下会全链失败（实测 EPERM 连发）→
   转发 safe-write 队列：按路径串行 + 异步指数退避重试 6 次（~10.9s），不阻塞事件循环、永不抛错。
   语义为 best-effort 持久化：进程内 cfg 对象仍是事实源（读盘仅在启动），调用点零改动。 */
function writeJsonSafe(p, obj) {
  saveJson(p, obj);   // fire-and-forget：队列串行 + 退避重试，失败仅 safe-write 内部告警
  return true;
}'''

out = src
out = patch_once(out, a_old, a_new, "A-require-saveJson")
out = patch_once(out, b_old, b_new, "B-writeJsonSafe")

new_path = TARGET + ".new"
with io.open(new_path, "w", encoding="utf-8", newline="") as f:
    f.write(out)

node = r"C:\\Users\\anlan0725\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe"
tmp_chk = TARGET + ".syntaxcheck.js"
shutil.copy2(new_path, tmp_chk)
try:
    r = subprocess.run([node, "--check", tmp_chk], capture_output=True, text=True)
finally:
    if os.path.exists(tmp_chk):
        os.remove(tmp_chk)
if r.returncode != 0:
    print("SYNTAX FAIL:\\n" + r.stderr[:2000])
    sys.exit(1)
print("SYNTAX OK")

os.remove(TARGET)
shutil.copy2(new_path, TARGET)
os.remove(new_path)
print("PATCHED ->", TARGET)
