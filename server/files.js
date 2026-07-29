/* ============================================================
   pancode 文件系统层 —— "文件是唯一真相"
   - 所有路径经过 safePath 防目录逃逸
   - 完整 CRUD：读 / 写 / 新建 / 删除 / 重命名 / 建目录
   - fs.watch 监听外部变更（编辑器外改文件也能同步到 UI）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const IGNORE = new Set([
  "node_modules", ".git", ".omc", ".workbuddy",
  "dist", "build", "out", "release", "coverage", "__pycache__",
  ".venv", "venv", ".idea", ".vscode", "target", ".next", ".nuxt",
]);
const MAX_FILE = 1024 * 1024;  // 1MB，超出视为二进制/大文件不进内存
const MAX_FILES = 500;         // 打开真实项目时最多进内存的文件数（防卡死）
const MAX_WATCH_DIRS = 200;    // fs.watch 监听目录上限

/* 已知二进制扩展名：按 UTF-8 读必然乱码，且误存会直接损坏文件 */
const BINARY_EXTS = new Set([
  // Office / 文档
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf", "wps", "et", "dps", "odt", "ods", "odp",
  // 压缩包
  "zip", "rar", "7z", "gz", "tar", "bz2", "xz", "jar", "war",
  // 图片 / 音视频 / 字体
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "tif", "tiff", "psd",
  "mp3", "wav", "flac", "ogg", "mp4", "avi", "mkv", "mov", "webm",
  "ttf", "otf", "woff", "woff2", "eot",
  // 可执行 / 库 / 数据
  "exe", "dll", "so", "dylib", "bin", "class", "pyc", "pyd", "wasm",
  "db", "sqlite", "sqlite3", "mdb", "pak", "dat", "iso", "img",
]);

function isBinaryPath(p) {
  const name = String(p).split(/[\\/]/).pop();
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return false;
  return BINARY_EXTS.has(name.slice(idx + 1).toLowerCase());
}

/* 内容嗅探：前 512 字节含 NUL 字节 → 视为二进制（兜住无扩展名/未知扩展名） */
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

function langOf(p) {
  const ext = p.split(".").pop().toLowerCase();
  return {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    json: "json", html: "html", htm: "html", css: "css", scss: "scss",
    md: "markdown", py: "python", sh: "shell", yml: "yaml", yaml: "yaml",
    txt: "plaintext", gitignore: "plaintext",
  }[ext] || "plaintext";
}

class FileStore {
  constructor(wsDir) {
    this.dir = wsDir;
    this.watchers = new Map();   // dirPath -> fs.FSWatcher
    this.onExternalChange = null; // (relPath|null) => void
    this._selfWrites = new Map(); // relPath -> timestamp（忽略自身写入触发的 watch 事件）
    this._debounce = null;
  }

  /* 防目录逃逸：任何 rel 路径必须解析到 workspace 内 */
  safePath(rel) {
    if (typeof rel !== "string" || !rel.length) throw new Error("路径不能为空");
    const norm = rel.replace(/\\/g, "/");
    if (norm.includes("\0")) throw new Error("非法路径");
    const abs = path.resolve(this.dir, norm);
    const root = path.resolve(this.dir);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("路径越界: " + rel);
    return abs;
  }

  rel(abs) { return path.relative(this.dir, abs).replace(/\\/g, "/"); }

  list(sub) {
    const base = sub ? this.safePath(sub) : this.dir;
    const out = [];
    this.truncated = false;
    const walk = (dir, prefix) => {
      if (out.length >= MAX_FILES) { this.truncated = true; return; }
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { return; }
      for (const name of names) {
        if (out.length >= MAX_FILES) { this.truncated = true; return; }
        if (isIgnored(name)) continue;
        const full = path.join(dir, name);
        const r = prefix ? prefix + "/" + name : name;
        let st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (st.isDirectory()) walk(full, r);
        else if (st.size <= MAX_FILE) out.push(r);
      }
    };
    walk(base, sub || "");
    return out.sort();
  }

  exists(rel) { return fs.existsSync(this.safePath(rel)); }

  /* 是否二进制文件：扩展名 + 内容嗅探双保险，结果缓存 */
  isBinary(rel) {
    const key = rel.replace(/\\/g, "/");
    if (!this._binCache) this._binCache = new Map();
    if (this._binCache.has(key)) return this._binCache.get(key);
    let bin = isBinaryPath(rel);
    if (!bin) { try { bin = sniffBinary(this.safePath(rel)); } catch (e) {} }
    this._binCache.set(key, bin);
    return bin;
  }

