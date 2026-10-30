/* ============================================================
   独立 CLI 引擎契约实测（审查项 F05 / F07 / F11）
   钉四件以前没有判据、实测确实错了的事：
     1) 路径边界：绝对路径带 .. 能绕过工作区（实测读到过界文件）
     2) 搜索：子目录命中全丢（递归丢了 this，异常又被空 catch 吞掉）
     3) 权限：配置默认 mode="ask"，实际写文件/跑命令一律直通执行
     4) 流协议：正常 EOF 但没结束标记，半截工具调用照样当完成交付
   第 3 项走的是**真实调用链**（handleChat → 工具循环 → 闸门 → execTool），
   不是直接调决策函数 —— 决策函数一直是对的，错的是没人调它。
   全程一次性临时目录，不碰用户 HOME 与仓库 .pancode/。
   ============================================================ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-cli-contract-"));

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

const { FileStore } = require("../cli/lib/files");
const wsDir = path.join(SB, "ws");
fs.mkdirSync(path.join(wsDir, "nested"), { recursive: true });
fs.writeFileSync(path.join(wsDir, "root.txt"), "NEEDLE 在根");
fs.writeFileSync(path.join(wsDir, "nested", "deep.txt"), "NEEDLE 在子目录");
const outside = path.join(SB, "outside.txt");
fs.writeFileSync(outside, "AUDIT_OUTSIDE_MARKER");

function startUpstream(handler) {
  const srv = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => handler(res));
  });
  srv.listen(0, "127.0.0.1");
  return new Promise((resolve) => srv.once("listening", () => resolve({ srv, port: srv.address().port })));
}
const toolChunk = (name, args) => "data: " + JSON.stringify({
  choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: args } }] }, finish_reason: null }] },
) + "\n";
const cfgFor = (port) => ({ baseURL: "http://127.0.0.1:" + port + "/v1", apiKey: "fake", model: "probe" });

/* ---------- 1) 工作区边界 ---------- */
section("1) 工作区边界（绝对路径带 .. 的旁路）");
{
  const store = new FileStore(wsDir);
  const escapeAbs = path.join(wsDir, "..", "outside.txt");
  let threw = false;
  try { store.read(escapeAbs); } catch (e) { threw = true; }
  ok("绝对路径含 .. 被拒", threw, "没抛错：判据放过了 " + escapeAbs);
  let readOutside = false;
  try { readOutside = String(store.read("../outside.txt").content).indexOf("AUDIT_OUTSIDE_MARKER") > -1; } catch (e) {}
  ok("相对 .. 读不到界外文件", !readOutside);
  let wrote = false;
  try { store.write(path.join(wsDir, "..", "written-by-escape.txt"), "x"); wrote = fs.existsSync(path.join(SB, "written-by-escape.txt")); } catch (e) {}
  ok("写路径同样不能借 .. 出界", !wrote);
  ok("界内正常路径仍可用", String(store.read("nested/deep.txt").content).indexOf("NEEDLE") > -1);
  /* 符号链接：Windows 非开发者模式可能没权限建。建不出来就如实报 SKIP ——
     不能拿"没测到"当"测过了"。 */
  const link = path.join(wsDir, "link.txt");
  let linkMade = false;
  try { fs.symlinkSync(outside, link, "file"); linkMade = true; } catch (e) {}
  if (linkMade) {
    let via = false;
    try { via = String(store.read("link.txt").content).indexOf("AUDIT_OUTSIDE_MARKER") > -1; } catch (e) {}
    ok("工作区内的符号链接不跟到界外（实测）", !via);
    try { fs.unlinkSync(link); } catch (e) {}
  } else {
    console.log("  \x1b[33m–\x1b[0m 符号链接用例 SKIP（本机无权创建 file symlink，未覆盖）");
  }
}

