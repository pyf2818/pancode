/* ============================================================
   F20-1/-3 验收：四条边界（协议 / 权限 / 生命周期 / 存储）有没有真的对账
   ————————————————————————————————————————————————————
   这一支不测界面，测的是"声明与代码是否一致"这件事本身，所以它同时干三件事：
     ① 契约自洽：结构、命名、方向、层级都必须是合法的声明；
     ② 静态对账：两个分派器（server 的 switch (m.type)、前端的 switch (ev.type)）
        里出现的每一种类型都必须在册，在册的必须有人收发 —— 双向；
     ③ 现场对账：起一个真服务端、连真 WebSocket、跑一轮带工具的对话，
        把线上真的飞过每一帧抓下来 —— 未在册即红；tier=core 的还要检查声明字段真的在帧里。
   外加一条阳性对照（⑦）：门禁得证明它会红。拿一份故意改坏的契约喂同一套比对函数，
   必须抓到 —— 只报"没报错"的门禁不算门禁。
   全程一次性沙箱数据根，绝不碰开发者的 .pancode。
   用法：node scripts/_verify_contract.js
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({
  tag: "contract",
  wsFiles: { "README.md": "# demo\n", "src/app.js": "export const a = 1;\n" },
});

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.CONTRACT_PORT || 8933);
const CONV = "conv-contract";

let pass = 0, fail = 0;
const fails = [];
const metrics = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
function measure(name, value, unit) { metrics.push({ name, value: String(value), unit }); console.log("  \x1b[36m◦\x1b[0m " + name + "：\x1b[1m" + value + "\x1b[0m " + unit); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 320); } catch (e) { return String(v).slice(0, 320); } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/* 大括号配对：把 switch (…) { … } 整块取出来，比按行猜靠谱（行正则会在嵌套 case 里跑偏）。 */
/* 前端要扫的文件：app.js 之外还有 js/ 下的模块（lsp-client 就接 lsp.*）与 index.html。 */
function pubFilesForScan() {
  return fs.readdirSync(path.join(ROOT, "public")).filter((f) => f.endsWith(".js") || f.endsWith(".html"))
    .map((f) => "public/" + f)
    .concat(fs.readdirSync(path.join(ROOT, "public", "js")).filter((f) => f.endsWith(".js")).map((f) => "public/js/" + f));
}
function switchBody(src, header) {
  const i = src.indexOf(header);
  if (i < 0) return null;
  let d = 0, j = src.indexOf("{", i);
  const start = j;
  for (; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") { d--; if (d === 0) break; }
  }
  return src.slice(start, j);
}
function casesOf(src, header) {
  const body = switchBody(src, header);
  if (body === null) return null;
  return [...new Set([...body.matchAll(/case "([a-z][a-z0-9._]*)"/g)].map((m) => m[1]))];
}

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (token) headers["x-user-token"] = token;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 20000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, raw: buf }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("请求超时")));
    if (data) r.write(data);
    r.end();
  });
}

/* ---------- 假网关：【工】→ 先回一个 write_file 工具调用，第二轮收尾正文 ---------- */
function startGateway() {
  return new Promise((res) => {
    const srv = http.createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c) => (body += c));
      rq.on("end", () => {
        if (!/chat\/completions$/.test(rq.url || "")) { rs.writeHead(404); return rs.end(); }
        let j = {};
        try { j = JSON.parse(body || "{}"); } catch (e) {}
        const msgs = j.messages || [];
        const asText = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""));
        const userText = msgs.filter((m) => m.role === "user").map(asText).filter((s) => /【回[^\]】]*】/.test(s)).pop() || "";
        const alreadyRanTool = msgs.some((m) => m.role === "tool");
        rs.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const send = (obj) => rs.write("data: " + JSON.stringify(obj) + "\n\n");
        if (/【工】/.test(userText) && !alreadyRanTool) {
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_c_1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "contract/probe.txt", content: "written-by-probe\n" }) } }] } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          rs.write("data: [DONE]\n\n"); return rs.end();
        }
        const tagM = userText.match(/【回([^\]】]*)】/);
        /* 带上 usage：不带的话 agent.usage 这一帧根本不发，字段契约就永远核不到（③ 里要量它）。 */
        send({ choices: [{ index: 0, delta: { content: "回答·" + (tagM ? tagM[1] : "默认") } }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        rs.write("data: [DONE]\n\n");
        rs.end();
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, base: "http://127.0.0.1:" + srv.address().port + "/v1" }));
  });
}

