# -*- coding: utf-8 -*-
# W2 patch: docs/workbuddy-alignment-plan.md — §W2 落地决策记录
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
p = os.path.join(BASE, "docs", "workbuddy-alignment-plan.md")
src = io.open(p, "r", encoding="utf-8").read()

old = '- **价值**：让 Pancode 从"编码 agent"演进为"可接外部服务 + 可切换专家"的办公级工作台，对齐 WorkBuddy 生态位。\n'
new = '''- **价值**：让 Pancode 从"编码 agent"演进为"可接外部服务 + 可切换专家"的办公级工作台，对齐 WorkBuddy 生态位。
- **落地决策（2026-09-26）**：
  1. **Connectors：不做**。MCP（`cfg.mcp.servers` + 连接状态徽标 + hooks 拦截 `mcp__*` + 审批规则）已 100% 覆盖"外部服务接入"全链路；再建 Connectors 注册表 = 同一能力的重复抽象，违反第一性原理。MCP 即 Pancode 的 Connectors。
  2. **Experts：已落地（最小完整闭环）**——
     - 专家包 = md 文件（frontmatter: name/description/tool_whitelist + 正文第一段=role、其余=methodology）；name 缺失回退文件名。
     - 三层来源 project(`<工作区>/.pancode/experts/`) > user(`~/.pancode/experts/`) > builtin（内置三角色升级为 role+methodology，id 不变零迁移）；agent 可直接 write_file 沉淀项目专家。
     - `personaText(userText)`：`@专家名/id` 单条消息切换（精确命中才生效） > custom > active（内置 id 或专家包 id）。
     - `runSubAgent(opts.expert)`：子智能体按专家 role/methodology 执行，工具按白名单收敛（先排 SUB_AGENT_BLOCK 再取交集，白名单无法解锁受限工具；全不命中回退防呆）；`agent`/`orchestrate` 工具均透传 expert。
     - 设置面板预设下拉动态渲染「专家包」optgroup；同 value 选项更新标签防重复（内置被覆盖时标签同步）。
     - 明确不做：专家审计（无外部市场来源，专家即用户/agent 自写；若未来引入专家市场再复用 auditSkill）、专家管理面板（md 文件即接口）。
'''

n = src.count(old)
assert n == 1, "plan doc: expect 1 occurrence, got %d" % n
src = src.replace(old, new)
newp = p + ".new"
io.open(newp, "w", encoding="utf-8", newline="").write(src)
print("plan doc -> .new written")
