/* ============================================================
   pancode 设置 / Agent 设置 / 工作流 / 会话沉淀 / 打开文件夹 / 欢迎
   依赖全局：state / models / editor / inputBox / chatStream / AUTH /
            toast / termLine / mdLite / ico / applyAgentSettings / $（运行时解析）
   ============================================================ */
"use strict";

/* ---------------- 设置面板 ---------------- */
function getModelPresets() { try { return JSON.parse(localStorage.getItem("cw-model-presets")) || []; } catch (e) { return []; } }
function saveModelPresets(presets) { localStorage.setItem("cw-model-presets", JSON.stringify(presets)); }

function renderModelPresets() {
  const presets = getModelPresets();
  const box = $("modelPresets");
  const list = $("modelPresetList");
  list.innerHTML = "";
  const currentURL = $("setBaseURL").value.trim();
  const currentModel = $("setModel").value.trim();
  if (presets.length) {
    presets.forEach((p, i) => {
      const el = document.createElement("div");
      el.className = "model-preset" + (p.baseURL === currentURL && p.model === currentModel ? " active" : "");
      el.innerHTML = '<span style="color:var(--blue)">●</span><span class="model-preset-name">' + esc(p.name) + '</span><span class="model-preset-model">' + esc(p.model) + '</span><span class="model-preset-del" data-i="' + i + '">✕</span>';
      el.onclick = (e) => {
        if (e.target.closest(".model-preset-del")) return;
        $("setBaseURL").value = p.baseURL;
        $("setModel").value = p.model;
        $("setApiKey").placeholder = p.hasKey ? "已保存（留空不修改）" : "sk-…";
        renderModelPresets();
      };
      el.querySelector(".model-preset-del").onclick = (e) => {
        e.stopPropagation();
        presets.splice(i, 1);
        saveModelPresets(presets);
        renderModelPresets();
      };
      list.appendChild(el);
    });
  } else {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:11px;color:var(--text-dim);padding:4px 0";
    empty.textContent = "暂无预设，填写下方配置后点击「保存为预设」";
    list.appendChild(empty);
  }
  // 保存当前配置为预设按钮
  const add = document.createElement("div");
  add.className = "model-preset-add";
  add.textContent = "+ 保存当前配置为预设";
  add.onclick = () => {
    const name = prompt("为这个配置命名：", $("setModel").value.trim() || "我的模型");
    if (!name) return;
    presets.push({ name, baseURL: $("setBaseURL").value.trim(), model: $("setModel").value.trim(), hasKey: !!$("setApiKey").value.trim() || !!($("setApiKey").placeholder.includes("已保存")) });
    saveModelPresets(presets);
    renderModelPresets();
  };
  list.appendChild(add);
}

async function openSettings() {
  const modal = $("settingsModal");
  modal.style.display = "flex";
  $("setStatus").textContent = "";
  try {
    const r = await fetch("/api/settings").then((x) => x.json());
    $("setBaseURL").value = r.baseURL || "";
    $("setModel").value = r.mode === "llm" ? r.model : ($("setModel").value || "");
    $("setApiKey").placeholder = r.hasKey ? "已保存 " + r.keyTail + "（留空表示不修改）" : "sk-…";
    $("setApiKey").value = "";
    renderModelPresets();
  } catch (e) {}
}
$("btnSettings").onclick = openSettings;
$("setClose").onclick = () => ($("settingsModal").style.display = "none");
// 弹窗只点 X 关闭，点击外部不关闭

$("setTest").onclick = async () => {
  const st = $("setStatus");
  st.className = "set-status"; st.textContent = "测试中…";
  try {
    const r = await fetch("/api/settings/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseURL: $("setBaseURL").value.trim(), apiKey: $("setApiKey").value.trim(), model: $("setModel").value.trim() }),
    }).then((x) => x.json());
    if (r.ok) { st.className = "set-status ok"; st.textContent = "连接成功，模型响应: " + (r.sample || "ok"); }
    else { st.className = "set-status err"; st.textContent = "连接失败: " + r.error; }
  } catch (e) { st.className = "set-status err"; st.textContent = "请求异常: " + e.message; }
};

