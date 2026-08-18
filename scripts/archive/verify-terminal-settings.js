/* pancode 三项能力端到端验证（Playwright headless Chromium）
   1) 终端多标签页：新建标签 / 各标签隔离输出 / 关闭标签 / 刷新后还原
   2) 设置页持久化：修改 BaseURL/Model → 保存 → 刷新后配置仍在（校验 /api/settings + 输入框）
   3) Agent 全局 CLI 路径：设置 claude 路径 → 保存 → 校验 /api/agents/paths + 刷新后输入框保留
   产物：scripts/_verify_out/term_*.png
*/
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = process.env.PORT || "8827";
const WS = process.env.CURSORWEB_WORKSPACE || path.resolve(__dirname, "..", "server");
process.env.CURSORWEB_WORKSPACE = WS;

require("../../server/index.js");   // 启动服务端（同进程）

const PORT = process.env.PORT;
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

// 备份 pancode.config.json，避免测试写入污染仓库（结束恢复）
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
  const user = "verify_" + Date.now();
  const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: "test1234" }) };
  await fetch(base + "/api/auth/register", opts).catch(() => {});
  const r = await fetch(base + "/api/auth/login", opts);
  const j = await r.json();
  return j.token || "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
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

  const termText = () => page.$eval("#termLines", (e) => e.textContent || "").catch(() => "");
  const tabCount = () => page.$$eval(".term-tab", (els) => els.length).catch(() => 0);
  const activeTabName = () => page.$eval(".term-tab.active .term-tab-name", (e) => e.textContent || "").catch(() => "");
  async function runInActiveTab(cmd) {
    await page.click("#termInput", { force: true });
    await page.fill("#termInput", "");
    await page.fill("#termInput", cmd);
    await page.keyboard.press("Enter");
    await sleep(900);
  }

  // ---------- 1) 终端多标签页 ----------
  await page.click("#btnModeEditor").catch(() => {});   // 终端在编辑器窗口底部
  await sleep(400);
  const tabs0 = await tabCount();
  // 新建一个标签
  await page.click(".term-tab-add");
  await sleep(300);
  const tabs1 = await tabCount();
  // 在标签1（默认）跑命令
  const tab1Name = (await page.$$(".term-tab-name"))[0];
  await (await page.$$(".term-tab-name"))[0].click();
  await sleep(200);
  await runInActiveTab("echo ::MARKER_A::");
  const tA = await termText();
  // 切到标签2 跑不同命令
  await (await page.$$(".term-tab-name"))[1].click();
  await sleep(200);
  await runInActiveTab("echo ::MARKER_B::");
  const tB = await termText();
  const isolationOK = tB.includes("::MARKER_B::") && !tB.includes("::MARKER_A::");
  // 切回标签1 确认隔离
  await (await page.$$(".term-tab-name"))[0].click();
  await sleep(300);
  const tAback = await termText();
  const isolationBackOK = tAback.includes("::MARKER_A::") && !tAback.includes("::MARKER_B::");
  await page.screenshot({ path: path.join(OUT, "term_multitab.png") });
  console.log("TERM tabs0=" + tabs0 + " tabsAfterNew=" + tabs1 + " B_onlyInTab2=" + isolationOK + " A_onlyInTab1=" + isolationBackOK);

  // 刷新还原（此时有 2 个标签，标签2 含 MARKER_B）
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await sleep(1200);
  await hideModals();
  await page.click("#btnModeEditor").catch(() => {});
  await sleep(500);
  const tabsAfterReload = await tabCount();
  // 找到含 MARKER_B 的标签并点击（每次迭代重新查询，因为点击会重渲染标签栏）
  let restoredB = false;
  for (let i = 0; i < tabsAfterReload; i++) {
    const names2 = await page.$$(".term-tab-name");
    if (!names2[i]) break;
    await names2[i].click();
    await sleep(300);
    const tx = await termText();
    if (tx.includes("::MARKER_B::")) { restoredB = true; break; }
  }
  console.log("TERM tabsAfterReload=" + tabsAfterReload + " historyRestored=" + restoredB + " => " + ((tabsAfterReload >= 2 && restoredB) ? "OK" : "FAIL"));
  await page.screenshot({ path: path.join(OUT, "term_reload.png") });
  const termOK = tabs1 === 2 && isolationOK && isolationBackOK && tabsAfterReload >= 2 && restoredB;

  // ---------- 2) 设置页持久化 ----------
  await page.click("#btnSettings");
  await sleep(400);
  const SET_URL = "https://verify.example.com/v1_" + Date.now();
  const SET_MODEL = "verify-model-" + Date.now();
  await page.fill("#setBaseURL", SET_URL);
  await page.fill("#setModel", SET_MODEL);
  await page.click("#setSave");
  await sleep(1100);   // 等自动关闭 + 落盘
  const afterSave = await page.evaluate(async (u) => {
    const r = await fetch("/api/settings").then((x) => x.json());
    return { baseURL: r.baseURL, model: r.model };
  }, base);
  const settingsPersistAPI = afterSave.baseURL === SET_URL && afterSave.model === SET_MODEL;
  // 刷新后输入框应回填 baseURL
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await sleep(1200);
  await hideModals();
  await page.click("#btnSettings");
  await sleep(400);
  const baseURLFilled = await page.$eval("#setBaseURL", (e) => e.value).catch(() => "");
  const settingsPersistUI = baseURLFilled === SET_URL;
  console.log("SETTINGS api=" + settingsPersistAPI + " uiBaseURL=" + settingsPersistUI + " => " + ((settingsPersistAPI && settingsPersistUI) ? "OK" : "FAIL"));
  await page.screenshot({ path: path.join(OUT, "settings_persist.png") });
  // 关掉弹窗
  await page.evaluate(() => { const m = document.getElementById("settingsModal"); if (m) m.style.display = "none"; });

  // ---------- 3) Agent 全局 CLI 路径配置 ----------
  await page.click("#btnAgentSettings");
  await sleep(400);
  const FAKE_PATH = "C:\\verify\\claude-path-" + Date.now() + ".exe";
  await page.fill("#agmPathClaude", FAKE_PATH);
  await page.click("#agmSave");
  await sleep(1000);
  const pathsAPI = await page.evaluate(async () => {
    const r = await fetch("/api/agents/paths").then((x) => x.json());
    return r.paths || {};
  });
  const pathsPersistAPI = (pathsAPI.claude || "") === FAKE_PATH;
  // 刷新后输入框保留
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await sleep(1200);
  await hideModals();
  await page.click("#btnAgentSettings");
  await sleep(400);
  const claudeInput = await page.$eval("#agmPathClaude", (e) => e.value).catch(() => "");
  const pathsPersistUI = claudeInput === FAKE_PATH;
  console.log("AGENTPATHS api=" + pathsPersistAPI + " ui=" + pathsPersistUI + " => " + ((pathsPersistAPI && pathsPersistUI) ? "OK" : "FAIL"));
  await page.screenshot({ path: path.join(OUT, "agent_paths.png") });
  await page.evaluate(() => { const m = document.getElementById("agentModal"); if (m) m.style.display = "none"; });

  const summary = {
    termOK, tabs0, tabs1, isolationOK, isolationBackOK, tabsAfterReload, restoredB,
    settingsPersistAPI, settingsPersistUI,
    pathsPersistAPI, pathsPersistUI,
    errors: errors.slice(0, 8),
  };
  console.log("SUMMARY " + JSON.stringify(summary));

  await browser.close();
  restoreConfig();
  process.exit(0);
})().catch((e) => { console.error("VERIFY_FAIL", e); restoreConfig(); process.exit(1); });
