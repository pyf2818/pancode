/* ============================================================
   pancode 文件系统层 —— "文件是唯一真相"
   - 所有路径经过 safePath 防目录逃逸
   - 完整 CRUD：读 / 写 / 新建 / 删除 / 重命名 / 建目录
   - fs.watch 监听外部变更（编辑器外改文件也能同步到 UI）
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const { AppError } = require("./app-error");

const IGNORE = new Set([
  "node_modules", ".git", ".omc", ".workbuddy",
  "dist", "build", "out", "release", "coverage", "__pycache__",
  ".venv", "venv", ".idea", ".vscode", "target", ".next", ".nuxt",
]);
const MAX_FILE = 1024 * 1024;  // 1MB，超出视为二进制/大文件不进内存
const MAX_FILES = 500;         // 打开真实项目时最多进内存的文件数（防卡死）
const MAX_WATCH_DIRS = 200;    // fs.watch 监听目录上限
/* 按行区间读（read_file 精准取段的底座）用的三道闸，理由见 FileStore.readWindow */
const WINDOW_CHUNK = 256 * 1024;            // 每次从 fd 读多少字节
const WINDOW_MAX_CHARS = 2 * 1024 * 1024;   // 一次最多交出去的字符数，防止"取段"退化成"取整个文件"
const WINDOW_COUNT_MAX_SIZE = 8 * 1024 * 1024;  // 大于此文件不为"总行数"扫全篇，只报"行数未知"
const WINDOW_MAX_LINE_BYTES = 4 * 1024 * 1024;  // 单行字节上限：超过就是压缩产物，换行符压根不存在

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

/* ============================================================
   价值分层：决定「配额紧张时谁先出局」
   ------------------------------------------------------------
   分层依据不是文件大小，而是「对理解这个项目有没有用」：
     0 层 = 源码与配置（模型改代码真正要碰的东西）
     1 层 = 文档（人写的说明，有参考价值）
     2 层 = 其余文本（探针日志、构建清单、归档产物……）
   同层内按路径字典序，保证同一项目每次结果一致（可复现，不随 NTFS 目录项顺序漂移）。

   目录级降权（整棵子树压到 2 层）：产物目录、第三方库、探针沙箱。
   这些不是"垃圾"——read_file 照样能读——只是不该挤占发现入口的配额。
   ============================================================ */
const SOURCE_EXTS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte",
  "py", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cc", "cs", "rb", "php", "lua", "sh", "bash", "zsh", "ps1",
  "json", "jsonc", "yaml", "yml", "toml", "ini", "env", "conf", "cfg",
  "html", "htm", "css", "scss", "sass", "less",
  "sql", "graphql", "proto", "tf", "dockerfile", "makefile", "cmake",
]);
const DOC_EXTS = new Set(["md", "mdx", "txt", "rst", "adoc", "org"]);

/* 路径里出现这些片段 → 整棵子树降权（探针产物 / 第三方库目录的共同特征） */
const LOW_VALUE_PATH_HINTS = [
  /(^|\/)_verify_out(\/|$)/,
  /(^|\/)_sandbox(\/|$)/,
  /(^|\/)archive(\/|$)/,
  /(^|\/)artifacts?(\/|$)/,
  /(^|\/)vendor(\/|$)/,
  /(^|\/)dist(\/|$)/,
];

