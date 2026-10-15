/* pancode 终端模块 —— 从 app.js 抽出
   依赖: state.project (读), send (全局), $/esc (core.js)
   加载顺序: core.js → utils.js → terminal-mod.js → app.js */
"use strict";

let termTabs = {};        // tabId -> { title, lines: [ "<div class=tl>...</div>" ] }
let termActive = null;    // 当前激活标签
let termSeq = 0;
function genTermTabId() { return "t" + (++termSeq).toString(36) + Date.now().toString(36); }

function termHtmlFromEntry(e) {
  if (e.cmd) {
    return '<span class="tl-prompt">user@pancode</span><span class="tl-dim">:</span>' +
      '<span class="tl-info">~/' + esc(state.project) + '</span><span class="tl-dim">$ </span>' +
      '<span class="tl-cmd">' + esc(e.text) + "</span>";
  }
  return '<span class="' + (e.cls || "tl-cmd") + '">' + esc(e.text) + "</span>";
}

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
    const tab = termTabs[id];
    /* 标签名按"终端 N"这个形状现算，不直接显示存下来的 title：
       title 是建标签那一刻的语言写进协议里的，切过语言后它就成了旧语言。 */
    const num = (String(tab.title || "").match(/(\d+)\s*$/) || [])[1] || "";
    const b = document.createElement("div");
    b.className = "term-tab" + (id === termActive ? " active" : "");
    b.innerHTML = '<span class="term-tab-name">' + esc(t("terminalTabName", { n: num })) + '</span><span class="term-tab-x" title="' + esc(t("closeTerminalTab")) + '">✕</span>';
    b.querySelector(".term-tab-name").onclick = () => swapTerm(id);
    b.querySelector(".term-tab-x").onclick = (e) => { e.stopPropagation(); closeTermTab(id); };
    bar.appendChild(b);
  });
  const add = document.createElement("div");
  add.className = "term-tab-add";
  add.textContent = "＋";
  add.title = t("newTerminalTab");
  add.onclick = newTermTab;
  bar.appendChild(add);
}

function newTermTab() {
  const id = genTermTabId();
  const n = Object.keys(termTabs).length + 1;
  termTabs[id] = { title: t("tmNewTermTabtitleT151") + n, lines: [] };
  send({ type: "term.open", tabId: id, title: t("tmNewTermTabtitleT151") + n });
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

function initTermTabs(tabs) {
  termTabs = {};
  termActive = null;
  (tabs || []).forEach((tab) => {
    const lines = (tab.history || []).map((e) => '<div class="tl">' + termHtmlFromEntry(e) + "</div>");
    termTabs[tab.id] = { title: tab.title || t("tmInitTermTabstitleT138"), lines };
  });
  const ids = Object.keys(termTabs);
  if (ids.length) {
    swapTerm(ids[0]);
  } else {
    const id = genTermTabId();
    termTabs[id] = { title: t("tmInitTermTabstitleT138"), lines: ['<div class="tl"><span class="tl-dim term-intro">' + t("terminalIntro", { dir: (typeof state !== "undefined" && state.project) || "workspace" }) + '</span></div>'] };
    send({ type: "term.open", tabId: id, title: t("tmInitTermTabstitleT138") });
    swapTerm(id);
  }
}
/* 标签条与「+」提示是 JS 画的，不在 [data-i18n] 覆盖范围内：切语言时重画一次。 */
if (typeof onLang === "function") onLang(() => { try { renderTermTabs(); } catch (e) {} });