// 拉取模型列表功能
$("setFetchModels").onclick = async () => {
  const st = $("setStatus");
  const baseURL = $("setBaseURL").value.trim();
  if (!baseURL) {
    st.className = "set-status err";
    st.textContent = "请先填写 Base URL";
    return;
  }

  st.className = "set-status";
  st.textContent = "正在拉取模型列表…";

  try {
    // 通过服务端代理请求，避免浏览器 CORS 拦截
    const apiKey = $("setApiKey").value.trim();
    let proxyURL = "/api/models?baseURL=" + encodeURIComponent(baseURL);
    if (apiKey) proxyURL += "&apiKey=" + encodeURIComponent(apiKey);

    const response = await fetch(proxyURL);
    const data = await response.json();

    if (data.data && Array.isArray(data.data)) {
      // 成功获取模型列表
      const models = data.data.map(m => m.id || m.name).filter(Boolean);
      if (models.length > 0) {
        // 创建模型选择下拉框
        let selectHTML = '<select id="modelSelect" style="margin-top:8px;width:100%;padding:6px;border-radius:4px;border:1px solid var(--border);background:var(--bg);color:var(--text)">';
        models.forEach(model => {
          selectHTML += `<option value="${model}">${model}</option>`;
        });
        selectHTML += '</select>';

        // 在模型名输入框后面添加下拉框
        const modelInput = $("setModel");
        const container = modelInput.parentNode;
        const existingSelect = document.getElementById('modelSelect');
        if (existingSelect) existingSelect.remove();
        container.insertAdjacentHTML('beforeend', selectHTML);

        // 当选择模型时，更新输入框
        document.getElementById('modelSelect').onchange = (e) => {
          $("setModel").value = e.target.value;
        };

        st.className = "set-status ok";
        st.textContent = `成功拉取 ${models.length} 个模型，请选择或手动输入`;
      } else {
        st.className = "set-status err";
        st.textContent = "未找到可用模型";
      }
    } else if (data.error) {
      st.className = "set-status err";
      st.textContent = "拉取失败: " + (data.error.message || data.error);
    } else {
      st.className = "set-status err";
      st.textContent = "返回格式不正确";
    }
  } catch (e) {
    st.className = "set-status err";
    st.textContent = "请求异常: " + e.message;
  }
};

$("setSave").onclick = async () => {
  const st = $("setStatus");
  const body = { baseURL: $("setBaseURL").value.trim(), model: $("setModel").value.trim() };
  const key = $("setApiKey").value.trim();
  if (key) body.apiKey = key;
  try {
    const r = await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.ok) {
      st.className = "set-status ok";
      st.textContent = r.engine.mode === "llm" ? "已切换到真实 LLM 引擎: " + r.engine.model : "已保存（缺少 Key 或 URL，当前为演示引擎）";
      setTimeout(() => ($("settingsModal").style.display = "none"), 900);
    } else { st.className = "set-status err"; st.textContent = "保存失败: " + r.error; }
  } catch (e) { st.className = "set-status err"; st.textContent = "请求异常: " + e.message; }
};

