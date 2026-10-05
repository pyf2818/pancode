/* ============================================================
   pancode 设置工作台（T3）
   全屏工作台替代原来散在 6 个入口、15 个弹窗里的设置界面：
     左栏分组导航 · 右栏表单 · 顶栏全局搜索
   写入统一走 /api/config（按段保存），外观类即时生效写 localStorage。
   依赖全局：$ / esc / ico / toast / replaceIcons / PALETTES / applyPalette /
            getTheme / getThemePref / applyTheme（运行时解析）
   ============================================================ */
"use strict";

const WB = {
  root: null, nav: null, body: null, search: null,
  section: "appearance", query: "", cfg: null, lastFocus: null,
};

const WB_GROUPS = [
  { id: "prefs", label: "偏好" },
  { id: "engine", label: "模型与工具" },
  { id: "assets", label: "Agent 资产" },
  { id: "data", label: "数据与隐私" },
];

/* 各分区由本文件或 assets-center.js 注册进来 */
const WB_SECTIONS = [];
function wbRegister(sec) {
  const i = WB_SECTIONS.findIndex((s) => s.id === sec.id);
  if (i >= 0) WB_SECTIONS[i] = sec; else WB_SECTIONS.push(sec);
  if (WB.root) wbRenderNav();
}

/* ---------------- DOM 原语 ---------------- */
function wbEl(tag, cls, html) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
}
function wbGroup(title, desc) {
  const g = wbEl("div", "wb-group");
  g.appendChild(wbEl("div", "wb-group-title", esc(title)));
  if (desc) g.appendChild(wbEl("div", "wb-group-desc", esc(desc)));
  return g;
}
/* 一行 = 左标题/说明 + 右控件。返回节点本身，控件位挂在 .ctrl 上——
   避免调用方把返回值当节点 appendChild 时报 "not of type Node"。 */
function wbRow(label, desc, kw) {
  const row = wbEl("div", "wb-row");
  if (kw) row.dataset.kw = String(kw).toLowerCase();
  row.dataset.label = label + " " + (desc || "");
  const left = wbEl("div", "wb-row-label");
  left.appendChild(wbEl("div", "wb-row-name", esc(label)));
  if (desc) left.appendChild(wbEl("div", "wb-row-desc", esc(desc)));
  const ctrl = wbEl("div", "wb-row-ctrl");
  row.appendChild(left);
  row.appendChild(ctrl);
  row.ctrl = ctrl;
  return row;
}
function wbNote(text, kind) {
  return wbEl("div", "wb-note" + (kind ? " wb-note-" + kind : ""), esc(text));
}
function wbSeg(label, desc, options, value, onChange, kw) {
  const row = wbRow(label, desc, kw); const ctrl = row.ctrl;
  const seg = wbEl("div", "wb-segment");
  options.forEach((o) => {
    const b = wbEl("button", o.v === value ? "active" : "", esc(o.t));
    b.type = "button";
    b.onclick = () => {
      [...seg.children].forEach((c) => c.classList.remove("active"));
      b.classList.add("active");
      onChange(o.v);
    };
    seg.appendChild(b);
  });
  ctrl.appendChild(seg);
  return row;
}
function wbToggle(label, desc, value, onChange, kw) {
  const row = wbRow(label, desc, kw); const ctrl = row.ctrl;
  const sw = wbEl("button", "wb-switch" + (value ? " on" : ""));
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", value ? "true" : "false");
  sw.appendChild(wbEl("span", "wb-knob"));
  sw.onclick = () => {
    const next = !sw.classList.contains("on");
    sw.classList.toggle("on", next);
    sw.setAttribute("aria-checked", next ? "true" : "false");
    onChange(next);
  };
  ctrl.appendChild(sw);
  return row;
}
function wbInput(label, desc, value, onCommit, opts, kw) {
  opts = opts || {};
  const row = wbRow(label, desc, kw); const ctrl = row.ctrl;
  const inp = wbEl("input", "wb-input" + (opts.wide ? " wb-input-wide" : ""));
  inp.type = opts.password ? "password" : (opts.type || "text");
  inp.value = value == null ? "" : value;
  if (opts.placeholder) inp.placeholder = opts.placeholder;
  if (opts.min != null) { inp.type = "number"; inp.min = opts.min; inp.max = opts.max; inp.step = opts.step != null ? opts.step : 1; }
  const commit = () => onCommit(inp.type === "number" ? Number(inp.value) : inp.value.trim());
  inp.onkeydown = (e) => { if (e.key === "Enter") { commit(); inp.blur(); } };
  inp.onblur = commit;
  if (opts.password) {
    const eye = wbEl("button", "wb-eye", ico("eye"));
    eye.type = "button";
    eye.title = "显示/隐藏";
    eye.onclick = () => { inp.type = inp.type === "password" ? "text" : "password"; };
    const wrap = wbEl("div", "wb-input-wrap");
    wrap.appendChild(inp); wrap.appendChild(eye);
    ctrl.appendChild(wrap);
  } else ctrl.appendChild(inp);
  return row;
}
function wbSlider(label, desc, value, min, max, step, unit, onInput, kw) {
  const row = wbRow(label, desc, kw); const ctrl = row.ctrl;
  const out = wbEl("span", "wb-slider-val", value + (unit || ""));
  const inp = wbEl("input", "wb-slider");
  inp.type = "range"; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
  inp.oninput = () => { out.textContent = inp.value + (unit || ""); onInput(Number(inp.value)); };
  const wrap = wbEl("div", "wb-slider-wrap");
  wrap.appendChild(inp); wrap.appendChild(out);
  ctrl.appendChild(wrap);
  return row;
}
function wbAction(label, desc, btnText, fn, opts, kw) {
  opts = opts || {};
  const row = wbRow(label, desc, kw); const ctrl = row.ctrl;
  const b = wbEl("button", "wb-btn" + (opts.danger ? " wb-btn-danger" : "") + (opts.primary ? " wb-btn-primary" : ""), esc(btnText));
  b.type = "button";
  b.onclick = async () => {
    b.disabled = true;
    try { await fn(b); } finally { b.disabled = false; }
  };
  ctrl.appendChild(b);
  if (opts.note) row.appendChild(wbNote(opts.note));
  return row;
}
/* 只读键值行（关于 / 路径 / 状态） */
function wbKV(label, value, mono) {
  const row = wbEl("div", "wb-kv");
  row.appendChild(wbEl("span", "wb-kv-k", esc(label)));
  row.appendChild(wbEl("span", "wb-kv-v" + (mono ? " wb-mono" : ""), esc(value == null ? "—" : String(value))));
  return row;
}
/* 字符串数组编辑器（权限 allow/deny、tags） */
function wbChips(label, desc, items, onChange, placeholder, kw) {
  const row = wbRow(label, desc, kw); const ctrl = row.ctrl;
  let cur = (items || []).slice();
  const box = wbEl("div", "wb-chips");
  const draw = () => {
    box.innerHTML = "";
    if (!cur.length) box.appendChild(wbEl("span", "wb-chips-empty", "（空）"));
    cur.forEach((v, i) => {
      const c = wbEl("span", "wb-chip");
      c.appendChild(wbEl("code", "", esc(v)));
      const x = wbEl("button", "wb-chip-x", "✕");
      x.type = "button";
      x.title = "移除";
      x.onclick = () => { cur = cur.slice(); cur.splice(i, 1); draw(); onChange(cur); };
      c.appendChild(x);
      box.appendChild(c);
    });
  };
  draw();
  const add = wbEl("input", "wb-input wb-chip-add");
  add.placeholder = placeholder || "输入后回车添加";
  add.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = e.target.value.trim();
    if (!v) return;
    e.target.value = "";
    cur = cur.concat([v]);
    draw();
    onChange(cur);
  };
  const wrap = wbEl("div", "wb-chips-wrap");
  wrap.appendChild(box); wrap.appendChild(add);
  ctrl.appendChild(wrap);
  return row;
}

