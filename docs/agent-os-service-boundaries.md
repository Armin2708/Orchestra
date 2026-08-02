# Agent OS focused service boundaries

Status: integrated Beta Lane A and Lane C boundaries, observed at exact code head
`3f8aed8a3b5af29c2dcbfaec634277cd32473034`.

## TL;DR

Agent OS exposes one typed ten-domain composition catalog. Discussions, managed Knowledge, and
durable conflict resolution are canonical services; low-level messages and advisory overlap
detection remain separate compatibility surfaces. Device pairing is a canonical executable
boundary backed by `SqliteDeviceSessionRepository`; its DeviceSession credential lifecycle is
separate from the excluded operator master-token QR bootstrap.

| Boundary | Implementation state | Current service | Explicitly not claimed |
|---|---|---|---|
| `orchestration` | `canonical` | `OrchestrationService` | provider runtime implementation, route authentication, legacy projection |
| `conversations` | `canonical` | `ConversationService` | wake transport, provider process control, Discussion lifecycle |
| `deliveries` | `canonical` | `DeliveryReportService` | job scheduling, legacy review controls, Knowledge promotion |
| `discussions` | `canonical` | `DiscussionService` | low-level wake transport, implicit broadcast, tool-capable prompt injection |
| `knowledge` | `canonical` | `KnowledgeService` plus compiler/runtime bridges | unreviewed arbitrary-text promotion, provider token estimates presented as actual usage |
| `organization` | `canonical` | `OrganizationService` | work assignment identity, provider runtime identity, implicit authority from capability or seniority labels |
| `coordination` | `canonical` | `OrganizationCoordinationService` | wake transport, implicit broadcast, acknowledgement loops, self-approval |
| `assurance` | `canonical` | `OrganizationAssuranceService` | activity-volume ranking, self-review, hidden overrides, blame from incident learning |
| `conflicts` | `canonical` | `PlanningTeamService` | last-write-wins resolution, self-approved knowledge promotion, unbounded negotiation fanout |
| `device_pairing` | `canonical` | `SqliteDeviceSessionRepository` | operator master-token QR bootstrap, broad bearer persistence, unclassified remote reads or mutations |

## Contract

`createAgentOsDomainServiceBoundaries(db, options)` returns an immutable catalog in
`src/agent-os/service-boundaries.ts`. Each active boundary has:

- one stable domain name;
- an implementation state separate from product aspiration;
- a narrow structural service type;
- explicit owned responsibilities and exclusions;
- an independently injectable service instance.

The active device-pairing boundary owns single-use PairingTickets, named scoped DeviceSessions,
expiry, revocation, and device attribution. Route and service authorization remain default-deny and
stay outside the credential repository's authority.

## Current runtime use

The canonical orchestration, Agent Home conversation, Delivery Trackbook, Discussions, Knowledge,
Teams, and conflict implementations remain authoritative in their focused modules. Knowledge adds
bounded compiler/runtime bridges, live-head freshness, review controls, exact-source promotion,
and token receipts to its durable persistence and deterministic retrieval foundation. Discussion
acceptance and Knowledge promotion remain distinct commands with a separate review decision.

The compatibility `GET /api/v1/os/boards/:id/conflicts` response still delegates advisory overlap
detection to `ComputedWorkspaceConflictService` for its two existing overlap kinds:

- `execution_root`;
- `owned_paths`.

Canonical durable conflicts use `PlanningTeamService` and its separate `/team-conflicts` command
surface. Conflict participants, proposals, arbitration rationale, resolution, follow-up, and
reviewable Knowledge candidates are persisted without converting advisory overlap observations.

## Deliberate non-goals

- The credential repository does not grant broad route access, treat the operator master token as a
  DeviceSession credential, or close native-device and production-operations acceptance gates.
- Exact route/resource classification, step-up enforcement, mutation audit, and abuse controls stay
  in the remote authorization and security integration boundaries.

## Evidence

- Integrated focused migration/auth/domain regression: 13 files / 167 tests PASS.
- Complete one-worker suite: 266 files / 2,203 tests PASS.
- Complete default-parallel suite: 266 files / 2,203 tests PASS.
- Root and web strict TypeScript PASS.
- Root and web production builds PASS.
- Changed-diff Gitleaks and `git diff --check` PASS.
- Current documentation remediation GitNexus review: LOW, 10 mapped documentation/test symbols and
  no affected execution flows. The integrated runtime seam remains covered by both complete suites.

The product remains an engineering preview. Canonical credential lifecycle truth does not by itself
close `REM-017`, `REM-GATE`, production `OPS-002`, or `OPS-GATE`.
