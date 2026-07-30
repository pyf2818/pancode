/* ============================================================
   pancode 前端核心工具
   先于所有模块脚本加载，提供全局选择器 $ 与转义 esc，
   供后续模块（evolution-codex / skill-market / cmdk / onboard / settings）加载时使用。
   ============================================================ */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
