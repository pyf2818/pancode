/* 端到端验证：连上真实运行的 pancode 服务，先发 newchat，再发一条会触发工具调用的对话，
   收集事件，确认不再出现 "TOOLS is not defined"，且能正常收到 agent.done / tool 事件。 */
const WebSocket = require("ws");

/* A2 认证升级后 WS 仅接受登录后的 userToken —— 注册临时用户获取 */
const PORT = process.env.PANCODE_TEST_PORT || 8766;
async function getToken() {
  const r = await fetch("http://127.0.0.1:" + PORT + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "_verify_ws_" + Date.now(), password: "test1234" }),
  });
  const j = await r.json();
  if (!j || !j.token) throw new Error("注册失败: " + ((j && j.error) || "unknown"));
  return j.token;
}

(async () => {
  let token;
  try { token = await getToken(); }
  catch (e) { console.error("FAIL: " + e.message + "（需先 npm start 后运行本脚本）"); process.exit(1); }
  const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/?token=" + encodeURIComponent(token));
  const seen = { types: {}, error: null, toolCalls: 0, gotReset: false, gotDone: false, content: "" };
  const log = [];

  ws.on("open", () => {
    // 1) newchat：应回 agent.reset
    ws.send(JSON.stringify({ type: "newchat" }));
    // 2) 触发工具调用：让 Agent 列文件并简述
    setTimeout(() => ws.send(JSON.stringify({ type: "chat", text: "请列出工作区根目录的文件，并简要说明这个项目的用途（用一句话）。" })), 400);
  });

  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    seen.types[m.type] = (seen.types[m.type] || 0) + 1;
    if (m.type === "agent.reset") seen.gotReset = true;
    if (m.type === "agent.done") seen.gotDone = true;
    if (m.type === "tool.pending") seen.toolCalls++;
    if (m.type === "term.line" && /TOOLS is not defined|is not defined/.test(m.text || "")) seen.error = m.text;
    if (m.type === "msg.delta" || m.type === "agent.msg") { /* content may arrive as events */ }
    log.push(m.type + (m.text ? " :: " + String(m.text).slice(0, 80) : ""));
  });

  ws.on("error", (e) => { seen.error = "WS_ERROR: " + e.message; });

  setTimeout(() => {
    ws.close();
    const errs = [];
    if (seen.error) errs.push("运行期错误: " + seen.error);
    if (!seen.gotReset) errs.push("未收到 newchat 的 agent.reset");
    if (!seen.gotDone && !seen.types["agent.done"]) errs.push("未收到 agent.done（对话可能未完成/超时）");
    console.log("事件统计:", JSON.stringify(seen.types));
    console.log("收到 agent.reset:", seen.gotReset, "| agent.done:", seen.gotDone, "| tool.pending:", seen.toolCalls);
    if (errs.length) { console.error("FAIL:\n - " + errs.join("\n - ")); process.exit(1); }
    console.log("PASS: newchat 生效，且整轮对话未触发 TOOLS is not defined 之类的运行期错误。");
    process.exit(0);
  }, 45000);
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
