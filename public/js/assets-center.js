/* ============================================================
   pancode Agent 资产中心（T4）
   「角色设定 / 灵魂 / 记忆 / 沉淀 / 规则 / 技能 / 进化 / 自动化 / 审计」可视化增删改查，
   分区注册进 workbench.js 的左侧导航，写操作直接打 /api/*。
   依赖全局：$ / esc / ico / toast / replaceIcons / wb* 原语 / collectConvTurns
   ============================================================ */
"use strict";

/* ---------------- 布局与请求原语 ---------------- */
function wbSplit(box, toolbar) {
  const wrap = wbEl("div", "wb-split");
  const left = wbEl("div", "wb-side");
  const right = wbEl("div", "wb-detail");
  if (toolbar) left.appendChild(toolbar);
  const list = wbEl("div", "wb-side-list");
  left.appendChild(list);
  wrap.appendChild(left);
  wrap.appendChild(right);
  box.appendChild(wrap);
  return { wrap, list, detail: right };
}
function wbSideItem(o) {
  const it = wbEl("button", "wb-side-item" + (o.active ? " active" : ""));
  it.type = "button";
  const top = wbEl("div", "wb-side-top");
  /* 列表里的名字/副标题/徽标既可能是随包发行的默认值（内置专家、进化阶段），也可能是用户自己的数据。
     tr() 只翻字典里有的中文，用户内容原样通过 —— 不用在两处各维护一份"这是不是文案"的判断。 */
  top.appendChild(wbEl("span", "wb-side-name", esc(tr(o.title))));
  (o.badges || []).forEach((b) => top.appendChild(wbEl("span", "wb-badge " + (b.cls || "wb-badge-dim"), esc(tr(b.text)))));
  it.appendChild(top);
  if (o.sub) it.appendChild(wbEl("div", "wb-side-sub", esc(tr(o.sub))));
  if (o.bar != null) {
    const bar = wbEl("div", "wb-bar");
    const fill = wbEl("i");
    fill.style.width = Math.max(2, Math.min(100, o.bar)) + "%";
    if (o.barCls) fill.className = o.barCls;
    bar.appendChild(fill);
    it.appendChild(bar);
  }
  if (o.on) it.onclick = o.on;
  return it;
}
function wbHead(title, desc) {
  const h = wbEl("div", "wb-detail-head");
  h.appendChild(wbEl("h3", "", esc(tr(title))));
  if (desc) h.appendChild(wbEl("p", "", esc(tr(desc))));
  return h;
}
function wbEmpty(text) { return wbEl("div", "wb-detail-empty", esc(text)); }
function wbToolbar(placeholder, onSearch, actions) {
  const bar = wbEl("div", "wb-toolbar");
  const s = wbEl("input", "wb-input wb-toolbar-search");
  s.placeholder = placeholder || "筛选…";
  let timer = null;
  s.oninput = () => { clearTimeout(timer); timer = setTimeout(() => onSearch(s.value.trim().toLowerCase()), 120); };
  bar.appendChild(s);
  (actions || []).forEach((a) => {
    const b = wbEl("button", "wb-btn" + (a.primary ? " wb-btn-primary" : ""), esc(a.text));
    b.type = "button";
    b.onclick = () => a.run(b);
    bar.appendChild(b);
  });
  return bar;
}
function wbStats(pairs) {
  const strip = wbEl("div", "wb-stats");
  pairs.forEach((pr) => {
    const it = wbEl("div", "wb-stat");
    it.appendChild(wbEl("b", "", String(pr[1] == null ? 0 : pr[1])));
    it.appendChild(wbEl("span", "", pr[0]));
    strip.appendChild(it);
  });
  return strip;
}
function wbBtn(text, cls, fn) {
  const b = wbEl("button", "wb-btn " + (cls || ""), esc(text));
  b.type = "button";
  b.onclick = () => fn(b);
  return b;
}
/* 统一 JSON 取回：非 JSON（401 的 HTML 登录页 / 网关错误页）不再抛 "Unexpected token <"，
   而是给出人话；401 单独打标，调用点可提示"登录态失效"而不是"加载失败"。 */
async function wbJson(res) {
  const text = await res.text();
  let j = null;
  if (res.status === 404) {
    // 404 不是登录问题：是运行中的后端根本没有这个接口（进程比界面旧）。
    // 早先把它归到"请重新登录"，用户照着登出登录一遍，问题一点没变。
    const err = new Error("后端没有这个接口（HTTP 404）");
    err.missing = true;
    throw err;
  }
  try { j = text ? JSON.parse(text) : {}; }
  catch (e) {
    throw new Error(res.status === 401 ? "登录态已失效，请重新登录后再试" : "服务返回了非 JSON 内容（HTTP " + res.status + "）");
  }
  if (res.status === 401) { const err = new Error("登录态已失效，请重新登录后再试"); err.unauthorized = true; throw err; }
  return j == null ? {} : j;
}
const wbGet = (url) => fetch(url).then(wbJson);
const wbPost = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) }).then(wbJson);
const wbPut = (url, body) => fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(wbJson);
const wbDel = (url, body) => fetch(url, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: body == null ? undefined : JSON.stringify(body) }).then(wbJson);
/* 加载失败绝不允许留下空白双栏：左列表写原因、右详情写下一步。
   用户看到两个空框只会判定"这个功能坏了"，而真实原因往往是登录态过期或接口 500。 */
function wbLoadError(list, detail, e) {
  const msg = (e && e.unauthorized ? "" : "加载失败：") + String((e && e.message) || e || "接口无响应");
  if (list) { list.innerHTML = ""; list.appendChild(wbEl("div", "wb-list-empty wb-list-err", msg)); }
  if (detail) {
    detail.innerHTML = "";
    detail.appendChild(wbEl("div", "wb-detail-empty",
      e && e.missing
        ? "运行中的后端没有这个接口——服务进程比界面旧。重启 pancode 服务（npm start，或重新打包桌面端）后重开设置即可；光刷新页面没用。"
        : (e && e.unauthorized ? "登录态已失效。" : "接口没有返回数据。") + "点顶栏用户名重新登录，或关掉设置重开一次。"));
  }
  return msg;
}
function wbShowPreview(host, text) {
  let pre = host.querySelector(":scope > .wb-preview");
  if (!pre) { pre = wbEl("pre", "wb-preview"); host.appendChild(pre); }
  pre.textContent = text == null || text === "" ? "（空）" : text;
  pre.style.display = "block";
}
/* 字段行：input / textarea / select */
function wbField(host, label, desc, value, kind, onChange) {
  const row = wbRow(label, desc); const ctrl = row.ctrl;
  let inp;
  if (kind === "area") { inp = wbEl("textarea", "wb-textarea"); inp.rows = 6; }
  else if (kind && kind.select) {
    inp = wbEl("select", "wb-select wb-select-wide");
    kind.select.forEach((v) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = (kind.labels && kind.labels[v]) || v;
      inp.appendChild(o);
    });
  } else {
    inp = wbEl("input", "wb-input wb-input-wide");
    if (kind === "number") { inp.type = "number"; inp.min = 1; inp.max = 5; }
  }
  inp.value = value == null ? "" : value;
  const evt = kind && kind.select ? "onchange" : "oninput";
  inp[evt] = () => onChange(kind === "number" ? Number(inp.value) : inp.value);
  ctrl.appendChild(inp);
  host.appendChild(row);
  return inp;
}

/* ============================================================
   角色与专家
   ============================================================ */
