/* read_file 精准取段实测（symbol / 行区间 / 超 1MB 退段）
   ————————————————————————————————————————————
   单测钉的是纯函数形状，这里钉的是**接线与数字**：
   1) 真引擎 execTool("read_file") 走通（TOOLS schema → args → handler 这一段单测掩护不到）；
   2) 回执里的行号用 fs 全量读独立复核一遍——工具自己说"第 3699–3724 行"不算依据，
      它要是少数一行，模型就会拿着错行号去写 old_string，而这正是本项要治的病；
   3) 超 1MB 的文件以前只能自己写脚本按行 dump，现在必须能直接读到中间段；
   4) 符号索引有 500 文件上限，真实大仓会把最需要取段的文件截掉——所以 symbol 必须能在
      索引缺席时靠自己扫到定义行，这一条只有跑在真仓库上才测得到。
   全程只读真实仓库，写盘只落在沙箱 scratch。
   用法：node scripts/_verify_readseg.js
*/
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "readseg", ws: false });

const fs = require("fs");
const path = require("path");
const { FileStore } = require(path.join(__dirname, "..", "server", "files.js"));
const { LlmAgent } = require(path.join(__dirname, "..", "server", "agent-llm.js"));

const REPO = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
const mkAgent = (store) => new LlmAgent({
  cfg: { llm: {}, permissions: { mode: "auto" }, persona: {}, rules: { enabled: false }, memory: { enabled: false }, context: {}, computer: {} },
  files: store, emit: () => {}, git: null,
  term: { run: async () => ({ out: "", code: 0 }) },
});
const headOf = (out) => String(out).split("\n")[0];
const bodyOf = (out) => String(out).split("\n").slice(1).join("\n");
/* 正文 = 去掉首行抬头、再去掉尾行"续读提示"。逐字比对只能比正文，
   尾注是给模型看的，不是文件内容的一部分。 */
const bodyOnly = (out) => bodyOf(out).replace(/\n【[^】]*】$/, "");
/* 回执里的数字一律按格式抽，不靠"包含某个字符串"糊过去 */
const grab = (s, re) => { const m = re.exec(s); return m ? Number(m[1]) : NaN; };
const FROM = (s) => grab(s, /起自第 (\d+) 行/);
const RANGE = (s) => { const m = /本次返回第 (\d+)–(\d+) 行/.exec(s); return m ? [Number(m[1]), Number(m[2])] : [NaN, NaN]; };
const TOTAL = (s) => grab(s, /共 (\d+) 行/);
/* fs 读回来的 split 会把结尾换行算成多一行，工具数的是真实行数——这里对齐口径，
   否则"共 4621 行 vs 4622"这种差异是探针的错，不是产品的错。 */
const linesOf = (src) => { const a = src.split("\n"); return src.endsWith("\n") ? a.slice(0, -1) : a; };

