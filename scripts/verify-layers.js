/* ============================================================
   验证分层运行器（F20-3）
   ————————————————————————————————————————————————————
   原来 test:verify 是一条 67 步的长链：它只回答"整条链红没红"，
   不回答"这轮改了协议，是哪一层该负责、哪些层压根没参与"。
   这里把同一批探针按"要不要起服务端 / 要不要开浏览器 / 要不要真安装包 / 要不要真模型"
   分成五层，每层各报：步数、红判据数、真判据总数、被 SKIP 的步骤与原因。

   分层不是重排覆盖率：第 1-3 层就是今天 test:verify 的全部 67 步，一步没丢；
   第 4、5 层今天只在 verify:all 里出现，这里显式命名并说明它们什么时候才跑得起来。

   用法：
     node scripts/verify-layers.js                  跑 1-3 层（CI 用的就是这条）
     node scripts/verify-layers.js --layer=3        只跑第 3 层
     node scripts/verify-layers.js --layer=1,2      跑前两层
     node scripts/verify-layers.js --layer=all      五层全跑（第 4 层要先 npm run dist，第 5 层要 Key）
     node scripts/verify-layers.js --list           只看分层，不跑
   ============================================================ */
"use strict";
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const S = (f) => "scripts/" + f + ".js";

/* 判层口径写在名字里，不靠记忆：
   L1 不起服务端（纯逻辑 + 契约对账，秒级到十几秒）
   L2 起隔离服务端、不开浏览器
   L3 开真浏览器（playwright chromium）量界面
   L4 发行验收：要有装出来的包 / 真机桌面
   L5 真实模型评测：要有真 Key，且要量到工具路径本身 */
const LAYERS = [
  {
    id: 1, key: "contract", name: "L1 快速契约（不起服务端，改协议/权限/存储先过这层）",
    steps: [
      S("_verify_contract"),
      S("_verify_render"), S("_verify_repo_map"), S("_verify_readseg"), S("_verify_vision"),
      S("_verify_tools"), S("_verify_agentflow"), S("_verify_ctxpair"), S("_verify_parallel"),
      S("_verify_promptctx"), S("_verify_multiroot"), S("_verify_choice"), S("_verify_rulehistory"),
      S("_verify_skilluse"), S("_verify_sse_terminal"), S("_verify_cli_contract"), S("_verify_settle"),
      S("_verify_memjudge"), S("_verify_cliui"), S("_verify_streambreak"),
    ],
  },
  {
    id: 2, key: "integration", name: "L2 隔离集成（起一次性数据根的真服务端，不开浏览器）",
    steps: [
      S("_verify_testrunner"), S("_verify_cost"), S("verify-git-async"), S("_verify_gitworkflow"),
      S("_verify_subboard"), S("_verify_wskey"), S("_verify_tasks"), S("_verify_fswatch"),
      S("_verify_roots"), S("test-lsp"), S("_verify_assets"), S("_verify_longtask"),
      S("_verify_auth"), S("_verify_origin"), S("_verify_eventscope"), S("_verify_logger"),
      S("_verify_editfiles"), S("_verify_refactor"), S("_verify_bootperf"),
      S("_verify_eld"), S("_verify_dist"), S("_verify_nightly_eval"),
      S("_verify_browser"), S("_verify_computer"),
    ],
  },
  {
    id: 3, key: "browser", name: "L3 浏览器交互（真开 chromium，量的是看得见的那一层）",
    steps: [
      S("_verify_codegraph"), S("_verify_worktree"), S("_verify_trace_proj"), S("_verify_scale"),
      S("_verify_roots_ui"), S("_verify_composer"), S("_verify_preview"), S("_verify_editorasync"),
      S("_verify_skillmarket"), S("_verify_workbench"), S("_verify_decisions"), S("_verify_ruleevo"),
      S("_verify_undo"), S("_verify_i18n"), S("_verify_gearmenu"), S("_verify_plandock"),
      S("_verify_stream_sched"), S("_verify_listeners"), S("_verify_diagnostics"),
      S("_verify_layout"), S("_verify_uitaste"), S("_verify_convlist"), S("_verify_mainspace"),
      S("_verify_trayjump"), S("_verify_shotui"), S("_verify_icons"),
    ],
  },
  {
    id: 4, key: "release", name: "L4 发行验收（要有装出来的安装包与真机桌面，本地 npm run dist 之后才跑得动）",
    /* _verify_perf 必须跑在真 Electron 里（GPU 开关只在桌面壳生效，headless 量出来的不是用户感受到的数）。
       它原先不在任何一条链上 —— 一道没人按的闸，这次分层顺带把它接回 L4。 */
    steps: [S("_verify_desktop"), S("verify-ui"), S("_verify_pkg"), S("_verify_workflow_ui"), S("_verify_perf")],
  },
  {
    id: 5, key: "model", name: "L5 真实模型评测（要真 Key；没 Key 时只能报「未测」，不能报通过）",
    steps: [S("nightly-real-llm")],
  },
];

