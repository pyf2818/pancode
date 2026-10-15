/* ============================================================
   P3-D2 代码知识图谱
   两半：code-graph 的图算法（纯函数），以及 repo-map 真的把边交出来。
   钉住的重点：
   - 环不能把 BFS 绕死（图里有环是常态）
   - 同一条环从不同点出发只报一次
   - buildRepoIndex 以前算完边只留计数就把邻接表丢了；
     而且符号数封顶用的是 break，连带把大文件后半段的 import 也截断了
   ============================================================ */
const CG = require("../server/code-graph");
const { buildRepoIndex } = require("../server/repo-map");

const G = (edges) => CG.fromIndex({ edges });

describe("图构建与遍历", () => {
  it("边建成正反两张表，自环丢掉", () => {
    const g = G({ "a.js": ["b.js", "a.js"], "b.js": [] });
    expect([...g.out.get("a.js")]).toEqual(["b.js"]);
    expect([...g.in.get("b.js")]).toEqual(["a.js"]);
    expect(g.out.get("a.js").has("a.js")).toBe(false);
    expect(g.nodes.has("b.js")).toBe(true);
  });

  it("反向走：谁依赖它，带层数与经由", () => {
    const g = G({ "x.js": ["a.js"], "y.js": ["x.js"], "a.js": [] });
    const rows = CG.impact(g, "a.js", 3);
    expect(rows.map((r) => r.path)).toEqual(["x.js", "y.js"]);
    expect(rows[0]).toMatchObject({ depth: 1, via: "a.js" });
    expect(rows[1]).toMatchObject({ depth: 2, via: "x.js" });
  });

  it("depth=1 只给直接依赖者", () => {
    const g = G({ "x.js": ["a.js"], "y.js": ["x.js"] });
    expect(CG.impact(g, "a.js", 1).map((r) => r.path)).toEqual(["x.js"]);
  });

  it("循环依赖不会把遍历绕死，也不会重复收同一个节点", () => {
    const g = G({ "a.js": ["b.js"], "b.js": ["c.js"], "c.js": ["a.js"] });
    const rows = CG.impact(g, "a.js", 6);
    expect(new Set(rows.map((r) => r.path)).size).toBe(rows.length);
    expect(rows.map((r) => r.path).sort()).toEqual(["b.js", "c.js"]);
  });

  it("Windows 反斜杠与 ./ 前缀都认得（target 是模型写的）", () => {
    const g = G({ "server/a.js": ["server/b.js"], "server/b.js": [] });
    expect(CG.impact(g, "server\\b.js", 2).map((r) => r.path)).toEqual(["server/a.js"]);
    expect(CG.impact(g, "./server/b.js", 2).map((r) => r.path)).toEqual(["server/a.js"]);
  });

  it("不存在的节点返回空而不是抛；根级文件也能解析上", () => {
    const g = G({ "a.js": ["b.js"] });
    expect(CG.impact(g, "nope.js", 3)).toEqual([]);
    expect(CG.depsOf(g, "nope.js", 3)).toEqual([]);
    expect(CG.impact(g, "b.js", 3).map((r) => r.path)).toEqual(["a.js"]);
    expect(CG.depsOf(g, "a.js", 3).map((r) => r.path)).toEqual(["b.js"]);
  });
});

describe("环与整仓形状", () => {
  it("同一条环从不同点出发只报一次", () => {
    const g = G({ "a.js": ["b.js"], "b.js": ["c.js"], "c.js": ["a.js"] });
    const c = CG.cycles(g, 8);
    expect(c.length).toBe(1);
    expect([...c[0]].sort()).toEqual(["a.js", "b.js", "c.js"]);
  });

  it("两组独立的环都报出来，limit 生效", () => {
    const g = G({
      "a.js": ["b.js"], "b.js": ["a.js"],
      "p.js": ["q.js"], "q.js": ["r.js"], "r.js": ["p.js"],
    });
    expect(CG.cycles(g, 8).length).toBe(2);
    expect(CG.cycles(g, 1).length).toBe(1);
  });

  it("无环时不硬凑", () => {
    const g = G({ "a.js": ["b.js"], "b.js": ["c.js"] });
    expect(CG.cycles(g, 8)).toEqual([]);
  });

  it("枢纽按被依赖数排，叶子/孤岛分开数", () => {
    const g = G({ "x.js": ["hub.js"], "y.js": ["hub.js"], "z.js": ["leaf.js"], "hub.js": [], "leaf.js": [] });
    const o = CG.overview(g, { top: 5 });
    expect(o.hubs[0].path).toBe("hub.js");
    expect(o.hubs[0].in).toBe(2);
    expect(o.leaves).toContain("x.js");
    expect(o.orphanCount).toBe(0);
    expect(o.edges).toBe(3);   // x→hub、y→hub、z→leaf
  });

  it("只有出边的文件不是孤岛；两边都没有才是", () => {
    const g = CG.fromIndex({ edges: { "a.js": ["b.js"] } });
    expect(CG.overview(g, {}).orphans).toEqual([]);
    const g2 = CG.fromIndex({ edges: { "a.js": ["b.js"], "solo.js": [] } });
    expect(CG.overview(g2, {}).orphans).toEqual(["solo.js"]);
  });
});

