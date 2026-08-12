/* ============================================================
   pancode · MCP（Model Context Protocol）客户端与管理器（后端）
   ------------------------------------------------------------
   设计原则（与 lsp-bridge 一致，零额外依赖，纯 Node 标准库）：
   1. 仅实现 stdio 传输的 MCP：子进程在 stdin/stdout 上以「换行分隔的
      JSON-RPC 2.0」通信（MCP stdio 规范），stderr 仅作日志忽略。
   2. 进程管理 + 协议翻译：每个 enabled 的 mcpServer 对应一个子进程，
      完成 initialize → notifications/initialized → tools/list，
      之后保持长连接，供 Agent 随时 tools/call。
   3. 优雅降级：spawn 失败 / initialize 超时 / 进程退出 → 标记 status=error
      并向前端广播，绝不影响主流程（Agent 只是少几个外部工具）。
   4. 工具命名空间：对外暴露为 `mcp__<server>__<tool>`，execTool 按前缀路由。
   5. 规划模式（planMode）下，所有 mcp__ 工具与内置 mutating 工具一并禁止。
   ============================================================ */
"use strict";
const { spawn } = require("child_process");

const PROTOCOL_VERSION = "2024-11-05";
const INIT_TIMEOUT = 15000;
const CALL_TIMEOUT = 30000;

function sanitizeName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9_]/g, "_");
}

/* ---------- 单个 MCP 服务器连接（stdio JSON-RPC） ---------- */
class McpClient {
  constructor(def, manager) {
    this.def = def;                 // { name, command, args, env, cwd, enabled }
    this.manager = manager;
    this.proc = null;
    this.connected = false;
    this.status = "idle";           // idle | connecting | ready | error | exited | disabled
    this.error = "";
    this.tools = [];                 // [{ name, description, inputSchema }]
    this._buf = "";
    this._pending = new Map();       // id -> { resolve, reject, timer }
    this._nextId = 1;
    this._readyPromise = new Promise((res, rej) => { this._readyResolve = res; this._readyReject = rej; });
  }

  async connect() {
    if (!this.def.enabled) { this.status = "disabled"; this._readyResolve(); this.manager._emitStatus(this.def.name); return; }
    this.status = "connecting"; this.error = "";
    const args = Array.isArray(this.def.args)
      ? this.def.args.slice()
      : String(this.def.args || "").split(/\s+/).filter(Boolean);
    const env = Object.assign({}, process.env, this.def.env || {});
    let proc;
    try {
      proc = spawn(this.def.command, args, {
        env,
        cwd: this.def.cwd || process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      this._fail("spawn 失败: " + e.message);
      return;
    }
    this.proc = proc;
    proc.on("error", (e) => this._fail("进程错误: " + e.message));
    proc.on("exit", (code, sig) => {
      this.connected = false;
      if (this.status !== "error") { this.status = "exited"; this.error = "进程退出 code=" + code + (sig ? " signal=" + sig : ""); }
      this._readyReject(new Error(this.error || "MCP 进程已退出"));
      this.manager._emitStatus(this.def.name);
    });
    if (proc.stderr) proc.stderr.on("data", () => { /* 服务器日志，忽略 */ });
    proc.stdout.on("data", (chunk) => this._onData(chunk));

    try {
      await this._request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "pancode", version: "2.3.0" },
      }, INIT_TIMEOUT);
      this.connected = true;
      this._notify("notifications/initialized", {});
      const list = await this._request("tools/list", {}, INIT_TIMEOUT);
      this.tools = (list && Array.isArray(list.tools)) ? list.tools : [];
      this.status = "ready";
      this._readyResolve();
    } catch (e) {
      this._fail(e.message);
      return;
    }
    this.manager._emitStatus(this.def.name);
  }

  _fail(msg) {
    this.status = "error"; this.error = msg; this.connected = false;
    if (this._readyReject) this._readyReject(new Error(msg));
    this.manager._emitStatus(this.def.name);
  }

  _onData(chunk) {
    this._buf += chunk.toString("utf8");
    let idx;
    while ((idx = this._buf.indexOf("\n")) !== -1) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; } // 跳过坏行
      this._handle(msg);
    }
  }

  _handle(msg) {
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
    // 服务器发来的通知（如 progress）忽略
  }

  _request(method, params, timeout) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin) { reject(new Error("MCP 进程未启动")); return; }
      const id = this._nextId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const timer = setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); reject(new Error("请求超时: " + method)); }
      }, timeout || INIT_TIMEOUT);
      this._pending.set(id, { resolve, reject, timer });
      try { this.proc.stdin.write(payload + "\n"); }
      catch (e) { clearTimeout(timer); this._pending.delete(id); reject(e); }
    });
  }

  _notify(method, params) {
    try { if (this.proc && this.proc.stdin) this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); } catch (e) {}
  }

  async awaitReady(ms) {
    if (this.connected) return true;
    if (this.status === "error" || this.status === "exited" || this.status === "disabled") throw new Error(this.error || "MCP 未就绪");
    return Promise.race([
      this._readyPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("等待 MCP 连接超时")), ms || 20000)),
    ]);
  }

  async callTool(localName, args) {
    await this.awaitReady(CALL_TIMEOUT);
    return this._request("tools/call", { name: localName, arguments: args || {} }, CALL_TIMEOUT);
  }

  disconnect() {
    try { if (this.proc) this.proc.kill(); } catch (e) {}
    this.proc = null; this.connected = false; this.tools = []; this.status = "idle";
    for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(new Error("连接已关闭")); }
    this._pending.clear();
  }
}

