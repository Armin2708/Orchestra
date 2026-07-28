# Agent OS BASE-008 Current Baseline Checkpoint — 2026-07-28

Status: **delivered at one exact clean source commit**. This checkpoint closes BASE-008 only. It
does not establish release SLOs, prove public installation, exercise a real provider turn, close
TOOL-014 or BASE-010, or make Orchestra public plug-and-play.

## TL;DR

| State | Exact evidence |
|---|---|
| Branch | `codex/base008-runtime-baselines` |
| Worktree | `/Users/arminrad/.codex/worktrees/agentboard/base008-runtime-baselines` |
| Exact base | `d2f7eace22a38b0bb927b97b8276a9bcd4e15948` |
| Measured harness commit | `51b168d96becccd4aa3506dec9e80fcebda43ed7` |
| Restart point | the isolated branch commit containing this checkpoint |
| Required toolchain | Node `22.20.0`; npm `10.9.3`; no project `.env` file was present or assumed |
| Backlog truth | **130 / 375 delivered; 245 open**; BASE-008 closed; TOOL-014 and BASE-010 open |
| Exact tests | default and serial: 146 / 146 files; 1,199 / 1,199 tests PASS |
| Runtime | 3 / 3 cold starts and graceful exits; 300 / 300 health requests; 0 failures |
| Token estimate | 903 verbose → 449 compact; 50.3% reduction; 11 / 11 compliance |
| Product status | Engineering preview; no provider support, runtime route, schema, or release state changed |

## Delivered

- `scripts/capture-agent-os-baseline.mjs` captures and validates one versioned, credential-free
  BASE-008 schema.
- `docs/agent-os-current-baseline.json` records the exact observed source, host, toolchain, tests,
  builds, package/install smoke, three cold starts, ready memory, 300 request latencies, and
  deterministic injected-context token usage.
- `docs/agent-os-current-baseline.md` explains those measurements and their interpretation limits.
- Capture requires a full SHA at clean HEAD, no tracked changes, no project environment files, a
  new absolute output, and a valid final schema. It rechecks HEAD and tracked cleanliness before
  writing.
- Package/cache and daemon state are disposable. Runtime capture is loopback-only with auth
  disabled for that disposable process and the Codex command intentionally unavailable.
- Provider-native completion tokens are excluded explicitly; TOOL-014 remains their evidence gate.
- The README, token-diet record, delivery program, package allowlist, and executable evidence tests
  are aligned to the source-controlled snapshot.

## Observed evidence

- Exact source commit: `51b168d96becccd4aa3506dec9e80fcebda43ed7`.
- Exact tree: `50cb9c7c9062bf3f25701a6dff66fee3d34befd0`.
- Host: Darwin 25.5.0 arm64, 12 logical CPUs, 24 GiB physical memory.
- Default-parallel suite: 146 / 146 files and 1,199 / 1,199 tests PASS in 22,483.430 ms.
- One-worker suite: 146 / 146 files and 1,199 / 1,199 tests PASS in 87,722.114 ms.
- Root/web TypeScript and production builds PASS. Root output is 1,807,439 bytes; web output is
  995,285 bytes, both with canonical SHA-256 summaries.
- Package/install smoke PASS: 680,660 packed bytes, 3,051,963 unpacked bytes, 37 files, scripts
  disabled during install, and CLI version `0.1.0`.
- Cold startup p50/p95: 724.909 / 728.157 ms.
- Ready RSS p50/p95: 123,846,656 / 126,287,872 bytes.
- All 300 sequential loopback health requests passed. Latency p50/p95/p99 is
  0.250 / 0.698 / 1.174 ms.
- Deterministic injected-context estimate: 903 verbose tokens versus 449 compact tokens, a 50.3%
  reduction with 11 / 11 compliance gates.
- The capture schema rejects dirty-source claims, failed package evidence, fewer than three cold
  starts, incomplete request aggregation, and non-reducing token evidence.

## Measurement boundary

- The source commit contains the harness but cannot contain the JSON generated from itself. The
  following evidence commit adds the immutable snapshot and human record.
- The measured package therefore does not include the later baseline JSON/Markdown allowlist
  additions; that difference is documented rather than hidden.
- Timings are observations on one host, not thresholds. BASE-009 owns the complete
  request-to-knowledge acceptance harness, not a conversion of these values into SLOs.
- Startup excludes provider authentication and model execution. Token evidence excludes
  provider-native completion tokens.
- Loopback health latency is not remote, concurrent, UI, database-heavy, or provider latency.
- Darwin virtual-memory size is reserved address space and not physical-memory use.

## Remaining

- BASE-009: create north-star acceptance tests for the full request-to-knowledge lifecycle.
- TOOL-014: record the real exact-source Codex matrix, reconcile support only from passing
  evidence, and implement the remaining declared provider adapters.
- BASE-010: define and prove the exact four-provider version, authentication/billing, capability,
  and platform matrix.
- The other 242 open checklist boxes remain dependency-ordered work.

## Shared-main preservation

The dirty shared checkout remains on `main` and was not reset, cleaned, switched, staged, or
committed.

- `web/src/Board.tsx` expected SHA-256:
  `e7b01cdab3709c66730f5b790f767e19bb2ddca6df0dc9fe56847c9b0bf0e0e8`
- `web/src/styles.css` expected SHA-256:
  `f54f263c6fd0f76e025b602a9f8f812d6e7e1cb4ad3e6bd8ee7f2ec5621cb2ec`

## Exact resume procedure

1. Read `/Users/arminrad/Desktop/agentboard/AGENTS.md` and this checkpoint completely.
2. Use this isolated worktree and branch; never switch or create a branch in the shared checkout.
3. Verify branch, worktree, shared UI hashes/status, Node/npm, `.env` state, and exact commit.
4. Continue dependency-ready BASE-009 or the independently pending TOOL-014 clean-profile
   acceptance track.
5. Run GitNexus impact before every existing-symbol edit and `detect_changes` before every commit.
6. Keep TOOL-014, BASE-010, provider labels, and provider-native token claims open until their
   exact real gates pass.
7. After meaningful changes, update Graphify and the Obsidian project notes, then rerun complete
   verification and preservation checks.

## Paste-ready resume prompt

```text
Resume the Agentboard Agent OS program from:
/Users/arminrad/.codex/worktrees/agentboard/base008-runtime-baselines/docs/checkpoints/2026-07-28-agent-os-base008-current-baseline.md

Read AGENTS.md and the checkpoint first. Preserve the dirty shared main checkout and continue the
earliest dependency-ready Agent OS backlog item from branch codex/base008-runtime-baselines.
BASE-008 is evidence-complete at 130/375 delivered. TOOL-014 and BASE-010 remain open pending exact
real provider evidence; provider-native completion tokens remain unmeasured.
```
