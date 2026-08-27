# Agent OS surface inventory

Status: compatibility-contract inventory plus Beta Lane A's Delivery Trackbook, managed Knowledge Compiler,
Discussions, Teams, planning, and durable conflict resolution surfaces,
DOM-014's focused service-boundary topology, DOM-015's server composition boundary, and DOM-016's
legacy projection contract, DOM-017's physical forward migration, and DOM-019's compatibility
telemetry and failure evidence, plus the integrated Open Work, collaboration, knowledge, team,
delivery, remote DeviceSession, operations, diagnostics-backed support, production-chaos evidence,
and outcome-analytics surfaces, observed against exact code integration
`58fc112a94c2253dd04f2ba617a6477b11d3d966`.

This inventory separates the original Board product from the canonical Agent OS and the bridges
that keep both usable during migration. The machine-readable source of truth is
[`agent-os-surface-inventory.json`](./agent-os-surface-inventory.json); the executable drift check
is `test/agent-os-baseline-docs.test.ts`.

## TL;DR

| Surface | Canonical | Compatibility | Legacy | Infrastructure | Total |
|---|---:|---:|---:|---:|---:|
| SQLite application tables | 170 | 3 | 10 | 17 | 200 |
| Contract-scoped registered HTTP routes | 168 | 29 | 25 | 12 | 234 |
| Contract-scoped CLI command families/subcommands | 94 | 5 | 18 | 23 | 140 |

Classification does not mean “safe to delete.” Compatibility and legacy surfaces remain supported
until migration telemetry and release gates allow removal.

## Classification

- **Canonical:** durable Agent OS state or an interface under `/api/v1/os`.
- **Compatibility:** a supported legacy-shaped bridge that may project to or gate canonical state,
  but is not itself the canonical source of truth.
- **Legacy:** the original Board, presence, message, milestone, review, and telemetry product.
- **Infrastructure:** shared daemon, auth, streaming, push, settings, and schema machinery.

The source contract is `docs/agent-os-domain.md:102`; Agent OS route registration is delegated by
`src/server.ts:1423` through `src/server-composition.ts:97` to
`src/agent-os/routes.ts:124`.

## Focused service boundaries

Implementation state is separate from the future domain target. `reserved` means the boundary is
named and fail-closed but has no service; partial implementation states name exactly
which partial foundation exists.

| Boundary | Implementation state | Source |
|---|---|---|
| `orchestration` | `canonical` | `src/agent-os/orchestration-service.ts` |
| `conversations` | `canonical` | `src/agent-os/conversations.ts` |
| `deliveries` | `canonical` | `src/agent-os/delivery-reports.ts` |
| `discussions` | `canonical` | `src/agent-os/discussions.ts` |
| `knowledge` | `canonical` | `src/agent-os/knowledge-service.ts` |
| `organization` | `canonical` | `src/agent-os/organization.ts` |
| `coordination` | `canonical` | `src/agent-os/organization-coordination.ts` |
| `assurance` | `canonical` | `src/agent-os/organization-assurance.ts` |
| `conflicts` | `canonical` | `src/agent-os/team-planning.ts` |
| `device_pairing` | `canonical` | `SqliteDeviceSessionRepository` in `src/agent-os/device-sessions.ts` |

The exact ownership/exclusion contract is
[`agent-os-service-boundaries.md`](./agent-os-service-boundaries.md).

## Server composition boundary

`buildServer` owns Fastify lifecycle/authentication, dependency injection, focused route-plugin
registration, and the supported legacy compatibility routes. It delegates Agent OS default
provider/driver discovery and plugin registration to `src/server-composition.ts`; neither module
constructs a canonical domain service on this path.

| Contract | Exact value |
|---|---|
| Role | `composition_and_compatibility_routing` |
| Source | `src/server-composition.ts` |
| Focused registrar | `registerAgentOsRoutes` in `src/agent-os/routes.ts` |
| Excludes | canonical domain transitions, service construction, persistence, and validation |

The static drift guard rejects direct Agent OS registrar imports in `src/server.ts`, inline HTTP
handlers or SQL in the composition module, and canonical service constructors in either boundary.
The full contract and fallback-preservation evidence are in
[`agent-os-server-composition.md`](./agent-os-server-composition.md).

## Legacy projection and compatibility-view contract

All 3 compatibility and 10 legacy tables have one executable authority entry in
`src/agent-os/compatibility-projection-contract.ts`. The contract distinguishes shared scope,
bounded compatibility authority, field/lineage-partitioned bridges, projection sinks, legacy-event
ingress, and legacy domains with no canonical replacement. No entry permits two authorities to
resolve by last-write-wins.

