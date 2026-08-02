# Troubleshooting Orchestra beta

Start with `orchestra doctor --provider <provider> --json`. Keep the exact source commit, package
version, platform, Node/npm versions, and the failing command. Do not paste environment dumps.

| Symptom | Safe checks | Resolution boundary |
| --- | --- | --- |
| Hook does not register a session | inspect only the selected provider's project/global hook file; run `orchestra install --project --provider <provider>` again | install/uninstall merges only Orchestra entries; never replace the whole provider config |
| Provider login not ready | run the provider's official status/login flow and `orchestra doctor`; verify the executable fingerprint/version | do not paste auth output or credentials; no provider/billing fallback |
| Unsupported provider/version | compare doctor output with `docs/supported-environments.md` | install the exact accepted version or remain blocked; an installed CLI is not a support claim |
| Port/listener failure | check the configured loopback port and one `/health` request; inspect ownership before changing a process | never kill an unrelated PID or use `--expose` as a repair |
| PTY is stuck | inspect process status/output cursor, then use documented interrupt/stop controls | preserve output and recovery identity; do not delete the worktree |
| Database locked | stop writers and hooks, wait for the exact daemon PID, preserve DB/WAL/SHM | do not delete WAL/SHM or copy only the main DB while live |
| Migration fails | preserve the database, exact commit and error; run integrity checks on a copy | no manual schema surgery or guessed identity; use a reviewed forward repair |
| Daemon restart loses work | inspect durable jobs, sessions, workspaces, attempts and attention | do not create a duplicate job until reconciliation proves the prior outcome |
| Remote device is lost | follow [remote-access-security.md](remote-access-security.md) | secure per-device revoke depends on Lane C; legacy preview requires master rotation |
| Browser looks stale | hard reload only after confirming API health and exact web build | do not clear credentialed storage until the recovery implications are understood |

For a report, use the diagnostics-backed workflow in [telemetry-support.md](telemetry-support.md).
If automatic redacted diagnostics are unavailable, follow [support-preview.md](support-preview.md)
and share no bundle.
