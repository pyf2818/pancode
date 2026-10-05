/* ============================================================
   pancode 配置中心
   优先级：环境变量 > pancode.config.json > 默认值
   - LLM 配置可在运行时通过 UI 修改并持久化到配置文件
   - 无 API Key 时自动降级到演示引擎（产品可开箱即用）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const wsKey = require("./ws-key");
const { setEnvVar } = require("./dotenv");
const { saveJson } = require("./safe-write");

// 数据根：打包态(__dirname 落在只读 app.asar)必须指向可写目录，由桌面端 main.js 注入 PANCODE_DATA_DIR(=userData)
const ROOT = process.env.PANCODE_DATA_DIR || path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "pancode.config.json");

/* 探针护栏：带"我在跑测试"的标记（AGENT_FAST / CURSORWEB_ENGINE=demo，产品路径一个都不设，实测）
   却没换数据根 → 直接拒启。
   理由不是洁癖：这种组合会往真实的 .pancode 里写探针账号、按 TTL 删真实对话、落测试用的索引分片，
   而且全程一声不吭。宁可启动即失败，也不让"探针绿了、开发者的数据没了"这种事再发生一次。 */
if (!process.env.PANCODE_DATA_DIR && (process.env.AGENT_FAST === "1" || process.env.CURSORWEB_ENGINE === "demo")) {
  throw new Error(
    "探针护栏：这是探针启动（AGENT_FAST/CURSORWEB_ENGINE=demo）但没设 PANCODE_DATA_DIR——它会把账号、会话、索引写进真实数据根 " +
    ROOT + "。请 require('./scripts/_sandbox').create({ tag: \"…\" })，或显式指定一个临时 PANCODE_DATA_DIR。"
  );
}

const DEFAULTS = {
  port: 8766,
  workspace: "workspace",
  recentWorkspaces: [],   // 最近打开过的文件夹（绝对路径）
  llm: {
    baseURL: "",          // 例如 https://api.openai.com/v1 或任何 OpenAI 兼容网关
    apiKey: "",
    model: "gpt-4o-mini",
    temperature: 0.2,
    maxToolRounds: 100,   // 单次任务最多工具调用轮数
    contextWindow: 128000, // 模型真实上下文窗口（tokens）：上下文进度条分母 + 自动压缩依据，按所用模型调整
    // 输出预留（tokens）：窗口是 input+output 共享的，自动压缩只能让出输入侧，
    // 所以阈值要先从窗口里扣掉"本轮模型最多还要写多少"。不发给上游，纯本地预算量。
    // 留空 = 按窗口 10% 自动取。
    maxOutputTokens: 0,
  },
  // 多份模型配置（网关地址 + 模型名）。密钥不进这里，见 profileKeyVar。
  llmProfiles: [],
  // —— Phase 1：Agent 框架 ——
  permissions: {
    mode: "ask",          // ask=全部询问(默认) | semi=半自动(安全操作免确认) | auto=全自动(仅高危硬拦截)
    allow: [],            // 免确认规则（命令子串/正则，或文件 glob），semi/auto 模式生效
    deny: [],             // 强制拦截（命令子串/正则，或文件 glob），所有模式生效
    strictCommand: true,  // W14 沙箱开关：AI 命令启用 strict 黑名单（sudo/全局安装/系统目录写入等）。
                          // 关闭 = 降低防护，AI 可执行这些命令，请自行评估风险
  },
  // W14 hooks：工具执行前拦截规则（deny），覆盖包括 MCP 在内的全部工具
  hooks: {
    // pre: [{ tool: "write_file"（工具名，"*"=全部，省略=全部）, match: "/node_modules/i"（/正则/ 或包含子串，省略=仅按 tool）, action: "deny", reason: "给 AI 的拦截原因" }]
    pre: [],
  },
  planMode: false,        // 规划模式：开启后 Agent 仅可读/检索/规划，禁止任何写文件/执行命令，待用户批准再切回执行
  persona: {
    active: "default",    // default | fullstack | frontend | backend | custom
    systemPrompt: "",     // 自定义人格覆盖（非空时优先于预设）
  },
  rules: { enabled: true },        // 是否加载 .pancode/rules 作为强制约束
  context: { budgetTokens: 1000000, autoCompact: true }, // 上下文预算 1M tokens
  memory: { enabled: true },       // auto memory（会话中沉淀记忆）
  // —— 桌面端（Electron）窗口行为 ——
  desktop: {
    // 点标题栏红点 / 系统关闭时要做什么：
    //   ask = 每次问（默认，第一次用会问）| background = 直接挂到后台，任务继续跑 | quit = 直接退出
    // 只有主进程读它（设置界面负责写）；非桌面态（浏览器 / npm start）完全不涉及。
    closeAction: "ask",
    // 硬件加速：on = 交给 Chromium 自检（默认，真桌面 GPU 上动画/模糊才跟得上）；
    // off = 强制软件渲染，虚拟机 / 远程桌面等无 GPU 环境的兼容档（重启生效）。
    gpu: "on",
  },
  // —— 长任务时限（秒）——
  // 这些是"跑不完一次真实构建/测试"的直接来源，默认值按长任务设定，可在 设置 → Agent 行为 里调。
  timeouts: {
    commandSec: 600,    // run_command 前台等待上限；更长的任务应改用 start_process 后台 + read_process 轮询
    approvalSec: 1200,  // 审批/选项卡多久没人处理就自动放弃（默认 20 分钟；期间状态栏持续倒计时提醒）
    toolSec: 120,       // 读类工具的兜底超时；agent / orchestrate 等本身要跑很久的工具不受此约束
  },
  // —— 真实 LSP 桥接（按需 spawn 语言服务器，详见 server/lsp-bridge.js）——
  lsp: {
    enabled: true,
    servers: {},                   // 留空则用 lsp-bridge 内置默认（python 等）
  },
  // —— 轻量代码向量索引（可插拔 embedding；未配置则 BM25 词法兜底）——
  embedding: {
    endpoint: "",                  // OpenAI 兼容 /v1/embeddings，例如 https://api.openai.com/v1
    apiKey: "",
    model: "text-embedding-3-small",
    dim: 1536,
  },
  // —— MCP（Model Context Protocol）外部工具服务器 ——
  // 每个 server：{ name, command, args[], env{}, enabled, cwd? }
  // 仅本地优先开发工具使用；server 以用户当前权限运行，请仅添加可信来源。
  mcp: {
    servers: [],
  },
};

