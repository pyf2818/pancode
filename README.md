# pancode

> [English](README.md) | [中文](README.zh-CN.md)

> A **local-first AI coding workbench** — a writable editor that reads and writes real files on disk, a real terminal that runs real commands, and an agent that programs autonomously through a **real LLM tool-calling loop**. Not a demo toy.

**Make AI your coding partner: real, efficient, controllable — and it learns how you work.**

---

## 📌 About pancode

pancode is a fully self-contained, local-first AI coding system — from its runtime to its workbench, everything is built in-house. At its core sits a homegrown agent runtime that drives the "think → call tool → observe → think again" ReAct loop inside a single process, alongside the HTTP/WebSocket gateway, the filesystem protocol, command execution, context compaction, memory/evolution, and multi-agent orchestration. The front end is a browser-based workbench that uses Monaco as its editing kernel, ships a unified SVG icon set, and stays consistent across light and dark themes. The desktop build bundles the backend and workspace into an installable Electron app — open it and go, no login required.

The project depends on no off-the-shelf agent framework: the security model, tool contracts, patch review, context budget, orchestration scheduler, and memory accumulation are all designed and implemented from first principles. Monaco is adopted purely as the interactive editing kernel; it is a peer component alongside the agent runtime and backend services, not a wrapper "built on top of" some editor.

---

## ✨ Why pancode

Feature coverage benchmarked against Cursor / Windsurf / Cline / Aider / Copilot — implemented end to end under a local-first constraint:

| Dimension | Highlights |
| --- | --- |
| **Agent core** | Real ReAct tool loop (74 tools), Plan / Ask / Agent modes, approval flow (`ask` / `semi` / `auto` + allow/deny + hooks), command sandbox (policy / docker / wsl), egress domain policy |
| **Editing** | Aider-style search/replace patches with per-hunk review, undo checkpoints, Git baseline & restore, LSP diagnostics, semantic code index, repo map, `@file` mentions |
| **Orchestration** | Multi-agent orchestration with per-file claiming, focused sub-agents, goal-driven long runs, workflow templates |
| **Context** | Four-tier compaction (microcompact → structured summary → circuit breaker → emergency trim), CJK-aware token accounting, per-round group trimming, spill-to-disk for oversized tool output |
| **Memory** | Structured long-term memory, soul/values evolution, progression levels, Skills marketplace, per-session settlement |
| **Ecosystem** | MCP (zero-dependency client), OpenAI-compatible + Anthropic-native protocols, per-session cost ledger |
| **One stop** | Editor + chat + integrated terminal + source control + live preview in one workbench; Electron desktop app; VS Code extension scaffold |

Runs with **no API key at all** — a built-in demo engine performs a full loop (read code → edit → run tests → watch them fail → fix → pass → diff) so you can evaluate before wiring a model.

---

## 🤖 The coding kernel

### Real LLM tool loop (ReAct)
The canonical "think → call tool → observe → think again" loop runs until the task is done. Full tool set:

`list_files` · `read_file` · `write_file` · `apply_edit` · `delete_file` · `search_code` · `run_command` · `repo_map` · `search_symbol` · `search_memory` · `get_diagnostics` · `undo` · `create_skill` · `create_plan` / `update_plan` · `list_templates` / `instantiate_template` / `save_template` / `remove_template` · `set_goal` / `goal_status` · `save_session_memory` · `agent`

### Plan Mode (plan/execute separation)
When enabled, the agent may only read, retrieve, and plan — **no** writing files, running commands, or calling external MCP tools — until you review the plan and switch back to execute mode. This is the industry-standard safety boundary (same paradigm as Cursor / Cline / Windsurf).

### Reliable editing: patches + per-hunk review + undo
- Edits are **Aider-style search/replace blocks**, more precise and safer than whole-file overwrites.
- Changes land in a **review panel**; you **accept / reject** per file / per hunk (diff view) before anything touches disk.
- A checkpoint is recorded before every write; the `undo` tool rolls back one step (LIFO).

