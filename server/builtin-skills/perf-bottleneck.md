---
name: 性能瓶颈排查
description: 定位前端/Node 性能瓶颈（卡顿、慢、内存涨），用度量驱动优化而非盲猜
category: perf
tags: [performance, 性能, 慢, 卡顿, 优化, 内存, 渲染]
trigger: 性能,perf,慢,卡顿,卡,渲染慢,内存涨,leak,优化
author: pancode
version: 1.0.0
---

## 解决方案
1. 先量化：用浏览器 Performance 面板 / Node `--cpu-prof` / `console.time` 记录「慢在哪一步」，避免凭感觉优化。
2. 常见前端瓶颈：
   - 大列表卡顿 → 虚拟滚动（react-window）、避免每个 item 内联对象/函数导致无谓重渲染（`React.memo` / `useMemo` / `useCallback`）。
   - 频繁 setState → 防抖/节流、合并状态、用 `useTransition` 标记非紧急更新。
   - 重复重渲染 → 查 props 是否稳定、key 是否合理。
3. 常见 Node 瓶颈：
   - 同步重活阻塞事件循环 → 拆批 / 用 worker / 流式处理。
   - N+1 查询 / 未加索引 → 批量查询、建索引、缓存。
   - 大对象常驻 → 及时释放、用流而非全量读入。
4. 改一处、测一处：优化前后用同一脚本对比耗时/内存，确认有效再继续。

## 验证
复现脚本耗时的前后对比有可量化下降（如列表滚动帧率 ≥ 50fps、接口 P95 下降）；无新增内存泄漏（堆快照稳定）。
