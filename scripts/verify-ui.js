/* pancode UI 真实渲染验证（Playwright headless Chromium）
   1) 同进程拉起服务端
   2) 注册+登录一个测试账号，自动跳过登录弹窗
   3) 无头加载 Web 应用（与 Electron 同内核），截图主 IDE
   4) 用 mock 数据驱动 Diff 审阅面板，截图核对 hunk 级接受/拒绝
   产物：scripts/_verify_out/main.png、scripts/_verify_out/patch.png
*/
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = process.env.PORT || "8822";
require("../server/index.js");   // 启动服务端（同进程）

const PORT = process.env.PORT;
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

const MOCK = {
  convId: "verify",
  files: [
    {
      path: "src/calc.py", lang: "python", add: 1, del: 0,
      original: "def add(a, b):\n    return a + b\n",
      hunks: [{ index: 0, old_string: "def add(a, b):\n    return a + b\n", new_string: "def add(a, b):\n    # 支持字符串拼接\n    return a + b\n", accepted: true }],
    },
    {
      path: "src/util.js", lang: "javascript", add: 2, del: 1,
      original: "function greet(){\n  return 'hi';\n}",
      hunks: [
        { index: 0, old_string: "return 'hi';", new_string: "return 'hello ' + name;", accepted: true },
        { index: 1, old_string: "function greet(){", new_string: "function greet(name){", accepted: false },
      ],
    },
  ],
};

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

  if (token) await page.addInitScript((t) => localStorage.setItem("cw-user-token", t), token);

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1500);

  await page.screenshot({ path: path.join(OUT, "main.png") });
  console.log("shot: main.png");

  // 登录弹窗可能仍然短暂出现；若存在则点击登录按钮（已经通过 localStorage 自动登录）
  const loginModal = await page.$$("#loginModal").catch(() => []);
  if (loginModal.length) {
    await page.evaluate(() => { const b = document.querySelector("#loginModal button.primary"); if (b) b.click(); });
    await page.waitForTimeout(800);
  }

  await page.evaluate((m) => window.openPatchReview(m), MOCK);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "patch.png") });
  console.log("shot: patch.png");

  const diag = await page.evaluate(() => {
    const modal = document.getElementById("patchModal");
    const visible = modal && getComputedStyle(modal).display !== "none";
    const files = document.querySelectorAll(".patch-file").length;
    const hunks = document.querySelectorAll(".phk").length;
    const checked = Array.from(document.querySelectorAll(".phk input[type=checkbox]")).filter((x) => x.checked).length;
    return { visible, files, hunks, checked };
  });
  console.log("DIAG " + JSON.stringify(diag) + " errors=" + JSON.stringify(errors.slice(0, 8)));

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error("VERIFY_FAIL", e); process.exit(1); });
