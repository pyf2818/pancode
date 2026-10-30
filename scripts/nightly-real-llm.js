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
/* 度量落盘位置（可选）：给了就按行追加 JSONL，没给就只打 stdout。
   不默认写到仓库里 —— 夜间跑多少次都不该把工作树弄脏。 */
const REPORT_TO = process.env.PANCODE_NIGHTLY_REPORT || "";
if (!DEMO && (!NIGHTLY.baseURL || !NIGHTLY.apiKey || !NIGHTLY.model)) {
  console.log("[nightly] 未测（SKIP）：未配置真实模型（PANCODE_NIGHTLY_BASE_URL/KEY/MODEL），exit 0。");
  console.log("[nightly] 配置后可每晚真跑：read-echo / subagent / apply-edit / compaction 四场景。");
  /* 机器可读的结论行：CI 里 exit 0 只代表"没把流水线拖红"，不代表真实模型跑过了。
     汇报时必须按这一行说，别把未测写成 PASS —— 0 条判据就是 0 条，通过率的分母里没有它们。 */
  console.log("共 0 条，红 0 条");
  console.log("[nightly] RESULT: 未测（真实模型路径一条都没跑，不算通过，也不计入通过率分母）");
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
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v); } catch (e) { return String(v); } };

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
    ev.__at = Date.now();          // 到达时刻：TTFT 与端到端耗时要从这里量，不是从"跑完之后回忆"
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
/* 一轮跑完之后手上有的东西：事件流 + 从中算出来的几条事实。
   断言一律从这些事实出发，不再"看盘上有没有那个文件"就算数 ——
   盘上有文件只证明"某个 write_file 成功了"，不证明被测的那条路（子智能体 / apply_edit / 压缩）真的走过。 */
function facts(evs) {
  const toolNames = (n) => evs.filter((e) => e.type === "tool.start" && e.name === n);
  const toolEnds = (n) => evs.filter((e) => e.type === "tool.end" && e.name === n);
  return {
    evs,
    toolNames, toolEnds,
    toolOk: (n) => toolEnds(n).some((e) => e.ok !== false),
    errors: evs.filter((e) => e.type === "agent.error"),
    done: evs.filter((e) => e.type === "agent.done"),
    compact: evs.filter((e) => e.type === "context.compact" || e.type === "context.microcompact"),
    text: evs.filter((e) => e.type === "msg.delta").map((e) => e.text).join(""),
  };
}

async function runScenario(name, prompt, check, timeoutMs) {
  console.log("\n\x1b[1m场景 " + name + "\x1b[0m");
  events = [];
  send({ type: "reset" });
  await wait(300);
  const tSend = Date.now();
  send({ type: "chat", text: prompt });
  const ended = await until((evs) => evs.some((e) => e.type === "agent.done" || e.type === "agent.error"), timeoutMs || 300000, name);
  if (!ended) { ok(name + "：任务在时限内结束", false, "超时 " + ((timeoutMs || 300000) / 1000) + "s"); return; }
  const f = facts(events);
  /* 每次跑都留一行机器可读的度量：TTFT、端到端、工具调用数、恢复次数、成本。
     没有这一行，"这版模型/这版参数好不好"就只能靠人肉看日志比。 */
  const firstDelta = f.evs.find((e) => e.type === "msg.delta");
  const usage = f.evs.filter((e) => e.type === "agent.usage").pop();
  const rec = {
    scenario: name,
    at: new Date().toISOString(),
    model: DEMO ? "demo-engine" : NIGHTLY.model,
    baseURL: DEMO ? null : NIGHTLY.baseURL,
    ttftMs: firstDelta ? Math.max(0, firstDelta.__at - tSend) : null,
    e2eMs: Math.max(0, (f.evs[f.evs.length - 1].__at || Date.now()) - tSend),
    toolCalls: f.evs.filter((e) => e.type === "tool.start").length,
    midErrors: f.errors.length,
    compactEvents: f.compact.length,
    cost: usage && usage.cost != null ? usage.cost : null,
    usage: usage ? usage.usage : null,
    outcome: f.evs[f.evs.length - 1].type || null,
  };
  console.log("  [nightly] METRIC " + JSON.stringify(rec));
  if (REPORT_TO) { try { fs.appendFileSync(REPORT_TO, JSON.stringify(rec) + "\n", "utf8"); } catch (e) {} }
  /* 中途的 agent.error 与"这一轮最终失败"是两件事：
     以前任一 agent.error 就 return，把"报过错但自己恢复并跑完了"的场景直接判死，
     反过来也一样——只看最终文件内容，会把"根本没走被测工具"放过去。这里两笔分开记。 */
  const last = f.evs[f.evs.length - 1] || {};
  const fatalAtEnd = last.type === "agent.error";
  if (f.errors.length) {
    console.log("  \x1b[33m·\x1b[0m 中途 agent.error " + f.errors.length + " 条" + (fatalAtEnd ? "，且以此收口（判失败）" : "，但任务仍在推进（单独记录，不盖掉结果）"));
  }
  ok(name + "：这一轮以 agent.done 收口（不是以 agent.error 收口）", !fatalAtEnd && f.done.length > 0,
    f.errors.length ? "收口事件：" + last.type + "；首条错误：" + J(last.message || last.error).slice(0, 200) : "没等到 agent.done");
  ok(name + "：TTFT 量得到（首帧 msg.delta 的到达时刻在发送之后）", rec.ttftMs !== null && rec.ttftMs >= 0 && rec.e2eMs >= rec.ttftMs, J({ ttft: rec.ttftMs, e2e: rec.e2eMs }));
  if (DEMO) { console.log("  \x1b[33m·\x1b[0m DEMO 降级：只验管线通，下面的真实模型断言不跑"); return; }
  if (fatalAtEnd) return;
  await check(f);
}

