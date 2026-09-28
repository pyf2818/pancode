/* 登录态跨重启实测（用户反馈"保存不了我的账号登录"）
   旧实现把会话只放在内存 Map 里：服务一重启所有 token 作废，前端 localStorage 的"记住我"
   变废票 → 每次开机都要重新登录。这里真的杀掉服务再拉起来，验证同一个 token 仍然有效。
   全程用一次性 PANCODE_DATA_DIR，绝不碰仓库里的 .pancode/users.json。 */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-auth-live-"));
const DATA = path.join(SB, "data");
const WS = path.join(SB, "ws");
const PORT = Number(process.env.AUTH_VERIFY_PORT || 8819);

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
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, raw: buf.slice(0, 160) }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    if (data) r.write(data);
    r.end();
  });
}

function boot() {
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), PANCODE_DATA_DIR: DATA, CURSORWEB_WORKSPACE: WS,
      CURSORWEB_ENGINE: "demo", AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  child.stdout.on("data", (c) => { tail = (tail + c).slice(-4000); });
  child.stderr.on("data", (c) => { tail = (tail + c).slice(-4000); });
  return { child, tail: () => tail };
}
async function untilUp() {
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const r = await req("GET", "/api/health"); if (r.json && r.json.ok) return true; } catch (e) {}
  }
  return false;
}
async function kill(child) {
  child.kill();
  for (let i = 0; i < 60; i++) {
    await wait(150);
    try { await req("GET", "/api/health"); } catch (e) { return true; }   // 端口已无人监听
  }
  return false;
}
/* 用真实 WebSocket 走一遍前端连线路径（握手只认 token） */
function wsOpen(token) {
  const WebSocket = require(path.join(ROOT, "node_modules", "ws"));
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const s = new WebSocket("ws://127.0.0.1:" + PORT + "/?token=" + encodeURIComponent(token));
    const t = setTimeout(() => { fin({ ok: false, why: "超时" }); try { s.terminate(); } catch (e) {} }, 6000);
    s.on("open", () => { clearTimeout(t); fin({ ok: true }); try { s.close(); } catch (e) {} });
    s.on("error", (e) => { clearTimeout(t); fin({ ok: false, why: String(e && e.message || e) }); });
    s.on("close", () => { if (!done) { clearTimeout(t); fin({ ok: false, why: "握手前被关闭" }); } });
  });
}

