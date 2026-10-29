/* ============================================================
   pancode-cli · 事件 → ANSI 渲染器
   ------------------------------------------------------------
   消费 agent 引擎 emit 的事件；没登记的一律静默丢掉（见 default 分支）。
   所有输出一律走 screen（cli/screen.js）仲裁，不直接写 stdout：
   流式正文是活动区的尾巴，事件行落在它上方，输入框帧永远在最下面。
   视觉语言对齐 OpenAnLan Terminal（亮青绿）：
     用户消息   › text           (inverseText rail)
     AI 消息    ⊂ markdown       (主色，逐段流式 → 收口时重排版)
     思考块     ∴ Thinking       (dim italic, 折叠)
     工具       ● Name (detail)  (running=dim / done=green / fail=red)
     diff       +行 success / -行 error
     运行态     状态行 ⠙ AI 思考中 / 等你确认：… / 被限流等待 Ns（见 getState）
   ============================================================ */
"use strict";

const S = require("./style");
const { renderMd } = require("./markdown");
const { createScreen } = require("./screen");

/* agent.state 的三种默认语（引擎发 labelKey 而不是死文案，好让界面按当前语言渲染）。
   引擎自己写死的中文 label 优先于这张表。 */
const STATE_TEXT = {
  running: "运行中",
  aiIdle: "AI 空闲",
  rateLimitRetry: "被限流，等待 {s}s 后重试（{a}/{n}）",
};