/* ---------------- 服务端读写 ---------------- */
async function wbLoadConfig() {
  try {
    const r = await fetch("/api/config").then((x) => x.json());
    WB.cfg = r && r.ok ? r : null;
  } catch (e) { WB.cfg = null; }
  return WB.cfg;
}
async function wbSave(section, patch) {
  try {
    const r = await fetch("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ section, patch }),
    }).then((x) => x.json());
    if (r && r.ok) {
      if (WB.cfg) Object.assign(WB.cfg, r);
      wbSaved(section + " 已保存并生效");
    } else wbSaved((r && r.error) || "保存失败", true);
    return r;
  } catch (e) { wbSaved("保存失败：" + e.message, true); return { ok: false }; }
}
let wbSavedTimer = null;
function wbSaved(msg, isErr) {
  const el = WB.root && WB.root.querySelector("#wbSaved");
  if (el) {
    el.textContent = msg;
    el.className = "wb-saved" + (isErr ? " wb-saved-err" : "");
    el.style.opacity = "1";
    clearTimeout(wbSavedTimer);
    wbSavedTimer = setTimeout(() => { el.style.opacity = "0"; }, 1800);
  } else toast(msg);
}

/* ============================================================
   分区：外观（含配色库）
   ============================================================ */
function wbRenderAppearance(box) {
  const g1 = wbGroup("明暗与配色", "明暗即时生效；配色方案决定整套颜色基调。");
  g1.appendChild(wbSeg("明暗模式", "跟随系统会随操作系统切换", [
    { v: "auto", t: "跟随系统" }, { v: "dark", t: "深色" }, { v: "light", t: "浅色" },
  ], getThemePref(), (v) => {
    localStorage.setItem("cw-theme", v);
    applyTheme(v);
    wbRepaintGallery();
  }, "theme dark light auto 深色 浅色 主题"));

  const gal = wbEl("div", "wb-palette-gallery");
  gal.id = "wbPaletteGallery";
  g1.appendChild(wbEl("div", "wb-sub-label", "配色方案（" + PALETTES.length + " 套）"));
  g1.appendChild(gal);
  g1.appendChild(wbEl("div", "wb-note", "深色与浅色各自成组；点选即时生效。标注「双模式」的方案两种明暗都可用。"));
  box.appendChild(g1);

  const g2 = wbGroup("字号");
  g2.appendChild(wbSlider("界面字号", "影响列表、按钮、侧栏", parseFloat(localStorage.getItem("cw-ui-fontsize")) || 13, 11, 18, 0.5, "px",
    (v) => applyUiFontSize(v), "font size ui 字号"));
  g2.appendChild(wbSlider("编辑器字号", "Monaco 代码区", parseFloat(localStorage.getItem("cw-fontsize")) || 13.5, 11, 22, 0.5, "px",
    (v) => applyEditorFontSize(v), "font size editor 字号"));
  box.appendChild(g2);
  wbRepaintGallery();
}
/* 配色卡片：4 个色块预览 + 名称 + 模式徽章 */
function wbRepaintGallery() {
  const gal = $("wbPaletteGallery");
  if (!gal || typeof PALETTES === "undefined") return;
  const cur = getPalette();
  gal.innerHTML = "";
  PALETTES.forEach((p) => {
    const card = wbEl("button", "wb-palette" + (p.id === cur ? " active" : ""));
    card.type = "button";
    card.title = p.name + " · " + p.desc;
    const sw = wbEl("div", "wb-palette-sw");
    (p.sw || []).slice(0, 4).forEach((color) => {
      const i = wbEl("i");
      i.style.background = color;
      sw.appendChild(i);
    });
    card.appendChild(sw);
    card.appendChild(wbEl("div", "wb-palette-name", esc(p.name)));
    card.appendChild(wbEl("div", "wb-palette-desc", esc(p.desc) + " · " + ({ dark: "深色", light: "浅色", both: "双模式" }[p.mode] || p.mode)));
    card.onclick = () => { applyPalette(p.id); wbRepaintGallery(); wbSaved("配色已切换为「" + p.name + "」"); };
    gal.appendChild(card);
  });
}

/* ============================================================
   分区：通用
   ============================================================ */
function wbRenderGeneral(box) {
  const c = WB.cfg || {};
  const g1 = wbGroup("语言与区域");
  g1.appendChild(wbSeg("界面语言", "影响按钮、菜单等界面文案", [
    { v: "zh", t: "中文" }, { v: "en", t: "English" },
  ], localStorage.getItem("cw-lang") || "zh", (v) => {
    if (typeof setLang === "function") setLang(v);
    wbSaved("语言已切换");
  }, "language lang 语言"));
  box.appendChild(g1);

  const g2 = wbGroup("工作区", "当前工作区会自动出现在「权限与安全 · 授权目录」里；Agent 能进哪几扇门全部由那份清单说了算。");
  g2.appendChild(wbKV("当前工作区", (c.workspace && c.workspace.dir) || "—", true));
  const wsDir = (c.workspace && c.workspace.dir) || "";
  g2.appendChild(wbAction("切换工作区", "选择本机文件夹作为新的工作区", "选择…", () => {
    if (typeof fmOpenFolder === "function") fmOpenFolder(); else toast("文件夹选择器未就绪");
  }, null, "workspace folder 工作区 文件夹"));
  const recent = ((c.workspace && c.workspace.recent) || []).filter((p) => p !== wsDir);
  if (recent.length) {
    const list = wbEl("div", "wb-recent");
    recent.slice(0, 6).forEach((p) => {
      const it = wbEl("button", "wb-recent-item", "<span>" + ico("folder") + " " + esc(String(p).split(/[\\/]+/).pop()) + "</span><code>" + esc(p) + "</code>");
      it.type = "button";
      it.onclick = () => {
        fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir: p }) })
          .then((x) => x.json()).then((r) => {
            if (r && r.ok) { wbSaved("已切换，正在重载…"); setTimeout(() => location.reload(), 700); }
            else wbSaved("切换失败：" + ((r && r.error) || ""), true);
          });
      };
      list.appendChild(it);
    });
    g2.appendChild(wbEl("div", "wb-sub-label", "最近打开"));
    g2.appendChild(list);
  }
  box.appendChild(g2);

  const g3 = wbGroup("编辑器增强");
  g3.appendChild(wbToggle("LSP 语言服务", "悬停文档、跳转定义、真实诊断", !!(c.agent && c.agent.lsp && c.agent.lsp.enabled),
    (v) => wbSave("agent", { lsp: { enabled: v } }), "lsp 语言服务 诊断"));
  box.appendChild(g3);
}

/* ============================================================
   分区：模型
   ============================================================ */
