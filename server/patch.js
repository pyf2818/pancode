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

function diffStat(oldStr, newStr) {
  const cnt = (arr) => { const m = {}; arr.forEach((l) => (m[l] = (m[l] || 0) + 1)); return m; };
  const A = cnt(String(oldStr).split("\n")), B = cnt(String(newStr).split("\n"));
  let add = 0, del = 0;
  for (const l in B) { const d = B[l] - (A[l] || 0); if (d > 0) add += d; }
  for (const l in A) { const d = A[l] - (B[l] || 0); if (d > 0) del += d; }
  return { add, del };
}

/* 在单文件内容上，顺序应用 old->new 片段替换。
   返回 { original, modified, edits:[{ok,error,old_string,new_string}] } */
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
      results.push({ ok: false, error: "未找到匹配片段（old_string 不存在于文件中）", old_string: oldS, new_string: newS });
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
      const hunks = (spec.edits || []).map((e, i) => ({
        index: i, old_string: e.old_string || "", new_string: e.new_string || "",
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
     返回已应用路径列表。 */
  apply(convId, paths, hunkSelections) {
    const list = this.pending[convId] || [];
    const target = (paths && paths.length) ? paths : list.map((x) => x.path);
    const applied = [];
    const remain = [];
    for (const s of list) {
      if (!target.includes(s.path)) { remain.push(s); continue; }
      const sel = hunkSelections && hunkSelections[s.path];
      let chosen;
      if (sel === undefined) chosen = s.edits;                       // 未指定 hunk → 应用全部
      else if (sel.length === 0) continue;                           // 空数组 → 整文件拒绝，跳过
      else chosen = s.edits.filter((_, i) => sel.includes(i));       // 仅应用选中的 hunk
      const { modified } = applyEditsToString(s.original, chosen);
      try { this.files.write(s.path, modified); applied.push(s.path); }
      catch (e) { /* 写失败不阻塞其它文件 */ }
    }
    this.pending[convId] = remain;
    return applied;
  }

  /* 拒绝。paths 为空 = 拒绝全部 */
  reject(convId, paths) {
    const list = this.pending[convId] || [];
    const target = (paths && paths.length) ? paths : list.map((x) => x.path);
    this.pending[convId] = list.filter((s) => !target.includes(s.path));
    return target;
  }
}

module.exports = { applyEditsToString, parsePatchText, diffStat, PatchEngine };
