# Upgrade and compatibility notes

Before upgrading, retain the exact current version/commit, create and restore-test an offline
SQLite backup, preserve worktrees separately, and keep provider hooks quiesced for the entire
database transition. Verify the target package digest and its declared Node/npm/platform/provider
matrix before starting it.

After upgrade:

1. run the operator-contract compatibility check;
2. validate `onboarding.json` schema 1;
3. start once and verify all migration markers, `PRAGMA foreign_key_check`, and
   `PRAGMA integrity_check`;
4. rerun `orchestra doctor` for each selected provider;
5. restart once and recheck jobs/sessions/workspaces before enabling new work; and
6. retain the old artifact and verified backup through the observation window.

Package rollback and data rollback are different. A compatible old package may run only against a
copy whose forward schema it explicitly supports. Never delete migration markers, columns,
canonical records or evidence to make a downgrade appear compatible. Restoring an older backup is
an offline recovery decision that discards later writes and must be explicit.

The first-run and provider compatibility checks fail closed on unknown major versions. Provider
readiness is re-evaluated after upgrade because executable provenance, login, billing and acceptance
evidence are exact-tuple facts, not durable assumptions.
