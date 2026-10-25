/* ============================================================
   浏览器自动化工具族的端到端验收（browser_* 全家）。

   测的是"真浏览器 + 真 handler"，不是读代码：
   进程内不起 LLM，直接拿一个桩 agent 调 server/tools/browser-tools.js 的 handler，
   让它去驱动真的 agent-browser 二进制开真的 Chromium。这是唯一能同时证明
   「CLI 参数拼装对」「ref 游标真的能用」「截图落在数据根而不是工作区」的观测点。

   为什么用本地 file:// 页面而不是真站点：探针不能依赖网络 ——
   一次断网就红，红的还不是我的代码。本地 fixture 还能把 ref 数量、按钮文案钉死。

   沙箱数据根：这条探针会真往 .pancode/shots 写截图，不隔离就是往开发者的真实数据根里丢东西。
   ============================================================ */
const path = require("path");
const fs = require("fs");

const sb = require("./_sandbox").create({ tag: "browser", ws: false });
const TMP = sb.root;

const ab = require("../server/computer/agent-browser");
const shots = require("../server/computer/shots");
const handlers = require("../server/tools/browser-tools");

/* ---------- 断言小工具（与其余探针同一风格：计数 + 失败项列出来） ---------- */
let pass = 0; let fail = 0; const fails = [];
function section(t) { console.log("\n\x1b[36m" + t + "\x1b[0m"); }
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name + (detail ? "  \x1b[90m" + detail + "\x1b[0m" : "")); }
  else { fail++; fails.push(name + (detail ? " —— " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? "  " + detail : "")); }
}

/* ---------- 本地 fixture：一个带表单/下拉/勾选框的页面 ---------- */
const PAGE = path.join(TMP, "fixture.html").replace(/\\/g, "/");
fs.writeFileSync(path.join(TMP, "fixture.html"), [
  "<!doctype html><meta charset='utf-8'><title>探针页面</title>",
  "<h1>账号设置</h1>",
  "<input id='q' placeholder='用户名'>",
  "<button id='go' onclick=\"document.getElementById('out').textContent='已提交：'+document.getElementById('q').value\">保存</button>",
  "<div id='out'></div>",
  "<select id='plan'><option value='free'>免费版</option><option value='pro'>专业版</option></select>",
  "<input type='checkbox' id='agree'>",
  "<label for='agree'>同意条款</label>",
].join(""));
const URL = "file:///" + PAGE.replace(/^[A-Za-z]:/, (m) => m.toLowerCase());

/* ---------- 桩 agent：捕获工具卡事件，审批一律给过 ---------- */
function mkAgent(convId, cfg) {
  const events = [];
  const a = {
    cfg: Object.assign({ computer: {} }, cfg || {}),
    _currentConv: convId,
    _convIdNow() { return this._currentConv; },   // 手搓 agent 需自带：tools 层已改走 agent._convIdNow() 取执行会话
    _gate: async () => ({ blocked: false, approved: true }),
    state() {},
    visionCalls: [],
    /* 真引擎的 offerVision 由单测钉；这里只钉"工具到底有没有调它、调的时候说了什么"。
       判 vision 开关这件事必须在桩上一比一复刻，否则测的就不是生产路径。 */
    offerVision(info) {
      a.visionCalls.push(info);
      return (a.cfg.llm && a.cfg.llm.vision === true)
        ? { ok: true, count: a.visionCalls.length }
        : { ok: false, why: "off" };
    },
    tool(kind, name, target) {
      const rec = { kind, name, target, body: "", doneLabel: "", ok: null, image: null };
      events.push(rec);
      return {
        body: (t) => { rec.body = String(t); },
        done: (o, label) => { rec.ok = o; rec.doneLabel = label; },
        image: (rel) => { rec.image = rel; },
        end() {}, start() {},
      };
    },
    events,
  };
  return a;
}

