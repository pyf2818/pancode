/* pancode 三项能力端到端验证（Playwright headless Chromium）
   1) 持久化聊天记录：切到 Agents 模式 → 发一条用户消息 → 重载页面 → 断言消息仍在（localStorage 恢复）
   2) 新建对话重置：点「新建对话」→ 断言旧消息清空、出现「新对话」系统消息
   3) 预览区可拖拽：切到编辑器模式 → 打开 .md 文件 → 开启预览 → 拖拽分隔条 → 断言宽度变化且写入 localStorage
   产物：scripts/_verify_out/persist_*.png
*/
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = process.env.PORT || "8826";
const WS = process.env.CURSORWEB_WORKSPACE || path.resolve(__dirname, "..", "server");
process.env.CURSORWEB_WORKSPACE = WS;

// 预览拖拽测试需要一个可预览文件：在测试工作区放一个临时 .md（脚本结束删除，不入库）
const PV_FILE = "_pv_verify_test.md";
const pvPath = path.join(WS, PV_FILE);
fs.writeFileSync(pvPath, "# 预览拖拽验证\n\n这是一段用于验证实时预览与分隔条拖拽的 Markdown 内容。\n", "utf8");

require("../../server/index.js");   // 启动服务端（同进程）

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
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

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
  await page.evaluate(() => {
    ["onboardModal", "authModal"].forEach((id) => { const m = document.getElementById(id); if (m) m.style.display = "none"; });
  });

  // 切到 Agents 模式（聊天 UI 与「新建对话」按钮都在该窗口）
  await page.click("#btnModeAgents");
  await page.waitForTimeout(500);

  // ---------- 1) 持久化聊天记录 ----------
  const TEST_MSG = "持久化验证消息_" + Date.now();
  await page.fill("#chatInput", TEST_MSG);
  await page.click("#btnSend");
  await page.waitForTimeout(900);   // 等 MutationObserver 防抖落盘（500ms）
  const beforeReload = await page.$eval("#chatStream", (e) => e.textContent || "").catch(() => "");
  await page.screenshot({ path: path.join(OUT, "persist_before.png") });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    ["onboardModal", "authModal"].forEach((id) => { const m = document.getElementById(id); if (m) m.style.display = "none"; });
  });
  await page.click("#btnModeAgents").catch(() => {});   // 重载后默认回编辑器，切回 agents 看聊天
  await page.waitForTimeout(500);
  const afterReload = await page.$eval("#chatStream", (e) => e.textContent || "").catch(() => "");
  const persistOK = beforeReload.includes(TEST_MSG) && afterReload.includes(TEST_MSG);
  console.log("PERSIST beforeHas=" + beforeReload.includes(TEST_MSG) + " afterHas=" + afterReload.includes(TEST_MSG) + " => " + (persistOK ? "OK" : "FAIL"));
  await page.screenshot({ path: path.join(OUT, "persist_after.png") });

  // ---------- 2) 新建对话重置 ----------
  await page.evaluate(() => { if (window.state) window.state.running = false; });   // 解除无 LLM 时的运行守卫
  await page.click("#agNewTask");
  await page.waitForTimeout(700);
  const afterNew = await page.$eval("#chatStream", (e) => e.textContent || "").catch(() => "");
  const resetOK = !afterNew.includes(TEST_MSG) && /新对话/.test(afterNew);
  console.log("NEWCONV oldCleared=" + (!afterNew.includes(TEST_MSG)) + " hasGreeting=" + /新对话/.test(afterNew) + " => " + (resetOK ? "OK" : "FAIL"));
  await page.screenshot({ path: path.join(OUT, "persist_newconv.png") });

  // ---------- 3) 预览区可拖拽 ----------
  await page.click("#btnModeEditor");   // 切回编辑器模式（预览面板在该窗口）
  await page.waitForTimeout(400);
  await page.evaluate((f) => { if (typeof state !== "undefined") state.activeFile = f; if (typeof togglePreview === "function") togglePreview(true); }, PV_FILE);
  await page.waitForTimeout(600);
  const resizerVisible = await page.$eval("#previewResizer", (e) => getComputedStyle(e).display !== "none").catch(() => false);
  const wBefore = await page.$eval("#htmlPreview", (e) => e.getBoundingClientRect().width).catch(() => 0);
  const box = await page.$eval("#previewResizer", (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }).catch(() => null);
  let dragOK = false, wAfter = wBefore, stored = "";
  if (box) {
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x - 120, box.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    wAfter = await page.$eval("#htmlPreview", (e) => e.getBoundingClientRect().width).catch(() => wBefore);
    stored = await page.evaluate(() => localStorage.getItem("cw-preview-w") || "");
    dragOK = Math.abs(wAfter - wBefore) > 30 && stored !== "";
    console.log("PREVIEW resizerVisible=" + resizerVisible + " wBefore=" + Math.round(wBefore) + " wAfter=" + Math.round(wAfter) + " stored=" + stored + " => " + (dragOK ? "OK" : "FAIL"));
  } else {
    console.log("PREVIEW resizer not found => FAIL");
  }
  await page.screenshot({ path: path.join(OUT, "persist_preview.png") });

  const summary = { persistOK, resetOK, dragOK, resizerVisible, previewWidth: { before: Math.round(wBefore), after: Math.round(wAfter) }, stored, errors: errors.slice(0, 8) };
  console.log("SUMMARY " + JSON.stringify(summary));

  await browser.close();
  try { fs.unlinkSync(pvPath); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error("VERIFY_FAIL", e); try { fs.unlinkSync(pvPath); } catch (_) {} process.exit(1); });
