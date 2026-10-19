/* 视觉链路的端到端验收：像素只随"下一次请求"带一次，绝不进对话历史。
   ————————————————————————————————————————————
   拆成两条探针是有原因的：
   · scripts/_verify_browser.js 钉的是"真 Chromium 截图 → 工具真的登记了像素"；
   · 这里钉的是后半截："登记之后，消息层到底把它怎么发出去" ——
     这一段用真 LLM 测不了（要看上游是否带视觉），用单测又测不全（rebuildMessages 在 handleChat 肚子里）。
   所以这里同时假掉 ./llm（把每轮请求的 messages 形状抄下来）和 agent-browser CLI
   （screenshot 时按传入路径写真文件，顺便钉住 --screenshot-format jpeg 真的到了 argv）。

   三件事必须成立，否则这条链是负的：
   1) for_model 的下一轮请求里确实有 image_url 部件；
   2) 再下一轮没有 —— 同一张图反复上传等于每轮多付 1.5k token；
   3) 对话历史里搜不到 base64 —— 图片不能落进 .pancode 的会话文件。
   外加降级：上游因图片 400 时必须摘掉像素重试一次并关掉本会话喂图，而不是让整轮任务挂掉。
   用法：node scripts/_verify_vision.js
*/
"use strict";
const SANDBOX = require("./_sandbox").create({ tag: "vision" });

const Module = require("module");
const path = require("path");
const fs = require("fs");

/* ---------- 假 LLM：把每轮请求的 messages 形状抄下来 ---------- */
/* 必须带上这两个导出：handleChat 的 catch 第一件事就是 `e instanceof LlmAbortedError`，
   mock 少了它就会 "Right-hand side of 'instanceof' is not an object" ——
   那时测到的是探针自己的洞，不是产品的错误路径。 */
class LlmAbortedError extends Error { constructor() { super("aborted"); this.aborted = true; } }
class LlmError extends Error {}
let plan = null;      // 每轮的行为
let roundIdx = 0;
const reqs = [];
const mockLlm = {
  LlmAbortedError, LlmError,
  async chatStream(cfg, messages, tools, cb) {
    reqs.push({
      round: roundIdx,
      /* 只抄形状与摘要：base64 整条塞进断言数组会把探针自己的内存吃光 */
      parts: messages.map((m) => (Array.isArray(m.content)
        ? { role: m.role, kinds: m.content.map((p) => (p.type === "image_url" ? "img:" + String(p.image_url.url).slice(0, 16) : "txt")) }
        : { role: m.role, kinds: ["str"] })),
      hasImage: messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")),
      imgCount: messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").length : 0), 0),
      bytes: JSON.stringify(messages).length,
    });
    const act = plan[roundIdx];
    roundIdx++;
    if (!act) throw new Error("探针脚本没安排第 " + roundIdx + " 轮");
    if (act.throw) throw new Error(act.throw);
    if (act.toolCalls) {
      return { content: act.content || "", reasoning: "", toolCalls: act.toolCalls, finish: "tool_calls" };
    }
    if (cb && cb.onContent) cb.onContent(act.content || "看到了。");
    return { content: act.content || "看到了。", reasoning: "", toolCalls: [], finish: "stop" };
  },
  async ping() { return true; },
};

/* ---------- 假 agent-browser CLI：screenshot 时按 argv 里的路径写张真 jpeg ---------- */
const argvSeen = [];
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7)]);
const fakeAb = {
  DEFAULT_TIMEOUT_MS: 30000,
  status: () => ({ enabled: true, available: true, exe: "fake-agent-browser", browser: "chrome" }),
  sessionName: (c) => "pc-" + String(c || "x").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 20),
  globalArgs: () => [],
  async call(exe, argv) {
    argvSeen.push(argv.slice());
    if (argv.includes("screenshot")) {
      const target = argv[argv.indexOf("screenshot") + 1];
      fs.writeFileSync(target, JPEG);
      return { ok: true, data: { url: "file:///fixture" }, text: "" };
    }
    if (argv.includes("open")) return { ok: true, data: { url: "file:///fixture", title: "视觉探针页" }, text: "" };
    if (argv.includes("snapshot")) return { ok: true, data: { snapshot: '- button "保存" [ref=e1]' }, text: "" };
    if (argv.includes("close")) return { ok: true, data: {}, text: "" };
    return { ok: true, data: {}, text: "" };
  },
};

