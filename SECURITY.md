# Security Policy

## Reporting a vulnerability

Please report vulnerabilities **privately** — do not open a public issue.

- Email: **radarmine1@gmail.com** with subject `[orchestra security]`
- Or use GitHub's [private vulnerability reporting](https://github.com/Armin2708/Orchestra/security/advisories/new)

You'll get an acknowledgment within 72 hours. Please include reproduction
steps and the version (`orchestra --version`).

## Scope

Orchestra runs a **local daemon** that spawns and controls coding agents, and
optionally exposes a scoped remote surface (Tailscale/Cloudflare pairing with
per-device sessions). Reports we care most about:

- Authentication/authorization bypass on the daemon HTTP API (operator vs
  agent vs device principals)
- Remote surface escalation (pairing tickets, DeviceSessions, step-up grants)
- Agents escaping their workspace/worktree or acting with operator authority
- Injection through board messages, cards, or pasted content into agent
  terminals

The threat model and route-by-route control matrix live in
[docs/remote-mobile-threat-model.md](docs/remote-mobile-threat-model.md).

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅        |
