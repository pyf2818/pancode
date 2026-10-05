/* 多根授权的真实链路探针（阶段二-2a）
 * 用真 LlmAgent + 真 FileStore + 真授权清单，只把 LLM 换成脚本（发哪几发 tool_call 是写死的），
 * 这样跑出来的就是"模型真的收到了什么回执、盘上真的发生了什么"，不是读代码的想象。
 *
 * 验的是六条底线：
 *   一、跨根**读**真的能读到（另一个项目里的文件内容进了 history），不带 root 时与单根时代一字不差；
 *   二、没授权的目录一律拒，而且**绝不回退**去读当前工作区里的同名文件（这是最阴的一种错）；
 *   三、只读授权读得到、写不进；可写授权的别的根可以跨根写，但**当前项目的 allow 规则不替它背书**
 *        （mode=semi 时必须问用户，见 ⑤b）；
 *   四、撤销授权立刻生效——实例还缓存在手里，下一次调用就已经够不着；
 *   五、规则**按根各一份**：只装当前根的规矩，碰过的根才补上它自己的，撤销后立刻停装（⑩）；
 *   六、跨根写/删不惊动前端编辑器（相对路径同名会撞车），而 /undo 会把文件放回**它自己那个根**（⑤c、⑨）。
 * 另加接线自检：新的 root 参数真的进了出网 schema，提示词里那句新规矩真的装配上了。
 */
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pc-multiroot-"));
const DATA = path.join(TMP, "data");
const ACTIVE = path.join(TMP, "ws");
const OTHER = path.join(TMP, "other-project");
const RO = path.join(TMP, "notes-readonly");
const OUTSIDE = path.join(TMP, "not-granted");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

/* ---------- 沙箱目录 ---------- */
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(ACTIVE, "src"), { recursive: true });
fs.writeFileSync(path.join(ACTIVE, "src", "a.js"), "当前根里的 A", "utf8");
fs.writeFileSync(path.join(ACTIVE, "leak.txt"), "当前根的内容", "utf8");
fs.mkdirSync(path.join(OTHER, "docs"), { recursive: true });
fs.writeFileSync(path.join(OTHER, "docs", "b.md"), "来自另一个项目的正文", "utf8");
fs.mkdirSync(path.join(OTHER, "src"), { recursive: true });
/* ⑤b 要用的"同形状文件"：当前根和别的根里各有一份 src/a.js，
   这样一旦 allow 规则按形状跨根背书，盘上就会被真的改掉，判定不会靠读代码猜。 */
fs.writeFileSync(path.join(OTHER, "src", "a.js"), "B", "utf8");
fs.writeFileSync(path.join(OTHER, "leak.txt"), "另一个项目的内容", "utf8");
fs.mkdirSync(RO, { recursive: true });
fs.writeFileSync(path.join(RO, "note.txt"), "只读目录里的备忘", "utf8");
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, "leak.txt"), "未授权目录的内容", "utf8");
/* 每个根都放一份自己的规矩，用来验"规则按根各一份"是不是真的：
   三句话互不相同，注入错了立刻看得见。 */
fs.writeFileSync(path.join(ACTIVE, "AGENTS.md"), "规矩AAA：本项目一律用 pnpm\n", "utf8");
fs.writeFileSync(path.join(OTHER, "AGENTS.md"), "规矩BBB：该项目一律用 yarn\n", "utf8");
fs.writeFileSync(path.join(RO, "AGENTS.md"), "规矩CCC：该目录只许读\n", "utf8");
/* ⑨ 要用的可写副本根：⑦ 已经把 OTHER 撤销了，这里另开一个干净的可授权根，
   免得"撤销"这一段的副作用串进后面的判定。 */
const DUAL = path.join(TMP, "writable-copy");
fs.mkdirSync(DUAL, { recursive: true });
fs.writeFileSync(path.join(DUAL, "victim.txt"), "原本的内容", "utf8");

/* ---------- 脚本化 LLM ---------- */
let plan = [];              // 每一步要发的 tool_call
let step = 0;
const outCalls = [];        // 出网的 tool_call 参数（验 schema 真的把 root 传出去了）
const toolResults = [];     // 模型实际收到的 tool 回执正文
const sysPrompts = [];      // 每次出网的 system 正文（验"改了常量真的进了提示词"）

