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

/* 滚动条只在滚动时/hover 时显示：监听全局 scroll 事件，给滚动元素加 is-scrolling class，停止后移除 */
(function () {
  const timers = new WeakMap();
  document.addEventListener("scroll", (e) => {
    const el = e.target;
    if (!el || !el.classList) return;
    el.classList.add("is-scrolling");
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => el.classList.remove("is-scrolling"), 600));
  }, true);
})();

const state = {
  mode: "editor",
  files: {},            // { path: {content, original, isNew, lang} }
  openTabs: [],
  activeFile: null,
  dirty: new Set(),     // 有未保存编辑的文件
  running: false,
  convRunning: {},       // 多会话并行：convId -> boolean（该会话是否正在运行）
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


/* ---------------- 共享组件（双窗口间搬运） ---------------- */
const chatStream = document.createElement("div");
chatStream.id = "chatStream";

/* ---------------- 多会话并行：每会话独立 DOM pane ----------------
   convPanes[convId]  = 该会话的 .conv-pane 容器；活跃 pane 挂在 chatStream 下，
   后台会话 pane 处于 detached 状态但保留 DOM 引用，流式输出照常写入。
   切换会话 = mountPane（move DOM），不再 innerHTML 快照恢复。 */
const convPanes = {};       // convId -> pane 元素
const convBlocks = {};      // convId -> blocks 映射（think/msg/tool DOM 引用）
const convMeta = {};        // convId -> { answerBlock, thinkCount, lastThink }
const convPersistTimers = {}; // convId -> 后台会话节流持久化定时器

function ensureConvCtx(id) {
  const cvid = id || convId || "default";
  if (!convPanes[cvid]) {
    const pane = document.createElement("div");
    pane.className = "conv-pane";
    pane.dataset.convId = cvid;
    convPanes[cvid] = pane;
  }
  if (!convBlocks[cvid]) convBlocks[cvid] = {};
  if (!convMeta[cvid]) convMeta[cvid] = { answerBlock: null, thinkCount: 0, lastThink: null };
  return { pane: convPanes[cvid], blocks: convBlocks[cvid], meta: convMeta[cvid] };
}

let _boundConvId = null;    // withConv 期间的消息目标会话
function chatPane() { return (convPanes[_boundConvId || convId]) || chatStream; }

/* 在指定会话上下文中执行 fn：动态绑定 blocks/answerBlock/thinkCount/lastThink，
   聊天 DOM 写入该会话的 pane；结束后回写 meta 并恢复原上下文 */
function withConv(cvid, fn) {
  const id = cvid || convId;
  const ctx = ensureConvCtx(id);
  const prevBound = _boundConvId;
  const prevBlocks = blocks, prevAB = answerBlock, prevTC = thinkCount, prevLT = lastThink;
  _boundConvId = id;
  blocks = ctx.blocks; answerBlock = ctx.meta.answerBlock; thinkCount = ctx.meta.thinkCount; lastThink = ctx.meta.lastThink;
  try {
    fn(ctx.pane);
  } finally {
    ctx.meta.answerBlock = answerBlock; ctx.meta.thinkCount = thinkCount; ctx.meta.lastThink = lastThink;
    _boundConvId = prevBound;
    blocks = prevBlocks; answerBlock = prevAB; thinkCount = prevTC; lastThink = prevLT;
    if (id !== convId) scheduleConvPersist(id);
  }
}

/* 把指定会话的 pane 挂载进 chatStream（卸下其他 pane）；返回 pane */
function mountPane(id) {
  const ctx = ensureConvCtx(id);
  for (const child of Array.from(chatStream.children)) {
    if (child !== ctx.pane && child.classList && child.classList.contains("conv-pane")) chatStream.removeChild(child);
  }
  if (ctx.pane.parentNode !== chatStream) chatStream.appendChild(ctx.pane);
  return ctx.pane;
}

/* 从 localStorage 快照重建 pane（页面刷新后首次打开该会话时调用） */
function hydratePane(id, html) {
  const ctx = ensureConvCtx(id);
  if (!ctx.pane.childNodes.length && html) ctx.pane.innerHTML = html;
  return ctx.pane;
}

/* 后台会话节流持久化：写消息后 800ms 内保存一次 pane 内容 */
function scheduleConvPersist(id) {
  clearTimeout(convPersistTimers[id]);
  convPersistTimers[id] = setTimeout(() => {
    delete convPersistTimers[id];
    persistConv(id);
  }, 800);
}

const msgNavRail = document.createElement("div");
msgNavRail.id = "msgNavRail";


const inputBox = document.createElement("div");
inputBox.id = "chatInputBox";
inputBox.innerHTML =

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
  '<div id="ctxBarWrap" title="上下文用量" style="display:none">' +
    '<span id="ctxPct">0%</span>' +
  '</div>' +
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
    $("chatSlotEditor").appendChild(msgNavRail);
    $("chatInputEditor").appendChild(inputBox);
    $("terminalSlotEditor").appendChild(terminal);
  } else {
    $("chatSlotAgents").appendChild(chatStream);
    $("chatSlotAgents").appendChild(msgNavRail);
    $("chatInputAgents").appendChild(inputBox);
    $("terminalSlotAgents").appendChild(terminal);
  }
  chatStream.scrollTop = chatStream.scrollHeight;
  buildMsgNav();
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
        { key: "aiExplain", ic: "sparkle", label: "AI 解释此文件", fn: () => aiFileAction(path, "请阅读并解释 @file:" + path + "，说明其功能、关键逻辑和设计思路。") },
        { key: "aiFix", ic: "sparkle", label: "AI 修复错误", fn: () => aiFileAction(path, "请检查并修复 @file:" + path + " 中的错误和问题。先运行测试确认问题，修复后再验证。") },
        { key: "aiTest", ic: "sparkle", label: "AI 生成测试", fn: () => aiFileAction(path, "请为 @file:" + path + " 生成单元测试，覆盖主要功能和边界情况。先查看项目中已有的测试风格并保持一致。") },
        { key: "aiRefactor", ic: "sparkle", label: "AI 重构", fn: () => aiFileAction(path, "请重构 @file:" + path + "，改善代码结构、可读性和可维护性，但不改变功能。改完跑测试验证。") },
        { key: "aiReview", ic: "sparkle", label: "AI 审查代码", fn: () => aiFileAction(path, "请对 @file:" + path + " 进行代码审查，指出潜在问题、改进建议和最佳实践。") },
        { key: "delete", ic: "trash", danger: true, fn: () => { if (confirm(t("deleteConfirm") + " " + path + "？")) send({ type: "file.delete", path }); } },
      ];
  menu.innerHTML = "";
  items.forEach((it) => {
    const d = document.createElement("div");
    d.className = "ctx-item" + (it.danger ? " danger" : "");
    d.innerHTML = ico(it.ic) + esc(it.label || t(it.key));
    d.onclick = () => { hideCtxMenu(); it.fn(); };
    menu.appendChild(d);
  });
  menu.style.display = "block";
  menu.style.left = Math.min(e.clientX, window.innerWidth - 200) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - items.length * 34 - 12) + "px";
}
function aiFileAction(path, text) {
  openFile(path);
  switchMode("agents");
  // 多会话并行：直接发送
  lastUserText = text; send({ type: "chat", text, attachments: [], convId });
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
    document.dispatchEvent(new Event("monaco-ready"));
    /* Bio-luminal 配套 Monaco 主题：编辑器融入深渊/晨光视觉，diff 修前修后行背景显式加强 */
    monaco.editor.defineTheme("pancode-dark", {
      base: "vs-dark", inherit: true, rules: [],
      colors: {
        "editor.background": "#0a0e13",
        "editorGutter.background": "#0a0e13",
        "minimap.background": "#0a0e13",
        "editor.lineHighlightBackground": "#131b24",
        "editorLineNumber.foreground": "#3d5265",
        "editorLineNumber.activeForeground": "#7ea3b8",
        "diffEditor.insertedLineBackground": "#1d45319e",
        "diffEditor.removedLineBackground": "#4c1d2b9e",
        "diffEditor.insertedTextBackground": "#2dd4a72e",
        "diffEditor.removedTextBackground": "#fb71852e",
        "diffEditor.insertedTextBorder": "#2dd4a740",
        "diffEditor.removedTextBorder": "#fb718540",
        "diffEditor.border": "#2e4457",
      },
    });
    monaco.editor.defineTheme("pancode-light", {
      base: "vs", inherit: true, rules: [],
      colors: {
        "editor.background": "#fafdfb",
        "editorGutter.background": "#fafdfb",
        "minimap.background": "#fafdfb",
        "diffEditor.insertedLineBackground": "#b9ecd48c",
        "diffEditor.removedLineBackground": "#ffd3da8c",
        "diffEditor.insertedTextBackground": "#0f9d5829",
        "diffEditor.removedTextBackground": "#dc262629",
        "diffEditor.insertedTextBorder": "#0f9d5840",
        "diffEditor.removedTextBorder": "#dc262640",
        "diffEditor.border": "#bcd2c7",
      },
    });
    const monacoTheme = () => (getTheme() === "light" ? "pancode-light" : "pancode-dark");

    /* ---- 内联 Tab 补全 ---- */
    function initInlineComplete(monaco, editor) {
      const LANGS = ["javascript", "typescript", "python", "go", "rust", "java", "html", "css", "json", "markdown", "yaml", "xml", "shell", "c", "cpp"];
      let lastReq = 0;
      const provider = {
        provideInlineCompletions: async function (model, position, ctx, token) {
          const now = Date.now();
          if (now - lastReq < 400) return { items: [] };
          lastReq = now;
          const lang = model.getLanguageId ? model.getLanguageId() : "plaintext";
          const lineContent = model.getLineContent(position.lineNumber);
          const charBefore = lineContent[position.column - 2];
          if (charBefore && !/[\w.\(\[\{<\/\-:"']/.test(charBefore)) return { items: [] };
          const prefix = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
          const suffix = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: model.getLineCount(), endColumn: model.getLineMaxColumn(model.getLineCount()) });
          if (prefix.trim().length < 3) return { items: [] };
          const uri = model.uri ? model.uri.toString() : "";
          const filePath = uri.replace("inmemory:///", "");
          try {
            const r = await fetch("/api/complete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prefix, suffix, language: lang, filePath }),
              signal: AbortSignal.timeout(7000),
            });
            if (token.isCancellationRequested) return { items: [] };
            const data = await r.json();
            if (!data || !data.ok || !data.text) return { items: [] };
            return { items: [{ text: data.text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), filterText: data.text }] };
          } catch (e) { return { items: [] }; }
        },
        freeInlineCompletions: function () {},
      };
      LANGS.forEach(function (lang) { try { monaco.languages.registerInlineCompletionsProvider(lang, provider); } catch (e) {} });
    }

    /* Cmd+K 内联编辑：选中文本 → 输入指令 → AI 返回修改 → 预览 → Accept/Reject */
    function initInlineEdit(monaco, editor) {
      let box = null;
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
        const sel = editor.getSelection();
        if (!sel || sel.isEmpty()) return;
        const model = editor.getModel();
        if (!model) return;
        const selectedText = model.getValueInRange(sel);
        const fullText = model.getValue();
        const beforeText = fullText.slice(0, model.getOffsetAt(sel.getStartPosition()));
        const afterText = fullText.slice(model.getOffsetAt(sel.getEndPosition()));
        const uri = model.uri ? model.uri.toString() : "";
        const filePath = uri.replace("inmemory:///", "");
        const lang = model.getLanguageId ? model.getLanguageId() : "plaintext";
        showBox(sel, selectedText, beforeText, afterText, filePath, lang);
      });
      function showBox(sel, selectedText, beforeText, afterText, filePath, lang) {
        if (box) { box.remove(); box = null; }
        box = document.createElement("div");
        box.id = "inlineEditBox";
        box.innerHTML =
          '<div class="ie-header"><span class="ie-title">AI 编辑</span><span class="ie-close">×</span></div>' +
          '<input class="ie-input" placeholder="描述你想要的修改…（Enter 执行，Esc 取消）" />' +
          '<div class="ie-actions"><button class="ie-btn ie-accept" disabled>接受</button><button class="ie-btn ie-reject">拒绝</button></div>' +
          '<pre class="ie-preview" style="display:none;"></pre>';
        document.body.appendChild(box);
        const selTop = editor.getTopForLineNumber(sel.startLineNumber) - editor.getScrollTop();
        const domRect = editor.getDomNode().getBoundingClientRect();
        box.style.left = (domRect.left + 24) + "px";
        box.style.top = (domRect.top + selTop + 24) + "px";
        const input = box.querySelector(".ie-input");
        const acceptBtn = box.querySelector(".ie-accept");
        const rejectBtn = box.querySelector(".ie-reject");
        const closeBtn = box.querySelector(".ie-close");
        const preview = box.querySelector(".ie-preview");
        const title = box.querySelector(".ie-title");
        input.focus();
        let modifiedText = null;
        async function runEdit() {
          const instruction = input.value.trim();
          if (!instruction) return;
          input.disabled = true;
          title.textContent = "AI 编辑中…";
          try {
            const r = await fetch("/api/edit", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filePath, language: lang, selectedText, instruction, beforeContext: beforeText, afterContext: afterText }),
              signal: AbortSignal.timeout(35000),
            });
            const data = await r.json();
            if (!data || !data.ok || !data.text) { title.textContent = data && data.error ? data.error : "AI 返回为空"; input.disabled = false; return; }
            modifiedText = data.text;
            preview.style.display = "block";
            preview.textContent = modifiedText;
            acceptBtn.disabled = false;
            title.textContent = "AI 编辑（预览）";
            input.disabled = false;
          } catch (e) { title.textContent = "失败：" + e.message.slice(0, 40); input.disabled = false; }
        }
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); runEdit(); }
          if (e.key === "Escape") { closeBox(); }
        });
        acceptBtn.addEventListener("click", () => {
          if (!modifiedText) return;
          editor.executeEdits("inline-edit", [{ range: sel, text: modifiedText }]);
          closeBox();
        });
        rejectBtn.addEventListener("click", closeBox);
        closeBtn.addEventListener("click", closeBox);
        function closeBox() { if (box) { box.remove(); box = null; } editor.focus(); }
      }
    }

    editor = monaco.editor.create($("monacoHost"), {
      theme: monacoTheme(),
      automaticLayout: true,
      minimap: { enabled: true, renderCharacters: true },
      fontSize: (typeof getEditorFontSize === "function" ? getEditorFontSize() : 13.5),
      fontFamily: "Cascadia Code, JetBrains Mono, Consolas, monospace",
      smoothScrolling: true,
      cursorBlinking: "smooth",
      renderLineHighlight: "all",
      scrollBeyondLastLine: false,
      padding: { top: 8 },
      inlineSuggest: { enabled: true },
    });
    editor.onDidChangeCursorPosition((e) => {
      $("sbCursor").textContent = "行 " + e.position.lineNumber + ", 列 " + e.position.column;
    });
    /* Ctrl+S 真实保存到服务端 */
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActiveFile);
    /* 用户编辑文件时清除 Agent diff 高亮 */
    editor.onDidChangeModelContent(function() {
      if (state.diffDecos) { state.diffDecos = editor.deltaDecorations(state.diffDecos, []); }
    });

    /* 内联 Tab 补全：注册 InlineCompletionsProvider */
    initInlineComplete(monaco, editor);
    /* Cmd+K 内联编辑 */
    initInlineEdit(monaco, editor);
    if (state.booted && !state.openTabs.length) {
      const names = Object.keys(state.files);
      const first = names.find((p) => /^readme\.md$/i.test(p)) || names[0];
      if (first) openFile(first);
    }
  }, () => {
    $("monacoHost").innerHTML = '<div id="monacoFallback">Monaco 编辑器加载失败（请刷新；若仍失败请检查 /vendor/monaco 资源是否完整）<br>对话 / 终端 / Agent 功能不受影响。</div>';
  });
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

