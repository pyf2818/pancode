/* ============================================================
   agent-helpers —— agent-llm 的纯函数层（W21 第一阶段拆分）
   ------------------------------------------------------------
   这里只放"不碰 this、不碰磁盘之外的状态、给定输入必得同样输出"的原语：
   tool_call 历史净化 / CJK token 估算 / 轮次组切分与孤儿修复 /
   规则路径与预算 / 子智能体写目标。拆出来的目的：单测直接钉这层，
   agent-llm.js 专注循环与状态（5100 行 god-file 的第一刀，行为零变化，
   agent-llm 通过 require 继续拿到同名绑定，_ctx 导出面不变）。
   ============================================================ */
"use strict";
const os = require("os");
const path = require("path");
const fs = require("fs");
const TOOL = require("./tools/contract");   // MICROCOMPACTABLE_TOOLS 的唯一真相源

/* ============================================================
   历史 tool_call 净化（防御性）
   商汤 SenseNova 等严格网关对 tool_call 的 name / arguments 做非空校验，
   空串会直接返回 400（invalid arguments / code 3）。修复前版本可能把
   无参工具流式返回的空 arguments 直接持久化进对话存档；重开旧对话重发
   历史时会复现 400。加载存档时统一补齐，避免"配置正确但每条消息都 400"。
   - 仅修正 name / arguments；保留原始 id 以免破坏与 tool 消息的配对。
   ============================================================ */
function _sanitizeToolCall(tc) {
  if (!tc || typeof tc !== "object") return tc;
  const fn = tc.function || {};
  const name = (fn.name && String(fn.name).trim()) ? fn.name : "unknown";
  const argsRaw = fn.arguments;
  const args = (argsRaw != null && String(argsRaw).trim()) ? String(argsRaw) : "{}";
  return Object.assign({}, tc, { function: { name, arguments: args } });
}
function _sanitizeHistory(history) {
  if (!Array.isArray(history)) return history;
  return history.map((m) =>
    m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length
      ? Object.assign({}, m, { tool_calls: m.tool_calls.map(_sanitizeToolCall) })
      : m
  );
}

/* ============================================================
   Token 估算：CJK 权重
   一个汉字在上游 BPE 里通常占 0.6~1 token，而按 len/4 只给 0.25 ——
   对以中文为主的载荷（pancode 的规则/记忆/注释/回复全是中文）会系统性
   低估 2~4 倍。后果不是"数字不准"而是"压缩触发过晚"：我们自己算着没满，
   上游却直接回 400，长任务因此中途断掉。宁可高估（早一点压缩），
   也不要低估（撞墙）。与主流 harness 一致：CJK 按 2 个"估算字符"计。
   覆盖：CJK 标点/假名/扩展 A/基本汉字/谚文/全角形式。
   ============================================================ */
const CJK_CHAR_RE = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/g;
function estTextTokens(str) {
  const s = String(str == null ? "" : str);
  if (!s) return 0;
  let cjk = 0;
  // 用 matchAll 而不是 match+length：全局正则下 length 才是真字符数
  for (const _ of s.matchAll(CJK_CHAR_RE)) cjk++;
  return Math.ceil((cjk * 2 + (s.length - cjk)) / 4);
}

/* ============================================================
   历史按「轮次组」切分：一条带 tool_calls 的 assistant 必须与紧随其后的
   N 条 role:"tool" 结果同进同出。
   OpenAI 兼容协议对不成对的 tool_call_id 直接回 400，而且这条 400 发生在
   「我们已经压缩完、以为处理好了」之后，是最难排查的一类中断。
   组定义取宽松侧：带 tool_calls 的 assistant 起头，吸收其后连续的 tool 消息；
   其余消息各自成组。孤儿 tool 消息（前文已被更早的压缩吞掉）单独成组，
   绝不并入别的组 —— 否则它会跟着一个没有 tool_calls 的 assistant 一起被保留或丢弃。
   ============================================================ */
function groupHistoryByToolPairing(history) {
  const groups = [];
  let pendingIds = null;
  for (const m of history || []) {
    if (m && m.role === "tool" && pendingIds && pendingIds.has(m.tool_call_id)) {
      groups[groups.length - 1].items.push(m);
      pendingIds.delete(m.tool_call_id);
      if (!pendingIds.size) { pendingIds = null; }
      continue;
    }
    pendingIds = null;
    const group = { items: [m] };
    groups.push(group);
    if (m && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      pendingIds = new Set(m.tool_calls.map((t) => t.id));
    }
  }
  return groups;
}

