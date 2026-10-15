/* ============================================================
   pancode Skill 市场 / 选择器 / 沉淀
   依赖全局：allSkills / builtinSkills / skillCategories（app.js 声明）、
            loadSkills / toast / replaceIcons / ico / activeSkill / inputBox / $ / esc
   ============================================================ */
"use strict";

/* ---------------- 市场面板的筛选状态 ----------------
   分类 chip / 搜索 / 排序。排序在浏览器里做而不是复用 /api/skills/all 的 list()：
   这一栏把内置工作流和市场技能并排展示，而后端的 list() 池子里没有内置项，
   只有客户端手里有全集时，一次排序的结果才是这一屏真正的顺序。 */
let skillCat = "";
let skillQuery = "";
let skillSort = "usage";

const SKILL_CMP = {
  usage: (a, b) => ((b.useCount || 0) - (a.useCount || 0)) || ((b.ts || 0) - (a.ts || 0)),
  rating: (a, b) => ((b.rating || 0) - (a.rating || 0)) || ((b.useCount || 0) - (a.useCount || 0)) || ((b.ts || 0) - (a.ts || 0)),
  recent: (a, b) => ((b.ts || 0) - (a.ts || 0)) || ((b.useCount || 0) - (a.useCount || 0)),
  name: (a, b) => String(a.name || "").localeCompare(String(b.name || ""), "zh"),
};

function skillPass(s) {
  if (skillCat && (s.category || "other") !== skillCat) return false;
  const q = skillQuery.trim().toLowerCase();
  if (!q) return true;
  const cat = s.category || "other";
  /* 搜的是屏上看得见的字：分类 chip 显示"重构"，那搜"重构"就该命中，
     不能逼用户去记池子里存的是 refactor 还是 backend。 */
  return ((s.name || "") + " " + cat + " " + (CAT_LABELS[cat] || "") + " " + (s.description || "") + " " + (s.tags || []).join(" ")).toLowerCase().includes(q);
}

function sortSkills(list) {
  return list.slice().sort(SKILL_CMP[skillSort] || SKILL_CMP.usage);
}

/* 描边星：评分是数据，不用 emoji 凑。filled 只影响填充色，描边始终保留，
   深色主题下实心星会糊成一块。 */
