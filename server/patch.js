/* ============================================================
   pancode 补丁引擎（Patch Engine）
   —— 复刻 Cline / Aider / Cursor 的「片段编辑 + 审阅」体验

   两种输入：
   1) 结构化：path + edits:[{old_string,new_string}]（function calling 首选）
   2) Aider 风格 search/replace 文本块（多文件）：
        path/to/file
        <<<<<<< SEARCH
        old code
        =======
        new code
        >>>>>>> REPLACE

   设计要点（对齐成熟产品的工程实践）：
   - search 块必须「逐字且唯一」，否则拒绝并让模型自我修正（Claude Code 式严格）
   - 改动先「暂存」进审阅队列，绝不静默落盘；由用户在 diff 视图逐文件接受/拒绝
   - 纯函数 applyEditsToString / parsePatchText 不依赖文件系统，方便单测
   ============================================================ */
"use strict";

// diffStat 统一复用 agent-base 的单一实现，避免双份重复逻辑（patch 仍对外导出以保持 test-patch 兼容）
const { diffStat } = require("./agent-base");

/* ---------- W13：fast-apply 模糊匹配（确定性机械 merge，零依赖） ----------
   精确匹配失败时的降级：LLM 出的 old_string 常有空白/缩进/CRLF 微差，逐字匹配失败导致整批拒绝→重跑。
   步骤 A：空白归一化连续行匹配（trim + 去 CR，覆盖缩进/尾随空格/CRLF 差异——最高频失败场景）
   步骤 B：行级 LCS 相似度滑窗（old ≥3 行才启用防短块误匹配，窗口 ±2 行，ratio ≥ 阈值；
           top2 相近判不唯一拒绝——宁可失败交给模型自我修正，不可误替换）
   返回 { start, end, ratio }（行号区间 [start, end)）或 null */
function normLine(line) { return String(line).replace(/\r$/, "").trim(); }

/* W13：行内小改（改变量名等）会让整行不同——LCS 相等判定放宽为行相似度。
   混合相似度：短行（≤80 字符）用编辑距离比率（对 3 字符扰动鲁棒），
   长行用 trigram Jaccard（O(行长) 便宜）；取 max。 */
function trigrams(s) {
  const t = new Set();
  const str = " " + s + " ";
  for (let i = 0; i + 3 <= str.length; i++) t.add(str.slice(i, i + 3));
  return t;
}
function trigSim(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
function levRatio(a, b) {
  if (a === b) return 1;
  const m = a.length, k = b.length;
  if (!m || !k || Math.max(m, k) > 80) return 0;   // 长行走 trigram，这里不兜
  const prev = new Array(k + 1), cur = new Array(k + 1);
  for (let j = 0; j <= k; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= k; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= k; j++) prev[j] = cur[j];
  }
  return 1 - prev[k] / Math.max(m, k);
}
function lineSim(a, b) { return Math.max(trigSim(a, b), levRatio(a, b)); }
const LINE_SIM = 0.55;   // 行近似匹配阈值

/* 相似度矩阵预计算：sims[oldIdx][fileIdx]（DP 内查表 O(1)，避免滑窗内重复计算）。
   性能：trigram Set 每行只建一次（5000 行文件 × 22 行 old 从 11 万次构建降到 5022 次）；
   长度比 <0.4 早退；trigSim <0.2 时跳过 levRatio（经验上 lev 不可能达标）。 */
function buildSimMatrix(oldLines, fileNorm) {
  const fileTrig = fileNorm.map(trigrams);
  const oldTrig = oldLines.map(trigrams);
  return oldLines.map((ol, j) => {
    const A = oldTrig[j];
    return fileNorm.map((fl, i) => {
      if (ol === fl) return 1;
      if (!ol || !fl) return 0;
      if (Math.min(ol.length, fl.length) / Math.max(ol.length, fl.length) < 0.4) return 0;
      const B = fileTrig[i];
      let inter = 0;
      for (const x of A) if (B.has(x)) inter++;
      const ts = inter / (A.size + B.size - inter);
      if (ts >= LINE_SIM) return ts;
      if (ts < 0.2) return 0;
      return Math.max(ts, levRatio(ol, fl));
    });
  });
}
function lcsRatioM(n, size, start, sims) {
  if (!n || !size) return 0;
  const dp = new Array(size + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    let prevDiag = 0;
    const row = sims[i - 1];
    for (let j = 1; j <= size; j++) {
      const tmp = dp[j];
      dp[j] = row[start + j - 1] >= LINE_SIM ? prevDiag + 1 : Math.max(dp[j], dp[j - 1]);
      prevDiag = tmp;
    }
  }
  return dp[size] / Math.max(n, size);
}

