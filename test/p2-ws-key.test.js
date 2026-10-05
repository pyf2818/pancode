/* ============================================================
   阶段一-1 工作区分片键统一回归。

   修的是"同一个目录在磁盘上有两个名字"：
     md5(path.resolve(ROOT, cfg.workspace))  —— 会话上下文 / 目标 / 代码索引 / 编排历史
     base36(31 项多项式哈希)(WS_DIR)          —— 记忆 / Skill / 计划 / 灵魂 / 进度 / 自动化
   真实仓库里就摆着证据：E:\...\ai-ppt-generator 同时是 fgkhkc 和 c36f4041…，
   soul/ 与 plans/ 各留两份，UI 读一份、Agent 写另一份。

   验收三件事：
     1) 一个目录只产一个键（写法差异不再产第二个名字）
     2) 老键改名归并：纯 move，不覆盖不删除，二次调用不再动文件
     3) 键算错方向时测试必须变红（每条都配反向断言）
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const K = require("../server/ws-key");

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "pancode-wskey-")); }

/* config 在 require 时就把 ROOT 定死，换数据根必须连带清缓存，否则分片文件静默写进真实仓库 */
function freshConfig(dataDir) {
  for (const m of ["../server/config", "../server/safe-write", "../server/ws-key"]) {
    delete require.cache[require.resolve(m)];
  }
  process.env.PANCODE_DATA_DIR = dataDir;
  return require("../server/config");
}

const WS = process.platform === "win32" ? "E:\\Proj\\Demo App" : "/Proj/Demo App";
const WIN = process.platform === "win32";

describe("shardKey：一个目录只产一个键", () => {
  it("尾分隔符、大小写（Windows）、相对写法都收敛到同一个键", () => {
    const base = K.shardKey(WS);
    expect(K.shardKey(WS + path.sep)).toBe(base);
    expect(K.shardKey(WS + "//")).toBe(base);
    const relForms = [K.shardKey("Demo App", path.dirname(WS))];
    expect(relForms[0]).toBe(base);
    if (WIN) {
      expect(K.shardKey(WS.toLowerCase())).toBe(base);
      expect(K.shardKey(WS.toUpperCase())).toBe(base);
    } else {
      // POSIX 大小写敏感是文件系统语义，不能折——折了 /Proj 和 /proj 会撞成一个键
      expect(K.normalizeDir(WS)).toBe(WS);
    }
  });

  it("不同目录必不同键；同前缀的兄弟目录也不撞", () => {
    expect(K.shardKey(WS)).not.toBe(K.shardKey(WS + "X"));
    expect(K.shardKey("E:\\Proj\\Demo")).not.toBe(K.shardKey("E:\\Proj\\Demo App"));
  });

  it("空串退化成根，且不抛", () => {
    expect(K.shardKey("", "C:\\x")).toBe(K.shardKey("C:\\x"));
    expect(typeof K.shardKey(null)).toBe("string");
  });
});

describe("legacyKeys：老键要能被数出来，才搬得动", () => {
  it("枚举出 md5(未规范化) 与 base36 两族，且不含新键本身", () => {
    const legacy = K.legacyKeys(WS);
    const canon = K.shardKey(WS);
    const rawAbs = path.resolve(WS);
    const b36 = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36); };
    expect(legacy).toContain(crypto.createHash("md5").update(rawAbs).digest("hex"));
    expect(legacy).toContain(b36(rawAbs));
    expect(legacy).not.toContain(canon);
    expect(new Set(legacy).size).toBe(legacy.length);
  });
});

