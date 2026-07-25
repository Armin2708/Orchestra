# Agent OS North Star Delivery Program

Status: Milestone A is delivered. Milestone B now has provider-native durable Agent Home capture,
controls, search/export, CLI parity, the responsive visual workspace, and the integrated
privacy/audit blocker closure. Milestone C has its first typed Job Market contract foundation. The
product is not yet public plug-and-play.

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

Finish the usable Agent Home surface without weakening the real terminal, then establish typed,
validated Job Market contracts so requested work can move toward matching, execution, and verified
delivery with an auditable human-readable handoff.

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
  are denied operator transcript/SSE surfaces.

See [Durable Agent Home](./agent-home.md) and [Typed Job Market](./job-market.md).

### Evidence

- Agent Home integration train: `5c289fc`, `63efbf3`, `cacba47`, `6953d97`, `ff86cf4`,
  `72d78c4`, `c785e5d`, `24e984a`, and `fc808b7`;
- typed Job Market integration: `8ae2eeb`;
- blocker/security integration: `f82ab4a`, `a59580d`, `883683f`, and `1b1dfbe`;
- serialized Node 22.20.0 repository gate: 99 test files / 631 tests;
- root and web TypeScript checks, CLI production build, and web production build pass;
- focused final security/auth gate: 7 files / 86 tests;
- `scripts/e2e.sh`, `npm pack --dry-run`, and isolated Codex protocol 0.144.6 verification pass;
- independent regression/security review returned PASS;
- focused migration/controls/Job Market integration: 6 files / 51 tests;
- focused Agent Home controls/UI integration: 10 files / 66 tests;
- independent Playwright acceptance passed at 1440×1000 and 390×844: exact event lookup/context
  focused and highlighted `event-5001`, pause changed Running → Idle, no horizontal overflow, and
  fresh reloads produced zero console/page errors or unhandled mock requests;
- independent reviews returned PASS after migration rollback, dependency completion, event lookup,
  replay safety, workspace audit scope, and lifecycle crash-recovery defects were corrected;
- GitNexus was rebuilt at `1b1dfbe` and reports a critical full-train surface (82 files, 252 changed
  symbols, 88 dependent symbols), so combined tests/builds and browser acceptance remain required
  release evidence.

### Remaining

- Agent Home retention/compaction/raw-event archival policy, provenance-safe native forking, and a
  real daemon-mid-session to browser-continuation E2E gate;
- current combined desktop/phone browser acceptance; the configured browser backend returned zero
  available browsers, so no pass is claimed from the older baseline;
- Open Work filters, dependency/critical-path UI, explicit assignment/release/reassignment,
  templates, editor/brief preview, and capability/capacity matching;
- Knowledge Compiler, Discussions/Q&A, bounded Teams/conflicts, secure DeviceSessions/phone
  control, token/outcome analytics, operations hardening, clean-machine packaging, and release.

The strict master reconciliation is 106 / 373 checklist boxes delivered. Milestones C–E remain
open; this branch is a verified engineering train, not yet a public plug-and-play release.

The safe multi-agent continuation point, including the integrated blocker/security closure and the
still-open browser gate, is recorded in the
[2026-07-25 major handoff](./checkpoints/2026-07-25-agent-os-major-handoff.md).

## Evidence baseline

- Runtime: Node 22.20.0; the repository dependency ABI requires Node 22 rather than the machine's
  unrelated Homebrew Node 26 runtime.
- Environment: no project `.env`, `.env.local`, `web/.env`, or `web/.env.local` files are present.
- Combined current baseline: 99 test files / 631 tests pass serially.
- Root/web TypeScript and production builds: clean.
- The default parallel suite remains tracked by `QA-020`; this slice used the deterministic serial
  gate.
- Primary checkout user changes remain outside this isolated worktree and were not modified.
