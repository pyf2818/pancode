"use strict";
/* ============================================================
   桌面控制 worker 的生命周期管理（常驻 PowerShell + UIA）。

   为什么常驻：实测每次 spawn 一个 powershell.exe 要 1.0-1.3 秒，UIA 程序集首次加载
   再加 373ms。"看一眼窗口再点三下"要是每次都冷启动，光进程开销就十几秒。

   为什么脚本要先落盘再 -File 执行：打包态 server/** 在只读的 app.asar 里，
   Node 能读（它认 asar），**powershell.exe 不认 asar** —— 直接给它 asar 路径会报"找不到文件"。
   所以把脚本按内容写到数据根的 .pancode/computer/ 下，内容没变就不重写。

   参数走 base64：中文 Windows 的控制台代码页是 936，stdin 里直接写 UTF-8 的中文
   会被按 GBK 解码 —— 模型要输入的中文会糊成乱码。base64 之后与代码页彻底无关。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const IDLE_MS = 5 * 60000;
const READY_MS = 25000;
const DEFAULT_REQ_MS = 30000;

let _child = null;
let _seq = 0;
let _ready = null;               // Promise，_readyResolve 在收到 ready 行时兑现
let _buf = "";
let _pending = new Map();        // id -> { resolve, reject, timer, cmd }
let _idle = null;
let _readyResolve = null;
let _stderr = "";
let _scriptPath = null;
let _exited = false;

function supported() { return process.platform === "win32"; }

/* 把 uia.ps1 落到可写目录；内容一致就不动（避免每次开机都改时间戳、也避免探针里误判"没变所以没写"）。
   ⚠ 落盘必须带 UTF-8 BOM：Windows PowerShell 5.1 读没有 BOM 的 .ps1 时按**系统代码页**解释，
   中文 Windows 上就是 936 —— 脚本里的中文注释和错误文案会被按 GBK 拆成半个字符，
   某些字节还正好撞上 0x5C(\\) 或花括号，于是整份脚本以 ParserError 收场（实测：UnexpectedToken "}").
   仓库里那份保持无 BOM 的纯 UTF-8（git/编辑器友好），只在写盘这一步补 BOM。 */
const BOM = "﻿";
function materialize() {
  const cfg = require("../config");
  const dir = path.join(cfg.ROOT, ".pancode", "computer");
  const target = path.join(dir, "uia.ps1");
  const src = BOM + fs.readFileSync(path.join(__dirname, "uia.ps1"), "utf8");
  let same = false;
  /* 比较必须带上 BOM：上一版把两边都 stripBom 再比，于是"盘上那份没 BOM"永远算相同，
     加了 BOM 也永远写不回去 —— 症状就是 PS 5.1 继续按 936 代码页解析、继续 ParserError。 */
  try { same = fs.readFileSync(target, "utf8") === src; } catch (e) { same = false; }
  if (!same) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(target, src, "utf8"); }
  return target;
}

function killPending(err) {
  for (const [, p] of _pending) { clearTimeout(p.timer); p.reject(err); }
  _pending.clear();
}

function onLine(line) {
  const s = line.trim();
  if (!s || s[0] !== "{") return;
  let msg;
  try { msg = JSON.parse(s); } catch (e) { return; }
  if (msg.ready) {
    const r = _readyResolve;
    _readyResolve = null;
    if (r) r(true);
    return;
  }
  const p = _pending.get(msg.id);
  if (!p) return;
  _pending.delete(msg.id);
  clearTimeout(p.timer);
  touchIdle();
  p.resolve({ ok: !!msg.ok, data: msg.data, error: msg.error || null });
}

function touchIdle() {
  clearTimeout(_idle);
  _idle = setTimeout(() => { stop("空闲超时"); }, IDLE_MS);
}

function failExited(why) {
  _child = null;
  _ready = null;
  _exited = true;
  killPending(new Error(why));
}

