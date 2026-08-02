# Beta Lane D onboarding/docs/support integration handoff

Status: remediated isolated candidate. No PKG item is globally closed by this checkpoint; Lane B/C,
central CLI/package integration, retained-artifact lifecycle tests and final reconciliation remain.

## Isolated modules

- `src/first-run-onboarding.ts`: provider-manifest-backed safe plan, compatible owner-only config,
  immediately verified config writes, and explicit hook application.
- `src/first-run-cli.ts`: interactive `onboard` and safe `lifecycle-demo` registrars.
- `src/lifecycle-demo.ts`: real Board/WorkContract/publish and opt-in Job API sequence.
- `src/operator-contract.ts`: executable API/event/config/provider compatibility contract.
- `src/operator-telemetry.ts`: opt-in allowlisted redacted external envelope; no transport.
- `src/support-workflow.ts`: inert-until-verified diagnostics-manifest to support-case boundary.

## Central integration steps

The Lane D root owns these edits after reviewing Lane B/C seams:

1. Import `registerFirstRunCommands` in `src/cli.ts` and call it beside the Agent OS/doctor
   registrars with `{ api, demoLaunchGate }`. Build `demoLaunchGate` from the real readiness doctor
   and the exact accepted provider-matrix store; never inject a constant success stub.
2. Add the new modules and operator docs to the package `files` list if packaging uses an explicit
   allowlist; verify the retained tarball rather than rebuilding after release testing.
3. Let Lane B revise provider statuses and direct provider-API mode only from exact acceptance
   evidence. Do not remove current blockers merely because a CLI is installed.
4. Let Lane C connect secure DeviceSession onboarding and a real diagnostics generator. The support
   adapter requires a redaction attestation and must remain inert without it.
5. Keep external telemetry without a transport until explicit destination, consent, deletion and
   privacy review are approved.
6. Add help/onboarding links to the web UI only in the central App/navigation integration.

No authoritative backlog, north-star, release-note, launch-checklist or Vault status was changed by
this isolated slice.

## Owned PKG evidence

| Item | Isolated delivery | Remaining central/external dependency |
| --- | --- | --- |
| PKG-003 | interactive provider-manifest-backed wizard, project/mode/hook/security plan, explicit apply | root CLI registration; Lane B exact support and API runtime |
| PKG-006 | loopback, local-only, no-fallback, telemetry-off, isolated-worktree defaults with visible advanced controls | optional web entry point |
| PKG-007 | exact local-state/worktree inventory and offline backup/restore/reset/migration contract | Lane C automated backup/restore drill |
| PKG-011 | pairing, scope, tunnel and lost-device operator contract | Lane C DeviceSession implementation and tests |
| PKG-012 | hook/login/version/port/PTY/database/migration/restart/remote troubleshooting matrix | Lane C diagnostics command |
| PKG-013 | production HTTP/database lifecycle sample; provider launch remains explicit | accepted native provider for a real end-to-end run |
| PKG-014 | candidate v1 compatibility contract and explanatory API/event/config/provider/schema documentation | exhaustive generated inventory, drift enforcement and central publication remain open |
| PKG-015 | candidate upgrade/rollback notes and local fail-closed config/contract checks | retained-artifact clean install/upgrade/uninstall/data-preservation automation remains open |
| PKG-016 | opt-in, enum-only, runtime-validated redacted envelope with no registered transport | destination/privacy/deletion approval before transport |
| PKG-017 | verified redacted diagnostics-manifest support-case adapter and workflow | Lane C diagnostics bundle generation |

Focused verification on Node 22.20.0/npm 10.9.3 covers the new modules plus existing hook, doctor,
readiness, environment and provider-contract seams. Root/web typechecks and production builds pass.
Parallel complete-suite attempts overlapped other beta-lane Vitest runs and transiently failed two
different pre-existing process/worktree acceptance tests; both passed immediately in isolation.
The final integrator must run the authoritative complete parallel and one-worker suites after all
lane processes are drained. These candidate artifacts are evidence inputs, not backlog closure.

## P1 remediation evidence

- First-run apply rejects every plan blocker before any filesystem or hook side effect, requires a
  validated provider release and supported mode/hooks, validates the exact safe config schema, and
  restores the prior config bytes and mode if hook installation fails.
