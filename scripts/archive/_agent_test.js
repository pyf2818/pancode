/* Phase 1 纯逻辑单测：不触发网络，用假 ctx 实例化 LlmAgent 验证助手方法 */
const assert = require("assert");
const { LlmAgent } = require("../../server/agent-llm");

const store = {
  "src/a.js": "console.log(1)",
  ".pancode/rules/style.md": "# 规则\n用 2 空格缩进",
  ".pancode/rules/api.md": "API 必须返回 JSON",
};
const files = {
  list: () => Object.keys(store),
  read: (p) => (store[p] !== undefined ? store[p] : (() => { throw new Error("no:" + p); })()),
  exists: (p) => store[p] !== undefined,
  write: () => {}, remove: () => {}, search: () => [],
};
const ctx = { emit: () => {}, files, term: { run: async () => ({ code: 0, out: "" }) }, cfg: {} };

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); pass++; console.log("  ✓", name); }

const baseCfg = () => ({
  llm: { maxToolRounds: 10 },
  permissions: { mode: "ask", allow: [], deny: [] },
  persona: { active: "default", systemPrompt: "" },
  rules: { enabled: true },
  context: { budgetTokens: 120000, autoCompact: false },
  memory: { enabled: true },
  workspace: "workspace",
});

console.log("== 权限决策 ==");
{
  const a = new LlmAgent(ctx); a.cfg = baseCfg();
  ok("ask: run_command 需询问", a._approvalDecision("run_command", { command: "npm test" }).action === "ask");
  ok("ask: write_file 需询问", a._approvalDecision("write_file", { path: "x.js" }).action === "ask");
  ok("ask: read_file 直接允许", a._approvalDecision("read_file", { path: "x.js" }).action === "allow");
}
{
  const a = new LlmAgent(ctx); const c = baseCfg(); c.permissions.mode = "auto"; a.cfg = c;
  ok("auto: write_file 直接允许", a._approvalDecision("write_file", { path: "x.js" }).action === "allow");
  ok("auto: run_command 直接允许", a._approvalDecision("run_command", { command: "rm -rf x" }).action === "allow"); // 沙箱仍兜底
}
{
  const a = new LlmAgent(ctx); const c = baseCfg(); c.permissions.mode = "semi"; c.permissions.allow = ["npm test", "git status"]; a.cfg = c;
  ok("semi: 白名单命令免确认", a._approvalDecision("run_command", { command: "npm test" }).action === "allow");
  ok("semi: 非白名单命令仍询问", a._approvalDecision("run_command", { command: "git push" }).action === "ask");
  ok("semi: 写文件仍询问", a._approvalDecision("write_file", { path: "x.js" }).action === "ask");
}
{
  const a = new LlmAgent(ctx); const c = baseCfg(); c.permissions.deny = ["rm -rf", "/sudo/"]; a.cfg = c;
  ok("deny: 命中即硬拦截(ask模式)", a._approvalDecision("run_command", { command: "rm -rf /" }).action === "block");
  ok("deny: 命中即硬拦截(auto模式)", (() => { const c2 = baseCfg(); c2.permissions.mode = "auto"; c2.permissions.deny = ["rm -rf"]; a.cfg = c2; return a._approvalDecision("run_command", { command: "rm -rf x" }).action; })() === "block");
}

console.log("== @提及 / 多模态 ==");
{
  const a = new LlmAgent(ctx); a.cfg = baseCfg();
  const r = a._resolveMentions("看下 @file:src/a.js 这个文件");
  ok("@file 解析出内容", /console\.log\(1\)/.test(r.block));
  ok("@file 从正文剥离", r.clean.includes("@file") === false && r.clean.includes("这个文件"));
  const r2 = a._resolveMentions("@folder:src 有什么");
  ok("@folder 列出目录", /目录 src/.test(r2.block));
}
{
  const a = new LlmAgent(ctx); a.cfg = baseCfg();
  ok("纯文本→字符串", typeof a._buildUserContent("hi", []) === "string");
  const c = a._buildUserContent("hi", [{ src: "data:image/png;base64,AAA" }]);
  ok("带图片→多模态数组", Array.isArray(c) && c[1].type === "image_url" && c[1].image_url.url === "data:image/png;base64,AAA");
}

console.log("== 上下文增强 ==");
{
  const a = new LlmAgent(ctx); const c = baseCfg(); c.persona.active = "fullstack"; a.cfg = c;
  const aug = a.buildSystemAugment();
  ok("人格(全栈)注入", /全栈/.test(aug));
  ok(".pancode/rules 注入", /2 空格缩进/.test(aug) && /返回 JSON/.test(aug));
}
{
  const a = new LlmAgent(ctx); const c = baseCfg(); c.rules.enabled = false; c.persona.active = "default"; a.cfg = c;
  ok("规则关闭则不注入", !/2 空格缩进/.test(a.buildSystemAugment()));
}
{
  const a = new LlmAgent(ctx); const c = baseCfg(); c.persona.active = "custom"; c.persona.systemPrompt = "你是一只猫"; a.cfg = c;
  ok("自定义人格覆盖", /你是一只猫/.test(a.buildSystemAugment()));
}

console.log("== 上下文预算估算 ==");
{
  const a = new LlmAgent(ctx); a.cfg = baseCfg();
  const msgs = [{ role: "system", content: "abcdefgh" }, { role: "user", content: [{ type: "text", text: "十二字内" }] }];
  const est = a._estTokens(msgs);
  ok("估算≈字符/4", est === Math.ceil(8 / 4) + Math.ceil(4 / 4)); // 8/4 + 4/4 = 2+1 = 3
}

console.log("\n全部通过：" + pass + " 项断言");
