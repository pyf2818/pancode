/* 全局授权根清单的真实服务验证：沙箱实例（独立数据根 + 独立工作区）走真实 HTTP 路径，验八件事——
 *   ① 挂载即登记：当前工作区一定在清单里（阶段二把工具接到清单之后，漏了它第一个吃亏的就是当前目录）；
 *   ② 授权接口过登录闸门：未带 token 一律 401（授权目录是敏感操作，不能匿名调）；
 *   ③ 新增授权：出现在清单里，并且真的落盘到 <数据根>/.pancode/roots.json；
 *   ④ 同一个目录换写法（大小写 / 尾斜杠）不长出第二条；
 *   ⑤ 目录不存在 → 400 且给得出人话错误；
 *   ⑥ 只读 ↔ 可写能翻面；
 *   ⑦ 撤销授权只删清单里那一行，目录和里面的文件一个都不碰；
 *   ⑧ 目录被拔掉 → 标 stale 但不静默摘除；重启进程后清单照常读得回来。
 * 键算错就会串到别人的数据上，所以 ① 里的分片键由探针独立复算（不 import 产品代码）。
 * 全程不碰开发者真实的 .pancode。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const PORT = 8817;
const ROOT = path.resolve(__dirname, "..");
const SANDBOX = path.join(ROOT, "scripts", "_verify_out", "roots-sandbox");
const DATA_DIR = path.join(SANDBOX, "data");
const WS_DIR = path.join(SANDBOX, "ws");
const EXTRA_DIR = path.join(SANDBOX, "other-project");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 独立复算分片键：绝对化 + 去尾分隔符 + Windows 折大小写 → md5 */
function shardOf(p) {
  const abs = path.resolve(p).replace(/[\\/]+$/, "");
  return crypto.createHash("md5").update(process.platform === "win32" ? abs.toLowerCase() : abs).digest("hex");
}

let TOKEN = "";
function req(method, urlPath, body, opts) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (TOKEN && !(opts && opts.noToken)) headers["x-user-token"] = TOKEN;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 15000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, raw: buf }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("请求超时")));
    if (data) r.write(data);
    r.end();
  });
}

function boot() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, "pancode.config.json"), JSON.stringify({
    workspace: WS_DIR,
    agentMode: "auto",
    permissions: { mode: "auto", allow: [], deny: [] },
  }), "utf8");
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), PANCODE_DATA_DIR: DATA_DIR, CURSORWEB_WORKSPACE: WS_DIR,
      CURSORWEB_ENGINE: "demo", AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => { out = (out + c).slice(-20000); });
  child.stderr.on("data", (c) => { out = (out + c).slice(-20000); });
  return { child, log: () => out };
}

async function waitHealth() {
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const r = await req("GET", "/api/health", null, { noToken: true }); if (r.json && r.json.ok) return true; } catch (e) {}
  }
  return false;
}

const rootsFile = () => path.join(DATA_DIR, ".pancode", "roots.json");
/* safeWrite 是异步排队落盘：接口回来不等于盘上有了，必须轮询到读得回来 */
async function readDisk(pred, ms) {
  const deadline = Date.now() + (ms || 5000);
  while (Date.now() < deadline) {
    try { const d = JSON.parse(fs.readFileSync(rootsFile(), "utf8")); if (pred(d.roots || [])) return d.roots; } catch (e) {}
    await wait(60);
  }
  return null;
}
const findRoot = (list, id) => (list || []).find((r) => r.id === id) || null;