| Contract | Exact value |
|---|---|
| Schema / backlog item | `1` / `DOM-016` |
| Covered tables | 13 / 13 compatibility and legacy tables |
| Physical migration owner | `DOM-017` |
| Read/write telemetry owner | `DOM-019` |
| DOM-016 runtime effect | none; logical design only |

DOM-016 does not create SQLite views, backfill data, disable a writer, or relabel low-level
messages as Discussions, message receipts as work Deliveries, or injected-context estimates as
provider usage. DOM-017 now implements the physical migration without changing those semantic
boundaries. The exact per-table read/write/cutover rules are in
[`agent-os-compatibility-projections.md`](./agent-os-compatibility-projections.md).

## Compatibility forward migration

Migration `022-legacy-projection-forward-plan` implements the DOM-017 physical handoff for all
13 compatibility and legacy tables at code head
`74d632f46bfeaaead1c7a52ced8a317915baacbf`.

| Contract | Exact value |
|---|---|
| Prerequisite | migration `021-command-idempotency-coverage` plus exact source/target schemas |
| Covered tables | 13 / 13 plan entries |
| Deterministic dispositions | links or quarantine for every row on the seven movable/validated source surfaces |
| Validation | count, key, scope, lifecycle, and linked-snapshot hash |
| Evidence tables | `os_compatibility_projection_links`, `os_compatibility_projection_quarantine`, `os_compatibility_migration_checks` |
| Failure behavior | the enclosing migration transaction aborts before marker `022` is recorded |
| Rollback | forward-only; no automatic down migration and no deletion or demotion of canonical writes |
| Telemetry owner | `DOM-019`; no usage cutover control advances here |

The operator ordering, backup checkpoint, compatibility range, exact validation queries, and
offline restore boundary are in
[`agent-os-forward-migrations.md`](./agent-os-forward-migrations.md).

## Database tables

The exact live schema is obtained by opening a fresh database, applying every migration, and
reading `sqlite_master`. Base tables are defined in `src/db.ts`; Agent OS migrations and their
transactional ledger are defined in `src/agent-os/migrations.ts`; DOM-017's evidence schema is
defined in `src/agent-os/compatibility-forward-migration.ts`; DOM-019 telemetry and failure
evidence are defined in `src/agent-os/compatibility-migration-telemetry.ts` and
`src/agent-os/compatibility-migration-failure-journal.ts`. Organization and coordination records
are defined in `src/agent-os/organization-migration.ts` and
`src/agent-os/organization-coordination-migration.ts`.
The assurance evidence graph is defined in
`src/agent-os/organization-assurance-migration.ts`. Outcome measurement, execution authorization,
and reconciliation evidence are defined in `src/agent-os/outcome-analytics-migration.ts`. Exact
ShipQueue receipts, attributed ContextUse evidence, and the durable autoship outbox are defined in
`src/agent-os/delivery-shipment-integrity-migration.ts`,
`src/agent-os/knowledge-context-use-actual-migration.ts`, and
`src/agent-os/delivery-autoship-intent-migration.ts`.
DeviceSession, credential, grant, step-up, stream, push and remote audit state is defined by
`src/agent-os/device-session-migration.ts` and `src/remote-security-schema.ts`. Operations recovery,
outbox, retention and compaction state is defined by `src/agent-os/operations-recovery.ts`.

### Canonical

