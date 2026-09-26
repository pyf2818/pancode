# -*- coding: utf-8 -*-
# W4 patch: server/index.js — 自动化任务实例化 + API
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
p = os.path.join(BASE, "server", "index.js")
src = io.open(p, "r", encoding="utf-8").read()
applied = []

def patch_once(name, old, new):
    global src
    n = src.count(old)
    assert n == 1, "%s: expect 1 occurrence, got %d" % (name, n)
    src = src.replace(old, new)
    applied.append(name)

# ---- 1. require ----
patch_once(
    "require",
    'const { ExpertStore } = require("./expert-store"); // W2 专家注册表',
    'const { ExpertStore } = require("./expert-store"); // W2 专家注册表\n'
    'const { AutomationStore, Scheduler } = require("./scheduler"); // W4 自动化任务',
)

# ---- 2. 模块级实例变量 + buildEngine 内初始化 ----
patch_once(
    "module-vars",
    "let files = null, git = null, term = null, procs = null, engine = null, soulStore = null, progressionStore = null, skillStore = null;",
    "let files = null, git = null, term = null, procs = null, engine = null, soulStore = null, progressionStore = null, skillStore = null;\n"
    "let automationStore = null, schedulerInst = null; // W4 自动化任务（随工作区重建）",
)
patch_once(
    "buildEngine-init",
    '  _engineAssets.experts = new ExpertStore(WS_DIR ? path.join(WS_DIR, ".pancode", "experts") : null,\n'
    '    path.join(require("os").homedir(), ".pancode", "experts"));\n',
    '  _engineAssets.experts = new ExpertStore(WS_DIR ? path.join(WS_DIR, ".pancode", "experts") : null,\n'
    '    path.join(require("os").homedir(), ".pancode", "experts"));\n'
    '  // W4：自动化任务（ROOT/.pancode/automations/<wsHash>/，随工作区重建；停掉旧调度器防泄漏）\n'
    '  if (schedulerInst) { try { schedulerInst.stop(); } catch (_) {} schedulerInst = null; }\n'
    '  automationStore = new AutomationStore(path.join(configMod.ROOT, ".pancode", "automations", wsHash));\n'
    '  schedulerInst = new Scheduler(automationStore, () => engine);\n'
    '  schedulerInst.start();\n',
)

# ---- 3. API 路由（挂在 /api/experts 之后） ----
patch_once(
    "routes",
    'app.get("/api/experts", (req, res) => {\n'
    '  try {\n'
    '    res.json({ ok: true, experts: engine.experts.list(), active: (cfg.persona && cfg.persona.active) || "default" });\n'
    '  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }\n'
    '});\n',
    'app.get("/api/experts", (req, res) => {\n'
    '  try {\n'
    '    res.json({ ok: true, experts: engine.experts.list(), active: (cfg.persona && cfg.persona.active) || "default" });\n'
    '  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }\n'
    '});\n'
    '\n'
    '/* ---------- W4：自动化任务（Automations）API ---------- */\n'
    'app.get("/api/automations", (req, res) => {\n'
    '  try { res.json({ ok: true, automations: automationStore.list() }); }\n'
    '  catch (e) { res.status(500).json({ ok: false, error: e.message }); }\n'
    '});\n'
    'app.post("/api/automations", async (req, res) => {\n'
    '  try {\n'
    '    const r = await automationStore.create(req.body || {});\n'
    '    if (r.error) return res.status(400).json({ ok: false, error: r.error });\n'
    '    res.json({ ok: true, automation: r.task });\n'
    '  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }\n'
    '});\n'
    'app.post("/api/automations/:id/:action(pause|resume|run)", async (req, res) => {\n'
    '  try {\n'
    '    const { id, action } = req.params;\n'
    '    if (action === "run") {\n'
    '      const t = automationStore.get(id);\n'
    '      if (!t) return res.status(404).json({ ok: false, error: "任务不存在" });\n'
    '      schedulerInst.fire(id); // 异步执行，立即返回（历史见 runs）\n'
    '      return res.json({ ok: true, started: true });\n'
    '    }\n'
    '    const r = await automationStore.update(id, { status: action === "pause" ? "paused" : "active" });\n'
    '    if (r.error) return res.status(404).json({ ok: false, error: r.error });\n'
    '    res.json({ ok: true, automation: r.task });\n'
    '  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }\n'
    '});\n'
    'app.delete("/api/automations/:id", (req, res) => {\n'
    '  try {\n'
    '    const r = automationStore.remove(req.params.id);\n'
    '    if (r.error) return res.status(404).json({ ok: false, error: r.error });\n'
    '    res.json({ ok: true });\n'
    '  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }\n'
    '});\n'
    'app.get("/api/automations/:id/runs", (req, res) => {\n'
    '  try {\n'
    '    const t = automationStore.get(req.params.id);\n'
    '    if (!t) return res.status(404).json({ ok: false, error: "任务不存在" });\n'
    '    res.json({ ok: true, runs: automationStore.runs(req.params.id, 20) });\n'
    '  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }\n'
    '});\n',
)

newp = p + ".new"
io.open(newp, "w", encoding="utf-8", newline="").write(src)
print("index.js -> .new written:", ", ".join(applied))