const EXP = { rows: [], active: "default", customPrompt: "", picked: null, q: "" };
async function wbRenderExperts(box) {
  box.innerHTML = "";
  let r;
  try { r = await wbGet("/api/experts"); } catch (e) { box.appendChild(wbNote(t("acFieldwbNoteT1") + e.message, "err")); return; }
  if (!r.ok) { box.appendChild(wbNote(r.error || t("acFieldwbNoteT228"), "err")); return; }
  EXP.rows = r.experts; EXP.active = r.active; EXP.customPrompt = r.customPrompt || "";
  box.appendChild(wbStats([
    [t("statTotal"), r.experts.length],
    [t("statBuiltin"), r.experts.filter((x) => x.builtin).length],
    [t("statUserCreated"), r.experts.filter((x) => !x.builtin).length],
    [t("statCurrent"), EXP.active === "custom" ? t("personaCustom") : EXP.active === "default" ? t("statNone") : tr(EXP.active)],
  ]));
  const { list, detail } = wbSplit(box, wbToolbar(t("acFieldwbToolbarT2"), (q) => { EXP.q = q; paintExperts(); }, [
    { text: t("acFieldtextT229"), primary: true, run: () => { EXP.picked = "__new__"; paintExperts(); } },
  ]));
  EXP._list = list; EXP._detail = detail;
  paintExperts();
}
function paintExperts() {
  const list = EXP._list, detail = EXP._detail;
  if (!list) return;
  list.innerHTML = "";
  const rows = EXP.q ? EXP.rows.filter((e) => (e.name + " " + (e.description || "")).toLowerCase().includes(EXP.q)) : EXP.rows;
  if (!rows.length) list.appendChild(wbEl("div", "wb-list-empty", t("acPaintExpertswbElT230")));
  rows.forEach((e) => {
    list.appendChild(wbSideItem({
      title: e.name,
      active: EXP.picked === e.id,
      badges: [
        e.active ? { text: t("wbWtAddRowwbKVT59"), cls: "wb-badge-ok" } : null,
        e.builtin ? { text: t("acPaintExpertstextT231") } : { text: e.source === "user" ? t("scopeUser") : t("scopeProject"), cls: "wb-badge-blue" },
        (e.unknownTools || []).length ? { text: t("acPaintExpertstextT232"), cls: "wb-badge-warn" } : null,
      ].filter(Boolean),
      sub: (e.description || "（无描述）").slice(0, 46),
      on: () => { EXP.picked = e.id; paintExperts(); },
    }));
  });
  if (EXP.picked === "__new__") expertForm(detail, null);
  else if (EXP.picked) expertForm(detail, EXP.rows.find((x) => x.id === EXP.picked) || null);
  else expertCurrentRole(detail);
}
async function applyExpertsResp(r) {
  if (!r.ok) { wbSaved(r.error || t("apOnOrchStepFailtextContentT55"), true); return false; }
  if (r.experts) EXP.rows = r.experts;
  if (r.active) EXP.active = r.active;
  if (r.customPrompt != null) EXP.customPrompt = r.customPrompt;
  paintExperts();
  return true;
}
/* 右侧默认页：当前常驻角色 */
function expertCurrentRole(detail) {
  detail.innerHTML = "";
  detail.appendChild(wbHead(t("acExpertCurrentRolewbHeadT3"), t("acExpertCurrentRolewbHeadT4")));
  detail.appendChild(wbSeg(t("acExpertCurrentRolewbSegT233"), "",
    [{ v: "default", t: t("acExpertCurrentRoletT234") }, { v: "custom", t: t("acExpertCurrentRoletT235") }]
      .concat(EXP.rows.map((e) => ({ v: e.id, t: tr(e.name) }))),
    EXP.active, async (v) => {
      const r = await wbPost("/api/experts/active", { active: v });
      if (!await applyExpertsResp(r)) return;
      wbSaved(t("acExpertCurrentRolewbSavedT1"));
    }, "persona role active 角色"));
  wbField(detail, t("acExpertCurrentRolewbFieldT5"), t("acExpertCurrentRolewbFieldT6"), EXP.customPrompt, "area", (v) => { EXP.customPrompt = v; });
  const acts = wbEl("div", "wb-detail-actions");
  acts.appendChild(wbBtn(t("acExpertCurrentRolewbBtnT7"), "wb-btn-primary", async () => {
    const r = await wbPost("/api/experts/active", { active: "custom", systemPrompt: EXP.customPrompt });
    if (await applyExpertsResp(r)) wbSaved(t("acExpertCurrentRolewbSavedT2"));
  }));
  acts.appendChild(wbBtn(t("acExpertCurrentRolewbBtnT8"), "", async () => {
    const r = await wbGet("/api/experts/preview?" + (EXP.active === "custom" ? "custom=" + encodeURIComponent(EXP.customPrompt) : "id=" + encodeURIComponent(EXP.active)));
    wbShowPreview(detail, r.preview || t("acExpertCurrentRolewbShowPreviewT3"));
  }));
  detail.appendChild(acts);
  detail.appendChild(wbNote(t("acExpertCurrentRolewbNoteT236"), "dim"));
}
function expertForm(detail, e) {
  detail.innerHTML = "";
  const isNew = !e;
  const f = e ? {
    name: e.name, description: e.description || "", role: e.role || "", methodology: e.methodology || "",
    tool_whitelist: (e.tool_whitelist || []).join(", "), scope: e.source === "user" ? "user" : "project",
  } : { name: "", description: "", role: "", methodology: "", tool_whitelist: "", scope: "project" };
  detail.appendChild(wbHead(isNew ? t("acExpertFormwbHeadT9") : e.name, isNew ? t("acExpertFormwbHeadT10") : (e.builtin ? t("acExpertFormwbHeadT4") : (e.source === "user" ? t("acExpertFormwbHeadT5") : t("ceexpertFormC3")))));
  if (e && e.unknownTools && e.unknownTools.length) {
    detail.appendChild(wbNote(t("acExpertFormwbNoteT11") + e.unknownTools.length + t("acExpertFormwbNoteT6") + e.unknownTools.join(", ") + t("ceexpertFormC50"), "warn"));
  }
  if (e && e.builtin) detail.appendChild(wbNote(t("acExpertFormwbNoteT238"), "dim"));
  wbField(detail, t("ecOpenSoulEditorH78"), t("acExpertFormwbFieldT12"), f.name, "text", (v) => { f.name = v; });
  wbField(detail, t("acExpertFormwbFieldT13"), t("acExpertFormwbFieldT14"), f.description, "text", (v) => { f.description = v; });
  wbField(detail, t("acExpertFormwbFieldT15"), t("acExpertFormwbFieldT16"), f.role, "area", (v) => { f.role = v; });
  wbField(detail, t("acExpertFormwbFieldT17"), t("acExpertFormwbFieldT18"), f.methodology, "area", (v) => { f.methodology = v; });
  wbField(detail, t("acExpertFormwbFieldT19"), t("acExpertFormwbFieldT20"), f.tool_whitelist, "text", (v) => { f.tool_whitelist = v; });
  const scopeRow = wbRow(t("acExpertFormwbRowT239"), t("acExpertFormwbRowT240"));
  const scopeSeg = wbEl("div", "wb-segment");
  [["project", "项目级"], ["user", "用户级"]].forEach(([v, t]) => {
    const b = wbEl("button", f.scope === v ? "active" : "", t);
    b.type = "button";
    b.onclick = () => { f.scope = v; [...scopeSeg.children].forEach((x) => x.classList.remove("active")); b.classList.add("active"); };
    scopeSeg.appendChild(b);
  });
  scopeRow.ctrl.appendChild(scopeSeg);
  detail.appendChild(scopeRow);

  const acts = wbEl("div", "wb-detail-actions");
  const payload = () => ({
    name: String(f.name).trim(), description: String(f.description).trim(), role: f.role,
    methodology: f.methodology, scope: f.scope,
    tool_whitelist: String(f.tool_whitelist).split(/[,，]/).map((x) => x.trim()).filter(Boolean),
  });
  if (isNew) {
    acts.appendChild(wbBtn(t("acExpertFormwbBtnT21"), "wb-btn-primary", async (b) => {
      b.disabled = true;
      const r = await wbPost("/api/experts", payload());
      b.disabled = false;
      if (await applyExpertsResp(r)) { EXP.picked = r.id; wbSaved(t("acExpertFormwbSavedT7")); }
    }));
    acts.appendChild(wbBtn(t("cancel"), "", () => { EXP.picked = null; paintExperts(); }));
  } else if (e.builtin) {
    acts.appendChild(wbBtn(t("acExpertFormwbBtnT22"), "wb-btn-primary", async () => {
      const p = payload();
      p.name = (p.name || "副本") + "（改）";
      const r = await wbPost("/api/experts", p);
      if (await applyExpertsResp(r)) { EXP.picked = r.id; wbSaved(t("acExpertFormwbSavedT8")); }
    }));
  } else {
    acts.appendChild(wbBtn(t("save"), "wb-btn-primary", async () => {
      const r = await wbPut("/api/experts/" + encodeURIComponent(e.id), payload());
      if (await applyExpertsResp(r)) wbSaved(t("saved"));
    }));
    acts.appendChild(wbBtn(t("acExpertFormwbBtnT23"), "", async () => {
      const r = await wbPost("/api/experts/active", { active: e.id });
      if (await applyExpertsResp(r)) wbSaved(t("acExpertFormwbSavedT9") + e.name);
    }));
    acts.appendChild(wbBtn(t("acExpertFormwbBtnT24"), "", async () => {
      const r = await wbGet("/api/experts/export/" + encodeURIComponent(e.id));
      wbShowPreview(detail, r.ok ? r.markdown : t("acExpertFormwbShowPreviewT10") + r.error);
    }));
    acts.appendChild(wbBtn(t("delete"), "wb-btn-danger", async () => {
      if (!confirm(t("acExpertFormconfirmT11") + e.name + t("ceexpertFormC51"))) return;
      const r = await wbDel("/api/experts/" + encodeURIComponent(e.id));
      if (!r.ok) return wbSaved(r.error || t("acExpertFormwbSavedT12"), true);
      EXP.picked = null;
      await applyExpertsResp(r);
      wbSaved(t("skillDeleted"));
    }));
  }
  detail.appendChild(acts);
}

/* ============================================================
   灵魂
   ============================================================ */
async function wbRenderSoul(box) {
  box.innerHTML = "";
  let r;
  try { r = await wbGet("/api/soul"); } catch (e) { box.appendChild(wbNote(t("acFieldwbNoteT1") + e.message, "err")); return; }
  if (!r.ok) { box.appendChild(wbNote(r.error || t("acFieldwbNoteT228"), "err")); return; }
  const s = r.soul;
  const put = async (patch) => { const x = await wbPut("/api/soul", patch); if (x.ok) wbSaved(t("saved")); else wbSaved(x.error || t("acRuleFormwbSavedT32"), true); };
  box.appendChild(wbStats([[t("acExpertFormStatsT25"), s.values.length], [t("acExpertFormStatsT26"), s.boundaries.length], [t("acExpertFormStatsT27"), s.principles.length], [t("pending"), r.pending]]));

  const g0 = wbGroup(t("acExpertFormwbGroupT241"), t("acExpertFormwbGroupT242"));
  g0.appendChild(wbKV(t("acExpertFormwbKVT243"), s.name));
  g0.appendChild(wbSeg(t("acExpertFormwbSegT244"), t("acExpertFormwbSegT245"), [{ v: "warm", t: t("acExpertFormtT246") }, { v: "sharp", t: t("acExpertFormtT247") }, { v: "nerd", t: t("acExpertFormtT248") }], s.vibe, (v) => put({ vibe: v }), "vibe soul"));
  g0.appendChild(wbInput(t("acExpertFormwbInputT249"), t("acExpertFormwbInputT250"), s.emoji, (v) => v && put({ emoji: v }), null, "emoji soul"));
  box.appendChild(g0);

  const g1 = wbGroup(t("acExpertFormwbGroupT251"), t("acExpertFormwbGroupT252"));
  const chips = (key, items, label) => {
    const row = wbRow(label, "", key);
    row.ctrl.appendChild((function () {
      let cur = (items || []).slice();
      const boxEl = wbEl("div", "wb-chips");
      const draw = () => {
        boxEl.innerHTML = "";
        if (!cur.length) boxEl.appendChild(wbEl("span", "wb-chips-empty", t("wbChipswbElT6")));
        cur.forEach((v, i) => {
          const c = wbEl("span", "wb-chip");
          c.appendChild(wbEl("code", "", esc(tr(v))));
          const x = wbEl("button", "wb-chip-x", "✕");
          x.type = "button";
          x.onclick = () => { cur = cur.slice(); cur.splice(i, 1); draw(); const p = {}; p[key] = cur; put(p); };
          c.appendChild(x);
          boxEl.appendChild(c);
        });
      };
      draw();
      const add = wbEl("input", "wb-input wb-chip-add");
      add.placeholder = t("acExpertFormplaceholderT253");
      add.onkeydown = (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        const v = ev.target.value.trim();
        if (!v) return;
        ev.target.value = "";
        cur = cur.concat([v]);
        draw();
        const p = {}; p[key] = cur; put(p);
      };
      const wrap = wbEl("div", "wb-chips-wrap");
      wrap.appendChild(boxEl); wrap.appendChild(add);
      return wrap;
    })());
    return row;
  };
  g1.appendChild(chips("values", s.values, t("soulValues")));
  g1.appendChild(chips("boundaries", s.boundaries, t("soulBoundaries")));
  g1.appendChild(wbNote(t("acExpertFormwbNoteT254"), "warn"));
  g1.appendChild(chips("principles", s.principles, t("soulPrinciples")));
  box.appendChild(g1);

  const g2 = wbGroup(t("acExpertFormwbGroupT255"), t("acExpertFormwbGroupT256"));
  const plist = wbEl("div", "wb-list");
  const props = s.proposals || [];
  if (!props.length) plist.appendChild(wbEl("div", "wb-list-empty", t("acExpertFormwbElT257")));
  props.forEach((p) => {
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("span", "wb-badge " + (p.status === "accepted" ? "wb-badge-ok" : p.status === "rejected" ? "wb-badge-dim" : "wb-badge-warn"),
      p.status === "accepted" ? "已接受" : p.status === "rejected" ? "已拒绝" : "待确认"));
    it.appendChild(wbEl("b", "", esc(p.content)));
    it.appendChild(wbEl("span", "wb-list-sub", esc((p.target || "") + (p.reason ? " · " + p.reason : ""))));
    const acts = wbEl("span", "wb-list-actions");
    if (p.status === "pending") {
      acts.appendChild(wbBtn(t("apShowBoxH3"), "wb-btn-primary", async () => {
        const x = await wbPut("/api/soul/proposal/" + encodeURIComponent(p.id) + "?accept=1");
        if (x.ok) { wbSaved(t("acExpertFormwbSavedT13") + p.target); wbReloadInto(box, "soul"); }
      }));
      acts.appendChild(wbBtn(t("apShowBoxH4"), "", async () => {
        await wbPut("/api/soul/proposal/" + encodeURIComponent(p.id) + "?accept=0");
        wbReloadInto(box, "soul");
      }));
    }
    acts.appendChild(wbBtn(t("acExpertFormwbBtnT28"), "wb-btn-mini", async () => {
      await wbDel("/api/soul/proposal/" + encodeURIComponent(p.id));
      wbReloadInto(box, "soul");
    }));
    it.appendChild(acts);
    plist.appendChild(it);
  });
  g2.appendChild(plist);
  g2.appendChild(wbAction(t("acExpertFormwbActionT258"), t("acExpertFormwbActionT259"), t("acExpertFormwbActionT260"), async () => {
    if (!confirm(t("acExpertFormconfirmT14"))) return;
    const x = await wbPost("/api/soul/reset", {});
    if (!x.ok) return wbSaved(x.error || t("acExpertFormwbSavedT15"), true);
    wbSaved(t("acExpertFormwbSavedT16"));
    wbReloadInto(box, "soul");
  }, { danger: true }, "reset soul 重置"));
  box.appendChild(g2);
}

/* ============================================================
   记忆
   ============================================================ */
