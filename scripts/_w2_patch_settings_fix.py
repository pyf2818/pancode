# -*- coding: utf-8 -*-
# W2 fix: settings.js — 同 value 选项去重 + 覆盖内置时更新标签
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
p = os.path.join(BASE, "public", "js", "settings.js")
src = io.open(p, "r", encoding="utf-8").read()

old = (
    '      for (const e of (ex.experts || [])) {\n'
    '        if (e.source === "builtin") continue; // 内置三项已有静态 option（id 一致）\n'
    '        if (!og) {\n'
)
new = (
    '      for (const e of (ex.experts || [])) {\n'
    '        // 已有同 value 选项（内置三项或重复请求）：更新标签而非新增，防重复 option；\n'
    '        // 内置 id 被项目/用户级包覆盖时，标签同步为覆盖后的专家名\n'
    '        const existing = sel.querySelector(\'option[value="\' + e.id + \'"]\');\n'
    '        if (existing) { existing.textContent = e.name + (e.source === "user" ? " · 用户级" : e.source === "project" ? " · 项目级" : ""); continue; }\n'
    '        if (e.source === "builtin") continue; // 纯内置项已有静态 option\n'
    '        if (!og) {\n'
)

n = src.count(old)
assert n == 1, "settings.js: expect 1 occurrence, got %d" % n
src = src.replace(old, new)
newp = p + ".new"
io.open(newp, "w", encoding="utf-8", newline="").write(src)
print("settings.js fix -> .new written")
