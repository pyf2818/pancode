/* ============================================================
   齿轮抽屉（设置按钮的第一层）+ 反馈小窗 + GitHub 信息
   ------------------------------------------------------------
   为什么不是直接开全屏工作台：齿轮下最常改的只有 主题 / 语言 / 模式 / 模型，
   全屏工作台有 17 个分区，为了切一次深色要点三下。这里把这些提到第一层，
   子项在原位抽屉式展开（grid-template-rows 0fr→1fr，不用重画整张列表，
   重画会让展开动画变成闪一下），全屏工作台仍从底部「全部设置」进。

   GitHub 侧刻意不做任何"真点亮 / 真建单"：星数读公开 API，点星开仓库页；
   反馈拼一条预填好的 new-issue 链接交给系统浏览器。应用里不落任何令牌。
   ============================================================ */
"use strict";

const GH_REPO = "pyf2818/pancode";
const GH_URLS = {
  home: "https://github.com/" + GH_REPO,
  issues: "https://github.com/" + GH_REPO + "/issues",
  newIssue: "https://github.com/" + GH_REPO + "/issues/new",
  api: "https://api.github.com/" + "repos/" + GH_REPO,
};
const GM = { root: null, shown: false, expanded: null, stars: undefined, version: "" };
const FB = { root: null, shots: [] };

const gmApp = () => (typeof state !== "undefined" && state) || window.state || {};

/* ---------- 小工具 ---------- */
function gmOpenExternal(url) {
  /* Electron 侧 setWindowOpenHandler 会把它转成 shell.openExternal；
     纯浏览器里就是开一个新标签。两条路都不经过我们的服务端。 */
  const w = window.open(url, "_blank", "noopener");
  if (!w && typeof toast === "function") toast(t("gmPopupBlocked"), 4000);
}

function gmThemePref() {
  return (typeof getThemePref === "function") ? getThemePref() : (localStorage.getItem("cw-theme") || "dark");
}

function gmEngineText() {
  const e = gmApp().engine;
  if (!e) return t("gmEngineLoading");
  return e.mode === "llm" ? (e.model || t("gmNoModel")) : t("engineDemo");
}

function gmModeText() {
  const m = gmApp().agentMode || "agent";
  return m === "plan" ? t("gmModePlan") : m === "ask" ? t("gmModeAsk") : t("gmModeAgent");
}

function gmStarText() {
  if (GM.stars === undefined) return t("gmStarsLoading");
  if (GM.stars === null) return t("gmStarsUnknown");
  return GM.stars === 1 ? t("gmStarsOne", { n: 1 }) : t("gmStarsN", { n: GM.stars });
}

async function gmFetchStars() {
  const KEY = "cw-gh-stars";
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) {}
  if (cached && Array.isArray(cached) && Date.now() - cached[1] < 6 * 3600 * 1000) {
    GM.stars = cached[0];
    gmRepaintValues();
    return;
  }
  try {
    const r = await fetch(GH_URLS.api, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    GM.stars = Number(j.stargazers_count) || 0;
    try { localStorage.setItem(KEY, JSON.stringify([GM.stars, Date.now()])); } catch (e) {}
  } catch (e) {
    /* 离线 / 限流：读不到就说读不到。把失败画成 0 颗星是撒谎。 */
    GM.stars = cached && Array.isArray(cached) ? cached[0] : null;
  }
  gmRepaintValues();
  document.dispatchEvent(new CustomEvent("pancode:gh-stars", { detail: { stars: GM.stars } }));
}

function gmRepaintValues() {
  if (!GM.root || !GM.shown) return;
  /* 表头与页脚是一次性建的，只重画列表会把「设置 / 全部设置…」留在建它时的语言里 */
  const head = GM.root.querySelector(".gm-head-txt");
  if (head) head.textContent = t("gmSettings");
  const ver = GM.root.querySelector(".gm-ver");
  if (ver) ver.textContent = GM.version;
  const all = GM.root.querySelector(".gm-all span");
  if (all) all.textContent = t("gmAllSettings");
  const box = GM.root.querySelector(".gm-list");
  if (box) { GM.root.replaceChild(gmList(), box); gmWire(GM.root); }
}