  read(rel) {
    const abs = this.safePath(rel);
    const st = fs.statSync(abs);
    if (st.size > MAX_FILE) throw new Error("文件过大（>1MB）: " + rel);
    if (this.isBinary(rel)) throw new Error("二进制文件无法作为文本打开: " + rel);
    return fs.readFileSync(abs, "utf8");
  }

  write(rel, content) {
    // 防线：绝不用文本内容覆盖二进制文件（会直接损坏 Word/图片等）
    if (this.exists(rel) && this.isBinary(rel)) {
      throw new Error("二进制文件不能以文本方式保存（防止损坏）: " + rel);
    }
    const abs = this.safePath(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    this._selfWrites.set(rel.replace(/\\/g, "/"), Date.now());
    this._binCache && this._binCache.delete(rel.replace(/\\/g, "/"));
    fs.writeFileSync(abs, content, "utf8");
  }

  create(rel, content) {
    if (this.exists(rel)) throw new Error("文件已存在: " + rel);
    this.write(rel, content || "");
  }

  mkdir(rel) {
    fs.mkdirSync(this.safePath(rel), { recursive: true });
  }

  remove(rel) {
    const abs = this.safePath(rel);
    if (abs === path.resolve(this.dir)) throw new Error("不能删除工作区根目录");
    const st = fs.statSync(abs);
    this._selfWrites.set(rel.replace(/\\/g, "/"), Date.now());
    if (st.isDirectory()) fs.rmSync(abs, { recursive: true });
    else fs.unlinkSync(abs);
  }

  rename(rel, relNew) {
    const from = this.safePath(rel), to = this.safePath(relNew);
    if (fs.existsSync(to)) throw new Error("目标已存在: " + relNew);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    this._selfWrites.set(rel.replace(/\\/g, "/"), Date.now());
    this._selfWrites.set(relNew.replace(/\\/g, "/"), Date.now());
    fs.renameSync(from, to);
  }

  /* 全文搜索（服务端真实搜索，替代前端内存搜索） */
  search(query, maxResults) {
    const q = String(query || "").toLowerCase();
    const results = [];
    if (q.length < 2) return results;
    for (const rel of this.list()) {
      if (this.isBinary(rel)) continue;
      let text;
      try { text = this.read(rel); } catch (e) { continue; }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const idx = lines[i].toLowerCase().indexOf(q);
        if (idx >= 0) {
          results.push({ path: rel, line: i + 1, col: idx + 1, text: lines[i].slice(0, 300) });
          if (results.length >= (maxResults || 200)) return results;
        }
      }
    }
    return results;
  }

  /* ---------- 外部变更监听 ---------- */
  startWatch(onChange) {
    this.onExternalChange = onChange;
    const watchDir = (dir) => {
      if (this.watchers.has(dir) || this.watchers.size >= MAX_WATCH_DIRS) return;
      let w;
      try {
        w = fs.watch(dir, (eventType, fname) => {
          if (fname && isIgnored(String(fname).split(/[\\/]/)[0])) return;
          const rel = fname ? this.rel(path.join(dir, String(fname))) : null;
          // 忽略 2 秒内自身写入
          if (rel && this._selfWrites.has(rel) && Date.now() - this._selfWrites.get(rel) < 2000) return;
          clearTimeout(this._debounce);
          this._debounce = setTimeout(() => {
            // 目录结构可能变化，重扫并补挂监听
            this._watchAllDirs(watchDir);
            if (this.onExternalChange) this.onExternalChange(rel);
          }, 120);
        });
        w.on("error", () => {});
        this.watchers.set(dir, w);
      } catch (e) { /* 目录可能已删除 */ }
    };
    this._watchAllDirs(watchDir);
  }

  _watchAllDirs(watchDir) {
    watchDir(this.dir);
    const walk = (dir) => {
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { return; }
      for (const name of names) {
        if (isIgnored(name)) continue;
        const full = path.join(dir, name);
        try { if (fs.statSync(full).isDirectory()) { watchDir(full); walk(full); } } catch (e) {}
      }
    };
    walk(this.dir);
  }

  stopWatch() {
    for (const w of this.watchers.values()) { try { w.close(); } catch (e) {} }
    this.watchers.clear();
  }
}

module.exports = { FileStore, langOf, isBinaryPath };
