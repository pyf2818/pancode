/* ============================================================
   W4 · 自动化任务面板（Automations）
   - 任务列表：状态徽标 / 下次执行 / 上次结果 + 运行·暂停·历史·删除
   - 新建表单（cron / 一次性）+ 编码场景模板快捷填充
   - 运行历史：每任务内联展开（最近 20 条，封顶防撑爆磁盘）
   ============================================================ */
"use strict";
let automationsList = [];   // 当前任务列表缓存
let autoHistoryOpen = {};   // 任务 id -> 历史区是否展开
let autoRunsCache = {};     // 任务 id -> runs 数组

function autoStatusBadge(s) {
  const map = {
    active: ["ok", "进行中"], paused: ["warn", "已暂停"],
    done: ["dim", "已完成"], missed: ["err", "已错过"],
  };
  const m = map[s] || ["dim", s || "未知"];
  return '<span class="mcp-badge ' + m[0] + '">' + m[1] + "</span>";
}
function autoSchedDesc(a) {
  if (a.scheduleType === "once") return ico("clock") + " 一次性 · " + (a.scheduledAt ? new Date(a.scheduledAt).toLocaleString() : "—");
  return ico("reset") + " 周期 · <code style='font-family:var(--mono);background:var(--bg4);padding:1px 6px;border-radius:4px'>" + escHtml(a.cron || "") + "</code>";
}
function autoFmtTs(ms) { return ms ? new Date(ms).toLocaleString() : "—"; }
function autoLastBadge(s) {
  if (s === "ok") return '<span class="mcp-badge ok">成功</span>';
  if (s === "fail") return '<span class="mcp-badge err">失败</span>';
  return '<span class="mcp-badge dim">未运行</span>';
}

async function openAutomations() {
  $("automationsModal").style.display = "flex";
  autoToggleForm(false);
  await loadAutomations();
}

function autoToggleForm(show) {
  const f = $("autoForm");
  if (show === undefined) show = f.style.display === "none";
  f.style.display = show ? "block" : "none";
  $("btnAutoNew").textContent = show ? "收起表单" : "＋ 新建任务";
}

async function loadAutomations() {
  const box = $("autoList");
  try {
    const r = await fetch("/api/automations").then((x) => x.json());
    automationsList = (r && r.automations) || [];
  } catch (e) { box.innerHTML = '<div style="color:var(--err,#e5484d);padding:12px">加载失败: ' + escHtml(e.message) + "</div>"; return; }
  if (!automationsList.length) {
    box.innerHTML = '<div style="color:var(--text-dim);padding:18px 4px;font-size:12px;text-align:center">还没有自动化任务。用下方模板一键创建：定时跑测试、夜间依赖审计、每周代码健康报告。</div>';
    return;
  }
  box.innerHTML = automationsList.map((a) => {
    const running = a.status === "active";
    return '<div class="auto-card" data-id="' + escHtml(a.id) + '" style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--bg)">'
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + '<b style="font-size:13px">' + escHtml(a.name) + "</b>" + autoStatusBadge(a.status) + autoLastBadge(a.lastStatus)
      + '<span style="flex:1"></span>'
      + '<button class="auto-act" data-act="run" data-id="' + escHtml(a.id) + '" style="font-size:11px;padding:3px 10px">' + ico("play") + " 立即运行</button>"
      + '<button class="auto-act" data-act="' + (running ? "pause" : "resume") + '" data-id="' + escHtml(a.id) + '" style="font-size:11px;padding:3px 10px">' + (running ? ico("stopSq") + " 暂停" : ico("play") + " 恢复") + "</button>"
      + '<button class="auto-act" data-act="hist" data-id="' + escHtml(a.id) + '" style="font-size:11px;padding:3px 10px">' + ico("history") + " 历史</button>"
      + '<button class="auto-act" data-act="del" data-id="' + escHtml(a.id) + '" style="font-size:11px;padding:3px 10px" title="删除任务">' + ico("trash") + "</button>"
      + "</div>"
      + '<div style="font-size:12px;color:var(--text-dim);margin-top:6px">' + autoSchedDesc(a) + "</div>"
      + '<div style="font-size:11px;color:var(--text-dim);margin-top:4px">上次: ' + autoFmtTs(a.lastRunAt) + " · 下次: " + autoFmtTs(a.nextRunAt) + "</div>"
      + '<div class="auto-prompt" style="font-size:11px;color:var(--text-dim);margin-top:4px;font-family:var(--mono);white-space:pre-wrap;max-height:60px;overflow:auto">' + escHtml(a.prompt || "") + "</div>"
      + '<div class="auto-runs" style="display:none;margin-top:8px"></div>'
      + "</div>";
  }).join("");
}

