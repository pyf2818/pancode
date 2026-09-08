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

function renderCodexTree() {
  const root = $("evoCodexTree");
  if (!root || !evoData) return;
  root.innerHTML = buildCodexBubble(evoData.tree, evoData.progression);
  initBubblePhysics(root);
}

function buildCodexBubble(t, prog) {
  const C = {
    soul:   { f: "#9b3fb0", s: "#6a2a86", glow: "#b18cff" },
    memory: { f: "#0a6ebd", s: "#084c7a", glow: "#3ee0ff" },
    skills: { f: "#1a8c6e", s: "#0f5a45", glow: "#2dd4a7" },
    exp:    { f: "#b58a00", s: "#8a6a00", glow: "#fbbf24" },
    lesson: { f: "#d94343", s: "#a32d2d", glow: "#fb7185" },
  };
  const W = 440, H = 600;

  const nodes = [];
  const edges = [];

  // 根节点（固定）
  nodes.push({ id: "soul", x: W / 2, y: 55, r: 26, c: C.soul, label: t.soul.name || "Agent", kind: "soul", fixed: true, lv: 0 });

  // 分类节点
  const cats = [
    { key: "memory", x: 90,  y: 200, label: "记忆", items: t.memory.memory.items, c: C.memory },
    { key: "skills", x: 350, y: 200, label: "技能", items: t.skills.reduce((a, g) => a.concat(g.items), []), c: C.skills },
    { key: "exp",    x: 90,  y: 410, label: "经验", items: t.memory.experience.items, c: C.exp },
    { key: "lesson", x: 350, y: 410, label: "教训", items: t.memory.lesson.items, c: C.lesson },
  ];

  cats.forEach((cat) => {
    const seen = new Set();
    const unique = cat.items.filter((it) => { const k = it.id || it.topic || it.name || it.type; if (seen.has(k)) return false; seen.add(k); return true; });
    const lv = Math.min(9, 1 + Math.floor(unique.length / 3));
    const r = 18 + Math.min(lv, 5);
    const catId = "cat-" + cat.key;
    nodes.push({ id: catId, x: cat.x, y: cat.y, r: r, c: cat.c, label: cat.label + " " + unique.length, kind: "cat", catKey: cat.key, lv: lv, fixed: false, parent: "soul" });
    edges.push({ from: "soul", to: catId });

    const top = unique.slice(0, 5);
    top.forEach((it, i) => {
      const angle = (i / top.length) * Math.PI * 2 - Math.PI / 2;
      const dist = r + 35;
      const lx = cat.x + Math.cos(angle) * dist;
      const ly = cat.y + Math.sin(angle) * dist;
      const leafId = "leaf-" + cat.key + "-" + i;
      const nm = (cat.key === "skills" ? it.name : (it.topic || it.type || ""));
      const label = (nm || "").slice(0, 10);
      const kind = cat.key === "skills" ? "skill" : "mem";
      nodes.push({ id: leafId, x: lx, y: ly, r: 7, c: cat.c, label: label, kind: kind, leafId: it.id, fixed: false, parent: catId, isLeaf: true });
      edges.push({ from: catId, to: leafId });
    });
  });

  // 进阶称号节点
  const un = (prog && prog.unlockNodes) || [];
  un.forEach((u, i) => {
    const ux = W / 2 - (un.length - 1) * 65 / 2 + i * 65;
    const uy = 560;
    nodes.push({ id: "unlock-" + u.id, x: ux, y: uy, r: 16, c: u.met ? { f: "#1a8c6e", s: "#0f5a45", glow: "#2dd4a7" } : { f: "#6a7078", s: "#4a5058", glow: "#8a9098" }, label: u.label, kind: "unlock", unlockId: u.id, met: u.met, fixed: false, isUnlock: true });
  });

  // 构建 HTML
  let s = '<div class="evo-bubble-canvas" style="width:100%;height:' + H + 'px;position:relative;overflow:hidden">';
  // 背景网格
  s += '<svg class="evo-bubble-bg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">';
  s += '<defs><pattern id="hexgrid-b" width="30" height="26" patternUnits="userSpaceOnUse"><path d="M15 0L30 7.5L30 18.5L15 26L0 18.5L0 7.5Z" fill="none" stroke="var(--border)" stroke-width="0.5" opacity="0.25"/></pattern>';
  s += '<radialGradient id="bg-glow"><stop offset="0%" stop-color="var(--accent-glow)" stop-opacity="0.08"/><stop offset="100%" stop-color="transparent" stop-opacity="0"/></radialGradient></defs>';
  s += '<rect width="' + W + '" height="' + H + '" fill="url(#hexgrid-b)"/>';
  s += '<rect width="' + W + '" height="' + H + '" fill="url(#bg-glow)"/>';
  s += '</svg>';

  // 连线 SVG 层
  s += '<svg class="evo-bubble-edges" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none">';
  edges.forEach((e) => {
    s += '<path id="edge-' + e.from + '-' + e.to + '" class="evo-bubble-edge" stroke="' + (nodes.find(n => n.id === e.to) || {}).c?.s + '" stroke-width="1.5" fill="none" opacity="0.4"/>';
  });
  s += '</svg>';

  // 节点数据（JSON 嵌入）
  s += '<script type="application/json" id="evo-bubble-data">' + esc(JSON.stringify({ nodes: nodes.map(n => ({ id: n.id, x: n.x, y: n.y, r: n.r, fixed: n.fixed, parent: n.parent })), edges: edges, W: W, H: H })) + '</script>';

  // 节点球 div
  nodes.forEach((n) => {
    const cls = ["evo-bubble"];
    if (n.fixed) cls.push("evo-bubble-root");
    if (n.isLeaf) cls.push("evo-bubble-leaf");
    if (n.isUnlock) cls.push("evo-bubble-unlock");
    if (n.isUnlock && n.met) cls.push("met");
    const bg = 'background:radial-gradient(circle at 35% 30%, ' + n.c.glow + ', ' + n.c.f + ' 60%, ' + n.c.s + ')';
    const shadow = 'box-shadow:0 0 ' + (n.r * 0.8) + 'px ' + n.c.glow + '88, inset 0 1px 0 #fff3';
    s += '<div class="' + cls.join(" ") + '" data-id="' + esc(n.id) + '" data-kind="' + esc(n.kind) + '" data-fixed="' + (n.fixed ? "1" : "0") + '"';
    if (n.kind === "cat") s += ' data-cat="' + esc(n.catKey) + '"';
    if (n.kind === "unlock") s += ' data-unlock-id="' + esc(n.unlockId) + '"';
    if (n.kind === "skill" || n.kind === "mem") s += ' data-leaf-id="' + esc(n.leafId || "") + '"';
    s += ' style="left:' + (n.x - n.r) + 'px;top:' + (n.y - n.r) + 'px;width:' + (n.r * 2) + 'px;height:' + (n.r * 2) + 'px;' + bg + ';' + shadow + '" title="' + esc(n.label) + '">';
    if (n.kind === "soul") {
      s += '<span class="evo-bubble-icon">' + ico("soul") + '</span>';
    } else if (n.kind === "cat") {
      s += '<span class="evo-bubble-lv">L' + n.lv + '</span>';
    } else if (n.isUnlock) {
      s += '<span class="evo-bubble-icon">' + ico(n.met ? "check" : "lock") + '</span>';
    }
    s += '<span class="evo-bubble-label">' + esc(n.label) + '</span>';
    s += '</div>';
  });

  s += '<div class="evo-bubble-hint">拖动节点可自由排列 · 根节点固定</div>';
  s += '</div>';
  return s;
}

