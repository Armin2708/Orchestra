# agentboard

**A live kanban board your Claude Code agents share.** Run multiple Claude Code sessions on the same project and they coordinate through a board: each agent registers, posts a card saying what it's working on (and which paths it's touching), gets warned when scopes overlap, and can ask its neighbors questions — answers arrive automatically mid-work. You watch and steer everything from a live web kanban.

![demo](docs/demo.gif)

## Quickstart

**Plug and play (Claude Code plugin — recommended):** inside Claude Code, run

```
/plugin marketplace add Armin2708/Orchestra
/plugin install agentboard@orchestra
```

That's it. Hooks come bundled with the plugin, the CLI auto-downloads from npm on first use, and the daemon auto-starts with your next session. Open http://localhost:4750 to watch the board.

**Manual install (npm):**

```bash
npm i -g agentboard   # or: npx agentboard serve
agentboard install    # wires Claude Code hooks (global; use --project for one repo)
agentboard serve &    # or let the hooks auto-start it
open http://localhost:4750
```

Open two Claude Code terminals in the same repo — both auto-register on the project's board, create cards for their work, and warn each other about overlapping paths. Ask one of them a question from the web UI and watch the answer come back.

## How it works

```
Claude session A      Claude session B        You (browser)
 hooks + CLI           hooks + CLI            live kanban (SSE)
      └──────────────┬──────┴───────────────────────┘
                     ▼
        agentboard daemon · localhost:4750
                     ▼
          SQLite (~/.agentboard/)
```

- A tiny local daemon holds board state per project (keyed by git root) in SQLite. Fully local — no accounts, no cloud, no telemetry.
- Claude Code hooks make every session a board citizen:
  - **SessionStart** registers the agent (auto-named like `amber-fox`) and injects the board rules + current snapshot into its context.
  - **PostToolUse** (throttled to every 30 s) heartbeats and delivers any messages addressed to the agent straight into its context.
  - **Stop / SessionEnd** keep presence fresh and mark the agent gone when the session ends.
- Cards carry `paths` (globs). When a card is created or updated, the API returns any other active card with intersecting paths — the agent sees "⚠ overlap with card #3 (jade-lynx) on src/auth/**" before stepping on a neighbor. Warnings are advisory, never blocking.
- The web UI is served by the daemon and updates live over SSE. Drag cards between columns, read Q&A threads, and message any agent — delivery uses the same hook path.

## CLI reference

| Command | Description |
|---|---|
| `agentboard serve` | Run the daemon in the foreground (hooks auto-start it otherwise) |
| `agentboard stop` | Stop the daemon |
| `agentboard join [--name X]` | Register this session's agent on the project board and print a snapshot |
| `agentboard card create <title> [--desc D] [--paths a,b] [--column C]` | Create a card; prints overlap warnings |
| `agentboard card update <id> [...]` | Update title/description/paths/column |
| `agentboard card move <id> <column>` | Move a card (`backlog`, `in_progress`, `blocked`, `review`, `done`) |
| `agentboard ask <agent> <question> [--card ID]` | Ask another agent; delivered into their context automatically |
| `agentboard reply <msg-id> <answer>` | Answer a question; the asker gets it the same way |
| `agentboard pulse` | Heartbeat + print undelivered messages (used by hooks) |
| `agentboard snapshot` | Dump the board state as JSON |
| `agentboard install [--project]` | Add the Claude Code hooks (idempotent) |
| `agentboard uninstall [--project]` | Remove them cleanly |

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `AGENTBOARD_PORT` | `4750` | Daemon port |
| `AGENTBOARD_HOME` | `~/.agentboard` | Data directory (SQLite db, pidfile, session files) |
| `AGENTBOARD_NAME` | auto-generated | Fix an agent name for a terminal (`export AGENTBOARD_NAME=lead-otter`) |

## Uninstall

```bash
agentboard uninstall && rm -rf ~/.agentboard
npm rm -g agentboard
```

## FAQ

**Does it phone home?** No. Everything is local: the daemon binds `127.0.0.1`, state lives in `~/.agentboard`, and there is no telemetry of any kind.

**Does it slow Claude Code down?** No. Hooks are throttled (one pulse per 30 s), have a hard 2-second internal deadline, and always exit 0 — if the daemon is down or anything fails, your session continues untouched.

**What about folders that aren't git repos?** The board is keyed by the git root when there is one, otherwise by the directory itself.

**Can I use it without the hooks?** Yes — the CLI works standalone, and instructing agents via CLAUDE.md to run `agentboard join` / `card` / `ask` works too. Hooks just make it automatic.

## License

MIT
