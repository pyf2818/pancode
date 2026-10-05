/* ============================================================
   pancode 工作流模板弹层 / 会话轮次提取 / 打开文件夹 / 欢迎语
   （设置界面与沉淀面板本身已并入 js/workbench.js + js/assets-center.js）
   依赖全局：state / models / editor / inputBox / chatStream / AUTH /
            toast / termLine / mdLite / ico / $（运行时解析）
   ============================================================ */
"use strict";




/* ---------------- 工作流模板（目标驱动 /goal 式） ----------------
   面板优先展示后端真实模板（/api/templates，含用户 save_template 存的自定义模板），
   点击后生成「设定目标 + 实例化模板 + 逐步执行」的提示词；
   下面的 WORKFLOWS 仅作为接口不可用时的本地兜底提示词。 */
const WORKFLOWS = [
  { icon: "error", name: "修复 Bug", tmpl: "请定位并修复以下 bug：<描述 bug 现象与复现步骤>。\n要求：先复现，再定位根因，修复后运行相关测试验证，最后总结根因与改动。" },
  { icon: "plus", name: "实现新功能", tmpl: "请实现以下功能：<功能描述与目标>。\n要求：先列出计划（涉及的文件 / 接口 / 数据结构），再编码实现，最后自测并说明如何验证。" },
  { icon: "split", name: "重构模块", tmpl: "请重构 <模块 / 文件>：保持对外行为不变，提升可读性 / 性能 / 结构。\n要求：改前先跑测试建立基线，改后跑测试确认无回归，给出前后对比。" },
  { icon: "md", name: "补充文档", tmpl: "请为 <模块 / 目录> 编写或更新文档与关键注释，覆盖设计决策、使用方式、注意事项。" },
  { icon: "check", name: "跑测试 / CI", tmpl: "请运行项目的测试 / 构建 / lint，并修复所有失败项，直到全部通过；每一步说明做了什么。" },
  { icon: "eye", name: "代码审查", tmpl: "请审查 <范围 / 文件 / PR> 的代码质量、潜在 bug、安全风险与可维护性，给出按优先级排序的问题清单与改进建议。" },
];
/* 后端真实模板的展示映射：name → 图标 / 中文标签 */
const WF_ICONS = { ship: "sparkle", review: "eye", feature: "plus", bugfix: "error", refactor: "split", test: "check", docs: "md" };
const WF_LABELS = { ship: "一键全流程交付", review: "代码审查", feature: "实现新功能", bugfix: "修复 Bug", refactor: "重构模块", test: "补充测试", docs: "补充文档" };
const WF_GOAL_PH = "<在此描述你的目标>";

/* 真实模板 → 目标驱动提示词：Agent 会用 set_goal + 模板生成计划并执行到交付 */
function wfTemplatePrompt(t) {
  return "目标：" + WF_GOAL_PH + "\n\n请用工作流模板「" + t.name + "」设定会话目标并生成执行计划（共 " + t.steps +
    " 步），然后按计划逐步执行，每完成一步更新任务状态，直到全部交付完成。";
}

/* 填入输入框并选中占位符，方便直接覆盖输入 */
function wfFill(text) {
  const ta = inputBox.querySelector("#chatInput");
  if (ta) {
    ta.value = text;
    ta.focus();
    const i = text.indexOf("<");
    if (i >= 0) { const j = text.indexOf(">", i); if (j > i) ta.setSelectionRange(i, j + 1); }
  }
  $("wfPop").style.display = "none";
}

function wfItemEl(icon, name, sub, badge, onPick, hi) {
  const it = document.createElement("div");
  it.className = "wf-item" + (hi ? " wf-hi" : "");
  it.innerHTML = '<span class="wf-ic">' + ico(icon) + '</span><div class="wf-meta"><div class="wf-name">' + esc(name) +
    (badge ? '<span class="wf-badge">' + esc(badge) + "</span>" : "") + '</div><div class="wf-sub">' + esc(sub) + "</div></div>";
  it.onclick = onPick;
  return it;
}
function wfGroupEl(label) {
  const g = document.createElement("div");
  g.className = "wf-group";
  g.textContent = label;
  return g;
}

