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
  agentMode: "agent",   // W8：Agent 行为模式 agent=执行 | plan=只读规划 | ask=仅问答（不调用任何工具）
  planMode: false,      // 派生字段，= (agentMode === "plan")，保留向后兼容
  project: "workspace",
  workspace: null,      // 当前工作区绝对路径（hello 事件设置）
  noGit: true,          // 没收到 git 事件前按静态 HTML 的"无 Git（快照基线）"走，别显示"本地"
  branchName: "",       // 分支名（hello 事件设置，切语言时要按当前语言重画）
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

/* 快速滚动按钮（顶部/底部） */
const chatScrollBtns = document.createElement("div");
chatScrollBtns.id = "chatScrollBtns";
chatScrollBtns.innerHTML =
  '<button id="btnScrollTop" class="chat-scroll-btn" data-i18n-title="scrollTopTip" title="滚动到顶部">' + ico("arrowUp") + "</button>" +
  '<button id="btnScrollBottom" class="chat-scroll-btn" data-i18n-title="scrollBottomTip" title="滚动到底部">' + ico("arrowDown") + "</button>";
// 滚动按钮钉在 .chat-slot（不随内容滚动的祖先）上，见 mountShared：
// 挂在 #chatStream 里时它是滚动容器的绝对定位子节点，会跟着内容一起滚，
// 结果两个按钮跑到某条回答中间，既挡字也点不到。


const inputBox = document.createElement("div");
inputBox.id = "chatInputBox";
inputBox.innerHTML =

  '<div id="ciChips" class="ci-chips"></div>' +
  '<div id="ciSkillActive" class="ci-skill-active" style="display:none"></div>' +
  '<textarea id="chatInput" rows="3" data-i18n-ph="inputPlaceholder" placeholder="描述你要 Agent 完成的改动，Enter 发送 / Shift+Enter 换行；@ 引用文件，/ 唤起命令…" spellcheck="false"></textarea>' +
  '<div class="ci-bottom">' +
    '<div class="ci-left">' +
      '<button id="btnAttach" class="ci-tool" data-i18n-title="attachTip" title="添加附件（图片可直接粘贴 / 拖拽）">' + ico("plus") + "</button>" +
      '<div class="ci-skill-wrap">' +
        '<button id="btnSkillPick" class="ci-tool ci-skill-pick" data-i18n-title="pickSkillTip" title="引用一个 Skill 到本次对话">' + ico("sparkle") + "<span>Skill</span></button>" +
        '<div id="ciSkillPop" class="ci-skill-pop" style="display:none"></div>' +
      "</div>" +
      '<span class="ci-perm-wrap" data-i18n-title="permTip" title="权限档位决定 Agent 改盘 / 执行命令前是否要你点头">' +
        '<i class="ci-perm-ico" data-ico="shield"></i>' +
        '<select id="ciPerm" class="ci-perm">' +
          '<option value="ask" data-i18n="permOptAsk">每次问我</option>' +
          '<option value="semi" data-i18n="permOptSemi">半自动</option>' +
          '<option value="auto" data-i18n="permOptAuto">完全访问</option>' +
        "</select>" +
      "</span>" +
    "</div>" +
    '<div class="ci-right">' +
      '<div id="ctxBarWrap" class="ctx-ring" data-i18n-title="ctxUsage" title="上下文用量">' +
        '<svg viewBox="0 0 20 20" class="ctx-svg"><circle class="ctx-bg" cx="10" cy="10" r="7.6"/><circle class="ctx-fg" cx="10" cy="10" r="7.6"/></svg>' +
        '<span id="ctxPct">0%</span>' +
      "</div>" +
      '<div class="ci-model-wrap">' +
        '<button id="btnModelChip" class="ci-model" data-i18n-title="pickModelTip" title="选择模型"><i data-ico="layers"></i><span id="ciModelTxt" data-i18n="modelChip">模型</span><i data-ico="chevD"></i></button>' +
        '<div id="ciModelPop" class="ci-model-pop" style="display:none"></div>' +
      "</div>" +
      '<button id="btnSend" class="ci-send" data-i18n-title="sendTip" title="发送 (Enter)">' + ico("sendUp") + "</button>" +
    "</div>" +
  "</div>";

const terminal = document.createElement("div");
terminal.id = "terminal";
terminal.innerHTML =
  '<div id="termTabs" class="term-tabs"></div>' +
  '<div id="termLines"><div class="tl"><span class="tl-dim term-intro" id="termIntroLine">' + t("terminalIntro", { dir: state.project || "workspace" }) + '</span></div></div>' +
  '<div id="termInputRow"><span class="tl-prompt">user@pancode</span><span class="tl-dim">:</span><span class="tl-info" id="termCwd">~/workspace</span><span class="tl-dim">$&nbsp;</span><input id="termInput" spellcheck="false" autocomplete="off" data-i18n-ph="terminalInputPh" placeholder="输入命令，如 node tests/run-tests.js"><button id="termKill" data-i18n-title="interruptTip" title="中断当前命令 (Ctrl+C)">' + ico("stop") + "</button></div>";

function mountShared() {
  if (state.mode === "editor") {
    $("chatSlotEditor").appendChild(chatStream);
    $("chatSlotEditor").appendChild(msgNavRail);
    $("chatSlotEditor").appendChild(chatScrollBtns);
    $("chatInputEditor").appendChild(inputBox);
    $("terminalSlotEditor").appendChild(terminal);
  } else {
    $("chatSlotAgents").appendChild(chatStream);
    $("chatSlotAgents").appendChild(msgNavRail);
    $("chatSlotAgents").appendChild(chatScrollBtns);
    $("chatInputAgents").appendChild(inputBox);
    $("terminalSlotAgents").appendChild(terminal);
  }
  chatStream.scrollTop = chatStream.scrollHeight;
  buildMsgNav();
  updateScrollBtns();
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
    if (state.dirty.has(p)) return '<span class="ft-mod ft-dirty" title="' + escHtml(t("ftDirtyTip")) + '">●</span>';
    if (state.files[p] && state.files[p].isNew) return '<span class="ft-mod ft-new" title="' + escHtml(t("ftNewTip")) + '">U</span>';
    if (mod.has(p)) {
      const f = state.files[p];
      const st = diffStat(f.original || "", f.content || "");
      const tip = "已修改 +" + st.add + " −" + st.del + " 行（点击查看 Diff）";
      return '<span class="ft-change" data-path="' + esc(p) + '" title="' + tip + '">' +
        '<span class="ft-c-add">+' + st.add + '</span><span class="ft-c-del">−' + st.del + '</span></span>';
    }
    return "";
  };
  const mkItem = (path, depth) => {
    const el = document.createElement("div");
    const isMod = mod.has(path) && !state.dirty.has(path) && !(state.files[path] && state.files[path].isNew);
    el.className = "ft-item" + (state.activeFile === path ? " active" : "") + (isMod ? " has-change" : "");
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
  /* 点击变更 badge 直接查看 Diff */
  tree.querySelectorAll(".ft-change").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); showDiff(b.dataset.path); };
  });
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
        { key: "aiExplain", ic: "sparkle", label: t("apShowCtxMenulabelT1"), fn: () => aiFileAction(path, "请阅读并解释 @file:" + path + "，说明其功能、关键逻辑和设计思路。") },
        { key: "aiFix", ic: "sparkle", label: t("apShowCtxMenulabelT2"), fn: () => aiFileAction(path, "请检查并修复 @file:" + path + " 中的错误和问题。先运行测试确认问题，修复后再验证。") },
        { key: "aiTest", ic: "sparkle", label: t("apShowCtxMenulabelT3"), fn: () => aiFileAction(path, "请为 @file:" + path + " 生成单元测试，覆盖主要功能和边界情况。先查看项目中已有的测试风格并保持一致。") },
        { key: "aiRefactor", ic: "sparkle", label: t("apShowCtxMenulabelT4"), fn: () => aiFileAction(path, "请重构 @file:" + path + "，改善代码结构、可读性和可维护性，但不改变功能。改完跑测试验证。") },
        { key: "aiReview", ic: "sparkle", label: t("apShowCtxMenulabelT5"), fn: () => aiFileAction(path, "请对 @file:" + path + " 进行代码审查，指出潜在问题、改进建议和最佳实践。") },
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
    /* Monaco 主题跟随当前配色方案：从 CSS 变量实测取色，新增配色不必再改这里。
       （旧写法把 #0a0e13 这类色值硬编码进 Monaco，换主题后编辑器会和周围脱节。） */
    window.__pancodeMonacoTheme = function () {
      if (!window.monaco) return;
      const cs = getComputedStyle(document.documentElement);
      const v = (n, fb) => (cs.getPropertyValue(n) || "").trim() || fb;
      const bg = v("--bg", "#0b0e0d");
      const light = getTheme() === "light";
      monaco.editor.defineTheme("pancode", {
        base: light ? "vs" : "vs-dark", inherit: true, rules: [],
        colors: {
          "editor.background": bg,
          "editorGutter.background": bg,
          "minimap.background": bg,
          "editor.lineHighlightBackground": v("--bg3", "#161b1a"),
          "editorLineNumber.foreground": v("--text-dim", "#7f8c87"),
          "editorLineNumber.activeForeground": v("--accent-hi", "#3ddc91"),
          "editorCursor.foreground": v("--accent-hi", "#3ddc91"),
          "editor.selectionBackground": v("--sel", "#12362a"),
          "editorWidget.background": v("--bg2", "#111514"),
          "editorWidget.border": v("--border", "#242b29"),
          "editorSuggestWidget.background": v("--bg2", "#111514"),
          "editorSuggestWidget.selectedBackground": v("--active", "#202b28"),
          "diffEditor.insertedLineBackground": v("--cs-bg", "#0d2519") + "9e",
          "diffEditor.removedLineBackground": v("--err", "#fb7185") + "2e",
          "diffEditor.insertedTextBackground": v("--green", "#34d399") + "2e",
          "diffEditor.removedTextBackground": v("--err", "#fb7185") + "2e",
          "diffEditor.insertedTextBorder": v("--green", "#34d399") + "40",
          "diffEditor.removedTextBorder": v("--err", "#fb7185") + "40",
          "diffEditor.border": v("--border-strong", "#33403c"),
        },
      });
      monaco.editor.setTheme("pancode");
    };
    window.__pancodeMonacoTheme();
    const monacoTheme = () => "pancode";

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
          const filePath = uriToRelPath(model.uri);   // 见 utils.js：toString() 会给出 inmemory:/x.js，手拼 replace 匹配不上
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
        const filePath = uriToRelPath(model.uri);   // 见 utils.js：toString() 会给出 inmemory:/x.js，手拼 replace 匹配不上
        const lang = model.getLanguageId ? model.getLanguageId() : "plaintext";
        showBox(sel, selectedText, beforeText, afterText, filePath, lang);
      });
      function showBox(sel, selectedText, beforeText, afterText, filePath, lang) {
        if (box) { box.remove(); box = null; }
        box = document.createElement("div");
        box.id = "inlineEditBox";
        box.innerHTML =
          '<div class="ie-header"><span class="ie-title">' + t("apShowBoxH2") + '</span><span class="ie-close">×</span></div>' +
          '<input class="ie-input" placeholder="' + escHtml(t("ieInputPh")) + '" />' +
          '<div class="ie-actions"><button class="ie-btn ie-accept" disabled>' + t("apShowBoxH3") + '</button><button class="ie-btn ie-reject">' + t("apShowBoxH4") + '</button></div>' +
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
          title.textContent = t("apShowBoxtextContentT6");
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
            title.textContent = t("apShowBoxtextContentT7");
            input.disabled = false;
          } catch (e) { title.textContent = t("acSkillFormwbShowPreviewT42") + e.message.slice(0, 40); input.disabled = false; }
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
      $("sbCursor").textContent = t("sbCursor", { line: e.position.lineNumber, col: e.position.column });
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
    $("monacoHost").innerHTML = '<div id="monacoFallback">' + t("apCloseBoxH5") + '<br>' + t("apCloseBoxH6") + '</div>';
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

/* ---------- 后端接口指纹自检 ----------
   public/ 是每次请求从磁盘读的，/api/* 却是服务启动时 require 进去的：
   只刷新界面不重启服务时，新界面会去调旧进程里不存在的接口，设置里整片报「HTTP 404」。
   两侧常量成对维护（server/index.js 的 API_STAMP），改动 /api/* 路由时一起更新。 */
const API_STAMP = "2026.09.28.2";
let API_STALE = null;   // null=未测 / true=后端进程偏旧 / false=一致
async function checkApiStamp() {
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    API_STALE = h.apiStamp !== API_STAMP;
    if (API_STALE) toast(t("apSaveActiveFiletoastT120") + (h.apiStamp || t("apcheckApiStampC1")) + t("apcheckApiStampC2"));
  } catch (e) { /* 服务不可达时另有提示，这里不重复报警 */ }
}

/* ---------- 主题：明暗模式 × 配色方案 ---------- */

/* 配色库：mode 决定该方案属于深色还是浅色；选方案时模式自动跟随 */
const PALETTES = [
  { id: "graphite",  name: "石墨",   mode: "dark",  desc: t("apSaveActiveFiledescT10"), sw: ["#0b0e0d", "#1e8a5c", "#3ddc91", "#48c6ef"] },
  { id: "midnight",  name: "午夜",   mode: "dark",  desc: t("apSaveActiveFiledescT11"),     sw: ["#080b14", "#2f6fed", "#6ea8ff", "#38bdf8"] },
  { id: "amethyst",  name: "紫晶",   mode: "dark",  desc: t("apSaveActiveFiledescT12"),   sw: ["#0d0a14", "#7c4dbd", "#b98bf0", "#6fb7f0"] },
  { id: "whisky",    name: "威士忌", mode: "dark",  desc: t("apSaveActiveFiledescT13"),   sw: ["#100c08", "#a8641f", "#e0a050", "#6fb6c8"] },
  { id: "pine",      name: "松墨",   mode: "dark",  desc: t("apSaveActiveFiledescT14"),     sw: ["#080d0b", "#2c6e55", "#6fbf9a", "#5aa8b8"] },
  { id: "slate",     name: "岩灰",   mode: "dark",  desc: t("apSaveActiveFiledescT15"),       sw: ["#0d0d0e", "#5a6674", "#9fb0c2", "#7fa8c8"] },
  { id: "contrast",  name: "高对比", mode: "both",  desc: t("apSaveActiveFiledescT16"),   sw: ["#000000", "#2f7bff", "#ffd400", "#43e08a"] },
  { id: "celadon",   name: "青瓷",   mode: "light", desc: t("apSaveActiveFiledescT17"),   sw: ["#f6faf7", "#2f8a6a", "#1f7a5c", "#2b7f9e"] },
  { id: "parchment", name: "羊皮纸", mode: "light", desc: t("apSaveActiveFiledescT18"),     sw: ["#fbf7ef", "#9a6b30", "#7d5320", "#3f7a94"] },
  { id: "linen",     name: "亚麻",   mode: "light", desc: t("apSaveActiveFiledescT19"),   sw: ["#fafafa", "#4a6b8a", "#33566f", "#2f7ba8"] },
  { id: "rose",      name: "胭脂",   mode: "light", desc: t("apSaveActiveFiledescT20"),   sw: ["#fdf6f7", "#b05670", "#8e3d58", "#5f88a8"] },
];
/* 配色按明暗两侧分别记忆（cw-palette-dark / cw-palette-light）。
   以前深色方案在浅色模式下会被就地改写成该侧默认值并写回 localStorage，
   于是"选午夜 → 切浅色 → 切回深色"之后午夜就永久没了，用户看到的就是"配色跳回默认"。 */
function palSide(id) {
  const p = PALETTES.find((x) => x.id === id);
  return !p ? null : (p.mode === "both" ? null : p.mode);
}
function resolvedMode() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}
function getPalette(mode) {
  const m = mode || resolvedMode();
  const side = localStorage.getItem("cw-palette-" + m);
  if (side && (!palSide(side) || palSide(side) === m)) return side;
  const legacy = localStorage.getItem("cw-palette");       // 老字段：能配这一侧就继承
  if (legacy && (!palSide(legacy) || palSide(legacy) === m)) return legacy;
  return m === "light" ? "celadon" : "graphite";
}

function applyTheme(themePref) {
  const pref = (themePref === "auto" || themePref === "light" || themePref === "dark") ? themePref : "dark";
  const resolved = pref === "auto" ? getSystemTheme() : pref;
  const r = document.documentElement;
  r.setAttribute("data-theme", resolved);
  const pal = getPalette(resolved);
  r.setAttribute("data-palette", pal);
  localStorage.setItem("cw-theme", pref);
  const btn = $("btnTheme");
  if (btn) {
    btn.innerHTML = ico(resolved === "light" ? "moon" : "sun");
    const p = PALETTES.find((x) => x.id === pal);
    btn.title = t("apApplyThemetitleT121") + tr((p || {}).name || pal) + " · " + (pref === "auto" ? t("wbAppearancetT12") : t("apapplyThemeC3") + (resolved === "light" ? t("wbAppearancetT14") : t("wbAppearancetT13"))) + t("apapplyThemeC4");
  }
  const mt = window.__pancodeMonacoTheme;
  if (state.monacoReady && mt) mt();
  else if (state.monacoReady && editor) {
    editor.updateOptions({ theme: "pancode" });
    if (diffEditor) diffEditor.updateOptions({ theme: "pancode" });
  }
  document.dispatchEvent(new Event("pancode:theme"));
}

/* 换配色方案：写进该方案自己那一侧的记忆，再把明暗切过去（高对比两侧通用，不动明暗） */
function applyPalette(id) {
  const p = PALETTES.find((x) => x.id === id);
  if (!p) return;
  const cur = resolvedMode();
  const side = p.mode === "both" ? cur : p.mode;
  localStorage.setItem("cw-palette-" + side, id);
  localStorage.setItem("cw-palette", id);
  const next = p.mode === "both" ? cur : p.mode;
  applyTheme(getThemePref() === "auto" && next === getSystemTheme() ? "auto" : next);
}
$("btnTheme").onclick = () => applyTheme(getTheme() === "light" ? "dark" : "light"); /* 点击 = 显式接管 */

/* auto 档：系统主题变化时实时切换（Electron nativeTheme / 系统 OS 设置均会触发） */
try {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (getThemePref() === "auto") applyTheme("auto");
  });
} catch (e) { /* 旧环境无 matchMedia 时静默降级为手动档 */ }

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
    body.innerHTML = '<div class="bp-doc-loading">' + t("apShowBinPreviewH7") + '</div>';
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
  body.innerHTML = '<div class="bp-doc-loading">' + esc(path) + '<br><br>该文件是二进制文件（' + fmtSize(f.size) + '），暂不支持预览。<br>' + t("apShowBinPreviewH8") + '</div>';
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

/* 预览用的 Markdown 渲染器。
   ⚠ 段落分支必须至少吃掉一行（下面写成 do…while）：旧版是 while + 一个"块起始"停止条件，
   而那个条件比上面的分支表宽——`#标题`（井号后没空格）、`#`、`-- 不是分隔线` 这类行
   既不被任何分支接住，也不被段落吃掉，于是 i 永远不前进：整个渲染进程死循环，
   srcdoc 根本没机会赋值。用户看到的"预览面板一片空白、界面点不动"就是这个。
   语义按 CommonMark/GFM：井号后没空格就是普通文本，不猜它是标题。 */
