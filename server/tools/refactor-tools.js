/* ============================================================
   P2-C2 · 跨文件重构工具：find_references（纯读）+ rename_symbol（先预览后落盘）

   这两个工具是一对，不是两个独立功能：改名之前必须先看到"波及哪些文件"，
   否则模型只能凭印象改，或者一个文件一个文件试 —— 那正是跨文件重构最费钱的地方。

   rename_symbol 默认 dry-run（与 git_push 同一套纪律：apply 不为 true 就只回预览），
   真正落盘时整批交给 edit_files，于是这些语义是白送的：
     - 一次调用一个检查点（/undo 一次撤掉整批改名，不是撤掉最后一个文件）
     - 任一处失败全批还原
     - 改完把诊断回灌给模型（改名最容易漏的就是"改了一半"）
   ============================================================ */
"use strict";
const R = require("../refactor");
const fileTools = require("./file-tools");

const MAX_FILES_SHOWN = 12;
const MAX_LINES_PER_FILE = 4;

/* 候选文件：默认整个活动工作区，paths 给定时按子串收窄（模型改名的时候
   通常知道自己要动哪一片，全仓扫一遍既慢又容易把 lock 文件卷进来）。 */
function candidates(agent, args) {
  let all = [];
  try { all = agent.files.list() || []; } catch (e) { return { error: "读不到工作区文件清单：" + e.message }; }
  const filter = Array.isArray(args.paths) ? args.paths.map(String) : (args.paths ? [String(args.paths)] : []);
  const hit = filter.length
    ? all.filter((p) => filter.some((f) => f && String(p).toLowerCase().includes(f.toLowerCase())))
    : all;
  return { files: hit, filtered: filter.length > 0, total: all.length };
}

function tally(list) {
  let n = 0;
  list.forEach((f) => { n += f.hits.length; });
  return n;
}
function briefLine(h) {
  const t = String(h.lineText).replace(/\s+/g, " ").trim();
  return (h.def ? "声明 " : h.member ? "成员 " : "引用 ") + h.line + "  " + (t.length > 96 ? t.slice(0, 96) + "…" : t);
}

/* 预览文本：dry-run 与"撞车拒绝"共用这一个渲染口，避免两种说法对不上。 */
function renderPlan(name, to, scanned, shown, skipped, note) {
  const lines = [];
  const files = shown.filter((f) => f.hits.length);
  lines.push(to
    ? "重命名 " + name + " → " + to + "：命中 " + tally(files) + " 处 / " + files.length + " 个文件（预览，未写入）"
    : "查找 " + name + "：命中 " + tally(files) + " 处 / " + files.length + " 个文件");
  /* 文档条目必须从"扫过的全部文件"里取：它们按定义就是 hits 为空的（默认不改），
     从改名清单里筛会永远筛不出来 —— 那等于对模型隐瞒了"这个名字在文档里还有几处"。 */
  const docs = scanned.filter((f) => !f.hits.length && f.rawHits);
  if (skipped) lines.push("另有 " + skipped + " 处同名文本在字符串 / 注释里，默认不动（要一起改加 includeLiterals:true）。");
  if (docs.length) lines.push("文档 / 数据文件里另有 " + docs.reduce((s, d) => s + d.rawHits, 0) + " 处（" + docs.map((d) => d.path).slice(0, 4).join("、") + "），默认不改（includeDocs:true 才计入）。");
  files.slice(0, MAX_FILES_SHOWN).forEach((f) => {
    const decl = f.hits.filter((h) => h.def).length;
    const mem = f.hits.filter((h) => h.member).length;
    lines.push("  " + f.path + "  " + f.hits.length + " 处" +
      (decl || mem ? "（" + [decl ? "声明 " + decl : "", mem ? "成员访问 " + mem : ""].filter(Boolean).join(" · ") + "）" : ""));
    f.hits.slice(0, MAX_LINES_PER_FILE).forEach((h) => lines.push("    " + briefLine(h)));
    if (f.hits.length > MAX_LINES_PER_FILE) lines.push("    …还有 " + (f.hits.length - MAX_LINES_PER_FILE) + " 处");
  });
  if (files.length > MAX_FILES_SHOWN) lines.push("  …还有 " + (files.length - MAX_FILES_SHOWN) + " 个文件（用 paths 参数收窄后再看）");
  if (note) lines.push(note);
  return lines.join("\n");
}

