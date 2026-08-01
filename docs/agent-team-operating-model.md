# Agent Team Operating Model

Status: **implemented and acceptance-verified**. This document is the research-backed operating
model and delivered contract for backlog items `ORG-001` through `ORG-024` and `ORG-GATE`.

Implementation lineage: organization core `fd80d02`, coordination `479e67a`, assurance and
learning `37f7ce2`, API/CLI/web control center `45d29b1`, restart-safe system gate `d68d4f8`, and
focused governance coverage `cbfa636`.

## Bottom line

Orchestra should model a professional software organization, not a room full of agents chatting.
Persistent identities join bounded teams, accept explicit roles, work against versioned objectives
and contracts, exchange typed durable artifacts, pass risk-based independent quality gates, and
leave an auditable chain from product intent to production outcome.

The control system has five layers:

1. **Organization** — ownership, membership, roles, capacity, and decision rights.
2. **Work** — objectives, designs, contracts, assignments, dependencies, and budgets.
3. **Coordination** — typed messages, discussions, decisions, services, and escalation.
4. **Assurance** — separation of duties, evidence, review, testing, release, and incident learning.
5. **Measurement** — contextual team outcomes, quality, reliability, flow, cost, and capability.

It must not become employee-surveillance software. Raw thoughts, keystrokes, hours online, lines of
code, message volume, or commit counts are not valid individual productivity measures.

## Scope and non-goals

This program adds the organizational control plane missing between the current Agent Profile/Job
foundation and the planned Discussions, Teams, Conflicts, Permissions, Metrics, Operations, and QA
phases. It does not duplicate those domains: it defines the relationships and rules they must
jointly enforce.

It does not:

- imitate meetings when a durable artifact or event is sufficient;
- infer authority from model capability, seniority labels, or who speaks most often;
- grant a worker the right to approve its own work;
- turn a single score or activity counter into a performance verdict;
- expose hidden chain-of-thought or provider-private reasoning;
- claim an organization feature is delivered because a chat or task table exists.

## What large organizations actually keep track of

Large organizations use several systems of record. Orchestra should preserve the useful control
intent while removing employment-specific bureaucracy.

| Real-world system | What it tracks | Agent-team equivalent |
|---|---|---|
| HRIS and organization directory | identity, manager, team, position, lifecycle | Agent Profile, Membership, Position, lifecycle state |
| Identity and access management | roles, entitlements, approvals, periodic access review | role capability bundle, policy, approval, expiry, revocation |
| Portfolio/product planning | objectives, outcomes, owners, funding, roadmap | Objective, ProductArea, TeamGoal, capacity and budget allocation |
| Work management | backlog, dependencies, DRI, status, blockers | versioned Contract, Job, Assignment, dependency graph, escalation |
| Design and engineering records | research, design, RFC/ADR, code review | immutable linked artifact versions and Decision Records |
| CI/CD and service management | tests, builds, deploys, SLOs, incidents | evidence graph, Quality Gates, release state, error budget, Incident |
| Performance and capability | outcomes, competencies, feedback, growth | contextual scorecard, capability evidence, calibration, remediation |
| Audit and risk | policy decisions, exceptions, controls, retention | append-only authority, approval, override, provenance, and audit events |

The purpose is to answer five questions without reconstructing chat transcripts:

- Who owned the outcome and who was authorized to act?
- What exact request, design, policy, and source state governed the work?
- Who produced, reviewed, approved, and released each artifact?
- What evidence proved quality and what risk was accepted?
- What happened after release, and what did the organization learn?

## Research translated into product rules