function starSvg(filled) {
  return '<svg class="ico sk-star' + (filled ? " on" : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z"/></svg>';
}

/* 分类英文 id → 中文标签；未知分类原样显示，不编一个错的中文名。 */
const CAT_LABELS = { frontend: "前端", backend: "后端", devops: "运维", test: "测试", refactor: "重构", security: "安全", perf: "性能", debug: "调试", config: "配置", workflow: "工作流", other: "其它" };

function paintSkillCats() {
  const host = $("skillCatChips");
  if (!host) return;
  const cats = skillCategories || {};
  const entries = Object.keys(cats).sort((a, b) => (cats[b] - cats[a]) || a.localeCompare(b, "zh"));
  const total = entries.reduce((n, c) => n + cats[c], 0);
  let html = '<button class="skm-cat' + (skillCat ? " on" : "") + '" data-cat="">全部 ' + total + "</button>";
  for (const c of entries) html += '<button class="skm-cat' + (skillCat === c ? " on" : "") + '" data-cat="' + esc(c) + '">' +
    esc(CAT_LABELS[c] || c) + " " + cats[c] + "</button>";
  host.innerHTML = html;
  host.querySelectorAll(".skm-cat").forEach((b) => {
    b.onclick = () => {
      skillCat = b.dataset.cat === skillCat ? "" : b.dataset.cat;
      renderSkillsList();
    };
  });
}

function renderSkillsList() {
  const marketBox = $("skillsList");
  const localBox = $("localSkillsList");
  const countEl = $("skillsCount");

  // 分离来源
  const userSkills = allSkills.filter((s) => s.source === "manual" || s.source === "import");
  const autoSkills = allSkills.filter((s) => s.source === "auto");

  paintSkillCats();

  const filtered = {
    builtin: sortSkills(builtinSkills.filter(skillPass)),
    user: sortSkills(userSkills.filter(skillPass)),
    auto: sortSkills(autoSkills.filter(skillPass)),
  };
  const shown = filtered.builtin.length + filtered.user.length + filtered.auto.length;
  const all = builtinSkills.length + userSkills.length + autoSkills.length;
  if (countEl) {
    /* 有筛选时把"命中/总数"都写出来：只显示一个数字，用户无从判断是自己筛掉了还是市场真没了 */
    countEl.textContent = (skillCat || skillQuery.trim())
      ? shown + " / " + all + " 个 Skill（已筛选）"
      : all + " 个 Skill";
  }

  const filtering = !!(skillCat || skillQuery.trim());
  const emptyHtml = filtering
    ? '<div class="scm-empty">' + t("skRenderSkillsListH43") + '<button type="button" class="skm-clear">' + t("skRenderSkillsListH44") + '</button></div>'
    : '<div class="scm-empty">' + t("skRenderSkillsListH45") + '</div>';

  // 市场 Skills（内置工作流 + 用户创建/导入）
  if (marketBox) {
    marketBox.innerHTML = "";
    if (filtered.builtin.length) {
      const wfTitle = document.createElement("div");
      wfTitle.className = "side-section-head";
      wfTitle.innerHTML = '<span style="font-size:11px;color:var(--text-dim)">' + t("skRenderSkillsListH46") + '</span>';
      marketBox.appendChild(wfTitle);
      filtered.builtin.forEach((s) => { marketBox.appendChild(makeSkillEl(s, "workflow")); });
    }
    if (filtered.user.length) {
      const uTitle = document.createElement("div");
      uTitle.className = "side-section-head";
      uTitle.innerHTML = '<span style="font-size:11px;color:var(--text-dim)">' + t("skRenderSkillsListH47") + '</span>';
      marketBox.appendChild(uTitle);
      filtered.user.forEach((s) => { marketBox.appendChild(makeSkillEl(s, "market")); });
    }
    if (!filtered.builtin.length && !filtered.user.length) marketBox.innerHTML = emptyHtml;
  }

  // 工作区 Skills（Agent 沉淀）
  if (localBox) {
    localBox.innerHTML = "";
    if (!filtered.auto.length) {
      localBox.innerHTML = '<div class="scm-empty">' + (filtering ? "工作区沉淀里没有匹配的 Skill。" : "Agent 自动沉淀的 Skill 会出现在这里。") + "</div>";
    } else {
      filtered.auto.forEach((s) => { localBox.appendChild(makeSkillEl(s, "local")); });
    }
  }
  const clear = marketBox && marketBox.querySelector(".skm-clear");
  if (clear) clear.onclick = () => {
    skillCat = ""; skillQuery = "";
    const inp = $("skillSearch"); if (inp) inp.value = "";
    renderSkillsList();
  };
  replaceIcons();
}

const CAT_COLORS = { frontend: "#4fc1ff", backend: "#4ec9b0", devops: "#c586c0", test: "#dcdcaa", refactor: "#ce9178", security: "#f48771", perf: "#cca700", debug: "#d16969", config: "#8a8a8a", workflow: "#0e639c", other: "#808080" };

function makeSkillEl(s, sourceType) {
  const el = document.createElement("div");
  el.className = "skill-item";
  /* data-* 不只是给样式用的：筛选与排序对不对，得能按"这一行到底是哪个分类/哪条技能"来断言，
     而不是拿界面文本正则凑（凑出来的断言在文案改动时会假绿）。 */
  el.dataset.cat = s.category || "other";
  el.dataset.name = s.name || "";
  el.dataset.src = sourceType || "";
  el.dataset.rating = String(Math.max(0, s.rating | 0));
  const catColor = CAT_COLORS[s.category] || "#808080";
  const riskBadge = s.risk_level === "P0" ? '<span class="sk-risk sk-risk-p0" title="' + escHtml(t("skRiskP0Tip")) + '">P0</span>'
    : s.risk_level === "P1" ? '<span class="sk-risk sk-risk-p1" title="' + escHtml(t("skRiskP1Tip")) + '">P1</span>' : "";
  const isBuiltin = s.source === "workflow";
  const isAuto = s.source === "auto";
  const srcTag = isBuiltin ? ' <span style="font-size:9px;color:var(--text-dim)">' + t("acPaintExpertstextT231") + '</span>' : (isAuto ? ' <span style="font-size:9px;color:var(--ok)">' + t("skMakeSkillElH48") + '</span>' : '');
  /* 评分与用量是这个面板里唯一的"哪个技能真的有用"信号，所以常驻显示而不是藏在详情里。
     两样都为 0（新技能）时整组不渲染，不给空数据占位。 */
  const uses = Math.max(0, s.useCount | 0), rate = Math.max(0, s.rating | 0);
  const statEl = (uses || rate)
    ? '<span class="skm-stat">' +
      (rate ? '<span class="skm-rate" title="' + escHtml(t("skmRateTip", { n: rate })) + '">' + starSvg(true) + rate + "</span>" : "") +
      (uses ? '<span class="skill-use" title="' + escHtml(t("skmUsesTip", { n: uses })) + '">' + t("skmUses", { n: uses }) + "</span>" : "") +
      "</span>"
    : "";
  const eyeIco = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const linkIco = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  const trashIco = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  el.innerHTML =
    '<div class="skill-ic" style="background:' + catColor + '">' + esc((s.name || "S")[0]) + '</div>' +
    '<div class="skill-meta"><div class="skill-name">' + esc(s.name) + riskBadge + srcTag + '</div>' +
    '<div class="skill-desc">' + esc(s.description || t("skmNoDesc")) + '</div></div>' +
    statEl +
    '<div class="skill-actions">' +
    '<button class="skill-view" title="' + escHtml(t("skillViewTip")) + '">' + eyeIco + '</button>' +
    '<button class="skill-ref" title="' + escHtml(t("skillRefTip")) + '">' + linkIco + '</button>' +
    (sourceType !== "workflow" ? '<button class="danger" title="' + escHtml(t("skillDelTip")) + '">' + trashIco + '</button>' : '') + '</div>';
  el.querySelector(".skill-view").onclick = (e) => { e.stopPropagation(); showSkillDetail(s); };
  el.querySelector(".skill-ref").onclick = (e) => { e.stopPropagation(); insertSkillToChat(s); };
  const delBtn = el.querySelector(".danger");
  if (delBtn) delBtn.onclick = (e) => { e.stopPropagation(); deleteSkill(s.id); };
  return el;
}

/* Skill 详情弹窗 */
function showSkillDetail(skill) {
  let modal = $("skillDetailModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "skillDetailModal";
    modal.style.cssText = "position:fixed;inset:0;background:#000000aa;z-index:var(--z-overlay);display:none;align-items:center;justify-content:center";
    modal.innerHTML = '<div class="set-box" style="max-width:560px;max-height:80vh;display:flex;flex-direction:column">' +
      '<div class="set-head"><span id="skillDetailTitle"></span><button id="skillDetailClose"><i data-ico="close"></i></button></div>' +
      '<div class="set-body" id="skillDetailBody" style="overflow-y:auto"></div>' +
      '</div>';
    document.body.appendChild(modal);
    $("skillDetailClose").onclick = () => { modal.style.display = "none"; };
  // Skill 详情弹窗只点 X 关闭
  }
  $("skillDetailTitle").innerHTML = '<i data-ico="sparkle"></i> ' + esc(skill.name);
  const catColor = CAT_COLORS[skill.category] || "#808080";
  let body = "";
  body += "<label style=\"display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px\">名称</label><input id=\"sdName\" type=\"text\" value=\"" + esc(skill.name) + "\" style=\"width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px;margin-bottom:8px\">";
  body += "<label style=\"display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px\">描述</label><input id=\"sdDesc\" type=\"text\" value=\"" + esc(skill.description || "") + "\" style=\"width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px;margin-bottom:8px\">";
  body += "<div style=\"display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px\">";
  body += "<span style=\"font-size:10px;padding:2px 8px;border-radius:8px;background:" + catColor + "22;color:" + catColor + ";border:1px solid " + catColor + "44\">" + esc(CAT_LABELS[skill.category] || skill.category || "other") + "</span>";
  if (skill.tags && skill.tags.length) skill.tags.forEach((t) => { body += "<span style=\"font-size:10px;padding:2px 6px;border-radius:8px;background:var(--bg4);color:var(--text-dim)\">" + esc(t) + "</span>"; });
  body += "</div>";
  /* 评分行。内置项只给说明不给星星——它的落点是内存视图，点了会"看起来成功了"然后重启即失，
     那种假勾比没有这个功能更糟。 */
  const builtinEdit = skill.source === "workflow" || /^wf_|^builtin_/.test(skill.id || "");
  const cur = Math.max(0, skill.rating | 0);
  body += '<div class="skm-rate-row"><span class="skm-rate-label">' + t("skShowSkillDetailH49") + '</span><span class="skm-stars-pick" id="sdStars">' +
    [1, 2, 3, 4, 5].map((i) => '<button type="button" data-v="' + i + '"' + (builtinEdit ? " disabled" : "") +
      ' title="' + escHtml(t("starNtip", { n: i }) + (i === cur && !builtinEdit ? t("starAgainTip") : "")) + '">' + starSvg(i <= cur) + "</button>").join("") +
    '</span><span class="skm-rate-val" id="sdRateVal">' + (cur ? cur + " / 5" : t("skmUnrated")) + "</span></div>";
  if (builtinEdit) body += '<div class="skm-rate-hint">' + t("skShowSkillDetailH50") + '</div>';
  body += "<label style=\"display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px\">触发关键词</label><input id=\"sdTrigger\" type=\"text\" value=\"" + esc(skill.trigger || "") + "\" style=\"width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px;margin-bottom:8px\">";
  body += "<label style=\"display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px\">内容（Markdown）</label>";
  body += "<textarea id=\"sdBody\" rows=\"10\" style=\"width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text);font-size:12px;line-height:1.6;font-family:var(--mono);resize:vertical;outline:none\">" + esc(skill.body || "") + "</textarea>";
  body += "<div style=\"display:flex;gap:8px;margin-top:12px;justify-content:flex-end\">";
  /* 内置项随安装包走，就地改了下次升级就被覆盖——所以按钮说的是"另存"，不是"保存"。
     以前这里对所有技能都写「保存修改」，而 PUT 打到内置 id 上必然 404「Skill 不存在」，
     用户看到的就是"改完保存说不存在"。 */
  body += "<button id=\"skillDetailSave\" class=\"set-btn\" style=\"background:var(--ok);color:#000\">" + (builtinEdit ? "另存为我的技能" : "保存修改") + "</button>";
  body += "<button id=\"skillDetailRef\" class=\"set-btn\" style=\"background:var(--accent);color:#fff\">引用到对话</button>";
  body += "</div>";
  $("skillDetailBody").innerHTML = body;
  replaceIcons(modal);
  $("skillDetailRef").onclick = () => { modal.style.display = "none"; insertSkillToChat(skill); };
  $("skillDetailSave").onclick = async () => {
    const patch = {
      name: $("sdName").value.trim(),
      description: $("sdDesc").value.trim(),
      trigger: $("sdTrigger").value.trim(),
      body: $("sdBody").value.trim(),
      category: skill.category || "other",
    };
    try {
      const url = skill.id ? "/api/skills/market/" + encodeURIComponent(skill.id) : "/api/skills/market";
      const r = await fetch(url, {
        method: skill.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      }).then((x) => x.json());
      if (r.ok) {
        toast(r.forked ? t("skShowSkillDetailtoastT98") : t("skillSaved"));
        if (r.forked && activeSkill && activeSkill.id === skill.id) activeSkill = r.skill;
        modal.style.display = "none"; loadSkills();
      } else toast(t("skShowSkillDetailtoastT99") + r.error);
    } catch (e) { toast(t("skPainttextContentT138") + e.message); }
  };
  if (!builtinEdit) {
    const host = $("sdStars");
    host.querySelectorAll("button").forEach((b) => {
      b.onclick = () => {
        const v = Number(b.dataset.v);
        rateSkill(skill, (skill.rating | 0) === v ? 0 : v, host);
      };
    });
  }
  modal.style.display = "flex";
}

/* 评分立刻 POST：只改内存的话，关掉弹窗或刷新就丢了，而用户看到的是"我已经点过星了"。 */
async function rateSkill(skill, value, host) {
  try {
    const r = await fetch("/api/skills/market/" + encodeURIComponent(skill.id) + "/rate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating: value }),
    }).then((x) => x.json());
    if (!r.ok) { toast(r.error || t("skShowSkillDetailtoastT100")); return; }
    skill.rating = value;
    if (host) host.querySelectorAll("button").forEach((b) => { b.innerHTML = starSvg(Number(b.dataset.v) <= value); });
    const val = $("sdRateVal");
    if (val) val.textContent = value ? value + " / 5" : "未评分";
    toast(value ? t("skShowSkillDetailtoastT101") + value + " / 5" : t("marateSkillC36"));
    loadSkills();
  } catch (e) { toast(t("skPainttextContentT138") + e.message); }
}

