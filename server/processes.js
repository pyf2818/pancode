/* ============================================================
   pancode 长驻进程层 —— Agent 的后台进程管理（dev server / watcher 等）
   - start：spawn 常驻进程，输出进环形缓冲并同步流入 Agent 终端标签
   - stop：杀进程树（Windows 用 taskkill /T /F，其余用 kill）
   - read：读取缓冲尾部输出
   - probe：TCP 端口探活（服务就绪检测）
   ============================================================ */
"use strict";
const net = require("net");
const { spawn } = require("child_process");
const { _sanitizeEnv, classify, AI_TERM_TAB } = require("./terminal");

const MAX_BUFFER_LINES = 800;   // 每进程环形缓冲行数
const MAX_LINE_LEN = 2000;

class ManagedProcess {
  constructor(name, command, pid, child, emit) {
    this.name = name;
    this.command = command;
    this.child = child;
    this.pid = pid;
    this.startedAt = Date.now();
    this.exitCode = null;       // null = 运行中
    this.buffer = [];           // [{ cls, text }]
    this.emit = emit;
  }
  get alive() { return this.exitCode === null && !this.child.killed; }
  push(cls, text) {
    this.buffer.push({ cls, text: String(text).slice(0, MAX_LINE_LEN) });
    if (this.buffer.length > MAX_BUFFER_LINES) this.buffer.shift();
  }
  tail(n) {
    const lines = n && n > 0 ? this.buffer.slice(-Math.min(n, MAX_BUFFER_LINES)) : this.buffer;
    if (!lines.length) return "(暂无输出)";
    return lines.map((l) => l.text).join("\n");
  }
  info() {
    return { name: this.name, pid: this.pid, command: this.command, alive: this.alive, exitCode: this.exitCode, startedAt: this.startedAt, outputLines: this.buffer.length };
  }
}

class ProcessLayer {
  constructor(wsDir, emit, auditDir) {
    this.dir = wsDir;
    this.emit = emit;           // 与 TerminalLayer 共用广播通道
    this.auditDir = auditDir || null;
    this.procs = new Map();     // name -> ManagedProcess
  }

  /* 启动长驻进程；重名先停旧进程。返回 { ok, pid } 或 { ok:false, error } */
  start(name, command, audit) {
    name = String(name || "").trim();
    command = String(command || "").trim();
    if (!name || !command) return { ok: false, error: "name 与 command 必填" };
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) return { ok: false, error: "name 仅允许字母/数字/下划线/连字符（≤40 字符）" };
    if (this.procs.has(name)) { try { this.stop(name); } catch (e) {} }
    const child = spawn(command, { cwd: this.dir, shell: true, env: _sanitizeEnv(), windowsHide: true });
    const mp = new ManagedProcess(name, command, child.pid, child, this.emit);
    this.procs.set(name, mp);
    if (this.auditDir) this._audit(command);
    mp.push("tl-info", "[已启动] pid=" + child.pid);
    this.emit({ type: "term.cmd", tabId: AI_TERM_TAB, text: "[process:" + name + "] " + command });
    const onData = (buf) => {
      buf.toString("utf8").split(/\r?\n/).forEach((line, i, arr) => {
        if (i === arr.length - 1 && line === "") return;
        mp.push(classify(line), line);
        this.emit({ type: "term.line", tabId: AI_TERM_TAB, text: "[" + name + "] " + line.slice(0, MAX_LINE_LEN), cls: classify(line) });
      });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => { mp.push("tl-err", String(err)); this.emit({ type: "term.line", tabId: AI_TERM_TAB, text: "[" + name + "] 进程错误: " + err, cls: "tl-err" }); });
    child.on("close", (code) => {
      mp.exitCode = code;
      mp.push(code === 0 ? "tl-ok" : "tl-err", "[已退出] exit=" + code);
      this.emit({ type: "term.line", tabId: AI_TERM_TAB, text: "[" + name + "] 进程已退出 (exit " + code + ")", cls: code === 0 ? "tl-ok" : "tl-err" });
    });
    return { ok: true, pid: child.pid };
  }

  /* 停止进程（杀整棵进程树） */
  stop(name) {
    const mp = this.procs.get(name);
    if (!mp) return { ok: false, error: "未找到进程: " + name };
    if (mp.alive) {
      try {
        if (process.platform === "win32" && mp.pid) {
          spawn("taskkill", ["/PID", String(mp.pid), "/T", "/F"], { windowsHide: true });
        } else {
          try { if (mp.child.pid) process.kill(-mp.child.pid); } catch (e) { mp.child.kill("SIGKILL"); }
        }
      } catch (e) { try { mp.child.kill("SIGKILL"); } catch (e2) {} }
      mp.push("tl-warn", "[已手动停止]");
      this.emit({ type: "term.line", tabId: AI_TERM_TAB, text: "[" + name + "] 进程已被停止", cls: "tl-warn" });
    }
    return { ok: true };
  }

  /* 读取输出尾部 */
  read(name, lines) {
    const mp = this.procs.get(name);
    if (!mp) return { ok: false, error: "未找到进程: " + name + "（可用进程: " + (this.list().filter((p) => p.alive).map((p) => p.name).join(", ") || "无") + "）" };
    return { ok: true, info: mp.info(), output: mp.tail(lines || 100) };
  }

  list() {
    const out = [];
    for (const mp of this.procs.values()) out.push(mp.info());
    return out;
  }

  /* TCP 端口探活：服务就绪检测（IPv4/IPv6 回环） */
  probe(port, timeout) {
    port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve({ ok: false, error: "端口必须是 1-65535 的整数" });
    const t = Math.min(Math.max(Number(timeout) || 3000, 500), 10000);
    return new Promise((resolve) => {
      const done = (open) => { try { s.destroy(); } catch (e) {} resolve({ ok: true, port, open }); };
      const s = net.connect({ port, host: "127.0.0.1" });
      s.setTimeout(t);
      s.on("connect", () => done(true));
      s.on("timeout", () => done(false));
      s.on("error", () => done(false));
    });
  }

  /* 切换工作区 / 关服时清理全部托管进程（孤儿防护） */
  stopAll() {
    for (const name of [...this.procs.keys()]) { try { this.stop(name); } catch (e) {} }
    this.procs.clear();
  }

  /* 审计日志：AI 启动的长驻进程落盘可追溯 */
  _audit(cmd) {
    try {
      const fs = require("fs");
      const path = require("path");
      fs.mkdirSync(this.auditDir, { recursive: true });
      const f = path.join(this.auditDir, new Date().toISOString().slice(0, 10) + ".log");
      fs.appendFileSync(f, new Date().toISOString() + " | AI-process | " + String(cmd).replace(/\r?\n/g, " ") + "\n");
    } catch (e) {}
  }
}

module.exports = { ProcessLayer };