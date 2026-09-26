/* ============================================================
   W2 · ExpertStore — 专家角色包（Experts & Personas）
   ------------------------------------------------------------
   专家 = 角色设定(role) + 方法论(methodology) + 可选工具白名单(tool_whitelist)
   对齐 WorkBuddy 的 "Expert" 一等公民：让 agent 按场景切换专家人格，
   并在子智能体上按白名单收敛工具集。

   三层来源（优先级 project > user > builtin，同 id 覆盖）：
   - builtin:  BUILTIN_EXPERTS（内置三角色，升级自旧 PERSONAS，id 不变零迁移）
   - user:     ~/.pancode/experts/*.md（跨项目个人专家库）
   - project:  <工作区>/.pancode/experts/*.md（项目专家，agent 可直接 write_file 沉淀）

   专家包格式（md + frontmatter，正文第一段=role，其余=methodology）：
   ---
   name: 代码审查专家
   description: 对抗性审查，找 bug 与安全漏洞
   tool_whitelist: [read_file, search_code, search_symbol, repo_map]
   ---
   你是一位严苛的代码审查专家，专注找问题而非夸奖。

   ## 方法论
   1. 先读全上下文再评判
   2. ...
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

/* ---------- 内置专家（升级自旧 PERSONAS，id 与 cfg.persona.active 旧值完全兼容） ---------- */
const BUILTIN_EXPERTS = [
  {
    id: "fullstack",
    name: "全栈工程师",
    description: "前后端协同思考的全栈视角",
    source: "builtin",
    role: "你是一位资深全栈工程师，习惯前后端协同思考。",
    methodology: "改动 API 时同步考虑契约、错误码与前端调用；优先复用现有模块，保持接口一致。",
    tool_whitelist: [],
  },
  {
    id: "frontend",
    name: "前端专家",
    description: "注重设计与体验的前端视角",
    source: "builtin",
    role: "你是一位注重设计与体验的前端工程师。",
    methodology: "重视视觉还原、可访问性（a11y）、组件化与交互细节；偏好语义化标签与清晰的状态管理。",
    tool_whitelist: [],
  },
  {
    id: "backend",
    name: "后端专家",
    description: "严谨健壮的后端视角",
    source: "builtin",
    role: "你是一位严谨的后端工程师。",
    methodology: "重视健壮性、可观测性、错误处理与安全防护（输入校验、鉴权、日志）；改动先评估边界与失败路径。",
    tool_whitelist: [],
  },
];

/* ---------- 专家 md 解析（纯函数，可测） ----------
   返回 {id, name, description, role, methodology, tool_whitelist, source} 或 null（无效包） */
function parseExpertMd(text, id, source) {
  text = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return null;
  let meta = {};
  let body = text;
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      const val = kv[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        meta[kv[1]] = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        meta[kv[1]] = val;
      }
    }
    body = m[2].trim();
  }
  // name 缺失时回退到文件名 id（皮实：手写包忘写 name 仍可用）；两者皆无才拒绝
  if (!meta.name && !id) return null;
  // 正文切分：第一个空行之前 = role，其余全部 = methodology（保留 ## 小标题原样注入）
  let role = "";
  let methodology = "";
  const cut = body.indexOf("\n\n");
  if (cut === -1) {
    role = body;
  } else {
    role = body.slice(0, cut).trim();
    methodology = body.slice(cut + 2).trim();
  }
  return {
    id: String(id || meta.name),
    name: String(meta.name || id),
    description: String(meta.description || ""),
    role,
    methodology,
    tool_whitelist: Array.isArray(meta.tool_whitelist) ? meta.tool_whitelist : [],
    source: source || "project",
  };
}

/* ---------- 专家提示词格式化：role + methodology 平铺（注入 system 用） ---------- */
function formatExpertPrompt(e) {
  if (!e) return "";
  let s = String(e.role || "");
  if (e.methodology) s += (s ? "\n" : "") + String(e.methodology);
  return s.trim();
}

/* ---------- 专家注册表 ---------- */
class ExpertStore {
  /* projectDir: <工作区>/.pancode/experts（可为 null）；userDir: ~/.pancode/experts（可为 null） */
  constructor(projectDir, userDir) {
    this._projectDir = projectDir || null;
    this._userDir = userDir || null;
  }

  /* 仅内置专家的兜底注册表（agent 无共享 store 时的降级，单测/极端容错用） */
  static builtinOnly() {
    return new ExpertStore(null, null);
  }

  /* 扫描一个目录下的 *.md 专家包；目录不存在/读失败 → 空数组（绝不抛错） */
  _readDir(dir, source) {
    if (!dir) return [];
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)); } catch (e) { return []; }
    const out = [];
    for (const f of files) {
      let text = "";
      try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch (e) { continue; }
      const e = parseExpertMd(text, f.replace(/\.md$/i, ""), source);
      if (e) out.push(e); // 坏文件静默跳过——单个损坏包不影响整个注册表
    }
    return out;
  }

  /* 按优先级排序的全量池：project > user > builtin（同名/同 id 时前者胜） */
  _ordered() {
    return [
      ...this._readDir(this._projectDir, "project"),
      ...this._readDir(this._userDir, "user"),
      ...BUILTIN_EXPERTS,
    ];
  }

  /* 合并视图：同 id 去重（project 优先保留）。每次调用重扫——专家文件数量极小，
     换取零缓存失效问题（外部/agent 直接改文件立即生效）。 */
  list() {
    const seen = new Set();
    const out = [];
    for (const e of this._ordered()) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  }

  /* 按 id 或 name 精确匹配（project > user > builtin 取先命中者） */
  byIdOrName(key) {
    const k = String(key || "").trim();
    if (!k) return null;
    for (const e of this._ordered()) {
      if (e.id === k || e.name === k) return e;
    }
    return null;
  }
}

module.exports = { ExpertStore, BUILTIN_EXPERTS, parseExpertMd, formatExpertPrompt };
