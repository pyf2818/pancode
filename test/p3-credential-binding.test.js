/* ============================================================
   审查项 F12：一把 Key 只能属于它本来被发给的那个来源
   两处实测过的错配：
     1) upsertLlmProfile：没显式给 Key 时，把"当前运行时那份 Key"归到新配置名下 ——
        于是把 A 服务商的 Key 存到一条指向别家的配置上，切过去就带着它出网；
     2) applyLlmProfile：`if (key) {...}`，新配置没 Key 就什么都不做 ——
        上一个服务商的 Key 原样留在运行时里，下一次请求发向新地址。
   两条合起来是"改一次地址就顺走一次凭据"。判据要问的是 origin，不是"有没有填"。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");

let tmp, configMod;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-cred-"));
  process.env.PANCODE_DATA_DIR = path.join(tmp, "data");
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  fs.mkdirSync(process.env.PANCODE_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.PANCODE_DATA_DIR, "pancode.config.json"), JSON.stringify({ workspace: tmp }), "utf8");
  configMod = require("../server/config");
});
afterAll(() => {
  delete process.env.PANCODE_DATA_DIR;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
});

/* 变量名按 config.js 文档里写明的规则独立算一遍，不用它自己的函数 ——
   用被测模块的函数算等于自己给自己作证。 */
const keyVar = (id) => "PANCODE_LLM_KEY_" + String(id).replace(/[^0-9a-zA-Z]/g, "").slice(0, 24).toUpperCase();

function freshCfg(baseURL, apiKey) {
  return {
    llm: { baseURL, apiKey, model: "m1" },
    llmProfiles: [],
    workspace: tmp,
  };
}

describe("Key 不跨来源继承", () => {
  it("换到另一个 origin 存配置，不带原服务商的 Key", () => {
    const cfg = freshCfg("https://api.provider-a.example/v1", "sk-SECRET-A");
    const p = configMod.upsertLlmProfile(cfg, { id: "b1", name: "B 家", baseURL: "https://api.provider-b.example/v1", model: "m" });
    expect(p.hasKey).toBe(false);
    expect(process.env[keyVar("b1")]).toBeFalsy();
  });

  it("同一 origin 换个模型，仍然继承（这是「同一家换型号」的真实场景，不该逼人重贴）", () => {
    const cfg = freshCfg("https://api.provider-a.example/v1", "sk-SECRET-A");
    const p = configMod.upsertLlmProfile(cfg, { id: "a2", name: "A 家另一个模型", baseURL: "https://api.provider-a.example/v1", model: "m2" });
    expect(p.hasKey).toBe(true);
    expect(process.env[keyVar("a2")]).toBe("sk-SECRET-A");
  });

  it("显式填了 Key 就存显式的那一份", () => {
    const cfg = freshCfg("https://api.provider-a.example/v1", "sk-SECRET-A");
    configMod.upsertLlmProfile(cfg, { id: "b2", baseURL: "https://api.provider-b.example/v1", model: "m", apiKey: "sk-EXPLICIT-B" });
    expect(process.env[keyVar("b2")]).toBe("sk-EXPLICIT-B");
  });

  it("端口/协议不同的 origin 不算同一家", () => {
    const cfg = freshCfg("https://api.provider-a.example:8443/v1", "sk-SECRET-A");
    const p = configMod.upsertLlmProfile(cfg, { id: "b3", baseURL: "https://api.provider-a.example/v1", model: "m" });
    expect(p.hasKey).toBe(false);
  });
});

describe("切配置时运行时 Key 跟着换，没 Key 就清空", () => {
  it("切到没有 Key 的配置 → 运行时与 .env 里的旧 Key 都被清掉", () => {
    const cfg = freshCfg("https://api.provider-a.example/v1", "sk-SECRET-A");
    process.env.OPENAI_API_KEY = "sk-SECRET-A";
    configMod.upsertLlmProfile(cfg, { id: "bare", baseURL: "https://api.provider-b.example/v1", model: "m" });
    const r = configMod.applyLlmProfile(cfg, "bare");
    expect(r.hasKey).toBe(false);
    expect(cfg.llm.apiKey).toBe("");
    expect(process.env.OPENAI_API_KEY).toBeFalsy();   // setEnvVar 空值走 delete，读回来是 undefined
    expect(cfg.llm.baseURL).toBe("https://api.provider-b.example/v1");
  });

  it("切到有 Key 的配置 → 用它自己那一份，而不是上一个的残留", () => {
    const cfg = freshCfg("https://api.provider-a.example/v1", "sk-OLD-A");
    process.env.OPENAI_API_KEY = "sk-OLD-A";
    configMod.upsertLlmProfile(cfg, { id: "kb", baseURL: "https://api.provider-b.example/v1", model: "m", apiKey: "sk-NEW-B" });
    const r = configMod.applyLlmProfile(cfg, "kb");
    expect(r.hasKey).toBe(true);
    expect(cfg.llm.apiKey).toBe("sk-NEW-B");
    expect(process.env.OPENAI_API_KEY).toBe("sk-NEW-B");
  });

  it("来回切两次，Key 各自跟着各自的 origin，不会留在上一次那一档上", () => {
    const cfg = freshCfg("https://api.provider-a.example/v1", "sk-A");
    configMod.upsertLlmProfile(cfg, { id: "ka", baseURL: "https://api.provider-a.example/v1", model: "m" });   // 同 origin → 继承 sk-A
    configMod.upsertLlmProfile(cfg, { id: "kb", baseURL: "https://api.provider-b.example/v1", model: "m", apiKey: "sk-B" });
    configMod.applyLlmProfile(cfg, "kb");
    expect(cfg.llm.apiKey).toBe("sk-B");
    configMod.applyLlmProfile(cfg, "ka");
    expect(cfg.llm.apiKey).toBe("sk-A");
    expect(cfg.llm.baseURL).toBe("https://api.provider-a.example/v1");
  });

  it("删掉配置会连它名下那份 Key 一起摘掉", () => {
    const cfg = freshCfg("https://api.provider-a.example/v1", "sk-A");
    configMod.upsertLlmProfile(cfg, { id: "gone", baseURL: "https://api.provider-c.example/v1", model: "m", apiKey: "sk-C" });
    expect(process.env[keyVar("gone")]).toBe("sk-C");
    configMod.removeLlmProfile(cfg, "gone");
    expect(process.env[keyVar("gone")]).toBeFalsy();
  });
});
