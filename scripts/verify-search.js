/* pancode 语义代码检索真实渲染验证（Playwright headless Chromium）
   1) 同进程拉起服务端，工作区指向仓库根（索引覆盖真实源码，BM25 模式）
   2) 注册+登录测试账号，自动跳过登录弹窗
   3) 打开搜索侧栏 → 切「语义」模式 → 点「构建索引」→ 等待「已构建」
   4) 输入自然语言查询 → 等待 .sem-result 出现 → 截图核对
   产物：scripts/_verify_out/search_build.png、scripts/_verify_out/search.png
*/
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = process.env.PORT || "8823";
// 测试工作区用较小的 server/ 目录：索引覆盖真实源码（lsp-bridge 等），且不含 node_modules，避免巨型 hello 快照拖垮事件循环
process.env.CURSORWEB_WORKSPACE = process.env.CURSORWEB_WORKSPACE || path.resolve(__dirname, "..", "server");
require("../server/index.js");   // 启动服务端（同进程）

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

  // 启动就绪轮询：确保 express 已在 127.0.0.1:PORT 响应（工作区挂载可能略慢）
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(base + "/"); if (r.ok) break; } catch (e) {}
    await new Promise((res) => setTimeout(res, 500));
  }
  await page.goto(base + "/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);

  // 防御性隐藏任何可能拦截点击的弹窗（首次引导 / 登录）
  await page.evaluate(() => {
    ["onboardModal", "authModal"].forEach((id) => { const m = document.getElementById(id); if (m) m.style.display = "none"; });
  });

  // 打开搜索侧栏
  await page.click('button[data-view="search"]');
  await page.waitForTimeout(300);
  // 切到语义模式
  await page.click("#searchModeSem");
  await page.waitForTimeout(300);
  // 构建索引
  await page.click("#btnBuildIndex");
  await page.waitForFunction(() => /已构建/.test((document.getElementById("semStatus") || {}).textContent || ""), { timeout: 40000 }).catch(() => {});
  const builtStatus = await page.$eval("#semStatus", (e) => e.textContent).catch(() => "");
  await page.screenshot({ path: path.join(OUT, "search_build.png") });
  console.log("built status:", builtStatus);

  // 输入自然语言查询（BM25 模式按英文 token 命中，仓库内多文件含 websocket/proxy/language server）
  await page.fill("#searchInput", "websocket proxy language server");
  await page.waitForFunction(() => document.querySelectorAll(".sem-result").length > 0, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "search.png") });

  const diag = await page.evaluate(() => {
    const mode = (document.querySelector(".sr-count") || {}).textContent || "";
    const items = Array.from(document.querySelectorAll(".sem-result")).map((el) => {
      const p = (el.querySelector(".sem-path") || {}).textContent || "";
      const rg = (el.querySelector(".sem-range") || {}).textContent || "";
      return p + ":" + rg;
    });
    return { mode, count: items.length, first: items[0] || "", all: items.slice(0, 5) };
  });
  console.log("DIAG " + JSON.stringify(diag) + " errors=" + JSON.stringify(errors.slice(0, 8)));

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("VERIFY_FAIL", e); process.exit(1); });