/* 把分组摊平回消息数组（按区间取用时的便捷函数） */
function flattenGroups(groups) {
  const out = [];
  for (const g of groups || []) for (const m of g.items) out.push(m);
  return out;
}

/* 超长历史裁剪：从最新往回收完整轮次组，不把 tool_calls 与结果切开。
   单组就超过上限时整组保留（宁超不切）。
   以前调用点写的是 groups[i].length —— 那是 undefined，且 kept.flat() 留下的是
   { items:[...] } 对象而不是消息，发给上游直接 400。这条路径只在 100 条以上才走到，
   常规会话测不出来，所以把它收成纯函数单测。 */
function trimHistoryGroups(history, max) {
  const list = Array.isArray(history) ? history : [];
  const cap = Math.max(1, Math.floor(Number(max) || 100));
  if (list.length <= cap) return list;
  const groups = groupHistoryByToolPairing(list);
  const kept = [];
  let total = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    const n = groups[i].items.length;
    if (total > 0 && total + n > cap) break;
    kept.unshift(groups[i]);
    total += n;
  }
  return flattenGroups(kept);
}

/* ============================================================
   历史配对修复（崩溃/中断恢复）
   典型事故：一条 assistant.tool_calls 已经落进对话存档，但它对应的
   role:"tool" 结果还没写回来 —— 最常见的窗口是工具卡在人工确认
   （approvalSec 默认 20 分钟），期间用户刷新页面 / 重启服务，
   flushConversations 把「半截的一轮」原样落盘。重开这条会话再发请求，
   OpenAI 兼容上游会因为 tool_call_id 不成对直接回 400 —— 表现为
   「配置没问题、模型也没问题，但这条老对话一发消息就报错」。
   修复策略：给缺失的结果补一条保守的错误消息，并把「能不能重试」的
   判断权交给模型 —— 有副作用的操作必须先核实外部状态，不许盲目重试。
   ============================================================ */
function toolOutcomeUnknownText(name) {
  return "[未收到结果] 上一次进程在 " + (name || "该工具")
    + " 返回之前中断，这条调用的结果未知。\n"
    + "仅当它是只读或幂等操作时才可以重试；若可能已经产生副作用（写文件、删除、执行命令、提交），"
    + "请先核实外部状态（文件当前内容、命令是否已生效）或询问用户，不要盲目重试。";
}

/* 返回 { history, fixed, droppedOrphans }。不修改入参数组。 */
function repairToolPairing(history) {
  if (!Array.isArray(history) || !history.length) {
    return { history: history || [], fixed: 0, droppedOrphans: 0 };
  }
  const haveResult = new Set();
  const declared = new Set();
  for (const m of history) {
    if (!m) continue;
    if (m.role === "tool" && m.tool_call_id) haveResult.add(m.tool_call_id);
    if (Array.isArray(m.tool_calls)) for (const t of m.tool_calls) if (t && t.id) declared.add(t.id);
  }
  let fixed = 0, droppedOrphans = 0;
  const out = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m && m.role === "tool") {
      // 孤儿结果：它对应的 assistant 已被更早的一次压缩吞掉了，留着同样不成对
      if (!declared.has(m.tool_call_id)) { droppedOrphans++; continue; }
      out.push(m);
      continue;
    }
    out.push(m);
    if (!(m && Array.isArray(m.tool_calls) && m.tool_calls.length)) continue;
    // 先跳过该 assistant 后面已有的连续结果，再把缺的按声明顺序补在其后 ——
    // 不重排真实结果的位置，只把合成结果垫在最后。
    let j = i + 1;
    while (j < history.length && history[j] && history[j].role === "tool") {
      if (declared.has(history[j].tool_call_id)) out.push(history[j]);
      else droppedOrphans++;
      j++;
    }
    for (const t of m.tool_calls) {
      if (!t || !t.id || haveResult.has(t.id)) continue;
      fixed++;
      out.push({ role: "tool", tool_call_id: t.id, content: toolOutcomeUnknownText(t.function && t.function.name) });
    }
    i = j - 1;
  }
  return { history: out, fixed, droppedOrphans };
}

/* ============================================================
   microcompact 参数（不调模型的廉价通道）
   数值取自业界同类实现的量级：保留最近 5 轮只读结果、省不到 256 token 就不动手。
   ============================================================ */
