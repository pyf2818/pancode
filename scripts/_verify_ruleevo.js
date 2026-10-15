/* ============================================================
   P3-D3 自进化规则 —— 端到端验收（真服务 + 真 ReAct 循环 + 真浏览器 + 真重启）
   这条链子每一环都可能"看着在工作其实没工作"，所以全部按真实副作用验收：
     ① 证据要真的来自既有账本：记忆靠 POST /api/memory 落进去，
        拒绝与拦截靠假网关驱动真 Agent 走真权限门（不是往 JSONL 里手写两行）；
     ② 采纳要真的落成模型每轮读到的硬约束：磁盘上有 frontmatter、/api/rules 列得出、
        /api/rules/preview 里读得到这句——预览与注入同源，才算真的生效；
     ③ 忽略与采纳必须活得过进程重启（重启即失忆 = 每次开面板重催用户）；
     ④ 沉淀入口的老 bug 单独钉：同一条内容点两次不许在规则里出现两遍；
     ⑤ 进化面板那三个按钮（采纳 / 忽略 / 重新考虑）真点、真变、真落盘。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({
  tag: "ruleevo",
  wsFiles: {
    "README.md": "# 规则提案验收沙箱\n",
    "src/app.js": "export const app = 1;\n",
  },
  config: {
    agentMode: "agent",
    permissions: { mode: "ask", allow: [], deny: ["reevo-secret.txt"] },
  },
});

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.RLEEVO_PORT || 8829);
const WS_DIR = SANDBOX.wsDir;
const OUT = path.join(ROOT, "scripts", "_verify_out");
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
const countOf = (hay, needle) => String(hay).split(needle).length - 1;
function readWs(rel) { try { return fs.readFileSync(path.join(WS_DIR, rel), "utf8"); } catch (e) { return null; } }

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (token) headers["x-user-token"] = token;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 15000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, json: { raw: buf.slice(0, 200) } }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

/* ---------- 假网关：驱动真 Agent 调 write_file（一次被用户拒、一次撞拒绝规则） ---------- */
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
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_re_" + scene + "_" + Date.now(), type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
          send({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          rs.write("data: [DONE]\n\n"); rs.end();
        };
        if (alreadyRan) return endText("场景 " + scene + " 跑完");
        if (scene === "拒写") return toolCall("write_file", { path: "reevo-rejected.txt", content: "这条写盘应当被用户拒掉\n" });
        if (scene === "撞规则") return toolCall("write_file", { path: "reevo-secret.txt", content: "这条应当被拒绝规则拦下\n" });
        if (scene === "放行") return toolCall("write_file", { path: "reevo-ok.txt", content: "这条应当写下去\n" });
        return endText("没有匹配的场景：" + scene);
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, base: "http://127.0.0.1:" + srv.address().port + "/v1" }));
  });
}

/* 起服务：探针要自己重启一次，所以把"起 + 等就绪 + 注册"收成一个函数 */
async function boot(gwBase) {
  fs.writeFileSync(path.join(SANDBOX.dataDir, "pancode.config.json"), JSON.stringify({
    workspace: WS_DIR,
    llm: { baseURL: gwBase, apiKey: "sk-sandbox", model: "mock-re", contextWindow: 32000 },
    agentMode: "agent",
    permissions: { mode: "ask", allow: [], deny: ["reevo-secret.txt"] },
  }, null, 2), "utf8");
  let out = "";
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: SANDBOX.env({ PORT: String(PORT), NODE_NO_WARNINGS: "1", AGENT_FAST: "1", HOME, USERPROFILE: HOME }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => { out = (out + c).slice(-40000); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-40000); });
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const h = await req("GET", "/api/health"); if (h.json && h.json.ok) return { child, log: () => out }; } catch (e) {}
  }
  child.kill();
  throw new Error("服务未就绪\n" + out.slice(-1500));
}

/* 一次会话的驱动：审批卡一到就按场景策略回答（串行跑，模块级变量够用） */
function attachAgent() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", ["bearer." + encodeURIComponent(TOKEN)]);
    const st = { events: [], waiters: [], responded: [], scene: "", conv: "" };
    ws.on("message", (raw) => {
      let ev; try { ev = JSON.parse(raw.toString()); } catch (e) { return }
      st.events.push(ev);
      if (ev.type === "tool.pending" && ev.convId === st.conv) {
        const act = st.scene === "拒写" ? "tool.reject" : "tool.approve";
        ws.send(JSON.stringify({ type: act, id: ev.id }));
        st.responded.push({ conv: ev.convId, tool: ev.tool, act });
      }
      for (let i = st.waiters.length - 1; i >= 0; i--) if (st.waiters[i].match(ev)) { st.waiters[i].resolve(ev); st.waiters.splice(i, 1); }
    });
    ws.on("open", () => resolve({
      ws, st,
      send: (o) => ws.send(JSON.stringify(o)),
      waitFor: (match, ms) => new Promise((res2, rej2) => {
        const hit = st.events.find(match);
        if (hit) return res2(hit);
        const t = setTimeout(() => rej2(new Error("等事件超时 " + (ms || 8000) + "ms")), ms || 8000);
        st.waiters.push({ match, resolve: (ev) => { clearTimeout(t); res2(ev); } });
      }),
    }));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS 连接超时")), 8000);
  });
}

