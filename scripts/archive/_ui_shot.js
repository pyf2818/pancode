/* pancode 视觉回归截图台（Playwright headless Chromium @1440x900）
   用法：node scripts/_ui_shot.js [shotName]
   产物：scripts/_verify_out/shot_<name>_code.png / _agents.png / _codex.png
   通过页面全局 handleEvent() 注入 mock 事件流，真实走一遍前端渲染管线。
*/
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.SHOT_BASE || "http://127.0.0.1:8766";
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });
const NAME = process.argv[2] || "now";
const THEME = process.env.SHOT_THEME || "dark";
const PALETTE = process.env.SHOT_PALETTE || (THEME === "light" ? "celadon" : "graphite");

const MOCK = [
  { type: "msg.start", id: "u1" },
  { type: "msg.delta", id: "u1", text: "我来把 QuickMenu 的滚动卡顿改掉，先看一眼实现。" },
  { type: "msg.end", id: "u1" },

  { type: "think.start", id: "t1" },
  { type: "think.delta", id: "t1", text: "summaryStrategy 'llm' 会调用 generateSummary，这条路径在滚动时反复重算位置，应该改成逐帧 rAF 节流。" },
  { type: "think.end", id: "t1" },

  { type: "tool.start", id: "k1", name: "read_file", kind: "read", target: "src/components/aichat/agentLoopCore.js", round: 1 },
  { type: "tool.body", id: "k1", text: "const budget = resolveContextBudget(selectedModel);\n// 128K 窗口下 0.9 安全系数" },
  { type: "tool.end", id: "k1", ok: true, label: "312 行" },

  { type: "tool.start", id: "k2", name: "search_code", kind: "search", target: "contextBudget | resolveContextBudget", round: 1 },
  { type: "tool.end", id: "k2", ok: true, label: "6 处命中" },

  { type: "tool.start", id: "k3", name: "apply_edit", kind: "edit", target: "src/components/aichat/QuickMenu.tsx", round: 2 },
  { type: "tool.body", id: "k3", text: "--- a/src/components/aichat/QuickMenu.tsx\n+++ b/src/components/aichat/QuickMenu.tsx\n@@ -41,7 +41,9 @@\n-    reposition();\n+    const raf = requestAnimationFrame(reposition);\n+    return () => cancelAnimationFrame(raf);\n" },
  { type: "tool.end", id: "k3", ok: true, label: "+18 -6" },

  { type: "tool.start", id: "k4", name: "run_command", kind: "term", target: "npm run build", round: 3 },
  { type: "tool.body", id: "k4", text: "vite build ... built in 15.25s" },
  { type: "tool.end", id: "k4", ok: true, label: "exit 0" },

  { type: "tool.start", id: "k5", name: "run_command", kind: "term", target: "npm run test:unit", round: 4 },
  { type: "tool.end", id: "k5", ok: false, label: "2 failed" },

  { type: "think.start", id: "t2" },
  { type: "think.delta", id: "t2", text: "两个用例挂在旧的快照断言上，更新快照后复跑。" },
  { type: "think.end", id: "t2" },

  { type: "context.compact", before: 106000, after: 41000, budget: 115200, dropped: 23, keptCritical: 6, keptRecent: 10, forced: false,
    summary: "【任务目标】把 QuickMenu 滚动卡顿改掉，设置面板全屏，侧栏支持拖拽缩放。\n【已定决策】弹层改逐帧重算位置 + rAF 节流；只有关闭触发器滚出视口才收起；拖动只写 CSS 变量、松手才落 localStorage。\n【已改文件】src/components/aichat/QuickMenu.tsx（rAF 节流 + 滚出判定）；src/settings/Panel.tsx（100vw×100dvh，正文 1360px）；src/layout/Sidebar.tsx（ResizeHandle）。\n【验证状态】npm run build 通过 15.25s；npm run test:unit 首轮 2 failed（旧快照断言），更新快照后 1497 passed。\n【未决问题】无，三项均在 1440×900 下验证完毕。" },

  { type: "tool.start", id: "k6", name: "agent", kind: "agent", target: "worker: 修复快照断言", round: 5 },
  { type: "tool.end", id: "k6", ok: true, label: "子 Agent 完成" },

  { type: "tool.start", id: "k7", name: "run_command", kind: "term", target: "npm run test:unit", round: 6 },
  { type: "tool.end", id: "k7", ok: true, label: "1497 passed" },

  { type: "changes", list: [
    { path: "src/components/aichat/QuickMenu.tsx", status: "M", add: 18, del: 6, risk: "mid", riskScore: 3, riskReasons: ["敏感路径（鉴权 / 配置 / 依赖 / 部署 / 入口）"] },
    { path: "src/settings/Panel.tsx", status: "M", add: 41, del: 22, risk: "high", riskScore: 7, riskReasons: ["敏感路径（鉴权 / 配置 / 依赖 / 部署 / 入口）","大段删除（+41 / −22），易误删既有逻辑","改动集中没有配套测试变更"] },
    { path: "src/layout/Sidebar.tsx", status: "M", add: 27, del: 9 },
    { path: "src/styles/tokens.css", status: "A", add: 12, del: 0 },
  ] },
  { type: "context.usage", used: 41000, budget: 115200, est: false },
  { type: "goal.continue", turn: 7, max: 40, reason: "仍有 3 步未完成：补 e2e；改 tokens；写 CHANGELOG", convId: "default" },
  { type: "msg.start", id: "a1" },
  { type: "msg.delta", id: "a1", text: "## 收工\n\n三项都落在 `1440×900` 下验证过：\n\n1. 弹层改成逐帧重算位置 + `rAF` 节流，滚动不再掉帧；\n2. 设置面板全屏，正文留 `1360px` 阅读宽度；\n3. 侧栏 `ResizeHandle` 支持拖拽缩放，只写 CSS 变量松手落 `localStorage`。\n\n> 上下文已自动压缩一次，保留了全部决策要点。" },
  { type: "msg.end", id: "a1" },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const user = "shot_" + Date.now();
  const r = await fetch(BASE + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user, password: "shot1234" }),
  }).then((x) => x.json()).catch(() => null);
  const token = r && r.token;
  if (token) await page.addInitScript((t) => localStorage.setItem("cw-user-token", t), token);
  await page.addInitScript(`(() => { localStorage.setItem("cw-onboarded","1"); localStorage.setItem("cw-theme",${JSON.stringify(THEME)}); localStorage.setItem("cw-palette",${JSON.stringify(PALETTE)}); })()`);

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  // 关掉新手引导（若仍出现）
  await page.evaluate(() => {
    const m = document.querySelector("#onboardModal, .ob-mask, #obModal");
    if (m && m.style) m.style.display = "none";
    document.querySelectorAll("[id*=Modal],[class*=mask]").forEach((x) => {
      if (/引导|欢迎|onboard/i.test(x.textContent || "") && x.id !== "evoCodexModal") x.style.display = "none";
    });
  });

  // 注入 mock 事件流
  const injected = await page.evaluate((events) => {
    if (typeof window.handleEvent !== "function") return "NO handleEvent";
    for (const e of events) { try { window.handleEvent(e); } catch (err) {} }
    return "ok";
  }, MOCK);
  console.log("inject:", injected);
  await page.waitForTimeout(600);

  await page.screenshot({ path: path.join(OUT, `shot_${NAME}_${THEME}_${PALETTE}_code.png`) });

  await page.evaluate(() => document.querySelector("#btnModeAgents") && document.querySelector("#btnModeAgents").click());
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `shot_${NAME}_${THEME}_${PALETTE}_agents.png`) });

  await page.evaluate(() => { try { window.openEvolutionCodex && window.openEvolutionCodex(); } catch (e) {} });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `shot_${NAME}_${THEME}_${PALETTE}_codex.png`) });

  await browser.close();
  console.log("->", path.join(OUT, `shot_${NAME}_code.png`));
})().catch((e) => { console.error(e); process.exit(1); });
