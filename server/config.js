/* ============================================================
   pancode 配置中心
   优先级：环境变量 > pancode.config.json > 默认值
   - LLM 配置可在运行时通过 UI 修改并持久化到配置文件
   - 无 API Key 时自动降级到演示引擎（产品可开箱即用）
   ============================================================ */
"use strict";
const fs = require("fs");
const log = require("./logger");
const path = require("path");
const wsKey = require("./ws-key");
const { setEnvVar } = require("./dotenv");
const { saveJson, hasPending } = require("./safe-write");

// 数据根：打包态(__dirname 落在只读 app.asar)必须指向可写目录，由桌面端 main.js 注入 PANCODE_DATA_DIR(=userData)
const ROOT = process.env.PANCODE_DATA_DIR || path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "pancode.config.json");

/* 探针护栏：带"我在跑测试"的标记（AGENT_FAST / CURSORWEB_ENGINE=demo，产品路径一个都不设，实测）
   却没换数据根 → 直接拒启。
   理由不是洁癖：这种组合会往真实的 .pancode 里写探针账号、按 TTL 删真实对话、落测试用的索引分片，
   而且全程一声不吭。宁可启动即失败，也不让"探针绿了、开发者的数据没了"这种事再发生一次。 */
if (!process.env.PANCODE_DATA_DIR && (process.env.AGENT_FAST === "1" || process.env.CURSORWEB_ENGINE === "demo")) {
  throw new Error(
    "探针护栏：这是探针启动（AGENT_FAST/CURSORWEB_ENGINE=demo）但没设 PANCODE_DATA_DIR——它会把账号、会话、索引写进真实数据根 " +
    ROOT + "。请 require('./scripts/_sandbox').create({ tag: \"…\" })，或显式指定一个临时 PANCODE_DATA_DIR。"
  );
}

/* permissions.mode 的唯一合法取值。写在这里而不是只写在注释里，是为了让"配错了"这件事
   在落盘前就被拦下 —— 非法 mode 存进去之后不会报错，只会让权限语义静默退化。 */
const PERMISSION_MODES = ["ask", "semi", "auto"];

