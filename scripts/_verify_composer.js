/* ============================================================
   审查项 F09 + F10 验收：发送状态机 与 键盘入口优先级
   ————————————————————————————————————————————————————
   这两条在报告里都是"实测出来的"，所以验收也只认浏览器里真按一次键：
   F09 —— 连接没开时点发送，旧版先把输入框清空、send 再静默不做事，
          人看到的就是"字没了、消息也没出去"；审批按钮同理，先标"已批准"再禁用，
          用户连重试的机会都没有，而 Agent 那边还卡在等确认。
   F10 —— Enter 挂了两遍：斜杠菜单开着按 Enter，先被"Enter 就发"抢走，
          菜单补全随后才跑；合成 isComposing 的 Enter 也一样把半截输入发出去。

   怎么把"连接没开"造出来：在页面自己的 WebSocket 实例上把 readyState 改成 3，
   真的 socket 还活着（不会触发重连风暴），而 app.js 的 send() 走的就是那条判据。
   同时把 ws.send 换成记账版，判据看的是"到底有没有 frame 交出去"，不是界面上的字。

   ⚠ 输入法那几条是浏览器事件通路验证（KeyboardEvent 带 isComposing / keyCode 229），
     不等于用真 Windows 中文输入法人工确认候选词 —— 报告里也是这么写的，这里不夸大。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const sb = require("./_sandbox").create({
  tag: "composer",
  wsFiles: { "README.md": "# demo\n\n一支给 @ 引用用的文件。\n", "src/app.js": "console.log(1);\n" },
});

const { chromium } = require("playwright");
const PORT = Number(process.env.PORT || 8862);
const REPO = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

const child = spawnServer();
function spawnServer() {
  const { spawn } = require("child_process");
  return spawn(process.execPath, ["server/index.js"], {
    cwd: REPO,
    env: sb.env({ PORT: String(PORT), AGENT_FAST: "1", CURSORWEB_ENGINE: "demo", NODE_NO_WARNINGS: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
}
let childLog = "";
child.stdout.on("data", (d) => { childLog += d; });
child.stderr.on("data", (d) => { childLog += d; });

/* 记账 + 可控"断线"：包住构造器，只改这一个实例的 readyState，别的都不动。
   另外把"入站"整扇掐掉（mute）：这条探针判的是**发出去没有 + 本地状态对不对**，
   不需要服务端回包。不掐的话第一发 chat 会让界面进入 running，
   而 running 时 #btnSend 会被换成「停止」按钮（onclick 改成发 abort），
   后面每一次点按钮测的都不是发送路径了 —— 那是最容易骗过自己的一种假绿。 */
const INIT_SCRIPT = `(
  function () {
    try {
      const Orig = window.WebSocket;
      window.__pc = { frames: [], dead: false, mute: false, ws: null };
      function Wrapped(url, protos) {
        const s = new Orig(url, protos);
        window.__pc.ws = s;
        const pd = Object.getOwnPropertyDescriptor(Orig.prototype, "readyState");
        Object.defineProperty(s, "readyState", {
          configurable: true,
          get() { return window.__pc.dead ? 3 : (pd && pd.get ? pd.get.call(s) : 1); },
        });
        const origSend = s.send.bind(s);
        s.send = (m) => {
          if (window.__pc.dead) throw new Error("probe: socket 处于人为断开态，不该走到这里");
          window.__pc.frames.push(String(m));
          return origSend(m);
        };
        /* 入站只保留握手期那几条（hello/conv.list/ctx.query…），跑起来之后一律吞掉：
           靠 agent.state 那类"界面该切成 running"的信号被吞来实现。 */
        const omDesc = Object.getOwnPropertyDescriptor(Orig.prototype, "onmessage");
        let handler = null;
        Object.defineProperty(s, "onmessage", {
          configurable: true,
          get() { return handler; },
          set(fn) {
            handler = function (ev) {
              if (window.__pc.mute) {
                let type = "";
                try { type = JSON.parse(ev.data).type; } catch (e) {}
                if (/^(agent\\.|tool\\.|think\\.|msg\\.|token|user\\.msg|plan\\.|fs\\.sync|changes|goal\\.)/.test(type)) return;
              }
              return fn.apply(s, arguments);
            };
            if (omDesc && omDesc.set) omDesc.set.call(s, handler);
            else s.addEventListener("message", handler);
          },
        });
        return s;
      }
      Wrapped.prototype = Orig.prototype;
      window.WebSocket = Wrapped;
    } catch (e) { window.__pcInitError = String(e); }
  }
)()`;

