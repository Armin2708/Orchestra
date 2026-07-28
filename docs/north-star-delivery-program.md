# Agent OS North Star Delivery Program

Status: the canonical Milestone A acceptance harness is delivered, while its legacy-launch-removal
summary remains open. Milestone B now has provider-native durable Agent Home capture, controls,
search/export, retention, native fork reconciliation, CLI parity, the responsive visual workspace,
and the integrated privacy/audit blocker closure; its daemon-to-browser restart and current mobile
acceptance gates remain open. Milestone C has typed Job Market contracts, built-in templates, and
an explicit assignment lifecycle bound through jobs, sessions, execution, retry, recovery, and
control projections, the durable Knowledge Compiler persistence foundation, and bounded
repository-document ingestion; Open Work, matching, the complete Job Market gate, and Knowledge
retrieval, compilation, and injection remain open. The product is not yet public plug-and-play.
The versioned subscription-first terminal-agent contract is delivered and its first
capability-aware driver-bridge/support-gate slice is implemented. The canonical Codex adapter,
append-only acceptance store, opt-in no-fallback production wrapper, and authorized restart
recovery are now implemented, but real exact-tuple acceptance, the other three managed adapters,
and the exact declared-provider compatibility matrix remain open.

This document is the source-controlled engineering contract for delivering Orchestra's Agent OS
north star. The terminal, installed CLIs, provider-native behavior, worktree safety, explicit human
attention, and observed evidence remain product invariants throughout the program.

Personal subscription entitlement through a provider's native terminal CLI is the primary managed
execution path. Direct provider-API execution and usage-priced API credentials are optional,
explicit secondary modes and never silent fallback. Claude Code and Codex CLI are the current
managed runtimes; Qwen Code and Kimi Code are first-release targets whose support remains open
until the same versioned provider matrix and real acceptance gates pass.
Provider terms and provider-managed overage are part of that gate: an interactive-only
subscription cannot power background orchestration without permission, and metered overage must
be explicitly visible and consented.
The source-controlled acceptance contract is
[Subscription-first terminal-agent strategy](./provider-subscription-strategy.md).

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
the same Agent Home resumes every declared provider session subject to explicit capability
differences, exposes real PTY state, and supports pause, stop, retry, fork, rename, archive, search,
and provenance-preserving export.

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

**Asked:** a personal subscriber to any declared provider can install Orchestra and complete the
entire North Star journey without repository-maintainer knowledge or usage-priced API fallback.

**Acceptance:** clean macOS and Linux install/upgrade/uninstall, provider doctor and onboarding,
native subscription readiness for every declared provider, exact-commit CI,
migration/backup/recovery, security review, package provenance, public plugin installation where
supported, dogfood, rollback, diagnostics, release notes, and staged beta promotion all pass.

## Current delivery slice

### Asked

Close the known Agent Home durability, fork, privacy, and test-reliability blockers without
weakening the real terminal; add deterministic contract templates; bind the explicit assignment
lifecycle into the managed runtime; and add actionable local readiness diagnostics while keeping
unfinished browser, remote, packaging, and release gates visible. Deliver KNO-001's durable,
board-scoped knowledge-source, chunk, context-build, and context-use persistence without claiming
the retrieval, injection, or operator surfaces that depend on it; then deliver KNO-002's bounded
repository-document ingestion without claiming the remaining Knowledge Compiler.
Then deliver TOOL-013's versioned subscription-first terminal-agent boundary without claiming
provider support or reopening any unsupported provider state. Begin TOOL-014 with a sealed
capability-aware bridge and one exact acceptance gate shared by every present and future provider,
without claiming TOOL-014 complete before real canonical adapters and acceptance evidence exist.

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
- migration `018-knowledge-persistence`, strict contracts, and the standalone `KnowledgeStore`
  persist six board-scoped source, chunk, build, build-evidence, and context-use entities behind
  eight named indexes and 20 integrity triggers;
