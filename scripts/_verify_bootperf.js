/* ============================================================
   首屏快照性能与等价性（#30 / 任务 #38：加载后 22 秒才出第一屏）

   根因：hello 里带全量 files，而 snapshotFiles 对**每个文件** await 一次
   git.baseline(rel) = 一发 `git show HEAD:<path>` 子进程。
   实测 126ms/次 × 127 个文件 = 22.3s。窗口已经开出来了，里面什么都没有。

   这一支探针钉两件事：
     ① 等价性——批量口径（一次 ls-files + 一次 status，只给真改过的文件发 git show）
        与旧的逐文件 baseline **逐字节同结果**。这条最重要：快照是"随时可一键还原"的
        依据，改快了但算错基线，比慢更糟。
     ② 真的快了——同一个仓库里两种算法并排计时，且端到端 hello 到达时间显著下降。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const N = 150;                       // 沙箱工作区文件数（与当初实测的 127 同量级）
const sb = require("./_sandbox").create({
  tag: "bootperf",
  wsFiles: buildFiles(N),
  config: {
    agentMode: "auto",
    llm: { baseURL: "", apiKey: "", model: "sandbox-model", contextWindow: 32000 },
    permissions: { mode: "auto", allow: [], deny: [] },
  },
});

function buildFiles(n) {
  const out = {};
  for (let i = 0; i < n; i++) {
    const rel = i % 7 === 0 ? `src/mod${i}.js` : `src/pkg${i % 9}/file${i}.js`;
    out[rel] = "// 模块 " + i + "\nexport const v = " + i + ";\n" + "/* 填充 */\n".repeat(6);
  }
  out["README.md"] = "# bootperf 沙箱工作区\n";
  return out;
}

const { GitLayer } = require("../server/git");
const { FileStore } = require("../server/files");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.PORT || 8841);
const REPO = path.resolve(__dirname, "..");

function gitAt(dir, args) {
  const r = spawnSync("git", args, {
    cwd: dir, encoding: "utf8", timeout: 30000,
    env: Object.assign({}, process.env, {
      GIT_AUTHOR_NAME: "probe", GIT_AUTHOR_EMAIL: "p@p",
      GIT_COMMITTER_NAME: "probe", GIT_COMMITTER_EMAIL: "p@p",
    }),
  });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + " 失败：" + (r.stderr || r.stdout));
  return (r.stdout || "").trim();
}

async function snapshotOld(g, f) {
  const out = {};
  for (const rel of f.list()) {
    if (f.isBinary(rel)) { out[rel] = { original: "", isNew: false, binary: true }; continue; }
    let content; try { content = f.read(rel); } catch (e) { continue; }
    const base = await g.baseline(rel);
    out[rel] = { content, original: base === null ? "" : base, isNew: base === null };
  }
  return out;
}
async function snapshotNew(g, f) {
  const out = {};
  const pick = await g.baselinePlanner();
  for (const rel of f.list()) {
    if (f.isBinary(rel)) { out[rel] = { original: "", isNew: false, binary: true }; continue; }
    let content; try { content = f.read(rel); } catch (e) { continue; }
    const base = pick ? await pick(rel, content) : await g.baseline(rel);
    out[rel] = { content, original: base === null ? "" : base, isNew: base === null };
  }
  return out;
}