function initBubblePhysics(container) {
  const dataEl = container.querySelector("#evo-bubble-data");
  if (!dataEl) return;
  let data;
  try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }
  const W = data.W, H = data.H;
  const canvas = container.querySelector(".evo-bubble-canvas");
  const edgeSvg = container.querySelector(".evo-bubble-edges");
  if (!canvas || !edgeSvg) return;

  // 获取实际渲染尺寸比例
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / W;

  // 节点状态
  const nodes = {};
  data.nodes.forEach((n) => { nodes[n.id] = { x: n.x, y: n.y, vx: 0, vy: 0, r: n.r, fixed: n.fixed, parent: n.parent }; });

  const nodeEls = {};
  container.querySelectorAll(".evo-bubble").forEach((el) => { nodeEls[el.dataset.id] = el; });

  // 更新连线
  function updateEdges() {
    data.edges.forEach((e) => {
      const a = nodes[e.from], b = nodes[e.to];
      if (!a || !b) return;
      const path = edgeSvg.querySelector("#edge-" + e.from + "-" + e.to);
      if (!path) return;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dy = b.y - a.y;
      const cp1x = a.x, cp1y = a.y + dy * 0.3;
      const cp2x = b.x, cp2y = b.y - dy * 0.3;
      path.setAttribute("d", "M" + a.x + " " + a.y + " C" + cp1x + " " + cp1y + " " + cp2x + " " + cp2y + " " + b.x + " " + b.y);
    });
  }

  // 更新节点位置
  function updateNodes() {
    for (const id in nodes) {
      const n = nodes[id], el = nodeEls[id];
      if (!el) continue;
      el.style.left = (n.x - n.r) + "px";
      el.style.top = (n.y - n.r) + "px";
    }
  }

  // 物理模拟
  const REPULSION = 6000;
  const SPRING = 0.015;
  const DAMPING = 0.82;
  const MAX_V = 8;
  let animId = null;
  let dragging = null;

  function step() {
    const ids = Object.keys(nodes);
    for (const id of ids) {
      const n = nodes[id];
      if (n.fixed || (dragging && dragging.id === id)) { n.vx = 0; n.vy = 0; continue; }
      let fx = 0, fy = 0;
      // 斥力
      for (const oid of ids) {
        if (oid === id) continue;
        const o = nodes[oid];
        let dx = n.x - o.x, dy = n.y - o.y;
        let dist2 = dx * dx + dy * dy + 1;
        let dist = Math.sqrt(dist2);
        if (dist < n.r + o.r + 4) { dist = n.r + o.r + 4; dist2 = dist * dist; }
        const f = REPULSION / dist2;
        fx += (dx / dist) * f;
        fy += (dy / dist) * f;
      }
      // 弹簧力（连向 parent）
      if (n.parent && nodes[n.parent]) {
        const p = nodes[n.parent];
        const dx = p.x - n.x, dy = p.y - n.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.1;
        const rest = 80;
        const f = SPRING * (dist - rest);
        fx += (dx / dist) * f * dist;
        fy += (dy / dist) * f * dist;
      }
      // 边界
      const margin = n.r + 4;
      if (n.x < margin) fx += (margin - n.x) * 0.3;
      if (n.x > W - margin) fx -= (n.x - (W - margin)) * 0.3;
      if (n.y < margin) fy += (margin - n.y) * 0.3;
      if (n.y > H - margin) fy -= (n.y - (H - margin)) * 0.3;

      n.vx = (n.vx + fx * 0.001) * DAMPING;
      n.vy = (n.vy + fy * 0.001) * DAMPING;
      if (n.vx > MAX_V) n.vx = MAX_V; if (n.vx < -MAX_V) n.vx = -MAX_V;
      if (n.vy > MAX_V) n.vy = MAX_V; if (n.vy < -MAX_V) n.vy = -MAX_V;
      n.x += n.vx;
      n.y += n.vy;
    }
    updateEdges();
    updateNodes();
    animId = requestAnimationFrame(step);
  }

  // 拖拽（用移动距离区分拖拽和点击，不阻止事件传播）
  const DRAG_THRESHOLD = 4;
  container.querySelectorAll(".evo-bubble").forEach((el) => {
    if (el.dataset.fixed === "1") return;
    el.addEventListener("mousedown", (e) => {
      const id = el.dataset.id;
      const n = nodes[id];
      if (!n) return;
      const startX = e.clientX, startY = e.clientY;
      const origX = n.x, origY = n.y;
      let moved = false;
      function onMove(ev) {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (!moved && (dx * dx + dy * dy) > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          moved = true;
          dragging = { id: id };
          el.classList.add("dragging");
        }
        if (moved) {
          e.preventDefault();
          n.x = origX + dx / scale;
          n.y = origY + dy / scale;
          n.x = Math.max(n.r, Math.min(W - n.r, n.x));
          n.y = Math.max(n.r, Math.min(H - n.r, n.y));
          n.vx = 0; n.vy = 0;
          updateEdges();
          updateNodes();
        }
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        el.classList.remove("dragging");
        dragging = null;
        if (moved) { el._justDragged = true; setTimeout(() => { el._justDragged = false; }, 50); }
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    // 触摸支持
    el.addEventListener("touchstart", (e) => {
      if (el.dataset.fixed === "1") return;
      const touch = e.touches[0];
      const id = el.dataset.id;
      const n = nodes[id];
      if (!n) return;
      const startX = touch.clientX, startY = touch.clientY;
      const origX = n.x, origY = n.y;
      let moved = false;
      function onMove(ev) {
        const t = ev.touches[0];
        const dx = t.clientX - startX, dy = t.clientY - startY;
        if (!moved && (dx * dx + dy * dy) > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          moved = true;
          dragging = { id: id };
          el.classList.add("dragging");
        }
        if (moved) {
          ev.preventDefault();
          n.x = origX + dx / scale;
          n.y = origY + dy / scale;
          n.x = Math.max(n.r, Math.min(W - n.r, n.x));
          n.y = Math.max(n.r, Math.min(H - n.r, n.y));
          n.vx = 0; n.vy = 0;
          updateEdges();
          updateNodes();
        }
      }
      function onEnd() {
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onEnd);
        el.classList.remove("dragging");
        dragging = null;
      }
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onEnd);
    }, { passive: false });
  });

  // 点击事件（分类/叶子/解锁/灵魂）
  container.querySelectorAll(".evo-bubble").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (el._justDragged || el.classList.contains("dragging")) return;
      const kind = el.dataset.kind;
      if (kind === "soul") { openSoulEditor(); return; }
      if (kind === "cat") { openCategoryDetail(el.dataset.cat); return; }
      if (kind === "unlock") { openUnlockDetail(el.dataset.unlockId); return; }
      if (kind === "skill" || kind === "mem") { openNodeDetail(kind, el.dataset.leafId); return; }
    });
  });

  updateEdges();
  animId = requestAnimationFrame(step);

  // 清理旧动画（切换 tab 时）
  if (container._evoAnimId) cancelAnimationFrame(container._evoAnimId);
  container._evoAnimId = animId;
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
