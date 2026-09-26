# -*- coding: utf-8 -*-
"""W7/W9 落地决策记录追加到 docs/workbuddy-alignment-plan.md"""
import io, os, sys, shutil

TARGET = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "workbuddy-alignment-plan.md"))

def patch_once(s, old, new, tag):
    n = s.count(old)
    if n != 1:
        print("FAIL[%s]: anchor count=%d (expect 1)" % (tag, n))
        sys.exit(1)
    print("OK[%s]" % tag)
    return s.replace(old, new, 1)

with io.open(TARGET, "r", encoding="utf-8") as f:
    src = f.read()

w7_anchor = "- **ROI**：P2，因单工作区已满足核心场景，属办公级体验增强。"
w7_new = w7_anchor + """
- **落地决策（2026-09-26）**：
  1. **审计结论：最小闭环（最近工作区快速切换）已存在，不重复造轮子**——前端 `btnOpenFolder` 下拉（wsDropdown：recent 列表 + 当前工作区高亮/check + 同目录短路）+ folderModal `fmRenderRecent` top5 + 后端 `saveWorkspace`（`recentWorkspaces` 封顶 8、去重置顶、落盘）+ `POST /api/workspace`（mountWorkspace + helloPayload 广播全窗口切换 + 引擎运行中 409 保护）。API 探针 12/12 实证（GET/POST/去重置顶/持久化/错误路径）。
  2. **顺手挖出并修复 P1**：`config.js writeJsonSafe` 同步直写→tmprename 在杀软持续锁定下全链 EPERM 失败（探针日志实证连发）——切工作区时 `recentWorkspaces` 静默丢失。修复：转发 safe-write 队列（按路径串行 + async 指数退避 6 次 ~10.9s，不阻塞事件循环，永不抛错）；进程内 cfg 仍是事实源（读盘仅在启动），调用点零改动。
  3. **真并行如实标注不做**：多工作区同时各开 Agent 依赖 W11 子进程化——单进程引擎闭包绑定 files/git/term，`mountWorkspace` 是全局单例切换语义，409 保护已把「串行」做对；伪造并行 = 制造数据竞态。
  4. **跨工作区会话分组：不做**（第一性砍掉）：单进程串行语义下跨 ws 会话不可达，UI 分组是伪需求；若 W11 落地后再评估。"""

w9_anchor = "- **取舍**：上框架（React）vs 纯 Vite+原生——选**Vite+原生模块化**优先，因现有 15 模块已成型，重写框架成本高风险大，违背\"小步可验\"。"
w9_new = w9_anchor + """
- **落地决策（2026-09-26 · 重渲染 Worker 化）**：
  1. **卡顿根因**：`msg.delta` 每 token 全量 `renderChatMD` 重渲染（innerHTML 覆盖）——问题既是频率也是单次耗时（超长回复单次渲染可达数十 ms）。
  2. **方案：经典 Worker + 主线程节流组合**——`public/js/md-worker.js`（零构建依赖，自包含 esc+renderChatMD 副本，与主线程逐行同构）；主线程 65ms 节流合并突发 delta，只渲染最新一帧。为什么不只用节流：节流解决频率不解决单次耗时（12.5Hz × 20ms 仍占 1/4 帧预算）；两个都解决。
  3. **竞态防护：快照校验**（`b.buf === src`）——buf 已前进则丢弃过期帧；msg.end 的同步最终渲染天然覆盖「迟到结果」（旧 src ≠ 最终 buf 必被拦截；src 相同则等价无害覆盖）。曾设计 `_mdGen` 代数计数器，对抗性审查发现连续流式下每帧 gen 都过期 → 渲染结果永远被丢弃，砍掉后逻辑更简且正确。
  4. **msg.end 强制同步最终渲染**：闭合 widget 块升级为沙箱卡片（Worker 内无 `renderWidgetCard`，流式期按代码块预览 = W5 既有语义，两端天然一致）+ 终态与主线程渲染器一致（`htmlToMarkdown` 复制提取从最终 DOM）。
  5. **回退内聚**：Worker 创建失败（Electron file:// 协议禁 Worker）/onerror → `renderChatMDAsync` 内部同步渲染，cb 恒返回 html（调用方零分支，绝不白屏）。曾把回退语义抛给调用方（cb(null)），API 评审后收拢。
  6. **为什么不搬 `renderMarkdown`**：仅预览 iframe 打开时一次性调用，非热点，搬移纯增双份维护成本（对抗性审查砍掉）。Vite 构建链维持不做（原生零构建是本地优先特性，前次已定）。"""

out = src
out = patch_once(out, w7_anchor, w7_new, "W7-decision")
out = patch_once(out, w9_anchor, w9_new, "W9-decision")

new_path = TARGET + ".new"
with io.open(new_path, "w", encoding="utf-8", newline="") as f:
    f.write(out)

os.remove(TARGET)
shutil.copy2(new_path, TARGET)
os.remove(new_path)
print("PATCHED ->", TARGET)
