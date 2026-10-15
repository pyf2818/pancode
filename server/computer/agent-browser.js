"use strict";
/* ============================================================
   agent-browser 封装 —— 浏览器自动化的唯一出口。

   为什么引一个外部原生 CLI，而不是走 MCP 挂 @playwright/mcp，也不是直接 require playwright：
   1) 它给的是无障碍树的纯文本快照（实测百度首页 -i 模式 20 行 / 约 600 token），
      而 pancode 的工具结果通道只能装字符串（agent-llm.js 的 _toolMsg），
      MCP 返回的 image 内容块会在 agent-llm.js:3217 被 JSON.stringify 抹成一坨元数据 ——
      "看像素报坐标"那条路要先动消息层、token 估算和压缩三处，成本最高。
   2) 打包态：它是单个 win32 exe（约 18MB），用户机器上不需要 Node/npx，
      也不把 playwright 的 alpha 版本拖进依赖树。
   3) 浏览器来源：--executable-path 指本机 Chrome/Edge 时走独立 temp user-data-dir
      （实测），既不下载 150MB 的 Chrome for Testing，也不碰用户自己的登录态。

   协议（实测 0.39.1）：stdout 一行 { success, data, error }，失败时进程 exit=1；
   每个 data 都重复带一段 lifecycle，进模型前统一剥掉。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const BIN_BY_PLATFORM = {
  "win32-x64": "agent-browser-win32-x64.exe",
  "darwin-x64": "agent-browser-darwin-x64",
  "darwin-arm64": "agent-browser-darwin-arm64",
  "linux-x64": "agent-browser-linux-x64",
  "linux-arm64": "agent-browser-linux-arm64",
};

const DEFAULT_TIMEOUT_MS = 45000;

function platformBinName() {
  if (process.platform === "win32") return BIN_BY_PLATFORM["win32-x64"];
  return BIN_BY_PLATFORM[process.platform + "-" + process.arch] || null;
}

/* agent-browser 的 npm 包把 7 个平台的二进制一起发（约 125MB），真正要跑的只有一个；
   打包时只留当前平台那一个，路径要跟着 electron-builder 的 asarUnpack 走 ——
   asar 里的文件 powershell/系统都读不到，可执行文件必须落在 app.asar.unpacked。 */
function fromPackage() {
  const bin = platformBinName();
  if (!bin) return null;
  let pkgDir;
  try { pkgDir = path.dirname(require.resolve("agent-browser/package.json")); } catch (e) { return null; }
  const candidates = [path.join(pkgDir, "bin", bin)];
  if (pkgDir.includes("app.asar")) {
    candidates.unshift(path.join(pkgDir.replace("app.asar", "app.asar.unpacked"), "bin", bin));
  }
  for (const p of candidates) { try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* 继续找下一个 */ } }
  return null;
}

/* 优先级：配置显式路径 > 环境变量 > 随包二进制。
   留前两个是因为装机用户可能已经全局装过 agent-browser，而随包那份版本被钉死在 package.json。 */
function resolveExe(cfg) {
  const c = (cfg && cfg.computer) || {};
  const explicit = [c.agentBrowserExe, process.env.PPCODE_AGENT_BROWSER];
  for (const p of explicit) {
    if (p) { try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* 配错了就退回随包那份 */ } }
  }
  return fromPackage();
}

/* 会话名要落到 agent-browser 的 session 里，只允许 [A-Za-z0-9_-]。
   默认（匿名）会话是整机共享的同一个浏览器，两个会话同时跑会互相抢页面，所以必须显式命名。 */
function sessionName(convId) {
  const base = String(convId || "default").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  return "pc-" + (base || "default");
}

/* 全局旗标一律放在子命令之前（实测这个位置才生效）。
   浏览器来源优先级：配置显式 chromePath > 自动探测本机已装的 Chrome/Edge > 留给 agent-browser 自己决定。
   最后那个兜底很贵：它会去下载 Chrome for Testing（约 150MB，实测首轮 open 就卡在那），
   而这台机器本来就有 Chrome —— 探测一次就把首字延迟从"几十秒"变成"1 秒"。
   探测到的是本机浏览器，但 agent-browser 会为它单独起临时 user-data-dir（实测），
   所以既不读也不写用户自己的登录态与 Cookie。 */
const CANDIDATES = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  ],
};

function detectBrowser() {
  const list = CANDIDATES[process.platform] || [];
  for (const raw of list) {
    const p = raw.replace(/%([A-Z_]+)%/g, (_, k) => process.env[k] || "");
    try { if (p && fs.statSync(p).isFile()) return p; } catch (e) { /* 下一个候选 */ }
  }
  return null;
}

let _detected;   // 只探一次：装/卸浏览器不是会话内会变的事
function browserPath(cfg) {
  const c = (cfg && cfg.computer) || {};
  if (c.chromePath) return String(c.chromePath);
  if (c.autoDetectBrowser === false) return null;
  if (_detected === undefined) _detected = detectBrowser();
  return _detected;
}

function globalArgs(cfg) {
  const c = (cfg && cfg.computer) || {};
  const out = [];
  const exe = browserPath(cfg);
  if (exe) out.push("--executable-path", String(exe));
  const domains = Array.isArray(c.allowedDomains) ? c.allowedDomains.filter(Boolean) : [];
  if (domains.length) out.push("--allowed-domains", domains.join(","));
  if (c.headed === true) out.push("--headed");
  return out;
}

