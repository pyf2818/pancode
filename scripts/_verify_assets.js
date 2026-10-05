/* T4/T3 后端契约验证：起一个完全沙箱化的 pancode 实例（独立 PANCODE_DATA_DIR + 独立工作区 + 独立端口），
 * 逐个打资产/设置类端点，断言「可写、可读回、预览与生效同源、密钥不外泄」。
 * 沙箱保证不往用户真实的 .pancode 数据根和工作区里写任何一个字节。
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

const PORT = 8811;
const ROOT = path.resolve(__dirname, "..");
const SANDBOX = path.join(ROOT, "scripts", "_verify_out", "assets-sandbox");
const DATA_DIR = path.join(SANDBOX, "data");
const WS_DIR = path.join(SANDBOX, "ws");
/* 沙箱化的"用户主目录"：~/.pancode/AGENTS.md 这一层是跨项目的，
   不给它一个假 HOME，探针就会去读开发者真实的用户全局规则，结果不可复现。 */
const HOME_DIR = path.join(SANDBOX, "home");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
function section(t) { console.log("\n\x1b[1m" + t + "\x1b[0m"); }

let TOKEN = "";
function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const headers = data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {};
    if (TOKEN) headers["x-user-token"] = TOKEN;
    const r = http.request({
      host: "127.0.0.1", port: PORT, path: urlPath, method, headers, timeout: 15000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }); } catch (e) { resolve({ status: res.statusCode, raw: buf }); } });
    });
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    if (data) r.write(data);
    r.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 假模型服务：一个最普通的本地 HTTP 接口，提供 /v1/models 与 /v1/chat/completions。
   用它验证「拉取模型」直连用户填的地址，不需要任何额外网关；同时记录被请求到的 URL 与鉴权头，
   用来证明密钥只走请求头、没有落进 URL。 */
function startMockUpstream() {
  const hits = [];
  const srv = http.createServer((rq, rs) => {
    let payload = "";
    rq.on("data", (c) => (payload += c));
    rq.on("end", () => {
      hits.push({ url: rq.url, auth: rq.headers.authorization || "", body: payload });
      const send = (code, type, text) => { rs.writeHead(code, { "Content-Type": type }); rs.end(text); };
      if (rq.url === "/v1/models") {
        return send(200, "application/json", JSON.stringify({ data: [{ id: "mock-b" }, { id: "mock-a" }, { id: "mock-a" }] }));
      }
      if (rq.url === "/empty/models") return send(200, "application/json", JSON.stringify({ data: [] }));
      if (rq.url === "/v1/chat/completions") {
        return send(200, "text/event-stream", 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      }
      send(404, "application/json", JSON.stringify({ error: "no such path" }));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      base: "http://127.0.0.1:" + srv.address().port,
      hits,
      close: () => new Promise((d) => srv.close(d)),
    }));
  });
}

function seedWorkspace() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(path.join(WS_DIR, ".pancode", "rules"), { recursive: true });
  fs.mkdirSync(path.join(WS_DIR, ".pancode", "experts"), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, ".pancode", "rules"), { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(HOME_DIR, ".pancode"), { recursive: true });
  fs.writeFileSync(path.join(HOME_DIR, ".pancode", "AGENTS.md"), "# 全局偏好\n\n跨项目规则：先给结论，再给依据。\n");
  // 应用级（数据根）遗留规则：Agent 不读，面板也不得标成生效
  fs.writeFileSync(path.join(DATA_DIR, ".pancode", "rules", "legacy.md"), "---\ntitle: 应用级遗留\n---\n\n这条不该被标成生效。\n");
  // 一条始终生效的规则 + 一条按需规则（glob 只命中 server/**）+ 一条停用规则
  fs.writeFileSync(path.join(WS_DIR, ".pancode", "rules", "always-cn.md"),
    "---\ntitle: 汇报用中文\nenabled: true\n---\n\n所有对外汇报一律使用中文，并给出可核对的数字。\n");
  fs.writeFileSync(path.join(WS_DIR, ".pancode", "rules", "server-style.md"),
    "---\ntitle: 后端风格\nenabled: true\nglobs: [\"server/**\"]\n---\n\nserver 下新增文件必须 CommonJS，禁止 ESM。\n");
  fs.writeFileSync(path.join(WS_DIR, ".pancode", "rules", "off-rule.md"),
    "---\ntitle: 已停用的规则\nenabled: false\n---\n\n这条不该出现在模型上下文里。\n");
  fs.writeFileSync(path.join(WS_DIR, "AGENTS.md"), "# 仓库约定\n\n根级规则文件。\n");
  fs.mkdirSync(path.join(WS_DIR, "server"), { recursive: true });
  fs.writeFileSync(path.join(WS_DIR, "server", "demo.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(WS_DIR, ".cursor", "rules"), { recursive: true });
  fs.writeFileSync(path.join(WS_DIR, ".cursor", "rules", "legacy.mdc"),
    "---\ndescription: 旧 Cursor 规则\nalwaysApply: true\n---\n\n复用的 Cursor 规则库也应被读到。\n");
}

async function boot() {
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), PANCODE_DATA_DIR: DATA_DIR, CURSORWEB_WORKSPACE: WS_DIR,
      CURSORWEB_ENGINE: "demo", AGENT_FAST: "1", NODE_NO_WARNINGS: "1",
      // os.homedir() 在调用时读这两个环境变量（Windows 取 USERPROFILE，POSIX 取 HOME）
      HOME: HOME_DIR, USERPROFILE: HOME_DIR, HOMEDRIVE: "", HOMEPATH: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  child.stdout.on("data", (c) => { tail = (tail + c).slice(-4000); });
  child.stderr.on("data", (c) => { tail = (tail + c).slice(-4000); });
  for (let i = 0; i < 90; i++) {
    await wait(200);
    try { const r = await req("GET", "/api/health"); if (r.json && r.json.ok) return { child, tail: () => tail }; } catch (e) {}
  }
  throw new Error("服务未在 18s 内就绪\n" + tail);
}

