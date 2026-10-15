/* ============================================================
   P3-D2 代码知识图谱
   与 repo_map 的分工：地图是「给人看的清单」（哪些文件里有哪些符号），
   图是「能问问题的结构」——谁指向谁。有了方向才能问：
     impact(file)  改它，谁会被牵连（沿 import 边反向走）
     deps(file)    它依赖谁（正向走）
     overview()    整仓的形状：枢纽文件、叶子、孤岛、循环依赖
   边从哪来：buildRepoIndex 本来就在提 import/require 边，只是算完只留了个计数
   就把邻接表丢了；这里把那一份接出来用，不另起第二套全仓扫描。
   没有解析器（仓库纪律：不加 tree-sitter），所以边的粒度是文件级，
   工具与界面的文案也按这个口径说——不冒充类型级精确调用图。
   ============================================================ */
"use strict";

/* index.edges：{ "importer 路径": ["被 import 的路径", …] }（repo-map.js 产出）
   allPaths：工作区全部文件（可选）。给了才能算出"孤岛"——
   只从边里收集节点的话，没有任何边的文件压根不在图上，"没查到"和"是孤岛"就分不开了。 */
function fromIndex(index, allPaths) {
  const out = new Map();   // path -> Set<path>（我依赖谁）
  const inMap = new Map(); // path -> Set<path>（谁依赖我）
  const nodes = new Set();
  const linked = new Set();
  const edges = (index && index.edges) || {};
  for (const from of Object.keys(edges)) {
    nodes.add(from);
    for (const to of edges[from] || []) {
      if (to === from) continue;                 // 自环不是信息，只会把 BFS 绕晕
      if (!out.has(from)) out.set(from, new Set());
      out.get(from).add(to);
      if (!inMap.has(to)) inMap.set(to, new Set());
      inMap.get(to).add(from);
      nodes.add(to);
      linked.add(from); linked.add(to);
    }
  }
  for (const p of allPaths || []) nodes.add(norm(p));
  return { out, in: inMap, nodes, linked };
}

const empty = () => new Set();

/* 反向 BFS：改 target 会牵连到谁。depth 是"隔了几层"，via 是这一层经由谁过来的。
   带 visited：循环依赖下不带就会无限转（图里出现环是常态，不是异常）。 */