const MEM = { rows: [], scope: "project", q: "", type: "", archived: "visible", picked: null, stats: null };
async function wbRenderMemory(box) {
  box.innerHTML = "";
  const filters = wbEl("div", "wb-filters");
  const scopeSeg = wbEl("div", "wb-segment");
  [["project", t("memProject")], ["user", t("memUser")]].forEach(([v, label]) => {
    const b = wbEl("button", MEM.scope === v ? "active" : "", label);
    b.type = "button";
    b.onclick = () => { MEM.scope = v; [...scopeSeg.children].forEach((x) => x.classList.remove("active")); b.classList.add("active"); memReload(); };
    scopeSeg.appendChild(b);
  });
  filters.appendChild(scopeSeg);
  const typeSel = wbEl("select", "wb-select");
  [["", "全部类型"], ["preference", "偏好"], ["lesson", "经验"], ["pattern", "模式"], ["decision", "决策"], ["error", "教训"], ["skill", "技能"]].forEach(([v, t]) => {
    const o = document.createElement("option"); o.value = v; o.textContent = t; typeSel.appendChild(o);
  });
  typeSel.value = MEM.type;
  typeSel.onchange = () => { MEM.type = typeSel.value; memReload(); };
  filters.appendChild(typeSel);
  const archSel = wbEl("select", "wb-select");
  [["visible", "生效中"], ["only", "已归档"], ["all", "全部"]].forEach(([v, t]) => {
    const o = document.createElement("option"); o.value = v; o.textContent = t; archSel.appendChild(o);
  });
  archSel.value = MEM.archived;
  archSel.onchange = () => { MEM.archived = archSel.value; memReload(); };
  filters.appendChild(archSel);
  const search = wbEl("input", "wb-input wb-toolbar-search");
  search.placeholder = t("acExpertFormplaceholderT261");
  search.value = MEM.q;
  let tm = null;
  search.oninput = () => { clearTimeout(tm); tm = setTimeout(() => { MEM.q = search.value.trim(); memReload(); }, 200); };
  filters.appendChild(search);
  filters.appendChild(wbBtn(t("acExpertFormwbBtnT29"), "wb-btn-primary", () => { MEM.picked = "__new__"; paintMems(); }));
  box.appendChild(filters);

  const stats = wbEl("div");
  box.appendChild(stats);
  const { list, detail } = wbSplit(box, null);
  MEM._list = list; MEM._detail = detail; MEM._stats = stats;
  await memReload();
}
async function memReload() {
  let r;
  try {
    r = await wbGet("/api/memory?scope=" + MEM.scope + "&q=" + encodeURIComponent(MEM.q) + "&archived=" + MEM.archived +
      (MEM.type ? "&type=" + MEM.type : "") + "&limit=200");
  } catch (e) {
    wbLoadError(MEM._list, MEM._detail, e);
    return;
  }
  if (!r.ok) { wbListErr(MEM._list, r.error || "加载失败"); return; }
  MEM.rows = r.entries || [];
  const st = r.stats || {};
  MEM._stats.innerHTML = "";
  /* 两个数各量各的：常驻正文 = 每轮真的把内容摊给模型的条数（只有硬提醒那一类）；
     只在索引里 = 模型看得见目录、但要自己查才拿到正文。旧口径只有"将注入"一个数，
     那是"凑满 10 条无条件在场"时代的说法，现在留着会让人以为正文天天在场。 */
  MEM._stats.appendChild(wbStats([[t("acExpertFormStatsT30"), r.total], [t("acExpertFormStatsT31"), st.injected], [t("acPaintMemsbadgeT411"), st.indexed], [t("acExpertFormStatsT32"), st.atRisk], [t("acPaintMemstextT266"), st.archived], [t("acMemFormwbToggleT273"), st.sticky], [t("acExpertFormStatsT33"), st.avgStrength]]));
  MEM._stats.appendChild(wbNote(t("acExpertFormwbNoteT262"), "dim"));
  const acts = wbEl("div", "wb-inline-actions");
  acts.appendChild(wbBtn(t("acExpertFormwbBtnT34"), "", async () => {
    const x = await wbPost("/api/memory/prune", { scope: MEM.scope });
    if (!x.ok) return wbSaved(x.error || t("apOnOrchStepFailtextContentT55"), true);
    wbSaved(t("acExpertFormwbSavedT17") + x.removed + t("cememReloadC52") + x.archived + t("cememReloadC53"));
    memReload();
  }));
  acts.appendChild(wbBtn(t("acExpertFormwbBtnT35"), "", async () => {
    const x = await wbPost("/api/memory/purge", { scope: MEM.scope });
    if (!x.ok) return wbSaved(x.error || t("apOnOrchStepFailtextContentT55"), true);
    wbSaved(t("acExpertFormwbSavedT18") + x.removed + t("cememReloadC54"));
    memReload();
  }));
  acts.appendChild(wbBtn(t("acExpertFormwbBtnT36"), "", async () => {
    const x = await wbGet("/api/memory/used");
    const rows = (x.entries || []);
    MEM._detail.innerHTML = "";
    MEM._detail.appendChild(wbHead(t("acExpertFormwbHeadT37"), t("acExpertFormwbHeadT38")));
    if (!rows.length) MEM._detail.appendChild(wbEl("div", "wb-list-empty", t("acExpertFormwbElT263")));
    rows.forEach((e) => {
      const it = wbEl("div", "wb-list-item");
      /* via 是分界的根据：常驻 = 正文每轮自己在场；自查 = 模型判断要看才调 search_memory 取的。
         没有这块，面板会把"索引里有一行"也说成"模型读过了"。 */
      it.appendChild(wbEl("span", "wb-badge " + (e.via === "pull" ? "wb-badge-ok" : "wb-badge-blue"),
        e.via === "pull" ? t("acPaintMemsbadgeT412") : t("acExpertFormStatsT31")));
      it.appendChild(wbEl("span", "wb-badge", esc(e.type)));
      it.appendChild(wbEl("b", "", esc(e.topic || t("acExpertFormwbElT264"))));
      it.appendChild(wbEl("span", "wb-list-sub", esc(e.content)));
      MEM._detail.appendChild(it);
    });
  }));
  MEM._stats.appendChild(acts);
  paintMems();
}
function paintMems() {
  const list = MEM._list, detail = MEM._detail;
  if (!list) return;
  list.innerHTML = "";
  if (!MEM.rows.length) list.appendChild(wbEl("div", "wb-list-empty", t("acPaintMemswbElT265")));
  MEM.rows.forEach((e) => {
    list.appendChild(wbSideItem({
      title: (e.topic || e.type) + "：" + e.content.slice(0, 26),
      active: MEM.picked === e.id,
      badges: [
        e.archived ? { text: t("acPaintMemstextT266") } : null,
        e.sticky ? { text: t("acPaintMemstextT267"), cls: "wb-badge-blue" } : null,
        e.lane === "guard" ? { text: t("acPaintMemsbadgeT410"), cls: "wb-badge-ok" }
          : e.lane === "index" ? { text: t("acPaintMemsbadgeT411"), cls: "wb-badge-dim" } : null,
        e.risk === "drop" ? { text: t("acPaintMemstextT268"), cls: "wb-badge-err" } : e.risk === "archive" ? { text: t("acPaintMemstextT269"), cls: "wb-badge-warn" } : null,
        e.source === "sediment" ? { text: t("sediment") } : e.source === "manual" ? { text: t("acPaintMemstextT270") } : null,
      ].filter(Boolean),
      sub: "[" + e.type + "] 强度 " + e.strength + " · 访问 " + (e.accessCount || 0) + " 次 · " + (e.ageDays === 0 ? "今天" : e.ageDays + " 天前"),
      bar: e.strength * 16,
      barCls: e.strength >= 4 ? "wb-bar-hi" : e.strength < 1.5 ? "wb-bar-lo" : "",
      on: () => { MEM.picked = e.id; paintMems(); },
    }));
  });
  if (MEM.picked === "__new__") memForm(detail, null);
  else if (MEM.picked) memForm(detail, MEM.rows.find((x) => x.id === MEM.picked) || null);
  else detail.appendChild(wbEmpty(t("acPaintMemswbEmptyT39")));
}
function memForm(detail, e) {
  detail.innerHTML = "";
  const f = e ? { type: e.type, topic: e.topic, content: e.content, valueScore: e.valueScore == null ? 2 : e.valueScore, sticky: !!e.sticky }
    : { type: "lesson", topic: "", content: "", valueScore: 3, sticky: false };
  detail.appendChild(wbHead(e ? t("acMemFormwbHeadT40") : t("acMemFormwbHeadT41"), e ? "" : t("acMemFormwbHeadT19")));
  wbField(detail, t("ecOpenNodeDetailH70"), t("acMemFormwbFieldT42"), f.type,
    { select: ["preference", "lesson", "pattern", "decision", "error", "skill"], labels: { preference: "偏好", lesson: "经验", pattern: "模式", decision: "决策", error: "教训", skill: "技能" } },
    (v) => { f.type = v; });
  wbField(detail, t("ecOpenNodeDetailH71"), t("acMemFormwbFieldT43"), f.topic, "text", (v) => { f.topic = v; });
  const cRow = wbRow(t("acMemFormwbRowT271"), t("acMemFormwbRowT272"));
  const ta = wbEl("textarea", "wb-textarea");
  ta.rows = 6;
  ta.value = f.content;
  ta.oninput = () => { f.content = ta.value; };
  cRow.ctrl.appendChild(ta);
  detail.appendChild(cRow);
  wbField(detail, t("acMemFormwbFieldT44"), t("acMemFormwbFieldT45"), f.valueScore, "number", (v) => { f.valueScore = v; });
  detail.appendChild(wbToggle(t("acMemFormwbToggleT273"), t("acMemFormwbToggleT274"), f.sticky, (v) => { f.sticky = v; }));
  if (e) {
    detail.appendChild(wbKV(t("acMemFormwbKVT275"), e.source || "auto"));
    detail.appendChild(wbKV(t("acMemFormwbKVT276"), e.accessCount || 0));
    detail.appendChild(wbKV(t("acMemFormwbKVT277"), e.strength));
    detail.appendChild(wbKV(t("acMemFormwbKVT278"), e.ttlDays + t("acMemFormwbKVT46")));
  }
  const acts = wbEl("div", "wb-detail-actions");
  acts.appendChild(wbBtn(e ? t("save") : t("acMemFormwbBtnT20"), "wb-btn-primary", async () => {
    if (!String(f.content).trim()) return wbSaved(t("acMemFormwbSavedT21"), true);
    const body = Object.assign({}, f, { scope: MEM.scope });
    const r = e ? await wbPut("/api/memory/" + encodeURIComponent(e.id), body) : await wbPost("/api/memory", body);
    if (!r.ok) return wbSaved(r.error || t("apOnOrchStepFailtextContentT55"), true);
    wbSaved(e ? t("saved") : t("acExpertFormwbSavedT13"));
    MEM.picked = null;
    await memReload();
  }));
  if (e) {
    acts.appendChild(wbBtn(e.archived ? t("acMemFormwbBtnT47") : t("acMemFormwbBtnT22"), "", async () => {
      const r = await wbPost("/api/memory/" + encodeURIComponent(e.id) + "/archive", { archived: !e.archived, scope: MEM.scope });
      if (!r.ok) return wbSaved(r.error || t("apOnOrchStepFailtextContentT55"), true);
      wbSaved(e.archived ? t("acMemFormwbSavedT23") : t("cememFormC4"));
      await memReload();
    }));
    acts.appendChild(wbBtn(t("delete"), "wb-btn-danger", async () => {
      if (!confirm(t("acMemFormconfirmT24"))) return;
      await wbDel("/api/memory/" + encodeURIComponent(e.id) + "?scope=" + MEM.scope);
      wbSaved(t("skillDeleted"));
      MEM.picked = null;
      await memReload();
    }));
  } else {
    detail.appendChild(wbNote(t("acMemFormwbNoteT279"), "dim"));
  }
  detail.appendChild(acts);
}

/* ============================================================
   沉淀
   ============================================================ */