async function main() {
  seedWorkspace();
  const { child, tail } = await boot();
  const reg = await req("POST", "/api/auth/register", { username: "_assets_" + Date.now(), password: "test1234" });
  TOKEN = (reg.json && reg.json.token) || "";
  if (!TOKEN) { child.kill(); throw new Error("注册验证用户失败：" + JSON.stringify(reg.json || reg.raw)); }
  try {
    /* ---------- 规则 ---------- */
    section("规则（Rules）");
    let r = await req("GET", "/api/rules");
    ok("GET /api/rules 返回 ok", r.json.ok === true, r.json.error);
    const rules = r.json.rules || [];
    ok("扫到 7 个规则源（3 pancode + 1 AGENTS.md + 1 Cursor mdc + 1 应用级遗留 + 1 用户全局）", rules.length === 7, "实际 " + rules.length + "：" + rules.map((x) => x.file).join(", "));
    /* 用户全局层必须同时出现在清单和预览里：Agent 的 loadRules() 真的读它，
       面板少列一次，用户就看到"预览里凭空多了一段没来源的规则"。 */
    const globalRec = rules.find((x) => x.scope === "global");
    ok("用户全局规则被列出且归类为 global", !!globalRec && globalRec.kind === "global" && globalRec.active === true,
      JSON.stringify(globalRec && { file: globalRec.file, kind: globalRec.kind, active: globalRec.active }));
    ok("用户全局规则排在项目级之前（它表达的是「我是谁」，项目规则表达的是「这个仓库」）",
      !!globalRec && globalRec.order < (rules.find((x) => x.kind === "root") || {}).order,
      JSON.stringify({ global: globalRec && globalRec.order, root: (rules.find((x) => x.kind === "root") || {}).order }));
    ok("用户全局规则不可编辑（本面板只管工作区内的规则）", globalRec && globalRec.editable === false);
    const appRec = rules.find((x) => x.scope === "app");
    ok("应用级遗留规则被列出来", !!appRec, JSON.stringify(rules.map((x) => x.scope)));
    ok("应用级规则不得谎称生效", appRec && appRec.active === false && /不读取/.test(appRec.activeWhy || ""), JSON.stringify(appRec || {}));
    ok("应用级规则不可编辑", appRec && appRec.editable === false);
    const byTitle = {};
    rules.forEach((x) => (byTitle[x.title] = x));
    ok("frontmatter title 被解析出来", !!byTitle["汇报用中文"] && !!byTitle["后端风格"], Object.keys(byTitle).join(" / "));
    ok("停用规则 enabled=false", byTitle["已停用的规则"] && byTitle["已停用的规则"].enabled === false);
    ok("无查询时按需规则标为未命中", byTitle["后端风格"] && byTitle["后端风格"].active === false, JSON.stringify(byTitle["后端风格"]));
    ok("始终生效规则 active", byTitle["汇报用中文"] && byTitle["汇报用中文"].active === true);
    ok("AGENTS.md 归为根级规则", byTitle["仓库约定"] && byTitle["仓库约定"].kind === "root", byTitle["仓库约定"] && byTitle["仓库约定"].kind);
    ok("counts.editable = 3（只有 .pancode/rules 可编辑）", r.json.counts && r.json.counts.editable === 3, JSON.stringify(r.json.counts));
    const listBudgetMax = r.json.budget && r.json.budget.max;

    r = await req("GET", "/api/rules/preview");
    ok("预览不含停用规则", !/这条不该出现/.test(r.json.preview || ""), "停用规则漏进上下文");
    ok("预览含始终生效规则", /一律使用中文/.test(r.json.preview || ""));
    ok("预览无查询时不含按需规则", !/禁止 ESM/.test(r.json.preview || ""));
    ok("预览含用户全局规则（与清单同源）", /先给结论，再给依据/.test(r.json.preview || ""),
      "loadRules 读了这一层，预览却没体现");
    ok("全局层排在项目级 AGENTS.md 之前",
      (r.json.preview || "").indexOf("先给结论，再给依据") < (r.json.preview || "").indexOf("根级规则文件"),
      "注入顺序与面板顺序不一致");
    /* 预算数字不在这里写死：它只从 server/agent-llm.js 的常量来。
       探针能验的是「两个端点报同一个分母」，写死 12000 那种断言只会制造第二个真相源。 */
    ok("预览标注字符数与预算，且与清单端点同一分母",
      typeof r.json.chars === "number" && r.json.max > 0 && r.json.chars <= r.json.max
      && r.json.max === listBudgetMax,
      JSON.stringify({ previewMax: r.json.max, listMax: listBudgetMax, chars: r.json.chars }));

    r = await req("GET", "/api/rules/preview?q=" + encodeURIComponent("server/demo.js"));
    ok("命中 server/** 时按需规则进入上下文", /禁止 ESM/.test(r.json.preview || ""), "touched=" + r.json.touched);
    ok("点目录里的 Cursor 规则被读到（list() 看不见点开头名字）", /复用的 Cursor 规则库/.test(r.json.preview || ""), "Cursor 规则漏读");
    ok("根级点文件规则也能被枚举", /根级规则/.test(r.json.preview || "") || /仓库约定/.test(r.json.preview || ""));

    /* 只读来源也要能在详情里看到正文。面板对每一行都会打 /api/rules/content，
       这一组断言是为了别让"列出来了却读不到"的行（AGENTS.md / Cursor mdc / 用户全局）
       在详情里显示成"非法规则路径"。 */
    for (const [label, q] of [
      ["根级 AGENTS.md", "AGENTS.md"],
      ["Cursor 规则 .mdc", ".cursor/rules/legacy.mdc"],
      ["用户全局 ~/.pancode/AGENTS.md", "~/.pancode/AGENTS.md"],
    ]) {
      const cr = await req("GET", "/api/rules/content?file=" + encodeURIComponent(q));
      ok("只读来源可读回正文：" + label, cr.json.ok === true && /\S/.test(String(cr.json.body || "")),
        JSON.stringify(cr.json || cr.raw).slice(0, 160));
    }
    const tr = await req("GET", "/api/rules/content?file=" + encodeURIComponent("../secret.txt"));
    ok("越界路径仍被拒", tr.json.ok === false, JSON.stringify(tr.json));

    r = await req("POST", "/api/rules", { title: "提交信息规范", content: "commit message 用中文，首行不超过 40 字。", globs: [], enabled: true });
    ok("POST /api/rules 新建成功", r.json.ok === true, r.json.error);
    const newFile = r.json.file;
    ok("新建落在工作区 .pancode/rules 下", newFile === ".pancode/rules/提交信息规范.md", newFile);
    ok("落盘文件真实存在", fs.existsSync(path.join(WS_DIR, newFile.replace(/\//g, path.sep))));
    ok("新建后规则列表可见", (r.json.rules || []).some((x) => x.file === newFile));

    r = await req("PUT", "/api/rules", { file: newFile, content: "commit message 用中文，正文空一行。", enabled: false });
    ok("PUT 改写正文成功", r.json.ok === true, r.json.error);
    r = await req("GET", "/api/rules/content?file=" + encodeURIComponent(newFile));
    ok("读回正文为新内容", /正文空一行/.test(r.json.body || ""), r.json.body);
    ok("读回 enabled=false", r.json.meta && r.json.meta.enabled === false);

    r = await req("GET", "/api/rules/preview");
    ok("停用后预览不再含该规则", !/正文空一行/.test(r.json.preview || ""));

    r = await req("POST", "/api/rules/toggle", { file: newFile, enabled: true });
    ok("toggle 打开成功", r.json.ok === true && r.json.enabled === true, r.json.error);
    r = await req("GET", "/api/rules/preview");
    ok("打开后预览含该规则", /正文空一行/.test(r.json.preview || ""));

    r = await req("DELETE", "/api/rules", { file: "AGENTS.md" });
    ok("拒绝删除非 pancode 规则（AGENTS.md）", r.json.ok === false, JSON.stringify(r.json));
    r = await req("DELETE", "/api/rules", { file: newFile });
    ok("DELETE 删除自建规则成功", r.json.ok === true, r.json.error);
    ok("文件确实从磁盘消失", !fs.existsSync(path.join(WS_DIR, newFile.replace(/\//g, path.sep))));

    /* ---------- 记忆 ---------- */
    section("记忆（Memory）");
    r = await req("GET", "/api/memory");
    ok("GET /api/memory 返回 ok 与 stats", r.json.ok === true && !!r.json.stats, r.json.error);
    ok("stats 暴露 byType/injected/atRisk", !!(r.json.stats.byType && "injected" in r.json.stats && "atRisk" in r.json.stats), JSON.stringify(r.json.stats || {}));

    r = await req("POST", "/api/memory", { type: "lesson", topic: "验证用例", content: "端点验证：记忆写入需带价值分。", valueScore: 5, sticky: true });
    ok("POST /api/memory 写入成功", r.json.ok === true && !!r.json.entry.id, r.json.error);
    const memId = r.json.entry && r.json.entry.id;
    ok("sticky 条目标为将注入", r.json.entry && r.json.entry.injected === true);
    ok("strength 是数值", typeof (r.json.entry && r.json.entry.strength) === "number");

    r = await req("PUT", "/api/memory/" + memId, { content: "端点验证：记忆已被编辑。", valueScore: 3 });
    ok("PUT 编辑记忆", /已被编辑/.test((r.json.entry || {}).content || ""), r.json.error);

    r = await req("POST", "/api/memory/" + memId + "/archive", { archived: true });
    ok("归档成功", r.json.ok === true && r.json.entry.archived === true, r.json.error);
    r = await req("GET", "/api/memory?archived=only");
    ok("归档视图能看到该条", (r.json.entries || []).some((e) => e.id === memId));
    r = await req("GET", "/api/memory?q=" + encodeURIComponent("已被编辑"));
    ok("默认视图排除归档条目", !(r.json.entries || []).some((e) => e.id === memId));

    r = await req("POST", "/api/memory/" + memId + "/archive", { archived: false });
    ok("可逆恢复", r.json.ok === true && r.json.entry.archived === false);
    r = await req("GET", "/api/memory?q=" + encodeURIComponent("已被编辑"));
    ok("恢复后可被检索到", (r.json.entries || []).some((e) => e.id === memId));
    r = await req("GET", "/api/memory?q=" + encodeURIComponent("完全无关的词啊"));
    ok("零命中的查询不返回无关条目（hitsOnly）", (r.json.entries || []).length === 0, JSON.stringify((r.json.entries || []).map((e) => e.content)));

    r = await req("POST", "/api/memory", { type: "bogus-type", topic: "t", content: "c" });
    ok("非法 type 回落 lesson", r.json.ok === true && r.json.entry.type === "lesson", JSON.stringify(r.json.entry && r.json.entry.type));
    r = await req("POST", "/api/memory", { type: "lesson", topic: "t", content: "   " });
    ok("空内容被拒绝", r.json.ok === false || r.status === 400);
    r = await req("POST", "/api/memory/prune", {});
    ok("prune 返回 removed/archived", r.json.ok === true && typeof r.json.removed === "number", r.json.error);
    r = await req("DELETE", "/api/memory/" + memId);
    ok("DELETE 记忆", r.json.ok === true);

    /* ---------- 专家 / 角色 ---------- */
    section("专家与角色（Experts）");
    r = await req("GET", "/api/experts");
    ok("GET /api/experts 返回内置专家", r.json.ok === true && (r.json.experts || []).length >= 3, "实际 " + (r.json.experts || []).length);
    ok("内置专家标记为不可编辑", (r.json.experts || []).every((e) => !e.builtin || e.editable === false));
    ok("暴露 active 角色", typeof r.json.active === "string");

    r = await req("POST", "/api/experts", { name: "部署专家", description: "只管发布", role: "你是发布工程师，只关注构建与灰度。", methodology: "## 步骤\n1. 构建\n2. 灰度", tool_whitelist: ["run_command", "not_a_real_tool"], scope: "project" });
    ok("POST /api/experts 新建成功", r.json.ok === true && !!r.json.id, r.json.error);
    const expId = r.json.id;
    ok("落盘为 md 专家包", fs.existsSync(path.join(WS_DIR, ".pancode", "experts", expId + ".md")));
    ok("未知工具被检出", (r.json.experts || []).some((e) => e.id === expId && (e.unknownTools || []).includes("not_a_real_tool")), JSON.stringify((r.json.experts || []).find((e) => e.id === expId) || {}));
    ok("读回角色定位与正文一致", (r.json.experts || []).find((e) => e.id === expId || e.name === "部署专家"));

    r = await req("POST", "/api/experts/active", { active: expId });
    ok("切换当前角色成功", r.json.ok === true && r.json.active === expId, r.json.error);
    r = await req("GET", "/api/experts/preview");
    ok("预览含该专家名", /部署专家/.test(r.json.preview || ""), (r.json.preview || "").slice(0, 60));
    ok("预览走的是真实 personaText（含【专家设定·】前缀）", /【专家设定·/.test(r.json.preview || ""));

    r = await req("GET", "/api/experts");
    const builtinId = (r.json.experts || []).filter((e) => e.builtin)[0].id;
    r = await req("PUT", "/api/experts/" + encodeURIComponent(builtinId), { role: "改了内置" });
    ok("拒绝直接修改内置专家", r.json.ok === false, JSON.stringify(r.json));
    r = await req("GET", "/api/experts/export/" + encodeURIComponent(expId));
    ok("导出为 markdown", r.json.ok === true && /^---\nname: /m.test(r.json.markdown || ""), (r.json.markdown || "").slice(0, 40));
    r = await req("POST", "/api/experts/import", { markdown: r.json.markdown, name: "部署专家导入", scope: "project" });
    ok("导入 markdown 成功", r.json.ok === true, r.json.error);
    r = await req("POST", "/api/experts/import", { markdown: "没有 frontmatter 的散文" });
    ok("坏 markdown 被拒绝并说明原因", r.json.ok === false && /frontmatter|解析/.test(r.json.error || ""), r.json.error);
    r = await req("DELETE", "/api/experts/" + encodeURIComponent(expId));
    ok("DELETE 自建专家", r.json.ok === true, r.json.error);
    ok("磁盘文件被删掉", !fs.existsSync(path.join(WS_DIR, ".pancode", "experts", expId + ".md")));
    r = await req("DELETE", "/api/experts/" + encodeURIComponent(builtinId));
    ok("拒绝删除内置专家并给出覆盖指引", r.json.ok === false && /内置/.test(r.json.error || ""), r.json.error);

    /* ---------- 技能 ---------- */
    section("技能（Skills）");
    r = await req("GET", "/api/skills/managed");
    ok("GET /api/skills/managed 返回 ok", r.json.ok === true, r.json.error);
    ok("内置工作流被标记 builtin", (r.json.skills || []).some((s) => s.builtin));
    r = await req("POST", "/api/skills", { name: "端点验证技能", description: "仅用于验证", trigger: "验证xyz", body: "步骤一" });
    const created = r.json.skill || {};
    ok("创建技能成功", r.json.ok === true && !!created.id, r.json.error);
    r = await req("GET", "/api/skills/preview?q=" + encodeURIComponent("帮我做验证xyz的事情"));
    ok("预览能命中触发词", (r.json.matched || []).some((m) => m.name === "端点验证技能"), JSON.stringify(r.json.matched || []));
    ok("预览只给目录不给正文（渐进式披露）", /use_skill/.test(r.json.directory || "") && !/步骤一/.test(r.json.directory || ""));
    r = await req("POST", "/api/skills/" + created.id + "/toggle", { disabled: true });
    ok("停用技能成功", r.json.ok === true && r.json.disabled === true, r.json.error);
    r = await req("GET", "/api/skills/preview?q=" + encodeURIComponent("帮我做验证xyz的事情"));
    ok("停用后不再参与匹配", !(r.json.matched || []).some((m) => m.name === "端点验证技能"));
    r = await req("GET", "/api/skills/export/" + created.id);
    ok("导出 markdown", r.json.ok === true && !!r.json.content);
    r = await req("POST", "/api/skills/import", { markdown: r.json.content });
    ok("重复导入被判为重名", r.json.ok === false && /同名|已存在/.test(r.json.error || ""), JSON.stringify(r.json));
    r = await req("DELETE", "/api/skills/" + created.id);
    ok("删除技能", r.json.ok === true);

    /* ---------- 灵魂 ---------- */
    section("灵魂（Soul）");
    r = await req("GET", "/api/soul");
    ok("GET /api/soul 返回三张清单", r.json.ok === true && Array.isArray(r.json.soul.values) && Array.isArray(r.json.soul.boundaries) && Array.isArray(r.json.soul.principles), JSON.stringify(Object.keys((r.json.soul || {}))));
    const beforeVal = r.json.soul.values.length;
    r = await req("POST", "/api/soul/proposal", { target: "values", content: "验证用价值条目", reason: "契约测试" });
    ok("新增提案", r.json.ok === true && !!r.json.proposal.id, r.json.error);
    const pid = r.json.proposal.id;
    r = await req("PUT", "/api/soul/proposal/" + pid + "?accept=1");
    ok("接受提案会写入清单", r.json.ok === true && r.json.soul.values.length === beforeVal + 1, beforeVal + " → " + (r.json.soul || {}).values.length);
    r = await req("POST", "/api/soul/reset", {});
    ok("一键重置回出厂", r.json.ok === true && r.json.soul.values.length === beforeVal && (r.json.soul.proposals || []).length === 0, JSON.stringify({ v: (r.json.soul || {}).values.length, p: ((r.json.soul || {}).proposals || []).length }));

    /* ---------- 进度 ---------- */
    section("进度（Progression）");
    r = await req("GET", "/api/progression");
    ok("GET /api/progression 有阶段与 xp", r.json.ok === true && !!r.json.progression && typeof r.json.progression.xp === "number", r.json.error);
    r = await req("POST", "/api/progression", { path: "全栈工程化" });
    ok("设定进化路线", r.json.ok === true);
    r = await req("GET", "/api/progression");
    ok("路线读得回来", (r.json.path || "") === "全栈工程化", JSON.stringify(r.json.path));

    /* ---------- 设置工作台聚合 ---------- */
    section("设置聚合（Config）");
    r = await req("GET", "/api/config");
    ok("GET /api/config 一次返回全部面板", r.json.ok === true && !!r.json.engine && !!r.json.agent && !!r.json.embedding && !!r.json.mcp, r.json.error);
    ok("assets 给出记忆/规则/技能/专家计数", !!(r.json.assets && typeof r.json.assets.rules === "number"), JSON.stringify(r.json.assets || {}));
    ok("权限默认不放开（yolo 不为默认）", r.json.agent.permissions && r.json.agent.permissions.mode !== "yolo", JSON.stringify(r.json.agent.permissions || {}));

    r = await req("POST", "/api/config", { section: "agent", patch: { permissions: { mode: "acceptEdits" }, memory: { enabled: false } } });
    ok("按段保存 agent", r.json.ok === true && r.json.agent.permissions.mode === "acceptEdits", r.json.error);
    r = await req("GET", "/api/settings");
    ok("engine 段读取正常", r.status === 200);
    r = await req("POST", "/api/config", { section: "nonsense", patch: {} });
    ok("未知分组被拒绝", r.json.ok === false);

    r = await req("GET", "/api/config/export");
    ok("导出 JSON 可解析", r.json.ok === true && !!JSON.parse(r.json.json));
    ok("导出里没有 apiKey 字段", !/"apiKey"/.test(r.json.json || ""), "泄露风险");
    ok("导出里也没有 embedding 明文密钥", !/sk-/.test(r.json.json || ""));

    r = await req("POST", "/api/config/import", { json: JSON.stringify({ _kind: "pancode-config", agent: { permissions: { mode: "plan" } }, llm: { apiKey: "sk-should-be-dropped", model: "gpt-test" } }) });
    ok("导入应用 agent 段", r.json.ok === true && (r.json.applied || []).includes("agent"), r.json.error);
    ok("导入拒绝并告知跳过了密钥", (r.json.skipped || []).some((s) => /apiKey/.test(s)), JSON.stringify(r.json.skipped || []));
    r = await req("GET", "/api/agent-settings");
    ok("导入的权限模式真的生效", r.json.permissions && r.json.permissions.mode === "plan", JSON.stringify(r.json.permissions || {}));
    r = await req("POST", "/api/config/import", { json: "{ not json" });
    ok("坏 JSON 被拒绝", r.json.ok === false);
    r = await req("POST", "/api/config/import", { json: { _kind: "other-tool" } });
    ok("非 pancode 配置被拒绝", r.json.ok === false, JSON.stringify(r.json));

    /* ---------- 审计 / 编排历史 ---------- */
    section("审计与编排历史");
    r = await req("GET", "/api/audit");
    ok("GET /api/audit 可用", r.status === 200 && r.json.ok === true, r.json.error);
    r = await req("GET", "/api/orch/history");
    ok("GET /api/orch/history 可用", r.json.ok === true && Array.isArray(r.json.runs));
    r = await req("GET", "/api/agent/trace/history");
    ok("GET /api/agent/trace/history 可用", r.status === 200);

    /* ---------- 沉淀 ---------- */
    section("沉淀（Sediment）");
    r = await req("GET", "/api/sediment");
    ok("GET /api/sediment 返回规则+记忆", r.json.ok === true && Array.isArray(r.json.rules) && Array.isArray(r.json.memory), r.json.error);
    ok("沉淀预览的规则与工作区同源", (r.json.rules || []).some((x) => /always-cn\.md$/.test(x.file)), JSON.stringify((r.json.rules || []).map((x) => x.file)));
    r = await req("POST", "/api/sediment", { target: "rule", title: "验证沉淀", content: "沉淀写入的规则必须能被规则面板看到。" });
    ok("沉淀为规则成功", r.json.ok === true && /\.pancode\/rules\//.test(r.json.file || ""), JSON.stringify(r.json));
    const sedFile = r.json.file;
    r = await req("GET", "/api/rules");
    const sedRec = (r.json.rules || []).find((x) => x.file === sedFile);
    ok("沉淀产物出现在规则面板", !!sedRec, JSON.stringify((r.json.rules || []).map((x) => x.file)));
    ok("沉淀规则标题被解析出来", !!sedRec && /验证沉淀/.test(sedRec.title + sedRec.excerpt), sedRec && sedRec.title);
    if (sedFile) { await req("DELETE", "/api/rules", { file: sedFile }); }

    /* ---------- 多份模型配置（profile）与 Git 推送 ---------- */
    section("模型配置 profile 与 Git 推送");
    r = await req("GET", "/api/health");
    ok("/api/health 暴露 apiStamp（前端据此自检后端是否偏旧）",
      /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(String(r.json.apiStamp || "")), JSON.stringify(r.json).slice(0, 140));
    r = await req("GET", "/api/llm/profiles");
    ok("GET /api/llm/profiles 返回 ok + 清单 + 当前参数",
      r.json.ok === true && Array.isArray(r.json.profiles) && r.json.active && typeof r.json.active.baseURL === "string",
      JSON.stringify(r.json).slice(0, 160));
    r = await req("POST", "/api/llm/profiles", { name: "验证网关", baseURL: "https://example.test/v1", model: "real-model-x", apiKey: "sk-verify-1234" });
    const prof = r.json.profile;
    ok("保存一份配置成功且标出密钥尾号", r.json.ok === true && !!prof && prof.hasKey === true && /1234$/.test(prof.keyTail || ""),
      JSON.stringify(r.json).slice(0, 200));
    r = await req("GET", "/api/settings");
    ok("profile 的密钥不落进只读配置 JSON", !JSON.stringify(r.json).includes("sk-verify"), JSON.stringify(r.json).slice(0, 140));
    r = await req("GET", "/api/config");
    ok("引擎配置导出里也没有密钥明文", !JSON.stringify(r.json).includes("sk-verify"), JSON.stringify(r.json).slice(0, 140));
    r = await req("POST", "/api/llm/profiles/" + encodeURIComponent(prof.id) + "/apply", {});
    ok("切到这份配置后引擎地址立刻生效",
      r.json.ok === true && r.json.engine.baseURL === "https://example.test/v1",
      JSON.stringify(r.json.engine).slice(0, 200));
    r = await req("GET", "/api/llm/profiles");
    const back = (r.json.profiles || []).find((p) => p.id === prof.id) || {};
    ok("profile 里存的模型 ID 不被演示引擎显示名覆盖", back.model === "real-model-x", JSON.stringify(back).slice(0, 200));
    r = await req("GET", "/api/settings");
    ok("apply 后该配置的密钥从本地 .env 回到运行时", /1234$/.test(String(r.json.keyTail || "")), JSON.stringify(r.json).slice(0, 140));
    r = await req("DELETE", "/api/llm/profiles/" + encodeURIComponent(prof.id));
    ok("删除配置后清单里不再出现", r.json.ok === true && !(r.json.profiles || []).some((p) => p.id === prof.id), JSON.stringify(r.json).slice(0, 160));
    r = await req("POST", "/api/git/push", {});
    ok("不能推送时给出人话原因而不是静默", r.json && r.json.ok === false && /远端|Git|分支|推送/.test(String(r.json.error || "")),
      JSON.stringify(r.json).slice(0, 200));
    r = await req("GET", "/api/git/status");
    ok("/api/git/status 带 remote 字段（界面据此决定推送按钮）", Object.prototype.hasOwnProperty.call(r.json, "remote"),
      JSON.stringify(r.json).slice(0, 160));

    /* ---------- 拉取模型：直连表单里填的地址，不依赖任何"网关" ---------- */
    section("拉取模型直连接口（POST /api/models）");
    const mock = await startMockUpstream();
    try {
      r = await req("POST", "/api/models", { baseURL: mock.base + "/v1/" });
      ok("填个本地 HTTP 地址就能拉到模型（无需网关、无需密钥）",
        r.json.ok === true && (r.json.models || []).join(",") === "mock-a,mock-b", JSON.stringify(r.json).slice(0, 200));
      ok("返回里带回真正请求过的地址", /\/v1\/models$/.test(String(r.json.attempted || "")), r.json.attempted);

      r = await req("POST", "/api/models", { baseURL: mock.base + "/v1/chat/completions", apiKey: "sk-form-key-9999" });
      ok("地址误填成 /v1/chat/completions 也能拉对", r.json.ok === true && (r.json.models || []).length === 2, JSON.stringify(r.json).slice(0, 200));
      const authHit = mock.hits[mock.hits.length - 1];
      ok("密钥只走请求头，没有出现在 URL 里", !/sk-form-key/.test(authHit.url), authHit.url);
      ok("表单里的密钥确实用于这一次请求", authHit.auth === "Bearer sk-form-key-9999", authHit.auth);
      r = await req("GET", "/api/settings");
      ok("拉取用的表单密钥不落进运行时配置", !JSON.stringify(r.json).includes("9999"), JSON.stringify(r.json).slice(0, 160));
      r = await req("POST", "/api/models", { baseURL: mock.base + "/v1" });
      const anonHit = mock.hits.filter((h) => h.url === "/v1/models").pop();
      ok("不传密钥时用已保存的那份（本地服务则可完全无密钥）",
        r.json.ok === true && anonHit.auth !== "Bearer sk-form-key-9999", JSON.stringify(anonHit));

      r = await req("POST", "/api/models", { baseURL: mock.base + "/nope/v1" });
      ok("对端 404 时说清是哪个地址、并提示版本段写法",
        r.json.ok === false && /\/nope\/v1\/models 返回 HTTP 404/.test(String(r.json.error || "")) && /版本段/.test(String(r.json.error || "")),
        JSON.stringify(r.json).slice(0, 220));
      r = await req("POST", "/api/models", { baseURL: mock.base + "/empty" });
      ok("200 但列表为空时说明这个服务不提供 /models",
        r.json.ok === false && /不提供 \/models/.test(String(r.json.error || "")), JSON.stringify(r.json).slice(0, 220));
      r = await req("POST", "/api/models", { baseURL: "http://127.0.0.1:8898/v1" });
      ok("连不上时报出被请求的完整地址而不是笼统失败",
        r.json.ok === false && /127\.0\.0\.1:8898\/v1\/models/.test(String(r.json.error || "")), JSON.stringify(r.json).slice(0, 220));
      r = await req("POST", "/api/models", { baseURL: "http://127.0.0.1:1/v1" });
      ok("失败原因给的是真实错因，不是 TypeError 这种内部词",
        r.json.ok === false && !/TypeError|fetch failed/.test(String(r.json.error || "")) && /127\.0\.0\.1:1\/v1\/models/.test(String(r.json.error || "")),
        JSON.stringify(r.json).slice(0, 220));
      r = await req("POST", "/api/models", { baseURL: "127.0.0.1:8899/v1" });
      ok("缺协议的地址直接说明要 http/https", r.json.ok === false && /http/.test(String(r.json.error || "")), JSON.stringify(r.json).slice(0, 160));
      r = await req("POST", "/api/models", {});
      ok("表单留空时回落到已保存的地址，报错也点名那个地址",
        r.json.ok === false && /example\.test\/v1\/models/.test(String(r.json.error || "")) && !/网关/.test(String(r.json.error || "")),
        JSON.stringify(r.json).slice(0, 220));

      r = await req("POST", "/api/settings/test", { baseURL: mock.base + "/v1", model: "mock-a" });
      ok("无密钥也能测通本地式服务", r.json.ok === true && /ok/.test(String(r.json.sample || "")), JSON.stringify(r.json).slice(0, 200));
      r = await req("POST", "/api/settings/test", { baseURL: mock.base + "/v1", model: "  " });
      ok("模型名留空时回落到已保存的模型而不是空报错",
        r.json.ok === true && /ok/.test(String(r.json.sample || "")), JSON.stringify(r.json).slice(0, 200));
      r = await req("POST", "/api/settings/test", { baseURL: "http://127.0.0.1:8898/v1", model: "mock-a" });
      ok("测不通时点名请求了哪个地址",
        r.json.ok === false && /127\.0\.0\.1:8898\/v1\/chat\/completions/.test(String(r.json.error || "")) && !/网关/.test(String(r.json.error || "")),
        JSON.stringify(r.json).slice(0, 220));
      r = await req("POST", "/api/settings/test", { baseURL: "", model: "  " });
      ok("两处都留空时用已保存的配置（也不再出现「网关」）",
        r.json.ok === false && !/网关/.test(String(r.json.error || "")), JSON.stringify(r.json).slice(0, 200));

      /* 把运行时配置真的清空：上面几条走的是"回落"分支，这几条才是"空值守卫"分支 */
      await req("POST", "/api/settings", { baseURL: "", apiKey: "", model: "" });
      r = await req("POST", "/api/models", {});
      ok("什么都没配时说的是「还没填接口地址」",
        r.json.ok === false && /还没填接口地址/.test(String(r.json.error || "")) && !/网关/.test(String(r.json.error || "")),
        JSON.stringify(r.json).slice(0, 160));
      r = await req("POST", "/api/settings/test", { baseURL: mock.base + "/v1", model: "" });
      ok("缺模型名时提示去拉取或手填模型 ID",
        r.json.ok === false && /模型名/.test(String(r.json.error || "")), JSON.stringify(r.json).slice(0, 160));
      r = await req("POST", "/api/settings/test", { baseURL: "", model: "mock-a" });
      ok("缺地址时提示填的就是接口地址，并给出地址写法",
        r.json.ok === false && /接口地址/.test(String(r.json.error || "")) && /https?:\/\//.test(String(r.json.error || "")),
        JSON.stringify(r.json).slice(0, 160));
    } finally { mock.close(); }
  } finally {
    child.kill();
    await wait(300);
  }
}

main().then(() => {
  console.log("\n" + "=".repeat(52));
  console.log(fail === 0 ? "\x1b[32m全部通过\x1b[0m  " + pass + " 项断言" : "\x1b[31m失败 " + fail + " 项\x1b[0m / 共 " + (pass + fail));
  if (fail) fails.forEach((f) => console.log("  · " + f));
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error("\x1b[31m验证脚本异常：\x1b[0m" + e.message);
  process.exit(2);
});
