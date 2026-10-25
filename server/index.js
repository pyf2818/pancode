/* ============================================================
   pancode 服务端入口 v2.0
   Express 静态服务 + REST API + WebSocket 实时网关
   模块化：config / files / git / terminal / llm / agent 双轨
   ============================================================ */
"use strict";
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

require("./dotenv").loadDotEnv();   // 启动即加载本地 .env（LLM 密钥来源，已被 .gitignore 忽略）
const configMod = require("./config");
const wsKey = require("./ws-key");            // 工作区分片键唯一来源（老键改名迁移）
const { FileStore, langOf } = require("./files");
const { GitLayer } = require("./git");
const { summarize, docDraft } = require("./change-summary");
const { TerminalLayer } = require("./terminal");
const { ProcessLayer } = require("./processes");
const { ping } = require("./llm");
const { LlmAgent, _ctx: agentCtx } = require("./agent-llm");
const { TaskBoard } = require("./tasks");
const { RootGrants } = require("./root-grants");
const { writeAudit } = require("./security");   // 敏感目录授权等敏感动作要留痕
const { RootStore } = require("./root-store");
const evScope = require("./event-scope");
const { DemoAgent } = require("./agent-demo");
const { LspManager, setActiveManager } = require("./lsp-bridge");
const log = require("./logger");
const usageStore = require("./usage-store");   // P1-B4 用量账本（面板与 /api/usage 共用一份）
const codeIndex = require("./code-index");
const { SoulStore } = require("./soul-store");
const { SkillStore } = require("./skill-store");
const { MemoryStore } = require("./memory-store");
const { histList: orchHistList, histGet: orchHistGet } = require("./orchestrator"); // 编排历史（服务端落盘）
const { ExpertStore, parseExpertMd } = require("./expert-store"); // W2 专家注册表
const rulesLib = require("./rules"); // T4 规则可视化管理：与 loadRules 同源
const ruleHistory = require("./rule-history"); // P1-B5 写前快照：历史不在 .pancode/rules 里，避免被当规则注入
const ruleProp = require("./rule-proposals"); // P3-D3 自进化规则：证据→提案→人工采纳
const { AutomationStore, Scheduler } = require("./scheduler"); // W4 自动化任务
const { PlanStore } = require("./plan-store");
const { WorkflowStore } = require("./workflow-store");

const { ProgressionStore } = require("./progression-store");
const { computeProgression, PATHS } = require("./progression");
const auth = require("./auth");
const VERSION = (() => { try { return require("../package.json").version; } catch (e) { return "2.3.0"; } })();
/* 接口指纹：前端 public/app.js 里有一份同名常量，两边必须一起改。
   用途是"后端进程比界面旧"的自检——express.static 每次从磁盘读 public/，所以刷新页面就拿到新界面，
   但 /api/* 由启动时 require 的这份进程决定；只重启前端不重启服务时，新界面会去调旧进程里没有的接口，
   用户看到的就是设置里整片「HTTP 404 加载失败」。 */
const API_STAMP = process.env.PANCODE_API_STAMP || "2026.09.28.2";

const cfg = configMod.load();

/* ---------- MCP 管理器（外部工具服务器，零依赖 stdio JSON-RPC） ---------- */
const { initMcpManager } = require("./mcp");
const mcpManager = initMcpManager(cfg);
mcpManager.onStatus = () => { try { broadcast({ type: "mcp.servers", servers: mcpManager.statusList() }); } catch (e) {} };

/* 本地访问令牌：REST/WS 鉴权用。绑定 127.0.0.1 后仅本机可达；可用 PANCODE_TOKEN 固定 */
const AUTH_TOKEN = process.env.PANCODE_TOKEN || crypto.randomBytes(18).toString("hex");

const clients = new Set();
/* 第二个参数决定"这条事件属于谁"：给了就只发那个用户的连接，不给（或 anon）就广播。
   判据与理由见 server/event-scope.js。发送包 try/catch 是新加的一环：
   过滤之后收件人变少了，一个已断的连接抛错会把后面那个本来该收到的人整段跳过。 */
function broadcast(ev, userKey) {
  const s = JSON.stringify(ev);
  for (const c of evScope.recipients(clients, userKey)) {
    try { c.send(s); } catch (e) { /* 连接正在关：心跳那一轮会把它摘掉 */ }
  }
}

/* W11：事件循环延迟（ELD）探针
   每 1s 用 setImmediate 实测"从排定到执行"的偏差，反映主进程是否繁忙 / 被重计算阻塞。
   用途：(1) 前端状态栏提示用户感知卡顿源；(2) 为"进程隔离"改造提供量化基线。 */
let _eldMs = 0, _eldMaxMs = 0;
setInterval(() => {
  const s = process.hrtime.bigint();
  setImmediate(() => {
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    _eldMs = ms;
    if (ms > _eldMaxMs) _eldMaxMs = ms;
  });
}, 1000);
// 周期性把 ELD 推到前端（不依赖会话轮询）
setInterval(() => {
  broadcast({ type: "system.perf", eld: Math.round(_eldMs * 10) / 10, eldMax: Math.round(_eldMaxMs * 10) / 10, uptime: Math.round(process.uptime()) });
}, 3000);

/* ---------- 工作区挂载（核心：任意本地文件夹都可以成为工作区） ---------- */
let WS_DIR = null;
let files = null, git = null, term = null, procs = null, engine = null, soulStore = null, progressionStore = null, skillStore = null;
let taskBoard = null;   // 任务表：派出去的活到哪一步了（关窗/断线后回来还能查）
/* 全局授权根清单：一台机器一份，落 <数据根>/.pancode/roots.json，不按工作区分片。
   用户拍板的是"全局一份"（类操作系统的权限面板），所以它必须在挂载之前就存在——
   挂载动作本身要往清单里登记当前工作区。 */
const rootGrants = new RootGrants(path.join(configMod.ROOT, ".pancode", "roots.json"), configMod.ROOT);
/* 多根路径解析：把"这个路径属于哪个已授权根"集中一处回答，工具不再各自判越界。
   审计目录全根共用一份（撤销授权要能在审计里追到）。 */
const rootStore = new RootStore({
  grants: rootGrants,
  dataRoot: configMod.ROOT,
  auditDir: path.join(configMod.ROOT, ".pancode", "audit"),
});
let automationStore = null, schedulerInst = null; // W4 自动化任务（随工作区重建）
const userEngines = new Map();   // userKey -> LlmAgent（每个登录用户一份，会话/目标/trace 独立）
const _engineAssets = {};        // 共享资产（memory/skills/plan/... 按工作区一份，跨用户共用）

/* 构建共享资产（不创建 LlmAgent），再由 ensureUserEngine 按 userKey 分片。
   项目级资产（记忆/技能/计划/灵魂/进度）跨用户共享——它们是"项目知识"而非"个人会话"。 */
function buildEngine() {
  // 切换/重挂工作区：先刷盘各用户的会话上下文（防丢失），再清掉旧工作区的按用户引擎（其闭包指向旧 files/git/term），避免残留串用
  for (const eng of userEngines.values()) {
    try { if (eng && typeof eng.flushConversations === "function") eng.flushConversations(); } catch (_) {}
  }
  userEngines.clear();
  const ws = wsKey.forWorkspace(WS_DIR, configMod.ROOT);   // 全部项目级分片只用这一个键
  const marketDir = path.join(configMod.ROOT, ".pancode", "skills", "market");
  const skillDir = path.join(configMod.ROOT, ".pancode", "skills");
  _engineAssets.skillStore = new SkillStore(marketDir, ws.file(skillDir), path.join(__dirname, "builtin-skills"), path.join(require("os").homedir(), ".pancode", "skills")); // W1：+ 用户级目录
  _engineAssets.memDir = path.join(configMod.ROOT, ".pancode", "memory");
  _engineAssets.memory = new MemoryStore(ws.file(_engineAssets.memDir));
  // W3：用户级记忆（跨项目偏好/约定），~/.pancode/memory/user.json，随工作区重挂共享同一实例
  _engineAssets.userMemory = new MemoryStore(path.join(require("os").homedir(), ".pancode", "memory", "user.json"));
  // W2：专家注册表（项目级 = <工作区>/.pancode/experts，用户级 = ~/.pancode/experts，内置 = BUILTIN_EXPERTS）
  _engineAssets.experts = new ExpertStore(WS_DIR ? path.join(WS_DIR, ".pancode", "experts") : null,
    path.join(require("os").homedir(), ".pancode", "experts"));
  // W4：自动化任务（ROOT/.pancode/automations/<分片键>/，随工作区重建；停掉旧调度器防泄漏）
  if (schedulerInst) { try { schedulerInst.stop(); } catch (_) {} schedulerInst = null; }
  automationStore = new AutomationStore(ws.subdir(path.join(configMod.ROOT, ".pancode", "automations")));
  schedulerInst = new Scheduler(automationStore, () => engine);
  /* 定时器跑的活也要走"派出去 → 回来查 → 被通知"：开跑先落一行 running，收口再翻成 done/failed。
     必须先有 running 这一面——桌面端每 3s 轮询比较前后两次快照，只在"翻面"那一刻弹通知；
     若开跑与收口都发生在两次轮询之间，通知就会静默丢失。 */
  schedulerInst.onStart = (id, t) => {
    if (!taskBoard) return;
    taskBoard.begin("automation", "auto-" + id, "自动化：" + ((t && t.name) || id), "automation");
    broadcast({ type: "term.line", text: "[自动化] 开始执行「" + ((t && t.name) || id) + "」", cls: "tl-info" });
  };
  schedulerInst.onFire = (id, rec) => {
    if (!taskBoard) return;
    let name = id;
    try { const t = automationStore.get(id); if (t && t.name) name = t.name; } catch (e) {}
    taskBoard.end("automation", "auto-" + id, rec && rec.ok ? "done" : "failed", { error: (rec && rec.error) || "" });
    broadcast({
      type: "term.line",
      text: "[自动化]「" + name + "」" + (rec && rec.ok ? "跑完了" : "失败：" + ((rec && rec.error) || "未知原因")),
      cls: rec && rec.ok ? "tl-info" : "tl-err",
    });
  };
  schedulerInst.start();
  const planDir = path.join(configMod.ROOT, ".pancode", "plans");
  _engineAssets.plan = new PlanStore(ws.file(planDir));
  const wfDir = path.join(configMod.ROOT, ".pancode", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  _engineAssets.workflow = new WorkflowStore(ws.file(wfDir));
  const soulDir = path.join(configMod.ROOT, ".pancode", "soul");
  _engineAssets.soul = new SoulStore(ws.file(soulDir));
  const progDir = path.join(configMod.ROOT, ".pancode", "progression");
  _engineAssets.progression = new ProgressionStore(ws.file(progDir));
  /* P3-D3 规则提案账本：与记忆同一套分片键（换工作区不串台），
     记的是"这条证据有没有被人裁决过"——采纳/忽略必须活过一次重启，
     否则每次开面板都把用户已经拒绝过的提案再催一遍。 */
  _engineAssets.ruleProposals = new ruleProp.ProposalStore(
    ws.file(path.join(configMod.ROOT, ".pancode", "rule-proposals")));
  _engineAssets.cfg = cfg;
  // 任务表按工作区分片；换工作区即换表（旧表的行属于旧目录，不该串到新目录里显示）
  taskBoard = new TaskBoard(ws.file(path.join(configMod.ROOT, ".pancode", "tasks")));
  if (taskBoard.interruptedCount) {
    log.tag("tasks").info("上次进程退出时有 " + taskBoard.interruptedCount + " 个任务未收口，已标为 interrupted");
  }
  // 默认 engine（helloPayload 等全局状态用）
  engine = ensureUserEngine("anon");
  soulStore = _engineAssets.soul;
  progressionStore = _engineAssets.progression;   // 同 soulStore：HTTP 侧与 Agent 侧必须共用同一实例，否则一边写一边读旧态
  /* 分片键归并结果要说得出口：搬了哪些文件、还留着哪些同工作区的老键名等人合并 */
  const moved = wsKey.drainMigrated();
  if (moved.length) {
    log.tag("workspace").info("分片键归并 " + moved.length + " 个文件："
      + moved.map((m) => path.basename(m.from) + " → " + path.basename(m.to)).join("、"));
  }
  for (const d of wsKey.drainDrift()) {
    log.tag("workspace").warn(d.dir + " 下同属本工作区还有别的历史分片（当前读 " + d.live + "）："
      + (d.leftovers || []).join("、") + (d.error ? "（改名失败，退回原文件：" + d.error + "）" : "") + "；内容合并需人工确认。");
  }
}

/* 从 Agent 事件流里维护任务表。事件由内核统一带 convId（AsyncLocalStorage 注入），
   所以这里不需要知道引擎内部状态，也不新增一条上报通道。 */
function observeTask(ev, userKey) {
  if (!taskBoard || !ev) return;
  /* LLM 引擎的事件由 AsyncLocalStorage 统一带上 convId；演示引擎（无 API Key 时桌面端开箱就是它）
     不带。取不到就退回该用户引擎的当前会话——否则任务表在没有 Key 的装机上是空的。 */
  const convId = ev.convId || (userEngines.get(userKey) || {})._currentConv;
  if (!convId) return;
  try {
    switch (ev.type) {
      case "user.msg": taskBoard.begin(userKey, convId, ev.text); break;
      case "tool.end": taskBoard.inc(userKey, convId, "tools", true); break;
      case "tool.pending": taskBoard.note(userKey, convId, { status: "waiting", waitingFor: ev.tool || "" }); break;
      case "goal.continue": taskBoard.note(userKey, convId, { status: "running", turns: ev.turn, waitingFor: "" }); break;
      case "chat.queued": taskBoard.note(userKey, convId, { queueLen: ev.position }); break;
      case "chat.dequeued": taskBoard.note(userKey, convId, { queueLen: ev.remaining }); break;
      case "agent.error": taskBoard.end(userKey, convId, "failed", { error: String(ev.message || "").slice(0, 300) }); break;
      case "agent.done": {
        /* 出错收口时 finally 照样会发一条 agent.done —— 那句是"这一轮结束了"，不是"成功了"。
           以前它无条件把 failed 盖回 done，于是跑挂的任务在任务表 / 托盘 / 系统通知里全变成"完成"，
           用户只能看见"计划 3/9 之后就没动静"，这就是"经常无故中断"里被吞掉的那一半。
           已经判失败的行保持 failed；下一轮 begin() 会把 error 清掉，不会串台。 */
        const cur = taskBoard._find(userKey, convId);
        const keep = !!(cur && cur.status === "failed");
        taskBoard.end(userKey, convId, keep ? "failed" : (ev.aborted ? "aborted" : "done"),
          keep ? { waitingFor: "" } : { waitingFor: "", error: "" });
        break;
      }
    }
  } catch (e) { /* 任务表绝不反过来影响主链路 */ }
}

/* 按 userKey 获取或创建该用户的 LlmAgent 实例。每个用户的 history/conversations/goal/trace 独立，
   但共享 memory/skills/plan/soul/files/git/term/procs 等重资产。 */
function ensureUserEngine(userKey) {
  if (userEngines.has(userKey)) return userEngines.get(userKey);
  const a = _engineAssets;
  const ctx = {
    emit: (ev) => { observeTask(ev, userKey); broadcast(ev, userKey); }, files, git, term, procs, cfg: a.cfg,
    roots: rootStore,   // 多根路径解析（阶段二）：不带 root 的调用仍然落在当前工作区
    skills: a.skillStore,
    sharedMemory: a.memory, sharedPlan: a.plan, sharedWorkflow: a.workflow,
    sharedUserMemory: a.userMemory,
    sharedExperts: a.experts, // W2：专家注册表
    sharedSoul: a.soul, sharedProgression: a.progression,
    userKey,
  };
  const eng = configMod.engineMode(cfg) === "llm" ? new LlmAgent(ctx) : new DemoAgent(ctx);
  userEngines.set(userKey, eng);
  // 上限：最多 20 个用户实例（与 CONV_MAX 对齐，防止恶意/异常大量连接撑爆内存）
  if (userEngines.size > 20) {
    const oldest = userEngines.keys().next().value;
    if (oldest && oldest !== userKey) {
      const old = userEngines.get(oldest);
      try { if (old && typeof old.flushConversations === "function") old.flushConversations(); } catch (_) {}
      userEngines.delete(oldest);
    }
  }
  return eng;
}

/* 从 WS 取 userKey：登录用户 = token 的 8 位哈希（会话/目标按人隔离），无 token = "anon"。
   工作区维度由 agent 构造器内部用分片键组合，此处不重复拼，保持文件名片段干净（Windows 安全）。 */
function wsUserKey(ws) {
  return tokenUserKey(ws._userToken || "");
}

/* 同一个 token 算同一个 key：REST 也要能拿到"这个用户正在用的那个引擎"，
   否则面板与 Agent 会各自持有一份 repo 索引缓存，一边新一边旧。 */
function tokenUserKey(tok) {
  if (!tok) return "anon";
  return "u" + crypto.createHash("md5").update(tok).digest("hex").slice(0, 8);
}

function mountWorkspace(dir) {
  const abs = path.resolve(dir);
  let st;
  try { st = fs.statSync(abs); } catch (e) { throw new Error("文件夹不存在: " + abs); }
  if (!st.isDirectory()) throw new Error("不是文件夹: " + abs);
  try { fs.accessSync(abs, fs.constants.R_OK); } catch (e) { throw new Error("没有读取权限: " + abs); }

  if (files) files.stopWatch();
  if (procs) { try { procs.stopAll(); } catch (e) {} }   // 切换工作区前清理上一工作区的后台进程（孤儿防护）
  WS_DIR = abs;
  /* 活动工作区必须在授权清单里，否则阶段二把工具接到清单上之后，第一个吃亏的就是当前目录。
     add 的行是同步进内存的，这里不等落盘——挂载失败不该被一次写盘拖住。 */
  /* 不往清单里写"当前工作区"这种会变的状态：它是每次请求现算的徽标（workbench 按 active 上色）。
     当年写进 roots.json 的后果是切过一次工作区后，两条授权行都自称"当前工作区"（实测在真实例里看到过）。 */
  rootGrants.ensure(abs).catch((e) => log.tag("roots").warn("授权清单登记失败 " + e));
  files = new FileStore(WS_DIR, path.join(configMod.ROOT, ".pancode", "audit"));
  /* 活动根认的就是这个实例：不能再造第二个，否则同一目录两份 fs.watch，外部改动会被推两遍 */
  rootStore.setActive(WS_DIR, files);
  git = new GitLayer(WS_DIR, files);
  require("./security").setAuditDir(path.join(configMod.ROOT, ".pancode", "audit")); // W14：agent 层审计统一落同一目录
  /* P3-D1 决策链：与 audit 同根不同文件（audit 是"做了什么动作"的人话流水，格式已被探针钉住；
     这边是"当时怎么判断的"结构化 JSONL，按 convId 能还原一整局）。 */
  require("./decision-log").setDecisionDir(path.join(configMod.ROOT, ".pancode", "decisions"));
  term = new TerminalLayer(WS_DIR, broadcast, path.join(configMod.ROOT, ".pancode", "audit"), cfg.permissions.strictCommand !== false);
  procs = new ProcessLayer(WS_DIR, broadcast, path.join(configMod.ROOT, ".pancode", "audit"));
  buildEngine();
  /* W26：演示引擎 + 完全空的工作区 → 铺示例项目。演示剧本要读 README/src/tests 并
     真实跑 tests/run-tests.js，空工作区上第一跑就是一串 ENOENT，观感是"演示坏了"。
     只在 readdir 为空时铺，绝不碰用户已有文件（smoke/探针的夹具工作区都不受影响）。 */
  require("./demo-seed").seedDemoWorkspace(WS_DIR, configMod.engineMode(cfg) !== "llm");
  files.startWatch((batch) => { syncAfterExternalChange(batch).catch((e) => log.tag("fs").warn("外部改动同步失败: " + e.message)); });
  log.tag("workspace").info("workspace 已挂载: " + WS_DIR);
}

/* 启动时挂载：绝对路径直接用，相对路径相对数据根（兼容旧配置 "workspace"）
   打包态：默认相对工作区（如 userData/workspace）可能不存在 → 先创建空目录，保证应用可启动 */
const wsArg = cfg.workspace;
const wsAbs = path.isAbsolute(wsArg) ? wsArg : path.resolve(configMod.ROOT, wsArg);
try { fs.mkdirSync(wsAbs, { recursive: true }); } catch (e) {}
mountWorkspace(wsAbs);

/* ---------- 快照/状态 ---------- */
/* 取基线优先走 git.baselinePlanner()：一次 ls-files + 一次 status 就把绝大多数文件的基线定下来，
   只有真被修改的文件才发 `git show`。旧写法每个文件发一次子进程，实测 126ms × 127 文件
   = 22.3s 才出第一屏（hello 里带全量 files）。 */
async function snapshotFiles() {
  const out = {};
  const pick = await git.baselinePlanner();
  for (const rel of files.list()) {
    // 二进制文件（Word/图片/压缩包等）：出现在文件树，但不读内容（按文本读必乱码）
    if (files.isBinary(rel)) {
      let size = 0;
      try { size = fs.statSync(files.safePath(rel)).size; } catch (e) {}
      out[rel] = { content: "", original: "", isNew: false, lang: "binary", binary: true, size };
      continue;
    }
    let content;
    try { content = files.read(rel); } catch (e) { continue; }
    const base = pick ? await pick(rel, content) : await git.baseline(rel);
    out[rel] = {
      content,
      original: base === null ? "" : base,
      isNew: base === null,
      lang: langOf(rel),
    };
  }
  return out;
}

/* 增量快照：只读取指定路径，避免大工作区全量读盘 */
async function snapshotFilesIncremental(paths) {
  const out = {};
  const pick = await git.baselinePlanner();
  for (const rel of paths) {
    if (files.isBinary(rel)) {
      let size = 0;
      try { size = fs.statSync(files.safePath(rel)).size; } catch (e) {}
      out[rel] = { content: "", original: "", isNew: false, lang: "binary", binary: true, size };
      continue;
    }
    let content;
    try { content = files.read(rel); } catch (e) { continue; }
    const base = pick ? await pick(rel, content) : await git.baseline(rel);
    out[rel] = {
      content,
      original: base === null ? "" : base,
      isNew: base === null,
      lang: langOf(rel),
    };
  }
  return out;
}

/* 外部改盘之后的同步：能只读被点名的那几个文件，就绝不重读整棵树。

   判据只有一个问题——**文件集合变了吗**。没变（用户在别的编辑器里改、测试写回既有文件、
   格式化插件跑了一遍）就只读那几个被点名的路径，广播带 incremental 让前端合并；
   变了（新增 / 删除 / 改名）必须走全量，因为前端的增量分支只覆盖传入路径、不会删掉消失的文件
   （app.js:2183），漏一次删除界面上就还留着一个点得开的幽灵文件。

   以前这里不看事件说了什么，一律全量：≤500 个文件逐个 readFileSync + 整包 JSON 广播给所有连接。
   七八小时的任务里外部改盘是几十次起步，这一条就是"越跑越卡"里属于快照那半截的成因。
   _syncedPaths 记的是"前端此刻手里那份集合"；file.create/delete/reset 那些分支也发全量但没来更新它，
   代价是下一次外部改动多走一次全量——只是少省一点，绝不会算错，所以不在这儿重复维护。 */
let _syncedPaths = null;
async function syncAfterExternalChange(batch) {
  const { planSync } = require("./sync-plan");
  const paths = Array.isArray(batch) ? batch : [];
  const cur = new Set(files.list());
  const plan = planSync(paths, _syncedPaths, cur);
  /* 语义索引以前只吃显式写盘那几条路径（file.save / applyPatch / 工具直写），
     外部改动从不喂进去 —— Agent 在别的进程刚改过的代码上，检索到的还是旧内容。 */
  for (const p of paths) if (p) { try { codeIndex.queueFileUpdate(WS_DIR, p); } catch (e) { /* 索引没建过就是空操作 */ } }
  if (plan.mode === "none") return;
  if (plan.mode === "incremental") {
    const out = await snapshotFilesIncremental(plan.changed);
    _syncedPaths = cur;
    broadcast({ type: "fs.sync", files: out, incremental: true });
    return;
  }
  const out = await snapshotFiles();
  _syncedPaths = cur;
  broadcast({ type: "fs.sync", files: out });
}

async function helloPayload(eng, userKey) {
  const e = eng || engine;
  const fileMap = await snapshotFiles();
  /* hello 带的就是全量，顺手把"前端手里那份集合"记下来：
     不记的话第一条外部改动永远走全量，判据等于白改。 */
  _syncedPaths = new Set(Object.keys(fileMap));
  return {
    type: "hello",
    files: fileMap,
    running: e.running,
    round: e.round,
    engine: configMod.publicInfo(cfg),
    agent: configMod.agentSettings(cfg),
    lsp: lspManager.capabilities(),
    git: git.info(),
    project: path.basename(WS_DIR),
    /* wsId 是前端 localStorage 的会话存储 key 后缀（app.js 拼 cw-conv-v1:<id>），故意沿用旧的
       31 项多项式哈希：换算法等于让老用户浏览器里的历史列表凭空消失。磁盘分片键走 wsKey，两码事。 */
    wsId: wsKey.legacyStorageId(WS_DIR),
    workspace: WS_DIR,
    truncated: !!files.truncated,
    tabs: term.list(),          // 还原多标签终端（同一服务进程内刷新可恢复）
    tasks: taskBoard ? taskBoard.snapshot(userKey) : [],   // 进行中/最近收口的任务（关窗回来能查）
  };
}

/* ---------- HTTP ---------- */
const app = express();
app.use(express.json({ limit: "2mb" }));
// vendor/（Monaco 等）长缓存 immutable，版本升级时靠 URL 查询参数 ?v= 强制刷新
app.use("/vendor", express.static(path.join(__dirname, "..", "public", "vendor"), { maxAge: "1y", immutable: true }));
app.use(express.static(path.join(__dirname, "..", "public")));

/* A8+：本机回环判定的唯一口径（HTTP Host 头与 WS 升级共用）。
   注意必须精确匹配：前缀正则曾是 `^localhost` 无 `$` 锚 —— localhost.evil.com
   一样通过，等于没拦。取 hostname（剥端口、剥 IPv6 方括号）后查集合。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
function hostNameOf(hostHeader) {
  const h = String(hostHeader || "").trim();
  if (!h) return "";
  if (h[0] === "[") { const i = h.indexOf("]"); return i < 0 ? h.slice(1) : h.slice(1, i); }
  const i = h.lastIndexOf(":");
  return i > -1 ? h.slice(0, i) : h;
}
function isLocalHostHeader(hostHeader) {
  return LOOPBACK_HOSTS.has(hostNameOf(hostHeader).toLowerCase());
}

/* DNS rebinding 防护：evil.com 的域名重绑到 127.0.0.1 后，页面发起的请求变"同源"，
   浏览器对同源 GET 不带 Origin —— CORS 整套对它失效，只能靠 Host 头还认不认得出
   "这不是发给我们这个本机服务的请求"。所有 HTTP 请求（含静态资源）统一过这道闸。 */
app.use((req, res, next) => {
  if (!isLocalHostHeader(req.headers.host)) {
    return res.status(403).json({ ok: false, error: "非法 Host（本服务仅本机回环可达）" });
  }
  next();
});

/* A8：CORS 收紧——本地优先工具只允许同源或本机回环访问，拒绝跨站请求（防 CSRF 式滥用） */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();                               // 非浏览器（curl/同源）放行
  let hostname;
  try { hostname = new URL(origin).hostname; } catch (e) { return res.status(403).json({ ok: false, error: "非法 Origin" }); }
  if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) return res.status(403).json({ ok: false, error: "跨站请求被拒绝" });
  res.setHeader("Access-Control-Allow-Origin", origin);     // 本机 Origin 反射
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-user-token");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- 本地鉴权 ---------- */
/* A2：收紧白名单——仅保留本机可匿名访问的引导类端点；业务/敏感端点全部要求登录后的 userToken */
const NO_AUTH = new Set([
  "/api/health",        // 健康探测
  "/api/bootstrap",     // 本机领取访问令牌（绑定 127.0.0.1）
  "/api/version",       // 版本信息
  "/api/auth/register", // 注册（首次建账号）
  "/api/auth/login",    // 登录
  "/api/auth/status",   // 查询登录态（前端启动判定）
  "/api/auth/auto",     // W25 个人模式：本机自动身份（路由内再验 remoteAddress；多账号取最近创建的签发）
  "/api/preview/docx",  // 仅预览渲染辅助，不泄露源码正文
  "/api/index/status",  // 本地代码索引状态查询（本地优先工具，与 health 同级）
  "/api/index/build",   // 本地代码索引构建
  "/api/index/search",  // 本地代码索引检索

]);
/* A1：用户会话闸门——仅校验登录后下发的 userToken（auth.verify）；AUTH_TOKEN 仅用于本机 bootstrap 与 WS 环回 */
/* 修 C-B2：令牌不再走 query string。
   query 会进浏览器历史、Referer 头、代理/服务器访问日志、以及崩溃报告——四处都会留痕。
   现在只认 header；query 兜底保留但默认关闭（PANCODE_ALLOW_TOKEN_QUERY=1 可临时开，
   供老版本前端/老脚本平滑升级）。 */
