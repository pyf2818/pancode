/* ============================================================
   pancode 仓库地图 / 检索增强（Repo Map · Retrieval Augmentation）
   - buildRepoIndex：扫描工作区，按语言抽取顶层符号（函数/类/接口/常量）
   - formatRepoMap：把索引压成紧凑的「符号地图」文本，供 Agent 快速建立代码库全景
   - searchSymbols：按名字检索定义（精确 > 前缀 > 子串），替代盲目 grep
   - repoOverview：零读取成本的顶层结构概览，注入系统提示做检索增强基线
   纯正则启发式，语言无关兜底（不支持的语言只列文件、不抽符号）。
   ============================================================ */
"use strict";
const { langOf } = require("./files");

/* 每种语言的符号提取规则（按行匹配，命中即记一个符号） */
const LANG_SYMBOLS = {
  javascript: [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "func" },
    { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/, kind: "func" },
    { re: /^\s*(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*=/, kind: "func" },
    { re: /^\s*(?:export\s+)?var\s+([A-Za-z_$][\w$]*)\s*=/, kind: "func" },
  ],
  typescript: [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "func" },
    { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type" },
    { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/, kind: "func" },
    { re: /^\s*(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*=/, kind: "func" },
    { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "type" },
  ],
  python: [
    { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "func" },
    { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
  ],
  go: [
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: "func" },
    { re: /^\s*type\s+([A-Za-z_]\w*)\s+/, kind: "type" },
  ],
  java: [
    { re: /^\s*(?:public|private|protected|static|\s)*?(?:static\s+)?(?:final\s+)?(?:public|private|protected\s+)?(?:class|interface|enum)\s+([A-Za-z_]\w*)/, kind: "class" },
    { re: /^\s*(?:public|private|protected|static|\s)*?(?:<[A-Za-z_,\s]*>\s*)?([A-Za-z_]\w*)\s+\w+\s*\([^)]*\)\s*\{/, kind: "func" },
  ],
  rust: [
    { re: /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/, kind: "func" },
    { re: /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/, kind: "class" },
  ],
};

/* 方法级符号（仅对 js/ts 启用，带负向前瞻排除 if/for/while 等控制流） */
const METHOD_RE = /^\s*(?!if|for|while|switch|catch|function|return|await|else|do|with|try|finally|typeof|new|delete|typeof|throw|yield|case)\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;
const METHOD_KINDS = new Set(["javascript", "typescript"]);

const MAX_INDEX_FILES = 400;   // 与 FileStore.MAX_FILES 对齐，避免超大仓库卡死
const MAX_SYMBOLS_PER_FILE = 60;
const MAX_SYMBOL_FILE_BYTES = 300 * 1024;

function buildRepoIndex(files) {
  let paths;
  try { paths = files.list(); } catch (e) { paths = []; }
  const fileEntries = [];
  let symbolCount = 0, indexed = 0;
  for (const p of paths) {
    if (indexed >= MAX_INDEX_FILES) break;
    const lang = langOf(p);
    const rules = LANG_SYMBOLS[lang];
    if (!rules && !METHOD_KINDS.has(lang)) continue; // 不支持的语言跳过符号抽取
    let content;
    try {
      if (files.isBinary && files.isBinary(p)) continue;
      content = files.read(p);
    } catch (e) { continue; }
    if (content.length > MAX_SYMBOL_FILE_BYTES) continue;
    const lines = content.split("\n");
    const syms = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let hit = false;
      if (rules) {
        for (const rule of rules) {
          const m = rule.re.exec(line);
          if (m) { syms.push({ name: m[1], kind: rule.kind, line: i + 1 }); hit = true; break; }
        }
      }
      if (!hit && METHOD_KINDS.has(lang)) {
        const mm = METHOD_RE.exec(line);
        if (mm) syms.push({ name: mm[1], kind: "method", line: i + 1 });
      }
      if (syms.length >= MAX_SYMBOLS_PER_FILE) break;
    }
    if (syms.length) { fileEntries.push({ path: p, lang, symbols: syms }); symbolCount += syms.length; indexed++; }
  }
  return { files: fileEntries, symbolCount, fileCount: paths.length, indexedCount: indexed };
}

function formatRepoMap(index, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 60;
  const maxSym = opts.maxSym || 30;
  const maxChars = opts.maxChars || 6000;
  let out = "仓库符号地图（repo map）：\n";
  out += `（共 ${index.fileCount} 个文件；索引到 ${index.indexedCount} 个含符号的文件、${index.symbolCount} 个符号）\n\n`;
  let chars = out.length;
  for (const f of index.files.slice(0, maxFiles)) {
    const head = f.path + "  [" + f.lang + "]\n";
    if (chars + head.length > maxChars) { out += "…（已达长度上限，更多细节用 search_symbol 按名字检索）\n"; break; }
    out += head; chars += head.length;
    for (const s of f.symbols.slice(0, maxSym)) {
      const ln = "  · " + s.kind + " " + s.name + "  (L" + s.line + ")\n";
      if (chars + ln.length > maxChars) { out += "  · …\n"; break; }
      out += ln; chars += ln.length;
    }
  }
  return out;
}

function searchSymbols(index, q) {
  q = String(q || "").trim().toLowerCase();
  if (q.length < 1) return [];
  const res = [];
  for (const f of index.files) {
    for (const s of f.symbols) {
      const name = s.name.toLowerCase();
      let score = 0;
      if (name === q) score = 3;
      else if (name.startsWith(q)) score = 2;
      else if (name.includes(q)) score = 1;
      if (score) res.push({ path: f.path, name: s.name, kind: s.kind, line: s.line, score });
    }
  }
  res.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return res.slice(0, 40);
}

/* 零读取成本的结构概览：顶层目录 + 源码计数 + 疑似入口，注入系统提示做检索增强基线 */
function repoOverview(files) {
  let paths;
  try { paths = files.list(); } catch (e) { return ""; }
  if (!paths.length) return "";
  const dirs = new Set();
  const entryHints = new Set();
  let srcCount = 0;
  const SRC_EXT = new Set(["js", "ts", "jsx", "tsx", "py", "go", "java", "c", "cpp", "rs", "rb", "php"]);
  for (const p of paths) {
    const segs = p.split("/");
    if (segs[0]) dirs.add(segs[0]);
    const base = segs[segs.length - 1].toLowerCase();
    if (/^readme(\.|$)/.test(base)) entryHints.add(p);
    else if (base === "package.json") entryHints.add(p);
    else if (/^(index|main|app|server)\.(js|ts|jsx|tsx|py|go|java)$/.test(base)) entryHints.add(p);
    const ext = p.split(".").pop().toLowerCase();
    if (SRC_EXT.has(ext)) srcCount++;
  }
  let s = "仓库结构概览（自动注入，供快速定位；细节请调用 repo_map 获取完整符号地图，或用 search_symbol 按名字检索定义）：\n";
  s += "- 顶层目录：" + [...dirs].slice(0, 12).join("、") + "（共 " + paths.length + " 个文件，约 " + srcCount + " 个源码文件）\n";
  const hints = [...entryHints].slice(0, 6);
  if (hints.length) s += "- 疑似入口：" + hints.join("、") + "\n";
  return s;
}

module.exports = { buildRepoIndex, formatRepoMap, searchSymbols, repoOverview };
