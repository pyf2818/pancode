/* ============================================================
   P2-C3 技能市场增强 —— 端到端验收（真服务 + 真磁盘 + 真浏览器）
   为什么要浏览器那一层：这条链上三个缺陷全是"服务端静默丢字段"型的——
   rate() 不存在、categories 没有 getter、状态字段不写回 frontmatter。
   读代码看不出"那排分类 chip 从来没出现过"，只有把面板真打开才知道。

   反向断言（"没被筛掉""没变成空对象"）一律先配正向对照：
   先证明列表真渲染出了行、评分真从接口回来了，再断言筛选与顺序。
   ============================================================ */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");

const PORT = Number(process.env.SKILLMKT_PORT || 8825);
const ROOT = path.resolve(__dirname, "..");
const SB = path.join(ROOT, "scripts", "_verify_out", "skm-sandbox");
const DATA = path.join(SB, "data");
const WS = path.join(SB, "ws");
const MARKET = path.join(DATA, ".pancode", "skills", "market");
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
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, json: { raw: buf.slice(0, 200) } }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const J = (v) => JSON.stringify(v).slice(0, 260);

function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(MARKET, { recursive: true });
  fs.mkdirSync(path.join(WS, ".pancode"), { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(WS, "readme.md"), "# 技能市场探针工作区\n");
}

async function boot() {
  /* 用户级技能池读的是 os.homedir()/.pancode/skills —— 不隔离的话，
     开发机自己攒的那些技能会混进侧栏，排序与计数的断言就变成"看我电脑上有什么"而不是看产品行为。
     （_verify_assets.js / _verify_skilluse.js 同一个手法：给子进程换 HOME。） */
  const HOME = path.join(SB, "home");
  fs.mkdirSync(HOME, { recursive: true });
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), PANCODE_DATA_DIR: DATA, CURSORWEB_WORKSPACE: WS,
      HOME, USERPROFILE: HOME,
      CURSORWEB_ENGINE: "demo", AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  child.stdout.on("data", (c) => (tail = (tail + c).slice(-4000)));
  child.stderr.on("data", (c) => (tail = (tail + c).slice(-4000)));
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const h = await req("GET", "/api/health"); if (h.json && h.json.ok) return { child, tail }; } catch (e) {}
  }
  throw new Error("服务未就绪\n" + tail);
}

/* 侧栏那一屏的当前状态：行按渲染顺序给出，带 data-cat / data-rating / data-src，
   断言因此打在"这一行是谁、属于哪一组"上，而不是拿界面文本正则凑（凑出来的断言在文案改动时会假绿）。
   内置组永远排在用户组之上，所以排序断言必须打在 data-src="market" 的那一段里。 */
const readRows = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll("#skillsList .skill-item"), ...document.querySelectorAll("#localSkillsList .skill-item")];
  return {
    names: rows.map((r) => r.dataset.name),
    cats: rows.map((r) => r.dataset.cat),
    ratings: rows.map((r) => r.dataset.rating),
    marketNames: rows.filter((r) => r.dataset.src === "market").map((r) => r.dataset.name),
    count: (document.getElementById("skillsCount") || {}).textContent || "",
    chips: [...document.querySelectorAll("#skillCatChips .skm-cat")].map((b) => ({ cat: b.dataset.cat, text: b.textContent.trim(), on: b.classList.contains("on") })),
    sortOn: ([...document.querySelectorAll("#skillSort button.on")].map((b) => b.dataset.sort) || [])[0],
    box: (() => { const v = document.getElementById("view-skills"); return v ? { w: v.clientWidth, sw: v.scrollWidth } : null; })(),
  };
});

