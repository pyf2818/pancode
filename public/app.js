/* ============================================================
   pancode 前端 v2.0 — Monaco 可写编辑器 + WebSocket 实时通信
   - 编辑器真实保存（Ctrl+S）、脏标记、外部变更同步
   - 文件树 CRUD：新建 / 重命名 / 删除（右键菜单）
   - 服务端全文搜索、Git 基线 Diff、LLM 设置面板
   ============================================================ */
"use strict";

/* B2：状态集中化——把分散的 previewOn/previewZoom/evoData/evoTab 收编为 Store 访问器（既有读写点零改动） */
(function () {
  if (!window.Store) return;
  const map = { previewOn: "preview.on", previewZoom: "preview.zoom", evoData: "evo.data", evoTab: "evo.tab" };
  Object.keys(map).forEach((name) => {
    if (Object.getOwnPropertyDescriptor(window, name)) return;
    Object.defineProperty(window, name, {
      configurable: true,
      get() { return window.Store.get(map[name]); },
      set(v) { window.Store.set(map[name], v); },
    });
  });
})();
const LANG_NAME = { javascript: "JavaScript", typescript: "TypeScript", markdown: "Markdown", json: "JSON", html: "HTML", css: "CSS", python: "Python", shell: "Shell", yaml: "YAML", plaintext: "Plain Text" };

const state = {
  mode: "editor",
  files: {},            // { path: {content, original, isNew, lang} }
  openTabs: [],
  activeFile: null,
  dirty: new Set(),     // 有未保存编辑的文件
  running: false,
  round: 0,
  monacoReady: false,
  booted: false,
  engine: null,         // { mode, model, ... }
  agent: null,          // { permissions, persona, rules, context, memory }
  planMode: false,      // 规划模式：仅只读/规划，禁止修改文件与执行命令
  project: "workspace",
  workspace: null,      // 当前工作区绝对路径（hello 事件设置）
  lsp: null,            // 后端下发的 LSP 能力清单（hello 事件设置）
  lspClients: {},       // 语言 -> LspClient 实例（按需懒加载）
};
let editor = null, diffEditor = null;
const models = {};

function modifiedSet() {
  const s = new Set();
  for (const p in state.files) {
    if (state.files[p].isNew || state.files[p].content !== state.files[p].original) s.add(p);
  }
  return s;
}
function diffStat(a, b) {
  const cnt = (arr) => { const m = {}; arr.forEach((l) => (m[l] = (m[l] || 0) + 1)); return m; };
  const A = cnt(a.split("\n")), B = cnt(b.split("\n"));
  let add = 0, del = 0;
  for (const l in B) { const d = B[l] - (A[l] || 0); if (d > 0) add += d; }
  for (const l in A) { const d = A[l] - (B[l] || 0); if (d > 0) del += d; }
  return { add, del };
}

/* ---------------- 共享组件（双窗口间搬运） ---------------- */
const chatStream = document.createElement("div");
chatStream.id = "chatStream";

const inputBox = document.createElement("div");
inputBox.id = "chatInputBox";
inputBox.innerHTML =
  '<div id="ctxBarWrap" title="上下文用量" style="display:none"><div id="ctxBarFill"></div><span id="ctxBarTxt"></span></div>' +
  '<div id="ciSkillBar" class="ci-skill-bar">' +
    '<button id="btnSkillPick" class="ci-skill-pick" title="选择 Skill 引用到对话"><i data-ico="sparkle"></i>Skill</button>' +
    '<div id="ciSkillPop" class="ci-skill-pop" style="display:none"></div>' +
    '<span id="ciSkillActive" class="ci-skill-active" style="display:none"></span>' +
  '</div>' +
  '<div id="ciChips"></div>' +
  '<textarea id="chatInput" rows="2" placeholder="向 AI 描述你的任务；支持 @file:路径 / @folder:路径 引用，可粘贴或拖入图片…"></textarea>' +
  '<div class="ci-bottom">' +
    '<button id="btnAttach" class="ci-tool" title="添加图片附件（也可直接粘贴 / 拖拽）">' + ico("filePlus") + "</button>" +
    '<button id="btnPlanMode" class="ci-tool ci-plan" title="规划模式：仅可读 / 检索 / 规划，禁止修改文件或执行命令">规划</button>' +
    '<select id="ciPerm" class="ci-perm" title="Agent 权限模式">' +
      '<option value="ask">权限：逐项确认</option>' +
      '<option value="semi">权限：半自动</option>' +
      '<option value="auto">权限：全自动</option>' +
    "</select>" +
    '<span class="ci-hint">Enter 发送</span>' +
  '<button id="btnSend">' + ico("send") + "发送</button></div>";

const terminal = document.createElement("div");
terminal.id = "terminal";
terminal.innerHTML =
  '<div id="termTabs" class="term-tabs"></div>' +
  '<div id="termLines"><div class="tl"><span class="tl-dim">pancode 集成终端 — 命令在服务端 workspace/ 目录真实执行（Ctrl+C 中断）</span></div></div>' +
  '<div id="termInputRow"><span class="tl-prompt">user@pancode</span><span class="tl-dim">:</span><span class="tl-info" id="termCwd">~/workspace</span><span class="tl-dim">$&nbsp;</span><input id="termInput" spellcheck="false" autocomplete="off" placeholder="输入命令，如 node tests/run-tests.js"><button id="termKill" title="中断当前命令 (Ctrl+C)">' + ico("stop") + "</button></div>";

function mountShared() {
  if (state.mode === "editor") {
    $("chatSlotEditor").appendChild(chatStream);
    $("chatInputEditor").appendChild(inputBox);
    $("terminalSlotEditor").appendChild(terminal);
  } else {
    $("chatSlotAgents").appendChild(chatStream);
    $("chatInputAgents").appendChild(inputBox);
    $("terminalSlotAgents").appendChild(terminal);
  }
  chatStream.scrollTop = chatStream.scrollHeight;
  const tl = $("termLines"); if (tl) tl.scrollTop = tl.scrollHeight;
}

/* ---------------- 模式切换 ---------------- */
function switchMode(mode) {
  state.mode = mode;
  $("editorWindow").style.display = mode === "editor" ? "flex" : "none";
  $("agentsWindow").style.display = mode === "agents" ? "flex" : "none";
  $("statusbar").style.display = mode === "editor" ? "flex" : "none";
  $("btnModeEditor").classList.toggle("active", mode === "editor");
  $("btnModeAgents").classList.toggle("active", mode === "agents");
  mountShared();
  if (mode === "editor" && editor) setTimeout(() => editor.layout(), 30);
}
$("btnModeEditor").onclick = () => switchMode("editor");
$("btnModeAgents").onclick = () => switchMode("agents");

/* ---------------- 文件树（含右键菜单 + 文件夹折叠） ---------------- */
const collapsedDirs = {};  // { dirName: true } 记录折叠的目录
function renderTree() {
  const tree = $("fileTree");
  if (!tree) return;
  tree.innerHTML = "";
  const mod = modifiedSet();
  const dirs = {}, roots = [];
  Object.keys(state.files).sort().forEach((p) => {
    const parts = p.split("/");
    if (parts.length === 1) roots.push(p);
    else (dirs[parts[0]] = dirs[parts[0]] || []).push(p);
  });
  const badge = (p) => {
    if (state.dirty.has(p)) return '<span class="ft-mod ft-dirty" title="未保存">●</span>';
    if (state.files[p] && state.files[p].isNew) return '<span class="ft-mod ft-new" title="新文件">U</span>';
    if (mod.has(p)) return '<span class="ft-mod" title="已修改">M</span>';
    return "";
  };
  const mkItem = (path, depth) => {
    const el = document.createElement("div");
    el.className = "ft-item" + (state.activeFile === path ? " active" : "");
    el.style.paddingLeft = 14 + depth * 14 + "px";
    el.innerHTML = fileIco(path) + "<span>" + esc(path.split("/").pop()) + "</span>" + badge(path);
    el.onclick = () => openFile(path);
    el.oncontextmenu = (e) => { e.preventDefault(); showCtxMenu(e, path); };
    tree.appendChild(el);
  };
  Object.keys(dirs).sort().forEach((dir) => {
    const collapsed = !!collapsedDirs[dir];
    const head = document.createElement("div");
    head.className = "ft-item ft-dir-head" + (collapsed ? " collapsed" : "");
    head.style.paddingLeft = "14px";
    head.innerHTML = '<span class="ft-dir-toggle">' + ico("chevR") + '</span><span class="ft-dir">' + ico("folder") + "</span><b>" + esc(dir) + '</b><span class="ft-dir-count">' + dirs[dir].length + '</span>';
    head.onclick = () => { collapsedDirs[dir] = !collapsedDirs[dir]; renderTree(); };
    head.oncontextmenu = (e) => { e.preventDefault(); showCtxMenu(e, dir, true); };
    tree.appendChild(head);
    if (!collapsed) dirs[dir].sort().forEach((p) => mkItem(p, 1));
  });
  roots.forEach((p) => mkItem(p, 0));
}

/* 右键菜单 */
function showCtxMenu(e, path, isDir) {
  const menu = $("ctxMenu");
  const items = isDir
    ? [
        { key: "newFileHere", ic: "filePlus", fn: () => promptNewFile(path + "/") },
        { key: "deleteDir", ic: "trash", danger: true, fn: () => { if (confirm(t("deleteDirConfirm") + " " + path + "？")) send({ type: "file.delete", path }); } },
      ]
    : [
        { key: "open", ic: "files", fn: () => openFile(path) },
        { key: "rename", ic: "edit", fn: () => {
            const np = prompt(t("renamePrompt"), path);
            if (np && np !== path) send({ type: "file.rename", path, newPath: np });
          } },
        { key: "viewDiff", ic: "diff", fn: () => showDiff(path) },
        { key: "delete", ic: "trash", danger: true, fn: () => { if (confirm(t("deleteConfirm") + " " + path + "？")) send({ type: "file.delete", path }); } },
      ];
  menu.innerHTML = "";
  items.forEach((it) => {
    const d = document.createElement("div");
    d.className = "ctx-item" + (it.danger ? " danger" : "");
    d.innerHTML = ico(it.ic) + esc(t(it.key));
    d.onclick = () => { hideCtxMenu(); it.fn(); };
    menu.appendChild(d);
  });
  menu.style.display = "block";
  menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - items.length * 34 - 12) + "px";
}
function hideCtxMenu() { $("ctxMenu").style.display = "none"; }
document.addEventListener("click", hideCtxMenu);

function promptNewFile(prefix) {
  const p = prompt("新建文件（相对路径）：", (prefix || "") + "untitled.js");
  if (!p) return;
  send({ type: "file.create", path: p, content: "" });
  setTimeout(() => openFile(p), 300);
}
$("btnNewFile").onclick = () => promptNewFile("");
$("btnNewFolder").onclick = () => {
  const p = prompt("新建文件夹（相对路径）：", "newdir");
  if (p) send({ type: "file.mkdir", path: p });
};

/* ---------------- Monaco（可写 + 保存） ---------------- */
function bootMonaco() {
  // 本地化的 Monaco：内核、worker、语言包全部来自 /vendor/monaco，彻底离线可用
  self.MonacoEnvironment = {
    getWorkerUrl: function () {
      return "/vendor/monaco/worker.js";
    },
  };
  require.config({ paths: { vs: "/vendor/monaco/vs" } });
  require(["vs/editor/editor.main"], () => {
    state.monacoReady = true;
    editor = monaco.editor.create($("monacoHost"), {
      theme: getTheme() === "light" ? "vs" : "vs-dark",
      automaticLayout: true,
      minimap: { enabled: true, renderCharacters: true },
      fontSize: 13.5,
      fontFamily: "Cascadia Code, JetBrains Mono, Consolas, monospace",
      smoothScrolling: true,
      cursorBlinking: "smooth",
      renderLineHighlight: "all",
      scrollBeyondLastLine: false,
      padding: { top: 8 },
    });
    editor.onDidChangeCursorPosition((e) => {
      $("sbCursor").textContent = "行 " + e.position.lineNumber + ", 列 " + e.position.column;
    });
    /* Ctrl+S 真实保存到服务端 */
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActiveFile);
    if (state.booted && !state.openTabs.length) {
      const names = Object.keys(state.files);
      const first = names.find((p) => /^readme\.md$/i.test(p)) || names[0];
      if (first) openFile(first);
    }
  }, () => {
    $("monacoHost").innerHTML = '<div id="monacoFallback">Monaco 编辑器加载失败（请刷新；若仍失败请检查 /vendor/monaco 资源是否完整）<br>对话 / 终端 / Agent 功能不受影响。</div>';
  });
}

function fmtSize(n) {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function getModel(path) {
  const f = state.files[path];
  if (f.binary) {
    // 二进制文件（Word/图片/压缩包等）：只读占位提示，绝不加载/保存真实内容
    if (!models[path]) {
      const tip = [
        "",
        "  " + path,
        "",
        "  该文件是二进制文件（" + fmtSize(f.size) + "），无法以文本方式显示或编辑。",
        "  Word / Excel / PDF / 图片 / 压缩包等请用对应的本地应用打开。",
        "",
        "  pancode 不会读取或修改此文件，请放心。",
        "",
      ].join("\n");
      models[path] = monaco.editor.createModel(tip, "plaintext", monaco.Uri.parse("inmemory:///" + path));
    }
    return models[path];
  }
  if (!models[path]) {
    const m = monaco.editor.createModel(f.content, f.lang, monaco.Uri.parse("inmemory:///" + path));
    m.onDidChangeContent(() => {
      const disk = state.files[path] ? state.files[path].content : "";
      const isDirty = m.getValue() !== disk;
      if (isDirty !== state.dirty.has(path)) {
        if (isDirty) state.dirty.add(path); else state.dirty.delete(path);
        renderTabs(); renderTree();
      }
      if (previewOn && isPreviewable(path) && path === state.activeFile) schedulePreview();
      lspChange(path);   // 编辑后防抖通知语言服务器（实时诊断/补全）
      // 绑定滚动同步（避免重复绑）
      if (previewOn && models[path] && !models[path]._previewScrollBound) {
        models[path]._previewScrollBound = true;
      }
    });
    models[path] = m;
    lspOpen(path, m, f.lang);   // 该语言启用 LSP 时，把文档交给真实语言服务器（诊断/补全/跳转）
  }
  return models[path];
}

/* ---------- 真实 LSP 客户端调度（按语言懒加载，单客户端复用多文档） ---------- */
function lspLangEnabled(lang) {
  return !!(state.lsp && state.lsp.enabled && state.lsp.servers && state.lsp.servers[lang] && state.lsp.servers[lang].enabled);
}
function lspRootUri() { return "file:///" + (state.workspace || "").replace(/\\/g, "/"); }
function lspEnsureClient(lang) {
  if (!lspLangEnabled(lang)) return null;
  if (state.lspClients[lang]) return state.lspClients[lang];
  if (typeof LspClient === "undefined") return null;
  const client = new LspClient({ language: lang, rootUri: lspRootUri(), getToken: () => AUTH.token });
  client.connect();
  state.lspClients[lang] = client;
  return client;
}
function lspOpen(relPath, model, lang) {
  const client = lspEnsureClient(lang);
  if (!client || client.models.has(relPath)) return;
  client.openModel(relPath, model);
}
const _lspChangeTimers = {};
function lspChange(relPath) {
  const t = _lspChangeTimers[relPath]; if (t) clearTimeout(t);
  _lspChangeTimers[relPath] = setTimeout(() => {
    for (const lang in state.lspClients) {
      if (state.lspClients[lang].models.has(relPath)) { state.lspClients[lang].changeModel(relPath); break; }
    }
  }, 400);
}
function lspClose(relPath) {
  for (const lang in state.lspClients) {
    if (state.lspClients[lang].models.has(relPath)) { state.lspClients[lang].closeModel(relPath); break; }
  }
}
function lspDisposeAll() {
  for (const lang in state.lspClients) { try { state.lspClients[lang].dispose(); } catch (e) {} }
  state.lspClients = {};
  for (const k in _lspChangeTimers) clearTimeout(_lspChangeTimers[k]);
}

function saveActiveFile() {
  const p = state.activeFile;
  if (!p || !models[p] || !state.dirty.has(p)) return;
  if (state.files[p] && state.files[p].binary) return; // 二进制文件永不保存
  send({ type: "file.save", path: p, content: models[p].getValue() });
}

/* ---------- 主题（浅色 / 深色） ---------- */
function getTheme() { return localStorage.getItem("cw-theme") || "dark"; }
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("cw-theme", t);
  const btn = $("btnTheme");
  if (btn) btn.innerHTML = ico(t === "light" ? "moon" : "sun");
  if (state.monacoReady && editor) editor.updateOptions({ theme: t === "light" ? "vs" : "vs-dark" });
  if (diffEditor) diffEditor.updateOptions({ theme: t === "light" ? "vs" : "vs-dark" });
}
$("btnTheme").onclick = () => applyTheme(getTheme() === "light" ? "dark" : "light");

/* ---------- 键盘快捷键帮助弹窗 ---------- */
function openShortcuts() {
  const m = $("shortcutsModal");
  if (m) m.style.display = "flex";
}
if ($("scClose")) $("scClose").onclick = () => { $("shortcutsModal").style.display = "none"; };
if ($("shortcutsModal")) {
  $("shortcutsModal").addEventListener("click", (e) => { if (e.target === $("shortcutsModal")) $("shortcutsModal").style.display = "none"; });
}

