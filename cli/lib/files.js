/* ============================================================
   pancode-cli · 文件系统层（自包含版）
   - safePath 防目录逃逸
   - 读/写/列目录/搜索
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const IGNORE = new Set([
  "node_modules", ".git", ".omc", ".workbuddy",
  "dist", "build", "out", "release", "coverage", "__pycache__",
  ".venv", "venv", ".idea", ".vscode", "target", ".next", ".nuxt",
]);

const BINARY_EXTS = new Set([
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf",
  "zip", "rar", "7z", "gz", "tar", "bz2", "xz", "jar", "war",
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "tif", "tiff", "psd",
  "mp3", "wav", "flac", "ogg", "mp4", "avi", "mkv", "mov", "webm",
  "ttf", "otf", "woff", "woff2", "eot",
  "exe", "dll", "so", "dylib", "bin", "class", "pyc", "pyd", "wasm",
  "db", "sqlite", "sqlite3", "mdb", "pak", "dat", "iso", "img",
]);

const MAX_FILE = 1024 * 1024;  // 1MB

function isBinaryPath(p) {
  const name = String(p).split(/[\\/]/).pop();
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return false;
  return BINARY_EXTS.has(name.slice(idx + 1).toLowerCase());
}

function sniffBinary(absPath) {
  let fd;
  try {
    fd = fs.openSync(absPath, "r");
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } catch (e) { return false; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {} }
}

function isIgnored(name) {
  return IGNORE.has(name) || (name.startsWith(".") && name !== ".gitignore" && name !== ".env.example");
}

const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/* 工作区根的 realpath：两侧都过一遍 realpath，才不会因为大小写盘符、
   8.3 短名、目录 junction 这些"同一个目录两种写法"把合法路径判成越界。 */
function realRootOf(root) {
  try { return fs.realpathSync(root); } catch (e) { return root; }
}

/* 从 abs 往下找到"真实存在的最深一段"取 realpath，缺失的尾巴单独带回来。
   直接 realpathSync(abs) 对新建文件必然 ENOENT —— 那正是"新文件"和
   "指向不存在目标的悬空链接"要区分开的地方，不能一律宽松放行。 */
function realpathNearest(abs) {
  let cur = abs;
  const missing = [];
  for (;;) {
    try { return { real: fs.realpathSync(cur), missing }; } catch (e) {}
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    missing.unshift(path.basename(cur));
    cur = parent;
  }
}

function escapeError(rel) {
  return new Error("路径越界: " + rel + " 不在工作区内");
}

function safePath(root, rel) {
  /* 防目录逃逸。两道判据，缺一不可：
     1) 字符串层：先 path.resolve 规范化再比。原先绝对路径分支直接用 rel 原样，
        于是 <root>\..\outside.txt 这种"绝对但带父目录片段"的写法能过 startsWith
        （审查项 F05 实测：读到过界文件）。resolve 会把 .. 折掉，绝对/相对统一走同一条。
     2) 落点层：符号链接让字符串判据形同虚设 —— root/link.txt -> ../outside.txt
        字符串在界内，open() 却跟着链走。所以对已存在部分取 realpath 再判一次。 */
  const normalizedRoot = path.resolve(root);
  const abs = path.resolve(normalizedRoot, rel == null ? "." : String(rel));
  if (!within(abs, normalizedRoot)) throw escapeError(rel);
  const rr = realRootOf(normalizedRoot);
  const probe = realpathNearest(abs);
  if (probe) {
    const realAbs = probe.missing.length ? path.resolve(probe.real, ...probe.missing) : probe.real;
    if (!within(realAbs, rr)) throw escapeError(rel);
  }
  return abs;
}

/* 写/删之前单独看叶子自己：悬空符号链接（指向不存在目标的链）在上面那道
   realpath 判据里会退到父目录、被判为"界内"，随后 writeFileSync 顺着链
   在界外把文件创建出来。lstat 不跟链，正好用来把这一类挑出来拒绝掉。
   注意这只覆盖"叶子本身是链"；父目录是链已由 realpath 那道判据管住。 */
function assertWritableLeaf(abs, rel) {
  let st;
  try { st = fs.lstatSync(abs); } catch (e) { return; }   // 不存在 = 新建，没有链可跟
  if (st.isSymbolicLink()) throw new Error("路径越界: " + rel + " 是符号链接，CLI 不顺着链写/删");
}