const MD_HEAD = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const MD_FENCE = /^```/;
const MD_HR = /^(?:-{3,}|\*{3,}|_{3,})$/;
const MD_QUOTE = /^>[ \t]?(.*)$/;
const MD_UL = /^[ \t]*[-*+][ \t]+(.*)$/;
const MD_OL = /^[ \t]*\d+[.)][ \t]+(.*)$/;
const MD_TDEL = /^:?-{1,}:?$/;
function mdIsBlockStart(ln) {
  return MD_FENCE.test(ln) || MD_HEAD.test(ln) || MD_HR.test(ln.trim()) ||
    MD_QUOTE.test(ln) || MD_UL.test(ln) || MD_OL.test(ln);
}
/* GFM 表格行：去掉首尾竖线再切格 */
function mdCells(ln) {
  let s = ln.trim();
  if (s[0] === "|") s = s.slice(1);
  if (s[s.length - 1] === "|") s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
function mdIsDelim(ln) {
  const c = mdCells(ln);
  return c.length > 0 && ln.includes("-") && c.every((x) => MD_TDEL.test(x));
}
function mdAlign(cell) {
  const l = cell[0] === ":", r = cell[cell.length - 1] === ":";
  return l && r ? "center" : r ? "right" : "left";
}
function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  /* 行内代码要先摘出来存好：不这么做，`a*b*c` 里的星号会被后面的强调规则二次加工成 <i>。 */
  const inline = (t) => {
    const kept = [];
    let s = esc(t).replace(/`([^`]+)`/g, (m, c) => { kept.push("<code>" + c + "</code>"); return "\u0000" + (kept.length - 1) + "\u0000"; });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (m, k) => kept[+k]);
  };
  const lines = String(src == null ? "" : src).replace(/\r\n/g, "\n").split("\n");
  const out = []; let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.trim() === "") { i++; continue; }
    if (MD_FENCE.test(ln)) {
      const buf = []; i++;
      while (i < lines.length && !MD_FENCE.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++;
      out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>"); continue;
    }
    const h = ln.match(MD_HEAD);
    if (h) { const lv = h[1].length; out.push("<h" + lv + ">" + inline(h[2] || "") + "</h" + lv + ">"); i++; continue; }
    if (MD_HR.test(ln.trim())) { out.push("<hr>"); i++; continue; }
    if (MD_QUOTE.test(ln)) {
      const q = [];
      while (i < lines.length && MD_QUOTE.test(lines[i])) { q.push(lines[i].match(MD_QUOTE)[1]); i++; }
      out.push("<blockquote>" + inline(q.join("\n")).replace(/\n/g, "<br>") + "</blockquote>"); continue;
    }
    if (MD_UL.test(ln) || MD_OL.test(ln)) {
      const ord = MD_OL.test(ln); const re = ord ? MD_OL : MD_UL; const items = [];
      while (i < lines.length && re.test(lines[i])) { items.push("<li>" + inline(lines[i].match(re)[1]) + "</li>"); i++; }
      out.push("<" + (ord ? "ol" : "ul") + ">" + items.join("") + "</" + (ord ? "ol" : "ul") + ">"); continue;
    }
    if (ln.includes("|") && i + 1 < lines.length && mdIsDelim(lines[i + 1])) {
      const head = mdCells(ln);
      const al = mdCells(lines[i + 1]).map(mdAlign);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) { body.push(mdCells(lines[i])); i++; }
      const th = head.map((c, k) => '<th style="text-align:' + (al[k] || "left") + '">' + inline(c) + "</th>").join("");
      const td = body.map((r) => "<tr>" + head.map((_, k) =>
        '<td style="text-align:' + (al[k] || "left") + '">' + inline(r[k] || "") + "</td>").join("") + "</tr>").join("");
      out.push("<table><thead><tr>" + th + "</tr></thead>" + (td ? "<tbody>" + td + "</tbody>" : "") + "</table>");
      continue;
    }
    const para = [];
    do { para.push(lines[i]); i++; }
    while (i < lines.length && lines[i].trim() !== "" && !mdIsBlockStart(lines[i]));
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
    showConfirm(t("closeTerminalTab"), t("unsavedCloseMsg", { path: path }), () => _doCloseTab(path));
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
    const tab = document.createElement("div");
    tab.className = "tab" + (path === state.activeFile ? " active" : "");
    tab.draggable = true;
    tab.dataset.idx = idx;
    tab.innerHTML = fileIco(path) + "<span>" + esc(path.split("/").pop()) + "</span>" +
      (state.dirty.has(path) ? '<span class="tab-dot" title="' + escHtml(t("tabDirtyTip")) + '">●</span>' : "") +
      '<span class="tab-close">' + ico("close") + "</span>";
    tab.onclick = () => openFile(path);
    tab.querySelector(".tab-close").onclick = (e) => closeTab(path, e);
    tab.addEventListener("dragstart", (e) => { dragTabIdx = idx; e.dataTransfer.effectAllowed = "move"; tab.classList.add("dragging"); });
    tab.addEventListener("dragend", () => { tab.classList.remove("dragging"); bar.querySelectorAll(".tab").forEach(x => x.classList.remove("drag-over")); });
    tab.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    tab.addEventListener("dragenter", (e) => { e.preventDefault(); if (idx !== dragTabIdx) tab.classList.add("drag-over"); });
    tab.addEventListener("dragleave", () => tab.classList.remove("drag-over"));
    tab.addEventListener("drop", (e) => {
      e.preventDefault();
      tab.classList.remove("drag-over");
      if (dragTabIdx === null || dragTabIdx === idx) return;
      const moved = state.openTabs.splice(dragTabIdx, 1)[0];
      state.openTabs.splice(idx, 0, moved);
      dragTabIdx = null;
      renderTabs();
    });
    bar.appendChild(tab);
  });
}

function renderBreadcrumb() {
  const bc = $("breadcrumb");
  if (!state.activeFile) { bc.innerHTML = ""; return; }
  const parts = state.activeFile.split("/").map((s) => "<span>" + esc(s) + "</span>").join('<span class="bc-sep">›</span>');
  const prevBtn = isPreviewable(state.activeFile)
    ? '<button id="bcPreview" class="bc-preview' + (previewOn ? " active" : "") + '" data-i18n-title="togglePreviewTip" title="切换 HTML / Markdown 实时预览"><i data-ico="eye"></i><span data-i18n="preview">预览</span></button>'
    : "";
  bc.innerHTML = parts + prevBtn + '<button id="bcSave" class="bc-save" data-i18n-title="saveTip" title="保存 (Ctrl+S)">' + ico("save") + '<span data-i18n="save">保存</span></button>';
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
      $("semStatus").textContent = t("apSwitchSearchModetextContentT122") + (r.meta.count || 0) + t("aprefreshIndexStatusC5")
        + (r.meta.useVector ? " · 向量" : " · BM25")
        + (r.meta.builtAt ? " · " + new Date(r.meta.builtAt).toLocaleTimeString() : "");
      const b = $("btnBuildIndex"); if (b) { b.querySelector("span").textContent = t("rebuildIndex"); b.disabled = false; }
    } else {
      $("semStatus").textContent = t("apSwitchSearchModetextContentT23");
      const b = $("btnBuildIndex"); if (b) { b.querySelector("span").textContent = t("buildIndex"); b.disabled = false; }
    }
  } catch (e) { $("semStatus").textContent = ""; }
}

async function buildCodeIndex() {
  if (semBuilding) return;
  semBuilding = true;
  const b = $("btnBuildIndex"); if (b) b.disabled = true;
  $("semStatus").textContent = t("apSwitchSearchModetextContentT24");
  try {
    const r = await fetch("/api/index/build", { method: "POST" }).then((x) => x.json());
    if (r && r.ok) {
      $("semStatus").textContent = t("apSwitchSearchModetextContentT122") + (r.count || 0) + t("aprefreshIndexStatusC5") + (r.useVector ? t("apbuildCodeIndexC6") : " · BM25");
      if (b) b.querySelector("span").textContent = t("rebuildIndex");
    } else {
      $("semStatus").textContent = t("apSwitchSearchModetextContentT123") + ((r && r.error) || t("apbuildCodeIndexC7"));
    }
  } catch (e) {
    $("semStatus").textContent = t("apSwitchSearchModetextContentT123") + e.message;
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
  cnt.textContent = t("apRenderSemanticResultstextContentT124") + (r.mode || "bm25") + t("aprenderSemanticResultsC8") + (r.count || 0) + t("aprenderSemanticResultsC9");
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
  state.lastChangeTotals = {
    files: n,
    add: items.reduce((s, it) => s + (it.add || 0), 0),
    del: items.reduce((s, it) => s + (it.del || 0), 0),
  };
  if (typeof renderStepPill === "function") renderStepPill();
  if (typeof renderEnvPanel === "function") renderEnvPanel();
  $("scmHead").textContent = t("changesCount", { n });
  $("scmBadge").style.display = n ? "flex" : "none";
  $("scmBadge").textContent = n;
  $("sbChangesTxt").textContent = t("sbChanges", { n: n });
  $("agChangeCount").textContent = t("nFiles", { n: n });
  const scm = $("scmList"), ag = $("agChangedFiles");
  if (!n) {
    scm.innerHTML = '<div class="scm-empty">' + t("apRenderChangesH9") + '</div>';
    ag.innerHTML = '<div class="scm-empty">' + t("apRenderChangesH10") + '</div>';
    return;
  }
  scm.innerHTML = ""; ag.innerHTML = "";
  items.forEach((it) => {
    const st = ST_TXT[it.status] || "M";
    const stat = '<span class="stat-add">+' + it.add + '</span> <span class="stat-del">−' + it.del + "</span>";
    const rk = it.risk && it.risk !== "low"
      ? '<span class="risk-dot ' + it.risk + '" title="' + esc((it.riskReasons || []).join("\n") || t("riskFallback")) + '">' + (it.risk === "high" ? t("riskHigh") : t("riskMid")) + "</span>"
      : "";
    const item = document.createElement("div");
    item.className = "scm-item" + (it.risk && it.risk !== "low" ? " risk-" + it.risk : "");
    item.innerHTML = rk + fileIco(it.path) + " <span>" + esc(it.path.split("/").pop()) + '</span><span class="scm-stat">' + stat + '</span><span class="m st-' + st + '">' + st + "</span>";
    item.onclick = () => showDiff(it.path);
    scm.appendChild(item);

    const row = document.createElement("div");
    row.className = "agcf-item";
    row.innerHTML = '<div class="agcf-head"><span class="m st-' + st + '">' + st + '</span><span>' + esc(it.path) + '</span><span class="agcf-stat">' + stat + '</span><button class="agcf-btn">' + t("apRenderChangesH11") + '</button></div>';
    row.querySelector(".agcf-head").onclick = () => showDiff(it.path);
    ag.appendChild(row);
  });
}

/* ---------- W6 产物视图：卡片化交付物（点击复用 openFile 全预览链路） ---------- */
function renderArtifacts() {
  const host = $("agArtifacts");
  if (!host) return;
  const list = (state.convArtifacts || {})[convId] || [];
  const badge = $("agArtifactBadge");
  if (badge) { badge.textContent = list.length; badge.style.display = list.length ? "" : "none"; }
  if (!list.length) {
    host.innerHTML = '<div class="scm-empty">' + t("apRenderArtifactsH12") + '</div>';
    return;
  }
  host.innerHTML = "";
  list.forEach((it) => {
    const card = document.createElement("div");
    card.className = "af-card";
    card.title = it.path + "（点击预览）";
    card.innerHTML = '<span class="af-ico">' + fileIco(it.path) + '</span>'
      + '<span class="af-name">' + esc(it.path.split("/").pop()) + '</span>'
      + '<span class="af-kind">' + esc(it.label) + '</span>'
      + (it.isNew ? '<span class="af-new">' + t("apRenderArtifactsH13") + '</span>' : "");
    card.onclick = () => { try { openFile(it.path); } catch (e) {} };
    host.appendChild(card);
  });
}

function switchAgOutTab(tab) {
  const tc = $("agTabChanges"), ta = $("agTabArtifacts");
  if (tc) tc.classList.toggle("active", tab === "changes");
  if (ta) ta.classList.toggle("active", tab === "artifacts");
  const cf = $("agChangedFiles"), af = $("agArtifacts");
  if (cf) cf.style.display = tab === "changes" ? "" : "none";
  if (af) af.style.display = tab === "artifacts" ? "" : "none";
  if (tab === "artifacts") renderArtifacts();
}

/* 历史会话回看：切换会话时从服务端拉取产物清单 */
async function loadArtifactsHistory(id) {
  try {
    const d = await fetch("/api/artifacts?convId=" + encodeURIComponent(id)).then((x) => x.json());
    state.convArtifacts = state.convArtifacts || {};
    state.convArtifacts[id] = d.list || [];
    const ta = $("agTabArtifacts");
    if (ta && ta.classList.contains("active")) renderArtifacts();
  } catch (e) { /* 历史清单拉取失败静默，不影响会话切换 */ }
}

function showDiff(path) {
  if (!state.monacoReady || !state.files[path]) return;
  const f = state.files[path];
  $("diffModal").style.display = "flex";
  $("diffTitle").textContent = path + (f.isNew ? " — 新文件" : " — 相对基线的改动");
  if (diffEditor) diffEditor.dispose();
  diffEditor = monaco.editor.createDiffEditor($("diffHost"), {
    theme: "pancode", readOnly: true, automaticLayout: true, fontSize: 13,
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

/* ---------------- P-H3 · 撤销入口 ----------------
   引擎一直有写盘检查点（_snapshotBefore / _undoLast + shadow git），缺的就是用户手上的这颗按钮。
   三条规矩：
     · 只有"这一步真的推了检查点"的卡片才有按钮 —— undoable 由服务端按撤销栈的栈深差算，
       不在前端另写一份工具名字表（edit_files 整批一个检查点、只读工具一个都不推、
       被拒绝规则拦下时也不推，名字表一定会漂）；
     · 同一时刻只有每个会话最新的那一张可点 —— 撤销是后进先出的，
       旧卡片上的按钮点了会撤到别的步骤，那是意外不是功能；
     · 点下去之前先把"会动哪些文件、各自是改回原样还是删掉新建"摊出来确认。
   刷新页面后按钮不会重新出现：聊天记录能回放，撤销栈不能，
   与其在旧卡片上挂一个指向别处的按钮，不如不挂。 */
const undoCards = [];
function convOf(el) {
  const pane = el && el.closest ? el.closest(".conv-pane") : null;
  return (pane && pane.dataset.convId) || convId || "default";
}
function paintUndoBtns() {
  for (let i = undoCards.length - 1; i >= 0; i--) if (!undoCards[i].isConnected) undoCards.splice(i, 1);
  /* 先把全屏的按钮扫干净再重画：撤销掉的那张卡已经从 undoCards 里移走，
     只按名单清理会把那颗按钮留在原地 —— 点它就去撤别的步骤。 */
  document.querySelectorAll(".tool-card .t-undo").forEach((b) => b.remove());
  const seen = new Set();
  for (const card of undoCards) {
    if (seen.has(convOf(card))) continue;      // 每个会话只留自己最新的那一张
    seen.add(convOf(card));
    const head = card.querySelector(".tool-head");
    if (!head) continue;
    const b = document.createElement("button");
    b.className = "t-undo"; b.type = "button";
    b.title = t("apPaintUndoBtnstitleT28");
    b.setAttribute("aria-label", "撤销这一步");
    /* 只放图标：这一行右侧要挤下 轮次/耗时/结果/按钮 四样，带四个字的标签
       会把整行顶出卡片边界（实测溢出 37px），图标 + 悬停说明才放得下。 */
    b.innerHTML = ico("reset");
    b.onclick = (e) => { e.stopPropagation(); runUndo(card, b); };
    head.appendChild(b);
  }
}
async function runUndo(card, btn) {
  const cid = convOf(card);
  const st = await fetch("/api/undo").then((x) => x.json()).catch(() => ({ ok: false, steps: [] }));
  const top = (st.steps || [])[0];
  if (!st.ok) { toast(t("apPaintUndoBtnstoastT125") + (st.error || t("apbuildCodeIndexC7"))); return; }
  if (!top) { toast(t("apPaintUndoBtnstoastT126")); paintUndoBtns(); return; }
  if (top.convId && top.convId !== cid) { toast(t("apPaintUndoBtnstoastT127")); return; }
  const list = (top.files || []).map((f) => f.path + "（" + tr(f.action) + "）").join("、");
  if (!confirm(t("undoConfirmMsg", { label: tr(top.label), list }))) return;
  btn.disabled = true;
  const r = await fetch("/api/undo", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ convId: cid }),
  }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  btn.disabled = false;
  if (!r.ok) { toast(t("wbRootsGroupwbSavedT85") + (r.error || t("apbuildCodeIndexC7"))); return; }
  const tag = document.createElement("span");
  tag.className = "t-undone";
  tag.textContent = t("apPaintUndoBtnstextContentT29");
  tag.title = t("undoDoneTip", { n: (r.restored || []).length });
  const head = card.querySelector(".tool-head");
  if (head) head.appendChild(tag);
  card.classList.add("undone");
  const i = undoCards.indexOf(card);
  if (i >= 0) undoCards.splice(i, 1);
  paintUndoBtns();
  toast(t("apPaintUndoBtnstoastT128") + r.label + t("aprunUndoC10") + (r.restored || []).length + t("aprunUndoC11") + (r.left ? t("aprunUndoC12") + r.left + t("aprunUndoC13") : ""));
}
function scrollChat(force) {
  // Sticky scroll：用户上翻查看历史时不强制拉回底部；force=true 时无条件滚到底（新消息/审批/选项卡）
  // 网格模式下滚动容器是各会话 pane 自身（chatStream 不滚），滚"当前写入的那个"
  const box = (gridMode ? (convPanes[_boundConvId || convId] || chatStream) : chatStream);
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 80) {
    box.scrollTop = box.scrollHeight;
  }
  updateScrollBtns();
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
  /* 节点只记录用户输入消息；分布由 CSS space-evenly 均匀排列，不随消息实际位置 */
  const userMsgs = [];
  chatPane().querySelectorAll(":scope > .msg-user").forEach((el) => { userMsgs.push(el); });
  _hideNavPop();
  rail.innerHTML = "";
  if (!userMsgs.length) { rail.classList.remove("nav-visible"); return; }
  userMsgs.forEach((el) => {
    const dot = document.createElement("div");
    dot.className = "msg-nav-item user";
    /* 点击任意节点 → 弹出全部输入记录窗口，在窗口里点击具体条目跳转 */
    dot.onclick = (e) => {
      e.stopPropagation();
      if (_navPop && _navPop.classList.contains("show")) { _hideNavPop(); return; }
      _showNavPop(dot, userMsgs);
    };
    rail.appendChild(dot);
  });
  rail.classList.add("nav-visible"); /* 有输入记录时常驻显示 */
  updateMsgNavActive();
}
let _navPop = null;
/* 点击节点弹出的小窗口：列出本会话全部用户输入，点击条目跳转到对应消息 */
function _showNavPop(anchor, userMsgs) {
  if (!_navPop) {
    _navPop = document.createElement("div");
    _navPop.className = "msg-nav-pop";
    document.body.appendChild(_navPop);
  }
  _navPop.innerHTML =
    '<div class="mnp-head"><span class="mnp-role">' + t("ap_showNavPopH14") + '</span>' +
    '<span class="mnp-idx">' + userMsgs.length + " 条</span></div>" +
    '<div class="mnp-list"></div>';
  const listBox = _navPop.querySelector(".mnp-list");
  userMsgs.forEach((el, i) => {
    const item = document.createElement("div");
    item.className = "mnp-item";
    const no = document.createElement("span");
    no.className = "mnp-no";
    no.textContent = String(i + 1);
    const tx = document.createElement("span");
    tx.className = "mnp-txt";
    tx.textContent = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200) || "（空消息）";
    item.appendChild(no);
    item.appendChild(tx);
    item.onclick = (e) => {
      e.stopPropagation();
      _hideNavPop();
      chatStream.scrollTo({ top: el.offsetTop - 10, behavior: "smooth" });
      /* 跳转后目标消息短暂高亮，给出位置反馈 */
      el.classList.add("msg-jump-flash");
      setTimeout(() => el.classList.remove("msg-jump-flash"), 1400);
    };
    listBox.appendChild(item);
  });
  _navPop.classList.add("show");
  /* 定位：节点左侧、垂直居中；越界时钳回视口 */
  const r = anchor.getBoundingClientRect();
  const pw = _navPop.offsetWidth, ph = _navPop.offsetHeight;
  const top = Math.max(8, Math.min(r.top + r.height / 2 - ph / 2, window.innerHeight - ph - 8));
  const left = Math.max(8, r.left - pw - 10);
  _navPop.style.left = left + "px";
  _navPop.style.top = top + "px";
}
function _hideNavPop() { if (_navPop) _navPop.classList.remove("show"); }
/* 点击弹窗外部区域关闭 */
document.addEventListener("click", (e) => {
  if (_navPop && _navPop.classList.contains("show") && !_navPop.contains(e.target)) _hideNavPop();
});
function updateMsgNavActive() {
  const rail = msgNavRail;
  if (!rail || !rail.children.length) return;
  const scrollTop = chatStream.scrollTop;
  const viewH = chatStream.clientHeight;
  let activeIdx = -1;
  const dots = Array.from(rail.children);
  const userMsgs = [];
  chatPane().querySelectorAll(":scope > .msg-user").forEach((el) => { userMsgs.push(el); });
  for (let i = 0; i < userMsgs.length; i++) {
    if (userMsgs[i].offsetTop - 10 <= scrollTop + viewH * 0.3) activeIdx = i;
  }
  dots.forEach((d, i) => d.classList.toggle("active", i === activeIdx));
}
/* 只要内容可滚动就常驻显示快速按钮，不再依赖「滚动后 800ms 内」的临时可见 */
function updateScrollBtns() {
  const hasOverflow = chatStream.scrollHeight > chatStream.clientHeight + 40;
  chatScrollBtns.classList.toggle("csb-visible", hasOverflow);
  const btnTop = $("btnScrollTop"), btnBot = $("btnScrollBottom");
  if (btnTop) btnTop.style.display = "flex";
  if (btnBot) btnBot.style.display = "flex";
}
chatStream.addEventListener("scroll", () => {
  msgNavRail.classList.add("nav-visible");
  updateMsgNavActive();
  updateScrollBtns();
  _hideNavPop();
});
/* 按钮自身是容器，用 querySelector 取内层按钮（元素可能还在分离树上） */
chatScrollBtns.querySelector("#btnScrollTop").onclick = () => chatStream.scrollTo({ top: 0, behavior: "smooth" });
chatScrollBtns.querySelector("#btnScrollBottom").onclick = () => chatStream.scrollTo({ top: chatStream.scrollHeight, behavior: "smooth" });