function fuzzyFindBlock(text, oldS, threshold) {
  const th = threshold || 0.85;
  const fileLines = String(text || "").split("\n");
  if (fileLines.length > 20000) return null;   // 超大文件跳过 fuzzy（防 DP 性能失控）
  const oldLines = String(oldS || "").split("\n").map(normLine);
  const n = oldLines.length;
  if (!n) return null;
  if (oldLines.every((l) => l === "")) return null;   // 全空行无匹配意义
  const fileNorm = fileLines.map(normLine);
  /* 步骤 A：归一化逐行滑窗精确匹配（含唯一性检查） */
  let hitsA = 0, firstA = -1;
  for (let i = 0; i + n <= fileNorm.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) if (fileNorm[i + j] !== oldLines[j]) { ok = false; break; }
    if (ok) { hitsA++; if (firstA < 0) firstA = i; }
  }
  if (hitsA === 1) return { start: firstA, end: firstA + n, ratio: 1 };
  if (hitsA > 1) return null;   // 归一化意义下不唯一
  /* 步骤 B：LCS 行相似度滑窗 */
  if (n < 3) return null;
  /* 滑窗评估：ratio 主排序；同起点不同 size 的子窗口天然重叠不算 tie。
     tie（ratio 容差 0.02 内、不同起点）用对角 sim 均值破——精确对齐的窗口相似度
     均值显著高于错位窗口（如 v2000 区块 0.97 vs 平移一格 0.73）；
     sim 均值也并列（真重复样板）才拒绝。 */
  const sims = buildSimMatrix(oldLines, fileNorm);
  let best = null, bestSimMean = -1, bestTies = 0;
  for (let size = Math.max(1, n - 2); size <= n + 2; size++) {
    for (let i = 0; i + size <= fileNorm.length; i++) {
      const r = lcsRatioM(n, size, i, sims);
      if (r < th) continue;
      const diagN = Math.min(n, size);
      let simMean = 0;
      for (let j = 0; j < diagN; j++) simMean += sims[j][i + j];
      simMean /= diagN;
      if (!best || r > best.ratio + 0.02) { best = { start: i, end: i + size, ratio: r }; bestSimMean = simMean; bestTies = 1; }
      else if (Math.abs(r - best.ratio) <= 0.02) {
        if (i === best.start) continue;   // 同起点跨 size：对角对相同，simMean 必然相等，天然同源非 tie
        if (simMean > bestSimMean + 1e-9) { best = { start: i, end: i + size, ratio: r }; bestSimMean = simMean; bestTies = 1; }
        else if (Math.abs(simMean - bestSimMean) <= 1e-9) bestTies++;
        /* sim 均值更低 → 保持现 best，不计 tie */
      }
    }
  }
  return best && bestTies === 1 ? best : null;
}

/* 在单文件内容上，顺序应用 old->new 片段替换。
   返回 { original, modified, edits:[{ok,fuzzy?,ratio?,error?,old_string,new_string}] } */