const SED = { cands: [] };
async function wbRenderSediment(box) {
  box.innerHTML = "";
  const g0 = wbGroup(t("acMemFormwbGroupT280"), t("acMemFormwbGroupT281"));
  const hint = wbEl("div", "wb-note wb-note-dim", t("acMemFormwbElT282"));
  const candBox = wbEl("div", "wb-cands");
  const runBtn = wbBtn(t("acMemFormtextContentT286"), "wb-btn-primary", async (b) => {
    const msgs = typeof collectConvTurns === "function" ? collectConvTurns() : [];
    if (msgs.length < 2) { hint.textContent = t("acMemFormtextContentT283"); return; }
    b.disabled = true; b.textContent = t("acMemFormtextContentT284");
    try {
      const r = await wbPost("/api/sediment/distill", { messages: msgs });
      if (!r.ok) { hint.textContent = r.error || "提炼失败"; return; }
      SED.cands = r.items || [];
      hint.textContent = SED.cands.length ? "共 " + SED.cands.length + " 条候选，取消勾选即不写入：" : "这次没有值得沉淀的长期资产——这通常是正确答案。";
      candBox.innerHTML = "";
      SED.cands.forEach((c, i) => {
        const row = wbEl("label", "wb-cand");
        const cb = wbEl("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.onchange = () => row.classList.toggle("off", !cb.checked);
        const body = wbEl("div", "wb-cand-body");
        body.appendChild(wbEl("div", "wb-cand-title", esc(c.title || t("acExpertFormwbElT264")) + " · " + (c.target === "rule" ? t("candTargetRule") : t("candTargetMemory")) + (c.scope ? " / " + esc(c.scope) : "")));
        body.appendChild(wbEl("div", "wb-cand-text", esc(c.content)));
        row.appendChild(cb);
        row.appendChild(body);
        candBox.appendChild(row);
      });
      if (SED.cands.length) {
        candBox.appendChild(wbBtn(t("acMemFormwbBtnT48"), "wb-btn-primary", async () => {
          const rows = [...candBox.querySelectorAll(".wb-cand")];
          let n = 0;
          const errs = [];
          for (let i = 0; i < rows.length; i++) {
            const cb = rows[i].querySelector("input");
            if (!cb || !cb.checked) continue;
            const c = SED.cands[i];
            const r = await wbPost("/api/sediment", { target: c.target, title: c.title, content: c.content, scope: c.scope });
            if (r.ok) n++; else errs.push((r.error || "失败") + "（" + (c.title || "") + "）");
          }
          wbSaved(t("acMemFormwbSavedT25") + n + t("cememReloadC53") + (errs.length ? "；" + errs.join("；") : ""), !!errs.length);
          if (n) { candBox.innerHTML = ""; hint.textContent = t("acMemFormtextContentT285"); await sedReload(); }
        }));
      }
    } finally { b.disabled = false; b.textContent = t("acMemFormtextContentT286"); }
  });
  const r0 = wbRow(t("acMemFormwbRowT287"), t("acMemFormwbRowT288"));
  r0.ctrl.appendChild(runBtn);
  g0.appendChild(r0);
  g0.appendChild(hint);
  g0.appendChild(candBox);
  box.appendChild(g0);

  const g1 = wbGroup(t("acMemFormwbGroupT289"), t("acMemFormwbGroupT290"));
  const fw = { target: "rule", title: "", content: "", scope: "decision" };
  const tRow = wbRow(t("acMemFormwbRowT291"), t("acMemFormwbRowT292"));
  const tgt = wbEl("div", "wb-segment");
  [["rule", t("candTargetRule")], ["memory", t("memProject")], ["user", t("memUser")]].forEach(([v, label]) => {
    const b = wbEl("button", fw.target === v ? "active" : "", label);
    b.type = "button";
    b.onclick = () => { fw.target = v; [...tgt.children].forEach((x) => x.classList.remove("active")); b.classList.add("active"); };
    tgt.appendChild(b);
  });
  tRow.ctrl.appendChild(tgt);
  g1.appendChild(tRow);
  wbField(g1, t("acMemFormwbFieldT49"), t("acMemFormwbFieldT50"), "", "text", (v) => { fw.title = v; });
  const cRow = wbRow(t("acMemFormwbRowT271"), t("acMemFormwbRowT272"));
  const ta = wbEl("textarea", "wb-textarea");
  ta.rows = 4;
  ta.oninput = () => { fw.content = ta.value; };
  cRow.ctrl.appendChild(ta);
  g1.appendChild(cRow);
  const sRow = wbRow("", "");
  sRow.ctrl.appendChild(wbBtn(t("skMakeSkillElH48"), "wb-btn-primary", async () => {
    if (!fw.content.trim()) return wbSaved(t("acMemFormwbSavedT21"), true);
    const r = await wbPost("/api/sediment", fw);
    if (!r.ok) return wbSaved(r.error || t("apOnOrchStepFailtextContentT55"), true);
    ta.value = "";
    fw.content = ""; fw.title = "";
    wbSaved(t("acMemFormwbSavedT26"));
    await sedReload();
  }));
  g1.appendChild(sRow);
  box.appendChild(g1);

  const g2 = wbGroup(t("acMemFormwbGroupT293"), t("acMemFormwbGroupT294"));
  const out = wbEl("div", "wb-list");
  g2.appendChild(out);
  box.appendChild(g2);
  SED._out = out;
  await sedReload();
}
async function sedReload() {
  if (!SED._out) return;
  SED._out.innerHTML = "";
  let r;
  try { r = await wbGet("/api/sediment"); }
  catch (e) { SED._out.appendChild(wbEl("div", "wb-list-empty wb-list-err", t("acFieldwbNoteT1") + String((e && e.message) || e))); return; }
  if (!r.ok) { SED._out.appendChild(wbEl("div", "wb-list-empty", r.error || t("acFieldwbNoteT228"))); return; }
  const rules = (r.rules || []).filter((x) => /sediment-/.test(x.file));
  const mem = r.memory || [];
  if (!rules.length && !mem.length) { SED._out.appendChild(wbEl("div", "wb-list-empty", t("acMemFormwbElT295"))); return; }
  rules.forEach((x) => {
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("span", "wb-badge wb-badge-blue", t("acMemFormwbElT296")));
    it.appendChild(wbEl("code", "", esc(x.file)));
    it.appendChild(wbBtn(t("acMemFormwbBtnT51"), "wb-btn-mini", () => openWorkbench("rules")));
    SED._out.appendChild(it);
  });
  mem.slice(0, 40).forEach((m) => {
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("span", "wb-badge", esc(m.type)));
    it.appendChild(wbEl("b", "", esc(m.topic || t("acExpertFormwbElT264"))));
    it.appendChild(wbEl("span", "wb-list-sub", esc(m.content.slice(0, 60))));
    it.appendChild(wbBtn(t("acMemFormwbBtnT51"), "wb-btn-mini", () => openWorkbench("memory")));
    SED._out.appendChild(it);
  });
}

/* ============================================================
   规则
   ============================================================ */
const RULE = { rows: [], counts: null, budget: null, picked: null, q: "", sample: "" };
async function wbRenderRules(box) {
  box.innerHTML = "";
  const stats = wbEl("div");
  box.appendChild(stats);
  RULE._stats = stats;
  const { list, detail } = wbSplit(box, wbToolbar(t("acMemFormwbToolbarT52"), (q) => { RULE.q = q; paintRules(); }, [
    { text: t("acMemFormtextT297"), primary: true, run: () => { RULE.picked = "__new__"; paintRules(); } },
  ]));
  RULE._list = list;
  RULE._detail = detail;
  const pv = wbEl("div", "wb-rules-preview");
  box.appendChild(pv);
  RULE._pv = pv;
  await ruleReload();
}
async function ruleReload() {
  let r;
  try { r = await wbGet("/api/rules"); }
  catch (e) { wbLoadError(RULE._list, RULE._detail, e); return; }
  if (!r.ok) { RULE._list.innerHTML = ""; RULE._list.appendChild(wbEl("div", "wb-list-empty", r.error || "加载失败")); return; }
  RULE.rows = r.rules || [];
  RULE.counts = r.counts;
  RULE.budget = r.budget;
  RULE.enabledGlob = r.enabledGlob;
  const st = RULE._stats;
  st.innerHTML = "";
  st.appendChild(wbStats([[t("acMemFormStatsT53"), r.counts.total], [t("acMemFormStatsT54"), r.counts.active], [t("wbMcpwbElT182"), r.counts.off], [t("acPaintRulestextT301"), r.counts.conditional], [t("acMemFormStatsT55"), r.counts.editable]]));
  const pct = Math.min(100, Math.round((r.budget.chars / r.budget.max) * 100));
  const bar = wbEl("div", "wb-bar wb-bar-wide");
  const fill = wbEl("i", "", "");
  fill.style.width = Math.max(1, pct) + "%";
  if (pct > 80) fill.className = "wb-bar-lo";
  bar.appendChild(fill);
  st.appendChild(bar);
  st.appendChild(wbNote(t("acMemFormwbNoteT56") + r.budget.chars + " / " + r.budget.max + t("acMemFormwbNoteT27") + pct + t("ceruleReloadC55") + (r.enabledGlob ? "" : t("ceruleReloadC56")), pct > 80 || !r.enabledGlob ? "warn" : "dim"));
  paintRules();
  renderRulePreview(RULE._pv);
}
function paintRules() {
  const list = RULE._list, detail = RULE._detail;
  if (!list) return;
  list.innerHTML = "";
  const rows = RULE.q ? RULE.rows.filter((x) => (x.file + " " + x.title + " " + x.excerpt).toLowerCase().includes(RULE.q)) : RULE.rows;
  if (!rows.length) list.appendChild(wbEl("div", "wb-list-empty", t("acPaintRuleswbElT299")));
  rows.forEach((x) => {
    list.appendChild(wbSideItem({
      title: x.title,
      active: RULE.picked === x.file,
      badges: [
        x.active ? { text: t("acPaintRulestextT300"), cls: "wb-badge-ok" } : { text: x.enabled ? t("ruleMissed") : t("ruleOff"), cls: x.enabled ? "wb-badge-warn" : "wb-badge-dim" },
        x.editable ? null : { text: x.scope === "app" ? t("ruleAppScope") : t("ruleReadonly"), cls: "wb-badge-dim" },
        x.kind !== "pancode" ? { text: x.kindLabel } : null,
        x.globs && x.globs.length ? { text: t("acPaintRulestextT301"), cls: "wb-badge-blue" } : null,
      ].filter(Boolean),
      sub: x.file + " · " + x.chars + " 字" + (x.globs && x.globs.length ? " · " + x.globs.join(" ") : ""),
      on: () => { RULE.picked = x.file; paintRules(); },
    }));
  });
  if (RULE.picked === "__new__") ruleForm(detail, null);
  else if (RULE.picked) ruleForm(detail, RULE.rows.find((x) => x.file === RULE.picked) || null);
  else detail.appendChild(wbEmpty(t("acPaintRuleswbEmptyT57")));
}
function ruleForm(detail, x) {
  detail.innerHTML = "";
  const isNew = !x;
  if (isNew) {
    detail.appendChild(wbHead(t("acRuleFormwbHeadT58"), t("acRuleFormwbHeadT59")));
    const f = { title: "", globs: "", content: "" };
    wbField(detail, t("acMemFormwbFieldT49"), t("acRuleFormwbFieldT60"), f.title, "text", (v) => { f.title = v; });
    wbField(detail, t("acRuleFormwbFieldT61"), t("acRuleFormwbFieldT62"), "", "text", (v) => { f.globs = v; });
    const cRow = wbRow(t("acRuleFormwbRowT302"), t("acRuleFormwbRowT303"));
    const ta = wbEl("textarea", "wb-textarea");
    ta.rows = 8;
    ta.oninput = () => { f.content = ta.value; };
    cRow.ctrl.appendChild(ta);
    detail.appendChild(cRow);
    const acts = wbEl("div", "wb-detail-actions");
    acts.appendChild(wbBtn(t("acExpertFormwbBtnT21"), "wb-btn-primary", async () => {
      if (!String(f.title).trim()) return wbSaved(t("acRuleFormwbSavedT28"), true);
      if (!String(f.content).trim()) return wbSaved(t("acRuleFormwbSavedT29"), true);
      const r = await wbPost("/api/rules", {
        title: f.title.trim(), globs: String(f.globs).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean), content: f.content,
      });
      if (!r.ok) return wbSaved(r.error || t("apOnOrchStepFailtextContentT55"), true);
      RULE.picked = r.file;
      wbSaved(t("acExpertFormwbSavedT7"));
      await ruleReload();
    }));
    detail.appendChild(acts);
    return;
  }
  detail.appendChild(wbHead(x.title, x.file + " · " + x.kindLabel));
  if (!x.active) detail.appendChild(wbNote(t("acRuleFormwbNoteT63") + x.activeWhy, x.enabled ? "warn" : "dim"));
  if (!x.editable) detail.appendChild(wbNote(t("acRuleFormwbNoteT305"), "dim"));
  fetch("/api/rules/content?file=" + encodeURIComponent(x.file)).then((r) => r.json()).then((r) => {
    if (!r.ok) { detail.appendChild(wbNote(r.error || t("acRuleFormwbNoteT306"), "err")); return; }
    const f = {
      title: r.meta.title || "", description: r.meta.description || "", enabled: r.meta.enabled !== false,
      always: !!r.meta.always, globs: (r.meta.globs || []).join(", "), content: r.body || "",
    };
    wbField(detail, t("acMemFormwbFieldT49"), t("acRuleFormwbFieldT64"), f.title, "text", (v) => { f.title = v; });
    wbField(detail, t("acRuleFormwbFieldT61"), t("acRuleFormwbFieldT65"), f.globs, "text", (v) => { f.globs = v; });
    detail.appendChild(wbToggle(t("acRuleFormwbToggleT307"), t("acRuleFormwbToggleT308"), f.enabled, (v) => {
      if (!x.editable) { wbSaved(t("acRuleFormwbSavedT30"), true); return; }
      f.enabled = v;
      wbPost("/api/rules/toggle", { file: x.file, enabled: v }).then((r2) => {
        if (!r2.ok) { wbSaved(r2.error || t("apOnOrchStepFailtextContentT55"), true); return; }
        wbSaved(v ? t("acRuleFormwbSavedT31") : t("wbMcpwbElT182"));
        ruleReload();
      });
    }, "enabled"));
    const cRow = wbRow(t("acRuleFormwbRowT302"), t("acRuleFormwbRowT309"));
    const ta = wbEl("textarea", "wb-textarea");
    ta.rows = 10;
    ta.value = f.content;
    ta.readOnly = !x.editable;
    ta.oninput = () => { f.content = ta.value; };
    cRow.ctrl.appendChild(ta);
    detail.appendChild(cRow);
    if (x.editable) {
      const acts = wbEl("div", "wb-detail-actions");
      acts.appendChild(wbBtn(t("save"), "wb-btn-primary", async () => {
        const r2 = await wbPut("/api/rules", {
          file: x.file, title: f.title, description: f.description, enabled: f.enabled, always: f.always,
          globs: String(f.globs).split(/[,，]/).map((s) => s.trim()).filter(Boolean), content: f.content,
        });
        if (!r2.ok) return wbSaved(r2.error || t("acRuleFormwbSavedT32"), true);
        wbSaved(t("saved"));
        await ruleReload();
      }));
      acts.appendChild(wbBtn(t("acRuleFormwbBtnT66"), "wb-btn-danger", async () => {
        if (!confirm(t("acExpertFormwbSavedT17") + x.file + "？")) return;
        const r2 = await wbDel("/api/rules", { file: x.file });
        if (!r2.ok) return wbSaved(r2.error || t("acExpertFormwbSavedT12"), true);
        RULE.picked = null;
        wbSaved(t("acRuleFormwbSavedT33"));
        await ruleReload();
      }));
      /* 历史默认收起：多数保存根本用不到它，但误删规则之后它是唯一的退路，
         所以入口必须常驻动作行，而不是藏在某个二级菜单里。 */
      const histWrap = wbEl("div", "wb-rulehist");
      histWrap.style.display = "none";
      let histLoaded = false;
      acts.appendChild(wbBtn(t("acRuleFormwbBtnT67"), "", async (b) => {
        const open = histWrap.style.display === "none";
        histWrap.style.display = open ? "block" : "none";
        b.textContent = open ? "收起历史" : "历史";
        if (open && !histLoaded) {
          histLoaded = true;
          try { await ruleHistoryPanel(histWrap, x.file); }
          catch (e) { histWrap.innerHTML = ""; histWrap.appendChild(wbNote(t("acRuleFormwbNoteT68") + e.message, "err")); histLoaded = false; }
        }
      }));
      detail.appendChild(acts);
      detail.appendChild(histWrap);
    }
  });
}
/* 规则历史面板：版本列表（动作 + 行级差异 + 恢复）。
   后端存的每一版都是「那次动作之前」的内容，所以列表标题要说清是哪次动作的前一版，
   否则用户会以为 ts 那一行就是那次动作产出的结果（正好差一版）。 */
