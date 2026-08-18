/* ============================================================
   pancode i18n - 中英文语言切换
   ============================================================ */
"use strict";

const LANGS = {
  zh: {
    // 标题栏
    modelSettings: "模型设置",
    agentSettings: "Agent 设置",
    workflow: "工作流",
    sediment: "沉淀",
    resetWorkspace: "还原工作区",
    aiIdle: "AI 空闲",
    notLoggedIn: "未登录",
    openFolder: "打开文件夹",
    // 活动栏
    explorer: "资源管理器",
    search: "搜索",
    searchPlaceholder: "在所有文件中搜索…",
    scm: "源代码管理",
    skills: "Skills",
    // 文件树
    newFile: "新建文件",
    newFolder: "新建文件夹",
    open: "打开",
    rename: "重命名",
    viewDiff: "查看 Diff",
    delete: "删除",
    newFileHere: "在此目录新建文件",
    deleteDir: "删除目录",
    deleteDirConfirm: "确定删除目录",
    deleteConfirm: "确定删除",
    renamePrompt: "重命名为（相对路径）：",
    newFilePrompt: "新建文件（相对路径）：",
    newFolderPrompt: "新建文件夹（相对路径）：",
    // 侧边栏
    changes: "更改",
    noChanges: "暂无更改。当 AI 修改代码后，改动会出现在这里。",
    taskPlan: "任务计划",
    planEmpty: "Agent 面对复杂任务时会自动创建计划，实时跟进进度。",
    skillMarket: "Skills 市场",
    builtinWorkflow: "内置工作流",
    userSkills: "用户创建",
    autoSediment: "自动沉淀",
    noSkills: "暂无可用 Skill",
    // 输入框
    inputPlaceholder: "向 AI 描述你的任务；支持 @file:路径 / @folder:路径 引用，可粘贴或拖入图片…",
    send: "发送",
    stop: "停止",
    skill: "Skill",
    enterToSend: "Enter 发送",
    permAsk: "权限：逐项确认",
    permSemi: "权限：半自动",
    permAuto: "权限：全自动",
    // 会话
    currentChat: "当前对话",
    ready: "已就绪",
    running: "运行中",
    newChat: "新建对话",
    exportChat: "导出",
    noHistory: "暂无历史对话",
    // 设置面板
    openaiCompat: "模型设置 - OpenAI 兼容 API",
    modelConfig: "模型配置（点击切换 / 保存当前为预设）",
    baseURL: "Base URL",
    apiKey: "API Key",
    modelName: "模型名",
    fetchModels: "拉取模型",
    testConn: "测试连接",
    save: "保存并切换引擎",
    savePreset: "+ 保存当前配置为预设",
    noPresets: "暂无预设，填写下方配置后点击「保存为预设」",
    // Skill 弹窗
    createSkill: "创建 Skill",
    skillName: "Skill 名称 *",
    description: "描述",
    category: "分类",
    trigger: "触发关键词（逗号分隔）",
    skillContent: "内容（Markdown）*",
    saveToMarket: "保存到市场",
    viewDetail: "查看",
    refToChat: "引用到对话",
    saveEdit: "保存修改",
    nameCantEmpty: "名称和内容不能为空",
    // 登录
    login: "登录",
    register: "注册新账号",
    username: "用户名",
    password: "密码",
    loginSuccess: "✅ 登录成功",
    registerSuccess: "✅ 注册成功",
    fillUserPass: "请填写用户名和密码",
    // Goal
    goal: "Goal",
    setGoal: "设定目标",
    goalPlaceholder: "描述你的目标，如：实现完整的用户登录注册功能，包括前后端、测试",
    startGoal: "启动 Goal",
    goalStarted: "Goal 已启动，Agent 将持续执行直到完成",
    // 终端
    terminal: "终端",
    terminalHint: "真实执行",
    changesPanel: "本次改动",
    noChangesAgent: "Agent 修改代码后，文件与 Diff 会显示在这里。",
    // 预览
    preview: "预览",
    autoRefresh: "编辑时实时刷新",
    // 弹窗
    close: "关闭",
    confirm: "确定",
    cancel: "取消",
    // 工具
    queued: "排队",
    agentAborted: "Agent 已中断",
    agentAbortedMsg: "已中断",
    newChatStarted: "已开始新对话，AI 上下文已清空（文件改动保留）",
    contextCompressed: "上下文已自动压缩",
    memoryConsolidated: "记忆已归纳压缩",
    skillCreated: "Skill 已创建",
    skillSaved: "Skill 已保存",
    skillDeleted: "已删除",
    skillRef: "已选中 Skill",
    importSuccess: "导入成功",
    importFail: "导入失败",
    jsonError: "JSON 格式错误",
    // 权限
    approve: "批准",
    reject: "拒绝",
    pending: "待确认",
    approved: "已批准",
    rejected: "已拒绝",
    highRisk: "高危",
    midRisk: "中危",
    lowRisk: "低危",
    opFailed: "操作失败",
    saved: "已保存",
    // 欢迎信息
    welcome: "你好，我是 pancode Agent。",
    welcomeLlm: "当前引擎",
    welcomeDemo: "当前为内置演示引擎",
    // 杂项
    files: "个文件",
    steps: "步",
    lines: "行",
    // 语义检索
    kwSearch: "关键词",
    semSearch: "语义",
    buildIndex: "构建索引",
    buildIndexing: "正在构建索引…",
    rebuildIndex: "重建索引",
    indexBuilt: "已构建",
    // 语言切换
    langToggle: "EN",
  },
  en: {
    modelSettings: "Model Settings",
    agentSettings: "Agent Settings",
    workflow: "Workflow",
    sediment: "Sediment",
    resetWorkspace: "Reset Workspace",
    aiIdle: "AI Idle",
    notLoggedIn: "Not logged in",
    openFolder: "Open Folder",
    explorer: "Explorer",
    search: "Search",
    searchPlaceholder: "Search in all files…",
    scm: "Source Control",
    skills: "Skills",
    newFile: "New File",
    newFolder: "New Folder",
    open: "Open",
    rename: "Rename",
    viewDiff: "View Diff",
    delete: "Delete",
    newFileHere: "New File Here",
    deleteDir: "Delete Directory",
    deleteDirConfirm: "Delete directory",
    deleteConfirm: "Delete",
    renamePrompt: "Rename to (relative path):",
    newFilePrompt: "New file (relative path):",
    newFolderPrompt: "New folder (relative path):",
    changes: "Changes",
    noChanges: "No changes. AI modifications will appear here.",
    taskPlan: "Task Plan",
    planEmpty: "Agent will create plans for complex tasks with real-time progress.",
    skillMarket: "Skills Market",
    builtinWorkflow: "Built-in Workflows",
    userSkills: "User Skills",
    autoSediment: "Auto-sediment",
    noSkills: "No skills available",
    inputPlaceholder: "Describe your task; supports @file:path / @folder:path, paste or drag images…",
    send: "Send",
    stop: "Stop",
    skill: "Skill",
    enterToSend: "Enter to send",
    permAsk: "Permission: Confirm each",
    permSemi: "Permission: Semi-auto",
    permAuto: "Permission: Full auto",
    currentChat: "Current Chat",
    ready: "Ready",
    running: "Running",
    newChat: "New Chat",
    exportChat: "Export",
    noHistory: "No history",
    openaiCompat: "Model Settings - OpenAI Compatible API",
    modelConfig: "Model Config (click to switch / save as preset)",
    baseURL: "Base URL",
    apiKey: "API Key",
    modelName: "Model Name",
    fetchModels: "Fetch Models",
    testConn: "Test Connection",
    save: "Save & Switch Engine",
    savePreset: "+ Save current as preset",
    noPresets: "No presets yet. Fill in the config below and click \"Save as preset\"",
    createSkill: "Create Skill",
    skillName: "Skill Name *",
    description: "Description",
    category: "Category",
    trigger: "Trigger keywords (comma separated)",
    skillContent: "Content (Markdown) *",
    saveToMarket: "Save to Market",
    viewDetail: "View",
    refToChat: "Reference to chat",
    saveEdit: "Save Changes",
    nameCantEmpty: "Name and content cannot be empty",
    login: "Login",
    register: "Register New Account",
    username: "Username",
    password: "Password",
    loginSuccess: "✅ Login successful",
    registerSuccess: "✅ Registration successful",
    fillUserPass: "Please enter username and password",
    goal: "Goal",
    setGoal: "Set Goal",
    goalPlaceholder: "Describe your goal, e.g.: Implement complete user auth with frontend, backend and tests",
    startGoal: "Start Goal",
    goalStarted: "Goal started, Agent will run until complete",
    terminal: "Terminal",
    terminalHint: "Real execution",
    changesPanel: "Changes",
    noChangesAgent: "Files and diffs will appear here after Agent modifies code.",
    preview: "Preview",
    autoRefresh: "Real-time on edit",
    close: "Close",
    confirm: "OK",
    cancel: "Cancel",
    queued: "Queue",
    agentAborted: "Agent aborted",
    agentAbortedMsg: "Aborted",
    newChatStarted: "New chat started, AI context cleared (file changes preserved)",
    contextCompressed: "Context auto-compressed",
    memoryConsolidated: "Memory consolidated",
    skillCreated: "Skill created",
    skillSaved: "Skill saved",
    skillDeleted: "Deleted",
    skillRef: "Skill selected",
    importSuccess: "Imported",
    importFail: "Import failed",
    jsonError: "Invalid JSON",
    approve: "Approve",
    reject: "Reject",
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
    highRisk: "High risk",
    midRisk: "Medium risk",
    lowRisk: "Low risk",
    opFailed: "Operation failed",
    saved: "Saved",
    welcome: "Hello, I'm pancode Agent.",
    welcomeLlm: "Current engine",
    welcomeDemo: "Currently using built-in demo engine",
    files: " files",
    steps: " steps",
    lines: " lines",
    // 语义检索
    kwSearch: "Keyword",
    semSearch: "Semantic",
    buildIndex: "Build Index",
    buildIndexing: "Building index…",
    rebuildIndex: "Rebuild Index",
    indexBuilt: "Built",
    // 语言切换
    langToggle: "中",
  },
};

let currentLang = localStorage.getItem("cw-lang") || "zh";

function t(key) {
  return (LANGS[currentLang] && LANGS[currentLang][key]) || (LANGS.zh[key]) || key;
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem("cw-lang", lang);
  applyI18n();
  // 切换语言后重渲染动态区域（文件树 / 会话列表），使文案同步；历史聊天消息不翻译
  if (typeof renderTree === "function") { try { renderTree(); } catch (e) {} }
  if (typeof renderConvList === "function") { try { renderConvList(); } catch (e) {} }
  if (typeof window.refreshSidebar && typeof window.refreshSidebar === "function") { try { window.refreshSidebar(); } catch (e) {} }
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    const val = t(key);
    if (el.tagName === "INPUT" && el.type === "text") el.placeholder = val;
    else if (el.tagName === "TEXTAREA") el.placeholder = val;
    else el.textContent = val;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
}

// 全局暴露，供 app.js 使用
window.LANGS = LANGS;
window.t = t;
window.setLang = setLang;
window.applyI18n = applyI18n;
