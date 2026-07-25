# Typed Job Market Contracts

Status: the typed contract, validation, lifecycle, dependency, budget, audit, and exclusive
assignment foundation is implemented. Six deterministic built-in contract templates and the
canonical assignment lifecycle are available through API and CLI. Open Work UX, runtime
job/session binding, scheduler matching, the contract editor, and collaborative ownership remain
open.

This slice is tracked in the [Agent OS North Star Delivery Program](./north-star-delivery-program.md).

## Product contract

`TaskContractService` remains the compatibility source for existing objective, deliverables,
stable criteria IDs, dependencies, verification commands, workspace, policy, priority, and
token/cost fields. `JobMarketService` is an additive typed layer; it does not create a second
competing contract identity.

Migration `009-job-market-domain` adds:

- `job_market_contracts` for lifecycle, constraints, extended budgets, version, and timestamps;
- `job_market_criteria` for description, verifier, required artifacts, priority, and owner;
- `job_market_dependencies` for same-board blockers and completion conditions.

Migration 009 reserves migration 008 for Agent Home controls and fails atomically when the
compatibility `cards` and `task_contracts` prerequisites are absent.

Migration `016-job-market-assignment-lifecycle` adds:

- `job_market_assignments`, an immutable board/card/profile/workspace responsibility history;
- one active exclusive assignment per card;
- market-version and assignment-version compare-and-set guards;
- frozen nullable assignment identity columns on `jobs` and `agent_sessions` for phase-two runtime
  binding;
- scope, capability, dependency, profile-archive, active-execution, lifecycle, and identity
  triggers.

Migration 016 requires migration 015 and the Job Market, Agent Home, event, workspace, and runtime
tables. It creates no assignment rows for legacy card owners or pre-016 runtime state.

Pre-016 ownerless `assigned` contracts with no active job or session are safely returned to `open`
with a version increment. `assigned` contracts that still have active execution, plus `running` and
`submitted` contracts, retain their legacy lifecycle state until that work finishes. Both outcomes
write a migration audit event with an explicit remediation. Retained legacy states cannot be
re-asserted through a same-state `assigned` transition and are ineligible for canonical assignment
until their normal lifecycle returns them to `open`.

`cards.owner_agent_id` remains a compatibility projection. Phase one rejects a non-null legacy
owner instead of creating dual authority; the phase-two runtime-binding migration must replace
that guard with a proven assignment-bound projection before the executor writes legacy ownership.

## Typed fields

Every Job Market aggregate returns:

- the compatibility contract and its stable criterion IDs;
- criterion descriptions, command/artifact/human/custom verifiers, required artifacts, priority,
  and owner;
- required capabilities, allowed providers/models, and read-only/workspace-write/full-access
  needs;
- token, cost, time, retry, coordination-token, and coordination-message budgets;
- dependency card, blocking reason, and `card_done` completion condition;
- lifecycle status, market version, publish/archive time, and update time.

## Validation and lifecycle

Publish validation requires an objective, at least one deliverable, at least one complete
criterion/verifier, and valid dependency rules. Every dependency must exist on the same board and
be in the `done` column.

Launch validation additionally requires `open` or `assigned` status, an allowed provider/model,
and an access profile at least as strong as the declared need. Validation runs before canonical
orchestration creates durable job, session, or workspace-assignment writes.

The lifecycle supports:

`draft → open → assigned → running → submitted → accepted/rejected → archived`

with explicit cancellation/rework paths. Updates use a market version and compare-and-swap state
transition so concurrent writers reload instead of silently overwriting one another.

Declared capabilities still generate a general contract-validation warning because scheduler
capacity matching is not implemented. Canonical claim, assign, and reassign commands do enforce
every declared required capability against the selected active AgentProfile before writing.

## Exclusive assignment lifecycle

`JobAssignmentService` is the authoritative responsibility boundary:

`open contract → claim | assign → active assignment → release | reassign`

- Claim and assign require an open contract, its exact market version, a same-board active profile,
  complete dependencies, required capabilities, compatible active workspace scope, no legacy
  owner, and no active job/session.
