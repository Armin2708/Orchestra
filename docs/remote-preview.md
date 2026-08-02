# Remote and mobile beta

Status: Beta Lane C implementation candidate. `REM-017` and `REM-GATE` remain open pending a fresh
iOS and Android run against one retained exact integrated artifact; this is not a public-release
or plug-and-play claim.

## Security boundary

`orchestra remote` keeps the daemon on loopback and exposes it through a verified Orchestra-owned
Tailscale route by default. Public Cloudflare fallback requires both
`ORCHESTRA_REMOTE_PUBLIC_TUNNEL=1` and `--public`. Before starting or reusing a tunnel, the CLI
checks daemon health, durable rollback state, tunnel ownership, origin, and end-to-end auth.

The QR fragment contains a short-lived, single-use, origin-bound `PairingTicket`—never the master
operator token. Redemption creates a named, scoped, expiring `DeviceSession` with a hashed,
rotating, P-256 key-bound credential that is individually revocable without rotating unrelated
sessions. The master and agent tokens remain loopback-only and are not
accepted through public or forwarded Host headers, query strings, browser storage, logs, referrers,
analytics, push payloads, or stream URLs.

Remote reads and mutations are default-deny and service-boundary classified. Terminal viewing is
read-only by default. Terminal write, destructive operations, administration, and higher-risk
approvals require exact-resource, exact-request step-up. Every allowed or denied remote mutation
retains device attribution and redacted audit evidence. Offline mutations are never queued.

Live events use a short-lived, single-use `Stream` Authorization credential. A held stream closes
at session/credential expiry, rotation, selective revoke, rollback, or daemon shutdown. Event data
is a board-grant-filtered invalidation envelope; clients refetch through classified APIs.

## Operator commands

```sh
orchestra remote
orchestra remote --stop

# Emergency rollback: persistently disable remote access, revoke every device/pairing/stream/
# step-up/push/grant authority, purge caches on contact, and stop only verified tunnel state.
orchestra remote --rollback REVOKE_ALL_REMOTE_AUTHORITY --reason 'lost device or security incident'

# Re-enable only fresh pairing. Revoked credentials and grants are never restored.
orchestra remote --enable-new-pairing ENABLE_NEW_REMOTE_PAIRING
```

Rollback preserves the loopback owner and daemon. A phone that is offline and unreachable cannot
be remotely erased; server authority is revoked immediately and `Clear-Site-Data` plus the v3
service worker purges authenticated browser state at next contact.

The mandatory threats, controls, AC-01–AC-20 abuse contract, and rollback invariants are in the
[remote/mobile threat model](remote-mobile-threat-model.md) and
[control matrix](remote-mobile-threat-control-matrix.json).