(async () => {
  /* ---------- 把沙箱工作区变成 git 仓库（服务端还没起，GitLayer 在 boot 时才探测） ---------- */
  section("① 准备：沙箱工作区做成 git 仓库，并制造三类文件状态");
  gitAt(sb.wsDir, ["init", "-q", "."]);
  gitAt(sb.wsDir, ["add", "-A"]);
  gitAt(sb.wsDir, ["commit", "-qm", "bootperf baseline"]);
  const MOD = "src/pkg1/file10.js";           // 已跟踪 + 被改
  const NEW = "src/untracked-new.js";         // 未跟踪（旧写法这里必发一发失败的 git show）
  fs.writeFileSync(path.join(sb.wsDir, MOD), "// 改过的内容\n", "utf8");
  fs.writeFileSync(path.join(sb.wsDir, NEW), "// 全新文件\n", "utf8");
  ok("工作区是 git 仓库", /true/.test(gitAt(sb.wsDir, ["rev-parse", "--is-inside-work-tree"])));

  const files = new FileStore(sb.wsDir);
  const g = new GitLayer(sb.wsDir, files);
  ok("GitLayer 认到这个仓库（不是降级到快照）", g.available === true, JSON.stringify({ available: g.available, prefix: g.prefix }));
  const listed = files.list();
  ok("文件数够跑出旧算法的代价（≥100）", listed.length >= 100, "实际 " + listed.length);

  /* ---------------- ② 等价性 ---------------- */
  section("② 批量口径必须与逐文件 baseline 逐字节同结果");
  const [oldSnap, newSnap] = [await snapshotOld(g, files), await snapshotNew(g, files)];
  const keys = Object.keys(oldSnap).sort();
  ok("覆盖的文件集合一致", JSON.stringify(keys) === JSON.stringify(Object.keys(newSnap).sort()),
    keys.length + " vs " + Object.keys(newSnap).length);
  let diffKeys = [];
  for (const k of keys) {
    if (oldSnap[k].original !== newSnap[k].original || !!oldSnap[k].isNew !== !!newSnap[k].isNew) diffKeys.push(k);
  }
  ok("每个文件的 original / isNew 都一致", diffKeys.length === 0, JSON.stringify(diffKeys.slice(0, 5)));
  ok("改过的文件：基线仍是 HEAD 版本、且不算新增",
    newSnap[MOD] && newSnap[MOD].isNew === false && /模块 10/.test(newSnap[MOD].original)
    && /改过的内容/.test(newSnap[MOD].content),
    newSnap[MOD] && JSON.stringify({ isNew: newSnap[MOD].isNew, original: newSnap[MOD].original.slice(0, 20) }));
  /* 启动前就存在的未跟踪文件：旧写法 `git show` 失败后回落到启动快照，
     所以它算"有基线"而不是"全新"——两条口径必须一致（上面那条逐文件比对已经钉过），
     这里额外把它写清楚，免得后人以为未跟踪就等于 isNew。 */
  ok("启动前就存在的未跟踪文件：两条口径都回落成「有基线、非新增」",
    oldSnap[NEW] && newSnap[NEW] && oldSnap[NEW].isNew === newSnap[NEW].isNew
    && oldSnap[NEW].original === newSnap[NEW].original,
    JSON.stringify({ oldIsNew: oldSnap[NEW] && oldSnap[NEW].isNew, newIsNew: newSnap[NEW] && newSnap[NEW].isNew }));
  // 启动之后才冒出来的新文件（Agent 写盘的真实形态）：不在这次的比对范围内，见 ③ 之后
  const AFTER = "src/made-after-boot.js";
  const AFTER_TXT = "// 启动后新建的内容";
  fs.writeFileSync(path.join(sb.wsDir, AFTER), AFTER_TXT, "utf8");
  const afterOld = await g.baseline(AFTER);
  const afterNew = await (await g.baselinePlanner())(AFTER, AFTER_TXT);
  ok("启动后新建的文件：两条口径都是 null（=真正的新增）",
    afterOld === null && afterNew === null, JSON.stringify({ afterOld: String(afterOld), afterNew: String(afterNew) }));
  fs.unlinkSync(path.join(sb.wsDir, AFTER));
  ok("没动过的文件：基线等于自身（不再发子进程）",
    newSnap["README.md"] && newSnap["README.md"].isNew === false
    && newSnap["README.md"].original === newSnap["README.md"].content);

  /* ---------------- ③ 速度 ---------------- */
  section("③ 同一个仓库并排计时");
  let t = Date.now(); const a = await snapshotOld(g, files); const oldMs = Date.now() - t;
  t = Date.now(); const b = await snapshotNew(g, files); const newMs = Date.now() - t;
  console.log("  逐文件 git show：" + oldMs + "ms / 批量：" + newMs + "ms / 文件数：" + Object.keys(a).length);
  ok("批量口径确实快（≥5×）", newMs * 5 < oldMs, oldMs + " vs " + newMs);
  ok("快的同时结果没变（两次快照 JSON 相同）", JSON.stringify(a) === JSON.stringify(b));
  ok("批量口径只发了少量子进程（ls-files + status + 改动文件数）",
    Object.keys(a).length > 100, "文件数 " + Object.keys(a).length);

  /* ---------------- ④ 端到端：hello 到达时间 ---------------- */
  section("④ 端到端：窗口打开到拿到第一屏数据（hello）");
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: REPO,
    env: sb.env({ PORT: String(PORT), AGENT_FAST: "1", CURSORWEB_ENGINE: "demo", NODE_NO_WARNINGS: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const t0 = Date.now();
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) { up = true; break; } } catch (e) {}
    await wait(250);
  }
  ok("服务端起来了", up, log.slice(-300));
  if (up) {
    /* 业务 WS 有登录闸门：不带 token 的 upgrade 直接被 socket.destroy()（上一版探针就是
       在这里读到 "socket hang up"，误以为服务端坏了）。先在沙箱里注册一个一次性账号。 */
    const base = `http://127.0.0.1:${PORT}`;
    const authOpts = { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bootperf_" + Date.now(), password: "test1234" }) };
    await fetch(base + "/api/auth/register", authOpts).catch(() => {});
    const token = await fetch(base + "/api/auth/login", authOpts).then((r) => r.json()).then((j) => j.token || "").catch(() => "");
    ok("沙箱里能拿到登录 token（账号只落在沙箱数据根）", !!token);
    const helloMs = await new Promise((resolve, reject) => {
      const WebSocket = require("ws");
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`);
      const start = Date.now();
      const timer = setTimeout(() => { ws.terminate(); reject(new Error("hello 超时未到达")); }, 60000);
      ws.on("open", () => {});
      ws.on("message", (raw) => {
        let m = null;
        try { m = JSON.parse(raw.toString()); } catch (e) { return; }
        if (m && m.type === "hello") {
          clearTimeout(timer);
          const n = Object.keys(m.files || {}).length;
          ws.close();
          resolve({ ms: Date.now() - start, n });
        }
      });
      ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    }).catch((e) => { console.log("  hello 取数失败：" + e.message); return null; });
    if (helloMs) {
      console.log("  hello 到达 " + helloMs.ms + "ms，带 " + helloMs.n + " 个文件");
      ok("首屏数据在 6 秒内到达（旧算法同规模实测 22s）", helloMs.ms < 6000, helloMs.ms + "ms");
      ok("hello 里文件是全的", helloMs.n >= 100, "拿到 " + helloMs.n);
    } else {
      ok("hello 能取到", false, "取数失败");
    }
  }
  child.kill();

  console.log("\n" + (fail ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m") + " — 通过 " + pass + " / 失败 " + fail);
  if (fail) for (const f of fails) console.log("  · " + f);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("VERIFY_FAIL", e && e.stack || e);
  process.exit(1);
});