### LSP diagnostics
The backend bridges language servers (stdio JSON-RPC) and surfaces compile / type / syntax errors live, exposing a `get_diagnostics` tool so the agent **self-corrects** against them.

### MCP external tools
A zero-dependency stdio JSON-RPC client plugs into local / third-party tool servers (filesystem, databases, API gateways…). Tools a server exposes are auto-registered as `mcp__<server>__<tool>`; disabled automatically in Plan Mode. Manage them visually under **Agent Settings → MCP**.

### Multi-agent orchestration
The `agent` tool dispatches a focused sub-agent that reads / searches / writes / edits / runs commands in the same workspace and reports back in Chinese. Orchestration renders as a directed acyclic graph: **vertical swimlanes** express layer ordering, Bézier edges trace dependencies, and sub-task outputs expand by default. The final result is set apart as an independent **answer card** (bordered, with a "结论/answer" badge) distinct from the thinking chain, with **copy / regenerate / branch** actions. Dispatched serially with a round cap to prevent runaway, it makes real workspace changes and refreshes the editor and index.

---

## 🧠 Learns how you work (memory · evolution · skills)

- **Structured long-term memory**: stored by type (preferences / experience / conventions / anti-patterns), auto-classified from your corrections, with memory distillation to curb bloat; `search_memory` lets the agent consult past experience.
- **Soul evolution**: after a task, proposes tuning the agent's values / boundaries / principles (takes effect only after your confirmation).
- **Progression system**: computes stage and XP from accumulated deposits, feeding back into behavioral preferences (craftsman → quality, scholar → docs, companion → rapport).
- **Skills marketplace**: distills a class of problems into reusable templates, auto-injected by trigger words.
- **Session settlement**: `save_session_memory` structures the session's effective decisions / lessons / rejected actions into long-term assets.

---

## 🧭 Dual-window mode

| Window | Purpose |
| --- | --- |
| **Editor Window** | VS Code-style editor: file tree CRUD, writable editor (Ctrl+S), full-text search, source control, integrated terminal, AI sidebar, live preview (**two-way scroll sync** with the editor) |
| **Agents Window** | Conversation workbench: thinking stream, tool cards grouped per round (collapsible), real terminal, diff reports, task plan, multi-agent orchestration graph, multi-session grid view |

Both windows stay in sync — conversations, terminal, state.

---

## 🚀 Quick start

```bash
npm install
npm start            # Web UI: http://localhost:8766
```

Requires **Node.js ≥ 24** (`agent-browser@0.39` requires ≥ 24; the test toolchain, vitest 5, requires ≥ 22.12). No login screen — the server issues a loopback-only identity automatically.

### Desktop (Electron)

```bash
npm run desktop      # desktop window (built-in backend, port 8767)
npm run dist         # Windows installer (NSIS) → release/
```

### Configure a model

Click **Model Settings** (top right) and point it at any OpenAI-compatible API (OpenAI / DeepSeek / Moonshot / Qwen / Ollama / vLLM…), or pick the native Anthropic protocol (`provider: "anthropic"`) for thinking deltas and prompt caching. Switching models auto-fills the context window from the 26 presets in `model-presets.js` — no manual entry needed.

