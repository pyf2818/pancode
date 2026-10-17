/* 桌面端「关窗后续跑 / 记住选择 / 托盘」验收。
 *
 * 起三个真 Electron 实例（各自沙箱数据根 + 沙箱工作区 + 独立端口 + demo 引擎），分别验：
 *   A 关窗偏好=挂后台：派一个活 → 到点自动关窗 → 后端还活着、任务照常收口、
 *     托盘菜单确实按分组装配出来、点某一条真的走 openConversation 那条链；
 *   B 关窗偏好=问：第一次关窗有人答（探针注入答案 + 勾"记住"）→ 选择落盘 →
 *     **第二次关窗不再问**，直接照记住的办。这一条是"记住我的选择"坏掉很久之后新加的判据；
 *   C 关窗偏好=直接退出：关窗真的把进程带走（证明"问"之外的另一极没被托盘吃掉）。
 *
 * 为什么必须是三个实例：关窗偏好是启动期读的配置，同进程里没有第二个入口能改它；
 * 而单实例锁跟着 userData 走，所以每个实例都要有自己的数据根（见 electron/main.js 那段）。
 * 若本机无法启动 Electron（无桌面会话 / GPU 受限），脚本明确报"未能启动"并退出码 1，不假装通过。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "scripts", "_verify_out");
let electronBin = "";        // 由主流程在启动前填；boot() 要读它，所以必须是模块级

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function get(port, urlPath, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { "x-user-token": token } : {};
    const r = http.request({ host: "127.0.0.1", port, path: urlPath, method: "GET", headers, timeout: 4000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, raw: buf }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("超时")));
    r.end();
  });
}
function post(port, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const r = http.request({
      host: "127.0.0.1", port, path: urlPath, method: "POST",
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

/* 一个可关窗、可注入答案、可读日志的 Electron 实例 */
async function boot(tag, port, cfgExtra, probeEnv) {
  const sandbox = path.join(OUT, "desktop-sandbox-" + tag);
  const DATA_DIR = path.join(sandbox, "data");
  const WS_DIR = path.join(sandbox, "ws");
  fs.rmSync(sandbox, { recursive: true, force: true });
  /* 演示引擎开箱就跑（没配 API Key 的装机状态），它按固定剧本读 README/src/tests，
     所以沙箱工作区必须是那套夹具——直接复制仓库自带的 workspace/，不在这里重抄一遍。 */
  fs.cpSync(path.join(ROOT, "workspace"), WS_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "pancode.config.json"),
    JSON.stringify(Object.assign({ workspace: WS_DIR }, cfgExtra || {})), "utf8");

  const child = spawn(electronBin, ["."], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), PANCODE_DATA_DIR: DATA_DIR, CURSORWEB_WORKSPACE: WS_DIR,
      CURSORWEB_ENGINE: "demo", AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
    }, probeEnv || {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const inst = {
    child, port, DATA_DIR, WS_DIR, sandbox, out: "",
    alive: () => child.exitCode === null && !child.killed,
    count: (sub) => (inst.out.split(sub).length - 1),
  };
  child.stdout.on("data", (c) => { inst.out = (inst.out + c).slice(-60000); });
  child.stderr.on("data", (c) => { inst.out = (inst.out + c).slice(-60000); });
  child.on("exit", (code, sig) => { inst.out += "\n[exit code=" + code + " sig=" + sig + "]"; });
  /* 关键的一层：后端起来 ≠ 界面弹出来。3.2.1 第一次装机就是栽在这个洞上——
     ipcMain.off 少传 listener 抛 ERR_INVALID_ARG_TYPE，createWindow 从那一行整段中断，
     ready-to-show 没挂上：health 全绿、任务照跑，而窗口从头到尾没出现过（wsClients 恒 0）。
     所以每个实例都先等主进程自己喊"显形了"。 */
  inst.marker = async (sub, ms) => {
    const hit = () => (typeof sub === "string" ? inst.out.includes(sub) : sub.test(inst.out));
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (hit()) return true; await wait(120); }
    return false;
  };
  inst.healthy = async () => { try { const h = await get(port, "/api/health"); return !!(h.json && h.json.ok); } catch (e) { return false; } };
  let up = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) { if (await inst.healthy()) { up = true; break; } await wait(500); }
  if (!up) { try { child.kill(); } catch (e) {} return null; }
  return inst;
}