/* ---------- 假 config / agent-base（与 _verify_tools.js 同一套路数） ---------- */
const mockConfig = { ROOT: SANDBOX.dataDir };
class AgentBase {
  constructor(ctx) {
    this.ctx = ctx; this.cfg = ctx.cfg; this.files = ctx.files; this.term = ctx.term;
    this.evts = []; this.cards = [];
    this.emit = (ev) => { this.evts.push(ev); };
  }
  tool(kind, name, target) {
    const rec = { kind, name, target, body: "", image: null, ok: null, label: "" };
    this.cards.push(rec);
    return {
      body: (t) => { rec.body = String(t); },
      done: (o, label) => { rec.ok = o; rec.label = label; },
      image: (rel) => { rec.image = rel; },
      end() {}, start() {}, delta() {},
    };
  }
  thinkStart() { return { delta() {}, end() {} }; }
  msgStart() { return { delta() {}, end() {} }; }
  async say() {}
  state() {}
  fileChanged() {}
  pushChanges() { return []; }
  resolveApproval() {}
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const base = String(request).split(/[\\/]/).pop();
  if (base === "llm") return mockLlm;
  if (base === "config") return mockConfig;
  if (base === "agent-base") return { AgentBase };
  if (base === "agent-browser") return fakeAb;
  return origLoad.apply(this, arguments);
};
const { LlmAgent } = require(path.join(__dirname, "..", "server", "agent-llm.js"));
Module._load = origLoad;

/* ---------- 断言小工具 ---------- */
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + name); }
  else { fail++; fails.push(name + (detail ? " — " + detail : "")); console.log("  \x1b[31m✗\x1b[0m " + name + (detail ? " — " + detail : "")); }
}
/* 工具回执在模型序里是 role:tool 的消息，工具卡上只有标题——判文案必须取历史 */
const histText = (a) => JSON.stringify((a.conversations.get("default") || {}).history || []);
const termLines = (a) => a.evts.filter((e) => e.type === "term.line").map((e) => e.text).join("\n");

function mkAgent(extraLlm) {
  const cfg = {
    llm: Object.assign({ baseURL: "http://fake", apiKey: "k", model: "vision-test", maxToolRounds: 8, contextWindow: 32000, vision: true }, extraLlm || {}),
    permissions: { mode: "auto", allow: [], deny: [] },
    persona: {}, rules: { enabled: false }, memory: { enabled: false }, context: {}, computer: {},
  };
  const a = new LlmAgent({
    cfg,
    files: { list: () => [], read: () => "", write() {}, exists: () => true, remove() {}, search: () => [], dir: SANDBOX.wsDir },
    term: { run: async () => ({ out: "", code: 0 }) },
  });
  a.running = false;
  return a;
}
async function run(name, extraLlm, script) {
  reqs.length = 0; argvSeen.length = 0; roundIdx = 0; plan = script;
  const a = mkAgent(extraLlm);
  await a.handleChat(name);
  return a;
}

