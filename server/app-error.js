/* ============================================================
   统一错误处理：AppError + classifyError
   —— 结构化错误 { code, kind, userHint }，替代裸 Error
   ============================================================ */
"use strict";

/* AppError: 携带错误码 + 用户可读提示的结构化错误 */
class AppError extends Error {
  constructor(code, message, userHint, kind) {
    super(message);
    this.name = "AppError";
    this.code = code;           // 机器可读错误码，如 "FILE_WRITE_FAILED"
    this.userHint = userHint || message || "";
    this.kind = kind || "unknown";
  }
}

/* 从任意错误对象分类推断 kind + userHint（供 safe() 包装用） */
function classifyError(err) {
  if (err instanceof AppError) return { code: err.code, kind: err.kind, message: err.message, userHint: err.userHint };
  const msg = (err && err.message ? err.message : String(err || "")).toLowerCase();
  let kind = "unknown", userHint = err && err.message || String(err);
  if (err && err.code === "ENOENT" || msg.includes("no such file") || msg.includes("does not exist")) {
    kind = "notfound"; userHint = "文件或路径不存在，请检查路径是否正确。";
  } else if (err && err.code === "EACCES" || err && err.code === "EPERM" || msg.includes("permission")) {
    kind = "permission"; userHint = "权限不足，无法执行该操作。请检查文件/目录权限。";
  } else if (err && err.code === "ENOSPC") {
    kind = "nospace"; userHint = "磁盘空间不足。请清理后重试。";
  } else if (msg.includes("econn") || msg.includes("timeout") || msg.includes("network") || msg.includes("fetch failed")) {
    kind = "network"; userHint = "网络异常，请检查连接后重试。";
  } else if (msg.includes("429") || msg.includes("rate") || msg.includes("quota")) {
    kind = "quota"; userHint = "请求过于频繁或配额已满，请稍后重试。";
  } else if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("invalid api key")) {
    kind = "auth"; userHint = "认证失败，请检查 API Key 或登录状态。";
  }
  return { code: err && err.code || "UNKNOWN", kind, message: err && err.message || String(err), userHint };
}

/* ============================================================
   LLM 错误分类：五个 kind 的唯一真相源
   —— context / quota / network / key / model / unknown

   为什么单独抽出来：agent-llm 有两处独立的"这条错误该走哪条恢复路径"
   判断（① 卡片分类 hint ② 循环内"上下文超限→强制压缩→重试"的自愈）。
   两处各写一份正则就会漂移：修了卡片那一处，自愈那一处还在误判。
   更具体的坑在下面注释里（限流文案与上下文文案会共用一个词）。

   判定顺序（刻意为之，不是随手排的）：
     1) context  —— 只有 4xx 或空闲超时才可能是上下文问题
     2) quota    —— 429 优先于"消息里含 limit"，否则限流会被 context 吃掉
     3) network / key / model
   裸词匹配不加状态码约束的后果是真实的：一条 429 写着
   "inference exceeds tpm/rpm limit"，exceeds + limit 两个词都在
   context 那档里，分类就成了"上下文超限（自动压缩重试）"——
   于是用户(tmp/rpm 打满)看到的是"你的历史太长了"，去点压缩，白费。
   ============================================================ */

/* 上下文超限：只在 4xx 或流空闲超时下成立（其余一律不当上下文问题） */
const LLM_CTX_RE = /(context length|context window|context too long|maximum context|max context|too many tokens|token limit|exceeded .*token|exceeds .*token|maximum .*length|prompt .*(too long|too large)|reduce the length|content too large|上下文|超出.*(限制|长度))/i;
const LLM_CTX_STATUS_RE = /^4\d\d$/;
const LLM_IDLE_RE = /流空闲超时|stream (idle|stalled|hung)|no data for/i;

/* 限流 / 配额：status 429 或明确的限流措辞（与 context 档刻意分开） */
const LLM_QUOTA_RE = /(\b429\b|rate.?limit|too many requests|quota|insufficient.?quota|tpm|rpm|requests per|limit reached)/i;
/* 模型不存在：状态码 404，或 "model ... not found / does not exist" */
const LLM_MODEL_RE = /(\b404\b|model .*(not found|does not exist|not exist))/i;

/* 分类结果只产出 kind（恢复路径由此决定），不产出文案：
   hint 属于 UI，改字不该影响走哪条分支。 */
function classifyLlmError(err, msg) {
  const text = typeof msg === "string" ? msg : (err && err.message ? err.message : String(err || ""));
  const status = Number(err && err.status);
  const hasStatus = Number.isFinite(status) && status > 0;
  const ctxStatusOk = (hasStatus && LLM_CTX_STATUS_RE.test(String(status)))
    || (!hasStatus && /4\d\d/.test(text));   // 消息里的 "HTTP 4xx" 前缀同样算数

  // HTTP 429 = 限流，这是硬规则，永远最先判：
  // 限流与上下文超限的文案常共用 "limit"（"exceeds tpm/rpm limit" 两边都命中），
  // 先判 context 的话，限流会被误报成"历史太长"，用户去压缩历史毫无作用。
  const is429 = (hasStatus && status === 429) || /\b429\b/i.test(text);
  const isIdle = LLM_IDLE_RE.test(text);
  const isCtx = isIdle || (ctxStatusOk && LLM_CTX_RE.test(text));
  if (is429) return "quota";
  if (isCtx) return "context";
  // 没有 429 时才看措辞：rate limit / quota / tpm / rpm …
  if (LLM_QUOTA_RE.test(text)) return "quota";
  if (msgIncludesAny(text, ["econn", "timeout", "network", "fetch failed", "enotfound", "socket", "aborted"])) {
    return "network";
  }
  if (msgIncludesAny(text, ["401", "unauthorized", "invalid api key", "incorrect api key", "authentication", "api key"])) {
    return "key";
  }
  // model：404 / "model ... not found"。只认最前面的状态码，正文里出现 404（比如
  // "gateway returned 404 upstream"）不至于把一条限流/鉴权错误拽成 model。
  if (LLM_MODEL_RE.test(text)) return "model";
  return "unknown";
}

function msgIncludesAny(msg, words) {
  return words.some((w) => msg.includes(w));
}

module.exports = { AppError, classifyError, classifyLlmError };