/* ============================================================
   pancode 进化图鉴（游戏化进化树 v2）
   记忆 / 经验 / 教训 / Skills / 灵魂 + 时间线
   依赖全局：ico / replaceIcons / evoData / toast / $ / esc（运行时解析）
   ============================================================ */
"use strict";

async function loadEvolutionTree() {
  try {
    const r = await fetch("/api/evolution/tree").then((x) => x.json());
    if (!r.ok) return;
    evoData = r;
    const codex = $("evoCodexModal");
    if (codex && codex.style.display !== "none") renderCodex();
    updateEvoCounts(r.counts);
  } catch (e) {}
}

function updateEvoCounts(c) {
  c = c || {};
  const el = $("evoCounts");
  if (el) el.textContent = "记忆 " + (c.memory || 0) + " · 经验 " + (c.experience || 0) + " · 教训 " + (c.lesson || 0) + " · Skills " + (c.skills || 0) + (c.pending ? " · 待确认 " + c.pending : "");
}

/* ============ 进化图鉴（游戏化进化树 v2） ============ */
function openEvolutionCodex() {
  let modal = $("evoCodexModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "evoCodexModal";
    modal.className = "evo-codex-mask";
    modal.innerHTML =
      '<div class="evo-codex">' +
        '<div class="evo-codex-head">' +
          '<div class="evo-codex-title">' + ico("tree") + ' 进化图鉴</div>' +
          '<div class="evo-codex-stage" id="evoStage"></div>' +
          '<div class="evo-codex-xp"><div class="evo-codex-xp-fill" id="evoXpFill"></div></div>' +
          '<div class="evo-codex-xp-txt" id="evoXpTxt"></div>' +
          '<button class="evo-codex-close" id="evoCodexClose" title="关闭">' + ico("close") + '</button>' +
        '</div>' +
        '<div class="evo-codex-tabs">' +
          '<button class="evo-tab active" data-tab="tree">' + ico("tree") + ' 成长树</button>' +
          '<button class="evo-tab" data-tab="timeline">' + ico("clock") + ' 时间线</button>' +
          '<span class="evo-codex-spacer"></span>' +
          '<button class="evo-tbtn" id="evoCodexEditSoul">' + ico("soul") + ' 编辑灵魂</button>' +
          '<button class="evo-tbtn" id="evoCodexRefresh">' + ico("reset") + '</button>' +
        '</div>' +
        '<div class="evo-codex-body">' +
          '<div class="evo-codex-tree" id="evoCodexTree"></div>' +
          '<div class="evo-codex-side" id="evoCodexSide"></div>' +
          '<div class="evo-codex-timeline" id="evoCodexTimeline" style="display:none"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector("#evoCodexClose").onclick = () => { modal.style.display = "none"; };
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = "none"; };
    modal.querySelectorAll(".evo-tab").forEach((tab) => {
      tab.onclick = () => {
        const tb = tab.dataset.tab;
        modal.querySelectorAll(".evo-tab").forEach((x) => x.classList.toggle("active", x === tab));
        $("evoCodexTree").style.display = tb === "tree" ? "" : "none";
        $("evoCodexSide").style.display = tb === "tree" ? "" : "none";
        $("evoCodexTimeline").style.display = tb === "timeline" ? "" : "none";
        if (tb === "tree") renderCodexTree(); else renderEvolutionTimeline($("evoCodexTimeline"));
      };
    });
    modal.querySelector("#evoCodexEditSoul").onclick = () => openSoulEditor();
    modal.querySelector("#evoCodexRefresh").onclick = () => loadEvolutionTree();
  }
  modal.style.display = "flex";
  loadEvolutionTree();
}

function renderCodex() {
  const prog = evoData && evoData.progression;
  if (!prog) return;
  $("evoStage").textContent = "阶段 " + prog.stage.id + " · " + prog.stage.name;
  $("evoXpFill").style.width = Math.round(prog.stageProgress * 100) + "%";
  $("evoXpTxt").textContent = prog.xpToNext > 0
    ? (prog.xp + " XP · 距下阶段 " + prog.xpToNext)
    : (prog.xp + " XP · 已满级");
  renderCodexTree();
  renderCodexSide();
}

/* ============================================================
   成长树 v3 —— 程序化拟真分形树（纯 SVG + CSS 动画，零依赖）
   数据源：evoData = GET /api/evolution/tree 的返回
     evoData.tree.soul                       {name,vibe,values,boundaries,principles,proposals,pendingCount}
     evoData.tree.memory.{memory,experience,lesson}  {label,icon,items:[{id,type,topic,content,ts,accessCount,valueScore,source}]}
     evoData.tree.skills                     [{label,icon,items:[{id,name,desc,ts,source}]}]
     evoData.progression                     {xp,stage:{id,name},stageProgress,xpToNext,attributes,path,achievements,unlockNodes:[{id,label,req,met}]}
     evoData.counts / evoData.timeline
   ============================================================ */
const EVO_H = 620;                   // 坐标系高度（面板内容宽 404）
const EVO_VIEW = "0 92 400 526";     // viewBox：裁掉树冠上方的空白天空，让树撑满面板
const EVO_GROUND = 466;              // 地平线（树干基部）
const EVO_TRUNK_TOP = 310;           // 主干顶端 = 内层两主枝分叉点
const EVO_LEN = [156, 84, 56, 37, 23];   // 各级枝长（0=主干）
const EVO_WID = [14, 8.6, 5.2, 3.1, 1.8]; // 各级枝宽：主干 14px → 末梢 ~1.8px
const EVO_KIDS = [0, 3, 2, 2];       // 每级子枝数 → 满级末梢 3*2*2 = 12 个叶位
const EVO_DELAY = [0, 0.18, 0.38, 0.56, 0.72]; // 逐级生长延迟（整棵 ≤1.6s）
const EVO_MAX_LEAF = 12;             // 每类最多渲染条目
let codexTreeGrown = false;          // 成长动画只播一次

/* 固定 seed 伪随机（mulberry32）：同一份数据每次渲染形状完全一致，不闪烁 */
function evoRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const evoN = (v) => (Math.round(v * 10) / 10);

