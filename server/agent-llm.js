/* ============================================================
   pancode 真实 LLM Agent 引擎
   标准 ReAct 工具调用循环：
     LLM 流式输出（思考/回复透传）→ 工具调用 → 结果回填 → 再询问
   工具：list_files / read_file / write_file / delete_file /
         search_code / run_command

   Phase 1 增强：
   - 权限模式（ask / semi / auto）+ allow / deny 规则
   - 多模态附件（图片）+ @file/@folder 提及注入
   - 人格设定（preset / custom）+ .pancode/rules 规则层 + auto memory
   - 上下文预算条 + 接近上限自动压缩

   Phase 2 增强：
   - 结构化长期记忆（MemoryStore）— 按类型/主题存储 + 关键词检索
   - 智能上下文检索（ContextRetriever）— 按相关性注入文件摘要/记忆
   - 自我进化（EvolutionEngine）— 任务完成后自动提取经验教训
   - Skill 系统（SkillStore）— 一类问题的解决方案沉淀为可复用模板
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AgentBase } = require("./agent-base");
const { chatStream } = require("./llm");
const codeIndex = require("./code-index");
const repoMap = require("./repo-map");
const { MemoryStore } = require("./memory-store");
const { SoulStore } = require("./soul-store");
const { ProgressionStore } = require("./progression-store");
const { AI_TERM_TAB } = require("./terminal");
const { computeProgression } = require("./progression");
const { ContextRetriever } = require("./context-retriever");
const { EvolutionEngine } = require("./evolution");
const { SkillStore } = require("./skill-store");
const { PlanStore } = require("./plan-store");
const safeWrite = require("./safe-write");
const { PatchEngine } = require("./patch");

/* C6 会话持久化参数 */
const CONV_MAX = 20;          // 最多保留 20 个对话（与内存 LRU 上限一致）
const CONV_MAX_MSGS = 80;     // 单个对话落盘时最多保留最近 80 条消息
const CONV_SAVE_DEBOUNCE = 600; // 落盘防抖（ms）

/* OpenAI 兼容工具定义：供 LLM 做 function calling（ReAct 工具调用循环） */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出工作区当前所有文件（相对路径）。用于先了解项目结构，再决定读取哪些文件。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取指定文件的完整内容。path 为相对工作区的路径，如 src/app.js。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "要读取的文件相对路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "创建或覆盖写入完整文件内容（不是补丁）。改动会由系统按当前权限模式向用户确认。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要写入的文件相对路径" },
          content: { type: "string", description: "文件的完整内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_edit",
      description: "以「搜索/替换片段」方式修改已存在文件（首选编辑方式，比整文件覆盖更精准、更安全）。" +
        "提供 path + edits（数组，每项含 old_string 与 new_string），或 path + old_string + new_string 做单处修改。" +
        "old_string 必须是文件中「逐字且唯一」的片段；新建/重写整个文件时 old_string 留空。也可以用 patch 字段传入 Aider 风格的多文件 search/replace 文本块。" +
        "改动会先进入「审阅面板」，用户在 diff 视图逐文件接受/拒绝后才落盘，无需你再次确认。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要修改的文件相对路径（与 edits 或 old_string/new_string 搭配；多文件时用 patch）" },
          edits: { type: "array", items: { type: "object", properties: { old_string: { type: "string" }, new_string: { type: "string" } } }, description: "多处修改：每项 old_string→new_string" },
          old_string: { type: "string", description: "单处修改：被替换的原片段（留空表示整文件新建/重写）" },
          new_string: { type: "string", description: "单处修改：替换后的新片段" },
          patch: { type: "string", description: "Aider 风格多文件 search/replace 文本块（优先级高于上面的字段）" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "删除指定文件（危险操作，需权限确认）。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "要删除的文件相对路径" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "检索工作区代码（语义向量检索优先，未建索引时自动退化为关键词搜索）。用于定位相关函数/类/逻辑片段。query 用自然语言或关键词描述要找的代码。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词或正则" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "在工作区根目录执行一条 shell 命令（如运行测试 / 构建）。危险命令会被安全沙箱拦截。命令语法必须符合当前运行环境" + (process.platform === "win32" ? "（Windows：后台启动用 `start /B`，`&` 只是分隔符不是后台；用 findstr/type/dir 替代 grep/cat/ls）" : "（bash）") + "。",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "要执行的命令，如 node tests/run.js" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_map",
      description: "生成整个工作区的「符号地图」：列出每个源码文件及其顶层函数 / 类 / 接口 / 常量与所在行号。用于在动手前快速建立代码库全景、定位应该读哪些文件。无需参数。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "search_symbol",
      description: "按名字检索工作区内的符号定义（函数 / 类 / 接口 / 方法），返回 文件:行号 名称。比全文 grep 更精准。query 为符号名（支持子串，如 handleChat / Agent）。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "要检索的符号名或子串，如 FileStore" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_memory",
      description: "搜索项目长期记忆，获取过去任务中积累的经验教训、用户偏好、决策约定等。用于参考历史经验指导当前任务。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词，如 '排序 bug'、'用户偏好'" },
          type: { type: "string", description: "过滤类型：preference/lesson/pattern/decision/error/skill（可选）" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_skill",
      description: "将当前任务的解决方案沉淀为可复用的 Skill 模板，供未来类似问题自动匹配参考。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill 名称，如 'React 组件性能优化'" },
          description: { type: "string", description: "一句话描述" },
          trigger: { type: "string", description: "触发关键词（逗号分隔）" },
          body: { type: "string", description: "Skill 内容（Markdown 格式，包含解决方案和验证方法）" },
        },
        required: ["name", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_plan",
      description: "面对复杂任务时创建执行计划，拆解为多个子任务并逐步推进。用户会实时看到进度。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "计划标题，如 '实现用户认证模块'" },
          tasks: { type: "array", items: { type: "string" }, description: "任务步骤列表，如 ['设计数据模型', '实现注册接口', '添加测试']" },
        },
        required: ["title", "tasks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_plan",
      description: "更新计划中某个任务的状态。每个任务完成/跳过时调用，用户会实时看到进度更新。",
      parameters: {
        type: "object",
        properties: {
          taskIndex: { type: "number", description: "任务序号（从0开始）" },
          status: { type: "string", description: "in_progress=开始执行, done=已完成, skipped=跳过" },
          note: { type: "string", description: "备注（可选），如 '已创建3个文件'" },
        },
        required: ["taskIndex", "status"],
      },
    },
  },
];

