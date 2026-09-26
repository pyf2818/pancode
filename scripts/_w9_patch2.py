# -*- coding: utf-8 -*-
"""W9 patch2: renderChatMDAsync 回退语义内聚（cb 恒返回 html，Worker 不可用/onerror 时同步渲染）"""
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

# A: onerror → pending 请求同步渲染回退
a_old = '''    _mdW.onerror = () => {
      _mdWDead = true; _mdWCbs.forEach((cb) => cb(null)); _mdWCbs.clear();
      try { _mdW.terminate(); } catch (e2) {} _mdW = null;
    };'''
a_new = '''    _mdW.onerror = () => {
      _mdWDead = true; _mdWCbs.forEach((o) => o.cb(renderChatMD(o.src))); _mdWCbs.clear();
      try { _mdW.terminate(); } catch (e2) {} _mdW = null;
    };'''

# B: renderChatMDAsync → cb 恒返回 html（回退内聚）
b_old = '''function renderChatMDAsync(src, cb) {
  const w = _mdWorker();
  if (!w) return cb(null);
  const id = ++_mdWSeq;
  _mdWCbs.set(id, cb);
  try { w.postMessage({ id: id, src: src }); } catch (e) { _mdWCbs.delete(id); cb(null); }
}'''
b_new = '''function renderChatMDAsync(src, cb) {
  const w = _mdWorker();
  if (!w) return cb(renderChatMD(src));   // Worker 不可用 → 同步回退（cb 恒有 html）
  const id = ++_mdWSeq;
  _mdWCbs.set(id, { src: src, cb: cb });
  try { w.postMessage({ id: id, src: src }); } catch (e) { _mdWCbs.delete(id); cb(renderChatMD(src)); }
}'''

# C: _mdRenderBlock 回调简化（无 null 分支）
c_old = '''    renderChatMDAsync(src, (html) => {
      if (html === null) { b.el.innerHTML = renderChatMD(src); wireCopyButtons(b.el); scrollChat(); return; }
      if (b.buf !== src) return;   // buf 已前进：丢弃过期帧，下一帧渲染最新内容
      b.el.innerHTML = html; wireCopyButtons(b.el); scrollChat();
    });'''
c_new = '''    renderChatMDAsync(src, (html) => {
      if (b.buf !== src) return;   // buf 已前进：丢弃过期帧，下一帧渲染最新内容
      b.el.innerHTML = html; wireCopyButtons(b.el); scrollChat();
    });'''

out = src
out = patch_once(out, a_old, a_new, "A-onerror")
out = patch_once(out, b_old, b_new, "B-async-fn")
out = patch_once(out, c_old, c_new, "C-renderblock")

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
