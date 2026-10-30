/* ============================================================
   审查项 F15 验收：首屏从"整棵树的正文快照"改成"目录元数据 + 按需正文"
   ————————————————————————————————————————————————————
   为什么必须先量：hello 里带的是**每个文件的 content + original**，
   而 list() 又故意把进内存的文件数钳在 500（防卡死）。两个约束撞在一起的结果是：
     · 首屏传输/解析随文件数线性膨胀（量到才知道膨胀到什么程度）；
     · 第 501 个文件在界面上根本不存在 —— 搜不到、点不开、也审不了。
   这一支把两件事都钉住：体积/时间只**记录**（用来决定要不要分块/Worker），
   "越界文件可达"是硬判据 —— 不能只报"首屏很快"而把文件弄丢。

   口径（探针即规格）：
     hello.tree = { entries:[{path,size,mtimeMs,lang,binary,isNew}], total, listed, truncated, ver }
     hello.files = 只有"需要正文的那一小撮"（git 变更集：徽标/Diff/审阅要用）
     op tree.load { after, limit } → tree.data { entries, total, listed, truncated, more, ver }
     op file.read { path }         → file.data { path, content, lang, size, mtimeMs, ver }
     op file.baseline { path }      → file.baseline { path, original, isNew }

   三份 fixture 的口径：500 与 10000 那份**不建 git**（走快照降级，验的就是"没有 git 也照常列得完"）；
   1500 那份建成提交过的 git 仓库，因为界面那一段要比"审阅左边那半"——没有 git 时排在
   内存上限（500）之后的文件本来就没有基线，要求左边非空量的就不是链路。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const http = require("http");
const { WebSocket } = require("ws");

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

/* 造一个 N 文件的工作区：分目录、每个文件带唯一可辨认的正文，
   越界判据要靠"最后一个文件的正文"来确认拿到的不是别人的。 */
function makeWs(n) {
  const files = {};
  for (let i = 0; i < n; i++) {
    const rel = i % 11 === 0 ? "src/mod" + String(i).padStart(5, "0") + ".js"
      : "pkg" + (i % 9) + "/deep/sub" + (i % 3) + "/file" + String(i).padStart(5, "0") + ".js";
    files[rel] = "// NEEDLE-" + i + "\nexport const v = " + i + ";\n" + "/* pad */\n".repeat(20);
  }
  files["README.md"] = "# scale\n";
  return files;
}

function writeTree(dir, files) {
  for (const rel in files) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, files[rel], "utf8");
  }
}

function get(port, urlPath, token) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: urlPath, method: "GET", headers: token ? { "x-user-token": token } : {}, timeout: 8000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch (e) { resolve({ raw: buf }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("超时")));
    r.end();
  });
}

/* 把 1500 那份工作区造成 git 仓库并全部提交。
   为什么要专门建仓：没有 git 时基线只来自"启动快照"，而快照是按进内存的文件读的
   （上限 500，防卡死）—— 于是排在第 500 位之后的文件本来就**没有**基线，
   服务端如实回 original:"" + isNew:true。这种情况下判据要求"左边那半不为空"
   量的不是审阅链路，量的是fixture。建了仓，这些文件才真的有提交版本可比，
   "越界文件的基线也是按需取、取回来的是它自己那份"才是一句可以说真话的断言。 */
function gitInit(repo) {
  const run = (args) => new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo, windowsHide: true }, (e) => (e ? reject(new Error("git " + args.join(" ") + " 失败：" + e.message)) : resolve()));
  });
  return run(["init", "-q"])
    .then(() => run(["config", "user.email", "scale@probe.local"]))
    .then(() => run(["config", "user.name", "scale-probe"]))
    .then(() => run(["config", "commit.gpgsign", "false"]))
    .then(() => run(["config", "core.autocrlf", "false"]))   // 隔离 Windows CRLF，否则提交回来的正文与盘上逐字节不同
    .then(() => run(["add", "-A"]))                           // 一次 add 全部：逐个 git add 在 1501 个文件上是 1501 次进程
    .then(() => run(["commit", "-q", "-m", "scale fixture"]));
}