/* 兜底：引擎未就绪 / 接口不可用时，退回本地提示词模板，保证面板始终可用 */
function renderWorkflowsFallback(box) {
  box.appendChild(wfGroupEl("快捷提示词"));
  WORKFLOWS.forEach((w) => {
    box.appendChild(wfItemEl(w.icon, w.name, w.tmpl.split("\n")[0].slice(0, 30), "", () => wfFill(w.tmpl), false));
  });
}

/* 渲染真实模板（内置 + 用户自定义），ship 置顶作为一站式交付入口 */
async function renderWorkflows() {
  const box = $("wfList");
  box.innerHTML = '<div class="wf-group">加载模板…</div>';
  let templates = [];
  try {
    const r = await fetch("/api/templates");
    const d = await r.json();
    templates = (d && d.templates) || [];
  } catch (e) { templates = []; }

  box.innerHTML = "";
  if (!templates.length) { renderWorkflowsFallback(box); return; }

  const addTpl = (t, hi) => box.appendChild(wfItemEl(
    WF_ICONS[t.name] || "toolbox",
    WF_LABELS[t.name] || t.name,
    t.description || (t.steps + " 步流程"),
    t.steps + " 步",
    () => wfFill(wfTemplatePrompt(t)),
    hi
  ));

  const ship = templates.find((t) => t.name === "ship" && t.builtin);
  if (ship) { box.appendChild(wfGroupEl("一站式交付")); addTpl(ship, true); }

  const rest = templates.filter((t) => t.builtin && t.name !== "ship");
  if (rest.length) { box.appendChild(wfGroupEl("流程模板")); rest.forEach((t) => addTpl(t, false)); }

  const custom = templates.filter((t) => !t.builtin);
  if (custom.length) { box.appendChild(wfGroupEl("我的模板")); custom.forEach((t) => addTpl(t, false)); }
}
/* 打开 / 切换工作流面板（顶栏按钮与命令面板共用） */
function openWorkflowPop(toggle) {
  const pop = $("wfPop");
  const show = toggle ? pop.style.display !== "block" : true;
  pop.style.display = show ? "block" : "none";
  if (show) renderWorkflows();
}
$("btnWorkflow").onclick = (e) => { e.stopPropagation(); openWorkflowPop(true); };
$("wfPop").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", (e) => {
  const pop = $("wfPop");
  if (pop.style.display === "block" && !pop.contains(e.target) && e.target !== $("btnWorkflow")) pop.style.display = "none";
});

/* 从当前对话 DOM 取纯文本轮次，供服务端蒸馏 */
function collectConvTurns() {
  const pane = document.querySelector("#chatSlotAgents .conv-pane.active, #chatSlotAgents .conv-pane, .chat-stream");
  const out = [];
  if (!pane) return out;
  pane.querySelectorAll(".msg-user, .msg-ai").forEach((n) => {
    const txt = (n.innerText || n.textContent || "").trim();
    if (txt) out.push({ role: n.classList.contains("msg-user") ? "user" : "assistant", content: txt.slice(0, 1200) });
  });
  return out.slice(-40);
}

/* ---------------- 打开文件夹（任意本地目录 → 工作区 / 交给调用方） ---------------- */
const fm = { dir: "", onPick: null };

/* 同一份目录浏览器要有两种动词：默认是"把它换成工作区"，
   但「授权目录」只是想挑一个目录交给调用方，绝不是换工作区。
   文案必须跟着变——否则用户点下「打开此文件夹」会以为自己的工作区被切走了。 */
const FM_TITLE_DEFAULT = "打开文件夹 — 任意本地目录都可以成为工作区";
function fmOpenPicker(opts) {
  opts = opts || {};
  fm.onPick = typeof opts.onPick === "function" ? opts.onPick : null;
  const head = document.querySelector("#folderModal .set-head > span");
  if (head) head.innerHTML = ico("folder") + " " + esc(opts.title || FM_TITLE_DEFAULT);
  const btn = $("fmOpen");
  if (btn) btn.textContent = opts.btnText || "打开此文件夹";
  $("folderModal").style.display = "flex";
  $("fmStatus").className = "set-status";
  $("fmStatus").textContent = "";
  fmRenderRecent();
  fmBrowse(fm.dir || "");
}

