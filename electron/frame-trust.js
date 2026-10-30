/* ============================================================
   桌面端「这条来源能不能信」的判据（审查项 F13）
   ------------------------------------------------------------
   主进程里那三条 IPC（最小化/最大化/关闭）是无边框窗口唯一的出口，所以"谁发的"必须问得出答案。
   判据抽在这里而不是写在 main.js：main.js 一 require 就要有 Electron 运行时，
   单测跑不了；而这套判定恰恰是最需要被反例钉住的（about:srcdoc、盘符大小写、失败页 data: 链接）。
   ============================================================ */
"use strict";

/* 自家来源 = http://127.0.0.1:<port>。
   shownFailPage：后端起不来时主进程自己加载的那张 data: 错误页。
   无边框窗口只有红绿灯能关，不认它就得到一个关不掉的窗口。 */
function isAppUrl(appOrigin, url, shownFailPage) {
  const s = String(url || "");
  if (!s) return false;
  if (s === appOrigin || s.startsWith(appOrigin + "/") || s.startsWith(appOrigin + "?") || s.startsWith(appOrigin + "#")) return true;
  return !!shownFailPage && s.startsWith("data:");
}

/* 想把窗口导航走 / 开新窗时，怎么处理这个目标地址：
   - 自家地址：放行（页面自己刷新、点自己域内的链接）
   - http(s)/mailto：不在本窗口里开，交给系统浏览器
   - 其余（file:、smb:、\\.\设备路径、自定义协议）：一律拒绝——openExternal 会把它们
     交给系统处理器，其中不乏直接崩 shell 或提权的入口 */
function navigationAction(appOrigin, url, shownFailPage) {
  const s = String(url || "");
  if (isAppUrl(appOrigin, s, shownFailPage)) return { action: "allow" };
  let proto = "";
  try { proto = new URL(s).protocol; } catch (e) { return { action: "block", protocol: "" }; }
  if (proto === "http:" || proto === "https:" || proto === "mailto:") return { action: "external", protocol: proto };
  return { action: "block", protocol: proto };
}

module.exports = { isAppUrl, navigationAction };
