# Typed Job Market Contracts

Status: the typed contract, validation, lifecycle, dependency, budget, and audit foundation is
implemented. Open Work UX, assignment lifecycle, templates/editor, and capability matching remain
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

## Audit contract

Scope, deliverable, criterion, owner, dependency, constraint, budget, and lifecycle changes append
field-level causal events with board, workspace, card, contract version, actor, before/after value,
and optional reason. Workspace scope is queryable through the canonical event ledger.

## API and CLI

Routes under `/api/v1/os`:

- `GET|PUT /cards/:id/contract`
- `GET /cards/:id/contract/validate?mode=publish|launch`
- `POST /cards/:id/contract/publish`
- `POST /cards/:id/contract/transition`

CLI parity:

- `orchestra contract show|set`
- `orchestra contract validate`
- `orchestra contract publish`
- `orchestra contract transition`

Publish and transition mutations remain operator-only. Contract reads and validation retain the
existing authenticated Agent OS boundary.

## Evidence

- Integrated commit: `8ae2eeb`.
- Focused merge gate: 6 files / 51 tests.
- Full Node 22.20.0 repository gate: 97 files / 596 tests.
- Root/web TypeScript and production builds pass.
- Migration tests prove missing prerequisites roll back and are not recorded.
- Domain tests prove typed round-trip, lifecycle CAS/idempotency, dependency completion,
  launch zero-write failure, and workspace-filterable audits.
- Independent review returned PASS after all three initially found data-integrity defects were
  corrected.

## Remaining

- Open Work filtering and dependency/critical-path visualization;
- explicit claim, assignment, release, and reassignment;
- contract templates and validated editor/agent-brief preview;
- scheduler matching by declared capability and current capacity;
- collaborative ownership through Teams;
- full publish → match/assign → dependency-ready → exactly-one-job acceptance gate.