- migration replay, canonical JSON/hashes, ordering, lifecycle, target coherence, Unicode
  accounting, cross-board isolation, and redacted fail-closed reads/writes are enforced without
  changing terminal, provider, route, or UI behavior.
- the standalone `RepositoryDocumentIngestor` discovers AGENTS, README, documentation,
  convention, and architecture files—including ignored AGENTS files—inside a verified board,
  repository, workspace, revision, and database scope;
- deterministic source/chunk identities distinguish exact committed blobs from scoped working-tree
  content, redact credentials before hashing or persistence, and atomically replay or reject
  conflicts without exposing raw paths, content, or caught errors;
- bounded file/count/byte/depth/entry limits, fixed Git invocation, fsmonitor suppression,
  symlink/hardlink/file-descriptor checks, nested-repository/gitlink exclusions, index/HEAD/DB
  stability checks, and dependency/generated/credential exclusions fail closed against traversal,
  substitution, and time-of-check/time-of-use attacks.
- provider contract version 1 defines executable/version provenance, safe provider-owned
  environment rules, readiness, runtime/billing/credential modes, explicit cost/overage consent,
  models, capabilities, approvals, lifecycle controls, normalized events, usage, and explicit
  unsupported states for the four first-release manifests;
- the gateway assigns each managed session ID before launch/fork, seals authorization evidence,
  rejects cross-domain identity reuse, translates controls/events through the assigned identity,
  and compensates malformed launch/fork output without exposing raw caught errors;
- cancellation settles public pending reads, validates raw iterator completion, contains ordinary
  abort-listener failures, and retains failed or hung cleanup identities inside the 1,024-session
  capacity bound; cooperative cleanup releases identity/capacity before awaited stop returns.
- the first TOOL-014 slice bridges existing `AgentDriver` implementations into the version-1
  provider boundary while preserving sealed launch identity, environment, model, effort, access,
  permission, and cost evidence and rejecting declared capabilities the driver cannot implement;
- Agent OS now owns one support-claim registry that requires the exact provider, adapter/version,
  mode, runtime, billing, credential, executable-version, platform, and source-commit tuple plus
  all eight declared-provider gates before returning a supported adapter;
- managed Claude and Codex spawn environments now apply the contract's subscription-first
  conflict rules, stripping declared usage-priced and cross-provider credential/endpoint variables
  before the native process starts;
- the real Codex app-server adapter is registered as an implementation without claiming support;
  migration 019 persists append-only exact-tuple matrix/artifact evidence and revalidates its
  canonical digest during runtime hydration;
- an opt-in Agent OS production wrapper requires exact source-commit support before dispatch and
  never falls back to the raw driver. The current candidate manifest/mode and absent real matrix
  intentionally prevent that route from enabling;
- authorized Codex restart recovery now reconstructs a single-use resume action from the durable
  Agent OS binding and seals provider session, workspace, cwd, model, effort, access ceiling, and
  cost. The app-server adapter revalidates the active workspace before native resume/read and raw
  attach remains unavailable through the provider contract.

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
- exact KNO-001 code head `72f97b46fc120c4fe82c805c48f765df65b9e62a` passed the
  99-test focused KNO gate, 10-test assignment-replay gate, 15-test store gate, 63-test
  adversarial gate, 136-file / 1,015-test complete serial suite, 6-test documentation drift gate,
  root/web TypeScript, and root/web production builds on Node 22.20.0;
- two independent exact-head reviews reported zero P0, P1, or P2 findings. GitNexus re-indexed
  7,919 symbols, 23,463 relationships, 515 clusters, and 300 flows, then reported LOW change risk
  and zero affected flows against `main`;
- desktop/phone browser acceptance is N/A for KNO-001 because the exact diff contains no UI,
  route, or runtime-control changes;
- the Graphify update for `72f97b4` passed independent review with zero P0, P1, or P2 findings:
  4,692 nodes, 10,970 links, 190 communities, 5 valid hyperedges, 365 manifest entries, zero
  dangling endpoints, exact JSON/HTML/report equivalence, a valid two-run zero-token cost ledger,
  and passing credential, excluded-source, and source-location checks.
