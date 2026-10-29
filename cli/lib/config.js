/* ============================================================
   pancode-cli · 配置管理（自包含版）
   优先级：环境变量 > ~/.pancode-cli.json > 默认值
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { loadDotEnv, setEnvVar } = require("./dotenv");

const CONFIG_PATH = path.join(os.homedir(), ".pancode-cli.json");

const DEFAULTS = {
  workspace: process.cwd(),
  llm: {
    baseURL: "",
    apiKey: "",
    model: "",
    temperature: 0.2,
    maxToolRounds: 200,
    contextWindow: 256000,
  },
  permissions: {
    mode: "ask",   // ask | semi | auto
    allow: [],
    deny: [],
  },
};

function load() {
  loadDotEnv();
  let cfg = JSON.parse(JSON.stringify(DEFAULTS));
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      cfg = deepMerge(cfg, saved);
    } catch (e) { /* 配置文件损坏，用默认值 */ }
  }
  /* 环境变量覆盖 */
  if (process.env.OPENAI_API_KEY && !cfg.llm.apiKey) cfg.llm.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_BASE_URL && !cfg.llm.baseURL) cfg.llm.baseURL = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_MODEL && !cfg.llm.model) cfg.llm.model = process.env.OPENAI_MODEL;
  return cfg;
}

function save(cfg) {
  const data = JSON.stringify(cfg, null, 2);
  fs.writeFileSync(CONFIG_PATH, data, "utf8");
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k in over) {
    if (over[k] && typeof over[k] === "object" && !Array.isArray(over[k]) &&
        base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over[k];
    }
  }
  return out;
}

/* LLM profile 管理（兼容 /llm 命令） */
function upsertLlmProfile(cfg, profile) {
  if (!cfg.llmProfiles) cfg.llmProfiles = [];
  const idx = cfg.llmProfiles.findIndex((p) => p.name === profile.name);
  if (idx >= 0) cfg.llmProfiles[idx] = profile;
  else cfg.llmProfiles.push(profile);
}

function normalizeBaseURL(url) {
  if (!url) return "";
  let u = String(url).trim().replace(/\/+$/, "");
  /* 自动补 /v1：用户常填 https://api.openai.com 而忘了 /v1 */
  if (!/\/v\d+(?:beta\d*)?$/.test(u) && !/\/chat\/completions$/.test(u)) {
    u += "/v1";
  }
  return u;
}

function hasKey(cfg) {
  return !!(cfg.llm && cfg.llm.apiKey);
}

module.exports = { load, save, deepMerge, upsertLlmProfile, normalizeBaseURL, hasKey, CONFIG_PATH };