const RH_OP_LABEL = { create: "新建", update: "改写", delete: "删除", toggle: "启停", restore: "恢复", "pre-restore": "回滚" };
async function ruleHistoryPanel(host, file) {
  host.innerHTML = "";
  let r;
  try { r = await wbGet("/api/rules/history?file=" + encodeURIComponent(file)); }
  catch (e) { host.appendChild(wbNote(t("acRuleFormwbNoteT69") + e.message, "err")); return; }
  if (!r.ok) { host.appendChild(wbNote(r.error || t("acRuleFormwbNoteT312"), "err")); return; }
  const vs = r.versions || [];
  host.appendChild(wbNote(t("acRuleFormwbNoteT70") + (r.keep || 20) + t("acRuleFormwbNoteT34"), "dim"));
  if (!vs.length) {
    host.appendChild(wbEl("div", "wb-list-empty", t("acRuleFormwbElT314")));
    return;
  }
  const listEl = wbEl("div", "wb-list");
  const diffEl = wbEl("div");
  host.appendChild(listEl);
  host.appendChild(diffEl);
  const showDiff = async (v, btn) => {
    diffEl.innerHTML = "";
    [...listEl.querySelectorAll(".wb-btn.active")].forEach((n) => n.classList.remove("active"));
    btn.classList.add("active");
    let d;
    try { d = await wbGet("/api/rules/diff?file=" + encodeURIComponent(file) + "&ts=" + v.ts); }
    catch (e) { diffEl.appendChild(wbNote(t("acRuleFormwbNoteT71") + e.message, "err")); return; }
    if (!d.ok) { diffEl.appendChild(wbNote(d.error || t("acRuleFormwbNoteT316"), "err")); return; }
    diffEl.appendChild(wbEl("div", "wb-preview-meta", esc(t("acRuleFormwbElT72") + new Date(d.meta.ts).toLocaleString() + " · "
      + (RH_OP_LABEL[d.meta.op] || d.meta.op) + "前）↔ 现在"
      + (d.exists ? "" : " · 当前文件已不存在")
      + (d.tooBig ? "" : " · +" + d.added + " −" + d.removed))));
    if (d.tooBig) {
      diffEl.appendChild(wbNote(t("acRuleFormwbNoteT318"), "dim"));
      const pre = wbEl("pre", "wb-preview");
      pre.textContent = d.old || "（空）";
      diffEl.appendChild(pre);
      return;
    }
    if (!d.lines.length) { diffEl.appendChild(wbNote(t("acRuleFormwbNoteT319"), "dim")); return; }
    const box = wbEl("div", "wb-diff");
    d.lines.forEach((ln) => {
      const cls = ln.t === "+" ? "wb-diff-add" : ln.t === "-" ? "wb-diff-del" : "wb-diff-ctx";
      const row = wbEl("div", "wb-diff-line " + cls);
      row.textContent = ln.t + " " + ln.text;   // 规则正文是用户写的，走 textContent 不拼 innerHTML
      box.appendChild(row);
    });
    diffEl.appendChild(box);
  };
  vs.forEach((v, idx) => {
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("b", "", esc(new Date(v.ts).toLocaleString())));
    it.appendChild(wbEl("span", "wb-badge" + (v.op === "delete" ? " wb-badge-err" : ""), esc(RH_OP_LABEL[v.op] || v.op)));
    it.appendChild(wbEl("span", "wb-list-sub", esc(v.size + t("acRuleFormwbElT73"))));
    const dbtn = wbBtn(t("acRuleFormwbBtnT74"), "", () => showDiff(v, dbtn));
    it.appendChild(dbtn);
    it.appendChild(wbBtn(t("acRuleFormwbBtnT75"), "", async () => {
      if (!confirm(t("ruleRestoreConfirm", { when: new Date(v.ts).toLocaleString() }))) return;
      const rr = await wbPost("/api/rules/restore", { file, ts: v.ts });
      if (!rr.ok) return wbSaved(rr.error || t("acRuleFormwbSavedT36"), true);
      wbSaved(t("acRuleFormwbSavedT37"));
      await ruleReload();
    }));
    listEl.appendChild(it);
    /* 首屏不自动拉差异：20 版 × 每次一个请求，点开才要第二个请求，浪费且会闪。 */
    if (idx === 0) queueMicrotask(() => showDiff(v, dbtn));
  });
}
function renderRulePreview(host) {
  if (!host) return;
  host.innerHTML = "";
  host.appendChild(wbHead(t("acRenderRulePreviewwbHeadT76"), t("acRenderRulePreviewwbHeadT77")));
  /* 多根授权之后这句话必须说全：本预览是用裸 {files}（只有当前根）调装配函数的，
     而某条会话真去读过别的授权目录之后，模型看到的规则会比这里多。面板没说谎，但不完整。 */
  host.appendChild(wbNote(t("acRenderRulePreviewwbNoteT78") + t("rulePreviewNoteTail")));
  const row = wbRow(t("acRenderRulePreviewwbRowT322"), t("acRenderRulePreviewwbRowT323"));
  const inp = wbEl("input", "wb-input wb-input-wide");
  inp.placeholder = t("acRenderRulePreviewplaceholderT324");
  inp.value = RULE.sample;
  inp.onkeydown = (e) => { if (e.key === "Enter") { RULE.sample = inp.value.trim(); ruleReload(); } };
  inp.oninput = () => { RULE.sample = inp.value; };
  row.ctrl.appendChild(inp);
  row.ctrl.appendChild(wbBtn(t("viewDetail"), "", () => { RULE.sample = inp.value.trim(); ruleReload(); }));
  host.appendChild(row);
  const meta = wbEl("div", "wb-preview-meta", "");
  host.appendChild(meta);
  const pre = wbEl("pre", "wb-preview");
  host.appendChild(pre);
  wbGet("/api/rules/preview?q=" + encodeURIComponent(RULE.sample || "")).then((r) => {
    if (!r.ok) { pre.textContent = t("acFieldwbNoteT1") + r.error; return; }
    pre.textContent = r.preview || t("rulePreviewEmpty");
    meta.textContent = t("acRenderRulePreviewtextContentT79") + r.chars + " / " + r.max + t("cerenderRulePreviewC57") + r.touched + t("aprunUndoC11");
  });
}

/* ============================================================
   技能
   ============================================================ */
