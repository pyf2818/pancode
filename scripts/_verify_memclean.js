/* ============================================================
   长期记忆一次性清理（#31 的收尾：把已经躺在库里的垃圾请出去）
   用法：
     node scripts/_verify_memclean.js            # 只报告，不动盘（默认）
     node scripts/_verify_memclean.js --apply    # 先备份再降级，然后 prune() 归档
     node scripts/_verify_memclean.js --apply --scope user   # 连用户级库一起清

   为什么需要它：写入端与读取端的闸门已经修好（新垃圾进不来），但存量垃圾还在库里。
   更麻烦的是它们手里有两道免检：
     · valueScore ≥ 4 ⇒ isSticky ⇒ prune() 直接 continue，永远裁不掉；
     · 强度 ≈ 4 ⇒ 高于归档线 2.5，也够不上删除线。
   两头都不沾，所以面板上点「立即整理」对这批条目完全无效——这是实测出来的。

   做什么（只降级，不删除）：
     命中判据的条目 valueScore 压到 3、清掉 sticky，让它们重新回到衰减与裁剪的通道里；
     然后跑一次 prune()，按现行规则该归档的归档。原文一条都不删，
     每个分片先落一份 .pre-clean-<ts>.bak，回滚就是拷回去。
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");

const { MemoryStore, decayWeight, isJunkPhrase } = require("../server/memory-store");

const APPLY = process.argv.includes("--apply");
const ALSO_USER = process.argv.includes("--scope");      // --scope user：连用户级库一起过一遍
const ROOT = process.env.PANCODE_DATA_DIR || path.resolve(__dirname, "..");
const MEM_DIR = path.join(ROOT, ".pancode", "memory");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

/* 判据（与 memory-store.isJunkPhrase 同源，别在脚本里再抄一份句式表）：
   ① 主题栏就是用户当时的原话/问句 —— 这是"读进来全是垃圾"最直观的那一半；
   ② 自动沉淀(evolution)却拿到 ≥4 分 —— 拿到就等于免检，本不该发生。 */
function junkReason(e) {
  const topic = String(e.topic || "");
  if (topic && isJunkPhrase(topic, 1)) return "主题是用户原话/问句";
  if (e.source === "evolution" && (e.valueScore || 0) >= 4) return "自动沉淀却拿到免检分(≥4)";
  return "";
}

function shards() {
  const out = [];
  if (!fs.existsSync(MEM_DIR)) return out;
  for (const f of fs.readdirSync(MEM_DIR)) {
    if (!f.endsWith(".json")) continue;                       // .bak / .tmp / .corrupt-* 一律不碰
    if (f === "user.json" && !ALSO_USER) continue;            // 用户级默认不动（那是跨项目偏好，判据不同）
    out.push(path.join(MEM_DIR, f));
  }
  return out;
}

/* 只读地看一个分片：绝不 new MemoryStore(p)——构造会 prune() 并写回别的分片（同 searchAll 的约束）。
   要动盘的那个分片才走真实实例（它的写入路径与线上一致，含 saveJson 排队落盘）。 */
function inspect(file) {
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return { entries: [], error: e.message }; }
  if (!Array.isArray(entries)) return { entries: [], error: "not-an-array" };
  const live = entries.filter((e) => !e.archived);
  return {
    entries,
    total: entries.length,
    live: live.length,
    /* 名字别说满：这只是"过了强度地板的候选数"，真进上下文还要再过
       同主题 ≤2 与总量 ≤10 两道闸。旧名 willInject 让我把 37→37 读成"清理没效果"，
       也把这条断言的语义带偏了。 */
    candidates: live.filter((e) => decayWeight(e) >= 1.5).length,
    hits: entries.filter(junkReason),
    byReason: entries.reduce((m, e) => {
      const r = junkReason(e);
      if (r) m[r] = (m[r] || 0) + 1;
      return m;
    }, {}),
  };
}

function clean(file) {
  const store = new MemoryStore(file);          // 构造即 prune 一次，与线上启动行为一致
  const demoted = [];
  for (const e of store.list({ archived: "all", limit: 5000 })) {
    if (!junkReason(e)) continue;
    store.update(e.id, { valueScore: Math.min(e.valueScore || 2, 3), sticky: false });
    demoted.push({ id: e.id, topic: e.topic, reason: junkReason(e) });
  }
  const r = store.prune();
  return { demoted, pruned: r };
}