const DEFAULTS = {
  port: 8766,
  workspace: "workspace",
  recentWorkspaces: [],   // 最近打开过的文件夹（绝对路径）
  /* 长任务的两条命门（判据在 server/agent-llm.js 的看门狗里）：
       agentStallMs = 连续多久毫无进展才算卡死；agentMaxMs = 单任务最长墙钟兜底。
     默认 6 分钟 / 8 小时。以前这里只有墙钟一条、且默认 30 分钟，注释还写着"可配"而配置里
     根本没有这一项 —— 等于任何跑满半小时的任务必被掐死，"跑七八小时"是设计上进不去的。 */
  agentStallMs: 6 * 60 * 1000,
  agentMaxMs: 8 * 60 * 60 * 1000,
  llm: {
    baseURL: "",          // 例如 https://api.openai.com/v1 或任何 OpenAI 兼容网关
    apiKey: "",
    model: "gpt-4o-mini",
    temperature: 0.2,
    maxToolRounds: 100,   // 单次任务最多工具调用轮数
    contextWindow: 128000, // 模型真实上下文窗口（tokens）：上下文进度条分母 + 自动压缩依据，按所用模型调整
    // 输出预留（tokens）：窗口是 input+output 共享的，自动压缩只能让出输入侧，
    // 所以阈值要先从窗口里扣掉"本轮模型最多还要写多少"。不发给上游，纯本地预算量。
    // 留空 = 按窗口 10% 自动取。
    maxOutputTokens: 0,
    // P-M2：推理力度透传（low / medium / high），支持则透传给 LLM 上游
    reasoningEffort: "",
  },
  // 多份模型配置（网关地址 + 模型名）。密钥不进这里，见 profileKeyVar。
  llmProfiles: [],
  // —— Phase 1：Agent 框架 ——
  permissions: {
    mode: "ask",          // ask=全部询问(默认) | semi=半自动(安全操作免确认) | auto=全自动(仅高危硬拦截)
    allow: [],            // 免确认规则（命令子串/正则，或文件 glob），semi/auto 模式生效
    deny: [],             // 强制拦截（命令子串/正则，或文件 glob），所有模式生效
    strictCommand: true,  // W14 沙箱开关：AI 命令启用 strict 黑名单（sudo/全局安装/系统目录写入等）。
                          // 关闭 = 降低防护，AI 可执行这些命令，请自行评估风险
  },
  // W14 hooks：工具执行前拦截规则（deny），覆盖包括 MCP 在内的全部工具
  hooks: {
    // pre: [{ tool: "write_file"（工具名，"*"=全部，省略=全部）, match: "/node_modules/i"（/正则/ 或包含子串，省略=仅按 tool）, action: "deny", reason: "给 AI 的拦截原因" }]
    pre: [],
  },
  planMode: false,        // 规划模式：开启后 Agent 仅可读/检索/规划，禁止任何写文件/执行命令，待用户批准再切回执行
  persona: {
    active: "default",    // default | fullstack | frontend | backend | custom
    systemPrompt: "",     // 自定义人格覆盖（非空时优先于预设）
  },
  rules: { enabled: true },        // 是否加载 .pancode/rules 作为强制约束
  // —— 注册闸门（修 C-B1）——
  // /api/auth/register 是无鉴权入口。已有用户之后还开着自助注册，等于把
  // "注册→拿 token→改配置开 auto→WS 发命令" 这条越权链的大门敞开。
  // 默认 false：第一个账号自助建，之后由管理员登录后在账户管理里加人；
  // 确实要开（比如内网部署要给多个同事发账号）时临时置 true 建完即关。
  allowUserSignup: false,
  context: { budgetTokens: 1000000, autoCompact: true }, // 上下文预算 1M tokens
  memory: { enabled: true },       // auto memory（会话中沉淀记忆）
  // —— 桌面端（Electron）窗口行为 ——
  desktop: {
    // 点标题栏红点 / 系统关闭时要做什么：
    //   ask = 每次问（默认，第一次用会问）| background = 直接挂到后台，任务继续跑 | quit = 直接退出
    // 只有主进程读它（设置界面负责写）；非桌面态（浏览器 / npm start）完全不涉及。
    closeAction: "ask",
    // 硬件加速：on = 交给 Chromium 自检（默认，真桌面 GPU 上动画/模糊才跟得上）；
    // off = 强制软件渲染，虚拟机 / 远程桌面等无 GPU 环境的兼容档（重启生效）。
    gpu: "on",
  },
  // —— 长任务时限（秒）——
  // 这些是"跑不完一次真实构建/测试"的直接来源，默认值按长任务设定，可在 设置 → Agent 行为 里调。
  timeouts: {
    commandSec: 600,    // run_command 前台等待上限；更长的任务应改用 start_process 后台 + read_process 轮询
    approvalSec: 1200,  // 审批/选项卡多久没人处理就自动放弃（默认 20 分钟；期间状态栏持续倒计时提醒）
    toolSec: 120,       // 读类工具的兜底超时；agent / orchestrate 等本身要跑很久的工具不受此约束
  },
  // —— 真实 LSP 桥接（按需 spawn 语言服务器，详见 server/lsp-bridge.js）——
  lsp: {
    enabled: true,
    servers: {},                   // 留空则用 lsp-bridge 内置默认（python 等）
  },
  // —— Token 单价与成本（P1-B4，换算逻辑见 server/cost.js）——
  // 放在 agent 段而不是 llm 段：单价只影响面板显示，不影响任何一次请求，
  // 而存 llm 段会触发 buildEngine() 重建引擎（换 Key 才需要重建）。
  // rates 为空 = 不显示金额，只显示 token —— 猜一个价格打在面板上比留空更糟。
  // 单位：每 100 万 token 的货币额（与供应商标价习惯一致，抄账单不容易错）。
  pricing: {
    enabled: true,
    currency: "CNY",
    rates: [],                     // [{ match:"deepseek-chat", input:2, output:8, currency:"CNY" }]，靠前的先命中
  },
  // —— 轻量代码向量索引（可插拔 embedding；未配置则 BM25 词法兜底）——
  embedding: {
    endpoint: "",                  // OpenAI 兼容 /v1/embeddings，例如 https://api.openai.com/v1
    apiKey: "",
    model: "text-embedding-3-small",
    dim: 1536,
  },
  // —— MCP（Model Context Protocol）外部工具服务器 ——
  // 每个 server：{ name, command, args[], env{}, enabled, cwd? }
  // 仅本地优先开发工具使用；server 以用户当前权限运行，请仅添加可信来源。
  mcp: {
    servers: [],
  },
  // —— 电脑控制与浏览器自动化 ——
  // 浏览器：经随包原生二进制 agent-browser 用 CDP 驱动本机 Chrome/Edge；
  // 桌面：常驻 PowerShell worker 走 UI Automation 读元素树、user32 SendInput 做兜底点击。
  // 两档都能单独关掉；关掉的后果不是"报错"而是对应工具在界面里显示"未启用"并直接把原因回给模型。
  computer: {
    browser: true,            // 浏览器自动化总开关
    desktop: true,            // 电脑控制总开关（非桌面态没有 UIA 进程时自动不可用）
    autoDetectBrowser: true,  // 自动探测本机 Chrome/Edge，避免首字等待去下载 150MB 的 Chrome for Testing
    chromePath: "",           // 留空 = 自动探测；显式指定优先级最高
    agentBrowserExe: "",      // 留空 = 用随包二进制；已全局装过 agent-browser 的可指向那份
    allowedDomains: [],       // 非空 = 只允许访问这些域名（agent-browser 侧的硬约束，不是提示模型别去）
    headed: false,            // true = 显示浏览器窗口（用户能看着它操作）；默认无头且跑在私有 desktop，不会往桌面盖窗口
    shotsTtlDays: 7,          // 截图目录保留天数，开机按 TTL 清理（与对话历史同一做法）
    snapshotMaxChars: 12000,  // 交给模型的页面文本上限；超长按头尾收口并落盘
  },
};

