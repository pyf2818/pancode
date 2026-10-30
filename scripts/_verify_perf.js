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

  const perfEnv = Object.assign({}, process.env, {
    PANCODE_DATA_DIR: DATA_DIR, PORT: String(PORT), AGENT_FAST: "1",
    CURSORWEB_ENGINE: "demo", NODE_NO_WARNINGS: "1",
  });
  /* 父 shell 残留 ELECTRON_RUN_AS_NODE=1 时，electron.exe 会退化成纯 Node：
     `require("electron").app` 是 undefined，main.js 第一行 setAppUserModelId 就 TypeError，
     症状是"服务端没起来"而不是"权限错了"。同一把尺子见 _verify_desktop.js 与 _verify_pkg.js。 */
  delete perfEnv.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBin, [".", "--no-sandbox", "--remote-debugging-port=" + CDP,
    "--user-data-dir=" + path.join(SANDBOX, "electron-ud")], {
    cwd: ROOT,
    env: perfEnv,
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

  /* 打开设置这一步走的是用户真路径：#btnSettings 现在只出小抽屉（gear-menu.js），
     「全部设置」才进全屏工作台（workbench.js:1464 注释）。上一版直接点齿轮等 #wbBody，
     于是 evaluate 里 getElementById("wbBody") 是 null，整段 catch 成 err，
     探针照样 exit 0 —— 量了个空。抽屉与面板两段分开量：抽屉是用户摸到的第一下。
     openWorkbench 先 wbBuild() 出空壳，再 await 一次配置请求才填内容，所以"看得见"和"有内容"仍然是两件事。 */
  const openSettings = await page.evaluate(async () => {
    const gear = () => document.getElementById("btnSettings");
    const drawerOn = () => { const g = document.getElementById("gearMenu"); return !!g && !g.classList.contains("hidden"); };
    const closeDrawer = () => { if (typeof window.closeGearMenu === "function") window.closeGearMenu(); };
    const close = () => { const c = document.getElementById("wbClose"); if (c && document.getElementById("workbench") && document.getElementById("workbench").style.display !== "none") c.click(); };
    const openFull = () => { closeDrawer(); gear().click(); document.querySelector("#gearMenu .gm-all").click(); };
    const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    /* wbBuild() 是懒建的：第一次打开之前根本没有 #wbBody。清空只在它已存在时做
       —— 不存在时本来就是干净的空壳，不存在"旧节点留在下次重建前"的问题。 */
    const clearBody = () => { const b = document.getElementById("wbBody"); if (b) b.replaceChildren(); };
    const until = (pred) => new Promise((done) => {
      const t0 = performance.now();
      (function loop() { if (pred()) return done(performance.now() - t0); requestAnimationFrame(loop); })();
    });
    const drawer = [];
    const drawerShown = [];
    for (let k = 0; k < 3; k++) {
      closeDrawer(); await raf2();
      const t0 = performance.now();
      gear().click();
      drawerShown.push(drawerOn());
      drawer.push(Math.round(performance.now() - t0));
    }
    const frame = []; const content = [];
    for (let k = 0; k < 3; k++) {
      close(); await raf2();
      clearBody();
      const t1 = performance.now();
      openFull();
      await raf2();
      frame.push(Math.round(performance.now() - t1));
      close(); await raf2();
      // close 不清 #wbBody（openWorkbench 每次重建内容，但旧节点会留到下次重建前），
      // 不清空的话第二次起 ">40 个元素" 判据立即为真，量出 0 —— 上一轮基线就是这么被污染的。
      clearBody();
      const t2 = performance.now();
      openFull();
      content.push(Math.round(await until(() => document.querySelectorAll("#wbBody *").length > 40)));
    }
    drawer.sort((a, b) => a - b); frame.sort((a, b) => a - b); content.sort((a, b) => a - b);
    return { drawerMed: drawer[1], drawer, drawerShown: drawerShown.filter(Boolean).length,
      frameMed: frame[1], frames: frame, contentMed: content[1], contents: content };
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
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(result, null, 2), "utf8");
  await browser.close();
  child.kill();
  child = null;

  /* 原先这一段只把 JSON 打出来就 exit 0 —— 上一轮 #wbBody 取不到、整段量成 err，
     链上依然读成"跑了且过"。这里补判据：全部是"这一步到底量到数没有"的结构判据，
     不设毫秒闸（同机器上别的进程会把阈值随机刷红，见 _verify_perf 头注释的口径）。 */
  console.log(JSON.stringify(result, null, 1));
  const isNum = (x) => typeof x === "number" && isFinite(x);
  const os = result.openSettings;
  const judge = [
    ["真桌面壳里量到了首屏（FCP 与 domInteractive 都是正数）", isNum(result.boot.fcp) && result.boot.fcp > 0 && isNum(result.boot.domInteractive) && result.boot.domInteractive > 0],
    ["齿轮小抽屉一点就出（三次都显形，且量到时间）", os.drawerShown === 3 && isNum(os.drawerMed) && (os.drawer || []).length === 3],
    ["全屏设置面板开到有内容（#wbBody 子节点 >40）", result.panelOpen === true],
    ["面板「空壳」与「有内容」两段都量到数（没被 catch 成 err）", isNum(os.frameMed) && isNum(os.contentMed) && !os.err],
    ["设置里换分组逐个量到（样本数=导航项数，上限 8）", result.tabs.count > 0 && result.tabs.samples.length === Math.min(result.tabs.count, 8) && result.tabs.samples.every((s) => isNum(s.med))],
    ["CODE↔AGENT 切换量到 3 个样本", isNum(result.modeSwitch.med) && (result.modeSwitch.all || []).length === 3],
    ["静置 1.5 秒有帧间隔采样（不是空数组凑出来的 p95）", result.frames.n > 0 && isNum(result.frames.p95)],
    ["基线文件落盘且就是这一次量的（读回比对 at）", (() => { try { return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")).at === result.at; } catch (e) { return false; } })()],
  ];
  let red = 0;
  for (const [name, cond] of judge) {
    console.log((cond ? "  \x1b[32m✓\x1b[0m " : "  \x1b[31m✗\x1b[0m ") + name);
    if (!cond) red++;
  }
  console.log("\n共 " + judge.length + " 条，红 " + red + " 条");
  console.log("\n写入 " + path.relative(ROOT, BASELINE_FILE));
  process.exit(red ? 1 : 0);
})().catch((e) => {
  console.error("探针异常：" + e.stack);
  console.error(log.slice(-2000));
  console.log("\n共 1 条，红 1 条");
  try { child.kill(); } catch (_) {}
  process.exit(1);
});