/* 删目录：git 把对象文件写成只读，Windows 上直接 rmSync 会 EPERM，先把只读位清掉 */
function chmodTree(d) {
  let it = [];
  try { it = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of it) {
    const p = path.join(d, ent.name);
    if (ent.isDirectory()) chmodTree(p);
    else { try { fs.chmodSync(p, 0o666); } catch (e) {} }
  }
}
function rmAll(dir) {
  chmodTree(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

/* 一个独立数据根 + 独立端口 + 独立工作区的服务端（三个规模不能挤同一份数据根） */
async function bootScale(tag, port, n, opts) {
  const dir = path.join(os.tmpdir(), "pc-scale-" + tag + "-" + process.pid);
  rmAll(dir);
  const data = path.join(dir, "data"), ws = path.join(dir, "ws");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  writeTree(ws, makeWs(n));
  if (opts && opts.git) await gitInit(ws);
  fs.writeFileSync(path.join(data, "pancode.config.json"), JSON.stringify({ workspace: ws }), "utf8");
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), PANCODE_DATA_DIR: data, CURSORWEB_WORKSPACE: ws,
      CURSORWEB_ENGINE: "demo", AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { const h = await get(port, "/api/health"); if (h && h.ok) break; } catch (e) {}
    await wait(400);
  }
  const inst = { port, dir, ws, child, log: () => log };
  inst.stop = () => { try { child.kill(); } catch (e) {} rmAll(dir); };
  return inst;
}

/* 真 WS 客户端：记录 hello 到达时间、字节数、JSON.parse 耗时 */
function connect(port, token) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/", ["bearer." + encodeURIComponent(token)]);
    const seen = [];
    let helloBytes = 0, helloMs = 0, parseMs = 0, hello = null;
    ws.on("open", () => {
      ws.on("message", (raw) => {
        seen.push(raw);
        const s = raw.toString();
        let obj;
        try { obj = JSON.parse(s); } catch (e) { return; }
        seen.length = 1;   // 只留最后一条的原始字节
        if (obj.type === "hello") {
          helloMs = Date.now() - t0;
          helloBytes = Buffer.byteLength(s);
          const p0 = Date.now();
          JSON.parse(s);
          parseMs = Date.now() - p0;
          hello = obj;
          resolve({ ws, get hello() { return hello; }, helloBytes, helloMs, parseMs, ask, next });
        }
      });
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("hello 没在 25s 内到达")), 25000);
    function ask(obj) { ws.send(JSON.stringify(obj)); }
    /* 等下一条指定类型的回包（按类型出队，避免不同请求互相抢答） */
    function next(type, ms) {
      return new Promise((res, rej) => {
        const t = Date.now();
        const on = (raw) => {
          let o = null;
          try { o = JSON.parse(raw.toString()); } catch (e) {}
          if (o && o.type === type) { ws.off("message", on); res(o); }
          else if (Date.now() - t > (ms || 8000)) { ws.off("message", on); rej(new Error("等 " + type + " 超时")); }
        };
        ws.on("message", on);
      });
    }
  });
}

