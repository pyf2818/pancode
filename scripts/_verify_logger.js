/* 结构化日志 + reqId 实测（P0-A1）
   ————————————————————————————————————————————
   这条探针守的是"日志到底接上了没有"。上一版的教训很具体：logger.js 写完了、导出也齐，
   但全仓没有一个 require —— 死文件看起来像功能，只有"按 reqId 从 /api/logs 把刚才那次失败捞出来"
   这种断言才会把它现形。所以这里两段都做：
     A 段（同进程）：日志器自己的语义——级别、内存环、ALS 里的 reqId 跨 await 传播、Error 归一化。
     B 段（真服务）：一条会抛错的 WS 指令 → 前端拿到 reqId → 同一个 reqId 在服务端 stdout 和
                     /api/logs 里都查得到；顺带钉住 /api/logs 必须鉴权。
   全程一次性沙箱数据根，绝不碰开发者的 .pancode。
   用法：node scripts/_verify_logger.js
*/
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "logger" });

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.LOGGER_PORT || 8831);
const log = require("../server/logger");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- A 段：日志器语义（同进程，不需要服务端） ---------- */
async function partA() {
  section("A1 级别与内存环");
  const before = log.readRing({ limit: log.ringMax }).length;
  let printed = [];
  const origInfo = console.info, origDebug = console.debug;
  console.info = (...a) => printed.push(a.join(" "));
  console.debug = (...a) => printed.push("DBG:" + a.join(" "));
  try {
    log.tag("probe").info("一条 info", { k: 1 });
    log.tag("probe").debug("一条 debug");
  } finally { console.info = origInfo; console.debug = origDebug; }
  const ring = log.readRing({ limit: log.ringMax });
  const infoEntry = ring.filter((e) => e.msg === "一条 info")[0];
  const debugEntry = ring.filter((e) => e.msg === "一条 debug")[0];
  ok("info 进了环并带上模块标签", !!infoEntry && infoEntry.module === "probe" && infoEntry.level === "info", JSON.stringify(infoEntry));
  ok("结构化上下文跟着入环（不是只剩正文）", !!infoEntry && infoEntry.ctx && infoEntry.ctx.k === 1, JSON.stringify(infoEntry && infoEntry.ctx));
  ok("debug 低于阈值：不打到 stdout，但仍在环里",
    !!debugEntry && !printed.some((p) => /一条 debug/.test(p)), JSON.stringify(printed).slice(0, 200));
  ok("环按旧→新返回", ring.length > before && ring[ring.length - 1].ts >= ring[0].ts);
  ok("stdout 那一行带级别与标签", printed.some((p) => /\sinfo\s+\[probe\] 一条 info/.test(p)), JSON.stringify(printed).slice(0, 200));

  section("A2 reqId 跨 await 传播（ALS）");
  const rid = log.newReqId();
  await log.runWithReqId(rid, async () => {
    await wait(1);                       // 真正跨一个 await，才是 ALS 的意义所在
    log.tag("probe/nested").info("嵌套里的一条");
    log.tag("probe").tag("deeper").info("再派生一层标签");
  });
  log.info("环外的一条");
  const nested = log.readRing({ reqId: rid });
  ok("同一次操作内的日志自动带同一个 reqId", nested.length === 2, JSON.stringify(nested.map((e) => e.msg)));
  ok("派生子标签不丢 reqId", nested.every((e) => e.reqId === rid) && nested.some((e) => /deeper/.test(e.module)), JSON.stringify(nested.map((e) => e.module)));
  ok("出了这次操作就不该再挂着那个 reqId",
    log.readRing({ reqId: rid }).every((e) => e.msg !== "环外的一条"));
  ok("reqId 形状稳定（r+base36 时间戳-base36 序号）", /^r[a-z0-9]+-[a-z0-9]+$/.test(rid), rid);

  section("A3 Error 直接扔进来");
  const e = new Error("模拟一次炸");
  e.code = "E_FAKE";
  log.tag("probe").warn(e);
  const errEntry = log.readRing({ q: "模拟一次炸" })[0];
  ok("正文取 message，不是 [object Error]", !!errEntry && errEntry.msg === "模拟一次炸", JSON.stringify(errEntry));
  ok("堆栈首行与 code 落进结构化上下文",
    !!errEntry && !!errEntry.ctx && /_verify_logger\.js/.test(errEntry.ctx.at || "") && errEntry.ctx.code === "E_FAKE",
    JSON.stringify(errEntry && errEntry.ctx));
}