| Domain | Tables |
|---|---|
| Agent Home | `agent_profiles`, `agent_conversations`, `agent_sessions`, `agent_session_actions`, `agent_session_action_reconciliations`, `conversation_events`, `conversation_event_conflicts` |
| Retention and transcript integrity | `agent_home_retention_policies`, `agent_home_retention_runs`, `agent_home_raw_artifact_archives`, `agent_home_evidence_bundle_repairs`, `agent_home_transcript_repairs` |
| Runtime/workspace | `workspaces`, `workspace_assignments`, `processes`, `process_output`, `terminal_workspace_state`, `terminal_command_history`, `daemon_leases` |
| Contract/scheduling | `jobs`, `job_market_assignments`, `job_market_contracts`, `job_market_criteria`, `job_market_dependencies` |
| Delivery/evidence | `delivery_reports`, `delivery_deliverable_results`, `delivery_criterion_results`, `delivery_review_comments`, `delivery_verification_runs`, `delivery_artifact_attestations`, `delivery_regressions`, `delivery_shipment_receipts`, `delivery_shipments`, `delivery_autoship_intents`, `delivery_autoship_completions`, `artifacts` |
| Provider acceptance | `provider_acceptance_evidence` |
| Control plane | `os_command_receipts`, `os_events`, `attention_items`, `policies`, `checkpoints`, `context_items` |
| Knowledge persistence and retrieval | `knowledge_sources`, `knowledge_chunks`, `context_builds`, `context_build_sources`, `context_build_entries`, `context_uses`, `knowledge_retrieval_schema`, `knowledge_retrieval_documents`, `knowledge_retrieval_index_state`, and the `knowledge_retrieval_fts*` virtual-table family |
| Organization and authority | `os_organizations`, `os_product_areas`, `os_teams`, `os_positions`, `os_team_memberships`, `os_membership_transitions`, `os_role_definitions`, `os_role_assignments`, `os_role_activations`, `os_capability_attestations`, `os_authority_policies`, `os_team_ownerships` |
| Coordination and risk control | `os_team_interactions`, `os_responsibility_assignments`, `os_objectives`, `os_team_goals`, `os_capacity_snapshots`, `os_message_envelopes`, `os_decision_records`, `os_escalations`, `os_risk_evaluations`, `os_participation_history`, `os_control_approvals` |
| Assurance and learning | `os_trace_nodes`, `os_trace_edges`, `os_provenance_attestations`, `os_quality_gate_definitions`, `os_quality_gate_runs`, `os_quality_gate_results`, `os_quality_gate_overrides`, `os_metric_definitions`, `os_scorecards`, `os_metric_observations`, `os_calibration_reviews`, `os_access_certifications`, `os_review_appeals`, `os_incidents`, `os_incident_timeline`, `os_postmortems`, `os_corrective_actions`, `os_knowledge_promotions` |
| Outcome analytics | `outcome_analytics_schema`, `outcome_analytics_secrets`, `outcome_usage_observations`, `outcome_usage_context_receipts`, `outcome_usage_provider_bindings`, `outcome_activity_observations`, `outcome_context_refresh_receipts`, `outcome_budget_policies`, `outcome_operation_confirmations`, `outcome_operation_bindings`, `outcome_operation_consumptions`, `outcome_operation_context_receipts`, `outcome_operation_usage_links`, `outcome_operation_usage_reconciliations`, `outcome_team_digests`, `outcome_benchmark_observations`, `outcome_benchmark_evidence_bindings` |
| Secure remote authority | `os_device_sessions`, `os_device_credentials`, `os_device_proof_replays`, `os_pairing_tickets`, `os_pairing_ticket_resources`, `os_remote_resource_grants`, `os_remote_step_up_grants`, `os_remote_stream_tickets`, `os_remote_mutation_audit`, `os_remote_security_events`, `os_remote_rate_limits`, `os_remote_messages`, `os_remote_push_subscriptions`, `os_remote_notification_preferences`, `os_remote_control_state` |

### Compatibility

| Table | Current role |
|---|---|
| `boards` | shared project/board scope used by both products |
| `task_contracts` | card-keyed TaskContract bridge and current canonical launch input |
| `agent_usage` | original agent-keyed usage storage now carrying provider-neutral additions |

### Legacy

| Table | Current role |
|---|---|
| `agents` | Board presence and hired-agent compatibility identity |
| `cards` | original Board task surface |
| `card_events` | original card activity log |
| `messages` | ask/reply/task/notify/announce/swarm transport |
| `message_targets` | explicit fan-out recipient snapshot |
| `deliveries` | message-recipient receipt; **not** a work Delivery |
| `milestones` | ordered Board planning steps |
| `ideas` | Roadmap idea records |
| `review_decisions` | Board approve/send-back record |
| `token_telemetry` | injected-context hook accounting |

### Infrastructure

`kv` stores daemon settings/cache values. `os_schema_migrations` records applied Agent OS
migrations. `os_compatibility_projection_links` records deterministic source-to-canonical
identity, `os_compatibility_projection_quarantine` records rows that cannot be migrated without
guessing, and `os_compatibility_migration_checks` records the five validation categories. The
four `os_compatibility_migration_telemetry_*` tables hold privacy-safe observation, rollup, and
coverage state. The three `os_compatibility_failure_*` tables preserve crash-safe failure,
success-receipt, and day-seal evidence. SQLite's own internal tables are intentionally excluded.

## HTTP APIs

