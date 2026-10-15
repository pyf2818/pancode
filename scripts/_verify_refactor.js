/* 跨文件改名实测（P2-C2）
   ————————————————————————————————————————————
   守的是三件事，全部只能在"真引擎 + 真落盘 + 真撤销栈"上验：
     1) 默认只给预览，一个字节都不写；带 apply:true 才落盘；
     2) 落盘整批走 edit_files —— 一次调用一个检查点，/undo 一次撤掉全部文件；
     3) 边界：前后缀同名（getUserScore）不动、字符串/注释里的同名默认不动、
        文档与数据文件默认不动、新名字已存在时直接拒绝而不是改出重名。
   工作区里所有 fixture 都是真文件，断言读的是磁盘上的字节，不是返回值。
   全程一次性沙箱数据根，绝不碰开发者的 .pancode。
   用法：node scripts/_verify_refactor.js
*/
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "refactor" });

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.REFACTOR_PORT || 8839);

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const WS_DIR = SANDBOX.wsDir;
const F = (n) => path.join(WS_DIR, n);
const read = (n) => { try { return fs.readFileSync(F(n), "utf8"); } catch (e) { return null; } };

const USER_JS = [
  "// getUser 的说明：注释里也提到 getUser",
  "function getUser(id) {",
  "  return db.query(\"SELECT getUser FROM x\");",
  "}",
  "module.exports = { getUser };",
  "",
].join("\n");
const API_JS = [
  "const { getUser } = require(\"./user\");",
  "exports.handler = async (e) => getUser(e.id);",
  "",
].join("\n");
const OTHER_JS = "function getUserScore(u) { return u.score; }\nconst tag = \"getUser\";\n";
const README_MD = "# 用法\n\n调用 getUser 拿到用户。\n";

function seed() {
  fs.mkdirSync(path.join(WS_DIR, "src"), { recursive: true });
  fs.mkdirSync(path.join(WS_DIR, "docs"), { recursive: true });
  fs.writeFileSync(F("src/user.js"), USER_JS, "utf8");
  fs.writeFileSync(F("src/api.js"), API_JS, "utf8");
  fs.writeFileSync(F("src/other.js"), OTHER_JS, "utf8");
  fs.writeFileSync(F("docs/readme.md"), README_MD, "utf8");
}

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (token) headers["x-user-token"] = token;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 20000 }, (res) => {
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

/* ---------- 假网关：按用户消息里的【场景】决定吐哪个 tool_call ---------- */
/* 工具回执从网关这一侧取：探针要断言的是"模型到底读到了什么"，
   而 tool.end 事件里只有卡片标题（预览那条路径甚至不开卡）。
   每个场景用独立 convId，所以下一次请求里的 role:"tool" 必然只属于本场景。 */
const toolText = {};
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
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") lastUserIdx = i;
        const alreadyRan = lastUserIdx >= 0 && msgs.slice(lastUserIdx + 1).some((m) => m.role === "tool");
        rs.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const send = (o) => rs.write("data: " + JSON.stringify(o) + "\n\n");
        const toolCall = (name, args) => {
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_rf_" + scene, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          rs.write("data: [DONE]\n\n"); rs.end();
        };
        const say = (t) => {
          send({ choices: [{ index: 0, delta: { content: t } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          rs.write("data: [DONE]\n\n"); rs.end();
        };
        if (alreadyRan) {
          const got = msgs.slice(lastUserIdx + 1).filter((m) => m.role === "tool").map(asText).join("\n");
          toolText[scene] = (toolText[scene] || "") + "\n" + got;
          return say("场景 " + scene + " 跑完");
        }
        if (scene === "预览") return toolCall("rename_symbol", { name: "getUser", to: "loadUser" });
        if (scene === "应用") return toolCall("rename_symbol", { name: "getUser", to: "loadUser", apply: true });
        if (scene === "字面量") return toolCall("rename_symbol", { name: "getUser", to: "loadUser", includeLiterals: true, apply: true });
        if (scene === "撞车") return toolCall("rename_symbol", { name: "getUser", to: "getUserScore", apply: true });
        if (scene === "不存在") return toolCall("rename_symbol", { name: "noSuchSymbolAtAll", to: "whatever", apply: true });
        if (scene === "引用") return toolCall("find_references", { name: "getUser" });
        if (scene === "撤销") return toolCall("undo", {});
        return say("没有匹配的场景：" + scene);
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, base: "http://127.0.0.1:" + srv.address().port + "/v1" }));
  });
}

