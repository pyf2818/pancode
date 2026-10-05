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
  top.appendChild(wbEl("span", "wb-side-name", esc(o.title)));
  (o.badges || []).forEach((b) => top.appendChild(wbEl("span", "wb-badge " + (b.cls || "wb-badge-dim"), esc(b.text))));
  it.appendChild(top);
  if (o.sub) it.appendChild(wbEl("div", "wb-side-sub", esc(o.sub)));
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
  h.appendChild(wbEl("h3", "", esc(title)));
  if (desc) h.appendChild(wbEl("p", "", esc(desc)));
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
  try { r = await wbGet("/api/experts"); } catch (e) { box.appendChild(wbNote("加载失败：" + e.message, "err")); return; }
  if (!r.ok) { box.appendChild(wbNote(r.error || "加载失败", "err")); return; }
  EXP.rows = r.experts; EXP.active = r.active; EXP.customPrompt = r.customPrompt || "";
  box.appendChild(wbStats([
    ["总计", r.experts.length],
    ["内置", r.experts.filter((x) => x.builtin).length],
    ["自建", r.experts.filter((x) => !x.builtin).length],
    ["当前", EXP.active === "custom" ? "自定义" : EXP.active === "default" ? "无" : EXP.active],
  ]));
  const { list, detail } = wbSplit(box, wbToolbar("筛选专家…", (q) => { EXP.q = q; paintExperts(); }, [
    { text: "+ 新建专家", primary: true, run: () => { EXP.picked = "__new__"; paintExperts(); } },
  ]));
  EXP._list = list; EXP._detail = detail;
  paintExperts();
}
function paintExperts() {
  const list = EXP._list, detail = EXP._detail;
  if (!list) return;
  list.innerHTML = "";
  const rows = EXP.q ? EXP.rows.filter((e) => (e.name + " " + (e.description || "")).toLowerCase().includes(EXP.q)) : EXP.rows;
  if (!rows.length) list.appendChild(wbEl("div", "wb-list-empty", "没有匹配的专家"));
  rows.forEach((e) => {
    list.appendChild(wbSideItem({
      title: e.name,
      active: EXP.picked === e.id,
      badges: [
        e.active ? { text: "当前", cls: "wb-badge-ok" } : null,
        e.builtin ? { text: "内置" } : { text: e.source === "user" ? "用户级" : "项目级", cls: "wb-badge-blue" },
        (e.unknownTools || []).length ? { text: "工具存疑", cls: "wb-badge-warn" } : null,
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
  if (!r.ok) { wbSaved(r.error || "失败", true); return false; }
  if (r.experts) EXP.rows = r.experts;
  if (r.active) EXP.active = r.active;
  if (r.customPrompt != null) EXP.customPrompt = r.customPrompt;
  paintExperts();
  return true;
}
/* 右侧默认页：当前常驻角色 */
function expertCurrentRole(detail) {
  detail.innerHTML = "";
  detail.appendChild(wbHead("当前角色", "常驻角色每一轮都注入；@专家名 只在单条消息里临时换人。"));
  detail.appendChild(wbSeg("常驻角色", "",
    [{ v: "default", t: "无（默认）" }, { v: "custom", t: "自定义人格" }]
      .concat(EXP.rows.map((e) => ({ v: e.id, t: e.name }))),
    EXP.active, async (v) => {
      const r = await wbPost("/api/experts/active", { active: v });
      if (!await applyExpertsResp(r)) return;
      wbSaved("当前角色已切换");
    }, "persona role active 角色"));
  wbField(detail, "自定义人格正文", "仅「自定义人格」模式下注入；写身份、口吻与硬约束", EXP.customPrompt, "area", (v) => { EXP.customPrompt = v; });
  const acts = wbEl("div", "wb-detail-actions");
  acts.appendChild(wbBtn("保存人格", "wb-btn-primary", async () => {
    const r = await wbPost("/api/experts/active", { active: "custom", systemPrompt: EXP.customPrompt });
    if (await applyExpertsResp(r)) wbSaved("已保存并启用");
  }));
  acts.appendChild(wbBtn("预览注入效果", "", async () => {
    const r = await wbGet("/api/experts/preview?" + (EXP.active === "custom" ? "custom=" + encodeURIComponent(EXP.customPrompt) : "id=" + encodeURIComponent(EXP.active)));
    wbShowPreview(detail, r.preview || "（无角色层注入）");
  }));
  detail.appendChild(acts);
  detail.appendChild(wbNote("内置专家不可直接改；在专家包里放同名 .md 即可覆盖——选左侧任一项可编辑自建专家。", "dim"));
}
function expertForm(detail, e) {
  detail.innerHTML = "";
  const isNew = !e;
  const f = e ? {
    name: e.name, description: e.description || "", role: e.role || "", methodology: e.methodology || "",
    tool_whitelist: (e.tool_whitelist || []).join(", "), scope: e.source === "user" ? "user" : "project",
  } : { name: "", description: "", role: "", methodology: "", tool_whitelist: "", scope: "project" };
  detail.appendChild(wbHead(isNew ? "新建专家" : e.name, isNew ? "两段正文：第一段是角色定位，第二段起是方法论（保留 ## 小标题原样注入）。" : (e.builtin ? "内置专家（只读）· 可另存为项目级副本" : (e.source === "user" ? "用户级专家包" : "项目级专家包"))));
  if (e && e.unknownTools && e.unknownTools.length) {
    detail.appendChild(wbNote("白名单里有 " + e.unknownTools.length + " 个当前不存在的工具：" + e.unknownTools.join(", ") + "——它们会被忽略，该工具将无法被这位专家调用。", "warn"));
  }
  if (e && e.builtin) detail.appendChild(wbNote("内置专家只读。改法：拉到最下面点「另存为项目级副本」，副本可自由编辑并会覆盖同名内置。", "dim"));
  wbField(detail, "名称", "同时作为文件名与 @ 引用名", f.name, "text", (v) => { f.name = v; });
  wbField(detail, "一句话描述", "出现在列表与选择器里", f.description, "text", (v) => { f.description = v; });
  wbField(detail, "角色定位", "它是谁、目标是什么、语气如何", f.role, "area", (v) => { f.role = v; });
  wbField(detail, "方法论", "步骤、清单、注意事项——模型会原样看到", f.methodology, "area", (v) => { f.methodology = v; });
  wbField(detail, "工具白名单", "逗号分隔；留空 = 不限制", f.tool_whitelist, "text", (v) => { f.tool_whitelist = v; });
  const scopeRow = wbRow("存放位置", "项目级跟着仓库走，用户级跨项目可用");
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
    acts.appendChild(wbBtn("创建", "wb-btn-primary", async (b) => {
      b.disabled = true;
      const r = await wbPost("/api/experts", payload());
      b.disabled = false;
      if (await applyExpertsResp(r)) { EXP.picked = r.id; wbSaved("已创建"); }
    }));
    acts.appendChild(wbBtn("取消", "", () => { EXP.picked = null; paintExperts(); }));
  } else if (e.builtin) {
    acts.appendChild(wbBtn("另存为项目级副本", "wb-btn-primary", async () => {
      const p = payload();
      p.name = (p.name || "副本") + "（改）";
      const r = await wbPost("/api/experts", p);
      if (await applyExpertsResp(r)) { EXP.picked = r.id; wbSaved("已另存为副本"); }
    }));
  } else {
    acts.appendChild(wbBtn("保存", "wb-btn-primary", async () => {
      const r = await wbPut("/api/experts/" + encodeURIComponent(e.id), payload());
      if (await applyExpertsResp(r)) wbSaved("已保存");
    }));
    acts.appendChild(wbBtn("设为当前角色", "", async () => {
      const r = await wbPost("/api/experts/active", { active: e.id });
      if (await applyExpertsResp(r)) wbSaved("当前角色：" + e.name);
    }));
    acts.appendChild(wbBtn("导出 Markdown", "", async () => {
      const r = await wbGet("/api/experts/export/" + encodeURIComponent(e.id));
      wbShowPreview(detail, r.ok ? r.markdown : "导出失败：" + r.error);
    }));
    acts.appendChild(wbBtn("删除", "wb-btn-danger", async () => {
      if (!confirm("删除专家「" + e.name + "」？落盘的 .md 会被移除，不可撤销。")) return;
      const r = await wbDel("/api/experts/" + encodeURIComponent(e.id));
      if (!r.ok) return wbSaved(r.error || "删除失败", true);
      EXP.picked = null;
      await applyExpertsResp(r);
      wbSaved("已删除");
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
  try { r = await wbGet("/api/soul"); } catch (e) { box.appendChild(wbNote("加载失败：" + e.message, "err")); return; }
  if (!r.ok) { box.appendChild(wbNote(r.error || "加载失败", "err")); return; }
  const s = r.soul;
  const put = async (patch) => { const x = await wbPut("/api/soul", patch); if (x.ok) wbSaved("已保存"); else wbSaved(x.error || "保存失败", true); };
  box.appendChild(wbStats([["价值观", s.values.length], ["边界", s.boundaries.length], ["原则", s.principles.length], ["待确认", r.pending]]));

  const g0 = wbGroup("身份", "名字与气质会出现在界面与系统提示词里。");
  g0.appendChild(wbKV("名字", s.name));
  g0.appendChild(wbSeg("气质", "影响语气取向", [{ v: "warm", t: "温和" }, { v: "sharp", t: "利落" }, { v: "nerd", t: "极客" }], s.vibe, (v) => put({ vibe: v }), "vibe soul"));
  g0.appendChild(wbInput("表情符号", "用在标题与气泡上", s.emoji, (v) => v && put({ emoji: v }), null, "emoji soul"));
  box.appendChild(g0);

  const g1 = wbGroup("条目", "越具体越好用；空泛的口号模型无从执行。");
  const chips = (key, items, label) => {
    const row = wbRow(label, "", key);
    row.ctrl.appendChild((function () {
      let cur = (items || []).slice();
      const boxEl = wbEl("div", "wb-chips");
      const draw = () => {
        boxEl.innerHTML = "";
        if (!cur.length) boxEl.appendChild(wbEl("span", "wb-chips-empty", "（空）"));
        cur.forEach((v, i) => {
          const c = wbEl("span", "wb-chip");
          c.appendChild(wbEl("code", "", esc(v)));
          const x = wbEl("button", "wb-chip-x", "✕");
          x.type = "button";
          x.onclick = () => { cur = cur.slice(); cur.splice(i, 1); draw(); const p = {}; p[key] = cur; put(p); };
          c.appendChild(x);
          boxEl.appendChild(c);
        });
      };
      draw();
      const add = wbEl("input", "wb-input wb-chip-add");
      add.placeholder = "写一条，回车添加";
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
  g1.appendChild(chips("values", s.values, "价值观"));
  g1.appendChild(chips("boundaries", s.boundaries, "边界"));
  g1.appendChild(wbNote("边界是硬红线：删掉一条，Agent 对相应风险的默认判断会一并放松。", "warn"));
  g1.appendChild(chips("principles", s.principles, "原则"));
  box.appendChild(g1);

  const g2 = wbGroup("提案收件箱", "Agent 完成任务后会提议微调灵魂——只有你点「接受」才生效。");
  const plist = wbEl("div", "wb-list");
  const props = s.proposals || [];
  if (!props.length) plist.appendChild(wbEl("div", "wb-list-empty", "还没有提案"));
  props.forEach((p) => {
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("span", "wb-badge " + (p.status === "accepted" ? "wb-badge-ok" : p.status === "rejected" ? "wb-badge-dim" : "wb-badge-warn"),
      p.status === "accepted" ? "已接受" : p.status === "rejected" ? "已拒绝" : "待确认"));
    it.appendChild(wbEl("b", "", esc(p.content)));
    it.appendChild(wbEl("span", "wb-list-sub", esc((p.target || "") + (p.reason ? " · " + p.reason : ""))));
    const acts = wbEl("span", "wb-list-actions");
    if (p.status === "pending") {
      acts.appendChild(wbBtn("接受", "wb-btn-primary", async () => {
        const x = await wbPut("/api/soul/proposal/" + encodeURIComponent(p.id) + "?accept=1");
        if (x.ok) { wbSaved("已写入" + p.target); wbReloadInto(box, "soul"); }
      }));
      acts.appendChild(wbBtn("拒绝", "", async () => {
        await wbPut("/api/soul/proposal/" + encodeURIComponent(p.id) + "?accept=0");
        wbReloadInto(box, "soul");
      }));
    }
    acts.appendChild(wbBtn("移除记录", "wb-btn-mini", async () => {
      await wbDel("/api/soul/proposal/" + encodeURIComponent(p.id));
      wbReloadInto(box, "soul");
    }));
    it.appendChild(acts);
    plist.appendChild(it);
  });
  g2.appendChild(plist);
  g2.appendChild(wbAction("重置为出厂灵魂", "清空自定义条目与全部提案记录，不可撤销", "重置", async () => {
    if (!confirm("确定重置？你自定的价值观 / 边界 / 原则与提案历史都会清空。")) return;
    const x = await wbPost("/api/soul/reset", {});
    if (!x.ok) return wbSaved(x.error || "重置失败", true);
    wbSaved("已重置");
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
  [["project", "项目记忆"], ["user", "用户记忆"]].forEach(([v, t]) => {
    const b = wbEl("button", MEM.scope === v ? "active" : "", t);
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
  search.placeholder = "搜索记忆…";
  search.value = MEM.q;
  let tm = null;
  search.oninput = () => { clearTimeout(tm); tm = setTimeout(() => { MEM.q = search.value.trim(); memReload(); }, 200); };
  filters.appendChild(search);
  filters.appendChild(wbBtn("+ 手写一条", "wb-btn-primary", () => { MEM.picked = "__new__"; paintMems(); }));
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
  MEM._stats.appendChild(wbStats([["库内", r.total], ["将注入", st.injected], ["衰减中", st.atRisk], ["已归档", st.archived], ["长期保留", st.sticky], ["平均强度", st.avgStrength]]));
  MEM._stats.appendChild(wbNote("进上下文 = 未归档 + 有效强度 ≥ 1.5，再分两条道：偏好与归纳产物「常驻」，每轮无条件在场；经验/决策/报错「按相关性」，只有本轮问的话与它有词元交集才注入。同主题每轮最多 2 条，凑数式注入已取消。强度 < 2.5 会先归档（可恢复），< 0.5 会被裁剪。", "dim"));
  const acts = wbEl("div", "wb-inline-actions");
  acts.appendChild(wbBtn("立即整理（裁剪低强度）", "", async () => {
    const x = await wbPost("/api/memory/prune", { scope: MEM.scope });
    if (!x.ok) return wbSaved(x.error || "失败", true);
    wbSaved("删除 " + x.removed + " 条，归档 " + x.archived + " 条");
    memReload();
  }));
  acts.appendChild(wbBtn("清空归档", "", async () => {
    const x = await wbPost("/api/memory/purge", { scope: MEM.scope });
    if (!x.ok) return wbSaved(x.error || "失败", true);
    wbSaved("清除 " + x.removed + " 条归档");
    memReload();
  }));
  acts.appendChild(wbBtn("最近实际注入", "", async () => {
    const x = await wbGet("/api/memory/used");
    const rows = (x.entries || []);
    MEM._detail.innerHTML = "";
    MEM._detail.appendChild(wbHead("最近一轮实际注入", "不是「库里有什么」，而是「模型这轮真读到了什么」。"));
    if (!rows.length) MEM._detail.appendChild(wbEl("div", "wb-list-empty", "本轮还没有记忆注入记录（新会话或记忆开关关闭）"));
    rows.forEach((e) => {
      const it = wbEl("div", "wb-list-item");
      it.appendChild(wbEl("span", "wb-badge", esc(e.type)));
      it.appendChild(wbEl("b", "", esc(e.topic || "未命名")));
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
  if (!MEM.rows.length) list.appendChild(wbEl("div", "wb-list-empty", "没有符合条件的记忆"));
  MEM.rows.forEach((e) => {
    list.appendChild(wbSideItem({
      title: (e.topic || e.type) + "：" + e.content.slice(0, 26),
      active: MEM.picked === e.id,
      badges: [
        e.archived ? { text: "已归档" } : null,
        e.sticky ? { text: "长期", cls: "wb-badge-blue" } : null,
        e.injected ? { text: e.lane === "resident" ? "常驻" : "按相关性", cls: "wb-badge-ok" } : null,
        e.risk === "drop" ? { text: "将被裁剪", cls: "wb-badge-err" } : e.risk === "archive" ? { text: "将被归档", cls: "wb-badge-warn" } : null,
        e.source === "sediment" ? { text: "沉淀" } : e.source === "manual" ? { text: "手写" } : null,
      ].filter(Boolean),
      sub: "[" + e.type + "] 强度 " + e.strength + " · 访问 " + (e.accessCount || 0) + " 次 · " + (e.ageDays === 0 ? "今天" : e.ageDays + " 天前"),
      bar: e.strength * 16,
      barCls: e.strength >= 4 ? "wb-bar-hi" : e.strength < 1.5 ? "wb-bar-lo" : "",
      on: () => { MEM.picked = e.id; paintMems(); },
    }));
  });
  if (MEM.picked === "__new__") memForm(detail, null);
  else if (MEM.picked) memForm(detail, MEM.rows.find((x) => x.id === MEM.picked) || null);
  else detail.appendChild(wbEmpty("从左侧选一条记忆，或手写一条新的"));
}
function memForm(detail, e) {
  detail.innerHTML = "";
  const f = e ? { type: e.type, topic: e.topic, content: e.content, valueScore: e.valueScore == null ? 2 : e.valueScore, sticky: !!e.sticky }
    : { type: "lesson", topic: "", content: "", valueScore: 3, sticky: false };
  detail.appendChild(wbHead(e ? "编辑记忆" : "新增记忆", e ? "" : "写陈述句，别写「这个」「刚才」这类对话指代——下一轮模型看不到上下文。"));
  wbField(detail, "类型", "决定衰减速度与注入权重", f.type,
    { select: ["preference", "lesson", "pattern", "decision", "error", "skill"], labels: { preference: "偏好", lesson: "经验", pattern: "模式", decision: "决策", error: "教训", skill: "技能" } },
    (v) => { f.type = v; });
  wbField(detail, "主题", "同一主题下的近似内容会被自动合并", f.topic, "text", (v) => { f.topic = v; });
  const cRow = wbRow("内容", "一条只说一件事");
  const ta = wbEl("textarea", "wb-textarea");
  ta.rows = 6;
  ta.value = f.content;
  ta.oninput = () => { f.content = ta.value; };
  cRow.ctrl.appendChild(ta);
  detail.appendChild(cRow);
  wbField(detail, "价值分", "1–5，越高越难被遗忘", f.valueScore, "number", (v) => { f.valueScore = v; });
  detail.appendChild(wbToggle("长期保留", "豁免遗忘曲线裁剪", f.sticky, (v) => { f.sticky = v; }));
  if (e) {
    detail.appendChild(wbKV("来源", e.source || "auto"));
    detail.appendChild(wbKV("访问次数", e.accessCount || 0));
    detail.appendChild(wbKV("有效强度", e.strength));
    detail.appendChild(wbKV("该类型 TTL", e.ttlDays + " 天"));
  }
  const acts = wbEl("div", "wb-detail-actions");
  acts.appendChild(wbBtn(e ? "保存" : "写入", "wb-btn-primary", async () => {
    if (!String(f.content).trim()) return wbSaved("内容不能为空", true);
    const body = Object.assign({}, f, { scope: MEM.scope });
    const r = e ? await wbPut("/api/memory/" + encodeURIComponent(e.id), body) : await wbPost("/api/memory", body);
    if (!r.ok) return wbSaved(r.error || "失败", true);
    wbSaved(e ? "已保存" : "已写入");
    MEM.picked = null;
    await memReload();
  }));
  if (e) {
    acts.appendChild(wbBtn(e.archived ? "恢复生效" : "归档", "", async () => {
      const r = await wbPost("/api/memory/" + encodeURIComponent(e.id) + "/archive", { archived: !e.archived, scope: MEM.scope });
      if (!r.ok) return wbSaved(r.error || "失败", true);
      wbSaved(e.archived ? "已恢复" : "已归档：不再注入、不再被检索到");
      await memReload();
    }));
    acts.appendChild(wbBtn("删除", "wb-btn-danger", async () => {
      if (!confirm("彻底删除这条记忆？要可逆请改用「归档」。")) return;
      await wbDel("/api/memory/" + encodeURIComponent(e.id) + "?scope=" + MEM.scope);
      wbSaved("已删除");
      MEM.picked = null;
      await memReload();
    }));
  } else {
    detail.appendChild(wbNote("记忆不是越多越好：每轮只注入强度最高的一小批，堆太多只会互相稀释。", "dim"));
  }
  detail.appendChild(acts);
}

/* ============================================================
   沉淀
   ============================================================ */
const SED = { cands: [] };
async function wbRenderSediment(box) {
  box.innerHTML = "";
  const g0 = wbGroup("从当前会话提炼", "先看一眼本次会话，挑出「下次真用得上」的候选；你勾选后才落库。");
  const hint = wbEl("div", "wb-note wb-note-dim", "提炼结果会出现在这里。");
  const candBox = wbEl("div", "wb-cands");
  const runBtn = wbBtn("开始提炼", "wb-btn-primary", async (b) => {
    const msgs = typeof collectConvTurns === "function" ? collectConvTurns() : [];
    if (msgs.length < 2) { hint.textContent = "当前会话内容太少，没有可提炼的东西。"; return; }
    b.disabled = true; b.textContent = "提炼中…";
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
        body.appendChild(wbEl("div", "wb-cand-title", esc(c.title || "未命名") + " · " + (c.target === "rule" ? "项目规则" : "项目记忆") + (c.scope ? " / " + esc(c.scope) : "")));
        body.appendChild(wbEl("div", "wb-cand-text", esc(c.content)));
        row.appendChild(cb);
        row.appendChild(body);
        candBox.appendChild(row);
      });
      if (SED.cands.length) {
        candBox.appendChild(wbBtn("写入勾选项", "wb-btn-primary", async () => {
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
          wbSaved("已沉淀 " + n + " 条" + (errs.length ? "；" + errs.join("；") : ""), !!errs.length);
          if (n) { candBox.innerHTML = ""; hint.textContent = "已写入。去「规则」「记忆」分区可继续改。"; await sedReload(); }
        }));
      }
    } finally { b.disabled = false; b.textContent = "开始提炼"; }
  });
  const r0 = wbRow("自动提炼", "走一次大模型，只产出候选，不直接写库");
  r0.ctrl.appendChild(runBtn);
  g0.appendChild(r0);
  g0.appendChild(hint);
  g0.appendChild(candBox);
  box.appendChild(g0);

  const g1 = wbGroup("手写沉淀", "已经想清楚要留什么，直接写。");
  const fw = { target: "rule", title: "", content: "", scope: "decision" };
  const tRow = wbRow("去处", "规则 = 每轮强制注入的硬约束；记忆 = 参考性经验");
  const tgt = wbEl("div", "wb-segment");
  [["rule", "项目规则"], ["memory", "项目记忆"], ["user", "用户记忆"]].forEach(([v, t]) => {
    const b = wbEl("button", fw.target === v ? "active" : "", t);
    b.type = "button";
    b.onclick = () => { fw.target = v; [...tgt.children].forEach((x) => x.classList.remove("active")); b.classList.add("active"); };
    tgt.appendChild(b);
  });
  tRow.ctrl.appendChild(tgt);
  g1.appendChild(tRow);
  wbField(g1, "标题", "规则会作为小标题；记忆会作为 topic", "", "text", (v) => { fw.title = v; });
  const cRow = wbRow("内容", "一条只说一件事");
  const ta = wbEl("textarea", "wb-textarea");
  ta.rows = 4;
  ta.oninput = () => { fw.content = ta.value; };
  cRow.ctrl.appendChild(ta);
  g1.appendChild(cRow);
  const sRow = wbRow("", "");
  sRow.ctrl.appendChild(wbBtn("沉淀", "wb-btn-primary", async () => {
    if (!fw.content.trim()) return wbSaved("内容不能为空", true);
    const r = await wbPost("/api/sediment", fw);
    if (!r.ok) return wbSaved(r.error || "失败", true);
    ta.value = "";
    fw.content = ""; fw.title = "";
    wbSaved("已沉淀");
    await sedReload();
  }));
  g1.appendChild(sRow);
  box.appendChild(g1);

  const g2 = wbGroup("沉淀产物", "看得出去向，也能一键跳到对应分区改。");
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
  catch (e) { SED._out.appendChild(wbEl("div", "wb-list-empty wb-list-err", "加载失败：" + String((e && e.message) || e))); return; }
  if (!r.ok) { SED._out.appendChild(wbEl("div", "wb-list-empty", r.error || "加载失败")); return; }
  const rules = (r.rules || []).filter((x) => /sediment-/.test(x.file));
  const mem = r.memory || [];
  if (!rules.length && !mem.length) { SED._out.appendChild(wbEl("div", "wb-list-empty", "还没有沉淀过任何东西")); return; }
  rules.forEach((x) => {
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("span", "wb-badge wb-badge-blue", "规则"));
    it.appendChild(wbEl("code", "", esc(x.file)));
    it.appendChild(wbBtn("去编辑", "wb-btn-mini", () => openWorkbench("rules")));
    SED._out.appendChild(it);
  });
  mem.slice(0, 40).forEach((m) => {
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("span", "wb-badge", esc(m.type)));
    it.appendChild(wbEl("b", "", esc(m.topic || "未命名")));
    it.appendChild(wbEl("span", "wb-list-sub", esc(m.content.slice(0, 60))));
    it.appendChild(wbBtn("去编辑", "wb-btn-mini", () => openWorkbench("memory")));
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
  const { list, detail } = wbSplit(box, wbToolbar("筛选规则…", (q) => { RULE.q = q; paintRules(); }, [
    { text: "+ 新建规则", primary: true, run: () => { RULE.picked = "__new__"; paintRules(); } },
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
  st.appendChild(wbStats([["规则源", r.counts.total], ["本轮生效", r.counts.active], ["已停用", r.counts.off], ["按需", r.counts.conditional], ["可编辑", r.counts.editable]]));
  const pct = Math.min(100, Math.round((r.budget.chars / r.budget.max) * 100));
  const bar = wbEl("div", "wb-bar wb-bar-wide");
  const fill = wbEl("i", "", "");
  fill.style.width = Math.max(1, pct) + "%";
  if (pct > 80) fill.className = "wb-bar-lo";
  bar.appendChild(fill);
  st.appendChild(bar);
  st.appendChild(wbNote("占用 " + r.budget.chars + " / " + r.budget.max + " 字符（" + pct + "%）。超出预算的规则会被省略并显式告知模型，不静默丢弃。" + (r.enabledGlob ? "" : "　注意：规则注入总开关当前是关闭的。"), pct > 80 || !r.enabledGlob ? "warn" : "dim"));
  paintRules();
  renderRulePreview(RULE._pv);
}
function paintRules() {
  const list = RULE._list, detail = RULE._detail;
  if (!list) return;
  list.innerHTML = "";
  const rows = RULE.q ? RULE.rows.filter((x) => (x.file + " " + x.title + " " + x.excerpt).toLowerCase().includes(RULE.q)) : RULE.rows;
  if (!rows.length) list.appendChild(wbEl("div", "wb-list-empty", "还没有规则。用沉淀写入，或在这里新建。"));
  rows.forEach((x) => {
    list.appendChild(wbSideItem({
      title: x.title,
      active: RULE.picked === x.file,
      badges: [
        x.active ? { text: "生效", cls: "wb-badge-ok" } : { text: x.enabled ? "未命中" : "停用", cls: x.enabled ? "wb-badge-warn" : "wb-badge-dim" },
        x.editable ? null : { text: x.scope === "app" ? "应用级" : "只读", cls: "wb-badge-dim" },
        x.kind !== "pancode" ? { text: x.kindLabel } : null,
        x.globs && x.globs.length ? { text: "按需", cls: "wb-badge-blue" } : null,
      ].filter(Boolean),
      sub: x.file + " · " + x.chars + " 字" + (x.globs && x.globs.length ? " · " + x.globs.join(" ") : ""),
      on: () => { RULE.picked = x.file; paintRules(); },
    }));
  });
  if (RULE.picked === "__new__") ruleForm(detail, null);
  else if (RULE.picked) ruleForm(detail, RULE.rows.find((x) => x.file === RULE.picked) || null);
  else detail.appendChild(wbEmpty("从左侧选一条规则"));
}
function ruleForm(detail, x) {
  detail.innerHTML = "";
  const isNew = !x;
  if (isNew) {
    detail.appendChild(wbHead("新建规则", "写入工作区 .pancode/rules/<名称>.md，Agent 每轮强制读取。"));
    const f = { title: "", globs: "", content: "" };
    wbField(detail, "标题", "同时作为文件名", f.title, "text", (v) => { f.title = v; });
    wbField(detail, "适用范围（glob）", "留空 = 始终注入；填 server/** 只在改到后端文件时注入", "", "text", (v) => { f.globs = v; });
    const cRow = wbRow("正文", "Markdown 原样注入，建议用 ## 分条");
    const ta = wbEl("textarea", "wb-textarea");
    ta.rows = 8;
    ta.oninput = () => { f.content = ta.value; };
    cRow.ctrl.appendChild(ta);
    detail.appendChild(cRow);
    const acts = wbEl("div", "wb-detail-actions");
    acts.appendChild(wbBtn("创建", "wb-btn-primary", async () => {
      if (!String(f.title).trim()) return wbSaved("标题不能为空", true);
      if (!String(f.content).trim()) return wbSaved("正文不能为空", true);
      const r = await wbPost("/api/rules", {
        title: f.title.trim(), globs: String(f.globs).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean), content: f.content,
      });
      if (!r.ok) return wbSaved(r.error || "失败", true);
      RULE.picked = r.file;
      wbSaved("已创建");
      await ruleReload();
    }));
    detail.appendChild(acts);
    return;
  }
  detail.appendChild(wbHead(x.title, x.file + " · " + x.kindLabel));
  if (!x.active) detail.appendChild(wbNote("当前不生效：" + x.activeWhy, x.enabled ? "warn" : "dim"));
  if (!x.editable) detail.appendChild(wbNote("这类规则（AGENTS.md / CLAUDE.md / Cursor 规则 / 用户全局 ~/.pancode/AGENTS.md / 应用级遗留）不由本面板改写：它们属于其他工具或数据根。正文仍可在这里读到，是否生效以页面底部的「生效预览」为准。", "dim"));
  fetch("/api/rules/content?file=" + encodeURIComponent(x.file)).then((r) => r.json()).then((r) => {
    if (!r.ok) { detail.appendChild(wbNote(r.error || "读取失败", "err")); return; }
    const f = {
      title: r.meta.title || "", description: r.meta.description || "", enabled: r.meta.enabled !== false,
      always: !!r.meta.always, globs: (r.meta.globs || []).join(", "), content: r.body || "",
    };
    wbField(detail, "标题", "列表与注入块里显示的名字", f.title, "text", (v) => { f.title = v; });
    wbField(detail, "适用范围（glob）", "逗号分隔；留空 = 始终注入", f.globs, "text", (v) => { f.globs = v; });
    detail.appendChild(wbToggle("启用", "关掉即刻从上下文消失，不必删文件", f.enabled, (v) => {
      if (!x.editable) { wbSaved("这一类规则不可改写", true); return; }
      f.enabled = v;
      wbPost("/api/rules/toggle", { file: x.file, enabled: v }).then((r2) => {
        if (!r2.ok) { wbSaved(r2.error || "失败", true); return; }
        wbSaved(v ? "已启用" : "已停用");
        ruleReload();
      });
    }, "enabled"));
    const cRow = wbRow("正文", "Markdown 原样注入");
    const ta = wbEl("textarea", "wb-textarea");
    ta.rows = 10;
    ta.value = f.content;
    ta.readOnly = !x.editable;
    ta.oninput = () => { f.content = ta.value; };
    cRow.ctrl.appendChild(ta);
    detail.appendChild(cRow);
    if (x.editable) {
      const acts = wbEl("div", "wb-detail-actions");
      acts.appendChild(wbBtn("保存", "wb-btn-primary", async () => {
        const r2 = await wbPut("/api/rules", {
          file: x.file, title: f.title, description: f.description, enabled: f.enabled, always: f.always,
          globs: String(f.globs).split(/[,，]/).map((s) => s.trim()).filter(Boolean), content: f.content,
        });
        if (!r2.ok) return wbSaved(r2.error || "保存失败", true);
        wbSaved("已保存");
        await ruleReload();
      }));
      acts.appendChild(wbBtn("删除规则文件", "wb-btn-danger", async () => {
        if (!confirm("删除 " + x.file + "？")) return;
        const r2 = await wbDel("/api/rules", { file: x.file });
        if (!r2.ok) return wbSaved(r2.error || "删除失败", true);
        RULE.picked = null;
        wbSaved("已删除");
        await ruleReload();
      }));
      detail.appendChild(acts);
    }
  });
}
function renderRulePreview(host) {
  if (!host) return;
  host.innerHTML = "";
  host.appendChild(wbHead("生效预览", "当前工作区这一层的规则装配结果——直接调 Agent 的装配函数，不是模拟。"));
  /* 多根授权之后这句话必须说全：本预览是用裸 {files}（只有当前根）调装配函数的，
     而某条会话真去读过别的授权目录之后，模型看到的规则会比这里多。面板没说谎，但不完整。 */
  host.appendChild(wbNote("这里只装「当前工作区」的规则。会话里真的读过其他授权目录之后，那个目录自己的 AGENTS.md / .pancode/rules 也会从下一条消息起一起注入，模型看到的会比本预览多。" +
    "Agent 能进哪几扇门、哪些是只读，在「权限与安全 · 授权目录」里看。"));
  const row = wbRow("模拟任务", "填一个文件路径，看按需规则会不会命中");
  const inp = wbEl("input", "wb-input wb-input-wide");
  inp.placeholder = "如 server/index.js（留空 = 只看始终生效的规则）";
  inp.value = RULE.sample;
  inp.onkeydown = (e) => { if (e.key === "Enter") { RULE.sample = inp.value.trim(); ruleReload(); } };
  inp.oninput = () => { RULE.sample = inp.value; };
  row.ctrl.appendChild(inp);
  row.ctrl.appendChild(wbBtn("查看", "", () => { RULE.sample = inp.value.trim(); ruleReload(); }));
  host.appendChild(row);
  const meta = wbEl("div", "wb-preview-meta", "");
  host.appendChild(meta);
  const pre = wbEl("pre", "wb-preview");
  host.appendChild(pre);
  wbGet("/api/rules/preview?q=" + encodeURIComponent(RULE.sample || "")).then((r) => {
    if (!r.ok) { pre.textContent = "加载失败：" + r.error; return; }
    pre.textContent = r.preview || "（本轮没有规则被注入）";
    meta.textContent = "注入 " + r.chars + " / " + r.max + " 字符 · 模拟命中 " + r.touched + " 个文件";
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
  const { list, detail } = wbSplit(box, wbToolbar("筛选技能…", (q) => { SKL.q = q; paintSkills(); }, [
    { text: "+ 新建技能", primary: true, run: () => { SKL.picked = "__new__"; paintSkills(); } },
    { text: "导入", run: () => { SKL.picked = "__import__"; paintSkills(); } },
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
  SKL._stats.appendChild(wbStats([["总计", r.counts.total], ["启用", r.counts.on], ["停用", r.counts.off], ["内置", r.counts.builtin], ["风险提示", r.counts.risky]]));
  SKL._stats.appendChild(wbNote("渐进式披露：只有名称 + 一句话描述 + 触发词常驻上下文，正文在模型判定要用时才通过 use_skill 取回。停用 = 不再自动匹配，显式调用仍可用。", "dim"));
  paintSkills();
}
function paintSkills() {
  const list = SKL._list, detail = SKL._detail;
  if (!list) return;
  list.innerHTML = "";
  const rows = SKL.q ? SKL.rows.filter((s) => (s.name + " " + (s.description || "") + " " + (s.trigger || "")).toLowerCase().includes(SKL.q)) : SKL.rows;
  if (!rows.length) list.appendChild(wbEl("div", "wb-list-empty", "没有匹配的技能"));
  rows.forEach((s) => {
    list.appendChild(wbSideItem({
      title: s.name,
      active: SKL.picked === s.id,
      badges: [
        s.builtin ? { text: "内置" } : null,
        s.disabled ? { text: "停用", cls: "wb-badge-dim" } : null,
        s.risk === "P0" ? { text: "高危", cls: "wb-badge-err" } : s.risk === "P1" ? { text: "注意", cls: "wb-badge-warn" } : null,
        s.scope === "user" ? { text: "用户级", cls: "wb-badge-blue" } : null,
      ].filter(Boolean),
      sub: (s.description || "（无描述）").slice(0, 42) + " · 用过 " + s.useCount + " 次",
      on: () => { SKL.picked = s.id; paintSkills(); },
    }));
  });
  if (SKL.picked === "__new__") skillForm(detail, null);
  else if (SKL.picked === "__import__") skillImportForm(detail);
  else if (SKL.picked) skillForm(detail, SKL.rows.find((x) => x.id === SKL.picked) || null);
  else detail.appendChild(wbEmpty("从左侧选一个技能"));
}
function skillForm(detail, s) {
  detail.innerHTML = "";
  if (!s) {
    detail.appendChild(wbHead("新建技能", "技能是「可复用的做法」：什么时候用、怎么做、别做什么。"));
    const f = { name: "", description: "", trigger: "", body: "" };
    wbField(detail, "名称", "", "", "text", (v) => { f.name = v; });
    wbField(detail, "一句话描述", "常驻目录里就这一句，决定模型会不会想起它", "", "text", (v) => { f.description = v; });
    wbField(detail, "触发词", "逗号分隔；命中即参与匹配", "", "text", (v) => { f.trigger = v; });
    const bRow = wbRow("正文", "步骤、注意事项、反例");
    const ta = wbEl("textarea", "wb-textarea");
    ta.rows = 10;
    ta.oninput = () => { f.body = ta.value; };
    bRow.ctrl.appendChild(ta);
    detail.appendChild(bRow);
    const newActs = wbEl("div", "wb-detail-actions");
    newActs.appendChild(wbBtn("创建", "wb-btn-primary", async () => {
      if (!String(f.name).trim()) return wbSaved("名称不能为空", true);
      const r = await wbPost("/api/skills", { name: f.name.trim(), description: f.description.trim(), trigger: f.trigger.trim(), body: f.body });
      if (!r.ok) return wbSaved(r.error || "失败", true);
      if (r.skill && r.skill._auditRejected) return wbSaved("安全审计拒绝：" + r.skill._auditRejected.level, true);
      SKL.picked = r.skill && r.skill.id;
      wbSaved("已创建");
      await skReload();
    }));
    detail.appendChild(newActs);
    return;
  }
  detail.appendChild(wbHead(s.name, (s.builtin ? "内置工作流（只读）" : (s.source || "") + " · " + (s.scope || "project")) + (s.risk && s.risk !== "P2" ? " · 风险 " + s.risk : "")));
  fetch("/api/skills/content?id=" + encodeURIComponent(s.id)).then((r) => r.json()).then((r) => {
    if (!r.ok) { detail.appendChild(wbNote(r.error || "读取失败", "err")); return; }
    const k = r.skill;
    const f = { name: k.name, description: k.description || "", trigger: k.trigger || "", tags: (k.tags || []).join(", "), body: k.body || "" };
    wbField(detail, "名称", "", f.name, "text", (v) => { f.name = v; });
    wbField(detail, "一句话描述", "出现在常驻目录", f.description, "text", (v) => { f.description = v; });
    wbField(detail, "触发词", "逗号分隔", f.trigger, "text", (v) => { f.trigger = v; });
    wbField(detail, "标签", "逗号分隔", f.tags, "text", (v) => { f.tags = v; });
    const bRow = wbRow("正文", "只有真被采用时才会读进上下文");
    const ta = wbEl("textarea", "wb-textarea");
    ta.rows = 12;
    ta.value = f.body;
    ta.readOnly = !!s.builtin;
    ta.oninput = () => { f.body = ta.value; };
    bRow.ctrl.appendChild(ta);
    detail.appendChild(bRow);
    const acts = wbEl("div", "wb-detail-actions");
    if (!s.builtin) {
      acts.appendChild(wbBtn("保存", "wb-btn-primary", async () => {
        const r2 = await wbPut("/api/skills/" + encodeURIComponent(s.id), {
          name: f.name.trim(), description: f.description.trim(), trigger: f.trigger.trim(),
          tags: f.tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean), body: f.body,
        });
        if (!r2.ok) return wbSaved(r2.error || "保存失败", true);
        wbSaved("已保存");
        await skReload();
      }));
      acts.appendChild(wbBtn(s.disabled ? "启用" : "停用", "", async () => {
        const r2 = await wbPost("/api/skills/" + encodeURIComponent(s.id) + "/toggle", { disabled: !s.disabled });
        if (!r2.ok) return wbSaved(r2.error || "失败", true);
        wbSaved(r2.disabled ? "已停用" : "已启用");
        await skReload();
      }));
      acts.appendChild(wbBtn("导出 Markdown", "", async () => {
        const r2 = await wbGet("/api/skills/export/" + encodeURIComponent(s.id));
        if (!r2.ok) return wbSaved(r2.error || "失败", true);
        const blob = new Blob([r2.content], { type: "text/markdown" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = r2.filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }));
      acts.appendChild(wbBtn("删除", "wb-btn-danger", async () => {
        if (!confirm("删除技能「" + s.name + "」？")) return;
        await wbDel("/api/skills/" + encodeURIComponent(s.id));
        SKL.picked = null;
        wbSaved("已删除");
        await skReload();
      }));
    } else {
      acts.appendChild(wbBtn("另存为我的技能", "wb-btn-primary", async () => {
        const r2 = await wbPost("/api/skills", {
          name: f.name + "（自定义）", description: f.description, trigger: f.trigger,
          tags: f.tags.split(/[,，]/).map((x) => x.trim()).filter(Boolean), body: f.body,
        });
        if (!r2.ok) return wbSaved(r2.error || "失败", true);
        SKL.picked = r2.skill && r2.skill.id;
        wbSaved("已另存");
        await skReload();
      }));
    }
    detail.appendChild(acts);
    const pvRow = wbRow("注入预览", "这一轮任务模型会看到哪几条技能目录");
    const pin = wbEl("input", "wb-input wb-input-wide");
    pin.placeholder = "如：帮我修一个渲染错位的 bug";
    pvRow.ctrl.appendChild(pin);
    pvRow.ctrl.appendChild(wbBtn("查看", "", async () => {
      const r2 = await wbGet("/api/skills/preview?q=" + encodeURIComponent(pin.value.trim()));
      if (!r2.ok) return wbShowPreview(detail, "失败：" + r2.error);
      wbShowPreview(detail, (r2.directory || "（本轮没有技能命中）") + "\n\n命中：" + (r2.matched || []).map((m) => m.name).join(" / "));
    }));
    detail.appendChild(pvRow);
  });
}
function skillImportForm(detail) {
  detail.innerHTML = "";
  detail.appendChild(wbHead("导入技能", "粘贴 Markdown（frontmatter 需含 name）。导入会走安全审计，高危内容需二次确认。"));
  const ta = wbEl("textarea", "wb-textarea");
  ta.rows = 12;
  detail.appendChild(ta);
  const acts = wbEl("div", "wb-detail-actions");
  acts.appendChild(wbBtn("导入", "wb-btn-primary", async () => {
    const r = await wbPost("/api/skills/import", { markdown: ta.value });
    if (r.ok) { wbSaved("已导入"); SKL.picked = r.skill && r.skill.id; await skReload(); return; }
    if (r.needForce) {
      if (!confirm("安全审计提示：\n" + r.error + "\n\n仍然导入？")) return;
      const r2 = await wbPost("/api/skills/import", { markdown: ta.value, force: true });
      wbSaved(r2.ok ? "已强制导入" : r2.error || "失败", !r2.ok);
      if (r2.ok) await skReload();
      return;
    }
    wbSaved(r.error || "导入失败", true);
  }));
  detail.appendChild(acts);
}

/* ============================================================
   进化 / 进度
   ============================================================ */
async function wbRenderEvolution(box) {
  box.innerHTML = "";
  let r;
  try { r = await wbGet("/api/progression"); } catch (e) { box.appendChild(wbNote("加载失败：" + e.message, "err")); return; }
  const p = r.progression || {};
  const g0 = wbGroup("阶段", "成长值来自：沉淀记忆、蒸馏技能、打磨灵魂、完成任务。");
  const head = wbEl("div", "wb-prog");
  const stage = p.stage || {};
  head.appendChild(wbEl("div", "wb-prog-stage", "<b>" + esc(stage.name || "萌芽") + "</b><span>阶段 " + (stage.id == null ? 0 : stage.id) + "</span>"));
  const bar = wbEl("div", "wb-prog-bar");
  const fill = wbEl("i");
  fill.style.width = Math.max(2, Math.round((p.stageProgress || 0) * 100)) + "%";
  bar.appendChild(fill);
  head.appendChild(bar);
  head.appendChild(wbEl("div", "wb-prog-meta", p.xp + " 经验值 · 距下一阶段 " + (p.xpToNext ? p.xpToNext + " 点" : "已是最高阶段")));
  g0.appendChild(head);
  const at = wbEl("div", "wb-attrs");
  const ATTR = { understanding: "理解力", craft: "技艺", robustness: "稳健", rapport: "默契" };
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
    g0.appendChild(wbEl("div", "wb-sub-label", "尚未解锁"));
    const uc = wbEl("div", "wb-achv");
    un.forEach((n) => uc.appendChild(wbEl("span", "wb-achv-item locked", esc(n.label) + " · " + esc(n.req))));
    g0.appendChild(uc);
  }
  const got = (p.achievements || []).filter((a) => a.unlocked);
  if (got.length) {
    g0.appendChild(wbEl("div", "wb-sub-label", "成就"));
    const ac = wbEl("div", "wb-achv");
    got.forEach((a) => ac.appendChild(wbEl("span", "wb-achv-item", esc(a.name))));
    g0.appendChild(ac);
  }
  box.appendChild(g0);

  const g1 = wbGroup("进化路线", "选定后影响四维属性的成长偏向（乘子），不改变模型行为。");
  const seg = wbEl("div", "wb-segment wb-segment-wrap");
  (r.paths || []).forEach((pa) => {
    const b = wbEl("button", r.path === pa.id ? "active" : "", pa.name);
    b.type = "button";
    b.title = pa.desc;
    b.onclick = async () => {
      const x = await wbPost("/api/progression", { path: pa.id });
      if (!x.ok) return wbSaved(x.error || "失败", true);
      [...seg.children].forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      wbSaved("进化路线：" + pa.name);
    };
    seg.appendChild(b);
  });
  if ((r.paths || []).length) {
    const row = wbRow("路线", (r.paths.find((x) => x.id === r.path) || {}).desc || "");
    row.ctrl.appendChild(seg);
    g1.appendChild(row);
  }
  g1.appendChild(wbAction("清除路线", "回到未选定状态", "清除", async () => {
    const x = await wbPost("/api/progression", { path: null });
    if (x.ok) { wbSaved("已清除"); wbReloadInto(box, "evolution"); }
  }));
  box.appendChild(g1);

  const g2 = wbGroup("成长时间线", "记忆 / 技能 / 灵魂微调按时间排开。");
  const tl = wbEl("div", "wb-timeline");
  g2.appendChild(tl);
  box.appendChild(g2);
  try {
    const t = await wbGet("/api/evolution/tree");
    const items = t.timeline || [];
    if (!items.length) tl.appendChild(wbEl("div", "wb-list-empty", "还没有成长记录"));
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
  } catch (e) { tl.appendChild(wbEl("div", "wb-list-empty", "时间线加载失败")); }

  const g3 = wbGroup("进化图鉴", "以有机树形态展开全部资产。");
  g3.appendChild(wbAction("打开图鉴", "树状视图，可点开每个节点", "打开", () => {
    if (typeof openEvolutionCodex === "function") openEvolutionCodex(); else toast("图鉴未就绪");
  }, null, "codex tree 图鉴"));
  box.appendChild(g3);
}

/* ============================================================
   自动化任务
   ============================================================ */
async function wbRenderAutomations(box) {
  box.innerHTML = "";
  let r;
  try { r = await wbGet("/api/automations"); } catch (e) { box.appendChild(wbNote("加载失败：" + e.message, "err")); return; }
  const rows = r.automations || [];
  const g0 = wbGroup("定时任务", "到点自动跑一个任务；执行记录留在本机。");
  g0.appendChild(wbStats([["任务", rows.length], ["运行中", rows.filter((t) => t.status === "active").length]]));
  const list = wbEl("div", "wb-list");
  const runsPv = wbEl("div", "wb-runs-pv");
  if (!rows.length) list.appendChild(wbEl("div", "wb-list-empty", "还没有自动化任务"));
  rows.forEach((t) => {
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("span", "wb-badge " + (t.status === "active" ? "wb-badge-ok" : "wb-badge-dim"), t.status === "active" ? "运行中" : "已暂停"));
    it.appendChild(wbEl("b", "", esc(t.name)));
    it.appendChild(wbEl("span", "wb-list-sub", esc((t.cron || t.schedule || "—") + " · 上次 " + (t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : "从未"))));
    const acts = wbEl("span", "wb-list-actions");
    acts.appendChild(wbBtn("立即执行", "wb-btn-mini", async () => {
      const x = await wbPost("/api/automations/" + encodeURIComponent(t.id) + "/run");
      wbSaved(x.ok ? "已开始，稍后看运行记录" : x.error || "失败", !x.ok);
    }));
    acts.appendChild(wbBtn(t.status === "active" ? "暂停" : "恢复", "wb-btn-mini", async () => {
      await wbPost("/api/automations/" + encodeURIComponent(t.id) + "/" + (t.status === "active" ? "pause" : "resume"));
      wbReloadInto(box, "automations");
    }));
    acts.appendChild(wbBtn("记录", "wb-btn-mini", async () => {
      const x = await wbGet("/api/automations/" + encodeURIComponent(t.id) + "/runs");
      const runs = x.runs || [];
      wbShowPreview(runsPv, runs.length
        ? runs.map((run) => new Date(run.at || run.ts || 0).toLocaleString() + "  " + (run.status || "") + " " + String(run.summary || run.error || "").slice(0, 60)).join("\n")
        : "还没有执行记录");
    }));
    acts.appendChild(wbBtn("删除", "wb-btn-mini wb-btn-danger", async () => {
      if (!confirm("删除「" + t.name + "」？")) return;
      await wbDel("/api/automations/" + encodeURIComponent(t.id));
      wbSaved("已删除");
      wbReloadInto(box, "automations");
    }));
    it.appendChild(acts);
    list.appendChild(it);
  });
  g0.appendChild(list);
  g0.appendChild(wbAction("新建任务", "在任务编辑器里填写名称、周期与提示词", "新建", () => {
    if (typeof openAutomations === "function") openAutomations(); else toast("任务编辑器未就绪");
  }, { primary: true }, "automation cron 新建 定时"));
  box.appendChild(g0);
}

/* ============================================================
   行为审计
   ============================================================ */
const AUD = { date: "" };
async function wbRenderAudit(box) {
  box.innerHTML = "";
  let dates = [];
  try { dates = (await wbGet("/api/audit/dates")).dates || []; } catch (e) { /* 首日无日志 */ }
  const g0 = wbGroup("文件与命令操作", "Agent 的每次写入 / 删除 / 命令都按日期落盘在本机。");
  if (!dates.length) {
    g0.appendChild(wbEl("div", "wb-list-empty", "还没有审计日志（未发生写操作，或首次运行）"));
    box.appendChild(g0);
    return;
  }
  if (!AUD.date || !dates.includes(AUD.date)) AUD.date = dates[0];
  const row = wbRow("日期", "共 " + dates.length + " 天有记录");
  const sel = wbEl("select", "wb-select");
  dates.forEach((d) => { const o = document.createElement("option"); o.value = d; o.textContent = d; sel.appendChild(o); });
  sel.value = AUD.date;
  const body = wbEl("div", "wb-list wb-audit");
  const load = async () => {
    body.innerHTML = "";
    const r = await wbGet("/api/audit?date=" + encodeURIComponent(sel.value) + "&limit=400");
    const lines = r.lines || [];
    if (!lines.length) { body.appendChild(wbEl("div", "wb-list-empty", "这一天没有记录")); return; }
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

/* ============================================================
   注册分区
   ============================================================ */
wbRegister({ id: "experts", group: "assets", title: "角色与专家", icon: "agent", desc: "常驻角色与专家包的增删改查", keywords: "expert persona role 角色 人格 专家", render: wbRenderExperts });
wbRegister({ id: "soul", group: "assets", title: "灵魂", icon: "soul", desc: "价值观、边界、原则与提案收件箱", keywords: "soul values boundaries principles proposal 灵魂 价值 边界 原则 提案", render: wbRenderSoul });
wbRegister({ id: "memory", group: "assets", title: "记忆", icon: "memory", desc: "长期记忆的检索、编辑与治理", keywords: "memory lesson preference recall prune 记忆 经验 教训 遗忘 归档", render: wbRenderMemory });
wbRegister({ id: "sediment", group: "assets", title: "沉淀", icon: "save", desc: "把有效会话提炼为规则或记忆", keywords: "sediment distill 沉淀 提炼 规则 记忆", render: wbRenderSediment });
wbRegister({ id: "rules", group: "assets", title: "规则", icon: "md", desc: "AGENTS.md / .pancode/rules / Cursor 规则", keywords: "rules agents md cursor glob 规则 约束 按需", render: wbRenderRules });
wbRegister({ id: "skills", group: "assets", title: "技能", icon: "toolbox", desc: "技能包的启停、编辑与导入导出", keywords: "skill skills trigger 技能 触发 导入 导出", render: wbRenderSkills });
wbRegister({ id: "evolution", group: "assets", title: "进化", icon: "leaf", desc: "阶段、属性、路线、时间线与图鉴", keywords: "evolution xp stage path timeline 进化 阶段 路线 时间线", render: wbRenderEvolution });
wbRegister({ id: "automations", group: "engine", title: "自动化", icon: "clock", desc: "定时任务与执行记录", keywords: "automation cron schedule 自动化 定时 任务", render: wbRenderAutomations });
wbRegister({ id: "audit", group: "data", title: "行为审计", icon: "history", desc: "文件与命令操作流水", keywords: "audit log 审计 日志 操作", render: wbRenderAudit });