async function connect(token) {
  const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
  const frames = [];
  const waiters = [];
  ws.on("message", (raw) => {
    let ev;
    try { ev = JSON.parse(raw.toString()); } catch (e) { return; }
    frames.push(ev);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(ev)) { waiters[i].resolve(ev); waiters.splice(i, 1); }
    }
  });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve); ws.on("error", reject);
    setTimeout(() => reject(new Error("WS 连接超时")), 8000);
  });
  return {
    ws, frames,
    send: (o) => ws.send(JSON.stringify(o)),
    waitFor: (match, ms) => new Promise((resolve2, reject2) => {
      const hit = frames.find(match);
      if (hit) return resolve2(hit);
      const t = setTimeout(() => reject2(new Error("等事件超时 " + (ms || 6000) + "ms：没等到符合的那帧")), ms || 6000);
      waiters.push({ match, resolve: (ev) => { clearTimeout(t); resolve2(ev); } });
    }),
  };
}

/* 每一类帧：出现次数 + 每一帧都在的字段集合（跨帧取交集，交集才是"真契约"） */
function summarize(frames) {
  const by = new Map();
  for (const f of frames) {
    const t = String(f.type);
    if (!by.has(t)) by.set(t, { n: 0, keys: null });
    const e = by.get(t);
    e.n++;
    const ks = new Set(Object.keys(f));
    e.keys = e.keys === null ? ks : new Set([...e.keys].filter((k) => ks.has(k)));
  }
  return by;
}

/* ---------- 对账本体：纯函数，好让阳性对照喂得进假契约 ---------- */
function reconcileStatic(contractTypes, codeTypes, label) {
  const declared = new Set(contractTypes);
  const undeclared = codeTypes.filter((t) => !declared.has(t));
  const unhandled = contractTypes.filter((t) => !codeTypes.includes(t));
  return { label, undeclared, unhandled };
}