const SKL = { rows: [], picked: null, q: "" };
async function wbRenderSkills(box) {
  box.innerHTML = "";
  const stats = wbEl("div");
  box.appendChild(stats);
  SKL._stats = stats;
  const { list, detail } = wbSplit(box, wbToolbar(t("acRenderRulePreviewwbToolbarT80"), (q) => { SKL.q = q; paintSkills(); }, [
    { text: t("acRenderRulePreviewtextT326"), primary: true, run: () => { SKL.picked = "__new__"; paintSkills(); } },
    { text: t("acRenderRulePreviewtextT327"), run: () => { SKL.picked = "__import__"; paintSkills(); } },
  ]));
  SKL._list = list;
  SKL._detail = detail;
  await skReload();
}
async function skReload() {
  let r;
  try { r = await wbGet("/api/skills/managed"); }
  catch (e) { wbLoadError(SKL._list, SKL._detail, e); return; }
  if (!r.ok) { wbLoadError(SKL._list, SKL._detail, { message: r.error || "加载失败" }); return; }
  SKL.rows = r.skills || [];
  SKL._stats.innerHTML = "";
  SKL._stats.appendChild(wbStats([[t("acRenderRulePreviewStatsT81"), r.counts.total], [t("acRuleFormwbToggleT307"), r.counts.on], [t("acPaintSkillstextT330"), r.counts.off], [t("acPaintExpertstextT231"), r.counts.builtin], [t("acRenderRulePreviewStatsT82"), r.counts.risky]]));
  SKL._stats.appendChild(wbNote(t("acRenderRulePreviewwbNoteT328"), "dim"));
  paintSkills();
}
function paintSkills() {
  const list = SKL._list, detail = SKL._detail;
  if (!list) return;
  list.innerHTML = "";
  const rows = SKL.q ? SKL.rows.filter((s) => (s.name + " " + (s.description || "") + " " + (s.trigger || "")).toLowerCase().includes(SKL.q)) : SKL.rows;
  if (!rows.length) list.appendChild(wbEl("div", "wb-list-empty", t("acPaintSkillswbElT329")));
  rows.forEach((s) => {
    list.appendChild(wbSideItem({
      title: s.name,
      active: SKL.picked === s.id,
      badges: [
        s.builtin ? { text: t("acPaintExpertstextT231") } : null,
        s.disabled ? { text: t("acPaintSkillstextT330"), cls: "wb-badge-dim" } : null,
        s.risk === "P0" ? { text: t("highRisk"), cls: "wb-badge-err" } : s.risk === "P1" ? { text: t("acPaintSkillstextT331"), cls: "wb-badge-warn" } : null,
        s.scope === "user" ? { text: t("acPaintSkillstextT332"), cls: "wb-badge-blue" } : null,
      ].filter(Boolean),
      sub: tr(s.description || t("skillNoDesc")).slice(0, 42) + t("skillUsedCount", { n: s.useCount }),
      on: () => { SKL.picked = s.id; paintSkills(); },
    }));
  });
  if (SKL.picked === "__new__") skillForm(detail, null);
  else if (SKL.picked === "__import__") skillImportForm(detail);
  else if (SKL.picked) skillForm(detail, SKL.rows.find((x) => x.id === SKL.picked) || null);
  else detail.appendChild(wbEmpty(t("acPaintSkillswbEmptyT83")));
}
function skillForm(detail, s) {
  detail.innerHTML = "";
  if (!s) {
    detail.appendChild(wbHead(t("acSkillFormwbHeadT84"), t("acSkillFormwbHeadT85")));
    const f = { name: "", description: "", trigger: "", body: "" };
    wbField(detail, t("ecOpenSoulEditorH78"), "", "", "text", (v) => { f.name = v; });
    wbField(detail, t("acExpertFormwbFieldT13"), t("acSkillFormwbFieldT86"), "", "text", (v) => { f.description = v; });
    wbField(detail, t("acSkillFormwbFieldT87"), t("acSkillFormwbFieldT88"), "", "text", (v) => { f.trigger = v; });
    const bRow = wbRow(t("acRuleFormwbRowT302"), t("acSkillFormwbRowT333"));
    const ta = wbEl("textarea", "wb-textarea");
    ta.rows = 10;
    ta.oninput = () => { f.body = ta.value; };
    bRow.ctrl.appendChild(ta);
    detail.appendChild(bRow);
    const newActs = wbEl("div", "wb-detail-actions");
    newActs.appendChild(wbBtn(t("acExpertFormwbBtnT21"), "wb-btn-primary", async () => {
      if (!String(f.name).trim()) return wbSaved(t("acSkillFormwbSavedT38"), true);
      const r = await wbPost("/api/skills", { name: f.name.trim(), description: f.description.trim(), trigger: f.trigger.trim(), body: f.body });
      if (!r.ok) return wbSaved(r.error || t("apOnOrchStepFailtextContentT55"), true);
      if (r.skill && r.skill._auditRejected) return wbSaved(t("acSkillFormwbSavedT39") + r.skill._auditRejected.level, true);
      SKL.picked = r.skill && r.skill.id;
      wbSaved(t("acExpertFormwbSavedT7"));
      await skReload();
    }));
    detail.appendChild(newActs);
    return;
  }
  detail.appendChild(wbHead(s.name, (s.builtin ? t("acSkillFormwbHeadT89") : (s.source || "") + " · " + (s.scope || "project")) + (s.risk && s.risk !== "P2" ? t("acSkillFormwbHeadT90") + s.risk : "")));
  fetch("/api/skills/content?id=" + encodeURIComponent(s.id)).then((r) => r.json()).then((r) => {
    if (!r.ok) { detail.appendChild(wbNote(r.error || t("acRuleFormwbNoteT306"), "err")); return; }
    const k = r.skill;
    const f = { name: k.name, description: k.description || "", trigger: k.trigger || "", tags: (k.tags || []).join(", "), body: k.body || "" };
    wbField(detail, t("ecOpenSoulEditorH78"), "", f.name, "text", (v) => { f.name = v; });
    wbField(detail, t("acExpertFormwbFieldT13"), t("acSkillFormwbFieldT91"), f.description, "text", (v) => { f.description = v; });
    wbField(detail, t("acSkillFormwbFieldT87"), t("acSkillFormwbFieldT92"), f.trigger, "text", (v) => { f.trigger = v; });
    wbField(detail, t("acSkillFormwbFieldT93"), t("acSkillFormwbFieldT92"), f.tags, "text", (v) => { f.tags = v; });
    const bRow = wbRow(t("acRuleFormwbRowT302"), t("acSkillFormwbRowT334"));
    const ta = wbEl("textarea", "wb-textarea");
    ta.rows = 12;
    ta.value = f.body;
    ta.readOnly = !!s.builtin;
    ta.oninput = () => { f.body = ta.value; };
    bRow.ctrl.appendChild(ta);
    detail.appendChild(bRow);
    const acts = wbEl("div", "wb-detail-actions");
    if (!s.builtin) {
      acts.appendChild(wbBtn(t("save"), "wb-btn-primary", async () => {
        const r2 = await wbPut("/api/skills/" + encodeURIComponent(s.id), {
          name: f.name.trim(), description: f.description.trim(), trigger: f.trigger.trim(),
          tags: f.tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean), body: f.body,
        });
        if (!r2.ok) return wbSaved(r2.error || t("acRuleFormwbSavedT32"), true);
        wbSaved(t("saved"));
        await skReload();
      }));
      acts.appendChild(wbBtn(s.disabled ? t("acRuleFormwbToggleT307") : t("acPaintSkillstextT330"), "", async () => {
        const r2 = await wbPost("/api/skills/" + encodeURIComponent(s.id) + "/toggle", { disabled: !s.disabled });
        if (!r2.ok) return wbSaved(r2.error || t("apOnOrchStepFailtextContentT55"), true);
        wbSaved(r2.disabled ? t("wbMcpwbElT182") : t("acRuleFormwbSavedT31"));
        await skReload();
      }));
      acts.appendChild(wbBtn(t("acExpertFormwbBtnT24"), "", async () => {
        const r2 = await wbGet("/api/skills/export/" + encodeURIComponent(s.id));
        if (!r2.ok) return wbSaved(r2.error || t("apOnOrchStepFailtextContentT55"), true);
        const blob = new Blob([r2.content], { type: "text/markdown" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = r2.filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }));
      acts.appendChild(wbBtn(t("delete"), "wb-btn-danger", async () => {
        if (!confirm(t("acSkillFormconfirmT40") + s.name + "」？")) return;
        await wbDel("/api/skills/" + encodeURIComponent(s.id));
        SKL.picked = null;
        wbSaved(t("skillDeleted"));
        await skReload();
      }));
    } else {
      acts.appendChild(wbBtn(t("acSkillFormwbBtnT94"), "wb-btn-primary", async () => {
        const r2 = await wbPost("/api/skills", {
          name: f.name + "（自定义）", description: f.description, trigger: f.trigger,
          tags: f.tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean), body: f.body,
        });
        if (!r2.ok) return wbSaved(r2.error || t("apOnOrchStepFailtextContentT55"), true);
        SKL.picked = r2.skill && r2.skill.id;
        wbSaved(t("acSkillFormwbSavedT41"));
        await skReload();
      }));
    }
    detail.appendChild(acts);
    const pvRow = wbRow(t("acSkillFormwbRowT335"), t("acSkillFormwbRowT336"));
    const pin = wbEl("input", "wb-input wb-input-wide");
    pin.placeholder = t("acSkillFormplaceholderT337");
    pvRow.ctrl.appendChild(pin);
    pvRow.ctrl.appendChild(wbBtn(t("viewDetail"), "", async () => {
      const r2 = await wbGet("/api/skills/preview?q=" + encodeURIComponent(pin.value.trim()));
      if (!r2.ok) return wbShowPreview(detail, t("acSkillFormwbShowPreviewT42") + r2.error);
      wbShowPreview(detail, t("skillPreviewHits", { dir: r2.directory || t("acSkillFormwbShowPreviewT43"), names: (r2.matched || []).map((m) => tr(m.name)).join(" / ") }));
    }));
    detail.appendChild(pvRow);
  });
}
function skillImportForm(detail) {
  detail.innerHTML = "";
  detail.appendChild(wbHead(t("acSkillImportFormwbHeadT95"), t("acSkillImportFormwbHeadT96")));
  const ta = wbEl("textarea", "wb-textarea");
  ta.rows = 12;
  detail.appendChild(ta);
  const acts = wbEl("div", "wb-detail-actions");
  acts.appendChild(wbBtn(t("acRenderRulePreviewtextT327"), "wb-btn-primary", async () => {
    const r = await wbPost("/api/skills/import", { markdown: ta.value });
    if (r.ok) { wbSaved(t("acSkillImportFormwbSavedT44")); SKL.picked = r.skill && r.skill.id; await skReload(); return; }
    if (r.needForce) {
      if (!confirm("安全审计提示：\n" + r.error + "\n\n仍然导入？")) return;
      const r2 = await wbPost("/api/skills/import", { markdown: ta.value, force: true });
      wbSaved(r2.ok ? t("acSkillImportFormwbSavedT45") : r2.error || t("apOnOrchStepFailtextContentT55"), !r2.ok);
      if (r2.ok) await skReload();
      return;
    }
    wbSaved(r.error || t("importFail"), true);
  }));
  detail.appendChild(acts);
}

/* ============================================================
   进化 / 进度
   ============================================================ */

/* ---------- P3-D3 规则提案 ----------
   提案的证据口径全部在服务端（server/rule-proposals.js：数重复，不叫模型总结），
   界面只负责把「凭什么提这条」摊开：正文与证据都必须在点采纳之前看得见，
   否则这条功能就变成了让用户对着未知文本按确认键。 */
let rpView = "pending";

async function renderProposals(host) {
  host.innerHTML = "";
  const g = wbGroup(t("acSkillImportFormwbGroupT338"), t("acSkillImportFormwbGroupT339"));
  host.appendChild(g);
  let r;
  try { r = await wbGet("/api/rule-proposals"); }
  catch (e) { g.appendChild(wbEl("div", "wb-list-empty", t("acSkillImportFormwbElT97") + esc(e.message || String(e)))); return; }
  if (!r.ok) { g.appendChild(wbEl("div", "wb-list-empty", t("acSkillImportFormwbElT97") + esc(r.error || "未知"))); return; }
  const c = r.counts || {};
  const win = r.window || {};
  const labels = r.sourceLabels || {};
  const ps = r.proposals || [];
  /* 三个状态的计数一次给全：只数 pending 会让人以为"没提案=没在进化"，
     其实多半是已经忽略过、或者证据还没到门槛。 */
  g.appendChild(wbSeg(t("acSkillImportFormwbSegT341"), t("acSkillImportFormwbSegT342"),
    [{ v: "pending", t: t("acSkillImportFormtT98") + (c.pending || 0) }, { v: "adopted", t: t("acSkillImportFormtT99") + (c.adopted || 0) }, { v: "dismissed", t: t("acSkillImportFormtT100") + (c.dismissed || 0) }],
    rpView, (v) => { rpView = v; paint(); }));
  const body = wbEl("div", "wb-list wb-rp");
  g.appendChild(body);

  const paint = () => {
    body.innerHTML = "";
    const rows = ps.filter((p) => (p.status || "pending") === rpView);
    if (!rows.length) {
      body.appendChild(wbEl("div", "wb-list-empty", rpView === "pending"
        ? t("rpNonePending", { threshold: r.minRepeat || 2, days: win.days || 0, decisions: win.decisions || 0, memories: win.memories || 0 })
        : rpView === "adopted" ? t("rpNoneAdopted") : t("rpNoneIgnored")));
      return;
    }
    rows.forEach((p) => body.appendChild(proposalRow(p, labels, () => renderProposals(host))));
  };
  paint();
}

