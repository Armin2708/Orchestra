# Agent OS North Star Delivery Program

Status: Milestone A is delivered; Milestone B's durable Agent Home domain foundation is delivered
on `codex/northstar-program` through `63efbf3`.

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

Start Milestone B by giving every agent a durable identity, conversation, session link, and ordered
history model that survives restart without weakening terminal or provider behavior.

### Delivered

- migration `007-agent-home-domain` adds durable agent profiles, conversations, enriched session
  ownership/recovery fields, monotonic conversation events, and retained replay-conflict records;
- legacy agents receive deterministic profile and default-conversation identities, while valid
  same-board sessions are linked without replacing compatibility tables;
- invalid cross-board legacy sessions are quarantined as `compatibility/lost`, remain deliberately
  unlinked, retain safe provider control metadata, and carry a machine-readable recovery reason;
- one append path provides session-local sequence allocation, exact replay, durable command-key
  binding, content hashes, causal metadata, scope validation, and preserved conflict evidence;
- replay identity is stable when a provider thread is discovered after an earlier threadless event;
- authenticated APIs expose agent profiles, conversations, sessions, timelines, and aggregate
  Agent Home reads; mutations remain operator-only and reads remain available to agent principals;
- terminal process controls retain the same operator-only boundary: agents may observe PTY state
  but cannot spawn, restart, write, resize, or signal processes.

### Evidence

- commits: `5c289fc` (`feat(agent-os): add durable Agent Home domain and API`) and `63efbf3`
  (`fix(agent-os): harden Agent Home replay and migration`);
- repository suite: 90 files and 535 tests pass on Node 22.20.0;
- focused Agent Home, migration, API, and authorization gate: 4 files and 17 tests pass;
- root TypeScript, CLI build, and production web build pass;
- migration reopen/idempotency coverage proves deterministic backfill and safe quarantine;
- regression coverage proves replay aliases cannot later be reused for different content and that
  mutable session thread discovery cannot manufacture a false replay conflict;
- independent executable review reproduced each prior defect, then returned `PASS`;
- GitNexus staged review reports low indexed flow risk for the hardening patch; the original domain
  integration was separately reviewed as a high-surface migration and route addition.

### Remaining

Milestone B is not complete. Next is provider-native Claude and Codex capture plus restart recovery,
followed by lifecycle actions, search/export, CLI parity, and the additive responsive Agent Home
web surface. Milestones C–E remain open; the product is not yet public plug-and-play.

## Evidence baseline

- Runtime: Node 22.20.0; repository dependency ABI requires Node 22 rather than the machine's
  unrelated Homebrew Node 26 runtime.
- Environment: no project `.env`, `.env.local`, `web/.env`, or `web/.env.local` files are present.
- Combined Milestone B domain baseline: 90 test files and 535 tests pass.
- Root/web TypeScript and production builds: clean.
- Primary checkout user changes in `web/src/Board.tsx`, `web/src/styles.css`, and `graphify-out/`
  are outside the isolated program branches and must remain preserved.
