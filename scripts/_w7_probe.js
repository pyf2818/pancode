/* W7 多工作区 API 探针（进程内起服，mkdtemp 一次性工作区）
   验证链路：GET /api/workspace（current+recent）→ POST 切换 → recent 去重置顶封顶 →
   config 持久化（recentWorkspaces 落盘）→ 错误路径（不存在目录 400）→ 引擎运行中 409 语义（只验证常驻路径） */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

process.env.PORT = "8897";
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "w7api-ws-"));
process.env.CURSORWEB_WORKSPACE = WS;
process.env.PANCODE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "w7api-data-"));   // 隔离数据根：CONFIG_PATH 落一次性目录，不碰开发配置
const { CONFIG_PATH } = require("../server/config");
require("../server/index.js");

const PORT = process.env.PORT;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n + (extra ? "  [" + extra + "]" : "")); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(300);
  const uname = "w7api_" + Date.now();
  const j = await (await fetch(BASE + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: uname, password: "test1234" }) })).json();
  const token = j.token || "";
  const auth = { "Content-Type": "application/json", Authorization: "Bearer " + token };

  /* 0. 初始：GET /api/workspace → current + recent */
  const r0 = await (await fetch(BASE + "/api/workspace", { headers: auth })).json();
  t("GET /api/workspace：current 存在", !!r0.current, JSON.stringify(r0).slice(0, 120));
  t("GET /api/workspace：recent 是数组", Array.isArray(r0.recent));

  /* 1. 造两个目录并切换 */
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "w7proj-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "w7proj-b-"));
  const p1 = await (await fetch(BASE + "/api/workspace", { method: "POST", headers: auth, body: JSON.stringify({ dir: dirA }) })).json();
  t("POST 切到 A：ok", p1.ok === true, JSON.stringify(p1));
  const p2 = await (await fetch(BASE + "/api/workspace", { method: "POST", headers: auth, body: JSON.stringify({ dir: dirB }) })).json();
  t("POST 切到 B：ok", p2.ok === true);
  const r1 = await (await fetch(BASE + "/api/workspace", { headers: auth })).json();
  t("recent[0] === B（最近置顶）", r1.recent[0] === dirB, JSON.stringify(r1.recent));
  t("recent 含 A", r1.recent.includes(dirA));

  /* 2. 再切回 A：去重置顶 */
  const p3 = await (await fetch(BASE + "/api/workspace", { method: "POST", headers: auth, body: JSON.stringify({ dir: dirA }) })).json();
  t("POST 切回 A：ok", p3.ok === true);
  const r2 = await (await fetch(BASE + "/api/workspace", { headers: auth })).json();
  t("recent[0] === A（去重置顶）", r2.recent[0] === dirA, JSON.stringify(r2.recent));
  t("recent 无重复 A", r2.recent.filter((p) => p === dirA).length === 1);

  /* 3. 持久化：config 落盘 recentWorkspaces（异步队列 + 退避重试，最多等 ~12s） */
  let persisted = null;
  for (let i = 0; i < 24 && !persisted; i++) {
    await wait(500);
    try { persisted = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch (e) {}
  }
  t("config.json recentWorkspaces 已持久化", !!(persisted && Array.isArray(persisted.recentWorkspaces) && persisted.recentWorkspaces[0] === dirA), CONFIG_PATH + " -> " + (persisted ? JSON.stringify(persisted.recentWorkspaces) : "missing"));

  /* 4. 错误路径：不存在目录 → 400 + 中文错误 */
  const p4 = await (await fetch(BASE + "/api/workspace", { method: "POST", headers: auth, body: JSON.stringify({ dir: path.join(os.tmpdir(), "w7-not-exist-" + Date.now()) }) })).json();
  t("不存在目录 → ok:false + 错误信息", p4.ok === false && !!p4.error, JSON.stringify(p4));

  /* 5. 引擎运行中 409（不真跑任务：当前引擎未运行 → 应放行，只验证响应结构） */
  const p5 = await (await fetch(BASE + "/api/workspace", { method: "POST", headers: auth, body: JSON.stringify({ dir: dirB }) })).json();
  t("引擎空闲时切换放行（ok:true）", p5.ok === true, JSON.stringify(p5));

  console.log("\n=== W7 API probe: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
