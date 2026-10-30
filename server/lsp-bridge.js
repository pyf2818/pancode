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
const log = require("./logger");
const { WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const auth = require("./auth");

/* ---------- 单例访问器：让 Agent（server/agent-llm.js）能拿到与主进程同一个 LspManager 实例 ---------- */
let _activeManager = null;
function setActiveManager(m) { _activeManager = m; }
function getActiveManager() { return _activeManager; }

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

/* initialize 里的 rootUri / workspaceFolders 是客户端给的，和 query 上那个 root 可以不一样。
   桥接层已经判过授权，就以判过的结果为准重写：语言服务器要扫描、要索引的范围，
   到这里才真的等于"已授权的工作区"。只动 initialize 这一帧，其余 RPC 原样透传。 */
function pinInitializeRoot(msg, rootAbs, rootUri) {
  if (!msg || msg.method !== "initialize" || !rootAbs) return msg;
  const uri = rootUri || ("file:///" + String(rootAbs).replace(/\\/g, "/"));
  const params = Object.assign({}, msg.params || {}, {
    rootUri: uri,
    rootPath: rootAbs,
    workspaceFolders: [{ uri, name: path.basename(rootAbs), index: 0 }],
  });
  return Object.assign({}, msg, { params });
}

/* ---------- 默认语言服务器定义（可被 pancode.config.json 的 lsp.servers 覆盖） ---------- */
const DEFAULT_SERVERS = {
  python: { command: "pyright-langserver", args: ["--stdio"], enabled: true,  docs: "npm i -g pyright" },
  go:     { command: "gopls",              args: [],         enabled: false, docs: "go install golang.org/x/tools/gopls@latest" },
  rust:   { command: "rust-analyzer",      args: [],         enabled: false, docs: "随 Rust 工具链安装" },
  cpp:    { command: "clangd",             args: [],         enabled: false, docs: "系统安装 clangd" },
  java:   { command: "jdtls",              args: [],         enabled: false, docs: "Eclipse JDT Language Server" },
};

class LspManager {
  /* cfg：pancode 配置；hooks（审查项 F13）由 server/index.js 注入，本模块不认得授权清单长什么样：
     - findRoot(absPath) → 授权条目或 null（与 Agent 用的是同一份 .pancode/roots.json）
     - defaultRoot()     → 当前工作区目录（客户端没给 root 时用它）
     两个都不给时按"没有任何授权"处理：宁可不给起语言服务器，也不让 root 变成客户端说了算。 */
  constructor(cfg, hooks) {
    this.cfg = cfg || {};
    this.hooks = hooks || {};
    this.servers = Object.assign({}, DEFAULT_SERVERS, (this.cfg.lsp && this.cfg.lsp.servers) || {});
    this.wss = new WebSocketServer({
      noServer: true,
      /* 子协议回显的唯一正确位置：handleUpgrade 只有 (req, socket, head, cb) 四个参数，
         多塞一个 headers 会把 cb 顶掉；completeUpgrade 在 protocols.size > 0 时才调本钩子，
         返回值写进 Sec-WebSocket-Protocol 响应头，浏览器才不会因"未选择子协议"断开。 */
      handleProtocols: (protocols) => {
        for (const p of protocols) if (p.indexOf("bearer.") === 0) return p;
        return false;
      },
    });
    this.wss.on("connection", (ws, req) => this._onConnection(ws, req));
    // 实时诊断缓存：归一化绝对路径 -> { abs, language, uri, items, at }
    // 由后端在代理 textDocument/publishDiagnostics 时填充，Agent 通过 getDiagnostics 查询
    this._diagnostics = new Map();
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

  /* ============================================================
     诊断缓存与查询（供 Agent get_diagnostics 工具 / 前端调试用）
     ============================================================ */

  /* 归一化路径：去 file:// 前缀、解码、统一为正斜杠、去首尾斜杠、盘符小写。
     这样 Windows (E:\x) 与 LSP uri (file:///E:/x) 能可靠地做前缀匹配。 */
  _normPath(p) {
    if (!p) return "";
    let s = decodeURIComponent(p);
    s = s.replace(/\\/g, "/");
    s = s.replace(/^\/+/, "");
    s = s.replace(/\/+$/, "");
    s = s.replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
    return s.toLowerCase();
  }

  _absFromUri(uri) {
    if (!uri) return null;
    if (uri.startsWith("file://")) return decodeURIComponent(uri.slice("file://".length));
    return null;
  }

  _storeDiagnostics(lang, uri, items) {
    const originalAbs = this._absFromUri(uri);
    if (!originalAbs) return;
    const norm = this._normPath(originalAbs);
    this._diagnostics.set(norm, { abs: originalAbs, language: lang, uri, items, at: Date.now() });
  }

  _relFrom(ws, originalAbs) {
    const w = this._normPath(ws || "");
    const lower = this._normPath(originalAbs);
    if (w && lower.startsWith(w + "/")) return lower.slice(w.length + 1);
    return lower;
  }

  /* 供 Agent 查询：
     - relPath 给定时返回单个文件诊断（items 可能为空数组 = 该文件无错误）
     - 不传 relPath 时返回当前工作区全部诊断（按文件聚合，含错误/警告计数） */
  getDiagnostics(workspaceDir, relPath) {
    if (relPath) {
      const originalAbs = path.resolve(workspaceDir || "", relPath);
      const norm = this._normPath(originalAbs);
      const e = this._diagnostics.get(norm);
      return { ok: true, scope: "file", path: relPath, language: e ? e.language : null, items: e ? e.items : [] };
    }
    const w = this._normPath(workspaceDir || "");
    const out = [];
    for (const [, e] of this._diagnostics) {
      if (w && !this._normPath(e.abs).startsWith(w + "/")) continue;
      out.push({ path: this._relFrom(workspaceDir || "", e.abs), language: e.language, items: e.items, at: e.at });
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    let errors = 0, warnings = 0;
    for (const f of out) for (const d of f.items) {
      if (d.severity === 1) errors++;
      else if (d.severity === 2) warnings++;
    }
    return { ok: true, scope: "workspace", errors, warnings, files: out };
  }

  /* 清空诊断缓存（如工作区卸载时调用，Agent 侧一般不会用到） */
  clearDiagnostics() { this._diagnostics.clear(); }

  /* ============================================================
     语言服务器的运行边界（审查项 F13）
     ============================================================ */

  _defaultRoot() {
    try { return typeof this.hooks.defaultRoot === "function" ? String(this.hooks.defaultRoot() || "") : ""; }
    catch (e) { return ""; }
  }

  /* file:///E:/proj、E:\proj、/home/u/p 都收进来，认不出来就返回 ""（改走默认工作区）。 */
  _rootToPath(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/^file:/i.test(s)) {
      try {
        const u = new URL(s);
        let p = decodeURIComponent(u.pathname);
        // Windows 的 file URL  pathname 会多一个前导斜杠：/E:/proj → E:/proj
        if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
        return p;
      } catch (e) { return ""; }
    }
    if (/^\/\//.test(s)) return "";         // UNC：不是任何工作区里的路径
    return s;
  }

  _pathToUri(abs) { return "file:///" + String(abs).replace(/\\/g, "/"); }

  /* root 由客户端给 = 任意一个起语言服务器的人都能把子进程 cwd 指到机器上任何目录，
     而语言服务器是会读文件、跑构建脚本的（pyright 读 pyproject、rust-analyzer 会 cargo metadata）。
     所以 root 必须落在这台机器上**已经授权过的工作区**里，与 Agent 用的那份清单同源；
     词法过了还要看真实路径——授权目录里一个指向别处的软链/junction，前缀匹配是看不出来的。 */
  _authorizeRoot(raw) {
    const p = this._rootToPath(raw);
    const abs = p ? path.resolve(p) : this._defaultRoot();
    if (!abs) return { error: "还没有可用的工作区，语言服务器不起" };
    const find = (v) => {
      try { return typeof this.hooks.findRoot === "function" ? this.hooks.findRoot(v) : null; }
      catch (e) { return null; }
    };
    if (!find(abs)) return { error: "该目录不在已授权的工作区里，语言服务器不起：" + abs };
    try {
      const real = fs.realpathSync(abs);
      if (real && real !== abs && !find(real)) {
        return { error: "该目录经软链指向授权范围外，已拒绝：" + abs };
      }
    } catch (e) { /* 目录还不存在：词法已授权，交给子进程自己报"起不来" */ }
    return { abs, uri: this._pathToUri(abs) };
  }

  /* 子进程环境：语言服务器要的是 PATH/SYSTEMRoot/TEMP/HOME 这类，不是本机的一柜子凭据。
     以前整份 process.env 直接继承 —— OPENAI_API_KEY、会话令牌、云服务密钥全在里面，
     任何一个语言服务器崩溃后被 core dump 或被插件读取，都是白送。
     这里按"名字长得像凭据"摘掉，而不是用一张白名单：白名单会漏掉 gopls 需要的 GOFLAGS
     一类真实依赖，先把确凿的泄漏面收口，不拿合法用法赌气。 */
  _childEnv() {
    const out = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^PANCODE_/i.test(k)) continue;                       // 本项目的数据根 / 探针开关，语言服务器不需要
      if (/(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|AUTH|SIGNING_KEY|PRIVATE_KEY|ACCESS_KEY)(_|$)/i.test(k)) continue;
      out[k] = v;
    }
    return out;
  }

  /* 修 C-B2：令牌不再走 query string，改走 Sec-WebSocket-Protocol
     （浏览器 WebSocket API 无法自定义 header；协议名不进 URL，不入历史/Referer/日志）。
     query 兜底与 HTTP 侧共用同一个开关 PANCODE_ALLOW_TOKEN_QUERY=1。 */
  handleUpgrade(req, socket, head) {
    const u = new URL(req.url, "http://localhost");
    const legacy = process.env.PANCODE_ALLOW_TOKEN_QUERY === "1" ? (u.searchParams.get("token") || "") : "";
    const offered = String(req.headers["sec-websocket-protocol"] || "");
    const chosen = offered.split(",").map((s) => s.trim()).find((p) => p.indexOf("bearer.") === 0);
    const tok = (chosen ? decodeURIComponent(chosen.slice(7)) : "") || legacy;
    if (!auth.verify(tok)) { socket.destroy(); return; }
    /* root 在这里就判，判完才升级：升级成功后连接就是个能起子进程的通道，
       能更早拒绝就不留一个"已经连上、马上又被关掉"的空窗给前端去猜。 */
    const r = this._authorizeRoot(u.searchParams.get("root") || "");
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws._lspParams = {
        lang: (u.searchParams.get("lang") || "").toLowerCase(),
        root: r.abs || "", rootUri: r.uri || "", rootError: r.error || "",
      };
      ws._userToken = tok;
      this.wss.emit("connection", ws, req);
    });
  }

  _onConnection(ws, req) {
    const { lang, root, rootUri, rootError } = ws._lspParams || {};
    const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

    if (!lang || !this.servers[lang] || !this.servers[lang].enabled) {
      send({ type: "lsp.error", language: lang || "", message: "该语言未启用 LSP（在 pancode.config.json 的 lsp.servers 中开启）" });
      return ws.close();
    }
    if (rootError) {
      send({ type: "lsp.error", language: lang, message: rootError });
      return ws.close();
    }
    const def = this.servers[lang];

    let proc;
    try {
      proc = spawn(def.command, def.args || [], {
        /* cwd 一定是上面授权过的绝对路径；这里绝不再退回 process.cwd()——
           打包态那是 Program Files 里的安装目录，让语言服务器在那儿起等于换了个越界方向。 */
        cwd: root,
        env: this._childEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
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
      // 后端顺手缓存诊断：供 Agent 的 get_diagnostics 工具读取，模型据此自我修正编译/类型错误
      if (msg && msg.method === "textDocument/publishDiagnostics" && msg.params && msg.params.uri) {
        this._storeDiagnostics(lang, msg.params.uri, msg.params.diagnostics || []);
      }
      // 把语言服务器发来的 LSP 消息原样转发给前端（前端负责解释）
      send({ type: "lsp.msg", language: lang, msg });
    };

    proc.stdout.on("data", (d) => parser.push(d));
    proc.stderr.on("data", (d) => {
      const text = d.toString("utf8").trim();
      if (text) log.tag("lsp").warn(lang + ": " + text.split("\n")[0]);
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
        const msg = pinInitializeRoot(obj.msg, root, rootUri);
        try { proc.stdin.write(encodeLsp(msg)); } catch (e) {
          send({ type: "lsp.error", language: lang, message: `写入语言服务器失败：${e.message}` });
        }
      }
    });

    // 前端断开 → 杀掉语言服务器子进程
    ws.on("close", () => { try { proc.kill("SIGTERM"); } catch (e) {} });

    send({ type: "lsp.ready", language: lang, command: def.command });
  }
}

module.exports = { LspManager, DEFAULT_SERVERS, encodeLsp, LspParser, pinInitializeRoot, setActiveManager, getActiveManager };
