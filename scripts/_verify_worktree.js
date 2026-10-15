/* ============================================================
   P-M1 git worktree 隔离 —— 端到端验收（真 git 仓库 + 真 ReAct 循环 + 真面板）
   "隔离"这两个字必须落在盘上，不然它就是界面上一句漂亮话。所以每条断言都去问磁盘：
     ① 开完副本，主检出的改动列表必须还是干净的（.git/info/exclude 没写进去就会永远挂一条
        "?? .worktrees/"，用户的改动面板从此多一条假改动，git_commit -A 还会把副本提交进仓库）；
     ② 在副本里写的文件，主检出里没有；在主检出写的，副本里没有；两边的 git 状态各自独立；
     ③ Agent 侧走真审批门：拒了就必须什么都没发生，批了才真建/真删；
     ④ 面板上"开一份 / 移除 / 切到这里"三个按钮真点、真变、真落盘，
        最后真把工作区切进副本（这才是"两份现实"的终点）。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({
  tag: "worktree",
  wsFiles: {
    "a.js": "export const a = 1;\n",
    "src/b.js": "export const b = 2;\n",
  },
});

const fs = require("fs");
const http = require("http");
const path = require("path");
const cp = require("child_process");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.WT_PORT || 8830);
const WS_DIR = SANDBOX.wsDir;
const HOME = path.join(SANDBOX.root, "home");
fs.mkdirSync(HOME, { recursive: true });

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 320); } catch (e) { return String(v).slice(0, 320); } };
const wsPath = (...p) => path.join(WS_DIR, ...p);
const exists = (...p) => fs.existsSync(wsPath(...p));
const g = (args) => cp.spawnSync("git", ["-C", WS_DIR].concat(args), { encoding: "utf8", windowsHide: true });

/* 工作区本身必须是个真仓库，否则整项功能无从谈起 */
(function gitInitWorkspace() {
  g(["init", "-q"]);
  g(["config", "user.email", "probe@pancode"]);
  g(["config", "user.name", "probe"]);
  g(["config", "core.autocrlf", "false"]);
  g(["add", "-A"]);
  const c = g(["commit", "-q", "-m", "init"]);
  if (c.status !== 0) throw new Error("沙箱 git 初始化失败：" + (c.stderr || c.stdout));
})();

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (token) headers["x-user-token"] = token;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 20000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, json: { raw: buf.slice(0, 200) } }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

/* ---------- 假网关：让真 Agent 去开副本 / 在副本里写文件 / 删副本 ---------- */
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
        let lastUserIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { lastUserIdx = i; break; }
        const alreadyRan = lastUserIdx >= 0 && msgs.slice(lastUserIdx + 1).some((m) => m.role === "tool");
        rs.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const send = (o) => rs.write("data: " + JSON.stringify(o) + "\n\n");
        const endText = (t) => {
          send({ choices: [{ index: 0, delta: { content: t } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          rs.write("data: [DONE]\n\n"); rs.end();
        };
        const toolCall = (name, args) => {
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_wt_" + scene + "_" + Date.now(), type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          rs.write("data: [DONE]\n\n"); rs.end();
        };
        if (alreadyRan) return endText("场景 " + scene + " 跑完");
        if (scene === "清单") return toolCall("git_worktree", { action: "list" });
        if (scene === "开副本") return toolCall("git_worktree", { action: "add", name: "agent-trial" });
        if (scene === "删副本") return toolCall("git_worktree", { action: "remove", name: "agent-trial" });
        if (scene === "强删副本") return toolCall("git_worktree", { action: "remove", name: "agent-trial", force: true });
        if (scene === "写副本") return toolCall("write_file", { path: ".worktrees/agent-trial/probe-only.txt", content: "这个文件只该出现在副本里\n" });
        if (scene === "写主区") return toolCall("write_file", { path: "main-only.txt", content: "这个文件只该出现在主检出里\n" });
        return endText("没有匹配的场景：" + scene);
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, base: "http://127.0.0.1:" + srv.address().port + "/v1" }));
  });
}

