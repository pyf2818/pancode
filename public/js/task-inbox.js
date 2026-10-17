/* ============================================================
   任务收件箱（Agents 左栏「任务」页）
   ------------------------------------------------------------
   回答的是"我派出去的活，现在到哪一步了"：谁在跑、谁卡在我这里等你批、
   上次进程退出时哪些没跑完、最近收口的结果如何。点一张卡 = 打开它那条会话。

   数据源是服务端任务表（server/tasks.js，由事件流喂：user.msg / tool.end /
   tool.pending / agent.done / agent.error / goal.continue / chat.queued），
   前端以前一行都没接 —— 只有 Electron 托盘那行"在跑 N"读它。

   刷新：WS 事件驱动（app.js 的 handleEvent 里调 tiOnEvent）+ 6 秒兜底轮询，
   两者都只在"这页真的看得见"时干活（Agents 窗口隐藏或切去 CODE 模式就不打网络）。
   ============================================================ */
"use strict";

const TI = { rows: [], pane: "tasks", timer: 0, pending: 0 };
const TI_LIVE = { running: 1, queued: 1, waiting: 1 };
const TI_GROUPS = [
  { key: "running", cls: "run", label: "tiGroupRunning", pick: (r) => r.status === "running" || r.status === "queued" },
  { key: "waiting", cls: "wait", label: "tiGroupWaiting", pick: (r) => r.status === "waiting" },
  { key: "interrupted", cls: "int", label: "tiGroupInterrupted", pick: (r) => r.status === "interrupted" },
  { key: "settled", cls: "done", label: "tiGroupSettled", pick: (r) => !TI_LIVE[r.status] && r.status !== "interrupted" },
];

function tiElapsed(r) {
  const from = r.startedAt || r.lastEventAt || 0;
  if (!from) return "";
  const to = r.endedAt && r.endedAt > from ? r.endedAt : Date.now();
  return typeof fmtDur === "function" ? fmtDur(to - from) : "";
}

function tiMetaBits(r) {
  const bits = [];
  if (r.turns) bits.push("R" + r.turns);
  if (r.tools) bits.push(t("tiTools", { n: r.tools }));
  const d = tiElapsed(r);
  if (d) bits.push(d);
  return bits;
}

function tiNote(r) {
  if (r.status === "waiting") return { cls: "wait", text: t("tiWaitingFor", { what: r.waitingFor || t("tiWaitingGeneric") }) };
  if (r.status === "queued" && r.queueLen) return { cls: "queue", text: t("tiQueued", { n: r.queueLen }) };
  if (r.status === "failed" && r.error) return { cls: "err", text: r.error };
  if (r.status === "interrupted") return { cls: "int", text: t("tiInterruptedNote") };
  return null;
}

function tiCard(r) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "ti-card st-" + r.status + (r.convId === (typeof convId !== "undefined" ? convId : "") ? " current" : "");
  el.title = t("tiOpenTip");
  const bits = tiMetaBits(r);
  const note = tiNote(r);
  el.innerHTML =
    '<span class="ti-dot"></span>' +
    '<span class="ti-body">' +
      '<span class="ti-title">' + esc(r.title || t("tiUntitled")) + "</span>" +
      '<span class="ti-meta">' +
        (r.origin === "automation" ? '<span class="ti-badge">' + esc(t("tiAutoBadge")) + "</span>" : "") +
        esc(bits.join(" · ")) +
      "</span>" +
      (note ? '<span class="ti-note ' + note.cls + '">' + esc(note.text) + "</span>" : "") +
    "</span>" +
    (r.convId === (typeof convId !== "undefined" ? convId : "") ? '<span class="ti-here">' + ico("chevR") + "</span>" : "");
  el.onclick = () => { if (typeof openConv === "function") openConv(r.convId); };
  return el;
}

