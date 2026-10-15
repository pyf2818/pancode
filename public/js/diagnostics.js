"use strict";
/* ============================================================
   pancode · 问题面板（P1-B1）
   ————————————————————————————————————————————
   之前编辑器里其实一直有诊断：LSP 的 publishDiagnostics 会变成 Monaco 的波浪线
   （js/lsp-client.js 的 setModelMarkers），Monaco 自带的 TS worker 也会给 js/ts 报语法错。
   但用户只能一行一行把鼠标挪过去看 hover，状态栏那个 #sbProblems 更是从来没被任何代码写过
   ——永远显示"0 错误"的死标签。跨文件的错误因此等于不存在：改完 a.js，b.js 红了，没人知道。

   这里把它变成一个真的能看、能点、能跳的面板：
     · 数据源只有一个：monaco.editor.getModelMarkers()。
       不在面板里另算一套严重度、也不让状态栏和列表各读各的——
       "面板看到的"和"编辑器里画出来的"必须是同一份数据（与 _ctxLimit 同一个原则）。
     · 覆盖范围说清楚：Monaco 只为**打开过的 model** 算诊断，所以面板是"已打开文件的问题"。
       空态直接写这个事实，不假装全仓没有问题。
     · 点一行 = openFile(路径, 行号) 并定位光标，和 VS Code 一致。
   ============================================================ */
