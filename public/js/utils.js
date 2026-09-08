/* pancode 纯工具函数模块 —— 从 app.js 抽出，零状态依赖
   加载顺序：core.js → icons.js → utils.js → app.js */
"use strict";

function diffStat(a, b) {
  const cnt = (arr) => { const m = {}; arr.forEach((l) => (m[l] = (m[l] || 0) + 1)); return m; };
  const A = cnt(a.split("\n")), B = cnt(b.split("\n"));
  let add = 0, del = 0;
  for (const l in B) { const d = B[l] - (A[l] || 0); if (d > 0) add += d; }
  for (const l in A) { const d = A[l] - (B[l] || 0); if (d > 0) del += d; }
  return { add, del };
}

function fmtSize(n) {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function getTheme() { return localStorage.getItem("cw-theme") || "dark"; }

function extOf(p) { return String(p).split(".").pop().toLowerCase(); }

function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function monacoLangOf(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return ({ js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    json: "json", html: "html", htm: "html", css: "css", scss: "scss", md: "markdown", py: "python",
    sh: "shell", yml: "yaml", yaml: "yaml", txt: "plaintext" })[ext] || "plaintext";
}

function fmtTok(n) { n = n || 0; return n >= 1000 ? (Math.round(n / 100) / 10) + "k" : "" + n; }

function toast(msg) {
  let t = $("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 1800);
}

function colorizeDiffText(text) {
  return text.split("\n").map((l) => {
    if (l.startsWith("+")) return '<span class="add">' + esc(l) + "</span>";
    if (l.startsWith("-")) return '<span class="del">' + esc(l) + "</span>";
    return esc(l);
  }).join("\n");
}

function showConfirm(title, msg, onOk) {
  const m = $("confirmModal");
  if (!m) { if (confirm(msg.replace(/<[^>]+>/g, ""))) onOk(); return; }
  $("confirmTitle").textContent = title;
  $("confirmMsg").innerHTML = msg;
  replaceIcons(m);
  m.style.display = "flex";
  const ok = $("confirmOk"), cancel = $("confirmCancel");
  const cleanup = () => { m.style.display = "none"; ok.onclick = null; cancel.onclick = null; };
  ok.onclick = () => { cleanup(); onOk(); };
  cancel.onclick = cleanup;
}