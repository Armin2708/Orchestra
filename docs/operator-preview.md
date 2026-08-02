# Operator preview

Status: engineering preview; not a public release or plug-and-play installation.

## Scope

The current supported evaluation path is an already verified source checkout on one of the
observed environments in the [compatibility matrix](supported-environments.md). Public npm and
provider-plugin installation remain unavailable. Run the full readiness doctor before starting a
managed provider:

```sh
node dist/cli.js doctor --provider both
```

The normal daemon listens on `127.0.0.1`. `ORCHESTRA_HOME` selects its state root and defaults to
`~/.orchestra`. Use the same value for every command that must address one daemon; changing it
selects a different state directory.

## State inventory

The current source writes the following under `ORCHESTRA_HOME`:

| Path | Lifecycle and sensitivity |
| --- | --- |
| `orchestra.db` | Durable SQLite board, agent, message, delivery, Agent OS, usage-telemetry, push-subscription, and settings state. |
| `orchestra.db-wal`, `orchestra.db-shm` | SQLite WAL companion files while the database is active. They are part of a consistent live database state, not disposable logs. |
| `daemon.pid` | Ephemeral daemon process identifier; removed during a graceful shutdown. |
| `token` | Reusable master operator bearer. Owner-only when created; never attach or paste it into a report. |
| `agent-token` | Reusable credential scoped for managed-agent API access. Owner-only when created; never attach or paste it into a report. |
| `vapid-reference.json` | Owner-only opaque reference to the Web Push private key held by the platform credential store; it contains no private key bytes. |
| `sessions/*.json` | Claude hook session bindings, including a per-session bearer and local transcript path metadata. |
| `sessions/codex/*.json` | Codex hook session bindings with the same sensitivity boundary. |
| `sessions/**/*.tel` | Temporary local injected-context telemetry spool containing event names and character counts. |
| `sessions/**/*.throttle`, `sessions/**/*.nudged`, `sessions/**/*.stale` | Ephemeral hook throttle and reminder markers. |
| `remote.json` | Optional verified tunnel provider, public URL, process ownership fingerprint when applicable, and start time. |
| `cloudflared.log` | Optional Cloudflare quick-tunnel startup output. Treat it as sensitive operational data. |

SQLite stores local injected-context telemetry as event category, character/token estimate, count,
agent, board, and day. This is local product telemetry; the current product has no Orchestra-hosted
analytics receiver.

Workspaces and worktrees are deliberately outside `ORCHESTRA_HOME`. Legacy launched-card worktrees
use a sibling `<repo>-card-<id>` path. Canonical Agent OS worktrees default under a sibling
`<repo>-workspaces/` directory or an operator-selected path, with their locations recorded in
SQLite. Moving or retiring `ORCHESTRA_HOME` does not remove, archive, commit, or recover those
worktrees.

## Network and telemetry boundary

Local injected-context telemetry is not sent to an Orchestra service. It is distinct from the
Claude subscription-usage integration:

- The web Usage view requests the daemon's `/api/v1/system` endpoint on load and every 60 seconds.
- On a cache miss, the daemon reads the Claude Code OAuth credential from the macOS keychain or
  `~/.claude/.credentials.json` and sends it as a bearer to
  `https://api.anthropic.com/api/oauth/usage`.
- Claude limit auto-wake uses the same live usage check when limit-paused agents need scheduling.
- The in-memory result is cached for 60 seconds. The last successful usage payload is stored in
  `orchestra.db`; the OAuth credential is not stored there by this integration.

Managed provider runtimes make their normal provider network calls. Opt-in remote access and
notifications can also contact Tailscale, Cloudflare, Web Push endpoints, or `ntfy`.

## Backup, restore, and retirement

Hooks can auto-start the daemon on a later provider event, and `orchestra stop` signals the recorded
PID without waiting for process exit. Before moving or copying state:

1. Close or quiesce every Claude/Codex session that can still invoke Orchestra hooks.
2. Remove the applicable global hooks and every project-local hook, or keep all hook-producing
   sessions closed for the entire backup window.
3. Before stopping, read and retain the recorded daemon PID from the configured
   `ORCHESTRA_HOME/daemon.pid`; `orchestra stop` removes that file before shutdown is complete.
4. Stop verified remote access when it was used, then run `orchestra stop`.
5. Wait until that exact daemon process has exited. An unreachable `/health` endpoint alone is not
   sufficient because the listener can close before final provider-state persistence finishes.
6. Poll the configured loopback `/health` endpoint and proceed only after it remains unreachable.
   If it responds again, a hook restarted the daemon; do not move state.

Only after both the recorded process exit and persistent health-offline checks should the SQLite
state and its WAL companions be copied or moved.

For the default state root, a recoverable retirement is:

```sh
test -d "$HOME/.orchestra" &&
  test ! -e "$HOME/.orchestra.backup" &&
  mv "$HOME/.orchestra" "$HOME/.orchestra.backup"
```

Do not use that example if `ORCHESTRA_HOME` is customized. Confirm the exact configured source and
an explicit, absent backup destination first. Do not use a recursive delete as an uninstall step.

To restore the default state, keep the daemon stopped, confirm `~/.orchestra` is absent, and move
the backup directory back. A copied database without the WAL companions is not a verified backup.

Before retiring worktrees, run `git worktree list`, inspect each branch and status, and preserve or
commit work that has not been integrated. Hook removal does not manage worktrees. Keep provider
sessions and hooks quiesced until state has been restored or deliberately retired.

## Known preview boundaries

- Public package publication, provenance, clean-machine install/upgrade/uninstall, and
  credentialed-provider release journeys remain open gates.
- Remote access uses scoped DeviceSession pairing; read the [remote/mobile beta](remote-preview.md)
  and use the typed rollback command immediately for a lost device or suspected credential theft.
- Generate only the allowlisted redacted bundle with `orchestra ops diagnostics <new-file.json.gz>`;
  review the decoded contents before sharing as described in the [support preview](support-preview.md).
- A source checkout passing local tests is not, by itself, a release artifact.
