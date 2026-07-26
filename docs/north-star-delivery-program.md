# Agent OS North Star Delivery Program

Status: the canonical Milestone A acceptance harness is delivered, while its legacy-launch-removal
summary remains open. Milestone B now has provider-native durable Agent Home capture, controls,
search/export, retention, native fork reconciliation, CLI parity, the responsive visual workspace,
and the integrated privacy/audit blocker closure; its daemon-to-browser restart and current mobile
acceptance gates remain open. Milestone C has typed Job Market contracts, built-in templates, and
an explicit assignment lifecycle bound through jobs, sessions, execution, retry, recovery, and
control projections; Open Work, matching, the complete Job Market gate, and the Knowledge Compiler
remain open. The product is not yet public plug-and-play.

This document is the source-controlled engineering contract for delivering Orchestra's Agent OS
north star. The terminal, installed CLIs, provider-native behavior, worktree safety, explicit human
attention, and observed evidence remain product invariants throughout the program.

## Handoff contract

Every implementation slice begins with:

- **Asked**: the user-visible outcome and backlog IDs in scope;
- **Deliverables**: concrete data, service, API/CLI, UI, documentation, and migration changes;
- **Evidence plan**: tests, builds, browser flows, security checks, and compatibility checks that
  must pass before the slice may be reported complete.

Every implementation slice ends with:

- **Delivered**: what exists in the verified commit;
- **Evidence**: exact observed checks and artifacts;
- **Remaining**: gaps, known limits, deferred work, and the next dependency-ordered slice.

Agent claims never close a task without observed evidence or an explicitly attributed human
override. Source branches are integrated only after GitNexus change review and the combined suite.

## Release train

### Milestone A — Coherent kernel

**Asked:** one canonical lifecycle powers Board, CLI, API, and contracted direct-hire work.

**Acceptance:**

- every managed run durably links contract, workspace assignment, session, job, delivery, and
  causal events before provider execution;
- provider, model, effort, access profile, policy, dependency state, budgets, and idempotency are
  validated without silent fallback;
- duplicate requests, daemon restart, cancellation, retry, timeout, capacity, and compatibility
  routes preserve one observable lifecycle;
- unattached hired agents are explicitly ambient/external rather than represented as managed work;
- legacy writes remain feature-gated until comparison telemetry proves safe removal.

### Milestone B — Usable Agent OS

**Asked:** every agent has one durable home with chat, terminal, work, context, tools, usage, and
history.

**Acceptance:** normalized provider events and coordination chat survive daemon/browser restart;
the same Agent Home resumes Claude and Codex sessions, exposes real PTY state, and supports pause,
stop, retry, fork, rename, archive, search, and provenance-preserving export.

### Milestone C — Collaborative intelligence

**Asked:** agents can find work, retrieve repo knowledge, ask and answer structured questions,
plan in bounded teams, and resolve conflicts without uncontrolled fanout.

**Acceptance:** contracts and dependencies drive an Open Work view; the Knowledge Compiler injects
cited, fresh, budgeted context; discussions support accepted answers and promotion; teams retain
roles, budgets, proposals, synthesis, conflicts, resolution, and one integrated delivery.

### Milestone D — Safe remote beta

**Asked:** the command center and phone surface support safe monitoring, messaging, approval, and
agent control.

**Acceptance:** named device sessions use expiring, scoped, revocable credentials; pairing never
places the master token in a URL; terminal write and destructive actions require step-up approval;
offline mode is visibly read-only; every remote mutation carries device attribution.

### Milestone E — Public plug-and-play

**Asked:** a Claude or Codex subscriber can install Orchestra and complete the entire North Star
journey without repository-maintainer knowledge.

**Acceptance:** clean macOS and Linux install/upgrade/uninstall, provider doctor and onboarding,
exact-commit CI, migration/backup/recovery, security review, package provenance, public plugin
installation, dogfood, rollback, diagnostics, release notes, and staged beta promotion all pass.

## Current delivery slice

### Asked

