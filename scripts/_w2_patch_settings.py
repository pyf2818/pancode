# -*- coding: utf-8 -*-
# W2 patch: public/js/settings.js — 专家动态填充 agmPersona select
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
p = os.path.join(BASE, "public", "js", "settings.js")
src = io.open(p, "r", encoding="utf-8").read()

old = (
    '    $("agmLsp").checked = !(a.lsp && a.lsp.enabled === false);\n'
    '    agmSyncPromptVis();\n'
)
new = (
    '    $("agmLsp").checked = !(a.lsp && a.lsp.enabled === false);\n'
    '    agmSyncPromptVis();\n'
    '    // W2：动态填充专家包选项（项目级/用户级 experts/*.md → optgroup，插在 custom 之前）\n'
    '    try {\n'
    '      const ex = await fetch("/api/experts").then((x) => x.json());\n'
    '      const sel = $("agmPersona");\n'
    '      const stale = sel.querySelector(\'optgroup[data-dyn="experts"]\');\n'
    '      if (stale) stale.remove();\n'
    '      const customOpt = sel.querySelector(\'option[value="custom"]\');\n'
    '      let og = null;\n'
    '      for (const e of (ex.experts || [])) {\n'
    '        if (e.source === "builtin") continue; // 内置三项已有静态 option（id 一致）\n'
    '        if (!og) {\n'
    '          og = document.createElement("optgroup");\n'
    '          og.setAttribute("label", "专家包");\n'
    '          og.dataset.dyn = "experts";\n'
    '          sel.insertBefore(og, customOpt);\n'
    '        }\n'
    '        const o = document.createElement("option");\n'
    '        o.value = e.id;\n'
    '        o.textContent = e.name + (e.source === "user" ? " · 用户级" : " · 项目级");\n'
    '        og.appendChild(o);\n'
    '      }\n'
    '    } catch (e2) { /* 专家列表拉取失败不阻塞设置面板 */ }\n'
)

n = src.count(old)
assert n == 1, "settings.js: expect 1 occurrence, got %d" % n
src = src.replace(old, new)
newp = p + ".new"
io.open(newp, "w", encoding="utf-8", newline="").write(src)
print("settings.js -> .new written")