- Reassign requires the exact active assignment and market versions. It atomically supersedes the
  predecessor and creates one successor, so no intermediate dual-owner or ownerless state is
  visible.
- Release terminalizes the assignment and returns assigned/rejected/cancelled contracts to `open`;
  accepted and archived contracts retain their terminal market status.
- Every command has a board-scoped idempotency key and normalized request fingerprint. Identical
  retries return the original result snapshot; changed intent under the same key conflicts.
- Actor identity is derived at the API boundary. Raw request parameters and client-supplied actors
  are never copied into managed `os_events`.
- Direct generic lifecycle transition to `assigned`, or back to `open` while an assignment is
  active, is rejected with a canonical-command remediation.

Assignment history is append/terminalize only: identity fields cannot be rewritten, terminal rows
cannot be reopened, and profile/card/workspace scope changes cannot displace retained history. A
workspace must be active when selected, but phase one does not block later workspace
failed/missing/archived cleanup because runtime coordination is not yet assignment-aware.

Phase one deliberately does not wire assignment identity into scheduler-created jobs or managed
sessions. The nullable frozen columns and invariants are ready for that phase-two cutover,
including queued-only identity injection and ordinary profile/conversation linking after a bound
job starts.

## Built-in templates

The built-in registry has a stable order and versioned IDs:

| Order | ID | Required variables | Default verification |
|---:|---|---|---|
| 1 | `bug-fix` | `objective`, `affected_area`, `reproduction` | `npm test` |
| 2 | `feature` | `objective`, `user_outcome`, `affected_area` | `npm test`, `npm run build` |
| 3 | `research` | `question`, `scope`, `decision` | evidence artifacts |
| 4 | `review` | `objective`, `review_scope`, `review_standard` | evidence artifacts |
| 5 | `test` | `objective`, `test_scope`, `behavior` | `npm test` |
| 6 | `release` | `objective`, `release_scope`, `version` | `npm test`, `npm run build` |

Every preview includes stable deliverable/criterion IDs, criterion verifiers, required evidence,
risks, capabilities, access needs, and token/cost/time/retry/coordination budgets. Variables are
strict: missing, blank, oversized, and unknown keys fail closed.

Applying a template controls only its generated scope, criteria, verification, constraint, and
budget fields. It preserves dependency rules, policy/workspace links, and lifecycle state. The
default conflict strategy is `reject`; replacing conflicting template-owned fields requires
explicit `conflict_strategy=replace` or CLI `--replace`. An identical reapply performs no write and
adds no duplicate audit event.

Templates never publish a contract or mutate remote state. In particular, the release template
performs local test/build verification only; it does not push, publish, tag, or deploy.
Authenticated preview/apply responses intentionally return the rendered contract requested by the
caller and can therefore echo caller-supplied template values. Managed events are a different trust
boundary and never retain those raw values.

Template preview is card-specific. It returns `expected_state`, an exact compare-and-set token with
the card, Job Market version, task-contract version, current-state SHA-256 hash, template identity,
and rendered-preview hash. Preview obtains the canonical initial state through a rollback-only snapshot,
so it commits no task-contract, Job Market, criterion, dependency, or event rows. Apply requires the
complete token. The server validates it inside the same immediate transaction as replacement; any
intervening lifecycle, dependency, policy, workspace, contract, or rendered-template change returns
HTTP `409` before contract or event writes. A successful apply returns `next_expected_state`, which
can be used for an unchanged idempotent reapply. Retrying the exact original successful apply is also
a zero-write `200`: the server accepts a stale token only when the durable template-application audit
matches its card, template, preview, actor, strategy, expected state, and the still-current result hash.

## Audit contract

Scope, deliverable, criterion, owner, dependency, constraint, budget, and lifecycle changes append
field-level causal events with board, workspace, card, contract version, actor, before/after value,
and optional reason. A changed template apply also appends `job_market.template_applied` with the
template/version, variable names (not values), replaced fields, actor, and resulting versions.
For template applies, `task_contract.updated` and the normal changed-group events retain their kinds,
ordering, actor, versions, changed field names, and before/after SHA-256 + structural shape, but redact
rendered strings before they enter `os_events`. Structural projections record counts and value shapes,
not arbitrary nested metadata keys. This keeps provenance and lost-response replay proof without
turning the event ledger into a credential or prompt store.
Workspace scope is queryable through the canonical event ledger.