Close the known Agent Home durability, fork, privacy, and test-reliability blockers without
weakening the real terminal; add deterministic contract templates; bind the explicit assignment
lifecycle into the managed runtime; and add actionable local readiness diagnostics while keeping
unfinished browser, remote, packaging, and release gates visible.

### Delivered

- migrations `007-agent-home-domain` and `008-agent-home-controls` provide durable profiles,
  conversations, managed/ambient sessions, ordered events, replay conflict evidence, lineage,
  persisted control state, and idempotent lifecycle actions;
- managed launches bind one Agent Home identity before Claude or Codex starts;
- provider-native Codex notifications and Claude stream/control events enter the durable
  conversation ledger before bounded transcript projection, preserving provider identity,
  cursors/resume metadata, provenance, and redaction state;
- pause, resume, stop, retry, rename, archive, stable search, direct exact-event lookup,
  provenance-preserving export, canonical deep links, and CLI parity are implemented;
- one responsive Agent Home route exposes Chat, real Terminal, Work, Context, Tools, Usage,
  History, attention, provider health, and exact contract/job/workspace/process state;
- migration `009-job-market-domain` and `JobMarketService` add typed criteria, verifier/artifact
  requirements, capability/provider/model/access constraints, complete budgets, dependency rules,
  lifecycle validation, optimistic concurrency, and workspace-scoped field audit events;
- publish and launch reject incomplete dependencies or invalid constraints before creating durable
  job/session/assignment records; API and CLI support contract show/set/validate/publish/transition;
- recoverable lifecycle auditing, safe transcript projection, and durable Codex approval outcomes
  are integrated in the required order;
- migrations `010-agent-home-redaction` and `011-managed-driver-event-redaction` repair legacy
  projections and managed driver events while preserving visible safe transcript text;
- managed `os_events` exclude raw approval parameters, credentials, Codex reasoning, and Claude
  thinking, while authenticated operators retain the complete live approval form and agent tokens
  are denied operator transcript/SSE surfaces;
- migrations `012-agent-home-retention`, `013-agent-home-structured-metadata-redaction`,
  `014-agent-home-native-fork-lifecycle`, and `015-agent-home-action-command-scope` add bounded
  retention/repair, safe structured projections, provider-native Claude/Codex fork, parked-child
  adoption, operator reconciliation, and globally scoped replay identity;
- six deterministic contract templates support strict preview, compare-and-set apply,
  credential-safe audit projection, and exact lost-response replay;
- migration `016-job-market-assignment-lifecycle` and the assignment API/CLI add exclusive claim,
  assign, release, and atomic reassign history with version guards and integrity triggers;
- migration `017-job-assignment-runtime-binding` freezes one exact assignment/profile/market-version
  identity into the durable job and managed session, then verifies it across orchestration,
  provider dispatch, retry, recovery, cancellation, fork, workspace mutation, Agent Home control,
  task API, and UI projections;
- new assigned work fails closed on stale, partial, substituted, archived, or cross-workspace
  identity, while already-created jobs retain their immutable execution identity across later
  market changes;
- `orchestra doctor` now detects Node, git, Claude and Codex availability and versions,
  provider login/readiness, SDK/protocol compatibility, and returns fail-closed actionable
  remediation without exposing credential material;
- terminal Stop/resize behavior is race-safe and preserves the raw signal path; card-drawer owner
  and provider controls remain valid and contained on desktop and phone;
- the default parallel test suite is deterministic, verified delivery summaries are available for
  later knowledge ingestion, and the release workflow retains and verifies the tested package
  artifact instead of rebuilding it before publication.

See [Durable Agent Home](./agent-home.md) and [Typed Job Market](./job-market.md).

### Evidence

- Gate C passed from a fresh detached checkout of
  `ddbb3fc05853f51f045ae329a44979810e1387f8` on Node 22.20.0: 23 focused files / 200 tests,
  121 files / 822 tests serially, and three fresh default-parallel runs at 121 / 822 each;
