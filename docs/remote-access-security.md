# Remote pairing, scopes, tunnels, and lost-device response

Status: design and operator boundary. Secure remote beta remains owned by Lane C and is unavailable
until its DeviceSession gates pass.

## Current boundary

The existing `orchestra remote` command is a legacy preview. Its QR contains a reusable master
operator bearer, browser storage retains that bearer, and there is no named, scoped, expiring,
key-bound, individually revocable DeviceSession. It must not be presented as secure pairing or
used for sensitive beta work.

The first-run defaults therefore keep remote access and remote terminal writes off. The onboarding
plan exposes the missing controls but cannot enable them.

## Required secure pairing flow

Lane C must supply a one-time, short-lived PairingTicket that yields a named DeviceSession containing
only a credential hash/key binding, explicit scopes, expiry, last-seen and revocation audit data.
The master token must never enter a URL, QR payload, browser storage, log, referrer, analytics event,
push notification, or diagnostics bundle.

Scopes must separate viewing from mutations, approvals, terminal write, destructive operations and
administration. Terminal write, destructive work and admin require explicit step-up. Every remote
mutation is attributable to one device.

## Tunnel choices

- Loopback remains the default and recovery surface.
- A private tailnet is preferred after DeviceSession authorization exists; TLS or a private network
  is transport, not application authorization.
- A public tunnel is an explicit advanced action with an independent kill switch, never a fallback.
- The current Cloudflare quick-tunnel path and host-wide `tailscale serve reset` behavior are legacy
  preview mechanics, not release-ready ownership isolation.

## Lost device

From a trusted local loopback session: revoke only the affected DeviceSession, terminate its streams
and grants, remove its push subscription, purge its authenticated cache, and verify that it cannot
read or mutate after reconnect. Revoking one phone must not rotate unrelated devices, stop the daemon,
or restore the master-token QR flow. If only the legacy preview was used, stop the tunnel, rotate the
master credential, clear affected browser storage, and assume any captured bearer is compromised.

The authoritative abuse cases and controls are
[remote-mobile-threat-model.md](remote-mobile-threat-model.md) and
[remote-mobile-threat-control-matrix.json](remote-mobile-threat-control-matrix.json).
