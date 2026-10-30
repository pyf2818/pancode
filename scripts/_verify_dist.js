/* ============================================================
   F21 验收：发行脚本要把"缺东西"变成失败
   ————————————————————————————————————————————————————
   改之前的两条静默放行（都是原话，不是我推测的）：
     · scripts/dist.js：拷回**至少一个**产物就继续 —— 于是"主包没出、只有 blockmap"
       这种半截构建会绿着走出打包这一步；
     · scripts/_verify_pkg.js：找不到 exe 时打一行 SKIP 然后 exit 0 —— 于是"验包"这一步
       在没有包的情况下也是绿的，等于这道闸从未合过。
   这一支不跑真打包（那要几分钟且要干净工作树），它验的是抽出来的收口逻辑
   scripts/dist-artifacts.js 与两个脚本的口径本身：
     ① 缺件必须失败，并且不许写清单；
     ② 齐件才写清单，清单里的哈希/字节数/版本/commit 要真；
     ③ 产物被改动要能被清单对出来（这就是"验的是不是刚打的那一份"）；
     ④ 两条旧口径不许回退（源码级）；
     ⑤ 真跑 _verify_pkg 的缺件分支：发行门禁下非零退出，普通模式打「未测」且 0 退出。
   全程只在临时目录里动手，不碰 release/、不碰真数据根。
   用法：node scripts/_verify_dist.js
   ============================================================ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DA = require("./dist-artifacts");

let pass = 0, fail = 0;
const fails = [];
const metrics = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }
function measure(name, value, unit) { metrics.push({ name, value: String(value), unit }); console.log("  \x1b[36m◦\x1b[0m " + name + "：\x1b[1m" + value + "\x1b[0m " + unit); }
const J = (v) => { try { return JSON.stringify(v === undefined ? "<undefined>" : v).slice(0, 300); } catch (e) { return String(v).slice(0, 300); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pancode-dist-probe-"));
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const EXPECTED = [
  "pancode Setup " + version + ".exe",
  "pancode Setup " + version + ".exe.blockmap",
  "latest.yml",
];

/* 在临时 outDir 里铺产物；count 小于 3 就是"半截构建" */
function fakeBuildDir(tag, count) {
  const dir = path.join(tmp, tag);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, EXPECTED[i]), "payload-" + tag + "-" + i + "-" + "x".repeat(64), "utf8");
  }
  return dir;
}

