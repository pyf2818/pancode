"use strict";
/* Git 工具：git_status / git_diff / git_log / git_commit / git_branch
   + P1-B2 工作流：git_fetch / git_push / git_pull / git_stash / git_blame / git_reset */
module.exports = {
  git_status: async (agent, args) => {
    const t = agent.tool("read", "Git 状态", "git status");
    const info = agent.git.info();
    const changes = await agent.git.changes();
    const txt = "仓库: " + (info.git ? "Git · 分支 " + info.branch : "无 Git（快照模式）") + "\n变更 " + changes.length + " 个文件:\n" + (changes.map((c) => "  [" + c.status + "] " + c.path).join("\n") || "  (无改动)");
    t.body(txt);
    t.done(true, changes.length + " 处改动");
    return txt;
  },

  git_diff: async (agent, args) => {
    const t = agent.tool("read", "Git diff", args.path || "git diff --stat");
    const r = await agent.git.diff(args.path);
    if (!r.ok) { t.body(r.error); t.done(false, "diff 失败", false); return "Git diff 失败: " + r.error; }
    const out = (r.diff || r.stat || "").slice(0, 6000);
    t.body(out);
    t.done(true, r.diff ? "diff 文本" : "统计概览");
    return out;
  },

  git_log: async (agent, args) => {
    const t = agent.tool("read", "Git 历史", "git log");
    const r = await agent.git.log(args.count);
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
    const r = await agent.git.commit(args.message, args.files);
    if (!r.ok) { t.body(r.error || "无可提交改动"); t.done(false, r.nothing ? "无改动可提交" : "提交失败", false); return "Git 提交失败: " + (r.error || (r.nothing ? "当前没有可提交的改动" : "未知错误")); }
    t.done(true, "已提交 " + r.committed + " 个文件", false);
    agent.pushChanges(false);
    return "提交成功（" + r.committed + " 个文件）:\n" + r.summary;
  },

  git_branch: async (agent, args) => {
    const action = args.action || "list";
    if (action === "list") {
      const t = agent.tool("read", "Git 分支", "git branch");
      const r = await agent.git.branches();
      if (!r.ok) { t.body(r.error); t.done(false, "失败", false); return "失败: " + r.error; }
      t.body(r.branches);
      t.done(true, "当前: " + r.current);
      return "分支清单:\n" + r.branches;
    }
    if (action === "create" || action === "switch") {
      const gate = await agent._gate("git_branch", { action, name: args.name });
      if (gate.blocked) { const t = agent.tool("edit", "分支操作被拦截", args.name); t.done(false, "被拒绝规则拦截", false); return "分支操作被拒绝规则拦截。"; }
      if (!gate.approved) { const t = agent.tool("edit", "分支操作被拒", args.name); t.done(false, "用户拒绝", false); return "用户拒绝了分支" + (action === "create" ? "创建" : "切换") + "：" + args.name; }
      const t = agent.tool("edit", action === "create" ? "创建分支" : "切换分支", String(args.name || ""));
      const r = await agent.git.checkout(args.name, action === "create");
      if (!r.ok) { t.body(r.error); t.done(false, "失败", false); return "分支操作失败: " + r.error; }
      t.done(true, "当前: " + r.branch, false);
      return (r.created ? "已创建并切换到分支: " : "已切换到分支: ") + r.branch;
    }
    if (action === "delete") {
      /* 删除走高危：分支名没了以后要靠 reflog 找回，而 reflog 会过期。
         未合并的分支在 git.js 里还有一道（不带 force 直接拒），这里是第二道。 */
      const gate = await agent._gate("git_branch", { action: "delete", name: args.name }, "high");
      if (gate.blocked) { const t = agent.tool("edit", "删除分支被拦截", args.name); t.done(false, "被拒绝规则拦截", false); return "删除分支被拒绝规则拦截。"; }
      if (!gate.approved) { const t = agent.tool("edit", "删除分支被拒", args.name); t.done(false, "用户拒绝", false); return "用户拒绝了删除分支：" + args.name; }
      const t = agent.tool("edit", "删除分支", String(args.name || ""));
      const r = await agent.git.deleteBranch(args.name, args.force === true);
      if (!r.ok) { t.body(r.error); t.done(false, r.unmerged ? "未合并" : "失败", false); return "删除分支失败: " + r.error + (r.unmerged ? "\n（确实要删请带 force:true 再说一次）" : ""); }
      t.done(true, "已删除 " + r.branch, false);
      return "已删除分支: " + r.branch + (r.forced ? "（含未合并改动，强删）" : "");
    }
    const t = agent.tool("read", "Git 分支", "git branch");
    t.done(false, "未知动作", false);
    return "git_branch 只支持 list / create / switch / delete，收到：" + action;
  },

  /* ---------- P1-B2 · 同步与历史 ---------- */

  git_fetch: async (agent, args) => {
    const t = agent.tool("read", "Git 抓取", "git fetch");
    const r = await agent.git.fetch(args.remote);
    if (!r.ok) { t.body(r.error); t.done(false, r.noRemote ? "没有远端" : "fetch 失败", false); return "fetch 失败: " + r.error; }
    t.body(r.report || "(远端无新引用)");
    t.done(true, "已抓取 " + r.remote, false);
    /* fetch 只动 .git 里的远端跟踪引用，不碰工作区——所以它不需要审批，也不该被说成"更新了什么"：
       模型接下来要看的是 behind 数，不是这段 stderr。 */
    const st = await agent.git.branchState();
    return "已 fetch " + r.remote + "。" + (st.ok ? "当前分支 " + st.branch + "：领先 " + st.ahead + "、落后 " + st.behind + "。" : "") +
      (r.report ? "\n" + r.report.slice(0, 300) : "");
  },

  /* 推送。默认只做 dry-run ——
     推出去的东西别人可能已经拉走，这是这套工具里唯一"撤不回来"的一步（C-L5 就是这条），
     所以真推必须显式 confirm:true，并且契约里标了 irreversible：全自动模式下也会停下来问人。 */
  git_push: async (agent, args) => {
    const wantReal = args.confirm === true;
    if (!wantReal) {
      const t = agent.tool("read", "预演推送", "git push --dry-run");
      const r = await agent.git.pushDryRun();
      if (!r.ok) { t.body(r.error); t.done(false, r.noRemote ? "没有远端" : "预演失败", false); return "推送预演失败: " + r.error; }
      t.body(r.report);
      t.done(true, (r.newBranch ? "新分支" : "将更新") + " " + r.remote + "/" + r.branch, false);
      return "【未推送，仅预演】将推到 " + r.remote + "/" + r.branch +
        (r.newBranch ? "（新分支）" : "：领先 " + r.ahead + "、落后 " + r.behind) +
        (r.upstream ? "" : "；该分支还没有上游，真推会带 -u 建立跟踪") +
        "。\n预演输出：" + (r.report || "(无变化)") +
        "\n确认可推之后，用 {confirm:true} 再调一次 git_push 才会真的推出去。";
    }
    const st = await agent.git.branchState();
    const gate = await agent._gate("git_push", { branch: st.branch || "", action: "push" }, "high");
    if (gate.blocked) { const t2 = agent.tool("edit", "推送被拦截", "git push"); t2.done(false, "被拒绝规则拦截", false); return "推送被拒绝规则拦截，未执行。"; }
    if (!gate.approved) { const t2 = agent.tool("edit", "推送被拒", "git push"); t2.done(false, "用户拒绝", false); return "用户拒绝了这次推送，未执行。"; }
    const t = agent.tool("edit", "Git 推送", "push " + (st.branch || ""));
    const r = await agent.git.push(!st.upstream);
    if (!r.ok) { t.body(r.error); t.done(false, r.rejected ? "被远端拒绝" : r.network ? "连不上远端" : "推送失败", false); return "推送失败: " + r.error; }
    t.done(true, "已推送 " + r.branch, false);
    agent.pushChanges(false);
    return "已推送到 " + r.remote + "/" + r.branch + (r.summary ? "：" + r.summary : "");
  },

  git_pull: async (agent, args) => {
    const gate = await agent._gate("git_pull", { action: "pull" }, "medium");
    if (gate.blocked) { const t = agent.tool("edit", "拉取被拦截", "git pull"); t.done(false, "被拒绝规则拦截", false); return "拉取被拒绝规则拦截。"; }
    if (!gate.approved) { const t = agent.tool("edit", "拉取被拒", "git pull"); t.done(false, "用户拒绝", false); return "用户拒绝了这次拉取。"; }
    const t = agent.tool("edit", "Git 拉取", "git pull --ff-only");
    const r = await agent.git.pull();
    if (!r.ok) {
      t.body(r.error);
      t.done(false, r.diverged ? "已分叉" : r.dirty ? "工作区不干净" : r.noUpstream ? "没有上游" : "拉取失败", false);
      /* 分叉与脏工作区不是"失败"，是"需要人来决定"——把选择说清楚，别让模型去猜一条合并策略 */
      return "未拉取：" + r.error;
    }
    t.body(r.report);
    t.done(true, "已快进", false);
    agent.pushChanges(false);
    return "已拉取（--ff-only 快进）:\n" + r.report;
  },

  git_stash: async (agent, args) => {
    const action = args.action || "list";
    if (action !== "list") {
      const gate = await agent._gate("git_stash", { action }, action === "drop" ? "high" : "medium");
      if (gate.blocked) { const t = agent.tool("edit", "暂存被拦截", "git stash " + action); t.done(false, "被拒绝规则拦截", false); return "暂存操作被拒绝规则拦截。"; }
      if (!gate.approved) { const t = agent.tool("edit", "暂存被拒", "git stash " + action); t.done(false, "用户拒绝", false); return "用户拒绝了 git stash " + action + "。"; }
    }
    const t = agent.tool(action === "list" ? "read" : "edit", "Git 暂存", "git stash " + action);
    const r = await agent.git.stash(action, args.message);
    if (!r.ok) { t.body(r.error); t.done(false, r.empty ? "没有可暂存的改动" : "失败", false); return "暂存操作失败: " + r.error; }
    if (action === "list") {
      const n = (r.list || []).length;
      t.body(r.report || "(空)");
      t.done(true, n + " 条暂存", false);
      return n ? "暂存栈（" + n + " 条）:\n" + r.list.join("\n") : "暂存栈是空的。";
    }
    t.body(r.report);
    t.done(true, "已 " + action, false);
    agent.pushChanges(false);
    return "git stash " + action + " 完成：" + (r.report || "").slice(0, 300);
  },

  git_blame: async (agent, args) => {
    const t = agent.tool("read", "Git 追责", args.path || "git blame");
    const r = await agent.git.blame(args.path, args.line, args.lineEnd);
    if (!r.ok) { t.body(r.error); t.done(false, "blame 失败", false); return "blame 失败: " + r.error; }
    if (!r.commits.length) { t.done(true, "无归属信息", false); return r.path + " 第 " + r.from + "-" + r.to + " 行没有 blame 记录（可能未跟踪或从未提交）。"; }
    const txt = r.commits.map((c) => c.sha + "  " + (c.author || "?") + "  " +
      (c.ts ? new Date(c.ts * 1000).toISOString().slice(0, 10) + "  " : "") + (c.summary || "")).join("\n");
    t.body(txt);
    t.done(true, r.commits.length + " 个提交", false);
    return r.path + " 第 " + r.from + "-" + r.to + " 行来自 " + r.commits.length + " 个提交:\n" + txt;
  },

  /* 回退指针。hard 在服务层就被拒（git.js 里那条），这里不给它开第二条路：
     --hard 抹掉的是用户工作区里没提交的东西，Agent 无从判断那值不值钱。 */
  git_reset: async (agent, args) => {
    const mode = args.mode || "mixed";
    const t0 = agent.tool("edit", "Git 回退", "reset --" + mode + " " + (args.target || ""));
    if (mode === "hard") { t0.done(false, "被拒绝", false); return "拒绝执行 git reset --hard：它会抹掉工作区里未提交的改动。要用户自己来。"; }
    const gate = await agent._gate("git_reset", { mode, target: String(args.target || "") }, "high");
    if (gate.blocked) { t0.done(false, "被拒绝规则拦截", false); return "回退被拒绝规则拦截。"; }
    if (!gate.approved) { t0.done(false, "用户拒绝", false); return "用户拒绝了这次回退。"; }
    const r = await agent.git.reset(mode, args.target);
    if (!r.ok) { t0.body(r.error); t0.done(false, r.refused ? "档位被拒" : "回退失败", false); return "回退失败: " + r.error; }
    t0.body("HEAD " + r.from + " → " + r.to + "\n" + r.keptFiles);
    t0.done(true, "已 " + mode + " 回退到 " + r.to, false);
    agent.pushChanges(false);
    return "已 git reset --" + mode + " " + args.target + "（" + r.from + " → " + r.to + "）。" + r.keptFiles + "。";
  },

  /* ---------- P-M1 · worktree 隔离副本 ----------
     为什么给 Agent 这个能力：用户说"另开一份改改看，别碰我现在这套"时，
     切分支会把他的未提交改动一起带走，克隆一份又慢又要重新授权目录；
     worktree 与主检出共享同一个对象库，开出来只是多一个目录，两边互不可见。
     三道判断：
       · list 纯读免确认；
       · add 建目录 + 建分支 → mutating，走普通审批门；
       · remove 会连着删掉副本里未提交的改动 → 标 irreversible + high 门，
         全自动模式下也会停下来问人（与 git_push 同一档理由：撤不回来）。 */
  git_worktree: async (agent, args) => {
    const action = String(args.action || "list");
    if (action === "list") {
      const t = agent.tool("read", "Git 副本清单", "git worktree list");
      const r = await agent.git.worktrees();
      if (!r.ok) { t.body(r.error); t.done(false, "失败", false); return "副本清单失败: " + r.error; }
      const rows = r.worktrees || [];
      t.body(rows.map((w) => (w.current ? "* " : "  ") + (w.branch || "(游离)") + " → " + w.path).join("\n") || "（只有主检出）");
      t.done(true, rows.length + " 份");
      return "仓库根 " + r.repoRoot + "，共 " + rows.length + " 份检出：\n" + rows.map((w) =>
        "- 分支 " + (w.branch || "(detached)") + " @ " + w.path
        + (w.main ? " [主检出]" : "") + (w.current ? " [当前工作区在这份里]" : "")
        + (w.exists ? "" : " [目录已不在盘上，可 git_worktree remove 清登记]")
        + (w.detached ? " [游离 HEAD]" : "")).join("\n");
    }
    if (action === "add") {
      const gate = await agent._gate("git_worktree", { action: "add", name: String(args.name || "") });
      if (gate.blocked) { const t = agent.tool("edit", "开副本被拦截", args.name); t.done(false, "被拒绝规则拦截", false); return "开副本被拒绝规则拦截。"; }
      if (!gate.approved) { const t = agent.tool("edit", "开副本被拒", args.name); t.done(false, "用户拒绝", false); return "用户拒绝了这次开副本：" + args.name; }
      const t = agent.tool("edit", "开独立副本", String(args.name || ""));
      const r = await agent.git.addWorktree(args.name, { base: args.base });
      if (!r.ok) { t.body(r.error); t.done(false, "失败", false); return "开副本失败: " + r.error; }
      t.body(r.report || "");
      t.done(true, r.branch + " → " + require("path").basename(r.path), false);
      /* 回执必须说清"这份不在当前工作区里"：不然模型会按主工作区的相对路径去读它，
         读到一个根本不存在的文件，然后开始怀疑自己刚才白改了。 */
      return "已开独立副本（" + (r.reusedBranch ? "检出已有分支 " : "新建分支 ") + r.branch + "，基线 " + r.base + "）：\n"
        + "  目录 " + r.path + "\n"
        + "  这份与主检出互不影响：在这里写的文件不会出现在当前工作区的改动列表里。\n"
        + "  要在里面干活：把 path 写成 " + r.dir + "/" + String(args.name || "").trim() + "/xxx 即可（它就在仓库内，当前工作区能直接读写）；"
        + "或者让用户切到那份目录去（设置 · 通用 · 独立工作副本）。";
    }
    if (action === "remove") {
      const gate = await agent._gate("git_worktree", { action: "remove", name: String(args.name || args.path || "") }, "high");
      if (gate.blocked) { const t = agent.tool("edit", "移除副本被拦截", args.name || args.path); t.done(false, "被拒绝规则拦截", false); return "移除副本被拒绝规则拦截。"; }
      if (!gate.approved) { const t = agent.tool("edit", "移除副本被拒", args.name || args.path); t.done(false, "用户拒绝", false); return "用户拒绝了这次移除副本。"; }
      const t = agent.tool("edit", "移除独立副本", String(args.name || args.path || ""));
      const r = await agent.git.removeWorktree(args.name || args.path, args.force === true);
      if (!r.ok) { t.body(r.error); t.done(false, r.dirty ? "有未提交改动" : "失败", false); return "移除副本失败: " + r.error + (r.dirty ? "\n（副本里有未提交/未跟踪的东西，确认要一起删请带 force:true 再说一次）" : ""); }
      t.done(true, "已移除", false);
      return "已移除副本 " + r.removed + (r.forced ? "（连同其中未提交的改动一起删掉）" : "") + "。分支 "
        + "仍保留在仓库里，需要删分支请用 git_branch delete。";
    }
    const t = agent.tool("read", "Git 副本", "git worktree");
    t.done(false, "未知动作", false);
    return "git_worktree 只支持 list / add / remove，收到：" + action;
  },
};
