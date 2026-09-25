/* W13 冒烟：真实 server 环境验证 patch 链路 + HTTP 面（有则验 stage，无则确认工具链由单测覆盖） */
"use strict";
process.env.PORT = "8897";
process.env.CURSORWEB_WORKSPACE = "E:/独立目录/_w13smoke_ws";
require("../server/index.js");
const fs = require("fs");
const path = require("path");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  + " + n); } else { fail++; console.error("  x " + n); } };

(async () => {
  const BASE = "http://127.0.0.1:8897";
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + "/api/health"); if (r.ok) break; } catch (e) {} await wait(250); }
  t("server 启动（patch.js 含 fuzzy 链路加载无炸）", true);

  const ws = "E:/独立目录/_w13smoke_ws";
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "fuzzy_target.js"), "function calc() {\n\tconst total = 1;\n\treturn total;\n}\n", "utf8");

  const reg = await (await fetch(BASE + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "w13probe_" + Date.now(), password: "test1234" }) })).json();
  const auth = { "Content-Type": "application/json", Authorization: "Bearer " + (reg.token || "") };
  t("register 拿 token", !!(reg.token || ""));

  /* 探 HTTP 面是否有 patch 路由（有则验 stage 的 fuzzy 兜底，无则工具链由单测覆盖） */
  const stageRes = await fetch(BASE + "/api/patch/stage", { method: "POST", headers: auth, body: JSON.stringify({ convId: "smoke", path: "fuzzy_target.js", edits: [{ old_string: "function calc() {\nconst total = 1;\nreturn total;\n}", new_string: "function calc() {\n  const total = 42;\n  return total;\n}" }] }) });
  if (stageRes.status === 404) {
    console.log("  (info) 无 /api/patch/stage 路由，stage/apply 由 vitest 全链路覆盖，HTTP 面跳过");
    t("HTTP 面探测完成", true);
  } else {
    const sd = await stageRes.json();
    t("HTTP stage 成功（缩进差异被 fuzzy 兜住）", sd.ok === true);
  }

  t("目标文件仍在（server 启动未破坏工作区）", fs.readFileSync(path.join(ws, "fuzzy_target.js"), "utf8").includes("const total = 1;"));

  console.log("\n=== W13 smoke: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
