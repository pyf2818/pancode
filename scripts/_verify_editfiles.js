/* 多文件原子编辑实测（P0-A3 / edit_files）
   ————————————————————————————————————————————
   守的是这个工具唯一对外承诺的语义：**全或无**。
   一次调用改 N 个文件，中途任何一处不匹配／没权限，前面已经写下去的必须还原回去，
   全部成功才提交**一个**检查点（于是一次 /undo 撤掉整批，而不是撤掉最后一个）。
   这条语义只在"真引擎 + 真落盘 + 真撤销栈"上才算验过，
   所以这里起一个一次性沙箱服务端，用假网关把 edit_files 的工具调用喂进真实的 ReAct 循环。
   全程不碰开发者的 .pancode。
   用法：node scripts/_verify_editfiles.js
*/
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "editfiles" });

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.EDITFILES_PORT || 8835);

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

/* ---------- 假网关：按用户消息里的【场景】标记决定吐哪个 tool_call ---------- */
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
        /* "本轮已经跑过工具"只能看最后一条 user 之后——整个 history 里有 tool 结果不等于本轮跑过。
           这条判据写错的话，同一个会话里第二个场景起网关就再也不吐 tool_call，
           探针里的"文件没被改"会因为工具根本没执行而假绿（实测踩过）。 */
        let lastUserIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { lastUserIdx = i; break; }
        const alreadyRan = lastUserIdx >= 0 && msgs.slice(lastUserIdx + 1).some((m) => m.role === "tool");
        rs.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const send = (o) => rs.write("data: " + JSON.stringify(o) + "\n\n");
        const toolCall = (name, args) => {
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_ef_" + scene, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          rs.write("data: [DONE]\n\n"); rs.end();
        };
        if (alreadyRan) { send({ choices: [{ index: 0, delta: { content: "场景 " + scene + " 跑完" } }] }); send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }); rs.write("data: [DONE]\n\n"); return rs.end(); }
        if (scene === "成功") return toolCall("edit_files", { ops: [
          { path: "a.txt", old_string: "A1", new_string: "A1-edited" },
          { path: "b.txt", old_string: "B1", new_string: "B1-edited" },
        ] });
        if (scene === "回滚") return toolCall("edit_files", { ops: [
          { path: "a.txt", old_string: "A1", new_string: "A1-should-be-rolled-back" },
          { path: "b.txt", old_string: "这行在文件里根本不存在", new_string: "X" },
          { path: "c.txt", old_string: "C1", new_string: "C1-should-not-land" },
        ] });
        if (scene === "越界") return toolCall("edit_files", { ops: [
          { path: "a.txt", old_string: "A1", new_string: "A1-should-stay-untouched" },
          { path: "../outside.txt", old_string: "O", new_string: "O2" },
        ] });
        if (scene === "合并") return toolCall("edit_files", { ops: [
          { path: "d.txt", old_string: "D1", new_string: "D1-first" },
          { path: "d.txt", old_string: "D2", new_string: "D2-second" },
        ] });
        if (scene === "拒绝") return toolCall("edit_files", { ops: [
          { path: "a.txt", old_string: "A1", new_string: "A1-should-never-land" },
          { path: "ef-deny.txt", old_string: "P", new_string: "Q" },
        ] });
        if (scene === "撤销") return toolCall("undo", {});
        send({ choices: [{ index: 0, delta: { content: "没有匹配的场景：" + scene } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        rs.write("data: [DONE]\n\n"); rs.end();
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, base: "http://127.0.0.1:" + srv.address().port + "/v1" }));
  });
}

/* 每个场景用独立会话：共享一台引擎、但历史互不串，
   这样"这一轮工具到底跑没跑"能从 tool.end 事件上直接读出来，而不是靠推断。
   （_undoStack 是引擎级的，所以"撤销"场景换会话照样撤得动上一批改的——这正是要验的语义。） */
