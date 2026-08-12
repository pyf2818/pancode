/* pancode 规划模式（Plan Mode）端到端验证（Playwright headless Chromium）
   验证：
   1) 点击「规划」按钮 → 按钮进入 .on 高亮，且 GET /api/agent-settings 返回 planMode:true（后端实时生效）
   2) 刷新页面后按钮仍为 .on（经 hello → applyAgentSettings 持久化还原）
   3) 再次点击 → 取消 .on，GET 返回 planMode:false
   4) pancode.config.json 已落盘 planMode
   产物：scripts/_verify_out/planmode.png
*/
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = process.env.PORT || "8831";
const WS = process.env.CURSORWEB_WORKSPACE || path.resolve(__dirname, "..", "server");
process.env.CURSORWEB_WORKSPACE = WS;

require("../server/index.js");   // 启动服务端（同进程）

const PORT = process.env.PORT;
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

const CONFIG_PATH = path.join(__dirname, "..", "pancode.config.json");
const cfgExisted = fs.existsSync(CONFIG_PATH);
const cfgBackup = cfgExisted ? fs.readFileSync(CONFIG_PATH, "utf8") : null;
function restoreConfig() {
  try {
    if (cfgExisted) fs.writeFileSync(CONFIG_PATH, cfgBackup, "utf8");
    else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  } catch (e) {}
}

async function getToken() {
  const base = `http://127.0.0.1:${PORT}`;
  const user = "verify_pm_" + Date.now();
  const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: "test1234" }) };
  await fetch(base + "/api/auth/register", opts).catch(() => {});
  const r = await fetch(base + "/api/auth/login", opts);
  const j = await r.json();
  return j.token || "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let ok = true;
  const token = await getToken();
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  if (token) await page.addInitScript((t) => { localStorage.setItem("cw-onboarded", "1"); localStorage.setItem("cw-user-token", t); }, token);
  else await page.addInitScript(() => localStorage.setItem("cw-onboarded", "1"));

  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 30; i++) { try { const r = await fetch(base + "/"); if (r.ok) break; } catch (e) {} await sleep(500); }
  await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await sleep(1200);
  const hideModals = () => page.evaluate(() => ["onboardModal", "authModal"].forEach((id) => { const m = document.getElementById(id); if (m) m.style.display = "none"; }));
  await hideModals();
  await page.click("#btnModeEditor").catch(() => {});
  await sleep(400);

  const isOn = () => page.$eval("#btnPlanMode", (e) => e.classList.contains("on")).catch(() => false);
  const getPlanMode = async () => {
    const r = await fetch(base + "/api/agent-settings", { headers: { "x-user-token": token } });
    const j = await r.json();
    return !!(j.agent && j.agent.planMode);
  };

  // 1) 开启规划模式
  await page.click("#btnPlanMode");
  await sleep(500);
  const onAfterClick = await isOn();
  const apiTrue = await getPlanMode();
  console.log("PLAN onAfterClick=" + onAfterClick + " apiPlanMode=" + apiTrue);
  if (!onAfterClick || !apiTrue) ok = false;

  // 2) 刷新后是否仍在（持久化）
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await sleep(1200);
  await hideModals();
  await page.click("#btnModeEditor").catch(() => {});
  await sleep(500);
  const onAfterReload = await isOn();
  console.log("PLAN onAfterReload=" + onAfterReload);
  if (!onAfterReload) ok = false;

  // 3) 再次点击关闭
  await page.click("#btnPlanMode");
  await sleep(500);
  const offAfterClick = await isOn();
  const apiFalse = await getPlanMode();
  console.log("PLAN offAfterClick=" + offAfterClick + " apiPlanMode=" + apiFalse);
  if (offAfterClick || apiFalse) ok = false;

  // 4) 落盘检查
  let persisted = false;
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); persisted = c.planMode === false; } catch (e) {}
  console.log("PLAN configPlanModeFalse=" + persisted);

  await page.screenshot({ path: path.join(OUT, "planmode.png") });
  await browser.close();

  console.log("PLAN errors=" + JSON.stringify(errors));
  console.log("PLAN OK=" + (ok && errors.length === 0));
  restoreConfig();
  process.exit(ok && errors.length === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY ERROR", e); restoreConfig(); process.exit(2); });
