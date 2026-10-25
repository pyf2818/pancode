"use strict";
/* Agent 工具：agent / orchestrate / board / undo */
const { Orchestrator } = require("../orchestrator");
const { currentSub } = require("../sub-context");

module.exports = {
  undo: async (agent, args) => {
    const t = agent.tool("edit", "撤销上一步", "undo");
    const r = agent._undoLast();
    if (!r.ok) {
      if (r.reason === "empty") {
        t.done(false, "无可撤销", false);
        /* reason=empty 只在"内存栈空 + 影子仓不可用"时出现：
           这句话以前写"重启后检查点已清空"，而重启后其实还能从影子快照退一步 —— 说少了会让用户白放弃。 */
        return "当前没有可撤销的改动：本次运行没执行过写入 / 编辑 / 删除，这台引擎也没有可用的影子快照"
          + "（未配置工作区或影子仓身份校验未通过，详见服务端日志）。";
      }
      if (/没有可回退的检查点/.test(String(r.reason || ""))) {
        t.done(false, "无可撤销", false);
        return "没有可撤销的改动了：本次运行的改动栈是空的，影子快照里也没有可回退的检查点"
          + "（初始全量快照与回退记录都不算一步，退它们不是撤销）。";
      }
      t.done(false, "撤销失败", false);
      return "撤销失败：" + (r.reason || "未知错误");
    }
    /* shadow 回退那条路径除了"恢复旧内容"还会"删掉那一步新建的文件"。
       只报 restored 等于删了文件却不吭声 —— 回执里的数字必须等于真的动了几个文件。 */
    const restored = r.restored || [];
    const removed = r.removed || [];
    const bits = [];
    if (restored.length) bits.push("恢复 " + restored.length + " 个文件：" + restored.join(", "));
    if (removed.length) bits.push("删掉那一步新建的 " + removed.length + " 个文件：" + removed.join(", "));
    const line = bits.join("；") || "没有文件需要还原";
    t.body("已撤销：" + r.label + "\n" + line);
    t.done(true, "已撤销 " + (restored.length + removed.length) + " 个文件", false);
    return "已撤销操作「" + r.label + "」，" + line + "。";
  },

  agent: async (agent, args) => {
    const t = agent.tool("agent", "子智能体", args.task);
    agent.state(true, "子智能体执行中");
    const rep = {};
    try {
      // W2：专家人设透传；rep 是这一步的出参（改了哪些文件、撞了几次车、写了什么白板）
      const result = await agent.runSubAgent(args.task, { subagent_type: args.subagent_type, expert: args.expert, report: rep });
      const files = rep.changedFiles || [];
      const conf = rep.conflicts || [];
      const notes = rep.boardNotes || [];
      const attribution = (files.length || conf.length || notes.length)
        ? "\n\n【这一步的归属】\n"
          + (files.length ? "改动 " + files.length + " 个文件：" + files.join(", ") + "\n" : "未认领任何文件的改盘权\n")
          + (conf.length ? "被并行冲突挡回 " + conf.length + " 次：" + conf.map((c) => c.path + "（正被「" + c.by + "」写着）").join("、") + "\n" : "")
          + (notes.length ? "它写上白板的：\n" + notes.map((b) => "- [" + b.kind + "] " + (b.key ? b.key + "：" : "") + b.text).join("\n") + "\n" : "")
        : "";
      t.body((files.length ? "改动 " + files.length + " 个文件：" + files.join(", ") + "\n" : "未改盘\n")
        + (result || "(子智能体无返回)").slice(0, 6000));
      t.done(true, "子智能体完成");
      agent.state(false, "AI 思考中");
      return "子智能体已完成子任务「" + args.task + "」，汇报如下：\n\n" + (result || "(无返回)") + attribution;
    } catch (e) {
      t.done(false, "子智能体失败");
      agent.state(false, "AI 思考中");
      return "子智能体执行失败：" + e.message;
    }
  },

  orchestrate: async (agent, args) => {
    const t = agent.tool("agent", "多 Agent 编排", args.title || "编排");
    agent.state(true, "编排执行中");
    try {
      const orch = new Orchestrator(agent);
      const result = await orch.run({ title: args.title, steps: args.steps });
      t.body((result.fullReport || result.summary || "").slice(0, 8000));
      t.done(result.ok !== false, result.summary || "编排完成");
      agent.state(false, "AI 思考中");
      /* 模型序走结构化汇报（每步一行：状态/耗时/改了哪些文件/结论摘要），
         长文留在工具卡里给人看。以前是 fullReport 截 6000 字直接摊给模型，
         一次编排能把上下文吃掉一大截，而且模型还得自己在散文里找"到底改了哪几个文件"。 */
      return result.summary + "\n\n" + (result.modelReport || (result.fullReport || "").slice(0, 6000));
    } catch (e) {
      t.done(false, "编排失败");
      agent.state(false, "AI 思考中");
      return "多 Agent 编排执行失败：" + e.message;
    }
  },

  /* 共享白板：一次编排一块，只在运行内活着。写进去的条目会被编排器随下游步骤一起发过去，
     兄弟步骤因此不必各自把同一段代码调研第二遍。 */
  board: async (agent, args) => {
    const sub = currentSub();
    const writing = args.action === "write";
    const t = agent.tool("tool", "编排白板", writing ? "写一条" : "读");
    if (!sub || !sub.board) {
      t.done(false, "没有可写的板");
      return "现在没有正在进行的编排，这块板没人读。board 是给子智能体（agent / orchestrate 派出去的那一步）用的；"
        + "你如果是父智能体，要把判断留给后面几步就写进给用户的汇报，或直接改代码。";
    }
    if (!writing) {
      const body = sub.board.render(null);
      t.body(body || "(白板还是空的)");
      t.done(true, sub.board.items.length + " 条");
      return body
        ? "共享白板（本次编排，共 " + sub.board.items.length + " 条，含你自己写的）：\n" + body
        : "共享白板现在是空的 —— 还没有兄弟步骤留下结论，按需自己查。";
    }
    const r = sub.board.post(sub.from, args.kind, args.key, args.text);
    if (!r.ok) {
      t.done(false, "没写进去");
      return "这条没写进白板：正文是空的。board action=write 要带 text（一句话说清结论）。";
    }
    t.body(String(args.text || "").slice(0, 600));
    t.done(true, "已记录");
    return "已写上白板（第 " + r.n + " 条" + (r.truncated ? "，超过 600 字的部分已截掉" : "") + "）："
      + (args.key ? args.key + " — " : "") + String(args.text).slice(0, 120)
      + "。同批兄弟步骤下一步就能看到；父智能体只看各步骤的结构化汇报，这条要让它也知道，请同时写进你的最终汇报。";
  },
};
