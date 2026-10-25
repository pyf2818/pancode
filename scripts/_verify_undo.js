/* ============================================================
   P-H3 撤销（undo）界面入口 —— 端到端验收（真服务 + 真 ReAct 循环 + 真浏览器）
   引擎里早就有检查点机制，这次补的是"用户按得下去、按下去真的回得来"。所以每条都问磁盘：
     ① 只读工具不留"可撤销"的假象，写盘的那一步才给旗标（正负对照同批做）；
     ② 撤销不是"栈里少了一条"这种自证：新建的要真消失、改过的要真回到旧内容、
        批量编辑一次压的一个检查点要一次把三个文件全带回去；
     ③ 最近一步属于另一个会话时必须拒绝，并且拒绝之后盘上一个字节都没动；
     ④ 撤销栈挂在"这个用户的引擎"上：另一个用户来读必须是空的
        （读一份匿名实例 = 面板与 Agent 两套真相，这个坑本项目踩过不止一次）；
     ⑤ 聊天卡片上那颗「撤销这步」真点、真回滚、真把按钮交还给上一张卡。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({
  tag: "undo",
  wsFiles: {
    "undo-edit.txt": "第一版\n",
    "batch/a.txt": "A1\n",
    "batch/b.txt": "B1\n",
    "batch/c.txt": "C1\n",
  },
});

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.UNDO_PORT || 8831);
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
const read = (...p) => { try { return fs.readFileSync(path.join(WS_DIR, ...p), "utf8"); } catch (e) { return null; } };

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

/* ---------- 假网关：每一步都是真写盘，撤销才有东西可撤 ---------- */
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
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_u_" + scene + "_" + Date.now(), type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          rs.write("data: [DONE]\n\n"); rs.end();
        };
        if (alreadyRan) return endText("场景 " + scene + " 跑完");
        if (scene === "只读") return toolCall("read_file", { path: "undo-edit.txt" });
        if (scene === "新建") return toolCall("write_file", { path: "undo-new.txt", content: "新建的内容\n" });
        if (scene === "改文件") return toolCall("write_file", { path: "undo-edit.txt", content: "第二版\n" });
        if (scene === "批量") return toolCall("edit_files", { ops: [
          { path: "batch/a.txt", old_string: "A1", new_string: "A2" },
          { path: "batch/b.txt", old_string: "B1", new_string: "B2" },
          { path: "batch/c.txt", old_string: "C1", new_string: "C2" },
        ] });
        return endText("没有匹配的场景：" + scene);
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, base: "http://127.0.0.1:" + srv.address().port + "/v1" }));
  });
}

const TOKENS = {};
let TOKEN = "";
const agent = { ws: null, st: { events: [], waiters: [], responded: [], conv: "" } };

function attach(token) {
  return new Promise((resolve, reject) => {
    agent.ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(token)]);
    agent.st.events = []; agent.st.waiters = [];
    agent.ws.on("open", () => resolve());
    agent.ws.on("error", reject);
    agent.ws.on("message", (raw) => {
      let ev; try { ev = JSON.parse(raw.toString()); } catch (e) { return; }
      agent.st.events.push(ev);
      if (ev.type === "tool.pending") {
        agent.ws.send(JSON.stringify({ type: "tool.approve", id: ev.id }));
        agent.st.responded.push(ev.tool);
      }
      for (let i = agent.st.waiters.length - 1; i >= 0; i--) if (agent.st.waiters[i].match(ev)) { agent.st.waiters[i].resolve(ev); agent.st.waiters.splice(i, 1); }
    });
    setTimeout(() => reject(new Error("WS 连接超时")), 8000);
  });
}
function waitFor(match, ms) {
  return new Promise((resolve, reject) => {
    const hit = agent.st.events.find(match);
    if (hit) return resolve(hit);
    const t = setTimeout(() => reject(new Error("等事件超时 " + (ms || 8000) + "ms")), ms || 8000);
    agent.st.waiters.push({ match, resolve: (ev) => { clearTimeout(t); resolve(ev); } });
  });
}
async function runScene(scene, ms) {
  const conv = "un-" + scene + "-" + Date.now();
  const before = agent.st.events.length;
  agent.st.conv = conv;
  agent.ws.send(JSON.stringify({ type: "chat", text: "【场景" + scene + "】请按这个场景调用工具", convId: conv }));
  try { await waitFor((e) => e.type === "agent.done" && e.convId === conv && agent.st.events.indexOf(e) >= before, ms || 25000); }
  catch (e) { return { conv, evs: [] }; }
  await wait(250);
  return { conv, evs: agent.st.events.slice(before).filter((e) => e.convId === conv) };
}
const endsWith = (evs, re) => evs.filter((e) => e.type === "tool.end" && re.test(e.label || "") || (e.type === "tool.start" && re.test(e.name || "")));
const stack = async () => (await req("GET", "/api/undo", null, TOKEN)).json;
const doUndo = (convId, token) => req("POST", "/api/undo", { convId }, token || TOKEN);

