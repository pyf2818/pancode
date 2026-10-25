# Changelog

All notable changes to this project are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions are tagged on the relevant release commits.

## [3.7.0] - 2026-10

### Fixed
- **Sub-agents were inoperative with real LLMs**: the sub-agent loop read a non-existent `tc.args` field, so every tool call received empty arguments under a real model (unit mocks had drifted to the same wrong shape). Parsed the `{id, name, arguments}` contract instead, with parse errors fed back to the model.
- Concurrency: deep paths attributed work to the front-most conversation (`_currentConv` global); 17 call sites now resolve the executing conversation via AsyncLocalStorage, and `handleChat` restores the pointer guardedly on all exit paths.
- Watchdog no longer kills tasks waiting on approvals (default 20 min) or long test runs (up to 30 min); the wall-clock budget still applies.
- `llm.js` no longer concatenates re-sent tool names (`read_fileread_file`); patch `=======` separator now matches the exact line only; history trimming groups assistant/tool messages so orphaned tool results cannot reach the API.
- Auto-identity: with multiple local accounts (legacy probe leftovers) the newest one is issued silently instead of falling back to the login modal.

### Added
- Command sandbox runner (`server/sandbox.js`): `policy` (default, unchanged behavior) / `docker` (one-shot container, workspace-mounted, network off) / `wsl` / `auto` with graceful degradation.
- Anthropic native protocol (`server/llm-anthropic.js`): Messages API with thinking deltas, streamed `tool_use` assembly, prompt-caching breakpoints on system+tools, 429 backoff.
- Egress domain policy (`net.allowDomains` / `net.blockDomains`) enforced for `web_fetch` and browser navigation; connection-time IP pinning in net-guard (TOCTOU); CORS exact matching + Host header checks on HTTP and WS; docx preview href sanitizing; Electron `openExternal` scheme whitelist.
- Multi-account-safe silent identity (`/api/auth/auto`, loopback-only) — pancode starts with no login screen; MCP tools now go through the approval gate.
- Nightly real-LLM regression suite (`npm run test:nightly`, read-echo / sub-agent / apply-edit / compaction); CI revived with `package-lock.json`; VS Code extension scaffold (`ide/vscode`).
- Demo engine seeds an example project into an empty workspace at boot; demo rounds are numbered (R1…) like real runs.

### Changed
- `agent-llm.js` split: pure helpers moved to `server/agent-helpers.js` (28 exports, `_ctx` surface unchanged).
- Frontend: round-based collapsible timeline, multi-session grid view, Skills sidebar reduced to search + list, Trace panel empty state.

## [3.1.0 - 3.6.x]

UI and usability: theme library (light/dark each coherent), settings rebuilt as a full-screen workbench, single step-stream timeline with progress capsule, long-task reliability (heartbeat / approval timing / per-tool timeouts), one-screen model config, git commit & push, markdown rendering in a Worker, desktop icon & tray.

## [3.0.0]

Generation jump over v2.3.0: Plan Mode, MCP, LSP diagnostics, incremental semantic code index, per-hunk patch review, /undo checkpoints, multi-agent orchestration, Goal + workflow templates, session settlement memory, persistent conversations, command palette, onboarding, light/dark themes, i18n.