function createRenderer(opts) {
  opts = opts || {};
  const onApprove = opts.onApprove || (() => {});
  const onChoice  = opts.onChoice  || (() => {});
  /* 输出仲裁层：所有写出去的东西都归它管，输入框的帧才不会被异步事件咬穿。
     不给就用一个自带的（渲染器独立可用，测试与 --once 单次模式走这条）。 */
  const screen = opts.screen || createScreen();

  /* 活跃块缓冲：id → { buf, startTime, name, target, kind } */
  const blocks = new Map();

  /* 最近一次 context.usage 事件（{ used, budget, est }）——交给输入框状态行常驻显示。
     以前这个事件在渲染器里是 case "context.usage": break; 直接扔掉的，
     而状态行去问一个引擎根本没有的 engine.getContextUsage()，两头都拿不到水位。 */
  let lastUsage = null;

  /* 12345 → 12.3k，96000 → 96k：token 数动辄五位数，原样打出来占位又读不出量级。
     整千的不留 ".0"（96.0k 那种写法白占两个字符，还让人以为是精度）。 */
  function fmtK(n) {
    const v = Number(n) || 0;
    const trim = (x) => String(parseFloat(x.toFixed(1)));
    if (v >= 1e6) return trim(v / 1e6) + "M";
    if (v >= 1e3) return trim(v / 1e3) + "k";
    return String(v);
  }

  /* 改盘工具集合——本轮是否真的修改了文件 */
  const MUTATING_TOOLS = new Set(["write_file", "apply_edit", "edit_files", "delete_file"]);
  let hasMutatingTool = false;

  /* 每轮开始前重置标志 */
  function resetRound() {
    hasMutatingTool = false;
    /* 上一轮要是被中断（Ctrl+C / 报错），流式尾巴还挂在活动区里，
       不清掉就会和新轮的正文粘成一段。 */
    screen.setLive("");
    blocks.clear();
  }

  /* ---------- 状态行动画 ----------
     spinner 不再自己占一行：它画进输入框的状态行（见 getStatus）。
     理由很实际——按下 Enter 到第一个 token 之间屏幕空着，用户只能靠"有没有东西在动"
     判断程序死没死；而那一行若写在正文里，就和常驻的输入框抢同一个光标。
     没有帧时（--once 单次模式没有输入框）退回原来那种就地刷一行。 */
  let spinnerTimer = null;
  let spinnerIdx = 0;
  let spinnerOn = false;

  function spinnerGlyph() { return S.SPINNER_FRAMES[spinnerIdx]; }

  function paintSpinner() {
    /* 弹窗（审批/选择）正占着屏幕：那一段时间活动区已经让出去，
       往光标上写一格动画会把选项擦掉。 */
    if (screen.isSuspended()) return;
    if (screen.hasFrame()) { screen.refresh(); return; }
    process.stdout.write("\r\x1b[K" + S.dim(spinnerGlyph() + " " + (runState.text || STATE_TEXT.running)));
  }
  function startSpinner() {
    if (spinnerOn) return;             /* 已经在转就不重置，动画不跳格 */
    spinnerOn = true;
    spinnerIdx = 0;
    paintSpinner();
    spinnerTimer = setInterval(() => {
      spinnerIdx = (spinnerIdx + 1) % S.SPINNER_FRAMES.length;
      paintSpinner();
    }, 120);  // OpenAnLan BriefSpinner: 120ms
  }
  function stopSpinner() {
    if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
    if (!spinnerOn) return;
    spinnerOn = false;
    /* 有帧：紧接着的活动区重画会把状态行刷新，不用自己擦；
       弹窗期间：\r\x1b[K 擦的是 inquirer 那一行，绝对不碰；
       无帧：那一行是自己写出去的，得自己收掉。 */
    if (screen.hasFrame()) screen.refresh();
    else if (!screen.isSuspended()) process.stdout.write("\r\x1b[K");
  }

  /* 最近一次 agent.state：{ running, text } —— 交给输入框状态行常驻显示。
     以前这里是 `case "agent.state": break;` 直接扔掉的，而引擎一直在发
     "运行中 / 被限流等待 N 秒"，CLI 屏幕上却一个字都没有：
     用户按下 Enter 之后到第一个 token 之间是一段空白，看起来像卡死。 */
  let runState = { running: false, text: "" };

  function stateTextOf(ev) {
    if (ev.label) return String(ev.label);
    const key = ev.labelKey;
    if (!key || !STATE_TEXT[key]) return "";
    const v = ev.labelVars || {};
    return STATE_TEXT[key].replace(/\{(\w+)\}/g, (m, k) => (v[k] == null ? m : String(v[k])));
  }

  function setRunning(on, text) {
    runState = { running: !!on, text: text || "" };
    if (on) startSpinner(); else stopSpinner();
  }

  function out(s) {
    /* 帧在的时候正文行落在框上方，动画该继续转；只有裸写模式（无帧）
       才需要在打印任何一行前把 spinner 那一行收掉。 */
    if (!screen.hasFrame()) stopSpinner();
    screen.line(s);
  }
  function outRaw(s) {
    if (!screen.hasFrame()) stopSpinner();
    screen.write(s);
  }

  /* 带归属前缀的整块输出：首行挂前缀，续行按前缀宽度悬挂缩进。
     原先是 out(prefix + 整段多行文本) —— 只有第一行有 ⊂，其余行顶到最左边，
     一段五行的回答看上去就像"一句话 + 一堆不知道谁说的散行"。
     空行不补空格，免得在屏幕上留一串尾随空白。 */
  function outBlock(prefix, text) {
    const pad = " ".repeat(S.displayWidth(prefix));
    String(text).split("\n").forEach((l, i) => out(i === 0 ? prefix + l : (l.trim() ? pad + l : l)));
  }

  /* ---------- 工具名映射（OpenAnLan CLI: Read/Write/Bash/Grep…） ---------- */
  const TOOL_NAME = {
    list_files:           "Read",
    read_file:            "Read",
    read_segment:         "Read",
    write_file:           "Write",
    apply_edit:           "Edit",
    edit_files:           "Edit",
    delete_file:          "Delete",
    search_code:          "Grep",
    search_symbol:        "Grep",
    run_command:          "Bash",
    repo_map:             "Glob",
    create_skill:         "Skill",
    create_plan:          "Plan",
    update_plan:          "Plan",
    set_goal:             "Goal",
    goal_status:          "Goal",
    save_session_memory:  "Memory",
    agent:                "Agent",
    orchestrate:          "Orchestrate",
    browser_open:         "Browser",
  };
  function toolNameOf(name) {
    return TOOL_NAME[name] || name || "";
  }

  /* ---------- 事件分发 ---------- */
  function handleEvent(ev) {
    try { dispatch(ev); } catch (e) { out(S.err("render: " + e.message)); }
  }

  function dispatch(ev) {
    switch (ev.type) {

      /* ── 用户消息：› text（OpenAnLan: inverseText rail + inverseText text） ── */
      case "user.msg": {
        /* 输出区起始：空行与上方内容（输入框/上一轮输出）拉开距离 */
        out("");
        out(S.inverseText(" " + S.MOON_BAR + " ") + S.inverseText(ev.text || ""));
        break;
      }

      /* ── 思考块：∴ Thinking（dim italic 折叠） ── */
      case "think.start": {
        blocks.set(ev.id, { buf: "", startTime: Date.now(), kind: "think" });
        break;
      }
      case "think.delta": {
        const b = blocks.get(ev.id); if (!b) break;
        b.buf += ev.text;
        break;
      }
      case "think.end": {
        const b = blocks.get(ev.id); if (!b) break;
        blocks.delete(ev.id);
        /* OpenAnLan：折叠态只显示 ∴ Thinking，不显示内容/耗时 */
        out(S.dim(S.mod.italic(S.THINKING + " Thinking")));
        break;
      }

      /* ── AI 消息：⊂ markdown（OpenAnLan: prompt + markdown） ── */
      case "msg.start": {
        blocks.set(ev.id, { buf: "", kind: "msg" });
        break;
      }
      case "msg.delta": {
        const b = blocks.get(ev.id); if (!b) break;
        b.buf += ev.text;
        /* 流式正文交给仲裁层当"活动区尾巴"：每来一段就擦掉旧的、写新的、把输入框画回下方。
           以前是直接 raw 出去、等 msg.end 再数行数往上擦 —— 那套行数在输入框常驻之后
           必然把框自己算进去，所以现在整块挪进活动区，msg.end 只需把它清空。 */
        screen.setLive(S.accent(S.MOON) + " " + b.buf);
        break;
      }
      case "msg.end": {
        const b = blocks.get(ev.id); if (!b) break;
        blocks.delete(ev.id);
        /* 收起流式原文（活动区擦干净），再用 markdown 重排版落在框上方 */
        screen.setLive("");
        if (b.buf && b.buf.trim()) {
          const prefixW = S.displayWidth(S.MOON + " ");
          outBlock(S.accent(S.MOON) + " ", renderMd(b.buf, { indent: prefixW }));
        }
        break;
      }

      /* ── 工具调用：● Name (detail)（OpenAnLan 工具样式） ── */
      case "tool.start": {
        const name = toolNameOf(ev.name);
        const detail = ev.target ? "(" + ev.target + ")" : "";
        /* 标记本轮是否执行了改盘工具 */
        if (MUTATING_TOOLS.has(ev.name)) hasMutatingTool = true;
        /* running: dim ● + bold name + plain detail */
        out(S.dim(S.TEARDROP) + " " + S.c.bold(name) + (detail ? " " + detail : ""));
        blocks.set(ev.id, { buf: "", startTime: Date.now(), name: ev.name, target: ev.target });
        break;
      }
      case "tool.body": {
        const b = blocks.get(ev.id); if (!b) break;
        b.buf += ev.text;
        break;
      }
      case "tool.image": {
        out(S.dim("  " + S.SHOT + " " + String(ev.path || "").split("/").pop() + "（截图，CLI 不展开）"));
        break;
      }
      case "tool.end": {
        const b = blocks.get(ev.id); if (!b) break;
        blocks.delete(ev.id);
        /* OpenAnLan: 结果体在 header 下方，用 ⎿ NEST 缩进前缀 */
        if (b.buf && b.buf.trim()) {
          const lines = S.colorizeDiff(b.buf).split("\n").slice(0, 12);
          lines.forEach((l) => out(S.dim("  " + S.NEST + " ") + l));
          if (b.buf.split("\n").length > 12) out(S.dim("  " + S.NEST + " …（更多省略）"));
        }
        /* 失败：在原来那一行下面补一条 ⎿ 失败原因。
           原先是"再印一遍红色 header"——一次工具调用出现两行一模一样的标题，
           除了颜色没有任何差异信息，用户分不清哪行作数，也看不到为什么失败。
           失败原因只挂在下面一行，不回头改已打出去的那行 header：header 早就落在活动区
           上方了，终端里没有"改上面第 N 行"这种操作，改它只能整屏重画。
           原因只取引擎真给的东西：tool.end 的载荷是 { id, ok, label, open }，
           label 是"已中断/等待超时"这类官方措辞，没有它就退回结果体第一行（错误正文常在那）。 */
        if (!ev.ok) {
          const why = String(ev.label || (b.buf || "").split("\n").find((l) => l.trim()) || "").trim();
          out(S.dim("  " + S.NEST + " ") + S.err("失败") + (why ? S.dim(" · ") + S.err(S.truncateCols(why, 60)) : ""));
        }
        break;
      }

      case "tool.pending": {
        onApprove(ev);
        break;
      }
      case "tool.ask_choice": {
        onChoice(ev);
        break;
      }

      case "term.line": {
        outRaw((ev.text || "") + "\n");
        break;
      }

      case "agent.state": {
        /* 引擎每换一次阶段就发这条（AI 思考中 / 第 N 轮 · 调用 M 个工具 /
           等你确认：Write src/a.js / 被限流等待 N 秒）。以前整条丢掉，
           于是运行期屏幕上没有任何"还在干活"的证据。 */
        setRunning(ev.running, stateTextOf(ev));
        break;
      }

      case "agent.error": {
        setRunning(false);
        out(S.err(S.TEARDROP + " " + (ev.message || ev.error || "Agent 错误")));
        break;
      }
      case "agent.done": {
        /* OpenAnLan：完成时不显示"✓ 完成"，静默结束 */
        setRunning(false);
        break;
      }

      case "agent.usage": {
        if (ev.totalTokens) out(S.dim("  " + S.ARROW_DOWN + " " + fmtK(ev.totalTokens) + " tokens" + (ev.rounds ? " · " + ev.rounds + " 轮" : "")));
        break;
      }
      case "agent.budget": {
        if (ev.used != null && ev.limit != null) out(S.dim("  " + S.BUDGET + " 预算 " + fmtK(ev.used) + "/" + fmtK(ev.limit)));
        break;
      }
      case "agent.backoff": {
        /* 引擎载荷是 { waitSec, attempt, maxAttempts, done }，没有 ms 这个字段：
           原先那句 "(Nms)" 永远拼不出来，屏幕上只剩干巴巴的"重试中"。
           done=true 是"重试已成功、把倒计时收掉"的信号，不是又一次退避 —— 给它也印一行
           等于每轮成功都多发一条假警告。 */
        if (ev.done) break;
        const bits = [];
        if (ev.waitSec != null) bits.push("等 " + ev.waitSec + "s");
        if (ev.attempt != null) bits.push("第 " + ev.attempt + "/" + (ev.maxAttempts || "?") + " 次");
        out(S.warn("  " + S.RETRY + " 被限流，自动重试" + (bits.length ? "（" + bits.join(" · ") + "）" : "")));
        break;
      }

      /* 上下文压缩：引擎给的字段是 before/after/budget/dropped/keptFiles/readsDropped。
         原先这里读的是 ev.freed —— 引擎从来没发过这个字段（全仓 grep "freed:" 零命中），
         所以那句"腾出 N%"永远走不到，用户只看到干巴巴的"已压缩"。 */
      case "context.compact":
      case "context.compact_breaker":
      case "context.microcompact": {
        const parts = [];
        if (ev.before != null && ev.after != null) {
          const pct = ev.budget ? Math.round((ev.before - ev.after) / ev.budget * 100) : 0;
          parts.push(fmtK(ev.before) + "→" + fmtK(ev.after) + (pct > 0 ? "（腾出 " + pct + "%）" : ""));
        } else parts.push("已压缩");
        if (ev.keptFiles) parts.push("带回 " + ev.keptFiles + " 个已读文件");
        else if (ev.readsDropped) parts.push("已读快照挤不下，本次丢弃");
        out(S.dim("  " + S.COMPACT + " 上下文压缩 · " + parts.join(" · ")));
        break;
      }
      /* 水位不占行：交给状态行常驻显示（见 getStatus） */
      case "context.usage": {
        if (ev.used != null) lastUsage = { used: ev.used, budget: ev.budget || 0, est: !!ev.est };
        break;
      }

      /* ── 计划：引擎载荷是 { plan: { title, tasks:[{text,status,note}] } } ── */
      case "plan.created":
      case "plan.updated": {
        const p = ev.plan || {};
        const tasks = Array.isArray(p.tasks) ? p.tasks : [];
        const done = tasks.filter((t) => t.status === "done").length;
        const skipped = tasks.filter((t) => t.status === "skipped").length;
        const running = tasks.find((t) => t.status === "in_progress");
        out(S.dim("  " + S.PLAN + " ") + S.text(S.mod.bold(S.truncateCols(p.title || "任务计划", 40))) +
          S.dim(" " + done + "/" + tasks.length + (skipped ? "（跳过 " + skipped + "）" : "")));
        /* 只摊当前在跑的那一条：全量列表每更新一次刷一屏，等于把终端当日志尾巴 */
        if (running) out(S.dim("    " + S.NEST + " ") + S.warn(S.truncateCols(running.text || "", 66)));
        break;
      }

      /* ── 多 Agent 编排：进度按事件逐行报，不摊步骤面板 ── */
      case "orch.start": {
        const steps = Array.isArray(ev.steps) ? ev.steps.length : 0;
        out(S.dim("  " + S.ORCH + " ") + S.text(S.mod.bold(S.truncateCols(ev.title || "多 Agent 编排", 40))) +
          S.dim(" · " + steps + " 步"));
        break;
      }
      case "orch.step.start": {
        out(S.dim("    " + S.NEST + " ") + S.text(S.truncateCols(ev.name || "", 48)) + (ev.parallel ? S.dim(" ∥") : ""));
        break;
      }
      case "orch.step.done": {
        const bits = [];
        if (ev.elapsed != null) bits.push(ev.elapsed + "s");
        if (Array.isArray(ev.changed) && ev.changed.length) bits.push("改 " + ev.changed.length + " 文件");
        if (ev.conflicts) bits.push(S.warn("撞车 " + ev.conflicts));
        out(S.dim("    " + S.NEST + " ") + S.ok(S.TEARDROP) + " " + S.text(S.truncateCols(ev.name || "", 44)) +
          S.dim(bits.length ? " · " + bits.join(" · ") : ""));
        break;
      }
      case "orch.step.fail": {
        out(S.dim("    " + S.NEST + " ") + S.err(S.TEARDROP) + " " + S.text(S.truncateCols(ev.name || "", 44)) +
          S.dim(ev.elapsed != null ? " · " + ev.elapsed + "s" : ""));
        if (ev.error) out(S.dim("      " + S.NEST + " ") + S.err(S.truncateCols(String(ev.error).split("\n")[0], 66)));
        break;
      }
      case "orch.done": {
        const steps = Array.isArray(ev.steps) ? ev.steps : [];
        const bad = steps.filter((s) => s.status === "failed" || s.status === "error").length;
        out(S.dim("  " + S.ORCH + " 编排收口 · " + steps.length + " 步") +
          (ev.ok ? S.ok(" 全部完成") : S.err(" " + bad + " 步失败")) +
          S.dim(ev.elapsed != null ? " · " + (ev.elapsed / 1000).toFixed(1) + "s" : ""));
        break;
      }

      case "skill.created": {
        out(S.dim("  " + S.SKILL + " 沉淀技能：") + S.accent(ev.name || "") +
          S.dim("（" + (ev.level || "P1") + (ev.findings && ev.findings.length ? " · " + ev.findings.length + " 处提示" : "") + "）"));
        break;
      }
      case "session.memory.saved": {
        if (ev.count) out(S.dim("  " + S.MEMORY + " 会话记忆 " + ev.count + " 条" + (ev.skill ? " · 来自 " + ev.skill : "")));
        break;
      }
      case "patch.review": {
        const files = Array.isArray(ev.files) ? ev.files : [];
        out(S.dim("  " + S.PATCH + " 待审阅补丁 · " + files.length + " 个文件（/diff 看改动）"));
        break;
      }
      case "goal.set": {
        out(ev.goal ? S.warn("  " + S.GOAL + " 目标：") + S.text(S.truncateCols(String(ev.goal).split("\n")[0], 60))
                    : S.dim("  " + S.GOAL + " 目标已清除"));
        break;
      }
      case "goal.continue": {
        out(S.warn("  " + S.GOAL + " 目标续跑 · 第 " + (ev.round || "?") + " 轮") +
          (ev.summary ? S.dim(" · " + S.truncateCols(String(ev.summary).split("\n")[0], 48)) : ""));
        break;
      }
      /* cleared=true 是"用户按了停止，目标被摘掉"，不是正常收口。
         两者以前都印成"Goal 收口"，等于把一次中断报成一次完成。 */
      case "goal.settled": {
        if (ev.cleared) out(S.dim("  " + S.GOAL + " 目标已按停止清除"));
        else out(S.warn("  " + S.GOAL + " 目标收口") + (ev.summary ? S.dim(" · " + S.truncateCols(String(ev.summary).split("\n")[0], 48)) : ""));
        break;
      }

      case "file.changed": {
        /* 只在本轮真的执行了改盘工具时才显示文件变更 */
        if (!hasMutatingTool) break;
        if (ev.deleted) out(S.dim("  " + S.FILE_DEL + " " + ev.path));
        else out(S.dim("  " + S.FILE_EDIT + " " + ev.path));
        break;
      }
      case "changes": {
        /* 引擎给的 ev.task 才是"本轮动的文件"；ev.list 是整棵脏工作树。
           以前这里靠渲染层自己的 hasMutatingTool 开关去压住 ev.list ——
           那是在界面层替数据源擦屁股，压得住这张表也压不住别处那句"改动 N 个文件"。 */
        const entries = (ev.task && ev.task.entries) || [];
        entries.slice(0, 8).forEach((c) => {
          const stat = (c.add != null && c.del != null) ? S.ok("+" + c.add) + " " + S.err("-" + c.del) : "";
          out(stat + " " + S.dim(c.path));
        });
        if (entries.length > 8) out(S.dim("  " + S.NEST + " …另有 " + (entries.length - 8) + " 个文件"));
        break;
      }
      case "artifacts": {
        if (ev.list && ev.list.length) {
          out(S.accent("  " + S.ARTIFACT + " 交付物："));
          ev.list.forEach((a) => out(S.dim("    " + S.NEST + " ") + (a.path || a.name || "")));
        }
        break;
      }

      case "editor.diff": {
        if (Array.isArray(ev.added) && ev.added.length) out(S.dim("  " + S.FILE_EDIT + " " + ev.path + " +" + ev.added.length + " 行（CLI 不展开）"));
        break;
      }
      case "editor.open": {
        out(S.dim("  → 编辑器打开 " + ev.path + (ev.line ? ":" + ev.line : "") + "（CLI 模式略）"));
        break;
      }
      case "term.cmd": {
        out(S.dim("  " + "$ " + S.truncateCols(ev.text || "", 70)));
        break;
      }
      case "term.exit": {
        /* 退出码不在载荷里（只有 tabId），报出来反而是假信息，静默 */
        break;
      }

      case "chat.rejected":
        out(S.err("  " + S.TEARDROP + " 拒绝：" + (ev.reason || "忙")));
        break;
      case "chat.queued":
        out(S.dim("  " + S.QUEUE + " 排队中"));
        break;
      case "chat.dequeued":
        break;
      case "chat.rewound":
        out(S.dim("  " + S.REWIND + " 回退到第 " + (ev.backIndex || 0) + " 条之前"));
        break;

      case "memory.recall": {
        if (ev.items && ev.items.length) out(S.dim("  " + S.MEMORY + " 记忆召回 " + ev.items.length + " 条"));
        break;
      }

      case "agent.trace":
      case "op.error":
        break;

      /* 未登记事件静默丢掉。
         原先是 out("  · " + ev.type)：引擎一共发 51 种事件，这里只接 37 种，
         剩下 14 种（plan.* / orch.* / skill.created / patch.review …）会在屏幕上
         变成一行行内部事件名——把协议泄漏当成交互，而且引擎每加一种事件，
         界面就自动多一种噪声。 */
      default:
        break;
    }
  }

  /* 状态行两路数据源：水位来自 context.usage，运行态来自 agent.state。
     两个都是"引擎一直在发、CLI 一直没接"的那类缺口。 */
  return {
    handleEvent, resetRound,
    getStatus: () => lastUsage,
    getState: () => ({ running: runState.running, text: runState.text, glyph: spinnerOn ? spinnerGlyph() : "" }),
  };
}

module.exports = { createRenderer };
