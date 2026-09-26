/* 真实启动冒烟探针：真实配置（仓库根 config + workspace/）+ 真实 LLM 全链路
   验证：登录 → 工作区挂载 → 核心 UI → 发消息 → W9 Worker 流式渲染 → msg.end 终态 → 截图
   产物：scripts/_verify_out/smoke_workspace.png / smoke_answer.png */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = "http://127.0.0.1:8766";
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n + (extra ? "  [" + extra + "]" : "")); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* 0. 冒烟账号（测完清理） */
  const uname = "_smoke_ui_" + Date.now();
  const j = await (await fetch(BASE + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: uname, password: "smoke1234" }) })).json();
  const token = j.token || "";
  t("注册冒烟账号", !!token, JSON.stringify(j).slice(0, 120));

  /* 0.5 真实工作区信息 */
  const wsInfo = await (await fetch(BASE + "/api/workspace", { headers: { Authorization: "Bearer " + token } })).json();
  t("GET /api/workspace（真实配置）", wsInfo.ok !== false && !!wsInfo.current, "current=" + wsInfo.current + " recent=" + (wsInfo.recent || []).length + " 条");

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => {
    const msg = e.message || "";
    if (msg.includes("sandboxed and lacks the 'allow-same-origin'")) return;
    errors.push("PAGEERROR: " + msg);
  });
  await page.addInitScript((tk) => { localStorage.setItem("cw-user-token", tk); localStorage.setItem("cw-onboarded", "1"); }, token);

  await page.goto(BASE + "/", { waitUntil: "load", timeout: 30000 });
  // 坑：state 是顶层词法绑定（window.state 为 undefined）——必须用 typeof 词法访问，window.state.* 永远空等
  const monacoOk = await page.waitForFunction(() => (typeof state !== "undefined") && state.monacoReady === true, { timeout: 60000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(1500);

  /* 1. 核心 UI 就位 */
  const ui = await page.evaluate(() => ({
    editorReady: (typeof state !== "undefined") && state.monacoReady === true,
    wsTitle: (document.getElementById("btnOpenFolder") || {}).title || "",
    chatInput: !!document.querySelector("#chatInputEditor #chatInput, #chatInputAgents #chatInput"),
    modelLabel: (document.getElementById("cpModelEditor") || {}).textContent || "",   // applyEngineInfo 直接写 UI，比 state.engine 时序稳
    fileTree: document.querySelectorAll("#fileTree .ft-item").length || 0,
  }));
  t("Monaco 编辑器就绪", ui.editorReady && monacoOk);
  t("工作区 title 提示（W7 链路）", ui.wsTitle.includes("当前工作区"), ui.wsTitle);
  t("聊天输入框存在", ui.chatInput);
  t("引擎模式标签（llm + 模型名）", /llm|flash|gpt|claude|agnes/i.test(ui.modelLabel) || ui.modelLabel.includes("演示"), ui.modelLabel);
  t("文件树已渲染（>0 项）", ui.fileTree > 0, "items=" + ui.fileTree);

  await page.screenshot({ path: path.join(OUT, "smoke_workspace.png") });

  /* 2. 真实 LLM 端到端（W9 Worker 流式渲染链路） */
  await page.evaluate(() => window.send({ type: "chat", text: "用一句话 + 一个二级标题介绍你自己，控制在 50 字内" }));
  const sawCaret = await page.waitForSelector(".msg-ai.type-caret", { timeout: 15000 }).then(() => true).catch(() => false);
  t("流式开始（type-caret 出现）", sawCaret);
  await page.waitForFunction(() => !document.querySelector(".msg-ai.type-caret"), { timeout: 45000 }).catch(() => {});
  await wait(500);

  const ans = await page.evaluate(() => {
    const el = document.querySelector(".ans-row .msg-ai");
    const errCard = document.querySelector(".evo-err-card");
    if (errCard) return { found: false, err: errCard.textContent.trim().slice(0, 200) };
    if (!el) return { found: false, err: "(无气泡也无错误卡片)" };
    return {
      found: true,
      text: el.textContent.trim(),
      hasH2: !!el.querySelector("h2"),
      hasCaret: el.classList.contains("type-caret"),
      hasCopy: !!(el.closest(".msg-row") && el.closest(".msg-row").querySelector(".msg-copy")),
      workerAlive: !_mdWDead,
      toolCards: document.querySelectorAll(".tool-card").length,
    };
  });
  if (!ans.found && ans.err) t("真实 LLM 回答已渲染", false, "错误卡片: " + ans.err);
  t("markdown 标题渲染（h2）", ans.found && ans.hasH2);
  t("msg.end 终态（caret 移除 + 复制按钮）", ans.found && !ans.hasCaret && ans.hasCopy);
  t("W9 Worker 全程存活", ans.found && ans.workerAlive);

  await page.screenshot({ path: path.join(OUT, "smoke_answer.png") });
  t("无页面 JS 错误", errors.length === 0, errors.join(" || ").slice(0, 300));

  await browser.close();

  /* 3. 清理冒烟账号（文件级；服务进程持锁/AV 时重试 3 次） */
  const up = path.join(__dirname, "..", ".pancode", "users.json");
  let cleaned = false, lastErr = "";
  for (let i = 0; i < 3 && !cleaned; i++) {
    try {
      const db = JSON.parse(fs.readFileSync(up, "utf8"));
      if (db.users) delete db.users[uname]; else delete db[uname];
      fs.writeFileSync(up, JSON.stringify(db, null, 2), "utf8");
      cleaned = true;
    } catch (e) { lastErr = e.message; await wait(800); }
  }
  console.log(cleaned ? "  ⌫ 冒烟账号已清理: " + uname : "  ⚠ 冒烟账号清理失败（无害，可留待手动清）: " + lastErr);

  console.log("\n=== Smoke: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
