/* ============================================================
   上下文窗口与工具轮次的出厂默认，以及「有效窗口」到底听谁的

   为什么要单独测：这两个数不是给人看的装饰，它们决定
     - 压缩触发线（分母）：配大了 → 我们算着没满、上游回 400/500
     - 单任务能跑多少轮工具：配小了 → 长任务被设计掐死（到顶只会说"请再发一条"）
   而窗口的来源有四层（在线探测 / 手填 / 预设表 / 出厂兜底），优先级只在
   agent-llm 的 _effectiveWindow 一处实现。改默认值时最容易撞的坑是
   「出厂值把自己当成手填值」——那样预设表就永远顶不动它：
   gpt-4o 会被出厂的 256K 顶到上游 400，真实 512K 的模型又被钳在 256K 白扔一半窗口。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { LlmAgent } = require("../server/agent-llm");
const mp = require("../server/model-presets");

/* 空数据根 → load() 出来的是纯出厂值（仓库里的 pancode.config.json 会把默认顶掉，
   所以不能直接 require 就用，必须先把 PANCODE_DATA_DIR 指到临时目录再加载）。 */
function freshConfig(dataDir) {
  for (const m of ["../server/config", "../server/safe-write"]) delete require.cache[require.resolve(m)];
  process.env.PANCODE_DATA_DIR = dataDir;
  return require("../server/config");
}

function agent(llm) {
  const a = Object.create(LlmAgent.prototype);
  a.cfg = { llm: llm, context: {}, memory: { enabled: false }, permissions: { mode: "ask" } };
  a._detectedWindow = 0;
  return a;
}

describe("出厂默认：轮次 200、窗口 256K", () => {
  let root, cfgMod;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-window-"));
    cfgMod = freshConfig(root);
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} });

  it("单任务最大工具轮次出厂 200（以前 100：并行改盘 + 跑测试 + 修失败轻松破百，长任务在设计上进不去）", () => {
    expect(cfgMod.load().llm.maxToolRounds).toBe(200);
  });

  it("上下文窗口出厂 256000", () => {
    expect(cfgMod.load().llm.contextWindow).toBe(256000);
  });

  it("出厂窗口和预设表的兜底是同一个数（前端的「这个值用户没动过」判据靠两者相等）", () => {
    expect(cfgMod.load().llm.contextWindow).toBe(mp.DEFAULT_CONTEXT_WINDOW);
  });

  it("出厂值落在自己的校验区间里（轮次 5..500，窗口 4096..2000000）", () => {
    const cfg = cfgMod.load();
    cfgMod.saveLlm(cfg, { maxToolRounds: 200, contextWindow: 256000 });
    expect(cfg.llm.maxToolRounds).toBe(200);
    expect(cfg.llm.contextWindow).toBe(256000);
  });
});

describe("有效窗口：出厂默认不算手填", () => {
  it("没动过出厂值 + 命中预设的模型 → 用预设（gpt-4o 128K，不被出厂 256K 顶上去撞上游 400）", () => {
    const a = agent({ contextWindow: mp.DEFAULT_CONTEXT_WINDOW, model: "gpt-4o" });
    expect(a._effectiveWindow()).toBe(128000);
    expect(a._ctxWindowInfo().source).toBe("preset");
  });

  it("真手填了更大的值 → 尊重用户（预设只是默认，不是硬上限）", () => {
    const a = agent({ contextWindow: 300000, model: "gpt-4o" });
    expect(a._effectiveWindow()).toBe(300000);
    expect(a._ctxWindowInfo().source).toBe("configured");
  });

  it("手填更小也尊重（配小只是早压缩，不报错）", () => {
    const a = agent({ contextWindow: 60000, model: "gpt-4o" });
    expect(a._effectiveWindow()).toBe(60000);
  });

  it("没命中预设的模型 + 出厂值 → 出厂兜底，来源标 default", () => {
    const a = agent({ contextWindow: mp.DEFAULT_CONTEXT_WINDOW, model: "某unknown模型" });
    expect(a._effectiveWindow()).toBe(mp.DEFAULT_CONTEXT_WINDOW);
    expect(a._ctxWindowInfo().source).toBe("default");
  });

  it("探测到真实窗口时不拿出厂值去钳它（512K 的模型就该用 512K）", () => {
    const a = agent({ contextWindow: mp.DEFAULT_CONTEXT_WINDOW, model: "agnes-3.0-flash" });
    a._detectedWindow = 524288;
    expect(a._effectiveWindow()).toBe(524288);
    expect(a._ctxWindowInfo().source).toBe("detected");
  });

  it("探测到 + 用户手填更小 → 尊重手填", () => {
    const a = agent({ contextWindow: 200000, model: "agnes-3.0-flash" });
    a._detectedWindow = 524288;
    expect(a._effectiveWindow()).toBe(200000);
    expect(a._ctxWindowInfo().source).toBe("configured");
  });

  it("探测到 + 手填过大 → 钳回真实窗口并标 auto-clamped（这是防上游 400/500 的那道钳）", () => {
    const a = agent({ contextWindow: 500000, model: "某local模型" });
    a._detectedWindow = 131072;
    expect(a._effectiveWindow()).toBe(131072);
    expect(a._ctxWindowInfo().source).toBe("auto-clamped");
  });

  it("压缩线的分母就是有效窗口（两处不许各说各话）", () => {
    const a = agent({ contextWindow: mp.DEFAULT_CONTEXT_WINDOW, model: "gpt-4o" });
    a.cfg.context = { budgetTokens: 1000000, autoCompact: true };
    a.cfg.llm.maxOutputTokens = 12800;
    // 128000 窗口：扣输出预留 12800、headroom 5120 → 102400，不是 256K 那一套
    expect(a._compactSpec().thresholdTokens).toBe(102400);
  });
});

describe("CLI 自包含引擎：同一对默认值不许漂开", () => {
  /* cli/lib/config.js 没导出 DEFAULTS，而这份出厂值只在"没有 server/ 可依赖"时生效。
     漂开的表现是同一个任务在 IDE 里能跑完、在 CLI 自包含模式下第 100 轮被掐死。 */
  const src = fs.readFileSync(path.join(__dirname, "..", "cli", "lib", "config.js"), "utf8");
  it("出厂轮次 200、窗口 256000", () => {
    expect(/maxToolRounds:\s*200/.test(src)).toBe(true);
    expect(/contextWindow:\s*256000/.test(src)).toBe(true);
  });
});