async function main() {
  const proto = require("../contracts/protocol.js");
  const bound = require("../contracts/index.js");
  const allDeclared = proto.SERVER_EVENTS.concat(proto.CLIENT_EVENTS);
  const declaredS2C = proto.SERVER_EVENTS.map((e) => e.type);
  const declaredC2S = proto.CLIENT_EVENTS.map((e) => e.type);
  /* 两份文案字典按段切，不按大括号配对 —— i18n 的值里带 {s}、{a}/{n} 这类占位符，
     拿 brace-count 去切会把占位符当结构，切出来的是半本字典。④⑤ 两段都要用它，先备好。 */
  const i18n = read("public/i18n.js");
  const zhAt = i18n.indexOf("zh: {");
  const enAt = i18n.indexOf("en: {");
  const dicts = { zh: zhAt < 0 ? "" : i18n.slice(zhAt, enAt < 0 ? i18n.length : enAt), en: enAt < 0 ? "" : i18n.slice(enAt) };
  const hasLabel = (k) => new RegExp("^\\s+" + k + "\\s*:", "m").test(dicts.zh) && new RegExp("^\\s+" + k + "\\s*:", "m").test(dicts.en);

  section("① 契约自洽：声明本身必须是合法声明");
  /* 重复只在同一个方向里算：goal.set / file.baseline 这类"前端也发、服务端也发"的类型
     本来就要在两个方向各登记一次，跨方向重名不是错。 */
  const dup = [].concat(
    declaredS2C.filter((t, i, a) => a.indexOf(t) !== i),
    declaredC2S.filter((t, i, a) => a.indexOf(t) !== i)
  );
  const seenDir = new Set(["s2c", "c2s"]);
  const badDir = allDeclared.filter((e) => !seenDir.has(e.dir));
  const badTier = allDeclared.filter((e) => e.tier !== "core" && e.tier !== "edge");
  const noDesc = allDeclared.filter((e) => !e.desc || e.desc.length < 4);
  const ghostFields = Object.keys(proto.REQUIRED_FIELDS).filter((t) => !declaredS2C.includes(t));
  const fieldLessCore = proto.SERVER_EVENTS.filter((e) => e.tier === "core" && !proto.REQUIRED_FIELDS[e.type]).map((e) => e.type);
  measure("在册类型总数（s2c / c2s）", declaredS2C.length + " / " + declaredC2S.length, "种");
  measure("tier=core 且有字段契约", proto.SERVER_EVENTS.filter((e) => e.tier === "core" && proto.REQUIRED_FIELDS[e.type]).length + " / " + proto.SERVER_EVENTS.filter((e) => e.tier === "core").length, "种");
  ok("没有重复登记的类型", dup.length === 0, J(dup));
  ok("方向只能是 s2c / c2s", badDir.length === 0, J(badDir.map((e) => e.type + "=" + e.dir)));
  ok("层级只能是 core / edge", badTier.length === 0, J(badTier.map((e) => e.type + "=" + e.dir)));
  ok("每条声明都写清了它是干什么的", noDesc.length === 0, J(noDesc.map((e) => e.type)));
  ok("字段契约只挂在在册的 s2c 类型上", ghostFields.length === 0, J(ghostFields));
  /* core 且没字段契约 = 这条其实只做类型级检查。允许存在，但必须显式挂进 UNVERIFIED_CORE，
     否则"我声明了它是 core"就成了自欺 —— 漏登记才红。 */
  const unverified = (proto.UNVERIFIED_CORE || []);
  const silentlyCore = fieldLessCore.filter((t) => !unverified.includes(t));
  ok("每个 core 类型要么有字段契约，要么被显式记为「仅类型级」", silentlyCore.length === 0,
    "没登记的：" + J(silentlyCore));

  section("② 静态对账：两端分派器与契约逐条比（双向）");
  const serverIdx = read("server/index.js");
  const appJs = read("public/app.js");
  const sHandler = casesOf(serverIdx, "switch (m.type)");
  const cHandler = casesOf(appJs, "switch (ev.type)");
  ok("前提：两个分派器都定位到了（找不到就别装成通过）", !!sHandler && !!cHandler,
    J({ server: sHandler && sHandler.length, client: cHandler && cHandler.length }));
  const rC2S = reconcileStatic(declaredC2S, sHandler || [], "c2s");
  const rS2C = reconcileStatic(declaredS2C, cHandler || [], "s2c");
  measure("前端 switch (ev.type) 实际处理", (cHandler || []).length, "种");
  measure("服务端 switch (m.type) 实际处理", (sHandler || []).length, "种");
  ok("前端处理的每种事件都在册（没有给早已不存在的类型写 case）", rS2C.undeclared.length === 0, "未在册：" + J(rS2C.undeclared));
  ok("服务端处理的每种入站消息都在册", rC2S.undeclared.length === 0, "未在册：" + J(rC2S.undeclared));
  ok("在册的每种 c2s 类型服务端都真的接", rC2S.unhandled.length === 0, "无人接：" + J(rC2S.unhandled));
  /* "在册的 s2c 有没有人接"不能只看 app.js 那一个 switch：lsp.* 由 public/js/lsp-client.js 接，
     chat.queued / chat.dequeued 由服务端的任务表接。所以把整个前端 + 服务端的事件中转都算进来，
     剩下真没人接的必须能在 UNHANDLED 里找到一条写明现状的理由。 */
  const pubAllSrc = pubFilesForScan().map((f) => read(f)).join("\n");
  const anyFrontHandler = new Set([
    ...[...pubAllSrc.matchAll(/case "([a-z][a-z0-9._]*)"/g)].map((m) => m[1]),
    ...[...pubAllSrc.matchAll(/type (?:===|!==) "([a-z][a-z0-9._]*)"/g)].map((m) => m[1]),
  ]);
  const taskBoardCases = casesOf(serverIdx, "switch (ev.type)") || [];
  const notHandled = declaredS2C.filter((t) => !anyFrontHandler.has(t) && !taskBoardCases.includes(t));
  const undocumented = notHandled.filter((t) => !proto.UNHANDLED[t]);
  const staleUnhandled = Object.keys(proto.UNHANDLED).filter((t) => anyFrontHandler.has(t) || taskBoardCases.includes(t));
  measure("s2c 里前端与任务表都不接的", notHandled.length, "种（其中 " + Object.keys(proto.UNHANDLED).length + " 种已写明现状）");
  ok("在册却真没人接的类型，必须在契约里写明现状", undocumented.length === 0, "没写理由的：" + J(undocumented));
  ok("写明「没人接」的类型今天确实还没人接（有人接了就删掉这条）", staleUnhandled.length === 0, "已经有人接了：" + J(staleUnhandled));
  /* 服务端 emit 出来的字面量类型必须全部在册 —— 这条是本次建契约时真抓到东西的那条：
     十种"代码在发、清单没有"的类型就是这么冒出来的。 */
  const serverFilesForEmit = fs.readdirSync(path.join(ROOT, "server")).filter((f) => f.endsWith(".js"));
  const emitted = new Map();
  for (const f of serverFilesForEmit) {
    const s = read(path.join("server", f));
    for (const m of s.matchAll(/(?:emit|broadcast[A-Za-z]*|send|note)\(\s*\{?\s*type:\s*"([a-z][a-z0-9._]*)"/g)) {
      if (!emitted.has(m[1])) emitted.set(m[1], new Set());
      emitted.get(m[1]).add("server/" + f);
    }
    for (const m of s.matchAll(/JSON\.stringify\(\{\s*type:\s*"([a-z][a-z0-9._]*)"/g)) {
      if (!emitted.has(m[1])) emitted.set(m[1], new Set());
      emitted.get(m[1]).add("server/" + f);
    }
  }
  const emitUndeclared = [...emitted.keys()].filter((t) => !declaredS2C.includes(t));
  measure("服务端 emit 出来的字面量类型", emitted.size, "种");
  ok("服务端发出的每一种类型都在册（新增事件必须先登记，两端才有人对账）", emitUndeclared.length === 0, "未在册：" + J(emitUndeclared));
  /* 反方向：在册却没在 emit 语句里找到字面量的，可能是走了变量（h / Object.assign），
     不一定是错的，所以只报数不判红 —— 现场那一层（③）才是"真发没发"的依据。 */
  const noLiteral = declaredS2C.filter((t) => !emitted.has(t));
  measure("在册但没找到 emit 字面量的（走变量/间接拼，交给③现场判）", noLiteral.length, "种");
  console.log("     " + noLiteral.join(", "));
  /* 反方向：前端发出的 type 字面量必须服务端接得住。
     只扫 send({ type: "…" }) 这一种写法，扫出来的都必须在 c2s 清单里。 */
  const clientSends = [...new Set([...pubAllSrc.matchAll(/send\(\{\s*type:\s*"([a-z][a-z0-9._]*)"/g)].map((m) => m[1]))];
  const orphanSends = clientSends.filter((t) => !declaredC2S.includes(t) && !sHandler.includes(t));
  measure("前端 send({ type: … }) 出现的入站类型", clientSends.length, "种");
  ok("前端发出去的每一种消息都在册且服务端接得住", orphanSends.length === 0, "幽灵发送：" + J(orphanSends));

  section("③ 现场对账：真服务端 + 真 WebSocket，逐帧核");
  const gw = await startGateway();
  /* 覆盖 _sandbox 写的"全关"配置：引擎要真指到假网关，agentMode 必须是 "agent"
     （ask 档只问不干活，工具走不到审批），逐次确认由 permissions.mode 管 ——
     这里就要它问，好把 tool.pending / tool.approve 这条链也抓进帧里。 */
  fs.writeFileSync(path.join(SANDBOX.dataDir, "pancode.config.json"), JSON.stringify({
    workspace: SANDBOX.wsDir,
    llm: { baseURL: gw.base, apiKey: "sk-sandbox", model: "mock-contract", contextWindow: 32000 },
    agentMode: "agent",
    permissions: { mode: "ask", allow: [], deny: [] },
    timeouts: { approvalSec: 120 },
  }), "utf8");
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: SANDBOX.env({ PORT: String(PORT), AGENT_FAST: "1", NODE_NO_WARNINGS: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (c) => { log = (log + c).slice(-20000); });
  server.stderr.on("data", (c) => { log = (log + c).slice(-20000); });
  let conn = null;
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { await wait(200); try { const h = await req("GET", "/api/health"); up = !!(h.json && h.json.ok); } catch (e) {} }
    if (!up) { console.error("[contract] 服务端没起来：\n" + log.slice(-2500)); process.exit(1); }
    const reg = await req("POST", "/api/auth/register", { username: "_contract_" + Date.now(), password: "test1234" });
    const token = reg.json && (reg.json.token || (reg.json.user && reg.json.user.token));
    ok("前提：注册到真令牌（拿不到就别量事件流）", !!token, J(reg.json).slice(0, 200));
    conn = await connect(token);
    await conn.waitFor((e) => e.type === "hello", 10000);

    /* 驱动：一轮带工具的对话（审批放行，工具链才真跑得完）+ 文件/目录/搜索/终端/压缩/切会话 */
    conn.send({ type: "chat", text: "写个文件【工】【回甲】", convId: CONV });
    const pending = await conn.waitFor((e) => e.type === "tool.pending", 20000).catch(() => null);
    if (pending) conn.send({ type: "tool.approve", id: pending.id });
    await conn.waitFor((e) => e.type === "msg.end" && e.convId === CONV, 25000).catch(() => {});
    conn.send({ type: "file.create", path: "contract/new.txt", content: "created\n" });
    conn.send({ type: "file.save", path: "contract/new.txt", content: "saved\n" });
    conn.send({ type: "file.read", path: "README.md" });
    conn.send({ type: "file.baseline", path: "README.md" });
    /* 两条失败路径也要抓到：file.error / op.error 只在出错时发，
       而它们恰恰是"用户看得见的那一句"，字段没核对就等于没测。 */
    conn.send({ type: "file.read", path: "no/such/file.txt" });
    conn.send({ type: "file.baseline", path: "no/such/file.txt" });
    conn.send({ type: "tree.load", dir: "no/such/dir", offset: 0 });
    conn.send({ type: "search", query: "" });
    conn.send({ type: "tree.load", dir: "src", offset: 0 });
    conn.send({ type: "search", query: "demo" });
    conn.send({ type: "term.open", id: "t1" });
    conn.send({ type: "term.exec", id: "t1", cmd: "echo contract-term-probe" });
    conn.send({ type: "compact.now", convId: CONV });
    conn.send({ type: "ctx.query", convId: CONV });
    conn.send({ type: "newchat" });
    await wait(2500);
    conn.send({ type: "chat", text: "再说一句【回乙】", convId: CONV });
    await conn.waitFor((e) => e.type === "agent.done" && e.convId === CONV, 20000).catch(() => {});
    await wait(600);

    const sum = summarize(conn.frames);
    if (process.env.CONTRACT_DUMP) {
      console.log("\n  \x1b[33m[dump] 现场抓到的类型 → 每一帧都有的字段\x1b[0m");
      for (const [t, e] of [...sum].sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log("    " + t + "  ×" + e.n + "  [" + [...e.keys].sort().join(", ") + "]");
      }
      console.log("");
    }
    const observed = [...sum.keys()].filter((t) => /^[a-z]/.test(t));
    measure("现场抓到帧的类型数", observed.length, "种（总帧数 " + conn.frames.length + "）");
    measure("其中已核对字段契约的 core 类型", proto.SERVER_EVENTS.filter((e) => e.tier === "core" && proto.REQUIRED_FIELDS[e.type] && sum.has(e.type)).length, "种");
    const wild = observed.filter((t) => !declaredS2C.includes(t));
    ok("线上飞过的每一帧都在册（冒出来的新类型必须先登记）", wild.length === 0, "未在册：" + J(wild));
    const fieldMiss = [];
    for (const [t, e] of sum) {
      const need = proto.REQUIRED_FIELDS[t];
      if (!need) continue;
      const missing = need.filter((k) => !e.keys.has(k));
      if (missing.length) fieldMiss.push(t + " 缺 " + missing.join("/") + "（" + e.n + " 帧里都不是每帧都有）");
    }
    ok("core 帧声明的字段真的在每一帧里出现", fieldMiss.length === 0, J(fieldMiss));
    const notDriven = declaredS2C.filter((t) => !sum.has(t));
    measure("本轮没驱动到的在册类型（只做了类型级在册，没做字段级）", notDriven.length, "种");
    console.log("     未驱动：" + notDriven.join(", "));
    ok("抓到过 tool.start / tool.end 且中间真的执行了工具（不是只看最终文本）",
      sum.has("tool.start") && sum.has("tool.end"), J([...sum.keys()].filter((t) => t.startsWith("tool."))));
  } finally {
    if (conn) { try { conn.ws.close(); } catch (e) {} }
    try { gw.srv.close(); } catch (e) {}
    try { server.kill(); } catch (e) {}
    await wait(200);
  }

  section("④ 权限档：服务端清单 = 契约登记 = 界面选项");
  /* 服务端的唯一清单是 server/config.js 里的 PERMISSION_MODES 常量 —— 直接读它，
     不去抠 permission-core 里的 mode === "x" 分支（那里的 ask 是兜底 return，抠不到，
     抠到的反而是分支里出现的档，两边口径不一样就会假红）。 */
  const cfgSrc = read("server/config.js");
  const canonicalM = /const PERMISSION_MODES\s*=\s*\[([^\]]*)\]/.exec(cfgSrc);
  const modesServer = canonicalM ? [...canonicalM[1].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]) : [];
  const modesDeclared = bound.PERMISSION_MODES.map((m) => m.mode);
  const uiOpts = [...appJs.matchAll(/value="([a-zA-Z]+)"\s*data-i18n="(permOpt[A-Za-z]+)"/g)];
  const modesUi = [...new Set(uiOpts.map((m) => m[1]))];
  measure("契约 / 服务端清单 / 界面选项", modesDeclared.length + " / " + modesServer.length + " / " + modesUi.length, "档");
  ok("前提：服务端清单与界面选项都读到了（读空了就等于没检查）",
    modesServer.length >= 2 && modesUi.length >= 1, J({ 服务端: modesServer, 界面: modesUi }));
  const modeMiss = modesServer.filter((m) => !modesDeclared.includes(m));
  const modeStale = modesDeclared.filter((m) => !modesServer.includes(m));
  ok("服务端每认一种档，契约就登记一种", modeMiss.length === 0, "服务端认但没登记：" + J(modeMiss));
  ok("契约里每档服务端都真认（没有作废的声明）", modeStale.length === 0, "登记了但服务端没有：" + J(modeStale));
  ok("界面给的每一档服务端都认", modesUi.filter((m) => !modesServer.includes(m)).length === 0,
    "界面有但服务端不认：" + J(modesUi.filter((m) => !modesServer.includes(m))));
  const optLabelMiss = uiOpts.filter((m) => !hasLabel(m[2])).map((m) => m[1] + "@" + m[2]);
  ok("界面每档的文案两份字典都有", optLabelMiss.length === 0, J(optLabelMiss));
  const defMode = /mode:\s*"([a-zA-Z]+)"/.exec(cfgSrc);
  const declaredDefault = (bound.PERMISSION_MODES.find((m) => m.isDefault) || {}).mode;
  ok("契约写的默认档与服务端配置默认值一致", !!(defMode && defMode[1] === declaredDefault), J({ 契约: declaredDefault, 配置: defMode && defMode[1] }));

  section("⑤ 生命周期：agent.state 的文案 key 两份字典都得有");
  measure("zh / en 字典条目", (dicts.zh.match(/^\s+\w+:\s*"/gm) || []).length + " / " + (dicts.en.match(/^\s+\w+:\s*"/gm) || []).length, "条");
  const labelMiss = bound.LIFECYCLE.stateLabelKeys.filter((k) => !hasLabel(k));
  ok("每个 labelKey 都有中英文案（缺一个界面就显示字面量 key）", labelMiss.length === 0, J(labelMiss));
  /* 服务端在 agent.state 这一帧里到底会给哪些文案 key：直接看发这一帧的那些行，
     把行里的字符串字面量收下来（labelKey 是三元表达式，按"赋值右边的标识符"去抠只会抠到 label 这个变量名）。 */
  const stateLines = ["server/agent-llm.js", "server/agent-base.js"]
    .flatMap((f) => read(f).split(/\r?\n/))
    .filter((l) => /agent\.state/.test(l) && /emit|send|broadcast/.test(l));
  const emittedLabels = [...new Set(stateLines.flatMap((l) => [...l.matchAll(/"([a-zA-Z][a-zA-Z0-9_]{2,})"/g)].map((m) => m[1])))].filter((k) => k !== "agent.state");
  const unknownLabels = emittedLabels.filter((k) => !bound.LIFECYCLE.stateLabelKeys.includes(k));
  measure("服务端实际给出的 labelKey", J(emittedLabels), "");
  ok("服务端给出的每个 labelKey 都在契约词汇表里", unknownLabels.length === 0, "未登记：" + J(unknownLabels));
  const termMiss = bound.LIFECYCLE.terminalEvents.filter((t) => !declaredS2C.includes(t));
  ok("收口事件全部在册（一轮运行必须有终点）", termMiss.length === 0, J(termMiss));

  section("⑥ 存储：键名与数据根子目录双向对账");
  /* 键名的对账口径：不抠"哪次调用读了哪个键"（键名藏在常量与函数里，抠不干净），
     而是收全部 "cw-*" / 已登记的 "ag-*-h" 字面量 —— cw- 这个前缀在本工程里就是存储键名。
     双向都比：出现了却没登记的（改了名，老用户偏好静默丢）红；登记了却查无此串的（作废声明）也红。 */
  const pubFiles = pubFilesForScan();
  const pubAll = pubFiles.map((f) => read(f)).join("\n");
  const cwLits = [...new Set([...pubAll.matchAll(/"(cw-[a-z0-9_:.-]*)"/g)].map((m) => m[1]))].sort();
  const norm = (s) => s.replace(/[:.-]+$/, "");
  const dynBases = bound.STORAGE.dynamicKeyPrefixes.map(norm);
  const declaredSet = new Set(bound.STORAGE.localStorageKeys);
  const covered = (k) => declaredSet.has(k) || declaredSet.has(norm(k)) || dynBases.includes(norm(k));
  const lsUndeclared = cwLits.filter((k) => !covered(k));
  /* "在册的键真的在用"按字面量查（ag-changed-h 这类键不带 cw- 前缀，不能只靠上面那份清单） */
  const lsUnused = bound.STORAGE.localStorageKeys.filter((k) => !pubAll.includes('"' + k + '"'));
  const dynUnused = bound.STORAGE.dynamicKeyPrefixes.filter((p) => !pubAll.includes('"' + p + '"') && !pubAll.includes('"' + norm(p) + '"'));
  measure("前端出现的 cw-* 字面量", cwLits.length, "个");
  measure("契约在册（固定键 / 动态前缀）", bound.STORAGE.localStorageKeys.length + " / " + bound.STORAGE.dynamicKeyPrefixes.length, "个");
  ok("每个存储键都在册（键名一改，老用户的偏好就静默丢了）", lsUndeclared.length === 0, "未在册：" + J(lsUndeclared));
  ok("在册的固定键前端都真的在用（没有早已作废的声明）", lsUnused.length === 0, "没人用：" + J(lsUnused));
  ok("登记的动态键前缀确实在代码里出现", dynUnused.length === 0, "查无此源：" + J(dynUnused));

  const dataDirMiss = [], dataDirStale = [];
  for (const d of bound.STORAGE.dataDirs) {
    for (const f of d.files) {
      let src = "";
      try { src = read(f); } catch (e) { dataDirStale.push(d.dir + " → " + f + " 读不到"); continue; }
      if (!src.includes('"' + d.dir + '"')) dataDirMiss.push(d.dir + " 没在 " + f + " 里出现");
    }
  }
  ok("每个数据根子目录在其登记的每个文件里都真的拼了这个路径", dataDirMiss.length === 0, J(dataDirMiss));
  ok("登记的 owner 都指得到真文件", dataDirStale.length === 0, J(dataDirStale));
  /* 双向的另外一半：服务端在数据根下拼出来的目录，契约里必须登记（连在哪个文件拼的都登记）。
     扫法照 agent-traces 的真实写法：path.join(config.ROOT, ".pancode", "<目录>")。 */
  const serverFiles = fs.readdirSync(path.join(ROOT, "server")).filter((f) => f.endsWith(".js"));
  const seenDirs = new Map();
  for (const f of serverFiles) {
    const s = read(path.join("server", f));
    /* 必须是 join(...) 里的相邻实参，不能只看 `".pancode", "x"` ——
       否则 code-index 的 SKIP_DIRS（一个把 ".pancode" 和 "out" 并排列着的数组）会被当成"拼了个新目录"。 */
    for (const m of s.matchAll(/(?:join|resolve)\([^)]{0,160}?"\.pancode"\s*,\s*"([a-z][a-z0-9_-]{2,22})"/g)) {
      if (!seenDirs.has(m[1])) seenDirs.set(m[1], new Set());
      seenDirs.get(m[1]).add("server/" + f);
    }
  }
  const declaredDirs = new Map(bound.STORAGE.dataDirs.map((d) => [d.dir, new Set(d.files)]));
  const dirUndeclared = [...seenDirs.keys()].filter((d) => !declaredDirs.has(d));
  const fileUndeclared = [];
  for (const [d, where] of seenDirs) {
    const dec = declaredDirs.get(d);
    if (!dec) continue;
    for (const f of where) if (!dec.has(f)) fileUndeclared.push(d + " 在 " + f + " 里拼了这个目录，契约没登记这个文件");
  }
  measure("服务端以 .pancode 拼出的数据根子目录", seenDirs.size, "个");
  ok("前提：这种拼法真扫得到目录（扫到 0 个等于没检查这一条）", seenDirs.size >= 5, "实际扫到 " + seenDirs.size + " 个");
  ok("数据根下每拼一个目录，契约里就登记一个", dirUndeclared.length === 0, "未登记：" + J(dirUndeclared));
  ok("拼这个目录的每个文件都在契约里（读写两端同源的机器版）", fileUndeclared.length === 0, J(fileUndeclared));

  section("⑦ 阳性对照：这套门禁真的会红");
  const brokenA = reconcileStatic(declaredS2C.filter((t) => t !== "msg.delta"), ["hello", "msg.delta", "brand.new.event"], "少登记");
  ok("代码里有、契约没登记的类型会被抓到", brokenA.undeclared.includes("msg.delta") && brokenA.undeclared.includes("brand.new.event"), J(brokenA.undeclared));
  const brokenB = reconcileStatic(["hello", "brand.gone.event"], ["hello"], "多登记");
  ok("契约里登记了、前端却没人处理的类型会被抓到", brokenB.unhandled.includes("brand.gone.event"), J(brokenB.unhandled));
  const brokenFields = [];
  const fakeSum = new Map([["msg.end", { n: 3, keys: new Set(["type", "convId"]) }]]);
  for (const [t, e] of fakeSum) {
    const need = proto.REQUIRED_FIELDS[t];
    if (!need) continue;
    const missing = need.filter((k) => !e.keys.has(k));
    if (missing.length) brokenFields.push(t + " 缺 " + missing.join("/"));
  }
  ok("真帧缺了声明字段时，字段级对账会抓到", brokenFields.length === 1 && /id/.test(brokenFields[0]), J(brokenFields));
  const fakeFieldContract = { msg: ["nope"] };
  ok("把字段契约挂到不存在的类型上时，自洽检查会抓到",
    Object.keys(fakeFieldContract).some((t) => !declaredS2C.includes(t)), J(fakeFieldContract));

  console.log("\n\x1b[1m量到的数\x1b[0m");
  for (const m of metrics) console.log("  " + m.name + " = " + m.value + " " + m.unit);
  console.log("\n共 " + (pass + fail) + " 条，红 " + fail + " 条");
  if (fail) { console.log("\n失败明细："); fails.forEach((f, i) => console.log("  " + (i + 1) + ". " + f)); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("[contract] 探针自身抛错：" + (e && e.stack || e));
  if (fails.length) console.log("已红的判据：" + fails.join(" | "));
  process.exit(1);
});
