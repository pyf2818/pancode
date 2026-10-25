/* ============================================================
   编辑器异步状态验收（三处"看起来已经完成"的假象）

   这三条都不是渲染样式问题，读代码也看不出：它们只在"用户比 ack 快"时露馅。

   1. 保存 ack 竞态：保存 A 之后继续敲出 B，旧代码在 ack 回来时把**此刻编辑器里的内容**
      当成已落盘内容 → 脏点消失、关页不提醒，而 B 从未写到磁盘。判据必须卡在
      "ack 只认它对应的那份内容"上：seq1 的 ack 到达后，编辑器里的 v3 仍然是脏的。
   2. 内联 AI 编辑的目标漂移：请求发出后用户切文件 / 改了选区文字，旧代码直接
      executeEdits 把结果写进另一个 model 或错位区间。判据：拒绝并给出提示，目标文件内容不变。
   3. 后台会话审批卡归属：tool.pending 不带进 withConv 时，后台会话的审批卡会弹在
      当前正在看的另一条会话里。判据：卡片只出现在它自己的 conv pane，活跃 pane 里没有。

   保存 ack 用假 send 精确控制时序；真实落盘另走一遍真 send + 真服务端，确认 seq 端到端回显。
   ============================================================ */
"use strict";
const sb = require("./_sandbox").create({
  tag: "editorasync",
  wsFiles: {
    "a.js": "alpha beta gamma\n// original\n",
    "b.js": "// b file untouched\nconst b = 1;\n",
  },
});

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 8865);
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

const V2 = "const value = 2;\n// v2\n";
const V3 = "const value = 3;\n// v3\n";
const V4 = "const value = 4;\n// real-save\n";
const EDITED = "EDITED_TEXT";

