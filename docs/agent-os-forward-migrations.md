# Agent OS compatibility forward migration

Status: **DOM-017 delivered** at exact code head
`74d632f46bfeaaead1c7a52ced8a317915baacbf`.

Migration `022-legacy-projection-forward-plan` turns the DOM-016 logical authority catalog into an
idempotent, fail-closed physical migration. It covers all **13 / 13** compatibility and legacy
tables without treating similarly named legacy concepts as canonical domains.

## TL;DR

| Contract | Exact behavior |
|---|---|
| Ordering | `021-command-idempotency-coverage` must be recorded before `022` runs |
| Atomicity | schema creation, backfill, validation evidence, and the `022` marker commit in one SQLite transaction |
| Row outcome | every row on the seven movable/validated sources receives one deterministic link or one quarantine record |
| Validation | count, key, scope, lifecycle, and linked-snapshot hash |
| Ambiguity | quarantine safe hashes and reason codes; never guess a canonical identity or write |
| Restart | replay is idempotent; deleting only the migration marker safely revalidates without duplicating links or events |
| Rollback | keep the additive schema and canonical writes; no automatic down migration |
| Cutover | no writer or reserved Phase 1 control is enabled by DOM-017; delivered DOM-019 telemetry supplies evidence but does not authorize cutover |

The executable source of truth is
`src/agent-os/compatibility-forward-migration.ts`. The exact migration wrapper is
`src/agent-os/migrations.ts`.

## Frozen 13-table plan

| Source | State | Forward action | Ambiguous or non-canonical behavior |
|---|---|---|---|
| `boards` | no data move | retain the existing positive integer key as shared scope | invalid scope aborts because every other identity depends on it |
| `task_contracts` | implemented | normalize through the existing Job Market contract, criteria, and dependency path | malformed JSON, cross-board dependencies, or conflicting typed rows are quarantined |
| `agent_usage` | implemented | retain the scoped aggregate as a compatibility baseline | orphan/cross-board keys are quarantined; no provider events or billing evidence are fabricated |
| `agents` | implemented | adopt a deterministic profile/default conversation and bind same-board sessions when collision-free | identity, name, conversation, workspace, or non-active-state collisions stay unadopted and quarantined |
| `cards` | implemented | record legacy scope or an exact canonical assignment/runtime lineage | no assignment is synthesized and `owner_agent_id` cannot create canonical authority |
| `card_events` | implemented | import valid history once into `os_events` with deterministic event/idempotency identity | invalid JSON, missing scope, cross-board actor, or unsafe kind is quarantined |
| `review_decisions` | implemented | link only one same-card delivery report with the matching terminal state | multiple revisions, state mismatch, or cross-board lineage is quarantined |
| `messages` | no data move | retain low-level transport semantics | no Discussion, membership, subscription, or accepted answer is inferred |
| `message_targets` | no data move | retain the recipient snapshot | no durable role, membership, subscription, or permission is inferred |
| `deliveries` | no data move | retain message-receipt semantics | no work Delivery, accepted evidence, or satisfied criterion is inferred |
| `milestones` | deferred | wait for a canonical planning domain | no Job, Team, PlanningSession, or dependency authority is fabricated |
| `ideas` | deferred | wait for a canonical roadmap/planning domain | no WorkContract, Discussion, or accepted plan is fabricated |
| `token_telemetry` | no data move | retain injected-context estimates in their original units | no provider usage, billing, or accepted-outcome evidence is inferred |

## Evidence schema

Migration `022` creates three additive infrastructure tables and two indexes:

| Table | Purpose |
|---|---|
| `os_compatibility_projection_links` | immutable source hash, target identity/hash, and disposition for deterministic migrations |
| `os_compatibility_projection_quarantine` | source hash, bounded reason code, and safe detail for rows that cannot be migrated without guessing |
| `os_compatibility_migration_checks` | last result hash and issue count for each validator |

The primary keys make link/quarantine/check evidence replay-safe. A source key may not exist in
both link and quarantine evidence; the key validator checks this explicitly. Exact normalized
`sqlite_master` definitions and required column sets are checked before and after backfill.
Populated partial lookalike schemas fail closed. Missing optional historical tables are treated as
empty only for direct upgrades from versions that predate them.

## Validation queries

The migration executes and stores all five categories before it records marker `022`:

| ID | Category | Zero means |
|---|---|---|
| `count.coverage` | count | every row on the seven handled sources has exactly one disposition candidate |
| `key.exclusive_disposition` | key | no source identity appears in both link and quarantine evidence |
| `scope.unquarantined_rows` | scope | orphan/cross-board usage or review rows are not silently accepted |
| `lifecycle.canonical_owner` | lifecycle | a managed card owner is backed by one active assignment/job/session identity or is quarantined |
| `hash.linked_snapshots` | hash | every linked source and target still exists and matches its recorded SHA-256 snapshot |

