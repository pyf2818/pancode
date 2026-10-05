/* ============================================================
   pancode 命令面板（Ctrl/⌘+Shift+P）
   依赖全局：getTheme / applyTheme / togglePreview / openEvolutionCodex /
            openSettings / openFile / state / esc / replaceIcons / $（运行时解析）
   ============================================================ */
"use strict";

let _cmdkItems = [];
function buildCmdList() {
  const acts = [
    { id: "ship", title: "一键全流程交付（工作流模板）", icon: "sparkle", group: "交付", run: () => openWorkflowPop() },
    { id: "workflow", title: "打开工作流面板", icon: "tasklist", group: "交付", run: () => openWorkflowPop(true) },
    { id: "commit", title: "提交当前改动（Git）", icon: "branch", group: "交付", run: () => openCommit() },
    { id: "newfile", title: "新建文件", icon: "filePlus", group: "文件", run: () => promptNewFile("") },
    { id: "newdir", title: "新建文件夹", icon: "filePlus", group: "文件", run: () => { const p = prompt("新建文件夹（相对路径）：", "newdir"); if (p) send({ type: "file.mkdir", path: p }); } },
    { id: "save", title: "保存当前文件", icon: "save", group: "文件", run: () => saveActiveFile() },
    { id: "closetab", title: "关闭当前标签", icon: "close", group: "文件", run: () => { if (window.state && state.activeFile) closeTab(state.activeFile); } },
    { id: "newconv", title: "新建对话", icon: "robot", group: "会话", run: () => startNewConv(true) },
    { id: "ai-explain", title: "AI：解释当前文件", icon: "search", group: "AI", run: () => aiCurrentFile("请阅读并解释当前打开的文件，说明其功能、关键逻辑和设计思路。") },
    { id: "ai-fix", title: "AI：修复当前文件的错误", icon: "sparkle", group: "AI", run: () => aiCurrentFile("请检查当前打开的文件中的错误和问题，并修复它们。先运行测试确认问题，修复后再验证。") },
    { id: "ai-test", title: "AI：为当前文件生成测试", icon: "tasklist", group: "AI", run: () => aiCurrentFile("请为当前打开的文件生成单元测试，覆盖主要功能和边界情况。") },
    { id: "ai-refactor", title: "AI：重构当前文件", icon: "branch", group: "AI", run: () => aiCurrentFile("请重构当前打开的文件，改善代码结构、可读性和可维护性，但不改变功能。") },
    { id: "ai-review", title: "AI：审查当前文件", icon: "eye", group: "AI", run: () => aiCurrentFile("请对当前打开的文件进行代码审查，指出潜在问题和改进建议。") },
    { id: "theme", title: "切换主题（深色 / 浅色）", icon: getTheme() === "light" ? "moon" : "sun", group: "视图", run: () => applyTheme(getTheme() === "light" ? "dark" : "light") },
    { id: "preview", title: "切换 HTML / Markdown 预览", icon: "eye", group: "视图", run: () => togglePreview() },
    { id: "switch", title: "切换 Editor / Agents 窗口", icon: "robot", group: "视图", run: () => switchMode((window.state && window.state.mode === "editor") ? "agents" : "editor") },
    { id: "evo", title: "打开进化树", icon: "tree", group: "视图", run: () => openEvolutionCodex() },
    { id: "automations", title: "自动化任务（定时跑测试 / 依赖审计）", icon: "clock", group: "交付", run: () => typeof openAutomations === "function" && openAutomations() },
    { id: "sediment", title: "沉淀本次会话（规则 / 记忆）", icon: "save", group: "交付", run: () => typeof openSediment === "function" && openSediment() },
    { id: "settings", title: "打开设置（模型 / 外观 / Agent）", icon: "gear", group: "视图", run: () => openSettings() },
    { id: "mode-agent", title: "模式：Agent 执行（说做就做）", icon: "robot", group: "模式", run: () => window.setAgentMode && setAgentMode("agent") },
    { id: "mode-plan", title: "模式：Plan 只读规划", icon: "target", group: "模式", run: () => window.setAgentMode && setAgentMode("plan") },
    { id: "mode-ask", title: "模式：Ask 仅问答（不调工具）", icon: "user", group: "模式", run: () => window.setAgentMode && setAgentMode("ask") },
    { id: "model", title: "选择模型", icon: "layers", group: "模式", run: () => { const c = document.getElementById("btnModelChip"); if (c) c.click(); } },
    { id: "shortcuts", title: "查看键盘快捷键", icon: "keyboard", group: "帮助", run: () => openShortcuts() },
    { id: "logout", title: "退出登录", icon: "close", group: "账户", run: () => doLogout() },
  ];
  const files = Object.keys(state.files || {}).sort().map((f) => ({ id: "file:" + f, title: f, icon: "files", group: "打开文件", run: () => openFile(f) }));
  return acts.concat(files);
}
function renderCmdk(filter) {
  filter = (filter || "").toLowerCase().trim();
  const list = $("cmdkList");
  const all = buildCmdList();
  _cmdkItems = filter ? all.filter((c) => c.title.toLowerCase().includes(filter) || c.id.toLowerCase().includes(filter)) : all;
  if (!_cmdkItems.length) { list.innerHTML = '<div class="cmdk-empty">无匹配结果</div>'; return; }
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
