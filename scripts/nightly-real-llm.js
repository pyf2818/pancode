/* ============================================================
   真实模型夜间回归集（W19）
   ------------------------------------------------------------
   为什么存在：单测/探针全部打桩在传输层，mock 形状漂移能遮住真 bug
   （2026-10 的 P0 就是这么活的：子智能体读 tc.args，mock 也返回 args，
   985 个单测全绿而真实模型下编排完全不可用）。这套回归只做一件事：
   用真实 LLM 把关键路径每晚真跑一遍。

   场景（每个都是真实模型驱动，断言可观察结果）：
     ① read-echo   —— 单工具调用回路（read_file + 回答内容核对）
     ② subagent    —— 子智能体派发真实落盘（P0 回归钉：修复前恒空参失败）
     ③ apply-edit  —— 补丁编辑链路（apply_edit + 盘上内容核对）
     ④ compaction  —— 压缩链路（小 contextWindow 强制触发，断言不因 400/超限中断）

   用法：
     npm run test:nightly                      # 无 Key → 打印跳过原因并 exit 0（CI 安全）
     PANCODE_NIGHTLY_KEY=sk-.. npm run test:nightly
   环境变量：
     PANCODE_NIGHTLY_BASE_URL / PANCODE_NIGHTLY_KEY / PANCODE_NIGHTLY_MODEL
     （缺省回落 OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL）
     PANCODE_NIGHTLY_DEMO=1 —— 不接真实模型，用演示引擎只验"管线通"（场景断言降级为 done）
   ============================================================ */
"use strict";

const NIGHTLY = {
  baseURL: process.env.PANCODE_NIGHTLY_BASE_URL || process.env.OPENAI_BASE_URL || "",
  apiKey: process.env.PANCODE_NIGHTLY_KEY || process.env.OPENAI_API_KEY || "",
  model: process.env.PANCODE_NIGHTLY_MODEL || process.env.OPENAI_MODEL || "",
};
const DEMO = process.env.PANCODE_NIGHTLY_DEMO === "1";
if (!DEMO && (!NIGHTLY.baseURL || !NIGHTLY.apiKey || !NIGHTLY.model)) {
  console.log("[nightly] SKIP：未配置真实模型（PANCODE_NIGHTLY_BASE_URL/KEY/MODEL），exit 0。");
  console.log("[nightly] 配置后可每晚真跑：read-echo / subagent / apply-edit / compaction 四场景。");
  /* 机器可读的结论行：CI 里 exit 0 只代表"没把流水线拖红"，不代表真实模型跑过了。
     汇报时必须按这一行说，别把 SKIP 写成 PASS。 */
  console.log("[nightly] RESULT: SKIP（未验证真实模型路径，不算通过）");
  process.exit(0);
}

const PORT = 8877;
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");
const WebSocket = require("ws");