| Practice | Research finding | Orchestra rule |
|---|---|---|
| Multi-dimensional productivity | Microsoft's SPACE framework rejects productivity as one metric or activity count. | Measure satisfaction/health, performance, activity only as context, communication, and efficiency/flow; never rank an individual from one number. |
| Delivery performance | DORA uses deployment throughput and stability measures in team/application context. | Measure lead time, deployment frequency, recovery time, failure/rework rate at service or team level, alongside outcome and quality. |
| Team effectiveness | Google re:Work emphasizes team dynamics and shared goals; Scrum defines a small, cross-functional, self-managing unit with one Product Goal. | Give each bounded team a mission, product goal, ownership boundary, backlog, and explicit accountabilities. |
| Team interaction | Team Topologies distinguishes collaboration, X-as-a-Service, and facilitating. | Encode the interaction mode, owner, service contract, timebox, and exit condition; do not create permanent all-to-all coordination. |
| Async communication | GitLab uses public work artifacts and links a single source of truth instead of relying on direct messages. | Discussions are durable and link to the canonical work/decision; direct transport wakes recipients but is not the system of record. |
| Performance management | GitLab connects responsibilities and competencies to documented, contextual feedback. | Evaluate assigned outcomes and role capabilities over a window with evidence, context, uncertainty, review, and appeal. |
| Engineering review | Google's review guidance requires a non-author review and evaluates design, functionality, complexity, tests, naming, comments, style, and documentation. | Risk selects review dimensions and approvers; author and final approver are distinct principals and sessions. |
| Reliability | Google SRE uses user-centered SLOs, error budgets, clear response levels, and blameless postmortems. | Services own SLOs and error budgets; failures create incidents, reviewed postmortems, and tracked corrective actions. |
| Governance | NIST AI RMF organizes continuous work as Govern, Map, Measure, and Manage and calls for clear roles, inventory, monitoring, and risk treatment. | Maintain an agent/system inventory, assigned risk owners, pre-deployment evaluation, monitoring, escalation, and explicit treatment decisions. |
| Access control | NIST RBAC and separation-of-duty guidance assign access through roles and prevent one principal from completing conflicting steps. | Use bounded role entitlements plus static, dynamic, and history-based separation of duties and two-person control for high risk. |
| Supply-chain traceability | SLSA provenance records where, when, and how an artifact was produced and connects artifacts to source. | Attest source, builder, inputs, parameters, outputs, and digests for reviewable and releasable artifacts. |

## Canonical organization model

### Hierarchy and ownership

```text
Organization
└── ProductArea
    ├── Team (stable mission and ownership boundary)
    │   ├── Position (capacity slot and expected role family)
    │   ├── Membership (who belongs, lifecycle, allocation)
    │   └── TeamGoal / owned Service / owned Backlog
    └── TeamInteraction (collaboration, service, or facilitation)
```

`Organization` and `ProductArea` aggregate goals, policy, budget, risk, and ownership. A `Team` is
the smallest accountable delivery unit. Cross-team work is an explicit interaction or service
request, not an ambient broadcast.

### Identity is not role and role is not authority

| Record | Meaning | Lifetime |
|---|---|---|
| `AgentProfile` | stable identity, provider provenance, declared capabilities | persistent |
| `TeamMembership` | affiliation, allocation, lifecycle, position | days to months |
| `RoleDefinition` | reusable duties, capabilities, constraints, evidence requirements | versioned policy |
| `RoleAssignment` | role granted to one identity in one scope | bounded and revocable |
| `RoleActivation` | role actually used by one session/job | short-lived, auditable |
| `AgentSession` | one execution context with exact provider/model/workspace/policy | minutes to days |
| `Assignment` | responsibility for a specific contract/job | until terminal work state |

An agent can be a team member without an active job, can hold several roles without activating all
their permissions, and can execute a job without becoming its decider or approver.

### Membership lifecycle

```text
candidate -> onboarding -> active <-> leave
                         -> suspended
active|leave|suspended -> offboarded
```

Transitions must coordinate work handoff, credential and role changes, outstanding approvals,
retention, legal/audit holds, and revocation. Offboarding removes new authority immediately while
retaining the minimum redacted historical evidence required to explain past work.

## Relationship and authority model

Every material relationship is typed, scoped, versioned, and time-bounded where appropriate.

| Relationship | Meaning | Required evidence |
|---|---|---|
| owns | accountable team for a product area, service, or backlog | ownership record and effective window |
| manages | lifecycle/capacity responsibility, not automatic work approval | membership policy |
| delegates | assigns bounded work and constraints | accepted assignment and frozen contract |
| depends_on | work or service cannot progress without another result | dependency condition and status |
| serves | one team provides a capability as a service | service contract, SLO, support/escalation path |
| collaborates_with | temporary joint discovery or delivery | purpose, participants, timebox, exit condition |
| facilitates | helps another team acquire a capability | desired capability, timebox, handoff evidence |
| reviews | independently evaluates criteria and evidence | review assignment and verdict |
| approves | exercises explicit decision authority | policy basis, actor, scope, rationale, expiry |
| decides | selects an option and accepts its consequences | Decision Record |
| escalates_to | transfers attention or authority at a threshold | trigger, attempted mitigations, deadline |
| observes | receives redacted metrics/events without mutation authority | purpose and access policy |

For each artifact or decision, the responsibility tuple is:

