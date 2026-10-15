"use strict";
/* 文件工具：list_files / read_file / write_file / apply_edit / edit_files / delete_file / search_code */
const path = require("path");
const codeIndex = require("../code-index");
const { getActiveManager } = require("../lsp-bridge");
const { computeDiffLines, fmtDiag } = require("./util");
const { applyEditsToString } = require("../patch");

/* 路径归属交给 root-store 判：不带 root 的相对路径就是当前工作区，与单根时代逐字一致。
   ctx 里没有 roots（假 agent / 老路径）就退回 agent.files —— 这条改造不许打断任何既有调用。 */
function locate(agent, args, mutation) {
  if (!agent || !agent.roots || typeof agent.roots.resolve !== "function") {
    const p = String((args && args.path) || "");
    return { ok: true, store: agent.files, rel: p, root: { active: true, dir: agent.files.dir, label: "" } };
  }
  const res = agent.roots.resolve(args, mutation);
  /* 碰过哪个根就记下来：下一轮装配规则层时，那个根自己的 AGENTS.md / .pancode/rules 也要进来。
     否则跨根读了半天文件，模型看到的约定却仍然只有当前项目的——等于拿 A 的规矩办 B 的事。 */
  if (res.ok && res.root && !res.root.active && typeof agent.noteSessionRoot === "function") {
    agent.noteSessionRoot(res.root.id);
  }
  return res;
}

/* 卡片上要给人看清是哪家的文件：跨根时带上根名，避免两个项目里的同名文件看起来像同一个 */
function showPath(args, res) {
  const rel = res.rel || String((args && args.path) || "");
  if (!res.root || res.root.active) return rel;
  const who = res.root.label || path.basename(res.root.dir || "");
  return who + ":" + rel;
}

/* 写完把 LSP 诊断拼进工具回执（P1-B1）。
   为什么要拼：波浪线只有人看得见，模型看不见——它写完就接着往下推，
   直到 run_command 撞车才发现语法错了。回灌之后错误在下一轮就回到它眼前。
   等 400ms 是给 LSP 发布的时间；读不到就当没有（诊断失败不许影响写入本身）。
   多个文件只等一次，不是每个文件各等一次。 */
async function diagBlock(agent, rels) {
  const list = (rels || []).filter(Boolean);
  if (!list.length) return "";
  try {
    const mgr = getActiveManager();
    if (!mgr) return "";
    await new Promise((r) => setTimeout(r, 400));
    let errs = 0, warns = 0;
    const lines = [];
    for (const rel of list) {
      const d = mgr.getDiagnostics(agent.files.dir, rel);
      if (!d || d.scope !== "file" || !d.items || !d.items.length) continue;
      const e = d.items.filter((x) => x.severity === 1);
      const w = d.items.filter((x) => x.severity === 2);
      errs += e.length; warns += w.length;
      for (const it of d.items.slice(0, 10)) lines.push(rel + " · " + fmtDiag(it));
    }
    if (!errs && !warns) return "";
    const files = new Set(lines.map((l) => l.split(" · ")[0])).size;
    return "\n\n【LSP 诊断】" + errs + " 个错误、" + warns + " 个警告（涉及 " + files + " 个文件）：\n" +
      lines.slice(0, 14).join("\n") + (errs ? "\n建议修复上述错误后再继续。" : "");
  } catch (e) { return ""; }
}

