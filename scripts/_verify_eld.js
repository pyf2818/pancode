/* ============================================================
   F22-4 验收：ELD 采样口径要量到它声称的东西
   ————————————————————————————————————————————————————
   旧写法：每 1s 起一个 setImmediate，量"排定到执行"的差，当作事件循环延迟。
   它漏的是这件事本身：那个 1s 的 interval 自己也会被卡住迟发 —— 卡住的时候
   没有 setImmediate 在排队，于是最长的一次阻塞恰好量不到。
   新写法用 perf_hooks.monitorEventLoopDelay（原生按 resolution 记整段分布）
   + eventLoopUtilization 增量。

   这一支分三段：
     ① 口径对照：同一个进程里同时跑"旧写法"和"新写法"，把一次 250ms 同步阻塞
        刻意放在旧写法两拍之间 —— 旧读数是陈的、新的必须抓到；
     ② ELU：阻塞之后那 1s 的忙比要大于空闲时的忙比；
     ③ 真服务端：system.perf 三字段齐、且 eldMax ≥ eld（窗口 p99 不可能超过历史最大），
        并且源码里不许再留"setImmediate 当延迟计"的旧写法（防回退）。
   全程一次性沙箱数据根，绝不碰开发者的 .pancode。
   用法：node scripts/_verify_eld.js
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "eld" });
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { performance, monitorEventLoopDelay, eventLoopUtilization } = require("perf_hooks");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.ELD_PORT || 8941);

let pass = 0, fail = 0;
const fails = [];
const metrics = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function measure(name, value, unit) { metrics.push({ name, value: String(value), unit }); console.log("  \x1b[36m◦\x1b[0m " + name + "：\x1b[1m" + value + "\x1b[0m " + unit); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 300); } catch (e) { return String(v).slice(0, 300); } };
function blockSync(ms) { const t = Date.now(); while (Date.now() - t < ms) { /* 就是要同步卡住 */ } }