function bearerToken(req) {
  const h = (req.headers && (req.headers["x-user-token"] || req.headers["authorization"])) || "";
  const raw = h || "";
  return raw.startsWith("Bearer ") ? raw.slice(7) : raw;
}
function legacyQueryToken(req) {
  if (process.env.PANCODE_ALLOW_TOKEN_QUERY === "1" && req.query) return String(req.query.userToken || "");
  return "";
}
function tokenOf(req) {
  return bearerToken(req) || legacyQueryToken(req);
}
function userAuthed(req) {
  return !!auth.verify(tokenOf(req));
}
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();                       // 静态资源不鉴权
  if (NO_AUTH.has(req.path)) return next();                               // 白名单（引导类）
  if (!userAuthed(req)) return res.status(401).json({ ok: false, error: "未授权：请先登录", code: "NO_AUTH" });
  next();
});

app.get("/api/state", async (req, res) => res.json({ version: VERSION, files: await snapshotFiles(), git: git.info(), eld: { ms: Math.round(_eldMs * 10) / 10, max: Math.round(_eldMaxMs * 10) / 10 }, engine: configMod.publicInfo(cfg) }));

/* W15：审计日志查询——受全局鉴权保护（非白名单），可查指定日期的全部命令/文件变更 */
app.get("/api/audit", (req, res) => {
  try {
    const date = (req.query.date || new Date().toISOString().slice(0, 10)).toString().replace(/[^0-9-]/g, "");
    const f = path.join(configMod.ROOT, ".pancode", "audit", date + ".log");
    if (!fs.existsSync(f)) return res.json({ ok: true, date, lines: [] });
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean);
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    res.json({ ok: true, date, lines: lines.slice(-limit) });
  } catch (e) { res.json({ ok: false, error: String(e) }); }
});
/* 审计日志按天分文件：先让前端知道有哪些日期可查 */
app.get("/api/audit/dates", (req, res) => {
  try {
    const dir = path.join(configMod.ROOT, ".pancode", "audit");
    const dates = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse().slice(0, 60)
      : [];
    res.json({ ok: true, dates });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* P3-D1 决策链：?date=&convId=&kind=&limit=（默认今天 / 全部会话 / 最近 300 条，时间正序）。
   与 /api/audit 一样受全局鉴权保护——它能看出"用户拒过哪些命令、放行过哪些写盘"，不是公开信息。 */
app.get("/api/decisions", (req, res) => {
  try {
    const dl = require("./decision-log");
    const date = (req.query.date || "").toString().replace(/[^0-9-]/g, "") || undefined;
    const decisions = dl.readDecisions({
      date,
      convId: req.query.convId ? String(req.query.convId) : undefined,
      kind: req.query.kind ? String(req.query.kind) : undefined,
      limit: parseInt(req.query.limit, 10) || 300,
    });
    res.json({ ok: true, date: date || new Date().toISOString().slice(0, 10), decisions, path: dl.decisionDir() });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get("/api/decisions/dates", (req, res) => {
  try { res.json({ ok: true, dates: require("./decision-log").decisionDates() }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
/* ---------- P-H3 撤销（undo）的界面入口 ----------
   引擎里一直有这套检查点（_snapshotBefore / _pushCheckpoint / _undoLast + shadow git），
   但只有 Agent 自己能调的 undo 工具，用户手上没有任何按钮或接口能用它 —— 这里补的就是这一段。
   ⚠ 必须按"请求者是谁"取引擎：撤销栈挂在每个用户的引擎实例上（与 /api/graph 同一个坑），
     拿匿名实例去读会看到一份空栈，表现为"明明刚改过文件却说没有可撤销的"。 */
function undoEngine(req) { return ensureUserEngine(tokenUserKey(tokenOf(req))); }
app.get("/api/undo", (req, res) => {
  try {
    const eng = undoEngine(req);
    const steps = typeof eng.undoSteps === "function" ? eng.undoSteps() : [];
    res.json({ ok: true, steps, depth: steps.length });
  } catch (e) { res.json({ ok: false, error: e.message, steps: [] }); }
});
app.post("/api/undo", (req, res) => {
  try {
    const eng = undoEngine(req);
    if (typeof eng.undoSteps !== "function" || typeof eng._undoLast !== "function") {
      return res.json({ ok: false, error: "当前引擎不支持撤销（演示引擎没有写盘检查点）" });
    }
    const steps = eng.undoSteps();
    if (!steps.length) return res.json({ ok: false, empty: true, error: "没有可撤销的改动了：本次运行没写过文件，本机影子快照里也没有可回退的检查点（初始全量快照不算一步）" });
    const conv = String((req.body && req.body.convId) || "");
    /* 撤销是后进先出的，能撤的只有栈顶那一步。顶上的改动属于另一个会话时直接说明，
       而不是悄悄把别人的工作回滚掉 —— 那才是这个按钮最危险的误用面。 */
    if (conv && steps[0].convId && steps[0].convId !== conv) {
      return res.json({ ok: false, cross: true, error: "最近一步改动属于另一个会话（" + steps[0].label + "），没有替你撤销它" });
    }
    const top = steps[0];
    const r = eng._undoLast();
    if (!r || !r.ok) return res.json({ ok: false, error: (r && r.reason) || "撤销失败" });
    /* removed 那半截也要出去：shadow 回退会删掉那一步新建的文件，
       只报 restored 的话，界面说的数字比真的动过的文件少。 */
    writeAudit("undo", "撤销 " + (r.label || top.label) + " → "
      + (r.restored || []).concat((r.removed || []).map((p) => "删 " + p)).join("、"));
    res.json({ ok: true, label: r.label || top.label, restored: r.restored || [], removed: r.removed || [], left: eng.undoSteps().length });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 服务日志环（P0-A1）：内存里最近 log.ringMax 条结构化日志，诊断面板与排障共用一个入口。
   刻意不落盘：日志自己写坏盘是新引入的风险，而这里的语义是"刚刚发生了什么"，
   重启即空是明确取舍（要留久的东西走 .pancode/audit，那边是按天分文件的动作审计，不是运行日志）。
   鉴权：本端点不在 NO_AUTH 白名单里，所以走全局 userToken 闸门——它能读出模块名、
   出错堆栈首行与 reqId，匿名请求等于把内部结构递到本机任意进程手上。 */
app.get("/api/logs", (req, res) => {
  try {
    const cap = log.ringMax;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, cap);
    res.json({
      ok: true, level: log.level(), json: log.jsonMode(), capacity: cap,
      entries: log.readRing({
        limit, level: req.query.level, module: req.query.module,
        reqId: req.query.reqId, q: req.query.q,
      }),
    });
  } catch (e) { res.json({ ok: false, error: String(e && e.message || e) }); }
});
/* 用量与成本（P1-B4）：?days=30 → 按天 / 按模型的 token 与金额汇总。
   鉴权：不在 NO_AUTH 白名单里，走全局 userToken 闸门——花销是本机的隐私数据。
   priced=false 意味着"没配单价"，前端要显示"未配置单价"而不是 ¥0：
   后者会被读成"这次免费"，而真实含义是"我不知道价"。 */
app.get("/api/usage", (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), usageStore.KEEP_DAYS);
    const s = usageStore.summary(days);
    res.json({
      ok: true, days: s.days, models: s.models, total: s.total, priced: s.priced,
      prompt: s.prompt, completion: s.completion, today: usageStore.today(),
      currency: (cfg.pricing && cfg.pricing.currency) || "CNY",
      rates: (cfg.pricing && cfg.pricing.rates) || [],
      path: usageStore.filePath(),
    });
  } catch (e) { res.json({ ok: false, error: String(e && e.message || e) }); }
});
app.get("/api/health", (req, res) => res.json({ ok: true, name: "pancode", version: VERSION, apiStamp: API_STAMP, workspace: WS_DIR, wsClients: clients.size, engine: configMod.publicInfo(cfg) }));
app.get("/api/version", (req, res) => res.json({
  ok: true, name: "pancode", version: VERSION,
  features: ["repo_map", "search_symbol", "chat_history", "resizable_preview", "permissions", "attachments", "persona", "rules", "auto_memory"],
}));

/* P2 可观测：Agent 内部 trace / 真实 token 用量调试端点（开发排查用，随全局鉴权生效） */
app.get("/api/agent/trace", (req, res) => {
  if (typeof engine.getTrace === "function") return res.json({ ok: true, trace: engine.getTrace() });
  res.json({ ok: false, error: "当前引擎不支持 trace（演示引擎）" });
});
app.get("/api/agent/usage", (req, res) => {
  if (typeof engine.getTrace === "function") return res.json({ ok: true, usage: engine.getTrace().usage });
  res.json({ ok: false, error: "当前引擎不支持 usage（演示引擎）" });
});
/* P2 可观测：读取某会话落盘的 trace 历史（跨会话回看，路径已净化） */
app.get("/api/agent/trace/history", (req, res) => {
  const id = req.query && req.query.conv;
  const safe = id ? String(id).replace(/[^a-zA-Z0-9_-]/g, "_") : "";
  if (!safe) return res.json({ ok: true, events: [] });
  const fp = path.join(configMod.ROOT, ".pancode", "agent-traces", safe + ".jsonl");
  if (!fs.existsSync(fp)) return res.json({ ok: true, events: [] });
  try {
    const lines = fs.readFileSync(fp, "utf8").split("\n");
    const events = [];
    for (let i = lines.length - 1; i >= 0 && events.length < 500; i--) {
      const l = lines[i].trim(); if (!l) continue;
      try { events.push(JSON.parse(l)); } catch (e) {}
    }
    events.reverse();
    res.json({ ok: true, events });
  } catch (e) { res.json({ ok: false, error: String(e) }); }
});

/* 仅本机可领取访问令牌（绑定 127.0.0.1 后局域网不可达） */
app.get("/api/bootstrap", (req, res) => {
  const ip = req.socket.remoteAddress || "";
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip)) return res.status(403).json({ ok: false, error: "仅本机可领取令牌" });
  res.json({ token: AUTH_TOKEN });
});

/* ---------- 用户认证 API ---------- */
app.get("/api/auth/status", (req, res) => {
  const user = auth.verify(tokenOf(req));
  res.json({ ok: true, loggedIn: !!user, username: user ? user.username : null, hasUsers: auth.hasUsers() });
});
/* W25 个人模式：本机自动身份。个人本机产品不该有登录门槛，但 token 闸门要留着 ——
   这里按"谁够得着 TCP 回环就发给谁"静默发身份（与 /api/bootstrap 同口径，只认
   remoteAddress，任何伪造头都无效；服务本身也只绑 127.0.0.1）。
   账号无论几个都取最近创建的一个签发 —— 信任模型与 bootstrap 同档，回环内没有
   "被冒充"的对象（W28 终审修正：曾对多账号拒绝，把存量用户锁回登录框）。 */
app.get("/api/auth/auto", async (req, res) => {
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(String((req.socket && req.socket.remoteAddress) || ""))) {
    return res.status(403).json({ ok: false, error: "仅本机可领取自动身份" });
  }
  try { res.json(await auth.autoIdentity()); }
  catch (e) { res.json({ ok: false, error: "自动身份失败：" + e.message }); }
});
app.post("/api/auth/register", async (req, res) => {
  /* 首个账号才能自助注册，之后必须显式开窗（修 C-B1）。
     原先这里只有重名检查，于是 /api/auth/register 是个无鉴权入口：
     任何能连到本机端口的主体都能注册拿到 token，再改配置开 auto 模式，
     最后经 WS 触发命令执行 —— 一条完整的越权链。

     判断刻意写死成"只认真开"：这个值来自 JSON 配置文件，手改时把 false 写成
     字符串 "false" 或 "0" 很常见，而 JS 里 "0"/"false" 都是真值 ——
     用 !cfg.allowUserSignup 这种朴素判断等于给越权留了个后门。
     只有布尔 true，或字符串 "1"/"true" 才算开窗。 */
  const signupOpen = cfg.allowUserSignup === true
    || cfg.allowUserSignup === "1"
    || cfg.allowUserSignup === "true";
  if (auth.hasUsers() && !signupOpen) {
    return res.status(403).json({
      ok: false,
      error: "已存在用户，默认不再开放自助注册。确实要新增账号时，"
        + "用环境变量 PANCODE_ALLOW_SIGNUP=1 启动一次完成注册，然后关掉。",
      code: "REGISTRATION_CLOSED",
    });
  }
  const { username, password } = req.body || {};
  try { res.json(await auth.register(String(username || "").trim(), String(password || ""))); }
  catch (e) { res.json({ ok: false, error: "注册失败：" + e.message }); }
});
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  try { res.json(await auth.login(String(username || "").trim(), String(password || ""))); }
  catch (e) { res.json({ ok: false, error: "登录失败：" + e.message }); }
});
app.post("/api/auth/logout", (req, res) => {
  auth.logout(tokenOf(req));
  res.json({ ok: true });
});

/* ---------- Skills 生态 API ---------- */
app.get("/api/skills/market", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.json({ ok: true, skills: [], builtin: [], categories: {} });
    const skills = engine.skills.list({ limit: 50, category: req.query.category, search: req.query.q, sort: req.query.sort });
    res.json({ ok: true, skills, stats: engine.skills.stats, categories: engine.skills.categories, builtin: engine.skills.builtinWorkflows });
  } catch (e) { res.json({ ok: true, skills: [], builtin: [], categories: {} }); }
});
app.get("/api/skills/all", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.json({ ok: true, skills: [], stats: { total: 0, market: 0, local: 0, builtin: 0 }, builtin: [], categories: {} });
    const skills = engine.skills.list({ limit: 100, sort: req.query.sort });
    res.json({ ok: true, skills, stats: engine.skills.stats, builtin: engine.skills.builtinWorkflows, categories: engine.skills.categories });
  } catch (e) { res.json({ ok: true, skills: [], builtin: [], categories: {} }); }
});
app.post("/api/skills/market", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const body = req.body || {};
    const skill = engine.skills.add(body, "manual", { force: !!body.force, scope: body.scope === "user" ? "user" : "" });
    if (!skill) return res.status(400).json({ ok: false, error: "名称不能为空" });
    if (skill._duplicate) return res.status(409).json({ ok: false, error: "同名 Skill 已存在: " + skill.name });
    if (skill._auditRejected) return res.status(403).json({ ok: false, error: "安全审计发现 P0 风险，已拒绝导入（需显式确认）", audit: skill._auditRejected });
    res.json({ ok: true, skill, audit: skill._audit || null });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put("/api/skills/market/:id", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const id = req.params.id;
    let skill = engine.skills.update(id, req.body || {});
    /* 内置项改不动（随安装包走），但也不该回"Skill 不存在"把人堵在那儿——
       另存一份我的副本，改的就是这份副本。forked 给前端把提示说清楚。 */
    const forked = !skill && engine.skills.isBuiltin(id);
    if (forked) skill = engine.skills.forkBuiltin(id, req.body || {});
    if (skill && skill._auditRejected) {
      return res.status(403).json({ ok: false, error: "安全审计发现 P0 风险，已拒绝保存（需显式确认）", audit: skill._auditRejected });
    }
    if (!skill) return res.status(404).json({ ok: false, error: "Skill 不存在" });
    res.json({ ok: true, skill, forked });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete("/api/skills/market/:id", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const ok = engine.skills.remove(req.params.id);
    res.json({ ok });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/skills/market/:id/use", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.json({ ok: true });
    engine.skills.recordUse(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/skills/market/:id/rate", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    /* 以前这里调的是根本不存在的 engine.skills.rate()，抛 TypeError 被 catch 吞成 400
       ——前端每次评分都得到一句干巴巴的 "engine.skills.rate is not a function"。 */
    const raw = (req.body || {}).rating;
    const v = Number(raw);
    if (raw == null || raw === "" || !Number.isFinite(v) || v < 0 || v > 5) {
      return res.status(400).json({ ok: false, error: "评分必须是 0–5 的数字（0 = 取消评分）" });
    }
    /* 内置项没有可写落点：写进内存视图会假装成功、重启即失，所以像 toggle 一样显式挡掉并说明出路。 */
    if (engine.skills.isBuiltin(req.params.id)) {
      return res.json({ ok: false, needFork: true, error: "内置技能随安装包分发，评分不会保存；请先另存为我的技能" });
    }
    const skill = engine.skills.rate(req.params.id, v);
    if (!skill) return res.status(404).json({ ok: false, error: "Skill 不存在" });
    res.json({ ok: true, skill });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get("/api/skills/search/:query", (req, res) => {
  try {
    if (!engine || !engine.skills) return res.json({ ok: true, skills: [] });
    const matched = engine.skills.match(req.params.query, 10);
    res.json({ ok: true, skills: matched });
  } catch (e) { res.json({ ok: true, skills: [] }); }
});

/* ---------- 任务计划 API ---------- */
app.get("/api/plans", (req, res) => {
  try {
    if (!engine || !engine.plan) return res.json({ ok: true, active: null, recent: [] });
    const cid = req.query.convId || "default";
    const active = engine.plan.getActive(cid);
    const recent = engine.plan.recent(cid, 5);
    res.json({ ok: true, active, recent });
  } catch (e) { res.json({ ok: true, active: null, recent: [] }); }
});
app.post("/api/plans", (req, res) => {
  try {
    if (!engine || !engine.plan) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const plan = engine.plan.create(req.body.convId || (engine._currentConv) || "default", req.body.title, req.body.tasks);
    // 按请求者的 userKey 收窄：不带 key 的 broadcast 会发给所有连接（别人的计划会串进你的窗口）
    broadcast({ type: "plan.created", plan, convId: plan.convId }, tokenUserKey(tokenOf(req)));
    res.json({ ok: true, plan });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/plans/:id/complete", (req, res) => {
  try {
    if (!engine || !engine.plan) return res.status(503).json({ ok: false, error: "引擎未就绪" });
    const plan = engine.plan.complete(req.params.id);
    if (!plan) return res.status(404).json({ ok: false, error: "计划不存在" });
    broadcast({ type: "plan.updated", plan, convId: plan.convId }, tokenUserKey(tokenOf(req)));
    res.json({ ok: true, plan });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- 工作流模板 API（供前端工作流面板展示真实模板，含用户自定义） ---------- */
app.get("/api/templates", (req, res) => {
  try {
    /* 取工作区级那份 store，不要绕引擎拿：`this.workflows` 只在 LlmAgent 构造函数里挂，
       演示引擎（没配 API Key 的第一次启动——桌面端最典型的初始态）下它是 undefined，
       于是这里回空数组，前端工作流面板会静默退化成快捷提示词列表，内置模板一个都不见。 */
    const wf = _engineAssets.workflow || (engine && engine.workflows);
    if (!wf) return res.json({ ok: true, templates: [] });
    const templates = wf.list().map((t) => ({
      name: t.name,
      description: t.description || "",
      title: t.title || "",
      steps: Array.isArray(t.tasks) ? t.tasks.length : 0,
      tasks: Array.isArray(t.tasks) ? t.tasks : [],
      builtin: !!t.builtin,
    }));
    res.json({ ok: true, templates });
  } catch (e) { res.json({ ok: true, templates: [] }); }
});

/* ---------- 任务表（桌面端托盘/系统通知的唯一数据源） ---------- */
/* 不带 userKey：托盘在窗口关闭时也要能看见"有几个任务在跑"，那是本机自己的后端。
   需要按人过滤时走 hello.tasks（那里按连接的 userKey 过滤）。 */
app.get("/api/tasks", (req, res) => {
  try {
    res.json({ ok: true, tasks: taskBoard ? taskBoard.snapshot(null) : [], workspace: WS_DIR });
  } catch (e) { res.json({ ok: false, error: e.message, tasks: [] }); }
});

/* ---------- 全局授权根清单（阶段二：Agent 能进哪几扇门） ---------- */
/* 与 allow/deny 工具规则是两个轴：规则管"在目录里能干什么"，这份清单管"能不能进这个门"。
   全局一份、跨工作区共用，所以它在 <数据根>/.pancode/roots.json，不在工作区里。
   这些接口一律走登录闸门（app.use 的 NO_AUTH 白名单不含它们）——授权目录是敏感操作。 */
app.get("/api/roots", (req, res) => {
  try {
    res.json({
      ok: true,
      roots: rootGrants.list(),
      active: WS_DIR,
      activeId: wsKey.shardKey(WS_DIR, configMod.ROOT),   // 前端据此把"当前工作区"单独标出来
      dataRoot: configMod.ROOT,
    });
  } catch (e) { res.json({ ok: false, error: e.message, roots: [] }); }
});

app.post("/api/roots", async (req, res) => {
  try {
    const r = await rootGrants.add(req.body || {});
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    res.json({ ok: true, root: r.root, roots: rootGrants.list() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* 只读 ↔ 可写：用户想"让它能看别的项目，但别乱改"就是这一档 */
app.post("/api/roots/:id/writable", async (req, res) => {
  try {
    const r = await rootGrants.setWritable(req.params.id, !!(req.body && req.body.writable));
    if (r.error) return res.status(404).json({ ok: false, error: r.error });
    rootStore.invalidate(req.params.id);   // 顺带丢掉缓存实例；真正的拦截靠每次解析现查清单
    res.json({ ok: true, root: r.root, roots: rootGrants.list() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* 撤销授权只删这一行，目录与其中文件一概不碰（这条在 roots.test.js 里钉着） */
app.delete("/api/roots/:id", async (req, res) => {
  try {
    const r = await rootGrants.remove(req.params.id);
    if (r.error) return res.status(404).json({ ok: false, error: r.error });
    rootStore.invalidate(req.params.id);
    res.json({ ok: true, roots: rootGrants.list() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------- W6 产物清单（历史会话回看：切换会话时前端拉取渲染） ---------- */
app.get("/api/artifacts", (req, res) => {
  try {
    const artifacts = require("./artifacts");
    res.json(artifacts.loadArtifacts(configMod.ROOT, req.query.convId || "default"));
  } catch (e) { res.json({ convId: req.query.convId || "default", ts: 0, list: [] }); }
});

/* ---------- Git 状态预览 + 一键提交（一站式交付闭环） ---------- */
app.get("/api/git/status", async (req, res) => {
  try {
    if (!git) return res.json({ ok: true, available: false, branch: "", changes: [] });
    let remote = "";
    try { remote = (await git.remotes())[0] || ""; } catch (e) {}
    res.json({ ok: true, available: git.available, branch: git.branch, remote, sub: git.info().sub, changes: await git.changes() });
  } catch (e) { res.json({ ok: true, available: false, changes: [] }); }
});
app.post("/api/git/push", async (req, res) => {
  try {
    if (!git) return res.status(503).json({ ok: false, error: "Git 未就绪" });
    const r = await git.push();
    res.json(r);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/git/commit", async (req, res) => {
  try {
    if (!git) return res.status(503).json({ ok: false, error: "Git 未就绪" });
    const body = req.body || {};
    const files = Array.isArray(body.files) ? body.files : undefined; // undefined → 全量提交（向后兼容）
    const r = await git.commit((body.message) || "", files);
    res.json(Object.assign({ ok: r.ok }, r.ok ? r : { error: r.error, nothing: r.nothing }));
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- P-M1 worktree 隔离副本 ----------
   这三个端点会建目录 / 删目录，所以受全局鉴权保护（/api/git/* 一律不在 NO_AUTH 白名单里）。
   形状与 Agent 侧的 git_worktree 完全同源（同一个 GitLayer 方法），
   不留"面板一套逻辑、工具另一套逻辑"的缝。 */
app.get("/api/git/worktrees", async (req, res) => {
  try {
    if (!git || !git.available) return res.json({ ok: false, available: false, worktrees: [], error: "当前工作区不是 Git 仓库" });
    const r = await git.worktrees();
    res.json(Object.assign({ available: true }, r));
  } catch (e) { res.json({ ok: false, error: e.message, worktrees: [] }); }
});
app.post("/api/git/worktree", async (req, res) => {
  try {
    if (!git || !git.available) return res.json({ ok: false, error: "当前工作区不是 Git 仓库" });
    const b = req.body || {};
    const r = await git.addWorktree(b.name, { base: b.base });
    if (r.ok) writeAudit("git", "worktree add " + r.path + " 分支 " + r.branch);
    res.json(r);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete("/api/git/worktree", async (req, res) => {
  try {
    if (!git || !git.available) return res.json({ ok: false, error: "当前工作区不是 Git 仓库" });
    const b = req.body || {};
    const r = await git.removeWorktree(b.name || b.path, b.force === true);
    if (r.ok) writeAudit("git", "worktree remove " + r.removed + (r.forced ? "（含未提交改动，强删）" : ""));
    res.json(r);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* 智能变更摘要（P9 / P10）：GET 全量，POST {files} 仅统计选中子集
   返回 summary(changelog/总览/建议) 与 docDraft(文档片段)，均为草稿，由前端决定是否采用 */
function buildSummaryPayload(subset) {
  return { ok: true, available: git.available, branch: git.branch, summary: summarize(subset), docDraft: docDraft(subset) };
}
app.get("/api/git/summary", async (req, res) => {
  try {
    if (!git) return res.json({ ok: true, available: false, summary: null, docDraft: "" });
    res.json(buildSummaryPayload(await git.changes()));
  } catch (e) { res.json({ ok: true, available: false, summary: null, docDraft: "" }); }
});
app.post("/api/git/summary", async (req, res) => {
  try {
    if (!git) return res.json({ ok: true, available: false, summary: null, docDraft: "" });
    const all = await git.changes();
    const body = req.body || {};
    let subset = all;
    if (Array.isArray(body.files) && body.files.length) {
      const set = new Set(body.files);
      subset = all.filter((c) => set.has(c.path));
    }
    res.json(buildSummaryPayload(subset));
  } catch (e) { res.json({ ok: true, available: false, summary: null, docDraft: "" }); }
});

/* ---------- 后台进程管理（Agent 启动的长驻进程：dev server / watcher 等） ---------- */
app.get("/api/processes", (req, res) => {
  try {
    if (!procs) return res.json({ ok: true, processes: [] });
    res.json({ ok: true, processes: procs.list() });
  } catch (e) { res.json({ ok: false, error: String(e) }); }
});
app.get("/api/processes/log", (req, res) => {
  try {
    if (!procs) return res.json({ ok: false, error: "进程层未就绪" });
    const name = String((req.query && req.query.name) || "").trim();
    const lines = Math.min(Math.max(Number(req.query && req.query.lines) || 100, 1), 800);
    if (!name) return res.status(400).json({ ok: false, error: "缺少 name 参数" });
    res.json(procs.read(name, lines));
  } catch (e) { res.status(400).json({ ok: false, error: String(e) }); }
});
app.post("/api/processes/stop", (req, res) => {
  try {
    if (!procs) return res.json({ ok: false, error: "进程层未就绪" });
    const name = String((req.body || {}).name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "缺少 name" });
    res.json(procs.stop(name));
  } catch (e) { res.status(400).json({ ok: false, error: String(e) }); }
});

/* ---------- 工作区管理：打开任意本地文件夹 ---------- */
app.get("/api/workspace", (req, res) => {
  res.json({ current: WS_DIR, recent: (cfg.recentWorkspaces || []).filter((p) => fs.existsSync(p)) });
});

app.post("/api/workspace", (req, res) => {
  try {
    const dir = String((req.body || {}).dir || "").trim();
    if (!dir) return res.status(400).json({ ok: false, error: "路径不能为空" });
    // 多用户：任一用户引擎运行中都禁止切工作区（其闭包指向旧 files/git/term）
    if (engine && engine.running) return res.status(409).json({ ok: false, error: "AI 任务运行中，请先等待完成" });
    for (const eng of userEngines.values()) { if (eng.running) return res.status(409).json({ ok: false, error: "AI 任务运行中，请先等待完成" }); }
    /* 高危目录要人点头才给可写权（修 C-H4）。
       mountWorkspace 里的 rootGrants.ensure(abs) 会把这个目录按 writable:true 登记进授权清单，
       于是"POST 一个任意路径"就等于"AI 拿到了这棵树以及它下面全部内容的写权限"，全程无确认。
       这里只在**这个目录还没被授权过**时拦一次：已经在清单里的（用户此前明确授过权的）
       不再重复问，否则每切一次工作区都要点一次确认。
       confirmWrites 缺省为 true——选择不确认必须由前端显式说明，不靠"字段没传"来推断。 */
    const body = req.body || {};
    const alreadyGranted = rootGrants.get(wsKey.shardKey(path.resolve(dir), configMod.ROOT));
    if (!alreadyGranted && rootGrants.isSensitiveRoot(dir)) {
      if (body.confirmWrites !== true) {
        return res.status(409).json({
          ok: false, needConfirm: true, code: "SENSITIVE_ROOT",
          error: "「" + path.resolve(dir) + "」是系统或用户数据目录。把 AI 的写权限交到这个层级，"
            + "它下面的每一份文件都可改（回收站只兜得住删除，兜不住就地覆盖）。确认要打开它，请重新提交并带 confirmWrites=true。",
        });
      }
      writeAudit("workspace", "确认授权敏感目录 " + path.resolve(dir));
    }
    if (term) term.closeAll();
    mountWorkspace(dir);
    configMod.saveWorkspace(cfg, WS_DIR);
    helloPayload().then((h) => broadcast(h));   // 所有已连接窗口立即切换到新工作区
    res.json({ ok: true, workspace: WS_DIR, project: path.basename(WS_DIR) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- 二进制文件预览（对齐 VS Code 图片预览 + Office Viewer 扩展体验） ---------- */
const IMG_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", webp: "image/webp", ico: "image/x-icon", svg: "image/svg+xml",
};
const PREVIEW_MAX = 20 * 1024 * 1024; // 预览上限 20MB

function extOf(p) { return String(p).split(".").pop().toLowerCase(); }

/* 原始文件流：图片 <img> / PDF <iframe> 直接引用 */
app.get("/api/raw", (req, res) => {
  try {
    const rel = String(req.query.path || "");
    const abs = files.safePath(rel);
    if (!abs.startsWith(WS_DIR)) return res.status(403).send("拒绝访问该路径");
    const st = fs.statSync(abs);
    if (st.size > PREVIEW_MAX) return res.status(413).send("文件过大");
    const ext = extOf(rel);
    const mime = IMG_MIME[ext] || (ext === "pdf" ? "application/pdf" : "application/octet-stream");
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(abs).pipe(res);
  } catch (e) { res.status(404).send("文件不存在: " + e.message); }
});

/* 会话截图：只服务数据根 .pancode/shots 这一个目录。
   与 /api/raw 分开是因为边界不一样 —— raw 限定在工作区内，而截图刻意不落工作区
   （落进去就会被 Git 基线当成用户改动、被撤销栈纳入检查点）。
   只接受 shots 目录内的相对路径，逐段校验，任何 .. 或绝对路径一律 404。 */
app.get("/api/shot", (req, res) => {
  try {
    const shots = require("./computer/shots");
    const abs = shots.resolveRel(String(req.query.name || ""));
    if (!abs) return res.status(404).send("截图不存在或路径不在截图目录内");
    const st = fs.statSync(abs);
    if (st.size > PREVIEW_MAX) return res.status(413).send("文件过大");
    res.setHeader("Content-Type", extOf(abs) === "png" ? "image/png" : "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(abs).pipe(res);
  } catch (e) { res.status(404).send("截图读取失败: " + e.message); }
});

/* docx → HTML 预览（mammoth，与 VS Code Office Viewer 同类方案）。
   mammoth 对超链接 href 原样透传、不做 scheme 过滤 —— 恶意 docx 里塞一条
   javascript: 链接，前端 innerHTML 渲染后点一下就在应用源内执行（可携
   userToken 调 API，等于接管 Agent）。渲染前在服务端把非 http(s)/mailto/
   相对路径的 href 摘掉。 */
function sanitizePreviewHtml(html) {
  return String(html).replace(/href\s*=\s*(["'])([\s\S]*?)\1/gi, (m, q, url) => {
    const u = String(url).trim();
    const safe = /^(https?:|mailto:)/i.test(u) || !/^[a-z][a-z0-9+.\-]*:/i.test(u);
    return safe ? m : "href=" + q + "#" + q;
  });
}
app.get("/api/preview/docx", async (req, res) => {
  try {
    const rel = String(req.query.path || "");
    const abs = files.safePath(rel);
    if (fs.statSync(abs).size > PREVIEW_MAX) return res.status(413).json({ ok: false, error: "文件过大，无法预览" });
    let mammoth;
    try { mammoth = require("mammoth"); }
    catch (e) { return res.status(501).json({ ok: false, error: "预览组件未安装（npm install mammoth）" }); }
    const result = await mammoth.convertToHtml({ path: abs }, { convertImage: mammoth.images.imgElement((img) =>
      img.read("base64").then((b64) => ({ src: "data:" + img.contentType + ";base64," + b64 })))
    });
    res.json({ ok: true, html: sanitizePreviewHtml(result.value), warnings: (result.messages || []).length });
  } catch (e) { res.status(400).json({ ok: false, error: "无法解析该文档: " + e.message }); }
});

/* 文件夹浏览器：给前端"打开文件夹"选择器用（只列目录，不读文件） */
app.get("/api/fs/browse", (req, res) => {
  try {
    const dir = String(req.query.dir || "").trim();
    if (!dir) {
      // 根级：Windows 列盘符，其他系统列 /
      if (process.platform === "win32") {
        const drives = [];
        for (let i = 65; i <= 90; i++) {
          const d = String.fromCharCode(i) + ":\\";
          try { fs.statSync(d); drives.push({ name: d, path: d }); } catch (e) {}
        }
        return res.json({ dir: "", parent: null, dirs: drives, home: require("os").homedir() });
      }
      return res.json({ dir: "/", parent: null, dirs: listSubdirs("/"), home: require("os").homedir() });
    }
    const abs = path.resolve(dir);
    const parent = path.dirname(abs);
    res.json({
      dir: abs,
      parent: parent === abs ? "" : parent,   // 盘符根再往上 → 回到盘符列表
      dirs: listSubdirs(abs),
      home: require("os").homedir(),
    });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

function listSubdirs(abs) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(abs); } catch (e) { return out; }
  for (const name of names) {
    if (name.startsWith("$") || name === "System Volume Information") continue;
    const full = path.join(abs, name);
    try { if (fs.statSync(full).isDirectory()) out.push({ name, path: full, hidden: name.startsWith(".") }); } catch (e) {}
    if (out.length >= 400) break;
  }
  out.sort((a, b) => (a.hidden - b.hidden) || a.name.localeCompare(b.name));
  return out;
}

/* 拉取模型列表的公共实现：规范化地址 → 请求 <base>/models → 归一化模型 ID。
   失败时把「到底请求了哪个地址、返回了什么」原样带回。以前只说「网关返回 HTTP 404」，
   用户不知道 404 出在自己刚填的地址上，以为还得额外架一个网关。 */
async function listModels(baseURL, apiKey) {
  const base = configMod.normalizeBaseURL(baseURL);
  if (!base) return { ok: false, models: [], error: "还没填接口地址" };
  let target;
  try { target = new URL(base + "/models"); } catch (e) { return { ok: false, models: [], error: "接口地址不是合法 URL（要带 http:// 或 https://）：" + base }; }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, models: [], error: "接口地址必须以 http:// 或 https:// 开头：" + base };
  }
  const tried = target.origin + target.pathname;   // 只回报到路径，绝不带上密钥
  const headers = { "Accept": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
  let r;
  try {
    r = await fetch(target, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    // fetch 失败时真正的错在 e.cause 上；e.name 只会给出没用的 "TypeError"
    const c = (e && e.cause) || {};
    const why = String(c.code || c.message || (e && e.message) || (e && e.name) || "未知错误");
    return { ok: false, models: [], attempted: tried, error: /timeout|abort/i.test(why)
      ? "连 " + tried + " 超时（20 秒）：地址不通或对方响应太慢"
      : "连不上 " + tried + "：" + why };
  }
  if (!r.ok) {
    const hint = r.status === 404 ? "——多半是地址少了 /v1 这类版本段，或多写了 /chat/completions"
      : (r.status === 401 || r.status === 403) ? "——密钥不对或没有权限" : "";
    return { ok: false, models: [], attempted: tried, error: tried + " 返回 HTTP " + r.status + hint };
  }
  const data = await r.json().catch(() => null);
  const raw = Array.isArray(data && data.data) ? data.data : (Array.isArray(data && data.models) ? data.models : (Array.isArray(data) ? data : []));
  const models = raw.map((m) => (typeof m === "string" ? m : (m && (m.id || m.name)))).filter(Boolean);
  if (!models.length) return { ok: false, models: [], attempted: tried, error: tried + " 返回 200 但列表是空的：这个服务可能不提供 /models，直接填模型 ID 就行" };
  return { ok: true, models: [...new Set(models)].sort(), attempted: tried };
}

/* 代理拉取模型列表：服务端请求外部 API，避免前端 CORS 被拦截。
   GET 只认服务端已保存的 baseURL/apiKey；POST 可带表单当前值（见下）。返回 { ok, models, attempted, error }。 */
app.get("/api/models", async (req, res) => {
  try { res.json(await listModels(cfg.llm.baseURL, cfg.llm.apiKey)); }
  catch (e) { res.json({ ok: false, error: e.message, models: [] }); }
});

/* 用「表单里正填着的」地址和密钥拉取：设置里刚填完就点「拉取模型」，不必先保存，
   也不受保存落盘时序影响。密钥只走请求体——绝不进 URL（URL 会留在访问日志与历史记录里），
   用完即弃：不写进配置、不落盘、不回显。 */
app.post("/api/models", async (req, res) => {
  const p = req.body || {};
  const baseURL = String(p.baseURL || "").trim() || cfg.llm.baseURL || "";
  const apiKey = String(p.apiKey || "").trim() || cfg.llm.apiKey || "";
  try { res.json(await listModels(baseURL, apiKey)); }
  catch (e) { res.json({ ok: false, error: e.message, models: [] }); }
});

/* ---------- 多份模型配置（profile）：接口地址 + 模型名存配置，密钥各自存本地 .env ---------- */
app.get("/api/llm/profiles", (req, res) => {
  try {
    res.json({
      ok: true,
      profiles: (cfg.llmProfiles || []).map(configMod.profilePublic),
      active: { baseURL: cfg.llm.baseURL, model: cfg.llm.model, hasKey: !!cfg.llm.apiKey,
        keyTail: cfg.llm.apiKey ? "…" + cfg.llm.apiKey.slice(-4) : "",
        contextWindow: cfg.llm.contextWindow, maxToolRounds: cfg.llm.maxToolRounds, maxOutputTokens: cfg.llm.maxOutputTokens },
    });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/llm/profiles", (req, res) => {
  try {
    const p = configMod.upsertLlmProfile(cfg, req.body || {});
    if (!p) return res.status(400).json({ ok: false, error: "配置需要名称与接口地址" });
    buildEngine();
    res.json({ ok: true, profile: p, profiles: (cfg.llmProfiles || []).map(configMod.profilePublic) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/llm/profiles/:id/apply", (req, res) => {
  try {
    const r = configMod.applyLlmProfile(cfg, req.params.id);
    if (!r) return res.status(404).json({ ok: false, error: "配置不存在" });
    buildEngine();
    broadcast({ type: "engine.info", engine: configMod.publicInfo(cfg) });
    res.json({ ok: true, ...r, engine: configMod.publicInfo(cfg) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete("/api/llm/profiles/:id", (req, res) => {
  try {
    configMod.removeLlmProfile(cfg, req.params.id);
    res.json({ ok: true, profiles: (cfg.llmProfiles || []).map(configMod.profilePublic) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get("/api/settings", (req, res) => res.json(configMod.publicInfo(cfg)));app.post("/api/settings", (req, res) => {
  try {
    configMod.saveLlm(cfg, req.body || {});
    buildEngine();
    const info = configMod.publicInfo(cfg);
    broadcast({ type: "engine.info", engine: info });
    res.json({ ok: true, engine: info });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post("/api/settings/test", async (req, res) => {
  const p = req.body || {};
  const testCfg = {
    baseURL: String(p.baseURL || "").trim() || cfg.llm.baseURL,
    apiKey: String(p.apiKey || "").trim() || cfg.llm.apiKey,
    model: String(p.model || "").trim() || cfg.llm.model,
    temperature: 0,
  };
  // 密钥不是必填：本地 Ollama / LM Studio 这类服务压根不校验。以前缺 Key 直接拒测，
  // 用户对着本机服务看到"不能为空"，只会更确信自己少配了个网关。
  if (!testCfg.baseURL) return res.json({ ok: false, error: "还没填接口地址（形如 https://…/v1 或 http://127.0.0.1:11434）" });
  if (!testCfg.model) return res.json({ ok: false, error: "还没填模型名：点「拉取模型」选一个，或直接输入模型 ID" });
  try {
    const r = await ping(testCfg);
    res.json({ ok: true, sample: r.sample });
  } catch (e) {
    // 把实际请求的地址带上（chatStream 挂在 err.endpoint 上）：设置面板里"不通"必须说清不通在哪
    res.json({ ok: false, error: String(e.message || e) + (e.endpoint ? "（请求 " + e.endpoint + "）" : "") });
  }
});

/* ---------- 内联代码补全（Tab completion）---------- */
app.post("/api/complete", async (req, res) => {
  try {
    const { prefix, suffix, language, filePath } = req.body || {};
    if (!prefix || prefix.length < 2) return res.json({ ok: true, text: "" });
    if (!cfg.llm || !cfg.llm.apiKey) return res.json({ ok: true, text: "" });
    const baseURL = String(cfg.llm.baseURL || "").replace(/\/+$/, "");
    const prompt =
      "You are a code completion engine. Complete the code at the cursor position.\n" +
      "Return ONLY the completion text (what should be inserted at cursor), no explanation, no markdown.\n" +
      "Keep it short (1-3 lines typically). Stop at a natural boundary.\n\n" +
      "File: " + String(filePath || "").slice(-60) + " (" + (language || "text") + ")\n\n" +
      "Code before cursor:\n```\n" + String(prefix).slice(-1500) + "\n```\n\n" +
      "Code after cursor:\n```\n" + String(suffix).slice(0, 500) + "\n```\n\n" +
      "Completion:";
    const r = await fetch(baseURL + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.llm.apiKey },
      body: JSON.stringify({
        model: cfg.llm.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 80,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.json({ ok: true, text: "" });
    const data = await r.json();
    let text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    text = text.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim();
    if (text.length > 200) text = text.slice(0, 200);
    res.json({ ok: true, text });
  } catch (e) { res.json({ ok: true, text: "" }); }
});

/* Cmd+K 内联编辑：选中代码 + 指令 → AI 返回修改后的代码 */
app.post("/api/edit", async (req, res) => {
  try {
    const { filePath, language, selectedText, instruction, beforeContext, afterContext } = req.body || {};
    if (!selectedText || !instruction) return res.json({ ok: false, error: "缺少选中文本或指令" });
    if (!cfg.llm || !cfg.llm.apiKey) return res.json({ ok: false, error: "未配置 LLM API Key" });
    const baseURL = String(cfg.llm.baseURL || "").replace(/\/+$/, "");
    const prompt =
      "You are a code editing assistant. The user has selected a piece of code and wants to modify it.\n" +
      "Return ONLY the modified code that should replace the selected text. No explanation, no markdown fences.\n" +
      "Preserve the original language and style. Keep changes minimal and focused on the instruction.\n\n" +
      "File: " + String(filePath || "").slice(-80) + " (" + (language || "text") + ")\n\n" +
      "Instruction: " + String(instruction).slice(0, 500) + "\n\n" +
      "Code before selection (for context):\n```\n" + String(beforeContext || "").slice(-800) + "\n```\n\n" +
      "Selected code to modify:\n```\n" + String(selectedText).slice(0, 4000) + "\n```\n\n" +
      "Code after selection (for context):\n```\n" + String(afterContext || "").slice(0, 800) + "\n```\n\n" +
      "Modified code (replace the selected code only):";
    const r = await fetch(baseURL + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.llm.apiKey },
      body: JSON.stringify({
        model: cfg.llm.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4000,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return res.json({ ok: false, error: "LLM 返回 " + r.status });
    const data = await r.json();
    let text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    text = text.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "").trim();
    res.json({ ok: true, text });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* Agent 框架设置（权限 / 人格 / 规则 / 上下文 / 记忆） */
app.get("/api/agent-settings", (req, res) => res.json(configMod.agentSettings(cfg)));
app.post("/api/agent-settings", (req, res) => {
  try {
    configMod.saveAgentSettings(cfg, req.body || {});
    broadcast({ type: "agent.settings", agent: configMod.agentSettings(cfg) });
    res.json({ ok: true, agent: configMod.agentSettings(cfg) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get("/api/embedding", (req, res) => res.json(configMod.embeddingInfo(cfg)));
app.post("/api/embedding", (req, res) => {
  try {
    configMod.saveEmbedding(cfg, req.body || {});
    res.json({ ok: true, embedding: configMod.embeddingInfo(cfg) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});


/* MCP 服务器管理（外部工具）：
   GET  → 当前所有 server 的连接状态 + 已发现工具
   POST {action:"save", servers:[...]} → 持久化配置并重新对账连接
   POST {action:"reconnect"}           → 仅重新对账（不改动配置） */
app.get("/api/mcp", (req, res) => res.json({ ok: true, servers: mcpManager.statusList(), configured: (cfg.mcp && Array.isArray(cfg.mcp.servers)) ? cfg.mcp.servers : [] }));
app.post("/api/mcp", (req, res) => {
  const body = req.body || {};
  const action = body.action || "save";
  try {
    if (action === "save") {
      configMod.saveMcpServers(cfg, { servers: Array.isArray(body.servers) ? body.servers : [] });
    }
    mcpManager.sync();
    res.json({ ok: true, servers: mcpManager.statusList() });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- T3：设置工作台聚合 API ----------
   一次 GET 拿到全部可配置面（模型 / Agent 行为 / 权限 / MCP / Embedding / 资产计数），
   避免前端为每一页各拉一次；写操作仍按段落分派到各自已有的持久化函数，不散布第二套写入口。 */
function configSnapshot() {
  const memCount = _engineAssets.memory ? _engineAssets.memory.size : 0;
  const ruleCount = collectRuleRecords([]).length;
  return {
    engine: configMod.publicInfo(cfg),
    llm: { baseURL: cfg.llm.baseURL, model: cfg.llm.model, maxToolRounds: cfg.llm.maxToolRounds, contextWindow: cfg.llm.contextWindow, maxOutputTokens: cfg.llm.maxOutputTokens, vision: cfg.llm.vision === true },
    agent: configMod.agentSettings(cfg),
    embedding: configMod.embeddingInfo(cfg),
    mcp: { configured: (cfg.mcp && Array.isArray(cfg.mcp.servers)) ? cfg.mcp.servers : [], running: mcpManager.statusList() },
    workspace: { dir: WS_DIR, recent: cfg.recentWorkspaces || [] },
    desktop: cfg.desktop || { closeAction: "ask" },   // 桌面端关窗行为（设置里那一行读写的就是它）
    /* 电脑控制的偏好 + "东西到底在不在"。后者跟着配置一起回，是因为这两项能力都依赖外部实物
       （随包的 agent-browser 二进制、常驻 PowerShell + UIA）：只回配置的话，界面会显示"已开启"
       而工具却说"没装"，用户在设置里看不出差别。 */
    computer: cfg.computer || {},
    computerStatus: (() => {
      try {
        const abS = require("./computer/agent-browser").status(cfg);
        return {
          browser: { available: abS.available, exe: abS.exe, browser: abS.browser, reason: abS.reason },
          desktop: { supported: require("./computer/uia-worker").supported() },
        };
      } catch (e) { return { error: String(e && e.message || e) }; }
    })(),
    assets: { memory: memCount, rules: ruleCount, skills: engine && engine.skills ? engine.skills.stats : null, experts: expertRecords().length },
    paths: { root: configMod.ROOT, configFile: configMod.CONFIG_PATH, rulesWorkspace: ".pancode/rules（工作区内，Agent 实际读取处）", rulesApp: configMod.rulesDir() },
    version: VERSION,
    features: ["repo_map", "search_symbol", "permissions", "persona", "rules", "auto_memory", "skills", "experts", "sediment", "orchestration", "risk_scan", "mcp", "automation", "progression", "browser", "computer"],
  };
}
app.get("/api/config", (req, res) => {
  try { res.json(Object.assign({ ok: true }, configSnapshot())); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/config", (req, res) => {
  try {
    const { section, patch } = req.body || {};
    const p = patch || {};
    let out = {};
    if (section === "llm") { configMod.saveLlm(cfg, p); buildEngine(); out = { engine: configMod.publicInfo(cfg) }; broadcast({ type: "engine.info", engine: out.engine }); }
    else if (section === "agent") { configMod.saveAgentSettings(cfg, p);
      /* 用户亲手改权限档 / Agent 模式，是整局里最该留痕的决定之一：
         它解释了之后所有门的松紧（"那阵子为什么什么都直接放行"）。 */
      if (p && (p.agentMode !== undefined || p.permissions !== undefined)) {
        require("./decision-log").recordDecision({
          convId: "settings", kind: "mode", action: "switched",
          reason: "用户在设置里改了 Agent 模式 / 权限档",
          mode: ((cfg.permissions || {}).mode || ""),
          detail: { agentMode: cfg.agentMode, permissionsMode: (cfg.permissions || {}).mode },
        });
      }
      /* 改了单价就按 token 数把历史账整表重算：账本里存的是**当时**算出的金额，
         不重算的话用户填完价格面板纹丝不动，看起来像"设置没生效"。 */
      if (p && p.pricing) { try { usageStore.reprice(cfg.pricing.rates, cfg.pricing.currency); } catch (e) { log.tag("usage").warn("按新单价重算历史账失败: " + e.message); } }
      out = { agent: configMod.agentSettings(cfg) }; broadcast({ type: "agent.settings", agent: out.agent }); }
    else if (section === "embedding") { configMod.saveEmbedding(cfg, p); out = { embedding: configMod.embeddingInfo(cfg) }; }
    else if (section === "desktop") { configMod.saveDesktop(cfg, p); out = { desktop: cfg.desktop }; }
    /* 电脑控制：存完顺手把"能不能用"回给前端。
       这两项都依赖外部实物（随包的 agent-browser 二进制、常驻 PowerShell + UIA），
       只存不验就会变成"开关明明开了、工具却说没装"，而用户没有任何地方能看出来。 */
    else if (section === "computer") {
      configMod.saveComputer(cfg, p);
      const abS = require("./computer/agent-browser").status(cfg);
      out = {
        computer: cfg.computer,
        computerStatus: {
          browser: { available: abS.available, exe: abS.exe, browser: abS.browser, reason: abS.reason },
          desktop: { supported: require("./computer/uia-worker").supported() },
        },
      };
    }
    else if (section === "mcp") {
      if (!Array.isArray(p.servers)) return res.json({ ok: false, error: "servers 必须是数组" });
      configMod.saveMcpServers(cfg, { servers: p.servers });
      mcpManager.sync();
      out = { mcp: { configured: cfg.mcp.servers, running: mcpManager.statusList() } };
    }
    else return res.json({ ok: false, error: "未知设置分组：" + section });
    res.json(Object.assign({ ok: true, section }, out));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 导出 / 导入：密钥永不进出（导出里没有，导入时即使带了也拒绝），只搬可共享的行为配置 */
app.get("/api/config/export", (req, res) => {
  try {
    const dump = {
      _kind: "pancode-config", _version: VERSION, _exportedAt: new Date().toISOString(),
      llm: { baseURL: cfg.llm.baseURL, model: cfg.llm.model, maxToolRounds: cfg.llm.maxToolRounds, contextWindow: cfg.llm.contextWindow, maxOutputTokens: cfg.llm.maxOutputTokens, vision: cfg.llm.vision === true },
      agent: configMod.agentSettings(cfg),
      embedding: { endpoint: cfg.embedding.endpoint, model: cfg.embedding.model, dim: cfg.embedding.dim },
      mcp: { servers: (cfg.mcp && cfg.mcp.servers) || [] },
    };
    res.json({ ok: true, filename: "pancode-config-" + new Date().toISOString().slice(0, 10) + ".json", json: JSON.stringify(dump, null, 2), note: "导出内容不含任何 API Key" });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/config/import", (req, res) => {
  try {
    let d = req.body && req.body.json;
    if (typeof d === "string") { try { d = JSON.parse(d); } catch (e) { return res.json({ ok: false, error: "不是合法 JSON" }); } }
    if (!d || typeof d !== "object") return res.json({ ok: false, error: "缺少配置内容" });
    if (d._kind && d._kind !== "pancode-config") return res.json({ ok: false, error: "这不是 pancode 的配置文件（_kind=" + d._kind + "）" });
    const applied = [], skipped = [];
    const dropped = (o) => { const c = Object.assign({}, o); delete c.apiKey; delete c.apikey; delete c.key; return c; };
    if (d.llm && typeof d.llm === "object") {
      if (d.llm.apiKey) skipped.push("llm.apiKey（密钥不通过导入写入，请在模型设置里手动填）");
      configMod.saveLlm(cfg, dropped(d.llm)); applied.push("llm");
    }
    if (d.agent && typeof d.agent === "object") { configMod.saveAgentSettings(cfg, d.agent); applied.push("agent"); }
    if (d.embedding && typeof d.embedding === "object") {
      if (d.embedding.apiKey) skipped.push("embedding.apiKey（同上，需手动填）");
      configMod.saveEmbedding(cfg, dropped(d.embedding)); applied.push("embedding");
    }
    if (d.mcp && Array.isArray(d.mcp.servers)) { configMod.saveMcpServers(cfg, { servers: d.mcp.servers }); mcpManager.sync(); applied.push("mcp"); }
    buildEngine();
    res.json({ ok: true, applied, skipped, snapshot: configSnapshot() });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ---------- Phase 2：长期记忆 API（T4：可视化管理所需的全量读过滤 + 治理动作） ---------- */
const MEM_TYPES = ["preference", "lesson", "pattern", "decision", "error", "skill"];

function memScopeStore(scope) {
  return scope === "user" ? _engineAssets.userMemory : _engineAssets.memory;
}
/* 面板问"这条会不会进上下文"，只能问存储层，不能自己按强度再猜一遍：
   P6 起常驻的正文只剩硬提醒那几条，其余全部只在索引里占一行。
   自己猜的口径迟早会和真注入的口径分叉，而分叉的表现就是面板说"会注入"、模型却没看到。 */
function memCtxSets(store) {
  const sets = { guard: new Set(), index: new Set() };
  try { (store.guardForContext ? store.guardForContext(999) : []).forEach((e) => sets.guard.add(e.id)); } catch (err) {}
  try { (store.indexForContext ? store.indexForContext(999) : []).forEach((e) => sets.index.add(e.id)); } catch (err) {}
  return sets;
}
/* 把内部衰减权重翻成面板看得懂的话：强度档 / 距归档天数 / 是否快被遗忘 */
function enrichMem(e, sets) {
  sets = sets || { guard: new Set(), index: new Set() };
  let w = 0;
  try { w = MemoryStore.strength(e); } catch (err) { w = 0; }
  const anchor = e.lastAccessAt || e.ts || 0;
  const ageDays = Math.floor((Date.now() - anchor) / 86400000);
  let ttl = 90;
  try { ttl = MemoryStore.ttlOf(e.type); } catch (err) {}
  const sticky = !!e.sticky;
  const resident = sets.guard.has(e.id);
  return Object.assign({}, e, {
    strength: Math.round(w * 10) / 10,
    tier: w >= 4 ? "high" : w >= 1 ? "mid" : "low",
    ageDays,
    ttlDays: ttl,
    sticky,
    /* lane 三档，跟提示词装配一一对应：
       guard = 正文常驻（被否过的做法与禁忌）；index = 只有目录行，正文要模型自己查；
       none  = 强度不达标或索引预算没排到，只有 search_memory 按关键词才找得到。 */
    lane: resident ? "guard" : sets.index.has(e.id) ? "index" : "none",
    injected: resident,
    risk: !sticky && w < 2.5 ? (w < 0.5 ? "drop" : "archive") : "keep",
  });
}
app.get("/api/memory", (req, res) => {
  try {
    const q = String(req.query.q || "");
    const opts = {
      type: req.query.type || null,
      source: req.query.source || null,
      limit: Math.min(500, Number(req.query.limit) || 200),
    };
    const arch = String(req.query.archived || "visible");
    const wantArch = arch === "all" ? "all" : arch === "only" ? true : false;
    const scope = req.query.scope === "user" ? "user" : "project";
    const store = memScopeStore(scope);
    if (!store) return res.json({ ok: false, error: "记忆库未就绪" });
    const keep = (e) => wantArch === "all" || !!e.archived === !!wantArch;
    const sets = memCtxSets(store);
    let raw;
    if (q && wantArch !== true) {
      // hitsOnly：不传的话 search() 会把"零命中"的条目按衰减强度补位返回，搜索结果里混进无关记忆
      // noTouch：用户在面板里搜一次不是"这条记忆被用上了"，加分会让搜一次就长生
      raw = store.search(q, { type: opts.type, limit: 500, hitsOnly: true, noTouch: true }).filter(keep).slice(0, opts.limit);
    } else {
      // 归档视图 / 空检索：走 list 再按关键词粗筛（search 对归档条目已隐身）
      const kw = q.toLowerCase();
      raw = store.list(Object.assign({}, opts, { archived: wantArch, limit: 500 }))
        .filter((e) => !kw || (e.topic + " " + e.content).toLowerCase().includes(kw))
        .slice(0, opts.limit);
    }
    const entries = raw.map((e) => enrichMem(e, sets));
    const all = store.list({ archived: "all", limit: 500 }).map((e) => enrichMem(e, sets));
    const byType = {};
    for (const t of MEM_TYPES) byType[t] = all.filter((e) => e.type === t).length;
    res.json({
      ok: true, entries, query: q, scope,
      total: store.size,
      stats: {
        total: all.length,
        byType,
        archived: all.filter((e) => e.archived).length,
        sticky: all.filter((e) => e.sticky).length,
        injected: all.filter((e) => e.lane === "guard").length,
        indexed: all.filter((e) => e.lane === "index").length,
        atRisk: all.filter((e) => e.risk !== "keep").length,
        avgStrength: Math.round((all.reduce((n, e) => n + e.strength, 0) / (all.length || 1)) * 10) / 10,
      },
      types: MEM_TYPES,
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 最近一轮真正注入进上下文的是哪几条（"存了几百条但没人知道用没用上"的解药） */
/* 最近一轮真正读进上下文的记忆（"存了几百条但没人知道用没用上"的解药）。
   P6 起台账有两类：guard=常驻提醒（正文每轮在场）、pull=模型自己调 search_memory 取的。 */
app.get("/api/memory/used", (req, res) => {
  try {
    const used = (engine && engine._usedMemory) || [];
    res.json({
      ok: true,
      entries: used.map((e) => ({
        id: e.id, type: e.type, topic: e.topic, content: e.content,
        scope: e.scope || "project", via: e.via || "guard",
      })),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/memory", (req, res) => {
  try {
    const { type, topic, content, scope, valueScore, sticky } = req.body || {};
    if (!content) return res.status(400).json({ ok: false, error: "内容不能为空" });
    const store = memScopeStore(scope);
    if (!store) return res.status(400).json({ ok: false, error: "记忆库不可用" });
    const meta = { source: "manual" };
    if (valueScore != null) meta.valueScore = Math.max(1, Math.min(5, Number(valueScore) || 2));
    if (sticky) meta.sticky = true;
    const entry = store.add(MEM_TYPES.includes(type) ? type : "lesson", topic || "", content, meta);
    if (!entry) return res.status(400).json({ ok: false, error: "内容不能为空" });
    res.json({ ok: true, entry: enrichMem(entry, memCtxSets(store)) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
/* 治理：主动裁剪（低强度归档/删除）与清除归档 */
app.post("/api/memory/prune", (req, res) => {
  try {
    const store = memScopeStore(req.body && req.body.scope);
    const r = store.prune();
    res.json({ ok: true, ...r, total: store.size });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/memory/purge", (req, res) => {
  try {
    const store = memScopeStore(req.body && req.body.scope);
    const removed = store.purgeArchived();
    res.json({ ok: true, removed, total: store.size });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 归档 / 恢复：归档 = 不注入不检索但不删（可逆） */
app.post("/api/memory/:id/archive", (req, res) => {
  try {
    const store = memScopeStore(req.body && req.body.scope);
    const archived = req.body ? req.body.archived !== false : true;
    const entry = store.update(req.params.id, { archived });
    if (!entry) return res.status(404).json({ ok: false, error: "条目不存在" });
    res.json({ ok: true, entry: enrichMem(entry, memCtxSets(store)) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete("/api/memory/:id", (req, res) => {
  try {
    const store = memScopeStore(req.query && req.query.scope);
    const ok = store.remove(req.params.id);
    res.json({ ok });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put("/api/memory/:id", (req, res) => {
  try {
    const store = memScopeStore(req.body && req.body.scope);
    const entry = store.update(req.params.id, req.body || {});
    if (!entry) return res.status(404).json({ ok: false, error: "条目不存在" });
    res.json({ ok: true, entry: enrichMem(entry, memCtxSets(store)) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- Phase 2：Skill 系统 API ---------- */
app.get("/api/skills", (req, res) => {
  try {
    const q = String(req.query.q || "");
    const results = q ? engine.skills.match(q, 10) : engine.skills.list({ limit: 30 });
    res.json({ ok: true, skills: results, total: engine.skills.size });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------- W2：专家（Experts）API ---------- */
function expertRecords() {
  const reg = _engineAssets.experts || ExpertStore.builtinOnly();
  const active = (cfg.persona && cfg.persona.active) || "default";
  const toolNames = (() => {
    try { return new Set(LlmAgent.toolNames()); }
    catch (e) { return null; }
  })();
  return reg.list().map((e) => Object.assign({}, e, {
    builtin: e.source === "builtin",
    editable: e.source !== "builtin",
    active: e.id === active || e.name === active,
    unknownTools: toolNames && Array.isArray(e.tool_whitelist)
      ? e.tool_whitelist.filter((t) => t !== "*" && !toolNames.has(t)) : [],
  }));
}
app.get("/api/experts", (req, res) => {
  try {
    res.json({
      ok: true,
      experts: expertRecords(),
      active: (cfg.persona && cfg.persona.active) || "default",
      customPrompt: (cfg.persona && cfg.persona.systemPrompt) || "",
      scopes: { project: !!(WS_DIR), user: true },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
/* 生效预览：与 personaText() 同源，面板里看到的就是模型读到的 */
app.get("/api/experts/preview", (req, res) => {
  try {
    const reg = _engineAssets.experts || ExpertStore.builtinOnly();
    const probeCfg = { persona: Object.assign({}, cfg.persona, { active: req.query.id || (cfg.persona && cfg.persona.active) }) };
    const shim = { experts: reg, cfg: probeCfg };
    const text = req.query.custom != null
      ? (String(req.query.custom).trim() ? "【人格设定】\n" + String(req.query.custom).trim() : "")
      : LlmAgent.prototype.personaText.call(shim, req.query.sample || "");
    res.json({ ok: true, preview: text, chars: text.length });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 保存专家包（内置只读：改法是在 project/user 层放同名包覆盖） */
app.post("/api/experts", (req, res) => {
  try {
    const reg = _engineAssets.experts;
    if (!reg) return res.json({ ok: false, error: "专家注册表未就绪" });
    const b = req.body || {};
    const r = reg.save({
      id: b.id, name: b.name, description: b.description,
      role: b.role, methodology: b.methodology,
      tool_whitelist: Array.isArray(b.tool_whitelist) ? b.tool_whitelist.filter(Boolean).slice(0, 60) : [],
    }, b.scope === "user" ? "user" : "project");
    if (!r.ok) return res.json(r);
    res.json(Object.assign({ ok: true, experts: expertRecords() }, r));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.put("/api/experts/:id", (req, res) => {
  try {
    const reg = _engineAssets.experts;
    const cur = reg && reg.byIdOrName(req.params.id);
    if (!cur) return res.json({ ok: false, error: "专家不存在" });
    if (cur.source === "builtin") return res.json({ ok: false, error: "内置专家不可直接改，另存为项目级同名包即可覆盖" });
    const b = req.body || {};
    const r = reg.save({
      id: cur.id, name: b.name != null ? b.name : cur.name,
      description: b.description != null ? b.description : cur.description,
      role: b.role != null ? b.role : cur.role,
      methodology: b.methodology != null ? b.methodology : cur.methodology,
      tool_whitelist: b.tool_whitelist != null ? (Array.isArray(b.tool_whitelist) ? b.tool_whitelist.filter(Boolean) : []) : cur.tool_whitelist,
    }, b.scope || (cur.source === "user" ? "user" : "project"));
    if (!r.ok) return res.json(r);
    res.json(Object.assign({ ok: true, experts: expertRecords() }, r));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete("/api/experts/:id", (req, res) => {
  try {
    const reg = _engineAssets.experts;
    const r = reg ? reg.remove(req.params.id) : { ok: false, error: "专家注册表未就绪" };
    res.json(Object.assign({ experts: expertRecords() }, r));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 切换当前角色：active=专家 id / "custom"（配 systemPrompt）/ "default"（无角色层） */
app.post("/api/experts/active", (req, res) => {
  try {
    const id = String((req.body || {}).active || "default");
    const reg = _engineAssets.experts || ExpertStore.builtinOnly();
    if (id !== "default" && id !== "custom" && !reg.byIdOrName(id))
      return res.json({ ok: false, error: "专家不存在：" + id });
    cfg.persona = cfg.persona || {};
    cfg.persona.active = id;
    if (req.body && req.body.systemPrompt != null) cfg.persona.systemPrompt = String(req.body.systemPrompt).slice(0, 4000);
    try { configMod.saveAgentSettings(cfg, { persona: cfg.persona }); } catch (e) { return res.json({ ok: false, error: "已切换但未能持久化：" + e.message }); }
    res.json({ ok: true, active: id, experts: expertRecords(), customPrompt: cfg.persona.systemPrompt || "" });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get("/api/experts/export/:id", (req, res) => {
  try {
    const reg = _engineAssets.experts || ExpertStore.builtinOnly();
    const e = reg.byIdOrName(req.params.id);
    if (!e) return res.json({ ok: false, error: "专家不存在" });
    res.json({ ok: true, id: e.id, markdown: ExpertStore.toMd(e) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/experts/import", (req, res) => {
  try {
    const md = String((req.body || {}).markdown || "");
    if (!md.trim()) return res.json({ ok: false, error: "内容为空" });
    const parsed = parseExpertMd(md, (req.body.name || "").trim(), "project");
    if (!parsed) return res.json({ ok: false, error: "无法解析专家包：需要 --- frontmatter（含 name）与正文角色定位" });
    const reg = _engineAssets.experts;
    const r = reg.save(parsed, req.body.scope === "user" ? "user" : "project");
    res.json(Object.assign({ experts: expertRecords() }, r));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ---------- W4：自动化任务（Automations）API ---------- */
app.get("/api/automations", (req, res) => {
  try { res.json({ ok: true, automations: automationStore.list() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/automations", async (req, res) => {
  try {
    const r = await automationStore.create(req.body || {});
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    res.json({ ok: true, automation: r.task });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/automations/:id/:action(pause|resume|run)", async (req, res) => {
  try {
    const { id, action } = req.params;
    if (action === "run") {
      const t = automationStore.get(id);
      if (!t) return res.status(404).json({ ok: false, error: "任务不存在" });
      schedulerInst.fire(id); // 异步执行，立即返回（历史见 runs）
      return res.json({ ok: true, started: true });
    }
    const r = await automationStore.update(id, { status: action === "pause" ? "paused" : "active" });
    if (r.error) return res.status(404).json({ ok: false, error: r.error });
    res.json({ ok: true, automation: r.task });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.delete("/api/automations/:id", async (req, res) => {
  try {
    const r = await automationStore.remove(req.params.id);
    if (r.error) return res.status(404).json({ ok: false, error: r.error });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/api/automations/:id/runs", (req, res) => {
  try {
    const t = automationStore.get(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "任务不存在" });
    res.json({ ok: true, runs: automationStore.runs(req.params.id, 20) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/skills", (req, res) => {
  try {
    const skill = engine.skills.add(req.body || {});
    if (!skill) return res.status(400).json({ ok: false, error: "Skill 名称不能为空" });
    res.json({ ok: true, skill });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put("/api/skills/:id", (req, res) => {
  try {
    const id = req.params.id;
    let skill = engine.skills.update(id, req.body || {});
    const forked = !skill && engine.skills.isBuiltin(id);
    if (forked) skill = engine.skills.forkBuiltin(id, req.body || {});
    if (!skill) return res.status(404).json({ ok: false, error: "Skill 不存在" });
    res.json({ ok: true, skill, forked });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete("/api/skills/:id", (req, res) => {
  try {
    const ok = engine.skills.remove(req.params.id);
    res.json({ ok });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- T4：技能资产可视化管理（启停 / 导出 / 导入 / 注入预览） ---------- */
function skillRecords(q) {
  const st = engine.skills;
  const all = st.list({ limit: 500, search: q || undefined });
  const bk = st.builtinWorkflows || [];
  const rows = [...all, ...bk.map((s) => Object.assign({ builtin: true }, s))].map((s) => ({
    id: s.id, name: s.name, description: s.description, trigger: s.trigger, tags: s.tags || [],
    source: s.builtin ? "builtin" : s.source, scope: s.scope || (s.source === "auto" ? "project" : s.source === "user" ? "user" : "app"),
    version: s.version, useCount: s.useCount || 0, rating: s.rating || 0, ts: s.ts, disabled: !!s.disabled,
    risk: s.risk_level || "OK", builtin: !!s.builtin || s.source === "workflow",
    chars: (s.body || "").length, steps: Array.isArray(s.steps) ? s.steps.length : 0,
  }));
  return rows;
}
app.get("/api/skills/managed", (req, res) => {
  try {
    const rows = skillRecords(String(req.query.q || ""));
    res.json({
      ok: true, skills: rows,
      counts: {
        total: rows.length, on: rows.filter((r) => !r.disabled && !r.builtin).length,
        off: rows.filter((r) => r.disabled).length, builtin: rows.filter((r) => r.builtin).length,
        risky: rows.filter((r) => r.risk === "P0" || r.risk === "P1").length,
      },
      stats: engine.skills.stats,
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get("/api/skills/content", (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    const s = engine.skills.getById(req.query.id) || (name ? engine.skills.findByName(name) : null);
    if (!s) return res.json({ ok: false, error: "技能不存在" });
    res.json({ ok: true, skill: { id: s.id, name: s.name, description: s.description, trigger: s.trigger, tags: s.tags, version: s.version, body: s.body || "", steps: s.steps || [], risk: s.risk_level, disabled: !!s.disabled, source: s.source, builtin: engine.skills.isBuiltin(s.id) } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/skills/:id/toggle", (req, res) => {
  try {
    const id = req.params.id;
    /* 内置项不参与启停：它没有可写的落点（getById 现在认得内置项，
       所以这里必须显式挡，否则停用会悄悄走到 forkBuiltin，凭空多出一条副本）。 */
    if (engine.skills.isBuiltin(id)) return res.json({ ok: false, error: "内置技能随安装包分发，不可停用；要停用请先另存为我的技能" });
    const cur = engine.skills.getById(id);
    if (!cur) return res.json({ ok: false, error: "技能不存在" });
    const next = req.body && req.body.disabled != null ? !!req.body.disabled : !cur.disabled;
    engine.skills.update(id, { disabled: next });
    res.json({ ok: true, disabled: next, skills: skillRecords("") });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get("/api/skills/export/:id", (req, res) => {
  try {
    const r = engine.skills.exportMarkdown(req.params.id);
    res.json(r ? { ok: true, ...r } : { ok: false, error: "技能不存在" });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/skills/import", (req, res) => {
  try {
    const md = String((req.body || {}).markdown || "");
    if (!md.trim()) return res.json({ ok: false, error: "内容为空" });
    const r = engine.skills.importMarkdown(md);
    if (!r) return res.json({ ok: false, error: "无法解析：markdown 需要 --- frontmatter 且包含 name" });
    if (r._auditRejected) return res.json({ ok: false, error: "安全审计判定为 " + r._auditRejected.level + "：" + (r._auditRejected.findings || []).join("；"), needForce: true });
    if (r._duplicate) return res.json({ ok: false, error: "已存在同名技能「" + r.name + "」，如需替换请先删除", duplicate: true });
    res.json({ ok: true, skill: r, risk: r.risk_level, skills: skillRecords("") });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 注入预览：这轮任务模型真正会看到哪几条技能目录 */
app.get("/api/skills/preview", (req, res) => {
  try {
    const q = String(req.query.q || "");
    const matched = q ? engine.skills.match(q, 5) : [];
    res.json({
      ok: true, query: q,
      matched: matched.map((s) => ({ id: s.id, name: s.name, source: s.source })),
      directory: engine.skills.formatForContext(matched),
      disclosure: "只注入目录，正文由 use_skill 按需取回",
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ---------- Phase 2：进化报告 API ---------- */
app.get("/api/evolution", (req, res) => {
  try {
    const report = engine.evolution.getReport();
    res.json({ ok: true, report });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------- 进化树：分层树 + 时间线（聚合记忆/经验/Skill/灵魂） ---------- */
app.get("/api/evolution/tree", (req, res) => {
  try {
    const ss = soulStore || (soulStore = new SoulStore(configMod.soulPath(cfg)));
    const soul = ss.get();

    // 1) 记忆 / 经验 / 教训（来自 MemoryStore 六类）
    const memEntries = (engine && engine.memory) ? engine.memory.list({ limit: 200 }) : [];
    const memGroups = {
      memory:   { label: "记忆", icon: null, items: memEntries.filter((e) => e.type === "preference" || e.type === "decision") },
      experience:{ label: "经验", icon: null, items: memEntries.filter((e) => e.type === "lesson" || e.type === "pattern") },
      lesson:   { label: "教训", icon: null, items: memEntries.filter((e) => e.type === "error") },
    };

    // 2) Skills（内置工作流 / 用户创建 / 工作区沉淀）
    const skills = (engine && engine.skills) ? engine.skills.list({ limit: 200 }) : [];
    const builtin = (engine && engine.skills) ? engine.skills.builtinWorkflows : [];
    const skillNodes = [
      { label: "内置工作流", icon: null, items: (builtin || []).map((s) => ({ id: "bk-" + s.name, name: s.name, desc: s.description, ts: 0, source: "builtin" })) },
      { label: "用户创建", icon: null, items: skills.filter((s) => s.source === "manual" || s.source === "import").map((s) => ({ id: s.id, name: s.name, desc: s.description, ts: s.ts || 0, source: s.source })) },
      { label: "工作区沉淀", icon: null, items: skills.filter((s) => s.source === "auto").map((s) => ({ id: s.id, name: s.name, desc: s.description, ts: s.ts || 0, source: s.source })) },
    ];

    // 3) 灵魂（人格 + 待确认提案）
    const pending = (soul.proposals || []).filter((p) => p.status === "pending");
    const soulNode = {
      label: "灵魂 Soul", icon: null,
      name: soul.name, vibe: soul.vibe,
      values: soul.values, boundaries: soul.boundaries, principles: soul.principles,
      proposals: soul.proposals || [],
      pendingCount: pending.length,
    };

    // 4) 时间线：把所有带 ts 的节点打平按时间排序
    const timeline = [];
    const push = (kind, icon, title, sub, ts, id) => { if (ts) timeline.push({ kind, icon, title, sub, ts, id }); };
    memEntries.forEach((e) => push("memory", null, (e.topic || e.type) + "：" + e.content.slice(0, 80), e.type, e.ts, e.id));
    (builtin || []).forEach((s) => push("skill", null, "内置工作流：" + s.name, "builtin", 0, "bk-" + s.name));
    skills.forEach((s) => push("skill", null, "Skill：" + s.name, s.source, s.ts || 0, s.id));
    (soul.proposals || []).forEach((p) => push("soul", null, "灵魂微调提案：" + p.content.slice(0, 60), p.status, p.ts, p.id));
    timeline.sort((a, b) => b.ts - a.ts);

    // 进度系统：阶段 / 经验值 / 属性 / 成就 / 解锁规则
    const ps = progressionStore || (progressionStore = new ProgressionStore(configMod.progressionPath(cfg)));
    const prog = computeProgression({ soul, memEntries, skills: skills, builtin: builtin || [], path: ps.get().path });

    res.json({
      ok: true,
      tree: { soul: soulNode, memory: memGroups, skills: skillNodes },
      timeline,
      progression: prog,
      counts: {
        memory: memGroups.memory.items.length,
        experience: memGroups.experience.items.length,
        lesson: memGroups.lesson.items.length,
        skills: skills.length + (builtin || []).length,
        proposals: (soul.proposals || []).length,
        pending: pending.length,
      },
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------- 灵魂(Soul)读写 + 微调提案确认 ---------- */
function soulInst() { return soulStore || (soulStore = new SoulStore(configMod.soulPath(cfg))); }
app.get("/api/soul", (req, res) => {
  try {
    const soul = soulInst().get();
    res.json({
      ok: true, soul,
      editable: { text: ["name", "vibe", "emoji"], lists: ["values", "boundaries", "principles"] },
      pending: (soul.proposals || []).filter((p) => p.status === "pending").length,
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.put("/api/soul", (req, res) => {
  try {
    res.json({ ok: true, soul: soulInst().update(req.body || {}) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
/* 一键回到出厂人格：清空自定义条目与提案历史 */
app.post("/api/soul/reset", (req, res) => {
  try { res.json({ ok: true, soul: soulInst().reset() }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/soul/proposal", (req, res) => {
  try {
    const p = soulInst().addProposal(req.body || {});
    if (!p) return res.status(400).json({ ok: false, error: "提案内容不能为空" });
    res.json({ ok: true, proposal: p });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.put("/api/soul/proposal/:id", (req, res) => {
  try {
    const accept = req.query.accept !== "0" && req.query.accept !== "false";
    const p = soulInst().resolveProposal(req.params.id, accept);
    if (!p) return res.status(404).json({ ok: false, error: "提案不存在" });
    res.json({ ok: true, proposal: p, soul: soulInst().get() });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.delete("/api/soul/proposal/:id", (req, res) => {
  try { res.json({ ok: soulInst().removeProposal(req.params.id), soul: soulInst().get() }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ---------- 进度：进化路线（读 + 设定） ---------- */
app.get("/api/progression", (req, res) => {
  try {
    const ps = progressionStore || (progressionStore = new ProgressionStore(configMod.progressionPath(cfg)));
    const st = engine.skills;
    const prog = computeProgression({
      soul: soulInst().get(),
      memEntries: _engineAssets.memory ? _engineAssets.memory.list({ limit: 500, archived: "all" }) : [],
      skills: st.list({ limit: 500 }),
      builtin: st.builtinWorkflows || [],
      path: ps.get().path,
    });
    res.json({
      ok: true, path: ps.get().path, progression: prog,
      paths: Object.keys(PATHS).map((k) => ({ id: k, name: PATHS[k].name, desc: PATHS[k].desc })),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/progression", (req, res) => {
  try {
    const ps = progressionStore || (progressionStore = new ProgressionStore(configMod.progressionPath(cfg)));
    const p = ps.setPath((req.body && req.body.path) || null);
    res.json({ ok: true, path: p.path });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ---------- 会话沉淀：把有效决策 / 约定沉淀为「项目规则」或「项目记忆」 ---------- */
/* ---------- 编排历史（多 Agent 编排的服务端运行记录，可点开回放） ---------- */
app.get("/api/orch/history", (req, res) => {
  try { res.json({ ok: true, runs: orchHistList() }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get("/api/orch/history/:id", (req, res) => {
  try {
    const r = orchHistGet(req.params.id);
    res.json(r ? { ok: true, run: r } : { ok: false, error: "记录不存在" });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* 规则清单：工作区 .pancode/rules + ROOT 级历史遗留。与 Agent loadRules() 严格同源。 */
function collectRuleRecords(touched) {
  const out = [];
  const cand = LlmAgent.RULE_CANDIDATES;
  const seen = new Set();
  const pushRec = (file, content, scope) => {
    if (seen.has(file)) return;
    // 应用级文件带 "app:/" 前缀只为区分来源，分类时先剥掉，展示时再放回去
    const rec = rulesLib.describe(file.replace(/^app:\/?/, ""), content, scope, cand);
    if (!rec) return;
    seen.add(file);
    rec.file = file;
    const parsed = rulesLib.parseFrontmatter(content);
    const act = rulesLib.activeFor(parsed.meta, touched);
    // 应用级（数据根 .pancode/rules）历史遗留文件：loadRules() 不读它，面板不能谎称"生效"
    rec.active = scope === "app" ? false : act.on;
    rec.activeWhy = scope === "app" ? "应用级遗留目录，Agent 不读取（要生效请沉淀/新建到工作区 .pancode/rules）" : act.why;
    out.push(rec);
  };
  let listed = [];
  try { listed = files.list().map((x) => x.replace(/\\/g, "/")); } catch (e) {}
  /* 用户全局层：Agent 的 loadRules() 真的会读 ~/.pancode/AGENTS.md。
     面板不列它就会出现"预览里有、清单里无"的裂口——两边必须同源。 */
  try {
    const gp = agentCtx.userGlobalRulePath();
    if (gp) pushRec("~/.pancode/AGENTS.md", fs.readFileSync(gp, "utf8"), "global");
  } catch (e) {}
  // files.list() 看不见点开头目录，规则目录必须另外枚举磁盘（与 loadRules 同一套枚举函数）
  const dotFiles = [];
  for (const rel of rulesLib.RULE_DIRS) {
    try { dotFiles.push.apply(dotFiles, rulesLib.listRuleDir(files.dir, rel)); } catch (e) {}
  }
  for (const f of rulesLib.rootRuleFiles(files.dir, cand, listed)) dotFiles.push(f);
  for (const f of listed) if (rulesLib.kindOf(f, cand)) {
    let c = ""; try { c = files.read(f); } catch (e) {}
    pushRec(f, c, "workspace");
  }
  for (const f of dotFiles) {
    let c = ""; try { c = files.read(f); } catch (e) {}
    pushRec(f, c, "workspace");
  }
  try {
    const rd = configMod.rulesDir();
    if (fs.existsSync(rd)) {
      for (const f of fs.readdirSync(rd).filter((x) => /\.md$/i.test(x))) {
        let c = ""; try { c = fs.readFileSync(path.join(rd, f), "utf8"); } catch (e) {}
        pushRec("app:/.pancode/rules/" + f, c, "app");
      }
    }
  } catch (e) {}
  out.sort((a, b) => a.order - b.order || String(a.file).localeCompare(String(b.file)));
  return out;
}

/* 沉淀规则预览：沿用同一份收集逻辑 */
function listSedimentRules() {
  return collectRuleRecords([]).filter((r) => r.kind === "pancode" || r.kind === "root")
    .map((r) => {
      let c = "";
      try { c = r.file.startsWith("app:/") ? fs.readFileSync(path.join(configMod.rulesDir(), path.posix.basename(r.file)), "utf8") : files.read(r.file); } catch (e) {}
      return { file: r.file, content: String(c).slice(0, 4000), scope: r.scope };
    });
}

/* ---------- T4：规则（Rules）可视化管理 CRUD ----------
   只允许编辑工作区内的 .pancode/rules/*.md：AGENTS.md / CLAUDE.md 是跨工具共享的
   约定文件，Cursor 规则库属于另一个产品，改它们等于替用户动了别的工具的资产。 */
function rulePath(file) {
  const f = String(file || "").replace(/\\/g, "/");
  if (!f.startsWith(rulesLib.RULES_DIR + "/") || !/\.md$/i.test(f)) return null;
  if (f.includes("..")) return null;
  return f;
}
/* 取"改动前那份内容"给历史用。读不出来（二进制 / 超 1MB / 权限）就返回 null：
   版本化是附加能力，不能因为快照取不到就挡住用户存规则。 */
function prevRuleContent(rel) {
  try { return files.exists(rel) ? files.read(rel) : null; } catch (e) { return null; }
}
app.get("/api/rules", (req, res) => {
  try {
    const q = String(req.query.q || "");
    let touched = [];
    if (q) { try { touched = files.list().filter((x) => String(x).toLowerCase().includes(q.toLowerCase())).slice(0, 40); } catch (e) {} }
    const rules = collectRuleRecords(touched);
    res.json({
      ok: true, rules,
      counts: {
        total: rules.length,
        active: rules.filter((r) => r.active).length,
        off: rules.filter((r) => !r.enabled).length,
        conditional: rules.filter((r) => r.globs && r.globs.length).length,
        editable: rules.filter((r) => r.editable).length,
      },
      budget: {
        chars: rules.filter((r) => r.active).reduce((n, r) => n + r.chars + r.file.length + 24, 0),
        // 面板分母与 Agent 的实际预算同源：stable 桶 + conditional 桶
        max: agentCtx.RULE_MAX_STABLE + agentCtx.RULE_MAX_CONDITIONAL,
      },
      enabledGlob: !!(cfg.rules && cfg.rules.enabled),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get("/api/rules/content", (req, res) => {
  try {
    const f = String(req.query.file || "");
    if (f.startsWith("app:/")) return res.json({ ok: false, error: "应用级规则为只读遗留文件，请直接在工作区 .pancode/rules 新建同名规则覆盖" });
    /* 只读通道走白名单形状判定：AGENTS.md / CLAUDE.md / Cursor .mdc / 用户全局
       这些"面板列得出来却读不到"的行，点进去以前一律报「非法规则路径」。
       写入仍只认 rulePath(.pancode/rules/*.md)，两者不同源是刻意的。 */
    const rr = rulesLib.resolveReadableRule(files.dir, f, LlmAgent.RULE_CANDIDATES);
    if (!rr) return res.json({ ok: false, error: "非法规则路径" });
    let raw = "";
    if (rr.kind === "global") {
      const gp = agentCtx.userGlobalRulePath();
      if (!gp) return res.json({ ok: false, error: "用户全局规则文件不存在" });
      raw = fs.readFileSync(gp, "utf8");
    } else {
      if (!files.exists(rr.rel)) return res.json({ ok: false, error: "规则文件不存在" });
      raw = files.read(rr.rel);
    }
    const parsed = rulesLib.parseFrontmatter(raw);
    res.json({ ok: true, file: rr.rel, kind: rr.kind, editable: rr.editable, raw, meta: parsed.meta, body: parsed.body });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/rules", (req, res) => {
  try {
    const b = req.body || {};
    const body = String(b.content || b.body || "").trim();
    if (!body) return res.json({ ok: false, error: "规则正文不能为空" });
    const meta = {
      title: String(b.title || "").trim().slice(0, 60),
      description: String(b.description || "").trim().slice(0, 120),
      enabled: b.enabled !== false,
      always: !!b.always,
      globs: Array.isArray(b.globs) ? b.globs.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : [],
    };
    const file = rulesLib.RULES_DIR + "/" + rulesLib.safeName(meta.title, b.file) + ".md";
    if (files.exists(file) && !b.overwrite) return res.json({ ok: false, error: "已存在同名规则「" + meta.title + "」，请改名或选择覆盖" });
    /* 覆盖写之前留一份旧内容。新建（文件不存在）不留版——没有"旧内容"可留，
       造一条空版本只会让历史列表里多一行看不懂的东西。 */
    if (files.exists(file)) ruleHistory.snapshot(file, prevRuleContent(file), "update");
    files.write(file, rulesLib.toMd(meta, body));
    res.json({ ok: true, file, rules: collectRuleRecords([]) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.put("/api/rules", (req, res) => {
  try {
    const b = req.body || {};
    const rel = rulePath(b.file);
    if (!rel) return res.json({ ok: false, error: "只能编辑工作区 .pancode/rules 下的规则" });
    if (!files.exists(rel)) return res.json({ ok: false, error: "规则文件不存在" });
    const cur = rulesLib.parseFrontmatter(files.read(rel));
    const meta = Object.assign({}, cur.meta, {
      title: b.title != null ? String(b.title).trim().slice(0, 60) : cur.meta.title,
      description: b.description != null ? String(b.description).trim().slice(0, 120) : cur.meta.description,
      enabled: b.enabled != null ? !!b.enabled : cur.meta.enabled,
      always: b.always != null ? !!b.always : cur.meta.always,
      globs: b.globs != null ? (Array.isArray(b.globs) ? b.globs.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : []) : cur.meta.globs,
    });
    const body = b.content != null ? String(b.content).trim() : cur.body;
    if (!body) return res.json({ ok: false, error: "规则正文不能为空" });
    ruleHistory.snapshot(rel, prevRuleContent(rel), "update");
    files.write(rel, rulesLib.toMd(meta, body));
    res.json({ ok: true, file: rel, rules: collectRuleRecords([]) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete("/api/rules", (req, res) => {
  try {
    const rel = rulePath(req.body && req.body.file);
    if (!rel) return res.json({ ok: false, error: "只能删除工作区 .pancode/rules 下的规则" });
    if (!files.exists(rel)) return res.json({ ok: false, error: "规则文件不存在" });
    /* 删除前必须留一份：这条是整套版本化里唯一"没有快照就真找不回来"的路径。
       留了这份，用户误删规则之后还能从历史里把文件本体恢复出来。 */
    ruleHistory.snapshot(rel, prevRuleContent(rel), "delete");
    files.remove(rel);
    res.json({ ok: true, rules: collectRuleRecords([]) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* ---------- P1-B5 规则历史：列表 / 行级 diff / 回滚 ---------- */
app.get("/api/rules/history", (req, res) => {
  try {
    const rel = rulePath(req.query.file);
    if (!rel) return res.json({ ok: false, error: "非法规则路径" });
    res.json({ ok: true, file: rel, slug: ruleHistory.slugOf(rel), keep: ruleHistory.KEEP_PER_FILE, versions: ruleHistory.list(rel) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get("/api/rules/diff", (req, res) => {
  try {
    const rel = rulePath(req.query.file);
    if (!rel) return res.json({ ok: false, error: "非法规则路径" });
    const hit = ruleHistory.read(rel, req.query.ts);
    if (!hit) return res.json({ ok: false, error: "没有这个版本（可能已被更旧的版本挤出保留数）" });
    const cur = prevRuleContent(rel);
    const d = ruleHistory.diffLines(hit.content, cur == null ? "" : cur);
    res.json({ ok: true, file: rel, meta: hit.meta, exists: cur != null, tooBig: d.tooBig, added: d.added, removed: d.removed, lines: d.lines, old: hit.content });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 回滚。回滚之前先把"当前这份"也存一版（pre-restore）——
   否则误滚一次就把手头那份没保存好的改动永久弄丢，等于用一个不可逆去修另一个不可逆。 */
app.post("/api/rules/restore", (req, res) => {
  try {
    const rel = rulePath(req.body && req.body.file);
    if (!rel) return res.json({ ok: false, error: "只能恢复工作区 .pancode/rules 下的规则" });
    const hit = ruleHistory.read(rel, req.body && req.body.ts);
    if (!hit) return res.json({ ok: false, error: "没有这个版本，恢复不了" });
    if (files.exists(rel)) ruleHistory.snapshot(rel, prevRuleContent(rel), "pre-restore");
    files.write(rel, hit.content);
    res.json({ ok: true, file: rel, restoredFrom: hit.meta, rules: collectRuleRecords([]) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 一键启停：只重写 frontmatter，正文一字不动 */
app.post("/api/rules/toggle", (req, res) => {
  try {
    const rel = rulePath(req.body && req.body.file);
    if (!rel) return res.json({ ok: false, error: "该规则不可编辑" });
    if (!files.exists(rel)) return res.json({ ok: false, error: "规则文件不存在" });
    const raw = files.read(rel);
    const parsed = rulesLib.parseFrontmatter(raw);
    const next = req.body.enabled != null ? !!req.body.enabled : !parsed.meta.enabled;
    ruleHistory.snapshot(rel, prevRuleContent(rel), "toggle");
    files.write(rel, rulesLib.toMd(Object.assign({}, parsed.meta, { enabled: next }), parsed.body));
    res.json({ ok: true, enabled: next, rules: collectRuleRecords([]) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 生效预览：直接调真实的 loadRules，面板里看到的就是模型读到的 */
app.get("/api/rules/preview", (req, res) => {
  try {
    const q = String(req.query.q || "");
    let touched = [];
    if (q) { try { touched = files.list().filter((x) => String(x).toLowerCase().includes(q.toLowerCase())).slice(0, 40); } catch (e) {} }
    let text = "";
    /* 必须挂上原型再调：loadRules 内部会分派到 this.loadRulesParts()，
       用裸对象 { files } 当 this 时那个方法不存在，预览会直接抛错。 */
    try {
      const probe = Object.create(LlmAgent.prototype);
      probe.files = files;
      text = probe.loadRules(touched);
    } catch (e) { return res.json({ ok: false, error: "预览失败：" + e.message }); }
    res.json({ ok: true, preview: text, chars: text.length, max: agentCtx.RULE_MAX_STABLE + agentCtx.RULE_MAX_CONDITIONAL, touched: touched.length, query: q });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ---------- P3-D3 自进化规则：证据 → 提案 → 人工采纳 ----------
   提案不叫 LLM 生成，只从既有账本里数重复（证据口径见 server/rule-proposals.js 头注释）。
   面板每打开一次扫一遍：证据消失了（记忆被裁剪、决策滚出窗口）pending 自动下架，
   已采纳/已忽略是人的决定，按住不再冒出来。 */
const PROPOSAL_WINDOW_DAYS = 7;
function proposalEvidence() {
  const dl = require("./decision-log");
  const decisions = [];
  for (const d of (dl.decisionDates() || []).slice(0, PROPOSAL_WINDOW_DAYS)) {
    try { decisions.push.apply(decisions, dl.readDecisions({ date: d, limit: 2000 })); } catch (e) {}
  }
  return {
    decisions,
    entries: _engineAssets.memory ? _engineAssets.memory.list({ limit: 200 }) : [],
  };
}
app.get("/api/rule-proposals", (req, res) => {
  try {
    const store = _engineAssets.ruleProposals;
    if (!store) return res.json({ ok: false, error: "提案库未就绪（工作区尚未挂载）" });
    const ev = proposalEvidence();
    store.sync(ruleProp.candidates(ev));
    const proposals = store.list().map((p) => Object.assign({}, p, {
      ruleFileExists: !!(p.ruleFile && files.exists(p.ruleFile)),
    }));
    res.json({
      ok: true, proposals, counts: store.counts(), minRepeat: ruleProp.MIN_REPEAT,
      sourceLabels: ruleProp.SRC_LABEL,
      window: { days: PROPOSAL_WINDOW_DAYS, decisions: ev.decisions.length, memories: ev.entries.length },
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 采纳 = 往工作区 .pancode/rules 写一条真规则。
   走的是与 POST /api/rules 同一条写路径（rulesLib.toMd + files.write），
   所以它天然带 frontmatter（能在规则面板里停用）、受 rule-history 快照（改坏了能回滚）。 */
app.post("/api/rule-proposals/:id/adopt", (req, res) => {
  try {
    const store = _engineAssets.ruleProposals;
    const p = store && store.get(req.params.id);
    if (!p) return res.json({ ok: false, error: "提案不存在（证据已消失或账本被清理）" });
    if (p.status === "adopted" && p.ruleFile && files.exists(p.ruleFile)) {
      return res.json({ ok: true, already: true, proposal: p, file: p.ruleFile, rules: collectRuleRecords([]) });
    }
    const body = String(p.statement || "").trim();
    if (!body) return res.json({ ok: false, error: "这条提案没有可写入的正文" });
    /* 文件名带上提案 id 的尾段：两条不同来源的提案可能撞出同一个标题
       （同一工具既被拒过又撞过拒绝规则），不带尾号就是后采纳的那条覆盖前一条。 */
    const rel = rulesLib.RULES_DIR + "/" + rulesLib.safeName("evolve " + p.title + " " + p.id.slice(-4)) + ".md";
    if (files.exists(rel)) ruleHistory.snapshot(rel, prevRuleContent(rel), "update");
    files.write(rel, rulesLib.toMd({
      title: "进化 · " + p.title,
      description: "采纳自规则提案（" + (ruleProp.SRC_LABEL[p.source] || p.source) + " 证据 " + p.count + " 次）",
      enabled: true,
    }, body));
    const hit = store.setStatus(p.id, "adopted", { ruleFile: rel });
    writeAudit("rules", "采纳规则提案 " + rel);
    res.json({ ok: true, proposal: hit, file: rel, rules: collectRuleRecords([]) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/rule-proposals/:id/dismiss", (req, res) => {
  try {
    const store = _engineAssets.ruleProposals;
    const hit = store && store.setStatus(req.params.id, "dismissed");
    if (!hit) return res.json({ ok: false, error: "提案不存在" });
    res.json({ ok: true, proposal: hit, counts: store.counts() });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
/* 忽略点错了要能收回来：忽略态只是按住，不删证据，重新待定后下一轮扫描仍在。 */
app.post("/api/rule-proposals/:id/reopen", (req, res) => {
  try {
    const store = _engineAssets.ruleProposals;
    const hit = store && store.setStatus(req.params.id, "pending");
    if (!hit) return res.json({ ok: false, error: "提案不存在" });
    res.json({ ok: true, proposal: hit, counts: store.counts() });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get("/api/sediment", (req, res) => {
  try {
    // 规则：Agent 的 loadRules() 读的是「工作区内」.pancode/rules/*.md，预览必须同源
    const rules = listSedimentRules();
    const mem = (_engineAssets.memory ? _engineAssets.memory.list({ limit: 200 }) : [])
      .filter((e) => e.source === "sediment" || e.sticky)
      .map((e) => ({ id: e.id, type: e.type, topic: e.topic, content: e.content, ts: e.ts }));
    res.json({ ok: true, rules, memory: mem, counts: { rules: rules.length, memory: mem.length, total: _engineAssets.memory ? _engineAssets.memory.size : 0 } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post("/api/sediment", async (req, res) => {
  try {
    const { target, title, content, scope } = req.body || {};
    if (!content || !String(content).trim()) return res.status(400).json({ ok: false, error: "沉淀内容不能为空" });
    const stamp = new Date().toISOString().slice(0, 10);
    const topic = (title || "沉淀").toString().trim().slice(0, 60);
    const text = String(content).trim().slice(0, 4000);
    if (target === "rule") {
      /* 一条沉淀 = 一条规则 = 一个带 frontmatter 的文件。
         旧写法按天把沉淀追加进同一个 sediment-<date>.md，三个后果：
           · 没有 frontmatter → 规则面板只能给整份起一个标题，单条关不掉、也挂不上 glob；
           · 没有去重 → 同一句话点两次「沉淀」，硬约束里就出现两遍一模一样的话；
           · 一天的沉淀挤在一个文件里 → 想撤一条得改整份文件，写前快照也把无关的几条一起卷进版本。
         文件名保留 sediment- 前缀：沉淀面板按它认出自己写的那批（assets-center 的筛条）。 */
      const rel = rulesLib.RULES_DIR + "/sediment-" + rulesLib.safeName(topic, "rule") + ".md";
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
      if (files.exists(rel)) {
        const cur = rulesLib.parseFrontmatter(files.read(rel));
        if (norm(cur.body) === norm(text)) return res.json({ ok: true, target, file: rel, unchanged: true });
        ruleHistory.snapshot(rel, prevRuleContent(rel), "update");
      }
      files.write(rel, rulesLib.toMd({
        title: topic,
        description: "由「沉淀」入口写入（" + stamp + "）",
        enabled: true,
      }, text));
      return res.json({ ok: true, target, file: rel });
    }
    // 记忆：写入结构化 MemoryStore（sticky + 高价值，免于遗忘曲线裁剪）
    const store = target === "user" ? _engineAssets.userMemory : _engineAssets.memory;
    if (!store) return res.status(500).json({ ok: false, error: "记忆库未就绪" });
    const type = ["preference", "lesson", "pattern", "decision", "error", "skill"].includes(scope) ? scope : "decision";
    const e = store.add(type, topic, text, { source: "sediment", valueScore: 5, sticky: true });
    res.json({ ok: true, target: target || "memory", id: e && e.id });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
/* 自动提炼：把本次会话交给 LLM，产出「值得沉淀」的候选清单，用户勾选后再落库 */
app.post("/api/sediment/distill", async (req, res) => {
  try {
    const msgs = (req.body && req.body.messages) || [];
    if (msgs.length < 2) return res.json({ ok: false, error: "会话内容太少，暂无可提炼" });
    const transcript = msgs.slice(-40).map((m) => (m.role === "user" ? "用户" : "Agent") + ": " + String(typeof m.content === "string" ? m.content : JSON.stringify(m.content) || "").slice(0, 600)).join("\n").slice(0, 16000);
    const { chatStream } = require("./llm");
    const r = await chatStream(cfg.llm, [
      { role: "system", content: '你是记忆蒸馏器。从对话中挑出「未来同类任务真的会用上」的长期资产，最多 5 条。只输出 JSON 数组，每项形如 {"target":"rule|memory","scope":"preference|lesson|decision|pattern","title":"≤20字","content":"≤200字，陈述句，不含对话指代"}。rule=必须遵守的约定；memory=经验参考。不要沉淀一次性闲聊、不要复述任务过程。' },
      { role: "user", content: transcript },
    ], null, null);
    const raw = (r.content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "");
    let items = [];
    try { items = JSON.parse(raw); } catch (e) { const m = raw.match(/\[[\s\S]*\]/); if (m) { try { items = JSON.parse(m[0]); } catch (_e) {} } }
    res.json({ ok: true, items: (Array.isArray(items) ? items : []).slice(0, 5).filter((x) => x && x.content) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ---------- P3-D2 代码依赖图 REST（底栏「依赖」页签的数据源） ----------
   索引取自 engine._repoIndex()：那是 Agent 自己用的同一份缓存，fileChanged 会置脏。
   另起一份缓存就会出现"面板说没有依赖、Agent 说有"的两套真相。 */
app.get("/api/graph", (req, res) => {
  try {
    /* 取"这个用户正在用的那个引擎"的索引，而不是全局 anon 那份：
       缓存是按引擎实例挂的（_repoCache / _repoDirty），Agent 写完文件只把自己那份弄脏。
       用错实例就会出现"面板说没有牵连、Agent 说有一串"——实测就是这样假绿过一次。 */
    const eng = ensureUserEngine(tokenUserKey(tokenOf(req)));
    if (!eng || typeof eng._repoIndex !== "function") return res.json({ ok: false, error: "引擎未就绪" });
    const CG = require("./code-graph");
    let all = [];
    try { all = (files.list() || []).map(CG.norm); } catch (e) { all = []; }
    const g = CG.fromIndex(eng._repoIndex(), all);
    const file = CG.norm(req.query.file || "");
    const depth = Math.max(1, Math.min(4, Number(req.query.depth) || 2));
    const o = CG.overview(g, { top: 8 });
    res.json({
      ok: true,
      files: g.nodes.size,
      linked: g.linked.size,
      edges: [...g.out.values()].reduce((n, s) => n + s.size, 0),
      hubs: o.hubs, cycles: o.cycles, orphanCount: o.orphanCount, orphans: o.orphans,
      node: file ? {
        path: file,
        known: g.nodes.has(file),
        deps: [...(g.out.get(file) || [])].sort(),
        importers: [...(g.in.get(file) || [])].sort(),
        impact: CG.impact(g, file, depth),
      } : null,
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ---------- 轻量代码向量索引 REST ---------- */
app.post("/api/index/build", async (req, res) => {
  try {
    const r = await codeIndex.buildIndex({ wsDir: WS_DIR, fileStore: files, cfg });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post("/api/index/search", async (req, res) => {
  try {
    const q = (req.body && req.body.query) || "";
    const k = Number((req.body && req.body.k) || 8);
    if (!q.trim()) return res.status(400).json({ ok: false, error: "query 为空" });
    const r = await codeIndex.search({ wsDir: WS_DIR, query: q, k });
    res.json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/api/index/status", (req, res) => {
  const idx = codeIndex.getIndex(WS_DIR);
  res.json({ ok: true, built: !!idx, meta: idx ? idx.meta : null });
});


/* ---------- WebSocket ---------- */
const server = http.createServer(app);
/* handleProtocols 是 ws v8 唯一能回显 Sec-WebSocket-Protocol 的钩子：
   completeUpgrade 里 protocols.size > 0 时才调它，返回值直接写进响应头。
   （handleUpgrade(req, socket, head, cb) 只有 4 个参数，没有 headers 位——
     把 hdrs 塞在第 4 位会把 cb 顶掉，连接建成后回调永不触发。） */
const wss = new WebSocketServer({
  noServer: true,
  /* 客户端把令牌当 "bearer.<tok>" 子协议申请，服务端必须回显一个已接受的协议名，
     否则浏览器按 RFC 6455 §4.1 判定"未选择任何子协议"而断开连接。回显同一个值。 */
  handleProtocols: (protocols) => {
    for (const p of protocols) if (p.indexOf("bearer.") === 0) return p;
    return false;   // 不选任何子协议
  },
});
const lspManager = new LspManager(cfg);
setActiveManager(lspManager);   // 让 Agent 的 get_diagnostics 工具能访问同一实例的诊断缓存

/* A1：业务 WS 仅接受登录后的 userToken（登录闸门）。AUTH_TOKEN 仅用于本机 bootstrap，不再用于 WS
   修 C-B2（另一半）：query string 已不用；浏览器 WebSocket API 无法自定义 header，
   令牌改走 Sec-WebSocket-Protocol（RFC 6455 推荐的握手内传递方式，不进 URL，
   因而不会出现在浏览器历史 / Referer / 访问日志里）。协议名是 "bearer.<token>"。 */
function wsTokenFromProtocol(h) {
  const raw = String(h || "");
  if (!raw) return "";
  const list = raw.split(",").map((s) => s.trim());
  for (const p of list) {
    if (p.indexOf("bearer.") === 0) return decodeURIComponent(p.slice(7));
  }
  return "";
}
server.on("upgrade", (req, socket, head) => {
  /* rebinding 防护与 HTTP 侧同口径：握手也是一次 HTTP 请求，Host 不是本机回环就销毁。
     LSP 端点一并覆盖（它分流在鉴权之前）。 */
  if (!isLocalHostHeader(req.headers.host)) { socket.destroy(); return; }
  const u = new URL(req.url, "http://localhost");
  // LSP 走独立端点 /lsp，避免与主聊天 WS 混流
  if (u.pathname === "/lsp") { lspManager.handleUpgrade(req, socket, head); return; }
  /* query 兜底默认关闭（与 HTTP 侧同一个开关）；老前端/老脚本平滑升级用 */
  const legacy = process.env.PANCODE_ALLOW_TOKEN_QUERY === "1" ? (u.searchParams.get("token") || "") : "";
  const tok = wsTokenFromProtocol(req.headers["sec-websocket-protocol"]) || legacy;
  if (!auth.verify(tok)) { socket.destroy(); return; }
  /* 子协议回显交给 wss 的 handleProtocols（见上方构造处），这里只负责鉴权与移交 */
  wss.handleUpgrade(req, socket, head, (ws) => { ws._userToken = tok; wss.emit("connection", ws, req); });
});

/* WS 指令执行的统一包装。原先 catch 之后只往前端发一条 op.error，服务端一行日志不留，
   于是"界面上说服务内部异常"和"后台到底哪一步炸了"完全对不上号 —— 出了问题只能靠猜。
   修法（见 ws-safe.js 的完整注释）：落一行服务端日志 + 生成 reqId 回传前端。
   实现放在 ws-safe.js 而非这里，因为本文件模块顶层会 listen()，require 进来就等于起服务，
   断言脚本没法在没有服务端的环境里单测这条链路。 */
const { safe } = require("./ws-safe");

/* 用户侧文件操作的 /undo 检查点：按能力取快照，缺方法的引擎返回 null（调用侧也随之跳过）。
   返回 null 而不是 [] —— [] 会被压成一条"什么都没改"的空检查点，撤回去是假的还原。 */
function userSnaps(eng, paths) {
  if (!eng || typeof eng._snapshotBefore !== "function") return null;
  return paths.filter((p) => typeof p === "string" && p).map((p) => eng._snapshotBefore(p));
}
function userCheckpoint(eng, snaps, label) {
  if (snaps == null || !snaps.length || typeof eng._pushCheckpoint !== "function") return;
  eng._pushCheckpoint(snaps, label);
}

wss.on("connection", (ws) => {
  clients.add(ws);
  // 每连接绑定用户级 engine（会话/目标/trace 隔离；重资产仍共享）。
  // 注意：不在此处缓存实例引用——LlmAgent 按"每消息查表"取（见下），
  // 这样 /api/settings 热更新（buildEngine 重建引擎缓存）后旧连接立即用上新引擎。
  const uKey = wsUserKey(ws);
  ws._userKey = uKey;
  ws._alive = true;                    // 心跳存活标记，见文件底部 wsHeartbeat
  ws.on("pong", () => { ws._alive = true; });
  // 缺省无 error 监听时，ws 抛出的连接错误会成为未处理事件（靠全局兜底吞掉，连接却残留在集合里）
  ws.on("error", () => clients.delete(ws));
  helloPayload(ensureUserEngine(uKey), uKey).then((h) => {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify(h));
    /* 上次进程退出时没收口的 Goal：连上来就说一句，别让用户自己发现"它不动了"。
       只提示不自动续跑——重启后擅自继续改盘/跑命令，是用户没点头的事。 */
    const eng = userEngines.get(uKey);
    const pending = eng && typeof eng._pendingGoals === "function" ? eng._pendingGoals() : [];
    for (const p of pending) {
      ws.send(JSON.stringify({ type: "goal.pending", convId: p.convId, turns: p.turns, goal: eng._goal }));
      ws.send(JSON.stringify({ type: "term.line", text: "[Goal] 上次这个会话跑到第 " + p.turns + " 轮被进程退出打断，要不要继续？", cls: "tl-warn" }));
    }
  });
  ws.on("close", () => clients.delete(ws));
  ws.on("message", (raw) => {
    ws._alive = true;                  // 客户端有来流即证明链路可用
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    const uEng = ensureUserEngine(ws._userKey || "anon");   // 每条消息按 userKey 查表（Map.get，无分配开销）
    /* 这条消息来自哪个用户——随后所有"属于某个会话"的事件都按它收窄收件人，
       免得 A 的操作把 B 的界面/审批卡一起改了（理由见 server/event-scope.js）。 */
    const msgKey = ws._userKey || "anon";

    switch (m.type) {
      case "chat": {
        const txt = typeof m.text === "string" ? m.text.slice(0, 8000) : "";
        const skillId = typeof m.skillId === "string" ? m.skillId : "";
        /* 挂了 Skill 就不要求输入框必须有字：选一个技能本身就是一个指令
           （对齐 Claude Code 的 slash command——/skill-name 可以不带参数）。 */
        if (txt.trim() || skillId) {
          // 多会话并行：不切换会话，直接传 convId 给 handleChat（按连接绑定的用户实例）
          uEng.handleChat(txt, { convId: m.convId, attachments: Array.isArray(m.attachments) ? m.attachments : [], skillId })
            .catch((e) => log.tag("agent").error("handleChat 抛错（会话已收口，不会留下永远在跑的假行）：" + String((e && e.stack) || e).slice(0, 300)));
        }
        break;
      }
      /* W27 · 对话 rewind：从某条用户消息重跑。backIndex = 从最新数起的第几条用户消息
         （0 = 最后一条）。服务端把该会话历史截断到这条消息之前，再按原文重跑 ——
         "改一下我刚才的指令重新来"不再需要新开会话或把上下文越滚越长。 */
      case "rewind": {
        const txt = typeof m.text === "string" ? m.text.slice(0, 8000) : "";
        const backIndex = Math.max(0, Math.min(2000, Number(m.backIndex) || 0));
        if (txt.trim() && typeof uEng.rewindAndRun === "function") {
          Promise.resolve(uEng.rewindAndRun(txt, { convId: m.convId, backIndex }))
            .catch((e) => {
              log.tag("agent").error("rewind 重跑失败：" + String((e && e.stack) || e).slice(0, 300));
              broadcast({ type: "op.error", error: "重跑失败：" + (e && e.message || e), convId: m.convId }, msgKey);
            });
        }
        break;
      }

      /* 前端主动查询上下文实测水位（页面加载 / 会话切换 / 收到回答后调用） */
      case "ctx.query": {
        try {
          /* 分母必须与引擎的压缩判定同源（_ctxLimit = _compactSpec().thresholdTokens）。
             以前这里自己拿模型窗口 ×0.9，于是进度条按 115200 走、真正触发压缩的线是 102400，
             用户永远看不到 100%，Agent 却在一遍遍压缩——看起来就像"统计是假的"。 */
          const budget = uEng && typeof uEng._ctxLimit === "function"
            ? uEng._ctxLimit()
            : ((cfg.context || {}).budgetTokens || 1000000);
          const used = (uEng && typeof uEng._ctxUsed === "function" && Array.isArray(uEng.history))
            ? uEng._ctxUsed(uEng.history) : 0;
          ws.send(JSON.stringify({ type: "context.usage", used, budget,
            est: !(uEng && uEng._lastPrompt && uEng._lastPromptArr === uEng.history) }));
        } catch (e) { /* 引擎未就绪时静默 */ }
        break;
      }

      /* Goal：前端只负责「说要设什么目标」，设定与续跑预算全部落在服务端，
         这样刷新页面 / 断线重连后 Goal 仍然继续。不走 execTool，避免被 Ask 模式拦截。 */
      case "goal.set": {
        if (!uEng) break;
        const g = typeof m.goal === "string" ? m.goal.trim().slice(0, 2000) : "";
        const cid = m.convId || uEng._currentConv || "default";
        uEng._goal = g || null;
        uEng._saveGoal();
        uEng._goalState = uEng._goalState || {};
        uEng._goalState[cid] = { turns: 0, stall: 0, lastSig: "" };
        broadcast({ type: "goal.set", goal: g || null, convId: cid }, msgKey);
        if (g && !uEng.runningConvs.has(cid)) {
          uEng.handleChat("【Goal】请围绕以下目标自主推进直到完成：\n" + g + "\n先用 create_plan 拆解为可验收步骤，逐步执行并验证，全部完成后结束。", { convId: cid });
        }
        break;
      }
      /* 重启后接续被打断的 Goal：用户点一下「继续」才重新起跑。 */
      case "goal.resume": {
        if (!uEng || typeof uEng._pendingGoals !== "function") break;
        const cid = m.convId || uEng._currentConv || "default";
        const hit = uEng._pendingGoals().find((p) => p.convId === cid);
        if (!hit) { ws.send(JSON.stringify({ type: "term.line", text: "[Goal] 这个会话没有被打断的目标可继续。", cls: "tl-warn" })); break; }
        if (uEng.runningConvs.has(cid)) { uEng._queueChat(cid, "【Goal】继续推进未完成的目标。", { convId: cid }); break; }
        broadcast({ type: "goal.resumed", convId: cid, turns: hit.turns }, msgKey);
        uEng.handleChat("【Goal 续跑 · 上次被进程退出打断，已跑 " + hit.turns + " 轮】目标：" + uEng._goal
          + "\n先核对上几轮已经改过/验过的部分，别重复劳动，然后继续推进到完成。", { convId: cid });
        break;
      }
      case "goal.clear": {
        if (!uEng) break;
        uEng._goal = null; uEng._saveGoal();
        if (uEng._goalState) uEng._goalState[m.convId || uEng._currentConv] = undefined;
        broadcast({ type: "goal.set", goal: null, convId: m.convId || uEng._currentConv }, msgKey);
        break;
      }

      /* /compact：用户主动压缩当前会话上下文（不等水位线到 80%） */
      case "compact.now": {
        if (!uEng || typeof uEng.compactHistory !== "function") break;
        (async () => {
          try {
            const before = Array.isArray(uEng.history) ? uEng.history.slice() : [];
            const after = await uEng.compactHistory(before, { force: true });
            if (Array.isArray(after) && after !== before) {
              const beforePct = Math.round((uEng._ctxUsed(before) || 0) / (uEng._ctxLimit() || 1) * 100);
              uEng.history = after;
              uEng._dropCtxAnchor();
              const afterPct = Math.round((uEng._ctxUsed(after) || 0) / (uEng._ctxLimit() || 1) * 100);
              if (ws.readyState === 1) ws.send(JSON.stringify({ type: "term.line", text: "[Agent] 已按你的要求手动压缩上下文（水位 " + beforePct + "% → " + afterPct + "%）", cls: "tl-info" }));
            } else if (ws.readyState === 1) {
              /* 别把三种不同的原因糊成一句"已关闭"：compactHistory 压不动时会先落一条原因
                 （摘要没生成 / 摘要不比原文短），这里只负责指过去。 */
              ws.send(JSON.stringify({ type: "term.line", text: "[Agent] 没有换掉任何历史：原因见上面一条（自动压缩已关闭 / 可压区太小 / 本次压不动）", cls: "tl-warn" }));
            }
          } catch (e) {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "term.line", text: "[Agent] 压缩失败：" + e.message, cls: "tl-err" }));
          }
        })();
        break;
      }

      case "term.exec": {
        const tabId = m.tabId || "default";
        if (typeof m.cmd === "string" && m.cmd.trim() && !term.busyFor(tabId)) {
          // C-H2：WS 手敲终端路径按 AI 严档执行（sudo/系统目录写入/全局安装/批量删除等拦截），
          // 与 terminal.js:118 AI 内部路径的 strict 语义对齐。
          term.run(tabId, m.cmd.slice(0, 500), null, { strict: true }).then(() => {
            snapshotFiles().then((files2) => broadcast({ type: "fs.sync", files: files2 }));
            uEng.pushChanges(false);
          });
        }
        break;
      }
      case "term.open":
        if (typeof m.tabId === "string" && m.tabId) term.open(m.tabId, m.title || "");
        break;
      case "term.close":
        if (typeof m.tabId === "string" && m.tabId) term.close(m.tabId);
        break;
      case "term.kill":
        term.kill(typeof m.tabId === "string" ? m.tabId : "default");
        break;

      /* ----- 文件操作协议（编辑器可写的核心） ----- */
      /* 用户侧的保存/新建/删除/重命名也压进 /undo 栈（修 C-M1）：原先只有 AI 路径有检查点，
         用户在编辑器里手改的东西一律撤不回来。
         但 _snapshotBefore / _pushCheckpoint 定义在 LlmAgent 上，演示引擎没有这两个方法
         （server/agent-demo.js 只继承 AgentBase）。不认能力就直接调，
         后果是没配 Key 的默认体验里用户每按一次 Ctrl+S 都收到一条「服务内部异常」，
         而且写在调用之后——文件也根本没存下去。 */
      case "file.save":
        safe(() => {
          const snap = userSnaps(uEng, [m.path]);
          files.write(m.path, String(m.content));
          userCheckpoint(uEng, snap, "用户保存 " + m.path);
          codeIndex.queueFileUpdate(WS_DIR, m.path);
          uEng.fileChanged(m.path);
          uEng.pushChanges(false);
          broadcast({ type: "file.saved", path: m.path, seq: m.seq });
        }, ws, m.type);
        break;
      case "file.create":
        safe(() => {
          const snap = userSnaps(uEng, [m.path]);
          files.create(m.path, m.content || "");
          userCheckpoint(uEng, snap, "用户新建 " + m.path);
          codeIndex.queueFileUpdate(WS_DIR, m.path);
          uEng.fileChanged(m.path);
          uEng.pushChanges(false);
          snapshotFiles().then((files2) => broadcast({ type: "fs.sync", files: files2 }));
        }, ws, m.type);
        break;
      case "file.delete":
        safe(() => {
          const snap = userSnaps(uEng, [m.path]);
          files.remove(m.path);
          userCheckpoint(uEng, snap, "用户删除 " + m.path);
          codeIndex.removeFile(WS_DIR, m.path);
          uEng.pushChanges(false);
          snapshotFiles().then((files2) => broadcast({ type: "fs.sync", files: files2 }));
        }, ws, m.type);
        break;
      case "file.rename":
        safe(() => {
          const snap = userSnaps(uEng, [m.path, m.newPath]);
          files.rename(m.path, m.newPath);
          userCheckpoint(uEng, snap, "用户重命名 " + m.path + " → " + m.newPath);
          codeIndex.removeFile(WS_DIR, m.path);
          codeIndex.queueFileUpdate(WS_DIR, m.newPath);
          uEng.pushChanges(false);
          snapshotFiles().then((files2) => broadcast({ type: "fs.sync", files: files2, renamed: { from: m.path, to: m.newPath } }));
        }, ws, m.type);
        break;
      case "file.mkdir":
        safe(() => {
          files.mkdir(m.path);
          snapshotFiles().then((files2) => broadcast({ type: "fs.sync", files: files2 }));
        }, ws, m.type);
        break;

      case "search":
        safe(() => {
          const results = files.search(String(m.query || ""), 200);
          ws.send(JSON.stringify({ type: "search.result", query: m.query, results }));
        }, ws, m.type);
        break;

      case "reset":
        safe(() => {
          // W12：discardAll 已异步化，必须等其真正完成再读快照，否则文件树仍是改动态
          git.discardAll().then(() => {
            uEng.round = 0;
            if (uEng.history) uEng.history = [];
            // 清空当前会话记录的改动（工作区已回退基线）
            if (uEng.convChanges) uEng.convChanges[uEng._currentConv] = [];
            if (typeof uEng.saveConversations === "function") uEng.saveConversations();
            uEng.pushChanges(false);
            broadcast({ type: "term.line", text: "[pancode] 工作区已恢复到基线状态", cls: "tl-info" }, msgKey);
            broadcast({ type: "agent.reset" }, msgKey);
            snapshotFiles().then((files2) => broadcast({ type: "fs.sync", files: files2 }));
          }).catch((e) => log.tag("git").error("reset: discardAll 失败 " + e));
        }, ws, m.type);
        break;

      /* 新建对话：仅清空 AI 对话上下文，不丢弃文件改动 */
      case "newchat":
        safe(() => {
          if (typeof uEng.switchConversation === "function" && m.convId) {
            uEng.switchConversation(String(m.convId));
          }
          // 清空该会话记录的改动（新对话无历史改动）
          if (uEng.convChanges) uEng.convChanges[String(m.convId || uEng._currentConv)] = [];
          // newchat 语义 = 该会话上下文清空（新建会话本就为空；重试场景同 ID 也需清空）
          uEng.round = 0;
          if (uEng.history) uEng.history = [];
          if (typeof uEng.saveConversations === "function") uEng.saveConversations();
          broadcast({ type: "agent.reset" }, msgKey);
          broadcast({ type: "term.line", text: "[pancode] 已开始新对话，AI 上下文已清空（文件改动保留）", cls: "tl-info" }, msgKey);
        }, ws, m.type);
        break;

      /* C6：切换对话 — 把服务端 AI 上下文同步到前端选中的会话 */
      case "switchConv":
        safe(() => {
          if (typeof uEng.switchConversation === "function" && m.convId) {
            uEng.switchConversation(String(m.convId));
            const n = uEng.history ? uEng.history.length : 0;
            ws.send(JSON.stringify({ type: "conv.switched", convId: String(m.convId), messages: n }));
            // 同步切换该会话记录的改动清单，前端改动面板一并切换
            const cl = (uEng.convChanges && uEng.convChanges[String(m.convId)]) || [];
            ws.send(JSON.stringify({
              type: "changes", list: cl, convId: String(m.convId),
              risk: (uEng.convRisk && uEng.convRisk[String(m.convId)]) || null,
            }));
          }
        }, ws, m.type);
        break;

      /* C6：删除对话 — 同步清理服务端上下文，避免残留占用 */
      case "dropConv":
        safe(() => {
          if (typeof uEng.dropConversation === "function" && m.convId) {
            uEng.dropConversation(String(m.convId));
          }
        }, ws, m.type);
        break;

      /* 中断当前 Agent 运行 */
      case "abort":
        safe(() => {
          if (typeof uEng.abort === "function") {
            uEng.abort(m.convId);
            broadcast({ type: "term.line", text: "[pancode] Agent 已中断", cls: "tl-warn" }, msgKey);
            broadcast({ type: "agent.state", running: false, label: "AI 空闲", convId: m.convId }, msgKey);
            broadcast({ type: "agent.done", round: uEng.round, convId: m.convId }, msgKey);
          }
        }, ws, m.type);
        break;

      /* ----- 人工确认：AI 工具的写/删/执行需用户批准（审批队列按用户隔离） ----- */
      case "tool.approve":
        if (typeof uEng.resolveApproval === "function" && m.id) uEng.resolveApproval(m.id, true);
        // 「本会话内都允许」：记住这次批准的工具，后续同名工具不再逐次询问（不可逆操作不受影响）
        if (m.remember === "session" && m.tool && typeof uEng.grantSession === "function") uEng.grantSession(m.tool);
        break;
      case "tool.reject":
        if (typeof uEng.resolveApproval === "function" && m.id) uEng.resolveApproval(m.id, false);
        break;

      /* ----- 交互式选项列表：用户选择方案后回传 ----- */
      case "tool.choice_result":
        if (typeof uEng.resolveChoice === "function" && m.id) uEng.resolveChoice(m.id, m.choice || null);
        break;

      /* ----- 补丁审阅：用户在 diff 视图逐文件「接受 / 拒绝」（补丁队列按用户隔离） ----- */
      case "patch.approve":
        safe(() => {
          const convId = m.convId || uEng._currentConv;
          const paths = Array.isArray(m.paths) ? m.paths : [];
          const { applied, conflicts, failed } = typeof uEng.applyPatch === "function"
            ? uEng.applyPatch(convId, paths, m.hunks) : { applied: [], conflicts: [], failed: [] };
          if (applied.length || conflicts.length || (failed && failed.length)) {
            // 增量同步：只发 applied 路径，避免大工作区全量读盘
            snapshotFilesIncremental(applied).then((files2) => broadcast({ type: "fs.sync", files: files2, incremental: true }));
            broadcast({ type: "patch.applied", paths: applied, convId, conflicts, failed: failed || [] }, msgKey);
          } else {
            broadcast({ type: "patch.applied", paths: [], convId, empty: true }, msgKey);
          }
        }, ws, m.type);
        break;
      case "patch.reject":
        safe(() => {
          const convId = m.convId || uEng._currentConv;
          const paths = Array.isArray(m.paths) ? m.paths : [];
          if (typeof uEng.rejectPatch === "function") uEng.rejectPatch(convId, paths);
          broadcast({ type: "patch.rejected", paths, convId, all: !paths.length }, msgKey);
        }, ws, m.type);
        break;

      /* 点计划条目打勾：前端一直发这条，但服务端从没接 —— 于是勾是画上去的，
         刷新后按服务端为准又弹回未勾。落到 PlanStore 再把新状态推回去（同一份 plan 引用）。 */
      case "update_plan_task":
        safe(() => {
          if (!uEng.plan || typeof uEng.plan.updateTask !== "function") return;
          const idx = Number(m.taskIdx);
          const status = String(m.status || "");
          if (!Number.isInteger(idx) || ["pending", "in_progress", "done", "skipped"].indexOf(status) < 0) return;
          const convId = m.convId || uEng._currentConv;
          const plan = uEng.plan.updateTask(m.planId, idx, status, m.note);
          if (plan) broadcast({ type: "plan.updated", plan, convId }, msgKey);
        }, ws, m.type);
        break;
    }
  });
});

/* 长任务保活：WebSocket 协议层心跳
   为什么必需：TCP 半开（休眠唤醒、代理静默丢包、杀软断链、VPN 切换）时 ws.readyState 仍是 1，
   而 broadcast 只看 readyState → 每个事件都"发送成功"却无人收到，前端永远停在"AI 思考中"，
   表现为"跑几分钟就卡住/断了"。浏览器会自动应答协议层 ping，所以只要链路真活着必回 pong；
   连续两轮（约 40s）未回即判定链路已死，terminate() 触发前端 onclose → 指数退避重连 →
   hello 携带 running/round/tabs 恢复现场，正在跑的 Agent 任务不受影响（它在服务端继续）。 */
const WS_PING_MS = Math.max(500, Number(process.env.PANCODE_WS_PING_MS) || 20000);
const wsHeartbeat = setInterval(() => {
  for (const c of Array.from(wss.clients)) {
    if (c.readyState !== 1) { clients.delete(c); continue; }
    if (c._alive === false) {
      clients.delete(c);
      try { c.terminate(); } catch (e) {}
      continue;
    }
    c._alive = false;
    try { c.ping(); } catch (e) { clients.delete(c); try { c.terminate(); } catch (_) {} }
  }
}, WS_PING_MS);
wsHeartbeat.unref();   // 不阻止进程退出（优雅关闭路径无需等待心跳）

/* A7：清理上次异常退出遗留的原子写临时文件。
   原实现只认根目录一个模式 /^pancode\.config\.json\.\d+\.tmp$/，
   而 atomicWrite 的临时名是 "<目标名>.<pid>.tmp"（server/safe-write.js:22），
   凡是走 safe-write 的落盘点都会留孤儿——实测 .pancode/{skills,memory,
   progression,automations/*} 下就有一批，压根不会被这个正则碰到。
   现在交给 safe-write 的通用清扫：递归 + 按 pid 判活，
   另一个还在跑的 pancode 实例正在用的 .tmp 不会被误删。 */
function cleanupTmpOrphans() {
  try {
    const sw = require("./safe-write");
    // 配置目录与 .pancode 全树都扫：前者是配置落盘，后者是记忆/技能/进度/自动化
    const targets = [configMod.ROOT, path.join(configMod.ROOT, ".pancode")];
    let removed = 0, kept = 0;
    for (const t of targets) {
      if (!fs.existsSync(t)) continue;
      const r = sw.sweepTmpOrphans(t);
      removed += r.removed.length; kept += r.kept.length;
    }
    if (removed) log.tag("boot").info("清理残留临时文件 " + removed + " 个" + (kept ? "（另有 " + kept + " 个属于仍在运行的进程，保留）" : ""));
    else if (kept) log.tag("boot").info(kept + " 个临时文件属于仍在运行的进程，保留");
  } catch (e) { log.tag("boot").warn("清理残留临时文件失败 " + e); }
}
cleanupTmpOrphans();

/* 截图目录按 TTL 清理 —— 与对话历史同一做法：只删超期的，不做"看起来没用了就删"的推断。
   不接这一步的话 shotsTtlDays 就只是个写在配置里的数字，而浏览器/桌面任务每轮都能产几十张图。 */
function cleanupShots() {
  try {
    const shots = require("./computer/shots");
    const r = shots.prune((configMod.load().computer || {}).shotsTtlDays);
    if (r.removed) log.tag("boot").info("清理超期截图 " + r.removed + " 张（保留 " + ((configMod.load().computer || {}).shotsTtlDays || shots.DEFAULT_TTL_DAYS) + " 天内）");
  } catch (e) { log.tag("boot").warn("清理截图目录失败 " + e); }
}
cleanupShots();

server.listen(cfg.port, "127.0.0.1", () => {
  const info = configMod.publicInfo(cfg);
  // 这四行是给人看的开机横幅，刻意不进日志器：日志行一律带时间戳和级别前缀，
  // 横幅要的是"打开终端一眼看清服务起在哪、挂的是哪个目录"，加了前缀反而难读。
  console.log("pancode v" + VERSION + " 已启动: http://localhost:" + cfg.port);
  console.log("workspace: " + WS_DIR);
  const gi = git.info();
  console.log("Git: " + (gi.git ? ("已启用（基线 = HEAD" + (gi.sub ? "，工作区在仓库的 " + gi.sub + " 子目录" : "") + "）") : "未启用（基线 = 启动快照）"));
  console.log("Agent 引擎: " + (info.mode === "llm" ? "真实 LLM（" + info.model + "）" : "内置演示引擎（配置 API Key 后自动切换真实 LLM）"));
  // 启动已启用的 MCP 服务器（非阻塞：按服务器响应速度异步就绪，不影响主流程）
  try { mcpManager.connectAll(); } catch (e) { log.tag("mcp").warn("初始化失败 " + e); }
});

/* 优雅关闭：中止 Agent → 杀终端子进程 → 关 WS → 停 watch → 关 HTTP，避免孤儿进程 / 端口残留 */
function shutdown(sig) {
  log.tag("boot").info("收到 " + sig + "，正在优雅关闭…");
  // 多用户：中止 + 刷盘所有用户引擎（默认 engine 也在 userEngines 里，anon key）
  for (const eng of userEngines.values()) {
    try { if (eng && typeof eng.abort === "function") eng.abort(); } catch (e) {}
    try { if (eng && typeof eng.flushConversations === "function") eng.flushConversations(); } catch (e) {}
  }
  try { if (term && typeof term.closeAll === "function") term.closeAll(); } catch (e) {}      // 杀掉全部终端子进程，避免孤儿
  try { auth.flushSessions(); } catch (e) {}                        // 会话同步落盘：合并窗里没来得及写的登录态不能随进程丢
  try { usageStore.flush(); } catch (e) {}   // 用量账本自己有 5s 合并窗，退出前把最后这一笔推下去（面板"今天花了多少"不能少一段）
  try { if (mcpManager) mcpManager.disconnectAll(); } catch (e) {}   // 关闭全部 MCP 子进程，避免孤儿
  try { for (const c of wss.clients) { try { c.close(); } catch (e) {} } } catch (e) {}
  try { if (files) files.stopWatch(); } catch (e) {}
  /* 桌面控制的常驻 PowerShell 不会自己走：worker 是子进程，父进程直接 exit 就会留孤儿，
     而它持有 UIA 引用缓存与 ref 序号，下一次开机看到的"上一个进程的窗口"会全是废 ref。 */
  try { require("./computer/uia-worker").stop("服务退出"); } catch (e) {}
  try { server.close(() => process.exit(0)); } catch (e) { process.exit(0); }
  setTimeout(() => process.exit(0), 3000).unref();   // 兜底：3s 内未退出则强制退出
}

/* A3：全局兜底——未捕获的 Promise 拒绝 / 异常不再直接杀死进程，记日志并广播给前端 */
function logFatal(where, err) {
  try {
    const msg = (err && err.stack) ? err.stack : String(err);
    const reqId = log.newReqId();
    /* 堆栈进结构化上下文而不是正文：正文要保持一行可读，
       而这条堆栈是这次崩溃事后唯一剩下的东西（/api/logs 里按 reqId 就能捞到）。 */
    log.tag("fatal").withReqId(reqId).error(where + ": " + (err && err.message ? err.message : String(err)), { stack: msg });
    broadcast({ type: "op.error", error: "服务内部异常（" + where + "），已自动恢复；reqId=" + reqId + "，可在诊断面板「服务日志」里查到这一条。", reqId });
  } catch (e) {}
}
process.on("unhandledRejection", (reason) => logFatal("unhandledRejection", reason));
process.on("uncaughtException", (err) => logFatal("uncaughtException", err));

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/* 桌面端在同一进程里 require 本文件（electron/main.js），托盘菜单的「退出并终止所有任务」
   需要一个能显式收口的入口：中止各用户引擎、刷盘会话、杀终端/MCP 子进程，再退出。
   没有它，app.quit() 只是让进程消失，落盘全凭运气。 */
/* 桌面主进程（electron/main.js）与后端同进程，这几个入口是给它直接调的，别改回 HTTP：
   /api/tasks 在登录闸门后面，而主进程手里没有 userToken——以前它每 3 秒轮一次一直吃 401，
   结果是托盘状态行永远报"没有任务在跑"、任务收口的系统通知从来没弹出来过（窗口挂着后台也没用）。 */
const readTaskRows = () => { try { return taskBoard ? taskBoard.snapshot(null) : []; } catch (e) { return []; } };
module.exports = {
  shutdown,
  getTaskBoard: () => taskBoard,
  taskRows: readTaskRows,
  desktopPref: () => (cfg.desktop && cfg.desktop.closeAction) || "ask",
  setDesktopPref: (v) => { try { return configMod.saveDesktop(cfg, { closeAction: v }).closeAction; } catch (e) { return ""; } },
  workspaceDir: () => WS_DIR,
  /* 托盘「复制诊断信息」的数据源。日志环是内存的（刻意不落盘，重启即空），
     所以出问题后要趁进程还活着抄走 —— 这也是内测阶段唯一能把"我这崩了"变成可查证据的路径。
     注意 tasks 里带的是用户指令的前 80 字：复制出来的文本会含它，文案里要提醒一句。 */
  diagSnapshot: () => {
    let logs = [];
    try { logs = log.readRing({ limit: 150, level: "warn" }) || []; } catch (e) { logs = []; }
    let engine = null;
    try { engine = configMod.publicInfo(cfg); } catch (e) { engine = null; }
    return {
      version: VERSION, apiStamp: API_STAMP, workspace: WS_DIR,
      wsClients: clients.size, engine, tasks: readTaskRows(), logs,
    };
  },
};