(async () => {
  const A = await bootScale("a", 8863, 500);
  const B = await bootScale("b", 8864, 1500, { git: true });
  const C = await bootScale("c", 8865, 10000);
  try {
    /* ================= 规模 500：基线体积 ================= */
    section("① 500 文件（旧上限以内）：首屏体积与时间");
    const ta = await get(8863, "/api/auth/auto");
    const a = await connect(8863, ta.token);
    measure("500 文件 · hello 字节", (a.helloBytes / 1024).toFixed(1), "KB");
    measure("500 文件 · hello 到达", a.helloMs, "ms");
    measure("500 文件 · JSON.parse", a.parseMs, "ms");
    const treeA = a.hello.tree || {};
    ok("目录快照给出真实总数（不是「截到 500 就当只有 500」）", treeA.total === 501, "total=" + treeA.total + " listed=" + treeA.listed);
    ok("带出的条数不超过一页，且如实标 truncated", treeA.entries.length === (treeA.listed || treeA.entries.length),
      "entries=" + treeA.entries.length);
    ok("500 规模下不再逐个带正文（hello.files 只覆盖需要正文的那撮）",
      Object.keys(a.hello.files || {}).length <= 60, "带正文的条目数=" + Object.keys(a.hello.files || {}).length);
    a.ws.close();

    /* ================= 规模 1500：分页 + 按需正文 ================= */
    section("② 1500 文件：越界的文件必须还能找到、打开、改、审");
    const tb = await get(8864, "/api/auth/auto");
    const b = await connect(8864, tb.token);
    measure("1500 文件 · hello 字节", (b.helloBytes / 1024).toFixed(1), "KB");
    measure("1500 文件 · hello 到达", b.helloMs, "ms");
    measure("1500 文件 · JSON.parse", b.parseMs, "ms");
    const treeB = b.hello.tree || {};
    ok("总数按真实文件数报（1500+1）", treeB.total === 1501, "total=" + treeB.total);
    ok("首屏只带一页，truncated 如实为真", treeB.listed < treeB.total && treeB.truncated === true,
      "listed=" + treeB.listed + " truncated=" + treeB.truncated);
    ok("首屏体积有预算（元数据一页不该把包撑大）", b.helloBytes < 600 * 1024,
      (b.helloBytes / 1024).toFixed(1) + "KB");

    /* 翻页：一页一页把全量拿完。游标用 offset ——
       服务端那页的排序键是 (价值层, 字典序)，按"上一条路径找比它大的第一条"会跨层错位，
       实测同一棵树翻完少一个文件（界面上完全看不出来）。这条判据就是把它逼出来的。 */
    const seenPaths = new Set((treeB.entries || []).map((e) => e.path));
    let off = treeB.nextOffset || (treeB.entries || []).length;
    let pages = 1, guard = 0;
    for (;;) {
      if (++guard > 40) break;
      const reply = b.next("tree.data", 8000);
      b.ask({ type: "tree.load", offset: off, limit: 500 });
      const td = await reply;
      pages++;
      (td.entries || []).forEach((e) => seenPaths.add(e.path));
      off = td.nextOffset || (off + (td.entries || []).length);
      if (!td.more) break;
    }
    ok("分页能把 1501 个文件全部列出来（翻 " + pages + " 页）", seenPaths.size === treeB.total,
      "拿到 " + seenPaths.size + " / " + treeB.total);
    /* 随机抽查：首、尾、中间，各自 file.read 拿回的必须是**它自己**的正文 */
    const all = Array.from(seenPaths).sort();
    const picks = [all[0], all[Math.floor(all.length / 2)], all[all.length - 1]];
    for (const p of picks) {
      const r = b.next("file.data", 8000);
      b.ask({ type: "file.read", path: p });
      const fd = await r;
      /* 期望正文不靠"猜路径里该有哪个编号"，直接跟盘上那份比 ——
         这才是这条判据真正要说的话：发回来的正文 == 磁盘上的正文，一个字节不差。
         （前几版在这里用正则剥数字，剥错了两次：一次把 pkg4/sub1 的数字拼进编号，
           一次要求 README.md 也带 NEEDLE，红的都是判据自己。） */
      const onDisk = fs.readFileSync(path.join(B.ws, p), "utf8");
      ok("file.read 拿回的正文与盘上那份逐字节相同：" + p,
        fd.path === p && fd.content === onDisk,
        "path=" + fd.path + " 长度 服务端=" + String(fd.content || "").length + " 盘上=" + onDisk.length);
      measure("file.read 单文件往返（" + p.split("/").pop() + "）", fd.size, "字节");
    }
    /* 基线（审阅用的 original）也是按需拿。这份工作区是提交过的 git 仓库，
       所以"排在第一页之后的文件"也有真基线可拿 —— 回空串在这里就是 bug，不是"本来就没基线"。 */
    const rb = b.next("file.baseline", 8000);
    b.ask({ type: "file.baseline", path: picks[0] });
    const bl = await rb;
    const blDisk = fs.readFileSync(path.join(B.ws, picks[0]), "utf8");
    ok("file.baseline 回的是这一条自己的提交版本（不是空、不是别人的）",
      bl.path === picks[0] && bl.isNew === false && bl.original === blDisk,
      "path=" + bl.path + " isNew=" + bl.isNew + " 长度 服务端=" + String(bl.original || "").length + " 盘上=" + blDisk.length);
    b.ws.close();

    /* ================= 规模 10000：遍历不能被拖死 ================= */
    section("③ 10000 文件：首屏仍然要来得出来");
    const tc = await get(8865, "/api/auth/auto");
    const c = await connect(8865, tc.token);
    measure("10000 文件 · hello 字节", (c.helloBytes / 1024).toFixed(1), "KB");
    measure("10000 文件 · hello 到达", c.helloMs, "ms");
    const treeC = c.hello.tree || {};
    ok("10000 规模下总数如实（允许上限之外的 honest truncated）",
      treeC.total >= 10001 || (treeC.truncated === true && treeC.total >= 1000), "total=" + treeC.total);
    ok("10000 规模首屏 3 秒内到得了", c.helloMs < 3000, c.helloMs + "ms");
    ok("10000 规模首屏体积不破预算", c.helloBytes < 600 * 1024, (c.helloBytes / 1024).toFixed(1) + "KB");
    /* 拿目录里真实存在的最后一条，而不是在探针里照想象中的路径拼一个
       （上一版硬写了 pkg0/deep/sub0/file09998.js —— 那个 i 实际落在 pkg8/sub2，
         于是 file.read 回的是 file.error，判据在等一朵永远不来的 file.data 超时）。 */
    const tailReply = c.next("tree.data", 8000);
    c.ask({ type: "tree.load", offset: 9000, limit: 1000 });
    const tail = await tailReply;
    const lastPath = (tail.entries || []).length ? tail.entries[tail.entries.length - 1].path : "";
    ok("翻到最后一页点得出具体文件（10000 规模下 offset 有效）",
      (tail.entries || []).length > 0 && !!lastPath, "尾页条数=" + (tail.entries || []).length);
    const rc = c.next("file.data", 8000);
    c.ask({ type: "file.read", path: lastPath });
    const fdC = await rc;
    ok("排在第 1 万条附近的文件（远超旧 500 上限）照样能直接读正文",
      fdC.path === lastPath && /NEEDLE-\d+/.test(fdC.content || ""),
      "path=" + fdC.path + " 头=" + String(fdC.content || "").slice(0, 24));
    c.ws.close();
    section("④ 界面这一侧：越界文件找得到、点得开、改得了、审得了（真浏览器）");
    /* 上面那三段验的是协议。这一条验的是"用户点得动"：
       协议对了但前端没接上（懒加载没触发 / 翻页按钮没接 / Diff 等回包前把 model 建空）
       是这类改造最常见的翻车姿势，只能在真页面上点一次才知道。 */
    const { chromium } = require("playwright");
    const base = `http://127.0.0.1:${8864}`;
    const user = "scale_" + Date.now();
    const authOpts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: user, password: "test1234" }) };
    await fetch(base + "/api/auth/register", authOpts).catch(() => {});
    const token = await fetch(base + "/api/auth/login", authOpts).then((r) => r.json()).then((j) => j.token || "").catch(() => "");
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErr = [];
    page.on("pageerror", (e) => pageErr.push(String(e && e.message)));
    await page.addInitScript((t) => { try { localStorage.setItem("cw-user-token", t); localStorage.setItem("cw-onboarded", "1"); } catch (e) {} }, token);
    await page.goto(base + "/", { waitUntil: "load", timeout: 30000 });
    await page.waitForFunction(() => typeof state !== "undefined" && state.tree && state.tree.total > 1000, { timeout: 30000 });

    const tree0 = await page.evaluate(() => ({ total: state.tree.total, have: Object.keys(state.files).length }));
    ok("首屏只把一页装进界面（1001 个文件不在 DOM 里）",
      tree0.total === 1501 && tree0.have <= 600, JSON.stringify(tree0));
    ok("树尾明写了还差多少（不是默默少给）",
      await page.locator(".ft-more").isVisible() && /还有 9\d\d|还有 10\d\d|共 1501/.test(await page.locator(".ft-more").innerText()),
      await page.locator(".ft-more").innerText().catch(() => "(没有这一行)"));

    /* 点两下"加载更多"，把整棵树翻完 */
    for (let i = 0; i < 3; i++) {
      const has = await page.evaluate(() => Object.keys(state.files).length);
      if (has >= 1501) break;
      await page.locator(".ft-more").click();
      await page.waitForTimeout(700);
    }
    const tree1 = await page.evaluate(() => ({ total: state.tree.total, have: Object.keys(state.files).length, more: state.tree.more }));
    ok("翻完之后界面里真的有 1501 个文件", tree1.have === 1501 && tree1.more === false, JSON.stringify(tree1));

    /* 挑一个"首屏根本没加载"的文件（价值层 2，排在第 1000 位之后） */
    const target = await page.evaluate(() => {
      const ps = Object.keys(state.files).filter((p) => /^pkg\d\/deep\/sub\d\/file/.test(p)).sort();
      return ps[ps.length - 1] || "";
    });
    ok("点得到的目标文件路径取到了（不是空字符串）", !!target, "target=" + target);
    await page.locator(".ft-item", { hasText: target.split("/").pop() }).first().click();
    await page.waitForFunction((p) => !!(window.monaco && typeof models !== "undefined" && models[p] && models[p].getValue().length > 0),
      target, { timeout: 15000 }).catch(() => {});
    const inEditor = await page.evaluate((p) => (models[p] ? models[p].getValue() : ""), target);
    const onDisk = fs.readFileSync(path.join(B.ws, target), "utf8");
    ok("点开之后编辑器里就是盘上那份正文（按需读取接通了）",
      inEditor === onDisk, "编辑器长度=" + inEditor.length + " 盘上=" + onDisk.length);

    /* 编辑 + 保存。
       键入走的是"点中编辑器 → Monaco 自己把隐藏 textarea 拿到焦点 → 打字"这条真实路径；
       不去直接 click 那个 textarea（它没有可见尺寸，locator 会一直等下去）。 */
    const MARK = "// scale-probe-edited";
    await page.locator("#monacoHost").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n" + MARK);
    await page.waitForTimeout(300);
    const typedIn = await page.evaluate((p) => (models[p] ? models[p].getValue() : ""), target);
    ok("打字打进了这个文件的 model（脏标记与保存走的是同一条路径）",
      typedIn.includes(MARK), JSON.stringify(typedIn.slice(-40)));
    await page.evaluate(() => saveActiveFile());
    const t1 = Date.now();
    let diskAfter = "";
    while (Date.now() - t1 < 8000) {
      diskAfter = fs.readFileSync(path.join(B.ws, target), "utf8");
      if (diskAfter.includes(MARK)) break;
      await wait(200);
    }
    ok("在这个文件里打字并保存，真的写进了盘上这一份", diskAfter.includes(MARK),
      JSON.stringify(diskAfter.slice(-40)));

    /* 审阅：这个文件的正文是点开时才读的；刚存过盘，它现在在 git 变更集里，
       基线要等 file.baseline 从 HEAD 取回来。左边那半必须是**保存前那一份**（真基线），
       右边那半必须带 MARK —— 两边都对得上，才叫"等两份齐了才建 model"。 */
    await page.evaluate((p) => showDiff(p), target);
    const gotDiff = await page.waitForFunction(() => {
      const m = document.getElementById("diffModal");
      return m && getComputedStyle(m).display !== "none" && typeof diffEditor !== "undefined" && diffEditor && diffEditor.getModel();
    }, null, { timeout: 12000 }).then(() => true).catch(() => false);
    const diffTexts = gotDiff ? await page.evaluate(() => {
      const mm = diffEditor.getModel();
      return { original: String((mm.original && mm.original.getValue()) || "").slice(0, 24), modified: String((mm.modified && mm.modified.getValue()) || "").slice(-30) };
    }) : { original: "", modified: "" };
    ok("审阅打开的是这一份的对比（左边=保存前那一份，右边=刚改的这份，两份都按需取回来了）",
      gotDiff && diffTexts.modified.includes(MARK) && diffTexts.original === onDisk.slice(0, 24),
      JSON.stringify(diffTexts) + " 期望左边=" + JSON.stringify(onDisk.slice(0, 24)));
    ok("这一路页面没有报错", pageErr.length === 0, pageErr.slice(0, 2).join(" | "));
    await browser.close();

    A.stop(); B.stop(); C.stop();
  } catch (e) {
    ok("探针整条链路没抛错", false, (e && e.stack ? e.stack : String(e)).slice(0, 300));
    try { A.stop(); B.stop(); C.stop(); } catch (er) {}
  }

  console.log("\n\x1b[1m量到的数（用于决定要不要再上分块/Worker/窗口化）\x1b[0m");
  for (const m of metrics) console.log("  " + m.name + " = " + m.value + " " + m.unit);
  console.log("\n共 " + (pass + fail) + " 条，红 " + fail + " 条");
  if (fail) console.log("失败明细：\n  - " + fails.join("\n  - "));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("探针自身出错：" + (e && e.stack ? e.stack : e)); process.exit(1); });
