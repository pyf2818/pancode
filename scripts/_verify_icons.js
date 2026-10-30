/* 应用图标工艺门禁（2026-10-30 换版时建）
   起因：装出来的包在桌面/开始菜单上"像占位图"。量出来根因不是没生效 ——
   exe 与 Setup 里嵌的确实是品牌图，而是那版浅底细描边在浅色任务栏上
   平均亮度差只有 19.5/255（可辨面积 49%），缩到 16px 就融成一块。
   所以这一支不查"图标在不在"，查的是"缩到快捷方式真用的尺寸还认不认得出"，
   并把网页标签页那枚收进同一份源文件。

   跑法：node scripts/_verify_icons.js   （L3 层，会起无头 Chromium）
   改图标流程：编辑 assets/icon.svg → node scripts/render-icon.js → 跑这一支
*/
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const SIZES = [16, 24, 32, 48, 64, 128, 256];
/* 门槛是量出来的，不是拍的：新版 16px 实测 浅栏 76.6%/63.9、深栏 80.1%/135.8；
   被否掉的旧版是 浅栏 49.2%/19.5（对比一项直接不合格）。
   取 60% / 45 是给以后的改动留一点余量，又不至于让"又画成浅底细线"混过去。 */
const MIN_SEEN = 60;
const MIN_CONTRAST = 45;
const BARS = { 浅: "#dfe6ec", 深: "#15191f" };

