#!/usr/bin/env node
/* ============================================================
   pancode-cli · 终端 Agent CLI 入口
   ------------------------------------------------------------
   双模式引擎装配：
     1. 自包含模式（默认）：使用 cli/lib/ 精简引擎，零外部依赖
     2. 完整模式（pancode 仓库内）：使用 ../server/ 全功能引擎
   自动检测：../server/config.js 存在 → 完整模式；否则 → 自包含模式

   用法：
     pancode-cli                 # 在当前目录起会话
     pancode-cli "帮我加个测试"  # 单次任务，跑完退出
     pancode-cli --ws ./myproj   # 指定工作区
   ============================================================ */
"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");

const S = require("./style");
const { createRenderer } = require("./render");
const { createScreen } = require("./screen");
const prompt = require("./prompt");
const { COMMANDS, parse } = require("./commands");
const { commandPalette } = require("./cmdpalette");
const { historySearch } = require("./history");
const { transcript } = require("./transcript");
const { externalEditor } = require("./editor");

/* ---------- 模式检测 ---------- */
const HAS_SERVER = fs.existsSync(path.join(__dirname, "..", "server", "config.js"));

/* ---------- 参数解析 ---------- */
function parseArgs(argv) {
  const a = { ws: process.cwd(), wsExplicit: false, once: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--ws" || v === "-w") { a.ws = path.resolve(argv[++i]); a.wsExplicit = true; }
    else if (v === "--help" || v === "-h") a.help = true;
    else if (!v.startsWith("-") && a.once === null) a.once = v;
  }
  return a;
}

function banner() {
  const w = Math.min(process.stdout.columns || 80, 72);
  /* 每一行都走同一个补空格口径（S.stripLen 现在返回列数）。
     原先第二行用 stripLen、第三行用硬编码 62，一行之内两套尺子：
     含中文的那行按字符数算，右边框实际比别的行短 9 列。 */
  const rows = [
    S.accent("  ⊂ pancode-cli") + S.dim("  ·  终端 AI 编程 Agent"),
    S.dim("  /help 看命令 · ^K 命令面板 · ^R 历史 · ^O transcript · ^X E 编辑器"),
  ];
  const edge = (s) => S.border("│") + s + " ".repeat(Math.max(0, w - S.stripLen(s) - 2)) + S.border("│");
  process.stdout.write("\n" + S.border("┌" + "─".repeat(Math.max(2, w - 2)) + "┐") + "\n");
  rows.forEach((r) => process.stdout.write(edge(r) + "\n"));
  process.stdout.write(S.border("└" + "─".repeat(Math.max(2, w - 2)) + "┘") + "\n\n");
}

/* ============================================================
   自包含模式引擎装配（cli/lib/）
   ============================================================ */
function assembleStandalone(wsDir, emit) {
  const configMod = require("./lib/config");
  const { Engine } = require("./lib/engine");
  const cfg = configMod.load();
  cfg.workspace = wsDir;

  const engine = new Engine(cfg);
  engine.setEmitter(emit);
  if (!engine.cfg) engine.cfg = cfg;

  return {
    engine,
    stores: { files: engine.files, git: engine.git, term: engine.term },
    cfg,
    standalone: true,
  };
}

/* ============================================================
   完整模式引擎装配（../server/）
   ============================================================ */