**Data boundary:** the app is local-first (files, conversations and memory stay in `.pancode` on this machine), but a remote LLM means prompts, selected code, tool results and file snippets **are sent to the provider you configure**. The API key is stored locally and never rendered back to the UI. Point the base URL at a local runtime (Ollama / vLLM) if the code must not leave the machine.

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1 \
OPENAI_API_KEY=sk-xxx \
OPENAI_MODEL=deepseek-chat \
npm start
```

With no key configured, the **demo engine** boots automatically so you can experience the full loop out of the box (read code → edit → run tests that really fail → self-fix → re-test passes → diff report).

---

## 🗂️ Project structure

```
pancode/
├── server/                      # Backend: single Node.js process (HTTP + WebSocket + filesystem + agent runtime)
│   ├── index.js                 # Entry: HTTP/WS gateway, auth, route assembly, hello ctxLimit
│   ├── agent-base.js            # Agent shared primitives: thinking stream / message stream / tool cards
│   ├── agent-llm.js             # Real LLM engine: ReAct tool loop + repo map + memory/evolution
│   ├── agent-demo.js            # Offline demo engine (full loop with no key)
│   ├── orchestrator.js          # Multi-agent orchestration: DAG, layers, dependencies, workspace isolation
│   ├── context-retriever.js     # Intelligent context retrieval (budget + auto-compaction)
│   ├── security.js              # Command & prompt-injection safety layer (6-stage normalize/sandbox)
│   ├── safe-write.js            # Anti-AV / concurrency-safe write queue (exponential backoff, never throws)
│   ├── sandbox.js               # Command sandbox: policy (default) / docker (hard) / wsl (soft)
│   ├── net-guard.js             # Egress domain allow/deny + connection-time IP pinning
│   ├── memory-store.js          # Structured long-term memory (prefs/experience/conventions/anti-patterns)
│   ├── soul-store.js / evolution.js / progression*.js  # soul / evolution / stage
│   ├── skill-store.js / builtin-skills/  # Skills marketplace + built-in skill packs
│   ├── code-index.js / repo-map.js / code-graph.js  # semantic index / repo map / code graph
│   ├── lsp-bridge.js            # LSP diagnostics bridge (stdio JSON-RPC proxy)
│   ├── mcp.js                   # Zero-dependency MCP client
│   ├── model-presets.js         # 26 model context-window presets + /api/llm/presets
│   ├── scheduler.js / cron-lite.js  # Task scheduler (5-field cron + snapshot-isolated sub-agents)
│   ├── computer/                # Computer use: browser / UIA / vision / screenshot assertion
│   ├── tools/                   # 23+ tool implementations (file/patch/terminal/Git/LSP…)
│   ├── config.js / files.js / git.js / processes.js / auth.js / cost.js / logger.js …
│   └── *.test.js                # 80+ backend unit tests (P0–P5 tiers, vitest)
├── public/                      # Frontend: Chromium render, Monaco editing kernel, full SVG icons
│   ├── index.html               # Dual-window layout skeleton (Editor / Agents switch)
│   ├── app.js                   # Main controller: chat/orchestration/preview/grid view/sessions
│   ├── store.js                 # Frontend state (ctxLimit, orchestration scope…)
│   ├── i18n.js                  # Bilingual (Chinese default, applies on switch)
│   ├── icons.js                 # Unified SVG icon set (BADGES type badges)
│   ├── styles.css               # Design tokens / light & dark / orchestration overlay / answer card
│   └── js/
│       ├── workbench.js         # Editor workbench (Monaco + file tree + preview scroll sync)
│       ├── terminal-mod.js      # Integrated terminal
│       ├── md-worker.js         # Markdown render worker (65ms throttle + snapshot check)
│       ├── visualizer.js        # Multi-agent orchestration graph (vertical swimlanes + Bézier edges)
│       ├── trace.js             # Agent trace panel (emitted / watermark / ≈ N rounds)
│       ├── skill-market.js / automations.js / global-settings.js / gear-menu.js
│       ├── lsp-client.js / diagnostics.js / dep-graph.js
│       ├── assets-center.js / commit.js / processes.js / patch-review.js
│       ├── onboard.js / cmdk.js / evolution-codex.js / utils.js / core.js
│       └── settings.js
├── electron/                    # Desktop shell: Electron-builder (NSIS) packaging
│   ├── main.js                  # Main process: window / protocol / built-in backend bootstrap
│   ├── preload.js               # Secure bridge
│   ├── close-policy.js          # Close policy (avoid losing sessions on accidental quit)
│   └── task-watch.js            # Task watchdog
├── scripts/                     # Build / verify / probes (50+ acceptance scripts)
│   ├── dist.js                  # Packaging (ELECTRON_MIRROR + proxy clear, avoids 502)
│   ├── _verify_*.js             # Link probes (render/orchestration/preview/grid/i18n/compaction…)
│   └── _smoke_ui.js / _verify_pkg.js
├── docs/                        # Design research / optimization plans / gap analyses
├── research/                    # Competitive architecture & baseline reports
├── test/                        # E2E + unit (P0–P5 tiers)
├── tests/                       # e2e-workspace smoke
├── ide/vscode/                  # VS Code extension scaffold
├── assets/                      # Icons (icon.svg / icon-1024.png / icon.ico "清雅薄荷/mint")
├── pancode.config.json          # Config shape sample
├── package.json / tsconfig.json
├── README.md / README.zh-CN.md
└── CHANGELOG.md
```

---

## ⚙️ Reliability engineering

- **Round-grouped timeline** — every agent round collapses into one summary line (`R3 · edit src/app.js · 5 steps · 23s`); screenshots and approvals stay visible.
- **Re-run from any message** — hover a user bubble, click ↻: the conversation is truncated before that message and the task re-runs verbatim.
- **Guardrails** — tool-argument schema validation, same-call loop breaking, failure-streak reflection, watchdog (stall + wall clock, suspended while a tool or approval is legitimately pending), 429 backoff per endpoint, orphaned-tool-result repair, context-overflow recovery in both main and sub-agent loops.
- **Observability** — decision log (why was this allowed/blocked), agent trace, per-conversation token/cost ledger, audit log.

---

## ⚙️ Configuration

Most settings live in the UI (Model / Agent settings) and persist to `pancode.config.json`. Key env vars:

```bash
PORT=8766                  # server port (bound to 127.0.0.1 only)
OPENAI_BASE_URL=url        # LLM API base
OPENAI_API_KEY=key         # LLM key (kept in memory / .env, never rendered back to the UI)
OPENAI_MODEL=model         # model name
PANCODE_DATA_DIR=path      # data root (.pancode), defaults next to the repo
```

See `pancode.config.json` in the repo root for the full shape (permissions, rules, memory, sandbox, net policy, MCP servers, LSP).

---

## 📚 Research & docs

- `ai-coding-agent-baseline.md` — capability baseline of Claude Code / Codex / Cline / Cursor, verified against official docs.
- `agentic-coding-tools-architecture-report.md` — architecture report across Cursor / Windsurf / Cline / Aider / Copilot / Zed / OpenCode / Goose / Continue.
- `docs/` — design research, optimization plans, gap analyses.
- `CHANGELOG.md` — release history.

---

## 🧪 Tests

```bash
npm run test:unit       # vitest, 1,300+ tests in 72 files (sandbox, net-guard, SSE, Anthropic, sub-agents…)
npm run test:verify     # 55 probes on a live server (render, repo map, tools, agents, isolation…; 62 acceptance scripts under scripts/, desktop/UI ones run separately)
npm run smoke           # end-to-end loop with the demo engine
npm run test:nightly    # real-LLM nightly regression — no key means SKIP, which is NOT a pass
npm test                # full suite: unit + probes + smoke + integration/patch/lsp/code-index
```

CI runs lint → unit → probes → smoke → file ops on Windows (Node 24, matching `engines`). Of the 55 probes, 53 run to completion on the runner and 2 print `SKIP` — `_verify_computer` (UIA + screen capture) and `_verify_browser` (agent-browser driving a local Chrome/Edge) both need an interactive desktop session, which a CI runner does not have; `npm run verify:all` locally runs all 55 plus the Electron shell checks. A skipped probe is reported as skipped, not as a pass. A nightly workflow runs the real-LLM regression when `NIGHTLY_LLM_KEY` is configured — without it the nightly prints `RESULT: SKIP`, which is not a pass.

---

## 📄 License

[MIT](LICENSE)
