/* ============================================================
   W27 · 对话 rewind 的服务端截断逻辑
   backIndex 从最新往回数（0 = 最后一条用户消息），与压缩折叠天然对齐；
   目标消息已被压缩折掉时退化为清空重跑并明说；会话在跑时拒绝。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

let tmp;
let LlmAgent;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-"));
  fs.writeFileSync(path.join(tmp, "pancode.config.json"), JSON.stringify({ workspace: tmp }), "utf8");
  process.env.PANCODE_DATA_DIR = tmp;
  ({ LlmAgent } = require("../server/agent-llm"));
});
afterAll(() => {
  delete process.env.PANCODE_DATA_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

function mkAgent() {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = { llm: { contextWindow: 128000 }, permissions: { mode: "auto" }, memory: { enabled: false } };
  a.conversations = new Map();
  a.runningConvs = new Set();
  a.emitted = [];
  a.convChanges = {};
  a.handled = [];
  a.emit = (m) => a.emitted.push(m);
  a._persistConversations = () => {};
  a._convIdNow = () => "c1";
  a.handleChat = async (text, opts) => { a.handled.push({ text, opts }); return { ok: true }; };
  return a;
}
const hist = () => ([
  { role: "user", content: "第一条" },
  { role: "assistant", content: "答一" },
  { role: "user", content: "第二条" },
  { role: "assistant", content: "答二" },
  { role: "user", content: "第三条" },
]);

describe("rewindAndRun —— 历史截断口径", () => {
  it("backIndex=0：截到最后一条用户消息之前，按原文重发", async () => {
    const a = mkAgent();
    a.conversations.set("c1", { history: hist(), round: 2, ts: 1, changes: [] });
    await a.rewindAndRun("第三条(改)", { convId: "c1", backIndex: 0 });
    const h = a.conversations.get("c1").history;
    expect(h.map((m) => m.role + ":" + m.content)).toEqual(["user:第一条", "assistant:答一", "user:第二条", "assistant:答二"]);
    expect(a.handled).toEqual([{ text: "第三条(改)", opts: { convId: "c1" } }]);
  });

  it("backIndex=1：截到倒数第二条用户消息之前（保留它之前的完整上下文）", async () => {
    const a = mkAgent();
    a.conversations.set("c1", { history: hist(), round: 2, ts: 1, changes: [] });
    await a.rewindAndRun("第二条(改)", { convId: "c1", backIndex: 1 });
    expect(a.conversations.get("c1").history).toEqual([
      { role: "user", content: "第一条" },
      { role: "assistant", content: "答一" },
    ]);
  });

  it("目标消息被压缩折叠时退化为清空重跑，且明说", async () => {
    const a = mkAgent();
    // 历史里只剩一条 user，但前端点的是第 3 条（前两条已被折叠）
    a.conversations.set("c1", { history: [{ role: "user", content: "仅存的旧话" }], round: 2, ts: 1, changes: [] });
    await a.rewindAndRun("重跑", { convId: "c1", backIndex: 2 });
    expect(a.conversations.get("c1").history).toEqual([]);
    expect(a.emitted.some((e) => e.type === "term.line" && /被压缩折叠/.test(e.text))).toBe(true);
    expect(a.handled.length).toBe(1);
  });

  it("会话正在跑时拒绝，不动历史", async () => {
    const a = mkAgent();
    a.runningConvs.add("c1");
    a.conversations.set("c1", { history: hist(), round: 2, ts: 1, changes: [] });
    const r = await a.rewindAndRun("重跑", { convId: "c1", backIndex: 0 });
    expect(r).toEqual({ ok: false, reason: "busy" });
    expect(a.conversations.get("c1").history.length).toBe(5);
    expect(a.handled.length).toBe(0);
    expect(a.emitted.some((e) => e.type === "term.line" && /还有任务在跑/.test(e.text))).toBe(true);
  });

  it("空会话（无历史）也能重跑：相当于清空后首发", async () => {
    const a = mkAgent();
    await a.rewindAndRun("从头来", { convId: "c1", backIndex: 0 });
    expect(a.handled.length).toBe(1);
    expect(a.conversations.get("c1").history).toEqual([]);
  });
});
