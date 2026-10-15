/* ============================================================
   P3-D3 自进化规则 · 提案层
   这一层唯一值得钉住的东西是"证据 → 提案"的判定：
   - 门槛必须是真的门槛（重复 1 次绝不提案，否则面板会被即兴偏好刷满）
   - 拒绝/拦截的分组键必须稳定（同一条规则的两条记录要合成一条提案，而不是两条）
   - 从 reason 里取的规则标签只认「命中拒绝规则 …」这一种句式，
     其它 block 原因（不可撤回、超时无应答）不是规则，不能拿去当提案标题
   - 人已裁决的状态要活得过重启：忽略过的不能再冒出来催
   这里一次 LLM 调用都没有，所以同输入必同输出，可以直接断言文本形状。
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

const RP = require("../server/rule-proposals");

let tmp, seq = 0;
function store() { return new RP.ProposalStore(path.join(tmp, "rp" + (++seq) + ".json")); }
const mem = (topic, content, type, ts) => ({ id: "m" + topic + content, topic, content, type: type || "lesson", ts: ts || Date.now(), archived: false });
const dec = (o) => Object.assign({ ts: Date.now(), kind: "gate", action: "block", tool: "run_command", subject: "x", reason: "" }, o);

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rp-")); });
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

describe("证据 → 候选", () => {
  it("同主题两条教训才提案，一条不算", () => {
    const one = RP.candidates({ entries: [mem("探针数据根", "第一条教训内容要够长才不会被当噪音", "lesson")], decisions: [] });
    expect(one).toHaveLength(0);
    const two = RP.candidates({ entries: [
      mem("探针数据根", "第一条教训内容要够长才不会被当噪音", "lesson"),
      mem("探针数据根", "第二条同主题教训，说的是另一件事", "error"),
    ], decisions: [] });
    expect(two).toHaveLength(1);
    expect(two[0]).toMatchObject({ source: "memory", title: "探针数据根", count: 2 });
    expect(two[0].statement).toContain("探针数据根");
    expect(two[0].statement).toContain("- 第一条教训");
  });

  it("preference / decision 类型不参与：那是偏好记录，不是反复踩到的坑", () => {
    const out = RP.candidates({ entries: [
      mem("界面口味", "喜欢深色", "preference"), mem("界面口味", "不要 emoji", "preference"),
      mem("选型", "选了 ws", "decision"), mem("选型", "定了 express", "decision"),
    ], decisions: [] });
    expect(out).toHaveLength(0);
  });

  it("归档记忆不算证据（已经被治理掉的东西不该复活成规则）", () => {
    const a = mem("同一主题", "内容一", "lesson"); a.archived = true;
    const out = RP.candidates({ entries: [a, mem("同一主题", "内容二", "lesson")], decisions: [] });
    expect(out).toHaveLength(0);
  });

  it("同一工具被连拒两次合成一条提案，一次不提案", () => {
    const once = RP.candidates({ entries: [], decisions: [dec({ kind: "approval", action: "rejected", tool: "delete_file", subject: "a.txt" })] });
    expect(once).toHaveLength(0);
    const twice = RP.candidates({ entries: [], decisions: [
      dec({ kind: "approval", action: "rejected", tool: "delete_file", subject: "a.txt", ts: 1000 }),
      dec({ kind: "approval", action: "rejected", tool: "delete_file", subject: "b.txt", ts: 2000 }),
      dec({ kind: "approval", action: "rejected", tool: "write_file", subject: "c.txt", ts: 3000 }),
    ] });
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatchObject({ source: "rejection", title: "delete_file 需先征得同意", count: 2 });
    expect(twice[0].statement).toContain("不要主动");
    expect(twice[0].evidence[0].text).toContain("b.txt");   // 新的在前
  });

  it("拒绝规则按标签分组：同一条撞两次是一条提案，不同标签各算各的", () => {
    const out = RP.candidates({ entries: [], decisions: [
      dec({ reason: "命中拒绝规则 src/** *.ts", tool: "edit_files", ts: 1000 }),
      dec({ reason: "命中拒绝规则 src/** *.ts", tool: "write_file", ts: 2000 }),
      dec({ reason: "命中拒绝规则 .env", tool: "read_file", ts: 3000 }),
    ] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "deny", title: "拒绝规则 src/** *.ts 是硬边界", count: 2 });
    expect(out[0].statement).toContain("不要换工具");
  });

  it("其它 block 原因不当规则：不可撤回、超时这些不是用户划的边界", () => {
    const out = RP.candidates({ entries: [], decisions: [
      dec({ reason: "删除不可撤回，即使全自动模式也要确认", ts: 1000 }),
      dec({ reason: "删除不可撤回，即使全自动模式也要确认", ts: 2000 }),
    ] });
    expect(out).toHaveLength(0);
  });

  it("hooks 拦下的同一工具重复两次也提案", () => {
    const out = RP.candidates({ entries: [], decisions: [
      dec({ kind: "hook", action: "block", tool: "run_command", reason: "hooks.pre deny", ts: 1000 }),
      dec({ kind: "hook", action: "block", tool: "run_command", reason: "hooks.pre deny", ts: 2000 }),
    ] });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("hook");
  });

  it("证据最多带 3 条，但次数按全部算；文本里的换行被压平", () => {
    const out = RP.candidates({ entries: [], decisions: [1, 2, 3, 4, 5].map((n) => dec({
      kind: "approval", action: "rejected", tool: "git_commit", subject: "多行\n主题 " + n, ts: n * 1000,
    })) });
    expect(out[0].count).toBe(5);
    expect(out[0].evidence).toHaveLength(3);
    expect(out[0].evidence[0].text).not.toContain("\n");
  });

  it("一模一样的证据合并成一行带 ×N，但次数仍按全部算", () => {
    const out = RP.candidates({ entries: [], decisions: [1, 2, 3, 4, 5].map((n) => dec({
      kind: "approval", action: "rejected", tool: "git_commit", subject: "同一个对象", ts: n * 1000,
    })) });
    expect(out[0].count).toBe(5);
    expect(out[0].evidence).toHaveLength(1);
    expect(out[0].evidence[0].text).toContain("×5");
    expect(out[0].statement).toContain("×5");
  });

  it("候选按最近证据时间倒序（面板先看最新的坑）", () => {
    const out = RP.candidates({ entries: [], decisions: [
      dec({ kind: "approval", action: "rejected", tool: "old_tool", ts: 1000 }),
      dec({ kind: "approval", action: "rejected", tool: "old_tool", ts: 1100 }),
      dec({ kind: "approval", action: "rejected", tool: "new_tool", ts: 9000 }),
      dec({ kind: "approval", action: "rejected", tool: "new_tool", ts: 9100 }),
    ] });
    expect(out.map((x) => x.title)).toEqual(["new_tool 需先征得同意", "old_tool 需先征得同意"]);
  });

  it("空输入不炸，返回空数组", () => {
    expect(RP.candidates({})).toEqual([]);
    expect(RP.candidates()).toEqual([]);
  });
});

describe("提案账本", () => {
  const cands = () => RP.candidates({ entries: [], decisions: [
    dec({ kind: "approval", action: "rejected", tool: "delete_file", ts: 1000 }),
    dec({ kind: "approval", action: "rejected", tool: "delete_file", ts: 2000 }),
    dec({ reason: "命中拒绝规则 src/**", ts: 3000 }),
    dec({ reason: "命中拒绝规则 src/**", ts: 4000 }),
  ] });

  it("sync 建 pending，同一证据再来一次不换 id（采纳用的 id 必须稳定）", async () => {
    const st = store();
    expect(st.sync(cands())).toBe(2);
    const before = st.list().map((x) => x.id).sort();
    await st._flush;
    expect(st.sync(RP.candidates({ entries: [], decisions: [
      dec({ kind: "approval", action: "rejected", tool: "delete_file", ts: 1000 }),
      dec({ kind: "approval", action: "rejected", tool: "delete_file", ts: 2000 }),
      dec({ kind: "approval", action: "rejected", tool: "delete_file", ts: 5000 }),
      dec({ reason: "命中拒绝规则 src/**", ts: 3000 }),
      dec({ reason: "命中拒绝规则 src/**", ts: 4000 }),
    ] }))).toBe(0);
    expect(st.list().map((x) => x.id).sort()).toEqual(before);
    expect(st.list().find((x) => x.source === "rejection").count).toBe(3);
  });

  it("忽略过的不再翻回待处理；证据消失后 pending 自动下架、已裁决留痕", () => {
    const st = store();
    st.sync(cands());
    const gone = st.list().find((x) => x.source === "deny");
    st.setStatus(gone.id, "dismissed");
    st.sync(RP.candidates({ entries: [], decisions: [
      dec({ kind: "approval", action: "rejected", tool: "delete_file", ts: 1000 }),
      dec({ kind: "approval", action: "rejected", tool: "delete_file", ts: 2000 }),
    ] }));
    expect(st.get(gone.id).status).toBe("dismissed");
    expect(st.list({ status: "pending" })).toHaveLength(1);
    expect(st.counts()).toMatchObject({ total: 2, dismissed: 1, pending: 1 });
  });

  it("采纳时把规则文件一并记下，重启后仍在（忽略/采纳绝不能刷新就没）", async () => {
    const st = store();
    st.sync(cands());
    const p = st.list()[0];
    st.setStatus(p.id, "adopted", { ruleFile: ".pancode/rules/evolve-x-a1b2.md" });
    await st._flush;
    const again = new RP.ProposalStore(st._path);
    expect(again.get(p.id)).toMatchObject({ status: "adopted", ruleFile: ".pancode/rules/evolve-x-a1b2.md" });
  });

  it("坏文件按空处理：提案可重扫，不该因为账本脏了让面板整片打不开", () => {
    const p = path.join(tmp, "rp-broken.json");
    fs.writeFileSync(p, "{ this is not json", "utf8");
    const st = new RP.ProposalStore(p);
    expect(st.size).toBe(0);
    expect(st.sync(cands())).toBe(2);
  });

  it("非法状态与未知 id 都返回 null（采纳端点靠这个判断要不要写文件）", () => {
    const st = store();
    st.sync(cands());
    expect(st.setStatus(st.list()[0].id, "已采纳")).toBeNull();
    expect(st.get("rp-none")).toBeNull();
    expect(st.setStatus("rp-none", "pending")).toBeNull();
  });
});