- **DRI** — executes and coordinates the work;
- **Decider** — has final bounded authority and owns the consequence;
- **Contributors/Consulted** — supply evidence or specialist judgment;
- **Reviewers/Assurers** — independently test claims against criteria;
- **Informed** — receive a digest or decision, not every intermediate message.

Exactly one DRI and one decider are required for material work. They can be the same principal for
low-risk reversible decisions, but the producer cannot be the sole reviewer or approver of its own
delivery.

## Communication protocol

### Durable artifacts, not simulated conversation

Agents communicate by producing typed records. Natural-language content is allowed, but the
record must state what action is requested and which work or decision it affects.

Canonical message intents are:

`QUESTION`, `ANSWER`, `PROPOSAL`, `DECISION`, `ASSIGNMENT`, `STATUS_UPDATE`, `BLOCKER`,
`REVIEW_REQUEST`, `REVIEW_FINDING`, `APPROVAL`, `REJECTION`, `EVIDENCE`, `INCIDENT`, and
`ESCALATION`.

Each envelope includes:

- message, thread, parent, causal, organization, team, actor, session, and active-role identity;
- intent, recipients, visibility, urgency, requested action, deadline, and expiry;
- linked objective, contract, job, artifact, decision, incident, and evidence references;
- idempotency key, delivery/read receipt policy, redaction class, and retention policy;
- structured payload version plus an optional human-readable summary.

Transport and knowledge stay separate. A message may intentionally wake a recipient; the durable
Discussion, Decision Record, Contract, Review, or Incident is the source of truth. Mechanical
receipts never trigger model-generated acknowledgements, and automated reply/fanout loops fail
closed.

### Channel rules

| Need | Default channel | Rule |
|---|---|---|
| Work status or blocker | linked work thread | update the canonical state and notify only subscribers/owners |
| Design question | searchable discussion | accepted answer may be promoted to knowledge after review |
| Binding choice | Decision Record | options, evidence, decider, rationale, consequences, supersession |
| Review | review request/finding | point to exact artifact version, criterion, severity, and location |
| Cross-team dependency | service request or time-bounded collaboration | name provider/consumer, SLO or exit condition, and escalation path |
| Urgent operational failure | incident channel and Incident record | page only the response role; preserve timeline and decisions |
| Human judgment | Needs You escalation | explain uncertainty, risk, options, recommendation, and deadline |

A synchronous planning or incident session is permitted when latency matters. It is complete only
when its summary, decisions, owners, deadlines, and unresolved questions are written back to the
canonical records.

## Decision and escalation protocol

A `DecisionRecord` contains the question, owner, decider, consulted parties, options, evidence,
constraints, selected option, rationale, risks accepted, effective window, review date, and links
to superseded or follow-up decisions. Silence and message popularity are never approval.

Escalation is threshold-driven:

- contract ambiguity or confidence below the task threshold;
- a blocked dependency or service SLO breach;
- planning rounds, WIP, token, time, or financial budget exhausted;
- unresolved review finding or conflict;
- permission outside the active role;
- destructive, security-sensitive, public, legal, privacy, or financial action;
- repeated failure, anomalous behavior, or quality regression.

An escalation must include the attempted actions, current evidence, risk of waiting, bounded
options, recommendation, required authority, and response deadline. The receiver may decide,
delegate to a qualified role, narrow scope, request evidence, pause, or reject.

## Risk and permission tiers

| Tier | Example | Minimum control |
|---|---|---|
| R0 | read-only exploration inside assigned scope | logged policy evaluation; automatic execution |
| R1 | reversible isolated code/document change | frozen contract, tests/evidence, independent review |
| R2 | shared interface, migration, security control, production configuration | named owner, impact review, specialist approval, rollback evidence |
| R3 | destructive deletion, public release, secrets/identity, material spend | explicit human approval, two-person control, expiry, canary/rollback |
| R4 | disallowed by law, provider terms, policy, or missing authority | fail closed; no override in the same workflow |

Policy considers actor, active role, resource, action, environment, risk, contract, time, budget,
and prior participation. Static separation of duties blocks incompatible role assignments;
dynamic separation blocks simultaneous activation; history-based separation blocks an author or
earlier operator from becoming the independent approver later.

## Quality assurance system

Quality is a chain of evidence, not a final testing stage.

```text
Objective
  -> customer/research evidence
  -> PRD + versioned design/Figma artifact
  -> RFC/ADR and acceptance criteria
  -> epic/story/contract
  -> assignment + exact session/source
  -> commit/PR
  -> independent reviews + tests
  -> build attestation
  -> deployment + SLO/error budget
  -> outcome telemetry
  -> decision, incident, or improvement
```

