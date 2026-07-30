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
  root.innerHTML = buildCodexSVG(evoData.tree, evoData.progression);
  root.querySelectorAll('[data-node]').forEach((n) => {
    const k = n.dataset.kind;
    if (k === "soul") n.onclick = () => openSoulEditor();
    else n.onclick = (e) => { e.stopPropagation(); openNodeDetail(k, n.dataset.id); };
  });
  root.querySelectorAll('[data-cat]').forEach((n) => {
    n.onclick = () => openCategoryDetail(n.dataset.cat);
  });
  root.querySelectorAll('[data-unlock-id]').forEach((n) => { n.onclick = () => openUnlockDetail(n.dataset.unlockId); });
}

function buildCodexSVG(t, prog) {
  const C = {
    soul:   { f: "#9b3fb0", s: "#6a2a86" },
    memory: { f: "#0a6ebd", s: "#084c7a" },
    skills: { f: "#1a8c6e", s: "#0f5a45" },
    exp:    { f: "#b58a00", s: "#8a6a00" },
    lesson: { f: "#d94343", s: "#a32d2d" },
  };
  const W = 360, H = 470;
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" preserveAspectRatio="xMidYMid meet" font-family="-apple-system,Segoe UI,sans-serif" role="img">';

  const root_ = { x: 180, y: 34 };
  const cats = [
    { key: "memory", x: 64, y: 150, label: "记忆", items: t.memory.memory.items, c: C.memory },
    { key: "skills", x: 296, y: 150, label: "技能", items: t.skills.reduce((a, g) => a.concat(g.items), []), c: C.skills },
    { key: "exp", x: 64, y: 300, label: "经验", items: t.memory.experience.items, c: C.exp },
    { key: "lesson", x: 296, y: 300, label: "教训", items: t.memory.lesson.items, c: C.lesson },
  ];
  cats.forEach((cat) => {
    s += '<path class="evo-branch" d="M' + root_.x + ' ' + root_.y + ' C' + root_.x + ' ' + (root_.y + 40) + ' ' + cat.x + ' ' + (cat.y - 50) + ' ' + cat.x + ' ' + cat.y + '" stroke="' + cat.c.s + '" stroke-width="3" fill="none" opacity="0.7"/>';
  });

  // 根：灵魂（内联人形 SVG，替代 emoji）
  s += '<g class="evo-node-root" data-node data-kind="soul" data-id="soul" style="cursor:pointer">' +
    '<circle cx="' + root_.x + '" cy="' + root_.y + '" r="22" fill="' + C.soul.f + '" stroke="' + C.soul.s + '" stroke-width="1.5"/>' +
    '<circle cx="' + root_.x + '" cy="' + (root_.y - 5) + '" r="4.6" fill="#fff"/>' +
    '<path d="M' + (root_.x - 8.5) + ' ' + (root_.y + 7) + 'c0-4.8 3.8-8 8.5-8s8.5 3.2 8.5 8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></g>';
  s += '<text x="' + root_.x + '" y="' + (root_.y + 42) + '" font-size="12" font-weight="600" style="fill:var(--text)" text-anchor="middle">' + esc(t.soul.name || "Agent") + '</text>';

  cats.forEach((cat) => {
    const lv = Math.min(9, 1 + Math.floor(cat.items.length / 3));
    const r = 14 + Math.min(lv, 5);
    const top = cat.items.slice(0, 3);
    s += '<g class="evo-cat-group" data-cat="' + cat.key + '" style="cursor:pointer">';
    s += '<circle class="evo-node-cat" cx="' + cat.x + '" cy="' + cat.y + '" r="' + r + '" fill="' + cat.c.f + '" stroke="' + cat.c.s + '" stroke-width="1.5"/>';
    s += '<text x="' + cat.x + '" y="' + (cat.y + 4) + '" font-size="11" font-weight="600" fill="#fff" text-anchor="middle">L' + lv + '</text>';
    s += '<text x="' + cat.x + '" y="' + (cat.y + r + 16) + '" font-size="11.5" font-weight="600" style="fill:var(--text)" text-anchor="middle">' + cat.label + ' ' + cat.items.length + '</text>';

    top.forEach((it, i) => {
      const ox = cat.x + (i - 1) * 34;
      const oy = cat.y + r + 34 + (i % 2) * 16;
      const ir = 8;
      const id = it.id;
      const kind = cat.key === "skills" ? "skill" : "mem";
      const nm = (cat.key === "skills" ? it.name : (it.topic || it.type || ""));
      s += '<g class="evo-node-leaf" data-node data-kind="' + kind + '" data-id="' + esc(id) + '" style="cursor:pointer">';
      s += '<title>' + esc((nm || "").slice(0, 30)) + '</title>';
      s += '<circle cx="' + ox + '" cy="' + oy + '" r="' + ir + '" fill="' + cat.c.f + '" opacity="0.85" stroke="' + cat.c.s + '" stroke-width="1"/>';
      s += '</g>';
    });
    s += '</g>';
  });

  // 进阶称号（虚线锁定态，可点击查看说明）
  s += '<text x="64" y="412" font-size="10.5" font-weight="600" style="fill:var(--text-dim)" text-anchor="start">进阶称号 · 达成条件后解锁</text>';
  const un = (prog && prog.unlockNodes) || [];
  un.forEach((u, i) => {
    const ux = 64 + i * 116;
    const uy = 432;
    const cls = u.met ? "evo-unlock-on" : "";
    s += '<g class="' + cls + '" data-unlock-id="' + esc(u.id) + '" style="cursor:pointer">';
    s += '<title>' + esc(u.label + "：" + (u.met ? "已解锁" : u.req)) + '</title>';
    s += '<circle cx="' + ux + '" cy="' + uy + '" r="16" fill="' + (u.met ? "#1a8c6e" : "#eef0f2") + '" stroke="' + (u.met ? "#0f5a45" : "#b0b6bd") + '" stroke-width="1.5" stroke-dasharray="4 3"/>';
    if (u.met) {
      s += '<path d="M' + (ux - 5) + ' ' + uy + 'l3.4 3.4L' + (ux + 5.5) + ' ' + (uy - 4) + '" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
    } else {
      s += '<rect x="' + (ux - 4.5) + '" y="' + (uy - 1) + '" width="9" height="7" rx="1.4" fill="none" stroke="#8a9098" stroke-width="1.6"/>';
      s += '<path d="M' + (ux - 2.6) + ' ' + (uy - 1) + 'v-2.2a2.6 2.6 0 0 1 5.2 0v2.2" fill="none" stroke="#8a9098" stroke-width="1.6"/>';
    }
    s += '</g>';
    s += '<text x="' + ux + '" y="' + (uy + 30) + '" font-size="9.5" style="fill:var(--text-dim)" text-anchor="middle">' + esc(u.label) + '</text>';
  });

  s += '</svg>';
  return s;
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
  body.innerHTML = '<div class="evo-detail"><div class="evo-d-k">类型</div><div>' + esc(entry.type) + '</div><div class="evo-d-k">主题</div><div>' + esc(entry.topic || "") + '</div><div class="evo-d-k">内容</div><div>' + esc(entry.content) + '</div></div>';
  const del = document.createElement("button"); del.className = "set-btn danger"; del.innerHTML = ico("trash") + " 删除";
  del.onclick = async () => { await fetch("/api/memory/" + id, { method: "DELETE" }); modal.style.display = "none"; loadEvolutionTree(); };
  foot.appendChild(del);
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

      modal.style.display = "none"; loadEvolutionTree(); toast("灵魂已更新");
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
