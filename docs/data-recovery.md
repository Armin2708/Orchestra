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
orchestra_state_root="${ORCHESTRA_HOME:-$HOME/.orchestra}"
orchestra_backup_path="/absolute/secure/path/orchestra.backup.db"

case "$orchestra_state_root" in /*) ;; *) echo 'ORCHESTRA_HOME must be absolute' >&2; exit 1;; esac
case "$orchestra_backup_path" in /*) ;; *) echo 'backup path must be absolute' >&2; exit 1;; esac
case "$orchestra_backup_path" in *"'"*) echo "backup path cannot contain a single quote" >&2; exit 1;; esac
if printf '%s%s' "$orchestra_state_root" "$orchestra_backup_path" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  echo 'state and backup paths cannot contain control characters' >&2
  exit 1
fi
test -f "$orchestra_state_root/orchestra.db"
test ! -e "$orchestra_backup_path"

sqlite3 "$orchestra_state_root/orchestra.db" ".backup '$orchestra_backup_path'"
sqlite3 "$orchestra_backup_path" 'PRAGMA integrity_check;'
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$orchestra_backup_path"       # macOS and many Linux hosts
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$orchestra_backup_path"           # GNU/Linux
else
  echo 'no SHA-256 utility found' >&2
  exit 1
fi
```

Do not run the snippet with an unset `HOME`, a relative/custom state root, a pre-existing backup
target, or a backup path containing control characters. Record the resolved state root before
stopping the daemon; do not assume a later shell has the same environment.

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
