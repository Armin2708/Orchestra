# Agent OS Current Engineering Baseline

Status: **BASE-008 observed at exact clean commit
`51b168d96becccd4aa3506dec9e80fcebda43ed7`**. The machine-readable evidence is
[agent-os-current-baseline.json](./agent-os-current-baseline.json). These measurements are a
single-host engineering comparison point, not release SLOs, public-install proof, provider
acceptance, or cross-machine performance guarantees.

## Exact source and host

| Field | Observed value |
|---|---|
| Captured | 2026-07-28 20:21:54 UTC |
| Source commit | `51b168d96becccd4aa3506dec9e80fcebda43ed7` |
| Source tree | `50cb9c7c9062bf3f25701a6dff66fee3d34befd0` |
| Source state | tracked clean before and after capture; no project environment files present |
| Host | Darwin 25.5.0, arm64, 12 logical CPUs, 24 GiB physical memory |
| Toolchain | Node 22.20.0; npm 10.9.3 |
| Dependency lock | SHA-256 `d78a8c7ac1d32829c56ce5355fde3c13048eed89b1214e12855c0d4c435ee2ac` |

## Test and build baseline

| Gate | Result | Wall time | Output |
|---|---:|---:|---|
| Default-parallel Vitest | 146 / 146 files; 1,199 / 1,199 tests | 22,483.430 ms | 0 failures, pending, or todo |
| One-worker Vitest | 146 / 146 files; 1,199 / 1,199 tests | 87,722.114 ms | 0 failures, pending, or todo |
| Root strict TypeScript | PASS | 384.853 ms | `npx tsc --noEmit` |
| Root production build | PASS | 659.222 ms | 1 file; 1,807,439 bytes; SHA-256 `6881d1b529ca37e1af0090d23e940c76d0d109512c5369916bed603cccc336a0` |
| Web strict TypeScript | PASS | 1,885.060 ms | `cd web && npx tsc --noEmit` |
| Web production build | PASS | 1,266.020 ms | 16 files; 995,285 bytes; SHA-256 `aad9b5e71d10eb5cbda816870ecdbfaca30fa9f3c6d088d4f4451e5ea4a4669a` |

Wall times are descriptive observations from this host. The artifact digests are canonical
summaries of relative path, byte count, and file SHA-256, not just directory timestamps.

## Package baseline

The real package/install smoke and an independent `npm pack --dry-run --ignore-scripts --json`
inventory agreed:

| Field | Observed value |
|---|---:|
| Package | `orchestra-board@0.1.0` |
| Packed bytes | 680,660 |
| Unpacked bytes | 3,051,963 |
| Files | 37 |
| Pack/install wall time | 12,202.995 ms |
| Tarball SHA-256 | `f217f5da9454ec88016b95a5094c5016a006941885f922aa8166fb99dc04ffde` |
| npm shasum | `6a0e6f5fd91468bc9b5cda209db4f1f6f8272e9b` |
| Install smoke | PASS with install scripts disabled; CLI reported `0.1.0` |

The captured package belongs to the exact source commit above. The later evidence commit adds this
document and JSON to the package allowlist, so it must not be represented as byte-identical to the
captured tarball.

## Startup, memory, and latency baseline

Three cold daemon starts used fresh disposable `ORCHESTRA_HOME` directories, loopback-only
`ORCHESTRA_NO_AUTH=1`, an intentionally unavailable Codex command, and no provider login or turn.
All three shut down gracefully with exit code 0.

| Metric | Samples | Min | Mean | p50 | p95 | p99 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|
| Ready startup (ms) | 3 | 718.605 | 723.890 | 724.909 | 728.157 | 728.157 | 728.157 |
| Ready RSS (bytes) | 3 | 123,830,272 | 124,654,933.333 | 123,846,656 | 126,287,872 | 126,287,872 | 126,287,872 |
| Ready virtual memory (bytes) | 3 | 456,985,591,808 | 456,988,568,234.667 | 456,985,706,496 | 456,994,406,400 | 456,994,406,400 | 456,994,406,400 |
| Warm loopback `/health` latency (ms) | 300 | 0.160 | 0.309 | 0.250 | 0.698 | 1.174 | 1.773 |

The 300 latency samples are the full request population: 100 sequential requests after readiness
in each run, with 300 successes and zero failures. RSS p50 is 118.109 MiB. Darwin virtual-memory
size includes reserved address space and is not physical-memory consumption.

## Token-usage baseline

The deterministic identical-scenario gate measures only Orchestra-injected hook context using
`ceil(characters / 4)`:

| Mode | Characters | Estimated tokens | Emissions |
|---|---:|---:|---:|
| Verbose rollback | 3,609 | 903 | 5 |
| Compact default | 1,795 | 449 | 5 |

Compact mode reduces estimated injected tokens by **50.3%** while all **11 / 11** compliance gates
pass. The output-discipline block costs 130 characters, or 33 estimated input tokens. See
[Token diet](./token-diet.md) for the per-event breakdown.

Provider-native completion tokens are deliberately not measured: a credential-free deterministic
baseline cannot execute a real provider turn. That evidence remains gated by TOOL-014 and must not
be inferred from this snapshot.

## Reproduction contract

`npm run baseline:agent-os` owns two commands:

```sh
npm run baseline:agent-os -- capture \
  --output /absolute/path/to/baseline.json \
  --source-commit <full-clean-HEAD-sha>

npm run baseline:agent-os -- validate \
  --input /absolute/path/to/baseline.json
```

Capture refuses a non-exact SHA, tracked source changes, a pre-existing output, project `.env`
files, invalid package/build/runtime evidence, incomplete request aggregation, or an invalid final
schema. It uses an empty npm user configuration and disposable cache/home directories, then
rechecks HEAD and tracked cleanliness before writing the 0644 JSON with exclusive-create
semantics.

## Interpretation boundary

- Measurements describe one exact source tree and one host; they are not budgets or thresholds.
- Startup is credential-free daemon readiness, not provider login, first token, or task completion.
- Latency is sequential loopback `/health` latency, not remote, concurrent, database-heavy, UI, or
  provider latency.
- Memory is one ready daemon process, not a complete multi-agent workload.
- Package evidence proves a local tarball install and CLI smoke, not public npm/plugin availability.
- No credential, provider transcript, raw terminal content, or login state enters the snapshot.
