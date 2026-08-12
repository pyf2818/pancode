/* ============================================================
   pancode · 真实 LSP 桥接层（后端）
   ------------------------------------------------------------
   设计原则（第一性原理）：
   1. 不引入需要重写 Monaco 的 @codingame/monaco-vscode —— 保留已有的
      vendored Monaco。前端用「轻量 LSP 客户端」直接把 LSP 结果喂给 Monaco 的
      marker / completion / hover / definition API。
   2. 后端只做「协议翻译 + 进程管理」：每个 WS 连接对应一个语言服务器子进程
      （stdio 上的 LSP JSON-RPC，Content-Length 分帧），WS 与子进程之间双向代理。
   3. TS/JS/JSON/CSS/HTML 继续用 Monaco 内置 worker（零配置、离线），不重复起服。
      其余语言（python/go/rust...）走真实语言服务器。
   4. 优雅降级：语言服务器未安装 / spawn 失败时，向前端发 lsp.error 并关闭，
      绝不影响主流程。
   ============================================================ */
"use strict";
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");
const auth = require("./auth");

/* ---------- LSP stdio 分帧解析（Content-Length: N\r\n\r\n{json}） ---------- */
class LspParser {
  constructor() { this.buf = Buffer.alloc(0); this.onMessage = null; }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.drain();
  }
  drain() {
    while (true) {
      const sep = this.buf.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const header = this.buf.slice(0, sep).toString("utf8");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { this.buf = Buffer.alloc(0); return; }   // 非 LSP 帧，放弃
      const len = parseInt(m[1], 10);
      const start = sep + 4;
      if (this.buf.length < start + len) return;         // 等更多数据
      const body = this.buf.slice(start, start + len).toString("utf8");
      this.buf = this.buf.slice(start + len);
      try { if (this.onMessage) this.onMessage(JSON.parse(body)); } catch (e) { /* 忽略坏帧 */ }
    }
  }
}

function encodeLsp(obj) {
  const json = JSON.stringify(obj);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`, "utf8");
}

/* ---------- 默认语言服务器定义（可被 pancode.config.json 的 lsp.servers 覆盖） ---------- */
const DEFAULT_SERVERS = {
  python: { command: "pyright-langserver", args: ["--stdio"], enabled: true,  docs: "npm i -g pyright（需已装 Python）" },
  go:     { command: "gopls",              args: [],         enabled: false, docs: "go install golang.org/x/tools/gopls@latest" },
  rust:   { command: "rust-analyzer",      args: [],         enabled: false, docs: "随 Rust 工具链安装" },
  cpp:    { command: "clangd",             args: [],         enabled: false, docs: "系统安装 clangd" },
  java:   { command: "jdtls",              args: [],         enabled: false, docs: "Eclipse JDT Language Server" },
};

class LspManager {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.servers = Object.assign({}, DEFAULT_SERVERS, (this.cfg.lsp && this.cfg.lsp.servers) || {});
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this._onConnection(ws, req));
  }

  /* 给前端的能力清单（哪些语言有 LSP 可用） */
  capabilities() {
    const list = {};
    for (const [lang, def] of Object.entries(this.servers)) {
      list[lang] = { enabled: !!def.enabled, command: def.command, docs: def.docs || "" };
    }
    return { enabled: !this.cfg.lsp || this.cfg.lsp.enabled !== false, servers: list };
  }

  createWss() { return this.wss; }

  handleUpgrade(req, socket, head) {
    const u = new URL(req.url, "http://localhost");
    const tok = u.searchParams.get("token") || "";
    if (!auth.verify(tok)) { socket.destroy(); return; }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws._lspParams = { lang: (u.searchParams.get("lang") || "").toLowerCase(), root: u.searchParams.get("root") || "" };
      this.wss.emit("connection", ws, req);
    });
  }

  _onConnection(ws, req) {
    const { lang, root } = ws._lspParams || {};
    const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

    if (!lang || !this.servers[lang] || !this.servers[lang].enabled) {
      send({ type: "lsp.error", language: lang || "", message: "该语言未启用 LSP（在 pancode.config.json 的 lsp.servers 中开启）" });
      return ws.close();
    }
    const def = this.servers[lang];

    let proc;
    try {
      proc = spawn(def.command, def.args || [], {
        cwd: root || process.cwd(),
        env: Object.assign({}, process.env),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      send({ type: "lsp.error", language: lang, message: `语言服务器启动失败：${e.message}（${def.docs || ""}）` });
      return ws.close();
    }
    if (!proc.pid) {
      send({ type: "lsp.error", language: lang, message: `找不到语言服务器「${def.command}」（${def.docs || ""}）` });
      return ws.close();
    }

    const parser = new LspParser();
    parser.onMessage = (msg) => {
      // 把语言服务器发来的 LSP 消息原样转发给前端（前端负责解释）
      send({ type: "lsp.msg", language: lang, msg });
    };

    proc.stdout.on("data", (d) => parser.push(d));
    proc.stderr.on("data", (d) => {
      const text = d.toString("utf8").trim();
      if (text) console.warn(`[lsp:${lang}] ${text.split("\n")[0]}`);
    });
    proc.on("exit", (code, sig) => {
      send({ type: "lsp.exit", language: lang, code: code ?? null, signal: sig || null });
      try { ws.close(); } catch (e) {}
    });
    proc.on("error", (e) => {
      send({ type: "lsp.error", language: lang, message: `语言服务器异常：${e.message}` });
      try { ws.close(); } catch (e2) {}
    });

    // 前端 → 语言服务器（JSON-RPC 透传，桥接层只做分帧）
    ws.on("message", (raw) => {
      let obj;
      try { obj = JSON.parse(raw.toString()); } catch (e) { return; }
      if (obj && obj.type === "lsp.send" && obj.msg) {
        try { proc.stdin.write(encodeLsp(obj.msg)); } catch (e) {
          send({ type: "lsp.error", language: lang, message: `写入语言服务器失败：${e.message}` });
        }
      }
    });

    // 前端断开 → 杀掉语言服务器子进程
    ws.on("close", () => { try { proc.kill("SIGTERM"); } catch (e) {} });

    send({ type: "lsp.ready", language: lang, command: def.command });
  }
}

module.exports = { LspManager, DEFAULT_SERVERS, encodeLsp, LspParser };