function insertSkillToChat(skill) {
  // 只记住"这一局用哪个技能"，正文由服务端在发送时注入上下文
  activeSkill = skill;
  const tag = inputBox.querySelector("#ciSkillActive");
  if (tag) {
    tag.style.display = "inline-flex";
    tag.innerHTML = '<i data-ico="sparkle"></i>' + esc(skill.name) + '<span class="ci-skill-x">×</span>';
    replaceIcons(tag);
    tag.querySelector(".ci-skill-x").onclick = () => { activeSkill = null; tag.style.display = "none"; };
  }
  // 关闭弹出框
  const pop = inputBox.querySelector("#ciSkillPop");
  if (pop) pop.style.display = "none";
  toast(t("skInsertSkillToChattoastT102") + skill.name + t("mainsertSkillToChatC37"));
}

/* Skill 选择器弹出列表（按来源分组：内置 / 创建 / 沉淀，支持搜索 + 滚动） */
function renderSkillPop() {
  const pop = inputBox.querySelector("#ciSkillPop");
  if (!pop) return;

  const builtin = builtinSkills || [];
  const userSkills = (allSkills || []).filter((s) => s.source === "manual" || s.source === "import");
  const autoSkills = (allSkills || []).filter((s) => s.source === "auto");

  pop.innerHTML = "";

  // 顶部搜索框（sticky）
  const head = document.createElement("div");
  head.className = "ci-skill-pop-head";
  head.innerHTML = '<input id="ciSkillSearch" type="text" placeholder="' + escHtml(t("ciSkillSearchPh")) + '" ' +
    'style="width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px;outline:none">';
  pop.appendChild(head);

  const listWrap = document.createElement("div");
  pop.appendChild(listWrap);

  function paint(filter) {
    const q = (filter || "").trim().toLowerCase();
    listWrap.innerHTML = "";
    const groups = [
      { title: t("builtinWorkflow"), list: builtin },
      { title: t("userSkills"), list: userSkills },
      { title: t("skPainttitleT79"), list: autoSkills },
    ];
    let shown = 0;
    groups.forEach((g) => {
      /* 分类彩色 chip 也参与匹配，且要能按界面上看得见的那个中文标签搜——
         列表里显示"重构"，用户就只能搜"重构"，让他去记 backend/refactor 是刁难。 */
      const items = q ? g.list.filter((s) => {
        const cat = s.category || "other";
        return (s.name + " " + cat + " " + (CAT_LABELS[cat] || "") + " " + (s.description || "")).toLowerCase().includes(q);
      }) : g.list;
      if (!items.length) return;
      const gt = document.createElement("div");
      gt.className = "ci-skill-group-title";
      gt.textContent = g.title + "（" + items.length + "）";
      listWrap.appendChild(gt);
      items.forEach((s) => {
        const el = document.createElement("div");
        el.className = "ci-skill-opt";
        const catColor = CAT_COLORS[s.category] || "#808080";
        const catLabel = CAT_LABELS[s.category] || s.category || "other";
        el.innerHTML =
          '<span class="ci-skill-opt-cat" style="background:' + catColor + '">' + esc(catLabel) + '</span>' +
          '<span class="ci-skill-opt-name" title="' + esc(s.description || "") + '">' + esc(s.name) + '</span>';
        el.onclick = () => insertSkillToChat(s);
        listWrap.appendChild(el);
        shown++;
      });
    });
    if (!shown) listWrap.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:12px">' + t("skPaintH51") + '</div>';
  }

  paint("");
  const searchInput = head.querySelector("#ciSkillSearch");
  searchInput.addEventListener("input", (e) => paint(e.target.value));
  setTimeout(() => searchInput.focus(), 50);
}

