/* pancode 一键构建代码索引（独立 CLI，不依赖运行中的服务）
   用法：node scripts/index-build.js [目录]
   目录缺省用配置工作区（pancode.config.json 的 workspace，或 CURSORWEB_WORKSPACE 环境变量）。
   构建结果按工作区哈希持久化到 .pancode/code-index/，前端「语义检索」与 Agent search_code 共用。 */
"use strict";
const path = require("path");
const config = require("../server/config");
const codeIndex = require("../server/code-index");

(async () => {
  const cfg = config.load();
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(config.ROOT, cfg.workspace);
  console.log("[code-index] 构建目录:", dir);
  const r = await codeIndex.buildIndex({ wsDir: dir, cfg });
  if (!r || !r.ok) { console.error("[code-index] 构建失败:", (r && r.error) || r); process.exit(1); }
  console.log("[code-index] 完成 ✓ " + r.count + " 个片段 · 模式=" + (r.useVector ? "向量(embeddings)" : "BM25(未配置 embedding 端点，已自动兜底)"));
  console.log("[code-index] 索引文件:", r.file);
})().catch((e) => { console.error("[code-index] 异常:", e.message); process.exit(1); });