let TOKEN = "";
const agent = { ws: null, st: { events: [], waiters: [], responded: [], scene: "", conv: "", policy: "approve" } };

async function attach() {
  agent.ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(TOKEN)]);
  agent.st.events = []; agent.st.waiters = [];
  await new Promise((resolve, reject) => {
    agent.ws.on("open", resolve);
    agent.ws.on("error", reject);
    setTimeout(() => reject(new Error("WS 连接超时")), 8000);
  });
  agent.ws.on("message", (raw) => {
    let ev; try { ev = JSON.parse(raw.toString()); } catch (e) { return; }
    agent.st.events.push(ev);
    if (ev.type === "tool.pending" && ev.convId === agent.st.conv) {
      const act = agent.st.policy === "reject" ? "tool.reject" : "tool.approve";
      agent.ws.send(JSON.stringify({ type: act, id: ev.id }));
      agent.st.responded.push({ conv: ev.convId, tool: ev.tool, act });
    }
    for (let i = agent.st.waiters.length - 1; i >= 0; i--) if (agent.st.waiters[i].match(ev)) { agent.st.waiters[i].resolve(ev); agent.st.waiters.splice(i, 1); }
  });
  await waitFor((e) => e.type === "hello", 15000);
}
function waitFor(match, ms) {
  return new Promise((resolve, reject) => {
    const hit = agent.st.events.find(match);
    if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error("等事件超时 " + (ms || 8000) + "ms")), ms || 8000);
    agent.st.waiters.push({ match, resolve: (ev) => { clearTimeout(t); resolve(ev); } });
  });
}
async function runScene(scene, policy, ms) {
  const conv = "wt-" + scene + "-" + Date.now();
  const before = agent.st.events.length;
  agent.st.scene = scene; agent.st.conv = conv; agent.st.policy = policy || "approve";
  agent.ws.send(JSON.stringify({ type: "chat", text: "【场景" + scene + "】请按这个场景调用工具", convId: conv }));
  try { await waitFor((e) => e.type === "agent.done" && e.convId === conv && agent.st.events.indexOf(e) >= before, ms || 25000); }
  catch (e) { return { conv, evs: [] }; }
  await wait(250);
  return { conv, evs: agent.st.events.slice(before).filter((e) => e.convId === conv) };
}
const bodies = (evs) => evs.filter((e) => e.type === "tool.body").map((e) => e.text || "").join("\n");
const wt = async () => (await req("GET", "/api/git/worktrees", null, TOKEN)).json;

