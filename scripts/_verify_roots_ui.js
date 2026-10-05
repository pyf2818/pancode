/* 授权目录管理 UI 的真实链路探针（阶段二-4）
 * 同进程拉起服务端 → Playwright 打开设置工作台「权限与安全」→ 对着**盘上真的发生了什么**断言。
 * 为什么必须跑浏览器：这一节的全部价值在于"用户点一下，Agent 的可达范围真的变了"，
 * 而这件事读代码看不出来（装配、落盘、异步写盘、picker 复用，任何一环断掉界面都照样好看）。
 *
 * 七条底线：
 *   一、清单里列的就是盘上 roots.json 里的那些目录，当前工作区被单独标出来；
 *   二、当前工作区不给撤销按钮（撤了等于 Agent 什么都碰不到，且下次挂载会被 ensure 加回来）；
 *   三、只读 ↔ 可写一点就落盘（saveJson 是异步排队的，所以要轮询等，不能 POST 返回就断言）；
 *   四、「添加目录」用的是同一个文件夹浏览器，但它**绝不换工作区**（这条最容易写错，错了就是数据事故）；
 *   五、撤销授权只删清单里那一行，目录和其中的文件一个都不碰；
 *   六、目录掉盘要标出来（"不在盘上"），不是静默少一行；
 *   七、规则生效预览说明白"只装当前根那一层"，别让人以为看到的是模型看到的全部。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

/* ---------- 沙箱：数据根与工作区都必须在 require 服务端之前定下来 ----------
   晚一步就会把测试账号写进开发者真实的 .pancode/users.json，并顺手按 TTL 删掉真实对话。 */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pc-rootsui-"));
const SDATA = path.join(SANDBOX, "data");
const SWS = path.join(SANDBOX, "ws");
const EXTRA = path.join(SANDBOX, "other-project");
const RO = path.join(SANDBOX, "notes");
const GONE = path.join(SANDBOX, "then-removed");
const ADDED = path.join(SANDBOX, "added-by-ui");
/* 复现真实例里踩到的脏数据：清单是持久化的，而"当前工作区"是每轮现算的状态，
   老代码把它当名字写进了 roots.json，于是切过一次工作区之后两行都自称"当前工作区"。 */
const STALE = path.join(SANDBOX, "stale-labeled");
for (const d of [SDATA, SWS, EXTRA, RO, GONE, ADDED, STALE]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(SWS, "a.js"), "当前根\n", "utf8");
fs.writeFileSync(path.join(EXTRA, "b.js"), "另一个项目\n", "utf8");
fs.writeFileSync(path.join(RO, "c.md"), "只读备忘\n", "utf8");
fs.writeFileSync(path.join(GONE, "d.txt"), "会被删掉的目录\n", "utf8");
fs.writeFileSync(path.join(ADDED, "e.txt"), "UI 加进来的目录\n", "utf8");

process.env.PANCODE_DATA_DIR = SDATA;
process.env.CURSORWEB_WORKSPACE = SWS;
process.env.PORT = process.env.PORT || "8828";
process.env.CURSORWEB_ENGINE = "demo";
process.env.NODE_NO_WARNINGS = "1";

const ROOTS_FILE = path.join(SDATA, ".pancode", "roots.json");
const auth = require("../server/auth");
require("../server/index.js");

const PORT = process.env.PORT;
const BASE = "http://127.0.0.1:" + PORT;
const USER = "rootsui_" + Date.now();
const OUT = path.join(__dirname, "_verify_out");
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