(async () => {
  /* ① vision 开 + for_model：下一轮带图，再下一轮必须不带 */
  const A = await run("截一张图给我看", { vision: true }, [
    { toolCalls: [{ id: "c1", name: "browser_screenshot", arguments: JSON.stringify({ for_model: true, name: "验收", caption: "按钮排在哪" }) }] },
    { toolCalls: [{ id: "c2", name: "browser_snapshot", arguments: JSON.stringify({}) }] },
    { content: "右上角有个保存按钮。" },
  ]);
  ok("① 第一轮请求没有图片部件（还没截呢）", reqs[0] && !reqs[0].hasImage, reqs[0] && reqs[0].imgCount);
  ok("① 截图后的那次请求真的带上了 image_url", reqs[1] && reqs[1].hasImage, "第 2 轮 hasImage=" + (reqs[1] && reqs[1].hasImage));
  ok("① 带的是 jpeg 的 data URL", reqs[1] && /img:data:image\/jpeg;/.test(JSON.stringify(reqs[1].parts)),
    reqs[1] && JSON.stringify(reqs[1].parts).slice(0, 160));
  ok("① 只带一张，不多塞", reqs[1] && reqs[1].imgCount === 1, reqs[1] && reqs[1].imgCount);
  ok("② 再下一轮不再重复上传同一张图（否则每轮白付 1.5k token）", reqs[2] && !reqs[2].hasImage,
    reqs[2] && "imgCount=" + reqs[2].imgCount);
  const shotArgv = argvSeen.find((a) => a.includes("screenshot")) || [];
  ok("③ --screenshot-format jpeg 真的传到了 CLI（不是照着想象写的旗标名）",
    shotArgv.includes("--screenshot-format") && shotArgv[shotArgv.indexOf("--screenshot-format") + 1] === "jpeg",
    JSON.stringify(shotArgv));
  ok("③ 质量旗标也带上了", shotArgv.includes("--screenshot-quality"));
  ok("③ 落盘扩展名是 .jpeg（前端与 mime 都靠它）", /\.jpeg$/.test((A.cards[0] || {}).image || ""), (A.cards[0] || {}).image);
  ok("③ 回执说清了像素会随下一次请求交出去", /会随下一次请求交给你/.test(histText(A)), histText(A).slice(0, 120));
  const hist = (A.conversations.get("default") || {}).history || [];
  ok("④ 对话历史里搜不到 base64（图片不落进会话文件）",
    hist.length > 0 && !JSON.stringify(hist).includes("base64,"), "history " + hist.length + " 条");
  ok("④ 待发队列已清空", (A._visionFor("default") || []).length === 0);

  /* ⑤ vision 关：绝不附图，且回执不许假装"已经看到" */
  const B = await run("截一张图", { vision: false }, [
    { toolCalls: [{ id: "d1", name: "browser_screenshot", arguments: JSON.stringify({ for_model: true, name: "开关关着" }) }] },
    { content: "好。" },
  ]);
  ok("⑤ vision 关闭时任何一轮都不附图", !reqs.some((r) => r.hasImage), JSON.stringify(reqs.map((r) => r.imgCount)));
  ok("⑤ 回执如实说只有用户能看见，并指出开关在哪", /llm\.vision/.test(histText(B)), histText(B).slice(0, 120));
  ok("⑤ 不许出现已交给模型的措辞", !/会随下一次请求交给你/.test(histText(B)), "");

  /* ⑥ 上游因图片拒收：摘掉像素重试一次，本会话此后不再喂 */
  const C = await run("截一张图", { vision: true }, [
    { toolCalls: [{ id: "e1", name: "browser_screenshot", arguments: JSON.stringify({ for_model: true, name: "拒收测试" }) }] },
    { throw: "400 invalid_request_error: image content type is not supported by this model" },
    { content: "改用文本快照了。" },
  ]);
  const afterReject = reqs.slice(1);
  ok("⑥ 被拒的那一次请求确实带了图（不然谈不上因图被拒）", afterReject[0] && afterReject[0].hasImage,
    JSON.stringify(afterReject.map((r) => r.imgCount)));
  ok("⑥ 立刻摘掉像素重试，而不是把整轮任务判死", afterReject[1] && !afterReject[1].hasImage,
    JSON.stringify(afterReject.map((r) => r.imgCount)));
  ok("⑥ 终端痕里告知了降级与原因", /\[视觉\].*拒收/.test(termLines(C)), termLines(C).slice(0, 120));
  ok("⑥ 本会话此后 _visionRejected 置位", C._visionRejected === true);
  const doneEvts = C.evts.some((e) => e.type === "agent.done");
  const saidNew = C.evts.some((e) => String(e.text || "").includes("改用文本快照了"));
  ok("⑥ 任务继续跑到了结束（不是以报错收场）", doneEvts || saidNew,
    "agent.done=" + doneEvts + " 最终回答=" + saidNew);

  if (fail) { console.error("\nFAIL " + fail + " 项:\n - " + fails.join("\n - ")); SANDBOX.cleanup(); process.exit(1); }
  console.log("\nPASS: 视觉链路 " + pass + " 项全过（像素带一次、不进历史、CLI 旗标实测、拒收能降级）");
  SANDBOX.cleanup();
  process.exit(0);
})().catch((e) => { console.error("FAIL 探针异常: " + (e && e.stack || e)); SANDBOX.cleanup(); process.exit(1); });
