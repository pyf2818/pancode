/* ============================================================
   pancode 前端 v2.0 — Monaco 可写编辑器 + WebSocket 实时通信
   - 编辑器真实保存（Ctrl+S）、脏标记、外部变更同步
   - 文件树 CRUD：新建 / 重命名 / 删除（右键菜单）
   - 服务端全文搜索、Git 基线 Diff、LLM 设置面板
   ============================================================ */
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  project: "workspace",
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
        { label: "在此目录新建文件", ic: "filePlus", fn: () => promptNewFile(path + "/") },
        { label: "删除目录", ic: "trash", danger: true, fn: () => { if (confirm("确定删除目录 " + path + " 及其全部内容？")) send({ type: "file.delete", path }); } },
      ]
    : [
        { label: "打开", ic: "files", fn: () => openFile(path) },
        { label: "重命名", ic: "edit", fn: () => {
            const np = prompt("重命名为（相对路径）：", path);
            if (np && np !== path) send({ type: "file.rename", path, newPath: np });
          } },
        { label: "查看 Diff", ic: "diff", fn: () => showDiff(path) },
        { label: "删除", ic: "trash", danger: true, fn: () => { if (confirm("确定删除 " + path + "？")) send({ type: "file.delete", path }); } },
      ];
  menu.innerHTML = "";
  items.forEach((it) => {
    const d = document.createElement("div");
    d.className = "ctx-item" + (it.danger ? " danger" : "");
    d.innerHTML = ico(it.ic) + esc(it.label);
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
      if (previewOn && isPreviewable(path)) schedulePreview();
    });
    models[path] = m;
  }
  return models[path];
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
  let px = null;
  const pvW0 = parseInt(localStorage.getItem("cw-preview-w"));
  if (pvW0 && hp.classList.contains("show")) { hp.style.flex = "none"; hp.style.width = pvW0 + "px"; hp.classList.add("sized"); }
  pvR.addEventListener("mousedown", (e) => {
    if (!hp.classList.contains("show")) return;
    hp.style.flex = "none"; hp.classList.add("sized");
    px = e.clientX; pvR.classList.add("dragging"); document.body.style.cursor = "col-resize"; e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (px === null) return;
    let w = hp.offsetWidth - (e.clientX - px);
    w = Math.max(200, Math.min(window.innerWidth * 0.65, w));
    hp.style.width = w + "px"; px = e.clientX;
    if (state.monacoReady && editor) editor.layout();
  });
  window.addEventListener("mouseup", () => {
    if (px === null) return; px = null; pvR.classList.remove("dragging"); document.body.style.cursor = "";
    localStorage.setItem("cw-preview-w", hp.offsetWidth); if (editor) editor.layout();
  });
  pvR.addEventListener("dblclick", () => {
    hp.style.flex = "1"; hp.style.width = ""; hp.classList.remove("sized");
    localStorage.removeItem("cw-preview-w"); if (editor) editor.layout();
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
let previewOn = false, previewTimer = null;
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

function renderPreview() {
  const path = state.activeFile;
  const frame = $("hpFrame");
  if (!previewOn || !path || !isPreviewable(path) || !models[path]) return;
  const val = models[path].getValue();
  if (extOf(path) === "html" || extOf(path) === "htm") {
    frame.srcdoc = val;
  } else {
    frame.srcdoc = "<!DOCTYPE html><html><head><meta charset='utf-8'><style>" + MD_CSS + "</style></head><body class='md-body'>" + renderMarkdown(val) + "</body></html>";
  }
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
    if (pvR) pvR.classList.add("show");
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
$("searchInput").addEventListener("input", function () {
  clearTimeout(searchTimer);
  const q = this.value.trim();
  if (q.length < 2) { $("searchResults").innerHTML = ""; return; }
  searchTimer = setTimeout(() => send({ type: "search", query: q }), 200);
});

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

/* ---------------- 活动栏 ---------------- */
document.querySelectorAll(".ab-btn").forEach((btn) => {
  btn.onclick = () => {
    const v = btn.dataset.view;
    if (v === "ai") { switchMode("agents"); return; }
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
    if (v === "search") setTimeout(() => $("searchInput").focus(), 50);
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

/* ---------------- 终端渲染 ---------------- */
function termLine(html) {
  const lines = $("termLines");
  const div = document.createElement("div");
  div.className = "tl";
  div.innerHTML = html;
  lines.appendChild(div);
  while (lines.children.length > 800) lines.removeChild(lines.firstChild);
  lines.scrollTop = lines.scrollHeight;
}
function termPrompt(cmd) {
  termLine('<span class="tl-prompt">user@pancode</span><span class="tl-dim">:</span><span class="tl-info">~/' + esc(state.project) + '</span><span class="tl-dim">$ </span><span class="tl-cmd">' + esc(cmd) + "</span>");
}

/* ---------------- 聊天流渲染 ---------------- */
const blocks = {};
let answerBlock = null;   // 跨轮聚合的最终回答气泡（一次任务 = 一个气泡）
let thinkCount = 0;       // 本次任务的思考步序号
let lastThink = null;     // 当前正在流式输出的思考块（用于自动折叠上一个）
function scrollChat() { chatStream.scrollTop = chatStream.scrollHeight; }

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
  chatStream.appendChild(el); scrollChat();
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
      if (!files[p]) { models[p].dispose(); delete models[p]; state.dirty.delete(p); continue; }
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
  chatStream.appendChild(el); scrollChat();
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
      $("projName").textContent = state.project.toUpperCase();
      document.querySelector(".tb-project").textContent = state.project;
      if (ev.workspace) $("btnOpenFolder").title = "当前工作区: " + ev.workspace + "（点击打开其他文件夹）";
      const cwd = $("termCwd"); if (cwd) cwd.textContent = "~/" + state.project;
      if (ev.truncated) termLine('<span class="tl-warn">[提示] 该文件夹文件较多，文件树仅加载前 500 个文本文件（终端与 AI 仍可操作全部文件）</span>');
      if (ev.git) $("sbBranch").textContent = ev.git.git ? ev.git.branch : "无 Git（快照基线）";
      if (ev.engine) applyEngineInfo(ev.engine);
      if (ev.agent) applyAgentSettings(ev.agent);
      syncFiles(ev.files);
      setRunning(ev.running, null);
      if (!state.booted) {
        state.booted = true;
        welcome();
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
      chatStream.appendChild(el); scrollChat();
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
      answerBlock = { el, buf: "" };
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
      break;
    }

    case "tool.start": {
      const el = document.createElement("div");
      el.className = "tool-card";
      el.innerHTML = '<div class="tool-head"><span class="t-kind">' + ico(KIND_ICO[ev.kind] || "files") + '</span>' +
        '<span class="t-name">' + esc(ev.name) + '</span><span class="t-target">' + esc(ev.target) + "</span>" +
        '<span class="t-status running">' + ico("spin") + "执行中</span></div><div class=\"tool-body\"></div>";
      el.querySelector(".tool-head").onclick = () => el.classList.toggle("open");
      chatStream.appendChild(el); scrollChat();
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

    case "term.cmd": termPrompt(ev.text); if (state.mode === "editor") $("bottomPanel").classList.remove("collapsed"); break;
    case "term.line": termLine('<span class="' + (ev.cls || "tl-cmd") + '">' + esc(ev.text) + "</span>"); break;
    case "term.exit": break;

    case "file.changed": {
      if (ev.deleted) {
        delete state.files[ev.path];
        if (models[ev.path]) { models[ev.path].dispose(); delete models[ev.path]; }
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
      renderChanges(ev.list);
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
        chatStream.appendChild(el); scrollChat();
      }
      break;
    }

    case "agent.done": state.round = ev.round; answerBlock = null; thinkCount = 0; lastThink = null; break;
    case "agent.reset": state.round = 0; answerBlock = null; thinkCount = 0; lastThink = null; break;

    case "plan.created": renderPlan(ev.plan); break;
    case "plan.updated": renderPlan(ev.plan); break;

    case "agent.settings": applyAgentSettings(ev.agent); break;
    case "context.usage": updateCtxBar(ev.used, ev.budget); break;
  }
}

/* ---------------- Agent 设置同步 / 上下文预算条 ---------------- */
function applyAgentSettings(a) {
  if (!a) return;
  state.agent = a;
  const sel = inputBox.querySelector("#ciPerm");
  if (sel && a.permissions && a.permissions.mode) sel.value = a.permissions.mode;
}
function updateCtxBar(used, budget) {
  const wrap = inputBox.querySelector("#ctxBarWrap");
  if (!wrap || !budget) return;
  const pct = Math.min(100, Math.round((used / budget) * 100));
  wrap.style.display = "flex";
  const fill = wrap.querySelector("#ctxBarFill");
  fill.style.width = pct + "%";
  fill.className = pct >= 85 ? "warn" : pct >= 60 ? "mid" : "";
  wrap.querySelector("#ctxBarTxt").textContent = "上下文 " + pct + "%（约 " + (used > 1000 ? (used / 1000).toFixed(1) + "k" : used) + " / " + Math.round(budget / 1000) + "k tokens" + (pct >= 85 ? "，即将自动压缩" : "") + "）";
  wrap.title = "上下文用量估算；超过 85% 时自动摘要压缩早期消息";
}

/* ---------------- Agent 状态 ---------------- */
function setRunning(running, label) {
  state.running = running;
  const txt = label || (running ? "AI 运行中" : "AI 空闲");
  const tb = $("tbAgentState");
  tb.className = "agent-state " + (running ? "running" : "idle");
  tb.innerHTML = '<span class="dot"></span>' + esc(txt);
  $("sbAgentTxt").textContent = txt;
  $("agSessMeta").textContent = (running ? "运行中" : "已就绪") + " · " + state.project;
  const live = document.querySelector(".ag-live-dot");
  if (live) live.classList.toggle("running", running);
  const liveTxt = $("agLiveTxt"); if (liveTxt) liveTxt.textContent = txt;
  const btn = inputBox.querySelector("#btnSend");
  if (btn) {
    btn.disabled = running;
    if (running) {
      btn.innerHTML = ico("stop") + "停止";
      btn.classList.add("stop-mode");
      btn.onclick = () => { send({ type: "term.kill" }); send({ type: "newchat" }); };
    } else {
      btn.innerHTML = ico("send") + "发送";
      btn.classList.remove("stop-mode");
      // Agent 空闲时自动处理队列
      if (msgQueue.length > 0) setTimeout(processQueue, 500);
    }
  }
}

/* ---------------- 本地鉴权 ---------------- */
const AUTH = { token: "" };
(function patchFetch() {
  const orig = window.fetch.bind(window);
  window.fetch = (url, opts) => {
    if (AUTH.token && typeof url === "string" && url.startsWith("/api/")) {
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers, { Authorization: "Bearer " + AUTH.token });
    }
    return orig(url, opts);
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
  ws.onclose = () => setTimeout(connect, 1500);
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

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
  send({ type: "chat", text, attachments });
}

function bindInput() {
  const ta = inputBox.querySelector("#chatInput");
  const doSend = () => {
    const v = ta.value.trim();
    if (!v && !pendingAttach.length) return;
    ta.value = "";
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
      send({ type: "chat", text, attachments });
    }
    if (attachments.length) termLine('<span class="tl-info">[附件] 已随消息发送 ' + attachments.length + " 张图片</span>");
  };
  inputBox.querySelector("#btnSend").onclick = doSend;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

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
      send({ type: "term.exec", cmd });
    }
    if (e.key === "c" && e.ctrlKey) send({ type: "term.kill" });
  });
  terminal.querySelector("#termKill").onclick = () => send({ type: "term.kill" });
}

/* ---------------- 会话历史（本地持久化，跨刷新保留） ---------------- */
const CONV_LS = "cw-conv-v1";
const CONV_ACTIVE_LS = "cw-conv-active";
let convId = null;
let convObs = null;

function loadConvList() {
  try { return JSON.parse(localStorage.getItem(CONV_LS)) || []; } catch (e) { return []; }
}
function saveConvList(list) {
  try { localStorage.setItem(CONV_LS, JSON.stringify(list)); } catch (e) {}
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
  localStorage.setItem(CONV_ACTIVE_LS, id);
  const c = loadConvList().find((x) => x.id === id);
  chatStream.innerHTML = c && c.dom ? c.dom : "";
  for (const k in blocks) delete blocks[k];
  answerBlock = null; thinkCount = 0; lastThink = null;
  scrollChat();
  renderConvList();
  replaceIcons();
}

function deleteConv(id) {
  const list = loadConvList().filter((x) => x.id !== id);
  saveConvList(list);
  if (id === convId) {
    if (list.length) openConv(list[0].id);
    else startNewConv(true);
  }
  renderConvList();
}

function startNewConv(announce) {
  convId = genConvId();
  localStorage.setItem(CONV_ACTIVE_LS, convId);
  const list = loadConvList();
  list.unshift({ id: convId, title: "新对话", ts: Date.now(), dom: "" });
  saveConvList(list);
  if (announce) {
    chatStream.innerHTML = "";
    for (const k in blocks) delete blocks[k];
    answerBlock = null; thinkCount = 0; lastThink = null;
    const el = document.createElement("div");
    el.className = "msg msg-ai";
    el.innerHTML = mdLite("已开始 **新对话**。上一轮上下文已清空，随时描述你的下一个任务。");
    chatStream.appendChild(el);
    scrollChat();
  }
  renderConvList();
}

/* 启动时恢复上次会话（历史跨刷新保留） */
function restoreConv() {
  convId = localStorage.getItem(CONV_ACTIVE_LS);
  const list = loadConvList();
  const c = convId && list.find((x) => x.id === convId);
  if (!c) { startNewConv(false); return; }
  chatStream.innerHTML = c.dom || "";
  for (const k in blocks) delete blocks[k];
  answerBlock = null; thinkCount = 0; lastThink = null;
  renderConvList();
  replaceIcons();
  scrollChat();
}

function newConversation() {
  if (state.running) return;
  // 真正的新对话：当前会话已由 observer 持久化；新建本地会话并清空服务端 AI 上下文（保留文件改动）
  startNewConv(true);
  send({ type: "newchat" });
}
$("agNewTask").onclick = newConversation;
$("agExport").onclick = exportConversation;
$("btnReset").onclick = () => {
  if (state.running) return;
  if (confirm("将丢弃全部更改，恢复到 Git/快照基线。未保存的编辑也会丢失，确定？")) {
    state.dirty.clear();
    send({ type: "reset" });
  }
};

/* ---------------- 全局快捷键 ---------------- */
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveActiveFile(); }
});

