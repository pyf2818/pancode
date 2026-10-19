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
           writes: ["src/a.js"]   // 可选：预计改动的文件，用来提前判并行撞车
         }
       ]
     }

   执行策略:
     - 拓扑排序按层级执行，同一层无依赖的步骤并行执行
     - 同批里两个步骤声明了同一个文件，自动改成串行（并行的两个写手改同一文件必然互相覆盖）
     - 下游拿到的不是上游全文，而是结构化汇报（状态/改了哪些文件/结论摘要）+ 共享白板
     - 每步开始/完成/失败时通过 emit 推送事件到前端
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const wsKey = require("./ws-key");
const safeWrite = require("./safe-write");
const { Blackboard } = require("./blackboard");

const HIST_MAX = 50;
/* 注入给下游的上游结论摘要长度：以前是整段 8000 字原文，
   下游真正要用的是"它改了哪些文件、结论是什么"，全文既贵又让模型自己去里面找。 */
const DEP_OUTPUT_MAX = 1200;
/* 交给父智能体的每步摘要长度（工具卡里给人看的仍是长文） */
const STEP_NOTE_MAX = 700;

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
    conv: r.conv || "",
    counts: r.counts, summary: r.summary || "",
    steps: (r.steps || []).map((s) => ({
      id: s.id, name: s.name, status: s.status, layer: s.layer,
      agent_type: s.agent_type || "general",
      task: String(s.task || "").slice(0, 160),
      output: String(s.output || "").slice(0, 120),
      /* 列表端点是裁剪过的，但"这一步改了几个文件 / 撞了几次"必须跟着走：
         侧栏那几行要据此显示归属，点开详情才去拿整条记录太绕。 */
      changed: (s.changedFiles || []).length,
      conflicts: (s.conflicts || []).length,
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

  /* 声明了同一批文件的步骤不许并行：并行的两个写手改同一个文件必然互相覆盖，
     而运行时的按文件认领只会把后到的那次写挡回 —— 挡回等于这一步白跑几轮。
     这里在派发前按声明顺序补一条依赖（只从下标小的指向大的，不会造出环），
     把"跑一半被撞回"变成"本来就排队"。返回补过的边，供汇报里说清改了什么。 */
  _serializeWriteClashes(steps) {
    const added = [];
    const keyOf = (p) => String(p || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    const sets = steps.map((s) => new Set((Array.isArray(s.writes) ? s.writes : []).map(keyOf).filter(Boolean)));
    for (let i = 0; i < steps.length; i++) {
      for (let j = i + 1; j < steps.length; j++) {
        const overlap = [...sets[i]].filter((p) => sets[j].has(p));
        if (!overlap.length) continue;
        const di = steps[i].depends_on || [];
        const dj = steps[j].depends_on || [];
        if (di.indexOf(steps[j].id) >= 0 || dj.indexOf(steps[i].id) >= 0) continue;  // 已经有序，不用补
        steps[j].depends_on = dj.concat([steps[i].id]);
        added.push({ from: steps[j].id, to: steps[i].id, files: overlap });
      }
    }
    return added;
  }

  /* 一条上游步骤的简报（注入下游用）。带上了"它真的改了哪些文件"和撞车次数：
     下游要接着改同一个文件，光看散文结论看不出上游动过它，就会重复动刀或基于旧内容下 old_string。 */
  _depBrief(id, r) {
    if (!r) return "— " + id + " —\n(找不到这一步的结果)";
    const files = (r.changedFiles || []).slice(0, 12);
    const head = "— " + (r.name || id) + "（" + id + "）· " + (r.status === "done" ? "完成" : "失败")
      + (files.length ? " · 改动 " + files.length + " 个文件：" + files.join(", ") : " · 未改盘")
      + ((r.conflicts || []).length ? " · 有 " + r.conflicts.length + " 次改盘被并行冲突挡回" : "") + " —";
    return head + "\n" + String(r.output || "(无输出)").slice(0, DEP_OUTPUT_MAX);
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

    /* 先补撞车边再分层：分层读的就是这份 depends_on，顺序反了并行图还是旧的。 */
    const serialized = this._serializeWriteClashes(steps);
    if (serialized.length) {
      this.agent.emit({ type: "term.line", cls: "tl-warn", text: "[编排] " + serialized.length
        + " 对步骤声明了同一批文件，已自动改成串行：" + serialized.map((e) => e.to + " 等 " + e.from + "（" + e.files.join("、") + "）").join("；") });
    }
    const layers = this._topoLayers(steps);
    /* 一次编排一份白板：兄弟之间靠它对信息，不靠把上游原文塞进下游的 prompt。 */
    const runId = "orch-" + Date.now().toString(36);
    const board = new Blackboard(runId);
    const results = {};
    const startTime = Date.now();
    const stepMeta = [];          // 落盘用的完整步骤明细（含耗时与输出，供历史回放）

    /* layer 随步骤一起发：前端要按「第几批」分泳道画依赖图。
       让它自己从 depends_on 再推一遍分层，就等于允许它推出和真正执行顺序不同的图 ——
       分层只有一个真相源，就是上面那次 _topoLayers。 */
    this.agent.emit({
      type: "orch.start",
      title: plan.title || "多 Agent 编排",
      steps: layers.reduce((acc, layer, li) => {
        layer.forEach((s) => {
          const meta = steps.find((x) => x.id === s.id) || s;
          acc.push({ id: s.id, name: s.name, layer: li, parallel: layer.length > 1, depends_on: meta.depends_on || [] });
        });
        return acc;
      }, []),
    });

    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      const parallel = layer.length > 1;

      // 同层步骤并行执行
      const promises = layer.map(async (step) => {
        const t0 = Date.now();
        // task 必须随明细落盘：历史回放要让用户看到"这个子 agent 被派了什么活"，
        // 只有 name 的话（"分析"“实现"）等于什么都没说。
        stepMeta.push({ id: step.id, name: step.name, layer: li, parallel, depends_on: (step.depends_on || []).slice(), agent_type: step.agent_type || "general", task: String(step.task || ""), status: "running", output: "", elapsed: 0 });
        this.agent.emit({
          type: "orch.step.start",
          stepId: step.id,
          name: step.name,
          layer: li,
          parallel,
        });

        /* 上游给下游的不是全文，是一份能直接用的简报：状态、动了哪些文件、撞了几次车、结论摘要。
           再加本次编排的共享白板（排掉这一步自己写的，它不需要重读自己的便签）。 */
        const deps = step.depends_on || [];
        let ctx = "";
        if (deps.length) ctx = "\n\n【前置步骤结果】\n" + deps.map((d) => this._depBrief(d, results[d])).join("\n\n");
        const boardText = board.render(step.id);
        if (boardText) ctx += "\n\n【共享白板·兄弟步骤】\n" + boardText;

        const meta = stepMeta[stepMeta.length - 1];
        const rep = {};
        try {
          const taskText = step.task + ctx;
          const result = await this.agent.runSubAgent(taskText, {
            subagent_type: step.agent_type || "general",
            expert: step.expert, // W2：编排步骤可选专家人设
            label: step.name,
            stepId: step.id,
            board, report: rep,
          });
          const output = (result || "(无返回)").slice(0, 8000);
          results[step.id] = {
            name: step.name, status: "done", output,
            changedFiles: rep.changedFiles || [], conflicts: rep.conflicts || [],
            unattributed: rep.unattributed || [], notes: board.from(step.id),
          };
          meta.status = "done"; meta.output = output.slice(0, 4000); meta.elapsed = (Date.now() - t0) / 1000;
          meta.changedFiles = results[step.id].changedFiles;
          meta.conflicts = results[step.id].conflicts;

          this.agent.emit({
            type: "orch.step.done",
            stepId: step.id,
            name: step.name,
            elapsed: +meta.elapsed.toFixed(1),
            output: output.slice(0, 2000),
            /* 归属也要发给界面：并行跑的时候用户看的不是"这一步完成了"，
               而是"这一步动了哪几个文件、有没有被别人占住"。 */
            changed: results[step.id].changedFiles,
            conflicts: results[step.id].conflicts.length,
          });
          return { id: step.id, ok: true, output };
        } catch (e) {
          const errMsg = e.message || String(e);
          results[step.id] = {
            name: step.name, status: "fail", output: errMsg,
            changedFiles: rep.changedFiles || [], conflicts: rep.conflicts || [],
            unattributed: rep.unattributed || [], notes: board.from(step.id),
          };
          meta.status = "fail"; meta.output = errMsg; meta.elapsed = (Date.now() - t0) / 1000;
          meta.changedFiles = results[step.id].changedFiles;
          meta.conflicts = results[step.id].conflicts;

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

    // 汇总各步骤结果（给人看的工具卡：仍留长文）
    const fullReport = stepMeta.map((r) => {
      return "## " + r.name + " [" + (r.status === "done" ? "✓" : r.status === "fail" ? "✗" : "…") + "]\n" + r.output;
    }).join("\n\n---\n\n");

    /* 交给父智能体的模型序：每步一行结构化 + 结论摘要，不再整段摊上 6000 字原文。
       父智能体要做的是"据此决定下一步"，它需要的是谁改了什么、谁撞了车、结论是什么。 */
    const modelReport = stepMeta.map((r) => {
      const res = results[r.id] || {};
      const files = (res.changedFiles || []).slice(0, 12);
      const bits = [
        (r.status === "done" ? "完成" : r.status === "fail" ? "失败" : "未完"),
        (+r.elapsed).toFixed(1) + "s",
        files.length ? "改动 " + files.length + " 个文件：" + files.join(", ") + ((res.changedFiles || []).length > 12 ? "…（共 " + res.changedFiles.length + "）" : "") : "未改盘",
      ];
      if ((res.conflicts || []).length) bits.push("有 " + res.conflicts.length + " 次改盘被并行冲突挡回：" + res.conflicts.map((c) => c.path).slice(0, 6).join(", "));
      if ((res.unattributed || []).length) bits.push("另有 " + res.unattributed.length + " 个新文件无法归因（命令改盘）");
      return "- " + r.id + " " + r.name + "（" + bits.join(" · ") + "）\n  结论："
        + String(r.output || "").replace(/\s+/g, " ").slice(0, STEP_NOTE_MAX)
        /* 白板条目也要交给父智能体：那是子智能体对工作区的判断（"这条路上不去"），
           只留在运行内的板上，父智能体收尾时看不见，等于查到了但没人用。 */
        + ((res.notes || []).length
          ? "\n  白板上记的：" + res.notes.slice(0, 4).map((b) => "[" + b.kind + "] " + (b.key ? b.key + "：" : "") + b.text)
            .join("；").slice(0, 600)
          : "");
    }).join("\n");

    // 编排历史落盘（服务端，跨浏览器/跨用户可见，可点开回放）
    try {
      histAppend({
        id: runId, title: plan.title || "多 Agent 编排", ok: failCount === 0,
        elapsed: +elapsed, ts: Date.now(),
        /* 归属会话：历史文件按工作区分，以前整份直接摊给侧栏，
           于是换个对话看到的编排历史一模一样，分不清哪次是自己刚跑的。 */
        conv: (this.agent && this.agent.currentConv) ? this.agent.currentConv() : "default",
        counts: { done: okCount, fail: failCount, total: steps.length },
        steps: stepMeta, summary,
        /* 自动串行补上的边也要留档：回放时看不到这几条，用户会以为这两步真的并行了 */
        serialized,
        board: board.items.slice(),
      });
    } catch (e) {}

    this.agent.emit({ type: "orch.done", summary, ok: failCount === 0, elapsed, runId, steps: stepMeta.map((s) => ({ id: s.id, name: s.name, status: s.status, elapsed: +s.elapsed.toFixed(1), changed: (s.changedFiles || []).length, conflicts: (s.conflicts || []).length })) });

    // ok 必须随返回体走：orchestrate 工具拿它决定 t.done 的成败；
    // 以前返回体从没有这个字段（只有 orch.done 事件带），有步骤失败时
    // 工具卡照样亮"完成"，模型也不知道要向用户交代失败的部分。
    return { title: plan.title, results, summary, fullReport, modelReport, elapsed, ok: failCount === 0, runId, board };
  }
}

module.exports = { Orchestrator, histList, histGet, histPath };