/* 过程块（思考 / 工具步骤 / 审批 / 记忆卡）归进同一条 .step-flow 时间轴。
   竖线只由分组画一条：以前每张卡片各自 ::before + border-left，同一列上叠三四条线，
   既穿过状态图标，又在相邻行间错位成"多条线重叠遮挡"。
   用户消息、回答气泡、分隔线不进分组——它们天然切断一条时间轴。 */
function chatFlow(pane) {
  // 最终回答已出现时，后续过程块仍插在它前面，保证「过程在前、结论在最后」
  const anchor = answerBlock && answerBlock.row && answerBlock.row.parentNode === pane
    ? answerBlock.row : null;
  const last = anchor ? anchor.previousElementSibling : pane.lastElementChild;
  if (last && last.classList.contains("step-flow")) return last;
  const flow = document.createElement("div");
  flow.className = "step-flow";
  if (anchor) pane.insertBefore(flow, anchor); else pane.appendChild(flow);
  return flow;
}

/* ---------- W17 · 轮次收纳 ----------
   长任务动辄十几轮、每轮"思考 + N 张工具卡"，全部平铺在一条时间轴上就是"全部罗列"。
   现在按 Agent 轮次分组：每组头部一行摘要（R3 · 动词 目标 · N 步 · 时长），
   新一轮开始时自动折叠上一轮，当前轮保持展开；点击头部可重新展开。
   组的归属状态完全从 DOM 推导（最后一组 + data-round），会话切换/恢复零额外状态。 */
function finalizeRoundGrp(grp) {
  grp.classList.remove("live");
  const body = grp.querySelector(".rg-body");
  /* 含截图的轮组不自动折叠：截图是"用户想立刻看到的证据"，tool.image 特意不收进
     .tool-body（折叠卡里 display:none）就是为了它常显——轮组折叠会把这层设计整个
     推翻（shotui 探针抓的就是这个）。头部仍可手动收起。 */
  if (!body.querySelector(".tool-shots")) grp.classList.remove("open");
  const txt = (sel) => { const n = body.querySelector(sel); return n ? String(n.textContent || "").trim() : ""; };
  const label = (txt(".tool-card .t-name") + (txt(".tool-card .t-target") ? " " + txt(".tool-card .t-target") : ""))
    || txt(".think-block .tk-label");
  const dur = grp.dataset.t0 ? Math.max(1, Math.round((Date.now() - Number(grp.dataset.t0)) / 1000)) : 0;
  grp.querySelector(".rg-sum").textContent = (label.slice(0, 60) + " · " + body.children.length + " 步" + (dur ? " · " + dur + "s" : "")).replace(/^ · /, "");
}

function appendChatBlock(el, round) {
  const flow = chatFlow(chatPane());
  /* 同轮续接要找"flow 里最后一个轮组"而不是最后一个子节点：
     审批卡/记忆卡等无轮次卡片可能平铺插在两组之间，按 lastElementChild 判断
     会把同一轮拆成多个组（实测演示引擎一轮被拆成 5 组、摘要全空）。 */
  const grps = flow.querySelectorAll(".round-grp");
  const lastGrp = grps.length ? grps[grps.length - 1] : null;
  if (round != null && round > 0) {
    if (lastGrp && Number(lastGrp.dataset.round) === round) {
      lastGrp.querySelector(".rg-body").appendChild(el);          // 同轮续接
    } else {
      /* 新一轮：收起上一个仍展开的组。它可能在更早的 flow 段里（回答气泡会开新段），
         必须跨整个 pane 找 —— 限定在当前 flow 里找的话，旧段的组永远收不掉、摘要全空。 */
      const openGrps = chatPane().querySelectorAll(".round-grp.open");
      if (openGrps.length) finalizeRoundGrp(openGrps[openGrps.length - 1]);
      const grp = document.createElement("div");
      grp.className = "round-grp open live";
      grp.dataset.round = round;
      grp.dataset.t0 = String(Date.now());
      grp.innerHTML = '<div class="rg-head"><span class="rg-badge">R' + round + '</span><span class="rg-sum"></span><span class="chev">' + ico("chevR") + '</span></div><div class="rg-body"></div>';
      flow.appendChild(grp);
      grp.querySelector(".rg-body").appendChild(el);
    }
  } else if (lastGrp && lastGrp.classList.contains("open")) {
    // 无轮次号的过程块（审批卡等）跟在当前轮组里，不打断分组
    lastGrp.querySelector(".rg-body").appendChild(el);
  } else {
    flow.appendChild(el);   // 任务级卡片（结算/记忆）与旧数据：保持平铺
  }
  buildMsgNav();
  foldOldMessages();
}

/* 任务收尾：给最后一个仍展开的轮组填摘要并收起（否则它永远挂着呼吸点、摘要空白）。
   在 handleEvent 的事件上下文里调用 —— chatFlow(chatPane()) 已绑定到对应会话的 pane。 */
function finalizeOpenRoundGrp() {
  const openGrps = chatPane().querySelectorAll(".round-grp.open");
  const last = openGrps.length ? openGrps[openGrps.length - 1] : null;
  if (last) finalizeRoundGrp(last);
}

