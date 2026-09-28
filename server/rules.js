"use strict";
/* ============ pancode · 规则层（server/rules.js） ============
   规则是 Agent 每轮强制注入系统提示词的硬约束。可视化编辑它需要三件事与
   loadRules() 严格同源，否则面板里看到的"生效规则"和模型实际读到的会不一致：
     1) 同一份 frontmatter 解析（enabled / always / globs / title）
     2) 同一份 glob 编译器（与权限规则共用 _globToRe 语义）
     3) 同一份装配与预算截断（assemble）
   故本模块被 agent-llm.loadRules 与 /api/rules 共同引用，而不是各写一遍。 */

const fs = require("fs");
const path = require("path");

const RULES_DIR = ".pancode/rules";
const RULE_DIRS = [".pancode/rules", ".cursor/rules"];

/* 直接枚举磁盘上的规则目录。
   为什么不能走 files.list()：FileStore 按设计跳过一切点开头的名字（isIgnored），
   所以 .pancode/rules 与 .cursor/rules 在它的结果里恒为空 —— 规则写进去了、面板也看得见，
   但模型一个字都读不到。这条路径必须独立枚举。（沙箱契约测试 scripts/_verify_assets.js 守着。） */
function listRuleDir(absRoot, relDir, depth) {
  const out = [];
  if (!absRoot || (depth || 0) > 3 || out.length > 400) return out;
  const base = path.join(absRoot, relDir);
  let names = [];
  try { names = fs.readdirSync(base); } catch (e) { return out; }
  for (const n of names) {
    let st;
    try { st = fs.statSync(path.join(base, n)); } catch (e) { continue; }
    const rel = relDir + "/" + n;
    if (st.isDirectory()) out.push.apply(out, listRuleDir(absRoot, rel, (depth || 0) + 1));
    else if (st.isFile() && /\.(md|mdc)$/i.test(n) && st.size <= 200000) out.push(rel);
  }
  return out;
}

/* 根级规则清单：AGENTS.md / CLAUDE.md 出现在 files.list() 里，.pancoderules / .cursorrules
   不会（点开头被 isIgnored 跳过），所以要补一次磁盘探测。 */
function rootRuleFiles(absRoot, names, listed) {
  const out = [];
  for (const n of names || []) {
    if ((listed || []).includes(n)) { out.push(n); continue; }
    if (!absRoot) continue;
    try { if (fs.existsSync(path.join(absRoot, n))) out.push(n); } catch (e) {}
  }
  return out;
}

/* glob → RegExp。** 跨目录、* 不跨 /、? 单字符；大小写不敏感。 */
function globToRe(glob) {
  let out = "^";
  const s = String(glob);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "*") {
      if (s[i + 1] === "*") { out += ".*"; i++; if (s[i + 1] === "/") i++; }
      else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if ("\\^$.|+()[]{}".indexOf(c) >= 0) out += "\\" + c;
    else out += c;
  }
  return new RegExp(out + "$", "i");
}

function truthy(v) {
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "on" || s === "1";
}

/* 宽松 frontmatter 解析：只认 `---` 包起来的键值头，值支持 [a, b] 数组字面量。
   手写规则包经常缺头或写错缩进，这里不能抛异常，只能尽量读出来。 */
