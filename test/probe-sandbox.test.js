/* ============================================================
   探针沙箱回归（#28）。

   盯的是两件真实发生过的事：
     1) 探针没换数据根 → 账号写进真实 .pancode/users.json（真实用户表里攒了 34 个探针账号）、
        会话 TTL 清理把开发者 30 天没动的对话真删了、code-index 往真实 .pancode 落分片。
        实测过的手感：fileops-test 动 users.json/sessions.json/audit，integration-runner 还多带动任务表
        和 memory 分片，_verify_tools 动 artifacts+memory。
     2) 每个探针各自抄一段 mkdtemp，抄漏一次就是上面那种"静默写真实盘"。
        所以这里既测共享夹具 _sandbox.js 本身，也测"忘了用它会怎样"。

   三条判据都有反向断言：把沙箱去掉，测试必须变红，而不是悄悄跳过。
   ============================================================ */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SCRIPTS = path.join(REPO, "scripts");

/* 静态这一层只管"自己拉起服务端"的脚本——那一类一定会写 users.json/sessions.json。
   不起服务端但把 mockConfig.ROOT 指到仓库根的那种（实测 `_verify_tools` 就是）静态看不出来，
   由 test:verify 链首尾的 scripts/_verify_dataroot.js 指纹兜住：那是结果导向的，动了就报红。 */