/* ---------------- 设置面板 ---------------- */
function getModelPresets() { try { return JSON.parse(localStorage.getItem("cw-model-presets")) || []; } catch (e) { return []; } }
function saveModelPresets(presets) { localStorage.setItem("cw-model-presets", JSON.stringify(presets)); }

function renderModelPresets() {
  const presets = getModelPresets();
  const box = $("modelPresets");
  const list = $("modelPresetList");
  list.innerHTML = "";
  const currentURL = $("setBaseURL").value.trim();
  const currentModel = $("setModel").value.trim();
  if (presets.length) {
    presets.forEach((p, i) => {
      const el = document.createElement("div");
      el.className = "model-preset" + (p.baseURL === currentURL && p.model === currentModel ? " active" : "");
      el.innerHTML = '<span style="color:var(--blue)">●</span><span class="model-preset-name">' + esc(p.name) + '</span><span class="model-preset-model">' + esc(p.model) + '</span><span class="model-preset-del" data-i="' + i + '">✕</span>';
      el.onclick = (e) => {
        if (e.target.closest(".model-preset-del")) return;
        $("setBaseURL").value = p.baseURL;
        $("setModel").value = p.model;
        $("setApiKey").placeholder = p.hasKey ? "已保存（留空不修改）" : "sk-…";
        renderModelPresets();
      };
      el.querySelector(".model-preset-del").onclick = (e) => {
        e.stopPropagation();
        presets.splice(i, 1);
        saveModelPresets(presets);
        renderModelPresets();
      };
      list.appendChild(el);
    });
  } else {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:11px;color:var(--text-dim);padding:4px 0";
    empty.textContent = "暂无预设，填写下方配置后点击「保存为预设」";
    list.appendChild(empty);
  }
  // 保存当前配置为预设按钮
  const add = document.createElement("div");
  add.className = "model-preset-add";
  add.textContent = "+ 保存当前配置为预设";
  add.onclick = () => {
    const name = prompt("为这个配置命名：", $("setModel").value.trim() || "我的模型");
    if (!name) return;
    presets.push({ name, baseURL: $("setBaseURL").value.trim(), model: $("setModel").value.trim(), hasKey: !!$("setApiKey").value.trim() || !!($("setApiKey").placeholder.includes("已保存")) });
    saveModelPresets(presets);
    renderModelPresets();
  };
  list.appendChild(add);
}

