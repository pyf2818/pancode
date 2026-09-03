/* ============================================================
   pancode 后台进程面板 —— 查看 / 停止 Agent 启动的长驻进程
   依赖全局：$ / esc / toast / ico / replaceIcons（运行时解析）
   ============================================================ */
"use strict";

let _pmTimer = null;          // 自动刷新定时器
let _pmExpanded = new Set();  // 当前展开日志的进程名

function openProcsModal() {
  $("procsModal").style.display = "flex";
  refreshProcs();
  if (_pmTimer) clearInterval(_pmTimer);
  _pmTimer = setInterval(refreshProcs, 3000);
}

function closeProcsModal() {
  $("procsModal").style.display = "none";
  if (_pmTimer) { clearInterval(_pmTimer); _pmTimer = null; }
}

async function refreshProcs() {
  try {
    const r = await fetch("/api/processes").then((x) => x.json());
    if (!r || !r.ok) return;
    renderProcsList(r.processes || []);
    updateSbProcs(r.processes || []);
  } catch (e) {}
}

function updateSbProcs(procs) {
  const alive = procs.filter((p) => p.alive).length;
  const el = $("sbProcs");
  if (!el) return;
  if (alive > 0) {
    el.style.display = "";
    $("sbProcsTxt").textContent = alive + " 进程";
    el.classList.add("sb-procs-alive");
  } else {
    el.style.display = procs.length ? "" : "none";
    if (procs.length) {
      $("sbProcsTxt").textContent = "0 进程";
      el.classList.remove("sb-procs-alive");
    }
  }
}

function renderProcsList(procs) {
  const list = $("pmList");
  $("pmCount").textContent = procs.length ? (procs.length + " 个进程") : "";
  if (!procs.length) {
    list.innerHTML = '<div class="pm-empty"><i data-ico="pulse"></i><p>暂无后台进程</p><span>Agent 通过 <code>start_process</code> 启动的长驻服务会显示在这里</span></div>';
    if (typeof replaceIcons === "function") replaceIcons(list);
    return;
  }
  list.innerHTML = "";
  procs
    .sort((a, b) => (b.alive ? 1 : 0) - (a.alive ? 1 : 0) || (b.startedAt || 0) - (a.startedAt || 0))
    .forEach((p) => list.appendChild(renderProcCard(p)));
  if (typeof replaceIcons === "function") replaceIcons(list);
}

function renderProcCard(p) {
  const card = document.createElement("div");
  card.className = "pm-card" + (p.alive ? " alive" : " dead");
  const dur = p.startedAt ? fmtDur(Date.now() - p.startedAt) : "";
  const expanded = _pmExpanded.has(p.name);
  card.innerHTML =
    '<div class="pm-card-head">' +
      '<span class="pm-status-dot' + (p.alive ? " on" : "") + '"></span>' +
      '<span class="pm-name">' + esc(p.name) + '</span>' +
      '<span class="pm-badge">' + (p.alive ? "运行中" : "已退出" + (p.exitCode != null ? " (" + p.exitCode + ")" : "")) + '</span>' +
      '<span class="pm-pid">pid ' + esc(p.pid || "?") + '</span>' +
      (dur ? '<span class="pm-dur">' + dur + '</span>' : '') +
      '<span class="pm-actions">' +
        (p.alive ? '<button class="pm-btn-stop" data-name="' + esc(p.name) + '"><i data-ico="stop"></i> 停止</button>' : '') +
        '<button class="pm-btn-log" data-name="' + esc(p.name) + '"><i data-ico="' + (expanded ? "chevD" : "chevR") + '"></i> 日志</button>' +
      '</span>' +
    '</div>' +
    '<div class="pm-cmd"><code>' + esc(p.command) + '</code></div>' +
    (expanded ? '<div class="pm-log" data-name="' + esc(p.name) + '"><div class="pm-log-loading">加载中…</div></div>' : '');
  const stopBtn = card.querySelector(".pm-btn-stop");
  if (stopBtn) stopBtn.onclick = (e) => { e.stopPropagation(); stopProc(p.name); };
  const logBtn = card.querySelector(".pm-btn-log");
  if (logBtn) logBtn.onclick = (e) => { e.stopPropagation(); toggleProcLog(p.name); };
  if (expanded) loadProcLog(p.name);
  return card;
}

async function stopProc(name) {
  if (!confirm("停止进程 " + name + "？")) return;
  try {
    const r = await fetch("/api/processes/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((x) => x.json());
    if (r && r.ok) {
      toast("已停止 " + name);
      refreshProcs();
    } else {
      toast((r && r.error) || "停止失败");
    }
  } catch (e) { toast("停止失败: " + e); }
}

function toggleProcLog(name) {
  if (_pmExpanded.has(name)) _pmExpanded.delete(name);
  else _pmExpanded.add(name);
  refreshProcs();
}

async function loadProcLog(name) {
  const box = document.querySelector('.pm-log[data-name="' + CSS.escape(name) + '"]');
  if (!box) return;
  try {
    const r = await fetch("/api/processes/log?name=" + encodeURIComponent(name) + "&lines=200").then((x) => x.json());
    if (!r || !r.ok) { box.innerHTML = '<div class="pm-log-err">' + esc((r && r.error) || "读取失败") + '</div>'; return; }
    const lines = String(r.output || "").split("\n");
    box.innerHTML = '<pre class="pm-log-pre">' + lines.map((l) => esc(l)).join("\n") + '</pre>';
    box.scrollTop = box.scrollHeight;
  } catch (e) { box.innerHTML = '<div class="pm-log-err">读取失败</div>'; }
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m" + (s % 60 ? " " + (s % 60) + "s" : "");
  const h = Math.floor(m / 60);
  return h + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
}

$("sbProcs").onclick = openProcsModal;
$("pmClose").onclick = closeProcsModal;
$("pmRefresh").onclick = refreshProcs;