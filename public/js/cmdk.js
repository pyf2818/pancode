/* ============================================================
   pancode 命令面板（Ctrl/⌘+Shift+P）
   依赖全局：getTheme / applyTheme / togglePreview / openEvolutionCodex /
            openSettings / openFile / state / esc / replaceIcons / $（运行时解析）
   ============================================================ */
"use strict";

let _cmdkItems = [];
function buildCmdList() {
  const acts = [
    { id: "ship", title: t("ckBuildCmdListtitleT103"), icon: "sparkle", group: t("ckGroupDeliver"), run: () => openWorkflowPop() },
    { id: "workflow", title: t("ckBuildCmdListtitleT104"), icon: "tasklist", group: t("ckGroupDeliver"), run: () => openWorkflowPop(true) },
    { id: "commit", title: t("ckBuildCmdListtitleT105"), icon: "branch", group: t("ckGroupDeliver"), run: () => openCommit() },
    { id: "newfile", title: t("newFile"), icon: "filePlus", group: t("ckGroupFile"), run: () => promptNewFile("") },
    { id: "newdir", title: t("newFolder"), icon: "filePlus", group: t("ckGroupFile"), run: () => { const p = prompt(t("ckNewDirPrompt"), "newdir"); if (p) send({ type: "file.mkdir", path: p }); } },
    { id: "save", title: t("scSave"), icon: "save", group: t("ckGroupFile"), run: () => saveActiveFile() },
    /* 卡片上的撤销按钮只挂在本次渲染的卡片上，页面一刷就没得点；影子快照里的检查点还在，
       所以命令面板这条是给"重启之后"留的入口（判据在服务端：跨会话拒绝、初始全量快照不暴露）。 */
    { id: "undo", title: t("ckUndoLastChange"), icon: "reset", group: t("ckGroupFile"), run: () => typeof undoFromPalette === "function" && undoFromPalette() },
    { id: "closetab", title: t("ckBuildCmdListtitleT106"), icon: "close", group: t("ckGroupFile"), run: () => { if (window.state && state.activeFile) closeTab(state.activeFile); } },
    { id: "newconv", title: t("ckBuildCmdListtitleT107"), icon: "robot", group: t("ckGroupSession"), run: () => startNewConv(true) },
    { id: "ai-explain", title: t("ckBuildCmdListtitleT108"), icon: "search", group: "AI", run: () => aiCurrentFile("请阅读并解释当前打开的文件，说明其功能、关键逻辑和设计思路。") },
    { id: "ai-fix", title: t("ckBuildCmdListtitleT109"), icon: "sparkle", group: "AI", run: () => aiCurrentFile("请检查当前打开的文件中的错误和问题，并修复它们。先运行测试确认问题，修复后再验证。") },
    { id: "ai-test", title: t("ckBuildCmdListtitleT110"), icon: "tasklist", group: "AI", run: () => aiCurrentFile("请为当前打开的文件生成单元测试，覆盖主要功能和边界情况。") },
    { id: "ai-refactor", title: t("ckBuildCmdListtitleT111"), icon: "branch", group: "AI", run: () => aiCurrentFile("请重构当前打开的文件，改善代码结构、可读性和可维护性，但不改变功能。") },
    { id: "ai-review", title: t("ckBuildCmdListtitleT112"), icon: "eye", group: "AI", run: () => aiCurrentFile("请对当前打开的文件进行代码审查，指出潜在问题和改进建议。") },
    { id: "theme", title: t("ckBuildCmdListtitleT113"), icon: getTheme() === "light" ? "moon" : "sun", group: t("ckGroupView"), run: () => applyTheme(getTheme() === "light" ? "dark" : "light") },
    { id: "preview", title: t("ckBuildCmdListtitleT114"), icon: "eye", group: t("ckGroupView"), run: () => togglePreview() },
    { id: "switch", title: t("scSwitchWin"), icon: "robot", group: t("ckGroupView"), run: () => switchMode((window.state && window.state.mode === "editor") ? "agents" : "editor") },
    { id: "evo", title: t("ckBuildCmdListtitleT115"), icon: "tree", group: t("ckGroupView"), run: () => openEvolutionCodex() },
    { id: "automations", title: t("ckBuildCmdListtitleT116"), icon: "clock", group: t("ckGroupDeliver"), run: () => typeof openAutomations === "function" && openAutomations() },
    { id: "sediment", title: t("ckBuildCmdListtitleT117"), icon: "save", group: t("ckGroupDeliver"), run: () => typeof openSediment === "function" && openSediment() },
    { id: "settings", title: t("ckBuildCmdListtitleT118"), icon: "gear", group: t("ckGroupView"), run: () => openSettings() },
    { id: "mode-agent", title: t("ckBuildCmdListtitleT119"), icon: "robot", group: t("ckGroupMode"), run: () => window.setAgentMode && setAgentMode("agent") },
    { id: "mode-plan", title: t("ckBuildCmdListtitleT120"), icon: "target", group: t("ckGroupMode"), run: () => window.setAgentMode && setAgentMode("plan") },
    { id: "mode-ask", title: t("ckBuildCmdListtitleT121"), icon: "user", group: t("ckGroupMode"), run: () => window.setAgentMode && setAgentMode("ask") },
    { id: "model", title: t("pickModelTip"), icon: "layers", group: t("ckGroupMode"), run: () => { const c = document.getElementById("btnModelChip"); if (c) c.click(); } },
    { id: "shortcuts", title: t("ckBuildCmdListtitleT122"), icon: "keyboard", group: t("ckGroupHelp"), run: () => openShortcuts() },
    { id: "logout", title: t("ckBuildCmdListtitleT123"), icon: "close", group: t("ckGroupAccount"), run: () => doLogout() },
  ];
  const files = Object.keys(state.files || {}).sort().map((f) => ({ id: "file:" + f, title: f, icon: "files", group: t("ckBuildCmdListgroupT1"), run: () => openFile(f) }));
  return acts.concat(files);
}
function renderCmdk(filter) {
  filter = (filter || "").toLowerCase().trim();
  const list = $("cmdkList");
  const all = buildCmdList();
  _cmdkItems = filter ? all.filter((c) => c.title.toLowerCase().includes(filter) || c.id.toLowerCase().includes(filter)) : all;
  if (!_cmdkItems.length) { list.innerHTML = '<div class="cmdk-empty">' + t("ckRenderCmdkH40") + '</div>'; return; }
  let html = "", lastGroup = null;
  _cmdkItems.forEach((c, i) => {
    if (c.group && c.group !== lastGroup) { html += '<div class="cmdk-group">' + esc(c.group) + '</div>'; lastGroup = c.group; }
    html += '<div class="cmdk-item' + (i === 0 ? " active" : "") + '" data-i="' + i + '" role="option"><i class="ico" data-ico="' + c.icon + '"></i><span class="cmdk-label">' + esc(c.title) + '</span></div>';
  });
  list.innerHTML = html;
  list.querySelectorAll(".cmdk-item").forEach((el) => {
    el.onclick = (ev) => { ev.stopPropagation(); runCmdk(parseInt(el.dataset.i)); };
    el.onmousemove = () => setCmdkActive(parseInt(el.dataset.i));
  });
  replaceIcons(list);
}
function setCmdkActive(i) {
  const items = $("cmdkList").querySelectorAll(".cmdk-item");
  items.forEach((el, j) => el.classList.toggle("active", j === i));
}
function currentCmdkIndex() {
  const items = $("cmdkList").querySelectorAll(".cmdk-item");
  for (let i = 0; i < items.length; i++) if (items[i].classList.contains("active")) return i;
  return 0;
}
function runCmdk(i) {
  const c = _cmdkItems[i]; if (!c) return;
  $("cmdk").classList.add("hidden");
  c.run();
}
function openCmdk() {
  $("cmdk").classList.remove("hidden");
  const inp = $("cmdkInput");
  inp.value = "";
  renderCmdk("");
  setTimeout(() => inp.focus(), 0);
}
function closeCmdk() { $("cmdk").classList.add("hidden"); }

/* 命令面板键盘交互 */
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "P" || e.key === "p")) {
    e.preventDefault(); openCmdk(); return;
  }
  if (!$("cmdk") || $("cmdk").classList.contains("hidden")) return;
  if (e.key === "Escape") { closeCmdk(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); setCmdkActive((currentCmdkIndex() + 1) % Math.max(_cmdkItems.length, 1)); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setCmdkActive((currentCmdkIndex() - 1 + _cmdkItems.length) % Math.max(_cmdkItems.length, 1)); }
  else if (e.key === "Enter") { e.preventDefault(); runCmdk(currentCmdkIndex()); }
});
$("cmdkInput").addEventListener("input", (e) => renderCmdk(e.target.value));