function classify(relPath) {
  const p = String(relPath);
  for (const re of LOW_VALUE_PATH_HINTS) if (re.test(p)) return 2;
  const name = p.split("/").pop().toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  // 无扩展名的配置文件（Makefile / Dockerfile / LICENSE）
  if (!ext) {
    if (/^(makefile|dockerfile|license|licence|readme|changelog|procfile|justfile|rakefile|gemfile)$/.test(name)) return 0;
    return 1;
  }
  if (SOURCE_EXTS.has(ext)) return 0;
  if (DOC_EXTS.has(ext)) return 1;
  return 2;
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
  constructor(wsDir, auditDir) {
    this.auditDir = auditDir || null; // W15：文件变更审计目录（.pancode/audit）
    this.dir = wsDir;
    this.watchers = new Map();   // dirPath -> fs.FSWatcher
    this.onExternalChange = null; // (relPath|null) => void
    this._selfWrites = new Map(); // relPath -> timestamp（忽略自身写入触发的 watch 事件）
    this._debounce = null;
    // 定时清理 _selfWrites，避免长跑内存只增不减（A4）
    this._sweepTimer = setInterval(() => this._sweepSelfWrites(), 5000);
    if (this._sweepTimer && this._sweepTimer.unref) this._sweepTimer.unref();
  }

  /* 定时清理 _selfWrites 中超过 5s 的条目（防止内存只增不减） */
  _sweepSelfWrites() {
    const now = Date.now();
    for (const [k, t] of this._selfWrites) {
      if (now - t > 5000) this._selfWrites.delete(k);
    }
  }

  /**
   * 防目录逃逸：任何 rel 路径必须解析到 workspace 内
   * @param {string} rel - 相对于 workspace 根的路径（支持正斜杠 / 反斜杠）
   * @returns {string} 解析后的绝对路径（保证在 this.dir 内）
   * @throws {Error} 路径为空 / 含 NULL 字节 / 越界逃逸
   */
  safePath(rel) {
    if (typeof rel !== "string" || !rel.length) throw new Error("路径不能为空");
    const norm = rel.replace(/\\/g, "/");
    if (norm.includes("\0")) throw new Error("非法路径");
    const abs = path.resolve(this.dir, norm);
    const root = path.resolve(this.dir);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("路径越界: " + rel);
    // 词法之外还要看真实路径：工作区里一个指向外部的软链（或 Windows junction），startsWith 是看不出来的
    if (this._escapesRoot(abs)) throw new Error("路径经由软链指向工作区外，已拒绝: " + rel);
    return abs;
  }

  _realRoot() {
    try { return fs.realpathSync(path.resolve(this.dir)); } catch (e) { return path.resolve(this.dir); }
  }

  /* abs 沿符号链接展开后是否落到根外。
     目标可能还不存在（新建文件），所以向上找第一个真实存在的祖先再解析；
     整条链都不存在时返回 false —— 那种情况已经被上面的词法判定挡住了。 */
  _escapesRoot(abs) {
    const rootReal = process.platform === "win32" ? this._realRoot().toLowerCase() : this._realRoot();
    let cur = abs;
    while (cur && cur !== path.dirname(cur)) {
      let real = null;
      try { real = fs.realpathSync(cur); } catch (e) { cur = path.dirname(cur); continue; }
      const r = process.platform === "win32" ? real.toLowerCase() : real;
      return r !== rootReal && !r.startsWith(rootReal + path.sep);
    }
    return false;
  }

  rel(abs) { return path.relative(this.dir, abs).replace(/\\/g, "/"); }

  /* W15：文件变更审计——所有写/删/改名操作落盘到 .pancode/audit/<日期>.log，可追溯。
     审计目录是**全根共用一份**（多根授权之后 N 个 FileStore 写同一个日志），
     所以每一行必须带上自己那个根：否则"A 项目里的 src/a.js"和"B 项目里的 src/a.js"
     在日志里长得一模一样，事后无法回答"到底改了哪个项目"。 */
  _audit(actor, action, rel) {
    if (!this.auditDir) return;
    try {
      fs.mkdirSync(this.auditDir, { recursive: true });
      const f = path.join(this.auditDir, new Date().toISOString().slice(0, 10) + ".log");
      const line = new Date().toISOString() + " | " + actor + " | " + action + " | " + String(rel).replace(/\r?\n/g, " ") +
        " | root=" + path.resolve(this.dir) + "\n";
      fs.appendFileSync(f, line);
    } catch (e) {}
  }

  /* ============================================================
     列出工作区文件（配额受限）
     ------------------------------------------------------------
     两阶段：先收集全量候选，再按价值分层取前 MAX_FILES。
     旧实现是「边走边停」——撞满 500 就 return，谁被截断取决于
     readdirSync 的原始返回顺序（NTFS 目录项顺序），于是：
       · 同一项目在不同机器/不同时间看到的文件树可能不一样；
       · 配额被「产物目录 + 第三方库」这类低价值文件抢光，
         源码目录整个消失（实测 server/ 与 test/ 曾因此完全不可见）。

     现在改成：
       · 收集阶段设硬上限 MAX_SCAN，避免超大仓库把遍历拖死；
       · 排序键 = (价值层级, 路径字典序) —— 同层内字典序保证可复现；
       · 返回仍是排序后的相对路径数组，truncated 语义不变。
     ============================================================ */
  list(sub) {
    const base = sub ? this.safePath(sub) : this.dir;
    const out = [];
    this.truncated = false;
    /* 收集阶段的硬上限：仓库大到几十万文件时不能全遍历。
       超出即标记 truncated —— 与旧语义一致（"有内容没列全"）。 */
    const MAX_SCAN = 20000;
    let scanned = 0;
    let overflow = false;

    const walk = (dir, prefix) => {
      if (overflow) return;
      let names;
      try { names = fs.readdirSync(dir); } catch (e) { return; }
      /* 目录项排序：收集顺序稳定，配合后面的字典序兜底，
         保证同一工作区每次 list() 的候选集完全一致。 */
      names.sort();
      for (const name of names) {
        if (overflow) return;
        if (isIgnored(name)) continue;
        const full = path.join(dir, name);
        const r = prefix ? prefix + "/" + name : name;
        let st;
        try { st = fs.lstatSync(full); } catch (e) { continue; }
        // 不跟随软链：既挡住"根内软链指向根外"被列出来再读，也避免自引用软链把遍历绕死
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { walk(full, r); continue; }
        if (st.size > MAX_FILE) continue;
        if (++scanned > MAX_SCAN) { overflow = true; return; }
        out.push(r);
      }
    };
    walk(base, sub || "");

    /* 价值分层排序：0 源码/配置 → 1 文档 → 2 其余。
       同层按路径字典序，取前 MAX_FILES。 */
    out.sort((a, b) => {
      const ca = classify(a), cb = classify(b);
      if (ca !== cb) return ca - cb;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    if (out.length > MAX_FILES) { this.truncated = true; return out.slice(0, MAX_FILES).sort(); }
    if (overflow) this.truncated = true;
    return out.sort();
  }

  /* 我们拒绝触碰的路径（含软链逃逸）一律按"不存在"回答，而不是把异常抛给调用方 */
  exists(rel) {
    try { return fs.existsSync(this.safePath(rel)); } catch (e) { return false; }
  }

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
    if (st.size > MAX_FILE) throw new AppError("FILE_TOO_LARGE", "文件过大（>1MB）: " + rel, "文件超过 1MB 限制，无法作为文本打开。请使用专用编辑器查看。");
    if (this.isBinary(rel)) throw new AppError("FILE_BINARY", "二进制文件无法作为文本打开: " + rel, "该文件为二进制格式（图片/压缩包等），不能作为文本编辑。");
    return fs.readFileSync(abs, "utf8");
  }

  /* 按行区间读一段。startLine 从 1 起算，lineCount 为要读的行数。
     为什么不复用 read() 再切片：read() 有 1MB 硬顶、且必须整份进内存，
     而"只想要第 300~400 行"的恰恰就是那种撑破 1MB 的大文件——
     于是它以前要么被 FILE_TOO_LARGE 挡回来，要么全文塞进上下文再被头尾截断砍掉中段。
     这里改用 fd 分块扫行：只留窗口内的几十行，其余连内存都不进。
     返回 { lines, startLine, endLine, totalLines, sizeBytes, charCapped, hasMore }。
     totalLines 为 null 表示"没数"（文件 >8MB 且已经取到段，不为一个行数把全篇再扫一遍）。 */
  readWindow(rel, opts) {
    const start = Math.max(1, Math.floor(Number(opts && opts.startLine) || 1));
    const count = Math.max(1, Math.floor(Number(opts && opts.lineCount) || 200));
    const abs = this.safePath(rel);
    const st = fs.statSync(abs);
    if (this.isBinary(rel)) throw new AppError("FILE_BINARY", "二进制文件无法作为文本打开: " + rel, "该文件为二进制格式（图片/压缩包等），不能作为文本编辑。");
    const wantTotal = st.size <= WINDOW_COUNT_MAX_SIZE;
    const out = [];
    let chars = 0;
    let charCapped = false;
    let lineNo = 0;
    let pos = 0;
    let stoppedEarly = false;
    let leftover = Buffer.alloc(0);
    const fd = fs.openSync(abs, "r");
    try {
      for (;;) {
        const chunk = Buffer.alloc(WINDOW_CHUNK);
        const n = fs.readSync(fd, chunk, 0, WINDOW_CHUNK, pos);
        pos += n;
        const eof = n === 0;
        const buf = n ? Buffer.concat([leftover, chunk.slice(0, n)]) : leftover;
        let idx = 0;
        let nl;
        while ((nl = buf.indexOf(0x0a, idx)) !== -1) {
          const raw = buf.slice(idx, nl);
          idx = nl + 1;
          lineNo++;
          if (lineNo >= start && lineNo < start + count && !charCapped) {
            // 原样交出去：不剥 \r、不剥 BOM。取段结果必须等于整读的对应切片，
            // 否则模型照它写 apply_edit 的 old_string 会"逐字"失败（本仓源码就是全 CRLF）。
            const s = raw.toString("utf8");
            if (chars + s.length + 1 > WINDOW_MAX_CHARS) charCapped = true;
            else { out.push(s); chars += s.length + 1; }
          }
          // 取到段就收工：不为一个"共多少行"把 30MB 的文件扫完（那时 totalLines 直说没数）
          if (out.length >= count && !wantTotal) { stoppedEarly = true; break; }
        }
        leftover = buf.slice(idx);
        if (eof || stoppedEarly) break;
        if (leftover.length > WINDOW_MAX_LINE_BYTES) {
          throw new AppError("FILE_ONE_LINE_TOO_LONG", "单行超过 " + Math.round(WINDOW_MAX_LINE_BYTES / 1024 / 1024) + "MB: " + rel,
            "这多半是压缩产物（整份文件没有换行）。按行取段读不了，请改用 search_code 找关键片段。");
        }
      }
      if (!stoppedEarly && leftover.length) {
        // 末行没有换行符也要算一行 —— 窗口已经读满时同样得数它，
        // 否则"共 60000 行"会报成 59999，模型据此判断的"还差几段"就是错的。
        lineNo++;
        if (!charCapped && out.length < count && lineNo >= start) {
          const s = leftover.toString("utf8");   // 同样原样保留（见上面的 CRLF 说明）
          if (chars + s.length + 1 <= WINDOW_MAX_CHARS) { out.push(s); chars += s.length + 1; }
          else charCapped = true;
        }
      }
    } finally {
      try { fs.closeSync(fd); } catch (e) { /* 已关或被关闭流程抢了 */ }
    }
    const last = out.length ? start + out.length - 1 : 0;
    return {
      lines: out,
      startLine: out.length ? start : 0,
      endLine: last,
      /* 只有"取到段就提前收工"时才算没数完全篇 —— 那时 lineNo 是半截，报出去就是假总数。
         字符闸挡下时其实已经扫到 EOF，总数是真数出来的，不能一并说成未知。 */
      totalLines: stoppedEarly ? null : lineNo,
      sizeBytes: st.size,
      charCapped,
      hasMore: charCapped || stoppedEarly || lineNo >= start + out.length,
    };
  }

  write(rel, content) {
    // 防线：绝不用文本内容覆盖二进制文件（会直接损坏 Word/图片等）
    if (this.exists(rel) && this.isBinary(rel)) {
      throw new AppError("FILE_BINARY", "二进制文件不能以文本方式保存（防止损坏）: " + rel, "该文件为二进制格式，不能以文本方式保存。");
    }
    const abs = this.safePath(rel);
    this._audit("fs", "write", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    this._selfWrites.set(rel.replace(/\\/g, "/"), Date.now());
    this._binCache && this._binCache.delete(rel.replace(/\\/g, "/"));
    fs.writeFileSync(abs, content, "utf8");
  }

  create(rel, content) {
    if (this.exists(rel)) throw new AppError("FILE_EXISTS", "文件已存在: " + rel, "目标路径已有同名文件，请改名后重试。");
    this.write(rel, content || "");
  }

  mkdir(rel) {
    fs.mkdirSync(this.safePath(rel), { recursive: true });
  }

  /* 删除前先搬进回收站，而不是直接 rm -rf。
     原来「误删 = 真没了」：编辑器里一次 deleteDir 就 recursive 掉整棵目录树，
     而 AI 那边的 undo 检查点只在 agent 层、纯内存、重启即丢（见 _pushCheckpoint）。

     回收站位置从 auditDir 反推：auditDir = <数据根>/.pancode/audit，
     于是垃圾箱落在 <数据根>/.pancode/trash —— 在**工作区之外**（不会被 list()/repo_map
     当项目文件索引进去），又在数据根之内（跟着 pancode 的数据一起搬家，多根共用一份）。
     绝不放在工作区的父目录：那会在"工作区 = C:\ 或家目录"时直接写到盘根上。 */
  _trashDir() {
    const base = this.auditDir ? path.dirname(path.resolve(this.auditDir)) : null;
    if (base) return path.join(base, "trash");
    /* 兜底也绝不放工作区内 —— 那会让垃圾箱自己出现在用户的工作区文件树里。
       退到系统临时目录，进程重启后仍在（可恢复性略降，但不会污染项目）。 */
    return path.join(require("os").tmpdir(), "pancode-trash-" + this._trashRootKey());
  }

  /* 多根共用一份垃圾箱，所以条目名里必须带根标识 ——
     否则 "A 项目里的 src/a.js" 和 "B 项目里的 src/a.js" 恢复回去就是错的目录。
     与 _audit 那条注释是同一个理由。 */
  _trashRootKey() {
    const r = path.resolve(this.dir);
    let h = 5381;
    for (let i = 0; i < r.length; i++) h = ((h * 33) ^ r.charCodeAt(i)) >>> 0;
    return h.toString(36).slice(0, 6);
  }

  /* 回收站是补救措施，不能反过来变成"因为垃圾箱满了所以文件删不掉"：
     搬移失败时退回原地删除，把 ok=false 如实返回给调用方审计。 */
  _toTrash(abs, rel) {
    const base = this._trashDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let dest = path.join(base, stamp + "__" + this._trashRootKey() + "__" + this._trashEncode(rel));
    try {
      fs.mkdirSync(base, { recursive: true });
      let n = 1;
      while (fs.existsSync(dest)) {
        dest = path.join(base, stamp + "__" + this._trashRootKey() + "__" + n + "_" + this._trashEncode(rel));
        n++;
      }
      fs.renameSync(abs, dest);
      return { ok: true, dest };
    } catch (e) {
      /* 跨设备（rename EXDEV）等情况：拷贝后再删原体，语义等价于搬走 */
      try {
        fs.cpSync(abs, dest, { recursive: true });
        fs.rmSync(abs, { recursive: true, force: true });
        return { ok: true, dest };
      } catch (e2) { return { ok: false }; }
    }
  }

  /* 条目名里的路径部分必须**无损可逆** —— 曾经把 "src/a.js" 压成 "src_a.js"，
     结果 restore 只能还原出一个躺在工作区根的同名文件，目录结构全丢。
     斜杠/反斜杠编码成分隔符（%2F / %5C），其余字符原样保留，仍能被人眼读懂。 */
  _trashEncode(rel) {
    return String(rel).replace(/%/g, "%25").replace(/\//g, "%2F").replace(/\\/g, "%5C");
  }

  /* 反解条目名：<stamp>__<rootKey>__[<n>_]<encodedRel>。
     序号只可能出现在 encodedRel 的开头（数字 + 下划线），且编码后的路径首字符
     不会是数字下划线组合，所以剥一次即可 —— 但用 ^\\d+_ 只剥一层，
     因为 "1_src/a.js" 与 "1/2/x.js" 两种原名都要能还原。 */
  _trashRel(name) {
    const parts = String(name || "").split("__");
    if (parts.length < 3) return null;
    const body = parts.slice(2).join("__").replace(/^\d+_/, "");
    let rel;
    try { rel = decodeURIComponent(body); } catch (e) { return null; }
    return rel || null;
  }

  remove(rel) {
    const abs = this.safePath(rel);
    if (abs === path.resolve(this.dir)) throw new AppError("ROOT_DELETE", "不能删除工作区根目录", "无法删除工作区根目录。");
    this._audit("fs", "remove", rel);
    const st = fs.statSync(abs);
    this._selfWrites.set(rel.replace(/\\/g, "/"), Date.now());
    this._binCache && this._binCache.delete(rel.replace(/\\/g, "/"));
    const tr = this._toTrash(abs, rel);
    if (tr.ok) return { recycled: true, trash: path.basename(tr.dest) };
    if (st.isDirectory()) fs.rmSync(abs, { recursive: true });
    else fs.unlinkSync(abs);
    return { recycled: false };
  }

  /* 从回收站恢复（服务端接口；前端未接 UI，先让能力可测、可脚本化） */
  restore(trashName) {
    const base = this._trashDir();
    const root = path.resolve(base);
    const real = path.resolve(base, String(trashName || ""));
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error("非法回收站条目");
    if (!fs.existsSync(real)) throw new Error("回收站里没有这个条目: " + trashName);
    const rel = this._trashRel(path.basename(real));
    if (!rel) throw new Error("回收站条目名不可解析: " + trashName);
    const dest = this.safePath(rel);
    if (fs.existsSync(dest)) throw new Error("原位置已被占用，未恢复: " + rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(real, dest);
    this._selfWrites.set(rel.replace(/\\/g, "/"), Date.now());
    this._audit("fs", "restore", rel);
    return { restored: rel };
  }

  listTrash() {
    const base = this._trashDir();
    let names = [];
    try { names = fs.readdirSync(base); } catch (e) { return []; }
    const key = this._trashRootKey();
    const out = [];
    for (const n of names) {
      let st = null;
      try { st = fs.statSync(path.join(base, n)); } catch (e) {}
      const parts = n.split("__");
      out.push({ name: n, dir: !!(st && st.isDirectory()), mtime: st ? st.mtimeMs : 0,
                 rel: this._trashRel(n), mine: parts[1] === key });
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  rename(rel, relNew) {
    const from = this.safePath(rel), to = this.safePath(relNew);
    this._audit("fs", "rename", rel + " -> " + relNew);
    if (fs.existsSync(to)) throw new Error("目标已存在: " + relNew);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    this._selfWrites.set(rel.replace(/\\/g, "/"), Date.now());
    this._binCache && this._binCache.delete(rel.replace(/\\/g, "/"));
    this._selfWrites.set(relNew.replace(/\\/g, "/"), Date.now());
    this._binCache && this._binCache.delete(relNew.replace(/\\/g, "/"));
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
  /* 回调收到的是一批相对路径（防抖窗口内所有事件的并集）。
     以前只把最后一个 rel 传出去，而调用方拿到也不看，直接全量重读 ≤500 个文件再整包广播；
     八小时任务里测试/格式化这类外部改盘很频繁，等于每 120ms 防抖到期就全文重读一遍。
     空串代表"这条事件说不清改了谁"（fs.watch 有时会只给目录事件），调用方必须据此走全量。 */
  startWatch(onChange) {
    this.onExternalChange = onChange;
    this._pendingChanges = new Set();
    const watchDir = (dir) => {
      if (this.watchers.has(dir) || this.watchers.size >= MAX_WATCH_DIRS) return;
      let w;
      try {
        w = fs.watch(dir, (eventType, fname) => {
          if (fname && isIgnored(String(fname).split(/[\\/]/)[0])) return;
          const rel = fname ? this.rel(path.join(dir, String(fname))) : null;
          // 忽略 2 秒内自身写入
          if (rel && this._selfWrites.has(rel) && Date.now() - this._selfWrites.get(rel) < 2000) return;
          this._pendingChanges.add(rel || "");
          clearTimeout(this._debounce);
          this._debounce = setTimeout(() => {
            // 目录结构可能变化，重扫并补挂监听
            this._watchAllDirs(watchDir);
            if (this.onExternalChange) {
              const batch = Array.from(this._pendingChanges);
              this._pendingChanges = new Set();
              this.onExternalChange(batch);
            }
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
    if (this._sweepTimer) { clearInterval(this._sweepTimer); this._sweepTimer = null; }
    for (const w of this.watchers.values()) { try { w.close(); } catch (e) {} }
    this.watchers.clear();
  }
}

module.exports = { FileStore, langOf, isBinaryPath };
