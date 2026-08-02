# Beta Lane C — phone, PWA, push, and device-management evidence

Status: integrated and verified; no authoritative backlog counts changed

Scope: `REM-008`, `REM-011`, `REM-012`, `REM-013`, `REM-014`, `REM-015`,
`REM-016`, `REM-017`, `REM-019`, `REM-020`, and the phone-UX `MILE-D` summary.

## TLDR

The web client now rejects master-token bootstrap on non-loopback origins and gives paired devices
a dedicated class-only shell backed only by classified remote board and no-tool message routes. It
also has a fail-closed DeviceSession surface, explicit offline read-only state, device-scoped
notification preferences, same-origin push navigation, generic lock-screen previews, and a four-
action phone dock for monitor, message, approve, and pause/stop navigation. Agent prompts
and PTY input/resize/signal/restart controls remain view-only unless the daemon reports both the
required scope and an exact active action/resource-bound step-up grant.

Lane-root route integration, DeviceSession-bound push, iOS/Android secure-context runs,
offline/revoke propagation, lost-device tests, and independent security review are complete. The
combined gate evidence is recorded in `docs/checkpoints/beta-lane-c-remote-ops.md`.

## Threat-control coverage

| Contract | Client implementation | Evidence | Residual integration |
| --- | --- | --- | --- |
| `TGT-002`, `TGT-003`, `REM-008`, `AC-02`, `AC-13` | Non-loopback bootstrap rejects and scrubs owner-token fragments/queries and old localStorage; only a single-use PairingTicket can create proof-bound Device authority. Rotation requires exact old/new proofs; session and credential expiry fail closed; peer revoke is target/digest/nonce-bound. | browser, proof, integration and revoke-gate tests; native pairing/revoke transcript | Ambiguous rotation outcomes must be probed, never blindly replayed; if neither authority works, revoke from another trusted device and re-pair. |
| `TGT-004`, `TGT-016`, `TGT-017`, `REM-011`, `AC-06`, `AC-12` | Paired non-loopback browsers never render owner Login or load legacy owner surfaces. The dedicated shell consumes field-minimized classified routes; message retries retain one bounded idempotency key; strict remote CSP is integrated. | remote shell, API, browser-security, production AC and native viewport evidence | The deliberately looser loopback owner style policy must never weaken remote script or framing policy. |
| `TGT-009`, `REM-011`, `AC-12` | Private networking is the presented default; public exposure requires explicit double confirmation; ownership, health and origin are verified before reuse/stop. | remote UI, CLI and tunnel tests | Public exposure remains an explicitly accepted operator risk. |
| `TGT-013`, `REM-012`–`REM-014`, `AC-11`, `AC-17` | Per-device severity, quiet hours, generic/content preview controls, DeviceSession-bound subscriptions/fanout, same-origin allowlisted paths, and atomic revoke cleanup are integrated. | `web/public/sw-push.js`; web-push and integration tests; AC-11/17 | Web Push remains at-least-once across a provider acknowledgement window and uses the stable delivery identity. |
| `TGT-010`, `REM-015`–`REM-017`, `AC-09`, `AC-10` | Offline banner says stale/read-only, all new remote mutations disable offline, the worker has no mutation queue/sync/outbox, authenticated APIs are network-only, and legacy API caches purge on activate/revoke contact. | PWA tests; Android standalone secure-PWA offline/revoke run | Physical-device regression remains recommended for future OS/keychain/push changes. |
| `TGT-016`, `REM-019` | Bottom phone dock exposes Monitor, Message, Approve, and Pause/stop destinations with 44px+ safe-area-aware targets. Existing Agent Home retains phone lifecycle actions. | phone dock and mobile Agent Home tests; iOS 26.5 and Android 36.1 native viewport runs | None beyond normal physical-device regression. |
| `TGT-004`, `TGT-005`, `TGT-017`, `REM-020`, `AC-06`, `AC-14` | Unknown/missing authority fails closed. Agent prompts require `agent-control`; terminal writes require `terminal-write`; privileged actions require exact active resource/digest/nonce-bound step-up. | remote policy, terminal/cockpit panels, production route/service-boundary tests | User verification remains intentionally interactive and cannot be queued or bypassed offline. |

## Integrated API contract

The lane root implements these client contracts:

- `GET /api/v1/os/devices/self` → either `{ local_owner: true }` or the public device DTO
  `{ device_session_id, name, scopes, expires_at, credential_expires_at, step_up }`.
- `GET /api/v1/os/devices` → `{ devices: [...] }` or a public device array.
- `POST /api/v1/os/devices/:id/revoke` → selective, audited device revoke.
- `POST /api/v1/os/devices/self/credential/rotate` → body is exactly
  `{ new_public_key_jwk }`; `x-orchestra-request-id` is a bounded stable request identity, and
  `x-orchestra-credential-rotation-proof` plus `x-orchestra-new-key-proof` are 64-byte P1363 ES256
  signatures over the canonical challenge. Old-key DPoP authenticates ingress. The direct response
  is `{ credential, credential_metadata }` for the same DeviceSession and a new rotation generation.
- `POST /api/v1/os/devices/self/step-up` → starts user verification; returning success never
  optimistically unlocks the client, which re-reads `/self` for an exact active grant.
- `GET|PUT /api/v1/os/devices/self/notifications` → device-bound severity, quiet-hours, and
  preview preferences.
- `GET /api/v1/os/remote/status` → `{ mode: "local"|"private"|"public", origin? }` with a
  field-minimized origin appropriate for the current principal.
- `GET /api/v1/os/remote/boards` → `{ boards: [{ id, name, open_work, attention_count }] }` for
  explicitly granted boards only.
- `POST /api/v1/os/remote/messages` → accepts `{ board_id, body }` with a bounded
  `idempotency-key` retained across transport retries and must confirm `{ target_kind: "no-tool" }`
  with device attribution, replay-safe outcome, and audit evidence.

A `404`, invalid DTO, authentication failure, offline state, expired grant, wrong resource, or
wrong action leaves all privileged controls view-only. The master token is never accepted or stored
on non-loopback. Device credential material and its nonextractable private key live only in the
browser authority store. A pending revoke nonce is ephemeral React state and is cleared on failure,
use, mismatch, or expiry; it is never logged, placed in a URL, analytics, referrers, or push.
If rotation issuance succeeds but protected storage fails, the paired shell immediately exposes a
recovery action. A subsequent polling `401` clears only the rejected old record and deliberately
preserves the staged key plus pending issued authority until recovery or explicit discard.

## Verification at child-lane commit candidate

- Required runtime: Node `22.20.0` loaded explicitly through nvm.
- Environment: no repository `.env` or `web/.env` exists; focused UI tests require no external
  environment variables.
- Focused tests: 8 files, 61 tests passed (`remote-browser-security`, `remote-phone-ux`, threat
  matrix, `pwa`, auth, mobile Agent Home, AgentTerminal controls, ProcessTerminal state).
- Backend TypeScript bundle: passed.
- Production web build: passed (Vite transformed 83 modules).
- Integrated native QA: iOS 26.5 paired Safari and Android 36.1 secure standalone PWA passed;
  Android also proved offline read-only and post-revoke authority purge. Exact evidence is in the
  combined Lane C checkpoint.

## MILE-D phone UX summary

`MILE-D Phone UX handles attention, messaging, approval and safe control` is complete on the
integrated lane. The phone information architecture, classified routes, push, safe deep links,
offline read-only behavior, selective revoke, and fail-closed privileged controls passed production
tests and native iOS/Android secure-context runs. Independent review has zero unresolved P0/P1/P2.
