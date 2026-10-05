/* W5 Visualizer UI 探针（Playwright headless Chromium）
   验证链路：renderChatMD 识别 ```widget 块 → 沙箱 iframe srcdoc 渲染 SVG →
   高度桥自适应 → 下载按钮（SVG/PNG）注册表 → 未闭合 fence 流式期不渲染 widget
   产物：scripts/_verify_out/w5_widget.png */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = "8893";
const os = require("os");
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "w5ui-ws-"));
process.env.CURSORWEB_WORKSPACE = WS;
require("../server/index.js");

const PORT = process.env.PORT;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const uname = "w5ui_" + Date.now();
  const j = await (await fetch(BASE + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: uname, password: "test1234" }) })).json();
  const token = j.token || "";

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
  await page.waitForTimeout(1000);

  /* 1. renderChatMD：widget 块 → 沙箱卡片；未闭合 → 普通代码块；普通语言不受影响 */
  const sample = [
    "架构如下：",
    "",
    "```widget",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120" width="300" height="120">',
    '  <rect x="10" y="10" width="120" height="40" rx="6" fill="none" stroke="currentColor"/>',
    '  <text x="70" y="35" text-anchor="middle" fill="currentColor" font-size="13">Frontend</text>',
    '  <rect x="170" y="10" width="120" height="40" rx="6" fill="none" stroke="currentColor"/>',
    '  <text x="230" y="35" text-anchor="middle" fill="currentColor" font-size="13">Backend</text>',
    '  <path d="M130 30 L170 30" stroke="currentColor" marker-end=""/>',
    '  <rect x="90" y="70" width="120" height="36" rx="6" fill="none" stroke="currentColor"/>',
    '  <text x="150" y="93" text-anchor="middle" fill="currentColor" font-size="13">DB</text>',
    "</svg>",
    "```",
    "",
    "```widget",
    "<svg><unclosed",
  ].join("\n");

  const rendered = await page.evaluate((src) => {
    const box = document.createElement("div");
    box.id = "w5probe";
    box.innerHTML = window.renderChatMD(src);
    document.body.appendChild(box);
    const widgets = box.querySelectorAll(".msg-widget");
    const frames = box.querySelectorAll(".wg-frame");
    const codes = box.querySelectorAll(".code-block");
    const unclosedPre = codes.length && codes[codes.length - 1].textContent.includes("<svg><unclosed");
    const svgInDoc = frames.length ? frames[0].getAttribute("srcdoc").replace(/&quot;/g, '"').replace(/&amp;/g, "&") : "";
    return {
      widgetCount: widgets.length,
      frameCount: frames.length,
      codeCount: codes.length,
      unclosedIsCode: unclosedPre,
      hasSvg: svgInDoc.includes("<svg"),
      hasBtns: widgets.length ? widgets[0].querySelectorAll(".wg-btn").length : 0,
      sandboxed: frames.length ? frames[0].sandbox.contains("allow-scripts") && !frames[0].sandbox.contains("allow-same-origin") : false,
    };
  }, sample);
  t("widget 块渲染为卡片（1 个）", rendered.widgetCount === 1, JSON.stringify(rendered));
  t("沙箱 iframe：allow-scripts 且无 allow-same-origin", rendered.sandboxed);
  t("srcdoc 含 SVG 内容", rendered.hasSvg);
  t("下载按钮 2 个（SVG/PNG）", rendered.hasBtns === 2);
  t("未闭合 widget 流式期按代码块预览", rendered.unclosedIsCode && rendered.codeCount === 1);

  /* 2. 高度桥：等 iframe load → postMessage 高度 → iframe 高度 > 80px 初始值 */
  await wait(1200);
  const h = await page.evaluate(() => {
    const f = document.querySelector("#w5probe .wg-frame");
    return f ? parseInt(f.style.height, 10) : 0;
  });
  t("高度桥自适应（>80px 初始值）", h > 80, "h=" + h);

  /* 3. 下载 SVG：注册表 + download 事件 */
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 8000 }).catch(() => null),
    page.click('#w5probe .wg-btn[data-act="svg"]'),
  ]);
  t("下载 SVG 触发", !!download, "无 download 事件");
  if (download) t("文件名 .svg", /\.svg$/.test(download.suggestedFilename()), download.suggestedFilename());

  await page.screenshot({ path: path.join(OUT, "w5_widget.png") });
  t("无页面 JS 错误", errors.length === 0, errors.join(" || ").slice(0, 300));

  await browser.close();
  console.log("\n=== W5 UI probe: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