/* ---------- 一键提交改动弹窗（Git 一站式闭环） ---------- */
function openCommit() {
  const m = $("commitModal");
  if (!m) return;
  m.style.display = "flex";
  $("cmResult").textContent = ""; $("cmResult").className = "cm-result";
  const branch = $("cmBranch"), box = $("cmChanges");
  branch.textContent = "加载中…"; box.innerHTML = "";
  if ($("cmSummaryWrap")) $("cmSummaryWrap").style.display = "none";
  fetch("/api/git/status").then((r) => r.json()).then((d) => {
    if (!d.available) {
      branch.textContent = "当前工作区不是 Git 仓库（快照模式），无法提交";
      box.innerHTML = '<div class="cm-empty">未检测到 Git 仓库</div>';
      $("cmSubmit").disabled = true; return;
    }
    branch.textContent = "分支：" + d.branch;
    if (!d.changes || !d.changes.length) {
      box.innerHTML = '<div class="cm-empty">没有未提交的改动</div>';
      $("cmSubmit").disabled = true; return;
    }
    $("cmSubmit").disabled = false;
    const labels = { M: "修改", A: "新增", D: "删除" };
    box.innerHTML = "";
    d.changes.forEach((c) => {
      const row = document.createElement("label");
      row.className = "cm-item";
      const chk = document.createElement("input");
      chk.type = "checkbox"; chk.className = "cm-chk"; chk.checked = true; chk.dataset.path = c.path;
      const tag = document.createElement("span");
      tag.className = "cm-tag cm-" + c.status; tag.textContent = labels[c.status] || c.status;
      const p = document.createElement("span");
      p.className = "cm-path"; p.textContent = c.path;
      row.appendChild(chk); row.appendChild(tag); row.appendChild(p);
      box.appendChild(row);
    });
    const selAll = $("cmSelAll");
    if (selAll) selAll.checked = true;
    updateCmCount();
    $("cmMsg").value = "更新 " + d.changes.length + " 个文件";
  }).catch(() => { branch.textContent = "状态获取失败"; box.innerHTML = ""; });
}
/* 已选文件数 → 提交按钮可用性 + 计数 */
function updateCmCount() {
  const chks = Array.from(document.querySelectorAll("#cmChanges .cm-chk"));
  const n = chks.filter((c) => c.checked).length;
  const total = chks.length;
  const cnt = $("cmCount");
  if (cnt) cnt.textContent = total ? "已选 " + n + " / " + total : "";
  const sa = $("cmSelAll");
  if (sa && total) sa.checked = (n === total);
  if ($("cmSubmit")) $("cmSubmit").disabled = (total > 0 && n === 0);
  refreshCmSummary(); // 选择变化时同步刷新智能摘要（选择感知）
}
/* P9/P10：智能摘要面板（变更摘要 / 文档草稿 双视图） */
let cmView = "log", cmSummaryData = null, cmCurrentText = "";
function refreshCmSummary() {
  const wrap = $("cmSummaryWrap"); if (!wrap) return;
  const chks = Array.from(document.querySelectorAll("#cmChanges .cm-chk"));
  if (!chks.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  const files = chks.filter((c) => c.checked).map((c) => c.dataset.path);
  fetch("/api/git/summary", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files }),
  }).then((r) => r.json()).then((d) => {
    if (!d || !d.summary) { wrap.style.display = "none"; return; }
    cmSummaryData = d; renderCmSummary();
  }).catch(() => {});
}
function renderCmSummary() {
  if (!cmSummaryData) return;
  let text;
  if (cmView === "doc") {
    text = cmSummaryData.docDraft || "";
  } else {
    const s = cmSummaryData.summary || {};
    const lines = [];
    if (s.overview) lines.push(s.overview);
    if (Array.isArray(s.suggestions) && s.suggestions.length) {
      lines.push("", "建议");
      s.suggestions.forEach((t) => lines.push("- " + t));
    }
    text = lines.join("\n");
  }
  cmCurrentText = text;
  const body = $("cmSummary");
  if (body) body.textContent = cmCurrentText || "（暂无内容）";
}
function setCmTab(view) {
  cmView = view;
  const log = $("cmViewLog"), doc = $("cmViewDoc");
  if (log) log.classList.toggle("active", view === "log");
  if (doc) doc.classList.toggle("active", view === "doc");
}
if ($("cmViewLog")) $("cmViewLog").onclick = () => { setCmTab("log"); renderCmSummary(); };
if ($("cmViewDoc")) $("cmViewDoc").onclick = () => { setCmTab("doc"); renderCmSummary(); };
if ($("cmApplyMsg")) $("cmApplyMsg").onclick = () => {
  const msg = cmSummaryData && cmSummaryData.summary ? (cmSummaryData.summary.commitMsg || "") : cmCurrentText;
  if (msg && $("cmMsg")) $("cmMsg").value = msg.trim();
};
if ($("cmCopy")) $("cmCopy").onclick = () => {
  if (!cmCurrentText) return;
  const btn = $("cmCopy"); const old = btn ? btn.textContent : "复制";
  const done = () => { if (btn) btn.textContent = old; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(cmCurrentText)
      .then(() => { if (btn) { btn.textContent = "已复制 ✓"; setTimeout(done, 1200); } })
      .catch(done);
  }
};
if ($("cmSelAll")) $("cmSelAll").onchange = () => {
  document.querySelectorAll("#cmChanges .cm-chk").forEach((c) => { c.checked = $("cmSelAll").checked; });
  updateCmCount();
};
if ($("cmChanges")) $("cmChanges").addEventListener("change", (e) => { if (e.target.classList.contains("cm-chk")) updateCmCount(); });
if ($("cmClose")) $("cmClose").onclick = () => { $("commitModal").style.display = "none"; };
if ($("cmCancel")) $("cmCancel").onclick = () => { $("commitModal").style.display = "none"; };
if ($("commitModal")) {
  $("commitModal").addEventListener("click", (e) => { if (e.target === $("commitModal")) $("commitModal").style.display = "none"; });
}
if ($("cmSubmit")) $("cmSubmit").onclick = () => {
  const msg = $("cmMsg").value.trim();
  const files = Array.from(document.querySelectorAll("#cmChanges .cm-chk"))
    .filter((c) => c.checked).map((c) => c.dataset.path);
  const res = $("cmResult"); res.textContent = "提交中…"; res.className = "cm-result";
  fetch("/api/git/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: msg, files }) })
    .then((r) => r.json()).then((d) => {
      if (d.ok) { res.textContent = "已提交（" + d.committed + " 个文件）✓"; res.className = "cm-result ok"; setTimeout(() => { $("commitModal").style.display = "none"; }, 1200); }
      else { res.textContent = d.nothing ? "没有可提交的改动" : ("提交失败：" + (d.error || "")); res.className = "cm-result err"; }
    }).catch((e) => { res.textContent = "提交失败：" + e.message; res.className = "cm-result err"; });
};

/* ---------- 可拖拽分隔条（侧边栏 / 终端 / AI 聊天栏 / Agents 三栏） ---------- */
function initResizers() {
  /* 侧边栏宽度 */
  const sb = $("sidebar"), sbR = $("sidebarResizer");
  const w0 = parseInt(localStorage.getItem("cw-sidebar-w"));
  if (w0) sb.style.width = w0 + "px";
  let sx = null;
  sbR.addEventListener("mousedown", (e) => { sx = e.clientX; sbR.classList.add("dragging"); document.body.style.cursor = "col-resize"; e.preventDefault(); });
  window.addEventListener("mousemove", (e) => {
    if (sx === null) return;
    let w = sb.offsetWidth + (e.clientX - sx);
    w = Math.max(160, Math.min(520, w));
    sb.style.width = w + "px"; sx = e.clientX;
    if (state.monacoReady && editor) editor.layout();
  });
  window.addEventListener("mouseup", () => {
    if (sx === null) return; sx = null; sbR.classList.remove("dragging"); document.body.style.cursor = "";
    localStorage.setItem("cw-sidebar-w", sb.offsetWidth); if (editor) editor.layout();
  });
  /* 侧边栏双击完全缩回 */
  sbR.addEventListener("dblclick", () => {
    const ab = $("activitybar");
    if (sb.classList.contains("fully-collapsed")) {
      sb.classList.remove("fully-collapsed");
      sb.style.width = (parseInt(localStorage.getItem("cw-sidebar-w")) || 230) + "px";
    } else {
      sb.classList.add("fully-collapsed");
    }
    if (editor) editor.layout();
  });


  /* 终端高度 */
  const bp = $("bottomPanel"), pr = $("panelResizer");
  const h0 = parseInt(localStorage.getItem("cw-panel-h"));
  if (h0) bp.style.height = h0 + "px";
  let py = null;
  pr.addEventListener("mousedown", (e) => { py = e.clientY; pr.classList.add("dragging"); document.body.style.cursor = "row-resize"; e.preventDefault(); });
  window.addEventListener("mousemove", (e) => {
    if (py === null) return;
    let h = bp.offsetHeight - (e.clientY - py);
    h = Math.max(90, Math.min(window.innerHeight * 0.72, h));
    bp.style.height = h + "px"; py = e.clientY;
    if (state.monacoReady && editor) editor.layout();
  });
  window.addEventListener("mouseup", () => {
    if (py === null) return; py = null; pr.classList.remove("dragging"); document.body.style.cursor = "";
    localStorage.setItem("cw-panel-h", bp.offsetHeight); if (editor) editor.layout();
  });

  /* Editor 窗口：AI 聊天栏宽度 + 折叠 */
  const chat = $("chatPanel"), chatR = $("chatResizer");
  const chatW = parseInt(localStorage.getItem("cw-chat-w"));
  if (chatW) chat.style.width = chatW + "px";
  if (localStorage.getItem("cw-chat-collapsed") === "1") chat.classList.add("collapsed");
  let cx = null;
  chatR.addEventListener("mousedown", (e) => {
    if (chat.classList.contains("collapsed")) return;
    cx = e.clientX; chatR.classList.add("dragging"); document.body.style.cursor = "col-resize"; e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (cx === null) return;
    let w = chat.offsetWidth - (e.clientX - cx);   // 向左拖拽 → 聊天栏变宽
    w = Math.max(240, Math.min(640, w));
    chat.style.width = w + "px"; cx = e.clientX;
    if (state.monacoReady && editor) editor.layout();
  });
  window.addEventListener("mouseup", () => {
    if (cx === null) return; cx = null; chatR.classList.remove("dragging"); document.body.style.cursor = "";
    localStorage.setItem("cw-chat-w", chat.offsetWidth); if (editor) editor.layout();
  });
  chatR.addEventListener("dblclick", () => {
    if (chat.classList.contains("collapsed")) {
      chat.classList.remove("collapsed");
      chat.style.width = (parseInt(localStorage.getItem("cw-chat-w")) || 360) + "px";
      localStorage.setItem("cw-chat-collapsed", "0");
    } else {
      chat.classList.add("collapsed");
      localStorage.setItem("cw-chat-collapsed", "1");
    }
    if (editor) editor.layout();
  });

  /* Agents 窗口：左侧会话栏宽度 + 折叠 */
  const agS = $("agSessions"), agSR = $("agSessionsResizer");
  const agSW = parseInt(localStorage.getItem("cw-ag-sessions-w"));
  if (agSW) agS.style.width = agSW + "px";
  if (localStorage.getItem("cw-ag-sessions-collapsed") === "1") agS.classList.add("collapsed");
  let agsx = null;
  agSR.addEventListener("mousedown", (e) => {
    if (agS.classList.contains("collapsed")) return;
    agsx = e.clientX; agSR.classList.add("dragging"); document.body.style.cursor = "col-resize"; e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (agsx === null) return;
    let w = agS.offsetWidth + (e.clientX - agsx);   // 向右拖拽 → 左侧栏变宽
    w = Math.max(170, Math.min(360, w));
    agS.style.width = w + "px"; agsx = e.clientX;
  });
  window.addEventListener("mouseup", () => {
    if (agsx === null) return; agsx = null; agSR.classList.remove("dragging"); document.body.style.cursor = "";
    localStorage.setItem("cw-ag-sessions-w", agS.offsetWidth);
  });
  agSR.addEventListener("dblclick", () => {
    if (agS.classList.contains("collapsed")) {
      agS.classList.remove("collapsed");
      agS.style.width = (parseInt(localStorage.getItem("cw-ag-sessions-w")) || 250) + "px";
      localStorage.setItem("cw-ag-sessions-collapsed", "0");
    } else {
      agS.classList.add("collapsed");
      localStorage.setItem("cw-ag-sessions-collapsed", "1");
    }
  });

  /* Agents 窗口：右侧面板宽度 + 折叠 */
  const agR = $("agRight"), agRR = $("agRightResizer");
  const agRW = parseInt(localStorage.getItem("cw-ag-right-w"));
  if (agRW) agR.style.width = agRW + "px";
  if (localStorage.getItem("cw-ag-right-collapsed") === "1") agR.classList.add("collapsed");
  let agrx = null;
  agRR.addEventListener("mousedown", (e) => {
    if (agR.classList.contains("collapsed")) return;
    agrx = e.clientX; agRR.classList.add("dragging"); document.body.style.cursor = "col-resize"; e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (agrx === null) return;
    let w = agR.offsetWidth - (e.clientX - agrx);   // 向左拖拽 → 右侧栏变宽
    w = Math.max(200, Math.min(620, w));
    agR.style.width = w + "px"; agrx = e.clientX;
  });
  window.addEventListener("mouseup", () => {
    if (agrx === null) return; agrx = null; agRR.classList.remove("dragging"); document.body.style.cursor = "";
    localStorage.setItem("cw-ag-right-w", agR.offsetWidth);
  });
  agRR.addEventListener("dblclick", () => {
    if (agR.classList.contains("collapsed")) {
      agR.classList.remove("collapsed");
      agR.style.width = (parseInt(localStorage.getItem("cw-ag-right-w")) || 430) + "px";
      localStorage.setItem("cw-ag-right-collapsed", "0");
    } else {
      agR.classList.add("collapsed");
      localStorage.setItem("cw-ag-right-collapsed", "1");
    }
  });

  /* 预览面板：宽度调整 - 完全照搬侧边栏模式 */
  const hp = $("htmlPreview"), pvR = $("previewResizer");
  let px = null, pvSW = 0;
  const pvW0 = parseInt(localStorage.getItem("cw-preview-w"));
  if (pvW0 && hp.classList.contains("show")) { hp.style.flex = "none"; hp.style.width = pvW0 + "px"; hp.classList.add("sized"); pvSW = pvW0; }
  pvR.addEventListener("mousedown", (e) => {
    if (!hp.classList.contains("show")) return;
    hp.style.flex = "none"; hp.classList.add("sized");
    pvSW = hp.getBoundingClientRect().width || pvSW;
    px = e.clientX; pvR.classList.add("dragging"); document.body.style.cursor = "col-resize"; e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (px === null) return;
    var w = pvSW - (e.clientX - px);
    w = Math.max(200, Math.min(window.innerWidth * 0.65, w));
    hp.style.width = w + "px"; px = e.clientX; pvSW = w;
    if (state.monacoReady && editor) editor.layout();
  });
  window.addEventListener("mouseup", () => {
    if (px === null) return; px = null; pvR.classList.remove("dragging"); document.body.style.cursor = "";
    localStorage.setItem("cw-preview-w", hp.offsetWidth || pvSW); if (editor) editor.layout();
  });
  pvR.addEventListener("dblclick", () => {
    hp.style.flex = "1"; hp.style.width = ""; hp.classList.remove("sized");
    localStorage.removeItem("cw-preview-w"); if (editor) editor.layout();
  });

  /* 预览缩放（类浏览器 zoom + 滚动容器，方向自然） */
  const zoomIn = $("hpZoomIn"), zoomOut = $("hpZoomOut"), zoomReset = $("hpZoomReset");
  const stepZoom = (d) => { previewZoom = Math.max(0.25, Math.min(3, Math.round((previewZoom + d) * 100) / 100)); applyPreviewZoom(); };
  if (zoomIn) zoomIn.onclick = () => stepZoom(0.1);
  if (zoomOut) zoomOut.onclick = () => stepZoom(-0.1);
  if (zoomReset) zoomReset.onclick = () => { previewZoom = 1; applyPreviewZoom(); };
  window.addEventListener("keydown", (e) => {
    if (!previewOn) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === "=" || e.key === "+")) { e.preventDefault(); stepZoom(0.1); }
    else if (ctrl && e.key === "-") { e.preventDefault(); stepZoom(-0.1); }
    else if (ctrl && e.key === "0") { e.preventDefault(); previewZoom = 1; applyPreviewZoom(); }
  });
}

/* ---------- 二进制预览（对齐 VS Code：图片内置预览 / Word 类似 Office Viewer） ---------- */
const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico"]);
function extOf(p) { return String(p).split(".").pop().toLowerCase(); }