function parseLayers(argv) {
  const a = argv.find((s) => s.startsWith("--layer="));
  if (!a) return [1, 2, 3];
  if (a === "--layer=all") return [1, 2, 3, 4, 5];
  return a.slice("--layer=".length).split(",").map((x) => Number(x)).filter(Boolean);
}

/* 一支探针跑完，把它自己打的汇总翻成统一口径：判据数 + 红数 + 跳过数。
   这仓里的探针比 this runner 早，页脚写法有五六种（共 N 条 / 通过 N 失败 M / N 通过, M 失败 /
   光一行 PASS / 只有逐条 ✓），所以按优先级挨个试，最后兜底用 ✓/✗ 行数 ——
   兜底也算数：宁可报"这一支只给了聚合 PASS = 1 条"，也不让它混在"没打出判据数"里看不出来。 */
function tally(out, status) {
  /* 红不红只认探针自己的退出码与页脚。上一版用「✗ / × 出现次数」兜底，
     把 "460×370" 这种乘号当失败，于是三支全绿的探针被报成"红 6/3/2"、整链跟着假红。
     数错的判据比没有数更糟：它会训练人去忽略红。 */
  const green = status === 0;
  const num = (a, b, known) => ({ checks: Number(a), red: known ? Number(b) : (green ? 0 : 1) });
  let m = /共 (\d+) 条，红 (\d+) 条/.exec(out); if (m) return num(m[1], m[2], true);
  m = /通过 (\d+) \/ 失败 (\d+)/.exec(out); if (m) return num(Number(m[1]) + Number(m[2]), m[2], true);
  m = /(\d+) 通过,? 失败 (\d+)/.exec(out) || /(\d+) 通过,? *(\d+) 失败/.exec(out); if (m) return num(Number(m[1]) + Number(m[2]), m[2], true);
  m = /FAIL (\d+) 项/.exec(out); if (m) return num((out.match(/[✓✔]/g) || []).length + Number(m[1]), m[1], true);
  const checks = (out.match(/[✓✔]/g) || []).length;
  if (checks) return num(checks, 0, false);
  return { checks: /(^|\n)PASS/.test(out) ? 1 : 0, red: green ? 0 : 1 };
}
/* 跳过：分清"整支没测"和"支里某个子用例跳过"，两者都必须在报告里看得见。 */
function skipInfo(out, checks) {
  /* 跳过只认"这一行本身就是跳过"：去掉缩进与 ANSI 之后，行首是 – / SKIP / 未测 才算。
     原先按整行文本搜 /未测|SKIP/i，把三类东西数成了跳过：① 标题「⑤ …如实「未测」」；
     ② 判据名「✓ …必须写「未测」而不是「通过」」；③ 判据明细里被 JSON 打出来的英文 `skip` 字段
     （_verify_plandock 那条"内含 1 处跳过"就是这么来的，它整个文件里没有一个「未测」）。
     跟把 "460×370" 数成失败是同一个病：数错的数会训练人去忽略数。 */
  const strip = (l) => l.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = out.split(/\r?\n/).filter((l) => /^\s*(–|SKIP|未测)/i.test(strip(l)));
  const whole = /^\s*(SKIP|未测)/im.test(strip(out)) || (/SKIP|未测/.test(out) && checks === 0);
  return { whole, notes: lines.map((l) => strip(l).trim().slice(0, 140)) };
}

