/* ============================================================
   多 Agent 编排引擎 — 将复杂任务拆分为多个子任务，
   由专门的子智能体按依赖关系并行/串行执行。

   编排计划结构:
     {
       title: "编排标题",
       steps: [
         {
           id: "step1",
           name: "步骤名称",
           agent_type: "general|coder|reviewer|tester|...",
           task: "具体任务描述",
           depends_on: ["step0"]  // 依赖的步骤 id 列表（空表示无依赖）
         }
       ]
     }

   执行策略:
     - 拓扑排序按层级执行，同一层无依赖的步骤并行执行
     - 前置步骤的输出作为后续步骤的上下文注入
     - 每步开始/完成/失败时通过 emit 推送事件到前端
   ============================================================ */
"use strict";

class Orchestrator {
  constructor(agent) {
    this.agent = agent;
  }

  /* 拓扑分层：将步骤按依赖关系分成多个层级，
     同一层内的步骤可以并行执行 */
  _topoLayers(steps) {
    const map = new Map(steps.map((s) => [s.id, s]));
    const done = new Set();
    const layers = [];
    let remaining = steps.slice();

    while (remaining.length) {
      const layer = remaining.filter((s) => {
        const deps = s.depends_on || [];
        return deps.every((d) => done.has(d));
      });
      if (!layer.length) {
        // 循环依赖或缺失依赖：把剩余的全塞进最后一层，避免死锁
        layers.push(remaining);
        break;
      }
      layers.push(layer);
      layer.forEach((s) => done.add(s.id));
      remaining = remaining.filter((s) => !done.has(s.id));
    }
    return layers;
  }

  /* 执行一个编排计划 */
  async run(plan) {
    const steps = plan.steps || [];
    if (!steps.length) return { title: plan.title || "编排", results: {}, summary: "无步骤" };

    const layers = this._topoLayers(steps);
    const results = {};
    const startTime = Date.now();

    this.agent.emit({
      type: "orch.start",
      title: plan.title || "多 Agent 编排",
      steps: steps.map((s) => ({ id: s.id, name: s.name, depends_on: s.depends_on || [] })),
    });

    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const parallel = layer.length > 1;

      // 同层步骤并行执行
      const promises = layer.map(async (step) => {
        this.agent.emit({
          type: "orch.step.start",
          stepId: step.id,
          name: step.name,
          layer: li,
          parallel,
        });

        // 收集前置步骤的输出作为上下文
        const deps = step.depends_on || [];
        let ctx = "";
        if (deps.length) {
          ctx = "\n\n【前置步骤结果】\n" + deps.map((d) => {
            const r = results[d];
            return "— " + (r && r.name || d) + " —\n" + (r && r.output || "(无输出)");
          }).join("\n\n");
        }

        try {
          const taskText = step.task + ctx;
          const result = await this.agent.runSubAgent(taskText, {
            subagent_type: step.agent_type || "general",
          });
          const output = (result || "(无返回)").slice(0, 8000);
          results[step.id] = { name: step.name, status: "done", output };

          this.agent.emit({
            type: "orch.step.done",
            stepId: step.id,
            name: step.name,
            output: output.slice(0, 2000),
          });
          return { id: step.id, ok: true, output };
        } catch (e) {
          const errMsg = e.message || String(e);
          results[step.id] = { name: step.name, status: "fail", output: errMsg };

          this.agent.emit({
            type: "orch.step.fail",
            stepId: step.id,
            name: step.name,
            error: errMsg.slice(0, 500),
          });
          return { id: step.id, ok: false, output: errMsg };
        }
      });

      await Promise.all(promises);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const okCount = Object.values(results).filter((r) => r.status === "done").length;
    const failCount = Object.values(results).filter((r) => r.status === "fail").length;

    const summary = "编排「" + (plan.title || "多 Agent 编排") + "」完成：" +
      okCount + " 成功" + (failCount ? "，" + failCount + " 失败" : "") +
      "，耗时 " + elapsed + "s";

    // 汇总各步骤结果
    const fullReport = Object.entries(results).map(([id, r]) => {
      return "## " + r.name + " [" + (r.status === "done" ? "✓" : "✗") + "]\n" + r.output;
    }).join("\n\n---\n\n");

    this.agent.emit({ type: "orch.done", summary, ok: failCount === 0, elapsed });

    return { title: plan.title, results, summary, fullReport, elapsed };
  }
}

module.exports = { Orchestrator };