/* 规划模式（planMode）下禁止 Agent 调用的"会改动工作区 / 执行命令"工具 */
const MUTATING_TOOLS = new Set(["write_file", "apply_edit", "delete_file", "run_command"]);

/* 运行环境提示：注入 SYSTEM_PROMPT，避免 agent 用错平台的 shell 语法
   （Windows cmd 无 `&` 后台符 / grep / cat，用 start /B、findstr、type；路径分隔符为 \） */
const PLATFORM_HINT = process.platform === "win32"
  ? "【运行环境】当前是 Windows，shell = cmd.exe。命令必须用 Windows 语法：后台启动用 `start /B`（`&` 在 cmd 里只是分隔符不是后台）；没有 `grep`/`cat`/`ls`/`&&`，用 `findstr`/`type`/`dir`/`&`；路径用 `\\`；跨平台命令（node/npm/git 等）可直接用。运行 JS 用 `node`。"
  : "【运行环境】当前是 Linux/macOS，shell = bash。命令用 POSIX 语法（`&` 后台、`grep`/`cat`/`ls` 均可用）。";

const SYSTEM_PROMPT = `你是 pancode Agent，一个在真实项目工作区中自主编程的 AI。
${PLATFORM_HINT}

工作准则：
1. 动手前先用 list_files / read_file / repo_map 了解项目，不要凭空假设文件内容。
2. 修改「已存在」的文件一律用 apply_edit（传递 path + edits 做片段替换，old_string 必须逐字且唯一；整文件新建/重写时 old_string 留空）。新建一个此前不存在的文件才用 write_file。
   改完同一个文件后若要再改，继续追加 edits 到同一 apply_edit 调用，不要用 write_file 整文件覆盖。
3. 每次有意义的修改之后，必须用 run_command 运行测试或程序验证，失败就继续修复，直到通过或确认无法解决。
4. 写文件 / 删除文件 / 执行命令等操作会由系统代为向用户请求确认（取决于当前权限模式），你正常调用工具即可，无需自行询问用户；若被拒绝，换更安全的方案或停止。
5. 全程用简体中文回复。最终答复请总结：做了什么改动、如何验证的、结果如何。
6. run_command 的命令在工作区根目录执行；运行 JS 用 node，禁止执行危险命令（rm -rf /、格式化磁盘等）。
7. 面对复杂任务（涉及 3 个以上步骤），先用 create_plan 拆解为子任务计划，然后用 update_plan 逐个标记进度，用户会在侧边栏实时看到进展。
8. 上下文中如果出现【相关 Skill】，说明系统已匹配到可参考的解决方案模板，请参考其中的步骤和验证方法来指导你的工作。
9. 执行 run_command 时，务必先确认命令语法符合当前【运行环境】——Windows 下后台启动用 start /B，不要用 `&` 结尾试图后台化；没有 grep/cat/ls 就用 findstr/type/dir。

安全准则（必须严格遵守）：
- 禁止修改或删除 .env、.git、node_modules、package-lock.json 等关键文件。
- 禁止执行 rm -rf、format、del /f /s /q 等批量删除命令。
- 禁止向外部发送数据（curl POST 到外部地址、wget 上传等）。
- 禁止修改文件权限或创建可执行脚本到系统目录。
- 涉及密钥/密码/token 的代码，只使用环境变量引用，不硬编码。
- 执行命令前评估风险，高危操作（删除、覆盖、安装）必须通过权限确认。
- 每次写入文件前确认路径在工作区内，防止路径穿越攻击。`;

/* 人格预设：role + 风格/价值观/侧重。default 不额外追加（SYSTEM_PROMPT 已是通用全栈口吻）。 */
const PERSONAS = {
  fullstack: "你是一位资深全栈工程师，习惯前后端协同思考：改动 API 时同步考虑契约、错误码与前端调用；优先复用现有模块，保持接口一致。",
  frontend: "你是一位注重设计与体验的前端工程师，重视视觉还原、可访问性（a11y）、组件化与交互细节；偏好语义化标签与清晰的状态管理。",
  backend: "你是一位严谨的后端工程师，重视健壮性、可观测性、错误处理与安全防护（输入校验、鉴权、日志）；改动先评估边界与失败路径。",
};

class LlmAgent extends AgentBase {
  constructor(ctx) {
    super(ctx);
    this.cfg = ctx.cfg;                 // 全局配置（引用，可热更新）
    this.history = [];                  // 当前对话历史（切换时保存/恢复）
    this.conversations = new Map();     // convId -> { history, round, changes }
    this.convChanges = {};              // convId -> 该会话改动的文件清单（按会话记录显示）
    this._currentConv = "default";      // 当前活跃对话 ID
    this._abort = false;                // 中断标志
    this.pending = new Map();           // 等待用户确认的工具调用 id -> { resolve, timer }
    this._apSeq = 0;
    this._memPath = null;
    this._repoDirty = false;        // 仓库索引失效标记（文件变更后置位）
    this._repoCache = null;         // 缓存的仓库符号索引
    this.patch = new PatchEngine(this.files);   // 补丁暂存/审阅引擎（apply_edit 工具使用）

    /* Phase 2：4 大子系统初始化 */
    const wsHash = crypto.createHash("md5")
      .update(path.resolve(require("./config").ROOT, ctx.cfg.workspace || "workspace"))
      .digest("hex");
    const memDir = path.join(require("./config").ROOT, ".pancode", "memory");
    const skillDir = path.join(require("./config").ROOT, ".pancode", "skills");
    this.memory = new MemoryStore(path.join(memDir, wsHash + ".json"));
    const marketDir = path.join(require("./config").ROOT, ".pancode", "skills", "market");
    this.skills = new SkillStore(marketDir, path.join(skillDir, wsHash + ".json"));
    const planDir = path.join(require("./config").ROOT, ".pancode", "plans");
    this.plan = new PlanStore(path.join(planDir, wsHash + ".json"));
    this.contextRetriever = new ContextRetriever(this.memory, this.files);
    this.evolution = new EvolutionEngine(this.memory);
    const soulDir = path.join(require("./config").ROOT, ".pancode", "soul");
    this.soul = new SoulStore(path.join(soulDir, wsHash + ".json"));
    const progDir = path.join(require("./config").ROOT, ".pancode", "progression");
    this.progression = new ProgressionStore(path.join(progDir, wsHash + ".json"));

    /* C6：会话上下文磁盘持久化（跨进程重启恢复 AI 记忆） */
    const convDir = path.join(require("./config").ROOT, ".pancode", "conversations");
    this._convPath = path.join(convDir, wsHash + ".json");
    this._convSaveTimer = null;
    this._loadConversations();
  }