const mockLlm = {
  async chatStream(cfg, messages, tools) {
    /* 一次请求的 system 是**好几条**消息（人格 / stable / turn），按条收集会把"完整装配"切碎——
       数某个注入块出现几次时，切碎的版本每条都不含完整前缀，永远数出 0。按请求聚合。 */
    const sysAll = messages.filter((m) => m.role === "system" && typeof m.content === "string")
      .map((m) => m.content).join("\n");
    if (sysAll) sysPrompts.push(sysAll);
    for (const m of messages) if (m.role === "tool" && typeof m.content === "string") {
      if (toolResults[toolResults.length - 1] !== m.content) toolResults.push(m.content);
    }
    if (tools && tools.length) {
      for (const t of tools) if (t.function && t.function.name === "read_file") outCalls.push(t.function.parameters);
    }
    if (tools === null || tools === undefined) return { content: "【任务目标】摘要", toolCalls: [], finish: "stop", usage: {} };
    /* 脚本只发 plan.length 轮，之后一律收尾。早先写成 Math.min(step, len-1) 会**无限重复最后一轮**，
       maxToolRounds 之内把同一发工具调用反复执行——审批问三遍、盘上写三遍，
       看起来像产品的双重确认 bug，其实全是探针自己的伪影。 */
    const cur = plan[step];
    step++;
    if (!cur || !cur.length) return { content: "完成。", toolCalls: [], finish: "stop", usage: { prompt_tokens: 500, completion_tokens: 5, total_tokens: 505 } };
    return {
      content: "",
      toolCalls: cur.map((c, i) => ({ id: "s" + step + "_" + i, name: c.name, arguments: JSON.stringify(c.args || {}) })),
      finish: "tool",
      usage: { prompt_tokens: 900, completion_tokens: 30, total_tokens: 930 },
    };
  },
  async ping() { return true; },
};

/* 数据根只能在这批模块被 require 之前定下来（config.js 在加载时算 ROOT）：
   晚一步就会把探针的会话/目标写进开发者真实的 .pancode。 */
process.env.PANCODE_DATA_DIR = DATA;
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "./llm") return mockLlm;
  return origLoad.apply(this, arguments);
};

const { LlmAgent } = require(path.join(__dirname, "..", "server", "agent-llm.js"));
const { FileStore } = require(path.join(__dirname, "..", "server", "files.js"));
const { RootGrants } = require(path.join(__dirname, "..", "server", "root-grants.js"));
const { RootStore } = require(path.join(__dirname, "..", "server", "root-store.js"));
const wsKey = require(path.join(__dirname, "..", "server", "ws-key.js"));

/* ---------- 真实件：清单 / 解析层 / 当前根 FileStore ---------- */
const grants = new RootGrants(path.join(DATA, ".pancode", "roots.json"), DATA);
const activeFiles = new FileStore(ACTIVE, path.join(DATA, ".pancode", "audit"));
const roots = new RootStore({ grants, dataRoot: DATA, auditDir: path.join(DATA, ".pancode", "audit") });
roots.setActive(ACTIVE, activeFiles);

const events = [];      // 内核事件流（卡片文案也在这里，能拿来断言"给人看的到底是哪家的文件"）
const agent = new LlmAgent({
  cfg: {
    llm: { baseURL: "http://mock", apiKey: "k", model: "m", maxToolRounds: 6, contextWindow: 200000 },
    permissions: { mode: "auto", allow: [], deny: [] },
    persona: { active: "default" }, rules: { enabled: true }, memory: { enabled: false },
    context: { budgetTokens: 1000000, autoCompact: false }, repoMap: false,
    workspace: "ws", timeouts: { toolSec: 30, approvalSec: 60 },
  },
  files: activeFiles,
  roots,
  emit: (ev) => { events.push(ev); },
  term: { run: async () => ({ out: "ok", code: 0 }) },
});
agent.running = false;
/* 写当前根的文件会走到 pushChanges()（它读 this.git 的改动列表）。
   探针不测 git，给一个"干净仓库"的桩：改动面板收到空列表，但写入链路是真的。 */
agent.git = { changes: async () => [], baseline: async () => null, dir: ACTIVE };