The extractor reads literal Fastify `get/post/put/patch/delete` registrations from
`src/server.ts`, `src/push.ts`, `src/agent-session-controls.ts`,
`src/agent-os/routes.ts`, `src/agent-os/contract-template-routes.ts`,
`src/agent-os/agent-home-routes.ts`, and
`src/agent-os/agent-home-retention-routes.ts`, and
`src/agent-os/job-assignment-routes.ts`, `src/agent-os/open-work-routes.ts`,
`src/agent-os/organization-routes.ts`, `src/agent-os/delivery-trackbook-routes.ts`,
`src/agent-os/knowledge-management-routes.ts`, `src/agent-os/discussion-routes.ts`, and
`src/agent-os/team-planning-routes.ts`, and `src/agent-os/outcome-analytics-routes.ts`. The seven
session action routes are expanded from
`AGENT_HOME_SESSION_ACTIONS` in `src/agent-os/agent-home-lifecycle.ts:39`.

This 231-route compatibility inventory is deliberately scoped to the `route_sources` array in the
machine manifest. Separately registered secure-remote, operations/support and session-tool routes
are current integrated surfaces documented by their own closed authorization contracts; they are
not silently counted in this historical compatibility tripwire. The final release review must use
the dedicated remote/operations route tests in addition to this extractor rather than presenting
231 as the entire daemon route count.

### Canonical routes