function applyEditsToString(original, edits) {
  let cur = original == null ? "" : String(original);
  const results = [];
  for (const e of (edits || [])) {
    const oldS = e.old_string == null ? "" : String(e.old_string);
    const newS = e.new_string == null ? "" : String(e.new_string);
    if (oldS === "") {
      // 空 old_string = 整文件（新建/重写）。后续若有多个 edit，后者覆盖前者。
      cur = newS;
      results.push({ ok: true, old_string: oldS, new_string: newS });
      continue;
    }
    const idx = cur.indexOf(oldS);
    if (idx < 0) {
      /* W13：精确失败 → fuzzy 机械 merge 降级 */
      const fz = fuzzyFindBlock(cur, oldS, 0.85);
      if (fz) {
        const lines = cur.split("\n");
        const blockLines = lines.slice(fz.start, fz.end);
        const hadCR = blockLines.some((l) => /\r$/.test(l));   // 保持原区块行尾风格
        const newLines = String(newS).split("\n").map((l) => (hadCR && !/\r$/.test(l) ? l + "\r" : l));
        lines.splice(fz.start, fz.end - fz.start, ...newLines);
        cur = lines.join("\n");
        results.push({ ok: true, fuzzy: true, ratio: Math.round(fz.ratio * 100) / 100, old_string: oldS, new_string: newS });
        continue;
      }
      results.push({ ok: false, error: "未找到匹配片段（old_string 不存在于文件中，且模糊匹配未命中）", old_string: oldS, new_string: newS });
      continue;
    }
    const idx2 = cur.indexOf(oldS, idx + 1);
    if (idx2 >= 0) {
      results.push({ ok: false, error: "old_string 在文件中出现多次（不唯一），无法安全替换；请向上/下扩展上下文使其唯一", old_string: oldS, new_string: newS });
      continue;
    }
    cur = cur.slice(0, idx) + newS + cur.slice(idx + oldS.length);
    results.push({ ok: true, old_string: oldS, new_string: newS });
  }
  return { original, modified: cur, edits: results };
}

/* 解析 Aider 风格 search/replace 多文件文本块 → [{path, edits:[{old_string,new_string}]}] */
function parsePatchText(text) {
  const lines = String(text).split("\n");
  const files = [];
  let pendingPath = null;     // 最近一个疑似「文件路径」的非标记行
  let curPath = null;
  let inBlock = false, phase = null, oldBuf = [], newBuf = [];
  const flush = () => {
    if (curPath != null) {
      const ed = { old_string: oldBuf.join("\n"), new_string: newBuf.join("\n") };
      const f = files.find((x) => x.path === curPath);
      if (f) f.edits.push(ed); else files.push({ path: curPath, edits: [ed] });
    }
    oldBuf = []; newBuf = []; inBlock = false; curPath = null; phase = null;
  };
  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) { inBlock = true; phase = "old"; curPath = pendingPath; continue; }
    if (line.startsWith("=======") && inBlock) { phase = "new"; continue; }
    if (line.startsWith(">>>>>>>") && inBlock) { flush(); continue; }
    if (inBlock) {
      if (phase === "old") oldBuf.push(line); else newBuf.push(line);
    } else if (line.trim().length) {
      pendingPath = line.trim();   // 块前的非空行即文件路径（Aider 约定）
    }
  }
  return files;
}

/* 基于 FileStore 的暂存/应用引擎（生命周期跟随 Agent） */
class PatchEngine {
  constructor(fileStore) {
    this.files = fileStore;
    this.pending = {};   // convId -> [{path, original, modified, isNew, status, add, del}]
  }

  /* 解析参数并暂存改动；不落盘。
     返回 { ok, staged?, error?, errors? } */
  stage(convId, args) {
    let specs = [];   // [{path, edits}]
    if (args.patch && String(args.patch).trim()) {
      specs = parsePatchText(args.patch);
    } else if (args.path) {
      let edits = [];
      if (Array.isArray(args.edits)) edits = args.edits;
      else if (args.old_string !== undefined || args.new_string !== undefined) {
        edits = [{ old_string: args.old_string || "", new_string: args.new_string || "" }];
      }
      specs = [{ path: args.path, edits }];
    } else {
      return { ok: false, error: "apply_edit 需要提供 path + edits（或 old_string/new_string），或 patch 文本块" };
    }

    const staged = [];
    const errors = [];
    for (const spec of specs) {
      const p = spec.path;
      if (!p) { errors.push("缺少文件路径"); continue; }
      let exists = false, original = "";
      try { exists = this.files.exists(p); if (exists) original = this.files.read(p); } catch (e) {}
      const { modified, edits } = applyEditsToString(original, spec.edits || []);
      const failed = edits.filter((e) => !e.ok);
      if (failed.length) {
        errors.push(p + ": " + failed.map((f) => f.error).join("; "));
        continue;
      }
      if (modified === original) continue;   // 无实际改动，跳过
      const st = diffStat(original, modified);
      const hunks = edits.map((r, i) => ({
        index: i, old_string: r.old_string || "", new_string: r.new_string || "",
        fuzzy: !!r.fuzzy, ratio: r.ratio,   // W13：宽松匹配标记，供工具返回/审阅面板提示
      }));
      staged.push({
        path: p, original, modified, edits: spec.edits || [], hunks,
        isNew: !exists, status: exists ? "M" : "A", add: st.add, del: st.del,
      });
    }

    if (!staged.length) {
      return { ok: false, error: errors.length ? errors.join(" | ") : "没有产生任何改动（目标内容与当前文件一致）" };
    }

    // 合并：同一文件若已暂存，后者覆盖前者
    if (!this.pending[convId]) this.pending[convId] = [];
    const byPath = {};
    for (const s of this.pending[convId]) byPath[s.path] = s;
    for (const s of staged) byPath[s.path] = s;
    this.pending[convId] = Object.values(byPath);

    return { ok: true, staged: this.pending[convId], errors: errors };
  }

