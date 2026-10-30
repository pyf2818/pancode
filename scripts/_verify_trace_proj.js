/* ============================================================
   审查项 F18 验收：Trace 面板是可重建投影，不是"来一条加一次"的累加器
   ————————————————————————————————————————————————————
   旧形态四笔账（这一支逐条钉住）：
     ① 事件没有身份：历史回看走的是与实时同一条"全局计数器 +1"的路 ——
        A→B→A 把 A 的历史再数一遍；重连两次就叠两层，数字只会虚高。
     ② 事件不带归属：后台会话那一轮的事件也往当前面板的账上加（串会话）。
     ③ 读历史只看 anon 目录，而写的人按用户分目录（agent-traces/<userKey>/）——
        登录用户切回会话，历史永远是空的。
     ④ 拉历史没有异步守卫：A 的回包晚到，会盖掉正在看的 B。
   口径：①②的"真事件形状"由真服务端 + 假上游跑一轮抓下来（不编形状），
        ③④在真页面上用抓到的形状重放 —— 被测的是投影本身，
        形状对不对由第①节那条判据兜住。
   ============================================================ */
"use strict";
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const LLM_PORT = 8909;
const PORT = 8908;

const SANDBOX = require("./_sandbox").create({
  tag: "traceproj",
  wsFiles: { "src/app.js": "export const a = 1;\nexport const b = 2;\n", "README.md": "# demo\n" },
  config: {
    agentMode: "auto",
    permissions: { mode: "auto", allow: [], deny: [] },
    llm: {
      baseURL: "http://127.0.0.1:" + LLM_PORT + "/v1",
      apiKey: "fake-key", model: "fake-model", contextWindow: 32000,
      idleTimeout: 8000, connectTimeout: 15000,
    },
  },
});

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const fails = [];
const metrics = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
function measure(name, value, unit) { metrics.push({ name, value, unit }); console.log("  \x1b[36m◦\x1b[0m " + name + "：\x1b[1m" + value + "\x1b[0m " + unit); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 400); } catch (e) { return String(v).slice(0, 400); } };

/* ---------- 假上游：一轮里有正文、有一次工具调用，trace 才有东西可记 ---------- */
let toolDone = false;
function sse(res, obj) { res.write("data: " + JSON.stringify(obj) + "\n\n"); }
function endOk(res) { sse(res, "[DONE]"); try { res.end(); } catch (e) {} }
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = null; try { parsed = JSON.parse(body || "{}"); } catch (e) {}
    const msgs = (parsed && parsed.messages) || [];
    const hasToolResult = msgs.some((m) => m.role === "tool");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    if (!hasToolResult) {
      sse(res, { choices: [{ delta: { content: "我先看一眼文件。" }, finish_reason: null }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/app.js" }) } }] }, finish_reason: "tool" }] });
      endOk(res);
      toolDone = true;
      return;
    }
    sse(res, { choices: [{ delta: { content: "看完了，两个导出都在。" }, finish_reason: null }] });
    sse(res, { choices: [{ delta: {}, finish_reason: "stop", usage: { prompt_tokens: 1200, completion_tokens: 34, total_tokens: 1234 } }] });
    endOk(res);
  });
});