```text
DELETE /api/v1/os/discussions/:discussionId/subscriptions/:profileId
GET /api/v1/os/boards/:boardId/discussion-promotions
GET /api/v1/os/boards/:boardId/discussion-queues/:queue
GET /api/v1/os/boards/:boardId/discussions
GET /api/v1/os/boards/:boardId/knowledge
GET /api/v1/os/boards/:boardId/knowledge/benchmarks
GET /api/v1/os/boards/:boardId/knowledge/promotions
GET /api/v1/os/boards/:boardId/knowledge/reviews
GET /api/v1/os/boards/:boardId/team-conflicts
GET /api/v1/os/boards/:boardId/team-plans
GET /api/v1/os/boards/:boardId/team-visualization
GET /api/v1/os/boards/:id/delivery-trackbook
GET /api/v1/os/context-builds/:buildId/knowledge-manifest
GET /api/v1/os/discussions/:discussionId
GET /api/v1/os/jobs/:id/detail
GET /api/v1/os/team-plans/:planId
PATCH /api/v1/os/discussions/:discussionId/posts/:postId
POST /api/v1/os/boards/:boardId/discussion-permissions
POST /api/v1/os/boards/:boardId/discussions
POST /api/v1/os/boards/:boardId/knowledge/benchmarks
POST /api/v1/os/boards/:boardId/knowledge/ingest/graphify
POST /api/v1/os/boards/:boardId/knowledge/promotions
POST /api/v1/os/boards/:boardId/knowledge/promotions/:promotionId/review
POST /api/v1/os/boards/:boardId/knowledge/refresh
POST /api/v1/os/boards/:boardId/knowledge/sources/:sourceId/actions
POST /api/v1/os/boards/:boardId/team-plans
POST /api/v1/os/deliveries/:id/artifacts/:artifactId/attest
POST /api/v1/os/deliveries/:id/reject-with-feedback
POST /api/v1/os/deliveries/:id/reopen-regression
POST /api/v1/os/deliveries/:id/review-comments
POST /api/v1/os/deliveries/:id/revise-rejected
POST /api/v1/os/deliveries/:id/ship
POST /api/v1/os/deliveries/:id/verification-runs
POST /api/v1/os/discussion-permissions/:permissionId/revoke
POST /api/v1/os/discussion-promotions/:promotionId/review
POST /api/v1/os/discussions/:discussionId/accept
POST /api/v1/os/discussions/:discussionId/posts
POST /api/v1/os/discussions/:discussionId/posts/:postId/promotion
POST /api/v1/os/discussions/:discussionId/transition
POST /api/v1/os/team-conflict-knowledge-candidates/:candidateId/review
POST /api/v1/os/team-conflicts/:conflictId/knowledge-candidates
POST /api/v1/os/team-conflicts/:conflictId/proposals
POST /api/v1/os/team-conflicts/:conflictId/resolve
POST /api/v1/os/team-plans/:planId/:command
PUT /api/v1/os/discussions/:discussionId/subscriptions/:profileId
DELETE /api/v1/os/processes/:id
DELETE /api/v1/os/workspaces/:id
GET /api/v1/os/agent-profiles/:id
GET /api/v1/os/agent-profiles/:id/conversations
GET /api/v1/os/agent-profiles/:id/home
GET /api/v1/os/agent-profiles/:id/sessions
GET /api/v1/os/boards/:id/agent-profiles
GET /api/v1/os/boards/:id/attention
GET /api/v1/os/boards/:id/conflicts
GET /api/v1/os/boards/:id/events
GET /api/v1/os/boards/:id/jobs
GET /api/v1/os/boards/:id/policies
GET /api/v1/os/boards/:id/retention
GET /api/v1/os/boards/:id/workspaces
GET /api/v1/os/boards/:boardId/assignments
GET /api/v1/os/boards/:boardId/organizations
GET /api/v1/os/boards/:boardId/outcomes/benchmarks/:suiteKey
GET /api/v1/os/boards/:boardId/outcomes/dashboard
GET /api/v1/os/cards/:cardId/assignments
GET /api/v1/os/cards/:cardId/assignments/current
GET /api/v1/os/cards/:id/contract
GET /api/v1/os/cards/:id/contract/validate
GET /api/v1/os/cards/:id/deliveries
GET /api/v1/os/cards/:id/evidence
GET /api/v1/os/compatibility-migration-telemetry/daily
GET /api/v1/os/compatibility-migration-telemetry/summary
GET /api/v1/os/compatibility-migration-telemetry/writer-observation
GET /api/v1/os/contract-templates
GET /api/v1/os/conversations/:id
GET /api/v1/os/conversations/:id/events
GET /api/v1/os/conversations/:id/events/:eventId
GET /api/v1/os/conversations/:id/export
GET /api/v1/os/conversations/:id/search
GET /api/v1/os/deliveries/:id/export
GET /api/v1/os/drivers
GET /api/v1/os/jobs/:id
GET /api/v1/os/open-work
GET /api/v1/os/organizations/:organizationId/control-center
GET /api/v1/os/plugins
GET /api/v1/os/processes/:id
GET /api/v1/os/processes/:id/output
GET /api/v1/os/providers
GET /api/v1/os/providers/:id/update-command
GET /api/v1/os/providers/auth
GET /api/v1/os/providers/updates
GET /api/v1/os/sessions/:id
GET /api/v1/os/sessions/:id/events
GET /api/v1/os/sessions/:id/export
GET /api/v1/os/sessions/:id/search
GET /api/v1/os/settings/agent-defaults
GET /api/v1/os/workspaces/:id
GET /api/v1/os/workspaces/:id/checkpoints
GET /api/v1/os/workspaces/:id/context
GET /api/v1/os/workspaces/:id/git
GET /api/v1/os/workspaces/:id/processes
GET /api/v1/os/workspaces/:id/terminal-history
GET /api/v1/os/workspaces/:id/terminal-selection
PATCH /api/v1/os/agent-profiles/:id
PATCH /api/v1/os/conversations/:id
PATCH /api/v1/os/workspaces/:id
POST /api/v1/os/agent-profiles/:id/archive
POST /api/v1/os/agent-profiles/:id/conversations
POST /api/v1/os/attention/:id/resolve
POST /api/v1/os/boards/:id/agent-profiles
POST /api/v1/os/boards/:id/jobs
POST /api/v1/os/boards/:id/policies
POST /api/v1/os/boards/:id/retention/run
POST /api/v1/os/boards/:id/workspaces
POST /api/v1/os/boards/:boardId/organizations
POST /api/v1/os/boards/:boardId/outcomes/activity
POST /api/v1/os/boards/:boardId/outcomes/benchmarks
POST /api/v1/os/boards/:boardId/outcomes/budgets
POST /api/v1/os/boards/:boardId/outcomes/budgets/evaluate
POST /api/v1/os/boards/:boardId/outcomes/digests
POST /api/v1/os/boards/:boardId/outcomes/operations
POST /api/v1/os/boards/:boardId/outcomes/usage
POST /api/v1/os/cards/:cardId/assignments/:assignmentId/reassign
POST /api/v1/os/cards/:cardId/assignments/:assignmentId/release
POST /api/v1/os/cards/:cardId/assignments/assign
POST /api/v1/os/cards/:cardId/assignments/claim
POST /api/v1/os/cards/:cardId/contract/templates/:templateId/apply
POST /api/v1/os/cards/:cardId/contract/brief-preview
POST /api/v1/os/cards/:cardId/open-work/dispatch
POST /api/v1/os/cards/:cardId/open-work/match
POST /api/v1/os/cards/:id/contract/publish
POST /api/v1/os/cards/:id/contract/transition
POST /api/v1/os/cards/:id/evidence
POST /api/v1/os/checkpoints/:id/fork
POST /api/v1/os/compatibility-migration-telemetry/rollup
POST /api/v1/os/compatibility-migration-telemetry/seal
POST /api/v1/os/contract-templates/:templateId/preview
POST /api/v1/os/conversations/:id/archive
POST /api/v1/os/conversations/:id/export
POST /api/v1/os/deliveries/:id/accept
POST /api/v1/os/deliveries/:id/reject
POST /api/v1/os/deliveries/:id/revise
POST /api/v1/os/deliveries/:id/verify
POST /api/v1/os/jobs/:id/cancel
POST /api/v1/os/jobs/:id/deliveries/prepare
POST /api/v1/os/jobs/:id/deliveries/submit
POST /api/v1/os/organizations/:organizationId/assurance/:command
POST /api/v1/os/organizations/:organizationId/coordination/:command
POST /api/v1/os/organizations/:organizationId/core/:command
POST /api/v1/os/outcomes/operations/:operationId/confirm
POST /api/v1/os/outcomes/operations/:operationId/consume
POST /api/v1/os/policies/:id/evaluate
POST /api/v1/os/processes/:id/commands
POST /api/v1/os/processes/:id/input
POST /api/v1/os/processes/:id/paste-image
POST /api/v1/os/processes/:id/resize
POST /api/v1/os/processes/:id/restart
POST /api/v1/os/processes/:id/signal
POST /api/v1/os/session-actions/:id/reconcile
POST /api/v1/os/sessions/:id/archive
POST /api/v1/os/sessions/:id/events
POST /api/v1/os/sessions/:id/export
POST /api/v1/os/sessions/:id/fork
POST /api/v1/os/sessions/:id/link
POST /api/v1/os/sessions/:id/pause
POST /api/v1/os/sessions/:id/rename
POST /api/v1/os/sessions/:id/resume
POST /api/v1/os/sessions/:id/retry
POST /api/v1/os/sessions/:id/stop
POST /api/v1/os/workspaces/:id/checkpoints
POST /api/v1/os/workspaces/:id/processes
PUT /api/v1/os/boards/:id/retention
PUT /api/v1/os/cards/:id/contract
PUT /api/v1/os/settings/agent-defaults
PUT /api/v1/os/workspaces/:id/context
PUT /api/v1/os/workspaces/:id/terminal-selection
```

