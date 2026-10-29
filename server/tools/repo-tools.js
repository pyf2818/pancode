"use strict";
/* 仓库工具：repo_map / search_symbol / code_graph / get_diagnostics / list_mcp */
const repoMap = require("../repo-map");
const CG = require("../code-graph");
const R = require("../refactor");
const { getMcpManager } = require("../mcp");
const { getActiveManager } = require("../lsp-bridge");
const { fmtDiag } = require("./util");

/* 工作区全部文件（算孤岛要用；只从边里收集节点会把"没查到"和"是孤岛"混成一件事）。
   list() 失败时返回空数组——图照样能问上下游，只是不报孤岛。 */
function allFiles(agent) {
  try { return (agent.files.list() || []).map(CG.norm); } catch (e) { return []; }
}

/* 图里查不到这个节点时给几个"你是不是想问"——直接回"没找到"会让人以为工具坏了。 */
function nearMatches(g, target, limit) {
  const q = CG.norm(target).toLowerCase();
  const seg = q.split("/").pop() || q;
  return [...g.nodes]
    .map((p) => ({ p, l: p.toLowerCase() }))
    .filter((x) => x.l.includes(seg) || seg.includes(x.p.split("/").pop()))
    .slice(0, limit || 6)
    .map((x) => x.p);
}

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

  /* P3-D2 代码知识图谱：把"改这里会牵连谁"变成一个可直接问的只读工具。
     四种问法对应四种真实动作：接手陌生仓看形状 / 改文件前看影响面 / 看它依赖谁 / 改符号前看谁在用。 */
  code_graph: async (agent, args) => {
    const mode = ["overview", "impact", "deps", "symbol"].includes(args.mode) ? args.mode : "overview";
    const target = CG.norm(args.target || args.path || args.name || "");
    const depth = Math.max(1, Math.min(6, Number(args.depth) || 2));
    const t = agent.tool("read", mode === "overview" ? "依赖图概览" : mode === "impact" ? "改动影响面" : mode === "deps" ? "依赖清单" : "符号使用点",
      mode === "overview" ? "全仓" : target);
    const idx = agent._repoIndex();
    const g = CG.fromIndex(idx, allFiles(agent));
    if (!g.linked.size) {
      const txt = "依赖图是空的：这个工作区里没识别到任何 import/require 关系（可能是纯脚本集合，或依赖写法不在识别范围内）。";
      t.done(false, "无依赖边");
      return txt;
    }
    if (mode === "overview") {
      const txt = CG.formatOverview(CG.overview(g, { top: Number(args.top) || 8 }));
      t.body(txt.slice(0, 6000));
      t.done(true, g.nodes.size + " 个文件有依赖关系");
      return txt;
    }
    if (!target) {
      t.done(false, "缺少 target");
      return "错误: mode=" + mode + " 需要 target（工作区相对路径或符号名）。例如 { mode: \"impact\", target: \"server/files.js\" }。";
    }
    if (mode === "symbol") {
      if (!R.IDENT_RE.test(target)) {
        t.done(false, "符号名不合法");
        return "错误: target 要是一个标识符（字母/数字/_/$ 组成），收到的是「" + target + "」。按文件问影响面请用 mode=impact。";
      }
      const defs = repoMap.searchSymbols(idx, target).filter((s) => s.name.toLowerCase() === target.toLowerCase());
      const scan = R.scanFiles((p) => { try { return agent.files.read(p); } catch (e) { return null; } }, g.nodes.size ? [...g.nodes] : [], target, {});
      const users = scan.files.filter((f) => f.hits && f.hits.length);
      const head = "符号 " + target + "：定义 " + defs.length + " 处、被引用文件 " + users.length + " 个\n";
      const defLines = defs.length ? defs.map((d) => "  · 定义 " + d.path + ":" + d.line + "（" + d.kind + "）").join("\n") + "\n" : "";
      const useLines = users.slice(0, 40).map((f) => "  · " + f.path + "（" + f.hits.length + " 处，L" + (f.hits[0].line || "?") + " 起）").join("\n");
      /* 定义所在文件的反向影响面才是重点：谁 import 了这个文件，才可能用到这个符号 */
      const defPaths = [...new Set(defs.map((d) => d.path))];
      const spill = new Set();
      defPaths.forEach((p) => CG.impact(g, p, depth).forEach((r) => spill.add(r.path)));
      const txt = head + defLines + (useLines || "  （没有文件按这个名字引用它）\n")
        + (spill.size ? "\n这些定义文件再往上还会牵连：" + [...spill].slice(0, 30).join("、") + "\n" : "")
        + "（边的粒度是文件级：谁 import 了定义所在文件都算牵连到，具体是否真用到这个符号请逐个看上面的引用行。）";
      t.body(txt.slice(0, 6000));
      t.done(true, users.length + " 个文件引用");
      return txt;
    }
    if (!g.nodes.has(target)) {
      const near = nearMatches(g, target);
      const txt = "依赖图里没有「" + target + "」这个节点（它没有任何 import/require 边，或路径写错了）。"
        + (near.length ? "\n名字接近的节点：" + near.join("、") : "")
        + "\n要按名字问符号级的问题请改用 mode=symbol。";
      t.done(false, "节点不存在");
      return txt;
    }
    const rows = mode === "impact" ? CG.impact(g, target, depth) : CG.depsOf(g, target, depth);
    const txt = CG.formatWalk(target, rows, mode === "impact" ? "反向（谁依赖它）" : "正向（它依赖谁）");
    t.body(txt.slice(0, 6000));
    t.done(true, rows.length + " 个文件");
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
  /* 按需取回外部 MCP 工具的完整定义（对齐 openanlan 的 ToolSearchTool）。
     这些工具默认只以「限定名 + 一句话」出现在系统提示里，完整 inputSchema 不进请求；
     决定要用哪一条就先查这里，取回后它从**下一次请求**起出现在工具列表里。
     为什么要这一层：接三台 MCP 服务器动辄上百个工具，全量 schema 每轮白占上万字符。 */
  tool_search: async (agent, args) => {
    const t = agent.tool("read", "检索 MCP 工具", "tool_search");
    const mgr = getMcpManager();
    const all = mgr ? mgr.deferredCatalog() : [];
    if (!all.length) {
      t.body("无可用的外部 MCP 工具");
      t.done(true, "无 MCP 工具");
      return "当前没有已连接且提供工具的 MCP 服务器。要查看配置与连接状态请调 list_mcp。";
    }
    const q = String((args && args.query) || "").trim().toLowerCase();
    /* 空 query 不当"匹配全部"：includes("") 对任何名字都成立，那样会一次解锁几十条，
       等于把按需暴露又退化成全量。找不到关键词就如实说，并给几个例子。 */
    if (!q) {
      const sample = all.slice(0, 8).map((r) => "  - " + r.name).join("\n");
      t.body("缺少 query 参数");
      t.done(true, "缺参数");
      return "tool_search 需要 query（工具名或其描述里的关键词），不会一次给出全部 schema。\n"
        + "当前可用 " + all.length + " 条，前 8 条：\n" + sample
        + "\n（完整清单在系统提示的【外部 MCP 工具】段里；要按服务器看状态用 list_mcp）";
    }
    const hits = all.filter((r) => (r.name + " " + r.description).toLowerCase().includes(q));
    if (!hits.length) {
      t.body("无匹配：" + q);
      t.done(true, "0 条匹配");
      return "没有匹配「" + q + "」的 MCP 工具（共 " + all.length + " 条可用）。"
        + "换个更宽的关键词再试，或用 list_mcp 看各服务器都提供什么。";
    }
    const take = hits.slice(0, 5);
    const defs = new Map(mgr.toolDefs().map((d) => [d.function.name, d]));
    for (const r of take) agent.unlockMcp(r.name);
    const txt = take.map((r) => {
      const d = defs.get(r.name);
      const schema = d ? JSON.stringify(d.function.parameters) : "{}";
      return "### " + r.name + "\n" + r.description + "\n参数 schema：" + schema;
    }).join("\n\n");
    const more = hits.length > take.length ? "\n\n（另有 " + (hits.length - take.length) + " 条也匹配，关键词再具体一点）" : "";
    t.body(txt.slice(0, 4000));
    t.done(true, take.length + " 条已解锁");
    return "以下 " + take.length + " 条已解锁，下一次请求起你可以直接调用：\n\n" + txt + more;
  },
};
