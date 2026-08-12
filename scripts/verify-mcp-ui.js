/* MCP 前端 UI 端到端验证：
   通过真实浏览器驱动「Agent 设置 → MCP」面板：新增 mock 服务器 → 保存 →
   后端连接 → 前端显示已连接 + 发现 echo 工具。
   运行：node scripts/verify-mcp-ui.js （会自动清理 mock 配置） */
"use strict";
const path = require("path");
const http = require("http");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));

const MOCK = path.join(__dirname, "mock-mcp-server.js");
const NODE = process.execPath;
const PORT = 8861;

process.env.PORT = String(PORT);
const server = require("../server/index.js");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function poll(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(400); } return false; }

// 设置弹窗内容可能溢出视口，click 前先滚动目标可见，避免 "outside of the viewport" 重试
async function click(page, sel) {
  const loc = page.locator(sel).first();
  await loc.scrollIntoViewIfNeeded();
  await sleep(120);
  await loc.click();
}

(async () => {
  let browser, page, ok = true;
  const fail = (m) => { ok = false; console.log("  FAIL: " + m); };
  const good = (m) => console.log("  OK: " + m);
  await sleep(1500); // 等服务启动
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

    const base = "http://127.0.0.1:" + PORT;
    await page.goto(base, { waitUntil: "networkidle" });
    // 注册测试用户并写入 token / 跳过引导，重载后 AUTH.token 自动生效
    await page.evaluate(async (ts) => {
      const r = await fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "mcpui" + ts, password: "ui123" }) });
      const j = await r.json();
      if (j.token) localStorage.setItem("cw-user-token", j.token);
      localStorage.setItem("cw-onboarded", "1");
    }, Date.now());
    await page.reload({ waitUntil: "networkidle" });
    await sleep(800);

    // 打开 Agent 设置面板
    await click(page, "#btnAgentSettings");
    await page.waitForSelector("#mcpServerList", { timeout: 5000 });
    const emptyShown = await page.$eval("#mcpServerList", (el) => el.textContent.includes("尚未配置"));
    if (!emptyShown) fail("未显示空状态"); else good("空状态显示正常");

    // 新增服务器
    await click(page, "#mcpAdd");
    await page.waitForSelector("#mcpForm", { state: "visible", timeout: 5000 });
    await page.fill("#mcpName", "mock");
    await page.fill("#mcpCommand", NODE);
    await page.fill("#mcpArgs", MOCK);
    await click(page, "#mcpFormSave");
    await sleep(300);
    const rowCount = await page.$$eval(".mcp-server-row", (els) => els.length);
    if (rowCount !== 1) fail("新增后列表应有 1 行，实际 " + rowCount); else good("新增后列表显示 1 行（本地副本）");

    // 保存配置
    await click(page, "#mcpSave");
    const synced = await poll(async () => {
      const r = await page.evaluate(async () => (await fetch("/api/mcp").then((x) => x.json())));
      const s = (r.configured || []).find((x) => x.name === "mock");
      return s && s.command === NODE;
    }, 8000);
    if (!synced) fail("保存后后端未持久化 mock 配置"); else good("保存后后端持久化 mock 配置");

    // 等待前端状态变为「已连接」并发现 echo 工具
    const ready = await poll(async () => {
      const r = await page.evaluate(async () => (await fetch("/api/mcp").then((x) => x.json())));
      const s = (r.servers || []).find((x) => x.name === "mock");
      return s && s.status === "ready" && s.tools.some((t) => t.name === "echo");
    }, 15000);
    if (!ready) fail("mock 未就绪或未发现 echo 工具"); else good("前端/后端均确认 mock 已连接，发现 echo 工具");

    // 前端徽标应为「已连接」
    const badge = await page.$eval(".mcp-badge", (el) => el.textContent).catch(() => "");
    if (!badge.includes("已连接")) fail("前端状态徽标未显示已连接: " + badge); else good("前端状态徽标: " + badge);

    if (errors.length) fail("页面报错: " + errors.slice(0, 3).join(" | ")); else good("无页面 JS 错误");

    // 清理：移除 mock 配置
    await page.evaluate(async () => {
      await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", servers: [] }) });
    });
    good("已清理 mock 配置");
  } catch (e) {
    fail("异常: " + e.message);
  } finally {
    if (browser) await browser.close();
  }
  console.log(ok ? "\nMCP UI OK=true" : "\nMCP UI OK=false");
  process.exit(ok ? 0 : 1);
})();