/* 读配置。⚠ 不能只读盘：`saveJson` 是排队异步落盘的（Windows 被杀软/句柄锁住时还要退避重试到 ~10s），
   而每个 saveX 都是"读盘 → 只改自己那一段 → 整份写回"。于是同一秒里连着存两个段时，
   第二次读到的是**还没落盘的旧内容**，会把第一次那段整段抹回去
   （实测：先存 permissions 再存 desktop，permissions 就没了）。
   解法：给"刚写出去、盘上还没追上"的内容做一层读回缓存。
   判据是 safe-write 的在途写队列（hasPending），其次才是 mtime——
   只比 mtime 不够：Windows 时间戳粒度粗，同一毫秒内的两次写会落进"盘看起来不比缓存新"的
   比较盲区，实测就是这条测试在全量跑时随机失败（permissions 被 desktop 抹掉）。
   外部改了文件（盘 mtime 明确新于我们最后一次写）时仍然以盘为准。 */
const _recent = new Map();     // 绝对路径 -> { obj, at }
function readJsonSafe(p) {
  const key = path.resolve(p);
  const r = _recent.get(key);
  /* 队列里还压着这份文件的写没落盘时，盘上那份**一定**是旧的——直接回内存。
     早先只比 mtime（st.mtimeMs < r.at），可 Windows 的时间戳粒度粗、
     同一毫秒里"入队 + 上一次那份文件恰好在同一毫秒写下"就会让比较落进 false 分支，
     于是读到旧内容再整份写回，把上一段抹掉（permissions 就是这么丢的）。
     判"有没有在途写"是 safe-write 的事实源，不比时间戳猜。 */
  if (r && hasPending(p)) return JSON.parse(JSON.stringify(r.obj));
  try {
    const st = fs.statSync(p);
    if (r && st.mtimeMs <= r.at) return JSON.parse(JSON.stringify(r.obj));
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (r) { try { return JSON.parse(JSON.stringify(r.obj)); } catch (e2) { return null; } }
    return null;
  }
}

/* 皮实的配置写入（W7 补漏 · P1）：
   同步直写/tmprename 在杀软持续锁定下会全链失败（实测 EPERM 连发）→
   转发 safe-write 队列：按路径串行 + 异步指数退避重试 6 次（~10.9s），不阻塞事件循环、永不抛错。
   语义为 best-effort 持久化：进程内 cfg 对象仍是事实源（读盘仅在启动），调用点零改动。 */
function writeJsonSafe(p, obj) {
  try { _recent.set(path.resolve(p), { obj, at: Date.now() }); } catch (e) {}
  saveJson(p, obj);   // fire-and-forget：队列串行 + 退避重试，失败仅 safe-write 内部告警
  return true;
}

function deepMerge(base, extra) {
  const out = Object.assign({}, base);
  for (const k in extra) {
    if (extra[k] && typeof extra[k] === "object" && !Array.isArray(extra[k])) {
      out[k] = deepMerge(base[k] || {}, extra[k]);
    } else if (extra[k] !== undefined && extra[k] !== null) {
      out[k] = extra[k];
    }
  }
  return out;
}