function showBinPreview(path) {
  const host = $("binPreview"), body = $("binPreviewBody");
  $("editorRow").style.display = "none";
  host.style.display = "block";
  const ext = extOf(path);
  const f = state.files[path];
  const enc = encodeURIComponent(path);
  if (IMG_EXTS.has(ext)) {
    body.innerHTML = '<div class="bp-img-wrap"><img src="/api/raw?path=' + enc + '&t=' + Date.now() + '" alt=""><div class="bp-meta">' + esc(path) + " · " + fmtSize(f.size) + "</div></div>";
    return;
  }
  if (ext === "pdf") {
    body.innerHTML = '<iframe class="bp-pdf" src="/api/raw?path=' + enc + '"></iframe>';
    return;
  }
  if (ext === "docx") {
    body.innerHTML = '<div class="bp-doc-loading">正在解析 Word 文档…</div>';
    fetch("/api/preview/docx?path=" + enc).then((r) => r.json()).then((d) => {
      if (state.activeFile !== path) return;  // 用户已切走
      if (d.ok) {
        body.innerHTML = '<div class="bp-doc-page">' + d.html + '</div><div class="bp-meta">' + esc(path) + " · " + fmtSize(f.size) + " · 只读预览（编辑请用 Word/WPS）</div>";
      } else {
        body.innerHTML = '<div class="bp-doc-loading">预览失败：' + esc(d.error || "未知错误") + "</div>";
      }
    }).catch((e) => { body.innerHTML = '<div class="bp-doc-loading">预览失败：' + esc(e.message) + "</div>"; });
    return;
  }
  // 其他二进制：保持信息占位
  body.innerHTML = '<div class="bp-doc-loading">' + esc(path) + '<br><br>该文件是二进制文件（' + fmtSize(f.size) + '），暂不支持预览。<br>请用对应的本地应用打开。</div>';
}

function hideBinPreview() {
  $("binPreview").style.display = "none";
  $("binPreviewBody").innerHTML = "";
  $("editorRow").style.display = "flex";
}

/* ---------- HTML / Markdown 实时预览 ---------- */
const PREVIEW_EXTS = new Set(["html", "htm", "md", "markdown"]);
const MD_CSS =
  "body{margin:0;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;font-size:15px;line-height:1.75;color:#222;background:#fff}" +
  ".md-body{max-width:860px;margin:0 auto;padding:32px 40px}" +
  "h1,h2,h3,h4{line-height:1.3;margin:1.1em 0 .5em;color:#111}h1{border-bottom:1px solid #eaeaea;padding-bottom:.3em}" +
  "code{background:#f0f0f0;padding:1px 5px;border-radius:4px;font-family:Consolas,monospace;font-size:13px;color:#c0392b}" +
  "pre{background:#1e1e2e;color:#e6e6e6;padding:12px 14px;border-radius:8px;overflow-x:auto}pre code{background:none;color:inherit;padding:0}" +
  "blockquote{margin:1em 0;padding:.4em 1em;border-left:4px solid #0a6ebd;background:#f3f7fb;color:#555}" +
  "table{border-collapse:collapse;margin:1em 0}th,td{border:1px solid #ddd;padding:6px 12px;font-size:14px}" +
  "img{max-width:100%}a{color:#0a6ebd;text-decoration:none}a:hover{text-decoration:underline}hr{border:none;border-top:1px solid #eaeaea;margin:1.4em 0}";
let previewTimer = null;
function isPreviewable(p) { return PREVIEW_EXTS.has(extOf(p)); }

