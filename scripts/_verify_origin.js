/* ============================================================
   浏览器来源隔离实测（审查项 F01）
   钉的是这条实测过的链：跑在**另一个** 127.0.0.1 端口上的网页，
   用 Origin: http://127.0.0.1:<别的端口> 请求本服务，旧 CORS 只看 hostname
   不看端口，于是反射式 ACAO 让它读得到 /api/auth/auto 免密签发的 token，
   再拿这个 token 调业务接口 —— 本机任意一个开发网页 = 拿到 Agent 的身份。

   这个脚本不靠"读源码里有 if"作证，全部走真实 HTTP/WS 请求：
     · 自家来源必须仍然可用（收紧不能把应用自己关在门外）
     · 不带 Origin 的原生客户端必须仍然可用（Electron 主进程 / CLI / 探针）
     · 外部来源、null 来源、别的回环端口一律拒
   全程一次性 PANCODE_DATA_DIR，绝不碰仓库里的 .pancode/。
   ============================================================ */
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const WebSocket = require("ws");

const ROOT = path.resolve(__dirname, "..");
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-origin-"));
const DATA = path.join(SB, "data");
const WS = path.join(SB, "ws");
const PORT = Number(process.env.ORIGIN_VERIFY_PORT || 8831);
/* 攻击者页面所在的"另一个回环端口"：起一个真 HTTP 服务，让探针的 Origin 头
   不是随手编的字符串，而是本机真实存在、真实能打开的另一个来源。 */
const OTHER_PORT = Number(process.env.ORIGIN_VERIFY_OTHER_PORT || 8832);

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, urlPath, body, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = Object.assign({}, opts.headers || {});
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
    if (opts.token) headers["x-user-token"] = opts.token;
    const r = http.request({ host: "127.0.0.1", port: opts.port || PORT, path: urlPath, method, headers, timeout: 15000 }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(buf || "{}"); } catch (e) {}
        resolve({ status: res.statusCode, json, raw: buf, headers: res.headers });
      });
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
function wsOpen(origin, token) {
  return new Promise((resolve) => {
    const done = (v) => { if (!resolve.settled) { resolve.settled = true; resolve(v); } };
    const protocols = token ? ["bearer." + encodeURIComponent(token)] : undefined;
    const ws = new WebSocket("ws://127.0.0.1:" + PORT + "/", protocols, { headers: { Origin: origin } });
    const t = setTimeout(() => { try { ws.terminate(); } catch (e) {} done({ opened: false, why: "timeout" }); }, 4000);
    ws.on("open", () => { clearTimeout(t); done({ opened: true }); setTimeout(() => { try { ws.close(); } catch (e) {} }, 60); });
    ws.on("error", (e) => { clearTimeout(t); done({ opened: false, why: String(e && e.message || e) }); });
    // 非 101 响应：v8 给 (req, res)；连响应都没有就被销毁时给 (req, socket)
    ws.on("unexpected-response", (_req, a, b) => {
      clearTimeout(t);
      const why = a && a.statusCode ? "http " + a.statusCode : String((b && b.message) || "no handshake");
      done({ opened: false, why });
    });
  });
}

