/* ============================================================
   P5 端到端：子智能体并行改盘 + 逐文件隔离 + 共享白板
   ------------------------------------------------------------
   这条探针存在的理由：单测里工具执行是桩，"挡回的那次到底有没有落盘"、
   "写完的认领为什么没把兄弟的文件抹掉"这两件事桩是编不出来的。
   这里跑的是真链路：
     真 LlmAgent → 真 runSubAgent → 真认领/逐文件快照 → 真 execTool
     → 真 write_file handler → 真 FileStore 落盘 → 真 PatchEngine 审阅队列。
   只替换模型说话（_chatStream），因为我们无法要求真模型按顺序撞车。

   判据一律读盘（fs.readFileSync），不读 agent 内存里的副本 ——
   内存里的东西可以被代码骗，盘上的字节不能。
   ============================================================ */
const fs = require("fs");
const path = require("path");

const sb = require("./_sandbox").create({
  tag: "subboard",
  wsFiles: {
    "one.js": "one 原文\n第二行\n",
    "two.js": "two 原文\n",
    "shared.js": "shared 原文\n",
    "README.md": "# 沙箱工作区\n",
  },
  /* LSP 关掉：探针要的是确定性的写入回执，不该顺手拉起一个语言服务器。
     权限 auto：写既有文件属于 medium，auto 放行；探针不等人工点确认。 */
  config: { lsp: { enabled: false }, permissions: { mode: "auto", allow: [], deny: [] } },
});

const { LlmAgent } = require("../server/agent-llm");
const { FileStore } = require("../server/files");
const { Orchestrator } = require("../server/orchestrator");
const { currentSub } = require("../server/sub-context");
const cfgMod = require("../server/config");

