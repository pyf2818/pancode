/* ============================================================
   P1-B4 回归：Token 成本换算与用量账本
   验的是"三处同一个口径"这条承诺：实时事件、落盘账本、trace 记录里的金额必须来自
   同一次计算（server/cost.js），否则面板与设置页会各说各话。

   两条只有真跑才看得出来的断言：
     · 换进程再读一次账本，数字还在（内存里的 _usage 一重启就归零，这正是本项要修的东西）；
     · 账本被写坏时挪成 .corrupt-* 后从头记，而不是静默把旧账盖掉。
   沙箱：全程 PANCODE_DATA_DIR 指临时目录（由 _sandbox 负责，晚一步 require("./config") 就晚了）。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "cost" });

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const COST = require("../server/cost");
const usageStore = require("../server/usage-store");
const configMod = require("../server/config");
const { LlmAgent } = require("../server/agent-llm");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  ❌ " + name + (extra ? "  " + extra : "")); }
}

const STORE_PATH = path.join(__dirname, "..", "server", "usage-store");

/* 另起一个真进程读同一份账本：这是"重启不丢"唯一可信的证法 */
function inChildProcess(body) {
  return execFileSync(process.execPath, ["-e", "const u=require(" + JSON.stringify(STORE_PATH) + ");" + body],
    { env: SANDBOX.env(), encoding: "utf8", timeout: 30000 });
}

/* 只带 _accumUsage 所需字段的最小 agent：不连 LLM、不起循环 */
function mkAgent(cfg) {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = cfg;
  a._usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  a._usageByConv = {};
  a._traceSeq = 0;
  a.trace = [];
  a.events = [];
  a.emit = (e) => a.events.push(e);
  a._traceEnqueue = (rec) => a.trace.push(rec);
  a._estTokens = () => 0;
  return a;
}

const PRICED = { llm: { model: "deepseek-chat" }, pricing: { enabled: true, currency: "CNY", rates: [{ match: "deepseek", input: 1, output: 2 }] } };

