# Changelog

## 0.1.0 — 2026-08-25

First public release on npm (`npx orchestra-board`).

- **Board core** — live kanban shared by Claude Code / Codex / Qwen sessions:
  agents register via hooks, post cards with path scopes, get overlap
  warnings, and message each other (ask/task/notify/announce/swarm) with
  answers injected mid-work.
- **Web UI** — multi-project canvas, Kanban / Roadmap / Funnel backlog views,
  Teams, Inbox, agent chat with image paste, per-agent terminals, working
  indicators, push notifications, PWA/mobile layout.
- **Agent OS** — isolated worktrees, real PTY terminals, provider-neutral
  sessions, task contracts with evidence, delivery trackbook, review gates,
  verification, test-gated auto-ship queue, shipped-commit history.
- **Operations** — daemon with SQLite state, SSE stream, capacity admission,
  reaper (stale agents, zombie sessions), scheduled wake, token accounting,
  memory/handoff, wiki auto-sync (graphify).
- **Remote** — scoped phone access via Tailscale or Cloudflare pairing
  tickets; per-device revocable sessions; threat-model-driven controls.
- **Projects** — operator-curated project list (folder-picker add, cascade
  delete); sessions in unregistered folders run untracked.
- **License** — FSL-1.1-ALv2 (Fair Source; converts to Apache-2.0 two years
  after each release). History through `fd4cd58` remains MIT.