## API and CLI

Routes under `/api/v1/os`:

- `GET|PUT /cards/:id/contract`
- `GET /cards/:id/contract/validate?mode=publish|launch`
- `POST /cards/:id/contract/publish`
- `POST /cards/:id/contract/transition`
- `GET /contract-templates`
- `POST /contract-templates/:templateId/preview` with `{ card_id, variables }`
- `POST /cards/:cardId/contract/templates/:templateId/apply` with
  `{ variables, expected_state, conflict_strategy?, actor? }`
- `GET /boards/:boardId/assignments`
- `GET /cards/:cardId/assignments`
- `GET /cards/:cardId/assignments/current`
- `POST /cards/:cardId/assignments/claim|assign`
- `POST /cards/:cardId/assignments/:assignmentId/release|reassign`

CLI parity:

- `orchestra contract show|set`
- `orchestra contract validate`
- `orchestra contract publish`
- `orchestra contract transition`
- `orchestra contract-template list`
- `orchestra contract-template preview <card> <template> --vars <json>`
- `orchestra contract-template apply <card> <template> --vars <json> --expected <json> [--replace]`
- `orchestra job assignment list [card]`
- `orchestra job assignment current <card>`
- `orchestra job assignment claim|assign <card> <profile> --expected-market-version <version>`
- `orchestra job assignment release <card> <assignment> --expected-market-version <version> --expected-assignment-version <version>`
- `orchestra job assignment reassign <card> <assignment> <profile> --expected-market-version <version> --expected-assignment-version <version>`

Publish, transition, template replacement, and assignment mutations remain operator-only.
Contract/template/assignment reads and preview/validation retain the existing authenticated Agent
OS boundary.

## Evidence

- Typed Job Market foundation commit: `8ae2eeb`.
- JOB-013 template-specific gate: 3 files / 10 tests.
- Combined Job Market, API, CLI, surface-inventory, and threat-model gate: 8 files / 39 tests.
- The compare-and-set integration base passed the full Node 22.20.0 serial repository gate:
  120 files / 813 tests, plus root TypeScript and production build.
- JOB-010 phase-one focused gate: 10 files / 79 tests on Node 22.20.0.
- The JOB-010 source candidate passed 122 files / 820 tests both serial and default-parallel,
  root and web TypeScript checks, production builds, and an independent P0-P2 review.
- Migration tests prove missing prerequisites roll back and are not recorded.
- Assignment migration tests prove explicit pre-016 lifecycle remediation, no legacy-owner or
  runtime backfill, one-active exclusivity, active-execution guards, scope,
  capability/dependency, profile-archive, immutable audit history, and frozen job/session identity
  invariants.
- Domain tests prove typed round-trip, lifecycle CAS/idempotency, dependency completion,
  launch zero-write failure, and workspace-filterable audits.
- Assignment domain/API/CLI tests prove original-snapshot replay, changed-intent conflicts,
  retained-history validation, cross-handle stale-writer rejection, atomic reassignment,
  dual-version release, server-derived actors, raw-parameter exclusion, operator boundaries, and
  exact command/route parity.
- Template tests prove stable built-in ordering, strict variables, complete verifier/evidence/risk/
  budget output, explicit replacement, atomic conflict rollback, lifecycle preservation,
  non-destructive release defaults, projected audits with an adversarial secret-marker scan,
  exact-request replay proof, and zero-write deterministic reapply.

## Remaining

- Open Work filtering and dependency/critical-path visualization;
- validated contract editor and generated agent-brief preview;
- scheduler job/session binding to the frozen assignment identity;
- scheduler matching by declared capability and current capacity;
- collaborative ownership through Teams;
- full publish → match/assign → dependency-ready → exactly-one-job acceptance gate;
- desktop and phone browser acceptance still requires an available configured browser instance;
- the release-level Codex protocol contract must be deliberately reconciled from pinned CLI
  0.144.6 to the installed 0.145.0 protocol before the product can be called shippable.