let pass = 0; let fail = 0; const fails = [];
function section(t) { console.log("\n\x1b[36m" + t + "\x1b[0m"); }
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name + (detail ? "  \x1b[90m" + detail + "\x1b[0m" : "")); }
  else { fail++; fails.push(name + (detail ? " —— " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? "  " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gate() {
  let release;
  const p = new Promise((r) => { release = r; });
  return { wait: () => p, go: () => release() };
}
const onDisk = (rel) => {
  try { return fs.readFileSync(path.join(sb.wsDir, rel), "utf8"); } catch (e) { return null; }
};
const writeDisk = (rel, text) => fs.writeFileSync(path.join(sb.wsDir, rel), text, "utf8");

/* 一个真引擎实例：真 FileStore、真 PatchEngine、真 execTool、真 write_file handler。
   替身只有三个，且都不在这轮的判据上：
     emit  收集事件（探针不起服务端，没法真广播）
     term  命令执行（本轮不跑命令，run_command 那条走单测）
     git   改动面板的数据源（write_file 收尾会 pushChanges，与"谁认领了哪个文件"无关）
   模型说话（_chatStream）在每条场景里单独注。 */
function mkAgent() {
  const cfg = cfgMod.load();
  cfg.lsp = { enabled: false };
  cfg.memory = { enabled: false };
  const events = [];
  const a = new LlmAgent({
    cfg,
    files: new FileStore(sb.wsDir),
    term: { run: async () => ({ out: "", code: 0 }) },
    git: { changes: async () => [], baseline: async () => "" },
    emit: (m) => events.push(m),
  });
  a.__events = events;
  a.running = false;
  return a;
}

(async () => {
  /* ---------------- ① 并行不再排队（真工具真落盘） ---------------- */
  section("① 两个改不同文件的写盘子智能体：同时在跑、各自收回");
  {
    writeDisk("one.js", "one 原文\n第二行\n");
    writeDisk("two.js", "two 原文\n");
    const a = mkAgent();
    let live = 0, peak = 0;
    const span = {};
    a._chatStream = async () => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      span[me.label] = span[me.label] || { s: Date.now(), e: Date.now() };
      span[me.label].e = Date.now();
      if (me.n === 1) {
        live++; peak = Math.max(peak, live);
        await sleep(40);                       // 旧实现里那支全局锁就是在这里把第二个卡住的
        return { toolCalls: [{ id: "w" + me.owner, name: "write_file", arguments: JSON.stringify({ path: me.label === "甲" ? "one.js" : "two.js", content: me.label + " 写的新内容" }) }] };
      }
      live--;
      return { content: me.label + " 完成" };
    };
    const rA = {}, rB = {};
    const t0 = Date.now();
    await Promise.all([a.runSubAgent("改 one.js", { label: "甲", report: rA }), a.runSubAgent("改 two.js", { label: "乙", report: rB })]);
    const dur = Date.now() - t0;
    ok("两个写手同时在跑（峰值并发 2；旧的整盘互斥锁只能是 1）", peak === 2, "peak=" + peak);
    /* 并发要量"执行区间真的重叠"，不能只信一个计数器：计数器证明两次调用同时在场，
       区间重叠才证明它们互相等过对方的耗时。总耗时的判据用"小于两步各自耗时之和"，
       这条在真链路上才站得住（一次 write_file 要 1~2 秒，写死毫秒数会变成随机红）。 */
    ok("两步的执行区间重叠（不是排队）", span.甲.s < span.乙.e && span.乙.s < span.甲.e, JSON.stringify(span));
    ok("总耗时没把两份各自的时间加起来（并行确实省了时间）",
      dur < (span.甲.e - span.甲.s) + (span.乙.e - span.乙.s), dur + "ms vs " + ((span.甲.e - span.甲.s) + (span.乙.e - span.乙.s)) + "ms");
    ok("甲只认领了自己那一个文件", JSON.stringify(rA.changedFiles) === '["one.js"]', JSON.stringify(rA.changedFiles));
    ok("乙只认领了自己那一个文件", JSON.stringify(rB.changedFiles) === '["two.js"]', JSON.stringify(rB.changedFiles));
    /* 收回：盘上回到原文，而且**兄弟的那个文件被另一个进程读过没被抹**——
       整盘快照互抹的旧毛病就是：甲收尾把整个工作区按自己起跑那一刻的样子盖回去。 */
    ok("one.js 被收回成原文", onDisk("one.js") === "one 原文\n第二行\n", JSON.stringify(onDisk("one.js")));
    ok("two.js 被收回成原文（没被甲的整盘回滚带歪）", onDisk("two.js") === "two 原文\n", JSON.stringify(onDisk("two.js")));
    const q = a.patch.list("default");
    ok("两处改动都进了审阅队列（不是悄悄丢回盘上就算完）", q.length === 2, "队列 " + q.length + " 条");
    ok("队列里能分辨是哪两个文件", q.map((x) => x.path).sort().join(",") === "one.js,two.js", q.map((x) => x.path).join(","));
    ok("收尾放掉了所有认领（否则后来者永远写不了这两个文件）", a._claims.size === 0, "仍占着 " + a._claims.size);
    const term = a.__events.filter((e) => e.type === "term.line").map((e) => e.text).join("\n");
    /* 措辞要跟着真走的那条分支：并行时不许报「独占，整盘比对」，
       那等于告诉用户"命令改盘也收回了"，而这条分支只收回认领过的文件。 */
    ok("两条隔离回执都按实际分支措辞（按文件认领收回，没冒称独占）",
      /按文件认领收回/.test(term) && !/独占/.test(term), term.slice(0, 200));
  }

  /* ---------------- ② 撞车：未声明的运行时冲突 ---------------- */
  section("② 同批两个步骤抢同一个文件：后到的那次没落盘");
  {
    writeDisk("shared.js", "shared 原文\n");
    const a = mkAgent();
    const held = gate(), done = gate();
    const seen = [];
    a._chatStream = async (messages) => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.label === "甲") {
        if (me.n === 1) return { toolCalls: [{ id: "a1", name: "write_file", arguments: JSON.stringify({ path: "shared.js", content: "甲写的" }) }] };
        held.go(); await done.wait();
        return { content: "甲 完成" };
      }
      await held.wait();
      if (me.n === 1) return { toolCalls: [{ id: "b1", name: "write_file", arguments: JSON.stringify({ path: "shared.js", content: "乙写的" }) }] };
      seen.push(messages[messages.length - 1].content);
      done.go();
      return { content: "乙 完成" };
    };
    const rA = {}, rB = {};
    await Promise.all([a.runSubAgent("改 shared", { label: "甲", report: rA }), a.runSubAgent("也改 shared", { label: "乙", report: rB })]);
    ok("乙拿到的是一条挡回回执，不是写入成功", /改盘冲突/.test(seen[0] || ""), String(seen[0] || "").slice(0, 80));
    ok("回执里点名是谁占着、并给出改计划的出路", /甲/.test(seen[0] || "") && /depends_on/.test(seen[0] || ""));
    /* 落盘只能发生一次：盘上从没出现过"乙写的"，审阅队列里也只有一条 shared.js */
    ok("乙的那次写根本没执行（盘上只有甲改过）", onDisk("shared.js") === "shared 原文\n", JSON.stringify(onDisk("shared.js")));
    const q = a.patch.list("default").filter((x) => x.path === "shared.js");
    ok("审阅队列里 shared.js 只有一条，内容是甲那一刀、不含乙的", q.length === 1
      && String(q[0].modified).includes("甲写的") && !String(q[0].modified).includes("乙写的"), JSON.stringify(q[0] || {}).slice(0, 200));
    ok("乙的汇报里记了一次冲突（父智能体据此重排计划）", rB.conflicts.length === 1 && rB.conflicts[0].path === "shared.js", JSON.stringify(rB.conflicts));
    ok("甲没被告知冲突（它确实写成了）", (rA.conflicts || []).length === 0, JSON.stringify(rA.conflicts));
  }

  /* ---------------- ③ 声明式 writes：编排器提前改串行 ---------------- */
  section("③ 两步声明了同一个文件：编排器不等撞车，直接排队");
  {
    writeDisk("shared.js", "shared 原文\n");
    const a = mkAgent();
    const at = [];
    a._chatStream = async () => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.n === 1) {
        at.push({ label: me.label, t: Date.now() });
        await sleep(45);
        return { toolCalls: [{ id: "x" + me.owner, name: "write_file", arguments: JSON.stringify({ path: "shared.js", content: me.label + " 写的" }) }] };
      }
      return { content: me.label + " 完成" };
    };
    const r = await new Orchestrator(a).run({
      title: "撞车声明",
      steps: [
        { id: "s1", name: "第一步", task: "改 shared.js", writes: ["shared.js"] },
        { id: "s2", name: "第二步", task: "也改 shared.js", writes: ["shared.js"] },
      ],
    });
    ok("两次派发时刻不重叠（后一个等前一个跑完）", at.length === 2 && (at[1].t - at[0].t) >= 40, JSON.stringify(at.map((x) => x.t - at[0].t)));
    ok("没有任何一步报冲突（提前排队就不会撞）", r.results.s1.conflicts.length === 0 && r.results.s2.conflicts.length === 0);
    ok("终端痕告知了自动串行", /自动改成串行/.test(a.__events.filter((e) => e.type === "term.line").map((e) => e.text).join("\n")));
    ok("盘上回到原文（两步都收回）", onDisk("shared.js") === "shared 原文\n", JSON.stringify(onDisk("shared.js")));
    const q = a.patch.list("default").filter((x) => x.path === "shared.js");
    /* 审阅队列按文件合并（后一次覆盖前一次）——这是队列本来就有的语义，不是这轮改出来的。
       钉在这里是为了让"两步改同一个文件只剩最后一条待审"这件事是**明说的**，而不是被人发现时当成 bug。 */
    ok("两步都收回、队列里留的是同一条待审（按文件合并的既有语义）", q.length === 1
      && String(q[0].modified).includes("第二步 写的"), JSON.stringify(q.map((x) => x.modified)));
  }

  /* ---------------- ④ 共享白板：跨步骤真的看得见 ---------------- */
  section("④ 共享白板：走真 execTool 写进去，下一个步骤的任务里就带着它");
  {
    const a = mkAgent();
    const tasks = {};
    a._chatStream = async (messages) => {
      const me = currentSub();
      tasks[me.from] = messages[1].content;           // 编排器拼好的 task（含上游简报与白板）
      me.n = (me.n || 0) + 1;
      if (me.n === 1) {
        /* 走真 execTool → 真 board handler，不直接调 board.post：
           要验的就是"工具名、参数形状、归属上下文"这三者接得上。 */
        return { toolCalls: [{ id: "p" + me.owner, name: "board", arguments: JSON.stringify({ action: "write", kind: "blocker", key: "shared.js", text: me.label + " 说：这里有一处不能再改的约束" }) }] };
      }
      return { content: me.label + " 完成" };
    };
    const r = await new Orchestrator(a).run({
      title: "白板",
      steps: [
        { id: "s1", name: "查认证", task: "一" },
        { id: "s2", name: "汇总", task: "二", depends_on: ["s1"] },
      ],
    });
    ok("s1 的白板条目归到了它自己名下", r.results.s1.notes.length === 1
      && r.results.s1.notes[0].from === "s1" && r.results.s1.notes[0].kind === "blocker", JSON.stringify(r.results.s1.notes));
    ok("s2 的任务里被自动带上了共享白板那一段", /【共享白板/.test(tasks.s2 || ""), String(tasks.s2 || "").slice(-160));
    ok("带过去的是 s1 写的那句话，不是空标题", /不能再改的约束/.test(tasks.s2 || ""));
    ok("s1 起跑时白板还是空的（不许凭空有一段空标题）", !/【共享白板/.test(tasks.s1 || ""));
    ok("父智能体的结构化汇报里能看到这条判断", /不能再改的约束/.test(r.modelReport || ""), String(r.modelReport || "").slice(0, 160));
  }

  /* ---------------- ⑤ 只读子智能体不占认领 ---------------- */
  section("⑤ 只读子智能体：不取认领、不改盘");
  {
    const a = mkAgent();
    a._chatStream = async () => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.n === 1) return { toolCalls: [{ id: "l" + me.owner, name: "list_files", arguments: JSON.stringify({}) }] };
      return { content: "读完了" };
    };
    const r = {};
    await a.runSubAgent("只是看看", { label: "只读", report: r });
    ok("只读步骤没登记任何认领", !a._claims || a._claims.size === 0, a._claims ? String(a._claims.size) : "认领表根本没建（就是没取过）");
    ok("只读步骤没拍快照也没收回（报告里改动为空）", JSON.stringify(r.changedFiles) === "[]", JSON.stringify(r.changedFiles));
    ok("盘上文件原样没动", onDisk("one.js") === "one 原文\n第二行\n", JSON.stringify(onDisk("one.js")));
  }

  /* ---------------- ⑥ 白板不外溢：父智能体没有这块板 ---------------- */
  section("⑥ 父智能体这一侧：board 不可用，且不跨编排泄漏");
  {
    const a = mkAgent();
    const out = await a.execTool("board", { action: "write", text: "父智能体想写一条" });
    ok("父智能体调 board 被如实拒绝（没人读那块板，不许假装收下）", /没有正在进行的编排/.test(String(out)), String(out).slice(0, 90));
    ok("父清单里没有 board 这份 schema（每轮白占 token）", !LlmAgent.toolsForMode({}).some((t) => t.function.name === "board"));
    ok("子集里有 board", a._subToolset().some((t) => t.function.name === "board"));
    ok("子集里没有 orchestrate（收掉的已知偏差 3）", !a._subToolset().some((t) => t.function.name === "orchestrate"));
  }

  /* ---------------- ⑦ 认领过 ≠ 改动过 ---------------- */
  section("⑦ 认领了但盘上没变：不许把它算进「改动 N 个文件」，也不许塞进审阅队列");
  {
    writeDisk("one.js", "one 原文\n第二行\n");
    const a = mkAgent();
    a._chatStream = async () => {
      const me = currentSub();
      me.n = (me.n || 0) + 1;
      if (me.n === 1) {
        return { toolCalls: [{ id: "n" + me.owner, name: "write_file", arguments: JSON.stringify({ path: "one.js", content: "one 原文\n第二行\n" }) }] };
      }
      return { content: "原样写了一遍" };
    };
    const r = {};
    await a.runSubAgent("把 one.js 原样写一遍", { label: "原样", report: r });
    /* 先证明这一步真的走到了写（不是压根没跑）：write_file 成功后会 emit editor.open。
       没有这条前置，下面那句"改动清单为空"可能只是因为什么都没发生。 */
    ok("write_file 真的执行过（emit 里有 editor.open）", a.__events.some((e) => e.type === "editor.open" && e.path === "one.js"),
      JSON.stringify(a.__events.filter((e) => e.type === "editor.open").map((e) => e.path)));
    ok("改动清单是空的（内容一个字没变）", JSON.stringify(r.changedFiles) === "[]", JSON.stringify(r.changedFiles));
    ok("认领表里有它（两件事分开记，才说得清「来过但没改」）", JSON.stringify(r.claimed) === '["one.js"]', JSON.stringify(r.claimed));
    ok("收回数为 0", r.rolledBack === 0, String(r.rolledBack));
    ok("审阅队列没被一条空改动污染", a.patch.list("default").length === 0, JSON.stringify(a.patch.list("default").map((x) => x.path)));
    ok("盘上内容仍是原文", onDisk("one.js") === "one 原文\n第二行\n");
  }

  if (fail) { console.error("\nFAIL " + fail + " 项:\n - " + fails.join("\n - ")); sb.cleanup(); process.exit(1); }
  console.log("\nPASS: 子智能体并行与白板 " + pass + " 项全过（真落盘、按文件认领、撞车挡回、白板跨步骤可见）");
  sb.cleanup();
})().catch((e) => { console.error("\n探针自己炸了：", e && e.stack || e); sb.cleanup(); process.exit(2); });
