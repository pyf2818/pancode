# -*- coding: utf-8 -*-
# W2 patch: agent-llm.js — Experts 集成
# 逐补丁精确匹配 + 唯一性断言 + .new 写入后立即换入（同脚本内 os.replace）
import io, os, re, sys

P = os.path.join(os.path.dirname(__file__), "..", "server", "agent-llm.js")
P = os.path.abspath(P)
src = io.open(P, "r", encoding="utf-8").read()
orig = src
applied = []

def patch_once(name, old, new):
    global src
    n = src.count(old)
    assert n == 1, "patch %s: expect 1 occurrence, got %d" % (name, n)
    src = src.replace(old, new)
    applied.append(name)

# ---- 1. require expert-store ----
patch_once(
    "require",
    'const { chatStream } = require("./llm");',
    'const { chatStream } = require("./llm");\n'
    'const { ExpertStore, formatExpertPrompt } = require("./expert-store"); // W2 专家注册表',
)

# ---- 2. PERSONAS 块 → SUB_AGENT_BLOCK 模块常量 ----
i = src.find("/* 人格预设")
assert i >= 0, "PERSONAS comment not found"
j = src.find("\n};\n", i)
assert j > i, "PERSONAS block end not found"
j += len("\n};\n")
new_block = (
    '/* W2 子智能体工具黑名单：排除会自我嵌套或污染主流程的工具\n'
    '   （原 runSubAgent 内 BLOCK 提升为模块常量，供 _subToolset 使用；\n'
    '     内置人格已升级为专家包，见 expert-store.js 的 BUILTIN_EXPERTS） */\n'
    'const SUB_AGENT_BLOCK = new Set(["agent", "create_plan", "update_plan", "undo", "set_goal", '
    '"instantiate_template", "save_template", "remove_template", "list_templates", "goal_status", "save_session_memory"]);\n'
)
src = src[:i] + new_block + src[j:]
applied.append("PERSONAS->SUB_AGENT_BLOCK")

# ---- 3. personaText 升级（@专家切换 + 专家包查找） ----
old_persona = (
    '  personaText() {\n'
    '    const active = this.cfg.persona && this.cfg.persona.active;\n'
    '    if (active === "custom") {\n'
    '      const sp = (this.cfg.persona.systemPrompt || "").trim();\n'
    '      return sp ? "【人格设定】\\n" + sp : "";\n'
    '    }\n'
    '    const p = PERSONAS[active];\n'
    '    return p ? "【人格设定】\\n" + p : "";\n'
    '  }\n'
)
new_persona = (
    '  /* W2 人格/专家注入：优先级 @专家（单条消息切换） > custom > active（内置 id 或专家包 id）。\n'
    '     active 为 default 或未知值时返回空串（与旧行为一致）。 */\n'
    '  personaText(userText) {\n'
    '    const reg = this.experts || ExpertStore.builtinOnly();\n'
    '    // @专家：userText 以 @专家id/名 开头且精确命中注册表时，仅本条消息使用该专家\n'
    '    const at = String(userText || "").match(/^\\s*@([^\\s@]+)/);\n'
    '    if (at) {\n'
    '      const e = reg.byIdOrName(at[1]);\n'
    '      if (e) return "【专家设定·" + e.name + "（仅本条消息生效）】\\n" + formatExpertPrompt(e);\n'
    '    }\n'
    '    const active = this.cfg.persona && this.cfg.persona.active;\n'
    '    if (active === "custom") {\n'
    '      const sp = (this.cfg.persona.systemPrompt || "").trim();\n'
    '      return sp ? "【人格设定】\\n" + sp : "";\n'
    '    }\n'
    '    const p = reg.byIdOrName(active);\n'
    '    return p ? "【专家设定·" + p.name + "】\\n" + formatExpertPrompt(p) : "";\n'
    '  }\n'
)
patch_once("personaText", old_persona, new_persona)

# ---- 4. buildSystemAugment 传入 userText ----
patch_once(
    "augment-pass-usertext",
    "const persona = this.personaText();",
    "const persona = this.personaText(userText);",
)

# ---- 5. runSubAgent：专家选项 + 抽出可测纯函数 ----
old_doc = (
    '  /* 运行一个子智能体：在父工作区内读/搜/写/改/运行命令，完成一项聚焦子任务并返回结果文本。\n'
    '     - 禁止递归 agent、禁止 plan/undo，工具集收敛为只读+改动类\n'
    '     - UI 静默：子智能体的工具时间线不刷到主界面（仍真实改动工作区并刷新编辑器）\n'
    '     - 轮数上限 maxRounds，避免失控 */\n'
)
new_doc = (
    '  /* 运行一个子智能体：在父工作区内读/搜/写/改/运行命令，完成一项聚焦子任务并返回结果文本。\n'
    '     - 禁止递归 agent、禁止 plan/undo，工具集收敛为只读+改动类\n'
    '     - W2：opts.expert 可选专家——子智能体按专家 role/methodology 执行，工具按白名单进一步收敛\n'
    '     - UI 静默：子智能体的工具时间线不刷到主界面（仍真实改动工作区并刷新编辑器）\n'
    '     - 轮数上限 maxRounds，避免失控 */\n'
)
patch_once("runSubAgent-doc", old_doc, new_doc)