/* 沿方向角折线采样：ang 弧度，0 = 正上方；curve = 全枝累积弯曲 */
function evoSample(rnd, x, y, ang, len, curve, n) {
  const pts = [[x, y]];
  let a = ang, px = x, py = y;
  const step = len / n;
  for (let i = 1; i <= n; i++) {
    a += curve / n + (rnd() - 0.5) * 0.055;
    px += Math.sin(a) * step;
    py -= Math.cos(a) * step;
    pts.push([px, py]);
  }
  return pts;
}

function evoPolyline(pts, i0, i1) {
  let d = "M" + evoN(pts[i0][0]) + " " + evoN(pts[i0][1]);
  for (let i = i0 + 1; i <= i1; i++) d += "L" + evoN(pts[i][0]) + " " + evoN(pts[i][1]);
  return d;
}

/* 按弧长比例取折线上一点（用于把主枝挂在主干的不同高度） */
function evoPointAt(pts, frac) {
  const last = pts.length - 1;
  const f = Math.max(0, Math.min(1, frac)) * last;
  const i = Math.min(last - 1, Math.floor(f));
  const t = f - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
}

/* 递归分枝：枝宽随层级递减，每级带轻微随机弯曲。
   枝长系数 cat.k 与最大层级 cat.maxDepth 由该分类条目数决定 —— 沉淀越多长得越高越密。 */
function evoGrow(ctx, rnd, cat, x, y, ang, len, w, depth) {
  const curve = (rnd() - 0.5) * (0.6 - depth * 0.07);
  const pts = evoSample(rnd, x, y, ang, len, curve, 8);
  ctx.segs.push({ pts: pts, w: w, depth: depth, cat: cat.key });
  const ex = pts[8][0], ey = pts[8][1], ea = ang + curve;
  if (depth === 1) cat.elbow = { x: ex, y: ey, ang: ea };
  if (depth >= cat.maxDepth) { cat.tips.push({ x: ex, y: ey, ang: ea }); return; }
  const n = EVO_KIDS[depth];
  const spread = n === 3 ? [-0.46, -0.05, 0.4] : [-0.28, 0.28];
  for (let i = 0; i < n; i++) {
    let ka = ea * 0.74 + spread[i] + (rnd() - 0.5) * 0.16;
    ka = Math.max(-1.16, Math.min(1.16, ka));
    evoGrow(ctx, rnd, cat, ex, ey, ka, EVO_LEN[depth + 1] * cat.k * (0.9 + rnd() * 0.2), EVO_WID[depth + 1] * cat.wk, depth + 1);
  }
}

/* 叶（记忆 / 经验 / 教训）：大小随 valueScore，饱满度随 accessCount */
function evoLeaf(tip, it, cat, rnd, idx, anim) {
  const score = Math.max(1, Math.min(5, Number(it.valueScore) || 2));
  const L = 9.5 + score * 2.3;
  const acc = Math.max(0, Math.min(1, (Number(it.accessCount) || 0) / 5));
  const op = (0.58 + acc * 0.42).toFixed(2);
  const rot = (Math.atan2(-Math.cos(tip.ang), Math.sin(tip.ang)) * 180) / Math.PI + (rnd() - 0.5) * 26 - 8;
  const d = "M0 0Q" + evoN(L * 0.5) + " " + evoN(-L * 0.37) + " " + evoN(L) + " 0Q" + evoN(L * 0.5) + " " + evoN(L * 0.37) + " 0 0Z";
  const vein = "M" + evoN(L * 0.08) + " 0L" + evoN(L * 0.92) + " 0";
  const delay = anim ? (0.92 + idx * 0.006) : 0;
  return '<g class="evo-leaf" data-cat="' + cat.key + '" data-i="' + idx + '" transform="translate(' + evoN(tip.x) + ',' + evoN(tip.y) + ') rotate(' + evoN(rot) + ')">' +
    '<g' + (anim ? ' class="evo-pop" style="animation-delay:' + delay.toFixed(3) + 's"' : "") + '>' +
      '<path class="evo-leaf-body" d="' + d + '" style="fill:' + cat.color + ";fill-opacity:" + op + ";stroke:" + cat.color + '"/>' +
      '<path class="evo-leaf-vein" d="' + vein + '"/>' +
    "</g></g>";
}

/* 果（技能）：圆形带高光 */
function evoFruit(tip, it, cat, rnd, idx, anim) {
  const r = 4.3 + rnd() * 1.5 + (it.source === "builtin" ? 0 : 0.9);
  const dx = Math.sin(tip.ang) * (r * 0.7), dy = -Math.cos(tip.ang) * (r * 0.7);
  const delay = anim ? (0.92 + idx * 0.006) : 0;
  return '<g class="evo-fruit" data-cat="' + cat.key + '" data-i="' + idx + '" transform="translate(' + evoN(tip.x + dx) + ',' + evoN(tip.y + dy) + ')">' +
    "<g" + (anim ? ' class="evo-pop" style="animation-delay:' + delay.toFixed(3) + 's"' : "") + ">" +
      '<path class="evo-fruit-stem" d="M0 ' + evoN(-r) + "L0 " + evoN(-r - 3.4) + '"/>' +
      '<circle class="evo-fruit-body" r="' + evoN(r) + '" fill="url(#evoFruitG)" style="stroke:' + cat.color + '"/>' +
      '<circle class="evo-fruit-hi" cx="' + evoN(-r * 0.32) + '" cy="' + evoN(-r * 0.34) + '" r="' + evoN(r * 0.28) + '"/>' +
    "</g></g>";
}

/* 超出 12 条的聚合簇：枝肘处一小簇 + 「+N」 */
function evoPlusBunch(cat, extra) {
  const e = cat.elbow;
  if (!e) return "";
  const left = cat.ang < 0;
  const base = (Math.atan2(-Math.cos(e.ang), Math.sin(e.ang)) * 180) / Math.PI;
  let s = '<g class="evo-plus" data-cat="' + cat.key + '" transform="translate(' + evoN(e.x) + "," + evoN(e.y) + ')">';
  [-46, 6, 58].forEach((o) => {
    const L = 9.5;
    s += '<g transform="rotate(' + evoN(base + o) + ')"><path class="evo-leaf-body" style="fill:' + cat.color + ";fill-opacity:.72;stroke:" + cat.color +
      '" d="M0 0Q' + evoN(L * 0.5) + " " + evoN(-L * 0.37) + " " + evoN(L) + " 0Q" + evoN(L * 0.5) + " " + evoN(L * 0.37) + ' 0 0Z"/></g>';
  });
  s += '<text class="evo-plus-txt" x="' + (left ? -5 : 5) + '" y="3.5" text-anchor="' + (left ? "end" : "start") + '">+' + extra + "</text></g>";
  return s;
}

