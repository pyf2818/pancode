# 历史 W 轮一次性探针（归档）

这些是 harness 优化路线里 W1–W13 各轮的当场验证脚本。它们的结论都已经写进
`docs/harness-optimization-2026-10.md` 和 `docs/desktop-first-2026-10.md`，脚本本身不再维护。

**别指望直接跑**：
1. 它们按 `scripts/` 一层写相对路径（`require("../server/index.js")`），搬到这个目录后路径已经不成立。
2. 它们**全部不带沙箱数据根**——当年就是靠"直连真实 .pancode"跑起来的，实测会往真实 `users.json`
   塞探针账号、按 TTL 删真实对话、往真实 `.pancode/code-index` 落分片。这正是 `test/probe-sandbox.test.js`
   现在盯着的那件事，所以它们被移出 `scripts/` 顶层，不参与任何 npm 测试链。

要复用其中的思路，请从 `scripts/_verify_*` 里挑一个现役探针抄，并且**第一行就
`require("./_sandbox").create({ tag: "…" })`**（见该文件头部的两条硬规矩）。