/* 长会话折叠：直接子消息超过阈值时，把最早的批次收入折叠容器（可展开），降低 DOM 渲染压力 */
const FOLD_THRESHOLD = 60, FOLD_BATCH = 30;
function foldOldMessages() {
  const pane = chatPane();
  const direct = pane.querySelectorAll(":scope > .msg-user, :scope > .msg-ai, :scope > .step-flow");
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
  container.querySelector(".fold-old-btn").textContent = t("apFoldOldMessagestextContentT129") + (n || body.children.length) + t("apfoldOldMessagesC14");
  buildMsgNav();
}
/* 折叠按钮事件委托：会话 dom 持久化恢复后按钮事件依然有效 */
chatStream.addEventListener("click", (e) => {
  const btn = e.target.closest(".fold-old-btn");
  if (btn) {
    const c = btn.closest(".fold-old");
    if (c) { c.classList.add("expanded"); btn.style.display = "none"; buildMsgNav(); }
    return;
  }
  /* 轮组/工具卡/思考块的头部长事件委托：会话 dom 是 innerHTML 序列化恢复的，
     逐元素挂的 onclick 在恢复后全部失联（折叠卡点不开是老问题），委托天然免疫。
     头部内嵌的按钮（撤销/批准等）不触发折叠。 */
  const head = e.target.closest(".rg-head, .tool-head, .think-head");
  if (head && !e.target.closest("button")) {
    const card = head.closest(".round-grp, .tool-card, .think-block");
    if (card) card.classList.toggle("open");
  }
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

/* W9 · Markdown 渲染 Worker 化：流式 msg.delta 的全量重渲染移入经典 Worker，主线程只做 DOM 写入。
   失败兜底：Worker 创建失败（如 Electron file:// 协议）/运行期 onerror → 同步 renderChatMD 回退（绝不白屏）。
   竞态防护：快照校验 b.buf === src —— buf 已前进则丢弃过期结果（msg.end 的同步最终渲染天然覆盖迟到结果）。 */
let _mdW = null, _mdWDead = false, _mdWSeq = 0, _mdTimer = null;
const _mdWCbs = new Map();
function _mdWorker() {
  if (_mdW || _mdWDead) return _mdW;
  try {
    _mdW = new Worker("js/md-worker.js");
    _mdW.onmessage = (e) => {
      const d = e.data || {}; const o = _mdWCbs.get(d.id);
      if (o) { _mdWCbs.delete(d.id); o.cb(typeof d.html === "string" ? d.html : renderChatMD(o.src)); }
    };
    _mdW.onerror = () => {
      _mdWDead = true; _mdWCbs.forEach((o) => o.cb(renderChatMD(o.src))); _mdWCbs.clear();
      try { _mdW.terminate(); } catch (e2) {} _mdW = null;
    };
  } catch (e) { _mdWDead = true; }
  return _mdW;
}
function renderChatMDAsync(src, cb) {
  const w = _mdWorker();
  if (!w) return cb(renderChatMD(src));   // Worker 不可用 → 同步回退（cb 恒有 html）
  const id = ++_mdWSeq;
  _mdWCbs.set(id, { src: src, cb: cb });
  try { w.postMessage({ id: id, src: src }); } catch (e) { _mdWCbs.delete(id); cb(renderChatMD(src)); }
}
function _mdRenderBlock(b) {
  if (_mdTimer) return;   // 节流：65ms 窗口内合并突发 delta，只调度一帧（触发时取最新 buf）
  _mdTimer = setTimeout(() => {
    _mdTimer = null;
    const src = b.buf;
    renderChatMDAsync(src, (html) => {
      if (b.buf !== src) return;   // buf 已前进：丢弃过期帧，下一帧渲染最新内容
      b.el.innerHTML = html; wireCopyButtons(b.el); scrollChat();
    });
  }, 65);
}

/* W9：msg.end 的最终渲染同样走 Worker —— 长回复在结束那一瞬同步全量重渲染，
   与打字期是同一个量级的卡顿，只是更显眼（用户正等着结果）。
   例外：含闭合 widget/svg/diagram 代码块的回复必须留在主线程，
   因为 renderWidgetCard 只存在于主线程（md-worker.js:44 的 typeof 守卫会退化成普通代码块）。
   宁可这类回复慢一次，也不要"为了不卡而降级成代码块"。 */
function _hasWidgetFence(src) {
  return /^```[ \t]*(widget|svg|diagram)[ \t]*$[\s\S]*?^```[ \t]*$/im.test(String(src || ""));
}
function renderChatMDFinal(src, done) {
  if (!src) return done("");
  if (_hasWidgetFence(src)) return done(renderChatMD(src));
  renderChatMDAsync(src, done);
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
      let closed = false;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      if (i < lines.length) { closed = true; i++; }
      // W5：闭合的 widget/svg/diagram 代码块 → 沙箱内联可视化（未闭合时流式期先按代码预览显示）
      if (closed && /^(widget|svg|diagram)$/i.test(lang) && typeof renderWidgetCard === "function") {
        html += renderWidgetCard(code.join("\n"), lang);
        continue;
      }
      html += '<div class="code-block"><div class="code-head"><span class="code-lang">' + esc(lang || "code") +
        '</span><button class="copy-btn" type="button">' + t("apRenderChatMDH15") + '</button></div><pre class="' + esc(lang) +
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
      const done = () => { const old = btn.textContent; btn.textContent = t("apWireCopyButtonstextContentT32"); setTimeout(() => (btn.textContent = old), 1200); };
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
  if (!has) { toast(t("apExportConversationtoastT130")); return; }
  const md = parts.join("\n");
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "pancode-conversation-" + Date.now() + ".md";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(t("apExportConversationtoastT131"));
}


function addMsgCopyBtn(el, text) {
  const btn = document.createElement("button");
  btn.className = "msg-copy";
  btn.innerHTML = ico("copy");
  btn.title = t("commitCopy");
  btn.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(text || el.textContent || "").then(() => toast(t("apWireCopyButtonstextContentT32"))); };
  el.appendChild(btn);
}

function addUserMsg(text, skill) {
  const el = document.createElement("div");
  el.className = "msg msg-user";
  el.textContent = text;
  /* 这一轮用了哪个 Skill：只在气泡上方挂一枚标记，正文不进消息。
     用户诉求是"用技能不需要在输入框输入或展示内容"——技能是能力，不是要发出去的话。 */
  if (skill) {
    const chip = document.createElement("span");
    chip.className = "msg-skill";
    chip.textContent = "✦ " + skill;
    chip.title = t("apAddUserMsgtitleT132") + skill + t("apaddUserMsgC15");
    el.insertBefore(chip, el.firstChild);
  }
  addMsgCopyBtn(el, text);
  chatPane().appendChild(el); scrollChat(true);
}


const KIND_ICO = { read: "read", edit: "edit", terminal: "terminal" };

/* 步骤流动词化：把裸工具名翻译成"人话"，对齐主流 agent 的 step 列表观感。
   verb = 流里显示的中文动作；ico = 左侧状态圆点之外的语义图标。 */
const STEP_META = {
  list_files:      { verb: "浏览目录", ico: "files" },
  read_file:       { verb: "读取文件", ico: "read" },
  write_file:      { verb: "写入文件", ico: "edit" },
  apply_edit:      { verb: "编辑文件", ico: "edit" },
  edit_files:      { verb: "批量编辑", ico: "edit" },
  delete_file:     { verb: "删除文件", ico: "trash" },
  search_code:     { verb: "搜索内容", ico: "search" },
  search_symbol:   { verb: "查找符号", ico: "compass" },
  repo_map:        { verb: "梳理仓库", ico: "toolbox" },
  run_command:     { verb: "终端命令", ico: "terminal" },
  get_diagnostics: { verb: "检查诊断", ico: "gauge" },
  undo:            { verb: "撤销改动", ico: "reset" },
  search_memory:   { verb: "回忆经验", ico: "memory" },
  save_session_memory: { verb: "沉淀记忆", ico: "save" },
  create_skill:    { verb: "提炼技能", ico: "sparkle" },
  use_skill:       { verb: "展开技能", ico: "layers" },
  create_plan:     { verb: "制定计划", ico: "tasklist" },
  update_plan:     { verb: "更新计划", ico: "tasklist" },
  set_goal:        { verb: "锁定目标", ico: "target" },
  goal_status:     { verb: "核对目标", ico: "target" },
  agent:           { verb: "派遣子 Agent", ico: "agent" },
  orchestrate:     { verb: "编排多 Agent", ico: "layers" },
  start_process:   { verb: "启动进程", ico: "play" },
  stop_process:    { verb: "停止进程", ico: "stopSq" },
  read_process:    { verb: "查看日志", ico: "pulse" },
  check_port:      { verb: "探测端口", ico: "gauge" },
  git_status:      { verb: "Git 状态", ico: "branch" },
  git_diff:        { verb: "Git 差异", ico: "diff" },
  git_log:         { verb: "Git 历史", ico: "history" },
  git_commit:      { verb: "Git 提交", ico: "branch" },
  /* git_branch 现在四种动作都有（含 P1-B2 补的 delete），动词不能再写"切换分支" */
  git_branch:      { verb: "分支操作", ico: "branch" },
  git_fetch:       { verb: "看清远端", ico: "eye" },
  git_pull:        { verb: "拉取更新", ico: "arrowDown" },
  git_push:        { verb: "推送远端", ico: "arrowUp" },
  git_stash:       { verb: "暂存改动", ico: "save" },
  git_blame:       { verb: "追查归属", ico: "history" },
  git_reset:       { verb: "回退提交", ico: "reset" },
  run_tests:       { verb: "跑测试", ico: "circleCheck" },
  find_references: { verb: "查波及面", ico: "search" },
  rename_symbol:   { verb: "跨文件改名", ico: "edit" },
  list_mcp:        { verb: "列出 MCP", ico: "toolbox" },
  web_search:      { verb: "联网搜索", ico: "search" },
  web_fetch:       { verb: "抓取网页", ico: "eye" },
  ask_user_choice: { verb: "请你选择", ico: "user" },
};
function stepMeta(name) { return STEP_META[name] || { verb: name || "执行", ico: "files" }; }
/* 步骤语义色标在工具图标上。以前每行画一条彩色竖线做区分，
   十几行连起来就是一列互相错位的发光条，压住状态图标也压住相邻卡片的边框。 */
function stepKindCls(name) {
  if (/^(write_file|apply_edit|edit_files|delete_file|undo|rename_symbol|git_commit|git_push|git_pull|git_reset|git_stash)$/.test(name)) return "k-edit";
  if (/^(run_command|run_tests|start_process|stop_process|read_process|check_port)$/.test(name)) return "k-terminal";
  if (/^(agent|orchestrate|set_goal|goal_status|create_plan|update_plan|ask_user_choice|use_skill|create_skill)$/.test(name)) return "k-flow";
  return "k-read";
}
function fmtDur(ms) {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m" + String(Math.round((ms % 60000) / 1000)).padStart(2, "0") + "s";
}

function applyEngineInfo(info) {
  state.engine = info;
  const label = info.mode === "llm" ? info.model : t("engineDemo");
  $("cpModelEditor").textContent = label;
  $("cpModelEditor").title = label;
  $("cpModelAgents").textContent = label + " · " + t("agentModeLabel");
  $("cpModelAgents").title = label;
  $("btnSettings").classList.toggle("llm-on", info.mode === "llm");
  const chip = document.querySelector("#ciModelTxt");
  if (chip) chip.textContent = label.length > 22 ? label.slice(0, 21) + "…" : label;
  const chipBtn = document.querySelector("#btnModelChip");
  if (chipBtn) chipBtn.classList.toggle("demo", info.mode !== "llm");
  if (typeof renderEnvPanel === "function") renderEnvPanel();
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


/* 等待倒计时：卡片上写明"多久不处理就自动放弃"并把剩余时间走成秒表。
   「任务卡住了」里相当一部分其实是审批卡在等人，而状态栏只显示"AI 思考中"——
   把等待事实摆到界面上，用户才知道该点的是自己。 */
function waitCountdown(sec) {
  const span = document.createElement("span");
  span.className = "ap-wait";
  const t0 = Date.now();
  let iv = null;
  const stop = () => { if (iv) { clearInterval(iv); iv = null; } };
  const tick = () => {
    const left = sec - Math.floor((Date.now() - t0) / 1000);
    if (left <= 0) { stop(); span.textContent = t("apWaitCountdowntextContentT34"); return; }
    span.textContent = t("apWaitCountdowntextContentT133") + fmtDur(left * 1000);
    if (left <= 120) span.classList.add("soon");
  };
  tick();
  iv = setInterval(tick, 1000);
  return { el: span, stop };
}

/* 人工确认卡片：写文件 / 删文件 / 执行命令 需用户批准或拒绝 */
const APPROVE_META = {
  write_file:  { label: t("apWaitCountdownlabelT36"),   ico: "edit",     kindCls: "k-edit" },
  delete_file: { label: t("apWaitCountdownlabelT37"),   ico: "trash",    kindCls: "k-edit" },
  run_command: { label: t("apWaitCountdownlabelT38"), ico: "terminal", kindCls: "k-terminal" },
  /* P1-B2 / P1-B3 新增的要确认的工具。卡片标题写"git_push"这种名字等于把决定权
     推给用户去看文档——标签必须是动词，且把真正执行的那条命令/分支显示出来。 */
  run_tests:   { label: t("apWaitCountdownlabelT39"),   ico: "circleCheck", kindCls: "k-terminal" },
  git_push:    { label: t("apWaitCountdownlabelT40"), ico: "arrowUp",  kindCls: "k-edit" },
  git_pull:    { label: t("apWaitCountdownlabelT41"), ico: "arrowDown", kindCls: "k-edit" },
  git_reset:   { label: t("apWaitCountdownlabelT42"), ico: "reset",    kindCls: "k-edit" },
  git_stash:   { label: t("apWaitCountdownlabelT43"), ico: "save",     kindCls: "k-edit" },
  git_branch:  { label: t("apWaitCountdownlabelT44"), ico: "branch",   kindCls: "k-edit" },
  git_commit:  { label: t("apWaitCountdownlabelT45"), ico: "branch",   kindCls: "k-edit" },
};
function renderApproval(ev) {
  const m = APPROVE_META[ev.tool] || { label: ev.tool, ico: "files", kindCls: "" };
  const danger = ev.danger === "high"
    ? { t: t("highRisk"), c: "danger-high" }
    : ev.danger === "medium"
      ? { t: t("midRisk"), c: "danger-mid" }
      : { t: t("lowRisk"), c: "danger-low" };
  let pv = "";
  if (ev.tool === "write_file" && ev.preview) {
    pv = '<div class="ap-meta">' + t("apRenderApprovalH16") + '<span class="ap-path">' + esc(ev.preview.path) + "</span> · 共 " + esc(ev.preview.lines) + " 行</div>" +
         '<pre class="ap-pre">' + esc(ev.preview.preview) + "</pre>";
  } else if (ev.preview && ev.preview.command) {
    /* run_command / run_tests / git 工作流工具都走这一支：卡片上显示真正会执行的那条串。
       以前只认 run_command，于是"推送远端"的卡片上什么细节都没有，用户只能盲点批准。 */
    pv = '<div class="ap-meta">' + t("apRenderApprovalH17") + '</div><pre class="ap-pre">' + esc(ev.preview.command) + "</pre>";
  } else if (ev.preview && ev.preview.path) {
    pv = '<div class="ap-meta">' + t("apRenderApprovalH16") + '<span class="ap-path">' + esc(ev.preview.path) + "</span></div>";
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
      (ev.tool !== "delete_file" ? '<button class="btn-approve-session" data-id="' + esc(ev.id) + '" title="' + escHtml(t("approveSessionTip", { tool: ev.tool || "" })) + '">' + ico("shield") + " " + t("approveSessionBtn") + "</button>" : "") +
      '<button class="btn-reject" data-id="' + esc(ev.id) + '">' + ico("close") + " 拒绝</button>" +
    "</div>";
  appendChatBlock(el, ev.round); scrollChat(true);
  blocks["ap_" + ev.id] = { el };   // 服务端超时自动拒绝时通过合成 tool.end 收尾
  const statusEl = el.querySelector(".t-status");
  let cdStop = null;
  if (ev.timeoutSec) {
    const w = waitCountdown(ev.timeoutSec);
    el.querySelector(".approval-actions").insertBefore(w.el, el.querySelector(".btn-approve"));
    cdStop = w.stop;
  }
  const lock = () => { el.querySelectorAll(".approval-actions button").forEach((b) => (b.disabled = true)); if (cdStop) cdStop(); };
  el.querySelector(".btn-approve").onclick = () => {
    send({ type: "tool.approve", id: ev.id });
    statusEl.className = "t-status done";
    statusEl.innerHTML = ico("check") + " 已批准";
    lock();
  };
  const sesBtn = el.querySelector(".btn-approve-session");
  if (sesBtn) sesBtn.onclick = () => {
    send({ type: "tool.approve", id: ev.id, remember: "session", tool: ev.tool });
    statusEl.className = "t-status done";
    statusEl.innerHTML = ico("shield") + " 本会话已授权 " + (ev.tool || "");
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
    '<div class="tool-head"><span class="t-kind">' + ico("sparkle") + '</span><span class="t-name">' + t("apRenderChoiceH18") + '</span>' +
      '<span class="t-target">' + esc((ev.question || "").slice(0, 60)) + '</span>' +
      '<span class="t-status pending">' + t("apRenderChoiceH19") + '</span></div>' +
    '<div class="tool-body choice-body">' +
      '<div class="choice-question">' + esc(ev.question || "") + '</div>' +
      '<div class="choice-list">' + opts.map((o, i) =>
        '<button class="choice-opt" data-idx="' + i + '">' +
          '<span class="choice-opt-label">' + esc(o.label || "") + '</span>' +
          (o.description ? '<span class="choice-opt-desc">' + esc(o.description) + '</span>' : '') +
        '</button>'
      ).join("") + '</div>' +
    '</div>';
  appendChatBlock(el, ev.round); scrollChat(true);
  blocks["choice_" + ev.id] = { el };   // 服务端超时/取消时通过合成 tool.end 收尾
  const statusEl = el.querySelector(".t-status");
  let cdStop = null;
  if (ev.timeoutSec) {
    const w = waitCountdown(ev.timeoutSec);
    el.querySelector(".choice-body").appendChild(w.el);
    cdStop = w.stop;
  }
  el.querySelectorAll(".choice-opt").forEach((btn) => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const choice = opts[idx] ? opts[idx].label : "";
      send({ type: "tool.choice_result", id: ev.id, choice });
      statusEl.className = "t-status done";
      statusEl.innerHTML = ico("check") + " 已选择: " + esc(choice);
      if (cdStop) cdStop();
      el.querySelectorAll(".choice-opt").forEach((b) => { b.disabled = true; b.classList.toggle("selected", b === btn); });
    };
  });
}

/* 取回一张会话截图，交回可用的 objectURL。
   为什么绕一圈 fetch 而不是直接给 img.src：/api/* 全部过登录闸门，令牌由 patchFetch
   注进请求头（C-B2 之后不再认 query string），而 <img src> 那条路压根没有请求头可带 ——
   直接写 src 就是一律 401，卡片上永远是一片空白。
   不放宽 /api/shot 的鉴权：屏幕截图里可能正好开着密码管理器。 */
async function shotBlobUrl(name) {
  const r = await fetch("/api/shot?name=" + encodeURIComponent(name));
  if (!r.ok) throw new Error("HTTP " + r.status);
  return URL.createObjectURL(await r.blob());
}

function handleEvent(ev) {
  /* 多会话并行：聊天 DOM 类消息按 convId 写入对应会话的 pane（后台会话实时可见），
     其余消息（文件/终端/计划/编排等全局 UI）直接分发 */
  const CHAT_DOM_TYPES = new Set(["user.msg", "think.start", "think.delta", "think.end", "msg.start", "msg.delta", "msg.end", "tool.start", "tool.body", "tool.image", "tool.end", "tool.ask_choice", "agent.error"]);
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
      if (ev.workspace) $("btnOpenFolder").title = t("wsOpenTip", { ws: ev.workspace });
      const cwd = $("termCwd"); if (cwd) cwd.textContent = "~/" + state.project;
      if (ev.tabs) initTermTabs(ev.tabs);   // 还原多标签终端（同一服务进程内刷新可恢复）
      if (ev.truncated) termLine('<span class="tl-warn">' + t("apHandleEventInnerH20") + '</span>');
      if (ev.git) { state.noGit = !ev.git.git; state.branchName = ev.git.branch || ""; $("sbBranch").textContent = ev.git.git ? ev.git.branch : t("noGitBaseline"); }
      if (ev.engine) applyEngineInfo(ev.engine);
      if (ev.agent) applyAgentSettings(ev.agent);
      if (typeof wireEnvPanel === "function") wireEnvPanel();
      if (typeof renderEnvPanel === "function") setTimeout(renderEnvPanel, 0);
      if (ev.lsp) state.lsp = ev.lsp;
      syncFiles(ev.files);
      setRunning(ev.running, null);
      if (!state.booted) {
        state.booted = true;
        refreshCtx();   // 上下文条从会话开始即实时可见
        /* 欢迎信息已移除：空对话不再自动输出内容（welcome() 保留在 settings.js 备用） */
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
    case "agent.state": setRunning(ev.running, ev.label, ev.convId, ev.labelKey, ev.labelVars); break;
    case "agent.backoff": {
      /* 修 E-M2：限流退避原先只有工具栏一行静态文字。倒计时浮层必须是"当前会话"才弹 ——
         后台会话在限流，不该在正看着的会话里弹一个不相干的倒计时。 */
      if (ev.done) { if (typeof toastHoldHide === "function") toastHoldHide(); break; }
      const isCur = !ev.convId || ev.convId === convId;
      if (isCur && typeof toastCountdown === "function") {
        toastCountdown(ev.waitSec, t("rateLimitToast", { a: ev.attempt, n: ev.maxAttempts }));
      }
      break;
    }
    case "agent.budget": {
      /* P1-8：轮次预算预警。限流浮层会自己走完归零就消失，预算这条不一样 ——
         它不会自己消失（任务还在跑），所以用普通 toast：短、不挡正文、也不假装还要倒计时。 */
      if ((!ev.convId || ev.convId === convId) && typeof toast === "function") {
        toast(t("apHandleEventInnertoastT134") + Math.round((ev.rounds / ev.max) * 100) + "%（" + ev.rounds + "/" + ev.max + t("aphandleEventInnerC16") + ev.left + t("aphandleEventInnerC17"));
      }
      break;
    }
    case "user.msg": {
      // 新任务开始：重置聚合状态 + 加一条分隔线，让多次任务清晰分段
      answerBlock = null; thinkCount = 0; lastThink = null;
      const sep = document.createElement("div");
      sep.className = "run-sep";
      chatPane().appendChild(sep);
      addUserMsg(ev.text, ev.skill);
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
      toast(t("wbWtAddRowwbInputT119") + ev.path);
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
      appendChatBlock(el, ev.round); scrollChat();
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
      // 折叠态也留一行思路摘要：主流 agent 的 step 列表是"动词 + 一句人话"，
      // 只显示"思考 · 1s"用户无从判断 Agent 到底想通了什么。
      const snippet = (b.buf || "").replace(/\s+/g, " ").trim().slice(0, 46);
      b.el.querySelector(".tk-label").textContent = t("apHandleEventInnertextContentT135") + (snippet ? " · " + snippet + (b.buf.trim().length > 46 ? "…" : "") : "")
        + (dur ? "（" + dur + "s）" : "");
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
      b.buf += ev.text; b.el.classList.add("type-caret"); _mdRenderBlock(b);   // W9: Worker 化 + 节流
      break;
    }
    case "msg.end": {
      const b = blocks[ev.id]; if (!b) break;
      if (_mdTimer) { clearTimeout(_mdTimer); _mdTimer = null; }
      b.el.classList.remove("type-caret");
      // W9：最终渲染也走 Worker（widget 类回复除外，见 renderChatMDFinal 注释）
      let finished = false;
      const finish = (html) => {
        if (finished) return; finished = true;
        b.el.innerHTML = html; wireCopyButtons(b.el);
        // 给 AI 回复加「复制全部」按钮（气泡在流式渲染中会被 innerHTML 覆盖，故在结束时挂载）
        const row = b.el.closest(".msg-row");
        if (row && !row.querySelector(".msg-copy")) {
          const full = htmlToMarkdown(b.el).trim() || b.el.textContent.trim();
          addMsgCopyBtn(row, full);
        }
        scrollChat();
        send({ type: "ctx.query" });   // 回答结束拉一次服务端实测水位，校正圆圈进度
      };
      if (b.buf) renderChatMDFinal(b.buf, finish);
      else finish("");
      break;
    }

    case "tool.start": {
      // 工具调用一旦开始，之前那段话就是"过程叙述"，应当独立成泡；
      // 否则叙述与最终回答会被跨轮聚合成同一个气泡，读起来像被截断的句子。
      answerBlock = null;
      const el = document.createElement("div");
      el.className = "tool-card step " + stepKindCls(ev.name || "");
      const meta = stepMeta(ev.name);
      const roundBadge = ev.round ? '<span class="t-round">R' + ev.round + '</span>' : '';
      el.innerHTML = '<div class="tool-head">' +
        '<span class="t-state run">' + ico("circleDot") + '</span>' +
        '<span class="t-kind">' + ico(meta.ico) + '</span>' +
        '<span class="t-name">' + esc(meta.verb) + '</span>' +
        '<span class="t-target"><code>' + esc(ev.target || "") + "</code></span>" +
        roundBadge +
        '<span class="t-dur"></span>' +
        '<span class="t-status running">' + t("apHandleEventInnerH21") + '</span></div><div class="tool-body"></div>';
      appendChatBlock(el, ev.round); scrollChat();
      blocks[ev.id] = { el, name: ev.name, startTime: Date.now() };
      bumpStepProgress(ev.name, ev.convId);
      // 实时进度：状态栏显示当前轮次 + 工具名
      const liveTxt = $("agLiveTxt");
      if (liveTxt && ev.round) liveTxt.textContent = t("apHandleEventInnertextContentT136") + ev.round + t("aphandleEventInnerC18") + meta.verb;
      const sbTxt = $("sbAgentTxt");
      if (sbTxt && ev.round) sbTxt.textContent = "R" + ev.round + " · " + meta.verb;

      break;
    }
    case "tool.body": {
      const b = blocks[ev.id]; if (!b) break;
      b.el.querySelector(".tool-body").innerHTML = colorizeDiffText(ev.text);
      break;
    }
    case "tool.image": {
      /* 截图直接挂在卡片上，不塞进 .tool-body —— 未展开的卡片里 .tool-body 是 display:none，
         而这张图正是"用户想立刻看到的证据"，藏在折叠态里等于没有。 */
      const b = blocks[ev.id]; if (!b || !ev.path) break;
      let box = b.el.querySelector(".tool-shots");
      if (!box) { box = document.createElement("div"); box.className = "tool-shots"; b.el.appendChild(box); }
      const img = document.createElement("img");
      img.className = "t-shot";
      img.alt = "";
      const label = String(ev.path).split("/").pop();
      img.title = label + "（点击放大 / 缩回）";
      img.onclick = () => b.el.classList.toggle("shotwide");
      box.appendChild(img);
      /* 不能用 <img src="/api/shot?..."> 直连：/api/* 全走登录闸门，而 C-B2 之后令牌只认请求头，
         <img> 带不上 x-user-token —— 直接给 src 就是 401，界面上一张图都出不来。
         先按登录态 fetch 成 blob，再把 objectURL 交给 <img>。鉴权一点不放宽：
         屏幕截图里可能正好开着密码管理器。 */
      shotBlobUrl(ev.path).then((url) => { img.src = url; },
        () => { img.className = "t-shot t-shot-missing"; img.title = label + "（未能载入：截图可能已被清理，或登录态已过期）"; });
      scrollChat();
      break;
    }
    case "tool.end": {
      const b = blocks[ev.id]; if (!b) break;
      const dur = b.startTime ? Date.now() - b.startTime : 0;
      const s = b.el.querySelector(".t-status");
      s.className = "t-status " + (ev.ok ? "done" : "fail");
      s.textContent = tr(ev.label) || (ev.ok ? t("doneTag") : t("failTag"));
      const st = b.el.querySelector(".t-state");
      if (st) { st.className = "t-state " + (ev.ok ? "ok" : "fail"); st.innerHTML = ico(ev.ok ? "circleCheck" : "circleX"); }
      const d = b.el.querySelector(".t-dur");
      if (d) d.textContent = fmtDur(dur);
      if (ev.open) b.el.classList.add("open");
      /* 服务端按"这一步有没有真的把检查点压进撤销栈"给这个旗标，卡片于是自己知道该不该长按钮 */
      if (ev.undoable) { undoCards.push(b.el); paintUndoBtns(); }
      stepProgressDone(ev.ok, ev.convId);
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
      if (ev.risk) { state.riskSummary = ev.risk; if (typeof renderEnvPanel === "function") renderEnvPanel(); }
      if (!ev.convId || ev.convId === convId) renderChanges(ev.list);

      break;
    }

    /* ----- W6 产物：会话交付物清单（可预览文件卡片） ----- */
    case "artifacts": {
      state.convArtifacts = state.convArtifacts || {};
      state.convArtifacts[ev.convId] = ev.list || [];
      if (!ev.convId || ev.convId === convId) renderArtifacts();
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
      toast(cl ? t("apHandleEventInnertoastT137") + (ev.paths || []).length + t("aphandleEventInnerC19") + cl + t("aphandleEventInnerC20") : t("apHandleEventInnertoastT137") + (ev.paths || []).length + t("aphandleEventInnerC21"));
      break;
    }
    case "patch.rejected": {
      if (!state.patch) break;
      const set = new Set(ev.paths || []);
      state.patch.files = state.patch.files.filter((f) => !set.has(f.path));
      if (!state.patch.files.length) closePatchModal();
      else { renderPatchList(); renderPatchDiff(state.patch.files[0].path); }
      toast(ev.all ? t("apHandleEventInnertoastT138") : t("aphandleEventInnerC1") + (ev.paths || []).length + t("aphandleEventInnerC21"));
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
      finalizeOpenRoundGrp();   // W22：任务收尾给最后的轮组填摘要（呼吸点停掉）
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
    case "system.perf": onSystemPerf(ev); break;
    case "mcp.servers": if (typeof window.onMcpServers === "function") window.onMcpServers(ev.servers); break;
    case "context.usage": updateCtxBar(ev.used, ev.budget, ev.est); break;
    case "context.compact": renderCompactCard(ev); break;
    case "context.compact_breaker": {
      /* 自动摘要连续压不动会停手。这条只写在 AI 终端里等于没说 —— 终端默认是收起的，
         而"上下文不再自动压了、下次超限会真丢原文"必须让用户当场知道。
         服务端保证一次会话只发一条，所以这里可以直接用会自己消失的 toast。 */
      if (typeof toast === "function") {
        toast(t("apHandleEventInnertoastT139"));
      }
      break;
    }
    case "memory.recall": renderRecallCard(ev); break;
    case "goal.set": {
      if (ev.goal) { goalMode = true; goalText = ev.goal; const b = $("btnGoal"); if (b) b.classList.add("active"); }
      else if (typeof setGoalMode === "function") setGoalMode(false);
      break;
    }
    case "goal.continue": {
      if (typeof renderGoalBanner === "function") {
        renderGoalBanner(ico("target") + '<span class="gb-txt">' + t("apHandleEventInnerH22") + '</span><b>' + esc((goalText || ev.reason || "").slice(0, 56)) + "</b>"
          + '<span class="gb-turn">第 ' + ev.turn + " / " + ev.max + " 轮</span>"
          + '<span class="gb-why">' + esc(String(ev.reason || "").slice(0, 70)) + "</span>"
          + '<button class="gb-stop" id="gbStop">' + t("apHandleEventInnerH23") + '</button>');
        const s = $("gbStop"); if (s) s.onclick = stopGoal;
      }
      break;
    }
    case "goal.settled":
      if (typeof setGoalMode === "function") setGoalMode(false);
      toast(t("goalTurns", { n: ev.turns }));
      break;
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
  setAgentModeUI(a.agentMode || "agent");
}
/* 三模式 UI：输入栏不再常驻三个按钮（太挤），只在非默认模式时挂一枚小徽标，
   避免用户切到 Plan/Ask 后不明白 Agent 为什么不动文件。切换入口在命令面板与设置。 */
function setAgentModeUI(mode) {
  state.agentMode = mode;
  state.planMode = (mode === "plan");
  const left = inputBox.querySelector(".ci-left");
  if (!left) return;
  let badge = inputBox.querySelector("#ciModeBadge");
  if (mode !== "agent") {
    if (!badge) {
      badge = document.createElement("span");
      badge.id = "ciModeBadge";
      badge.className = "ci-mode-badge";
      left.insertBefore(badge, inputBox.querySelector(".ci-perm-wrap"));
    }
    badge.textContent = mode === "plan" ? t("modeBadgePlan") : t("modeBadgeAsk");
    badge.title = mode === "plan" ? t("modeBadgePlanTip") : t("modeBadgeAskTip");
  } else if (badge) badge.remove();
}

/* ---------------- 模型下拉（输入栏直接选，不再跳设置） ---------------- */
/* 只列接口真实返回的模型：以前拉不到就塞一份内置假模型清单，用户选了个当前服务根本没有的
   模型，报错还报在别处，排查成本全压在用户身上。 */
let MODEL_CACHE = null;      // { models:[id…], at:ts, error:"" }
/* 设置里改了地址/存了新配置，下拉不能再拿 5 分钟前的缓存——否则会列出上一个服务的模型。 */
function invalidateModelCache() { MODEL_CACHE = null; }
async function fetchModels(force) {
  if (!force && MODEL_CACHE && Date.now() - MODEL_CACHE.at < 5 * 60 * 1000) return MODEL_CACHE;
  let r;
  try { r = await fetch("/api/models").then((x) => x.json()); } catch (e) { r = { ok: false, error: e.message }; }
  const ids = Array.isArray(r && r.models) ? r.models.filter(Boolean) : [];
  MODEL_CACHE = {
    models: ids.length ? ids.slice().sort() : [],
    at: ids.length ? Date.now() : 0,
    error: ids.length ? "" : String((r && r.error) || "接口没有返回模型列表"),
  };
  return MODEL_CACHE;
}
function wireModelPicker() {
  const chip = inputBox.querySelector("#btnModelChip");
  const pop = inputBox.querySelector("#ciModelPop");
  if (!chip || !pop) return;
  const close = () => { pop.style.display = "none"; };
  const paint = (info, loading) => {
    const cur = (state.engine && state.engine.model) || "";
    const list = info.models || [];
    pop.innerHTML =
      '<div class="cmp-head"><span>' + t("apWireModelPickerH24") + '</span>' +
        '<button type="button" class="cmp-refresh" title="' + escHtml(t("cmpRefreshTip")) + '">' + ico("reset") + "</button></div>" +
      (loading ? '<div class="cmp-loading">' + t("apWireModelPickerH25") + '</div>'
        : list.length
          ? '<div class="cmp-list">' + list.map((m) =>
              '<button type="button" class="cmp-item' + (m === cur ? " on" : "") + '" data-m="' + esc(m) + '">' +
                '<i data-ico="' + (m === cur ? "circleCheck" : "dot") + '"></i><span>' + esc(m) + "</span></button>").join("") + "</div>"
          : '<div class="cmp-empty">' + esc(info.error || "还没取到模型列表") +
            "<br>可在「设置 → 模型」里填接口地址与 API Key，或直接在这里输入模型 ID。</div>" +
            '<input class="cmp-manual" placeholder="' + escHtml(t("cmpManualPh")) + '" value="">') +
      '<div class="cmp-foot"><span class="cmp-src">' +
        (list.length ? "来自当前接口的 /models（" + list.length + " 个）" : "未取到模型列表") +
        '</span><button type="button" class="cmp-gear">' + ico("gear") + " 模型设置…</button></div>";
    replaceIcons(pop);
    pop.querySelector(".cmp-refresh").onclick = async (e) => {
      e.stopPropagation();
      paint({ models: [], error: "" }, true);
      paint(await fetchModels(true));
    };
    pop.querySelectorAll(".cmp-item").forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const id = b.dataset.m;
        b.classList.add("busy");
        const ok2 = await applyModel(id);
        b.classList.remove("busy");
        if (ok2) { close(); renderModelPopItems(); }
      };
    });
    const manual = pop.querySelector(".cmp-manual");
    if (manual) manual.onkeydown = async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const v = manual.value.trim();
      if (v && await applyModel(v)) close();
    };
    pop.querySelector(".cmp-gear").onclick = (e) => { e.stopPropagation(); close(); openWorkbench("model"); };
  };
  const renderModelPopItems = () => { if (pop.style.display !== "none") paint(MODEL_CACHE || { models: [], error: "" }); };
  chip.onclick = async (e) => {
    e.stopPropagation();
    if (pop.style.display !== "none") { close(); return; }
    pop.style.display = "block";
    paint(MODEL_CACHE || { models: [], error: "" }, !MODEL_CACHE);
    if (!MODEL_CACHE) paint(await fetchModels());
  };
  pop.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}
