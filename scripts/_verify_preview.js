/* ============================================================
   文件预览验收（#42：点「预览」右侧整块白、界面点不动）

   这条链路以前没有任何探针覆盖过：预览面板的渲染跑在渲染进程主线程上，
   旧版 renderMarkdown 遇到 `#标题`（井号后没空格）这类行会死循环，
   srcdoc 根本没赋值 → 面板一片白 + 整个界面钉死。读代码看不出来，必须真点一次。

   断言盯三件事：
   1. 真 UI 路径：侧栏点文件 → 点「预览」按钮 → 面板真的长出内容（不是 evaluate 直接调函数）。
   2. 点完还活着：拿一个"会死循环"的文件点完预览，紧接着让页面算一次算术，
      超时即红。这一条是这次事故的正证——旧版在这里必然卡死。
   3. 内容真渲染：标题/代码块/GFM 表格都要在 srcdoc 里见到对应标签，
      光"srcdoc 非空"不够（旧版把表格当段落原样吐出来，看着还是"没显示内容"）。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/* 这份 README 故意把当年触发死循环的三种行都放进去：井号后没空格、单独一个 #、两个短横。 */
const README = [
  "# Todo App",
  "",
  "一个待办事项 REST 服务。",
  "",
  "#没空格的标题也算正文",
  "",
  "#",
  "",
  "-- 这不是分隔线",
  "",
  "## 快速开始",
  "",
  "```bash",
  "npm install",
  "npm run dev",
  "```",
  "",
  "## API 摘要",
  "",
  "| 方法 | 路径 | 说明 |",
  "| --- | :---: | ---: |",
  "| GET | /todos | 列表 |",
  "| POST | /todos | 新建 |",
  "",
  ">提示：需要 Node 18+",
  "",
  "- [x] 增删改查",
  "- [ ] 持久化",
  "",
].join("\n");

const PAGE_HTML = "<!DOCTYPE html><html><head><meta charset='utf-8'></head>" +
  "<body style='margin:0;font-family:sans-serif'><h1 id='t'>静态页预览</h1><p>正文</p></body></html>";

const sb = require("./_sandbox").create({
  tag: "preview",
  wsFiles: { "README.md": README, "page.html": PAGE_HTML },
});

const { chromium } = require("playwright");
const PORT = Number(process.env.PORT || 8858);
const REPO = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

const child = spawn(process.execPath, ["server/index.js"], {
  cwd: REPO,
  env: sb.env({ PORT: String(PORT), AGENT_FAST: "1", CURSORWEB_ENGINE: "demo", NODE_NO_WARNINGS: "1" }),
  stdio: ["ignore", "pipe", "pipe"],
});
let childLog = "";
child.stdout.on("data", (d) => { childLog += d; });
child.stderr.on("data", (d) => { childLog += d; });