async function openSettings() {
  const modal = $("settingsModal");
  modal.style.display = "flex";
  $("setStatus").textContent = "";
  try {
    const r = await fetch("/api/settings").then((x) => x.json());
    $("setBaseURL").value = r.baseURL || "";
    $("setModel").value = r.mode === "llm" ? r.model : ($("setModel").value || "");
    $("setApiKey").placeholder = r.hasKey ? "已保存 " + r.keyTail + "（留空表示不修改）" : "sk-…";
    $("setApiKey").value = "";
    renderModelPresets();
  } catch (e) {}
}
$("btnSettings").onclick = openSettings;
$("setClose").onclick = () => ($("settingsModal").style.display = "none");
// 弹窗只点 X 关闭，点击外部不关闭

$("setTest").onclick = async () => {
  const st = $("setStatus");
  st.className = "set-status"; st.textContent = "测试中…";
  try {
    const r = await fetch("/api/settings/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseURL: $("setBaseURL").value.trim(), apiKey: $("setApiKey").value.trim(), model: $("setModel").value.trim() }),
    }).then((x) => x.json());
    if (r.ok) { st.className = "set-status ok"; st.textContent = "连接成功，模型响应: " + (r.sample || "ok"); }
    else { st.className = "set-status err"; st.textContent = "连接失败: " + r.error; }
  } catch (e) { st.className = "set-status err"; st.textContent = "请求异常: " + e.message; }
};

