# Changelog

## 0.3.0 — 2026-09-01

- **OpenCode as a 4th agent provider** (candidate tier, same honesty level Qwen
  sits at — not yet through the full acceptance harness). Driven via
  `opencode serve` + `@opencode-ai/sdk` as one shared, daemon-wide server
  process, directory-scoped per call, with real per-turn usage. Live model
  catalog (whichever upstream providers you've configured in OpenCode, no
  hardcoded list); managed/background launch stays fail-closed until
  OpenCode's own terms on autonomous use are confirmed.
- **TUI: Board tab lists agents**, not raw cards — name, status, and current
  card+column at a glance; click/enter an agent for a detail view (status,
  project, last seen, capabilities, current card). Long text now wraps to
  the terminal's width and height instead of being truncated.
- **Codex reliability fixes**: orchestra's own "update available" prompt used
  to tell you to `npm install --global @openai/codex@latest`, walking you
  straight off the protocol-pinned CLI version — it no longer does that.
  Version drift is now re-checked live (not just at daemon boot) and
  surfaces as an inbox mail instead of a silent failure. Codex also no
  longer hard-blocks on an unpinned CLI version — it runs on whatever is
  installed and flags health as "unverified" instead, so a real (if
  unverified) Codex update never leaves you stuck; `orchestra doctor` still
  reports the true validated/unsupported status honestly.
- **Daemon/cloud hard split** — the cloud dashboard and hub service now live
  only in their own repos (`orchestra-cloud-dashboard`, `orchestra-cloud-api`);
  the in-repo cloud bundle (cloud.html, HubApp/HubBoard/hubApi, billing,
  Clerk) is removed from this repo entirely. `src/hub/` stays here only as
  the org-sync e2e dev source, now with a mandatory mirror script
  (`scripts/sync-hub-to-cloud-api.sh`) for any change to it.

## 0.2.0 — 2026-08-31

- **Interactive terminal session** — bare `orchestra` at a TTY now opens a
  full-screen app in the alternate screen buffer: a Home landing with the
  ORCHESTRA wordmark, an animated pet, and simple status; the board list
  behind a Board tab (with inbox); a Logs tab with a timestamped session
  event stream. Arrow/j-k navigation, mouse clicks, live refresh, and the
  terminal is restored on every exit path. Non-TTY invocations and all
  subcommands are byte-for-byte unchanged.
- **Cloud connect that heals itself** — pressing ⏎ on the Home tab runs the
  browser sign-in when needed, then plays a hyperspace jump until the sync
  stream reports live. Root fix underneath: an edge proxy killing the SSE
  stream mid-read (undici's `TypeError: terminated`) is now retryable
  instead of parking org-sync in a permanent `terminal` state, and
  `POST /api/v1/org/reconnect` (operator-only) relaunches a stuck loop
  without a daemon restart.
- **Soft cloud disconnect** — `orchestra org pause` / `orchestra org resume`
  (or `d` in the session): stay joined but stop syncing, keeping cursor and
  outbox, persisted across daemon restarts. Distinct from `org leave`.
- **CLI color pass** — accent ids, per-column hues, dimmed metadata across
  snapshot, card, mail, and team output. TTY-only: piped output (agents,
  hooks, scripts) stays exactly as before; `NO_COLOR` honored.
- **Hardening** — board-sourced text is scrubbed of terminal escape
  sequences before rendering; the reconnect/pause routes require operator
  authorization.
- **Org collaboration** — the hosted org board becomes a real shared
  workspace: card moves, edits, claims, and milestone changes now sync
  BOTH ways between every connected machine (optimistic versioning,
  first-claim-wins, echo-suppressed); agents on different machines can
  mail each other (`orchestra ask <agent>` on the org board — delivery
  lands on the recipient's own board); shared milestones with per-card
  linkage and a progress strip on the cloud board; presence now reports
  which card an agent is working on. `orchestra org board` prints the
  local board that mirrors the organization. Personal boards still never
  sync (verified end-to-end).

## 0.1.1 — 2026-08-26

- **`orchestra demo`** — seed a sample board (agents, overlap warning,
  agent-to-agent Q&A, review card) to explore without live sessions.
- **`orchestra project add [path]`** — register a project from the CLI;
  projects are operator-curated (sessions in unregistered folders run
  untracked instead of auto-creating boards). The board UI adds a folder
  picker for the same, plus per-project delete with full cascade.
- Chat image paste fixes (clipboard type captured synchronously), kanban
  card drawer + drag-to-done, zombie-session reaping freeing launch
  capacity, launch-throttle diagnostics.
- CI: all 23 release-evidence gates green (first passing run); community
  files (SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, templates); dependency
  audits clean.

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
