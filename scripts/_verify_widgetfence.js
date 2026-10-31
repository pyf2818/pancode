/* ============================================================
   围栏/产物/本地位置 验收（2026-10-31）

   用户截图里的坏形态：结论卡里 ```widget 和 <svg> 被当成普通段落原样吐出。
   根因是旧围栏正则只认绝对行首，模型在 ``` 前多打一个空格（或中文全角空格）就整段降级。
   本探针盯四件事：
   1. 四种行首空白（无/空格/NBSP/全角）在终稿渲染里都必须出 .msg-widget；
   2. Worker 流式路径不能把围栏吐成字面段落（流式期允许先画代码块，但不能是<p>```）；
   3. 旧快照那种「字面围栏存成段落」的形态，hydratePane 时必须被升级回卡片；
   4. 产物卡片：目录页没缓存的路径也能点开；图片预览走鉴权 blob（不是 401 空图）；
      卡片上的「在文件夹中显示」按钮不触发打开文件，并真的把相对路径递给桥。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#0a6ebd"/><circle cx="60" cy="30" r="18" fill="#fff"/></svg>';

const sb = require("./_sandbox").create({
  tag: "wgfence",
  wsFiles: {
    "notes.md": "# 产物说明\n\n这是探针产物。\n",
    "report.html": "<!DOCTYPE html><html><body><h1 id='r'>报告</h1></body></html>",
    "art.svg": SVG,
    "docs/guide.md": "# 指南\n",
  },
});
fs.writeFileSync(path.join(sb.wsDir, "pic.png"), Buffer.from(PNG_B64, "base64"));

const { chromium } = require("playwright");
const PORT = Number(process.env.PORT || 8861);
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

const MD = {
  plain: "结论\n\n```svg\n" + SVG + "\n```\n",
  space: "结论\n\n ```svg\n" + SVG + "\n ```\n",
  nbsp: "结论\n\n\u00a0```svg\n" + SVG + "\n\u00a0```\n",
  full: "结论\n\n\u3000```svg\n" + SVG + "\n\u3000```\n",
  /* 用户真实快照的形态：四个反引号开围栏（旧解析器只认恰好三个） */
  four: "结论\n\n````widget\n" + SVG + "\n````\n",
};

