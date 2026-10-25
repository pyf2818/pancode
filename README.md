# pancode

> [English](README.md) | [中文](README.zh-CN.md)

> A **local-first AI coding workbench** — a writable Monaco editor (the VS Code kernel), a real terminal, and an agent that programs autonomously through a **real LLM tool-calling loop**. Not a demo toy.

**Make AI your coding partner: real, efficient, controllable — and it learns how you work.**

No cloud. No account. No telemetry. Your code and your keys never leave this machine.

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

Click **Model Settings** (top right) and point it at any OpenAI-compatible API (OpenAI / DeepSeek / Moonshot / Qwen / Ollama / vLLM…), or pick the native Anthropic protocol (`provider: "anthropic"`) for thinking deltas and prompt caching.

**Data boundary:** the app is local-first (files, conversations and memory stay in `.pancode` on this machine), but a remote LLM means prompts, selected code, tool results and file snippets **are sent to the provider you configure**. The API key is stored locally and never rendered back to the UI. Point the base URL at a local runtime (Ollama / vLLM) if the code must not leave the machine.

```bash
OPENAI_BASE_URL=https://api.deepseek.com/v1 \
OPENAI_API_KEY=sk-xxx \
OPENAI_MODEL=deepseek-chat \
npm start
```

### Sandbox (recommended)

`run_command` runs through a policy blacklist + approval gate by default. For hard isolation, configure `sandbox` in `pancode.config.json`:

```json
{ "sandbox": { "backend": "docker" } }
```

`docker` runs every AI command in a one-shot container with only the workspace mounted (read-write) and networking off. `wsl` is a softer option; `auto` probes docker → wsl → policy.

---

## 🧭 Dual-window mode

| Window | Purpose |
| --- | --- |
| **Editor Window** | VS Code-style editor: file tree, writable editor (Ctrl+S), full-text search, source control, integrated terminal, AI sidebar, live preview |
| **Agents Window** | Conversation workbench: thinking stream, tool cards grouped per round (collapsible), real terminal, diff reports, task plan, multi-session grid view |

Both windows stay in sync — conversations, terminal, state.

---

## 🤖 Reliability engineering

- **Round-grouped timeline** — every agent round collapses into one summary line (`R3 · edit src/app.js · 5 steps · 23s`); screenshots and approvals stay visible.
- **Re-run from any message** — hover a user bubble, click ↻: the conversation is truncated before that message and the task re-runs verbatim.
- **Guardrails** — tool-argument schema validation, same-call loop breaking, failure-streak reflection, watchdog (stall + wall clock, suspended while a tool or approval is legitimately pending), 429 backoff per endpoint, orphaned-tool-result repair, context-overflow recovery in both main and sub-agent loops.
- **Observability** — decision log (why was this allowed/blocked), agent trace, per-conversation token/cost ledger, audit log.

---

## 🧪 Tests

```bash
npm run test:unit       # vitest, 1,316 tests in 72 files (sandbox, net-guard, SSE, Anthropic, sub-agents…)
npm run test:verify     # 55 probes on a live server (render, repo map, tools, agents, isolation…; 62 acceptance scripts under scripts/, desktop/UI ones run separately)
npm run smoke           # end-to-end loop with the demo engine
npm run test:nightly    # real-LLM nightly regression — no key means SKIP, which is NOT a pass
npm test                # full suite: unit + probes + smoke + integration/patch/lsp/code-index
```

CI runs lint → unit → probes → smoke → file ops on Windows (Node 24, matching `engines`). Of the 55 probes, 53 run to completion on the runner and 2 print `SKIP` — `_verify_computer` (UIA + screen capture) and `_verify_browser` (agent-browser driving a local Chrome/Edge) both need an interactive desktop session, which a CI runner does not have; `npm run verify:all` locally runs all 55 plus the Electron shell checks. A skipped probe is reported as skipped, not as a pass. A nightly workflow runs the real-LLM regression when `NIGHTLY_LLM_KEY` is configured — without it the nightly prints `RESULT: SKIP`, which is not a pass.

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

## 📄 License

[MIT](LICENSE)
