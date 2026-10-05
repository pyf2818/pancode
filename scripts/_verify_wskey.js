/* 工作区分片键统一验证：起一个完全沙箱化的 pancode 实例（独立 PANCODE_DATA_DIR + 独立工作区），
 * 事先按"老键名"摆好分片文件，然后检查——
 *   1) 两套老键被归并成 canonical 一个名字，内容一字不改；
 *   2) Agent 与 HTTP 端点读的是同一个文件（过去灵魂/进度各读一份，界面和模型看的不是同一份数据）；
 *   3) 有冲突时绝不覆盖、绝不删除，只把老文件留在原地并告警；
 *   4) 切工作区后键跟着挂载根走，配置里的 workspace 与运行时同源。
 * 单元层能算对键，不代表起进程后 store 真指对文件——这一层只在真实服务上验。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const PORT = 8813;
const ROOT = path.resolve(__dirname, "..");
const SANDBOX = path.join(ROOT, "scripts", "_verify_out", "wskey-sandbox");
const DATA_DIR = path.join(SANDBOX, "data");
const WS1 = path.join(SANDBOX, "ws1");
const WS2 = path.join(SANDBOX, "ws2");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 键算法：与 server/ws-key.js 同源，独立复算一遍才不会自证 ---------- */
const IS_WIN = process.platform === "win32";
function b36(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36); }
function md5(s) { return crypto.createHash("md5").update(s).digest("hex"); }
function legacyB36(p) { return b36(path.resolve(p)); }
function legacyMd5(p) { return md5(path.resolve(p)); }
function canonical(p) {
  let abs = path.resolve(p).replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(abs)) abs += path.sep;
  return md5(IS_WIN ? abs.toLowerCase() : abs);
}

let TOKEN = "";
function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (TOKEN) headers["x-user-token"] = TOKEN;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 15000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, raw: buf }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(new Error("请求超时")); });
    if (data) r.write(data);
    r.end();
  });
}

function seed() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const d of [WS1, WS2]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(WS1, "src"), { recursive: true });
  fs.writeFileSync(path.join(WS1, "src", "a.js"), "export const a = 1;\n");
  fs.mkdirSync(path.join(DATA_DIR, ".pancode", "memory"), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, ".pancode", "soul"), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "pancode.config.json"), JSON.stringify({ workspace: WS1, llm: { engine: "demo" } }), "utf8");

  // 老键 A 套（base36）：记忆一条 + 灵魂"甲"（这份更新，归并后应当是它在服务）
  fs.writeFileSync(path.join(DATA_DIR, ".pancode", "memory", legacyB36(WS1) + ".json"), JSON.stringify([
    { id: "seed0001", type: "decision", topic: "旧键记忆", content: "这条记忆写在 base36 键名下，归并后必须还能被 /api/memory 读到。",
      ts: Date.now(), accessCount: 1, lastAccessAt: Date.now(), source: "sediment", valueScore: 5, sticky: true },
  ], null, 2), "utf8");
  fs.writeFileSync(path.join(DATA_DIR, ".pancode", "soul", legacyB36(WS1) + ".json"),
    JSON.stringify({ name: "甲灵魂", vibe: "warm", emoji: "🅰", values: [], boundaries: [], principles: [], proposals: [] }), "utf8");
  // 老键 B 套（md5 未规范化）：同工作区的另一份灵魂——冲突方，谁都不许被覆盖
  const older = new Date(Date.now() - 86400000);
  const f = path.join(DATA_DIR, ".pancode", "soul", legacyMd5(WS1) + ".json");
  fs.writeFileSync(f, JSON.stringify({ name: "乙灵魂", vibe: "cool", emoji: "🅱", values: [], boundaries: [], principles: [], proposals: [] }), "utf8");
  fs.utimesSync(f, older, older);
}

async function boot() {
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), PANCODE_DATA_DIR: DATA_DIR, CURSORWEB_WORKSPACE: WS1,
      CURSORWEB_ENGINE: "demo", AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out = (out + c).slice(-20000); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-20000); });
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const r = await req("GET", "/api/health"); if (r.json && r.json.ok) return { child, log: () => out }; } catch (e) {}
  }
  child.kill();
  throw new Error("服务启动超时：\n" + out.slice(-2000));
}

const jsonsIn = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch (e) { return []; } };

/* safe-write 的 saveJson 是排队 + 退避的异步落盘：POST 返回时文件往往还没写出来。
   跨进程"读己之写"必须轮询等，否则测的是竞态而不是键。 */
async function waitFor(fn, ms) {
  const deadline = Date.now() + (ms || 6000);
  while (Date.now() < deadline) {
    try { const last = fn(); if (last) return last; } catch (e) {}
    await wait(120);
  }
  return null;
}
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

