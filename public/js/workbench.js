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

/* 分组名与分区标题都存键名，不存渲染结果：这些表是脚本加载时求值的顶层常量，
   存字符串等于把语言钉死在开机那一刻，之后切换界面就再也跟不上了。 */
const WB_GROUPS = [
  { id: "prefs", labelKey: "wbToplabelT1" },
  { id: "engine", labelKey: "wbToplabelT2" },
  { id: "assets", labelKey: "wbToplabelT3" },
  { id: "data", labelKey: "wbToplabelT4" },
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
    eye.title = t("wbInputtitleT5");
    eye.onclick = () => { inp.type = inp.type === "password" ? "text" : "password"; };
    const wrap = wbEl("div", "wb-input-wrap");
    wrap.appendChild(inp); wrap.appendChild(eye);
    ctrl.appendChild(wrap);
  } else ctrl.appendChild(inp);
  return row;
}

/* ---------- 模型 ID → 上下文窗口联动 ----------
   换模型时自动带出真实窗口：上游 /v1/models 不返回窗口元数据，
   只能靠服务端预设表（/api/llm/presets）。
   只有「用户没手动改过窗口」时才动它 —— 判据是当前窗口值是否等于
   旧模型的预设值。预设表拉不到就什么都不做（宁可不联动，也别猜错窗口
   撞上游 400）。 */
let _wbModelPresets = null;   // { byModel: {id: {contextWindow, note}}, defaultWindow }
function wbMatchPreset(model) {
  if (!_wbModelPresets) return null;
  const m = String(model || "").toLowerCase();
  if (!m) return null;
  for (const p of _wbModelPresets.list || []) {
    if (m.indexOf(p.match.toLowerCase()) >= 0) return p;
  }
  return null;
}
async function wbLoadModelPresets() {
  try {
    const r = await fetch("/api/llm/presets").then((x) => x.json());
    if (r && r.ok && Array.isArray(r.presets)) {
      _wbModelPresets = { list: r.presets, defaultWindow: r.defaultWindow || 128000 };
    }
  } catch (e) { /* 拉不到就保持不联动 */ }
}
function wireModelWindowPreset(modelRow, ctxRow, e) {
  if (!modelRow || !ctxRow) return;
  const modelInp = modelRow.ctrl.querySelector("input");
  const ctxInp = ctxRow.ctrl.querySelector("input");
  if (!modelInp || !ctxInp) return;
  if (!_wbModelPresets) {
    wbLoadModelPresets().then(() => {
      if (_wbModelPresets) wireModelWindowPreset(modelRow, ctxRow, e);
    });
    return;
  }
  /* 记录「本次会话里用户手动改过窗口」—— 用它兜住一种情况：
     用户先改了窗口（值不在预设表里），再换模型，此时不该动。 */
  let manual = false;
  ctxInp.addEventListener("input", () => { manual = true; });
  const origModelCommit = modelInp.onblur;
  modelInp.onblur = (ev) => {
    if (origModelCommit) origModelCommit.call(modelInp, ev);
    const newModel = modelInp.value.trim();
    if (!newModel) return;
    const pre = wbMatchPreset(newModel);
    if (!pre) return;                       // 没命中预设：不猜
    if (manual) return;                     // 用户手改过窗口：尊重用户
    const cur = Number(ctxInp.value) || 0;
    const oldPre = wbMatchPreset(e.model);
    /* 当前窗口值等于「旧模型的预设值」或「兜底值」→ 认为是没手改过的默认值，可以换 */
    const isUntouched = !oldPre ? cur === _wbModelPresets.defaultWindow : cur === oldPre.contextWindow;
    if (!isUntouched) return;
    if (cur === pre.contextWindow) return;  // 已经是目标值
    ctxInp.value = String(pre.contextWindow);
    wbSave("llm", { contextWindow: pre.contextWindow });
    wbSaved((pre.note || newModel) + " · 上下文窗口 → " + pre.contextWindow);
  };
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
    if (!cur.length) box.appendChild(wbEl("span", "wb-chips-empty", t("wbChipswbElT6")));
    cur.forEach((v, i) => {
      const c = wbEl("span", "wb-chip");
      c.appendChild(wbEl("code", "", esc(v)));
      const x = wbEl("button", "wb-chip-x", "✕");
      x.type = "button";
      x.title = t("wbChipstitleT7");
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
      wbSaved(section + t("wbChipswbSavedT54"));
    } else wbSaved((r && r.error) || t("acRuleFormwbSavedT32"), true);
    return r;
  } catch (e) { wbSaved(t("wbChipswbSavedT55") + e.message, true); return { ok: false }; }
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
  const g1 = wbGroup(t("wbAppearancewbGroupT8"), t("wbAppearancewbGroupT9"));
  g1.appendChild(wbSeg(t("wbAppearancewbSegT10"), t("wbAppearancewbSegT11"), [
    { v: "auto", t: t("wbAppearancetT12") }, { v: "dark", t: t("wbAppearancetT13") }, { v: "light", t: t("wbAppearancetT14") },
  ], getThemePref(), (v) => {
    localStorage.setItem("cw-theme", v);
    applyTheme(v);
    wbRepaintGallery();
  }, "theme dark light auto 深色 浅色 主题"));

  const gal = wbEl("div", "wb-palette-gallery");
  gal.id = "wbPaletteGallery";
  g1.appendChild(wbEl("div", "wb-sub-label", t("wbPaletteCount", { n: PALETTES.length })));
  g1.appendChild(gal);
  g1.appendChild(wbEl("div", "wb-note", t("wbAppearancewbElT16")));
  box.appendChild(g1);

  const g2 = wbGroup(t("wbAppearancewbGroupT17"));
  g2.appendChild(wbSlider(t("wbAppearancewbSliderT18"), t("wbAppearancewbSliderT19"), parseFloat(localStorage.getItem("cw-ui-fontsize")) || 13, 11, 18, 0.5, "px",
    (v) => applyUiFontSize(v), "font size ui 字号"));
  g2.appendChild(wbSlider(t("wbAppearancewbSliderT20"), t("wbAppearancewbSliderT21"), parseFloat(localStorage.getItem("cw-fontsize")) || 13.5, 11, 22, 0.5, "px",
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
    card.title = tr(p.name) + " · " + tr(p.desc);
    const sw = wbEl("div", "wb-palette-sw");
    (p.sw || []).slice(0, 4).forEach((color) => {
      const i = wbEl("i");
      i.style.background = color;
      sw.appendChild(i);
    });
    card.appendChild(sw);
    card.appendChild(wbEl("div", "wb-palette-name", esc(tr(p.name))));
    card.appendChild(wbEl("div", "wb-palette-desc", esc(tr(p.desc) + " · " + tr({ dark: "深色", light: "浅色", both: "双模式" }[p.mode] || p.mode))));
    card.onclick = () => { applyPalette(p.id); wbRepaintGallery(); wbSaved(t("wbPaletteSwitched", { name: tr(p.name) })); };
    gal.appendChild(card);
  });
}

/* ============================================================
   分区：通用
   ============================================================ */
