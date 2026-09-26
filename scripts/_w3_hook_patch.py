# -*- coding: utf-8 -*-
"""W3 test hook 超时对齐（Defender 环境噪声，与 W4 惯例一致）"""
import io, os, sys, shutil, subprocess

TARGET = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test", "w3-memory.test.js"))

def patch_once(s, old, new, tag):
    n = s.count(old)
    if n != 1:
        print("FAIL[%s]: anchor count=%d (expect 1)" % (tag, n))
        sys.exit(1)
    print("OK[%s]" % tag)
    return s.replace(old, new, 1)

with io.open(TARGET, "r", encoding="utf-8") as f:
    src = f.read()

old = '''afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});'''
new = '''afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}, 30000);   // Windows Defender 逐文件扫描可超默认 10s（对齐 W4 惯例）'''

out = patch_once(src, old, new, "w3-afterAll-timeout")
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
