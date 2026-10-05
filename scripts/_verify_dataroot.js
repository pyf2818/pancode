/* ============================================================
   数据根指纹（scripts/_verify_dataroot.js）
   验收的不是产品功能，而是"这一串探针到底有没有偷写开发者真实的 .pancode"。

     node scripts/_verify_dataroot.js mark    # 测试链开跑前
     node scripts/_verify_dataroot.js check   # 全部探针跑完后

   为什么要有它：静态扫脚本只能看出"有没有拉起服务端"，看不出"绕开服务端把 mockConfig.ROOT
   指到仓库根"——实测 `_verify_tools` 就是这么每次改真实 .pancode/artifacts + memory 的（探针自己全绿，
   数据根已经在悄悄变）。指纹是结果导向的：谁写的、怎么写进来的，只要动了就报红。

   只读比对（大小 + mtime），不改不删。指纹落在系统临时目录，跟着探针一样不进仓库。
   ============================================================ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const DATA_ROOT = process.env.PANCODE_DATA_DIR || path.resolve(__dirname, "..");
const TARGET = path.join(DATA_ROOT, ".pancode");
const MARK_FILE = path.join(os.tmpdir(), "pc-dataroot-fingerprint.json");

function fingerprint(dir) {
  const lines = [];
  (function walk(d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try {
        const st = fs.statSync(p);
        lines.push(path.relative(dir, p) + "|" + st.size + "|" + st.mtimeMs.toFixed(0));
      } catch (err) {}
    }
  })(dir);
  lines.sort();
  return { files: lines.length, hash: crypto.createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16), list: lines };
}

const mode = process.argv[2];
if (mode === "mark") {
  const f = fingerprint(TARGET);
  fs.writeFileSync(MARK_FILE, JSON.stringify(f), "utf8");
  console.log("[dataroot] mark：" + f.files + " 个文件，指纹 " + f.hash + "（" + TARGET + "）");
  process.exit(0);
}

if (mode === "check") {
  let before = null;
  try { before = JSON.parse(fs.readFileSync(MARK_FILE, "utf8")); } catch (e) {}
  if (!before) {
    console.error("[dataroot] FAIL：没有 mark 记录（" + MARK_FILE + "）。测试链必须以 `...dataroot.js mark` 开头。");
    process.exit(1);
  }
  const now = fingerprint(TARGET);
  const was = new Map(before.list.map((l) => [l.split("|")[0], l]));
  const is = new Map(now.list.map((l) => [l.split("|")[0], l]));
  const changed = [];
  for (const [k, v] of is) { if (!was.has(k)) changed.push("新增  " + k); else if (was.get(k) !== v) changed.push("改动  " + k); }
  for (const k of was.keys()) if (!is.has(k)) changed.push("删除  " + k);
  if (changed.length) {
    console.error("[dataroot] FAIL：这一串探针动了真实数据根 " + TARGET + "（" + changed.length + " 处）");
    for (const c of changed.slice(0, 20)) console.error("    - " + c);
    if (changed.length > 20) console.error("    …另有 " + (changed.length - 20) + " 处");
    console.error("    两种可能：① 某个探针没设沙箱 → 让它第一行 require(\"./_sandbox\").create({tag:\"…\"})，见 scripts/_sandbox.js 头部两条硬规矩；");
    console.error("              ② 你自己正在跑的 pancode 实例（桌面端 / npm start）写的——看改动是不是落在 spill/、agent-traces/<userKey>/、tasks/、audit/ 这类活会话上。是的话先关掉实例再判。");
    process.exit(1);
  }
  console.log("[dataroot] check：真实数据根一字未动（" + now.files + " 个文件，指纹 " + now.hash + "）");
  process.exit(0);
}

console.error("用法：node scripts/_verify_dataroot.js mark|check");
process.exit(2);
