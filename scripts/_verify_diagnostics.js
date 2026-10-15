/* 问题面板实测（P1-B1）
   ————————————————————————————————————————————
   这条探针要解决的是上一轮留下的同类问题：功能"写在代码里"不等于"接上了"。
   诊断面板尤其容易假完成——数据源（Monaco marker）一直都在，缺的是"有没有人把它读出来给人看"。
   判据因此全部落在真实浏览器里：真的把带语法错误的文件打开、真的点页签、真的点那一行、
   真的读状态栏那格子的文字。任何一环没接上，这里就红。

   数据源刻意选 Monaco 自带的 js/ts 语法诊断：它不依赖机器上装没装 pyright/gopls，
   所以这条门在任何开发机上都会真的跑出诊断，而不是"环境没配 → 断言空转 → 永远绿"。
   LSP 那条路的回灌（写盘后把诊断拼进工具回执给模型）由 test/p1-diag-readback.test.js 钉住。
   用法：node scripts/_verify_diagnostics.js
*/
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "diag" });

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.DIAG_PORT || 8837);

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (token) headers["x-user-token"] = token;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 15000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (x) { resolve({ status: res.statusCode, raw: buf.slice(0, 200) }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("http timeout")));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  section("起沙箱服务（工作区里放一个真有语法错误的 js）");
  const wsDir = SANDBOX.wsDir;
  fs.mkdirSync(wsDir, { recursive: true });
  /* 语法错误刻意放在第 2 行：如果它和第 1 行一样，"光标跳到报错那一行"这条断言就只是巧合通过。
     `function broken(:` 是 Monaco 的 TS worker 稳定会报的语法错，
     不需要任何外部语言服务器 —— 这是本探针能长住的前提。 */
  fs.writeFileSync(path.join(wsDir, "broken.js"), "const fine = 1;\nfunction broken(:\n  return 1;\n}\n", "utf8");
  fs.writeFileSync(path.join(wsDir, "clean.js"), "const fine2 = 1;\nconsole.log(fine2);\n", "utf8");
  fs.writeFileSync(path.join(SANDBOX.dataDir, "pancode.config.json"), JSON.stringify({
    workspace: wsDir,
    llm: { baseURL: "http://127.0.0.1:1/v1", apiKey: "sk-sandbox", model: "mock" },
    agentMode: "agent", permissions: { mode: "auto", allow: [], deny: [] },
  }), "utf8");
  let out = "";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT, env: SANDBOX.env({ PORT: String(PORT), NODE_NO_WARNINGS: "1", CURSORWEB_ENGINE: "demo" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => { out = (out + c).slice(-40000); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-40000); });
  let up = false;
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const h = await req("GET", "/api/health"); if (h.json && h.json.ok) { up = true; break; } } catch (x) {}
  }
  if (!up) { child.kill(); throw new Error("服务未就绪\n" + out.slice(-1200)); }
  const reg = await req("POST", "/api/auth/register", { username: "_diag_" + Date.now(), password: "test1234" });
  const token = reg.json && reg.json.token;
  if (!token) { child.kill(); throw new Error("注册失败：" + JSON.stringify(reg.json)); }

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("cw-user-token", t);
      localStorage.setItem("cw-onboarded", "1");
    } catch (e) {}
  }, token);
  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load", timeout: 30000 });
  /* 等的是"真就绪"而不是固定毫秒数：state 是词法全局，裸引用才等得到（window.state 恒为 undefined，
     那样的等待会立刻假通过，后面全在跟时序赌博）。 */
  await page.waitForFunction(() => {
    const st = (typeof state !== "undefined" && state) || window.state;
    return !!(st && st.monacoReady === true);
  }, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const b = document.querySelector("#loginModal button.primary"); if (b) b.click();
    ["onboardModal", "authModal"].forEach((id) => { const m = document.getElementById(id); if (m) m.style.display = "none"; });
  });
  await page.waitForTimeout(400);

  section("① 面板存在，且没打开出错的代码时是空的");
  const initial = await page.evaluate(() => {
    const t = document.getElementById("bpTabProb");
    const c = window.Diagnostics ? window.Diagnostics.collect() : null;
    return { tab: !!t, body: !!document.getElementById("problemsBody"), counts: c };
  });
  ok("底栏出现了「问题」页签与面板容器", initial.tab && initial.body, JSON.stringify(initial));
  ok("面板数据源接的是 monaco marker（不是自己另算一套）",
    !!initial.counts && typeof initial.counts.errors === "number", JSON.stringify(initial.counts));

  section("② 打开带语法错误的文件 → 问题真的进面板");
  await page.evaluate(() => window.openFile("broken.js"));
  /* TS worker 算第一份诊断要时间，轮询而不是死等一个毫秒数 */
  let got = null;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    got = await page.evaluate(() => window.Diagnostics.collect());
    if (got.errors > 0) break;
  }
  ok("出错文件被统计到至少 1 个错误", !!got && got.errors >= 1, JSON.stringify(got));
  ok("干净的文件不贡献计数（只列有 marker 的）",
    !got.rows.some((r) => r.path === "clean.js"), JSON.stringify(got.rows.map((r) => r.path)));
  const dom = await page.evaluate(() => {
    const t = document.getElementById("bpTabProb");
    t.click();
    const rows = Array.from(document.querySelectorAll(".pb-row"));
    const sb = document.getElementById("sbProblems");
    return {
      paneShown: getComputedStyle(document.getElementById("problemsBody")).display !== "none",
      termHidden: getComputedStyle(document.getElementById("terminalSlotEditor")).display === "none",
      rows: rows.length,
      firstMsg: rows[0] ? rows[0].querySelector(".pb-msg").textContent : "",
      firstLoc: rows[0] ? rows[0].querySelector(".pb-loc").textContent : "",
      badge: (document.getElementById("bpProbCount") || {}).textContent,
      sbText: sb ? sb.textContent.trim() : "",
      sbHot: sb ? sb.classList.contains("has-errors") : false,
    };
  });
  ok("点页签切到问题面板（终端那侧同时隐藏，不是叠在下面）", dom.paneShown && dom.termHidden, JSON.stringify(dom));
  ok("列出了具体那一行", dom.rows >= 1 && /行|:\d|line|;/i.test(dom.firstMsg + dom.firstLoc), JSON.stringify(dom));
  ok("状态栏那一格不再是恒为 0 的死标签", dom.sbText !== "0 错误" && dom.sbHot, JSON.stringify({ sbText: dom.sbText, hot: dom.sbHot }));
  ok("页签上的计数徽标与列表同源", parseInt(dom.badge, 10) === dom.rows, JSON.stringify({ badge: dom.badge, rows: dom.rows }));

  section("③ 点一行跳到那个文件的那一行");
  const jumped = await page.evaluate(async () => {
    /* app.js 顶层是 `const state` —— 词法全局，window.state 取不到，必须裸引用 */
    const st = (typeof state !== "undefined" && state) || window.state;
    /* 先切到另一个文件，再点问题行——不然"跳到了"可能只是它本来就在 */
    window.openFile("clean.js");
    await new Promise((r) => setTimeout(r, 250));
    const before = st.activeFile;
    const rows = Array.from(document.querySelectorAll(".pb-row"));
    const row = rows.filter((x) => x.dataset.p === "broken.js")[0] || rows[0];
    const wantLine = parseInt(row.dataset.l, 10);
    row.click();
    await new Promise((r) => setTimeout(r, 350));
    const ed = window.__pancodeEditor || (window.monaco && monaco.editor.getEditors && monaco.editor.getEditors()[0]);
    const pos = ed ? ed.getPosition() : null;
    return { before, after: st.activeFile, line: pos ? pos.lineNumber : -1, want: wantLine, path: row.dataset.p, rowCount: rows.length };
  });
  ok("点击后活动文件切到了问题所在文件", jumped.before === "clean.js" && jumped.after === "broken.js", JSON.stringify(jumped));
  ok("光标落在报错那一行（不是只打开文件）", jumped.line === jumped.want && jumped.want > 1, JSON.stringify(jumped));

  section("④ 修好错误 → 计数自己掉下来");
  await page.evaluate(() => {
    const m = window.monaco.editor.getModels().filter((x) => /broken\.js$/.test(x.uri.toString()))[0];
    m.setValue("function ok2(){ return 1; }\n");
  });
  let cleared = null;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    cleared = await page.evaluate(() => window.Diagnostics.collect());
    if (cleared.errors === 0) break;
  }
  ok("改对之后错误清零（面板不是只增不减的清单）", !!cleared && cleared.errors === 0, JSON.stringify(cleared));
  const emptyState = await page.evaluate(async () => {
    document.getElementById("bpTabProb").click();
    /* 渲染走 rAF 合并，点完立刻读会拿到上一次的结果（实测拿到过旧的"2 错误"） */
    await new Promise((r) => setTimeout(r, 350));
    const e = document.querySelector(".pb-empty");
    return {
      shown: !!e, text: e ? e.textContent : "",
      sb: document.getElementById("sbProblems").textContent.trim(),
      toolbar: !!document.querySelector(".pb-mask-btn"),
    };
  });
  ok("回到空态时写清了覆盖范围（不假装全仓没问题）",
    emptyState.shown && /已打开的文件/.test(emptyState.text), JSON.stringify(emptyState));
  ok("工具条在多次刷新后还在（列表写在独立容器里，没被 innerHTML 冲掉）",
    emptyState.toolbar === true, JSON.stringify(emptyState));

  await browser.close();
  child.kill();
  console.log("\n" + (fail ? "\x1b[31mHAS FAIL\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { for (const f of fails) console.log("  - " + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\x1b[31mFAIL:\x1b[0m " + (e && e.stack || e)); process.exit(1); });