function proposalRow(p, labels, repaint) {
  const it = wbEl("div", "wb-list-item wb-rp-item");
  it.appendChild(wbEl("span", "wb-badge wb-badge-dim", esc(labels[p.source] || p.source || t("acProposalRowwbElT346"))));
  it.appendChild(wbEl("span", "wb-badge " + (p.status === "adopted" ? "wb-badge-ok" : p.status === "dismissed" ? "wb-badge-dim" : "wb-badge-warn"),
    "证据 " + (p.count || 0) + " 次"));
  if (p.status === "adopted") it.appendChild(wbEl("span", "wb-badge " + (p.ruleFileExists ? "wb-badge-blue" : "wb-badge-err"), p.ruleFileExists ? "规则已生效" : "规则文件已不在"));
  const main = wbEl("div", "wb-rp-main");
  main.appendChild(wbEl("b", "wb-rp-title", esc(p.title || "")));
  main.appendChild(wbEl("pre", "wb-rp-statement", esc(p.statement || "")));
  const ev = wbEl("div", "wb-rp-evidence");
  ev.style.display = "none";
  (p.evidence || []).forEach((x) => {
    const line = wbEl("div", "wb-rp-ev");
    line.appendChild(wbEl("span", "wb-rp-ev-when", esc(x.ts ? new Date(x.ts).toLocaleString() : "—")));
    line.appendChild(wbEl("span", "", esc(x.text || "")));
    ev.appendChild(line);
  });
  main.appendChild(ev);
  const more = wbBtn(t("acProposalRowwbBtnT101") + (p.count || 0) + t("acProposalRowwbBtnT46"), "wb-btn-sm", () => {
    ev.style.display = ev.style.display === "none" ? "block" : "none";
  });
  main.appendChild(more);
  it.appendChild(main);

  const acts = wbEl("div", "wb-detail-actions");
  const say = (msg, err) => { wbSaved(msg, err); repaint(); };
  if ((p.status || "pending") === "pending") {
    acts.appendChild(wbBtn(t("acProposalRowwbBtnT102"), "wb-btn-primary", async () => {
      const x = await wbPost("/api/rule-proposals/" + encodeURIComponent(p.id) + "/adopt", {});
      say(x.ok ? (x.already ? "这条规则已经在 " + x.file : "已写入规则 " + x.file) : "采纳失败：" + (x.error || "未知"), !x.ok);
    }));
    acts.appendChild(wbBtn(t("acProposalRowwbBtnT103"), "", async () => {
      const x = await wbPost("/api/rule-proposals/" + encodeURIComponent(p.id) + "/dismiss", {});
      say(x.ok ? "已忽略，这条不会再冒出来" : "操作失败：" + (x.error || "未知"), !x.ok);
    }));
  } else if (p.status === "adopted") {
    if (p.ruleFile) acts.appendChild(wbEl("code", "wb-rp-file", esc(p.ruleFile)));
    if (!p.ruleFileExists) acts.appendChild(wbBtn(t("acProposalRowwbBtnT104"), "", async () => {
      const x = await wbPost("/api/rule-proposals/" + encodeURIComponent(p.id) + "/adopt", {});
      say(x.ok ? "已重新写入规则 " + x.file : "失败：" + (x.error || "未知"), !x.ok);
    }));
  } else {
    acts.appendChild(wbBtn(t("acProposalRowwbBtnT105"), "", async () => {
      const x = await wbPost("/api/rule-proposals/" + encodeURIComponent(p.id) + "/reopen", {});
      say(x.ok ? "已放回待处理" : "失败：" + (x.error || "未知"), !x.ok);
    }));
  }
  it.appendChild(acts);
  return it;
}

async function wbRenderEvolution(box) {
  box.innerHTML = "";
  let r;
  try { r = await wbGet("/api/progression"); } catch (e) { box.appendChild(wbNote(t("acFieldwbNoteT1") + e.message, "err")); return; }
  const p = r.progression || {};
  const g0 = wbGroup(t("acProposalRowwbGroupT347"), t("acProposalRowwbGroupT348"));
  const head = wbEl("div", "wb-prog");
  const stage = p.stage || {};
  head.appendChild(wbEl("div", "wb-prog-stage", "<b>" + esc(tr(stage.name || "萌芽")) + "</b><span>" + esc(t("evoStageN", { n: stage.id == null ? 0 : stage.id })) + "</span>"));
  const bar = wbEl("div", "wb-prog-bar");
  const fill = wbEl("i");
  fill.style.width = Math.max(2, Math.round((p.stageProgress || 0) * 100)) + "%";
  bar.appendChild(fill);
  head.appendChild(bar);
  head.appendChild(wbEl("div", "wb-prog-meta", p.xp + t("acProposalRowwbElT106") + (p.xpToNext ? t("evoXpPoints", { n: p.xpToNext }) : t("evoMaxStage"))));
  g0.appendChild(head);
  const at = wbEl("div", "wb-attrs");
  const ATTR = { understanding: t("evoAttrUnderstanding"), craft: t("evoAttrCraft"), robustness: t("evoAttrRobustness"), rapport: t("evoAttrRapport") };
  Object.keys(ATTR).forEach((k) => {
    const v = (p.attributes || {})[k] || 0;
    const it = wbEl("div", "wb-attr");
    it.appendChild(wbEl("b", "", ATTR[k]));
    const b = wbEl("div", "wb-bar");
    const fi = wbEl("i");
    fi.style.width = Math.max(2, v) + "%";
    b.appendChild(fi);
    it.appendChild(b);
    it.appendChild(wbEl("span", "", String(Math.round(v))));
    at.appendChild(it);
  });
  g0.appendChild(at);
  const un = (p.unlockNodes || []).filter((n) => !n.met);
  if (un.length) {
    g0.appendChild(wbEl("div", "wb-sub-label", t("acProposalRowwbElT350")));
    const uc = wbEl("div", "wb-achv");
    un.forEach((n) => uc.appendChild(wbEl("span", "wb-achv-item locked", esc(tr(n.label)) + " · " + esc(tr(n.req)))));
    g0.appendChild(uc);
  }
  const got = (p.achievements || []).filter((a) => a.unlocked);
  if (got.length) {
    g0.appendChild(wbEl("div", "wb-sub-label", t("acProposalRowwbElT351")));
    const ac = wbEl("div", "wb-achv");
    got.forEach((a) => ac.appendChild(wbEl("span", "wb-achv-item", esc(tr(a.name)))));
    g0.appendChild(ac);
  }
  box.appendChild(g0);

  /* P3-D3 规则提案：进化不只有分数，还得能变成下一轮的硬约束。
     单独一个 host——采纳/忽略之后只刷这一组，不重跑整个进化面板的阶段与时间线。
     不 await：提案要扫决策链，慢一点也不能把下面的路线/时间线一起拖没影。 */
  const rpHost = wbEl("div", "wb-rp-host");
  box.appendChild(rpHost);
  renderProposals(rpHost);

  const g1 = wbGroup(t("acProposalRowwbGroupT352"), t("acProposalRowwbGroupT353"));
  const seg = wbEl("div", "wb-segment wb-segment-wrap");
  (r.paths || []).forEach((pa) => {
    const b = wbEl("button", r.path === pa.id ? "active" : "", esc(tr(pa.name)));
    b.type = "button";
    b.title = tr(pa.desc);
    b.onclick = async () => {
      const x = await wbPost("/api/progression", { path: pa.id });
      if (!x.ok) return wbSaved(x.error ? tr(x.error) : t("failTag"), true);
      [...seg.children].forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      wbSaved(t("evoPathSet", { name: tr(pa.name) }));
    };
    seg.appendChild(b);
  });
  if ((r.paths || []).length) {
    const row = wbRow(t("acProposalRowwbRowT354"), (r.paths.find((x) => x.id === r.path) || {}).desc || "");
    row.ctrl.appendChild(seg);
    g1.appendChild(row);
  }
  g1.appendChild(wbAction(t("acProposalRowwbActionT355"), t("acProposalRowwbActionT356"), t("acProposalRowwbActionT357"), async () => {
    const x = await wbPost("/api/progression", { path: null });
    if (x.ok) { wbSaved(t("acProposalRowwbSavedT47")); wbReloadInto(box, "evolution"); }
  }));
  box.appendChild(g1);

  const g2 = wbGroup(t("acProposalRowwbGroupT358"), t("acProposalRowwbGroupT359"));
  const tl = wbEl("div", "wb-timeline");
  g2.appendChild(tl);
  box.appendChild(g2);
  try {
    const treeRes = await wbGet("/api/evolution/tree");
    const items = treeRes.timeline || [];
    if (!items.length) tl.appendChild(wbEl("div", "wb-list-empty", t("acProposalRowwbElT360")));
    items.slice(0, 50).forEach((x) => {
      const it = wbEl("div", "wb-tl-item");
      it.appendChild(wbEl("span", "wb-tl-dot wb-tl-" + esc(x.kind || "x")));
      const body = wbEl("div", "wb-tl-body");
      body.appendChild(wbEl("b", "", esc(String(x.title || "").slice(0, 70))));
      body.appendChild(wbEl("span", "wb-tl-sub", esc(x.sub || x.kind || "")));
      it.appendChild(body);
      it.appendChild(wbEl("span", "wb-tl-when", x.ts ? new Date(x.ts).toLocaleDateString() : "—"));
      tl.appendChild(it);
    });
  } catch (e) { tl.appendChild(wbEl("div", "wb-list-empty", t("acProposalRowwbElT361"))); }

  const g3 = wbGroup(t("acProposalRowwbGroupT362"), t("acProposalRowwbGroupT363"));
  g3.appendChild(wbAction(t("acProposalRowwbActionT364"), t("acProposalRowwbActionT365"), t("open"), () => {
    if (typeof openEvolutionCodex === "function") openEvolutionCodex(); else toast(t("acProposalRowtoastT48"));
  }, null, "codex tree 图鉴"));
  box.appendChild(g3);
}

/* ============================================================
   自动化任务
   ============================================================ */
async function wbRenderAutomations(box) {
  box.innerHTML = "";
  let r;
  try { r = await wbGet("/api/automations"); } catch (e) { box.appendChild(wbNote(t("acFieldwbNoteT1") + e.message, "err")); return; }
  const rows = r.automations || [];
  const g0 = wbGroup(t("acProposalRowwbGroupT366"), t("acProposalRowwbGroupT367"));
  g0.appendChild(wbStats([[t("acProposalRowStatsT107"), rows.length], [t("apBuildConvItemH35"), rows.filter((row) => row.status === "active").length]]));
  const list = wbEl("div", "wb-list");
  const runsPv = wbEl("div", "wb-runs-pv");
  if (!rows.length) list.appendChild(wbEl("div", "wb-list-empty", t("acProposalRowwbElT368")));
  rows.forEach((row) => {
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("span", "wb-badge " + (row.status === "active" ? "wb-badge-ok" : "wb-badge-dim"), row.status === "active" ? t("autoRunning") : t("autoPaused")));
    it.appendChild(wbEl("b", "", esc(row.name)));
    it.appendChild(wbEl("span", "wb-list-sub", esc((row.cron || row.schedule || "—") + " · " + t(row.lastRunAt ? "autoLastRun" : "autoNever", { t: row.lastRunAt ? new Date(row.lastRunAt).toLocaleString() : "" }))));
    const acts = wbEl("span", "wb-list-actions");
    acts.appendChild(wbBtn(t("acProposalRowwbBtnT108"), "wb-btn-mini", async () => {
      const x = await wbPost("/api/automations/" + encodeURIComponent(row.id) + "/run");
      wbSaved(x.ok ? t("acProposalRowwbSavedT49") : x.error || t("apOnOrchStepFailtextContentT55"), !x.ok);
    }));
    acts.appendChild(wbBtn(row.status === "active" ? t("acProposalRowwbBtnT109") : t("autoResume"), "wb-btn-mini", async () => {
      await wbPost("/api/automations/" + encodeURIComponent(row.id) + "/" + (row.status === "active" ? "pause" : "resume"));
      wbReloadInto(box, "automations");
    }));
    acts.appendChild(wbBtn(t("acDecBadgewbElT372"), "wb-btn-mini", async () => {
      const x = await wbGet("/api/automations/" + encodeURIComponent(row.id) + "/runs");
      const runs = x.runs || [];
      wbShowPreview(runsPv, runs.length
        ? runs.map((run) => new Date(run.at || run.ts || 0).toLocaleString() + "  " + (run.status || "") + " " + String(run.summary || run.error || "").slice(0, 60)).join("\n")
        : "还没有执行记录");
    }));
    acts.appendChild(wbBtn(t("delete"), "wb-btn-mini wb-btn-danger", async () => {
      if (!confirm(t("acProposalRowconfirmT50") + row.name + "」？")) return;
      await wbDel("/api/automations/" + encodeURIComponent(row.id));
      wbSaved(t("skillDeleted"));
      wbReloadInto(box, "automations");
    }));
    it.appendChild(acts);
    list.appendChild(it);
  });
  g0.appendChild(list);
  g0.appendChild(wbAction(t("acProposalRowwbActionT369"), t("acProposalRowwbActionT370"), t("acProposalRowwbActionT371"), () => {
    if (typeof openAutomations === "function") openAutomations(); else toast(t("acProposalRowtoastT51"));
  }, { primary: true }, "automation cron 新建 定时"));
  box.appendChild(g0);
}

