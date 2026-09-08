/* pancode 补丁审阅模块 —— 从 app.js 抽出
   依赖: state/convId (app.js), send (app.js), $ (core.js), toast/escHtml/getTheme/monacoLangOf (utils.js), fileIco (icons.js), monaco (global)
   加载顺序: core.js → utils.js → icons.js → patch-review.js → app.js */
"use strict";

/* ---------------- 补丁审阅面板（agent apply_edit 的改动审阅） ---------------- */
let patchDiffEditor = null;

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
  const btn = $("sbPatchReview"); if (btn) btn.style.display = "none";
}

function reopenPatchReview() {
  if (!state.patch || !state.patch.files || !state.patch.files.length) return;
  if (!state.monacoReady) { toast("编辑器尚未就绪"); return; }
  $("patchModal").style.display = "flex";
  renderPatchList();
  renderPatchDiff(state.patch._sel || state.patch.files[0].path);
  const btn = $("sbPatchReview"); if (btn) btn.style.display = "none";
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
    theme: getTheme() === "light" ? "pancode-light" : "pancode-dark", readOnly: true, automaticLayout: true, fontSize: 13,
    renderSideBySide: true, minimap: { enabled: false },
    ignoreTrimWhitespace: false, renderIndicators: true,
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
  const btn = $("sbPatchReview");
  if (btn) btn.style.display = (state.patch && state.patch.files && state.patch.files.length) ? "inline-flex" : "none";
}

$("patchAcceptAll").onclick = () => patchApply(state.patch.files.map((f) => f.path));
$("patchRejectAll").onclick = () => patchReject(state.patch.files.map((f) => f.path));
$("patchApplySelected").onclick = () => { if (state.patch && state.patch._sel) patchApplySelected(state.patch._sel); };
$("patchClose").onclick = closePatchModal;
{ const b = $("sbPatchReview"); if (b) b.onclick = reopenPatchReview; }
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("patchModal").style.display !== "none" && !e.target.closest("input,textarea")) {
    closePatchModal();
  }
});