/* ---------------- Agent 设置面板（权限 / 人格 / 规则 / 上下文 / 记忆） ---------------- */
async function openAgentSettings() {
  const modal = $("agentModal");
  modal.style.display = "flex";
  $("agmStatus").textContent = "";
  try {
    const a = await fetch("/api/agent-settings").then((x) => x.json());
    state.agent = a;
    $("agmMode").value = (a.permissions && a.permissions.mode) || "ask";
    $("agmAllow").value = ((a.permissions && a.permissions.allow) || []).join("\n");
    $("agmDeny").value = ((a.permissions && a.permissions.deny) || []).join("\n");
    $("agmPersona").value = (a.persona && a.persona.active) || "default";
    $("agmPrompt").value = (a.persona && a.persona.systemPrompt) || "";
    $("agmRules").checked = !(a.rules && a.rules.enabled === false);
    $("agmMemory").checked = !(a.memory && a.memory.enabled === false);
    $("agmCompact").checked = !(a.context && a.context.autoCompact === false);
    $("agmBudget").value = (a.context && a.context.budgetTokens) || 120000;
    agmSyncPromptVis();
  } catch (e) { $("agmStatus").className = "set-status err"; $("agmStatus").textContent = "读取设置失败: " + e.message; }
}
function agmSyncPromptVis() {
  $("agmPromptRow").style.display = $("agmPersona").value === "custom" ? "block" : "none";
}
$("btnAgentSettings").onclick = openAgentSettings;
$("agmClose").onclick = () => ($("agentModal").style.display = "none");
// Agent 设置弹窗只点 X 关闭
$("agmPersona").addEventListener("change", agmSyncPromptVis);

$("agmSave").onclick = async () => {
  const st = $("agmStatus");
  const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
  const body = {
    permissions: { mode: $("agmMode").value, allow: lines($("agmAllow").value), deny: lines($("agmDeny").value) },
    persona: { active: $("agmPersona").value, systemPrompt: $("agmPrompt").value.trim() },
    rules: { enabled: $("agmRules").checked },
    memory: { enabled: $("agmMemory").checked },
    context: { budgetTokens: parseInt($("agmBudget").value, 10) || 120000, autoCompact: $("agmCompact").checked },
  };
  try {
    const r = await fetch("/api/agent-settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.ok) {
      st.className = "set-status ok"; st.textContent = "已保存，对下一条消息立即生效";
      applyAgentSettings(r.agent);
      setTimeout(() => ($("agentModal").style.display = "none"), 800);
    } else { st.className = "set-status err"; st.textContent = "保存失败: " + r.error; }
  } catch (e) { st.className = "set-status err"; st.textContent = "请求异常: " + e.message; }
};

/* ---------------- 工作流模板（目标驱动 /goal 式） ---------------- */
const WORKFLOWS = [
  { icon: "error", name: "修复 Bug", tmpl: "请定位并修复以下 bug：<描述 bug 现象与复现步骤>。\n要求：先复现，再定位根因，修复后运行相关测试验证，最后总结根因与改动。" },
  { icon: "plus", name: "实现新功能", tmpl: "请实现以下功能：<功能描述与目标>。\n要求：先列出计划（涉及的文件 / 接口 / 数据结构），再编码实现，最后自测并说明如何验证。" },
  { icon: "split", name: "重构模块", tmpl: "请重构 <模块 / 文件>：保持对外行为不变，提升可读性 / 性能 / 结构。\n要求：改前先跑测试建立基线，改后跑测试确认无回归，给出前后对比。" },
  { icon: "md", name: "补充文档", tmpl: "请为 <模块 / 目录> 编写或更新文档与关键注释，覆盖设计决策、使用方式、注意事项。" },
  { icon: "check", name: "跑测试 / CI", tmpl: "请运行项目的测试 / 构建 / lint，并修复所有失败项，直到全部通过；每一步说明做了什么。" },
  { icon: "eye", name: "代码审查", tmpl: "请审查 <范围 / 文件 / PR> 的代码质量、潜在 bug、安全风险与可维护性，给出按优先级排序的问题清单与改进建议。" },
];
function renderWorkflows() {
  const box = $("wfList");
  box.innerHTML = "";
  WORKFLOWS.forEach((w) => {
    const it = document.createElement("div");
    it.className = "wf-item";
    it.innerHTML = '<span class="wf-ic">' + ico(w.icon) + '</span><div class="wf-meta"><div class="wf-name">' + w.name + '</div><div class="wf-sub">' + esc(w.tmpl.split("\n")[0].slice(0, 30)) + "</div></div>";
    it.onclick = () => {
      const ta = inputBox.querySelector("#chatInput");
      if (ta) { ta.value = w.tmpl; ta.focus(); }
      $("wfPop").style.display = "none";
    };
    box.appendChild(it);
  });
}
$("btnWorkflow").onclick = (e) => {
  e.stopPropagation();
  const pop = $("wfPop");
  const show = pop.style.display !== "block";
  pop.style.display = show ? "block" : "none";
  if (show) renderWorkflows();
};
$("wfPop").addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", (e) => {
  const pop = $("wfPop");
  if (pop.style.display === "block" && !pop.contains(e.target) && e.target !== $("btnWorkflow")) pop.style.display = "none";
});