/* 浏览器的两份响应可能乱序回来（连点两次"转到"），而回来那一刻用户往往已经在输入框里打下一段路径了。
   旧写法无条件把响应写进 #fmPath：等于**把人家正在打的字抹掉**，主按钮还被退回"未选目录"而禁用。 */
let fmSeq = 0;
async function fmBrowse(dir) {
  const seq = ++fmSeq;
  const r = await fetch("/api/fs/browse?dir=" + encodeURIComponent(dir || "")).then((x) => x.json());
  if (seq !== fmSeq) return;                       // 更晚的那次已经有结果了，这份过期
  fm.dir = r.dir || "";
  fm.parent = r.parent;
  fm.home = r.home;
  const inp = $("fmPath");
  if (document.activeElement !== inp || !String(inp.value).trim()) inp.value = fm.dir;
  $("fmCurrent").textContent = fm.dir ? "当前选择: " + fm.dir : "请选择一个文件夹";
  $("fmOpen").disabled = !fm.dir;
  const list = $("fmList");
  list.innerHTML = "";
  if (!r.dirs || !r.dirs.length) {
    list.innerHTML = '<div class="scm-empty">此目录下没有子文件夹（可以直接点「打开此文件夹」）</div>';
    return;
  }
  r.dirs.forEach((d) => {
    const el = document.createElement("div");
    el.className = "fm-item" + (d.hidden ? " fm-hidden" : "");
    el.innerHTML = ico("folder") + "<span>" + esc(d.name) + "</span>";
    el.onclick = () => fmBrowse(d.path);
    el.ondblclick = () => { fm.dir = d.path; fmOpenFolder(); };
    list.appendChild(el);
  });
}

async function fmRenderRecent() {
  try {
    const r = await fetch("/api/workspace").then((x) => x.json());
    const box = $("fmRecent");
    box.innerHTML = "";
    if (!r.recent || !r.recent.length) return;
    const title = document.createElement("div");
    title.className = "fm-recent-title";
    title.textContent = "最近打开";
    box.appendChild(title);
    r.recent.slice(0, 5).forEach((p) => {
      const el = document.createElement("div");
      el.className = "fm-recent-item";
      el.innerHTML = ico("folder") + "<span>" + esc(p) + "</span>";
      el.onclick = () => { fm.dir = p; fmOpenFolder(); };
      box.appendChild(el);
    });
  } catch (e) {}
}

async function fmOpenFolder() {
  const st = $("fmStatus");
  if (fm.onPick) {
    const dir = fm.dir;
    if (!dir) return;
    try {
      const keepOpen = await fm.onPick(dir);
      if (keepOpen !== false) $("folderModal").style.display = "none";
    } catch (e) {
      st.className = "set-status err"; st.textContent = "选择失败: " + e.message;
    }
    return;
  }
  st.className = "set-status"; st.textContent = "正在切换工作区…";
  try {
    const r = await fetch("/api/workspace", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: fm.dir }),
    }).then((x) => x.json());
    if (r.ok) {
      st.className = "set-status ok"; st.textContent = "已打开: " + r.workspace;
      // 清空本地编辑状态，等 hello 广播重建
      state.openTabs = []; state.activeFile = null; state.dirty.clear();
      for (const p in models) { models[p].dispose(); delete models[p]; }
      if (state.monacoReady && editor) editor.setModel(null);
      setTimeout(() => ($("folderModal").style.display = "none"), 500);
      termLine('<span class="tl-info">[pancode] 工作区已切换 → ' + esc(r.workspace) + "</span>");
    } else { st.className = "set-status err"; st.textContent = "打开失败: " + r.error; }
  } catch (e) { st.className = "set-status err"; st.textContent = "请求异常: " + e.message; }
}

