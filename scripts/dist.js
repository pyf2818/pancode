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

   F21 之后又收紧了三件事（都属"缺东西必须失败"，不是"缺东西提示一下"）：
     · 每次构建一个独立中间目录（原先是全局固定名 pancode-dist-build）：
       两个构建同时跑会互相清对方的半成品，症状是"偶发的 rename 失败"，查起来最费时间。
     · 预期产物按清单逐个核对，少一个就非零退出（原先只要至少拷回一个就算成功，
       于是"Setup.exe 没出来、只有 blockmap"也能绿着走出这一步）。
     · 生成 release/build-manifest.json：版本、来源 commit、工作树干净与否、
       每个产物的 sha256 与字节数、依赖清单（lock）的哈希。
       _verify_pkg.js 拿它对账 —— 这样"验的是不是刚打的那一份"才有依据。
   ============================================================ */
"use strict";
const { spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const version = require(path.join(REPO, "package.json")).version;
const REL = path.join(REPO, "release");
/* 本次构建是否算"发行构建"：默认是。--dev 只是本地试打包，允许树脏、允许留半成品。 */
const DEV_BUILD = process.argv.includes("--dev");

function log(...a) { console.log(...a); }
function git(args) {
  try { return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch (e) { return ""; }
}

/* 每次构建独占一个中间目录：名字里带版本、时间戳、pid，谁也不碰谁的。
   旧的目录不再主动清（清别人的正在写的树就是上面那个偶发 rename 失败的成因），
   交给系统临时目录的自然回收，以及 --gc 手动回收。 */
function freshOutDir() {
  const dir = path.join(os.tmpdir(), "pancode-dist-build-" + version + "-" + Date.now() + "-" + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const outDir = freshOutDir();
log("• 打包中间目录（工作区外，避开文件监听句柄）: " + outDir);

/* 来源标记先取、发行口径先判：**要拒的构建别先花四分钟再拒**。
   第一版把这条放在产物收口之后，实测白跑了一次完整打包才报"工作树不干净"。 */
const head = git(["rev-parse", "HEAD"]);
const dirty = git(["status", "--porcelain=v1"]).split(/\r?\n/).filter(Boolean);
if (!DEV_BUILD && dirty.length) {
  log("✗ 发行构建要求工作树干净（本次有 " + dirty.length + " 处改动），一开始就不跑，不等到最后。");
  log("  先提交，或本地试打包用：node scripts/dist.js --dev");
  try { fs.rmdirSync(outDir); } catch (e) {}
  process.exit(1);
}

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

/* 预期产物清单：少任何一个都是失败，不是"提示一下继续"。
   以前这里是"拷回至少一个就往下走"，于是最常见的半截构建（NSIS 主包没出、只留下
   blockmap 或 latest.yml）会被当成成功，直到装机时才暴露。
   收口逻辑抽在 scripts/dist-artifacts.js —— 那样探针能拿临时目录直接验"缺件必须红"，
   不必等一次几分钟的真打包。 */
fs.mkdirSync(REL, { recursive: true });
const DA = require("./dist-artifacts");
const wanted = [
  "pancode Setup " + version + ".exe",
  "pancode Setup " + version + ".exe.blockmap",
  "latest.yml",
];
const got = DA.collectArtifacts({ outDir, rel: REL, expected: wanted });
for (const a of got.artifacts) log("  → release/" + a.file + "（" + Math.round(a.bytes / 1048576) + " MB，sha256 " + a.sha256.slice(0, 12) + "…）");
if (got.missing.length) {
  log("\n✗ 预期产物缺失 " + got.missing.length + " 个：" + got.missing.join("、"));
  log("  中间产物留在 " + outDir + " —— 这次构建不算完成，清单也不写（免得下一次验包验到旧的那份）。");
  process.exit(1);
}

/* 来源标记：commit + 工作树是否干净 + 依赖清单哈希。
   脏树不是错误（本地天天在改），但"发行"用的是脏树就必须留在清单里，
   好让 _verify_pkg.js 与后面看包的人知道这份二进制对应的是哪一版代码。 */
/* 依赖清单：声明的版本 + 实际装上去的版本一起记。
   只看 package.json 答不了"这个包里塞的是哪一版 ws"，而发行要能回答这一问。 */
function installedDeps() {
  const pkg = require(path.join(REPO, "package.json"));
  const rows = [];
  for (const field of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(pkg[field] || {})) {
      let installed = null;
      try { installed = require(path.join(REPO, "node_modules", name, "package.json")).version; } catch (e) { installed = null; }
      rows.push({ name, declared: pkg[field][name], installed, kind: field });
    }
  }
  return { direct: rows.length, resolved: rows.filter((r) => r.installed).length, packages: rows };
}

const lockPath = path.join(REPO, "package-lock.json");
const manifest = DA.buildManifest({
  version, sourceCommit: head,
  worktreeClean: dirty.length === 0, dirtyFiles: dirty.length,
  dirtySample: dirty.slice(0, 12).map((l) => l.slice(3)),
  electronBuilder: (() => { try { return require(path.join(REPO, "node_modules", "electron-builder", "package.json")).version; } catch (e) { return null; } })(),
  lockfile: fs.existsSync(lockPath) ? { file: "package-lock.json", sha256: DA.sha256(lockPath) } : null,
  deps: installedDeps(),
  buildDir: outDir, artifacts: got.artifacts,
});
const mfPath = DA.writeManifest(REL, manifest);
log("  → " + path.relative(REPO, mfPath) + "（commit " + (head ? head.slice(0, 8) : "取不到") + (DEV_BUILD ? "，--dev 允许脏树" : "，工作树干净") + "）");

/* 解包目录留在临时区（拷回 release/ 就是重新踩监听的坑）；给探针留个记号。
   记号写不进清单就算了 —— _verify_pkg.js 找不到解包目录时按"未测"处理，不报通过。 */
const unpacked = path.join(outDir, "win-unpacked");
if (fs.existsSync(unpacked)) {
  fs.writeFileSync(path.join(REL, ".unpacked-path"), unpacked + "\n", "utf8");
  log("  → release/.unpacked-path = " + unpacked);
} else {
  log("\n✗ 没找到解包目录 " + unpacked + "：B 段（包内内容核对）没有可验的对象，这次构建不算完成");
  try { fs.rmSync(path.join(REL, ".unpacked-path"), { force: true }); } catch (e) {}
  process.exit(1);
}
log("完成：v" + version + "，产物 " + got.artifacts.length + " 个，清单 release/build-manifest.json");
