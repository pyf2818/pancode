/* ============================================================
   字号落地：界面 / 编辑器（Monaco + Diff）
   设置界面本身已并入 js/workbench.js；这里只留被两侧共用、
   且必须在启动时执行一次的持久化应用。
   ============================================================ */
"use strict";

(function () {
  function getEditorFontSize() { return parseFloat(localStorage.getItem("cw-fontsize")) || 13.5; }
  function getUiFontSize() { return parseFloat(localStorage.getItem("cw-ui-fontsize")) || 13; }

  window.applyEditorFontSize = function (size) {
    localStorage.setItem("cw-fontsize", String(size));
    if (typeof editor !== "undefined" && editor && editor.updateOptions) {
      try { editor.updateOptions({ fontSize: size }); } catch (e) {}
    }
    if (typeof diffEditor !== "undefined" && diffEditor && diffEditor.updateOptions) {
      try { diffEditor.updateOptions({ fontSize: size }); } catch (e) {}
    }
  };

  window.applyUiFontSize = function (size) {
    localStorage.setItem("cw-ui-fontsize", String(size));
    document.documentElement.style.fontSize = size + "px";
  };

  try {
    window.applyUiFontSize(getUiFontSize());
    if (typeof state !== "undefined" && state.monacoReady) window.applyEditorFontSize(getEditorFontSize());
    else document.addEventListener("monaco-ready", () => window.applyEditorFontSize(getEditorFontSize()));
  } catch (e) { console.warn("[字号] 启动应用失败:", e); }
})();
