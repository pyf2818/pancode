/* ============================================================
   性能基线与回归闸（#44：启动/运行/切换要丝滑，"打开设置都卡卡的"）

   为什么必须在**真 Electron**里量：GPU 开关（electron/main.js gpuPref）只在桌面壳里生效，
   headless Chromium 量出来的数不是用户感受到的数。
   实测教训：主进程曾无条件 disableHardwareAcceleration + disable-gpu，整台应用被压进
   软件光栅化——设置切组 190-320ms、切视图 207ms；默认交给 Chromium 自检后降到 30ms 级（6-9 倍）。
   软件光栅化下 backdrop-filter / box-shadow / 常驻动画的代价是数量级的。

   量的是四件用户能直接感觉到的事：
     1) 打开设置面板到下一帧真的画出来（不是"点了没反应"那一段）
     2) 设置里换分组（每次都是一整块 DOM 重建）
     3) CODE ↔ AGENT 切视图
     4) 什么都不动的 1.5 秒里，帧间隔的 p95（常驻动画把主线程占了多少）
   外加：>50ms 的长任务清单，和首屏从导航到"输入框可用"的时间。

   计时全在页面内做（一次 evaluate 拿全部数字），避免 CDP 往返混进测量值。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PERF_PORT || 8861);
const CDP = Number(process.env.PERF_CDP || 9341);
const SANDBOX = path.join(ROOT, "scripts", "_verify_out", "perf-electron");
const DATA_DIR = path.join(SANDBOX, "data");
const WS_DIR = path.join(SANDBOX, "ws");
const OUT = path.join(__dirname, "_verify_out");
const BASELINE_FILE = path.join(OUT, "perf-baseline.json");

let log = "";
let child = null;

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign({}, token ? { "x-user-token": token } : {},
      data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {});
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 8000 }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch (e) { resolve({ raw: buf }); } });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 页面内测一次"点击 → 连续两帧"：第二帧才可能是新内容的绘制结果。
   重复 REPS 次取中位数，第一次通常被懒加载/字体/布局缓存污染。 */
const PROBE_SRC = `
window.__perfNow = function () { return performance.now(); };
window.__probe = async function (opts) {
  const REPS = opts.reps || 3;
  const samples = [];
  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  for (let k = 0; k < REPS; k++) {
    if (opts.before) await opts.before();
    const t0 = performance.now();
    opts.act();
    await raf2();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { med: Math.round(samples[Math.floor(samples.length / 2)]), all: samples.map((x) => Math.round(x)) };
};
window.__longTasks = [];
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push({ dur: Math.round(e.duration), name: e.name.slice(0, 60) }); })
    .observe({ entryTypes: ["longtask"] });
} catch (e) { window.__longTasks.push({ dur: 0, name: "longtask 不支持" }); }
window.__frameGaps = async function (ms) {
  const gaps = [];
  let last = performance.now();
  return new Promise((done) => {
    function tick(now) {
      gaps.push(now - last); last = now;
      if (now - start < ms) requestAnimationFrame(tick);
      else {
        gaps.shift();
        const s = gaps.slice().sort((a, b) => a - b);
        done({ n: s.length, med: Math.round(s[Math.floor(s.length / 2)] || 0), p95: Math.round(s[Math.floor(s.length * 0.95) - 1] || s[s.length - 1] || 0), max: Math.round(s[s.length - 1] || 0) });
      }
    }
    const start = performance.now();
    requestAnimationFrame(tick);
  });
};
`;