async function deleteSkill(id) {
  if (!confirm(t("skPaintconfirmT103"))) return;
  try {
    await fetch("/api/skills/market/" + id, { method: "DELETE" });
    toast(t("skillDeleted"));
    loadSkills();
  } catch (e) {}
}

// 新建 Skill 弹窗
$("btnNewSkill").onclick = () => { $("skillModal").style.display = "flex"; $("skillStatus").textContent = ""; $("skillName").value = ""; $("skillDesc").value = ""; $("skillTrigger").value = ""; $("skillBody").value = ""; };
$("skillClose").onclick = () => ($("skillModal").style.display = "none");
// Skill 创建弹窗只点 X 关闭

$("skillSave").onclick = async () => {
  const body = {
    name: $("skillName").value.trim(),
    description: $("skillDesc").value.trim(),
    category: $("skillCategory").value,
    trigger: $("skillTrigger").value.trim(),
    body: $("skillBody").value.trim(),
  };
  if (!body.name || !body.body) { $("skillStatus").className = "set-status err"; $("skillStatus").textContent = t("nameCantEmpty"); return; }
  try {
    const r = await fetch("/api/skills/market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.ok) {
      $("skillStatus").className = "set-status ok";
      $("skillStatus").textContent = t("skPainttextContentT80");
      toast(t("skillCreated"));
      loadSkills();
      setTimeout(() => ($("skillModal").style.display = "none"), 800);
    } else { $("skillStatus").className = "set-status err"; $("skillStatus").textContent = r.error; }
  } catch (e) { $("skillStatus").className = "set-status err"; $("skillStatus").textContent = t("skPainttextContentT138") + e.message; }
};