(async () => {
  try { electronBin = require("electron"); } catch (e) {
    console.log("\x1b[33mSKIP:\x1b[0m 本机没有安装 electron（" + e.message + "），桌面层无法在此验收。");
    process.exit(0);
  }
  if (typeof electronBin !== "string") { console.log("\x1b[33mSKIP:\x1b[0m require('electron') 不在 Node 进程里返回可执行路径。"); process.exit(0); }

  /* ================= 实例 A：关窗挂后台 + 托盘 ================= */
  section("A 启动 Electron（关窗偏好=挂后台，任务在跑时关窗）");
  const A = await boot("a", 8815, { desktop: { closeAction: "background" } }, {
    PANCODE_PROBE_CLOSE_MS: "9000",
    /* 为什么是 9 秒而不是原来的 2.5 秒：后端启动 + 页面加载就要 2–3 秒，
       2.5 秒那一刀砍在 loadURL 中间，窗口从没成功显示过——这支探针过去 11 项全绿，
       其实一次也没证明过"界面弹得出来"。现在关窗时机落在"任务正在跑"里面，
       "关窗前 / 关窗后"那对比对才真的是在比这两件事。 */
    PANCODE_PROBE_TRAY_DUMP: "1",
    PANCODE_PROBE_TRAY_CLICK_MS: "12500",   // 落在挂后台之后：验"从托盘唤回窗口 + 跳会话"
  });
  if (!A) {
    ok("Electron 实例能启动并把后端带起来", false, "60s 内 /api/health 没应答");
    console.log("\n\x1b[31mHAS FAIL\x1b[0m：" + pass + " 通过 / " + fail + " 失败");
    console.log("说明：本机当前环境无法启动 Electron（无桌面会话 / 沙箱限制），桌面层需要你在本机跑一次 npm run desktop 验收。");
    process.exit(1);
  }
  ok("A：实例启动、后端起来", true);
  ok("A：窗口真的显形（ready-to-show 一路跑到 show，没有被中途抛错打断）",
    await A.marker("[pc] 窗口已显形", 20000), A.out.slice(-700));
  ok("A：页面真的加载完成（did-finish-load）", await A.marker("[pc] 页面加载完成", 20000), A.out.slice(-500));
  /* 托盘图标：读不到图时主进程现在会大声记一行 error，成功也打一行心跳。
     3.2.x 的包里 `build.files` 白名单漏了 `assets/**`，托盘一直是个"点得到但看不见"的空图标，
     而日志里一个字都没有——用户看到的就是"托盘没图标"，排查全靠猜。 */
  ok("A：托盘图标真的读到了（缩到 16px 的非空图）", await A.marker("[pc] 托盘图标 ok", 15000), A.out.slice(-400));
  ok("A：没有「托盘图标读不到」的告警", !/托盘图标读不到/.test(A.out), A.out.slice(-400));
  const crashes = (A.out.match(/(unhandledRejection|uncaughtException)[^\n]*/g) || []).slice(0, 2);
  ok("A：主进程这一路没有未捕获的异步异常", crashes.length === 0, crashes.join(" | "));

  const reg = await post(8815, "/api/auth/register", { username: "_desk_" + Date.now(), password: "test1234" });
  const TOKEN = reg.json && reg.json.token;
  ok("A：沙箱内可注册验证用户（账号只落在沙箱数据根）", !!TOKEN, JSON.stringify(reg.json).slice(0, 140));

  /* 用 WS 派一个活：demo 引擎会跑一串工具，耗时足够跨过"关窗"这个时刻 */
  const WebSocket = require("ws");
  const conv = "c-desk-" + Date.now();
  /* 令牌走 Sec-WebSocket-Protocol，与真实前端同一个路径（C-B2）。
     这里原先挂的是 ?token=，只有 _sandbox 起的服务端会为了兼容老脚本临时收它，
     Electron 起的正式服务端直接 socket.destroy() —— 探针读出来就是 socket hang up。 */
  const ws = new WebSocket("ws://localhost:8815/", ["bearer." + encodeURIComponent(TOKEN)]);
  const events = [];
  ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); setTimeout(() => rej(new Error("WS 连接超时")), 10000); });
  ws.send(JSON.stringify({ type: "chat", text: "修复筛选 bug 并补测试", convId: conv }));

  const waitFor = async (pred, ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { const e = events.find(pred); if (e) return e; await wait(120); }
    return null;
  };

  section("A 任务在跑，窗口按探针设定被关掉");
  // 演示引擎的事件不带 convId（LLM 引擎才由 AsyncLocalStorage 统一注入），这里只按事件类型判，归属交给 /api/tasks 校
  const started = await waitFor((e) => e.type === "tool.start", 20000);
  ok("A：任务已开始（收到 tool.start）", !!started, started === null && "20s 内没有工具事件");

  const isMineRunning = (tasks) => tasks.some((x) => x.convId === conv && x.status === "running");
  let r = await get(8815, "/api/tasks", TOKEN);
  ok("A：关窗前 /api/tasks 能查到这条 running（这就是托盘那行的数据源）",
    isMineRunning((r.json && r.json.tasks) || []), JSON.stringify((r.json || {}).tasks || r.json).slice(0, 200));

  await wait(3500);                      // 越过 PANCODE_PROBE_CLOSE_MS=9000，确认关掉之后还活着
  ok("A：关窗后 Electron 进程仍然存活", A.alive() === true, A.out.slice(-300));
  /* 这两条是 #40/#41 的真验收：
     · 「在跑 N」必须真的出现过——以前主进程走 HTTP 轮 /api/tasks，那个端点在登录闸门后面，
       它手里没有 userToken，于是每 3 秒吃一次 401、rows 恒空，托盘状态行永远说没任务在跑，
       收口的系统通知也一次都没弹过。换成同进程读任务表之后，这一行才是有内容的。
     · 「已挂到后台」证明关窗判据走的是 hide 分支（渲染进程留着，任务流不断线）。 */
  ok("A：托盘状态行真的数到了在跑的任务", await A.marker(/（在跑 [1-9]\d*）/, 20000), A.out.slice(-400));
  ok("A：按偏好挂到后台（hide，不是销毁窗口）", await A.marker("[pc] 已挂到后台", 15000), A.out.slice(-400));
  ok("A：关窗后后端仍在应答 /api/health", await A.healthy());

  section("A 托盘菜单：分组装配 + 点一条真的跳会话");
  /* 原生托盘弹层 Playwright 点不到、截图拍不进（它在窗口之外），所以这里断言的是
     "那份菜单项被装配出来了"——分组标题、条目、底部动作项各是什么，一行日志全装了。
     单测 test/p3-longrun.test.js 管纯函数分组，这一行管真数据真的流进了真菜单。 */
  const dumped = await A.marker("[pc] 托盘菜单：", 15000);
  ok("A：托盘菜单被刷新过（有装配快照）", dumped, A.out.slice(-400));
  /* 每一轮轮询都可能改菜单，所以要看的不是第一份快照而是"有没有出现过这一份"。
     快照按内容去重，任务从在跑到收口必然各出一条。 */
  const menuDumps = () => (A.out.match(/\[pc\] 托盘菜单：[^\n]*/g) || []);
  const anyMenu = (re) => menuDumps().some((l) => re.test(l));
  ok("A：有一版菜单里是「在跑」分组带着这条任务的标题", anyMenu(/在跑 1/) && anyMenu(/修复筛选 bug 并补测试/), menuDumps().slice(-2).join("\n").slice(0, 300));
  ok("A：菜单底部三条动作项都在（工作区 / 诊断 / 退出）",
    anyMenu(/打开工作区文件夹/) && anyMenu(/复制诊断信息/) && anyMenu(/退出 pancode（终止所有任务）/), menuDumps().slice(-1)[0] || "");
  /* 第一项必须是状态行本身（"pancode 后端运行中…" 或 "N 个任务…"）。
     以前这里写死 "pancode " 前缀，而单任务那支文案是「1 个任务进行中：…」不带前缀 —— 判据错了，不是产品错了。 */
  ok("A：状态行永远排在第一项，分隔符把分组隔开",
    menuDumps().length > 0 && menuDumps().every((l) => /^\[pc\] 托盘菜单：(pancode 后端运行中|\d+ 个任务)/.test(l)) && anyMenu(/\| — \|/), menuDumps().slice(-1)[0] || "");
  /* 点一条 = openConversation：探针直接调那个函数（鼠标点不到原生菜单），
     判据是它真的按 convId 唤回了窗口并把通道发出去。 */
  ok("A：模拟托盘点击命中这条在跑的任务", await A.marker("[pc] 探针模拟托盘点击 " + conv, 20000), A.out.slice(-300));
  ok("A：点击后走 openConversation（带页面就绪状态）",
    await A.marker(new RegExp("\\[pc\\] 托盘跳会话 " + conv + "（页面就绪="), 10000), A.out.slice(-300));
  /* 这一条才真正值钱：窗口此刻是挂后台藏着的，点击必须把它捞回可见态。
     以前 showWindow/createWindow 那条链坏过一次（ready-to-show 没挂上），
     只断"日志里有这一行"是测不出没显形的。 */
  ok("A：挂后台的窗口被托盘点击唤回成可见", await A.marker("[pc] 唤回窗口后可见=true", 10000), A.out.slice(-400));

  section("A 没有窗口，任务照常跑到收口");
  const done = await waitFor((e) => e.type === "agent.done", 150000);
  ok("A：窗口关闭后仍收到 agent.done（Agent 没被关窗带走）", !!done, done === null && "150s 内没等到 agent.done");
  r = await get(8815, "/api/tasks", TOKEN);
  const rows = (r.json && r.json.tasks) || [];
  const mine = rows.find((x) => x.convId === conv) || {};
  ok("A：收口后任务表把这行标成 done", mine.status === "done", JSON.stringify(mine).slice(0, 200));
  ok("A：演示引擎确实改了盘（src/utils.js 里出现了它新增的 sortByPriority）",
    /sortByPriority/.test(fs.readFileSync(path.join(A.WS_DIR, "src", "utils.js"), "utf8")),
    fs.readFileSync(path.join(A.WS_DIR, "src", "utils.js"), "utf8").slice(0, 120));
  /* 收口后菜单必须换一组：这条要从「在跑」搬到「最近收口」。
     轮询在无任务时是 15 秒一次，所以这里给 25 秒。 */
  const settledMenu = await A.marker(/最近收口 [1-9]/, 25000);
  ok("A：收口后菜单里出现「最近收口」分组", settledMenu, (A.out.match(/\[pc\] 托盘菜单：[^\n]*/g) || []).slice(-1)[0] || "");

  section("A 退出钩子与托盘装配");
  ok("A：server/index.js 导出了 shutdown（electron before-quit 用它刷盘 + 杀子进程）",
    /module\.exports\s*=\s*\{\s*shutdown/.test(fs.readFileSync(path.join(ROOT, "server", "index.js"), "utf8")));
  /* 托盘建不出来时主进程会打这行并退回"关窗即退出"——那等于用户拍板的那条承诺失效，必须能被发现。
     图标到底长什么样、通知气泡弹没弹，只有人眼能验收，这一步请在桌面端亲眼确认一次。 */
  ok("A：托盘创建没有失败（日志里没有出现退回提示）", !/托盘创建失败/.test(A.out), A.out.slice(-300));
  ok("A：沙箱数据根里确实落了配置（userData 被搬进沙箱，没写进真实 %AppData%）",
    fs.existsSync(path.join(A.DATA_DIR, "pancode.config.json")), A.DATA_DIR);

  ws.close();
  try { A.child.kill(); } catch (e) {}
  await wait(500);

  /* ================= 实例 B：问一次，然后不再问 ================= */
  section("B 关窗偏好=问：答一次并勾「记住」，第二次不该再问");
  /* 这一节是补出来的。上一版把 remember 读成 res.checkboxValue（Electron 的字段叫 checkboxChecked），
     永远是 undefined → 勾了也不落盘 → 每次关窗都问一遍。判据 close-policy.js 有单测、一直是绿的，
     坏的是主进程读返回值那一行：集成点没有探针，就等于没修。
     原生模态框没人能自动化点选，所以这里用 PANCODE_PROBE_CLOSE_ANSWER 把答案喂进同一条处理路径。 */
  const B = await boot("b", 8816, {}, {          // 不写 desktop = 默认 ask
    PANCODE_PROBE_CLOSE_ANSWER: "0",             // 0 = 挂到后台（任务继续跑）
    PANCODE_PROBE_CLOSE_REMEMBER: "1",
    PANCODE_PROBE_CLOSE_MS: "9000,16000",        // 关两次：第一次问，第二次验"记住了"
  });
  if (!B) {
    ok("B：实例启动、后端起来", false, "60s 内 /api/health 没应答");
  } else {
    ok("B：实例启动、后端起来", true);
    ok("B：窗口显形并加载完成", await B.marker("[pc] 页面加载完成", 20000), B.out.slice(-400));
    ok("B：第一次关窗问了（走注入的同一条答复路径）",
      await B.marker("[pc] 探针注入关窗答案 0（记住=true）", 20000), B.out.slice(-400));
    ok("B：勾了记住 → 主进程确实写了偏好", await B.marker("[pc] 关窗选择已记住：background", 10000), B.out.slice(-400));
    /* 落盘是异步排队的（saveJson），所以这里轮文件而不是读一次 */
    let saved = "";
    for (let i = 0; i < 40 && saved !== "background"; i++) {
      try {
        saved = (JSON.parse(fs.readFileSync(path.join(B.DATA_DIR, "pancode.config.json"), "utf8")).desktop || {}).closeAction || "";
      } catch (e) { saved = ""; }
      if (saved !== "background") await wait(250);
    }
    ok("B：偏好真的写进了配置文件（desktop.closeAction=background）", saved === "background", "读到：" + saved);
    ok("B：第一次关窗按答复挂到后台", await B.marker("[pc] 已挂到后台", 10000), B.out.slice(-400));
    /* 判据的核心：第二次关窗时**问都没有再问**。
       注入那一行只在"还要问"的路径上打印，所以它的次数必须停在 1，
       而"已挂到后台"必须变成 2 —— 这两条一起才叫"记住我的选择"。 */
    await wait(9000);
    ok("B：第二次关窗没有再问（注入答复仍只出现 1 次）", B.count("[pc] 探针注入关窗答案") === 1,
      "出现 " + B.count("[pc] 探针注入关窗答案") + " 次");
    ok("B：第二次关窗直接照记住的办（挂后台累计 2 次）", B.count("[pc] 已挂到后台") >= 2,
      "出现 " + B.count("[pc] 已挂到后台") + " 次 · " + B.out.slice(-300));
    ok("B：两次关窗后进程仍然存活（挂后台不是退出）", B.alive() === true, B.out.slice(-200));
    const bcrash = (B.out.match(/(unhandledRejection|uncaughtException)[^\n]*/g) || []).slice(0, 2);
    ok("B：主进程没有未捕获异常", bcrash.length === 0, bcrash.join(" | "));
    try { B.child.kill(); } catch (e) {}
    await wait(500);
  }

  /* ================= 实例 C：直接退出 ================= */
  section("C 关窗偏好=直接退出：这一路必须真的把进程带走");
  /* 另一半极也验：托盘在、任务没跑、用户早就选了"直接退出"，这时绝不能因为
     "反正有托盘"而偷偷挂后台——那正是"看不见又关不掉"的来源。 */
  const C = await boot("c", 8817, { desktop: { closeAction: "quit" } }, { PANCODE_PROBE_CLOSE_MS: "9000" });
  if (!C) {
    ok("C：实例启动、后端起来", false, "60s 内 /api/health 没应答");
  } else {
    ok("C：实例启动、后端起来", true);
    await wait(6000);                              // 越过 9000 的关窗时刻
    ok("C：按选择直接退出（日志有这一行）", await C.marker("[pc] 按选择直接退出", 15000), C.out.slice(-400));
    let gone = false;
    for (let i = 0; i < 60; i++) { if (!C.alive()) { gone = true; break; } await wait(300); }
    ok("C：进程真的退了（没有留成后台幽灵）", gone, C.out.slice(-300));
    ok("C：退出后端口不再应答", !(await C.healthy()), "还答得上来就是没退干净");
    if (!gone) { try { C.child.kill(); } catch (e) {} }
  }

  console.log("\n" + (fail ? "\x1b[31mHAS FAIL\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "：" + pass + " 通过 / " + fail + " 失败");
  if (fail) {
    for (const f of fails) console.log("  - " + f);
    console.log("\n--- A 输出末尾 ---\n" + A.out.slice(-1200));
    if (typeof B !== "undefined" && B) console.log("\n--- B 输出末尾 ---\n" + B.out.slice(-1200));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error("\x1b[31mFAIL:\x1b[0m " + (e && e.stack || e)); process.exit(1); });
