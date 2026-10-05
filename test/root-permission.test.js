/* 阶段二-25 跨根写的权限判定：两份形态（根内相对 / 根限定绝对），
   deny 命中任一份即拦（保护面只增不减），allow 只认绝对形态（当前项目的规则不替别的项目背书）。
   单根时两份相同 → 判定结果必须与迁移前逐字一致，这是这条改动的底线。 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LlmAgent } = require("../server/agent-llm");
const { FileStore } = require("../server/files");
const { RootGrants } = require("../server/root-grants");
const { RootStore } = require("../server/root-store");
const { shardKey } = require("../server/ws-key");

let TMP, DATA, WS, OTHER;

function mk(p) { fs.mkdirSync(p, { recursive: true }); return p; }

/* 授权清单只摆内存行：这测的是判定，不是落盘（落盘在 roots.test.js 里已经钉过） */
function makeAgent(perm) {
  const grants = new RootGrants(path.join(DATA, ".pancode", "roots.json"), DATA);
  grants.rows = [
    { id: shardKey(WS, DATA), path: WS, writable: true, label: "当前工作区", source: "workspace" },
    { id: shardKey(OTHER, DATA), path: OTHER, writable: true, label: "另一个项目", source: "manual" },
  ];
  const store = new RootStore({ grants, dataRoot: DATA, auditDir: null });
  store.setActive(WS, new FileStore(WS, null));
  const a = Object.create(LlmAgent.prototype);
  a.cfg = { permissions: perm || { mode: "semi", allow: [], deny: [] } };
  a.files = new FileStore(WS, null);
  a.roots = store;
  return a;
}

const abs = (dir, rel) => path.join(dir, rel.split("/").join(path.sep));
const fwd = (p) => String(p).replace(/\\/g, "/");