/* 跑一支探针：script 是仓库内相对路径，args 是它的参数 */
function runStep(script, args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...(args || [])], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return { r, out: (r.stdout || "") + (r.stderr || "") };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--list")) {
    for (const l of LAYERS) console.log(l.name + " — " + l.steps.length + " 步\n    " + l.steps.map((s) => path.basename(s, ".js")).join(", "));
    return 0;
  }
  const want = argv.includes("--layer=all") ? [1, 2, 3, 4, 5] : parseLayers(argv);
  const chosen = LAYERS.filter((l) => want.includes(l.id));
  const totalSteps = chosen.reduce((n, l) => n + l.steps.length, 0);
  console.log("\n\x1b[1m验证分层：跑 " + chosen.length + " 层 / " + totalSteps + " 步（层序 " + want.join("+") + "）\x1b[0m");

  /* 数据根守门不属于任何一层：每次跑之前拍一次指纹、跑完再核一次。
     探针全在沙箱数据根里干活，这一头一尾证明的是"真那份一个字节没动"。 */
  const mark = runStep(S("_verify_dataroot"), ["mark"]);
  console.log("  数据根指纹 mark：" + (mark.r.status === 0 ? "已拍" : "失败（退出码 " + mark.r.status + "）"));
  if (mark.r.status !== 0) { console.log(mark.out.split(/\r?\n/).slice(-12).join("\n")); return 1; }

  const report = [];
  let bad = 0;
  for (const layer of chosen) {
    console.log("\n\x1b[1m▌" + layer.name + "\x1b[0m");
    let layerRed = 0, layerChecks = 0, skipped = [], layerPartialSkips = 0;
    const t0 = Date.now();
    for (const step of layer.steps) {
      const label = path.basename(step.split(" ")[0], ".js");
      const { r, out } = runStep(step);
      const t = tally(out, r.status);
      const sk = skipInfo(out, t.checks);
      layerChecks += t.checks; layerRed += t.red;
      if (sk.whole) skipped.push(label + "：整支未测（" + (sk.notes[0] || "输出里没有一条判据").slice(0, 120) + "）");
      else if (sk.notes.length) layerPartialSkips += sk.notes.length;
      const okRun = r.status === 0;
      if (!okRun) bad++;
      console.log("  " + (okRun ? "\x1b[32m·\x1b[0m" : "\x1b[31m·\x1b[0m") + " " + label + "  " +
        (t.checks || t.red ? t.checks + " 判据" + (t.red ? "，红 " + t.red : "") : "（这条探针没打任何可数的判据，只当跑了没跑）") +
        (sk.whole ? "  [整支未测]" : sk.notes.length ? "  [内含 " + sk.notes.length + " 处跳过]" : ""));
      if (!okRun) {
        /* 只打末尾 25 行是不够的：桌面那种探针末尾全是托盘日志，真正红的那条 ✗ 被冲在上面，
           读不出"红在哪"就等于没报（2026-10-30 那次 38/1 的偶发红就是这么查不到名的）。
           先把判据行单挑出来，再补一段尾部上下文。 */
        const marks = out.split(/\r?\n/).filter((l) => /[✗✔✓]|共 \d+ 条|ALL |通过 \d+/.test(l));
        if (marks.length) {
          console.log("      --- 判据行 ---");
          console.log(marks.slice(-10).map((l) => "      " + l.trim().slice(0, 160)).join("\n"));
        }
        console.log("      --- 输出末尾 ---");
        console.log(out.split(/\r?\n/).filter((l) => l.trim()).slice(-25).map((l) => "      " + l).join("\n"));
      }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log("  \x1b[1m本层：\x1b[0m" + layerRed + " 红 / " + layerChecks + " 判据，" + layer.steps.length + " 步，" + secs + "s" +
      (layerPartialSkips ? "，内含跳过 " + layerPartialSkips + " 处" : "") +
      (skipped.length ? "，整支未测 " + skipped.length + " 步：" + skipped.join(" | ") : ""));
    report.push({ name: layer.name, steps: layer.steps.length, checks: layerChecks, red: layerRed, secs, skipped, partial: layerPartialSkips });
  }

  console.log("\n\x1b[1m分层小结\x1b[0m");
  for (const r of report) {
    console.log("  " + r.name.split("（")[0] + " → " + r.red + " 红 / " + r.checks + " 判据 / " + r.steps + " 步 / " + r.secs + "s" +
      (r.skipped.length ? " / 整支未测 " + r.skipped.length + " 步" : "") + (r.partial ? " / 内含跳过 " + r.partial + " 处" : ""));
  }
  const chk = runStep(S("_verify_dataroot"), ["check"]);
  console.log("  数据根指纹 check：" + (chk.r.status === 0 ? "真那份一个字节没动" : "失败（退出码 " + chk.r.status + "）"));
  if (chk.r.status !== 0) { console.log(chk.out.split(/\r?\n/).slice(-12).join("\n")); bad++; }
  const anyRed = report.some((r) => r.red > 0);
  if (bad || anyRed) {
    console.log("\n\x1b[31m验证未通过：失败步骤 " + bad + " 个，红判据 " + report.reduce((n, r) => n + r.red, 0) + " 条\x1b[0m");
    return 1;
  }
  /* 这句原先只要 4/5 里跑过任意一个就说"本次已跑"，单跑 --layer=4 时会把没跑的第 5 层
     （需真 Key）也说成跑了 —— 结论行不能这样含糊。改成点明到底跑了哪一层。 */
  const opt = [4, 5].filter((n) => want.includes(n));
  console.log("\n\x1b[32m验证通过\x1b[0m（" + (opt.length
    ? "本次跑了第 " + opt.join(" 和 ") + " 层（4 需安装包、5 需真 Key）"
    : "本次只跑了第 1–3 层；第 4 层需安装包、第 5 层需真 Key，都没跑") + "）");
  return 0;
}

process.exit(main());