The system must preserve exact identifiers and immutable versions at every arrow. A later edit may
supersede a record but cannot silently rewrite which request or policy governed historical work.

### Quality gates

Each gate declares entry criteria, required evidence families, approver roles, risk tier, timeout,
waiver authority, override expiry, and failure behavior. Typical gates are:

1. **Ready** — problem, user evidence, outcome, acceptance criteria, owner, dependencies, and risk.
2. **Design** — alternatives, architecture/design review, privacy/security/operability impact.
3. **Implementation** — small self-contained change, tests, static checks, provenance.
4. **Independent review** — correctness, design, complexity, security, tests, docs, maintainability.
5. **Release** — artifact attestation, migration/rollback, canary, SLO and support ownership.
6. **Outcome** — observed product/reliability result and follow-up decision.

Overrides do not turn a failed criterion into evidence. They retain the gap, actor, authority,
rationale, scope, expiry, compensating control, and required follow-up.

### Incidents and learning

Significant failures create a durable Incident, causal timeline, impact assessment, containment,
recovery evidence, and a blameless reviewed Postmortem. Corrective and preventive actions have
owners, due dates, verification, and closure evidence. Reusable lessons are promoted to the
Knowledge Compiler; performance review must not use blameless learning artifacts as a shortcut
for individual blame.

## Measurement and performance management

### Scorecard, not leaderboard

The primary unit of delivery performance is the product/service and its accountable team. Role or
individual views exist to diagnose support, capability, authorization, or repeated responsibility
patterns—not to create a universal ranking.

| Dimension | Useful measures | Guardrail |
|---|---|---|
| Outcomes | objective progress, adoption, task success, customer evidence | do not substitute output volume for impact |
| Quality | escaped defects, review findings, acceptance/regression rate | normalize by risk and change type |
| Reliability | SLO attainment, error-budget burn, recovery time, repeated incidents | measure user impact, not uptime theater |
| Flow | lead time, WIP, blocked age, batch size, rework | use at team/service context; expose dependencies |
| Efficiency | compute/token/cost per accepted outcome, cache/context reuse | never optimize cost at the expense of quality |
| Collaboration | service responsiveness, handoff quality, evidence completeness | do not reward message count or meeting volume |
| Capability | current attested skills, review quality, remediation progress | evidence expires; declared skill is not proof |
| Safety | policy violations, unauthorized attempts, overdue access | distinguish prevented attempts from harm |

Every metric declares its purpose, population, owner, source, window, freshness, uncertainty,
known confounders, access policy, and prohibited uses. A performance judgment cites assigned goals
and evidence, includes operating context and confidence, is independently calibrated, and supports
correction or human appeal. Missing data yields `INSUFFICIENT_EVIDENCE`, not a low score.

### Capacity at scale

Capacity planning records positions, allocations, availability, WIP limits, queued demand,
service load, and skill/risk constraints. It must surface silent overload, critical-person risk,
orphaned ownership, and blocked age. More agent instances are not useful capacity when review,
integration, environment, or human-approval constraints are saturated.

## Control surfaces

The UI/API/CLI should provide:

- organization map with product areas, teams, owned services/backlogs, and accountable roles;
- team home with mission, goals, capacity, WIP, dependencies, interactions, and risk;
- identity home with memberships, assignments, active roles, capabilities, access, and history;
- decision and discussion registers with search, supersession, and unresolved queues;
- review/gate center with exact evidence, required approvers, findings, overrides, and expiry;
- trace explorer from objective to production outcome and in reverse from incident to source;
- organizational dashboard for outcome, quality, reliability, flow, cost, access, and risk;
- Needs You queue for decisions whose authority or judgment cannot safely be delegated;
- redacted audit export with retention and legal/policy boundaries.

## Delivered evidence

The implementation is additive and migration-backed. Migrations 027–029 create the organization,
coordination, assurance, measurement, access, incident, and learning records. The API exposes a
server-authorized organization control center, the CLI exposes organization list/create/show/
command operations, and the web application exposes the organization map, Needs You queue,
quality gates, trace, provenance, scorecards, incidents, postmortems, corrective actions, and
knowledge promotion.