describe("forWorkspace().file：老键改名归并", () => {
  let root, dir;
  beforeEach(() => {
    root = tmpRoot();
    dir = path.join(root, ".pancode", "memory");
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} });

  const shard = () => K.forWorkspace(WS, root);

  it("canonical 缺席、只有一份 legacy：改名成 canonical，内容一字不改", () => {
    const legacyName = shard().legacy[1] + ".json";         // base36 那一族
    fs.writeFileSync(path.join(dir, legacyName), '{"items":["甲"]}', "utf8");
    const p = shard().file(dir);
    expect(path.basename(p)).toBe(shard().key + ".json");
    expect(fs.readFileSync(p, "utf8")).toBe('{"items":["甲"]}');
    expect(fs.existsSync(path.join(dir, legacyName))).toBe(false);   // 是 move，不是 copy
    expect(K.drainMigrated().length).toBeGreaterThan(0);
  });

  it("再解析一次不再动文件（幂等）", () => {
    const legacyName = shard().legacy[1] + ".json";
    fs.writeFileSync(path.join(dir, legacyName), "x", "utf8");
    shard().file(dir);
    K.drainMigrated();
    const after = fs.readdirSync(dir);
    expect(after.length).toBe(1);
    shard().file(dir);
    expect(K.drainMigrated()).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(after);
  });

  it("canonical 与 legacy 同时在：谁都不许动，只记 drift 等人合并", () => {
    const legacyName = shard().legacy[1] + ".json";
    fs.writeFileSync(path.join(dir, legacyName), "旧内容", "utf8");
    const canon = shard().key + ".json";
    fs.writeFileSync(path.join(dir, canon), "新内容", "utf8");
    const p = shard().file(dir);
    expect(p).toBe(path.join(dir, canon));
    expect(fs.readFileSync(path.join(dir, legacyName), "utf8")).toBe("旧内容");   // 绝不覆盖、绝不删除
    expect(fs.readFileSync(p, "utf8")).toBe("新内容");
    const d = K.drainDrift();
    expect(d.length).toBe(1);
    expect(d[0].leftovers).toContain(path.basename(legacyName));
  });

  it("多份 legacy 且无 canonical：搬最新的那份（应用当前在展示的），其余留在原地并上报", () => {
    const l = shard().legacy;
    fs.writeFileSync(path.join(dir, l[0] + ".json"), "老", "utf8");
    fs.writeFileSync(path.join(dir, l[1] + ".json"), "新", "utf8");
    const t = Date.now() / 1000;
    fs.utimesSync(path.join(dir, l[0] + ".json"), t - 100, t - 100);   // l[0] 改旧
    fs.utimesSync(path.join(dir, l[1] + ".json"), t, t);
    const p = shard().file(dir);
    expect(fs.readFileSync(p, "utf8")).toBe("新");
    expect(fs.existsSync(path.join(dir, l[0] + ".json"))).toBe(true);
    expect(K.drainDrift()[0].leftovers).toContain(l[0] + ".json");
  });

  it("带用户后缀的文件名也迁移（conversations/<key>__<user>.json 这类）", () => {
    const dec = (k) => k + "__u18cc4d3b.json";
    const legacyFile = path.join(dir, dec(shard().legacy[1]));
    fs.writeFileSync(legacyFile, "老会话", "utf8");
    const p = shard().file(dir, dec);
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(fs.readFileSync(p, "utf8")).toBe("老会话");
    expect(path.basename(p)).toBe(shard().key + "__u18cc4d3b.json");
  });

  it("分片子目录（automations/<key>/）同样归并", () => {
    const parent = path.join(root, ".pancode", "automations");
    fs.mkdirSync(parent, { recursive: true });
    const legacyDir = path.join(parent, shard().legacy[1]);
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, "jobs.json"), "[]", "utf8");
    const p = shard().subdir(parent);
    expect(p).toBe(path.join(parent, shard().key));
    expect(fs.existsSync(path.join(p, "jobs.json"))).toBe(true);
    expect(fs.existsSync(legacyDir)).toBe(false);
  });

  it("两边都没有：直接给 canonical，且不创建文件", () => {
    const p = shard().file(dir);
    expect(p).toBe(path.join(dir, shard().key + ".json"));
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe("一个目录一个键：跨模块一致", () => {
  let root, cfgMod;
  beforeEach(() => {
    root = tmpRoot();
    fs.mkdirSync(path.join(root, ".pancode"), { recursive: true });
    fs.writeFileSync(path.join(root, "pancode.config.json"), JSON.stringify({ workspace: WS }), "utf8");
    cfgMod = freshConfig(root);
  });
  afterEach(() => {
    delete process.env.PANCODE_DATA_DIR;
    delete require.cache[require.resolve("../server/orchestrator")];
    cfgMod = null;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  });

  it("config 的 4 个分片路径与 code-index / orchestrator 同键", () => {
    const cfg = cfgMod.load();
    const key = K.shardKey(WS);
    for (const [name, p] of Object.entries({
      memory: cfgMod.memoryPath(cfg), skill: cfgMod.skillPath(cfg),
      soul: cfgMod.soulPath(cfg), progression: cfgMod.progressionPath(cfg),
    })) {
      expect(path.basename(p), name + " 的键").toBe(key + ".json");
    }
    // 代码索引：文件名与缓存键同源
    delete require.cache[require.resolve("../server/code-index")];
    const ci = require("../server/code-index");
    expect(ci.wsIndexFile(WS)).toBe(path.join(root, ".pancode", "code-index", key + ".json"));
    // 编排历史：读的是配置里的 workspace，键必须和上面同源
    delete require.cache[require.resolve("../server/orchestrator")];
    const orch = require("../server/orchestrator");
    expect(path.basename(orch.histPath())).toBe(key + ".json");
  });

  it("工作区写法不同（大小写 / 尾斜杠）时，config 路径也指向同一个文件", () => {
    if (!WIN) return;   // POSIX 大小写敏感是文件系统语义，不该折
    const other = freshConfig(root);
    fs.writeFileSync(path.join(root, "pancode.config.json"),
      JSON.stringify({ workspace: WS.toLowerCase() + "\\" }), "utf8");
    const cfg = other.load();
    expect(other.memoryPath(cfg)).toBe(K.forWorkspace(WS, root).file(path.join(root, ".pancode", "memory")));
  });
});

describe("防回归：不许再长出第二套键", () => {
  const SRC = path.join(__dirname, "..", "server");
  function jsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) return jsFiles(p);
      return /\.js$/.test(d.name) ? [p] : [];
    });
  }
  const offenders = (re) => jsFiles(SRC)
    .filter((f) => !/[\\/]ws-key\.js$/.test(f))
    .filter((f) => re.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.basename(f));

  it("server/ 里除 ws-key 外没人再对路径做 md5", () => {
    expect(offenders(/createHash\("md5"\)\s*\.update\(\s*(path\.resolve|wsAbs|WS_DIR|raw)\b/)).toEqual([]);
  });

  it("31 项多项式哈希只留在 ws-key 的 legacyStorageId 里", () => {
    expect(offenders(/\*\s*31\s*\+/)).toEqual([]);
  });
});
