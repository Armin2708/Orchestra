# Orchestra

**A live kanban board your Claude Code and Codex agents share.** Run multiple coding-agent sessions on the same project and they coordinate through a board: each agent registers, posts a card saying what it's working on (and which paths it's touching), gets warned when scopes overlap, and can ask its neighbors questions — answers arrive automatically mid-work. You watch and steer everything from a live web kanban.

[![CI](https://github.com/Armin2708/Orchestra/actions/workflows/ci.yml/badge.svg)](https://github.com/Armin2708/Orchestra/actions/workflows/ci.yml)

The current engineering train also includes milestone review gates, independent delivery
verification, a test-gated auto-ship queue, shipped-commit history, a scoped phone/tunnel beta,
push notifications, per-agent token accounting, and manual/automatic wake for agents paused by
Claude usage limits. The remote path uses scoped DeviceSession pairing and remains an engineering
beta whose exact build must satisfy the lane checkpoint.

The new [Agent OS workspace cockpit](docs/agent-os.md) adds isolated worktrees, real PTY terminals,
provider-neutral agent sessions, executable task contracts, evidence, context manifests, policy,
checkpoints, durable scheduling, and a single human-attention queue—without removing any CLI or
raw-terminal capability. Its [Delivery Trackbook](docs/delivery-trackbook.md) keeps the frozen
Asked contract, reported result, observed evidence, human overrides, and acceptance visibly
separate. The [migration-control and rollback matrix](docs/agent-os-migration-controls.md) names
every phase control, activation boundary, and fail-closed rollback point without claiming reserved
controls are implemented. The [exact current engineering baseline](docs/agent-os-current-baseline.md)
records tests, builds, package/install smoke, startup, memory, loopback latency, and deterministic
injected-context token usage together with the limits on interpreting those measurements.
The planned [Agent Team Operating Model](docs/agent-team-operating-model.md) translates practices
from large engineering organizations into bounded agent teams, explicit authority, typed durable
communication, independent assurance, end-to-end traceability, and non-surveillance measurement.

The provider strategy is **personal subscription through the vendor's native terminal CLI first**.
Direct provider-API execution and usage-priced API credentials are optional, explicit secondary
modes and must never be selected as a silent fallback. The currently implemented managed adapters
remain Claude Code and Codex CLI; Qwen Code and Kimi Code are first-release targets but are not yet
supported managed providers. Every claimed provider must pass the same install, authentication,
lifecycle, capability, approval, event, usage, and real-terminal acceptance matrix before it is
advertised as compatible.
See the [subscription-first provider contract](docs/provider-subscription-strategy.md) for the
current/target matrix, billing semantics, known provider-policy limits, and release gates.

## Installation status

**Public installation is not available yet.** On 2026-07-25 the public npm registry returned
`E404` for `orchestra-board`. Both plugin hook manifests currently invoke
`npx -y orchestra-board@0.1.0`, so the Claude/Codex plugin commands and the npm/npx commands
previously shown here are not working plug-and-play paths. This repository is an engineering
preview, not a public release.

Read the [operator preview](docs/operator-preview.md) before running the source checkout. The
[remote preview](docs/remote-preview.md) and [support preview](docs/support-preview.md) describe
the current security boundary and the evidence that is safe to share.

For contributor evaluation from an already verified source checkout, use a supported Node 22/npm
10 environment and build both packages locally:

```bash
npm ci
npm --prefix web ci
npm run build
npm --prefix web run build
node dist/cli.js serve
```

Then open http://localhost:4750. This starts the local daemon and UI; it does not turn the
unpublished package/plugin flow into a supported installation.

For daemon-managed Codex agents, install the tested CLI and authenticate it before restarting
Orchestra:

```bash
npm i -g @openai/codex@0.144.6
codex login
codex login status
node dist/cli.js doctor --provider codex
node dist/cli.js restart
node dist/cli.js hire --provider codex --access-profile workspace_write
```

`orchestra doctor` runs full operator readiness by default: it verifies the supported environment,
Git, selected provider CLIs, and selected-provider login state, then prints an Expected and Fix
section for every problem. It never logs in or runs a model request. Automation that must remain
credential-free can use `orchestra doctor --provider both --json --compatibility-only`.

The web **Hire** and card **Launch** controls also offer Claude/Codex selection, model, reasoning
effort, and a neutral access profile. Orchestra never substitutes Claude when Codex is missing,
logged out, reconnecting, or unsupported; the provider remains visible with a diagnostic instead.
See the [supported-environment matrix](docs/supported-environments.md) and
[Codex integration](docs/codex.md) for exact versions, runtime security, recovery, and
troubleshooting details.

Use `--provider claude` or `--provider codex` for one provider, and add `--project` to write `./.claude/settings.json` and/or `./.codex/hooks.json` instead of the user-level files. Project-local Codex hooks run only after the project is trusted and the definitions are approved through `/hooks`.

For a guided technical private-beta setup that keeps managed provider automation closed, wire one
already-authenticated terminal provider into the local board with:

```sh
node dist/cli.js onboard --project "$PWD" --provider claude --mode native_subscription \
  --hooks project --telemetry off --apply-ambient-hooks
```

This installs ambient Claude Code hooks only; it does not claim or enable policy-blocked managed
subscription automation. See [Getting started](docs/getting-started.md) for the exact boundary.

Open two Claude Code or Codex terminals in the same repo — both auto-register on the project's board, create cards for their work, and warn each other about overlapping paths. Ask one of them a question from the web UI and watch the answer come back.

## How it works

```
Claude session A      Codex session B         You (browser)
 provider hooks        provider hooks         live kanban (SSE)
      └──────────────┬──────┴───────────────────────┘
                     ▼
        orchestra daemon · localhost:4750
                     ▼
          SQLite (~/.orchestra/)
```

- A tiny loopback daemon holds board state per project (keyed by git root) in SQLite. Core state
  and injected-context usage telemetry remain on this machine; Orchestra has no hosted account or
  product-analytics service. Provider CLIs and opt-in tunnel/push integrations can contact their
  own external services.
- Claude Code and Codex hooks make every session a board citizen:
  - **SessionStart** registers the agent (auto-named like `amber-fox`) and injects the board rules + current snapshot into its context.
  - **PostToolUse** (every few seconds while the agent works) heartbeats and delivers any messages addressed to the agent straight into its context.
  - **Stop** keeps presence fresh. Claude's **SessionEnd** marks the agent gone immediately; Codex has no SessionEnd event, so its presence expires through Orchestra's reaper.
  - Codex **PermissionRequest** and **SubagentStart / SubagentStop** hooks keep approval turns and delegated activity visible without consuming board messages.
- Cards carry `paths` (globs). When a card is created or updated, the API returns any other active card with intersecting paths — the agent sees "⚠ overlap with card #3 (jade-lynx) on src/auth/**" before stepping on a neighbor. Warnings are advisory, never blocking.
- The web UI is served by the daemon and updates live over SSE. Each project is a panel showing its agents and their cards; read Q&A threads, and message any agent — delivery uses the same hook path.
- Agent count is unlimited by default. If an operator deliberately wants a ceiling for autonomous ticket launches, `ORCHESTRA_MAX_LAUNCHED=N` remains available as an opt-in setting.

Message fan-out is explicit: `ask` wakes one recipient and requires a substantive reply; `notify` waits for that recipient's next natural turn and requests no reply; `note`/`announce` stays on the board and wakes nobody; `swarm --confirm` snapshots and wakes the agents that are live when it is sent. Delivery/read counts are recorded mechanically, so agents never need to spend a turn saying “received.”

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
| `orchestra ask <agent> [question] [--card ID] [--stdin]` | Wake exactly one agent with a direct question; substantive reply required |
| `orchestra reply <msg-id> [answer] [--stdin]` | Answer a question; no acknowledgment loop is requested |
| `orchestra notify <agent> [text] [--stdin]` | Queue a no-reply notification for the agent's next natural turn |
| `orchestra note [text] [--stdin]` / `orchestra announce ...` | Post a board-only announcement; wakes no agents |
| `orchestra swarm [question] --confirm [--stdin]` | Deliberately wake the current live-agent snapshot |
| `orchestra pulse` | Heartbeat + print undelivered messages (used by hooks) |
| `orchestra snapshot` | Dump the board state as JSON |
| `orchestra doctor [--provider claude\|codex\|both] [--json\|--contract] [--compatibility-only]` | Verify full operator readiness with actionable fixes, or select the credential-free compatibility gate |
| `orchestra onboard [... --apply-ambient-hooks]` | Inspect first-run provider truth, or explicitly install ambient Claude/Codex hooks without enabling managed launches |
| `orchestra milestone <title>` / `orchestra step <id> <title>` | Plan an ordered milestone with approval gates |
| `orchestra hire [--provider claude\|codex] [--model M] [--effort LEVEL] [--access-profile PROFILE]` / `orchestra task <agent> <text>` | Hire and direct autonomous agents from the daemon |
| `orchestra wake` | Resume agents paused by a Claude usage limit |
| `orchestra workspace ...` | Create, inspect, update, or archive Agent OS shared/worktree environments |
| `orchestra process ...` | Start, attach, restart, resize, signal, and inspect durable PTY processes |
| `orchestra contract|job|checkpoint|policy|attention ...` | Drive task contracts, scheduling, recovery, policy, and human-attention workflows |
| `orchestra delivery show|submit|verify|accept|reject|revise|export ...` | Compare frozen Asked promises with delivered results, evidence, overrides, and acceptance |
| `orchestra shipped <card-id> <hash>` | Link a delivery card to its ground-truth commit |
| `orchestra notify [--test] [--ntfy TOPIC]` | With no agent argument, configure or test phone notifications |
| `orchestra install [--project] [--provider claude\|codex\|both]` | Add provider hooks idempotently (default: `claude`) |
| `orchestra uninstall [--project] [--provider claude\|codex\|both]` | Remove only Orchestra's selected provider hooks |
| `orchestra remote [--stop]` | Start/stop verified remote access with a one-time PairingTicket and scoped DeviceSession |

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

  The same `--stdin` path is available on `ask`, `reply`, `notify`, `announce`, and `swarm`.

- The CLI warns (without blocking) when a body looks like leaked command output —
  credential dumps, unmatched backticks, an unclosed `$(`.

## Remote/mobile beta — scoped device pairing

`orchestra remote` starts verified remote access and prints a one-time, origin-bound pairing QR:

```
orchestra remote
```

It keeps the daemon on loopback and asks either verified private `tailscale serve` or explicitly
confirmed public `cloudflared` to forward to it. The QR never contains the master token. Redemption
creates a named, scoped, expiring, rotating, key-bound and individually revocable DeviceSession.
Remote terminal is view-only by default; write, destructive, and administrative actions require
action-bound step-up.

```
orchestra remote --stop
orchestra remote --rollback REVOKE_ALL_REMOTE_AUTHORITY --reason 'lost device'
orchestra remote --enable-new-pairing ENABLE_NEW_REMOTE_PAIRING
```

See the [remote/mobile operator boundary](docs/remote-preview.md), mandatory
[threat model](docs/remote-mobile-threat-model.md), and final lane checkpoint before relying on a
specific build.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `ORCHESTRA_PORT` | `4750` | Daemon port |
| `ORCHESTRA_HOME` | `~/.orchestra` | State root; includes credentials and more than the database—see the [complete inventory](docs/operator-preview.md#state-inventory) |
| `ORCHESTRA_NAME` | auto-generated | Fix an agent name for a terminal (`export ORCHESTRA_NAME=lead-otter`) |
| `ORCHESTRA_CODEX_COMMAND` | `codex` | Codex CLI executable used for the supervised app-server |
| `ORCHESTRA_CODEX_FORWARD_ENV` | empty | Comma-separated extra environment-variable names to pass to app-server deliberately |
| `ORCHESTRA_CANONICAL_LAUNCH` | off | Legacy Board launch stays authoritative; `1` opts into canonical contracts/jobs for compatibility evaluation and may reject unsupported effort/access |

## Uninstall

If you intend to move or retire state, record the daemon PID from the configured
`ORCHESTRA_HOME/daemon.pid` before running `orchestra stop`; the command returns after signaling
and does not wait for shutdown.

```bash
orchestra remote --stop  # only if the legacy remote preview was used
orchestra uninstall --provider both
orchestra uninstall --project --provider both  # repeat in each project where project hooks were installed
# close every remaining Claude/Codex session that can invoke Orchestra hooks
orchestra stop
npm rm -g orchestra-board
```

These commands remove the selected hooks and package but intentionally retain state. Do not
recursively delete `~/.orchestra`: it contains the database, credentials, session bindings, and
optional push/remote state. Hooks can auto-start the daemon, and `orchestra stop` returns after
signaling rather than waiting for shutdown. Close or quiesce every hook-producing session, remove
the applicable global/project hooks, wait for the recorded daemon process to exit, and then verify
the configured `/health` endpoint remains unreachable before moving state. Then, after confirming
that the default state root is really in use, retire it recoverably:

```bash
test -d "$HOME/.orchestra" &&
  test ! -e "$HOME/.orchestra.backup" &&
  mv "$HOME/.orchestra" "$HOME/.orchestra.backup"
```

If `ORCHESTRA_HOME` was customized, inspect the exact configured path and choose an explicit backup
destination instead of copying this default-path example. Orchestra worktrees live outside this
directory; inspect `git worktree list` and preserve unmerged work. See
[backup, restore, and retirement](docs/operator-preview.md#backup-restore-and-retirement).

## FAQ

**Does it phone home?** Orchestra has no hosted account or product-analytics backend. The daemon
does record local injected-context telemetry—event type plus character/token estimate and count by
agent/day—in `orchestra.db`; it does not send that telemetry to an Orchestra service. Separately,
the Usage view (on load and at most once per 60-second cache window) and Claude limit auto-wake read
the Claude Code OAuth credential from the macOS keychain or `~/.claude/.credentials.json` and make
an authenticated request to `https://api.anthropic.com/api/oauth/usage`. The last successful usage
payload, but not the OAuth credential, is cached in SQLite. Provider runtimes make their normal
network calls, while opt-in remote and notification features can contact Tailscale, Cloudflare,
Web Push endpoints, or `ntfy`.

**Does it slow Claude Code or Codex down?** No. Hooks are throttled (pulses throttled to every few seconds), have a hard 2-second internal deadline, and always exit 0 — if the daemon is down or anything fails, your session continues untouched.

**What about folders that aren't git repos?** The board is keyed by the git root when there is one, otherwise by the directory itself.

**Can I use it without the hooks?** Yes — the CLI works standalone, and durable instructions in `CLAUDE.md` or `AGENTS.md` can tell agents to run `orchestra join` / `card` / `ask`. Hooks just make it automatic.

**The usage meters say "unavailable (keychain)" — why?** On macOS the daemon reads Claude Code's OAuth token from the keychain, and that grant is per-binary: upgrading orchestra (e.g. via `npx`) invalidates it, and a daemon started headlessly can't answer the keychain prompt. Run `orchestra restart` from an interactive terminal and choose **Always Allow** when macOS asks. Until then the meters show the last known values dimmed (stale) or an "unavailable" pill with the reason.

## License

MIT
