/* ============================================================
   P3-D1 可审计决策链 —— 端到端验收
   验的是三件事，缺一不可：
     ① 真的决策点会落盘（假网关把工具调用喂进真实 ReAct 循环 → 真权限门 → 真 JSONL）；
     ② 落盘的内容能回答「谁定的、为什么」（action / reason / convId / 不可撤回旗标）；
     ③ 界面能把一整局的决策顺序还原出来（工作台 → 审计 → 决策链）。
   每条否定断言前都配了正向对照（先证明这条记录真存在），否则测的是「什么都没发生」。
   全程沙箱数据根，不碰开发者的 .pancode。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({
  tag: "decisions",
  wsFiles: {
    "read.txt": "可读内容\n",
    "dec-secret.txt": "被 deny 规则护住的文件\n",
  },
});

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.DECISIONS_PORT || 8827);
const WS_DIR = SANDBOX.wsDir;
const DEC_DIR = path.join(SANDBOX.dataDir, ".pancode", "decisions");
const AUD_LOG = path.join(SANDBOX.dataDir, ".pancode", "audit");
const OUT = path.join(ROOT, "scripts", "_verify_out");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 300); } catch (e) { return String(v).slice(0, 300); } };
const today = () => new Date().toISOString().slice(0, 10);

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (token) headers["x-user-token"] = token;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 15000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, json: { raw: buf.slice(0, 200) } }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

/* ---------- 假网关：按【场景】决定吐哪个 tool_call ---------- */
function startGateway() {
  return new Promise((res) => {
    const srv = http.createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c) => (body += c));
      rq.on("end", () => {
        if (!/chat\/completions$/.test(rq.url || "")) { rs.writeHead(404); return rs.end(); }
        let j = {}; try { j = JSON.parse(body || "{}"); } catch (e) {}
        const asText = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""));
        const msgs = j.messages || [];
        const hit = msgs.filter((m) => m.role === "user").map(asText).filter((s) => /【场景[^\]】]*】/.test(s)).pop() || "";
        const scene = (hit.match(/【场景([^\]】]*)】/) || [])[1] || "";
        let lastUserIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { lastUserIdx = i; break; }
        const alreadyRan = lastUserIdx >= 0 && msgs.slice(lastUserIdx + 1).some((m) => m.role === "tool");
        rs.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const send = (o) => rs.write("data: " + JSON.stringify(o) + "\n\n");
        const endText = (t) => {
          send({ choices: [{ index: 0, delta: { content: t } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          rs.write("data: [DONE]\n\n"); rs.end();
        };
        const toolCall = (name, args) => {
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_dc_" + scene, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          rs.write("data: [DONE]\n\n"); rs.end();
        };
        if (alreadyRan) return endText("场景 " + scene + " 跑完");
        if (scene === "批准") return toolCall("write_file", { path: "dec-ok.txt", content: "用户批准后才写\n" });
        if (scene === "拒绝") return toolCall("write_file", { path: "dec-no.txt", content: "用户拒绝后不该出现\n" });
        if (scene === "拦截") return toolCall("write_file", { path: "dec-secret.txt", content: "deny 规则该在写之前就挡住\n" });
        if (scene === "只读") return toolCall("read_file", { path: "read.txt" });
        if (scene === "自动放行") return toolCall("write_file", { path: "dec-auto.txt", content: "auto 档直接放行\n" });
        if (scene === "选择") return toolCall("ask_user_choice", {
          question: "发布方式选哪个？",
          options: [{ label: "蓝绿", description: "切换快、资源翻倍" }, { label: "灰度", description: "按比例放量" }],
        });
        return endText("没有匹配的场景：" + scene);
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, base: "http://127.0.0.1:" + srv.address().port + "/v1" }));
  });
}

/* 场景串行跑，所以"当前会话 + 当前场景"两个模块级变量就够：
   审批卡一到就按场景策略回答，不靠 Promise 竞速（竞速会把上一条场景的卡误答给下一条）。 */
let currentConv = "";
let currentScene = "";
const responded = [];