/* ---------- MCP 管理器（多 server 注册表 + 工具暴露） ---------- */
class McpManager {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.clients = new Map();       // serverName -> McpClient
    this.onStatus = null;           // 由 index.js 注入：状态变化时广播前端
  }

  _defs() {
    const mcp = (this.cfg.mcp && Array.isArray(this.cfg.mcp.servers)) ? this.cfg.mcp.servers : [];
    return mcp.filter((s) => s && s.name && s.command);
  }

  connectAll() {
    for (const def of this._defs()) {
      const name = sanitizeName(def.name);
      const client = new McpClient(Object.assign({}, def, { name }), this);
      this.clients.set(name, client);
      client.connect();
    }
  }

  /* 重新对账（config 变更后）：新增 / 移除 / 重连变化的 server */
  sync() {
    const wanted = new Map(this._defs().map((d) => [sanitizeName(d.name), d]));
    // 移除不再需要的
    for (const [name, client] of this.clients) {
      if (!wanted.has(name)) { client.disconnect(); this.clients.delete(name); }
    }
    // 新增或（定义变化时）重连
    for (const [name, def] of wanted) {
      const existing = this.clients.get(name);
      const changed = existing && (
        existing.def.command !== def.command ||
        JSON.stringify(existing.def.args || []) !== JSON.stringify(def.args || []) ||
        JSON.stringify(existing.def.env || {}) !== JSON.stringify(def.env || {}) ||
        existing.def.enabled !== def.enabled
      );
      if (existing && !def.enabled) { existing.disconnect(); existing.status = "disabled"; }
      else if (existing && changed) {
        existing.disconnect();
        const client = new McpClient(Object.assign({}, def, { name }), this);
        this.clients.set(name, client); client.connect();
      } else if (!existing && def.enabled) {
        const client = new McpClient(Object.assign({}, def, { name }), this);
        this.clients.set(name, client); client.connect();
      }
    }
    if (this.onStatus) this.onStatus();
  }

  getClient(serverName) { return this.clients.get(serverName); }

  /* 关闭所有连接（进程退出时调用，避免孤儿进程） */
  disconnectAll() {
    for (const [, client] of this.clients) { try { client.disconnect(); } catch (e) {} }
    this.clients.clear();
  }

  /* 当前可用工具，转为 LLM 的 function 定义数组 */
  toolDefs() {
    const defs = [];
    for (const [server, client] of this.clients) {
      if (!client.connected) continue;
      for (const t of client.tools) {
        defs.push({
          type: "function",
          function: {
            name: "mcp__" + server + "__" + t.name,
            description: "[MCP·" + server + "] " + (t.description || t.name),
            parameters: (t.inputSchema && t.inputSchema.type)
              ? t.inputSchema
              : { type: "object", properties: {}, required: [] },
          },
        });
      }
    }
    return defs;
  }

  /* 按限定名调用：mcp__server__tool */
  async callTool(qualifiedName, args) {
    const rest = qualifiedName.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep === -1) throw new Error("非法 MCP 工具名: " + qualifiedName);
    const server = rest.slice(0, sep);
    const localName = rest.slice(sep + 2);
    const client = this.clients.get(server);
    if (!client) throw new Error("未知 MCP 服务器: " + server);
    const res = await client.callTool(localName, args);
    return res;
  }

  _emitStatus() { if (this.onStatus) this.onStatus(); }

  /* 给前端的服务器状态清单 */
  statusList() {
    const list = [];
    const seen = new Set();
    for (const [server, client] of this.clients) {
      seen.add(server);
      list.push({
        name: server,
        enabled: client.def.enabled,
        status: client.status,
        error: client.error || "",
        tools: client.tools.map((t) => ({ name: t.name, description: t.description || "" })),
      });
    }
    for (const def of this._defs()) {
      const name = sanitizeName(def.name);
      if (!seen.has(name)) list.push({ name, enabled: !!def.enabled, status: def.enabled ? "pending" : "disabled", error: "", tools: [] });
    }
    return list;
  }
}

/* ---------- 模块级单例：boot 时由 index.js 初始化 ---------- */
let _manager = null;
function initMcpManager(cfg) { _manager = new McpManager(cfg); return _manager; }
function getMcpManager() { return _manager; }

module.exports = { McpManager, McpClient, initMcpManager, getMcpManager, sanitizeName };