console.log("数据根：" + ROOT);
console.log("记忆目录：" + MEM_DIR);
console.log(APPLY ? "\x1b[33m模式：--apply（会先备份再改）\x1b[0m" : "模式：只报告，不动盘（加 --apply 才真改）");

const files = shards();
section("① 逐个分片体检");
if (!files.length) console.log("  （没找到任何 .json 分片）");
let totalHits = 0, totalCand = 0;
for (const f of files) {
  const s = inspect(f);
  totalCand += s.candidates || 0;
  totalHits += (s.hits || []).length;
  console.log("  " + path.basename(f) + "：" + (s.error ? "读不了（" + s.error + "）"
    : "共 " + s.total + " 条 / 未归档 " + s.live + " / 过强度地板的候选 " + s.candidates
      + " / 命中清理判据 " + s.hits.length
      + (Object.keys(s.byReason).length ? "  " + JSON.stringify(s.byReason) : "")));
}

section("② 判据本身要站得住（反向自证）");
ok("「启动项目」「项目有没有问题」这类主题会被判成垃圾",
  isJunkPhrase("启动项目", 1) && isJunkPhrase("项目有没有问题", 1));
ok("「探针数据根」「打包降级」这类名词短语不会被误判",
  !isJunkPhrase("探针数据根", 1) && !isJunkPhrase("打包降级", 1));
ok("用户级库默认不动（跨项目偏好的判据不一样）",
  !files.some((f) => path.basename(f) === "user.json") || ALSO_USER);

if (!APPLY) {
  console.log("\n未改动任何文件。命中 " + totalHits + " 条，其中过强度地板的候选共 " + totalCand + " 条。");
  console.log("确认判据没问题后：node scripts/_verify_memclean.js --apply");
  process.exit(0);
}

section("③ 落盘（先备份）");
const ts = new Date().toISOString().replace(/[:.]/g, "-");
/* ⚠ 必须等落盘再断言。`MemoryStore._save()` 走 `safe-write` 的**异步串行队列**
   （Windows 上目标被杀软/句柄锁住时还会 100→2400ms 退避重试），脚本原来在 clean() 之后
   同步 `inspect()` 就读到了**旧内容**，末尾 `process.exit()` 又把排着没跑的写一并丢掉。
   实测第一次 --apply 等于白跑：报告"降级 46 条 / 归档 7 / 删除 12"，
   重跑时对同一批分片又报了一遍一模一样的数字——盘上根本没变。
   现在：等盘上真的没有免检项为止（上限 12s），断言只看**读回来的内容**。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readBack(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; } }
function immuneOf(arr) {
  return (Array.isArray(arr) ? arr : []).filter((e) =>
    junkReason(e) && (Number(e.valueScore || 0) >= 4 || e.sticky));
}
async function waitSaved(file, ms) {
  const t0 = Date.now();
  let got = null;
  while (Date.now() - t0 < ms) {
    got = readBack(file);
    if (got && immuneOf(got).length === 0) return got;
    await sleep(120);
  }
  return got;
}

(async () => {
for (const f of files) {
  const s = inspect(f);
  if (!s.hits || !s.hits.length) { console.log("  " + path.basename(f) + "：没有命中的条目，跳过"); continue; }
  const bak = f + ".pre-clean-" + ts + ".bak";
  fs.copyFileSync(f, bak);
  const r = clean(f);
  const onDisk = await waitSaved(f, 12000);
  const after = inspect(f);
  const immune = immuneOf(onDisk);
  console.log("  " + path.basename(f) + "：降级 " + r.demoted.length + " 条 → 归档 " + r.pruned.archived
    + " / 删除 " + r.pruned.removed + "；过强度地板的候选 " + s.candidates + " → " + after.candidates
    + "（备份 " + path.basename(bak) + "）");
  ok("盘上已无命中项仍免检（valueScore≥4 或 sticky）", immune.length === 0,
    JSON.stringify({ 报告命中: s.hits.length, 本轮降级: r.demoted.length, 仍免检: immune.length,
      读回条数: onDisk ? onDisk.length : "读不到" }));
}
console.log("\n" + (fail ? "\x1b[31mFAIL\x1b[0m" : "\x1b[32mPASS\x1b[0m") + " — 通过 " + pass + " / 失败 " + fail);
if (fail) for (const x of fails) console.log("  · " + x);
process.exit(fail ? 1 : 0);
})();