### Compatibility routes

```text
DELETE /api/v1/agents/:id
GET /api/v1/agents/:id/inbox
GET /api/v1/agents/:id/mcp
GET /api/v1/agents/:id/transcript
GET /api/v1/fs/dirs
POST /api/v1/agents/:id/access-profile
POST /api/v1/agents/:id/approvals/:requestId
POST /api/v1/agents/:id/effort
POST /api/v1/agents/:id/fire
POST /api/v1/agents/:id/heartbeat
POST /api/v1/agents/:id/interrupt
POST /api/v1/agents/:id/leave
POST /api/v1/agents/:id/mcp/:name/reconnect
POST /api/v1/agents/:id/mcp/:name/toggle
POST /api/v1/agents/:id/model
POST /api/v1/agents/:id/paste-image
POST /api/v1/agents/:id/permission-mode
POST /api/v1/agents/:id/permissions/:requestId
POST /api/v1/agents/:id/plugins/reload
POST /api/v1/agents/:id/pulse
POST /api/v1/agents/:id/rename
POST /api/v1/agents/:id/subping
POST /api/v1/agents/:id/task
POST /api/v1/agents/register
POST /api/v1/cards/:id/approve
POST /api/v1/cards/:id/launch
POST /api/v1/cards/:id/move
POST /api/v1/cards/:id/restore
POST /api/v1/cards/:id/send-back
POST /api/v1/cards/:id/shipped
POST /api/v1/cards/:id/verification
POST /api/v1/cards/:id/verify
POST /api/v1/fs/pick-dir
```

These routes do not all behave identically. In particular, card launch returns either a canonical
or legacy envelope depending on `ORCHESTRA_CANONICAL_LAUNCH` (`src/server.ts:897`), while Board
review/move routes consult Trackbook gates for managed cards (`src/server.ts:409`,
`src/server.ts:646`).

### Legacy routes