module.exports = {
  find_references: async (agent, args) => {
    const name = String((args && args.name) || "").trim();
    if (!R.IDENT_RE.test(name)) return "错误: find_references 需要 name 参数（一个标识符，例如 getUserInfo；不接受带空格或路径片段的写法）。";
    const cand = candidates(agent, args || {});
    if (cand.error) return "错误: " + cand.error;
    if (!cand.files.length) return "错误: 没有匹配到任何文件（paths=" + JSON.stringify((args || {}).paths) + "）。去掉 paths 再试一次。";
    const scan = R.scanFiles((p) => { try { return agent.files.read(p); } catch (e) { return null; } }, cand.files, name, {});
    if (!scan.files.length) {
      return "工作区里没有任何叫 " + name + " 的标识符（扫了 " + cand.files.length + " 个文件" +
        (cand.filtered ? "，已按 paths 收窄" : "") + "）。可能它在别的授权目录里、拼写不同，或只是字符串里的文本 —— 用 search_code 再确认一次。";
    }
    return renderPlan(name, "", scan.files, scan.files, scan.skipped,
      "这些位置都参与同一个名字，但本工具不做语义判断：同名不等于同一符号。改名前先确认声明处（标了「声明」的那几行）是不是你要动的那个。");
  },

  rename_symbol: async (agent, args) => {
    const a = args || {};
    const name = String(a.name || "").trim();
    const to = String(a.to || "").trim();
    if (!R.IDENT_RE.test(name)) return "错误: rename_symbol 的 name 必须是一个标识符（例如 getUserInfo）。";
    if (!to) return "错误: rename_symbol 需要 to 参数（新名字）。先想清楚新名字再改，改到一半再改回来要付两次钱。";
    if (!R.IDENT_RE.test(to)) return "错误: 新名字「" + to + "」不是合法标识符（只能由字母、数字、下划线、$ 组成，且不能以数字开头）。";
    if (name === to) return "错误: 新旧名字相同，没有可改的。";
    const cand = candidates(agent, a);
    if (cand.error) return "错误: " + cand.error;
    const readFile = (p) => { try { return agent.files.read(p); } catch (e) { return null; } };
    const scan = R.scanFiles(readFile, cand.files, name, { includeLiterals: !!a.includeLiterals, includeDocs: !!a.includeDocs });
    const targets = scan.files.filter((f) => f.hits.length);
    if (!targets.length) {
      return "错误: 工作区里没有任何叫 " + name + " 的标识符（扫了 " + cand.files.length + " 个文件），没有可改的。" +
        "先用 find_references 或 search_code 确认名字。";
    }
    /* 撞车检查：新名字已经在代码里出现，改名会把两个东西并成一个名字。
       这不是"可能有问题"，这基本一定有问题，所以直接拒绝而不是提醒。 */
    const clash = R.scanFiles(readFile, cand.files, to, {});
    if (clash.files.some((f) => f.hits.length)) {
      const where = clash.files.filter((f) => f.hits.length).slice(0, 5);
      return "错误: 目标名 " + to + " 已经存在于 " + where.map((f) => f.path + ":" + f.hits[0].line).join("、") +
        (clash.files.length > where.length ? " 等 " + clash.files.length + " 个文件" : "") +
        "。直接改会让两个东西共用一个名字。先处理掉已有那个，或换个名字。";
    }
    if (!a.apply) {
      return renderPlan(name, to, scan.files, targets, scan.skipped,
        "确认无误后带 apply:true 再调一次即可落盘（整批一个检查点，/undo 一次撤掉全部）。改完记得跑 run_tests。");
    }
    const ops = targets.map((f) => ({
      path: f.path,
      edits: [{ old_string: f.text, new_string: R.applyHits(f.text, f.hits, to) }],
    }));
    const res = await fileTools.edit_files(agent, { ops });
    return "重命名 " + name + " → " + to + "（" + tally(targets) + " 处 / " + targets.length + " 个文件）\n" + res;
  },
};
