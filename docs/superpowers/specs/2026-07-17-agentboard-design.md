# agentboard — Design Spec

**Date:** 2026-07-17
**Status:** Approved direction (interactive brainstorm 2026-07-17)
**Goal:** A publicly distributable coordination tool: a live kanban board per project where Claude Code agents (across many terminal sessions) register, publish what they're working on, avoid overlapping work, and ping each other questions — visualized and steerable by the human in a web UI.

---

## 1. Product summary

Multiple Claude Code sessions on one machine work on the same project with no awareness of each other. agentboard gives them a shared board:

- Every session auto-registers as a named agent (hooks) and is told the board rules.
- Agents create a card describing scope before starting, and keep it updated.
- Card scopes carry file paths; the API warns when scopes intersect ("neighbor X is on `src/auth/`").
- Agents ask each other questions ("pings"); delivery is push-style via hook injection into the target's context.
- The human watches and participates through a live web kanban.

Distribution target: `npx agentboard` + one install command for hooks. Anyone with Claude Code can adopt it in under a minute.

## 2. Architecture

One local daemon, three thin clients over the same REST API.

```
┌────────────┐   ┌────────────┐   ┌───────────────┐
│ Claude Code │   │ Claude Code │   │  Human (web)  │
│  session A  │   │  session B  │   │  React UI     │
│ hooks + CLI │   │ hooks + CLI │   │  (SSE live)   │
└─────┬──────┘   └─────┬──────┘   └──────┬────────┘
      │  HTTP           │ HTTP            │ HTTP + SSE
      └────────────┬────┴─────────────────┘
                   ▼
        agentboard daemon (Node/TS, Fastify)
        localhost:4750 · auto-started, single instance
                   │
                   ▼
        SQLite (~/.agentboard/agentboard.db)
```

- **Daemon** (`agentboard serve`, auto-spawned by CLI/hooks if not running): Fastify + better-sqlite3. Single-writer SQLite avoids concurrency issues from many agents. Serves the built web UI statically and pushes live updates via SSE.
- **CLI** (`agentboard <cmd>`): thin HTTP client, used by agents (Bash) and humans. Auto-detects project (git root) and agent identity (env `AGENTBOARD_AGENT` set by SessionStart hook).
- **Hooks**: shipped as a Claude Code plugin; shell scripts calling the CLI. No daemon logic in hooks.
- **Web UI**: React + Vite, served by daemon at `http://localhost:4750`. SSE stream per board.

### Auto-start & liveness
- CLI/hook calls try the port; on connection failure, spawn `agentboard serve --daemonize` (lockfile + pidfile in `~/.agentboard/`), retry with short backoff.
- Daemon idles indefinitely; footprint is negligible. `agentboard stop` to kill.

## 3. Data model (SQLite)

- **boards** — id, project_path (git root, unique), name, created_at.
- **agents** — id, board_id, name (e.g. `crimson-otter`), session_id, status (`active | idle | gone`), last_seen, created_at. Heartbeat from throttled PreToolUse hook; reaper marks `idle` after 5 min silence, `gone` after SessionEnd or 30 min.
- **cards** — id, board_id, title, description (scope of work), column (`backlog | in_progress | blocked | review | done`), owner_agent_id, paths (JSON array of globs/paths in scope), created_at, updated_at.
- **card_events** — id, card_id, agent_id (nullable = human), type (`created | updated | moved | comment`), payload JSON, created_at. Powers the activity feed.
- **messages** — id, board_id, from_agent_id (nullable = human), to_agent_id (nullable = broadcast/human), card_id (nullable context), body, reply_to (nullable), delivered_at (nullable), created_at. A question is a message; an answer is a message with `reply_to`.

Columns are fixed (the five above) — agents and hooks rely on known states.

## 4. API surface (REST, JSON)

Base: `http://localhost:4750/api`

- `POST /boards/resolve` `{project_path}` → board (create-on-first-use)
- `POST /agents/register` `{board, session_id, name?}` → agent (name auto-generated if absent)
- `POST /agents/:id/heartbeat`
- `GET  /boards/:id/snapshot` → agents + cards + unanswered questions (used by SessionStart injection)
- `POST /cards` / `PATCH /cards/:id` / `POST /cards/:id/move` — create/update/move. **Create/update responses include `overlaps`: other active cards whose `paths` intersect.**
- `POST /messages` (ask/reply/broadcast) · `GET /agents/:id/inbox?undelivered=1` · `POST /messages/:id/delivered`
- `GET /boards/:id/events` — SSE stream (card/agent/message events) for the web UI.

Overlap check: path-prefix and glob intersection (e.g. `src/auth/**` ∩ `src/auth/login.ts`). Advisory only — a warning, never a lock.

## 5. Agent lifecycle (Claude Code plugin)

Shipped as a plugin (`hooks/` + a small skill telling agents board etiquette).