beforeEach(() => {
  TMP = mk(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pc-rperm-")), "root"));
  DATA = mk(path.join(TMP, "data")); WS = mk(path.join(TMP, "ws")); OTHER = mk(path.join(TMP, "other"));
  mk(path.join(WS, "src")); mk(path.join(OTHER, "src"));
  fs.writeFileSync(abs(WS, "src/a.js"), "A", "utf8");
  fs.writeFileSync(abs(OTHER, "src/a.js"), "B", "utf8");
});
afterEach(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

describe("两份形态", () => {
  it("当前根：abs 与 rel 逐字相同（相对写法和绝对写法都是）——单根判定不变的根因", () => {
    const a = makeAgent();
    const relWay = a._subjectForms("write_file", { path: "src/a.js" });
    expect(relWay.abs).toEqual(relWay.rel);
    const absWay = a._subjectForms("write_file", { path: fwd(abs(WS, "src/a.js")) });
    expect(absWay.abs).toEqual(absWay.rel);
    // 绝对写法的 rel 会带上盘符外的全部前缀（canonicalRulePath 只抹盘符），这是既有语义，不改
    expect(absWay.rel.length).toBe(1);
  });

  it("跨根：abs 保得住是哪个根，rel 保不住（这正是不能靠 rel 授权的原因）", () => {
    const a = makeAgent();
    const f = a._subjectForms("write_file", { path: fwd(abs(OTHER, "src/a.js")) });
    expect(f.abs[0]).toBe(fwd(abs(OTHER, "src/a.js")));
    expect(f.abs[0].endsWith("/other/src/a.js")).toBe(true);
    expect(f.abs).not.toEqual(f.rel);
  });

  it("非路径类工具仍然返回 null（命令类走原来的文本主体）", () => {
    const a = makeAgent();
    expect(a._subjectForms("run_command", { command: "npm test" })).toBe(null);
  });

  it("老 ctx 没有 roots：abs 退回与 rel 相同，不改变任何既有判定", () => {
    const a = makeAgent();
    delete a.roots;
    const f = a._subjectForms("write_file", { path: fwd(abs(OTHER, "src/a.js")) });
    expect(f.abs).toEqual(f.rel);
  });
});

describe("allow 不跨根背书", () => {
  it("本项目写的 allow src/** 放行本项目的文件", () => {
    const a = makeAgent({ mode: "semi", allow: [{ tool: "write_file", pattern: "src/**" }], deny: [] });
    expect(a._approvalDecision("write_file", { path: "src/a.js" }).action).toBe("allow");
  });

  it("同一条 allow 不能放行另一个项目里同形状的文件", () => {
    const a = makeAgent({ mode: "semi", allow: [{ tool: "write_file", pattern: "src/**" }], deny: [] });
    const d = a._approvalDecision("write_file", { path: fwd(abs(OTHER, "src/a.js")) });
    expect(d.action).not.toBe("allow");
    expect(d.action).toBe("ask");   // 退回到问用户，而不是"这边放行过就算那边也放行"
  });

  it("想跨根放行就得按那个目录自己写规则（绝对形态，大小写不敏感）", () => {
    const a = makeAgent({ mode: "semi", allow: [{ tool: "write_file", pattern: fwd(abs(OTHER, "src")) + "/**" }], deny: [] });
    const d = a._approvalDecision("write_file", { path: fwd(abs(OTHER, "src/a.js")) });
    expect(d.action).toBe("allow");
    // 反过来：这条绝对规则不该顺手放行当前项目自己的 src
    expect(a._approvalDecision("write_file", { path: "src/a.js" }).action).toBe("ask");
  });

  it("多文件补丁：只覆盖住其中一个就不算被授权（every 语义叠加不跨根）", () => {
    const a = makeAgent({ mode: "semi", allow: [{ tool: "write_file", pattern: "src/**" }], deny: [] });
    const d = a._approvalDecision("write_file", {
      edits: [{ path: "src/a.js" }, { path: fwd(abs(OTHER, "src/a.js")) }],
    });
    expect(d.action).not.toBe("allow");
  });

  /* 三份形态全被抹空是真实可达的（path 写成 "." 或 "/"：canonicalRulePath 只剩空串），
     而 [].every() 恒为 true —— 少一道长度守卫就等于"路径越怪，越不用问用户"。 */
  it("形态全为空的路径（\".\"）不许白嫖 allow", () => {
    const a = makeAgent({ mode: "semi", allow: [{ tool: "write_file", pattern: "docs/**" }], deny: [] });
    expect(a._subjectForms("write_file", { path: "." }).abs).toEqual([]);
    expect(a._approvalDecision("write_file", { path: "." }).action).toBe("ask");
    expect(a._approvalDecision("write_file", { edits: [{ path: "." }] }).action).toBe("ask");
  });
});

describe("deny 保护面只增不减", () => {
  it("按形状写的拒绝规则照样拦得住别的根（abs 那份命中 **/*.env）", () => {
    const a = makeAgent({ mode: "auto", allow: [], deny: [{ tool: "write_file", pattern: "**/*.env" }] });
    const foreign = { path: fwd(abs(OTHER, "config/.env")) };
    expect(a._subjectForms("write_file", foreign).abs[0].endsWith("/config/.env")).toBe(true);
    expect(a._approvalDecision("write_file", foreign).action).toBe("block");
  });

  it("按绝对路径写的拒绝规则也能拦住别的根（abs 那份命中）", () => {
    const a = makeAgent({ mode: "auto", allow: [], deny: [{ tool: "write_file", pattern: fwd(abs(OTHER, "secret")) + "/**" }] });
    expect(a._approvalDecision("write_file", { path: fwd(abs(OTHER, "secret/k.txt")) }).action).toBe("block");
  });

  it("当前项目的文件仍然照旧被 deny 拦住（没因为加了 abs 而漏判）", () => {
    const a = makeAgent({ mode: "auto", allow: [], deny: [{ tool: "delete_file", pattern: "src/**" }] });
    expect(a._approvalDecision("delete_file", { path: "src/a.js" }).action).toBe("block");
  });

  /* 既有漏判（这轮实测发现的）：path 写成工作区内的绝对路径时，rel 形态会带上一长串前缀，
     于是 deny "src/**" 拦不住同一次改动。补一份"归属后的根内相对形状"专治这条——
     只加 deny 的覆盖面，allow 仍然只认 abs，所以不会顺手放宽任何权限。 */
  it("写成工作区内的绝对路径也别想绕过 deny", () => {
    const a = makeAgent({ mode: "auto", allow: [], deny: [{ tool: "write_file", pattern: "src/**" }] });
    const f = a._subjectForms("write_file", { path: fwd(abs(WS, "src/a.js")) });
    expect(f.shape).toContain("src/a.js");
    expect(a._approvalDecision("write_file", { path: fwd(abs(WS, "src/a.js")) }).action).toBe("block");
  });

  it("补形状只加拒绝面，不放宽放行面", () => {
    const a = makeAgent({ mode: "semi", allow: [{ tool: "write_file", pattern: "src/**" }], deny: [] });
    // 绝对写法仍然不因为 shape 存在就被 allow 放行：allow 只看 abs（= 今天的样子）
    expect(a._approvalDecision("write_file", { path: fwd(abs(WS, "src/a.js")) }).action).toBe("ask");
  });

  it("跨根删除：命中 deny 也是 block，而不是先问一遍再删", () => {
    const a = makeAgent({ mode: "auto", allow: [], deny: [{ tool: "delete_file", pattern: "**/*.key" }] });
    const d = a._approvalDecision("delete_file", { path: fwd(abs(OTHER, "tls/server.key")) });
    expect(d.action).toBe("block");
  });
});

describe("不可逆操作不受跨根影响", () => {
  it("跨根删除即使在 auto 模式、且 allow 明确覆盖，也必须落到 ask（人工确认）", () => {
    const a = makeAgent({ mode: "auto", allow: [{ tool: "delete_file", pattern: fwd(abs(OTHER, "**")) }], deny: [] });
    const d = a._approvalDecision("delete_file", { path: fwd(abs(OTHER, "src/a.js")) });
    expect(d.action).toBe("ask");
    expect(d.reason).toMatch(/不可逆/);
  });
});