(async () => {
  /* ── 1. 真仓库上的符号取段：行号独立复核 ── */
  const repoStore = new FileStore(REPO, null);
  const repoAgent = mkAgent(repoStore);
  const rel = "server/agent-llm.js";
  const full = linesOf(fs.readFileSync(path.join(REPO, rel), "utf8"));
  const realLine = full.findIndex((l) => l.includes("_boundToolResult(name, str)")) + 1;
  ok("全量读能找到被测函数（靶子立住了）", realLine > 0, "found " + realLine);
  const listed = repoStore.list().length;
  ok("靶子文件确实不在符号索引里（这条测的是兜底而非索引）",
    !(await repoAgent.execTool("search_symbol", { query: "_boundToolResult" })).includes("_boundToolResult"),
    "工作区列到 " + listed + " 个文件，FileStore 上限 500");

  const out = await repoAgent.execTool("read_file", { path: rel, symbol: "_boundToolResult" });
  const h = headOf(out);
  const [from, to] = RANGE(h);
  ok("符号段的起始行与全量读一致", FROM(h) === realLine && from === realLine, "回执 " + from + " vs 实际 " + realLine + " · " + h.slice(0, 90));
  ok("回执承认的全文件行数与真实行数一致", TOTAL(h) === full.length, "回执 " + TOTAL(h) + " vs 实际 " + full.length);
  ok("段内容与全量读的对应行逐字相等",
    bodyOf(out).replace(/\n【.*$/s, "") === full.slice(from - 1, to).join("\n"),
    "段 " + bodyOf(out).split("\n").length + " 行 vs 全量 " + (to - from + 1) + " 行");
  ok("段尾正好收在函数右括号（没多给下一个函数）", full[to - 1].trim() === "}", "第 " + to + " 行是 " + JSON.stringify(full[to - 1]));
  ok("段内含该函数自己的 spill 调用行", bodyOf(out).includes("this._spillToolResult("));
  ok("段尾没串进下一个符号 _pruneSpill", !bodyOf(out).includes("_pruneSpill("));

  /* ── 2. 行区间：防 off-by-one ── */
  const seg = await repoAgent.execTool("read_file", { path: rel, startLine: 3700, endLine: 3705 });
  const [s0, s1] = RANGE(headOf(seg));
  ok("区间抬头给的起止行就是请求的那几行", s0 === 3700 && s1 === 3705, headOf(seg));
  ok("区间内容与全量读逐字相等", bodyOnly(seg) === full.slice(3699, 3705).join("\n"), headOf(seg));
  ok("区间读到中间时承认后面还有", TOTAL(headOf(seg)) === full.length && headOf(seg).includes("startLine: 3706"), headOf(seg));

  /* ── 3. 超 1MB：以前只能自己写脚本 dump ── */
  const scratch = SANDBOX.scratch("big");
  // 每行都是一个真函数：这样"按符号取段"在这文件上必须成立（靶子要是纯文本，测不到定义识别）
  const bigLines = Array.from({ length: 40000 }, (_, i) => "function CODE" + i + "() { return " + i + "; }");
  const bigRel = "big.js";
  fs.writeFileSync(path.join(scratch, bigRel), bigLines.join("\n"), "utf8");
  ok("靶子文件确实超过 1MB 整读闸", fs.statSync(path.join(scratch, bigRel)).size > 1024 * 1024,
    "实际 " + Math.round(fs.statSync(path.join(scratch, bigRel)).size / 1024) + "KB");
  const bigAgent = mkAgent(new FileStore(scratch, null));
  const whole = await bigAgent.execTool("read_file", { path: bigRel });
  ok("超 1MB 整读不再报死错，而是退成开头一段", !/^错误:/.test(whole) && headOf(whole).includes("整读上限 1MB 已触发"), headOf(whole));
  const [w0, w1] = RANGE(headOf(whole));
  ok("退段给满 400 行且行号从 1 起", w0 === 1 && w1 === 400, headOf(whole));
  const mid = await bigAgent.execTool("read_file", { path: bigRel, startLine: 25000, lineCount: 3 });
  ok("大文件能直接读到中间段（这是取段的正事）", bodyOnly(mid) === bigLines.slice(24999, 25002).join("\n"), headOf(mid));
  ok("大文件总数照常报真行数而不是含糊", TOTAL(headOf(mid)) === 40000, headOf(mid));
  const bigSym = await bigAgent.execTool("read_file", { path: bigRel, symbol: "CODE24999" });
  const [b0, b1] = RANGE(headOf(bigSym));
  ok("超 1MB 文件也能按符号取到整个函数（索引同样覆盖不到它）",
    b0 === 25000 && b1 === 25000 && bodyOnly(bigSym) === bigLines[24999], headOf(bigSym));

  /* ── 4. 反向对照：没找到绝不能返回源码正文 ── */
  const bogus = await repoAgent.execTool("read_file", { path: rel, symbol: "_totallyNotAFunctionXYZ" });
  ok("符号不存在时不返回任何源码正文", !bogus.includes("const MICROCOMPACT") && /没找到定义行|不在 /.test(bogus), String(bogus).slice(0, 80));
  const callSite = await repoAgent.execTool("read_file", { path: rel, symbol: "_spillToolResult" });
  ok("真有定义的私有方法照样取到段", RANGE(headOf(callSite))[0] > 0, headOf(callSite));
  const onlyUsed = await repoAgent.execTool("read_file", { path: rel, symbol: "SPILL_MAX_FILE_CHARS_NOT_A_THING" });
  ok("只有调用点/完全不存在时给出行号线索而不是空面", /没找到定义行/.test(onlyUsed), String(onlyUsed).slice(0, 80));

  /* ── 5. 老路径不许有行为漂移：小文件整读仍是全文、无抬头 ── */
  const smallRel = "server/app-error.js";
  const small = await repoAgent.execTool("read_file", { path: smallRel });
  ok("小于 1MB 的整读仍返回全文，不加任何抬头", small === fs.readFileSync(path.join(REPO, smallRel), "utf8"), headOf(small).slice(0, 60));

  try { repoStore.close(); } catch (e) { /* 已关 */ }
  if (fail) { console.error("\nFAIL " + fail + " 项:\n - " + fails.join("\n - ")); process.exit(1); }
  console.log("\nPASS: read_file 取段 " + pass + " 项全过（" + rel + " 的 " + realLine + " 行函数按段取出，索引缺席时靠文本定位顶上）");
  process.exit(0);
})().catch((e) => { console.error("FAIL 探针自身异常: " + (e && e.stack || e)); process.exit(1); });