function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const inline = (t) => esc(t)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = []; let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>"); continue;
    }
    if (/^###### /.test(ln)) { out.push("<h6>" + inline(ln.slice(7)) + "</h6>"); i++; continue; }
    if (/^##### /.test(ln)) { out.push("<h5>" + inline(ln.slice(6)) + "</h5>"); i++; continue; }
    if (/^#### /.test(ln)) { out.push("<h4>" + inline(ln.slice(5)) + "</h4>"); i++; continue; }
    if (/^### /.test(ln)) { out.push("<h3>" + inline(ln.slice(4)) + "</h3>"); i++; continue; }
    if (/^## /.test(ln)) { out.push("<h2>" + inline(ln.slice(3)) + "</h2>"); i++; continue; }
    if (/^# /.test(ln)) { out.push("<h1>" + inline(ln.slice(2)) + "</h1>"); i++; continue; }
    if (/^---+$/.test(ln)) { out.push("<hr>"); i++; continue; }
    if (/^&gt; |^> /.test(ln)) {
      const q = [];
      while (i < lines.length && /^&gt; |^> /.test(lines[i])) { q.push(lines[i].replace(/^&gt; |^> /, "")); i++; }
      out.push("<blockquote>" + inline(q.join("\n")).replace(/\n/g, "<br>") + "</blockquote>"); continue;
    }
    if (/^(-|\*|\d+\.)\s/.test(ln)) {
      const ord = /^\d+\./.test(ln); const items = [];
      while (i < lines.length && /^(-|\*|\d+\.)\s/.test(lines[i])) { items.push("<li>" + inline(lines[i].replace(/^(-|\*|\d+\.)\s/, "")) + "</li>"); i++; }
      out.push("<" + (ord ? "ol" : "ul") + ">" + items.join("") + "</" + (ord ? "ol" : "ul") + ">");
      continue;
    }
    if (ln.trim() === "") { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#|##|###|####|#####|######|```|&gt;|> |--+|[-*]\s|\d+\.\s)/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push("<p>" + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>");
  }
  return out.join("\n");
}

function applyPreviewZoom() {
  const frame = $("hpFrame");
  if (frame) frame.style.zoom = previewZoom;
  const txt = $("hpZoomTxt");
  if (txt) txt.textContent = Math.round(previewZoom * 100) + "%";
}

/* 预览滚动同步：编辑器 <-> iframe 双向跟随（postMessage 桥）
   预览 iframe 已改为 sandbox="allow-scripts"（去掉 allow-same-origin，杜绝预览内脚本
   反咬父页面 pancode），iframe 因此是不透明源，无法再直读 contentDocument/scrollHeight。
   改用 postMessage 跨源桥同步滚动位置，且不回退任何 UX。 */
const PREVIEW_BRIDGE = '<script>(function(){var P=function(){try{parent.postMessage({__pcPs:window.scrollY,__pcSh:(document.body?document.body.scrollHeight:0)},"*")}catch(e){}};window.addEventListener("scroll",function(){requestAnimationFrame(P)},{passive:true});window.addEventListener("resize",function(){requestAnimationFrame(P)},{passive:true});window.addEventListener("message",function(e){var d=e.data;if(d&&d.__pcPt!=null){try{window.scrollTo(0,d.__pcPt)}catch(e){}}});if(document.readyState!=="loading")P();else window.addEventListener("DOMContentLoaded",P);})();<\/script>';
function injectPreviewBridge(html) {
  const i = html.toLowerCase().lastIndexOf("</body>");
  if (i >= 0) return html.slice(0, i) + PREVIEW_BRIDGE + html.slice(i);
  return html + PREVIEW_BRIDGE;
}

let _previewScrollRAF = null, _pvSh = 1000, _pvSyncing = false, _pvMsgAttached = false;
function _onPreviewMessage(e) {
  const d = e.data;
  if (!d || d.__pcPs == null) return;
  if (d.__pcSh && d.__pcSh > 0) _pvSh = d.__pcSh; // 缓存预览页可滚动高度（跨源无法直读）
  if (_pvSyncing) return; // 本次由 editor->preview 触发，忽略回声避免回环
  if (previewOn && editor) { try { editor.setScrollTop(d.__pcPs); } catch (_) {} }
}
function _ensurePreviewMsg() {
  if (_pvMsgAttached) return;
  _pvMsgAttached = true;
  window.addEventListener("message", _onPreviewMessage);
}
function _schedulePreviewScrollSync() {
  if (_previewScrollRAF) return;
  _previewScrollRAF = requestAnimationFrame(() => {
    _previewScrollRAF = null;
    if (!previewOn) return;
    const frame = $("hpFrame");
    if (!frame || !frame.contentWindow) return;
    try {
      const ratio = editor.getScrollTop() / Math.max(1, editor.getScrollHeight() - editor.getContainerDomNode().clientHeight);
      const target = ratio * _pvSh;
      _pvSyncing = true;
      frame.contentWindow.postMessage({ __pcPt: target }, "*");
      requestAnimationFrame(() => { _pvSyncing = false; }); // 下一帧解除回环保护
    } catch (_) {}
  });
}
function _attachPreviewScrollListeners() {
  // 编辑器滚动时触发同步；仅订阅一次，避免每次 renderPreview 重复挂监听
  if (editor && !editor._pvScrollBound) {
    editor._pvScrollBound = true;
    editor.onDidScrollChange(() => _schedulePreviewScrollSync());
  }
  _ensurePreviewMsg();
}

function renderPreview() {
  const path = state.activeFile;
  const frame = $("hpFrame");
  if (!previewOn || !path || !isPreviewable(path) || !models[path]) return;
  const val = models[path].getValue();
  if (extOf(path) === "html" || extOf(path) === "htm") {
    frame.srcdoc = injectPreviewBridge(val);
  } else {
    frame.srcdoc = injectPreviewBridge("<!DOCTYPE html><html><head><meta charset='utf-8'><style>" + MD_CSS + "</style></head><body class='md-body'>" + renderMarkdown(val) + "</body></html>");
  }
  frame.style.zoom = previewZoom;
  frame.style.marginTop = "0"; // 每次重绘重置滚动偏移
  _attachPreviewScrollListeners();
}
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 350); }

function togglePreview(force) {
  const path = state.activeFile;
  previewOn = (force !== undefined) ? force : !previewOn;
  const hp = $("htmlPreview");
  const pvR = $("previewResizer");
  if (previewOn && path && isPreviewable(path)) {
    hp.classList.add("show");
    const pvW = parseInt(localStorage.getItem("cw-preview-w"));
    if (pvW) { hp.style.flex = "none"; hp.style.width = pvW + "px"; hp.classList.add("sized"); }
    else {
      const defW = Math.min(620, Math.max(360, Math.round(window.innerWidth * 0.42)));
      hp.style.flex = "none"; hp.style.width = defW + "px"; hp.classList.add("sized");
    }
    if (pvR) pvR.classList.add("show");
    applyPreviewZoom();
    renderPreview();
  } else {
    previewOn = false; hp.classList.remove("show", "sized");
    hp.style.flex = ""; hp.style.width = "";
    if (pvR) pvR.classList.remove("show");
  }
  const btn = $("bcPreview"); if (btn) btn.classList.toggle("active", previewOn);
  if (state.monacoReady && editor) editor.layout();
}

function openFile(path, revealLine) {
  if (!state.files[path]) return;
  if (!state.openTabs.includes(path)) state.openTabs.push(path);
  state.activeFile = path;
  const isBin = !!state.files[path].binary;
  if (isBin) {
    previewOn = false; $("htmlPreview").classList.remove("show");
    const _pv = $("previewResizer"); if (_pv) _pv.classList.remove("show");
    showBinPreview(path);
    $("sbLang").textContent = extOf(path) === "docx" ? "Word 预览" : (IMG_EXTS.has(extOf(path)) ? "图片预览" : (extOf(path) === "pdf" ? "PDF 预览" : "二进制文件"));
  } else {
    hideBinPreview();
    if (!isPreviewable(path)) { previewOn = false; $("htmlPreview").classList.remove("show"); const _pv = $("previewResizer"); if (_pv) _pv.classList.remove("show"); }
    if (state.monacoReady) {
      editor.setModel(getModel(path));
      editor.updateOptions({ readOnly: false });
      if (revealLine) { editor.revealLineInCenter(revealLine); editor.setPosition({ lineNumber: revealLine, column: 1 }); }
      editor.layout();
      $("sbLang").textContent = LANG_NAME[state.files[path].lang] || state.files[path].lang;
    }
    if (previewOn && isPreviewable(path)) renderPreview();
  }
  renderTabs(); renderTree(); renderBreadcrumb();
}

function closeTab(path, ev) {
  ev.stopPropagation();
  if (state.dirty.has(path) && !confirm(path + " 有未保存的更改，关闭将丢弃编辑，确定？")) return;
  if (state.dirty.has(path) && models[path] && state.files[path]) {
    models[path].setValue(state.files[path].content); // 还原
    state.dirty.delete(path);
  }
  state.openTabs = state.openTabs.filter((p) => p !== path);
  if (state.activeFile === path) {
    state.activeFile = state.openTabs[state.openTabs.length - 1] || null;
    if (state.activeFile) openFile(state.activeFile);
    else { hideBinPreview(); if (state.monacoReady) editor.setModel(null); }
  }
  renderTabs(); renderTree(); renderBreadcrumb();
}

function renderTabs() {
  const bar = $("tabbar");
  bar.innerHTML = "";
  state.openTabs.forEach((path) => {
    const t = document.createElement("div");
    t.className = "tab" + (path === state.activeFile ? " active" : "");
    t.innerHTML = fileIco(path) + "<span>" + esc(path.split("/").pop()) + "</span>" +
      (state.dirty.has(path) ? '<span class="tab-dot" title="未保存 (Ctrl+S 保存)">●</span>' : "") +
      '<span class="tab-close">' + ico("close") + "</span>";
    t.onclick = () => openFile(path);
    t.querySelector(".tab-close").onclick = (e) => closeTab(path, e);
    bar.appendChild(t);
  });
}

function renderBreadcrumb() {
  const bc = $("breadcrumb");
  if (!state.activeFile) { bc.innerHTML = ""; return; }
  const parts = state.activeFile.split("/").map((s) => "<span>" + esc(s) + "</span>").join('<span class="bc-sep">›</span>');
  const prevBtn = isPreviewable(state.activeFile)
    ? '<button id="bcPreview" class="bc-preview' + (previewOn ? " active" : "") + '" title="切换 HTML / Markdown 实时预览"><i data-ico="eye"></i>预览</button>'
    : "";
  bc.innerHTML = parts + prevBtn + '<button id="bcSave" class="bc-save" title="保存 (Ctrl+S)">' + ico("save") + "保存</button>";
  $("bcSave").onclick = saveActiveFile;
  const pb = $("bcPreview");
  if (pb) pb.onclick = () => togglePreview();
  replaceIcons();
}

/* ---------------- 全文搜索（服务端真实搜索） ---------------- */
let searchTimer = null;
let searchMode = "kw";   // kw=关键词(WS grep) | sem=语义(本地向量/BM25 索引)
let semBuilding = false;
$("searchInput").addEventListener("input", function () {
  clearTimeout(searchTimer);
  const q = this.value.trim();
  if (q.length < 2) { $("searchResults").innerHTML = ""; return; }
  searchTimer = setTimeout(() => {
    if (searchMode === "sem") semanticSearch(q);
    else send({ type: "search", query: q });
  }, 200);
});

/* ---------------- 语义代码检索（本地向量/BM25 索引） ---------------- */
function switchSearchMode(mode) {
  searchMode = mode;
  $("searchModeKw").classList.toggle("active", mode === "kw");
  $("searchModeSem").classList.toggle("active", mode === "sem");
  $("semBar").style.display = mode === "sem" ? "flex" : "none";
  $("searchInput").placeholder = mode === "sem"
    ? "用自然语言描述要找的代码，如：LSP 诊断是怎么推送的"
    : "在所有文件中搜索…";
  $("searchResults").innerHTML = "";
  if (mode === "sem") { refreshIndexStatus(); setTimeout(() => $("searchInput").focus(), 30); }
}

async function refreshIndexStatus() {
  try {
    const r = await fetch("/api/index/status").then((x) => x.json());
    if (r && r.built) {
      $("semStatus").textContent = "已构建 · " + (r.meta.count || 0) + " 片段"
        + (r.meta.useVector ? " · 向量" : " · BM25")
        + (r.meta.builtAt ? " · " + new Date(r.meta.builtAt).toLocaleTimeString() : "");
      const b = $("btnBuildIndex"); if (b) { b.querySelector("span").textContent = "重建索引"; b.disabled = false; }
    } else {
      $("semStatus").textContent = "索引未构建，点击构建";
      const b = $("btnBuildIndex"); if (b) { b.querySelector("span").textContent = "构建索引"; b.disabled = false; }
    }
  } catch (e) { $("semStatus").textContent = ""; }
}

async function buildCodeIndex() {
  if (semBuilding) return;
  semBuilding = true;
  const b = $("btnBuildIndex"); if (b) b.disabled = true;
  $("semStatus").textContent = "构建中…";
  try {
    const r = await fetch("/api/index/build", { method: "POST" }).then((x) => x.json());
    if (r && r.ok) {
      $("semStatus").textContent = "已构建 · " + (r.count || 0) + " 片段" + (r.useVector ? " · 向量" : " · BM25");
      if (b) b.querySelector("span").textContent = "重建索引";
    } else {
      $("semStatus").textContent = "构建失败：" + ((r && r.error) || "未知");
    }
  } catch (e) {
    $("semStatus").textContent = "构建失败：" + e.message;
  } finally {
    semBuilding = false;
    if (b) b.disabled = false;
  }
}

async function semanticSearch(q) {
  try {
    const r = await fetch("/api/index/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, k: 12 }),
    }).then((x) => x.json());
    if (!r || !r.ok) {
      $("searchResults").innerHTML = '<div class="sr-count">' + esc((r && r.reason) || "检索失败，请先构建索引") + "</div>";
      return;
    }
    renderSemanticResults(r);
  } catch (e) {
    $("searchResults").innerHTML = '<div class="sr-count">检索失败：' + esc(e.message) + "</div>";
  }
}

function renderSemanticResults(r) {
  const box = $("searchResults");
  box.innerHTML = "";
  const cnt = document.createElement("div");
  cnt.className = "sr-count";
  cnt.textContent = "语义检索 · " + (r.mode || "bm25") + " 模式 · " + (r.count || 0) + " 个结果";
  box.appendChild(cnt);
  (r.results || []).forEach((res) => {
    const item = document.createElement("div");
    item.className = "sem-result";
    const head = document.createElement("div");
    head.className = "sem-head";
    head.innerHTML = fileIco(res.path)
      + ' <span class="sem-path">' + esc(res.path) + "</span>"
      + ' <span class="sem-range">' + res.startLine + "-" + res.endLine + "</span>"
      + (res.score != null ? ' <span class="sem-score">' + res.score + "</span>" : "");
    head.onclick = () => openFile(res.path, res.startLine);
    item.appendChild(head);
    if (res.title) {
      const t = document.createElement("div");
      t.className = "sem-title"; t.textContent = res.title;
      item.appendChild(t);
    }
    const snip = document.createElement("pre");
    snip.className = "sem-snippet";
    snip.textContent = res.snippet;
    snip.onclick = () => openFile(res.path, res.startLine);
    item.appendChild(snip);
    box.appendChild(item);
  });
}

$("searchModeKw").onclick = () => switchSearchMode("kw");
$("searchModeSem").onclick = () => switchSearchMode("sem");
$("btnBuildIndex").onclick = buildCodeIndex;

function renderSearchResults(query, results) {
  const box = $("searchResults");
  box.innerHTML = "";
  const byFile = {};
  results.forEach((r) => (byFile[r.path] = byFile[r.path] || []).push(r));
  const fileCount = Object.keys(byFile).length;
  const cnt = document.createElement("div");
  cnt.className = "sr-count";
  cnt.textContent = results.length ? "共 " + results.length + " 个结果，分布在 " + fileCount + " 个文件中" : "未找到结果";
  box.appendChild(cnt);
  Object.keys(byFile).sort().forEach((path) => {
    const hits = byFile[path];
    const fh = document.createElement("div");
    fh.className = "sr-file";
    fh.innerHTML = fileIco(path) + " " + esc(path) + ' <span style="color:#777">(' + hits.length + ")</span>";
    fh.onclick = () => openFile(path);
    box.appendChild(fh);
    hits.slice(0, 8).forEach((h) => {
      const le = document.createElement("div");
      le.className = "sr-line";
      const ln = h.text, idx = Math.max(0, h.col - 1);
      const before = esc(ln.slice(Math.max(0, idx - 20), idx));
      const match = esc(ln.substr(idx, query.length));
      const after = esc(ln.slice(idx + query.length, idx + query.length + 40));
      le.innerHTML = '<span style="color:#666">' + h.line + ":</span> " + before + "<mark>" + match + "</mark>" + after;
      le.onclick = () => openFile(h.path, h.line);
      box.appendChild(le);
    });
  });
}

/* ---------------- 本地 Agent 检测与一键调用 ---------------- */
function refreshAgents() {
  const list = $("agentDetectList");
  if (!list) return;
  list.innerHTML = '<div class="agent-detecting"><span class="agent-spin"></span>' + esc(t("agentDetecting")) + "</div>";
  fetch("/api/agents/detect")
    .then((r) => r.json())
    .then((j) => {
      if (!j.ok || !j.agents || !j.agents.length) { list.innerHTML = '<div class="agent-empty">' + esc(t("agentNone")) + "</div>"; return; }
      list.innerHTML = "";
      j.agents.forEach((a) => {
        const el = document.createElement("div");
        el.className = "agent-item" + (a.installed ? " installed" : " missing");
        const badge = a.installed
          ? '<span class="agent-badge ok">' + esc(t("agentInstalled")) + "</span>"
          : '<span class="agent-badge">' + esc(t("agentNotInstalled")) + "</span>";
        const btn = a.installed
          ? '<button class="agent-launch" data-id="' + esc(a.id) + '">' + ico("play") + esc(t("launchAgent")) + "</button>"
          : "";
        const pathLine = a.installed && a.path ? '<div class="agent-path" title="' + esc(a.path) + '">' + esc(a.path) + "</div>" : "";
        el.innerHTML = '<div class="agent-meta"><b>' + esc(a.name) + "</b>" + badge + "</div>" + pathLine + btn;
        list.appendChild(el);
      });
      list.querySelectorAll(".agent-launch").forEach((b) => {
        b.onclick = () => launchAgent(b.dataset.id);
      });
    })
    .catch((e) => { list.innerHTML = '<div class="agent-empty">' + esc(e.message) + "</div>"; });
}
function launchAgent(id) {
  fetch("/api/agents/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  })
    .then((r) => r.json())
    .then((j) => {
      if (j.ok) toast(t("launchAgent") + "： " + cmd);
      else toast(t("agentLaunchFail") + cmd);
    })
    .catch((e) => toast(t("agentLaunchFail") + cmd));
}
$("btnAgentRefresh").onclick = refreshAgents;

/* ---------------- 活动栏 ---------------- */
document.querySelectorAll(".ab-btn").forEach((btn) => {
  btn.onclick = () => {
    const v = btn.dataset.view;
    if (v === "ai") { switchMode("agents"); return; }
    if (v === "evolution") { openEvolutionCodex(); return; }
    // 侧边栏缩回时，点击活动栏按钮重新展开
    const sb = $("sidebar");
    if (sb.classList.contains("fully-collapsed")) {
      sb.classList.remove("fully-collapsed");
      sb.style.width = (parseInt(localStorage.getItem("cw-sidebar-w")) || 230) + "px";
      if (editor) editor.layout();
    }
    document.querySelectorAll(".ab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    ["explorer", "search", "scm", "skills"].forEach((name) => {
      $("view-" + name).style.display = name === v ? "block" : "none";
    });
    if (v === "search") { setTimeout(() => $("searchInput").focus(), 50); if (searchMode === "sem") refreshIndexStatus(); }
    if (v === "skills") onSkillsViewActive();
  };
});
$("bpToggle").onclick = () => $("bottomPanel").classList.toggle("collapsed");

/* ---------------- 改动面板（Git 状态：M/A/D） ---------------- */
const ST_TXT = { M: "M", A: "U", D: "D" };
function renderChanges(list) {
  const items = list || Array.from(modifiedSet()).map((p) => {
    const f = state.files[p];
    const st = diffStat(f.original, f.content);
    return { path: p, status: f.isNew ? "A" : "M", add: st.add, del: st.del };
  });
  const n = items.length;
  $("scmHead").textContent = "更改 (" + n + ")";
  $("scmBadge").style.display = n ? "flex" : "none";
  $("scmBadge").textContent = n;
  $("sbChangesTxt").textContent = n + " 处改动";
  $("agChangeCount").textContent = n + " 个文件";
  const scm = $("scmList"), ag = $("agChangedFiles");
  if (!n) {
    scm.innerHTML = '<div class="scm-empty">暂无更改。改动（相对 Git/快照基线）会出现在这里。</div>';
    ag.innerHTML = '<div class="scm-empty">Agent 修改代码后，文件与 Diff 会显示在这里。</div>';
    return;
  }
  scm.innerHTML = ""; ag.innerHTML = "";
  items.forEach((it) => {
    const st = ST_TXT[it.status] || "M";
    const stat = '<span class="stat-add">+' + it.add + '</span> <span class="stat-del">−' + it.del + "</span>";
    const item = document.createElement("div");
    item.className = "scm-item";
    item.innerHTML = fileIco(it.path) + " <span>" + esc(it.path.split("/").pop()) + '</span><span class="scm-stat">' + stat + '</span><span class="m st-' + st + '">' + st + "</span>";
    item.onclick = () => showDiff(it.path);
    scm.appendChild(item);

    const row = document.createElement("div");
    row.className = "agcf-item";
    row.innerHTML = '<div class="agcf-head"><span class="m st-' + st + '">' + st + '</span><span>' + esc(it.path) + '</span><span class="agcf-stat">' + stat + '</span><button class="agcf-btn">查看 Diff</button></div>';
    row.querySelector(".agcf-head").onclick = () => showDiff(it.path);
    ag.appendChild(row);
  });
}

function showDiff(path) {
  if (!state.monacoReady || !state.files[path]) return;
  const f = state.files[path];
  $("diffModal").style.display = "flex";
  $("diffTitle").textContent = path + (f.isNew ? " — 新文件" : " — 相对基线的改动");
  if (diffEditor) diffEditor.dispose();
  diffEditor = monaco.editor.createDiffEditor($("diffHost"), {
    theme: getTheme() === "light" ? "vs" : "vs-dark", readOnly: true, automaticLayout: true, fontSize: 13,
    renderSideBySide: true, minimap: { enabled: false },
  });
  diffEditor.setModel({
    original: monaco.editor.createModel(f.original, f.lang),
    modified: monaco.editor.createModel(f.content, f.lang),
  });
}
$("diffClose").onclick = () => {
  $("diffModal").style.display = "none";
  if (diffEditor) {
    const m = diffEditor.getModel();
    diffEditor.dispose(); diffEditor = null;
    if (m) { m.original.dispose(); m.modified.dispose(); }
  }
};

/* ---------------- 补丁审阅面板（agent apply_edit 的改动审阅） ---------------- */
let patchDiffEditor = null;
function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function monacoLangOf(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  return ({ js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    json: "json", html: "html", htm: "html", css: "css", scss: "scss", md: "markdown", py: "python",
    sh: "shell", yml: "yaml", yaml: "yaml", txt: "plaintext" })[ext] || "plaintext";
}

function openPatchReview(ev) {
  if (!state.monacoReady) { toast("编辑器尚未就绪，稍后可在 SCM 查看改动"); return; }
  const files = (ev.files || []).map((f) => Object.assign({}, f, {
    hunks: (f.hunks || []).map((h) => Object.assign({}, h, { accepted: true })),
  }));
  if (!files.length) return;
  state.patch = { files, convId: ev.convId || convId, _sel: files[0].path };
  $("patchModal").style.display = "flex";
  renderPatchList();
  renderPatchDiff(files[0].path);
}

/* 仅应用被勾选（accepted）的 hunk，算出"预览用"的修改后内容 */
function previewModified(f) {
  let cur = f.original == null ? "" : f.original;
  for (const h of (f.hunks || [])) {
    if (!h.accepted) continue;
    const oldS = h.old_string || "";
    const newS = h.new_string || "";
    if (oldS === "") { cur = newS; continue; }
    const idx = cur.indexOf(oldS);
    if (idx < 0) continue;
    cur = cur.slice(0, idx) + newS + cur.slice(idx + oldS.length);
  }
  return cur;
}

function renderPatchHunks(f) {
  const box = $("patchHunks");
  if (!f.hunks || !f.hunks.length) { box.style.display = "none"; box.innerHTML = ""; return; }
  box.style.display = "block";
  box.innerHTML = "";
  f.hunks.forEach((h, i) => {
    const row = document.createElement("div");
    row.className = "phk";
    const idxSpan = document.createElement("span");
    idxSpan.className = "phk-idx"; idxSpan.textContent = "#" + (i + 1);
    const snippet = document.createElement("pre");
    snippet.className = "phk-snippet";
    const oldLines = (h.old_string || "").split("\n").slice(0, 3).map((l) => '<span class="dl">- ' + escHtml(l) + "</span>").join("");
    const newLines = (h.new_string || "").split("\n").slice(0, 3).map((l) => '<span class="al">+ ' + escHtml(l) + "</span>").join("");
    snippet.innerHTML = oldLines + newLines;
    const toggle = document.createElement("label");
    toggle.className = "phk-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!h.accepted;
    cb.onchange = () => { h.accepted = cb.checked; renderPatchDiff(f.path); };
    toggle.appendChild(cb);
    toggle.appendChild(document.createTextNode("接受"));
    row.appendChild(idxSpan); row.appendChild(snippet); row.appendChild(toggle);
    box.appendChild(row);
  });
}

function renderPatchList() {
  const box = $("patchFiles");
  box.innerHTML = "";
  $("patchCount").textContent = state.patch.files.length + " 个文件";
  state.patch.files.forEach((f) => {
    const stat = '<span class="stat-add">+' + f.add + '</span> <span class="stat-del">−' + f.del + "</span>";
    const row = document.createElement("div");
    row.className = "patch-file" + (f.path === state.patch._sel ? " active" : "");
    row.innerHTML = fileIco(f.path) + ' <span class="pf-name">' + escHtml(f.path) + '</span><span class="pf-stat">' + stat + '</span>' +
      '<span class="pf-act"><button class="pf-btn acc">接受</button><button class="pf-btn rej">拒绝</button></span>';
    row.querySelector(".pf-btn.acc").onclick = (e) => { e.stopPropagation(); patchApply([f.path]); };
    row.querySelector(".pf-btn.rej").onclick = (e) => { e.stopPropagation(); patchReject([f.path]); };
    row.onclick = () => renderPatchDiff(f.path);
    box.appendChild(row);
  });
}

function renderPatchDiff(path) {
  if (!path) return;
  state.patch._sel = path;
  document.querySelectorAll("#patchFiles .patch-file").forEach((el) => {
    const nm = el.querySelector(".pf-name");
    if (nm) el.classList.toggle("active", nm.textContent === path);
  });
  const f = state.patch.files.find((x) => x.path === path);
  if (!f) return;
  renderPatchHunks(f);
  const preview = previewModified(f);
  if (patchDiffEditor) patchDiffEditor.dispose();
  patchDiffEditor = monaco.editor.createDiffEditor($("patchHost"), {
    theme: getTheme() === "light" ? "vs" : "vs-dark", readOnly: true, automaticLayout: true, fontSize: 13,
    renderSideBySide: true, minimap: { enabled: false },
  });
  patchDiffEditor.setModel({
    original: monaco.editor.createModel(f.original, monacoLangOf(f.path)),
    modified: monaco.editor.createModel(preview, monacoLangOf(f.path)),
  });
}

function patchApply(paths) { send({ type: "patch.approve", convId: state.patch.convId, paths }); }
function patchReject(paths) { send({ type: "patch.reject", convId: state.patch.convId, paths }); }
function patchApplySelected(path) {
  const f = state.patch.files.find((x) => x.path === path);
  if (!f) return;
  const accepted = (f.hunks || []).map((h, i) => (h.accepted ? i : -1)).filter((i) => i >= 0);
  send({ type: "patch.approve", convId: state.patch.convId, paths: [path], hunks: { [path]: accepted } });
}
function closePatchModal() {
  $("patchModal").style.display = "none";
  if (patchDiffEditor) {
    const m = patchDiffEditor.getModel();
    patchDiffEditor.dispose(); patchDiffEditor = null;
    if (m) { m.original.dispose(); m.modified.dispose(); }
  }
}

$("patchAcceptAll").onclick = () => patchApply(state.patch.files.map((f) => f.path));
$("patchRejectAll").onclick = () => patchReject(state.patch.files.map((f) => f.path));
$("patchApplySelected").onclick = () => { if (state.patch && state.patch._sel) patchApplySelected(state.patch._sel); };
$("patchClose").onclick = closePatchModal;

/* ---------------- 终端渲染（多标签页） ----------------
   每个标签是独立的输出缓冲（与聊天会话解耦，可随意开多个终端）。
   标签状态在服务端内存中常驻：刷新后由 hello 的 tabs 还原；关闭/新建标签同步到服务端。
   lines 数组统一存放每条输出的「完整 div.tl 外层 HTML」，保证 class 不丢失、刷新可还原。 */
let termTabs = {};        // tabId -> { title, lines: [ "<div class=tl>...</div>" ] }
let termActive = null;    // 当前激活标签
let termSeq = 0;
function genTermTabId() { return "t" + (++termSeq).toString(36) + Date.now().toString(36); }

/* 把一条服务端历史条目（{cls,text,cmd}）渲染为 div.tl 的内部 HTML（与前端 termLine 调用格式一致） */
function termHtmlFromEntry(e) {
  if (e.cmd) {
    return '<span class="tl-prompt">user@pancode</span><span class="tl-dim">:</span>' +
      '<span class="tl-info">~/' + esc(state.project) + '</span><span class="tl-dim">$ </span>' +
      '<span class="tl-cmd">' + esc(e.text) + "</span>";
  }
  return '<span class="' + (e.cls || "tl-cmd") + '">' + esc(e.text) + "</span>";
}

/* 向某标签追加一行（html 为 div.tl 内部 HTML）；标签不存在则惰性创建（AI 的 agent 标签自动出现） */
function appendTermHtml(tabId, html) {
  if (!tabId) return;
  const wrapped = '<div class="tl">' + html + "</div>";
  let created = false;
  if (!termTabs[tabId]) {
    termTabs[tabId] = { title: tabId === "agent" ? "Agent" : "终端", lines: [] };
    created = true;
  }
  const tab = termTabs[tabId];
  if (tabId === termActive) {
    const div = document.createElement("div");
    div.className = "tl";
    div.innerHTML = html;
    const lines = $("termLines");
    lines.appendChild(div);
    while (lines.children.length > 800) lines.removeChild(lines.firstChild);
    lines.scrollTop = lines.scrollHeight;
  }
  tab.lines.push(wrapped);
  while (tab.lines.length > 800) tab.lines.shift();
  if (created) renderTermTabs();
}

function termLine(html, tabId) { appendTermHtml(tabId || termActive, html); }
function termPrompt(cmd, tabId) { appendTermHtml(tabId || termActive, termHtmlFromEntry({ cmd: true, text: cmd })); }

/* ----- Agent Trace 面板：渲染 agent 内部事件流（llm.round / tool.* / usage） ----- */
const TRACE_LABELS = {
  "llm.round": "llm.round", "tool.call": "tool.call", "tool.arg_err": "arg_err",
  "tool.loop": "loop", "tool.failstreak": "failstreak", "usage": "usage",
};
const traceState = { rounds: 0, tools: 0, tokens: 0, loops: 0, errors: 0, seq: 0 };

function traceDetail(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "llm.round": return "round " + (d.rounds || "?") + " · " + (d.tools || 0) + " tools · finish: " + (d.finish || "");
    case "tool.call": return (d.name || "?") + " · " + (d.len != null ? (Math.round(d.len / 100) / 10 + "k") : "") + " chars";
    case "tool.arg_err": return (d.name || "?") + " · 参数解析失败 → 回传模型纠正";
    case "tool.loop": return (d.name || "?") + " 已连续 " + (d.count || "?") + " 次相同调用 → 死循环已阻断";
    case "tool.failstreak": return "连续 " + (d.streak || "?") + " 次工具报错 → 注入反思";
    case "usage": return "prompt " + (d.prompt_tokens || 0) + " / completion " + (d.completion_tokens || 0) + " / total " + (d.total_tokens || 0);
    default: return JSON.stringify(d);
  }
}
function fmtTok(n) { n = n || 0; return n >= 1000 ? (Math.round(n / 100) / 10) + "k" : "" + n; }
function setTraceText(id, v) { const el = $(id); if (el) el.textContent = v; }

function onTraceEvent(ev, isHistory) {
  if (!ev) return;
  const list = $("traceList"); if (!list) return;
  if (ev.type === "llm.round") traceState.rounds++;
  else if (ev.type === "tool.call") traceState.tools++;
  else if (ev.type === "tool.loop" || ev.type === "tool.failstreak") traceState.loops++;
  else if (ev.type === "tool.arg_err") traceState.errors++;
  else if (ev.type === "usage" && ev.data) traceState.tokens = ev.data.total_tokens || traceState.tokens;
  setTraceText("traceRounds", traceState.rounds);
  setTraceText("traceTools", traceState.tools);
  setTraceText("traceLoops", traceState.loops);
  setTraceText("traceErrors", traceState.errors);
  setTraceText("traceTokens", fmtTok(traceState.tokens));
  setTraceText("agTraceCount", (++traceState.seq) + " 事件");
  const t = (((ev.t || Date.now()) % 60000) / 1000).toFixed(1) + "s";
  const row = document.createElement("div");
  row.className = "trace-row tr-" + ev.type.replace(/\./g, "-") + (isHistory ? " tr-history" : "");
  row.innerHTML = '<span class="tr-time">' + t + '</span>' +
    '<span class="tr-badge">' + escHtml(TRACE_LABELS[ev.type] || ev.type) + '</span>' +
    '<span class="tr-detail">' + escHtml(traceDetail(ev)) + '</span>';
  list.appendChild(row);
  while (list.children.length > 200) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}
function clearTrace() {
  traceState.rounds = traceState.tools = traceState.loops = traceState.errors = traceState.seq = 0;
  traceState.tokens = 0;
  const list = $("traceList"); if (list) list.innerHTML = "";
  setTraceText("traceRounds", "0"); setTraceText("traceTools", "0"); setTraceText("traceLoops", "0");
  setTraceText("traceErrors", "0"); setTraceText("traceTokens", "0"); setTraceText("agTraceCount", "0 事件");
}
function onUsageEvent(u) { if (!u) return; traceState.tokens = u.total_tokens || traceState.tokens; setTraceText("traceTokens", fmtTok(traceState.tokens)); }
/* 跨会话回看：从服务端拉取某会话落盘的 trace 历史并渲染（dimmed），然后 live 事件继续追加 */
async function loadTraceHistory(convId) {
  const list = $("traceList"); if (!list || !convId) return;
  try {
    const r = await fetch("/api/agent/trace/history?conv=" + encodeURIComponent(convId));
    const j = await r.json();
    if (!j || !j.ok || !Array.isArray(j.events)) return;
    for (const ev of j.events) onTraceEvent(ev, true);
    list.scrollTop = list.scrollHeight;
  } catch (e) { /* 静默：历史缺失不应影响实时面板 */ }
}

/* 切换显示的标签缓冲 */
function swapTerm(tabId) {
  if (!termTabs[tabId]) return;
  termActive = tabId;
  const tab = termTabs[tabId];
  const el = $("termLines");
  el.innerHTML = tab.lines.join("");
  el.scrollTop = el.scrollHeight;
  renderTermTabs();
}

function renderTermTabs() {
  const bar = $("termTabs");
  if (!bar) return;
  bar.innerHTML = "";
  Object.keys(termTabs).forEach((id) => {
    const t = termTabs[id];
    const b = document.createElement("div");
    b.className = "term-tab" + (id === termActive ? " active" : "");
    b.innerHTML = '<span class="term-tab-name">' + esc(t.title) + '</span><span class="term-tab-x" title="关闭标签">✕</span>';
    b.querySelector(".term-tab-name").onclick = () => swapTerm(id);
    b.querySelector(".term-tab-x").onclick = (e) => { e.stopPropagation(); closeTermTab(id); };
    bar.appendChild(b);
  });
  const add = document.createElement("div");
  add.className = "term-tab-add";
  add.textContent = "＋";
  add.title = "新建终端标签";
  add.onclick = newTermTab;
  bar.appendChild(add);
}

function newTermTab() {
  const id = genTermTabId();
  const n = Object.keys(termTabs).length + 1;
  termTabs[id] = { title: "终端 " + n, lines: [] };
  send({ type: "term.open", tabId: id, title: "终端 " + n });
  swapTerm(id);
}

function closeTermTab(id) {
  if (!termTabs[id]) return;
  delete termTabs[id];
  send({ type: "term.close", tabId: id });
  if (termActive === id) {
    const first = Object.keys(termTabs)[0];
    if (first) swapTerm(first);
    else newTermTab();
  } else {
    renderTermTabs();
  }
}

/* 由 hello 的 tabs 还原（同一服务进程内刷新可恢复所有标签与历史） */
function initTermTabs(tabs) {
  termTabs = {};
  termActive = null;
  (tabs || []).forEach((t) => {
    const lines = (t.history || []).map((e) => '<div class="tl">' + termHtmlFromEntry(e) + "</div>");
    termTabs[t.id] = { title: t.title || "终端", lines };
  });
  const ids = Object.keys(termTabs);
  if (ids.length) {
    swapTerm(ids[0]);
  } else {
    const id = genTermTabId();
    termTabs[id] = { title: "终端 1", lines: ['<div class="tl"><span class="tl-dim">pancode 集成终端 — 命令在服务端 workspace/ 目录真实执行（Ctrl+C 中断）</span></div>'] };
    send({ type: "term.open", tabId: id, title: "终端 1" });
    swapTerm(id);
  }
}

/* ---------------- 聊天流渲染 ---------------- */
const blocks = {};
let answerBlock = null;   // 跨轮聚合的最终回答气泡（一次任务 = 一个气泡）
let thinkCount = 0;       // 本次任务的思考步序号
let lastThink = null;     // 当前正在流式输出的思考块（用于自动折叠上一个）
function scrollChat() {
  chatStream.scrollTop = chatStream.scrollHeight;
  // 每次消息变化都触发上下文实时刷新（rAF 节流，避免流式输出时频繁重排）
  if (_ctxRaf) return;
  _ctxRaf = requestAnimationFrame(() => { _ctxRaf = null; refreshCtx(); });
}

/* 追加任务内容块：若最终回答气泡已出现，则插到它之前，保证「思考/工具在前、最终结论在最后」 */
function appendChatBlock(el) {
  if (answerBlock && answerBlock.row && answerBlock.row.parentNode === chatStream) {
    chatStream.insertBefore(el, answerBlock.row);
  } else {
    chatStream.appendChild(el);
  }
}

function mdLite(s) {
  let h = esc(s);
  h = h.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, l, c) => "<pre>" + c.trim() + "</pre>");
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/^### (.+)$/gm, "<b>$1</b>");
  h = h.replace(/^## (.+)$/gm, "<b>$1</b>");
  h = h.replace(/^# (.+)$/gm, "<b>$1</b>");
  h = h.replace(/\n/g, "<br>");
  return h;
}

/* 富文本 Markdown 渲染（聊天回答）：代码块/标题/列表/引用/表格/行内样式 */
function renderChatMD(src) {
  if (!src) return "";
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let listBuf = [], inList = false, inOrdered = false;
  const flushList = () => {
    if (!listBuf.length) return;
    const tag = inOrdered ? "ol" : "ul";
    html += "<" + tag + ">" + listBuf.map((x) => "<li>" + inlineMD(x) + "</li>").join("") + "</" + tag + ">";
    listBuf = []; inList = false; inOrdered = false;
  };
  const inlineMD = (t) => {
    let h = esc(t);
    h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return h;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      flushList();
      const lang = fence[1] || "";
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      html += '<div class="code-block"><div class="code-head"><span class="code-lang">' + esc(lang || "code") +
        '</span><button class="copy-btn" type="button">复制</button></div><pre class="' + esc(lang) +
        '">' + esc(code.join("\n")) + "</pre></div>";
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushList(); const lv = h[1].length; html += "<h" + lv + ">" + inlineMD(h[2]) + "</h" + lv + ">"; i++; continue; }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { flushList(); html += "<blockquote>" + inlineMD(bq[1]) + "</blockquote>"; i++; continue; }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) { if (!inList || inOrdered) { flushList(); inList = true; inOrdered = false; } listBuf.push(ul[1]); i++; continue; }
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) { if (!inList || !inOrdered) { flushList(); inList = true; inOrdered = true; } listBuf.push(ol[1]); i++; continue; }
    if (line.trim() === "") { flushList(); i++; continue; }
    flushList();
    html += "<p>" + inlineMD(line) + "</p>";
    i++;
  }
  flushList();
  return html;
}

