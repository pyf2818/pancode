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
const fs = require("fs");
const path = require("path");
const wsKey = require("./ws-key");
const safeWrite = require("./safe-write");

const HIST_MAX = 50;

/* 编排历史：按工作区分文件落盘（跨用户 / 跨浏览器可见），取代前端 localStorage 空壳 */
function histPath() {
  const ROOT = require("./config").ROOT;
  const cfg = require("./config").load();
  return wsKey.forWorkspace(path.resolve(ROOT, (cfg && cfg.workspace) || "workspace"), ROOT)
    .file(path.join(ROOT, ".pancode", "orch-history"));
}
/* 进程内权威副本 + 懒加载一次。以前每次 append 都裸读盘再 unshift：
   saveJson 是异步排队落盘，连续两次编排时第二次读到的还是旧文件，
   会把第一次的记录整条覆盖丢掉。 */
let _histCache = null;
function histLoad() {
  if (_histCache) return _histCache;
  try { _histCache = JSON.parse(fs.readFileSync(histPath(), "utf8")) || []; }
  catch (e) { _histCache = []; }
  return _histCache;
}
function histAppend(rec) {
  const list = histLoad();
  list.unshift(rec);
  const kept = list.slice(0, HIST_MAX);
  _histCache = kept;
  safeWrite.saveJson(histPath(), kept);
  return kept;
}
function histList() {
  return histLoad().map((r) => ({
    id: r.id, title: r.title, ok: r.ok, elapsed: r.elapsed, ts: r.ts,
    counts: r.counts, summary: r.summary || "",
    steps: (r.steps || []).map((s) => ({
      id: s.id, name: s.name, status: s.status, layer: s.layer,
      agent_type: s.agent_type || "general",
      task: String(s.task || "").slice(0, 160),
      output: String(s.output || "").slice(0, 120),
    })),
  }));
}
function histGet(id) { return histLoad().find((r) => r.id === id) || null; }

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
    if (!steps.length) {
      /* 以前这里静默返回 summary="无步骤"（ok 未置 false、orch.start 都不发）：
         前端什么也不弹，模型拿到"无步骤"两个字还可能向用户复述"编排完成"。
         现在明确告诉两边：这个计划无效，模型需要重新给步骤。 */
      const msg = "编排计划无效：steps 为空。请给出至少 1 个步骤（每个含 id/name/task）。";
      this.agent.emit({ type: "op.error", error: msg, userHint: "编排没有跑起来：Agent 给出的计划里一个步骤都没有，请让它重新拆分任务" });
      return { title: plan.title || "编排", results: {}, summary: msg, ok: false, fullReport: "" };
    }

    const layers = this._topoLayers(steps);
    const results = {};
    const startTime = Date.now();
    const stepMeta = [];          // 落盘用的完整步骤明细（含耗时与输出，供历史回放）

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
        const t0 = Date.now();
        // task 必须随明细落盘：历史回放要让用户看到"这个子 agent 被派了什么活"，
        // 只有 name 的话（"分析"“实现"）等于什么都没说。
        stepMeta.push({ id: step.id, name: step.name, layer: li, parallel, agent_type: step.agent_type || "general", task: String(step.task || ""), status: "running", output: "", elapsed: 0 });
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

        const meta = stepMeta[stepMeta.length - 1];
        try {
          const taskText = step.task + ctx;
          const result = await this.agent.runSubAgent(taskText, {
            subagent_type: step.agent_type || "general",
            expert: step.expert, // W2：编排步骤可选专家人设
            label: step.name,
          });
          const output = (result || "(无返回)").slice(0, 8000);
          results[step.id] = { name: step.name, status: "done", output };
          meta.status = "done"; meta.output = output.slice(0, 4000); meta.elapsed = (Date.now() - t0) / 1000;

          this.agent.emit({
            type: "orch.step.done",
            stepId: step.id,
            name: step.name,
            elapsed: +meta.elapsed.toFixed(1),
            output: output.slice(0, 2000),
          });
          return { id: step.id, ok: true, output };
        } catch (e) {
          const errMsg = e.message || String(e);
          results[step.id] = { name: step.name, status: "fail", output: errMsg };
          meta.status = "fail"; meta.output = errMsg; meta.elapsed = (Date.now() - t0) / 1000;

          this.agent.emit({
            type: "orch.step.fail",
            stepId: step.id,
            name: step.name,
            elapsed: +meta.elapsed.toFixed(1),
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
    const fullReport = stepMeta.map((r) => {
      return "## " + r.name + " [" + (r.status === "done" ? "✓" : r.status === "fail" ? "✗" : "…") + "]\n" + r.output;
    }).join("\n\n---\n\n");

    // 编排历史落盘（服务端，跨浏览器/跨用户可见，可点开回放）
    let runId = "";
    try {
      runId = "orch-" + Date.now().toString(36);
      histAppend({
        id: runId, title: plan.title || "多 Agent 编排", ok: failCount === 0,
        elapsed: +elapsed, ts: Date.now(),
        counts: { done: okCount, fail: failCount, total: steps.length },
        steps: stepMeta, summary,
      });
    } catch (e) {}

    this.agent.emit({ type: "orch.done", summary, ok: failCount === 0, elapsed, runId, steps: stepMeta.map((s) => ({ id: s.id, name: s.name, status: s.status, elapsed: +s.elapsed.toFixed(1) })) });

    // ok 必须随返回体走：orchestrate 工具拿它决定 t.done 的成败；
    // 以前返回体从没有这个字段（只有 orch.done 事件带），有步骤失败时
    // 工具卡照样亮"完成"，模型也不知道要向用户交代失败的部分。
    return { title: plan.title, results, summary, fullReport, elapsed, ok: failCount === 0 };
  }
}

module.exports = { Orchestrator, histList, histGet, histPath };