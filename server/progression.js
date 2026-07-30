/* ============================================================
   进度系统（游戏化进化树的"成长引擎"）
   纯函数：基于已有的 记忆 / 经验 / 教训 / Skill / 灵魂 数据，
   推导 经验值(XP) / 进化阶段 / 四维属性 / 成就徽章 / 解锁规则。
   不引入新数据源，只做一层"游戏化包装"。
   ============================================================ */
"use strict";

const STAGES = [
  { id: 0, name: "萌芽", xpMin: 0, xpMax: 200 },
  { id: 1, name: "幼苗", xpMin: 200, xpMax: 600 },
  { id: 2, name: "茁壮", xpMin: 600, xpMax: 1200 },
  { id: 3, name: "茂盛", xpMin: 1200, xpMax: 2400 },
  { id: 4, name: "通透", xpMin: 2400, xpMax: Infinity },
];

/* 进化路线：选定后影响四维属性的成长偏向（乘子） */
const PATHS = {
  craftsman:  { name: "工匠", boost: { craft: 1.2, understanding: 0.9 }, desc: "重代码质量：技艺成长更快" },
  scholar:    { name: "学者", boost: { understanding: 1.2, craft: 0.95 }, desc: "重知识沉淀：理解力成长更快" },
  companion:  { name: "伙伴", boost: { rapport: 1.2, robustness: 0.95 }, desc: "重默契陪伴：越来越懂你" },
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function num(v) { return Number.isFinite(v) ? v : 0; }

function computeProgression({ soul, memEntries, skills, builtin, path }) {
  soul = soul || {};
  memEntries = memEntries || [];
  skills = skills || [];
  builtin = builtin || [];

  const prefs = memEntries.filter((e) => e.type === "preference" || e.type === "decision");
  const lessons = memEntries.filter((e) => e.type === "lesson" || e.type === "pattern");
  const errors = memEntries.filter((e) => e.type === "error");
  const skillCount = skills.length + builtin.length;
  const accepted = (soul.proposals || []).filter((p) => p.status === "accepted").length;
  const soulSize = (soul.values ? soul.values.length : 0) + (soul.boundaries ? soul.boundaries.length : 0) + (soul.principles ? soul.principles.length : 0);

  // 经验值：完成任务 / 沉淀记忆 / 蒸馏技能 / 打磨灵魂 都算成长
  const xp =
    prefs.length * 12 + lessons.length * 10 + errors.length * 6 +
    skills.length * 18 + builtin.length * 4 +
    soulSize * 2 + accepted * 5;

  let stage = STAGES[0];
  for (const s of STAGES) if (xp >= s.xpMin) stage = s;
  const xpInStage = xp - stage.xpMin;
  const stageSpan = stage.xpMax === Infinity ? 1 : stage.xpMax - stage.xpMin;
  const stageProgress = clamp(stage.xpMax === Infinity ? 1 : xpInStage / stageSpan, 0, 1);
  const xpToNext = stage.xpMax === Infinity ? 0 : Math.max(0, stage.xpMax - xp);

  // 四维属性（0-100）：由数据推导，再叠加路线乘子
  let attrs = {
    understanding: clamp(prefs.length * 9 + soulSize * 3, 0, 100),
    craft: clamp(skillCount * 8, 0, 100),
    robustness: clamp(lessons.length * 6 + errors.length * 5, 0, 100),
    rapport: clamp(20 + stage.id * 14 + accepted * 7, 0, 100),
  };
  const boost = path && PATHS[path] ? PATHS[path].boost : null;
  if (boost) {
    for (const k in boost) attrs[k] = clamp(attrs[k] * boost[k], 0, 100);
  }

  const achievements = [
    { id: "first_fix", name: "初次自主修复", icon: null, unlocked: errors.length > 0 || skills.some((s) => s.source === "auto") },
    { id: "ten_skills", name: "十项绝技", icon: null, unlocked: skillCount >= 10 },
    { id: "soul_stable", name: "灵魂稳固", icon: null, unlocked: stage.id >= 3 },
    { id: "path_chosen", name: "选定道路", icon: null, unlocked: !!path },
    { id: "fifty_skills", name: "宗师之路", icon: null, unlocked: skillCount >= 50 },
  ];

  // 解锁规则：某些"进阶节点"需满足前置才会点亮（树上显示为虚线锁定态）
  const unlockNodes = [
    { id: "architect", label: "架构师", req: "Skill ≥ 5 且 理解力 ≥ 50", met: skillCount >= 5 && attrs.understanding >= 50 },
    { id: "mentor", label: "导师", req: "进化阶段 ≥ 3", met: stage.id >= 3 },
    { id: "sage", label: "贤者", req: "灵魂稳固 且 Skill ≥ 20", met: stage.id >= 3 && skillCount >= 20 },
  ];

  return {
    xp,
    stage: { id: stage.id, name: stage.name },
    xpInStage, stageProgress, xpToNext,
    attributes: attrs,
    path: path || null,
    pathInfo: path ? PATHS[path] : null,
    achievements,
    unlockNodes,
  };
}

module.exports = { computeProgression, STAGES, PATHS };