const MICROCOMPACT_KEEP_RECENT_ROUNDS = 5;       // 最近 N 个"带工具结果的轮次"保留原文
const MICROCOMPACT_MIN_TOKEN_SAVINGS = 256;      // 低于此收益整体放弃（别白动历史）
const MICROCOMPACT_THRESHOLD_RATIO = 0.9;        // 到阈值的 90% 先做便宜的那一遍
const MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2000;  // 或离阈值还差 2000 token，取更保守的一个
const MICROCOMPACT_CLEARED = "[旧工具结果已清理]";
/* spill（超长工具结果全文落盘）上限：单文件字符数与每会话保留份数。
   数值取"够装下一次完整构建日志，又不至于吃掉磁盘"的量级。 */
const SPILL_MAX_FILE_CHARS = 4 * 1024 * 1024;
const SPILL_MAX_FILES_PER_CONV = 60;
/* —— 视觉：把截图的像素交给模型 ——
   工具结果通道装不了图：OpenAI 规范的 role:"tool" content 只能是字符串，硬塞数组会被上游 400。
   所以走"工具落盘 + 下一次请求前附一条多模态 user 消息"，而且只在模型显式要（for_model:true）时喂。
   base64 不进对话历史（历史只在本轮请求里临时带上），否则每截图一次就往 .pancode 里塞几百 KB。 */
const VISION_MAX_BYTES = 3 * 1024 * 1024;        // 单张图超过这个数不喂：上传体积与 token 都不划算
const VISION_MAX_PER_ROUND = 4;                  // 一轮最多带几张，再多只会把水位顶穿
const VISION_IMAGE_TOKEN_ESTIMATE = 1500;        // 估算口径（真实占用以 usage 实测锚点为准）
/* 可清理的工具：结果可再生、且体量以"读回来的原文"为主。
   写类/计划类的结果不在此列 —— 它们承载的是"我改了什么"，不可再生。
   名单来自契约表（注意 run_command 也在其中，理由与保留意见见 contract.js 末"已知偏差 2"）。 */
const MICROCOMPACTABLE_TOOLS = TOOL.DERIVED.MICROCOMPACTABLE;

/* ============================================================
   P1-B6 · 摘要压缩（贵的那一遍）的三条硬约定
   - SUMMARY_PREFIX：摘要消息的固定开头。第二次压缩要靠它把「上一版摘要」从历史里认出来；
     认不出来就会把摘要再摘要一次，压到第三层只剩模型对自己的转述，事实早就凉了。
   - COMPACT_SECTIONS：九段模板。段名是契约——单测按它清点，界面「上下文」面板也照它解释保留了什么。
   - COMPACT_POST_REMINDER：挂在摘要同一条消息尾部的提醒。压完最常见的两种跑偏是
     「向用户复述一遍摘要」和「停下来问是否继续」，都得在这里堵住。
   ============================================================ */
const SUMMARY_PREFIX = "[历史摘要] ";
const COMPACT_SECTIONS = [
  "【任务目标】用户到底要什么，包括没说出口但能确定的验收标准",
  "【全部用户消息】按顺序逐条列用户每次输入的要点；更正、否决、临时加上的约束都必须留",
  "【已定决策】采纳与被否决的方案各是什么、为什么。被否决的必须写，否则下一轮会再提一遍",
  "【已改文件】路径 + 一句话改动，逐个列，不许合并成「若干文件」",
  "【验证状态】跑过什么命令、通过还是失败、失败的首行报错原文",
  "【待办任务】还没做的事，逐条",
  "【当前工作】压缩那一刻正在进行的那一步，具体做到哪了",
  "【下一步】引用最近一轮里的原话片段，说明紧接着的第一个动作",
  "【安全约束】规则与用户明令的硬约束逐字保留：禁止项、必须项、可写目录边界",
];

/* 规则读取与注入预算（P1-#11）。
   旧实现只有 MAX_TOTAL 这一个「渲染」上限，读取侧完全不设限，于是有两个真实后果：
     ① 一个几百 KB 的 AGENTS.md 会被整份读进内存（每发一条消息读一次）；
     ② 更糟的是它在 assemble 里作为第一个块就把预算吃光 → 直接 break，
        结果这条规则一个字都没注入，还连带把它后面的全部规则一起丢掉。
        表现为"我明明写了 AGENTS.md，模型却像没看见"，而面板里它显示为生效。
   所以拆成三层：磁盘不读上限 / 单文件注入上限（超出截断并如实说明）/ 分桶渲染预算。 */
const RULE_READ_CAP = 256 * 1024;      // 超过这个字节数的规则文件不读盘，只留一条说明
const RULE_MAX_FILE_CHARS = 8000;      // 单个规则文件最多注入的字符数
const RULE_MAX_STABLE = 12000;         // 与本轮输入无关的规则桶预算
const RULE_MAX_CONDITIONAL = 4000;     // 本轮按路径命中的规则桶预算

