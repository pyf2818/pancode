"use strict";
/* 进程工具：run_command / start_process / stop_process / read_process / check_port */
const { AI_TERM_TAB } = require("../terminal");

module.exports = {
  run_command: async (agent, args) => {
    const gate = await agent._gate("run_command", { command: args.command }, "high");
    if (gate.blocked) {
      const t = agent.tool("terminal", "命令被拦截", args.command);
      t.done(false, "被拒绝规则拦截", false);
      return "命令被拒绝规则拦截，未执行：" + args.command;
    }
    if (!gate.approved) {
      const t = agent.tool("terminal", "命令被拒", args.command);
      t.done(false, "用户拒绝", false);
      return "用户拒绝了执行命令：" + args.command + (gate.reason ? "（" + gate.reason + "）" : "");
    }
    const t = agent.tool("terminal", "运行终端", args.command);
    agent.state(true, "AI 正在执行命令");
    const r = await agent.term.run(AI_TERM_TAB, args.command, null, { timeout: 90_000, strict: true, ai: true });
    if (r.blocked) {
      t.body("命令被安全沙箱拦截：" + args.command);
      t.done(false, "已拦截", false);
      return "命令被安全沙箱拦截，未执行";
    }
    t.body((r.out || "(无输出)").slice(-4000) + "\n\n(exit code " + r.code + ")");
    t.done(r.code === 0, r.code === 0 ? "退出码 0" : "退出码 " + r.code, r.code !== 0);
    agent.pushChanges(false);
    const errHint = r.code !== 0 && process.platform === "win32"
      ? "\n\n提示：当前为 Windows/cmd 环境，请检查命令是否用了 Linux 语法（`&` 后台、`grep`/`cat`/`ls`），应改用 `start /B`、`findstr`/`type`/`dir`。"
      : "";
    return "退出码: " + r.code + "\n输出:\n" + (r.out || "(无输出)").slice(-6000) + errHint;
  },

  start_process: async (agent, args) => {
    if (!agent.procs) return "错误：长驻进程层未初始化（服务需重启后生效）。";
    const gate = await agent._gate("start_process", { command: args.command }, "high");
    if (gate.blocked) { const t = agent.tool("terminal", "启动被拦截", args.command); t.done(false, "被拒绝规则拦截", false); return "命令被拒绝规则拦截，未执行：" + args.command; }
    if (!gate.approved) { const t = agent.tool("terminal", "启动被拒", args.command); t.done(false, "用户拒绝", false); return "用户拒绝了启动进程：" + args.command; }
    const t = agent.tool("terminal", "后台启动进程", "[" + args.name + "] " + args.command);
    const r = agent.procs.start(args.name, args.command);
    if (!r.ok) { t.body(r.error); t.done(false, "启动失败", false); return "启动失败: " + r.error; }
    t.body("进程已在后台启动，pid=" + r.pid + "。稍等片刻后可用 check_port 探测端口就绪、用 read_process 查看启动日志。");
    t.done(true, "pid " + r.pid, false);
    return "进程 [" + args.name + "] 已后台启动（pid " + r.pid + "）。下一步建议：check_port 探测服务端口 → read_process 查看日志确认启动成功。";
  },

  stop_process: async (agent, args) => {
    if (!agent.procs) return "错误：长驻进程层未初始化。";
    const t = agent.tool("terminal", "停止进程", String(args.name || ""));
    const r = agent.procs.stop(String(args.name || ""));
    if (!r.ok) { t.body(r.error); t.done(false, "未找到进程", false); return r.error; }
    t.done(true, "已停止", false);
    return "进程 [" + args.name + "] 已停止。";
  },

  read_process: async (agent, args) => {
    if (!agent.procs) return "错误：长驻进程层未初始化。";
    const t = agent.tool("terminal", "读取进程日志", String(args.name || ""));
    const r = agent.procs.read(String(args.name || ""), args.lines);
    if (!r.ok) { t.body(r.error); t.done(false, "读取失败", false); return r.error; }
    const out = r.output.slice(-4000);
    t.body(out);
    t.done(r.info.alive, r.info.alive ? "运行中 · " + r.info.outputLines + " 行" : "已退出 (exit " + r.info.exitCode + ")", false);
    return "进程 [" + args.name + "] " + (r.info.alive ? "运行中" : "已退出(exit " + r.info.exitCode + ")") + "（pid " + r.info.pid + "）\n最近输出:\n" + out;
  },

  check_port: async (agent, args) => {
    if (!agent.procs) return "错误：长驻进程层未初始化。";
    const t = agent.tool("read", "探测端口", String(args.port));
    const r = await agent.procs.probe(args.port, args.timeout);
    if (r.error) { t.body(r.error); t.done(false, "参数错误", false); return "错误: " + r.error; }
    t.body("端口 " + r.port + (r.open ? " : 可连接（服务就绪）" : " : 无响应"));
    t.done(true, r.open ? "端口开放" : "端口未开放", false);
    return "端口 " + r.port + (r.open ? " 可连接，服务已就绪。" : " 无响应（服务可能尚未启动/仍在启动中，可稍后重试或用 read_process 查看日志）。");
  },
};
