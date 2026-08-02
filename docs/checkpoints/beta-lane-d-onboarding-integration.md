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