old_head = (
    '  async runSubAgent(task, opts) {\n'
    '    opts = opts || {};\n'
    '    const type = opts.subagent_type || "general";\n'
    '    const SUB_PROMPT = "你是一个子智能体（类型：" + type + "），在父智能体的同一工作区内执行一项具体子任务。" +\n'
    '      "要求：目标明确、独立完成，不要向用户追问；不要创建计划、不要调用 plan/undo 类工具；" +\n'
    '      "优先用 read_file / search_code / search_symbol / repo_map 理解代码，再动手写或改。" +\n'
    '      "完成后用简洁中文汇报你做了什么、结果如何。你拥有读/搜/写/改/运行命令的权限。";\n'
    '    // 子智能体工具白名单：排除会自我嵌套或污染主流程的工具\n'
    '    const BLOCK = new Set(["agent", "create_plan", "update_plan", "undo", "set_goal", "instantiate_template", "save_template", "remove_template", "list_templates", "goal_status", "save_session_memory"]);\n'
    '    const subTools = TOOLS.filter((t) => !BLOCK.has(t.function.name));\n'
    '    const messages = [\n'
    '      { role: "system", content: SUB_PROMPT },\n'
    '      { role: "user", content: task },\n'
    '    ];\n'
)
new_head = (
    '  /* 子智能体系统提示词（纯函数，可测）：无专家 → 通用约束；有专家 → 专家角色+方法论+约束 */\n'
    '  _subSystemPrompt(type, expert) {\n'
    '    const base = "你是一个子智能体（类型：" + type + "），在父智能体的同一工作区内执行一项具体子任务。" +\n'
    '      "要求：目标明确、独立完成，不要向用户追问；不要创建计划、不要调用 plan/undo 类工具；" +\n'
    '      "优先用 read_file / search_code / search_symbol / repo_map 理解代码，再动手写或改。" +\n'
    '      "完成后用简洁中文汇报你做了什么、结果如何。你拥有读/搜/写/改/运行命令的权限。";\n'
    '    if (!expert) return base;\n'
    '    return "你是子智能体，按以下专家角色行事（类型：" + type + "）：\\n" +\n'
    '      "【专家设定·" + expert.name + "】\\n" + formatExpertPrompt(expert) + "\\n\\n" +\n'
    '      "在以上专家角色与方法论的约束下执行子任务：目标明确、独立完成，不要向用户追问；不要创建计划、不要调用 plan/undo 类工具。" +\n'
    '      "完成后用简洁中文汇报你做了什么、结果如何。你的可用工具可能被专家白名单收敛。";\n'
    '  }\n'
    '\n'
    '  /* 子智能体工具集（纯函数，可测）：先排除 SUB_AGENT_BLOCK，再按专家白名单收敛。\n'
    '     安全：白名单只能进一步收紧（交集），无法解锁 BLOCK 工具；白名单全不命中时回退未收敛集（防呆）。 */\n'
    '  _subToolset(expert) {\n'
    '    let subTools = TOOLS.filter((t) => !SUB_AGENT_BLOCK.has(t.function.name));\n'
    '    if (expert && Array.isArray(expert.tool_whitelist) && expert.tool_whitelist.length) {\n'
    '      const wl = new Set(expert.tool_whitelist);\n'
    '      const filtered = subTools.filter((t) => wl.has(t.function.name));\n'
    '      if (filtered.length) subTools = filtered;\n'
    '    }\n'
    '    return subTools;\n'
    '  }\n'
    '\n'
    '  async runSubAgent(task, opts) {\n'
    '    opts = opts || {};\n'
    '    const type = opts.subagent_type || "general";\n'
    '    // W2：可选专家人设——按专家 role/methodology 执行，工具按白名单收敛\n'
    '    const expert = opts.expert ? (this.experts || ExpertStore.builtinOnly()).byIdOrName(opts.expert) : null;\n'
    '    const subTools = this._subToolset(expert);\n'
    '    const messages = [\n'
    '      { role: "system", content: this._subSystemPrompt(type, expert) },\n'
    '      { role: "user", content: task },\n'
    '    ];\n'
)
patch_once("runSubAgent-head", old_head, new_head)

# ---- 6. agent 工具 schema 加 expert 参数 ----
patch_once(
    "schema-expert",
    '          subagent_type: { type: "string", description: "可选：general/explorer/coder，默认 general" },\n',
    '          subagent_type: { type: "string", description: "可选：general/explorer/coder，默认 general" },\n'
    '          expert: { type: "string", description: "可选：专家角色 id 或名称（如 fullstack、代码审查专家），子智能体按该专家的方法论执行并收敛工具" },\n',
)

# ---- 写 .new 并立即换入 ----
newp = P + ".new"
io.open(newp, "w", encoding="utf-8", newline="").write(src)
os.replace(newp, P)
print("OK applied:", ", ".join(applied))
print("size:", len(orig), "->", len(src))