function wbRenderGeneral(box) {
  const c = WB.cfg || {};
  const g1 = wbGroup(t("wbGeneralwbGroupT22"));
  g1.appendChild(wbSeg(t("wbGeneralwbSegT23"), t("wbGeneralwbSegT24"), [
    { v: "zh", t: t("wbGeneraltT25") }, { v: "en", t: "English" },
  ], localStorage.getItem("cw-lang") || "zh", (v) => {
    if (typeof setLang === "function") setLang(v);
    wbSaved(t("wbGeneralwbSavedT56"));
  }, "language lang 语言"));
  box.appendChild(g1);

  /* 只有桌面端才谈得上"关窗之后进程去哪"：浏览器里关标签页没有驻留进程这回事，
     这一行在网页态直接不出现，免得摆一个改了没作用的开关骗人。
     写的是 cfg.desktop.closeAction，主进程关窗时读的是同一份（判据在 electron/close-policy.js）。 */
  if (window.pancodeDesktop) {
    const gd = wbGroup(t("wbGeneralwbGroupT26"), t("wbGeneralwbGroupT27"));
    const NAMES = { ask: "每次询问", background: "挂到后台", quit: "直接退出" };
    gd.appendChild(wbSeg(t("wbGeneralwbSegT28"), t("wbGeneralwbSegT29"), [
      { v: "ask", t: NAMES.ask }, { v: "background", t: NAMES.background }, { v: "quit", t: NAMES.quit },
    ], (c.desktop && c.desktop.closeAction) || "ask", (v) => {
      Promise.resolve(wbSave("desktop", { closeAction: v }))
        .then(() => wbSaved(t("wbGeneralwbSavedT57") + (NAMES[v] || v)))
        .catch(() => wbSaved(t("acRuleFormwbSavedT32"), true));
    }, "close 关闭 退出 后台 托盘 tray 窗口 desktop 驻留"));
    box.appendChild(gd);

    /* GPU 策略与 main.js 启动期那份判定同源（electron/main.js gpuPref）：
       默认开（交给 Chromium 自检）；无 GPU 环境选 off 才回到旧的全禁四连。重启生效——
       Chromium 的 GPU 开关是启动期一次性决定，运行时改不回来，所以文案里明说。 */
    const gp = wbGroup(t("wbGeneralwbGroupT30"), t("wbGeneralwbGroupT31"));
    gp.appendChild(wbSeg(t("wbGeneralwbSegT32"), t("wbGeneralwbSegT33"), [
      { v: "on", t: t("wbGeneralwbSegT32") }, { v: "off", t: t("wbGeneraltT34") },
    ], (c.desktop && c.desktop.gpu) || "on", (v) => {
      Promise.resolve(wbSave("desktop", { gpu: v }))
        .then(() => wbSaved(t("wbGeneralwbSavedT58")))
        .catch(() => wbSaved(t("acRuleFormwbSavedT32"), true));
    }, "gpu 硬件加速 显卡 软件渲染 卡顿 性能 闪烁 崩溃"));
    box.appendChild(gp);
  }

  /* 电脑控制与浏览器自动化：两行开关 + 两行"实物到底在不在"。
     状态是跟着配置一起从 /api/config 回的（computerStatus），因为这两项能力都依赖外部实物 ——
     随包的 agent-browser 二进制、常驻 PowerShell + UIA。只给开关不给状态，就会出现
     "界面里明明开着、工具却说没装"，而用户在设置里看不出任何差别。 */
  const comp = c.computer || {};
  const cs = c.computerStatus || {};
  const gc = wbGroup(t("wbCompGroupT1"), t("wbCompGroupT2"));
  gc.appendChild(wbToggle(t("wbCompToggleT3"), t("wbCompToggleT4"), comp.browser !== false, (v) => {
    Promise.resolve(wbSave("computer", { browser: v })).then(() => wbSaved((v ? t("wbCompOnT13") : t("wbCompOffT14")) + t("wbCompToggleT3")));
  }, "browser 浏览器 网页 上网 自动化 playwright web 抓取"));
  if (cs.desktop && cs.desktop.supported) {
    gc.appendChild(wbToggle(t("wbCompToggleT5"), t("wbCompToggleT6"), comp.desktop !== false, (v) => {
      Promise.resolve(wbSave("computer", { desktop: v })).then(() => wbSaved((v ? t("wbCompOnT13") : t("wbCompOffT14")) + t("wbCompToggleT5")));
    }, "桌面 电脑控制 窗口 鼠标 键盘 截屏 uia automation ui"));
  } else {
    gc.appendChild(wbKV(t("wbCompToggleT5"), t("wbCompT7")));
  }
  gc.appendChild(wbToggle(t("wbCompToggleT8"), t("wbCompToggleT9"), comp.headed === true, (v) => {
    Promise.resolve(wbSave("computer", { headed: v })).then(() => wbSaved((v ? t("wbCompOnT13") : t("wbCompOffT14")) + t("wbCompToggleT8")));
  }, "headed 有头 无头 headless 显示窗口 看着它操作"));
  gc.appendChild(wbKV(t("wbCompKVT10"), (cs.browser && cs.browser.available && cs.browser.exe) || (cs.browser && cs.browser.reason) || "—", true));
  gc.appendChild(wbKV(t("wbCompKVT11"), (cs.browser && cs.browser.browser) || t("wbCompT12"), true));
  box.appendChild(gc);

  const g2 = wbGroup(t("wbGeneralwbGroupT35"), t("wbGeneralwbGroupT36"));
  g2.appendChild(wbKV(t("wbGeneralwbKVT37"), (c.workspace && c.workspace.dir) || "—", true));
  const wsDir = (c.workspace && c.workspace.dir) || "";
  g2.appendChild(wbAction(t("wbGeneralwbActionT38"), t("wbGeneralwbActionT39"), t("wbGeneralwbActionT40"), () => {
    if (typeof fmOpenFolder === "function") fmOpenFolder(); else toast(t("wbGeneraltoastT59"));
  }, null, "workspace folder 工作区 文件夹"));
  const recent = ((c.workspace && c.workspace.recent) || []).filter((p) => p !== wsDir);
  if (recent.length) {
    const list = wbEl("div", "wb-recent");
    recent.slice(0, 6).forEach((p) => {
      const it = wbEl("button", "wb-recent-item", "<span>" + ico("folder") + " " + esc(String(p).split(/[\\/]+/).pop()) + "</span><code>" + esc(p) + "</code>");
      it.type = "button";
      it.onclick = () => {
        /* 服务端对未授权过的敏感目录会回 409 needConfirm，这里补一次显式确认再重发。
           已经授权过的目录（最近列表里的绝大多数）不会进这个分支。 */
        const openDir = (confirmWrites) => fetch("/api/workspace", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(confirmWrites ? { dir: p, confirmWrites: true } : { dir: p }),
        }).then((x) => x.json());
        openDir(false).then((r) => {
          if (r && r.needConfirm) {
            if (!confirm(r.error + t("dirConfirmWrite"))) { wbSaved(t("wbGeneralwbSavedT60"), true); return; }
            return openDir(true);
          }
          return r;
        }).then((r) => {
          if (r && r.ok) { wbSaved(t("wbGeneralwbSavedT61")); setTimeout(() => location.reload(), 700); }
          else wbSaved(t("wbGeneralwbSavedT62") + ((r && r.error) || ""), true);
        });
      };
      list.appendChild(it);
    });
    g2.appendChild(wbEl("div", "wb-sub-label", t("wbGeneralwbElT41")));
    g2.appendChild(list);
  }
  box.appendChild(g2);

  /* P-M1 · 独立工作副本（git worktree）。
     紧挨着"工作区"放：它解决的正是"我想同时有两份现实"——
     一份继续跑着手上的活，一份让 Agent 放手改，两边互不可见。
     不是 Git 仓库时整组不出现（摆一排点了必报错的按钮不算功能）。 */
  const gw = wbEl("div", "wb-wt-host");
  box.appendChild(gw);
  wbWorktrees(gw);

  const g3 = wbGroup(t("wbGeneralwbGroupT42"));
  g3.appendChild(wbToggle(t("wbGeneralwbToggleT43"), t("wbGeneralwbToggleT44"), !!(c.agent && c.agent.lsp && c.agent.lsp.enabled),
    (v) => wbSave("agent", { lsp: { enabled: v } }), "lsp 语言服务 诊断"));
  box.appendChild(g3);
}

/* ============================================================
   P-M1 · 独立工作副本（git worktree）
   面板与 Agent 工具调的是同一批 GitLayer 方法（worktrees / addWorktree / removeWorktree），
   名字校验、"只准删 .worktrees 下的"、脏副本要 force 这些边界全在服务端 ——
   两边各写一份判断迟早会漂，这里只负责把人话摆出来。
   ============================================================ */