function readRoots() {
  try { return JSON.parse(fs.readFileSync(ROOTS_FILE, "utf8")); } catch (e) { return null; }
}
/* saveJson 是排队异步写的（Windows 上还要退避重试），POST 返回 200 时文件常常还没落盘 */
async function waitForRootsFile(pred, label) {
  for (let i = 0; i < 60; i++) {
    const rows = rowsOf(readRoots()) || [];
    if (Array.isArray(rows) && pred(rows)) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("等不到 roots.json 变成期望的样子：" + label + " 现有内容：" + JSON.stringify(readRoots()));
}
const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const rowsOf = (j) => (j && (j.roots || j.list || j)) || [];

async function api(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

(async () => {
  /* 先用真 API 铺好初始清单（顺带把 #22 的端点也过一遍） */
  section("准备：用 /api/roots 铺初始清单");
  let reg = await fetch(BASE + "/api/auth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: "test1234" }),
  }).then((x) => x.json()).catch(() => ({}));
  const token = (await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USER, password: "test1234" }),
  }).then((x) => x.json())).token || "";
  ok("临时账号可登录（沙箱数据根，不碰真实 users.json）", !!token, JSON.stringify(reg).slice(0, 120));
  const H = { "Content-Type": "application/json", Authorization: "Bearer " + token };
  const noAuth = await fetch(BASE + "/api/roots", { method: "GET" }).then((x) => x.status);
  ok("匿名读授权清单被拒（授权目录是敏感操作）", noAuth === 401, "status=" + noAuth);

  const addExtra = await fetch(BASE + "/api/roots", {
    method: "POST", headers: H, body: JSON.stringify({ path: EXTRA, label: "另一个项目" }),
  }).then((x) => x.json());
  const addRo = await fetch(BASE + "/api/roots", {
    method: "POST", headers: H, body: JSON.stringify({ path: RO, label: "备忘（只看）", writable: false }),
  }).then((x) => x.json());
  const addGone = await fetch(BASE + "/api/roots", {
    method: "POST", headers: H, body: JSON.stringify({ path: GONE, label: "会掉盘" }),
  }).then((x) => x.json());
  /* 脏数据复现：名字位存了"当前工作区"，而它其实不是当前工作区 */
  const addStale = await fetch(BASE + "/api/roots", {
    method: "POST", headers: H, body: JSON.stringify({ path: STALE, label: "当前工作区" }),
  }).then((x) => x.json());
  ok("三个额外目录都授权成功", !!(addExtra.root && addRo.root && addGone.root && addStale.root),
    JSON.stringify(addExtra).slice(0, 160));
  await waitForRootsFile((j) => rowsOf(j).length >= 5, "初始 5 条（含当前工作区）");
  /* 授权完了再把目录删掉 → 它应当以"不在盘上"的样子出现，而不是静默少一行 */
  fs.rmSync(GONE, { recursive: true, force: true });

  /* ---------- 开浏览器 ---------- */
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("response", (r) => { if (r.status() >= 400) errors.push("HTTP " + r.status() + " " + r.url().replace(BASE, "")); });
  await page.addInitScript((t) => localStorage.setItem("cw-user-token", t), token);
  await page.goto(BASE + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.state && window.state.monacoReady === true, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const readRows = () => page.evaluate(() => {
    const out = [];
    document.querySelectorAll("#wbBody .wb-root-item").forEach((el) => {
      out.push({
        label: (el.querySelector(".wb-root-label") || {}).textContent || "",
        path: (el.querySelector(".wb-root-path") || {}).textContent || "",
        badges: Array.from(el.querySelectorAll(".wb-badge")).map((b) => b.textContent),
        writable: !!el.querySelector(".wb-root-switch.on"),
        removeDisabled: !!el.querySelector(".wb-icon-btn") && el.querySelector(".wb-icon-btn").disabled === true,
      });
    });
    return out;
  });

  section("① 设置里能搜到「授权目录」，打开就是权限与安全的第一组");
  await page.evaluate(() => openWorkbench("perms"));
  await page.waitForSelector("#wbBody .wb-root-item", { timeout: 8000 });
  const groupTitles = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#wbBody .wb-group-title")).map((x) => x.textContent));
  ok("「授权目录」排在最前面（先谈能不能进门，再谈进门后能干什么）",
    /授权目录/.test(groupTitles[0] || ""), JSON.stringify(groupTitles));
  await page.evaluate(() => { document.getElementById("wbClose").click(); });
  await page.waitForTimeout(150);
  const navHit = await page.evaluate(() => {
    openWorkbench("appearance");
    const s = document.getElementById("wbSearch");
    s.value = "授权"; s.dispatchEvent(new Event("input"));
    const hits = Array.from(document.querySelectorAll("#wbNav .wb-nav-item")).map((x) => x.textContent.trim());
    s.value = ""; s.dispatchEvent(new Event("input"));
    return hits;
  });
  ok("设置顶栏搜「授权」能落到那一节（不用背路径）", navHit.some((t) => /权限与安全/.test(t)), JSON.stringify(navHit));

  section("② 列出来的就是清单里那些目录，当前工作区单独标出");
  await page.evaluate(() => openWorkbench("perms"));
  await page.waitForSelector("#wbBody .wb-root-item", { timeout: 8000 });
  let rows = await readRows();
  ok("四条额外目录 + 当前工作区都在", rows.length === 5, JSON.stringify(rows.map((r) => r.label)));
  const activeRow = rows.find((r) => r.badges.includes("当前工作区"));
  ok("当前工作区被标出来且路径正确", !!activeRow && norm(activeRow.path) === norm(SWS), JSON.stringify(activeRow));
  /* 徽标只该有一个：它是现算的；名字位里那句"当前工作区"是老数据留下的，不能跟着冒充状态 */
  ok("自称「当前工作区」的行只有一行（脏 label 不再冒充徽标）",
    rows.filter((r) => r.badges.includes("当前工作区")).length === 1,
    JSON.stringify(rows.filter((r) => r.badges.includes("当前工作区")).map((r) => r.path)));
  const staleRow = rows.find((r) => norm(r.path) === norm(STALE));
  ok("label 存成「当前工作区」的那条，名字位退回目录名", !!staleRow && staleRow.label === "stale-labeled",
    JSON.stringify(staleRow));
  ok("只读那条带「只读」标，可写那条不带", rows.find((r) => r.label === "备忘（只看）").badges.includes("只读") &&
    !rows.find((r) => r.label === "另一个项目").badges.includes("只读"),
    JSON.stringify(rows.map((r) => [r.label, r.badges])));
  ok("掉盘的那条标「不在盘上」而不是静默消失",
    !!rows.find((r) => r.label === "会掉盘" && r.badges.includes("不在盘上")),
    JSON.stringify(rows.find((r) => r.label === "会掉盘")));
  ok("当前工作区不给撤销按钮", !!activeRow && activeRow.removeDisabled === true,
    JSON.stringify({ has: !!activeRow, disabled: activeRow && activeRow.removeDisabled }));
  ok("额外目录可以被撤销", rows.find((r) => r.label === "另一个项目").removeDisabled === false);

  section("③ 只读 ↔ 可写：点一下真的落盘");
  await page.click('#wbBody .wb-root-item:has(.wb-root-label:text-is("备忘（只看）")) .wb-root-switch');
  await page.waitForTimeout(250);
  const afterToggle = await waitForRootsFile(
    (j) => rowsOf(j).some((r) => norm(r.path) === norm(RO) && r.writable === true), "备忘改成可写");
  ok("盘上那条真的变成可写", !!afterToggle.find((r) => norm(r.path) === norm(RO) && r.writable === true),
    JSON.stringify(afterToggle.map((r) => [r.label, r.writable])));
  rows = await readRows();
  ok("界面开关跟着变绿（不用刷新）", !!rows.find((r) => r.label === "备忘（只看）" && r.writable),
    JSON.stringify(rows.find((r) => r.label === "备忘（只看）")));
  const errsAfterToggle = errors.slice();
  ok("改读写性没有连带打出别的错（会话没被换掉）",
    (await page.evaluate(() => document.querySelector("#wbBody .wb-root-item .wb-root-path").textContent)).length > 0,
    JSON.stringify(errsAfterToggle.slice(0, 2)));

  section("④「添加目录」复用同一个浏览器，但绝不换工作区");
  /* GET /api/workspace 给的是 { current, recent }，字段名别再猜第二遍 */
  const wsOf = async () => (await fetch(BASE + "/api/workspace", { headers: H }).then((x) => x.json())).current;
  const wsBefore = await wsOf();
  await page.click('#wbBody .wb-btn-primary:has-text("添加目录")');
  await page.waitForSelector("#folderModal", { timeout: 5000 });
  const picker = await page.evaluate(() => ({
    shown: getComputedStyle(document.getElementById("folderModal")).display,
    title: (document.querySelector("#folderModal .set-head > span") || {}).textContent || "",
    btn: (document.getElementById("fmOpen") || {}).textContent || "",
  }));
  ok("选择器打开的是「授权」这件事，不是「打开此文件夹」",
    picker.shown !== "none" && /授权/.test(picker.title) && /授权/.test(picker.btn), JSON.stringify(picker));
  await page.fill("#fmPath", ADDED);
  await page.click("#fmGo");
  await page.waitForTimeout(600);
  const pickState = await page.evaluate(() => ({
    path: document.getElementById("fmPath").value,
    current: document.getElementById("fmCurrent").textContent,
    btnDisabled: document.getElementById("fmOpen").disabled,
    listRows: document.getElementById("fmList").children.length,
    listTxt: document.getElementById("fmList").textContent.slice(0, 80),
  }));
  ok("浏览到目标目录后「授权此文件夹」变为可点（选择器真的认得这个路径）",
    pickState.btnDisabled === false, JSON.stringify(pickState));
  await page.click("#fmOpen");
  await page.waitForTimeout(500);
  const afterAdd = await waitForRootsFile(
    (j) => rowsOf(j).some((r) => norm(r.path) === norm(ADDED)), "UI 新加的目录");
  ok("新目录进了清单（也在盘上）",
    !!afterAdd.find((r) => norm(r.path) === norm(ADDED)), JSON.stringify(afterAdd.map((r) => r.path)));
  const wsAfter = (await fetch(BASE + "/api/workspace", { headers: H }).then((x) => x.json())).current;
  ok("工作区没有被换掉（授权 ≠ 切目录，这条错了就是数据事故）",
    norm(wsAfter) === norm(wsBefore) && norm(wsAfter) === norm(SWS), wsBefore + " → " + wsAfter);
  rows = await readRows();
  ok("列表立刻多出新目录，且默认可写",
    !!rows.find((r) => norm(r.path) === norm(ADDED) && r.writable), JSON.stringify(rows.map((r) => r.label)));

  section("⑤ 撤销授权只删那一行，目录和文件一概不动");
  const victim = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("#wbBody .wb-root-item"))
      .find((x) => (x.querySelector(".wb-root-label") || {}).textContent === "另一个项目");
    return el ? el.querySelector(".wb-root-path").textContent : "";
  });
  page.once("dialog", (d) => d.accept());
  await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("#wbBody .wb-root-item"))
      .find((x) => (x.querySelector(".wb-root-label") || {}).textContent === "另一个项目");
    el.querySelector(".wb-icon-btn").click();
  });
  await page.waitForTimeout(400);
  const afterRemove = await waitForRootsFile(
    (j) => !rowsOf(j).some((r) => norm(r.path) === norm(EXTRA)), "撤销「另一个项目」");
  ok("盘上那一行没了", !afterRemove.find((r) => norm(r.path) === norm(EXTRA)),
    JSON.stringify(afterRemove.map((r) => r.path)));
  ok("目录与其中的文件还在（撤销权限不等于删数据）",
    fs.existsSync(path.join(EXTRA, "b.js")) && fs.readFileSync(path.join(EXTRA, "b.js"), "utf8") === "另一个项目\n",
    victim);
  rows = await readRows();
  ok("界面上那一行也没了", !rows.some((r) => r.label === "另一个项目"), JSON.stringify(rows.map((r) => r.label)));

  section("⑥ 规则生效预览说清了「只装当前根那一层」");
  /* 先把授权目录这一节本身截下来：截图落在后面导航去的分区，等于没看过它长什么样 */
  await page.evaluate(() => { window.scrollTo(0, 0); const b = document.querySelector(".wb-body-wrap"); if (b) b.scrollTop = 0; });
  await page.screenshot({ path: path.join(OUT, "roots-ui.png") });
  console.log("shot: roots-ui.png");
  const rulesTxt = await page.evaluate(async () => {
    openWorkbench("rules");
    await new Promise((r) => setTimeout(r, 900));
    return document.getElementById("wbBody").innerText;
  });
  ok("预览明写这里只有当前工作区的规则（不说谎，但也不装全知）",
    /只装「当前工作区」的规则/.test(rulesTxt) || /这里只装「当前工作区」的规则/.test(rulesTxt),
    (rulesTxt.match(/只装[^\n。]{0,40}/) || ["没找到这句"])[0]);
  ok("预览把「去哪里看授权目录」指出来了", /权限与安全 · 授权目录/.test(rulesTxt), "缺指引");

  section("⑦ 控制台与网络：没有多余的四百 / 报错");
  await page.evaluate(() => { const s = document.getElementById("wbSearch"); if (s) { s.value = ""; s.dispatchEvent(new Event("input")); } });
  const fatal = errors.filter((e) => !/favicon|net::ERR|sandboxed and lacks|localStorage.*sandboxed/i.test(e));
  ok("全程没有致命报错与意外的 4xx", fatal.length === 0, fatal.slice(0, 4).join(" | ") || "无");
  await page.screenshot({ path: path.join(OUT, "roots-rules-note.png") });
  console.log("shot: roots-rules-note.png");

  await browser.close();
  try { auth.removeUser(USER); } catch (e) {}
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  console.log("\n" + (fail ? "\x1b[31mHAS FAIL\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { for (const f of fails) console.log("  - " + f); process.exit(1); }
  process.exit(0);
})().catch((e) => {
  console.error("\x1b[31mFAIL:\x1b[0m " + (e && e.stack || e));
  try { auth.removeUser(USER); } catch (x) {}
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});
