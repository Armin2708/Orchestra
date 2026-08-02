# Local data, backup, restore, reset, and migration

Status: operator contract for beta evaluation. It does not claim an automated backup command.

## Ownership and locations

`ORCHESTRA_HOME` defaults to `~/.orchestra`. It owns `onboarding.json`, the SQLite database and WAL/SHM companions,
operator and agent bearer files, push keys, provider hook-session bindings, local telemetry spools,
and optional legacy tunnel state. The complete inventory and sensitivity labels are in
[operator-preview.md](operator-preview.md).

Managed worktrees are intentionally outside `ORCHESTRA_HOME`. Their paths live in SQLite, but their
branches and dirty files remain Git/worktree state. A state-root backup does not back up worktrees;
removing hooks does not remove them.

## Verified backup

Backups are offline-consistent operations:

1. Quiesce every provider session capable of invoking hooks.
2. Remove or disable all relevant global and project hooks for the backup window.
3. Stop remote exposure, record the daemon PID, stop the daemon, and wait for that exact process to
   exit. Confirm the loopback health endpoint stays down.
4. Use SQLite `.backup`, not a live copy of only `orchestra.db`.
5. Record SHA-256, run `PRAGMA integrity_check`, and retain the exact application commit/version.
6. Inspect and separately preserve every worktree with `git worktree list` and `git status`.

```sh
HOME=/absolute/operator/home \
ORCHESTRA_HOME=/absolute/operator/home/.orchestra \
scripts/backup-orchestra-state.sh /absolute/secure/path/orchestra.backup.db
```

The executable script runs with `set -euo pipefail` and `umask 077` under Bash or Zsh. `HOME`, any
explicit `ORCHESTRA_HOME`, and the destination must be absolute. With `ORCHESTRA_HOME` unset, the
source is exactly `$HOME/.orchestra/orchestra.db`. It rejects symlinked source files, insecure backup
directories, existing outputs, quotes/control characters and partial tool results; creates new
directories as mode `700`; requires `PRAGMA integrity_check` to return exactly `ok`; supports macOS
`shasum` and GNU `sha256sum`; atomically commits no-clobber backup/checksum files; verifies their
checksums and mode `600`; and removes partial output after any failure.
Checksum selection is automatic; `ORCHESTRA_CHECKSUM_TOOL=shasum` or `sha256sum` may pin one of the
two validated implementations when both are installed.

Record the resolved state root before stopping the daemon; do not assume a later shell has the same
environment. Run the command from the exact retained source/artifact checkout so the reviewed script
is the one producing the backup.

Never paste a database, WAL/SHM file, bearer, provider session, transcript, or worktree content into
a support report.

## Restore and reset

Restore is explicit and offline. Preserve the failed state first, verify the selected backup and
its compatible application version, keep all writers stopped, restore into an absent target, run
foreign-key/integrity checks, and perform one controlled restart. Do not merge two state roots.

A safe reset is a recoverable retirement: with the daemon and hooks quiesced, move the entire state
root to a new absent backup path. Do not recursively delete it. Resetting state does not delete,
commit, archive, or recover external worktrees. Credentials and device sessions, once Lane C
exists, require their own revocation workflow.

## Migrations and downgrade

Schema migrations are idempotent, additive, and forward-only. Unknown or partial schemas fail
closed. Feature rollback does not run a down migration or delete canonical evidence. Downgrade is
allowed only by an explicitly compatible prior application against a verified copy, or by an
offline restore after accepting the loss of every post-backup write. See
[agent-os-forward-migrations.md](agent-os-forward-migrations.md) for the concrete DOM-017 contract.