async function wtFetch(url, method, body) {
  try {
    const r = await fetch(url, {
      method: method || "GET",
      headers: body == null ? {} : { "Content-Type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    try { return JSON.parse(t || "{}"); }
    catch (e) { return { ok: false, error: "服务返回了非 JSON 内容（HTTP " + r.status + "）" }; }
  } catch (e) { return { ok: false, error: e.message }; }
}

async function wbWorktrees(host) {
  host.innerHTML = "";
  const r = await wtFetch("/api/git/worktrees");
  /* available=false（不是 Git 仓库）或读不到：整组不出现。
     给非仓库用户摆一排"点了必报错的按钮"不是功能，是噪音。 */
  if (!r || r.available !== true) return;
  const g = wbGroup(t("wbGeneralwbGroupT45"),
    "同一个仓库再开一份检出：与当前工作区共享 .git，但两边的文件互不影响。副本固定开在仓库根的 "
    + (r.dir || ".worktrees") + "/ 下，并已写进仓库本地的排除表，不会出现在你的改动列表里。");
  const rows = r.worktrees || [];
  const list = wbEl("div", "wb-list");
  if (rows.length <= 1) {
    list.appendChild(wbEl("div", "wb-list-empty", t("wbGeneralwbElT46")));
  } else {
    rows.forEach((w) => list.appendChild(wtRow(w, host)));
  }
  g.appendChild(list);
  g.appendChild(wtAddRow(host));
  host.appendChild(g);
}

function wtRow(w, host) {
  const it = wbEl("div", "wb-list-item wb-wt-item");
  const base = String(w.path || "").split(/[\\/]+/).filter(Boolean).pop() || "副本";
  it.appendChild(wbEl("b", "", esc(base)));
  /* 副本名按设计就是分支名，再并排印一遍同样的字符串是噪音；
     只有真的不一样（游离 HEAD、或目录被手工改过名）才值得单独标出来。 */
  if ((w.branch || "") !== base) it.appendChild(wbEl("code", "", esc(w.branch || "(游离 HEAD)")));
  const p = wbEl("code", "wb-wt-path", esc(w.path));
  p.title = w.path;                                   // 路径必然被截断，title 是看全的唯一去处
  it.appendChild(p);
  if (w.main) it.appendChild(wbEl("span", "wb-badge wb-badge-dim", t("wbWtRowwbElT47")));
  if (w.current) it.appendChild(wbEl("span", "wb-badge wb-badge-blue", t("wbWtRowwbElT48")));
  if (!w.exists) it.appendChild(wbEl("span", "wb-badge wb-badge-warn", t("wbWtRowwbElT49")));
  if (!w.current) {
    const sw = wbEl("button", "wb-btn", t("wbWtRowwbElT50"));
    sw.type = "button";
    sw.title = t("wbWtRowtitleT51");
    sw.onclick = () => {
      const open = (confirmWrites) => wtFetch("/api/workspace", "POST",
        confirmWrites ? { dir: w.path, confirmWrites: true } : { dir: w.path });
      open(false).then((x) => {
        if (x && x.needConfirm) {
          if (!confirm(x.error + t("dirConfirmWrite"))) return { ok: false, error: t("wbGeneralwbSavedT60") };
          return open(true);
        }
        return x;
      }).then((x) => {
        if (x && x.ok) { wbSaved(t("wbWtRowwbSavedT63")); setTimeout(() => location.reload(), 700); }
        else wbSaved(t("wbGeneralwbSavedT62") + ((x && x.error) || ""), true);
      });
    };
    it.appendChild(sw);
  }
  if (!w.main && w.exists) {
    const rm = wbEl("button", "wb-btn wb-btn-danger", t("wbChipstitleT7"));
    rm.type = "button";
    rm.onclick = async () => {
      if (!confirm(t("wtRemoveConfirm", { name: tr(base), path: w.path }))) return;
      let x = await wtFetch("/api/git/worktree", "DELETE", { path: w.path });
      if (!x.ok && x.dirty) {
        if (!confirm("这份副本里还有未提交 / 未跟踪的文件：\n" + (x.error || "") + "\n\n仍要连它们一起删掉吗？分支和主检出都不受影响。")) return;
        x = await wtFetch("/api/git/worktree", "DELETE", { path: w.path, force: true });
      }
      if (!x.ok) return wbSaved(t("wbWtRowwbSavedT65") + (x.error || t("apbuildCodeIndexC7")), true);
      wbSaved(t("wbWtRowwbSavedT66") + x.removed);
      wbWorktrees(host);
    };
    it.appendChild(rm);
  }
  return it;
}

function wtAddRow(host) {
  const row = wbRow(t("wbWtAddRowwbRowT52"), t("wbWtAddRowwbRowT53"));
  const name = wbEl("input", "wb-input");
  name.placeholder = t("wbWtAddRowplaceholderT54");
  name.maxLength = 40;
  const base = wbEl("input", "wb-input");
  base.placeholder = t("wbWtAddRowplaceholderT55");
  base.maxLength = 80;
  const btn = wbEl("button", "wb-btn wb-btn-primary", t("wbWtAddRowwbElT56"));
  btn.type = "button";
  btn.onclick = async () => {
    const v = name.value.trim();
    if (!v) return wbSaved(t("wbWtAddRowwbSavedT67"), true);
    btn.disabled = true;
    const x = await wtFetch("/api/git/worktree", "POST", { name: v, base: base.value.trim() || undefined });
    btn.disabled = false;
    if (!x.ok) return wbSaved(t("wbWtAddRowwbSavedT68") + (x.error || t("apbuildCodeIndexC7")), true);
    wbSaved(t("wbWtAddRowwbSavedT69") + x.branch + " → " + x.path + (x.reusedBranch ? t("wowtAddRowC42") : t("wowtAddRowC43")));
    wbWorktrees(host);
  };
  row.ctrl.appendChild(name);
  row.ctrl.appendChild(base);
  row.ctrl.appendChild(btn);
  return row;
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

  const g = wbGroup(t("wbWtAddRowwbGroupT57"), t("wbWtAddRowwbGroupT58"));
  box.appendChild(g);
  g.appendChild(wbKV(t("wbWtAddRowwbKVT59"), (e.mode === "llm" ? t("wbWtAddRowwbKVT114") : t("wbWtAddRowwbKVT70")) +
    (e.model ? " · " + tr(e.model) : "") + (e.hasKey ? t("keyTail", { tail: e.keyTail || "" }) : t("noKey"))));

  const modelList = wbEl("div", "wb-model-list");
  const urlRow = wbInput(t("wbWtAddRowwbInputT60"), t("wbWtAddRowwbInputT61"), e.baseURL,
    (v) => { if (v) { wbSave("llm", { baseURL: v }); modelList.innerHTML = ""; if (typeof invalidateModelCache === "function") invalidateModelCache(); } },
    { wide: true, placeholder: "https://api.openai.com/v1" }, "base url endpoint 接口 网关");
  const keyRow = wbInput("API Key", t("wbWtAddRowwbInputT62"), "",
    (v) => { if (v) { wbSave("llm", { apiKey: v }); if (typeof invalidateModelCache === "function") invalidateModelCache(); } },
    { wide: true, password: true, placeholder: e.hasKey ? "已保存 " + (e.keyTail || "") + "（留空不修改）" : "sk-…" }, "api key 密钥");
  g.appendChild(urlRow);
  g.appendChild(keyRow);
  const urlInp = urlRow.querySelector("input");
  const keyInp = keyRow.querySelector("input");

  const stepRow = wbRow(t("modelChip"), t("wbWtAddRowwbRowT63"), t("wbWtAddRowwbRowT115"));
  const btns = wbEl("div", "wb-inline-actions");
  const pull = wbEl("button", "wb-btn wb-btn-primary", t("fetchModels")); pull.type = "button";
  const test = wbEl("button", "wb-btn", t("wbWtAddRowwbElT64")); test.type = "button";
  btns.appendChild(pull); btns.appendChild(test);
  stepRow.ctrl.appendChild(btns);
  stepRow.ctrl.appendChild(modelList);
  g.appendChild(stepRow);

  const paintModels = (ids) => {
    modelList.innerHTML = "";
    if (!ids.length) {
      modelList.appendChild(wbEl("div", "wb-model-none", t("wbWtAddRowwbElT65")));
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
    modelList.appendChild(wbEl("div", "wb-model-meta", t("wbModelListMeta", { n: ids.length })));
  };
  /* 表单值优先；两处都留空时才回落到已保存的配置 */
  const formCreds = () => ({ baseURL: urlInp.value.trim(), apiKey: keyInp.value.trim() });
  const showFail = (msg) => {
    modelList.innerHTML = "";
    modelList.appendChild(wbEl("div", "wb-model-none", t("wbWtAddRowwbElT116") + msg));
  };
  pull.onclick = async () => {
    pull.disabled = true; pull.textContent = t("wbWtAddRowtextContentT68");
    modelList.innerHTML = "";
    modelList.appendChild(wbEl("div", "wb-model-none", t("wbWtAddRowwbElT117") + (formCreds().baseURL || e.baseURL || t("noBaseURLSet")) + "/models …"));
    try {
      const r = await wbPost("/api/models", formCreds());
      const ids = (r && r.models || []).filter(Boolean);
      if (ids.length) {
        paintModels(ids);
        if (typeof invalidateModelCache === "function") invalidateModelCache();
        wbSaved(t("wbWtAddRowwbSavedT71") + ids.length + t("wowbRenderModelC44"));
      } else {
        const err = (r && r.error) || "对方未返回模型列表";
        showFail(err);
        wbSaved(err, true);
      }
    } catch (err) {
      showFail(err.message);
      wbSaved(t("wbWtAddRowwbElT116") + err.message, true);
    } finally { pull.disabled = false; pull.textContent = t("fetchModels"); }
  };
  test.onclick = async () => {
    test.disabled = true; test.textContent = t("wbWtAddRowtextContentT70");
    try {
      const modelInp = g.querySelector('input[placeholder*="模型 ID"]');
      const r = await wbPost("/api/settings/test", Object.assign(formCreds(), { model: modelInp ? modelInp.value.trim() : "" }));
      wbSaved(r.ok ? t("wbWtAddRowwbSavedT72") + String(r.sample || "").slice(0, 40) : t("wowbRenderModelC45") + (r.error || ""), !r.ok);
    } catch (err) { wbSaved(t("wbWtAddRowwbSavedT73") + err.message, true); }
    finally { test.disabled = false; test.textContent = t("wbWtAddRowwbElT64"); }
  };

  /* 模型 ID 与上下文窗口联动。
     上游 /v1/models 不返回窗口元数据，只能靠本地预设表（/api/llm/presets）。
     判据：窗口当前值「等于旧模型的预设值」→ 说明用户没手动改过，可以跟着换；
     等于别的值 → 用户手改过，绝不覆盖。 */
  const modelRow = wbInput(t("wbWtAddRowwbInputT71"), t("wbWtAddRowwbInputT72"), e.model === t("engineDemo") ? "" : e.model,
    (v) => v && wbSave("llm", { model: v }), { wide: true, placeholder: t("wbWtAddRowplaceholderT73") }, "model 模型 id");
  const ctxRow = wbInput(t("wbWtAddRowwbInputT74"), t("wbWtAddRowwbInputT75"), e.contextWindow || 128000,
    (v) => wbSave("llm", { contextWindow: v }), { min: 4096, max: 2000000, step: 1024 }, "context window token 上下文");
  g.appendChild(modelRow);
  g.appendChild(ctxRow);
  wireModelWindowPreset(modelRow, ctxRow, e);
  g.appendChild(wbInput(t("wbWtAddRowwbInputT76"), t("wbWtAddRowwbInputT77"), e.maxToolRounds || 100,
    (v) => wbSave("llm", { maxToolRounds: v }), { min: 5, max: 500 }, "rounds max 轮次 预算"));
  g.appendChild(wbInput(t("wbWtAddRowwbInputT78"), t("wbWtAddRowwbInputT79"), e.maxOutputTokens || 0,
    (v) => wbSave("llm", { maxOutputTokens: v }), { min: 0, max: 1000000, step: 1024 }, "max output tokens 输出 预留 budget"));

  /* 视觉开关。默认关不是审美问题，是这条链的两个真实代价：一张截图约 1.5k token，
     而模型不带视觉时收到图片直接 400。开了以后仍然要截图工具显式带 for_model 才喂像素
     （见 server/computer/vision.js）——这一行只决定"能不能喂"，不决定"每次都喂"。 */
  g.appendChild(wbToggle(t("wbWtVisionT1"), t("wbWtVisionT2"), e.vision === true, (v) => {
    Promise.resolve(wbSave("llm", { vision: v })).then(() => wbSaved((v ? t("wbCompOnT13") : t("wbCompOffT14")) + t("wbWtVisionT1")));
  }, "vision 视觉 图片 截图 像素 screenshot image 多模态"));

  /* 存成一份可切换的配置 */
  const saveRow = wbRow(t("wbWtAddRowwbRowT80"), t("wbWtAddRowwbRowT81"), t("wbWtAddRowwbRowT118"));
  const nameInp = wbEl("input", "wb-input");
  nameInp.placeholder = t("wbWtAddRowplaceholderT82");
  nameInp.style.flex = "1";
  const saveBtn = wbEl("button", "wb-btn wb-btn-primary", t("wbWtAddRowwbElT83")); saveBtn.type = "button";
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
      // 上下文相关的两个输入框：失焦即保存，这里带上当前值，避免"存配置存的是旧参数"
      const wi = g.querySelector('input[placeholder*="上下文"]');
      if (wi && Number(wi.value) > 0) body.contextWindow = Number(wi.value);
      const ri = g.querySelector('input[placeholder*="轮次"]');
      if (ri && Number(ri.value) > 0) body.maxToolRounds = Number(ri.value);
      const oi = g.querySelector('input[placeholder*="预留"]');
      if (oi && oi.value.trim() !== "" && Number(oi.value) >= 0) body.maxOutputTokens = Number(oi.value);
      const r = await wbPost("/api/llm/profiles", body);
      if (r && r.ok) {
        wbSaved(t("wbWtAddRowwbSavedT74") + r.profile.name + "」"); nameInp.value = "";
        if (typeof invalidateModelCache === "function") invalidateModelCache();
        wbReloadInto(box, "model");
      }
      else wbSaved((r && r.error) || t("acRuleFormwbSavedT32"), true);
    } catch (err) { wbSaved(t("wbChipswbSavedT55") + err.message, true); }
    finally { saveBtn.disabled = false; }
  };
  const grp = wbEl("div", "wb-inline-actions");
  grp.appendChild(nameInp); grp.appendChild(saveBtn);
  saveRow.ctrl.appendChild(grp);
  g.appendChild(saveRow);

  /* 已保存的配置列表 */
  const g2 = wbGroup(t("wbWtAddRowwbGroupT84"), t("wbWtAddRowwbGroupT85"));
  box.appendChild(g2);
  if (!profiles.length) g2.appendChild(wbNote(t("wbWtAddRowwbNoteT86"), "dim"));
  profiles.forEach((p) => {
    const row = wbEl("div", "wb-profile");
    row.appendChild(wbEl("div", "wb-profile-name", esc(p.name)));
    row.appendChild(wbEl("div", "wb-profile-sub", esc(p.baseURL) + " · " + esc(tr(p.model || t("noModelChosen"))) +
      (p.hasKey ? t("keyTail", { tail: esc(p.keyTail || "") }) : t("noKey"))));
    const use = wbEl("button", "wb-btn wb-btn-mini", t("wbWtAddRowwbElT87")); use.type = "button";
    use.onclick = async () => {
      const r = await wbPost("/api/llm/profiles/" + encodeURIComponent(p.id) + "/apply", {});
      if (r && r.ok) {
        wbSaved(t("wbWtAddRowwbSavedT75") + p.name + "」" + (r.hasKey ? "" : t("wowbRenderModelC46")));
        if (typeof invalidateModelCache === "function") invalidateModelCache();
        wbReloadInto(box, "model");
      }
      else wbSaved((r && r.error) || t("wbWtAddRowwbSavedT76"), true);
    };
    const del = wbEl("button", "wb-btn wb-btn-mini wb-btn-danger", t("delete")); del.type = "button";
    del.onclick = async () => {
      if (!confirm(t("wbWtAddRowconfirmT77") + p.name + t("wowbRenderModelC47"))) return;
      const r = await wbDel("/api/llm/profiles/" + encodeURIComponent(p.id));
      if (r && r.ok) {
        if (typeof invalidateModelCache === "function") invalidateModelCache();
        wbSaved(t("skillDeleted")); wbReloadInto(box, "model");
      } else wbSaved(t("acExpertFormwbSavedT12"), true);
    };
    const acts = wbEl("div", "wb-inline-actions");
    acts.appendChild(use); acts.appendChild(del);
    row.appendChild(acts);
    g2.appendChild(row);
  });

  const emb = c.embedding || {};
  const g3 = wbGroup(t("wbWtAddRowwbGroupT88"), t("wbWtAddRowwbGroupT89"));
  box.appendChild(g3);
  g3.appendChild(wbInput("Endpoint", "", emb.endpoint, (v) => wbSave("embedding", { endpoint: v }), { wide: true, placeholder: "https://api.openai.com/v1" }, t("wbWtAddRowwbInputT90")));
  g3.appendChild(wbInput("API Key", "", "", (v) => v && wbSave("embedding", { apiKey: v }), { wide: true, password: true, placeholder: emb.hasKey ? t("wbWtAddRowwbInputT119") + (emb.keyTail || "") + t("wbWtAddRowwbInputT120") : t("wbWtAddRowwbInputT78") }, "embedding key"));
  g3.appendChild(wbInput(t("modelChip"), "", emb.model, (v) => v && wbSave("embedding", { model: v }), { placeholder: "text-embedding-3-small" }, "embedding model"));
  g3.appendChild(wbAction(t("rebuildIndex"), t("wbWtAddRowwbActionT93"), t("wbWtAddRowwbActionT94"), async (b) => {
    b.textContent = t("wbWtAddRowtextContentT95");
    try {
      const r = await fetch("/api/index/build", { method: "POST" }).then((x) => x.json());
      wbSaved(r.ok ? t("wbWtAddRowwbSavedT79") : t("wowbRenderModelC5") + (r.error || ""), !r.ok);
    } finally { b.textContent = t("wbWtAddRowwbActionT94"); }
  }, null, "index build 索引"));

  await wbPricingGroup(box);
}

/* ============================================================
   P1-B4 · 单价与用量
   单价按「每 100 万 token 的货币额」填（供应商标价就是这种形式，抄账单不容易错）。
   刻意不内置任何默认价格：猜一个数打在面板上会被用户拿去做决定，比留空更糟。
   编辑方式沿用本页 MCP 服务器那一套（列出现有行 + 删除 + 底部表单添加 + 整表保存），
   不另造一种交互。
   ============================================================ */
async function wbPricingGroup(box) {
  const c = WB.cfg || {};
  const pr = (c.agent && c.agent.pricing) || { currency: "CNY", rates: [] };
  let usage = null;
  try { usage = await wbGet("/api/usage?days=30"); } catch (e) { usage = null; }

  /* 金额显示口径与 server/cost.js 的 fmtMoney 保持一致（不足 1 元留 4 位小数），
     否则同一笔钱在两处显示成 "¥0.00" 和 "¥0.0064" 会被当成 bug。 */
  const money = (n, cur) => {
    const sym = ({ CNY: "¥", USD: "$", EUR: "€" })[String(cur || "CNY").toUpperCase()] || (String(cur || "CNY").toUpperCase() + " ");
    const v = Number(n) || 0;
    return sym + v.toFixed(Math.abs(v) < 1 ? 4 : Math.abs(v) < 100 ? 3 : 2);
  };

  const g = wbGroup(t("wbWtAddRowwbGroupT96"), t("wbWtAddRowwbGroupT97"));
  box.appendChild(g);

  const cur = (usage && usage.currency) || pr.currency || "CNY";
  /* 区分两件常被混为一谈的事：
       配了单价没有 —— 看 rates 清单（配置）；
       有没有花钱 —— 看 priced（账本里是否存在被定价覆盖的条目）。
     用 priced 当"配没配"会使刚填完价格、还没有用量的时候显示"未配置单价"，
     用户会以为设置没保存，接着再填一遍。 */
  const hasRates = (pr.rates || []).length > 0 || ((usage && usage.rates) || []).length > 0;
  if (usage && usage.ok) {
    const td = usage.today || { total: 0 };
    g.appendChild(wbKV(t("wbWtAddRowwbKVT98"), (hasRates
      ? money(td.total, cur) + (td.total > 0 ? "" : t("noUsageYet"))
      : t("costUnpriced"))
      + (td.models && Object.keys(td.models).length ? t("nModels", { n: Object.keys(td.models).length }) : "")));
    g.appendChild(wbKV(t("wbWtAddRowwbKVT99"), (hasRates ? money(usage.total, cur) + " · " : "") +
      t("costInOut", { i: Math.round((usage.prompt || 0) / 1000), o: Math.round((usage.completion || 0) / 1000) })));
    const perModel = Object.keys(usage.models || {});
    if (perModel.length) {
      g.appendChild(wbEl("div", "wb-list", perModel.slice(0, 6).map((m) => {
        const v = usage.models[m];
        return '<div class="wb-list-item"><b>' + esc(m) + "</b>" +
          '<span class="wb-list-sub">' + Math.round((v.prompt || 0) / 1000) + "k in / " + Math.round((v.completion || 0) / 1000) + "k out</span>" +
          '<span class="wb-list-sub">' + (hasRates ? money(v.cost, v.currency || cur) : "—") + "</span></div>";
      }).join("")));
    }
    if (!hasRates) g.appendChild(wbNote(t("wbWtAddRowwbNoteT100"), "dim"));
  } else {
    g.appendChild(wbNote(t("wbWtAddRowwbNoteT101"), "warn"));
  }

  const rates = (pr.rates || []).slice();
  const save = async (next) => {
    const r = await wbSave("agent", { pricing: { enabled: pr.enabled !== false, currency: cur, rates: next } });
    if (r && r.ok) await wbReloadInto(box, "model");
  };

  const list = wbEl("div", "wb-list");
  if (!rates.length) list.appendChild(wbEl("div", "wb-list-empty", t("wbWtAddRowwbElT102")));
  rates.forEach((r, i) => {
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("b", "", esc(r.match)));
    it.appendChild(wbEl("span", "wb-list-sub", t("costPerMillion", { i: r.input != null ? r.input : "—", o: r.output != null ? r.output : "—" })));
    if (r.currency) it.appendChild(wbEl("span", "wb-list-sub", r.currency));
    const del = wbEl("button", "wb-icon-btn", t("delete"));
    del.type = "button";
    del.onclick = () => { const n = rates.slice(); n.splice(i, 1); save(n); };
    it.appendChild(del);
    list.appendChild(it);
  });
  g.appendChild(list);

  const form = wbEl("div", "wb-mcp-form");
  const m = wbEl("input", "wb-input"); m.placeholder = t("wbWtAddRowwbElT104");
  const pi = wbEl("input", "wb-input"); pi.placeholder = t("wbWtAddRowwbElT105"); pi.type = "number"; pi.min = "0"; pi.step = "0.01";
  const po = wbEl("input", "wb-input"); po.placeholder = t("wbWtAddRowwbElT106"); po.type = "number"; po.min = "0"; po.step = "0.01";
  const add = wbEl("button", "wb-btn wb-btn-primary", t("wbWtAddRowwbElT107"));
  add.type = "button";
  add.onclick = () => {
    const match = m.value.trim();
    const a = Number(pi.value), b = Number(po.value);
    if (!match) return wbSaved(t("wbWtAddRowwbSavedT80"), true);
    if (!Number.isFinite(a) && !Number.isFinite(b)) return wbSaved(t("wbWtAddRowwbSavedT81"), true);
    const row = { match: match.slice(0, 80) };
    if (Number.isFinite(a) && a >= 0) row.input = a;
    if (Number.isFinite(b) && b >= 0) row.output = b;
    save(rates.concat([row]));
  };
  form.appendChild(m); form.appendChild(pi); form.appendChild(po); form.appendChild(add);
  g.appendChild(form);
  g.appendChild(wbInput(t("wbWtAddRowwbInputT108"), t("wbWtAddRowwbInputT109"), cur,
    (v) => wbSave("agent", { pricing: { enabled: pr.enabled !== false, currency: String(v || "").trim().toUpperCase() || cur, rates } })
      .then((r) => { if (r && r.ok) wbReloadInto(box, "model"); }),
    { placeholder: "CNY / USD" }, "currency 币种"));
}

/* ============================================================
   分区：Agent 行为
   ============================================================ */
function wbRenderAgent(box) {
  const c = WB.cfg || {};
  const ag = c.agent || {};
  const g0 = wbGroup(t("wbAgentwbGroupT110"), t("wbAgentwbGroupT111"));
  const a = c.assets || {};
  const strip = wbEl("div", "wb-stats");
  [[t("statRules"), a.rules], [t("statMemory"), a.memory], [t("statSkills"), a.skills && a.skills.total], [t("statExperts"), a.experts]].forEach(([k, v]) => {
    const it = wbEl("div", "wb-stat");
    it.appendChild(wbEl("b", "", String(v == null ? 0 : v)));
    it.appendChild(wbEl("span", "", k));
    strip.appendChild(it);
  });
  g0.appendChild(strip);
  g0.appendChild(wbAction(t("wbAgentwbActionT112"), t("wbAgentwbActionT113"), t("wbAgentwbActionT114"), () => openWorkbench("experts"), null, t("wbAgentwbActionT122")));
  box.appendChild(g0);

  const g1 = wbGroup(t("wbAgentwbGroupT115"), t("wbAgentwbGroupT116"));
  g1.appendChild(wbSeg(t("wbAgentwbSegT117"), t("wbAgentwbSegT118"), [
    { v: "agent", t: t("wbAgenttT119") }, { v: "plan", t: t("wbAgenttT120") }, { v: "ask", t: t("wbAgenttT121") },
  ], ag.agentMode || "agent", (v) => wbSave("agent", { agentMode: v }), "mode plan ask agent 模式"));
  g1.appendChild(wbToggle(t("wbAgentwbToggleT122"), t("wbAgentwbToggleT123"), !!(ag.rules && ag.rules.enabled),
    (v) => wbSave("agent", { rules: { enabled: v } }), "rules 规则"));
  g1.appendChild(wbToggle(t("wbAgentwbToggleT124"), t("wbAgentwbToggleT125"), !!(ag.memory && ag.memory.enabled),
    (v) => wbSave("agent", { memory: { enabled: v } }), "memory 记忆"));
  /* 自动结算只在「长期记忆」开着时才生效，但开关显示的是它自己的真实配置值——
     不跟着上面那个联动，否则"明明开了却显示关"会变成第二层要解释的状态。
     依赖关系写进副标题里说清楚。 */
  g1.appendChild(wbToggle(t("wbAgentwbToggleT139"), t("wbAgentwbToggleT140"),
    (ag.memory || {}).autoSettle !== false,
    (v) => wbSave("agent", { memory: { autoSettle: v } }), "autoSettle 结算 决策链"));
  box.appendChild(g1);

  const ctx = ag.context || {};
  const g2 = wbGroup(t("ctxLabel"), t("wbAgentwbGroupT126"));
  g2.appendChild(wbToggle(t("wbAgentwbToggleT127"), t("wbAgentwbToggleT128"), ctx.autoCompact !== false,
    (v) => wbSave("agent", { context: { autoCompact: v } }), "compact 压缩"));
  g2.appendChild(wbInput(t("wbAgentwbInputT129"), t("wbAgentwbInputT130"), ctx.budgetTokens || 100000,
    (v) => wbSave("agent", { context: { budgetTokens: v } }), { min: 8000, max: 2000000, step: 1000 }, "budget token 预算"));
  box.appendChild(g2);

  /* 长任务时限：这三项是「跑几分钟就断」的直接开关，默认按长任务设定。
     审批时限尤其重要——原实现 120 秒无人点就自动拒绝，Agent 于是带着「用户拒绝」继续收尾，
     看起来就像任务中途死了。 */
  const to = ag.timeouts || {};
  const g3 = wbGroup(t("wbAgentwbGroupT131"), t("wbAgentwbGroupT132"));
  g3.appendChild(wbInput(t("wbAgentwbInputT133"), t("wbAgentwbInputT134"),
    to.commandSec == null ? 600 : to.commandSec,
    (v) => wbSave("agent", { timeouts: { commandSec: v } }), { min: 15, max: 7200, step: 15 }, "command 命令 构建 timeout"));
  g3.appendChild(wbInput(t("wbAgentwbInputT135"), t("wbAgentwbInputT136"),
    to.approvalSec == null ? 1200 : to.approvalSec,
    (v) => wbSave("agent", { timeouts: { approvalSec: v } }), { min: 30, max: 7200, step: 30 }, "approval 审批 确认 等待"));
  g3.appendChild(wbInput(t("wbAgentwbInputT137"), t("wbAgentwbInputT138"),
    to.toolSec == null ? 120 : to.toolSec,
    (v) => wbSave("agent", { timeouts: { toolSec: v } }), { min: 15, max: 3600, step: 15 }, "tool 工具 guard 兜底"));
  /* 看门狗的两个旋钮（server/run-watchdog.js）：跑得久不是问题，停着不动才是。
     以前只有配置文件能改，而"能配却看不见"正是上一轮 agentMaxMs 那种缺陷的温床。 */
  g3.appendChild(wbInput(t("wbAgentStallMin"), t("wbAgentStallMinTip"),
    Math.min(60, Math.max(1, Math.round((Number(ag.agentStallMs) || 360000) / 60000))),
    (v) => wbSave("agent", { agentStallMs: Math.round(Number(v) * 60000) }), { min: 1, max: 60, step: 1 }, "stall watchdog 停滞 卡住 看门狗 分钟"));
  g3.appendChild(wbInput(t("wbAgentMaxHours"), t("wbAgentMaxHoursTip"),
    Math.min(48, Math.max(0.5, Math.round(((Number(ag.agentMaxMs) || 28800000) / 3600000) * 2) / 2)),
    (v) => wbSave("agent", { agentMaxMs: Math.round(Number(v) * 3600000) }), { min: 0.5, max: 48, step: 0.5 }, "max wall clock 墙钟 上限 小时 长任务"));
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
  const g = wbGroup(t("wbRootsGroupwbGroupT139"), t("wbRootsGroupwbGroupT140"));
  const list = wbEl("div", "wb-list");
  list.appendChild(wbEl("div", "wb-list-empty", t("wbRootsGroupwbElT141")));
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
      list.appendChild(wbEl("div", "wb-list-empty", t("wbRootsGroupwbElT142")));
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
      if (isActive) it.appendChild(wbEl("span", "wb-badge wb-badge-blue", t("wbGeneralwbKVT37")));
      if (row.stale) it.appendChild(wbEl("span", "wb-badge wb-badge-warn", t("wbRootsGroupwbElT143")));
      if (row.moved) it.appendChild(wbEl("span", "wb-badge wb-badge-warn", t("wbRootsGroupwbElT144")));
      if (!row.writable && !row.stale) it.appendChild(wbEl("span", "wb-badge", t("wbRootsGroupwbElT145")));

      /* 与 .wb-switch 同一套外观，只是嵌在列表行里：每行都能单独收放读写档位 */
      const sw = wbEl("button", "wb-switch wb-root-switch" + (row.writable ? " on" : ""));
      sw.type = "button";
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", row.writable ? "true" : "false");
      sw.title = row.writable ? t("rootWritableTip") : t("rootReadonlyTip");
      sw.appendChild(wbEl("span", "wb-knob"));
      sw.onclick = async () => {
        const res = await post("/api/roots/" + encodeURIComponent(row.id) + "/writable", { writable: !row.writable });
        if (!res.ok) return wbSaved(t("wbRootsGroupwbSavedT82") + ((res && res.error) || ""), true);
        wbSaved((row.writable ? t("wbRootsGroupwbSavedT83") : t("wbRootsGroupC1")) + (row.label || row.path));
        draw(res.roots || roots);
      };
      it.appendChild(sw);

      const x = wbEl("button", "wb-icon-btn", ico("close"));
      x.type = "button";
      if (isActive) {
        /* 当前工作区撤了等于 Agent 什么都碰不到，而且下次挂载会被 ensure 加回来 ——
           给个能点的 X 只会让人以为"撤销成功了但怎么还在" */
        x.disabled = true;
        x.title = t("wbRootsGrouptitleT146");
      } else {
        x.title = t("wbRootsGrouptitleT147");
        x.onclick = async () => {
          if (!confirm(t("wbRootsGroupconfirmT84") + (row.label || row.path) + t("wbRootsGroupC2"))) return;
          const res = await post("/api/roots/" + encodeURIComponent(row.id), null, "DELETE");
          if (!res.ok) return wbSaved(t("wbRootsGroupwbSavedT85") + ((res && res.error) || ""), true);
          wbSaved(t("wbRootsGroupwbSavedT86") + (row.label || row.path));
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
      g.querySelector(".wb-group-desc").textContent = t("wbRootsGrouptextContentT123") + (r.error || t("apapplyModelC22"));
      list.innerHTML = "";
      list.appendChild(wbEl("div", "wb-list-empty wb-list-err", t("wbRootsGroupwbElT149")));
      return;
    }
    activeId = r.activeId || "";
    draw(r.roots || []);
    replaceIcons(list);
  }).catch((e) => {
    list.innerHTML = "";
    list.appendChild(wbEl("div", "wb-list-empty wb-list-err", t("wbRootsGroupwbElT124") + e.message));
  });

  const add = wbEl("button", "wb-btn wb-btn-primary", t("wbRootsGroupwbElT151"));
  add.type = "button";
  add.onclick = () => {
    if (typeof fmOpenPicker !== "function") return wbSaved(t("wbGeneraltoastT59"), true);
    fmOpenPicker({
      title: t("wbRootsGrouptitleT152"),
      btnText: t("wbRootsGroupbtnTextT153"),
      onPick: async (dir) => {
        const res = await post("/api/roots", { path: dir, writable: true });
        if (!res.ok) { wbSaved(t("wbRootsGroupwbSavedT87") + ((res && res.error) || ""), true); return false; }
        wbSaved(t("wbRootsGroupwbSavedT88") + dir);
        draw(res.roots || []);
        return true;
      },
    });
  };
  const bar = wbEl("div", "wb-hook-form");
  bar.appendChild(add);
  g.appendChild(bar);
  g.appendChild(wbNote(t("wbRootsGroupwbNoteT125") + t("rootsNoteTail")));
  g.appendChild(wbNote(t("wbRootsGroupwbNoteT155")));
  /* 先占位再异步填：这一组要排在「审批策略」之前（先谈能不能进门，再谈进门后能干什么），
     等 fetch 回来再 append 就会掉到整页最后面。 */
  box.appendChild(g);
}