/* 年轮 = 阶段：树干基部的横截面，环数 = progression.stage.id，尺寸随主干粗细 */
function evoRings(prog, wk) {
  const st = (prog && prog.stage) || {};
  const stage = Math.max(1, Number(st.id) || 1);
  const n = Math.min(8, stage);
  const RX = 28 * (wk || 1), RY = 11.5 * (wk || 1), cy = EVO_GROUND + 4;
  let s = '<g class="evo-rings" data-act="soul" transform="translate(200,' + cy + ')">';
  s += '<ellipse class="evo-ring-face" rx="' + RX + '" ry="' + RY + '"/>';
  for (let i = n; i >= 1; i--) {
    const k = i / n;
    s += '<ellipse class="evo-ring' + (i === n ? " out" : "") + '" rx="' + evoN(RX * k - 1.6) + '" ry="' + evoN(RY * k - 0.7) + '"/>';
  }
  s += '<circle class="evo-ring-core" r="1.7"/></g>';
  s += '<text class="evo-ring-txt" x="' + (200 + RX + 9) + '" y="' + (cy + 4) + '">阶段 ' + stage + " · " + esc(st.name || "幼苗") + "</text>";
  return s;
}

/* 解锁称号 = 树下种子：met 发芽，未 met 灰暗休眠 */
function evoSeeds(nodes) {
  const list = nodes || [];
  if (!list.length) return "";
  const gap = Math.min(112, 330 / list.length);
  const x0 = 200 - ((list.length - 1) * gap) / 2;
  const y = 556;
  let s = '<text class="evo-seed-cap" x="200" y="524" text-anchor="middle">进阶称号</text>';
  list.forEach((u, i) => {
    s += '<g class="evo-seed' + (u.met ? " met" : "") + '" data-u="' + esc(u.id) + '" transform="translate(' + evoN(x0 + i * gap) + "," + y + ')">';
    s += '<ellipse class="evo-seed-mound" rx="30" ry="7"/>';
    if (u.met) {
      s += '<path class="evo-seed-sprout" d="M0 1C0 -7 -1 -12 -1 -17"/>' +
        '<path class="evo-seed-coti" d="M-1 -12Q-9 -17 -11 -10Q-5 -8 -1 -12Z"/>' +
        '<path class="evo-seed-coti" d="M-1 -15Q7 -21 10 -13Q3 -11 -1 -15Z"/>';
    } else {
      s += '<ellipse class="evo-seed-shell" rx="6.4" ry="4.2" transform="rotate(-18)"/>' +
        '<path class="evo-seed-zzz" d="M-2 -8h4l-4 5h4"/>';
    }
    s += '<text class="evo-seed-txt" y="26" text-anchor="middle">' + esc(u.label) + "</text></g>";
  });
  return s;
}

