# -*- coding: utf-8 -*-
"""patch: ElectronFramework rename exe 失败降级 copyFile（AV 锁 rename 场景自救）"""
import io, os, sys, shutil, subprocess

TARGET = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "node_modules", "app-builder-lib", "out", "electron", "ElectronFramework.js"))

def patch_once(s, old, new, tag):
    n = s.count(old)
    if n != 1:
        print("FAIL[%s]: anchor count=%d (expect 1)" % (tag, n))
        sys.exit(1)
    print("OK[%s]" % tag)
    return s.replace(old, new, 1)

with io.open(TARGET, "r", encoding="utf-8") as f:
    src = f.read()

old = '''    else if (packager.platform === index_1.Platform.WINDOWS) {
        const executable = path.join(appOutDir, `${packager.appInfo.productFilename}.exe`);
        await (0, fs_extra_1.rename)(path.join(appOutDir, `${electronBranding.projectName}.exe`), executable);'''
new = '''    else if (packager.platform === index_1.Platform.WINDOWS) {
        const executable = path.join(appOutDir, `${packager.appInfo.productFilename}.exe`);
        const exeSrc = path.join(appOutDir, `${electronBranding.projectName}.exe`);
        // AV(Antivirus) may hold the freshly extracted exe and deny rename; degrade to copyFile (read src + create dst)
        await (0, fs_extra_1.rename)(exeSrc, executable).catch(() => require("fs").promises.copyFile(exeSrc, executable));'''

out = patch_once(src, old, new, "rename-to-copy-fallback")
new_path = TARGET + ".new"
with io.open(new_path, "w", encoding="utf-8", newline="") as f:
    f.write(out)

node = r"D:\download\nodejs\node.exe"
tmp_chk = TARGET + ".chk.js"
shutil.copy2(new_path, tmp_chk)
try:
    r = subprocess.run([node, "--check", tmp_chk], capture_output=True, text=True)
finally:
    if os.path.exists(tmp_chk):
        os.remove(tmp_chk)
if r.returncode != 0:
    print("SYNTAX FAIL:\n" + r.stderr[:1500])
    sys.exit(1)
print("SYNTAX OK")

os.remove(TARGET)
shutil.copy2(new_path, TARGET)
os.remove(new_path)
print("PATCHED ->", TARGET)