/* ---------- 列表 ---------- */
function gmSpec() {
  const pref = gmThemePref();
  const lang = (typeof getLang === "function") ? getLang() : "zh";
  const mode = gmApp().agentMode || "agent";
  return [
    { id: "appearance", icon: "sun", label: t("gmAppearance"), value: pref === "light" ? t("gmThemeLight") : pref === "auto" ? t("gmThemeAuto") : t("gmThemeDark"),
      seg: [["dark", "gmThemeDark", () => applyTheme("dark")], ["light", "gmThemeLight", () => applyTheme("light")], ["auto", "gmThemeAuto", () => applyTheme("auto")]], cur: pref },
    { id: "lang", icon: "globe", label: t("gmLanguage"), value: lang === "en" ? "English" : "中文",
      seg: [["zh", "gmLangZh", () => setLang("zh")], ["en", "gmLangEn", () => setLang("en")]], cur: lang },
    { id: "mode", icon: "sparkle", label: t("gmAgentMode"), value: gmModeText(),
      seg: [["agent", "gmModeAgent", () => window.setAgentMode && setAgentMode("agent")], ["plan", "gmModePlan", () => window.setAgentMode && setAgentMode("plan")], ["ask", "gmModeAsk", () => window.setAgentMode && setAgentMode("ask")]], cur: mode },
    { id: "model", icon: "robot", label: t("gmModel"), value: gmEngineText(),
      links: [["gmOpenModelSettings", () => { gmClose(); openWorkbench("model"); }], ["gmOpenPerms", () => { gmClose(); openWorkbench("perms"); }]] },
    { id: "github", icon: "star", label: "GitHub", value: gmStarText(),
      links: [["gmRepoHome", () => gmOpenExternal(GH_URLS.home)], ["gmIssues", () => gmOpenExternal(GH_URLS.issues)], ["gmReleases", () => gmOpenExternal(GH_URLS.home + "/releases")]] },
    { id: "shortcuts", icon: "keyboard", label: t("gmShortcuts"), value: "Ctrl / ⌘ + ?", action: () => { gmClose(); if (typeof openShortcuts === "function") openShortcuts(); } },
    { id: "feedback", icon: "bug", label: t("gmFeedback"), action: () => { gmClose(); fbOpen(); } },
    { id: "about", icon: "read", label: t("gmAbout"), action: () => { gmClose(); openWorkbench("about"); } },
  ];
}

function gmLinkRow(items) {
  const wrap = document.createElement("div");
  wrap.className = "gm-links";
  items.forEach(([key, run]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gm-link";
    b.innerHTML = ico("link") + "<span></span>";
    b.querySelector("span").textContent = t(key);
    b.onclick = run;
    wrap.appendChild(b);
  });
  return wrap;
}

