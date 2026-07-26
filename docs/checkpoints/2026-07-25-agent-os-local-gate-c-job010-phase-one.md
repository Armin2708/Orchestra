# Agent OS Local Gate C and JOB-010 Phase-One Checkpoint — 2026-07-25

Status: **local engineering checkpoint only**. The tested code head is
`0c1323780b5f776eb419c4dabbbe42b2bcf1c0ee` on `codex/northstar-program`. This is
not hosted exact-commit evidence, not a release, and not a public plug-and-play claim.

## TL;DR

| State | Observed result |
|---|---|
| Backlog reconciliation | **122 / 373 delivered; 251 open** |
| Gate C base | `ddbb3fc05853f51f045ae329a44979810e1387f8` — PASS |
| JOB-010 phase-one integration | `0c1323780b5f776eb419c4dabbbe42b2bcf1c0ee` — reviewed assignment foundation integrated |
| JOB-010 overall | Open — runtime/job/session/executor/recovery binding is not implemented |
| Knowledge Compiler | Open — every `KNO-*` box remains unchecked |
| Hosted exact-commit gate | Open — `QA-019` has no successful hosted run for this head |
| Browser/mobile gate | Open — in-app inventory was empty; Playwright fallback passed desktop and failed phone |
| Public install | Unavailable — npm returned `E404` for `orchestra-board` |

## Asked

Preserve the real PTY, installed provider CLIs, safe transcript/audit behavior, and worktree
isolation while closing the local release gate and adding explicit claim, assignment, release, and
reassignment as the first JOB-010 slice.

## Delivered

- Gate C verifies the blocker/security, deterministic-test, exact-artifact, verified-summary, and
  contract-template train through `ddbb3fc`.
- Migration `016-job-market-assignment-lifecycle` adds immutable exclusive assignment history,
  market/assignment compare-and-set guards, frozen nullable job/session identity columns, and
  integrity triggers.
- `JobAssignmentService`, authenticated API routes, and CLI commands implement claim, assign,
  release, reassign, list, and current-assignment operations with durable idempotency.
- The reviewed JOB-010 phase-one source commit `4b3aef1d187104da2273da6bdb4ea5dbc57929fa`
  and integrated commit `0c1323780b5f776eb419c4dabbbe42b2bcf1c0ee` have the identical tree
  `399d4009f24a0660079d699755ba9721a0dee10c`.
- Phase one deliberately does not bind the assignment through canonical launch, scheduler jobs,
  managed sessions, executor dispatch, restart recovery, or retry. No JOB-010 backlog box is
  closed by this partial slice.

## Observed evidence

### Gate C at `ddbb3fc`

The gate ran from a fresh detached checkout with Node `22.20.0`, npm `10.9.3`, and a temporary
pinned Codex CLI `0.144.6`.

| Gate | Result |
|---|---|
| Focused matrix | PASS — 23 files / 200 tests |
| Complete serial suite | PASS — 121 files / 822 tests |
| Default parallel suite | PASS three fresh times — 121 files / 822 tests each |
| Root/web TypeScript and production builds | PASS |
| Credential-free shell E2E | PASS |
| Package pack, install, and publish dry-runs | PASS from one retained tarball |
| Root/web dependency thresholds | PASS — root had 3 moderate findings; web had 0 vulnerabilities |
| Actionlint and merge-aware Gitleaks | PASS |
| Codex protocol and both-provider doctor | PASS — 671 protocol files; doctor `ready: true` |
| Independent regression/security review | PASS — no P0–P2 finding |

Retained package identity:

- file: `orchestra-board-0.1.0.tgz`;
- size: `539638` bytes;
- SHA-256: `fa32482a706fda8b3a72052178869641b53d0db1809e1184a8ca350594f0ba4a`;
- npm SHA-1: `941ad7f0f1adfc9d408115cf9081dd5266ff413a`;
- npm integrity:
  `sha512-MvXcNe8PFk5RwoQLhs9+WoHyBCyJ5QVhNFhl1qJHdsrh0TtUHglJ/xI8hmmflaMDK7nK9ndf/oEpHWTUh2E7hg==`;
- local evidence manifest SHA-256:
  `914859bb6f05c72abd222db38ad463a3cf7ad0b5c179d3489d02de38ceb2ee23`.

The package wrapper initially treated normal npm lifecycle output on stderr as a harness failure
after `npm pack` itself had exited zero. The existing JSON and tarball were validated without
rerunning the command; no required product-gate failure was retried or hidden.

### JOB-010 phase one at `0c13237`

| Gate | Result |
|---|---|
| Reviewed source-candidate focused gate | PASS — 20 files / 151 tests |
| Reviewed source-candidate complete serial suite | PASS — 125 files / 850 tests |
| Reviewed source-candidate default-parallel suite | PASS — 125 files / 850 tests |
| Reviewed source-candidate root/web TypeScript and builds | PASS |
| Independent P0–P2 review | PASS |
| Exact integration focused gate | PASS — 9 files / 73 tests |
| Exact integration root/web TypeScript | PASS |
| Source/integration tree comparison | PASS — identical tree ID |

### Browser acceptance

- The in-app Browser inventory was `[]`, so it supplied no acceptance result.
- The configured Playwright MCP fallback at exact `ddbb3fc` passed desktop acceptance.
- Phone acceptance failed with two P1 defects: mobile hides pause/resume/stop/retry, and a paused
  idle session renders Pause/Stop rather than Resume.
- It also found one P2 defect: a card deep link canonicalizes to `/`, so refresh loses the drawer.
- The run observed zero console warnings/errors, zero page errors, and HTTP 200 for all observed
  API requests.
- Checkpoint-time fallback evidence was stored at
  `/private/tmp/agentboard-browser-evidence-ddbb3fc`; it is local evidence, not a hosted artifact.

## Asked versus Delivered

| Asked outcome | Delivered now | Remaining |
|---|---|---|
| Reliable combined release evidence | Strong local Gate C with exact artifact identity | Hosted exact-SHA workflow evidence and clean-machine release gates |
| Explicit ownership lifecycle | Durable phase-one claim/assign/release/reassign history | End-to-end runtime binding and the JOB-010 gate |
| Responsive remote control | Desktop fallback passed | Phone controls, paused-state semantics, deep-link persistence, and intended-browser acceptance |
| Public plug-and-play install | Local package smoke only | Publish npm package, verify plugins, provenance, dogfood, rollback, and staged release |

The checkpoint advances the engineering train but does not change the release verdict: Orchestra is
not yet shippable or public plug-and-play.
