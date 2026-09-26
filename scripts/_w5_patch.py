# -*- coding: utf-8 -*-
# W5 patch: app.js renderChatMD widget 分支 + styles.css 样式 + index.html script + agent-llm.js 指引
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

def swap(p, s):
    io.open(p + ".new", "w", encoding="utf-8", newline="").write(s)

# ---------- 1. app.js: renderChatMD fence 分支 ----------
p = os.path.join(BASE, "public", "app.js")
s = io.open(p, "r", encoding="utf-8").read()
old = '''    const fence = line.match(/^```(\\w*)\\s*$/);
    if (fence) {
      flushList();
      const lang = fence[1] || "";
      const code = [];
      i++;
      while (i < lines.length && !/^```\\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      html += '<div class="code-block">'''
new = '''    const fence = line.match(/^```(\\w*)\\s*$/);
    if (fence) {
      flushList();
      const lang = fence[1] || "";
      const code = [];
      i++;
      let closed = false;
      while (i < lines.length && !/^```\\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      if (i < lines.length) { closed = true; i++; }
      // W5：闭合的 widget/svg/diagram 代码块 → 沙箱内联可视化（未闭合时流式期先按代码预览显示）
      if (closed && /^(widget|svg|diagram)$/i.test(lang) && typeof renderWidgetCard === "function") {
        html += renderWidgetCard(code.join("\\n"), lang);
        continue;
      }
      html += '<div class="code-block">'''
assert s.count(old) == 1, "app.js fence: %d" % s.count(old)
s = s.replace(old, new)
swap(p, s)
print("app.js patched")

# ---------- 2. styles.css: 追加 widget 样式 ----------
p = os.path.join(BASE, "public", "styles.css")
s = io.open(p, "r", encoding="utf-8").read()
css = '''
/* ============ W5 · 消息流内联可视化（widget 卡片） ============ */
.msg-widget{border:1px solid var(--border);border-radius:10px;margin:8px 0;background:var(--bg);overflow:hidden}
.msg-widget .wg-head{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--border);font-size:11px;color:var(--text-dim)}
.msg-widget .wg-title{font-weight:600}
.msg-widget .wg-btn{font-size:11px;padding:2px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);cursor:pointer}
.msg-widget .wg-btn:hover{border-color:var(--accent);color:var(--accent)}
.msg-widget .wg-frame{display:block;width:100%;border:0;background:transparent}
.msg-widget.wg-err{padding:10px;font-size:12px;color:var(--text-dim)}
'''
s = s.rstrip() + "\n" + css
swap(p, s)
print("styles.css patched")

# ---------- 3. index.html: script 标签（app.js 之前加载） ----------
p = os.path.join(BASE, "public", "index.html")
s = io.open(p, "r", encoding="utf-8").read()
old = '  <script src="js/patch-review.js"></script>'
assert s.count(old) == 1, "index.html script anchor: %d" % s.count(old)
s = s.replace(old, old + '\n  <script src="js/visualizer.js"></script>')
swap(p, s)
print("index.html patched")

# ---------- 4. agent-llm.js: SYSTEM_PROMPT 指引 item 14 ----------
p = os.path.join(BASE, "server", "agent-llm.js")
s = io.open(p, "r", encoding="utf-8").read()
old = ' 13. 面对复杂任务且存在多种可行设计方向（如架构选型、技术方案对比、UI 交互模式选择）时，用 ask_user_choice 弹出候选方案让用户决策，不要自行替用户做重大方向性选择。每个选项给出 label（简短名称）和 description（利弊分析）。用户选择后按其方案继续。\n'
new = (' 13. 面对复杂任务且存在多种可行设计方向（如架构选型、技术方案对比、UI 交互模式选择）时，用 ask_user_choice 弹出候选方案让用户决策，不要自行替用户做重大方向性选择。每个选项给出 label（简短名称）和 description（利弊分析）。用户选择后按其方案继续。\n'
       ' 14. 需要向用户展示架构图、流程图、时序图或数据图表时，直接用 ```widget 代码块输出完整的 <svg>…</svg> 片段（自包含、无外部依赖；配色用 currentColor 以适配深浅主题；声明 viewBox 保证缩放），前端会内联渲染并提供 SVG/PNG 下载。\n')
assert s.count(old) == 1, "agent-llm anchor: %d" % s.count(old)
s = s.replace(old, new)
swap(p, s)
print("agent-llm.js patched")