- KNO-002 exact code head `2a9acffe3021e7906712a8522ebf6080d2a14563` passed 41 focused
  ingestion tests, 111 Knowledge tests, the complete 138-file / 1,056-test serial suite, root/web
  TypeScript, root/web production builds, per-file Gitleaks, and `git diff --check` on Node
  22.20.0;
- two independent KNO-002 security and provenance/portability reviews reported zero P0, P1, or P2
  findings. GitNexus reported LOW risk and no mapped affected process for the four-file new-code
  slice; browser acceptance is N/A because no UI, route, or runtime-control path changed.
- exact TOOL-013 code head `38d1d2f` passed 105 focused contract tests, the complete 139-file /
  1,161-test serial suite, root and standalone strict test TypeScript, web TypeScript, root/web
  production builds, four Gitleaks scans, and `git diff --check` on Node 22.20.0;
- three independent exact-hash contract, lifecycle, and identity reviews reported zero in-scope
  P0, P1, or P2 findings. GitNexus could not map the new TOOL-013 symbols and returned `UNKNOWN`;
  that stale result was treated as a critical review boundary rather than evidence of low risk.
  Browser acceptance is N/A because TOOL-013 changes no route, UI, or existing runtime wiring.
- the TOOL-014 WIP candidate passed 9 focused files / 78 tests, 5 provider-contract/integration
  files / 131 tests, and the complete 140-file / 1,167-test serial suite on Node 22.20.0; root and
  standalone strict test TypeScript, web TypeScript, root/web production builds, and
  per-file Gitleaks `8.30.1` scans plus `git diff --check` passed;
- the second TOOL-014 Codex/evidence slice passed 6 focused files / 34 tests and the complete
  143-file / 1,179-test serial suite on Node 22.20.0, plus root TypeScript and
  `git diff --check`. It proves exact-version discovery, credential-conflict readiness,
  append-only migration/restart hydration, digest-tamper rejection, accepted contract dispatch,
  and zero raw launches when acceptance is absent;
- the third TOOL-014 recovery slice passed 5 focused files / 123 tests, 11 recovery-adjacent
  files / 204 tests, and the complete 143-file / 1,183-test serial suite on Node 22.20.0.
  It proves single-use resume authorization, access/configuration sealing, zero raw attach
  authority, exact acceptance gating before native recovery, and Agent OS preference for the
  durable recovery seam;
- after re-indexing the candidate, GitNexus reported a formally CRITICAL bridge impact
  (702 symbols, 512 direct, 56 processes, and 20 modules), but its returned relationships were
  demonstrably corrupted and unrelated to the new symbol. The result is retained as a critical
  manual-review boundary, not presented as real low-risk evidence.

### Remaining

- a real daemon-mid-session to browser-continuation E2E gate;
- combined desktop/phone acceptance in the intended in-app Browser surface when that backend is
  available;
- Open Work filters, dependency/critical-path UI, editor/brief preview, collaborative assignment,
  capability/capacity matching, and the complete publish-to-exactly-one-job acceptance gate;
- `KNO-003` through `KNO-027` and `KNO-GATE`, including structural/history/social/graph ingestion,
  retrieval, budgeted injection, freshness, review controls, UI, and benchmarks;
- complete `TOOL-014` by passing and persisting the real exact-source Codex matrix, reconciling its
  candidate manifest only from that evidence, and
  implementing the remaining Claude/Qwen/Kimi adapters. The exact supported-provider/version
  matrix under reopened `BASE-010` remains open, while current default managed behavior remains
  Claude/Codex-only and prior support/policy labels are unchanged;
- Discussions/Q&A, bounded Teams/conflicts, secure DeviceSessions/phone control, token/outcome
  analytics, operations hardening, clean-machine packaging, and release;