/* 大模型配置：一屏走完「填地址 + Key → 拉取模型 → 选 → 测 → 存成可切换的配置」。
   以前拆成"当前引擎 / OpenAI 兼容接口 / 向量索引"三块，且拉不到模型时前端会塞一份内置假模型清单
   （gpt-4o、deepseek-chat…），选了当前服务根本没有的模型，报错还报在别处。现在只列真拿到的。
   「拉取模型」「测试模型」直接用表单里正填着的地址与密钥发请求，不依赖已保存配置——
   输入框只在失焦时才落盘，点按钮的那一下常常还没存上，以前就是这么"拉取失败"的。 */
async function wbRenderModel(box) {
  const c = WB.cfg || {};
  const e = c.engine || {};
  let profiles = [];
  try { const pr = await wbGet("/api/llm/profiles"); if (pr && pr.ok) profiles = pr.profiles || []; } catch (err) { profiles = []; }

  const g = wbGroup("大模型配置", "填接口地址与 Key → 拉取模型 → 选中 → 测一次 → 存成配置；存下的每一份都能一键切回来。");
  box.appendChild(g);
  g.appendChild(wbKV("当前", (e.mode === "llm" ? "真实大模型" : "未配置（内置演示引擎）") +
    (e.model ? " · " + e.model : "") + (e.hasKey ? " · 密钥 " + (e.keyTail || "") : " · 无密钥")));

  const modelList = wbEl("div", "wb-model-list");
  const urlRow = wbInput("接口地址（Base URL）", "填你自己的模型服务地址，含协议与版本路径；OpenAI 兼容服务、本地 Ollama / LM Studio 都可以，不要求任何额外组件", e.baseURL,
    (v) => { if (v) { wbSave("llm", { baseURL: v }); modelList.innerHTML = ""; if (typeof invalidateModelCache === "function") invalidateModelCache(); } },
    { wide: true, placeholder: "https://api.openai.com/v1" }, "base url endpoint 接口 网关");
  const keyRow = wbInput("API Key", "只写进本地 .env 与内存，绝不进配置文件", "",
    (v) => { if (v) { wbSave("llm", { apiKey: v }); if (typeof invalidateModelCache === "function") invalidateModelCache(); } },
    { wide: true, password: true, placeholder: e.hasKey ? "已保存 " + (e.keyTail || "") + "（留空不修改）" : "sk-…" }, "api key 密钥");
  g.appendChild(urlRow);
  g.appendChild(keyRow);
  const urlInp = urlRow.querySelector("input");
  const keyInp = keyRow.querySelector("input");

  const stepRow = wbRow("模型", "点「拉取模型」列出这个地址真实可用的模型；拉不到就直接填模型 ID", "model 模型");
  const btns = wbEl("div", "wb-inline-actions");
  const pull = wbEl("button", "wb-btn wb-btn-primary", "拉取模型"); pull.type = "button";
  const test = wbEl("button", "wb-btn", "测试模型"); test.type = "button";
  btns.appendChild(pull); btns.appendChild(test);
  stepRow.ctrl.appendChild(btns);
  stepRow.ctrl.appendChild(modelList);
  g.appendChild(stepRow);

  const paintModels = (ids) => {
    modelList.innerHTML = "";
    if (!ids.length) {
      modelList.appendChild(wbEl("div", "wb-model-none", "这个地址没有返回模型列表，直接在下方「当前模型」里填 ID 即可。"));
      return;
    }
    const wrap = wbEl("div", "wb-model-chips");
    ids.forEach((id) => {
      const b = wbEl("button", "wb-model-chip" + (id === (e.model || "") ? " on" : ""), esc(id));
      b.type = "button";
      b.onclick = async () => {
        const r = await wbSave("llm", { model: id });
        if (r && r.ok) {
          [...wrap.children].forEach((x) => x.classList.remove("on"));
          b.classList.add("on");
          const inp = g.querySelector('input[placeholder*="模型 ID"]');
          if (inp) inp.value = id;
        }
      };
      wrap.appendChild(b);
    });
    modelList.appendChild(wrap);
    modelList.appendChild(wbEl("div", "wb-model-meta", "共 " + ids.length + " 个 · 点一个即选中并生效"));
  };
  /* 表单值优先；两处都留空时才回落到已保存的配置 */
  const formCreds = () => ({ baseURL: urlInp.value.trim(), apiKey: keyInp.value.trim() });
  const showFail = (msg) => {
    modelList.innerHTML = "";
    modelList.appendChild(wbEl("div", "wb-model-none", "拉取失败：" + msg));
  };
  pull.onclick = async () => {
    pull.disabled = true; pull.textContent = "拉取中…";
    modelList.innerHTML = "";
    modelList.appendChild(wbEl("div", "wb-model-none", "正在请求 " + (formCreds().baseURL || e.baseURL || "（还没填地址）") + "/models …"));
    try {
      const r = await wbPost("/api/models", formCreds());
      const ids = (r && r.models || []).filter(Boolean);
      if (ids.length) {
        paintModels(ids);
        if (typeof invalidateModelCache === "function") invalidateModelCache();
        wbSaved("已拉取 " + ids.length + " 个模型，点一个选中");
      } else {
        const err = (r && r.error) || "对方未返回模型列表";
        showFail(err);
        wbSaved(err, true);
      }
    } catch (err) {
      showFail(err.message);
      wbSaved("拉取失败：" + err.message, true);
    } finally { pull.disabled = false; pull.textContent = "拉取模型"; }
  };
  test.onclick = async () => {
    test.disabled = true; test.textContent = "测试中…";
    try {
      const modelInp = g.querySelector('input[placeholder*="模型 ID"]');
      const r = await wbPost("/api/settings/test", Object.assign(formCreds(), { model: modelInp ? modelInp.value.trim() : "" }));
      wbSaved(r.ok ? "连通正常：" + String(r.sample || "").slice(0, 40) : "不通：" + (r.error || ""), !r.ok);
    } catch (err) { wbSaved("测试失败：" + err.message, true); }
    finally { test.disabled = false; test.textContent = "测试模型"; }
  };

  g.appendChild(wbInput("当前模型", "从上面点选即生效，也可直接改这里", e.model === "内置演示引擎" ? "" : e.model,
    (v) => v && wbSave("llm", { model: v }), { wide: true, placeholder: "从上面点选，或粘贴模型 ID" }, "model 模型 id"));
  g.appendChild(wbInput("上下文窗口", "自动压缩与用量条的分母（token）", e.contextWindow || 128000,
    (v) => wbSave("llm", { contextWindow: v }), { min: 4096, max: 2000000, step: 1024 }, "context window token 上下文"));
  g.appendChild(wbInput("单任务最大工具轮次", "5–500；越大越能跑长任务，也越烧额度", e.maxToolRounds || 100,
    (v) => wbSave("llm", { maxToolRounds: v }), { min: 5, max: 500 }, "rounds max 轮次 预算"));

  /* 存成一份可切换的配置 */
  const saveRow = wbRow("存为配置", "把上面的地址 / 模型 / 参数存成一份，随时切回来；密钥按配置各自存本地 .env", "profile 配置 保存");
  const nameInp = wbEl("input", "wb-input");
  nameInp.placeholder = "配置名，如 生产环境 / 本地 Ollama";
  nameInp.style.flex = "1";
  const saveBtn = wbEl("button", "wb-btn wb-btn-primary", "保存这份配置"); saveBtn.type = "button";
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      // 带上表单当前值：只发 name 的话，服务端取的是"已保存的"配置——输入框还没失焦保存就存了个旧的
      const body = { name: nameInp.value.trim() };
      const fc = formCreds();
      if (fc.baseURL) body.baseURL = fc.baseURL;
      if (fc.apiKey) body.apiKey = fc.apiKey;
      const mi = g.querySelector('input[placeholder*="模型 ID"]');
      if (mi && mi.value.trim()) body.model = mi.value.trim();
      const r = await wbPost("/api/llm/profiles", body);
      if (r && r.ok) {
        wbSaved("已存为「" + r.profile.name + "」"); nameInp.value = "";
        if (typeof invalidateModelCache === "function") invalidateModelCache();
        wbReloadInto(box, "model");
      }
      else wbSaved((r && r.error) || "保存失败", true);
    } catch (err) { wbSaved("保存失败：" + err.message, true); }
    finally { saveBtn.disabled = false; }
  };
  const grp = wbEl("div", "wb-inline-actions");
  grp.appendChild(nameInp); grp.appendChild(saveBtn);
  saveRow.ctrl.appendChild(grp);
  g.appendChild(saveRow);

  /* 已保存的配置列表 */
  const g2 = wbGroup("已保存的配置", "点「用这份」立刻切换接口地址与模型；配置文件里只有地址和模型名，没有密钥。");
  box.appendChild(g2);
  if (!profiles.length) g2.appendChild(wbNote("还没有保存过配置。填好上面两项后点「保存这份配置」。", "dim"));
  profiles.forEach((p) => {
    const row = wbEl("div", "wb-profile");
    row.appendChild(wbEl("div", "wb-profile-name", esc(p.name)));
    row.appendChild(wbEl("div", "wb-profile-sub", esc(p.baseURL) + " · " + esc(p.model || "未选模型") +
      (p.hasKey ? " · 密钥 " + esc(p.keyTail || "") : " · 无密钥")));
    const use = wbEl("button", "wb-btn wb-btn-mini", "用这份"); use.type = "button";
    use.onclick = async () => {
      const r = await wbPost("/api/llm/profiles/" + encodeURIComponent(p.id) + "/apply", {});
      if (r && r.ok) {
        wbSaved("已切到「" + p.name + "」" + (r.hasKey ? "" : "（这份没有密钥，本地服务可忽略；云端服务请补一下 API Key）"));
        if (typeof invalidateModelCache === "function") invalidateModelCache();
        wbReloadInto(box, "model");
      }
      else wbSaved((r && r.error) || "切换失败", true);
    };
    const del = wbEl("button", "wb-btn wb-btn-mini wb-btn-danger", "删除"); del.type = "button";
    del.onclick = async () => {
      if (!confirm("删除配置「" + p.name + "」？密钥也会一并从本地 .env 清掉。")) return;
      const r = await wbDel("/api/llm/profiles/" + encodeURIComponent(p.id));
      if (r && r.ok) {
        if (typeof invalidateModelCache === "function") invalidateModelCache();
        wbSaved("已删除"); wbReloadInto(box, "model");
      } else wbSaved("删除失败", true);
    };
    const acts = wbEl("div", "wb-inline-actions");
    acts.appendChild(use); acts.appendChild(del);
    row.appendChild(acts);
    g2.appendChild(row);
  });

  const emb = c.embedding || {};
  const g3 = wbGroup("代码向量索引（Embedding，可选）", "留空则语义检索退化为关键词匹配；与上面的对话模型互不影响。");
  box.appendChild(g3);
  g3.appendChild(wbInput("Endpoint", "", emb.endpoint, (v) => wbSave("embedding", { endpoint: v }), { wide: true, placeholder: "https://api.openai.com/v1" }, "embedding vector 向量"));
  g3.appendChild(wbInput("API Key", "", "", (v) => v && wbSave("embedding", { apiKey: v }), { wide: true, password: true, placeholder: emb.hasKey ? "已保存 " + (emb.keyTail || "") + "（留空不修改）" : "可选" }, "embedding key"));
  g3.appendChild(wbInput("模型", "", emb.model, (v) => v && wbSave("embedding", { model: v }), { placeholder: "text-embedding-3-small" }, "embedding model"));
  g3.appendChild(wbAction("重建索引", "扫描工作区生成向量索引，大仓库首次会较久", "重建", async (b) => {
    b.textContent = "重建中…";
    try {
      const r = await fetch("/api/index/build", { method: "POST" }).then((x) => x.json());
      wbSaved(r.ok ? "索引完成" : "索引失败：" + (r.error || ""), !r.ok);
    } finally { b.textContent = "重建"; }
  }, null, "index build 索引"));
}

