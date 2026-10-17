/* ============================================================
   断流不该当成跑完 —— 长任务"无故中断"这一类的验收探针
   ------------------------------------------------------------
   量的是三件真实故障（都来自用户截图与他的任务表）：
     ① 上游半截流（掐断 / 空闲不吐字）时，旧代码把"已经收到一点内容"当正常完成返回，
        于是没有 tool_calls → ReAct 循环直接收尾 → 任务停在计划 3/9 却记成"完成"。
     ② 出错收口时 finally 仍会发一条 agent.done，把刚标的 failed 盖回 done，
        托盘与系统通知一起跟着说谎 —— 用户事后看什么都是"完成"。
     ③ 普通模式跑到一半自己停下、计划还有步骤没勾掉时，以前是静默的。
   做法：起一个会说坏话的假上游（真 SSE），跑真服务端 + 真引擎 + 真任务表，
        不打桩 llm.js —— 打桩它就测不到自己。
   ============================================================ */
"use strict";
const LLM_PORT = 8899;
const PORT = 8898;

const SANDBOX = require("./_sandbox").create({
  tag: "streambreak",
  wsFiles: { "src/app.js": "export const a = 1;\n", "README.md": "# demo\n" },
  config: {
    agentMode: "auto",
    permissions: { mode: "auto", allow: [], deny: [] },
    llm: {
      baseURL: "http://127.0.0.1:" + LLM_PORT + "/v1",
      apiKey: "fake-key", model: "fake-model", contextWindow: 32000,
      idleTimeout: 5000, connectTimeout: 15000,   // 探针把空闲窗口调小，否则一支要等 90 秒
    },
  },
});

const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + " — " + (detail || "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 300); } catch (e) { return String(v).slice(0, 300); } };

/* ---------- 假上游：按脚本一口一口吐 SSE，坏的那几口真的把流弄断 ---------- */
const script = [];              // 每个请求按序取一条；取完就报"脚本不够用"
const hits = [];                // 每次出网的 { body }
function sse(res, obj) { res.write("data: " + JSON.stringify(obj) + "\n\n"); }
function chunk(res, delta, finish) { sse(res, { choices: [{ delta: delta || {}, finish_reason: finish || null }] }); }
function endOk(res) { sse(res, "[DONE]"); try { res.end(); } catch (e) {} }

const behaviors = {
  /* 说了半句就被掐：res.destroy() 让客户端 read() 抛"terminated"，且没有 finish_reason */
  trunc(res) { chunk(res, { content: "计划已刷新，方向明确为一步到位：以 server.js 内联为正" }); setTimeout(() => { try { res.destroy(); } catch (e) {} }, 30); },
  /* 吐一个字就再也不动：撞空闲超时 */
  idle(res) { chunk(res, { content: "我重写 lib/pptx.js，" }); },
  /* 正常说完一句 */
  ok(res, arg) { chunk(res, { content: arg || "这一步我做完了。" }, "stop"); endOk(res); },
  /* 正常发起一次工具调用 */
  tool(res, arg) {
    chunk(res, { tool_calls: [{ index: 0, id: arg.id, type: "function", function: { name: arg.name, arguments: JSON.stringify(arg.args) } }] }, "tool");
    endOk(res);
  },
};
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const step = script.shift();
    hits.push({ at: Date.now(), body: body ? JSON.parse(body) : null });
    if (!step) { res.writeHead(500, { "Content-Type": "application/json" }); res.end('{"error":"探针脚本不够用"}'); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    try { behaviors[step.kind](res, step.arg); }
    catch (e) { try { res.end(); } catch (x) {} }
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

/* 跑一轮并收全部事件：返回 { evs, done, err }。
   收口以 agent.done 为准 —— 出错时引擎是"先发 agent.error 再在 finally 发 agent.done"，
   一见 error 就返回会抢在盖状态之前读任务表，那条断言就成了测不到东西的假绿。 */
function runRound(ws, text, convId, ms) {
  return new Promise((resolve) => {
    const evs = [];
    let errSeen = null, grace = null, settled = false;
    const finish = (done) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); if (grace) clearTimeout(grace);
      ws.off("message", onMsg);
      resolve({ evs, done: done || null, err: errSeen });
    };
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
      if (m.convId && m.convId !== convId) return;
      evs.push(m);
      if (m.type === "agent.error") {
        errSeen = m;
        grace = setTimeout(() => finish(null), 4000);   // 万一某条路径只报错不发 done
      } else if (m.type === "agent.done") finish(m);
    };
    const timer = setTimeout(() => { settled = true; clearTimeout(grace); ws.off("message", onMsg); resolve({ evs, timeout: true, err: errSeen }); }, ms || 90000);
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ type: "chat", text: text, convId: convId }));
  });
}
const typesOf = (evs) => evs.map((e) => e.type);
const textsOf = (evs, type) => evs.filter((e) => e.type === type).map((e) => String(e.text || ""));

