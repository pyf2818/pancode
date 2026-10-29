/* ============================================================
   pancode-cli · 斜杠命令
   ------------------------------------------------------------
   吸收自 openanlan commands.ts 的命令注册模式：
     - name + aliases + description + argumentHint + isHidden
   命令分三类：
     A. 会话控制   /help /clear /compact /exit /resume /branch /btw
      B. 引擎暴露   /model /llm /budget /context /mcp /sandbox /hooks /agents
                    /add-dir /config /permissions /tasks /vim
     C. 工具       /rewind /undo /diff /files /git /export /copy /doctor
                    /soul /skill /plan /goal /memory /remember /theme /status
   每条命令接收 ctx = { engine, stores, cfg, render, prompt, args, convId, exit, transcriptLines }
   ============================================================ */
"use strict";

const S = require("./style");
const { renderMd } = require("./markdown");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const COMMANDS = [
  /* ============ A. 会话控制 ============ */
  {
    name: "help", aliases: ["?"], desc: "显示所有命令",
    run(ctx) {
      const lines = COMMANDS.filter((c) => !c.isHidden).map((c) => {
        const aliases = c.aliases ? S.dim("/" + c.aliases.join(" /")) : "";
        return S.indent(S.accent("/" + c.name.padEnd(12)) + S.dim(c.desc) + (aliases ? "  " + aliases : ""), 1);
      });
      process.stdout.write(S.box("命令", lines.join("\n"), { titleColor: S.accent }) + "\n\n");
    },
  },
  {
    name: "clear", aliases: ["reset", "new"], desc: "清空对话历史并释放上下文",
    run() { process.stdout.write("\x1b[2J\x1b[H"); },
  },
  {
    name: "compact", desc: "压缩上下文（保留摘要）",
    async run(ctx) {
      const e = ctx.engine;
      if (!e || !e.compactHistory) { process.stdout.write(S.dim("  引擎不支持压缩\n")); return; }
      try {
        const convId = e.currentConv ? e.currentConv() : ctx.convId;
        const conv = (e.conversations && e.conversations.get(convId)) || null;
        const hist = conv ? (conv.history || []) : [];
        if (!hist.length) { process.stdout.write(S.dim("  无对话历史可压缩\n")); return; }
        const compacted = await e.compactHistory(hist, { convId });
        if (conv && compacted) conv.history = compacted;
        process.stdout.write(S.ok("✓ 上下文已压缩") + S.dim(" (" + hist.length + " → " + (compacted ? compacted.length : "?") + " 条)") + "\n");
      } catch (e2) { process.stdout.write(S.err("  压缩失败：" + e2.message + "\n")); }
    },
  },
  {
    name: "exit", aliases: ["quit"], desc: "退出",
    run(ctx) { ctx.exit = true; },
  },
  {
    name: "resume", aliases: ["continue"], desc: "恢复历史对话",
    async run(ctx) {
      const e = ctx.engine;
      if (!e || !e.conversations) { process.stdout.write(S.dim("  无会话存储\n")); return; }
      const convs = Array.from(e.conversations.entries())
        .map(([id, c]) => ({ id, round: c.round || 0, ts: c.ts || 0, msgs: (c.history || []).length }))
        .sort((a, b) => b.ts - a.ts);
      if (!convs.length) { process.stdout.write(S.dim("  无历史会话\n")); return; }
      process.stdout.write(S.accent("  历史会话：\n"));
      convs.slice(0, 15).forEach((c, i) => {
        const time = c.ts ? new Date(c.ts).toLocaleString() : "?";
        process.stdout.write(S.indent(S.accent("[" + i + "]") + " " + S.dim(c.id.slice(0, 20)) + " " + S.dim(c.msgs + " 条 · R" + c.round) + " " + S.dim(time), 1) + "\n");
      });
      const idx = await ctx.prompt.input("选择序号");
      const n = parseInt(idx, 10);
      if (isNaN(n) || n < 0 || n >= convs.length) { process.stdout.write(S.dim("  已取消\n")); return; }
      e.switchConversation(convs[n].id);
      ctx.convId = convs[n].id;
      process.stdout.write(S.ok("✓ 已恢复会话 ") + convs[n].id.slice(0, 20) + "\n");
    },
  },
  {
    name: "branch", desc: "从当前位置创建对话分支",
    async run(ctx) {
      const e = ctx.engine;
      if (!e || !e.currentConv) { process.stdout.write(S.dim("  无当前会话\n")); return; }
      const oldId = e.currentConv();
      const newId = "cli-" + Date.now() + "-br";
      /* 复制当前历史到新会话 */
      if (e.conversations && e.conversations.has(oldId)) {
        const old = e.conversations.get(oldId);
        e.conversations.set(newId, JSON.parse(JSON.stringify(old)));
        e.switchConversation(newId);
        ctx.convId = newId;
        process.stdout.write(S.ok("✓ 已分支 ") + S.dim(oldId.slice(0, 16) + " → " + newId.slice(0, 16)) + "\n");
      } else {
        process.stdout.write(S.dim("  无法分支\n"));
      }
    },
  },
  {
    name: "btw", desc: "快速旁问（不打断主对话）",
    argumentHint: "<问题>",
    async run(ctx) {
      if (!ctx.args) { process.stdout.write(S.dim("  用法：/btw 你的问题\n")); return; }
      const e = ctx.engine;
      const origConv = e.currentConv ? e.currentConv() : ctx.convId;
      const sideId = "cli-" + Date.now() + "-btw";
      process.stdout.write(S.dim("  旁问中…（主对话不受影响）\n"));
      try {
        await e.handleChat(ctx.args, { convId: sideId });
      } catch (e2) { process.stdout.write(S.err("  旁问失败：" + e2.message + "\n")); }
      /* 切回原会话 */
      if (e.switchConversation && origConv) {
        try { e.switchConversation(origConv); ctx.convId = origConv; } catch (_) {}
      }
    },
  },

  /* ============ B. 引擎暴露 ============ */
  {
    name: "model", aliases: ["models"], desc: "查看或切换模型",
    argumentHint: "[model-name]",
    async run(ctx) {
      const cfg = ctx.engine.cfg || {};
      if (!ctx.args) {
        process.stdout.write(S.dim("当前模型：") + S.c.bold(cfg.model || "demo") + "\n");
        return;
      }
      try {
        const configMod = require("./config-loader");
        configMod.saveLlm(cfg, { model: ctx.args });
        process.stdout.write(S.ok("✓ 模型 → ") + ctx.args + S.dim("（已落盘）") + "\n");
      } catch (e) {
        cfg.model = ctx.args;
        process.stdout.write(S.ok("✓ 模型 → ") + ctx.args + S.dim("（内存）") + "\n");
      }
    },
  },
  {
    name: "llm", desc: "配置大模型（输入URL→Key→拉取模型→选择）",
    argumentHint: "<sub>",
    async run(ctx) {
      const cfg = ctx.engine.cfg || {};
      const configMod = require("./config-loader");
      const sub = (ctx.args || "").split(/\s+/)[0];
      const rest = (ctx.args || "").split(/\s+/).slice(1).join(" ");

      /* /llm 无参数 → 直接进向导（输入 URL → Key → 拉取模型 → 选择） */
      if (!sub) {
        const { wizard } = require("./llm-setup");
        const r = await wizard(cfg);
        if (r && ctx.rebuildEngine) ctx.rebuildEngine();
        return;
      }

      /* /llm list — 列出所有 profile */
      if (sub === "list") {
        const profiles = (cfg.llmProfiles || []).map((p) => configMod.profilePublic(p));
        const curURL = (cfg.llm && cfg.llm.baseURL) || "";
        const curModel = (cfg.llm && cfg.llm.model) || "";
        process.stdout.write(S.accent("  当前激活：") + S.c.bold(curModel || "demo") + S.dim(" @ " + (curURL || "无")) + "\n");
        if (!profiles.length) {
          process.stdout.write(S.dim("  暂无保存的配置，用 /llm add 新增\n"));
          return;
        }
        process.stdout.write(S.dim("  已保存配置（" + profiles.length + "）：\n"));
        profiles.forEach((p) => {
          const active = p.baseURL === curURL && p.model === curModel;
          const mark = active ? S.ok("▸ ") : S.dim("  ");
          const keyInfo = p.hasKey ? S.dim(" [Key …" + p.keyTail + "]") : S.warn(" [无Key]");
          process.stdout.write(mark + S.c.bold(p.name) + S.dim(" (" + p.id + ")") + " → " + p.model + S.dim(" @ " + p.baseURL) + keyInfo + "\n");
        });
        process.stdout.write(S.dim("\n  /llm add · /llm use <id> · /llm del <id> · /llm test · /llm models\n"));
        return;
      }

      /* /llm add — 交互式向导 */
      if (sub === "add") {
        const { wizard } = require("./llm-setup");
        const r = await wizard(cfg);
        if (r && ctx.rebuildEngine) ctx.rebuildEngine();
        return;
      }

      /* /llm use <id> — 切换到指定 profile */
      if (sub === "use") {
        if (!rest) { process.stdout.write(S.dim("  用法：/llm use <id>\n")); return; }
        const r = configMod.applyLlmProfile(cfg, rest);
        if (r && r.ok) {
          process.stdout.write(S.ok("✓ 已切换到 ") + r.profile.name + S.dim(" → " + r.profile.model) + "\n");
          if (!r.hasKey) process.stdout.write(S.warn("  ⚠ 该配置无 API Key，需重新设置\n"));
          if (ctx.rebuildEngine) ctx.rebuildEngine();
        } else {
          process.stdout.write(S.err("  未找到配置 id=" + rest + "\n"));
        }
        return;
      }

      /* /llm del <id> — 删除 profile */
      if (sub === "del" || sub === "rm") {
        if (!rest) { process.stdout.write(S.dim("  用法：/llm del <id>\n")); return; }
        const before = (cfg.llmProfiles || []).length;
        configMod.removeLlmProfile(cfg, rest);
        if ((cfg.llmProfiles || []).length < before) {
          process.stdout.write(S.ok("✓ 已删除 " + rest + "\n"));
        } else {
          process.stdout.write(S.err("  未找到 " + rest + "\n"));
        }
        return;
      }

      /* /llm test — 测试当前连接 */
      if (sub === "test") {
        const { testConnection } = require("./llm-setup");
        await testConnection(cfg);
        return;
      }

      /* /llm models — 拉取当前配置的模型列表 */
      if (sub === "models") {
        const { fetchModels } = require("./llm-setup");
        const baseURL = (cfg.llm && cfg.llm.baseURL) || "";
        const apiKey = (cfg.llm && cfg.llm.apiKey) || "";
        if (!baseURL) { process.stdout.write(S.err("  未配置 baseURL，先 /llm add\n")); return; }
        process.stdout.write(S.dim("  拉取 " + baseURL + " 的模型列表…\n"));
        const r = await fetchModels(baseURL, apiKey);
        if (r.ok) {
          process.stdout.write(S.ok("  ✓ " + r.models.length + " 个模型：\n"));
          r.models.forEach((m, i) => process.stdout.write(S.dim("  " + String(i + 1).padStart(3) + ". ") + m + "\n"));
        } else {
          process.stdout.write(S.err("  ✗ " + r.error + "\n"));
        }
        return;
      }

      /* /llm save — 把当前运行时配置存为 profile */
      if (sub === "save") {
        const name = rest || ((cfg.llm && cfg.llm.baseURL) || "").replace(/^https?:\/\//, "").slice(0, 28);
        const p = configMod.upsertLlmProfile(cfg, { name });
        process.stdout.write(S.ok("✓ 已保存为 ") + name + S.dim(" (id=" + p.id + ")") + "\n");
        return;
      }

      process.stdout.write(S.dim("  未知子命令 " + sub + "\n  用法：/llm [list|add|use|del|test|models|save]\n"));
    },
  },
  {
    name: "budget", desc: "查看预算水位",
    run(ctx) {
      const e = ctx.engine;
      const used = e.totalTokens || 0;
      const limit = (e.cfg && e.cfg.budget) || 0;
      process.stdout.write(S.dim("  预算 ") + used + "/" + (limit || "∞") + "\n");
    },
  },
  {
    name: "context", desc: "查看上下文用量",
    run(ctx) {
      const e = ctx.engine;
      const tokens = e.totalTokens || 0;
      const limit = (e.cfg && e.cfg.budget) || 0;
      const pct = limit ? Math.round(tokens / limit * 100) : 0;
      const bar = "▰".repeat(Math.round(pct / 10)) + "▱".repeat(10 - Math.round(pct / 10));
      process.stdout.write(S.ctxColor(pct)(bar) + " " + S.dim(pct + "%") + " " + S.dim(tokens + " tokens") + "\n");
    },
  },
  {
    name: "mcp", desc: "管理 MCP 服务器",
    async run(ctx) {
      try {
        const { getMcpManager } = require("../server/mcp");
        const mgr = getMcpManager();
        if (!mgr) { process.stdout.write(S.dim("  MCP 未初始化\n")); return; }
        const list = mgr.statusList();
        if (!list.length) { process.stdout.write(S.dim("  无 MCP 服务器\n")); return; }
        list.forEach((s) => {
          const stat = s.status === "connected" ? S.ok("●") : s.status === "error" ? S.err("●") : S.dim("○");
          process.stdout.write(S.indent(stat + " " + S.c.bold(s.name) + S.dim(" (" + (s.tools || []).length + " 工具)") + (s.error ? S.err(" " + s.error) : ""), 1) + "\n");
        });
      } catch (e) { process.stdout.write(S.dim("  MCP 模块未启用\n")); }
    },
  },
  {
    name: "sandbox", desc: "查看沙箱状态",
    run(ctx) {
      try {
        const sandbox = require("../server/sandbox");
        const cfg = ctx.engine.cfg || {};
        const r = sandbox.resolveBackend(cfg);
        const icon = r.backend === "docker" ? S.ok("🐳") : r.backend === "wsl" ? S.accent("🐧") : S.dim("⚙");
        process.stdout.write(icon + " " + S.c.bold(r.backend) + S.dim(" — " + r.reason) + "\n");
      } catch (e) { process.stdout.write(S.dim("  沙箱模块未启用\n")); }
    },
  },
  {
    name: "hooks", desc: "查看工具事件 Hook 规则",
    run(ctx) {
      const cfg = ctx.engine.cfg || {};
      const hooks = (cfg.hooks && cfg.hooks.pre) || [];
      if (!hooks.length) { process.stdout.write(S.dim("  无 Hook 规则\n")); return; }
      hooks.forEach((h) => {
        process.stdout.write(S.indent(S.warn("●") + " " + S.c.bold(h.tool || "*") + S.dim(" match=" + (h.match || "*")) + " → " + S.err(h.action || "deny") + (h.reason ? S.dim(" (" + h.reason + ")") : ""), 1) + "\n");
      });
    },
  },
  {
    name: "agents", desc: "管理 Agent 配置",
    run(ctx) {
      const e = ctx.engine;
      /* 显示引擎类型和可用工具 */
      const engineType = e.constructor && e.constructor.name ? e.constructor.name : "unknown";
      process.stdout.write(S.accent("  引擎：") + S.c.bold(engineType) + "\n");
      /* 子 Agent 能力 */
      const hasSubAgent = typeof e.runSubAgent === "function";
      process.stdout.write(S.dim("  子 Agent：") + (hasSubAgent ? S.ok("✓ 可用（通过工具 agent 自动派发）") : S.dim("○ 不可用")) + "\n");
      /* 列出引擎注册的工具 */
      if (e.toolDefs) {
        try {
          const defs = e.toolDefs();
          if (Array.isArray(defs) && defs.length) {
            process.stdout.write(S.dim("  工具（" + defs.length + "）：\n"));
            defs.forEach((d) => {
              const name = d.function ? d.function.name : d.name;
              process.stdout.write(S.indent(S.dim("  • ") + name, 1) + "\n");
            });
          }
        } catch (_) {}
      } else if (e.tools) {
        const names = Object.keys(e.tools);
        if (names.length) {
          process.stdout.write(S.dim("  工具（" + names.length + "）：\n"));
          names.forEach((n) => process.stdout.write(S.indent(S.dim("  • ") + n, 1) + "\n"));
        }
      }
      /* MCP 工具 */
      try {
        const { getMcpManager } = require("../server/mcp");
        const mgr = getMcpManager();
        if (mgr) {
          const list = mgr.statusList().filter((s) => s.status === "connected");
          const mcpTools = list.reduce((a, s) => a + (s.tools || []).length, 0);
          if (mcpTools) process.stdout.write(S.dim("  MCP 工具：") + S.ok(mcpTools + " 个（" + list.length + " 服务器）") + "\n");
        }
      } catch (_) {}
    },
  },
  {
    name: "add-dir", desc: "添加工作目录",
    argumentHint: "<path>",
    async run(ctx) {
      if (!ctx.args) { process.stdout.write(S.dim("  用法：/add-dir <路径>\n")); return; }
      const dir = path.resolve(ctx.args);
      if (!fs.existsSync(dir)) { process.stdout.write(S.err("  目录不存在\n")); return; }
      if (ctx.engine && ctx.engine.noteSessionRoot) {
        try { ctx.engine.noteSessionRoot(dir); process.stdout.write(S.ok("✓ 已添加 ") + dir + "\n"); }
        catch (e) { process.stdout.write(S.err("  添加失败\n")); }
      } else {
        process.stdout.write(S.dim("  引擎不支持多根\n"));
      }
    },
  },
  {
    name: "config", aliases: ["settings"], desc: "查看 / 修改配置",
    async run(ctx) {
      const cfg = ctx.engine.cfg || {};
      if (!ctx.args) {
        const lines = [
          S.dim("  model:    ") + (cfg.model || "demo"),
          S.dim("  workspace:") + (cfg.workspace || ctx.stores.files.root || "?"),
          S.dim("  budget:   ") + (cfg.budget || "∞"),
          S.dim("  sandbox:  ") + ((cfg.sandbox && cfg.sandbox.backend) || "auto"),
          S.dim("  mcp:      ") + ((cfg.mcp && cfg.mcp.servers && cfg.mcp.servers.length) || 0) + " servers",
          S.dim("  hooks:    ") + ((cfg.hooks && cfg.hooks.pre && cfg.hooks.pre.length) || 0) + " rules",
          S.dim("  perms:    ") + ((cfg.permissions && cfg.permissions.mode) || "default"),
        ];
        lines.forEach((l) => process.stdout.write(l + "\n"));
        process.stdout.write(S.dim("  /config set <key> <value> 修改（model|budget|sandbox|workspace）\n"));
        return;
      }
      const sp = ctx.args.split(/\s+/);
      if (sp[0] === "set" && sp.length >= 3) {
        const key = sp[1], val = sp.slice(2).join(" ");
        try {
          const configMod = require("./config-loader");
          if (key === "model") {
            configMod.saveLlm(cfg, { model: val });
          } else if (key === "budget") {
            cfg.budget = parseInt(val, 10) || 0;
          } else if (key === "sandbox") {
            configMod.saveAgentSettings(cfg, { sandbox: { backend: val } });
          } else if (key === "workspace") {
            const abs = path.resolve(val);
            if (!fs.existsSync(abs)) { process.stdout.write(S.err("  目录不存在\n")); return; }
            configMod.saveWorkspace(cfg, abs);
          } else if (key === "contextWindow") {
            configMod.saveLlm(cfg, { contextWindow: parseInt(val, 10) || 0 });
          } else if (key === "maxToolRounds") {
            configMod.saveLlm(cfg, { maxToolRounds: parseInt(val, 10) || 0 });
          } else {
            process.stdout.write(S.dim("  未知配置项 " + key + "（可用：model|budget|sandbox|workspace|contextWindow|maxToolRounds）\n"));
            return;
          }
          process.stdout.write(S.ok("✓ " + key + " → " + val) + S.dim("（已落盘）") + "\n");
        } catch (e) { process.stdout.write(S.err("  保存失败：" + e.message + "\n")); }
      } else if (sp[0] === "get" && sp[1]) {
        const key = sp[1];
        const val = key === "model" ? cfg.model : key === "budget" ? cfg.budget : cfg[key];
        process.stdout.write(S.dim("  " + key + " = ") + String(val) + "\n");
      } else {
        process.stdout.write(S.dim("  用法：/config set <key> <value> 或 /config get <key>\n"));
      }
    },
  },
  {
    name: "permissions", aliases: ["allowed-tools"], desc: "管理工具权限",
    run(ctx) {
      const cfg = ctx.engine.cfg || {};
      const perms = cfg.permissions || {};
      const mode = perms.mode || "default";
      process.stdout.write(S.dim("  模式：") + S.c.bold(mode) + "\n");
      const allow = perms.allow || [];
      const deny = perms.deny || [];
      if (allow.length) { process.stdout.write(S.ok("  允许：\n")); allow.forEach((t) => process.stdout.write(S.indent(S.ok("  + ") + t, 1) + "\n")); }
      if (deny.length) { process.stdout.write(S.err("  拒绝：\n")); deny.forEach((t) => process.stdout.write(S.indent(S.err("  - ") + t, 1) + "\n")); }
      if (!allow.length && !deny.length) process.stdout.write(S.dim("  无自定义规则\n"));
    },
  },
  {
    name: "tasks", aliases: ["bashes"], desc: "列出后台任务",
    run(ctx) {
      const procs = ctx.stores && ctx.stores.procs;
      if (!procs) { process.stdout.write(S.dim("  后台任务模块未启用\n")); return; }
      const list = (procs.list && procs.list()) || [];
      if (!list.length) { process.stdout.write(S.dim("  无后台任务\n")); return; }
      list.forEach((p) => {
        const stat = p.running ? S.warn("●") : S.dim("○");
        process.stdout.write(S.indent(stat + " [" + p.id + "] " + S.dim(p.cmd || "") + (p.pid ? S.dim(" pid=" + p.pid) : ""), 1) + "\n");
      });
    },
  },
  {
    name: "vim", desc: "切换 Vim 编辑模式",
    run(ctx) {
      ctx.vimMode = !ctx.vimMode;
      if (ctx.onVimToggle) ctx.onVimToggle(ctx.vimMode);
      process.stdout.write(S.dim("  Vim 模式：") + (ctx.vimMode ? S.accent("on") : S.dim("off")) + "\n");
    },
  },

  /* ============ C. 工具 ============ */
  {
    name: "rewind", aliases: ["checkpoint"], desc: "回退 N 轮后重发",
    argumentHint: "[N]",
    async run(ctx) {
      const n = parseInt(ctx.args, 10) || 1;
      const text = await ctx.prompt.multiline(S.accent("重发内容 ›"));
      if (!text.trim()) return;
      await ctx.engine.rewindAndRun(text, { convId: ctx.convId, backIndex: n });
    },
  },
  {
    name: "undo", desc: "撤销最近一次文件改动",
    async run(ctx) {
      const r = ctx.engine._undoLast ? ctx.engine._undoLast() : null;
      if (r) process.stdout.write(S.ok("✓ 已撤销 ") + S.dim(r.path || "") + "\n");
      else process.stdout.write(S.dim("  无可撤销改动\n"));
    },
  },
  {
    name: "undosteps", desc: "查看可撤销步数",
    run(ctx) {
      const n = ctx.engine.undoSteps ? ctx.engine.undoSteps() : 0;
      process.stdout.write(S.dim("  可撤销 " + n + " 步\n"));
    },
  },
  {
    name: "files", desc: "列出工作区文件",
    async run(ctx) {
      const list = await ctx.stores.files.list("");
      (list || []).slice(0, 40).forEach((f) => process.stdout.write(S.indent(S.dim(f.type === "dir" ? "📁 " : "  ") + f.name, 1) + "\n"));
    },
  },
  {
    name: "diff", desc: "查看 Git diff",
    async run(ctx) {
      const d = await ctx.stores.git.diff();
      if (d && d.trim()) process.stdout.write(S.colorizeDiff(d) + "\n");
      else process.stdout.write(S.dim("  无改动\n"));
    },
  },
  {
    name: "git", desc: "Git 状态",
    async run(ctx) {
      const st = await ctx.stores.git.status();
      if (Array.isArray(st)) st.forEach((s) => process.stdout.write(S.indent(S.dim(s.status || "") + " " + s.path, 1) + "\n"));
      else process.stdout.write(S.dim("  " + String(st || "干净") + "\n"));
    },
  },
  {
    name: "export", desc: "导出当前对话到文件",
    argumentHint: "[path]",
    async run(ctx) {
      const e = ctx.engine;
      const convId = e.currentConv ? e.currentConv() : ctx.convId;
      const conv = (e.conversations && e.conversations.get(convId)) || null;
      const history = conv ? (conv.history || []) : [];
      if (!history.length) { process.stdout.write(S.dim("  无对话内容\n")); return; }
      const outPath = ctx.args || path.join(process.cwd(), `chat-${Date.now()}.md`);
      const lines = [];
      const toText = (m) => {
        const c = m.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : (p && p.text) || (p && p.type === "text" ? p.text : ""))).join("");
        if (c && typeof c === "object") return c.text || c.content || JSON.stringify(c);
        return String(c || "");
      };
      history.forEach((m) => {
        if (m.role === "user") lines.push(S.MOON_BAR + " " + toText(m));
        else if (m.role === "assistant") lines.push(S.MOON + " " + toText(m));
        else if (m.role === "tool" || m.role === "function") lines.push(S.dim("  ⎿ [tool] " + toText(m).slice(0, 120)));
        lines.push("");
      });
      try { fs.writeFileSync(outPath, lines.join("\n"), "utf8"); process.stdout.write(S.ok("✓ 已导出到 ") + outPath + "\n"); }
      catch (e2) { process.stdout.write(S.err("  导出失败：" + e2.message + "\n")); }
    },
  },
  {
    name: "copy", desc: "复制最近一条 AI 回复",
    run(ctx) {
      const e = ctx.engine;
      const convId = e.currentConv ? e.currentConv() : ctx.convId;
      const conv = (e.conversations && e.conversations.get(convId)) || null;
      const history = conv ? (conv.history || []) : [];
      const last = [...history].reverse().find((m) => m.role === "assistant");
      if (!last) { process.stdout.write(S.dim("  无可复制内容\n")); return; }
      const c = last.content;
      let text;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.map((p) => (typeof p === "string" ? p : (p && p.text) || "")).join("");
      else text = JSON.stringify(c || "");
      try {
        const clip = process.platform === "win32" ? "clip" : process.platform === "darwin" ? "pbcopy" : "xclip -selection clipboard";
        execSync(clip, { input: text, stdio: ["pipe", "ignore", "ignore"] });
        process.stdout.write(S.ok("✓ 已复制到剪贴板") + " " + S.dim("(" + text.length + " 字符)") + "\n");
      } catch (_) { process.stdout.write(S.dim("  剪贴板不可用，内容：\n" + text.slice(0, 200) + "\n")); }
    },
  },
  {
    name: "doctor", desc: "诊断安装与配置",
    async run(ctx) {
      const checks = [];
      /* Node 版本 */
      const nv = process.versions.node;
      checks.push(["Node.js", nv >= "24" ? S.ok("✓ " + nv) : S.warn("⚠ " + nv + " (建议 ≥24)")]);
      /* 工作区 */
      const ws = ctx.stores.files.root || "?";
      checks.push(["工作区", fs.existsSync(ws) ? S.ok("✓ " + ws) : S.err("✗ " + ws)]);
      /* Git */
      try { execSync("git --version", { stdio: "ignore" }); checks.push(["Git", S.ok("✓ 可用")]); }
      catch { checks.push(["Git", S.err("✗ 不可用")]); }
      /* 模型 */
      const cfg = ctx.engine.cfg || {};
      checks.push(["模型", cfg.model ? S.ok("✓ " + cfg.model) : S.warn("⚠ demo 模式")]);
      /* API Key */
      const hasKey = !!(process.env.OPENAI_API_KEY || (cfg.llm && cfg.llm.apiKey));
      checks.push(["API Key", hasKey ? S.ok("✓ 已配置") : S.dim("○ 未配置（demo 模式）")]);
      /* LSP */
      try { require("../server/lsp-bridge"); checks.push(["LSP", S.ok("✓ 可用")]); }
      catch { checks.push(["LSP", S.dim("○ 未启用")]); }
      /* MCP */
      try { require("../server/mcp"); checks.push(["MCP", S.ok("✓ 可用")]); }
      catch { checks.push(["MCP", S.dim("○ 未启用")]); }
      /* 终端能力 */
      checks.push(["终端色彩", S.chalkLevel >= 3 ? S.ok("✓ truecolor") : S.chalkLevel >= 2 ? S.ok("✓ 256色") : S.chalkLevel >= 1 ? S.warn("⚠ 16色") : S.err("✗ 无色")]);

      process.stdout.write(S.box("诊断", checks.map(([k, v]) => S.dim(k.padEnd(12)) + v).join("\n"), { titleColor: S.accent }) + "\n");
    },
  },
  {
    name: "soul", desc: "查看 / 编辑 AI 人格",
    async run(ctx) {
      const soul = ctx.stores.soul;
      if (!soul) { process.stdout.write(S.dim("  灵魂模块未启用\n")); return; }
      if (!ctx.args) {
        const s = soul.get();
        process.stdout.write(S.box("灵魂", renderMd([
          "**" + (s.name || "pancode") + "**",
          "",
          s.vibe ? "*氛围*：" + s.vibe : "",
          s.values ? "*价值观*：" + s.values : "",
          s.principles ? "*原则*：" + s.principles : "",
        ].join("\n")), { titleColor: S.accent }) + "\n");
      }
    },
  },
  {
    name: "skill", aliases: ["skills"], desc: "列出沉淀的技能",
    async run(ctx) {
      const sk = ctx.stores.skillStore || ctx.stores.skill;
      if (!sk) { process.stdout.write(S.dim("  技能模块未启用\n")); return; }
      const list = sk.list();
      if (!list.length) { process.stdout.write(S.dim("  暂无技能\n")); return; }
      list.forEach((s) => process.stdout.write(S.indent(S.accent("⚡ " + s.name) + S.dim(" — " + (s.desc || "")), 1) + "\n"));
    },
  },
  {
    name: "plan", desc: "查看当前计划",
    async run(ctx) {
      const pl = ctx.stores.plan;
      if (!pl) { process.stdout.write(S.dim("  计划模块未启用\n")); return; }
      const p = pl.current();
      if (!p) { process.stdout.write(S.dim("  无活跃计划\n")); return; }
      process.stdout.write(S.box("计划", renderMd(p.text || JSON.stringify(p, null, 2)), { titleColor: S.accent }) + "\n");
    },
  },
  {
    name: "goal", desc: "查看目标",
    run(ctx) {
      const g = ctx.engine.goal;
      if (!g) { process.stdout.write(S.dim("  无目标\n")); return; }
      process.stdout.write(S.accent("🎯 " + (g.text || g.summary || JSON.stringify(g)) + "\n"));
    },
  },
  {
    name: "memory", desc: "查看长期记忆",
    run(ctx) {
      const mem = ctx.stores.memory;
      if (!mem) { process.stdout.write(S.dim("  记忆模块未启用\n")); return; }
      const items = mem.recent ? mem.recent(20) : (mem.list ? mem.list() : []);
      if (!items || !items.length) { process.stdout.write(S.dim("  暂无记忆\n")); return; }
      items.forEach((m) => process.stdout.write(S.indent(S.dim("• ") + (m.text || m.summary || JSON.stringify(m)), 1) + "\n"));
    },
  },
  {
    name: "remember", desc: "将当前会话沉淀为可复用 Skill",
    async run(ctx) {
      const e = ctx.engine;
      /* 取当前会话历史 */
      const convId = e.currentConv ? e.currentConv() : ctx.convId;
      const conv = (e.conversations && e.conversations.get(convId)) || null;
      const history = conv ? (conv.history || []) : [];
      if (!history.length) { process.stdout.write(S.dim("  无会话内容可沉淀\n")); return; }

      /* 优先走 evolution.processTaskCompletion（真实 LLM 提取经验） */
      try {
        const { EvolutionEngine } = require("../server/evolution");
        const mem = ctx.stores.memory || (e.memoryStore) || null;
        if (!mem) { process.stdout.write(S.dim("  记忆模块未启用\n")); return; }
        const eng = new EvolutionEngine(mem);
        /* 需要 llmChatFn：复用引擎的 chat 能力 */
        const llmChat = (typeof e.chat === "function") ? e.chat.bind(e)
                      : (typeof e.llmChat === "function") ? e.llmChat.bind(e)
                      : null;
        const topic = ctx.args || "CLI 会话沉淀";
        if (llmChat) {
          process.stdout.write(S.dim("  正在提取经验…\n"));
          const r = await eng.processTaskCompletion(llmChat, e.cfg || {}, history, topic, null);
          if (r && r.saved) {
            process.stdout.write(S.ok("✓ 已沉淀 " + r.saved.length + " 条经验") + "\n");
            r.saved.forEach((s) => process.stdout.write(S.indent(S.dim("• ") + (s.topic || "") + "：" + (s.content || "").slice(0, 60), 1) + "\n"));
          } else {
            process.stdout.write(S.dim("  未提取到值得沉淀的经验\n"));
          }
        } else {
          /* 无 LLM 能力（demo 引擎）：手动沉淀最后一条用户消息 */
          const lastUser = [...history].reverse().find((m) => m.role === "user");
          const content = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content || "");
          if (content.length < 20) { process.stdout.write(S.dim("  内容过短，不值得沉淀\n")); return; }
          const entry = mem.add("lesson", topic.slice(0, 24), content.slice(0, 200), { source: "cli-remember", valueScore: 3 });
          if (entry) process.stdout.write(S.ok("✓ 已沉淀到记忆（id=" + entry.id + "）") + "\n");
          else process.stdout.write(S.dim("  沉淀失败\n"));
        }
      } catch (err) {
        process.stdout.write(S.err("  沉淀失败：" + err.message + "\n"));
      }
    },
  },
  {
    name: "theme", desc: "查看当前主题配色",
    run() {
      const colors = [
        ["openanlan (主色)", S.accent("#4fc3f7")],
        ["suggestion (辉光)", S.accentShim("#81d4fa")],
        ["neon (霓虹)", S.neon("#00E5FF")],
        ["success", S.ok("#69F0AE")],
        ["error", S.err("#FF5252")],
        ["warning", S.warn("#FFD28C")],
        ["subtle (边框)", S.border("#1A3A5C")],
        ["text (月白)", S.text("#D8E8F0")],
      ];
      colors.forEach(([k, v]) => process.stdout.write("  " + k.padEnd(20) + v + "\n"));
    },
  },

  /* ============ D. 快捷动作（对齐前端 SLASH_COMMANDS） ============ */
  {
    name: "explain", desc: "解释当前文件",
    expand: "请阅读并解释当前打开的文件，说明其功能、关键逻辑和设计思路。",
    async run(ctx) { await ctx.engine.handleChat(this.expand, { convId: ctx.convId }); },
  },
  {
    name: "test", desc: "生成单元测试",
    expand: "请为当前打开的文件生成单元测试，覆盖主要功能和边界情况。先查看项目中已有的测试风格并保持一致。",
    async run(ctx) { await ctx.engine.handleChat(this.expand, { convId: ctx.convId }); },
  },
  {
    name: "fix", desc: "修复错误",
    expand: "请检查当前打开的文件中的错误和问题，并修复它们。先运行测试确认问题，修复后再验证。",
    async run(ctx) { await ctx.engine.handleChat(this.expand, { convId: ctx.convId }); },
  },
  {
    name: "refactor", desc: "重构代码",
    expand: "请重构当前打开的文件，改善代码结构、可读性和可维护性，但不改变功能。改完跑测试验证。",
    async run(ctx) { await ctx.engine.handleChat(this.expand, { convId: ctx.convId }); },
  },
  {
    name: "review", desc: "代码审查",
    expand: "请对当前打开的文件进行代码审查，指出潜在问题、改进建议和最佳实践。",
    async run(ctx) { await ctx.engine.handleChat(this.expand, { convId: ctx.convId }); },
  },
  {
    name: "docs", desc: "生成文档",
    expand: "请为当前打开的文件生成文档注释（JSDoc/docstring 等），包括函数说明、参数和返回值。",
    async run(ctx) { await ctx.engine.handleChat(this.expand, { convId: ctx.convId }); },
  },
  {
    name: "optimize", desc: "优化性能",
    expand: "请分析当前打开的文件的性能瓶颈，并提出和实施优化方案。改完验证功能不变。",
    async run(ctx) { await ctx.engine.handleChat(this.expand, { convId: ctx.convId }); },
  },
  {
    name: "orchestrate", desc: "拆分任务并行派发子 Agent",
    argumentHint: "<任务描述>",
    expand: "请把下面这个任务拆成可并行的子任务并用 orchestrate 派发：\n",
    async run(ctx) {
      const text = this.expand + (ctx.args || "");
      await ctx.engine.handleChat(text, { convId: ctx.convId });
    },
  },
  {
    name: "sediment", desc: "沉淀本次会话为规则/记忆",
    async run(ctx) {
      /* 复用 /remember 的逻辑 */
      const rememberCmd = COMMANDS.find((c) => c.name === "remember");
      if (rememberCmd) await rememberCmd.run(ctx);
    },
  },

  /* ============ 隐藏命令 ============ */
  {
    name: "status", desc: "显示状态", isHidden: true,
    run(ctx) {
      const e = ctx.engine;
      const cfg = e.cfg || {};
      process.stdout.write(S.dim("  模型: ") + (cfg.model || "demo") + "\n");
      process.stdout.write(S.dim("  tokens: ") + (e.totalTokens || 0) + "\n");
      process.stdout.write(S.dim("  轮次: ") + (e.round || 0) + "\n");
    },
  },
];

/* 解析输入：返回命令或 null */
function parse(line) {
  if (!line || line[0] !== "/") return null;
  const sp = line.slice(1).split(/\s+/);
  const name = sp[0].toLowerCase();
  const args = sp.slice(1).join(" ");
  const cmd = COMMANDS.find((c) => c.name === name || (c.aliases && c.aliases.includes(name)));
  return cmd ? { cmd, args } : { notFound: name };
}

module.exports = { COMMANDS, parse };