async function assembleFull(wsDir, emit) {
  require("../server/dotenv").loadDotEnv();
  const configMod = require("../server/config");
  const cfg = configMod.load();

  const { FileStore } = require("../server/files");
  const { GitLayer } = require("../server/git");
  const { TerminalLayer } = require("../server/terminal");
  const { ProcessLayer } = require("../server/processes");
  const { SkillStore } = require("../server/skill-store");
  const { MemoryStore } = require("../server/memory-store");
  const { PlanStore } = require("../server/plan-store");
  const { SoulStore } = require("../server/soul-store");
  const { WorkflowStore } = require("../server/workflow-store");
  const wsKey = require("../server/ws-key");

  const ws = wsKey.forWorkspace(wsDir, configMod.ROOT);
  const auditDir = path.join(configMod.ROOT, ".pancode", "audit");
  fs.mkdirSync(auditDir, { recursive: true });

  const files = new FileStore(wsDir, auditDir);
  const git = new GitLayer(wsDir, files);
  const term = new TerminalLayer(wsDir, emit, auditDir, cfg.permissions && cfg.permissions.strictCommand !== false);
  const procs = new ProcessLayer(wsDir, emit, auditDir);

  const skillDir = path.join(configMod.ROOT, ".pancode", "skills");
  const marketDir = path.join(skillDir, "market");
  const skillStore = new SkillStore(marketDir, ws.file(skillDir), path.join(__dirname, "..", "server", "builtin-skills"), path.join(os.homedir(), ".pancode", "skills"));
  const memory = new MemoryStore(ws.file(path.join(configMod.ROOT, ".pancode", "memory")));
  const userMemory = new MemoryStore(path.join(os.homedir(), ".pancode", "memory", "user.json"));
  const plan = new PlanStore(ws.file(path.join(configMod.ROOT, ".pancode", "plans")));
  const wfDir = path.join(configMod.ROOT, ".pancode", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  const workflow = new WorkflowStore(ws.file(wfDir));
  const soul = new SoulStore(ws.file(path.join(configMod.ROOT, ".pancode", "soul")));

  let progression = null, experts = null;
  try { const { ProgressionStore } = require("../server/progression-store"); progression = new ProgressionStore(ws.file(path.join(configMod.ROOT, ".pancode", "progression"))); } catch (_) {}
  try { const { ExpertStore } = require("../server/expert-store"); experts = new ExpertStore(path.join(wsDir, ".pancode", "experts"), path.join(os.homedir(), ".pancode", "experts")); } catch (_) {}

  const ctx = {
    emit, files, git, term, procs, cfg,
    roots: null,
    skills: skillStore,
    sharedMemory: memory, sharedPlan: plan, sharedWorkflow: workflow,
    sharedUserMemory: userMemory,
    sharedExperts: experts, sharedSoul: soul, sharedProgression: progression,
    userKey: "cli",
  };

  let engine;
  if (configMod.engineMode(cfg) === "llm") {
    const { LlmAgent } = require("../server/agent-llm");
    engine = new LlmAgent(ctx);
  } else {
    const { DemoAgent } = require("../server/agent-demo");
    engine = new DemoAgent(ctx);
  }
  if (!engine.cfg) engine.cfg = cfg;

  return {
    engine,
    stores: { files, git, term, procs, skillStore, memory, plan, soul, workflow, progression, experts },
    cfg,
    standalone: false,
  };
}

/* ---------- 统一装配入口 ---------- */
async function assembleEngine(wsDir, emit) {
  if (HAS_SERVER) {
    return await assembleFull(wsDir, emit);
  }
  return assembleStandalone(wsDir, emit);
}

/* ---------- REPL ---------- */
async function repl({ engine, stores, cfg, wsDir, standalone }) {
  const convId = "cli-" + Date.now();
  /* stdout 的唯一所有者。渲染器写事件行、输入框画帧，两边都不再直接碰 process.stdout：
     异步事件落在输入框上方时由它先擦帧、写完再画回去。 */
  const screen = createScreen();
  const renderer = createRenderer({
    screen,
    /* 审批/选择要让输入框先收帧交出 stdin（见 inputbox 的 exclusive）：
       运行期输入框常驻之后，这两个弹窗第一次和框抢同一个键盘。 */
    onApprove: (ev) => screen.exclusive(async () => {
      const r = await prompt.approval(ev);
      if (r.stop) { process.exit(0); }
      if (engine.resolveApproval) engine.resolveApproval(ev.id, r.ok);
      if (r.session && r.ok && engine.grantSession) engine.grantSession(ev.tool);
    }),
    onChoice: (ev) => screen.exclusive(async () => {
      const r = await prompt.choice(ev);
      if (engine.resolveChoice) engine.resolveChoice(ev.id, r.value);
    }),
  });

  const emit = (ev) => renderer.handleEvent(ev);
  engine.emit = emit;

  const ctx = {
    engine, stores, render: renderer, prompt, convId,
    exit: false, vimMode: false,
    transcriptLines: [],
    standalone,
    /* /llm 配置后热切换引擎 */
    rebuildEngine: () => {
      const fresh = standalone
        ? assembleStandalone(wsDir, () => {})
        : assembleFull(wsDir, () => {});
      engine = fresh.engine;
      cfg = fresh.cfg;
      engine.emit = emit;
      ctx.engine = engine;
      ctx.cfg = cfg;
    },
  };

  ctx.prompt = ctx.prompt || prompt;
  if (!ctx.prompt.input) {
    ctx.prompt.input = async (label) => {
      const inq = require("@inquirer/prompts");
      return inq.input({ message: label || "›" });
    };
  }

  const { inputBox } = require("./inputbox");
  const history = [];

  function buildTranscriptLines() {
    const e = engine;
    const convId = e.currentConv ? e.currentConv() : ctx.convId;
    const conv = (e.conversations && e.conversations.get(convId)) || null;
    const hist = conv ? (conv.history || []) : (e.history || []);
    const lines = [];
    hist.forEach((m) => {
      const content = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : JSON.stringify(m.content));
      if (m.role === "user") {
        lines.push(S.inverseText(S.MOON_BAR + " " + content));
      } else if (m.role === "assistant") {
        lines.push(S.accent(S.MOON) + " " + content);
      } else if (m.role === "tool" || m.role === "function") {
        lines.push(S.dim("  " + S.TEARDROP + " " + (m.name || m.role) + ": " + content.slice(0, 100)));
      }
    });
    return [...lines, ...ctx.transcriptLines];
  }

  async function loop() {
    while (!ctx.exit) {
      let line;
      try {
        line = await inputBox({
          history,
          screen,
          /* 空行按 ^C 时：这一轮还在跑就中断它，而不是退出程序 */
          isRunning: () => !!(renderer.getState && renderer.getState().running),
          onInterrupt: () => { if (typeof engine.abort === "function") engine.abort(convId); },
          getStatus: () => {
            const model = (cfg.llm && cfg.llm.model) || "demo";
            const wsName = path.basename(wsDir || process.cwd());
            /* 水位来自渲染器收下的 context.usage 事件。
               原先这里问的是 engine.getContextUsage()——引擎没有这个方法，
               所以那段 try 永远静默失败，进度条一次都没出现。 */
            const ctx = (renderer.getStatus && renderer.getStatus()) || null;
            const state = (renderer.getState && renderer.getState()) || null;
            return { model, workspace: wsName, perm: (cfg.permissions && cfg.permissions.mode) || "ask", ctx, state };
          },
          onCommandPalette: async () => {
            const result = await commandPalette({
              onCommand: async (cmd) => {
                ctx.args = "";
                try { await cmd.run(ctx); } catch (e) { process.stdout.write(S.err("  命令出错：" + e.message + "\n")); }
              },
            });
            if (result && result.action) { await result.action(); return null; }
            if (result && result.label) { return { text: result.label }; }
            return null;
          },
          onHistorySearch: async (h) => { return historySearch(h); },
          onTranscript: async () => { await transcript(buildTranscriptLines()); },
          onExternalEditor: async (val) => { return externalEditor(val); },
        });
      } catch (e) {
        break;
      }
      if (!line.trim()) continue;
      history.push(line);
      if (history.length > 200) history.shift();

      const parsed = parse(line);
      if (parsed) {
        if (parsed.notFound) { process.stdout.write(S.err("  未知命令 /" + parsed.notFound + "，/help 看列表\n")); continue; }
        ctx.args = parsed.args;
        try { await parsed.cmd.run(ctx); } catch (e) { process.stdout.write(S.err("  命令出错：" + e.message + "\n")); }
        continue;
      }

      /* 不 await。引擎自己按会话排队：这条正在跑时下一条发 chat.queued 排队，
         收口后自动放行（server/agent-llm.js 的 _queueChat / _drainChatQueue）。
         await 在这儿等于把 REPL 钉死在"这轮跑完之前不许有输入框"上——
         用户看到的就是"一发问题输入框就没了"，长任务期间一个字也打不进去。
         上一版为躲"异步事件咬穿输入框"补的那句 setTimeout(800) 一并删掉：
         那是拿睡眠赌异步完成，而沉淀里还有三个 LLM 调用，慢的时候远超 0.8 秒。
         现在正文和帧都归 screen 仲裁，谁先到都一样落在框上方。 */
      renderer.resetRound();
      const run = Promise.resolve()
        .then(() => engine.handleChat(line, { convId }))
        .catch((e) => { screen.line(S.err("  " + ((e && e.message) || e))); });
      /* 管道里没有键盘可打字（echo "任务" | pancode 走的是输入框的非 TTY 分支），
         读到尽头不等这一轮就等于自己把它掐断。TTY 下不等——那才是"运行期输入框常驻"要的场景。 */
      if (!process.stdin.isTTY) await run;
    }
  }

  await loop();
  try { if (engine.flushConversations) engine.flushConversations(); } catch (_) {}
}