The first four are exported as
`AGENT_OS_COMPATIBILITY_VALIDATION_QUERIES`; the linked-snapshot validator is exported through
`validateCompatibilityForwardMigration`. Operators can inspect the persisted result:

```sql
SELECT validation_id, category, issue_count, result_hash, checked_at
FROM os_compatibility_migration_checks
WHERE migration_id = '022-legacy-projection-forward-plan'
ORDER BY validation_id;
```

Acceptance requires five rows and `issue_count = 0` for every row. Also run:

```sql
PRAGMA foreign_key_check;
PRAGMA integrity_check;
```

`foreign_key_check` must return no rows and `integrity_check` must return exactly `ok`.

## Upgrade procedure

1. Stop every Orchestra process that can write the target database.
2. Record the exact compatible application commit and database path.
3. Create and verify an offline-consistent SQLite backup:

   ```sh
   DB_PATH=/absolute/path/to/orchestra.db
   BACKUP_PATH=/absolute/path/to/orchestra.pre-022.db
   sqlite3 "$DB_PATH" ".backup '$BACKUP_PATH'"
   shasum -a 256 "$BACKUP_PATH"
   sqlite3 "$BACKUP_PATH" "PRAGMA integrity_check;"
   ```

4. Start exact code head `74d632f46bfeaaead1c7a52ced8a317915baacbf`. Startup applies migrations
   in numeric order inside one transaction. Migration `022` first validates prerequisites and
   evidence-schema compatibility, then links/backfills/imports, runs all five validators, stores
   their hashes, revalidates the evidence schema, and only then records its marker.
5. Confirm marker and validation state:

   ```sql
   SELECT id, applied_at
   FROM os_schema_migrations
   WHERE id = '022-legacy-projection-forward-plan';

   SELECT validation_id, category, issue_count, result_hash
   FROM os_compatibility_migration_checks
   WHERE migration_id = '022-legacy-projection-forward-plan'
   ORDER BY validation_id;
   ```

6. Run `PRAGMA foreign_key_check`, `PRAGMA integrity_check`, restart once, and rerun the checks.
7. Retain the backup hash, exact application commit, validation output, and restart evidence for
   the supported observation window.

If any prerequisite, schema fingerprint, row backfill, or validator fails, the enclosing
transaction rolls back schema, data, evidence, and marker together. Do not repair a failed row by
inventing an identity; correct the source or implement a reviewed forward repair.

## Compatibility range

- A pre-022 application that already supports migrations through `021` can read the retained
  legacy/compatibility tables on a copied 022 database because migration `022` is additive and
  does not disable those paths.
- The 022 application reads canonical links only where identity and snapshot evidence are exact.
  Quarantined and deliberately distinct rows remain on their named compatibility/legacy path.
- Old and new writers must not run concurrently during the upgrade or rollback decision.
- DOM-017 does not advance the reserved `agent_os.domain.canonical_ledger` control. Old-versus-new
  read/write and mismatch telemetry remains DOM-019.
- An unknown, populated partial schema; ambiguous identity; scope mismatch; lifecycle mismatch; or
  changed linked snapshot fails closed.

## Forward-only rollback

Rollback is a routing/application rollback, not a schema reversal:

1. Stop writers.
2. Preserve the migrated database and make another verified copy for diagnosis.
3. Disable new canonical entrypoints if a reviewed runtime binding exists; the Phase 1 control is
   currently reserved, so do not claim a flag was toggled when none exists.
4. Run only the prior compatible application commit against a copy of the migrated database.
5. Route rows without a verified canonical link through their retained compatibility path.
6. Keep canonical writes, imported events, link evidence, quarantine evidence, validation
   evidence, and migration markers intact.
7. Run all five validators plus SQLite foreign-key/integrity checks.

There is **no automatic down migration**. Never delete the three evidence tables, imported
`os_events`, normalized Job Market rows, adopted Agent Home identities, or canonical writes to
make an older view appear authoritative. Restore the pre-022 backup only as an explicit offline
recovery operation after preserving the failed database and confirming that discarding all
post-checkpoint writes is acceptable.

## Acceptance evidence

`test/compatibility-forward-migration.test.ts` proves:

- complete and immutable 13-table plan coverage;
- deterministic links/backfills/event import plus all five clean validators;
- quarantine for malformed, orphaned, cross-scope, and identity-collision rows;
- restart and marker-loss replay without duplicate links, profiles, conversations, or events;
- linked-snapshot drift detection and rejection of an incompatible full-column evidence schema.

The package/document drift contract is
`test/compatibility-forward-migration-docs.test.ts`.
