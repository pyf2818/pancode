/* ============================================================
   截图在界面里真可见的验收（tool.image → /api/shot → <img>）。

   为什么必须有这条：功能断言全绿而画面是黑的，这个项目已经栽过一次。
   所以这里不查"DOM 里有没有 img"就算完，而是查**解码后的真实像素**：
   红底页面截图 → 落进 shots 目录 → 登录态 fetch 成 blob → 贴进卡片
   → canvas 画出来读中心像素，必须是红的。
   链路任何一环断（路径拼错 / 路由没注册 / 鉴权没过 / CSS 让它 0 尺寸 / 图没解码）都会红。

   顺带钉住两条真实踩过的坑：
   · /api/* 全过登录闸门，而令牌只认请求头 —— <img src> 那条路压根带不上头，
     所以前端是先 fetch 成 blob 再给 objectURL。探针必须先注册一个用户，
     否则一切 401，看起来像"图没画出来"。（写这条探针时就是先撞上这个 401 的。）
   · 取不回来的图要留占位，不能退化成一片空白。
   ============================================================ */
"use strict";
const path = require("path");
const { spawn } = require("child_process");

const sb = require("./_sandbox").create({ tag: "shotui" });
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 8863);
const USER = "shotui-user";
const PASS = "shotui-pass-123";
let pass = 0; let fail = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name + (detail ? "  \x1b[90m" + detail + "\x1b[0m" : "")); }
  else { fail++; fails.push(name + (detail ? " —— " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? "  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, ["server/index.js"], {
  cwd: path.join(__dirname, ".."),
  env: sb.env({ PORT: String(PORT), AGENT_FAST: "1", CURSORWEB_ENGINE: "demo", NODE_NO_WARNINGS: "1" }),
  stdio: ["ignore", "pipe", "pipe"],
});
let childLog = "";
child.stdout.on("data", (d) => { childLog += d; });
child.stderr.on("data", (d) => { childLog += d; });

async function waitServer(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(base + "/api/health")).ok) return true; } catch (e) { /* 还没起 */ }
    await sleep(300);
  }
  return false;
}

