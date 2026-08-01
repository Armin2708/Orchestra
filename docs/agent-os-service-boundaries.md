# Agent OS focused service boundaries

Status: DOM-014 delivered at exact code head
`3630baa28073871deef3e24d4562dcef32530353`.

## TL;DR

Agent OS now exposes one typed ten-domain composition catalog. The catalog names the real
canonical services, labels partial foundations precisely, and leaves unimplemented domains
explicitly reserved with `service: null`. It does not turn legacy messages into Discussions,
computed overlaps into durable Conflict resolution, bounded Knowledge ingestion/retrieval into
managed prompt injection, or the operator-token QR into secure device pairing.

| Boundary | Implementation state | Current service | Explicitly not claimed |
|---|---|---|---|
| `orchestration` | `canonical` | `OrchestrationService` | provider runtime implementation, route authentication, legacy projection |
| `conversations` | `canonical` | `ConversationService` | wake transport, provider process control, Discussion lifecycle |
| `deliveries` | `canonical` | `DeliveryReportService` | job scheduling, legacy review controls, Knowledge promotion |
| `discussions` | `reserved` | none | `messages` remain low-level targeted transport, not a durable Q&A domain |
| `knowledge` | `canonical` | `KnowledgeService` | managed prompt injection, freshness automation, review, promotion, API/UI |
| `organization` | `canonical` | `OrganizationService` | work assignment identity, provider runtime identity, implicit authority from capability or seniority labels |
| `coordination` | `canonical` | `OrganizationCoordinationService` | wake transport, implicit broadcast, acknowledgement loops, self-approval |
| `assurance` | `canonical` | `OrganizationAssuranceService` | activity-volume ranking, self-review, hidden overrides, blame from incident learning |
| `conflicts` | `compatibility_only` | `ComputedWorkspaceConflictService` | durable negotiation, arbitration, enforcement, resolution |
| `device_pairing` | `reserved` | none | the reusable operator-token QR is not a PairingTicket or DeviceSession |

## Contract

`createAgentOsDomainServiceBoundaries(db, options)` returns an immutable catalog in
`src/agent-os/service-boundaries.ts`. Each active boundary has:

- one stable domain name;
- an implementation state separate from product aspiration;
- a narrow structural service type;
- explicit owned responsibilities and exclusions;
- an independently injectable service instance.

Reserved boundaries cannot silently accept a compatibility implementation. Their service is
`null` until the later domain and security gates are implemented.

## Current runtime use

The existing canonical orchestration, Agent Home conversation, Delivery Trackbook, and Knowledge
implementations remain authoritative in their existing modules. The Knowledge boundary composes
durable persistence with exact committed accepted-answer/decision evidence, verified repository
evidence ingestion, and deterministic bounded FTS retrieval. The accepted-evidence adapter does
not create a Discussion lifecycle or promotion authority. DOM-014 does not move
their domain behavior into `buildServer` or a route plugin.

The existing `GET /api/v1/os/boards/:id/conflicts` response now passes through
`ComputedWorkspaceConflictService`. That boundary validates the board scope and delegates only the
two existing advisory overlap kinds:

- `execution_root`;
- `owned_paths`.

No schema, route, CLI, rendered UI, response shape, or conflict-enforcement behavior changed.

## Deliberate non-goals

- Discussion/Post persistence, answer acceptance, subscriptions, search, and promotion remain
  Phase 8 work; Knowledge can ingest an already-accepted answer only from an exact committed
  citation.
- Durable Conflict records, proposals, arbiter decisions, rationale, and resolution remain Phase 9
  work.
- Knowledge managed injection, freshness, review, and product surfaces remain KNO-011 onward.
- PairingTicket, DeviceSession, scoped credentials, expiry, revocation, step-up, and device audit
  remain Phase 13/security work.
- Moving construction and compatibility routing out of `buildServer` is DOM-015.

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