async function waitServer(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* 预览面板当前状态：几何 + iframe 里那份文档（srcdoc 就是浏览器要画的东西） */
const readPanel = (page) => page.evaluate(() => {
  const hp = document.getElementById("htmlPreview");
  const fr = document.getElementById("hpFrame");
  const box = (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
  return {
    on: typeof previewOn === "undefined" ? null : previewOn,
    disp: getComputedStyle(hp).display,
    panel: box(hp), frame: box(fr),
    srcdoc: fr.getAttribute("srcdoc") || "",
    zoomTxt: (document.getElementById("hpZoomTxt") || {}).textContent || "",
  };
});

(async () => {
  if (!await waitServer(20000)) { console.log(childLog.slice(-2000)); throw new Error("服务端没起来（端口 " + PORT + "）"); }
  const base = `http://127.0.0.1:${PORT}`;
  const user = "preview_" + Date.now();
  const authOpts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: "test1234" }) };
  await fetch(base + "/api/auth/register", authOpts).catch(() => {});
  const token = await fetch(base + "/api/auth/login", authOpts).then((r) => r.json()).then((j) => j.token || "").catch(() => "");

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  if (token) await page.addInitScript((t) => {
    try { localStorage.setItem("cw-user-token", t); localStorage.setItem("cw-onboarded", "1"); } catch (e) {}
  }, token);
  await page.goto(base + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => !!document.getElementById("chatInputBox"), { timeout: 20000 });
  await page.waitForTimeout(1200);

  section("① 侧栏点开 README.md，预览按钮出现");
  await page.click("#btnModeEditor");
  await page.waitForTimeout(500);
  await page.locator("#fileTree .ft-item", { hasText: "README.md" }).first().click();
  await page.waitForTimeout(700);
  ok("标签页打开了 README.md", await page.evaluate(() => state.activeFile) === "README.md",
    await page.evaluate(() => state.activeFile));
  ok("可预览的文件才给「预览」按钮", !!(await page.$("#bcPreview")));

  section("② 点「预览」：面板要长出内容，而且点完界面还活着");
  await page.click("#bcPreview");
  /* 旧版在这里死循环：主线程被占住，后面任何一次 evaluate 都会超时。
     所以这个 4s 上限既是等待也是判据——它给"渲染函数返回了"兜底。 */
  let alive = true;
  try { await page.waitForFunction(() => !!(document.getElementById("hpFrame").getAttribute("srcdoc") || "").includes("<h1>"), null, { timeout: 4000 }); }
  catch (e) { alive = false; }
  ok("点完预览后渲染进程还响应（旧版死循环在这里必然超时）", alive);
  const p = await readPanel(page);
  ok("面板显示出来且有尺寸", p.disp === "flex" && p.panel.w > 200 && p.frame.h > 100, JSON.stringify({ disp: p.disp, panel: p.panel, frame: p.frame }));
  ok("标题渲染成 <h1> 而不是原样吐 #", /<h1>Todo App<\/h1>/.test(p.srcdoc), p.srcdoc.slice(0, 120));
  ok("井号后没空格的行按正文渲染（不猜成标题，也不再死循环）", p.srcdoc.includes("<p>#没空格的标题也算正文</p>"), "");
  ok("单独一个 # 与 -- 开头行都吃得下", p.srcdoc.includes("<h1></h1>") && p.srcdoc.includes("<p>-- 这不是分隔线"), "");
  ok("代码块出 <pre><code>", p.srcdoc.includes("<pre><code>npm install"), "");
  ok("GFM 表格出 <table>（旧版当段落原样吐，看着就是「没内容」）",
    p.srcdoc.includes("<table><thead>") && p.srcdoc.includes("<tbody>"), "");
  ok("表头对齐按分隔行走（:---: 居中、---: 右对齐）",
    p.srcdoc.includes('<th style="text-align:center">路径</th>') && p.srcdoc.includes('<th style="text-align:right">说明</th>'), "");
  ok("引用与列表归位", p.srcdoc.includes("<blockquote>提示：需要 Node 18+</blockquote>") && p.srcdoc.includes("<li>[x] 增删改查</li>"), "");
  await page.screenshot({ path: path.join(OUT, "preview-md.png") });

  section("③ 缩放与实时刷新");
  ok("缩放初始 100%", p.zoomTxt === "100%", p.zoomTxt);
  await page.click("#hpZoomIn");
  await page.waitForTimeout(200);
  const z = await readPanel(page);
  ok("点放大后是 110%，iframe 的 zoom 跟着变",
    z.zoomTxt === "110%" && (await page.evaluate(() => document.getElementById("hpFrame").style.zoom)) === "1.1",
    JSON.stringify({ txt: z.zoomTxt }));
  await page.click("#hpZoomReset");
  await page.waitForTimeout(150);

  await page.evaluate(() => editor.trigger("probe", "type", { text: "\n## 探针新增小节\n" }));
  let refreshed = false;
  try { await page.waitForFunction(() => (document.getElementById("hpFrame").getAttribute("srcdoc") || "").includes("<h2>探针新增小节</h2>"), null, { timeout: 4000 }); refreshed = true; } catch (e) {}
  ok("编辑后预览自动刷新（350ms 防抖那条链路是通的）", refreshed);

  section("④ HTML 文件预览与关闭");
  await page.locator("#fileTree .ft-item", { hasText: "page.html" }).first().click();
  await page.waitForTimeout(700);
  const h = await readPanel(page);
  ok("切到 HTML 文件后预览跟着换内容", h.srcdoc.includes("静态页预览") && !h.srcdoc.includes("md-body"), h.srcdoc.slice(0, 100));
  await page.click("#hpClose");
  await page.waitForTimeout(300);
  const c = await readPanel(page);
  ok("点关闭后面板收起", c.disp === "none" && c.on === false, JSON.stringify({ disp: c.disp, on: c.on }));

  section("⑤ 过程里不能冒出渲染报错");
  ok("没有 console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log("\n\x1b[1m预览验收：\x1b[0m " + pass + " 通过 / " + fail + " 失败");
  if (fails.length) { console.log("\x1b[31m失败项：\x1b[0m\n  - " + fails.join("\n  - ")); console.log("\n--- 服务端日志尾部 ---\n" + childLog.slice(-1500)); }
  await browser.close();
  child.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\x1b[31m探针异常：\x1b[0m" + e.message);
  console.error(childLog.slice(-2000));
  try { child.kill(); } catch (_) {}
  process.exit(1);
});
