/* ============================================================
   pancode · 依赖视图（P3-D2 代码知识图谱的界面那一面）
   数据只来自 /api/graph，而 /api/graph 用的是 Agent 自己那份 repo 索引
   （engine._repoIndex，fileChanged 会置脏）。不在前端另算一套边——
   否则就会出现"面板说没有依赖、Agent 说有一串"的两套真相。
   边的口径是文件级 import/require，所以这里讲的是"牵连"，不是类型级调用图；
   文案照这个口径写，不夸大成"这些文件都用到了它"。
   ============================================================ */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /* 并发回来的响应丢旧的：快速切标签页时后发先至会让面板停在另一个文件的依赖上 */
  let seq = 0;
  let depth = 2;
  let lastKey = null;

  function activeFile() {
    try { if (typeof state !== "undefined" && state) return state.activeFile; } catch (e) {}
    return (window.state || {}).activeFile || null;
  }

  function chip(path) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dg-chip";
    b.title = t("dpChiptitleT148") + path;
    b.textContent = path;
    b.onclick = () => { if (typeof window.openFile === "function") window.openFile(path, 1); };
    return b;
  }

  function section(title, hint, paths, emptyText) {
    const wrap = document.createElement("div");
    wrap.className = "dg-sec";
    const head = document.createElement("div");
    head.className = "dg-sec-head";
    head.innerHTML = "<span>" + esc(title) + "</span>" + (hint ? '<span class="dg-sec-hint">' + esc(hint) + "</span>" : "");
    wrap.appendChild(head);
    if (!paths || !paths.length) {
      const e = document.createElement("div");
      e.className = "dg-empty";
      e.textContent = emptyText || "无";
      wrap.appendChild(e);
      return wrap;
    }
    const list = document.createElement("div");
    list.className = "dg-chips";
    paths.forEach((p) => list.appendChild(chip(p)));
    wrap.appendChild(list);
    return wrap;
  }

  function renderOverview(o) {
    const host = $("depBody");
    if (!host) return;
    /* 不清 host：paint() 已经清过并铺好了那排"层数"按钮，
       这里再清一次会把工具条连按钮一起抹掉（表现为页签能用，但换不了展开层数）。 */
    const bar = document.createElement("div");
    bar.className = "dg-note";
    bar.textContent = t("dpRenderOverviewtextContentT82")
      + o.files + " 个文件，其中 " + (o.linked || 0) + " 个之间有 import/require 关系，共 " + o.edges + " 条边。";
    host.appendChild(bar);
    const hubs = document.createElement("div");
    hubs.className = "dg-sec";
    hubs.innerHTML = '<div class="dg-sec-head"><span>' + t("dpRenderOverviewH52") + '</span><span class="dg-sec-hint">' + t("dpRenderOverviewH53") + '</span></div>';
    if (!o.hubs.length) {
      const e = document.createElement("div"); e.className = "dg-empty";
      e.textContent = t("dpRenderOverviewtextContentT83");
      hubs.appendChild(e);
    } else {
      const ul = document.createElement("div"); ul.className = "dg-hubs";
      o.hubs.forEach((h) => {
        const row = document.createElement("button");
        row.type = "button"; row.className = "dg-hub";
        row.innerHTML = "<code>" + esc(h.path) + "</code><span>被 " + h.in + " 个文件依赖 · 它依赖 " + h.out + " 个</span>";
        row.onclick = () => { if (typeof window.openFile === "function") window.openFile(h.path, 1); };
        ul.appendChild(row);
      });
      hubs.appendChild(ul);
    }
    host.appendChild(hubs);
    const cyc = document.createElement("div");
    cyc.className = "dg-sec";
    cyc.innerHTML = '<div class="dg-sec-head"><span>' + t("dpRenderOverviewH54") + '</span><span class="dg-sec-hint">' + t("dpRenderOverviewH55") + '</span></div>';
    if (!o.cycles.length) {
      const e = document.createElement("div"); e.className = "dg-empty"; e.textContent = t("dpRenderOverviewtextContentT84");
      cyc.appendChild(e);
    } else {
      o.cycles.forEach((c) => {
        const row = document.createElement("div"); row.className = "dg-cycle";
        row.textContent = c.join(" ← ") + " ← (回到 " + c[0] + ")";
        cyc.appendChild(row);
      });
    }
    host.appendChild(cyc);
    if (o.orphanCount) {
      const orp = document.createElement("div");
      orp.className = "dg-sec";
      orp.innerHTML = '<div class="dg-sec-head"><span>' + t("dpRenderOverviewH56") + '</span><span class="dg-sec-hint">' + t("dpRenderOverviewH57") + '</span></div>'
        + '<div class="dg-empty">' + o.orphanCount + " 个文件既没 import 别人，也没人 import 它"
        + (o.orphans && o.orphans.length ? "（如 " + o.orphans.slice(0, 4).join("、") + "）" : "") + "</div>";
      host.appendChild(orp);
    }
  }

  function renderFile(node) {
    const host = $("depBody");
    if (!host) return;
    const head = document.createElement("div");
    head.className = "dg-head";
    head.innerHTML = '<code>' + esc(node.path) + "</code>"
      + (node.known ? "" : '<span class="dg-badge dg-badge-dim">' + t("dpRenderFileH58") + '</span>');
    host.appendChild(head);
    host.appendChild(section("谁依赖它", "直接 import 这个文件的", node.importers,
      "没有文件依赖它。要么它是入口/脚本，要么它的引用方用了这里识别不了的动态加载。"));
    host.appendChild(section("它依赖谁", "它直接 import 的", node.deps,
      "它没有 import/require 任何工作区内的文件。"));
    const spill = node.impact || [];
    const trans = spill.filter((r) => r.depth > 1);
    const wrap = document.createElement("div");
    wrap.className = "dg-sec";
    wrap.innerHTML = '<div class="dg-sec-head"><span>牵连范围（' + depth + " 层内）</span>"
      + '<span class="dg-sec-hint">' + t("dpRenderFileH59") + '</span></div>';
    if (!spill.length) {
      const e = document.createElement("div"); e.className = "dg-empty";
      e.textContent = t("dpRenderFiletextContentT85");
      wrap.appendChild(e);
    } else {
      const list = document.createElement("div"); list.className = "dg-chips";
      spill.forEach((r) => {
        const b = chip(r.path);
        b.innerHTML = '<span class="dg-l">L' + r.depth + "</span>" + esc(r.path);
        b.title = t("dpRenderFiletitleT149") + r.via + t("grrenderFileC39");
        list.appendChild(b);
      });
      wrap.appendChild(list);
      const n = document.createElement("div"); n.className = "dg-note";
      n.textContent = t("acAuditSwitchwbRowT111") + spill.length + t("grrenderFileC40") + trans.length + t("grrenderFileC41")
        + "口径是文件级：谁 import 了它就算牵连，具体有没有用到你改的那个导出，请逐个确认。";
      wrap.appendChild(n);
    }
    host.appendChild(wrap);
  }

  function toolbar() {
    const host = $("depBody");
    if (!host) return;
    const bar = document.createElement("div");
    bar.className = "dg-bar";
    [1, 2, 3].forEach((d) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "dg-depth" + (d === depth ? " on" : "");
      b.textContent = d + " 层";
      b.onclick = () => { depth = d; paint(true); };
      bar.appendChild(b);
    });
    const tip = document.createElement("span");
    tip.className = "dg-bar-tip";
    tip.textContent = t("dpToolbartextContentT87");
    bar.appendChild(tip);
    host.appendChild(bar);
  }

  async function paint(force) {
    const host = $("depBody");
    if (!host) return;
    const file = activeFile();
    /* 只在"这一屏真的变了"时才重新拉：页签栏任何 DOM 变动都会回调，
       没有这把钥匙就会每动一下标签页就打一次 /api/graph。 */
    const key = (file || "—") + "@" + depth;
    if (!force && key === lastKey) return;
    lastKey = key;
    const mine = ++seq;
    host.innerHTML = "";
    toolbar();
    if (!file) {
      const loading = document.createElement("div");
      loading.className = "dg-empty"; loading.textContent = t("dpToolbartextContentT88");
      host.appendChild(loading);
    }
    let r;
    try { r = await fetch("/api/graph?file=" + encodeURIComponent(file || "") + "&depth=" + depth).then((x) => x.json()); }
    catch (e) {
      if (mine !== seq) return;
      host.innerHTML = "";
      toolbar();
      const err = document.createElement("div");
      err.className = "dg-empty";
      err.textContent = t("dpToolbartextContentT150") + (e.message || e);
      host.appendChild(err);
      return;
    }
    if (mine !== seq) return;   // 已有更新的请求在路上，这一份丢掉
    host.innerHTML = "";
    if (r.ok && r.files && ((r.node && file) || !file)) {
      /* 工具条只在"看某个文件的上下游"时出现——整仓形状那一屏没有层数可言，
         摆三个按了没反应的按钮比不摆更糟。 */
      toolbar();
    }
    if (!r.ok) {
      const err = document.createElement("div");
      err.className = "dg-empty";
      err.textContent = r.error || "依赖图不可用";
      host.appendChild(err);
      return;
    }
    if (!r.files) {
      const e = document.createElement("div");
      e.className = "dg-empty";
      e.textContent = t("dpToolbartextContentT90");
      host.appendChild(e);
      return;
    }
    if (r.node && file) renderFile(r.node);
    else renderOverview(r);
  }

  /* 换文件就重画。信号取自标签栏 DOM 而不是 Monaco 的 editor 实例：
     本模块加载时 app.js 那个顶层 editor 变量还没赋值，而顶层 let/const 又不是 window 属性，
     在 boot 时抓实例会静默抓不到 → 面板永远停在第一次点页签时的那个文件上。
     标签栏是"当前文件"这件事唯一稳定的可见证据。 */
  function watchActiveTab() {
    const bar = $("tabbar");
    if (!bar || typeof MutationObserver === "undefined") return;
    new MutationObserver(() => paint(false)).observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchActiveTab, { once: true });
  else watchActiveTab();

  window.DepGraph = { paint, depth: () => depth, activeFile };
})();