// 拉取模型列表功能
$("setFetchModels").onclick = async () => {
  const st = $("setStatus");
  const baseURL = $("setBaseURL").value.trim();
  if (!baseURL) {
    st.className = "set-status err";
    st.textContent = "请先填写 Base URL";
    return;
  }
  
  st.className = "set-status";
  st.textContent = "正在拉取模型列表…";

  try {
    // 通过服务端代理请求，避免浏览器 CORS 拦截
    const apiKey = $("setApiKey").value.trim();
    let proxyURL = "/api/models?baseURL=" + encodeURIComponent(baseURL);
    if (apiKey) proxyURL += "&apiKey=" + encodeURIComponent(apiKey);

    const response = await fetch(proxyURL);
    const data = await response.json();
    
    if (data.data && Array.isArray(data.data)) {
      // 成功获取模型列表
      const models = data.data.map(m => m.id || m.name).filter(Boolean);
      if (models.length > 0) {
        // 创建模型选择下拉框
        let selectHTML = '<select id="modelSelect" style="margin-top:8px;width:100%;padding:6px;border-radius:4px;border:1px solid var(--border);background:var(--bg);color:var(--text)">';
        models.forEach(model => {
          selectHTML += `<option value="${model}">${model}</option>`;
        });
        selectHTML += '</select>';
        
        // 在模型名输入框后面添加下拉框
        const modelInput = $("setModel");
        const container = modelInput.parentNode;
        const existingSelect = document.getElementById('modelSelect');
        if (existingSelect) existingSelect.remove();
        container.insertAdjacentHTML('beforeend', selectHTML);
        
        // 当选择模型时，更新输入框
        document.getElementById('modelSelect').onchange = (e) => {
          $("setModel").value = e.target.value;
        };
        
        st.className = "set-status ok";
        st.textContent = `成功拉取 ${models.length} 个模型，请选择或手动输入`;
      } else {
        st.className = "set-status err";
        st.textContent = "未找到可用模型";
      }
    } else if (data.error) {
      st.className = "set-status err";
      st.textContent = "拉取失败: " + (data.error.message || data.error);
    } else {
      st.className = "set-status err";
      st.textContent = "返回格式不正确";
    }
  } catch (e) {
    st.className = "set-status err";
    st.textContent = "请求异常: " + e.message;
  }
};

$("setSave").onclick = async () => {
  const st = $("setStatus");
  const body = { baseURL: $("setBaseURL").value.trim(), model: $("setModel").value.trim() };
  const key = $("setApiKey").value.trim();
  if (key) body.apiKey = key;
  try {
    const r = await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.ok) {
      st.className = "set-status ok";
      st.textContent = r.engine.mode === "llm" ? "已切换到真实 LLM 引擎: " + r.engine.model : "已保存（缺少 Key 或 URL，当前为演示引擎）";
      setTimeout(() => ($("settingsModal").style.display = "none"), 900);
    } else { st.className = "set-status err"; st.textContent = "保存失败: " + r.error; }
  } catch (e) { st.className = "set-status err"; st.textContent = "请求异常: " + e.message; }
};

/* ---------------- Agent 设置面板（权限 / 人格 / 规则 / 上下文 / 记忆） ---------------- */
async function openAgentSettings() {
  const modal = $("agentModal");
  modal.style.display = "flex";
  $("agmStatus").textContent = "";
  try {
    const a = await fetch("/api/agent-settings").then((x) => x.json());
    state.agent = a;
    $("agmMode").value = (a.permissions && a.permissions.mode) || "ask";
    $("agmAllow").value = ((a.permissions && a.permissions.allow) || []).join("\n");
    $("agmDeny").value = ((a.permissions && a.permissions.deny) || []).join("\n");
    $("agmPersona").value = (a.persona && a.persona.active) || "default";
    $("agmPrompt").value = (a.persona && a.persona.systemPrompt) || "";
    $("agmRules").checked = !(a.rules && a.rules.enabled === false);
    $("agmMemory").checked = !(a.memory && a.memory.enabled === false);
    $("agmCompact").checked = !(a.context && a.context.autoCompact === false);
    $("agmBudget").value = (a.context && a.context.budgetTokens) || 120000;
    agmSyncPromptVis();
  } catch (e) { $("agmStatus").className = "set-status err"; $("agmStatus").textContent = "读取设置失败: " + e.message; }
}
function agmSyncPromptVis() {
  $("agmPromptRow").style.display = $("agmPersona").value === "custom" ? "block" : "none";
}
$("btnAgentSettings").onclick = openAgentSettings;
$("agmClose").onclick = () => ($("agentModal").style.display = "none");
// Agent 设置弹窗只点 X 关闭
$("agmPersona").addEventListener("change", agmSyncPromptVis);

$("agmSave").onclick = async () => {
  const st = $("agmStatus");
  const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
  const body = {
    permissions: { mode: $("agmMode").value, allow: lines($("agmAllow").value), deny: lines($("agmDeny").value) },
    persona: { active: $("agmPersona").value, systemPrompt: $("agmPrompt").value.trim() },
    rules: { enabled: $("agmRules").checked },
    memory: { enabled: $("agmMemory").checked },
    context: { budgetTokens: parseInt($("agmBudget").value, 10) || 120000, autoCompact: $("agmCompact").checked },
  };
  try {
    const r = await fetch("/api/agent-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.ok) {
      st.className = "set-status ok"; st.textContent = "已保存，对下一条消息立即生效";
      applyAgentSettings(r.agent);
      setTimeout(() => ($("agentModal").style.display = "none"), 800);
    } else { st.className = "set-status err"; st.textContent = "保存失败: " + r.error; }
  } catch (e) { st.className = "set-status err"; st.textContent = "请求异常: " + e.message; }
};

