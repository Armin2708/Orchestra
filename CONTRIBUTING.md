# Contributing to Orchestra

Thanks for helping! Orchestra is a local daemon + web board that coordinates
multiple coding-agent sessions on the same repository.

## Development setup

```bash
git clone https://github.com/Armin2708/Orchestra.git
cd Orchestra
npm install
cd web && npm install && cd ..

npm test               # vitest — the full suite must pass
npx tsc --noEmit       # server typecheck
cd web && npx tsc --noEmit   # web typecheck
```

Run it locally:

```bash
npm run build && node dist/cli.js serve   # foreground daemon
# or, with a global install: orchestra serve
```

The web UI is served from `web/dist` — rebuild it (`cd web && npm run build`)
after web changes, or the daemon serves a stale bundle.

## Ground rules

- **Tests accompany changes.** Fixes come with a failing-first test; features
  with coverage. `npm test` runs ~2,600 tests and stays green on `main`.
- **New HTTP routes and CLI commands are inventoried.** Add them to
  `docs/agent-os-surface-inventory.json` **and** `.md`, and recompute the
  counts in `docs/remote-mobile-threat-control-matrix.json` from the
  inventory (never hand-increment).
- **Don't weaken auth defaults.** The daemon distinguishes operator, agent,
  and device principals; anything destructive or remote-reachable needs the
  right guard. See `SECURITY.md` for the threat model.
- **Work in a git worktree** for multi-file changes if you run agents on your
  own checkout — that's the tool's own convention.

## Pull requests

- Keep PRs focused; describe what changed and how you verified it.
- CI must be green (typecheck + full test suite on Linux).
- By contributing you agree your contribution is licensed under the
  project's [FSL-1.1-ALv2 license](LICENSE), including its automatic
  conversion to Apache-2.0 two years after each release (inbound = outbound;
  no CLA).

## Reporting bugs

Use the issue templates. For anything security-sensitive, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
