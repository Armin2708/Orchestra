# Agent OS Canonical Domain

Status: canonical product and compatibility contract.

This document fixes the vocabulary, lifecycle boundaries, actor metadata, retention classes, and
migration rules used by Orchestra's Agent OS. Legacy Board records remain compatibility projections
until their canonical replacement passes the release gates.

## Product statement

Orchestra is a local-first operating system for Claude and Codex work. It preserves unrestricted
real terminals, installed CLIs and tools, provider-native semantics, git/worktree truth, and
observed evidence while adding a visual control plane for durable agents, contracts, delivery,
knowledge, collaboration, attention, and secure remote control.

## Canonical nouns

### AgentProfile

Durable identity owned by a project/operator. Stores the human-readable name, role, provider
preferences, capability declarations, default effort/access policy, status, and provenance. It is
not a provider process or conversation.

### AgentSession

One provider-native execution/conversation lifecycle for an AgentProfile in a WorkspaceAssignment.
Stores provider/thread identifiers, model and effort, effective access, recovery cursors, status,
and context. A profile may have many historical sessions but at most the policy-allowed number of
active sessions.

### Workspace and WorkspaceAssignment

A Workspace is a durable execution root: managed git worktree by default, or an explicitly chosen
shared checkout. WorkspaceAssignment links a contract/job/session to that workspace with access
mode, lifecycle, and timestamps. Card ownership is a Board projection and is not the assignment's
source of truth.

### WorkContract

Versioned request containing objective, stable required/optional deliverables and criteria,
constraints, dependencies, verification commands, base ref, provider/capability needs, policy,
priority, and token/cost/time/retry/coordination budgets. Each launch freezes the answered version.

### Job

One schedulable attempt to execute a WorkContract. It records provider/driver selection, durable
launch profile, assignment/session links, idempotency identity, priority, schedule, attempts,
budgets, usage, recovery, and terminal state. A Job is not a Delivery.

### Delivery

Immutable, revisioned report of what a Job produced against the frozen Asked contract. It separates
agent claims, observed evidence, verifier results, gaps, audited overrides, acceptance, rejection,
and shipped state.

### Discussion and DiscussionPost

Durable question, answer, plan, decision, announcement, or conflict thread with nested posts,
explicit subscriptions/mentions, accepted answer or resolution, provenance, and links to work,
agents, files, symbols, knowledge, and deliveries. Low-level messages remain the targeted wake and
delivery transport.

### Team and PlanningSession

Explicit bounded group of AgentProfiles/Sessions with roles, participant/wake/token/cost budgets,
planning rounds, proposals, critiques, positions, synthesis, delegation, completion condition, and
human escalation. A Team never means all currently live agents.

### Conflict

Durable path, branch, dependency, resource, ownership, or decision collision. It records causal
jobs, participants, affected resources, detection evidence, severity, proposals, arbiter, resolution,
rationale, and follow-up actions.

### KnowledgeItem, ContextBuild, and ContextUse

KnowledgeItem is a content-addressed, attributable, freshness-aware repo fact, decision, convention,
symbol relationship, accepted answer, verified delivery summary, or gotcha. ContextBuild is the
deterministic task-aware selection of items within a token budget. ContextUse records exactly what
was injected, why, its provenance, estimated/actual tokens, cache identity, and outcome.

### ToolCapability

Provider-neutral description of an installed CLI, provider-native tool, MCP server, plugin, skill,
or policy-controlled operation. It reports availability and effective permissions without hiding
provider-specific behavior or proxying arbitrary terminal commands.

### DeviceSession

Named, expiring, scoped and individually revocable remote/browser/phone credential. It stores only
a credential hash plus device identity, scopes, expiry, last seen, revocation, and audit metadata.
It never contains or exposes the operator master token.

### AttentionItem

One actionable human interruption for a question, approval, conflict, failed process/test,
verification gap, blocked job, recovery failure, security event, or review. It has severity,
ownership, exact deep link, and durable resolution.

## Flow classification

| Class | Meaning | Guarantees |
|---|---|---|
| Managed | Created through canonical orchestration | Contract, assignment, session, job, events, delivery and recovery |
| Ambient | Provider/terminal session started outside a WorkContract | Visible identity/chat where available; recovery limits disclosed; never presented as verified managed work |
| Compatibility | Legacy Board/provider behavior retained during migration | Projected into canonical reads/events where possible; feature-flagged; measured for removal |
| Manual | Human terminal/Board action without an agent job | Audited where relevant; never retroactively fabricated into a managed lifecycle |

## Lifecycle states

### WorkContract

`draft → open → assigned → running → submitted → accepted | rejected → archived`

`cancelled` may be entered from draft/open/assigned/running. Rejected work may produce a new Job or
Delivery revision without rewriting the prior request/result.

### Job

`queued → running → succeeded | blocked | cancelled`

