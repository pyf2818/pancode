---
name: Git 提交规范
description: 写出清晰、可回溯的 Conventional Commits 提交信息，便于生成 changelog 与协作
category: config
tags: [git, commit, 提交, conventional, changelog, 规范]
trigger: 提交,commit,git commit,提交信息,commit message,规范
author: pancode
version: 1.0.0
---

## 解决方案
1. 采用 Conventional Commits：`type(scope): subject`，空一行后写 body。
   - type：`feat` 新功能 / `fix` 修复 / `refactor` 重构 / `perf` 性能 / `docs` 文档 / `test` 测试 / `chore` 杂务 / `style` 格式。
   - scope 可选，标明模块（如 `feat(auth)`）。
2. subject（标题）：祈使句、≤ 50 字、不加句号；说「做了什么」而非「怎么做的」。
   - 好：`fix(auth): 修复 token 过期未刷新导致 401`
   - 差：`修改了一下代码`
3. body：解释「为什么」（动机/上下文），而非贴代码 diff；关联 issue 用 `Closes #123`。
4. 一个提交只做一件事；大改动拆多个专注提交，便于 revert 与 bisect。
5. 提交前 `git status` / `git diff --staged` 自检，不把调试残留/密钥/大文件提交进去。

## 验证
`git log --oneline -5` 信息清晰可读；`git diff --staged` 内容与提交说明一致；无密钥/大文件入库。