function tiRender() {
  const host = document.getElementById("agPaneTasks");
  if (!host) return;
  const rows = TI.rows || [];
  if (!rows.length) {
    host.innerHTML = '<div class="ti-empty">' + esc(t("tiEmpty")) + '<br><span>' + esc(t("tiEmptyHint")) + "</span></div>";
    replaceIcons(host);
    return;
  }
  host.innerHTML = "";
  let shown = 0;
  TI_GROUPS.forEach((g) => {
    const list = rows.filter(g.pick);
    if (!list.length) return;
    const head = document.createElement("div");
    head.className = "ti-head";
    head.innerHTML = '<span class="ti-head-t ' + g.cls + '">' + esc(t(g.label)) + '</span><span class="ti-head-n">' + list.length + "</span>";
    host.appendChild(head);
    list.forEach((r) => { host.appendChild(tiCard(r)); shown++; });
  });
  if (!shown) {
    host.innerHTML = '<div class="ti-empty">' + esc(t("tiEmpty")) + "</div>";
  }
  replaceIcons(host);
}

async function tiFetch() {
  /* 任务表在登录闸门后面：开机那一刻 token 还没落地，抢跑去拉就是给自己刷一条 401
     （_verify_uitaste 的"整轮零页面报错"门先撞上这条）。 */
  if (typeof AUTH !== "undefined" && AUTH && !AUTH.token) return;
  try {
    const r = await fetch("/api/tasks").then((x) => x.json());
    if (r && r.ok) { TI.rows = Array.isArray(r.tasks) ? r.tasks : []; tiRender(); }
  } catch (e) { /* 静默：轮询失败保留上一次画面，比清成空白好 */ }
}

function tiVisible() {
  const inAgents = typeof state !== "undefined" && state && state.mode === "agents";
  return TI.pane === "tasks" && inAgents && document.visibilityState === "visible";
}

/* 事件驱动刷新要合并：一轮里 tool.end 能连来几十条，别每条都打一次 HTTP */
function tiOnEvent(ev) {
  if (!ev || !TI_VISIBLE_TYPES[ev.type]) return;
  if (TI.pending) return;
  TI.pending = setTimeout(() => { TI.pending = 0; if (tiVisible()) tiFetch(); }, 400);
}
const TI_VISIBLE_TYPES = {
  "user.msg": 1, "tool.end": 1, "tool.pending": 1, "agent.done": 1, "agent.error": 1,
  "agent.state": 1, "goal.continue": 1, "chat.queued": 1, "chat.dequeued": 1, "hello": 1,
};

function tiSetPane(p) {
  TI.pane = p === "sessions" ? "sessions" : "tasks";
  try { localStorage.setItem("cw-ag-pane", TI.pane); } catch (e) {}
  const tasks = TI.pane === "tasks";
  const seg = [["segTasks", tasks], ["segSessions", !tasks]];
  seg.forEach(([id, on]) => {
    const b = document.getElementById(id);
    if (!b) return;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  const pt = document.getElementById("agPaneTasks"), ps = document.getElementById("agPaneSessions"), nc = document.getElementById("btnNewConv");
  if (pt) pt.hidden = !tasks;
  if (ps) ps.hidden = tasks;
  if (nc) nc.style.display = tasks ? "none" : "";
  if (tasks) tiFetch();
}

(function tiWire() {
  const a = document.getElementById("segTasks"), b = document.getElementById("segSessions");
  if (a) a.onclick = () => tiSetPane("tasks");
  if (b) b.onclick = () => tiSetPane("sessions");
  let saved = "";
  try { saved = localStorage.getItem("cw-ag-pane") || ""; } catch (e) {}
  tiSetPane(saved === "sessions" ? "sessions" : "tasks");
  tiRender();   // 先画一次：token 还没落地时 tiFetch 会直接返回，不画就留一个空壳容器
  TI.timer = setInterval(() => { if (tiVisible()) tiFetch(); }, 6000);
  document.addEventListener("visibilitychange", () => { if (tiVisible()) tiFetch(); });
  if (typeof onLang === "function") onLang(() => tiRender());
})();
