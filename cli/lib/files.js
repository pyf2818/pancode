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

function safePath(root, rel) {
  /* 防目录逃逸：确保解析后的路径在 root 内 */
  const abs = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
  const normalizedRoot = path.resolve(root);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + path.sep)) {
    throw new Error("路径越界: " + rel + " 不在工作区内");
  }
  return abs;
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
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return { path: relPath, bytes: Buffer.byteLength(content) };
  }

  delete(relPath) {
    const abs = safePath(this.root, relPath);
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

    function walk(dir, depth) {
      if (depth > 8 || results.length >= maxResults) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
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
    }
    walk.call(this, abs, 0);
    return results;
  }
}

module.exports = { FileStore, safePath, isBinaryPath, isIgnored, langOf };
