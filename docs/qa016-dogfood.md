# QA-016 real-duration dogfood evidence

Status: deterministic recorder and engineering-cycle runner implemented. `QA-016` and `REL-009`
remain open until a real 24-hour run on one exact retained artifact is independently reviewed.

## What this closes and what it does not

The quality matrix now binds the production transition-chaos adapter, real-daemon two-agent
SIGKILL recovery, provider disconnect behavior, selective lost-device revoke, and raw PTY
disconnect/resume to one reproducible command. Those are deterministic prerequisites for
`OPS-002`, `OPS-GATE`, `REM-GATE`, and `QA-016`; they are not elapsed real-provider or native-device
evidence.

`scripts/run-beta-dogfood.mjs` records a hash-chained, append-only observation ledger outside the
repository. It binds one clean exact commit, one retained tarball plus its package metadata,
checksum, source-identity, and reproducibility proof, every provider actually
claimed for the run, a minimum 24-hour duration, at least three retained real-work cycles, one
deterministic engineering cycle, and ordered daemon/provider/network interruption and recovery
evidence. The exact candidate must remain `HEAD` with no tracked changes at every record, cycle,
and verification boundary. Any source drift, changed artifact, metadata/checksum mismatch,
ledger/evidence tamper, future/non-monotonic timestamp, missing pair, or unresolved P0/P1 leaves
the result incomplete.

Even a complete ledger reports only `eligible_for_independent_review`, keeps
`qa016_closed: false`, and carries `release_authorized: false`. An independent reviewer must inspect
the copied evidence and exact artifact before the authoritative backlog may close `QA-016` or
`REL-009`.

## Runbook

Use a dedicated disposable Orchestra state directory and real work that does not expose secrets in
the retained observation files. The artifact path must point to the one `.tgz` in its retained
package directory beside `package-metadata.json` and `<filename>.sha256`. Start from the clean exact
candidate worktree with the supported Node/npm versions:

```sh
evidence_dir="$(mktemp -d /tmp/orchestra-qa016.XXXXXX)"
npm run quality:dogfood -- init \
  --output-dir "$evidence_dir/run" \
  --candidate-commit "$(git rev-parse HEAD)" \
  --artifact /absolute/path/to/the-retained-candidate.tgz \
  --providers codex
```

Run the deterministic interruption set at least once. It uses disposable test state and no real
credentials:

```sh
npm run quality:dogfood -- cycle --output-dir "$evidence_dir/run"
```

For each real work cycle and observed interruption, retain a privacy-reviewed log, screenshot, or
diagnostic file and record it. Event time is taken from the current process; callers cannot supply
it through the CLI.

```sh
npm run quality:dogfood -- record --output-dir "$evidence_dir/run" \
  --kind work_cycle_passed --provider codex --evidence /absolute/path/to/safe-work-cycle.json
npm run quality:dogfood -- record --output-dir "$evidence_dir/run" \
  --kind daemon_interrupted --evidence /absolute/path/to/safe-daemon-stop.json
npm run quality:dogfood -- record --output-dir "$evidence_dir/run" \
  --kind daemon_recovered --evidence /absolute/path/to/safe-daemon-recovery.json
npm run quality:dogfood -- record --output-dir "$evidence_dir/run" \
  --kind provider_interrupted --provider codex --evidence /absolute/path/to/safe-provider-stop.json
npm run quality:dogfood -- record --output-dir "$evidence_dir/run" \
  --kind provider_recovered --provider codex --evidence /absolute/path/to/safe-provider-recovery.json
npm run quality:dogfood -- record --output-dir "$evidence_dir/run" \
  --kind network_interrupted --evidence /absolute/path/to/safe-network-stop.json
npm run quality:dogfood -- record --output-dir "$evidence_dir/run" \
  --kind network_recovered --evidence /absolute/path/to/safe-network-recovery.json
```

Record incidents with a stable non-secret identifier; resolve them only with retained evidence:

```sh
npm run quality:dogfood -- record --output-dir "$evidence_dir/run" \
  --kind p1_opened --incident-id P1-001 --evidence /absolute/path/to/safe-incident.json
npm run quality:dogfood -- record --output-dir "$evidence_dir/run" \
  --kind p1_resolved --incident-id P1-001 --evidence /absolute/path/to/safe-fix-verification.json
```

After at least 24 hours, with the first work cycle recorded in the first hour and the last at or
after the duration boundary, verify:

```sh
npm run quality:dogfood -- verify --output-dir "$evidence_dir/run"
```

Retain the entire evidence directory beside the unchanged candidate artifact. Never retain raw
prompts, transcripts, PTY input/output, tokens, credentials, source files, or private device data.