/* 读配置。⚠ 不能只读盘：`saveJson` 是排队异步落盘的（Windows 被杀软/句柄锁住时还要退避重试到 ~10s），
   而每个 saveX 都是"读盘 → 只改自己那一段 → 整份写回"。于是同一秒里连着存两个段时，
   第二次读到的是**还没落盘的旧内容**，会把第一次那段整段抹回去
   （实测：先存 permissions 再存 desktop，permissions 就没了）。
   解法：给"刚写出去、盘上还没追上"的内容做一层读回缓存，只在盘确实更旧时才用它——
   外部改了文件（mtime 变新）时仍然以盘为准。 */
const _recent = new Map();     // 绝对路径 -> { obj, at }
function readJsonSafe(p) {
  const key = path.resolve(p);
  const r = _recent.get(key);
  try {
    const st = fs.statSync(p);
    if (r && st.mtimeMs < r.at) return JSON.parse(JSON.stringify(r.obj));
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (r) { try { return JSON.parse(JSON.stringify(r.obj)); } catch (e2) { return null; } }
    return null;
  }
}

/* 皮实的配置写入（W7 补漏 · P1）：
   同步直写/tmprename 在杀软持续锁定下会全链失败（实测 EPERM 连发）→
   转发 safe-write 队列：按路径串行 + 异步指数退避重试 6 次（~10.9s），不阻塞事件循环、永不抛错。
   语义为 best-effort 持久化：进程内 cfg 对象仍是事实源（读盘仅在启动），调用点零改动。 */
function writeJsonSafe(p, obj) {
  try { _recent.set(path.resolve(p), { obj, at: Date.now() }); } catch (e) {}
  saveJson(p, obj);   // fire-and-forget：队列串行 + 退避重试，失败仅 safe-write 内部告警
  return true;
}

function deepMerge(base, extra) {
  const out = Object.assign({}, base);
  for (const k in extra) {
    if (extra[k] && typeof extra[k] === "object" && !Array.isArray(extra[k])) {
      out[k] = deepMerge(base[k] || {}, extra[k]);
    } else if (extra[k] !== undefined && extra[k] !== null) {
      out[k] = extra[k];
    }
  }
  return out;
}

