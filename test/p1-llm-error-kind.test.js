/* ============================================================
   classifyLlmError：把"限流"从"上下文超限"里择出来

   为什么值得单测：用户实际收到的那张卡片写着"上下文超限 / 流挂起（自动压缩后重试）"，
   而底层错误是 HTTP 429 "inference exceeds tpm/rpm limit"——限流。
   限流与上下文的文案共用 "limit"，谁先判就决定了卡片说什么：
   判成 context，用户会去压缩历史、白费；判成 quota，用户知道该降并发。
   真实调用里 llm.js 抛的是 `"LLM 请求失败 HTTP 429: …"`，429 不在串首，
   所以用例都以完整消息文本喂进去，与 catch 到的 e.message 一致。
   ============================================================ */
const { classifyLlmError, isVisionRejection, isVisionRelated } = require("../server/app-error.js");

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

/* ============================================================
   视觉拒收判定：决定的是"这台引擎以后还不喂像素"
   ————————————————————————————————————————————
   判错的代价不对称，所以单独一把尺子：
   · 漏判 → 带图请求失败一次，用户看得见真实错误；
   · 误判 → 视觉被关到引擎重建为止，而且那句"模型不带视觉"把真正的错误盖掉了。
     以前用的宽正则里有一条 invalid_request，等于"任何 400 都算模型不带视觉"。
   用例都取各家上游的原话，不自己编措辞。
   ============================================================ */
describe("isVisionRejection（永久停喂像素的唯一入口）", () => {
  it("上游明说不收图片 → 判成视觉拒收", () => {
    const yes = [
      "HTTP 400 invalid_request_error: image content type is not supported by this model",
      "HTTP 400 This model does not support image inputs",
      "HTTP 400 Invalid value: 'image_url'. Expected 'text'.",
      "HTTP 400 messages.0.content.0.type: image is not supported",
      "HTTP 400 this model is text-only and cannot accept vision inputs",
      "HTTP 400 Unsupported content type. Only text is supported.",
      "HTTP 400 multimodal not enabled for this deployment",
    ];
    for (const msg of yes) {
      expect(isVisionRejection(K(msg, 400), msg) && classifyLlmError(K(msg, 400), msg) === "unknown").toBe(true);
    }
  });

  it("与图片无关的 400 不算视觉拒收（修复前 invalid_request 一条通吃）", () => {
    expect(isVisionRejection("HTTP 400 invalid_request_error: tools[0].function.name is required")).toBe(false);
    expect(isVisionRejection("HTTP 404 model vision-test not found")).toBe(false);   // 模型名里带 vision
    expect(isVisionRejection("HTTP 400 image is too large, resize it")).toBe(false); // 是这张图的问题，不是没视觉
    expect(isVisionRejection("HTTP 400 the image_url base64 payload is invalid")).toBe(false);
  });

  it("上下文超限的措辞里提到图片，走压缩那条路而不是关视觉", () => {
    const msg = "HTTP 400 image tokens push you over the maximum context length";
    expect(classifyLlmError(K(msg, 400), msg)).toBe("context");
    expect(isVisionRejection(K(msg, 400), msg)).toBe(false);
  });

  it("isVisionRelated 比永久判定宽：与图沾边的失败都值得摘掉像素重试一次", () => {
    expect(isVisionRelated("HTTP 400 image is too large, resize it")).toBe(true);
    expect(isVisionRelated("HTTP 400 unsupported content type")).toBe(true);
    expect(isVisionRelated("HTTP 400 invalid_request_error: tools[0].function.name is required")).toBe(false);
  });
});