- `QA-001` and `QA-013`; the added state-transition tests and Playwright fallback do not cover
  every state machine or the intended desktop/tablet/phone Browser matrix;
- `TOOL-010`; the readiness doctor covers provider compatibility and login but does not yet verify
  installed hook state;
- public package publication and clean-machine plugin/npm installation; the successful hosted
  `QA-019` run proves the frozen engineering commit, not publication or a later release head.

The strict master reconciliation is **128 / 375 checklist boxes delivered; 247 remain open**.
The prior exact-head reconciliation closed `JOB-010`, `PKG-002`, and `PKG-005`; this current
program state closes `KNO-002` and `TOOL-013`, keeps `TOOL-014` open, and keeps `BASE-010`
reopened because the expanded provider target does not yet have an exact compatibility matrix.
The milestone summaries remain 2 / 15; this branch is a verified engineering train, not a public
plug-and-play release.

| Area | Delivered | Open |
|---|---:|---:|
| Phase 0 — Product contract/baseline | 9 / 13 | 4 |
| Phase 1 — Canonical domain/event ledger | 13 / 20 | 7 |
| Phase 2 — Canonical orchestration | 19 / 21 | 2 |
| Phase 3 — Agent Home/conversations | 20 / 21 | 1 |
| Phase 4 — Terminal/workspace parity | 11 / 16 | 5 |
| Phase 5 — Contracts/job market | 12 / 18 | 6 |
| Phase 6 — Delivery Trackbook | 14 / 21 | 7 |
| Phase 7 — Knowledge Compiler | 2 / 28 | 26 |
| Phase 8 — Discussions/Q&A | 4 / 20 | 16 |
| Phase 9 — Teams/conflicts | 0 / 21 | 21 |
| Phase 10 — Tools/permissions | 3 / 15 | 12 |
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
[TOOL-014 authorized recovery WIP checkpoint](./checkpoints/2026-07-28-agent-os-tool014-restart-recovery-wip.md).
The
[TOOL-014 Codex adapter/evidence WIP checkpoint](./checkpoints/2026-07-28-agent-os-tool014-codex-adapter-evidence-wip.md)
is retained as the preceding Codex integration checkpoint.
The first
[TOOL-014 bridge/support-gate checkpoint](./checkpoints/2026-07-27-agent-os-tool014-adapter-integration-wip.md)
is retained as the preceding adapter-integration checkpoint.
The
[TOOL-013 exact-head checkpoint](./checkpoints/2026-07-27-agent-os-tool013-exact-head-38d1d2f.md)
is retained as the preceding provider-contract checkpoint.
The
[KNO-002 exact-head checkpoint](./checkpoints/2026-07-26-agent-os-kno002-exact-head-2a9acff.md)
is retained as the preceding Knowledge ingestion checkpoint.
The
[KNO-001 exact-head checkpoint](./checkpoints/2026-07-26-agent-os-kno001-exact-head-72f97b4.md)
is retained as the preceding Knowledge foundation.
The preceding
[exact-head functional checkpoint](./checkpoints/2026-07-26-agent-os-exact-head-95d11d5.md)
is retained as the prior functional baseline.
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
- KNO-001 exact code head `72f97b46fc120c4fe82c805c48f765df65b9e62a`: 99 / 99
  focused KNO tests, 10 / 10 assignment-replay tests, 15 / 15 store tests, 63 / 63 adversarial
  tests, 136 files / 1,015 tests serially, 6 / 6 baseline-documentation tests, root/web
  TypeScript and production builds, two zero-P0–P2 reviews, and LOW/zero-flow GitNexus change
  detection passed.
- KNO-002 exact code head `2a9acffe3021e7906712a8522ebf6080d2a14563`: 41 / 41 focused
  ingestion tests, 111 / 111 Knowledge tests, 138 files / 1,056 tests serially, root/web
  TypeScript and production builds, per-file Gitleaks, two zero-P0–P2 reviews, and LOW/zero-flow
  GitNexus change detection passed.
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
