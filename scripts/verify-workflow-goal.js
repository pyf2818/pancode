/* 验证 ⑪ 工作流模板 / goal 目标驱动
 * 用 LlmAgent 原型 + 最小 mock 字段驱动 execTool，覆盖：
 *   list_templates / instantiate_template / save_template / remove_template / set_goal / goal_status
 *   + goal 持久化 + {goal} 占位符替换
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LlmAgent } = require("../server/agent-llm");
const { PlanStore } = require("../server/plan-store");
const { WorkflowStore, fillGoal } = require("../server/workflow-store");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name); }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-wf-"));
  const a = Object.create(LlmAgent.prototype);
  a.cfg = { planMode: false };
  a._currentConv = "c1";
  a.emit = () => {};
  a.plan = new PlanStore(path.join(tmp, "plans.json"));
  a.workflows = new WorkflowStore(path.join(tmp, "wf.json"));
  a._goalPath = path.join(tmp, "goal.json");
  a._goal = a._loadGoal();

  console.log("== ⑪ 工作流模板 / goal ==");

  // 1. list_templates 含 5 个内置
  const lst = await a.execTool("list_templates", {});
  ok("list_templates 含 feature", /feature/.test(lst));
  ok("list_templates 含 bugfix/refactor/test/docs", /bugfix/.test(lst) && /refactor/.test(lst) && /test/.test(lst) && /docs/.test(lst));

  // 2. instantiate_template（内置，替换标题 {goal}）
  const inst = await a.execTool("instantiate_template", { name: "feature", goal: "用户登录模块" });
  ok("instantiate feature 成功", /已用模板/.test(inst) && /用户登录模块/.test(inst));
  const active1 = a.plan.getActive("c1");
  ok("生成计划标题含目标", active1 && active1.title.includes("用户登录模块"));
  ok("生成计划 6 步", active1 && active1.tasks.length === 6);

  // 3. 保存自定义模板（含 {goal} 占位），再实例化验证占位替换
  const saved = await a.execTool("save_template", { name: "myrel", description: "发布流程", title: "发布：{goal}", tasks: ["准备 {goal} 的构建", "发布并验证"] });
  ok("save_template 成功", /已保存模板：myrel/.test(saved));
  const found = a.workflows.find("myrel");
  ok("自定义模板可被查找", found && found.builtin === false);
  const inst2 = await a.execTool("instantiate_template", { name: "myrel", goal: "v2.0" });
  ok("自定义模板实例化成功", /myrel/.test(inst2) && /v2\.0/.test(inst2));
  const latest2 = a.plan.recent("c1", 1)[0];
  ok("步骤内 {goal} 被替换", latest2 && latest2.tasks[0].text === "准备 v2.0 的构建");

  // 4. remove_template（自定义可删，内置不可删）
  const rm = await a.execTool("remove_template", { name: "myrel" });
  ok("remove 自定义模板成功", /已删除/.test(rm));
  ok("删除后不可查", a.workflows.find("myrel") === null);
  const rmBuiltin = await a.execTool("remove_template", { name: "feature" });
  ok("内置模板不可删", /内置模板不可删/.test(rmBuiltin));

  // 5. set_goal + 持久化 + goal_status + 清除
  const sg = await a.execTool("set_goal", { goal: "实现 GitHub Actions 自动测试" });
  ok("set_goal 成功", /已设定会话目标/.test(sg));
  ok("goal 已持久化", fs.existsSync(a._goalPath) && JSON.parse(fs.readFileSync(a._goalPath, "utf8")).goal === "实现 GitHub Actions 自动测试");
  const gs = await a.execTool("goal_status", {});
  ok("goal_status 显示目标", gs.includes("实现 GitHub Actions 自动测试"));
  const clear = await a.execTool("set_goal", { goal: "" });
  ok("set_goal 空值清除", /已清除/.test(clear) && a._goal === null);
  const gs2 = await a.execTool("goal_status", {});
  ok("清除后 goal_status 提示未设定", /未设定会话目标/.test(gs2));

  // 6. set_goal 带 template → 同时生成执行计划
  const sg2 = await a.execTool("set_goal", { goal: "补全登录测试", template: "test" });
  ok("set_goal+template 设定目标", /已设定会话目标/.test(sg2) && a._goal === "补全登录测试");
  ok("set_goal+template 生成计划", /生成执行计划/.test(sg2));
  const latest3 = a.plan.recent("c1", 1)[0];
  ok("计划标题含目标", latest3 && latest3.title.includes("补全登录测试"));

  // 7. fillGoal 单元
  ok("fillGoal 替换", fillGoal("实现 {goal} 的 {goal}", "X") === "实现 X 的 X");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n⑪ WORKFLOW/GOAL OK=" + (fail === 0) + "  (pass=" + pass + ", fail=" + fail + ")");
  process.exit(fail === 0 ? 0 : 1);
})();
