/* ============================================================
   pancode 首次引导（三步浮层）
   依赖全局：state / replaceIcons / $（运行时解析）
   内联 onclick="hideOnboarding();openSettings()" 要求两者均为全局
   ============================================================ */
"use strict";

let _obStep = 0;
const _obSteps = [
  { title: "这是什么", html: '<h3>pancode · Agent 驱动的自主编程台</h3><ul><li>编辑器直接改代码，<code>Ctrl/⌘+S</code> 真实保存</li><li>文件树支持新建 / 重命名 / 删除</li><li>终端真实执行命令（<code>Ctrl+C</code> 中断）</li><li>Agent 会自己写代码、跑测试、修 bug，并在过程中不断「进化」</li></ul>' },
  { title: "配置大模型", html: '<h3>让 Agent 真正聪明起来</h3><p id="obModelTip"></p><ul><li>右上角 <code>模型设置</code> 填入 OpenAI 兼容的 <code>Base URL / API Key / 模型名</code></li><li>没有 Key 也能用：内置「演示引擎」开箱即用</li></ul><div class="ob-cta"><button class="set-btn" style="background:var(--accent);color:#fff" onclick="hideOnboarding();openSettings()">去配置模型</button></div>' },
  { title: "开始对话", html: '<h3>发第一条消息</h3><ul><li>底部输入框描述需求，<code>Enter</code> 发送（<code>Shift+Enter</code> 换行）</li><li>输入 <code>@</code> 引用文件，<code>Ctrl/⌘+Shift+P</code> 打开命令面板</li><li>复杂任务自动生成计划，左侧实时看进度</li></ul>' },
];
function renderOnboard() {
  const s = _obSteps[_obStep];
  $("onboardBody").innerHTML = s.html;
  replaceIcons($("onboardBody"));
  $("onboardDots").innerHTML = _obSteps.map((_, i) => '<i class="' + (i === _obStep ? "on" : "") + '"></i>').join("");
  $("onboardPrev").style.visibility = _obStep === 0 ? "hidden" : "visible";
  $("onboardNext").textContent = _obStep === _obSteps.length - 1 ? "开始使用" : "下一步";
  const tip = $("obModelTip");
  if (tip) tip.innerHTML = (state.engine && state.engine.mode === "llm") ? "✅ 已检测到 LLM 配置，可以直接对话。" : "⚠️ 当前为演示引擎，Agent 能力有限，建议配置真实 Key。";
}
function showOnboarding() { _obStep = 0; renderOnboard(); $("onboardModal").style.display = "flex"; }
function hideOnboarding() { $("onboardModal").style.display = "none"; localStorage.setItem("cw-onboarded", "1"); }
function maybeOnboard() { if (!localStorage.getItem("cw-onboarded")) showOnboarding(); }
$("onboardSkip").onclick = hideOnboarding;
$("onboardPrev").onclick = () => { if (_obStep > 0) { _obStep--; renderOnboard(); } };
$("onboardNext").onclick = () => { if (_obStep < _obSteps.length - 1) { _obStep++; renderOnboard(); } else hideOnboarding(); };