(async () => {
  if (!ab.resolveExe({})) {
    console.log("\x1b[31mSKIP：没有 agent-browser 二进制（npm install 没跑？）—— 这条探针必须装好再测，不接受「读代码通过」。\x1b[0m");
    sb.cleanup(); process.exit(1); return;
  }

  section("① 浏览器来源：探到本机 Chrome/Edge，不触发 150MB 下载");
  const st = ab.status({ computer: {} });
  ok("二进制可用", st.available, st.exe || st.reason);
  ok("探测到本机浏览器（不是留空让 agent-browser 去下载）", !!st.browser, st.browser || "(没探到)");
  ok("全局旗标带上了 --executable-path", ab.globalArgs({ computer: {} }).includes("--executable-path"));
  ok("会话名按 convId 派生且洗过字符", ab.sessionName("c:1/../x") === "pc-c_1___x".replace("c_1___x", "c1x") || /^pc-[A-Za-z0-9_]+$/.test(ab.sessionName("c:1/../x")), ab.sessionName("c:1/../x"));
  ok("两个不同会话得到不同 session（否则会互相抢同一个浏览器）",
    ab.sessionName("convA") !== ab.sessionName("convB"), ab.sessionName("convA") + " / " + ab.sessionName("convB"));

  const A = mkAgent("probeA");
  section("② 真开真读：open → snapshot 给出可用的 ref");
  let r = await handlers.browser_open(A, { url: URL });
  ok("open 回执里带回标题（模型靠它判断到哪了）", /探针页面/.test(r) && /file:\//.test(r), r.slice(0, 90));
  ok("open 提示了下一步要 snapshot", /browser_snapshot/.test(r));

  r = await handlers.browser_snapshot(A, {});
  /* 树里 ref 常和别的属性挤在同一对方括号内（[expanded=false, ref=e4]），
     所以按 "ref=eN" 取，不按 "[ref=eN]" 取 —— 后者会漏掉带属性的一半元素。 */
  const pickRef = (text, kw) => (text.match(new RegExp(kw + "[^\\n]*?ref=(e\\d+)")) || [])[1];
  const m = r.match(/ref=(e\d+)/g) || [];
  ok("快照给出 ref", m.length >= 5, m.length + " 个可交互元素");
  const btn = pickRef(r, "保存");
  const box = pickRef(r, "textbox");
  ok("认得出「保存」按钮的 ref", !!btn, btn || r.slice(0, 200));
  ok("认得出输入框的 ref", !!box, box || "");
  ok("快照没有把 refs 映射表一起塞给模型（省一半 token）", !/"role":\s*"button"/.test(r));
  /* 模型常见会把整段属性粘进 ref 参数（"expanded=false, ref=e4"），这里钉住容错 */
  r = await handlers.browser_click(A, { ref: "[expanded=false, ref=" + btn + "]" });
  ok("ref 参数能吃下整段 [.., ref=eN]（模型常整段粘贴）", /已点击/.test(r), r.slice(0, 90));

  section("③ 真填真点：fill → click → wait 条件 → read 结果");
  if (box) {
    r = await handlers.browser_fill(A, { ref: box, value: "anlan0725" });
    ok("fill 回执说清填了多少字符", /9 个字符/.test(r), r.slice(0, 80));
  }
  if (btn) {
    r = await handlers.browser_click(A, { ref: btn });
    ok("click 成功并提醒 ref 作废", /已点击/.test(r) && /先 browser_snapshot/.test(r), r.slice(0, 80));
    r = await handlers.browser_wait(A, { text: "已提交：anlan0725" });
    ok("wait 命中点击后的文本变化", /条件已满足/.test(r), r.slice(0, 120));
  } else ok("click 成功并提醒 ref 作废", false, "没有拿到按钮 ref，整段跳过");

  r = await handlers.browser_read(A, { ref: btn });
  ok("按 ref 取到那个元素的文本", /保存/.test(r), r.slice(0, 60));

  r = await handlers.browser_click(A, { ref: "e9999" });
  ok("坏 ref 回的是可读散文，不是抛异常", /浏览器操作失败/.test(r) && !/undefined/.test(r), r.slice(0, 100));
  r = await handlers.browser_click(A, { ref: "../../etc" });
  ok("非法 ref 被参数校验挡下（没把 ../ 拼进 CLI）", /参数不对/.test(r), r.slice(0, 90));

  section("③b 行为断言：点完之后 DOM 真的变成那样了吗（browser_assert 全链路）");
  /* 这一节是本轮新工具的验收场：前面 fill+click 已经把 #out 改成了「已提交：anlan0725」，
     于是"通过"与"失败"两侧都有确定答案，不需要靠读代码脑补。 */
  const cardB = A.events.length;
  r = await handlers.browser_assert(A, {
    asserts: [
      { kind: "text", sel: "#out", expected: "已提交：anlan0725", name: "提交回执文案" },
      { kind: "visible", sel: "#out" },
      { kind: "value", sel: "#q", expected: "anlan0725" },
      { kind: "count", sel: ".根本没有这种行", expected: 0 },
      { kind: "url", expected: "fixture.html", contains: true },
    ],
  });
  ok("五条全过时首行就说「全部通过」并给条数", /^断言全部通过：5 条/.test(r), r.split("\n")[0]);
  ok("失败为零时不复述实得值当噪音，但给出「验的是哪几条」的编号", /\[5\]/.test(r) && /URL|地址/.test(r), r.slice(0, 260));
  ok("工具卡标成功（界面据此显示绿），断言名带进回执", (A.events[cardB] || {}).ok === true && /提交回执文案/.test((A.events[cardB] || {}).body),
    JSON.stringify({ ok: (A.events[cardB] || {}).ok, label: (A.events[cardB] || {}).doneLabel }));

  const cardC = A.events.length;
  r = await handlers.browser_assert(A, {
    asserts: [
      { kind: "text", sel: "#out", expected: "已提交：anlan0725" },
      { kind: "text", sel: "#out", expected: "提交成功", name: "文案写法猜错的那条" },
      { kind: "visible", sel: "#不存在的选择器" },
    ],
  });
  ok("有任何一条失败时首行改口说「未全部通过」并给 1 通过 / 2 失败",
    /^断言未全部通过：1 通过 \/ 2 失败（共 3 条）/.test(r), r.split("\n")[0]);
  ok("失败条把实得值带回去（否则模型只能再截图猜）", /实得 已提交：anlan0725/.test(r), (r.match(/✗ \[2\].*/) || [""])[0]);
  ok("元素不存在时判失败并说清「没有这个元素」，不是默默算过", /没有这个元素/.test(r), (r.match(/✗ \[3\].*/) || [""])[0]);
  ok("有失败时工具卡标红", (A.events[cardC] || {}).ok === false);
  ok("教它下一步：不许把同一批再点一遍当验证", /别把同一批断言再点一遍|改代码还是改期望/.test(r), r.slice(-160));

  r = await handlers.browser_assert(A, { asserts: [{ kind: "text", sel: "#out" }] });
  ok("缺 expected 的清单一条都不执行（不给你拿什么比）", /一条都没执行/.test(r) && /缺 expected/.test(r), r.slice(0, 120));
  r = await handlers.browser_assert(A, { asserts: [] });
  ok("空清单直接要参数，不跑 eval", /需要 asserts 数组/.test(r), r.slice(0, 80));

  /* 注入面实测：把 JS 片段当选择器塞进去。它只能变成"查不到这个元素"，
     绝不能变成页面里真跑了一段代码 —— 这里用文档标题当哨兵，被改写了就说明逃逸成功。 */
  await handlers.browser_eval(A, { expression: "document.title='SENTINEL_OK'" });
  r = await handlers.browser_assert(A, { asserts: [{ kind: "text", sel: '");document.title="PWNED";//', expected: "x" }] });
  const titleNow = await handlers.browser_eval(A, { expression: "document.title" });
  ok("恶意选择器只导致查不到元素，没有改写页面", /没有这个元素/.test(r) && /SENTINEL_OK/.test(titleNow) && !/PWNED/.test(titleNow),
    r.split("\n").find((l) => l.startsWith("✗")) + " | 标题=" + titleNow.slice(0, 40));
  /* 哨兵要当场擦掉：⑥ 那条 "eval 取回页面数据" 判的是 document.title 里有没有「探针页面」，
     留着 SENTINEL_OK 走过去就是本次改动自己制造的假红（实测就是这样红过一次）。 */
  await handlers.browser_eval(A, { expression: "document.title='探针页面'" });

  section("④ 下拉与勾选：走 select，不是模拟点击坐标");
  r = await handlers.browser_snapshot(A, {});
  const sel = pickRef(r, "combobox");
  const chk = pickRef(r, "checkbox");
  if (sel) { r = await handlers.browser_select(A, { ref: sel, value: "专业版" }); ok("select 选中下拉项", /完成选择/.test(r), r.slice(0, 80)); }
  else ok("select 选中下拉项", false, "快照里没找到 combobox：" + r.slice(0, 150));
  if (chk) { r = await handlers.browser_select(A, { ref: chk, checked: true }); ok("check 勾上复选框", /完成选择/.test(r), r.slice(0, 80)); }
  else ok("check 勾上复选框", false, "快照里没找到 checkbox");

  section("⑤ 截图：落进数据根 shots，不进工作区，界面取得到");
  const cardBefore = A.events.length;
  r = await handlers.browser_screenshot(A, { name: "探针 截图 (1)" });
  const card = A.events[cardBefore];
  ok("回执说明图只有人看、模型不看像素", /只有你能看见/.test(r), r.slice(0, 90));
  ok("工具卡带上了 image 通道（前端据此显示）", !!card && !!card.image, card && card.image);
  const rel = card && card.image;
  ok("截图文件真的存在", !!rel && fs.existsSync(path.join(shots.root(), rel)));
  ok("截图落在数据根，不在工作区（不会污染 Git 改动列表）",
    !!rel && path.resolve(shots.root(), rel).startsWith(path.resolve(shots.root())), rel || "");
  ok("/api/shot 能解析这个相对路径", !!shots.resolveRel(rel), rel || "");
  ok("穿越路径被拒", shots.resolveRel("../../server/config.js") === null);
  ok("绝对路径被拒", shots.resolveRel("C:\\Windows\\win.ini") === null);

  section("⑤b for_model：像素只在显式要、且 vision 开着时才交给模型");
  /* 这一段顺带钉住 CLI 旗标名：--screenshot-format jpeg --screenshot-quality 80
     要是拼错了，CLI 会直接失败，回执就不是"已截图"——不许照想象中的 API 写参数。 */
  const V = mkAgent("probeVision", { llm: { vision: true } });
  await handlers.browser_open(V, { url: URL });
  const beforeV = V.visionCalls.length;
  r = await handlers.browser_screenshot(V, { for_model: true, name: "交模型", caption: "按钮排在哪里" });
  ok("for_model 且 vision 开：登记了一次像素", V.visionCalls.length === beforeV + 1, JSON.stringify(V.visionCalls.slice(-1)[0] || {}));
  ok("回执如实说明像素会随下一次请求交出去", /会随下一次请求交给你/.test(r), r.slice(0, 120));
  ok("回执教它别拿像素当坐标", /不要按像素坐标|仍用快照里的 ref/.test(r), r.slice(0, 120));
  const vRel = V.visionCalls[V.visionCalls.length - 1] && V.visionCalls[V.visionCalls.length - 1].rel;
  const vAbs = V.visionCalls[V.visionCalls.length - 1] && V.visionCalls[V.visionCalls.length - 1].abs;
  ok("喂模型的确实存成 jpeg（同样画面省一个量级的字节）",
    !!vRel && /\.jpeg$/.test(vRel) && fs.existsSync(vAbs) && fs.readFileSync(vAbs).slice(0, 3).toString("hex") === "ffd8ff",
    vRel + " · " + (vAbs && fs.existsSync(vAbs) ? fs.readFileSync(vAbs).slice(0, 3).toString("hex") : "文件不在"));
  ok("caption 随图一起登记（模型要知道这张该看什么）",
    (V.visionCalls[V.visionCalls.length - 1] || {}).caption === "按钮排在哪里");
  await handlers.browser_close(V);

  const NOVIS = mkAgent("probeNoVision", { llm: { vision: false } });
  await handlers.browser_open(NOVIS, { url: URL });
  r = await handlers.browser_screenshot(NOVIS, { for_model: true, name: "没开开关" });
  ok("vision 没开时照样登记一次，并如实回「只有用户看得见」",
    NOVIS.visionCalls.length === 1 && /llm\.vision/.test(r), r.slice(0, 120));
  ok("没喂成时绝不许说「已交给模型」", !/会随下一次请求交给你/.test(r), r.slice(0, 120));
  const nvRel = (NOVIS.visionCalls[0] || {}).rel;
  ok("没开开关时仍用 jpeg（字节已经省了，只是不给模型看）", /\.jpeg$/.test(nvRel || ""), nvRel || "");
  await handlers.browser_close(NOVIS);

  const beforeDefault = A.visionCalls.length;
  r = await handlers.browser_screenshot(A, { name: "默认" });
  ok("不带 for_model 时一次都不登记像素（不悄悄吃 token）", A.visionCalls.length === beforeDefault,
    "调用次数 " + A.visionCalls.length);
  ok("默认路径仍是 png 且说明模型不看像素", /\.png$/.test((A.events[A.events.length - 1] || {}).image || "") && /只有你能看见/.test(r),
    (A.events[A.events.length - 1] || {}).image);

  section("⑥ 逃生舱与标签页");
  r = await handlers.browser_eval(A, { expression: "document.title" });
  ok("eval 取回页面数据且标明是外部数据", /探针页面/.test(r) && /外部数据/.test(r), r.slice(0, 90));
  r = await handlers.browser_tabs(A, { action: "list" });
  ok("tabs list 回当前页", /fixture\.html/.test(r), r.slice(0, 90));
  r = await handlers.browser_tabs(A, { action: "nope" });
  ok("未知 action 直接说清支持哪些", /只支持 list/.test(r), r.slice(0, 70));
  r = await handlers.browser_tabs(A, { action: "switch" });
  ok("switch 缺 tab 时要求补，而不是切到 undefined", /必须给 tab/.test(r), r.slice(0, 70));

  section("⑦ 开关与未安装的降级（都是散文回执，不抛错）");
  const OFF = mkAgent("probeOff", { computer: { browser: false } });
  r = await handlers.browser_open(OFF, { url: "https://example.com" });
  ok("computer.browser=false 时明确告知已关闭", /已关闭/.test(r), r.slice(0, 90));
  const NONE = mkAgent("probeNone", { computer: { agentBrowserExe: "Z:\\不存在\\agent-browser.exe" } });
  /* 指了个不存在的显式路径时，应当退回随包二进制而不是报"没装" —— 这条钉住优先级语义 */
  r = await handlers.browser_snapshot(NONE, {});
  ok("坏路径不会让工具抛错", typeof r === "string" && r.length > 0, r.slice(0, 70));

  section("⑧ 收尾：只关本会话的浏览器");
  r = await handlers.browser_close(A);
  ok("close 回执说明产物不受影响", /已关闭/.test(r) && /shots/.test(r), r.slice(0, 90));
  const P = mkAgent("probeA");
  r = await handlers.browser_close(P);
  ok("另一个同名会话的 close 也能干净走完", typeof r === "string", r.slice(0, 60));

  console.log("\n\x1b[1m浏览器自动化验收：\x1b[0m " + pass + " 通过 / " + fail + " 失败");
  if (fails.length) console.log("\x1b[31m失败项：\x1b[0m\n  - " + fails.join("\n  - "));
  sb.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\x1b[31m探针异常：\x1b[0m" + e.stack);
  try { handlers.browser_close(mkAgent("probeA")); } catch (x) { /* 已经炸了，别在收尾再炸一次 */ }
  sb.cleanup();
  process.exit(1);
});