function langOf(p) {
  const ext = String(p).split(".").pop().toLowerCase();
  const map = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
    cs: "csharp", rb: "ruby", php: "php", lua: "lua",
    sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", html: "html", css: "css", scss: "scss",
    vue: "vue", svelte: "svelte",
  };
  return map[ext] || "text";
}

/* ---------- FileStore ---------- */
class FileStore {
  constructor(root) {
    this.root = path.resolve(root);
  }

  list(dir) {
    const abs = safePath(this.root, dir || ".");
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const result = [];
    for (const e of entries) {
      if (isIgnored(e.name)) continue;
      result.push({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
        path: path.relative(this.root, path.join(abs, e.name)).replace(/\\/g, "/"),
      });
    }
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return result;
  }

  read(relPath, opts) {
    opts = opts || {};
    const abs = safePath(this.root, relPath);
    if (!fs.existsSync(abs)) throw new Error("文件不存在: " + relPath);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) throw new Error("是目录不是文件: " + relPath);
    if (stat.size > MAX_FILE && !opts.force) {
      /* 大文件：只读前 400 行 */
      const text = fs.readFileSync(abs, "utf8");
      const lines = text.split("\n");
      return {
        content: lines.slice(0, 400).join("\n"),
        truncated: true,
        totalLines: lines.length,
        shownLines: 400,
      };
    }
    if (isBinaryPath(abs) || sniffBinary(abs)) {
      return { content: "[二进制文件，不显示内容]", binary: true };
    }
    const content = fs.readFileSync(abs, "utf8");
    if (opts.startLine || opts.endLine) {
      const lines = content.split("\n");
      const start = (opts.startLine || 1) - 1;
      const end = opts.endLine || (start + 400);
      return {
        content: lines.slice(start, end).join("\n"),
        totalLines: lines.length,
        shownLines: end - start,
        startLine: start + 1,
      };
    }
    return { content, totalLines: content.split("\n").length };
  }

  write(relPath, content) {
    const abs = safePath(this.root, relPath);
    assertWritableLeaf(abs, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return { path: relPath, bytes: Buffer.byteLength(content) };
  }

  delete(relPath) {
    const abs = safePath(this.root, relPath);
    assertWritableLeaf(abs, relPath);
    if (!fs.existsSync(abs)) throw new Error("文件不存在: " + relPath);
    fs.unlinkSync(abs);
    return { path: relPath };
  }

  search(query, opts) {
    opts = opts || {};
    const abs = safePath(this.root, opts.path || ".");
    const results = [];
    const maxResults = opts.maxResults || 50;
    const regex = query.startsWith("/") && query.endsWith("/")
      ? new RegExp(query.slice(1, -1), "i")
      : null;
    const needle = regex ? null : query.toLowerCase();

    /* 必须是箭头函数：原先是普通函数 + walk.call(this, abs, 0)，
       顶层这一调用把 this 传进去了，递归那句 walk(full, depth + 1) 却没有 ——
       子目录里 path.relative(this.root, full) 抛 TypeError，又被下面那个空 catch 吞掉，
       表现是"根目录的命中能出、子目录的命中全丢"（审查项 F11 实测：2 处命中只回 1 处）。 */
    const walk = (dir, depth) => {
      if (depth > 8 || results.length >= maxResults) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        /* 上限要在每一轮开头就判：只在函数入口判一次的话，从子目录带着一身命中
           return 回来后，本层还会继续把剩下的文件扫下去 —— maxResults 就成了
           "大概这么多"而不是"最多这么多"。 */
        if (results.length >= maxResults) return;
        if (isIgnored(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (e.isFile()) {
          if (isBinaryPath(full)) continue;
          try {
            const text = fs.readFileSync(full, "utf8");
            const lines = text.split("\n");
            for (let i = 0; i < lines.length; i++) {
              const match = regex ? regex.test(lines[i]) : lines[i].toLowerCase().includes(needle);
              if (match) {
                results.push({
                  file: path.relative(this.root, full).replace(/\\/g, "/"),
                  line: i + 1,
                  text: lines[i].trim().slice(0, 200),
                });
                if (results.length >= maxResults) return;
              }
            }
          } catch (e) { /* skip */ }
        }
      }
    };
    walk(abs, 0);
    return results;
  }
}

module.exports = { FileStore, safePath, isBinaryPath, isIgnored, langOf };