function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("cw-theme", t);
  const btn = $("btnTheme");
  if (btn) btn.innerHTML = ico(t === "light" ? "moon" : "sun");
  if (state.monacoReady && editor) editor.updateOptions({ theme: t === "light" ? "pancode-light" : "pancode-dark" });
  if (diffEditor) diffEditor.updateOptions({ theme: t === "light" ? "pancode-light" : "pancode-dark" });
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
/* commit 域已抽出到 js/commit.js */

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

/* 重写 HTML 中的相对资源路径为 /api/raw?path= 绝对端点，使预览能加载关联 CSS/JS/图片 */
function rewriteResourcePaths(html, filePath) {
  const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/") + 1) : "";
  const resolve = (ref) => {
    if (!ref || /^(https?:|\/\/|data:|blob:|mailto:|#)/i.test(ref)) return ref; // 绝对/外链/锚点不改
    let rel;
    if (ref.startsWith("/")) rel = ref.slice(1);
    else if (ref.startsWith("./")) rel = dir + ref.slice(2);
    else rel = dir + ref;
    return "/api/raw?path=" + encodeURIComponent(rel);
  };
  // <link href="...">
  html = html.replace(/(<link[^>]*\shref=["'])([^"']*)(["'])/gi, (m, pre, ref, post) => pre + resolve(ref) + post);
  // <script src="...">
  html = html.replace(/(<script[^>]*\ssrc=["'])([^"']*)(["'])/gi, (m, pre, ref, post) => pre + resolve(ref) + post);
  // <img src="...">
  html = html.replace(/(<img[^>]*\ssrc=["'])([^"']*)(["'])/gi, (m, pre, ref, post) => pre + resolve(ref) + post);
  // <source src="..."> (video/audio/picture)
  html = html.replace(/(<source[^>]*\ssrc=["'])([^"']*)(["'])/gi, (m, pre, ref, post) => pre + resolve(ref) + post);
  // url("...") in <style>
  html = html.replace(/url\(["']?([^"')]+)["']?\)/gi, (m, ref) => "url(" + resolve(ref) + ")");
  return html;
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
    const rewritten = rewriteResourcePaths(val, path);
    frame.srcdoc = injectPreviewBridge(rewritten);
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
      if (state.diffDecos) { state.diffDecos = editor.deltaDecorations(state.diffDecos, []); }
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
  if (ev) ev.stopPropagation();
  if (state.dirty.has(path)) {
    showConfirm("关闭标签", path + " 有未保存的更改，关闭将丢弃编辑，确定？", () => _doCloseTab(path));
    return;
  }
  _doCloseTab(path);
}
function _doCloseTab(path) {
  if (state.dirty.has(path) && models[path] && state.files[path]) {
    models[path].setValue(state.files[path].content);
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
  state.openTabs.forEach((path, idx) => {
    const t = document.createElement("div");
    t.className = "tab" + (path === state.activeFile ? " active" : "");
    t.draggable = true;
    t.dataset.idx = idx;
    t.innerHTML = fileIco(path) + "<span>" + esc(path.split("/").pop()) + "</span>" +
      (state.dirty.has(path) ? '<span class="tab-dot" title="未保存 (Ctrl+S 保存)">●</span>' : "") +
      '<span class="tab-close">' + ico("close") + "</span>";
    t.onclick = () => openFile(path);
    t.querySelector(".tab-close").onclick = (e) => closeTab(path, e);
    t.addEventListener("dragstart", (e) => { dragTabIdx = idx; e.dataTransfer.effectAllowed = "move"; t.classList.add("dragging"); });
    t.addEventListener("dragend", () => { t.classList.remove("dragging"); bar.querySelectorAll(".tab").forEach(x => x.classList.remove("drag-over")); });
    t.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    t.addEventListener("dragenter", (e) => { e.preventDefault(); if (idx !== dragTabIdx) t.classList.add("drag-over"); });
    t.addEventListener("dragleave", () => t.classList.remove("drag-over"));
    t.addEventListener("drop", (e) => {
      e.preventDefault();
      t.classList.remove("drag-over");
      if (dragTabIdx === null || dragTabIdx === idx) return;
      const moved = state.openTabs.splice(dragTabIdx, 1)[0];
      state.openTabs.splice(idx, 0, moved);
      dragTabIdx = null;
      renderTabs();
    });
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

/* ---------------- #agRight 右侧栏三面板拖拽调高 ---------------- */
function initAgRightResizers() {
  const agRight = $("agRight");
  if (!agRight) return;
  const termSlot = $("terminalSlotAgents");
  const changed = $("agChangedPanel");
  const r1 = $("agResize1"), r2 = $("agResize2");
  const termH = parseInt(localStorage.getItem("ag-term-h"));
  if (termSlot && termH) termSlot.style.height = termH + "px";
  const changedH = parseInt(localStorage.getItem("ag-changed-h"));
  if (changed && changedH) changed.style.flex = "0 0 " + changedH + "px";

  if (r1 && termSlot) {
    let sy = null;
    r1.addEventListener("mousedown", (e) => { sy = e.clientY; r1.classList.add("dragging"); document.body.style.cursor = "row-resize"; e.preventDefault(); });
    window.addEventListener("mousemove", (e) => {
      if (sy === null) return;
      let h = termSlot.offsetHeight + (e.clientY - sy);
      h = Math.max(80, Math.min(560, h));
      termSlot.style.height = h + "px"; sy = e.clientY;
    });
    window.addEventListener("mouseup", () => {
      if (sy === null) return; sy = null; r1.classList.remove("dragging"); document.body.style.cursor = "";
      localStorage.setItem("ag-term-h", termSlot.offsetHeight);
    });
  }
  if (r2 && changed) {
    let sy = null;
    r2.addEventListener("mousedown", (e) => {
      if (!changed.style.flex) changed.style.flex = "0 0 " + changed.offsetHeight + "px";
      sy = e.clientY; r2.classList.add("dragging"); document.body.style.cursor = "row-resize"; e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (sy === null) return;
      let h = changed.offsetHeight + (e.clientY - sy);
      h = Math.max(80, Math.min(window.innerHeight * 0.7, h));
      changed.style.flex = "0 0 " + h + "px"; sy = e.clientY;
    });
    window.addEventListener("mouseup", () => {
      if (sy === null) return; sy = null; r2.classList.remove("dragging"); document.body.style.cursor = "";
      localStorage.setItem("ag-changed-h", changed.offsetHeight);
    });
  }
}

/* ---------------- 活动栏 ---------------- */
document.querySelectorAll(".ab-btn").forEach((btn) => {
  if (!btn.dataset.view) return;  // 跳过无 data-view 的按钮（如全局设置齿轮）
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
    theme: getTheme() === "light" ? "pancode-light" : "pancode-dark", readOnly: true, automaticLayout: true, fontSize: 13,
    renderSideBySide: true, minimap: { enabled: false },
    ignoreTrimWhitespace: false, renderIndicators: true,
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

/* patch-review 域已抽出到 js/patch-review.js */

/* ---------------- 终端渲染（多标签页） ----------------
   每个标签是独立的输出缓冲（与聊天会话解耦，可随意开多个终端）。
   标签状态在服务端内存中常驻：刷新后由 hello 的 tabs 还原；关闭/新建标签同步到服务端。
   lines 数组统一存放每条输出的「完整 div.tl 外层 HTML」，保证 class 不丢失、刷新可还原。 */
/* terminal 域已抽出到 js/terminal-mod.js */

/* trace 域已抽出到 js/trace.js */

/* 切换显示的标签缓冲 */
/* terminal 域 swapTerm/renderTermTabs/newTermTab/closeTermTab/initTermTabs 已抽出到 js/terminal-mod.js */

/* ---------------- 聊天流渲染 ---------------- */
let blocks = {};          // 当前绑定会话的块映射（withConv 动态指向 convBlocks[convId]）
let answerBlock = null;   // 跨轮聚合的最终回答气泡（一次任务 = 一个气泡；按会话隔离）
let thinkCount = 0;       // 本次任务的思考步序号（withConv 按会话绑定）
let lastThink = null;     // 当前正在流式输出的思考块（用于自动折叠上一个）
let dragTabIdx = null;    // 拖拽排序中的源标签索引
function scrollChat(force) {
  // Sticky scroll：用户上翻查看历史时不强制拉回底部；force=true 时无条件滚到底（新消息/审批/选项卡）
  if (force || chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight < 80) {
    chatStream.scrollTop = chatStream.scrollHeight;
  }
  if (_ctxRaf) return;
  _ctxRaf = requestAnimationFrame(() => { _ctxRaf = null; refreshCtx(); });
}

/* ---------------- 消息节点快速跳转 ---------------- */
let _msgNavRaf = null;
function buildMsgNav() {
  if (_msgNavRaf) return;
  _msgNavRaf = requestAnimationFrame(() => {
    _msgNavRaf = null;
    _doBuildMsgNav();
  });
}
function _doBuildMsgNav() {
  const rail = msgNavRail;
  if (!rail) return;
  const msgs = [];
  chatPane().querySelectorAll(":scope > .msg-user, :scope > .msg-ai").forEach((el) => { msgs.push(el); });
  if (msgs.length < 2) { rail.innerHTML = ""; return; }
  rail.innerHTML = "";
  const count = msgs.length;
  msgs.forEach((el, i) => {
    const isUser = el.classList.contains("msg-user");
    const dot = document.createElement("div");
    dot.className = "msg-nav-item" + (isUser ? " user" : " ai");
    dot.style.top = ((i / (count - 1)) * 100) + "%";
    const txt = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
    dot.onclick = (e) => {
      e.stopPropagation();
      chatStream.scrollTo({ top: el.offsetTop - 10, behavior: "smooth" });
    };
    dot.onmouseenter = () => { _showNavTip(dot, isUser, txt); };
    dot.onmouseleave = () => { _hideNavTip(); };
    rail.appendChild(dot);
  });
  updateMsgNavActive();
}
let _navTip = null;
function _showNavTip(dot, isUser, txt) {
  if (!_navTip) { _navTip = document.createElement("div"); _navTip.className = "msg-nav-tip"; document.body.appendChild(_navTip); }
  _navTip.textContent = (isUser ? "👤 " : "🤖 ") + txt;
  _navTip.style.display = "block";
  const r = dot.getBoundingClientRect();
  _navTip.style.top = (r.top + r.height / 2 - 10) + "px";
}
function _hideNavTip() { if (_navTip) _navTip.style.display = "none"; }
function updateMsgNavActive() {
  const rail = msgNavRail;
  if (!rail || !rail.children.length) return;
  const scrollTop = chatStream.scrollTop;
  const viewH = chatStream.clientHeight;
  let activeIdx = -1;
  const dots = Array.from(rail.children);
  const msgs = [];
  chatPane().querySelectorAll(":scope > .msg-user, :scope > .msg-ai").forEach((el) => { msgs.push(el); });
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].offsetTop - 10 <= scrollTop + viewH * 0.3) activeIdx = i;
  }
  dots.forEach((d, i) => d.classList.toggle("active", i === activeIdx));
}
let _navHideTimer;
chatStream.addEventListener("scroll", () => {
  msgNavRail.classList.add("nav-visible");
  clearTimeout(_navHideTimer);
  _navHideTimer = setTimeout(() => msgNavRail.classList.remove("nav-visible"), 800);
  updateMsgNavActive();
});

/* 追加任务内容块：若最终回答气泡已出现，则插到它之前，保证「思考/工具在前、最终结论在最后」 */
function appendChatBlock(el) {
  const pane = chatPane();
  if (answerBlock && answerBlock.row && answerBlock.row.parentNode === pane) {
    pane.insertBefore(el, answerBlock.row);
  } else {
    pane.appendChild(el);
  }
  buildMsgNav();
  foldOldMessages();
}

/* 长会话折叠：直接子消息超过阈值时，把最早的批次收入折叠容器（可展开），降低 DOM 渲染压力 */
const FOLD_THRESHOLD = 60, FOLD_BATCH = 30;
function foldOldMessages() {
  const pane = chatPane();
  const direct = pane.querySelectorAll(":scope > .msg-user, :scope > .msg-ai");
  if (direct.length <= FOLD_THRESHOLD) return;
  let container = pane.querySelector(":scope > .fold-old");
  if (!container) {
    container = document.createElement("div");
    container.className = "fold-old";
    container.innerHTML = '<button class="fold-old-btn" type="button"></button><div class="fold-old-body"></div>';
    pane.insertBefore(container, pane.firstChild);
  }
  const body = container.querySelector(".fold-old-body");
  const take = Math.min(FOLD_BATCH, direct.length - FOLD_THRESHOLD);
  for (let i = 0; i < take; i++) body.appendChild(direct[i]);   // 按原顺序收进折叠区
  const n = body.querySelectorAll(".msg-user, .msg-ai").length;
  container.querySelector(".fold-old-btn").textContent = "展开更早的 " + n + " 条消息";
  buildMsgNav();
}
/* 折叠按钮事件委托：会话 dom 持久化恢复后按钮事件依然有效 */
chatStream.addEventListener("click", (e) => {
  const btn = e.target.closest(".fold-old-btn");
  if (!btn) return;
  const c = btn.closest(".fold-old");
  if (c) { c.classList.add("expanded"); btn.style.display = "none"; buildMsgNav(); }
});

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
  const nodes = Array.from(chatPane().children);
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


function addMsgCopyBtn(el, text) {
  const btn = document.createElement("button");
  btn.className = "msg-copy";
  btn.innerHTML = ico("copy");
  btn.title = "复制";
  btn.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(text || el.textContent || "").then(() => toast("已复制")); };
  el.appendChild(btn);
}

function addUserMsg(text) {
  const el = document.createElement("div");
  el.className = "msg msg-user";
  el.textContent = text;
  addMsgCopyBtn(el, text);
  chatPane().appendChild(el); scrollChat(true);
}


const KIND_ICO = { read: "read", edit: "edit", terminal: "terminal" };

function applyEngineInfo(info) {
  state.engine = info;
  const label = info.mode === "llm" ? info.model : "内置演示引擎";
  $("cpModelEditor").textContent = label;
  $("cpModelAgents").textContent = label + " · Agent 模式";
  $("btnSettings").classList.toggle("llm-on", info.mode === "llm");
}

function syncFiles(files, incremental) {
  if (incremental) {
    // 增量更新：只覆盖传入的路径，保留未提及的文件
    state.files = state.files || {};
    for (const p in files) state.files[p] = files[p];
  } else {
    state.files = files;
  }
  // 关闭已消失文件的标签
  state.openTabs = state.openTabs.filter((p) => state.files[p]);
  if (state.activeFile && !state.files[state.activeFile]) {
    state.activeFile = state.openTabs[state.openTabs.length - 1] || null;
    if (state.activeFile) openFile(state.activeFile);
    else { hideBinPreview(); if (state.monacoReady) editor.setModel(null); }
  }
  // 同步 model 内容（跳过用户正在编辑的脏文件）
  if (state.monacoReady) {
    for (const p in models) {
      if (!state.files[p]) { models[p].dispose(); delete models[p]; state.dirty.delete(p); lspClose(p); continue; }
      if (state.files[p].binary) continue; // 二进制占位 model 不同步内容
      if (!state.dirty.has(p) && models[p].getValue() !== state.files[p].content) models[p].setValue(state.files[p].content);
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
  appendChatBlock(el); scrollChat(true);
  blocks["ap_" + ev.id] = { el };   // 服务端超时自动拒绝时通过合成 tool.end 收尾
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

/* 交互式选项列表弹窗：Agent 调 ask_user_choice 时渲染候选方案。
   注意：必须用 tool-card choice open 结构——.tool-body 全局 display:none，
   只有 .tool-card.open（或 .choice 专属规则）才显示；头部类名是 tool-head。 */
function renderChoice(ev) {
  const el = document.createElement("div");
  el.className = "tool-card choice open";
  const opts = Array.isArray(ev.options) ? ev.options : [];
  el.innerHTML =
    '<div class="tool-head"><span class="t-kind">' + ico("sparkle") + '</span><span class="t-name">需要你做个决策</span>' +
      '<span class="t-target">' + esc((ev.question || "").slice(0, 60)) + '</span>' +
      '<span class="t-status pending">等待选择</span></div>' +
    '<div class="tool-body choice-body">' +
      '<div class="choice-question">' + esc(ev.question || "") + '</div>' +
      '<div class="choice-list">' + opts.map((o, i) =>
        '<button class="choice-opt" data-idx="' + i + '">' +
          '<span class="choice-opt-label">' + esc(o.label || "") + '</span>' +
          (o.description ? '<span class="choice-opt-desc">' + esc(o.description) + '</span>' : '') +
        '</button>'
      ).join("") + '</div>' +
    '</div>';
  appendChatBlock(el); scrollChat(true);
  blocks["choice_" + ev.id] = { el };   // 服务端超时/取消时通过合成 tool.end 收尾
  const statusEl = el.querySelector(".t-status");
  el.querySelectorAll(".choice-opt").forEach((btn) => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const choice = opts[idx] ? opts[idx].label : "";
      send({ type: "tool.choice_result", id: ev.id, choice });
      statusEl.className = "t-status done";
      statusEl.innerHTML = ico("check") + " 已选择: " + esc(choice);
      el.querySelectorAll(".choice-opt").forEach((b) => { b.disabled = true; b.classList.toggle("selected", b === btn); });
    };
  });
}

function handleEvent(ev) {
  /* 多会话并行：聊天 DOM 类消息按 convId 写入对应会话的 pane（后台会话实时可见），
     其余消息（文件/终端/计划/编排等全局 UI）直接分发 */
  const CHAT_DOM_TYPES = new Set(["user.msg", "think.start", "think.delta", "think.end", "msg.start", "msg.delta", "msg.end", "tool.start", "tool.body", "tool.end", "tool.ask_choice", "agent.error"]);
  if (CHAT_DOM_TYPES.has(ev.type)) {
    withConv(ev.convId || convId, () => handleEventInner(ev));
    return;
  }
  handleEventInner(ev);
}

function handleEventInner(ev) {
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
    case "fs.sync": syncFiles(ev.files, ev.incremental); break;
    case "engine.info": applyEngineInfo(ev.engine); break;
    case "agent.state": setRunning(ev.running, ev.label, ev.convId); break;
    case "user.msg": {
      // 新任务开始：重置聚合状态 + 加一条分隔线，让多次任务清晰分段
      answerBlock = null; thinkCount = 0; lastThink = null;
      const sep = document.createElement("div");
      sep.className = "run-sep";
      chatPane().appendChild(sep);
      addUserMsg(ev.text);
      break;
    }
    case "op.error": termLine('<span class="tl-err">[操作失败] ' + esc(ev.userHint || ev.error) + "</span>"); break;
    case "agent.error": showAgentError(ev); break;
    case "file.saved": {
      state.dirty.delete(ev.path);
      if (state.files[ev.path] && models[ev.path]) state.files[ev.path].content = models[ev.path].getValue();
      renderTabs(); renderTree(); renderChanges();
      if (previewOn && isPreviewable(ev.path)) renderPreview();
      termLine('<span class="tl-info">[已保存] ' + esc(ev.path) + "</span>");
      toast("已保存 " + ev.path);
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
      blocks[ev.id] = { el, body, buf: "", step: thinkCount, startTime: Date.now() };
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
      const dur = b.startTime ? Math.max(1, Math.round((Date.now() - b.startTime) / 1000)) : null;
      b.el.querySelector(".tk-label").textContent = "思考" + (dur ? " · " + dur + "s" : "") + "（第 " + (b.step || thinkCount) + " 步，点击展开）";
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
      chatPane().appendChild(row); scrollChat(true);
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
      send({ type: "ctx.query" });   // 回答结束拉一次服务端实测水位，校正圆圈进度
      break;
    }

    case "tool.start": {
      const el = document.createElement("div");
      el.className = "tool-card";
      const roundBadge = ev.round ? '<span class="t-round">R' + ev.round + '</span>' : '';
      el.innerHTML = '<div class="tool-head"><span class="t-kind">' + ico(KIND_ICO[ev.kind] || "files") + '</span>' +
        '<span class="t-name">' + esc(ev.name) + '</span><span class="t-target">' + esc(ev.target) + "</span>" +
        roundBadge + '<span class="t-status running">' + ico("spin") + "执行中</span></div><div class=\"tool-body\"></div>";
      el.querySelector(".tool-head").onclick = () => el.classList.toggle("open");
      appendChatBlock(el); scrollChat();
      blocks[ev.id] = { el };
      // 实时进度：状态栏显示当前轮次 + 工具名
      const liveTxt = $("agLiveTxt");
      if (liveTxt && ev.round) liveTxt.textContent = "第 " + ev.round + " 轮 · " + ev.name;
      const sbTxt = $("sbAgentTxt");
      if (sbTxt && ev.round) sbTxt.textContent = "R" + ev.round + " · " + ev.name;

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
    case "tool.ask_choice": renderChoice(ev); break;

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
    case "editor.diff": {
      if (state.mode === "editor" && state.activeTab === ev.path && editor && monaco) {
        const decos = ev.added.map(function(ln) {
          return { range: new monaco.Range(ln, 1, ln, 1), options: { isWholeLine: true, className: "agent-diff-added", linesDecorationsClassName: "agent-diff-added-gutter" } };
        });
        state.diffDecos = editor.deltaDecorations(state.diffDecos || [], decos);
      }
      break;
    }

    case "changes": {
      if (!ev.convId || ev.convId === convId) renderChanges(ev.list);

      break;
    }

    /* ----- 补丁审阅：agent 用 apply_edit 暂存的改动 ----- */
    case "patch.review": openPatchReview(ev); break;
    case "patch.applied": {
      if (ev.empty) { if (state.patch) state.patch.files = []; closePatchModal(); break; }
      if (!state.patch) break;
      const set = new Set(ev.paths || []);
      state.patch.files = state.patch.files.filter((f) => !set.has(f.path));
      set.forEach((p) => { try { openFile(p); } catch (e) {} });   // 应用后打开到编辑器
      if (!state.patch.files.length) closePatchModal();
      else { renderPatchList(); renderPatchDiff(state.patch.files[0].path); }
      const cl = (ev.conflicts || []).length;
      toast(cl ? "已接受 " + (ev.paths || []).length + " 个，" + cl + " 个冲突跳过" : "已接受 " + (ev.paths || []).length + " 个文件改动");
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

    case "agent.done": {
      // 多会话并行：按 convId 清除运行状态
      const doneConvId = ev.convId || convId;
      if (doneConvId) state.convRunning[doneConvId] = false;
      state.running = !!state.convRunning[convId];
      state.round = ev.round;
      if (!ev.convId || ev.convId === convId) {
        answerBlock = null; thinkCount = 0; lastThink = null; refreshCtx();
      }
      renderConvList();
      break;
    }
    case "agent.reset": state.round = 0; answerBlock = null; thinkCount = 0; lastThink = null; refreshCtx(); break;

    /* ----- 多 Agent 编排 ----- */
    case "orch.start": onOrchStart(ev); break;
    case "orch.step.start": onOrchStepStart(ev); break;
    case "orch.step.done": onOrchStepDone(ev); break;
    case "orch.step.fail": onOrchStepFail(ev); break;
    case "orch.done": onOrchDone(ev); break;


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
  chatPane().querySelectorAll(".msg-user, .msg-ai").forEach((n) => { chars += (n.textContent || "").length; });
  return Math.ceil(chars / 4);
}
/* 上下文真实实时显示：仅百分比，基于真实 token 计算 */
function refreshCtx() {
  const wrap = inputBox.querySelector("#ctxBarWrap");
  if (!wrap) return;
  let used, budget, fromServer = false;
  if (ctxServer && ctxServer.budget) { used = ctxServer.used; budget = ctxServer.budget; fromServer = true; }
  else {
    // 估算：统计所有消息 + 思考块 + 工具卡片
    let chars = 0;
    chatPane().querySelectorAll(".msg-user, .msg-ai, .think-block, .tool-card").forEach((n) => { chars += (n.textContent || "").length; });
    used = Math.ceil(chars / 4);
    budget = (state.agent && state.agent.contextWindow) || 128000;
  }
  const pct = Math.min(100, Math.round((used / budget) * 100));
  wrap.style.display = "flex";
  const pctEl = wrap.querySelector("#ctxPct");
  if (pctEl) {
    pctEl.textContent = pct + "%";
    pctEl.classList.toggle("mid", pct >= 60 && pct < 85);
    pctEl.classList.toggle("warn", pct >= 85);
  }
  wrap.title = "上下文 " + pct + "%" + (fromServer ? "（服务端实测）" : "（本地估算）") + (pct >= 85 ? "，即将自动压缩" : "");
}
/* 服务端 context.usage 事件 → 存储实测值并刷新 */
function updateCtxBar(used, budget) {
  ctxServer = { used, budget };
  refreshCtx();
}

/* ---------------- Agent 状态 ---------------- */
function setRunning(running, label, evConvId) {
  // 多会话并行：按 convId 更新运行状态
  const cid = evConvId || convId;
  if (cid) state.convRunning[cid] = running;
  // 全局 running = 当前活跃会话是否在运行
  state.running = !!state.convRunning[convId];
  const isCurrent = !evConvId || evConvId === convId;
  if (!isCurrent) { renderConvList(); return; }  // 后台会话状态变更：只刷新会话列表
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
    if (running) {
      // 修复：running 时按钮变为「停止」，必须保持可点击，才能发送 abort 中断 Agent 主循环
      btn.disabled = false;
      btn.innerHTML = ico("stop") + t("stop");
      btn.classList.add("stop-mode");
      btn.onclick = () => { if (goalMode) { setGoalMode(false); toast("已停止 Goal 模式"); } send({ type: "abort", convId }); };
    } else {
      // Agent 空闲：恢复为「发送」按钮，点击走正常 doSend（重置 onclick，避免残留 abort 处理器）
      btn.disabled = false;
      btn.innerHTML = ico("send") + t("send");
      btn.classList.remove("stop-mode");
      btn.onclick = window._doSend || (() => {});
      // Goal 模式：Agent 完成一轮后，若计划未完成则自动续跑
      if (goalMode) scheduleGoalContinue();
    }
  }
}

/* Goal 续跑：检查进度，决定是否继续、停滞提示、或退出 */
function scheduleGoalContinue() {
  if (!goalMode) return;
  const plan = currentPlan;
  if (!plan || !plan.tasks || plan.tasks.length === 0) {
    // 计划还没创建，给 Agent 一轮思考时间后重试
    if (goalRunCount < 3) { goalRunCount++; setTimeout(() => send({ type: "chat", text: "请先用 create_plan 创建执行计划", attachments: [], convId }), 800); }
    return;
  }
  if (plan.status === "completed") { setGoalMode(false); return; }
  // 轮数上限
  if (goalRunCount >= GOAL_MAX_RUNS) {
    setGoalMode(false);
    toast("Goal 已续跑 " + GOAL_MAX_RUNS + " 轮，自动停止。请检查进度后决定是否继续。");
    return;
  }
  const doneNow = plan.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
  // 停滞检测
  if (doneNow === goalLastDoneCount) {
    goalStallCount++;
    if (goalStallCount >= GOAL_MAX_STALL) {
      setGoalMode(false);
      toast("Goal 连续 " + GOAL_MAX_STALL + " 轮无进展，自动停止。请检查后手动继续或调整目标。");
      return;
    }
  } else {
    goalStallCount = 0;
  }
  goalLastDoneCount = doneNow;
  goalRunCount++;
  // 续跑消息：简洁，不重复整个 goal
  const remaining = plan.tasks.filter((t) => t.status !== "done" && t.status !== "skipped");
  const nextTask = remaining[0];
  const hint = nextTask ? '（下一步：' + (nextTask.text || "").slice(0, 60) + '）' : '';
  setTimeout(() => send({ type: "chat", text: "继续执行计划" + hint, attachments: [], convId }), 1000);
}

/* ---------------- 多 Agent 编排面板 ---------------- */
let orchSteps = {};
function onOrchStart(ev) {
  orchSteps = {};
  const overlay = $("orchOverlay");
  $("orchTitle").textContent = ev.title || "多 Agent 编排";
  $("orchSummary").style.display = "none";
  const container = $("orchSteps");
  container.innerHTML = "";
  (ev.steps || []).forEach((s) => {
    orchSteps[s.id] = { name: s.name, status: "pending" };
    const el = document.createElement("div");
    el.className = "orch-step pending";
    el.dataset.id = s.id;
    el.innerHTML = '<div class="orch-step-head">' +
      '<span class="orch-step-ico">' + ico("spin") + '</span>' +
      '<span class="orch-step-name">' + esc(s.name) + '</span>' +
      '<span class="orch-step-status">等待中</span></div>' +
      '<div class="orch-step-out"></div>';
    container.appendChild(el);
  });
  overlay.style.display = "";
  replaceIcons();
}
function onOrchStepStart(ev) {
  const el = $("orchSteps").querySelector('[data-id="' + ev.stepId + '"]');
  if (!el) return;
  el.className = "orch-step running";
  el.querySelector(".orch-step-ico").innerHTML = ico("spin");
  el.querySelector(".orch-step-status").textContent = "执行中" + (ev.parallel ? "（并行）" : "");
  replaceIcons();
}
function onOrchStepDone(ev) {
  const el = $("orchSteps").querySelector('[data-id="' + ev.stepId + '"]');
  if (!el) return;
  el.className = "orch-step done";
  el.querySelector(".orch-step-ico").innerHTML = ico("check");
  el.querySelector(".orch-step-status").textContent = "完成";
  if (ev.output) {
    const out = el.querySelector(".orch-step-out");
    out.textContent = ev.output.slice(0, 500);
    out.style.display = "";
  }
  replaceIcons();
}
function onOrchStepFail(ev) {
  const el = $("orchSteps").querySelector('[data-id="' + ev.stepId + '"]');
  if (!el) return;
  el.className = "orch-step fail";
  el.querySelector(".orch-step-ico").innerHTML = ico("error");
  el.querySelector(".orch-step-status").textContent = "失败";
  if (ev.error) {
    const out = el.querySelector(".orch-step-out");
    out.textContent = ev.error;
    out.style.display = "";
  }
  replaceIcons();
}
function onOrchDone(ev) {
  const summary = $("orchSummary");
  summary.style.display = "";
  summary.className = "orch-summary " + (ev.ok ? "ok" : "fail");
  summary.innerHTML = '<span class="orch-sum-ico">' + ico(ev.ok ? "check" : "error") + '</span>' + esc(ev.summary || "编排完成");
  replaceIcons();
  // 保存编排历史
  try {
    const key = "pancode:orch-hist:" + _wsHash();
    let hist = JSON.parse(localStorage.getItem(key) || "[]");
    hist.unshift({ title: ev.summary || "编排", ok: ev.ok, elapsed: ev.elapsed, ts: Date.now() });
    hist = hist.slice(0, 20);
    localStorage.setItem(key, JSON.stringify(hist));
    renderOrchHistory();
  } catch (e) {}
}
function renderOrchHistory() {
  const host = $("agOrchHistory");
  if (!host) return;
  try {
    const key = "pancode:orch-hist:" + _wsHash();
    const hist = JSON.parse(localStorage.getItem(key) || "[]");
    if (!hist.length) { host.innerHTML = '<div class="ag-orch-empty">暂无编排记录</div>'; return; }
    host.innerHTML = "";
    hist.forEach((h) => {
      const el = document.createElement("div");
      el.className = "ag-orch-item";
      const d = new Date(h.ts);
      const meta = (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      el.innerHTML = '<div class="ag-orch-item-head">' +
        '<span class="ag-orch-item-badge ' + (h.ok ? "ok" : "fail") + '">' + (h.ok ? "✓" : "✗") + '</span>' +
        '<span class="ag-orch-item-title">' + esc((h.title || "编排").slice(0, 40)) + '</span>' +
        '</div><div class="ag-orch-item-meta">' + meta + (h.elapsed ? " · " + h.elapsed + "s" : "") + '</div>';
      host.appendChild(el);
    });
  } catch (e) {}
}
(function () {
  const closeBtn = $("orchClose");
  if (closeBtn) closeBtn.onclick = () => { $("orchOverlay").style.display = "none"; };
  renderOrchHistory();
})();

/* ---------------- 本地鉴权 ---------------- */
const AUTH = { token: "" };
let _authRedirected = false;   // 防止 401 时反复弹登录窗
let lastUserText = "";         // C2：记录最后一条用户消息，供错误重试使用

function showAuthModal() {
  _authRedirected = false;
  const m = $("authModal"); if (m) m.style.display = "flex";
  const s = $("authStatus"); if (s) { s.textContent = ""; s.className = "auth-status"; }
  replaceIcons(m);
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
  chatPane().appendChild(el);
  scrollChat(true);
}
function resendLast() {
  if (!lastUserText) { toast("没有可重试的消息"); return; }
  send({ type: "newchat" });
  setTimeout(() => send({ type: "chat", text: lastUserText, attachments: [], convId }), 250);
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
        sessionStorage.removeItem("cw-user-token");
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
let wsRetry = 0;               // 重连退避计数（指数退避 1s→30s 封顶）
const WS_RETRY_MAX = 30000;
function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/?token=" + encodeURIComponent(AUTH.token));
  ws.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  // C6：连接/重连建立后，把当前会话 ID 同步给服务端，恢复对应的 AI 上下文
  ws.onopen = () => {
    if (wsRetry > 0) toast("已重新连接");
    wsRetry = 0;             // 连接成功，重置退避
    send({ type: "ctx.query" });
    if (typeof convId !== "undefined" && convId) { send({ type: "switchConv", convId: convId }); loadTraceHistory(convId); send({ type: "ctx.query" }); }
  };
  ws.onclose = () => {
    const delay = Math.min(1000 * Math.pow(2, wsRetry), WS_RETRY_MAX);
    wsRetry++;
    if (wsRetry === 1) toast("连接断开，正在重连…");
    setTimeout(connect, delay);
  };
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

/* ---------------- 输入事件 ---------------- */
let activeSkill = null;
const sentHistory = {};   // 各会话的已发消息历史，供 ↑/↓ 浏览：{ convId: [text, ...] }
let histNav = -1;         // 历史浏览指针，-1 表示正在正常编辑（不在浏览历史）


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
    // 多会话并行：直接发送，不再排队
    lastUserText = text; send({ type: "chat", text, attachments, convId });
    if (attachments.length) termLine('<span class="tl-info">[附件] 已随消息发送 ' + attachments.length + " 张图片</span>");
  };
  window._doSend = doSend;   // 暴露全局引用供 setRunning / openConv 使用
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

  // /斜杠命令：快速执行常见任务
  const SLASH_COMMANDS = [
    { cmd: "/explain", desc: "解释当前文件", expand: "请阅读并解释当前打开的文件，说明其功能、关键逻辑和设计思路。" },
    { cmd: "/test", desc: "生成单元测试", expand: "请为当前打开的文件生成单元测试，覆盖主要功能和边界情况。先查看项目中已有的测试风格并保持一致。" },
    { cmd: "/fix", desc: "修复错误", expand: "请检查当前打开的文件中的错误和问题，并修复它们。先运行测试确认问题，修复后再验证。" },
    { cmd: "/refactor", desc: "重构代码", expand: "请重构当前打开的文件，改善代码结构、可读性和可维护性，但不改变功能。改完跑测试验证。" },
    { cmd: "/review", desc: "代码审查", expand: "请对当前打开的文件进行代码审查，指出潜在问题、改进建议和最佳实践。" },
    { cmd: "/docs", desc: "生成文档", expand: "请为当前打开的文件生成文档注释（JSDoc/docstring 等），包括函数说明、参数和返回值。" },
    { cmd: "/optimize", desc: "优化性能", expand: "请分析当前打开的文件的性能瓶颈，并提出和实施优化方案。改完验证功能不变。" },
  ];
  const slashMenu = document.createElement("div");
  slashMenu.className = "at-menu"; slashMenu.style.display = "none";
  document.body.appendChild(slashMenu);
  let slashIdx = 0, slashItems = [];
  const hideSlashMenu = () => { slashMenu.style.display = "none"; };
  const refreshSlashActive = () => slashMenu.querySelectorAll(".at-item").forEach((el, i) => el.classList.toggle("active", i === slashIdx));
  const pickSlash = (i) => {
    const it = slashItems[i]; if (!it) return;
    ta.value = it.expand; ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    hideSlashMenu();
  };
  const showSlashMenu = (items) => {
    slashItems = items; slashIdx = 0;
    if (!items.length) { hideSlashMenu(); return; }
    slashMenu.innerHTML = items.map((it, i) => '<div class="at-item' + (i === 0 ? " active" : "") + '" data-i="' + i + '"><span class="at-kind">命令</span>' + esc(it.cmd) + ' <span style="color:var(--text-dim)">' + esc(it.desc) + '</span></div>').join("");
    slashMenu.style.display = "block";
    const r = ta.getBoundingClientRect();
    slashMenu.style.left = Math.max(8, r.left) + "px";
    slashMenu.style.top = Math.max(8, r.top - slashMenu.offsetHeight - 6) + "px";
    slashMenu.querySelectorAll(".at-item").forEach((el) => el.onclick = () => pickSlash(parseInt(el.dataset.i, 10)));
  };
  const onSlashInput = () => {
    if (atMenu && atMenu.style.display !== "none") { hideSlashMenu(); return; }
    const pos = ta.selectionStart, before = ta.value.slice(0, pos);
    const m = before.match(/^\/(\w*)$/);
    if (!m) { hideSlashMenu(); return; }
    const q = m[1].toLowerCase();
    showSlashMenu(SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(q)));
  };
  ta.addEventListener("input", onSlashInput);

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
    if (slashMenu && slashMenu.style.display !== "none") {
      if (e.key === "Escape") hideSlashMenu();
      else if (e.key === "ArrowDown") { e.preventDefault(); slashIdx = (slashIdx + 1) % slashItems.length; refreshSlashActive(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); slashIdx = (slashIdx - 1 + slashItems.length) % slashItems.length; refreshSlashActive(); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashIdx); }
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
  document.addEventListener("click", (e) => { if (slashMenu && slashMenu.style.display !== "none" && !slashMenu.contains(e.target) && e.target !== ta) hideSlashMenu(); });

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
    if (mode === "auto") {
      e.target.value = "ask"; // 先还原，确认后再切
      showConfirm("切换到全自动模式", "全自动模式下 Agent 将<strong style='color:var(--err)'>无需确认即可执行所有操作</strong>（高危命令仍会拦截）。确定切换吗？", async () => {
        e.target.value = "auto";
        try {
          await fetch("/api/agent-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissions: { mode: "auto" } }) });
          toast("权限模式 → 全自动");
        } catch (err) { toast("权限切换失败: " + err.message); }
      });
      return;
    }
    try {
      await fetch("/api/agent-settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: { mode } }),
      });
      const label = { ask: "逐项确认", semi: "半自动（安全操作放行，写入仍确认）", auto: "全自动（高危仍会拦截）" }[mode] || mode;
      toast("权限模式 → " + label);
    } catch (err) { toast("权限切换失败: " + err.message); }
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
/* 分离存储：每会话 dom 独立 key，避免 persistConv 时全量序列化所有会话 */
function convDomKey(id) { return "cw-convdom-v1:" + _wsHash() + ":" + id; }
function saveConvDom(id, html) { try { localStorage.setItem(convDomKey(id), html); } catch (e) {} }
function loadConvDom(id) { try { return localStorage.getItem(convDomKey(id)) || ""; } catch (e) { return ""; } }
function deleteConvDom(id) { try { localStorage.removeItem(convDomKey(id)); } catch (e) {} }
let convId = null;
let convObs = null;

function loadConvList() {
  let list;
  try { list = JSON.parse(localStorage.getItem(convListKey())) || []; } catch (e) { list = []; }
  // 兼容旧格式：迁移嵌入的 .dom 到分离存储
  let migrated = false;
  for (const c of list) {
    if (c && c.dom != null) {
      if (c.dom) saveConvDom(c.id, c.dom);
      delete c.dom;
      migrated = true;
    }
  }
  if (migrated) { try { localStorage.setItem(convListKey(), JSON.stringify(list)); } catch (e) {} }
  return list;
}
function saveConvList(list) {
  try { localStorage.setItem(convListKey(), JSON.stringify(list)); } catch (e) {}
}
function genConvId() { return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function convFirstUserTitle(cvid) {
  const pane = (cvid ? convPanes[cvid] : chatPane()) || chatPane();
  if (!pane) return "";
  const u = pane.querySelector(".msg-user");
  if (!u) return "";
  let t = (u.textContent || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  // 去掉常见前缀词，提取核心意图
  t = t.replace(/^(帮我|请|麻烦|能不能|可以|我想|我想要|需要|为什么|怎么|如何|怎样|为啥|为啥要|帮我看看|看一下|看下|处理一下|修复一下|添加|新增|删除|修改|更新|优化|重构)\s*/i, "");
  // 去掉 [引用 Skill: xxx] 前缀
  t = t.replace(/^\[引用[^\]]*\]\s*/, "");
  return t.slice(0, 32);
}

/* 持久化指定会话（默认当前活跃）的 pane 内容到 localStorage */
function persistConv(cvid) {
  const id = cvid || convId;
  if (!id) return;
  const pane = convPanes[id];
  const list = loadConvList();
  const c = list.find((x) => x.id === id);
  if (!c) return;
  if (pane) saveConvDom(id, pane.innerHTML);   // dom 独立存储，避免全量序列化
  const t = convFirstUserTitle(id);
  if (t && (!c.title || c.title === "新对话")) c.title = t;
  // 不更新 ts，保持创建时间排序不变，避免会话列表跳动
  saveConvList(list);
}

function initConvObserver() {
  let t = null;
  convObs = new MutationObserver(() => { clearTimeout(t); t = setTimeout(persistConv, 500); });
  convObs.observe(chatStream, { childList: true, subtree: true, characterData: true });
}

function loadPinnedConvs() { try { return JSON.parse(localStorage.getItem("pancode:pinned:" + _wsHash()) || "[]"); } catch (e) { return []; } }
function savePinnedConvs(arr) { try { localStorage.setItem("pancode:pinned:" + _wsHash(), JSON.stringify(arr)); } catch (e) {} }
function convTimeGroup(ts) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= todayStart) return 0;
  if (ts >= todayStart - 86400000) return 1;
  if (ts >= todayStart - 7 * 86400000) return 2;
  return 3;
}
const CONV_GROUP_LABELS = ["今天", "昨天", "本周", "更早"];
function convSummary(c) {
  if (c.id === convId && state.convRunning[c.id]) return { tag: "running", text: "R" + (state.round || 1) + " 运行中" };
  if (state.convRunning[c.id]) return { tag: "running", text: "运行中" };
  // 优先取内存 pane（后台会话流式更新后比 localStorage 快照新鲜）
  const domHtml = (convPanes[c.id] && convPanes[c.id].childNodes.length) ? convPanes[c.id].innerHTML : loadConvDom(c.id);
  if (domHtml) {
    const tmp = document.createElement("div");
    tmp.innerHTML = domHtml;
    const msgs = tmp.querySelectorAll(".msg-user, .msg-ai");
    const last = msgs[msgs.length - 1];
    if (last) {
      const text = (last.textContent || "").trim().replace(/\s+/g, " ").slice(0, 42);
      if (text) return { tag: "", text: text };
    }
  }
  return { tag: "", text: "" };
}

function renderConvList() {
  const host = $("agSessionList");
  if (!host) return;
  const list = loadConvList();
  list.sort((a, b) => b.ts - a.ts);
  const _q = ($("convSearch") && $("convSearch").value || "").toLowerCase().trim();
  const filtered = _q ? list.filter((c) => (c.title || "新对话").toLowerCase().includes(_q)) : list;
  const pinned = loadPinnedConvs();
  host.innerHTML = "";
  if (!filtered.length) {
    host.innerHTML = '<div class="ag-session"><div class="ag-sess-main"><div class="ag-sess-name ag-sess-empty">' + (_q ? "未找到匹配的会话" : "暂无历史对话") + '</div></div></div>';
    return;
  }

  // 固定会话置顶
  const pinnedItems = filtered.filter((c) => pinned.includes(c.id));
  const restItems = filtered.filter((c) => !pinned.includes(c.id));

  function renderGroup(label, items) {
    if (!items.length) return;
    if (label) {
      const g = document.createElement("div");
      g.className = "ag-sess-group";
      g.textContent = label;
      host.appendChild(g);
    }
    items.forEach((c) => host.appendChild(buildConvItem(c, pinned.includes(c.id))));
  }

  renderGroup(pinnedItems.length ? "固定" : "", pinnedItems);

  // 按时间分组
  const groups = [[], [], [], []];
  restItems.forEach((c) => { groups[convTimeGroup(c.ts)].push(c); });
  groups.forEach((items, gi) => renderGroup(items.length ? CONV_GROUP_LABELS[gi] : "", items));

  replaceIcons();
}

function buildConvItem(c, isPinned) {
  const item = document.createElement("div");
  item.className = "ag-session" + (c.id === convId ? " active" : "") + (isPinned ? " pinned" : "");
  const d = new Date(c.ts);
  const meta = (d.getMonth() + 1) + "/" + d.getDate() + " " +
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const sm = convSummary(c);
  const smHtml = sm.text ? '<div class="ag-sess-summary">' +
    (sm.tag === "running" ? '<span class="ss-tag running">运行中</span>' : "") +
    esc(sm.text) + '</div>' : "";
  item.innerHTML =
    '<span class="ag-sess-dot' + (c.id === convId ? "" : " done") + '" title="' + (c.id === convId ? "进行中" : "历史对话") + '"></span>' +
    '<div class="ag-sess-main">' +
      '<div class="ag-sess-name">' + esc(c.title || "新对话") + '</div>' +
      '<div class="ag-sess-meta">' + meta + '</div>' +
      smHtml +
    '</div>' +
    '<button class="ag-sess-pin" title="固定/取消固定"><i data-ico="pin"></i></button>' +
    '<button class="ag-sess-del" title="删除此对话"><i data-ico="close"></i></button>';
  item.querySelector(".ag-sess-name").ondblclick = (e) => { e.stopPropagation(); var newName = prompt("输入新名称：", c.title || "新对话"); if (newName && newName.trim()) { c.title = newName.trim(); var l2 = loadConvList(); var f = l2.find(function(x){return x.id===c.id;}); if(f){f.title=newName.trim();saveConvList(l2);} renderConvList(); } };
  item.addEventListener("click", (e) => { if (e.target.closest(".ag-sess-del") || e.target.closest(".ag-sess-pin")) return; openConv(c.id); });
  item.addEventListener("contextmenu", (e) => { e.preventDefault(); showConvCtxMenu(e, c); });
  const del = item.querySelector(".ag-sess-del");
  if (del) del.addEventListener("click", (e) => { e.stopPropagation(); deleteConv(c.id); });
  const pin = item.querySelector(".ag-sess-pin");
  if (pin) pin.addEventListener("click", (e) => { e.stopPropagation(); togglePinConv(c.id); });
  return item;
}

function togglePinConv(id) {
  let pinned = loadPinnedConvs();
  if (pinned.includes(id)) pinned = pinned.filter((x) => x !== id);
  else pinned.unshift(id);
  savePinnedConvs(pinned);
  renderConvList();
}

function showConvCtxMenu(e, c) {
  const menu = $("ctxMenu");
  if (!menu) return;
  const pinned = loadPinnedConvs();
  menu.innerHTML = "";
  const items = [
    { label: pinned.includes(c.id) ? "取消固定" : "固定到顶部", action: () => togglePinConv(c.id) },
    { label: "重命名", action: () => { var n = prompt("输入新名称：", c.title || "新对话"); if (n && n.trim()) { var l = loadConvList(); var f = l.find(function(x){return x.id===c.id;}); if(f){f.title=n.trim();saveConvList(l);renderConvList();} } } },
    { label: "复制标题", action: () => { navigator.clipboard && navigator.clipboard.writeText(c.title || "新对话"); } },
    { label: "导出对话", action: () => { var blob = new Blob([loadConvDom(c.id) || ""], {type:"text/html"}); var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (c.title||"对话") + ".html"; a.click(); } },
    { label: "删除", danger: true, action: () => deleteConv(c.id) },
  ];
  items.forEach((it) => {
    const el = document.createElement("div");
    el.className = "ctx-item" + (it.danger ? " danger" : "");
    el.textContent = it.label;
    el.onclick = () => { menu.style.display = "none"; it.action(); };
    menu.appendChild(el);
  });
  menu.style.display = "";
  menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 200) + "px";
}

/* 会话搜索框实时过滤 */
(function() { const cs = $("convSearch"); if (cs) cs.addEventListener("input", renderConvList); })();

function openConv(id) {
  if (id === convId) return;
  if (goalMode) setGoalMode(false);   // 切换会话时退出 goal 模式
  persistConv();                       // 切走前保存当前会话 pane
  convId = id;
  localStorage.setItem(convActiveKey(), id);
  send({ type: "switchConv", convId: id });   // C6：同步切换服务端 AI 上下文
  send({ type: "ctx.query" });
  loadTraceHistory(id);

  // 多会话并行：pane 内存中有则直接 move 挂载；无（刷新后首次打开）则从快照 hydrate
  const c = loadConvList().find((x) => x.id === id);
  if (!convPanes[id]) hydratePane(id, (c && loadConvDom(id)) || "");
  mountPane(id);
  foldOldMessages();
  scrollChat();
  buildMsgNav();
  refreshCtx();
  loadPlan(convId);                                                      // 切换该会话的任务计划
  renderConvList();
  replaceIcons();
  // 多会话并行：切换后更新全局 running 状态与按钮
  state.running = !!state.convRunning[convId];
  const btn = inputBox.querySelector("#btnSend");
  if (btn) {
    if (state.running) {
      btn.innerHTML = ico("stop") + t("stop");
      btn.classList.add("stop-mode");
      btn.onclick = () => { if (goalMode) { setGoalMode(false); toast("已停止 Goal 模式"); } send({ type: "abort", convId }); };
    } else {
      btn.innerHTML = ico("send") + t("send");
      btn.classList.remove("stop-mode");
      btn.onclick = window._doSend || (() => {});
    }
  }
}

function deleteConv(id) {
  const list = loadConvList().filter((x) => x.id !== id);
  saveConvList(list);
  deleteConvDom(id);                            // 清理分离存储的 dom
  send({ type: "dropConv", convId: id });     // C6：同步清理服务端上下文
  // 多会话并行：清理内存 pane 与会话上下文
  clearTimeout(convPersistTimers[id]); delete convPersistTimers[id];
  if (convPanes[id]) { if (convPanes[id].parentNode) convPanes[id].parentNode.removeChild(convPanes[id]); delete convPanes[id]; }
  delete convBlocks[id]; delete convMeta[id];
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
  list.unshift({ id: convId, title: "新对话", ts: Date.now() });
  saveConvList(list);
  clearPlanPanel();                  // 新会话无任务计划
  mountPane(convId);                 // 多会话并行：新会话独立空 pane
  for (const k in blocks) delete blocks[k];
  answerBlock = null; thinkCount = 0; lastThink = null;
  if (announce) {
    const el = document.createElement("div");
    el.className = "msg msg-ai";
    el.innerHTML = mdLite("已开始 **新对话**。上一轮上下文已清空，随时描述你的下一个任务。");
    chatPane().appendChild(el);
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
  // 工作区切换：清空全部 pane 与会话上下文（新工作区存储 key 已隔离）
  for (const pid in convPanes) { if (convPanes[pid].parentNode) convPanes[pid].parentNode.removeChild(convPanes[pid]); delete convPanes[pid]; }
  for (const bid in convBlocks) delete convBlocks[bid];
  for (const mid in convMeta) delete convMeta[mid];
  clearPlanPanel();
  const id = localStorage.getItem(convActiveKey());
  const c = id && loadConvList().find((x) => x.id === id);
  if (!c) { startNewConv(false); }
  else {
    convId = id;
    hydratePane(id, loadConvDom(id) || "");
    mountPane(id);
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
  hydratePane(convId, loadConvDom(convId) || "");
  mountPane(convId);
  renderConvList();
  replaceIcons();
  scrollChat();
  loadPlan(convId);                              // 恢复该会话的任务计划
}

function newConversation() {
  // 多会话并行：允许运行中新建会话
  // 真正的新对话：当前会话已由 observer 持久化；新建本地会话并清空服务端 AI 上下文（保留文件改动）
  clearTrace();
  startNewConv(true);
  send({ type: "newchat" });
}

$("agExport").onclick = exportConversation;

/* 侧边栏增强：新建会话 / 手动计划 / 编排历史折叠 */
(function () {
  const nc = $("btnNewConv");
  if (nc) nc.onclick = newConversation;

  const np = $("btnNewPlan");
  if (np) np.onclick = function () {
    const title = prompt("计划标题：", "手动计划");
    if (!title || !title.trim()) return;
    const tasksStr = prompt("任务步骤（每行一个）：", "步骤一\n步骤二\n步骤三");
    if (!tasksStr || !tasksStr.trim()) return;
    const tasks = tasksStr.split("\n").filter((s) => s.trim()).map((s) => ({ text: s.trim(), status: "pending" }));
    if (!tasks.length) return;
    send({ type: "tool_call", tool: "create_plan", args: { title: title.trim(), tasks: tasks.map((t) => t.text) } });
  };

  const tog = $("btnToggleOrchHist");
  if (tog) tog.onclick = function () {
    const panel = $("agOrchHistory");
    if (!panel) return;
    panel.style.display = panel.style.display === "none" ? "" : "none";
    tog.querySelector("i").style.transform = panel.style.display === "none" ? "rotate(-90deg)" : "";
  };
})();


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
/* ---------------- Ctrl+Shift+P 命令面板 ---------------- */
function aiCurrentFile(text) {
  if (!state.activeFile) { toast("请先打开一个文件"); return; }
  aiFileAction(state.activeFile, text);
}
function openCommandPalette() {
  const existing = $("cmdPalette");
  if (existing) { existing.remove(); return; }
  const commands = [
    { label: "新建文件", hint: "", fn: () => promptNewFile("") },
    { label: "新建文件夹", hint: "", fn: () => { const p = prompt("新建文件夹（相对路径）：", "newdir"); if (p) send({ type: "file.mkdir", path: p }); } },
    { label: "保存文件", hint: "Ctrl+S", fn: saveActiveFile },
    { label: "关闭当前标签", hint: "Ctrl+W", fn: () => { if (state.activeFile) closeTab(state.activeFile); } },
    { label: "文件跳转", hint: "Ctrl+P", fn: openFilePalette },
    { label: "新建对话", hint: "", fn: () => startNewConv(true) },
    { label: "切换至编辑器窗口", hint: "Ctrl+.", fn: () => switchMode("editor") },
    { label: "切换至 Agents 窗口", hint: "Ctrl+.", fn: () => switchMode("agents") },
    { label: "AI 解释当前文件", hint: "/explain", fn: () => aiCurrentFile("请阅读并解释当前打开的文件，说明其功能、关键逻辑和设计思路。") },
    { label: "AI 修复错误", hint: "/fix", fn: () => aiCurrentFile("请检查当前打开的文件中的错误和问题，并修复它们。先运行测试确认问题，修复后再验证。") },
    { label: "AI 生成测试", hint: "/test", fn: () => aiCurrentFile("请为当前打开的文件生成单元测试，覆盖主要功能和边界情况。") },
    { label: "AI 重构代码", hint: "/refactor", fn: () => aiCurrentFile("请重构当前打开的文件，改善代码结构、可读性和可维护性，但不改变功能。") },
    { label: "AI 审查代码", hint: "/review", fn: () => aiCurrentFile("请对当前打开的文件进行代码审查，指出潜在问题和改进建议。") },
    { label: "切换主题", hint: "深色/浅色", fn: () => applyTheme(getTheme() === "light" ? "dark" : "light") },
    { label: "打开设置", hint: "", fn: () => $("btnSettings").click() },
    { label: "键盘快捷键", hint: "", fn: openShortcuts },
  ];
  const pal = document.createElement("div");
  pal.id = "cmdPalette";
  pal.innerHTML = '<input class="cmd-input" placeholder="输入命令名称…" /><div class="cmd-list"></div>';
  document.body.appendChild(pal);
  const input = pal.querySelector(".cmd-input");
  const list = pal.querySelector(".cmd-list");
  let idx = 0, filtered = commands;
  const updateActive = () => list.querySelectorAll(".cmd-item").forEach((el, i) => el.classList.toggle("active", i === idx));
  const render = () => {
    filtered = commands.filter((c) => c.label.toLowerCase().includes(input.value.toLowerCase()));
    idx = 0;
    list.innerHTML = filtered.map((c, i) => '<div class="cmd-item' + (i === 0 ? " active" : "") + '" data-i="' + i + '"><span class="cmd-label">' + esc(c.label) + '</span>' + (c.hint ? '<span class="cmd-hint">' + esc(c.hint) + '</span>' : '') + '</div>').join("");
    list.querySelectorAll(".cmd-item").forEach((el) => el.onclick = () => pick(parseInt(el.dataset.i, 10)));
  };
  const pick = (i) => { const c = filtered[i]; if (!c) return; pal.remove(); c.fn(); };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { pal.remove(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(idx + 1, filtered.length - 1); updateActive(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(idx - 1, 0); updateActive(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(idx); }
  });
  render();
  input.focus();
  setTimeout(() => { document.addEventListener("click", function close(e) { if (!pal.contains(e.target)) { pal.remove(); document.removeEventListener("click", close); } }); }, 100);
}

function openFilePalette() {
  const existing = $("filePalette");
  if (existing) { existing.remove(); return; }
  const files = Object.keys(state.files).sort();
  const pal = document.createElement("div");
  pal.id = "filePalette";
  pal.innerHTML = '<input class="cmd-input" placeholder="输入文件名快速跳转…" /><div class="cmd-list"></div>';
  document.body.appendChild(pal);
  const input = pal.querySelector(".cmd-input");
  const list = pal.querySelector(".cmd-list");
  let idx = 0, filtered = files;
  const updateActive = () => list.querySelectorAll(".cmd-item").forEach((el, i) => el.classList.toggle("active", i === idx));
  const render = () => {
    const q = input.value.toLowerCase();
    filtered = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
    idx = 0;
    list.innerHTML = filtered.slice(0, 50).map((f, i) => '<div class="cmd-item' + (i === 0 ? " active" : "") + '" data-i="' + i + '"><span class="cmd-label">' + esc(f) + '</span></div>').join("");
    list.querySelectorAll(".cmd-item").forEach((el) => el.onclick = () => pick(parseInt(el.dataset.i, 10)));
  };
  const pick = (i) => { const f = filtered[i]; if (!f) return; pal.remove(); switchMode("editor"); openFile(f); };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { pal.remove(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); idx = Math.min(idx + 1, Math.min(filtered.length, 50) - 1); updateActive(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); idx = Math.max(idx - 1, 0); updateActive(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(idx); }
  });
  render();
  input.focus();
  setTimeout(() => { document.addEventListener("click", function close(e) { if (!pal.contains(e.target)) { pal.remove(); document.removeEventListener("click", close); } }); }, 100);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("shortcutsModal") && $("shortcutsModal").style.display !== "none") {
    $("shortcutsModal").style.display = "none"; return;
  }
  if (e.key === "Escape" && $("commitModal") && $("commitModal").style.display !== "none") {
    $("commitModal").style.display = "none"; return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); saveActiveFile(); }
  else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "P" || e.key === "p")) { e.preventDefault(); openCommandPalette(); }
  else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "p" || e.key === "P")) { e.preventDefault(); openFilePalette(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === "w" || e.key === "W")) { e.preventDefault(); if (state.activeFile) closeTab(state.activeFile); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === "." || e.code === "Period")) {
    e.preventDefault();
    const target = state.mode === "editor" ? "agents" : "editor";
    switchMode(target);
    toast("已切换至 " + (target === "editor" ? "编辑器" : "Agents") + " 窗口（Ctrl/Cmd + . 切换）");
  }
});


