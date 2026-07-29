/* ============================================================
   pancode 服务端入口 v2.0
   Express 静态服务 + REST API + WebSocket 实时网关
   模块化：config / files / git / terminal / llm / agent 双轨
   ============================================================ */
"use strict";
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

require("./dotenv").loadDotEnv();   // 启动即加载本地 .env（LLM 密钥来源，已被 .gitignore 忽略）
const configMod = require("./config");
const { FileStore, langOf } = require("./files");
const { GitLayer } = require("./git");
const { TerminalLayer } = require("./terminal");
const { ping } = require("./llm");
const { LlmAgent } = require("./agent-llm");
const { DemoAgent } = require("./agent-demo");
const auth = require("./auth");
const VERSION = (() => { try { return require("../package.json").version; } catch (e) { return "2.3.0"; } })();

const cfg = configMod.load();

/* 本地访问令牌：REST/WS 鉴权用。绑定 127.0.0.1 后仅本机可达；可用 PANCODE_TOKEN 固定 */
const AUTH_TOKEN = process.env.PANCODE_TOKEN || crypto.randomBytes(18).toString("hex");

const clients = new Set();
function broadcast(ev) {
  const s = JSON.stringify(ev);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

/* ---------- 工作区挂载（核心：任意本地文件夹都可以成为工作区） ---------- */
let WS_DIR = null;
let files = null, git = null, term = null, engine = null;

function buildEngine() {
  const ctx = { emit: broadcast, files, git, term, cfg };
  engine = configMod.engineMode(cfg) === "llm" ? new LlmAgent(ctx) : new DemoAgent(ctx);
}

function mountWorkspace(dir) {
  const abs = path.resolve(dir);
  let st;
  try { st = fs.statSync(abs); } catch (e) { throw new Error("文件夹不存在: " + abs); }
  if (!st.isDirectory()) throw new Error("不是文件夹: " + abs);
  try { fs.accessSync(abs, fs.constants.R_OK); } catch (e) { throw new Error("没有读取权限: " + abs); }

  if (files) files.stopWatch();
  WS_DIR = abs;
  files = new FileStore(WS_DIR);
  git = new GitLayer(WS_DIR, files);
  term = new TerminalLayer(WS_DIR, broadcast);
  buildEngine();
  files.startWatch(() => {
    broadcast({ type: "fs.sync", files: snapshotFiles() });
  });
  console.log("workspace 已挂载: " + WS_DIR);
}

/* 启动时挂载：绝对路径直接用，相对路径相对项目根（兼容旧配置 "workspace"） */
mountWorkspace(path.isAbsolute(cfg.workspace) ? cfg.workspace : path.resolve(configMod.ROOT, cfg.workspace));

/* ---------- 快照/状态 ---------- */
function snapshotFiles() {
  const out = {};
  for (const rel of files.list()) {
    // 二进制文件（Word/图片/压缩包等）：出现在文件树，但不读内容（按文本读必乱码）
    if (files.isBinary(rel)) {
      let size = 0;
      try { size = fs.statSync(files.safePath(rel)).size; } catch (e) {}
      out[rel] = { content: "", original: "", isNew: false, lang: "binary", binary: true, size };
      continue;
    }
    let content;
    try { content = files.read(rel); } catch (e) { continue; }
    const base = git.baseline(rel);
    out[rel] = {
      content,
      original: base === null ? "" : base,
      isNew: base === null,
      lang: langOf(rel),
    };
  }
  return out;
}

function helloPayload() {
  return {
    type: "hello",
    files: snapshotFiles(),
    running: engine.running,
    round: engine.round,
    engine: configMod.publicInfo(cfg),
    agent: configMod.agentSettings(cfg),
    git: git.info(),
    project: path.basename(WS_DIR),
    workspace: WS_DIR,
    truncated: !!files.truncated,
  };
}

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

/* ---------- 本地鉴权 ---------- */
const NO_AUTH = new Set(["/api/health", "/api/bootstrap", "/api/state", "/api/version", "/api/raw", "/api/preview/docx", "/api/fs/browse", "/api/models", "/api/auth/register", "/api/auth/login", "/api/auth/status", "/api/skills/all", "/api/skills/market", "/api/plans"]);
function authed(req) {
  const h = req.headers["authorization"] || "";
  const q = (req.query && req.query.token) || "";
  return (h.startsWith("Bearer ") && h.slice(7) === AUTH_TOKEN) || q === AUTH_TOKEN;
}
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();                       // 静态资源不鉴权
  if (NO_AUTH.has(req.path)) return next();                               // 白名单（只读/预览）
  if (req.method === "GET" && (req.path === "/api/workspace" || req.path === "/api/settings")) return next();
  if (!authed(req)) return res.status(401).json({ ok: false, error: "未授权：缺少有效令牌" });
  next();
});