(async () => {
  section("起沙箱服务（权限档 auto，写盘不再逐个问；删除仍会被不可逆守卫拦一次）");
  const gw = await startGateway();
  fs.writeFileSync(path.join(SANDBOX.dataDir, "pancode.config.json"), JSON.stringify({
    workspace: WS_DIR,
    llm: { baseURL: gw.base, apiKey: "sk-sandbox", model: "mock-un", contextWindow: 32000 },
    agentMode: "agent",
    permissions: { mode: "auto", allow: [], deny: [] },
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
  const reg = await req("POST", "/api/auth/register", { username: "_un_" + Date.now(), password: "test1234" });
  TOKEN = reg.json && reg.json.token;
  if (!TOKEN) { child.kill(); gw.srv.close(); throw new Error("注册失败：" + J(reg.json)); }
  const reg2 = await req("POST", "/api/auth/register", { username: "_un2_" + Date.now(), password: "test1234" });
  TOKENS.other = reg2.json && reg2.json.token;
  await attach(TOKEN);
  await waitFor((e) => e.type === "hello", 15000);

  try {
    section("① 接口本身");
    const anon = await req("GET", "/api/undo");
    ok("未登录读不到撤销栈（它能看出你改过哪些文件）", anon.status === 401, J(anon.json));
    const s0 = await stack();
    ok("刚起来时栈是空的（后面每一条断言都以此为基准，别在这里假绿）",
      s0.ok === true && Array.isArray(s0.steps) && s0.steps.length === 0, J(s0));

    section("② 只读不留痕，写盘才给旗标（正负对照同批做）");
    const rRead = await runScene("只读");
    ok("只读那一步真跑到了（正向对照：卡片出现了）",
      rRead.evs.some((e) => e.type === "tool.start" && /读取文件/.test(e.name || "")), J(rRead.evs.map((e) => e.type + ":" + (e.name || e.label || ""))));
    ok("只读的 tool.end 不带 undoable（否则用户会以为读文件也能撤）",
      !rRead.evs.some((e) => e.type === "tool.end" && e.undoable), J(rRead.evs.filter((e) => e.type === "tool.end")));
    ok("读完之后栈仍然是空的", (await stack()).steps.length === 0, J(await stack()));

    const rNew = await runScene("新建");
    ok("写盘那一步带上了 undoable（判据是撤销栈真的长了）",
      rNew.evs.some((e) => e.type === "tool.end" && e.undoable === true), J(rNew.evs.filter((e) => e.type === "tool.end")));
    ok("新建的文件真的在盘上", read("undo-new.txt") !== null, "");
    const s1 = await stack();
    const st1 = (s1.steps || [])[0] || {};
    ok("栈顶就是这一步，且说的是人话：路径 + 会怎么恢复",
      st1.label === "创建 undo-new.txt" || /undo-new\.txt/.test(String(st1.label)), J(st1));
    ok("新建的文件标成「删掉这个新建的文件」而不是「改回原样」",
      (st1.files || []).length === 1 && st1.files[0].path === "undo-new.txt" && /删掉/.test(st1.files[0].action), J(st1.files));
    ok("栈顶带着它属于哪个会话（跨会话保护靠这个字段）", !!st1.convId, J(st1));

    section("③ 撤销 = 盘上真回得去");
    const u1 = await doUndo(rNew.conv);
    ok("撤销成功并回报恢复了哪些文件",
      u1.json.ok === true && (u1.json.restored || []).join() === "undo-new.txt", J(u1.json));
    ok("新建的文件被真删掉了（不是只从栈里划掉）", read("undo-new.txt") === null, "");
    ok("撤完栈空了", (await stack()).steps.length === 0, J(await stack()));
    const u1again = await doUndo(rNew.conv);
    ok("再点一次说清「没有可撤销的了」而不是假装成功",
      u1again.json.ok === false && u1again.json.empty === true && /没有可撤销/.test(u1again.json.error || ""), J(u1again.json));

    const rEd = await runScene("改文件");
    ok("改过的文件盘上是新内容", read("undo-edit.txt") === "第二版\n", String(read("undo-edit.txt")));
    const s2 = await stack();
    ok("改动标成「改回原样」（它本来就存在）",
      /改回原样/.test(((s2.steps || [])[0].files || [])[0].action || ""), J((s2.steps || [])[0]));
    const u2 = await doUndo(rEd.conv);
    ok("撤销把旧内容原样写回去了", u2.json.ok === true && read("undo-edit.txt") === "第一版\n", String(read("undo-edit.txt")));

    await runScene("批量");
    ok("批量编辑把三个文件都改了", read("batch", "a.txt") === "A2\n" && read("batch", "c.txt") === "C2\n", "");
    const s3 = await stack();
    ok("三个文件是一次检查点（一次撤销全带回，不是撤一次只回一个）",
      (s3.steps || []).length === 1 && ((s3.steps[0] || {}).files || []).length === 3, J(s3.steps));
    const u3 = await doUndo();
    ok("一次撤销带回三个文件",
      u3.json.ok === true && read("batch", "a.txt") === "A1\n" && read("batch", "b.txt") === "B1\n" && read("batch", "c.txt") === "C1\n", J(u3.json));

    section("④ 跨会话保护：最近一步是别人的会话就不撤");
    const rA = await runScene("改文件");
    ok("A 会话又改了一次（正向对照：盘上是第二版）", read("undo-edit.txt") === "第二版\n", "");
    const cross = await doUndo("some-other-conversation-id");
    ok("用另一个会话的身份请求会被拒绝并说明原因",
      cross.json.ok === false && cross.json.cross === true && /另一个会话/.test(cross.json.error || ""), J(cross.json));
    ok("被拒之后盘上一个字节都没动", read("undo-edit.txt") === "第二版\n", String(read("undo-edit.txt")));
    const okBack = await doUndo(rA.conv);
    ok("换回这一步真正所属的会话就撤销成功", okBack.json.ok === true && read("undo-edit.txt") === "第一版\n", J(okBack.json));

    section("⑤ 撤销栈按用户分开（不是全机一份）");
    await runScene("改文件");
    const own = await stack();
    const other = await req("GET", "/api/undo", null, TOKENS.other);
    ok("自己看得到刚才那一步", (own.steps || []).length === 1, J(own));
    ok("另一个用户读到的是空栈（读错实例就等于面板与 Agent 两套真相）",
      other.json.ok === true && (other.json.steps || []).length === 0, J(other.json));
    const otherUndo = await doUndo(rA.conv, TOKENS.other);
    ok("另一个用户也撤不动这一步", otherUndo.json.ok === false, J(otherUndo.json));
    ok("拒绝之后盘上仍是第二版", read("undo-edit.txt") === "第二版\n", String(read("undo-edit.txt")));
    await doUndo();

    section("⑥ 浏览器：卡片上那颗撤销按钮");
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
    await page.waitForFunction(() => !!document.getElementById("chatInput"), null, { timeout: 15000 });
    await wait(1500);
    const ask = async (scene) => {
      await page.locator("#chatInput").fill("【场景" + scene + "】请按这个场景调用工具");
      await page.keyboard.press("Enter");
      await wait(2600);
    };
    await ask("只读");
    await ask("新建");
    const cards = page.locator(".tool-card", { hasText: "创建文件" });
    ok("写盘那张卡上出现了撤销按钮", (await cards.locator(".t-undo").count()) >= 1, "卡数=" + (await cards.count()));
    ok("只读那张卡上没有按钮（否则用户会以为读文件也要撤）",
      (await page.locator(".tool-card", { hasText: "读取文件" }).locator(".t-undo").count()) === 0);
    ok("整屏只有一颗可点的撤销按钮（撤销是后进先出的）",
      (await page.locator(".t-undo").count()) === 1, "按钮数=" + (await page.locator(".t-undo").count()));
    /* 视觉层：功能断言全绿不等于看得见。行尾要挤下 轮次/耗时/结果/按钮 四样，
       任何一样溢出卡片那一行，用户读到的就是被切半的字——所以逐量测宽，不靠肉眼。 */
    const fitOf = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return { sel: s, found: false };
      const head = el.closest(".tool-head");
      const panel = document.getElementById("chatPanel");
      const r = el.getBoundingClientRect(), h = head.getBoundingClientRect(), p = panel.getBoundingClientRect();
      return { sel: s, found: true, w: Math.round(r.width), txt: el.textContent.trim(),
        headOverflow: head.scrollWidth - head.clientWidth,
        outOfPanel: Math.round(r.right - p.right),
        selfClip: el.scrollWidth - Math.floor(r.width) };
    }, sel);
    const say = (tag, f) => tag + " " + J(f);
    const fit = await fitOf(".tool-card .t-undo");
    ok("撤销按钮完整可见（没溢出卡片那一行、没被面板右边缘切掉）",
      fit.found && fit.outOfPanel <= 0 && fit.selfClip <= 0 && fit.w >= 20, say("", fit));
    ok("卡片那一行挤得下（轮次/耗时/结果/按钮不横向溢出）", fit.headOverflow <= 1, say("溢出=", fit.headOverflow) + " " + J(fit));
    /* 正向对照：把面板压窄，这两条判据必须变红——否则它们只是恒真的空断言。 */
    const ctrl = await page.evaluate(() => {
      const el = document.getElementById("chatPanel");
      const old = el.style.width;
      el.style.width = "240px";
      const btn = document.querySelector(".tool-card .t-undo");
      const head = btn.closest(".tool-head");
      const r = { overflow: head.scrollWidth - head.clientWidth, panel: Math.round(btn.getBoundingClientRect().right - el.getBoundingClientRect().right) };
      el.style.width = old;
      return r;
    });
    ok("正向对照：面板压窄后确实测得出溢出", ctrl.overflow > 1 || ctrl.panel > 0, J(ctrl));
    await page.screenshot({ path: path.join(ROOT, "scripts", "_verify_out", "undo_card.png") });

    await page.locator(".t-undo").first().click();
    await wait(1400);
    ok("点之前先问了一句会恢复哪些文件", dialogs.some((m) => /撤销/.test(m) && /undo-new\.txt/.test(m)), J(dialogs));
    ok("点下去之后文件真的没了", read("undo-new.txt") === null, "");
    ok("卡片留下「已撤销」痕迹且按钮摘掉（不是原地消失让人以为没点上）",
      (await page.locator(".tool-card.undone").count()) === 1 && (await page.locator(".t-undo").count()) === 0,
      "undone=" + (await page.locator(".tool-card.undone").count()));
    const tf = await fitOf(".tool-card.undone .t-undone");
    ok("「已撤销」痕迹同样挤在这一行里（换字不换出溢出）",
      tf.found && tf.outOfPanel <= 0 && tf.selfClip <= 0 && tf.headOverflow <= 1, J(tf));
    await page.screenshot({ path: path.join(ROOT, "scripts", "_verify_out", "undo_after.png") });

    await ask("改文件");
    await ask("新建");
    /* 固定 2.6s 只够等"用户气泡出现"，任务收尾/按钮交还都可能晚到一点。
       这条探针盯的是"看得见才点得下去"，所以等到按钮真的可见再断言，别赌时序。 */
    await page.locator(".t-undo").first().waitFor({ state: "visible", timeout: 20000 });
    ok("连着两步之后仍然只有一颗按钮（在最新那张卡上）", (await page.locator(".t-undo").count()) === 1);
    await page.locator(".t-undo").first().click();
    await wait(1400);
    ok("撤掉最新一步之后，按钮自动交还给上一张卡", (await page.locator(".t-undo").count()) === 1,
      "按钮数=" + (await page.locator(".t-undo").count()));
    ok("最新那一步（新建）确实被撤了", read("undo-new.txt") === null, "");
    await page.locator(".t-undo").first().waitFor({ state: "visible", timeout: 20000 });
    await page.locator(".t-undo").first().click();
    await wait(1400);
    ok("再点一次回到上一步之前的内容（逐步回退）", read("undo-edit.txt") === "第一版\n", String(read("undo-edit.txt")));
    ok("两步都撤完之后不再摆着可点的按钮", (await page.locator(".t-undo").count()) === 0);

    const real = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|is sandboxed|allow-same-origin/i.test(e));
    ok("浏览器侧无 JS 报错", real.length === 0, real.slice(0, 3).join(" | "));
    section("⑦ 服务端侧的静默失败检查");
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
  console.log("\n[P-H3] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e && e.stack || e); process.exit(1); });