/* ---------------- 工作流模板（目标驱动 /goal 式） ---------------- */
const WORKFLOWS = [
  { icon: "error", name: "修复 Bug", tmpl: "请定位并修复以下 bug：<描述 bug 现象与复现步骤>。\n要求：先复现，再定位根因，修复后运行相关测试验证，最后总结根因与改动。" },
  { icon: "plus", name: "实现新功能", tmpl: "请实现以下功能：<功能描述与目标>。\n要求：先列出计划（涉及的文件 / 接口 / 数据结构），再编码实现，最后自测并说明如何验证。" },
  { icon: "split", name: "重构模块", tmpl: "请重构 <模块 / 文件>：保持对外行为不变，提升可读性 / 性能 / 结构。\n要求：改前先跑测试建立基线，改后跑测试确认无回归，给出前后对比。" },
  { icon: "md", name: "补充文档", tmpl: "请为 <模块 / 目录> 编写或更新文档与关键注释，覆盖设计决策、使用方式、注意事项。" },
  { icon: "check", name: "跑测试 / CI", tmpl: "请运行项目的测试 / 构建 / lint，并修复所有失败项，直到全部通过；每一步说明做了什么。" },
  { icon: "eye", name: "代码审查", tmpl: "请审查 <范围 / 文件 / PR> 的代码质量、潜在 bug、安全风险与可维护性，给出按优先级排序的问题清单与改进建议。" },
];
function renderWorkflows() {
  const box = $("wfList");
  box.innerHTML = "";
  WORKFLOWS.forEach((w) => {
    const it = document.createElement("div");
    it.className = "wf-item";
    it.innerHTML = '<span class="wf-ic">' + ico(w.icon) + '</span><div class="wf-meta"><div class="wf-name">' + w.name + '</div><div class="wf-sub">' + esc(w.tmpl.split("\n")[0].slice(0, 30)) + "</div></div>";
    it.onclick = () => {
      const ta = inputBox.querySelector("#chatInput");
      if (ta) { ta.value = w.tmpl; ta.focus(); }
      $("wfPop").style.display = "none";
    };
    box.appendChild(it);
  });
}
$("btnWorkflow").onclick = (e) => {
  e.stopPropagation();
  const pop = $("wfPop");
  const show = pop.style.display !== "block";
  pop.style.display = show ? "block" : "none";
  if (show) renderWorkflows();
};
$("wfPop").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", (e) => {
  const pop = $("wfPop");
  if (pop.style.display === "block" && !pop.contains(e.target) && e.target !== $("btnWorkflow")) pop.style.display = "none";
});

/* ---------------- 会话沉淀（自我进化 P2：把决策 / 约定固化为长期资产） ---------------- */
async function openSediment() {
  const modal = $("sedimentModal");
  modal.style.display = "flex";
  $("sedStatus").textContent = "";
  $("sedTitle").value = "";
  $("sedContent").value = "";
  const rb = document.querySelector('input[name="sedTarget"][value="rule"]');
  if (rb) rb.checked = true;
  const prev = $("sedPreview");
  prev.textContent = "（加载中…）";
  try {
    const r = await fetch("/api/sediment").then((x) => x.json());
    let out = "";
    if (r.rules && r.rules.length) out += "【项目规则 user-rules.md】\n" + r.rules.map((x) => x.content).join("\n---\n").slice(0, 2500) + "\n\n";
    else out += "（暂无项目规则）\n\n";
    out += "【项目记忆】\n" + (r.memory || "（暂无项目记忆）");
    prev.textContent = out;
  } catch (e) { prev.textContent = "加载失败: " + e.message; }
}
$("btnSediment").onclick = openSediment;
$("sedClose").onclick = () => ($("sedimentModal").style.display = "none");
// 沉淀弹窗只点 X 关闭
$("sedSave").onclick = async () => {
  const st = $("sedStatus");
  const rb = document.querySelector('input[name="sedTarget"]:checked');
  const target = rb ? rb.value : "rule";
  const body = { target, title: $("sedTitle").value.trim(), content: $("sedContent").value.trim() };
  if (!body.content) { st.className = "set-status err"; st.textContent = "请先填写要沉淀的内容"; return; }
  try {
    const r = await fetch("/api/sediment", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.ok) {
      st.className = "set-status ok";
      st.textContent = target === "rule" ? "已沉淀为项目规则，下次对话起强制生效" : "已沉淀为项目记忆，下次对话起作为参考";
      $("sedContent").value = "";
      toast(target === "rule" ? "✅ 已沉淀为项目规则" : "✅ 已沉淀为项目记忆");
      setTimeout(() => ($("sedimentModal").style.display = "none"), 800);
    } else { st.className = "set-status err"; st.textContent = "沉淀失败: " + r.error; }
  } catch (e) { st.className = "set-status err"; st.textContent = "请求异常: " + e.message; }
};

/* ---------------- 打开文件夹（任意本地目录 → 工作区） ---------------- */
const fm = { dir: "" };

async function fmBrowse(dir) {
  const r = await fetch("/api/fs/browse?dir=" + encodeURIComponent(dir || "")).then((x) => x.json());
  fm.dir = r.dir || "";
  fm.parent = r.parent;
  fm.home = r.home;
  $("fmPath").value = fm.dir;
  $("fmCurrent").textContent = fm.dir ? "当前选择: " + fm.dir : "请选择一个文件夹";
  $("fmOpen").disabled = !fm.dir;
  const list = $("fmList");
  list.innerHTML = "";
  if (!r.dirs || !r.dirs.length) {
    list.innerHTML = '<div class="scm-empty">此目录下没有子文件夹（可以直接点「打开此文件夹」）</div>';
    return;
  }
  r.dirs.forEach((d) => {
    const el = document.createElement("div");
    el.className = "fm-item" + (d.hidden ? " fm-hidden" : "");
    el.innerHTML = ico("folder") + "<span>" + esc(d.name) + "</span>";
    el.onclick = () => fmBrowse(d.path);
    el.ondblclick = () => { fm.dir = d.path; fmOpenFolder(); };
    list.appendChild(el);
  });
}