async function run(label, calls) {
  plan = [calls];
  step = 0;
  const before = toolResults.length;
  const sysBefore = sysPrompts.length;
  const evBefore = events.length;
  outCalls.length = 0;
  await agent.handleChat(label, { convId: "c-" + Math.random().toString(36).slice(2) });
  const res = toolResults.slice(before);
  res.sys = sysPrompts.slice(sysBefore).join("\n");   // 这一轮真正出网的 system 正文
  /* 一轮对话会发好几次请求（摘要/规划 + 工具轮 + 收尾轮），每份 system 都不一样长。
     要数"某个块出现几次"必须取**完整装配那一份**（最长的那份），
     取第一份会拿到摘要用的短提示词，数出来永远是 0 —— 那是探针的伪影不是产品的事实。 */
  res.one = (sysPrompts.slice(sysBefore).sort((a, b) => b.length - a.length)[0]) || "";
  res.events = events.slice(evBefore);                // 这一轮广播出去的事件（编辑器有没有被撞，看这里）
  return res;
}

(async () => {
  await grants.ensure(ACTIVE, "当前工作区");
  await grants.add({ path: OTHER, label: "另一个项目" });
  await grants.add({ path: RO, label: "备忘（只看）", writable: false });

  section("① 跨根读：真读到另一个项目里的文件");
  const r1 = await run("读另一个项目的文件", [{ name: "read_file", args: { path: path.join(OTHER, "docs", "b.md") } }]);
  ok("回执正文是那个目录里的内容", r1.some((x) => /来自另一个项目的正文/.test(x)), JSON.stringify(r1).slice(0, 220));
  ok("没有把当前工作区的内容混进来", !r1.some((x) => /当前根里的 A/.test(x)), JSON.stringify(r1).slice(0, 160));

  section("② 不带 root 的相对路径 = 当前工作区（单根行为逐字不变）");
  const r2 = await run("读本项目的文件", [
    { name: "read_file", args: { path: "src/a.js" } },
    { name: "list_files", args: {} },
  ]);
  ok("相对路径读到的还是当前根的文件", r2.some((x) => /当前根里的 A/.test(x)), JSON.stringify(r2).slice(0, 220));
  ok("list_files 不带 root 列的是当前根", r2.some((x) => /src\/a\.js/.test(x) && !/docs\/b\.md/.test(x)), JSON.stringify(r2).slice(0, 260));

  section("③ 未授权的目录：拒，而且绝不回退去读同名文件");
  const r3 = await run("读未授权目录", [
    { name: "read_file", args: { path: path.join(OUTSIDE, "leak.txt") } },
    { name: "read_file", args: { path: path.join(OUTSIDE, "sub", "a.js") } },
  ]);
  ok("回执里说清楚是没授权", r3.some((x) => /不在任何已授权的目录内/.test(x)), JSON.stringify(r3).slice(0, 240));
  ok("回执里给了可选项与「要用户去加授权」的路径", r3.some((x) => /必须由用户先把那个目录加入授权/.test(x)), JSON.stringify(r3).slice(0, 240));
  ok("没有回退读当前根的同名文件（最阴的一种错）", !r3.some((x) => /当前根的内容/.test(x)), JSON.stringify(r3).slice(0, 240));
  ok("也没有把未授权目录的内容漏出去", !r3.some((x) => /未授权目录的内容/.test(x)), JSON.stringify(r3).slice(0, 240));

  section("④ 只读授权：读得到，写不进");
  const r4 = await run("只读目录读写各一发", [
    { name: "read_file", args: { path: path.join(RO, "note.txt") } },
    { name: "write_file", args: { path: path.join(RO, "note.txt"), content: "覆盖它" } },
  ]);
  ok("只读根允许读", r4.some((x) => /只读目录里的备忘/.test(x)), JSON.stringify(r4).slice(0, 200));
  ok("写它被拒且理由是只读", r4.some((x) => /只读授权/.test(x) && /改成可写/.test(x)), JSON.stringify(r4).slice(0, 260));
  ok("盘上那个文件一字未改", fs.readFileSync(path.join(RO, "note.txt"), "utf8") === "只读目录里的备忘",
    fs.readFileSync(path.join(RO, "note.txt"), "utf8"));

  section("⑤ 跨根写：可写授权根写得住，只读与未授权一律拒");
  const r5 = await run("往另一个项目写", [
    { name: "write_file", args: { path: path.join(OTHER, "docs", "new.txt"), content: "跨根写的内容" } },
    { name: "write_file", args: { path: path.join(RO, "note.txt"), content: "覆盖它" } },
    { name: "write_file", args: { path: path.join(OUTSIDE, "nope.txt"), content: "x" } },
  ]);
  ok("可写授权根里真的建出了文件",
    fs.existsSync(path.join(OTHER, "docs", "new.txt")) &&
    fs.readFileSync(path.join(OTHER, "docs", "new.txt"), "utf8") === "跨根写的内容",
    "回执：" + JSON.stringify(r5).slice(0, 220));
  ok("回执带上了落在哪个目录（不让模型以为写的是本项目）",
    r5.some((x) => /另一个项目:docs\/new\.txt/.test(x) && x.includes(OTHER)), JSON.stringify(r5).slice(0, 260));
  ok("只读根被拒且理由带「只读」", r5.some((x) => /只读授权/.test(x)), JSON.stringify(r5).slice(0, 260));
  ok("未授权目录被拒", r5.some((x) => /不在任何已授权的目录内/.test(x)), JSON.stringify(r5).slice(0, 260));
  ok("只读根里的文件一字未改", fs.readFileSync(path.join(RO, "note.txt"), "utf8") === "只读目录里的备忘");
  ok("未授权目录里没有多出文件", !fs.existsSync(path.join(OUTSIDE, "nope.txt")), fs.readdirSync(OUTSIDE).join("、"));
  ok("跨根写没有把当前工作区的同名路径一起改掉", !fs.existsSync(path.join(ACTIVE, "docs")),
    "当前根里冒出了 docs：" + fs.readdirSync(ACTIVE).join("、"));

  /* 审计日志是**全根共用一份**：跨根写若不带根名，事后翻日志就答不出"到底改了哪个项目"。
     所以这里故意在当前根也写一个**同名相对路径**，两份必须在日志里分得开。 */
  await run("当前根也写一个同名的", [{ name: "write_file", args: { path: "docs/new.txt", content: "当前根的" } }]);
  const auditFile = path.join(DATA, ".pancode", "audit", new Date().toISOString().slice(0, 10) + ".log");
  const auditTxt = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "";
  const auditLines = auditTxt.split("\n").filter((l) => /\| fs \| write \| docs\/new\.txt \| root=/.test(l));
  ok("跨根写进审计日志时带上了是哪个根",
    auditLines.some((l) => l.toLowerCase().includes(OTHER.toLowerCase())), auditTxt.slice(-300));
  ok("同名的两份写各归各家（日志答得出改了哪个项目）",
    auditLines.some((l) => l.toLowerCase().includes(OTHER.toLowerCase())) &&
    auditLines.some((l) => l.toLowerCase().includes(ACTIVE.toLowerCase())),
    JSON.stringify(auditLines.map((l) => (l.match(/root=(.*)$/) || ["", "?"])[1])));

  section("⑤b 当前项目的 allow 规则不替别的根背书（mode=semi 时会问用户）");
  /* 这条是"跨根写"最容易被做错的地方：allow 规则写的是 src/** 这种相对形状，
     如果按形状判，A 项目里"src 可以改"就顺手放行了 B 项目的 src。 */
  agent.cfg.permissions = { mode: "semi", allow: [{ tool: "write_file", pattern: "src/**" }], deny: [] };
  let asked = [];
  agent.requestApproval = async (toolName, args) => { asked.push(args.path); return { approved: false, reason: "探针代拒" }; };
  const r5b = await run("带 allow 规则去跨根写", [
    { name: "write_file", args: { path: path.join(OTHER, "src", "a.js"), content: "改掉它" } },
  ]);
  ok("别的根里同形状的 src/** 没有被当前项目的 allow 放行（问了用户）",
    asked.some((p) => /other-project[\\/]src[\\/]a\.js$/.test(String(p))), JSON.stringify(asked));
  ok("只问一遍（跨根写的确认卡不重复弹）", asked.length === 1, "问了 " + asked.length + " 次：" + JSON.stringify(asked));
  ok("用户拒了就没写进去", fs.readFileSync(path.join(OTHER, "src", "a.js"), "utf8") === "B",
    fs.readFileSync(path.join(OTHER, "src", "a.js"), "utf8"));
  ok("当前工作区那份同形状的 src/a.js 也没被顺手改掉", fs.readFileSync(path.join(ACTIVE, "src", "a.js"), "utf8") === "当前根里的 A",
    fs.readFileSync(path.join(ACTIVE, "src", "a.js"), "utf8"));
  ok("回执把是哪家的文件说清楚了", r5b.some((x) => /用户拒绝了写入文件：另一个项目:src\/a\.js/.test(x)), JSON.stringify(r5b).slice(0, 260));

  /* 反向对照：allow 按那个目录自己的绝对路径写，就该放行跨根写。
     少了这一发，⑤b 上半段的"问了用户"可能只是因为 abs 判据压根没在工作。 */
  agent.cfg.permissions = {
    mode: "semi",
    allow: [{ tool: "write_file", pattern: OTHER.replace(/\\/g, "/") + "/src/**" }],
    deny: [],
  };
  asked = [];
  await run("用绝对路径的 allow 去跨根写", [
    { name: "write_file", args: { path: path.join(OTHER, "src", "a.js"), content: "改掉它" } },
  ]);
  ok("绝对路径的 allow 真的放行跨根写（没问用户、盘上确实改了）",
    asked.length === 0 && fs.readFileSync(path.join(OTHER, "src", "a.js"), "utf8") === "改掉它",
    "问了 " + asked.length + " 次，盘上：" + JSON.stringify(fs.readFileSync(path.join(OTHER, "src", "a.js"), "utf8")));
  ok("放行也没有波及当前工作区那份同名的 src/a.js",
    fs.readFileSync(path.join(ACTIVE, "src", "a.js"), "utf8") === "当前根里的 A");
  agent.cfg.permissions = { mode: "auto", allow: [], deny: [] };
  delete agent.requestApproval;

  section("⑤c 跨根写不惊动前端编辑器（同名相对路径会撞车）");
  /* 编辑器的模型按"工作区相对路径"认文件：跨根写 docs/new.txt 若照旧推 file.changed/editor.open，
     就会把当前工作区里同名的文件当成刚改的那个刷新一遍。 */
  fs.writeFileSync(path.join(ACTIVE, "docs.new.txt"), "", "utf8");   // 占位，证明当前根没被碰
  const r5c = await run("再写一次另一个项目", [
    { name: "write_file", args: { path: path.join(OTHER, "docs", "new.txt"), content: "第二次写" } },
  ]);
  const changedPaths = r5c.events.filter((e) => e.type === "file.changed" || e.type === "editor.open" || e.type === "editor.diff").map((e) => e.path);
  ok("没有推 file.changed/editor.open（那些只属于当前工作区）", changedPaths.length === 0, JSON.stringify(changedPaths));
  ok("改为在终端留一条痕，写明是哪个目录", r5c.events.some((e) => e.type === "term.line" && /\[跨根写入\] 另一个项目:docs\/new\.txt/.test(e.text || "")),
    JSON.stringify(r5c.events.filter((e) => e.type === "term.line").map((e) => e.text)).slice(0, 240));

  section("⑥ 其他根列目录：带 root 时能列出，且回执里说清是哪个目录");
  const r6 = await run("列另一个项目", [{ name: "list_files", args: { root: "另一个项目" } }]);
  ok("列出了那个根的文件", r6.some((x) => /docs\/b\.md/.test(x)), JSON.stringify(r6).slice(0, 260));
  ok("正文里标了这是哪个目录（两个项目同名文件不能看着一样）",
    r6.some((x) => /另一个项目 = /.test(x) && x.includes(OTHER)), JSON.stringify(r6).slice(0, 260));

  section("⑦ 撤销授权：实例还缓存着，下一次调用就已经够不着");
  const usedBefore = roots.liveCount();
  await grants.remove(wsKey.shardKey(OTHER, DATA));
  const r7 = await run("撤销后再读", [{ name: "read_file", args: { path: path.join(OTHER, "docs", "b.md") } }]);
  ok("撤销后再读被拒", r7.some((x) => /不在任何已授权的目录内/.test(x)), JSON.stringify(r7).slice(0, 240));
  ok("（对照）撤销前那个实例确实被缓存过，所以拒绝不是靠回收实现的", usedBefore > 1, "liveCount=" + usedBefore);

  section("⑧ 接线自检：root 参数真的在出网 schema 里，新规矩真的进了提示词");
  ok("read_file 的 schema 带 root 参数", !!outCalls.length && !!outCalls[0].properties.root,
    JSON.stringify(outCalls[0] || null).slice(0, 220));
  const joined = sysPrompts.join("\n");
  ok("出网的系统提示词里真的带了「只能碰用户授权过的目录」这条新规矩",
    /只能碰用户授权过的目录/.test(joined), "system 正文共 " + sysPrompts.length + " 段，里面没找到");
  ok("提示词说清只读授权不许写、不许删", /只读授权不许写、不许删/.test(joined), "缺这半句");
  ok("提示词说清当前项目的 allow 不替别的项目背书", /allow 规则不会替其他项目背书/.test(joined), "缺这半句");

  section("⑨ 未接线的工具仍被 safePath 挡；已接线的跨根删仍强制人工确认，且 /undo 能恢复");
  await grants.add({ path: DUAL, label: "可写副本" });
  /* delete_file 是不可逆操作：W14 那条"即使 auto 模式也强制人工确认"必须跨根同样生效。
     探针先代拒、再代批，两种结局都要落对。 */
  agent.requestApproval = async () => ({ approved: false, reason: "探针代拒" });
  const r9 = await run("越界与跨根删", [
    { name: "apply_edit", args: { path: path.join(DUAL, "victim.txt"), edits: [{ old_string: "原本的内容", new_string: "改掉它" }] } },
    { name: "delete_file", args: { path: path.join(DUAL, "victim.txt") } },
    { name: "write_file", args: { path: "../not-granted/hack.txt", content: "x" } },
  ]);
  ok("apply_edit 没接线，改不掉别的根（原文一字未动）",
    fs.readFileSync(path.join(DUAL, "victim.txt"), "utf8") === "原本的内容",
    "现在：" + fs.readFileSync(path.join(DUAL, "victim.txt"), "utf8"));
  ok("跨根删除问了用户（不可逆不因跨根而免确认）",
    r9.some((x) => /用户拒绝了删除文件：可写副本:victim\.txt/.test(x)), JSON.stringify(r9).slice(0, 260));
  ok("用户拒了就没删", fs.existsSync(path.join(DUAL, "victim.txt")));
  ok("相对 .. 拼出来的越界写也被挡", !fs.existsSync(path.join(OUTSIDE, "hack.txt")), JSON.stringify(r9).slice(0, 240));

  agent.requestApproval = async () => ({ approved: true, reason: "探针代批" });
  const r9b = await run("批准之后跨根删", [{ name: "delete_file", args: { path: path.join(DUAL, "victim.txt") } }]);
  ok("批准之后确实删掉了（回执说清是哪个目录）",
    !fs.existsSync(path.join(DUAL, "victim.txt")) && r9b.some((x) => /删除成功: 可写副本:victim\.txt/.test(x)),
    JSON.stringify(r9b).slice(0, 240));
  ok("终端留痕写明删的是哪个目录", r9b.events.some((e) => e.type === "term.line" && /\[跨根删除\]/.test(e.text || "")),
    JSON.stringify(r9b.events.filter((e) => e.type === "term.line").map((e) => e.text)).slice(0, 200));

  const evBeforeUndo = events.length;
  const restored = await agent._undoLast();
  const undoEvents = events.slice(evBeforeUndo);
  ok("/undo 把别的根里删掉的文件放回原处（不是放回当前工作区）",
    restored.ok === true && fs.existsSync(path.join(DUAL, "victim.txt")) &&
    fs.readFileSync(path.join(DUAL, "victim.txt"), "utf8") === "原本的内容",
    JSON.stringify(restored) + " 当前根里有没有冒出来：" + fs.existsSync(path.join(ACTIVE, "victim.txt")));
  ok("撤销跨根改动不推工作区面板（changes/editor.open/file.changed 只属于当前根）",
    !undoEvents.some((e) => e.type === "changes" || e.type === "editor.open" || e.type === "file.changed"),
    JSON.stringify(undoEvents.map((e) => e.type)));

  section("⑩ 规则按根各一份：只装了当前根的规矩，碰过的根才补上它自己的");
  /* 这是 #25 的前置：跨根写之前，必须保证"另一个项目的规矩"不会被当前项目的规矩替它做主。
     注入时机是**下一条消息**（本轮装配已经完成），探针按这个事实断，不假装是即时的。 */
  /* ①–⑨ 已经把 OTHER / RO 都碰过，会话根集合里带着残留。
     这一段要验的是"碰过才注入"，所以先把状态清干净，-controlled 地重新碰一次。 */
  agent._sessionRoots = new Set();
  agent.cfg.repoMap = true;      // 这一段顺带验"仓库结构按根各一份"（探针默认关着它）
  const g1 = await run("先只碰本项目", [{ name: "read_file", args: { path: "src/a.js" } }]);
  ok("当前根的 AGENTS.md 装进去了", /规矩AAA/.test(g1.sys), g1.sys.slice(0, 120));
  ok("没碰过的授权根，它的规矩不进来", !/规矩CCC/.test(g1.sys) && !/规矩BBB/.test(g1.sys),
    "不该出现的规则进来了");
  ok("提示词里列出了已授权的其他目录（不然模型不知道自己够得着）",
    /已授权的其他目录/.test(g1.sys) && g1.sys.includes(RO), g1.sys.match(/已授权的其他目录[\s\S]{0,180}/) ? "" : "整段没找到");
  ok("仓库结构只装了当前根那一份（没碰过的邻居项目不占每条消息）",
    (g1.one.match(/【仓库结构】/g) || []).length === 1 && !/【仓库结构 · /.test(g1.one),
    JSON.stringify((g1.one.match(/【仓库结构[^】]*】/g) || [])));

  const g2 = await run("读一下只读目录", [{ name: "read_file", args: { path: path.join(RO, "note.txt") } }]);
  ok("跨根读成功（回执里是那个目录的内容）", g2.some((x) => /只读目录里的备忘/.test(x)), JSON.stringify(g2).slice(0, 160));
  const g3 = await run("再问一次", [{ name: "list_files", args: {} }]);
  ok("碰过之后，下一条消息才带上那个根自己的规矩", /规矩CCC/.test(g3.sys), g3.sys.match(/规矩CCC/) ? "" : "未注入");
  ok("那条规矩带上是哪个根的（两个项目同名文件不能混为一谈）", /备忘（只看）\/AGENTS\.md|notes-readonly\/AGENTS\.md/.test(g3.sys),
    (g3.sys.match(/.{0,60}AGENTS\.md/g) || []).join(" | "));
  ok("碰过之后也带上那个项目的仓库结构（跨项目干活时「它长什么样」和「它的规矩」一样必需）",
    /【仓库结构 · 备忘（只看）\/】/.test(g3.one),
    JSON.stringify((g3.one.match(/【仓库结构[^】]*】/g) || [])));

  await grants.remove(wsKey.shardKey(RO, DATA));
  const g4 = await run("撤销之后再问", [{ name: "list_files", args: {} }]);
  ok("撤销授权后它的规矩立刻不再注入", !/规矩CCC/.test(g4.sys), "还在注入：" + (g4.sys.match(/.{0,40}规矩CCC.{0,40}/) || "")[0]);
  ok("已授权目录清单也跟着不再列它", !(g4.sys.includes(RO)), "清单里还留着那个路径");
  ok("它的仓库结构也跟着停装（撤了权限还在替它做决定就是漏）",
    !/【仓库结构 · /.test(g4.one), JSON.stringify((g4.one.match(/【仓库结构[^】]*】/g) || [])));

  console.log("\n" + (fail ? "\x1b[31mHAS FAIL\x1b[0m" : "\x1b[32mALL PASS\x1b[0m") + "：" + pass + " 通过 / " + fail + " 失败");
  if (fail) { for (const f of fails) console.log("  - " + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\x1b[31mFAIL:\x1b[0m " + (e && e.stack || e)); process.exit(1); });
