/* ============================================================
   齿轮抽屉 / 反馈小窗 / 关于页 GitHub 与开发者信息 的验收探针
   ------------------------------------------------------------
   三条口径：
     ① 每张截图、每条"看到了"之前，先断言目标真的显形（有尺寸、没被 class 藏起来）。
        上一轮探针就是靠这条查出"命令面板从来没被打开过"的。
     ② 不测"按钮存在"，测"点下去真有用"：主题、语言、模式都读回真实状态
        （documentElement[data-theme] / getLang() / state.agentMode）。
     ③ 出网的一律拦下来看字符串：window.open 与 navigator.clipboard 都打桩，
        断言拼出的 issue URL 与复制的联系方式，绝不真开浏览器、真建单。
   ============================================================ */
"use strict";
const SANDBOX = require("./_sandbox").create({
  tag: "gearmenu",
  wsFiles: { "src/app.js": "export const a = 1;\n", "README.md": "# demo\n" },
});

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { chromium } = require("playwright");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.GM_PORT || 8841);
const HOME = path.join(SANDBOX.root, "home");
fs.mkdirSync(HOME, { recursive: true });
const OUT = path.join(ROOT, "scripts", "_verify_out");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 320); } catch (e) { return String(v).slice(0, 320); } };

function req(method, urlPath, body, token) {
  const data = body == null ? null : JSON.stringify(body);
  const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
  if (token) headers["x-user-token"] = token;
  return new Promise((resolve, reject) => {
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

function boot() {
  const env = SANDBOX.env({ PORT: String(PORT), PANCODE_PROBE: "1", HOME, USERPROFILE: HOME });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], { cwd: ROOT, env, windowsHide: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const waitFor = async (sub, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (out.includes(sub)) return true; await wait(150); }
    return false;
  };
  return { child, out: () => out, waitFor };
}

/* 页内小工具：显形判据 + 可见中文计数（fixed 元素 offsetParent 为 null，所以用 rect） */
const HELPERS = `
window.__vis = function (sel) {
  const el = typeof sel === "string" ? document.querySelector(sel) : sel;
  if (!el) return { shown: false, why: "no-node" };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const hiddenByClass = el.classList.contains("hidden");
  const hiddenByStyle = el.style && el.style.display === "none";
  return { shown: r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden" && !hiddenByClass && !hiddenByStyle,
    w: Math.round(r.width), h: Math.round(r.height), why: hiddenByClass ? "class-hidden" : hiddenByStyle ? "style-none" : cs.display };
};
window.__cjk = function (rootSel) {
  const root = document.querySelector(rootSel) || document.body;
  const CJK = /[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]/;
  const out = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const el = n.parentElement;
    if (!el || ["SCRIPT", "STYLE", "TEXTAREA"].indexOf(el.tagName) >= 0) continue;
    if (el.closest("[data-i18n-skip]")) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0 || cs.display === "none" || parseFloat(cs.opacity) < 0.05) continue;
    const s = String(n.nodeValue).replace(/\\s+/g, " ").trim();
    if (s && CJK.test(s)) {
      /* 语言选择器里的「中文」是各语言按自己的写法显示的（和右上角 中/EN 同一口径），
         翻成 "Chinese" 反而更难认，不算漏翻 */
      if (s === "中文" && el.closest(".gm-seg")) continue;
      out.push(s.slice(0, 40));
    }
  }
  root.querySelectorAll("[title],[placeholder],[aria-label]").forEach((el) => {
    const v = el.title || el.placeholder || el.getAttribute("aria-label") || "";
    if (CJK.test(v) && el.getBoundingClientRect().width > 0) out.push(v.slice(0, 40));
  });
  return Array.from(new Set(out));
};
`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { child, waitFor, out } = boot();
  if (!(await waitFor("已启动", 25000))) throw new Error("服务端没起来：" + out().slice(-400));
  const reg = await req("POST", "/api/auth/register", { username: "_gm_" + Date.now(), password: "test1234" });
  const token = reg && reg.json && reg.json.token;
  if (!token) throw new Error("注册失败：" + J(reg.json));

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const jsErrors = [];
  page.on("console", (m) => { if (m.type() === "error") jsErrors.push(m.text()); });
  page.on("pageerror", (e) => jsErrors.push("pageerror: " + e.message));
  /* 已知遗留（本轮之前就有，实测：加载完、一次没点就是 1 条，点齿轮后新增 0 条）：
     沙箱化的预览 iframe（sandbox="allow-scripts"，无 allow-same-origin）里跑到了
     读 localStorage 的行内脚本 → SecurityError。只按这一条消息精确豁免，不放宽成"忽略所有报错"。 */
  const KNOWN = /favicon|net::ERR|Failed to load resource|'localStorage' property from 'Window': The document is sandboxed/i;
  const realErrors = () => jsErrors.filter((e) => !KNOWN.test(e));
  await page.addInitScript((cfg) => {
    localStorage.setItem("cw-user-token", cfg.token);
    localStorage.setItem("cw-lang", "zh");
    localStorage.setItem("cw-theme", "dark");
    localStorage.setItem("cw-onboarded", "1");
  }, { token });
  await page.goto("http://127.0.0.1:" + PORT + "/index.html", { waitUntil: "domcontentloaded" });
  await wait(2200);
  await page.evaluate(HELPERS);

  const clickGear = () => page.click("#btnSettings");
  const vis = (sel) => page.evaluate((s) => window.__vis(s), sel);

  try {
    section("① 齿轮先出小抽屉，不再直接开全屏工作台");
    await clickGear();
    await wait(260);
    /* 报错断言放在最前面：链尾那条"全程无 JS 报错"要等整条跑完才说话，
       而加载期抛错会让节点根本不存在 —— 那时先报"为什么没节点"比报一堆超时有用。 */
    ok("点齿轮没抛页面错误", realErrors().length === 0, realErrors().slice(0, 2).join(" | ").slice(0, 200));
    const g = await vis("#gearMenu");
    ok("点齿轮出抽屉（真的显形：有尺寸、非 hidden）", g.shown, J(g));
    ok("全屏工作台没有跟着打开", (await vis("#workbench")).shown === false, J(await vis("#workbench")));
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll(".gm-row .gm-name")).map((n) => n.textContent));
    ok("抽屉里是一排常用项而不是空壳", rows.length >= 8, rows.length + " 行：" + rows.join(" / "));
    ok("中文态这把尺子量得到中文（EN 那个 0 才是量出来的，不是尺子坏了）",
      (await page.evaluate(() => window.__cjk("#gearMenu"))).length >= 5,
      "实测 " + (await page.evaluate(() => window.__cjk("#gearMenu"))).length + " 条");
    ok("可展开的行都读得出当前值（值位就是「现在是什么」）", await page.evaluate(() => Array.from(document.querySelectorAll(".gm-row"))
      .filter((r) => r.querySelector(".gm-chev"))
      .every((r) => String((r.querySelector(".gm-val") || {}).textContent || "").trim().length > 0)),
      "缺值的行：" + await page.evaluate(() => Array.from(document.querySelectorAll(".gm-row")).filter((r) => r.querySelector(".gm-chev") && !(r.querySelector(".gm-val") || {}).textContent).map((r) => r.dataset.gm).join(",")));

    await clickGear();
    await wait(200);
    ok("再点一次齿轮收起（toggle 语义）", (await vis("#gearMenu")).shown === false, J(await vis("#gearMenu")));
    await clickGear();
    await wait(200);
    await page.mouse.click(700, 620);
    await wait(200);
    ok("点抽屉外面收起", (await vis("#gearMenu")).shown === false, J(await vis("#gearMenu")));
    await clickGear();
    await wait(200);
    await page.keyboard.press("Escape");
    await wait(200);
    ok("Esc 收起", (await vis("#gearMenu")).shown === false, J(await vis("#gearMenu")));

    section("② 子项抽屉式展开");
    /* 上一节以 Esc 收起结尾：抽屉关着的话，这些行存在但不可见，
       page.click 会一直等到超时 —— 每节自己把界面摆回起点，别赌上一节的收尾。 */
    await clickGear();
    await wait(240);
    ok("第二节开始时抽屉是开着的", (await vis("#gearMenu")).shown, J(await vis("#gearMenu")));
    const kids = ["appearance", "lang", "mode", "model", "github"];
    for (const id of kids) {
      await page.click('.gm-row[data-gm="' + id + '"]');
      await wait(320);
      const r = await page.evaluate((k) => {
        const item = document.querySelector('.gm-item:has(.gm-row[data-gm="' + k + '"])');
        const sub = item && item.querySelector(".gm-sub");
        const inner = sub && sub.firstElementChild;
        return { open: !!(item && item.classList.contains("open")), h: inner ? Math.round(inner.getBoundingClientRect().height) : 0 };
      }, id);
      ok("展开「" + id + "」后子面板真的撑开了", r.open && r.h > 18, J(r));
    }
    const onlyOne = await page.evaluate(() => document.querySelectorAll(".gm-item.open").length);
    ok("同时只展开一项（不是叠成一堆）", onlyOne === 1, "展开数=" + onlyOne);

    section("③ 点下去真的生效（读回真实状态）");
    await page.click('.gm-row[data-gm="appearance"]');
    await wait(300);
    await page.evaluate(() => {
      const segs = Array.from(document.querySelectorAll('.gm-item.open .gm-seg-btn'));
      const light = segs.find((b) => /浅色|Light/.test(b.textContent));
      if (light) light.click();
    });
    await wait(320);
    ok("点「浅色」真的换了主题", (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "light",
      "data-theme=" + await page.evaluate(() => document.documentElement.getAttribute("data-theme")));
    await page.click('.gm-row[data-gm="appearance"]');
    await wait(280);
    await page.evaluate(() => {
      const segs = Array.from(document.querySelectorAll('.gm-item.open .gm-seg-btn'));
      const auto = segs.find((b) => /跟随系统|System/.test(b.textContent));
      if (auto) auto.click();
    });
    await wait(300);
    ok("点「跟随系统」写进了偏好", (await page.evaluate(() => localStorage.getItem("cw-theme"))) === "auto",
      "cw-theme=" + await page.evaluate(() => localStorage.getItem("cw-theme")));

    await page.click('.gm-row[data-gm="mode"]');
    await wait(280);
    await page.evaluate(() => {
      const segs = Array.from(document.querySelectorAll('.gm-item.open .gm-seg-btn'));
      const p = segs.find((b) => /Plan/.test(b.textContent));
      if (p) p.click();
    });
    await wait(420);
    const modeNow = await page.evaluate(() => { const s = (typeof state !== "undefined" && state) || window.state; return s && s.agentMode; });
    ok("点「Plan」真的切了 Agent 模式", modeNow === "plan", "state.agentMode=" + modeNow);

    await page.click('.gm-row[data-gm="lang"]');
    await wait(280);
    await page.evaluate(() => {
      const segs = Array.from(document.querySelectorAll('.gm-item.open .gm-seg-btn'));
      const en = segs.find((b) => /English/.test(b.textContent));
      if (en) en.click();
    });
    await wait(520);
    const enNow = await page.evaluate(() => ({ lang: (typeof getLang === "function" ? getLang() : ""), rows: Array.from(document.querySelectorAll(".gm-row .gm-name")).map((n) => n.textContent) }));
    ok("抽屉里点 English 真的换了语言并重画了自己", enNow.lang === "en" && enNow.rows.some((x) => /Appearance/.test(x)), J(enNow));
    ok("EN 态抽屉里零残留中文", (await page.evaluate(() => window.__cjk("#gearMenu"))).length === 0,
      J(await page.evaluate(() => window.__cjk("#gearMenu"))));
    await page.screenshot({ path: path.join(OUT, "gearmenu_en_appearance.png") });
    await page.evaluate(() => setLang("zh"));
    await wait(420);
    await clickGear();
    await wait(260);

    section("④ 反馈小窗：拼出来的链接逐字段查");
    await page.evaluate(() => {
      window.__opens = [];
      window.__realOpen = window.open;
      window.open = (u) => { window.__opens.push(String(u)); return null; };
      window.__copied = [];
      try { navigator.clipboard && (navigator.clipboard.writeText = async (v) => { window.__copied.push(String(v)); }); } catch (e) {}
    });
    await page.evaluate(() => window.openFeedback());
    await wait(300);
    ok("反馈窗真的显形", (await vis("#fbModal")).shown, J(await vis("#fbModal")));
    await page.click("#fbGo");
    await wait(260);
    const afterEmpty = await page.evaluate(() => window.__opens.slice());
    ok("空文本点提交不会开浏览器", afterEmpty.length === 0, J(afterEmpty));
    ok("空文本给了提示（toast 在场）", await page.evaluate(() => !!document.querySelector(".toast, #toast, [class*=toast]")), "没找到 toast 节点");
    await page.fill("#fbText", "终端里跑 npm test 时中文提示偶发乱码\n第二步：切到英文再切回来");
    await wait(220);
    ok("输入后给了正文预览（用户能看到将提交什么）", await page.evaluate(() => {
      const p = document.getElementById("fbPre");
      return !!p && getComputedStyle(p).display !== "none" && p.textContent.length > 20;
    }), "预览为空");
    await page.click("#fbGo");
    await wait(320);
    const url = await page.evaluate(() => window.__opens[0] || "");
    const parsed = (() => { try { const u = new URL(url); return { base: u.origin + u.pathname, title: u.searchParams.get("title") || "", body: u.searchParams.get("body") || "" }; } catch (e) { return { base: "", title: "", body: "" }; } })();
    ok("提交打开的是本仓库的 new-issue", parsed.base === "https://github.com/pyf2818/pancode/issues/new", url.slice(0, 90));
    ok("标题带了版本号前缀", /^\[v[0-9.]+\]/.test(parsed.title), parsed.title);
    ok("标题只取正文第一行且不超长", parsed.title.includes("npm test") && !parsed.title.includes("第二步") && parsed.title.length <= 70, parsed.title);
    ok("正文带了用户原话", parsed.body.includes("终端里跑 npm test"), parsed.body.slice(0, 80));
    ok("正文附了诊断块（版本 / 引擎 / 工作区）", /```/.test(parsed.body) && /pancode /.test(parsed.body) && /Workspace /.test(parsed.body), parsed.body.replace(/\n/g, " ").slice(0, 150));
    await page.screenshot({ path: path.join(OUT, "gearmenu_feedback.png") });
    await page.keyboard.press("Escape");
    await wait(220);
    ok("Esc 关掉反馈窗", (await vis("#fbModal")).shown === false, J(await vis("#fbModal")));

    section("⑤ 关于页：GitHub 与开发者信息");
    await page.evaluate(() => window.openWorkbench("about"));
    await wait(700);
    ok("关于页真的显形", (await vis("#workbench")).shown, J(await vis("#workbench")));
    const about = await page.evaluate(() => {
      const b = document.getElementById("wbBody");
      const txt = (b.textContent || "").replace(/\s+/g, " ");
      const star = b.querySelector(".wb-star-n");
      return { txt, star: star ? star.textContent : "", links: Array.from(b.querySelectorAll(".wb-btn")).map((x) => x.textContent.trim()) };
    });
    ok("星数读得出来（或如实标不可读，不谎报 0）", /[\d,]+\s*(星|stars)|暂不可读|unavailable|读取中/i.test(about.star), "star=" + about.star);
    ok("GitHub 行有仓库页与问题列表入口", about.links.some((x) => /仓库|Repository/i.test(x)) && about.links.some((x) => /问题|Issues/i.test(x)), J(about.links));
    ok("开发者姓名与角色在位", /潘裕丰|Pan Yufeng/.test(about.txt) && /独立开发者|Independent developer/.test(about.txt), about.txt.slice(0, 160));
    ok("邮箱与微信号在位", about.txt.includes("2818932783@qq.com") && about.txt.includes("anlan_0725"), about.txt.slice(0, 200));
    ok("中文态关于页量得到成串中文（尺子有效）", (await page.evaluate(() => window.__cjk("#wbBody"))).length >= 8,
      "实测 " + (await page.evaluate(() => window.__cjk("#wbBody"))).length + " 条");
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("#wbBody .wb-btn")).filter((x) => /复制|Copy/i.test(x.textContent));
      b.forEach((x) => x.click());
    });
    await wait(300);
    const copied = await page.evaluate(() => window.__copied.slice());
    ok("点复制写进剪贴板的是那两串本身", copied.includes("2818932783@qq.com") && copied.includes("anlan_0725"), J(copied));
    await page.evaluate(() => setLang("en"));
    await wait(600);
    const aboutEn = await page.evaluate(() => ({ txt: (document.getElementById("wbBody").textContent || "").replace(/\s+/g, " "), cjk: window.__cjk("#wbBody") }));
    ok("EN 态关于页零残留中文", aboutEn.cjk.length === 0, J(aboutEn.cjk.slice(0, 6)));
    ok("EN 态开发者名字用罗马字（不是把汉字留着）", /Pan Yufeng/.test(aboutEn.txt) && !/潘裕丰/.test(aboutEn.txt), aboutEn.txt.slice(0, 160));
    await page.screenshot({ path: path.join(OUT, "gearmenu_about_en.png") });
    await page.evaluate(() => { setLang("zh"); window.closeWorkbench(); });
    await wait(400);

    section("⑥ 版面：窄窗口不许溢出");
    for (const [w, h] of [[1440, 900], [1100, 800], [900, 700]]) {
      await page.setViewportSize({ width: w, height: h });
      await wait(260);
      await clickGear();
      await wait(240);
      await page.click('.gm-row[data-gm="github"]');
      await wait(320);
      const box = await page.evaluate(() => {
        const el = document.getElementById("gearMenu");
        const r = el.getBoundingClientRect();
        let spill = 0;
        el.querySelectorAll(".gm-name").forEach((n) => { spill = Math.max(spill, n.scrollWidth - n.clientWidth); });
        return { right: Math.round(r.right), bottom: Math.round(r.bottom), iw: window.innerWidth, ih: window.innerHeight, spill, shown: window.__vis("#gearMenu").shown };
      });
      ok(w + "×" + h + "：抽屉在视口内", box.shown && box.right <= box.iw + 1 && box.bottom <= box.ih + 1, J(box));
      ok(w + "×" + h + "：行名没有被裁字", box.spill <= 1, "溢出像素=" + box.spill);
      await page.evaluate(() => window.closeGearMenu());
      await wait(160);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await wait(200);
    await clickGear();
    await wait(260);
    await page.screenshot({ path: path.join(OUT, "gearmenu_zh.png") });

    ok("全程无 JS 报错", realErrors().length === 0, realErrors().slice(0, 3).join(" | "));
    await page.evaluate(() => { if (window.__realOpen) window.open = window.__realOpen; });
  } catch (e) {
    ok("探针自身跑通（未中途抛错）", false, String((e && e.stack) || e).slice(0, 400));
  } finally {
    await browser.close();
    child.kill();
  }
  console.log("\n[gearmenu] 结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { console.log("  失败项：\n   - " + fails.join("\n   - ")); process.exit(1); }
  process.exit(0);
})();
