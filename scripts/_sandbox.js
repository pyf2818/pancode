/* ============================================================
   探针沙箱（scripts/_sandbox.js）
   任何会拉起服务端、或 require 了会落盘的 server 模块的脚本，数据根都必须是临时目录。

   为什么要共用这一份：每个探针自己抄一段 mkdtemp 的写法，抄漏一次就是真实数据根被写花——
   实测踩过的三类代价：往真实 .pancode/users.json 里塞探针账号（攒了 34 个）、
   会话 TTL 清理把开发者 30 天未活跃的对话真删了、code-index 往真实 .pancode/code-index 里落分片。

   两条硬规矩（这个文件负责把它们变成运行时报错，而不是靠人记住）：
   1. create() 必须早于任何 server 模块的 require——`server/config.js`、`server/dotenv.js`、
      `server/code-index.js` 都在**模块加载时**就把 ROOT 定死了，晚设环境变量等于没设。
   2. 一个进程只有一份数据根。已经设过还再 create() 就是自欺欺人（后面的断言在指哪个根说不清）。

   用法：
     同进程：const sb = require("./_sandbox").create({ tag: "tools" });  然后才 require("../server/…")
     起子进程：const sb = require("./_sandbox").create({ tag: "fileops", wsFiles: { "a.js": "x" } });
               spawn(process.execPath, ["server/index.js"], { env: sb.env({ PORT: "8791" }) });
   收尾自动删（进程退出时尽力而为）；要留着排查就 SANDBOX_KEEP=1，路径会打在 stderr 上。
   ============================================================ */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

/* 这些模块在加载时就固化数据根，所以"必须在它们之前 create"。
   判据走 require.cache，不靠人肉检查顺序——探针改一行 import 顺序就会静默失效，正是最难查的那种。 */
const EARLY_MODULES = [
  path.join("server", "config.js"),
  path.join("server", "dotenv.js"),
  path.join("server", "index.js"),
  path.join("server", "code-index.js"),
];

function loadedTooEarly() {
  return Object.keys(require.cache)
    .map((p) => path.normalize(p))
    .filter((p) => EARLY_MODULES.some((m) => p.endsWith(m)));
}

function sanitizeTag(tag) {
  return String(tag || "probe").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 18) || "probe";
}

function create(opts = {}) {
  const tooEarly = loadedTooEarly();
  if (tooEarly.length) {
    throw new Error(
      "沙箱设晚了：" + tooEarly.map((p) => path.basename(p)).join("、") +
      " 已经加载，它们把数据根定成了 " + (process.env.PANCODE_DATA_DIR || "<仓库根>") +
      "。create() 必须排在任何 require(\"../server/…\") 之前。"
    );
  }
  if (process.env.PANCODE_DATA_DIR) {
    throw new Error("PANCODE_DATA_DIR 已经是 " + process.env.PANCODE_DATA_DIR + "，一个进程只许有一份沙箱");
  }

  const tag = sanitizeTag(opts.tag);
  /* os.tmpdir() 在 Windows 上是 8.3 短名（C:\Users\ANL…~1\…）。这里不展开：
     产品里 GitLayer.sameDir 用的是 fs.realpathSync.native（实测能把短名展回长名），
     探针再展开一次反而制造出两条不同的路径字符串去比相等。 */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pc-" + tag + "-"));
  const dataDir = path.join(root, "data");
  const wsDir = path.join(root, "ws");
  fs.mkdirSync(dataDir, { recursive: true });

  /* ws:false = 探针要拿真实目录当工作区（例如语义检索得索引真实源码才有意义），
     这时只搬数据根，别碰 CURSORWEB_WORKSPACE，让调用方自己设。 */
  if (opts.ws !== false) {
    fs.mkdirSync(wsDir, { recursive: true });
    const files = opts.wsFiles && Object.keys(opts.wsFiles).length
      ? opts.wsFiles
      : { "README.md": "# 沙箱工作区（探针用）\n" };
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(wsDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
  }

  process.env.PANCODE_DATA_DIR = dataDir;
  if (opts.ws !== false) process.env.CURSORWEB_WORKSPACE = wsDir;

  /* 配置也写进沙箱数据根：不写的话 config.load() 吃默认值，agentMode 是 ask，
     探针就会卡在"等人点确认"上——那是最容易被误读成产品坏了的一种挂法。
     LLM 一律留空：沙箱里没有真 key，探针要的是假网关或 demo 引擎。 */
  const cfg = Object.assign(
    {
      agentMode: "auto",
      llm: { baseURL: "", apiKey: "", model: "sandbox-model", contextWindow: 32000 },
      embedding: { endpoint: "" },
      permissions: { mode: "auto", allow: [], deny: [] },
    },
    opts.config || {}
  );
  if (opts.ws !== false) cfg.workspace = wsDir;
  fs.writeFileSync(path.join(dataDir, "pancode.config.json"), JSON.stringify(cfg, null, 2), "utf8");

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (process.env.SANDBOX_KEEP === "1") {
      console.error("[sandbox] SANDBOX_KEEP=1，保留 " + root);
      return;
    }
    /* 尽力而为：子进程服务端可能还攥着文件句柄（Windows 下 rmSync 会 EBUSY），
       删不掉就只报路径——留个空目录远比让探针在收尾处抛错、把断言结果吞掉要好。 */
    for (let i = 0; i < 3; i++) {
      try { fs.rmSync(root, { recursive: true, force: true }); return; }
      catch (e) {
        if (i === 2) console.error("[sandbox] 没删掉 " + root + "（" + e.code + "），手工清一下");
      }
    }
  }
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { cleanup(); process.exit(1); });
  }

  return {
    root,
    dataDir,
    wsDir,
    /* 给 spawn 用的环境。create() 已经改过 process.env，这里只是把覆盖项拼上，
       省得每个探针再抄一遍 PANCODE_DATA_DIR（抄漏就是本次要修的那个坑）。 */
    env(extra) {
      return Object.assign({}, process.env, { PANCODE_DATA_DIR: dataDir }, extra || {});
    },
    /* 探针自己的临时产物（比如要造两个 git 仓库）放这儿，跟着沙箱一起消失，
       别在仓库根留 w12-snap-* 这种没人认领的目录。 */
    scratch(prefix) {
      const p = path.join(root, "scratch", String(prefix || "t") + "-" + Date.now() + "-" + Math.floor(Math.random() * 1e6));
      fs.mkdirSync(p, { recursive: true });
      return p;
    },
    cleanup,
  };
}

module.exports = { create };
