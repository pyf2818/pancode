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
   ============================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AgentBase } = require("./agent-base");
const { chatStream } = require("./llm");
const repoMap = require("./repo-map");

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
      description: "在工作区所有文件内容中搜索关键词 / 正则，返回匹配的行。用于定位代码。",
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
      description: "在工作区根目录执行一条 shell 命令（如运行测试 / 构建）。危险命令会被安全沙箱拦截。",
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
];

const SYSTEM_PROMPT = `你是 pancode Agent，一个在真实项目工作区中自主编程的 AI。

工作准则：
1. 动手前先用 list_files / read_file 了解项目，不要凭空假设文件内容。
2. 修改代码用 write_file 写入完整文件内容（不是补丁）。
3. 每次有意义的修改之后，必须用 run_command 运行测试或程序验证，失败就继续修复，直到通过或确认无法解决。
4. 写文件 / 删除文件 / 执行命令等操作会由系统代为向用户请求确认（取决于当前权限模式），你正常调用工具即可，无需自行询问用户；若被拒绝，换更安全的方案或停止。
5. 全程用简体中文回复。最终答复请总结：做了什么改动、如何验证的、结果如何。
6. run_command 的命令在工作区根目录执行；运行 JS 用 node，禁止执行危险命令（rm -rf /、格式化磁盘等）。`;

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
    this.history = [];                  // 跨轮对话记忆
    this.pending = new Map();           // 等待用户确认的工具调用 id -> { resolve, timer }
    this._apSeq = 0;
    this._memPath = null;
    this._repoDirty = false;        // 仓库索引失效标记（文件变更后置位）
    this._repoCache = null;         // 缓存的仓库符号索引
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

  /* ---------------- 上下文增强：人格 / 规则 / 记忆 ---------------- */
  _memoryPath() {
    if (this._memPath) return this._memPath;
    const wsAbs = path.resolve(require("./config").ROOT, this.cfg.workspace || "workspace");
    const key = crypto.createHash("md5").update(wsAbs).digest("hex");
    this._memPath = path.join(require("./config").ROOT, ".pancode", "memory", key + ".md");
    return this._memPath;
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

  loadMemory() {
    try { return fs.readFileSync(this._memoryPath(), "utf8").trim(); } catch (e) { return ""; }
  }

  buildSystemAugment() {
    const parts = [];
    const persona = this.personaText();
    if (persona) parts.push(persona);
    if (this.cfg.rules && this.cfg.rules.enabled) {
      const r = this.loadRules();
      if (r) parts.push("【项目规则（强制遵循）】\n" + r);
    }
    if (this.cfg.memory && this.cfg.memory.enabled) {
      const m = this.loadMemory();
      if (m) parts.push("【项目记忆（参考）】\n" + m);
    }
    if (this.cfg.repoMap !== false) {
      const ov = repoMap.repoOverview(this.files);
      if (ov) parts.push("【仓库结构】\n" + ov);
    }
    return parts.join("\n\n");
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
    const budget = (this.cfg.context.budgetTokens) || 120000;
    if (this._estTokens(this.history) <= budget * 0.85) return;
    const keep = 6;
    if (this.history.length <= keep + 2) return;
    const old = this.history.slice(0, this.history.length - keep);
    const recent = this.history.slice(this.history.length - keep);
    const summary = await this._summarize(old);
    this.history = [{ role: "system", content: "[历史摘要] " + summary }, ...recent];
    this.emit({ type: "term.line", text: "[Agent] 上下文已自动压缩（保留最近 " + keep + " 条）", cls: "tl-info" });
  }

  /* ---------------- auto memory（会话中沉淀） ---------------- */
  _maybeRemember(text) {
    if (!this.cfg.memory || !this.cfg.memory.enabled) return;
    if (!text || text.length > 600) return;
    if (!/(不对|错了?|错误|应该|正确的是|记住|纠正|改成|其实|并非|不要|需要|建议)/.test(text)) return;
    const line = "- " + text.replace(/\s+/g, " ").slice(0, 300);
    const file = this._memoryPath();
    let prev = "";
    try { prev = fs.readFileSync(file, "utf8"); } catch (e) {}
    if (prev.split("\n").some((l) => l.trim() === line.trim())) return; // 去重
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, (prev && !prev.endsWith("\n") ? prev + "\n" : prev) + line + "\n", "utf8");
      this.emit({ type: "term.line", text: "[Agent] 已将你的偏好记入项目记忆", cls: "tl-info" });
    } catch (e) {}
  }

  /* ---------- 工具实现 ---------- */
  async execTool(name, args) {
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
        const t = this.tool("read", "全文搜索", args.query);
        const rs = this.files.search(args.query, 50);
        const txt = rs.map((r) => r.path + ":" + r.line + ": " + r.text.trim()).join("\n");
        t.body(txt || "无结果");
        t.done(true, rs.length + " 处匹配");
        return txt || "无结果";
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
        const r = await this.term.run(args.command, null, { timeout: 90_000, strict: true });
        if (r.blocked) {
          t.body("命令被安全沙箱拦截：" + args.command);
          t.done(false, "已拦截", false);
          return "命令被安全沙箱拦截，未执行";
        }
        t.body((r.out || "(无输出)").slice(-4000) + "\n\n(exit code " + r.code + ")");
        t.done(r.code === 0, r.code === 0 ? "退出码 0" : "退出码 " + r.code, r.code !== 0);
        this.pushChanges(false);
        return "退出码: " + r.code + "\n输出:\n" + (r.out || "(无输出)").slice(-6000);
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
      default:
        return "未知工具: " + name;
    }
  }

  /* ---------- 主循环 ---------- */
  async handleChat(text, opts) {
    if (this.running) return;
    opts = opts || {};
    const attachments = Array.isArray(opts.attachments) ? opts.attachments : [];

    const { clean, block } = this._resolveMentions(text);
    this._maybeRemember(text);
    this.emit({ type: "user.msg", text });
    this.state(true, "AI 思考中");

    const content = this._buildUserContent(clean + (block ? "\n\n" + block : ""), attachments);
    this.history.push({ role: "user", content });

    await this.compactHistory();
    this.emit({ type: "context.usage", used: this._estTokens(this.history), budget: (this.cfg.context || {}).budgetTokens || 120000 });

    // 控制上下文长度：最多保留最近 40 条（摘要后更低）
    if (this.history.length > 40) this.history = this.history.slice(-40);

    const aug = this.buildSystemAugment();
    const messages = [{ role: "system", content: SYSTEM_PROMPT }];
    if (aug) messages.push({ role: "system", content: aug });
    for (const h of this.history) messages.push(h);

    let rounds = 0;
    try {
      for (;;) {
        rounds++;
        if (rounds > this.cfg.llm.maxToolRounds) {
          await this.say("已达到单任务最大工具调用轮数（" + this.cfg.llm.maxToolRounds + "），先停在这里。如果还需要继续，请再发一条消息。");
          break;
        }

        let tk = null, mg = null;
        const r = await chatStream(this.cfg.llm, messages, TOOLS, {
          onReasoning: (d) => { if (!tk) tk = this.thinkStart(); tk.delta(d); },
          onContent: (d) => {
            if (tk) { tk.end(); tk = null; }
            if (!mg) mg = this.msgStart();
            mg.delta(d);
          },
        });
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
        this.state(true, "AI 思考中");
      }

      const changes = this.pushChanges(true);
      if (changes.length) this.emit({ type: "term.line", text: "[Agent] 本次任务共改动 " + changes.length + " 个文件", cls: "tl-info" });
      this.round++;
    } catch (err) {
      this.emit({ type: "term.line", text: "[LLM 引擎异常] " + err.message, cls: "tl-err" });
      await this.say("LLM 调用出错：" + err.message + "\n\n请检查右上角「模型设置」中的 Base URL / API Key / 模型名，或切换到内置演示引擎体验。");
    } finally {
      this.state(false);
      this.emit({ type: "agent.done", round: this.round });
    }
  }
}

module.exports = { LlmAgent, PERSONAS };