(async () => {
  section("起沙箱服务（权限档 ask + 一条 deny 规则）");
  const gw = await startGateway();
  fs.writeFileSync(path.join(SANDBOX.dataDir, "pancode.config.json"), JSON.stringify({
    workspace: WS_DIR,
    llm: { baseURL: gw.base, apiKey: "sk-sandbox", model: "mock-dec", contextWindow: 32000 },
    agentMode: "agent",
    permissions: { mode: "ask", allow: [], deny: ["dec-secret.txt"] },
  }, null, 2), "utf8");
  let out = "";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT, env: SANDBOX.env({ PORT: String(PORT), NODE_NO_WARNINGS: "1", AGENT_FAST: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => { out = (out + c).slice(-40000); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-40000); });
  let up = false;
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const h = await req("GET", "/api/health"); if (h.json && h.json.ok) { up = true; break; } } catch (e) {}
  }
  if (!up) { child.kill(); gw.srv.close(); throw new Error("服务未就绪\n" + out.slice(-1200)); }
  const reg = await req("POST", "/api/auth/register", { username: "_dc_" + Date.now(), password: "test1234" });
  const token = reg.json && reg.json.token;
  if (!token) { child.kill(); gw.srv.close(); throw new Error("注册失败：" + J(reg.json)); }

  const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
  const events = [];
  const waiters = [];
  ws.on("message", (raw) => {
    let ev; try { ev = JSON.parse(raw.toString()); } catch (e) { return; }
    events.push(ev);
    if (ev.type === "tool.pending" && ev.convId === currentConv) {
      const act = currentScene === "拒绝" ? "tool.reject" : "tool.approve";
      ws.send(JSON.stringify({ type: act, id: ev.id }));
      responded.push({ convId: ev.convId, tool: ev.tool, act, id: ev.id });
    }
    if (ev.type === "tool.ask_choice" && ev.convId === currentConv) {
      ws.send(JSON.stringify({ type: "tool.choice_result", id: ev.id, choice: "灰度" }));
      responded.push({ convId: ev.convId, tool: "ask_user_choice", act: "choice", id: ev.id });
    }
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].match(ev)) { waiters[i].resolve(ev); waiters.splice(i, 1); }
  });
  const waitFor = (match, ms) => new Promise((resolve, reject) => {
    const hit = events.find(match);
    if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error("等事件超时 " + (ms || 8000) + "ms")), ms || 8000);
    waiters.push({ match, resolve: (ev) => { clearTimeout(t); resolve(ev); } });
  });
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); setTimeout(() => reject(new Error("WS 超时")), 8000); });
  await waitFor((e) => e.type === "hello", 15000);

  const send = (o) => ws.send(JSON.stringify(o));
  async function runScene(scene, ms) {
    const conv = "dc-" + scene + "-" + Date.now();
    const before = events.length;
    currentScene = scene; currentConv = conv;
    send({ type: "chat", text: "【场景" + scene + "】请按这个场景调用工具", convId: conv });
    let done = null;
    try {
      done = await waitFor((e) => e.type === "agent.done" && e.convId === conv && events.indexOf(e) >= before, ms || 25000);
    } catch (e) { return { done: null, conv, evs: [] }; }
    await wait(200);
    return { done, conv, evs: events.slice(before).filter((e) => e.convId === conv) };
  }

  const convs = {};
  try {
    section("① 用户批准 / 拒绝：记的是「谁定的」");
    const r1 = await runScene("批准");
    convs.批准 = r1.conv;
    ok("审批卡真的弹出来了（正向对照：没有卡就没有「用户批准」这条记录）",
      responded.some((x) => x.convId === r1.conv && x.act === "tool.approve"), J(responded));
    ok("批准后文件真写下去了", fs.existsSync(path.join(WS_DIR, "dec-ok.txt")), "");

    const r2 = await runScene("拒绝");
    convs.拒绝 = r2.conv;
    ok("第二条审批卡也弹出来了", responded.some((x) => x.convId === r2.conv && x.act === "tool.reject"), J(responded.slice(-2)));
    ok("拒绝后没有落盘（决策与副作用一致）", !fs.existsSync(path.join(WS_DIR, "dec-no.txt")), "");

    section("② deny 规则拦截 + 只读免检");
    const r3 = await runScene("拦截");
    convs.拦截 = r3.conv;
    ok("被拦的调用没弹审批卡（规则先于人工）", !r3.evs.some((e) => e.type === "tool.pending"), J(r3.evs.map((e) => e.type)));
    ok("secret 文件一个字节没动", fs.readFileSync(path.join(WS_DIR, "dec-secret.txt"), "utf8") === "被 deny 规则护住的文件\n", "");
    const r4 = await runScene("只读");
    convs.只读 = r4.conv;
    ok("正向对照：读文件真的跑了（有「读取文件」那张工具卡）",
      r4.evs.some((e) => e.type === "tool.start" && e.name === "读取文件"), J(r4.evs.map((e) => e.type + ":" + (e.name || e.label || ""))));
    ok("读文件没弹卡（只读免检）", !r4.evs.some((e) => e.type === "tool.pending"), J(r4.evs.map((e) => e.type)));

    section("③ 用户改权限档：这条决定解释了之后所有门的松紧");
    const sw = await req("POST", "/api/config", { section: "agent", patch: { permissions: { mode: "auto", allow: [], deny: ["dec-secret.txt"] } } }, token);
    ok("切到 auto 成功", sw.json.ok === true, J(sw.json));

    /* auto 档下的写盘：不弹卡、直接放行，而"为什么没问我"这个答案必须留在链上。
       读类工具压根不走 _gate（一次任务几十次 read_file，全记下来只会把判断淹掉），
       所以这条 allow 用写文件来验——顺带钉住"读操作不进决策链"这个取舍。 */
    const r6 = await runScene("自动放行");
    convs.自动放行 = r6.conv;
    ok("auto 档写盘不再弹卡", !r6.evs.some((e) => e.type === "tool.pending"), J(r6.evs.map((e) => e.type)));
    ok("文件真的写下去了（放行不是空转）", fs.existsSync(path.join(WS_DIR, "dec-auto.txt")), "");

    section("④ 方案选择：选了哪个、当时摆在面前的是哪几个");
    const r5 = await runScene("选择");
    convs.选择 = r5.conv;
    const ask = r5.evs.find((e) => e.type === "tool.ask_choice");
    ok("选项卡真的弹出来了（两个候选）", !!ask && Array.isArray(ask.options) && ask.options.length === 2, J(ask && ask.options));

    section("⑤ 落盘：决策链是结构化 JSONL，一行一条判断");
    const file = path.join(DEC_DIR, today() + ".jsonl");
    ok("今天的决策文件在沙箱数据根里", fs.existsSync(file), file);
    const rawLines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
    const rows = rawLines.map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    ok("每一行都是合法 JSON（条数与行数一致）", rawLines.length > 0 && rows.length === rawLines.length, rawLines.length + " 行 / " + rows.length + " 条");
    const find = (kind, action, conv) => rows.find((d) => d.kind === kind && d.action === action && (!conv || d.convId === conv));
    ok("记到了「用户批准」，并带上是哪个工具、改的哪个文件",
      !!find("approval", "approved", convs.批准) && /dec-ok\.txt/.test((find("approval", "approved", convs.批准) || {}).subject || ""),
      J(rows.filter((r) => r.kind === "approval").map((r) => r.action + ":" + r.subject)));
    ok("记到了「用户拒绝」，理由不是空的",
      !!find("approval", "rejected", convs.拒绝) && !!((find("approval", "rejected", convs.拒绝) || {}).reason || "").length, "");
    ok("拒绝与批准是两条不同 action（不都写成 rejected）", !!find("approval", "approved") && !!find("approval", "rejected"));
    ok("记到了 deny 规则拦截，reason 说是哪条规则",
      !!find("gate", "block", convs.拦截) && /拒绝规则|deny/.test((find("gate", "block", convs.拦截) || {}).reason || ""),
      J((find("gate", "block", convs.拦截) || {}).reason));
    ok("记到了 auto 档的放行（回答「这一步为什么没问我」）", !!find("gate", "allow", convs.自动放行),
      J(rows.filter((r) => r.kind === "gate").map((r) => r.action + ":" + r.tool)));
    ok("放行记录带上了判定依据，不是光一个 allow",
      !!((find("gate", "allow", convs.自动放行) || {}).reason || "").length, J(find("gate", "allow", convs.自动放行)));
    ok("读操作不进决策链（一次任务几十次 read_file，记下来只会把判断淹掉）",
      !rows.some((r) => r.tool === "read_file"), J(rows.filter((r) => r.tool === "read_file")));
    ok("记到了用户改权限档", !!find("mode", "switched"), J(rows.filter((r) => r.kind === "mode")));
    ok("记到了方案选择：选了灰度，候选里还留着蓝绿",
      !!find("choice", "picked") && /灰度/.test((find("choice", "picked") || {}).subject || "")
      && /蓝绿/.test(String((find("choice", "picked") || {}).detail || "")), J(find("choice", "picked")));
    ok("每条都归到了正确的会话（不是一律 default 兜底）",
      !!find("approval", "approved", convs.批准) && !!find("gate", "allow", convs.自动放行) && rows.every((r) => !!r.convId),
      J(rows.map((r) => r.convId).slice(0, 6)));
    ok("写文件这类工具的 irreversible 列是真布尔",
      rows.some((r) => r.tool === "write_file" && typeof r.irreversible === "boolean"),
      J(rows.filter((r) => r.tool === "write_file").map((r) => r.irreversible)));
    ok("超时不会被记成「用户拒绝」（没人看过 ≠ 有人说不行）",
      !rows.some((r) => r.action === "rejected" && /超时/.test(r.reason || "")), J(rows.filter((r) => /超时/.test(r.reason || ""))));

    section("⑥ 接口：按会话能还原一整局");
    const api = await req("GET", "/api/decisions?limit=500", null, token);
    ok("GET /api/decisions 返回结构化数组", api.json.ok === true && Array.isArray(api.json.decisions) && api.json.decisions.length >= 5,
      J((api.json.decisions || []).length));
    const one = await req("GET", "/api/decisions?convId=" + encodeURIComponent(convs.批准), null, token);
    ok("按 convId 过滤后只剩那一局", (one.json.decisions || []).length >= 1 && one.json.decisions.every((d) => d.convId === convs.批准),
      J((one.json.decisions || []).map((d) => d.kind + "/" + d.action)));
    ok("过滤后的那一条确实是「用户批准 write_file」",
      (one.json.decisions || []).some((d) => d.kind === "approval" && d.action === "approved" && d.tool === "write_file"), J(one.json.decisions));
    const byKind = await req("GET", "/api/decisions?kind=choice", null, token);
    ok("按 kind 过滤可用", (byKind.json.decisions || []).length >= 1 && byKind.json.decisions.every((d) => d.kind === "choice"), J(byKind.json.decisions));
    const dates = await req("GET", "/api/decisions/dates", null, token);
    ok("日期列表里有今天", (dates.json.dates || []).includes(today()), J(dates.json));
    const noAuth = await req("GET", "/api/decisions");
    ok("决策链接口不是裸奔的（未登录 401）", noAuth.status === 401, J(noAuth.json));

    section("⑦ 两条台账并存：动作流水的格式没被决策链改掉");
    const aud = await req("GET", "/api/audit?limit=400", null, token);
    const alines = (aud.json.lines || []).filter((l) => /\| gate \|/.test(l));
    ok("audit 里仍有 gate 行（旧台账没被搬走）", alines.length >= 1, J(alines.slice(0, 2)));
    ok("audit 行仍是「时间 | 来源 | 说明」的人话格式（前端与探针都吃这个格式）",
      alines.every((l) => l.split("|").length >= 3 && /^\d{4}-\d{2}-\d{2}T/.test(l.trim())), J(alines.slice(0, 1)));
    ok("决策链没混进 audit 文件",
      !fs.existsSync(AUD_LOG) || !fs.readdirSync(AUD_LOG).some((f) => fs.readFileSync(path.join(AUD_LOG, f), "utf8").includes('"kind":"')));

    section("浏览器：工作台 → 审计 → 决策链");
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    await page.addInitScript((t) => {
      try {
        localStorage.setItem("cw-user-token", t);
        localStorage.setItem("cw-theme", "dark");
        localStorage.setItem("cw-palette", "graphite");
        localStorage.setItem("cw-onboarded", "1");
      } catch (e) {}
    }, token);
    await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.openWorkbench === "function", null, { timeout: 15000 });
    await wait(1400);
    await page.evaluate(() => window.openWorkbench("audit"));
    await page.waitForSelector(".wb-panel", { timeout: 8000 });
    await wait(700);
    const segBtns = page.locator(".wb-segment button");
    ok("审计分区顶部有视图切换（动作流水 / 决策链）",
      (await segBtns.count()) === 2 && /动作流水/.test(await segBtns.nth(0).textContent()) && /决策链/.test(await segBtns.nth(1).textContent()),
      await segBtns.allTextContents().then((a) => a.join("/")));
    await segBtns.nth(1).click();
    await wait(1000);
    await page.screenshot({ path: path.join(OUT, "dec_chain.png") });
    const items = page.locator(".wb-decision");
    const nAll = await items.count();
    ok("决策链渲染出行（不是空态）", nAll >= 5, "rows=" + nAll);
    const txt = await page.locator(".wb-decisions").innerText();
    ok("界面上看得见的判断词齐全（批准/拒绝/拦截/已选/放行）",
      /(已批准|已拒绝)/.test(txt) && /拦截/.test(txt) && /已选/.test(txt) && /放行/.test(txt), txt.replace(/\n/g, " / ").slice(0, 240));
    ok("每一行标了属于哪个会话（多会话并行时分得清是谁的）", /会话\s*dc-/.test(txt), "");
    ok("理由直接显示在行上（决策链的价值就在「为什么」）", /规则|批准|拒绝|超时|候选|灰度|蓝绿/.test(txt), "");
    const chips = page.locator(".wb-decision-filters .wb-btn");
    ok("分类 chip 带真实计数", (await chips.count()) >= 3, "chips=" + await chips.count());
    await page.locator('.wb-decision-filters .wb-btn', { hasText: "人工审批" }).first().click();
    await wait(500);
    const onlyApproval = await page.locator(".wb-decision").count();
    ok("点「人工审批」后只剩这一类", onlyApproval >= 1 && onlyApproval < nAll, onlyApproval + " / " + nAll);
    ok("筛选后每一行都是人工审批",
      (await page.locator(".wb-decision").allInnerTexts()).every((t) => /人工审批/.test(t)), "");
    await page.locator('.wb-decision-filters .wb-btn', { hasText: "人工审批" }).first().click();
    await wait(500);
    ok("再点一次取消筛选（不是只能加不能减）", (await page.locator(".wb-decision").count()) > onlyApproval, "");
    const withDetail = page.locator(".wb-decision:has(.wb-decision-detail pre)");
    ok("有带细节（候选 / 前后 token）的行", (await withDetail.count()) >= 1, "");
    if (await withDetail.count()) {
      ok("细节默认收起",
        (await withDetail.first().locator(".wb-decision-detail").evaluate((el) => getComputedStyle(el).display)) === "none");
      await withDetail.first().click();
      await wait(250);
      ok("点一行展开细节",
        (await withDetail.first().locator(".wb-decision-detail").evaluate((el) => getComputedStyle(el).display)) !== "none", "");
      await page.screenshot({ path: path.join(OUT, "dec_detail.png") });
    }
    await page.locator(".wb-switch").first().click();
    await wait(600);
    ok("「只看当前会话」切过去后界面没崩",
      errors.filter((e) => !/favicon|net::ERR|Failed to load resource|is sandboxed|allow-same-origin/i.test(e)).length === 0,
      errors.slice(0, 2).join(" | "));
    await page.locator(".wb-switch").first().click();
    await wait(400);
    await segBtns.nth(0).click();
    await wait(700);
    ok("切回「动作流水」仍是原来的文件与命令列表", (await page.locator(".wb-audit .wb-list-item").count()) >= 1, "");
    await browser.close();

    section("⑧ 服务端侧的静默失败检查");
    ok("整轮没有出现未捕获异常", !/UNCAUGHT|TypeError: |ReferenceError: /.test(out),
      (out.match(/.{0,160}(TypeError|ReferenceError|UNCAUGHT).{0,160}/) || [""])[0]);
  } catch (e) {
    ok("探针自身跑通（未中途抛错）", false, String(e && e.stack || e).slice(0, 400));
  } finally {
    try { ws.close(); } catch (e) {}
    child.kill();
    gw.srv.close();
  }
  console.log("\n[P3-D1] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e && e.stack || e); process.exit(1); });
