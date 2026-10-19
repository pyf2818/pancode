/* 渲染应用图标：SVG -> 1024x1024 PNG + 多尺寸 icon.ico
 * 用 Playwright 无头 Chromium 栅格化；ICO 为 PNG 压缩条目（Vista+ 标准），纯 Node 打包 */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ASSETS = path.resolve(__dirname, "..", "assets");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* 把 PNG 条目打包成 .ico（ICONDIR + ICONDIRENTRY[] + PNG 数据） */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type = 1 (icon)
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    const dim = e.size >= 256 ? 0 : e.size; // 256 写 0
    dir[o] = dim;
    dir[o + 1] = dim;
    dir[o + 2] = 0; // 调色板色数
    dir[o + 3] = 0; // 保留
    dir.writeUInt16LE(1, o + 4); // 色彩平面
    dir.writeUInt16LE(32, o + 6); // 位深
    dir.writeUInt32LE(e.buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.buf.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.buf)]);
}

(async () => {
  // SVG 声明了固定 width/height，替换为 100% 以便按视口缩放（有 viewBox 可无损缩放）
  const raw = fs.readFileSync(path.join(ASSETS, "icon.svg"), "utf8");
  const svg = raw.replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"');
  const html = (size) =>
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent}</style>` +
    `</head><body>${svg}</body></html>`;

  const browser = await chromium.launch();

  // 1024 主图（含透明边距，安装器/商店用）
  const big = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await big.setContent(html(1024), { waitUntil: "networkidle" });
  await big.waitForTimeout(150);
  await big.screenshot({
    path: path.join(ASSETS, "icon-1024.png"),
    omitBackground: true,
    clip: { x: 0, y: 0, width: 1024, height: 1024 },
  });
  await big.close();

  // 多尺寸 ICO
  const entries = [];
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(html(size), { waitUntil: "networkidle" });
    await page.waitForTimeout(60);
    const buf = await page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: size, height: size },
    });
    entries.push({ size, buf });
    await page.close();
    console.log(`  ${size}x${size} -> ${(buf.length / 1024).toFixed(1)} KB`);
  }
  await browser.close();

  const ico = buildIco(entries);
  fs.writeFileSync(path.join(ASSETS, "icon.ico"), ico);
  console.log("rendered -> assets/icon-1024.png + assets/icon.ico", `(${(ico.length / 1024).toFixed(0)} KB)`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
