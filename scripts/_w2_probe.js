/* ============================================================
   W2 API 探针：进程内起真实 server → 专家注册表端到端验证
   1. GET /api/experts 含 3 个内置专家
   2. 临时工作区 .pancode/experts/*.md → GET 可见（role/methodology 解析正确）
   3. POST /api/agent-settings 设 active=专家 id → 回读生效
   4. 还原 default + 删专家文件 → 重扫生效（幂等可重跑）
   已知坑：register 成功即返回 token；token 走 Authorization: Bearer
   ============================================================ */
"use strict";
const os = require("os");
const fs = require("fs");
const path = require("path");

const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "w2-ws-"));
process.env.PORT = "8907";
process.env.CURSORWEB_WORKSPACE = wsDir;
require("../server/index.js");

const BASE = "http://127.0.0.1:8907";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log("  + " + n); } else { fail++; console.error("  x " + n + (extra ? " | " + extra : "")); } };

(async () => {
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + "/api/health"); if (r.ok) break; } catch (e) {} await wait(250); }
  t("server 启动（expert-store 加载无炸）", true);

  const reg = await (await fetch(BASE + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "w2probe_" + Date.now(), password: "test1234" }) })).json();
  const auth = { "Content-Type": "application/json", Authorization: "Bearer " + (reg.token || "") };
  t("register 拿 token", !!(reg.token || ""));

  // 1. 内置专家
  const r1 = await (await fetch(BASE + "/api/experts", { headers: auth })).json();
  t("GET /api/experts ok", r1.ok === true);
  const ids = (r1.experts || []).map((e) => e.id);
  t("含 3 内置专家", ["fullstack", "frontend", "backend"].every((x) => ids.includes(x)), JSON.stringify(ids));

  // 2. 写入项目级专家包 → 重扫可见
  const expDir = path.join(wsDir, ".pancode", "experts");
  fs.mkdirSync(expDir, { recursive: true });
  fs.writeFileSync(path.join(expDir, "perf.md"),
    "---\nname: 性能优化专家\ndescription: 性能剖析与优化\n---\n你是一位性能优化专家。\n\n先用数据定位瓶颈，再做最小改动。\n", "utf8");
  const r2 = await (await fetch(BASE + "/api/experts", { headers: auth })).json();
  const perf = (r2.experts || []).find((e) => e.id === "perf");
  t("项目级专家 perf 可见（source=project）", !!perf && perf.name === "性能优化专家" && perf.source === "project", JSON.stringify(perf));
  t("解析含 role+methodology", !!perf && /性能优化专家/.test(perf.role || "") && /最小改动/.test(perf.methodology || ""));

  // 3. active 切到专家 id
  const setr = await (await fetch(BASE + "/api/agent-settings", { method: "POST", headers: auth, body: JSON.stringify({ persona: { active: "perf", systemPrompt: "" } }) })).json();
  t("POST agent-settings active=perf", setr.ok === true && setr.agent && setr.agent.persona.active === "perf");
  const r3 = await (await fetch(BASE + "/api/experts", { headers: auth })).json();
  t("GET /api/experts 回读 active=perf", r3.active === "perf");

  // 4. 还原 + 删包 → 重扫生效
  await fetch(BASE + "/api/agent-settings", { method: "POST", headers: auth, body: JSON.stringify({ persona: { active: "default", systemPrompt: "" } }) });
  fs.rmSync(path.join(expDir, "perf.md"), { force: true });
  const r4 = await (await fetch(BASE + "/api/experts", { headers: auth })).json();
  t("删除文件后专家消失（重扫生效）", !(r4.experts || []).some((e) => e.id === "perf"));
  t("active 已还原 default", r4.active === "default");

  console.log("\n=== W2 probe: " + pass + " passed, " + fail + " failed ===");
  try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
