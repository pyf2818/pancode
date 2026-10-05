/* 阶段二-24 规则按根各一份：碰过的根才注入、单根逐字不变、撤销后立刻停装、超限要说明 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LlmAgent } = require("../server/agent-llm");
const { FileStore } = require("../server/files");
const { RootGrants } = require("../server/root-grants");
const { RootStore } = require("../server/root-store");
const { wsIndexFile } = require("../server/code-index");
const { shardKey } = require("../server/ws-key");

let TMP = "", HOME = "", DATA = "", WS = "", OTHER = "", THIRD = "", grants, roots, wsStore, savedHome = [];

const mk = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, "utf8"); };
const labels = (r) => r.stable.map((b) => b.label).concat(r.conditional.map((b) => b.label));
const contents = (r) => r.stable.map((b) => b.content).concat(r.conditional.map((b) => b.content)).join("\n");

function makeAgent(withRoots) {
  const a = Object.create(LlmAgent.prototype);
  a.files = wsStore;
  if (withRoots) a.roots = roots;
  return a;
}

beforeEach(async () => {
  TMP = mk(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pc-rootrules-")), "root"));
  HOME = mk(path.join(TMP, "home")); DATA = mk(path.join(TMP, "data"));
  WS = mk(path.join(TMP, "ws")); OTHER = mk(path.join(TMP, "other")); THIRD = mk(path.join(TMP, "third"));
  write(path.join(HOME, ".pancode", "AGENTS.md"), "全局：一律用中文注释");
  write(path.join(WS, "AGENTS.md"), "本项目的约定 A");
  write(path.join(OTHER, "AGENTS.md"), "另一个项目的约定 B");
  write(path.join(THIRD, "AGENTS.md"), "第三个项目的约定 C");
  savedHome = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = HOME; process.env.USERPROFILE = HOME;
  grants = new RootGrants(path.join(DATA, ".pancode", "roots.json"), DATA);
  await grants.ensure(WS, "当前工作区");
  await grants.add({ path: OTHER, label: "另一个项目" });
  await grants.add({ path: THIRD, label: "第三个" });
  wsStore = new FileStore(WS, null);
  roots = new RootStore({ grants, dataRoot: DATA, auditDir: null });
  roots.setActive(WS, wsStore);
});
afterEach(() => {
  process.env.HOME = savedHome[0]; process.env.USERPROFILE = savedHome[1];
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

describe("单根回归底线", () => {
  it("只用当前根时，装配结果与迁移前的调用形状逐字相同", () => {
    const before = LlmAgent.prototype.loadRulesParts.call({ files: wsStore }, []);   // /api/rules 预览用的裸形状
    const after = makeAgent(true).loadRulesParts([]);                                 // 接了多根之后
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("没有 roots 字段（老 ctx / 假 agent）也不崩，仍只装当前根", () => {
    const r = makeAgent(false).loadRulesParts([]);
    expect(labels(r)).toContain("AGENTS.md");
    expect(contents(r)).toContain("本项目的约定 A");
  });
});

describe("按根各一份", () => {
  it("没碰过的授权根不注入：授权 ≠ 把它的规则塞进每条消息", () => {
    const r = makeAgent(true).loadRulesParts([]);
    expect(contents(r)).not.toMatch(/另一个项目的约定 B/);
    expect(contents(r)).not.toMatch(/第三个项目的约定 C/);
  });

  it("碰过的根才注入，并且标签带上是哪个根", () => {
    const a = makeAgent(true);
    a.noteSessionRoot(shardKey(OTHER, DATA));
    const r = a.loadRulesParts([]);
    expect(contents(r)).toContain("另一个项目的约定 B");
    expect(labels(r)).toContain("另一个项目/AGENTS.md");
    expect(contents(r)).not.toMatch(/第三个项目的约定 C/);
  });

  it("两个根同名的规则文件不会互相吞掉（各自一条，内容不串）", () => {
    const a = makeAgent(true);
    a.noteSessionRoot(shardKey(OTHER, DATA));
    const r = a.loadRulesParts([]);
    const as = labels(r).filter((l) => /AGENTS\.md$/.test(l) && l.charAt(0) !== "~");   // 去掉用户全局层那条
    expect(as).toContain("AGENTS.md");
    expect(as).toContain("另一个项目/AGENTS.md");
    expect(as.length).toBe(2);
  });

  it("撤销授权后立刻停装，并把会话集合里的残留清掉", async () => {
    const a = makeAgent(true);
    const id = shardKey(OTHER, DATA);
    a.noteSessionRoot(id);
    expect(contents(a.loadRulesParts([]))).toContain("另一个项目的约定 B");
    await grants.remove(id);
    expect(contents(a.loadRulesParts([]))).not.toMatch(/另一个项目的约定 B/);
    expect(a._sessionRoots.has(id)).toBe(false);
  });

  it("用户全局层只注入一次，不因为多装了一个根就重复一遍", () => {
    const a = makeAgent(true);
    a.noteSessionRoot(shardKey(OTHER, DATA));
    const n = labels(a.loadRulesParts([])).filter((l) => /AGENTS\.md$/.test(l) && l.indexOf("~") === 0).length;
    expect(n).toBe(1);
  });

  it("授权根超过上限时明说被截断，不许静默少装", async () => {
    const a = makeAgent(true);
    const more = [];
    for (let i = 0; i < 4; i++) {
      const d = mk(path.join(TMP, "extra" + i));
      write(path.join(d, "AGENTS.md"), "额外约定 " + i);
      await grants.add({ path: d, label: "额外" + i });
      more.push(shardKey(d, DATA));
    }
    for (const id of more) a.noteSessionRoot(id);
    const r = a.loadRulesParts([]);
    const injected = r.stable.concat(r.conditional).filter((b) => /^额外\d\/AGENTS\.md$/.test(b.label));
    expect(injected.length).toBe(3);              // 恰好是上限：既没超，也没静默少装
    expect(labels(r).join("\n")).toMatch(/规则未注入/);
    expect(contents(r)).toMatch(/read_file/);   // 得告诉模型怎么自己去看
  });
});

describe("代码索引本来就分根（阶段一键统一的直接收益）", () => {
  it("两个目录各自一个索引文件，文件名就是唯一的分片键", () => {
    const a = wsIndexFile(WS), b = wsIndexFile(OTHER);
    expect(a).not.toBe(b);
    expect(path.basename(a)).toBe(shardKey(WS, DATA) + ".json");
    expect(path.basename(b)).toBe(shardKey(OTHER, DATA) + ".json");
  });
});