/* 装配整棵树 */
function buildCodexTree(cats, prog) {
  const rnd = evoRng(20260903);
  const anim = !codexTreeGrown;
  const ctx = { segs: [] };
  const total = cats.reduce((a, c) => a + c.items.length, 0);

  // 主干：基部 → 顶端，带轻微 S 形摆动；粗细随进化阶段增长
  const stageId = (prog && prog.stage && Number(prog.stage.id)) || 1;
  const trunkAng = -0.05 + (rnd() - 0.5) * 0.03;
  const trunk = evoSample(rnd, 200, EVO_GROUND, trunkAng, total ? EVO_LEN[0] : EVO_LEN[0] * 0.58, -trunkAng * 1.5, 8);
  const trunkW = EVO_WID[0] * (total ? 0.84 + 0.055 * Math.min(7, stageId) : 0.52);
  const ringK = Math.max(0.55, Math.min(1.25, trunkW / EVO_WID[0]));
  ctx.segs.push({ pts: trunk, w: trunkW, depth: 0, cat: "trunk" });
  const top = trunk[8];

  cats.forEach((c) => {
    c.tips = [];
    c.elbow = null;
    c.hubPt = c.hub >= 1 ? top : evoPointAt(trunk, c.hub);
    const n = c.items.length;
    const g = Math.min(1, n / EVO_MAX_LEAF);
    c.k = 0.56 + 0.44 * g;              // 条目越多，该分类的枝越长
    c.wk = 0.76 + 0.24 * g;             // 越少的枝越细
    c.maxDepth = n <= 2 ? 2 : n <= 6 ? 3 : 4;  // 条目少时不抽末梢，避免出现光秃长枝
    if (total) evoGrow(ctx, rnd, c, c.hubPt[0], c.hubPt[1], c.ang, EVO_LEN[1] * c.k, EVO_WID[1] * c.wk, 1);
  });
  // 空数据：只留主干 + 两根小侧枝的小树苗
  if (!total) {
    [-0.5, 0.42].forEach((a) => {
      const pts = evoSample(rnd, top[0], top[1], a, 24, (rnd() - 0.5) * 0.3, 6);
      ctx.segs.push({ pts: pts, w: 2.6, depth: 1, cat: "trunk" });
    });
  }

  // defs：树皮渐变（深木 → 浅绿，全部取主题变量，自动适配深浅色）
  let s = '<svg id="evoTreeSvg" class="evo-tree-svg' + (anim ? " anim" : "") + '" viewBox="' + (total ? EVO_VIEW : "62 296 276 324") +
    '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Agent 成长树">';
  s += "<defs>" +
    '<linearGradient id="evoBark" gradientUnits="userSpaceOnUse" x1="200" y1="' + (EVO_GROUND + 6) + '" x2="200" y2="' + (EVO_TRUNK_TOP - 150) + '">' +
      '<stop offset="0" style="stop-color:var(--evo-bark-2)"/>' +
      '<stop offset=".34" style="stop-color:var(--evo-bark)"/>' +
      '<stop offset=".72" style="stop-color:var(--evo-bark-hi)"/>' +
      '<stop offset="1" style="stop-color:var(--accent-hi)"/>' +
    "</linearGradient>" +
    '<radialGradient id="evoFruitG" cx=".34" cy=".3" r=".82">' +
      '<stop offset="0" style="stop-color:var(--evo-fruit-hi)"/>' +
      '<stop offset=".62" style="stop-color:var(--green)"/>' +
      '<stop offset="1" style="stop-color:var(--evo-fruit-lo)"/>' +
    "</radialGradient>" +
    "</defs>";

  // 地面 / 土壤 / 草丛
  s += '<g class="evo-soil">' +
    '<path class="evo-earth" d="M14 ' + EVO_GROUND + "H386L374 " + EVO_H + 'H26Z"/>' +
    '<line class="evo-ground-line" x1="24" y1="' + EVO_GROUND + '" x2="376" y2="' + EVO_GROUND + '"/>';
  for (let i = 0; i < 19; i++) {
    const gx = 26 + i * 19.6 + (rnd() - 0.5) * 16;
    if (Math.abs(gx - 200) < 44 || rnd() < 0.25) continue;
    const gh = 3 + rnd() * 4.5;
    s += '<path class="evo-grass" d="M' + evoN(gx) + " " + EVO_GROUND + "q" + evoN((rnd() - 0.5) * 2.4) + " " + evoN(-gh * 0.6) +
      " " + evoN((rnd() - 0.5) * 3.4) + " " + evoN(-gh) + '" style="opacity:' + (0.14 + rnd() * 0.34).toFixed(2) + '"/>';
  }
  s += "</g>";

  // 根系（从主干两侧扎进土里，基部被年轮截面压住；树苗期不外扩）
  const rx0 = evoN(200 - 28 * ringK + 2), rx1 = evoN(200 + 28 * ringK - 2);
  const ry0 = evoN(EVO_GROUND - 5 - 11 * ringK);
  s += '<g class="evo-roots">' +
    '<path class="evo-root" d="M195 ' + ry0 + "C189 " + (EVO_GROUND - 2) + " 185 " + (EVO_GROUND + 1) + " " + rx0 + " " + (EVO_GROUND + 6) + '"/>' +
    '<path class="evo-root" d="M205 ' + ry0 + "C211 " + (EVO_GROUND - 2) + " 215 " + (EVO_GROUND + 1) + " " + rx1 + " " + (EVO_GROUND + 6) + '"/>' +
    '<path class="evo-root" d="M200 ' + (EVO_GROUND - 10) + "C200 " + (EVO_GROUND - 2) + " 200 " + (EVO_GROUND + 3) + ' 200 ' + (EVO_GROUND + 10) + '"/></g>';

  // 枝干（taper：粗枝拆成 2~3 段递减描边宽度）
  ctx.segs.forEach((g) => {
    const n = g.pts.length - 1;
    const parts = g.depth <= 1 ? 3 : g.depth === 2 ? 2 : 1;
    for (let k = 0; k < parts; k++) {
      const i0 = Math.max(0, Math.round((k * n) / parts) - (k ? 2 : 0));
      const i1 = Math.round(((k + 1) * n) / parts);
      const wid = (g.w * (1 - 0.1 * k)).toFixed(2);
      const dl = (EVO_DELAY[g.depth] + k * 0.05).toFixed(2);
      s += '<path class="evo-branch" data-cat="' + g.cat + '" stroke="url(#evoBark)" stroke-width="' + wid +
        '" pathLength="100" d="' + evoPolyline(g.pts, i0, i1) + '"' + (anim ? ' style="animation-delay:' + dl + 's"' : "") + "/>";
    }
  });

  // 主枝起点色环（分类归属，点击查看该分类全量）+ 末端条目
  let leafIdx = 0;
  cats.forEach((c) => {
    const hub = c.hubPt;
    if (total) {
      s += '<g class="evo-hub" data-cat="' + c.key + '" transform="translate(' + evoN(hub[0]) + "," + evoN(hub[1]) + ')">' +
        '<circle r="7" fill="transparent" pointer-events="all"/>' +
        '<circle class="evo-hub-dot" r="2.3" style="fill:' + c.color + '"/></g>';
    }
    if (!c.items.length) return;
    const shown = c.tips.length ? evoPick(c.tips, Math.min(c.items.length, EVO_MAX_LEAF)) : [];
    shown.forEach((tip, i) => {
      const it = c.items[i];
      if (!it) return;
      c.byIdx = c.byIdx || {};
      c.byIdx[leafIdx] = it.id;
      s += c.shapeKey === "skill"
        ? evoFruit(tip, it, c, rnd, leafIdx, anim)
        : evoLeaf(tip, it, c, rnd, leafIdx, anim);
      leafIdx++;
    });
    if (c.items.length > shown.length && shown.length) {
      s += evoPlusBunch(c, c.items.length - shown.length);
    }
  });

  s += evoRings(prog, ringK);
  s += evoSeeds((prog && prog.unlockNodes) || []);
  s += "</svg>";
  return s;
}

/* 从末梢列表里均匀挑 n 个叶位（条目少时不会全挤在一处） */
function evoPick(tips, n) {
  if (n >= tips.length) return tips.slice();
  const out = [], step = tips.length / n;
  for (let i = 0; i < n; i++) out.push(tips[Math.floor(i * step + step / 2)]);
  return out;
}