```text
DELETE /api/v1/boards/:id
DELETE /api/v1/cards/:id
DELETE /api/v1/ideas/:id
DELETE /api/v1/messages/:id
DELETE /api/v1/milestones/:id
GET /api/v1/boards
GET /api/v1/boards/:id/events
GET /api/v1/boards/:id/reviews
GET /api/v1/boards/:id/shipped
GET /api/v1/boards/:id/snapshot
GET /api/v1/boards/:id/telemetry
GET /api/v1/boards/:id/timeline
GET /api/v1/cards/:id/events
GET /api/v1/cards/:id/ledger
GET /api/v1/cards/:id/reviews
PATCH /api/v1/cards/:id
PATCH /api/v1/milestones/:id
GET /api/v1/boards/:id/teams
GET /api/v1/messages/:id/attachments/:index
GET /api/v1/messages/:id/attachments/:index/raw
GET /api/v1/teams/:id
PATCH /api/v1/teams/:id
POST /api/v1/boards/:id/hire
POST /api/v1/boards/:id/next
POST /api/v1/boards/:id/teams
POST /api/v1/boards/:id/teams/design
POST /api/v1/teams/:id/approve
POST /api/v1/teams/:id/hire
POST /api/v1/teams/:id/refine
GET /api/v1/boards/:id/mastermind
POST /api/v1/boards/:id/mastermind
POST /api/v1/teams/:id/focus
DELETE /api/v1/teams/:id
POST /api/v1/boards/:id/wake
POST /api/v1/boards/resolve
POST /api/v1/cards
POST /api/v1/cards/:id/assign
POST /api/v1/cards/:id/assign-team
POST /api/v1/cards/:id/rank
PATCH /api/v1/cards/:id/milestone
PATCH /api/v1/cards/:id/funnel
POST /api/v1/cards/:id/breakdown
POST /api/v1/teams/:id/hire-member
POST /api/v1/ideas
POST /api/v1/ideas/:id/promote
POST /api/v1/messages
POST /api/v1/milestones
POST /api/v1/milestones/:id/steps
PUT /api/v1/cards/:id/contract
```

Direct Hire is included here because it explicitly returns `mode: "ambient"` and does not create
a canonical contract/job lifecycle (`src/server.ts:1055`).

### Infrastructure routes

```text
GET /api/v1/auth/status
GET /api/v1/events
GET /api/v1/push/status
GET /api/v1/push/vapid-key
GET /api/v1/system
GET /health
POST /api/v1/auth/login
POST /api/v1/auth/setup
POST /api/v1/push/ntfy
POST /api/v1/push/subscribe
POST /api/v1/push/test
POST /api/v1/push/unsubscribe
```

The three `/api/v1/auth/*` routes are loopback/loopback-Host-only password setup and session
exchange; they never accept remote ingress. `GET /api/v1/events` is the operator-authenticated global SSE stream
(`src/server.ts:1358`). Agent OS event history is the paged durable
`GET /api/v1/os/boards/:id/events`, not SSE.

## CLI API

The exact 140 compatibility-contract command paths are machine-checked from `src/cli.ts`,
`src/agent-os-cli.ts`, and `src/job-assignment-cli.ts`. Separately registered current commands
include `doctor`, `onboard`, `lifecycle-demo`, and `ops support-case`; their focused tests and
operator docs are additional release evidence rather than being silently folded into the 137-count
historical extractor. The compact human map is:

| Class | Command surface |
|---|---|
| Canonical | `agent {list,create,show,home,rename,archive}`; `session {list,show,resume,pause,stop,retry,fork,reconcile-fork,rename,archive,search,export}`; `retention {show,set,run}`; `workspace {list,create,show,update,archive}`; `process {list,start,output,attach,input,resize,signal,restart}`; `attention {list,resolve}`; `contract {show,set,validate,publish,transition}`; `contract-template {list,preview,apply}`; `evidence {list,add}`; `delivery {show,submit,verify,accept,reject,revise,export}`; `context {show,set}`; `checkpoint {list,create,fork}`; `job {list,create,cancel,assignment {list,current,claim,assign,release,reassign}}`; `organization {list,create,show,command}`; `policy {list,create,evaluate}`; `events`; `conflicts`; `drivers`; `plugins` |
| Compatibility | `hire`; `task`; `fire`; `wake`; `shipped` |
| Legacy | `join`; `card {create,update,move}`; `ask`; `reply`; `notify`; `note`; `announce`; `swarm`; `pulse`; `snapshot`; `idea`; `idea-done`; `ideas`; `milestone`; `step` |
| Infrastructure | `serve`; `stop`; `restart`; `token`; `password {status,reset}`; `remote`; `hook`; `init`; `install`; `uninstall`; `integrations`; `remember`; `handoff` |

Root command names and every child command are listed individually in
`agent-os-surface-inventory.json`; the test expands the dynamic Agent Home session-action loop so
those routes and CLI commands cannot drift silently.

## Events and projections