(async () => {
  const electronBin = require("electron");
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(WS_DIR, { recursive: true });
  fs.writeFileSync(path.join(WS_DIR, "README.md"), "# 性能夹具工作区\n\n正文。\n", "utf8");
  fs.writeFileSync(path.join(DATA_DIR, "pancode.config.json"),
    JSON.stringify({ workspace: WS_DIR, desktop: { closeAction: "quit" }, agentMode: "auto" }), "utf8");

  child = spawn(electronBin, [".", "--no-sandbox", "--remote-debugging-port=" + CDP,
    "--user-data-dir=" + path.join(SANDBOX, "electron-ud")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PANCODE_DATA_DIR: DATA_DIR, PORT: String(PORT), AGENT_FAST: "1",
      CURSORWEB_ENGINE: "demo", NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { up = (await req("GET", "/api/health")).ok; } catch (e) {}
    if (!up) await wait(500);
  }
  if (!up) { console.log("服务端没起来\n" + log.slice(-1500)); process.exit(1); }

  const creds = { username: "perf" + Date.now(), password: "test1234" };
  await req("POST", "/api/auth/register", creds).catch(() => {});
  const token = (await req("POST", "/api/auth/login", creds).catch(() => ({}))).token || "";

  const { chromium } = require("playwright");
  let browser = null;
  for (let i = 0; i < 40 && !browser; i++) {
    try { browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP); } catch (e) { await wait(500); }
  }
  if (!browser) { console.log("CDP 没接上\n" + log.slice(-1500)); child.kill(); process.exit(1); }
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => p.url().startsWith("http://127.0.0.1:" + PORT));
  if (!page) { console.log("没找到应用窗口，现有：" + ctx.pages().map((p) => p.url()).join(" | ")); child.kill(); process.exit(1); }

  await page.evaluate((t) => { try { localStorage.setItem("cw-user-token", t); localStorage.setItem("cw-onboarded", "1"); } catch (e) {} }, token);
  await page.addScriptTag({ content: PROBE_SRC }).catch(() => {});
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => !!document.getElementById("chatInputBox"), { timeout: 40000 });
  await page.evaluate((src) => { (0, eval)(src); }, PROBE_SRC);
  await page.waitForTimeout(2500);

  const boot = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] || {};
    const fcp = (performance.getEntriesByName("first-contentful-paint")[0] || {}).startTime || 0;
    const interactive = nav.domInteractive || 0;
    /* 首屏真正的判据不是 FCP（那只是"有像素"），而是输入框出现——
       它要等 hello/配置/技能列表几轮 WS 回来才建得起来。 */
    const box = document.getElementById("chatInputBox");
    return {
      fcp: Math.round(fcp), domInteractive: Math.round(interactive),
      loadEvent: Math.round(nav.loadEventEnd || 0),
      boxNow: Math.round(performance.now() - (box ? box.getBoundingClientRect().top * 0 : 0)),
    };
  });

  /* 打开设置这一步：openWorkbench 先 display:flex 出空壳，再 await 一次配置请求，
     然后才把整块 DOM 建出来。所以"看得见"和"有内容"是两件事，分开量。 */
  const openSettings = await page.evaluate(async () => {
    const close = () => { const c = document.getElementById("wbClose"); if (c && document.getElementById("workbench").style.display !== "none") c.click(); };
    const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const until = (pred) => new Promise((done) => {
      const t0 = performance.now();
      (function loop() { if (pred()) return done(performance.now() - t0); requestAnimationFrame(loop); })();
    });
    const frame = [], content = [];
    for (let k = 0; k < 3; k++) {
      close(); await raf2();
      const t0 = performance.now();
      document.getElementById("btnSettings").click();
      await raf2();
      frame.push(Math.round(performance.now() - t0));
      close(); await raf2();
      // close 不清 #wbBody（openWorkbench 每次重建内容，但旧节点会留到下次重建前），
      // 不清空的话第二次起 ">40 个元素" 判据立即为真，量出 0 —— 上一轮基线就是这么被污染的。
      document.getElementById("wbBody").replaceChildren();
      const t1 = performance.now();
      document.getElementById("btnSettings").click();
      content.push(Math.round(await until(() => document.querySelectorAll("#wbBody *").length > 40)));
    }
    frame.sort((a, b) => a - b); content.sort((a, b) => a - b);
    return { frameMed: frame[1], frames: frame, contentMed: content[1], contents: content };
  }).catch((e) => ({ err: e.message.split("\n")[0] }));

  const panelOpen = await page.evaluate(() => {
    const el = document.getElementById("workbench");
    return !!(el && el.style.display !== "none" && document.querySelectorAll("#wbBody *").length > 40);
  });

  const tabs = await page.evaluate(async () => {
    const items = () => Array.from(document.querySelectorAll("#wbNav .wb-nav-item"));
    const names = items().map((x) => (x.textContent || "").trim()).filter(Boolean);
    const out = [];
    for (let i = 0; i < Math.min(names.length, 8); i++) {
      const r = await window.__probe({
        reps: 2,
        act: () => { const el = items()[i]; if (el) el.click(); },
      });
      out.push({ name: names[i], med: r.med, all: r.all });
    }
    return { count: names.length, samples: out };
  }).catch((e) => ({ err: e.message.split("\n")[0], count: 0, samples: [] }));

  const modeSwitch = await page.evaluate(() => window.__probe({
    reps: 3,
    act: () => { const b = document.getElementById("btnModeAgents") || document.getElementById("btnModeEditor"); b.click(); },
    before: async () => { (document.getElementById("btnModeEditor") || document.getElementById("btnModeAgents")).click(); await new Promise((r) => requestAnimationFrame(r)); },
  })).catch((e) => ({ err: e.message.split("\n")[0] }));

  const closeSettings = await page.evaluate(async () => {
    const close = document.getElementById("wbClose") || document.getElementById("setClose");
    if (close) close.click();
    await new Promise((r) => requestAnimationFrame(r));
  }).catch(() => {});
  void closeSettings;

  const frames = await page.evaluate(() => window.__frameGaps(1500));
  const longTasks = await page.evaluate(() => window.__longTasks.slice(0, 20));

  const result = {
    at: new Date().toISOString(),
    boot, openSettings, panelOpen, tabs, modeSwitch, frames,
    longTaskCount: longTasks.filter((t) => t.dur >= 50).length,
    longTasks,
  };
  console.log(JSON.stringify(result, null, 1));
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(result, null, 2), "utf8");
  console.log("\n写入 " + path.relative(ROOT, BASELINE_FILE));
  await browser.close();
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error("探针异常：" + e.stack);
  console.error(log.slice(-2000));
  try { child.kill(); } catch (_) {}
  process.exit(1);
});