async function applyModel(id) {
  try {
    const r = await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: id }),
    }).then((x) => x.json());
    if (!r || r.ok === false) { toast(t("apWireModelPickertoastT140") + ((r && r.error) || t("apapplyModelC22"))); return false; }
    if (r.engine) applyEngineInfo(r.engine);
    toast(t("apWireModelPickertoastT141") + id);
    termLine('<span class="tl-info">[模型] 已切到 ' + esc(id) + "</span>");
    return true;
  } catch (e) { toast(t("apWireModelPickertoastT140") + e.message); return false; }
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
  const pct = Math.min(100, Math.max(0, Math.round((used / budget) * 100)));
  wrap.style.display = "flex";
  wrap.classList.toggle("mid", pct >= 60 && pct < 85);
  wrap.classList.toggle("warn", pct >= 85);
  const pctEl = wrap.querySelector("#ctxPct");
  if (pctEl) {
    pctEl.textContent = pct + "%";
    pctEl.classList.toggle("mid", pct >= 60 && pct < 85);
    pctEl.classList.toggle("warn", pct >= 85);
  }
  // 环形进度：r=7.6 → 周长 2πr ≈ 47.752
  const fg = wrap.querySelector(".ctx-fg");
  if (fg) fg.style.strokeDashoffset = String(47.752 * (1 - pct / 100));
  // Agent Trace 面板里的「水位」格：与环形进度同一个分子/分母，避免两处各算一套
  if (typeof $ === "function") { const tc = $("traceCtx"); if (tc) tc.textContent = pct + "%"; }
  // 服务端 used = 最近一次 LLM 请求的真实 prompt_tokens（est 标记 = 尚无实测、退回估算）
  const srcLabel = fromServer ? (ctxServer.est ? "服务端估算" : "服务端实测") : "本地估算";
  if (typeof renderEnvPanel === "function") { _envCtx = { used, budget }; renderEnvPanel(); }
  // 只报百分比：具体 token 数对使用者没有决策价值，且分母口径随模型窗口变，
  // 摆在界面上只会让人拿它当"消费金额"来读（悬停同样不给数值，只给水位的语义）。
  wrap.title = t("apRefreshCtxtitleT142") + pct + "%（" + srcLabel + "）"
    + (pct >= 80 ? " · 已达自动压缩水位线，也可输入 /compact 立即压缩" : " · 输入 /compact 可手动压缩");
}
/* 服务端 context.usage 事件 → 存储实测值并刷新（est=true 表示服务端暂无 LLM 实测、用的估算） */
function updateCtxBar(used, budget, est) {
  ctxServer = { used, budget, est: !!est };
  refreshCtx();
}

/* ---------------- 任务进度胶囊（对齐主流 agent：步骤 x/y · n 个文件已修改 +a -d） ----------------
   注意：每会话独立计数（convStepProg[convId]），避免不同对话之间互相干扰 */
const convStepProg = {}; // convId -> {n, fail, running, total}
let stepPill = null;
function getStepProg(id) {
  const cvid = id || convId || "default";
  if (!convStepProg[cvid]) convStepProg[cvid] = { n: 0, fail: 0, running: 0, total: 0 };
  return convStepProg[cvid];
}
function ensureStepPill() {
  if (stepPill && document.body.contains(stepPill)) return stepPill;
  stepPill = document.createElement("div");
  stepPill.id = "stepPill";
  stepPill.className = "step-pill";
  stepPill.style.display = "none";
  // 必须挂在 chatStream（滚动容器）内部、且作为首个子节点：
  // 挂到 #chatSlotAgents 会被当成 flex 兄弟把对话挤到右边；挂在末尾则 sticky 顶不到上面。
  if (stepPill.parentNode !== chatStream || chatStream.firstChild !== stepPill) {
    chatStream.insertBefore(stepPill, chatStream.firstChild);
  }
  /* 这里原先挂的是一个自造的「步骤详情」下拉：内联拼样式、`style.zIndex = "var(--z-pop)"`
     是无效赋值（z-index 只吃整数，等于没设）、按 window.scrollY 定位 —— 可胶囊是聊天流里的
     sticky 元素、文档根本不滚，于是聊天一滚面板就飘在正文上；新对话里没有步骤，
     它只剩标题加一条横线压着正文（用户截图里那个空框）。内容又把聊天流已有的步骤卡抄一遍。
     现在点胶囊 = 滚到本轮第一条步骤卡。 */
  stepPill.onclick = jumpToFirstStep;
  return stepPill;
}
/* 点胶囊跳到本轮第一条步骤卡（步骤明细本来就在聊天流里，不再抄一份） */
function jumpToFirstStep() {
  const blocks = convBlocks[convId] || {};
  const items = Object.values(blocks).filter((b) => b && b.el && document.body.contains(b.el));
  if (!items.length) return;
  items.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  const el = items[0].el;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("step-jump-hi");
  setTimeout(() => el.classList.remove("step-jump-hi"), 1200);
}
function bumpStepProgress(name, convIdArg) {
  const p = ensureStepPill();
  const sp = getStepProg(convIdArg || convId);
  sp.n++; sp.running++;
  p.dataset.busy = "1";
  renderStepPill();
}
function stepProgressDone(ok, convIdArg) {
  const sp = getStepProg(convIdArg || convId);
  sp.running = Math.max(0, sp.running - 1);
  if (!ok) sp.fail++;
  renderStepPill();
}
function resetStepProgress(convIdArg) {
  const sp = getStepProg(convIdArg || convId);
  sp.n = 0; sp.fail = 0; sp.running = 0;
  const p = ensureStepPill();
  p.dataset.busy = "";
  renderStepPill();
}
/* 任务收尾：胶囊必须从"转圈"切回"打勾/打叉"。
   dataset.busy 原先只在 resetStepProgress（下一次开跑）里归零，空闲时再没有任何事件会重绘胶囊——
   实测跑完 4 步、顶部已显示「AI 空闲」，胶囊圈圈仍一直转。同时把 running 归零：
   最后一轮 tool.end 丢失或 abort 中断时它也会残留 >0。 */
function endStepProgress(convIdArg) {
  const sp = getStepProg(convIdArg || convId);
  sp.running = 0;
  const p = ensureStepPill();
  p.dataset.busy = "";
  // abort / 异常中断时最后一轮的 tool.end 可能永远不来，步骤卡会停在琥珀色「执行中」——一并收尾
  Object.keys(blocks || {}).forEach((id) => {
    const b = blocks[id]; if (!b || !b.el) return;
    const s = b.el.querySelector(".t-status.running");
    if (!s) return;
    s.className = "t-status fail"; s.textContent = t("agentAbortedMsg");
    const st = b.el.querySelector(".t-state");
    if (st) { st.className = "t-state fail"; st.innerHTML = ico("circleX"); }
  });
  renderStepPill();
}
/* 计划总步数：有 plan 时显示 x/y，没有就只显示 x */
function planTotalSteps() {
  const box = $("agPlanActive");
  if (!box || box.style.display === "none") return 0;
  const items = box.querySelectorAll(".plan-task, .pt-row, li");
  return items.length || 0;
}
function renderStepPill() {
  const p = ensureStepPill();
  const sp = getStepProg();
  const ch = (typeof state !== "undefined" && state.lastChangeTotals) || { files: 0, add: 0, del: 0 };
  sp.total = planTotalSteps();
  /* 本轮一步都没跑过就不该有这颗胶囊。原先条件是"步骤和改动数都为 0 才藏"，
     于是新开对话后会看到「步骤 0 · 1 个文件已修改 +1291 −1287」——
     步骤数是本会话的，改动数却是全工作区待提交的（跨会话不清零），
     两个口径拼在一句读起来像"这一步改了 1291 行"的话里。 */
  if (!sp.n) { p.style.display = "none"; return; }
  p.style.display = "";
  p.title = t("stepPillJumpTip");
  const busy = sp.running > 0 || p.dataset.busy === "1";
  const seg = [];
  /* 分母不能小于已跑步数：计划只有 2 步却干了 3 步是常态（临时补一次读、一次改），
     照抄 plan 的步数会读出"3/2"这种不可能的进度。 */
  const den = Math.max(sp.total || 0, sp.n);
  seg.push('<span class="sp-steps">' + (busy ? '<i class="sp-spin"></i>' : ico(sp.fail ? "circleX" : "circleCheck")) +
    t("stepPillSteps") + " <b>" + sp.n + "</b>" + (den ? "/" + den : "") + "</span>");
  if (ch.files) seg.push('<span class="sp-sep"></span><span class="sp-files">' + t("stepPillFiles", { n: ch.files }) + "</span>" +
    '<span class="sp-stat"><b class="add">+' + ch.add + '</b> <b class="del">−' + ch.del + "</b></span>");
  if (sp.fail) seg.push('<span class="sp-sep"></span><span class="sp-fail">' + t("stepPillFail", { n: sp.fail }) + "</span>");
  p.innerHTML = seg.join("");
  replaceIcons(p);
}

/* ---------------- 右侧「环境信息」面板：改动量 / 上下文 / 分支 / 引擎，一屏看清当前态势 ---------------- */
let _envCtx = { used: 0, budget: 0 };
function renderEnvPanel() {
  const root = $("agEnv"); if (!root) return;
  const ch = state.lastChangeTotals || { files: 0, add: 0, del: 0 };
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set("envAdd", "+" + (ch.add || 0));
  set("envDel", "−" + (ch.del || 0));
  set("envFiles", t("nFiles", { n: ch.files || 0 }));
  const br = $("sbBranch"); if (br) set("envBranch", br.textContent);
  const vcs = $("envVcs");
  if (vcs) { const noGit = !!state.noGit; vcs.textContent = noGit ? t("vcsSnapshot") : t("vcsLocal"); vcs.classList.toggle("muted", noGit); }
  set("envEngine", (state.engine && state.engine.mode === "llm") ? state.engine.model : t("engineDemo"));
  if (ctxServer && ctxServer.budget) _envCtx = { used: ctxServer.used, budget: ctxServer.budget };
  const pct = _envCtx.budget ? Math.min(100, Math.round((_envCtx.used / _envCtx.budget) * 100)) : 0;
  const fill = $("envCtxFill"); if (fill) { fill.style.width = pct + "%"; fill.className = pct >= 85 ? "warn" : pct >= 60 ? "mid" : ""; }
  set("envCtxTxt", _envCtx.budget ? pct + "%" : "—");
  set("envUpdated", t("envUpdated", { time: new Date().toLocaleTimeString(getLang() === "en" ? "en-GB" : "zh-CN", { hour: "2-digit", minute: "2-digit" }) }));
  // 改动风险热力：把"该重点看哪几处"从一堆 +/- 数字里拎出来
  const rs = state.riskSummary;
  const row = $("envRiskRow"), pill = $("envRiskPill"), ftxt = $("envRiskTxt"), focus = $("envRiskFocus");
  if (row && pill && ftxt && focus) {
    if (!rs || rs.level === "low") { row.style.display = "none"; focus.innerHTML = ""; }
    else {
      row.style.display = "";
      pill.textContent = rs.level === "high" ? t("riskHigh") : t("riskMid");
      pill.className = "risk-pill " + rs.level;
      ftxt.textContent = t("riskFocusCount", { n: rs.high.length + rs.mid.length, score: rs.score });
      focus.innerHTML = (rs.focus || []).slice(0, 5).map((f) =>
        '<div class="ag-risk-item ' + f.level + '" title="' + esc(f.reasons.join("\n")) + '"><i></i><span>' + esc(f.path.split("/").pop()) + "</span><em>" + f.score + "</em></div>"
      ).join("");
    }
  }
}
function wireEnvPanel() {
  const tg = $("agEnvToggle");
  if (tg) tg.onclick = () => {
    const body = $("agEnvBody"); if (!body) return;
    const folded = body.style.display === "none";
    body.style.display = folded ? "" : "none";
    tg.querySelector("i,svg") && (tg.querySelector("i,svg").style.transform = folded ? "" : "rotate(-90deg)");
  };
  const c = $("envCommit"); if (c) c.onclick = () => typeof openCommit === "function" && openCommit();
  const s = $("envSediment"); if (s) s.onclick = () => typeof openSediment === "function" && openSediment();
}

/* 记忆溯源卡（pancode 原创）：长期记忆最容易自欺欺人——存了几百条，没人知道这次到底用上了哪几条。 */
function renderRecallCard(ev) {
  const list = (ev.entries || []).filter((e) => e && (e.topic || e.content || e.type));
  if (!list.length) return;
  /* 口径跟着 P6 改：卡片以前写"读进了 N 条"，那是"每轮自动摊正文"时代的说法。
     现在正文只有硬提醒那几类常驻，其余全靠模型自己调 search_memory 取，
     所以两个来源要分开计——否则用户看到"读进了 12 条"，模型其实一条正文都没看。 */
  const resident = list.filter((e) => (e.via || "guard") === "guard").length;
  const pulled = list.length - resident;
  const el = document.createElement("div");
  el.className = "recall-card";
  const rows = list.map((e) => {
    const c = (e.content || "").trim();
    const t = (e.topic || "").trim();
    /* scope 三档：本项目 / 用户级（跨项目通用）/ 别的工作区的分片。
       旧的两档写法会把"从隔壁项目捞来的旧结论"显示成"本项目记过"。 */
    const SCOPE = { user: ["user", "跨项目"], other: ["other", "别的工作区"], project: ["proj", "本项目"] };
    const sc = SCOPE[e.scope === "user" ? "user" : e.scope === "other" ? "other" : "project"];
    // 旧条目的 topic 多是当年拿用户原话切片落盘的（#31 遗留），与正文开头重复时不再显示，
    // 回显卡以正文内容为主，免得满屏"用户说过的话"显得记忆没价值
    const dup = t && c && c.replace(/\s+/g, "").startsWith(t.replace(/\s+/g, ""));
    const via = (e.via || "guard") === "pull" ? "模型自查" : "常驻提醒";
    return '<div class="rc-row" data-via="' + ((e.via || "guard") === "pull" ? "pull" : "guard") + '">' +
      '<div class="rc-line">' +
        '<span class="rc-scope ' + sc[0] + '">' + sc[1] + "</span>" +
        '<span class="rc-tag rc-via">' + via + "</span>" +
        (t && !dup ? '<span class="rc-topic">' + esc(t) + "</span>" : "") +
        '<span class="rc-tag">' + esc(e.type || "") + "</span>" +
        '<span class="rc-meta">价值 ' + (e.valueScore >= 4 ? "高" : e.valueScore >= 3 ? "中" : "低") + " · 已用上 " + (e.accessCount || 0) + " 次</span>" +
      "</div>" +
      (c ? '<div class="rc-content">' + esc(c) + "</div>" : "") +
    "</div>";
  }).join("");
  el.innerHTML =
    '<div class="rc-head">' + ico("memory") +
      '<span class="rc-title">本次任务的长期记忆：常驻提醒 ' + resident + " 条" +
        (pulled ? " · 我自己查了 " + pulled + " 条" : "") + "</span>" +
      '<button class="rc-toggle">' + ico("chevR") + "明细</button>" +
    "</div><div class='rc-body'>" + rows + "</div>";
  el.querySelector(".rc-toggle").onclick = () => el.classList.toggle("open");
  appendChatBlock(el);
  replaceIcons(el);
  scrollChat();
}

/* 上下文压缩可视化：以前只在终端刷一行字，用户在主界面完全看不见"AI 把什么忘了"。
   这里在聊天流里插一张可展开的压缩卡，展开能看到结构化摘要（目标/决策/改动/验证/未决）。 */
function renderCompactCard(ev) {
  // 只给水位的相对量：压缩前/后各占水位线的百分之几、这次腾出多少。
  // 绝对 token 数既不直观（分母随模型窗口变），又会被误读成消费数字。
  const pc = (n) => (ev.budget ? Math.min(100, Math.max(0, Math.round((n / ev.budget) * 100))) : null);
  const beforePct = pc(ev.before), afterPct = pc(ev.after);
  const stat = beforePct == null || afterPct == null
    ? '<span class="cc-stat"><b>—</b></span>'
    : '<span class="cc-stat"><b>' + beforePct + '%</b><i>→</i><b class="cc-after">' + afterPct + '%</b></span>';
  const freed = beforePct == null || afterPct == null ? null : Math.max(0, beforePct - afterPct);
  const el = document.createElement("div");
  el.className = "compact-card";
  el.innerHTML =
    '<div class="cc-head">' +
      '<span class="cc-ico">' + ico("compress") + '</span>' +
      '<span class="cc-title">' + (ev.forced ? "已手动压缩上下文" : "上下文接近水位线，已自动压缩") + '</span>' +
      stat +
      '<span class="cc-badge">' + (freed == null ? "已压缩" : "腾出 " + freed + "% 空间") + '</span>' +
      '<button class="cc-toggle">' + ico("chevR") + '查看保留了什么</button>' +
    '</div>' +
    '<div class="cc-body">' +
      '<div class="cc-meta">' + t("apRenderCompactCardH27") + '</div>' +
      '<pre class="cc-summary">' + esc(ev.summary || "（无摘要文本）") + '</pre>' +
    '</div>';
  el.querySelector(".cc-toggle").onclick = () => el.classList.toggle("open");
  appendChatBlock(el);
  replaceIcons(el);
  scrollChat();
}

/* ---------------- Agent 状态 ---------------- */
/* W11：ELD（事件循环延迟）展示——>100ms 主进程繁忙（重计算阻塞中），提示用户感知卡顿源 */
let lastEld = 0;
function onSystemPerf(ev) {
  const el = $("sbEld"); const txt = $("sbEldTxt");
  if (!el || !txt) return;
  el.style.display = "";
  lastEld = Math.max(0, Number(ev && ev.eld) || 0);
  paintSbEld();
}
/* 提示语是拼出来的：单独抽成 paint，切语言时能按现有数值重画，不用等下一次 perf 事件 */
function paintSbEld() {
  const el = $("sbEld"); const txt = $("sbEldTxt");
  if (!el || !txt) return;
  const ms = lastEld;
  txt.textContent = ms.toFixed(1) + "ms";
  el.style.color = ms > 100 ? "var(--err, #e5484d)" : (ms > 40 ? "var(--warn, #f5a623)" : "");
  const st = ms > 100 ? t("sbBusyLag") : (ms > 40 ? t("sbMid") : t("sbIdle"));
  el.title = t("sbEld", { v: ms.toFixed(1) + "ms", state: st });
}

/* 运行状态那句话是事件驱动渲染的：切语言时若没有新的 agent.state，工具栏/状态栏会停在旧语言。
   记下最后一次渲染用的参数，lang hook 里重放一次。 */
let lastStateArgs = null;
function paintState(running, label, labelKey, labelVars) {
  lastStateArgs = { running, label, labelKey, labelVars };
  /* 演示引擎的 state 标签是服务端中文，tr() 查不到键会原样返回 —— 英文界面下就把"AI 分析任务中"
     直接漏到顶栏（截图目视抓到的，探针扫的是左栏容器，量不到这里）。查不到时退回通用文案。 */
  let txt = labelKey ? t(labelKey, labelVars) : null;
  if (!txt && label) {
    const mapped = tr(label);
    if (mapped !== label || getLang() === "zh") txt = mapped;
  }
  if (!txt) txt = running ? t("running") : t("aiIdle");
  const tb = $("tbAgentState");
  if (tb) {
    tb.className = "agent-state " + (running ? "running" : "idle");
    tb.innerHTML = '<span class="dot"></span>' + esc(txt);
  }
  const sb = $("sbAgentTxt"); if (sb) sb.textContent = txt;
  const liveTxt = $("agLiveTxt"); if (liveTxt) liveTxt.textContent = txt;
}
onLang(() => { if (lastStateArgs) paintState(lastStateArgs.running, lastStateArgs.label, lastStateArgs.labelKey, lastStateArgs.labelVars); });

function setRunning(running, label, evConvId, labelKey, labelVars) {
  // 多会话并行：按 convId 更新运行状态
  const cid = evConvId || convId;
  // 新任务开跑（当前会话由空闲 → 运行）：进度胶囊归零重新计数
  if (running && cid === convId && !state.running && typeof resetStepProgress === "function") resetStepProgress();
  if (cid) state.convRunning[cid] = running;
  // 全局 running = 当前活跃会话是否在运行
  state.running = !!state.convRunning[convId];
  const isCurrent = !evConvId || evConvId === convId;
  if (!isCurrent) { renderConvList(); return; }  // 后台会话状态变更：只刷新会话列表
  if (!running && typeof endStepProgress === "function") endStepProgress();
  paintState(running, label, labelKey, labelVars);
  const meta = $("agSessMeta");
  if (meta) meta.textContent = (running ? t("running") : t("ready")) + " · " + (state.project || "");
  const live = document.querySelector(".ag-live-dot");
  if (live) live.classList.toggle("running", running);
  /* 会话头轨道标记 + 输入框能量边框一起进/出"忙"态：关窗后台续跑再回来时，
     不用读文字就知道 Agent 此刻是在跑还是已经停了。 */
  const avatar = document.querySelector(".ag-avatar");
  if (avatar) avatar.classList.toggle("busy", !!running);
  inputBox.classList.toggle("busy", !!running);
  const btn = inputBox.querySelector("#btnSend");
  if (btn) {
    if (running) {
      // 修复：running 时按钮变为「停止」，必须保持可点击，才能发送 abort 中断 Agent 主循环
      btn.disabled = false;
      btn.innerHTML = ico("stopSq");
      btn.title = t("apSetRunningtitleT51");
      btn.classList.add("stop-mode");
      btn.onclick = () => { if (goalMode) { setGoalMode(false); toast(t("apSetRunningtoastT143")); } send({ type: "abort", convId }); };
    } else {
      // Agent 空闲：恢复为「发送」按钮，点击走正常 doSend（重置 onclick，避免残留 abort 处理器）
      btn.disabled = false;
      btn.innerHTML = ico("sendUp");
      btn.title = t("sendTip");
      btn.classList.remove("stop-mode");
      btn.onclick = window._doSend || (() => {});
      // Goal 续跑已搬到服务端（agent-llm.js 的 goal 预算块）：
      // 浏览器不再自续跑，刷新 / 断线都不会让长任务静默停住。
    }
  }
}

