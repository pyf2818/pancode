/* ============================================================
   pancode 前端核心工具
   先于所有模块脚本加载，提供全局选择器 $ 与转义 esc，
   供后续模块（evolution-codex / skill-market / cmdk / onboard / settings）加载时使用。
   ============================================================ */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---------------- 桌面端无边框窗口：左上角红绿灯是真控件 ----------------
   preload 没注入（浏览器 / 探针）时整段不生效，.traffic 也保持隐藏。
   close 走窗口自己的 close，让主进程既有的「关窗 ≠ 退出」策略原样生效。 */
(function desktopWindowChrome() {
  const w = typeof window !== "undefined" ? window.pancodeWin : null;
  if (!w || !document.body) return;
  document.body.classList.add("pc-desktop");
  const bind = (cls, fn, title) => {
    const el = document.querySelector("." + cls);
    if (!el) return;
    el.title = title;
    el.setAttribute("role", "button");
    el.tabIndex = -1;
    el.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
  };
  bind("t-red", () => w.close(), "关闭（任务会继续在后台跑）");
  bind("t-yellow", () => w.minimize(), "最小化");
  bind("t-green", () => w.toggleMax(), "最大化");
  const setMax = (max) => {
    document.body.classList.toggle("pc-maximized", !!max);
    const g = document.querySelector(".t-green");
    if (g) g.title = max ? "还原" : "最大化";
  };
  try { w.onMaxChange(setMax); } catch (e) {}
  Promise.resolve(w.isMaximized()).then(setMax, () => setMax(false));
  // 双击标题栏空白处 = 最大化/还原（无边框之后原生那点手感得自己接回来）
  const bar = document.getElementById("titlebar");
  if (bar) bar.addEventListener("dblclick", (e) => {
    if (e.target.closest("button, select, input, a, .traffic")) return;
    w.toggleMax();
  });
})();