function load() {
  let cfg = deepMerge(DEFAULTS, readJsonSafe(CONFIG_PATH) || {});
  // 环境变量最高优先级
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.CURSORWEB_WORKSPACE) cfg.workspace = process.env.CURSORWEB_WORKSPACE;
  if (process.env.OPENAI_BASE_URL) cfg.llm.baseURL = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_API_KEY) cfg.llm.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_MODEL) cfg.llm.model = process.env.OPENAI_MODEL;
  // 注册闸门可由环境变量临时开窗（内网多人部署要用），但默认仍是关闭
  if (process.env.PANCODE_ALLOW_SIGNUP === "1") cfg.allowUserSignup = true;
  // W8：agentMode 为行为模式真源；兼容旧 planMode（planMode=true → agentMode=plan）
  cfg.agentMode = (cfg.agentMode === "agent" || cfg.agentMode === "plan" || cfg.agentMode === "ask") ? cfg.agentMode : (cfg.planMode ? "plan" : "agent");
  cfg.planMode = (cfg.agentMode === "plan");
  return cfg;
}

/* 把 UI 提交的 LLM 设置持久化。
   安全约定：apiKey 永不写入配置文件（明文入库 = 泄露风险），只存于运行时内存 + 本地 .env（已被 .gitignore 忽略）。
   baseURL / model 等非敏感项才写入 pancode.config.json。 */
/* 存下来的一律是「基地址」：最常见的误填是把补全接口的完整路径（…/v1/chat/completions）粘进来，
   拼请求时就成了 …/chat/completions/chat/completions，表现正是"配置填好了却拉不到模型、一问就报错"。 */
function normalizeBaseURL(v) {
  return String(v || "").trim().replace(/\/+$/, "").replace(/\/(chat\/completions|completions|responses|embeddings)$/i, "");
}
function saveLlm(cfg, patch) {
  const baseURL = typeof patch.baseURL === "string" ? normalizeBaseURL(patch.baseURL) : undefined;
  const apiKey = typeof patch.apiKey === "string" ? patch.apiKey.trim() : undefined;
  const model = typeof patch.model === "string" ? patch.model.trim() : undefined;
  if (baseURL !== undefined) cfg.llm.baseURL = baseURL;
  if (apiKey !== undefined) { cfg.llm.apiKey = apiKey; setEnvVar("OPENAI_API_KEY", apiKey); }
  if (model !== undefined) cfg.llm.model = model;
  if (patch.maxToolRounds !== undefined) {
    const n = Number(patch.maxToolRounds);
    if (Number.isInteger(n) && n >= 5 && n <= 500) cfg.llm.maxToolRounds = n;
  }
  if (patch.contextWindow !== undefined) {
    const w = Number(patch.contextWindow);
    if (Number.isFinite(w) && w >= 4096 && w <= 2000000) cfg.llm.contextWindow = Math.round(w);
  }
  // 输出预留：0/空 = 按窗口 10% 自动取（与 agent-llm 的 _compactSpec 同一口径）。
  // 它只影响本地压缩预算（阈值 = 窗口 - 预留 - headroom），不发给上游，所以上限放宽到半个窗口。
  if (patch.maxOutputTokens !== undefined) {
    const n = Number(patch.maxOutputTokens);
    if (Number.isFinite(n) && n >= 0) cfg.llm.maxOutputTokens = Math.min(Math.round(n), Math.round((cfg.llm.contextWindow || 128000) * 0.5));
  }
  // P-M2：reasoningEffort 白名单校验
  if (patch.reasoningEffort !== undefined) {
    const RE = ["", "low", "medium", "high", "xhigh"];
    if (RE.includes(String(patch.reasoningEffort))) cfg.llm.reasoningEffort = String(patch.reasoningEffort);
  }
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.llm = { baseURL: cfg.llm.baseURL, model: cfg.llm.model, maxToolRounds: cfg.llm.maxToolRounds, contextWindow: cfg.llm.contextWindow, maxOutputTokens: cfg.llm.maxOutputTokens, reasoningEffort: cfg.llm.reasoningEffort };
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
}

/* ---------- 多份模型配置（profile） ----------
   与 apiKey 同一口径：非敏感项（网关地址 / 模型名 / 窗口 / 轮次）进 pancode.config.json，
   每份配置自己的密钥进本地 .env 的 PANCODE_LLM_KEY_<id>，绝不明文写进配置文件。 */
