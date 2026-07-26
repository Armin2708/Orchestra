# Support preview

Status: engineering-preview support guidance; no SLA, public-release support promise, or automated
diagnostics bundle.

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

There is no implemented diagnostics-bundle command that can make an arbitrary state archive safe
to publish. Do not attach or paste:

- `ORCHESTRA_HOME`, `orchestra.db`, SQLite WAL/SHM files, or raw database exports;
- `token`, `agent-token`, `vapid.json`, hook session files, browser storage, or QR/remote URLs;
- provider credentials, login output, environment dumps, keychain output, cookies, or request
  authorization headers;
- raw transcripts, prompts, PTY output, approval parameters, project source, local paths, or
  screenshots containing any of those; or
- `cloudflared.log` or browser/network logs without reviewing and redacting them first.

Replace project, user, host, agent, branch, worktree, and session identifiers with neutral labels
when they are not needed to reproduce the fault. Never post a secret and then rely on editing the
issue later; treat any published credential as exposed.

If a remote-preview token may have been captured, stop the tunnel and daemon. The current preview
has no per-device revocation, so do not resume exposure until the master credential has been
deliberately rotated and affected browser storage has been cleared.

## What this guidance does not prove

These steps help produce a safer bug report. They do not satisfy diagnostics-bundle, support-policy,
upgrade/uninstall, remote-security, or public-release gates.