/* 代码块复制按钮（委托绑定，幂等） */
function wireCopyButtons(root) {
  root.querySelectorAll(".copy-btn").forEach((btn) => {
    if (btn._wired) return;
    btn._wired = true;
    btn.addEventListener("click", () => {
      const cb = btn.closest(".code-block");
      const pre = cb ? cb.querySelector("pre") : null;
      const text = pre ? pre.textContent : "";
      const done = () => { const old = btn.textContent; btn.textContent = "已复制"; setTimeout(() => (btn.textContent = old), 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      } else fallbackCopy(text, done);
    });
  });
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (e) {}
  document.body.removeChild(ta);
}

/* 将已渲染的 HTML 气泡还原为 Markdown（用于导出） */
function htmlToMarkdown(node) {
  let out = "";
  node.childNodes.forEach((c) => {
    if (c.nodeType === 3) { out += c.textContent; return; }
    if (c.nodeType !== 1) return;
    const tag = c.tagName.toLowerCase();
    if (tag === "p") out += "\n" + htmlToMarkdown(c) + "\n";
    else if (tag === "br") out += "\n";
    else if (tag === "b" || tag === "strong") out += "**" + htmlToMarkdown(c) + "**";
    else if (tag === "i" || tag === "em") out += "*" + htmlToMarkdown(c) + "*";
    else if (tag === "code") out += "`" + c.textContent + "`";
    else if (tag === "h1") out += "\n# " + htmlToMarkdown(c) + "\n";
    else if (tag === "h2") out += "\n## " + htmlToMarkdown(c) + "\n";
    else if (tag === "h3") out += "\n### " + htmlToMarkdown(c) + "\n";
    else if (tag === "h4") out += "\n#### " + htmlToMarkdown(c) + "\n";
    else if (tag === "ul") { c.querySelectorAll(":scope > li").forEach((li) => (out += "\n- " + htmlToMarkdown(li))); out += "\n"; }
    else if (tag === "ol") { let k = 1; c.querySelectorAll(":scope > li").forEach((li) => (out += "\n" + (k++) + ". " + htmlToMarkdown(li))); out += "\n"; }
    else if (tag === "blockquote") out += "\n> " + htmlToMarkdown(c).replace(/\n/g, "\n> ") + "\n";
    else if (tag === "a") out += "[" + c.textContent + "](" + (c.getAttribute("href") || "") + ")";
    else if (tag === "pre") out += "\n```\n" + c.textContent + "\n```\n";
    else if (tag === "div" && c.classList.contains("code-block")) {
      const pre = c.querySelector("pre"); const lang = c.querySelector(".code-lang");
      out += "\n```" + (lang ? lang.textContent : "") + "\n" + (pre ? pre.textContent : "") + "\n```\n";
    } else out += htmlToMarkdown(c);
  });
  return out;
}

/* 将当前对话导出为 Markdown 文件 */
function exportConversation() {
  const nodes = Array.from(chatStream.children);
  const parts = ["# pancode 对话导出", "", "_导出时间：" + new Date().toLocaleString() + "_", ""];
  let has = false;
  for (const n of nodes) {
    let role = null, src = null;
    if (n.classList.contains("msg-user")) { role = "用户"; src = n; }
    else if (n.classList.contains("msg-row")) { const ai = n.querySelector(".msg-ai"); if (ai) { role = "助手"; src = ai; } }
    if (!role || !src) continue;
    const text = role === "用户" ? src.textContent.trim() : htmlToMarkdown(src).replace(/\n{3,}/g, "\n\n").trim();
    if (!text) continue;
    has = true;
    parts.push("## " + role);
    parts.push(text);
    parts.push("");
  }
  if (!has) { toast("当前没有可导出的对话内容"); return; }
  const md = parts.join("\n");
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "pancode-conversation-" + Date.now() + ".md";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("对话已导出为 Markdown");
}

/* 轻量 toast 提示 */
function toast(msg) {
  let t = $("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 1800);
}

function addUserMsg(text) {
  const el = document.createElement("div");
  el.className = "msg msg-user";
  el.textContent = text;
  addMsgCopyBtn(el, text);
  chatStream.appendChild(el); scrollChat();
}

/* 给消息气泡加「快捷复制」按钮（用户发出的消息 / AI 回复均可复制） */
function addMsgCopyBtn(el, text) {
  const btn = document.createElement("button");
  btn.className = "msg-copy";
  btn.title = "复制消息";
  btn.innerHTML = ico("copy");
  btn.addEventListener("click", () => {
    const done = () => { const old = btn.innerHTML; btn.innerHTML = "✓"; setTimeout(() => (btn.innerHTML = old), 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  });
  el.appendChild(btn);
}

function colorizeDiffText(text) {
  return text.split("\n").map((l) => {
    if (l.startsWith("+")) return '<span class="add">' + esc(l) + "</span>";
    if (l.startsWith("-")) return '<span class="del">' + esc(l) + "</span>";
    return esc(l);
  }).join("\n");
}

const KIND_ICO = { read: "read", edit: "edit", terminal: "terminal" };

function applyEngineInfo(info) {
  state.engine = info;
  const label = info.mode === "llm" ? info.model : "内置演示引擎";
  $("cpModelEditor").textContent = label;
  $("cpModelAgents").textContent = label + " · Agent 模式";
  $("btnSettings").classList.toggle("llm-on", info.mode === "llm");
}

function syncFiles(files) {
  state.files = files;
  // 关闭已消失文件的标签
  state.openTabs = state.openTabs.filter((p) => files[p]);
  if (state.activeFile && !files[state.activeFile]) {
    state.activeFile = state.openTabs[state.openTabs.length - 1] || null;
    if (state.activeFile) openFile(state.activeFile);
    else { hideBinPreview(); if (state.monacoReady) editor.setModel(null); }
  }
  // 同步 model 内容（跳过用户正在编辑的脏文件）
  if (state.monacoReady) {
    for (const p in models) {
      if (!files[p]) { models[p].dispose(); delete models[p]; state.dirty.delete(p); lspClose(p); continue; }
      if (files[p].binary) continue; // 二进制占位 model 不同步内容
      if (!state.dirty.has(p) && models[p].getValue() !== files[p].content) models[p].setValue(files[p].content);
    }
  }
  renderTree(); renderTabs(); renderChanges(); renderBreadcrumb();
}

/* 人工确认卡片：写文件 / 删文件 / 执行命令 需用户批准或拒绝 */
const APPROVE_META = {
  write_file:  { label: "写文件",   ico: "edit",     kindCls: "k-edit" },
  delete_file: { label: "删文件",   ico: "trash",    kindCls: "k-edit" },
  run_command: { label: "执行命令", ico: "terminal", kindCls: "k-terminal" },
};
function renderApproval(ev) {
  const m = APPROVE_META[ev.tool] || { label: ev.tool, ico: "files", kindCls: "" };
  const danger = ev.danger === "high"
    ? { t: "高危", c: "danger-high" }
    : ev.danger === "medium"
      ? { t: "中危", c: "danger-mid" }
      : { t: "低危", c: "danger-low" };
  let pv = "";
  if (ev.tool === "write_file" && ev.preview) {
    pv = '<div class="ap-meta">路径：<span class="ap-path">' + esc(ev.preview.path) + "</span> · 共 " + esc(ev.preview.lines) + " 行</div>" +
         '<pre class="ap-pre">' + esc(ev.preview.preview) + "</pre>";
  } else if (ev.tool === "run_command" && ev.preview) {
    pv = '<div class="ap-meta">命令：</div><pre class="ap-pre">' + esc(ev.preview.command) + "</pre>";
  } else if (ev.preview && ev.preview.path) {
    pv = '<div class="ap-meta">路径：<span class="ap-path">' + esc(ev.preview.path) + "</span></div>";
  }
  const target = (ev.preview && (ev.preview.path || ev.preview.command)) ? (ev.preview.path || ev.preview.command) : ev.tool;
  const el = document.createElement("div");
  el.className = "tool-card approval open " + m.kindCls;
  el.innerHTML =
    '<div class="tool-head"><span class="t-kind">' + ico(m.ico) + "</span>" +
      '<span class="t-name">需要确认：' + esc(m.label) + "</span>" +
      '<span class="t-target">' + esc(target) + "</span>" +
      '<span class="t-status pending">' + ico("tasklist") + " 待确认</span></div>" +
    '<div class="tool-body approval-body">' + pv + "</div>" +
    '<div class="approval-actions">' +
      '<span class="ap-danger ' + danger.c + '">' + danger.t + " 操作</span>" +
      '<button class="btn-approve" data-id="' + esc(ev.id) + '">' + ico("check") + " 批准</button>" +
      '<button class="btn-reject" data-id="' + esc(ev.id) + '">' + ico("close") + " 拒绝</button>" +
    "</div>";
  appendChatBlock(el); scrollChat();
  const statusEl = el.querySelector(".t-status");
  const lock = () => el.querySelectorAll(".approval-actions button").forEach((b) => (b.disabled = true));
  el.querySelector(".btn-approve").onclick = () => {
    send({ type: "tool.approve", id: ev.id });
    statusEl.className = "t-status done";
    statusEl.innerHTML = ico("check") + " 已批准";
    lock();
  };
  el.querySelector(".btn-reject").onclick = () => {
    send({ type: "tool.reject", id: ev.id });
    statusEl.className = "t-status fail";
    statusEl.innerHTML = ico("close") + " 已拒绝";
    lock();
  };
}

function handleEvent(ev) {
  switch (ev.type) {
    case "hello": {
      state.round = ev.round || 0;
      state.project = ev.project || "workspace";
      /* 工作区切换检测：路径变化时按新工作区重载对话（隔离存储） */
      if (ev.wsId) _wsId = ev.wsId;     // 稳定工作区 ID：消除刷新前后存储 key 不一致（聊天记录丢失根因）
      if (ev.workspace) {
        const wsChanged = ev.workspace !== state.workspace;
        const prevWs = state.workspace;
        state.workspace = ev.workspace;
        if (wsChanged && prevWs) {
          lspDisposeAll();               // 工作区变了，file:// 根随之改变，旧 LSP 会话失效
          reloadConvForWs();             // 非首次：切换工作区需重载会话列表与 active（已用稳定 key）
        } else {
          restoreConv();                 // 首次或工作区未变（如刷新）：用稳定 key 恢复会话
        }
      }
      $("projName").textContent = state.project.toUpperCase();
      document.querySelector(".tb-project").textContent = state.project;
      if (ev.workspace) $("btnOpenFolder").title = "当前工作区: " + ev.workspace + "（点击打开其他文件夹）";
      const cwd = $("termCwd"); if (cwd) cwd.textContent = "~/" + state.project;
      if (ev.tabs) initTermTabs(ev.tabs);   // 还原多标签终端（同一服务进程内刷新可恢复）
      if (ev.truncated) termLine('<span class="tl-warn">[提示] 该文件夹文件较多，文件树仅加载前 500 个文本文件（终端与 AI 仍可操作全部文件）</span>');
      if (ev.git) $("sbBranch").textContent = ev.git.git ? ev.git.branch : "无 Git（快照基线）";
      if (ev.engine) applyEngineInfo(ev.engine);
      if (ev.agent) applyAgentSettings(ev.agent);
      if (ev.lsp) state.lsp = ev.lsp;
      syncFiles(ev.files);
      setRunning(ev.running, null);
      if (!state.booted) {
        state.booted = true;
        welcome();
        refreshCtx();   // 上下文条从会话开始即实时可见
      }
      // 无打开标签时，自动打开 README 或第一个文件
      if (state.monacoReady && !state.openTabs.length) {
        const names = Object.keys(state.files);
        const first = names.find((p) => /^readme\.md$/i.test(p)) || names[0];
        if (first) openFile(first);
      }
      break;
    }
    case "fs.sync": syncFiles(ev.files); break;
    case "engine.info": applyEngineInfo(ev.engine); break;
    case "agent.state": setRunning(ev.running, ev.label); break;
    case "user.msg": {
      // 新任务开始：重置聚合状态 + 加一条分隔线，让多次任务清晰分段
      answerBlock = null; thinkCount = 0; lastThink = null;
      const sep = document.createElement("div");
      sep.className = "run-sep";
      chatStream.appendChild(sep);
      addUserMsg(ev.text);
      break;
    }
    case "op.error": termLine('<span class="tl-err">[操作失败] ' + esc(ev.error) + "</span>"); break;
    case "agent.error": showAgentError(ev); break;
    case "file.saved": {
      state.dirty.delete(ev.path);
      if (state.files[ev.path] && models[ev.path]) state.files[ev.path].content = models[ev.path].getValue();
      renderTabs(); renderTree(); renderChanges();
      if (previewOn && isPreviewable(ev.path)) renderPreview();
      termLine('<span class="tl-info">[已保存] ' + esc(ev.path) + "</span>");
      break;
    }
    case "search.result": renderSearchResults(ev.query, ev.results); break;

    case "think.start": {
      thinkCount++;
      // 自动折叠上一个仍在展开的思考块，避免多段思考同时摊开叠在一起看不清
      if (lastThink && lastThink.classList.contains("open")) lastThink.classList.remove("open", "live");
      const el = document.createElement("div");
      el.className = "think-block open live";
      el.innerHTML = '<div class="think-head">' + ico("bulb") + '<span class="tk-label">思考中…（第 ' + thinkCount + ' 步）</span><span class="chev">' + ico("chevR") + '</span></div><div class="think-body"></div>';
      el.querySelector(".think-head").onclick = () => el.classList.toggle("open");
      appendChatBlock(el); scrollChat();
      const body = el.querySelector(".think-body");
      body.classList.add("type-caret");
      blocks[ev.id] = { el, body, buf: "", step: thinkCount };
      lastThink = el;
      break;
    }
    case "think.delta": {
      const b = blocks[ev.id]; if (!b) break;
      b.buf += ev.text; b.body.textContent = b.buf; scrollChat();
      break;
    }
    case "think.end": {
      const b = blocks[ev.id]; if (!b) break;
      b.body.classList.remove("type-caret");
      b.el.querySelector(".tk-label").textContent = "已深度思考（第 " + (b.step || thinkCount) + " 步，点击展开 / 收起）";
      b.el.classList.remove("open", "live");   // 完成后默认折叠，避免堆叠
      scrollChat();
      break;
    }

    case "msg.start": {
      // 跨轮聚合：一次任务只保留一个「最终回答」气泡，避免被切成多个碎片气泡
      if (answerBlock) {
        answerBlock.el.classList.add("type-caret");
        blocks[ev.id] = answerBlock;
        break;
      }
      const row = document.createElement("div");
      row.className = "msg-row ans-row";
      row.innerHTML = '<div class="msg-avatar">' + ico("sparkle") + "</div>";
      const el = document.createElement("div");
      el.className = "msg msg-ai type-caret";
      row.appendChild(el);
      chatStream.appendChild(row); scrollChat();
      answerBlock = { el, row, buf: "" };
      blocks[ev.id] = answerBlock;
      break;
    }
    case "msg.delta": {
      const b = blocks[ev.id]; if (!b) break;
      b.buf += ev.text; b.el.innerHTML = renderChatMD(b.buf); wireCopyButtons(b.el); b.el.classList.add("type-caret"); scrollChat();
      break;
    }
    case "msg.end": {
      const b = blocks[ev.id]; if (!b) break;
      b.el.classList.remove("type-caret"); scrollChat();
      // 给 AI 回复加「复制全部」按钮（气泡在流式渲染中会被 innerHTML 覆盖，故在结束时挂载）
      const row = b.el.closest(".msg-row");
      if (row && !row.querySelector(".msg-copy")) {
        const full = htmlToMarkdown(b.el).trim() || b.el.textContent.trim();
        addMsgCopyBtn(row, full);
      }
      break;
    }

    case "tool.start": {
      const el = document.createElement("div");
      el.className = "tool-card";
      el.innerHTML = '<div class="tool-head"><span class="t-kind">' + ico(KIND_ICO[ev.kind] || "files") + '</span>' +
        '<span class="t-name">' + esc(ev.name) + '</span><span class="t-target">' + esc(ev.target) + "</span>" +
        '<span class="t-status running">' + ico("spin") + "执行中</span></div><div class=\"tool-body\"></div>";
      el.querySelector(".tool-head").onclick = () => el.classList.toggle("open");
      appendChatBlock(el); scrollChat();
      blocks[ev.id] = { el };
      break;
    }
    case "tool.body": {
      const b = blocks[ev.id]; if (!b) break;
      b.el.querySelector(".tool-body").innerHTML = colorizeDiffText(ev.text);
      break;
    }
    case "tool.end": {
      const b = blocks[ev.id]; if (!b) break;
      const s = b.el.querySelector(".t-status");
      s.className = "t-status " + (ev.ok ? "done" : "fail");
      s.innerHTML = (ev.ok ? ico("check") : ico("error")) + esc(ev.label || (ev.ok ? "完成" : "失败"));
      if (ev.open) b.el.classList.add("open");
      scrollChat();
      break;
    }

    case "tool.pending": renderApproval(ev); break;

    case "term.cmd": termPrompt(ev.text, ev.tabId); if (state.mode === "editor") $("bottomPanel").classList.remove("collapsed"); break;
    case "term.line": termLine('<span class="' + (ev.cls || "tl-cmd") + '">' + esc(ev.text) + "</span>", ev.tabId); break;
    case "term.exit": break;

    case "agent.trace": onTraceEvent(ev.event); break;
    case "agent.usage": onUsageEvent(ev.usage); break;

    case "file.changed": {
      if (ev.deleted) {
        delete state.files[ev.path];
        if (models[ev.path]) { models[ev.path].dispose(); delete models[ev.path]; lspClose(ev.path); }
        state.dirty.delete(ev.path);
        state.openTabs = state.openTabs.filter((p) => p !== ev.path);
      } else {
        state.files[ev.path] = { content: ev.content, original: ev.original, isNew: ev.isNew, lang: ev.lang };
        if (state.monacoReady && models[ev.path] && !state.dirty.has(ev.path) && models[ev.path].getValue() !== ev.content) {
          models[ev.path].setValue(ev.content);
        }
      }
      renderTree(); renderTabs(); renderChanges();
      break;
    }
    case "editor.open": if (state.mode === "editor" && state.files[ev.path]) openFile(ev.path, ev.line); break;

    case "changes": {
      if (!ev.convId || ev.convId === convId) renderChanges(ev.list);
      if (ev.card && ev.list.length) {
        const el = document.createElement("div");
        el.className = "change-summary";
        let inner = '<div class="cs-title">' + ico("diff") + "本次任务改动了 " + ev.list.length + " 个文件（点击查看 Diff）</div>";
        ev.list.forEach((it) => {
          inner += '<div class="cs-file" data-p="' + esc(it.path) + '">' + fileIco(it.path) + " " + esc(it.path) +
            '<span class="cs-stat"><span class="stat-add">+' + it.add + '</span> <span class="stat-del">−' + it.del + "</span></span></div>";
        });
        el.innerHTML = inner;
        el.querySelectorAll(".cs-file").forEach((f) => (f.onclick = () => showDiff(f.dataset.p)));
        appendChatBlock(el); scrollChat();
      }
      break;
    }

    /* ----- 补丁审阅：agent 用 apply_edit 暂存的改动 ----- */
    case "patch.review": openPatchReview(ev); break;
    case "patch.applied": {
      if (ev.empty) { closePatchModal(); break; }
      if (!state.patch) break;
      const set = new Set(ev.paths || []);
      state.patch.files = state.patch.files.filter((f) => !set.has(f.path));
      set.forEach((p) => { try { openFile(p); } catch (e) {} });   // 应用后打开到编辑器
      if (!state.patch.files.length) closePatchModal();
      else { renderPatchList(); renderPatchDiff(state.patch.files[0].path); }
      toast("已接受 " + (ev.paths || []).length + " 个文件改动");
      break;
    }
    case "patch.rejected": {
      if (!state.patch) break;
      const set = new Set(ev.paths || []);
      state.patch.files = state.patch.files.filter((f) => !set.has(f.path));
      if (!state.patch.files.length) closePatchModal();
      else { renderPatchList(); renderPatchDiff(state.patch.files[0].path); }
      toast(ev.all ? "已拒绝全部改动" : "已拒绝 " + (ev.paths || []).length + " 个文件改动");
      break;
    }

    case "agent.done": state.round = ev.round; answerBlock = null; thinkCount = 0; lastThink = null; refreshCtx(); break;
    case "agent.reset": state.round = 0; answerBlock = null; thinkCount = 0; lastThink = null; refreshCtx(); break;

    /* C6：服务端确认会话上下文已切换 */
    case "conv.switched":
      if (ev.messages > 0) termLine('<span class="tl-info">[会话] 已恢复 AI 上下文（' + ev.messages + ' 条消息）</span>');
      refreshCtx();
      break;

    case "plan.created": if (!ev.convId || ev.convId === convId) renderPlan(ev.plan); break;
    case "plan.updated": if (!ev.convId || ev.convId === convId) renderPlan(ev.plan); break;

    case "agent.settings": applyAgentSettings(ev.agent); break;
    case "mcp.servers": if (typeof window.onMcpServers === "function") window.onMcpServers(ev.servers); break;
    case "context.usage": updateCtxBar(ev.used, ev.budget); break;
  }
}

/* ---------------- Agent 设置同步 / 上下文预算条 ---------------- */
let ctxServer = null;   // 服务端实测用量 { used, budget }，优先作为真实值
let _ctxRaf = null;
function applyAgentSettings(a) {
  if (!a) return;
  state.agent = a;
  const sel = inputBox.querySelector("#ciPerm");
  if (sel && a.permissions && a.permissions.mode) sel.value = a.permissions.mode;
  setPlanModeUI(!!(a.planMode));
}
/* 规划模式 UI 同步：切换按钮高亮 + 记录状态（不在此处打印提示，避免每次同步都刷屏） */
function setPlanModeUI(on) {
  const btn = inputBox.querySelector("#btnPlanMode");
  if (btn) btn.classList.toggle("on", on);
  state.planMode = on;
}
/* 客户端估算：与服务端 _estTokens 同口径（content.length / 4），用于流式输出时的真实实时预览 */
function estTokensFromDom() {
  let chars = 0;
  chatStream.querySelectorAll(".msg-user, .msg-ai").forEach((n) => { chars += (n.textContent || "").length; });
  return Math.ceil(chars / 4);
}
/* 上下文真实实时显示：消息条数 + token 用量，随聊天即时刷新 */
function refreshCtx() {
  const wrap = inputBox.querySelector("#ctxBarWrap");
  if (!wrap) return;
  const msgCount = chatStream.querySelectorAll(".msg-user, .msg-ai").length;
  let used, budget, fromServer = false;
  if (ctxServer && ctxServer.budget) { used = ctxServer.used; budget = ctxServer.budget; fromServer = true; }
  else { used = estTokensFromDom(); budget = 1000000; }
  const pct = Math.min(100, Math.round((used / budget) * 100));
  wrap.style.display = "flex";
  const fill = wrap.querySelector("#ctxBarFill");
  fill.style.width = pct + "%";
  fill.className = pct >= 85 ? "warn" : pct >= 60 ? "mid" : "";
  const usedK = used > 1000 ? (used / 1000).toFixed(1) + "k" : used;
  const budK = Math.round(budget / 1000);
  wrap.querySelector("#ctxBarTxt").textContent =
    "上下文 " + msgCount + " 条消息 · " + usedK + "/" + budK + "k tokens（" + pct + "%" +
    (fromServer ? "" : "，估算") + (pct >= 85 ? "，即将自动压缩" : "") + "）";
  wrap.title = "上下文用量" + (fromServer ? "（服务端实测）" : "（本地估算，服务端会校正）") + "；超过 85% 时自动摘要压缩早期消息";
}
/* 服务端 context.usage 事件 → 存储实测值并刷新 */
function updateCtxBar(used, budget) {
  ctxServer = { used, budget };
  refreshCtx();
}

/* ---------------- Agent 状态 ---------------- */
function setRunning(running, label) {
  state.running = running;
  const txt = label || (running ? t("running") : t("aiIdle"));
  // 防御：agSessMeta 等元素可能被 renderConvList 重写覆盖，必须判空，否则 WS 事件触发时整页抛错
  const tb = $("tbAgentState");
  if (tb) {
    tb.className = "agent-state " + (running ? "running" : "idle");
    tb.innerHTML = '<span class="dot"></span>' + esc(txt);
  }
  const sb = $("sbAgentTxt"); if (sb) sb.textContent = txt;
  const meta = $("agSessMeta");
  if (meta) meta.textContent = (running ? t("running") : t("ready")) + " · " + (state.project || "");
  const live = document.querySelector(".ag-live-dot");
  if (live) live.classList.toggle("running", running);
  const liveTxt = $("agLiveTxt"); if (liveTxt) liveTxt.textContent = txt;
  const btn = inputBox.querySelector("#btnSend");
  if (btn) {
    btn.disabled = running;
    if (running) {
      btn.innerHTML = ico("stop") + t("stop");
      btn.classList.add("stop-mode");
      btn.onclick = () => { send({ type: "term.kill" }); send({ type: "newchat" }); };
    } else {
      btn.innerHTML = ico("send") + t("send");
      btn.classList.remove("stop-mode");
      // Agent 空闲时自动处理队列
      if (msgQueue.length > 0) setTimeout(processQueue, 500);
    }
  }
}

/* ---------------- 本地鉴权 ---------------- */
const AUTH = { token: "" };
let _authRedirected = false;   // 防止 401 时反复弹登录窗
let lastUserText = "";         // C2：记录最后一条用户消息，供错误重试使用

function showAuthModal() {
  _authRedirected = false;
  const m = $("authModal"); if (m) m.style.display = "flex";
  const s = $("authStatus"); if (s) { s.textContent = ""; s.className = "set-status"; }
}

/* C2：LLM 错误分类卡片 + 一键重试 */
function showAgentError(ev) {
  const el = document.createElement("div");
  el.className = "msg msg-ai evo-err-card";
  const labels = { quota: "配额耗尽 / 触发限流", network: "网络异常", key: "API Key 无效或未授权", model: "模型不存在", unknown: "未知错误" };
  const label = labels[ev.kind] || "未知错误";
  el.innerHTML = '<div class="evo-err-head">' + ico("warn") + " 出错了：" + esc(label) + "</div>" +
    '<div class="evo-err-msg">' + esc(ev.message || "") + "</div>" +
    '<div class="evo-err-hint">' + esc(ev.hint || "") + "</div>";
  if (ev.kind === "quota" || ev.kind === "network") {
    const btn = document.createElement("button");
    btn.className = "set-btn primary"; btn.textContent = "重试";
    btn.onclick = () => { el.remove(); resendLast(); };
    el.appendChild(btn);
  }
  chatStream.appendChild(el);
  chatStream.scrollTop = chatStream.scrollHeight;
}
function resendLast() {
  if (!lastUserText) { toast("没有可重试的消息"); return; }
  send({ type: "newchat" });
  setTimeout(() => send({ type: "chat", text: lastUserText, attachments: [] }), 250);
}

(function patchFetch() {
  const orig = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    if (AUTH.token && typeof url === "string" && url.startsWith("/api/")) {
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers, { Authorization: "Bearer " + AUTH.token });
    }
    const r = await orig(url, opts);
    if (r.status === 401) {
      let body = {};
      try { body = await r.clone().json(); } catch (e) {}
      if (body && body.code === "NO_AUTH" && !_authRedirected) {
        _authRedirected = true;
        userAuth.token = ""; userAuth.username = "";
        localStorage.removeItem("cw-user-token");
        AUTH.token = "";
        showAuthModal();
      }
    }
    return r;
  };
})();
async function bootstrap() {
  try {
    const r = await fetch("/api/bootstrap").then((x) => x.json());
    if (r && r.token) AUTH.token = r.token;
  } catch (e) { /* 服务未起时静默 */ }
}

/* ---------------- WebSocket ---------------- */
let ws = null;
function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/?token=" + encodeURIComponent(AUTH.token));
  ws.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  // C6：连接/重连建立后，把当前会话 ID 同步给服务端，恢复对应的 AI 上下文
  ws.onopen = () => { if (typeof convId !== "undefined" && convId) { send({ type: "switchConv", convId: convId }); loadTraceHistory(convId); } };
  ws.onclose = () => setTimeout(connect, 1500);
}
/* C6：chat / newchat 统一自动携带当前会话 ID，让服务端上下文与前端会话一一对应 */
function send(obj) {
  if (obj && (obj.type === "chat" || obj.type === "newchat") && !obj.convId &&
      typeof convId !== "undefined" && convId) obj.convId = convId;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

/* ---------------- 附件（图片粘贴 / 拖拽 / 选择） ---------------- */
const ATTACH_MAX = 3, ATTACH_MAX_BYTES = 900 * 1024; // express json limit 2mb，base64 约 ×1.37
const pendingAttach = []; // [{src, name}]

function renderChips() {
  const box = inputBox.querySelector("#ciChips");
  box.innerHTML = "";
  box.style.display = pendingAttach.length ? "flex" : "none";
  pendingAttach.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "ci-chip";
    chip.innerHTML = '<img src="' + a.src + '" alt=""><span class="ci-chip-name">' + esc(a.name) + '</span><button class="ci-chip-x" title="移除">×</button>';
    chip.querySelector(".ci-chip-x").onclick = () => { pendingAttach.splice(i, 1); renderChips(); };
    box.appendChild(chip);
  });
}
function addAttachFile(file) {
  if (!file || !/^image\//.test(file.type)) { termLine('<span class="tl-warn">[附件] 目前仅支持图片附件</span>'); return; }
  if (pendingAttach.length >= ATTACH_MAX) { termLine('<span class="tl-warn">[附件] 最多 ' + ATTACH_MAX + ' 张图片</span>'); return; }
  if (file.size > ATTACH_MAX_BYTES) { termLine('<span class="tl-warn">[附件] ' + esc(file.name || "图片") + " 超过 " + Math.round(ATTACH_MAX_BYTES / 1024) + "KB 限制</span>"); return; }
  const rd = new FileReader();
  rd.onload = () => { pendingAttach.push({ src: rd.result, name: file.name || "粘贴图片.png" }); renderChips(); };
  rd.readAsDataURL(file);
}

/* ---------------- 输入事件 + 消息排队 ---------------- */
let activeSkill = null;
const msgQueue = [];  // 消息队列
const sentHistory = {};   // 各会话的已发消息历史，供 ↑/↓ 浏览：{ convId: [text, ...] }
let histNav = -1;         // 历史浏览指针，-1 表示正在正常编辑（不在浏览历史）

function renderQueueBadge() {
  let badge = inputBox.querySelector("#ciQueueBadge");
  if (msgQueue.length > 0) {
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "ciQueueBadge";
      badge.className = "ci-queue-badge";
      inputBox.querySelector(".ci-bottom").insertBefore(badge, inputBox.querySelector("#btnSend"));
    }
    badge.textContent = "排队 " + msgQueue.length;
    badge.style.display = "inline-flex";
  } else if (badge) {
    badge.style.display = "none";
  }
}

