/* ============================================================
   pancode-cli · 自包含 Agent 引擎
   标准 ReAct 工具调用循环：
     LLM 流式输出（思考/回复透传）→ 工具调用 → 结果回填 → 再询问
   5 个核心工具：list_files / read_file / write_file / search_code / run_command

   事件协议与 render.js 兼容：
     user.msg / think.start/delta/end / msg.start/delta/end
     tool.start/body/end / agent.done / agent.error / agent.usage
   ============================================================ */
"use strict";
const { chatStream, LlmAbortedError } = require("./llm");
const { FileStore } = require("./files");
const { TerminalLayer } = require("./terminal");
const { GitLayer } = require("./git");

/* 权限决策与桌面端共用同一份梯子（server/permission-core.js）。
   这条 require 是审查项 F05 的正身：独立引擎以前完全不问人 ——
   cli/lib/config.js 的默认档写着 permissions.mode="ask"，
   execTool 却对 write_file / run_command 直通执行，"要问"只存在于配置里。
   自包含安装（没有 server/ 目录）时退到"问人"这一最严分支，不退到"直通"。 */
let permCore = null;
try { permCore = require("../../server/permission-core"); } catch (e) { permCore = null; }

/* 这 5 个工具的性质表。桌面端从 server/tools/contract.js 取（38 个工具），
   独立引擎只有这 5 个，就地声明一份最小表；readOnly/mutating 的语义与契约表一致。 */
const TOOL_FACTS = {
  list_files:  { readOnly: true,  mutating: false, pathArg: null },
  read_file:   { readOnly: true,  mutating: false, pathArg: "path" },
  search_code: { readOnly: true,  mutating: false, pathArg: "path" },
  write_file:  { readOnly: false, mutating: true,  pathArg: "path" },
  run_command: { readOnly: false, mutating: true,  pathArg: null },
};
const APPROVAL_TIMEOUT_SEC = 300;   // 终端里没人点卡不等于可以自动放行：到点按拒绝收场

const SYSTEM_PROMPT = [
  "你是一个强大的编程助手，工作在用户的本地项目目录中。",
  "你可以通过工具读取文件、写入文件、搜索代码、执行命令来帮助用户完成任务。",
  "工作原则：",
  "1. 先了解项目结构再动手，不要凭猜测修改代码",
  "2. 修改前先读取目标文件，确认上下文",
  "3. 写文件时给出完整内容，不要省略",
  "4. 执行命令前考虑安全性，危险命令需要用户确认",
  "5. 任务完成后简要总结做了什么",
].join("\n");

/* OpenAI 兼容工具定义 */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "列出工作区文件和目录。用于先了解项目结构，再决定读取哪些文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "可选：要列出的子目录路径，默认列根目录" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取指定文件内容。path 是相对工作区的路径。大文件会自动截断，可用 startLine/endLine 读指定区间。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要读取的文件路径（相对工作区）" },
          startLine: { type: "number", description: "可选：从第几行开始读（1 起算）" },
          endLine: { type: "number", description: "可选：读到第几行（含）" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "创建或覆盖写入完整文件内容。改动会按权限模式向用户确认。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要写入的文件路径（相对工作区）" },
          content: { type: "string", description: "文件的完整内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description: "在工作区中搜索代码。query 可以是关键词或 /正则/ 形式。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词或正则表达式（/pattern/ 格式）" },
          path: { type: "string", description: "可选：限定搜索的子目录" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "在工作区根目录执行一条 shell 命令（如运行测试、构建）。命令在用户本地真实执行。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的命令，如 npm test" },
          timeout: { type: "number", description: "可选：超时秒数（默认 60）" },
        },
        required: ["command"],
      },
    },
  },
];

class Engine {
  constructor(cfg) {
    this.cfg = cfg;
    this.workspace = cfg.workspace || process.cwd();
    this.files = new FileStore(this.workspace);
    this.term = new TerminalLayer(this.workspace);
    this.git = new GitLayer(this.workspace);
    this.history = [];
    this.round = 0;
    this.seq = 0;
    this.running = false;
    this._abortCtl = null;
    this.pending = new Map();        // 待人工确认的 tool.pending
    this._sessionGrants = new Set(); // 用户点过「本会话同类」的工具
  }