/* 沙箱先行：绝不允许夜间任务写进真实数据根 */
const SANDBOX = require("./_sandbox").create({
  tag: "nightly",
  wsFiles: {
    "calc.js": "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n",
    "calc.test.js": "const { add } = require('./calc');\nif (add(1, 2) !== 3) throw new Error('bad');\nconsole.log('calc ok');\n",
  },
  config: Object.assign({
    agentMode: "agent",
    permissions: { mode: "auto", allow: [], deny: [] },
    memory: { enabled: false },
    timeouts: { toolSec: 120, approvalSec: 60 },
  }, DEMO ? {} : {
    llm: {
      baseURL: NIGHTLY.baseURL, apiKey: NIGHTLY.apiKey, model: NIGHTLY.model,
      /* 场景④要逼出压缩：窗口调小到常规任务必然越线。其余场景共用同一配置，
         换小窗对正确性无影响（只有压缩更早触发）。 */
      contextWindow: 12000,
      maxToolRounds: 40,
      idleTimeout: 90000, connectTimeout: 60000,
    },
  }),
});

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 服务与 WS ---------- */
let srv, ws, events = [], wsWaiters = [];
function startServer() {
  return new Promise((resolve, reject) => {
    srv = spawn(process.execPath, ["server/index.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: SANDBOX.env({ PORT: String(PORT) }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    srv.stdout.on("data", (d) => { buf += d; if (buf.includes("listening") || buf.includes(String(PORT))) resolve(); });
    srv.stderr.on("data", (d) => { process.stderr.write("[srv] " + d); });
    srv.on("exit", (c) => { if (!ws) reject(new Error("服务进程提前退出 exit=" + c)); });
    setTimeout(() => resolve(), 4000);   // 日志措辞变了也不至于挂死
  });
}
async function registerAndConnect() {
  const tokRes = await fetch("http://127.0.0.1:" + PORT + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "nightly_" + Date.now(), password: "nightly-pass-123" }),
  }).then((x) => x.json());
  const token = tokRes.token || (tokRes.user && tokRes.user.token) || "";
  if (!token) throw new Error("注册未返回 token：" + JSON.stringify(tokRes).slice(0, 200));
  await new Promise((resolve, reject) => {
    ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.on("message", (raw) => {
    let ev; try { ev = JSON.parse(raw.toString()); } catch (e) { return; }
    events.push(ev);
    wsWaiters.forEach((w) => w(ev));
  });
}
function send(msg) { ws.send(JSON.stringify(msg)); }

/* 等待某个条件成真（事件流上轮询），带超时 */
function until(cond, ms, label) {
  return new Promise((resolve) => {
    if (cond(events)) return resolve(true);
    const timer = setTimeout(() => { cleanup(); resolve(false); }, ms);
    const w = () => { if (cond(events)) { clearTimeout(timer); cleanup(); resolve(true); } };
    function cleanup() { wsWaiters = wsWaiters.filter((x) => x !== w); }
    wsWaiters.push(w);
    void label;
  });
}

/* ---------- 场景 ---------- */
async function runScenario(name, prompt, check, timeoutMs) {
  console.log("\n\x1b[1m场景 " + name + "\x1b[0m");
  events = [];
  send({ type: "reset" });
  await wait(300);
  send({ type: "chat", text: prompt });
  const done = await until((evs) => evs.some((e) => e.type === "agent.done" || e.type === "agent.error"), timeoutMs || 300000, name);
  if (!done) { ok(name + "：任务在时限内结束", false, "超时 " + ((timeoutMs || 300000) / 1000) + "s"); return; }
  const errored = events.some((e) => e.type === "agent.error");
  if (DEMO) { ok(name + "（DEMO 降级：只验管线）", !errored); return; }
  if (errored) { ok(name + "：无 agent.error", false, JSON.stringify(events.find((e) => e.type === "agent.error")).slice(0, 200)); return; }
  await check();
}

async function main() {
  await startServer();
  await registerAndConnect();
  console.log("[nightly] 服务已起，模型：" + (DEMO ? "（演示引擎）" : NIGHTLY.model + " @ " + NIGHTLY.baseURL));

  await runScenario(
    "① read-echo（单工具回路）",
    "只做一件事：调用 read_file 读取 calc.js，然后在你的最终回复里原样引用 add 函数所在的那一行。不要修改任何文件。",
    async () => {
      ok("有 read_file 工具调用", events.some((e) => e.type === "tool.start" && e.name === "read_file"));
      const ans = events.filter((e) => e.type === "msg.delta").map((e) => e.text).join("");
      ok("回答里真的引用了 add 那一行", ans.includes("return a + b"), "回答前 200 字：" + ans.slice(0, 200));
    });

  if (!DEMO) {
    await runScenario(
      "② subagent（子智能体真实落盘 —— 2026-10 P0 回归钉）",
      "用 agent 工具派一个子智能体，让它完成：创建文件 sub-ok.js，内容正好是 module.exports = 7;（一行）。子智能体返回后你汇报它做了什么。不要自己动手写这个文件。",
      async () => {
        const p = path.join(SANDBOX.wsDir, "sub-ok.js");
        let content = null;
        try { content = fs.readFileSync(p, "utf8"); } catch (e) {}
        ok("sub-ok.js 由子智能体真实落盘", content != null && content.replace(/\s/g, "").includes("module.exports=7"),
          content == null ? "文件不存在" : "内容：" + JSON.stringify(content));
      });

    await runScenario(
      "③ apply-edit（补丁编辑链路）",
      "把 calc.js 里的 add 改成返回 a + b + 1（用 apply_edit 精确替换 return a + b; 那一行）。改完在回复里说明改了哪一行。",
      async () => {
        const c = fs.readFileSync(path.join(SANDBOX.wsDir, "calc.js"), "utf8");
        ok("盘上内容真的变了", c.includes("return a + b + 1"), "calc.js：" + JSON.stringify(c));
      });

    await runScenario(
      "④ compaction（压缩链路：小窗口长任务不因超限中断）",
      "这是一个多步任务：依次 read_file 读 calc.js 和 calc.test.js，然后创建 notes.md 写下这两个文件的行数，最后回复完成。步骤不要省略。",
      async () => {
        ok("没有因上下文超限报错", !events.some((e) => e.type === "agent.error" && /上下文|context|400|token/i.test(String(e.message || ""))));
        let notes = null; try { notes = fs.readFileSync(path.join(SANDBOX.wsDir, "notes.md"), "utf8"); } catch (e) {}
        ok("notes.md 已创建（压缩后任务仍在推进）", notes != null);
      }, 420000);
  }

  console.log("\n\x1b[1m[nightly] " + pass + " 通过 / " + fail + " 失败\x1b[0m");
  console.log("[nightly] RESULT: " + (fail
    ? "FAIL"
    : (DEMO ? "DEMO-PASS（只验管线，不算真实模型通过）" : "PASS")));
  if (fails.length) fails.forEach((f) => console.log("  ✗ " + f));
  try { ws.close(); } catch (e) {}
  try { srv.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("[nightly] 框架异常：", e);
  try { srv && srv.kill(); } catch (e2) {}
  process.exit(1);
});
