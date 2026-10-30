/* ============================================================
   服务端 SSE 终态实测（审查项 F07）
   钉的是这条实测过的链：上游发完一条**参数完整**的 tool_call 就 res.end()，
   既不发 finish_reason 也不发 [DONE] —— 旧 chatStream 照样 resolve，
   返回 finish:null、toolCalls:1，agent 层于是真的去执行这个工具。
   "传输结束"和"模型说完了"是两件事，这里判的是后者。
   用本地假上游，不连任何真实模型、不需要 API Key。
   ============================================================ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
/* 探针第一行先要沙箱：server/llm.js 会连带 require 到配置层，
   不设 PANCODE_DATA_DIR 就等于让被测代码往真实数据根里写。 */
const sb = require("./_sandbox").create({ tag: "sse-terminal" });

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

const { chatStream } = require(path.join(ROOT, "server", "llm.js"));

function startUpstream(handler) {
  const srv = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => handler(res));
  });
  srv.listen(0, "127.0.0.1");
  return new Promise((resolve) => srv.once("listening", () => resolve({ srv, port: srv.address().port })));
}
const cfgFor = (port) => ({ baseURL: "http://127.0.0.1:" + port + "/v1", apiKey: "probe-key", model: "probe" });
const toolFrame = (name, args) => "data: " + JSON.stringify({
  choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: args } }] }, finish_reason: null }] },
) + "\n";
const finishFrame = (r) => "data: " + JSON.stringify({ choices: [{ delta: {}, finish_reason: r }] }) + "\n";

(async () => {
  const cases = [];
  section("1) 半截流：干净 EOF、无结束标记 —— 必须抛，不能交付可执行工具调用");
  {
    const { srv, port } = await startUpstream((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(toolFrame("read_file", JSON.stringify({ path: "README.md" })));
      res.end();
    });
    let r = null, err = null;
    try { r = await chatStream(cfgFor(port), [{ role: "user", content: "go" }], null, null); } catch (e) { err = e; }
    ok("无结束标记的 EOF 被拒", !r && !!err, r ? "竟然 resolve：finish=" + r.finish + " toolCalls=" + r.toolCalls.length : String(err && err.message).slice(0, 90));
    ok("抛出的不是「成功」语义（错误信息说清是没收到结束标记）",
      !!err && /结束标记|提前结束/.test(String(err.message)), String(err && err.message).slice(0, 90));
    cases.push(srv);
  }
  section("2) 阳性对照：正常协议必须照常通过（收紧不能把所有响应一起拒掉）");
  {
    const { srv, port } = await startUpstream((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(toolFrame("read_file", JSON.stringify({ path: "README.md" })));
      res.write(finishFrame("tool_calls"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
    let r = null, err = null;
    try { r = await chatStream(cfgFor(port), [{ role: "user", content: "go" }], null, null); } catch (e) { err = e; }
    ok("finish_reason + [DONE] → 正常交付 1 个工具调用", !!r && r.finish === "tool_calls" && r.toolCalls.length === 1, String(err && err.message));
    cases.push(srv);
  }
  {
    const { srv, port } = await startUpstream((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "你好" }, finish_reason: "stop" }] }) + "\n");
      res.end();     // 有 finish_reason、没有 [DONE]：也应当算说完
    });
    let r = null, err = null;
    try { r = await chatStream(cfgFor(port), [{ role: "user", content: "go" }], null, null); } catch (e) { err = e; }
    ok("只发 finish_reason 不发 [DONE] 的网关不被误杀", !!r && r.content === "你好", String(err && err.message));
    cases.push(srv);
  }
  {
    const { srv, port } = await startUpstream((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "只有正文" }, finish_reason: null }] }) + "\n");
      res.write("data: [DONE]\n\n");
      res.end();     // 只发 [DONE]：传输终态成立，正文按完成处理
    });
    let r = null, err = null;
    try { r = await chatStream(cfgFor(port), [{ role: "user", content: "go" }], null, null); } catch (e) { err = e; }
    ok("只发 [DONE] 不发 finish_reason 的网关不被误杀", !!r && r.content === "只有正文", String(err && err.message));
    cases.push(srv);
  }
  section("3) 收到 [DONE] 之后才断线：算完成（不能把正常收尾误判成半截）");
  {
    const { srv, port } = await startUpstream((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "收尾前的最后一句" }, finish_reason: null }] }) + "\n");
      res.write("data: [DONE]\n\n");
      setTimeout(() => { try { res.destroy(); } catch (e) {} }, 120);   // [DONE] 之后才把连接掐了
    });
    let r = null, err = null;
    try { r = await chatStream(cfgFor(port), [{ role: "user", content: "go" }], null, null); } catch (e) { err = e; }
    ok("[DONE] 后断线不推翻已完成的结果", !!r && r.content === "收尾前的最后一句", String(err && err.message).slice(0, 90));
    cases.push(srv);
  }

  for (const s of cases) { try { s.close(); } catch (e) {} }
  try { sb.cleanup(); } catch (e) {}
  console.log("\n\x1b[1mSSE 终态：通过 " + pass + " / 失败 " + fail + "\x1b[0m");
  if (fail) { console.log("失败项：\n  - " + fails.join("\n  - ")); process.exit(1); }
})().catch((e) => {
  console.log("\x1b[31m探针异常：" + (e && e.stack || e) + "\x1b[0m");
  try { sb.cleanup(); } catch (x) {}
  process.exit(1);
});
