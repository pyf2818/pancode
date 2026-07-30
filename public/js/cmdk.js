/* ============================================================
   pancode 命令面板（Ctrl/⌘+Shift+P）
   依赖全局：getTheme / applyTheme / togglePreview / openEvolutionCodex /
            openSettings / openFile / state / esc / replaceIcons / $（运行时解析）
   ============================================================ */
"use strict";

let _cmdkItems = [];
function buildCmdList() {
  const acts = [
    { id: "theme", title: "切换主题（深色 / 浅色）", icon: getTheme() === "light" ? "moon" : "sun", group: "视图", run: () => applyTheme(getTheme() === "light" ? "dark" : "light") },
    { id: "preview", title: "切换 HTML / Markdown 预览", icon: "eye", group: "视图", run: () => togglePreview() },
    { id: "evo", title: "打开进化树", icon: "tree", group: "视图", run: () => openEvolutionCodex() },
    { id: "settings", title: "打开模型设置", icon: "robot", group: "视图", run: () => openSettings() },
    { id: "logout", title: "退出登录", icon: "close", group: "账户", run: () => { localStorage.removeItem("cw-user-token"); location.reload(); } },
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
    el.onclick = () => runCmdk(parseInt(el.dataset.i));
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