/* ============================================================
   行为审计 = 两份台账，一个入口
     动作流水：Agent 每次写文件 / 删文件 / 跑命令（.pancode/audit/<日期>.log，一行一句人话）
     决策链  ：每一步当时怎么判断的（.pancode/decisions/<日期>.jsonl，结构化、按会话可还原）
   两者刻意分开：前者回答"它动了什么"，后者回答"它为什么可以动 / 谁说不行的"。
   ============================================================ */
const AUD = { date: "", view: "ops", kind: "", onlyThis: false, cdate: "" };

const DEC_KIND_LABEL = { gate: "权限门", approval: "人工审批", choice: "方案选择", grant: "会话授权", compact: "上下文压缩", mode: "模式变更", hook: "规则拦截" };
const DEC_ACTION_LABEL = {
  allow: "放行", block: "拦截", ask: "询问", approved: "已批准", rejected: "已拒绝", timeout: "超时自动拒",
  picked: "已选", cancelled: "超时未选", granted: "本会话免确认", kept: "保留", compressed: "已压缩",
  abandoned: "放弃", switched: "已切换", none: "记录",
};
const DEC_OK_ACTIONS = { allow: 1, approved: 1, picked: 1, granted: 1, compressed: 1, switched: 1, kept: 1 };
const DEC_BAD_ACTIONS = { block: 1, rejected: 1, timeout: 1, cancelled: 1, abandoned: 1 };

function decBadge(action) {
  const cls = DEC_OK_ACTIONS[action] ? "wb-badge-ok" : DEC_BAD_ACTIONS[action] ? "wb-badge-err" : "wb-badge-warn";
  return wbEl("span", "wb-badge " + cls, esc(DEC_ACTION_LABEL[action] || action || t("acDecBadgewbElT372")));
}
function decKindBadge(kind) {
  return wbEl("span", "wb-badge wb-badge-dim", esc(DEC_KIND_LABEL[kind] || kind || t("acDecKindBadgewbElT373")));
}

async function wbRenderAudit(box) {
  box.innerHTML = "";
  const host = wbEl("div", "wb-audit-host");
  box.appendChild(host);
  const paint = async () => {
    host.innerHTML = "";
    if (AUD.view === "chain") await auditChainView(host, paint);
    else await auditOpsView(host, paint);
  };
  await paint();
}

/* 顶部那枚切换条由两个视图各自渲染：切过去时另一个视图的状态（日期/筛选）都留着，
   来回切不把人已经选好的筛选重置掉。 */
function auditSwitch(onPick) {
  const seg = wbSeg(t("acAuditSwitchwbSegT374"), t("acAuditSwitchwbSegT375"),
    [{ v: "ops", t: t("acAuditSwitchtT376") }, { v: "chain", t: t("acAuditSwitchtT377") }], AUD.view, async (v) => { AUD.view = v; await onPick(); });
  return seg;
}

async function auditOpsView(box, repaint) {
  box.appendChild(auditSwitch(repaint));
  let dates = [];
  try { dates = (await wbGet("/api/audit/dates")).dates || []; } catch (e) { /* 首日无日志 */ }
  const g0 = wbGroup(t("acAuditSwitchwbGroupT378"), t("acAuditSwitchwbGroupT379"));
  if (!dates.length) {
    g0.appendChild(wbEl("div", "wb-list-empty", t("acAuditSwitchwbElT380")));
    box.appendChild(g0);
    return;
  }
  if (!AUD.date || !dates.includes(AUD.date)) AUD.date = dates[0];
  const row = wbRow(t("acAuditSwitchwbRowT110"), t("acAuditSwitchwbRowT111") + dates.length + t("acAuditSwitchwbRowT52"));
  const sel = wbEl("select", "wb-select");
  dates.forEach((d) => { const o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); });
  sel.value = AUD.date;
  const body = wbEl("div", "wb-list wb-audit");
  const load = async () => {
    body.innerHTML = "";
    const r = await wbGet("/api/audit?date=" + encodeURIComponent(sel.value) + "&limit=400");
    const lines = r.lines || [];
    if (!lines.length) { body.appendChild(wbEl("div", "wb-list-empty", t("acAuditSwitchwbElT382"))); return; }
    lines.slice().reverse().forEach((ln) => {
      const parts = String(ln).split("|");
      const it = wbEl("div", "wb-list-item");
      const act = (parts[2] || "").trim();
      it.appendChild(wbEl("span", "wb-badge " + (/delete|remove|rm/i.test(act) ? "wb-badge-err" : /write|edit|commit|patch/i.test(act) ? "wb-badge-blue" : "wb-badge-dim"), esc(act || "event")));
      it.appendChild(wbEl("code", "", esc((parts[3] || "").trim())));
      it.appendChild(wbEl("span", "wb-list-sub", esc((parts[1] || "").trim() + " " + (parts[0] || "").trim())));
      body.appendChild(it);
    });
  };
  sel.onchange = load;
  row.ctrl.appendChild(sel);
  g0.appendChild(row);
  g0.appendChild(body);
  box.appendChild(g0);
  load();
}

async function auditChainView(box, repaint) {
  box.appendChild(auditSwitch(repaint));
  let dates = [];
  try { dates = (await wbGet("/api/decisions/dates")).dates || []; } catch (e) { /* 首日无记录 */ }
  const g = wbGroup(t("acAuditSwitchtT377"), t("acAuditSwitchwbGroupT383"));
  if (!dates.length) {
    g.appendChild(wbEl("div", "wb-list-empty", t("acAuditSwitchwbElT384")));
    box.appendChild(g);
    return;
  }
  if (!AUD.cdate || !dates.includes(AUD.cdate)) AUD.cdate = dates[0];
  const dRow = wbRow(t("acAuditSwitchwbRowT110"), t("acAuditSwitchwbRowT111") + dates.length + t("acAuditSwitchwbRowT53"));
  const sel = wbEl("select", "wb-select");
  dates.forEach((d) => { const o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); });
  sel.value = AUD.cdate;
  dRow.ctrl.appendChild(sel);
  g.appendChild(dRow);
  g.appendChild(wbToggle(t("acAuditSwitchwbToggleT385"), t("acAuditSwitchwbToggleT386"),
    AUD.onlyThis, (v) => { AUD.onlyThis = v; load(); }));

  const chips = wbEl("div", "wb-chips wb-decision-filters");
  g.appendChild(chips);
  const body = wbEl("div", "wb-list wb-decisions");
  const load = async () => {
    body.innerHTML = "";
    let r;
    try { r = await wbGet("/api/decisions?date=" + encodeURIComponent(sel.value) + "&limit=500"); }
    catch (e) { body.appendChild(wbEl("div", "wb-list-empty", t("acAuditSwitchwbElT112") + (e.message || e))); return; }
    const all = r.decisions || [];
    const conv = (typeof convId !== "undefined" && convId) ? String(convId) : "default";
    const rows = all.filter((d) => (!AUD.onlyThis || String(d.convId) === conv) && (!AUD.kind || d.kind === AUD.kind));
    /* 分类 chip 上的数字与"这一天真实有哪些 kind"同源，不预先摆一排点了必为空的按钮 */
    const byKind = {};
    all.forEach((d) => { byKind[d.kind] = (byKind[d.kind] || 0) + 1; });
    chips.innerHTML = "";
    const mk = (k, t, n) => {
      const c = wbEl("button", "wb-btn wb-btn-sm" + (AUD.kind === k ? " active" : ""), t + (n ? " " + n : ""));
      c.onclick = () => { AUD.kind = AUD.kind === k ? "" : k; load(); };
      chips.appendChild(c);
    };
    mk("", "全部", all.length);
    Object.keys(byKind).sort((a, b) => byKind[b] - byKind[a]).forEach((k) => mk(k, DEC_KIND_LABEL[k] || k, byKind[k]));
    if (!all.length) { body.appendChild(wbEl("div", "wb-list-empty", t("acAuditSwitchwbElT388"))); return; }
    if (!rows.length) { body.appendChild(wbEl("div", "wb-list-empty", t("acAuditSwitchwbElT389"))); return; }
    rows.slice().reverse().forEach((d) => {
      const it = wbEl("div", "wb-list-item wb-decision");
      it.appendChild(decKindBadge(d.kind));
      it.appendChild(decBadge(d.action));
      if (d.irreversible) it.appendChild(wbEl("span", "wb-badge wb-badge-warn", t("acAuditSwitchwbElT390")));
      const head = wbEl("div", "wb-decision-head");
      /* 没有工具名的记录（选了方案、改了权限档）不再补一个和左侧分类徽标重复的词——
         同一行里"方案选择"出现两次，读起来像渲染坏了。 */
      if (d.tool) head.appendChild(wbEl("code", "", esc(d.tool)));
      if (d.subject) head.appendChild(wbEl("span", "wb-decision-subject", esc(d.subject)));
      head.appendChild(wbEl("span", "wb-list-sub", esc(new Date(d.ts).toLocaleTimeString() + t("acAuditSwitchwbElT113") + (d.convId || "default") + (d.mode ? " · " + d.mode : ""))));
      it.appendChild(head);
      if (d.reason) it.appendChild(wbEl("div", "wb-decision-reason", esc(d.reason)));
      const detail = wbEl("div", "wb-decision-detail");
      detail.style.display = "none";
      if (d.detail) detail.appendChild(wbEl("pre", "wb-diff", esc(String(d.detail))));
      it.appendChild(detail);
      it.onclick = () => { detail.style.display = detail.style.display === "none" ? "block" : "none"; };
      body.appendChild(it);
    });
  };
  sel.onchange = load;
  g.appendChild(body);
  box.appendChild(g);
  load();
}

/* ============================================================
   注册分区
   ============================================================ */
wbRegister({ id: "experts", group: "assets", titleKey: "acAuditSwitchtitleT392", icon: "agent", descKey: "acAuditSwitchdescT393", keywords: "expert persona role 角色 人格 专家", render: wbRenderExperts });
wbRegister({ id: "soul", group: "assets", titleKey: "acAuditSwitchtitleT394", icon: "soul", descKey: "acAuditSwitchdescT395", keywords: "soul values boundaries principles proposal 灵魂 价值 边界 原则 提案", render: wbRenderSoul });
wbRegister({ id: "memory", group: "assets", titleKey: "acAuditSwitchtitleT396", icon: "memory", descKey: "acAuditSwitchdescT397", keywords: "memory lesson preference recall prune 记忆 经验 教训 遗忘 归档", render: wbRenderMemory });
wbRegister({ id: "sediment", group: "assets", titleKey: "sediment", icon: "save", descKey: "acAuditSwitchdescT398", keywords: "sediment distill 沉淀 提炼 规则 记忆", render: wbRenderSediment });
wbRegister({ id: "rules", group: "assets", titleKey: "acMemFormwbElT296", icon: "md", descKey: "acAuditSwitchdescT399", keywords: "rules agents md cursor glob 规则 约束 按需", render: wbRenderRules });
wbRegister({ id: "skills", group: "assets", titleKey: "acAuditSwitchtitleT400", icon: "toolbox", descKey: "acAuditSwitchdescT401", keywords: "skill skills trigger 技能 触发 导入 导出", render: wbRenderSkills });
wbRegister({ id: "evolution", group: "assets", titleKey: "acAuditSwitchtitleT402", icon: "leaf", descKey: "acAuditSwitchdescT403", keywords: "evolution xp stage path timeline rule proposal 进化 阶段 路线 时间线 规则提案 采纳 忽略 自进化", render: wbRenderEvolution });
wbRegister({ id: "automations", group: "engine", titleKey: "acAuditSwitchtitleT404", icon: "clock", descKey: "acAuditSwitchdescT405", keywords: "automation cron schedule 自动化 定时 任务", render: wbRenderAutomations });
wbRegister({ id: "audit", group: "data", titleKey: "wbDatawbGroupT205", icon: "history", descKey: "acAuditSwitchdescT406", keywords: "audit log 审计 日志 操作 决策 批准 拒绝 放行 拦截 chain", render: wbRenderAudit });