function start() {
  if (_child && !_exited) return _ready;
  if (!supported()) return Promise.reject(new Error("桌面控制目前只支持 Windows（走的是 UI Automation）"));
  _exited = false;
  _buf = "";
  _stderr = "";
  try { _scriptPath = materialize(); } catch (e) { return Promise.reject(new Error("桌面控制脚本准备失败：" + e.message)); }
  let child;
  try {
    child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Sta", "-File", _scriptPath],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) { return Promise.reject(new Error("启动 powershell 失败：" + e.message)); }
  _child = child;
  child.stdout.on("data", (d) => {
    _buf += d.toString("utf8");
    let i;
    while ((i = _buf.indexOf("\n")) >= 0) { onLine(_buf.slice(0, i)); _buf = _buf.slice(i + 1); }
  });
  child.stderr.on("data", (d) => { _stderr = (_stderr + d.toString("utf8")).slice(-4000); });
  child.on("error", (e) => failExited("桌面控制进程启动失败：" + e.message));
  child.on("exit", (code) => {
    if (_child === child) failExited("桌面控制进程退出了（exit=" + code + "）" + (_stderr ? "；stderr: " + _stderr.slice(-200) : ""));
  });
  _ready = new Promise((resolve, reject) => {
    _readyResolve = resolve;
    setTimeout(() => { if (_readyResolve) { _readyResolve = null; reject(new Error("桌面控制进程 25 秒没就绪" + (_stderr ? "；stderr: " + _stderr.slice(-240) : ""))); } }, READY_MS);
  });
  touchIdle();
  return _ready;
}

async function ensure() {
  await start();
  return _child;
}

/* 一次命令。永不 reject：失败以 { ok:false, error } 返回，与 handler 层约定一致。
   开关判断不在这里：worker 看不到是哪个引擎在调，"总开关"由 desktop-tools 按 agent.cfg 判
   —— 两处各读一份配置迟早会漂，而且探针也没法在不调盘的情况下模拟"已关闭"。 */
async function request(cmd, args, timeoutMs) {
  if (!supported()) return { ok: false, error: "桌面控制目前只支持 Windows（走的是 UI Automation）" };
  let child;
  try { child = await ensure(); } catch (e) { return { ok: false, error: e.message }; }
  if (!child || !child.stdin) return { ok: false, error: "桌面控制进程不可用" };
  const id = ++_seq;
  const payload = JSON.stringify({ id, cmd, args_b64: Buffer.from(JSON.stringify(args || {}), "utf8").toString("base64") });
  const ms = Math.max(1000, timeoutMs || DEFAULT_REQ_MS);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (_pending.delete(id)) resolve({ ok: false, timedOut: true, error: "桌面控制命令 " + cmd + " 超过 " + Math.round(ms / 1000) + " 秒未返回" });
    }, ms);
    _pending.set(id, { resolve, reject: () => {}, timer, cmd });
    try { child.stdin.write(payload + "\n"); }
    catch (e) { clearTimeout(timer); _pending.delete(id); resolve({ ok: false, error: "写入桌面控制进程失败：" + e.message }); }
  });
}

function stop(reason) {
  clearTimeout(_idle);
  const c = _child;
  if (!c) return;
  try { c.stdin.write(JSON.stringify({ id: 0, cmd: "shutdown" }) + "\n"); } catch (e) { /* 已经断了 */ }
  setTimeout(() => { try { c.kill(); } catch (e) { /* 已经退出了 */ } }, 300);
  _child = null;
  killPending(new Error("桌面控制进程已停止（" + (reason || "退出") + "）"));
}

function status() {
  return {
    supported: supported(),
    running: !!_child && !_exited,
    pending: _pending.size,
    script: _scriptPath,
    reason: supported() ? "" : "桌面控制走 Windows UI Automation，当前平台不可用",
  };
}

module.exports = { request, status, stop, supported, materialize, IDLE_MS };