(async () => {
  fs.mkdirSync(path.join(DATA, ".pancode"), { recursive: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(WS, "README.md"), "# auth sandbox\n");
  const USER = "安安_test_" + Date.now();
  const PASSW = "pw-test-1234";

  section("首启：注册 / 校验");
  let b = boot();
  if (!(await untilUp())) { b.child.kill(); throw new Error("服务未就绪\n" + b.tail()); }
  let r = await req("GET", "/api/auth/status");
  ok("未登录时 hasUsers=false（前端据此默认落在注册态）", r.json.ok === true && r.json.hasUsers === false, JSON.stringify(r.json));
  r = await req("POST", "/api/auth/register", { username: USER, password: PASSW });
  const token = r.json && r.json.token;
  ok("注册成功返回 token", r.json.ok === true && !!token, JSON.stringify(r.json));
  r = await req("GET", "/api/auth/status?userToken=" + encodeURIComponent(token || ""));
  ok("status 认得该 token 并回用户名", r.json.loggedIn === true && r.json.username === USER, JSON.stringify(r.json));
  r = await req("GET", "/api/config", null, token);
  ok("带 token 的受保护接口放行（HTTP 200）", r.status === 200 && r.json.ok === true, "status " + r.status);
  r = await req("GET", "/api/config");
  ok("不带 token 的受保护接口被拒（401 且是 JSON，不是 HTML 登录页）", r.status === 401, "status " + r.status + " " + String(r.raw || "").slice(0, 40));
  r = await req("POST", "/api/auth/register", { username: "x", password: "pass1234" });
  ok("用户名过短被拒", r.json.ok === false, JSON.stringify(r.json));
  r = await req("POST", "/api/auth/register", { username: "../etc/passwd", password: "pass1234" });
  ok("含路径字符的用户名被拒", r.json.ok === false, JSON.stringify(r.json));
  r = await req("POST", "/api/auth/login", { username: "nobody_xyz", password: "pass1234" });
  ok("不存在的用户带 noUser 标记（前端引导去注册）", r.json.ok === false && r.json.noUser === true, JSON.stringify(r.json));
  r = await req("POST", "/api/auth/login", { username: USER, password: "wrong-pass" });
  ok("错密码被拒且不带 noUser", r.json.ok === false && !r.json.noUser, JSON.stringify(r.json));

  section("关键：杀掉服务再拉起，同一个 token 仍然有效");
  const up1 = await kill(b.child);
  ok("旧服务确实已停（端口无人响应）", up1 === true);
  b = boot();
  if (!(await untilUp())) { b.child.kill(); throw new Error("重启后服务未就绪\n" + b.tail()); }
  r = await req("GET", "/api/auth/status?userToken=" + encodeURIComponent(token));
  ok("重启后 status 仍认得旧 token（「重启就要重新登录」的根因）",
    r.json.loggedIn === true && r.json.username === USER, JSON.stringify(r.json));
  r = await req("GET", "/api/config", null, token);
  ok("重启后带旧 token 的受保护接口照样放行", r.status === 200 && r.json.ok === true, "status " + r.status);
  const w = await wsOpen(token);
  ok("重启后 WebSocket 用旧 token 能握手成功（前端不再掉线）", w.ok === true, w.why || "");
  const sessFile = path.join(DATA, ".pancode", "sessions.json");
  ok("会话已落盘（sessions.json 存在且含该 token）",
    fs.existsSync(sessFile) && JSON.parse(fs.readFileSync(sessFile, "utf8"))[token] != null,
    fs.existsSync(sessFile) ? Object.keys(JSON.parse(fs.readFileSync(sessFile, "utf8"))).length + " 条" : "文件不存在");
  const usersRaw = fs.readFileSync(path.join(DATA, ".pancode", "users.json"), "utf8");
  ok("users.json 里没有明文密码", usersRaw.indexOf(PASSW) < 0);

  section("登出与过期");
  r = await req("POST", "/api/auth/logout", null, token);
  ok("登出接口放行", r.json.ok === true, JSON.stringify(r.json));
  r = await req("GET", "/api/auth/status?userToken=" + encodeURIComponent(token));
  ok("登出后同一 token 立即失效", r.json.loggedIn === false, JSON.stringify(r.json));
  r = await req("GET", "/api/config", null, token);
  ok("登出后受保护接口回到 401", r.status === 401, "status " + r.status);
  /* 过期会话不会被认回来：直接改盘上的 ts 再重启 */
  const t2 = (await req("POST", "/api/auth/login", { username: USER, password: PASSW })).json.token;
  await wait(900);
  const disk = JSON.parse(fs.readFileSync(sessFile, "utf8"));
  Object.keys(disk).forEach((k) => { disk[k].ts = Date.now() - 31 * 24 * 60 * 60 * 1000; });
  fs.writeFileSync(sessFile, JSON.stringify(disk));
  await kill(b.child);
  b = boot();
  if (!(await untilUp())) { b.child.kill(); throw new Error("二次重启未就绪\n" + b.tail()); }
  r = await req("GET", "/api/auth/status?userToken=" + encodeURIComponent(t2));
  ok("超过 30 天未活动的会话判死", r.json.loggedIn === false, JSON.stringify(r.json));
  b.child.kill();
  await wait(200);
  fs.rmSync(SB, { recursive: true, force: true });

  console.log("");
  if (fail) { console.log("\x1b[31mFAIL " + fail + "/" + (pass + fail) + " 项\x1b[0m"); fails.forEach((f) => console.log("  - " + f)); process.exit(1); }
  console.log("\x1b[32mPASS 登录态实测 " + pass + "/" + (pass + fail) + " 项\x1b[0m");
  process.exit(0);
})().catch((e) => { console.error("探针异常：" + (e && e.stack || e)); try { fs.rmSync(SB, { recursive: true, force: true }); } catch (_) {} process.exit(1); });
