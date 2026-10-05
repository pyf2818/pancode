/* 桌面端「关窗后续跑」验证：真的起一个 Electron 实例（沙箱数据根 + 沙箱工作区 + demo 引擎 + 独立端口），
 * 派一个活 → 到点自动关掉窗口 → 断言后端进程还活着、/api/health 仍在应答、任务照常收口、
 * 任务表在窗口不存在的时候也能被读到（托盘/通知就靠这份数据）。
 * 这一段是唯一能证明"关窗 ≠ 杀死 Agent"的验收层：纯逻辑单测只能证明判断式，证明不了进程存活。
 * 若本机无法启动 Electron（无桌面会话 / GPU 受限），脚本会明确报"未能启动"并退出码 1，不假装通过。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = 8815;
const ROOT = path.resolve(__dirname, "..");
const SANDBOX = path.join(ROOT, "scripts", "_verify_out", "desktop-sandbox");
const DATA_DIR = path.join(SANDBOX, "data");
const WS_DIR = path.join(SANDBOX, "ws");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function get(urlPath, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { "x-user-token": token } : {};
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method: "GET", headers, timeout: 4000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, raw: buf }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("超时")));
    r.end();
  });
}
function post(urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = http.request({
      host: "127.0.0.1", port: PORT, path: urlPath, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      timeout: 6000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, raw: buf }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("超时")));
    r.write(data); r.end();
  });
}

async function waitHealth(maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { const r = await get("/api/health"); if (r.json && r.json.ok) return true; } catch (e) {}
    await wait(500);
  }
  return false;
}

(async () => {
  let electronBin = "";
  try { electronBin = require("electron"); } catch (e) {
    console.log("\x1b[33mSKIP:\x1b[0m 本机没有安装 electron（" + e.message + "），桌面层无法在此验收。");
    process.exit(0);
  }
  if (typeof electronBin !== "string") { console.log("\x1b[33mSKIP:\x1b[0m require('electron') 不在 Node 进程里返回可执行路径。"); process.exit(0); }

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  /* 演示引擎开箱就跑（没配 API Key 的装机状态），它按固定剧本读 README/src/tests，
     所以沙箱工作区必须是那套夹具——直接复制仓库自带的 workspace/，不在这里重抄一遍。 */
  fs.cpSync(path.join(ROOT, "workspace"), WS_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "pancode.config.json"), JSON.stringify({ workspace: WS_DIR }), "utf8");

  section("启动 Electron 实例（独立端口 + 沙箱数据根）");
  const child = spawn(electronBin, ["."], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), PANCODE_DATA_DIR: DATA_DIR, CURSORWEB_WORKSPACE: WS_DIR,
      CURSORWEB_ENGINE: "demo", AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
      PANCODE_PROBE_CLOSE_MS: "2500",        // 主进程到点自动关窗（electron/main.js 里的探针钩子）
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out = (out + c).slice(-30000); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-30000); });
  child.on("exit", (code, sig) => { out += "\n[exit code=" + code + " sig=" + sig + "]"; });

  const alive = () => child.exitCode === null && !child.killed;
  let healthy = false;
  try { healthy = await waitHealth(60000); } catch (e) { }
  if (!healthy) {
    ok("Electron 实例能启动并把后端带起来", false, out.slice(-1500));
    try { child.kill(); } catch (e) {}
    console.log("\n\x1b[31mHAS FAIL\x1b[0m：" + pass + " 通过 / " + fail + " 失败");
    console.log("说明：本机当前环境无法启动 Electron（无桌面会话 / 沙箱限制），桌面层需要你在本机跑一次 npm run desktop 验收。");
    process.exit(1);
  }
  ok("Electron 实例能启动并把后端带起来", true);

  const reg = await post("/api/auth/register", { username: "_desk_" + Date.now(), password: "test1234" });
  const TOKEN = reg.json && reg.json.token;
  ok("沙箱内可注册验证用户（账号只落在沙箱数据根）", !!TOKEN, JSON.stringify(reg.json).slice(0, 140));

  /* 用 WS 派一个活：demo 引擎会跑一串工具，耗时足够跨过"关窗"这个时刻 */
  const WebSocket = require("ws");
  const conv = "c-desk-" + Date.now();
  const ws = new WebSocket("ws://localhost:" + PORT + "?token=" + encodeURIComponent(TOKEN));
  const events = [];
  ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); setTimeout(() => rej(new Error("WS 连接超时")), 10000); });
  ws.send(JSON.stringify({ type: "chat", text: "修复筛选 bug 并补测试", convId: conv }));

  const waitFor = async (pred, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { const e = events.find(pred); if (e) return e; await wait(120); }
    return null;
  };

  section("任务在跑，窗口按探针设定被关掉");
  // 演示引擎的事件不带 convId（LLM 引擎才由 AsyncLocalStorage 统一注入），这里只按事件类型判，归属交给 /api/tasks 校
  const started = await waitFor((e) => e.type === "tool.start", 20000);
  ok("任务已开始（收到 tool.start）", !!started, started === null && "20s 内没有工具事件");

  let t = (tasks) => tasks.some((x) => x.convId === conv && x.status === "running");
  let r = await get("/api/tasks", TOKEN);
  const runningBeforeClose = t((r.json && r.json.tasks) || []);
  ok("关窗前 /api/tasks 能查到这条 running（这就是托盘那行的数据源）", runningBeforeClose === true,
    JSON.stringify((r.json || {}).tasks || r.json).slice(0, 200));

  await wait(3500);                      // 越过 PANCODE_PROBE_CLOSE_MS=2500
  ok("关窗后 Electron 进程仍然存活", alive() === true, out.slice(-300));
  let stillHealthy = false;
  try { const h = await get("/api/health"); stillHealthy = !!(h.json && h.json.ok); } catch (e) {}
  ok("关窗后后端仍在应答 /api/health", stillHealthy === true);

  section("没有窗口，任务照常跑到收口");
  const done = await waitFor((e) => e.type === "agent.done", 150000);
  ok("窗口关闭后仍收到 agent.done（Agent 没被关窗带走）", !!done, done === null && "150s 内没等到 agent.done");
  r = await get("/api/tasks", TOKEN);
  const rows = (r.json && r.json.tasks) || [];
  const mine = rows.find((x) => x.convId === conv) || {};
  ok("收口后任务表把这行标成 done", mine.status === "done", JSON.stringify(mine).slice(0, 200));
  ok("演示引擎确实改了盘（src/utils.js 里出现了它新增的 sortByPriority）",
    /sortByPriority/.test(fs.readFileSync(path.join(WS_DIR, "src", "utils.js"), "utf8")),
    fs.readFileSync(path.join(WS_DIR, "src", "utils.js"), "utf8").slice(0, 120));

  section("退出钩子与托盘装配");
  ok("server/index.js 导出了 shutdown（electron before-quit 用它刷盘 + 杀子进程）",
    /module\.exports\s*=\s*\{\s*shutdown/.test(fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8")));
  /* 托盘建不出来时主进程会打这行并退回"关窗即退出"——那等于用户拍板的那条承诺失效，必须能被发现。
     图标到底长什么样、通知气泡弹没弹，只有人眼能验收，这一步请在桌面端亲眼确认一次。 */
  ok("托盘创建没有失败（日志里没有出现退回提示）", !/托盘创建失败/.test(out), out.slice(-300));

  ws.close();
  try { child.kill(); } catch (e) {}
  await wait(400);

  console.log("\n" + (fail ? "\x1b[31mHAS FAIL\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { for (const f of fails) console.log("  - " + f); console.log("\n--- electron 输出末尾 ---\n" + out.slice(-1200)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\x1b[31mFAIL:\x1b[0m " + (e && e.stack || e)); process.exit(1); });