/* Goal 横幅：服务端每续跑一轮推 goal.continue，收口推 goal.settled */
function renderGoalBanner(html) {
  let b = $("goalBanner");
  if (!b) {
    b = document.createElement("div");
    b.id = "goalBanner";
    b.className = "goal-banner";
    const wrap = $("chatInputAgents") || inputBox.parentNode;
    wrap.insertBefore(b, wrap.firstChild);
  }
  if (!html) { b.style.display = "none"; b.innerHTML = ""; return; }
  b.style.display = "";
  b.innerHTML = html;
  replaceIcons(b);
}

/* ---------------- 多 Agent 编排面板 ---------------- */
let orchSteps = {};
/* ---------------- 编排步骤图（P2-C1） ----------------
   原来这里是一条平铺列表：谁等谁、哪几步同批并行，服务端事件里都带着
   （depends_on / layer），前端拿到就扔，用户只看得到「N 步在跑」。
   现在有多批或存在依赖才画泳道 + 依赖边；单批无依赖仍是那条整宽列表 ——
   图为依赖服务，没有依赖时画一列框框只是噪音。
   分层只认服务端发的那一份（真正决定执行顺序的就是它），前端不再自己推一套。 */
/* 这一步的"归属"：改了哪几个文件、有没有被并行冲突挡回。
   并行分工最怕的就是跑完了没人说得清谁动了什么，所以这两个数实时就要看得见。
   changed 可能是数组（实时事件）也可能是条数（历史端点是裁剪过的），两种都接。 */
function orchAttrib(s) {
  const n = Array.isArray(s.changed) ? s.changed.length : (s.changed || 0);
  const c = Array.isArray(s.conflicts) ? s.conflicts.length : (s.conflicts || 0);
  return (n ? " · 改动 " + n + " 个文件" : "") + (c ? " · 撞回 " + c + " 次" : "");
}
function orchNodeEl(s) {
  const st = s.status || "pending";
  const el = document.createElement("div");
  el.className = "orch-step " + st;
  el.dataset.id = s.id;
  const icoName = st === "done" ? "check" : st === "fail" ? "error" : st === "running" ? "spin" : "clock";
  const statusText = st === "done" ? "完成" : st === "fail" ? "失败"
    : st === "running" ? (s.finished ? "未回收" : "执行中" + (s.parallel ? "（并行）" : ""))
    : "等待中";
  el.innerHTML = '<div class="orch-step-head">' +
    '<span class="orch-step-ico">' + ico(icoName) + "</span>" +
    '<span class="orch-step-name">' + esc(s.name || s.id) + "</span>" +
    '<span class="orch-step-status">' + esc(statusText) + (s.elapsed ? " · " + (+s.elapsed).toFixed(1) + "s" : "") + esc(orchAttrib(s)) + "</span></div>" +
    '<div class="orch-step-out"></div>';
  const out = el.querySelector(".orch-step-out");
  if (s.output) orchSetOutput(el, String(s.output).slice(0, 1500));
  return el;
}
/* 结果默认收起、点标题展开。实时那一步原先写 out.style.display = ""，
   而 .orch-step-out 的 CSS 就是 display:none —— 内联"空值"等于没表态，被 CSS 赢回去，
   结果文本从来没出现过；泳道里摊开一整段结果还会把节点撑高、边跟着失准。 */
function orchSetOutput(el, text) {
  const out = el.querySelector(".orch-step-out");
  if (!out) return;
  out.textContent = text;
  out.style.display = "none";            // 先表态，否则第一次点击读到空串会被判成"已展开"，点了两下才出结果
  const head = el.querySelector(".orch-step-head");
  head.onclick = () => { out.style.display = out.style.display === "none" ? "block" : "none"; };
  head.title = t("apOrchSetOutputtitleT52");
}
function renderOrchSteps(host, steps) {
  host.innerHTML = "";
  host._orchDeps = {};
  const lanes = [];
  (steps || []).forEach((s) => {
    host._orchDeps[s.id] = (s.depends_on || []).slice();
    const li = Number.isFinite(s.layer) ? s.layer : 0;
    while (lanes.length <= li) lanes.push([]);
    lanes[li].push(s);
  });
  const graphed = lanes.length > 1 || Object.keys(host._orchDeps).some((k) => host._orchDeps[k].length);
  const ov = $("orchOverlay");
  const box = ov && ov.querySelector(".orch-box");
  host.classList.toggle("orch-dag", graphed);
  if (box) box.classList.toggle("orch-box-wide", graphed);
  if (!graphed) {
    (steps || []).forEach((s) => host.appendChild(orchNodeEl(s)));
    return;
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "orch-dag-svg");
  host.appendChild(svg);
  const wrap = document.createElement("div");
  wrap.className = "orch-lanes";
  lanes.forEach((lane, li) => {
    const col = document.createElement("div");
    col.className = "orch-lane";
    col.dataset.layer = String(li);
    const head = document.createElement("div");
    head.className = "orch-lane-head";
    head.textContent = t("apHandleEventInnertextContentT136") + (li + 1) + t("aprenderOrchStepsC23") + (lane.length > 1 ? lane.length + t("aprenderOrchStepsC24") : t("aprenderOrchStepsC25"));
    col.appendChild(head);
    lane.forEach((s) => col.appendChild(orchNodeEl(s)));
    wrap.appendChild(col);
  });
  host.appendChild(wrap);
  bindOrchResize();
  drawOrchEdges(host);
  /* 再补一帧：泳道宽度是 flex 等分算出来的，第一次绘制时框宽（.orch-box-wide）
     与滚动条可能还没落定，边会按"上一次布局"的矩形画，端点差 1~2px。 */
  requestAnimationFrame(() => drawOrchEdges(host));
}
/* 边按节点真实矩形算，所以必须在布局落定之后画；每次状态变更都要重画一次
   （步骤高度会随结果文本变化，边跟着端点走才不脱靶）。 */
function drawOrchEdges(host) {
  const svg = host.querySelector(":scope > .orch-dag-svg");
  if (!svg) return;
  const deps = host._orchDeps || {};
  const els = [...host.querySelectorAll(".orch-step")];
  const hb = host.getBoundingClientRect();
  const pos = {};
  els.forEach((el) => {
    const r = el.getBoundingClientRect();
    pos[el.dataset.id] = { x: r.left - hb.left, y: r.top - hb.top, w: r.width, h: r.height,
      st: ["running", "done", "fail", "pending"].find((c) => el.classList.contains(c)) || "pending" };
  });
  const W = Math.max(host.scrollWidth, Math.ceil(hb.width));
  const H = Math.max(host.scrollHeight, Math.ceil(hb.height));
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  let out = "";
  els.forEach((el) => {
    const t = pos[el.dataset.id];
    if (!t) return;
    (deps[el.dataset.id] || []).forEach((d) => {
      const f = pos[d];
      if (!f) return;                       // 依赖指向不存在的步骤：不画一条指向虚无的边
      /* 颜色跟着「上游有没有交付」走，而不是下游的状态：
         绿色=前置结论已经流过来，红色=这条依赖断在这里，虚线=还没轮到。
         按下游着色会出现"s1 已经完成但 s1→s2 仍是灰虚线"，看起来像什么都没发生。 */
      const st = f.st;
      const x1 = f.x + f.w, y1 = f.y + f.h / 2, x2 = t.x, y2 = t.y + t.h / 2;
      const mx = Math.max(x1 + 12, x2 - 12);
      out += '<path class="orch-edge ' + st + '" d="M' + x1.toFixed(1) + ',' + y1.toFixed(1) +
        ' C' + mx.toFixed(1) + ',' + y1.toFixed(1) + ' ' + mx.toFixed(1) + ',' + y2.toFixed(1) +
        ' ' + (x2 - 7).toFixed(1) + ',' + y2.toFixed(1) + '"/>' +
        '<path class="orch-edge-head ' + st + '" d="M' + x2.toFixed(1) + ',' + y2.toFixed(1) + ' l-8,-4 v8 z"/>';
    });
  });
  svg.innerHTML = out;
}
/* 窗口一改宽度，节点矩形就变、边会脱靶。监听只在第一次画图时挂一条并复用，
   每次重渲染都 add 一条正是这仓库实测数过的泄漏来源。 */
let _orchResizeOn = false;
function bindOrchResize() {
  if (_orchResizeOn) return;
  _orchResizeOn = true;
  window.addEventListener("resize", () => {
    const host = $("orchSteps");
    if (host && host.classList.contains("orch-dag")) drawOrchEdges(host);
  });
}
function onOrchStart(ev) {
  orchSteps = {};
  const overlay = $("orchOverlay");
  $("orchTitle").textContent = ev.title || t("orchTitle");
  $("orchSummary").style.display = "none";
  const steps = (ev.steps || []).map((s) => Object.assign({}, s, { status: "pending" }));
  steps.forEach((s) => { orchSteps[s.id] = { name: s.name, status: "pending" }; });
  renderOrchSteps($("orchSteps"), steps);
  overlay.style.display = "";
  replaceIcons();
}
function onOrchStepStart(ev) {
  const el = $("orchSteps").querySelector('[data-id="' + ev.stepId + '"]');
  if (!el) return;
  el.className = "orch-step running";
  el.querySelector(".orch-step-ico").innerHTML = ico("spin");
  el.querySelector(".orch-step-status").textContent = t("apHandleEventInnerH21") + (ev.parallel ? "（并行）" : "");
  replaceIcons();
  redrawOrch();
}
function onOrchStepDone(ev) {
  const el = $("orchSteps").querySelector('[data-id="' + ev.stepId + '"]');
  if (!el) return;
  el.className = "orch-step done";
  el.querySelector(".orch-step-ico").innerHTML = ico("check");
  el.querySelector(".orch-step-status").textContent = t("apOnOrchStepDonetextContentT54") + orchAttrib({ changed: ev.changed, conflicts: ev.conflicts });
  if (ev.output) orchSetOutput(el, ev.output);
  replaceIcons();
  redrawOrch();
}
function onOrchStepFail(ev) {
  const el = $("orchSteps").querySelector('[data-id="' + ev.stepId + '"]');
  if (!el) return;
  el.className = "orch-step fail";
  el.querySelector(".orch-step-ico").innerHTML = ico("error");
  el.querySelector(".orch-step-status").textContent = t("apOnOrchStepFailtextContentT55");
  if (ev.error) orchSetOutput(el, ev.error);
  replaceIcons();
  redrawOrch();
}
/* 状态一变，节点矩形可能变（图标/文案换行），边必须跟着重画；同样补一帧取落定后的布局 */
function redrawOrch() {
  const host = $("orchSteps");
  if (!host || !host.classList.contains("orch-dag")) return;
  drawOrchEdges(host);
  requestAnimationFrame(() => drawOrchEdges(host));
}
function onOrchDone(ev) {
  const summary = $("orchSummary");
  summary.style.display = "";
  summary.className = "orch-summary " + (ev.ok ? "ok" : "fail");
  summary.innerHTML = '<span class="orch-sum-ico">' + ico(ev.ok ? "check" : "error") + '</span>' + esc(ev.summary || "编排完成")
    + (ev.runId ? '<button class="orch-sum-link" id="orchSumDetail">' + t("apOnOrchDoneH28") + '</button>' : "");
  replaceIcons();
  const btn = $("orchSumDetail");
  if (btn && ev.runId) btn.onclick = () => replayOrchRun(ev.runId, ev.summary);
  renderOrchHistory();   // 服务端已落盘，重新拉一次列表
}

/* 编排历史：服务端 .pancode/orch-history/<wsHash>.json，跨浏览器可见、可点开回放。
   文件是按工作区存的，以前整份摊到侧栏 → 换个对话看到的内容一模一样，
   分不清哪次是自己刚跑的。现在默认只看本会话，别的会话的记录仍在，可一键切到全部。 */
