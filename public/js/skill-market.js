/* ============================================================
   pancode Skill 市场 / 选择器 / 沉淀
   依赖全局：allSkills / builtinSkills（app.js 声明）、loadSkills / toast /
            replaceIcons / ico / activeSkill / inputBox / $ / esc（运行时解析）
   ============================================================ */
"use strict";

function renderSkillsList() {
  const marketBox = $("skillsList");
  const localBox = $("localSkillsList");
  const countEl = $("skillsCount");

  // 分离来源
  const userSkills = allSkills.filter((s) => s.source === "manual" || s.source === "import");
  const autoSkills = allSkills.filter((s) => s.source === "auto");

  if (countEl) countEl.textContent = (userSkills.length + autoSkills.length + builtinSkills.length) + " 个 Skill";

  // 市场 Skills（用户创建/导入）
  if (marketBox) {
    marketBox.innerHTML = "";
    // 内置 Workflow
    if (builtinSkills.length) {
      const wfTitle = document.createElement("div");
      wfTitle.className = "side-section-head";
      wfTitle.innerHTML = '<span style="font-size:11px;color:var(--text-dim)">内置工作流</span>';
      marketBox.appendChild(wfTitle);
      builtinSkills.forEach((s) => { marketBox.appendChild(makeSkillEl(s, "workflow")); });
    }
    // 用户创建
    if (userSkills.length) {
      const uTitle = document.createElement("div");
      uTitle.className = "side-section-head";
      uTitle.innerHTML = '<span style="font-size:11px;color:var(--text-dim)">用户创建</span>';
      marketBox.appendChild(uTitle);
      userSkills.forEach((s) => { marketBox.appendChild(makeSkillEl(s, "market")); });
    }
    if (!builtinSkills.length && !userSkills.length) {
      marketBox.innerHTML = '<div class="scm-empty">暂无 Skills。点击 + 创建或导入。</div>';
    }
  }

  // 工作区 Skills（Agent 沉淀）
  if (localBox) {
    localBox.innerHTML = "";
    if (!autoSkills.length) {
      localBox.innerHTML = '<div class="scm-empty">Agent 自动沉淀的 Skill 会出现在这里。</div>';
    } else {
      autoSkills.forEach((s) => { localBox.appendChild(makeSkillEl(s, "local")); });
    }
  }
  replaceIcons();
}

const CAT_COLORS = { frontend: "#4fc1ff", backend: "#4ec9b0", devops: "#c586c0", test: "#dcdcaa", refactor: "#ce9178", security: "#f48771", perf: "#cca700", debug: "#d16969", config: "#8a8a8a", workflow: "#0e639c", other: "#808080" };

