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
  saveSeq: 0,           // 保存请求序号：ack 要能对上是哪一次内容落了盘
  pendingSaves: {},     // path -> [{seq, content}] 已发出、还没收到 ack 的保存
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
  /* F15：目录是分页的，正文是按需的。
     tree = 服务端最近一次告诉我们的目录概况（总数/已列/还有没有下一页），
     changed = 一次 git status 的变更集，界面所有"改过的"徽标与改动面板都以它为准，
     files[path].content/original 只有"加载过"才存在——没有它不等于文件是空的。 */
  tree: { total: 0, listed: 0, more: false, truncated: false },
  changed: [],
};
let editor = null, diffEditor = null;
const models = {};

function modifiedSet() {
  /* F15 之前这里是"逐个文件比 content !== original"——那是首屏要拿到全部正文的原因。
     现在正文按需取，改没改由服务端的变更集（一次 git status）说，本地只看脏标记。
     两条来源并起来：服务端报的 M/A/D + 用户正在编辑器里没存的东西。 */
  const s = new Set();
  for (const c of (state.changed || [])) if (c && c.path) s.add(c.path);
  state.dirty.forEach((p) => s.add(p));
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

/* F17：热 pane 有界。切过的每一个会话都把整块 DOM 留在 convPanes 里 ——
   从页面摘下来（隐藏）并不等于释放，24 次往返就是 24 块常驻。
   这里只保留最近用过的 HOT_PANES 块，其余在摘掉前已经把正文写进快照，
   切回去时走 hydratePane 复原。正在跑的、当前在看、以及还挂在页面上的（网格）都不摘。 */
const HOT_PANES = 8;
const _paneLru = [];
function notePaneUse(id) {
  if (!id) return;
  const i = _paneLru.indexOf(id);
  if (i >= 0) _paneLru.splice(i, 1);
  _paneLru.push(id);
  while (_paneLru.length > 64) _paneLru.shift();   // 索引自身收敛，别变成新的泄漏点
}
function dropConvCtx(id) {
  const p = convPanes[id];
  if (p && p.parentNode) p.parentNode.removeChild(p);
  delete convPanes[id]; delete convBlocks[id]; delete convMeta[id];
  if (convPersistTimers[id]) { clearTimeout(convPersistTimers[id]); delete convPersistTimers[id]; }
  const i = _paneLru.indexOf(id);
  if (i >= 0) _paneLru.splice(i, 1);
}
function evictHotPanes() {
  let over = Object.keys(convPanes).length - HOT_PANES;
  if (over <= 0) return;
  for (const id of _paneLru.slice()) {
    if (over <= 0) break;
    if (id === convId || state.convRunning[id]) continue;
    const p = convPanes[id];
    if (!p || p.parentNode) continue;              // 还挂在页面上的（网格里同时显示好几块）不动
    persistConv(id);                               // 摘之前先落快照，正文不跟着 DOM 一起没
    dropConvCtx(id);
    over--;
  }
}

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
  notePaneUse(cvid);
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
  if (!ctx.pane.childNodes.length && html) {
    ctx.pane.innerHTML = html;
    /* 修复前落下的快照可能是"widget 块只画成代码"的降级形态，恢复时按原文重建卡片 */
    if (typeof upgradeWidgetCodeBlocks === "function") upgradeWidgetCodeBlocks(ctx.pane);
  }
  sweepEmptyRoundChildren(ctx.pane);
  return ctx.pane;
}

/* 扫掉轮次组里完全空的子节点：历史会话快照里可能存着空占位 div（实时渲染时
   finalizeRoundGrp 已清，但旧快照是清理前存的），恢复时再清一遍。 */
