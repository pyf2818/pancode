/* T3/T4 前端契约验证：起沙箱服务 + Playwright 真实加载 index.html，
 * 逐个打开工作台分区，断言「渲染出内容、无控制台报错、入口已改接」。
 * 产物：scripts/_verify_out/wb_<section>.png
 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

const PORT = 8815;
const ROOT = path.resolve(__dirname, "..");
const SB = path.join(ROOT, "scripts", "_verify_out", "wb-sandbox");
const DATA = path.join(SB, "data");
const WS = path.join(SB, "ws");
const OUT = path.join(ROOT, "scripts", "_verify_out");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (token) headers["x-user-token"] = token;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 15000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch (e) { resolve({ raw: buf.slice(0, 200) }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(WS, ".pancode", "rules"), { recursive: true });
  fs.mkdirSync(path.join(WS, ".pancode", "experts"), { recursive: true });
  fs.mkdirSync(path.join(WS, "server"), { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(WS, ".pancode", "rules", "style.md"),
    "---\ntitle: 中文汇报\nenabled: true\n---\n\n汇报一律中文并给可核对数字。\n");
  fs.writeFileSync(path.join(WS, ".pancode", "rules", "backend.md"),
    "---\ntitle: 后端约定\nglobs: [\"server/**\"]\n---\n\nserver 下只用 CommonJS。\n");
  fs.writeFileSync(path.join(WS, ".pancode", "experts", "发布专家.md"),
    "---\nname: 发布专家\ndescription: 只管构建与灰度\ntool_whitelist: [run_command, git_commit]\n---\n\n你是发布工程师。\n\n## 步骤\n1. 构建\n2. 灰度\n");
  fs.writeFileSync(path.join(WS, "AGENTS.md"), "# 仓库约定\n\n根级规则。\n");
  fs.writeFileSync(path.join(WS, "server", "index.js"), "module.exports = 1;\n");
}

async function boot() {
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), PANCODE_DATA_DIR: DATA, CURSORWEB_WORKSPACE: WS,
      CURSORWEB_ENGINE: "demo", AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  child.stdout.on("data", (c) => (tail = (tail + c).slice(-3000)));
  child.stderr.on("data", (c) => (tail = (tail + c).slice(-3000)));
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const h = await req("GET", "/api/health"); if (h.ok) return { child, tail }; } catch (e) {}
  }
  throw new Error("服务未就绪\n" + tail);
}

const SECTIONS = ["appearance", "general", "model", "agent", "perms", "mcp", "automations", "experts", "soul", "memory", "sediment", "rules", "skills", "evolution", "data", "audit", "about"];

async function main() {
  /* 静态防回归：新 UI 模块与既有脚本同为 classic script，顶层同名 function 会互相覆盖
     （真实踩过：assets-center 的 loadSkills 盖掉 app.js 的 loadSkills，侧栏技能列表静默失效） */
  section("全局符号冲突");
  const uiFiles = ["public/js/workbench.js", "public/js/assets-center.js"];
  const all = ["public/app.js", "public/store.js", "public/icons.js", "public/i18n.js"]
    .concat(fs.readdirSync(path.join(ROOT, "public/js")).filter((f) => f.endsWith(".js")).map((f) => "public/js/" + f))
    .filter((f) => !uiFiles.includes(f));
  const topNames = (p) => {
    const s = fs.readFileSync(path.join(ROOT, p), "utf8");
    const out = new Set();
    for (const m of s.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of s.matchAll(/^const ([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    for (const m of s.matchAll(/^let ([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
    return out;
  };
  const seen = new Map();
  for (const f of all) for (const n of topNames(f)) { if (!seen.has(n)) seen.set(n, f); }
  const clashes = [];
  for (const f of uiFiles) for (const n of topNames(f)) if (seen.has(n)) clashes.push(n + " (vs " + seen.get(n) + ")");
  ok("新模块未覆盖既有全局函数", clashes.length === 0, clashes.slice(0, 6).join(", "));

  seed();
  const { child, tail } = await boot();
  const reg = await req("POST", "/api/auth/register", { username: "_wb_" + Date.now(), password: "test1234" });
  const token = reg && reg.token;
  if (!token) { child.kill(); throw new Error("注册失败：" + JSON.stringify(reg)); }
  // 灌一点真实资产，让分区不是空壳
  await req("POST", "/api/memory", { type: "lesson", topic: "构建", content: "打包前要先跑一次冒烟。", valueScore: 5, sticky: true }, token);
  /* 再灌一条"被否过的做法"：记忆面板要同时有正文常驻与只在索引两类，
     只有一类的话徽章判据等于没判（另一种根本没出现，看不见就是"没渲染"而不是"渲染错了"）。 */
  await req("POST", "/api/memory", { type: "error", topic: "被拒操作/反例", content: "界面改动必须在真 Electron 里跑过探针才算完成。", valueScore: 5 }, token);
  await req("POST", "/api/skills", { name: "灰度发布", description: "分批放量", trigger: "灰度,发布", body: "1. 构建 2. 放量 10%" }, token);
  // 制造两条文件操作，让「行为审计」有真实内容可看
  const probe = await req("POST", "/api/rules", { title: "审计探针", content: "用于验证审计页有记录。" }, token);
  if (probe && probe.file) await req("DELETE", "/api/rules", { file: probe.file }, token);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  /* Playwright 默认把 confirm() 当"取消"处理，而删除/恢复都先问一句：
     不设这个处理器，界面点恢复永远是静默无反应，探针会误判成功。 */
  const dialogs = [];
  page.on("dialog", async (d) => { dialogs.push(d.message()); await d.accept(); });
  await page.addInitScript((t) => {
    // 预览 iframe 是 sandbox="allow-scripts"（无 allow-same-origin），读 localStorage 会抛，故 try 包一层
    try {
      localStorage.setItem("cw-user-token", t);
      localStorage.setItem("cw-theme", "dark");
      localStorage.setItem("cw-palette", "graphite");
      localStorage.setItem("cw-onboarded", "1");   // 沙箱是全新数据根，不放行新手引导会盖住所有入口
    } catch (e) {}
  }, token);

  try {
    section("加载与外壳");
    await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.openWorkbench === "function", null, { timeout: 15000 });
    await wait(1600);   // 给 app.js 的初始化与延迟绑定留出时间
    const loadErr = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|is sandboxed|allow-same-origin/i.test(e));
    ok("页面加载与初始化无 JS 报错", loadErr.length === 0, loadErr.slice(0, 3).join(" | "));
    ok("workbench.js 已加载并暴露 openWorkbench", true);
    ok("旧设置函数已被改接到工作台", await page.evaluate(() => typeof window.openSettings === "function" && typeof window.openSediment === "function"));
    const shell = await page.evaluate(() => ({
      palettes: typeof PALETTES !== "undefined" ? PALETTES.length : 0,
      sections: (typeof WB_SECTIONS !== "undefined" ? WB_SECTIONS : []).map((s) => s.id),
    }));
    ok("配色方案 ≥10 套已注入工作台", shell.palettes >= 10, "实际 " + shell.palettes);
    const missing = SECTIONS.filter((s) => !shell.sections.includes(s));
    ok("17 个分区全部注册", missing.length === 0, "缺：" + missing.join(","));

    await page.evaluate(() => window.openWorkbench("appearance"));
    await page.waitForSelector(".wb-panel", { timeout: 8000 });
    ok("工作台可打开", await page.isVisible("#workbench"));
    ok("遮罩 + 左导航渲染", await page.locator(".wb-nav-item").count() >= 17, "导航项 " + await page.locator(".wb-nav-item").count());

    section("逐分区渲染");
    const shots = {};
    for (const id of SECTIONS) {
      errors.length = 0;
      await page.evaluate((sid) => window.openWorkbench(sid), id);
      await wait(280);
      const info = await page.evaluate(() => {
        const b = document.getElementById("wbBody");
        return {
          text: (b.innerText || "").trim(),
          nodes: b.querySelectorAll("*").length,
          rows: b.querySelectorAll(".wb-row").length,
          groups: b.querySelectorAll(".wb-group").length,
          split: b.querySelectorAll(".wb-split").length,
          active: (document.querySelector(".wb-nav-item.active") || {}).textContent || "",
        };
      });
      const bad = info.nodes < 8 || info.text.length < 30;
      ok("分区 " + id + " 渲染出内容", !bad, "nodes=" + info.nodes + " text=" + info.text.length);
      ok("分区 " + id + " 导航高亮一致", info.active.includes(id === "appearance" ? "外观" : ""), info.active);
      const real = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|is sandboxed|allow-same-origin/i.test(e));
      ok("分区 " + id + " 无 JS 报错", real.length === 0, real.slice(0, 2).join(" | "));
      if (bad || real.length) console.log("      ↳ 文本：" + info.text.slice(0, 160).replace(/\n/g, " / "));
      shots[id] = info;
    }

    section("单价与用量（P1-B4）：设置里配价 → 界面出现金额口径");
    await page.evaluate(() => window.openWorkbench("model"));
    await wait(320);
    const p1 = await req("POST", "/api/config", { section: "agent", patch: { pricing: { enabled: true, currency: "CNY", rates: [{ match: "sandbox-model", input: 1, output: 2 }] } } }, token);
    ok("单价能保存并回读（1 条）", p1.ok === true && p1.agent && p1.agent.pricing && p1.agent.pricing.rates.length === 1,
      JSON.stringify((p1.agent || {}).pricing));
    await page.evaluate(() => window.openWorkbench("model"));
    await wait(500);
    const pg = await page.evaluate(() => {
      const g = [...document.querySelectorAll("#wbBody .wb-group")]
        .find((x) => /单价与用量/.test((x.querySelector(".wb-group-title") || {}).textContent || ""));
      return g ? { text: g.innerText, rows: g.querySelectorAll(".wb-list-item").length, inputs: g.querySelectorAll(".wb-mcp-form input").length } : null;
    });
    ok("模型分区渲染出「单价与用量」分组", !!pg, pg ? "" : "分组没找到");
    ok("已配置的单价列成行（不是只存在配置里）", pg && /sandbox-model/.test(pg.text) && pg.rows >= 1, pg && pg.rows);
    ok("配了价但账本还空：说「尚无用量」而不是「未配置单价」",
      pg && /尚无用量/.test(pg.text) && !/未配置单价/.test(pg.text), pg && pg.text.replace(/\n/g, " / ").slice(0, 110));
    ok("添加表单是三个框（匹配 / 输入价 / 输出价）", pg && pg.inputs === 3, pg && pg.inputs);
    // 界面上点「添加」要真的写进配置（不是只改了内存里的表）
    const grp = page.locator("#wbBody .wb-group", { hasText: "单价与用量" });
    await grp.locator(".wb-mcp-form input").nth(0).fill("glm-4-plus");
    await grp.locator(".wb-mcp-form input").nth(1).fill("2");
    await grp.locator(".wb-mcp-form input").nth(2).fill("6");
    await grp.locator(".wb-mcp-form button").click();
    await wait(700);
    const p2 = await req("GET", "/api/config", null, token);
    const rates2 = ((p2.agent || {}).pricing || {}).rates || [];
    ok("点「添加」后配置里真的是两条（界面写通了服务端）", rates2.length === 2 && rates2.some((r) => r.match === "glm-4-plus"), JSON.stringify(rates2));
    const bad = await req("POST", "/api/config", { section: "agent", patch: { pricing: { rates: [{ match: "ok", input: -5, output: 3 }, { match: "   ", input: 1 }] } } }, token);
    const rates3 = ((bad.agent || {}).pricing || {}).rates || [];
    ok("负数那一侧被丢、空 match 的整行被丢（不会算出 NaN 打在面板上）",
      rates3.length === 1 && rates3[0].match === "ok" && rates3[0].input === undefined, JSON.stringify(rates3));
    const p3 = await req("POST", "/api/config", { section: "agent", patch: { pricing: { rates: [{ match: "sandbox-model", input: 1, output: 2 }] } } }, token);
    ok("坏输入没有把原表带歪（清洗后仍能存回一条正常的）", ((p3.agent || {}).pricing || {}).rates.length === 1);
    await page.screenshot({ path: path.join(OUT, "wb_pricing.png") }).catch(() => {});

    section("视觉开关（llm.vision）：界面上点得动、服务端存得住、翻牌与配置同步");
    await page.evaluate(() => window.openWorkbench("model"));
    await wait(180);
    /* 这条是本轮新加的那一行。判据不能停在"页面上看得到这行字"——
       它必须证明点一下真的改了配置（截图工具的回执会据此说"开关没开"，说错就误导模型）。 */
    /* 注意：这里必须把**函数本体**交给 page.evaluate / waitForFunction。
       传"字符串形式的箭头函数"时 Playwright 会把它当表达式求值，得到的是函数对象本身，
       不可序列化 → resolve 成 undefined，判据永远假红（本轮就是这么绕了一圈）。 */
    const findVision = () => {
      const r = [...document.querySelectorAll("#wbBody .wb-row")]
        .find((x) => ((x.querySelector(".wb-row-name") || {}).textContent || "").includes("看截图像素"));
      if (!r) return null;
      const sw = r.querySelector(".wb-switch");
      if (!sw) return null;
      return { aria: sw.getAttribute("aria-checked"), hasKnob: !!sw.querySelector(".wb-knob") };
    };
    const clickVision = () => {
      const r = [...document.querySelectorAll("#wbBody .wb-row")]
        .find((x) => ((x.querySelector(".wb-row-name") || {}).textContent || "").includes("看截图像素"));
      if (r) r.querySelector(".wb-switch").click();
      return !!r;
    };
    /* wbRenderModel 是 async（要等 /api/llm/profiles 回来才画），固定 sleep 会赶在前面查完 —— 实测红过一次 */
    const pollVision = async (want, tries) => {
      for (let i = 0; i < (tries || 24); i++) {
        const v = await page.evaluate(findVision);
        if (v && (!want || v.aria === want)) return v;
        await wait(200);
      }
      return await page.evaluate(findVision);
    };
    const vBefore = await pollVision("false");
    ok("模型分区渲染出「看截图像素」这一行开关", !!vBefore && vBefore.aria === "false" && vBefore.hasKnob, JSON.stringify(vBefore));
    if (vBefore) {
      ok("点得到那一行的开关", await page.evaluate(clickVision));
      const vAfter = await pollVision("true");
      const cfgAfter = await req("GET", "/api/config", null, token);
      ok("点一下真的写进配置（不是只翻了 DOM）", ((cfgAfter.llm || {}).vision) === true, JSON.stringify(cfgAfter.llm));
      ok("开关状态与配置一致（aria-checked 翻成 true）", vAfter && vAfter.aria === "true", JSON.stringify(vAfter));
      /* 重开一次分区：读的是服务端的值，不是前端内存里的旧态 —— 这条能抓出"快照没带 vision 字段" */
      await page.evaluate(() => window.openWorkbench("general"));
      await wait(220);
      await page.evaluate(() => window.openWorkbench("model"));
      const vReload = await pollVision("true");
      ok("重新打开分区后仍显示已开启（configSnapshot 真的回传了 vision）",
        vReload && vReload.aria === "true", JSON.stringify(vReload));
      await page.screenshot({ path: path.join(OUT, "wb_vision.png") }).catch(() => {});
    }

    section("自动结算开关（memory.autoSettle）：界面点得动、存得住、不牵连上面那个记忆开关");
    await page.evaluate(() => window.openWorkbench("agent"));
    await wait(260);
    /* 同样只交函数本体，参数另走 evaluate 的 arg —— 交字符串会被当表达式求值成函数对象，
       不可序列化就永远 resolve 成 undefined（上面视觉那段踩过一次）。 */
    const findRow = (want) => {
      const r = [...document.querySelectorAll("#wbBody .wb-row")]
        .find((x) => ((x.querySelector(".wb-row-name") || {}).textContent || "").includes(want));
      if (!r) return null;
      const sw = r.querySelector(".wb-switch");
      if (!sw) return null;
      return { aria: sw.getAttribute("aria-checked"), hasKnob: !!sw.querySelector(".wb-knob") };
    };
    const clickRow = (want) => {
      const r = [...document.querySelectorAll("#wbBody .wb-row")]
        .find((x) => ((x.querySelector(".wb-row-name") || {}).textContent || "").includes(want));
      if (!r) return false;
      r.querySelector(".wb-switch").click();
      return true;
    };
    const pollRow = async (want, aria, tries) => {
      for (let i = 0; i < (tries || 20); i++) {
        const v = await page.evaluate(findRow, want);
        if (v && (!aria || v.aria === aria)) return v;
        await wait(200);
      }
      return await page.evaluate(findRow, want);
    };
    const sOn = await pollRow("自动结算", "true");
    ok("Agent 分区渲染出「收尾自动结算决策链」，默认是开的", !!sOn && sOn.aria === "true" && sOn.hasKnob, JSON.stringify(sOn));
    ok("点得到这一行的开关", await page.evaluate(clickRow, "自动结算"));
    const sOff = await pollRow("自动结算", "false");
    ok("点完 aria-checked 真的翻成 false（不是只在配置里改了值）", !!sOff && sOff.aria === "false", JSON.stringify(sOff));
    const cfgOff = await req("GET", "/api/config", null, token);
    const memOff = (cfgOff.agent || {}).memory || {};
    ok("点一下真的写进配置（不是只翻了 DOM）", memOff.autoSettle === false, JSON.stringify(memOff));
    /* 单独存一个键不许把同级的 enabled 带走：wbSave 交的是 { memory: { autoSettle } }，
       服务端要是有整表替换的写法，用户点开这里就等于悄悄关了长期记忆。 */
    ok("只动这一个键：上面的「长期记忆」没被顺手关掉", memOff.enabled === true, JSON.stringify(memOff));
    await page.evaluate(() => window.openWorkbench("general"));
    await wait(220);
    await page.evaluate(() => window.openWorkbench("agent"));
    const sReload = await pollRow("自动结算", "false");
    ok("重开分区后仍显示已关闭（agentSettings 真的回传了 autoSettle）", !!sReload && sReload.aria === "false", JSON.stringify(sReload));
    ok("再点一次能开回来", await page.evaluate(clickRow, "自动结算"));
    const sBack = await pollRow("自动结算", "true");
    const cfgBack = await req("GET", "/api/config", null, token);
    ok("开回后界面与配置一致", !!sBack && sBack.aria === "true"
      && ((cfgBack.agent || {}).memory || {}).autoSettle === true, JSON.stringify([sBack, (cfgBack.agent || {}).memory]));
    await page.screenshot({ path: path.join(OUT, "wb_autosettle.png") }).catch(() => {});

    // trace 面板那一格：有成本才出现金额，没成本绝不出现 ¥
    const withCost = await page.evaluate(() => {
      window.onUsageEvent({ total_tokens: 5000, prompt_tokens: 4000, completion_tokens: 1000, cost: 0.42, costCurrency: "CNY" });
      return (document.getElementById("traceTokens") || {}).textContent || "";
    });
    ok("本会话累计格里金额跟成本一起出现（不足 1 元留 4 位）", /¥0\.4200/.test(withCost) && /k/.test(withCost), withCost);
    const noCost = await page.evaluate(() => {
      window.clearTrace();
      window.onUsageEvent({ total_tokens: 8000, prompt_tokens: 7000, completion_tokens: 1000 });
      return (document.getElementById("traceTokens") || {}).textContent || "";
    });
    ok("正向对照的反面：没配单价时那一格绝不显示 ¥", !/¥|\$/.test(noCost), noCost);
    await page.evaluate(() => window.clearTrace());

    section("压缩断路器（P1-B6）：停手要在聊天区说，不能只躺在终端页");
    const brk = await page.evaluate(() => {
      window.handleEvent({ type: "context.compact_breaker", streak: 2, why: "摘要不比原文短" });
      const t = document.getElementById("toast");
      return t ? { text: t.textContent, shown: t.classList.contains("show") } : null;
    });
    ok("断路器提示当场可见（toast 处于 show 态）", !!brk && brk.shown === true, brk && brk.text);
    ok("提示说清了后果与手动出路（会丢最旧轮次 / 可输 /compact）",
      !!brk && /压缩已暂停/.test(brk.text) && /丢弃最旧/.test(brk.text) && /\/compact/.test(brk.text), brk && brk.text);

    section("规则历史（P1-B5）：界面能看差异、能滚回去");
    /* 用一条自建的探针规则，不拿种子里的 style.md 开刀：本页后面的断言要靠
       「中文汇报」那条始终生效规则去校验生效预览，改了它就是把前面测过的东西踩坏。 */
    const mk = await req("POST", "/api/rules", { title: "历史探针", content: "SAND-BODY-V0 初版正文。" }, token);
    ok("探针规则创建成功", mk.ok === true && !!mk.file, JSON.stringify(mk).slice(0, 90));
    const RF = mk.file;
    const putA = await req("PUT", "/api/rules", { file: RF, content: "SAND-BODY-V1 每条结论都要给可核对的数字。" }, token);
    const putB = await req("PUT", "/api/rules", { file: RF, content: "SAND-BODY-V2 先给结论再给依据。" }, token);
    ok("两次保存都成功（历史要有料才能测）", putA.ok === true && putB.ok === true, JSON.stringify([putA.error, putB.error]));
    const histBefore = await req("GET", "/api/rules/history?file=" + encodeURIComponent(RF), null, token);
    ok("服务端已存到 2 版（V1 在最新那版里）",
      histBefore.ok === true && histBefore.versions.length === 2 && histBefore.versions[0].op === "update",
      JSON.stringify((histBefore.versions || []).map((v) => v.op)));

    errors.length = 0;
    await page.evaluate(() => window.openWorkbench("rules"));
    await wait(340);
    await page.locator(".wb-side-item", { hasText: "历史探针" }).first().click();
    await wait(420);
    ok("规则详情动作行有「历史」入口", await page.locator(".wb-detail-actions .wb-btn", { hasText: "历史" }).count() === 1);
    await page.locator(".wb-detail-actions .wb-btn", { hasText: "历史" }).first().click();
    await wait(500);
    const panel = await page.evaluate(() => {
      const h = document.querySelector(".wb-rulehist");
      if (!h) return null;
      const items = [...h.querySelectorAll(".wb-list-item")];
      return {
        shown: h.offsetParent !== null,
        text: (h.innerText || "").replace(/\n+/g, " / "),
        rows: items.length,
        first: items[0] ? items[0].innerText.replace(/\n+/g, " / ") : "",
        diffLines: [...h.querySelectorAll(".wb-diff-line")].map((l) => ({ cls: l.className, text: l.textContent })),
        toggleText: [...document.querySelectorAll(".wb-detail-actions .wb-btn")].map((b) => b.textContent),
      };
    });
    ok("点「历史」展开面板（不是空框）", !!panel && panel.shown === true && panel.rows >= 2, panel && panel.rows);
    ok("每版标出是哪次动作的前一版 + 按钮都在",
      !!panel && /改写/.test(panel.first) && /看差异/.test(panel.first) && /恢复这一版/.test(panel.first), panel && panel.first);
    ok("面板说清历史存在 rules-history、不会被注入", !!panel && /rules-history/.test(panel.text), panel && panel.text.slice(0, 120));
    ok("按钮文案随展开改成「收起历史」", !!panel && panel.toggleText.some((t) => /收起历史/.test(t)), panel && panel.toggleText.join("|"));
    ok("首屏自动渲染最新那版的行级差异（−V1 / +V2）",
      !!panel && panel.diffLines.some((l) => /wb-diff-del/.test(l.cls) && /SAND-BODY-V1/.test(l.text))
        && panel.diffLines.some((l) => /wb-diff-add/.test(l.cls) && /SAND-BODY-V2/.test(l.text)),
      panel && JSON.stringify(panel.diffLines.slice(0, 3)));
    await page.screenshot({ path: path.join(OUT, "wb_rule_history.png") }).catch(() => {});

    const dialogsBefore = dialogs.length;
    const rows = page.locator(".wb-rulehist .wb-list-item");
    await rows.first().locator(".wb-btn", { hasText: "恢复这一版" }).click();
    await wait(700);
    ok("点恢复会先问一句（不是无声覆盖）", dialogs.length > dialogsBefore && /覆盖当前规则/.test(dialogs[dialogsBefore]), dialogs[dialogsBefore]);
    const restored = await req("GET", "/api/rules/content?file=" + encodeURIComponent(RF), null, token);
    ok("恢复真的写回文件：正文回到 V1", restored.ok === true && /SAND-BODY-V1/.test(restored.body || "") && !/SAND-BODY-V2/.test(restored.body || ""),
      String((restored.body || "").slice(0, 80)));
    const histAfter = await req("GET", "/api/rules/history?file=" + encodeURIComponent(RF), null, token);
    ok("回滚自己也留了版（pre-restore），链条没断",
      histAfter.versions.length === 3 && histAfter.versions[0].op === "pre-restore",
      JSON.stringify((histAfter.versions || []).map((v) => v.op)));
    const taVal = await page.evaluate(() => {
      const ta = document.querySelector(".wb-detail textarea");
      return ta ? ta.value : null;
    });
    ok("界面重画后正文框显示的就是恢复后的内容", typeof taVal === "string" && /SAND-BODY-V1/.test(taVal), String(taVal).slice(0, 60));
    // 反向对照：从没改过的规则不能显示成"坏了的空框"
    await page.locator(".wb-side-item", { hasText: "后端约定" }).first().click();
    await wait(420);
    await page.locator(".wb-detail-actions .wb-btn", { hasText: "历史" }).first().click();
    await wait(500);
    const empty = await page.evaluate(() => {
      const h = document.querySelector(".wb-rulehist");
      return h ? { text: h.innerText, items: h.querySelectorAll(".wb-list-item").length } : null;
    });
    ok("无历史的规则给出解释而不是空框", !!empty && empty.items === 0 && /还没有历史版本/.test(empty.text), empty && empty.text.slice(0, 90));
    const histErr = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|is sandboxed|allow-same-origin/i.test(e));
    ok("规则历史整段交互无 JS 报错", histErr.length === 0, histErr.slice(0, 2).join(" | "));
    const delProbe = await req("DELETE", "/api/rules", { file: RF }, token);
    ok("探针规则清掉了（不留一条始终生效的测试规则给后面的断言）", delProbe.ok === true, JSON.stringify(delProbe).slice(0, 80));

    section("长任务时限：设置面板 + 审批倒计时");
    await page.evaluate(() => window.openWorkbench("agent"));
    await wait(320);
    const limits = await page.evaluate(() => {
      const g = [...document.querySelectorAll("#wbBody .wb-group")]
        .find((x) => /长任务时限/.test((x.querySelector(".wb-group-title") || {}).textContent || ""));
      if (!g) return { found: false };
      return {
        found: true,
        labels: [...g.querySelectorAll(".wb-row-name")].map((e) => e.textContent),
        vals: [...g.querySelectorAll("input[type=number]")].map((e) => e.value),
        descs: [...g.querySelectorAll(".wb-row-desc")].map((e) => e.textContent).join(" | "),
      };
    });
    ok("Agent 分区渲染「长任务时限」分组", limits.found === true);
    ok("五个时限输入都在（三个原有 + 看门狗两个）", limits.found && limits.labels.length === 5, JSON.stringify(limits.labels));
    ok("输入值取自服务端真实设置（600/1200/120 + 停滞 6 分钟 + 墙钟 8 小时）",
      (limits.vals || []).join(",") === "600,1200,120,6,8", JSON.stringify(limits.vals));
    ok("审批时限的说明讲清了后果", /你拒绝了|自动放弃/.test(limits.descs || ""), (limits.descs || "").slice(0, 90));
    ok("命令时限的说明指向后台进程方案", /start_process/.test(limits.descs || ""), (limits.descs || "").slice(0, 90));
    /* 看门狗这两个键以前只在配置文件里：跑得越久越需要调它们，而"能配却看不见"
       正是 agentMaxMs 那个缺陷（注释写着可配置、实际根本没这个键）的温床。 */
    ok("停滞阈值的说明讲清「只要还在动就不算停」", /还在动|没有任何进展/.test(limits.descs || ""), (limits.descs || "").slice(-260));
    ok("墙钟上限的说明承诺到点会说原因、不是静默停", /不是静默停止|说明原因/.test(limits.descs || ""), (limits.descs || "").slice(-140));
    await page.locator("#wbBody .wb-group", { hasText: "长任务时限" }).locator("input[type=number]").nth(1).fill("1800");
    await page.keyboard.press("Enter");
    await wait(500);
    const persisted = await req("GET", "/api/config", null, token);
    ok("改审批时限真的落库并回读（1800s）",
      persisted.agent && persisted.agent.timeouts && persisted.agent.timeouts.approvalSec === 1800,
      JSON.stringify((persisted.agent || {}).timeouts));
    const reloaded = await page.evaluate(() => {
      const g = [...document.querySelectorAll("#wbBody .wb-group")]
        .find((x) => /长任务时限/.test((x.querySelector(".wb-group-title") || {}).textContent || ""));
      return g ? [...g.querySelectorAll("input[type=number]")].map((e) => e.value).join(",") : null;
    });
    ok("面板上的值与服务端一致（不会显示成没生效）", reloaded === "600,1800,120,6,8", String(reloaded));
    /* 两个新键各改一次：单位换算（分钟→毫秒、小时→毫秒）与落库、回填都得对上。
       上一版把"能改"写在注释里却没有入口，就是这个换算与键名从没被任何一层验过。 */
    const stallInput = page.locator("#wbBody .wb-group", { hasText: "长任务时限" }).locator("input[type=number]").nth(3);
    await stallInput.fill("10");
    await page.keyboard.press("Enter");
    await wait(450);
    const maxInput = page.locator("#wbBody .wb-group", { hasText: "长任务时限" }).locator("input[type=number]").nth(4);
    await maxInput.fill("12");
    await page.keyboard.press("Enter");
    await wait(500);
    const persisted2 = await req("GET", "/api/config", null, token);
    ok("停滞 10 分钟存成 600000 毫秒（单位换算在界面这一侧，服务端只认毫秒）",
      persisted2.agent && persisted2.agent.agentStallMs === 600000,
      JSON.stringify(persisted2.agent && persisted2.agent.agentStallMs));
    ok("墙钟 12 小时存成 43200000 毫秒",
      persisted2.agent && persisted2.agent.agentMaxMs === 43200000,
      JSON.stringify(persisted2.agent && persisted2.agent.agentMaxMs));
    const reloaded2 = await page.evaluate(() => {
      const g = [...document.querySelectorAll("#wbBody .wb-group")]
        .find((x) => /长任务时限/.test((x.querySelector(".wb-group-title") || {}).textContent || ""));
      return g ? [...g.querySelectorAll("input[type=number]")].map((e) => e.value).join(",") : null;
    });
    ok("重新画出来的面板显示 10 分钟 / 12 小时（回填走的是同一份配置）", reloaded2 === "600,1800,120,10,12", String(reloaded2));
    /* 越界值不许静默收下：服务端会 warn 并保留原值（与 permissions.mode 同一口径） */
    const clamped = await req("POST", "/api/config", { section: "agent", patch: { agentStallMs: 1000, agentMaxMs: 999999999999 } }, token);
    const afterClamp = await req("GET", "/api/config", null, token);
    ok("两个越界值一起提交时，原值都保住（600000 / 43200000），不是收下再说没生效",
      clamped.ok === true && afterClamp.agent.agentStallMs === 600000 && afterClamp.agent.agentMaxMs === 43200000,
      JSON.stringify(afterClamp.agent && { s: afterClamp.agent.agentStallMs, m: afterClamp.agent.agentMaxMs }));
    await page.screenshot({ path: path.join(OUT, "wb_longtask_limits.png") }).catch(() => {});
    await page.evaluate(() => window.closeWorkbench());   // 全屏工作台会拦住聊天区点击，先关掉
    await wait(250);

    const cd = await page.evaluate(async () => {
      window.handleEvent({
        type: "tool.pending", id: "apUI", tool: "run_command", danger: "medium",
        preview: { command: "npm run build" }, timeoutSec: 90,
      });
      await new Promise((r) => setTimeout(r, 1200));
      const el = document.querySelector(".tool-card.approval .ap-wait");
      return el ? { text: el.textContent, shown: el.offsetParent !== null } : null;
    });
    ok("审批卡片显示「等你处理 · 剩 …」倒计时", !!cd && /等你处理 · 剩/.test(cd.text), cd && cd.text);
    ok("倒计时显示在卡片操作行里（可见）", cd && cd.shown === true);
    ok("倒计时格式可读（1m29s 这类）", cd && /^等你处理 · 剩 (1m2[0-9]s|29s)$/.test(cd.text), cd && cd.text);
    const cd2 = await page.evaluate(async () => {
      const a = (document.querySelector(".tool-card.approval .ap-wait") || {}).textContent || "";
      await new Promise((r) => setTimeout(r, 1600));
      return { a, b: (document.querySelector(".tool-card.approval .ap-wait") || {}).textContent || "" };
    });
    ok("倒计时真的在走（不是静态文案）", cd2.a !== cd2.b, cd2.a + " → " + cd2.b);
    await page.locator(".tool-card.approval .btn-approve").first().click();
    await wait(300);
    const st = await page.evaluate(async () => {
      const el = document.querySelector(".tool-card.approval .ap-wait");
      const a = el.textContent;
      await new Promise((r) => setTimeout(r, 1400));
      return { a, b: el.textContent, disabled: document.querySelector(".tool-card.approval .btn-approve").disabled };
    });
    ok("批准后倒计时停住、按钮锁定（不再催促用户）", st.a === st.b && st.disabled === true, st.a + " / " + st.b);
    await page.evaluate(() => window.handleEvent({
      type: "tool.ask_choice", id: "chUI", question: "选一个方案",
      options: [{ label: "A" }, { label: "B" }], timeoutSec: 90,
    }));
    await wait(300);
    ok("选项卡同样显示等待倒计时", await page.locator(".tool-card.choice .ap-wait").count() === 1);
    const layout = await page.evaluate(() => {
      const card = [...document.querySelectorAll(".tool-card.approval")].find((c) => c.querySelector(".ap-wait"));
      const btn = card.querySelector(".btn-approve-session");
      const wait = card.querySelector(".ap-wait");
      const row = card.querySelector(".approval-actions");
      return {
        btnH: Math.round(btn.getBoundingClientRect().height),
        waitH: Math.round(wait.getBoundingClientRect().height),
        rowH: Math.round(row.getBoundingClientRect().height),
        clipped: [...card.querySelectorAll("button")].some((b) => b.scrollWidth > b.clientWidth + 1),
      };
    });
    ok("按钮没有被挤成竖排（单行高度 <30px）", layout.btnH < 30, "实际 " + layout.btnH + "px");
    ok("倒计时是单行（<20px）", layout.waitH < 20, "实际 " + layout.waitH + "px");
    ok("没有按钮文字被裁切", layout.clipped === false, JSON.stringify(layout));
    const noCd = await page.evaluate(async () => {
      window.handleEvent({
        type: "tool.pending", id: "apNo", tool: "write_file",
        preview: { path: "a.js", lines: 3, preview: "x" },
      });
      await new Promise((r) => setTimeout(r, 200));
      const cards = document.querySelectorAll(".tool-card.approval");
      return cards[cards.length - 1].querySelector(".ap-wait") === null;
    });
    ok("旧事件（无 timeoutSec）不渲染倒计时也不报错", noCd === true);
    await page.screenshot({ path: path.join(OUT, "wb_approval_countdown.png") }).catch(() => {});

    section("空闲看门狗：静默 34s 不得误杀健康连接");
    await page.evaluate(() => {
      window.__toasts = [];
      const orig = window.toast;
      window.toast = (m) => { window.__toasts.push(String(m)); return orig(m); };
    });
    const idle0 = await page.evaluate(() => ({ last: _wsLastMsg, state: ws && ws.readyState }));
    await wait(34000);
    const idle1 = await page.evaluate(() => ({ last: _wsLastMsg, state: ws && ws.readyState, toasts: window.__toasts }));
    ok("静默 34s 后连接仍是 OPEN（看门狗没误杀）", idle1.state === 1, "readyState=" + idle1.state);
    ok("服务端 3s 周期广播持续刷新存活证据", idle1.last > idle0.last + 5000, idle0.last + " → " + idle1.last);
    ok("没有误报「连接无响应 / 已重新连接」",
      !idle1.toasts.some((t) => /无响应|重新连接|断开/.test(t)), JSON.stringify(idle1.toasts.slice(0, 3)));

    section("关键交互");
    await page.evaluate(() => window.openWorkbench("appearance"));
    await wait(250);
    const palCount = await page.locator(".wb-palette").count();
    ok("配色卡片数量与 PALETTES 一致（" + palCount + "）", palCount === shell.palettes, "PALETTES=" + shell.palettes);
    await page.locator(".wb-palette", { hasText: "琥珀" }).first().click().catch(() => {});
    await wait(200);
    const pal = await page.evaluate(() => ({ attr: document.documentElement.getAttribute("data-palette"), stored: localStorage.getItem("cw-palette") }));
    ok("点配色卡片即切换 data-palette", !!pal.attr && pal.attr === pal.stored, JSON.stringify(pal));

    await page.evaluate(() => window.openWorkbench("rules"));
    await wait(320);
    const ruleRows = await page.locator(".wb-side-item").count();
    ok("规则分区列出磁盘上的规则", ruleRows >= 3, "实际 " + ruleRows);
    await page.locator(".wb-side-item", { hasText: "后端约定" }).first().click();
    await wait(320);
    ok("点开规则可编辑（出现正文框）", await page.locator(".wb-detail textarea").count() > 0);
    const pvText = await page.locator(".wb-rules-preview .wb-preview").innerText().catch(() => "");
    ok("生效预览含始终生效规则", /中文汇报|一律中文/.test(pvText), pvText.slice(0, 80));
    await page.fill(".wb-rules-preview input", "server/index.js");
    await page.click(".wb-rules-preview .wb-btn:not(.wb-btn-primary)");
    await wait(320);
    const pv2 = await page.locator(".wb-rules-preview .wb-preview").innerText().catch(() => "");
    ok("按需规则在模拟命中后进入预览", /CommonJS/.test(pv2), pv2.slice(0, 120));

    await page.evaluate(() => window.openWorkbench("experts"));
    await wait(320);
    ok("专家分区列出内置 + 自建专家", await page.locator(".wb-side-item").count() >= 4, "实际 " + await page.locator(".wb-side-item").count());
    await page.locator(".wb-side-item", { hasText: "发布专家" }).first().click();
    await wait(300);
    ok("专家表单出现角色定位与方法论字段", await page.locator(".wb-detail textarea").count() >= 2);
    await page.locator(".wb-detail .wb-btn-primary", { hasText: "保存" }).first().click();
    await wait(400);
    ok("保存专家后提示成功", await page.evaluate(() => (document.getElementById("wbSaved") || {}).textContent || "").then((t) => /已保存/.test(t)));

    await page.evaluate(() => window.openWorkbench("memory"));
    await wait(320);
    ok("记忆分区有统计条", await page.locator(".wb-stats").count() > 0);
    ok("记忆清单渲染", await page.locator(".wb-side-item").count() >= 1);
    /* P6 口径要在界面上看得见：面板如果说"将注入 12 条"而模型其实只看到一行目录，
       那就是界面在替旧规则撒谎。两类条目各一枚徽章才算判据有效（只有一类时另一类的缺失无法区分"没渲染"与"没数据"）。 */
    const memUi = await page.evaluate(() => {
      const stats = [...document.querySelectorAll(".wb-stats .wb-stat")].map((s) => ({
        label: (s.querySelector("span") || {}).textContent || "",
        value: (s.querySelector("b") || {}).textContent || "",
      }));
      const rows = [...document.querySelectorAll(".wb-side-item")].map((it) => ({
        title: it.textContent || "",
        badges: [...it.querySelectorAll(".wb-badge")].map((b) => b.textContent || ""),
      }));
      const note = [...document.querySelectorAll(".wb-note, .wb-stats + *")].map((n) => n.textContent || "").join(" ");
      const btns = [...document.querySelectorAll(".wb-inline-actions .wb-btn")].map((b) => b.textContent || "");
      return { stats, rows, note, btns };
    });
    const statLabels = memUi.stats.map((s) => s.label).join("|");
    ok("统计条把「正文常驻」和「只在索引里」分成两个数",
      /正文常驻/.test(statLabels) && /只在索引里/.test(statLabels), statLabels);
    const residentStat = memUi.stats.find((s) => /正文常驻/.test(s.label));
    const idxStat = memUi.stats.find((s) => /只在索引里/.test(s.label));
    ok("两个数各自量到了灌进去的那一条",
      Number(residentStat && residentStat.value) >= 1 && Number(idxStat && idxStat.value) >= 1,
      "常驻=" + (residentStat && residentStat.value) + " 索引=" + (idxStat && idxStat.value));
    ok("清单里被否过的那条挂着「正文常驻」徽章",
      memUi.rows.some((r) => /界面改动必须在真 Electron/.test(r.title) && r.badges.some((b) => /正文常驻/.test(b))),
      JSON.stringify(memUi.rows.slice(0, 4)));
    ok("清单里普通那条只挂「只在索引里」，不再谎称常驻",
      memUi.rows.some((r) => /打包前要先跑一次冒烟|构建/.test(r.title)
        && r.badges.some((b) => /只在索引里/.test(b)) && !r.badges.some((b) => /正文常驻/.test(b))),
      JSON.stringify(memUi.rows.slice(0, 4)));
    ok("说明文案讲的是判断层口径（提到 search_memory / 由模型自己查）",
      /search_memory|自己查|自己判断/.test(memUi.note), (memUi.note || "").slice(0, 120));
    ok("入口按钮改口为「最近实际用到」（不再是「实际注入」）",
      memUi.btns.some((b) => /最近实际用到/.test(b)) && !memUi.btns.some((b) => /实际注入/.test(b)),
      JSON.stringify(memUi.btns));

    await page.evaluate(() => window.openWorkbench("skills"));
    await wait(320);
    ok("技能分区渲染清单", await page.locator(".wb-side-item").count() >= 3, "实际 " + await page.locator(".wb-side-item").count());

    await page.evaluate(() => window.openWorkbench("soul"));
    await wait(320);
    ok("灵魂分区三张清单可见", await page.locator(".wb-chip").count() >= 3, "chip " + await page.locator(".wb-chip").count());

    section("入口改接");
    const entryChecks = [["btnGlobalSettings", "appearance", "click"], ["btnSettings", "model", "gear"], ["btnAgentSettings", "agent", "click"], ["envSediment", "sediment", "dom"]];
    for (const [id, expected, mode] of entryChecks) {
      const exists = await page.evaluate((eid) => !!document.getElementById(eid), id);
      if (!exists) { ok("入口 #" + id + " 存在", false, "元素不在 DOM 里"); continue; }
      await page.evaluate(() => window.closeWorkbench());
      await wait(150);
      if (mode === "gear") {
        /* §3.11 改了契约：齿轮先出小抽屉，全屏工作台改由抽屉底部「全部设置」进。
           这里两条都要断言 —— 只测"抽屉出来了"会漏掉"全部设置进不去"，
           只测"能进 model"又会漏掉"齿轮又变回直接开工作台"这个回退。 */
        await page.evaluate(() => { const el = document.getElementById("gearMenu"); if (el) el.classList.add("hidden"); });
        await page.click("#" + id, { timeout: 3000 }).catch(() => {});
        await wait(320);
        const gear = await page.evaluate(() => {
          const el = document.getElementById("gearMenu");
          const wb = document.getElementById("workbench");
          return { drawer: !!el && !el.classList.contains("hidden") && el.getBoundingClientRect().height > 0,
            wbOpen: !!wb && wb.style.display !== "none" };
        });
        ok("入口 #btnSettings → 先出小抽屉、不直接开工作台", gear.drawer && !gear.wbOpen, JSON.stringify(gear));
        await page.click(".gm-all", { timeout: 3000 }).catch(() => {});
        await wait(450);
        const sec2 = await page.evaluate(() => ({ s: (window.WB || {}).section, open: (document.getElementById("workbench") || {}).style ? document.getElementById("workbench").style.display : "?" }));
        ok("抽屉底部「全部设置」→ " + expected, sec2.s === expected && sec2.open !== "none", JSON.stringify(sec2));
        continue;
      }
      let clickErr = "";
      if (mode === "click") await page.click("#" + id, { timeout: 3000 }).catch((e) => { clickErr = e.message.split("\n")[0]; });
      else await page.evaluate((eid) => { const el = document.getElementById(eid); if (el) el.click(); }, id);
      await wait(450);
      const sec = await page.evaluate(() => ({ s: (window.WB || {}).section, open: (document.getElementById("workbench") || {}).style ? document.getElementById("workbench").style.display : "?" }));
      ok("入口 #" + id + " → " + expected, sec.s === expected && sec.open !== "none", clickErr ? "点击受阻：" + clickErr : "分区=" + sec.s + " open=" + sec.open + (mode === "dom" ? "（隐藏元素，用 DOM click 验证绑定）" : ""));
    }
    /* 输入栏模型 chip：改成直接下拉选模型，不再跳设置 */
    await page.evaluate(() => window.closeWorkbench());
    await wait(120);
    const chip = await page.evaluate(async () => {
      const el = document.getElementById("btnModelChip");
      if (!el) return { present: false };
      el.click();
      await new Promise((r) => setTimeout(r, 900));
      const pop = document.getElementById("ciModelPop");
      return {
        present: true,
        wbOpen: (document.getElementById("workbench") || {}).style ? document.getElementById("workbench").style.display : "?",
        popShown: pop ? getComputedStyle(pop).display !== "none" : false,
        items: pop ? pop.querySelectorAll(".cmp-item").length : 0,
        empty: pop ? pop.querySelectorAll(".cmp-empty").length : 0,
        fake: pop ? ["gpt-4o", "deepseek-chat", "kimi-k2-0905-preview", "glm-4.5"].filter((m) => (pop.innerText || "").includes(m)).length : 0,
      };
    });
    ok("输入栏模型 chip 存在", chip.present === true);
    ok("点 chip 不再打开设置工作台", chip.wbOpen === "none" || chip.wbOpen === "", "display=" + chip.wbOpen);
    ok("点 chip 直接展开模型下拉（真模型 " + chip.items + " 个 / 空态 " + chip.empty + "）",
      chip.popShown === true && (chip.items >= 1 || chip.empty === 1), JSON.stringify(chip));
    ok("模型下拉里没有内置假模型清单", chip.fake === 0, "假模型 " + chip.fake + " 个");

    section("搜索");
    await page.evaluate(() => window.openWorkbench("appearance"));
    await wait(200);
    await page.fill("#wbSearch", "配色");
    await wait(250);
    ok("搜索能过滤导航", await page.locator(".wb-nav-item").count() < 17 && await page.locator(".wb-nav-item").count() >= 1, "导航项 " + await page.locator(".wb-nav-item").count());
    await page.fill("#wbSearch", "权限");
    await wait(250);
    const navTxt = await page.locator(".wb-nav").innerText();
    ok("搜「权限」能找到权限分区", /权限与安全/.test(navTxt), navTxt.replace(/\n/g, " ").slice(0, 60));
    await page.fill("#wbSearch", "");
    await wait(200);

    section("截图");
    for (const id of ["appearance", "rules", "memory", "experts"]) {
      await page.evaluate((sid) => window.openWorkbench(sid), id);
      await wait(420);
      await page.screenshot({ path: path.join(OUT, "wb_" + id + ".png") });
    }
    /* 浅色配色下再看一次最密的两页，确认对比度与描边没塌 */
    await page.evaluate(() => window.openWorkbench("appearance"));
    await wait(300);
    await page.evaluate(() => { const p = [...document.querySelectorAll(".wb-palette")].find((x) => /羊皮纸/.test(x.textContent)); if (p) p.click(); });
    await wait(450);
    const lightMode = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    ok("选浅色配色会连带切到浅色模式", lightMode === "light", "data-theme=" + lightMode);
    for (const id of ["rules", "experts"]) {
      await page.evaluate((sid) => window.openWorkbench(sid), id);
      await wait(420);
      await page.screenshot({ path: path.join(OUT, "wb_light_" + id + ".png") });
    }
    await page.evaluate(() => window.openWorkbench("appearance"));
    await wait(300);
    await page.evaluate(() => { const p = [...document.querySelectorAll(".wb-palette")].find((x) => /威士忌/.test(x.textContent)); if (p) p.click(); });
    await wait(400);
    await page.screenshot({ path: path.join(OUT, "wb_appearance_whisky.png") });
    ok("截图产出", fs.existsSync(path.join(OUT, "wb_appearance.png")) && fs.existsSync(path.join(OUT, "wb_light_rules.png")));
  } finally {
    await browser.close();
    child.kill();
    await wait(300);
  }
  void tail;
}

main().then(() => {
  console.log("\n" + "=".repeat(52));
  console.log(fail === 0 ? "\x1b[32m全部通过\x1b[0m  " + pass + " 项断言" : "\x1b[31m失败 " + fail + " 项\x1b[0m / 共 " + (pass + fail));
  fails.forEach((f) => console.log("  · " + f));
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error("\x1b[31m异常：\x1b[0m" + e.message); process.exit(2); });
