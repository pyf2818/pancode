/* ============================================================
   P1-B5 · 规则版本化（写前快照 / 列表 / 读取 / 回滚）

   为什么历史不能放在 .pancode/rules/ 里面：那个目录会被规则加载器
   递归扫成 .md 并作为硬约束喂给模型（server/rules.js: rootRuleFiles），
   历史版本混进去 = 把"上个月的那份规则"也一起注入，模型看到的是一份现在没人认领的混合体。
   所以另开一棵树：<数据根>/.pancode/rules-history/<slug>/<毫秒时间戳>-<动作>.md

   数据根用 configMod.ROOT（与审计、trace、用量同一来源），不是工作区。
   规则文件本体在工作区的 .pancode/rules —— 两套同名 `.pancode/` 是本项目的老坑，
   这里只有一份账本，写与读都走同一个函数，不留第二处拼路径的地方。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const configMod = require("./config");
const log = require("./logger");

const KEEP_PER_FILE = 20;          // 一条规则留 20 版：够用一年，也够把目录大小按住
const MAX_NAME = 96;               // slug 长度上限，防止超长文件名在 Windows 上撞 ENAMETOOLONG
const OPS = ["create", "update", "delete", "toggle", "restore", "pre-restore"];

function root() { return path.join(configMod.ROOT, ".pancode", "rules-history"); }

/* 规则文件名 → 目录名。规则名由 rulesLib.safeName 产出，这里仍做一遍白名单：
   历史目录名是拼出来的路径，输入来自 HTTP，不能指望上游一定干净。 */
function slugOf(file) {
  const base = path.posix.basename(String(file || "")).replace(/\.md$/i, "").toLowerCase();
  const s = base.replace(/[^a-z0-9._\-\u4e00-\u9fa5]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, MAX_NAME);
  return s || "unnamed";
}

function dirOf(file) { return path.join(root(), slugOf(file)); }

function snapshot(file, content, op) {
  if (!file || content == null) return null;
  const o = OPS.indexOf(String(op)) >= 0 ? String(op) : "update";
  const dir = dirOf(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
    /* 同一毫秒内的两次改动会撞同一个文件名（连改两次规则真能落到同一毫秒），
       撞了就是后一份把前一份顶掉——历史少一版，而且没有任何提示。往上找空位。 */
    let ts = Date.now();
    let p = path.join(dir, ts + "-" + o + ".md");
    while (fs.existsSync(p)) { ts++; p = path.join(dir, ts + "-" + o + ".md"); }
    fs.writeFileSync(p, String(content), "utf8");
    prune(file);
    return { ts, op: o, file: path.basename(p) };
  } catch (e) {
    /* 快照失败绝不能变成"规则写不成了"：历史是附加能力，
       拿它挡主流程等于为了保险箱把门焊死。落一条 warn 让人能发现。 */
    log.tag("rules").warn("规则历史快照失败（" + file + " · " + o + "）：" + e.message);
    return null;
  }
}

function list(file) {
  const dir = dirOf(file);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names.map((n) => {
    const m = /^(\d+)-([a-z\-]+)\.md$/.exec(n);
    if (!m) return null;
    let size = 0, mtime = 0;
    try { const st = fs.statSync(path.join(dir, n)); size = st.size; mtime = st.mtimeMs; } catch (e) { return null; }
    return { ts: Number(m[1]), op: m[2], size, mtime, name: n };
  }).filter(Boolean).sort((a, b) => b.ts - a.ts);
}

function read(file, ts) {
  const hit = list(file).find((v) => v.ts === Number(ts));
  if (!hit) return null;
  try { return { meta: hit, content: fs.readFileSync(path.join(dirOf(file), hit.name), "utf8") }; } catch (e) { return null; }
}

function prune(file, keep) {
  const k = Math.max(1, Number(keep) || KEEP_PER_FILE);
  const vs = list(file);
  vs.slice(k).forEach((v) => { try { fs.unlinkSync(path.join(dirOf(file), v.name)); } catch (e) {} });
  return Math.max(0, vs.length - k);
}

/* 所有有历史的规则文件（设置页"历史"入口用）：slug 目录名不等于原文件名，
   所以这里只报 slug 与版本数，具体名字由调用方拿规则清单去对。 */
function summary() {
  let dirs = [];
  try { dirs = fs.readdirSync(root(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) { return []; }
  return dirs.map((d) => ({ slug: d, versions: fs.readdirSync(path.join(root(), d)).length })).filter((x) => x.versions > 0);
}

/* 行级 diff（给"这一版和现在差在哪"用）。
   没有复用 tools/util 的 computeDiffLines：它只回"新增了哪几行的行号"，
   面板要的是能左右对照的行序列（+/- 各自带文本），所以这里自己做一份小 LCS。
   规则文件本来就短；超过 DIFF_MAX 行就不做精确 diff，回一个 tooBig 标记，
   让 UI 显示"改动较大，请直接看两份全文"，而不是把主线程卡在半分钟上。 */
const DIFF_MAX = 400;
function diffLines(before, after) {
  const b = String(before == null ? "" : before).replace(/\r/g, "").split("\n");
  const a = String(after == null ? "" : after).replace(/\r/g, "").split("\n");
  if (b.length > DIFF_MAX || a.length > DIFF_MAX) return { tooBig: true, lines: [], added: 0, removed: 0 };
  const m = b.length, n = a.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = b[i] === a[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < m && j < n) {
    if (b[i] === a[j]) { lines.push({ t: " ", text: b[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ t: "-", text: b[i] }); removed++; i++; }
    else { lines.push({ t: "+", text: a[j] }); added++; j++; }
  }
  while (i < m) { lines.push({ t: "-", text: b[i++] }); removed++; }
  while (j < n) { lines.push({ t: "+", text: a[j++] }); added++; }
  /* 全同的行没必要占面板：只留真正变了的部分（+/- 及其上下文一行） */
  const keep = lines.map((l, k) => ({ l, k })).filter(({ l, k }) => l.t !== " "
    || (lines[k - 1] && lines[k - 1].t !== " ") || (lines[k + 1] && lines[k + 1].t !== " ")).map(({ l }) => l);
  return { tooBig: false, lines: keep.length ? keep : lines, added, removed };
}

module.exports = { root, slugOf, dirOf, snapshot, list, read, prune, summary, diffLines, KEEP_PER_FILE, OPS };