let _orchHistCache = [];
let _orchScope = "conv";        // conv = 只看本会话，all = 本工作区全部
function orchConvTitle(id) {
  if (!id) return "";
  try {
    const hit = (loadConvList() || []).find((c) => String(c.id) === String(id));
    return hit && hit.title ? hit.title : "";
  } catch (e) { return ""; }
}
async function renderOrchHistory() {
  const host = $("agOrchHistory");
  if (!host) return;
  try {
    const r = await fetch("/api/orch/history").then((x) => x.json());
    _orchHistCache = (r && r.runs) || [];
    if (!_orchHistCache.length) {
      host.innerHTML = '<div class="ag-orch-empty">' + t("apRenderOrchHistoryH29") + '<br><span>' + t("apRenderOrchHistoryH30") + '<code>orchestrate</code>' + t("apRenderOrchHistoryH31") + '</span></div>';
      return;
    }
    const cid = String(convId || "default");
    const mine = _orchHistCache.filter((h) => (h.conv || "default") === cid);
    const others = _orchHistCache.length - mine.length;
    const shown = _orchScope === "all" || !others ? _orchHistCache : mine;
    host.innerHTML = "";
    const bindScope = () => {
      host.querySelectorAll(".aos-btn").forEach((b) => {
        b.onclick = () => { _orchScope = b.dataset.scope; renderOrchHistory(); };
      });
    };
    if (!shown.length) {
      host.innerHTML = '<div class="ag-orch-empty">' + t("orchEmptyThisConv") +
        '<br><button class="aos-btn" data-scope="all">' + t("orchScopeAll") + '</button></div>';
      bindScope();
      return;
    }
    /* 只有确实存在别的会话的记录时才摆这一行，否则是白占一行的噪音 */
    if (others) {
      const bar = document.createElement("div");
      bar.className = "ag-orch-scope";
      bar.innerHTML = '<button class="aos-btn' + (_orchScope === "conv" ? " active" : "") + '" data-scope="conv">' + t("orchScopeThisConv") + '</button>' +
        '<button class="aos-btn' + (_orchScope === "all" ? " active" : "") + '" data-scope="all">' + t("orchScopeAll") + '</button>';
      host.appendChild(bar);
    }
    shown.forEach((h) => {
      const el = document.createElement("div");
      el.className = "ag-orch-item" + (h.ok ? "" : " failed");
      const d = new Date(h.ts);
      const meta = (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      const c = h.counts || {};
      /* 每条历史直接摊开子任务：派了什么活（task）+ 跑出什么（output 摘要）。
         以前这里只有标题和成败计数，用户看不出编排到底分发了什么——
         结果全文点开回放仍能看（每步 1500 字）。 */
      const stepRows = (h.steps || []).slice(0, 4).map((s) => {
        const st = s.status === "done" ? "done" : s.status === "fail" ? "fail" : "run";
        /* 耗时与归属并排一格：回放时用户同样要能看出"这一步动了几个文件、有没有撞回"，
           光看状态点和 output 摘要分不出谁改了盘。 */
        const stepT = [(s.elapsed ? (+s.elapsed).toFixed(1) + "s" : ""), orchAttrib(s).replace(/^ · /, "")].filter(Boolean).join(" · ");
        return '<div class="ag-orch-step ' + st + '">' +
          '<span class="ag-orch-step-name">' + esc(s.name || s.id) + "</span>" +
          (stepT ? '<span class="ag-orch-step-t">' + esc(stepT) + "</span>" : "") +
          (s.task ? '<span class="ag-orch-step-task">' + esc(s.task.slice(0, 70)) + "</span>" : "") +
          (s.output ? '<span class="ag-orch-step-out">' + esc(s.output.slice(0, 90)) + "</span>" : "") +
          "</div>";
      }).join("");
      const more = (h.steps || []).length > 4
        ? '<div class="ag-orch-more">' + t("orchMoreSteps", { n: (h.steps || []).length }) + "</div>" : "";
      /* 「几批」直接摆在计数里：3 步一条链和 3 步齐头并进，成本与失败面完全不同，
         光看步数看不出来，而点开之前没人会为一个数字去点。 */
      const batches = new Set((h.steps || []).map((s) => (Number.isFinite(s.layer) ? s.layer : 0))).size;
      /* 「全部」视图补一行归属会话：同一次编排的 title 很容易撞车，
         没有这行就没法分辨哪条属于哪个对话。 */
      const fromConv = _orchScope === "all"
        ? '<div class="ag-orch-item-conv">' + ico("chat") + '<span>' + esc(orchConvTitle(h.conv) || (h.conv || "default")) + '</span></div>' : "";
      el.innerHTML = '<div class="ag-orch-item-head">' +
        '<span class="ag-orch-item-badge ' + (h.ok ? "ok" : "fail") + '">' + (h.ok ? "✓" : "✗") + '</span>' +
        '<span class="ag-orch-item-title">' + esc((h.title || t("orchFallbackTitle")).slice(0, 40)) + '</span></div>' +
        '<div class="ag-orch-item-meta">' + meta + (h.elapsed ? " · " + h.elapsed + "s" : "") +
        " · " + t("orchStepsN", { n: c.total || 0 }) + (batches > 1 ? " · " + t("orchBatchesN", { n: batches }) : "") +
        (c.fail ? '<b class="ag-orch-fail"> · ' + t("orchFailN", { n: c.fail }) + '</b>' : "") + "</div>" +
        fromConv +
        '<div class="ag-orch-steps">' + stepRows + "</div>" + more;
      el.onclick = () => replayOrchRun(h.id, h.title);
      host.appendChild(el);
    });
    bindScope();
    replaceIcons(host);
  } catch (e) {
    host.innerHTML = '<div class="ag-orch-empty">' + t("apRenderOrchHistoryH32") + '</div>';
  }
}
async function replayOrchRun(runId, title) {
  try {
    const r = await fetch("/api/orch/history/" + encodeURIComponent(runId)).then((x) => x.json());
    if (!r.ok || !r.run) { toast(t("apOnOrchDonetoastT144") + (r.error || t("apreplayOrchRunC26"))); return; }
    const run = r.run;
    const overlay = $("orchOverlay");
    orchSteps = {};
    $("orchTitle").textContent = t("apOnOrchDonetextContentT145") + (run.title || title || "");
    /* finished：整条编排早就结束了，落盘时还停在 running 的步骤是中断没回收的，
       回放里不能显示成"执行中"（那会让人以为还在跑）。 */
    const steps = (run.steps || []).map((s) => Object.assign({}, s, {
      status: s.status === "done" || s.status === "fail" || s.status === "running" ? s.status : "pending",
      finished: true,
    }));
    steps.forEach((s) => { orchSteps[s.id] = { name: s.name, status: s.status }; });
    renderOrchSteps($("orchSteps"), steps);
    const sum = $("orchSummary");
    sum.style.display = "";
    sum.className = "orch-summary " + (run.ok ? "ok" : "fail");
    sum.innerHTML = '<span class="orch-sum-ico">' + ico(run.ok ? "check" : "error") + "</span>" + esc(run.summary || "");
    overlay.style.display = "";
    replaceIcons();
    requestAnimationFrame(() => drawOrchEdges($("orchSteps")));
  } catch (e) { toast(t("apOnOrchDonetoastT146") + e.message); }
}
(function () {
  const closeBtn = $("orchClose");
  if (closeBtn) closeBtn.onclick = () => { $("orchOverlay").style.display = "none"; };
  /* 编排历史的首次拉取挪到 startApp()（鉴权就绪之后）：
     在这里直接 fetch 时 AUTH.token 还是空串，服务端 401 NO_AUTH →
     下面那个全局 401 处理会把用户存好的登录态抹掉，等于每次刷新都要重新登录。 */
})();

/* ---------------- 本地鉴权 ---------------- */
const AUTH = { token: "" };
let _authRedirected = false;   // 防止 401 时反复弹登录窗
let HAS_USERS = true;          // 本机是否已有账号（/api/auth/status 告知）；决定弹窗默认落在登录还是注册
let lastUserText = "";         // C2：记录最后一条用户消息，供错误重试使用

function showAuthModal() {
  _authRedirected = false;
  const m = $("authModal"); if (m) m.style.display = "flex";
  const s = $("authStatus"); if (s) { s.textContent = ""; s.className = "auth-status"; }
  replaceIcons(m);
  // 本机还没有任何账号时直接给注册态，别让用户对着一个必然失败的登录框
  if (typeof authModeSwitch === "function") authModeSwitch(HAS_USERS ? "login" : "register");
  const first = $(HAS_USERS ? "authPass" : "authUser");
  if (first) setTimeout(() => { try { first.focus(); } catch (e) {} }, 60);
}

/* C2：LLM 错误分类卡片 + 一键重试 */
function showAgentError(ev) {
  const el = document.createElement("div");
  el.className = "msg msg-ai evo-err-card";
  const labels = {
    quota: "配额耗尽 / 触发限流",
    network: "网络异常",
    key: "API Key 无效或未授权",
    model: "模型不存在",
    context: "上下文超限 / 流挂起（自动压缩后重试）",
    unknown: "未知错误",
  };
  const label = labels[ev.kind] || "未知错误";
  el.innerHTML = '<div class="evo-err-head">' + ico("warn") + " 出错了：" + esc(label) + "</div>" +
    '<div class="evo-err-msg">' + esc(ev.message || "") + "</div>" +
    '<div class="evo-err-hint">' + esc(ev.hint || "") + "</div>";
  // 可恢复类错误（配额/网络/上下文超限）都提供「重试」入口
  if (ev.kind === "quota" || ev.kind === "network" || ev.kind === "context") {
    const btn = document.createElement("button");
    btn.className = "set-btn primary"; btn.textContent = t("apShowAgentErrortextContentT57");
    btn.onclick = () => { el.remove(); resendLast(); };
    el.appendChild(btn);
  }
  chatPane().appendChild(el);
  scrollChat(true);
}
function resendLast() {
  if (!lastUserText) { toast(t("apResendLasttoastT147")); return; }
  // Goal 模式下不能重置会话（会清掉执行计划）：直接发「继续执行计划」续跑，保留 goal 状态
  if (typeof goalMode !== "undefined" && goalMode) {
    setTimeout(() => send({ type: "chat", text: t("apResendLasttextT58"), attachments: [], convId }), 250);
    return;
  }
  send({ type: "newchat" });
  setTimeout(() => send({ type: "chat", text: lastUserText, attachments: [], convId }), 250);
}

(function patchFetch() {
  const orig = window.fetch.bind(window);
  window.fetch = async (url, opts) => {
    /* 这次请求到底带没带 token：没带就别把 401 当成"登录过期"。
       启动期那些早于 checkAuth() 的 fetch 一定会 401（AUTH.token 还是空串），
       若照旧走下面的清 token 分支，等于用户每次刷新都被登出。 */
    let hadToken = false;
    if (AUTH.token && typeof url === "string" && url.startsWith("/api/")) {
      opts = opts || {};
      opts.headers = Object.assign({}, opts.headers, { Authorization: "Bearer " + AUTH.token });
      hadToken = true;
    }
    const r = await orig(url, opts);
    if (r.status === 401 && hadToken) {
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
/* 半开连接的浏览器侧兜底：TCP 半死时 readyState 会长期停在 1，send 看似成功实则无人接收，
   且浏览器自己不会察觉——界面就卡在"AI 思考中"直到用户刷新。服务端每 3s 广播 system.perf，
   用它作为存活证据；超过 WS_STALE_MS 收不到任何消息即主动 close，走 onclose 的退避重连。 */
let _wsLastMsg = Date.now();
const WS_STALE_MS = 30000;
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  if (Date.now() - _wsLastMsg > WS_STALE_MS) {
    _wsLastMsg = Date.now();          // 先复位，避免重连前重复触发
    toast(t("apResendLasttoastT148"));
    try { ws.close(); } catch (e) {}
  }
}, 5000);
function connect() {
  /* 修 C-B2：令牌不再拼进 URL。浏览器 WebSocket API 不能自定义 header，
     走 Sec-WebSocket-Protocol（第二参数即 protocols），不进 URL，
     因而不会留在浏览器历史 / Referer / 访问日志里。 */
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/", ["bearer." + encodeURIComponent(AUTH.token || "")]);
  ws.onmessage = (e) => { _wsLastMsg = Date.now(); try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  // C6：连接/重连建立后，把当前会话 ID 同步给服务端，恢复对应的 AI 上下文
  ws.onopen = () => {
    if (wsRetry > 0) {
      toast(t("apConnecttoastT149"));
      /* S-H4：断线期间如果有生成任务在跑（state.running / convRunning 里有未收尾的会话），
         服务端已失去该 WS 的事件通道 —— 重连后生成不会自动续传，明确提示用户。 */
      const hadRunning = state.running || Object.keys(state.convRunning || {}).some((k) => state.convRunning[k]);
      if (hadRunning) {
        state.running = false;
        state.convRunning = {};
        termLine('<span class="tl-warn">' + t("apConnectH33") + '</span>');
      }
    }
    wsRetry = 0;             // 连接成功，重置退避
    send({ type: "ctx.query" });
    if (typeof convId !== "undefined" && convId) { send({ type: "switchConv", convId: convId }); loadTraceHistory(convId); send({ type: "ctx.query" }); }
  };
  ws.onclose = () => {
    const delay = Math.min(1000 * Math.pow(2, wsRetry), WS_RETRY_MAX);
    wsRetry++;
    if (wsRetry === 1) toast(t("apConnecttoastT150"));
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
    chip.innerHTML = '<img src="' + a.src + '" alt=""><span class="ci-chip-name">' + esc(a.name) + '</span><button class="ci-chip-x" title="' + escHtml(t("chipRemoveTip")) + '">×</button>';
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
    const skillId = activeSkill ? activeSkill.id : "";
    if (!v && !pendingAttach.length && !skillId) return;

    ta.value = "";
    // 记录到当前会话的发送历史，供 ↑/↓ 浏览回填
    const curConv = (typeof convId !== "undefined" && convId) || "default";
    (sentHistory[curConv] = sentHistory[curConv] || []);
    if (v) sentHistory[curConv].push(v);
    histNav = -1;
    const attachments = pendingAttach.splice(0, pendingAttach.length).map((a) => ({ src: a.src, name: a.name }));
    renderChips();
    /* Skill 走 skillId 单独发出去，正文由服务端注入到模型看到的上下文里。
       旧写法是把整份 body 前置拼进这条消息：气泡里糊一大段模板、每轮都重复占上下文，
       而且"用技能"必须靠输入框里有字才成立。 */
    const text = v || (attachments.length ? "（请分析所附图片）" : "");
    // 多会话并行：直接发送，不再排队
    lastUserText = text; send({ type: "chat", text, attachments, convId, skillId });
    if (attachments.length) termLine('<span class="tl-info">[附件] 已随消息发送 ' + attachments.length + " 张图片</span>");
  };
  window._doSend = doSend;   // 暴露全局引用供 setRunning / openConv 使用
  inputBox.querySelector("#btnSend").onclick = doSend;
  /* 输入框自适应高度：1 行起，最多 12 行后内部滚动 */
  const autoGrow = () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 12 * 20 + 4) + "px";
  };
  ta.addEventListener("input", autoGrow);
  ta.addEventListener("focus", () => inputBox.classList.add("focused"));
  ta.addEventListener("blur", () => inputBox.classList.remove("focused"));
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
    { cmd: "/explain", desc: t("apBindInputdescT59"), expand: "请阅读并解释当前打开的文件，说明其功能、关键逻辑和设计思路。" },
    { cmd: "/test", desc: t("apBindInputdescT60"), expand: "请为当前打开的文件生成单元测试，覆盖主要功能和边界情况。先查看项目中已有的测试风格并保持一致。" },
    { cmd: "/fix", desc: t("apBindInputdescT61"), expand: "请检查当前打开的文件中的错误和问题，并修复它们。先运行测试确认问题，修复后再验证。" },
    { cmd: "/refactor", desc: t("apBindInputdescT62"), expand: "请重构当前打开的文件，改善代码结构、可读性和可维护性，但不改变功能。改完跑测试验证。" },
    { cmd: "/review", desc: t("apBindInputdescT63"), expand: "请对当前打开的文件进行代码审查，指出潜在问题、改进建议和最佳实践。" },
    { cmd: "/docs", desc: t("apBindInputdescT64"), expand: "请为当前打开的文件生成文档注释（JSDoc/docstring 等），包括函数说明、参数和返回值。" },
    { cmd: "/optimize", desc: t("apBindInputdescT65"), expand: "请分析当前打开的文件的性能瓶颈，并提出和实施优化方案。改完验证功能不变。" },
    { cmd: "/compact", desc: t("apBindInputdescT66"), action: () => { send({ type: "compact.now" }); toast(t("apBindInputtoastT151")); } },
    { cmd: "/sediment", desc: t("apBindInputdescT67"), action: () => { typeof openSediment === "function" ? openSediment() : toast(t("apBindInputtoastT152")); } },
    { cmd: "/orchestrate", desc: t("apBindInputdescT68"), expand: "请把下面这个任务拆成可并行的子任务并用 orchestrate 派发：\n" },
  ];
  const slashMenu = document.createElement("div");
  slashMenu.className = "at-menu"; slashMenu.style.display = "none";
  document.body.appendChild(slashMenu);
  let slashIdx = 0, slashItems = [];
  const hideSlashMenu = () => { slashMenu.style.display = "none"; };
  const refreshSlashActive = () => slashMenu.querySelectorAll(".at-item").forEach((el, i) => el.classList.toggle("active", i === slashIdx));
  const pickSlash = (i) => {
    const it = slashItems[i]; if (!it) return;
    hideSlashMenu();
    if (it.action) { ta.value = ""; it.action(); ta.focus(); return; }
    ta.value = it.expand; ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  };
  const showSlashMenu = (items) => {
    slashItems = items; slashIdx = 0;
    if (!items.length) { hideSlashMenu(); return; }
    slashMenu.innerHTML = items.map((it, i) => '<div class="at-item' + (i === 0 ? " active" : "") + '" data-i="' + i + '"><span class="at-kind">' + t("apBindInputH34") + '</span>' + esc(it.cmd) + ' <span style="color:var(--text-dim)">' + esc(it.desc) + '</span></div>').join("");
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
          toast(t("apBindInputtoastT153"));
        } catch (err) { toast(t("apBindInputtoastT154") + err.message); }
      });
      return;
    }
    try {
      await fetch("/api/agent-settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: { mode } }),
      });
      const label = { ask: "逐项确认", semi: "半自动（安全操作放行，写入仍确认）", auto: "全自动（高危仍会拦截）" }[mode] || mode;
      toast(t("apBindInputtoastT155") + label);
    } catch (err) { toast(t("apBindInputtoastT154") + err.message); }
  };
  /* 行为模式（Agent / Plan / Ask）不再占输入栏：入口在命令面板与设置 → Agent 行为。
     这里只保留一个可编程切换的函数，服务端 agentMode 仍是唯一真源。 */
  window.setAgentMode = async function (mode) {
    if (mode !== "agent" && mode !== "plan" && mode !== "ask") return false;
    try {
      await fetch("/api/agent-settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentMode: mode }),
      });
      setAgentModeUI(mode);
      /* 整句一个键：原先是 t("模式 → ") + 中文 tip 的拼接，英文界面会切成半英半中 */
      const tip = t(mode === "plan" ? "modeToastPlan" : mode === "ask" ? "modeToastAsk" : "modeToastAgent");
      toast(tip);
      termLine('<span class="tl-info">' + tip + "</span>");
      return true;
    } catch (err) { termLine('<span class="tl-err">' + t("modeSwitchFail") + "：" + esc(err.message) + "</span>"); return false; }
  };

  wireModelPicker();

  // Skill 选择器
  const btnSkillPick = inputBox.querySelector("#btnSkillPick");
  const ciSkillPop = inputBox.querySelector("#ciSkillPop");
  if (btnSkillPick) {
    btnSkillPick.addEventListener("click", (e) => {
      e.stopPropagation();
      const show = ciSkillPop.style.display === "none";
      ciSkillPop.style.display = show ? "block" : "none";
      if (show) {
        renderSkillPop();
        // Skill 按钮靠左，360px 的窗口往右长会顶出窗口把列表裁掉：按实测可用宽度收窄，
        // 窄到放不下就改从右侧对齐往左长。
        const left = ciSkillPop.getBoundingClientRect().left;
        const avail = window.innerWidth - left - 14;
        if (avail < 260) {
          ciSkillPop.style.left = "auto";
          ciSkillPop.style.right = "0";
          ciSkillPop.style.maxWidth = Math.min(360, window.innerWidth - 24) + "px";
        } else {
          ciSkillPop.style.left = "0";
          ciSkillPop.style.right = "auto";
          ciSkillPop.style.maxWidth = Math.min(360, avail) + "px";
        }
      }
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
function saveConvDom(id, html) { return lsSet(convDomKey(id), html); }
function loadConvDom(id) { try { return lsGet(convDomKey(id)) || ""; } catch (e) { return ""; } }
function deleteConvDom(id) { try { localStorage.removeItem(convDomKey(id)); } catch (e) {} }
let convId = null;
let convObs = null;

function loadConvList() {
  let list;
  try { list = JSON.parse(lsGet(convListKey())) || []; } catch (e) { list = []; }
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
  return lsSet(convListKey(), JSON.stringify(list));
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

function loadPinnedConvs() { try { return JSON.parse(lsGet("pancode:pinned:" + _wsHash()) || "[]"); } catch (e) { return []; } }
function savePinnedConvs(arr) { return lsSet("pancode:pinned:" + _wsHash(), JSON.stringify(arr)); }
function convTimeGroup(ts) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= todayStart) return 0;
  if (ts >= todayStart - 86400000) return 1;
  if (ts >= todayStart - 7 * 86400000) return 2;
  return 3;
}
/* 分组标题按当前语言现取：写成常量数组的话，切语言后侧栏还钉着"今天" */
const CONV_GROUP_KEYS = ["convGroupToday", "convGroupYesterday", "convGroupWeek", "convGroupEarlier"];
function convSummary(c) {
  if (c.id === convId && state.convRunning[c.id]) return { tag: "running", text: t("convGroupRunning", { n: state.round || 1 }) };
  if (state.convRunning[c.id]) return { tag: "running", text: t("running") };
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

  renderGroup(pinnedItems.length ? t("convGroupPinned") : "", pinnedItems);

  // 按时间分组
  const groups = [[], [], [], []];
  restItems.forEach((c) => { groups[convTimeGroup(c.ts)].push(c); });
  groups.forEach((items, gi) => renderGroup(items.length ? t(CONV_GROUP_KEYS[gi]) : "", items));

  replaceIcons();
  if (gridMode) applyLayout();   // W22：运行态/时间排序变了，网格里的格序与运行点跟着刷新
}

function buildConvItem(c, isPinned) {
  const item = document.createElement("div");
  item.className = "ag-session" + (c.id === convId ? " active" : "") + (isPinned ? " pinned" : "");
  const d = new Date(c.ts);
  const meta = (d.getMonth() + 1) + "/" + d.getDate() + " " +
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const sm = convSummary(c);
  const smHtml = sm.text ? '<div class="ag-sess-summary">' +
    (sm.tag === "running" ? '<span class="ss-tag running">' + t("apBuildConvItemH35") + '</span>' : "") +
    esc(sm.text) + '</div>' : "";
  item.innerHTML =
    '<span class="ag-sess-dot' + (c.id === convId ? "" : " done") + '" title="' + escHtml(c.id === convId ? t("sessRunning") : t("sessHistory")) + '"></span>' +
    '<div class="ag-sess-main">' +
      '<div class="ag-sess-name">' + esc(c.title || t("convUntitled")) + '</div>' +
      '<div class="ag-sess-meta">' + meta + '</div>' +
      smHtml +
    '</div>' +
    '<button class="ag-sess-pin" title="' + escHtml(t("sessPinTip")) + '"><i data-ico="pin"></i></button>' +
    '<button class="ag-sess-del" title="' + escHtml(t("sessDelTip")) + '"><i data-ico="close"></i></button>';
  item.querySelector(".ag-sess-name").ondblclick = (e) => { e.stopPropagation(); var newName = prompt(t("convNamePrompt"), c.title || t("convUntitled")); if (newName && newName.trim()) { c.title = newName.trim(); var l2 = loadConvList(); var f = l2.find(function(x){return x.id===c.id;}); if(f){f.title=newName.trim();saveConvList(l2);} renderConvList(); } };
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
    { label: pinned.includes(c.id) ? t("convUnpin") : t("convPin"), action: () => togglePinConv(c.id) },
    { label: t("rename"), action: () => { var n = prompt(t("convNamePrompt"), c.title || t("convUntitled")); if (n && n.trim()) { var l = loadConvList(); var f = l.find(function(x){return x.id===c.id;}); if(f){f.title=n.trim();saveConvList(l);renderConvList();} } } },
    { label: t("apShowConvCtxMenulabelT69"), action: () => { navigator.clipboard && navigator.clipboard.writeText(c.title || t("convUntitled")); } },
    { label: t("apShowConvCtxMenulabelT70"), action: () => { var blob = new Blob([loadConvDom(c.id) || ""], {type:"text/html"}); var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (c.title||t("convUntitled")) + ".html"; a.click(); } },
    { label: t("delete"), danger: true, action: () => deleteConv(c.id) },
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
  if (id === convId) { applyLayout(); return; }   // 网格模式下重复点击本会话：只刷新布局
  if (goalMode) setGoalMode(false);   // 切换会话时退出 goal 模式
  persistConv();                       // 切走前保存当前会话 pane
  convId = id;
  localStorage.setItem(convActiveKey(), id);
  send({ type: "switchConv", convId: id });   // C6：同步切换服务端 AI 上下文
  send({ type: "ctx.query" });
  loadTraceHistory(id);
  loadArtifactsHistory(id);                     // W6：切换会话恢复产物清单

  // 多会话并行：pane 内存中有则直接 move 挂载；无（刷新后首次打开）则从快照 hydrate
  const c = loadConvList().find((x) => x.id === id);
  if (!convPanes[id]) hydratePane(id, (c && loadConvDom(id)) || "");
  applyLayout();   // W22：单视图与网格共用这一个挂载入口
  foldOldMessages();
  scrollChat();
  buildMsgNav();
  refreshCtx();
  loadPlan(convId);                                                      // 切换该会话的任务计划
  renderOrchHistory();                                                   // 编排历史只看本会话
  renderConvList();
  replaceIcons();
  // 多会话并行：切换后更新全局 running 状态与按钮
  state.running = !!state.convRunning[convId];
  const btn = inputBox.querySelector("#btnSend");
  if (btn) {
    if (state.running) {
      btn.innerHTML = ico("stopSq");
      btn.title = t("apSetRunningtitleT51");
      btn.classList.add("stop-mode");
      btn.onclick = () => { if (goalMode) { setGoalMode(false); toast(t("apSetRunningtoastT143")); } send({ type: "abort", convId }); };
    } else {
      btn.innerHTML = ico("sendUp");
      btn.title = t("sendTip");
      btn.classList.remove("stop-mode");
      btn.onclick = window._doSend || (() => {});
    }
  }
}

/* ---------- W22 · 多会话网格视图 ----------
   对齐 Codex App 的并行会话网格：一个开关把最近/运行中的会话 pane 并排挂进
   #chatStream（CSS grid），每格独立滚动、带头部（标题 + 运行点 + 点击聚焦）。
   事件路由零改动：后台会话的写入本来就落在各自 pane（withConv），网格只是
   把"一次只挂一个"放宽成"按序多挂"。输入/发送仍作用于聚焦的那个会话。
   状态全部可从 DOM 与 loadConvList 推导，切换/刷新零额外恢复逻辑。 */
const GRID_KEY = "cw-grid-mode";
const GRID_MAX = 6;
let gridMode = localStorage.getItem(GRID_KEY) === "1";

/* 统一挂载入口：单视图 = 仅活跃 pane；网格 = 有内容的会话并排挂载并刷新各格头部 */
function applyLayout() {
  if (!gridMode || typeof chatPane !== "function") {
    chatStream.classList.remove("grid-on");
    mountPane(convId);
    return;
  }
  chatStream.classList.add("grid-on");
  const titles = {};
  loadConvList().forEach((c) => { titles[c.id] = c.title || t("convUntitled"); });
  const ids0 = (() => {
    const ids = loadConvList().sort((a, b) => b.ts - a.ts).map((c) => c.id);
    const run = ids.filter((id) => state.convRunning[id]);
    const rest = ids.filter((id) => run.indexOf(id) < 0);
    const out = run.concat(rest);
    if (convId && out.indexOf(convId) < 0) out.unshift(convId);
    return out;
  })();
  /* 先从快照恢复再过滤：网格里非活跃 pane 若不 hydrate 就是空壳，
     直接按"有没有消息"过滤会把有内容的历史会话全判成空（实测整屏空格子）。
     hydrate 上限 24 个：再多先不恢复，等真正进入前 6 格的才需要内容。 */
  const hydrated = ids0.slice(0, 24).map((id) => {
    const ctx = ensureConvCtx(id);
    if (!ctx.pane.childNodes.length) hydratePane(id, loadConvDom(id) || "");
    return id;
  });
  const hasContent = (id) => {
    const p = convPanes[id];
    return !!(id === convId || (p && p.querySelector(".msg-user, .tool-card, .round-grp")));
  };
  const ids = hydrated.filter((id) => hasContent(id)).slice(0, GRID_MAX);
  if (convId && ids.indexOf(convId) < 0) ids.unshift(convId);
  for (const child of Array.from(chatStream.children)) {
    if (child.classList && child.classList.contains("conv-pane") && ids.indexOf(child.dataset.convId) < 0) {
      chatStream.removeChild(child);
    }
  }
  ids.forEach((id) => {
    const ctx = ensureConvCtx(id);
    let head = ctx.pane.querySelector(":scope > .gp-head");
    if (!head) {
      head = document.createElement("div");
      head.className = "gp-head";
      head.innerHTML = '<span class="gp-dot"></span><span class="gp-title"></span><span class="gp-focus">' + ico("target") + "</span>";
      head.onclick = () => openConv(id);
      ctx.pane.insertBefore(head, ctx.pane.firstChild);
    }
    head.querySelector(".gp-title").textContent = titles[id] || t("convUntitled");
    ctx.pane.classList.toggle("grid-active", id === convId);
    ctx.pane.classList.toggle("grid-running", !!state.convRunning[id]);
    if (ctx.pane.parentNode !== chatStream) chatStream.appendChild(ctx.pane);
  });
  replaceIcons();
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

/* 托盘点了某条任务：唤回窗口 + 切到 Agents + 打开那条会话。
   主进程那边已经排过队（页面没就绪会补发），所以这里能假定应用已经起来。 */
if (window.pancodeWin && typeof window.pancodeWin.onOpenConv === "function") {
  window.pancodeWin.onOpenConv((id) => {
    if (!id) return;
    try { if (state.mode !== "agents") switchMode("agents"); } catch (e) {}
    try { openConv(id); } catch (e) { console.warn("[ui] 托盘跳会话失败 " + id + "：" + (e && e.message)); }
  });
}

function startNewConv(announce) {
  convId = genConvId();
  localStorage.setItem(convActiveKey(), convId);
  const list = loadConvList();
  list.unshift({ id: convId, title: t("apStartNewConvtitleT71"), ts: Date.now() });
  saveConvList(list);
  clearPlanPanel();                  // 新会话无任务计划
  _orchScope = "conv";               // 新会话的编排历史必然是空的，别带着「全部」视图过来
  renderOrchHistory();               // 编排历史跟着会话走
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
    applyLayout();
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

  /* W22 网格开关：切换并记住偏好；回单视图时只保留活跃 pane */
  const gv = $("btnGridView");
  if (gv) {
    gv.classList.toggle("on", gridMode);
    gv.onclick = () => {
      gridMode = !gridMode;
      localStorage.setItem(GRID_KEY, gridMode ? "1" : "0");
      gv.classList.toggle("on", gridMode);
      applyLayout();
      scrollChat();
    };
  }

  const tog = $("btnToggleOrchHist");
  if (tog) tog.onclick = function () {
    const panel = $("agOrchHistory");
    if (!panel) return;
    panel.style.display = panel.style.display === "none" ? "" : "none";
    tog.querySelector("i").style.transform = panel.style.display === "none" ? "rotate(-90deg)" : "";
  };
})();


$("btnReset").onclick = () => {
  if (state.running) { toast(t("apNewConversationtoastT157")); return; }
  const n = state.dirty ? state.dirty.size : 0;
  showConfirm("还原工作区",
    "将丢弃全部未保存的更改" + (n ? "（当前有 <b>" + n + "</b> 个文件存在未保存编辑）" : "") +
    "，并恢复到 Git / 快照基线。<br><b style=\"color:var(--err)\">此操作不可撤销</b>，确定要继续吗？",
    () => {
      if (state.dirty) state.dirty.clear();
      send({ type: "reset" });
      toast(t("apNewConversationtoastT158"));
    });
};

/* ---------------- 全局快捷键 ---------------- */
/* ---------------- Ctrl+Shift+P 命令面板 ---------------- */
function aiCurrentFile(text) {
  if (!state.activeFile) { toast(t("apAiCurrentFiletoastT159")); return; }
  aiFileAction(state.activeFile, text);
}
function openFilePalette() {
  const existing = $("filePalette");
  if (existing) { existing.remove(); return; }
  const files = Object.keys(state.files).sort();
  const pal = document.createElement("div");
  pal.id = "filePalette";
  pal.innerHTML = '<input class="cmd-input" placeholder="' + esc(t("palFileJumpPh")) + '" /><div class="cmd-list"></div>';
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
  /* Ctrl+Shift+P 只归命令面板（js/cmdk.js 里绑的同一条键）。
     这里原先还开了一份旧的面板（#cmdPalette）：同一次按键叠出两个面板，
     后插入 body 的那份盖在前面那份上面，鼠标点下面那份永远被"拦截 pointer events"。
     旧面板独有的命令（新建文件夹 / 关闭标签 / 新建对话 / 五条 AI 命令）已并入 cmdk。 */
  else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "P" || e.key === "p")) { e.preventDefault(); }
  else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "p" || e.key === "P")) { e.preventDefault(); openFilePalette(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === "w" || e.key === "W")) { e.preventDefault(); if (state.activeFile) closeTab(state.activeFile); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === "." || e.code === "Period")) {
    e.preventDefault();
    const target = state.mode === "editor" ? "agents" : "editor";
    switchMode(target);
    toast(t("apOpenFilePalettetoastT160") + (target === "editor" ? t("apopenFilePaletteC27") : "Agents") + t("apopenFilePaletteC28"));
  }
});