function profileKeyVar(id) {
  return "PANCODE_LLM_KEY_" + String(id || "").replace(/[^0-9a-zA-Z]/g, "").slice(0, 24).toUpperCase();
}
function profilePublic(p) {
  const key = process.env[profileKeyVar(p.id)] || "";
  return {
    id: p.id, name: p.name, baseURL: p.baseURL, model: p.model,
    contextWindow: p.contextWindow, maxToolRounds: p.maxToolRounds, maxOutputTokens: p.maxOutputTokens,
    hasKey: !!key, keyTail: key ? "…" + key.slice(-4) : "",
  };
}
function saveLlmProfiles(cfg, list) {
  const out = (Array.isArray(list) ? list : []).slice(0, 20).map((p) => ({
    id: String(p.id || "").slice(0, 32),
    name: String(p.name || "").trim().slice(0, 40),
    baseURL: String(p.baseURL || "").trim().slice(0, 300),
    model: String(p.model || "").trim().slice(0, 120),
    contextWindow: Number(p.contextWindow) > 0 ? Math.round(Number(p.contextWindow)) : undefined,
    maxToolRounds: Number(p.maxToolRounds) > 0 ? Math.round(Number(p.maxToolRounds)) : undefined,
    maxOutputTokens: Number(p.maxOutputTokens) >= 0 ? Math.round(Number(p.maxOutputTokens)) : undefined,
  })).filter((p) => p.id && p.name && p.baseURL);
  cfg.llmProfiles = out;
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.llmProfiles = out;
  writeJsonSafe(CONFIG_PATH, onDisk);
  return out;
}
/* 把当前运行时参数存成一份新配置（或按 id 覆盖已有的一份）；apiKey 只在显式给了的时候写 .env */
function upsertLlmProfile(cfg, body) {
  const list = (cfg.llmProfiles || []).slice();
  const id = String(body.id || "").slice(0, 32) || "p" + Date.now().toString(36);
  const patch = {
    id,
    name: String(body.name || "").trim() || (cfg.llm.baseURL ? cfg.llm.baseURL.replace(/^https?:\/\//, "").slice(0, 28) : "未命名"),
    baseURL: String(body.baseURL != null ? body.baseURL : cfg.llm.baseURL).trim(),
    model: String(body.model != null ? body.model : cfg.llm.model).trim(),
    contextWindow: Number(body.contextWindow || cfg.llm.contextWindow) || undefined,
    maxToolRounds: Number(body.maxToolRounds || cfg.llm.maxToolRounds) || undefined,
    maxOutputTokens: Number(body.maxOutputTokens != null ? body.maxOutputTokens : cfg.llm.maxOutputTokens) >= 0
      ? Math.round(Number(body.maxOutputTokens != null ? body.maxOutputTokens : cfg.llm.maxOutputTokens)) : undefined,
  };
  const i = list.findIndex((p) => p.id === id);
  if (i >= 0) list[i] = patch; else list.push(patch);
  saveLlmProfiles(cfg, list);
  // 没显式给 Key 时，把当前运行时那份 Key 一起归到这条配置名下：切回来才不用重新粘贴
  const key = (typeof body.apiKey === "string" && body.apiKey.trim()) ? body.apiKey.trim() : (cfg.llm.apiKey || "");
  if (key) setEnvVar(profileKeyVar(id), key);
  return profilePublic(patch);
}
function applyLlmProfile(cfg, id) {
  const p = (cfg.llmProfiles || []).find((x) => x.id === String(id));
  if (!p) return null;
  saveLlm(cfg, { baseURL: p.baseURL, model: p.model, contextWindow: p.contextWindow, maxToolRounds: p.maxToolRounds, maxOutputTokens: p.maxOutputTokens });
  const key = process.env[profileKeyVar(p.id)] || "";
  if (key) { cfg.llm.apiKey = key; setEnvVar("OPENAI_API_KEY", key); }
  return { ok: true, profile: profilePublic(p), hasKey: !!key };
}
function removeLlmProfile(cfg, id) {
  const list = (cfg.llmProfiles || []).filter((p) => p.id !== String(id));
  saveLlmProfiles(cfg, list);
  setEnvVar(profileKeyVar(id), "");
  return list;
}

/* 把「打开的文件夹」持久化为新的默认工作区，并记入最近列表 */
function saveWorkspace(cfg, absDir) {
  cfg.workspace = absDir;
  const recent = (cfg.recentWorkspaces || []).filter((p) => p !== absDir);
  recent.unshift(absDir);
  cfg.recentWorkspaces = recent.slice(0, 8);
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.workspace = absDir;
  onDisk.recentWorkspaces = cfg.recentWorkspaces;
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
}

/* 持久化 Agent 框架设置（权限/人格/规则/上下文/记忆）。
   直接写入 pancode.config.json（均为非敏感配置）。 */
function saveAgentSettings(cfg, patch) {
  const p = patch || {};
  if (p.permissions) {
    /* mode 白名单：以前只判 typeof === "string"，于是 "asdf"、"ask "、中文"全自动" 都能存进来。
       落到 _approvalDecision 时非法值既不匹配 auto 也不匹配 semi，最终落到 :1737 的 ask 分支
       —— 也就是说不会放松防护（这点是对的），真正的问题是**用户的意图被静默丢弃**：
       配完显示保存成功，实际跑的是 ask 档，没有任何地方告诉他"你填的值没生效"。
       所以宁可丢弃非法值（保留磁盘上的原值 + 落一条 warn），也不要假装收下了。 */
    if (PERMISSION_MODES.includes(p.permissions.mode)) cfg.permissions.mode = p.permissions.mode;
    else if (p.permissions.mode !== undefined) {
      log.tag("config").warn("忽略非法的 permissions.mode=" + JSON.stringify(p.permissions.mode) + "，只接受 " + PERMISSION_MODES.join("/"));
    }
    if (Array.isArray(p.permissions.allow)) cfg.permissions.allow = p.permissions.allow.filter(Boolean).map(String);
    if (Array.isArray(p.permissions.deny)) cfg.permissions.deny = p.permissions.deny.filter(Boolean).map(String);
    if (typeof p.permissions.strictCommand === "boolean") cfg.permissions.strictCommand = p.permissions.strictCommand;
  }
  /* 长任务预算：非法值一样要吭一声，不许静默收下（同 permissions.mode 的口径） */
  for (const [k, lo, hi] of [["agentStallMs", 60000, 60 * 60000], ["agentMaxMs", 5 * 60000, 48 * 3600000]]) {
    if (p[k] === undefined) continue;
    const n = Number(p[k]);
    if (Number.isFinite(n) && n >= lo && n <= hi) cfg[k] = Math.round(n);
    else log.tag("config").warn("忽略非法的 " + k + "=" + p[k] + "（允许 " + lo + "–" + hi + " 毫秒）");
  }
  if (p.hooks && typeof p.hooks === "object" && Array.isArray(p.hooks.pre)) {
    cfg.hooks.pre = p.hooks.pre
      .filter((h) => h && typeof h === "object" && h.action === "deny")
      .map((h) => ({
        tool: typeof h.tool === "string" ? h.tool.slice(0, 64) : "",
        match: typeof h.match === "string" ? h.match.slice(0, 300) : "",
        action: "deny",
        reason: typeof h.reason === "string" ? h.reason.slice(0, 200) : "",
      }));
  }
  if (p.persona) {
    if (typeof p.persona.active === "string") cfg.persona.active = p.persona.active;
    if (typeof p.persona.systemPrompt === "string") cfg.persona.systemPrompt = p.persona.systemPrompt;
  }
  if (p.rules && typeof p.rules.enabled === "boolean") cfg.rules.enabled = p.rules.enabled;
  if (p.context) {
    if (Number.isFinite(p.context.budgetTokens)) cfg.context.budgetTokens = Math.max(8000, p.context.budgetTokens | 0);
    if (typeof p.context.autoCompact === "boolean") cfg.context.autoCompact = p.context.autoCompact;
  }
  if (p.memory && typeof p.memory.enabled === "boolean") cfg.memory.enabled = p.memory.enabled;
  if (typeof p.planMode === "boolean") cfg.planMode = p.planMode;
  if (p.agentMode === "agent" || p.agentMode === "plan" || p.agentMode === "ask") { cfg.agentMode = p.agentMode; cfg.planMode = (p.agentMode === "plan"); }
  if (p.lsp && typeof p.lsp.enabled === "boolean") cfg.lsp.enabled = p.lsp.enabled;
  /* 单价表。整表替换（与 mcp.servers 一样：前端提交的就是最终形状），
     但每一行都要过清洗：match 空、价格负数、价格不是数字的行直接丢——
     留一行坏数据等于让 costOf 命中它然后算出 NaN，面板显示 "¥NaN"。 */
  if (p.pricing && typeof p.pricing === "object") {
    const pr = p.pricing;
    const money = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1e7 ? Number(v) : null);
    if (typeof pr.enabled === "boolean") cfg.pricing.enabled = pr.enabled;
    if (typeof pr.currency === "string" && /^[A-Za-z]{1,8}$/.test(pr.currency.trim())) cfg.pricing.currency = pr.currency.trim().toUpperCase();
    if (Array.isArray(pr.rates)) {
      cfg.pricing.rates = pr.rates.slice(0, 40)
        .filter((r) => r && typeof r === "object" && typeof r.match === "string" && r.match.trim())
        .map((r) => {
          const row = { match: r.match.trim().slice(0, 80) };
          const i = money(r.input), o = money(r.output);
          if (i != null) row.input = i;
          if (o != null) row.output = o;
          if (typeof r.currency === "string" && /^[A-Za-z]{1,8}$/.test(r.currency.trim())) row.currency = r.currency.trim().toUpperCase();
          return row;
        });
    }
  }
  if (p.timeouts) {
    const t = p.timeouts;
    const cl = (v, lo, hi, fb) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : fb);
    if (t.commandSec !== undefined) cfg.timeouts.commandSec = cl(t.commandSec, 15, 7200, cfg.timeouts.commandSec);
    if (t.approvalSec !== undefined) cfg.timeouts.approvalSec = cl(t.approvalSec, 30, 7200, cfg.timeouts.approvalSec);
    if (t.toolSec !== undefined) cfg.timeouts.toolSec = cl(t.toolSec, 15, 3600, cfg.timeouts.toolSec);
  }

  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.permissions = cfg.permissions;
  onDisk.hooks = cfg.hooks;
  onDisk.planMode = cfg.planMode;
  onDisk.agentMode = cfg.agentMode;
  onDisk.persona = cfg.persona;
  onDisk.rules = cfg.rules;
  onDisk.context = cfg.context;
  onDisk.memory = cfg.memory;
  onDisk.lsp = cfg.lsp;
  onDisk.pricing = cfg.pricing;
  onDisk.timeouts = cfg.timeouts;
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
}

