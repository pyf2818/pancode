/* ============================================================
   长任务看门狗的判据（纯函数）

   为什么单独成文件：这一条以前是 `setTimeout(30 分钟)` 写死在 handleChat 里，
   注释写着"可经 cfg.agentMaxMs 配置"而配置里根本没有这一项 —— 任何跑满半小时的任务
   必被掐死，"连续跑七八小时"在设计上进不去，而且**零测试覆盖**，所以一直没人发现。
   现在换成"停滞 + 墙钟兜底"两条，判据抽出来就能单测，不用真等 6 分钟。
   ============================================================ */
"use strict";

const STALL_FLOOR = 60 * 1000;            // 低于 1 分钟的停滞窗口没有意义：一次工具执行就可能占掉
const WALL_FLOOR = 5 * 60 * 1000;
const DEFAULT_STALL_MS = 6 * 60 * 1000;
const DEFAULT_WALL_MS = 8 * 60 * 60 * 1000;

function stallMsOf(cfg) {
  const n = Number(cfg && cfg.agentStallMs);
  return Math.max(STALL_FLOOR, Number.isFinite(n) && n > 0 ? n : DEFAULT_STALL_MS);
}
function wallMsOf(cfg) {
  const n = Number(cfg && cfg.agentMaxMs);
  return Math.max(WALL_FLOOR, Number.isFinite(n) && n > 0 ? n : DEFAULT_WALL_MS);
}

/* 该不该在这一刻中断这一轮？
   progressAt 取"最近一次进展"的两个来源里较新的那个：
     · lastProgress —— 循环自己打的点（新轮次 / 流里出了字）
     · lastToolAt   —— 工具跑完时打的点（记在引擎上，按会话分桶，别处的事件不许替这条会话掩盖它卡死）
   toolBusySince —— 该会话当前有工具在执行（人工审批默认等 20 分钟、run_tests 自身允许
   1800s，都远超 6 分钟停滞窗口）：工具在跑就是"有事在发生"，停滞判定挂起，
   由工具自身的执行超时与墙钟兜底。修复前"一次工具执行最多几分钟"的假设
   覆盖不了这两条路径 —— 超长的测试/等审批的任务会被当成卡死而误杀。
   返回 null = 一切正常；否则返回中断原因（要能直接给人看）。 */
function decideWatchdog(s) {
  const st = s || {};
  const now = Number(st.now) || Date.now();
  const busySince = Number(st.toolBusySince) || 0;
  if (!busySince) {
    const last = Math.max(Number(st.lastProgress) || 0, Number(st.lastToolAt) || 0);
    const idle = now - (last || now);
    if (idle >= stallMsOf(st.cfg || {})) {
      return "连续 " + Math.max(1, Math.round(idle / 60000)) + " 分钟没有任何进展";
    }
  }
  const ranFor = now - (Number(st.startedAt) || now);
  if (ranFor >= wallMsOf(st.cfg || {})) {
    return "已达最长运行时长 " + Math.round(wallMsOf(st.cfg || {}) / 3600000) + " 小时";
  }
  return null;
}

module.exports = { decideWatchdog, stallMsOf, wallMsOf, STALL_FLOOR, WALL_FLOOR, DEFAULT_STALL_MS, DEFAULT_WALL_MS };
