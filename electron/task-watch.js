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

module.exports = { isLive, countRunning, justSettled, notifyText, trayStatusLine, LIVE };