function renderCodexTree() {
  const root = $("evoCodexTree");
  if (!root || !evoData) return;
  const t = evoData.tree || {};
  const mem = t.memory || {};
  const skillItems = [];
  (t.skills || []).forEach((g) => (g.items || []).forEach((s) => skillItems.push(s)));
  const uniq = (arr) => {
    const seen = new Set();
    return (arr || []).filter((it) => {
      const k = it && (it.id || it.topic || it.name);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const cats = [
    { key: "memory", shapeKey: "mem",   label: "记忆", ic: "memory",  color: "var(--blue)", ang: -0.87, hub: 0.62, items: uniq((mem.memory || {}).items) },
    { key: "skills", shapeKey: "skill", label: "技能", ic: "toolbox", color: "var(--green)", ang: -0.3, hub: 0.955, items: uniq(skillItems) },
    { key: "exp",    shapeKey: "mem",   label: "经验", ic: "bulb",    color: "var(--warn)", ang: 0.3, hub: 1, items: uniq((mem.experience || {}).items) },
    { key: "lesson", shapeKey: "mem",   label: "教训", ic: "warn",    color: "var(--err)", ang: 0.87, hub: 0.68, items: uniq((mem.lesson || {}).items) },
  ];

  const prog = evoData.progression || {};
  root.innerHTML =
    '<div class="evo-legend" id="evoLegend">' +
      cats.map((c) =>
        '<button class="evo-lg" data-cat="' + c.key + '" title="查看全部 ' + c.label + '">' +
          '<i class="evo-lg-dot" style="background:' + c.color + '"></i>' + ico(c.ic) +
          c.label + "<b>" + c.items.length + "</b></button>").join("") +
    "</div>" +
    buildCodexTree(cats, prog) +
    '<div class="evo-tree-tip" id="evoTreeTip" style="display:none"></div>' +
    (((mem.memory || {}).items || []).length + ((mem.experience || {}).items || []).length + ((mem.lesson || {}).items || []).length + skillItems.length
      ? ""
      : '<div class="evo-tree-hint">' + ico("leaf") + "还没有沉淀，Agent 会在完成任务后长出第一片叶子</div>");

  initCodexTree(root, cats);
  codexTreeGrown = true;
}

/* 交互：hover tooltip + 同枝高亮，click 复用既有条目详情 */
function initCodexTree(root, cats) {
  const svg = $("evoTreeSvg");
  const tip = $("evoTreeTip");
  if (!svg || !tip) return;
  const catByKey = {};
  cats.forEach((c) => (catByKey[c.key] = c));
  const entryOf = (c, id) => c.items.find((x) => x.id === id) || null;

  function focus(catKey) {
    svg.querySelectorAll(".evo-branch.hot").forEach((p) => p.classList.remove("hot"));
    svg.classList.toggle("focusing", !!catKey);
    if (!catKey) return;
    svg.querySelectorAll('.evo-branch[data-cat="' + catKey + '"]').forEach((p) => p.classList.add("hot"));
  }

  function showTip(el, clientX, clientY) {
    const i = +el.dataset.i;
    const c = catByKey[el.dataset.cat];
    if (!c) return;
    const it = entryOf(c, c.byIdx && c.byIdx[i]);
    if (!it) return;
    const title = c.shapeKey === "skill" ? (it.name || "未命名技能") : (it.topic || it.type || "未命名条目");
    const body = (c.shapeKey === "skill" ? it.desc : it.content) || "";
    const meta = c.shapeKey === "skill"
      ? "来源 " + (it.source === "builtin" ? "内置" : it.source === "manual" ? "手动" : "任务沉淀")
      : "价值 " + (Number(it.valueScore) || 0) + " / 5 · 访问 " + (Number(it.accessCount) || 0) + " 次";
    tip.innerHTML = '<div class="evo-tip-t">' + ico(c.shapeKey === "skill" ? "toolbox" : "leaf") + esc(title) + "</div>" +
      '<div class="evo-tip-b">' + esc(String(body).slice(0, 60)) + (body.length > 60 ? "…" : "") + "</div>" +
      '<div class="evo-tip-m">' + esc(meta) + "</div>";
    const r = root.getBoundingClientRect();
    const tw = 226;
    let x = clientX - r.left + 12;
    if (x + tw > r.width) x = clientX - r.left - tw - 10;
    tip.style.display = "";
    tip.style.left = Math.max(4, x) + "px";
    tip.style.top = Math.max(4, clientY - r.top + 6) + "px";
    focus(el.dataset.cat);
  }
  function hideTip() { tip.style.display = "none"; focus(null); }

  svg.addEventListener("mousemove", (e) => {
    const el = e.target.closest ? e.target.closest(".evo-leaf,.evo-fruit") : null;
    if (el) showTip(el, e.clientX, e.clientY);
    else hideTip();
  });
  svg.addEventListener("mouseleave", hideTip);
  svg.addEventListener("click", (e) => {
    const seed = e.target.closest ? e.target.closest("[data-u]") : null;
    if (seed) { hideTip(); openUnlockDetail(seed.dataset.u); return; }
    if (e.target.closest && e.target.closest('[data-act="soul"]')) { hideTip(); openSoulEditor(); return; }
    const el = e.target.closest ? e.target.closest(".evo-leaf,.evo-fruit") : null;
    if (el) {
      const c = catByKey[el.dataset.cat];
      const id = c && c.byIdx && c.byIdx[+el.dataset.i];
      if (id) { hideTip(); openNodeDetail(c.shapeKey, id); }
      return;
    }
    const hub = e.target.closest ? e.target.closest(".evo-hub") : null;
    if (hub) { hideTip(); openCategoryDetail(hub.dataset.cat); return; }
    const plus = e.target.closest ? e.target.closest(".evo-plus") : null;
    if (plus) { hideTip(); openCategoryDetail(plus.dataset.cat); return; }
    const br = e.target.closest ? e.target.closest(".evo-branch") : null;
    if (br && br.dataset.cat !== "trunk") { hideTip(); openCategoryDetail(br.dataset.cat); }
  });

  const legend = $("evoLegend");
  if (legend) {
    legend.querySelectorAll(".evo-lg").forEach((b) => {
      b.onmouseenter = () => focus(b.dataset.cat);
      b.onmouseleave = () => focus(null);
      b.onclick = () => openCategoryDetail(b.dataset.cat);
    });
  }
}


function renderCodexSide() {
  const root = $("evoCodexSide");
  if (!root || !evoData) return;
  const prog = evoData.progression;
  const t = evoData.tree;
  const a = prog.attributes;
  const attrRow = (label, val) =>
    '<div class="evo-attr"><span class="evo-attr-name">' + label + '</span>' +
    '<div class="evo-attr-bar"><i style="width:' + Math.round(val) + '%"></i></div>' +
    '<span class="evo-attr-val">' + Math.round(val) + '</span></div>';

  const ACH_ICON = { first_fix: "wrench", ten_skills: "toolbox", soul_stable: "soul", path_chosen: "compass", fifty_skills: "trophy" };
  const ach = (prog.achievements || []).map((x) =>
    '<div class="evo-ach ' + (x.unlocked ? "on" : "off") + '" title="' + esc(x.name) + '">' +
      '<span class="evo-ach-ico">' + ico(x.unlocked ? (ACH_ICON[x.id] || "trophy") : "lock") + '</span>' +
      '<span class="evo-ach-name">' + esc(x.name) + '</span></div>').join("");

  const pathBtns = ["craftsman", "scholar", "companion"].map((p) => {
    const names = { craftsman: "工匠", scholar: "学者", companion: "伙伴" };
    const descs = { craftsman: "重代码质量", scholar: "重知识沉淀", companion: "重默契陪伴" };
    const active = prog.path === p;
    return '<button class="evo-path-btn' + (active ? " active" : "") + '" data-path="' + p + '">' +
      '<b>' + names[p] + '</b><span>' + descs[p] + '</span></button>';
  }).join("");

  root.innerHTML =
    '<div class="evo-sec">能力属性</div>' +
    attrRow("理解力", a.understanding) +
    attrRow("技艺", a.craft) +
    attrRow("稳健", a.robustness) +
    attrRow("默契", a.rapport) +
    '<div class="evo-sec">灵魂核心</div>' +
    '<div class="evo-soulcard" data-act="soul"><span class="evo-soul-emoji">' + ico("soul") + '</span>' +
      '<div><div class="evo-soul-name">' + esc(t.soul.name || "Agent") + '</div>' +
      '<div class="evo-soul-sub">' + esc((t.soul.values && t.soul.values[0]) || "尚未定义灵魂") + '</div>' +
      (t.soul.pendingCount ? '<div class="evo-soul-pend">' + t.soul.pendingCount + ' 项微调待确认</div>' : '') +
      '</div></div>' +
    '<div class="evo-sec">进化路线 <span class="evo-sec-tip">选定后影响属性成长偏向</span></div>' +
    '<div class="evo-paths">' + pathBtns + '</div>' +
    '<div class="evo-sec">成就徽章</div>' +
    '<div class="evo-achs">' + ach + '</div>';

  root.querySelector(".evo-soulcard").onclick = () => openSoulEditor();
  root.querySelectorAll(".evo-path-btn").forEach((b) => {
    b.onclick = async () => {
      await fetch("/api/progression", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: b.dataset.path }) });
      loadEvolutionTree();
    };
  });
}

