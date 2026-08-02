# Beta Lane C remediation candidate

Status: remediation-ready for central integration. This checkpoint resolves or retracts the five
findings against Lane C marker `2e29f9d7fa5b11283e54542b3c8dc187d5d701fe`; it does **not** close
`REM-017`, `REM-GATE`, production transition-chaos acceptance for `OPS-002`, or `OPS-GATE`.

Runtime: Node `22.20.0`; npm `10.9.3`. No repository or web `.env` file was present or assumed.

## Asked

- Replace the restore CLI's network-error-as-quiescence behavior with durable, fail-closed proof.
- Repair the Lane C web TypeScript failures.
- Correct the root dependency audit result.
- Retain any safe native observations without presenting historical screenshots as exact-marker or
  exact-artifact gate evidence.
- Retract the unsupported production-chaos and native-gate completion claims, then rerun the full
  repository gates and obtain independent P0/P1/P2 review.

## Delivered

- Daemon startup and database restore now serialize on one owner-only state-transition lock.
- A restore requires a clean-shutdown receipt bound to the canonical state root, database
  device/inode/size, daemon PID, daemon lease owner, and successful provider/runtime shutdown. The
  recorded PID must be dead, the PID file absent, the database identity unchanged, and the daemon
  lease empty. The receipt is rechecked immediately before database replacement and consumed only
  by a successful restore.
- `orchestra stop` no longer removes the PID file before the daemon's shutdown hooks, provider
  detach, lease release, database close, and receipt write complete.
- The production daemon lifecycle test proves wrong-port and connection-reset conditions cannot
  authorize restore while the daemon is live, then proves restore succeeds after exact clean
  shutdown without deleting the quarantine copy.
- WebCrypto inputs retain their concrete `ArrayBuffer` backing type, and remote-session activity is
  a type predicate with an explicit null guard. Root and web TypeScript now pass.
- `@modelcontextprotocol/sdk` and its `@hono/node-server` dependency are lockfile-updated; root and
  web audits report zero vulnerabilities at the moderate threshold.
- Five native screenshots are tracked with exact bytes, dimensions, SHA-256 digests, capture base,
  and limitations in `docs/evidence/beta-lane-c-native-historical/manifest.json`. The executable
  verifier requires the bundle to remain classified `historical-non-gating` and explicitly records
  that it cannot close `REM-017` or `REM-GATE`.
- The Lane C checkpoints and preview docs now leave `REM-017`, `REM-GATE`, production `OPS-002`
  transition-chaos acceptance, and `OPS-GATE` open. The `DenyAllProbe` test is identified as a
  fail-closed harness enumeration, not production-adapter gate evidence.

## Evidence

| Gate | Result |
| --- | --- |
| Focused Lane C matrix | PASS — 13 files / 97 tests |
| Complete default-parallel suite | PASS — 213 files / 1,893 tests |
| Complete one-worker suite | PASS — 213 files / 1,893 tests |
| Root TypeScript and production build | PASS |
| Web TypeScript and production build | PASS |
| Root and web `npm audit --audit-level=moderate` | PASS — zero vulnerabilities in both trees |
| Native evidence integrity verifier | PASS — five tracked PNGs; gate status remains open |
| Package dry run | PASS — `orchestra-board@0.1.0`, 48 files / 957,711 bytes (approximately 957.7 kB) |
| Lock stability | PASS — root `14ffa43b3e3d2484a2177a814075fcae2dbcace764df30680ed92c2e23fd2817`; web `6445a8eae1436ef83a5a99240b619e4fcabe218f6a48a2560b09e810c89c11f5` |
| GitNexus | Impact checks ran before symbol edits; change detection reports an aggregate critical surface, dominated by global-name conflation of the local web `utf8` helper. The actual daemon/restore lifecycle symbols were reviewed individually and exercised by focused restart/restore plus both full suites. |
| Graphify | Isolated graph copy refreshed after the code changes; no shared-checkout graph was modified. |
| Independent exact-tree review | Candidate `9325a234` returned P0=0 / P1=0 / P2=1 for stale package/suite counts only. This exact-evidence correction was verified against a fresh package dry run and the retained full-suite reports; unresolved P0/P1/P2 = 0. |

## Remaining

- `REM-017` and `REM-GATE`: run one fresh retained exact integrated artifact through iOS PWA
  installation/relaunch/reconnect/persistence and Android install/offline/revoke authority checks.
- Production `OPS-002` transition-chaos acceptance and `OPS-GATE`: bind `OPS-CHAOS-01` through `04`
  to production daemon/outbox/provider transitions, including survivor, crash, disk/database,
  provider, network, and rollback behavior.
- Central Lane D must re-run cross-lane tests after integration and own the retained-artifact release
  gates. This lane does not publish, tag, promote stable, or change authoritative backlog counts.
- Central integration must revalidate this exact remediation marker after combining the lanes; any
  later code, package, or evidence change invalidates these counts and requires fresh review.
