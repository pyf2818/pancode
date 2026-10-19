"use strict";
/* ============================================================
   截图落盘（浏览器 + 桌面共用一套）。

   为什么不写进工作区：截图是"给这一轮对话看的证据"，不是项目产物。
   落在工作区会被 Git 基线当成用户改动列进改动面板、被 /undo 的检查点体系误纳入、
   还得求用户 .gitignore —— 所以落数据根的 .pancode/shots/<会话>/，与 spill 同一套纪律。
   前端取图走 /api/shot?name=<相对路径>，只在这个目录内解析（basename 逐段校验），
   不放宽 /api/raw 的 WS_DIR 边界。
   ============================================================ */
const fs = require("fs");
const path = require("path");

const SUB = ".pancode";
const DIR_NAME = "shots";
const DEFAULT_TTL_DAYS = 7;
const MAX_NAME_LEN = 80;

function root() {
  return path.join(require("../config").ROOT, SUB, DIR_NAME);
}

/* 会话目录名：与 agent-llm 的 spill 目录同一套字符集（不含点）——
   留着点就可能出现纯 ".." 的会话名，拼出 shots 的上一级，等于把截图写进 .pancode 根。 */
function safeSeg(s, dflt) {
  const v = String(s == null ? "" : s).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return v || dflt;
}

/* 会话子目录：不存在就建。返回绝对路径。 */
function convDir(convId) {
  const dir = path.join(root(), safeSeg(convId, "default"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp() { return Date.now(); }

/* 给人看的文件名：模型可以传 name，一律洗过再拼（去掉路径分隔与 shell 特殊字符），
   时间戳打头防互相覆盖。中文保留 —— 前端取图时 encodeURIComponent，
   全洗成下划线只会让截图文件名变成一坨 ____。
   扩展名只认这四种：喂给模型时要用 jpeg（同样画面比 png 小一个数量级，
   直接决定一次像素往返要花多少 token），但绝不让模型把 ".exe" 之类拼进名字。 */
const IMG_EXTS = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" };
function fileName(name, ext) {
  const raw = String(name == null ? "" : name);
  const cleaned = raw
    .replace(/[\\/:*?"<>|#%&+'`$ {}\[\]()]/g, "")
    .replace(/\.+/g, ".")                                  // NTFS 会归一化尾点与连续点，别把这种字符留在名字里
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, MAX_NAME_LEN);
  const e = String(ext || "png").toLowerCase();
  if (e === "pdf") return stamp() + "-" + (cleaned || "shot") + ".pdf";
  return stamp() + "-" + (cleaned || "shot") + "." + (IMG_EXTS[e] ? e : "png");
}
function mimeOf(p) {
  const e = String(p || "").split(".").pop().toLowerCase();
  return IMG_EXTS[e] || "image/png";
}

/* 直接写字节（Electron desktopCapturer 走这条）。 */
function writeBuffer(buf, convId, name) {
  const abs = path.join(convDir(convId), fileName(name, "png"));
  fs.writeFileSync(abs, buf);
  return { abs, rel: path.relative(root(), abs).split(path.sep).join("/") };
}

/* agent-browser 自己写到了别处（它只认路径），再收进 shots 目录。 */
function adopt(absSrc, convId, name) {
  const abs = path.join(convDir(convId), fileName(name, path.extname(absSrc).slice(1)));
  try { fs.renameSync(absSrc, abs); }
  catch (e) { fs.copyFileSync(absSrc, abs); }
  return { abs, rel: path.relative(root(), abs).split(path.sep).join("/") };
}

/* /api/shot 用：只接受 shots 目录内的相对路径，任何 ../ 或绝对路径一律 null。 */
function resolveRel(rel) {
  const r = root();
  const abs = path.resolve(r, String(rel || "").replace(/^\/+/, ""));
  const norm = path.resolve(abs);
  if (norm !== r && !norm.startsWith(r + path.sep)) return null;
  try { return fs.statSync(norm).isFile() ? norm : null; } catch (e) { return null; }
}

/* 开机按 TTL 清理。与对话历史同一做法：只删超期的，不做"看起来没用了就删"的推断。 */
function prune(ttlDays) {
  const days = Number(ttlDays) > 0 ? Number(ttlDays) : DEFAULT_TTL_DAYS;
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  const r = root();
  let convs = [];
  try { convs = fs.readdirSync(r, { withFileTypes: true }); } catch (e) { return { removed: 0, root: r }; }
  for (const d of convs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(r, d.name);
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) { fs.unlinkSync(fp); removed++; }
      } catch (e) { /* 被占用就留给下次 */ }
    }
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch (e) { /* 非空或正被占用 */ }
  }
  return { removed, root: r };
}

module.exports = { root, convDir, fileName, mimeOf, writeBuffer, adopt, resolveRel, prune, DEFAULT_TTL_DAYS, DIR_NAME, SUB, IMG_EXTS };
