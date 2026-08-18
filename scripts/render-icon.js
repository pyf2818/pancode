/* 渲染应用图标：SVG -> 1024x1024 PNG（用 Playwright 无头 Chromium 栅格化） */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

(async () => {
  const svgPath = path.resolve(__dirname, "..", "assets", "icon.svg");
  const outPath = path.resolve(__dirname, "..", "assets", "icon-1024.png");
  const svg = fs.readFileSync(svgPath, "utf8");
  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0;width:1024px;height:1024px;background:transparent}</style>` +
    `</head><body>${svg}</body></html>`;

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1024, height: 1024 },
    deviceScaleFactor: 1,
  });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
  await browser.close();
  console.log("rendered ->", outPath);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
