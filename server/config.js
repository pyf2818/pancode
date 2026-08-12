/* ============================================================
   pancode 配置中心
   优先级：环境变量 > pancode.config.json > 默认值
   - LLM 配置可在运行时通过 UI 修改并持久化到配置文件
   - 无 API Key 时自动降级到演示引擎（产品可开箱即用）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { setEnvVar } = require("./dotenv");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "pancode.config.json");

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
  },
  // —— Phase 1：Agent 框架 ——
  permissions: {
    mode: "ask",          // ask=全部询问(默认) | semi=半自动(安全操作免确认) | auto=全自动(仅高危硬拦截)
    allow: [],            // 免确认规则（命令子串/正则，或文件 glob），semi/auto 模式生效
    deny: [],             // 强制拦截（命令子串/正则，或文件 glob），所有模式生效
  },
  persona: {
    active: "default",    // default | fullstack | frontend | backend | custom
    systemPrompt: "",     // 自定义人格覆盖（非空时优先于预设）
  },
  rules: { enabled: true },        // 是否加载 .pancode/rules 作为强制约束
  context: { budgetTokens: 1000000, autoCompact: true }, // 上下文预算 1M tokens
  memory: { enabled: true },       // auto memory（会话中沉淀记忆）
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
  // —— 本地 Agent CLI 全局路径（可选；配置了绝对路径后优先于 PATH 探测）——
  agents: {
    paths: { claude: "", codex: "", gemini: "", aider: "" },  // 各 Agent 可执行文件绝对路径
  },
};

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

/* 皮实的配置写入：
   直接覆盖写可能被安全软件/环境钩子拦截（EPERM），
   失败后降级为「写临时文件 → rename 顶替」，再失败只警告不抛错——
   配置持久化永远不该阻断主流程（比如打开文件夹）。 */
function writeJsonSafe(p, obj) {
  const data = JSON.stringify(obj, null, 2);
  try { fs.writeFileSync(p, data, "utf8"); return true; } catch (e) {}
  try {
    const tmp = p + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.warn("[config] 配置持久化失败（不影响本次会话）:", e.message);
    return false;
  }
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
  return cfg;
}

/* 把 UI 提交的 LLM 设置持久化。
   安全约定：apiKey 永不写入配置文件（明文入库 = 泄露风险），只存于运行时内存 + 本地 .env（已被 .gitignore 忽略）。
   baseURL / model 等非敏感项才写入 pancode.config.json。 */
function saveLlm(cfg, patch) {
  const baseURL = typeof patch.baseURL === "string" ? patch.baseURL.trim() : undefined;
  const apiKey = typeof patch.apiKey === "string" ? patch.apiKey.trim() : undefined;
  const model = typeof patch.model === "string" ? patch.model.trim() : undefined;
  if (baseURL !== undefined) cfg.llm.baseURL = baseURL;
  if (apiKey !== undefined) { cfg.llm.apiKey = apiKey; setEnvVar("OPENAI_API_KEY", apiKey); }
  if (model !== undefined) cfg.llm.model = model;
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.llm = { baseURL: cfg.llm.baseURL, model: cfg.llm.model };
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
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

  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.permissions = cfg.permissions;
  onDisk.persona = cfg.persona;
  onDisk.rules = cfg.rules;
  onDisk.context = cfg.context;
  onDisk.memory = cfg.memory;
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
}

/* 给前端的 Agent 设置（脱敏，可编辑字段原样返回） */
function agentSettings(cfg) {
  return {
    permissions: cfg.permissions,
    persona: cfg.persona,
    rules: cfg.rules,
    context: cfg.context,
    memory: cfg.memory,
  };
}

/* 持久化本地 Agent CLI 全局路径（仅非敏感配置，写入 pancode.config.json） */
function saveAgentPaths(cfg, patch) {
  const p = (patch && patch.paths) || {};
  const fields = ["claude", "codex", "gemini", "aider"];
  if (!cfg.agents) cfg.agents = { paths: {} };
  if (!cfg.agents.paths) cfg.agents.paths = {};
  fields.forEach((k) => {
    if (typeof p[k] === "string") cfg.agents.paths[k] = p[k].trim();
  });
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.agents = { paths: cfg.agents.paths };
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
  };
}

/* 项目记忆文件路径（与 Agent 内部 _memoryPath 算法一致：md5(工作区绝对路径)） */
function memoryPath(cfg) {
  const wsAbs = path.resolve(ROOT, (cfg && cfg.workspace) || "workspace");
  const key = crypto.createHash("md5").update(wsAbs).digest("hex");
  return path.join(ROOT, ".pancode", "memory", key + ".json");
}
/* 项目规则目录（loadRules 从此读取 *.md 强制注入到系统提示词） */
function rulesDir() { return path.join(ROOT, ".pancode", "rules"); }
/* 项目 Skill 文件路径 */
function skillPath(cfg) {
  const wsAbs = path.resolve(ROOT, (cfg && cfg.workspace) || "workspace");
  const key = crypto.createHash("md5").update(wsAbs).digest("hex");
  return path.join(ROOT, ".pancode", "skills", key + ".json");
}
/* 项目灵魂(Soul)文件路径 — 与记忆/技能同算法、同工作区哈希 */
function soulPath(cfg) {
  const wsAbs = path.resolve(ROOT, (cfg && cfg.workspace) || "workspace");
  const key = crypto.createHash("md5").update(wsAbs).digest("hex");
  return path.join(ROOT, ".pancode", "soul", key + ".json");
}
/* 项目进度(进化路线)文件路径 — 与记忆/技能/灵魂同算法、同工作区哈希 */
function progressionPath(cfg) {
  const wsAbs = path.resolve(ROOT, (cfg && cfg.workspace) || "workspace");
  const key = crypto.createHash("md5").update(wsAbs).digest("hex");
  return path.join(ROOT, ".pancode", "progression", key + ".json");
}

module.exports = { load, saveLlm, saveWorkspace, saveAgentSettings, saveAgentPaths, agentSettings, engineMode, publicInfo, memoryPath, skillPath, soulPath, progressionPath, rulesDir, ROOT, CONFIG_PATH };
