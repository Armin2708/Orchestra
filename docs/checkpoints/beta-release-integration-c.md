# Beta release central integration — Lane C

Date: 2026-08-02

## Asked

Integrate the verified Lane C ready marker into the accepted Lane A central-integration head,
reconcile shared migration, authentication, daemon, server-composition, terminal and navigation
seams, and prove the combined repository without changing authoritative backlog status or making a
public release action.

- Accepted Lane A base: `b6dc067f7de66f7978b951d1e37ffb9c86ba9cfb`
- Lane C ready marker: `33627998e67a27b8cbfa19e54b0b8b4447bd254a`
- Central Lane C merge: `3f8aed8a3b5af29c2dcbfaec634277cd32473034`

## Delivered

- Reconciled the Lane C device-session and operations-recovery migrations as `040` and `041`
  after the accepted Lane A terminal migration `039`. Legacy Lane C `030`/`031` markers are
  accepted only after exact schema attestation; incomplete legacy state fails atomically and stays
  unrecorded.
- Unified managed-agent/bootstrap authentication with remote device proof, narrow scoped authority,
  selective revoke, request security, mutation audit, capacity and operations integration.
- Unified provider-native daemon readiness and session tools with database quiescence, operations
  runtime, VAPID setup and safe shutdown. The liveness probe accepts the current `live` contract and
  the historical `ok` compatibility response without spawning a duplicate daemon.
- Unified the Command Center/collaboration shell with paired-device routing, offline read-only
  behavior, phone navigation and remote step-up. Reconnect read-only and scoped-step-up state both
  gate terminal input, resize, shell, signal and restart controls.
- Extended the quality/state-machine inventory with device session, database quiescence, daemon and
  operations health candidates and refreshed the exact inventory digest.

## Evidence

Environment: Node `22.20.0`, npm `10.9.3`. Root and web `.env`/`.env.local` files were explicitly
checked and are absent.

| Gate | Exact result |
|---|---|
| Focused migration/auth/domain verification | 13 files / 167 tests passed |
| Final integration-seam verification | 4 files / 29 tests passed |
| Managed-launch daemon acceptance | 5 tests passed |
| Complete default-parallel repository suite | 266 files / 2,203 tests passed in 129.42s |
| Complete one-worker repository suite | 266 files / 2,203 tests passed in 372.08s |
| Root TypeScript and production build | passed |
| Web TypeScript and production build | passed |
| Root and web dependency audits | zero vulnerabilities |
| Beta quality-matrix validator | passed in current-base mode; 37 open prerequisite/lane-dependent cases remain truthfully unresolved |
| Gitleaks | staged scan and the three-commit integration range passed; no leaks found |
| GitNexus | final comparison mapped 159 changed symbols across 118 files and 16 affected processes; CRITICAL breadth is expected for the server/daemon/UI central seam and is covered by both complete suites |
| Graphify | structural graph refreshed to 10,354 nodes / 48,981 edges; clustering reported 392 communities; HTML visualization intentionally skipped for the graph size |

## Remaining

- `REM-017` and `REM-GATE` remain open: historical native images are explicitly non-gating and do
  not prove an exact-marker iOS/Android install, relaunch, persistent-authority, offline and revoke
  journey.
- Production transition-chaos acceptance for `OPS-002` and `OPS-GATE` remains open until the full
  chaos contract runs through the real production daemon/outbox adapter at every claimed
  transition.
- Provider-native acceptance is not green in this environment: the installed Codex CLI is
  `0.146.0`, while the repository pins `0.144.6`. This is an environmental version mismatch and was
  not bypassed or converted into a product success.
- The 37 quality-matrix cases reported by current-base mode remain for the final integration lane to
  satisfy or explicitly retain as prerequisites. This checkpoint does not reconcile backlog counts.
- Final artifact, clean-consumer lifecycle, browser/accessibility, interruption dogfood and exact
  release-candidate review remain owned by the central beta-release lane.

## Rollback

Revert merge `3f8aed8a3b5af29c2dcbfaec634277cd32473034` from the central integration branch. The first
parent is the accepted Lane A head and the second parent is the immutable Lane C marker, so the
entire Lane C integration can be removed without rewriting either source lane. Migration `040` and
`041` data is forward-only; restore from the retained pre-integration backup if database rollback is
required.

No push, tag, npm publication, GitHub release, provider promotion, stable claim or authoritative
backlog mutation was performed.
