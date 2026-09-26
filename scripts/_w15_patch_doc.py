# -*- coding: utf-8 -*-
# W15: plan doc 落地记录
import io

p = "docs/workbuddy-alignment-plan.md"
s = io.open(p, encoding="utf-8").read()
old = "  - 保留：登录闸门 + NO_AUTH 白名单收紧 + CORS 环回 + `/api/fs/browse` 限工作区及上级（防全盘枚举）。\n"
new = """  - 保留：登录闸门 + NO_AUTH 白名单收紧 + CORS 环回 + `/api/fs/browse` 限工作区及上级（防全盘枚举）。
  - **落地决策（2026-09-26）**：语义层内聚在 `security.js check()`（唯一入口 terminal.js:118，调用方零改动）——①Unicode NFKC 归一 + 零宽/控制字符剔除（防全角 `ｒｍ` 绕过）；②strict 层引号拼接还原（`r"m"` → `rm`）；③变量宏展开 2 轮收敛（`RM=rm; $RM -rf /` 展开后命中）；④base64 候选（≥8 位）解码递归检查（深度 ≤2，UTF-16LE 空字节剔除兼容 pwsh 编码执行，可打印率 >0.7 过滤误报）；⑤解释器管道检测（任意管道段首 ∈ {sh,bash,zsh,ksh,dash,powershell,pwsh,cmd}，`||` 排除）；⑥编码执行链模式（base64|sh / 编码参数执行 / certutil -decode / eval+base64）。审计查询 `/api/audit`（W14 已有）复用不重建。**语义发现**：BASE 正则本就穿透引号（`echo "rm -rf /"` 原语义即拦），引号不是隐身衣——测试如实断言。误杀矩阵 14 条常规命令全放行（`rm -rf ./build`、`git commit -m "fix rm -rf bug"` 等）。
"""
assert s.count(old) == 1, "W15 anchor: %d" % s.count(old)
s = s.replace(old, new)
io.open(p + ".new", "w", encoding="utf-8", newline="").write(s)
print("plan doc W15 -> .new")
