/* W9 Markdown Worker UI 探针（Playwright headless Chromium）
   验证链路：md-worker.js 经典 Worker 加载 → renderChatMDAsync 与主线程 renderChatMD 输出一致 →
   Worker 死亡回退同步 → 端到端流式（demo 引擎 msg.delta → 节流 Worker 渲染 → msg.end 同步终态）
   产物：scripts/_verify_out/w9_worker.png */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = "8895";
const os = require("os");
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "w9ui-ws-"));
process.env.CURSORWEB_WORKSPACE = WS;
require("../server/index.js");

const PORT = process.env.PORT;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (n, c, extra) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n + (extra ? "  [" + extra + "]" : "")); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const uname = "w9ui_" + Date.now();
  const j = await (await fetch(BASE + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: uname, password: "test1234" }) })).json();
  const token = j.token || "";
  t("注册拿 token", !!token);

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => {
    const msg = e.message || "";
    if (msg.includes("sandboxed and lacks the 'allow-same-origin'")) return;
    errors.push("PAGEERROR: " + msg);
  });
  if (token) await page.addInitScript((tk) => { localStorage.setItem("cw-user-token", tk); localStorage.setItem("cw-onboarded", "1"); }, token);

  await page.goto(BASE + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(800);

  /* 1. Worker 加载成功 + 异步渲染与主线程同步渲染输出一致（普通 markdown） */
  const sample = "## 标题\n\n- 列表项A\n- 列表项B\n\n`code` 和 **加粗**\n\n```js\nconsole.log(1);\n```";
  const r1 = await page.evaluate(async (src) => {
    const syncHtml = window.renderChatMD(src);
    const asyncHtml = await new Promise((res) => window.renderChatMDAsync(src, (h) => res({ h, alive: !_mdWDead, worker: !!_mdW })));
    return { syncHtml, asyncHtml };
  }, sample);
  t("Worker 实例创建成功（http 协议）", r1.asyncHtml.worker === true);
  t("Worker 存活（未回退）", r1.asyncHtml.alive === true);
  t("Worker 输出与主线程 renderChatMD 一致", r1.asyncHtml.h === r1.syncHtml, "len sync=" + (r1.syncHtml || "").length + " async=" + (r1.asyncHtml.h || "").length);
  t("渲染内容正确（列表+代码块）", (r1.asyncHtml.h || "").includes("<li>") && (r1.asyncHtml.h || "").includes("code-block"));

  /* 2. widget 块：Worker 语义 = 流式期按代码块预览（与 W5 约定一致） */
  const wsample = "前置\n\n```widget\n<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"10\" height=\"10\"/></svg>\n```";
  const r2 = await page.evaluate(async (src) => {
    const syncHtml = window.renderChatMD(src);
    const asyncHtml = await new Promise((res) => window.renderChatMDAsync(src, (h) => res(h)));
    return { syncHasCard: syncHtml.includes("msg-widget"), asyncHasCard: asyncHtml.includes("msg-widget"), asyncIsCode: asyncHtml.includes("code-block") };
  }, wsample);
  t("主线程版：闭合 widget → 沙箱卡片", r2.syncHasCard);
  t("Worker 版：widget 按代码块预览（流式语义）", !r2.asyncHasCard && r2.asyncIsCode);

  /* 3. 端到端流式：demo 引擎 → msg.delta 节流 Worker 渲染 → msg.end 同步终态 */
  await page.evaluate(() => window.send({ type: "chat", text: "请用 markdown 列表和代码块介绍你自己" }));
  await page.waitForSelector(".msg-ai.type-caret", { timeout: 10000 }).catch(() => {});
  // 等 msg.end：caret 消失（demo 引擎流式通常数秒内完成）
  await page.waitForFunction(() => !document.querySelector(".msg-ai.type-caret"), { timeout: 20000 }).catch(() => {});
  await wait(400);
  const r3 = await page.evaluate(() => {
    const el = document.querySelector(".ans-row .msg-ai");
    if (!el) return { found: false };
    return {
      found: true,
      html: el.innerHTML,
      hasCaret: el.classList.contains("type-caret"),
      hasCopy: !!(el.closest(".msg-row") && el.closest(".msg-row").querySelector(".msg-copy")),
      workerAlive: !_mdWDead,
    };
  });
  t("端到端：回答气泡已渲染", r3.found && r3.html.length > 0);
  t("端到端：msg.end 后 caret 已移除", r3.found && !r3.hasCaret);
  t("端到端：复制全部按钮已挂载", r3.hasCopy);
  t("端到端：全程 Worker 未挂（无回退触发）", r3.workerAlive);

  /* 4. Worker 死亡回退：_mdWDead 置真 → 异步调用走同步分支，输出仍正确 */
  const r4 = await page.evaluate(async (src) => {
    _mdWDead = true; _mdW = null;
    const h = await new Promise((res) => window.renderChatMDAsync(src, (hh) => res(hh)));
    const ok = h === window.renderChatMD(src);
    _mdWDead = false; _mdW = null;   // 复原
    return { ok };
  }, "回退测试 **加粗**");
  t("Worker 死亡 → 同步回退输出一致", r4.ok);

  await page.screenshot({ path: path.join(OUT, "w9_worker.png") });
  t("无页面 JS 错误", errors.length === 0, errors.join(" || ").slice(0, 300));

  await browser.close();
  console.log("\n=== W9 UI probe: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