/* ---------------- 用户认证 ----------------
   token 与用户名一并存：勾选"记住我"落 localStorage，否则 sessionStorage。
   用户名也存是因为 /api/auth/status 是异步的——不存的话顶栏每次刷新都会先闪一下"未登录"。 */
const userAuth = {
  token: localStorage.getItem("cw-user-token") || sessionStorage.getItem("cw-user-token") || "",
  username: localStorage.getItem("cw-user-name") || sessionStorage.getItem("cw-user-name") || "",
};
function rememberToken(token, username, persist) {
  for (const st of [localStorage, sessionStorage]) { st.removeItem("cw-user-token"); st.removeItem("cw-user-name"); }
  const store = persist ? localStorage : sessionStorage;
  if (token) store.setItem("cw-user-token", token);
  if (username) store.setItem("cw-user-name", username);
}
function setAuthUserUI(name) {
  const txt = $("tbUserTxt"), btn = $("tbUserBtn");
  if (!txt || !btn) return;
  txt.textContent = name || t("notLoggedIn");
  btn.classList.toggle("logged", !!name);
}
setAuthUserUI(userAuth.username);
/* 这段文字是 JS 写的，不能挂 data-i18n：applyI18n 会把每个 [data-i18n] 的 textContent 无条件刷成
   词条，切一次语言就把已登录的用户名刷回"未登录"（截图目视抓到的，是个假状态，不只是没翻译）。 */
if (typeof onLang === "function") onLang(() => setAuthUserUI(userAuth.username));

async function checkAuth() {
  if (!userAuth.token) { setAuthUserUI(""); return false; }
  let r = null;
  try { r = await fetch("/api/auth/status", { headers: { "x-user-token": userAuth.token || "" } }).then((x) => x.json()); }
  catch (e) { return true; }   // 服务没起来 ≠ 凭据无效：不清掉用户存好的 token
  if (typeof r.hasUsers === "boolean") HAS_USERS = r.hasUsers;
  if (r && r.loggedIn) {
    userAuth.username = r.username || userAuth.username;
    AUTH.token = userAuth.token;
    setAuthUserUI(userAuth.username);
    return true;
  }
  userAuth.token = ""; userAuth.username = ""; AUTH.token = "";
  rememberToken("", "", false);
  setAuthUserUI("");
  return false;
}

window.doLogout = async function () {
  try { await fetch("/api/auth/logout", { method: "POST", headers: { "x-user-token": userAuth.token || "" } }); } catch (e) {}
  rememberToken("", "", false);
  userAuth.token = ""; userAuth.username = ""; AUTH.token = "";
  location.reload();
};

/* W25 个人模式静默身份：GET /api/auth/auto 向本机服务领身份（服务端保证仅
   TCP 回环可达；多账号时返回 multiUser，这里回退登录弹窗）。
   成功路径与 submitAuth 同款赋值：token 落 localStorage（等同"记住我"），
   下次启动 checkAuth 直接通过，不再有任何弹窗。 */
async function autoLogin() {
  try {
    const r = await fetch("/api/auth/auto").then((x) => x.json());
    if (!r || !r.ok || !r.token) return false;
    userAuth.token = r.token; userAuth.username = r.username || "local"; AUTH.token = r.token;
    rememberToken(r.token, userAuth.username, true);
    setAuthUserUI(userAuth.username);
    return true;
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
/* 词条必须现取，不能在脚本加载时算好存着：那样英文界面下打开登录框，
   标题/按钮会停在开机那一刻的语言。 */
function authText(mode) {
  return mode === "register"
    ? { title: t("apSetAuthUserUItitleT72"), sub: t("apSetAuthUserUIsubT2"), submit: t("authSubmitRegister"), switchLabel: t("authSwitchToLogin"), switchBtn: t("authBtnLogin") }
    : { title: t("authWelcome"), sub: t("authSub"), submit: t("authSubmitLogin"), switchLabel: t("authSwitchToRegister"), switchBtn: t("authBtnRegister") };
}
function paintAuthMode() {
  const t = authText(authMode);
  $("authTitle").textContent = t.title;
  $("authSub").textContent = t.sub;
  $("authSubmit").textContent = t.submit;
  $("authSwitchLabel").textContent = t.switchLabel;
  $("authSwitch").textContent = t.switchBtn;
  const st = $("authStatus");
  st.textContent = ""; st.className = "auth-status";
}
$("authSwitch").onclick = () => { authMode = authMode === "login" ? "register" : "login"; paintAuthMode(); };
function authModeSwitch(mode) { authMode = mode === "register" ? "register" : "login"; paintAuthMode(); }
/* 这几个字段挂了 data-i18n，静态扫描会把它们刷回"登录"那套；注册模式正开着时要按当前模式重画。
   onLang 的回调在 applyI18n 之后跑，所以这里覆盖得到。 */
if (typeof onLang === "function") onLang(() => {
  const m = $("authModal");
  if (m && m.style.display && m.style.display !== "none") paintAuthMode();
});

function authFail(msg) {
  const st = $("authStatus");
  st.className = "auth-status err";
  st.textContent = msg;
}
async function submitAuth() {
  const u = $("authUser").value.trim(), p = $("authPass").value;
  if (!u || !p) { authFail("请填写用户名和密码"); return; }
  const btn = $("authSubmit");
  const label = AUTH_TEXT[authMode].submit;
  btn.disabled = true; btn.classList.add("loading"); btn.textContent = label + "中…";
  try {
    const r = await fetch(authMode === "login" ? "/api/auth/login" : "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: u, password: p }),
    }).then((x) => x.json());
    if (r.ok) {
      const persist = !($("authRemember") && $("authRemember").checked === false);
      userAuth.token = r.token; userAuth.username = r.username; AUTH.token = r.token;
      rememberToken(r.token, r.username, persist);
      setAuthUserUI(r.username);
      $("authModal").style.display = "none";
      _authRedirected = false;
      toast(authMode === "login" ? t("apAuthFailtoastT161") + r.username : t("apsubmitAuthC29") + r.username);
      startApp(); maybeOnboard();   // 登录后才加载工作区数据并连接 WS，并触发首次引导
    } else {
      authFail(r.error || "失败");
      if (authMode === "login" && r.noUser) { $("authUser").value = ""; $("authUser").focus(); }
    }
  } catch (e) { authFail("请求异常：" + e.message); }
  finally { btn.disabled = false; btn.classList.remove("loading"); btn.textContent = label; }
}
$("authSubmit").onclick = submitAuth;
["authUser", "authPass"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitAuth(); } });
});
if (userAuth.username) { const au = $("authUser"); if (au) au.value = userAuth.username; }

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
  const done = plan.tasks.filter((k) => k.status === "done" || k.status === "skipped").length;
  const total = plan.tasks.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const statusLabel = plan.status === "completed" ? t("planStatusDone") : t("planStatusActive");
  const statusClass = plan.status === "completed" ? "done" : "active";
  let html = "";
  // Goal 卡片（Goal 模式激活时在计划顶部显示）
  if (goalMode) {
    html += '<div class="plan-goal">' +
      '<div class="plan-goal-title">' + ico("target") + '<span>' + t("apRenderPlanH36") + '</span></div>' +
      '<div class="plan-goal-text">' + esc(plan.title) + '</div>' +
      '<div class="plan-goal-bar"><div class="plan-goal-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="plan-goal-meta"><span>' + t("planStepsDone", { done: done, total: total }) + '</span><span>' + pct + '%</span></div>' +
      '</div>';
  }
  html += '<div class="plan-title">' + ico("tasklist") + '<span>' + esc(plan.title) + '</span><span class="plan-status ' + statusClass + '">' + statusLabel + '</span></div>';
  plan.tasks.forEach((task, i) => {
    const cls = task.status;
    const icon = task.status === "done" ? "✓" : task.status === "in_progress" ? "●" : task.status === "skipped" ? "×" : "";
    html += '<div class="plan-task ' + cls + '" data-idx="' + i + '"><span class="plan-check">' + icon + '</span><span class="plan-text">' + esc(task.text) + (task.note ? ' <span style="color:var(--text-dim);font-size:10px">(' + esc(task.note) + ')</span>' : "") + '</span></div>';
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
  paintPlanBar(plan, done, total, pct);
  // C1a：同步常驻进度条（计划进行中显示，完成则隐藏）
  const sticky = $("planSticky");
  if (sticky) {
    if (!plan || plan.status === "completed") sticky.hidden = true;
    else {
      sticky.hidden = false;
      sticky.innerHTML = '<span class="ps-title">' + ico("tasklist") + t("planProgress") + '</span>' +
        '<span class="ps-count">' + done + '/' + total + '</span>' +
        '<div class="ps-bar"><div class="ps-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="ps-pct">' + pct + '%</span>';
      replaceIcons(sticky);
    }
  }
  // Goal 模式：计划全部完成时自动退出
  if (goalMode && plan.status === "completed") {
    setGoalMode(false);
    toast(t("apRenderPlantoastT162"));
  }
}

/* 输入框上方的计划条：常驻一行显示 x/y + 进度，点开才摊出清单（侧栏省出一整段） */
function paintPlanBar(plan, done, total, pct) {
  const bar = $("planBar");
  if (!bar) return;
  bar.hidden = false;
  const count = $("planBarCount"), fill = $("planBarFill"), pctEl = $("planBarPct");
  if (count) count.textContent = done + "/" + total;
  if (fill) fill.style.width = pct + "%";
  if (pctEl) pctEl.textContent = pct + "%";
  bar.classList.toggle("completed", plan.status === "completed");
}

function closePlanPop() {
  const pop = $("planPop"), bar = $("planBar"), btn = $("btnPlanToggle");
  if (pop) pop.classList.add("hidden");
  if (bar) bar.classList.remove("open");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function togglePlanPop() {
  const pop = $("planPop"), bar = $("planBar"), btn = $("btnPlanToggle");
  if (!pop || !bar) return;
  const open = pop.classList.toggle("hidden") === false;
  bar.classList.toggle("open", open);
  if (btn) btn.setAttribute("aria-expanded", String(open));
  if (open) replaceIcons(pop);
}

function clearPlanPanel() {
  const box = $("agPlanEmpty"), active = $("agPlanActive"), sticky = $("planSticky"), bar = $("planBar");
  if (box) box.style.display = "block";
  if (active) { active.style.display = "none"; active.innerHTML = ""; }
  if (sticky) sticky.hidden = true;
  if (bar) bar.hidden = true;   // 摊着的清单跟着收起，否则切到无计划的会话再切回来会是空壳
  closePlanPop();
}
async function loadPlan(cid) {
  const id = cid || convId || "default";
  try {
    const r = await fetch("/api/plans?convId=" + encodeURIComponent(id)).then((x) => x.json());
    if (r.active) renderPlan(r.active); else clearPlanPanel();
  } catch (e) {}
}

/* 计划条交互：按钮开合清单，点别处收起（跟弹层一致的 mainstream 语义） */
(function () {
  const btn = $("btnPlanToggle"), bar = $("planBar");
  if (btn) btn.onclick = (e) => { e.stopPropagation(); togglePlanPop(); };
  if (bar) bar.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { if (bar && !bar.hidden) closePlanPop(); });
})();

/* ---------------- Goal 模式（续跑判定在服务端，见 agent-llm.js 的 goal 预算块） ---------------- */
let goalMode = false;
let goalPollTimer = null;
let currentPlan = null;        // renderPlan 时缓存，供进度展示读取
let goalText = "";             // 当前目标文本（服务端回推 goal.set 时同步）

/* 换语言后这些"JS 现造"的界面要跟着重绘 —— 注册点必须落在 currentPlan 之后：
   onLang 会立刻调一次回调，而 let 声明在那之前会抛 TDZ（外层 try/catch 把它吞成"没重绘"）。 */
if (typeof onLang === "function") {
  onLang(() => { if (currentPlan) renderPlan(currentPlan); });
  onLang(() => { if (state.mode === "agents") renderConvList(); });
  /* 编排历史的空态/范围行是 JS 现造的，切语言要重画。但 onLang 注册即执行一次，
     那一刻 token 还没落地，去拉 /api/orch/history 只会给自己挣一条 401 —— 已经画过东西才重画。 */
  onLang(() => { const h = $("agOrchHistory"); if (h && h.children.length) renderOrchHistory(); });
}

function setGoalMode(active) {
  goalMode = active;
  const btn = $("btnGoal");
  if (btn) btn.classList.toggle("active", active);
  if (!active) {
    if (goalPollTimer) { clearInterval(goalPollTimer); goalPollTimer = null; }
    goalText = "";
    if (typeof renderGoalBanner === "function") renderGoalBanner("");
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
  goalMode = true; goalText = goal;
  const btn = $("btnGoal"); if (btn) btn.classList.add("active");
  // 只把目标交给服务端，由服务端写 _goal、建预算、并在每轮 agent.done 后判定是否续跑。
  send({ type: "goal.set", goal, convId });
  if (typeof renderGoalBanner === "function") {
    renderGoalBanner(ico("target") + '<span class="gb-txt">' + t("apSetGoalModeH37") + '</span><b>' + esc(goal.slice(0, 60)) + (goal.length > 60 ? "…" : "") + "</b>"
      + '<span class="gb-turn">' + t("apSetGoalModeH38") + '</span><button class="gb-stop" id="gbStop">' + t("apHandleEventInnerH23") + '</button>');
    const s = $("gbStop"); if (s) s.onclick = stopGoal;
  }
  toast(t("apSetGoalModetoastT163"));
};

function stopGoal() {
  send({ type: "goal.clear", convId });
  setGoalMode(false);
  toast(t("apStopGoaltoastT164"));
}


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
    /* 终端首行那句介绍带工作区目录名，是拼出来的，[data-i18n] 覆盖不到：
       注册成切语言时重算，切过去就立刻变色，不用等下一次终端输出。 */
    if (typeof window.onLang === "function") window.onLang(function () {
      document.querySelectorAll(".term-intro").forEach(function (el) {
        el.textContent = t("terminalIntro", { dir: state.project || "workspace" });
      });
    });
  }
})();

/* 状态栏、引擎胶囊、环境面板、进程计数这些都是 JS 按事件画的：切语言时按现有数据重画一遍，
   否则用户切完语言看到的还是旧语言，要等下一次 git / 光标 / perf 事件才变色。 */
if (typeof onLang === "function") onLang(() => {
  if (state.engine) { try { applyEngineInfo(state.engine); } catch (e) {} }
  try { renderChanges(); } catch (e) {}
  /* 顺序有讲究：renderEnvPanel 是把 #sbBranch 的文案抄进 #envBranch 的，
     先重绘环境面板就会把旧语言的"无 Git（快照基线）"抄过去，英文界面留下一条中文。 */
  const br = $("sbBranch");
  if (br) br.textContent = state.noGit ? t("noGitBaseline") : (state.branchName || br.textContent);
  try { renderEnvPanel(); } catch (e) {}
  if (typeof updateSbProcs === "function") { try { updateSbProcs(); } catch (e) {} }
  try { paintSbEld(); } catch (e) {}
  const pos = editor ? editor.getPosition() : null;
  if (pos) $("sbCursor").textContent = t("sbCursor", { line: pos.lineNumber, col: pos.column });
  if (state.workspace) $("btnOpenFolder").title = t("wsOpenTip", { ws: state.workspace });
});

/* ---------------- 启动 ---------------- */
applyTheme(getThemePref());
$("hpClose").onclick = () => togglePreview(false);
if ($("agTabChanges")) $("agTabChanges").onclick = () => switchAgOutTab("changes");     // W6 产物/变更 tab
if ($("agTabArtifacts")) $("agTabArtifacts").onclick = () => switchAgOutTab("artifacts");
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
  renderOrchHistory();   // 登录态已就绪（AUTH.token 已由 bootstrap/checkAuth 填好），此时才拉编排历史
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
  let loggedIn = await checkAuth();
  /* W25 个人模式：没有有效会话时先向本机服务静默领身份（免注册免登录）。
     只有服务端拒绝（users.json 里多于一个账号）才弹出登录框。 */
  if (!loggedIn) loggedIn = await autoLogin();
  checkApiStamp();
  hideBoot();
  if (loggedIn) { startApp(); maybeOnboard(); }
  else showAuthModal();
}).catch(() => { hideBoot(); showAuthModal(); });
bootMonaco();
