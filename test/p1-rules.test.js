/* ============================================================
   P1-#11 规则装配回归：stable/conditional 分桶 + 读取上限 + 用户全局层。

   守住的既有缺陷（旧实现真实存在，见 docs §11）：
     MAX_TOTAL 只是「渲染」预算，读取侧不设限。一个超过 12000 字符的根级 AGENTS.md
     会在 assemble 里作为第一个块直接把预算吃光 → break，结果它自己没注入，
     还连带把它后面的所有规则一起丢掉。表现是"规则写了、面板显示生效、模型没看见"。

   测试全部用临时目录 + 覆写 HOME/USERPROFILE，绝不碰真实的 ~/.pancode。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LlmAgent } = require("../server/agent-llm");

const RULES = ".pancode/rules";

/* FileStore.list() 的形状：返回相对 posix 路径，且按设计跳过一切点开头的名字。
   规则测试必须复刻这条"看不见点开头目录"的行为，否则测不到 listRuleDir 那条独立枚举路径。 */
function listLikeFileStore(root) {
  const out = [];
  const walk = (dir, rel) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const abs = path.join(dir, n), r = rel ? rel + "/" + n : n;
      let st;
      try { st = fs.statSync(abs); } catch (e) { continue; }
      if (st.isDirectory()) walk(abs, r);
      else out.push(r);
    }
  };
  walk(root, "");
  return out.sort();
}

function makeAgent(absRoot) {
  const a = Object.create(LlmAgent.prototype);
  a.files = {
    dir: absRoot,
    list: () => listLikeFileStore(absRoot),
    read: (p) => fs.readFileSync(path.join(absRoot, p.split("/").join(path.sep)), "utf8"),
  };
  return a;
}

/* 真实磁盘版：listRuleDir 走的是 fs.readdirSync，所以 dot 目录必须真存在 */
function writeRel(root, rel, text) {
  const p = path.join(root, rel.split("/").join(path.sep));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
  return p;
}