(async () => {
  console.log("[P1-B4] 成本换算与用量账本验证");
  const file = usageStore.filePath();
  ok("账本落在数据根而不是工作区（两套同名 .pancode 的老坑）", file === path.join(configMod.ROOT, ".pancode", "usage.json"), file.replace(/\\/g, "/"));

  /* ---------- 1. 配了单价：三处同一个数 ---------- */
  const a = mkAgent(PRICED);
  a._accumUsage({ prompt_tokens: 1000000, completion_tokens: 500000, total_tokens: 1500000 }, [], "conv-A");
  const ev = a.events[a.events.length - 1];
  ok("agent.usage 事件带上本次金额", ev && ev.type === "agent.usage" && ev.cost && Math.abs(ev.cost.total - 2) < 1e-9, ev && JSON.stringify(ev.cost));
  ok("会话桶里累计了金额与币种", ev.usage.cost > 0 && ev.usage.costCurrency === "CNY", "cost=" + ev.usage.cost);
  ok("trace 记录里也留了 model + cost（回看旧会话时金额要能重算）",
    a.trace.length === 1 && a.trace[0].data.model === "deepseek-chat" && Math.abs(a.trace[0].data.cost - 2) < 1e-9 && a.trace[0].data.costCurrency === "CNY",
    JSON.stringify(a.trace[0].data));

  /* ---------- 2. 没配单价：只报 token，绝不报 0 元 ---------- */
  const b = mkAgent({ llm: { model: "qwen-max" }, pricing: { enabled: true, currency: "CNY", rates: [] } });
  b._accumUsage({ prompt_tokens: 5000, completion_tokens: 200, total_tokens: 5200 }, [], "conv-B");
  const evB = b.events[b.events.length - 1];
  ok("没配单价时事件里 cost 为 null（前端因此不显示金额）", evB.cost === null, JSON.stringify(evB.cost));
  ok("token 仍然照记（不能因为算不出钱就不记账）", evB.usage.total_tokens === 5200);
  const c = mkAgent({ llm: { model: "glm-4" } });     // 整段 pricing 缺失（老配置文件没这一项）
  c._accumUsage({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 }, [], "conv-C");
  ok("配置里根本没有 pricing 段也不炸（老盘上的 config 没这一项）", c.events[c.events.length - 1].cost === null);

  /* ---------- 3. 账本：按天/模型累计 + 落盘 ---------- */
  await usageStore.flush();
  ok("落盘文件存在", fs.existsSync(file));
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  const today = disk.days[usageStore.today().day];
  ok("磁盘上的模型条目按 model 分桶，token 数对得上", today && today.models["deepseek-chat"] && today.models["deepseek-chat"].prompt === 1000000,
    JSON.stringify(today && today.models));
  ok("未配单价的模型 token 也进了账，金额是 0", today.models["qwen-max"] && today.models["qwen-max"].prompt === 5000 && today.models["qwen-max"].cost === 0);
  ok("今天合计 = 配过价的那笔金额", Math.abs(usageStore.today().total - 2) < 1e-9, "total=" + usageStore.today().total);

  /* ---------- 4. 换进程再读：重启不丢（本项存在的理由） ---------- */
  const child = inChildProcess('const s=u.summary(30);process.stdout.write(JSON.stringify({total:s.total,priced:s.priced,models:Object.keys(s.models)}));');
  const reloaded = JSON.parse(child);
  ok("另起进程读同一份账本，金额一致", Math.abs(reloaded.total - 2) < 1e-9 && reloaded.priced === true, child.slice(0, 90));
  ok("模型清单跨进程完整", ["deepseek-chat", "qwen-max", "glm-4"].every((m) => reloaded.models.indexOf(m) >= 0), reloaded.models.join(","));

  /* ---------- 5. 坏 JSON：备份而不是盖掉 ---------- */
  fs.writeFileSync(file, "{ 这不是 JSON", "utf8");
  const child2 = inChildProcess(
    'u.add({ts:Date.now(),model:"x",usage:{prompt_tokens:7},cost:null});u.flush();' +
    'const fs=require("fs"),path=require("path");const dir=path.dirname(u.filePath());' +
    'process.stdout.write(JSON.stringify({backups:fs.readdirSync(dir).filter(f=>f.indexOf("usage.json.corrupt")===0).length,prompt:u.summary(30).prompt}));'
  );
  const rec = JSON.parse(child2);
  ok("坏文件被挪成 .corrupt-*（旧账留着，不是就地覆盖）", rec.backups === 1, child2.slice(0, 90));
  ok("新账从空开始继续记", rec.prompt === 7, "prompt=" + rec.prompt);

  /* ---------- 6. 改了单价要把历史按 token 重算 ---------- */
  usageStore.add({ ts: Date.now(), model: "deepseek-chat", usage: { prompt_tokens: 1000000, completion_tokens: 0 }, cost: { total: 1, currency: "CNY" } });
  await usageStore.flush();
  const before = usageStore.summary(30).total;
  const n = usageStore.reprice([{ match: "deepseek", input: 3, output: 6 }], "CNY");
  const after = usageStore.summary(30).total;
  ok("reprice 覆盖到已有条目", n >= 1, "改动 " + n + " 条");
  ok("关键：单价从 1 涨到 3 之后历史金额按 token 跟着变（不是停在 1）", after > before, before + " → " + after);
  await usageStore.flush();

  /* ---------- 7. 换算本体的四条边界 ---------- */
  ok("条目自带币种优先于默认币种",
    COST.costOf("gpt-4o-mini", { prompt_tokens: 1e6, completion_tokens: 0 }, { currency: "CNY", rates: [{ match: "gpt-4o", input: 0.15, output: 0.6, currency: "USD" }] }).currency === "USD");
  ok("enabled=false 一律不算金额（用户想只看 token）",
    COST.costOf("deepseek-chat", { prompt_tokens: 1e6, completion_tokens: 1 }, { enabled: false, rates: [{ match: "deepseek", input: 1, output: 1 }] }) === null);
  ok("日界按本地时间（跨 UTC 午夜不串天）", COST.dayKey(new Date(2026, 9, 14, 23, 59).getTime()) === "2026-10-14");
  ok("金额显示：不足 1 元留 4 位（¥0.00 会被读成面板坏了）", COST.fmtMoney(0.0064, "CNY") === "¥0.0064");

  console.log("\n[P1-B4] 结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e && e.stack || e); process.exit(1); });