module.exports = {
  list_files: async (agent, args) => {
    /* 不带 root = 当前工作区，行为与单根时代一字不差；带 root 时列的是那个已授权根 */
    const res = locate(agent, { root: args && args.root, path: "." }, false);
    if (!res.ok) {
      const t0 = agent.tool("read", "列出被拒", String(args && args.root));
      t0.done(false, "没有授权");
      return "错误: " + res.error;
    }
    const cross = !!(res.root && !res.root.active);
    const who = res.root.label || path.basename(res.root.dir || "");
    const t = agent.tool("read", "列出文件", cross ? who + "/" : "workspace/");
    const list = res.store.list();
    t.body(list.join("\n"));
    t.done(true, list.length + " 个文件");
    if (!list.length) return cross ? "(这个授权的目录是空的)" : "(空工作区)";
    return (cross ? "（" + who + " = " + res.root.dir + "）\n" : "") + list.join("\n");
  },

  read_file: async (agent, args) => {
    if (!args.path || typeof args.path !== "string") {
      const t = agent.tool("read", "读取文件", String(args.path));
      t.done(false, "路径为空");
      return "错误: 未提供有效的文件路径（path 参数缺失或为空）。请提供要读取的文件相对路径，如 src/app.js。";
    }
    const res = locate(agent, args, false);
    if (!res.ok) {
      const t = agent.tool("read", "读取被拒", args.path);
      t.done(false, "没有授权");
      return "错误: " + res.error;
    }
    const t = agent.tool("read", "读取文件", showPath(args, res));
    try {
      const txt = res.store.read(res.rel);
      t.body(txt.split("\n").slice(0, 40).join("\n"));
      t.done(true, txt.split("\n").length + " 行");
      return txt;
    } catch (e) { t.done(false, "读取失败"); return "错误: " + e.message; }
  },

  write_file: async (agent, args) => {
    if (!args.path || typeof args.path !== "string") {
      const t = agent.tool("edit", "写入被拒", String(args.path)); t.done(false, "路径为空", false);
      return "错误: 未提供有效的文件路径（path 参数缺失或为空）。";
    }
    if (args.content == null || typeof args.content !== "string") {
      const t = agent.tool("edit", "写入被拒", args.path); t.done(false, "内容为空", false);
      return "错误: 未提供文件内容（content 参数缺失）。如需清空文件请传空字符串。";
    }
    /* 门（授权清单）先判，再谈屋里的规则（allow/deny）。 */
    const res = locate(agent, args, true);
    if (!res.ok) {
      const t = agent.tool("edit", "写入被拒", args.path); t.done(false, "没有授权", false);
      return "错误: " + res.error;
    }
    /* 归属定了才谈规则（阶段二-25）：跨根写走"根限定的绝对主体"过 allow 判定
       （见 _subjectForms），所以当前项目写的 src/** 不能替另一个项目背书。 */
    const store = res.root.active ? agent.files : res.store;
    const foreign = !res.root.active;
    const rel = res.rel;
    const shown = showPath(args, res);
    const isNew = !store.exists(rel);
    const gate = await agent._gate("write_file", { path: args.path, content: args.content, root: args.root }, isNew ? "high" : "medium");
    if (gate.blocked) {
      const t = agent.tool("edit", "创建被拒", shown); t.done(false, "被拒绝规则拦截", false);
      return "命令被拒绝规则拦截：" + shown;
    }
    if (!gate.approved) {
      const t = agent.tool("edit", isNew ? "创建被拒" : "编辑被拒", shown);
      t.done(false, "用户拒绝", false);
      return "用户拒绝了" + (isNew ? "创建" : "写入") + "文件：" + shown + (gate.reason ? "（" + gate.reason + "）" : "");
    }
    const t = agent.tool("edit", isNew ? "创建文件" : "编辑文件", shown);
    try {
      const snap = agent._snapshotBefore(rel, store);
      agent._pushCheckpoint([snap], (isNew ? "创建 " : "写入 ") + shown);
      store.write(rel, args.content);
      codeIndex.queueFileUpdate(store.dir, rel);
      const st = require("../agent-base").diffStat(isNew ? "" : snap.beforeContent, args.content);
      t.body((isNew ? "(新文件)\n" : "") + args.content.split("\n").slice(0, 30).join("\n"));
      t.done(true, "+" + st.add + " −" + st.del, false);
      if (foreign) {
        /* 前端编辑器与改动面板按「工作区相对路径」认文件，跨根同名会撞车（改 B 的 src/a.js
           却刷新了 A 的 src/a.js）；LSP 也只跟着当前工作区。所以跨根只给一句终端痕，
           并把落点写在回执里，让模型知道它改的不是本项目。 */
        agent.emit({ type: "term.line", text: "[跨根写入] " + shown + (isNew ? "（新建）" : "") + " → " + store.dir, cls: "tl-info" });
        return "写入成功: " + shown + "（已授权目录 " + store.dir + "；不在当前工作区，编辑器与改动面板不跟踪它，/undo 可以撤销）";
      }
      agent.fileChanged(rel);
      agent.pushChanges(false);
      agent.emit({ type: "editor.open", path: rel });
      if (!isNew && snap.beforeContent != null) {
        const _diffLines = computeDiffLines(snap.beforeContent, args.content);
        if (_diffLines.length) agent.emit({ type: "editor.diff", path: rel, added: _diffLines });
      }
      let _result = "写入成功: " + rel;
      _result += await diagBlock(agent, [rel]);
      return _result;
    } catch (e) { t.done(false, "写入失败"); return "错误: " + e.message; }
  },

  apply_edit: async (agent, args) => {
    const t = agent.tool("edit", "暂存改动", args.path || "多文件");
    const res = agent.patch.stage(agent._currentConv, args);
    if (!res.ok) {
      t.done(false, "编辑未应用", false);
      return "编辑未应用：" + res.error + "。请修正 old_string 使其「逐字、唯一且存在于文件中」，然后重试同一处修改。";
    }
    const files = res.staged;
    // W13：宽松匹配统计——让 LLM 与用户都能感知"机械 merge 介入了哪些 hunk"
    const fuzzyN = files.reduce((acc, f) => acc + (f.hunks || []).filter((h) => h.fuzzy).length, 0);
    const fuzzyNote = fuzzyN ? "\n注意：其中 " + fuzzyN + " 处为宽松匹配（相似度阈值 0.85，自动对齐缩进/空白差异），请核对新内容上下文是否正确。" : "";
    const permMode = (agent.cfg.permissions || {}).mode || "ask";
    if (permMode === "auto") {
      const paths = files.map((f) => f.path);
      const { applied, conflicts } = agent.applyPatch(agent._currentConv, paths);
      t.body(paths.join("\n"));
      if (conflicts.length) {
        t.done(true, "已应用 " + applied.length + " 个文件，" + conflicts.length + " 个冲突跳过", false);
        return "已写入 " + applied.length + " 个文件改动；冲突跳过：" + conflicts.join(", ") + "（文件已被其他会话修改，请重新执行 apply_edit）。";
      }
      t.done(true, "已自动接受 " + applied.length + " 个文件改动", false);
      return "已自动写入 " + applied.length + " 个文件改动（" + paths.join(", ") + "）。" + fuzzyNote;
    }
    agent.emit({
      type: "patch.review",
      convId: agent._currentConv,
      files: files.map((f) => ({
        path: f.path, status: f.status, isNew: f.isNew,
        original: f.original, modified: f.modified, add: f.add, del: f.del,
        hunks: f.hunks,
      })),
    });
    t.body(files.map((f) => f.path + "  (+" + f.add + " −" + f.del + ")").join("\n"));
    t.done(true, "已暂存 " + files.length + " 个文件，待审阅", false);
    return "已暂存 " + files.length + " 处文件改动（" + files.map((f) => f.path).join(", ") +
      "）。这些改动已进入「审阅面板」，请用户在 diff 视图中逐文件「接受」或「拒绝」后再落盘。" +
      "不要对同一个文件改用 write_file 整文件覆盖。" + fuzzyNote;
  },

  delete_file: async (agent, args) => {
    if (!args.path || typeof args.path !== "string") {
      const t = agent.tool("edit", "删除被拒", String(args.path)); t.done(false, "路径为空", false);
      return "错误: 未提供有效的文件路径（path 参数缺失或为空）。";
    }
    /* 先判门（授权 + 读写档位），再判屋里的规则。删除是不可逆的：_gate 里那条
       "即使 auto 模式也强制人工确认"的守卫对跨根同样生效。 */
    const res = locate(agent, args, true);
    if (!res.ok) {
      const t0 = agent.tool("edit", "删除被拒", args.path); t0.done(false, "没有授权", false);
      return "错误: " + res.error;
    }
    const store = res.root.active ? agent.files : res.store;
    const foreign = !res.root.active;
    const rel = res.rel;
    const shown = showPath(args, res);
    const gate = await agent._gate("delete_file", { path: args.path, root: args.root }, "high");
    if (gate.blocked) {
      const t = agent.tool("edit", "删除被拒", shown); t.done(false, "被拒绝规则拦截", false);
      return "命令被拒绝规则拦截：" + shown;
    }
    if (!gate.approved) {
      const t = agent.tool("edit", "删除被拒", shown);
      t.done(false, "用户拒绝", false);
      return "用户拒绝了删除文件：" + shown + (gate.reason ? "（" + gate.reason + "）" : "");
    }
    const t = agent.tool("edit", "删除文件", shown);
    try {
      agent._pushCheckpoint([agent._snapshotBefore(rel, store)], "删除 " + shown);
      store.remove(rel);
      codeIndex.removeFile(store.dir, rel);
      if (foreign) {
        agent.emit({ type: "term.line", text: "[跨根删除] " + shown + " → " + store.dir, cls: "tl-warn" });
        t.done(true, "已删除");
        return "删除成功: " + shown + "（已授权目录 " + store.dir + "；/undo 可以恢复）";
      }
      agent.fileChanged(rel);
      agent.pushChanges(false);
      t.done(true, "已删除");
      return "删除成功: " + rel;
    } catch (e) { t.done(false, "删除失败"); return "错误: " + e.message; }
  },

  search_code: async (agent, args) => {
    const t = agent.tool("read", "代码检索", args.query);
    let txt;
    try {
      const sem = await codeIndex.search({ wsDir: agent.files.dir, query: args.query, k: 12 });
      if (sem && sem.ok && sem.results.length) {
        txt = `[语义检索 · ${sem.mode} · ${sem.count} 结果]\n` + sem.results
          .map((r) => `■ ${r.path} (${r.startLine}-${r.endLine}) ${r.title}\n${r.snippet}`)
          .join("\n\n");
      }
    } catch (e) { /* 索引不可用，走兜底 */ }
    if (!txt) {
      const rs = agent.files.search(args.query, 50);
      txt = rs.map((r) => r.path + ":" + r.line + ": " + r.text.trim()).join("\n");
      if (txt) txt = "[关键词搜索 · " + rs.length + " 处匹配]\n" + txt;
      else txt = "（无索引也未匹配到关键词）";
    }
    t.body(txt);
    t.done(true, "检索完成");
    return txt;
  },

  /* P0-A3: 多文件原子编辑 —— 一次调用改动多个文件（每项 {path, old_string, new_string} 或 {path, edits:[...]}）
     语义：
       - 全部文件先逐个走 locate/gate，任何一处失败就整体回滚（已写入的文件还原快照）；
       - 全部成功才提交一个检查点（原子性）；
       - 相比 apply_edit：apply_edit 是「暂存到审阅队列，由用户逐文件接受/拒绝」，适合人工把关；
         edit_files 是「全或无」批量落盘，适合机械性批量改动（rename、import 替换等）。
     参数（args）:
       ops: 数组，每项:
         { path, old_string, new_string }  单处替换
         { path, edits: [{old_string,new_string}, ...] }  同文件多处替换
     返回：
       成功: "已原子写入 N 个文件 (M 处修改): path1, path2, ..."
       失败: "编辑回滚: <file>: <reason>；已还原 X 个已写入文件"
  */
  edit_files: async (agent, args) => {
    const ops = args && args.ops;
    if (!Array.isArray(ops) || !ops.length) {
      const t = agent.tool("edit", "原子编辑被拒", String(args && args.path));
      t.done(false, "参数无效", false);
      return "错误: edit_files 需要 ops 参数（数组），每项 {path, old_string, new_string} 或 {path, edits:[{old_string,new_string}...]}。";
    }
    /* 展开成 per-file edits: fileEdits = [ { path, edits: [{old_string,new_string}], isNew } ]
       同一文件多次出现则合并到同一组（避免同一文件被两次写盘）。 */
    const byPath = new Map();
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op || typeof op.path !== "string" || !op.path) {
        const t = agent.tool("edit", "原子编辑被拒", "ops[" + i + "]");
        t.done(false, "ops[" + i + "] 缺少 path", false);
        return "错误: ops[" + i + "] 缺少 path（必须是字符串）。";
      }
      let fileEdits;
      if (Array.isArray(op.edits)) fileEdits = op.edits;
      else if (typeof op.old_string === "string") fileEdits = [{ old_string: op.old_string, new_string: op.new_string == null ? "" : String(op.new_string) }];
      else if (op.new_string != null || op.old_string != null) {
        const t = agent.tool("edit", "原子编辑被拒", op.path);
        t.done(false, "old_string/new_string 不完整", false);
        return "错误: ops[" + i + "] 提供 old_string/new_string 时必须成对给出；或改用 edits 数组。";
      } else {
        const t = agent.tool("edit", "原子编辑被拒", op.path);
        t.done(false, "缺少编辑内容", false);
        return "错误: ops[" + i + "]（" + op.path + "）既没有 edits 数组，也没有 old_string/new_string。";
      }
      if (byPath.has(op.path)) byPath.get(op.path).edits = byPath.get(op.path).edits.concat(fileEdits);
      else byPath.set(op.path, { path: op.path, root: op.root, edits: fileEdits });
    }
    const files = Array.from(byPath.values());

    /* 先判门（授权）：任何一个文件没有权限就整体拒绝，不写任何东西 */
    for (const f of files) {
      const res = locate(agent, { path: f.path, root: f.root }, true);
      if (!res.ok) {
        const t = agent.tool("edit", "原子编辑被拒", f.path);
        t.done(false, "没有授权", false);
        return "错误: " + res.error + "（" + f.path + " 没有写权限，整个 edit_files 调用已拒绝，未写入任何文件）";
      }
      f.store = res.root.active ? agent.files : res.store;
      f.rel = res.rel;
      f.shown = showPath({ path: f.path, root: f.root }, res);
      f.isNew = !f.store.exists(f.rel);
    }

    /* 再走 gate：按每个文件的 isNew 决定风险级别；任何一个被 gate 拦截/用户拒绝就整体回滚 */
    for (const f of files) {
      const gate = await agent._gate("edit_files", { path: f.path, root: f.root }, f.isNew ? "high" : "medium");
      if (gate.blocked) {
        const t = agent.tool("edit", "原子编辑被拒", f.shown);
        t.done(false, "被拒绝规则拦截", false);
        return "命令被拒绝规则拦截：" + f.shown + "（整个 edit_files 调用已拒绝，未写入任何文件）";
      }
      if (!gate.approved) {
        const t = agent.tool("edit", "原子编辑被拒", f.shown);
        t.done(false, "用户拒绝", false);
        return "用户拒绝了编辑文件：" + f.shown + "（整个 edit_files 调用已拒绝，未写入任何文件）";
      }
    }

    /* 应用前统一打一个检查点（原子性：全部成功才提交；部分失败则把已写入的文件还原） */
    const t = agent.tool("edit", "原子编辑", files.map((f) => f.shown).join(", "));
    /* 每个文件一份"落盘前快照"，和它自己的 store/rel 绑在同一个对象上。
       原先 written 里 push 的是 files 的元素，而快照存在另一个平行数组里 ——
       w.snap 因此恒为 undefined，回滚整段被 try/catch 咽掉，"全或无"其实是"改了一半也没事"。 */
    const jobs = files.map((f) => ({ f, snap: agent._snapshotBefore(f.rel, f.store) }));
    const written = [];
    /* 回滚：把已写入的文件还原为快照，还原口径与 _undoLast 逐字一致 ——
       snap.store 对当前工作区的文件**按设计是 null**（检查点靠 store||files 回到本工作区），
       判"原来有没有这个文件"要用 beforeExisted，不能用 beforeContent == null
       （一个原本内容为空字符串的文件会被当成"新建"而删掉）。
       还原失败绝不能静默：这是用户唯一知道"某次编辑只落了一半"的机会。 */
    const restoreFail = [];
    const rollback = () => {
      for (const w of written) {
        const store = w.snap.store || agent.files;
        try {
          if (w.snap.beforeExisted) {
            store.write(w.snap.path, w.snap.beforeContent);
            codeIndex.queueFileUpdate(store.dir, w.snap.path);
          } else {
            store.remove(w.snap.path);
            codeIndex.removeFile(store.dir, w.snap.path);
          }
          if (store === agent.files) agent.fileChanged(w.snap.path);
        } catch (e) { restoreFail.push(w.f.shown + "（" + e.message + "）"); }
      }
      if (restoreFail.length) agent.emit({ type: "term.line", text: "[原子编辑回滚失败] 这些文件没能动回来，需人工检查：" + restoreFail.join("、"), cls: "tl-err" });
      else if (written.some((w) => (w.snap.store || agent.files) === agent.files)) agent.pushChanges(false);
    };
    let totalEdits = 0;
    try {
      for (const j of jobs) {
        const f = j.f;
        const current = f.isNew ? "" : f.store.read(f.rel);
        const res2 = applyEditsToString(current, f.edits);
        const failed = (res2.edits || []).filter((r) => !r.ok);
        if (failed.length) {
          rollback();
          // 工具卡上要点名是哪个文件把整批打回来的，只说"编辑匹配失败"等于让人再猜一遍
          t.done(false, "编辑匹配失败 · " + f.shown, false);
          const first = failed[0];
          return "编辑回滚: " + f.path + " 处 old_string 不匹配（" + (first.error || "逐字且唯一") + "）。已还原 " + written.length + " 个已写入文件" +
            (restoreFail.length ? "，但有 " + restoreFail.length + " 个还原失败：" + restoreFail.join("、") : "") + "。请修正后重试。";
        }
        totalEdits += (res2.edits || []).length;
        try {
          f.store.write(f.rel, res2.modified);
          written.push(j);
          agent._recordWrite(f.rel);
          codeIndex.queueFileUpdate(f.store.dir, f.rel);
        } catch (e) {
          rollback();
          t.done(false, "写入失败 · " + f.shown, false);
          return "编辑回滚: " + f.path + " 写入失败（" + e.message + "）。已还原 " + written.length + " 个已写入文件" +
            (restoreFail.length ? "，但有 " + restoreFail.length + " 个还原失败：" + restoreFail.join("、") : "") + "。";
        }
      }
      /* 全部成功：提交检查点 */
      agent._pushCheckpoint(jobs.map((j) => j.snap), "原子编辑 " + files.length + " 个文件");
      const inWs = files.filter((f) => f.store === agent.files);
      for (const f of inWs) {
        agent.fileChanged(f.rel);
        agent.emit({ type: "editor.open", path: f.rel });
      }
      if (inWs.length) agent.pushChanges(false);
      t.done(true, "已写入 " + files.length + " 个文件，共 " + totalEdits + " 处修改", false);
      /* 与 write_file 同一条回灌路径：一批改完，把有诊断的那些文件一起报给模型，
         而不是等它下一轮 run_command 撞车才想起看错误。 */
      const diag = await diagBlock(agent, inWs.map((f) => f.rel));
      return "已原子写入 " + files.length + " 个文件（共 " + totalEdits + " 处修改）: " + files.map((f) => f.shown).join(", ") +
        "。/undo 可一键回滚本次全部改动。" + diag;
    } catch (e) {
      rollback();
      t.done(false, "原子编辑失败", false);
      return "编辑回滚: " + e.message + "。已还原 " + written.length + " 个已写入文件。";
    }
  },
};
