# Lane 1 Open Work and DOM-019 integration checkpoint

Date: 2026-08-01

## Bottom line

Exact verified code head `091fb8ff2f1708969d60f046fb4ae8a7d4e7a8d3` integrates Lane 3,
the Lane 2 provider candidates, and Lane 4 Open Work into the central Agent OS composition.
It closes `DOM-019`, `JOB-008`, `JOB-009`, `JOB-014`, `JOB-015`, and `JOB-GATE`.
`JOB-012`, `TOOL-014`, and `BASE-010` remain open.

## Delivered contract

- Open Work is mounted at `/api/v1/os`, globally navigable, and included in the executable route,
  UI, package, and remote-threat inventories.
- Contract update/publish commands require an exact positive `expected_market_version`; the
  compare-and-set occurs inside the write transaction and the server derives the audit actor.
- Preview, dispatch, the persisted immutable job brief, its SHA-256, and the actual provider
  driver prompt use one renderer. Frozen job contracts do not drift when a mutable card contract
  changes later.
- Matching is deterministic across provider, model, access, capability, workspace, global
  capacity, and per-profile capacity. Dependency blockers and critical paths remain explicit.
- Confirmed dispatch is replay-safe and creates exactly one exclusive assignment, job, delivery,
  session, and start. Collaborative Team assignment remains deliberately out of scope.
- DOM-019 observes real legacy reads and writes across all 13 compatibility/legacy tables,
  resolves identity-bearing reads into their linked, quarantined, or unlinked cohorts, records
  canonical reads on supported replacement surfaces, and compares exact retained links for
  missing or stale projections. Failure admission/reconciliation remains durable across rollback,
  lock, restart, and UTC-day boundaries. No cutover flag or writer retirement is implied by
  closing the telemetry implementation item.
- Claude, Qwen, and Kimi remain fail-closed candidates. No provider support label is promoted;
  ambiguous version evidence, interactive-only automation, and unproved overage behavior remain
  blockers owned by `TOOL-014` and `BASE-010`.

## Evidence

Environment: Node `22.20.0`, npm `10.9.3`; no repository or web `.env` file exists.

| Gate | Exact result |
|---|---|
| Complete one-worker repository suite | 175 files / 1,663 tests passed |
| Complete default-parallel repository suite | 175 files / 1,663 tests passed |
| DOM-019 focused gate | 6 files / 109 tests passed |
| Open Work exact-brief gate | 5 files / 52 tests passed |
| Root TypeScript and production build | passed |
| Web TypeScript and production build | passed; lazy Open Work JS/CSS chunks emitted |
| Package dry-run | passed; 43 entries and Open Work chunks included |
| Migration/config stability | required double-hash checks matched |
| GitNexus | refreshed to 12,331 nodes / 33,200 edges / 723 clusters / 288 flows |
| Graphify structural index | refreshed to 7,010 nodes / 16,463 edges / 288 communities |

Gitleaks finds one historical synthetic test fixture (`delivery-accept-1` under an
`idempotencyKey` property in commit `085b180`) when scanning the 90-commit integration range. It
is not a credential and no new secret finding is attributable to this integration.

The configured in-app Browser runtime exposed zero browser backends during final central
verification. Lane 4's isolated desktop and phone browser acceptance remains recorded in
`2026-07-29-agent-os-job-market-open-work-candidate.md`; the combined real-shell Browser capture
remains an external QA gate rather than being represented as completed here.

## Reconciliation

The authoritative checklist is 151 / 375 delivered and 224 open:

- Phase 1: 20 / 20 delivered; `DOM-019` is closed.
- Phase 5: 17 / 18 delivered; only `JOB-012` remains open.
- `TOOL-014` and reopened `BASE-010` remain open. Claude/Codex are the current managed runtimes;
  Qwen/Kimi candidate code does not constitute support evidence.
- KNO-003 through KNO-010 remain globally closed from the reviewed Lane 3 integration.
