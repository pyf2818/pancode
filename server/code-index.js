/* ============================================================
   pancode · 轻量代码向量索引（server/code-index.js）
   ------------------------------------------------------------
   目标：给 Agent 一个「按需检索代码上下文」的能力，补 repo_map 的不足。
   设计（第一性原理 · 轻量优先）：
   - 分块：正则抽取「函数/类」级边界做语义分块（无原生依赖、可移植）；
     找不到边界时退化为固定行窗口滑动分块。不引入需要编译的 tree-sitter。
   - 向量：若配置了 OpenAI 兼容 /v1/embeddings 端点则生成 embedding；
     否则完全不依赖外部服务，用 BM25 词法检索兜底——开箱即用。
   - 检索：有向量用余弦相似度，无向量用 BM25；返回 topK 片段（路径/行号/摘要）。
   - 持久化：按工作区哈希存到 .pancode/code-index/<hash>.json。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const INDEX_DIR = path.join(ROOT, ".pancode", "code-index");

/* 跳过的目录 / 文件（避免索引依赖与产物） */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "release", ".pancode", "out", "coverage", ".next", ".vite"]);
const MAX_FILE_BYTES = 400 * 1024;
const CHUNK_WINDOW = 42, CHUNK_STEP = 30;

const LANG_BY_EXT = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", hpp: "cpp",
  rb: "ruby", php: "php", swift: "swift", kt: "kotlin", cs: "csharp", sh: "shell",
  json: "json", md: "markdown", yml: "yaml", yaml: "yaml", html: "html", css: "css",
};
function langOfFile(rel) {
  const ext = rel.split(".").pop().toLowerCase();
  return LANG_BY_EXT[ext] || "plaintext";
}

/* 声明边界正则（覆盖主流语言的函数/类/方法/常量） */
const DECL_RE = /^\s*(export\s+)?(async\s+)?(function\s+[\w$]+|def\s+[\w$]+|class\s+[\w$]+|interface\s+[\w$]+|struct\s+[\w$]+|impl\w*(\s*<[^>]*>)?\s+[\w$]+|func\s+[\w$]+|pub\s+fn\s+[\w$]+|const\s+[\w$]+\s*=|let\s+[\w$]+\s*=|var\s+[\w$]+\s*=|[\w$]+\s*\([^)]*\)\s*\{|[\w$]+\s*=>)/;

function firstDecl(text) {
  const m = text.match(DECL_RE);
  if (m) return m[0].trim().slice(0, 80);
  const first = text.split("\n").find((l) => l.trim());
  return first ? first.trim().slice(0, 80) : "(片段)";
}

function chunkFile(rel, content) {
  const lines = content.split("\n");
  if (lines.length === 0) return [];
  const bounds = [];
  for (let i = 0; i < lines.length; i++) if (DECL_RE.test(lines[i])) bounds.push(i);
  const spans = [];
  if (bounds.length === 0) {
    for (let s = 0; s < lines.length; s += CHUNK_STEP) {
      const e = Math.min(lines.length, s + CHUNK_WINDOW);
      spans.push([s, e]);
    }
  } else {
    for (let i = 0; i < bounds.length; i++) {
      const s = bounds[i];
      const e = i + 1 < bounds.length ? bounds[i + 1] : lines.length;
      spans.push([s, e]);
    }
  }
  return spans.map(([s, e], idx) => ({
    id: rel + "#" + idx,
    path: rel,
    startLine: s + 1,
    endLine: e,
    title: firstDecl(lines.slice(s, e).join("\n")),
    text: lines.slice(s, e).join("\n"),
  }));
}