/* 时间线视图：按 ts 排成纵向时间轴 */
function renderEvolutionTimeline(rootArg) {
  const root = rootArg || $("evoTimeline");
  if (!root || !evoData) return;
  root.innerHTML = "";
  const tl = evoData.timeline || [];
  if (!tl.length) { root.innerHTML = '<div class="evo-empty">还没有进化记录。完成几次任务后，Agent 会自动沉淀经验与灵魂微调。</div>'; return; }
  for (const it of tl) {
    const row = document.createElement("div");
    row.className = "evo-tl-row evo-click";
    row.dataset.kind = it.kind === "skill" ? "skill" : (it.kind === "soul" ? "soulprop" : "mem");
    row.dataset.id = it.id;
    const d = new Date(it.ts);
    const ds = isNaN(d) ? "" : (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const TL_ICON = { memory: "memory", experience: "bulb", lesson: "warn", skill: "toolbox", soul: "soul" };
    row.innerHTML = '<div class="evo-tl-dot"></div><div class="evo-tl-body"><div class="evo-tl-top"><span class="evo-ico">' + ico(TL_ICON[it.kind] || "dot") + '</span><span class="evo-tl-title">' + esc(it.title) + '</span><span class="evo-tl-time">' + ds + "</span></div>" + (it.sub ? '<div class="evo-tl-sub">' + esc(it.sub) + "</div>" : "") + "</div>";
    row.onclick = () => openNodeDetail(row.dataset.kind, it.id);
    root.appendChild(row);
  }
}

/* 节点详情弹窗（查看 / 删除） */
function openNodeDetail(kind, id) {
  let modal = $("evoDetailModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "evoDetailModal";
    modal.style.cssText = "position:fixed;inset:0;background:#000000aa;z-index:var(--z-overlay);display:none;align-items:center;justify-content:center";
    modal.innerHTML = '<div class="set-box" style="max-width:520px;max-height:80vh;display:flex;flex-direction:column">' +
      '<div class="set-head"><span id="evoDetailTitle"></span><button id="evoDetailClose"><i data-ico="close"></i></button></div>' +
      '<div class="set-body" id="evoDetailBody" style="overflow-y:auto"></div>' +
      '<div class="set-foot" id="evoDetailFoot" style="display:flex;gap:8px;justify-content:flex-end;padding:10px 12px;border-top:1px solid var(--border)"></div></div>';
    document.body.appendChild(modal);
    modal.querySelector("#evoDetailClose").onclick = () => { modal.style.display = "none"; };
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = "none"; };
  }
  const body = modal.querySelector("#evoDetailBody");
  const foot = modal.querySelector("#evoDetailFoot");
  const title = modal.querySelector("#evoDetailTitle");
  foot.innerHTML = "";

  if (kind === "soulprop") {
    const p = (evoData.tree.soul.proposals || []).find((x) => x.id === id);
    if (!p) { modal.style.display = "none"; return; }
    title.textContent = "灵魂微调提案";
    body.innerHTML = '<div class="evo-detail"><div class="evo-d-k">目标</div><div>' + esc(p.target) + '</div><div class="evo-d-k">内容</div><div>' + esc(p.content) + '</div><div class="evo-d-k">理由</div><div>' + esc(p.reason || "") + '</div><div class="evo-d-k">状态</div><div>' + esc(p.status) + '</div></div>';
    if (p.status === "pending") {
      const ok = document.createElement("button"); ok.className = "set-btn"; ok.style.background = "var(--ok)"; ok.style.color = "#000"; ok.textContent = "✓ 接受并写入灵魂";
      ok.onclick = async () => { await fetch("/api/soul/proposal/" + id + "?accept=1", { method: "PUT" }); modal.style.display = "none"; loadEvolutionTree(); };
      const no = document.createElement("button"); no.className = "set-btn"; no.textContent = "✗ 拒绝";
      no.onclick = async () => { await fetch("/api/soul/proposal/" + id + "?accept=0", { method: "PUT" }); modal.style.display = "none"; loadEvolutionTree(); };
      foot.appendChild(ok); foot.appendChild(no);
    }
    modal.style.display = "flex"; replaceIcons(); return;
  }

  if (kind === "skill") {
    const all = evoData.tree.skills;
    let s = null;
    for (const g of all) { const f = g.items.find((x) => x.id === id); if (f) { s = f; break; } }
    if (!s) { modal.style.display = "none"; return; }
    title.textContent = "Skill：" + s.name;
    body.innerHTML = '<div class="evo-detail"><div class="evo-d-k">来源</div><div>' + esc(s.source || "") + '</div><div class="evo-d-k">描述</div><div>' + esc(s.desc || "") + '</div></div>';
    modal.style.display = "flex"; replaceIcons(); return;
  }

  // memory / experience / lesson
  const mem = evoData.tree;
  let entry = null;
  for (const grp of [mem.memory.memory, mem.memory.experience, mem.memory.lesson]) {
    const f = grp.items.find((x) => x.id === id); if (f) { entry = f; break; }
  }
  if (!entry) { modal.style.display = "none"; return; }
  title.textContent = "记忆条目";
  const renderMemDetail = (e) => {
    body.innerHTML = '<div class="evo-detail">' +
      '<div class="evo-d-k">类型</div><div>' + esc(e.type) + '</div>' +
      '<div class="evo-d-k">主题</div><div>' + esc(e.topic || "") + '</div>' +
      '<div class="evo-d-k">内容</div><div>' + esc(e.content) + '</div>' +
      '<div class="evo-d-k">来源</div><div>' + esc(e.source || "手动") + ' · 访问 ' + (e.accessCount || 0) + ' 次</div>' +
      '</div>';
  };
  renderMemDetail(entry);
  // 编辑按钮
  const edit = document.createElement("button"); edit.className = "set-btn"; edit.innerHTML = ico("edit") + " 编辑";
  edit.onclick = () => {
    title.textContent = "编辑记忆条目";
    body.innerHTML =
      '<div style="margin-bottom:8px"><label class="set-label">主题</label><input id="memTopic" class="set-input" value="' + esc(entry.topic || "") + '"></div>' +
      '<div style="margin-bottom:8px"><label class="set-label">内容</label><textarea id="memContent" class="set-input" rows="6" style="width:100%;resize:vertical">' + esc(entry.content) + '</textarea></div>';
    foot.innerHTML = "";
    const save = document.createElement("button"); save.className = "set-btn"; save.style.background = "var(--ok)"; save.style.color = "#000"; save.textContent = "保存";
    save.onclick = async () => {
      try {
        const r = await fetch("/api/memory/" + id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic: $("memTopic").value.trim(), content: $("memContent").value.trim() }) });
        const j = await r.json();
        if (j.ok) { toast("已保存"); modal.style.display = "none"; loadEvolutionTree(); }
        else toast("保存失败：" + (j.error || ""));
      } catch (e2) { toast("保存失败：" + e2.message); }
    };
    const cancel = document.createElement("button"); cancel.className = "set-btn"; cancel.textContent = "取消";
    cancel.onclick = () => { title.textContent = "记忆条目"; renderMemDetail(entry); foot.innerHTML = ""; foot.appendChild(edit); foot.appendChild(del); replaceIcons(); };
    foot.appendChild(save); foot.appendChild(cancel);
  };
  // 删除按钮（带确认）
  const del = document.createElement("button"); del.className = "set-btn danger"; del.innerHTML = ico("trash") + " 删除";
  del.onclick = async () => {
    if (!confirm("确认删除这条记忆？删除后不可恢复。")) return;
    await fetch("/api/memory/" + id, { method: "DELETE" });
    modal.style.display = "none"; loadEvolutionTree();
  };
  foot.appendChild(edit); foot.appendChild(del);
  modal.style.display = "flex"; replaceIcons();
}