- Lifecycle launch requires a fresh readiness-doctor result plus an exact accepted native-provider
  attestation before its first API call. The sample scope must already exist inside the project, and
  repeated execution reuses the marked card/job instead of creating duplicates.
- Support-case preparation remains disabled without an injected bundle verifier. Its attestation is
  bound to the actual bundle SHA-256 and byte length, while metadata, filename, categories and
  credential patterns are checked at runtime.
- Backup instructions resolve an unset `ORCHESTRA_HOME` to `$HOME/.orchestra`, validate the resolved
  path and database before use, inventory `onboarding.json`, and document both macOS and GNU checksum
  commands.
- Node `22.20.0` and npm `10.9.3`: 19 focused tests and 207 adjacent onboarding/install/doctor/
  provider tests pass; root and web TypeScript/production builds pass. Final all-repository and
  retained-artifact verification remains owned by the central beta integrator.

## Residual P1 remediation evidence

- Provider hook installation now snapshots exact bytes/mode/nonexistence, takes an exclusive writer
  lock, writes through fsynced temporary files with before-rename CAS, verifies the committed file,
  and transactionally restores earlier provider files if a later provider fails. Failed onboarding
  restores only a recognized Orchestra hook mutation; an unrelated concurrent edit is preserved and
  reported for human reconciliation.
- Operator telemetry rejects boxed strings, custom coercion objects and nested objects. Every enum
  property must be an actual allowlisted string primitive, and the emitted envelope contains only
  the normalized primitive map.
- `scripts/backup-orchestra-state.sh` is an executable Bash/Zsh fail-fast workflow with absolute
  HOME/state/destination validation, restrictive modes, exact SQLite integrity, macOS/GNU checksum
  verification, atomic no-clobber output and failure cleanup. Central package integration must add
  this reviewed script to the retained artifact's explicit `files` allowlist.
- Lifecycle demo card/contract/job work is serialized by a deterministic exclusive mode-`600` lock
  under an absolute state root. A concurrent identical invocation fails before its first API call;
  canonical Job creation retains its durable server-side idempotency key.
- Node `22.20.0` and npm `10.9.3`: 35 focused tests and 221 adjacent onboarding/backup/install/
  doctor/provider tests pass; root and web TypeScript/production builds pass. The support adapter
  still requires Lane C's actual-byte verifier, and PKG-014/PKG-015 remain open as documented.

## Final trust-boundary remediation evidence

- First-run apply now reconstructs the complete plan from allowlisted safe identifiers and the
  immutable current provider manifest, requires deep equality, and only then evaluates readiness.
  Exact current candidate plans remain blocked; forged cleared-blocker Codex and Qwen plans and
  mutated runtime, billing, defaults or advanced controls fail before config or hook writes.
- Project hook files are physically contained below the selected project root. Global Claude and
  Codex files are physically contained below home or explicit `CODEX_HOME`. Every parent component
  is checked as a real directory, so `.claude`/`.codex` parent symlink escapes fail before a lock or
  target write.
- Multi-provider hook writes resolve and lock every target in deterministic path order before any
  snapshot. Locks remain held through commit or rollback; rollback uses exact ownership/CAS and
  refuses to overwrite unrelated edits. A contended later provider cannot cause a delayed rollback
  to undo a subsequent successful two-provider install.
- Lifecycle sample validation walks every physical path component and rejects parent or final
  symlinks before launch authorization or API mutation. On POSIX, committed hook/config renames,
  hook/config removals and lifecycle-lock create/remove operations `fsync` their containing
  directories; no Windows directory-metadata crash-durability claim is made.
- Node `22.20.0` and npm `10.9.3`: 38 focused tests and 224 adjacent onboarding/backup/install/
  doctor/provider tests pass. Root/web TypeScript and production builds, shell checks, staged secret
  scan and exact change-scope review are recorded at the final lane commit. The support adapter still
  requires Lane C's actual-byte verifier, and PKG-014/PKG-015 remain open as documented.
- The complete one-worker repository suite passes at 193 files/1,730 tests. The complete default-
  parallel run passed 192 files/1,729 tests and timed out only the 5-second DOM-019 compatibility-
  instrumentation case under scheduler pressure; that exact file then passed 19/19 in isolation.
  This isolated lane evidence does not replace the central integrator's drained-process, exact-head
  default-parallel and one-worker reruns after Lanes A-C are merged.