async function fmRenderRecent() {
  try {
    const r = await fetch("/api/workspace").then((x) => x.json());
    const box = $("fmRecent");
    box.innerHTML = "";
    if (!r.recent || !r.recent.length) return;
    const title = document.createElement("div");
    title.className = "fm-recent-title";
    title.textContent = "最近打开";
    box.appendChild(title);
    r.recent.slice(0, 5).forEach((p) => {
      const el = document.createElement("div");
      el.className = "fm-recent-item";
      el.innerHTML = ico("folder") + "<span>" + esc(p) + "</span>";
      el.onclick = () => { fm.dir = p; fmOpenFolder(); };
      box.appendChild(el);
    });
  } catch (e) {}
}

async function fmOpenFolder() {
  const st = $("fmStatus");
  st.className = "set-status"; st.textContent = "正在切换工作区…";
  try {
    const r = await fetch("/api/workspace", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: fm.dir }),
    }).then((x) => x.json());
    if (r.ok) {
      st.className = "set-status ok"; st.textContent = "已打开: " + r.workspace;
      // 清空本地编辑状态，等 hello 广播重建
      state.openTabs = []; state.activeFile = null; state.dirty.clear();
      for (const p in models) { models[p].dispose(); delete models[p]; }
      if (state.monacoReady && editor) editor.setModel(null);
      setTimeout(() => ($("folderModal").style.display = "none"), 500);
      termLine('<span class="tl-info">[pancode] 工作区已切换 → ' + esc(r.workspace) + "</span>");
    } else { st.className = "set-status err"; st.textContent = "打开失败: " + r.error; }
  } catch (e) { st.className = "set-status err"; st.textContent = "请求异常: " + e.message; }
}

$("btnOpenFolder").onclick = () => {
  $("folderModal").style.display = "flex";
  $("fmStatus").textContent = "";
  fmRenderRecent();
  fmBrowse(fm.dir || "");
};
$("fmClose").onclick = () => ($("folderModal").style.display = "none");
// 文件夹弹窗只点 X 关闭
$("fmUp").onclick = () => fmBrowse(fm.parent === "" ? "" : (fm.parent || ""));
$("fmHome").onclick = () => fmBrowse(fm.home || "");
$("fmGo").onclick = () => fmBrowse($("fmPath").value.trim());
$("fmPath").addEventListener("keydown", (e) => { if (e.key === "Enter") fmBrowse($("fmPath").value.trim()); });
$("fmOpen").onclick = fmOpenFolder;

/* ---------------- 欢迎信息 ---------------- */
function welcome() {
  const isLlm = state.engine && state.engine.mode === "llm";
  const el = document.createElement("div");
  el.className = "msg msg-ai";
  el.innerHTML = mdLite(
    "你好，我是 **pancode Agent**。\n\n" +
    (isLlm
      ? "当前引擎：**" + state.engine.model + "**（真实 LLM）。直接描述任何编程任务，我会自主读代码、编辑文件、跑终端验证，直到完成。\n\n"
      : "当前为**内置演示引擎**（无需 API Key 即可体验完整闭环）。点击右上角「模型设置」接入任意 OpenAI 兼容 API 后，我就能处理你的**任意真实编程任务**。\n\n") +
    "**这个工作台是真实的：**\n- 编辑器可直接改代码，`Ctrl+S` 真实保存到磁盘\n- 文件树支持新建 / 重命名 / 删除（右键菜单）\n- 终端真实执行，`Ctrl+C` 可中断\n- 改动基于 Git/快照基线计算，随时可一键还原\n\n" +
    "随时在顶部切换 **Editor / Agents** 双窗口，状态完全同步。");
  chatStream.appendChild(el);
}

/* ---------------- 用户认证 ---------------- */
const userAuth = { token: localStorage.getItem("cw-user-token") || "", username: "" };

async function checkAuth() {
  try {
    const r = await fetch("/api/auth/status?userToken=" + encodeURIComponent(userAuth.token)).then((x) => x.json());
    if (r.loggedIn) {
      userAuth.username = r.username;
      $("tbUserTxt").textContent = r.username;
      $("tbUserBtn").classList.add("logged");
    } else {
      userAuth.token = ""; userAuth.username = "";
      $("tbUserTxt").textContent = "未登录";
      $("tbUserBtn").classList.remove("logged");
    }
  } catch (e) { /* 静默 */ }
}

$("tbUserBtn").onclick = () => { $("authModal").style.display = "flex"; $("authStatus").textContent = ""; };
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
      localStorage.setItem("cw-user-token", r.token);
      $("tbUserTxt").textContent = r.username;
      $("tbUserBtn").classList.add("logged");
      $("authModal").style.display = "none";
      toast(authMode === "login" ? "✅ 登录成功" : "✅ 注册成功");
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