(async () => {
  if (!await waitServer(20000)) { console.log(childLog.slice(-2000)); throw new Error("服务端没起来（端口 " + PORT + "）"); }
  const base = `http://127.0.0.1:${PORT}`;
  const user = "editorasync_" + Date.now();
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
  /* 内联编辑的模型调用不走真网关：探针要验的是"结果回来后目标是否还有效"，不是模型质量。 */
  await page.route("**/api/edit", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, text: EDITED }),
  }));

  await page.goto(base + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => typeof state !== "undefined" && state.monacoReady && state.files && state.files["a.js"], null, { timeout: 20000 });
  await page.waitForTimeout(800);
  const editorBtn = await page.$("#btnModeEditor");
  if (editorBtn) { await editorBtn.click(); await page.waitForTimeout(400); }
  await page.locator("#fileTree .ft-item", { hasText: "a.js" }).first().click();
  await page.waitForTimeout(500);

  section("① 保存 ack 只认这一次请求的内容（用户在等 ack 时继续打字）");
  const opened = await page.evaluate(() => {
    openFile("a.js");
    return {
      active: state.activeFile,
      model: models["a.js"] ? models["a.js"].getValue() : null,
      disk: state.files["a.js"] ? state.files["a.js"].content : null,
      dirty: state.dirty.has("a.js"),
    };
  });
  ok("a.js 已打开且模型与磁盘内容一致", opened.active === "a.js" && opened.model === opened.disk && !opened.dirty,
    JSON.stringify(opened));

  /* 接管 send：不让保存帧真的到服务端，ack 由探针按 seq 精确投递。 */
  const stubbed = await page.evaluate(() => {
    window.__sent = [];
    window.__realSend = window.send;
    window.send = (o) => {
      try { window.__sent.push(JSON.parse(JSON.stringify(o))); }
      catch (e) { window.__sent.push({ type: o && o.type }); }
    };
    window.send({ type: "probe.noop" });
    return window.__sent.length;
  });
  ok("send 已被探针接管（自检帧能被捕获）", stubbed === 1, String(stubbed));

  const firstSave = await page.evaluate((v2) => {
    models["a.js"].setValue(v2);
    const dirtyAfterEdit = state.dirty.has("a.js");
    saveActiveFile();
    const frame = window.__sent[window.__sent.length - 1];
    return {
      dirtyAfterEdit,
      frame,
      pending: (state.pendingSaves["a.js"] || []).slice(),
    };
  }, V2);
  ok("编辑后文件变脏", firstSave.dirtyAfterEdit === true, JSON.stringify(firstSave));
  ok("保存帧带 path / content / seq，内容是**这次**发出的 v2",
    firstSave.frame && firstSave.frame.type === "file.save" && firstSave.frame.path === "a.js" &&
      firstSave.frame.content === V2 && typeof firstSave.frame.seq === "number",
    JSON.stringify(firstSave.frame));
  ok("发出后进入 pendingSaves（等 ack）", firstSave.pending.length === 1 && firstSave.pending[0].seq === firstSave.frame.seq,
    JSON.stringify(firstSave.pending));

  /* 等 ack 的窗口里继续敲字 → v3。旧代码会把这个 v3 当成"已落盘"。 */
  const afterOldAck = await page.evaluate((args) => {
    models["a.js"].setValue(args.v3);
    handleEvent({ type: "file.saved", path: "a.js", seq: args.seq });
    return {
      disk: state.files["a.js"].content,
      model: models["a.js"].getValue(),
      dirty: state.dirty.has("a.js"),
      pending: state.pendingSaves["a.js"] || null,
    };
  }, { v3: V3, seq: firstSave.frame.seq });
  ok("seq1 的 ack 只把 v2 记成磁盘内容（不拿此刻编辑器里的 v3 冒充）",
    afterOldAck.disk === V2, JSON.stringify(afterOldAck));
  ok("编辑器里的 v3 仍然算脏（旧代码在这里会清掉脏点、关页也不提醒）",
    afterOldAck.dirty === true && afterOldAck.model === V3, JSON.stringify(afterOldAck));
  ok("ack 到齐后 pendingSaves 清空", afterOldAck.pending === null, JSON.stringify(afterOldAck.pending));

  const afterRepeatAck = await page.evaluate((seq) => {
    handleEvent({ type: "file.saved", path: "a.js", seq });
    return { disk: state.files["a.js"].content, dirty: state.dirty.has("a.js") };
  }, firstSave.frame.seq);
  ok("旧 seq 的重复 ack 不会把后来的内容标成已保存",
    afterRepeatAck.disk === V2 && afterRepeatAck.dirty === true, JSON.stringify(afterRepeatAck));

  const secondSave = await page.evaluate(() => {
    saveActiveFile();
    return window.__sent[window.__sent.length - 1];
  });
  const afterNewAck = await page.evaluate((args) => {
    handleEvent({ type: "file.saved", path: "a.js", seq: args.seq });
    return {
      disk: state.files["a.js"].content,
      model: models["a.js"].getValue(),
      dirty: state.dirty.has("a.js"),
      pending: state.pendingSaves["a.js"] || null,
    };
  }, { seq: secondSave.seq });
  ok("新一次保存的 ack 才清脏点，且磁盘内容换成 v3",
    secondSave.seq !== firstSave.frame.seq && afterNewAck.disk === V3 && afterNewAck.dirty === false &&
      afterNewAck.model === V3 && afterNewAck.pending === null,
    JSON.stringify({ secondSave, afterNewAck }));

  section("② 真实保存走服务端：seq 端到端回显、文件真的落盘");
  await page.evaluate((v4) => {
    window.send = window.__realSend;
    models["a.js"].setValue(v4);
    saveActiveFile();
  }, V4);
  let savedForReal = true;
  try {
    await page.waitForFunction((v4) => !state.dirty.has("a.js") &&
      state.files["a.js"] && state.files["a.js"].content === v4, V4, { timeout: 6000 });
  } catch (e) { savedForReal = false; }
  const diskText = fs.readFileSync(path.join(sb.wsDir, "a.js"), "utf8");
  ok("服务端 ack 回来后脏点消失、state.files 内容对齐 v4", savedForReal);
  ok("沙箱工作区里的 a.js 真的是 v4（不是只在界面上显示已保存）", diskText === V4, JSON.stringify(diskText));
  await page.screenshot({ path: path.join(OUT, "editorasync-saveack.png") });

  section("③ 内联 AI 编辑：目标漂移必须拒绝，不能写错文件");
  async function openInlineBox() {
    await page.evaluate(() => {
      const p = state.activeFile;
      editor.setModel(models[p]);
      editor.setSelection(new monaco.Range(1, 1, 1, 6));
      editor.focus();
    });
    await page.keyboard.press("Control+k");
    await page.waitForSelector("#inlineEditBox", { timeout: 4000 });
  }
  async function runFakeEdit() {
    await page.fill("#inlineEditBox .ie-input", "rewrite this");
    await page.press("#inlineEditBox .ie-input", "Enter");
    await page.waitForFunction(() => {
      const b = document.querySelector("#inlineEditBox .ie-accept");
      return b && !b.disabled;
    }, null, { timeout: 5000 });
    return page.evaluate(() => document.querySelector("#inlineEditBox .ie-preview").textContent);
  }

  await page.evaluate(() => { models["a.js"].setValue("alpha beta gamma\n"); openFile("a.js"); });
  await openInlineBox();
  ok("Ctrl+K 在选区上打开内联编辑框", true);
  const preview1 = await runFakeEdit();
  ok("假网关的结果进入预览、接受按钮启用", preview1 === EDITED, preview1);

  /* 场景 A：请求期间选区文字被改动 → 拒绝，且文件不被结果覆盖 */
  const staleSel = await page.evaluate((edited) => {
    models["a.js"].setValue("ALPHA beta gamma\n");
    document.querySelector("#inlineEditBox .ie-accept").click();
    return {
      title: document.querySelector("#inlineEditBox .ie-title").textContent,
      expect: t("ieTargetChanged"),
      model: models["a.js"].getValue(),
      overwritten: models["a.js"].getValue().includes(edited),
    };
  }, EDITED);
  ok("选区文字已变时点接受：提示目标已改变", staleSel.title === staleSel.expect, JSON.stringify(staleSel));
  ok("结果没有写进文件（旧代码会把 EDITED 覆盖到新选区上）",
    staleSel.overwritten === false && staleSel.model === "ALPHA beta gamma\n", JSON.stringify(staleSel));

  /* 场景 B：选区未变 → 正常应用并关框 */
  await openInlineBox();
  await runFakeEdit();
  const applied = await page.evaluate((edited) => {
    document.querySelector("#inlineEditBox .ie-accept").click();
    return {
      model: models["a.js"].getValue(),
      boxGone: !document.getElementById("inlineEditBox"),
    };
  }, EDITED);
  ok("选区未变时接受，结果写进当前 model 并关闭编辑框",
    applied.model.includes(EDITED) && applied.boxGone === true, JSON.stringify(applied));

  /* 场景 C：请求期间切到另一个文件 → 框收起，旧的接受按钮不能再写 */
  await page.evaluate(() => { window.__ieOld = null; });
  await openInlineBox();
  await page.evaluate(() => { window.__ieOld = document.getElementById("inlineEditBox"); });
  await runFakeEdit();
  await page.locator("#fileTree .ft-item", { hasText: "b.js" }).first().click();
  await page.waitForTimeout(400);
  const switched = await page.evaluate((edited) => {
    const bBefore = "// b file untouched\nconst b = 1;\n";
    const old = window.__ieOld;
    const gone = !document.getElementById("inlineEditBox");
    const b = models["b.js"].getValue();
    if (old && old.querySelector) old.querySelector(".ie-accept").click();
    return {
      active: state.activeFile,
      gone,
      b,
      bUntouched: b === bBefore,
      title: old && old.querySelector ? old.querySelector(".ie-title").textContent : "",
      expect: t("ieTargetChanged"),
      bOverwritten: b.includes(edited),
    };
  }, EDITED);
  ok("切文件时内联编辑框从 DOM 收起", switched.gone === true, JSON.stringify(switched));
  ok("切换后 b.js 成为活跃文件且内容原样", switched.active === "b.js" && switched.bUntouched === true,
    JSON.stringify(switched));
  ok("对已失焦的旧框点接受：提示目标已改变，没有写进 b.js",
    switched.title === switched.expect && switched.bOverwritten === false, JSON.stringify(switched));
  await page.screenshot({ path: path.join(OUT, "editorasync-inline.png") });

  section("④ 后台会话的审批卡只落在自己的 pane");
  const routed = await page.evaluate(() => {
    const before = convId;
    ensureConvCtx("probeB");
    handleEvent({
      type: "tool.pending", convId: "probeB", id: "apB1", tool: "run_command",
      danger: "low", round: 1, preview: { command: "echo B-only" },
    });
    const paneB = convPanes.probeB;
    return {
      before,
      convUnchanged: convId === before,
      inB: !!(paneB && paneB.querySelector(".approval .btn-approve")),
      cmdInB: !!(paneB && paneB.textContent.includes("echo B-only")),
      bDetached: !!(paneB && !paneB.parentNode),
      inActive: document.querySelectorAll("#chatStream .approval").length,
      activeHasIt: !!(convPanes[before] && convPanes[before].querySelector(".approval")),
      blocksBound: !!(convBlocks.probeB && convBlocks.probeB["ap_apB1"]),
    };
  });
  ok("tool.pending(convId=B) 不改变当前会话", routed.convUnchanged === true, JSON.stringify(routed));
  ok("审批卡出现在 B 自己的 pane 里（带真实命令细节）", routed.inB === true && routed.cmdInB === true,
    JSON.stringify(routed));
  ok("B 的 pane 仍处于后台（未挂进活跃的 chatStream）", routed.bDetached === true, JSON.stringify(routed));
  ok("当前会话的 pane 里没有这张卡（旧代码会弹在这里）",
    routed.inActive === 0 && routed.activeHasIt === false, JSON.stringify(routed));
  ok("审批卡登记到 B 的 blocks（服务端超时收尾能找到它）", routed.blocksBound === true, JSON.stringify(routed));

  section("⑤ 过程里不能冒出渲染报错");
  ok("没有 console error / pageerror", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log("\n\x1b[1m编辑器异步验收：\x1b[0m " + pass + " 通过 / " + fail + " 失败");
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
