/* ============================================================
   pancode 首次引导（三步浮层）
   依赖全局：state / replaceIcons / $（运行时解析）
   内联 onclick="hideOnboarding();openSettings()" 要求两者均为全局
   ============================================================ */
"use strict";

let _obStep = 0;
const _obSteps = [
  { title: t("obToptitleT139"), html: '<h3>' + t("obTopH94") + '</h3><ul><li>' + t("obTopH95") + '<code>Ctrl/⌘+S</code>' + t("obTopH96") + '</li><li>' + t("obTopH97") + '</li><li>' + t("obTopH98") + '<code>Ctrl+C</code>' + t("obTopH99") + '</li><li>' + t("obTopH100") + '</li></ul>' },
  { title: t("obToptitleT140"), html: '<h3>' + t("obTopH101") + '</h3><p id="obModelTip"></p><ul><li>' + t("obTopH102") + '<code>' + t("obTopH103") + '</code>' + t("obTopH104") + '<code>' + t("obTopH105") + '</code></li><li>' + t("obTopH106") + '</li></ul><div class="ob-cta"><button class="set-btn" style="background:var(--accent);color:#fff" onclick="hideOnboarding();openSettings()">' + t("obTopH107") + '</button></div>' },
  { title: t("obToptitleT141"), html: '<h3>' + t("obTopH108") + '</h3><ul><li>' + t("obTopH109") + '<code>Enter</code>' + t("obTopH110") + '<code>Shift+Enter</code>' + t("obTopH111") + '</li><li>' + t("obTopH112") + '<code>@</code>' + t("obTopH113") + '<code>Ctrl/⌘+Shift+P</code>' + t("obTopH114") + '</li><li>' + t("obTopH115") + '</li></ul>' },
];
function renderOnboard() {
  const s = _obSteps[_obStep];
  $("onboardBody").innerHTML = s.html;
  replaceIcons($("onboardBody"));
  $("onboardDots").innerHTML = _obSteps.map((_, i) => '<i class="' + (i === _obStep ? "on" : "") + '"></i>').join("");
  $("onboardPrev").style.visibility = _obStep === 0 ? "hidden" : "visible";
  $("onboardNext").textContent = _obStep === _obSteps.length - 1 ? t("obLastStep") : t("onboardNext");
  const tip = $("obModelTip");
  if (tip) tip.innerHTML = (state.engine && state.engine.mode === "llm") ? t("obHasLlm") : t("obDemoEngine");
}
function showOnboarding() { _obStep = 0; renderOnboard(); $("onboardModal").style.display = "flex"; }
function hideOnboarding() { $("onboardModal").style.display = "none"; localStorage.setItem("cw-onboarded", "1"); }
function maybeOnboard() { if (!localStorage.getItem("cw-onboarded")) showOnboarding(); }
$("onboardSkip").onclick = hideOnboarding;
$("onboardPrev").onclick = () => { if (_obStep > 0) { _obStep--; renderOnboard(); } };
$("onboardNext").onclick = () => { if (_obStep < _obSteps.length - 1) { _obStep++; renderOnboard(); } else hideOnboarding(); };