`running → queued` is an explicit retry with incremented attempt and causal event. `cancelling` is a
durable intermediate state. Unsupported providers stay queued/deferred with attention rather than
silently falling back. Terminal states never return to running under the same execution identity.

### AgentSession

`reserved → starting → running ↔ idle → stopping → stopped`

`lost` means the daemon cannot reattach and must expose restart/resume options. `failed` means launch
or recovery failed. Ambient sessions may become gone without provider transcript recovery, but their
coordination events remain durable.

### WorkspaceAssignment

`reserved → provisioning → active → releasing → released`

Provision/recovery failure enters `failed`. Dirty worktrees are never implicitly deleted. Shared
checkout assignments require an explicit access decision.

### Delivery

`draft → submitted → verified → accepted` or `submitted|verified → rejected → revised child draft`.

Acceptance requires evidence for every mandatory result or an attributed human override.

### Discussion

`open → answered → resolved → archived`, with `needs_human` and `superseded` as explicit states.

### Conflict

`open → negotiating → resolved | needs_human | superseded`.

### DeviceSession

`pending_pairing → active → expired | revoked`.

## Causal metadata

New Agent OS commands and events use:

- `actor_type` and `actor_id` derived by the service boundary;
- `correlation_id` for one user-visible operation;
- `causation_id` for the preceding command/event;
- contract/card, job, session, assignment/workspace, delivery, discussion, team/conflict, and device
  IDs when applicable;
- versioned event kind/schema and idempotency key;
- UTC creation time and immutable payload/provenance.

Clients may supply an idempotency key but never an authoritative actor identity. Same key plus same
normalized request replays the original result; same key plus different request is a conflict.

## Retention and redaction

| Record | Default |
|---|---|
| Contracts, deliveries, acceptance, shipped records, decisions and audit events | Retain until explicit project deletion |
| Provider conversation events | Soft-archive transcript after 90 days and ephemeral after 7 days; retain audit/pinned canonical events forever |
| Inline provider raw artifacts | Compact strong-kind content after 30 days; preserve paths, hashes, references, and repair provenance |
| PTY output | Bounded rolling storage plus pinned artifacts; do not persist secrets intentionally |
| Artifacts | Content-addressed; retain accepted-delivery and pinned artifacts |
| Context builds/uses and usage | Retain summaries and provenance; allow raw prompt expiry |
| Device sessions/security events | Retain audit history after credential revocation |

Exports, diagnostics, logs, knowledge ingestion, and transcript persistence redact credentials,
tokens, excluded files, and configured secret patterns. Full-access same-user processes are trusted
unless isolated by a separate OS/container identity; an API workflow credential is not an OS
sandbox.

Retention policy is board-scoped and operator-controlled. A sweep uses a caller-selected normalized
`as_of` only for cutoffs and a server-generated application timestamp for archival/audit
chronology. It is bounded to 500 candidates per event/raw/legacy-repair lane, transactional, and
idempotent across restart. It never deletes canonical conversation rows or rewrites event
fingerprints.

Only strongly owned `provider_event`/`provider_raw_event` inline content is eligible. Generic
artifact kinds do not become owned merely through `raw_artifact_id`. Active, paused, or attachable
sessions; explicit artifact pins; accepted-delivery artifact/evidence references; and checkpoint
patches block raw compaction. An audit/pinned event class protects the canonical projection but
does not independently retain an unpinned raw payload after the owning session is detached.
Historical evidence bundles containing raw copies are replaced with idempotent tombstones backed by
original/repaired hashes, byte counts, raw artifact IDs, run identity, and repair time.

## Migration and rollback policy

1. Every schema change is an idempotent forward migration with upgrade and integrity tests.
2. Canonical writes begin behind a migration flag while legacy behavior remains available.
3. Compatibility routes read canonical state or project legacy state without dual authoritative
   mutation when avoidable.
4. Comparison telemetry counts canonical versus legacy reads/writes and mismatches without storing
   sensitive content.
5. A phase becomes default only after Board, CLI, API, provider, restart, and rollback gates pass.
6. Legacy writes are removed only after measured usage reaches zero for the supported window.
7. Rollback never reuses stale sessions, jobs, deliveries, assignments, or device credentials.
8. Dirty worktrees, artifacts, accepted deliveries, and audit events are never silently destroyed.

## Supported first-release surface

- exact validated and experimental Node/npm versions from the
  [supported-environment matrix](supported-environments.md);
- git worktrees;
- Claude SDK/bundled CLI and Codex CLI versions declared in that matrix;
- observed Darwin arm64 and Ubuntu Linux x64 gates; other macOS/Linux targets remain experimental,
  and Windows remains unsupported until its clean-machine and PTY contracts pass;
- local daemon and SQLite, with private Tailscale remote access preferred;
- PWA/browser control before any native mobile application.