/* ---------- embedding（可选） ---------- */
async function embed(texts, cfg) {
  const e = cfg && cfg.embedding;
  if (!e || !e.endpoint) return null;
  const url = e.endpoint.replace(/\/+$/, "") + "/embeddings";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, e.apiKey ? { Authorization: "Bearer " + e.apiKey } : {}),
      body: JSON.stringify({ model: e.model || "text-embedding-3-small", input: texts }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j.data || !Array.isArray(j.data)) return null;
    return j.data.map((d) => d.embedding);
  } catch (err) {
    console.warn("[code-index] embedding 失败，回退 BM25:", err.message);
    return null;
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ---------- BM25（兜底检索） ---------- */
/* 分词：先拆 camelCase / snake_case / 路径分隔符，再整体小写。
   这样 BM25 兜底检索能命中驼峰标识符（如 WebSocketServer -> web/socket/server），
   查询 “server” 也能命中 “WebSocketServer”。保留原整词与拆分碎片两类 token。 */
function tokenize(s) {
  if (!s) return [];
  const norm = String(s)
    .replace(/[_\.\/\\]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return norm.toLowerCase().match(/[a-z0-9_$]+/g) || [];
}
function buildBm25(chunks) {
  const N = chunks.length;
  // 注意：必须用 Object.create(null) 而非 {}，否则普通对象从 Object.prototype
  // 继承的 "constructor" 键会与代码中的 constructor 标识符冲突——读到的是
  // Object 构造函数，Object + 1 变成字符串，污染 len 累加，使 avgdl = NaN，
  // 进而导致所有 BM25 得分变 NaN 被过滤掉、检索永远返回 0 结果。
  const df = Object.create(null);
  chunks.forEach((c) => { const tset = new Set(tokenize(c.text)); tset.forEach((t) => (df[t] = (df[t] || 0) + 1)); });
  const docs = chunks.map((c) => {
    const f = Object.create(null);
    tokenize(c.text).forEach((t) => (f[t] = (f[t] || 0) + 1));
    const len = Object.values(f).reduce((a, b) => a + b, 0);
    return { tf: f, len };
  });
  const sumLens = docs.reduce((s, d) => s + d.len, 0);
  const avgdl = sumLens / Math.max(1, N);
  return { N, df, docs, avgdl };
}
function bm25Score(qtokens, doc, idx) {
  const k = 1.5, b = 0.75;
  const adl = idx.avgdl > 0 ? idx.avgdl : 1; // 防御：avgdl 非正时兜底，避免 0/0 = NaN 污染整次检索
  let score = 0;
  for (const q of qtokens) {
    if (!idx.df[q]) continue;
    const f = doc.tf[q] || 0;
    if (!f) continue;
    const idf = Math.log(1 + (idx.N - idx.df[q] + 0.5) / (idx.df[q] + 0.5));
    score += idf * (f * (k + 1)) / (f + k * (1 - b + (b * doc.len) / adl));
  }
  return score;
}

/* ---------- 索引构建 / 读取 / 检索 ---------- */
function wsIndexFile(wsAbs) {
  const key = crypto.createHash("md5").update(wsAbs).digest("hex");
  return path.join(INDEX_DIR, key + ".json");
}
function metaOf(wsAbs) { return { ws: wsAbs, builtAt: Date.now(), useVector: false, count: 0 }; }

const _cache = new Map();   // wsHash -> { meta, chunks }

function loadFromDisk(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return raw;
  } catch (e) { return null; }
}

async function buildIndex({ wsDir, fileStore, cfg }) {
  const wsAbs = path.resolve(wsDir);
  const file = wsIndexFile(wsAbs);
  const chunks = [];
  const files = fileStore ? fileStore.list() : fs.readdirSync(wsAbs, { withFileTypes: true });
  const iterate = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const abs = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) iterate(abs, r); continue; }
      if (e.isFile()) {
        if (r.split("/").some((seg) => SKIP_DIRS.has(seg))) continue;
        const ext = e.name.split(".").pop().toLowerCase();
        if (!LANG_BY_EXT[ext]) continue;
        let content;
        try {
          const st = fs.statSync(abs);
          if (st.size > MAX_FILE_BYTES) continue;
          content = fs.readFileSync(abs, "utf8");
        } catch (err) { continue; }
        if (!content || !content.trim()) continue;
        for (const c of chunkFile(r, content)) chunks.push(c);
      }
    }
  };
  iterate(wsAbs, "");

  // embedding（批量）
  let useVector = false;
  if (chunks.length) {
    const vecs = await embed(chunks.map((c) => c.text), cfg);
    if (vecs && vecs.length === chunks.length) {
      chunks.forEach((c, i) => (c.vec = vecs[i]));
      useVector = true;
    }
  }
  const meta = { ws: wsAbs, builtAt: Date.now(), useVector, count: chunks.length };
  const payload = { meta, chunks };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload), "utf8");
  } catch (e) { console.warn("[code-index] 持久化失败:", e.message); }
  const key = crypto.createHash("md5").update(wsAbs).digest("hex");
  _cache.set(key, payload);
  return { ok: true, count: chunks.length, useVector, file };
}

function getIndex(wsDir) {
  const wsAbs = path.resolve(wsDir);
  const key = crypto.createHash("md5").update(wsAbs).digest("hex");
  if (_cache.has(key)) return _cache.get(key);
  const raw = loadFromDisk(wsIndexFile(wsAbs));
  if (raw) { _cache.set(key, raw); return raw; }
  return null;
}

async function search({ wsDir, query, k = 8 }) {
  const idx = getIndex(wsDir);
  if (!idx || !idx.chunks || !idx.chunks.length) return { ok: false, reason: "索引不存在，请先构建", results: [] };
  const chunks = idx.chunks;
  let results;
  if (idx.meta.useVector) {
    const qvec = (await embed([query], { embedding: idx.meta.embedding })) || null;
    if (qvec && qvec[0]) {
      results = chunks
        .map((c) => ({ c, score: cosine(qvec[0], c.vec) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    }
  }
  if (!results) {
    const bm = buildBm25(chunks);
    const qt = tokenize(query);
    results = chunks
      .map((c, i) => ({ c, score: bm25Score(qt, bm.docs[i], bm) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
  return {
    ok: true,
    mode: idx.meta.useVector && results[0] && results[0].c.vec ? "vector" : "bm25",
    count: results.length,
    results: results.map((r) => ({
      path: r.c.path, startLine: r.c.startLine, endLine: r.c.endLine,
      title: r.c.title, score: Number(r.score.toFixed(4)),
      snippet: r.c.text.length > 600 ? r.c.text.slice(0, 600) + "\n…" : r.c.text,
    })),
  };
}

module.exports = { buildIndex, search, getIndex, chunkFile, langOfFile, metaOf };