function load() {
  let cfg = deepMerge(DEFAULTS, readJsonSafe(CONFIG_PATH) || {});
  // 环境变量最高优先级
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.CURSORWEB_WORKSPACE) cfg.workspace = process.env.CURSORWEB_WORKSPACE;
  if (process.env.OPENAI_BASE_URL) cfg.llm.baseURL = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_API_KEY) cfg.llm.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_MODEL) cfg.llm.model = process.env.OPENAI_MODEL;
  // W8：agentMode 为行为模式真源；兼容旧 planMode（planMode=true → agentMode=plan）
  cfg.agentMode = (cfg.agentMode === "agent" || cfg.agentMode === "plan" || cfg.agentMode === "ask") ? cfg.agentMode : (cfg.planMode ? "plan" : "agent");
  cfg.planMode = (cfg.agentMode === "plan");
  return cfg;
}

/* 把 UI 提交的 LLM 设置持久化。
   安全约定：apiKey 永不写入配置文件（明文入库 = 泄露风险），只存于运行时内存 + 本地 .env（已被 .gitignore 忽略）。
   baseURL / model 等非敏感项才写入 pancode.config.json。 */
/* 存下来的一律是「基地址」：最常见的误填是把补全接口的完整路径（…/v1/chat/completions）粘进来，
   拼请求时就成了 …/chat/completions/chat/completions，表现正是"配置填好了却拉不到模型、一问就报错"。 */
function normalizeBaseURL(v) {
  return String(v || "").trim().replace(/\/+$/, "").replace(/\/(chat\/completions|completions|responses|embeddings)$/i, "");
}
function saveLlm(cfg, patch) {
  const baseURL = typeof patch.baseURL === "string" ? normalizeBaseURL(patch.baseURL) : undefined;
  const apiKey = typeof patch.apiKey === "string" ? patch.apiKey.trim() : undefined;
  const model = typeof patch.model === "string" ? patch.model.trim() : undefined;
  if (baseURL !== undefined) cfg.llm.baseURL = baseURL;
  if (apiKey !== undefined) { cfg.llm.apiKey = apiKey; setEnvVar("OPENAI_API_KEY", apiKey); }
  if (model !== undefined) cfg.llm.model = model;
  if (patch.maxToolRounds !== undefined) {
    const n = Number(patch.maxToolRounds);
    if (Number.isInteger(n) && n >= 5 && n <= 500) cfg.llm.maxToolRounds = n;
  }
  if (patch.contextWindow !== undefined) {
    const w = Number(patch.contextWindow);
    if (Number.isFinite(w) && w >= 4096 && w <= 2000000) cfg.llm.contextWindow = Math.round(w);
  }
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.llm = { baseURL: cfg.llm.baseURL, model: cfg.llm.model, maxToolRounds: cfg.llm.maxToolRounds, contextWindow: cfg.llm.contextWindow };
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
}

/* ---------- 多份模型配置（profile） ----------
   与 apiKey 同一口径：非敏感项（网关地址 / 模型名 / 窗口 / 轮次）进 pancode.config.json，
   每份配置自己的密钥进本地 .env 的 PANCODE_LLM_KEY_<id>，绝不明文写进配置文件。 */
