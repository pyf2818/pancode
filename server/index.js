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
const { SoulStore } = require("./soul-store");
const { ProgressionStore } = require("./progression-store");
const { computeProgression } = require("./progression");
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
let files = null, git = null, term = null, engine = null, soulStore = null, progressionStore = null;

function buildEngine() {
  const ctx = { emit: broadcast, files, git, term, cfg };
  engine = configMod.engineMode(cfg) === "llm" ? new LlmAgent(ctx) : new DemoAgent(ctx);
  // 统一灵魂实例：复用引擎内部的 soul（指向同文件），避免双实例内存不一致
  soulStore = engine && engine.soul ? engine.soul : new SoulStore(configMod.soulPath(cfg));
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
  term = new TerminalLayer(WS_DIR, broadcast, path.join(__dirname, "..", ".pancode", "audit"));
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

/* A8：CORS 收紧——本地优先工具只允许同源或本机回环访问，拒绝跨站请求（防 CSRF 式滥用） */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();                               // 非浏览器（curl/同源）放行
  let host;
  try { host = new URL(origin).host; } catch (e) { return res.status(403).json({ ok: false, error: "非法 Origin" }); }
  const loopback = /^(127\.0\.0\.1|localhost|\[::1\])/.test(host);
  if (!loopback) return res.status(403).json({ ok: false, error: "跨站请求被拒绝" });
  res.setHeader("Access-Control-Allow-Origin", origin);     // 本机 Origin 反射
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-user-token");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- 本地鉴权 ---------- */
/* A2：收紧白名单——仅保留本机可匿名访问的引导类端点；业务/敏感端点全部要求登录后的 userToken */
const NO_AUTH = new Set([
  "/api/health",        // 健康探测
  "/api/bootstrap",     // 本机领取访问令牌（绑定 127.0.0.1）
  "/api/version",       // 版本信息
  "/api/auth/register", // 注册（首次建账号）
  "/api/auth/login",    // 登录
  "/api/auth/status",   // 查询登录态（前端启动判定）
  "/api/preview/docx",  // 仅预览渲染辅助，不泄露源码正文
]);
/* A1：用户会话闸门——仅校验登录后下发的 userToken（auth.verify）；AUTH_TOKEN 仅用于本机 bootstrap 与 WS 环回 */
function userAuthed(req) {
  const raw = (req.headers && (req.headers["x-user-token"] || req.headers["authorization"])) || (req.query && req.query.userToken) || "";
  const tok = raw.startsWith("Bearer ") ? raw.slice(7) : raw;
  return !!auth.verify(tok);
}
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();                       // 静态资源不鉴权
  if (NO_AUTH.has(req.path)) return next();                               // 白名单（引导类）
  if (!userAuthed(req)) return res.status(401).json({ ok: false, error: "未授权：请先登录", code: "NO_AUTH" });
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
    const cid = req.query.convId || "default";
    const active = engine.plan.getActive(cid);
    const recent = engine.plan.recent(cid, 5);
    res.json({ ok: true, active, recent });
  } catch (e) { res.json({ ok: true, active: null, recent: [] }); }
});
app.post("/api/plans", (req, res) => {
  try {
    if (!engine || !engine.plan) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const plan = engine.plan.create(req.body.convId || (engine._currentConv) || "default", req.body.title, req.body.tasks);
    broadcast({ type: "plan.created", plan, convId: plan.convId });
    res.json({ ok: true, plan });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/plans/:id/complete", (req, res) => {
  try {
    if (!engine || !engine.plan) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const plan = engine.plan.complete(req.params.id);
    if (!plan) return res.status(404).json({ ok: false, error: "计划不存在" });
    broadcast({ type: "plan.updated", plan, convId: plan.convId });
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
    if (!abs.startsWith(WS_DIR)) return res.status(403).send("拒绝访问该路径");
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

/* ---------- 进化树：分层树 + 时间线（聚合记忆/经验/Skill/灵魂） ---------- */
app.get("/api/evolution/tree", (req, res) => {
  try {
    const ss = soulStore || (soulStore = new SoulStore(configMod.soulPath(cfg)));
    const soul = ss.get();

    // 1) 记忆 / 经验 / 教训（来自 MemoryStore 六类）
    const memEntries = (engine && engine.memory) ? engine.memory.list({ limit: 200 }) : [];
    const memGroups = {
      memory:   { label: "记忆", icon: null, items: memEntries.filter((e) => e.type === "preference" || e.type === "decision") },
      experience:{ label: "经验", icon: null, items: memEntries.filter((e) => e.type === "lesson" || e.type === "pattern") },
      lesson:   { label: "教训", icon: null, items: memEntries.filter((e) => e.type === "error") },
    };

    // 2) Skills（内置工作流 / 用户创建 / 工作区沉淀）
    const skills = (engine && engine.skills) ? engine.skills.list({ limit: 200 }) : [];
    const builtin = (engine && engine.skills) ? engine.skills.builtinWorkflows : [];
    const skillNodes = [
      { label: "内置工作流", icon: null, items: (builtin || []).map((s) => ({ id: "bk-" + s.name, name: s.name, desc: s.description, ts: 0, source: "builtin" })) },
      { label: "用户创建", icon: null, items: skills.filter((s) => s.source === "manual" || s.source === "import").map((s) => ({ id: s.id, name: s.name, desc: s.description, ts: s.ts || 0, source: s.source })) },
      { label: "工作区沉淀", icon: null, items: skills.filter((s) => s.source === "auto").map((s) => ({ id: s.id, name: s.name, desc: s.description, ts: s.ts || 0, source: s.source })) },
    ];

    // 3) 灵魂（人格 + 待确认提案）
    const pending = (soul.proposals || []).filter((p) => p.status === "pending");
    const soulNode = {
      label: "灵魂 Soul", icon: null,
      name: soul.name, vibe: soul.vibe,
      values: soul.values, boundaries: soul.boundaries, principles: soul.principles,
      proposals: soul.proposals || [],
      pendingCount: pending.length,
    };

    // 4) 时间线：把所有带 ts 的节点打平按时间排序
    const timeline = [];
    const push = (kind, icon, title, sub, ts, id) => { if (ts) timeline.push({ kind, icon, title, sub, ts, id }); };
    memEntries.forEach((e) => push("memory", null, (e.topic || e.type) + "：" + e.content.slice(0, 80), e.type, e.ts, e.id));
    (builtin || []).forEach((s) => push("skill", null, "内置工作流：" + s.name, "builtin", 0, "bk-" + s.name));
    skills.forEach((s) => push("skill", null, "Skill：" + s.name, s.source, s.ts || 0, s.id));
    (soul.proposals || []).forEach((p) => push("soul", null, "灵魂微调提案：" + p.content.slice(0, 60), p.status, p.ts, p.id));
    timeline.sort((a, b) => b.ts - a.ts);

    // 进度系统：阶段 / 经验值 / 属性 / 成就 / 解锁规则
    const ps = progressionStore || (progressionStore = new ProgressionStore(configMod.progressionPath(cfg)));
    const prog = computeProgression({ soul, memEntries, skills: skills, builtin: builtin || [], path: ps.get().path });

    res.json({
      ok: true,
      tree: { soul: soulNode, memory: memGroups, skills: skillNodes },
      timeline,
      progression: prog,
      counts: {
        memory: memGroups.memory.items.length,
        experience: memGroups.experience.items.length,
        lesson: memGroups.lesson.items.length,
        skills: skills.length + (builtin || []).length,
        proposals: (soul.proposals || []).length,
        pending: pending.length,
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------- 灵魂(Soul)读写 + 微调提案确认 ---------- */
app.get("/api/soul", (req, res) => {
  try {
    const ss = soulStore || (soulStore = new SoulStore(configMod.soulPath(cfg)));
    res.json({ ok: true, soul: ss.get() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.put("/api/soul", (req, res) => {
  try {
    const ss = soulStore || (soulStore = new SoulStore(configMod.soulPath(cfg)));
    const updated = ss.update(req.body || {});
    res.json({ ok: true, soul: updated });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/soul/proposal", (req, res) => {
  try {
    const ss = soulStore || (soulStore = new SoulStore(configMod.soulPath(cfg)));
    const p = ss.addProposal(req.body || {});
    if (!p) return res.status(400).json({ ok: false, error: "提案内容不能为空" });
    res.json({ ok: true, proposal: p });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put("/api/soul/proposal/:id", (req, res) => {
  try {
    const ss = soulStore || (soulStore = new SoulStore(configMod.soulPath(cfg)));
    const accept = req.query.accept !== "0" && req.query.accept !== "false";
    const p = ss.resolveProposal(req.params.id, accept);
    if (!p) return res.status(404).json({ ok: false, error: "提案不存在" });
    res.json({ ok: true, proposal: p });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- 进度：设定进化路线（持久化） ---------- */
app.post("/api/progression", (req, res) => {
  try {
    const ps = progressionStore || (progressionStore = new ProgressionStore(configMod.progressionPath(cfg)));
    const p = ps.setPath((req.body && req.body.path) || null);
    res.json({ ok: true, path: p.path });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
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

/* A1：业务 WS 仅接受登录后的 userToken（登录闸门）。AUTH_TOKEN 仅用于本机 bootstrap，不再用于 WS */
server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://localhost");
  const tok = u.searchParams.get("token") || "";
  if (!auth.verify(tok)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => { ws._userToken = tok; wss.emit("connection", ws, req); });
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
          // 清空当前会话记录的改动（工作区已回退基线）
          if (engine.convChanges) engine.convChanges[engine._currentConv] = [];
          if (typeof engine.saveConversations === "function") engine.saveConversations();
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
            engine.switchConversation(String(m.convId));
          }
          // 清空该会话记录的改动（新对话无历史改动）
          if (engine.convChanges) engine.convChanges[String(m.convId || engine._currentConv)] = [];
          // newchat 语义 = 该会话上下文清空（新建会话本就为空；重试场景同 ID 也需清空）
          engine.round = 0;
          if (engine.history) engine.history = [];
          if (typeof engine.saveConversations === "function") engine.saveConversations();
          broadcast({ type: "agent.reset" });
          broadcast({ type: "term.line", text: "[pancode] 已开始新对话，AI 上下文已清空（文件改动保留）", cls: "tl-info" });
        }, ws);
        break;

      /* C6：切换对话 — 把服务端 AI 上下文同步到前端选中的会话 */
      case "switchConv":
        safe(() => {
          if (typeof engine.switchConversation === "function" && m.convId) {
            engine.switchConversation(String(m.convId));
            const n = engine.history ? engine.history.length : 0;
            ws.send(JSON.stringify({ type: "conv.switched", convId: String(m.convId), messages: n }));
            // 同步切换该会话记录的改动清单，前端改动面板一并切换
            const cl = (engine.convChanges && engine.convChanges[String(m.convId)]) || [];
            ws.send(JSON.stringify({ type: "changes", list: cl, convId: String(m.convId) }));
          }
        }, ws);
        break;

      /* C6：删除对话 — 同步清理服务端上下文，避免残留占用 */
      case "dropConv":
        safe(() => {
          if (typeof engine.dropConversation === "function" && m.convId) {
            engine.dropConversation(String(m.convId));
          }
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

/* A7：清理上次异常退出遗留的原子写临时文件（pancode.config.json.<pid>.tmp），避免根目录残留 */
function cleanupTmpOrphans() {
  try {
    const dir = path.join(__dirname, "..");
    for (const f of fs.readdirSync(dir)) {
      if (/^pancode\.config\.json\.\d+\.tmp$/.test(f)) {
        try { fs.unlinkSync(path.join(dir, f)); console.log("[pancode] 清理残留临时文件:", f); } catch (e) {}
      }
    }
  } catch (e) {}
}
cleanupTmpOrphans();

server.listen(cfg.port, "127.0.0.1", () => {
  const info = configMod.publicInfo(cfg);
  console.log("pancode v" + VERSION + " 已启动: http://localhost:" + cfg.port);
  console.log("workspace: " + WS_DIR);
  console.log("Git: " + (git.info().git ? "已启用（基线 = HEAD）" : "未启用（基线 = 启动快照）"));
  console.log("Agent 引擎: " + (info.mode === "llm" ? "真实 LLM（" + info.model + "）" : "内置演示引擎（配置 API Key 后自动切换真实 LLM）"));
});

/* 优雅关闭：中止 Agent → 杀终端子进程 → 关 WS → 停 watch → 关 HTTP，避免孤儿进程 / 端口残留 */
function shutdown(sig) {
  console.log("\n[pancode] 收到 " + sig + "，正在优雅关闭…");
  try { if (engine && typeof engine.abort === "function") engine.abort(); } catch (e) {}   // 中止进行中的 Agent 任务
  try { if (engine && typeof engine.flushConversations === "function") engine.flushConversations(); } catch (e) {}  // C6：同步刷盘会话上下文
  try { if (term && typeof term.kill === "function") term.kill(); } catch (e) {}            // 杀掉终端子进程，避免孤儿
  try { for (const c of wss.clients) { try { c.close(); } catch (e) {} } } catch (e) {}
  try { if (files) files.stopWatch(); } catch (e) {}
  try { server.close(() => process.exit(0)); } catch (e) { process.exit(0); }
  setTimeout(() => process.exit(0), 3000).unref();   // 兜底：3s 内未退出则强制退出
}

/* A3：全局兜底——未捕获的 Promise 拒绝 / 异常不再直接杀死进程，记日志并广播给前端 */
function logFatal(where, err) {
  try {
    const msg = (err && err.stack) ? err.stack : String(err);
    console.error("[pancode] " + where + ": " + msg);
    broadcast({ type: "op.error", error: "服务内部异常（" + where + "），已自动恢复；如频繁出现请查看后台日志。" });
  } catch (e) {}
}
process.on("unhandledRejection", (reason) => logFatal("unhandledRejection", reason));
process.on("uncaughtException", (err) => logFatal("uncaughtException", err));

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