  /* ---------------- C6：会话上下文落盘 / 恢复 ---------------- */

  /* 启动时从磁盘恢复全部对话上下文，并激活上次活跃对话 */
  _loadConversations() {
    try {
      if (!fs.existsSync(this._convPath)) return;
      const raw = JSON.parse(fs.readFileSync(this._convPath, "utf8"));
      const list = Array.isArray(raw && raw.conversations) ? raw.conversations : [];
      for (const c of list) {
        if (!c || !c.id || !Array.isArray(c.history)) continue;
        this.conversations.set(String(c.id), {
          history: c.history,
          round: Number(c.round) || 0,
          ts: Number(c.ts) || Date.now(),
          changes: Array.isArray(c.changes) ? c.changes : [],
        });
        if (Array.isArray(c.changes)) this.convChanges[String(c.id)] = c.changes;
      }
      // 恢复上次活跃对话为当前上下文
      const cur = raw && raw.current ? String(raw.current) : "";
      if (cur && this.conversations.has(cur)) {
        const saved = this.conversations.get(cur);
        this._currentConv = cur;
        this.history = saved.history;
        this.round = saved.round;
      }
      if (list.length) {
        console.log("[pancode] 已恢复 " + list.length + " 个对话上下文" +
          (this.history.length ? "（当前 " + this.history.length + " 条消息）" : ""));
      }
    } catch (e) {
      console.warn("[pancode] 会话上下文恢复失败:", e.message);
    }
  }

  /* 把当前 history 快照回 conversations Map（不落盘） */
  _snapshotCurrent() {
    if (!this._currentConv) return;
    this.conversations.set(this._currentConv, {
      history: this.history,
      round: this.round,
      ts: Date.now(),
      changes: (this.convChanges && this.convChanges[this._currentConv]) || [],
    });
  }

  /* 防抖落盘：序列化时裁剪单会话消息数与总会话数，避免文件无限膨胀 */
  _persistConversations() {
    clearTimeout(this._convSaveTimer);
    this._convSaveTimer = setTimeout(() => {
      try {
        const entries = [...this.conversations.entries()].slice(-CONV_MAX);
        const conversations = entries.map(([id, v]) => ({
          id,
          round: v.round || 0,
          ts: v.ts || Date.now(),
          history: Array.isArray(v.history) ? v.history.slice(-CONV_MAX_MSGS) : [],
          changes: Array.isArray(v.changes) ? v.changes : [],
        })).filter((c) => c.history.length);
        safeWrite.saveJson(this._convPath, {
          v: 1,
          updated: Date.now(),
          current: this._currentConv || "default",
          conversations,
        });
      } catch (e) {
        console.warn("[pancode] 会话上下文落盘失败:", e.message);
      }
    }, CONV_SAVE_DEBOUNCE);
    if (this._convSaveTimer.unref) this._convSaveTimer.unref();
  }

  /* 快照 + 落盘（对外统一入口） */
  saveConversations() {
    this._snapshotCurrent();
    this._persistConversations();
  }

  /* 进程退出前同步刷盘：防抖定时器来不及触发时兜底 */
  flushConversations() {
    clearTimeout(this._convSaveTimer);
    this._convSaveTimer = null;
    try {
      this._snapshotCurrent();
      const entries = [...this.conversations.entries()].slice(-CONV_MAX);
      const conversations = entries.map(([id, v]) => ({
        id,
        round: v.round || 0,
        ts: v.ts || Date.now(),
        history: Array.isArray(v.history) ? v.history.slice(-CONV_MAX_MSGS) : [],
        changes: Array.isArray(v.changes) ? v.changes : [],
      })).filter((c) => c.history.length);
      if (!conversations.length) return;
      safeWrite.atomicWrite(this._convPath, JSON.stringify({
        v: 1,
        updated: Date.now(),
        current: this._currentConv || "default",
        conversations,
      }, null, 2));
    } catch (e) {
      console.warn("[pancode] 会话上下文刷盘失败:", e.message);
    }
  }

  /* ---------- 任务完成后：提议灵魂(Soul)微调（写入待确认区，需用户确认） ---------- */
  async proposeSoul(llmChatFn, llmCfg, history, taskTopic) {
    if (!history || history.length < 2) return null;
    const soul = this.soul.get();
    const taskSummary = history.slice(-10).map((m) => {
      if (m.role === "user") return "用户: " + (typeof m.content === "string" ? m.content : "").slice(0, 200);
      if (m.role === "assistant") return "AI: " + (typeof m.content === "string" ? m.content : "").slice(0, 300);
      return "";
    }).filter(Boolean).join("\n");

    const prompt = `你是 Agent 的「灵魂演进器」。基于本次任务，判断是否需要微调 Agent 的灵魂（人格/价值观/边界/原则）。
当前灵魂：
- 价值观: ${soul.values.join("; ")}
- 边界: ${soul.boundaries.join("; ")}
- 原则: ${soul.principles.join("; ")}

任务过程：
${taskSummary}

如果本次任务揭示了新的、值得长期遵循的价值观/边界/原则，或某条现有原则需要修正，才输出提案。否则输出"无"。
输出格式（最多 1 条）：
[target] 内容 | 理由
其中 target 只能是 values / boundaries / principles。`;

    try {
      const r = await llmChatFn(llmCfg, [
        { role: "system", content: "你负责让 Agent 的灵魂随任务演进。只输出一条提案或'无'，不要解释。" },
        { role: "user", content: prompt },
      ]);
      const text = (r.content || "").trim();
      if (!text || text === "无") return null;
      const m = text.match(/^\[(values|boundaries|principles)\]\s*(.+?)\s*\|\s*(.+)$/);
      if (!m) return null;
      return this.soul.addProposal({ target: m[1], content: m[2].trim(), reason: m[3].trim() });
    } catch (e) {
      return null;
    }
  }

  /* 仓库索引：按需构建 + 文件变更时失效缓存 */
  _repoIndex() {
    if (this._repoDirty || !this._repoCache) {
      this._repoCache = repoMap.buildRepoIndex(this.files);
      this._repoDirty = false;
    }
    return this._repoCache;
  }

  /* 文件变更 → 失效仓库索引缓存（重写基类以加缓存失效） */
  fileChanged(rel) {
    this._repoDirty = true;
    super.fileChanged(rel);
  }

