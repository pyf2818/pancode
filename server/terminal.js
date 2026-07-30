/* ============================================================
   pancode 终端层 —— AI 与用户共用的真实命令执行
   - shell 模式执行任意命令（cwd 固定在 workspace）
   - 输出实时逐行推送 + 完整聚合返回给 Agent
   - 超时保护 / 输出上限保护（防挂死、防刷屏）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { check } = require("./security");

const MAX_OUT = 200 * 1024;   // 单次命令最多聚合 200KB 输出
const DEFAULT_TIMEOUT = 60_000;

function classify(line) {
  if (/\u2713|PASS|passed/.test(line)) return "tl-ok";
  if (/\u2717|FAIL|failed|Error|error:|Exception/.test(line)) return "tl-err";
  if (/, 0 失败/.test(line)) return "tl-ok";
  if (/[1-9]\d* 失败|warn/i.test(line)) return "tl-warn";
  return "tl-cmd";
}

class TerminalLayer {
  constructor(wsDir, emit, auditDir) {
    this.dir = wsDir;
    this.emit = emit;      // 广播事件
    this.auditDir = auditDir || null;
    this.current = null;   // 当前运行的子进程
  }

  get busy() { return !!this.current; }

  /**
   * 真实执行命令。argv 提供时用无 shell 精确执行（AI 内部用），
   * 否则走系统 shell（用户手敲命令用，支持管道等）。
   */
  run(displayCmd, argv, opts) {
    opts = opts || {};
    const display = argv ? argv.join(" ") : displayCmd;
    const sec = check(display, !!opts.strict);
    if (sec.blocked) {
      this.emit({ type: "term.line", text: "[已拒绝执行] " + sec.reason + "： " + display.slice(0, 200), cls: "tl-err" });
      return Promise.resolve({ code: -1, out: "", blocked: true, timedOut: false });
    }
    this.emit({ type: "term.cmd", text: displayCmd });
    if (this.auditDir) this._audit(opts.ai ? "AI" : "user", displayCmd);
    return new Promise((resolve) => {
      let child;
      try {
        child = argv
          ? spawn(argv[0], argv.slice(1), { cwd: this.dir })
          : spawn(displayCmd, { cwd: this.dir, shell: true });
      } catch (err) {
        this.emit({ type: "term.line", text: String(err), cls: "tl-err" });
        return resolve({ code: -1, out: String(err), timedOut: false });
      }
      this.current = child;
      let out = "", truncated = false, timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        this.emit({ type: "term.line", text: "[超时 " + ((opts.timeout || DEFAULT_TIMEOUT) / 1000) + "s，已终止]", cls: "tl-err" });
        try { child.kill(); } catch (e) {}
      }, opts.timeout || DEFAULT_TIMEOUT);

      const onData = (buf) => {
        const s = buf.toString("utf8");
        if (out.length < MAX_OUT) out += s;
        else if (!truncated) { truncated = true; out += "\n[输出过长，已截断]"; }
        s.split(/\r?\n/).forEach((line, i, arr) => {
          if (i === arr.length - 1 && line === "") return;
          this.emit({ type: "term.line", text: line.slice(0, 2000), cls: classify(line) });
        });
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("close", (code) => {
        clearTimeout(timer);
        this.current = null;
        this.emit({ type: "term.exit", code });
        resolve({ code: timedOut ? -2 : code, out, timedOut });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        this.current = null;
        this.emit({ type: "term.line", text: String(err), cls: "tl-err" });
        resolve({ code: -1, out: String(err), timedOut: false });
      });
    });
  }

  /* A6：命令审计日志——每次真实执行的命令落盘到 .pancode/audit/<日期>.log，可追溯 AI/用户行为 */
  _audit(source, cmd) {
    try {
      fs.mkdirSync(this.auditDir, { recursive: true });
      const f = path.join(this.auditDir, new Date().toISOString().slice(0, 10) + ".log");
      const line = new Date().toISOString() + " | " + source + " | " + String(cmd).replace(/\r?\n/g, " ") + "\n";
      fs.appendFileSync(f, line);
    } catch (e) {}
  }

  /* 中断当前命令（对齐 VS Code 终端 Ctrl+C） */
  kill() {
    if (this.current) { try { this.current.kill(); } catch (e) {} return true; }
    return false;
  }
}

module.exports = { TerminalLayer, classify };