async function waitServer(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const val = (page) => page.evaluate(() => document.getElementById("chatInput").value);
const framesOf = (page, type) => page.evaluate((t) =>
  window.__pc.frames.filter((f) => { try { return JSON.parse(f).type === t; } catch (e) { return false; } }).map((f) => JSON.parse(f)), type);
const setDead = (page, d) => page.evaluate((v) => { window.__pc.dead = v; }, d);
const menuState = (page) => page.evaluate(() => {
  // 两个补全菜单都是 body 上的 .at-menu（@ 与斜杠），靠可见性与内容区分
  const lists = Array.from(document.querySelectorAll("body > .at-menu"));
  return lists.map((el) => ({
    visible: el.style.display !== "none",
    items: Array.from(el.querySelectorAll(".at-item")).length,
    active: Array.from(el.querySelectorAll(".at-item")).findIndex((x) => x.classList.contains("active")),
    text: (el.textContent || "").slice(0, 60),
  }));
});

(async () => {
  if (!await waitServer(25000)) { console.log(childLog.slice(-2500)); throw new Error("服务端没起来（端口 " + PORT + "）"); }
  const base = `http://127.0.0.1:${PORT}`;
  const user = "composer_" + Date.now();
  const authOpts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: "test1234" }) };
  await fetch(base + "/api/auth/register", authOpts).catch(() => {});
  const token = await fetch(base + "/api/auth/login", authOpts).then((r) => r.json()).then((j) => j.token || "").catch(() => "");

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  await page.addInitScript((t) => {
    try { localStorage.setItem("cw-user-token", t); localStorage.setItem("cw-onboarded", "1"); } catch (e) {}
  }, token);
  await page.addInitScript(INIT_SCRIPT);
  await page.goto(base + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => !!document.getElementById("chatInput"), { timeout: 20000 });
  // WS 真连上了才开始：否则第一轮判据测的是"还没连上"，会把 F09 的正向对照弄成假绿
  await page.waitForFunction(() => !!window.__pc && !!window.__pc.ws && window.__pc.ws.readyState === 1, { timeout: 20000 });

  section("① 正向对照：连着的时候 Enter 真的发得出去");
  // 先把服务端回包吞掉（见 INIT_SCRIPT 那段），否则这一发之后按钮就变成「停止」了
  await page.evaluate(() => { window.__pc.mute = true; });
  await page.click("#chatInput");
  await page.keyboard.type("连着发的一条");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const chat1 = await framesOf(page, "chat");
  ok("发出了一条 chat", chat1.some((f) => f.text === "连着发的一条"), JSON.stringify(chat1).slice(0, 160));
  ok("发出去之后输入框才清空", (await val(page)) === "", "输入框还剩：" + await val(page));
  /* 夹具自己的对照：点 #btnSend 的那几段，测的必须还是"发送"这颗按钮。
     running 态下它会被换成 abort（onclick 重写），那时后面的判据全在测另一条路。 */
  ok("发送按钮还在「发送」态（没有被 running 换成停止）",
    await page.evaluate(() => !document.getElementById("btnSend").classList.contains("stop-mode")),
    await page.evaluate(() => document.getElementById("btnSend").className));

  section("② F09：连接没开时点发送，草稿必须还在");
  await setDead(page, true);
  const before2 = (await framesOf(page, "chat")).length;
  await page.keyboard.type("断线时的草稿");
  await page.click("#btnSend");
  await page.waitForTimeout(300);
  ok("没有任何 chat frame 交出去", (await framesOf(page, "chat")).length === before2,
    "多出 " + ((await framesOf(page, "chat")).length - before2) + " 条");
  ok("输入框里草稿原样保留", (await val(page)) === "断线时的草稿", "实际：" + await val(page));
  const warnLine = await page.evaluate(() => {
    const el = document.querySelector("#terminal, .terminal, #termBody");
    return el ? (el.textContent || "") : document.body.textContent;
  });
  ok("界面如实说了「没有发出，草稿已保留」", /没有发出[\s\S]{0,40}草稿已为你保留|没有发出，草稿/.test(warnLine),
    warnLine.slice(-200));

  section("③ F09：连回来再点一次，只执行一遍");
  await setDead(page, false);
  await page.click("#btnSend");
  await page.waitForTimeout(300);
  const chats3 = await framesOf(page, "chat");
  const sent3 = chats3.filter((f) => f.text === "断线时的草稿");
  ok("失败的那条恢复后真的发出去了", sent3.length === 1, "命中 " + sent3.length + " 条");
  ok("重发没有变成双份（总 chat 数只 +1）", chats3.length === before2 + 1, "总数 " + chats3.length + " / 期望 " + (before2 + 1));
  ok("发出去后输入框清空", (await val(page)) === "", "实际：" + await val(page));

  section("④ F09：审批卡没发出去时不许标成「已批准」");
  /* 事件类型是 tool.pending（app.js 里 renderApproval 挂在它下面）。
     convId 故意不给：给了一个不存在的会话，卡片会落进那条会话的 pane 里，
     页面上根本看不见，判据就变成"在空气里点按钮"。 */
  await page.evaluate(() => {
    window.handleEvent({ type: "tool.pending", id: "probe-ap-1", tool: "write_file", preview: { path: "a.js", lines: 3, preview: "line1\nline2\nline3" } });
  });
  await page.waitForTimeout(200);
  const cardSel = '.tool-card.approval .btn-approve[data-id="probe-ap-1"], .tool-card .btn-approve[data-id="probe-ap-1"]';
  ok("审批卡渲染出来了", !!(await page.$(cardSel)), "选择器：" + cardSel);
  await setDead(page, true);
  /* 点不动也要继续跑：老代码在这里已经把按钮禁掉了（它先标"已批准"再 lock()），
     Playwright 默认会等 enabled 而超时抛错，探针整支死在这一步 ——
     判据要看的是"状态文案 + 按钮还有没有可点"，所以这里把点击失败也当成一种读数。 */
  const clicks = [];
  for (let i = 0; i < 3; i++) {
    let clicked = true;
    await page.click(cardSel, { timeout: 2500 }).catch(() => { clicked = false; });
    clicks.push(clicked);
    await page.waitForTimeout(80);
  }
  const approves4 = await framesOf(page, "tool.approve");
  ok("断线时连点三次批准，一条也没出去", approves4.length === 0, "实际 " + approves4.length + " 条");
  const st4 = await page.evaluate(() => {
    const card = document.querySelector('.tool-card[data-approval-id="probe-ap-1"]') ||
      Array.from(document.querySelectorAll(".tool-card")).find((c) => c.querySelector('.btn-approve[data-id="probe-ap-1"]'));
    return {
      status: card ? (card.querySelector(".t-status") || {}).textContent : "(找不到卡片)",
      disabled: card ? Array.from(card.querySelectorAll(".approval-actions button")).map((b) => !!b.disabled) : [],
    };
  });
  ok("状态写的是「没有发出去，可重试」而不是「已批准」", /没有发出去/.test(st4.status || ""), "状态：" + st4.status);
  ok("按钮没有被禁用（还有重试机会）", st4.disabled.length > 0 && st4.disabled.every((d) => !d),
    JSON.stringify(st4.disabled));

  section("⑤ F09：连回来点一次就锁死，不许重复执行");
  await setDead(page, false);
  // 点不动本身就是这一条的失败（老代码在这里已经先把按钮锁了），所以不让它把探针整支带崩
  let clickable = true;
  await page.click(cardSel, { timeout: 4000 }).catch(() => { clickable = false; });
  await page.waitForTimeout(300);
  const approves5 = await framesOf(page, "tool.approve");
  ok("批准后恰好发出一条 tool.approve", clickable && approves5.length === 1 && approves5[0].id === "probe-ap-1",
    (clickable ? "" : "按钮已点不动（没有重试机会）· ") + JSON.stringify(approves5).slice(0, 200));
  const st5 = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll(".tool-card")).find((c) => c.querySelector('.btn-approve[data-id="probe-ap-1"]'));
    return {
      status: card ? (card.querySelector(".t-status") || {}).textContent : "(找不到卡片)",
      disabled: card ? Array.from(card.querySelectorAll(".approval-actions button")).map((b) => !!b.disabled) : [],
    };
  });
  ok("受理后标成已批准并禁用按钮", /已批准/.test(st5.status || "") && st5.disabled.every(Boolean),
    st5.status + " · " + JSON.stringify(st5.disabled));
  await page.click(cardSel).catch(() => {});      // 按钮已禁用，这里点不动才是对的
  await page.waitForTimeout(200);
  ok("重复点击不会二次执行", (await framesOf(page, "tool.approve")).length === 1,
    "实际 " + (await framesOf(page, "tool.approve")).length + " 条");

  section("⑥ F10：斜杠菜单开着时 Enter 是「选」，不是「发」");
  await page.evaluate(() => { document.getElementById("chatInput").value = ""; });
  await page.click("#chatInput");
  const beforeChat6 = (await framesOf(page, "chat")).length;
  await page.keyboard.type("/review");
  await page.waitForTimeout(250);
  const m6 = await menuState(page);
  ok("输入 /review 后补全菜单可见", m6.some((x) => x.visible && x.items > 0), JSON.stringify(m6));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  ok("Enter 没有把原始 /review 发出去", (await framesOf(page, "chat")).length === beforeChat6,
    "多出 " + ((await framesOf(page, "chat")).length - beforeChat6) + " 条");
  const v6 = await val(page);
  ok("Enter 填的是展开后的审查提示词", /代码审查|审查/.test(v6) && !/^\/review$/.test(v6), "输入框：" + v6.slice(0, 60));
  ok("菜单已经收起", !(await menuState(page)).some((x) => x.visible), JSON.stringify(await menuState(page)));

  section("⑦ F10：方向键与 Escape 归菜单");
  await page.evaluate(() => { document.getElementById("chatInput").value = ""; });
  await page.click("#chatInput");
  await page.keyboard.type("/");
  await page.waitForTimeout(250);
  const m7a = (await menuState(page)).find((x) => x.visible);
  ok("单独一个 / 就列出全部命令", !!m7a && m7a.items >= 5, JSON.stringify(m7a));
  ok("默认高亮第一条", !!m7a && m7a.active === 0, "active=" + (m7a && m7a.active));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(150);
  const m7b = (await menuState(page)).find((x) => x.visible);
  ok("ArrowDown 把高亮移到第二条", !!m7b && m7b.active === 1, "active=" + (m7b && m7b.active));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  ok("Escape 关闭菜单（再按 Enter 才是发送）", !(await menuState(page)).some((x) => x.visible),
    JSON.stringify(await menuState(page)));

  section("⑧ F10：@ 引用菜单同样优先于发送");
  await page.evaluate(() => { document.getElementById("chatInput").value = ""; });
  await page.click("#chatInput");
  const beforeChat8 = (await framesOf(page, "chat")).length;
  await page.keyboard.type("@READ");
  await page.waitForTimeout(600);
  const m8 = (await menuState(page)).find((x) => x.visible);
  ok("@READ 列出候选文件", !!m8 && m8.items > 0, JSON.stringify(m8));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  ok("Enter 选文件而不是发送", (await framesOf(page, "chat")).length === beforeChat8,
    "多出 " + ((await framesOf(page, "chat")).length - beforeChat8) + " 条");
  ok("输入框里是被选中的 @ 引用", /@file:README\.md/.test(await val(page)), "输入框：" + await val(page));

  section("⑨ F10：输入法组合态的 Enter 不算发送（事件通路）");
  await page.evaluate(() => { document.getElementById("chatInput").value = ""; });
  await page.click("#chatInput");
  await page.keyboard.type("IME哨兵");
  const beforeChat9 = (await framesOf(page, "chat")).length;
  const ime = await page.evaluate(() => {
    const ta = document.getElementById("chatInput");
    const a = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true });
    ta.dispatchEvent(a);
    const b = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(b, "keyCode", { value: 229 });
    Object.defineProperty(b, "isComposing", { value: false });
    ta.dispatchEvent(b);
    return { preventedA: a.defaultPrevented, preventedB: b.defaultPrevented };
  });
  await page.waitForTimeout(250);
  ok("isComposing=true 的 Enter 没有发出去", (await framesOf(page, "chat")).length === beforeChat9,
    "多出 " + ((await framesOf(page, "chat")).length - beforeChat9) + " 条");
  ok("只给 keyCode 229 的老输入法也拦得住", JSON.stringify(ime) !== "" && (await framesOf(page, "chat")).length === beforeChat9,
    JSON.stringify(ime));
  ok("半截输入还留在输入框里", (await val(page)) === "IME哨兵", "实际：" + await val(page));

  section("⑩ 边界：Shift+Enter 换行、空输入不发送");
  await page.evaluate(() => { document.getElementById("chatInput").value = ""; });
  await page.click("#chatInput");
  await page.keyboard.type("第一行");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("第二行");
  await page.waitForTimeout(200);
  const v10 = await val(page);
  ok("Shift+Enter 插了换行而不是发送", /\n/.test(v10) && v10 === "第一行\n第二行", JSON.stringify(v10));
  const beforeChat10 = (await framesOf(page, "chat")).length;
  await page.evaluate(() => { document.getElementById("chatInput").value = "   "; });
  await page.click("#chatInput");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  ok("全是空白的输入按 Enter 不发", (await framesOf(page, "chat")).length === beforeChat10,
    "多出 " + ((await framesOf(page, "chat")).length - beforeChat10) + " 条");

  section("⑪ 这一路页面没有报错");
  const realErrs = errors.filter((e) => !/favicon|net::ERR_(INCOMPLETE|ABORTED)|Failed to load resource/i.test(e));
  ok("控制台没有页面错误", realErrs.length === 0, realErrs.slice(0, 3).join(" | "));
  ok("WebSocket 包装自己没出错", !(await page.evaluate(() => !!window.__pcInitError)),
    await page.evaluate(() => window.__pcInitError || ""));

  console.log("\n共 " + (pass + fail) + " 条，红 " + fail + " 条");
  if (fail) { console.log("失败明细：\n  - " + fails.join("\n  - ")); }
  await browser.close();
  try { child.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log("探针自身出错：" + (e && e.stack ? e.stack : e));
  console.log(childLog.slice(-1500));
  try { child.kill(); } catch (er) {}
  process.exit(1);
});
