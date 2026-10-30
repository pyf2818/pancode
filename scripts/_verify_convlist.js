/* ============================================================
   审查项 F17 验收：会话列表用元数据，DOM 当可丢弃视图
   ————————————————————————————————————————————————————
   旧形态的三笔账（都在真页面上量得出来）：
     ① convSummary() 对**每一条**会话现场 `div.innerHTML = 那份pane快照` 再 querySelector，
        渲染一次列表 = 解析全部历史正文；1000 条会话时这是纯粹的重复劳动。
     ② lsGet() 每读一次就 lsTouch→_lsSaveOrder()→localStorage.setItem ——
        "读缓存"这件事本身在写盘，一次列表渲染写 1000+ 次。
     ③ foldOldMessages 的选择器是 :scope > .msg-ai，而 AI 消息外面包着 .msg-row ——
        直属选择一条都选不中，"折叠旧消息"对着长会话其实是空转（越用越重）。
     ④ convPanes 无界：切过的每个会话都把整块 DOM 留在内存里（隐藏 ≠ 释放）。
   做法：真服务端 + 真页面 + 真 localStorage。判据全部按"它声称的那件事"量：
        解析次数用 Storage.getItem 计数、重建次数用 MutationObserver 计数、
        有界性用 convPanes 的键数与页面上 .msg-ai 的节点数。
   ============================================================ */
"use strict";
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const PORT = 8906;
const SANDBOX = require("./_sandbox").create({
  tag: "convlist",
  wsFiles: { "src/app.js": "export const a = 1;\n", "README.md": "# demo\n" },
  config: {
    agentMode: "auto",
    permissions: { mode: "auto", allow: [], deny: [] },
    llm: { baseURL: "http://127.0.0.1:8907/v1", apiKey: "fake-key", model: "fake-model" },
  },
});

const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const fails = [];
const metrics = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
function measure(name, value, unit) { metrics.push({ name, value, unit }); console.log("  \x1b[36m◦\x1b[0m " + name + "：\x1b[1m" + value + "\x1b[0m " + unit); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 300); } catch (e) { return String(v).slice(0, 300); } };