app.get("/api/state", (req, res) => res.json({ version: VERSION, files: snapshotFiles(), git: git.info(), engine: configMod.publicInfo(cfg) }));
app.get("/api/health", (req, res) => res.json({ ok: true, name: "pancode", version: VERSION, workspace: WS_DIR, engine: configMod.publicInfo(cfg) }));
app.get("/api/version", (req, res) => res.json({
  ok: true, name: "pancode", version: VERSION,
  features: ["repo_map", "search_symbol", "chat_history", "resizable_preview", "permissions", "attachments", "persona", "rules", "auto_memory"],
}));

/* 仅本机可领取访问令牌（绑定 127.0.0.1 后局域网不可达） */
app.get("/api/bootstrap", (req, res) => {
  const ip = req.socket.remoteAddress || "";
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip)) return res.status(403).json({ ok: false, error: "仅本机可领取令牌" });
  res.json({ token: AUTH_TOKEN });
});

/* ---------- 用户认证 API ---------- */
app.get("/api/auth/status", (req, res) => {
  const userToken = req.headers["x-user-token"] || req.query.userToken;
  const user = auth.verify(userToken);
  res.json({ ok: true, loggedIn: !!user, username: user ? user.username : null, hasUsers: auth.hasUsers() });
});
app.post("/api/auth/register", (req, res) => {
  const { username, password } = req.body || {};
  const r = auth.register(String(username || "").trim(), String(password || ""));
  res.json(r);
});
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const r = auth.login(String(username || "").trim(), String(password || ""));
  res.json(r);
});
app.post("/api/auth/logout", (req, res) => {
  const userToken = req.headers["x-user-token"];
  auth.logout(userToken);
  res.json({ ok: true });
});

