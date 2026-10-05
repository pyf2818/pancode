/* pancode Git 提交模块 —— 从 app.js 抽出
   依赖: $ (core.js)
   加载顺序: core.js → commit.js → app.js */
"use strict";

function openCommit() {
  const m = $("commitModal");
  if (!m) return;
  m.style.display = "flex";
  $("cmResult").textContent = ""; $("cmResult").className = "cm-result";
  const branch = $("cmBranch"), box = $("cmChanges");
  const pushBtn = $("cmPush");
  const setPush = (enabled, why) => {
    if (!pushBtn) return;
    pushBtn.disabled = !enabled;
    pushBtn.title = why || "";
  };
  branch.textContent = "加载中…"; box.innerHTML = "";
  setPush(false, "加载中…");
  if ($("cmSummaryWrap")) $("cmSummaryWrap").style.display = "none";
  fetch("/api/git/status").then((r) => r.json()).then((d) => {
    if (!d.available) {
      branch.textContent = "当前工作区不是 Git 仓库（快照模式），无法提交";
      box.innerHTML = '<div class="cm-empty">未检测到 Git 仓库</div>';
      $("cmSubmit").disabled = true; setPush(false, "不是 Git 仓库"); return;
    }
    branch.textContent = "分支：" + d.branch + (d.remote ? " · 远端：" + d.remote : " · 无远端") +
      /* 打开的是仓库的子目录（monorepo 里只开 web/app）时，这里列的、提交的都只是这个子树，
         不说清楚就会让人以为"提交怎么漏了别的文件"。 */
      (d.sub ? " · 只含 " + d.sub + " 子目录" : "");
    setPush(!!d.remote, d.remote ? "提交后推送到 " + d.remote + "/" + d.branch : "这个仓库还没有远端（git remote 为空），只能本地提交");
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
/* 提交 → 可选推送。返回 true=已提交 / "nothing"=无改动可提交 / false=失败 */
function doCommit() {
  const res = $("cmResult");
  const msg = $("cmMsg").value.trim();
  const files = Array.from(document.querySelectorAll("#cmChanges .cm-chk"))
    .filter((c) => c.checked).map((c) => c.dataset.path);
  res.textContent = "提交中…"; res.className = "cm-result";
  return fetch("/api/git/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: msg, files }) })
    .then((r) => r.json()).then((d) => {
      if (d.ok) { res.textContent = "已提交（" + d.committed + " 个文件）"; res.className = "cm-result ok"; return true; }
      if (d.nothing) { res.textContent = "没有可提交的改动"; res.className = "cm-result"; return "nothing"; }
      res.textContent = "提交失败：" + (d.error || ""); res.className = "cm-result err"; return false;
    }).catch((e) => { res.textContent = "提交失败：" + e.message; res.className = "cm-result err"; return false; });
}
function closeCommitLater(ms) { setTimeout(() => { const m = $("commitModal"); if (m) m.style.display = "none"; }, ms); }
function doPush() {
  const res = $("cmResult");
  res.textContent = "推送中…"; res.className = "cm-result";
  return fetch("/api/git/push", { method: "POST" }).then((r) => r.json()).then((d) => {
    if (d.ok) { res.textContent = "已推送到 " + d.remote + "/" + d.branch; res.className = "cm-result ok"; closeCommitLater(1400); return; }
    res.textContent = "推送失败：" + (d.error || "");
    res.className = "cm-result" + (d.noRemote ? "" : " err");
  }).catch((e) => { res.textContent = "推送失败：" + e.message; res.className = "cm-result err"; });
}
if ($("cmSubmit")) $("cmSubmit").onclick = () => { doCommit().then((ok) => { if (ok === true) closeCommitLater(1200); }); };
if ($("cmPush")) $("cmPush").onclick = () => {
  doCommit().then((ok) => { if (ok !== false) doPush(); });
};