async function main() {
  await startServer();
  await registerAndConnect();
  console.log("[nightly] 服务已起，模型：" + (DEMO ? "（演示引擎）" : NIGHTLY.model + " @ " + NIGHTLY.baseURL));

  await runScenario(
    "① read-echo（单工具回路）",
    "只做一件事：调用 read_file 读取 calc.js，然后在你的最终回复里原样引用 add 函数所在的那一行。不要修改任何文件。",
    (f) => {
      ok("确实发起了 read_file 工具调用", f.toolNames("read_file").length > 0,
        "tool.start 里的名字：" + J([...new Set(f.evs.filter((e) => e.type === "tool.start").map((e) => e.name))]));
      ok("read_file 这一调用以成功收尾", f.toolOk("read_file"), J(f.toolEnds("read_file").map((e) => e.ok)));
      ok("回答里真的引用了 add 那一行", f.text.includes("return a + b"), "回答前 200 字：" + f.text.slice(0, 200));
      ok("这一轮没有动过任何文件（提示词要求只读）",
        f.toolNames("write_file").length === 0 && f.toolNames("apply_edit").length === 0 && f.toolNames("delete_file").length === 0,
        "越界副作用：" + J(f.evs.filter((e) => e.type === "tool.start" && /write|edit|delete/.test(String(e.name))).map((e) => e.name)));
    });

  if (!DEMO) {
    await runScenario(
      "② subagent（子智能体真实落盘 —— 2026-10 P0 回归钉）",
      "用 agent 工具派一个子智能体，让它完成：创建文件 sub-ok.js，内容正好是 module.exports = 7;（一行）。子智能体返回后你汇报它做了什么。不要自己动手写这个文件。",
      (f) => {
        /* 三条一起才叫"过了子智能体这条路"：派发了 agent 工具、那次调用成功收尾、文件真在盘上。
           只断言文件存在的话，主模型自己 write_file 也能让它绿 —— 那正是这次要修的口径。 */
        ok("发起了 agent 工具（子智能体派发）", f.toolNames("agent").length > 0,
          "tool.start 名字：" + J([...new Set(f.evs.filter((e) => e.type === "tool.start").map((e) => e.name))]));
        ok("子智能体那次调用成功收尾", f.toolOk("agent"), J(f.toolEnds("agent").map((e) => e.ok)));
        const p = path.join(SANDBOX.wsDir, "sub-ok.js");
        let content = null;
        try { content = fs.readFileSync(p, "utf8"); } catch (e) {}
        ok("sub-ok.js 真实落盘且内容对", content != null && content.replace(/\s/g, "").includes("module.exports=7"),
          content == null ? "文件不存在" : "内容：" + J(content));
        const mainWrote = f.evs.some((e) => e.type === "tool.start" && e.name === "write_file" && /sub-ok\.js/.test(String(e.target || "")));
        ok("文件不是主循环自己写的（那就没有走子智能体）", !mainWrote, mainWrote ? "主循环直接 write_file 了 sub-ok.js" : "");
      });

    await runScenario(
      "③ apply-edit（补丁编辑链路）",
      "把 calc.js 里的 add 改成返回 a + b + 1（用 apply_edit 精确替换 return a + b; 那一行）。改完在回复里说明改了哪一行。",
      (f) => {
        ok("确实发起了 apply_edit", f.toolNames("apply_edit").length > 0,
          "tool.start 名字：" + J([...new Set(f.evs.filter((e) => e.type === "tool.start").map((e) => e.name))]));
        ok("apply_edit 以成功收尾", f.toolOk("apply_edit"), J(f.toolEnds("apply_edit").map((e) => e.ok)));
        const c = fs.readFileSync(path.join(SANDBOX.wsDir, "calc.js"), "utf8");
        ok("盘上内容真的变了", c.includes("return a + b + 1"), "calc.js：" + J(c));
      });

    await runScenario(
      "④ compaction（压缩链路：小窗口长任务不因超限中断）",
      "这是一个多步任务：依次 read_file 读 calc.js 和 calc.test.js，然后创建 notes.md 写下这两个文件的行数，最后回复完成。步骤不要省略。",
      (f) => {
        /* 先证明压缩真的发生过，再谈"压缩之后任务还在推进"。
           以前只断言"没有因超限报错 + notes.md 存在"，窗口没压也能全绿 —— 那是没测。 */
        ok("这一轮真的触发了上下文压缩（context.compact / microcompact）", f.compact.length > 0,
          "事件类型分布：" + J([...new Set(f.evs.map((e) => e.type))]));
        ok("没有因上下文超限报错", !f.errors.some((e) => /上下文|context|400|token/i.test(String(e.message || e.error || ""))),
          J(f.errors.map((e) => String(e.message || e.error).slice(0, 120))));
        let notes = null; try { notes = fs.readFileSync(path.join(SANDBOX.wsDir, "notes.md"), "utf8"); } catch (e) {}
        ok("notes.md 已创建（压缩后任务仍在推进）", notes != null);
      }, 420000);
  }

  console.log("\n\x1b[1m[nightly] " + pass + " 通过 / " + fail + " 失败\x1b[0m");
  console.log("共 " + (pass + fail) + " 条，红 " + fail + " 条");
  console.log("[nightly] RESULT: " + (fail
    ? "FAIL"
    : (DEMO ? "DEMO-PASS（只验管线通，真实模型路径未测 —— 不计入真实模型通过率）" : "PASS")));
  if (DEMO && !fail) console.log("[nightly] 未测：②③④ 三个真实模型场景没跑（演示引擎），通过率分母里不含它们。");
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
