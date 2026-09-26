/* W4 自动化 UI 探针（Playwright headless Chromium）
   验证链路：工具栏 clock 按钮 → 自动化弹窗 → 模板快捷填充 → 创建任务 →
   卡片渲染（状态徽标/下次执行）→ 暂停 → 删除 → 列表空态
   产物：scripts/_verify_out/w4_automations.png */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = "8896";
const os = require("os");
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "w4ui-ws-")); // 每次全新工作区：杜绝上轮残留文件被 AV 长锁污染本轮
process.env.CURSORWEB_WORKSPACE = WS;
require("../server/index.js");

const PORT = process.env.PORT;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n); } };

(async () => {
  const uname = "w4ui_" + Date.now();
  const j = await (await fetch(BASE + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: uname, password: "test1234" }) })).json();
  const token = j.token || "";

  // 幂等预清理：上一轮探针可能残留任务（固定工作区），循环删到空为止（AV 锁可能让单轮删除失败）
  try {
    for (let round = 0; round < 5; round++) {
      const lst = await (await fetch(BASE + "/api/automations")).json();
      const items = lst.automations || [];
      if (!items.length) break;
      for (const a of items) await fetch(BASE + "/api/automations/" + a.id, { method: "DELETE" });
      await wait(800);
    }
  } catch (e) {}

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
  await page.waitForTimeout(1200);

  // 打开自动化弹窗（等列表加载完成：空态或卡片二选一）
  await page.click("#btnAutomations");
  await page.waitForSelector("#automationsModal", { state: "visible", timeout: 8000 });
  await page.waitForFunction(() => {
    const tx = document.querySelector("#autoList").textContent;
    return tx.includes("还没有自动化任务") || !!document.querySelector(".auto-card");
  }, { timeout: 8000 });
  t("弹窗打开 + 空态提示", await page.evaluate(() => document.querySelector("#autoList").textContent.includes("还没有自动化任务")));

  // 模板快捷填充 → 表单出现 → 创建
  await page.click('.auto-tpl[data-tpl="0"]');
  t("模板填充表单（名称/cron/prompt）", await page.evaluate(() =>
    document.querySelector("#autoName").value === "定时跑测试" &&
    document.querySelector("#autoCron").value === "0 */2 * * *" &&
    document.querySelector("#autoPrompt").value.length > 10));
  await page.click("#btnAutoSave");
  await page.waitForSelector(".auto-card", { timeout: 8000 });
  t("任务卡片渲染（名称+进行中徽标）", await page.evaluate(() => {
    const c = document.querySelector(".auto-card");
    return c && c.textContent.includes("定时跑测试") && !!c.querySelector(".mcp-badge.ok");
  }));
  t("卡片显示 cron 表达式", await page.evaluate(() => document.querySelector(".auto-card").textContent.includes("0 */2 * * *")));

  // 暂停 → 徽标变已暂停
  await page.click('.auto-card .auto-act[data-act="pause"]');
  await page.waitForFunction(() => {
    const b = document.querySelector(".auto-card");
    return b && b.textContent.includes("已暂停");
  }, { timeout: 8000 }).catch(() => {});
  t("暂停后徽标=已暂停", await page.evaluate(() => document.querySelector(".auto-card").textContent.includes("已暂停")));

  await page.screenshot({ path: path.join(OUT, "w4_automations.png") });

  // 删除（confirm 弹窗）
  await page.click('.auto-card .auto-act[data-act="del"]');
  await page.waitForFunction(() => !!document.querySelector("#confirmModal") && document.querySelector("#confirmModal").style.display === "flex", { timeout: 5000 });
  await page.click("#confirmOk");
  await page.waitForFunction(() => document.querySelector("#autoList").textContent.includes("还没有自动化任务"), { timeout: 8000 }).catch(() => {});
  const listText = await page.evaluate(() => document.querySelector("#autoList").textContent.slice(0, 200));
  if (!(listText.includes("还没有自动化任务"))) {
    console.log("    (diag) 删除后列表内容:", JSON.stringify(listText));
    await page.screenshot({ path: path.join(OUT, "w4_delete_debug.png") });
  }
  t("删除后回到空态", listText.includes("还没有自动化任务"));

  t("无页面 JS 错误", errors.length === 0, errors.join(" || ").slice(0, 300));
  await browser.close();
  console.log("\n=== W4 UI probe: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
