/* ============================================================
   全局设置 — 外观 / 语言 / 字体大小 / 项目管理
   ============================================================ */
"use strict";

(function () {

  // ---------- 字体大小 ----------
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

  // ---------- 打开/关闭 ----------
  function openGlobalSettings() {
    const modal = $("globalSettingsModal");
    modal.style.display = "flex";
    replaceIcons(modal);
    initAppearance();
    initLanguage();
    initProject();
  }

  function $(id) { return document.getElementById(id); }

  $("btnGlobalSettings").onclick = openGlobalSettings;
  $("gsClose").onclick = () => ($("globalSettingsModal").style.display = "none");

  // ---------- 外观 ----------
  function initAppearance() {
    // 主题
    const theme = (typeof getTheme === "function" ? getTheme() : "dark");
    const themeSeg = $("gsThemeSeg");
    themeSeg.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.val === theme);
      b.onclick = () => {
        themeSeg.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        if (typeof applyTheme === "function") applyTheme(b.dataset.val);
      };
    });

    // 编辑器字体大小
    const fs = getEditorFontSize();
    const fsSlider = $("gsFontSize");
    const fsVal = $("gsFontSizeVal");
    fsSlider.value = fs; fsVal.textContent = fs + "px";
    fsSlider.oninput = () => { fsVal.textContent = fsSlider.value + "px"; window.applyEditorFontSize(parseFloat(fsSlider.value)); };

    // UI 字体大小
    const uifs = getUiFontSize();
    const uifsSlider = $("gsUiFontSize");
    const uifsVal = $("gsUiFontSizeVal");
    uifsSlider.value = uifs; uifsVal.textContent = uifs + "px";
    uifsSlider.oninput = () => { uifsVal.textContent = uifsSlider.value + "px"; window.applyUiFontSize(parseFloat(uifsSlider.value)); };
  }

  // ---------- 语言 ----------
  function initLanguage() {
    const lang = localStorage.getItem("cw-lang") || "zh";
    const langSeg = $("gsLangSeg");
    langSeg.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.val === lang);
      b.onclick = () => {
        langSeg.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        if (typeof setLang === "function") setLang(b.dataset.val);
      };
    });
  }

  // ---------- 项目管理 ----------
  async function initProject() {
    // 当前工作区
    try {
      const r = await fetch("/api/workspace").then((x) => x.json());
      if (r.workspace) $("gsWorkspace").textContent = r.workspace;
      else $("gsWorkspace").textContent = "未指定";
      // 最近列表
      const recents = r.recent || [];
      const list = $("gsRecentList");
      if (recents.length === 0) { list.innerHTML = '<div class="gs-recent-empty">暂无最近项目</div>'; return; }
      list.innerHTML = recents.map((p) =>
        '<div class="gs-recent-item" data-path="' + (p || "").replace(/"/g, "&quot;") + '">' +
        '<i data-ico="folder" class="gs-recent-ico"></i>' +
        '<span class="gs-recent-path">' + (p || "").replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</span>' +
        '</div>').join("");
      replaceIcons(list);
      list.querySelectorAll(".gs-recent-item").forEach((el) => {
        el.onclick = async () => {
          const dir = el.dataset.path;
          try {
            const res = await fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir }) }).then((x) => x.json());
            if (res.ok) {
              if (typeof toast === "function") toast("已切换到: " + res.workspace);
              $("gsWorkspace").textContent = res.workspace;
              // 清空编辑状态
              if (typeof state !== "undefined") { state.openTabs = []; state.activeFile = null; if (state.dirty) state.dirty.clear(); }
              if (typeof models !== "undefined") { for (const p in models) { try { models[p].dispose(); } catch (e) {} delete models[p]; } }
              if (typeof editor !== "undefined" && editor) { try { editor.setModel(null); } catch (e) {} }
              $("globalSettingsModal").style.display = "none";
            } else { if (typeof toast === "function") toast("切换失败: " + (res.error || "")); }
          } catch (e) { if (typeof toast === "function") toast("请求异常: " + e.message); }
        };
      });
    } catch (e) { $("gsWorkspace").textContent = "加载失败"; }
  }

  $("gsBrowseFolder").onclick = () => {
    $("globalSettingsModal").style.display = "none";
    if (typeof openFolderModal === "function") openFolderModal();
    else { const fm = $("folderModal"); if (fm) fm.style.display = "flex"; }
  };

  // ---------- 高级设置入口 ----------
  $("gsOpenModelSettings").onclick = () => {
    $("globalSettingsModal").style.display = "none";
    if (typeof openSettings === "function") openSettings();
  };
  $("gsOpenAgentSettings").onclick = () => {
    $("globalSettingsModal").style.display = "none";
    if (typeof openAgentSettings === "function") openAgentSettings();
  };

  // ---------- 启动时应用持久化的字体大小 ----------
  try {
    window.applyUiFontSize(getUiFontSize());
    if (typeof state !== "undefined" && state.monacoReady) window.applyEditorFontSize(getEditorFontSize());
    else document.addEventListener("monaco-ready", () => window.applyEditorFontSize(getEditorFontSize()));
  } catch (e) { console.warn("[global-settings] 字体大小应用失败:", e); }

})();