(async () => {
  section("起沙箱服务（工作区是一个真 git 仓库，权限档 ask）");
  const gw = await startGateway();
  fs.writeFileSync(path.join(SANDBOX.dataDir, "pancode.config.json"), JSON.stringify({
    workspace: WS_DIR,
    llm: { baseURL: gw.base, apiKey: "sk-sandbox", model: "mock-wt", contextWindow: 32000 },
    agentMode: "agent",
    permissions: { mode: "ask", allow: [], deny: [] },
  }, null, 2), "utf8");
  let out = "";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT, env: SANDBOX.env({ PORT: String(PORT), NODE_NO_WARNINGS: "1", AGENT_FAST: "1", HOME, USERPROFILE: HOME }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => { out = (out + c).slice(-40000); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-40000); });
  let up = false;
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const h = await req("GET", "/api/health"); if (h.json && h.json.ok) { up = true; break; } } catch (e) {}
  }
  if (!up) { child.kill(); gw.srv.close(); throw new Error("服务未就绪\n" + out.slice(-1500)); }
  const reg = await req("POST", "/api/auth/register", { username: "_wt_" + Date.now(), password: "test1234" });
  TOKEN = reg.json && reg.json.token;
  if (!TOKEN) { child.kill(); gw.srv.close(); throw new Error("注册失败：" + J(reg.json)); }
  await attach();

  try {
    section("① REST：清单、开、脏保护、删");
    const anon = await req("GET", "/api/git/worktrees");
    ok("未登录读不到副本清单（它会暴露仓库结构）", anon.status === 401, J(anon.json));
    const w0 = await wt();
    ok("接口认得出这是个 Git 仓库", w0.ok === true && w0.available === true, J(w0));
    ok("一开始只有主检出，且它同时是「当前工作区所在」",
      (w0.worktrees || []).length === 1 && w0.worktrees[0].main === true && w0.worktrees[0].current === true, J(w0.worktrees));

    const add = await req("POST", "/api/git/worktree", { name: "try-x" }, TOKEN);
    ok("开副本成功并给出绝对路径", add.json.ok === true && fs.existsSync(String(add.json.path || "")), J(add.json));
    ok("副本里是一份真检出（不是空目录）", exists(".worktrees", "try-x", "a.js") && exists(".worktrees", "try-x", "src", "b.js"), "");
    ok("同名分支真的建出来了", g(["rev-parse", "--verify", "refs/heads/try-x"]).status === 0, "");
    const st1 = await req("GET", "/api/git/status", null, TOKEN);
    ok("主检出的改动列表里没有 .worktrees（排除表没写进去就会多一条假改动）",
      !(st1.json.changes || []).some((c) => /\.worktrees/.test(c.path)), J(st1.json.changes));
    const w1 = await wt();
    ok("清单里两份检出，各自的分支分得清",
      (w1.worktrees || []).length === 2 && w1.worktrees.some((x) => x.branch === "master" && x.main)
      && w1.worktrees.some((x) => x.branch === "try-x" && !x.main && !x.current), J((w1.worktrees || []).map((x) => x.branch)));

    const bad = await req("POST", "/api/git/worktree", { name: "../evil" }, TOKEN);
    ok("非法副本名被拒（这个名字会拼进路径交给 git）", bad.json.ok === false && /副本名/.test(bad.json.error || ""), J(bad.json));
    ok("非法副本名没有真的在仓库外面建目录", !fs.existsSync(path.join(WS_DIR, "..", "evil")), "");
    const dup = await req("POST", "/api/git/worktree", { name: "try-x" }, TOKEN);
    ok("同名副本再来一次被拒而不是覆盖", dup.json.ok === false && /已经存在/.test(dup.json.error || ""), J(dup.json));
    const badbase = await req("POST", "/api/git/worktree", { name: "from-old", base: "HEAD~3" }, TOKEN);
    ok("基线不存在时回的是 git 的人话而不是 500",
      badbase.json.ok === false && badbase.status === 200 && /invalid reference|unknown revision|not a valid/i.test(String(badbase.json.error || "")), J(badbase.json));

    const rmMain = await req("DELETE", "/api/git/worktree", { path: WS_DIR }, TOKEN);
    ok("删主检出这条路是堵死的", rmMain.json.ok === false && /只允许移除/.test(rmMain.json.error || ""), J(rmMain.json));
    ok("拒绝就是真拒绝，主检出还在盘上", exists("a.js"), "");

    fs.writeFileSync(wsPath(".worktrees", "try-x", "wip.txt"), "还没提交\n", "utf8");
    const dirty = await req("DELETE", "/api/git/worktree", { name: "try-x" }, TOKEN);
    ok("副本里有未提交东西时默认拒删，并回 dirty 让上层再问一句",
      dirty.json.ok === false && dirty.json.dirty === true, J(dirty.json));
    ok("被拒之后副本还在（没有先删再报错）", exists(".worktrees", "try-x", "wip.txt"), "");
    const forced = await req("DELETE", "/api/git/worktree", { name: "try-x", force: true }, TOKEN);
    ok("带 force 才真删，且不留 .worktrees 空壳",
      forced.json.ok === true && !exists(".worktrees", "try-x") && !exists(".worktrees"), J(forced.json));
    ok("删完清单回到一份检出", ((await wt()).worktrees || []).length === 1, J((await wt()).worktrees));

    section("② Agent：真审批门 + 真隔离");
    const r0 = await runScene("清单");
    ok("git_worktree 工具真跑到了（正向对照：那张卡出现了）",
      r0.evs.some((e) => e.type === "tool.start" && /副本清单/.test(e.name || "")), J(r0.evs.map((e) => e.type + ":" + (e.name || e.label || ""))));
    ok("list 是纯读：一个审批卡都没弹（否则会白问用户一次）",
      !agent.st.responded.some((x) => x.conv === r0.conv), J(agent.st.responded.slice(-3)));
    ok("回执里报得出分支与路径", /master/.test(bodies(r0.evs)) && /worktree|检出|主检出/.test(bodies(r0.evs)), bodies(r0.evs).slice(0, 160));

    const r1 = await runScene("开副本");
    ok("开副本弹出了审批卡（mutating 该问就问）",
      agent.st.responded.some((x) => x.conv === r1.conv && x.act === "tool.approve"), J(agent.st.responded.slice(-3)));
    ok("批准之后副本真在盘上", exists(".worktrees", "agent-trial", "a.js"), "");
    ok("分支也真建出来了", g(["rev-parse", "--verify", "refs/heads/agent-trial"]).status === 0, "");

    await runScene("写副本");
    ok("Agent 能在副本里写文件（路径就在仓库内，不需要另开授权）",
      exists(".worktrees", "agent-trial", "probe-only.txt"), "");
    ok("主检出根下没有这个文件（副本写的东西不会漏到用户手上那份）", !exists("probe-only.txt"), "");
    const st2 = await req("GET", "/api/git/status", null, TOKEN);
    ok("副本里的新文件不进主检出的改动列表",
      !(st2.json.changes || []).some((c) => /probe-only/.test(c.path)), J(st2.json.changes));
    await runScene("写主区");
    ok("反向也成立：主检出的文件不会出现在副本里", exists("main-only.txt") && !exists(".worktrees", "agent-trial", "main-only.txt"), "");

    agent.st.policy = "reject";
    const r2 = await runScene("删副本", "reject");
    ok("删副本同样要过门（它连副本里未提交的改动一起删）",
      agent.st.responded.some((x) => x.conv === r2.conv && x.act === "tool.reject"), J(agent.st.responded.slice(-3)));
    ok("用户拒绝之后副本还在（决策与副作用一致）", exists(".worktrees", "agent-trial", "a.js"), "");
    const r3 = await runScene("删副本", "approve");
    /* 第二层保护：上面那个场景已经在副本里写过文件，所以即使用户批了，
       git 那一层也要把它挡住，并把"要 force 才能连未提交的一起删"说回给模型。 */
    ok("批了但副本里有未提交文件时仍然挡住，并把要 force 这件事讲清楚",
      exists(".worktrees", "agent-trial", "a.js") && /force/i.test(bodies(r3.evs)), bodies(r3.evs).slice(0, 200));
    const r4 = await runScene("强删副本", "approve");
    ok("补上 force 才真删掉", !exists(".worktrees", "agent-trial") && ((await wt()).worktrees || []).length === 1,
      J((await wt()).worktrees));
    void r4;

    section("③ 面板：设置 · 通用 · 独立工作副本");
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    const dialogs = [];
    page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
    await page.addInitScript((t) => {
      try {
        localStorage.setItem("cw-user-token", t);
        localStorage.setItem("cw-theme", "dark");
        localStorage.setItem("cw-palette", "graphite");
        localStorage.setItem("cw-onboarded", "1");
      } catch (e) {}
    }, TOKEN);
    await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.openWorkbench === "function", null, { timeout: 15000 });
    await page.evaluate(() => window.openWorkbench("general"));
    await page.waitForSelector(".wb-wt-host .wb-group", { timeout: 8000 }).catch(() => {});
    await wait(500);
    const grp = page.locator(".wb-wt-host .wb-group");
    ok("Git 仓库的工作区里这一组出现了", (await grp.count()) === 1, "组数=" + (await grp.count()));
    ok("还没有副本时给的是引导空态而不是一片空白", /还没有副本/.test(await grp.innerText()), (await grp.innerText()).replace(/\n/g, " / ").slice(0, 160));
    await grp.locator(".wb-input").first().fill("panel-trial");
    await grp.locator("button", { hasText: "开一份" }).click();
    await wait(2200);
    ok("面板点「开一份」真的建到盘上", exists(".worktrees", "panel-trial", "a.js"), "");
    const row = grp.locator(".wb-wt-item", { hasText: "panel-trial" });
    ok("副本出现在列表里，带分支名与完整路径（路径被截断也有 title 可看全）",
      (await row.count()) === 1 && /panel-trial/.test(await row.innerText())
      && (await row.locator(".wb-wt-path").first().getAttribute("title")) !== null, (await grp.innerText()).replace(/\n/g, " / ").slice(0, 200));
    ok("主检出那行标着「主检出」，副本那行给「切到这里」和「移除」",
      /主检出/.test(await grp.innerText()) && (await row.locator("button", { hasText: "切到这里" }).count()) === 1
      && (await row.locator("button", { hasText: "移除" }).count()) === 1);
    await page.screenshot({ path: path.join(ROOT, "scripts", "_verify_out", "worktree_panel.png") });

    await row.locator("button", { hasText: "移除" }).click();
    await wait(1800);
    ok("面板点「移除」走了确认，然后真删掉",
      dialogs.some((m) => /移除副本/.test(m)) && !exists(".worktrees", "panel-trial"), J(dialogs));
    ok("删完列表回到空态（不是留一行死数据）", /还没有副本/.test(await grp.innerText()), (await grp.innerText()).replace(/\n/g, " / ").slice(0, 160));

    /* 最后一步才是"两份现实"的终点：把工作区真切进副本。
       切完页面会重载，所以这条放在面板段的末尾。 */
    await grp.locator(".wb-input").first().fill("switch-me");
    await grp.locator("button", { hasText: "开一份" }).click();
    await wait(2200);
    await grp.locator(".wb-wt-item", { hasText: "switch-me" }).locator("button", { hasText: "切到这里" }).click();
    await wait(3000);
    const stWt = await req("GET", "/api/git/status", null, TOKEN);
    ok("「切到这里」把工作区换成了副本：状态栏那套接口报的是副本的分支",
      stWt.json.ok === true && stWt.json.branch === "switch-me", J({ branch: stWt.json.branch, changes: (stWt.json.changes || []).length }));
    const wWt = await wt();
    ok("清单里 current 落到了副本那行，主检出仍在",
      (wWt.worktrees || []).filter((x) => x.current).map((x) => x.branch).join() === "switch-me"
      && (wWt.worktrees || []).some((x) => x.main && x.branch === "master"), J((wWt.worktrees || []).map((x) => x.branch + (x.current ? ":current" : "") + (x.main ? ":main" : ""))));
    ok("切过去之后主检出根下没有副本里写的文件（两份现实真的分开）", !exists("probe-only.txt"), "");

    const real = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|is sandboxed|allow-same-origin/i.test(e));
    ok("浏览器侧无 JS 报错", real.length === 0, real.slice(0, 3).join(" | "));
    section("④ 服务端侧的静默失败检查");
    ok("整轮没有出现未捕获异常", !/UNCAUGHT|TypeError: |ReferenceError: /.test(out),
      (out.match(/.{0,160}(TypeError|ReferenceError|UNCAUGHT).{0,160}/) || [""])[0]);
    await browser.close();
  } catch (e) {
    ok("探针自身跑通（未中途抛错）", false, String(e && e.stack || e).slice(0, 400));
  } finally {
    try { agent.ws && agent.ws.close(); } catch (e) {}
    child.kill();
    gw.srv.close();
  }
  console.log("\n[P-M1] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e && e.stack || e); process.exit(1); });