/* 持久化 Embedding 配置（代码向量索引用） */
/* 桌面端窗口偏好。写它的有两个入口，都必须走这里，别开第二条落盘路径：
   ① 设置界面（/api/config 的 section=desktop）；② 关窗对话框里勾了"记住我的选择"的主进程。
   只认三个值，其它一律不改（防止把配置写成不可识别的状态）。 */
function saveDesktop(cfg, patch) {
  const v = String((patch && patch.closeAction) || "");
  const ALLOWED = ["ask", "background", "quit"];
  if (ALLOWED.indexOf(v) < 0) return cfg.desktop;
  cfg.desktop = Object.assign({}, cfg.desktop, { closeAction: v });
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.desktop = cfg.desktop;
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg.desktop;
}

/* 电脑控制 / 浏览器自动化的偏好。只认这一组键，且逐键验类型 ——
   这一段的值直接决定"AI 能不能动你的鼠标、能不能开浏览器"，
   写成 undefined 或字符串 "false"（在 `!== false` 的判断里等于"开"）都不能接受。 */
function saveComputer(cfg, patch) {
  const p = patch || {};
  const cur = Object.assign({}, DEFAULTS.computer, cfg.computer || {});
  const BOOLS = ["browser", "desktop", "autoDetectBrowser", "headed"];
  for (const k of BOOLS) if (typeof p[k] === "boolean") cur[k] = p[k];
  const STRS = ["chromePath", "agentBrowserExe"];
  for (const k of STRS) if (typeof p[k] === "string") cur[k] = p[k].trim().slice(0, 500);
  if (Array.isArray(p.allowedDomains)) {
    cur.allowedDomains = p.allowedDomains.map((d) => String(d).trim().toLowerCase().replace(/[^a-z0-9._:-]/g, "").slice(0, 120))
      .filter(Boolean).slice(0, 50);
  }
  if (Number.isFinite(p.shotsTtlDays)) cur.shotsTtlDays = Math.min(365, Math.max(1, p.shotsTtlDays | 0));
  if (Number.isFinite(p.snapshotMaxChars)) cur.snapshotMaxChars = Math.min(200000, Math.max(500, p.snapshotMaxChars | 0));
  cfg.computer = cur;
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.computer = cur;
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cur;
}

