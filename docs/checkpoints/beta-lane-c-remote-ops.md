# Beta Lane C — remote security and operations readiness

Status: ready; no authoritative backlog counts changed

Base: `0dd3dd43b9f376370ee73a9e2fe4725974caaae8`

Branch: `codex/beta-remote-ops`

Runtime: Node `22.20.0`

## TLDR

`REM-002`–`REM-020`, `OPS-002`–`OPS-022`, `REM-GATE`, and `OPS-GATE` are
implemented and verified on the integrated Lane C tree. Remote authority is named, narrow,
expiring, proof-bound, individually revocable, audited, and default-deny. Recovery is durable and
idempotent across crashes. Operations output is bounded and redacted. Independent review reports
zero unresolved P0/P1/P2 findings.

## Mandatory threat-control coverage

| Contract | Integrated control | Executable evidence |
| --- | --- | --- |
| `TGT-001`–`TGT-003` / `REM-002`–`REM-004` | Single-use origin-bound PairingTicket; named DeviceSession; hashed, P-256-bound, expiring, rotating and selectively revocable credential. The owner token is rejected and scrubbed on remote origins. | `device-session-migration`, `device-sessions`, `remote-device-proof`, `remote-browser-security`, and canonical AC-01–04 tests |
| `TGT-004`–`TGT-006`, `TGT-017`, `TGT-018` / `REM-005`–`REM-009`, `REM-020` | Closed scope vocabulary, board/resource/data-class/field grants, view-only terminal default, exact action/resource/digest/nonce step-up, no-tool messaging, and immutable device-attributed mutation audit. | authorization-policy, mutation-audit-store, integration, phone policy, AC-05–09/14/18/19 tests |
| `TGT-007`, `TGT-008`, `TGT-014` / `REM-010`, `REM-018` | Host, Origin, Fetch Metadata, proxy, CSRF, framing/CSP and bounded ingress/auth/action rate checks precede authentication timestamps and mutation. Streams use a 30-second, single-use, hashed, purpose-bound header credential—not a URL token. | request-security, browser-security, live held-SSE, flood/load, AC-03/05/20 tests |
| `TGT-009` / `REM-011` | Private Tailscale is the default. Public Cloudflare exposure needs both the environment gate and explicit CLI confirmation. Reuse/stop require origin, ownership and health evidence. | `remote.test.ts`, remote CLI security, AC-12 |
| `TGT-013` / `REM-012`–`REM-014` | Push subscriptions and preferences are DeviceSession-bound; payloads are generic by default; destinations are normalized same-origin allowlisted paths; revoke atomically removes delivery authority. VAPID private material lives behind an opaque platform-keychain reference. | web-push security, push, phone UX, integration, AC-11/17 |
| `TGT-010`, `TGT-016` / `REM-015`–`REM-017`, `REM-019` | Installed PWA is explicit stale/read-only offline, has no mutation sync/outbox, uses network-only authenticated APIs, and purges authority/cache after rejection. Phone controls are safe-area aware and 44px or larger. | `pwa`, phone UX, browser security, AC-09/10 plus native simulator evidence below |
| `TGT-011`, `TGT-015` / `REM-004`, `REM-008`, `REM-018`, `REM-GATE` | Selective revoke closes only the target device's credentials, grants, step-up, streams, push and browser authority. Durable emergency rollback revokes all remote authority, stops verified transport, preserves local recovery, and requires an exact re-enable phrase. | lost-device held-stream test, rollback CLI/integration tests, native revoke evidence, AC-04/13 |
| `TGT-012` / `REM-007`, `REM-009` | Approval decisions are closed, risk-classified and bound to the exact request digest and fresh step-up; raw approval parameters remain withheld and concurrent devices produce one attributed final decision. | approval policy/audit integration and AC-07/14/15 tests |

The canonical production adapter rejects synthesized evidence and binds AC-01–20 to real
`buildServer`, SQLite, held sockets, shipped service workers, and production helper executions via
`PRODUCTION_AC_EVIDENCE_MANIFEST`. Integrated result: 20/20 controls passed; the surrounding
remote security set passed 79/79 after the final provenance fix.

## Operations coverage

| Items | Integrated result and evidence |
| --- | --- |
| `OPS-002`–`OPS-005` | Startup reconciliation precedes launch admission; leases recover; duplicate/orphan authority is revoked; outbox delivery has stable durable idempotency, bounded retries, abort handling and no concurrent reinvocation. Recovery/runtime tests include real close/reopen and SIGKILL paths. |
| `OPS-006`–`OPS-008` | Checksummed online backup and quiesced restore, recoverable quarantine/retirement, exact migration inventory, and argv-only Git execution with lexical, realpath and symlink containment. CLI regressions prove `ops backup` and `retire-backups` cannot follow an in-state symlink outside state. |
| `OPS-009`–`OPS-013` | Fixed-vocabulary structured logs, double redaction, protected platform credential references, quarantined no-tool remote messages, bounded privacy-hashed request/command/provider limits, and correlation/job/session/device attribution. |
| `OPS-014`–`OPS-018` | Concurrent timeout-bound live health probes, minimal public readiness, owner-only 0600 diagnostics, bounded-cardinality metrics, deduplicated privacy-safe alerts, interactive reserve and 10,000-admission capacity evidence. |
| `OPS-019`–`OPS-022` | Stable-code failure policy, admission freeze/drain/flush with authority-release guard, documented local data ownership/external-service boundaries, and completed dependency/secret/auth/command/path review. |
| `OPS-GATE` | Serialized full repository suite passed 211 files / 1,890 tests. Crash/restart, two-active-agent recovery, outbox replay, backup corruption, contention, rate flood and capacity tests passed without duplicate jobs, orphan authority or silent loss. |

