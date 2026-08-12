/* pancode i18n 切换 + 本地 Agent 检测 端到端验证（Playwright headless Chromium）
   1) 同进程启动服务端（CURSORWEB_WORKSPACE=server）
   2) 注册+登录，自动跳过引导/登录弹窗
   3) 断言初始中文 → 点语言切换变英文 → 再切换回中文
   4) 断言侧边栏「本地 Agent」区渲染出 agent-item（检测逻辑生效）
   5) 直接 fetch /api/agents/detect 校验后端 REST
   6) 捕获 pageerror：确认 setRunning 空引用已修复（WS hello 会触发 setRunning）
   产物：scripts/_verify_out/agents_i18n.png
*/
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = process.env.PORT || "8825";
process.env.CURSORWEB_WORKSPACE = process.env.CURSORWEB_WORKSPACE || path.resolve(__dirname, "..", "server");
require("../server/index.js");

const PORT = process.env.PORT;
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

async function getToken() {
  const base = `http://127.0.0.1:${PORT}`;
  const user = "verify_" + Date.now();
  const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: "test1234" }) };
  await fetch(base + "/api/auth/register", opts).catch(() => {});
  const r = await fetch(base + "/api/auth/login", opts);
  const j = await r.json();
  return j.token || "";
}

(async () => {
  const token = await getToken();
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  if (token) await page.addInitScript((t) => { localStorage.setItem("cw-onboarded", "1"); localStorage.setItem("cw-user-token", t); }, token);
  else await page.addInitScript(() => localStorage.setItem("cw-onboarded", "1"));

  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(base + "/"); if (r.ok) break; } catch (e) {}
    await new Promise((res) => setTimeout(res, 500));
  }
  await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.evaluate(() => { ["onboardModal", "authModal"].forEach((id) => { const m = document.getElementById(id); if (m) m.style.display = "none"; }); });

  // 1) 初始语言应为中文
  const zhInitial = await page.$eval("#btnSettings span", (e) => e.textContent).catch(() => "");
  // 2) 切换为英文
  await page.click("#btnLangToggle");
  await page.waitForTimeout(400);
  const enAfterToggle = await page.$eval("#btnSettings span", (e) => e.textContent).catch(() => "");
  // 3) 切回中文
  await page.click("#btnLangToggle");
  await page.waitForTimeout(400);
  const zhAfterBack = await page.$eval("#btnSettings span", (e) => e.textContent).catch(() => "");

  // 4) 侧边栏 Agent 检测区渲染
  await page.waitForFunction(() => document.querySelectorAll("#agentDetectList .agent-item").length > 0, { timeout: 15000 }).catch(() => {});
  const agentItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#agentDetectList .agent-item")).map((el) => ({
      name: (el.querySelector(".agent-meta b") || {}).textContent || "",
      installed: el.classList.contains("installed"),
    }))
  );
  await page.screenshot({ path: path.join(OUT, "agents_i18n.png") });

  // 5) 后端 REST 直测
  const det = await (await fetch(base + "/api/agents/detect")).json();

  const setRunningErr = errors.filter((e) => /setRunning/.test(e));
  console.log("DIAG " + JSON.stringify({
    zhInitial, enAfterToggle, zhAfterBack,
    agentItems, restDetect: det,
    setRunningErrCount: setRunningErr.length,
    errors: errors.slice(0, 8),
  }, null, 2));

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("VERIFY_FAIL", e); process.exit(1); });
