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
  /* F-H1：依赖图排序（Aider 方案）—— 轻量 import/require 边提取，
     让 formatRepoMap 按「依赖被谁用」拓扑排序，被依赖多的文件先展示。
     对 JS/TS 提取 import/require，对 Python 提取 from/import，对 Go 提取 import 块，
     对 Rust 提取 use。边只记录文件级（不记符号级），开销可接受。
     最后一个 import\s* 分支是为 P3-D2 补的：`import "./side-effect.css"` 这种无绑定的
     副作用导入以前一条都不匹配，于是依赖图上凭空少一条边——少边比多边危险，
     因为"看不出牵连"和"没有牵连"在界面上长得一模一样。 */
  const DEP_RE = {
    javascript: /^\s*(?:import\s.*?from\s|import\s*\(|require\s*\(|import\s+[\w{},\s]+|import\s*)\s*["']([^"']+)["']/,
    typescript: /^\s*(?:import\s.*?from\s|import\s*\(|require\s*\(|import\s+[\w{},\s]+|import\s*)\s*["']([^"']+)["']/,
    python: /^\s*(?:from\s+(\.\.?\/?[\w.]+)\s+import|import\s+(\w))/,
    go: /^\s*(?:import\s+\(|import\s+)["']([^"']+)["']?/,
    rust: /^\s*use\s+([a-zA-Z_][\w:]*)/,
  };
  const depMap = new Map();   // path -> Set<depPath>
  function resolveDep(importer, spec) {
    if (!spec) return null;
    const segs = importer.split("/");
    segs.pop();   // dirname
    const base = spec.startsWith(".") ? segs.join("/") : "";
    const raw = spec.startsWith(".") ? spec : "node_modules/" + spec;
    let rel;
    if (spec.startsWith(".")) {
      /* base 为空是真实情况：根级文件（app.js / index.js）的 dirname 就是工作区根本身。
         以前无条件拼 "base + '/' + spec" 会得出 "/./b"，于是根级文件的相对导入一条都解析不上——
         偏偏根级文件是入口，"看不出牵连"在图上和"没有牵连"长得一模一样。 */
      const joined = (base ? base + "/" : "") + spec;
      const parts = joined.split("/");
      let i = 0;
      while (i < parts.length) {
        if (parts[i] === ".") { parts.splice(i, 1); continue; }
        if (parts[i] === ".." && i > 0) { parts.splice(i - 1, 2); i--; continue; }
        i++;
      }
      rel = parts.join("/");
    } else {
      // 非相对导入（npm 包），无法解析为本地文件，跳过
      return null;
    }
    // 尝试常见后缀
    const exts = [".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".rs", ""];
    for (const ext of exts) {
      const candidate = rel + ext;
      if (ext === "") {
        if (paths.includes(candidate)) return candidate;
      } else if (paths.includes(candidate)) return candidate;
    }
    return null;
  }
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
    const deps = new Set();
    const depRe = DEP_RE[lang];
    let capped = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let hit = false;
      /* 符号数封顶只该封顶符号，不该顺手把这一文件的依赖边也截断：
         以前这里是 break，于是"超过 60 个符号的文件"后半段的 import 全丢，
         depCount 排序与 P3-D2 的依赖图都因此少边（大文件恰恰是最该看清依赖的那批）。 */
      if (!capped) {
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
        if (syms.length >= MAX_SYMBOLS_PER_FILE) capped = true;
      }
      /* F-H1：提取依赖边 */
      if (depRe && i < lines.length) {
        const dm = depRe.exec(line);
        if (dm) {
          const spec = dm[1] || dm[2];
          if (spec) {
            const resolved = resolveDep(p, spec);
            if (resolved) deps.add(resolved);
          }
        }
      }
    }
    if (deps.size) depMap.set(p, deps);
    if (syms.length) { fileEntries.push({ path: p, lang, symbols: syms }); symbolCount += syms.length; indexed++; }
  }
  /* F-H1：拓扑排序 —— 按被依赖数量降序排列（被依赖越多越靠前），
     相同被依赖数时按原路径排序保持稳定 */
  const depCount = new Map();   // path -> 被谁依赖的次数
  for (const [importer, depSet] of depMap) {
    for (const dep of depSet) {
      depCount.set(dep, (depCount.get(dep) || 0) + 1);
    }
  }
  fileEntries.sort((a, b) => {
    const ac = depCount.get(a.path) || 0;
    const bc = depCount.get(b.path) || 0;
    if (ac !== bc) return bc - ac;   // 被依赖多的排前面
    return a.path.localeCompare(b.path);
  });
  return {
    files: fileEntries, symbolCount, fileCount: paths.length, indexedCount: indexed, depCount,
    /* P3-D2：把邻接表原样交出去。以前算完只留了 depCount 计数，边本身被丢掉了，
       于是"改这个文件会牵连谁"这种问题无处可问。 */
    edges: Object.fromEntries([...depMap.entries()].map(([k, v]) => [k, [...v]])),
  };
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
