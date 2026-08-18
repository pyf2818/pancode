/* Phase1 前端接线端到端验证：静态资源 / REST / WS hello + agent.settings 广播 */
const http = require("http");
const WebSocket = require("ws");

const BASE = "http://127.0.0.1:8766";
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? "PASS" : "FAIL") + "  " + name); };

function get(path, token) {
  return new Promise((res, rej) => {
    http.get(BASE + path, { headers: token ? { Authorization: "Bearer " + token } : {} }, (r) => {
      let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res({ status: r.statusCode, body: b }));
    }).on("error", rej);
  });
}
function post(path, token, data) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(data);
    const req = http.request(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Authorization: "Bearer " + token } }, (r) => {
      let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res({ status: r.statusCode, body: b }));
    });
    req.on("error", rej); req.end(body);
  });
}

(async () => {
  // 1. 静态资源包含新 UI
  const idx = await get("/");
  ok("index.html 含 agentModal", idx.body.includes('id="agentModal"'));
  ok("index.html 含 btnAgentSettings", idx.body.includes('id="btnAgentSettings"'));
  const appjs = await get("/app.js");
  ok("app.js 含 applyAgentSettings", appjs.body.includes("function applyAgentSettings"));
  ok("app.js 含 updateCtxBar", appjs.body.includes("function updateCtxBar"));
  ok("app.js 含附件逻辑", appjs.body.includes("addAttachFile") && appjs.body.includes("image_url") === false);
  const css = await get("/styles.css");
  ok("styles.css 含 agentModal 定位", css.body.includes("#agentModal"));
  ok("styles.css 含 ci-chip / ctxBar", css.body.includes(".ci-chip") && css.body.includes("#ctxBarWrap"));

  // 2. 鉴权 token
  const boot = JSON.parse((await get("/api/bootstrap")).body);
  ok("bootstrap 返回 token", !!boot.token);
  const T = boot.token;

  // 3. REST 读改读
  const a0 = JSON.parse((await get("/api/agent-settings", T)).body);
  ok("GET agent-settings 结构完整", !!(a0.permissions && a0.persona && a0.rules && a0.context && a0.memory));
  const origMode = a0.permissions.mode;

  // 4. WS：hello 带 agent；POST 后收到 agent.settings 广播
  await new Promise((resolve) => {
    const ws = new WebSocket("ws://127.0.0.1:8766/?token=" + encodeURIComponent(T));
    let helloAgent = false, gotBroadcast = false;
    const done = () => { ws.close(); resolve(); };
    const timer = setTimeout(() => { ok("WS hello.agent 存在", helloAgent); ok("收到 agent.settings 广播", gotBroadcast); done(); }, 5000);
    ws.on("message", async (raw) => {
      const ev = JSON.parse(raw.toString());
      if (ev.type === "hello") {
        helloAgent = !!(ev.agent && ev.agent.permissions);
        const r = JSON.parse((await post("/api/agent-settings", T, { permissions: { mode: "semi" }, persona: { active: "frontend" } })).body);
        ok("POST agent-settings ok", r.ok === true && r.agent.permissions.mode === "semi" && r.agent.persona.active === "frontend");
      }
      if (ev.type === "agent.settings") {
        if (gotBroadcast) return; // 还原设置的第二次广播不重复断言
        gotBroadcast = ev.agent && ev.agent.permissions.mode === "semi";
        clearTimeout(timer);
        ok("WS hello.agent 存在", helloAgent);
        ok("收到 agent.settings 广播(semi)", gotBroadcast);
        // 还原
        await post("/api/agent-settings", T, { permissions: { mode: origMode }, persona: { active: "default" } });
        const a2 = JSON.parse((await get("/api/agent-settings", T)).body);
        ok("设置已还原", a2.permissions.mode === origMode && a2.persona.active === "default");
        done();
      }
    });
  });

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("异常:", e.message); process.exit(1); });