function walk(g, target, adj, depth) {
  const start = norm(target);
  const seen = new Set([start]);
  const rows = [];
  let frontier = [start];
  for (let d = 1; d <= Math.max(1, Math.min(6, depth || 2)); d++) {
    const next = [];
    for (const p of frontier) {
      for (const q of (adj.get(p) || empty())) {
        if (seen.has(q)) continue;
        seen.add(q);
        rows.push({ path: q, depth: d, via: p });
        next.push(q);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return rows;
}

/* 工作区相对路径的分隔符统一成 /（Windows 下 FileStore 已经给 /，但参数是用户/模型写的） */
function norm(p) { return String(p || "").replace(/\\/g, "/").replace(/^\.\//, ""); }

function impact(g, target, depth) { return walk(g, target, g.in, depth); }
function depsOf(g, target, depth) { return walk(g, target, g.out, depth); }

/* 找环：从入度/出度都有的节点做 DFS，遇到回到栈内的边就是一条环。
   只报前 limit 条，并按"最小节点开头 + 排序"去重——同一条环从不同点出发会被找到多次。 */
function cycles(g, limit) {
  const cap = Math.max(1, Math.min(20, limit || 8));
  const found = new Set();
  const out = [];
  const stack = [];
  const onStack = new Set();
  const visiting = new Set();
  function dfs(node) {
    if (out.length >= cap) return;
    visiting.add(node);
    stack.push(node);
    onStack.add(node);
    for (const nxt of (g.out.get(node) || empty())) {
      if (out.length >= cap) break;
      if (onStack.has(nxt)) {
        const i = stack.indexOf(nxt);
        const cyc = stack.slice(i);
        const key = canon(cyc);
        if (!found.has(key)) { found.add(key); out.push(cyc.slice()); }
      } else if (!visiting.has(nxt)) {
        dfs(nxt);
      }
    }
    stack.pop();
    onStack.delete(node);
  }
  for (const n of [...g.nodes].sort()) if (!visiting.has(n)) dfs(n);
  return out;
}
function canon(cyc) {
  let best = cyc.join("←");
  for (let i = 1; i < cyc.length; i++) {
    const rot = cyc.slice(i).concat(cyc.slice(0, i)).join("←");
    if (rot < best) best = rot;
  }
  return best;
}

/* 整仓形状：枢纽（被依赖最多）、叶子（只依赖别人）、孤岛（两边都没有）。
   这三个问题是"接手一个陌生仓库先看什么"的答案，也是纯文本地图答不了的。 */
function overview(g, opts) {
  opts = opts || {};
  const top = opts.top || 8;
  const hubs = [...g.nodes].map((p) => ({ path: p, in: (g.in.get(p) || empty()).size, out: (g.out.get(p) || empty()).size }))
    .sort((a, b) => b.in - a.in || b.out - a.out || a.path.localeCompare(b.path));
  const withIn = hubs.filter((h) => h.in > 0);
  const leaves = hubs.filter((h) => h.in === 0 && h.out > 0).map((h) => h.path);
  const orphans = [...g.nodes].filter((p) => !(g.linked ? g.linked.has(p) : ((g.out.get(p) || empty()).size || (g.in.get(p) || empty()).size)));
  /* 环上的文件去重列出：比"发现 N 个环"有用——人要的是知道是哪几个文件互相缠着 */
  const cyc = cycles(g, opts.cycleLimit || 8);
  const cycFiles = new Set();
  cyc.forEach((c) => c.forEach((p) => cycFiles.add(p)));
  return {
    files: g.nodes.size,
    linked: g.linked.size,
    edges: [...g.out.values()].reduce((n, s) => n + s.size, 0),
    hubs: withIn.slice(0, top),
    leaves: leaves.slice(0, top),
    orphanCount: orphans.length,
    orphans: orphans.slice(0, top),
    cycles: cyc.slice(0, 6),
    cycleFiles: [...cycFiles],
  };
}

/* 工具/界面共用的一份文案：图是数据结构，给模型看的必须是能直接引用的结论。 */
function formatOverview(o) {
  let s = "代码依赖图概览（文件级 import/require 边）：\n";
  s += "- " + o.files + " 个文件，其中 " + o.linked + " 个之间有依赖关系，共 " + o.edges + " 条边\n";
  if (o.hubs.length) {
    s += "- 枢纽（被最多文件依赖，改动代价最高）：\n";
    o.hubs.forEach((h) => { s += "  · " + h.path + "（被 " + h.in + " 个文件依赖，它依赖 " + h.out + " 个）\n"; });
  } else s += "- 没有文件被其它文件依赖（可能全是入口/脚本，或依赖写法没被识别）\n";
  if (o.leaves.length) s += "- 叶子（只依赖别人、没人依赖它）：" + o.leaves.join("、") + "\n";
  if (o.orphanCount) s += "- 孤岛（与任何文件都没有依赖关系）" + o.orphanCount + " 个：" + o.orphans.join("、") + (o.orphanCount > o.orphans.length ? " …" : "") + "\n";
  if (o.cycles.length) {
    s += "- 循环依赖 " + o.cycles.length + " 组（涉及 " + o.cycleFiles.length + " 个文件）：\n";
    o.cycles.forEach((c) => { s += "  · " + c.join(" ← ") + " ← (回到 " + c[0] + ")\n"; });
  } else s += "- 没有发现循环依赖\n";
  return s.trimEnd();
}

function formatWalk(target, rows, dirWord) {
  if (!rows.length) return "没有沿依赖边" + dirWord + "找到与 " + target + " 相关的文件（可能是孤岛，或依赖写法没被识别为 import/require）。";
  let s = target + " 的依赖影响面（" + dirWord + "，按层展开）：\n";
  rows.forEach((r) => { s += "  L" + r.depth + " " + r.path + "（经由 " + r.via + "）\n"; });
  s += "共 " + rows.length + " 个文件。改 " + target + " 的对外行为前，先确认这些点是否需要同步。";
  return s.trimEnd();
}

module.exports = { fromIndex, impact, depsOf, cycles, overview, formatOverview, formatWalk, norm };
