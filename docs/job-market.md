# Typed Job Market Contracts

Status: the typed contract, validation, lifecycle, dependency, budget, and audit foundation is
implemented. Six deterministic built-in contract templates are available through API and CLI.
Open Work UX, assignment lifecycle, the contract editor, and capability matching remain open.

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

Declared capabilities currently generate a validation warning because capability/capacity matching
belongs to the future scheduler matcher; they are not represented as already enforced.

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

## Audit contract

Scope, deliverable, criterion, owner, dependency, constraint, budget, and lifecycle changes append
field-level causal events with board, workspace, card, contract version, actor, before/after value,
and optional reason. A changed template apply also appends `job_market.template_applied` with the
template/version, variable names (not values), replaced fields, actor, and resulting versions.
Workspace scope is queryable through the canonical event ledger.

## API and CLI

Routes under `/api/v1/os`:

- `GET|PUT /cards/:id/contract`
- `GET /cards/:id/contract/validate?mode=publish|launch`
- `POST /cards/:id/contract/publish`
- `POST /cards/:id/contract/transition`
- `GET /contract-templates`
- `POST /contract-templates/:templateId/preview`
- `POST /cards/:cardId/contract/templates/:templateId/apply`

CLI parity:

- `orchestra contract show|set`
- `orchestra contract validate`
- `orchestra contract publish`
- `orchestra contract transition`
- `orchestra contract-template list`
- `orchestra contract-template preview <template> --vars <json>`
- `orchestra contract-template apply <card> <template> --vars <json> [--replace]`

Publish, transition, and template replacement remain operator-only. Contract/template reads and
preview/validation retain the existing authenticated Agent OS boundary.

## Evidence

- Typed Job Market foundation commit: `8ae2eeb`.
- JOB-013 template-specific gate: 3 files / 8 tests.
- Combined Job Market, API, CLI, surface-inventory, and threat-model gate: 8 files / 39 tests.
- Full Node 22.20.0 serial repository gate: 117 files / 787 tests.
- Root TypeScript and production build pass.
- Migration tests prove missing prerequisites roll back and are not recorded.
- Domain tests prove typed round-trip, lifecycle CAS/idempotency, dependency completion,
  launch zero-write failure, and workspace-filterable audits.
- Template tests prove stable built-in ordering, strict variables, complete verifier/evidence/risk/
  budget output, explicit replacement, atomic conflict rollback, lifecycle preservation,
  non-destructive release defaults, audited apply, and zero-write deterministic reapply.

## Remaining

- Open Work filtering and dependency/critical-path visualization;
- explicit claim, assignment, release, and reassignment;
- validated contract editor and generated agent-brief preview;
- scheduler matching by declared capability and current capacity;
- collaborative ownership through Teams;
- full publish → match/assign → dependency-ready → exactly-one-job acceptance gate.
