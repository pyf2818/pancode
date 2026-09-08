"use strict";
/* Git 工具：git_status / git_diff / git_log / git_commit / git_branch */
module.exports = {
  git_status: async (agent, args) => {
    const t = agent.tool("read", "Git 状态", "git status");
    const info = agent.git.info();
    const changes = agent.git.changes();
    const txt = "仓库: " + (info.git ? "Git · 分支 " + info.branch : "无 Git（快照模式）") + "\n变更 " + changes.length + " 个文件:\n" + (changes.map((c) => "  [" + c.status + "] " + c.path).join("\n") || "  (无改动)");
    t.body(txt);
    t.done(true, changes.length + " 处改动");
    return txt;
  },

  git_diff: async (agent, args) => {
    const t = agent.tool("read", "Git diff", args.path || "git diff --stat");
    const r = agent.git.diff(args.path);
    if (!r.ok) { t.body(r.error); t.done(false, "diff 失败", false); return "Git diff 失败: " + r.error; }
    const out = (r.diff || r.stat || "").slice(0, 6000);
    t.body(out);
    t.done(true, r.diff ? "diff 文本" : "统计概览");
    return out;
  },

  git_log: async (agent, args) => {
    const t = agent.tool("read", "Git 历史", "git log");
    const r = agent.git.log(args.count);
    if (!r.ok) { t.body(r.error); t.done(false, "log 失败", false); return "Git log 失败: " + r.error; }
    t.body(r.log);
    t.done(true, "最近提交");
    return r.log;
  },

  git_commit: async (agent, args) => {
    const gate = await agent._gate("git_commit", { message: args.message });
    if (gate.blocked) { const t = agent.tool("edit", "提交被拦截", args.message); t.done(false, "被拒绝规则拦截", false); return "提交被拒绝规则拦截，未执行。"; }
    if (!gate.approved) { const t = agent.tool("edit", "提交被拒", args.message); t.done(false, "用户拒绝", false); return "用户拒绝了本次提交：" + args.message; }
    const t = agent.tool("edit", "Git 提交", String(args.message || "").slice(0, 60));
    const r = agent.git.commit(args.message, args.files);
    if (!r.ok) { t.body(r.error || "无可提交改动"); t.done(false, r.nothing ? "无改动可提交" : "提交失败", false); return "Git 提交失败: " + (r.error || (r.nothing ? "当前没有可提交的改动" : "未知错误")); }
    t.done(true, "已提交 " + r.committed + " 个文件", false);
    agent.pushChanges(false);
    return "提交成功（" + r.committed + " 个文件）:\n" + r.summary;
  },

  git_branch: async (agent, args) => {
    const action = args.action || "list";
    if (action === "list") {
      const t = agent.tool("read", "Git 分支", "git branch");
      const r = agent.git.branches();
      if (!r.ok) { t.body(r.error); t.done(false, "失败", false); return "失败: " + r.error; }
      t.body(r.branches);
      t.done(true, "当前: " + r.current);
      return "分支清单:\n" + r.branches;
    }
    const gate = await agent._gate("git_branch", { action, name: args.name });
    if (gate.blocked) { const t = agent.tool("edit", "分支操作被拦截", args.name); t.done(false, "被拒绝规则拦截", false); return "分支操作被拒绝规则拦截。"; }
    if (!gate.approved) { const t = agent.tool("edit", "分支操作被拒", args.name); t.done(false, "用户拒绝", false); return "用户拒绝了分支" + (action === "create" ? "创建" : "切换") + "：" + args.name; }
    const t = agent.tool("edit", action === "create" ? "创建分支" : "切换分支", String(args.name || ""));
    const r = agent.git.checkout(args.name, action === "create");
    if (!r.ok) { t.body(r.error); t.done(false, "失败", false); return "分支操作失败: " + r.error; }
    t.done(true, "当前: " + r.branch, false);
    return (r.created ? "已创建并切换到分支: " : "已切换到分支: ") + r.branch;
  },
};
