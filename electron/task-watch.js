/* ============================================================
   桌面端任务观察：把服务端任务表变成"该不该打扰用户"的判断。
   纯函数、不 require electron，这样关窗续跑与通知触发条件能被单测覆盖
   （托盘图标和系统通知气泡本身只能靠人眼验收）。
   ============================================================ */
"use strict";

const LIVE = ["running", "queued", "waiting"];
const isLive = (row) => !!row && LIVE.indexOf(row.status) >= 0;

function countRunning(rows) {
  return (rows || []).filter(isLive).length;
}

/* 只在「从进行中变成收口」的那一刻通知一次。
   每次都报会把人淹了；从没有记录直接变 done（用户在别处开的任务）不该打扰。 */
function justSettled(prevRows, nextRows) {
  const before = new Map((prevRows || []).map((r) => [r.convId, r]));
  return (nextRows || []).filter((r) => {
    const p = before.get(r.convId);
    return isLive(p) && !isLive(r);
  });
}

/* 通知文案：状态决定语气，标题决定是哪件事。不写"AI 已完成您的请求"这种自夸句。 */
function notifyText(row) {
  const title = String(row.title || "").trim() || row.convId;
  const map = {
    done: ["任务已完成", title],
    failed: ["任务出错了", title + (row.error ? "：" + row.error.slice(0, 80) : "")],
    aborted: ["任务已中断", title],
    interrupted: ["任务被进程退出打断", title],
  };
  const [head, body] = map[row.status] || ["任务状态更新", title + "：" + row.status];
  return { title: head, body };
}

/* 托盘菜单里那行实时状态：没有进行中任务时说清楚，不要留个空数字 */
function trayStatusLine(rows) {
  const n = countRunning(rows);
  if (!n) return "pancode 后端运行中（没有进行中的任务）";
  if (n === 1) {
    const r = (rows || []).find(isLive) || {};
    const label = r.status === "waiting" ? "等你确认" : "进行中";
    return "1 个任务" + label + "：" + (String(r.title || "").slice(0, 40) || r.convId);
  }
  return n + " 个任务进行中";
}

/* 托盘菜单的分组。顺序是"要你动手的排最前"，不是按时间：
   挂后台的人回到托盘第一眼要看到的是"有一条卡在你这儿"，而不是"最近发生了什么"。 */
const TRAY_GROUPS = [
  { key: "waiting", title: "等你批", pick: (r) => r.status === "waiting" },
  { key: "running", title: "在跑", pick: (r) => r.status === "running" || r.status === "queued" },
  { key: "unfinished", title: "上次没跑完", pick: (r) => r.status === "interrupted" },
  { key: "settled", title: "最近收口", pick: (r) => ["done", "failed", "aborted"].indexOf(r.status) >= 0 },
];
const TRAY_MAX_PER_GROUP = 6;

function fmtShort(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s";
  return Math.floor(s / 3600) + "h" + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + "m";
}

/* 一行菜单项：标题 + 为什么值得点开它。工具/轮次数不放进来 ——
   托盘菜单宽度有限，而"跑了多少"不是决定要不要回去看一眼的因素，"卡在哪"才是。 */
function trayLine(r) {
  const title = String(r.title || "").replace(/\s+/g, " ").trim().slice(0, 42) || r.convId;
  const bits = [];
  if (r.origin === "automation") bits.push("自动化");
  if (r.status === "waiting") bits.push("等你批：" + (String(r.waitingFor || "").slice(0, 24) || "一个动作"));
  else if (r.status === "queued") bits.push("排队中");
  else if (r.status === "failed") bits.push("出错：" + (String(r.error || "").replace(/\s+/g, " ").slice(0, 28) || "见会话"));
  else if (r.status === "aborted") bits.push("已中断");
  else if (r.status === "interrupted") bits.push("进程退出时中断");
  const from = r.startedAt || r.lastEventAt || 0;
  if (from) {
    const to = r.endedAt && r.endedAt > from ? r.endedAt : Date.now();
    if (r.status === "running" || r.status === "waiting" || r.status === "queued") bits.push("已 " + fmtShort(to - from));
    else if (r.endedAt > from) bits.push(fmtShort(r.endedAt - from));
  }
  return bits.length ? title + " — " + bits.join(" · ") : title;
}

function traySections(rows, now) {
  const list = rows || [];
  const out = [];
  for (const g of TRAY_GROUPS) {
    const picked = list.filter(g.pick).sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
    if (!picked.length) continue;
    const shown = picked.slice(0, TRAY_MAX_PER_GROUP).map((r) => ({
      convId: r.convId, status: r.status, label: trayLine(r, now),
    }));
    if (picked.length > shown.length) shown.push({ label: "还有 " + (picked.length - shown.length) + " 条…", disabled: true });
    out.push({ key: g.key, title: g.title + " " + picked.length, items: shown });
  }
  return out;
}

module.exports = { isLive, countRunning, justSettled, notifyText, trayStatusLine, traySections, trayLine, fmtShort, LIVE, TRAY_GROUPS, TRAY_MAX_PER_GROUP };