| Backlog | Authoritative implementation evidence | Behavioral proof |
|---|---|---|
| ORG-001 | this operating model and its enforced anti-surveillance/authority invariants | `organization-presentation.test.ts`, `organization-assurance.test.ts` |
| ORG-002–005 | `organization-migration.ts`, `organization.ts` | `organization-core-migration.test.ts`, `organization-service.test.ts`, `organization-governance.test.ts` |
| ORG-006–010 | `organization-coordination-migration.ts`, `organization-coordination.ts` | `organization-coordination.test.ts`, `organization-governance.test.ts` |
| ORG-011–017 | objective, goal, capacity, message, decision, escalation, risk, participation, and approval records in `organization-coordination.ts` | `organization-coordination.test.ts`, `organization-gate.test.ts` |
| ORG-018–020 | trace, provenance, and risk-selected gate records in `organization-assurance.ts` | `organization-assurance.test.ts`, `organization-gate.test.ts` |
| ORG-021–023 | contextual metric/scorecard, calibration, access certification, remediation, and appeal records in `organization-assurance.ts` | `organization-assurance.test.ts`, `organization-governance.test.ts`, `organization-gate.test.ts` |
| ORG-024 | Incident, timeline, reviewed Postmortem, verified corrective action, and Knowledge promotion in `organization-assurance.ts` | `organization-assurance.test.ts`, `organization-gate.test.ts` |
| ORG-GATE | two-team product/service delivery under an SLO, R2 independent review, exact trace/provenance, incident learning, SQLite restart, and idempotent replay | `organization-gate.test.ts` |

The product surfaces are covered by `organization-api.test.ts`, `organization-cli.test.ts`,
`organization-presentation.test.ts`, and navigation/inventory/security tests. Repository-wide
verification must remain green before the checkbox mirror is reconciled.

## Delivery sequence and dependencies

### Source-controlled ORG backlog mirror

The authoritative checkbox state is maintained in the Agent OS Master Backlog. This table is the
source-controlled outcome contract and must remain textually aligned before any `ORG-*` item is
closed.

| ID | Planned outcome |
|---|---|
| ORG-001 | Freeze the operating model, vocabulary, invariants, non-goals, and anti-surveillance boundary. |
| ORG-002 | Extend Team with Organization, ProductArea, Position, Membership, RoleDefinition, RoleAssignment, RoleActivation, and AuthorityPolicy. |
| ORG-003 | Keep identity, membership, role assignment, active session role, work assignment, and approval authority distinct. |
| ORG-004 | Implement the full membership lifecycle with handoff, retention, suspension, offboarding, and immediate authority revocation. |
| ORG-005 | Assign one effective accountable team to every product area, backlog, service, and operational surface. |
| ORG-006 | Encode collaboration, X-as-a-Service, and facilitating interactions with owner, participants, timebox, SLO or exit condition. |
| ORG-007 | Bind roles to versioned duties, capabilities, permissions, budgets, constraints, and freshness-bounded evidence. |
| ORG-008 | Enforce role hierarchy and contextual policy without deriving authority from capability or seniority labels. |
| ORG-009 | Enforce static, dynamic, and history-based separation of duties and high-risk two-person control. |
| ORG-010 | Require one DRI and bounded decider and record consulted, assurer/reviewer, and informed parties. |
| ORG-011 | Link organization objectives and customer evidence through team goals and versioned design to frozen work contracts. |
| ORG-012 | Model positions, capacity, allocation, availability, WIP, blocked age, demand, and skill/risk constraints. |
| ORG-013 | Implement the versioned typed communication envelope and canonical message intents. |
| ORG-014 | Make asynchronous linked artifacts authoritative, persist synchronous outputs, and stop fanout/acknowledgement loops. |
| ORG-015 | Implement evidence-bearing Decision Records with option, rationale, accepted-risk, review, and supersession lineage. |
| ORG-016 | Implement evidence-bearing escalation thresholds and required response authority. |
| ORG-017 | Select automatic, review, specialist, human, two-person, or prohibited control from action risk. |
| ORG-018 | Preserve the digest-verifiable objective-to-design-to-source-to-deploy-to-outcome trace. |
| ORG-019 | Attest exact artifact source, builder, inputs, parameters, environment, outputs, and digests. |
| ORG-020 | Build risk-selected quality gate graphs with evidence, approvers, failure behavior, and audited overrides. |
| ORG-021 | Build contextual outcome, quality, reliability, flow, cost, collaboration, capability, and safety scorecards. |
| ORG-022 | Prohibit activity-volume individual ranking and require purpose, context, uncertainty, prohibited uses, and insufficient-evidence behavior. |
| ORG-023 | Add periodic goals/capability calibration, access certification, freshness, remediation, correction, and appeal. |
| ORG-024 | Add Incident, reviewed blameless Postmortem, corrective/preventive actions, verification, and Knowledge promotion. |
| ORG-GATE | Prove a restart-safe, audited two-team delivery with a service dependency, escalation, independent review, exact trace, outcome, and simulated incident. |