/* 分类全量列表（点击成长树的 记忆/技能/经验/教训 模块） */
function openCategoryDetail(catKey) {
  const modal = $("evoDetailModal");
  if (!modal || !evoData) return;
  const title = modal.querySelector("#evoDetailTitle");
  const body = modal.querySelector("#evoDetailBody");
  const foot = modal.querySelector("#evoDetailFoot");
  foot.innerHTML = "";
  const t = evoData.tree;
  const map = {
    memory: { label: "记忆", kind: "mem", items: t.memory.memory.items, color: "#0a6ebd", ico: "memory" },
    skills: { label: "技能", kind: "skill", items: t.skills.reduce((a, g) => a.concat(g.items), []), color: "#1a8c6e", ico: "toolbox" },
    exp:    { label: "经验", kind: "mem", items: t.memory.experience.items, color: "#b58a00", ico: "bulb" },
    lesson: { label: "教训", kind: "mem", items: t.memory.lesson.items, color: "#d94343", ico: "warn" },
  };
  const m = map[catKey];
  if (!m) return;
  title.innerHTML = ico(m.ico) + " " + m.label + " · " + m.items.length + " 条";
  if (!m.items.length) { body.innerHTML = '<div class="evo-empty">暂无条目。完成几次任务后 Agent 会自动沉淀。</div>'; modal.style.display = "flex"; replaceIcons(); return; }
  const rowHtml = (it) => {
    const nm = catKey === "skills" ? (it.name || "") : (it.topic || it.type || it.content || "");
    const sub = catKey === "skills" ? (it.desc || "") : (it.content || "");
    return '<div class="evo-cat-row" data-kind="' + m.kind + '" data-id="' + esc(it.id) + '">' +
      '<span class="evo-cat-dot" style="background:' + m.color + '"></span>' +
      '<div class="evo-cat-main"><div class="evo-cat-name">' + esc(("" + (nm || "")).slice(0, 60)) + '</div>' +
      (sub ? '<div class="evo-cat-sub">' + esc(("" + sub).slice(0, 90)) + '</div>' : '') + '</div>' +
      '<span class="evo-cat-go">' + ico("chevR") + '</span></div>';
  };
  body.innerHTML = '<div class="evo-cat-list">' + m.items.map(rowHtml).join("") + '</div>';
  body.querySelectorAll(".evo-cat-row").forEach((r) => { r.onclick = () => openNodeDetail(r.dataset.kind, r.dataset.id); });
  modal.style.display = "flex"; replaceIcons();
}

