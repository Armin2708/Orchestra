# Agent OS Exact-Head Functional Checkpoint — 2026-07-26

Status: **exact-head local engineering evidence only**. This checkpoint reconciles combined
evidence through `95d11d5892523b0f742eb098563ba92b13e65ba4` on
`codex/northstar-program`. It is not package publication, a release, or a public plug-and-play
claim.

## TL;DR

| State | Observed result |
|---|---|
| Exact code head | `95d11d5892523b0f742eb098563ba92b13e65ba4` |
| Backlog reconciliation | **126 / 373 delivered; 247 open** |
| Newly evidenced | `JOB-010`, `PKG-002`, and `PKG-005` only |
| Complete test suites | Serial and default-parallel: 134 files / 979 tests each |
| Focused combined gate | 31 files / 288 tests |
| TypeScript/build/E2E | Root and web TypeScript, root and web production builds, and credential-free E2E passed |
| Browser evidence | In-app Browser inventory `[]`; labeled Playwright fallback passed its observed desktop/phone flows |
| Package identity | 35 files; 616,570 bytes; SHA-256 `4a6fdf21238ba8d82e890cc4413f472db28c01c08f0f96a28e07aafc143393d4` |
| Provider readiness | Claude passed; installed Codex `0.145.0` correctly failed closed against pinned `0.144.6` |
| Consumer audit | Four moderate Hono dependency nodes; zero high; zero critical |
| Public registry | `orchestra-board` lookup returned `E404` |
| Independent review | PASS in-session; no retained reviewer artifact |
| Publication/release | Open |

## Asked

Integrate and verify the complete assignment lifecycle, actionable environment readiness, terminal
and drawer reliability, and truthful packaging boundaries without weakening real PTY/CLI behavior
or converting partial browser, diagnostics, packaging, or release foundations into unsupported
backlog credit.

## Delivered

- Migration `017-job-assignment-runtime-binding` and the managed runtime freeze one exact
  assignment/profile/market-version identity across job, session, orchestration, provider
  execution, retry, cancellation, recovery, fork, workspace mutation, Agent Home controls, and
  projections.
- Genuine assigned task projection returns `job_assignment_id`, `assigned_profile_id`, and
  `assignment_market_version`; partial or corrupt projection fails closed to ambient presentation.
- The existing claim, assign, release, and atomic reassign history is now connected to execution,
  satisfying the full wording of `JOB-010`. Open Work, matching, collaborative ownership, and
  `JOB-GATE` remain separate open work.
- `orchestra doctor` detects Node, git, selected Claude/Codex availability and versions, provider
  login state, and SDK/protocol incompatibility. Required failures are fail-closed and carry
  actionable remediation without raw credential or local-path disclosure, satisfying `PKG-002`
  and `PKG-005`.
- Bounded terminal Stop uses the supervised graceful-to-forceful shutdown path, raw signal remains
  distinct, resize/exit races are handled, and operator/agent authorization boundaries remain
  enforced.
- Card-drawer owner markup is valid, and provider controls/options are contained on desktop and
  390×844 phone layouts.
- Packaging documentation describes the engineering preview, local telemetry, remote master-token
  limits, recoverable state retirement, and support boundaries without claiming public
  distribution or safe device pairing.

## Evidence

### Automated combined gate

- Node runtime:
  `/Users/arminrad/.nvm/versions/node/v22.20.0/bin/node`.
- Complete serial suite: 134 files / 979 tests passed.
- Complete default-parallel suite: 134 files / 979 tests passed.
- Focused migration, lifecycle, native-event, approval, API, search/export, terminal, packaging,
  readiness, and UI suite: 31 files / 288 tests passed.
- Root and web TypeScript checks passed.
- Root and web production builds passed.
- Credential-free end-to-end smoke passed.
- Independent read-only combined and CSS-delta regression/security reviews passed in this
  orchestration session; no retained reviewer artifact was produced.

### Browser evidence boundary

- The in-app Browser inventory was exactly `[]`; no in-app Browser result is inferred.
- At exact head `35b68fe`, the labeled Playwright fallback passed the full desktop/phone
  assignment and Agent Home journey, including terminal Stop/Restart/resize and deep links, but
  exposed phone provider-control overflow.
- At exact head `95d11d5`, the fallback directly rechecked desktop/phone drawer containment, the
  deep link, all seven phone workspace panes, real PTY input/output, bounded Stop, restart with a
  new PID, zero console errors, and all observed APIs returning `200`.
- This evidence does not cover the intended in-app Browser backend or the complete
  desktop/tablet/phone matrix, so `QA-013` remains open.

### Package and provider evidence

- Exact-head tarball: `orchestra-board@0.1.0`.
- Contents: 35 files.
- Size: 616,570 bytes.
- SHA-256:
  `4a6fdf21238ba8d82e890cc4413f472db28c01c08f0f96a28e07aafc143393d4`.
- Isolated clean-consumer install, CLI/version/help, and doctor diagnostic smoke behaved as
  expected.
- Claude operator readiness passed. Overall both-provider readiness intentionally remained
  unsupported because installed Codex `0.145.0` correctly failed closed against the managed
  protocol contract pinned to supported `0.144.6`.
- Clean-consumer audit reported four moderate dependency nodes from transitive Hono advisory
  `GHSA-frvp-7c67-39w9`, with zero high and zero critical findings. No unsafe dependency override
  or release waiver was integrated.
- The public npm registry recheck returned `E404` for `orchestra-board`.

## Backlog reconciliation

| Area | Previous | Current | Evidence-backed change |
|---|---:|---:|---|
| Entire backlog | 123 / 373 | 126 / 373 | +3 delivered; 247 open |
| Phase 5 — Contracts/job market | 11 / 18 | 12 / 18 | `JOB-010` |
| Phase 16 — Packaging/docs | 5 / 19 | 7 / 19 | `PKG-002`, `PKG-005` |
| Release milestone summaries | 2 / 15 | 2 / 15 | No change |

No other box changes in this reconciliation:

- `QA-001` remains open because the added runtime transition tests do not cover every state machine
  and transition guard.
- `QA-013` remains open because Playwright fallback is not the intended in-app Browser proof and no
  complete tablet matrix was observed.
- `TOOL-010` remains open because the readiness doctor does not yet verify installed hook state.
- Public packaging, clean-machine lifecycle, provenance, tagging, dogfood, staged promotion, and
  every release item remain open.

## Asked versus Delivered

| Asked outcome | Delivered now | Remaining |
|---|---|---|
| Explicit assignment responsibility reaches execution | Claim/assign/release/reassign identity is frozen and enforced across the managed runtime | Open Work, matching, Teams, and `JOB-GATE` |
| Detect incompatible local prerequisites and explain fixes | Full operator readiness checks with fail-closed structured remediation | Installed-hook verification, first-run wizard, and clean-machine lifecycle |
| Preserve real terminal behavior while hardening controls | Real PTY input/output, bounded Stop, raw signals, restart, and resize/exit races verified | Full terminal journey gate and intended Browser proof |
| Produce an installable engineering artifact | Exact tarball identity and isolated clean-consumer functional checks | Public npm/plugin publication, provenance, clean-machine install/upgrade/uninstall, and release |

## Remaining

- Keep `QA-001`, `QA-013`, `TOOL-010`, all public-release items, and all unsupported milestone
  summaries open.
- Resolve or wait for an upstream-safe fix for the transitive Hono advisory before any
  zero-vulnerability release evidence.
- Continue dependency-ordered work with Open Work/matching and the Knowledge Compiler; this
  checkpoint does not advance those boxes.