const BOOT_SERVER = /server[\\/]index\.js/;
const USES_SANDBOX = /PANCODE_DATA_DIR|require\(\s*["']\.\/_sandbox["']\)/;

/* 白名单必须写理由，且条目失效也要报红——留着一条指向已删文件的豁免，比没有豁免更坏。 */
const ALLOWLIST = {
  // 不是探针：这是给开发者自己用的 CLI，按设计就把索引写进用户自己的数据根
  "index-build.js": "面向用户的 CLI，写真实索引就是它的功能",
};

function child(code, env) {
  return spawnSync(process.execPath, ["-e", code], { encoding: "utf8", cwd: REPO, env: Object.assign({}, process.env, env || {}) });
}

describe("scripts/ 顶层探针都必须走沙箱数据根", () => {
  const names = fs.readdirSync(SCRIPTS, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".js") && e.name !== "_sandbox.js")
    .map((e) => e.name);

  it("扫到了脚本（一条都没扫到说明扫描逻辑坏了）", () => {
    expect(names.length).toBeGreaterThan(10);
  });

  it("自己拉起服务端的脚本都换了数据根", () => {
    const dirty = [];
    for (const n of names) {
      if (ALLOWLIST[n]) continue;
      const src = fs.readFileSync(path.join(SCRIPTS, n), "utf8");
      if (BOOT_SERVER.test(src) && !USES_SANDBOX.test(src)) dirty.push(n);
    }
    expect(dirty, "这些脚本会拉起服务端却没设沙箱：" + dirty.join("、")).toEqual([]);
  });

  it("白名单条目都还成立（文件在、且确实需要豁免）", () => {
    for (const [n, why] of Object.entries(ALLOWLIST)) {
      const p = path.join(SCRIPTS, n);
      expect(fs.existsSync(p), "白名单里的 " + n + " 已不存在，删掉这条豁免（理由：" + why + "）").toBe(true);
      expect(BOOT_SERVER.test(fs.readFileSync(p, "utf8")) || /require\(\s*["'][^"']*server[\\/]/.test(fs.readFileSync(p, "utf8")),
        n + " 已经不碰服务端了，豁免可以删").toBe(true);
    }
  });

  it("test:verify 链首尾夹着数据根指纹（中间谁偷写就红在链尾）", () => {
    const chain = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).scripts["test:verify"];
    expect(chain.startsWith("node scripts/_verify_dataroot.js mark &&")).toBe(true);
    expect(chain.endsWith("node scripts/_verify_dataroot.js check")).toBe(true);
  });

  it("W 轮一次性探针不再躺在 scripts 顶层（它们全都直连真实数据根）", () => {
    const legacy = names.filter((n) => /^_w\d/.test(n) && n.endsWith(".js"));
    expect(legacy, "归档到 scripts/archive/legacy-w/：" + legacy.join("、")).toEqual([]);
  });
});

describe("_sandbox.js 的两条硬规矩", () => {
  it("设晚了直接抛：server/config 已经加载时 create() 不许装作成功", () => {
    const r = child(
      "require(" + JSON.stringify(path.join(REPO, "server", "config.js")) + ");" +
      "process.env.PANCODE_DATA_DIR='';" +
      "try { require(" + JSON.stringify(path.join(SCRIPTS, "_sandbox.js")) + ").create({tag:'late'}); " +
      "console.log('NO_THROW'); } catch (e) { console.log('THROW:' + e.message); }"
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("THROW:");
    expect(r.stdout, "报错必须说清是谁先加载的").toContain("config.js");
  });

  it("正常顺序：create() 排在 require 之前就用得起来", () => {
    const r = child(
      "const sb = require(" + JSON.stringify(path.join(SCRIPTS, "_sandbox.js")) + ").create({tag:'ok', wsFiles:{'a.js':'X'}});" +
      "const fs = require('fs'), path = require('path');" +
      "console.log(JSON.stringify({" +
      "data: process.env.PANCODE_DATA_DIR === sb.dataDir," +
      "inTmp: !sb.root.startsWith(" + JSON.stringify(REPO) + ")," +
      "cfg: fs.existsSync(path.join(sb.dataDir, 'pancode.config.json'))," +
      "ws: fs.readFileSync(path.join(sb.wsDir, 'a.js'), 'utf8')," +
      "seed: fs.existsSync(path.join(sb.dataDir, '.pancode'))" +
      "}));"
    );
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout.trim().split("\n").pop());
    expect(j.data).toBe(true);
    expect(j.inTmp).toBe(true);           // 绝不能是仓库根
    expect(j.cfg).toBe(true);             // 探针要的是 auto 模式，不是等人点确认
    expect(j.ws).toBe("X");
    expect(j.seed).toBe(false);           // .pancode 由被测代码自己建，夹具不越俎代庖
  });

  it("一个进程只许一份数据根：第二次 create() 必须抛", () => {
    const r = child(
      "const S = require(" + JSON.stringify(path.join(SCRIPTS, "_sandbox.js")) + ");" +
      "S.create({tag:'one'});" +
      "try { S.create({tag:'two'}); console.log('NO_THROW'); } catch (e) { console.log('THROW:' + e.message); }"
    );
    expect(r.stdout).toContain("THROW:");
    expect(r.stdout).toContain("只许有一份");
  });

  it("ws:false 只搬数据根，不抢工作区（语义检索那种要拿真实目录当工作区的探针需要）", () => {
    const wsPath = path.join(os.tmpdir(), "pc-wsfalse-" + Date.now());
    fs.mkdirSync(wsPath, { recursive: true });
    try {
      const r = child(
        "const sb = require(" + JSON.stringify(path.join(SCRIPTS, "_sandbox.js")) + ").create({tag:'wsfalse', ws:false});" +
        "const fs = require('fs');" +
        "console.log(JSON.stringify({untouched: process.env.CURSORWEB_WORKSPACE === " + JSON.stringify(wsPath) + "," +
        " noWsDir: !fs.existsSync(sb.wsDir), data: process.env.PANCODE_DATA_DIR === sb.dataDir}));",
        { CURSORWEB_WORKSPACE: wsPath }
      );
      expect(r.status, r.stderr).toBe(0);
      const j = JSON.parse(r.stdout.trim().split("\n").pop());
      expect(j.untouched).toBe(true);
      expect(j.noWsDir).toBe(true);
      expect(j.data).toBe(true);
    } finally {
      fs.rmSync(wsPath, { recursive: true, force: true });
    }
  });

  it("env() 把数据根带给子进程（spawn 型探针靠这一条）", () => {
    const r = child(
      "const sb = require(" + JSON.stringify(path.join(SCRIPTS, "_sandbox.js")) + ").create({tag:'env'});" +
      "const e = sb.env({PORT:'8799'});" +
      "console.log(JSON.stringify({data: e.PANCODE_DATA_DIR, port: e.PORT, keys: Object.keys(e).length}))"
    );
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout.trim().split("\n").pop());
    expect(j.data).toContain("pc-env-");
    expect(j.port).toBe("8799");
    expect(j.keys).toBeGreaterThan(20);      // 不是把整个环境抹了（Windows 上大小写不定，别按名字赌）
  });
});

describe("服务端护栏：带探针标记却没换数据根 → 拒启", () => {
  it("AGENT_FAST=1 且无 PANCODE_DATA_DIR：require config 就炸，且指路到 _sandbox", () => {
    const r = child(
      "process.env.AGENT_FAST='1'; delete process.env.PANCODE_DATA_DIR;" +
      "try { require(" + JSON.stringify(path.join(REPO, "server", "config.js")) + "); console.log('BOOTED'); }" +
      "catch (e) { console.log('THROW:' + e.message); }"
    );
    expect(r.stdout).toContain("THROW:");
    expect(r.stdout, "报错要指路，别让人自己猜该改哪").toContain("探针护栏");
    expect(r.stdout).toContain("_sandbox");
  });

  it("CURSORWEB_ENGINE=demo 同样拦（产品路径一个标记都不设，实测）", () => {
    const r = child(
      "process.env.CURSORWEB_ENGINE='demo'; delete process.env.PANCODE_DATA_DIR;" +
      "try { require(" + JSON.stringify(path.join(REPO, "server", "config.js")) + "); console.log('BOOTED'); }" +
      "catch (e) { console.log('THROW:' + e.message); }"
    );
    expect(r.stdout).toContain("THROW:");
  });

  it("反向：设了数据根就不该拦（否则开发态和打包态都会被自己锁死）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-rail-"));
    const r = child(
      "process.env.AGENT_FAST='1'; process.env.PANCODE_DATA_DIR=" + JSON.stringify(tmp) + ";" +
      "try { require(" + JSON.stringify(path.join(REPO, "server", "config.js")) + "); console.log('BOOTED'); }" +
      "catch (e) { console.log('THROW:' + e.message); }"
    );
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(r.stdout, r.stderr).toContain("BOOTED");
  });

  it("反向：开发者正常启动（不带任何标记）不受护栏影响", () => {
    const r = child(
      "delete process.env.AGENT_FAST; delete process.env.CURSORWEB_ENGINE; delete process.env.PANCODE_DATA_DIR;" +
      "try { require(" + JSON.stringify(path.join(REPO, "server", "config.js")) + "); console.log('BOOTED'); }" +
      "catch (e) { console.log('THROW:' + e.message); }"
    );
    expect(r.stdout, r.stderr).toContain("BOOTED");
  });
});
