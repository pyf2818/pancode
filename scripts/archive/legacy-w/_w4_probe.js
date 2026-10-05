/* ============================================================
   W4 API 探针：进程内起真实 server → 自动化任务端到端
   1. 校验矩阵：坏 cron / 过去时间 → 400
   2. 创建 cron 任务 → 列表可见（nextRunAt 未来）
   3. pause → resume → 列表状态正确
   4. run-now 真实触发（真实 LLM 子智能体，只读任务）→ 轮询 runs 出记录
   5. 删除 → 列表消失（幂等可重跑）
   ============================================================ */
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "w4-ws-"));
process.env.PORT = "8909";
process.env.CURSORWEB_WORKSPACE = wsDir;
require("../server/index.js");

const BASE = "http://127.0.0.1:8909";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log("  + " + n); } else { fail++; console.error("  x " + n + (extra ? " | " + extra : "")); } };
const J = (r) => r.json();

(async () => {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + "/api/health"); if (r.ok) break; } catch (e) {} await wait(250); }
  t("server 启动（scheduler 加载无炸）", true);

  const reg = await (await fetch(BASE + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "w4probe_" + Date.now(), password: "test1234" }) })).json();
  const auth = { "Content-Type": "application/json", Authorization: "Bearer " + (reg.token || "") };
  t("register 拿 token", !!(reg.token || ""));

  // 1. 校验矩阵
  const bad1 = await (await fetch(BASE + "/api/automations", { method: "POST", headers: auth, body: JSON.stringify({ name: "坏cron", prompt: "p", scheduleType: "cron", cron: "bad" }) })).status;
  t("坏 cron → 400", bad1 === 400, String(bad1));
  const bad2 = await (await fetch(BASE + "/api/automations", { method: "POST", headers: auth, body: JSON.stringify({ name: "过去时间", prompt: "p", scheduleType: "once", scheduledAt: new Date(Date.now() - 60000).toISOString() }) })).status;
  t("过去 scheduledAt → 400", bad2 === 400, String(bad2));

  // 2. 创建 cron 任务
  const cr = await (await fetch(BASE + "/api/automations", { method: "POST", headers: auth, body: JSON.stringify({ name: "定时跑测试", prompt: "列出工作区根目录的文件数量即可，不要修改任何文件。", scheduleType: "cron", cron: "0 */2 * * *" }) })).json();
  t("创建 cron 任务 ok", cr.ok === true && cr.automation && cr.automation.nextRunAt > Date.now(), JSON.stringify(cr).slice(0, 200));
  const id = cr.automation && cr.automation.id;

  // 3. pause / resume
  const pu = await (await fetch(BASE + "/api/automations/" + id + "/pause", { method: "POST", headers: auth })).json();
  t("pause → paused", pu.ok === true && pu.automation.status === "paused");
  const re = await (await fetch(BASE + "/api/automations/" + id + "/resume", { method: "POST", headers: auth })).json();
  t("resume → active", re.ok === true && re.automation.status === "active");

  // 4. run-now（真实 LLM 子智能体）
  const rn = await (await fetch(BASE + "/api/automations/" + id + "/run", { method: "POST", headers: auth })).json();
  t("run-now 返回 started", rn.ok === true && rn.started === true);
  let rec = null;
  for (let i = 0; i < 60 && !rec; i++) { // 最多 150s
    await wait(2500);
    const rr = await (await fetch(BASE + "/api/automations/" + id + "/runs", { headers: auth })).json();
    if (rr.ok && rr.runs && rr.runs.length) rec = rr.runs[0];
  }
  t("run-now 产生运行记录", !!rec, "无记录");
  if (rec) {
    console.log("    (info) 运行结果: ok=" + rec.ok + (rec.error ? " err=" + rec.error.slice(0, 120) : " out=" + (rec.output || "").slice(0, 120).replace(/\n/g, " ")));
    t("记录含 startedAt/finishedAt", !!rec.startedAt && !!rec.finishedAt);
  }

  // 5. 删除
  const del = await (await fetch(BASE + "/api/automations/" + id, { method: "DELETE", headers: auth })).json();
  t("删除 ok", del.ok === true);
  const lst = await (await fetch(BASE + "/api/automations", { headers: auth })).json();
  t("列表已不含该任务", !(lst.automations || []).some((x) => x.id === id));

  console.log("\n=== W4 probe: " + pass + " passed, " + fail + " failed ===");
  try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