(async () => {
  seed();
  const { child, log } = await boot();
  const reg = await req("POST", "/api/auth/register", { username: "_wskey_" + Date.now(), password: "test1234" });
  TOKEN = (reg.json && reg.json.token) || "";
  if (!TOKEN) { child.kill(); throw new Error("注册验证用户失败：" + JSON.stringify(reg.json || reg.raw)); }

  try {
    section("归并：两套老键 → 一个 canonical");
    const memDir = path.join(DATA_DIR, ".pancode", "memory");
    const soulDir = path.join(DATA_DIR, ".pancode", "soul");
    const key1 = canonical(WS1);
    ok("memory/ 只剩 canonical 一个分片文件", jsonsIn(memDir).join() === key1 + ".json", "实际：" + jsonsIn(memDir).join(", "));
    ok("soul/ 的 canonical 文件就是 base36 那份改名的（内容仍是甲灵魂）",
      fs.existsSync(path.join(soulDir, key1 + ".json"))
      && JSON.parse(fs.readFileSync(path.join(soulDir, key1 + ".json"), "utf8")).name === "甲灵魂");

    section("应用读的正是归并后的文件");
    let r = await req("GET", "/api/memory?q=" + encodeURIComponent("旧键记忆"));
    const hit = (r.json.entries || []).some((e) => String(e.content || "").includes("写在 base36 键名下"));
    ok("GET /api/memory 读得到归并前的老键记忆", hit === true, JSON.stringify(r.json).slice(0, 200));
    r = await req("GET", "/api/soul");
    ok("GET /api/soul 返回归并后的灵魂（甲，而非默认人格）", r.json.ok && r.json.soul && r.json.soul.name === "甲灵魂",
      JSON.stringify(r.json.soul || r.json).slice(0, 160));

    section("冲突不毁数据");
    const kept = path.join(soulDir, legacyMd5(WS1) + ".json");
    ok("两份灵魂同时存在时，输的那份原样留在磁盘（不删不盖）",
      fs.existsSync(kept) && JSON.parse(fs.readFileSync(kept, "utf8")).name === "乙灵魂");
    const logged = log();
    ok("挂载日志报出归并了哪些文件", /分片键归并/.test(logged), logged.slice(-400));
    ok("挂载日志报出同工作区还留着别的老键名", /同属本工作区还有别的历史分片/.test(logged) && /乙|\.json/.test(logged), logged.slice(-400));

    section("切工作区：键跟着挂载根走");
    r = await req("POST", "/api/workspace", { dir: WS2 });
    ok("POST /api/workspace 切到第二个目录", r.json.ok === true, JSON.stringify(r.json).slice(0, 160));
    r = await req("GET", "/api/soul");
    ok("第二个工作区读到的是自己的空灵魂，不是上一个的", r.json.ok && r.json.soul.name !== "甲灵魂",
      JSON.stringify(r.json.soul).slice(0, 160));
    r = await req("GET", "/api/memory?q=" + encodeURIComponent("旧键记忆"));
    ok("第二个工作区读不到上一个工作的记忆", !((r.json.entries || []).some((e) => String(e.content || "").includes("base36"))));

    section("写入端点与 Agent 读取路径同源");
    r = await req("POST", "/api/sediment", { target: "memory", title: "新键", content: "这条写在切区之后，必须落在 WS2 的 canonical 分片里。" });
    ok("POST /api/sediment 成功", r.json.ok === true, JSON.stringify(r.json).slice(0, 160));
    const key2 = canonical(WS2);
    const mem2File = path.join(memDir, key2 + ".json");
    const mem2After = await waitFor(() => (fs.existsSync(mem2File) && readJson(mem2File).some((e) => String(e.content).includes("切区之后")) ? true : null));
    ok("WS2 的分片文件名 = canonical(WS2)，沉淀条目落在里面", mem2After === true,
      "memory/ 现有：" + jsonsIn(memDir).join(", "));
    ok("memory/ 里两个工作区各一个文件，没有第三个名字", jsonsIn(memDir).join() === [key1 + ".json", key2 + ".json"].sort().join(),
      "实际：" + jsonsIn(memDir).join(", "));
    r = await req("POST", "/api/progression", { path: "fullstack" });
    const progDir = path.join(DATA_DIR, ".pancode", "progression");
    ok("进度分片也只留一个 canonical 名字（过去 HTTP 侧 md5、Agent 侧 base36 各写一份）",
      await waitFor(() => (jsonsIn(progDir).join() === key2 + ".json" ? true : null)) === true,
      "实际：" + jsonsIn(progDir).join(", "));

    section("切回原工作区：归并后的数据还在");
    r = await req("POST", "/api/workspace", { dir: WS1 });
    ok("切回 WS1", r.json.ok === true, JSON.stringify(r.json).slice(0, 120));
    r = await req("GET", "/api/soul");
    ok("切回后灵魂仍是甲灵魂", r.json.ok && r.json.soul.name === "甲灵魂", JSON.stringify(r.json.soul).slice(0, 120));
    ok("切回后 memory/ 仍是两个文件，归并没收走任何数据", jsonsIn(memDir).length === 2, "实际 " + jsonsIn(memDir).length);
  } finally {
    child.kill();
  }

  console.log("\n" + (fail ? "\x1b[31mHAS FAIL\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { for (const f of fails) console.log("  - " + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\x1b[31mFAIL:\x1b[0m " + (e && e.stack || e)); process.exit(1); });