function parseJsonLine(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i][0] !== "{") continue;
    try {
      const j = JSON.parse(lines[i]);
      if (j && typeof j === "object" && ("success" in j || "data" in j || "error" in j)) return j;
    } catch (e) { /* 不是 JSON，继续往上找 */ }
  }
  return null;
}

/* lifecycle 每个响应都带，且全是 daemon 内部状态（launchHash / reused / saveStatus），
   对模型没有信息量，却会按 token 计价。 */
function stripNoise(data) {
  if (!data || typeof data !== "object") return data;
  const out = Object.assign({}, data);
  delete out.lifecycle;
  /* snapshot 同时给 refs 映射表和 snapshot 文本，而文本里已经写了 [ref=eN] ——
     映射表是纯重复，留着等于把页面信息付两遍钱。 */
  if (out.snapshot && out.refs) delete out.refs;
  return out;
}

/* 一次 CLI 调用。永不 reject：失败以 { ok:false, error } 返回，
   与 handler 层"错误当作散文返回、不抛"的既有约定一致。

   ⚠ 这里不能用 child 的 "close" 事件收口（踩过一次，症状是整条工具链挂死 40s 直到超时）：
     agent-browser 第一次调用会 fork 一个**常驻 daemon**，daemon 继承了 stdout/stderr 句柄并长期持有，
     而 "close" 的语义是"进程退出**且所有 stdio 管道关闭**"—— 管道被 daemon 占着就永远不关。
     实测同一个命令在 bash 里 1 秒返回，在 Node 里就是这么死的。
   所以两条收口路径：
     1) 快路：stdout 是按行输出的协议（每次调用恰好一行 {success,...}），解析出来就立刻返回；
     2) 兜底：进程 "exit" 之后再给 300ms 让残余 data 事件落地，然后把缓冲区整块交出去
        （给 read 这类打印纯文本、不带 --json 结构的子命令用）。
   返回时主动 destroy 两个读端，否则那个被 daemon 持有的句柄会把服务端进程的事件循环一直吊住。 */
function call(exe, argv, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    if (!exe) { resolve({ ok: false, error: "agent-browser 未安装" }); return; }
    let child;
    try {
      child = spawn(exe, argv, { windowsHide: true, env: Object.assign({}, process.env, o.env || {}) });
    } catch (e) { resolve({ ok: false, error: "启动 agent-browser 失败：" + e.message }); return; }

    let out = "";
    let err = "";
    let settled = false;
    const ms = Math.max(1000, o.timeoutMs || DEFAULT_TIMEOUT_MS);
    const finish = (res, kill) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      try { child.stdout.destroy(); } catch (e) { /* 已经关了 */ }
      try { child.stderr.destroy(); } catch (e) { /* 已经关了 */ }
      if (kill) { try { child.kill(); } catch (e) { /* 已经退出了 */ } }
      resolve(res);
    };
    const timer = setTimeout(() => finish({
      ok: false, timedOut: true,
      error: "agent-browser 超过 " + Math.round(ms / 1000) + " 秒未返回，已中止",
    }, true), ms);
    let grace = null;

    /* 快路：协议是"一次调用一行 JSON"，第一行成功结构出现即可交差。 */
    const tryEarly = () => {
      const nl = out.indexOf("\n");
      if (nl < 0 && out.length < 2) return;
      const head = out.slice(0, nl < 0 ? out.length : nl);
      if (head[0] !== "{") return;
      try {
        const j = JSON.parse(head);
        if (j && typeof j.success === "boolean") {
          finish(j.success ? { ok: true, data: stripNoise(j.data) }
            : { ok: false, error: j.error || "agent-browser 返回失败但未说明原因", data: stripNoise(j.data) });
        }
      } catch (e) { /* 这一行还没写全，等下一个 chunk */ }
    };
    child.stdout.on("data", (d) => { out += d; if (!settled) tryEarly(); });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish({ ok: false, error: "agent-browser 调用失败：" + e.message }));
    child.on("exit", () => {
      if (settled) return;
      grace = setTimeout(() => {
        const j = parseJsonLine(out);
        if (j && typeof j.success === "boolean") {
          finish(j.success ? { ok: true, data: stripNoise(j.data) }
            : { ok: false, error: j.error || "agent-browser 返回失败但未说明原因", data: stripNoise(j.data) });
          return;
        }
        if (child.exitCode === 0) finish({ ok: true, text: String(out || "").trim() });
        else finish({ ok: false, error: String(err || out || "").trim() || ("agent-browser 退出码 " + child.exitCode) });
      }, 300);
    });
  });
}

/* 供 /api 与工具层共用的可用性判定。不抛错、不启动进程。 */
function status(cfg) {
  const c = (cfg && cfg.computer) || {};
  const exe = resolveExe(cfg);
  return {
    enabled: c.browser !== false,
    available: !!exe,
    exe,
    browser: browserPath(cfg),
    reason: exe ? "" : "未找到 agent-browser 可执行文件：跑 `npm install`（随包二进制在 node_modules/agent-browser/bin），或在 设置 → 电脑控制 里指定 agentBrowserExe / 环境变量 PPCODE_AGENT_BROWSER",
    binName: platformBinName(),
  };
}

module.exports = {
  resolveExe, status, call, sessionName, globalArgs, browserPath, detectBrowser,
  parseJsonLine, stripNoise, platformBinName, DEFAULT_TIMEOUT_MS,
};