let TOKEN = "";

(async () => {
  section("起沙箱服务（权限档 ask + 一条拒绝规则 reevo-secret.txt）");
  const gw = await startGateway();
  let srv = await boot(gw.base);
  const reg = await req("POST", "/api/auth/register", { username: "_re_" + Date.now(), password: "test1234" });
  TOKEN = reg.json && reg.json.token;
  if (!TOKEN) { srv.child.kill(); gw.srv.close(); throw new Error("注册失败：" + J(reg.json)); }
  const agent = await attachAgent();
  await agent.waitFor((e) => e.type === "hello", 15000);

  async function runScene(scene, ms) {
    const conv = "re-" + scene + "-" + Date.now();
    const before = agent.st.events.length;
    agent.st.scene = scene; agent.st.conv = conv;
    agent.send({ type: "chat", text: "【场景" + scene + "】请按这个场景调用工具", convId: conv });
    try { await agent.waitFor((e) => e.type === "agent.done" && e.convId === conv && agent.st.events.indexOf(e) >= before, ms || 25000); } catch (e) { return { conv, evs: [] }; }
    await wait(250);
    return { conv, evs: agent.st.events.slice(before).filter((e) => e.convId === conv) };
  }
  const props = async () => (await req("GET", "/api/rule-proposals", null, TOKEN)).json;
  const findBy = (r, src) => (r.proposals || []).filter((p) => p.source === src);

  try {
    section("① 空账本不提案（还没有任何证据）");
    const p0 = await props();
    ok("提案接口通了", p0.ok === true, J(p0));
    ok("一开始待处理为 0（后面每加一条证据都要能对上，否则这里就是假绿起点）", (p0.counts || {}).pending === 0, J(p0.counts));
    const anon = await req("GET", "/api/rule-proposals");
    ok("未登录读不到提案（它能看出用户拒过什么，不是公开信息）", anon.status === 401, J(anon.json));

    section("② 记忆重复 → 提案；只有一条的不提案（正负对照同批做）");
    const mkMem = (type, topic, content) => req("POST", "/api/memory", { type, topic, content }, TOKEN);
    await mkMem("lesson", "验收主题甲", "跑探针之前必须先把数据根设进沙箱，否则会删掉真实对话记录。");
    await mkMem("error", "验收主题甲", "异步排队的落盘要等 flush 收口再去断言，立刻读文件会读到旧的。");
    await mkMem("lesson", "验收主题乙", "只出现一次的主题不该被升级成硬约束。");
    const p1 = await props();
    const memA = findBy(p1, "memory");
    ok("同主题两条教训长出一条提案（正向对照）",
      memA.some((x) => x.title === "验收主题甲" && x.count >= 2), J(memA.map((x) => x.title + ":" + x.count)));
    ok("单条主题没有被提案（负向对照，同一次扫描里做）", !memA.some((x) => x.title === "验收主题乙"), J(memA.map((x) => x.title)));
    const hitA = memA.find((x) => x.title === "验收主题甲") || {};
    ok("提案正文把两条教训都带上了（用户点采纳前先看到原话）",
      /沙箱/.test(hitA.statement || "") && /flush/.test(hitA.statement || ""), String(hitA.statement).slice(0, 160));

    section("③ 用户连拒两次 → 提案（真审批卡、真点拒绝）");
    const r1 = await runScene("拒写");
    ok("第一张审批卡真的弹出来并被拒（正向对照：没有卡就没有「用户拒绝」）",
      agent.st.responded.some((x) => x.conv === r1.conv && x.act === "tool.reject"), J(agent.st.responded));
    ok("拒绝之后没有落盘（决策与副作用一致）", readWs("reevo-rejected.txt") === null, "");
    await runScene("拒写");
    const p2 = await props();
    const rej = findBy(p2, "rejection");
    ok("同一个工具被拒两次 → 一条 rejection 提案",
      rej.some((x) => x.title === "write_file 需先征得同意" && x.count >= 2), J(rej.map((x) => x.title + ":" + x.count)));
    ok("措辞是让模型先问再做，不是禁止这个工具",
      /不要主动|先.*说清/.test((rej[0] || {}).statement || ""), String((rej[0] || {}).statement).slice(0, 160));

    section("④ 同一条拒绝规则被撞两次 → 提案");
    const r3 = await runScene("撞规则");
    ok("撞规则这一次根本没有审批卡（权限门直接拦）",
      !agent.st.responded.some((x) => x.conv === r3.conv), J(agent.st.responded.slice(-2)));
    ok("被拦下后没有落盘", readWs("reevo-secret.txt") === null, "");
    await runScene("撞规则");
    const p3 = await props();
    const deny = findBy(p3, "deny");
    ok("拒绝规则 reevo-secret.txt 攒出一条提案",
      deny.some((x) => /reevo-secret\.txt/.test(x.title) && x.count >= 2), J(deny.map((x) => x.title + ":" + x.count)));
    ok("待处理一共三条（记忆 / 拒绝 / 拦截），一条也没多、一条也没少",
      (p3.counts || {}).pending === 3, J(p3.counts));
    ok("扫描窗口把真决策链算进来了（不是探针自己塞的数据）",
      (p3.window || {}).decisions >= 4 && (p3.window || {}).memories >= 3, J(p3.window));

    section("⑤ 采纳 = 落成模型每轮读到的硬约束");
    const mem = (p3.proposals || []).find((x) => x.source === "memory");
    const ad = await req("POST", "/api/rule-proposals/" + encodeURIComponent(mem.id) + "/adopt", {}, TOKEN);
    ok("采纳成功并给出规则文件", ad.json.ok === true && /^\.pancode\/rules\/evolve-.+\.md$/.test(ad.json.file || ""), J(ad.json));
    const raw = readWs(ad.json.file.replace(/\//g, path.sep));
    ok("文件真在工作区磁盘上，且带 frontmatter", raw !== null && /^---\r?\ntitle: /.test(raw), String(raw).slice(0, 120));
    ok("正文就是面板上那句提案原话（不是另写一份摘要）", !!raw && /同类教训在「验收主题甲」/.test(raw), String(raw).slice(0, 160));
    const rl = await req("GET", "/api/rules", null, TOKEN);
    const rec = (rl.json.rules || []).find((x) => x.file === ad.json.file);
    ok("规则面板列得出这条，且状态是生效中", !!rec && rec.active === true && rec.enabled === true, J(rec));
    const pv = await req("GET", "/api/rules/preview", null, TOKEN);
    ok("生效预览里读得到这句（预览与注入同源 → 模型真的会读到）",
      /同类教训在「验收主题甲」/.test(pv.json.preview || ""), String(pv.json.preview || "").slice(0, 120));
    const ad2 = await req("POST", "/api/rule-proposals/" + encodeURIComponent(mem.id) + "/adopt", {}, TOKEN);
    ok("重复采纳不覆盖、不复制（already=true）",
      ad2.json.ok === true && ad2.json.already === true && ad2.json.file === ad.json.file, J(ad2.json));
    ok("采纳之后待处理少了一条、已采纳多了一条",
      (await props()).counts.pending === 2 && (await props()).counts.adopted === 1, J((await props()).counts));

    section("⑥ 忽略要按住，且必须活得过重启");
    const dn = (p3.proposals || []).find((x) => x.source === "deny");
    const dm = await req("POST", "/api/rule-proposals/" + encodeURIComponent(dn.id) + "/dismiss", {}, TOKEN);
    ok("忽略成功", dm.json.ok === true && dm.json.proposal.status === "dismissed", J(dm.json));
    const p4 = await props();
    ok("再扫一遍（证据仍在）也不会把已忽略的推回待处理",
      (p4.proposals || []).some((x) => x.id === dn.id && x.status === "dismissed") && p4.counts.pending === 1, J(p4.counts));

    section("⑦ 重启进程：提案账本与规则文件都在");
    agent.ws.close();
    srv.child.kill();
    await wait(2500);
    srv = await boot(gw.base);
    const reg2 = await req("POST", "/api/auth/register", { username: "_re2_" + Date.now(), password: "test1234" });
    TOKEN = reg2.json && reg2.json.token;
    if (!TOKEN) throw new Error("重启后注册失败：" + J(reg2.json));
    const p5 = await props();
    ok("重启后已忽略还是已忽略（不是每次开面板重催一遍）",
      (p5.proposals || []).some((x) => x.id === dn.id && x.status === "dismissed"), J((p5.proposals || []).map((x) => x.source + ":" + x.status)));
    ok("重启后已采纳还带着规则文件路径，且文件仍在",
      (p5.proposals || []).some((x) => x.status === "adopted" && x.ruleFileExists === true),
      J((p5.proposals || []).filter((x) => x.status === "adopted")));
    ok("重启后剩下的那条 rejection 仍待处理（证据没有因为重启被抹平）",
      p5.counts.pending === 1 && findBy(p5, "rejection").length === 1, J(p5.counts));

    section("⑧ 规则被人工删掉后，面板给的是「重新写入」而不是假的已生效");
    const adopted = (p5.proposals || []).find((x) => x.status === "adopted");
    await req("DELETE", "/api/rules", { file: adopted.ruleFile }, TOKEN);
    const p6 = await props();
    const afterDel = (p6.proposals || []).find((x) => x.id === adopted.id);
    ok("删掉规则文件后 ruleFileExists=false", afterDel.ruleFileExists === false, J(afterDel));
    const re = await req("POST", "/api/rule-proposals/" + encodeURIComponent(adopted.id) + "/adopt", {}, TOKEN);
    ok("重新采纳把文件写回来了", re.json.ok === true && readWs(re.json.file.replace(/\//g, path.sep)) !== null, J(re.json));

    section("⑨ 沉淀入口的老 bug：一条规则一个文件、重复沉淀不复制、可回滚");
    const sedBody = "沉淀进来的规则必须带 frontmatter，同一条内容不许出现两遍。";
    const s1 = await req("POST", "/api/sediment", { target: "rule", title: "验收沉淀标题", content: sedBody }, TOKEN);
    ok("沉淀为规则成功，文件名按标题而不是按日期",
      s1.json.ok === true && /\.pancode\/rules\/sediment-验收沉淀标题\.md$/.test(s1.json.file || ""), J(s1.json));
    const sraw = readWs(s1.json.file.replace(/\//g, path.sep));
    ok("沉淀产物带 frontmatter（旧写法整份没有头，单条关不掉）",
      /^---\r?\ntitle: 验收沉淀标题/.test(sraw || ""), String(sraw).slice(0, 120));
    const s2 = await req("POST", "/api/sediment", { target: "rule", title: "验收沉淀标题", content: sedBody }, TOKEN);
    ok("同样内容再沉淀一次报 unchanged，而不是往硬约束里追加第二遍",
      s2.json.ok === true && s2.json.unchanged === true, J(s2.json));
    ok("磁盘上那句话只出现一次（老写法这里是 2 遍）",
      countOf(readWs(s1.json.file.replace(/\//g, path.sep)) || "", "不许出现两遍") === 1,
      String(readWs(s1.json.file.replace(/\//g, path.sep))).slice(0, 200));
    const s3 = await req("POST", "/api/sediment", { target: "rule", title: "验收沉淀标题", content: "改了一版的沉淀内容，写之前要先留快照。" }, TOKEN);
    ok("同标题改内容算更新（不算第二条重复）", s3.json.ok === true && s3.json.unchanged !== true, J(s3.json));
    const his = await req("GET", "/api/rules/history?file=" + encodeURIComponent(s1.json.file), null, TOKEN);
    ok("这次更新进了规则历史，能回滚（与 P1-B5 同一套快照）",
      (his.json.versions || []).length >= 1, J(his.json));

    section("⑩ 浏览器：进化面板的「规则提案」");
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("dialog", (d) => d.accept());
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
    await page.evaluate(() => window.openWorkbench("evolution"));
    await wait(1800);
    ok("进化分区里出现「规则提案」组", (await page.locator(".wb-group-title", { hasText: "规则提案" }).count()) === 1);
    const group = page.locator(".wb-group", { has: page.locator(".wb-group-title", { hasText: "规则提案" }) }).first();
    /* 每一句都钉在"那一条提案的行"上：按钮文案（忽略）与页签文案（已忽略 1）互为子串，
       整组范围里找按钮会点到页签上——第一轮就是这么假失败的。 */
    /* 按标题那一行定位：拒绝规则那条的"证据行"里也写着 write_file，
       拿整行文本筛会同时命中两条（折叠起来的证据也算文本）。 */
    const rowOf = (t) => group.locator(".wb-rp-item").filter({ has: page.locator(".wb-rp-title", { hasText: t }) });
    const btnOf = (row, t) => row.locator("button", { hasText: new RegExp("^" + t + "$") });
    ok("待处理那条在界面上看得见，正文原话也摊开了",
      (await rowOf("需先征得同意").count()) === 1 && /不要主动/.test(await rowOf("需先征得同意").innerText()),
      (await group.innerText()).replace(/\n/g, " / ").slice(0, 200));
    ok("证据默认折叠，入口一直在（点一次才展开）",
      (await rowOf("需先征得同意").locator(".wb-rp-evidence").count()) === 1
      && !(await rowOf("需先征得同意").locator(".wb-rp-evidence").first().isVisible()));
    await rowOf("需先征得同意").locator(".wb-btn-sm", { hasText: "看证据" }).click();
    await wait(300);
    ok("展开后能看到「拒绝发生在什么时候、拒的是哪个对象」",
      await rowOf("需先征得同意").locator(".wb-rp-evidence").first().isVisible()
      && /reevo-rejected\.txt/.test(await rowOf("需先征得同意").innerText()),
      (await rowOf("需先征得同意").innerText()).replace(/\n/g, " / ").slice(0, 200));
    await page.screenshot({ path: path.join(OUT, "ruleevo_pending.png") });

    await btnOf(rowOf("需先征得同意"), "忽略").click();
    await wait(1600);
    ok("点忽略之后待处理清空（列表自己重画，不是等人刷新）",
      (await rowOf("需先征得同意").count()) === 0 && /现在没有够格的提案/.test(await group.innerText()),
      (await group.innerText()).replace(/\n/g, " / ").slice(0, 180));
    await group.locator(".wb-segment button", { hasText: "已忽略" }).click();
    await wait(600);
    ok("切到已忽略能看到刚忽略的那条，并给「重新考虑」入口",
      (await rowOf("需先征得同意").count()) === 1 && (await btnOf(rowOf("需先征得同意"), "重新考虑").count()) === 1);
    await btnOf(rowOf("需先征得同意"), "重新考虑").click();
    await wait(1600);
    ok("重新考虑把它放回待处理（忽略不是一删了之）",
      (await rowOf("需先征得同意").count()) === 0, (await group.innerText()).replace(/\n/g, " / ").slice(0, 180));
    await group.locator(".wb-segment button", { hasText: "待处理" }).click();
    await wait(600);
    ok("回到待处理就能看到它了", (await rowOf("需先征得同意").count()) === 1);

    const before = (await props()).counts;
    await btnOf(rowOf("需先征得同意"), "采纳为规则").click();
    await wait(1600);
    const afterAdopt = await props();
    ok("界面点采纳真的落到服务端（待处理 -1、已采纳 +1）",
      afterAdopt.counts.pending === before.pending - 1 && afterAdopt.counts.adopted === before.adopted + 1,
      J({ before: before, after: afterAdopt.counts }));
    const newFile = (afterAdopt.proposals.find((x) => x.status === "adopted" && /write_file/.test(x.title)) || {}).ruleFile || "";
    ok("采纳写下的规则文件在工作区磁盘上，正文是要注入的那句",
      !!newFile && /不要主动/.test(readWs(newFile.replace(/\//g, path.sep)) || ""), newFile);
    await group.locator(".wb-segment button", { hasText: "已采纳" }).click();
    await wait(600);
    ok("已采纳那批列出了规则文件路径与「规则已生效」标记",
      /\.pancode\/rules\/evolve-/.test(await group.innerText()) && /规则已生效/.test(await group.innerText()),
      (await group.innerText()).replace(/\n/g, " / ").slice(0, 220));
    await page.screenshot({ path: path.join(OUT, "ruleevo_adopted.png") });

    await page.evaluate(() => window.openWorkbench("rules"));
    await wait(1500);
    ok("采纳的规则同时出现在「规则」分区（两个面板一份真相）",
      /同类教训在「验收主题甲」|write_file 需先征得同意/.test(await page.locator("#wbBody").innerText()),
      (await page.locator("#wbBody").innerText()).replace(/\n/g, " / ").slice(0, 160));

    const real = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|is sandboxed|allow-same-origin/i.test(e));
    ok("浏览器侧无 JS 报错", real.length === 0, real.slice(0, 3).join(" | "));

    section("⑪ 服务端侧的静默失败检查");
    ok("整轮没有出现未捕获异常", !/UNCAUGHT|TypeError: |ReferenceError: /.test(srv.log()),
      (srv.log().match(/.{0,160}(TypeError|ReferenceError|UNCAUGHT).{0,160}/) || [""])[0]);
    await browser.close();
  } catch (e) {
    ok("探针自身跑通（未中途抛错）", false, String(e && e.stack || e).slice(0, 400));
  } finally {
    try { agent.ws.close(); } catch (e) {}
    try { srv.child.kill(); } catch (e) {}
    gw.srv.close();
  }
  console.log("\n[P3-D3] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e && e.stack || e); process.exit(1); });