| Ledger/channel | Class | Contract | Source |
|---|---|---|---|
| `conversation_events` | canonical | ordered provider-neutral transcript with 9 closed kinds: `user`, `assistant`, `system`, `tool`, `tool_result`, `approval`, `usage`, `status`, `error` | `src/agent-os/conversations.ts:34` |
| `conversation_event_conflicts` | canonical | retains conflicting provider replay instead of overwriting canonical history | `src/agent-os/conversations.ts:970` |
| `os_events` | canonical | append-only causal operational ledger; open namespaces are enumerated in the JSON inventory | `src/agent-os/event-store.ts:55` |
| `card_events` | legacy | original card activity log and shipped/review compatibility evidence | `src/db.ts:36` |
| `messages` + recipient receipts | legacy | closed message kinds: `ask`, `reply`, `task`, `notify`, `announce`, `swarm` | `src/server.ts:81` |
| global/board SSE bus | mixed | 16 legacy event names plus `os:driver`, `os:runtime`, and `os:workspace`; it is live fan-out, not durable truth | `src/server.ts:112`, `src/agent-os/runtime-integration.ts:338`, `src/agent-os/runtime-integration.ts:418`, `src/agent-os/runtime-integration.ts:2401` |
| `LegacyEventProjection` | compatibility | projects `legacy.<bus-type>` into `os_events` and creates selected attention items | `src/agent-os/legacy-projection.ts:23` |

Provider Driver events have the closed types `output`, `status`, `tool`, `error`, and `exit`
(`src/runtime/types.ts:204`). Runtime PTY events have 11 closed `process.*` kinds
(`src/runtime/types.ts:113`). `os_events` intentionally allows versioned domain namespaces because
Job, Delivery, lifecycle, and compatibility helpers accept a kind parameter. The drift test
therefore exact-checks the closed vocabularies and source-backs the open namespace list instead of
pretending the open ledger is an enum.

Safe projection is part of the event boundary: raw approval parameters, credential-shaped content,
Codex reasoning, and Claude thinking must not enter managed `os_events`; the full approval form is
live operator state, not durable event payload.

## UI surfaces

Primary navigation is defined in `web/src/App.tsx` and `web/src/boardNavigation.ts`; composition is
in `web/src/BoardSection.tsx`.

| Surface | Class | Implementation |
|---|---|---|
| Board → Overview | legacy | `web/src/Board.tsx` |
| Board → Agents / Agent Home | canonical | `web/src/AgentHome.tsx` |
| Board → Messages | legacy | `web/src/MessagesView.tsx` |
| Board → Workspace | canonical | `web/src/WorkspaceTerminal.tsx` |
| Board → Git (Commits / Pushes) | canonical | `web/src/ShippedView.tsx` |
| Roadmap | legacy | `web/src/RoadmapView.tsx` |
| Settings | infrastructure | `web/src/SettingsView.tsx` |
| Needs You | canonical | `web/src/NeedsYou.tsx` |
| Card Trackbook summary/review buttons | compatibility | `web/src/CardTrackbookSummary.tsx`, `web/src/CardDrawer.tsx` |
| Agent Home mobile panes | canonical | Conversation, Terminal, Details (`web/src/AgentHome.tsx:729`) |
| Agent Home detail tabs | canonical | Work, Context, Tools, Usage, History (`web/src/AgentHomePanels.tsx:442`) |
| Workspace panes | canonical | Terminal only — the cockpit panes were deleted (`web/src/WorkspaceTerminal.tsx`) |
| Phone install surface | infrastructure | responsive web UI plus `web/public/manifest.webmanifest` |

There is one responsive web application, not a separate phone product. The exact UI evidence
markers are listed in the JSON inventory and fail the drift test if removed or renamed.

## Planned domains without complete current surfaces

No canonical domain in this inventory is represented only by a reserved service slot.
`device_pairing` is an executable canonical boundary backed by `SqliteDeviceSessionRepository`:
it owns single-use PairingTickets, named scoped DeviceSessions, credential expiry, selective
revocation, and device attribution. Route authorization remains separately default-deny, and this
inventory truth does not close the native `REM-017`/`REM-GATE` or production operations acceptance
gates.

## Drift-check contract

Run:

```sh
/Users/arminrad/.nvm/versions/node/v22.20.0/bin/node \
  ./node_modules/vitest/vitest.mjs run test/agent-os-baseline-docs.test.ts
```

The test:

1. opens a fresh in-memory database and exact-compares every application table;
2. extracts every contract-scoped literal HTTP route, applies Agent OS prefixes, expands session
   actions, and exact-compares all 234 signatures;
3. extracts every command in the manifest's three scoped Commander sources and exact-compares all
   140 command paths;
4. exact-compares closed message, conversation, driver, runtime, workspace, and session-action
   vocabularies;
5. exact-compares legacy/canonical live-bus names;
6. verifies that every UI inventory entry still has its source evidence marker.

A new or removed table, route, command, closed event kind, or declared UI surface breaks the test
until an engineer deliberately classifies it and updates this document/manifest. Human review is
still required for classification changes, dynamic open `os_events` namespaces, and determining
whether a compatibility surface can be retired.