- the same Gate C passed root/web TypeScript and production builds, credential-free E2E, package
  pack/install/publish dry-runs from one retained 539,638-byte tarball, audits, Actionlint,
  merge-aware Gitleaks, Codex protocol 0.144.6, and both-provider doctor;
- the reviewed JOB-010 phase-one candidate passed 20 focused files / 151 tests, the complete serial
  and default-parallel suites at 125 files / 850 tests, root/web TypeScript and production builds,
  and independent P0–P2 review;
- `0c1323780b5f776eb419c4dabbbe42b2bcf1c0ee` has the byte-identical reviewed tree and passed an
  exact-integration 9-file / 73-test gate plus root/web TypeScript;
- exact head `95d11d5892523b0f742eb098563ba92b13e65ba4` passed the complete Node 22.20.0
  suite in both serial and default-parallel modes at 134 files / 979 tests, the combined focused
  gate at 31 files / 288 tests, root/web TypeScript and production builds, and the credential-free
  end-to-end smoke;
- in-app Browser inventory remained exactly `[]`. At exact head `35b68fe`, the configured
  Playwright fallback passed the full desktop/phone assignment and Agent Home journey, including
  terminal Stop/Restart/resize and deep links, but exposed phone provider-control overflow. At
  exact head `95d11d5`, it directly rechecked desktop/phone drawer containment, the deep link, all
  seven phone workspace panes, real PTY input/output, bounded Stop, restart with a new PID, zero
  console errors, and all observed APIs returning `200`. `QA-013` stays open because fallback
  evidence does not prove the unavailable in-app Browser surface or the complete
  desktop/tablet/phone requirement;
- one exact-head `orchestra-board@0.1.0` tarball contained 35 files, measured 616,570 bytes, and had
  SHA-256 `4a6fdf21238ba8d82e890cc4413f472db28c01c08f0f96a28e07aafc143393d4`;
  isolated clean-consumer install, CLI/version/help, and doctor diagnostic smoke behaved as
  expected;
- Claude readiness passed. Overall both-provider readiness intentionally remained unsupported
  because installed Codex `0.145.0` correctly failed closed against the pinned supported `0.144.6`
  protocol instead of silently claiming compatibility;
- clean-consumer audit reported one transitive Hono advisory as four moderate dependency nodes,
  with zero high or critical findings. This remains a release blocker, not a zero-vulnerability
  claim;
- the public npm registry recheck in the exact-head gate returned `E404` for `orchestra-board`.

### Remaining

- a real daemon-mid-session to browser-continuation E2E gate;
- combined desktop/phone acceptance in the intended in-app Browser surface when that backend is
  available;
- Open Work filters, dependency/critical-path UI, editor/brief preview, collaborative assignment,
  capability/capacity matching, and the complete publish-to-exactly-one-job acceptance gate;
- every `KNO-*` item, including durable source/chunk/context schemas, ingestion, retrieval,
  provenance, budgeted injection, freshness, review controls, UI, and benchmarks;
- Discussions/Q&A, bounded Teams/conflicts, secure DeviceSessions/phone control, token/outcome
  analytics, operations hardening, clean-machine packaging, and release;
- `QA-001` and `QA-013`; the added state-transition tests and Playwright fallback do not cover
  every state machine or the intended desktop/tablet/phone Browser matrix;
- `TOOL-010`; the readiness doctor covers provider compatibility and login but does not yet verify
  installed hook state;
- public package publication and clean-machine plugin/npm installation; the successful hosted
  `QA-019` run proves the frozen engineering commit, not publication or a later release head.

The strict master reconciliation is **126 / 373 checklist boxes delivered; 247 remain open**.
This exact-head batch newly closes only `JOB-010`, `PKG-002`, and `PKG-005`.
The milestone summaries remain 2 / 15; this branch is a verified engineering train, not a public
plug-and-play release.

