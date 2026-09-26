# -*- coding: utf-8 -*-
"""W9 patch: markdown 渲染 Worker 化（msg.delta 移经典 Worker + 节流 + 快照校验 + 同步回退）"""
import io, os, sys, shutil

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "app.js")
TARGET = os.path.normpath(TARGET)

def patch_once(s, old, new, tag):
    n = s.count(old)
    if n != 1:
        print("FAIL[%s]: anchor count=%d (expect 1)" % (tag, n))
        sys.exit(1)
    print("OK[%s]" % tag)
    return s.replace(old, new, 1)

with io.open(TARGET, "r", encoding="utf-8") as f:
    src = f.read()

# ---------- P1: renderChatMD 定义前插入 Worker 单例 + 异步渲染 + 节流 ----------
p1_old = '/* 富文本 Markdown 渲染（聊天回答）：代码块/标题/列表/引用/表格/行内样式 */\nfunction renderChatMD(src) {'
p1_new = '''/* W9 · Markdown 渲染 Worker 化：流式 msg.delta 的全量重渲染移入经典 Worker，主线程只做 DOM 写入。
   失败兜底：Worker 创建失败（如 Electron file:// 协议）/运行期 onerror → 同步 renderChatMD 回退（绝不白屏）。
   竞态防护：快照校验 b.buf === src —— buf 已前进则丢弃过期结果（msg.end 的同步最终渲染天然覆盖迟到结果）。 */
let _mdW = null, _mdWDead = false, _mdWSeq = 0, _mdTimer = null;
const _mdWCbs = new Map();
function _mdWorker() {
  if (_mdW || _mdWDead) return _mdW;
  try {
    _mdW = new Worker("js/md-worker.js");
    _mdW.onmessage = (e) => {
      const d = e.data || {}; const cb = _mdWCbs.get(d.id);
      if (cb) { _mdWCbs.delete(d.id); cb(typeof d.html === "string" ? d.html : null); }
    };
    _mdW.onerror = () => {
      _mdWDead = true; _mdWCbs.forEach((cb) => cb(null)); _mdWCbs.clear();
      try { _mdW.terminate(); } catch (e2) {} _mdW = null;
    };
  } catch (e) { _mdWDead = true; }
  return _mdW;
}
function renderChatMDAsync(src, cb) {
  const w = _mdWorker();
  if (!w) return cb(null);
  const id = ++_mdWSeq;
  _mdWCbs.set(id, cb);
  try { w.postMessage({ id: id, src: src }); } catch (e) { _mdWCbs.delete(id); cb(null); }
}
function _mdRenderBlock(b) {
  if (_mdTimer) return;   // 节流：65ms 窗口内合并突发 delta，只调度一帧（触发时取最新 buf）
  _mdTimer = setTimeout(() => {
    _mdTimer = null;
    const src = b.buf;
    renderChatMDAsync(src, (html) => {
      if (html === null) { b.el.innerHTML = renderChatMD(src); wireCopyButtons(b.el); scrollChat(); return; }
      if (b.buf !== src) return;   // buf 已前进：丢弃过期帧，下一帧渲染最新内容
      b.el.innerHTML = html; wireCopyButtons(b.el); scrollChat();
    });
  }, 65);
}

/* 富文本 Markdown 渲染（聊天回答）：代码块/标题/列表/引用/表格/行内样式 */
function renderChatMD(src) {'''

# ---------- P2: msg.delta 改为节流异步渲染 ----------
p2_old = '''    case "msg.delta": {
      const b = blocks[ev.id]; if (!b) break;
      b.buf += ev.text; b.el.innerHTML = renderChatMD(b.buf); wireCopyButtons(b.el); b.el.classList.add("type-caret"); scrollChat();
      break;
    }'''
p2_new = '''    case "msg.delta": {
      const b = blocks[ev.id]; if (!b) break;
      b.buf += ev.text; b.el.classList.add("type-caret"); _mdRenderBlock(b);   // W9: Worker 化 + 节流
      break;
    }'''

# ---------- P3: msg.end 同步最终渲染（widget 升级 + 终态一致） ----------
p3_old = '''    case "msg.end": {
      const b = blocks[ev.id]; if (!b) break;
      b.el.classList.remove("type-caret"); scrollChat();'''
p3_new = '''    case "msg.end": {
      const b = blocks[ev.id]; if (!b) break;
      if (_mdTimer) { clearTimeout(_mdTimer); _mdTimer = null; }
      b.el.classList.remove("type-caret");
      // W9: 结束强制同步最终渲染 —— 闭合 widget 块升级为沙箱卡片，且终态与主线程渲染器一致
      if (b.buf) { b.el.innerHTML = renderChatMD(b.buf); wireCopyButtons(b.el); }
      scrollChat();'''

out = src
out = patch_once(out, p1_old, p1_new, "P1-worker-block")
out = patch_once(out, p2_old, p2_new, "P2-msg-delta")
out = patch_once(out, p3_old, p3_new, "P3-msg-end")

new_path = TARGET + ".new"
with io.open(new_path, "w", encoding="utf-8", newline="") as f:
    f.write(out)

# 语法冒烟：node --check（.new 扩展名不被识别，先复制成 .js 临时文件）
import subprocess
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
