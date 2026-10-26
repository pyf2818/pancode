// 渲染 README 顶部 Banner：assets/banner.png（2560x800，2x 高清）
// 用法：node scripts/_render_banner.js
const path = require('path');
const { chromium } = require('playwright');

const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1280px; height:400px; overflow:hidden; }
  #banner {
    position:relative; width:1280px; height:400px;
    background:
      radial-gradient(ellipse 900px 420px at 50% 42%, #232330 0%, #15151d 45%, #0b0b10 100%);
    font-family:"Microsoft YaHei","PingFang SC",sans-serif;
    color:#f0ece2;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
  }
  /* 细网格 */
  #banner::before {
    content:""; position:absolute; inset:0;
    background-image:
      linear-gradient(rgba(255,255,255,0.030) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.030) 1px, transparent 1px);
    background-size:64px 64px;
    mask-image:radial-gradient(ellipse 760px 340px at 50% 45%, rgba(0,0,0,.9), transparent 78%);
    -webkit-mask-image:radial-gradient(ellipse 760px 340px at 50% 45%, rgba(0,0,0,.9), transparent 78%);
  }
  /* 顶部氛围光 */
  #banner::after {
    content:""; position:absolute; inset:0;
    background:radial-gradient(ellipse 420px 90px at 50% 8%, rgba(214,196,150,0.10), transparent 70%);
  }
  .dot {
    position:absolute; top:88px; left:50%; transform:translateX(-50%);
    width:7px; height:7px; border-radius:50%;
    background:#e8dcc0;
    box-shadow:0 0 10px 3px rgba(232,220,192,0.55), 0 0 28px 10px rgba(232,220,192,0.18);
  }
  .title {
    position:relative; z-index:2;
    margin-top:34px;
    font-family:Georgia,"Times New Roman","Microsoft YaHei",serif;
    font-size:84px; font-weight:400;
    letter-spacing:30px; text-indent:30px;
    color:#f5f1e6;
    text-shadow:0 2px 30px rgba(0,0,0,0.65);
  }
  .subtitle {
    position:relative; z-index:2; margin-top:16px;
    font-size:13px; letter-spacing:10px; text-indent:10px;
    color:#8f8b80; font-weight:300;
  }
  .tagline {
    position:relative; z-index:2; margin-top:22px;
    font-size:16.5px; letter-spacing:3px;
    color:#b8b2a4; font-weight:300;
  }
  .corner { position:absolute; z-index:2; font-size:10.5px; letter-spacing:4px; color:#5d5a54; font-weight:300; }
  .c-tl { top:30px; left:40px; }
  .c-tr { top:30px; right:40px; }
  .c-bl { bottom:26px; left:40px; }
  .c-br { bottom:26px; right:40px; }
  .sep { color:#3d3b38; margin:0 8px; }
</style></head>
<body>
<div id="banner">
  <div class="dot"></div>
  <div class="title">PANCODE</div>
  <div class="subtitle">LOCAL-FIRST · AI CODING WORKBENCH</div>
  <div class="tagline">真实 · 高效 · 可控 · 越用越懂你的 AI 编程伙伴</div>
  <div class="corner c-tl">FORGE<span class="sep">/</span>锻造</div>
  <div class="corner c-tr">EVOLVE<span class="sep">/</span>进化</div>
  <div class="corner c-bl">VERIFY<span class="sep">/</span>验收</div>
  <div class="corner c-br">01 · AGENT RUNTIME</div>
</div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 400 }, deviceScaleFactor: 2 });
  await page.setContent(HTML, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const out = path.join(__dirname, '..', 'assets', 'banner.png');
  await page.locator('#banner').screenshot({ path: out });
  await browser.close();
  console.log('banner written:', out);
})();