function processQueue() {
  if (state.running || msgQueue.length === 0) return;
  const { text, attachments } = msgQueue.shift();
  renderQueueBadge();
  lastUserText = text; send({ type: "chat", text, attachments });
}

function bindInput() {
  const ta = inputBox.querySelector("#chatInput");
  let atMenu = null;
  const doSend = () => {
    const v = ta.value.trim();
    if (!v && !pendingAttach.length) return;
    ta.value = "";
    // 记录到当前会话的发送历史，供 ↑/↓ 浏览回填
    const curConv = (typeof convId !== "undefined" && convId) || "default";
    (sentHistory[curConv] = sentHistory[curConv] || []);
    if (v) sentHistory[curConv].push(v);
    histNav = -1;
    const attachments = pendingAttach.splice(0, pendingAttach.length).map((a) => ({ src: a.src, name: a.name }));
    renderChips();
    let text = v || "（请分析所附图片）";
    if (activeSkill) {
      text = "[引用 Skill: " + activeSkill.name + "]\n" + (activeSkill.description || "") + "\n\n" + activeSkill.body + "\n\n---\n\n" + text;
      fetch("/api/skills/market/" + activeSkill.id + "/use", { method: "POST" }).catch(() => {});
    }
    // 如果 Agent 正在运行，加入队列
    if (state.running) {
      msgQueue.push({ text, attachments });
      renderQueueBadge();
      toast("已加入队列（第 " + msgQueue.length + " 条），Agent 完成后自动执行");
    } else {
      lastUserText = text; send({ type: "chat", text, attachments });
    }
    if (attachments.length) termLine('<span class="tl-info">[附件] 已随消息发送 ' + attachments.length + " 张图片</span>");
  };
  inputBox.querySelector("#btnSend").onclick = doSend;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { if (atMenu && atMenu.style.display !== "none") return; e.preventDefault(); doSend(); }
  });

  // C1b：@文件 / @目录 补全（意图→结果闭环提速）
  atMenu = document.createElement("div");
  atMenu.className = "at-menu"; atMenu.style.display = "none";
  document.body.appendChild(atMenu);
  let atState = null, atItems = [], atIdx = 0;
  const hideAtMenu = () => { if (atMenu) atMenu.style.display = "none"; atState = null; };
  const refreshAtActive = () => atMenu.querySelectorAll(".at-item").forEach((el, i) => el.classList.toggle("active", i === atIdx));
  const pickAtItem = (i) => {
    const it = atItems[i]; if (!it || !atState) return;
    const pos = ta.selectionStart, val = ta.value;
    const insert = "@" + it.kind + ":" + it.path + " ";
    ta.value = val.slice(0, atState.start) + insert + val.slice(pos);
    const np = atState.start + insert.length;
    ta.setSelectionRange(np, np); ta.focus(); hideAtMenu();
  };
  const showAtMenu = (items) => {
    atItems = items; atIdx = 0;
    if (!items.length) { hideAtMenu(); return; }
    atMenu.innerHTML = items.map((it, i) => '<div class="at-item' + (i === 0 ? " active" : "") + '" data-i="' + i + '"><span class="at-kind">' + (it.kind === "folder" ? "目录" : "文件") + '</span>' + esc(it.path) + '</div>').join("");
    atMenu.style.display = "block";
    const r = ta.getBoundingClientRect();
    atMenu.style.left = Math.max(8, r.left) + "px";
    atMenu.style.top = Math.max(8, r.top - atMenu.offsetHeight - 6) + "px";
    atMenu.querySelectorAll(".at-item").forEach((el) => el.onclick = () => pickAtItem(parseInt(el.dataset.i, 10)));
  };
  const onAtInput = () => {
    histNav = -1;   // 用户手动编辑即退出历史浏览
    const pos = ta.selectionStart, before = ta.value.slice(0, pos);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) { hideAtMenu(); return; }
    let q = m[2], kind = "file";
    if (q.startsWith("folder:")) { kind = "folder"; q = q.slice(7); }
    else if (q.startsWith("file:")) { q = q.slice(5); }
    const pool = Object.keys(state.files).filter((p) => p.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
    const items = pool.map((p) => ({ kind: "file", path: p }));
    atState = { start: pos - m[2].length - 1 };
    showAtMenu(items);
  };
  ta.addEventListener("input", onAtInput);

  // 上下键浏览当前会话已发消息：↑ 更旧 / ↓ 更新（回到最新后继续 ↓ 清空输入框）
  const navHistory = (dir) => {
    const curConv = (typeof convId !== "undefined" && convId) || "default";
    const h = sentHistory[curConv] || [];
    if (!h.length) return;
    if (histNav === -1) {
      if (dir < 0) return;          // 已在最新，没有更新的
      histNav = h.length - 1;       // 从最近一条开始
    } else {
      histNav += dir;
    }
    if (histNav < 0) { histNav = -1; ta.value = ""; ta.focus(); return; }   // 越过最新 → 清空
    if (histNav >= h.length) { histNav = h.length - 1; return; }            // 夹在最早一条
    ta.value = h[histNav];
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };

  ta.addEventListener("keydown", (e) => {
    if (atMenu && atMenu.style.display !== "none") {
      // @ 文件/目录 补全菜单导航
      if (e.key === "Escape") hideAtMenu();
      else if (e.key === "ArrowDown") { e.preventDefault(); atIdx = (atIdx + 1) % atItems.length; refreshAtActive(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); atIdx = (atIdx - 1 + atItems.length) % atItems.length; refreshAtActive(); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickAtItem(atIdx); }
      return;
    }
    // 历史消息浏览（@ 菜单未打开时）
    // 仅在「不会妨碍多行编辑」时接管方向键：单行内容随时可翻历史；
    // 多行内容只在光标处于最开头（↑）/ 最末尾（↓）时才翻历史，
    // 其余情况交还输入框做正常跨行移动（否则 Shift+Enter 写的多行提示词无法上下移光标）。
    const collapsed = ta.selectionStart === ta.selectionEnd;
    const singleLine = ta.value.indexOf("\n") === -1;
    const atStart = collapsed && ta.selectionStart === 0;
    const atEnd = collapsed && ta.selectionStart === ta.value.length;
    if (e.key === "ArrowUp" && (singleLine || atStart)) { e.preventDefault(); navHistory(1); }
    else if (e.key === "ArrowDown" && (singleLine || atEnd)) { e.preventDefault(); navHistory(-1); }
  });
  document.addEventListener("click", (e) => { if (atMenu && atMenu.style.display !== "none" && !atMenu.contains(e.target) && e.target !== ta) hideAtMenu(); });

  // 附件：按钮选择 / 粘贴 / 拖拽
  const fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.multiple = true; fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  fileInput.onchange = () => { Array.from(fileInput.files || []).forEach(addAttachFile); fileInput.value = ""; };
  inputBox.querySelector("#btnAttach").onclick = () => fileInput.click();
  ta.addEventListener("paste", (e) => {
    const items = (e.clipboardData || {}).items || [];
    for (const it of items) {
      if (it.kind === "file" && /^image\//.test(it.type)) { e.preventDefault(); addAttachFile(it.getAsFile()); }
    }
  });
  inputBox.addEventListener("dragover", (e) => { e.preventDefault(); inputBox.classList.add("drag"); });
  inputBox.addEventListener("dragleave", () => inputBox.classList.remove("drag"));
  inputBox.addEventListener("drop", (e) => {
    e.preventDefault(); inputBox.classList.remove("drag");
    Array.from((e.dataTransfer || {}).files || []).forEach(addAttachFile);
  });

  // 权限模式快捷切换
  inputBox.querySelector("#ciPerm").onchange = async (e) => {
    const mode = e.target.value;
    try {
      await fetch("/api/agent-settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: { mode } }),
      });
      const label = { ask: "逐项确认", semi: "半自动（安全操作放行，写入仍确认）", auto: "全自动（高危仍会拦截）" }[mode] || mode;
      termLine('<span class="tl-info">[Agent] 权限模式 → ' + label + "</span>");
    } catch (err) { termLine('<span class="tl-err">[Agent] 权限切换失败: ' + esc(err.message) + "</span>"); }
  };
  // 规划模式开关：开启后 Agent 仅可读/检索/规划，禁止任何写文件或执行命令
  inputBox.querySelector("#btnPlanMode").onclick = async () => {
    const on = !state.planMode;
    try {
      await fetch("/api/agent-settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planMode: on }),
      });
      setPlanModeUI(on);
      toast(on ? "规划模式已开启：Agent 仅规划，不改动文件" : "已切回执行模式");
      termLine('<span class="tl-info">[规划模式] ' + (on ? "已开启：Agent 只可阅读/检索/规划，禁止修改文件或执行命令，待你审阅计划后切回执行" : "已关闭：Agent 可正常修改文件与执行命令") + "</span>");
    } catch (err) { termLine('<span class="tl-err">[规划模式] 切换失败: ' + esc(err.message) + "</span>"); }
  };

  // Skill 选择器
  const btnSkillPick = inputBox.querySelector("#btnSkillPick");
  const ciSkillPop = inputBox.querySelector("#ciSkillPop");
  if (btnSkillPick) {
    btnSkillPick.addEventListener("click", (e) => {
      e.stopPropagation();
      const show = ciSkillPop.style.display === "none";
      ciSkillPop.style.display = show ? "block" : "none";
      if (show) renderSkillPop();
    });
    ciSkillPop.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => { ciSkillPop.style.display = "none"; });
  }
  const ti = terminal.querySelector("#termInput");
  ti.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const cmd = ti.value.trim();
      if (!cmd) return;
      ti.value = "";
      send({ type: "term.exec", tabId: termActive, cmd });
    }
    if (e.key === "c" && e.ctrlKey) send({ type: "term.kill", tabId: termActive });
  });
  terminal.querySelector("#termKill").onclick = () => send({ type: "term.kill", tabId: termActive });
}

