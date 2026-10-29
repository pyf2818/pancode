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
        });

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
          let args = {};
          try { args = JSON.parse(tc.arguments || "{}"); } catch (e) {}
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
  }
}

module.exports = { Engine, TOOLS, SYSTEM_PROMPT };