/* ---------------- 用户认证 ---------------- */
const userAuth = { token: localStorage.getItem("cw-user-token") || sessionStorage.getItem("cw-user-token") || "", username: "" };

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

// 密码显示/隐藏切换
$("authTogglePass").onclick = () => {
  const inp = $("authPass");
  const isPwd = inp.type === "password";
  inp.type = isPwd ? "text" : "password";
  $("authTogglePass").innerHTML = ico(isPwd ? "eyeOff" : "eye");
};

let authMode = "login";
$("authSwitch").onclick = () => {
  authMode = authMode === "login" ? "register" : "login";
  if (authMode === "login") {
    $("authTitle").textContent = "欢迎回来";
    $("authSub").textContent = "登录以进入你的工作区";
    $("authSubmit").textContent = "登录";
    $("authSwitchLabel").textContent = "还没有账号？";
    $("authSwitch").textContent = "注册新账号";
  } else {
    $("authTitle").textContent = "创建账号";
    $("authSub").textContent = "注册一个新账号开始编码";
    $("authSubmit").textContent = "注册";
    $("authSwitchLabel").textContent = "已有账号？";
    $("authSwitch").textContent = "返回登录";
  }
  $("authStatus").textContent = "";
  $("authStatus").className = "auth-status";
};

$("authSubmit").onclick = async () => {
  const u = $("authUser").value.trim(), p = $("authPass").value;
  if (!u || !p) { $("authStatus").className = "auth-status err"; $("authStatus").textContent = "请填写用户名和密码"; return; }
  const url = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
  const btn = $("authSubmit");
  btn.disabled = true; btn.classList.add("loading"); btn.textContent = authMode === "login" ? "登录中…" : "注册中…";
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, password: p }) }).then((x) => x.json());
    if (r.ok) {
      userAuth.token = r.token; userAuth.username = r.username;
      AUTH.token = r.token;   // A1：登录成功 → 后续请求带 userToken（登录闸门生效）
      // 记住我：勾选用 localStorage（持久），不勾用 sessionStorage（会话级）
      const remember = $("authRemember") && $("authRemember").checked;
      localStorage.removeItem("cw-user-token");
      sessionStorage.removeItem("cw-user-token");
      if (remember) localStorage.setItem("cw-user-token", r.token);
      else sessionStorage.setItem("cw-user-token", r.token);
      $("tbUserTxt").textContent = r.username;
      $("tbUserBtn").classList.add("logged");
      $("authModal").style.display = "none";
      _authRedirected = false;
      toast(authMode === "login" ? "✅ 登录成功" : "✅ 注册成功");
      startApp(); maybeOnboard();   // 登录后才加载工作区数据并连接 WS，并触发首次引导
    } else {
      $("authStatus").className = "auth-status err";
      $("authStatus").textContent = r.error;
    }
  } catch (e) { $("authStatus").className = "auth-status err"; $("authStatus").textContent = "请求异常: " + e.message; }
  finally { btn.disabled = false; btn.classList.remove("loading"); btn.textContent = authMode === "login" ? "登录" : "注册"; }
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
  currentPlan = plan;
  const box = $("agPlanEmpty");
  const active = $("agPlanActive");
  if (box) box.style.display = "none";
  if (active) active.style.display = "block";
  const done = plan.tasks.filter((t) => t.status === "done" || t.status === "skipped").length;
  const total = plan.tasks.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const statusLabel = plan.status === "completed" ? "已完成" : "进行中";
  const statusClass = plan.status === "completed" ? "done" : "active";
  let html = "";
  // Goal 卡片（Goal 模式激活时在计划顶部显示）
  if (goalMode) {
    html += '<div class="plan-goal">' +
      '<div class="plan-goal-title">' + ico("target") + '<span>目标驱动</span></div>' +
      '<div class="plan-goal-text">' + esc(plan.title) + '</div>' +
      '<div class="plan-goal-bar"><div class="plan-goal-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="plan-goal-meta"><span>' + done + '/' + total + ' 步骤完成</span><span>' + pct + '%</span></div>' +
      '</div>';
  }
  html += '<div class="plan-title">' + ico("tasklist") + '<span>' + esc(plan.title) + '</span><span class="plan-status ' + statusClass + '">' + statusLabel + '</span></div>';
  plan.tasks.forEach((t, i) => {
    const cls = t.status;
    const icon = t.status === "done" ? "✓" : t.status === "in_progress" ? "●" : t.status === "skipped" ? "×" : "";
    html += '<div class="plan-task ' + cls + '" data-idx="' + i + '"><span class="plan-check">' + icon + '</span><span class="plan-text">' + esc(t.text) + (t.note ? ' <span style="color:var(--text-dim);font-size:10px">(' + esc(t.note) + ')</span>' : "") + '</span></div>';
  });
  html += '<div class="plan-progress"><span>' + done + '/' + total + '</span><div class="plan-progress-bar"><div class="plan-progress-fill" style="width:' + pct + '%"></div></div><span>' + pct + '%</span></div>';
  if (active) { active.innerHTML = html; replaceIcons(active); }
  // 任务可点击勾选
  active.querySelectorAll(".plan-task").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.idx, 10);
      const task = plan.tasks[idx];
      if (!task || task.status === "in_progress") return;
      const newStatus = task.status === "done" ? "pending" : "done";
      plan.tasks[idx].status = newStatus;
      renderPlan(plan);
      send({ type: "update_plan_task", convId: convId, planId: plan.id, taskIdx: idx, status: newStatus });
    });
  });
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
  // Goal 模式：计划全部完成时自动退出
  if (goalMode && plan.status === "completed") {
    setGoalMode(false);
    toast("Goal 已完成，自动退出目标模式");
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
let currentPlan = null;        // renderPlan 时缓存，供续跑逻辑读取进度
let goalRunCount = 0;          // 本轮 goal 已续跑次数
let goalLastDoneCount = -1;    // 上次续跑时的 done 数（停滞检测）
let goalStallCount = 0;        // 连续无进展次数
const GOAL_MAX_RUNS = 50;      // 单个 goal 最多续跑轮数
const GOAL_MAX_STALL = 3;      // 连续无进展上限

function setGoalMode(active) {
  goalMode = active;
  const btn = $("btnGoal");
  if (btn) btn.classList.toggle("active", active);
  if (!active) {
    if (goalPollTimer) { clearInterval(goalPollTimer); goalPollTimer = null; }
    goalRunCount = 0;
    goalLastDoneCount = -1;
    goalStallCount = 0;
  }
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
  send({ type: "chat", text: "[GOAL MODE] 请创建计划并持续执行，直到完成以下目标后自动停止：\n\n" + goal + "\n\n要求：\n1. 先用 create_plan 拆解为具体子任务\n2. 逐个执行，每完成一步用 update_plan 标记\n3. 每步执行后验证结果，失败则修复重试\n4. 所有步骤完成后用 create_plan 的任务全部 done 来结束\n5. 中间不要停下来询问用户，自主推进", attachments: [], convId });
  toast("Goal 已启动，Agent 将持续执行直到完成");
};


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
initAgRightResizers();
replaceIcons();
mountShared();
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