function gmList() {
  const list = document.createElement("div");
  list.className = "gm-list";
  gmSpec().forEach((it) => {
    const item = document.createElement("div");
    item.className = "gm-item" + (GM.expanded === it.id ? " open" : "");
    const row = document.createElement("button");
    row.type = "button";
    row.className = "gm-row" + (it.action ? " gm-row-act" : "");
    row.dataset.gm = it.id;
    const hasKids = !!(it.seg || (it.links && it.links.length));
    row.innerHTML = '<span class="gm-ic"></span><span class="gm-name"></span><span class="gm-val"></span>' + (hasKids ? '<span class="gm-chev"></span>' : "");
    row.querySelector(".gm-ic").innerHTML = ico(it.icon);
    row.querySelector(".gm-name").textContent = it.label;
    const v = row.querySelector(".gm-val");
    v.textContent = it.value || "";
    if (it.id === "github") v.dataset.gmStars = "1";
    if (hasKids) row.querySelector(".gm-chev").innerHTML = ico("chevD");
    row.onclick = () => {
      if (it.action) { it.action(); return; }
      if (!hasKids) return;
      /* 展开只翻 class：整张列表重画会让 0fr→1fr 的过渡变成闪一下 */
      const box = GM.root.querySelector(".gm-list");
      const willOpen = GM.expanded !== it.id;
      box.querySelectorAll(".gm-item.open").forEach((n) => n.classList.remove("open"));
      GM.expanded = willOpen ? it.id : null;
      if (willOpen) item.classList.add("open");
    };
    item.appendChild(row);
    if (hasKids) {
      const sub = document.createElement("div");
      sub.className = "gm-sub";
      const inner = document.createElement("div");
      sub.appendChild(inner);
      if (it.seg) {
        const seg = document.createElement("div");
        seg.className = "gm-seg";
        it.seg.forEach(([val, key, run]) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "gm-seg-btn" + (it.cur === val ? " on" : "");
          b.textContent = t(key);
          b.onclick = () => { run(); GM.expanded = null; gmRepaintValues(); };
          seg.appendChild(b);
        });
        inner.appendChild(seg);
      }
      if (it.links && it.links.length) inner.appendChild(gmLinkRow(it.links));
      item.appendChild(sub);
    }
    list.appendChild(item);
  });
  return list;
}

function gmWire(root) {
  const all = root.querySelector(".gm-all");
  if (all) all.onclick = () => { gmClose(); openWorkbench("model"); };
}

function gmBuild() {
  if (GM.root) return GM.root;
  const el = document.createElement("div");
  el.id = "gearMenu";
  el.className = "gm hidden";
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", t("gmSettings"));
  const head = document.createElement("div");
  head.className = "gm-head";
  head.innerHTML = '<span class="gm-head-ic"></span><span class="gm-head-txt"></span><span class="gm-ver"></span>';
  head.querySelector(".gm-head-ic").innerHTML = ico("gear");
  head.querySelector(".gm-head-txt").textContent = t("gmSettings");
  head.querySelector(".gm-ver").textContent = GM.version;
  el.appendChild(head);
  el.appendChild(gmList());
  const foot = document.createElement("button");
  foot.type = "button";
  foot.className = "gm-all";
  foot.innerHTML = "<span></span>" + ico("chevR");
  foot.querySelector("span").textContent = t("gmAllSettings");
  el.appendChild(foot);
  document.body.appendChild(el);
  GM.root = el;
  el.addEventListener("click", (e) => e.stopPropagation());
  gmWire(el);
  return el;
}

function gmPlace() {
  const btn = document.getElementById("btnSettings");
  if (!btn || !GM.root) return;
  const r = btn.getBoundingClientRect();
  const w = GM.root.offsetWidth || 300;
  GM.root.style.top = (r.bottom + 6) + "px";
  GM.root.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + "px";
}

function gmOpen() {
  const el = gmBuild();
  el.classList.remove("hidden");
  GM.shown = true;
  gmPlace();
  if (GM.stars === undefined) gmFetchStars();
  if (!GM.version) fetch("/api/version").then((r) => r.json()).then((j) => {
    GM.version = j.version || "";
    const v = GM.root && GM.root.querySelector(".gm-ver");
    if (v) v.textContent = GM.version;
  }).catch(() => {});
}

function gmClose() {
  if (!GM.root || GM.shown) { GM.root && GM.root.classList.add("hidden"); }
  GM.shown = false;
  GM.expanded = null;
}

function gmToggle() {
  if (GM.shown) gmClose(); else gmOpen();
}
window.toggleGearMenu = gmToggle;
window.closeGearMenu = gmClose;

document.addEventListener("click", (e) => {
  if (!GM.shown) return;
  if (GM.root && GM.root.contains(e.target)) return;
  if (e.target.closest && e.target.closest("#btnSettings")) return;
  gmClose();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && GM.shown) { e.stopPropagation(); gmClose(); }
}, true);
window.addEventListener("resize", () => { if (GM.shown) gmPlace(); });
if (typeof onLang === "function") onLang(() => { if (GM.shown) gmRepaintValues(); });