let checks = 0, red = 0;
const J = (o) => JSON.stringify(o).slice(0, 200);
function ok(name, cond, detail) {
  checks++;
  if (!cond) red++;
  console.log("  " + (cond ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m") + " " + name + (detail ? "  " + detail : ""));
}
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

/* 把 SVG 按某尺寸原生光栅化（与 scripts/render-icon.js 同一套管线） */
async function raster(browser, svg, size) {
  const body = svg.replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"');
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:${size}px;` +
    `height:${size}px;background:transparent}</style></head><body>${body}</body></html>`,
    { waitUntil: "networkidle" });
  await p.waitForTimeout(60);
  const buf = await p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await p.close();
  return buf;
}

/* 叠在任务栏底色上取像素：可辨 = 与底色亮度差 >12/255 的像素占比；对比 = 这些像素的平均亮度差 */
async function measure(page, pngBuf, size, bars) {
  const b64 = pngBuf.toString("base64");
  return page.evaluate(async ({ b64, size, bars }) => {
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = "data:image/png;base64," + b64; });
    const cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    const ctx = cv.getContext("2d");
    const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const out = {};
    for (const [name, hex] of Object.entries(bars)) {
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = hex; ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      const d = ctx.getImageData(0, 0, size, size).data;
      const barL = lum(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
      let seen = 0, sum = 0;
      for (let i = 0; i < size * size; i++) {
        const dl = Math.abs(lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) - barL);
        if (dl > 12) { seen++; sum += dl; }
      }
      out[name] = { seen: +(seen / (size * size) * 100).toFixed(1), contrast: seen ? +(sum / seen).toFixed(1) : 0 };
    }
    return out;
  }, { b64, size, bars });
}

(async () => {
  const svg = fs.readFileSync(path.join(ROOT, "assets", "icon.svg"), "utf8");
  const icoBuf = fs.readFileSync(path.join(ROOT, "assets", "icon.ico"));

  /* ① .ico 结构 */
  const count = icoBuf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    entries.push({
      size: icoBuf[o] || 256, type: icoBuf.readUInt16LE(o + 2),
      bytes: icoBuf.readUInt32LE(o + 8), offset: icoBuf.readUInt32LE(o + 12),
    });
  }
  const have = entries.map((e) => e.size).sort((a, b) => a - b);
  ok("icon.ico 里七档尺寸齐全（16/24/32/48/64/128/256）",
    JSON.stringify(have) === JSON.stringify(SIZES), have.join(","));
  const pngMagic = entries.every((e) => icoBuf.slice(e.offset, e.offset + 4).toString("hex") === "89504e47");
  ok("每个条目都是 PNG 压缩（Vista+ 标准，不是老 BMP 条目）", pngMagic, entries.length + " 条");

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();

  /* ② 小尺寸可辨性：16 / 24 / 32 三档，深浅两种任务栏底色 */
  const report = {};
  for (const size of [16, 24, 32]) {
    const png = await raster(browser, svg, size);
    const m = await measure(page, png, size, BARS);
    report[size] = m;
    for (const bar of Object.keys(BARS)) {
      ok(size + "px 叠" + bar + "色任务栏：可辨 ≥" + MIN_SEEN + "% 且对比 ≥" + MIN_CONTRAST,
        m[bar].seen >= MIN_SEEN && m[bar].contrast >= MIN_CONTRAST,
        "可辨 " + m[bar].seen + "% / 对比 " + m[bar].contrast);
    }
  }

  /* ③ 反向对照：同一把尺子量被否掉的旧版，必须不合格 —— 否则门槛是空的 */
  const oldSvg = cp.execSync("git show HEAD:assets/icon.svg", { cwd: ROOT, encoding: "utf8" });
  const oldPng = await raster(browser, oldSvg, 16);
  const oldM = await measure(page, oldPng, 16, BARS);
  const oldFails = Object.keys(BARS).some((b) => oldM[b].seen < MIN_SEEN || oldM[b].contrast < MIN_CONTRAST);
  ok("反向对照：HEAD 那版图标过不了同一道门槛（说明门槛咬得住）", oldFails,
    "旧版 16px 浅栏 可辨 " + oldM.浅.seen + "% / 对比 " + oldM.浅.contrast);

  /* ④ favicon 与应用图标同源 */
  const favPath = path.join(ROOT, "public", "favicon.svg");
  ok("public/favicon.svg 在（由 render-icon.js 从 icon.svg 原样拷来）", fs.existsSync(favPath));
  const same = fs.existsSync(favPath) && sha(fs.readFileSync(favPath)) === sha(Buffer.from(svg, "utf8"));
  ok("favicon 与 assets/icon.svg 字节同源（改图必须重跑 render-icon.js）", same,
    "favicon " + (fs.existsSync(favPath) ? sha(fs.readFileSync(favPath)) : "缺") + " / icon.svg " + sha(Buffer.from(svg, "utf8")));
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const link = /<link rel="icon"[^>]*href="favicon\.svg"/.test(html);
  const noSecondMark = !/rel="icon"[^>]*href="data:image\/svg\+xml/.test(html);
  ok("index.html 的 favicon 指向 favicon.svg", link, "");
  ok("index.html 里没有第二枚手写图标（data-URI 那版已收掉）", noSecondMark, "");

  /* ⑤ 桌面两处引用都得指到真文件：无边框窗口不指 icon 就退回 Electron 原子（实测过） */
  const main = fs.readFileSync(path.join(ROOT, "electron", "main.js"), "utf8").replace(/\r\n/g, "\n");
  const winIcon = /icon:\s*path\.join\(__dirname,\s*"\.\.",\s*"assets",\s*"icon-1024\.png"\)/.test(main);
  ok("BrowserWindow 显式给了 icon（无边框窗口不会退回 exe 内嵌）", winIcon, "");
  const trayIcon = /assets",\s*"icon-1024\.png"/.test(main.split("function trayIcon")[1] || "");
  ok("托盘图标也走同一张 assets/icon-1024.png", trayIcon, "");
  ok("assets/icon-1024.png 是这次渲染出来的（非空且 >100KB）",
    fs.existsSync(path.join(ROOT, "assets", "icon-1024.png")) && fs.statSync(path.join(ROOT, "assets", "icon-1024.png")).size > 100000,
    fs.existsSync(path.join(ROOT, "assets", "icon-1024.png")) ? fs.statSync(path.join(ROOT, "assets", "icon-1024.png")).size + " 字节" : "缺");

  await browser.close();
  console.log("\n16px 明细 " + J(report[16]));
  console.log("\n共 " + checks + " 条，红 " + red + " 条");
  process.exit(red ? 1 : 0);
})().catch((e) => {
  console.error("图标门禁异常：" + e.stack);
  console.log("\n共 " + (checks + 1) + " 条，红 " + (red + 1) + " 条");
  process.exit(1);
});
