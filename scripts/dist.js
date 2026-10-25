/* ============================================================
   打包（scripts/dist.js）—— 为什么不让 electron-builder 直接写 release/
   ------------------------------------------------------------
   electron-builder 的 Windows 流程是：先在 <output>/win-unpacked.tmp 里铺好整棵
   应用树，再删掉旧的 win-unpacked、把 .tmp 改名过去。改名/删除要求树里没有任何
   文件被别的进程以"不许删"的方式打开着。

   实测（2026-10-15）：IDE（Qoder，用 Restart Manager 查到的 pid 与进程名）会打开
   工作区里新出现的 release/win-unpacked.tmp/resources/default_app.asar 并一直握着
   句柄，于是 npm run dist 连续两次分别卡在
     ⨯ EPERM: rename 'release\win-unpacked.tmp' -> 'release\win-unpacked'
     ⨯ EBUSY: unlink 'release\win-unpacked.tmp\resources\default_app.asar'
   而且那个删不掉的 .tmp 会让**之后每一次**打包都失败（它先要清掉同名残留）。

   这里把中间产物放到工作区外（系统临时目录，不在任何监听根里），跑完只把
   安装包和一份"解包目录在哪"的记号带回 release/。_verify_pkg.js 读这个记号。
   ============================================================ */
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const version = require(path.join(REPO, "package.json")).version;
const OUT = path.join(os.tmpdir(), "pancode-dist-build");
const REL = path.join(REPO, "release");

function log(...a) { console.log(...a); }

/* 清空上一次的中间产物；被占用时不抛错——大不了换个新目录（下面会带版本号的子目录） */
function freshOutDir() {
  try { fs.rmSync(OUT, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); }
  catch (e) { log("  （清不掉 " + OUT + "：" + e.code + "，改用带时间戳的新目录）"); }
  const dir = fs.existsSync(OUT) && fs.readdirSync(OUT).length ? OUT + "-" + Date.now() : OUT;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function copyInto(from, to) {
  fs.copyFileSync(from, to);
  return fs.statSync(to).size;
}

const outDir = freshOutDir();
log("• 打包中间目录（工作区外，避开文件监听句柄）: " + outDir);

/* 打包进程同样不能带 ELECTRON_RUN_AS_NODE：electron-builder 内部会起 Electron
   做 asar 整合，那一步若被当成纯 Node 跑就会出怪问题。
   这个变量在部分工具链环境里是默认存在的，属于必须主动清掉的污染。 */
const buildEnv = Object.assign({}, process.env);
delete buildEnv.ELECTRON_RUN_AS_NODE;

const r = spawnSync(process.execPath, [
  path.join(REPO, "node_modules", "electron-builder", "cli.js"),
  "--win", "nsis",
  "-c.directories.output=" + outDir,
], { cwd: REPO, stdio: "inherit", windowsHide: true, env: buildEnv });

if (r.status !== 0) {
  log("\n✗ electron-builder 退出码 " + (r.status == null ? "?" : r.status) + "（中间产物留在 " + outDir + "）");
  process.exit(r.status == null ? 1 : r.status);
}

fs.mkdirSync(REL, { recursive: true });
const wanted = [
  "pancode Setup " + version + ".exe",
  "pancode Setup " + version + ".exe.blockmap",
  "latest.yml",
];
let copied = 0;
for (const f of wanted) {
  const src = path.join(outDir, f);
  if (!fs.existsSync(src)) { log("  ! 没找到产物 " + f); continue; }
  const size = copyInto(src, path.join(REL, f));
  log("  → release/" + f + "（" + Math.round(size / 1048576) + " MB）");
  copied++;
}
if (!copied) { log("\n✗ 一个产物都没拷回来，检查 " + outDir); process.exit(1); }

/* 解包目录留在临时区（拷回 release/ 就是重新踩监听的坑）；给探针留个记号 */
const unpacked = path.join(outDir, "win-unpacked");
if (fs.existsSync(unpacked)) {
  fs.writeFileSync(path.join(REL, ".unpacked-path"), unpacked + "\n", "utf8");
  log("  → release/.unpacked-path = " + unpacked);
  log("\n下一步验包体：node scripts/_verify_pkg.js   （会自动读这个记号）");
} else {
  log("  ! " + unpacked + " 不存在，_verify_pkg.js 需要手动传路径");
}
log("完成：v" + version);
