# Agent OS North Star Delivery Program

Status: Milestone A delivered on `codex/northstar-program` at `fce20fc`; Milestone B is next.

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

Deliver Milestone A as one canonical, durable lifecycle shared by Board, Agent OS API, and CLI
launches, with explicit compatibility/ambient classification and human-readable lifecycle truth.

### Delivered

- migration `006` reserves the job, frozen contract version, delivery, workspace assignment,
  workspace, session, policy/profile, and causal identities before provider execution;
- Board, Agent OS API, and CLI launches converge on the same idempotent orchestration service;
- retry, cancellation, restart reconciliation, capacity deferral, provisioning compensation, and
  same-key replay retain one lifecycle;
- operator-only control boundaries prevent agent credentials from launching, hiring, steering, or
  cancelling work;
- authenticated `GET /api/v1/os/jobs/:id` is non-mutating and returns the exact frozen lifecycle
  plus job-scoped, scope-validated causal events;
- the Workspace Cockpit loads that exact job record and never substitutes another workspace/card
  job when a delivery link is absent or invalid;
- strict web normalization rejects incomplete, mismatched, compatibility, or causally inconsistent
  envelopes instead of manufacturing canonical truth.

### Evidence

- commit: `fce20fc` (`feat(orchestration): close canonical lifecycle acceptance`);
- repository suite: 88 files and 526 tests pass on Node 22.20.0;
- focused orchestration/recovery/presentation gate: 5 files and 63 tests pass;
- root and web TypeScript checks pass;
- CLI and production web builds pass;
- same-key replay after a mutable contract edit still returns the frozen Asked version;
- a scheduler-only card job cannot cause the GET endpoint to create a contract or delivery;
- an independent review reproduced and then verified closure of frozen-snapshot, event-scope, and
  cockpit-fallback defects;
- GitNexus staged review reports critical blast radius because shared server/event/UI entrypoints
  are touched; the combined full-suite and independent-review gates passed.

### Remaining

Milestone B starts with the durable Agent Home conversation/event model, provider capture and
recovery, then the Agent Home web/CLI/terminal surface. Milestones C–E remain open; Milestone A does
not by itself make the product public plug-and-play.

## Evidence baseline

- Runtime: Node 22.20.0; repository dependency ABI requires Node 22 rather than the machine's
  unrelated Homebrew Node 26 runtime.
- Environment: no project `.env`, `.env.local`, `web/.env`, or `web/.env.local` files are present.
- Combined Milestone A baseline: 88 test files and 526 tests pass.
- Root/web TypeScript and production builds: clean.
- Primary checkout user changes in `web/src/Board.tsx`, `web/src/styles.css`, and `graphify-out/`
  are outside the isolated program branches and must remain preserved.