function profileKeyVar(id) {
  return "PANCODE_LLM_KEY_" + String(id || "").replace(/[^0-9a-zA-Z]/g, "").slice(0, 24).toUpperCase();
}
function profilePublic(p) {
  const key = process.env[profileKeyVar(p.id)] || "";
  return {
    id: p.id, name: p.name, baseURL: p.baseURL, model: p.model,
    contextWindow: p.contextWindow, maxToolRounds: p.maxToolRounds,
    hasKey: !!key, keyTail: key ? "…" + key.slice(-4) : "",
  };
}
function saveLlmProfiles(cfg, list) {
  const out = (Array.isArray(list) ? list : []).slice(0, 20).map((p) => ({
    id: String(p.id || "").slice(0, 32),
    name: String(p.name || "").trim().slice(0, 40),
    baseURL: String(p.baseURL || "").trim().slice(0, 300),
    model: String(p.model || "").trim().slice(0, 120),
    contextWindow: Number(p.contextWindow) > 0 ? Math.round(Number(p.contextWindow)) : undefined,
    maxToolRounds: Number(p.maxToolRounds) > 0 ? Math.round(Number(p.maxToolRounds)) : undefined,
  })).filter((p) => p.id && p.name && p.baseURL);
  cfg.llmProfiles = out;
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.llmProfiles = out;
  writeJsonSafe(CONFIG_PATH, onDisk);
  return out;
}
/* 把当前运行时参数存成一份新配置（或按 id 覆盖已有的一份）；apiKey 只在显式给了的时候写 .env */
function upsertLlmProfile(cfg, body) {
  const list = (cfg.llmProfiles || []).slice();
  const id = String(body.id || "").slice(0, 32) || "p" + Date.now().toString(36);
  const patch = {
    id,
    name: String(body.name || "").trim() || (cfg.llm.baseURL ? cfg.llm.baseURL.replace(/^https?:\/\//, "").slice(0, 28) : "未命名"),
    baseURL: String(body.baseURL != null ? body.baseURL : cfg.llm.baseURL).trim(),
    model: String(body.model != null ? body.model : cfg.llm.model).trim(),
    contextWindow: Number(body.contextWindow || cfg.llm.contextWindow) || undefined,
    maxToolRounds: Number(body.maxToolRounds || cfg.llm.maxToolRounds) || undefined,
  };
  const i = list.findIndex((p) => p.id === id);
  if (i >= 0) list[i] = patch; else list.push(patch);
  saveLlmProfiles(cfg, list);
  // 没显式给 Key 时，把当前运行时那份 Key 一起归到这条配置名下：切回来才不用重新粘贴
  const key = (typeof body.apiKey === "string" && body.apiKey.trim()) ? body.apiKey.trim() : (cfg.llm.apiKey || "");
  if (key) setEnvVar(profileKeyVar(id), key);
  return profilePublic(patch);
}
function applyLlmProfile(cfg, id) {
  const p = (cfg.llmProfiles || []).find((x) => x.id === String(id));
  if (!p) return null;
  saveLlm(cfg, { baseURL: p.baseURL, model: p.model, contextWindow: p.contextWindow, maxToolRounds: p.maxToolRounds });
  const key = process.env[profileKeyVar(p.id)] || "";
  if (key) { cfg.llm.apiKey = key; setEnvVar("OPENAI_API_KEY", key); }
  return { ok: true, profile: profilePublic(p), hasKey: !!key };
}
function removeLlmProfile(cfg, id) {
  const list = (cfg.llmProfiles || []).filter((p) => p.id !== String(id));
  saveLlmProfiles(cfg, list);
  setEnvVar(profileKeyVar(id), "");
  return list;
}

/* 把「打开的文件夹」持久化为新的默认工作区，并记入最近列表 */
function saveWorkspace(cfg, absDir) {
  cfg.workspace = absDir;
  const recent = (cfg.recentWorkspaces || []).filter((p) => p !== absDir);
  recent.unshift(absDir);
  cfg.recentWorkspaces = recent.slice(0, 8);
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.workspace = absDir;
  onDisk.recentWorkspaces = cfg.recentWorkspaces;
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
}

/* 持久化 Agent 框架设置（权限/人格/规则/上下文/记忆）。
   直接写入 pancode.config.json（均为非敏感配置）。 */
function saveAgentSettings(cfg, patch) {
  const p = patch || {};
  if (p.permissions) {
    if (typeof p.permissions.mode === "string") cfg.permissions.mode = p.permissions.mode;
    if (Array.isArray(p.permissions.allow)) cfg.permissions.allow = p.permissions.allow.filter(Boolean).map(String);
    if (Array.isArray(p.permissions.deny)) cfg.permissions.deny = p.permissions.deny.filter(Boolean).map(String);
    if (typeof p.permissions.strictCommand === "boolean") cfg.permissions.strictCommand = p.permissions.strictCommand;
  }
  if (p.hooks && typeof p.hooks === "object" && Array.isArray(p.hooks.pre)) {
    cfg.hooks.pre = p.hooks.pre
      .filter((h) => h && typeof h === "object" && h.action === "deny")
      .map((h) => ({
        tool: typeof h.tool === "string" ? h.tool.slice(0, 64) : "",
        match: typeof h.match === "string" ? h.match.slice(0, 300) : "",
        action: "deny",
        reason: typeof h.reason === "string" ? h.reason.slice(0, 200) : "",
      }));
  }
  if (p.persona) {
    if (typeof p.persona.active === "string") cfg.persona.active = p.persona.active;
    if (typeof p.persona.systemPrompt === "string") cfg.persona.systemPrompt = p.persona.systemPrompt;
  }
  if (p.rules && typeof p.rules.enabled === "boolean") cfg.rules.enabled = p.rules.enabled;
  if (p.context) {
    if (Number.isFinite(p.context.budgetTokens)) cfg.context.budgetTokens = Math.max(8000, p.context.budgetTokens | 0);
    if (typeof p.context.autoCompact === "boolean") cfg.context.autoCompact = p.context.autoCompact;
  }
  if (p.memory && typeof p.memory.enabled === "boolean") cfg.memory.enabled = p.memory.enabled;
  if (typeof p.planMode === "boolean") cfg.planMode = p.planMode;
  if (p.agentMode === "agent" || p.agentMode === "plan" || p.agentMode === "ask") { cfg.agentMode = p.agentMode; cfg.planMode = (p.agentMode === "plan"); }
  if (p.lsp && typeof p.lsp.enabled === "boolean") cfg.lsp.enabled = p.lsp.enabled;
  if (p.timeouts) {
    const t = p.timeouts;
    const cl = (v, lo, hi, fb) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : fb);
    if (t.commandSec !== undefined) cfg.timeouts.commandSec = cl(t.commandSec, 15, 7200, cfg.timeouts.commandSec);
    if (t.approvalSec !== undefined) cfg.timeouts.approvalSec = cl(t.approvalSec, 30, 7200, cfg.timeouts.approvalSec);
    if (t.toolSec !== undefined) cfg.timeouts.toolSec = cl(t.toolSec, 15, 3600, cfg.timeouts.toolSec);
  }

  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.permissions = cfg.permissions;
  onDisk.hooks = cfg.hooks;
  onDisk.planMode = cfg.planMode;
  onDisk.agentMode = cfg.agentMode;
  onDisk.persona = cfg.persona;
  onDisk.rules = cfg.rules;
  onDisk.context = cfg.context;
  onDisk.memory = cfg.memory;
  onDisk.lsp = cfg.lsp;
  onDisk.timeouts = cfg.timeouts;
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
}

/* 持久化 Embedding 配置（代码向量索引用） */
/* 桌面端窗口偏好。写它的有两个入口，都必须走这里，别开第二条落盘路径：
   ① 设置界面（/api/config 的 section=desktop）；② 关窗对话框里勾了"记住我的选择"的主进程。
   只认三个值，其它一律不改（防止把配置写成不可识别的状态）。 */
function saveDesktop(cfg, patch) {
  const v = String((patch && patch.closeAction) || "");
  const ALLOWED = ["ask", "background", "quit"];
  if (ALLOWED.indexOf(v) < 0) return cfg.desktop;
  cfg.desktop = Object.assign({}, cfg.desktop, { closeAction: v });
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.desktop = cfg.desktop;
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg.desktop;
}

function saveEmbedding(cfg, patch) {
  const p = patch || {};
  if (typeof p.endpoint === "string") cfg.embedding.endpoint = p.endpoint.trim();
  if (typeof p.apiKey === "string") { cfg.embedding.apiKey = p.apiKey.trim(); if (p.apiKey.trim()) setEnvVar("PANCODE_EMBEDDING_KEY", p.apiKey.trim()); }
  if (typeof p.model === "string") cfg.embedding.model = p.model.trim();
  if (Number.isFinite(p.dim)) cfg.embedding.dim = Math.max(1, p.dim | 0);
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.embedding = { endpoint: cfg.embedding.endpoint, model: cfg.embedding.model, dim: cfg.embedding.dim };
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
}

/* 给前端的 Embedding 配置（脱敏） */
function embeddingInfo(cfg) {
  return {
    endpoint: cfg.embedding.endpoint || "",
    model: cfg.embedding.model || "text-embedding-3-small",
    dim: cfg.embedding.dim || 1536,
    hasKey: !!cfg.embedding.apiKey,
    keyTail: cfg.embedding.apiKey ? "…" + cfg.embedding.apiKey.slice(-4) : "",
  };
}

/* 给前端的 Agent 设置（脱敏，可编辑字段原样返回） */
function agentSettings(cfg) {
  return {
    permissions: cfg.permissions,
    hooks: cfg.hooks,
    planMode: cfg.planMode,
    agentMode: cfg.agentMode,
    persona: cfg.persona,
    rules: cfg.rules,
    context: cfg.context,
    memory: cfg.memory,
    lsp: cfg.lsp,
    timeouts: cfg.timeouts,
  };
}

/* 持久化 MCP 服务器配置（写入 pancode.config.json 的 mcp.servers）。
   patch.servers 为完整数组（增删改由前端提交整表），我们做基本清洗：
   仅保留含 name + command 的条目，sanitize name，enabled 默认 true。 */
function saveMcpServers(cfg, patch) {
  const incoming = (patch && Array.isArray(patch.servers)) ? patch.servers : [];
  const clean = incoming
    .filter((s) => s && typeof s.name === "string" && s.name.trim() && typeof s.command === "string" && s.command.trim())
    .map((s) => ({
      name: s.name.trim(),
      command: s.command.trim(),
      args: Array.isArray(s.args) ? s.args.map(String) : (typeof s.args === "string" ? s.args.split(/\s+/).filter(Boolean) : []),
      env: (s.env && typeof s.env === "object") ? s.env : {},
      enabled: s.enabled !== false,
      cwd: typeof s.cwd === "string" ? s.cwd : undefined,
    }));
  cfg.mcp = cfg.mcp || { servers: [] };
  cfg.mcp.servers = clean;
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.mcp = { servers: clean };
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
}

/* 当前引擎模式：有 key + baseURL 就用真实 LLM，否则演示引擎
   CURSORWEB_ENGINE=demo 可强制演示引擎（测试用，保证确定性） */
function engineMode(cfg) {
  if (process.env.CURSORWEB_ENGINE === "demo") return "demo";
  return cfg.llm.apiKey && cfg.llm.baseURL ? "llm" : "demo";
}

/* 给前端看的脱敏信息 */
function publicInfo(cfg) {
  const mode = engineMode(cfg);
  return {
    mode,
    model: mode === "llm" ? cfg.llm.model : "内置演示引擎",
    baseURL: cfg.llm.baseURL,
    hasKey: !!cfg.llm.apiKey,
    keyTail: cfg.llm.apiKey ? "…" + cfg.llm.apiKey.slice(-4) : "",
    maxToolRounds: cfg.llm.maxToolRounds,
    contextWindow: cfg.llm.contextWindow,
    agentMode: cfg.agentMode,
  };
}

/* 项目级分片路径：全部走 ws-key 的唯一键（md5(规范化绝对路径)），
   老键由 ws-key 在缺席时改名迁移、冲突时原样保留并上报。 */
function wsShard(cfg) {
  return wsKey.forWorkspace(path.resolve(ROOT, (cfg && cfg.workspace) || "workspace"), ROOT);
}
function memoryPath(cfg) {
  return wsShard(cfg).file(path.join(ROOT, ".pancode", "memory"));
}
/* 项目规则目录（loadRules 从此读取 *.md 强制注入到系统提示词） */
function rulesDir() { return path.join(ROOT, ".pancode", "rules"); }
/* 项目 Skill 文件路径 */
function skillPath(cfg) {
  return wsShard(cfg).file(path.join(ROOT, ".pancode", "skills"));
}
/* 项目灵魂(Soul)文件路径 — 与记忆/技能同算法、同工作区哈希 */
function soulPath(cfg) {
  return wsShard(cfg).file(path.join(ROOT, ".pancode", "soul"));
}
/* 项目进度(进化路线)文件路径 — 与记忆/技能/灵魂同算法、同工作区哈希 */
function progressionPath(cfg) {
  return wsShard(cfg).file(path.join(ROOT, ".pancode", "progression"));
}

module.exports = { load, saveLlm, saveWorkspace, saveAgentSettings, saveMcpServers, saveEmbedding, saveDesktop, agentSettings, embeddingInfo, engineMode, publicInfo, memoryPath, skillPath, soulPath, progressionPath, rulesDir, ROOT, CONFIG_PATH,
  saveLlmProfiles, upsertLlmProfile, applyLlmProfile, removeLlmProfile, profilePublic, normalizeBaseURL };