function wbRenderPerms(box) {
  wbRootsGroup(box);
  const c = WB.cfg || {};
  const p = (c.agent && c.agent.permissions) || {};
  const g0 = wbGroup(t("wbPermswbGroupT156"), t("wbPermswbGroupT157"));
  g0.appendChild(wbSeg(t("wbPermswbSegT158"), "", [
    { v: "plan", t: t("wbRootsGroupwbElT145") }, { v: "default", t: t("wbPermstT159") }, { v: "acceptEdits", t: t("wbPermstT160") }, { v: "yolo", t: t("wbPermstT161") },
  ], p.mode || "default", (v) => {
    if (v === "yolo" && !confirm(t("wbPermsconfirmT89"))) return wbRepaintSeg(g0);
    wbSave("agent", { permissions: { mode: v } });
  }, "permission mode yolo 权限 审批"));
  g0.appendChild(wbToggle(t("wbPermswbToggleT162"), t("wbPermswbToggleT163"), p.strictCommand !== false,
    (v) => wbSave("agent", { permissions: { strictCommand: v } }), "strict command 黑名单 命令"));
  box.appendChild(g0);

  const g1 = wbGroup(t("wbPermswbGroupT164"), t("wbPermswbGroupT165"));
  g1.appendChild(wbChips(t("wbPermswbChipsT166"), t("wbPermswbChipsT167"), p.allow || [], (v) => wbSave("agent", { permissions: Object.assign({}, p, { allow: v }) }), t("wbPermswbChipsT126"), t("wbPermswbChipsT127")));
  g1.appendChild(wbChips(t("wbPermswbChipsT168"), t("wbPermswbChipsT169"), p.deny || [], (v) => wbSave("agent", { permissions: Object.assign({}, p, { deny: v }) }), t("wbPermswbChipsT128"), t("wbPermswbChipsT129")));
  box.appendChild(g1);

  const hooks = (c.agent && c.agent.hooks && c.agent.hooks.pre) || [];
  const g2 = wbGroup(t("wbPermswbGroupT170"), t("wbPermswbGroupT171"));
  const list = wbEl("div", "wb-list");
  const draw = (arr) => {
    list.innerHTML = "";
    if (!arr.length) list.appendChild(wbEl("div", "wb-list-empty", t("wbPermswbElT172")));
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
  add.placeholder = t("wbPermsplaceholderT173");
  const pat = wbEl("input", "wb-input wb-hook-add");
  pat.placeholder = t("wbPermsplaceholderT174");
  const rsn = wbEl("input", "wb-input wb-hook-add");
  rsn.placeholder = t("wbPermsplaceholderT175");
  const btn = wbEl("button", "wb-btn wb-btn-primary", t("wbWtAddRowwbElT107"));
  btn.type = "button";
  btn.onclick = () => {
    const h = { tool: add.value.trim() || "*", match: pat.value.trim(), action: "deny", reason: rsn.value.trim() };
    if (!h.match) return wbSaved(t("wbPermswbSavedT90"), true);
    const n = hooks.concat([h]);
    add.value = pat.value = rsn.value = "";
    draw(n);
    wbSave("agent", { hooks: { pre: n } });
  };
  const form = wbEl("div", "wb-hook-form");
  form.appendChild(add); form.appendChild(pat); form.appendChild(rsn); form.appendChild(btn);
  g2.appendChild(form);
  box.appendChild(g2);

  const g3 = wbGroup(t("wbPermswbGroupT176"), t("wbPermswbGroupT177"));
  g3.appendChild(wbNote(t("wbPermswbNoteT178")));
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
  const g0 = wbGroup(t("wbMcpwbGroupT179"), t("wbMcpwbGroupT180"));
  const list = wbEl("div", "wb-list");
  if (!servers.length) list.appendChild(wbEl("div", "wb-list-empty", t("wbMcpwbElT181")));
  servers.forEach((s, i) => {
    const st = statusOf(s.name) || {};
    const it = wbEl("div", "wb-list-item");
    it.appendChild(wbEl("span", "wb-badge " + (st.status === "connected" ? "wb-badge-ok" : st.status === "error" ? "wb-badge-err" : "wb-badge-dim"),
      st.status === "connected" ? "已连接" : st.status === "error" ? "异常" : "未连接"));
    it.appendChild(wbEl("b", "", esc(s.name)));
    it.appendChild(wbEl("code", "", esc(s.command + " " + (s.args || []).join(" "))));
    if (s.enabled === false) it.appendChild(wbEl("span", "wb-list-sub", t("wbMcpwbElT182")));
    const tools = st.tools ? st.tools.length : 0;
    it.appendChild(wbEl("span", "wb-list-sub", tools ? tools + t("wbMcpwbElT130") : ""));
    const del = wbEl("button", "wb-icon-btn", t("delete"));
    del.type = "button";
    del.onclick = () => { const n = servers.slice(); n.splice(i, 1); save(n); };
    it.appendChild(del);
    list.appendChild(it);
  });
  g0.appendChild(list);
  const form = wbEl("div", "wb-mcp-form");
  const n = wbEl("input", "wb-input"); n.placeholder = t("wbMcpwbElT184");
  const cmd = wbEl("input", "wb-input"); cmd.placeholder = t("wbMcpwbElT185");
  const args = wbEl("input", "wb-input wb-input-wide"); args.placeholder = t("wbMcpwbElT186");
  const add = wbEl("button", "wb-btn wb-btn-primary", t("wbMcpwbElT187"));
  add.type = "button";
  add.onclick = () => {
    const name = n.value.trim().replace(/[^a-zA-Z0-9_]/g, "_");
    if (!name || !cmd.value.trim()) return wbSaved(t("wbMcpwbSavedT91"), true);
    save(servers.concat([{ name, command: cmd.value.trim(), args: args.value.trim() ? args.value.trim().split(/\s+/) : [], enabled: true }]));
  };
  form.appendChild(n); form.appendChild(cmd); form.appendChild(args); form.appendChild(add);
  g0.appendChild(form);
  g0.appendChild(wbAction(t("wbMcpwbActionT188"), t("wbMcpwbActionT189"), t("wbMcpwbActionT190"), async () => {
    const r = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reconnect" }) }).then((x) => x.json());
    wbSaved(r.ok ? t("wbMcpwbSavedT92") : t("wowbRenderMcpC6") + (r.error || ""), !r.ok);
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
  const g0 = wbGroup(t("wbDatawbGroupT191"), t("wbDatawbGroupT192"));
  g0.appendChild(wbAction(t("wbDatawbActionT193"), t("wbDatawbActionT194"), t("exportChat"), async () => {
    const r = await fetch("/api/config/export").then((x) => x.json());
    if (!r.ok) return wbSaved(r.error || t("wbDatawbSavedT93"), true);
    const blob = new Blob([r.json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = r.filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    wbSaved(t("wbDatawbSavedT94") + r.filename);
  }, null, "export config 导出"));
  g0.appendChild(wbAction(t("wbDatawbActionT195"), t("wbDatawbActionT196"), t("wbDatawbActionT197"), () => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = ".json,application/json";
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      const text = await f.text();
      const r = await fetch("/api/config/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json: text }) }).then((x) => x.json());
      if (!r.ok) return wbSaved(r.error || t("importFail"), true);
      wbSaved(t("wbDatawbSavedT95") + (r.applied || []).join(" / ") + ((r.skipped || []).length ? t("wowbRenderDataC48") + r.skipped.length + t("wowbRenderDataC49") : ""));
      await wbLoadConfig();
      openWorkbench(WB.section);
    };
    inp.click();
  }, null, "import config 导入"));
  box.appendChild(g0);

  const g1 = wbGroup(t("wbDatawbGroupT198"), t("wbDatawbGroupT199"));
  g1.appendChild(wbKV(t("wbDatawbKVT200"), (c.paths && c.paths.root) || "—", true));
  g1.appendChild(wbKV(t("wbDatawbKVT201"), (c.paths && c.paths.configFile) || "—", true));
  g1.appendChild(wbKV(t("wbDatawbKVT202"), t("wbDatawbKVT131"), true));
  g1.appendChild(wbAction(t("wbDatawbActionT203"), t("wbDatawbActionT204"), t("open"), () => toast(t("wbDatawbActionT132") + ((c.paths && c.paths.root) || "")), null, t("wbDatawbActionT133")));
  box.appendChild(g1);

  const g2 = wbGroup(t("wbDatawbGroupT205"), t("wbDatawbGroupT206"));
  g2.appendChild(wbAction(t("wbDatawbActionT207"), t("wbDatawbActionT208"), t("viewDetail"), () => openWorkbench("audit"), null, t("wbDatawbActionT134")));
  box.appendChild(g2);
}

/* ============================================================
   分区：关于
   ============================================================ */
function wbRenderAbout(box) {
  const c = WB.cfg || {};
  const g0 = wbGroup("pancode", t("wbAboutwbGroupT209"));
  g0.appendChild(wbKV(t("wbAboutwbKVT210"), c.version || "—"));
  g0.appendChild(wbKV(t("engineLabel"), (c.engine && c.engine.mode) === "llm" ? t("wbAboutwbKVT135") + c.engine.model : t("engineDemo")));
  g0.appendChild(wbKV(t("wbAboutwbKVT211"), ((c.features || []).join(" · ")) || "—"));
  box.appendChild(g0);
  /* GitHub：星数读公开 API（读不到就说读不到），点星与点链接都只是打开系统浏览器；
     应用里不落任何令牌，也不假装"已点亮"。 */
  const gh = (typeof window.GH !== "undefined" && window.GH) || null;
  if (gh) {
    const gH = wbGroup(t("aboutRepo"));
    const row = wbRow("GitHub", "pyf2818/pancode", "github star issue feedback 仓库 问题 反馈");
    const star = wbEl("span", "wb-star");
    star.innerHTML = ico("star") + '<span class="wb-star-n"></span>';
    star.title = t("gmStarsTip");
    star.onclick = () => window.open(gh.home, "_blank", "noopener");
    row.ctrl.appendChild(star);
    const setStar = () => { const n = row.querySelector(".wb-star-n"); if (n && typeof window.gmStarText === "function") n.textContent = window.gmStarText(); };
    setStar();
    document.addEventListener("pancode:gh-stars", setStar, { once: true });
    if (typeof window.gmFetchStars === "function") window.gmFetchStars();
    [[t("gmRepoHome"), gh.home], [t("gmIssues"), gh.issues]].forEach(([label, url]) => {
      const b = wbEl("button", "wb-btn", esc(label));
      b.type = "button";
      b.onclick = () => window.open(url, "_blank", "noopener");
      row.ctrl.appendChild(b);
    });
    const fb = wbEl("button", "wb-btn wb-btn-primary", esc(t("gmFeedback")));
    fb.type = "button";
    fb.onclick = () => { if (typeof window.openFeedback === "function") window.openFeedback(); };
    row.ctrl.appendChild(fb);
    gH.appendChild(row);
    box.appendChild(gH);
  }
  /* 开发者：邮箱与微信号点击即复制（这两串是 ASCII，翻不翻都一样，名字才要翻） */
  const gD = wbGroup(t("aboutDev"));
  gD.appendChild(wbKV(t("aboutDev"), t("aboutDevName") + " · " + t("aboutDevRole")));
  [["aboutMail", "2818932783@qq.com"], ["aboutWechat", "anlan_0725"]].forEach(([k, v]) => {
    const r = wbRow(t(k), v, "email qq wechat 邮箱 微信 联系");
    const b = wbEl("button", "wb-btn", ico("copy") + " " + esc(t("aboutCopyTip")));
    b.type = "button";
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(v); if (typeof toast === "function") toast(t("aboutCopied", { v })); }
      catch (e) { if (typeof toast === "function") toast(v); }
    };
    r.ctrl.appendChild(b);
    gD.appendChild(r);
  });
  box.appendChild(gD);
  const g1 = wbGroup(t("wbAboutwbGroupT212"));
  const rows = [["Ctrl / ⌘ + K", t("scCmdk")], ["Ctrl / ⌘ + P", t("scFindFile")], ["Ctrl / ⌘ + `", t("scTerminal")], ["Ctrl / ⌘ + B", t("scSidebar")], ["Esc", t("scStopTask")]];
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
        '<div class="wb-title">' + ico("gear") + '<span data-i18n="wbWbBuildH39"></span></div>' +
        '<div class="wb-search-wrap">' + ico("search") + '<input id="wbSearch" data-i18n-ph="wbSearchPh" autocomplete="off"></div>' +
        '<span class="wb-saved" id="wbSaved"></span>' +
        '<button class="wb-close" id="wbClose" data-i18n-title="wbCloseTip">' + ico("close") + '</button>' +
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
  applyI18n();
}

/* 工作台整页是 JS 建的：切语言时重画导航与当前分区，
   否则导航栏、分区标题会停在开机那一刻的语言。 */
onLang(() => {
  if (!WB.root) return;
  wbRenderNav();
  if (WB.section) wbRenderBody();
});
function wbVisibleSections() {
  if (!WB.query) return WB_SECTIONS;
  const hit = (s) => (t(s.titleKey) + " " + (s.kw || "") + " " + (s.keywords || "")).toLowerCase().includes(WB.query);
  return WB_SECTIONS.filter(hit);
}
function wbRenderNav() {
  if (!WB.nav) return;
  const list = wbVisibleSections();
  WB.nav.innerHTML = "";
  WB_GROUPS.forEach((grp) => {
    const secs = list.filter((s) => s.group === grp.id);
    if (!secs.length) return;
    WB.nav.appendChild(wbEl("div", "wb-nav-group", esc(t(grp.labelKey))));
    secs.forEach((s) => {
      const it = wbEl("button", "wb-nav-item" + (s.id === WB.section ? " active" : ""),
        "<span class=\"wb-nav-ico\">" + ico(s.icon || "dot") + "</span><span>" + esc(t(s.titleKey)) + "</span>");
      it.type = "button";
      it.onclick = () => { WB.section = s.id; wbRenderNav(); wbRenderBody(); };
      WB.nav.appendChild(it);
    });
  });
  if (!list.length) WB.nav.appendChild(wbEl("div", "wb-nav-none", t("wbNavwbElT213")));
}
async function wbRenderBody() {
  const sec = WB_SECTIONS.find((s) => s.id === WB.section) || WB_SECTIONS[0];
  if (!sec) return;
  WB.section = sec.id;
  WB.body.innerHTML = "";
  const head = wbEl("div", "wb-body-head");
  head.appendChild(wbEl("h2", "", esc(t(sec.titleKey))));
  if (sec.descKey) head.appendChild(wbEl("p", "", esc(t(sec.descKey))));
  WB.body.appendChild(head);
  if (typeof API_STALE !== "undefined" && API_STALE) {
    WB.body.appendChild(wbEl("div", "wb-stale", t("wbStaleMsg")));
  }
  const holder = wbEl("div", "wb-body-inner");
  WB.body.appendChild(holder);
  if (!WB.cfg) await wbLoadConfig();
  try { await sec.render(holder, WB.query); }
  catch (e) { holder.appendChild(wbEl("div", "wb-note wb-note-err", t("wbLoadFail") + esc(e.message))); }
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
wbRegister({ id: "appearance", group: "prefs", titleKey: "wbCloseWorkbenchtitleT215", icon: "sun", descKey: "wbCloseWorkbenchdescT216", keywords: "theme palette color 主题 配色 字号", render: (b) => wbRenderAppearance(b) });
wbRegister({ id: "general", group: "prefs", titleKey: "scGroupGeneral", icon: "tune", descKey: "wbCloseWorkbenchdescT217", keywords: "language workspace folder editor 语言 工作区", render: (b) => wbRenderGeneral(b) });
wbRegister({ id: "model", group: "engine", titleKey: "modelChip", icon: "robot", descKey: "wbCloseWorkbenchdescT218", keywords: "llm model api key embedding 模型 密钥 索引", render: (b) => wbRenderModel(b) });
wbRegister({ id: "agent", group: "engine", titleKey: "wbCloseWorkbenchtitleT219", icon: "sparkle", descKey: "wbCloseWorkbenchdescT220", keywords: "agent mode rules memory context compact timeout settle decision 长任务 时限 超时 模式 上下文 压缩 记忆 结算 决策", render: (b) => wbRenderAgent(b) });
wbRegister({ id: "perms", group: "engine", titleKey: "wbCloseWorkbenchtitleT221", icon: "shield", descKey: "wbCloseWorkbenchdescT222", keywords: "permission deny allow hook yolo security roots 授权 目录 文件夹 权限 安全 审批 拦截", render: (b) => wbRenderPerms(b) });
wbRegister({ id: "mcp", group: "engine", titleKey: "wbCloseWorkbenchtitleT223", icon: "layers", descKey: "wbMcpwbGroupT179", keywords: "mcp server tool 外部工具", render: (b) => wbRenderMcp(b) });
wbRegister({ id: "data", group: "data", titleKey: "wbToplabelT4", icon: "folder", descKey: "wbCloseWorkbenchdescT224", keywords: "export import data privacy audit 导出 导入 数据 审计", render: (b) => wbRenderData(b) });
wbRegister({ id: "about", group: "data", titleKey: "wbCloseWorkbenchtitleT225", icon: "read", descKey: "wbCloseWorkbenchdescT226", keywords: "about version shortcut 关于 版本 快捷键", render: (b) => wbRenderAbout(b) });

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
  /* 齿轮不再直接进全屏工作台：先出小抽屉（js/gear-menu.js），「全部设置」再进这里。
     gear-menu 没加载成功时退回原行为，不要让设置入口变成死按钮。 */
  const gear = $("btnSettings");
  if (gear) gear.onclick = (e) => {
    e && e.preventDefault && e.preventDefault();
    if (typeof window.toggleGearMenu === "function") window.toggleGearMenu();
    else openWorkbench("model");
  };
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