function saveEmbedding(cfg, patch) {
  const p = patch || {};
  if (typeof p.endpoint === "string") cfg.embedding.endpoint = p.endpoint.trim();
  if (typeof p.apiKey === "string") { cfg.embedding.apiKey = p.apiKey.trim(); if (p.apiKey.trim()) setEnvVar("PANCODE_EMBEDDING_KEY", p.apiKey.trim()); }
  if (typeof p.model === "string") cfg.embedding.model = p.model.trim();
  if (Number.isFinite(p.dim)) cfg.embedding.dim = Math.max(1, p.dim | 0);
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.embedding = { endpoint: cfg.embedding.endpoint, model: cfg.embedding.model, dim: cfg.embedding.dim };
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
}

/* 给前端的 Embedding 配置（脱敏） */
function embeddingInfo(cfg) {
  return {
    endpoint: cfg.embedding.endpoint || "",
    model: cfg.embedding.model || "text-embedding-3-small",
    dim: cfg.embedding.dim || 1536,
    hasKey: !!cfg.embedding.apiKey,
    keyTail: cfg.embedding.apiKey ? "…" + cfg.embedding.apiKey.slice(-4) : "",
  };
}

/* 给前端的 Agent 设置（脱敏，可编辑字段原样返回） */
function agentSettings(cfg) {
  return {
    permissions: cfg.permissions,
    hooks: cfg.hooks,
    planMode: cfg.planMode,
    agentMode: cfg.agentMode,
    persona: cfg.persona,
    rules: cfg.rules,
    context: cfg.context,
    memory: cfg.memory,
    lsp: cfg.lsp,
    pricing: cfg.pricing,
    timeouts: cfg.timeouts,
  };
}