  id() { return "e" + Date.now().toString(36) + (++this.seq); }

  emit(ev) {
    if (this._emit) this._emit(ev);
  }

  setEmitter(fn) { this._emit = fn; }

  /* ---------- 事件辅助 ---------- */
  thinkStart() {
    const id = this.id();
    this.emit({ type: "think.start", id, round: this.round });
    return {
      delta: (text) => this.emit({ type: "think.delta", id, text }),
      end: () => this.emit({ type: "think.end", id }),
    };
  }

  msgStart() {
    const id = this.id();
    this.emit({ type: "msg.start", id });
    return {
      delta: (text) => this.emit({ type: "msg.delta", id, text }),
      end: () => this.emit({ type: "msg.end", id }),
    };
  }

  toolStart(name, target) {
    const id = this.id();
    this.emit({ type: "tool.start", id, name, target, round: this.round });
    return {
      body: (text) => this.emit({ type: "tool.body", id, text }),
      end: (ok) => this.emit({ type: "tool.end", id, ok: ok !== false }),
    };
  }

  /* ---------- 权限闸门（与桌面端共用 permission-core 的梯子） ---------- */
  _permConfig() {
    const p = (this.cfg && this.cfg.permissions) || {};
    return { mode: p.mode || "ask", allow: Array.isArray(p.allow) ? p.allow : [], deny: Array.isArray(p.deny) ? p.deny : [] };
  }

  /* 规则主体：文件类给相对路径（kind=path，走 glob/前缀那套退化规则），
     命令类给整条命令（kind=text，走子串/正则）。与桌面端 _hookSubject 的分工一致。 */
  _permSubject(name, args) {
    const fact = TOOL_FACTS[name] || { pathArg: null };
    if (fact.pathArg) return String((args && args[fact.pathArg]) || "");
    return String((args && (args.command || args.query)) || "");
  }

  _matchRule(toolName, subject, rules, kind) {
    if (permCore) return permCore.matchPermRule(toolName, subject, rules, kind);
    // 自包含安装拿不到共享核心时，退回最简子串命中：宁可多问一次，不可少问一次
    const s = String(subject || "").toLowerCase();
    return (rules || []).find((r) => (typeof r === "string" ? r && s.includes(r.toLowerCase()) : r && (!r.pattern || s.includes(String(r.pattern).toLowerCase())))) || null;
  }

  /* 返回 { action: "allow" | "ask" | "block", reason } */
  _approvalDecision(name, args) {
    const perm = this._permConfig();
    const fact = TOOL_FACTS[name] || { readOnly: false, mutating: true, pathArg: null };
    const subject = this._permSubject(name, args);
    const kind = fact.pathArg ? "path" : "text";
    const denyHit = this._matchRule(name, subject, perm.deny, kind);
    const allowHit = !denyHit && fact.mutating ? this._matchRule(name, subject, perm.allow, kind) : null;
    const dec = permCore
      ? permCore.decide({
          mode: perm.mode,
          denyReason: denyHit ? "命中拒绝规则 " + (typeof denyHit === "string" ? denyHit : denyHit.pattern || denyHit.tool) : null,
          allowReason: allowHit ? "命中放行规则 " + (typeof allowHit === "string" ? allowHit : allowHit.pattern || allowHit.tool) : null,
          sessionGranted: this._sessionGrants.has(name),
          readOnly: !!fact.readOnly,
          irreversible: false,       // 独立引擎没有删除/推送类工具，不可逆守卫由桌面端那条链负责
          isPath: !!fact.pathArg,
          mutating: !!fact.mutating,
        })
      : { action: fact.readOnly ? "allow" : "ask", reason: "权限核心不可用，写操作按最严档处理" };
    return permCore ? permCore.applyDontAsk(dec, perm.mode) : dec;
  }

  grantSession(toolName) { this._sessionGrants.add(toolName); }

