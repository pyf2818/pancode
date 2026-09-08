"use strict";
/* 仓库工具：repo_map / search_symbol / get_diagnostics / list_mcp */
const repoMap = require("../repo-map");
const { getMcpManager } = require("../mcp");
const { getActiveManager } = require("../lsp-bridge");
const { fmtDiag } = require("./util");

module.exports = {
  repo_map: async (agent, args) => {
    const t = agent.tool("read", "生成仓库地图", "repo_map");
    const idx = agent._repoIndex();
    const txt = repoMap.formatRepoMap(idx);
    t.body(txt.slice(0, 6000));
    t.done(true, idx.indexedCount + " 文件 / " + idx.symbolCount + " 符号");
    return txt;
  },

  search_symbol: async (agent, args) => {
    const t = agent.tool("read", "检索符号", args.query);
    const idx = agent._repoIndex();
    const rs = repoMap.searchSymbols(idx, args.query);
    const txt = rs.length
      ? rs.map((r) => r.path + ":" + r.line + "  " + r.kind + " " + r.name).join("\n")
      : "无匹配符号";
    t.body(txt);
    t.done(true, rs.length + " 处匹配");
    return txt;
  },

  get_diagnostics: async (agent, args) => {
    const t = agent.tool("read", "读取 LSP 诊断", args.path || "全部文件");
    const mgr = getActiveManager();
    if (!mgr) { t.done(false, "LSP 未启用"); return "当前未启用 LSP（在设置中开启语言服务器）。"; }
    const d = mgr.getDiagnostics(agent.files.dir, args.path);
    let txt;
    if (d.scope === "file") {
      if (!d.items.length) txt = "文件 " + d.path + "：无 LSP 诊断（无错误/警告）。";
      else txt = "文件 " + d.path + " 的 LSP 诊断（" + d.items.length + " 条）：\n" + d.items.map(fmtDiag).join("\n");
    } else {
      if (!d.files.length) {
        txt = "当前工作区没有 LSP 诊断（可能相关文件尚未在编辑器中打开，或语言服务器未启用）。";
      } else {
        txt = "当前工作区 LSP 诊断：共 " + d.errors + " 个错误、" + d.warnings + " 个警告，分布在 " + d.files.length + " 个文件：\n" +
          d.files.map((f) => {
            const head = "■ " + f.path + "（" + (f.language || "?") + "，" + f.items.length + " 条）";
            if (!f.items.length) return head + "：无";
            return head + "\n" + f.items.map((x) => "    " + fmtDiag(x)).join("\n");
          }).join("\n");
      }
    }
    t.body(txt.slice(0, 8000));
    t.done(true, "诊断 " + (d.scope === "file" ? d.items.length : d.errors + "/" + d.warnings));
    return txt;
  },

  list_mcp: async (agent, args) => {
    const t = agent.tool("read", "MCP 服务器清单", "list_mcp");
    const mgr = getMcpManager();
    const servers = mgr ? mgr.statusList() : [];
    if (!servers.length) { t.body("（未配置任何 MCP 服务器）"); t.done(true, "无 MCP"); return "当前没有配置 MCP 服务器。可在设置面板添加（stdio 命令型 MCP server），其工具会以 mcp__服务器__工具名 形式注入。"; }
    const txt = servers.map((s) => {
      const tools = (s.tools || []).map((x) => "    - " + x.name + (x.description ? " : " + String(x.description).slice(0, 80) : "")).join("\n");
      return "- [" + s.name + "] 状态: " + s.status + (s.error ? "（" + String(s.error).slice(0, 120) + "）" : "") + (tools ? "\n" + tools : "\n    (无可用工具)");
    }).join("\n");
    t.body(txt);
    t.done(true, servers.length + " 个服务器");
    return txt;
  },
};
