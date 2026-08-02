# Agent OS focused service boundaries

Status: DOM-014 plus Beta Lane A collaboration domains, observed at code head `408f5b2`.

## TL;DR

Agent OS exposes one typed ten-domain composition catalog. Discussions, managed Knowledge, and
durable conflict resolution are canonical services; low-level messages and advisory overlap
detection remain separate compatibility surfaces. Device pairing remains explicitly reserved with
`service: null`, so the operator-token QR cannot be mistaken for a secure device credential.

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
| `device_pairing` | `reserved` | none | the reusable operator-token QR is not a PairingTicket or DeviceSession |

## Contract

`createAgentOsDomainServiceBoundaries(db, options)` returns an immutable catalog in
`src/agent-os/service-boundaries.ts`. Each active boundary has:

- one stable domain name;
- an implementation state separate from product aspiration;
- a narrow structural service type;
- explicit owned responsibilities and exclusions;
- an independently injectable service instance.

Reserved boundaries cannot silently accept a compatibility implementation. Device pairing remains
`null` until its later domain and security gates are implemented.

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

- PairingTicket, DeviceSession, scoped credentials, expiry, revocation, step-up, and device audit
  remain Phase 13/security work.

## Evidence

- Focused boundary/API regression: 4 files / 26 tests PASS.
- Complete one-worker suite: 152 files / 1,221 tests PASS.
- Complete default-parallel suite: 152 files / 1,221 tests PASS.
- Root and web strict TypeScript PASS.
- Root and web production builds PASS.
- Changed-diff Gitleaks and `git diff --check` PASS.
- Worktree-local GitNexus review: MEDIUM, 3 indexed changed symbols and 4 affected Agent OS plugin
  flows. The complete suites cover that route-level compatibility seam.

The product remains an engineering preview. This boundary topology is an architectural delivery,
not completion of the reserved domains.
