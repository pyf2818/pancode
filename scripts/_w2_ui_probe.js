/* W2 Experts UI 探针（Playwright headless Chromium）
   验证链路：工作区写入 .pancode/experts/ui-probe.md → 打开 Agent 设置面板 →
   agmPersona select 动态渲染「专家包」optgroup（选项 = 专家名 · 项目级）→ 截图
   产物：scripts/_verify_out/w2_settings.png */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = "8895";
const WS = "E:/独立目录/_w2ui_ws";
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
  const uname = "w2ui_" + Date.now();
  const j = await (await fetch(BASE + "/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: uname, password: "test1234" }) })).json();
  const token = j.token || "";

  /* 预置两个专家包（项目级 + 覆盖内置） */
  const expDir = path.join(WS, ".pancode", "experts");
  fs.mkdirSync(expDir, { recursive: true });
  fs.writeFileSync(path.join(expDir, "ui-probe.md"),
    "---\nname: UI探针专家\ndescription: 设置面板渲染验证\n---\n你是 UI 探针专家。\n\n验证 optgroup 渲染。\n", "utf8");
  fs.writeFileSync(path.join(expDir, "fullstack.md"),
    "---\nname: 定制全栈\ndescription: 用户级覆盖示例（放项目级演示）\n---\n你是被定制的全栈工程师。\n", "utf8");

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

  /* 打开 Agent 设置面板 */
  await page.click("#btnAgentSettings");
  await page.waitForSelector("#agentModal", { state: "visible", timeout: 8000 });
  await page.waitForSelector('#agentModal optgroup[data-dyn="experts"] option', { timeout: 8000 }).catch(() => {});

  const probe = await page.evaluate(() => {
    const og = document.querySelector('#agentModal optgroup[data-dyn="experts"]');
    const opts = og ? Array.from(og.querySelectorAll("option")).map((o) => ({ v: o.value, t: o.textContent })) : [];
    const builtin = Array.from(document.querySelectorAll('#agentModal option[value="fullstack"], #agentModal option[value="frontend"], #agentModal option[value="backend"], #agentModal option[value="custom"]')).length;
    return { ogLabel: og ? og.getAttribute("label") : null, opts, builtin };
  });
  t("专家包 optgroup 已渲染（label=专家包）", probe.ogLabel === "专家包", JSON.stringify(probe));
  t("项目级专家选项存在（UI探针专家 · 项目级）", probe.opts.some((o) => o.v === "ui-probe" && o.t.includes("UI探针专家")), JSON.stringify(probe.opts));
  t("内置静态 option 未受影响（4 个）", probe.builtin === 4, String(probe.builtin));
  t("custom 仍在（optgroup 之后）", await page.evaluate(() => {
    const sel = document.querySelector("#agmPersona");
    const og = sel.querySelector('optgroup[data-dyn="experts"]');
    const custom = sel.querySelector('option[value="custom"]');
    if (!og || !custom) return false;
    return !!(og.compareDocumentPosition(custom) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));

  /* 选中专家并截图 */
  await page.selectOption("#agmPersona", "ui-probe");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "w2_settings.png") });
  t("selectOption 选中 ui-probe 生效", (await page.$eval("#agmPersona", (el) => el.value)) === "ui-probe");

  t("无页面 JS 错误", errors.length === 0, errors.join(" || ").slice(0, 300));

  await browser.close();
  try { fs.rmSync(path.join(expDir, "ui-probe.md"), { force: true }); } catch (e) {}
  try { fs.rmSync(path.join(expDir, "fullstack.md"), { force: true }); } catch (e) {}
  console.log("\n=== W2 UI probe: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
