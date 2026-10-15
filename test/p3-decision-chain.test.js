/* ============================================================
   P3-D1 决策链存储层（server/decision-log.js）
   钉住的是"观测面绝不能反噬主链路"这一条：
   - 没设数据根 / 目录写不了 → 记录照样返回、读返回空，绝不抛（权限门不能被日志卡住）
   - 半行（崩溃时截断的最后一行）跳过，而不是让整份决策链读不出来
   - kind / action 是白名单：写错的值归到 gate/none，而不是产出一行界面筛不出来的脏数据
   ============================================================ */
const fs = require("fs");
const path = require("path");
const os = require("os");

const DL = require("../server/decision-log");

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "decl-"));
  DL.setDecisionDir(path.join(tmp, "decisions"));
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

const file = () => path.join(tmp, "decisions", new Date().toISOString().slice(0, 10) + ".jsonl");

describe("记录与读回", () => {
  it("一条决策一行 JSONL，字段原样读回", () => {
    const rec = DL.recordDecision({ convId: "c1", kind: "approval", action: "approved", tool: "write_file", subject: "a.js", reason: "用户点了允许" });
    expect(rec.convId).toBe("c1");
    const back = DL.readDecisions({});
    expect(back.length).toBe(1);
    expect(back[0]).toMatchObject({ convId: "c1", kind: "approval", action: "approved", tool: "write_file", subject: "a.js" });
    expect(fs.readFileSync(file(), "utf8").trim().split("\n").length).toBe(1);
  });

  it("按会话与按种类过滤，互不串台", () => {
    DL.recordDecision({ convId: "A", kind: "gate", action: "allow", tool: "write_file" });
    DL.recordDecision({ convId: "B", kind: "choice", action: "picked", subject: "灰度" });
    expect(DL.readDecisions({ convId: "A" }).map((r) => r.kind)).toEqual(["gate"]);
    expect(DL.readDecisions({ kind: "choice" }).map((r) => r.subject)).toEqual(["灰度"]);
  });

  it("limit 截的是最新的尾巴，顺序仍是时间正序", () => {
    for (let i = 0; i < 5; i++) DL.recordDecision({ convId: "c", kind: "gate", action: "allow", subject: "s" + i });
    const last2 = DL.readDecisions({ limit: 2 });
    expect(last2.map((r) => r.subject)).toEqual(["s3", "s4"]);
  });

  it("未知 kind / action 归到 gate / none（界面筛得出，而不是留一行脏数据）", () => {
    const r = DL.recordDecision({ convId: "c", kind: "瞎写", action: "也瞎写" });
    expect(r.kind).toBe("gate");
    expect(r.action).toBe("none");
    expect(DL.readDecisions({ kind: "gate" }).length).toBe(1);
  });

  it("长理由与换行被压平截断（一行日志必须真的是一行）", () => {
    const r = DL.recordDecision({ convId: "c", kind: "gate", action: "block", reason: "第一行\n第二行" + "啊".repeat(600) });
    expect(r.reason).not.toContain("\n");
    expect(r.reason.length).toBeLessThanOrEqual(500);
    expect(fs.readFileSync(file(), "utf8").trim().split("\n").length).toBe(1);
  });

  it("detail 给对象也能存成字符串", () => {
    const r = DL.recordDecision({ convId: "c", kind: "choice", action: "picked", detail: { options: ["蓝绿", "灰度"] } });
    expect(String(r.detail)).toContain("蓝绿");
  });
});

describe("观测面不能反噬主链路", () => {
  it("没设数据根：记录照样返回，读返回空数组，不抛", () => {
    DL.setDecisionDir(null);
    expect(() => DL.recordDecision({ convId: "c", kind: "gate", action: "allow" })).not.toThrow();
    expect(DL.readDecisions({})).toEqual([]);
    expect(DL.decisionDates()).toEqual([]);
  });

  it("半行（崩溃截断）跳过，其余照旧读得出", () => {
    DL.recordDecision({ convId: "c", kind: "gate", action: "allow", subject: "好的那条" });
    fs.appendFileSync(file(), '{"convId":"c","kind":"gate","actio');   // 模拟写到一半掉电
    const rows = DL.readDecisions({});
    expect(rows.length).toBe(1);
    expect(rows[0].subject).toBe("好的那条");
  });

  it("目录变成一个文件（写不进去）：记录不抛，读返回空", () => {
    DL.setDecisionDir(path.join(tmp, "not-a-dir"));
    fs.writeFileSync(path.join(tmp, "not-a-dir"), "我是文件");
    expect(() => DL.recordDecision({ convId: "c", kind: "gate", action: "allow" })).not.toThrow();
    expect(DL.readDecisions({})).toEqual([]);
  });

  it("decisionDates 只认 YYYY-MM-DD.jsonl，按日期倒序", () => {
    fs.mkdirSync(path.join(tmp, "decisions"), { recursive: true });
    ["2026-10-12", "2026-10-14", "2026-10-13"].forEach((d) => fs.writeFileSync(path.join(tmp, "decisions", d + ".jsonl"), ""));
    fs.writeFileSync(path.join(tmp, "decisions", "notes.md"), "别算进来");
    expect(DL.decisionDates()).toEqual(["2026-10-14", "2026-10-13", "2026-10-12"]);
  });
});

describe("白名单与界面同源", () => {
  it("界面用到的 kind / action 都在白名单里（漏一个就会静默变成 gate/none）", () => {
    const uiKinds = ["gate", "approval", "choice", "grant", "compact", "mode", "hook"];
    const uiActions = ["allow", "block", "approved", "rejected", "timeout", "picked", "cancelled", "granted", "compressed", "abandoned", "switched"];
    expect(DL.KINDS.sort()).toEqual(uiKinds.slice().sort());
    for (const a of uiActions) expect(DL.ACTIONS).toContain(a);
  });
});