/* ============================================================
   分区：Agent 行为
   ============================================================ */
function wbRenderAgent(box) {
  const c = WB.cfg || {};
  const ag = c.agent || {};
  const g0 = wbGroup("资产总览", "点左侧「Agent 资产」下的任一分区可直接管理。");
  const a = c.assets || {};
  const strip = wbEl("div", "wb-stats");
  [["规则", a.rules], ["记忆", a.memory], ["技能", a.skills && a.skills.total], ["专家", a.experts]].forEach(([k, v]) => {
    const it = wbEl("div", "wb-stat");
    it.appendChild(wbEl("b", "", String(v == null ? 0 : v)));
    it.appendChild(wbEl("span", "", k));
    strip.appendChild(it);
  });
  g0.appendChild(strip);
  g0.appendChild(wbAction("打开资产中心", "角色 / 记忆 / 沉淀 / 规则 / 技能 全在这里", "进入", () => openWorkbench("experts"), null, "asset 资产 记忆 规则"));
  box.appendChild(g0);

  const g1 = wbGroup("运行模式", "决定 Agent 拿到任务后的默认动作。");
  g1.appendChild(wbSeg("行为模式", "Plan 先出计划再执行；Ask 只读不写", [
    { v: "agent", t: "执行" }, { v: "plan", t: "规划" }, { v: "ask", t: "问答" },
  ], ag.agentMode || "agent", (v) => wbSave("agent", { agentMode: v }), "mode plan ask agent 模式"));
  g1.appendChild(wbToggle("项目规则注入", "把 AGENTS.md / .pancode/rules 等作为硬约束喂给模型", !!(ag.rules && ag.rules.enabled),
    (v) => wbSave("agent", { rules: { enabled: v } }), "rules 规则"));
  g1.appendChild(wbToggle("长期记忆", "跨会话记住偏好、经验与教训", !!(ag.memory && ag.memory.enabled),
    (v) => wbSave("agent", { memory: { enabled: v } }), "memory 记忆"));
  box.appendChild(g1);

  const ctx = ag.context || {};
  const g2 = wbGroup("上下文", "超预算时自动做结构化压缩，保留目标 / 决策 / 待办。");
  g2.appendChild(wbToggle("自动压缩", "接近窗口上限时自动摘要旧轮次", ctx.autoCompact !== false,
    (v) => wbSave("agent", { context: { autoCompact: v } }), "compact 压缩"));
  g2.appendChild(wbInput("压缩阈值（token）", "建议设为模型窗口的 70%", ctx.budgetTokens || 100000,
    (v) => wbSave("agent", { context: { budgetTokens: v } }), { min: 8000, max: 2000000, step: 1000 }, "budget token 预算"));
  box.appendChild(g2);

  /* 长任务时限：这三项是「跑几分钟就断」的直接开关，默认按长任务设定。
     审批时限尤其重要——原实现 120 秒无人点就自动拒绝，Agent 于是带着「用户拒绝」继续收尾，
     看起来就像任务中途死了。 */
  const to = ag.timeouts || {};
  const g3 = wbGroup("长任务时限", "跑不完一次真实构建 / 测试，多半是这里被设得太短。改完立即生效，无需重启。");
  g3.appendChild(wbInput("命令前台等待上限（秒）", "run_command 等多久后终止并把已产出输出交回模型。超过 10 分钟的构建请让 Agent 改用后台进程（start_process + read_process）",
    to.commandSec == null ? 600 : to.commandSec,
    (v) => wbSave("agent", { timeouts: { commandSec: v } }), { min: 15, max: 7200, step: 15 }, "command 命令 构建 timeout"));
  g3.appendChild(wbInput("审批等待上限（秒）", "批准 / 拒绝卡片多久没人处理才自动放弃。设得太短会让长任务在你离开一会儿后被判定为「你拒绝了」",
    to.approvalSec == null ? 1200 : to.approvalSec,
    (v) => wbSave("agent", { timeouts: { approvalSec: v } }), { min: 30, max: 7200, step: 30 }, "approval 审批 确认 等待"));
  g3.appendChild(wbInput("只读工具兜底超时（秒）", "读文件 / 检索类工具的兜底时限。子智能体、编排、写类工具与命令不受此约束，各自有更长时限",
    to.toolSec == null ? 120 : to.toolSec,
    (v) => wbSave("agent", { timeouts: { toolSec: v } }), { min: 15, max: 3600, step: 15 }, "tool 工具 guard 兜底"));
  box.appendChild(g3);
}

