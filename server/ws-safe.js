/* ============================================================
   WS 指令执行的统一异常包装（从 index.js 抽出来，便于单测）
   —— 修 S-B3：原先 catch 之后只往前端发一条 op.error，服务端一行日志不留，
      于是"界面上说服务内部异常"和"后台到底哪一步炸了"完全对不上号，
      出了问题只能靠猜。

   现在补三件事：
     1) 每条 WS 指令进来就分配一个 requestId，并用 AsyncLocalStorage 绑住整条异步链
        —— 这一次操作里任何一处写的日志都自动带上同一个 reqId，不用层层传参；
     2) 抛错落进结构化日志（server/logger.js），同时进内存环，/api/logs 查得到；
     3) 前端错误里附 requestId，用户截图反馈时可直接定位。

   为什么单独成文件：server/index.js 的模块顶层会 listen() 并挂 watcher，
   require 进来就等于起服务，断言脚本需要能 require 而不产生副作用。
   ============================================================ */
"use strict";

const { classifyError } = require("./app-error");
const log = require("./logger");

let _errSeq = 0;
/* reqId 格式：r + base36 时间戳 + "-" + base36 序号。单调递增，
   同一毫秒内多次报错靠序号区分；前端把它贴出来就能在日志里 grep 到那一次。 */
function nextReqId() {
  _errSeq = (_errSeq % 1e6) + 1;
  return "r" + Date.now().toString(36) + "-" + _errSeq.toString(36);
}

/* op 是 WS 指令类型（如 file.save）；没有也照样能靠堆栈首行定位到调用栈。 */
function safe(fn, ws, op) {
  const reqId = nextReqId();
  const tag = log.tag("ws");
  return tag.run(reqId, () => {
    try { return fn(); }
    catch (e) {
      const info = classifyError(e);
      const uKey = (ws && ws._userKey) || "anon";
      // 堆栈首行能定位到文件:行；完整堆栈在 debug 时由 --inspect 现场看，这里只留首行避免刷屏
      const head = String((e && e.stack) || "").split("\n")[0] || String(e);
      tag.withReqId(reqId).error((op || "未标注操作") + " 失败", {
        userKey: uKey, kind: info.kind, code: info.code == null ? "-" : info.code,
        msg: info.message, at: head,
      });
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: "op.error", error: info.message, code: info.code, kind: info.kind,
          userHint: info.userHint, reqId, op: op || null,
        }));
      }
      return null;
    }
  });
}

module.exports = { safe, nextReqId };