/* ---------- B 段：真服务端上的一次失败，能不能按 reqId 捞回来 ---------- */
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

async function partB() {
  section("B1 起沙箱服务");
  const dataDir = SANDBOX.dataDir, wsDir = SANDBOX.wsDir;
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "a.txt"), "seed\n", "utf8");
  fs.writeFileSync(path.join(dataDir, "pancode.config.json"), JSON.stringify({
    workspace: wsDir, llm: { baseURL: "http://127.0.0.1:1/v1", apiKey: "sk-sandbox", model: "mock" },
    agentMode: "agent", permissions: { mode: "ask", allow: [], deny: [] },
  }), "utf8");
  let out = "";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: SANDBOX.env({ PORT: String(PORT), NODE_NO_WARNINGS: "1", AGENT_FAST: "1" }),
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
  try {
    const anon = await req("GET", "/api/logs");
    ok("/api/logs 不在匿名白名单里（要能读出模块名与堆栈首行，就必须登录）",
      anon.status === 401, "status " + anon.status + " " + JSON.stringify(anon.json || anon.raw));

    const reg = await req("POST", "/api/auth/register", { username: "_logger_" + Date.now(), password: "test1234" });
    const token = reg.json && reg.json.token;
    if (!token) throw new Error("注册失败：" + JSON.stringify(reg.json));

    const l = await req("GET", "/api/logs", null, token);
    ok("登录后 /api/logs 可查", l.status === 200 && l.json.ok === true && Array.isArray(l.json.entries), JSON.stringify(l.json).slice(0, 160));
    ok("回的是级别与容量，前端据此知道自己在看什么",
      typeof l.json.level === "string" && l.json.capacity === log.ringMax, JSON.stringify({ level: l.json.level, capacity: l.json.capacity }));
    const bootHit = (await req("GET", "/api/logs?limit=500&q=" + encodeURIComponent("workspace 已挂载"), null, token)).json.entries || [];
    ok("启动期写的日志也在环里（不是只有报错才有）",
      bootHit.some((x) => x.module === "workspace" && /workspace 已挂载/.test(x.msg)), JSON.stringify(bootHit).slice(0, 200));

    /* 造一次真实失败：保存一个会越界的路径。safe() 抓到 → 落日志 + 回前端 op.error（带 reqId）。
       这里要验的是"三处同一个号"：前端拿到的、stdout 那行的、/api/logs 环里的。 */
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
    const got = await new Promise((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "file.save", path: "../evil-outside-workspace.txt", content: "x" })));
      ws.on("message", (raw) => {
        let ev; try { ev = JSON.parse(raw.toString()); } catch (x) { return; }
        if (ev.type === "op.error") resolve(ev);
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("没等到 op.error")), 10000);
    });
    ok("失败指令回了带 reqId 与 op 名的错误", !!got.reqId && got.op === "file.save", JSON.stringify(got).slice(0, 200));
    ok("越界路径没有写出工作区", !fs.existsSync(path.join(path.dirname(wsDir), "evil-outside-workspace.txt")));
    await wait(300);
    ok("服务端 stdout 落了带同一个 reqId 的一行（不再是一行不写）",
      new RegExp("reqId=" + got.reqId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(out), out.slice(-400));
    const found = (await req("GET", "/api/logs?reqId=" + encodeURIComponent(got.reqId), null, token)).json.entries || [];
    ok("按 reqId 能从 /api/logs 把这次失败捞出来",
      found.length >= 1 && found.some((x) => x.module === "ws" && /file\.save 失败/.test(x.msg)), JSON.stringify(found).slice(0, 260));
    const detail = found.filter((x) => x.module === "ws")[0] || {};
    ok("捞出来的那条带得回现场的错因与位置",
      !!detail.ctx && /越界/.test(String(detail.ctx.msg || "")) && !!detail.ctx.at, JSON.stringify(detail.ctx));
    try { ws.close(); } catch (x) {}
  } finally {
    child.kill();
  }
}

(async () => {
  await partA();
  await partB();
  console.log("\n" + (fail ? "\x1b[31mHAS FAIL\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { for (const f of fails) console.log("  - " + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\x1b[31mFAIL:\x1b[0m " + (e && e.stack || e)); process.exit(1); });
