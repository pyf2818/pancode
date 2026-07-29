/* 验证 Phase2 仓库地图 / 检索增强：
   1) repo-map.js 纯逻辑（mock FileStore）：索引 / 格式化 / 符号检索 / 概览
   2) agent-llm.js 集成：execTool("repo_map") / execTool("search_symbol") 真实跑通（覆写 require，不依赖真实 LLM） */
const Module = require("module");
const path = require("path");

const SAMPLE = {
  "server/files.js": "class FileStore {\n  constructor(dir) {}\n  read(rel) {}\n  write(rel, c) {}\n}\nfunction safePath() {}\n",
  "server/agent-llm.js": "class LlmAgent extends AgentBase {\n  async handleChat(text) {}\n  execTool(name, args) {}\n}\nfunction buildRepoIndex() {}\n",
  "public/app.js": "const chatStream = document.createElement('div');\nfunction mdLite(s) {}\nasync function boot() {}\n",
  "README.md": "# pancode\n\n基于 Monaco 的 Web AI 编程工作台。\n",
  "src/util.py": "def load_config():\n    pass\nclass Config:\n    pass\n",
};

const mockFiles = {
  list() { return Object.keys(SAMPLE); },
  read(p) { return SAMPLE[p] || ""; },
  isBinary() { return false; },
  exists(p) { return p in SAMPLE; },
  search() { return []; },
};

// ---- 1) repo-map.js 纯逻辑 ----
const repoMap = require(path.join(__dirname, "..", "server", "repo-map.js"));
const idx = repoMap.buildRepoIndex(mockFiles);
const fmt = repoMap.formatRepoMap(idx);
const sym = repoMap.searchSymbols(idx, "FileStore");
const ov = repoMap.repoOverview(mockFiles);

const errs = [];
if (!idx.files.length) errs.push("buildRepoIndex 未索引到任何文件");
if (idx.symbolCount < 5) errs.push("抽取符号过少: " + idx.symbolCount);
if (!/FileStore/.test(fmt)) errs.push("formatRepoMap 未含 FileStore");
if (!sym.length || sym[0].name !== "FileStore") errs.push("searchSymbols 未优先匹配 FileStore: " + JSON.stringify(sym[0] || null));
if (!/顶层目录/.test(ov)) errs.push("repoOverview 格式异常: " + ov);

// ---- 2) agent-llm 集成（execTool 直接调用） ----
class AgentBase {
  constructor(ctx) { this.ctx = ctx; this.cfg = ctx.cfg; this.files = ctx.files; this.term = ctx.term; }
  emit() {}
  tool() { return { body() {}, done() {} }; }
  thinkStart() { return { delta() {}, end() {} }; }
  msgStart() { return { delta() {}, end() {} }; }
  async say() {}
  fileChanged() {}
  pushChanges() { return []; }
  state() {}
  resolveApproval() {}
}
const mockLlm = { async chatStream() { return { content: "", toolCalls: [] }; }, async ping() { return true; } };
const mockConfig = { ROOT: path.resolve(__dirname, "..") };
const orig = Module._load;
Module._load = function (req, p, m) {
  if (req === "./llm") return mockLlm;
  if (req === "./agent-base") return { AgentBase };
  if (req === "./config") return mockConfig;
  return orig.apply(this, arguments);
};
const { LlmAgent } = require(path.join(__dirname, "..", "server", "agent-llm.js"));

(async () => {
  const a = new LlmAgent({
    cfg: { llm: {}, permissions: { mode: "auto" }, persona: {}, rules: { enabled: false }, memory: { enabled: false }, context: {}, workspace: "workspace" },
    files: mockFiles, term: { run: async () => ({ out: "", code: 0 }) },
  });
  const mapOut = await a.execTool("repo_map", {});
  const symOut = await a.execTool("search_symbol", { query: "Config" });
  if (!/FileStore|LlmAgent/.test(mapOut)) errs.push("execTool(repo_map) 返回不含符号地图: " + String(mapOut).slice(0, 120));
  if (!/Config/.test(symOut)) errs.push("execTool(search_symbol) 未匹配 Config: " + symOut);

  if (errs.length) { console.error("FAIL:\n - " + errs.join("\n - ")); process.exit(1); }
  console.log("PASS Phase2: repo_map=" + idx.indexedCount + " 文件 / " + idx.symbolCount + " 符号；search_symbol('FileStore')→ " + sym[0].path + ":" + sym[0].line + "；execTool 接入正常。");
})().catch((e) => { console.error("FAIL:", e && e.stack || e); process.exit(1); });