/* ---------------- 会话沉淀（自我进化 P2：把决策 / 约定固化为长期资产） ---------------- */
async function openSediment() {
  const modal = $("sedimentModal");
  modal.style.display = "flex";
  $("sedStatus").textContent = "";
  $("sedTitle").value = "";
  $("sedContent").value = "";
  const rb = document.querySelector('input[name="sedTarget"][value="rule"]');
  if (rb) rb.checked = true;
  const prev = $("sedPreview");
  prev.textContent = "（加载中…）";
  try {
    const r = await fetch("/api/sediment").then((x) => x.json());
    let out = "";
    if (r.rules && r.rules.length) out += "【项目规则 user-rules.md】\n" + r.rules.map((x) => x.content).join("\n---\n").slice(0, 2500) + "\n\n";
    else out += "（暂无项目规则）\n\n";
    out += "【项目记忆】\n" + (r.memory || "（暂无项目记忆）");
    prev.textContent = out;
  } catch (e) { prev.textContent = "加载失败: " + e.message; }
}
$("btnSediment").onclick = openSediment;
$("sedClose").onclick = () => ($("sedimentModal").style.display = "none");
// 沉淀弹窗只点 X 关闭
$("sedSave").onclick = async () => {
  const st = $("sedStatus");
  const rb = document.querySelector('input[name="sedTarget"]:checked');
  const target = rb ? rb.value : "rule";
  const body = { target, title: $("sedTitle").value.trim(), content: $("sedContent").value.trim() };
  if (!body.content) { st.className = "set-status err"; st.textContent = "请先填写要沉淀的内容"; return; }
  try {
    const r = await fetch("/api/sediment", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((x) => x.json());
    if (r.ok) {
      st.className = "set-status ok";
      st.textContent = target === "rule" ? "已沉淀为项目规则，下次对话起强制生效" : "已沉淀为项目记忆，下次对话起作为参考";
      $("sedContent").value = "";
      toast(target === "rule" ? "✅ 已沉淀为项目规则" : "✅ 已沉淀为项目记忆");
      setTimeout(() => ($("sedimentModal").style.display = "none"), 800);
    } else { st.className = "set-status err"; st.textContent = "沉淀失败: " + r.error; }
  } catch (e) { st.className = "set-status err"; st.textContent = "请求异常: " + e.message; }
};

/* ---------------- 打开文件夹（任意本地目录 → 工作区） ---------------- */
const fm = { dir: "" };

async function fmBrowse(dir) {
  const r = await fetch("/api/fs/browse?dir=" + encodeURIComponent(dir || "")).then((x) => x.json());
  fm.dir = r.dir || "";
  fm.parent = r.parent;
  fm.home = r.home;
  $("fmPath").value = fm.dir;
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

$("btnOpenFolder").onclick = () => {
  $("folderModal").style.display = "flex";
  $("fmStatus").textContent = "";
  fmRenderRecent();
  fmBrowse(fm.dir || "");
};
$("fmClose").onclick = () => ($("folderModal").style.display = "none");
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
  chatStream.appendChild(el);
}