function req(method, urlPath, body, token) {
  const data = body == null ? null : JSON.stringify(body);
  const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
  if (token) headers["x-user-token"] = token;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 30000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, json: { raw: buf.slice(0, 200) } }); } });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const env = SANDBOX.env({ PORT: String(PORT), HOME: path.join(SANDBOX.root, "home"), USERPROFILE: path.join(SANDBOX.root, "home") });
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], { cwd: ROOT, env, windowsHide: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) { if (out.includes("已启动")) break; await wait(150); }
  if (!out.includes("已启动")) throw new Error("服务端没起来：" + out.slice(-400));

  const reg = await req("POST", "/api/auth/register", { username: "_cl_" + Date.now(), password: "test1234" });
  const token = reg.json && reg.json.token;
  if (!token) throw new Error("注册失败：" + J(reg.json));

  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--enable-precise-memory-info"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErr = [];
  page.on("pageerror", (e) => pageErr.push(String(e && e.message)));
  await page.addInitScript((tk) => { try { localStorage.setItem("cw-user-token", tk); localStorage.setItem("cw-onboarded", "1"); } catch (e) {} }, token);
  await page.goto("http://127.0.0.1:" + PORT + "/", { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => typeof renderConvList === "function" && typeof convListKey === "function" && typeof loadConvList === "function", null, { timeout: 30000 });

  /* 造 1000 条会话：其中
     · meta 条（新格式，带 summary）——列表该直接显示它，不必解析任何历史 DOM；
     · legacy 条（老格式，正文嵌在记录里的 dom 字段）——迁移必须逐字保住正文；
     · odd 条（带一个产品不认识的字段 mystery，也没有 summary）——不许被"顺手清掉"。 */
  const SEED = await page.evaluate(() => {
    const N = 1000;
    const list = [];
    const now = Date.now();
    for (let i = 0; i < N; i++) {
      list.push({ id: "m" + i, title: "会话 " + i, ts: now - i * 60000, summary: "这是第 " + i + " 条会话的摘要元数据" });
    }
    const legacyBody = '<div class="msg-row ans-row"><div class="msg msg-ai">旧格式正文 NEEDLE-LEGACY</div></div>';
    list.push({ id: "legacy1", title: "旧格式一条", ts: now - 90000, dom: legacyBody });
    list.push({ id: "odd1", title: "不认识的记录", ts: now - 91000, mystery: { keep: "me" }, customAt: 12345 });
    lsSet(convListKey(), JSON.stringify(list));
    return { n: loadConvList().length, key: convListKey() };
  });

  try {
    section("① 前提：列表真的灌进去了（阳性对照）");
    ok("1002 条会话记录进了存储", SEED.n === 1002, "实际 " + SEED.n);
    const rows0 = await page.evaluate(() => { renderConvList(); return document.querySelectorAll("#agSessionList .ag-session").length; });
    ok("界面真的把 1002 条都列出来了（不是截几条装装样子）", rows0 >= 1000, "行数=" + rows0);

    section("② 摘要来自记录元数据：渲染一次列表不该再解析全部历史");
    const cnt = await page.evaluate(() => {
      let reads = 0, writes = 0;
      const gi = Storage.prototype.getItem, si = Storage.prototype.setItem;
      Storage.prototype.getItem = function (k) { reads++; return gi.call(this, k); };
      Storage.prototype.setItem = function (k, v) { writes++; return si.call(this, k, v); };
      const t = performance.now();
      renderConvList();
      const ms = performance.now() - t;
      Storage.prototype.getItem = gi; Storage.prototype.setItem = si;
      return { reads, writes, ms: Math.round(ms) };
    });
    measure("1002 条 · 一次列表渲染耗时", cnt.ms, "ms");
    measure("1002 条 · 一次列表渲染的 localStorage 读", cnt.reads, "次");
    measure("1002 条 · 一次列表渲染的 localStorage 写", cnt.writes, "次");
    ok("摘要直接取自记录：界面里能看到那条 metadata 文案",
      await page.evaluate(() => { const el = document.querySelector("#agSessionList .ag-sess-summary"); return !!el && /摘要元数据/.test(el.textContent); }) === true, "");
    ok("渲染一次列表不再逐条解析历史 DOM（localStorage 读次数不随会话数线性增长）",
      cnt.reads < 200, "读了 " + cnt.reads + " 次（会话数 1002）");
    ok("读缓存不再写 localStorage（一次渲染的同步写次数收敛在个位数）",
      cnt.writes <= 9, "写了 " + cnt.writes + " 次");

    section("③ 迁移：旧格式正文与不认识的字段一个都不许丢");
    const mig = await page.evaluate(() => {
      const list = loadConvList();
      const legacy = list.find((c) => c.id === "legacy1");
      const odd = list.find((c) => c.id === "odd1");
      let dom = "";
      try { dom = loadConvDom("legacy1") || ""; } catch (e) {}
      return {
        legacyAlive: !!legacy, legacyNoEmbeddedDom: !!legacy && legacy.dom === undefined,
        domKept: /NEEDLE-LEGACY/.test(dom),
        oddAlive: !!odd, mysteryKept: !!(odd && odd.mystery && odd.mystery.keep === "me"), customKept: !!(odd && odd.customAt === 12345),
        count: list.length,
      };
    });
    ok("旧格式那条的正文搬到了分离存储且逐字还在", mig.legacyAlive && mig.domKept, J(mig));
    ok("搬完之后记录里不再嵌着整块 HTML（列表记录瘦下来）", mig.legacyNoEmbeddedDom === true, J(mig));
    ok("带未知字段的记录没有被「顺手清掉」（迁移是可回退的，不是重洗）",
      mig.oddAlive && mig.mysteryKept && mig.customKept, J(mig));
    ok("一条都没少（1002 条还在）", mig.count === 1002, "现在 " + mig.count + " 条");

    section("④ 输入搜索：整表重建的次数要收敛");
    const search = await page.evaluate(async () => {
      /* 数"重建了几次整表"要数 renderConvList 本身。
         用 MutationObserver 数 childList 是另一个口径：一次重建会连着产生
         "清空 + 逐行 append"好几条记录（1002 行时更多），13 条记录 ≠ 13 次重建。 */
      const orig = window.renderConvList;
      let calls = 0;
      window.renderConvList = function () { calls++; return orig.apply(this, arguments); };
      const host = document.getElementById("agSessionList");
      let childMut = 0;
      const mo = new MutationObserver((rs) => { for (const r of rs) if (r.type === "childList") childMut++; });
      mo.observe(host, { childList: true });
      const box = document.getElementById("convSearch");
      const t = performance.now();
      const q = "会话 12";
      for (const ch of q) {
        box.value += ch;
        box.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 16));
      }
      await new Promise((r) => setTimeout(r, 260));
      mo.disconnect();
      window.renderConvList = orig;
      const rows = host.querySelectorAll(".ag-session").length;
      const shown = Array.prototype.map.call(host.querySelectorAll(".ag-sess-name"), (x) => x.textContent);
      return { calls, childMut, rows, ms: Math.round(performance.now() - t), sample: shown.slice(0, 3), allMatch: shown.every((s) => s.indexOf(q) >= 0) };
    });
    measure("输入 6 个字符 · 整表重建次数", search.calls, "次");
    measure("输入 6 个字符 · 列表容器增删批次", search.childMut, "批");
    measure("输入 6 个字符 · 到过滤结果上屏", search.ms, "ms");
    ok("过滤结果是对的（剩下的行都含关键词）", search.allMatch && search.rows >= 1 && search.rows < 1002, J({ rows: search.rows, sample: search.sample }));
    ok("逐字符输入既没有每次都重建，也没有干脆不重建（旧代码：按一键重建一次 1002 行）",
      search.calls >= 1 && search.calls <= 2, "重建了 " + search.calls + " 次（按了 6 键）");

    section("⑤ 折叠：包在 .msg-row 里的消息也要真折叠");
    const fold = await page.evaluate(() => {
      const id = convId;
      const pane = convPanes[id] || (hydratePane(id, ""), convPanes[id]);
      if (pane) pane.innerHTML = "";
      const one = (n) => '<div class="msg-row ans-row"><div class="msg msg-ai">第' + n + '条回答，正文够长以便被折叠。' + "x".repeat(80) + "</div></div>";
      const frag = document.createElement("div");
      frag.innerHTML = Array.from({ length: 100 }, (unused, i) => one(i)).join("");
      while (frag.firstChild) pane.appendChild(frag.firstChild);
      foldOldMessages();
      const body = pane.querySelector(".fold-old .fold-old-body");
      return {
        container: !!pane.querySelector(".fold-old"),
        foldedRows: body ? body.querySelectorAll(".msg-row").length : 0,
        foldedMsgs: body ? body.querySelectorAll(".msg-ai").length : 0,
        totalMsgs: pane.querySelectorAll(".msg-ai").length,
      };
    });
    ok("折叠容器出现了（旧代码：:scope > .msg-ai 一条都选不中，这里根本没容器）",
      fold.container === true, J(fold));
    ok("折叠的是整行（.msg-row 进了折叠区，不是空气）", fold.foldedRows >= 30, "折叠了 " + fold.foldedRows + " 行");
    ok("折叠不是删除：100 条回答一条都没少（只是被收起来）",
      fold.totalMsgs === 100 && fold.foldedMsgs === fold.foldedRows, J(fold));

    /* 单会话 1000 条：这条量的是"折叠到底有没有生效 + 有没有吞掉消息"。
       一次调用只收 FOLD_BATCH=30 条是产品本来的分批策略（本轮没改它，也不该改），
       所以这里断言"直接摊着的行数确实小于总数"，而不是编一个"应当≤60"的产品不认账的界。 */
    const big = await page.evaluate(() => {
      const id = convId;
      const pane = convPanes[id];
      pane.innerHTML = "";
      const one = (n) => '<div class="msg-row ans-row"><div class="msg msg-ai">第' + n + '条</div></div>';
      const frag = document.createElement("div");
      frag.innerHTML = Array.from({ length: 1000 }, (unused, i) => one(i)).join("");
      while (frag.firstChild) pane.appendChild(frag.firstChild);
      const t = performance.now();
      foldOldMessages();
      const ms = Math.round(performance.now() - t);
      const direct = pane.querySelectorAll(":scope > .msg-row").length;
      return { direct: direct, total: pane.querySelectorAll(".msg-ai").length, ms: ms };
    });
    measure("单会话 1000 条 · 一次折叠后摊在外面的整行数", big.direct, "行");
    measure("单会话 1000 条 · 一次折叠耗时", big.ms, "ms");
    ok("1000 条的长会话折叠真的收走了整行（旧代码一条都没收），且 1000 条一条没丢",
      big.direct < 1000 && big.total === 1000, J(big));

    section("⑥ 热 pane 有界 + 会话往返：切过去还得有内容");
    const round = await page.evaluate(async () => {
      const ids = [];
      for (let i = 0; i < 24; i++) ids.push("m" + i);
      /* 每个会话先备一份快照，模拟"从历史里逐个回看" */
      for (const id of ids) {
        saveConvDom(id, '<div class="msg-row ans-row"><div class="msg msg-ai">会话 ' + id + " 的历史正文</div></div>");
      }
      for (const id of ids) { openConv(id); await new Promise((r) => setTimeout(r, 8)); }
      const keys = Object.keys(convPanes).length;
      const aiNodes = document.querySelectorAll(".msg-ai").length;
      /* 切回第一个：被挤掉的那个必须从快照里 hydrate 回来 */
      openConv(ids[0]);
      await new Promise((r) => setTimeout(r, 120));
      const backText = (convPanes[ids[0]] || { textContent: "" }).textContent;
      return { keys, aiNodes, backOk: backText.indexOf("会话 m0 的历史正文") >= 0 };
    });
    measure("24 次会话往返 · 常驻 pane 数", round.keys, "个");
    measure("24 次会话往返 · 页面上 .msg-ai 节点", round.aiNodes, "个");
    ok("常驻 pane 数量有界（不是切多少个就留多少个）", round.keys <= 8, "常驻 " + round.keys + " 个");
    ok("被挤掉的会话切回来仍有正文（从快照 hydrate，不是空白）", round.backOk === true, J(round));

    section("⑦ 历史快照里的 widget 代码块：恢复时升级成卡片");
    /* 修复前落下的快照长什么样：Worker 那条路把闭合的 widget 块画成了 <pre class="widget">。
       快照内容用真 Worker 现生成，不手抄形状——手抄的形状可能早就跟产品对不上了。 */
    const hyd = await page.evaluate(async () => {
      const SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'><rect width='24' height='24' fill='#0af'/></svg>";
      const src = "架构图：\n\n```widget\n" + SVG + "\n```\n\n" +
        "```js\nconst a = 1;\n```\n\n" +
        "```svg\n<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>\n```\n\n" +
        "```svg\n<svg xmlns='http://www.w3.org/2000/svg'><rect/>\n```";
      const w = new Worker("/js/md-worker.js");
      const html = await new Promise((res, rej) => {
        w.onmessage = (e) => res(e.data.html);
        w.onerror = (e) => rej(new Error("md-worker 起不来：" + (e && e.message)));
        w.postMessage({ id: 1, src: src });
      });
      w.terminate();
      const id = "hydw-" + Date.now();
      saveConvDom(id, '<div class="msg-row ans-row"><div class="msg msg-ai">' + html + "</div></div>");
      hydratePane(id, loadConvDom(id));
      const p = convPanes[id];
      const out = {
        degradedPre: (html.match(/pre class="widget"/g) || []).length,
        widget: p.querySelectorAll(".msg-widget").length,
        iframes: p.querySelectorAll("iframe").length,
        pre: p.querySelectorAll("pre").length,
        jsKept: !!p.querySelector("pre.js"),
        svgIncompleteKept: p.querySelectorAll("pre.svg").length,
      };
      deleteConvDom(id);
      dropConvCtx(id);
      return out;
    });
    ok("前提：快照里的 widget 确实是降级成代码块存下来的（阳性对照）", hyd.degradedPre === 1, J(hyd));
    ok("恢复后 widget 与完整 SVG 都按原文重建成了卡片（iframe 也在）", hyd.widget === 2 && hyd.iframes >= 2, J(hyd));
    ok("不该动的保持原样：普通代码块和没画完的 SVG 仍是代码", hyd.jsKept && hyd.svgIncompleteKept === 1 && hyd.pre === 2, J(hyd));

    ok("全程页面没有报错", pageErr.length === 0, pageErr.slice(0, 3).join(" | "));
  } catch (e) {
    ok("探针整条链路没抛错", false, (e && e.stack ? e.stack : String(e)).slice(0, 400));
  } finally {
    console.log("\n\x1b[1m量到的数\x1b[0m");
    for (const m of metrics) console.log("  " + m.name + " = " + m.value + " " + m.unit);
    console.log("\n共 " + (pass + fail) + " 条，红 " + fail + " 条");
    if (fail) { console.log("\n失败明细："); fails.forEach((f, i) => console.log("  " + (i + 1) + ". " + f)); }
    try { await browser.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    SANDBOX.cleanup();
    process.exit(fail ? 1 : 0);
  }
})();