/* ---------- Skills 生态 API ---------- */
app.get("/api/skills/market", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.json({ ok: true, skills: [], builtin: [] });
    const skills = engine.skills.list({ limit: 50, category: req.query.category, search: req.query.q });
    res.json({ ok: true, skills, stats: engine.skills.stats, builtin: engine.skills.builtinWorkflows });
  } catch (e) { res.json({ ok: true, skills: [], builtin: [] }); }
});
app.get("/api/skills/all", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.json({ ok: true, skills: [], stats: { total: 0, market: 0, local: 0, builtin: 0 }, builtin: [], categories: {} });
    const skills = engine.skills.list({ limit: 100 });
    res.json({ ok: true, skills, stats: engine.skills.stats, builtin: engine.skills.builtinWorkflows, categories: engine.skills.categories });
  } catch (e) { res.json({ ok: true, skills: [], builtin: [], categories: {} }); }
});
app.post("/api/skills/market", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const skill = engine.skills.add(req.body || {}, "manual");
    if (!skill) return res.status(400).json({ ok: false, error: "名称不能为空" });
    if (skill._duplicate) return res.status(409).json({ ok: false, error: "同名 Skill 已存在: " + skill.name });
    res.json({ ok: true, skill });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put("/api/skills/market/:id", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const skill = engine.skills.update(req.params.id, req.body || {});
    if (!skill) return res.status(404).json({ ok: false, error: "Skill 不存在" });
    res.json({ ok: true, skill });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete("/api/skills/market/:id", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const ok = engine.skills.remove(req.params.id);
    res.json({ ok });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/skills/market/:id/use", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.json({ ok: true });
    engine.skills.recordUse(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/skills/market/:id/rate", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const skill = engine.skills.rate(req.params.id, Number(req.body.rating) || 0);
    if (!skill) return res.status(404).json({ ok: false, error: "Skill 不存在" });
    res.json({ ok: true, skill });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get("/api/skills/search/:query", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.json({ ok: true, skills: [] });
    const matched = engine.skills.match(req.params.query, 10);
    res.json({ ok: true, skills: matched });
  } catch (e) { res.json({ ok: true, skills: [] }); }
});

/* ---------- 任务计划 API ---------- */
app.get("/api/plans", (req, res) => {
  try {
    if (!engine || !engine.plan) return res.json({ ok: true, active: null, recent: [] });
    const active = engine.plan.getActive();
    const recent = engine.plan.recent(5);
    res.json({ ok: true, active, recent });
  } catch (e) { res.json({ ok: true, active: null, recent: [] }); }
});
app.post("/api/plans", (req, res) => {
  try {
    if (!engine || !engine.plan) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const plan = engine.plan.create(req.body.title, req.body.tasks);
    broadcast({ type: "plan.created", plan });
    res.json({ ok: true, plan });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/plans/:id/complete", (req, res) => {
  try {
    if (!engine || !engine.plan) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const plan = engine.plan.complete(req.params.id);
    if (!plan) return res.status(404).json({ ok: false, error: "计划不存在" });
    broadcast({ type: "plan.updated", plan });
    res.json({ ok: true, plan });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- 工作区管理：打开任意本地文件夹 ---------- */
app.get("/api/workspace", (req, res) => {
  res.json({ current: WS_DIR, recent: (cfg.recentWorkspaces || []).filter((p) => fs.existsSync(p)) });
});

app.post("/api/workspace", (req, res) => {
  try {
    const dir = String((req.body || {}).dir || "").trim();
    if (!dir) return res.status(400).json({ ok: false, error: "路径不能为空" });
    if (engine.running) return res.status(409).json({ ok: false, error: "AI 任务运行中，请先等待完成" });
    if (term.busy) term.kill();
    mountWorkspace(dir);
    configMod.saveWorkspace(cfg, WS_DIR);
    broadcast(helloPayload());   // 所有已连接窗口立即切换到新工作区
    res.json({ ok: true, workspace: WS_DIR, project: path.basename(WS_DIR) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- 二进制文件预览（对齐 VS Code 图片预览 + Office Viewer 扩展体验） ---------- */
const IMG_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", webp: "image/webp", ico: "image/x-icon", svg: "image/svg+xml",
};
const PREVIEW_MAX = 20 * 1024 * 1024; // 预览上限 20MB

function extOf(p) { return String(p).split(".").pop().toLowerCase(); }

/* 原始文件流：图片 <img> / PDF <iframe> 直接引用 */
app.get("/api/raw", (req, res) => {
  try {
    const rel = String(req.query.path || "");
    const abs = files.safePath(rel);
    const st = fs.statSync(abs);
    if (st.size > PREVIEW_MAX) return res.status(413).send("文件过大");
    const ext = extOf(rel);
    const mime = IMG_MIME[ext] || (ext === "pdf" ? "application/pdf" : "application/octet-stream");
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(abs).pipe(res);
  } catch (e) { res.status(404).send("文件不存在: " + e.message); }
});

/* docx → HTML 预览（mammoth，与 VS Code Office Viewer 同类方案） */
app.get("/api/preview/docx", async (req, res) => {
  try {
    const rel = String(req.query.path || "");
    const abs = files.safePath(rel);
    if (fs.statSync(abs).size > PREVIEW_MAX) return res.status(413).json({ ok: false, error: "文件过大，无法预览" });
    let mammoth;
    try { mammoth = require("mammoth"); }
    catch (e) { return res.status(501).json({ ok: false, error: "预览组件未安装（npm install mammoth）" }); }
    const result = await mammoth.convertToHtml({ path: abs }, { convertImage: mammoth.images.imgElement((img) =>
      img.read("base64").then((b64) => ({ src: "data:" + img.contentType + ";base64," + b64 })))
    });
    res.json({ ok: true, html: result.value, warnings: (result.messages || []).length });
  } catch (e) { res.status(400).json({ ok: false, error: "无法解析该文档: " + e.message }); }
});

/* 文件夹浏览器：给前端"打开文件夹"选择器用（只列目录，不读文件） */
app.get("/api/fs/browse", (req, res) => {
  try {
    const dir = String(req.query.dir || "").trim();
    if (!dir) {
      // 根级：Windows 列盘符，其他系统列 /
      if (process.platform === "win32") {
        const drives = [];
        for (let i = 65; i <= 90; i++) {
          const d = String.fromCharCode(i) + ":\\";
          try { fs.statSync(d); drives.push({ name: d, path: d }); } catch (e) {}
        }
        return res.json({ dir: "", parent: null, dirs: drives, home: require("os").homedir() });
      }
      return res.json({ dir: "/", parent: null, dirs: listSubdirs("/"), home: require("os").homedir() });
    }
    const abs = path.resolve(dir);
    const parent = path.dirname(abs);
    res.json({
      dir: abs,
      parent: parent === abs ? "" : parent,   // 盘符根再往上 → 回到盘符列表
      dirs: listSubdirs(abs),
      home: require("os").homedir(),
    });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

function listSubdirs(abs) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(abs); } catch (e) { return out; }
  for (const name of names) {
    if (name.startsWith("$") || name === "System Volume Information") continue;
    const full = path.join(abs, name);
    try { if (fs.statSync(full).isDirectory()) out.push({ name, path: full, hidden: name.startsWith(".") }); } catch (e) {}
    if (out.length >= 400) break;
  }
  out.sort((a, b) => (a.hidden - b.hidden) || a.name.localeCompare(b.name));
  return out;
}

/* 代理拉取模型列表：服务端请求外部 API，避免前端 CORS 被拦截 */
app.get("/api/models", async (req, res) => {
  try {
    const baseURL = String(req.query.baseURL || cfg.llm.baseURL || "").replace(/\/+$/, "");
    const apiKey = String(req.query.apiKey || cfg.llm.apiKey || "");
    if (!baseURL) return res.status(400).json({ ok: false, error: "Base URL 不能为空" });
    const url = baseURL.replace(/\/+$/, "") + "/models";
    const headers = {};
    if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/settings", (req, res) => res.json(configMod.publicInfo(cfg)));
app.post("/api/settings", (req, res) => {
  try {
    configMod.saveLlm(cfg, req.body || {});
    buildEngine();
    const info = configMod.publicInfo(cfg);
    broadcast({ type: "engine.info", engine: info });
    res.json({ ok: true, engine: info });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/settings/test", async (req, res) => {
  const p = req.body || {};
  const testCfg = {
    baseURL: p.baseURL || cfg.llm.baseURL,
    apiKey: p.apiKey || cfg.llm.apiKey,
    model: p.model || cfg.llm.model,
    temperature: 0,
  };
  if (!testCfg.baseURL || !testCfg.apiKey) return res.json({ ok: false, error: "Base URL 与 API Key 不能为空" });
  try {
    const r = await ping(testCfg);
    res.json({ ok: true, sample: r.sample });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* Agent 框架设置（权限 / 人格 / 规则 / 上下文 / 记忆） */
app.get("/api/agent-settings", (req, res) => res.json(configMod.agentSettings(cfg)));
app.post("/api/agent-settings", (req, res) => {
  try {
    configMod.saveAgentSettings(cfg, req.body || {});
    broadcast({ type: "agent.settings", agent: configMod.agentSettings(cfg) });
    res.json({ ok: true, agent: configMod.agentSettings(cfg) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- Phase 2：长期记忆 API ---------- */
app.get("/api/memory", (req, res) => {
  try {
    const q = String(req.query.q || "");
    const type = req.query.type || null;
    const results = q ? engine.memory.search(q, { type, limit: 20 }) : engine.memory.list({ type, limit: 30 });
    res.json({ ok: true, entries: results, total: engine.memory.size });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/memory", (req, res) => {
  try {
    const { type, topic, content } = req.body || {};
    if (!content) return res.status(400).json({ ok: false, error: "内容不能为空" });
    const entry = engine.memory.add(type || "lesson", topic || "", content);
    res.json({ ok: true, entry });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete("/api/memory/:id", (req, res) => {
  try {
    const ok = engine.memory.remove(req.params.id);
    res.json({ ok });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- Phase 2：Skill 系统 API ---------- */
app.get("/api/skills", (req, res) => {
  try {
    const q = String(req.query.q || "");
    const results = q ? engine.skills.match(q, 10) : engine.skills.list({ limit: 30 });
    res.json({ ok: true, skills: results, total: engine.skills.size });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/skills", (req, res) => {
  try {
    const skill = engine.skills.add(req.body || {});
    if (!skill) return res.status(400).json({ ok: false, error: "Skill 名称不能为空" });
    res.json({ ok: true, skill });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put("/api/skills/:id", (req, res) => {
  try {
    const skill = engine.skills.update(req.params.id, req.body || {});
    if (!skill) return res.status(404).json({ ok: false, error: "Skill 不存在" });
    res.json({ ok: true, skill });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete("/api/skills/:id", (req, res) => {
  try {
    const ok = engine.skills.remove(req.params.id);
    res.json({ ok });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- Phase 2：进化报告 API ---------- */
app.get("/api/evolution", (req, res) => {
  try {
    const report = engine.evolution.getReport();
    res.json({ ok: true, report });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------- 会话沉淀：把有效决策 / 约定沉淀为「项目规则」或「项目记忆」 ---------- */
app.get("/api/sediment", (req, res) => {
  try {
    const memFile = configMod.memoryPath(cfg);
    let memory = "";
    try { memory = fs.readFileSync(memFile, "utf8"); } catch (e) {}
    const rd = configMod.rulesDir();
    let rules = [];
    try {
      if (fs.existsSync(rd)) {
        rules = fs.readdirSync(rd).filter((f) => /\.md$/i.test(f)).map((f) => {
          let c = ""; try { c = fs.readFileSync(path.join(rd, f), "utf8"); } catch (e) {}
          return { file: f, content: c.slice(0, 4000) };
        });
      }
    } catch (e) {}
    res.json({ ok: true, memory, rules });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/sediment", (req, res) => {
  try {
    const { target, title, content } = req.body || {};
    if (!content || !String(content).trim()) return res.status(400).json({ ok: false, error: "沉淀内容不能为空" });
    const stamp = new Date().toISOString().slice(0, 10);
    if (target === "rule") {
      const rd = configMod.rulesDir();
      fs.mkdirSync(rd, { recursive: true });
      const file = path.join(rd, "user-rules.md");
      const head = "## " + (title || "沉淀规则") + "（" + stamp + "）\n\n";
      const prev = fs.existsSync(file)
        ? fs.readFileSync(file, "utf8")
        : "# 用户沉淀的规则\n\n> 由「沉淀」入口写入，每次对话强制注入系统提示词。\n\n";
      fs.writeFileSync(file, prev + head + String(content).trim() + "\n\n", "utf8");
    } else {
      const memFile = configMod.memoryPath(cfg);
      fs.mkdirSync(path.dirname(memFile), { recursive: true });
      const prev = fs.existsSync(memFile) ? fs.readFileSync(memFile, "utf8") : "";
      const line = "- **" + (title || "沉淀") + "**（" + stamp + "）：" + String(content).trim() + "\n";
      fs.writeFileSync(memFile, (prev && !prev.endsWith("\n") ? prev + "\n" : prev) + line, "utf8");
    }
    res.json({ ok: true, target });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- WebSocket ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

/* 在 WebSocket 握手阶段即校验令牌：无 token 直接销毁 socket，握手无法完成 */
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://localhost");
  if (u.searchParams.get("token") !== AUTH_TOKEN) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

function safe(fn, ws) {
  try { return fn(); }
  catch (e) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "op.error", error: e.message })); }
}

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(helloPayload()));
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }

    switch (m.type) {
      case "chat":
        if (typeof m.text === "string" && m.text.trim()) {
          if (m.convId && typeof engine.switchConversation === "function") {
            engine.switchConversation(m.convId);
          }
          engine.handleChat(m.text.slice(0, 8000), { attachments: Array.isArray(m.attachments) ? m.attachments : [] });
        }
        break;

      case "term.exec":
        if (typeof m.cmd === "string" && m.cmd.trim() && !term.busy) {
          term.run(m.cmd.slice(0, 500)).then(() => {
            broadcast({ type: "fs.sync", files: snapshotFiles() });
            engine.pushChanges(false);
          });
        }
        break;
      case "term.kill":
        term.kill();
        break;

      /* ----- 文件操作协议（编辑器可写的核心） ----- */
      case "file.save":
        safe(() => {
          files.write(m.path, String(m.content));
          engine.fileChanged(m.path);
          engine.pushChanges(false);
          broadcast({ type: "file.saved", path: m.path });
        }, ws);
        break;
      case "file.create":
        safe(() => {
          files.create(m.path, m.content || "");
          engine.fileChanged(m.path);
          engine.pushChanges(false);
          broadcast({ type: "fs.sync", files: snapshotFiles() });
        }, ws);
        break;
      case "file.delete":
        safe(() => {
          files.remove(m.path);
          engine.pushChanges(false);
          broadcast({ type: "fs.sync", files: snapshotFiles() });
        }, ws);
        break;
      case "file.rename":
        safe(() => {
          files.rename(m.path, m.newPath);
          engine.pushChanges(false);
          broadcast({ type: "fs.sync", files: snapshotFiles(), renamed: { from: m.path, to: m.newPath } });
        }, ws);
        break;
      case "file.mkdir":
        safe(() => {
          files.mkdir(m.path);
          broadcast({ type: "fs.sync", files: snapshotFiles() });
        }, ws);
        break;

      case "search":
        safe(() => {
          const results = files.search(String(m.query || ""), 200);
          ws.send(JSON.stringify({ type: "search.result", query: m.query, results }));
        }, ws);
        break;

      case "reset":
        safe(() => {
          git.discardAll();
          engine.round = 0;
          if (engine.history) engine.history = [];
          broadcast({ type: "fs.sync", files: snapshotFiles() });
          engine.pushChanges(false);
          broadcast({ type: "term.line", text: "[pancode] 工作区已恢复到基线状态", cls: "tl-info" });
          broadcast({ type: "agent.reset" });
        }, ws);
        break;

      /* 新建对话：仅清空 AI 对话上下文，不丢弃文件改动 */
      case "newchat":
        safe(() => {
          if (typeof engine.switchConversation === "function" && m.convId) {
            engine.switchConversation(m.convId);
          } else {
            engine.round = 0;
            if (engine.history) engine.history = [];
          }
          broadcast({ type: "agent.reset" });
          broadcast({ type: "term.line", text: "[pancode] 已开始新对话，AI 上下文已清空（文件改动保留）", cls: "tl-info" });
        }, ws);
        break;

      /* 中断当前 Agent 运行 */
      case "abort":
        safe(() => {
          if (typeof engine.abort === "function") {
            engine.abort();
            broadcast({ type: "term.line", text: "[pancode] Agent 已中断", cls: "tl-warn" });
            broadcast({ type: "agent.state", running: false, label: "AI 空闲" });
            broadcast({ type: "agent.done", round: engine.round });
          }
        }, ws);
        break;

      /* ----- 人工确认：AI 工具的写/删/执行需用户批准 ----- */
      case "tool.approve":
        if (typeof engine.resolveApproval === "function" && m.id) engine.resolveApproval(m.id, true);
        break;
      case "tool.reject":
        if (typeof engine.resolveApproval === "function" && m.id) engine.resolveApproval(m.id, false);
        break;
    }
  });
});

server.listen(cfg.port, "127.0.0.1", () => {
  const info = configMod.publicInfo(cfg);
  console.log("pancode v" + VERSION + " 已启动: http://localhost:" + cfg.port);
  console.log("workspace: " + WS_DIR);
  console.log("Git: " + (git.info().git ? "已启用（基线 = HEAD）" : "未启用（基线 = 启动快照）"));
  console.log("Agent 引擎: " + (info.mode === "llm" ? "真实 LLM（" + info.model + "）" : "内置演示引擎（配置 API Key 后自动切换真实 LLM）"));
});

/* 优雅关闭：关闭 WS 连接 → 停止文件监听 → 关闭 HTTP，避免强杀导致端口 / 文件锁残留 */
function shutdown(sig) {
  console.log("\n[pancode] 收到 " + sig + "，正在优雅关闭…");
  try { for (const c of wss.clients) { try { c.close(); } catch (e) {} } } catch (e) {}
  try { if (files) files.stopWatch(); } catch (e) {}
  try { server.close(() => process.exit(0)); } catch (e) { process.exit(0); }
  setTimeout(() => process.exit(0), 3000).unref();   // 兜底：3s 内未退出则强制退出
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
