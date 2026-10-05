/* ============================================================
   事件作用域（server/event-scope.js）
   `broadcast(ev)` 以前无差别发给所有连接：两个人同开一个后端时，B 的窗口会收到 A 的
   逐字回答、工具卡、审批卡（B 点"同意"还能替 A 批准删文件），A 点"新对话"会把 B 正在
   流的那条回答的 UI 状态整段清掉。桌面端"一台机多个窗口/多个用户"是常规形态，不是边角。

   规则只有一条，故意做小：
     · 调用点给了 userKey → 只发给同一个 userKey 的连接；
     · 没给（或给的是 "anon"）→ 发给所有连接。
   "anon" 是后台自动化专用的引擎键（见 index.js 的调度器），它**不属于任何登录用户**，
   所以必须继续广播——否则定时任务的进度在用户窗口里就看不见了。
   登录用户的连接永远有自己的 key（WS upgrade 有 token 闸门），不存在匿名连接被误伤。

   身份为什么用 userKey（token 的 8 位哈希）而不是用户名：`userEngines` 本来就是按它分会话的，
   "某个引擎的事件发给拥有该引擎的连接"是自洽的；换成用户名反而会让同一个人的两个窗口
   互相插入对方引擎的流（那边是另一份 history/另一个 _currentConv）。
   ============================================================ */
"use strict";

const ANON = "anon";

/* clients 是 WebSocket 连接的集合；readyState 1 = OPEN。
   返回"该发给了谁"的数组，让调用方决定怎么发（也方便单测直接喂假连接）。 */
function recipients(clients, userKey) {
  const out = [];
  if (!clients) return out;
  const scoped = !!userKey && userKey !== ANON;
  for (const c of clients) {
    if (!c || c.readyState !== 1) continue;
    if (scoped && c._userKey !== userKey) continue;
    out.push(c);
  }
  return out;
}

module.exports = { recipients, ANON };
