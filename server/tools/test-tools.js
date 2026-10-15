"use strict";
/* ============================================================
   P1-B3 · 测试运行器工具层：run_tests
   检测 / 收窄 / 解析都在 server/test-runner.js（纯函数，可单测）；
   这一层只做三件事：读 package.json、起进程、把回执交回模型。
   ============================================================ */
const TR = require("../test-runner");

function readPkg(agent) {
  try {
    const raw = agent.files && typeof agent.files.read === "function" ? agent.files.read("package.json") : null;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;      // 没有 package.json / JSON 坏了：交给"认不出测试命令"那条路径处理
  }
}

module.exports = {
  /* 跑这个项目的测试。与 run_command 的差别不在"执行"，而在**回执**：
     run_command 给的是 6000 字原始输出，run_tests 给的是"哪个文件的哪一行挂了几个用例"，
     外加退出码定生死（解析器永远没有权利把失败说成通过）。 */
  run_tests: async (agent, args) => {
    const pkg = readPkg(agent);
    const detected = pkg ? TR.detect(pkg) : { scripts: [], primary: null };
    const files = Array.isArray(args.files) ? args.files.slice(0, 20) : [];
    const plan = TR.build(detected, { files, script: args.script, command: args.command });

    if (plan.missing) {
      const t = agent.tool("read", "跑测试", "没找到测试命令");
      const menu = detected.scripts.map((s) => "  · " + s.key + " → " + s.command.slice(0, 80)).join("\n");
      const body = plan.note + (menu ? "\n可选的测试脚本：\n" + menu : "");
      t.body(body);
      t.done(false, "没有测试命令", false);
      return (pkg ? "跑不了测试：" + body : "这个工作区没有 package.json，认不出测试命令。请用 run_command 直接跑该项目的测试命令（例如 pytest / go test ./...）。")
        + "\n如果确实有测试命令，把它写进 package.json 的 scripts.test（或 test:* 里任选一个键），下次 run_tests 就能自己找到。";
    }

    const gate = await agent._gate("run_tests", { command: plan.command }, "medium");
    if (gate.blocked) {
      const t = agent.tool("terminal", "测试被拦截", plan.command);
      t.done(false, "被拒绝规则拦截", false);
      return "run_tests 被拒绝规则拦截，未执行：" + plan.command;
    }
    if (!gate.approved) {
      const t = agent.tool("terminal", "测试被拒", plan.command);
      t.done(false, "用户拒绝", false);
      return "用户拒绝了这次 run_tests：" + plan.command;
    }

    const label = plan.scoped ? files.length + " 个文件" : (plan.script || "自定义命令");
    const t = agent.tool("terminal", "跑测试", plan.command.slice(0, 80) + "（" + label + "）");
    agent.state(true, "正在跑测试");

    /* 测试比一般命令更容易长跑（编译 + 全量用例），默认给 10 分钟，模型可显式加到 30 分钟。
       超时的处理照 run_command 的老路：终止进程但把已有输出交回去，别让模型看到空结果就猜。 */
    const sec = Math.max(30, Math.min(1800, Math.round(Number(args.timeoutSec) || 600)));
    const { AI_TERM_TAB } = require("../terminal");
    const r = await agent.term.run(AI_TERM_TAB, plan.command, null, { timeout: sec * 1000, strict: true, ai: true });
    agent.state(false, "");

    if (r.blocked) {
      t.body("命令被安全沙箱拦截：" + plan.command);
      t.done(false, "已拦截", false);
      return "run_tests 的命令被安全沙箱拦截，未执行：" + plan.command + "\n请改用项目里既有的测试脚本（script 参数），或让用户手动跑。";
    }
    if (r.timedOut) {
      t.body(String(r.out || "").slice(-4000) + "\n\n[超时 " + sec + "s，进程已终止]");
      t.done(false, "超时 " + sec + "s", true);
      agent.pushChanges(false);
      return "测试跑到 " + sec + " 秒被终止，没等到退出码——所以现在还不能说它通过或失败。\n已产生的输出末尾：\n"
        + String(r.out || "(无输出)").slice(-4000)
        + "\n请用 files 参数把范围收到正在改的那几个测试文件，或把 timeoutSec 设大一些再跑。";
    }

    const res = TR.parse(plan.framework, r.out, r.code, { cwd: agent.files && agent.files.dir });
    const receipt = TR.format(res, { command: plan.command, scoped: plan.scoped });
    t.body(receipt.slice(0, 6000));
    t.done(res.ok,
      res.ok ? (res.passed != null ? res.passed + " 个用例通过" : "通过")
        : (res.failed != null ? res.failed + " 个失败" : "退出码 " + res.code),
      !res.ok);
    agent.pushChanges(false);

    /* 丢掉了几个文件必须说：否则模型以为"这轮已经覆盖到那两个文件了"，
       而实际跑的范围比它以为的小 —— 那比报错更危险。 */
    const dropNote = plan.dropped
      ? "（有 " + plan.dropped + " 个文件路径不合规则已被忽略" + (plan.scoped ? "，只跑了其余 " + (plan.files || []).length + " 个" : "，因此按整串命令跑") + "）"
      : "";
    return dropNote + (plan.note ? "（" + plan.note + "）" : "") + receipt;
  },
};
