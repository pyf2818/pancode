/* ============================================================
   输出预留 maxOutputTokens（#429 误判引出的第二处）：存 / 读 / 切换

   为什么要单独测：这个值只影响本地压缩预算（threshold = 窗口 - 预留 - headroom），
   不发给上游，所以任何一环漏带都不会立刻报错——只会静静地让 autoCompact 阈值
   一直按"窗口 10%"算。配置导入导出、profile 切换都是同一类静默丢失。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");

let root = "";
let cfgMod = null;
function freshConfig(dataDir) {
  /* dotenv 也要一起清：它的 ROOT/ENV_PATH 是在**模块加载时**按当时的 PANCODE_DATA_DIR 定死的。
     每个用例都换一个新的临时数据根，只清 config 的话 setEnvVar 会往第一个用例（已经删掉的）
     目录里写 .env —— 表现是 ENOENT，红的是夹具的陈旧路径，不是产品。
     （applyLlmProfile 从 F12 起总会写这个键：切到没有密钥的档要显式清掉，不能让上一档的密钥留在运行时。） */
  for (const m of ["../server/config", "../server/safe-write", "../server/dotenv"]) delete require.cache[require.resolve(m)];
  process.env.PANCODE_DATA_DIR = dataDir;
  return require("../server/config");
}
// saveJson 是排队异步落盘的，读不到就再等
async function readDisk(pred, ms) {
  /* 预算取自 safe-write 的最坏退避跨度，而不是另写一个 4000ms：
     写撞上 EPERM 时最坏要退避 ~10.9s，预算小于它就变成随机 flake。 */
  const { WORST_CASE_WRITE_MS } = require("../server/safe-write");
  const budget = ms || (WORST_CASE_WRITE_MS + 3000);
  const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, "pancode.config.json"), "utf8"));
      if (!pred || pred(j)) return j;
    } catch (e) { /* 还没写出来 */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
}

describe("config: maxOutputTokens 往返", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-outtokens-"));
    cfgMod = freshConfig(root);
  });
  afterEach(() => {
    delete process.env.PANCODE_DATA_DIR;
    cfgMod = null;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  });

  it("saveLlm 收下它并落到盘上，publicInfo 也读得到", () => {
    const cfg = cfgMod.load();
    cfgMod.saveLlm(cfg, { maxOutputTokens: 16384 });
    expect(cfg.llm.maxOutputTokens).toBe(16384);
    expect(cfgMod.publicInfo(cfg).maxOutputTokens).toBe(16384);
    // 落盘是 safe-write 排队异步的，读不到就再等（同 p3-close-policy 的处理）
    return readDisk((j) => j.llm && j.llm.maxOutputTokens === 16384).then((j) => {
      expect(j).toBeTruthy();
    });
  });

  it("0 = 显式『按窗口 10% 自动』（不是『没填』）", () => {
    const cfg = cfgMod.load();
    cfgMod.saveLlm(cfg, { maxOutputTokens: 16384 });
    cfgMod.saveLlm(cfg, { maxOutputTokens: 0 });
    expect(cfg.llm.maxOutputTokens).toBe(0);
  });

  it("上限钳到半个窗口；负值 / NaN 一律不动原值", () => {
    const cfg = cfgMod.load();
    cfg.llm.contextWindow = 4096;
    cfgMod.saveLlm(cfg, { maxOutputTokens: 99999 });
    expect(cfg.llm.maxOutputTokens).toBe(2048);
    cfgMod.saveLlm(cfg, { maxOutputTokens: -5 });
    expect(cfg.llm.maxOutputTokens).toBe(2048);
    cfgMod.saveLlm(cfg, { maxOutputTokens: "abc" });
    expect(cfg.llm.maxOutputTokens).toBe(2048);
  });

  it("profile 存 / 切都带着它", () => {
    const cfg = cfgMod.load();
    cfgMod.upsertLlmProfile(cfg, {
      name: "测试档", baseURL: "https://example.com/v1", model: "m1",
      contextWindow: 128000, maxToolRounds: 50, maxOutputTokens: 8000,
    });
    const p = cfg.llmProfiles[0];
    expect(p.maxOutputTokens).toBe(8000);
    expect(cfgMod.profilePublic(p).maxOutputTokens).toBe(8000);
    cfg.llm.maxOutputTokens = 0;                     // 模拟切到一份"用自动档"的配置
    cfgMod.applyLlmProfile(cfg, p.id);
    expect(cfg.llm.maxOutputTokens).toBe(8000);      // 切回来必须一起回来
  });
});
