/* ============================================================
   classifyLlmError：把"限流"从"上下文超限"里择出来

   为什么值得单测：用户实际收到的那张卡片写着"上下文超限 / 流挂起（自动压缩后重试）"，
   而底层错误是 HTTP 429 "inference exceeds tpm/rpm limit"——限流。
   限流与上下文的文案共用 "limit"，谁先判就决定了卡片说什么：
   判成 context，用户会去压缩历史、白费；判成 quota，用户知道该降并发。
   真实调用里 llm.js 抛的是 `"LLM 请求失败 HTTP 429: …"`，429 不在串首，
   所以用例都以完整消息文本喂进去，与 catch 到的 e.message 一致。
   ============================================================ */
const { classifyLlmError } = require("../server/app-error.js");

const K = (msg, status) => {
  const e = new Error(msg);
  if (status != null) e.status = status;
  return e;
};

describe("classifyLlmError", () => {
  it("用户遇到的真实 429 → quota，不是 context", () => {
    const msg = "LLM 请求失败 HTTP 429: {\"error\":{\"message\":\"inference exceeds tpm/rpm limit\",\"type\":\"rate_limit_error\",\"code\":\"RateLimitExceeded.EndpointRPMExceeded\"}}";
    expect(classifyLlmError(K(msg, 429), msg)).toBe("quota");
    expect(classifyLlmError(K("LLM 请求失败 HTTP 429: inference exceeds tpm/rpm limit"), "LLM 请求失败 HTTP 429: inference exceeds tpm/rpm limit")).toBe("quota");
  });

  it("status===429 时消息没有 429 字样也算限流", () => {
    const msg = "inference exceeds tpm/rpm limit";
    expect(classifyLlmError(K(msg, 429), msg)).toBe("quota");
  });

  it("限流措辞（rate limit / quota / tpm / rpm）即使 4xx 也不是上下文", () => {
    expect(classifyLlmError(K("HTTP 429 rate limit: too many tokens per minute"), "HTTP 429 rate limit: too many tokens per minute")).toBe("quota");
    expect(classifyLlmError(K("HTTP 400 request exceeds quota of the endpoint"), "HTTP 400 request exceeds quota of the endpoint")).toBe("quota");
  });

  it("真正的上下文超限 → context", () => {
    expect(classifyLlmError(K("HTTP 400 maximum context length is 8192"), "HTTP 400 maximum context length is 8192")).toBe("context");
    expect(classifyLlmError(K("HTTP 400 This model's maximum context length is 4096 tokens"), "HTTP 400 This model's maximum context length is 4096 tokens")).toBe("context");
    expect(classifyLlmError(K("HTTP 400 content too large"), "HTTP 400 content too large")).toBe("context");
    expect(classifyLlmError(K("HTTP 400 prompt is too long"), "HTTP 400 prompt is too long")).toBe("context");
    expect(classifyLlmError(K("HTTP 400 上下文超出模型窗口"), "HTTP 400 上下文超出模型窗口")).toBe("context");
  });

  it("流空闲超时 → context（卡片『流挂起』半句的真实来源）", () => {
    expect(classifyLlmError(K("LLM 流空闲超时（90s 无数据），流可能已挂起"), "LLM 流空闲超时（90s 无数据），流可能已挂起")).toBe("context");
    expect(classifyLlmError(K("stream idle timeout after 90000ms"), "stream idle timeout after 90000ms")).toBe("context");
  });

  it("裸 'exceeds' 不再是上下文信号", () => {
    // 修复前：context 档的裸 exceeds 会把 429 限流吃成"历史太长"
    expect(classifyLlmError(K("HTTP 400 exceeds"), "HTTP 400 exceeds")).toBe("unknown");
  });

  it("network / key / model 互不串味", () => {
    expect(classifyLlmError(K("fetch failed"), "fetch failed")).toBe("network");
    expect(classifyLlmError(K("HTTP 401 Unauthorized: invalid api key"), "HTTP 401 Unauthorized: invalid api key")).toBe("key");
    expect(classifyLlmError(K("HTTP 404 model not found"), "HTTP 404 model not found")).toBe("model");
    expect(classifyLlmError(K("HTTP 429 {\"error\":{\"code\":\"RateLimitExceeded.EndpointRPMExceeded\"}}"), "HTTP 429 {\"error\":{\"code\":\"RateLimitExceeded.EndpointRPMExceeded\"}}")).toBe("quota");
  });
});