/* ---------------- 会话历史（本地持久化，跨刷新保留） ---------------- */
/* 会话存储 key：按工作区隔离（切换项目后对话列表/active 各自独立，互不串扰）。
   用工作区路径做哈希后缀，localStorage 里保留各项目独立的一份。 */
const CONV_LS_BASE = "cw-conv-v1";
const CONV_ACTIVE_BASE = "cw-conv-active";
let _wsId = null;   // 服务端 hello 下发的稳定工作区 ID（绝对路径哈希）；优先用于会话存储 key，确保刷新前后一致（修复相对/绝对路径导致聊天记录丢失）
function _wsHash() {
  if (_wsId) return _wsId;
  const ws = state.workspace || "default";
  let h = 0;
  for (let i = 0; i < ws.length; i++) h = (h * 31 + ws.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function convListKey() { return CONV_LS_BASE + ":" + _wsHash(); }
function convActiveKey() { return CONV_ACTIVE_BASE + ":" + _wsHash(); }
let convId = null;
let convObs = null;

function loadConvList() {
  try { return JSON.parse(localStorage.getItem(convListKey())) || []; } catch (e) { return []; }
}
function saveConvList(list) {
  try { localStorage.setItem(convListKey(), JSON.stringify(list)); } catch (e) {}
}
function genConvId() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function convFirstUserTitle() {
  const u = chatStream.querySelector(".msg-user");
  if (u) { const t = (u.textContent || "").trim().replace(/\s+/g, " ").slice(0, 32); if (t) return t; }
  return "";
}

function persistConv() {
  if (!convId) return;
  const list = loadConvList();
  const c = list.find((x) => x.id === convId);
  if (!c) return;
  c.dom = chatStream.innerHTML;
  const t = convFirstUserTitle();
  if (t && (!c.title || c.title === "新对话")) c.title = t;
  // 不更新 ts，保持创建时间排序不变，避免会话列表跳动
  saveConvList(list);
}

function initConvObserver() {
  let t = null;
  convObs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(persistConv, 500); });
  convObs.observe(chatStream, { childList: true, subtree: true, characterData: true });
}

