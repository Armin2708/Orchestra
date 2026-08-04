# Remote pairing, scopes, tunnels, and lost-device response

Status: integrated secure-remote implementation contract at code head
`58fc112a94c2253dd04f2ba617a6477b11d3d966`. DeviceSession and operations tests pass in the
accepted Lane C lineage, but exact-candidate iOS/Android installed-PWA evidence, `REM-017`,
`REM-GATE`, and public remote-beta approval remain open.

Secure remote beta remains unavailable for release until those exact-candidate native journeys
and the remaining remote gate are accepted.

## Current boundary

Remote browsers do not receive or accept the reusable local owner token. A browser on the active
private Tailscale origin may exchange the local owner password once for a limited named
DeviceSession. The server checks the private tunnel and request origin before verifying the
password; the phone never stores the password. Public Cloudflare origins cannot use this path and
must redeem a short-lived, single-use, origin-bound PairingTicket. The resulting device credential
is stored only as a hash and P-256 key binding; its scopes, board grants, expiry, last-seen state and
revocation audit are durable. Legacy token URL values and browser storage are rejected and scrubbed
on remote origins.

The remote shell is deliberately narrower than the local operator application. It exposes only
classified board summaries, no-tool messages, bounded agent controls, approval decisions and
terminal views/actions that the exact DeviceSession grant permits. Raw local settings, broad
snapshots, context, exports, provider credentials and the owner-token login surface are not mounted
for DeviceSession principals.

## Pairing and scopes

For a trusted phone already on the same private tailnet, plain `orchestra remote` may use password
bootstrap. It grants all current boards with only `observe`, `stream`, `message`, and `approve`.
It never grants `agent-control`, `terminal-write`, or `admin`; those capabilities and any narrower
board selection require an explicit pairing ticket and remain subject to step-up policy.

Start private access from a trusted local session and grant only the required boards and scopes:

```sh
orchestra remote --board 1 --scope observe --scope message --scope approve
```

The default transport is a private Tailscale exposure. Public Cloudflare exposure requires both
`ORCHESTRA_REMOTE_PUBLIC_TUNNEL=1` and the explicit `--public` CLI confirmation. Transport security
does not replace application authorization, and public exposure always uses ticket pairing rather
than owner-password bootstrap.

Scopes are closed and independent: `observe`, `stream`, `message`, `approve`, `agent-control`,
`terminal-write`, and `admin`. Agent control, terminal write, privileged approval and administration
also require fresh step-up bound to the exact action, resource, request digest and nonce. Terminal
access is view-only without `terminal-write`; offline mode is visibly stale/read-only and queues no
mutation.

Every remote mutation retains device attribution. Push subscriptions and preferences are bound to
one DeviceSession, use generic notification text and same-origin allowlisted destinations, and are
removed atomically when that device is revoked.

## Tunnel choices

- Loopback remains the default management and recovery surface.
- A private tailnet is preferred for remote use.
- Public tunnelling is an explicit advanced action with a separate kill switch; it is never a
  fallback when private transport or provider readiness fails.
- `orchestra remote --stop` stops only verified Orchestra-owned tunnel state.

## Lost device

From another trusted DeviceSession with the required admin step-up, selectively revoke the lost
device. Revocation closes its credentials, grants, step-up authority, streams, push subscriptions
and authenticated browser cache without rotating unrelated devices or stopping local recovery.

If selective administration is unavailable, use the local emergency boundary:

```sh
orchestra remote --rollback REVOKE_ALL_REMOTE_AUTHORITY \
  --reason 'lost device or suspected theft'
```

This durably disables remote access, revokes pairing/device/stream/step-up/push/grant authority,
purges caches on contact and stops only verified Orchestra-owned tunnel state. After local review,
permit fresh pairing without restoring old authority:

```sh
orchestra remote --enable-new-pairing ENABLE_NEW_REMOTE_PAIRING
```

## Evidence boundary

Source and adversarial tests cover expiry, replay, board/resource scope, step-up, selective revoke,
held-stream closure, unrelated-device survival, offline destructive rejection, credential rotation,
push removal and emergency rollback. Historical simulator images are explicitly non-gating. A fresh
run from the one retained exact candidate must still prove iOS and Android installation,
relaunch/reconnect, persistent authority, offline behavior and revoke before native remote gates can
close.

The authoritative abuse cases and controls are
[remote-mobile-threat-model.md](remote-mobile-threat-model.md) and
[remote-mobile-threat-control-matrix.json](remote-mobile-threat-control-matrix.json).