let browser;
(async () => {
  if (!await waitServer(25000)) { console.log(childLog.slice(-2000)); throw new Error("服务端没起来（端口 " + PORT + "）"); }

  /* 注册一个用户拿 userToken：不登录的话 /api/shot 一律 401，
     而 401 在这条链路上的表现和"图没画出来"一模一样，极易误诊。 */
  const reg = await (await fetch(base + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS }),
  })).json();
  const token = reg && reg.token;
  ok("沙箱里注册到用户（探针要有登录态）", !!token, JSON.stringify(reg).slice(0, 90));

  /* 先做一张内容已知的真 PNG：纯红 600×400。
     尺寸刻意做大：max-width/max-height 只收不放，20×20 的图只会按 20×20 画，
     那测不出"缩略 + 点击放大"这两条真实行为（第一版就是拿 20×20 断言，红了才发现是自己错了）。 */
  const shots = require("../server/computer/shots");
  const grab = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const gp = await grab.newPage({ viewport: { width: 600, height: 400 } });
  await gp.setContent("<body style='margin:0;background:#ff0000'></body>");
  const png = await gp.screenshot({ clip: { x: 0, y: 0, width: 600, height: 400 } });
  await grab.close();
  const written = shots.writeBuffer(png, "uiConv", "红底验收图");
  ok("截图落进数据根的 shots 目录（不在工作区）", fs_ok(written), written.rel);

  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const ctx = await browser.newContext();
  /* 令牌写进 localStorage 再加载：前端 checkAuth 会读它并填 AUTH.token，
     patchFetch 才给 /api/* 请求注入 Bearer 头。 */
  await ctx.addInitScript(([tk, un]) => {
    localStorage.setItem("cw-user-token", tk);
    localStorage.setItem("cw-user-name", un);
  }, [token, USER]);
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE " + m.text()); });
  await page.goto(base + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => typeof window.handleEvent === "function", null, { timeout: 15000 });

  /* 页面确实带着登录态（404 = 过了闸门但文件不存在；401 = 没带上令牌） */
  const authState = await page.evaluate(async () => (await fetch("/api/shot?name=nope.png")).status);
  ok("页面带着可用令牌访问 /api/shot（404 而不是 401）", authState === 404, String(authState));

  const sent = await page.evaluate((rel) => {
    try {
      window.handleEvent({ type: "tool.start", id: "shotUI1", kind: "tool", name: "浏览器·截图", target: "整页", round: 1 });
      window.handleEvent({ type: "tool.image", id: "shotUI1", path: rel });
      window.handleEvent({ type: "tool.end", id: "shotUI1", ok: true, label: "已截图" });
      /* 第二张：指向一个不存在的名字，验"取不回来要留占位，不能一片空白" */
      window.handleEvent({ type: "tool.start", id: "shotUI2", kind: "tool", name: "桌面·截图", target: "窗口", round: 2 });
      window.handleEvent({ type: "tool.image", id: "shotUI2", path: "uiConv/已被清理.png" });
      window.handleEvent({ type: "tool.end", id: "shotUI2", ok: true, label: "已截图" });
      return { cards: document.querySelectorAll(".tool-card").length, threw: null };
    } catch (e) { return { cards: 0, threw: String(e && e.message || e) }; }
  }, written.rel);
  ok("事件喂给 handleEvent 后卡片建起来了", sent.cards >= 2 && !sent.threw, JSON.stringify(sent));
  await page.waitForFunction(() => {
    const i = document.querySelector(".tool-shots img.t-shot");
    return !!i && (i.naturalWidth > 0 || i.classList.contains("t-shot-missing"));
  }, null, { timeout: 10000 }).catch(() => {});

  const geo = await page.evaluate(() => {
    const img = document.querySelector(".tool-shots img.t-shot");
    if (!img) return { missing: true };
    const cs = getComputedStyle(img);
    const box = img.getBoundingClientRect();
    const card = img.closest(".tool-card");
    return {
      natural: [img.naturalWidth, img.naturalHeight],
      rect: [Math.round(box.width), Math.round(box.height)],
      inCard: !!card,
      /* 卡片没展开时图是否仍可见 —— 这是"图挂卡片上而不是塞进折叠的 .tool-body"那条设计的判据 */
      visibleWhileClosed: !!(card && !card.classList.contains("open") && box.width > 0 && img.offsetParent !== null),
      isBlob: (img.getAttribute("src") || "").indexOf("blob:") === 0,
    };
  });
  ok("卡片上长出了截图", !geo.missing, JSON.stringify(geo).slice(0, 110));
  ok("走的是 blob:（登录态 fetch 的结果，而不是裸 /api/shot 的 401）", geo.isBlob === true, String(geo.isBlob));
  ok("图片真的解码成功（naturalWidth>0，600×400 的原始尺寸）", !!geo.natural && geo.natural[0] === 600 && geo.natural[1] === 400, JSON.stringify(geo.natural));
  ok("默认按缩略态收在 240×168 之内（不撑爆聊天流）", !!geo.rect && geo.rect[0] > 100 && geo.rect[0] <= 242 && geo.rect[1] <= 170, JSON.stringify(geo.rect));
  ok("卡片折叠态时图仍然可见", geo.visibleWhileClosed === true, JSON.stringify(geo).slice(0, 90));

  /* 像素级验收：把 <img> 画到 canvas 上读中心点 */
  const px = await page.evaluate(() => new Promise((resolve) => {
    const img = document.querySelector(".tool-shots img.t-shot");
    if (!img) return resolve("no-img");
    if (!img.naturalWidth) return resolve("not-decoded");
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    resolve([d[0], d[1], d[2], d[3]]);
  }));
  ok("解码后的中心像素是红的（整条链路真把图送到了眼里）", Array.isArray(px) && px[0] > 200 && px[1] < 60 && px[2] < 60 && px[3] > 200, JSON.stringify(px));

  const missing = await page.evaluate(() => {
    const imgs = document.querySelectorAll(".tool-shots img");
    let placeholder = false;
    imgs.forEach((i) => { if (i.classList.contains("t-shot-missing")) placeholder = true; });
    return { total: imgs.length, placeholder };
  });
  ok("取不回来的截图留了占位（不是一片空白）", missing.total >= 2 && missing.placeholder, JSON.stringify(missing));

  const wide = await page.evaluate(async () => {
    const img = document.querySelector(".tool-shots img.t-shot");
    const before = Math.round(img.getBoundingClientRect().width);
    img.click();
    await new Promise((r) => setTimeout(r, 150));
    return { before, after: Math.round(img.getBoundingClientRect().width), wide: !!img.closest(".tool-card").classList.contains("shotwide") };
  });
  ok("点一下变宽（桌面态不能用 target=_blank，那会开新窗口）", wide.wide && wide.after > wide.before, JSON.stringify(wide));
  const back = await page.evaluate(async () => {
    const img = document.querySelector(".tool-shots img.t-shot");
    img.click();
    await new Promise((r) => setTimeout(r, 150));
    return Math.round(img.getBoundingClientRect().width);
  });
  ok("再点一次缩回原尺寸", Math.abs(back - wide.before) <= 2, back + " vs " + wide.before);

  /* 路由边界：穿越与绝对路径都不能把 shots 目录之外的东西吐出去 */
  const codes = await page.evaluate(async () => {
    const q = async (n) => (await fetch("/api/shot?name=" + encodeURIComponent(n))).status;
    return { traversal: await q("../../server/config.js"), upup: await q("a/../../../etc/passwd"), abs: await q("C:\\Windows\\win.ini"), missing: await q("uiConv/不存在.png") };
  });
  ok(".. 逃逸被拒（404）", codes.traversal === 404, String(codes.traversal));
  ok("多层 .. 逃逸被拒（404）", codes.upup === 404, String(codes.upup));
  ok("绝对路径被拒（404）", codes.abs === 404, String(codes.abs));
  ok("不存在的名字 404", codes.missing === 404, String(codes.missing));
  const goodStatus = await (await fetch(base + "/api/shot?name=" + encodeURIComponent(written.rel), { headers: { Authorization: "Bearer " + token } })).status;
  ok("带令牌的正向请求 200", goodStatus === 200, String(goodStatus));

  /* 只判我这条链路上的错：应用里另有一处既存的 sandboxed iframe 读 localStorage 的报错
     （预览面板的 srcdoc  iframe 没有 allow-same-origin），那与截图卡片无关，
     混在一起断"页面零报错"就会长期红着一个不属于本轮的错。 */
  const mine = errs.filter((e) => /shot|blob|tool\.image|t-shot/i.test(e));
  ok("截图链路自身没有报错", mine.length === 0, mine.slice(0, 2).join(" | "));
  ok("（既存问题留痕，不在本轮修）预览 iframe 读 localStorage 会抛", errs.some((e) => /sandboxed/.test(e)),
    errs.filter((e) => /sandboxed/.test(e)).length + " 条");

  console.log("\n\x1b[1m截图可见性验收：\x1b[0m " + pass + " 通过 / " + fail + " 失败");
  if (fails.length) console.log("\x1b[31m失败项：\x1b[0m\n  - " + fails.join("\n  - "));
  await browser.close(); browser = null;
  child.kill();
  await sleep(500);
  sb.cleanup();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\x1b[31m探针异常：\x1b[0m" + e.stack);
  try { if (browser) await browser.close(); } catch (x) { /* 已经在崩了 */ }
  child.kill();
  await sleep(500);
  sb.cleanup();
  process.exit(1);
});

function fs_ok(w) {
  try { return require("fs").existsSync(w.abs) && w.rel.indexOf("uiConv/") === 0; } catch (e) { return false; }
}