  /* ---------------- 多对话管理 ---------------- */
  switchConversation(convId) {
    const next = convId || "default";
    if (next === this._currentConv) return;   // 同一对话，无需切换（避免误清空）
    if (this._currentConv && this.history.length) {
      this._snapshotCurrent();
      // LRU 上限 20，防止长跑内存只增不减（A4）
      if (this.conversations.size > CONV_MAX) {
        const oldest = this.conversations.keys().next().value;
        if (oldest && oldest !== this._currentConv) this.conversations.delete(oldest);
      }
    }
    this._currentConv = next;
    const saved = this.conversations.get(this._currentConv);
    this.history = saved ? saved.history : [];
    this.round = saved ? saved.round : 0;
    this._abort = false;
    this._persistConversations();   // C6：切换即落盘，进程被强杀也不丢
  }

  /* 删除某个对话的服务端上下文（前端删除会话时同步调用） */
  dropConversation(convId) {
    if (!convId) return;
    this.conversations.delete(String(convId));
    delete this.convChanges[String(convId)];
    if (this._currentConv === String(convId)) { this.history = []; this.round = 0; }
    this._persistConversations();
  }

  abort() {
    this._abort = true;
    this.running = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ approved: false, reason: "用户中断" });
    }
    this.pending.clear();
  }

  /* 用户在审阅面板「接受」暂存改动 → 写盘并广播变更。
     hunkSelections = { path: [hunkIndex,...] } 时仅应用选中的片段（逐 hunk 部分应用）。 */
  applyPatch(convId, paths, hunkSelections) {
    const applied = this.patch.apply(convId, paths, hunkSelections);
    for (const p of applied) {
      this.fileChanged(p);                 // 触发前端编辑器内容刷新
      this.emit({ type: "editor.open", path: p });
    }
    this.pushChanges(false);               // 更新 SCM / 状态栏改动数
    return applied;
  }

  /* 用户在审阅面板「拒绝」暂存改动 */
  rejectPatch(convId, paths) {
    return this.patch.reject(convId, paths);
  }

  /* ---------------- 权限决策 ---------------- */
  _matchRule(text, rules) {
    if (!rules || !rules.length || !text) return false;
    const t = String(text);
    for (const r of rules) {
      if (!r) continue;
      if (r.length >= 2 && r.startsWith("/") && r.endsWith("/")) {
        try { if (new RegExp(r.slice(1, -1), "i").test(t)) return true; } catch (e) {}
      } else if (t.toLowerCase().includes(r.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /* 返回 { action: "allow" | "ask" | "block", reason } */
  _approvalDecision(toolName, args) {
    const perm = this.cfg.permissions || { mode: "ask", allow: [], deny: [] };
    const mode = perm.mode || "ask";
    const allow = perm.allow || [];
    const deny = perm.deny || [];
    let subject = "";
    if (toolName === "run_command") subject = String(args.command || "");
    else if (toolName === "write_file" || toolName === "delete_file") subject = String(args.path || "");

    if (this._matchRule(subject, deny)) return { action: "block", reason: "命中拒绝规则" };
    if (toolName === "read_file" || toolName === "list_files" || toolName === "search_code") return { action: "allow" };

    if (mode === "auto") return { action: "allow" };
    if (mode === "semi") {
      if (toolName === "run_command") return this._matchRule(subject, allow) ? { action: "allow" } : { action: "ask" };
      // 写 / 删：命中 allow 也放行，否则仍询问
      return this._matchRule(subject, allow) ? { action: "allow" } : { action: "ask" };
    }
    return { action: "ask" }; // ask
  }

  async _gate(toolName, args, danger) {
    const dec = this._approvalDecision(toolName, args);
    if (dec.action === "block") return { blocked: true, reason: dec.reason };
    if (dec.action === "allow") return { blocked: false, approved: true };
    const ap = await this.requestApproval(toolName, args, danger);
    return { blocked: false, approved: ap.approved, reason: ap.reason };
  }

  /* 请求人工确认：emit tool.pending 并等待前端 approve/reject（超时 120s 自动拒绝） */
  requestApproval(toolName, args, danger) {
    const id = "ap" + (++this._apSeq);
    const preview = this._previewArgs(toolName, args);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ approved: false, reason: "等待确认超时（120s），已自动拒绝" });
      }, 120000);
      this.pending.set(id, { resolve, timer });
      this.emit({ type: "tool.pending", id, tool: toolName, danger, preview });
    });
  }

  resolveApproval(id, approved) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve({ approved: !!approved, reason: approved ? "" : "用户已拒绝" });
    return true;
  }

  _previewArgs(toolName, args) {
    if (toolName === "write_file") {
      const c = String(args.content || "");
      return { path: args.path, lines: c.split("\n").length, preview: c.slice(0, 1500) };
    }
    if (toolName === "delete_file") return { path: args.path };
    if (toolName === "run_command") return { command: String(args.command || "").slice(0, 1000) };
    return args;
  }

  personaText() {
    const active = this.cfg.persona && this.cfg.persona.active;
    if (active === "custom") {
      const sp = (this.cfg.persona.systemPrompt || "").trim();
      return sp ? "【人格设定】\n" + sp : "";
    }
    const p = PERSONAS[active];
    return p ? "【人格设定】\n" + p : "";
  }

  loadRules() {
    try {
      const all = this.files.list().map((f) => f.replace(/\\/g, "/"));
      const md = all.filter((f) => f.startsWith(".pancode/rules/") && /\.md$/i.test(f));
      if (!md.length) return "";
      const blocks = md.map((f) => {
        let c = "";
        try { c = this.files.read(f); } catch (e) { return ""; }
        return "## " + f + "\n" + c;
      }).filter(Boolean);
      return blocks.join("\n\n");
    } catch (e) { return ""; }
  }

  buildSystemAugment(userText) {
    const parts = [];
    const persona = this.personaText();
    if (persona) parts.push(persona);
    if (this.cfg.rules && this.cfg.rules.enabled) {
      const r = this.loadRules();
      if (r) parts.push("【项目规则（强制遵循）】\n" + r);
    }
    // 结构化记忆
    if (this.cfg.memory && this.cfg.memory.enabled) {
      const m = this.memory.formatForContext(3000);
      if (m) parts.push("【项目记忆（参考）】\n" + m);
    }
    // 当前任务计划
    const planCtx = this.plan.formatForContext(this._currentConv);
    if (planCtx) parts.push(planCtx);
    // 匹配相关 Skill 并注入
    if (userText) {
      const matched = this.skills.match(userText, 3);
      if (matched.length) {
        parts.push("【相关 Skill（可参考的解决方案模板）】\n" + this.skills.formatForContext(matched));
        for (const s of matched) this.skills.recordUse(s.id);
      }
    }
    if (this.cfg.repoMap !== false) {
      const ov = repoMap.repoOverview(this.files);
      if (ov) parts.push("【仓库结构】\n" + ov);
    }
    // 进化状态反哺 Agent 行为（第一性：进化必须真实改变行为才算进化）
    try {
      const prog = computeProgression({
        soul: this.soul.get(),
        memEntries: this.memory.list({ limit: 1000 }),
        skills: this.skills.list({ limit: 2000 }),
        builtin: [],
        path: this.progression.get().path,
      });
      const bias = this._evolutionBias(prog);
      if (bias) parts.push(bias);
    } catch (e) { /* 进化反哺失败不影响主流程 */ }
    return parts.join("\n\n");
  }

  /* 把进化状态翻译为 Agent 的行为偏好提示 */
  _evolutionBias(prog) {
    if (!prog) return "";
    const lines = [];
    const stageName = (prog.stage && prog.stage.name) || "萌芽";
    lines.push("你当前的进化阶段为「" + stageName + "」（XP " + (prog.xp || 0) + "）。");
    const p = this.progression.get().path;
    if (p === "craftsman") lines.push("你的进化路线是【工匠】：交付前更重视质量与边界检查，做完主动自测并说明如何验证。");
    else if (p === "scholar") lines.push("你的进化路线是【学者】：更重视文档沉淀与知识结构化，把关键决策写入记忆、产出说明文档。");
    else if (p === "companion") lines.push("你的进化路线是【伙伴】：更重视默契与少打扰，优先理解用户意图，减少不必要的追问。");
    if (prog.stage && prog.stage.id >= 2) lines.push("（阶段≥2）你可以自主连续执行多步任务，无需每步停下确认。");
    if (prog.stage && prog.stage.id >= 3) lines.push("（阶段≥3）你可以启用目标驱动模式，持续推进直到目标完成。");
    return lines.length ? "【Agent 进化状态（影响你的行为偏好）】\n" + lines.join("\n") : "";
  }

  /* ---------------- @提及 / 多模态 ---------------- */
  _resolveMentions(text) {
    const blockParts = [];
    const re = /@(file|folder):([^\s]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const kind = m[1], p = m[2];
      if (kind === "file") {
        try {
          const c = this.files.read(p);
          blockParts.push("=== 文件 " + p + " ===\n" + c.slice(0, 8000));
        } catch (e) {
          blockParts.push("=== 文件 " + p + " (读取失败: " + e.message + ") ===");
        }
      } else {
        const prefix = p.replace(/\\/g, "/").replace(/\/$/, "") + "/";
        const list = this.files.list().map((f) => f.replace(/\\/g, "/")).filter((f) => f.startsWith(prefix));
        blockParts.push("=== 目录 " + p + " (" + list.length + " 个文件) ===\n" + list.slice(0, 80).join("\n"));
      }
    }
    const clean = text.replace(/@(file|folder):[^\s]+/g, "").replace(/\n{2,}/g, "\n").trim();
    return { clean: clean || "(见下方引用上下文)", block: blockParts.length ? "【引用上下文】\n" + blockParts.join("\n\n") : "" };
  }

  _buildUserContent(text, attachments) {
    const parts = [];
    if (text && text.trim()) parts.push({ type: "text", text: text.trim() });
    for (const a of attachments || []) {
      if (a && a.src) parts.push({ type: "image_url", image_url: { url: a.src } });
    }
    if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
    return parts;
  }

  /* ---------------- 上下文预算 / 自动压缩 ---------------- */
  _estTokens(messages) {
    let n = 0;
    for (const m of messages) {
      const c = m.content;
      if (typeof c === "string") n += Math.ceil(c.length / 4);
      else if (Array.isArray(c)) for (const p of c) if (p.type === "text") n += Math.ceil((p.text || "").length / 4);
    }
    return n;
  }

  async _summarize(msgs) {
    try {
      const txt = msgs.map((m) => (m.role || "") + ": " + (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n").slice(0, 12000);
      const r = await chatStream(this.cfg.llm,
        [{ role: "system", content: "用中文把以下对话压缩为不超过 200 字的关键要点（保留决策、结论、未决问题），不要解释。" },
         { role: "user", content: txt }], null, null);
      return (r.content || "").trim() || "(无摘要)";
    } catch (e) { return "(摘要生成失败)"; }
  }

  async compactHistory() {
    if (!this.cfg.context || !this.cfg.context.autoCompact) return;
    const budget = (this.cfg.context.budgetTokens) || 1000000;
    const used = this._estTokens(this.history);
    if (used <= budget * 0.85) return;
    // 分阶段压缩：保留最近 10 条 + 摘要
    const keep = 10;
    if (this.history.length <= keep + 2) return;
    const old = this.history.slice(0, this.history.length - keep);
    const recent = this.history.slice(this.history.length - keep);
    const summary = await this._summarize(old);
    this.history = [{ role: "system", content: "[历史摘要] " + summary }, ...recent];
    this.emit({ type: "term.line", text: "[Agent] 上下文已自动压缩（" + Math.round(used/1000) + "k -> " + Math.round(this._estTokens(this.history)/1000) + "k，保留最近 " + keep + " 条）", cls: "tl-info" });
    // 压缩后同时归纳记忆
    if (this.cfg.memory && this.cfg.memory.enabled) {
      this._consolidateMemory(old);
    }
  }

  /* 定期归纳记忆：把多条零散记忆合并为主题摘要，防止记忆爆炸 */
  _consolidateMemory(oldMsgs) {
    try {
      const allMemories = this.memory.list({ limit: 100 });
      if (allMemories.length < 20) return; // 不足 20 条不需要归纳
      // 按主题分组
      const byTopic = {};
      for (const m of allMemories) {
        const key = m.topic || m.type;
        (byTopic[key] = byTopic[key] || []).push(m);
      }
      // 同主题超过 5 条的，合并最早的几条为摘要
      for (const topic in byTopic) {
        const group = byTopic[topic];
        if (group.length < 5) continue;
        const toMerge = group.sort((a, b) => a.ts - b.ts).slice(0, group.length - 2);
        const mergedContent = toMerge.map((m) => m.content).join("；");
        // 删除旧条目，添加合并条目
        for (const m of toMerge) this.memory.remove(m.id);
        this.memory.add(toMerge[0].type, topic, "[归纳] " + mergedContent.slice(0, 300), { source: "consolidate" });
      }
      this.emit({ type: "term.line", text: "[Agent] 记忆已归纳压缩（" + allMemories.length + " 条 -> " + this.memory.size + " 条）", cls: "tl-info" });
    } catch (e) {}
  }

  /* ---------------- auto memory（会话中沉淀，Phase 2：结构化存储） ---------------- */
  _maybeRemember(text) {
    if (!this.cfg.memory || !this.cfg.memory.enabled) return;
    if (!text || text.length > 600) return;
    // 关键词匹配 → 自动分类记忆类型
    let type = "preference";
    let topic = "用户偏好";
    if (/(不对|错了?|错误|纠正|改成|其实|并非)/.test(text)) { type = "lesson"; topic = "经验教训"; }
    else if (/(应该|正确的是|建议|最佳实践|推荐)/.test(text)) { type = "pattern"; topic = "最佳实践"; }
    else if (/(记住|备忘|以后|下次|将来)/.test(text)) { type = "decision"; topic = "决策约定"; }
    else if (/(不要|禁止|不能|不允许|避免)/.test(text)) { type = "preference"; topic = "禁止事项"; }
    const entry = this.memory.add(type, topic, text.replace(/\s+/g, " ").slice(0, 300));
    if (entry) {
      this.emit({ type: "term.line", text: "[Agent] 已将你的偏好记入项目记忆（" + type + "）", cls: "tl-info" });
    }
  }

  /* ---------- 工具实现 ---------- */
  async execTool(name, args) {
    // 规划模式：拦截一切会改动工作区 / 执行命令的工具（仅允许阅读、检索、规划）
    if (this.cfg.planMode && MUTATING_TOOLS.has(name)) {
      const t = this.tool("edit", "规划模式·已拦截", name);
      t.done(false, "规划模式禁止修改", false);
      return "你当前处于「规划模式」：只能阅读、检索代码，并用 create_plan 输出实施计划；不能修改文件或执行命令。请等待用户审阅计划并切回「执行模式」后，改动才会真正落地。";
    }
    switch (name) {
      case "list_files": {
        const t = this.tool("read", "列出文件", "workspace/");
        const list = this.files.list();
        t.body(list.join("\n"));
        t.done(true, list.length + " 个文件");
        return list.join("\n") || "(空工作区)";
      }
      case "read_file": {
        const t = this.tool("read", "读取文件", args.path);
        try {
          const txt = this.files.read(args.path);
          t.body(txt.split("\n").slice(0, 40).join("\n"));
          t.done(true, txt.split("\n").length + " 行");
          return txt;
        } catch (e) { t.done(false, "读取失败"); return "错误: " + e.message; }
      }
      case "write_file": {
        const isNew = !this.files.exists(args.path);
        const gate = await this._gate("write_file", { path: args.path, content: args.content }, isNew ? "high" : "medium");
        if (gate.blocked) {
          const t = this.tool("edit", "创建被拒", args.path); t.done(false, "被拒绝规则拦截", false);
          return "命令被拒绝规则拦截：" + args.path;
        }
        if (!gate.approved) {
          const t = this.tool("edit", isNew ? "创建被拒" : "编辑被拒", args.path);
          t.done(false, "用户拒绝", false);
          return "用户拒绝了" + (isNew ? "创建" : "写入") + "文件：" + args.path + (gate.reason ? "（" + gate.reason + "）" : "");
        }
        const t = this.tool("edit", isNew ? "创建文件" : "编辑文件", args.path);
        try {
          const before = isNew ? "" : this.files.read(args.path);
          this.files.write(args.path, args.content);
          this.fileChanged(args.path);
          this.pushChanges(false);
          const st = require("./agent-base").diffStat(before, args.content);
          t.body((isNew ? "(新文件)\n" : "") + args.content.split("\n").slice(0, 30).join("\n"));
          t.done(true, "+" + st.add + " −" + st.del, false);
          this.emit({ type: "editor.open", path: args.path });
          return "写入成功: " + args.path;
        } catch (e) { t.done(false, "写入失败"); return "错误: " + e.message; }
      }
      case "apply_edit": {
        const t = this.tool("edit", "暂存改动", args.path || "多文件");
        const res = this.patch.stage(this._currentConv, args);
        if (!res.ok) {
          t.done(false, "编辑未应用", false);
          return "编辑未应用：" + res.error + "。请修正 old_string 使其「逐字、唯一且存在于文件中」，然后重试同一处修改。";
        }
        const files = res.staged;
        this.emit({
          type: "patch.review",
          convId: this._currentConv,
          files: files.map((f) => ({
            path: f.path, status: f.status, isNew: f.isNew,
            original: f.original, modified: f.modified, add: f.add, del: f.del,
            hunks: f.hunks,
          })),
        });
        t.body(files.map((f) => f.path + "  (+" + f.add + " −" + f.del + ")").join("\n"));
        t.done(true, "已暂存 " + files.length + " 个文件，待审阅", false);
        return "已暂存 " + files.length + " 处文件改动（" + files.map((f) => f.path).join(", ") +
          "）。这些改动已进入「审阅面板」，请用户在 diff 视图中逐文件「接受」或「拒绝」后再落盘。" +
          "不要对同一个文件改用 write_file 整文件覆盖。";
      }
      case "delete_file": {
        const gate = await this._gate("delete_file", { path: args.path }, "high");
        if (gate.blocked) {
          const t = this.tool("edit", "删除被拒", args.path); t.done(false, "被拒绝规则拦截", false);
          return "命令被拒绝规则拦截：" + args.path;
        }
        if (!gate.approved) {
          const t = this.tool("edit", "删除被拒", args.path);
          t.done(false, "用户拒绝", false);
          return "用户拒绝了删除文件：" + args.path + (gate.reason ? "（" + gate.reason + "）" : "");
        }
        const t = this.tool("edit", "删除文件", args.path);
        try {
          this.files.remove(args.path);
          this.fileChanged(args.path);
          this.pushChanges(false);
          t.done(true, "已删除");
          return "删除成功: " + args.path;
        } catch (e) { t.done(false, "删除失败"); return "错误: " + e.message; }
      }
      case "search_code": {
        const t = this.tool("read", "代码检索", args.query);
        // 优先用向量/BM25 语义索引；未构建则退化为关键词全文搜索
        let txt;
        try {
          const sem = await codeIndex.search({ wsDir: this.files.dir, query: args.query, k: 12 });
          if (sem && sem.ok && sem.results.length) {
            txt = `[语义检索 · ${sem.mode} · ${sem.count} 结果]\n` + sem.results
              .map((r) => `■ ${r.path} (${r.startLine}-${r.endLine}) ${r.title}\n${r.snippet}`)
              .join("\n\n");
          }
        } catch (e) { /* 索引不可用，走兜底 */ }
        if (!txt) {
          const rs = this.files.search(args.query, 50);
          txt = rs.map((r) => r.path + ":" + r.line + ": " + r.text.trim()).join("\n");
          if (txt) txt = "[关键词搜索 · " + rs.length + " 处匹配]\n" + txt;
          else txt = "（无索引也未匹配到关键词）";
        }
        t.body(txt);
        t.done(true, "检索完成");
        return txt;
      }
      case "run_command": {
        const gate = await this._gate("run_command", { command: args.command }, "high");
        if (gate.blocked) {
          const t = this.tool("terminal", "命令被拦截", args.command);
          t.done(false, "被拒绝规则拦截", false);
          return "命令被拒绝规则拦截，未执行：" + args.command;
        }
        if (!gate.approved) {
          const t = this.tool("terminal", "命令被拒", args.command);
          t.done(false, "用户拒绝", false);
          return "用户拒绝了执行命令：" + args.command + (gate.reason ? "（" + gate.reason + "）" : "");
        }
        const t = this.tool("terminal", "运行终端", args.command);
        this.state(true, "AI 正在执行命令");
        const r = await this.term.run(AI_TERM_TAB, args.command, null, { timeout: 90_000, strict: true, ai: true });
        if (r.blocked) {
          t.body("命令被安全沙箱拦截：" + args.command);
          t.done(false, "已拦截", false);
          return "命令被安全沙箱拦截，未执行";
        }
        t.body((r.out || "(无输出)").slice(-4000) + "\n\n(exit code " + r.code + ")");
        t.done(r.code === 0, r.code === 0 ? "退出码 0" : "退出码 " + r.code, r.code !== 0);
        this.pushChanges(false);
        const errHint = r.code !== 0 && process.platform === "win32"
          ? "\n\n提示：当前为 Windows/cmd 环境，请检查命令是否用了 Linux 语法（`&` 后台、`grep`/`cat`/`ls`），应改用 `start /B`、`findstr`/`type`/`dir`。"
          : "";
        return "退出码: " + r.code + "\n输出:\n" + (r.out || "(无输出)").slice(-6000) + errHint;
      }
      case "repo_map": {
        const t = this.tool("read", "生成仓库地图", "repo_map");
        const idx = this._repoIndex();
        const txt = repoMap.formatRepoMap(idx);
        t.body(txt.slice(0, 6000));
        t.done(true, idx.indexedCount + " 文件 / " + idx.symbolCount + " 符号");
        return txt;
      }
      case "search_symbol": {
        const t = this.tool("read", "检索符号", args.query);
        const idx = this._repoIndex();
        const rs = repoMap.searchSymbols(idx, args.query);
        const txt = rs.length
          ? rs.map((r) => r.path + ":" + r.line + "  " + r.kind + " " + r.name).join("\n")
          : "无匹配符号";
        t.body(txt);
        t.done(true, rs.length + " 处匹配");
        return txt;
      }
      case "search_memory": {
        const t = this.tool("read", "搜索记忆", args.query);
        const results = this.memory.search(args.query, { type: args.type, limit: 10 });
        const txt = results.length
          ? results.map((e) => "[" + e.type + "] " + (e.topic ? e.topic + "：" : "") + e.content).join("\n")
          : "无相关记忆";
        t.body(txt);
        t.done(true, results.length + " 条记忆");
        return txt;
      }
      case "create_skill": {
        const t = this.tool("edit", "创建 Skill", args.name);
        const sk = this.skills.add({
          name: args.name,
          description: args.description || "",
          trigger: args.trigger || "",
          body: args.body || "",
        });
        if (sk && !sk._duplicate) {
          t.done(true, "Skill 已创建: " + sk.name);
          return "Skill 创建成功: " + sk.name + " (id: " + sk.id + ")";
        }
        t.done(false, sk && sk._duplicate ? "同名 Skill 已存在" : "创建失败");
        return sk && sk._duplicate ? "同名 Skill 已存在: " + sk.name : "Skill 创建失败";
      }
      case "create_plan": {
        const plan = this.plan.create(this._currentConv, args.title, args.tasks);
        if (plan) {
          this.emit({ type: "plan.created", plan, convId: plan.convId });
          return "计划已创建: " + plan.title + " (" + plan.tasks.length + " 个任务)";
        }
        return "计划创建失败";
      }
      case "update_plan": {
        const active = this.plan.getActive(this._currentConv);
        if (!active) return "没有活跃的计划";
        const plan = this.plan.updateTask(active.id, args.taskIndex, args.status, args.note);
        if (plan) {
          this.emit({ type: "plan.updated", plan, convId: plan.convId });
          const task = plan.tasks[args.taskIndex];
          return "任务 " + (args.taskIndex + 1) + " 状态更新为: " + args.status + (args.note ? " (" + args.note + ")" : "");
        }
        return "任务更新失败";
      }
      default:
        return "未知工具: " + name;
    }
  }

  /* ---------- 主循环 ---------- */
  async handleChat(text, opts) {
    if (this.running) return;
    opts = opts || {};
    const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];
    this._abort = false;

    const { clean, block } = this._resolveMentions(text);
    this._maybeRemember(text);
    this.emit({ type: "user.msg", text });
    this.state(true, "AI 思考中");

    const content = this._buildUserContent(clean + (block ? "\n\n" + block : ""), attachments);
    this.history.push({ role: "user", content });

    await this.compactHistory();
    this.emit({ type: "context.usage", used: this._estTokens(this.history), budget: (this.cfg.context || {}).budgetTokens || 1000000 });

    // 控制上下文长度：最多保留最近 100 条（压缩后通常远低于此）
    if (this.history.length > 100) this.history = this.history.slice(-100);

    // Phase 2：智能上下文检索（替代全量注入）
    const smartCtx = this.contextRetriever.buildSmartContext(clean, { files: this.files });
    const aug = this.buildSystemAugment(clean);
    const messages = [{ role: "system", content: SYSTEM_PROMPT }];
    if (aug) messages.push({ role: "system", content: aug });
    if (smartCtx) messages.push({ role: "system", content: smartCtx });
    // 规划模式：注入只读约束指令，并从可见工具集中移除所有会改动工作区的工具
    if (this.cfg.planMode) {
      messages.push({ role: "system", content: "【规划模式已开启】你当前只能阅读、检索代码，并用 create_plan 输出实施计划。严禁调用 write_file / apply_edit / delete_file / run_command 等任何会改动工作区或执行命令的工具。完成计划后请停止，等待用户审阅并切回执行模式。" });
    }
    const activeTools = this.cfg.planMode ? TOOLS.filter((t) => !MUTATING_TOOLS.has(t.function.name)) : TOOLS;
    for (const h of this.history) messages.push(h);

    let rounds = 0;
    try {
      for (;;) {
        rounds++;
        if (this._abort) { await this.say("已中断"); break; }
        if (rounds > this.cfg.llm.maxToolRounds) {
          await this.say("已达到单任务最大工具调用轮数（" + this.cfg.llm.maxToolRounds + "），先停在这里。如果还需要继续，请再发一条消息。");
          break;
        }

        let tk = null, mg = null;
        let r = null, llmErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            r = await chatStream(this.cfg.llm, messages, activeTools, {
              onReasoning: (d) => { if (!tk) tk = this.thinkStart(); tk.delta(d); },
              onContent: (d) => {
                if (tk) { tk.end(); tk = null; }
                if (!mg) mg = this.msgStart();
                mg.delta(d);
              },
            });
            llmErr = null;
            break;
          } catch (e) {
            llmErr = e;
            if (attempt < 2) {
              const wait = Math.pow(2, attempt) * 5;
              this.emit({ type: "term.line", text: "[Agent] LLM 调用失败（" + e.message.slice(0, 80) + "），第 " + (attempt + 1) + " 次重试，等待 " + wait + " 秒…", cls: "tl-warn" });
              await new Promise((resolve) => setTimeout(resolve, wait * 1000));
            }
          }
        }
        if (llmErr) throw llmErr;
        if (tk) tk.end();
        if (mg) mg.end();

        const assistantMsg = { role: "assistant", content: r.content || "" };
        if (r.toolCalls.length) {
          assistantMsg.tool_calls = r.toolCalls.map((t, i) => ({
            id: t.id || "call_" + i,
            type: "function",
            function: { name: t.name, arguments: t.arguments },
          }));
        }
        messages.push(assistantMsg);
        this.history.push(assistantMsg);

        if (!r.toolCalls.length) break;

        this.state(true, "AI 调用工具中");
        for (const call of r.toolCalls) {
          let args = {};
          try { args = JSON.parse(call.arguments || "{}"); } catch (e) {}
          const result = await this.execTool(call.name, args);
          const toolMsg = {
            role: "tool",
            tool_call_id: call.id || "call_0",
            content: String(result).slice(0, 24000),
          };
          messages.push(toolMsg);
          this.history.push(toolMsg);
        }
        // 工具调用后检查是否需要压缩（长任务中间也会膨胀）
        await this.compactHistory();
        this.emit({ type: "context.usage", used: this._estTokens(this.history), budget: (this.cfg.context || {}).budgetTokens || 1000000 });
        this.state(true, "AI 思考中");
      }

      const changes = this.pushChanges(true);
      if (changes.length) {
        // 按会话记录本次改动，切换会话时各自显示
        this.convChanges[this._currentConv] = changes;
        this.emit({ type: "term.line", text: "[Agent] 本次任务共改动 " + changes.length + " 个文件", cls: "tl-info" });
      }
      this.round++;

      /* Phase 2：任务完成后 → 自我进化 + Skill 自动提取（异步，不阻塞主流程） */
      if (this.cfg.memory && this.cfg.memory.enabled && this.history.length >= 2) {
        const taskTopic = text.slice(0, 60);
        this.evolution.processTaskCompletion(chatStream, this.cfg.llm, this.history, taskTopic, "成功完成")
          .then((r) => { if (r.saved) this.emit({ type: "term.line", text: "[进化] 已提取 " + r.saved + " 条经验教训", cls: "tl-info" }); })
          .catch(() => {});
        this.skills.autoExtract(chatStream, this.cfg.llm, this.history, taskTopic)
          .then((sk) => { if (sk) this.emit({ type: "term.line", text: "[Skill] 已自动沉淀: " + sk.name, cls: "tl-info" }); })
          .catch(() => {});
        // 灵魂微调提案：任务完成后提议，写入待确认区（不自动覆盖）
        this.proposeSoul(chatStream, this.cfg.llm, this.history, taskTopic)
          .then((sp) => { if (sp) this.emit({ type: "term.line", text: "[灵魂] 提议微调（待你确认）：" + sp.content.slice(0, 50), cls: "tl-info" }); })
          .catch(() => {});
        // 记忆归纳：每完成一次任务检查是否需要压缩
        this._consolidateMemory(this.history);
      }
  } catch (err) {
    const msg = (err && err.message ? err.message : String(err)).toLowerCase();
    let kind = "unknown";
    let hint = "请检查右上角「模型设置」中的 Base URL / API Key / 模型名，或切换到内置演示引擎体验。";
    if (err && err.status === 429 || msg.includes("429") || msg.includes("rate") || msg.includes("quota") || msg.includes("too many") || msg.includes("limit reached")) {
      kind = "quota";
      hint = "API 配额已耗尽或触发限流。请稍后重试，或在「模型设置」中更换 Key / 降低并发请求。";
    } else if (msg.includes("econn") || msg.includes("timeout") || msg.includes("network") || msg.includes("fetch failed") || msg.includes("enotfound") || msg.includes("socket") || msg.includes("aborted")) {
      kind = "network";
      hint = "网络异常，无法连接模型服务。请检查网络连接与 Base URL 是否正确可用。";
    } else if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("invalid api key") || msg.includes("incorrect api key") || msg.includes("authentication") || msg.includes("api key")) {
      kind = "key";
      hint = "API Key 无效或未授权。请检查「模型设置」中填写的 Key 是否正确。";
    } else if (msg.includes("404") || (msg.includes("model") && (msg.includes("not found") || msg.includes("does not exist") || msg.includes("not exist")))) {
      kind = "model";
      hint = "模型不存在或无访问权限。请确认「模型设置」中填写的模型名是否正确。";
    }
    this.emit({ type: "term.line", text: "[LLM 引擎异常] " + (err && err.message || err), cls: "tl-err" });
    this.emit({ type: "agent.error", kind, message: err && err.message || String(err), hint });
    await this.say("LLM 调用出错（" + kind + "）：" + (err && err.message || err) + "\n\n" + hint + ((kind === "quota" || kind === "network") ? "\n\n可在对话框下方点击「重试」重新发起。" : ""));
  } finally {
      this.state(false);
      this.saveConversations();   // C6：每轮对话结束落盘，重启后可恢复 AI 上下文
      this.emit({ type: "agent.done", round: this.round });
    }
  }
}

module.exports = { LlmAgent, PERSONAS };
