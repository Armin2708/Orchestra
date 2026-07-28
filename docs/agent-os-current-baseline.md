# Agent OS Current Engineering Baseline

Status: **capture harness implemented; exact snapshot pending the harness commit**. This document
describes BASE-008's measurement boundary. It is not a release SLO, public-install proof, provider
acceptance matrix, or cross-machine performance claim.

## Measurement contract

`npm run baseline:agent-os` owns two commands:

```sh
npm run baseline:agent-os -- capture \
  --output /absolute/path/to/baseline.json \
  --source-commit <full-clean-HEAD-sha>

npm run baseline:agent-os -- validate \
  --input /absolute/path/to/baseline.json
```

Capture refuses a non-exact SHA, tracked source changes, pre-existing output, project `.env` files,
or an invalid final schema. The eventual source-controlled JSON is generated only after this
harness is committed and verified, so the measured commit contains the measurement code.

## Included evidence

- default-parallel and one-worker Vitest totals and wall time;
- root/web strict TypeScript and production-build wall time;
- root/web production artifact file count, byte count, and canonical SHA-256;
- real `npm pack` plus local tarball install/CLI smoke, size, file count, integrity, and digest;
- three disposable loopback cold starts with readiness, resident/virtual memory, 100 warm health
  requests per run, and graceful shutdown evidence;
- deterministic verbose/compact Orchestra-injected context characters/tokens, reduction, and
  compliance gates.

## Isolation and interpretation

- Package operations use an empty npm user configuration and disposable cache.
- Daemon runs use disposable `ORCHESTRA_HOME` directories, loopback only, auth disabled only for
  that loopback process, and an intentionally unavailable Codex command.
- No provider login, provider-native turn, credential, transcript, or raw terminal content enters
  the snapshot.
- Provider-native completion tokens are explicitly excluded because a deterministic,
  credential-free run cannot produce them. TOOL-014 remains the real-provider evidence gate.
- Measurements describe one host at one exact commit. They establish a reproducible comparison
  point; they are not budgets, guarantees, or release thresholds.