/* 持久化 MCP 服务器配置（写入 pancode.config.json 的 mcp.servers）。
   patch.servers 为完整数组（增删改由前端提交整表），我们做基本清洗：
   仅保留含 name + command 的条目，sanitize name，enabled 默认 true。 */
function saveMcpServers(cfg, patch) {
  const incoming = (patch && Array.isArray(patch.servers)) ? patch.servers : [];
  const clean = incoming
    .filter((s) => s && typeof s.name === "string" && s.name.trim() && typeof s.command === "string" && s.command.trim())
    .map((s) => ({
      name: s.name.trim(),
      command: s.command.trim(),
      args: Array.isArray(s.args) ? s.args.map(String) : (typeof s.args === "string" ? s.args.split(/\s+/).filter(Boolean) : []),
      env: (s.env && typeof s.env === "object") ? s.env : {},
      enabled: s.enabled !== false,
      cwd: typeof s.cwd === "string" ? s.cwd : undefined,
    }));
  cfg.mcp = cfg.mcp || { servers: [] };
  cfg.mcp.servers = clean;
  const onDisk = readJsonSafe(CONFIG_PATH) || {};
  onDisk.mcp = { servers: clean };
  writeJsonSafe(CONFIG_PATH, onDisk);
  return cfg;
}

/* 当前引擎模式：有 key + baseURL 就用真实 LLM，否则演示引擎
   CURSORWEB_ENGINE=demo 可强制演示引擎（测试用，保证确定性） */
function engineMode(cfg) {
  if (process.env.CURSORWEB_ENGINE === "demo") return "demo";
  return cfg.llm.apiKey && cfg.llm.baseURL ? "llm" : "demo";
}

/* 给前端看的脱敏信息 */
function publicInfo(cfg) {
  const mode = engineMode(cfg);
  return {
    mode,
    model: mode === "llm" ? cfg.llm.model : "内置演示引擎",
    baseURL: cfg.llm.baseURL,
    hasKey: !!cfg.llm.apiKey,
    keyTail: cfg.llm.apiKey ? "…" + cfg.llm.apiKey.slice(-4) : "",
    maxToolRounds: cfg.llm.maxToolRounds,
    contextWindow: cfg.llm.contextWindow,
    maxOutputTokens: cfg.llm.maxOutputTokens,
    agentMode: cfg.agentMode,
  };
}

/* 项目级分片路径：全部走 ws-key 的唯一键（md5(规范化绝对路径)），
   老键由 ws-key 在缺席时改名迁移、冲突时原样保留并上报。 */
function wsShard(cfg) {
  return wsKey.forWorkspace(path.resolve(ROOT, (cfg && cfg.workspace) || "workspace"), ROOT);
}
function memoryPath(cfg) {
  return wsShard(cfg).file(path.join(ROOT, ".pancode", "memory"));
}
/* 项目规则目录（loadRules 从此读取 *.md 强制注入到系统提示词） */
function rulesDir() { return path.join(ROOT, ".pancode", "rules"); }
/* 项目 Skill 文件路径 */
function skillPath(cfg) {
  return wsShard(cfg).file(path.join(ROOT, ".pancode", "skills"));
}
/* 项目灵魂(Soul)文件路径 — 与记忆/技能同算法、同工作区哈希 */
function soulPath(cfg) {
  return wsShard(cfg).file(path.join(ROOT, ".pancode", "soul"));
}
/* 项目进度(进化路线)文件路径 — 与记忆/技能/灵魂同算法、同工作区哈希 */
function progressionPath(cfg) {
  return wsShard(cfg).file(path.join(ROOT, ".pancode", "progression"));
}

module.exports = { load, saveLlm, saveWorkspace, saveAgentSettings, saveMcpServers, saveEmbedding, saveDesktop, saveComputer, agentSettings, embeddingInfo, engineMode, publicInfo, memoryPath, skillPath, soulPath, progressionPath, rulesDir, ROOT, CONFIG_PATH,
  saveLlmProfiles, upsertLlmProfile, applyLlmProfile, removeLlmProfile, profilePublic, normalizeBaseURL, PERMISSION_MODES };