function renderSkillsList() {
  const marketBox = $("skillsList");
  const localBox = $("localSkillsList");
  const countEl = $("skillsCount");

  // 分离来源
  const userSkills = allSkills.filter((s) => s.source === "manual" || s.source === "import");
  const autoSkills = allSkills.filter((s) => s.source === "auto");

  if (countEl) countEl.textContent = (userSkills.length + autoSkills.length + builtinSkills.length) + " 个 Skill";

  // 市场 Skills（用户创建/导入）
  if (marketBox) {
    marketBox.innerHTML = "";
    // 内置 Workflow
    if (builtinSkills.length) {
      const wfTitle = document.createElement("div");
      wfTitle.className = "side-section-head";
      wfTitle.innerHTML = '<span style="font-size:11px;color:var(--text-dim)">内置工作流</span>';
      marketBox.appendChild(wfTitle);
      builtinSkills.forEach((s) => { marketBox.appendChild(makeSkillEl(s, "workflow")); });
    }
    // 用户创建
    if (userSkills.length) {
      const uTitle = document.createElement("div");
      uTitle.className = "side-section-head";
      uTitle.innerHTML = '<span style="font-size:11px;color:var(--text-dim)">用户创建</span>';
      marketBox.appendChild(uTitle);
      userSkills.forEach((s) => { marketBox.appendChild(makeSkillEl(s, "market")); });
    }
    if (!builtinSkills.length && !userSkills.length) {
      marketBox.innerHTML = '<div class="scm-empty">暂无 Skills。点击 + 创建或导入。</div>';
    }
  }

  // 工作区 Skills（Agent 沉淀）
  if (localBox) {
    localBox.innerHTML = "";
    if (!autoSkills.length) {
      localBox.innerHTML = '<div class="scm-empty">Agent 自动沉淀的 Skill 会出现在这里。</div>';
    } else {
      autoSkills.forEach((s) => { localBox.appendChild(makeSkillEl(s, "local")); });
    }
  }
  replaceIcons();
}

const CAT_COLORS = { frontend: "#4fc1ff", backend: "#4ec9b0", devops: "#c586c0", test: "#dcdcaa", refactor: "#ce9178", security: "#f48771", perf: "#cca700", debug: "#d16969", config: "#8a8a8a", workflow: "#0e639c", other: "#808080" };

function makeSkillEl(s, sourceType) {
  const el = document.createElement("div");
  el.className = "skill-item";
  const catColor = CAT_COLORS[s.category] || "#808080";
  const isBuiltin = s.source === "workflow";
  const isAuto = s.source === "auto";
  const srcTag = isBuiltin ? ' <span style="font-size:9px;color:var(--text-dim)">内置</span>' : (isAuto ? ' <span style="font-size:9px;color:var(--ok)">沉淀</span>' : '');
  el.innerHTML =
    '<div class="skill-ic" style="background:' + catColor + '">' + esc((s.name || "S")[0]) + '</div>' +
    '<div class="skill-meta"><div class="skill-name">' + esc(s.name) + srcTag + '</div>' +
    '<div class="skill-desc">' + esc(s.description || "无描述") + '</div></div>' +
    '<span class="skill-use">引用 ' + (s.useCount || 0) + '</span>' +
    '<div class="skill-actions">' +
    '<button class="skill-view" title="查看详情">查看</button>' +
    '<button class="skill-ref" title="引用到对话">引用</button>' +
    (sourceType !== "workflow" ? '<button class="danger" title="删除">删</button>' : '') + '</div>';
  el.querySelector(".skill-view").onclick = (e) => { e.stopPropagation(); showSkillDetail(s); };
  el.querySelector(".skill-ref").onclick = (e) => { e.stopPropagation(); insertSkillToChat(s); };
  const delBtn = el.querySelector(".danger");
  if (delBtn) delBtn.onclick = (e) => { e.stopPropagation(); deleteSkill(s.id); };
  return el;
}