/* ============================================================
   分区：权限与安全
   ============================================================ */
/* ============================================================
   分区：权限与安全
   ============================================================ */
/* 授权目录（阶段二-4）。这一组管「能不能进这个门」，下面的 allow/deny 清单管「进门之后能干什么」，
   两个轴刻意分开、不要混着写。清单是**全局一份**（<数据根>/.pancode/roots.json），换工作区也带着走。 */
function wbRootsGroup(box) {
  const g = wbGroup("授权目录", "Agent 只能读写下面这些目录。清单是全局一份，切换工作区不会带走它。");
  const list = wbEl("div", "wb-list");
  list.appendChild(wbEl("div", "wb-list-empty", "正在读取授权清单…"));
  g.appendChild(list);

  const post = (url, body, method) => fetch(url, {
    method: method || "POST",
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  }).then((x) => x.json());

  let activeId = "";
  /* 就地重画这一组，不整页重载：改一次读写档位就跳到页面顶部很难受 */
  const draw = (roots) => {
    list.innerHTML = "";
    if (!roots.length) {
      list.appendChild(wbEl("div", "wb-list-empty", "还没有任何授权目录（正常情况下当前工作区会自动出现在这里）"));
    }
    roots.forEach((row) => {
      const isActive = row.id === activeId;
      const it = wbEl("div", "wb-list-item wb-root-item");
      const name = wbEl("div", "wb-root-name");
      /* 清单是持久化的，而"当前工作区"是每轮现算的状态：老数据里存过这个 label，切过工作区之后
         会出现两行都写着"当前工作区"（真实例实测到过）。名字位只认目录名，徽标位交给 isActive。 */
      const stored = String(row.label || "");
      const base = String(row.path).split(/[\\/]+/).pop();
      const label = stored && stored !== "当前工作区" ? stored : base;
      const labelEl = wbEl("span", "wb-root-label", esc(label));
      /* 路径与名字都会被截断（Windows 的长路径必然超一行）：title 是"看全"的唯一去处，
         布局探针把"截了又没地方看全"当缺陷报。 */
      labelEl.title = label;
      const pathEl = wbEl("code", "wb-root-path", esc(row.path));
      pathEl.title = row.path;
      name.appendChild(labelEl);
      name.appendChild(pathEl);
      it.appendChild(name);
      if (isActive) it.appendChild(wbEl("span", "wb-badge wb-badge-blue", "当前工作区"));
      if (row.stale) it.appendChild(wbEl("span", "wb-badge wb-badge-warn", "不在盘上"));
      if (row.moved) it.appendChild(wbEl("span", "wb-badge wb-badge-warn", "已被移走"));
      if (!row.writable && !row.stale) it.appendChild(wbEl("span", "wb-badge", "只读"));

      /* 与 .wb-switch 同一套外观，只是嵌在列表行里：每行都能单独收放读写档位 */
      const sw = wbEl("button", "wb-switch wb-root-switch" + (row.writable ? " on" : ""));
      sw.type = "button";
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", row.writable ? "true" : "false");
      sw.title = row.writable ? "可写：Agent 能在这个目录里写文件、删文件（点击改成只读）"
        : "只读：Agent 能看不能改（点击放开写入）";
      sw.appendChild(wbEl("span", "wb-knob"));
      sw.onclick = async () => {
        const res = await post("/api/roots/" + encodeURIComponent(row.id) + "/writable", { writable: !row.writable });
        if (!res.ok) return wbSaved("改读写性失败：" + ((res && res.error) || ""), true);
        wbSaved((row.writable ? "已设为只读：" : "已放开写入：") + (row.label || row.path));
        draw(res.roots || roots);
      };
      it.appendChild(sw);

      const x = wbEl("button", "wb-icon-btn", ico("close"));
      x.type = "button";
      if (isActive) {
        /* 当前工作区撤了等于 Agent 什么都碰不到，而且下次挂载会被 ensure 加回来 ——
           给个能点的 X 只会让人以为"撤销成功了但怎么还在" */
        x.disabled = true;
        x.title = "当前工作区不能从这里撤销（切换工作区即可换掉它）";
      } else {
        x.title = "撤销授权：只把这一行从清单里移除，目录和其中的文件一概不动";
        x.onclick = async () => {
          if (!confirm("撤销「" + (row.label || row.path) + "」的授权？\n只会从清单里移除这一行，目录和其中的文件不会被删除。")) return;
          const res = await post("/api/roots/" + encodeURIComponent(row.id), null, "DELETE");
          if (!res.ok) return wbSaved("撤销失败：" + ((res && res.error) || ""), true);
          wbSaved("已撤销授权：" + (row.label || row.path));
          draw(res.roots || roots);
        };
      }
      it.appendChild(x);
      list.appendChild(it);
    });
  };

  /* 异步读清单：失败要说出来，别留一片空白让人以为"没授权过任何目录" */
  fetch("/api/roots").then((x) => x.json()).then((r) => {
    if (r.ok === false) {
      g.querySelector(".wb-group-desc").textContent = "读取授权清单失败：" + (r.error || "未知错误");
      list.innerHTML = "";
      list.appendChild(wbEl("div", "wb-list-empty wb-list-err", "授权清单读不出来，下面的开关此刻不可信"));
      return;
    }
    activeId = r.activeId || "";
    draw(r.roots || []);
    replaceIcons(list);
  }).catch((e) => {
    list.innerHTML = "";
    list.appendChild(wbEl("div", "wb-list-empty wb-list-err", "请求异常：" + e.message));
  });

  const add = wbEl("button", "wb-btn wb-btn-primary", "添加目录…");
  add.type = "button";
  add.onclick = () => {
    if (typeof fmOpenPicker !== "function") return wbSaved("文件夹选择器未就绪", true);
    fmOpenPicker({
      title: "授权一个目录 — Agent 可以读写它，当前工作区不会被换掉",
      btnText: "授权此文件夹",
      onPick: async (dir) => {
        const res = await post("/api/roots", { path: dir, writable: true });
        if (!res.ok) { wbSaved("授权失败：" + ((res && res.error) || ""), true); return false; }
        wbSaved("已授权：" + dir);
        draw(res.roots || []);
        return true;
      },
    });
  };
  const bar = wbEl("div", "wb-hook-form");
  bar.appendChild(add);
  g.appendChild(bar);
  g.appendChild(wbNote("撤销授权立刻生效：下一次调用就够不着那个目录，不用等 Agent 重启。" +
    "新加的目录要真被碰过之后，它自己的规则（AGENTS.md / .pancode/rules）才会从下一条消息起注入。"));
  g.appendChild(wbNote("跨根写入不会被当前项目的「始终允许」放行——那边该问的照样问，避免 A 项目的规则替 B 项目做主。"));
  /* 先占位再异步填：这一组要排在「审批策略」之前（先谈能不能进门，再谈进门后能干什么），
     等 fetch 回来再 append 就会掉到整页最后面。 */
  box.appendChild(g);
}