// 导入 Skill JSON
$("btnImportSkill").onclick = () => {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = ".json";
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    try {
      const text = await file.text();
      const skill = JSON.parse(text);
      const doImport = (extra) => fetch("/api/skills/market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({}, skill, extra || {})) }).then((x) => x.json());
      const r = await doImport();
      if (r.ok) { toast(t("skPainttoastT104") + skill.name + (r.audit && r.audit.level === "P1" ? t("madeleteSkillC38") : "")); loadSkills(); }
      else if (r.audit && r.audit.findings) {
        // W1：P0 风险 → 展示审计报告，用户显式确认后 force 重发
        const rows = r.audit.findings.map((f) => "· <b style='color:var(--err)'>" + esc(f.level) + "</b> " + esc(f.desc)).join("<br>");
        showConfirm("安全审计：该 Skill 存在 P0 风险",
          "以下内容将被注入 Agent 上下文并可能被 AI 参考执行，请确认你信任该来源：<br><br>" + rows + "<br><br><span style='color:var(--text-dim)'>确认后将以「已知晓风险」标记导入。</span>",
          async () => {
            const r2 = await doImport({ force: true });
            if (r2.ok) { toast(t("skPainttoastT105") + skill.name); loadSkills(); }
            else toast(t("skPainttoastT106") + (r2.error || ""));
          });
      }
      else toast(t("skPainttoastT106") + r.error);
    } catch (e) { toast(t("jsonError")); }
  };
  inp.click();
};

// 市场面板的搜索 / 排序。搜索走本地：这一屏的数据已经全在内存里，回后端只会多一次往返和一次闪烁。
const skSearchEl = $("skillSearch");
if (skSearchEl) skSearchEl.addEventListener("input", () => { skillQuery = skSearchEl.value; renderSkillsList(); });
const skSortEl = $("skillSort");
if (skSortEl) {
  skSortEl.querySelectorAll("button").forEach((b) => {
    b.onclick = () => {
      skillSort = b.dataset.sort;
      skSortEl.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      renderSkillsList();
    };
  });
}

// 切换到 Skills 面板时加载
function onSkillsViewActive() {
  loadSkills();
}
