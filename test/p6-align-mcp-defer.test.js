/* ============================================================
   P6-#10 MCP 工具按需暴露（对齐 openanlan 的 deferred tools + ToolSearchTool）。
   改前：每一轮请求都把全部 MCP 工具的完整 inputSchema 拼进去（agent-llm.js 迁移前的
   `getMcpManager().toolDefs()`），接两三台服务器就是上万字符，且每轮都付。
   改后：默认只给「限定名 + 一句话」的清单，模型要用哪条先 tool_search 取回 schema，
   取回后从下一次请求起才真的可调用。
   钉四件事：清单定序（缓存前缀）、未连接服务器不进清单、解锁按会话且有上限、
   以及最要紧的一条负控：**没解锁就一条 schema 都不许进请求**。
   ============================================================ */
const { McpManager, initMcpManager, getMcpManager } = require("../server/mcp");
const { LlmAgent } = require("../server/agent-llm");
const repoTools = require("../server/tools/repo-tools");

const clients = () => new Map([
  ["playwright", {
    connected: true,
    tools: [
      { name: "browser_navigate", description: "导航到指定 URL。" + "补".repeat(200), inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
      { name: "browser_click", description: "点击元素", inputSchema: { type: "object", properties: {} } },
    ],
  }],
  ["fs", { connected: true, tools: [{ name: "read", description: "读文件", inputSchema: { type: "object", properties: { p: { type: "string" } } } }] }],
  ["掉线的", { connected: false, tools: [{ name: "nope", description: "不该出现" }] }],
]);

function mgrOf() {
  const m = Object.create(McpManager.prototype);
  m.clients = clients();
  return m;
}

describe("deferredCatalog / toolDefsFor", () => {
  it("只列已连接服务器的工具，名字带 mcp__server__ 前缀", () => {
    const rows = mgrOf().deferredCatalog();
    expect(rows.map((r) => r.name)).toEqual([
      "mcp__fs__read", "mcp__playwright__browser_click", "mcp__playwright__browser_navigate",
    ]);
    expect(rows.some((r) => r.name.includes("nope"))).toBe(false);
  });

  it("按限定名定序：清单顺序变了会打碎系统提示的缓存前缀", () => {
    const m = mgrOf();
    const a = m.deferredCatalog().map((r) => r.name);
    const b = m.deferredCatalog().map((r) => r.name);
    expect(a).toEqual([...a].sort());
    expect(a).toEqual(b);
  });

  it("描述截到 160 字（清单只用来判断「有没有我要的那条」，不是说明书）", () => {
    const nav = mgrOf().deferredCatalog().find((r) => r.name === "mcp__playwright__browser_navigate");
    expect(nav.description.length).toBeLessThanOrEqual(160);
  });

  it("负控：没解锁 = 一条 schema 都不进请求", () => {
    expect(mgrOf().toolDefsFor(new Set())).toEqual([]);
    expect(mgrOf().toolDefs()).toHaveLength(3);        // 全量确实还是 3 条，说明"按需"这刀是真砍了
  });

  it("toolDefsFor 只回点名的那几条，形状与原 toolDefs 一致", () => {
    const defs = mgrOf().toolDefsFor(new Set(["mcp__playwright__browser_navigate"]));
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("mcp__playwright__browser_navigate");
    expect(defs[0].function.parameters.properties.url.type).toBe("string");
  });
});

describe("引擎侧的解锁状态", () => {
  function eng() {
    const a = Object.create(LlmAgent.prototype);
    a._conv = "c1";
    a._convIdNow = function () { return this._conv; };
    return a;
  }

  it("按会话各记各的：A 解锁的不该出现在 B 的请求里", () => {
    const a = eng();
    a.unlockMcp("mcp__fs__read");
    a._conv = "c2";
    expect([...a._mcpUnlockedNow()]).toEqual([]);
    a._conv = "c1";
    expect([...a._mcpUnlockedNow()]).toEqual(["mcp__fs__read"]);
  });

  it("解锁有上限，且淘汰的是最老的那条", () => {
    const a = eng();
    for (let i = 0; i < 20; i++) a.unlockMcp("t" + i);
    const set = a._mcpUnlockedNow();
    expect(set.size).toBe(12);
    expect(set.has("t0")).toBe(false);
    expect(set.has("t19")).toBe(true);
  });

  it("未解锁清单里不再列已解锁的那几条", () => {
    initMcpManager({});
    const mgr = getMcpManager();
    mgr.clients = clients();
    const a = eng();
    a.unlockMcp("mcp__fs__read");
    const block = a._mcpDeferredBlock();
    expect(block).toContain("mcp__playwright__browser_navigate");
    expect(block).not.toContain("mcp__fs__read");
    expect(block).toContain("tool_search");            // 告诉模型怎么取回 schema，不是只给一堆名字
  });

  it("全部解锁后清单整块消失（不留一个空标题占位）", () => {
    initMcpManager({});
    const mgr = getMcpManager();
    mgr.clients = clients();
    const a = eng();
    for (const r of mgr.deferredCatalog()) a.unlockMcp(r.name);
    expect(a._mcpDeferredBlock()).toBe("");
  });

  it("条目太多时退化成只列名字：描述是这里最贵也最可省的部分", () => {
    initMcpManager({});
    const mgr = getMcpManager();
    const big = new Map();
    for (let s = 0; s < 3; s++) {
      big.set("srv" + s, {
        connected: true,
        tools: Array.from({ length: 40 }, (_, i) => ({ name: "tool_" + i, description: "描".repeat(160), inputSchema: { type: "object", properties: {} } })),
      });
    }
    mgr.clients = big;
    const block = eng()._mcpDeferredBlock();
    expect(block.length).toBeLessThan(9000);
    expect(block).not.toContain("描描");               // 描述整段被丢掉，只留名字
    expect(block).toContain("mcp__srv0__tool_0");
  });
});

describe("tool_search 工具", () => {
  function agent() {
    return {
      unlocked: [],
      tool: () => ({ body: () => {}, done: () => {} }),
      unlockMcp(n) { this.unlocked.push(n); },
      _convIdNow: () => "c1",
    };
  }
  beforeEach(() => {
    initMcpManager({});
    getMcpManager().clients = clients();
  });

  it("命中就解锁并回完整参数 schema", async () => {
    const a = agent();
    const out = await repoTools.tool_search(a, { query: "browser_navigate" });
    expect(a.unlocked).toEqual(["mcp__playwright__browser_navigate"]);
    expect(out).toContain("mcp__playwright__browser_navigate");
    expect(out).toContain('"url"');                    // schema 真的给了，模型能直接拼参数
    expect(out).toContain("下一次请求");
  });

  it("空 query 不会退化成「全部解锁」（那等于把按需暴露又改回全量）", async () => {
    const a = agent();
    const out = await repoTools.tool_search(a, { query: "   " });
    expect(a.unlocked).toEqual([]);
    expect(out).toContain("不会一次给出全部");
  });

  it("没匹配就如实说，并给一条下一步（换关键词 / 用 list_mcp）", async () => {
    const a = agent();
    const out = await repoTools.tool_search(a, { query: "完全不存在的名字" });
    expect(a.unlocked).toEqual([]);
    expect(out).toContain("没有匹配");
    expect(out).toContain("list_mcp");
  });

  it("命中超过 5 条只解锁前 5 条，并明说还剩几条", async () => {
    const big = new Map([["srv", {
      connected: true,
      tools: Array.from({ length: 9 }, (_, i) => ({ name: "same_" + i, description: "同一类", inputSchema: { type: "object", properties: {} } })),
    }]]);
    initMcpManager({});
    getMcpManager().clients = big;
    const a = agent();
    const out = await repoTools.tool_search(a, { query: "same_" });
    expect(a.unlocked).toHaveLength(5);
    expect(out).toContain("另有 4 条");
  });

  it("没有 MCP 管理器时不炸，直接说没有", async () => {
    initMcpManager({});
    const mgr = getMcpManager();
    mgr.clients = new Map();
    const out = await repoTools.tool_search(agent(), { query: "x" });
    expect(out).toContain("没有已连接");
  });
});