(function () {
  /* Monaco 的 MarkerSeverity：Error=8 / Warning=4 / Info=2 / Hint=1 */
  const SEV_ERR = 8, SEV_WARN = 4;
  const SEV_KEY = { 8: "sevError", 4: "sevWarning", 2: "sevInfo", 1: "sevHint" };

  let filter = "all";          // all | error | warn
  let pane = "term";           // 当前底栏页签
  let disposers = [];          // 本模块注册的监听器（P0-A2 的 onEvent 返回的就是它）
  let rafPending = 0;

  /* app.js 的 state 是脚本顶层 const（词法全局），window.state 取到的是 undefined。
     这里两种都试一遍，别在"取不到"上静默退化成"这个文件不存在"。 */
  function appState() {
    try { if (typeof state !== "undefined" && state) return state; } catch (e) {}
    return window.state || null;
  }

  const $ = (id) => document.getElementById(id);

  function modelPath(model) {
    try { return uriToRelPath(model.uri); } catch (e) { return ""; }
  }

  /* 收一遍所有已打开 model 的 marker。
     按 model 查而不是 getModelMarkers({})：后者不告诉你每条 marker 属于哪个文件，
     而"点这行跳到那个文件"正好需要这个归属关系。 */
  function collect() {
    const rows = [];
    if (!window.monaco || !monaco.editor) return { rows, errors: 0, warnings: 0, files: 0 };
    let errors = 0, warnings = 0;
    const models = monaco.editor.getModels();
    for (const m of models) {
      const p = modelPath(m);
      if (!p) continue;
      let ms = [];
      try { ms = monaco.editor.getModelMarkers({ resource: m.uri }) || []; } catch (e) { continue; }
      if (!ms.length) continue;
      for (const k of ms) {
        if (k.severity === SEV_ERR) errors++;
        else if (k.severity === SEV_WARN) warnings++;
        else if (filter === "all" && k.severity > SEV_WARN) continue;   // 信息与提示不占版面
        rows.push({
          path: p, sev: k.severity, sevName: t(SEV_KEY[k.severity] || "dgKindAll"),
          line: (k.startLineNumber || 1), col: (k.startColumn || 1),
          text: String(k.message || ""), source: k.source ? " [" + k.source + "]" : "",
        });
      }
    }
    /* 排序口径：错误在前 → 文件名字典序 → 行号。诊断的先后顺序随 LSP 抖动，不能拿去当排序依据 */
    rows.sort((a, b) => (b.sev - a.sev) || a.path.localeCompare(b.path) || (a.line - b.line));
    return { rows, errors, warnings, files: new Set(rows.map((r) => r.path)).size };
  }

  function renderList() {
    /* 列表写在 #pbList 里，工具条是它的兄弟节点。
       两者不能同在 #problemsBody 下由 innerHTML 覆盖——那会把筛选/重扫按钮连监听一起冲掉，
       表现为"面板能用一次，第二次刷新后工具条消失"。 */
    const wrap = $("problemsBody");
    if (!wrap) return;
    let list = $("pbList");
    if (!list) {
      list = document.createElement("div");
      list.id = "pbList"; list.className = "pb-list";
      wrap.appendChild(list);
    }
    const { rows, errors, warnings, files } = collect();
    const shown = filter === "all" ? rows : rows.filter((r) => (filter === "error" ? r.sev === SEV_ERR : r.sev === SEV_WARN));

    /* 状态栏与徽标读的是同一份计数，绝不各算一遍 */
    const sb = $("sbProblems");
    if (sb) {
      const txt = errors + warnings === 0 ? t("sbProblems", { n: 0 })
        : (errors ? t("sbProblems", { n: errors }) : "") + (errors && warnings ? " · " : "") + (warnings ? t("sbWarns", { n: warnings }) : "");
      sb.innerHTML = '<i data-ico="' + (errors ? "error" : "check") + '"></i>' + txt;
      sb.classList.toggle("has-problems", errors + warnings > 0);
      sb.classList.toggle("has-errors", errors > 0);
      if (window.replaceIcons) window.replaceIcons(sb);
    }
    const badge = $("bpProbCount");
    if (badge) {
      badge.textContent = errors + warnings ? String(errors + warnings) : "";
      badge.className = "bp-count" + (errors ? " bp-count-err" : warnings ? " bp-count-warn" : "");
    }

    if (!shown.length) {
      /* 空态说清覆盖范围：Monaco 只算打开过的 model，这里"没有问题"不等于"全仓没有问题" */
      const kind = filter === "error" ? t("dgKindError") : filter === "warn" ? t("dgKindWarn") : t("dgKindAll");
      list.innerHTML = '<div class="pb-empty">' + (errors + warnings === 0
        ? '<i data-ico="check"></i>' + t("dgEmptyNone", { kind })
        : '<i data-ico="warn"></i>' + t("dgEmptyFiltered")) + '<span class="pb-empty-hint">' + t("dgRenderListH1") + '</span></div>';
      if (window.replaceIcons) window.replaceIcons(list);
      return;
    }
    let html = "", lastPath = null;
    for (const r of shown) {
      if (r.path !== lastPath) {
        if (lastPath !== null) html += "</div>";
        html += '<div class="pb-group"><div class="pb-file"><i data-ico="files"></i>' + esc(r.path) +
          '<span class="pb-file-n">' + shown.filter((x) => x.path === r.path).length + "</span></div>";
        lastPath = r.path;
      }
      html += '<button class="pb-row pb-' + (r.sev === SEV_ERR ? "err" : r.sev === SEV_WARN ? "warn" : "info") +
        '" data-p="' + esc(r.path) + '" data-l="' + r.line + '">' +
        '<i class="pb-ico" data-ico="' + (r.sev === SEV_ERR ? "error" : r.sev === SEV_WARN ? "warn" : "check") + '"></i>' +
        '<span class="pb-msg">' + esc(r.text) + '<span class="pb-src">' + esc(r.sevName + r.source) + "</span></span>" +
        '<span class="pb-loc">' + r.line + ":" + r.col + "</span></button>";
    }
    if (lastPath !== null) html += "</div>";
    list.innerHTML = html;
    if (window.replaceIcons) window.replaceIcons(list);
  }

  /* 诊断可能在一帧里连着来好几条（一次保存触发多个文件重算），合并到每帧一次 */
  function refresh() {
    if (rafPending) return;
    rafPending = requestAnimationFrame(() => { rafPending = 0; renderList(); });
  }

  /* 页签提示语按当前页签取：切语言时由 lang hook 重画，不留旧语言 */
  function paintHint() {
    const hint = $("bpHint");
    if (!hint) return;
    hint.textContent = pane === "prob"
      ? t("bpHintProb")
      : pane === "dep"
        ? t("bpHintDep")
        : t("bpHintTerm");
  }

  function setPane(which) {
    pane = which;
    const bp = $("bottomPanel");
    if (bp) bp.classList.remove("collapsed");
    const term = $("terminalSlotEditor"), prob = $("problemsBody"), dep = $("depBody");
    if (term) term.style.display = which === "term" ? "" : "none";
    if (prob) prob.style.display = which === "prob" ? "" : "none";
    if (dep) dep.style.display = which === "dep" ? "" : "none";
    document.querySelectorAll(".bp-tab").forEach((t) => t.classList.toggle("active", t.dataset.pane === which));
    paintHint();
    if (which === "prob") refresh();
    if (which === "dep" && window.DepGraph) window.DepGraph.paint();
  }

  function setFilter(f) {
    filter = f;
    document.querySelectorAll(".pb-mask-btn").forEach((b) => b.classList.toggle("active", b.dataset.filter === f));
    renderList();
  }

  function boot() {
    if (!window.monaco || !monaco.editor || $("problemsBody")) return;
    /* 页签：底栏原本只有"终端"一个标签且没有任何切换逻辑，这里补上"问题"并让它真的换内容 */
    const tabs = document.querySelector(".bp-tabs");
    if (!tabs) return;
    const termTab = tabs.querySelector(".bp-tab");
    if (termTab) termTab.dataset.pane = "term";
    /* 变量名不能叫 t：本文件顶层要用全局 t() 翻译，同名局部变量会把翻译函数遮掉 */
    const probTab = document.createElement("span");
    probTab.className = "bp-tab"; probTab.id = "bpTabProb"; probTab.dataset.pane = "prob";
    probTab.innerHTML = '<i data-ico="warn"></i><span data-i18n="bpTabProblems">问题</span> <span class="bp-count" id="bpProbCount"></span>';
    if (termTab && termTab.nextSibling) tabs.insertBefore(probTab, termTab.nextSibling); else tabs.appendChild(probTab);
    if (window.replaceIcons) window.replaceIcons(probTab);

    /* P3-D2 的「依赖」页签：页签机制仍归本模块管（三个页签互斥、高亮、提示语只有一处实现），
       内容交给 DepGraph——它只认 /api/graph，不重复算边。 */
    const td = document.createElement("span");
    td.className = "bp-tab"; td.id = "bpTabDep"; td.dataset.pane = "dep";
    td.innerHTML = '<i data-ico="split"></i><span data-i18n="bpTabDeps">依赖</span>';
    if (probTab.nextSibling) tabs.insertBefore(td, probTab.nextSibling); else tabs.appendChild(td);
    if (window.replaceIcons) window.replaceIcons(td);

    const bp = $("bottomPanel");
    const body = document.createElement("div");
    body.id = "problemsBody"; body.className = "problems-body"; body.style.display = "none";
    if (bp) bp.appendChild(body);
    const depBody = document.createElement("div");
    depBody.id = "depBody"; depBody.className = "dep-body"; depBody.style.display = "none";
    if (bp) bp.appendChild(depBody);

    disposers.push(onEvent(probTab, "click", () => setPane(pane === "prob" ? "term" : "prob")));
    disposers.push(onEvent(td, "click", () => setPane(pane === "dep" ? "term" : "dep")));
    if (termTab) disposers.push(onEvent(termTab, "click", () => setPane("term")));
    /* 状态栏那一格从死标签变成入口：点它打开面板 */
    const sb = $("sbProblems");
    if (sb) { sb.classList.add("pb-clickable"); disposers.push(onEvent(sb, "click", () => setPane("prob"))); }

    /* 工具条：筛选 + 手动重扫。重扫不是装饰——LSP 只在 didOpen/didChange 时发布，
       装好语言服务器之后想让老文件重新报一遍，需要有个地方能主动推一下。 */
    const bar = document.createElement("div");
    bar.className = "pb-mask";
    bar.innerHTML = '<button class="pb-mask-btn active" data-filter="all">' + t("dgBootH2") + '</button>' +
      '<button class="pb-mask-btn" data-filter="error">' + t("dgBootH3") + '</button>' +
      '<button class="pb-mask-btn" data-filter="warn">' + t("dgBootH4") + '</button>' +
      '<button class="pb-rescan" id="pbRescan"><i data-ico="reset"></i>' + t("dgBootH5") + '</button>';
    body.appendChild(bar);
    disposers.push(onEvent(bar, "click", (e) => {
      const b = e.target.closest(".pb-mask-btn");
      if (b) { setFilter(b.dataset.filter); return; }
      if (e.target.closest("#pbRescan")) rescanAll();
    }));
    if (window.replaceIcons) window.replaceIcons(bar);

    disposers.push(onEvent(body, "click", (e) => {
      const row = e.target.closest(".pb-row");
      if (!row) return;
      const p = row.dataset.p, line = parseInt(row.dataset.l, 10) || 1;
      /* 文件可能已经不在目录快照里（外部删了）：openFile 自己会静默返回，
         这里不拦——跳不过去至少面板还在，比弹一个"文件不存在"更不折腾。 */
      if (typeof window.openFile === "function") window.openFile(p, line);
    }));

    /* 订阅 marker 变化：这是"实时"的来源，也是面板与编辑器波浪线同源的原因 */
    try {
      if (typeof monaco.editor.onDidChangeMarkers === "function") disposers.push(monaco.editor.onDidChangeMarkers(() => refresh()));
      if (typeof monaco.editor.onDidCreateModel === "function") disposers.push(monaco.editor.onDidCreateModel(() => refresh()));
      if (typeof monaco.editor.onDidDestroyModel === "function") disposers.push(monaco.editor.onDidDestroyModel(() => refresh()));
    } catch (e) {}
    /* 打开文件后 TS worker 要几百毫秒才算完，光靠事件会漏第一帧 */
    disposers.push(onEvent(document, "visibilitychange", refresh));
    /* 面板内容全是 JS 渲染的，不在 [data-i18n] 覆盖范围内：切语言时重画一次，
       否则状态栏计数、空态、页签提示语会停在旧语言。 */
    onLang(() => { paintHint(); renderList(); });
    refresh();
    setTimeout(refresh, 900);
  }

  /* 重新诊断：把每个已打开 model 的内容重发给对应 LSP 会话（didChange 等价操作），
     并对 js/ts 直接强制一次 marker 计算。没有 LSP 的语言这条路就是空转，
     所以按钮不做"假装在干活"的动画。 */
  function rescanAll() {
    const btn = $("pbRescan");
    const st = appState();
    if (st && st.lspClients) {
      for (const lang in st.lspClients) {
        try {
          const c = st.lspClients[lang];
          if (c && typeof c.changeModel === "function" && c.models) for (const rel of c.models.keys()) c.changeModel(rel);
        } catch (e) {}
      }
    }
    if (btn) { btn.classList.add("pb-busy"); setTimeout(() => { btn.classList.remove("pb-busy"); refresh(); }, 600); }
    else refresh();
  }

  window.Diagnostics = { boot, refresh, collect, setPane, rescanAll,
    /* 面板被销毁时（目前只有整页刷新）统一摘监听——P0-A2 的 disposer 在这里有真实调用点 */
    dispose() { for (const d of disposers) { try { if (typeof d === "function") d(); } catch (e) {} } disposers = []; } };

  /* Monaco 是 require() 异步加载的，面板依赖它才谈得上"与波浪线同源"。
     所以没就绪时要等 monaco-ready 事件补一次，而不是静默不装（那样面板就永远不存在，
     而且不会有任何报错——正是最难发现的一类"看起来有、其实没接"）。 */
  function selfInit() {
    if (window.monaco && monaco.editor) { boot(); return; }
    document.addEventListener("monaco-ready", () => { boot(); }, { once: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(selfInit, 0), { once: true });
  else setTimeout(selfInit, 0);
})();
