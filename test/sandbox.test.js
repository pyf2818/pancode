/* ============================================================
   W18 · 命令沙箱运行器单测
   - 后端解析：policy 默认 / docker、wsl 探测失败退回 policy / auto 降级链
   - wrap 包装：docker 的挂载+断网+sh 引号转义、wsl 的路径映射+cd 拼接
   - policy 后端零改动（现状兼容）；包装异常绝不抛出（加固件不当故障点）
   全部注入探测器与纯函数模式（liveWslpath:false），不碰真实 docker/wsl。
   ============================================================ */
const sbx = require("../server/sandbox");

const yes = () => true;
const no = () => false;

describe("resolveBackend —— 后端解析与降级", () => {
  it("未配置 = policy（默认行为零变化）", () => {
    expect(sbx.resolveBackend({}, { docker: yes, wsl: yes }).backend).toBe("policy");
  });
  it("显式 policy 不探测", () => {
    const r = sbx.resolveBackend({ sandbox: { backend: "policy" } }, { docker: yes, wsl: yes });
    expect(r.backend).toBe("policy");
  });
  it("配置 docker 且可用 → docker；不可用 → 退回 policy 并说明原因", () => {
    expect(sbx.resolveBackend({ sandbox: { backend: "docker" } }, { docker: yes, wsl: yes }).backend).toBe("docker");
    const r = sbx.resolveBackend({ sandbox: { backend: "docker" } }, { docker: no, wsl: yes });
    expect(r.backend).toBe("policy");
    expect(r.reason).toContain("退回 policy");
  });
  it("配置 wsl 同理；auto 按 docker→wsl→policy 降级", () => {
    expect(sbx.resolveBackend({ sandbox: { backend: "auto" } }, { docker: yes, wsl: yes }).backend).toBe("docker");
    expect(sbx.resolveBackend({ sandbox: { backend: "auto" } }, { docker: no, wsl: yes }).backend).toBe("wsl");
    expect(sbx.resolveBackend({ sandbox: { backend: "auto" } }, { docker: no, wsl: no }).backend).toBe("policy");
  });
  it("不认识的 backend 值按 policy", () => {
    expect(sbx.resolveBackend({ sandbox: { backend: "jailbreak" } }, { docker: yes, wsl: yes }).backend).toBe("policy");
  });
});

describe("wrap —— docker 硬隔离包装", () => {
  const cfg = { sandbox: { backend: "docker" } };
  it("一次性容器 + 工作区挂载到 /ws + 默认断网", () => {
    const r = sbx.wrap("npm test", { workspace: "E:\\proj\\ws", cfg, detectors: { docker: yes, wsl: no } });
    expect(r.sandboxed).toBe(true);
    expect(r.backend).toBe("docker");
    expect(r.command).toContain("docker run --rm -i");
    expect(r.command).toContain("-v 'E:/proj/ws:/ws'");
    expect(r.command).toContain("-w /ws");
    expect(r.command).toContain("--network none");
    expect(r.command).toContain("node:20-slim");
    expect(r.command.endsWith("sh -c 'npm test'")).toBe(true);
  });
  it("network:true 放开网络；自定义镜像生效", () => {
    const r = sbx.wrap("ping x", { workspace: "/ws", cfg: { sandbox: { backend: "docker", network: true, image: "alpine:3" } }, detectors: { docker: yes, wsl: no } });
    expect(r.command).not.toContain("--network");
    expect(r.command).toContain("alpine:3");
  });
  it("命令里的单引号被安全转义（sh -c 注入面）", () => {
    /* 转义算法直接钉在原语上；wiring 用同原语构造期望，不手写易错字面量 */
    expect(sbx.shQuote("it's")).toBe("'it'\\''s'");
    const cmd = "echo 'it''s'";
    const r = sbx.wrap(cmd, { workspace: "/ws", cfg, detectors: { docker: yes, wsl: no } });
    expect(r.command.endsWith("sh -c " + sbx.shQuote(cmd))).toBe(true);
  });
});

describe("wrap —— wsl 软隔离包装", () => {
  it("工作区映射成 /mnt/<盘> 路径并 cd 进去执行", () => {
    const r = sbx.wrap("npm run dev", { workspace: "E:\\proj\\ws", cfg: { sandbox: { backend: "wsl" } }, detectors: { docker: no, wsl: yes }, liveWslpath: false });
    expect(r.sandboxed).toBe(true);
    expect(r.backend).toBe("wsl");
    expect(r.command).toBe("wsl.exe -e sh -c 'cd \"/mnt/e/proj/ws\" && npm run dev'");
  });
  it("wslPathOf 对 Windows 盘符路径给出 /mnt 猜测值（纯函数模式）", () => {
    expect(sbx.wslPathOf("C:\\a\\b c\\d", null)).toBe("/mnt/c/a/b c/d");
    expect(sbx.wslPathOf("/already/posix", null)).toBe(null);
  });
});

describe("wrap —— policy 与兜底", () => {
  it("policy 原样返回，sandboxed=false", () => {
    const r = sbx.wrap("del /q x", { workspace: "E:\\ws", cfg: {}, detectors: { docker: yes, wsl: yes } });
    expect(r.command).toBe("del /q x");
    expect(r.sandboxed).toBe(false);
  });
  it("没有工作区路径时即便配了 docker 也按 policy 执行", () => {
    const r = sbx.wrap("echo hi", { cfg: { sandbox: { backend: "docker" } }, detectors: { docker: yes, wsl: yes } });
    expect(r.sandboxed).toBe(false);
    expect(r.command).toBe("echo hi");
  });
});

describe("shQuote —— sh 单引号包裹", () => {
  it("普通文本原样；含单引号转义为 '\\''", () => {
    expect(sbx.shQuote("abc")).toBe("'abc'");
    expect(sbx.shQuote("a'b")).toBe("'a'\\''b'");
  });
});
