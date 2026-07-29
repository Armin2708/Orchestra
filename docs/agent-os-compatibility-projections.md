# Agent OS legacy projection and compatibility-view contract

Status: **DOM-016 delivered** at exact code head
`f5df13666ccdfdf552e423a379faf60463fc6643`.

## TL;DR

Every table currently classified as compatibility or legacy now has one explicit authority mode,
read/write boundary, canonical relationship, target disposition, and cutover gate. The executable
catalog covers all **13 / 13** such tables:

| Current mode | Count | Meaning |
|---|---:|---|
| `shared_scope` | 1 | One stable scope row is shared; no shadow canonical identity exists |
| `compatibility_authority` | 1 | A bounded compatibility service owns fields not yet replaced |
| `scope_partitioned_bridge` | 3 | Legacy and canonical authority are disjoint by field or lineage |
| `projection_sink` | 1 | Legacy-shaped aggregates cannot recreate canonical events |
| `legacy_event_ingress` | 1 | Legacy events import once into the canonical ledger |
| `isolated_legacy_domain` | 6 | No canonical replacement exists, so no false mapping is claimed |

These are logical projection/compatibility-view rules. DOM-016 does **not** create SQLite views,
run a migration, backfill data, change a route, or disable a legacy writer. DOM-017 owns those
physical changes and rollback plans. DOM-019 owns old-versus-canonical read/write telemetry.

## Non-competing-authority rule

One field or lifecycle has one authority at a time. A compatibility command may translate a
legacy request into a canonical command and then refresh a legacy projection, but the two stores
must never resolve differences by last-write-wins. Rollback selects an already-compatible read
path; it never promotes a stale projection back to authority.

The cutover sequence is:

1. classify the current authority by field, lineage, or still-unimplemented domain;
2. validate and append the canonical mutation first where a canonical authority exists;
3. materialize the supported legacy shape from that canonical result;
4. compare reads, writes, mismatches, and failures through DOM-019 telemetry;
5. make the legacy table read-only or retire it only after DOM-017 validation and release gates;
6. retain legacy-only semantics until their owning future domain supplies a real replacement.

## Table contract

The machine-readable source is
`src/agent-os/compatibility-projection-contract.ts`.

| Table | Current mode | Canonical authority or boundary | Target disposition |
|---|---|---|---|
| `boards` | `shared_scope` | one shared project/board identity | `retain_shared_scope` |
| `task_contracts` | `compatibility_authority` | base fields remain in `TaskContractService`; typed additions live in `job_market_*` | `canonical_command_adapter` |
| `agent_usage` | `projection_sink` | normalized usage evidence in `conversation_events` / `os_events` | `read_only_projection` |
| `agents` | `scope_partitioned_bridge` | adopted identity/session in `agent_profiles` / `agent_sessions` | `read_only_projection` |
| `cards` | `scope_partitioned_bridge` | market assignment, execution, and delivery in `job_market_*`, `jobs`, and `delivery_reports` | `canonical_command_adapter` |
| `card_events` | `legacy_event_ingress` | causal event history in `os_events` | `read_only_projection` |
| `messages` | `isolated_legacy_domain` | low-level transport; not Discussion | `retain_distinct_semantics` |
| `message_targets` | `isolated_legacy_domain` | transport recipient snapshot; not subscription or membership | `retain_distinct_semantics` |
| `deliveries` | `isolated_legacy_domain` | message receipt; not work Delivery | `retain_distinct_semantics` |
| `milestones` | `isolated_legacy_domain` | no canonical planning domain yet | `retire_after_replacement` |
| `ideas` | `isolated_legacy_domain` | no canonical roadmap/planning domain yet | `retire_after_replacement` |
| `review_decisions` | `scope_partitioned_bridge` | managed review in `delivery_reports` / `os_events` | `read_only_projection` |
| `token_telemetry` | `isolated_legacy_domain` | injected-context estimate; not provider usage | `retain_distinct_semantics` |

## Critical split boundaries

### Cards and assignment

For canonically bound work, `job_market_assignments` is the exclusive responsibility record.
`cards.owner_agent_id` is a presentation projection that is accepted only when it matches the
frozen assignment/job/session/profile tuple. Mutable ownership or `column_name` cannot create,
replace, or complete a canonical assignment.

Card identity, title, description, ordering, and path hints remain Board compatibility fields
during the migration. DOM-017 must define any physical backfill or command-adapter cutover instead
of silently reinterpreting them.

### Task contracts and Job Market

`TaskContractService` remains the bounded compatibility authority for base contract fields and
stable criterion identities. `job_market_contracts`, `job_market_criteria`, and
`job_market_dependencies` add typed publication/lifecycle fields to the same card identity. They
are not a second contract selected by update time.

### Agent identity

Unadopted `agents` rows remain legacy Board presence/wake records. Once explicitly adopted,
`agent_profiles` and `agent_sessions` own durable identity and provider lifecycle. Compatibility
mirrors cannot rewrite canonical profile/session identity, and ambient legacy presence cannot be
presented as managed execution.

### Events and review

`LegacyEventProjection` imports supported legacy bus events into `os_events`; canonical consumers
never reconstruct causal truth from `card_events`. Managed review uses immutable
`delivery_reports` lineage and `os_events`; `review_decisions` remains limited to legacy work
without that lineage.

### Names that are deliberately not aliases

- `messages` is low-level wake/coordination transport, not Discussion or DiscussionPost.
- `message_targets` is one fan-out snapshot, not a subscription, team, or permission grant.
- `deliveries` is a message receipt, not a verified or accepted work Delivery.
- `token_telemetry` estimates injected context, not provider-native usage or billing.

These stores remain isolated until their owning later phases define a canonical domain and an
explicit migration. DOM-016 does not fabricate one.

## DOM-017 migration handoff

For each table moving to an adapter or read-only projection, DOM-017 must provide:

- an idempotent forward migration and exact prerequisite/schema validation;
- a deterministic backfill with ambiguous rows quarantined rather than guessed;
- canonical-versus-compatibility count, key, scope, lifecycle, and hash queries;
- explicit command ordering and failure atomicity;
- upgrade, restart, and marker-loss replay tests;
- a backup/restore checkpoint and a rollback plan that preserves canonical writes;
- the exact compatibility range and a fail-closed behavior when no safe route exists.

No automatic down migration may delete or rewrite canonical state.

## DOM-019 telemetry handoff

DOM-019 must count privacy-safe reads, writes, adapter translations, projection refreshes,
mismatches, and failures by table/operation/cohort. It must not store message bodies, provider raw
payloads, terminal input, credentials, or arbitrary contract content. A legacy writer can be
disabled only after supported-window usage is zero and mismatch evidence is retained.

## Evidence

- Direct contract: 1 file / 4 tests PASS.
- Contract plus source-controlled inventory/documentation: 5 files / 20 tests PASS.
- Complete one-worker suite: 156 files / 1,236 tests PASS.
- Complete default-parallel suite: 156 files / 1,236 tests PASS.
- Root and web strict TypeScript PASS.
- Root and web production builds PASS.
- Staged changed-diff Gitleaks and `git diff --check` PASS.
- GitNexus staged review: LOW, 2 new files, 0 indexed changed symbols, 0 affected flows.
- The existing `LegacyEventProjection` was separately measured MEDIUM (3 direct dependents, one
  Agent OS plugin flow) and was not edited.

The first complete attempt had 153 passing files / 1,213 passing tests and three import-only suite
failures because the fresh worktree had root dependencies but not `web/node_modules`. After the
locked web dependency tree was installed, both complete modes passed. No source change was needed
for that environment prerequisite.
