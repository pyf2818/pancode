# -*- coding: utf-8 -*-
# W5 patch: plan doc 落地记录
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
p = os.path.join(BASE, "docs", "workbuddy-alignment-plan.md")
src = io.open(p, "r", encoding="utf-8").read()

old = "  3. **主题联动**：SVG 用 `currentColor` + CSS 变量，随 light/dark 切换（收口 B4）。\n"
new = """  3. **主题联动**：SVG 用 `currentColor` + CSS 变量，随 light/dark 切换（收口 B4）。
- **落地决策（2026-09-26）**：
  1. **渲染通道：`renderChatMD` 识别闭合的 ```widget/svg/diagram 代码块** → `visualizer.js renderWidgetCard` 生成沙箱 iframe 卡片；未闭合 fence（流式中）先按普通代码块预览，闭合后才升级为 widget（防每个 delta 重设 srcdoc 闪烁）。
  2. **安全第一：iframe `sandbox="allow-scripts"`（无 allow-same-origin）**——LLM 生成内容是半可信的，绝不允许触达主页面 DOM/存储/token。副作用：opaque origin 读不了 contentDocument → 下载用 JS 注册表（LRU 30 条）。
  3. **高度自适应**：iframe 内桥脚本 postMessage `__wgH` → 父页调高（48–480px 封顶，超出内部滚动）。
  4. **主题联动零侵入**：MutationObserver 监听 `<html data-theme>` → postMessage 广播到所有 widget iframe，不改 app.js 主题函数。
  5. **为什么 A 不选 B（不加 render_diagram 工具）**：工具路径 = 调用→结果→再渲染三步且需后端 SVG 模板引擎（效果死板）；agent 直接输出 widget 块一步到位且表达力完整（任意 SVG/HTML）。改为在 SYSTEM_PROMPT 加第 14 条指引。HTML 内容提供「新窗口打开」，SVG 提供下载 .svg/.png（canvas 2x 光栅化）。
"""
n = src.count(old)
assert n == 1, "W5 anchor: %d" % n
src = src.replace(old, new)
io.open(p + ".new", "w", encoding="utf-8", newline="").write(src)
print("plan doc W5 -> .new")