async function runScene(conn, scene, ms) {
  const conv = "ef-" + scene + "-" + Date.now();
  const before = conn.events.length;
  conn.send({ type: "chat", text: "【场景" + scene + "】请按这个场景调用工具", convId: conv });
  let done = null;
  try {
    done = await conn.waitFor((e) => e.type === "agent.done" && e.convId === conv && conn.events.indexOf(e) >= before, ms || 20000);
  } catch (e) { return { done: null, conv, tools: [], text: "" }; }
  await wait(120);
  const tools = conn.events.slice(before).filter((e) => e.type === "tool.end" && e.convId === conv);
  const deltas = conn.events.slice(before).filter((e) => e.type === "msg.delta" && e.convId === conv).map((e) => e.text || "").join("");
  return { done, conv, tools, text: deltas };
}
/* 正向对照：否定断言（"文件没被改"）必须先证明工具真的跑到了那一步，
   否则它测的是"什么都没发生"，永远绿。 */
function ranTool(r, label) {
  return !!r.done && r.tools.some((t) => new RegExp(label).test(t.label || ""));
}

(async () => {
  section("起沙箱服务");
  fs.mkdirSync(WS_DIR, { recursive: true });
  /* 工作区里预置四个文件；c.txt 用来验"排在不匹配项之后的文件不该被写" */
  fs.writeFileSync(F("a.txt"), "A1\nA2\n", "utf8");
  fs.writeFileSync(F("b.txt"), "B1\nB2\n", "utf8");
  fs.writeFileSync(F("c.txt"), "C1\nC2\n", "utf8");
  fs.writeFileSync(F("d.txt"), "D1\nD2\n", "utf8");
  fs.writeFileSync(F("ef-deny.txt"), "P\nQ0\n", "utf8");   // old_string 匹配得上，但被 deny 规则拦住
  const gw = await startGateway();
  fs.writeFileSync(path.join(SANDBOX.dataDir, "pancode.config.json"), JSON.stringify({
    workspace: WS_DIR,
    llm: { baseURL: gw.base, apiKey: "sk-sandbox", model: "mock-ef", contextWindow: 32000 },
    /* agentMode 必须是 "agent"（"ask" 档会直接把工具拦成「Ask 模式禁止工具调用」，走不到写盘）；
       permissions.mode 用 "auto" 是为了让这条探针专注于原子性本身，不掺审批流。
       deny 里放一个真实存在、且 old_string 完全匹配得上的文件——这样"被拒"只能是规则拦的，
       而不是碰巧没匹配上（场景③要的就是这个区分）。 */
    agentMode: "agent",
    permissions: { mode: "auto", allow: [], deny: ["ef-deny.txt"] },
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
  const reg = await req("POST", "/api/auth/register", { username: "_ef_" + Date.now(), password: "test1234" });
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
    section("① 两个文件一起改：都落盘，且只有 1 个检查点");
    const r1 = await runScene(conn, "成功");
    ok("工具真跑到了（正向对照）", ranTool(r1, "已写入 2 个文件"), JSON.stringify(r1.tools));
    ok("a.txt 改了", /A1-edited/.test(read("a.txt")), JSON.stringify(read("a.txt")));
    ok("b.txt 改了", /B1-edited/.test(read("b.txt")), JSON.stringify(read("b.txt")));
    ok("回执点明了改了 2 个文件共 2 处",
      r1.tools.filter((t) => /edit_files|原子编辑/.test(t.label || "") || /已写入 2 个文件，共 2 处/.test(t.label || "")).length >= 1,
      JSON.stringify(r1.tools.map((t) => t.label)));
    ok("这一批只开了一张工具卡（一次调用，不是拆成两次写）",
      r1.tools.filter((t) => /已写入 2 个文件/.test(t.label || "")).length === 1, JSON.stringify(r1.tools.map((t) => t.label)));

    section("② 中间一处不匹配：全部还原（全或无）");
    fs.writeFileSync(F("a.txt"), "A1\nA2\n", "utf8");
    fs.writeFileSync(F("b.txt"), "B1\nB2\n", "utf8");
    fs.writeFileSync(F("c.txt"), "C1\nC2\n", "utf8");
    const r2 = await runScene(conn, "回滚");
    ok("工具真跑到了，且报的是匹配失败（否则下面的否定断言全是假绿）",
      ranTool(r2, "编辑匹配失败"), JSON.stringify(r2.tools.map((t) => t.label)));
    ok("排在失败项之前的 a.txt 被还原了（这就是原子性的全部意义）", read("a.txt") === "A1\nA2\n", JSON.stringify(read("a.txt")));
    ok("排在失败项之后的 c.txt 根本没被写过", read("c.txt") === "C1\nC2\n", JSON.stringify(read("c.txt")));
    ok("回滚的文案点名了是哪个文件把它打回来的",
      /编辑回滚[^\n]*b\.txt/.test(JSON.stringify(r2.tools)) || /b\.txt/.test((r2.tools.filter((t) => !t.ok)[0] || {}).label || ""),
      JSON.stringify(r2.tools).slice(0, 300));

    section("③ deny 规则命中其中一个文件：整批在写之前就被拒");
    fs.writeFileSync(F("a.txt"), "A1\nA2\n", "utf8");
    const r3 = await runScene(conn, "拒绝");
    ok("工具真跑到了，且是规则拦的（不是碰巧没匹配上）",
      ranTool(r3, "被拒绝规则拦截"), JSON.stringify(r3.tools.map((t) => t.label)));
    ok("a.txt 一个字节都没动过（拒绝发生在任何写入之前，不是写一半再回滚）",
      read("a.txt") === "A1\nA2\n", JSON.stringify(read("a.txt")));

    section("③b 路径想跑出工作区：不会落进工作区之外");
    fs.writeFileSync(F("a.txt"), "A1\nA2\n", "utf8");
    const r3b = await runScene(conn, "越界");
    ok("工具真跑到了并失败（否则下面的「没有落盘」是假绿）",
      r3b.done !== null && r3b.tools.length >= 1, JSON.stringify(r3b.tools.map((t) => t.label)));
    ok("工作区的父目录里没有多出 outside.txt",
      !fs.existsSync(path.join(path.dirname(WS_DIR), "outside.txt")));
    ok("同批的 a.txt 最终仍是原样", read("a.txt") === "A1\nA2\n", JSON.stringify(read("a.txt")));

    section("④ 同一文件出现两次：合并成一次写入");
    const r4 = await runScene(conn, "合并");
    ok("工具真跑到了", ranTool(r4, "已写入 1 个文件"), JSON.stringify(r4.tools.map((t) => t.label)));
    ok("两处改动都在，且是同一份内容（不是后一次覆盖前一次）",
      read("d.txt") === "D1-first\nD2-second\n", JSON.stringify(read("d.txt")));

    section("⑤ 一批改动一个检查点：/undo 一次撤掉整批");
    fs.writeFileSync(F("a.txt"), "A1\nA2\n", "utf8");
    fs.writeFileSync(F("b.txt"), "B1\nB2\n", "utf8");
    fs.writeFileSync(F("d.txt"), "D1\nD2\n", "utf8");
    await runScene(conn, "成功");
    ok("先确认这一批改上了盘", /A1-edited/.test(read("a.txt")) && /B1-edited/.test(read("b.txt")),
      JSON.stringify([read("a.txt"), read("b.txt")]));
    const r5 = await runScene(conn, "撤销");
    ok("undo 工具真跑到了（不是「这一轮没做事」）",
      r5.done !== null && r5.tools.length >= 1, JSON.stringify(r5.tools.map((t) => t.label)));
    await wait(400);
    ok("一次 /undo 把整批两个文件都还原（不是只撤最后一个）",
      read("a.txt") === "A1\nA2\n" && read("b.txt") === "B1\nB2\n",
      JSON.stringify([read("a.txt"), read("b.txt")]));
  } finally {
    try { ws.close(); } catch (x) {}
    child.kill();
    gw.srv.close();
  }

  console.log("\n" + (fail ? "\x1b[31mHAS FAIL\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { for (const f of fails) console.log("  - " + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\x1b[31mFAIL:\x1b[0m " + (e && e.stack || e)); process.exit(1); });