/* ---------- 2) 搜索覆盖整个工作区 ---------- */
section("2) 搜索覆盖整个工作区（子目录命中不许丢）");
{
  const store = new FileStore(wsDir);
  const files = store.search("NEEDLE").map((h) => h.file).sort();
  ok("根目录与子目录各一处命中都报出来", files.length === 2 && files[0] === "nested/deep.txt" && files[1] === "root.txt",
    "实得 " + JSON.stringify(files));
  /* 正则形态：/NEE.LE/ 才对 NEEDLE 成立（NEEDLE 是 6 个字母，写成 /NEE.DLE/ 是
     探针自己把样例编错了 —— 那是 7 格的模式。判据不中不等于产品坏）。 */
  ok("正则形式同样穿透子目录", store.search("/NEE.LE/").length === 2, "实得 " + store.search("/NEE.LE/").length);
  ok("maxResults 是硬上限而不是大概这么多", store.search("NEEDLE", { maxResults: 1 }).length === 1,
    "实得 " + store.search("NEEDLE", { maxResults: 1 }).length);
  ok("list 仍列得到子目录", store.list(".").some((e) => e.name === "nested"));
}

/* ---------- 3)~7) 需要 await，统一收在一个 async 主体里 ---------- */
(async () => {
  const llmMod = require("../cli/lib/llm");

  section("3) SSE 终态：没有结束标记的干净 EOF 不能当完成交付");
  {
    const { srv, port } = await startUpstream((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(toolChunk("write_file", JSON.stringify({ path: "pwn.txt", content: "x" })));
      res.end();                       // 正常结束，但既无 finish_reason 也无 [DONE]
    });
    let r = null, err = null;
    try { r = await llmMod.chatStream(cfgFor(port), [{ role: "user", content: "go" }], null, null); } catch (e) { err = e; }
    ok("半截工具调用被拒（抛错而非返回可执行结果）", !r && !!err,
      r ? "竟然 resolve 了：finish=" + r.finish + " toolCalls=" + r.toolCalls.length : String(err && err.message));
    srv.close();
  }
  {
    const { srv, port } = await startUpstream((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(toolChunk("write_file", JSON.stringify({ path: "pwn.txt", content: "x" })));
      res.write("data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });
    let r = null, err = null;
    try { r = await llmMod.chatStream(cfgFor(port), [{ role: "user", content: "go" }], null, null); } catch (e) { err = e; }
    ok("阳性对照：带结束标记的完整工具调用照常交付", !!r && r.toolCalls.length === 1 && r.finish === "tool_calls", String(err && err.message));
    srv.close();
  }
  {
    const { srv, port } = await startUpstream((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "你好" }, finish_reason: null }] }) + "\n");
      res.write("data: [DONE]\n\n");
      res.end();
    });
    let r = null, err = null;
    try { r = await llmMod.chatStream(cfgFor(port), [{ role: "user", content: "go" }], null, null); } catch (e) { err = e; }
    ok("只发 [DONE] 不发 finish_reason 的网关不被误杀（兼容性对照）", !!r && r.content === "你好", String(err && err.message));
    srv.close();
  }

  section("4) 429 重试有界");
  {
    let hits = 0;
    const { srv, port } = await startUpstream((res) => {
      hits++;
      res.writeHead(429, { "retry-after": "1" });
      res.end("{}");
    });
    let err = null;
    try { await llmMod.chatStream(cfgFor(port), [{ role: "user", content: "go" }], null, null); } catch (e) { err = e; }
    ok("限流最终报错而不是无限重投", !!err && /429/.test(String(err.message)), String(err && err.message));
    ok("请求次数被上限钉住（<= MAX_RETRIES+1）", hits > 1 && hits <= llmMod.MAX_RETRIES + 1, "实得 " + hits + " 次");
    srv.close();
  }

  section("5) 取消信号真的接到流上");
  {
    const { srv, port } = await startUpstream((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "a" }, finish_reason: null }] }) + "\n");
      // 之后不再吐字：只有 signal 生效才能收场
    });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    let err = null, r = null;
    try { r = await llmMod.chatStream(cfgFor(port), [{ role: "user", content: "go" }], null, null, { signal: ctl.signal }); } catch (e) { err = e; }
    ok("流中途 abort → LlmAbortedError（不是半截内容当完成）", !r && !!err && err.name === "LlmAbortedError",
      err ? err.name + ": " + err.message : "没抛错");
    srv.close();
  }

  /* ---------- 6) 权限闸门：走真实 handleChat 调用链 ---------- */
  /* 必须在 require engine 之前替换：engine.js 在模块顶层就解构了 chatStream。 */
  let scripted = [];
  llmMod.chatStream = async () => {
    const next = scripted.shift();
    if (!next) return { content: "结束", reasoning: "", toolCalls: [], finish: "stop", usage: null };
    return next;
  };
  const call = (name, argsObj) => ({
    content: "", reasoning: "", finish: "tool_calls", usage: null,
    toolCalls: [{ id: "call_" + name + "_" + ((Math.random() * 1e6) | 0), name, arguments: JSON.stringify(argsObj) }],
  });

  const { Engine } = require("../cli/lib/engine");
  function mkEngine(permissions) {
    const dir = fs.mkdtempSync(path.join(SB, "eng-"));
    fs.mkdirSync(path.join(dir, "ws"), { recursive: true });
    const eng = new Engine({
      workspace: path.join(dir, "ws"),
      llm: { baseURL: "http://127.0.0.1:1/v1", apiKey: "fake", model: "probe", temperature: 0, maxToolRounds: 4 },
      permissions,
    });
    eng.emit = () => {};
    return eng;
  }
  const withTTY = async (v, fn) => { const real = process.stdin.isTTY; process.stdin.isTTY = v; try { return await fn(); } finally { process.stdin.isTTY = real; } };

  section("6) 权限闸门：mode=ask 必须真的问人，无人可问就拒绝（不是直通）");
  await withTTY(false, async () => {
    scripted = [call("write_file", { path: "should-not-exist.txt", content: "x" })];
    const eng = mkEngine({ mode: "ask", allow: [], deny: [] });
    await eng.handleChat("写个文件");
    ok("ask 档 + 无人可问 → 文件没被写出来", !fs.existsSync(path.join(eng.workspace, "should-not-exist.txt")), "文件竟然存在");
    const asst = eng.history.filter((m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length);
    const toolMsgs = eng.history.filter((m) => m.role === "tool");
    const paired = asst.length > 0 && asst.every((a) => a.tool_calls.every((tc) => toolMsgs.some((t) => t.tool_call_id === tc.id)));
    ok("拒绝也要回填 tool 结果（否则下一轮请求协议非法）", paired, "配对断了");
    ok("拒绝的理由回到模型眼前", toolMsgs.some((t) => /拒绝|无人可问/.test(String(t.content))),
      JSON.stringify(toolMsgs.map((t) => String(t.content).slice(0, 40))));
  });
  await withTTY(true, async () => {
    scripted = [call("write_file", { path: "approved.txt", content: "ok" })];
    const eng = mkEngine({ mode: "ask", allow: [], deny: [] });
    let asked = null;
    eng.emit = (ev) => {
      if (ev.type === "tool.pending" && !asked) { asked = ev; setTimeout(() => eng.resolveApproval(ev.id, true), 0); }
    };
    await eng.handleChat("写个文件");
    ok("ask 档确实弹出了确认卡（带 id 与主体）", !!asked && !!asked.id && !!asked.target, JSON.stringify(asked && asked.target));
    ok("批准后文件被写出来", fs.existsSync(path.join(eng.workspace, "approved.txt")));
  });
  await withTTY(true, async () => {
    scripted = [call("write_file", { path: "rejected.txt", content: "x" })];
    const eng = mkEngine({ mode: "ask", allow: [], deny: [] });
    eng.emit = (ev) => { if (ev.type === "tool.pending") setTimeout(() => eng.resolveApproval(ev.id, false), 0); };
    await eng.handleChat("写个文件");
    ok("用户点拒绝 → 不执行", !fs.existsSync(path.join(eng.workspace, "rejected.txt")));
  });
  {
    scripted = [call("write_file", { path: "auto.txt", content: "x" })];
    const eng = mkEngine({ mode: "auto", allow: [], deny: [] });
    let asked = false;
    eng.emit = (ev) => { if (ev.type === "tool.pending") asked = true; };
    await eng.handleChat("写个文件");
    ok("auto 档免确认并执行", !asked && fs.existsSync(path.join(eng.workspace, "auto.txt")));
  }
  {
    /* 规则形态要说清：字符串规则走的是"子串/正则"语义（"secret*" 里的 * 不是通配），
       glob 只在结构化规则 {tool, pattern} 里生效。两种形态各钉一条，
       免得失配时说不清是梯子错了还是形态用错了。 */
    scripted = [call("write_file", { path: "secret-a.txt", content: "x" })];
    const eng = mkEngine({ mode: "auto", allow: [], deny: [{ tool: "write_file", pattern: "secret*" }] });
    await eng.handleChat("写个文件");
    ok("deny（结构化 glob）压过 auto 档", !fs.existsSync(path.join(eng.workspace, "secret-a.txt")));
  }
  {
    scripted = [call("write_file", { path: "topsecret.txt", content: "x" })];
    const eng = mkEngine({ mode: "auto", allow: [], deny: ["topsecret"] });
    await eng.handleChat("写个文件");
    ok("deny（字符串子串）同样压过 auto 档", !fs.existsSync(path.join(eng.workspace, "topsecret.txt")));
  }
  {
    scripted = [call("write_file", { path: "yes.txt", content: "x" })];
    const eng = mkEngine({ mode: "auto", allow: [{ tool: "write_file", pattern: "yes*" }], deny: [] });
    let asked = false;
    eng.emit = (ev) => { if (ev.type === "tool.pending") asked = true; };
    await eng.handleChat("写个文件");
    ok("allow 规则命中即免确认（阳性对照：规则表不只有 deny 一侧生效）", !asked && fs.existsSync(path.join(eng.workspace, "yes.txt")));
  }
  {
    scripted = [call("read_file", { path: "missing.txt" })];
    const eng = mkEngine({ mode: "ask", allow: [], deny: [] });
    let asked = false;
    eng.emit = (ev) => { if (ev.type === "tool.pending") asked = true; };
    await eng.handleChat("读个文件");
    ok("只读工具不弹确认（收紧不许把日常读文件也变成每步一问）", !asked);
  }
  await withTTY(true, async () => {
    scripted = [call("write_file", { path: "s1.txt", content: "a" }), call("write_file", { path: "s2.txt", content: "b" })];
    const eng = mkEngine({ mode: "ask", allow: [], deny: [] });
    let cards = 0;
    eng.emit = (ev) => {
      if (ev.type === "tool.pending") {
        cards++;
        setTimeout(() => { eng.resolveApproval(ev.id, true); eng.grantSession(ev.name || ev.tool); }, 0);
      }
    };
    await eng.handleChat("连写两个文件");
    ok("「本会话同类」授权后第二发不再问", cards === 1 && fs.existsSync(path.join(eng.workspace, "s2.txt")), "弹卡 " + cards + " 次");
  });
  await withTTY(false, async () => {
    scripted = [call("run_command", { command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'x\')"' })];
    const eng = mkEngine({ mode: "ask", allow: [], deny: [] });
    await eng.handleChat("跑条命令");
    ok("run_command 也在闸门后面（无人可问 → 不执行）", !fs.existsSync(path.join(eng.workspace, "ran.txt")));
  });

  section("7) 阳性对照：闸门没有把引擎本身改坏");
  await withTTY(false, async () => {
    scripted = [call("write_file", { path: "pairing.txt", content: "x" })];
    const eng = mkEngine({ mode: "auto", allow: [], deny: [] });
    await eng.handleChat("写个文件");
    const kinds = eng.history.map((m) => m.role);
    ok("assistant → tool 的顺序完整，收尾有最终回复",
      kinds.indexOf("tool") > kinds.indexOf("assistant") && kinds[kinds.length - 1] === "assistant",
      JSON.stringify(kinds));
  });

  try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {}
  console.log("\n\x1b[1mCLI 契约：通过 " + pass + " / 失败 " + fail + "\x1b[0m");
  if (fail) { console.log("失败项：\n  - " + fails.join("\n  - ")); process.exit(1); }
})().catch((e) => {
  console.log("\x1b[31m探针异常：" + (e && e.stack || e) + "\x1b[0m");
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});
