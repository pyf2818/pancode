# -*- coding: utf-8 -*-
"""W9 patch3: onmessage 适配 {src, cb} 存储结构（patch2 漏改点）"""
import io, os, sys, shutil, subprocess

TARGET = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "app.js"))

def patch_once(s, old, new, tag):
    n = s.count(old)
    if n != 1:
        print("FAIL[%s]: anchor count=%d (expect 1)" % (tag, n))
        sys.exit(1)
    print("OK[%s]" % tag)
    return s.replace(old, new, 1)

with io.open(TARGET, "r", encoding="utf-8") as f:
    src = f.read()

old = '''    _mdW.onmessage = (e) => {
      const d = e.data || {}; const cb = _mdWCbs.get(d.id);
      if (cb) { _mdWCbs.delete(d.id); cb(typeof d.html === "string" ? d.html : null); }
    };'''
new = '''    _mdW.onmessage = (e) => {
      const d = e.data || {}; const o = _mdWCbs.get(d.id);
      if (o) { _mdWCbs.delete(d.id); o.cb(typeof d.html === "string" ? d.html : renderChatMD(o.src)); }
    };'''

out = patch_once(src, old, new, "onmessage-struct")
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