- **SessionStart** — `agentboard join` → registers agent, exports `AGENTBOARD_AGENT`, prints (as additionalContext): board rules, current snapshot (who's active, their cards/paths), and any questions addressed to this agent's prior identity.
  Rules injected: *create a card with scope+paths before starting work; update column/description as you go; check the snapshot before touching files another card claims; use `agentboard ask` when blocked on a neighbor.*
- **PreToolUse** (throttled to ≥30 s via timestamp file) — `agentboard pulse`: heartbeat + fetch undelivered inbox; if messages exist, emit them as hook output so they're injected mid-work; mark delivered.
- **Stop** — mark agent `idle`; nudge (once) if agent has an `in_progress` card untouched this session ("update or move your card").
- **SessionEnd** — mark `gone`; card stays, flagged stale on the board.

Env override `AGENTBOARD_NAME` lets users name agents per terminal.

## 6. Ping / Q&A flow

1. Agent A: `agentboard ask crimson-otter "are you changing the auth middleware signature?"` (optionally `--card 12`).
2. Stored as message; web UI shows it on the board (unanswered badge).
3. Agent B's next PreToolUse pulse delivers it into B's context; B replies: `agentboard reply <msg-id> "yes, merging tonight — hold off"`.
4. A receives the reply the same way. Human can ask/answer anyone from the UI; delivery identical.

Broadcast supported (`--all`) for "I'm about to rebase main"-style announcements.

## 7. Web UI

- Kanban with the five fixed columns; drag to move (writes via API, so an agent sees the move in its next snapshot/pulse).
- Agent sidebar: live status dots (active/idle/gone), current card, last seen.
- Card detail drawer: description, paths, activity feed, Q&A thread inline.
- Board switcher (daemon serves all projects).
- Unanswered-question badges; toast on new events. SSE-driven, no polling.
- Stack: React + Vite + minimal deps; built assets embedded in the npm package.

## 8. Distribution & go-to-market

**Packaging**
- npm package `agentboard` (bin: daemon + CLI, ships built web UI). `npx agentboard` = zero-install run.
- `agentboard install` — writes hook config: detects `~/.claude/settings.json` (global) or project `.claude/settings.json`, merges hooks idempotently; `agentboard uninstall` reverses. Also installable as a Claude Code plugin from a marketplace repo.

**Launch checklist**
1. Public GitHub repo (MIT), README with 30-second quickstart + demo GIF/video of 3 terminals coordinating.
2. Docs site (README-first; docs/ for hook internals, API, FAQ).
3. Publish to npm; tag v0.1.0; CI (GitHub Actions: lint, test, build, publish on tag).
4. Claude Code plugin marketplace listing (plugin repo with `.claude-plugin/marketplace.json`).
5. Launch posts: X/Twitter thread with demo video, r/ClaudeAI, Hacker News (Show HN), Anthropic Discord.
6. Telemetry: none in v1 (adoption trust); GitHub stars/issues as signal.

**Adoption-critical qualities**
- One-command install, zero config, works offline, no accounts.
- Uninstall is clean (hooks removed, one dir to delete).
- Fails soft: if daemon is unreachable, hooks exit 0 silently — never break a Claude session.

## 9. Error handling & edge cases

- Hook scripts: hard 2 s timeout, always exit 0; agentboard must never block or break a session.
- Port conflict: configurable via `AGENTBOARD_PORT`; lockfile prevents double daemons.
- Multiple agents in one project editing the board concurrently: SQLite WAL + single daemon writer.
- Non-git directories: board keyed by cwd realpath.
- Stale agents/cards: reaper + UI staleness flags; human can reassign/close cards.
- Version skew (old hooks vs new daemon): API versioned (`/api/v1`), daemon answers `GET /health` with version.

## 10. Testing

- **Unit (Vitest):** overlap/glob intersection, name generator, reaper transitions, message delivery state machine.
- **API integration:** Fastify inject tests over a temp SQLite db — full card/message/agent lifecycle.
- **Hook tests:** run hook scripts against a test daemon; assert injected output format and the exit-0/never-block guarantee.
- **E2E (manual gate):** two real Claude Code sessions + web UI; scripted scenario: register → cards → overlap warning → ask/reply → done.

## 11. Milestones

1. **M1 Core:** daemon + SQLite + API + CLI (join/card/ask/reply/pulse) + tests.
2. **M2 Hooks:** plugin scripts, install/uninstall, never-break guarantee, E2E with real sessions.
3. **M3 Web UI:** live board, Q&A, agent sidebar.
4. **M4 Ship:** packaging, CI, README/demo, npm publish, plugin listing, launch posts.

## Out of scope (v1)

Cross-machine/team sync, auth, cloud hosting, custom columns, task assignment automation, non-Claude-Code agents (API is generic enough to add later), telemetry.