function wbRenderPerms(box) {
  wbRootsGroup(box);
  const c = WB.cfg || {};
  const p = (c.agent && c.agent.permissions) || {};
  const g0 = wbGroup("审批策略", "越宽松越省交互，但误操作半径越大。");
  g0.appendChild(wbSeg("权限模式", "", [
    { v: "plan", t: "只读" }, { v: "default", t: "逐项确认" }, { v: "acceptEdits", t: "放行编辑" }, { v: "yolo", t: "全自动" },
  ], p.mode || "default", (v) => {
    if (v === "yolo" && !confirm("全自动模式将不再询问任何命令与写入，确认开启？")) return wbRepaintSeg(g0);
    wbSave("agent", { permissions: { mode: v } });
  }, "permission mode yolo 权限 审批"));
  g0.appendChild(wbToggle("严格命令拦截", "开启后危险命令走黑名单，即使模式放宽也生效", p.strictCommand !== false,
    (v) => wbSave("agent", { permissions: { strictCommand: v } }), "strict command 黑名单 命令"));
  box.appendChild(g0);

  const g1 = wbGroup("允许 / 拒绝清单", "支持 glob：write_file 配 src/**，run_command 配 npm run test*。会话内「本次都允许」是临时授权，不写在这里。");
  g1.appendChild(wbChips("始终允许", "命中即跳过询问", p.allow || [], (v) => wbSave("agent", { permissions: Object.assign({}, p, { allow: v }) }), "如 run_command: npm run test*", "allow 允许"));
  g1.appendChild(wbChips("始终拒绝", "命中直接拦截，优先于允许", p.deny || [], (v) => wbSave("agent", { permissions: Object.assign({}, p, { deny: v }) }), "如 write_file: .env", "deny 拒绝"));
  box.appendChild(g1);

  const hooks = (c.agent && c.agent.hooks && c.agent.hooks.pre) || [];
  const g2 = wbGroup("前置拦截（hooks）", "在工具执行前无条件 deny，用于把红线固化下来。");
  const list = wbEl("div", "wb-list");
  const draw = (arr) => {
    list.innerHTML = "";
    if (!arr.length) list.appendChild(wbEl("div", "wb-list-empty", "还没有拦截规则"));
    arr.forEach((h, i) => {
      const it = wbEl("div", "wb-list-item");
      it.appendChild(wbEl("span", "wb-badge wb-badge-err", "deny"));
      it.appendChild(wbEl("code", "", esc((h.tool || "*") + "  ~  " + (h.match || ""))));
      it.appendChild(wbEl("span", "wb-list-sub", esc(h.reason || "")));
      const x = wbEl("button", "wb-icon-btn", "✕");
      x.type = "button";
      x.onclick = () => { const n = arr.slice(); n.splice(i, 1); draw(n); wbSave("agent", { hooks: { pre: n } }); };
      it.appendChild(x);
      list.appendChild(it);
    });
  };
  draw(hooks);
  g2.appendChild(list);
  const add = wbEl("input", "wb-input wb-hook-add");
  add.placeholder = "工具名（* 表示全部）";
  const pat = wbEl("input", "wb-input wb-hook-add");
  pat.placeholder = "匹配文本 / glob，如 rm -rf*";
  const rsn = wbEl("input", "wb-input wb-hook-add");
  rsn.placeholder = "拒绝理由（会回灌给模型）";
  const btn = wbEl("button", "wb-btn wb-btn-primary", "添加");
  btn.type = "button";
  btn.onclick = () => {
    const h = { tool: add.value.trim() || "*", match: pat.value.trim(), action: "deny", reason: rsn.value.trim() };
    if (!h.match) return wbSaved("匹配内容不能为空", true);
    const n = hooks.concat([h]);
    add.value = pat.value = rsn.value = "";
    draw(n);
    wbSave("agent", { hooks: { pre: n } });
  };
  const form = wbEl("div", "wb-hook-form");
  form.appendChild(add); form.appendChild(pat); form.appendChild(rsn); form.appendChild(btn);
  g2.appendChild(form);
  box.appendChild(g2);

  const g3 = wbGroup("变更风险体检", "每次改动按敏感度打分，高危文件（密钥、迁移、锁文件）会标红。");
  g3.appendChild(wbNote("风险评分在改动面板与步骤流里展示，无需开关。要调整判定范围请编辑 .pancode/rules 下的规则。"));
  box.appendChild(g3);
}
function wbRepaintSeg(group) {
  const seg = group.querySelector(".wb-segment");
  if (seg) [...seg.children].forEach((b) => b.classList.toggle("active", b.textContent === "逐项确认"));
}

/* ============================================================
   分区：MCP
   ============================================================ */