/* Skill 详情弹窗 */
function showSkillDetail(skill) {
  let modal = $("skillDetailModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "skillDetailModal";
    modal.style.cssText = "position:fixed;inset:0;background:#000000aa;z-index:60;display:none;align-items:center;justify-content:center";
    modal.innerHTML = '<div class="set-box" style="max-width:560px;max-height:80vh;display:flex;flex-direction:column">' +
      '<div class="set-head"><span id="skillDetailTitle"></span><button id="skillDetailClose"><i data-ico="close"></i></button></div>' +
      '<div class="set-body" id="skillDetailBody" style="overflow-y:auto"></div>' +
      '</div>';
    document.body.appendChild(modal);
    $("skillDetailClose").onclick = () => { modal.style.display = "none"; };
  // Skill 详情弹窗只点 X 关闭
  }
  $("skillDetailTitle").innerHTML = '<i data-ico="sparkle"></i> ' + esc(skill.name);
  const catColor = CAT_COLORS[skill.category] || "#808080";
  let body = "";
  body += "<label style=\"display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px\">名称</label><input id=\"sdName\" type=\"text\" value=\"" + esc(skill.name) + "\" style=\"width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px;margin-bottom:8px\">";
  body += "<label style=\"display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px\">描述</label><input id=\"sdDesc\" type=\"text\" value=\"" + esc(skill.description || "") + "\" style=\"width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px;margin-bottom:8px\">";
  body += "<div style=\"display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px\">";
  body += "<span style=\"font-size:10px;padding:2px 8px;border-radius:8px;background:" + catColor + "22;color:" + catColor + ";border:1px solid " + catColor + "44\">" + esc(skill.category || "other") + "</span>";
  if (skill.tags && skill.tags.length) skill.tags.forEach((t) => { body += "<span style=\"font-size:10px;padding:2px 6px;border-radius:8px;background:var(--bg4);color:var(--text-dim)\">" + esc(t) + "</span>"; });
  body += "<span style=\"font-size:10px;padding:2px 6px;border-radius:8px;background:var(--bg4);color:var(--text-dim)\">引用 " + (skill.useCount || 0) + " 次</span>";
  body += "</div>";
  body += "<label style=\"display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px\">触发关键词</label><input id=\"sdTrigger\" type=\"text\" value=\"" + esc(skill.trigger || "") + "\" style=\"width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px;margin-bottom:8px\">";
  body += "<label style=\"display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px\">内容（Markdown）</label>";
  body += "<textarea id=\"sdBody\" rows=\"10\" style=\"width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text);font-size:12px;line-height:1.6;font-family:var(--mono);resize:vertical;outline:none\">" + esc(skill.body || "") + "</textarea>";
  body += "<div style=\"display:flex;gap:8px;margin-top:12px;justify-content:flex-end\">";
  body += "<button id=\"skillDetailSave\" class=\"set-btn\" style=\"background:var(--ok);color:#000\">保存修改</button>";
  body += "<button id=\"skillDetailRef\" class=\"set-btn\" style=\"background:var(--accent);color:#fff\">引用到对话</button>";
  body += "</div>";
  $("skillDetailBody").innerHTML = body;
  replaceIcons(modal);
  $("skillDetailRef").onclick = () => { modal.style.display = "none"; insertSkillToChat(skill); };
  $("skillDetailSave").onclick = async () => {
    const patch = {
      name: $("sdName").value.trim(),
      description: $("sdDesc").value.trim(),
      trigger: $("sdTrigger").value.trim(),
      body: $("sdBody").value.trim(),
      category: skill.category || "other",
    };
    try {
      let r;
      if (skill.id) {
        // 已有 Skill -> 更新
        r = await fetch("/api/skills/market/" + skill.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then((x) => x.json());
      } else {
        // 内置 Workflow 没有 id -> 创建为新 Skill
        r = await fetch("/api/skills/market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then((x) => x.json());
      }
      if (r.ok) { toast("Skill 已保存"); modal.style.display = "none"; loadSkills(); }
      else toast("保存失败: " + r.error);
    } catch (e) { toast("请求异常: " + e.message); }
  };
  modal.style.display = "flex";
}

function insertSkillToChat(skill) {
  // 设置 activeSkill，发送时自动注入
  activeSkill = skill;
  const tag = inputBox.querySelector("#ciSkillActive");
  if (tag) {
    tag.style.display = "inline-flex";
    tag.innerHTML = '<i data-ico="sparkle"></i>' + esc(skill.name) + '<span class="ci-skill-x">×</span>';
    replaceIcons(tag);
    tag.querySelector(".ci-skill-x").onclick = () => { activeSkill = null; tag.style.display = "none"; };
  }
  // 关闭弹出框
  const pop = inputBox.querySelector("#ciSkillPop");
  if (pop) pop.style.display = "none";
  toast("✅ 已选中 Skill: " + skill.name + "（发送时自动引用）");
  fetch("/api/skills/market/" + skill.id + "/use", { method: "POST" }).catch(() => {});
}

/* Skill 选择器弹出列表 */
function renderSkillPop() {
  const pop = inputBox.querySelector("#ciSkillPop");
  if (!pop) return;
  const all = [...builtinSkills, ...allSkills];
  if (!all.length) { pop.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:12px">暂无可用 Skill</div>'; return; }
  const CAT_COLORS = { frontend: "#4fc1ff", backend: "#4ec9b0", devops: "#c586c0", test: "#dcdcaa", refactor: "#ce9178", security: "#f48771", perf: "#cca700", debug: "#d16969", config: "#8a8a8a", workflow: "#0e639c", other: "#808080" };
  pop.innerHTML = "";
  all.forEach((s) => {
    const el = document.createElement("div");
    el.className = "ci-skill-opt";
    const catColor = CAT_COLORS[s.category] || "#808080";
    const srcLabel = s.source === "workflow" ? "内置" : (s.source === "auto" ? "沉淀" : "用户");
    el.innerHTML =
      '<span class="ci-skill-opt-cat" style="background:' + catColor + '">' + esc(s.category || "other") + '</span>' +
      '<span class="ci-skill-opt-name">' + esc(s.name) + '</span>' +
      '<span class="ci-skill-opt-src">' + srcLabel + '</span>';
    el.onclick = () => insertSkillToChat(s);
    pop.appendChild(el);
  });
}

async function deleteSkill(id) {
  if (!confirm("确定删除此 Skill？")) return;
  try {
    await fetch("/api/skills/market/" + id, { method: "DELETE" });
    toast("已删除");
    loadSkills();
  } catch (e) {}
}

// 新建 Skill 弹窗
$("btnNewSkill").onclick = () => { $("skillModal").style.display = "flex"; $("skillStatus").textContent = ""; $("skillName").value = ""; $("skillDesc").value = ""; $("skillTrigger").value = ""; $("skillBody").value = ""; };
$("skillClose").onclick = () => ($("skillModal").style.display = "none");
// Skill 创建弹窗只点 X 关闭

$("skillSave").onclick = async () => {
  const body = {
    name: $("skillName").value.trim(),
    description: $("skillDesc").value.trim(),
    category: $("skillCategory").value,
    trigger: $("skillTrigger").value.trim(),
    body: $("skillBody").value.trim(),
  };
  if (!body.name || !body.body) { $("skillStatus").className = "set-status err"; $("skillStatus").textContent = "名称和内容不能为空"; return; }
  try {
    const r = await fetch("/api/skills/market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.ok) {
      $("skillStatus").className = "set-status ok";
      $("skillStatus").textContent = "✅ 已保存到 Skills 市场";
      toast("✅ Skill 已创建");
      loadSkills();
      setTimeout(() => ($("skillModal").style.display = "none"), 800);
    } else { $("skillStatus").className = "set-status err"; $("skillStatus").textContent = r.error; }
  } catch (e) { $("skillStatus").className = "set-status err"; $("skillStatus").textContent = "请求异常: " + e.message; }
};

// 导入 Skill JSON
$("btnImportSkill").onclick = () => {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = ".json";
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    try {
      const text = await file.text();
      const skill = JSON.parse(text);
      const r = await fetch("/api/skills/market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(skill) }).then((x) => x.json());
      if (r.ok) { toast("✅ 导入成功: " + skill.name); loadSkills(); }
      else toast("❌ 导入失败: " + r.error);
    } catch (e) { toast("❌ JSON 格式错误"); }
  };
  inp.click();
};

// 切换到 Skills 面板时加载
function onSkillsViewActive() {
  loadSkills();
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
}

async function loadPlan() {
  try {
    const r = await fetch("/api/plans").then((x) => x.json());
    if (r.active) renderPlan(r.active);
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

/* ---------------- 启动 ---------------- */
applyTheme(getTheme());
$("hpClose").onclick = () => togglePreview(false);
$("hpRefresh").onclick = () => renderPreview();
initResizers();
replaceIcons();
mountShared();
restoreConv();
initConvObserver();
bindInput();
checkAuth();
bootstrap().finally(() => { loadSkills(); loadPlan(); connect(); });
bootMonaco();
