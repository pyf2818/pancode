# -*- coding: utf-8 -*-
# W4 patch: docs/workbuddy-alignment-plan.md — §W4 落地决策记录
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
p = os.path.join(BASE, "docs", "workbuddy-alignment-plan.md")
src = io.open(p, "r", encoding="utf-8").read()

old = '- **注意**：自动化写盘必须走 `safePath` + 审计日志；周期任务默认 `semi` 权限（写操作需确认），避免无人值守误伤。\n'
new = '''- **注意**：自动化写盘必须走 `safePath` + 审计日志；周期任务默认 `semi` 权限（写操作需确认），避免无人值守误伤。
- **落地决策（2026-09-26）**：
  1. **调度表达式选 cron 而非 RRULE**：cron 5 字段是开发者心智模型（crontab 生态），自研 `server/cron-lite.js`（~90 行纯函数：解析 + `cronNext` 逐分钟扫描上限 366 天 + Vixie dom/dow「或」语义 + 7→0 周日归一化），重度单测覆盖。
  2. **执行复用 `runSubAgent`**：工作区快照隔离 + 改动收回「改动审阅」队列——无人值守的写操作不直接落盘，天然实现「写操作需确认」；子智能体工具黑名单照常收敛。引擎不可用时记录失败原因不中断调度。
  3. **存储**：`ROOT/.pancode/automations/<wsHash>/<id>.json`（随工作区重建，与 memory/plan 同模式）；runs 封顶 20 条/任务防撑爆磁盘。
  4. **补偿语义**：周期任务错过多个周期 → 每次到点只补跑一次，nextRunAt 从当前重算（爆炸收敛）；once 任务 server 停机期间过期 → 启动标记 missed 不再执行。
  5. **UI**：工具栏 clock 按钮 + 自动化弹窗（列表/状态徽标/立即运行/暂停恢复/内联历史/删除确认）+ 三编码场景模板（定时跑测试 / 夜间依赖审计 / 每周代码健康）一键填充。
  6. **safe-write 加固（全仓受益）**：本机杀软对新建文件高频改写会持续数秒 EPERM——`atomicWrite` 改 async 指数退避（6 次 ~10.9s，不阻塞事件循环，永不抛错）；`AutomationStore.remove` 同款重试 + 回读验证删净。教训：探针工作区必须一次性（mkdtemp），固定路径的残留文件会被 AV 长锁污染后续轮次。
'''
n = src.count(old)
assert n == 1, "plan doc W4 anchor: %d" % n
src = src.replace(old, new)
newp = p + ".new"
io.open(newp, "w", encoding="utf-8", newline="").write(src)
print("plan doc W4 -> .new written")