/* 用户全局规则文件路径（跨项目个人约定，对齐 ~/.claude/CLAUDE.md 的位置约定）。
   homedir() 在无 HOME 的环境可能抛错或返回空串 —— 拿不到就当没有这一层，不影响项目级规则。 */
function userGlobalRulePath() {
  try {
    const home = os.homedir();
    if (!home) return null;
    const p = path.join(home, ".pancode", "AGENTS.md");
    return fs.existsSync(p) ? p : null;
  } catch (e) { return null; }
}

/* 规则匹配用的路径规范化（纯字符串，不碰磁盘；真正的越界拦截仍归 FileStore.safePath）。
   模型写路径没有稳定习惯：src/x.js、./src/x.js、src\x.js、/src/x.js 都出现过，
   而 allow/deny 的 glob 是 ^…$ 锚定的 —— 不归一，整条规则就静默不命中，
   表现为"我明明 deny 了 src/**，它还是改了"。
   只做四件事：反斜杠转正斜杠、去掉盘符与前导 /、折叠 ./ 与空段、保留 ..（交给 safePath 判越界）。 */
function canonicalRulePath(p) {
  let s = String(p == null ? "" : p).replace(/\\/g, "/").trim();
  if (!s) return "";
  s = s.replace(/^[A-Za-z]:/, "");          // Windows 盘符
  while (s.startsWith("/")) s = s.slice(1); // 绝对写法统一成"相对根"
  const out = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    out.push(seg);
  }
  return out.join("/");
}

/* 段边界前缀匹配：pattern "src" 命中 "src/x.js"，但不命中 "src-secret/x.js"。
   迁移前用的是无边界 startsWith，于是 allow 规则 "src" 会连带放行 "src-eval/x.js" ——
   放行面的误命中比拒绝面的漏命中更危险，所以这里收紧到分隔符边界。 */
function pathPrefixHit(pattern, value) {
  const p = canonicalRulePath(String(pattern).replace(/\*+$/g, "").trim());
  if (!p) return false;
  if (value === p) return true;
  return value.startsWith(p + "/");
}

/* 并行改盘要按文件认领，就得先知道"这次调用会写到哪些文件"。
   只有按文件寻址的工具能答这个问题：write_file/delete_file 一个 path，apply_edit 可能带 edits[]，
   edit_files 带 ops[]（同一文件可能重复出现，去重）。
   run_command / rename_symbol / git_* 故意不在表里 —— 它们能碰到任何地方，预先认领不了；
   那类改盘的归属交给收尾的"无法归因"口径如实报出来，不假装收回了。 */
function subWriteTargets(name, args) {
  const out = [];
  const add = (p) => { const s = String(p == null ? "" : p).trim(); if (s && out.indexOf(s) < 0) out.push(s); };
  if (!args) return out;
  if (name === "write_file" || name === "delete_file" || name === "apply_edit") {
    add(args.path);
    if (Array.isArray(args.edits)) args.edits.forEach((e) => e && add(e.path));
  } else if (name === "edit_files") {
    (Array.isArray(args.ops) ? args.ops : []).forEach((op) => op && add(op.path));
  }
  /* 跨根时路径键要带上是哪个根，否则两个项目里的同名文件会被认成同一个 */
  const root = String(args.root || "").trim();
  return out.map((p) => (root && !path.isAbsolute(p) ? "@" + root + "/" + p : p));
}

module.exports = {
  _sanitizeToolCall, _sanitizeHistory, estTextTokens, CJK_CHAR_RE,
  groupHistoryByToolPairing, flattenGroups, trimHistoryGroups, toolOutcomeUnknownText, repairToolPairing,
  MICROCOMPACT_KEEP_RECENT_ROUNDS, MICROCOMPACT_MIN_TOKEN_SAVINGS, MICROCOMPACT_THRESHOLD_RATIO,
  MICROCOMPACT_THRESHOLD_BUFFER_TOKENS, MICROCOMPACT_CLEARED, MICROCOMPACTABLE_TOOLS,
  SPILL_MAX_FILE_CHARS, SPILL_MAX_FILES_PER_CONV,
  VISION_MAX_BYTES, VISION_MAX_PER_ROUND, VISION_IMAGE_TOKEN_ESTIMATE,
  SUMMARY_PREFIX, COMPACT_SECTIONS,
  RULE_READ_CAP, RULE_MAX_FILE_CHARS, RULE_MAX_STABLE, RULE_MAX_CONDITIONAL,
  userGlobalRulePath, canonicalRulePath, pathPrefixHit, subWriteTargets,
};
