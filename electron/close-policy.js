/* ============================================================
   关窗去向的决策（纯函数，单独成文件就是为了能单测）

   为什么要有这一层：主进程里那套 dialog / hide / quit 在 Node 侧测不到，
   而"什么时候该问、什么时候直接照办、什么时候绝不能挂后台"恰恰是这套逻辑里
   最容易写错、错了又最难被发现的部分——尤其是**没有托盘的时候绝不能挂后台**，
   那会变成"看不见又关不掉"的后台进程。
   ============================================================ */
"use strict";

const ACTIONS = ["ask", "background", "quit"];

/* 配置里出现任何不认识的值都退回"问"，不猜用户想要哪个 */
function normalizePref(v) {
  const s = String(v || "");
  return ACTIONS.indexOf(s) >= 0 ? s : "ask";
}

/* pref     = 配置里的 desktop.closeAction
   quitting = 已经决定要退（托盘「退出并终止所有任务」、OS 的退出指令）
   trayOk   = 托盘可用；没托盘还挂后台 = 幽灵进程，一律放行关闭
   choice   = 对话框返回值：0 挂后台 / 1 直接退出 / 2 取消（含按 Esc）
   remember = 用户勾了"记住我的选择" */
function decideClose(s) {
  const st = s || {};
  if (st.quitting) return { action: "allow", rememberPref: null };
  if (!st.trayOk) return { action: "allow", rememberPref: null };
  const p = normalizePref(st.pref);
  if (p === "quit") return { action: "quit", rememberPref: null };
  if (p === "background") return { action: "hide", rememberPref: null };
  const c = st.choice;
  if (c === undefined || c === null || c === 2) return { action: "cancel", rememberPref: null };
  const next = c === 1 ? "quit" : "background";
  return { action: c === 1 ? "quit" : "hide", rememberPref: st.remember ? next : null };
}

/* 对话框的文案。把"挂后台会怎样、退出会怎样"写进按钮和正文里，
   尤其要说清现在有几个任务在跑——这决定了选"直接退出"会不会掐掉干到一半的活。 */
function closeDialog(running) {
  const n = Math.max(0, Number(running) || 0);
  return {
    type: "question",
    buttons: n > 0
      ? ["挂到后台（任务继续跑）", "直接退出（中断 " + n + " 个任务）", "取消"]
      : ["挂到后台", "直接退出", "取消"],
    defaultId: 0,
    cancelId: 2,
    checkboxType: "checkbox",
    checkboxLabel: "记住我的选择，以后不再问",
    message: "关闭 pancode 窗口后要做什么？",
    detail: n > 0
      ? "当前有 " + n + " 个任务在跑。\n\n挂到后台：窗口隐藏，进程与后端继续跑，任务照常推进，"
      + "收口时弹系统通知，从托盘可以唤回窗口。\n直接退出：终止后端与它起的全部子进程，正在跑的任务会被打断。"
      : "挂到后台：窗口隐藏，进程与后端留着，自动化与之后派出的任务照常跑，从托盘可以唤回窗口。\n"
      + "直接退出：终止后端与它起的全部子进程。",
  };
}

module.exports = { decideClose, closeDialog, normalizePref, ACTIONS };
