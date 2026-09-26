# -*- coding: utf-8 -*-
# W2 patch: index.js + tools/agent-tools.js + orchestrator.js
import io, os

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

def patch_file(rel, patches):
    p = os.path.join(BASE, rel)
    src = io.open(p, "r", encoding="utf-8").read()
    applied = []
    for name, old, new in patches:
        n = src.count(old)
        assert n == 1, "%s / %s: expect 1 occurrence, got %d" % (rel, name, n)
        src = src.replace(old, new)
        applied.append(name)
    newp = p + ".new"
    io.open(newp, "w", encoding="utf-8", newline="").write(src)
    print(rel, "-> .new written:", ", ".join(applied))

# ---------- server/index.js ----------
patch_file(os.path.join("server", "index.js"), [
    ("require", 'const { MemoryStore } = require("./memory-store");',
                'const { MemoryStore } = require("./memory-store");\n'
                'const { ExpertStore } = require("./expert-store"); // W2 专家注册表'),
    ("buildEngine",
     '_engineAssets.userMemory = new MemoryStore(path.join(require("os").homedir(), ".pancode", "memory", "user.json"));\n',
     '_engineAssets.userMemory = new MemoryStore(path.join(require("os").homedir(), ".pancode", "memory", "user.json"));\n'
     '  // W2：专家注册表（项目级 = <工作区>/.pancode/experts，用户级 = ~/.pancode/experts，内置 = BUILTIN_EXPERTS）\n'
     '  _engineAssets.experts = new ExpertStore(WS_DIR ? path.join(WS_DIR, ".pancode", "experts") : null,\n'
     '    path.join(require("os").homedir(), ".pancode", "experts"));\n'),
    ("ctx", "    sharedUserMemory: a.userMemory,\n",
            "    sharedUserMemory: a.userMemory,\n"
            "    sharedExperts: a.experts, // W2：专家注册表\n"),
    ("route",
     'app.get("/api/skills", (req, res) => {\n'
     '  try {\n'
     '    const q = String(req.query.q || "");\n'
     '    const results = q ? engine.skills.match(q, 10) : engine.skills.list({ limit: 30 });\n'
     '    res.json({ ok: true, skills: results, total: engine.skills.size });\n'
     '  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }\n'
     '});\n',
     'app.get("/api/skills", (req, res) => {\n'
     '  try {\n'
     '    const q = String(req.query.q || "");\n'
     '    const results = q ? engine.skills.match(q, 10) : engine.skills.list({ limit: 30 });\n'
     '    res.json({ ok: true, skills: results, total: engine.skills.size });\n'
     '  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }\n'
     '});\n'
     '\n'
     '/* ---------- W2：专家（Experts）API ---------- */\n'
     'app.get("/api/experts", (req, res) => {\n'
     '  try {\n'
     '    res.json({ ok: true, experts: engine.experts.list(), active: (cfg.persona && cfg.persona.active) || "default" });\n'
     '  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }\n'
     '});\n'),
])

# ---------- server/tools/agent-tools.js ----------
patch_file(os.path.join("server", "tools", "agent-tools.js"), [
    ("expert-passthrough",
     'const result = await agent.runSubAgent(args.task, { subagent_type: args.subagent_type });',
     'const result = await agent.runSubAgent(args.task, { subagent_type: args.subagent_type, expert: args.expert }); // W2：专家人设透传'),
])

# ---------- server/orchestrator.js ----------
patch_file(os.path.join("server", "orchestrator.js"), [
    ("step-expert",
     'const result = await this.agent.runSubAgent(taskText, {\n'
     '            subagent_type: step.agent_type || "general",\n'
     '          });',
     'const result = await this.agent.runSubAgent(taskText, {\n'
     '            subagent_type: step.agent_type || "general",\n'
     '            expert: step.expert, // W2：编排步骤可选专家人设\n'
     '          });'),
])
print("ALL PATCHES WRITTEN AS .new")