let tmp, home;
const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-rules-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-home-"));
  // os.homedir() 在调用时读环境变量（实测：Windows 取 USERPROFILE，POSIX 取 HOME）
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
});
afterEach(() => {
  Object.assign(process.env, realHome);
  for (const d of [tmp, home]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
});

describe("loadRulesParts：稳定段与按需段分开", () => {
  it("根级 AGENTS.md 与无条件 .pancode/rules 落 stable", () => {
    writeRel(tmp, "AGENTS.md", "# 项目约定\n统一用 pnpm");
    writeRel(tmp, RULES + "/always.md", "---\ndescription: 常量用大写\n---\n永远遵守");
    const a = makeAgent(tmp);
    const p = a.loadRulesParts([]);
    expect(p.stable.map((b) => b.label)).toContain("AGENTS.md");
    expect(p.stable.map((b) => b.label)).toContain(RULES + "/always.md");
    expect(p.conditional).toEqual([]);
  });

  it("带 globs 的规则只在碰到对应路径时进 conditional，不碰时完全不出现", () => {
    writeRel(tmp, RULES + "/sql.md", "---\nglobs: \"**/*.sql\"\nalwaysApply: false\n---\n禁止 SELECT *");
    const a = makeAgent(tmp);
    expect(a.loadRulesParts([]).conditional).toEqual([]);
    const hit = a.loadRulesParts(["queries/find.sql"]);
    expect(hit.conditional.map((b) => b.label)).toContain(RULES + "/sql.md");
    // 关键：命中的那条绝不进 stable —— 否则它就污染了本该逐字节不变的前缀
    expect(hit.stable.map((b) => b.label)).not.toContain(RULES + "/sql.md");
  });

  it("子目录 AGENTS.md 只在该目录被涉及时进 conditional", () => {
    writeRel(tmp, "AGENTS.md", "根约定");
    writeRel(tmp, "server/AGENTS.md", "服务端约定");
    const a = makeAgent(tmp);
    expect(a.loadRulesParts([]).conditional).toEqual([]);
    const hit = a.loadRulesParts(["server/agent-llm.js"]);
    expect(hit.conditional.map((b) => b.label)).toContain("server/AGENTS.md");
    expect(hit.stable.map((b) => b.label)).toEqual(["AGENTS.md"]);
  });

  it("同一会话连发两条不同输入：stable 逐字节不变，只有 conditional 随路径变", () => {
    writeRel(tmp, "AGENTS.md", "根约定：用 pnpm");
    writeRel(tmp, RULES + "/sql.md", "---\nglobs: \"**/*.sql\"\nalwaysApply: false\n---\n禁止 SELECT *");
    writeRel(tmp, RULES + "/always.md", "---\nalwaysApply: true\n---\n提交前跑 lint");
    const a = makeAgent(tmp);
    const t1 = a.loadRulesParts(["src/a.js"]);
    const t2 = a.loadRulesParts(["queries/b.sql"]);
    expect(JSON.stringify(t1.stable)).toBe(JSON.stringify(t2.stable));
    expect(t2.conditional.length).toBeGreaterThan(t1.conditional.length);
  });

  it("enabled: false 的规则一个字都不注入", () => {
    writeRel(tmp, RULES + "/off.md", "---\nenabled: false\ndescription: 停用\n---\n这段不该出现");
    const a = makeAgent(tmp);
    expect(a.loadRules([])).not.toContain("这段不该出现");
  });

  it("无 globs 且没写 always 的规则按「始终生效」处理（pancode 的既有语义，非 Cursor 的 alwaysApply:false）", () => {
    /* Cursor 里 alwaysApply:false + 无 globs = "由模型自行决定"；
       pancode 把它当始终注入。这里钉住现状，避免以后有人把它"修"成静默不注入——
       那种改法会让存量 .cursor/rules 悄悄失效。 */
    writeRel(tmp, RULES + "/plain.md", "---\nalwaysApply: false\n---\n仍然要注入");
    const a = makeAgent(tmp);
    expect(a.loadRules([])).toContain("仍然要注入");
  });
});

describe("读取与注入上限（旧实现的整段蒸发缺陷）", () => {
  it("根级 AGENTS.md 超长时不再把后续规则一起挤掉", () => {
    const huge = "A".repeat(40000);          // 远超旧的 MAX_TOTAL=12000
    writeRel(tmp, "AGENTS.md", huge);
    writeRel(tmp, RULES + "/keep.md", "---\nalwaysApply: true\n---\n这条必须活着");
    const a = makeAgent(tmp);
    const out = a.loadRules([]);
    expect(out).toContain("这条必须活着");   // 回归断言：修前这里整段为空
    expect(out).toContain("超过单文件注入上限");
    expect(out).toContain("AGENTS.md");
    // 截断必须如实告知原长度，不能让模型以为规则就这么长
    expect(out).toMatch(/本文件 40000 字符/);
  });

  it("单文件截断后长度受控，不吞掉整个预算", () => {
    writeRel(tmp, "AGENTS.md", "B".repeat(9000));
    const a = makeAgent(tmp);
    const p = a.loadRulesParts([]);
    expect(p.stable[0].content.length).toBeLessThan(8300);
  });

  it("磁盘侧超大文件不读进内存，只留一条说明", () => {
    const big = writeRel(tmp, "AGENTS.md", "x".repeat(300 * 1024));   // 300KB > RULE_READ_CAP
    const a = makeAgent(tmp);
    const readSpy = [];
    a.files.read = (p) => { readSpy.push(p); return "不该被调用"; };
    const out = a.loadRules([]);
    expect(readSpy).toEqual([]);            // 关键：连 files.read 都没碰过
    expect(out).toContain("超过读取上限");
    expect(out).toContain(String(fs.statSync(big).size));
    expect(out).not.toContain("不该被调用");
  });

  it("多个规则文件里的正文按 label 去重，同一文件不注入两遍", () => {
    writeRel(tmp, "AGENTS.md", "根约定");
    writeRel(tmp, "CLAUDE.md", "另一份约定");
    const a = makeAgent(tmp);
    const p = a.loadRulesParts([]);
    expect(p.stable.filter((b) => b.label === "AGENTS.md")).toHaveLength(1);
    expect(p.stable.map((b) => b.content).join("\n")).toContain("根约定");
    expect(p.stable.map((b) => b.content).join("\n")).toContain("另一份约定");
  });

  it("files.list() 抛错时退回空结果，不抛出到调用方（每条消息都会调它）", () => {
    const a = Object.create(LlmAgent.prototype);
    a.files = { dir: tmp, list: () => { throw new Error("boom"); }, read: () => "" };
    expect(a.loadRulesParts([])).toEqual({ stable: [], conditional: [] });
    expect(a.loadRules([])).toBe("");
  });
});

describe("用户全局层 ~/.pancode/AGENTS.md", () => {
  it("存在时作为 stable 的第一条注入，并标明跨项目生效", () => {
    writeRel(home, ".pancode/AGENTS.md", "回复一律用简体中文");
    writeRel(tmp, "AGENTS.md", "项目约定");
    const a = makeAgent(tmp);
    const p = a.loadRulesParts([]);
    expect(p.stable[0].label).toBe("~/.pancode/AGENTS.md");
    expect(p.stable[0].content).toContain("回复一律用简体中文");
    expect(p.stable[0].why).toContain("跨项目生效");
    expect(os.homedir()).toBe(home);        // 前提成立：这一层真的读的是临时 HOME
  });

  it("不存在时完全不产生该块（别注入一条空规则占位）", () => {
    const a = makeAgent(tmp);
    expect(a.loadRulesParts([]).stable.map((b) => b.label)).not.toContain("~/.pancode/AGENTS.md");
  });

  it("全局层里的 frontmatter 同样受 alwaysApply/globs 语义约束", () => {
    writeRel(home, ".pancode/AGENTS.md", "---\nglobs: \"**/*.py\"\nalwaysApply: false\n---\nPython 用 ruff");
    const a = makeAgent(tmp);
    expect(a.loadRules([])).not.toContain("Python 用 ruff");
  });

  it("项目级规则排在全局层之后（更具体的更靠近任务）", () => {
    writeRel(home, ".pancode/AGENTS.md", "全局：偏保守");
    writeRel(tmp, "AGENTS.md", "项目：偏快速");
    const out = makeAgent(tmp).loadRules([]);
    expect(out.indexOf("全局：偏保守")).toBeLessThan(out.indexOf("项目：偏快速"));
  });
});

describe("resolveReadableRule：只读通道的白名单边界", () => {
  /* /api/rules/content 是"看正文"的通道，判定函数同时是安全边界。
     这里是形状白名单而不是黑名单，所以测试的重点是"意料之外的形状必须被拒"。 */
  const rulesLib = require("../server/rules");
  const cand = LlmAgent.RULE_CANDIDATES;
  const R = (f) => rulesLib.resolveReadableRule("/tmp/root", f, cand);

  it("四种合法来源都放行并归类", () => {
    expect(R("AGENTS.md").kind).toBe("root");
    expect(R("CLAUDE.md").kind).toBe("root");
    expect(R(".pancode/rules/a.md").kind).toBe("pancode");
    expect(R(".cursor/rules/a.mdc").kind).toBe("cursor");
    expect(R("server/AGENTS.md").kind).toBe("diragents");
    expect(R("~/.pancode/AGENTS.md").kind).toBe("global");
  });

  it("只有 pancode 桶可编辑，其余只读", () => {
    expect(R(".pancode/rules/a.md").editable).toBe(true);
    for (const f of ["AGENTS.md", ".cursor/rules/a.mdc", "~/.pancode/AGENTS.md", "server/AGENTS.md"]) {
      expect(R(f).editable).toBe(false);
    }
  });

  it("越界与伪装形状一律拒绝", () => {
    const bad = [
      "", "../AGENTS.md", ".pancode/rules/../../secret.md", "/etc/passwd",
      "C:\\Windows\\win.ini", ".pancode/secrets.md", ".pancode/rules/a.exe",
      ".cursor/rules/a.sh", "server/notes.md", "~/.pancode/OTHER.md",
      "~/.ssh/id_rsa", "package.json", ".pancode/rules", "AGENTS.mdx",
    ];
    // 逐条报出是哪一条漏了，否则失败信息只说"不为 null"，定位不了
    const leaked = bad.filter((f) => R(f) !== null).map((f) => f + " → " + JSON.stringify(R(f)));
    expect(leaked).toEqual([]);
  });

  it("反斜杠路径先归一再判定（Windows 输入不能绕过）", () => {
    expect(R(".pancode\\rules\\a.md").kind).toBe("pancode");
    expect(R("..\\..\\AGENTS.md")).toBeNull();
  });
});

describe("/api/rules 的同源契约", () => {
  /* server/index.js 的生效预览用一个挂了原型的替身调 loadRules，
     清单接口用 rulesLib.describe 分类。两条路都必须能看到用户全局层，
     否则面板会出现"预览里有、清单里无"——模型读了什么用户看不见。 */
  it("预览按 index.js 的真实调用形状跑得通", () => {
    writeRel(tmp, "AGENTS.md", "只有 files 也能读到");
    writeRel(tmp, RULES + "/x.md", "---\nalwaysApply: true\n---\n面板要显示这条");
    const probe = Object.create(LlmAgent.prototype);
    probe.files = makeAgent(tmp).files;
    const text = probe.loadRules([]);
    expect(text).toContain("只有 files 也能读到");
    expect(text).toContain("面板要显示这条");
  });

  it("rulesLib 能把用户全局层分类成独立来源（面板需要一个不误报为项目规则的标签）", () => {
    const rulesLib = require("../server/rules");
    expect(rulesLib.kindOf("~/.pancode/AGENTS.md", LlmAgent.RULE_CANDIDATES)).toBe("global");
    const rec = rulesLib.describe("~/.pancode/AGENTS.md", "跨项目偏好", "global", LlmAgent.RULE_CANDIDATES);
    expect(rec).toBeTruthy();
    expect(rec.kindLabel).toBe("用户全局规则");
    expect(rec.order).toBeLessThan(rulesLib.describe("AGENTS.md", "x", "workspace", LlmAgent.RULE_CANDIDATES).order);
  });

  it("Agent 读到的全局文件与面板读的是同一个路径", () => {
    writeRel(home, ".pancode/AGENTS.md", "同一份内容");
    const { _ctx } = require("../server/agent-llm");
    const gp = _ctx.userGlobalRulePath();
    expect(gp).toBe(path.join(home, ".pancode", "AGENTS.md"));
    expect(makeAgent(tmp).loadRules([])).toContain("同一份内容");
    expect(rulesLibRead(gp)).toContain("同一份内容");
  });
});

function rulesLibRead(p) { return fs.readFileSync(p, "utf8"); }
