"use strict";
/* 文件工具：list_files / read_file / write_file / apply_edit / delete_file / search_code */
const codeIndex = require("../code-index");
const { getActiveManager } = require("../lsp-bridge");
const { computeDiffLines, fmtDiag } = require("./util");

module.exports = {
  list_files: async (agent, args) => {
    const t = agent.tool("read", "列出文件", "workspace/");
    const list = agent.files.list();
    t.body(list.join("\n"));
    t.done(true, list.length + " 个文件");
    return list.join("\n") || "(空工作区)";
  },

  read_file: async (agent, args) => {
    if (!args.path || typeof args.path !== "string") {
      const t = agent.tool("read", "读取文件", String(args.path));
      t.done(false, "路径为空");
      return "错误: 未提供有效的文件路径（path 参数缺失或为空）。请提供要读取的文件相对路径，如 src/app.js。";
    }
    const t = agent.tool("read", "读取文件", args.path);
    try {
      const txt = agent.files.read(args.path);
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
    const isNew = !agent.files.exists(args.path);
    const gate = await agent._gate("write_file", { path: args.path, content: args.content }, isNew ? "high" : "medium");
    if (gate.blocked) {
      const t = agent.tool("edit", "创建被拒", args.path); t.done(false, "被拒绝规则拦截", false);
      return "命令被拒绝规则拦截：" + args.path;
    }
    if (!gate.approved) {
      const t = agent.tool("edit", isNew ? "创建被拒" : "编辑被拒", args.path);
      t.done(false, "用户拒绝", false);
      return "用户拒绝了" + (isNew ? "创建" : "写入") + "文件：" + args.path + (gate.reason ? "（" + gate.reason + "）" : "");
    }
    const t = agent.tool("edit", isNew ? "创建文件" : "编辑文件", args.path);
    try {
      const snap = agent._snapshotBefore(args.path);
      agent._pushCheckpoint([snap], (isNew ? "创建 " : "写入 ") + args.path);
      agent.files.write(args.path, args.content);
      codeIndex.queueFileUpdate(agent.files.dir, args.path);
      agent.fileChanged(args.path);
      agent.pushChanges(false);
      const st = require("../agent-base").diffStat(isNew ? "" : snap.beforeContent, args.content);
      t.body((isNew ? "(新文件)\n" : "") + args.content.split("\n").slice(0, 30).join("\n"));
      t.done(true, "+" + st.add + " −" + st.del, false);
      agent.emit({ type: "editor.open", path: args.path });
      if (!isNew && snap.beforeContent != null) {
        const _diffLines = computeDiffLines(snap.beforeContent, args.content);
        if (_diffLines.length) agent.emit({ type: "editor.diff", path: args.path, added: _diffLines });
      }
      let _result = "写入成功: " + args.path;
      try {
        const _mgr = getActiveManager();
        if (_mgr) {
          await new Promise((r) => setTimeout(r, 400));
          const _d = _mgr.getDiagnostics(agent.files.dir, args.path);
          if (_d.scope === "file" && _d.items && _d.items.length) {
            const _errs = _d.items.filter((x) => x.severity === 1);
            const _warns = _d.items.filter((x) => x.severity === 2);
            if (_errs.length || _warns.length) {
              _result += "\n\n【LSP 诊断】" + _errs.length + " 个错误、" + _warns.length + " 个警告：\n" + _d.items.slice(0, 10).map(fmtDiag).join("\n");
              if (_errs.length) _result += "\n建议修复上述错误后再继续。";
            }
          }
        }
      } catch (e) { /* LSP 诊断失败不影响写入 */ }
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
      return "已自动写入 " + applied.length + " 个文件改动（" + paths.join(", ") + "）。";
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
      "不要对同一个文件改用 write_file 整文件覆盖。";
  },

  delete_file: async (agent, args) => {
    if (!args.path || typeof args.path !== "string") {
      const t = agent.tool("edit", "删除被拒", String(args.path)); t.done(false, "路径为空", false);
      return "错误: 未提供有效的文件路径（path 参数缺失或为空）。";
    }
    const gate = await agent._gate("delete_file", { path: args.path }, "high");
    if (gate.blocked) {
      const t = agent.tool("edit", "删除被拒", args.path); t.done(false, "被拒绝规则拦截", false);
      return "命令被拒绝规则拦截：" + args.path;
    }
    if (!gate.approved) {
      const t = agent.tool("edit", "删除被拒", args.path);
      t.done(false, "用户拒绝", false);
      return "用户拒绝了删除文件：" + args.path + (gate.reason ? "（" + gate.reason + "）" : "");
    }
    const t = agent.tool("edit", "删除文件", args.path);
    try {
      agent._pushCheckpoint([agent._snapshotBefore(args.path)], "删除 " + args.path);
      agent.files.remove(args.path);
      codeIndex.removeFile(agent.files.dir, args.path);
      agent.fileChanged(args.path);
      agent.pushChanges(false);
      t.done(true, "已删除");
      return "删除成功: " + args.path;
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
};