function req(method, urlPath, body, token) {
  const data = body == null ? null : JSON.stringify(body);
  const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
  if (token) headers["x-user-token"] = token;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 30000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, json: { raw: buf.slice(0, 200) } }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  upstream.listen(LLM_PORT, "127.0.0.1");
  const env = SANDBOX.env({ PORT: String(PORT), HOME: path.join(SANDBOX.root, "home"), USERPROFILE: path.join(SANDBOX.root, "home") });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], { cwd: ROOT, env, windowsHide: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (out.includes("已启动")) break; await wait(150); }
  if (!out.includes("已启动")) throw new Error("服务端没起来：" + out.slice(-400));

  const reg = await req("POST", "/api/auth/register", { username: "_tp_" + Date.now(), password: "test1234" });
  const token = reg.json && reg.json.token;
  if (!token) throw new Error("注册失败：" + J(reg.json));
  /* 另一个用户：只为了证明历史端点不会把别人的会话翻出来 */
  const reg2 = await req("POST", "/api/auth/register", { username: "_tp2_" + Date.now(), password: "test1234" });
  const token2 = reg2.json && reg2.json.token;

  const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); setTimeout(() => rej(new Error("ws 超时")), 8000); });

  const convA = "trace-proj-a";
  const captured = [];
  ws.on("message", (raw) => {
    let m = null; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.type === "agent.trace") captured.push(m.event);
  });

  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErr = [];
  page.on("pageerror", (e) => pageErr.push(String(e && e.message)));
  await page.addInitScript((tk) => { try { localStorage.setItem("cw-user-token", tk); localStorage.setItem("cw-onboarded", "1"); } catch (e) {} }, token);

  try {
    /* ================= ① 真事件带身份与归属 ================= */
    section("① 一轮真跑完：trace 事件带 convId / eid（后面全用这个形状重放）");
    ws.send(JSON.stringify({ type: "chat", text: "看看 src/app.js 里有什么", attachments: [], convId: convA }));
    const t1 = Date.now();
    while (Date.now() - t1 < 60000 && !captured.some((e) => e.type === "tool.call")) await wait(200);
    await wait(800);   // 等 trace 批量落盘（400ms 一刷）
    ok("假上游真的被打了、工具真的跑了（阳性对照）", toolDone && captured.length >= 2, "抓到 " + captured.length + " 条：" + captured.map((e) => e.type).join(","));
    ok("每条事件都带这条会话的 convId", captured.length > 0 && captured.every((e) => e.convId === convA), J(captured.slice(0, 2)));
    ok("每条事件都带可判重的身份 eid", captured.every((e) => !!e.eid), J(captured[0] || {}));
    ok("同一条会话里 eid 互不相同（重放时才能认出重复）",
      new Set(captured.map((e) => e.eid)).size === captured.length, "条数=" + captured.length);

    /* ================= ② 历史端点与写入端同源 ================= */
    section("② 历史端点读的是写的那个目录（登录用户不该永远看到空面板）");
    const hist = await req("GET", "/api/agent/trace/history?conv=" + encodeURIComponent(convA), null, token);
    const evs = (hist.json && hist.json.events) || [];
    ok("同一用户回看这条会话，历史里真的有事件（不是空数组）",
      hist.status === 200 && evs.length >= 2, J({ status: hist.status, n: evs.length, body: hist.json }));
    ok("拉回来的每条都归属这条会话", evs.length > 0 && evs.every((e) => e.convId === convA), J(evs.slice(0, 1)));
    ok("带 eid（前端才可能判重）", evs.every((e) => !!e.eid), "条数=" + evs.length);
    const other = await req("GET", "/api/agent/trace/history?conv=" + encodeURIComponent(convA), null, token2);
    ok("换个用户读同一条会话读不到东西（目录隔离没被这行改动弄漏）",
      other.status === 200 && ((other.json && other.json.events) || []).length === 0, J(other.json));

    /* 这一条说的是"以前为什么永远是空的"的机制本身：
       写的人落在 agent-traces/<userKey>/<conv>.jsonl，读的人以前只看 anon 根目录。
       直接点两个路径在不在，比任何解释都硬。 */
    const fsx = require("fs");
    const crypto = require("crypto");
    const uKey = "u" + crypto.createHash("md5").update(token).digest("hex").slice(0, 8);
    const userFile = path.join(SANDBOX.dataDir, ".pancode", "agent-traces", uKey, convA + ".jsonl");
    const anonFile = path.join(SANDBOX.dataDir, ".pancode", "agent-traces", convA + ".jsonl");
    ok("落盘确实在按用户分目录，而旧读取点（anon 根目录）根本没有这个文件",
      fsx.existsSync(userFile) && !fsx.existsSync(anonFile),
      "用户目录=" + fsx.existsSync(userFile) + " anon 目录=" + fsx.existsSync(anonFile));

    /* ================= 页面起来，用真形状重放 ================= */
    await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => typeof onTraceEvent === "function" && typeof loadTraceHistory === "function" && !!document.getElementById("traceList"), null, { timeout: 30000 });

    /* ================= ③ 重复/交错/来回切都不许累加 ================= */
    section("③ 同一批事件重放两次：数字必须由事件源算出来，且与次数无关");
    /* 这一段只用界面上看得见的东西（计数器文本 + 列表行数）说话，不去读实现内部的全局量 ——
       读内部字段会让这支探针在改版前直接抛 ReferenceError，红是红了，但指不出是哪个行为坏了。 */
    const replay = await page.evaluate((evs) => {
      const read = () => ({
        rounds: Number(document.getElementById("traceRounds").textContent || 0),
        tools: Number(document.getElementById("traceTools").textContent || 0),
        count: document.getElementById("agTraceCount").textContent,
        rows: document.querySelectorAll("#traceList .trace-row").length,
      });
      clearTrace();
      for (const e of evs) onTraceEvent(e, false);
      const once = read();
      for (const e of evs) onTraceEvent(e, false);          // 整批重放（重连补发的形态）
      const twice = read();
      for (const e of evs.slice(0, 2)) onTraceEvent(e, true); // 历史与实时交错
      const mixed = read();
      return { once, twice, mixed, n: evs.length };
    }, captured);
    const typesOf = (evs) => evs.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {});
    const wantRounds = typesOf(captured)["llm.round"] || 0;
    const wantTools = typesOf(captured)["tool.call"] || 0;
    measure("重放一遍：轮数/工具数/面板条数", replay.once.rounds + " / " + replay.once.tools + " / " + replay.once.count, "");
    ok("第一遍的数字与事件源算出来的一致（轮数=" + wantRounds + "、工具数=" + wantTools + "）",
      replay.once.rounds === wantRounds && replay.once.tools === wantTools, J(replay.once));
    ok("整批重放第二遍，数字一个都不涨（旧代码：这里直接翻倍）",
      replay.twice.rounds === replay.once.rounds && replay.twice.tools === replay.once.tools && replay.twice.rows === replay.once.rows,
      J({ once: replay.once, twice: replay.twice }));
    ok("历史与实时交错也只算一次",
      replay.mixed.rounds === replay.once.rounds && replay.mixed.tools === replay.once.tools, J(replay.mixed));

    /* ================= ④ 串会话：后台那一轮不许记到当前面板头上 ================= */
    section("④ 后台会话的事件不进当前会话的账");
    const cross = await page.evaluate((evs) => {
      clearTrace();
      const base = evs[0];
      const a1 = Object.assign({}, base, { eid: "a-only-1", convId: base.convId, type: "llm.round", data: { rounds: 1 } });
      const b1 = Object.assign({}, base, { eid: "b-only-1", convId: "another-conv", type: "llm.round", data: { rounds: 1 } });
      onTraceEvent(a1, false);
      const before = Number(document.getElementById("traceRounds").textContent || 0);
      onTraceEvent(b1, false);                       // 另一条会话的事件
      const after = Number(document.getElementById("traceRounds").textContent || 0);
      return { before, after };
    }, captured);
    ok("别的会话的事件不改变当前面板的轮数", cross.before === cross.after && cross.after >= 1, J(cross));

    /* ================= ⑤ 晚到的历史不盖当前会话 ================= */
    section("⑤ A 的历史回包晚到，也不能盖掉正在看的 B");
    await page.route("**/api/agent/trace/history*", async (route) => {
      const url = route.request().url();
      const conv = decodeURIComponent((url.match(/conv=([^&]*)/) || [])[1] || "");
      if (conv === "slow-A") { await new Promise((r) => setTimeout(r, 900)); }
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        ok: true,
        events: conv === "slow-A"
          ? [Object.assign({}, captured[0], { eid: "slow-1", convId: "slow-A", type: "llm.round", data: { rounds: 9 } }),
             Object.assign({}, captured[0], { eid: "slow-2", convId: "slow-A", type: "llm.round", data: { rounds: 9 } })]
          : [],
      }) });
    });
    const late = await page.evaluate(async () => {
      clearTrace();
      const p = loadTraceHistory("slow-A");          // 这次回包要 900ms
      await new Promise((r) => setTimeout(r, 120));
      const q = loadTraceHistory("fresh-B");         // 用户已经切走，看的是 B（B 没有历史）
      await q; await p;
      return {
        rounds: Number(document.getElementById("traceRounds").textContent || 0),
        rows: document.querySelectorAll("#traceList .trace-row").length,
      };
    });
    ok("晚到的 A 历史没有把正在看的 B 改写", late.rounds === 0 && late.rows === 0, J(late));
    await page.unroute("**/api/agent/trace/history*");

    /* ================= ⑥ 数字不由 DOM 猜 ================= */
    section("⑥ 列表按上限截断，条数说的是事件源而不是画出来的行数");
    const cap = await page.evaluate(() => {
      clearTrace();
      for (let i = 0; i < 250; i++) onTraceEvent({ eid: "cap-" + i, seq: i, t: Date.now(), type: "llm.round", data: { rounds: i }, convId: "conv-cap" }, false);
      return {
        rows: document.querySelectorAll("#traceList .trace-row").length,
        count: document.getElementById("agTraceCount").textContent,
        rounds: Number(document.getElementById("traceRounds").textContent || 0),
        empty: !!document.querySelector("#traceList .trace-empty"),
      };
    });
    measure("250 条事件 · 画出的行数", cap.rows, "行");
    measure("250 条事件 · 面板报的事件数", cap.count, "");
    ok("事件数按事件源算（250 条），画出来的行只留最后 200 条",
      cap.rows === 200 && /250/.test(cap.count) && cap.rounds === 250, J(cap));
    ok("截断之后没有把空态行当成数据（也没抛错）", cap.empty === false && pageErr.length === 0, J({ empty: cap.empty, err: pageErr.slice(0, 2) }));

    ok("整条链路页面没有报错", pageErr.length === 0, pageErr.slice(0, 3).join(" | "));
  } catch (e) {
    ok("探针整条链路没抛错", false, (e && e.stack ? e.stack : String(e)).slice(0, 400));
  } finally {
    console.log("\n\x1b[1m量到的数\x1b[0m");
    for (const m of metrics) console.log("  " + m.name + " = " + m.value + " " + m.unit);
    console.log("\n共 " + (pass + fail) + " 条，红 " + fail + " 条");
    if (fail) { console.log("\n失败明细："); fails.forEach((f, i) => console.log("  " + (i + 1) + ". " + f)); }
    try { await browser.close(); } catch (e) {}
    try { ws.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    try { upstream.close(); } catch (e) {}
    SANDBOX.cleanup();
    process.exit(fail ? 1 : 0);
  }
})();