(async () => {
  section0("① 口径对照：阻塞放在旧写法两拍之间时，旧读数必须是陈的");
  /* 照抄旧实现：1s 的 interval 里排一个 setImmediate，量排定到执行的差。 */
  let oldVal = -1, oldMax = 0;
  const oldTimer = setInterval(() => {
    const s = process.hrtime.bigint();
    setImmediate(() => {
      const ms = Number(process.hrtime.bigint() - s) / 1e6;
      oldVal = ms;
      if (ms > oldMax) oldMax = ms;
    });
  }, 1000);
  const hist = monitorEventLoopDelay({ resolution: 20 });
  hist.enable();
  /* ELU 增量要传参照对象（eventLoopUtilization(reference)），两个对象相减只会得到 NaN。 */
  let eluRef = eventLoopUtilization();
  await wait(1150);              // 让旧写法先正常采一拍
  const baseline = oldVal;
  const eluBase = eventLoopUtilization(eluRef);
  /* 关键：此刻旧写法刚排完一次 setImmediate、下一次还要等约 1s。
     现在卡 250ms，旧写法没有任何回调在排队 —— 它读到的还是上一拍那个陈值。 */
  const eluBusyRef = eventLoopUtilization();
  blockSync(250);
  const oldRightAfter = oldVal;
  /* 延迟是在"下一个内部 timer 真的跑到"时才记进直方图的 —— 阻塞刚结束时读还是旧的。
     这是这套 API 的口径（窗口式），不是缺陷：服务端那边每 1s 读一次，远大于 20ms 的分辨率。
     所以这里要等一拍再读，否则判据量的就是"读得太早"这件事。 */
  await wait(80);
  const histMaxAfterBlock = Number(hist.max) / 1e6;
  const p99AfterBlock = Number(hist.percentile(99)) / 1e6;
  const histMinAfterBlock = Number(hist.min) / 1e6;
  const eluBusy = eventLoopUtilization(eluBusyRef);   // 这个窗口必须把 250ms 阻塞包在里面
  void eluRef;
  hist.disable(); clearInterval(oldTimer);

  measure("旧写法阻塞前的读数", baseline.toFixed(2), "ms");
  measure("旧写法在 250ms 阻塞之后的读数", oldRightAfter.toFixed(2), "ms");
  measure("新写法同一窗口的 max", histMaxAfterBlock.toFixed(2), "ms");
  measure("新写法同一窗口的 p99", p99AfterBlock.toFixed(2), "ms");
  measure("新写法同一窗口的 min（对照：空闲时段的小延迟仍被分开记）", histMinAfterBlock.toFixed(2), "ms");
  ok("旧写法量不到这次阻塞（读数还是上一拍的陈值）", oldRightAfter < 120,
    "阻塞 250ms 之后旧读数 = " + oldRightAfter.toFixed(2) + "ms —— 它要是也涨到 200ms 以上，说明这个对照场景失效了");
  ok("新写法把这次阻塞量出来了（max 覆盖到 250ms 这一级）", histMaxAfterBlock >= 180,
    "max = " + histMaxAfterBlock.toFixed(2) + "ms（resolution=20ms，允许一档粒度误差）");
  ok("新写法的 p99 也随阻塞抬升", p99AfterBlock >= 20, "p99 = " + p99AfterBlock.toFixed(2) + "ms");

  section0("② ELU 忙比：阻塞那段时间的比例要显著高于空闲时段");
  /* 这台 Node 上比例字段叫 utilization；写成 .elu 会静默拿到 undefined，
     于是"忙比"永远是 0 —— 看起来像机器很闲，实际是没读数。 */
  const eluOf = (o) => (o && typeof o.utilization === "number" ? o.utilization : null);
  measure("空闲 1.15s 的 utilization", String(eluOf(eluBase)), "");
  measure("含 250ms 阻塞那一段的 utilization", String(eluOf(eluBusy)), "");
  ok("eventLoopUtilization 给得出可用的增量（不是恒 0）",
    eluOf(eluBusy) !== null && eluOf(eluBase) !== null, J({ 字段: Object.keys(eluBusy || {}), 空闲: eluBase, 忙: eluBusy }));
  ok("阻塞那一段的忙比显著高于空闲段", eluOf(eluBusy) > eluOf(eluBase) + 0.05,
    J({ 空闲: eluOf(eluBase), 忙: eluOf(eluBusy) }));

  section0("③ 真服务端：system.perf 的字段与不变式");
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT, env: SANDBOX.env({ PORT: String(PORT), AGENT_FAST: "1", NODE_NO_WARNINGS: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (c) => { log = (log + c).slice(-20000); });
  server.stderr.on("data", (c) => { log = (log + c).slice(-20000); });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { await wait(200); try { up = (await fetch("http://127.0.0.1:" + PORT + "/api/health")).ok; } catch (e) {} }
    if (!up) { console.error("[eld] 服务端没起来：\n" + log.slice(-2000)); process.exit(1); }
    /* 令牌要先注册一个真用户：随便编一个 bearer 会被服务端当场断握手（socket hang up），
       那时量到的就不是性能帧而是"连不上"。 */
    const reg = await (await fetch("http://127.0.0.1:" + PORT + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "_eld_" + Date.now(), password: "test1234" }),
    })).json();
    const token = reg.token || (reg.user && reg.user.token) || "";
    ok("前提：注册到真令牌（编的 token 会被握手直接拒掉）", !!token, J(reg).slice(0, 200));
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
    const perfFrames = [];
    ws.on("message", (raw) => {
      let ev; try { ev = JSON.parse(raw.toString()); } catch (e) { return; }
      if (ev.type === "system.perf") perfFrames.push(ev);
    });
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    await wait(7000);            // 至少两拍 3s 广播
    try { ws.close(); } catch (e) {}
    measure("收到 system.perf 帧", perfFrames.length, "帧");
    ok("前提：真收到广播（没收到的话下面都是空话）", perfFrames.length >= 2, "收到 " + perfFrames.length + " 帧");
    const last = perfFrames[perfFrames.length - 1] || {};
    ok("广播里有 eld / eldMax / elu / uptime 四个字段",
      ["eld", "eldMax", "elu", "uptime"].every((k) => typeof last[k] === "number"),
      J(Object.keys(last)));
    ok("eldMax 不小于 eld（历史最大不可能小于当前窗口的 p99）",
      perfFrames.every((f) => f.eldMax + 0.05 >= f.eld), J(perfFrames.map((f) => f.eld + "/" + f.eldMax)));
    const stateRes = await fetch("http://127.0.0.1:" + PORT + "/api/state", { headers: { "x-user-token": token } }).catch((e) => ({ status: "fetch 失败 " + e.message }));
    const state = stateRes.json ? await stateRes.json().catch(() => ({})) : {};
    ok("前提：/api/state 真的应答了（401/超时不能当成「口径对了」）",
      !stateRes.status || Number(stateRes.status) === 200, J({ status: stateRes.status, keys: Object.keys(state).slice(0, 10) }));
    ok("/api/state 里的 eld 也在（老接口口径同步改了）", !!state.eld && typeof state.eld.ms === "number",
      J({ status: stateRes.status, eld: state.eld, keys: Object.keys(state).slice(0, 10) }));
    ok("/api/state 里的 eld.max 同样是「历史最大」这一口径", !!state.eld && typeof state.eld.max === "number" && state.eld.max + 0.05 >= state.eld.ms,
      J(state.eld));
  } finally {
    try { server.kill(); } catch (e) {}
    await wait(200);
  }

  section0("④ 不许回退：服务端源码里不能再有「setImmediate 当延迟计」");
  const idx = fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8");
  ok("ELD 采样用的是 monitorEventLoopDelay", idx.includes("monitorEventLoopDelay"), "没找到");
  ok("旧的 _eldMs = setImmediate 差值写法已删除",
    !/const s = process\.hrtime\.bigint\(\);\s*\n\s*setImmediate/.test(idx), "还留着旧写法");
  ok("广播里带上了 elu（忙比），不是只报一个瞬时点", /system\.perf[\s\S]{0,200}elu:/.test(idx), "广播里没有 elu");

  console.log("\n\x1b[1m量到的数\x1b[0m");
  for (const m of metrics) console.log("  " + m.name + " = " + m.value + " " + m.unit);
  console.log("\n共 " + (pass + fail) + " 条，红 " + fail + " 条");
  if (fail) { console.log("\n失败明细："); fails.forEach((f, i) => console.log("  " + (i + 1) + ". " + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("[eld] 探针抛错：" + (e && e.stack || e)); process.exit(1); });

function section0(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
