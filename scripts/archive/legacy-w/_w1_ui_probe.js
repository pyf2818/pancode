/* W1 Skills UI 探针（Playwright headless Chromium）
   验证链路：导入 P0 skill JSON → 安全审计 403 → showConfirm 弹审计报告 →
   用户确认(force) → 导入成功 → 列表 riskBadge(.sk-risk-p0) 渲染
   产物：scripts/_verify_out/w1_confirm.png、w1_list.png */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = "8894";
process.env.CURSORWEB_WORKSPACE = "E:/独立目录/_w1ui_ws";
require("../server/index.js");

const PORT = process.env.PORT;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const t = (n, c) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.error("  ✗ " + n); } };

(async () => {
  /* 注册拿 token */
  const uname = "w1ui_" + Date.now();
  const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: uname, password: "test1234" }) };
  /* 坑：register 成功即返回 token；对刚注册用户再 login 反而报"用户名或密码错误"——直接用 register 的 token */
  const j = await (await fetch(BASE + "/api/auth/register", opts)).json();
  const token = j.token || "";

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => {
    const msg = e.message || "";
    /* 已知噪音：Playwright 在 about:blank 初始导航的 sandboxed 上下文跑 init script 触发的 localStorage 报错（真实页面不受影响） */
    if (msg.includes("sandboxed and lacks the 'allow-same-origin'")) return;
    errors.push("PAGEERROR: " + msg);
  });
  if (token) await page.addInitScript((tk) => { localStorage.setItem("cw-user-token", tk); localStorage.setItem("cw-onboarded", "1"); }, token);

  await page.goto(BASE + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);

  /* 准备 P0 skill JSON（含 eval + child_process，双 P0 命中） */
  const p0File = path.join(OUT, "_w1_p0_skill.json");
  fs.writeFileSync(p0File, JSON.stringify({
    name: "probe-p0-skill",
    description: "UI 探针用危险 skill",
    category: "test",
    body: '执行系统命令：require("child_process").exec(cmd)，并 eval(userInput) 动态执行',
  }), "utf8");

  /* 诊断钩子：记录 market POST 响应 */
  await page.evaluate(() => {
    window.__mktResp = null;
    const of = window.fetch;
    window.fetch = async (u, o) => {
      const r = await of(u, o);
      if (String(u).includes("/api/skills/market") && o && o.method === "POST") {
        try { window.__mktResp = { status: r.status, body: await r.clone().text() }; } catch (e) {}
      }
      return r;
    };
  });

  /* 触发导入（evaluate 点击绕过面板可见性；filechooser 仍由真实 inp.click() 触发） */
  const chooserP = page.waitForEvent("filechooser", { timeout: 10000 });
  await page.evaluate(() => document.getElementById("btnImportSkill").click());
  const chooser = await chooserP;
  await chooser.setFiles(p0File);

  /* showConfirm 弹出审计报告 */
  await page.waitForTimeout(2500);
  const mkt = await page.evaluate(() => window.__mktResp);
  console.log("  (diag) market POST resp:", mkt && mkt.status, mkt && String(mkt.body).slice(0, 160));
  await page.waitForSelector("#confirmModal", { state: "visible", timeout: 8000 });
  const cTitle = await page.textContent("#confirmTitle");
  const cMsg = await page.textContent("#confirmMsg");
  t("P0 导入触发 showConfirm", true);
  t("确认框标题含「P0 风险」", /P0/.test(cTitle));
  t("审计报告列出 child_process 发现", /child_process/.test(cMsg));
  t("审计报告列出 eval 发现", /eval/.test(cMsg));
  await page.screenshot({ path: path.join(OUT, "w1_confirm.png") });

  /* 确认 → force 重发 */
  await page.click("#confirmOk");
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.loadSkills && loadSkills());
  await page.waitForTimeout(800);

  /* 列表渲染 riskBadge */
  const hasSkill = await page.evaluate(() => {
    const names = Array.from(document.querySelectorAll("#skillsList .skill-name")).map((e) => e.textContent);
    return names.some((n) => n.includes("probe-p0-skill"));
  });
  t("确认后 skill 出现在市场列表", hasSkill);
  const badge = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("#skillsList .skill-item")).find((e) => e.textContent.includes("probe-p0-skill"));
    if (!el) return null;
    const b = el.querySelector(".sk-risk-p0");
    return b ? b.textContent : null;
  });
  t("riskBadge .sk-risk-p0 渲染且文本为 P0", badge === "P0");
  /* 切到 Skills 面板做视觉验证截图 */
  await page.evaluate(() => { const b = document.querySelector('.ab-btn[data-view="skills"]'); if (b) b.click(); });
  await page.waitForTimeout(800);
  const panelVisible = await page.evaluate(() => {
    const el = document.getElementById("skillsList");
    return el && el.offsetParent !== null && el.querySelectorAll(".skill-item").length > 0;
  });
  t("Skills 面板切换后可见且有 skill 项", panelVisible);
  await page.screenshot({ path: path.join(OUT, "w1_list.png") });

  /* P1 skill 直接过（无确认框） */
  const p1File = path.join(OUT, "_w1_p1_skill.json");
  fs.writeFileSync(p1File, JSON.stringify({ name: "probe-p1-skill", description: "联网", category: "test", body: "await fetch(url) 获取数据" }), "utf8");
  const chooser2P = page.waitForEvent("filechooser", { timeout: 10000 });
  await page.evaluate(() => document.getElementById("btnImportSkill").click());
  const chooser2 = await chooser2P;
  await chooser2.setFiles(p1File);
  await page.waitForTimeout(1500);
  const confirmVisible = await page.evaluate(() => { const m = document.getElementById("confirmModal"); return m && m.style.display === "flex"; });
  t("P1 导入不弹确认框（直接入库）", !confirmVisible);
  const p1badge = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("#skillsList .skill-item")).find((e) => e.textContent.includes("probe-p1-skill"));
    if (!el) return null;
    const b = el.querySelector(".sk-risk-p1");
    return b ? b.textContent : null;
  });
  t("P1 riskBadge .sk-risk-p1 渲染", p1badge === "P1");

  /* 清理：删两个探针 skill */
  await page.evaluate(async () => {
    const r = await fetch("/api/skills/all").then((x) => x.json());
    for (const s of r.skills || []) {
      if (String(s.name).startsWith("probe-")) await fetch("/api/skills/market/" + s.id, { method: "DELETE" });
    }
  });
  t("页面无 JS 错误", errors.length === 0);

  try { fs.unlinkSync(p0File); fs.unlinkSync(p1File); } catch (e) {}
  await browser.close();
  console.log(`\n=== W1 UI 探针: ${pass} passed, ${fail} failed ===`);
  if (errors.length) console.log("JS errors:", errors.slice(0, 3));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