/* ---------- main ---------- */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("pancode-cli [任务文本] [--ws <工作区>]\n");
    process.stdout.write("  无参数起交互 REPL；带参数则单次任务跑完退出\n");
    return;
  }

  banner();

  /* --ws 未显式指定时，回退到配置文件的 workspace */
  if (!args.wsExplicit) {
    try {
      if (HAS_SERVER) {
        require("../server/dotenv").loadDotEnv();
        const configMod = require("../server/config");
        const cfg0 = configMod.load();
        if (cfg0.workspace && fs.existsSync(cfg0.workspace)) {
          args.ws = path.resolve(cfg0.workspace);
        }
      } else {
        const configMod = require("./lib/config");
        const cfg0 = configMod.load();
        if (cfg0.workspace && fs.existsSync(cfg0.workspace)) {
          args.ws = path.resolve(cfg0.workspace);
        }
      }
    } catch (_) {}
  }

  let assembled;
  try {
    assembled = await assembleEngine(args.ws, () => {});
  } catch (e) {
    process.stdout.write(S.err("引擎装配失败：" + (e.stack || e.message || e) + "\n"));
    process.exit(1);
  }

  const { engine, stores, cfg, standalone } = assembled;
  const modelName = (cfg.llm && cfg.llm.model) ? cfg.llm.model : "演示引擎（无 API Key）";
  process.stdout.write("  " + S.accent(S.MOON) + " " + S.accentShim(S.mod.bold(modelName)) + S.dim("  ·  ") + S.inactive(path.basename(args.ws)) + "\n\n");

  if (args.once) {
    const renderer = createRenderer({
      onApprove: async (ev) => { const r = await prompt.approval(ev); if (r.stop) process.exit(0); if (engine.resolveApproval) engine.resolveApproval(ev.id, r.ok); if (r.session && r.ok && engine.grantSession) engine.grantSession(ev.tool); },
      onChoice: async (ev) => { const r = await prompt.choice(ev); if (engine.resolveChoice) engine.resolveChoice(ev.id, r.value); },
    });
    if (engine.emit) engine.emit = (ev) => renderer.handleEvent(ev);
    try {
      await engine.handleChat(args.once, { convId: "cli-once" });
    } catch (e) {
      process.stdout.write(S.err("  " + (e.message || e) + "\n"));
    }
    renderer.resetRound();
    try { if (engine.flushConversations) engine.flushConversations(); } catch (_) {}
    return;
  }

  await repl({ engine, stores, cfg, wsDir: args.ws, standalone });
}

/* 只有被当作命令执行时才跑主流程。
   加这道闸是为了让 banner/parseArgs 能被探针 require 到——原先 require("./cli")
   会当场执行 main()：装配引擎、占数据根、进 REPL，探针根本没法只量一个纯函数。 */
if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(String((e && e.stack) || e) + "\n");
    process.exit(1);
  });
}

module.exports = { banner, parseArgs };
