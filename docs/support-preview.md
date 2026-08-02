# Support preview

Status: engineering-preview support guidance; no SLA or public-release support promise. An
allowlisted local diagnostics bundle exists, but no bundle is automatically safe to publish.

## Before reporting a problem

Capture the smallest reproducible case and run:

```sh
node --version
npm --version
git --version
node dist/cli.js --version
node dist/cli.js doctor --provider both --json
```

The readiness doctor reports executable identity as a category and opaque fingerprint and does not
print raw provider command output. Include the exact Git revision under evaluation and say whether
the daemon, provider, terminal, browser, or build failed. For browser issues, include the viewport
and a redacted screenshot only when it materially helps.

Use the repository's
[issue tracker](https://github.com/Armin2708/Orchestra/issues) for non-sensitive reports. Search for
an existing issue first.

## Do not share

Generate a bounded, redacted bundle only to a new owner-only file:

```sh
orchestra ops diagnostics ./orchestra-diagnostics.json.gz
```

The command calls the loopback owner-only endpoint, writes with exclusive create and mode `0600`,
and includes only allowlisted health, metrics, bounded redacted logs, runtime facts, and safe
configuration categories. Decode and review it before sharing. It is not an arbitrary state
archive and does not make the following safe to attach or paste:

Do not attach or paste any of the following:

- `ORCHESTRA_HOME`, `orchestra.db`, SQLite WAL/SHM files, or raw database exports;
- `token`, `agent-token`, `vapid-reference.json`, hook session files, browser storage, pairing
  artifacts, device/stream credentials, or remote URLs;
- provider credentials, login output, environment dumps, keychain output, cookies, or request
  authorization headers;
- raw transcripts, prompts, PTY output, approval parameters, project source, local paths, or
  screenshots containing any of those; or
- `cloudflared.log` or browser/network logs without reviewing and redacting them first.

Replace project, user, host, agent, branch, worktree, and session identifiers with neutral labels
when they are not needed to reproduce the fault. Never post a secret and then rely on editing the
issue later; treat any published credential as exposed.

If a device may be lost or any remote credential may have been captured, run:

```sh
orchestra remote --rollback REVOKE_ALL_REMOTE_AUTHORITY --reason 'lost device or suspected theft'
```

This durably disables remote access, revokes pairing/device/stream/step-up/push/grant authority,
purges caches on contact, and stops only verified Orchestra-owned tunnel state. Local recovery
remains available. To permit only fresh pairing after review, run:

```sh
orchestra remote --enable-new-pairing ENABLE_NEW_REMOTE_PAIRING
```

## What this guidance does not prove

These steps help produce a safer bug report. They do not by themselves satisfy support-policy,
upgrade/uninstall, remote-security, or public-release gates.