(async () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(WS_DIR, { recursive: true });
  fs.writeFileSync(path.join(WS_DIR, "a.js"), "export const a = 1;\n", "utf8");
  fs.mkdirSync(EXTRA_DIR, { recursive: true });
  fs.writeFileSync(path.join(EXTRA_DIR, "keep.txt"), "别动我", "utf8");

  let b = boot();
  if (!await waitHealth()) { b.child.kill(); throw new Error("服务启动超时：" + b.log().slice(-1500)); }
  const reg = await req("POST", "/api/auth/register", { username: "_roots_" + Date.now(), password: "test1234" }, { noToken: true });
  TOKEN = (reg.json && reg.json.token) || "";
  if (!TOKEN) { b.child.kill(); throw new Error("注册失败：" + JSON.stringify(reg.json || reg.raw)); }

  const wsId = shardOf(WS_DIR);
  try {
    section("① 挂载即登记：当前工作区一定在清单里");
    const g1 = await req("GET", "/api/roots");
    const active = findRoot(g1.json.roots, wsId);
    ok("清单里有当前工作区（键与独立复算一致）", !!active,
      "接口返回：" + JSON.stringify(g1.json.roots).slice(0, 260) + "；期望键：" + wsId);
    /* 名字位不再存"当前工作区"：清单是持久化的，而"当前工作区"是每轮现算的（下一条断言查 activeId）。
       以前存过，切过一次工作区之后会出现两行都自称当前工作区（真实例实测到过）。 */
    ok("它标的是 workspace 来源且可写，别名位不冒充状态",
      !!active && active.source === "workspace" && active.writable === true && active.label !== "当前工作区",
      JSON.stringify(active).slice(0, 220));
    ok("接口把 activeId 一起给出（前端据此单独标当前工作区）", g1.json.activeId === wsId && g1.json.active === path.resolve(WS_DIR),
      JSON.stringify({ activeId: g1.json.activeId, active: g1.json.active }));

    section("② 授权接口过登录闸门");
    const anon = await req("GET", "/api/roots", null, { noToken: true });
    ok("不带 token 读清单被拒 401", anon.status === 401, JSON.stringify(anon.json || anon.raw).slice(0, 160));
    const anonAdd = await req("POST", "/api/roots", { path: EXTRA_DIR }, { noToken: true });
    ok("不带 token 授权目录被拒 401", anonAdd.status === 401, JSON.stringify(anonAdd.json || anonAdd.raw).slice(0, 160));

    section("③ 新增一个目录：出现在清单里，并且真的落盘");
    const add = await req("POST", "/api/roots", { path: EXTRA_DIR, label: "另一个项目" });
    const exId = add.json.root && add.json.root.id;
    ok("POST /api/roots 返回新条目", !!exId && exId === shardOf(EXTRA_DIR), JSON.stringify(add.json).slice(0, 220));
    const disk = await readDisk((rs) => rs.some((r) => r.id === exId));
    ok("roots.json 落在数据根而不是工作区", !!disk, "找过：" + rootsFile());
    ok("条目记下了来源与授权时间", !!disk && findRoot(disk, exId).source === "manual" && findRoot(disk, exId).grantedAt > 0,
      JSON.stringify(findRoot(disk, exId) || null).slice(0, 220));

    section("④ 同一个目录换写法不长出第二条");
    const alt = EXTRA_DIR + path.sep + (process.platform === "win32" ? "" : "");
    const again = await req("POST", "/api/roots", { path: alt, writable: false });
    ok("尾分隔符算同一条", again.json.root && again.json.root.id === exId, JSON.stringify(again.json.root).slice(0, 160));
    const listAfter = (await req("GET", "/api/roots")).json.roots;
    ok("清单里没有第二条", listAfter.filter((r) => r.id === exId).length === 1, JSON.stringify(listAfter.map((r) => r.id)));
    if (process.platform === "win32") {
      const up = await req("POST", "/api/roots", { path: EXTRA_DIR.toUpperCase() });
      ok("大小写不同也算同一条（Windows）", up.json.root && up.json.root.id === exId, JSON.stringify(up.json).slice(0, 160));
    }

    section("⑤ 目录不存在 → 400 且错误说人话");
    const bad = await req("POST", "/api/roots", { path: path.join(SANDBOX, "没有这个目录") });
    ok("返回 400", bad.status === 400, JSON.stringify(bad.json).slice(0, 160));
    ok("错误里点明了是哪个路径", /目录不存在/.test((bad.json && bad.json.error) || "") && /没有这个目录/.test(bad.json.error || ""),
      JSON.stringify(bad.json).slice(0, 200));
    const disk2 = await readDisk((rs) => true, 2000);
    ok("没有被塞进一条假的授权", (disk2 || []).filter((r) => /没有这个目录/.test(r.path || "")).length === 0, JSON.stringify((disk2 || []).map((r) => r.path)));

    section("⑥ 只读 ↔ 可写翻面");
    /* 上一步 ④ 已把这条改成 writable:false，先翻回可写再翻回顾两边都生效 */
    const on = await req("POST", "/api/roots/" + exId + "/writable", { writable: true });
    ok("翻成可写生效", on.json.root && on.json.root.writable === true, JSON.stringify(on.json.root).slice(0, 160));
    const off = await req("POST", "/api/roots/" + exId + "/writable", { writable: false });
    ok("翻成只读生效并落盘", off.json.root && off.json.root.writable === false, JSON.stringify(off.json.root).slice(0, 160));
    const wsRow = findRoot((await req("GET", "/api/roots")).json.roots, wsId) || {};
    ok("当前工作区那条没被牵连", wsRow.writable === true, "工作区授权不该跟着变：" + JSON.stringify(wsRow).slice(0, 160));
    const ghost = await req("POST", "/api/roots/no-such-id/writable", { writable: true });
    ok("改一条不存在的授权给 404", ghost.status === 404, JSON.stringify(ghost.json).slice(0, 160));

    section("⑦ 撤销授权只删清单里那一行");
    const del = await req("DELETE", "/api/roots/" + exId);
    ok("DELETE 后清单里没有了", del.ok !== false && !findRoot(del.json.roots, exId), JSON.stringify(del.json).slice(0, 200));
    ok("目录和里面的文件一个都没动",
      fs.existsSync(path.join(EXTRA_DIR, "keep.txt")) && fs.readFileSync(path.join(EXTRA_DIR, "keep.txt"), "utf8") === "别动我",
      "撤销授权绝不能变成删数据");
    const disk3 = await readDisk((rs) => !rs.some((r) => r.id === exId));
    ok("落盘里也删净了（不是只在内存里演一下）", !!disk3);
    ok("撤销不存在的授权给 404", (await req("DELETE", "/api/roots/" + exId)).status === 404);

    section("⑧ 目录被拔掉：标 stale 但不静默摘除；重启后清单还在");
    const diskDir = path.join(SANDBOX, "disk");
    fs.mkdirSync(diskDir, { recursive: true });
    await req("POST", "/api/roots", { path: diskDir, label: "外接盘" });
    const diskId = shardOf(diskDir);
    const freshRow = findRoot((await req("GET", "/api/roots")).json.roots, diskId) || {};
    ok("刚授权的目录此刻不算 stale", freshRow.stale === false, JSON.stringify(freshRow).slice(0, 200));
    fs.rmSync(diskDir, { recursive: true, force: true });
    const staleRow = findRoot((await req("GET", "/api/roots")).json.roots, diskId) || {};
    ok("目录没了就标 stale", staleRow.stale === true, JSON.stringify(staleRow).slice(0, 200));
    ok("但没有被静默摘除（用户可能只是拔了盘）", !!staleRow.id, "清单：" + JSON.stringify((await req("GET", "/api/roots")).json.roots.map((r) => r.label)));

    b.child.kill();
    await wait(900);
    b = boot();
    if (!await waitHealth()) throw new Error("重启失败：" + b.log().slice(-1200));
    const after = (await req("GET", "/api/roots")).json.roots;
    ok("重启后清单原样读回来", after.length >= 2 && !!findRoot(after, wsId), JSON.stringify(after.map((r) => [r.label, r.stale])));
    ok("重启后当前工作区仍只登记一条（没有重复生长）",
      after.filter((r) => r.id === wsId).length === 1, JSON.stringify(after.map((r) => r.id)));
    ok("那条拔掉过的目录仍然带着 stale 呈现", !!findRoot(after, diskId) && findRoot(after, diskId).stale === true,
      JSON.stringify(findRoot(after, diskId) || null).slice(0, 200));
  } finally {
    b.child.kill();
  }

  console.log("\n" + (fail ? "\x1b[31mHAS FAIL\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { for (const f of fails) console.log("  - " + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\x1b[31mFAIL:\x1b[0m " + (e && e.stack || e)); process.exit(1); });