async function autoToggleHistory(id) {
  const card = document.querySelector('.auto-card[data-id="' + id + '"]');
  if (!card) return;
  const box = card.querySelector(".auto-runs");
  if (autoHistoryOpen[id]) { box.style.display = "none"; autoHistoryOpen[id] = false; return; }
  box.style.display = "block";
  box.innerHTML = '<div style="font-size:11px;color:var(--text-dim)">加载中…</div>';
  try {
    const r = await fetch("/api/automations/" + id + "/runs").then((x) => x.json());
    const runs = (r && r.runs) || [];
    autoRunsCache[id] = runs;
    box.innerHTML = runs.length
      ? runs.map((rn) => '<div style="border-top:1px dashed var(--border);padding:6px 0;font-size:11px">'
        + (rn.ok ? '<span style="color:var(--ok,#46a758)">' + ico("check") + "</span>" : '<span style="color:var(--err,#e5484d)">' + ico("close") + "</span>")
        + " <b>" + new Date(rn.startedAt).toLocaleString() + "</b> · " + ((rn.finishedAt || rn.startedAt) - rn.startedAt >= 0 ? (((rn.finishedAt || rn.startedAt) - rn.startedAt) / 1000).toFixed(1) + "s" : "")
        + (rn.error ? ' <span style="color:var(--err,#e5484d)">' + escHtml(rn.error).slice(0, 200) + "</span>" : "")
        + '<div style="color:var(--text-dim);white-space:pre-wrap;max-height:100px;overflow:auto;margin-top:3px;font-family:var(--mono)">' + escHtml((rn.output || "").slice(0, 1500)) + "</div></div>").join("")
      : '<div style="font-size:11px;color:var(--text-dim);padding:4px 0">还没有运行记录（点「立即运行」试一次）</div>';
  } catch (e) { box.innerHTML = '<div style="font-size:11px;color:var(--err,#e5484d)">加载历史失败</div>'; }
  autoHistoryOpen[id] = true;
}

/* 表单类型切换：cron / once 字段可见性 */
function autoSyncType() {
  const t = $("autoType").value;
  $("autoCronRow").style.display = t === "cron" ? "block" : "none";
  $("autoAtRow").style.display = t === "once" ? "block" : "none";
}

/* 编码场景模板快捷填充 */
const AUTO_TEMPLATES = [
  { name: "定时跑测试", cron: "0 */2 * * *", prompt: "在工作区内运行测试套件（先查看 package.json 确认测试命令，通常是 npm test 或 npx vitest run），汇总通过/失败数量；若有失败，列出失败的测试文件与关键报错，不要尝试修复。" },
  { name: "夜间依赖审计", cron: "0 3 * * *", prompt: "运行依赖安全审计（npm audit --json 或等效命令），汇总高危/严重漏洞数量与涉及的包名，给出升级建议（不要实际执行安装/升级）。" },
  { name: "每周代码健康报告", cron: "0 9 * * 1", prompt: "浏览仓库结构，输出一份简短代码健康报告：目录规模变化、TODO/FIXME 数量、明显的技术债或重复代码热点（只读分析，不要修改任何文件）。" },
];
function autoFillTemplate(i) {
  const t = AUTO_TEMPLATES[i];
  if (!t) return;
  autoToggleForm(true);
  $("autoName").value = t.name;
  $("autoType").value = "cron";
  $("autoCron").value = t.cron;
  $("autoPrompt").value = t.prompt;
  autoSyncType();
}

/* ---------- 事件绑定 ---------- */
/* 顶部按钮已移除（自动化任务改由命令面板 / 全局设置进入），此处容错绑定 */
$("btnAutomations") && ($("btnAutomations").onclick = openAutomations);
$("automationsClose").onclick = () => ($("automationsModal").style.display = "none");
$("btnAutoNew").onclick = () => autoToggleForm();
$("autoType").addEventListener("change", autoSyncType);
document.querySelectorAll(".auto-tpl").forEach((b) => {
  b.onclick = () => autoFillTemplate(parseInt(b.dataset.tpl, 10) || 0);
});
$("autoList").addEventListener("click", async (e) => {
  const btn = e.target.closest(".auto-act");
  if (!btn) return;
  const id = btn.dataset.id;
  const act = btn.dataset.act;
  if (act === "run") {
    btn.disabled = true; btn.textContent = "运行中…";
    try { await fetch("/api/automations/" + id + "/run", { method: "POST" }); toast("已触发，稍后刷新历史查看结果"); }
    catch (err) { toast("触发失败: " + err.message); }
    setTimeout(loadAutomations, 800);
  } else if (act === "pause" || act === "resume") {
    try { await fetch("/api/automations/" + id + "/" + act, { method: "POST" }); } catch (err) {}
    loadAutomations();
  } else if (act === "hist") {
    autoToggleHistory(id);
  } else if (act === "del") {
    showConfirm("删除自动化任务", "删除后该任务的配置与运行历史都会移除，且不可恢复。确定删除？", async () => {
      try { await fetch("/api/automations/" + id, { method: "DELETE" }); } catch (err) {}
      loadAutomations();
    });
  }
});
$("btnAutoSave").onclick = async () => {
  const st = $("autoStatus");
  const body = {
    name: $("autoName").value.trim(),
    prompt: $("autoPrompt").value.trim(),
    scheduleType: $("autoType").value,
  };
  if (body.scheduleType === "cron") body.cron = $("autoCron").value.trim();
  else body.scheduledAt = $("autoAt").value ? new Date($("autoAt").value).toISOString() : "";
  try {
    const r = await fetch("/api/automations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.ok) {
      toast("任务已创建，到点自动执行");
      $("autoName").value = ""; $("autoPrompt").value = ""; $("autoCron").value = ""; $("autoAt").value = "";
      autoToggleForm(false);
      loadAutomations();
    } else { st.className = "set-status err"; st.textContent = "创建失败: " + (r.error || "未知错误"); }
  } catch (e) { st.className = "set-status err"; st.textContent = "请求异常: " + e.message; }
};