  resolveApproval(id, approved) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve({ approved: !!approved, reason: approved ? "" : "用户已拒绝" });
    return true;
  }

  /* 弹一张 tool.pending 卡等人点。没有 TTY（管道 / CI）时不假装问过了：
     直接拒绝并说明怎么显式改档 —— 静默放行正是审查项 F05 要关掉的那个洞。 */
  _requestApproval(name, args, reason) {
    if (!process.stdin.isTTY) {
      return Promise.resolve({ approved: false, reason: "无人可问（stdin 不是 TTY）：" + reason + "；需要自动执行请显式设 permissions.mode=auto" });
    }
    const id = this.id();
    const fact = TOOL_FACTS[name] || {};
    this.emit({
      type: "tool.pending", id, name, tool: name,
      target: this._permSubject(name, args),
      summary: reason, reason,
      risk: name === "run_command" ? "high" : "medium",
      timeoutSec: APPROVAL_TIMEOUT_SEC,
      mutating: !!fact.mutating,
    });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.emit({ type: "tool.cancelled", id, name, label: "等待确认超时，已自动拒绝" });
        resolve({ approved: false, reason: "等待确认超时（" + APPROVAL_TIMEOUT_SEC + "s），已自动拒绝" });
      }, APPROVAL_TIMEOUT_SEC * 1000);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, timer });
    });
  }

  /* ---------- 工具执行 ---------- */
  async execTool(name, args) {
    const t = this.toolStart(name, args.path || args.command || args.query || "");
    try {
      let result;
      switch (name) {
        case "list_files": {
          const items = this.files.list(args.path);
          result = items.map((i) => (i.type === "dir" ? "📁 " : "📄 ") + i.path).join("\n") || "(空目录)";
          break;
        }
        case "read_file": {
          const r = this.files.read(args.path, { startLine: args.startLine, endLine: args.endLine });
          result = r.content;
          if (r.truncated) result += "\n\n[文件已截断，共 " + r.totalLines + " 行，只显示前 " + r.shownLines + " 行。用 startLine/endLine 读后续内容]";
          if (r.startLine) result = "[第 " + r.startLine + "-" + (r.startLine + r.shownLines - 1) + " 行，共 " + r.totalLines + " 行]\n" + result;
          break;
        }
        case "write_file": {
          this.files.write(args.path, args.content);
          result = "已写入 " + args.path + " (" + Buffer.byteLength(args.content) + " bytes)";
          this.emit({ type: "file.changed", path: args.path });
          break;
        }
        case "search_code": {
          const hits = this.files.search(args.query, { path: args.path });
          result = hits.length
            ? hits.map((h) => h.file + ":" + h.line + "  " + h.text).join("\n")
            : "未找到匹配";
          break;
        }
        case "run_command": {
          const r = await this.term.run(args.command, { timeout: args.timeout });
          result = r.stdout || r.stderr || "(无输出)";
          if (r.timedOut) result = "[命令超时]\n" + result;
          if (!r.ok && !r.timedOut) result = "[退出码 " + r.code + "]\n" + result;
          break;
        }
        default:
          result = "未知工具: " + name;
      }
      t.body(result);
      t.end(true);
      return result;
    } catch (e) {
      t.body(String(e.message || e));
      t.end(false);
      return String(e.message || e);
    }
  }

  /* ---------- 主对话循环 ---------- */
  async handleChat(text, opts) {
    opts = opts || {};
    if (this.running) {
      this.emit({ type: "chat.rejected", reason: "忙" });
      return;
    }
    this.running = true;
    this._abortCtl = new AbortController();

    this.emit({ type: "user.msg", text });
    this.history.push({ role: "user", content: text });

    const llmCfg = {
      baseURL: this.cfg.llm.baseURL,
      apiKey: this.cfg.llm.apiKey,
      model: this.cfg.llm.model,
      temperature: this.cfg.llm.temperature,
    };

    let totalTokens = 0;
    let rounds = 0;
    const maxRounds = this.cfg.llm.maxToolRounds || 200;

    try {
      for (;;) {
        rounds++;
        this.round = rounds;
        if (rounds > maxRounds) {
          const m = this.msgStart();
          m.delta("已达到最大工具调用轮数（" + maxRounds + "），先停在这里。");
          m.end();
          break;
        }

        const messages = [{ role: "system", content: SYSTEM_PROMPT }].concat(this.history);
        let thinkId = null;
        let msgId = null;

        const r = await chatStream(llmCfg, messages, TOOLS, {
          onReasoning: (text) => {
            if (!thinkId) {
              thinkId = this.id();
              this.emit({ type: "think.start", id: thinkId, round: this.round });
            }
            this.emit({ type: "think.delta", id: thinkId, text });
          },
          onContent: (text) => {
            if (!msgId) {
              if (thinkId) { this.emit({ type: "think.end", id: thinkId }); thinkId = null; }
              msgId = this.id();
              this.emit({ type: "msg.start", id: msgId });
            }
            this.emit({ type: "msg.delta", id: msgId, text });
          },
        }, { signal: this._abortCtl.signal });   // 停止按钮必须接到流上：光置 running 位是假取消（审查项 F11）

        /* 关闭未关闭的块 */
        if (thinkId) { this.emit({ type: "think.end", id: thinkId }); thinkId = null; }
        if (msgId) { this.emit({ type: "msg.end", id: msgId }); msgId = null; }

        if (r.usage && r.usage.total_tokens) totalTokens = r.usage.total_tokens;

        /* 没有工具调用 → 对话结束 */
        if (!r.toolCalls || !r.toolCalls.length) {
          this.history.push({ role: "assistant", content: r.content });
          break;
        }

        /* 有工具调用 → 执行后继续循环 */
        this.history.push({
          role: "assistant",
          content: r.content || "",
          tool_calls: r.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        for (const tc of r.toolCalls) {
          /* 取消要落在"每一个工具执行之前"：只在 fetch 上挂 signal 的话，
             用户点停止时正在排队的第二个工具照样会真的跑掉（审查项 F11）。 */
          if (this._abortCtl && this._abortCtl.signal.aborted) break;
          let args = {};
          try { args = JSON.parse(tc.arguments || "{}"); } catch (e) {}
          /* 权限闸门：与桌面端共用 permission-core 那条梯子。判到 ask 就弹卡等确认，
             拒绝 / 超时 / 无人可问都**不执行**；但不执行也要把 tool 结果回填给模型 ——
             留一条没有 tool 结果的 tool_call，下一轮请求会被协议直接判非法。 */
          const dec = this._approvalDecision(tc.name, args);
          let denied = null;
          if (dec.action === "block") denied = "[已拒绝] " + dec.reason;
          else if (dec.action === "ask" || dec.action === "classify") {
            /* smart 档在独立 CLI 没有分类器可用。退化成"问人"，不退化成"放行"：
               拿不准就当没授权，才是这一档本来的意思。 */
            const why = dec.action === "classify" ? "智能判定档：独立 CLI 无分类器，这一步交回给你确认" : dec.reason;
            const ans = await this._requestApproval(tc.name, args, why);
            if (!ans.approved) denied = "[已拒绝] " + (ans.reason || why);
          }
          if (denied) {
            this.emit({ type: "tool.denied", name: tc.name, reason: denied });
            this.history.push({ role: "tool", tool_call_id: tc.id, content: denied });
            continue;
          }
          const result = await this.execTool(tc.name, args);
          this.history.push({
            role: "tool",
            tool_call_id: tc.id,
            content: String(result).slice(0, 20000),
          });
        }
      }
    } catch (e) {
      if (e instanceof LlmAbortedError) {
        this.emit({ type: "agent.error", message: "已取消" });
      } else {
        this.emit({ type: "agent.error", message: String(e.message || e) });
      }
    } finally {
      this.running = false;
      this._abortCtl = null;
      this.emit({ type: "agent.usage", totalTokens, rounds });
      this.emit({ type: "agent.done", round: rounds });
    }
  }

  abort() {
    if (this._abortCtl) this._abortCtl.abort();
    /* 待确认的卡也要当场收掉：不 resolve 的话 _requestApproval 会挂到 300s 超时，
       用户点了停止却看到"还在等待确认"。独立引擎只跑单会话，清全部是对的。 */
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ approved: false, reason: "已取消" });
    }
    this.pending.clear();
  }
}

module.exports = { Engine, TOOLS, SYSTEM_PROMPT };
