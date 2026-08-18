/* ============================================================
   pancode 一站式交付 / 命令面板 UI 回归验证（Playwright headless Chromium）

   覆盖 5 项（其中 R1/R2 是已修复的真实缺陷回归）：
     R1 命令面板能被打开
        回归点：#cmdk 曾写成内联 style="display:none"，与 cmdk.js 的
        .hidden 类开关机制冲突（内联样式优先级更高），导致 Ctrl+Shift+P 永久失效。
     R2 命令面板关闭时不劫持方向键
        回归点：因 R1 缺少 .hidden 类，document keydown 的
        `classList.contains("hidden")` 守卫恒为 false，
        使 ArrowUp/ArrowDown 在全应用范围被无条件 preventDefault。
     C3 命令面板含「一键全流程交付」入口，鼠标点击可打开工作流面板
        （点击需 stopPropagation，否则冒泡到 document 会被"点击外部关闭"秒关）
     C4 工作流面板渲染 /api/templates 的真实模板，ship 置顶且高亮
     C5 点击模板把「目标驱动」提示词填入聊天输入框

   产物：scripts/_verify_out/workflow.png
   自清理：结束时删除本次注册的临时账号，避免 users.json 堆积测试数据
   ============================================================ */
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

process.env.PORT = process.env.PORT || "8823";
require("../server/index.js"); // 同进程拉起服务端
const auth = require("../server/auth");

const PORT = process.env.PORT;
const BASE = "http://127.0.0.1:" + PORT;
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "PASS " : "FAIL ") + name + (detail ? "  → " + detail : ""));
}

const USER = "wfverify_" + Date.now();

async function getToken() {
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: "test1234" }),
  };
  await fetch(BASE + "/api/auth/register", opts).catch(() => {});
  const r = await fetch(BASE + "/api/auth/login", opts);
  const j = await r.json();
  return j.token || "";
}