$("btnOpenFolder").onclick = async (e) => {
  // 下拉快速切换：先列出最近项目，点击直接切换；选「浏览其他…」打开文件夹弹窗
  let menu = document.getElementById("wsDropdown");
  if (menu) { menu.remove(); return; }
  let recents = [];
  try { const r = await (await fetch("/api/workspace")).json(); recents = r.recent || []; } catch (err) {}
  menu = document.createElement("div");
  menu.id = "wsDropdown";
  menu.className = "ws-dropdown";
  const cur = (typeof state !== "undefined" && state.workspace) || "";
  menu.innerHTML = recents.map((p) =>
    '<div class="ws-item' + (p === cur ? " active" : "") + '" data-dir="' + p.replace(/"/g, "&quot;") + '">' +
      '<i data-ico="folder"></i><span>' + p.replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</span>' +
      (p === cur ? '<i data-ico="check"></i>' : "") + '</div>'
  ).join("") +
    '<div class="ws-item ws-more"><i data-ico="folderOpen"></i><span>浏览其他文件夹…</span></div>';
  const btn = $("btnOpenFolder");
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + "px";
  menu.style.left = r.left + "px";
  if (typeof replaceIcons === "function") replaceIcons();
  menu.querySelectorAll(".ws-item").forEach((item) => {
    item.onclick = async () => {
      menu.remove();
      if (item.classList.contains("ws-more")) { fmOpenPicker(); return; }
      const dir = item.dataset.dir;
      if (!dir || dir === cur) return;
      try {
        const res = await (await fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir }) })).json();
        if (!res.ok) toast(res.error || "切换失败");
      } catch (err) { toast("切换失败: " + err.message); }
    };
  });
  // 点外部关闭
  setTimeout(() => {
    const close = (ev) => { if (!menu.contains(ev.target) && ev.target !== btn) { menu.remove(); document.removeEventListener("click", close); } };
    document.addEventListener("click", close);
  }, 0);
};
$("fmClose").onclick = () => { $("folderModal").style.display = "none"; fm.onPick = null; };
// 文件夹弹窗只点 X 关闭
$("fmUp").onclick = () => fmBrowse(fm.parent === "" ? "" : (fm.parent || ""));
$("fmHome").onclick = () => fmBrowse(fm.home || "");
$("fmGo").onclick = () => fmBrowse($("fmPath").value.trim());
$("fmPath").addEventListener("keydown", (e) => { if (e.key === "Enter") fmBrowse($("fmPath").value.trim()); });
$("fmOpen").onclick = fmOpenFolder;

/* ---------------- 欢迎信息 ---------------- */
function welcome() {
  const isLlm = state.engine && state.engine.mode === "llm";
  const el = document.createElement("div");
  el.className = "msg msg-ai";
  el.innerHTML = mdLite(
    "你好，我是 **pancode Agent**。\n\n" +
    (isLlm
      ? "当前引擎：**" + state.engine.model + "**（真实 LLM）。直接描述任何编程任务，我会自主读代码、编辑文件、跑终端验证，直到完成。\n\n"
      : "当前为**内置演示引擎**（无需 API Key 即可体验完整闭环）。点击右上角「模型设置」接入任意 OpenAI 兼容 API 后，我就能处理你的**任意真实编程任务**。\n\n") +
    "**这个工作台是真实的：**\n- 编辑器可直接改代码，`Ctrl+S` 真实保存到磁盘\n- 文件树支持新建 / 重命名 / 删除（右键菜单）\n- 终端真实执行，`Ctrl+C` 可中断\n- 改动基于 Git/快照基线计算，随时可一键还原\n\n" +
    "随时在顶部切换 **Editor / Agents** 双窗口，状态完全同步。\n- 快捷键 `Ctrl/Cmd + .` 在「编辑器 / Agents」窗口间快速切换\n- 聊天输入框按 `↑ / ↓` 可浏览并回填当前对话已发的消息\n- 鼠标悬停消息气泡可一键复制内容");
  (typeof chatPane === "function" ? chatPane() : chatStream).appendChild(el);
}