## Native secure-context evidence

The run used the current worktree build only: isolated daemon state
`/tmp/agentboard-lane-c-home.KT1zzd`, port `4777`, and a locally trusted TLS reverse proxy on
`4443`. No public tunnel was opened. Separate single-use tickets were bound to
`https://192.168.1.18:4443` and `https://10.0.2.2:4443`; ticket values and credentials were never
printed or retained in repository artifacts.

- iOS 26.5, iPhone 17 Pro simulator: native viewport first showed remote Pairing required with no
  owner-token input, then redeemed a real ticket into `iPhone · 2026-08-02`, Online, with the
  scoped paired shell and no local-owner UI (platform transcript hashes `811d62a…` and
  independent `2274adce…`).
- Android 36.1, Medium Phone emulator: Chrome reported a secure connection, WebCrypto available,
  one active service-worker controller/registration, standalone display mode at 411×866, empty
  localStorage, and the IndexedDB authority store. The launched activity was
  `org.chromium.chrome.browser.webapps.WebappActivity`
  (platform evidence transcript: installed/paired hash `443ee572…`).
- With network disabled, the installed app rendered `Offline · read-only`, marked live data stale,
  disabled mutation controls, and stated mutations would not be queued
  (platform evidence transcript: offline hash `6e433add…`).
- Local-owner revoke changed only Android to `revoked`, revoked its credential and reduced its
  IndexedDB authority count to zero; the installed app returned to Pairing required. The iPhone
  session/credential remained active and was observed afterward
  (platform evidence transcript: post-revoke hash `39aa9c3a…`).

The durable, redacted reproduction transcript and full hashes are in
`docs/checkpoints/beta-lane-c-platform-evidence.txt`; temporary screenshot paths are not relied on
as repository evidence.

Production tests additionally cover session/credential expiry, offline destructive rejection,
single-use ticket replay, lost-device stream closure, and unrelated-device survival without
depending on simulator timing.

## Verification and review

- Environment: repository `.env` and `.env.local` do not exist; tests used explicit isolated
  variables. Node was explicitly loaded from `v22.20.0`.
- Builds/package: root build, TypeScript, web `npm ci` and production Vite build, and
  `npm pack --dry-run` passed (48 files; 954.8 kB package).
- Tests: serialized final full suite passed 211 files / 1,890 tests. One earlier parallel
  `autoship-wiring` failure was reproduced as cross-process temporary-worktree contention and its
  isolated 7/7 rerun plus the serialized full run passed.
- Supply chain: root and web production audits report zero vulnerabilities. A lock-only peer
  resolution refresh moved `@modelcontextprotocol/sdk` to `1.30.0` and `@hono/node-server` to
  `2.0.12`, remediating `GHSA-frvp-7c67-39w9`; dependency manifests remain unchanged.
- Secrets/injection: Gitleaks passed for production source, web assets and docs; seeded diagnostic
  secrets/content are absent from decoded bundles. Executable calls use fixed programs and argv.
  Backup, restore, diagnostics and repository paths reject traversal and symlinks.
- Independent review: canonical evidence, backup boundary, installed PWA, selective revoke,
  crash/recovery, dependency and secret gates were independently rerun; zero P0/P1/P2 remain.

## MILE-D summaries

### Secure remote/mobile control

Named phones can be paired without revealing the master token, receive only explicit board and
scope grants, observe redacted state, send quarantined no-tool messages, and use privileged
controls only after exact fresh step-up. Revocation is selective and immediately fail-closed.

### Reliability and recovery

Daemon restart, SIGKILL, concurrent active-agent reconciliation, outbox replay, idempotent
consumption, backup/restore, retention and shutdown authority release are durable and bounded.
Accepted work is neither silently dropped nor duplicated; unresolved delivery prevents authority
release.

### Diagnostics, observability and operations

The daemon now exposes minimal public readiness and owner-only redacted diagnostics, structured
bounded logs, metrics, alerts, capacity admission and stable failure policies. Local data ownership
and every opt-in external service boundary are documented. The outcome/token dashboard is
intentionally excluded because Session 4 supplies it.

## Residual risks

- Web Push remains at-least-once across the provider acknowledgement window; downstream delivery
  must honor the stable idempotency key.
- Public Cloudflare exposure is inherently broader than private tailnet access and remains an
  explicit double-confirmed operator choice.
- Simulator evidence covers iOS Safari and Android installed PWA behavior; final distribution
  should retain physical-device regression runs for OS/keychain/push changes.
- Operations artifacts are local and redacted but still require operator review before sharing.