function parseFrontmatter(text) {
  const raw = String(text == null ? "" : text);
  const meta = { title: "", enabled: true, always: false, globs: [], description: "" };
  let body = raw;
  const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const val = kv[2].trim().replace(/^["']|["']$/g, "");
      if (key === "enabled") meta.enabled = truthy(val);
      else if (key === "always" || key === "alwaysapply") meta.always = truthy(val);   // alwaysApply = Cursor MDC 的写法
      else if (key === "globs" || key === "glob" || key === "paths") {
        meta.globs = val.startsWith("[") && val.endsWith("]")
          ? val.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
          : val.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (key === "title" || key === "name") meta.title = val;
      else if (key === "description" || key === "desc") meta.description = val;
    }
    body = m[2];
  }
  if (!meta.title) {
    const h = body.match(/^\s*#\s+(.+)$/m);
    meta.title = h ? h[1].trim() : "";
  }
  return { meta, body: body.trim() };
}

/* 回写 frontmatter（只写我们用得到的字段，保留正文原样） */
function toMd(meta, body) {
  const lines = ["---"];
  lines.push("title: " + String(meta.title || "").trim());
  if (meta.description) lines.push("description: " + String(meta.description).trim());
  lines.push("enabled: " + (meta.enabled === false ? "false" : "true"));
  if (meta.always) lines.push("always: true");
  const g = Array.isArray(meta.globs) ? meta.globs.filter(Boolean) : [];
  if (g.length) lines.push("globs: [" + g.join(", ") + "]");
  lines.push("---", "", String(body || "").trim(), "");
  return lines.join("\n");
}

/* 本轮是否注入。touched 为空数组 = 静态预览（不参与 glob 命中，按"按需"标注）。
   返回 { on, why } —— why 直接给面板当徽章文案。 */
function activeFor(meta, touched) {
  if (meta && meta.enabled === false) return { on: false, why: "已停用" };
  if (meta && meta.always) return { on: true, why: "始终生效" };
  const g = (meta && Array.isArray(meta.globs)) ? meta.globs.filter(Boolean) : [];
  if (!g.length) return { on: true, why: "始终生效" };
  const list = Array.isArray(touched) ? touched : [];
  if (!list.length) return { on: false, why: "按需（本轮未涉及文件）", conditional: true };
  for (const p of list) {
    const rel = String(p).replace(/\\/g, "/").replace(/^\.\//, "");
    for (const glob of g) if (globToRe(glob).test(rel)) return { on: true, why: "命中 " + glob, conditional: true };
  }
  return { on: false, why: "按需（glob 未命中）", conditional: true };
}

/* 规则文件名：中文可读，只拦掉路径穿越与非法字符，不做拼音化 */
function safeName(title, fallback) {
  const s = String(title || "").trim().toLowerCase()
    .replace(/\.[\\/]/g, ".")
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || String(fallback || "rule-" + Date.now());
}

/* 与 loadRules 共用的装配：按预算拼最终注入文本，超额显式告知而非静默丢弃 */
function assemble(blocks, maxTotal) {
  const MAX = maxTotal || 12000;
  let out = "", used = 0, truncated = null;
  for (const b of blocks || []) {
    if (used + b.content.length > MAX) { truncated = b.label; break; }
    out += (out ? "\n\n" : "") + "## " + b.label + "（" + b.why + "）\n" + b.content;
    used += b.content.length;
  }
  if (truncated) {
    out += "\n\n## 已省略\n规则总量超过 " + MAX + " 字符，从「" + truncated
      + "」起后续文件未注入（如需生效请精简规则或缩小范围）。";
  }
  return out;
}

/* 规则来源分类：与 agent-llm 的四级装配顺序一一对应 */
const KIND = {
  root: { order: 1, label: "根级规则" },
  pancode: { order: 2, label: "项目规则" },
  cursor: { order: 3, label: "Cursor 规则" },
  diragents: { order: 4, label: "目录级 AGENTS.md" },
};

function kindOf(file, candidates) {
  const f = String(file).replace(/\\/g, "/");
  if (candidates.includes(f)) return "root";
  if (f.startsWith(".pancode/rules/")) return "pancode";
  if (f.startsWith(".cursor/rules/")) return "cursor";
  if (/(^|\/)AGENTS\.md$/i.test(f)) return "diragents";
  return null;
}

/* 把目录内的规则文件摊平成面板用的记录 */
function describe(file, content, scope, candidates) {
  const kind = kindOf(file, candidates || []);
  if (!kind) return null;
  const parsed = parseFrontmatter(content);
  const editable = kind === "pancode" && scope !== "app";
  return {
    file,
    scope,
    kind,
    kindLabel: KIND[kind].label,
    order: KIND[kind].order,
    title: parsed.meta.title || path.posix.basename(String(file).replace(/\\/g, "/")),
    description: parsed.meta.description,
    enabled: parsed.meta.enabled !== false,
    always: !!parsed.meta.always,
    globs: parsed.meta.globs,
    chars: parsed.body.length,
    excerpt: parsed.body.replace(/^#+\s*/gm, "").slice(0, 180),
    editable,
    deletable: editable,
  };
}

module.exports = {
  globToRe, parseFrontmatter, toMd, activeFor, safeName, assemble,
  describe, kindOf, KIND, listRuleDir, rootRuleFiles,
  RULES_DIR, RULE_DIRS,
};