describe("文案不夸大", () => {
  it("空图时说的是「没识别到」而不是「没有影响」", () => {
    const g = G({});
    const t = CG.formatWalk("a.js", CG.impact(g, "a.js", 2), "反向（谁依赖它）");
    expect(t).toContain("没有沿依赖边");
    expect(t).not.toContain("安全");
  });

  it("影响面文案把层数与经由写出来，并提醒这是超集", () => {
    const g = G({ "x.js": ["a.js"], "y.js": ["x.js"] });
    const t = CG.formatWalk("a.js", CG.impact(g, "a.js", 2), "反向（谁依赖它）");
    expect(t).toContain("L1 x.js（经由 a.js）");
    expect(t).toContain("L2 y.js（经由 x.js）");
    expect(t).toContain("共 2 个文件");
  });

  it("概览里没有枢纽时说得清原因，不留一行空白", () => {
    const txt = CG.formatOverview(CG.overview(G({ "a.js": [], "b.js": [] }), {}));
    expect(txt).toContain("没有文件被其它文件依赖");
  });
});

describe("repo-map 把边交出来", () => {
  const fakeFiles = (map) => ({
    dir: "/ws",
    list: () => Object.keys(map),
    read: (p) => map[p],
    isBinary: () => false,
  });

  it("edges 是邻接表，且与 depCount 同源", () => {
    const idx = buildRepoIndex(fakeFiles({
      "a.js": 'require("./b");\nmodule.exports = 1;\n',
      "b.js": "export function bb() { return 1; }\n",
    }));
    expect(idx.edges).toBeTruthy();
    expect(idx.edges["a.js"]).toContain("b.js");
    expect(idx.depCount.get("b.js")).toBe(1);
  });

  it("副作用导入（import \"./x\"，没有绑定名）也算一条边", () => {
    /* 这条以前是漏的：DEP_RE 的每个分支都要求 import 后面先有标识符，
       于是 `import "./theme.js"` 这种写法在图上凭空不存在——少边比多边危险，
       因为"看不出牵连"和"没有牵连"在界面上长得一模一样。 */
    const idx = buildRepoIndex(fakeFiles({
      "app.js": 'import "./theme.js";\nexport const app = 1;\n',
      "theme.js": "export const theme = 1;\n",
    }));
    expect(idx.edges["app.js"]).toContain("theme.js");
  });

  it("符号数封顶不再顺手截断依赖边（这条以前是 break）", () => {
    const lines = [];
    for (let i = 0; i < 80; i++) lines.push("export const s" + i + " = " + i + ";");
    lines.push('import "./late";');           // 封顶之后出现的 import
    const idx = buildRepoIndex(fakeFiles({
      "big.js": lines.join("\n"),
      "late.js": "export const late = 1;\n",
    }));
    expect(idx.files.find((f) => f.path === "big.js").symbols.length).toBeLessThanOrEqual(60);
    expect(idx.edges["big.js"]).toContain("late.js");
  });

  it("根级文件的相对导入也解析得上（入口文件全在根，漏不得）", () => {
    /* resolveDep 以前无条件拼 base + "/"，根级文件的 base 是空串，
       于是 "./b" 变成 "/./b"，一条边都建不起来。 */
    const idx = buildRepoIndex(fakeFiles({
      "main.js": 'require("./server.js");\n',
      "server.js": "const x = 1;\n",
    }));
    expect(idx.edges["main.js"]).toContain("server.js");
  });

  it("没有边的仓库：edges 是空对象而不是 undefined", () => {
    const idx = buildRepoIndex(fakeFiles({ "solo.js": "export const a = 1;\n" }));
    expect(idx.edges).toEqual({});
    expect(CG.fromIndex(idx).nodes.size).toBe(0);
  });
});
