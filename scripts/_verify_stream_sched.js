/* ============================================================
   审查项 F16 验收：流式重绘的调度单位必须是"这一条消息"
   ————————————————————————————————————————————————————
   旧形态：全局一根 _mdTimer。已有 timer 时后来者直接 return，于是
     · 后台那条流一帧都不画（画的是 timer 闭包里那一条），前台只能等它 msg.end；
     · msg.end 的 clearTimeout 会把别人刚排上的那帧连坐删掉；
     · 异步回调里 _boundConvId 早就出了 withConv，scrollChat 拿的是**前台**那块 ——
       后台流每画一帧，前台的"↓ N 条新消息"就 +1，那个数字在骗人；
     · 已发出、还在 Worker 里的那一帧会飞回来盖掉 msg.end 的终稿
       （widget 类终稿是主线程同步渲染的，被盖回去就退化成普通代码块）。
   这一支把四种形状钉死，并量 10KB/100KB/500KB 的单帧成本。

   口径：全部走**真链路** —— 假上游（真 SSE，按脚本一口一口吐）+ 真服务端 + 真引擎 +
        真浏览器。不打桩 renderChatMD，也不往 handleEvent 里灌编造的事件形状：
        ①先证明真流里的 msg.* 长什么样，后面所有场景都用真流跑出来。
   ============================================================ */
"use strict";
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const LLM_PORT = 8903;
const PORT = 8902;

