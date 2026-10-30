"use strict";
/* ============================================================
   发行产物收口（F21）：把"缺东西"从日志提示变成非零退出
   ————————————————————————————————————————————————————
   这段逻辑原来直接长在 scripts/dist.js 里，跑在真 electron-builder 之后 ——
   于是它没法在没有安装包的情况下被测：要测就得等一次几分钟的打包，
   而且"少拷回一个产物也算成功"这种规则本身就没被任何判据问过。
   抽出来之后，探针拿临时目录铺一份"半截构建"就能验：
     · 缺件必须失败（并且不许写清单，避免下一次 _verify_pkg 验到旧包）；
     · 齐件才写 release/build-manifest.json，里面带 sha256 / 字节数 / 来源 commit / 工作树是否干净；
     · 发行模式（非 --dev）遇到脏树直接拒。
   dist.js 只做"起构建 + 调这里 + 留解包记号"。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/* 把 expected 里的每个产物从 outDir 收进 rel。
   返回 { artifacts, missing } —— 是不是要失败由调用方决定（dist.js 里是"当场 exit 1"），
   这样探针可以直接对返回值下判据，不用去 parse 日志。 */
function collectArtifacts({ outDir, rel, expected }) {
  const artifacts = [];
  const missing = [];
  for (const f of expected) {
    const src = path.join(outDir, f);
    if (!fs.existsSync(src)) { missing.push(f); continue; }
    const dest = path.join(rel, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    artifacts.push({ file: f, bytes: fs.statSync(dest).size, sha256: sha256(dest) });
  }
  return { artifacts, missing };
}

/* 构建清单：这一份 exe 到底是哪一版代码 + 哪一份 lock 打出来的。
   sourceCommit 取不到（不在 git 里跑）时写 null，_verify_pkg.js 会据此判红而不是默认通过。 */
function buildManifest(o) {
  return {
    product: "pancode",
    version: o.version,
    builtAt: new Date().toISOString(),
    sourceCommit: o.sourceCommit || null,
    worktreeClean: o.worktreeClean === true,
    dirtyFiles: o.dirtyFiles || 0,
    dirtySample: o.dirtySample || [],
    node: process.version,
    electronBuilder: o.electronBuilder || null,
    lockfile: o.lockfile || null,
    /* 依赖清单：声明版本 + 实装版本一起留，"这个包里是哪一版 ws"才答得出（F20-6） */
    deps: o.deps || null,
    buildDir: o.buildDir,
    artifacts: o.artifacts,
  };
}

function writeManifest(rel, manifest) {
  fs.mkdirSync(rel, { recursive: true });
  const p = path.join(rel, "build-manifest.json");
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return p;
}

/* 清单自取（读不到就返回 null，让调用方决定是"未测"还是红） */
function readManifest(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(rel, "build-manifest.json"), "utf8")); }
  catch (e) { return null; }
}

module.exports = { sha256, collectArtifacts, buildManifest, writeManifest, readManifest };