(async () => {
  if (!await waitServer(20000)) { console.log(childLog.slice(-2000)); throw new Error("服务端没起来（端口 " + PORT + "）"); }
  const base = `http://127.0.0.1:${PORT}`;
  const user = "wgfence_" + Date.now();
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

  section("① 终稿渲染：四种行首空白的围栏都要出卡片");
  const finals = await page.evaluate(async (cases) => {
    const out = {};
    for (const [k, src] of Object.entries(cases)) {
      out[k] = await new Promise((res) => renderChatMDFinal(src, res));
    }
    return out;
  }, MD);
  for (const k of Object.keys(MD)) {
    const h = finals[k] || "";
    ok(k + "：出 .msg-widget 卡片", h.includes('class="msg-widget"') && h.includes("wg-frame"), h.slice(0, 160));
    ok(k + "：不再留下字面 ``` 段落", !/<p>\s*```/.test(h), h.slice(0, 160));
  }
  const live = await page.evaluate((h) => {
    const box = document.createElement("div");
    box.innerHTML = h;
    document.body.appendChild(box);
    const fr = box.querySelector(".msg-widget iframe");
    const r = { has: !!fr, srcdoc: fr ? (fr.getAttribute("srcdoc") || "") : "" };
    setTimeout(() => box.remove(), 3000);
    return r;
  }, finals.space);
  ok("卡片 iframe 的 srcdoc 里确实是 SVG", live.has && live.srcdoc.includes("<svg") && live.srcdoc.includes("#0a6ebd"), live.srcdoc.slice(0, 120));
  try {
    await page.waitForTimeout(600);
    const n = await page.frameLocator(".msg-widget iframe").first().locator("svg").count();
    ok("沙箱 iframe 里 SVG 真的被解析成节点（不只是源码字符串）", n > 0, "count=" + n);
  } catch (e) { ok("沙箱 iframe 里 SVG 真的被解析成节点（不只是源码字符串）", false, e.message); }

  section("② Worker 流式路径：允许代码块，不允许字面段落");
  for (const key of ["space", "four"]) {
    const workerHtml = await page.evaluate((src) => new Promise((res, rej) => {
      const w = new Worker("js/md-worker.js");
      const t = setTimeout(() => { w.terminate(); rej(new Error("worker 超时")); }, 5000);
      w.onmessage = (e) => { clearTimeout(t); w.terminate(); res((e.data && e.data.html) || ""); };
      w.onerror = (e) => { clearTimeout(t); w.terminate(); rej(new Error("worker error")); };
      w.postMessage({ id: 1, src });
    }), MD[key]);
    ok(key + "：Worker 认出了围栏（输出 code-block + lang）", workerHtml.includes('class="code-block"') && workerHtml.includes('code-lang">'), workerHtml.slice(0, 160));
    ok(key + "：Worker 没有把围栏吐成字面段落", !/<p>\s*`{3,}/.test(workerHtml), workerHtml.slice(0, 160));
  }

  section("②b 真流式事件序列：delta 期不吐字面围栏，end 后升级成卡片");
  const streamRes = await page.evaluate(async (svg) => {
    const id = "probe-stream-" + Date.now();
    const pane = convPanes[convId];
    const lastAI = () => Array.from(pane.querySelectorAll(".msg-ai")).pop();
    handleEvent({ type: "msg.start", id, convId });
    handleEvent({ type: "msg.delta", id, convId, text: "结论\n\n ```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"90\" height=\"40\">" });
    await new Promise((r) => setTimeout(r, 250));
    const duringEl = lastAI();
    const during = duringEl ? duringEl.innerHTML : "";
    handleEvent({ type: "msg.delta", id, convId, text: "<rect width=\"90\" height=\"40\" fill=\"#0a6ebd\"/></svg>\n ```\n" });
    await new Promise((r) => setTimeout(r, 250));
    handleEvent({ type: "msg.end", id, convId });
    await new Promise((r) => setTimeout(r, 500));
    const el = lastAI();
    const card = el ? el.querySelector(".msg-widget") : null;
    const srcdoc = card ? (card.querySelector("iframe").getAttribute("srcdoc") || "") : "";
    const b = convBlocks[convId] && convBlocks[convId][id];
    return {
      duringLen: during.length, during, card: !!card, srcdoc,
      after: el ? el.innerHTML.slice(-700) : "",
      buf: (b && b.buf || "").slice(-300),
      hasFence: typeof _hasWidgetFence === "function" ? _hasWidgetFence((b && b.buf) || "") : null,
      tail: !!(b && b._tailEl),
    };
  }, SVG);
  ok("delta 期没有把围栏画成字面段落", !/<p>\s*```/.test(streamRes.during), streamRes.during.slice(0, 160));
  ok("msg.end 后同一条消息里出现卡片", streamRes.card, JSON.stringify({ hasFence: streamRes.hasFence, tail: streamRes.tail, buf: streamRes.buf, after: streamRes.after }));
  ok("流式结束的卡片持有 SVG", streamRes.srcdoc.includes("<svg") && streamRes.srcdoc.includes("#0a6ebd"), streamRes.srcdoc.slice(0, 120));

  section("③ 旧快照：字面围栏段落被 hydratePane 升级回卡片");
  const legacyHtml = "<div class=\"msg msg-ai\"><p>结论</p>"
    + "<p> ```svg</p>"
    + "<p>&lt;svg xmlns=\"http://www.w3.org/2000/svg\" width=\"80\" height=\"40\"&gt;&lt;rect width=\"80\" height=\"40\" fill=\"#0a6ebd\"/&gt;&lt;/svg&gt;</p>"
    + "<p> ```</p></div>";
  const hydrated = await page.evaluate((legacy) => {
    const id = "probe-legacy-" + Date.now();
    const pane = hydratePane(id, legacy);
    const card = pane.querySelector(".msg-widget");
    const srcdoc = card ? (card.querySelector("iframe").getAttribute("srcdoc") || "") : "";
    try { delete convPanes[id]; } catch (e) {}
    return { isPane: pane.className, card: !!card, srcdoc, text: pane.textContent.slice(0, 120) };
  }, legacyHtml);
  ok("hydratePane 后出现 .msg-widget 卡片", hydrated.card, JSON.stringify(hydrated));
  ok("升级后的 iframe 持有 SVG 源码", hydrated.srcdoc.includes("<svg") && hydrated.srcdoc.includes("#0a6ebd"), hydrated.srcdoc.slice(0, 120));
  ok("原文里的字面围栏/段落不再残留", !/```/.test(hydrated.text), hydrated.text);

  /* 用户真实 localStorage 快照（cw-convdom-v1:kal7pt:cmvf8slfa8nzk）就是这个形状：
     四个反引号开围栏，SVG 每一行被存成一个独立 <p>。 */
  const legacyFour = "<div class=\"msg msg-ai\" data-final-label=\"结论\"><p>结论</p>"
    + "<p>````widget</p>"
    + "<p>&lt;svg viewBox=\"0 0 640 420\" xmlns=\"http://www.w3.org/2000/svg\"&gt;</p>"
    + "<p>  &lt;defs&gt;</p>"
    + "<p>    &lt;linearGradient id=\"g\"&gt;&lt;stop offset=\"0\" stop-color=\"#0a6ebd\"/&gt;&lt;/linearGradient&gt;</p>"
    + "<p>  &lt;/defs&gt;</p>"
    + "<p>  &lt;rect width=\"640\" height=\"420\" fill=\"url(#g)\"/&gt;</p>"
    + "<p>  &lt;circle cx=\"320\" cy=\"210\" r=\"80\" fill=\"#fff\"/&gt;</p>"
    + "<p>&lt;/svg&gt;</p>"
    + "<p>````</p></div>";
  const hydratedFour = await page.evaluate((legacy) => {
    const id = "probe-legacy-four-" + Date.now();
    const pane = hydratePane(id, legacy);
    const card = pane.querySelector(".msg-widget");
    const srcdoc = card ? (card.querySelector("iframe").getAttribute("srcdoc") || "") : "";
    try { delete convPanes[id]; } catch (e) {}
    return { card: !!card, srcdoc, text: pane.textContent.slice(0, 160) };
  }, legacyFour);
  ok("四个反引号的旧快照 hydratePane 后也出卡片", hydratedFour.card, JSON.stringify(hydratedFour));
  ok("四个反引号快照的 iframe 里是多行完整 SVG", hydratedFour.srcdoc.includes("<svg") && hydratedFour.srcdoc.includes("linearGradient") && hydratedFour.srcdoc.includes("<circle"), hydratedFour.srcdoc.slice(0, 160));
  ok("四个反引号快照升级后无字面围栏残留", !/````?/.test(hydratedFour.text), hydratedFour.text);

  /* 讲围栏语法的正文里也会出现 ```widget，不能被误升级成图 */
  const tutorialHtml = "<div class=\"msg msg-ai\"><p>| 输出 | 做法 |</p>"
    + "<p>| 可下载的 SVG/PNG 图 | 直接发 ```widget 代码块 |</p><p>说明文字。</p></div>";
  const tutorial = await page.evaluate((legacy) => {
    const id = "probe-tutorial-" + Date.now();
    const pane = hydratePane(id, legacy);
    const r = { card: !!pane.querySelector(".msg-widget"), text: pane.textContent.slice(0, 160) };
    try { delete convPanes[id]; } catch (e) {}
    return r;
  }, tutorialHtml);
  ok("正文里的行内 ```widget 提法不会被误升级", !tutorial.card, JSON.stringify(tutorial));
  ok("讲解文字原样保留", tutorial.text.includes("直接发 ```widget 代码块"), tutorial.text);

  section("④ 产物卡片：点击查看 / 图片鉴权 / 在文件夹中显示");
  await page.evaluate(() => {
    window.pancodeWin = {
      revealPath: (rel) => { window.__revealed = rel; return Promise.resolve({ ok: true }); },
      openFolder: (rel) => { window.__openedFolder = rel; return Promise.resolve({ ok: true }); },
    };
    state.convArtifacts = state.convArtifacts || {};
    state.convArtifacts[convId] = [
      { path: "art.svg", kind: "svg", label: "SVG", isNew: true },
      { path: "pic.png", kind: "image", label: "图片" },
      { path: "notes.md", kind: "markdown", label: "Markdown" },
    ];
    renderArtifacts();
  });
  await page.click("#btnModeAgents");
  await page.waitForTimeout(500);
  await page.click("#agTabArtifacts");
  await page.waitForTimeout(300);
  ok("产物面板列出三张卡片", await page.locator("#agArtifacts .af-card").count() === 3);

  /* 目录页没有缓存这个路径 → openFile 本来会静默 no-op；openArtifact 必须补元数据 */
  await page.evaluate(() => { delete state.files["notes.md"]; });
  await page.locator("#agArtifacts .af-card", { hasText: "notes.md" }).click();
  await page.waitForTimeout(900);
  const mdState = await page.evaluate(() => ({ active: state.activeFile, tabs: state.openTabs.slice(), previewOn }));
  ok("点击 Markdown 产物真的打开（路径不在 state.files 也能开）", mdState.active === "notes.md" && mdState.tabs.includes("notes.md"), JSON.stringify(mdState));
  ok("Markdown 产物顺手打开预览", mdState.previewOn === true, JSON.stringify(mdState));

  await page.evaluate(() => { delete state.files["pic.png"]; });
  await page.locator("#agArtifacts .af-card", { hasText: "pic.png" }).click();
  let imgOk = false, imgSrc = "", imgMeta = "";
  try {
    await page.waitForFunction(() => {
      const img = document.querySelector("#binPreviewBody img");
      return !!(img && img.src.startsWith("blob:") && img.naturalWidth > 0);
    }, null, { timeout: 5000 });
    imgOk = true;
  } catch (e) {}
  imgSrc = await page.evaluate(() => { const i = document.querySelector("#binPreviewBody img"); return i ? i.src : ""; });
  imgMeta = await page.evaluate(() => (document.querySelector("#binPreviewBody .bp-meta") || {}).textContent || "");
  ok("图片产物点开后用鉴权 blob 成功解码（naturalWidth>0，不是 401 空图）", imgOk, imgSrc.slice(0, 80));
  ok("图片元信息带上了真实字节数（不是 0 B）", /·\s*\d+\s*B/.test(imgMeta) && !/·\s*0\s*B/.test(imgMeta), imgMeta);

  const beforeReveal = await page.evaluate(() => state.activeFile);
  await page.evaluate(() => { window.__revealed = ""; });
  await page.locator("#agArtifacts .af-card", { hasText: "pic.png" }).locator(".af-reveal").click();
  await page.waitForTimeout(400);
  const reveal = await page.evaluate(() => ({ rel: window.__revealed, active: state.activeFile }));
  ok("文件夹按钮把相对路径递给桌面桥", reveal.rel === "pic.png", JSON.stringify(reveal));
  ok("点文件夹按钮不会顺带打开文件（stopPropagation）", reveal.active === beforeReveal, JSON.stringify({ beforeReveal, reveal }));

  section("⑤ 文件树右键入口");
  await page.click("#btnModeEditor");
  await page.waitForTimeout(800);
  const fileItem = page.locator("#fileTree .ft-item", { hasText: "notes.md" }).first();
  await fileItem.click({ button: "right" });
  await page.waitForTimeout(200);
  const menuTxt = await page.locator("#ctxMenu").innerText();
  ok("文件右键有「在文件夹中显示」", menuTxt.includes("在文件夹中显示"), menuTxt.replace(/\n/g, " | "));
  await page.evaluate(() => { window.__revealed = ""; });
  await page.locator("#ctxMenu .ctx-item", { hasText: "在文件夹中显示" }).click();
  await page.waitForTimeout(300);
  ok("文件右键条目调用 revealPath", await page.evaluate(() => window.__revealed === "notes.md"));

  const dirHead = page.locator("#fileTree .ft-dir-head").first();
  if (await dirHead.count()) {
    await dirHead.click({ button: "right" });
    await page.waitForTimeout(200);
    const dirMenu = await page.locator("#ctxMenu").innerText();
    ok("目录右键有「打开文件夹」", dirMenu.includes("打开文件夹"), dirMenu.replace(/\n/g, " | "));
    await page.evaluate(() => { window.__openedFolder = ""; });
    await page.locator("#ctxMenu .ctx-item", { hasText: "打开文件夹" }).click();
    await page.waitForTimeout(300);
    ok("目录右键条目调用 openFolder", await page.evaluate(() => !!window.__openedFolder), await page.evaluate(() => String(window.__openedFolder)));
  } else {
    ok("文件树里至少有一个目录可右键", false, "没有 .ft-dir-head");
  }

  section("⑥ 过程里不能有渲染报错");
  ok("没有 console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.screenshot({ path: path.join(OUT, "widgetfence.png") });

  console.log("\n\x1b[1m围栏/产物验收：\x1b[0m " + pass + " 通过 / " + fail + " 失败");
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