  list(convId) { return this.pending[convId] || []; }

  /* 写盘应用。
     paths 为空 = 应用全部文件；hunkSelections = { path: [hunkIndex,...] } 做逐 hunk 部分应用。
     某文件 hunkSelections[path] 为 []（空数组）= 该文件全部拒绝，不写盘。
     冲突检测：写盘前重新读当前文件，验证 old_string 仍存在；不匹配则跳过并记入 conflicts。
     返回 { applied:[路径], conflicts:[路径] }。 */
  apply(convId, paths, hunkSelections) {
    const list = this.pending[convId] || [];
    const target = (paths && paths.length) ? paths : list.map((x) => x.path);
    const applied = [];
    const conflicts = [];
    const remain = [];
    for (const s of list) {
      if (!target.includes(s.path)) { remain.push(s); continue; }
      const sel = hunkSelections && hunkSelections[s.path];
      let chosen;
      if (sel === undefined) chosen = s.edits;                       // 未指定 hunk → 应用全部
      else if (sel.length === 0) continue;                           // 空数组 → 整文件拒绝，跳过
      else chosen = s.edits.filter((_, i) => sel.includes(i));       // 仅应用选中的 hunk

      // 乐观锁：重新读当前文件，检测 stage→apply 窗口期间是否被其他会话改动
      let current = null;
      try { current = this.files.exists(s.path) ? this.files.read(s.path) : null; } catch (e) {}
      if (!s.isNew && current != null) {
        let stale = false;
        for (const e of chosen) {
          const oldS = e.old_string == null ? "" : String(e.old_string);
          if (oldS === "") continue;                                 // 整文件重写，无需检测
          // W13：逐字不存在时做 fuzzy 重定位——宽松匹配暂存的编辑在这里会被逐字检查误杀
          if (!current.includes(oldS) && !fuzzyFindBlock(current, oldS, 0.85)) { stale = true; break; }
        }
        if (stale) {
          conflicts.push(s.path);
          remain.push(s);                                            // 保留在 pending，供用户重新审视
          continue;
        }
        // 基于当前文件内容（而非过期快照）重新计算 modified
        const { modified } = applyEditsToString(current, chosen);
        try { this.files.write(s.path, modified); applied.push(s.path); }
        catch (e) { /* 写失败不阻塞其它文件 */ }
      } else {
        // 新建文件或文件已被删除：用原快照逻辑
        const { modified } = applyEditsToString(s.original, chosen);
        try { this.files.write(s.path, modified); applied.push(s.path); }
        catch (e) { /* 写失败不阻塞其它文件 */ }
      }
    }
    this.pending[convId] = remain;
    return { applied, conflicts };
  }

  /* 拒绝。paths 为空 = 拒绝全部 */
  reject(convId, paths) {
    const list = this.pending[convId] || [];
    const target = (paths && paths.length) ? paths : list.map((x) => x.path);
    this.pending[convId] = list.filter((s) => !target.includes(s.path));
    return target;
  }
}

module.exports = { applyEditsToString, parsePatchText, diffStat, fuzzyFindBlock, PatchEngine };