/* 进阶称号说明（点击成长树底部的 架构师/导师/贤者） */
function openUnlockDetail(id) {
  const modal = $("evoDetailModal");
  if (!modal || !evoData) return;
  const u = (evoData.progression.unlockNodes || []).find((x) => x.id === id);
  if (!u) return;
  const title = modal.querySelector("#evoDetailTitle");
  const body = modal.querySelector("#evoDetailBody");
  const foot = modal.querySelector("#evoDetailFoot");
  foot.innerHTML = "";
  title.innerHTML = ico(u.met ? "trophy" : "lock") + " 进阶称号：" + u.label;
  const roleDesc = {
    architect: "当 Agent 积累的技能足够多、对你和项目的理解够深时，它更像一位「架构师」——能主动规划结构、拆分模块、把控全局。",
    mentor: "当 Agent 进化到较高阶段（阶段≥3 茁壮及以上），它更像一位「导师」——能总结方法论、带你看清问题本质，而不只是执行。",
    sage: "当 Agent 灵魂稳固且技能丰富（阶段≥3 且 Skill≥20），它趋近于「贤者」——稳定、可靠、越来越懂你，是长期协作沉淀的结果。",
  };
  body.innerHTML = '<div class="evo-detail">' +
    '<div class="evo-d-k">这是什么</div><div>' + esc(roleDesc[id] || "Agent 的进阶称号，代表它在该方向的成熟度。") + '</div>' +
    '<div class="evo-d-k">解锁条件</div><div>' + esc(u.req) + '</div>' +
    '<div class="evo-d-k">当前状态</div><div>' + (u.met
      ? '<span style="color:var(--green,#1a8c6e);font-weight:600">✓ 已解锁</span>'
      : '<span style="color:var(--text-dim)">未解锁，继续完成任务、沉淀技能即可达成</span>') + '</div></div>';
  modal.style.display = "flex"; replaceIcons();
}

/* 灵魂编辑弹窗（手动编辑 + 显示待确认提案） */
function openSoulEditor() {
  let modal = $("soulEditorModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "soulEditorModal";
    modal.style.cssText = "position:fixed;inset:0;background:#000000aa;z-index:var(--z-overlay);display:none;align-items:center;justify-content:center";
    modal.innerHTML = '<div class="set-box" style="max-width:560px;max-height:85vh;display:flex;flex-direction:column">' +
      '<div class="set-head"><span>' + ico("soul") + ' 编辑 Agent 灵魂</span><button id="soulEditorClose"><i data-ico="close"></i></button></div>' +
      '<div class="set-body" id="soulEditorBody" style="overflow-y:auto;padding:12px"></div>' +
      '<div class="set-foot" style="display:flex;gap:8px;justify-content:flex-end;padding:10px 12px;border-top:1px solid var(--border)"><button id="soulSave" class="set-btn" style="background:var(--ok);color:#000">保存</button></div></div>';
    document.body.appendChild(modal);
    modal.querySelector("#soulEditorClose").onclick = () => { modal.style.display = "none"; };
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = "none"; };
    modal.querySelector("#soulSave").onclick = async () => {
      const get = (id) => Array.from(modal.querySelectorAll("#" + id + " .soul-line")).map((ta) => ta.value.trim()).filter(Boolean);
      const patch = {
        name: modal.querySelector("#soulName").value.trim(),
        vibe: modal.querySelector("#soulVibe").value.trim(),
        values: get("soulValues"),
        boundaries: get("soulBoundaries"),
        principles: get("soulPrinciples"),
      };
      try {
        await fetch("/api/soul", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
        modal.style.display = "none"; loadEvolutionTree(); toast("灵魂已更新");
      } catch (e) { toast("保存失败：" + e.message); }
    };
  }
  const body = modal.querySelector("#soulEditorBody");
  const soul = evoData ? evoData.tree.soul : null;
  const cur = soul || { name: "pan", vibe: "warm", values: [], boundaries: [], principles: [] };
  const taBlock = (id, label, arr) =>
    '<div style="margin-bottom:10px"><div class="set-label">' + label + '</div><div id="' + id + '">' +
    arr.map((x) => '<textarea class="soul-line" rows="2" style="width:100%;margin-bottom:4px">' + esc(x) + "</textarea>").join("") +
    '<button class="evo-tbtn" data-add="' + id + '">+ 添加一行</button></div></div>';
  body.innerHTML =
    '<div style="display:flex;gap:8px;margin-bottom:10px">' +
      '<label style="flex:1">名称<input id="soulName" class="set-input" value="' + esc(cur.name || "") + '"></label>' +
      '<label style="flex:1">风格<input id="soulVibe" class="set-input" value="' + esc(cur.vibe || "") + '"></label>' +
    "</div>" +
    taBlock("soulValues", "价值观（决策时优先考虑）", cur.values) +
    taBlock("soulBoundaries", "边界（绝不做的事）", cur.boundaries) +
    taBlock("soulPrinciples", "原则（通用工作准则）", cur.principles) +
    '<div style="margin-top:8px"><div class="set-label">待确认提案（Agent 自动提议，接受后写入上方对应列表）</div><div id="soulProposals">' +
    (cur.proposals && cur.proposals.length ? cur.proposals.map((p) =>
      '<div class="evo-prop' + (p.status !== "pending" ? " done" : "") + '"><span>' + (p.status === "pending" ? "待定" : (p.status === "accepted" ? "✓" : "✗")) + " [" + esc(p.target) + "] " + esc(p.content) + (p.reason ? " — " + esc(p.reason) : "") + "</span>" +
      (p.status === "pending" ? '<span><button class="evo-tbtn" data-acc="' + p.id + '">接受</button><button class="evo-tbtn" data-rej="' + p.id + '">拒绝</button></span>' : "") + "</div>"
    ).join("") : '<div class="evo-empty">暂无提案</div>') + "</div></div>";

  body.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => {
    const wrap = body.querySelector("#" + b.dataset.add);
    const ta = document.createElement("textarea"); ta.className = "soul-line"; ta.rows = 2; ta.style.cssText = "width:100%;margin-bottom:4px";
    wrap.insertBefore(ta, b);
  });
  body.querySelectorAll("[data-acc]").forEach((b) => b.onclick = async () => { await fetch("/api/soul/proposal/" + b.dataset.acc + "?accept=1", { method: "PUT" }); openSoulEditor(); loadEvolutionTree(); });
  body.querySelectorAll("[data-rej]").forEach((b) => b.onclick = async () => { await fetch("/api/soul/proposal/" + b.dataset.rej + "?accept=0", { method: "PUT" }); openSoulEditor(); loadEvolutionTree(); });

  modal.style.display = "flex"; replaceIcons();
}
