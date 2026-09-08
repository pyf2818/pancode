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
  const msg = (err && err.message ? err.message : String(err || "")).toLowerCase();
  if (err instanceof AppError) return { code: err.code, kind: err.kind, message: err.message, userHint: err.userHint };
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

module.exports = { AppError, classifyError };