function makeSkillEl(s, sourceType) {
  const el = document.createElement("div");
  el.className = "skill-item";
  const catColor = CAT_COLORS[s.category] || "#808080";
  const riskBadge = s.risk_level === "P0" ? '<span class="sk-risk sk-risk-p0" title="安全审计 P0：含任意执行/破坏性操作，导入时已显式确认">P0</span>'
    : s.risk_level === "P1" ? '<span class="sk-risk sk-risk-p1" title="安全审计 P1：含网络请求/提权/全局安装">P1</span>' : "";
  const isBuiltin = s.source === "workflow";
  const isAuto = s.source === "auto";
  const srcTag = isBuiltin ? ' <span style="font-size:9px;color:var(--text-dim)">内置</span>' : (isAuto ? ' <span style="font-size:9px;color:var(--ok)">沉淀</span>' : '');
  const eyeIco = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const linkIco = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  const trashIco = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  el.innerHTML =
    '<div class="skill-ic" style="background:' + catColor + '">' + esc((s.name || "S")[0]) + '</div>' +
    '<div class="skill-meta"><div class="skill-name">' + esc(s.name) + riskBadge + srcTag + '</div>' +
    '<div class="skill-desc">' + esc(s.description || "无描述") + '</div></div>' +
    '<div class="skill-actions">' +
    '<button class="skill-view" title="查看详情">' + eyeIco + '</button>' +
    '<button class="skill-ref" title="引用到对话">' + linkIco + '</button>' +
    (sourceType !== "workflow" ? '<button class="danger" title="删除">' + trashIco + '</button>' : '') + '</div>';
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
  body += "<span style=\"font-size:10px;padding:2px 8px;border-radius:8px;background:" + catColor + "22;color:" + catColor + ";border:1px solid " + catColor + "44\">" + esc(skill.category || "other") + "</span>";
  if (skill.tags && skill.tags.length) skill.tags.forEach((t) => { body += "<span style=\"font-size:10px;padding:2px 6px;border-radius:8px;background:var(--bg4);color:var(--text-dim)\">" + esc(t) + "</span>"; });
  body += "</div>";
  body += "<label style=\"display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px\">触发关键词</label><input id=\"sdTrigger\" type=\"text\" value=\"" + esc(skill.trigger || "") + "\" style=\"width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px;margin-bottom:8px\">";
  body += "<label style=\"display:block;font-size:12px;color:var(--text-dim);margin-bottom:4px\">内容（Markdown）</label>";
  body += "<textarea id=\"sdBody\" rows=\"10\" style=\"width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text);font-size:12px;line-height:1.6;font-family:var(--mono);resize:vertical;outline:none\">" + esc(skill.body || "") + "</textarea>";
  body += "<div style=\"display:flex;gap:8px;margin-top:12px;justify-content:flex-end\">";
  /* 内置项随安装包走，就地改了下次升级就被覆盖——所以按钮说的是"另存"，不是"保存"。
     以前这里对所有技能都写「保存修改」，而 PUT 打到内置 id 上必然 404「Skill 不存在」，
     用户看到的就是"改完保存说不存在"。 */
  const builtinEdit = skill.source === "workflow" || /^wf_|^builtin_/.test(skill.id || "");
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
        toast(r.forked ? "已另存为我的技能（内置那份没动，改的是副本）" : "Skill 已保存");
        if (r.forked && activeSkill && activeSkill.id === skill.id) activeSkill = r.skill;
        modal.style.display = "none"; loadSkills();
      } else toast("保存失败: " + r.error);
    } catch (e) { toast("请求异常: " + e.message); }
  };
  modal.style.display = "flex";
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
  toast("已选用 Skill：" + skill.name + "（直接说你要做什么就行）");
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
  head.innerHTML = '<input id="ciSkillSearch" type="text" placeholder="搜索 Skill 名称 / 描述…" ' +
    'style="width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:6px 8px;color:var(--text);font-size:12px;outline:none">';
  pop.appendChild(head);

  const listWrap = document.createElement("div");
  pop.appendChild(listWrap);

  function paint(filter) {
    const q = (filter || "").trim().toLowerCase();
    listWrap.innerHTML = "";
    const groups = [
      { title: "内置工作流", list: builtin },
      { title: "用户创建", list: userSkills },
      { title: "工作区沉淀（Agent 自动）", list: autoSkills },
    ];
    let shown = 0;
    groups.forEach((g) => {
      // 分类彩色 chip 也参与匹配：列表里看得见的字段，搜索就该搜得到
      const items = q ? g.list.filter((s) => (s.name + " " + (s.category || "") + " " + (s.description || "")).toLowerCase().includes(q)) : g.list;
      if (!items.length) return;
      const gt = document.createElement("div");
      gt.className = "ci-skill-group-title";
      gt.textContent = g.title + "（" + items.length + "）";
      listWrap.appendChild(gt);
      items.forEach((s) => {
        const el = document.createElement("div");
        el.className = "ci-skill-opt";
        const catColor = CAT_COLORS[s.category] || "#808080";
        el.innerHTML =
          '<span class="ci-skill-opt-cat" style="background:' + catColor + '">' + esc(s.category || "other") + '</span>' +
          '<span class="ci-skill-opt-name" title="' + esc(s.description || "") + '">' + esc(s.name) + '</span>';
        el.onclick = () => insertSkillToChat(s);
        listWrap.appendChild(el);
        shown++;
      });
    });
    if (!shown) listWrap.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:12px">没有匹配的 Skill</div>';
  }

  paint("");
  const searchInput = head.querySelector("#ciSkillSearch");
  searchInput.addEventListener("input", (e) => paint(e.target.value));
  setTimeout(() => searchInput.focus(), 50);
}

async function deleteSkill(id) {
  if (!confirm("确定删除此 Skill？")) return;
  try {
    await fetch("/api/skills/market/" + id, { method: "DELETE" });
    toast("已删除");
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
  if (!body.name || !body.body) { $("skillStatus").className = "set-status err"; $("skillStatus").textContent = "名称和内容不能为空"; return; }
  try {
    const r = await fetch("/api/skills/market", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
    if (r.ok) {
      $("skillStatus").className = "set-status ok";
      $("skillStatus").textContent = "已保存到 Skills 市场";
      toast("Skill 已创建");
      loadSkills();
      setTimeout(() => ($("skillModal").style.display = "none"), 800);
    } else { $("skillStatus").className = "set-status err"; $("skillStatus").textContent = r.error; }
  } catch (e) { $("skillStatus").className = "set-status err"; $("skillStatus").textContent = "请求异常: " + e.message; }
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
      if (r.ok) { toast("已导入：" + skill.name + (r.audit && r.audit.level === "P1" ? "（含 P1 风险警告，已在详情标注）" : "")); loadSkills(); }
      else if (r.audit && r.audit.findings) {
        // W1：P0 风险 → 展示审计报告，用户显式确认后 force 重发
        const rows = r.audit.findings.map((f) => "· <b style='color:var(--err)'>" + esc(f.level) + "</b> " + esc(f.desc)).join("<br>");
        showConfirm("安全审计：该 Skill 存在 P0 风险",
          "以下内容将被注入 Agent 上下文并可能被 AI 参考执行，请确认你信任该来源：<br><br>" + rows + "<br><br><span style='color:var(--text-dim)'>确认后将以「已知晓风险」标记导入。</span>",
          async () => {
            const r2 = await doImport({ force: true });
            if (r2.ok) { toast("已确认风险并导入：" + skill.name); loadSkills(); }
            else toast("导入失败：" + (r2.error || ""));
          });
      }
      else toast("导入失败：" + r.error);
    } catch (e) { toast("JSON 格式错误"); }
  };
  inp.click();
};

// 切换到 Skills 面板时加载
function onSkillsViewActive() {
  loadSkills();
}