function sweepEmptyRoundChildren(pane) {
  if (!pane) return;
  pane.querySelectorAll(".round-grp").forEach((g) => {
    const body = g.querySelector(".rg-body");
    if (!body) return;
    Array.from(body.children).forEach((c) => {
      if ((c.textContent || "").trim()) return;
      if (c.querySelector("img,video,canvas,svg")) return;
      c.remove();
    });
  });
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
  '<button id="btnScrollBottom" class="chat-scroll-btn" data-i18n-title="scrollBottomTip" title="滚动到底部">' + ico("arrowDown") + '<span class="scroll-badge"></span></button>';
// 滚动按钮钉在 .chat-slot（不随内容滚动的祖先）上，见 mountShared：
// 挂在 #chatStream 里时它是滚动容器的绝对定位子节点，会跟着内容一起滚，
// 结果两个按钮跑到某条回答中间，既挡字也点不到。


const inputBox = document.createElement("div");
inputBox.id = "chatInputBox";
inputBox.innerHTML =

  '<div id="ciChips" class="ci-chips"></div>' +
  '<div id="ciSkillActive" class="ci-skill-active" style="display:none"></div>' +
  '<textarea id="chatInput" rows="3" autocomplete="off" autocorrect="off" data-i18n-ph="inputPlaceholder" placeholder="描述你要 Agent 完成的改动，Enter 发送 / Shift+Enter 换行；@ 引用文件，/ 唤起命令…" spellcheck="false"></textarea>' +
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
          '<option value="acceptEdits" data-i18n="permOptAcceptEdits">接受编辑</option>' +
          '<option value="smart" data-i18n="permOptSmart">智能判定</option>' +
          '<option value="auto" data-i18n="permOptAuto">完全访问</option>' +
          '<option value="dontAsk" data-i18n="permOptDontAsk">不再询问</option>' +
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
      const f = state.files[p] || {};
      /* F15：改过的文件里只有"变更集那一撮"带着正文（首屏 warm）。
         没带正文的就只报"M"，不要拿两份空字符串去 diffStat 算出"+0 −0"骗人。 */
      if (typeof f.content !== "string" || typeof f.original !== "string") {
        return '<span class="ft-change" data-path="' + esc(p) + '" title="' + escHtml(t("ftModPendingTip")) + '">' +
          '<span class="ft-c-add">M</span></span>';
      }
      const st = diffStat(f.original, f.content);
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
  /* F15：目录是分页的。旧实现撞满 500 就再也不提后面有什么 ——
     界面上"看起来就是这个项目只有 500 个文件"，而第 501 个既找不到也点不开。
     现在把差额明写在树尾，点一下才要下一页。 */
  const tinfo = state.tree || {};
  const rest = Math.max(0, (Number(tinfo.total) || 0) - Object.keys(state.files).length);
  if (tinfo.more || rest > 0 || tinfo.truncated) {
    const more = document.createElement("div");
    more.className = "ft-item ft-more";
    more.innerHTML = '<span class="ft-more-ico">' + ico("chevD") + '</span><span>' +
      (rest > 0 ? "还有 " + rest + " 个文件没列出（共 " + tinfo.total + "）" : "目录可能没列全") +
      ' · <b>加载更多</b></span>';
    more.onclick = loadMoreTree;
    tree.appendChild(more);
  }
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
        showBox(sel, selectedText, beforeText, afterText, filePath, lang, model);
      });
      /* model 必须由调用方传进来：它是上面快捷键回调里的局部变量，showBox 的词法作用域看不到。
         接受时要用它判断"请求发出后目标文件有没有被换掉"。 */
      function showBox(sel, selectedText, beforeText, afterText, filePath, lang, model) {
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
          /* 发请求时捕获的 model / 选区可能已经过期：切了文件、或选区文字被改动。
             这时宁可拒绝并说清楚，也不能把结果写进另一个 model 或错位区间。 */
          if (!model || model.isDisposed() || editor.getModel() !== model) {
            title.textContent = t("ieTargetChanged");
            return;
          }
          if (model.getValueInRange(sel) !== selectedText) {
            title.textContent = t("ieTargetChanged");
            return;
          }
          editor.executeEdits("inline-edit", [{ range: sel, text: modifiedText, forceMoveMarkers: true }]);
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
    /* F15：正文可能还没读过来（首屏只发目录元数据）。这里先给一个空 model 顶上，
       同时把读请求发出去；回包落在 onFileData → 文件不脏就 setValue。
       不做成"await 再建 model"是因为 openFile 是同步调用链上十几处都在用，
       改成异步会把"点一下标签页"变成有先后顺序的一串Promise，更容易出错。 */
    const known = typeof f.content === "string" ? f.content : "";
    const m = monaco.editor.createModel(known, f.lang, monaco.Uri.parse("inmemory:///" + path));
    if (typeof f.content !== "string" && !f.binary) ensureContent(path);
    m.onDidChangeContent(() => {
      const disk = state.files[path] && typeof state.files[path].content === "string" ? state.files[path].content : "";
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
  /* 记下这一次到底发了什么：ack 回来时磁盘上的是**这份**内容，不是"此刻编辑器里的内容"。
     用户在等 ack 的几百毫秒里继续打字时，前者才是真话。 */
  const content = models[p].getValue();
  const seq = ++state.saveSeq;
  (state.pendingSaves[p] = state.pendingSaves[p] || []).push({ seq, content });
  send({ type: "file.save", path: p, content, seq });
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
  { id: "matrix",    name: "矩阵",   mode: "dark",  desc: t("apSaveActiveFiledescT21"), sw: ["#050807", "#00d4aa", "#00ffcc", "#0088ff"] },
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

  /* F19：主任务空间优先。左右两栏能拖到 360 / 620（合计 980px），
     视口一窄，被挤的是中间那块 —— 实测 900 宽时正文列只剩 200px，一行三五个字，
     连标题都竖着排。让步顺序固定为"先让辅助栏，最后才动中间"：
       1 右栏按可用宽度收窄 → 2 右栏临时收起 → 3 左栏收窄 → 4 左栏临时收起，
     中间那块永远保留 MIN_MAIN。
     关键是**临时**：状态只写在 DOM 上（data-auto-hide + style.width），
     不覆盖用户拖出来的偏好（localStorage 原值不动），窗口拉回去就按偏好还原。 */
  const MIN_MAIN = 480, MIN_AG_RIGHT = 200, MIN_AG_LEFT = 170;
  function agPrefW(key, dflt) { const n = parseInt(localStorage.getItem(key)); return n > 0 ? n : dflt; }
  function fitMainSpace() {
    const vw = document.documentElement.clientWidth;
    const abar = (($("activitybar") || {}).offsetWidth) || 0;
    const RES = 6;                                  // 两条 resizer 的占位（.resizer-v 宽 6px）
    const userOpenS = !agS.classList.contains("collapsed");
    const userOpenR = !agR.classList.contains("collapsed");
    let openS = userOpenS, openR = userOpenR;
    let wS = agPrefW("cw-ag-sessions-w", 250), wR = agPrefW("cw-ag-right-w", 430);
    const need = () => abar + (openS ? wS + RES : 0) + (openR ? wR + RES : 0) + MIN_MAIN;
    if (openR && need() > vw) wR = Math.max(MIN_AG_RIGHT, wR - (need() - vw));
    if (openR && need() > vw) { openR = false; wR = agPrefW("cw-ag-right-w", 430); }
    if (openS && need() > vw) wS = Math.max(MIN_AG_LEFT, wS - (need() - vw));
    if (openS && need() > vw) openS = false;
    agS.style.width = wS + "px"; agR.style.width = wR + "px";
    const autoS = userOpenS && !openS, autoR = userOpenR && !openR;
    agS.toggleAttribute("data-auto-hide", autoS);
    agR.toggleAttribute("data-auto-hide", autoR);
    if (agSR) agSR.toggleAttribute("data-auto-hide", autoS);
    if (agRR) agRR.toggleAttribute("data-auto-hide", autoR);
  }
  fitMainSpace();
  window.addEventListener("resize", fitMainSpace);
  agS.addEventListener("dblclick", () => setTimeout(fitMainSpace, 0));
  agR.addEventListener("dblclick", () => setTimeout(fitMainSpace, 0));

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



/* docx 预览 iframe 自带一份样式：沙箱里的文档读不到主应用的 CSS，
   不注入就会看到一份没有排版的裸 HTML。值与 .bp-doc-page 那组保持一致。 */
const DOC_PREVIEW_CSS =
  "body{margin:0;padding:28px 34px;background:#f2f2f2;color:#222;font-family:'Segoe UI','Microsoft YaHei',sans-serif;font-size:14.5px;line-height:1.8}" +
  "h1,h2,h3,h4,h5,h6{color:#111;margin:1.1em 0 .5em;line-height:1.4}" +
  "p{margin:.55em 0}" +
  "table{border-collapse:collapse;margin:12px 0;max-width:100%}" +
  "td,th{border:1px solid #bbb;padding:5px 10px;font-size:13.5px}" +
  "img{max-width:100%;height:auto}" +
  "ul,ol{padding-left:2em}" +
  "a{color:#1a6fbf}";

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
        /* 文档正文不进应用自己的 DOM：服务端清洗之外再隔一层 sandbox。
           原先是 innerHTML 直插应用文档 —— 那等于把"清洗必须一条不漏"当成唯一防线，
           漏一条 javascript: 链接就是拿 pancode 的 userToken 执行（审查项 F06）。
           这里不给 allow-scripts：预览用不到脚本，被沙箱隔开的文档连"点开的链接能读到本页"都做不到；
           只给 allow-popups，让 target=_blank 的正常外链还能开新窗口。 */
        body.innerHTML = '<iframe class="bp-doc-frame" sandbox="allow-popups" title="' + esc(path) + '"></iframe>'
          + '<div class="bp-meta">' + esc(path) + " · " + fmtSize(f.size) + " · 只读预览（编辑请用 Word/WPS）"
          + (d.rewrittenLinks ? ' · <span class="bp-doc-warn">' + t("apShowBinPreviewWarn").replace("{n}", Number(d.rewrittenLinks)) + "</span>" : "")
          + "</div>";
        body.querySelector(".bp-doc-frame").srcdoc =
          '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><style>' + DOC_PREVIEW_CSS + "</style></head><body>" + d.html + "</body></html>";
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
/* 预览页 → 父页面上报滚动状态。
   __pcPs = 当前滚动位置（像素）
   __pcSh = 内容总高度（像素）
   __pcCh = 可视高度（像素）—— 新增：父页面要靠它算出"预览可滚高度"
   （__pcSh - __pcCh）才能把比例映射到编辑器。之前只有 __pcSh，
   父页面无从知道预览能滚多远，只能拿像素硬搬，于是错位。 */
const PREVIEW_BRIDGE = '<script>(function(){var P=function(){try{parent.postMessage({__pcPs:window.scrollY,__pcSh:(document.body?document.body.scrollHeight:0),__pcCh:(document.documentElement?document.documentElement.clientHeight:0)},"*")}catch(e){}};window.addEventListener("scroll",function(){requestAnimationFrame(P)},{passive:true});window.addEventListener("resize",function(){requestAnimationFrame(P)},{passive:true});window.addEventListener("message",function(e){var d=e.data;if(d&&d.__pcPt!=null){try{window.scrollTo(0,d.__pcPt)}catch(e){}}});if(document.readyState!=="loading")P();else window.addEventListener("DOMContentLoaded",P);})();<\/script>';
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
/* 预览可滚动高度（内容高 - 可视高）。bridge 现在会上报 __pcCh，
   有了它才能算出预览能滚多远 —— 之前只有内容高度，比例无从算起。 */
let _pvCh = 600;
/* 两个方向的同步标记：_pvSyncing 护 editor→preview，_pvSyncingBack 护 preview→editor。
   之前只有前者，于是预览滚动 → editor.setScrollTop → onDidScrollChange →
   再算一次比例回滚预览，形成回环：用户滚一下，预览被甩到最底部。 */
let _pvSyncingBack = false;
/* 预览的滚动比例（0~1）与"重绘后待恢复"标记。
   记比例而不是像素：srcdoc 重载后内容高度会变，像素对不上，比例才对得上。 */
let _pvRatio = 0, _pvRestorePending = false;
function _onPreviewMessage(e) {
  const d = e.data;
  if (!d || d.__pcPs == null) return;
  if (d.__pcSh && d.__pcSh > 0) _pvSh = d.__pcSh; // 缓存预览页内容高度（跨源无法直读）
  if (d.__pcCh && d.__pcCh > 0) _pvCh = d.__pcCh; // 缓存预览页可视高度
  if (_pvSyncing) return;      // 本次由 editor->preview 触发，忽略回声避免回环
  if (_pvSyncingBack) return;  // 本次由 preview->editor 触发，同样忽略
  /* 重绘后的恢复：新文档加载完会照例上报一次初始状态（__pcPs=0 + 新高度）。
     这时把之前记下的比例按新高度还原回去，用户的滚动位置就保住了。
     这一条上报不参与比例更新 —— 它是新文档的初始状态，不是用户的滚动。 */
  if (_pvRestorePending) {
    _pvRestorePending = false;
    const pvMax = Math.max(0, _pvSh - _pvCh);
    if (pvMax > 0) {
      try {
        const fr = $("hpFrame");
        if (fr && fr.contentWindow) {
          _pvSyncing = true;
          fr.contentWindow.postMessage({ __pcPt: Math.round(_pvRatio * pvMax) }, "*");
          requestAnimationFrame(() => { _pvSyncing = false; });
        }
      } catch (_) {}
    }
    return;
  }
  /* 预览滚动 → 编辑器：按**比例**映射，不是像素。
     预览是渲染结果、编辑器是源码，两者滚动高度不同（源码往往更短），
     把预览的像素位置直接当编辑器的像素位置搬，必然错位 ——
     极端时编辑器的可滚高度为 0，位置一去不回，编辑器被顶到底。 */
  const pvMaxNow = Math.max(0, _pvSh - _pvCh);
  if (pvMaxNow > 0) _pvRatio = Math.min(1, Math.max(0, d.__pcPs / pvMaxNow));
  try {
    const pvMax = pvMaxNow;
    const edMax = Math.max(0, editor.getScrollHeight() - editor.getContainerDomNode().clientHeight);
    if (pvMax <= 0 || edMax <= 0) return;   // 任一侧不可滚 → 没有可映射的比例
    const ratio = Math.min(1, Math.max(0, d.__pcPs / pvMax));
    _pvSyncingBack = true;
    editor.setScrollTop(ratio * edMax);
    // 下一帧解除保护：onDidScrollChange 是异步派发的
    requestAnimationFrame(() => { requestAnimationFrame(() => { _pvSyncingBack = false; }); });
  } catch (_) {}
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
      /* 分母是编辑器**实际可滚高度**。原来用 Math.max(1, …) 兜底：
       编辑器不可滚时 ratio = scrollTop / 1 = scrollTop，target 被放大几千倍，
       预览直接被甩到底部（实测 300 → 14703）。不可滚时比例就该是 0。 */
      const edMax = Math.max(0, editor.getScrollHeight() - editor.getContainerDomNode().clientHeight);
      const ratio = edMax > 0 ? Math.min(1, Math.max(0, editor.getScrollTop() / edMax)) : 0;
      const target = ratio * Math.max(0, _pvSh - _pvCh);
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
  /* srcdoc 一改，iframe 整个重载 → scrollTop 归零，用户正在看的那段就没了。
     先把当前比例存下并置"待恢复"，新文档首次上报时再还原回去。 */
  _pvRestorePending = true;
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
  /* 切文件时收起内联编辑框：它绑定的是上一个文件的 model 与选区，
     留在屏幕上点「接受」就会把改动写进另一个文件。 */
  const _ieBox = document.getElementById("inlineEditBox");
  if (_ieBox) _ieBox.remove();
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
  /* 只有"盘上那份正文真的读过来了"才复位 model：
     没读过时 content 是 undefined，setValue(undefined) 会把编辑器变成 "undefined" 四个字。 */
  if (state.dirty.has(path) && models[path] && state.files[path] && typeof state.files[path].content === "string") {
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
let _lastChangesFingerprint = "";
function renderChanges(list) {
  const statusOf = (p) => {
    const hit = (state.changed || []).find((c) => c && c.path === p);
    if (hit && hit.status) return hit.status;
    return state.files[p] && state.files[p].isNew ? "A" : "M";
  };
  const items = list || Array.from(modifiedSet()).map((p) => {
    const f = state.files[p] || {};
    /* 正文没读过来就没法算行数（F15 之后首屏只带变更集那一撮正文）。
       这里给 0/0 会撒谎，所以干脆不算 add/del，让列表只说"这个文件改过"。 */
    const known = typeof f.content === "string" && typeof f.original === "string";
    const st = known ? diffStat(f.original, f.content) : { add: null, del: null };
    return { path: p, status: statusOf(p), add: st.add, del: st.del };
  });
  const n = items.length;
  // 内容指纹：跳过完全相同的重复渲染（文件监听自循环修复的配套防线）
  const fp = items.map((it) => it.path + ":" + it.status + ":" + (it.add || 0) + ":" + (it.del || 0) + ":" + (it.risk || "")).join("|");
  if (fp === _lastChangesFingerprint) return;
  _lastChangesFingerprint = fp;
  /* 有几个改过的文件正文还没读过来，"+N −N" 就只是"读到的那些"的数，不是总量。
     把 unknown 一起带上，显示层要么老老实实加个"部分"，要么别给数 —— 给个 0 是谎。 */
  state.lastChangeTotals = {
    files: n,
    add: items.reduce((s, it) => s + (it.add || 0), 0),
    del: items.reduce((s, it) => s + (it.del || 0), 0),
    unknown: items.filter((it) => it.add === null).length,
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

/* 状态栏「N 处改动」、Agents 面板「N 个文件」和 SCM 标题只在 renderChanges 里写，
   而那条路带内容指纹早退（同列表不重渲染，文件监听自循环的防线）。
   后果是切语言时这三处不重念，屏幕上留着 index.html 的中文种子 —— EN 态实测残留里
   26 条都是同一条文字被各面板重复数出来的。onLang 注册即执行一次，所以开机首帧也走这里。 */
if (typeof onLang === "function") onLang(() => {
  const n = (state.lastChangeTotals && state.lastChangeTotals.files) || 0;
  const head = $("scmHead"); if (head) head.textContent = t("changesCount", { n });
  const sb = $("sbChangesTxt"); if (sb) sb.textContent = t("sbChanges", { n });
  const ag = $("agChangeCount"); if (ag) ag.textContent = t("nFiles", { n });
});

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
  /* F15：Diff 要两份内容——当前正文 + 基线。两份都可能是"还没读过"，
     所以这里按需取，取齐了再建 model。
     _diffSeq 是用来挡"等回来时用户已经在看另一个文件"的：
     不加这个号，后到的那份会盖掉当前这个文件的对比，人看到的就是串台的 Diff。 */
  const seq = (state._diffSeq || 0) + 1;
  state._diffSeq = seq;
  const build = () => {
    if (state._diffSeq !== seq) return;
    const cur = state.files[path] || {};
    if (diffEditor) diffEditor.dispose();
    diffEditor = monaco.editor.createDiffEditor($("diffHost"), {
      theme: "pancode", readOnly: true, automaticLayout: true, fontSize: 13,
      renderSideBySide: true, minimap: { enabled: false },
      ignoreTrimWhitespace: false, renderIndicators: true,
    });
    diffEditor.setModel({
      original: monaco.editor.createModel(typeof cur.original === "string" ? cur.original : "", cur.lang),
      modified: monaco.editor.createModel(typeof cur.content === "string" ? cur.content : "", cur.lang),
    });
  };
  if (typeof f.content === "string" && (typeof f.original === "string" || f.isNew)) { build(); return; }
  $("diffHost").innerHTML = '<div style="padding:18px;color:var(--text-dim);font-size:13px">正在读取正文与基线…</div>';
  Promise.all([ensureContent(path), ensureBaseline(path)]).then(build, build);
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
    /* 按钮交还给上一张卡时，那张卡可能在上一个已收起的轮组里：撤销本来就是
       逐步回退，按钮看得见才有意义。只展开按钮真正落进去的那一组，别的组不动。 */
    const grp = card.closest(".round-grp");
    if (grp && !grp.classList.contains("open")) grp.classList.add("open");
  }
}
/* 两条撤销入口（卡片上的按钮、命令面板）共用这一截：列出会动哪些文件 → 确认 → POST。
   top.fromShadow 是"重启后从本机影子快照里退回来的一步"，必须先说清来源：
   它不属于本次运行的改动栈，退的是上一次服务进程写下的那一步。 */
async function undoStepRequest(cid, top) {
  const list = (top.files || []).map((f) => f.path + "（" + tr(f.action) + "）").join("、");
  const pre = top.fromShadow ? t("undoShadowNote") : "";
  if (!confirm(pre + t("undoConfirmMsg", { label: tr(top.label), list }))) return { cancelled: true };
  return await fetch("/api/undo", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ convId: cid }),
  }).then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
}
/* 回滚掉的个数 = 恢复的 + 删掉的：影子回退会把那一步新建的文件一并摘掉，
   只数 restored 会让界面报的数比真动过的少。 */
function undoTouched(r) { return (r.restored || []).length + (r.removed || []).length; }
async function runUndo(card, btn) {
  const cid = convOf(card);
  const st = await fetch("/api/undo").then((x) => x.json()).catch(() => ({ ok: false, steps: [] }));
  const top = (st.steps || [])[0];
  if (!st.ok) { toast(t("apPaintUndoBtnstoastT125") + (st.error || t("apbuildCodeIndexC7"))); return; }
  if (!top) { toast(t("apPaintUndoBtnstoastT126")); paintUndoBtns(); return; }
  if (top.convId && top.convId !== cid) { toast(t("apPaintUndoBtnstoastT127")); return; }
  btn.disabled = true;
  const r = await undoStepRequest(cid, top);
  btn.disabled = false;
  if (r.cancelled) return;
  if (!r.ok) { toast(t("wbRootsGroupwbSavedT85") + (r.error || t("apbuildCodeIndexC7"))); return; }
  const tag = document.createElement("span");
  tag.className = "t-undone";
  tag.textContent = t("apPaintUndoBtnstextContentT29");
  const touched = undoTouched(r);
  tag.title = t("undoDoneTip", { n: touched });
  const head = card.querySelector(".tool-head");
  if (head) head.appendChild(tag);
  card.classList.add("undone");
  const i = undoCards.indexOf(card);
  if (i >= 0) undoCards.splice(i, 1);
  paintUndoBtns();
  toast(t("apPaintUndoBtnstoastT128") + r.label + t("aprunUndoC10") + touched + t("aprunUndoC11") + (r.left ? t("aprunUndoC12") + r.left + t("aprunUndoC13") : ""));
}
/* 命令面板那条入口是给"重启之后"用的：卡片上的按钮只挂在本次渲染出来的卡片上，
   页面一刷就没得点了，而影子仓里的检查点还在。判据仍由服务端把关（跨会话拒绝、
   初始全量快照不暴露），这里只负责"说清要动哪些文件 + 让人确认"。 */
async function undoFromPalette() {
  const cid = String(convId || "default");
  const st = await fetch("/api/undo").then((x) => x.json()).catch(() => ({ ok: false, steps: [] }));
  if (!st.ok) { toast(t("apPaintUndoBtnstoastT125") + (st.error || t("apbuildCodeIndexC7"))); return; }
  const top = (st.steps || [])[0];
  if (!top) { toast(t("apPaintUndoBtnstoastT126")); return; }
  if (top.convId && top.convId !== cid) { toast(t("apPaintUndoBtnstoastT127")); return; }
  const r = await undoStepRequest(cid, top);
  if (r.cancelled) return;
  if (!r.ok) { toast(t("wbRootsGroupwbSavedT85") + (r.error || t("apbuildCodeIndexC7"))); return; }
  toast(t("apPaintUndoBtnstoastT128") + r.label + t("aprunUndoC10") + undoTouched(r) + t("aprunUndoC11") + (r.left ? t("aprunUndoC12") + r.left + t("aprunUndoC13") : ""));
}
function scrollChat(force) {
  // Sticky scroll：用户上翻查看历史时不强制拉回底部；force=true 时无条件滚到底（新消息/审批/选项卡）
  // 网格模式下滚动容器是各会话 pane 自身（chatStream 不滚），滚"当前写入的那个"
  const box = (gridMode ? (convPanes[_boundConvId || convId] || chatStream) : chatStream);
  const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (force || wasAtBottom) {
    box.scrollTop = box.scrollHeight;
    _newMsgCount = 0;
  } else {
    /* 用户不在底部，新消息到达时递增未读计数 */
    _newMsgCount++;
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
  /* 节点记录所有消息（用户 + AI），用不同颜色区分；分布由 CSS space-evenly 均匀排列 */
  const allMsgs = [];
  chatPane().querySelectorAll(":scope > .msg-user, :scope > .msg-ai").forEach((el) => { allMsgs.push(el); });
  _hideNavPop();
  rail.innerHTML = "";
  if (!allMsgs.length) { rail.classList.remove("nav-visible"); return; }
  allMsgs.forEach((el) => {
    const dot = document.createElement("div");
    dot.className = "msg-nav-item " + (el.classList.contains("msg-user") ? "user" : "ai");
    /* hover tooltip：显示消息内容预览 */
    dot.addEventListener("mouseenter", () => {
      _showNavTooltip(dot, el);
      _navHoverTimer = setTimeout(() => {
        _showNavPop(dot, allMsgs);
      }, 800);
    });
    dot.addEventListener("mouseleave", () => {
      _hideNavTooltip();
      clearTimeout(_navHoverTimer);
    });
    /* 单击直接跳转到对应消息 */
    dot.onclick = (e) => {
      e.stopPropagation();
      _hideNavTooltip();
      clearTimeout(_navHoverTimer);
      if (_navPop && _navPop.classList.contains("show")) { _hideNavPop(); return; }
      chatStream.scrollTo({ top: el.offsetTop - 10, behavior: "smooth" });
      el.classList.add("msg-jump-flash");
      setTimeout(() => el.classList.remove("msg-jump-flash"), 1400);
    };
    rail.appendChild(dot);
  });
  rail.classList.add("nav-visible"); /* 有消息时常驻显示 */
  updateMsgNavActive();
}
let _navHoverTimer = null;
let _navTooltip = null;
/* hover 圆点时显示的消息内容预览 tooltip */
function _showNavTooltip(anchor, msgEl) {
  if (!_navTooltip) {
    _navTooltip = document.createElement("div");
    _navTooltip.className = "msg-nav-tooltip";
    document.body.appendChild(_navTooltip);
  }
  const text = (msgEl.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120) || "（空消息）";
  const isUser = msgEl.classList.contains("msg-user");
  _navTooltip.innerHTML =
    '<div class="mnt-role">' + (isUser ? "用户" : "AI") + '</div>' +
    '<div class="mnt-txt">' + text + '</div>';
  _navTooltip.classList.add("show");
  const r = anchor.getBoundingClientRect();
  const pw = _navTooltip.offsetWidth, ph = _navTooltip.offsetHeight;
  const top = Math.max(8, Math.min(r.top + r.height / 2 - ph / 2, window.innerHeight - ph - 8));
  const left = Math.max(8, r.left - pw - 10);
  _navTooltip.style.left = left + "px";
  _navTooltip.style.top = top + "px";
}
function _hideNavTooltip() { if (_navTooltip) _navTooltip.classList.remove("show"); }
let _navPop = null;
/* hover 延迟后弹出的小窗口：列出本会话全部消息，点击条目跳转到对应消息 */
function _showNavPop(anchor, allMsgs) {
  if (!_navPop) {
    _navPop = document.createElement("div");
    _navPop.className = "msg-nav-pop";
    document.body.appendChild(_navPop);
  }
  _navPop.innerHTML =
    '<div class="mnp-head"><span class="mnp-role">' + t("ap_showNavPopH14") + '</span>' +
    '<span class="mnp-idx">' + allMsgs.length + " 条</span></div>" +
    '<div class="mnp-list"></div>';
  const listBox = _navPop.querySelector(".mnp-list");
  allMsgs.forEach((el, i) => {
    const item = document.createElement("div");
    item.className = "mnp-item " + (el.classList.contains("msg-user") ? "mnp-user" : "mnp-ai");
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
  if (_navTooltip && _navTooltip.classList.contains("show") && !_navTooltip.contains(e.target)) _hideNavTooltip();
});
function updateMsgNavActive() {
  const rail = msgNavRail;
  if (!rail || !rail.children.length) return;
  const scrollTop = chatStream.scrollTop;
  const viewH = chatStream.clientHeight;
  let activeIdx = -1;
  const dots = Array.from(rail.children);
  const allMsgs = [];
  chatPane().querySelectorAll(":scope > .msg-user, :scope > .msg-ai").forEach((el) => { allMsgs.push(el); });
  for (let i = 0; i < allMsgs.length; i++) {
    if (allMsgs[i].offsetTop - 10 <= scrollTop + viewH * 0.3) activeIdx = i;
  }
  dots.forEach((d, i) => d.classList.toggle("active", i === activeIdx));
}
/* 智能滚动按钮：只在需要时显示对应按钮（不在顶部时显示"到顶"，不在底部时显示"到底"） */
let _newMsgCount = 0;
function updateScrollBtns() {
  const hasOverflow = chatStream.scrollHeight > chatStream.clientHeight + 40;
  const isAtTop = chatStream.scrollTop <= 10;
  const isAtBottom = chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight <= 40;
  const btnTop = $("btnScrollTop"), btnBot = $("btnScrollBottom");
  if (btnTop) btnTop.style.display = (hasOverflow && !isAtTop) ? "flex" : "none";
  if (btnBot) btnBot.style.display = (hasOverflow && !isAtBottom) ? "flex" : "none";
  /* 有新消息且不在底部时，底部按钮显示未读计数 */
  if (btnBot) {
    if (_newMsgCount > 0 && !isAtBottom) {
      btnBot.classList.add("has-unread");
      const badge = btnBot.querySelector(".scroll-badge");
      if (badge) badge.textContent = _newMsgCount > 9 ? "9+" : String(_newMsgCount);
    } else {
      btnBot.classList.remove("has-unread");
      if (isAtBottom) _newMsgCount = 0;
    }
  }
  chatScrollBtns.classList.toggle("csb-visible", hasOverflow && (!isAtTop || !isAtBottom));
}
chatStream.addEventListener("scroll", () => {
  msgNavRail.classList.add("nav-visible");
  updateMsgNavActive();
  updateScrollBtns();
  _hideNavPop();
  _hideNavTooltip();
});
/* 按钮自身是容器，用 querySelector 取内层按钮（元素可能还在分离树上） */
chatScrollBtns.querySelector("#btnScrollTop").onclick = () => chatStream.scrollTo({ top: 0, behavior: "smooth" });
chatScrollBtns.querySelector("#btnScrollBottom").onclick = () => {
  chatStream.scrollTo({ top: chatStream.scrollHeight, behavior: "smooth" });
  _newMsgCount = 0;
  updateScrollBtns();
};

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
function finalizeRoundGrp(grp, opts) {
  grp.classList.remove("live");
  const body = grp.querySelector(".rg-body");
  /* 清理空块：某些轮次会留下没有内容的占位 div（think.start 发了但正文为空、
     或渲染竞态留下空壳），展开后是一条纯灰色空条，没存在价值。
     think-block 折叠态有"思考 Xs"文字、tool-card 有工具名，都不会被误删。 */
  Array.from(body.children).forEach((c) => {
    if ((c.textContent || "").trim()) return;
    if (c.querySelector("img,video,canvas,svg")) return;
    c.remove();
  });
  /* 含截图的轮组不自动折叠：截图是"用户想立刻看到的证据"，tool.image 特意不收进
     .tool-body（折叠卡里 display:none）就是为了它常显——轮组折叠会把这层设计整个
     推翻（shotui 探针抓的就是这个）。头部仍可手动收起。 */
  /* 收尾时含「撤销这一步」的轮组也不折叠：撤销是任务跑完之后才要按的动作，
     折起来等于把入口藏了（undo 探针量的是"按钮完不完整可见"）。下一轮开始时
     这里不带 opts，旧组照常收起，所以不会越积越多。 */
  const keepUndo = !!(opts && opts.keepUndo) && !!body.querySelector(".t-undo");
  if (!body.querySelector(".tool-shots") && !keepUndo) grp.classList.remove("open");
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

/* 任务收尾：给指定会话最后一个仍展开的轮组填摘要并收起（否则它永远挂着呼吸点、摘要空白）。
   W28 终审:agent.done 不走 withConv（不在 CHAT_DOM_TYPES 里）,这里若用 chatPane()
   会永远绑到前台活跃 pane —— 后台会话收尾时收错前台的组、自己的组永远不收。
   显式按 convId 找 pane,调用点把 ev.convId 传进来。 */
function finalizeOpenRoundGrp(cvid) {
  const pane = (cvid && convPanes[cvid]) || chatPane();
  const openGrps = pane.querySelectorAll(".round-grp.open");
  const last = openGrps.length ? openGrps[openGrps.length - 1] : null;
  if (last) finalizeRoundGrp(last, { keepUndo: true });
}

/* 长会话折叠：直接子消息超过阈值时，把最早的批次收入折叠容器（可展开），降低 DOM 渲染压力。
   W28:接受 pane 覆盖 —— 网格里对后台会话删消息后要按**那个** pane 重算，chatPane() 会跑错。 */
const FOLD_THRESHOLD = 60, FOLD_BATCH = 30;
function foldOldMessages(paneOverride) {
  const pane = paneOverride || chatPane();
  /* F17：AI 回答外面包着一层 .msg-row（头像 + 气泡），它不是 pane 的直属孩子 ——
     原来这条 :scope > .msg-ai 一条都选不中，于是"折叠旧消息"对着长会话其实是空转：
     消息越堆越多，DOM 一直在页面上。现在按整行折叠（连同头像一起收进折叠区）。 */
  const direct = pane.querySelectorAll(":scope > .msg-user, :scope > .msg-row, :scope > .msg-ai, :scope > .step-flow");
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
    return;
  }
  /* W27 · 用户气泡上的「重跑」：从这条消息重放任务（服务端截断历史再按原文重发）。 */
  const rerunBtn = e.target.closest(".msg-user .msg-rerun");
  if (rerunBtn) {
    const bubble = rerunBtn.closest(".msg-user");
    const pane = bubble.closest(".conv-pane") || chatPane();
    const cvid = pane.dataset.convId || convId;
    if (state.convRunning[cvid]) { toast(t("rerunBusyTip")); return; }
    const userMsgs = [...pane.querySelectorAll(".msg-user")];
    const backIndex = userMsgs.length - 1 - userMsgs.indexOf(bubble);   // 从最新数（0 = 最后一条）
    /* W28 终审:纯 Skill 气泡(只挂 chip 没打字)没有可重发的正文 —— 服务端会静默
       丢弃,客户端却已删 DOM 报成功。空文本直接拒绝,不动 DOM。 */
    const text = ([...bubble.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("")).trim();
    if (!text) { toast(t("rerunEmptyTip")); return; }
    /* 删除范围必须跨容器:bubble 可能在 .fold-old-body 里(展开折叠区后可点),
       只在同级删 nextElementSibling 会在容器边界截断,把"较新的后续消息"残留在
       时间线上,与服务端已截断的历史拼成错乱画面。向上逐级删"祖先容器在 pane 里的
       后续兄弟",到 pane 层为止。 */
    let n = bubble;
    while (n) { const nx = n.nextElementSibling; n.remove(); n = nx; }
    let anc = bubble.parentNode;
    while (anc && anc !== pane) {
      let s = anc.nextElementSibling;
      while (s) { const nx = s.nextElementSibling; s.remove(); s = nx; }
      anc = anc.parentNode;
    }
    send({ type: "rewind", convId: cvid, backIndex, text });
    buildMsgNav();
    foldOldMessages(pane);
    toast(t("rerunStartedTip"));
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
let _mdW = null, _mdWDead = false, _mdWSeq = 0;
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
/* F16：重绘的调度单位是"这一条消息"，不是全局一根 timer。
   原来 _mdTimer 是共享的：已有 timer 就直接 return —— 于是 A 在流、B 也在流时，
   B 的 delta 全被 A 那一帧压住（A 的回调只画 A），B 整个交错期一帧都不更新；
   msg.end 再 clearTimeout，又把别人刚排上的那帧连坐删掉。
   现在改成"脏集合 + 一根共享帧"：每块各自标脏，帧到期把这批脏块各画各的
   （帧预算仍然只有一份，不会放大成 N 个 timer）。
   另外每块带一个世代号 gen：结束事件把 gen+1，路上飞回来的旧帧凭号作废 ——
   不然 widget 那一类终稿是主线程同步渲染的，会被一条更早发出去、更晚回来的
   Worker 帧盖回退化成普通代码块。 */
const _mdDirty = new Set();
let _mdFrame = null;
function _mdRenderBlock(b) {
  _mdDirty.add(b);
  if (_mdFrame) return;   // 65ms 窗口内合并突发 delta，一批只调度一帧
  _mdFrame = setTimeout(_mdPaint, 65);
}
function _mdPaint() {
  _mdFrame = null;
  const batch = Array.from(_mdDirty);
  _mdDirty.clear();
  for (const b of batch) _mdPaintBlock(b, false);
}
/* ——— F16 第二段：长正文不再每帧整篇重灌 ———
   量到的曲线（10 / 100 / 500KB 三档，脚本 scripts/_verify_stream_sched.js）：
     帧数        1 / 10 / 39
     innerHTML   10KB / 569KB / 8.5MB     ← 每帧都把整篇重灌一遍，累计写入是正文的 17 倍
     longtask    0 / 0 / 202ms           ← 用户那一下卡顿
     帧间隔      19 / 55 / 209ms         ← 输入掉帧的直接来源
   解析本身不贵（Worker 里单帧最长 5.9ms，且不在主线程），贵的是 DOM 替换。
   所以正文按"稳定前缀 + 尾巴"两半画：
     · 稳定前缀只切在**块边界**（空行之后，且这之前围栏成双）——renderChatMD 是逐行的
       块级渲染，列表遇到空行本来就 flushList，所以在空行处切两半、分别渲染再拼接，
       与整篇渲染一次逐字相同（这一点是这套缓存正确的全部依据）；
     · 尾巴是还没稳定的那一小截，每帧只重画它；
     · 尾巴过长（例如一整块超长代码还没闭合）或内容回退（rewind/重生）时，
       这一块退回整篇 Worker 重画 —— 最坏情况不超过改造前的成本，不会更差。 */
const _MD_TAIL_MAX = 32 * 1024;
/* 返回 [稳定前缀, 尾巴]：切点右移一位都不行，切点必须在"一个空行结束"的位置 */
function _mdSplit(src) {
  let k = src.lastIndexOf("\n\n");
  while (k >= 0) {
    const cut = k + 2;
    const head = src.slice(0, cut);
    if (((head.match(/^```[^\n]*$/gm) || []).length & 1) === 0) return [head, src.slice(cut)];
    k = src.lastIndexOf("\n\n", k - 1);
  }
  return ["", src];
}
function _mdPaintBlock(b, final) {
  const src = b.buf;
  const sp = final ? [src, ""] : _mdSplit(src);
  const stable = sp[0], tail = sp[1];
  const painted = typeof b._paintedSrc === "string" ? b._paintedSrc : null;
  if (!final && (tail.length > _MD_TAIL_MAX || painted === null || !stable.startsWith(painted))) {
    _mdFullFrame(b, src);
    return;
  }
  /* 尾巴元素恒为 b.el 的最后一个孩子：新稳定的那一截永远插在它前面，
     于是 DOM 里的顺序与整篇渲染出来的顺序一致。 */
  if (!b._tailEl || b._tailEl.parentNode !== b.el) {
    if (b._tailEl && b._tailEl.parentNode !== b.el) b._tailEl.remove();
    b._tailEl = document.createElement("div");
    b._tailEl.className = "md-tail";
    b.el.appendChild(b._tailEl);
  }
  const delta = stable.slice(painted ? painted.length : 0);
  if (delta) b._tailEl.insertAdjacentHTML("beforebegin", renderChatMD(delta));
  b._paintedSrc = stable;
  if (final) { b._tailEl.remove(); b._tailEl = null; b._paintedSrc = src; }
  else b._tailEl.innerHTML = tail ? renderChatMD(tail) : "";
  wireCopyButtons(b.el); _mdScroll(b);
}
/* 整篇重画（旧那一条路）：Worker 解析 + 一次 innerHTML 替换 */
function _mdFullFrame(b, src) {
  const gen = b.gen || 0;
  if (b._tailEl) { b._tailEl.remove(); b._tailEl = null; }
  renderChatMDAsync(src, (html) => {
    /* 作废的两种情形：这一块的内容又前进了（下一帧会画更新的），
       或者这一块已经收尾（终稿由 msg.end 负责，见上面的 gen 注释）。 */
    if (b.buf !== src || (b.gen || 0) !== gen) return;
    b.el.innerHTML = html;
    b._paintedSrc = src;
    wireCopyButtons(b.el); _mdScroll(b);
  });
}
/* 这一块不再需要流式帧了：从脏集合摘掉 + 世代号让飞行中的旧帧全部作废 */
function _mdEndBlock(b) {
  if (!b) return;
  b.gen = (b.gen || 0) + 1;
  _mdDirty.delete(b);
}
/* 后台会话那一块不该去动前台的滚动位置。
   异步回调时 withConv 早就出来了，_boundConvId 是空的，scrollChat 会拿
   "当前看得见的那块"当目标滚 —— 后台流一帧，前台的阅读位置就被拉走一次。 */
function _mdScroll(b) {
  if (!b.pane || !b.pane.isConnected) return;   // 非网格里后台 pane 根本不挂 DOM，不用滚
  if (!gridMode) { scrollChat(); return; }
  const box = b.pane;
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) box.scrollTop = box.scrollHeight;
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
  /* W27 · 重跑：从这条消息重放任务。点击走 chatStream 上的事件委托（见 appendChatBlock
     区域的委托块）——历史会话的 DOM 是快照恢复的，逐元素 onclick 会失联，委托天然免疫。 */
  const rerun = document.createElement("button");
  rerun.className = "msg-rerun";
  rerun.innerHTML = ico("reset");
  rerun.title = t("rerunTip");
  rerun.setAttribute("aria-label", t("rerunTip"));
  el.appendChild(rerun);
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

/* ============================================================
   F15 · 目录元数据 + 按需正文的前端一侧
   ------------------------------------------------------------
   state.files[path] 现在长这样（后两个字段可能压根没有）：
     { path, size, mtimeMs, lang, binary, isNew, content?, original? }
   "没有 content" 和 "content 是空串" 是两件不同的事：前者=还没读，后者=文件是空的。
   所有要正文的地方都走 ensureContent / ensureBaseline，它们保证：
     · 同一路径并发只发一次请求（共享同一个 Promise）；
     · 服务端回包前不覆盖用户正在编辑的内容（脏文件绝不 setValue）；
     · 拿不到就明说（终端一行），而不是让界面停在一个永远转圈的标签上。
   ============================================================ */
const _lazyWait = {};     // path -> {resolve, timer}：正文在途
const _lazyBase = {};     // path -> {resolve, timer}：基线在途
const LAUNCH_READ_TIMEOUT_MS = 20000;

function _takeWait(map, key, value) {
  const w = map[key];
  if (!w) return;
  clearTimeout(w.timer);
  delete map[key];
  w.resolve(value);
}

/* 合并一条目录项：mtime 没变就保留已经读到的正文（这是"反复打开同一文件不重复读盘"的那一半）。 */
function mergeEntry(old, incoming) {
  if (!incoming) return old;
  const base = Object.assign({}, old || {}, incoming);
  if (typeof incoming.content !== "string") {
    // 元数据更新：正文只有在"文件确实变了"时才作废
    const staleByMtime = old && typeof old.content === "string" &&
      Number(old.mtimeMs || 0) !== Number(incoming.mtimeMs || 0);
    if (old && !staleByMtime) { base.content = old.content; base.original = old.original; }
    else if (staleByMtime) { delete base.content; delete base.original; }
  }
  return base;
}

function applyTree(tree, changed) {
  if (tree) {
    state.tree = {
      total: Number(tree.total) || 0,
      listed: Number(tree.listed) || (tree.entries || []).length,
      more: !!tree.more,
      truncated: !!tree.truncated,
      /* 翻页要带的是"下一条从第几个开始"（offset），不是上一条路径：
         服务端那页的排序键是 (价值层, 字典序)，路径游标会跨层错位。 */
      nextOffset: Number(tree.nextOffset) || ((Number(tree.offset) || 0) + (tree.entries || []).length),
    };
    state.files = state.files || {};
    for (const e of (tree.entries || [])) state.files[e.path] = mergeEntry(state.files[e.path], e);
  }
  if (Array.isArray(changed)) state.changed = changed;
}

function ensureContent(path) {
  const f = state.files[path];
  if (!f) return Promise.resolve("");
  if (f.binary) return Promise.resolve("");
  if (typeof f.content === "string") return Promise.resolve(f.content);
  if (_lazyWait[path]) return _lazyWait[path].p;
  let resolve, timer = null;
  const p = new Promise((r) => { resolve = r; });
  _lazyWait[path] = { p, resolve, timer };
  if (!send({ type: "file.read", path })) {
    delete _lazyWait[path];
    termLine('<span class="tl-warn">[读取] ' + escHtml(path) + " 没能发出去（连接未就绪）</span>");
    return Promise.resolve("");
  }
  timer = setTimeout(() => {
    if (!_lazyWait[path]) return;
    delete _lazyWait[path];
    termLine('<span class="tl-warn">[读取] ' + escHtml(path) + " 等了 " + (LAUNCH_READ_TIMEOUT_MS / 1000) + "s 没回，可能是盘上已经没有了</span>");
    resolve("");
  }, LAUNCH_READ_TIMEOUT_MS);
  _lazyWait[path].timer = timer;
  return p;
}

function ensureBaseline(path) {
  const f = state.files[path];
  if (!f) return Promise.resolve("");
  if (typeof f.original === "string" || f.isNew === true) return Promise.resolve(f.original || "");
  if (_lazyBase[path]) return _lazyBase[path].p;
  let resolve, timer = null;
  const p = new Promise((r) => { resolve = r; });
  _lazyBase[path] = { p, resolve, timer };
  if (!send({ type: "file.baseline", path })) {
    delete _lazyBase[path];
    return Promise.resolve("");
  }
  timer = setTimeout(() => {
    if (!_lazyBase[path]) return;
    delete _lazyBase[path];
    resolve("");
  }, LAUNCH_READ_TIMEOUT_MS);
  _lazyBase[path].timer = timer;
  return p;
}

/* 服务端回包（file.data / file.baseline / file.error）——在 handleEventInner 里分发到这里 */
function onFileData(ev) {
  const f = state.files[ev.path] || { path: ev.path };
  f.content = ev.content;
  if (ev.size != null) f.size = ev.size;
  if (ev.mtimeMs) f.mtimeMs = ev.mtimeMs;
  if (ev.lang) f.lang = ev.lang;
  state.files[ev.path] = f;
  if (models[ev.path] && !state.dirty.has(ev.path) && models[ev.path].getValue() !== ev.content) {
    models[ev.path].setValue(ev.content);
  }
  if (state.activeFile === ev.path && previewOn && isPreviewable(ev.path)) renderPreview();
  _takeWait(_lazyWait, ev.path, ev.content);
}
function onFileBaseline(ev) {
  const f = state.files[ev.path] || { path: ev.path };
  f.original = ev.original;
  if (ev.isNew !== undefined) f.isNew = !!ev.isNew;
  state.files[ev.path] = f;
  _takeWait(_lazyBase, ev.path, ev.original);
}
function onFileError(ev) {
  termLine('<span class="tl-warn">[读取] ' + escHtml(ev.path || "") + "：" + escHtml(ev.error || "读不出来") + "</span>");
  _takeWait(_lazyWait, ev.path, "");
  _takeWait(_lazyBase, ev.path, "");
}

/* 翻页：把下一页并进来，"还有 N 个未加载"跟着走 */
function loadMoreTree() {
  if (!state.tree.more) return;
  if (!send({ type: "tree.load", offset: Number(state.tree.nextOffset) || 0, limit: 500 })) {
    termLine('<span class="tl-warn">[目录] 加载更多没能发出去（连接未就绪）</span>');
  }
}

function syncFiles(files, incremental, removed) {
  state.files = state.files || {};
  if (removed && removed.length) {
    for (const p of removed) {
      delete state.files[p];
      if (models[p]) { models[p].dispose(); delete models[p]; state.dirty.delete(p); lspClose(p); }
    }
  }
  /* 增量合并：只覆盖点名的路径，**保留已经读到的正文**。
     服务端这里发来的多半是元数据（没有 content），mergeEntry 会按 mtime 决定要不要作废。 */
  for (const p in files) state.files[p] = mergeEntry(state.files[p], files[p]);
  if (!incremental && removed && removed.length) {
    /* 目录变了（增删改名）时服务端会点名哪些确实没了；上面已经按 removed 清过一遍，
       这里只补一句注释说明"为什么不整包替换"：整包替换等于把用户已经翻出来的后面几页也丢掉。 */
    for (const p of removed) delete state.files[p];
  }
  // 关闭已消失文件的标签
  state.openTabs = state.openTabs.filter((p) => state.files[p]);
  if (state.activeFile && !state.files[state.activeFile]) {
    state.activeFile = state.openTabs[state.openTabs.length - 1] || null;
    if (state.activeFile) openFile(state.activeFile);
    else { hideBinPreview(); if (state.monacoReady) editor.setModel(null); }
  }
  // 同步 model 内容（跳过用户正在编辑的脏文件；没正文的先不去读，等打开时再说）
  if (state.monacoReady) {
    for (const p in models) {
      if (!state.files[p]) continue;
      if (state.files[p].binary) continue; // 二进制占位 model 不同步内容
      if (typeof state.files[p].content !== "string") continue;
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
  /* send 返回 false 意味着这条压根没交给服务端（连接没开 / 正在重连）。
     这时把卡片标成"已批准"再禁用按钮，用户就没有第二次机会了 ——
     而 Agent 那边还卡在等确认，表现是"任务永远不动"（审查项 F09）。
     所以没发出去时保持按钮可点，只把状态如实写出来。 */
  const notSent = () => {
    statusEl.className = "t-status fail";
    statusEl.innerHTML = ico("close") + " 确认没有发出去（连接未就绪），可重试";
    return false;
  };
  el.querySelector(".btn-approve").onclick = () => {
    if (!send({ type: "tool.approve", id: ev.id })) return notSent();
    statusEl.className = "t-status done";
    statusEl.innerHTML = ico("check") + " 已批准";
    lock();
  };
  const sesBtn = el.querySelector(".btn-approve-session");
  if (sesBtn) sesBtn.onclick = () => {
    if (!send({ type: "tool.approve", id: ev.id, remember: "session", tool: ev.tool })) return notSent();
    statusEl.className = "t-status done";
    statusEl.innerHTML = ico("shield") + " 本会话已授权 " + (ev.tool || "");
    lock();
  };
  el.querySelector(".btn-reject").onclick = () => {
    if (!send({ type: "tool.reject", id: ev.id })) return notSent();
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
      /* 与审批卡同一口径：没发出去就不许标"已选择"，按钮保持可点（审查项 F09）。 */
      if (!send({ type: "tool.choice_result", id: ev.id, choice })) {
        statusEl.className = "t-status fail";
        statusEl.innerHTML = ico("close") + " 选择没有发出去（连接未就绪），可重试";
        return;
      }
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
  /* tool.pending 也属于会话内 DOM：后台会话弹审批卡时，卡片必须落进它自己的 pane，
     否则会出现在当前正在看的另一条会话里，批准的是谁的事都说不清。 */
  const CHAT_DOM_TYPES = new Set(["user.msg", "think.start", "think.delta", "think.end", "msg.start", "msg.delta", "msg.end", "tool.start", "tool.body", "tool.image", "tool.end", "tool.pending", "tool.ask_choice", "agent.error"]);
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
      if (ev.ctxLimit) state.ctxLimit = ev.ctxLimit;   // 水位分母：压缩线（与压缩判定同源）
      /* F15：先落目录元数据（含"一共多少个 / 还有没有下一页"），再把带正文的那一撮盖上去。
         顺序反了会把 warm 的正文当作"没有 content 的新条目"被 mergeEntry 丢一次。 */
      applyTree(ev.tree, ev.changed);
      syncFiles(ev.files, true, []);
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
    case "fs.sync":
      if (ev.tree || ev.changed) applyTree(ev.tree, ev.changed);
      syncFiles(ev.files, ev.incremental, ev.removed || []);
      break;
    /* F15 的三朵按需回包：正文、基线、目录下一页 */
    case "file.data": onFileData(ev); break;
    case "file.baseline": onFileBaseline(ev); break;
    case "file.error": onFileError(ev); break;
    case "tree.data":
      applyTree(ev, null);
      renderTree();
      break;
    case "fs.renamed": {
      /* 改名 = 旧路径没了 + 新路径有了。tab / model / 脏标记都要跟着搬家，
         否则用户看到的是"改完名之后编辑器里那份还是旧路径的内容"。 */
      if (ev.from && ev.to && state.files[ev.to] && !state.files[ev.from]) {
        if (models[ev.from]) { models[ev.to] = models[ev.from]; delete models[ev.from]; }
        if (state.dirty.has(ev.from)) { state.dirty.delete(ev.from); state.dirty.add(ev.to); }
        state.openTabs = state.openTabs.map((p) => (p === ev.from ? ev.to : p));
        if (state.activeFile === ev.from) state.activeFile = ev.to;
        renderTabs(); renderBreadcrumb();
      }
      break;
    }
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
    case "chat.rejected": {
      /* 会话排队满了，服务端拒收这一条。以前前端完全没接这个事件：
         输入框早就清空了，用户看到的只是"我发的消息没影了"（审查项 F09）。
         原文从 lastSent 取（服务端回包里的 text 为控体积截到 2000 字，
         拿它还原草稿等于悄悄吃掉后半截）。 */
      termLine('<span class="tl-warn">[Agent] ' + esc(ev.reason || "这条没有发出去") + "</span>");
      if (!ev.convId || ev.convId === (lastSent && lastSent.convId)) {
        if (restoreLastSent()) termLine('<span class="tl-info">[Agent] 原文已放回输入框，改完再发即可。</span>');
        lastSent = null;
      }
      break;
    }
    case "agent.error": showAgentError(ev); break;
    case "file.saved": {
      /* 只认这次 ack 对应的那份内容。以前无条件把"此刻编辑器里的内容"当成磁盘内容，
         于是保存 A 之后继续敲出的 B 被当成已落盘：脏点消失、关页也不提醒，B 实际从未存过。 */
      const q = state.pendingSaves[ev.path] || [];
      const idx = ev.seq != null ? q.findIndex((x) => x.seq === ev.seq) : (q.length ? 0 : -1);
      let acked = null;
      if (idx >= 0) {
        const done = q.splice(0, idx + 1);
        acked = done[done.length - 1].content;
      }
      if (q.length) state.pendingSaves[ev.path] = q; else delete state.pendingSaves[ev.path];
      if (state.files[ev.path] && acked != null) state.files[ev.path].content = acked;
      /* 脏不脏看「编辑器现值 vs 刚确认落盘的内容」，不是看"有没有 ack" */
      if (models[ev.path] && state.files[ev.path] && models[ev.path].getValue() === state.files[ev.path].content) {
        state.dirty.delete(ev.path);
      }
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
      answerBlock = { el, row, buf: "", pane: chatPane() };
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
      _mdEndBlock(b);   // 摘掉流式帧（含飞行中的那一次），终稿由下面这一次说了算
      b.el.classList.remove("type-caret");
      // W9：没建过稳定块壳的那一块（一口到位的短答）终稿仍走 Worker 整篇渲染
      let finished = false;
      const settle = () => {
        if (finished) return; finished = true;
        wireCopyButtons(b.el);
        // 给 AI 回复加「复制全部」按钮（气泡在流式渲染中会被 innerHTML 覆盖，故在结束时挂载）
        const row = b.el.closest(".msg-row");
        if (row && !row.querySelector(".msg-copy")) {
          const full = htmlToMarkdown(b.el).trim() || b.el.textContent.trim();
          addMsgCopyBtn(row, full);
        }
        /* 结论卡：加「结论」角标 + 操作条（复制/重新生成/分支）。
           只有最终答案块（.ans-row）才挂 —— 过程叙述（tool 前的那些）
           不该有"重新生成"，用户要重跑的是整轮任务，不是某句话。
           demoted：tool.start 已判定这块是过程叙述（后面又跟了工具），不再挂结论效果。 */
        if (row && !b.demoted) markFinalAnswer(row);
        _mdScroll(b);
        send({ type: "ctx.query" });   // 回答结束拉一次服务端实测水位，校正圆圈进度
      };
      /* F16：已经按稳定块画过的那一块，收尾只是"把最后一段挪进稳定区、清掉尾巴"，
         成本是剩下那一截，不是整篇再灌一遍（500KB 那 202ms 长任务就是这么省掉的）。
         尾巴里剩下的未闭合内容也在这里定稿，所以终稿与流式过程用的是同一套切分口径。 */
      /* widget 块可能在首帧就被 Worker 画成了代码（那时 _paintedSrc 已盖到整段前缀），
         后续帧只补增量，收尾若走增量路径就永远不会升级成卡片。
         含闭合 widget/svg/diagram 的回复一律走主线程整篇终稿（与 W9 的取舍一致：宁可慢一次）。 */
      if (b._tailEl && !_hasWidgetFence(b.buf)) { _mdPaintBlock(b, true); settle(); break; }
      const finish = (html) => { b.el.innerHTML = html; b._tailEl = null; b._paintedSrc = b.buf; settle(); };
      if (b.buf) renderChatMDFinal(b.buf, finish);
      else finish("");
      break;
    }

    case "tool.start": {
      // 工具调用一旦开始，之前那段话就是"过程叙述"，应当独立成泡；
      // 否则叙述与最终回答会被跨轮聚合成同一个气泡，读起来像被截断的句子。
      // 它也不是"最终结论" —— 一轮里只有最后一个 ans-row 才是最终结论，
      // 中间被工具打断的 ans-row 撤掉结论卡效果（角标 + 操作条）。
      if (answerBlock) {
        answerBlock.demoted = true;
        if (answerBlock.row) unmarkFinalAnswer(answerBlock.row);
      }
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
    case "agent.usage": onUsageEvent(ev.usage, ev); break;

    case "file.changed": {
      if (ev.deleted) {
        delete state.files[ev.path];
        if (models[ev.path]) { models[ev.path].dispose(); delete models[ev.path]; lspClose(ev.path); }
        state.dirty.delete(ev.path);
        state.openTabs = state.openTabs.filter((p) => p !== ev.path);
      } else {
        /* Agent 刚写完：正文/基线就地更新（这是"改了哪个文件"最权威的一手信息），
           同时把这个路径记进变更集 —— 否则 modifiedSet 只认服务端 hello 里那份快照，
           界面上的 M 徽标要等到下一次全量同步才亮。 */
        state.files[ev.path] = mergeEntry(state.files[ev.path] || {}, {
          content: ev.content, original: ev.original, isNew: ev.isNew, lang: ev.lang,
        });
        state.changed = state.changed || [];
        if (!state.changed.some((c) => c && c.path === ev.path)) {
          state.changed.push({ path: ev.path, status: ev.isNew ? "A" : "M" });
        }
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
      if (!ev.convId || ev.convId === convId) {
        /* ev.task 是引擎按"本会话真写过的路径"求交出来的任务口径；
           ev.list 仍是仓库口径（整棵脏树），给 SCM 面板和状态栏用。两者不能混。 */
        state.lastTaskTotals = ev.task || null;
        renderChanges(ev.list);
      }

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
      finalizeOpenRoundGrp(doneConvId);   // W22：按会话收尾轮组（后台会话也各收各的）
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
    /* 分母统一用服务端下发的压缩线（hello 的 ctxLimit）。
       此前这里读 state.agent.contextWindow —— 该字段根本不存在（agentSettings
       不返回它），于是恒退化成硬编码 128000，与服务端实测分支的压缩线
       （现 419430）对不上：估算时水位虚高近 4 倍，数据到达后又突然变小。 */
    budget = state.ctxLimit || 0;
    if (!budget) { wrap.style.display = "none"; return; }   // 分母未知就别显示水位（显示 0% 是误导）
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
  /* 这颗胶囊说的是"本次任务"，所以优先用引擎给的任务口径（本会话写过的路径与它们的增删行）。
     退到 lastChangeTotals 只在老引擎没发 ev.task 的时候 —— 那是整棵脏工作树的数，
     和"步骤 x/y"拼在一起读起来就像"这一步改了 1291 行"，是它历史上出过的错。 */
  const ch = (typeof state !== "undefined" && (state.lastTaskTotals || state.lastChangeTotals)) || { files: 0, add: 0, del: 0 };
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
  if (ch.files) {
    seg.push('<span class="sp-sep"></span><span class="sp-files">' + t("stepPillFiles", { n: ch.files }) + "</span>");
    /* 有文件没读正文就不报增删行数：那串数会让人以为"本次只改了这些"。 */
    if (!ch.unknown) {
      seg.push('<span class="sp-stat"><b class="add">+' + ch.add + '</b> <b class="del">−' + ch.del + "</b></span>");
    }
  }
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
  /* 同 renderStepPill：部分文件的正文还没读过来时，这两个格子说"没量到"，不说 0。 */
  set("envAdd", ch.unknown ? "—（有 " + ch.unknown + " 个未读）" : "+" + (ch.add || 0));
  set("envDel", ch.unknown ? "—" : "−" + (ch.del || 0));
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

/* ---------------- AI 最终结论卡：角标 + 操作条 ----------------
   结论是用户真正要拿走的东西。此前只能选中复制，且与过程消息长得一样。
   这里给它：①「结论」角标（与思路链路拉开量级）；②操作条（复制/重新生成/分支）。 */

/* 给一条已完成的 AI 结论补上角标与操作条。挂之前先摘掉旧的 —— 历史会话
   的 DOM 是快照恢复的，hydrate 后会再跑一次，不能叠出两套按钮。 */
function markFinalAnswer(row) {
  if (!row || !row.classList || !row.classList.contains("ans-row")) return;
  const el = row.querySelector(".msg-ai");
  if (!el) return;
  el.setAttribute("data-final-label", t("finalAnswerLabel") || "结论");
  if (row.querySelector(".msg-actions")) return;
  const bar = document.createElement("div");
  bar.className = "msg-actions";

  /* 复制：正文转 markdown 后的可读版（与导出对话同口径） */
  const copyBtn = document.createElement("button");
  copyBtn.className = "ma-copy";
  copyBtn.innerHTML = ico("copy") + "<span>" + t("finalCopy") + "</span>";
  copyBtn.title = t("finalCopy");
  copyBtn.onclick = (e) => {
    e.stopPropagation();
    const full = htmlToMarkdown(el).trim() || el.textContent.trim();
    navigator.clipboard.writeText(full).then(() => toast(t("apWireCopyButtonstextContentT32")));
  };
  bar.appendChild(copyBtn);

  const sep = document.createElement("span");
  sep.className = "ma-sep";
  bar.appendChild(sep);

  /* 重新生成：截断到这条结论之前，重发上一条用户消息。
     底座是 rewind（服务端截断历史 + 按原文重发），与用户气泡的「重跑」同源。 */
  const regenBtn = document.createElement("button");
  regenBtn.className = "ma-regen";
  regenBtn.innerHTML = ico("reset") + "<span>" + t("finalRegenerate") + "</span>";
  regenBtn.title = t("finalRegenerate");
  regenBtn.onclick = (e) => { e.stopPropagation(); regenerateFromAnswer(row); };
  bar.appendChild(regenBtn);

  /* 分支：把到这条结论为止的历史复制成新会话 */
  const branchBtn = document.createElement("button");
  branchBtn.className = "ma-branch";
  branchBtn.innerHTML = ico("branch") + "<span>" + t("finalBranch") + "</span>";
  branchBtn.title = t("finalBranch");
  branchBtn.onclick = (e) => { e.stopPropagation(); branchFromAnswer(row); };
  bar.appendChild(branchBtn);

  el.appendChild(bar);
  replaceIcons(bar);
}

/* 撤掉一条 ans-row 的结论卡效果：移除「结论」角标 + 操作条。
   tool.start 调它把"过程叙述"降级 —— 一轮里只有最后一个 ans-row 才是最终结论。 */
function unmarkFinalAnswer(row) {
  if (!row || !row.classList || !row.classList.contains("ans-row")) return;
  const el = row.querySelector(".msg-ai");
  if (el) el.removeAttribute("data-final-label");
  const bar = row.querySelector(".msg-actions");
  if (bar) bar.remove();
}

/* 找到这条结论之前最近的一条用户消息（重发的对象） */
function prevUserMsgBefore(row) {
  const pane = row.closest(".conv-pane") || chatPane();
  let n = row.previousElementSibling;
  while (n) {
    if (n.classList && n.classList.contains("msg-user")) return n;
    n = n.previousElementSibling;
  }
  return null;
}

/* 重新生成：截断到这条结论之前，重发上一条用户消息。
   与用户气泡「重跑」同一条路（rewind），但目标不同：这里以 AI 结论为锚点。 */
function regenerateFromAnswer(row) {
  const bubble = prevUserMsgBefore(row);
  if (!bubble) { toast(t("finalRegenNoUser")); return; }
  const pane = row.closest(".conv-pane") || chatPane();
  const cvid = pane.dataset.convId || convId;
  if (state.convRunning[cvid]) { toast(t("rerunBusyTip")); return; }
  const text = ([...bubble.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("")).trim();
  if (!text) { toast(t("rerunEmptyTip")); return; }
  /* 删掉这条结论及其之后的一切（DOM 层面），再让服务端按同样口径截断 */
  let n = row;
  while (n) { const nx = n.nextElementSibling; n.remove(); n = nx; }
  const userMsgs = [...pane.querySelectorAll(".msg-user")];
  const backIndex = userMsgs.length - 1 - userMsgs.indexOf(bubble);
  send({ type: "rewind", convId: cvid, backIndex, text });
}

/* 分支：把到这条结论为止的历史复制成一个新会话。
   会话历史分开存（列表 cw-conv-v1:<hash> / DOM 快照 cw-convdom-v1:<hash>:<id>），
   所以分支 = 复制列表项 + 复制快照到新 id + 切过去。 */
function branchFromAnswer(row) {
  const pane = row.closest(".conv-pane") || chatPane();
  const srcId = pane.dataset.convId || convId;
  if (!srcId) { toast(t("finalBranchFailed")); return; }
  const list = loadConvList();
  const src = list.find((c) => String(c.id) === String(srcId));
  if (!src) { toast(t("finalBranchFailed")); return; }
  /* 截到这条结论为止：取 row 之前（含）的 DOM */
  const nodes = [];
  let n = row;
  while (n) { nodes.unshift(n); n = n.previousElementSibling; }
  const holder = document.createElement("div");
  nodes.forEach((x) => holder.appendChild(x.cloneNode(true)));
  /* 去掉克隆里的操作条与角标：新会话里那些结论会各自重新挂上 */
  holder.querySelectorAll(".msg-actions").forEach((x) => x.remove());

  const newId = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const title = (src.title || t("convUntitled")) + " · " + t("finalBranchSuffix");
  const item = { id: newId, title, ts: Date.now() };
  /* 顺序要紧：先 persistConv 把当前会话的快照与标题落定（它内部会 load→改→写回
     整个会话列表），再把新分支项加进去。反过来的话，openConv 里的 persistConv()
     会拿旧列表写回，把刚加的分支项**覆盖掉** —— 分支会话凭空消失。 */
  persistConv();
  const next = loadConvList();
  next.unshift(item);
  saveConvList(next);
  saveConvDom(newId, holder.innerHTML);
  /* 切到新会话：服务端起一份新上下文，本地挂载那份快照 */
  send({ type: "newchat", convId: newId });
  openConv(newId);
  renderConvList();
  toast(t("finalBranchDone"));
}

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
  /* 默认展开：节点只有 40px 高的标题条时，一眼看过去全是框、看不到内容
     （"输出效果也不显示"）。CSS 里 .orch-step-out 也是 display:block。
     点标题仍可折叠。 */
  out.style.display = "block";
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
  /* getBoundingClientRect 给的是"变换后的屏幕尺寸"，而 svg 里的 d 是用户坐标（=布局尺寸）。
     模态入场那条 pc-modal-in 会把整框缩到 0.985 再放开：画的时候若还带着缩放，
     边就按 0.985 倍的位置写进用户坐标，动画结束后节点回到真位置、边留在那儿 ——
     实测偏差不随距离摊薄而是越靠右越大（第 2、3 列分别差 4.3px、8.6px，正是 1.5%×列位）。
     除以屏幕宽/布局宽之比把这一层缩放除掉，画出来的才是布局坐标。 */
  const k = (host.offsetWidth && hb.width) ? hb.width / host.offsetWidth : 1;
  const pos = {};
  els.forEach((el) => {
    const r = el.getBoundingClientRect();
    pos[el.dataset.id] = { x: (r.left - hb.left) / k, y: (r.top - hb.top) / k, w: r.width / k, h: r.height / k,
      st: ["running", "done", "fail", "pending"].find((c) => el.classList.contains(c)) || "pending" };
  });
  /* 画布尺寸也取布局空间那套（scrollWidth/offsetWidth 都不含祖先缩放），
     否则 viewBox 与用户坐标不在同一个尺子上，等于把偏差又乘回去。 */
  const W = Math.max(host.scrollWidth, host.offsetWidth || Math.ceil(hb.width));
  const H = Math.max(host.scrollHeight, host.offsetHeight || Math.ceil(hb.height));
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
      /* 竖向连线：从上游底边中点弯到下游顶边中点。
         泳道改成竖排（层=先后）后，横向画法会让箭头指向"右边"，
         而"右边"在竖排布局里没有先后含义 —— 箭头必须指向下一批。 */
      const x1 = f.x + f.w / 2, y1 = f.y + f.h, x2 = t.x + t.w / 2, y2 = t.y;
      const my = Math.max(y1 + 12, y2 - 12);
      out += '<path class="orch-edge ' + st + '" d="M' + x1.toFixed(1) + ',' + y1.toFixed(1) +
        ' C' + x1.toFixed(1) + ',' + my.toFixed(1) + ' ' + x2.toFixed(1) + ',' + my.toFixed(1) +
        ' ' + x2.toFixed(1) + ',' + (y2 - 7).toFixed(1) + '"/>' +
        '<path class="orch-edge-head ' + st + '" d="M' + x2.toFixed(1) + ',' + y2.toFixed(1) + ' l-4,-8 h8 z"/>';
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
/* 状态一变，节点矩形可能变（图标/文案换行），边必须跟着重画；
   容器尺寸那一路由 bindOrchResize 的 ResizeObserver 兜，这里只补当前这一帧的落定。 */
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
/* 默认看"本工作区全部"，不是"本会话"。
   编排历史是工作区级资产（服务端按工作区分片落盘、跨会话可见），
   而编排多半发生在别的会话里 —— 默认只显示本会话等于把它藏起来，
   用户看到的永远是「这个会话还没有编排记录」。
   "全部"视图里每条都带归属会话名，不会认不出是哪条。 */
let _orchScope = "all";         // conv = 只看本会话，all = 本工作区全部
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
        /* 自动改过串行就必须标出来：三步两批看起来像"并行走完很省时间"，
           实际那两步是被撞车边按住的，成本与失败面完全不同。 */
        (h.autoSerial ? " · " + t("orchAutoSerialN", { n: h.autoSerial }) : "") +
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
    /* 依赖图上的边只说"谁等谁"，说不出这几条是编排器自己补的还是模型声明的。
       留档里的 serialized 就是那一层：回放时必须看得见，否则用户以为这两步真的并行过。 */
    const auto = (run.serialized || []).map((e) => (e.from || "?") + " ⇠ " + (e.to || "?")
      + ((e.files && e.files.length) ? "（" + e.files.join("、") + "）" : "")).join("；");
    sum.innerHTML = '<span class="orch-sum-ico">' + ico(run.ok ? "check" : "error") + "</span>" + esc(run.summary || "")
      + (auto ? '<span class="orch-sum-serial">' + esc(t("orchAutoSerialNote", { list: auto })) + "</span>" : "");
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
/* 最近一条"已经交给 WebSocket"的消息。服务端排队满了会拒收（chat.rejected），
   而这时输入框早就清空了 —— 用户看到的是"我发的话凭空消失"。
   存整份（含附件）而不是回用事件里带回来的那份：服务端为了控制回包体积
   把 text 截到 2000 字，拿它还原草稿等于悄悄吃掉后半截。 */
let lastSent = null;
function restoreLastSent() {
  if (!lastSent) return false;
  const ta = document.querySelector("#chatInput");
  if (!ta) return false;
  if (!ta.value.trim() && !pendingAttach.length) {
    ta.value = lastSent.text || "";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    if (lastSent.attachments && lastSent.attachments.length) {
      lastSent.attachments.forEach((a) => pendingAttach.push({ src: a.src, name: a.name }));
      renderChips();
    }
    return true;
  }
  return false;
}

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
  /* 返回值是"这条有没有真的交出去"。以前这里静默丢弃：连接不是 OPEN 时
     ws.send 一行都不跑，而调用方已经把输入框清空了 ——
     实测形态是"断线时点发送，字没了、消息也没出去"（审查项 F09）。 */
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
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
    if (!v && !pendingAttach.length && !skillId) return false;

    const attachments = pendingAttach.map((a) => ({ src: a.src, name: a.name }));
    /* Skill 走 skillId 单独发出去，正文由服务端注入到模型看到的上下文里。
       旧写法是把整份 body 前置拼进这条消息：气泡里糊一大段模板、每轮都重复占上下文，
       而且"用技能"必须靠输入框里有字才成立。 */
    const text = v || (attachments.length ? "（请分析所附图片）" : "");
    // 多会话并行：直接发送，不再排队
    lastUserText = text;
    /* 先确认这条真的交得出去，再动输入框。
       原先的顺序是"清空 → 发送"，而 send 在连接没开时什么都不做：
       离线/重连的窗口里点一次发送，草稿就凭空没了（审查项 F09 实测）。
       刻意不做"重连后自动补发"：chat 这一路带着附件与技能，自动重发在
       "服务端其实收到了、只是回包丢了"的情况下会变成执行两遍。 */
    const accepted = send({ type: "chat", text, attachments, convId, skillId });
    if (!accepted) {
      termLine('<span class="tl-warn">[发送] 与服务的连接尚未就绪，这条消息没有发出，草稿已为你保留。</span>');
      return false;
    }
    ta.value = "";
    lastSent = { text, attachments, convId: (typeof convId !== "undefined" && convId) || "default" };
    // 记录到当前会话的发送历史，供 ↑/↓ 浏览回填
    const curConv = (typeof convId !== "undefined" && convId) || "default";
    (sentHistory[curConv] = sentHistory[curConv] || []);
    if (v) sentHistory[curConv].push(v);
    histNav = -1;
    pendingAttach.splice(0, pendingAttach.length);
    renderChips();
    if (attachments.length) termLine('<span class="tl-info">[附件] 已随消息发送 ' + attachments.length + " 张图片</span>");
    return true;
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
  /* Enter 不再单独挂一个监听器。以前这里先挂了一个"Enter 就发"的处理器，
     菜单导航那一个挂在它后面 —— 于是斜杠菜单开着时按 Enter，
     先被前一个处理器发出去、后一个才想起来要补全（实测：/review 既发出去了又被展开）。
     键盘入口只留下面那一个，优先级固定为：输入法组合态 → 菜单 → 历史 → 发送。 */

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
    /* 输入法组合态优先于一切：中文/日文输入时按 Enter 是"确认候选词"，
       不是"把这条发出去"。判据两条并用 —— e.isComposing 是标准位，
       keyCode 229 是老 Safari/部分 IME 唯一会给的信号（实测漏掉这一条时，
       选词按回车会把半截拼音直接发出去并清空输入框）。 */
    if (e.isComposing || e.keyCode === 229) return;
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
    /* 没有菜单在场，Enter 才是"发送"。放在菜单分支之后，斜杠/@ 命令就不会被抢发。 */
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); return; }
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
      const label = {
        ask: "逐项确认",
        semi: "半自动（安全操作放行，写入仍确认）",
        acceptEdits: "接受编辑（文件改动免确认，命令与外部操作仍确认）",
        smart: "智能判定（拿不准的问模型，判不了仍问你）",
        auto: "全自动（高危仍会拦截）",
        dontAsk: "不再询问（该问的一律拒绝，适合无人值守的后台任务）",
      }[mode] || mode;
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

/* 列表摘要：最后一句话（用户问的或 AI 答的）取前 42 字。
   只在写快照时算一次，不在每次渲染列表时算 —— 见 convSummary 的注释。 */
function convLastLineText(pane) {
  if (!pane) return "";
  const msgs = pane.querySelectorAll(".msg-user, .msg-ai");
  const last = msgs[msgs.length - 1];
  if (!last) return "";
  return (last.textContent || "").trim().replace(/\s+/g, " ").slice(0, 42);
}

/* 持久化指定会话（默认当前活跃）的 pane 内容到 localStorage */
function persistConv(cvid) {
  const id = cvid || convId;
  if (!id) return;
  const pane = convPanes[id];
  const list = loadConvList();
  const c = list.find((x) => x.id === id);
  if (!c) return;
  if (pane) {
    saveConvDom(id, pane.innerHTML);   // dom 独立存储，避免全量序列化
    const s = convLastLineText(pane);
    if (s) c.summary = s;
  }
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
/* F17：列表摘要优先读记录里的元数据。
   旧形态对**每一条**会话现场 `div.innerHTML = 那份 pane 快照` 再 querySelector ——
   渲染一次列表就要解析全部历史正文（1000 条会话时是纯重复劳动），而且每条都要
   读一次 localStorage（lsGet 还会顺手写一次 LRU 索引）。
   摘要在 persistConv 写快照时一并算好存下来（那时正文本来就在内存里）。
   老记录没有 summary → 仍然走原来的现场解析，不因为改版把历史摘要弄丢。 */
function convSummary(c) {
  if (c.id === convId && state.convRunning[c.id]) return { tag: "running", text: t("convGroupRunning", { n: state.round || 1 }) };
  if (state.convRunning[c.id]) return { tag: "running", text: t("running") };
  if (typeof c.summary === "string" && c.summary) return { tag: "", text: c.summary };
  // 兼容：没有 summary 的老记录（含刚迁移过来、还没再持久化过的那些）
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
(function() {
  const cs = $("convSearch");
  if (!cs) return;
  /* F17：逐字符重建整张表 = 每次按键都把 1000 行 DOM 重做一遍。
     输入框按主流做法做一次短延时（停手 120ms 才重建），搜索仍然即时响应。 */
  let timer = null;
  cs.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(renderConvList, 120);
  });
})();

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
  evictHotPanes();   // F17：切走的会话只留最近 HOT_PANES 块，其余在落快照后释放 DOM
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
const GRID_MIN_COL = 300;    // 一列再窄字就挤成竖条 —— 宁可少放一列，不留空白
const GRID_GAP = 10;         // 与 CSS 的 gap 保持一致
let gridMode = localStorage.getItem(GRID_KEY) === "1";

/* 网格模式下的右栏让位。
   实测：1080 视口 + 右栏 430px → 中间只剩 371px，网格只能排 1 列，
   多个会话格子竖着挤、每个仅 152px 高，内容被压扁（残缺 + 挤兑）。
   网格视图的用途是同时看多个会话，右栏是次要信息 —— 让位给它。
   规则：
     · 只在「宽度排不下 2 列」时收（够宽还收就是骚扰）；
     · 退出网格时不擅自展开（用户可能本来就想收着）；
     · 手动展开过的不再自动收（用 autoCollapsed 标记区分）。
   返回值：是否刚刚收起了右栏 —— 收起会改变可用宽度，调用方需要
   在下一帧重算列数（收起前算的是旧宽度，那一列是白收）。 */
function syncRightPanelForGrid() {
  const agR = $("agRight");
  if (!agR) return false;
  if (!gridMode) {
    if (agR.dataset.autoCollapsed === "1") {
      agR.classList.remove("collapsed");
      delete agR.dataset.autoCollapsed;
      localStorage.setItem("cw-ag-right-collapsed", "0");
    }
    return false;
  }
  /* 判据是「放得下两列吗」：两列需要 2×300 + gap = 610px。
     之前误写成 GRID_MIN_COL + GRID_GAP（310px），于是 371px 的容器
     被判成「够宽」→ 右栏不收，格子照样挤成 1 列（实测 3 个格子各 152px 高）。 */
  const w = (chatStream.clientWidth || 0) - 20;          // 20 = 左右 padding
  const needTwoCols = w >= GRID_MIN_COL * 2 + GRID_GAP;   // 放得下两列就不必收
  if (needTwoCols) return false;
  if (agR.classList.contains("collapsed")) return false;   // 本来就收着，不动
  agR.classList.add("collapsed");
  agR.dataset.autoCollapsed = "1";
  localStorage.setItem("cw-ag-right-collapsed", "1");
  return true;
}

/* 统一挂载入口：单视图 = 仅活跃 pane；网格 = 有内容的会话并排挂载并刷新各格头部 */
function applyLayout() {
  /* 右栏收起会改变可用宽度 → 收起后必须用新宽度重算列数，
     否则按旧宽度（371px）算出 1 列，白收一次。 */
  if (syncRightPanelForGrid()) {
    setTimeout(() => { if (gridMode) applyLayout(); }, 60);
  }
  if (!gridMode) {
    chatStream.classList.remove("grid-on");
    chatStream.style.removeProperty("--grid-cols");
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
  const ids = hydrated.filter((id) => hasContent(id));
  if (convId && ids.indexOf(convId) < 0) ids.unshift(convId);
  ids.length = Math.min(ids.length, GRID_MAX);   // W28 终审:截断放 unshift 之后,否则活跃会话会把列表顶成 7 格
  /* 列数 = pane 数与「宽度能放下的列数」取小。
     CSS 的 auto-fit 按容器宽度铺列数，与 pane 数脱钩：1 个 pane 时右边空一大块，
     窄容器时又挤成 1 列。这里按实际内容算，格子数与内容数永远对得上。 */
  const avail = Math.max(0, (chatStream.clientWidth || 0) - 20);   // 20 = 左右 padding
  const fitByWidth = avail <= 0 ? 1 : Math.floor((avail + GRID_GAP) / (GRID_MIN_COL + GRID_GAP));
  const cols = Math.max(1, Math.min(ids.length, fitByWidth || 1));
  chatStream.style.setProperty("--grid-cols", String(cols));
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
      ctx.pane.insertBefore(head, ctx.pane.firstChild);
    }
    /* W28 终审:onclick 必须每次重赋 —— gp-head 会随 pane 被序列化进快照,
       刷新恢复的 head 是无监听的死元素,复用分支不重绑的话"点头部聚焦"永久失联 */
    head.onclick = () => openConv(id);
    head.querySelector(".gp-title").textContent = titles[id] || t("convUntitled");
    ctx.pane.classList.toggle("grid-active", id === convId);
    ctx.pane.classList.toggle("grid-running", !!state.convRunning[id]);
    if (ctx.pane.parentNode !== chatStream) chatStream.appendChild(ctx.pane);
  });
  replaceIcons();
}

/* 窗口尺寸变了，列数得跟着重算 —— 列数是按「可用宽度 ÷ 最小列宽」算出来的，
   拖宽窗口后原本 1 列能放 2 列，不重算就一直挤着。
   只在网格模式下挂，且节流：拖动窗口时 resize 事件能连发几十次。 */
let _gridResizeTimer = null;
window.addEventListener("resize", () => {
  if (!gridMode) return;
  clearTimeout(_gridResizeTimer);
  _gridResizeTimer = setTimeout(() => {
    if (gridMode) applyLayout();
  }, 160);
});

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
  /* 不重置 scope：编排历史是工作区级的，切会话不该把它藏回"本会话"视图。 */
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
      /* 切到网格后容器宽度变了（可能收了右栏），列数要按新宽度重算 */
      setTimeout(() => { if (gridMode) applyLayout(); }, 60);
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
   TCP 回环可达；账号无论几个都会签发最近创建的那个，服务端拒绝仅剩网络/异常路径，
   这里一律回退登录弹窗兜底）。
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
    /* 初始按持久化语言应用一次。
       原先中文不调 setLang（"静态 HTML 已为中文，无需处理"）—— 但 data-i18n-title
       这类**属性**型文案只在 applyI18n() 里刷，而 applyI18n() 只由 setLang() 触发。
       于是中文界面的 tooltip 一直是 index.html 里的静态旧文案，字典里那版更详细的
       说明从来没显示过（实测 54 处里 5 处静态与字典不一致，全是"字典更详细"）。
       现在无条件走一次 setLang：静态 HTML 已与字典对齐，跑一次不会有视觉变化，
       但此后改文案只改 i18n 一处即可（单一真相源）。 */
    var cur=localStorage.getItem("cw-lang")||"zh";
    if(typeof setLang==="function") setLang(cur);
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