function wbRenderMcp(box) {
  const c = WB.cfg || {};
  const servers = (c.mcp && c.mcp.configured) || [];
  const running = (c.mcp && c.mcp.running) || [];
  const statusOf = (name) => running.find((s) => s.name === name);
  const g0 = wbGroup("外部工具服务器", "MCP server 提供的工具会以 mcp__服务名__工具名 出现给 Agent。");
  const list = wbEl("div", "wb-list");
  if (!servers.length) list.appendChild(wbEl("div", "wb-list-empty", "还没有 MCP 服务器"));
  servers.forEach((s, i) => {
    const st = statusOf(s.name) || {};
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("span", "wb-badge " + (st.status === "connected" ? "wb-badge-ok" : st.status === "error" ? "wb-badge-err" : "wb-badge-dim"),
      st.status === "connected" ? "已连接" : st.status === "error" ? "异常" : "未连接"));
    it.appendChild(wbEl("b", "", esc(s.name)));
    it.appendChild(wbEl("code", "", esc(s.command + " " + (s.args || []).join(" "))));
    if (s.enabled === false) it.appendChild(wbEl("span", "wb-list-sub", "已停用"));
    const tools = st.tools ? st.tools.length : 0;
    it.appendChild(wbEl("span", "wb-list-sub", tools ? tools + " 个工具" : ""));
    const del = wbEl("button", "wb-icon-btn", "删除");
    del.type = "button";
    del.onclick = () => { const n = servers.slice(); n.splice(i, 1); save(n); };
    it.appendChild(del);
    list.appendChild(it);
  });
  g0.appendChild(list);
  const form = wbEl("div", "wb-mcp-form");
  const n = wbEl("input", "wb-input"); n.placeholder = "名称（字母数字下划线）";
  const cmd = wbEl("input", "wb-input"); cmd.placeholder = "命令，如 npx";
  const args = wbEl("input", "wb-input wb-input-wide"); args.placeholder = "参数，空格分隔";
  const add = wbEl("button", "wb-btn wb-btn-primary", "添加并重连");
  add.type = "button";
  add.onclick = () => {
    const name = n.value.trim().replace(/[^a-zA-Z0-9_]/g, "_");
    if (!name || !cmd.value.trim()) return wbSaved("名称与命令不能为空", true);
    save(servers.concat([{ name, command: cmd.value.trim(), args: args.value.trim() ? args.value.trim().split(/\s+/) : [], enabled: true }]));
  };
  form.appendChild(n); form.appendChild(cmd); form.appendChild(args); form.appendChild(add);
  g0.appendChild(form);
  g0.appendChild(wbAction("重新对账", "不改配置，只按当前配置重连所有服务器", "重连", async () => {
    const r = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reconnect" }) }).then((x) => x.json());
    wbSaved(r.ok ? "已重连" : "重连失败：" + (r.error || ""), !r.ok);
    if (r.ok) await wbReloadInto(box, "mcp");
  }, null, "reconnect mcp"));
  box.appendChild(g0);
  async function save(next) {
    const r = await wbSave("mcp", { servers: next });
    if (r && r.ok) await wbReloadInto(box, "mcp");
  }
}
async function wbReloadInto(box, id) {
  await wbLoadConfig();
  const sec = WB_SECTIONS.find((s) => s.id === id);
  box.innerHTML = "";
  if (sec) sec.render(box);
}

/* ============================================================
   分区：数据与隐私
   ============================================================ */