/* ============================================================
   反馈小窗：一个输入框 + 截图，拼预填链接交给系统浏览器
   ============================================================ */
function fbDiagLines() {
  const app = gmApp();
  const ua = navigator.userAgent;
  const lines = [];
  lines.push("pancode " + (GM.version || "—"));
  lines.push("OS " + (/\(([^)])*\)/.exec(ua) ? RegExp.$1 : ua.slice(0, 60)));
  lines.push("Engine " + (app.engine && app.engine.mode === "llm" ? "LLM · " + (app.engine.model || "") : "demo"));
  const ws = String(app.workspace || "").replace(/[\\/]+$/, "");
  if (ws) lines.push("Workspace " + ws.split(/[\\/]/).pop() + (app.branchName && !app.noGit ? " · " + app.branchName : ""));
  lines.push("Language " + ((typeof getLang === "function") ? getLang() : "zh"));
  return lines;
}

function fbBuild() {
  if (FB.root) return FB.root;
  const mask = document.createElement("div");
  mask.id = "fbModal";
  mask.className = "fb hidden";
  mask.setAttribute("role", "dialog");
  mask.setAttribute("aria-modal", "true");
  mask.setAttribute("aria-label", t("fbTitle"));
  mask.innerHTML =
    '<div class="fb-box">' +
      '<header class="fb-head"><span class="fb-head-ic"></span><span class="fb-title"></span>' +
        '<button type="button" class="fb-x" id="fbClose"></button></header>' +
      '<textarea id="fbText" class="fb-text" rows="5"></textarea>' +
      '<div class="fb-shots" id="fbShots"></div>' +
      '<label class="fb-drop" id="fbDrop"><span></span><input type="file" id="fbFile" accept="image/*" multiple></label>' +
      '<label class="fb-diag"><input type="checkbox" id="fbDiag" checked><span></span></label>' +
      '<pre class="fb-pre" id="fbPre"></pre>' +
      '<footer class="fb-foot"><button type="button" class="fb-btn" id="fbCancel"></button>' +
        '<button type="button" class="fb-btn fb-go" id="fbGo"></button></footer>' +
    '</div>';
  document.body.appendChild(mask);
  FB.root = mask;
  const q = (s) => mask.querySelector(s);
  q(".fb-head-ic").innerHTML = ico("bug");
  q(".fb-title").textContent = t("fbTitle");
  q("#fbClose").innerHTML = ico("close");
  q("#fbClose").title = t("fbCancel");
  q("#fbDrop span").textContent = t("fbAddShot");
  q(".fb-diag span").textContent = t("fbDiag");
  q("#fbCancel").textContent = t("fbCancel");
  q("#fbGo").textContent = t("fbSubmit");
  mask.querySelector(".fb-text").placeholder = t("fbBodyPh");

  q("#fbClose").onclick = fbClose;
  q("#fbCancel").onclick = fbClose;
  q("#fbGo").onclick = fbSubmit;
  q("#fbDiag").onchange = fbPreview;
  q("#fbText").oninput = fbPreview;
  q("#fbFile").onchange = (e) => { fbAddFiles(e.target.files); e.target.value = ""; };
  mask.onpaste = (e) => { const f = []; (e.clipboardData || {}).items && Array.from(e.clipboardData.items).forEach((it) => { if (it.type.indexOf("image/") === 0) { const b = it.getAsFile(); if (b) f.push(b); } }); if (f.length) { e.preventDefault(); fbAddFiles(f); } };
  mask.ondragover = (e) => { e.preventDefault(); mask.classList.add("drop"); };
  mask.ondragleave = () => mask.classList.remove("drop");
  mask.ondrop = (e) => { e.preventDefault(); mask.classList.remove("drop"); fbAddFiles(e.dataTransfer.files); };
  mask.addEventListener("click", (e) => { if (e.target === mask) fbClose(); });
  return mask;
}

