/* AppError 单测（Vitest） */

const { AppError, classifyError } = require("../server/app-error");

describe("AppError", () => {
  it("携带 code/kind/userHint", () => {
    const e = new AppError("FILE_NOT_FOUND", "文件不存在", "请检查路径", "notfound");
    expect(e.code).toBe("FILE_NOT_FOUND");
    expect(e.kind).toBe("notfound");
    expect(e.userHint).toBe("请检查路径");
    expect(e.message).toBe("文件不存在");
    expect(e.name).toBe("AppError");
    expect(e instanceof Error).toBe(true);
  });

  it("默认 kind 为 unknown", () => {
    const e = new AppError("X", "err");
    expect(e.kind).toBe("unknown");
    expect(e.userHint).toBe("err");
  });
});

describe("classifyError", () => {
  it("AppError 直接返回自身属性", () => {
    const e = new AppError("CUSTOM", "msg", "hint", "custom");
    const info = classifyError(e);
    expect(info.code).toBe("CUSTOM");
    expect(info.kind).toBe("custom");
    expect(info.userHint).toBe("hint");
  });

  it("ENOENT → notfound", () => {
    const e = Object.assign(new Error("no such file"), { code: "ENOENT" });
    const info = classifyError(e);
    expect(info.kind).toBe("notfound");
  });

  it("EACCES → permission", () => {
    const e = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const info = classifyError(e);
    expect(info.kind).toBe("permission");
  });

  it("429 → quota", () => {
    const e = new Error("429 rate limit exceeded");
    const info = classifyError(e);
    expect(info.kind).toBe("quota");
  });

  it("401 → auth", () => {
    const e = new Error("401 unauthorized invalid api key");
    const info = classifyError(e);
    expect(info.kind).toBe("auth");
  });

  it("ECONNREFUSED → network", () => {
    const e = new Error("ECONNREFUSED fetch failed");
    const info = classifyError(e);
    expect(info.kind).toBe("network");
  });
});