const SANDBOX = require("./_sandbox").create({
  tag: "streamsched",
  wsFiles: { "src/app.js": "export const a = 1;\n", "README.md": "# demo\n" },
  config: {
    agentMode: "auto",
    permissions: { mode: "auto", allow: [], deny: [] },
    llm: {
      baseURL: "http://127.0.0.1:" + LLM_PORT + "/v1",
      apiKey: "fake-key", model: "fake-model", contextWindow: 1000000,
      idleTimeout: 30000, connectTimeout: 15000,
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
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 300); } catch (e) { return String(v).slice(0, 300); } };

/* ---------------- 假上游：按最后一条用户消息里的标记选剧本 ----------------
   两个会话同时在流，出网顺序不固定，所以不能靠"脚本队列按序取"，必须按内容路由。 */
const hits = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sse(res, obj) { res.write("data: " + JSON.stringify(obj) + "\n\n"); }
/* 出网记账挂在 res 上（两次并行请求共用不到一起）：只数**带正文**的那几口，
   和界面收到的 msg.delta 是同一口径。 */
function chunk(res, delta, finish) {
  const rec = res.__probe;
  if (rec && delta && delta.content) { rec.frames++; rec.chars += String(delta.content).length; }
  sse(res, { choices: [{ delta: delta || {}, finish_reason: finish || null }] });
}
function endOk(res) { sse(res, "[DONE]"); try { res.end(); } catch (e) {} }
const FILLER = "这一段是用来把正文顶到指定长度的填充文字，逐字都要能对上。";
function pad(n) { let s = ""; while (s.length < n) s += FILLER; return s.slice(0, n); }

const FG_NEEDLE = "前台这一句要立刻看得见";
const WIDGET_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><rect width='24' height='24' fill='#0af'/></svg>";

const scripts = {
  /* 后台猛流：240 口 × 4ms ≈ 1s，全程占着调度 */
  async heavy(res) {
    for (let i = 0; i < 240; i++) { chunk(res, { content: "b" + i + "g " }); await sleep(4); }
    chunk(res, {}, "stop"); endOk(res);
  },
  /* 只吐一口，然后停 900ms 再收尾：中间这段就是"被别人的调度压住"的观察窗 */
  async oneshot(res) {
    chunk(res, { content: FG_NEEDLE + "。" });
    await sleep(900);
    chunk(res, {}, "stop"); endOk(res);
  },
  /* 先灌 150KB 正文，再补一个**已闭合**的 widget 代码块，停 200ms 让流式帧发出去，再收尾。
     终稿是主线程同步渲染（widget 只在主线程有 renderWidgetCard），
     而那 150KB 的 Worker 帧还在路上 —— 谁后到谁说了算，旧代码是旧帧赢。 */
  async widget(res) {
    chunk(res, { content: "前置说明：\n\n" + pad(150 * 1024) });
    chunk(res, { content: "\n\n```widget\n" + WIDGET_SVG + "\n```\n" });
    await sleep(200);
    chunk(res, {}, "stop"); endOk(res);
  },
  /* 代码块从未闭合到闭合：中间停 600ms 给页面采样 */
  async fence(res) {
    chunk(res, { content: "```js\nconst a = 1;\n" });
    await sleep(600);
    chunk(res, { content: "const b = 2;\n```\n" });
    await sleep(400);
    chunk(res, {}, "stop"); endOk(res);
  },
  /* 指定 KB 的正文：每口 1KB，不额外延时（帧预算 65ms 决定了每秒画几帧，跟流速无关）。
     最后一口带一个尾针，判据用它确认"一口没丢"，长度用下限卡——渲染后的 textContent
     本来就不等于源码长度，拿源码长度去等比是判据自己不算账。 */
  async kb(res, arg) {
    const parts = Math.max(1, Math.round(arg));
    for (let i = 0; i < parts; i++) { chunk(res, { content: pad(1024) + "\n\n" }); await sleep(2); }
    chunk(res, { content: "TAIL-" + arg + "KB\n" });
    chunk(res, {}, "stop"); endOk(res);
  },
  /* 普通一句话（准备阶段用） */
  async plain(res) { chunk(res, { content: "这一轮说完了。" }, "stop"); endOk(res); },
};

function lastUserText(body) {
  const ms = (body && body.messages) || [];
  for (let i = ms.length - 1; i >= 0; i--) {
    if (ms[i].role === "user") return typeof ms[i].content === "string" ? ms[i].content : JSON.stringify(ms[i].content);
  }
  return "";
}
function route(text) {
  if (/HEAVY/.test(text)) return ["heavy", null];
  if (/FGONESHOT/.test(text)) return ["oneshot", null];
  if (/WIDGETPROBE/.test(text)) return ["widget", null];
  if (/FENCEPROBE/.test(text)) return ["fence", null];
  const m = text.match(/KB(\d+)/);
  if (m) return ["kb", Number(m[1])];
  return ["plain", null];
}

const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let parsed = null; try { parsed = JSON.parse(body || "{}"); } catch (e) {}
    const text = lastUserText(parsed);
    const [kind, arg] = route(text);
    res.__probe = { frames: 0, chars: 0 };
    hits.push({ kind, arg, at: Date.now(), rec: res.__probe });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    try { await scripts[kind](res, arg); } catch (e) { try { res.end(); } catch (x) {} }
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

function boot() {
  const env = SANDBOX.env({ PORT: String(PORT), HOME: path.join(SANDBOX.root, "home"), USERPROFILE: path.join(SANDBOX.root, "home") });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], { cwd: ROOT, env, windowsHide: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return { child, out: () => out };
}

(async () => {
  upstream.listen(LLM_PORT, "127.0.0.1");
  const { child, out } = boot();
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (out().includes("已启动")) break; await wait(150); }
  if (!out().includes("已启动")) throw new Error("服务端没起来：" + out().slice(-400));

  const reg = await req("POST", "/api/auth/register", { username: "_ss_" + Date.now(), password: "test1234" });
  const token = reg.json && reg.json.token;
  if (!token) throw new Error("注册失败：" + J(reg.json));

  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErr = [];
  page.on("pageerror", (e) => pageErr.push(String(e && e.message)));
  await page.addInitScript((tk) => {
    try { localStorage.setItem("cw-user-token", tk); localStorage.setItem("cw-onboarded", "1"); } catch (e) {}
  }, token);
  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => typeof handleEvent === "function" && typeof send === "function" && typeof convId !== "undefined" && convId, null, { timeout: 30000 });

  /* 页面侧仪器：只**记录**，不改行为（包住 renderChatMDAsync 量 post→回包，长任务/帧间隔/排队延迟各开一个观察器） */
  await page.evaluate(() => {
    const P = { wframes: 0, domWrites: 0, domKB: 0, parseSum: 0, parseMax: 0, longMax: 0, rafMax: 0, pingMax: 0, on: false };
    window.__p = P;
    window.__pReset = () => { P.wframes = 0; P.domWrites = 0; P.domKB = 0; P.parseSum = 0; P.parseMax = 0; P.longMax = 0; P.rafMax = 0; P.pingMax = 0; };
    const orig = window.renderChatMDAsync;
    window.renderChatMDAsync = function (src, cb) {
      const t = performance.now();
      return orig.call(this, src, function (html) {
        const dt = performance.now() - t;
        P.wframes++; P.parseSum += dt;
        if (dt > P.parseMax) P.parseMax = dt;
        return cb.apply(this, arguments);
      });
    };
    /* DOM 写入必须在这儿数：改成稳定块增量之后，绝大多数帧根本不再走 Worker，
       只包 renderChatMDAsync 会量到"1 帧、10KB"，而真实写进 DOM 的是 500KB ——
       数字得说它声称的那件事。只统计聊天区里的写入（Monaco 自己也用 innerHTML）。 */
    P.wframes = 0; P.domWrites = 0; P.domKB = 0;
    const inChat = (el) => { try { return !!(el.closest && el.closest("#chatStream")); } catch (e) { return false; } };
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true, enumerable: desc.enumerable, get: desc.get,
      set: function (v) { if (P.on && inChat(this)) { P.domWrites++; P.domKB += String(v || "").length / 1024; } return desc.set.call(this, v); },
    });
    const ins = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function (pos, html) {
      if (P.on && inChat(this)) { P.domWrites++; P.domKB += String(html || "").length / 1024; }
      return ins.call(this, pos, html);
    };
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > P.longMax) P.longMax = e.duration; }).observe({ entryTypes: ["longtask"] }); } catch (e) {}
    /* 按会话统计界面真的收到了几口、多少字：这是"少了一段"类问题的分层器 ——
       上游写出口数 / 界面收到口数 / pane 里的正文字符数，三层一比就知道丢在哪一层。 */
    window.__ev = {};
    const H = window.handleEvent;
    window.handleEvent = function (ev) {
      if (ev && ev.convId && (ev.type === "msg.delta" || ev.type === "msg.start" || ev.type === "msg.end")) {
        const s = window.__ev[ev.convId] || (window.__ev[ev.convId] = { starts: 0, deltas: 0, ends: 0, chars: 0 });
        if (ev.type === "msg.delta") { s.deltas++; s.chars += (ev.text || "").length; }
        else if (ev.type === "msg.start") s.starts++; else s.ends++;
      }
      return H.apply(this, arguments);
    };
    window.__evReset = () => { window.__ev = {}; };
    window.__evOf = (c) => window.__ev[c] || { starts: 0, deltas: 0, ends: 0, chars: 0 };
    let last = performance.now();
    (function tick() { const n = performance.now(); if (P.on && n - last > P.rafMax) P.rafMax = n - last; last = n; requestAnimationFrame(tick); })();
    (function ping() {
      const ch = new MessageChannel(); const t = performance.now();
      ch.port1.onmessage = () => { const d = performance.now() - t; if (P.on && d > P.pingMax) P.pingMax = d; setTimeout(ping, 16); };
      ch.port2.postMessage(0);
    })();
    P.on = true;
  });

  const askIn = (cid, text) => page.evaluate(([c, x]) => send({ type: "chat", text: x, attachments: [], convId: c }), [cid, text]);
  /* 等"这一轮的终稿上屏"，不能只看 .type-caret 是不是 0：
     刚发出去时那块还没建出来，光标类一个都没有，判据会在第一帧之前就返回（上一轮红就红在这）。
     正确口径：这条会话的 msg.end 计数比发之前多了，且全场没有还在闪的光标。 */
  const endsOf = (cid) => page.evaluate((c) => window.__evOf(c).ends, cid);
  const waitEnd = async (cid, ms) => {
    const base = await endsOf(cid);
    return page.waitForFunction(([c, b]) => window.__evOf(c).ends > b && document.querySelectorAll(".type-caret").length === 0,
      [cid, base], { timeout: ms || 60000 }).then(() => true).catch(() => false);
  };
  /* convPanes 是 app.js 里的顶层 const —— 顶层 const/let 不挂到 window 上，
     只能用裸名字取（写成 window.convPanes 恒为 undefined，判据就全在比空串）。 */
  const paneText = (cid) => page.evaluate((c) => ((typeof convPanes !== "undefined" && convPanes[c]) ? convPanes[c].textContent : ""), cid);
  const snap = () => page.evaluate(() => {
    const P = window.__p;
    return { wframes: P.wframes, domWrites: P.domWrites, domKB: Math.round(P.domKB), parseSum: Math.round(P.parseSum), parseMax: Math.round(P.parseMax * 10) / 10, longMax: Math.round(P.longMax), rafMax: Math.round(P.rafMax), pingMax: Math.round(P.pingMax) };
  });

  /* 等这一块把"最后一帧"发出去：帧预算是 65ms，超过就一定有一次 postMessage 在路上了 */
  await wait(1200);
  const ids = await page.evaluate(() => ({ fg: convId }));
  const FG = ids.fg;

  try {
    /* ================= ① 真流的形状 ================= */
    section("① 前提：真流里的 msg.* 到底长什么样（后面所有场景都用它，不编形状）");
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); setTimeout(() => rej(new Error("ws 超时")), 8000); });
    const shapeConv = "sched-shape-" + Date.now();
    const evs = [];
    ws.on("message", (raw) => { try { const m = JSON.parse(raw.toString()); if (m.convId === shapeConv) evs.push(m); } catch (e) {} });
    await new Promise((res) => {
      const done = (m) => { if (m.type === "agent.done" && m.convId === shapeConv) { ws.off("message", chk); res(); } };
      const chk = (raw) => { try { done(JSON.parse(raw.toString())); } catch (e) {} };
      ws.on("message", chk);
      ws.send(JSON.stringify({ type: "chat", text: "FGONESHOT 让上游只吐一口", attachments: [], convId: shapeConv }));
      setTimeout(() => { ws.off("message", chk); res(); }, 20000);
    });
    const starts = evs.filter((e) => e.type === "msg.start");
    const deltas = evs.filter((e) => e.type === "msg.delta");
    const ends = evs.filter((e) => e.type === "msg.end");
    ok("真流里 msg.start/delta/end 都带同一个字符串 id（调度就按这个 id 分块）",
      starts.length === 1 && deltas.length >= 1 && ends.length === 1 &&
      starts[0].id === ends[0].id && deltas.every((d) => d.id === starts[0].id && typeof d.text === "string"),
      J({ starts: starts.length, deltas: deltas.length, ends: ends.length, ids: [starts[0] && starts[0].id, ends[0] && ends[0].id] }));
    ok("真流里每条 msg.* 都带 convId（双会话交错靠它路由到各自的 pane）",
      [starts[0], deltas[0], ends[0]].every((e) => e && e.convId === shapeConv),
      J({ start: starts[0] && starts[0].convId, delta: deltas[0] && deltas[0].convId, end: ends[0] && ends[0].convId }));
    ok("delta 的 text 拼起来就是这一块的全部正文（正文不靠第二次全量下发）",
      deltas.map((d) => d.text).join("") === FG_NEEDLE + "。", JSON.stringify(deltas.map((d) => d.text).join("").slice(0, 60)));
    ws.close();

    /* ================= ② 双会话交错 ================= */
    section("② 后台一条在猛流：前台刚收到的那一截必须上屏，后台也必须持续画，且不许动前台的账");
    /* 先给前台灌一段够长的回答，让它真的能溢出视口（不溢出就谈不上"被拉走"） */
    await askIn(FG, "KB40 先把前台灌满");
    await waitEnd(FG, 40000);
    const overflow = await page.evaluate(() => { const box = document.getElementById("chatStream"); return { h: box.scrollHeight, c: box.clientHeight }; });
    ok("前台内容真的溢出视口（阳性对照：不溢出这条判据就是空转）", overflow.h > overflow.c + 200, J(overflow));

    /* 开第二条会话并让它成为后台 */
    const BG = await page.evaluate(() => { newConversation(); return convId; });
    ok("第二条会话真的开出来了（和前台不是同一条）", !!BG && BG !== FG, "FG=" + FG + " BG=" + BG);
    await askIn(BG, "HEAVY 后台一直流");
    await wait(250);   // 让后台先流起来，把调度占住
    /* 切回前台并按住阅读位置：后台每画一帧，旧代码都会去动这块 */
    await page.evaluate((c) => { openConv(c); }, FG);
    await page.evaluate(() => { const box = document.getElementById("chatStream"); box.scrollTop = 0; _newMsgCount = 0; });

    await askIn(FG, "FGONESHOT 前台只吐一口然后停 900ms");
    /* 观察窗：这一口之后到 msg.end 之前（上游故意停 900ms），前台那块该由流式帧画出来 */
    await wait(320);
    const mid = await page.evaluate(([f, b]) => {
      const box = document.getElementById("chatStream");
      return {
        fgText: (convPanes[f] || { textContent: "" }).textContent,
        bgLen: (convPanes[b] || { textContent: "" }).textContent.length,
        unread: typeof _newMsgCount !== "undefined" ? _newMsgCount : -1,
        scrollTop: box.scrollTop,
        caret: !!document.querySelector(".type-caret"),
      };
    }, [FG, BG]);
    const bg1 = (await paneText(BG)).length;
    await wait(300);
    const bg2 = (await paneText(BG)).length;
    const fgNow = await paneText(FG);
    const acct = await page.evaluate(() => ({
      unread: typeof _newMsgCount !== "undefined" ? _newMsgCount : -1,
      scrollTop: document.getElementById("chatStream").scrollTop,
    }));

    ok("后台在猛流的时候，前台刚收到的那一截也上了屏（旧代码：它的 delta 被后台的调度压住，要等 msg.end 才看得见）",
      fgNow.includes(FG_NEEDLE), JSON.stringify(fgNow.slice(-60)));
    ok("后台那块自己在交错期持续上屏（不是一次画完然后冻住）", bg2 > bg1 && bg1 > 0, "bg1=" + bg1 + " bg2=" + bg2);
    ok("后台每一帧都画的是它自己的正文（没串到前台那块里）",
      fgNow.includes(FG_NEEDLE) && !fgNow.includes("b0g "), JSON.stringify(fgNow.slice(0, 40)));
    ok("后台流式帧不去动前台的「↓ N 条新消息」（旧代码每画一帧 +1，那个数字是假的）",
      acct.unread === 0, "前台未读计数=" + acct.unread + "（交错期后台画了至少两帧）");
    ok("前台的阅读位置没被后台那一帧拉走", acct.scrollTop === mid.scrollTop, "scrollTop=" + acct.scrollTop);

    /* 等后台流完 */
    await waitEnd(BG, 60000);
    const bgFinal = await paneText(BG);
    ok("后台收尾后正文完整（240 口一口没丢）", /b239g /.test(bgFinal) && bgFinal.length > 800, "长度=" + bgFinal.length);

    /* ================= ③ 结束事件抢先 ================= */
    section("③ 结束事件抢先：终稿不许被更早发出、更晚回来的 Worker 帧盖回去");
    await askIn(FG, "WIDGETPROBE 150KB 正文 + 一个闭合的 widget 块");
    await page.waitForFunction(() => !!document.querySelector(".msg-widget"), null, { timeout: 30000 }).catch(() => {});
    const atEnd = await page.evaluate(() => ({
      widget: !!document.querySelector(".msg-widget"),
      codeFence: /```widget/.test(document.getElementById("chatStream").textContent),
    }));
    await wait(1500);   // 足够那一帧 150KB 的 Worker 回包飞回来（真机量到单帧解析远低于这个数）
    const afterLate = await page.evaluate(() => ({
      widget: !!document.querySelector(".msg-widget"),
      codeFence: /```widget/.test(document.getElementById("chatStream").textContent),
      tail: document.getElementById("chatStream").textContent.slice(-40),
    }));
    ok("widget 卡片渲染出来了（终稿走的是主线程那条能画卡片的路）", atEnd.widget && !atEnd.codeFence, J(atEnd));
    ok("终稿站住了：稍后飞回来的那一帧没有把它盖回普通代码块", afterLate.widget && !afterLate.codeFence, J(afterLate));

    /* ================= ④ 代码块从未闭合到闭合 ================= */
    section("④ 代码块未闭合：每一帧都得是一个正常代码块，不许出现游离的 ```");
    /* 只看这一轮新长出来的那一块：上一轮（widget 那一答）的气泡此刻仍是文档序最后一个，
       拿它当采样对象会一路采到"0 个代码块"—— min=0 红的是采样器，不是渲染器。 */
    const before = await page.evaluate(() => document.querySelectorAll("#chatStream .msg-ai").length);
    await page.evaluate(() => { window.__fence = { blocks: [], strays: 0, samples: 0, zeros: [] }; });
    const fenceWatch = page.evaluate(async (base) => {
      const W = window.__fence;
      const t0 = performance.now();
      while (performance.now() - t0 < 2200) {
        const box = document.getElementById("chatStream");
        const els = box.querySelectorAll(".msg-ai");
        const last = els.length > base ? els[els.length - 1] : null;
        if (last && last.textContent.trim().length > 0) {   // 第一帧之前这块还是空的，不纳入采样
          W.samples++;
          const nb = last.querySelectorAll(".code-block").length;
          W.blocks.push(nb);
          if (nb === 0 && W.zeros.length < 3) W.zeros.push(JSON.stringify(last.textContent.slice(0, 50)));
          if (/```/.test(last.textContent)) W.strays++;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      /* 注意 concat([0]) 那种"空数组兜底"写法会把 min 永远压成 0 —— 上一轮的 min:0 红的是这里，不是渲染 */
      return { samples: W.samples, strays: W.strays, zeros: W.zeros, min: W.blocks.length ? Math.min.apply(null, W.blocks) : -1, max: Math.max.apply(null, W.blocks.concat([0])) };
    }, before);
    await askIn(FG, "FENCEPROBE 未闭合代码块停 600ms 再闭合");
    const fw = await fenceWatch;
    const fenceFinal = await page.evaluate(() => {
      const box = document.getElementById("chatStream");
      const pres = box.querySelectorAll("pre");
      const last = box.querySelector(".msg-row:last-child");
      return {
        codeBlocks: box.querySelectorAll(".code-block").length,
        text: Array.prototype.map.call(pres, (p) => p.textContent).join("|"),
        stray: /```/.test(box.textContent),
        copyBtns: (last || box).querySelectorAll(".copy-btn").length,
      };
    });
    ok("全程每帧都恰好一个代码块（没有 0 个的时候，也没被拆成两个）",
      fw.samples > 5 && fw.min >= 1 && fw.max === 1, J(fw));
    ok("全程没有把 ``` 当正文露出来（未闭合时也按代码预览渲染）", fw.strays === 0 && !fenceFinal.stray, J({ 采样中见游离围栏: fw.strays, 收尾: fenceFinal.stray }));
    ok("闭合之后两行代码都在同一个块里，复制按钮也还在",
      fenceFinal.codeBlocks === 1 && /const a = 1;/.test(fenceFinal.text) && /const b = 2;/.test(fenceFinal.text) && fenceFinal.copyBtns >= 1,
      J(fenceFinal));

    /* ================= ⑤ 会话切换 ================= */
    section("⑤ 会话来回切：每块的内容各回各的 pane，切回来还在");
    await page.evaluate((c) => { openConv(c); }, BG);
    await wait(250);
    const bgShown = await page.evaluate(([needle]) => {
      const box = document.getElementById("chatStream");
      const pane = convPanes[convId];
      return { attached: !!pane && box.contains(pane), len: box.textContent.length, hasFg: box.textContent.indexOf(needle) >= 0 };
    }, [FG_NEEDLE]);
    const bgPaneNow = await paneText(BG);
    const fgPaneNow = await paneText(FG);
    ok("切到后台会话，它自己那块挂上视口且带着自己的正文",
      !!bgShown && bgShown.attached === true && bgShown.len > 500, J(bgShown));
    ok("两边正文各自完整：A 里不许有 B 的字，B 里也不许有 A 的字",
      bgPaneNow.indexOf(FG_NEEDLE) < 0 && fgPaneNow.indexOf("b0g ") < 0 && /b239g /.test(bgPaneNow) && fgPaneNow.includes(FG_NEEDLE),
      J({ bgLen: bgPaneNow.length, fgLen: fgPaneNow.length }));
    await page.evaluate((c) => { openConv(c); }, FG);
    await wait(200);
    ok("切回前台，内容仍在（不是靠那一次重绘侥幸对上）", (await paneText(FG)).includes(FG_NEEDLE), "");

    /* ================= ⑥ 尺寸曲线 ================= */
    section("⑥ 10KB / 100KB / 500KB：单帧成本随正文长度怎么长");
    const curve = [];
    for (const kb of [10, 100, 500]) {
      /* 用新会话量，避免历史正文把长度掺进来 */
      const cid = await page.evaluate(() => { newConversation(); return convId; });
      await page.evaluate(() => { window.__pReset(); window.__p.on = true; window.__evReset(); });
      const hitBase = hits.length;
      const s0 = Date.now();
      await askIn(cid, "KB" + kb + " 量这一档的单帧成本");
      await waitEnd(cid, 120000);
      await wait(400);
      const st = await snap();
      const got = await paneText(cid);
      const up = hits[hitBase] && hits[hitBase].rec;
      const recv = await page.evaluate((c) => window.__evOf(c), cid);
      curve.push({ kb, ...st, ms: Date.now() - s0, len: got.length, up: up && up.chars, recv: recv.chars });
      measure(kb + "KB · Worker 解析帧数", st.wframes, "次");
      measure(kb + "KB · 单次解析最长", st.parseMax, "ms");
      measure(kb + "KB · 解析累计", st.parseSum, "ms");
      measure(kb + "KB · 聊天区 DOM 写入次数", st.domWrites, "次");
      measure(kb + "KB · 聊天区 DOM 写入累计", st.domKB, "KB");
      measure(kb + "KB · 主线程最长一次阻塞(longtask)", st.longMax, "ms");
      measure(kb + "KB · 帧间隔最大(rAF)", st.rafMax, "ms");
      measure(kb + "KB · 排队延迟最大(MessageChannel ping)", st.pingMax, "ms");
      measure(kb + "KB · 整轮耗时", Date.now() - s0, "ms");
      measure(kb + "KB · 上游出网", (up ? up.frames : -1) + " 口 / " + (up ? up.chars : -1) + " 字", "");
      /* 这套稳定块缓存声称的全部就是"不再每帧把整篇重灌一遍"。
         所以判据按正文长度算账：写进 DOM 的总量不得超过正文的 1.5 倍
         （改造前同一台机器同一脚本量到 17 倍：500KB 正文写 8.5MB、一次 202ms 长任务）。 */
      ok(kb + "KB 的 DOM 写入总量没有随正文线性放大（≤1.5× 正文）",
        st.domKB <= kb * 1.5 + 30, "写入=" + st.domKB + "KB，正文=" + kb + "KB，共 " + st.domWrites + " 次");
      /* 分层账：①上游写出去的口/字 → ②界面收到的口/字 → ③pane 里的字。
         上一条红说明"传输/引擎少了一段"，这一条红说明"渲染丢了"。两条分开才指得出凶手。 */
      ok(kb + "KB 上游→界面一口不少（收到 " + recv.deltas + " 口 / " + recv.chars + " 字）",
        !!up && recv.deltas === up.frames && recv.chars === up.chars, J({ 上游: up, 界面: recv }));
      ok(kb + "KB 界面正文与收到的字对得上（尾针在，渲染没丢字）",
        got.includes("TAIL-" + kb + "KB") && got.length >= recv.chars * 0.9,
        "界面长度=" + got.length + " 收到=" + recv.chars);
      /* 稳定块缓存的立身之本：分段画出来的 DOM 必须与整篇渲染逐字相同，
         并且收尾之后不留下那个尾巴容器（留了就是每次都会多一个空 div）。
         不猜"哪一块是答案"：把这一会话里所有有正文的块都拉出来逐块比，任何一块不符都算红。 */
      const eq = await page.evaluate((c) => {
        /* 取块要用 convBlocks[cid]，不是全局 blocks：那个变量只是 withConv 在事件处理期间
           临时指过去的别名，事件一结束就还原成开页时那份空映射（实测 keys=0）。 */
        const all = Object.keys((convBlocks && convBlocks[c]) || {}).map((k) => convBlocks[c][k]);
        const list = all.filter((x) => x && typeof x.buf === "string" && x.buf.length > 500 && x.el);
        const bad = [];
        for (const x of list) {
          const want = renderChatMD(x.buf), got = x.el.innerHTML;
          /* 终稿之后 app 自己往这块里追加"复制全部/结论"那条操作条（.msg-actions），
             它不属于 Markdown 渲染结果，比的是"正文那一段逐字相同"，尾部多出来的一律以操作条开头为准。 */
          if (got.startsWith(want) && /^<div class="msg-actions"|^<div class="wg-|^\s*$/.test(got.slice(want.length))) continue;
          let i = 0;
          while (i < Math.min(got.length, want.length) && got[i] === want[i]) i++;
          bad.push({
            首处不同在下标: i, 界面: JSON.stringify(got.slice(i, i + 70)), 整篇: JSON.stringify(want.slice(i, i + 70)),
            gotLen: got.length, wantLen: want.length, 尾部: JSON.stringify(got.slice(want.length, want.length + 40)),
          });
        }
        return {
          n: list.length, keys: all.length, maxBuf: all.reduce((a, x) => Math.max(a, (x && x.buf ? x.buf.length : 0)), 0),
          tailLeft: list.some((x) => !!x.el.querySelector(".md-tail")), bad: bad.slice(0, 1),
        };
      }, cid);
      ok(kb + "KB 画出来的 DOM 与整篇渲染逐字相同（分段缓存没改变结果，尾巴容器也没留下）",
        eq.n >= 1 && eq.bad.length === 0 && !eq.tailLeft, J(eq));
      ok(kb + "KB 这一档页面没报错", pageErr.length === 0, pageErr.slice(0, 2).join(" | "));
    }
    const grow = curve.map((c) => c.longMax).join(" → ");
    measure("longtask 随尺寸(10→100→500KB)", grow, "ms");
    measure("DOM 写入累计随尺寸", curve.map((c) => c.domKB).join(" → "), "KB");
    measure("DOM 写入次数随尺寸", curve.map((c) => c.domWrites).join(" → "), "次");
    ok("500KB 档仍然画得出来（终稿上屏，不是卡死在白屏）",
      curve.length === 3 && curve[2].len > 300 * 1024 && curve[2].domWrites > 0,
      J(curve.length ? { len: curve[curve.length - 1].len, domWrites: curve[curve.length - 1].domWrites } : curve));

    /* 服务端日志里的 SSE 解析告警 = "回复凭空少一段"的真凶之一（llm.js 会把坏帧跳过并计一次 warn） */
    const sseWarn = (out().match(/SSE 帧 JSON 解析失败[^\n]*/g) || []);
    ok("服务端整轮没有跳过任何 SSE 帧（少一段时这里先红）", sseWarn.length === 0, sseWarn.slice(0, 2).join(" | "));

    ok("整条链路页面没有报错", pageErr.length === 0, pageErr.slice(0, 3).join(" | "));
    ok("假上游真的被打过（阳性对照：没有它整支都是空转）", hits.length >= 8, "出网 " + hits.length + " 次：" + hits.map((h) => h.kind).join(","));
  } catch (e) {
    ok("探针整条链路没抛错", false, (e && e.stack ? e.stack : String(e)).slice(0, 400));
  } finally {
    console.log("\n\x1b[1m量到的数\x1b[0m");
    for (const m of metrics) console.log("  " + m.name + " = " + m.value + " " + m.unit);
    console.log("\n共 " + (pass + fail) + " 条，红 " + fail + " 条");
    if (fail) { console.log("\n失败明细："); fails.forEach((f, i) => console.log("  " + (i + 1) + ". " + f)); }
    try { await browser.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    try { upstream.close(); } catch (e) {}
    SANDBOX.cleanup();
    process.exit(fail ? 1 : 0);
  }
})();