try {
  section("① 缺件必须失败，而且不许写清单（半截构建不能绿着走出这一步）");
  const rel1 = path.join(tmp, "rel-half");
  const half = fakeBuildDir("half", 2);            // 主包出了、blockmap 出了、latest.yml 没出
  const gotHalf = DA.collectArtifacts({ outDir: half, rel: rel1, expected: EXPECTED });
  measure("半截构建：拷回", gotHalf.artifacts.length, "个 / 预期 " + EXPECTED.length + " 个");
  measure("半截构建：缺失", gotHalf.missing.length, "个 — " + gotHalf.missing.join("、"));
  ok("缺了就是缺了：missing 里如实列出", gotHalf.missing.length === 1 && gotHalf.missing[0] === EXPECTED[2], J(gotHalf.missing));
  /* 阳性对照：旧规则"至少拷回一个就算成功"在同一份铺排上会判通过 ——
     这正是这次要修的静默放行。 */
  const oldRuleWouldPass = gotHalf.artifacts.length >= 1;
  ok("旧口径（拷回至少一个即成功）在这份半截铺排上会放行 —— 所以新口径必须拦",
    oldRuleWouldPass && gotHalf.missing.length > 0, J({ 旧: oldRuleWouldPass, 缺: gotHalf.missing }));
  ok("齐件之前不许写清单（dist.js 在 missing 时直接 exit，不调 writeManifest）",
    !fs.existsSync(path.join(rel1, "build-manifest.json")), "清单已存在，说明半截构建也留下了记号");

  section("② 齐件才写清单，清单里的数要真");
  const rel2 = path.join(tmp, "rel-full");
  const full = fakeBuildDir("full", 3);
  const gotFull = DA.collectArtifacts({ outDir: full, rel: rel2, expected: EXPECTED });
  const mf = DA.buildManifest({
    version, sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    worktreeClean: true, dirtyFiles: 0,
    electronBuilder: "26.0.0", lockfile: { file: "package-lock.json", sha256: DA.sha256(path.join(full, EXPECTED[0])) },
    buildDir: full, artifacts: gotFull.artifacts,
  });
  const mfPath = DA.writeManifest(rel2, mf);
  measure("齐件：拷回", gotFull.artifacts.length, "个，缺失 " + gotFull.missing.length + " 个");
  ok("齐件时 missing 为空", gotFull.missing.length === 0, J(gotFull.missing));
  const back = DA.readManifest(rel2);
  ok("清单读得回来且条数对得上", !!back && back.artifacts.length === 3, J(back && back.artifacts.length));
  ok("清单里每个产物的 sha256 都等于盘上重算的值",
    back.artifacts.every((a) => a.sha256 === DA.sha256(path.join(rel2, a.file))),
    J(back.artifacts.map((a) => a.file + ":" + (a.sha256 === DA.sha256(path.join(rel2, a.file)) ? "同" : "异"))));
  ok("清单里每个产物的字节数都等于盘上的",
    back.artifacts.every((a) => a.bytes === fs.statSync(path.join(rel2, a.file)).size), "");
  ok("清单记了版本与来源 commit", back.version === version && /^[0-9a-f]{40}$/.test(String(back.sourceCommit)),
    J({ version: back.version, commit: back.sourceCommit }));
  ok("清单记了 lock 的哈希（依赖口径可追）", !!(back.lockfile && back.lockfile.sha256 && /^[0-9a-f]{64}$/.test(back.lockfile.sha256)), J(back.lockfile));
  /* 依赖清单要"声明 + 实装"两个版本都有 —— 只记声明的那一份答不出包里到底是哪一版。 */
  const depsModHasIt = /deps:\s*o\.deps\s*\|\|\s*null/.test(fs.readFileSync(path.join(ROOT, "scripts", "dist-artifacts.js"), "utf8"));
  const distHasCollector = /installedDeps\(\)/.test(fs.readFileSync(path.join(ROOT, "scripts", "dist.js"), "utf8"));
  ok("发行清单里带依赖清单（声明版本 + 实装版本）", depsModHasIt && distHasCollector,
    J({ distArtifacts: depsModHasIt, dist: distHasCollector }));
  void mfPath;

  section("③ 产物被改动要能被清单对出来");
  const target = path.join(rel2, EXPECTED[0]);
  const before = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, before.replace("payload-", "PAYL0D-"), "utf8");
  const drift = back.artifacts.filter((a) => a.sha256 !== DA.sha256(path.join(rel2, a.file))).map((a) => a.file);
  ok("改一个字节，清单对账就抓到（这就是「验的是不是刚打的那一份」）",
    drift.length === 1 && drift[0] === EXPECTED[0], J(drift));
  fs.writeFileSync(target, before, "utf8");
  ok("改回去之后又对得上（判据不是永远红）",
    back.artifacts.every((a) => a.sha256 === DA.sha256(path.join(rel2, a.file))), "");

  section("④ 两条旧口径不许回退（源码级）");
  const distSrc = fs.readFileSync(path.join(ROOT, "scripts", "dist.js"), "utf8");
  const pkgSrc = fs.readFileSync(path.join(ROOT, "scripts", "_verify_pkg.js"), "utf8");
  ok("dist.js 里不再有「拷回至少一个就继续」的写法", !/if \(!copied\)/.test(distSrc) && !/copied\+\+/.test(distSrc), "");
  ok("dist.js 缺件时是 exit 非零", /missing\.length[\s\S]{0,200}process\.exit\(1\)/.test(distSrc), "");
  ok("dist.js 用固定全局临时目录的老写法已删（每次构建独立目录）",
    !/const OUT = path\.join\(os\.tmpdir\(\), "pancode-dist-build"\);/.test(distSrc) && /pancode-dist-build-/.test(distSrc), "");
  ok("dist.js 发行模式要求干净工作树（脏树只能 --dev）",
    /DEV_BUILD[\s\S]{0,240}process\.exit\(1\)/.test(distSrc), "");
  /* 而且这条要在起 electron-builder **之前**：第一版写在产物收口之后，
     实测白跑一次四分钟的打包才报"树不干净" —— 要拒的构建别先花四分钟再拒。 */
  const atRefuse = distSrc.indexOf("发行构建要求工作树干净");
  const atBuild = distSrc.indexOf('electron-builder", "cli.js"');
  ok("脏树拒绝发生在起构建之前（不烧那四分钟）",
    atRefuse > -1 && atBuild > -1 && atRefuse < atBuild, J({ 拒绝位置: atRefuse, 起构建位置: atBuild }));
  ok("dist.js 找不到解包目录也算失败，不是「手动传路径」",
    /没找到解包目录[\s\S]{0,200}process\.exit\(1\)/.test(distSrc), "");

  section("⑤ _verify_pkg 的缺件语义：门禁下红，普通模式下如实「未测」");
  const emptyDir = path.join(tmp, "no-artifact");
  fs.mkdirSync(emptyDir, { recursive: true });
  const gate = spawnSync(process.execPath, [path.join(ROOT, "scripts", "_verify_pkg.js"), emptyDir], {
    cwd: ROOT, encoding: "utf8", env: Object.assign({}, process.env, { PANCODE_RELEASE: "1" }), timeout: 60000,
  });
  const gateOut = (gate.stdout || "") + (gate.stderr || "");
  measure("发行门禁下的退出码", gate.status, "");
  ok("发行门禁：缺件必须非零退出（不能再 exit 0）", gate.status !== 0, J({ status: gate.status, out: gateOut.slice(-200) }));
  ok("发行门禁：话说清楚是缺件", /缺件/.test(gateOut), gateOut.slice(-200));
  const soft = spawnSync(process.execPath, [path.join(ROOT, "scripts", "_verify_pkg.js"), emptyDir], {
    cwd: ROOT, encoding: "utf8", env: Object.assign({}, process.env, { PANCODE_RELEASE: "" }), timeout: 60000,
  });
  const softOut = (soft.stdout || "") + (soft.stderr || "");
  measure("普通模式的退出码", soft.status, "");
  ok("普通模式：没包时 0 退出（CI 不被拖红），但必须写「未测」而不是「通过」",
    soft.status === 0 && /未测/.test(softOut) && !/^\s*PASS/m.test(softOut), J({ status: soft.status, out: softOut.slice(-220) }));
  ok("普通模式：结论行给出机器可读的 0 条判据（通过率分母里不含它）",
    /共 0 条，红 0 条/.test(softOut), softOut.slice(-220));
  /* 正向对照：真有一份"看着像产物"的 exe 时，这一支会往下跑（这里只验它不再把缺件当成通过，
     不重复起真应用）——用一句源码断言兜住：缺件分支之后才建临时数据目录。 */
  ok("缺件分支排在任何真启动之前（不会先起进程再说没起）",
    pkgSrc.indexOf("未测（SKIP）") < pkgSrc.indexOf("fs.mkdtempSync"), "");

  console.log("\n\x1b[1m量到的数\x1b[0m");
  for (const m of metrics) console.log("  " + m.name + " = " + m.value + " " + m.unit);
  console.log("\n共 " + (pass + fail) + " 条，红 " + fail + " 条");
  if (fail) { console.log("\n失败明细："); fails.forEach((f, i) => console.log("  " + (i + 1) + ". " + f)); }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch (e) {}
}
process.exit(fail ? 1 : 0);