(async () => {
  seed();
  section("起沙箱服务 + 造三条不同分类的技能");
  const { child, tail } = await boot();
  const reg = await req("POST", "/api/auth/register", { username: "_skm_" + Date.now(), password: "test1234" });
  const token = reg.json && reg.json.token;
  if (!token) { child.kill(); throw new Error("注册失败：" + J(reg.json)); }

  const mk = (name, category) => ({ name, description: name + " 的描述", category, trigger: name, body: "1. 步骤" });
  /* 名字用 ASCII 前缀：三种排序的期望首位各不相同（alpha=名称、zulu=用量、mid=评分），
     且不依赖 ICU 对汉字的撞序规则——那会随 Node 的 icu 构建变化，断言就不可复现了。 */
  const SEED = [["alpha", "skm-alpha 前端", "frontend"], ["mid", "skm-mid 测试", "test"], ["zulu", "skm-zulu 重构", "refactor"]];
  const made = {};
  for (const [k, name, cat] of SEED) {
    const r = await req("POST", "/api/skills", mk(name, cat), token);
    if (!r.json.ok) { child.kill(); throw new Error("造技能失败：" + J(r.json)); }
    made[k] = r.json.skill;
  }
  const use = (id) => req("POST", "/api/skills/market/" + encodeURIComponent(id) + "/use", {}, token);
  await use(made.zulu.id); await use(made.zulu.id); await use(made.mid.id);

  let browser;
  try {
    section("① categories 终于是个真对象（以前被 JSON 静默丢掉）");
    const all = await req("GET", "/api/skills/all", null, token);
    const cats = all.json.categories;
    ok("响应里有 categories 且是对象（不是 undefined）", cats && typeof cats === "object" && !Array.isArray(cats), J(all.json).slice(0, 120));
    ok("新造的三个分类都被数到了", !!(cats && cats.frontend >= 1 && cats.test >= 1 && cats.refactor >= 1), J(cats));
    ok("内置工作流也计入（与侧栏同一屏，chip 数字才不虚）", !!(cats && cats.debug >= 1 && Object.keys(cats).length >= 4), J(cats));

    section("② rate() 落盘：评分写进 .md，而不是抛 TypeError 被 catch 吞掉");
    const ratePath = (id) => "/api/skills/market/" + encodeURIComponent(id) + "/rate";
    const rated = await req("POST", ratePath(made.mid.id), { rating: 4 }, token);
    ok("接口返回 ok 且 skill.rating=4", rated.json.ok === true && rated.json.skill && rated.json.skill.rating === 4, J(rated.json));
    const md = fs.existsSync(path.join(MARKET, made.mid.id + ".md"))
      ? fs.readFileSync(path.join(MARKET, made.mid.id + ".md"), "utf8") : "";
    ok("磁盘上的 .md 真写了 rating: 4（不是只活在内存里）", /^rating: 4$/m.test(md), md.split("\n").slice(0, 10).join(" | "));
    const managed = await req("GET", "/api/skills/managed", null, token);
    const row = (managed.json.skills || []).find((s) => s.id === made.mid.id);
    ok("资产管理接口也带回了 rating", row && row.rating === 4, J(row));

    section("③ 非法评分与内置项：给明确文案，不给 JS 报错");
    const badStr = await req("POST", ratePath(made.alpha.id), { rating: "abc" }, token);
    const badBig = await req("POST", ratePath(made.alpha.id), { rating: 9 }, token);
    ok("非数字评分 → 400 且中文说明 0–5", badStr.status === 400 && /0[–-]5/.test(badStr.json.error || ""), J(badStr.json));
    ok("越界评分 → 400（不是静默夹到 5）", badBig.status === 400, J(badBig.json));
    ok("两条报错里都没有 is not a function（原缺陷的指纹）",
      !/is not a function/.test((badStr.json.error || "") + " " + (badBig.json.error || "")),
      (badStr.json.error || "") + " / " + (badBig.json.error || ""));
    ok("非法评分没把已存的那条清零（旧写法 Number(x)||0 会静默写 0）",
      /^rating: 4$/m.test(fs.readFileSync(path.join(MARKET, made.mid.id + ".md"), "utf8")), "");
    const builtin0 = (all.json.builtin || [])[0] || {};
    const bk = await req("POST", ratePath(builtin0.id), { rating: 5 }, token);
    ok("给内置技能评分被明确挡住并指出路（不是假装成功）", bk.json.ok === false && bk.json.needFork === true && /另存/.test(bk.json.error || ""), J(bk.json));

    section("④ sort 参数真的换了顺序");
    const byName = (await req("GET", "/api/skills/all?sort=name", null, token)).json.skills.map((s) => s.name);
    const byUsage = (await req("GET", "/api/skills/all?sort=usage", null, token)).json.skills.map((s) => s.name);
    const byRating = (await req("GET", "/api/skills/all?sort=rating", null, token)).json.skills.map((s) => s.name);
    const head3 = (a) => a.slice(0, 3).join(",");
    ok("name / usage / rating 三种顺序互不相同（参数没被忽略）",
      byName.join() !== byUsage.join() && byRating.join() !== byUsage.join() && byName.join() !== byRating.join(),
      "name:" + head3(byName) + " usage:" + head3(byUsage) + " rating:" + head3(byRating));
    ok("按名称排是升序（skm-alpha 在前，skm-zulu 在后）",
      byName.indexOf("skm-alpha 前端") < byName.indexOf("skm-zulu 重构"), head3(byName));
    ok("按用量排：用过 2 次的 skm-zulu 在只用过 1 次的 skm-mid 之前",
      byUsage.indexOf("skm-zulu 重构") < byUsage.indexOf("skm-mid 测试"), head3(byUsage));
    ok("按评分排：唯一评过分的 skm-mid 排第一", byRating[0] === "skm-mid 测试", head3(byRating));

    section("⑤ 停用状态写回磁盘（以前重启就自己活过来）");
    const beforeQ = "skm-zulu 重构";
    const hitBefore = (await req("GET", "/api/skills/preview?q=" + encodeURIComponent(beforeQ), null, token)).json.matched || [];
    ok("正向对照：停用之前它真的会被自动匹配到", hitBefore.some((m) => m.name === beforeQ), J(hitBefore));
    const off = await req("POST", "/api/skills/" + encodeURIComponent(made.zulu.id) + "/toggle", { disabled: true }, token);
    ok("toggle 返回 disabled=true", off.json.ok === true && off.json.disabled === true, J(off.json));
    ok("该技能的 .md 里出现 disabled: true",
      /^disabled: true$/m.test(fs.readFileSync(path.join(MARKET, made.zulu.id + ".md"), "utf8")), "");
    const hitAfter = (await req("GET", "/api/skills/preview?q=" + encodeURIComponent(beforeQ), null, token)).json.matched || [];
    ok("停用后不再被自动匹配推给模型", !hitAfter.some((m) => m.name === beforeQ), J(hitAfter));

    section("浏览器：打开 Skills 市场那一屏");
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    await page.addInitScript((t) => {
      try {
        localStorage.setItem("cw-user-token", t);
        localStorage.setItem("cw-theme", "dark");
        localStorage.setItem("cw-palette", "graphite");
        localStorage.setItem("cw-onboarded", "1");
      } catch (e) {}
    }, token);
    await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.renderSkillsList === "function", null, { timeout: 15000 });
    await wait(1200);
    await page.click('.ab-btn[data-view="skills"]');
    await wait(1400);
    await page.screenshot({ path: path.join(OUT, "skm_market.png") });

    let s = await readRows(page);
    const searchBox = await page.locator("#skillSearch").boundingBox();
    section("⑥ 工具条与分类 chip 出现在屏上");
    ok("搜索框可见且有高度", !!searchBox && searchBox.height > 16, J(searchBox));
    /* 排序按钮组已移除（只留搜索）：契约从"4 个开关"改为"DOM 不存在 + 列表按默认用量序" */
    ok("排序开关已移除，工具条只留搜索", (await page.locator("#skillSort").count()) === 0, J((await page.locator(".skm-toolbar").innerHTML().catch(() => "")).slice(0, 120)));
    ok("分类 chip 渲染出来了（这条以前永远为 0）", s.chips.length >= 4, "chips=" + J(s.chips.map((c) => c.text)));
    ok("「全部」chip 上的数字 = 屏内行数（计数与列表同源）",
      s.chips[0] && s.chips[0].cat === "" && new RegExp("^全部 " + s.names.length + "$").test(s.chips[0].text), J(s.chips[0]) + " rows=" + s.names.length);
    ok("正向对照：列表真渲染出了行", s.names.length > 0 && s.names.includes("skm-alpha 前端"), J(s.names.slice(0, 5)));
    ok("侧栏没有被筛选器撑出横向溢出", s.box && s.box.sw <= s.box.w + 2, J(s.box));

    section("⑦ 评分进了界面");
    const ratedRow = page.locator('#skillsList .skill-item[data-name="skm-mid 测试"]');
    const rateEl = ratedRow.locator(".skm-rate");
    ok("评过分的行显示 4 分（星 + 数字）",
      (await rateEl.count()) === 1 && /4/.test((await rateEl.textContent()) || "") && (await ratedRow.getAttribute("data-rating")) === "4",
      (await ratedRow.innerText().catch(() => "")));
    ok("没评分的行不硬凑一个 0 分占位",
      (await page.locator('#skillsList .skill-item[data-name="skm-alpha 前端"] .skm-rate').count()) === 0);

    section("⑧ 点分类 chip：只留下那一类");
    const feChip = page.locator('#skillCatChips .skm-cat[data-cat="frontend"]');
    ok("frontend 这个 chip 存在", await feChip.count() === 1, J(s.chips.map((c) => c.cat)));
    await feChip.click();
    await wait(320);
    s = await readRows(page);
    ok("屏内每一行都是 frontend", s.cats.length > 0 && s.cats.every((c) => c === "frontend"), J(s.cats));
    ok("计数写明是筛选结果（命中/总数）", /已筛选/.test(s.count) && /\/\s*\d+/.test(s.count), s.count);
    await page.screenshot({ path: path.join(OUT, "skm_filtered.png") });
    await page.locator('#skillCatChips .skm-cat[data-cat="frontend"]').click();   // 再点一次 = 取消
    await wait(280);
    s = await readRows(page);
    ok("再点同一枚 chip 是取消筛选，不是锁死", s.cats.length > 1 && !/已筛选/.test(s.count), J(s.count));

    section("⑨ 搜索框即时过滤");
    await page.fill("#skillSearch", "alpha");
    await wait(320);
    s = await readRows(page);
    ok("只剩名称/描述命中「alpha」的行", s.names.length >= 1 && s.names.every((n) => /alpha/i.test(n)), J(s.names));
    await page.fill("#skillSearch", "重构");
    await wait(320);
    s = await readRows(page);
    /* 搜中文分类标签也要命中：chip 上写的是"重构"，池子里存的是 refactor，
       只按原始字段搜就会出现"看得见却搜不到"。 */
    ok("按界面上看得见的中文分类标签搜得出来（重构 → refactor 那几条）",
      s.names.length >= 1 && s.names.every((n) => /重构/.test(n)), J(s.names));
    await page.fill("#skillSearch", "绝不存在zzz");
    await wait(320);
    ok("筛空了：给出可点的清除入口，而不是留一片空白",
      await page.locator("#skillsList .skm-clear").count() === 1, await page.locator("#skillsList").innerHTML().catch(() => ""));
    await page.click("#skillsList .skm-clear");
    await wait(320);
    s = await readRows(page);
    ok("清除筛选后行数回来了", s.names.includes("skm-alpha 前端") && (await page.inputValue("#skillSearch")) === "", J(s.names.slice(0, 4)));

    section("⑩ 默认排序（按用量）：用户创建那一组内部有序");
    /* 排序按钮组移除后固定 usage 序，不再有切换交互可测。内置组永远排在用户组之上
       （这是这一屏的信息架构），所以断言打在 data-src="market" 的那一段上；
       评分数据是否真从磁盘走到顺序，由 ⑪ 的"点星落盘"覆盖。 */
    s = await readRows(page);
    ok("用量序：skm-zulu 重构 在 skm-mid 测试 之前",
      s.marketNames.indexOf("skm-zulu 重构") === 0 && s.marketNames.indexOf("skm-mid 测试") === 1, J(s.marketNames));

    section("⑪ 详情弹窗里点星 → 落盘 → 重开还在");
    /* 操作区平时是 visibility:hidden（悬停才浮出），Playwright 把这种状态算不可见，
       所以先悬停到那一行再点里面的按钮——不然点了也只会等到超时。 */
    await ratedRow.hover();
    await ratedRow.locator(".skill-view").click();
    await wait(420);
    ok("弹窗里 5 枚星，其中 4 枚是实心（与磁盘一致）",
      (await page.locator("#sdStars button").count()) === 5 && (await page.locator("#sdStars .sk-star.on").count()) === 4,
      await page.locator("#sdRateVal").textContent().catch(() => ""));
    await page.screenshot({ path: path.join(OUT, "skm_detail.png") });
    await page.click('#sdStars button[data-v="2"]');
    await wait(600);
    ok("点 2 星后弹窗计数改成 2 / 5", /2 \/ 5/.test(await page.locator("#sdRateVal").textContent()), await page.locator("#sdRateVal").textContent());
    ok("磁盘上的 .md 跟着变成 rating: 2",
      /^rating: 2$/m.test(fs.readFileSync(path.join(MARKET, made.mid.id + ".md"), "utf8")), "");
    await page.click("#skillDetailClose");
    await wait(320);
    await ratedRow.hover();
    await ratedRow.locator(".skill-view").click();
    await wait(420);
    ok("重开弹窗仍是 2 星实心（不是靠内存里的旧对象）", (await page.locator("#sdStars .sk-star.on").count()) === 2, "");
    await page.click("#skillDetailClose");

    section("⑫ 内置技能：星星是灰的，说明先另存");
    const builtinRow = page.locator('#skillsList .skill-item[data-name="修复 Bug"]');
    ok("内置工作流那一行在屏上", (await builtinRow.count()) === 1, "");
    await builtinRow.hover();
    await builtinRow.locator(".skill-view").click();
    await wait(420);
    ok("内置项的星星按钮是 disabled",
      (await page.locator("#sdStars button:disabled").count()) === 5, await page.locator("#sdStars").count().catch(() => -1));
    ok("并写明「另存为我的技能」的出路", /另存为我的技能/.test(await page.locator("#skillDetailBody").innerText()), "");
    await page.click("#skillDetailClose");
    await wait(260);

    section("⑬ 全程没有 JS 报错");
    const real = errors.filter((e) => !/favicon|net::ERR|Failed to load resource|is sandboxed|allow-same-origin/i.test(e));
    ok("浏览器侧无未捕获异常/控制台报错", real.length === 0, real.slice(0, 3).join(" | "));
    ok("服务端侧没有 TypeError 指纹", !/is not a function|UNCAUGHT/.test(tail), (tail.match(/.{0,120}(is not a function|UNCAUGHT).{0,120}/) || [""])[0]);
  } catch (e) {
    ok("探针自身跑通（未中途抛错）", false, String(e && e.stack || e).slice(0, 400));
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
  console.log("\n[P2-C3] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("VERIFY_CRASH", e && e.stack || e); process.exit(1); });