async function runScene(conn, scene, ms) {
  const conv = "rf-" + scene + "-" + Date.now();
  const before = conn.events.length;
  conn.send({ type: "chat", text: "【场景" + scene + "】请按这个场景调用工具", convId: conv });
  let done = null;
  try {
    done = await conn.waitFor((e) => e.type === "agent.done" && e.convId === conv && conn.events.indexOf(e) >= before, ms || 25000);
  } catch (e) { return { done: null, conv, tools: [], text: "" }; }
  await wait(150);
  const tools = conn.events.slice(before).filter((e) => e.type === "tool.end" && e.convId === conv);
  return { done, conv, tools, text: conn.events.slice(before).filter((e) => e.type === "msg.delta" && e.convId === conv).map((e) => e.text || "").join("") };
}
/* 正向对照：断言"文件没被改"之前，先证明工具真跑到了、模型真读到了回执 */
const got = (scene) => toolText[scene] || "";
const ranScene = (r, scene) => !!r.done && got(scene).length > 0;

(async () => {
  section("起沙箱服务");
  seed();
  const gw = await startGateway();
  fs.mkdirSync(SANDBOX.dataDir, { recursive: true });
  fs.writeFileSync(path.join(SANDBOX.dataDir, "pancode.config.json"), JSON.stringify({
    workspace: WS_DIR,
    llm: { baseURL: gw.base, apiKey: "sk-sandbox", model: "mock-rf", contextWindow: 32000 },
    agentMode: "agent",
    permissions: { mode: "auto", allow: [], deny: [] },
  }), "utf8");
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
    try { const h = await req("GET", "/api/health"); if (h.json && h.json.ok) { up = true; break; } } catch (x) {}
  }
  if (!up) { child.kill(); gw.srv.close(); throw new Error("服务未就绪\n" + out.slice(-1200)); }
  const reg = await req("POST", "/api/auth/register", { username: "_rf_" + Date.now(), password: "test1234" });
  const token = reg.json && reg.json.token;
  if (!token) { child.kill(); gw.srv.close(); throw new Error("注册失败：" + JSON.stringify(reg.json)); }

  const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
  const events = [];
  const waiters = [];
  ws.on("message", (raw) => {
    let ev; try { ev = JSON.parse(raw.toString()); } catch (x) { return; }
    events.push(ev);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].match(ev)) { waiters[i].resolve(ev); waiters.splice(i, 1); }
  });
  const conn = {
    events,
    send: (o) => ws.send(JSON.stringify(o)),
    waitFor: (match, ms) => new Promise((resolve, reject) => {
      const hit = events.find(match);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error("等事件超时 " + (ms || 8000) + "ms")), ms || 8000);
      waiters.push({ match, resolve: (ev) => { clearTimeout(t); resolve(ev); } });
    }),
  };
  await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); setTimeout(() => reject(new Error("WS 超时")), 8000); });
  await conn.waitFor((e) => e.type === "hello", 15000);

  try {
    section("① 默认只给预览：一个字节都不写");
    const r1 = await runScene(conn, "预览");
    ok("工具真跑到了（正向对照，否则下面的否定断言全是假绿）", ranScene(r1, "预览"), got("预览").slice(0, 200));
    ok("预览说清了命中几处、几个文件", /命中 \d+ 处 \/ \d+ 个文件/.test(got("预览")), got("预览").slice(0, 200));
    ok("预览里点名了 src/user.js 与 src/api.js", /src\/user\.js/.test(got("预览")) && /src\/api\.js/.test(got("预览")), got("预览").slice(0, 260));
    ok("注释 / 字符串里的同名被单独计数（不静默少改）", /字符串|注释/.test(got("预览")), got("预览").slice(0, 260));
    ok("文档默认不改，但报出了它在文档里看到了几处", /文档/.test(got("预览")) && /readme\.md/.test(got("预览")), got("预览").slice(0, 300));
    ok("三个源码文件一个都没动",
      read("src/user.js") === USER_JS && read("src/api.js") === API_JS && read("src/other.js") === OTHER_JS,
      JSON.stringify({ u: read("src/user.js").slice(0, 24), o: read("src/other.js").slice(0, 24) }));

    section("② 查引用是纯读的");
    const r2 = await runScene(conn, "引用");
    ok("find_references 真跑到了", ranScene(r2, "引用"), got("引用").slice(0, 160));
    ok("命中行标出了声明处（改名前要先确认改的是哪个符号）", /声明/.test(got("引用")), got("引用").slice(0, 300));
    ok("查完文件仍未改动", read("src/user.js") === USER_JS, read("src/user.js").slice(0, 30));

    section("③ apply:true 才落盘，且边界都对");
    const r3 = await runScene(conn, "应用");
    ok("落盘真发生了（模型读到了原子写入的回执）", /已原子写入|已写入/.test(got("应用")), got("应用").slice(0, 220));
    ok("user.js 的函数名与导出都改了", /function loadUser\(id\)/.test(read("src/user.js")) && /\{ loadUser \}/.test(read("src/user.js")), read("src/user.js"));
    ok("api.js 的 import 与调用都改了", /const \{ loadUser \}/.test(read("src/api.js")) && /loadUser\(e\.id\)/.test(read("src/api.js")), read("src/api.js"));
    ok("注释里的旧名保持原样（默认不动字面量与注释）", /\/\/ getUser 的说明/.test(read("src/user.js")), read("src/user.js").split("\n")[0]);
    ok("字符串字面量里的 getUser 没被当成代码改", /"SELECT getUser FROM x"/.test(read("src/user.js")), read("src/user.js").split("\n")[2]);
    ok("前后缀同名 getUserScore 一个字节没动", read("src/other.js") === OTHER_JS, read("src/other.js"));
    ok("文档里的 getUser 没被改", read("docs/readme.md") === README_MD, read("docs/readme.md"));
    ok("回执里承诺了 /undo 一次撤掉整批", /undo/.test(got("应用")), got("应用").slice(0, 200));

    section("④ 一次撤销撤掉整批改名（一次调用只有一个检查点）");
    const r4 = await runScene(conn, "撤销");
    ok("undo 真跑到了", ranScene(r4, "撤销"), got("撤销").slice(0, 200));
    ok("user.js 回到原样", read("src/user.js") === USER_JS, JSON.stringify(read("src/user.js").slice(0, 40)));
    ok("api.js 也回到原样（同一次调用的第二个文件一起撤）", read("src/api.js") === API_JS, JSON.stringify(read("src/api.js").slice(0, 40)));

    section("⑤ 新名字已存在：直接拒绝，不写出重名");
    const r5 = await runScene(conn, "撞车");
    ok("撞车被拒（回执里有目标名已存在的说明）", /已经存在于|已存在/.test(got("撞车")), got("撞车").slice(0, 220));
    ok("拒绝之后 user.js 一字未动", read("src/user.js") === USER_JS, read("src/user.js").slice(0, 30));

    section("⑥ includeLiterals 才动字符串与注释");
    const r6 = await runScene(conn, "字面量");
    ok("这一轮真落了盘", /已原子写入|已写入/.test(got("字面量")), got("字面量").slice(0, 200));
    ok("注释与字符串里的同名这次一起改了",
      /\/\/ loadUser 的说明/.test(read("src/user.js")) && /"SELECT loadUser FROM x"/.test(read("src/user.js")),
      JSON.stringify(read("src/user.js").split("\n").slice(0, 3)));
    ok("getUserScore 仍然没被牵连", /function getUserScore/.test(read("src/other.js")), read("src/other.js"));

    section("⑦ 查无此名：说清楚而不是改一半");
    /* 基线取"这一刻"的样子：上一轮（字面量改名）合法地改过这些文件，
       拿最初的常量来比会把正确行为判成失败。 */
    const before7 = { api: read("src/api.js"), other: read("src/other.js"), user: read("src/user.js"), md: read("docs/readme.md") };
    const r7 = await runScene(conn, "不存在");
    ok("回执说没有任何命中", /没有任何叫 noSuchSymbolAtAll/.test(got("不存在")), got("不存在").slice(0, 200));
    ok("所有文件与进这一轮之前逐字相同",
      read("src/api.js") === before7.api && read("src/other.js") === before7.other &&
      read("src/user.js") === before7.user && read("docs/readme.md") === before7.md,
      JSON.stringify({ api: read("src/api.js") === before7.api, other: read("src/other.js") === before7.other }));

    section("⑧ 服务端侧的静默失败检查");
    ok("整轮没有出现未捕获异常", !/UNCAUGHT|TypeError: |ReferenceError: /.test(out), (out.match(/.{0,160}(TypeError|ReferenceError).{0,160}/) || [""])[0]);
  } finally {
    ws.close();
    child.kill();
    gw.srv.close();
  }
  console.log("\n[P2-C2] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e && e.stack || e); process.exit(1); });