function fbAddFiles(files) {
  Array.from(files || []).forEach((f) => {
    if (!f || f.type.indexOf("image/") !== 0) return;
    const url = URL.createObjectURL(f);
    FB.shots.push({ blob: f, url, name: f.name || "screenshot.png" });
  });
  fbPaintShots();
  fbPreview();
}

function fbPaintShots() {
  const box = FB.root.querySelector("#fbShots");
  box.innerHTML = "";
  box.style.display = FB.shots.length ? "flex" : "none";
  FB.shots.forEach((s, i) => {
    const cell = document.createElement("div");
    cell.className = "fb-shot";
    cell.innerHTML = '<img alt=""><button type="button"></button>';
    cell.querySelector("img").src = s.url;
    const x = cell.querySelector("button");
    x.title = t("fbRemoveShot");
    x.innerHTML = ico("close");
    x.onclick = () => { const [gone] = FB.shots.splice(i, 1); if (gone) URL.revokeObjectURL(gone.url); fbPaintShots(); fbPreview(); };
    box.appendChild(cell);
  });
}

function fbBody() {
  const text = FB.root.querySelector("#fbText").value.trim();
  const parts = [text, "", (FB.shots.length ? t("fbShotNote") : "")];
  if (FB.root.querySelector("#fbDiag").checked) {
    parts.push("", "---", "```", fbDiagLines().join("\n"), "```");
  }
  return parts.join("\n").trim();
}

function fbPreview() {
  const pre = FB.root.querySelector("#fbPre");
  const text = FB.root.querySelector("#fbText").value.trim();
  pre.style.display = text ? "block" : "none";
  /* 预览给人看的是"将要提交的内容"，不是百分号编码后的 URL —— 那串谁都读不动 */
  if (text) {
    const body = fbBody();
    pre.textContent = fbIssueTitle() + "\n\n" + body.slice(0, 400) + (body.length > 400 ? "…" : "");
  }
}

function fbIssueTitle() {
  const text = FB.root.querySelector("#fbText").value.trim();
  const first = (text.split("\n")[0] || t("fbTitle")).trim();
  return (GM.version ? "[v" + GM.version + "] " : "") + first.slice(0, 60);
}

function fbIssueUrl() {
  return GH_URLS.newIssue + "?expand=1&title=" + encodeURIComponent(fbIssueTitle()) + "&body=" + encodeURIComponent(fbBody());
}

async function fbSubmit() {
  const text = FB.root.querySelector("#fbText").value.trim();
  if (!text) { if (typeof toast === "function") toast(t("fbNeedText"), 2600); return; }
  const url = fbIssueUrl();
  /* 截图只能靠用户在 GitHub 的编辑框里粘贴 / 拖入（issue 正文不收 base64 图，
     附件接口又不是公开可写的）。所以提交前把第一张图放回剪贴板，并明说这一步。 */
  if (FB.shots.length && navigator.clipboard && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": FB.shots[0].blob.type === "image/png" ? FB.shots[0].blob : await fbToPng(FB.shots[0].blob) })]);
      if (typeof toast === "function") toast(t("fbCopied"), 3200);
    } catch (e) {
      if (typeof toast === "function") toast(t("fbNoClipboard"), 3600);
    }
  }
  gmOpenExternal(url);
}

function fbToPng(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.getContext("2d").drawImage(img, 0, 0);
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png");
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

function fbOpen() {
  const m = fbBuild();
  m.classList.remove("hidden");
  setTimeout(() => m.querySelector("#fbText").focus(), 30);
}
function fbClose() { if (FB.root) FB.root.classList.add("hidden"); }
window.openFeedback = fbOpen;
window.closeFeedback = fbClose;

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && FB.root && !FB.root.classList.contains("hidden")) { e.stopPropagation(); fbClose(); }
}, true);

/* workbench.js 先于本文件求值，但它调用这些是在全部脚本跑完之后 —— 显式挂到 window，
   免得关于页去猜词法全局的名字 */
window.GH = GH_URLS;
window.gmStarText = gmStarText;
window.gmFetchStars = gmFetchStars;