(async () => {
  upstream.listen(LLM_PORT, "127.0.0.1");
  const { child, out } = boot();
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) { if (out().includes("已启动")) break; await wait(150); }
  if (!out().includes("已启动")) throw new Error("服务端没起来：" + out().slice(-400));

  const reg = await req("POST", "/api/auth/register", { username: "_sb_" + Date.now(), password: "test1234" });
  const token = reg.json && reg.json.token;
  if (!token) throw new Error("注册失败：" + J(reg.json));
  const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); setTimeout(() => rej(new Error("ws 超时")), 8000); });

  const rowOf = async (convId) => {
    const r = await req("GET", "/api/tasks", null, token);
    const list = (r.json && r.json.tasks) || [];
    return list.find((x) => x.convId === convId) || null;
  };

  try {
    section("① 半截流被掐断：重试梯子要接住，接住了才算这一轮说完");
    script.length = 0; hits.length = 0;
    script.push({ kind: "trunc" }, { kind: "trunc" }, { kind: "ok", arg: "这次说完了。" });
    const c1 = "sb-recover";
    const r1 = await runRound(ws, "随便说一句", c1, 90000);
    ok("上游两次掐断 + 一次正常，共出网 3 次（阳性对照：假上游真被打了）", hits.length === 3, "出网 " + hits.length + " 次");
    ok("第三次成功 → 这一轮按完成收口，没有报错卡", !!r1.done && !r1.err, J({ done: !!r1.done, err: r1.err && r1.err.message }));
    const cards = typesOf(r1.evs).filter((t) => t === "msg.start" || t === "msg.end");
    let open = 0, overlap = 0;
    cards.forEach((t) => { if (t === "msg.start") { open++; if (open > 1) overlap++; } else open--; });
    ok("重试没有把半截文字和重试正文挤在同一张卡里（卡不叠卡）", overlap === 0 && cards.length >= 4, "卡序列=" + cards.join(",") + " 叠了 " + overlap);
    const row1 = await rowOf(c1);
    ok("恢复成功的行是 done 且不带残留 error", !!row1 && row1.status === "done" && !row1.error, J(row1));

    section("② 五次全被掐断：必须报错，并且任务表不许写『完成』");
    script.length = 0; hits.length = 0;
    /* 梯子深度是这一节的副产物，也是它的判据之一：流被掐 = 瞬时故障，重试上限从 3 提到 5
       （七八小时里上游抖一下不该把整条任务判死）。少写一条脚本，第四、五次就打到空脚本上
       返回 500，任务表里的原因就变成探针自己的"脚本不够用" —— 上一轮红在这里，红得对。 */
    for (let i = 0; i < 5; i++) script.push({ kind: "trunc" });
    const c2 = "sb-fail";
    const r2 = await runRound(ws, "再说一句", c2, 90000);
    ok("五次都断 → 报 agent.error（不再把半截内容当答案交付）", !!r2.err, J({ types: typesOf(r2.evs).slice(-4), err: r2.err && r2.err.message }));
    ok("瞬时故障确实重试满 5 次才认输（梯级分档，不是写死三次）", hits.length === 5, "出网 " + hits.length + " 次");
    const row2 = await rowOf(c2);
    ok("任务表停在 failed，agent.done 没把它盖回 done", !!row2 && row2.status === "failed", J(row2));
    ok("失败原因留在行里（托盘与通知都读得到）", !!row2 && /SSE|中断|超时/.test(String(row2.error || "")), "error=" + (row2 && row2.error));

    section("③ 空闲超时走同一条梯子：吐一个字后不再动");
    script.length = 0; hits.length = 0;
    script.push({ kind: "idle" }, { kind: "ok", arg: "接着说完了。" });
    const c3 = "sb-idle";
    const t1 = Date.now();
    const r3 = await runRound(ws, "慢慢说", c3, 90000);
    const spent = Date.now() - t1;
    ok("确实等满过一段空闲窗口才重试（说明测的是空闲分支不是别的）", spent >= 5000, "耗时 " + spent + "ms");
    ok("空闲之后重试成功 → 正常收口", !!r3.done && !r3.err, J({ done: !!r3.done, err: r3.err && r3.err.message }));

    section("④ 计划没走完就停：要吭一声（普通模式，没开 Goal）");
    script.length = 0; hits.length = 0;
    script.push(
      { kind: "tool", arg: { id: "p1", name: "create_plan", args: { title: "重写 lib", tasks: ["读 server.js", "重写 lib/share.js", "重写 lib/pptx.js"] } } },
      { kind: "tool", arg: { id: "p2", name: "update_plan", args: { taskIndex: 0, status: "done" } } },
      { kind: "ok", arg: "任务 1 已完成。接下来继续任务 2。" }
    );
    const c4 = "sb-plan";
    const r4 = await runRound(ws, "把 lib 重写一遍", c4, 90000);
    const tl = textsOf(r4.evs, "term.line").join("\n");
    const said = textsOf(r4.evs, "msg.delta").join("");
    ok("计划 1/3 就停 → 终端留一行『停在计划』", /停在计划 1\/3/.test(tl), "term.line=" + tl.slice(-200));
    ok("并且对着用户说清还剩哪几步", /计划还有 2 步/.test(said) && /重写 lib/.test(said), "说=" + said.slice(0, 160));
    ok("提示不改变收口性质：这一轮仍是正常 done（不是报错）", !!r4.done && !r4.err, J({ done: !!r4.done }));

    section("⑤ 阳性对照：计划真跑完了就不该啰嗦");
    script.length = 0; hits.length = 0;
    script.push(
      { kind: "tool", arg: { id: "q1", name: "create_plan", args: { title: "两步就完", tasks: ["第一步", "第二步"] } } },
      { kind: "tool", arg: { id: "q2", name: "update_plan", args: { taskIndex: 0, status: "done" } } },
      { kind: "tool", arg: { id: "q3", name: "update_plan", args: { taskIndex: 1, status: "done" } } },
      { kind: "ok", arg: "两步都做完了。" }
    );
    const c5 = "sb-plan-done";
    const r5 = await runRound(ws, "做完这两步", c5, 90000);
    const tl5 = textsOf(r5.evs, "term.line").join("\n");
    const said5 = textsOf(r5.evs, "msg.delta").join("");
    ok("计划全勾完 → 不再出现『停在计划』", !/停在计划/.test(tl5) && !/计划还有/.test(said5), "term=" + tl5.slice(-160) + " 说=" + said5.slice(0, 120));
    ok("阳性对照：这一轮真的建了计划并逐步勾完（四次出网一次不少）", hits.length === 4, "出网 " + hits.length + " 次");
    const planEvs = r5.evs.filter((e) => e.type === "plan.created" || e.type === "plan.updated");
    ok("计划事件真的推到了前端（否则上面那条『全勾完』是假的）", planEvs.length >= 2, "计划事件 " + planEvs.length + " 条");
    const row5 = await rowOf(c5);
    ok("跑完的行是 done 且没有残留 error", !!row5 && row5.status === "done" && !row5.error, J(row5));

    section("⑥ 任务表在重启后仍然诚实");
    const row2b = await rowOf(c2);
    ok("failed 的行带着原因，不会因为又收到别的事件而改口", !!row2b && row2b.status === "failed", J(row2b));
  } catch (e) {
    ok("探针自身跑通（未中途抛错）", false, String((e && e.stack) || e).slice(0, 400));
  } finally {
    try { ws.close(); } catch (e) {}
    child.kill();
    upstream.close();
  }
  console.log("\n[streambreak] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { console.log("  失败项：\n   - " + fails.join("\n   - ")); process.exit(1); }
  process.exit(0);
})();