function wbRenderData(box) {
  const c = WB.cfg || {};
  const g0 = wbGroup("配置导出 / 导入", "导出的 JSON 不含任何 API Key；导入时若带了密钥会被拒绝并说明。");
  g0.appendChild(wbAction("导出配置", "把模型地址、Agent 行为、权限、MCP 存成一份 JSON", "导出", async () => {
    const r = await fetch("/api/config/export").then((x) => x.json());
    if (!r.ok) return wbSaved(r.error || "导出失败", true);
    const blob = new Blob([r.json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = r.filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    wbSaved("已导出 " + r.filename);
  }, null, "export config 导出"));
  g0.appendChild(wbAction("导入配置", "选择之前导出的 pancode 配置 JSON", "选择文件", () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const text = await f.text();
      const r = await fetch("/api/config/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json: text }) }).then((x) => x.json());
      if (!r.ok) return wbSaved(r.error || "导入失败", true);
      wbSaved("已应用：" + (r.applied || []).join(" / ") + ((r.skipped || []).length ? "；跳过 " + r.skipped.length + " 项" : ""));
      await wbLoadConfig();
      openWorkbench(WB.section);
    };
    inp.click();
  }, null, "import config 导入"));
  box.appendChild(g0);

  const g1 = wbGroup("本地数据", "pancode 是本地优先工具：以下内容全部留在本机。");
  g1.appendChild(wbKV("数据目录", (c.paths && c.paths.root) || "—", true));
  g1.appendChild(wbKV("配置文件", (c.paths && c.paths.configFile) || "—", true));
  g1.appendChild(wbKV("规则目录（Agent 实际读取）", ".pancode/rules（在当前工作区内）", true));
  g1.appendChild(wbAction("打开数据目录", "在系统文件管理器中查看", "打开", () => toast("请在文件管理器中进入：" + ((c.paths && c.paths.root) || "")), null, "open dir 目录"));
  box.appendChild(g1);

  const g2 = wbGroup("行为审计", "Agent 的每次写文件 / 删除 / 命令都按日期落盘。");
  g2.appendChild(wbAction("查看审计", "展开最近的工具调用与文件变更流水", "查看", () => openWorkbench("audit"), null, "audit 审计"));
  box.appendChild(g2);
}

/* ============================================================
   分区：关于
   ============================================================ */
function wbRenderAbout(box) {
  const c = WB.cfg || {};
  const g0 = wbGroup("pancode", "本地优先的 Agent 编程工作台。");
  g0.appendChild(wbKV("版本", c.version || "—"));
  g0.appendChild(wbKV("引擎", (c.engine && c.engine.mode) === "llm" ? "真实大模型 · " + c.engine.model : "内置演示引擎"));
  g0.appendChild(wbKV("能力", ((c.features || []).join(" · ")) || "—"));
  box.appendChild(g0);
  const g1 = wbGroup("快捷键");
  const rows = [["Ctrl / ⌘ + K", "命令面板"], ["Ctrl / ⌘ + P", "文件检索"], ["Ctrl / ⌘ + `", "终端"], ["Ctrl / ⌘ + B", "侧栏"], ["Esc", "停止当前任务"]];
  rows.forEach(([k, v]) => g1.appendChild(wbKV(k, v)));
  box.appendChild(g1);
}

/* ============================================================
   外壳
   ================================================= */
function wbBuild() {
  if (WB.root) return;
  const root = wbEl("div", "wb");
  root.id = "workbench";
  root.style.display = "none";
  root.innerHTML =
    '<div class="wb-mask"></div>' +
    '<div class="wb-panel">' +
      '<header class="wb-top">' +
        '<div class="wb-title">' + ico("gear") + '<span>设置</span></div>' +
        '<div class="wb-search-wrap">' + ico("search") + '<input id="wbSearch" placeholder="搜索设置项…" autocomplete="off"></div>' +
        '<span class="wb-saved" id="wbSaved"></span>' +
        '<button class="wb-close" id="wbClose" title="关闭（Esc）">' + ico("close") + '</button>' +
      '</header>' +
      '<div class="wb-main">' +
        '<nav class="wb-nav" id="wbNav"></nav>' +
        '<div class="wb-body-wrap"><section class="wb-body" id="wbBody"></section></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);
  WB.root = root;
  WB.nav = $("wbNav");
  WB.body = $("wbBody");
  WB.search = $("wbSearch");
  root.querySelector(".wb-mask").onclick = closeWorkbench;
  $("wbClose").onclick = closeWorkbench;
  WB.search.oninput = () => { WB.query = WB.search.value.trim().toLowerCase(); wbRenderNav(); wbFilterBody(); };
  WB.search.onkeydown = (e) => {
    if (e.key === "Enter") { const first = WB.nav.querySelector(".wb-nav-item"); if (first) first.click(); }
    if (e.key === "Escape") { WB.search.value = ""; WB.query = ""; wbRenderNav(); wbFilterBody(); }
  };
  replaceIcons(root);
}
function wbVisibleSections() {
  if (!WB.query) return WB_SECTIONS;
  const hit = (s) => (s.title + " " + (s.kw || "") + " " + (s.keywords || "")).toLowerCase().includes(WB.query);
  return WB_SECTIONS.filter(hit);
}
function wbRenderNav() {
  if (!WB.nav) return;
  const list = wbVisibleSections();
  WB.nav.innerHTML = "";
  WB_GROUPS.forEach((grp) => {
    const secs = list.filter((s) => s.group === grp.id);
    if (!secs.length) return;
    WB.nav.appendChild(wbEl("div", "wb-nav-group", esc(grp.label)));
    secs.forEach((s) => {
      const it = wbEl("button", "wb-nav-item" + (s.id === WB.section ? " active" : ""),
        "<span class=\"wb-nav-ico\">" + ico(s.icon || "dot") + "</span><span>" + esc(s.title) + "</span>");
      it.type = "button";
      it.onclick = () => { WB.section = s.id; wbRenderNav(); wbRenderBody(); };
      WB.nav.appendChild(it);
    });
  });
  if (!list.length) WB.nav.appendChild(wbEl("div", "wb-nav-none", "没有匹配的分区"));
}
async function wbRenderBody() {
  const sec = WB_SECTIONS.find((s) => s.id === WB.section) || WB_SECTIONS[0];
  if (!sec) return;
  WB.section = sec.id;
  WB.body.innerHTML = "";
  const head = wbEl("div", "wb-body-head");
  head.appendChild(wbEl("h2", "", esc(sec.title)));
  if (sec.desc) head.appendChild(wbEl("p", "", esc(sec.desc)));
  WB.body.appendChild(head);
  if (typeof API_STALE !== "undefined" && API_STALE) {
    WB.body.appendChild(wbEl("div", "wb-stale",
      "当前运行的后端进程比界面旧（接口指纹对不上），规则 / 技能 / 进化这类较新的分区可能整片报 404。" +
      "重启 pancode 服务（npm start，或重新打包桌面端）后再打开设置即可恢复——只刷新页面没有用。"));
  }
  const holder = wbEl("div", "wb-body-inner");
  WB.body.appendChild(holder);
  if (!WB.cfg) await wbLoadConfig();
  try { await sec.render(holder, WB.query); }
  catch (e) { holder.appendChild(wbEl("div", "wb-note wb-note-err", "这一页加载失败：" + e.message)); }
  replaceIcons(WB.body);
  wbFilterBody();
}
/* 搜索时逐行过滤已渲染内容（分区无关的兜底能力） */
function wbFilterBody() {
  if (!WB.body) return;
  const q = WB.query;
  WB.body.querySelectorAll(".wb-row").forEach((row) => {
    const txt = ((row.dataset.label || "") + " " + (row.dataset.kw || "")).toLowerCase();
    row.style.display = !q || txt.includes(q) ? "" : "none";
  });
  WB.body.querySelectorAll(".wb-group").forEach((g) => {
    const any = [...g.querySelectorAll(".wb-row")].some((r) => r.style.display !== "none");
    const noRows = !g.querySelector(".wb-row");
    g.style.display = (noRows || any || !q) ? "" : "none";
  });
}
async function openWorkbench(section) {
  wbBuild();
  if (section) WB.section = section;
  WB.root.style.display = "flex";
  document.body.classList.add("wb-open");
  WB.lastFocus = document.activeElement;
  await wbLoadConfig();
  wbRenderNav();
  await wbRenderBody();
  setTimeout(() => WB.search && WB.search.focus(), 40);
}
function closeWorkbench() {
  if (!WB.root) return;
  WB.root.style.display = "none";
  document.body.classList.remove("wb-open");
  WB.query = "";
  if (WB.search) WB.search.value = "";
  if (WB.lastFocus && WB.lastFocus.focus) try { WB.lastFocus.focus(); } catch (e) {}
}

/* ---------------- 注册分区 ---------------- */
wbRegister({ id: "appearance", group: "prefs", title: "外观与配色", icon: "sun", desc: "明暗、配色方案与字号", keywords: "theme palette color 主题 配色 字号", render: (b) => wbRenderAppearance(b) });
wbRegister({ id: "general", group: "prefs", title: "通用", icon: "tune", desc: "语言、工作区与编辑器增强", keywords: "language workspace folder editor 语言 工作区", render: (b) => wbRenderGeneral(b) });
wbRegister({ id: "model", group: "engine", title: "模型", icon: "robot", desc: "大模型接口、密钥与向量索引", keywords: "llm model api key embedding 模型 密钥 索引", render: (b) => wbRenderModel(b) });
wbRegister({ id: "agent", group: "engine", title: "Agent 行为", icon: "sparkle", desc: "运行模式、规则、记忆、上下文与长任务时限", keywords: "agent mode rules memory context compact timeout 长任务 时限 超时 模式 上下文 压缩", render: (b) => wbRenderAgent(b) });
wbRegister({ id: "perms", group: "engine", title: "权限与安全", icon: "shield", desc: "授权目录、审批策略、允许/拒绝清单、前置拦截", keywords: "permission deny allow hook yolo security roots 授权 目录 文件夹 权限 安全 审批 拦截", render: (b) => wbRenderPerms(b) });
wbRegister({ id: "mcp", group: "engine", title: "MCP 工具", icon: "layers", desc: "外部工具服务器", keywords: "mcp server tool 外部工具", render: (b) => wbRenderMcp(b) });
wbRegister({ id: "data", group: "data", title: "数据与隐私", icon: "folder", desc: "导出导入、本地数据与审计", keywords: "export import data privacy audit 导出 导入 数据 审计", render: (b) => wbRenderData(b) });
wbRegister({ id: "about", group: "data", title: "关于", icon: "read", desc: "版本与快捷键", keywords: "about version shortcut 关于 版本 快捷键", render: (b) => wbRenderAbout(b) });

/* ---------------- 入口改接：把散落的设置入口收敛到工作台 ----------------
   重复绑定是必要的：app.js 里部分入口在初始化函数中赋值 onclick，
   只跑一次的接管可能被后执行的旧代码盖回去。
   注意 #btnModelChip 不在此列——它是输入栏的模型下拉（app.js wireModelPicker），不是设置入口。 */
function wbWireEntries() {
  const bind = (id, section) => {
    const el = $(id);
    if (el) el.onclick = (e) => { e && e.preventDefault && e.preventDefault(); openWorkbench(section); };
  };
  bind("btnGlobalSettings", "appearance");
  bind("btnSettings", "model");
  bind("btnAgentSettings", "agent");
  bind("envSediment", "sediment");
}
/* 旧设置界面的同名函数：命令面板、斜杠命令、新手引导的内联 onclick 都还在引用它们，
   一律指向工作台对应分区，避免出现"点了没反应 / ReferenceError"。脚本求值时就装好，不等 DOMContentLoaded。 */
window.openSettings = () => openWorkbench("model");
window.openAgentSettings = () => openWorkbench("agent");
window.openSediment = () => openWorkbench("sediment");
/* MCP 连接状态广播：刷新工作台里的 MCP 分区（旧弹窗已下线） */
window.onMcpServers = function (servers) {
  if (!WB.cfg) return;
  WB.cfg.mcp = Object.assign({}, WB.cfg.mcp, { running: servers || [] });
  if (WB.root && WB.root.style.display !== "none" && WB.section === "mcp") wbReloadInto(WB.body, "mcp");
};
[0, 300, 1200, 2500].forEach((ms) => setTimeout(wbWireEntries, ms));
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wbWireEntries);

/* WB / WB_SECTIONS 是 const 声明，不挂在 window 上；assets-center.js 与验证脚本需要读它们 */
window.WB = WB;
window.openWorkbench = openWorkbench;
window.closeWorkbench = closeWorkbench;

/* Esc 关闭工作台（捕获阶段抢在聊天区的 Esc 之前） */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && WB.root && WB.root.style.display !== "none") {
    e.stopPropagation();
    closeWorkbench();
  }
}, true);
