# Remote preview

Status: legacy functional preview; not a safe remote beta, supported remote-control surface, or
secure device-pairing system.

## What the command currently does

`orchestra remote` refuses to run when daemon authentication is disabled. Its current lifecycle is:

1. If `remote.json` appears live, it reuses that record without rechecking daemon health. Tailscale
   reuse checks only that the binary still exists; Cloudflare reuse checks only recorded PID
   liveness.
2. For a fresh tunnel, it attempts to ensure the loopback daemon is reachable.
3. It prefers `tailscale serve` when Tailscale is installed; otherwise it starts a public
   Cloudflare quick tunnel when `cloudflared` is installed.
4. It records tunnel metadata in `ORCHESTRA_HOME/remote.json`.
5. It prints a URL and QR whose fragment contains the reusable master operator bearer.

The web client copies that bearer into browser storage. This is token bootstrap, not device
enrollment or secure pairing.

## Missing security boundary

The current preview has no named `DeviceSession`, one-time pairing ticket, per-device scope,
expiry, key binding, per-device revocation, or user-verifying step-up for terminal writes,
approvals, agent control, and administration. Every browser holding the master token represents the
same broad operator. A captured QR, copied URL, lost phone, browser extension, injected script, or
leaked stream URL can therefore retain broad authority. There is no per-device revocation.

Stopping the tunnel:

```sh
orchestra remote --stop
```

requests `tailscale serve reset` or sends `SIGTERM` to the recorded Cloudflare process, then removes
`remote.json` without checking the reset result or waiting for termination. The Tailscale reset is
host-wide serve configuration, not an Orchestra-scoped route removal. Treat stop as best effort and
verify the external URL no longer reaches the daemon. Stop does not rotate the master token, revoke
one browser, clear browser storage, invalidate cached responses, or remotely erase an offline
device.

Do not use this preview for sensitive remote work or treat TLS transport as proof of safe device
authorization. If it is evaluated at all, prefer a private tailnet, use non-sensitive data, and keep
the exposure brief. A public quick tunnel is not a release-ready fallback.

The evidence-backed control inventory and abuse cases are in the
[remote/mobile threat model](remote-mobile-threat-model.md). Its `REM-GATE` remains open.