function renderConvList() {
  const host = $("agSessionList");
  if (!host) return;
  const list = loadConvList();
  list.sort((a, b) => b.ts - a.ts);          // 按创建时间排序，不重新保存
  host.innerHTML = "";
  if (!list.length) {
    host.innerHTML = '<div class="ag-session"><div class="ag-sess-main"><div class="ag-sess-name ag-sess-empty">暂无历史对话</div></div></div>';
    return;
  }
  list.forEach((c) => {
    const item = document.createElement("div");
    item.className = "ag-session" + (c.id === convId ? " active" : "");
    const d = new Date(c.ts);
    const meta = (d.getMonth() + 1) + "/" + d.getDate() + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    item.innerHTML =
      '<span class="ag-sess-dot' + (c.id === convId ? "" : " done") + '" title="' + (c.id === convId ? "进行中" : "历史对话") + '"></span>' +
      '<div class="ag-sess-main">' +
        '<div class="ag-sess-name">' + esc(c.title || "新对话") + '</div>' +
        '<div class="ag-sess-meta">' + meta + '</div>' +
      '</div>' +
      '<button class="ag-sess-del" title="删除此对话"><i data-ico="close"></i></button>';
    item.querySelector(".ag-sess-name").ondblclick = (e) => { e.stopPropagation(); var newName = prompt("输入新名称：", c.title || "新对话"); if (newName && newName.trim()) { c.title = newName.trim(); var l2 = loadConvList(); var f = l2.find(function(x){return x.id===c.id;}); if(f){f.title=newName.trim();saveConvList(l2);} renderConvList(); } };
    item.addEventListener("click", (e) => { if (e.target.closest(".ag-sess-del")) return; openConv(c.id); });
    const del = item.querySelector(".ag-sess-del");
    if (del) del.addEventListener("click", (e) => { e.stopPropagation(); deleteConv(c.id); });
    host.appendChild(item);
  });
  replaceIcons();
}

function openConv(id) {
  if (id === convId) return;
  convId = id;
  localStorage.setItem(convActiveKey(), id);
  send({ type: "switchConv", convId: id });   // C6：同步切换服务端 AI 上下文
  loadTraceHistory(id);
  const c = loadConvList().find((x) => x.id === id);
  chatStream.innerHTML = c && c.dom ? c.dom : "";
  for (const k in blocks) delete blocks[k];
  answerBlock = null; thinkCount = 0; lastThink = null;
  scrollChat();
  refreshCtx();
  loadPlan(convId);                                                      // 切换该会话的任务计划
  renderConvList();
  replaceIcons();
}

function deleteConv(id) {
  const list = loadConvList().filter((x) => x.id !== id);
  saveConvList(list);
  send({ type: "dropConv", convId: id });     // C6：同步清理服务端上下文
  if (id === convId) {
    if (list.length) openConv(list[0].id);
    else startNewConv(true);
  }
  renderConvList();
}

function startNewConv(announce) {
  convId = genConvId();
  localStorage.setItem(convActiveKey(), convId);
  const list = loadConvList();
  list.unshift({ id: convId, title: "新对话", ts: Date.now(), dom: "" });
  saveConvList(list);
  clearPlanPanel();                  // 新会话无任务计划
  if (announce) {
    chatStream.innerHTML = "";
    for (const k in blocks) delete blocks[k];
    answerBlock = null; thinkCount = 0; lastThink = null;
    const el = document.createElement("div");
    el.className = "msg msg-ai";
    el.innerHTML = mdLite("已开始 **新对话**。上一轮上下文已清空，随时描述你的下一个任务。");
    chatStream.appendChild(el);
    scrollChat();
    refreshCtx();
  }
  renderConvList();
}

/* 切换工作区时按新工作区重载对话（隔离存储）：
   清空当前 DOM / 终端 / 状态，从新工作区 key 恢复会话或开新对话，并同步服务端会话。 */
function reloadConvForWs() {
  for (const k in blocks) delete blocks[k];
  answerBlock = null; thinkCount = 0; lastThink = null;
  chatStream.innerHTML = "";
  clearPlanPanel();
  const id = localStorage.getItem(convActiveKey());
  const c = id && loadConvList().find((x) => x.id === id);
  if (!c) { startNewConv(false); }
  else {
    convId = id;
    chatStream.innerHTML = c.dom || "";
    for (const k in blocks) delete blocks[k];
    answerBlock = null; thinkCount = 0; lastThink = null;
    scrollChat();
    loadPlan(convId);
  }
  renderConvList();
  replaceIcons();
  refreshCtx();
  // 同步服务端：切换工作区后引擎已重建（新会话），通知前端跟随
  if (ws && ws.readyState === 1 && convId) { send({ type: "switchConv", convId: convId }); loadTraceHistory(convId); }
}

/* 启动时恢复上次会话（历史跨刷新保留） */
function restoreConv() {
  convId = localStorage.getItem(convActiveKey());
  const list = loadConvList();
  const c = convId && list.find((x) => x.id === convId);
  if (!c) { startNewConv(false); return; }
  chatStream.innerHTML = c.dom || "";
  for (const k in blocks) delete blocks[k];
  answerBlock = null; thinkCount = 0; lastThink = null;
  renderConvList();
  replaceIcons();
  scrollChat();
  loadPlan(convId);                              // 恢复该会话的任务计划
}

function newConversation() {
  if (state.running) return;
  // 真正的新对话：当前会话已由 observer 持久化；新建本地会话并清空服务端 AI 上下文（保留文件改动）
  clearTrace();
  startNewConv(true);
  send({ type: "newchat" });
}
$("agNewTask").onclick = newConversation;
$("agExport").onclick = exportConversation;

/* 通用确认弹窗：用于还原工作区等危险操作，让用户二次确认 */
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
$("btnReset").onclick = () => {
  if (state.running) { toast("Agent 正在运行，请先停止再还原"); return; }
  const n = state.dirty ? state.dirty.size : 0;
  showConfirm("还原工作区",
    "将丢弃全部未保存的更改" + (n ? "（当前有 <b>" + n + "</b> 个文件存在未保存编辑）" : "") +
    "，并恢复到 Git / 快照基线。<br><b style=\"color:var(--err)\">此操作不可撤销</b>，确定要继续吗？",
    () => {
      if (state.dirty) state.dirty.clear();
      send({ type: "reset" });
      toast("工作区已开始还原");
    });
};

/* ---------------- 全局快捷键 ---------------- */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("shortcutsModal") && $("shortcutsModal").style.display !== "none") {
    $("shortcutsModal").style.display = "none"; return;
  }
  if (e.key === "Escape" && $("commitModal") && $("commitModal").style.display !== "none") {
    $("commitModal").style.display = "none"; return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveActiveFile(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === "." || e.code === "Period")) {
    e.preventDefault();
    const target = state.mode === "editor" ? "agents" : "editor";
    switchMode(target);
    toast("已切换至 " + (target === "editor" ? "编辑器" : "Agents") + " 窗口（Ctrl/Cmd + . 切换）");
  }
});


/* ---------------- 用户认证 ---------------- */
const userAuth = { token: localStorage.getItem("cw-user-token") || "", username: "" };

async function checkAuth() {
  try {
    const r = await fetch("/api/auth/status?userToken=" + encodeURIComponent(userAuth.token)).then((x) => x.json());
    if (r.loggedIn) {
      userAuth.username = r.username;
      AUTH.token = userAuth.token;   // A1：登录态 → 让后续所有 API 请求带上 userToken（登录闸门生效）
      $("tbUserTxt").textContent = r.username;
      $("tbUserBtn").classList.add("logged");
      return true;
    } else {
      userAuth.token = ""; userAuth.username = "";
      AUTH.token = "";
      $("tbUserTxt").textContent = "未登录";
      $("tbUserBtn").classList.remove("logged");
      return false;
    }
  } catch (e) { return false; }
}

$("tbUserBtn").onclick = () => showAuthModal();
$("authClose").onclick = () => ($("authModal").style.display = "none");
// 登录弹窗只点 X 关闭，点击外部不关闭

let authMode = "login";
$("authSwitch").onclick = () => {
  authMode = authMode === "login" ? "register" : "login";
  $("authTitle").textContent = authMode === "login" ? "登录" : "注册";
  $("authSubmit").textContent = authMode === "login" ? "登录" : "注册";
  $("authSwitch").textContent = authMode === "login" ? "注册新账号" : "返回登录";
  $("authStatus").textContent = "";
};

$("authSubmit").onclick = async () => {
  const u = $("authUser").value.trim(), p = $("authPass").value;
  if (!u || !p) { $("authStatus").className = "set-status err"; $("authStatus").textContent = "请填写用户名和密码"; return; }
  const url = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, password: p }) }).then((x) => x.json());
    if (r.ok) {
      userAuth.token = r.token; userAuth.username = r.username;
      AUTH.token = r.token;   // A1：登录成功 → 后续请求带 userToken（登录闸门生效）
      localStorage.setItem("cw-user-token", r.token);
      $("tbUserTxt").textContent = r.username;
      $("tbUserBtn").classList.add("logged");
      $("authModal").style.display = "none";
      _authRedirected = false;
      toast(authMode === "login" ? "✅ 登录成功" : "✅ 注册成功");
      startApp(); maybeOnboard();   // 登录后才加载工作区数据并连接 WS，并触发首次引导
    } else {
      $("authStatus").className = "set-status err";
      $("authStatus").textContent = r.error;
    }
  } catch (e) { $("authStatus").className = "set-status err"; $("authStatus").textContent = "请求异常: " + e.message; }
};

/* ---------------- Skills 市场 ---------------- */
let allSkills = [];   // 所有 Skills（市场+工作区）
let builtinSkills = []; // 内置 Workflow
let skillCategories = {}; // 分类定义

async function loadSkills() {
  try {
    const r = await fetch("/api/skills/all").then((x) => x.json());
    allSkills = r.skills || [];
    builtinSkills = r.builtin || [];
    skillCategories = r.categories || {};
    renderSkillsList();
  } catch (e) {}
}



/* ---------------- 任务计划渲染 ---------------- */
const PLAN_ICONS = { pending: "○", in_progress: "◐", done: "●", skipped: "×" };
function renderPlan(plan) {
  if (!plan) return;
  const box = $("agPlanEmpty");
  const active = $("agPlanActive");
  if (box) box.style.display = "none";
  if (active) active.style.display = "block";
  const done = plan.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
  const total = plan.tasks.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const statusLabel = plan.status === "completed" ? "已完成" : "进行中";
  const statusClass = plan.status === "completed" ? "done" : "active";
  let html = '<div class="plan-title">' + ico("tasklist") + '<span>' + esc(plan.title) + '</span><span class="plan-status ' + statusClass + '">' + statusLabel + '</span></div>';
  plan.tasks.forEach((t, i) => {
    const cls = t.status;
    const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "●" : t.status === "skipped" ? "×" : "";
    html += '<div class="plan-task ' + cls + '"><span class="plan-check">' + icon + '</span><span class="plan-text">' + esc(t.text) + (t.note ? ' <span style="color:var(--text-dim);font-size:10px">(' + esc(t.note) + ')</span>' : "") + '</span></div>';
  });
  html += '<div class="plan-progress"><span>' + done + '/' + total + '</span><div class="plan-progress-bar"><div class="plan-progress-fill" style="width:' + pct + '%"></div></div><span>' + pct + '%</span></div>';
  if (active) { active.innerHTML = html; replaceIcons(active); }
  // C1a：同步常驻进度条（计划进行中显示，完成则隐藏）
  const sticky = $("planSticky");
  if (sticky) {
    if (!plan || plan.status === "completed") sticky.hidden = true;
    else {
      sticky.hidden = false;
      sticky.innerHTML = '<span class="ps-title">' + ico("tasklist") + '计划进度</span>' +
        '<span class="ps-count">' + done + '/' + total + '</span>' +
        '<div class="ps-bar"><div class="ps-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="ps-pct">' + pct + '%</span>';
      replaceIcons(sticky);
    }
  }
}

function clearPlanPanel() {
  const box = $("agPlanEmpty"), active = $("agPlanActive"), sticky = $("planSticky");
  if (box) box.style.display = "block";
  if (active) { active.style.display = "none"; active.innerHTML = ""; }
  if (sticky) sticky.hidden = true;
}
async function loadPlan(cid) {
  const id = cid || convId || "default";
  try {
    const r = await fetch("/api/plans?convId=" + encodeURIComponent(id)).then((x) => x.json());
    if (r.active) renderPlan(r.active); else clearPlanPanel();
  } catch (e) {}
}

/* ---------------- Goal 模式 ---------------- */
let goalMode = false;
let goalPollTimer = null;

function setGoalMode(active) {
  goalMode = active;
  const btn = $("btnGoal");
  if (btn) btn.classList.toggle("active", active);
  if (!active && goalPollTimer) { clearInterval(goalPollTimer); goalPollTimer = null; }
}

$("btnGoal").onclick = (e) => {
  e.stopPropagation();
  const pop = $("goalPop");
  const show = pop.style.display === "none";
  pop.style.display = show ? "flex" : "none";
  if (show) $("goalInput").focus();
};
$("goalPop").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => { $("goalPop").style.display = "none"; });

$("goalStart").onclick = () => {
  const goal = $("goalInput").value.trim();
  if (!goal) return;
  $("goalPop").style.display = "none";
  $("goalInput").value = "";
  setGoalMode(true);
  send({ type: "chat", text: "[GOAL MODE] 请创建计划并持续执行，直到完成以下目标后自动停止：\n\n" + goal + "\n\n要求：\n1. 先用 create_plan 拆解为具体子任务\n2. 逐个执行，每完成一步用 update_plan 标记\n3. 每步执行后验证结果，失败则修复重试\n4. 所有步骤完成后用 create_plan 的任务全部 done 来结束\n5. 中间不要停下来询问用户，自主推进", attachments: [] });
  toast("Goal 已启动，Agent 将持续执行直到完成");
};

/* 当 Agent 完成时检查是否在 goal 模式 */
const _origHandleEvent = handleEvent;

/* ---------------- 语言切换 ---------------- */
(function(){
  var LANG_BTN=document.getElementById("btnLangToggle");
  if(LANG_BTN){
    LANG_BTN.onclick=function(){
      var cur=localStorage.getItem("cw-lang")||"zh";
      var nxt=cur==="zh"?"en":"zh";
      if(typeof setLang==="function") setLang(nxt);
    };
    // 初始按持久化语言应用一次（默认 zh 时静态 HTML 已为中文，无需处理）
    var cur=localStorage.getItem("cw-lang")||"zh";
    if(cur!=="zh" && typeof setLang==="function") setLang(cur);
  }
})();

/* ---------------- 启动 ---------------- */
applyTheme(getTheme());
$("hpClose").onclick = () => togglePreview(false);
$("hpRefresh").onclick = () => renderPreview();
initResizers();
replaceIcons();
mountShared();
refreshAgents();
initConvObserver();
bindInput();
/* A1：登录成为闸门——先领取本机令牌，再判定登录态；未登录只显示登录/注册，不加载工作区数据、不连 WS */
async function startApp() {
  if (ws) { try { ws.close(); } catch (e) {} }
  loadSkills(); loadPlan(convId); connect();
}

/* ===== B5 全局加载遮罩 · 品牌开场 ===== */
let bootShownAt = 0;
const BOOT_MIN_DWELL = 1300; // 品牌开场最短停留，保证艺术入场被看见（而非一闪而过）
function showBoot() {
  const b = $("bootScreen");
  if (b) { b.classList.remove("hidden", "boot-exit", "boot-done"); bootShownAt = Date.now(); }
}
function hideBoot() {
  const b = $("bootScreen");
  if (!b || b.classList.contains("hidden")) return;
  const wait = Math.max(0, BOOT_MIN_DWELL - (Date.now() - bootShownAt));
  setTimeout(() => {
    b.classList.add("boot-done");   // 进度条拉满
    b.classList.add("boot-exit");   // 电影化退场（淡出 + 微缩放 + 模糊）
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      b.classList.add("hidden");
      b.classList.remove("boot-exit", "boot-done");
    };
    // 仅响应 bootScreen 自身的退场动画结束；子元素动画冒泡不触发
    const onEnd = (e) => {
      if (e.target === b && e.animationName === "bootExit") {
        b.removeEventListener("animationend", onEnd);
        done();
      }
    };
    b.addEventListener("animationend", onEnd);
    setTimeout(done, 850); // 兜底：reduced-motion 或动画未触发时也能收敛
  }, wait);
}


bootstrap().then(async () => {
  const loggedIn = await checkAuth();
  hideBoot();
  if (loggedIn) { startApp(); maybeOnboard(); }
  else showAuthModal();
}).catch(() => { hideBoot(); showAuthModal(); });
bootMonaco();
