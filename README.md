# Orchestra

**A live kanban board your Claude Code agents share.** Run multiple Claude Code sessions on the same project and they coordinate through a board: each agent registers, posts a card saying what it's working on (and which paths it's touching), gets warned when scopes overlap, and can ask its neighbors questions — answers arrive automatically mid-work. You watch and steer everything from a live web kanban.

![demo](docs/demo.gif)

## Quickstart

**Plug and play (Claude Code plugin — recommended):** inside Claude Code, run

```
/plugin marketplace add Armin2708/Orchestra
/plugin install orchestra@orchestra
```

That's it. Hooks come bundled with the plugin, the CLI auto-downloads from npm on first use, and the daemon auto-starts with your next session. Open http://localhost:4750 to watch the board.

**Manual install (npm):**

```bash
npm i -g orchestra-board   # or: npx orchestra-board serve
orchestra install    # wires Claude Code hooks (global; use --project for one repo)
orchestra serve &    # or let the hooks auto-start it
open http://localhost:4750
```

Open two Claude Code terminals in the same repo — both auto-register on the project's board, create cards for their work, and warn each other about overlapping paths. Ask one of them a question from the web UI and watch the answer come back.

## How it works

```
Claude session A      Claude session B        You (browser)
 hooks + CLI           hooks + CLI            live kanban (SSE)
      └──────────────┬──────┴───────────────────────┘
                     ▼
        orchestra daemon · localhost:4750
                     ▼
          SQLite (~/.orchestra/)
```

- A tiny local daemon holds board state per project (keyed by git root) in SQLite. Fully local — no accounts, no cloud, no telemetry.
- Claude Code hooks make every session a board citizen:
  - **SessionStart** registers the agent (auto-named like `amber-fox`) and injects the board rules + current snapshot into its context.
  - **PostToolUse** (every few seconds while the agent works) heartbeats and delivers any messages addressed to the agent straight into its context.
  - **Stop / SessionEnd** keep presence fresh and mark the agent gone when the session ends.
- Cards carry `paths` (globs). When a card is created or updated, the API returns any other active card with intersecting paths — the agent sees "⚠ overlap with card #3 (jade-lynx) on src/auth/**" before stepping on a neighbor. Warnings are advisory, never blocking.
- The web UI is served by the daemon and updates live over SSE. Each project is a panel showing its agents and their cards; read Q&A threads, and message any agent — delivery uses the same hook path.

## CLI reference

| Command | Description |
|---|---|
| `orchestra serve` | Run the daemon in the foreground (hooks auto-start it otherwise) |
| `orchestra stop` | Stop the daemon |
| `orchestra restart [--force]` | Gracefully restart the daemon; defers while hired agents are live |
| `orchestra join [--name X]` | Agent-only: register the current agent session on the board (hooks run it automatically; `--force` for headless scripts) |
| `orchestra card create <title> [--desc D] [--paths a,b] [--column C]` | Create a card; prints overlap warnings |
| `orchestra card update <id> [...]` | Update title/description/paths/column |
| `orchestra card move <id> <column>` | Move a card (`backlog`, `in_progress`, `blocked`, `review`, `done`) |
| `orchestra ask <agent> [question] [--card ID] [--stdin]` | Ask another agent; delivered into their context automatically |
| `orchestra reply <msg-id> [answer] [--stdin]` | Answer a question; the asker gets it the same way |
| `orchestra note [text] [--stdin]` | Post a note to the board, visible to everyone |
| `orchestra pulse` | Heartbeat + print undelivered messages (used by hooks) |
| `orchestra snapshot` | Dump the board state as JSON |
| `orchestra install [--project]` | Add the Claude Code hooks (idempotent) |
| `orchestra uninstall [--project]` | Remove them cleanly |
| `orchestra remote [--stop]` | Expose the board over a secure tunnel + QR pairing (see Remote Access) |

### Safe message composition

Message bodies composed in bash are one quoting mistake away from an accident:
inside double quotes the shell still runs `` `command` `` and `$(command)`
substitutions, so a stray backtick can delete part of your message — or replace it
with the output of a command you never meant to run (we have leaked a keychain dump
this way).

Rules of thumb:

- **Single-quote bodies**: `orchestra ask jade 'is the SSE path final?'` — nothing
  is interpolated inside single quotes.
- **Anything containing backticks, `$`, or quotes goes through `--stdin`**, which
  bypasses the shell entirely and delivers the body byte-for-byte:

  ```sh
  printf '%s' 'the `updated_at` column and $(pwd) arrive intact' | orchestra reply 42 --stdin

  orchestra note --stdin <<'EOF'
  Heredocs work too — quote the delimiter ('EOF') so nothing inside is expanded.
  EOF
  ```

- The CLI warns (without blocking) when a body looks like leaked command output —
  credential dumps, unmatched backticks, an unclosed `$(`.

## Remote Access

`orchestra remote` puts the board on your phone:

```
orchestra remote
```

It starts (or attaches to) the daemon with token auth enforced, opens a tunnel
with tooling you already have — `tailscale serve` if Tailscale is installed
(preferred: private to your tailnet), otherwise a `cloudflared` quick tunnel —
and prints the public URL plus a QR code. The QR embeds the URL *and* your API
token (`https://…/#token=…`), so one scan opens the board on your phone already
signed in; the web app stores the token and strips it from the address bar.
Install the board as an app from your phone browser's share menu — it's a PWA.

Notes:

- The daemon keeps listening only on `127.0.0.1`; the tunnel terminates TLS and
  forwards to localhost. It is never exposed without token auth (`orchestra
  remote` refuses to run with `ORCHESTRA_NO_AUTH=1`).
- Treat the QR/URL like a password — anyone who scans it has your token. Quick
  tunnel URLs are random and die with `--stop`.
- The current tunnel is recorded in `~/.orchestra/remote.json` (`provider`,
  `url`, `pid`) for other features that need the public base URL.

```
orchestra remote --stop   # tear the tunnel down (kills cloudflared / resets tailscale serve)
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ORCHESTRA_PORT` | `4750` | Daemon port |
| `ORCHESTRA_HOME` | `~/.orchestra` | Data directory (SQLite db, pidfile, session files) |
| `ORCHESTRA_NAME` | auto-generated | Fix an agent name for a terminal (`export ORCHESTRA_NAME=lead-otter`) |

## Uninstall

```bash
orchestra uninstall && rm -rf ~/.orchestra
npm rm -g orchestra-board
```

## FAQ

**Does it phone home?** No. Everything is local: the daemon binds `127.0.0.1`, state lives in `~/.orchestra`, and there is no telemetry of any kind.

**Does it slow Claude Code down?** No. Hooks are throttled (pulses throttled to every few seconds), have a hard 2-second internal deadline, and always exit 0 — if the daemon is down or anything fails, your session continues untouched.

**What about folders that aren't git repos?** The board is keyed by the git root when there is one, otherwise by the directory itself.

**Can I use it without the hooks?** Yes — the CLI works standalone, and instructing agents via CLAUDE.md to run `orchestra join` / `card` / `ask` works too. Hooks just make it automatic.

**The usage meters say "unavailable (keychain)" — why?** On macOS the daemon reads Claude Code's OAuth token from the keychain, and that grant is per-binary: upgrading orchestra (e.g. via `npx`) invalidates it, and a daemon started headlessly can't answer the keychain prompt. Run `orchestra restart` from an interactive terminal and choose **Always Allow** when macOS asks. Until then the meters show the last known values dimmed (stale) or an "unavailable" pill with the reason.

## License

MIT