### Implementation stages

| Stage | Backlog | Depends on | Observable result |
|---|---|---|---|
| 1. Vocabulary and hierarchy | ORG-001–005 | DOM, JOB, TEAM-001 | stable ownership and membership model |
| 2. Roles and authority | ORG-006–010 | TEAM, TOOL permissions | bounded interactions, capabilities, decision rights, SoD |
| 3. Goals, capacity, coordination | ORG-011–017 | JOB, DSC, TEAM, attention | linked outcomes, typed communication, escalation, risk tiers |
| 4. Traceability and assurance | ORG-018–020 | DEL, QA, OPS, provider evidence | immutable trace, provenance, independent gates |
| 5. Measurement and learning | ORG-021–024 | MET, OPS, KNO | contextual scorecards, calibration, incidents, improvement |
| 6. System acceptance | ORG-GATE | all above | two-team audited product slice under normal and failure paths |

The program is cross-cutting. Existing `DSC-*`, `TEAM-*`, `TOOL-*`, `MET-*`, `OPS-*`, and `QA-*`
items provide the implementation surfaces; an `ORG-*` item closes only when those surfaces jointly
prove the organizational behavior and the evidence is linked.

## `ORG-GATE` acceptance scenario

Two bounded teams deliver one product slice. One team owns the product capability; the other
provides a service under an SLO. The run must prove:

- objective, research, versioned design, decision, contract, assignments, and budgets are linked;
- memberships, active roles, capabilities, and permissions are valid at execution time;
- cross-team work uses a declared interaction mode and targeted typed messages without broadcast
  fanout or acknowledgement loops;
- one blocked dependency escalates with evidence and is resolved by the correct decider;
- authors cannot approve their own work, and one R2 action receives the required specialist review;
- source, review, tests, build, deployment, and observed outcome form a digest-verifiable trace;
- a simulated incident consumes error budget, produces a reviewed postmortem and corrective action,
  and promotes a reusable lesson without inventing individual blame;
- dashboards show outcomes, flow, quality, reliability, cost, capacity, and risk while rejecting
  activity-volume ranking;
- restart/replay preserves identity, authority, idempotency, decisions, and evidence exactly;
- a human can audit the result without reading raw agent transcripts or hidden reasoning.

## Sources

Accessed 2026-08-01:

- [Microsoft Research — The SPACE of Developer Productivity](https://www.microsoft.com/en-us/research/publication/the-space-of-developer-productivity-theres-more-to-it-than-you-think/)
- [DORA — DORA's software delivery performance metrics](https://dora.dev/guides/dora-metrics/)
- [Google re:Work — Understand team effectiveness](https://rework.withgoogle.com/en/guides/understanding-team-effectiveness)
- [The Scrum Guide, November 2020](https://scrumguides.org/docs/scrumguide/v2020/2020-Scrum-Guide-US.pdf)
- [Team Topologies — the three interaction modes](https://teamtopologies.com/news-blogs-newsletters/2025/2/21/team-topologies-interaction-modes-breaking-through-common-misconceptions)
- [GitLab Handbook — Communication](https://handbook.gitlab.com/handbook/communication/)
- [GitLab Handbook — Performance Management](https://handbook.gitlab.com/handbook/support/managers/performance-management/)
- [Google Engineering Practices — Code Review](https://google.github.io/eng-practices/review/)
- [Google Engineering Practices — Standard of Code Review](https://google.github.io/eng-practices/review/reviewer/standard.html)
- [Google SRE — Service Best Practices](https://sre.google/sre-book/service-best-practices/)
- [Google SRE — Service Level Objectives](https://sre.google/sre-book/service-level-objectives/)
- [Google SRE — Postmortem Culture](https://sre.google/sre-book/postmortem-culture/)
- [NIST — AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
- [NIST AI RMF Core — Govern, Map, Measure, Manage](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)
- [NIST AI 600-1 — Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)
- [NIST — Role Based Access Control FAQ](https://csrc.nist.gov/Projects/role-based-access-control/faqs)
- [NIST — Separation of Duty glossary](https://csrc.nist.gov/glossary/term/sod)
- [SLSA v1.2 — Provenance](https://slsa.dev/spec/v1.2/provenance)
