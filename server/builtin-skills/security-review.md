---
name: 安全审查清单
description: 提交前按优先级自查安全问题：注入、鉴权、敏感信息、依赖与配置
category: security
tags: [security, 安全, 审计, review, 漏洞, 注入, xss, 密钥]
trigger: 安全,security,审计,审查,漏洞,注入,xss,sql注入,密钥泄露,review
author: pancode
version: 1.0.0
---

## 解决方案
按「正确性 → 安全 → 性能」顺序检查改动：
1. 注入类：
   - SQL：禁止字符串拼接，统一参数化查询 / ORM 占位符。
   - 命令执行：禁止把用户输入拼进 shell；必须执行时用白名单 + 转义。
   - XSS：渲染用户输入走转义/文本节点，富文本用 sanitizer（如 DOMPurify）。
2. 鉴权与越权：
   - 每个涉及资源的接口都要校验「当前用户是否有权操作该资源」（对象级鉴权，不只登录态）。
   - 敏感操作加二次确认/审计日志。
3. 敏感信息：
   - 不把密钥/令牌写进代码或配置文件（用环境变量/密钥管理）；`.env` 必须 gitignore。
   - 日志不打印密码、token、身份证等 PII。
4. 依赖与配置：
   - `npm audit` 无高危；锁文件提交；生产关 debug/详细错误回显。

## 验证
`npm audit` 无 high/critical；自查清单 4 类问题均无非预期项；敏感串未出现在 git 历史（`git log -p -S "secret"` 复核）。