(async () => {
  const { child, tail } = boot();
  let other = null;
  try {
    if (!await untilUp()) { console.log(tail()); console.log("\x1b[31m服务未能启动，探针无法成立\x1b[0m"); process.exit(1); }
    other = http.createServer((_q, s) => { s.writeHead(200, { "Content-Type": "text/html" }); s.end("<html>other</html>"); })
      .listen(OTHER_PORT, "127.0.0.1");
    await new Promise((r) => other.once("listening", r));

    const OWN = "http://127.0.0.1:" + PORT;
    const OWN_LOCALHOST = "http://localhost:" + PORT;
    const FOREIGN = "http://127.0.0.1:" + OTHER_PORT;

    section("1) 自家来源必须照常可用（收紧不能把应用自己关在门外）");
    const own = await req("GET", "/api/auth/auto", null, { headers: { Origin: OWN } });
    ok("同源 Origin 取自动身份 → 200", own.status === 200 && !!own.json.token, "status=" + own.status);
    ok("同源响应回显 ACAO", own.headers["access-control-allow-origin"] === OWN, String(own.headers["access-control-allow-origin"]));
    const ownLH = await req("GET", "/api/auth/auto", null, { headers: { Origin: OWN_LOCALHOST } });
    ok("localhost 写法同样算自家", ownLH.status === 200, "status=" + ownLH.status);
    const token = own.json.token || "";
    const ownApi = await req("GET", "/api/tasks", null, { headers: { Origin: OWN }, token });
    ok("同源 + token 调业务接口 → 200", ownApi.status === 200, "status=" + ownApi.status);

    section("2) 另一个回环端口的网页（实测过的攻击形态）");
    const foreign = await req("GET", "/api/auth/auto", null, { headers: { Origin: FOREIGN } });
    ok("跨端口 Origin 取自动身份 → 403", foreign.status === 403, "status=" + foreign.status);
    ok("跨端口响应不回显 ACAO（读不到 body 才是硬道理）",
      !foreign.headers["access-control-allow-origin"], String(foreign.headers["access-control-allow-origin"]));
    const foreignApi = await req("GET", "/api/tasks", null, { headers: { Origin: FOREIGN }, token });
    ok("拿着自家 token 也不能从跨端口来源调业务", foreignApi.status === 403, "status=" + foreignApi.status);
    const preflight = await req("OPTIONS", "/api/auth/auto", null, { headers: { Origin: FOREIGN, "Access-Control-Request-Method": "GET" } });
    ok("跨端口预检不放行", preflight.status !== 204 || !preflight.headers["access-control-allow-origin"],
      "status=" + preflight.status + " acao=" + preflight.headers["access-control-allow-origin"]);

    section("3) 其它来源形态");
    const nullOrigin = await req("GET", "/api/auth/auto", null, { headers: { Origin: "null" } });
    ok("Origin: null（沙箱 iframe / file://）→ 403", nullOrigin.status === 403, "status=" + nullOrigin.status);
    const evil = await req("GET", "/api/auth/auto", null, { headers: { Origin: "http://localhost.evil.com:" + PORT } });
    ok("域名伪装（localhost.evil.com）→ 403", evil.status === 403, "status=" + evil.status);
    const rebinding = await req("GET", "/api/auth/auto", null, { headers: { Origin: "http://evil.example.com" } });
    ok("公网来源 → 403", rebinding.status === 403, "status=" + rebinding.status);
    const badHost = await req("GET", "/api/auth/auto", null, { headers: { Origin: OWN, Host: "evil.example.com:" + PORT } });
    ok("Host 伪装在来源闸之前就被拒", badHost.status === 403, "status=" + badHost.status);

    section("4) 不带 Origin 的原生客户端仍然可用（不能顺手把 CLI/Electron 关死）");
    const noOrigin = await req("GET", "/api/auth/auto", null, {});
    ok("无 Origin 的自动身份 → 200", noOrigin.status === 200 && !!noOrigin.json.token, "status=" + noOrigin.status);
    const noOriginApi = await req("GET", "/api/tasks", null, { token });
    ok("无 Origin + token 调业务 → 200", noOriginApi.status === 200, "status=" + noOriginApi.status);
    const staticRes = await req("GET", "/", null, { headers: { Origin: FOREIGN } });
    ok("跨端口取静态首页不报错但不给 CORS 头", !staticRes.headers["access-control-allow-origin"],
      "acao=" + staticRes.headers["access-control-allow-origin"]);
    const staticOwn = await req("GET", "/", null, {});
    ok("首页本身照常可取（应用还能打开）", staticOwn.status === 200 && staticOwn.raw.indexOf("pancode") > -1, "status=" + staticOwn.status);

    section("5) WebSocket 握手（命令执行通道：握手没有「读响应」这一步，CORS 帮不上）");
    const wsOwn = await wsOpen(OWN, token);
    ok("自家来源 + 有效 token 的 WS 能连上", wsOwn.opened, wsOwn.why || "");
    const wsForeign = await wsOpen(FOREIGN, token);
    ok("跨端口来源的 WS 握手被拒", !wsForeign.opened, "竟然连上了" );
    const wsEvil = await wsOpen("http://evil.example.com", token);
    ok("公网来源的 WS 握手被拒", !wsEvil.opened, "竟然连上了");

    section("6) 阳性对照：闸门没有把所有请求一起拒掉");
    /* 口径要说清：/api/health 也在来源闸后面 —— 跨源浏览器页面同样读不到它，这是有意的
       （健康状态也算信息面）。判"服务是否就绪"走的是无 Origin 的原生请求，那条必须通。 */
    const healthNative = await req("GET", "/api/health", null, {});
    ok("无 Origin 的健康探测照常可用（探针/桌面端靠它判就绪）", healthNative.status === 200, "status=" + healthNative.status);
    const healthForeign = await req("GET", "/api/health", null, { headers: { Origin: FOREIGN } });
    ok("跨端口来源连健康探测也读不到（信息面一并收紧）", healthForeign.status === 403, "status=" + healthForeign.status);
  } catch (e) {
    fail++; fails.push("探针异常: " + (e.stack || e.message));
    console.log("\x1b[31m探针异常：" + (e.stack || e.message) + "\x1b[0m");
    console.log(tail());
  } finally {
    if (other) try { other.close(); } catch (e) {}
    try { child.kill(); } catch (e) {}
    for (let i = 0; i < 40; i++) { await wait(100); try { await req("GET", "/api/health"); } catch (e) { break; } }
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch (e) {}
  }
  console.log("\n\x1b[1m来源隔离：通过 " + pass + " / 失败 " + fail + "\x1b[0m");
  if (fail) { console.log("失败项：\n  - " + fails.join("\n  - ")); process.exit(1); }
})();