| Area | Delivered | Open |
|---|---:|---:|
| Phase 0 — Product contract/baseline | 10 / 13 | 3 |
| Phase 1 — Canonical domain/event ledger | 13 / 20 | 7 |
| Phase 2 — Canonical orchestration | 19 / 21 | 2 |
| Phase 3 — Agent Home/conversations | 20 / 21 | 1 |
| Phase 4 — Terminal/workspace parity | 11 / 16 | 5 |
| Phase 5 — Contracts/job market | 12 / 18 | 6 |
| Phase 6 — Delivery Trackbook | 14 / 21 | 7 |
| Phase 7 — Knowledge Compiler | 0 / 28 | 28 |
| Phase 8 — Discussions/Q&A | 4 / 20 | 16 |
| Phase 9 — Teams/conflicts | 0 / 21 | 21 |
| Phase 10 — Tools/permissions | 2 / 13 | 11 |
| Phase 11 — Visual command center | 1 / 18 | 17 |
| Phase 12 — Token/outcome analytics | 1 / 17 | 16 |
| Phase 13 — Secure remote/mobile | 1 / 21 | 20 |
| Phase 14 — Reliability/security/ops | 1 / 23 | 22 |
| Phase 15 — Quality gates | 8 / 21 | 13 |
| Phase 16 — Packaging/docs | 7 / 19 | 12 |
| Phase 17 — Public release | 0 / 17 | 17 |
| Phase 18 — Deferred | 0 / 10 | 10 deferred |
| Release milestone summaries | 2 / 15 | 13 |

The current continuation point is the
[exact-head functional checkpoint](./checkpoints/2026-07-26-agent-os-exact-head-95d11d5.md).
The
[hosted QA-019 checkpoint](./checkpoints/2026-07-25-agent-os-hosted-qa019.md)
is retained as the preceding exact-hosted checkpoint.
The
[local Gate C and JOB-010 phase-one checkpoint](./checkpoints/2026-07-25-agent-os-local-gate-c-job010-phase-one.md)
is retained as the preceding local-evidence checkpoint.
The [major blocker handoff](./checkpoints/2026-07-25-agent-os-major-handoff.md) is retained as
superseded history.

## Evidence baseline

- Runtime: Node 22.20.0; the repository dependency ABI requires Node 22 rather than the machine's
  unrelated Homebrew Node 26 runtime.
- Environment: no project `.env`, `.env.local`, `web/.env`, or `web/.env.local` files are present.
- Gate C base `ddbb3fc`: 121 files / 822 tests serially and in three fresh default-parallel runs;
  root/web TypeScript and production builds are clean.
- JOB-010 phase-one code head `0c13237`: reviewed-tree full suites are 125 files / 850 tests
  serially and default-parallel; exact-integration focused checks are 9 files / 73 tests plus
  root/web TypeScript.
- Hosted QA-019 head `3c543b52a32109747d5f0fa1521188380c55fa93`: hosted run
  `30171494794` passed all 21 required exact-commit gates; serial and default-parallel suites each
  passed 127 files / 890 tests, and retained evidence/package artifacts reproduced independently.
- Current exact local head `95d11d5892523b0f742eb098563ba92b13e65ba4`: serial and
  default-parallel suites each passed 134 files / 979 tests; the focused combined gate passed
  31 files / 288 tests; root/web TypeScript, production builds, and credential-free E2E passed.
- `QA-019` and `QA-020` are delivered. A later release candidate still needs its own exact-head
  hosted run; this checkpoint does not prove publication, provenance, tagging, or release.
- Browser and mobile gates remain open because the intended in-app Browser backend is unavailable;
  its inventory was exactly `[]`. The labeled Playwright fallback passed the complete
  assignment/Agent Home journey at `35b68fe` and directly rechecked the terminal, deep-link,
  seven-pane phone workspace, and drawer-containment delta at `95d11d5`.
- The exact-head package/doctor evidence closes only `PKG-002` and `PKG-005`; clean-machine
  package lifecycle, diagnostics, public distribution, and every release item remain open.
- Public npm installation is unavailable while `orchestra-board` returns `E404`.
- Primary checkout user changes remain outside this isolated worktree and were not modified.