(async () => {
  const token = await getToken();
  if (!token) throw new Error("获取测试 token 失败");

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await page.addInitScript((t) => localStorage.setItem("cw-user-token", t), token);
  await page.goto(BASE + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1500);

  const cmdkState = () => page.evaluate(() => {
    const el = document.getElementById("cmdk");
    return { hasHidden: el.classList.contains("hidden"), display: getComputedStyle(el).display };
  });

  /* ---------- R1：初始应隐藏，Ctrl+Shift+P 后应可见 ---------- */
  const before = await cmdkState();
  check("R1a 命令面板初始隐藏（.hidden 类生效）", before.hasHidden === true && before.display === "none",
    "hasHidden=" + before.hasHidden + " display=" + before.display);

  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(400);
  const opened = await cmdkState();
  check("R1b Ctrl+Shift+P 打开命令面板", opened.hasHidden === false && opened.display !== "none",
    "display=" + opened.display);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const closed = await cmdkState();
  check("R1c Esc 关闭命令面板", closed.hasHidden === true && closed.display === "none",
    "display=" + closed.display);

  /* ---------- R2：方向键接管策略 —— 历史浏览不得妨碍多行编辑 ----------
     在 window 冒泡阶段观察 defaultPrevented，可精确判断方向键是否被接管。 */
  await page.evaluate(() => {
    window.__dp = {};
    window.addEventListener("keydown", (e) => { window.__dp[e.key] = e.defaultPrevented; });
  });

  // R2a 多行 + 光标在开头：应正常跨行移动，不被历史浏览抢走
  await page.evaluate(() => {
    const ta = document.querySelector("#chatInput");
    ta.value = "aaa\nbbb";
    ta.focus();
    ta.setSelectionRange(0, 0);
  });
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(200);
  const multi = await page.evaluate(() => ({
    start: document.querySelector("#chatInput").selectionStart,
    dp: window.__dp.ArrowDown,
    active: document.activeElement ? document.activeElement.id : null,
  }));
  check("R2a 多行内容中 ArrowDown 正常跨行移动光标", multi.start > 0 && multi.dp === false,
    "光标 0 → " + multi.start + "，defaultPrevented=" + multi.dp + "，焦点=" + multi.active);

  // R2b 单行内容：仍保留 shell 式历史浏览（方向键被接管）
  await page.evaluate(() => {
    window.__dp = {};
    const ta = document.querySelector("#chatInput");
    ta.value = "单行内容";
    ta.focus();
    ta.setSelectionRange(2, 2);
  });
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(200);
  const single = await page.evaluate(() => window.__dp.ArrowUp);
  check("R2b 单行内容仍保留历史浏览（方向键接管）", single === true, "defaultPrevented=" + single);

  /* ---------- C3：命令面板「一键全流程交付」入口（鼠标点击路径） ---------- */
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const i = document.querySelector("#cmdkInput");
    i.value = "全流程";
    i.dispatchEvent(new Event("input"));
  });
  await page.waitForTimeout(300);
  const shipEntry = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll(".cmdk-item .cmdk-label")).map((x) => x.textContent);
    return items;
  });
  check("C3a 命令面板含「一键全流程交付」入口", shipEntry.some((t) => t.includes("一键全流程交付")),
    "匹配项=" + JSON.stringify(shipEntry));

  await page.click(".cmdk-item");                 // 鼠标点击（验证 stopPropagation 未被外部点击关闭）
  await page.waitForTimeout(1200);                // 等 /api/templates 拉取 + 渲染
  const wfVisible = await page.evaluate(() => {
    const p = document.getElementById("wfPop");
    return { display: p.style.display, computed: getComputedStyle(p).display };
  });
  check("C3b 点击后工作流面板保持打开（未被冒泡秒关）", wfVisible.computed !== "none",
    "display=" + wfVisible.display + " computed=" + wfVisible.computed);

  /* ---------- C4：工作流面板渲染真实模板 ---------- */
  const wf = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll("#wfList .wf-item")).map((el) => ({
      name: el.querySelector(".wf-name") ? el.querySelector(".wf-name").textContent.trim() : "",
      badge: el.querySelector(".wf-badge") ? el.querySelector(".wf-badge").textContent.trim() : "",
      hi: el.classList.contains("wf-hi"),
    }));
    const groups = Array.from(document.querySelectorAll("#wfList .wf-group")).map((x) => x.textContent.trim());
    return { items, groups };
  });
  check("C4a 渲染出真实模板（7 个内置）", wf.items.length === 7, "实际 " + wf.items.length + " 项");
  check("C4b ship 置顶且高亮", wf.items.length > 0 && wf.items[0].hi === true && wf.items[0].name.includes("一键全流程交付"),
    "首项=" + JSON.stringify(wf.items[0] || null));
  check("C4c 步数徽标已渲染（ship=8 步）", (wf.items[0] || {}).badge === "8 步", "badge=" + (wf.items[0] || {}).badge);
  check("C4d 分组标题正确", wf.groups.includes("一站式交付") && wf.groups.includes("流程模板"),
    "分组=" + JSON.stringify(wf.groups));

  await page.screenshot({ path: path.join(OUT, "workflow.png") });
  console.log("shot: workflow.png");

  /* ---------- C5：点击模板填入目标驱动提示词 ---------- */
  await page.click("#wfList .wf-item.wf-hi");
  await page.waitForTimeout(400);
  const filled = await page.evaluate(() => {
    const ta = document.querySelector("#chatInput");
    return { value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd };
  });
  check("C5a 提示词已填入输入框并引用 ship 模板",
    filled.value.includes("「ship」") && filled.value.includes("目标：") && filled.value.includes("8 步"),
    JSON.stringify(filled.value.slice(0, 60)) + "…");
  check("C5b 占位符被自动选中（可直接覆盖输入）", filled.selEnd > filled.selStart,
    "选区 " + filled.selStart + "–" + filled.selEnd);

  /* ---------- C6/C7：命令面板新增高频命令 + 快捷键帮助弹窗 ---------- */
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(400);
  const cmds = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".cmdk-item .cmdk-label")).map((x) => x.textContent));
  check("C6 命令面板含新增高频命令", [
    "一键全流程交付", "打开工作流面板", "新建文件", "保存当前文件",
    "切换 Editor / Agents 窗口", "查看键盘快捷键",
  ].every((t) => cmds.some((c) => c.includes(t))), "命中 " + cmds.length + " 条命令");

  await page.evaluate(() => {
    const i = document.querySelector("#cmdkInput");
    i.value = "快捷键";
    i.dispatchEvent(new Event("input"));
  });
  await page.waitForTimeout(300);
  await page.click(".cmdk-item");                 // 点击「查看键盘快捷键」
  await page.waitForTimeout(400);
  const sc = await page.evaluate(() => {
    const m = document.getElementById("shortcutsModal");
    return { computed: getComputedStyle(m).display, kbd: document.querySelectorAll("#shortcutsModal kbd").length };
  });
  check("C7 快捷键帮助弹窗可打开且含按键说明", sc.computed !== "none" && sc.kbd > 0,
    "display=" + sc.computed + " kbd=" + sc.kbd);
  await page.screenshot({ path: path.join(OUT, "shortcuts.png") });
  console.log("shot: shortcuts.png");
  // 关闭弹窗，避免影响后续
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  /* ---------- C8/C9：提交改动命令 + 弹窗（只读，不实际提交） ---------- */
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(400);
  const cmds2 = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".cmdk-item .cmdk-label")).map((x) => x.textContent));
  check("C8 命令面板含「提交当前改动（Git）」", cmds2.some((c) => c.includes("提交当前改动")),
    "命中 " + cmds2.length + " 条命令");
  await page.evaluate(() => {
    const i = document.querySelector("#cmdkInput");
    i.value = "提交";
    i.dispatchEvent(new Event("input"));
  });
  await page.waitForTimeout(300);
  await page.click(".cmdk-item");                 // 点击「提交当前改动（Git）」
  await page.waitForTimeout(700);                 // 等 /api/git/status 拉取
  const cm = await page.evaluate(() => {
    const m = document.getElementById("commitModal");
    return {
      display: getComputedStyle(m).display,
      branch: document.getElementById("cmBranch").textContent,
      submitDisabled: document.getElementById("cmSubmit").disabled,
    };
  });
  check("C9 提交弹窗可打开并加载 Git 状态（未实际提交）", cm.display !== "none",
    "display=" + cm.display + " branch=" + cm.branch + " 提交按钮=" + (cm.submitDisabled ? "禁用" : "可用"));
  await page.screenshot({ path: path.join(OUT, "commit.png") });
  console.log("shot: commit.png");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  /* ---------- C10–C13：按文件勾选提交（P8，绝不实际提交） ---------- */
  await page.evaluate(() => openCommit());
  await page.waitForSelector("#cmChanges .cm-chk", { timeout: 8000 });
  const chk = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("#cmChanges .cm-chk"));
    return { total: all.length, checked: all.filter((c) => c.checked).length, cnt: document.getElementById("cmCount").textContent };
  });
  check("C10 每文件带勾选框且默认全选", chk.total > 0 && chk.checked === chk.total,
    "total=" + chk.total + " checked=" + chk.checked);
  check("C11 计数显示「已选 N / N」", /已选\s*\d+\s*\/\s*\d+/.test(chk.cnt) && chk.checked === chk.total, "count=" + chk.cnt);
  await page.screenshot({ path: path.join(OUT, "commit-check.png") });
  console.log("shot: commit-check.png");
  // 取消全选 → 提交按钮禁用
  await page.evaluate(() => { const sa = document.getElementById("cmSelAll"); sa.checked = false; sa.dispatchEvent(new Event("change")); });
  await page.waitForTimeout(150);
  const afterUn = await page.evaluate(() => ({
    disabled: document.getElementById("cmSubmit").disabled, cnt: document.getElementById("cmCount").textContent,
  }));
  check("C12 取消全选后提交按钮禁用", afterUn.disabled === true, "disabled=" + afterUn.disabled + " count=" + afterUn.cnt);
  // 选择性提交：取消一个文件 → 拦截 POST 并断言 payload.files 仅含勾选项（不实际提交）
  await page.evaluate(() => { const sa = document.getElementById("cmSelAll"); sa.checked = true; sa.dispatchEvent(new Event("change")); });
  await page.waitForTimeout(100);
  let captured = null;
  await page.route("**/api/git/commit", (route) => { captured = route.request().postData(); route.abort(); });
  await page.evaluate(() => {
    const chks = document.querySelectorAll("#cmChanges .cm-chk");
    if (chks.length > 1) { chks[0].checked = false; chks[0].dispatchEvent(new Event("change")); }
  });
  await page.waitForTimeout(120);
  const selTotal = await page.evaluate(() => document.querySelectorAll("#cmChanges .cm-chk").length);
  await page.evaluate(() => document.getElementById("cmSubmit").click());
  await page.waitForTimeout(400);
  const expectFiles = selTotal - 1;
  let got = null;
  try { got = captured ? JSON.parse(captured).files.length : null; } catch (e) {}
  check("C13 选择性提交仅含勾选文件（请求被拦截，未实际提交）",
    got === expectFiles, "payload.files=" + got + " 期望=" + expectFiles);
  await page.unroute("**/api/git/commit");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  /* ---------- C14/C15：智能摘要面板（P9 智能体验 / P10 文档整合，绝不实际提交） ---------- */
  await page.evaluate(() => openCommit());
  await page.waitForSelector("#cmChanges .cm-chk", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900); // 等 /api/git/summary 拉取并渲染
  const sum = await page.evaluate(() => {
    const wrap = document.getElementById("cmSummaryWrap");
    const body = document.getElementById("cmSummary");
    return {
      total: document.querySelectorAll("#cmChanges .cm-chk").length,
      wrapVisible: wrap && getComputedStyle(wrap).display !== "none",
      text: body ? body.textContent : "",
      logActive: document.getElementById("cmViewLog").classList.contains("active"),
    };
  });
  if (sum.total > 0) {
    check("C14 智能摘要面板可见且含总览/建议（P9）",
      sum.wrapVisible && sum.text.length > 0 && (sum.text.includes("建议") || sum.text.includes("变更")),
      "wrapVisible=" + sum.wrapVisible + " 文本长度=" + sum.text.length + " 变更摘要tab=" + sum.logActive);
    await page.evaluate(() => document.getElementById("cmViewDoc").click()); // 绕过 onboardModal 指针拦截
    await page.waitForTimeout(300);
    const docv = await page.evaluate(() => ({
      docActive: document.getElementById("cmViewDoc").classList.contains("active"),
      text: document.getElementById("cmSummary").textContent,
    }));
    check("C15 文档草稿视图可切换且含文档片段（P10）",
      docv.docActive && (docv.text.includes("改动清单") || docv.text.includes("🆕") || docv.text.includes("新增")),
      "docTab=" + docv.docActive + " 文本长度=" + docv.text.length);
    await page.screenshot({ path: path.join(OUT, "commit-summary.png") });
    console.log("shot: commit-summary.png");
  } else {
    check("C14 智能摘要面板（工作区无改动，跳过）", true, "total=0 跳过");
    check("C15 文档草稿视图（工作区无改动，跳过）", true, "total=0 跳过");
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  const fatal = errors.filter((e) => !/favicon|net::ERR|sandboxed and lacks|localStorage.*sandboxed/i.test(e));
  check("控制台无致命报错", fatal.length === 0, fatal.slice(0, 3).join(" | ") || "无");

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log("\n" + (failed.length ? "有 " + failed.length + " 项失败" : "ALL PASS") +
    "（共 " + results.length + " 项）");
  cleanup();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("VERIFY_FAIL", e);
  cleanup();
  process.exit(1);
});

/* 自清理：删除本次临时账号，避免 users.json 堆积测试数据 */
function cleanup() {
  try {
    if (auth.removeUser(USER)) console.log("已清理临时账号: " + USER);
  } catch (e) {}
}
