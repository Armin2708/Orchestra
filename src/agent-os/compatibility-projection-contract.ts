export const AGENT_OS_LEGACY_COMPATIBILITY_TABLES = Object.freeze([
  'boards',
  'task_contracts',
  'agent_usage',
  'agents',
  'cards',
  'card_events',
  'messages',
  'message_targets',
  'deliveries',
  'milestones',
  'ideas',
  'review_decisions',
  'token_telemetry',
] as const)

export type AgentOsLegacyCompatibilityTable =
  typeof AGENT_OS_LEGACY_COMPATIBILITY_TABLES[number]

export const AGENT_OS_LEGACY_AUTHORITY_MODES = Object.freeze([
  'shared_scope',
  'compatibility_authority',
  'scope_partitioned_bridge',
  'projection_sink',
  'legacy_event_ingress',
  'isolated_legacy_domain',
] as const)

export type AgentOsLegacyAuthorityMode =
  typeof AGENT_OS_LEGACY_AUTHORITY_MODES[number]

export const AGENT_OS_LEGACY_TARGET_DISPOSITIONS = Object.freeze([
  'retain_shared_scope',
  'canonical_command_adapter',
  'read_only_projection',
  'retain_distinct_semantics',
  'retire_after_replacement',
] as const)

export type AgentOsLegacyTargetDisposition =
  typeof AGENT_OS_LEGACY_TARGET_DISPOSITIONS[number]

export interface AgentOsLegacyTableProjection {
  readonly table: AgentOsLegacyCompatibilityTable
  readonly inventory_class: 'compatibility' | 'legacy'
  readonly current_mode: AgentOsLegacyAuthorityMode
  readonly target_disposition: AgentOsLegacyTargetDisposition
  readonly canonical_tables: readonly string[]
  readonly legacy_owned_scope: string
  readonly canonical_owned_scope: string | null
  readonly not_authoritative_for: readonly string[]
  readonly read_boundary: string
  readonly write_boundary: string
  readonly cutover_gate: string
}

export interface AgentOsLegacyProjectionContract {
  readonly schema_version: 1
  readonly backlog_item: 'DOM-016'
  readonly migration_owner: 'DOM-017'
  readonly telemetry_owner: 'DOM-019'
  readonly invariants: readonly string[]
  readonly tables: readonly AgentOsLegacyTableProjection[]
}

const projection = <
  const Entry extends AgentOsLegacyTableProjection,
>(entry: Entry): Readonly<Entry> => Object.freeze({
  ...entry,
  canonical_tables: Object.freeze([...entry.canonical_tables]),
  not_authoritative_for: Object.freeze([...entry.not_authoritative_for]),
}) as Readonly<Entry>

/**
 * Logical authority and cutover contract for every table classified as compatibility or legacy.
 *
 * This catalog deliberately does not create SQLite views or change write behavior. DOM-017 owns
 * physical migrations/backfills, while DOM-019 owns old-versus-canonical usage telemetry.
 */
export const AGENT_OS_LEGACY_PROJECTION_CONTRACT: AgentOsLegacyProjectionContract =
  Object.freeze({
    schema_version: 1,
    backlog_item: 'DOM-016',
    migration_owner: 'DOM-017',
    telemetry_owner: 'DOM-019',
    invariants: Object.freeze([
      'One field or lifecycle has one authority at a time; last-write-wins reconciliation is forbidden.',
      'A compatibility command validates and writes canonical state before refreshing a legacy projection.',
      'Legacy-only domains stay explicitly isolated until their canonical domain and migration exist.',
      'Rollback may select an already-compatible read path but never promotes a stale projection to authority.',
      'Physical cutover requires backfill validation and old-versus-canonical read/write telemetry.',
    ]),
    tables: Object.freeze([
      projection({
        table: 'boards',
        inventory_class: 'compatibility',
        current_mode: 'shared_scope',
        target_disposition: 'retain_shared_scope',
        canonical_tables: [],
        legacy_owned_scope:
          'Project identity, display name, and board scope shared by Board and Agent OS.',
        canonical_owned_scope: null,
        not_authoritative_for: [
          'agent lifecycle',
          'work lifecycle',
          'event ordering',
        ],
        read_boundary:
          'Both products resolve the same board row; no shadow Agent OS board identity is allowed.',
        write_boundary:
          'Board administration may update shared scope, but domain services own their scoped state.',
        cutover_gate:
          'Retain the stable board key while every canonical foreign key validates the same board scope.',
      }),
      projection({
        table: 'task_contracts',
        inventory_class: 'compatibility',
        current_mode: 'compatibility_authority',
        target_disposition: 'canonical_command_adapter',
        canonical_tables: [
          'job_market_contracts',
          'job_market_criteria',
          'job_market_dependencies',
        ],
        legacy_owned_scope:
          'Base WorkContract fields and stable criterion identities accepted by TaskContractService.',
        canonical_owned_scope:
          'Typed market publication, criterion ownership, dependencies, lifecycle, and market version.',
        not_authoritative_for: [
          'job market assignment',
          'job execution',
          'delivery acceptance',
        ],
        read_boundary:
          'Compose base and typed fields by one card identity; never choose a winner by update time.',
        write_boundary:
          'Compatibility writes pass through TaskContractService; typed market writes pass through JobMarketService.',
        cutover_gate:
          'Backfill one canonical WorkContract representation and prove stable IDs, hashes, and launch snapshots match.',
      }),
      projection({
        table: 'agent_usage',
        inventory_class: 'compatibility',
        current_mode: 'projection_sink',
        target_disposition: 'read_only_projection',
        canonical_tables: [
          'conversation_events',
          'os_events',
        ],
        legacy_owned_scope:
          'Provider/day aggregate rows used by existing system and usage summaries.',
        canonical_owned_scope:
          'Ordered normalized provider usage evidence, provider identity, and causal provenance.',
        not_authoritative_for: [
          'provider event identity',
          'billing mode',
          'conversation history',
        ],
        read_boundary:
          'Legacy summaries may read materialized totals but canonical evidence reads never reconstruct events from aggregates.',
        write_boundary:
          'At cutover, canonical usage evidence is appended first and one materializer refreshes this aggregate.',
        cutover_gate:
          'Compare aggregate counts and totals over the supported window before disabling direct aggregate writers.',
      }),
      projection({
        table: 'agents',
        inventory_class: 'legacy',
        current_mode: 'scope_partitioned_bridge',
        target_disposition: 'read_only_projection',
        canonical_tables: [
          'agent_profiles',
          'agent_sessions',
        ],
        legacy_owned_scope:
          'Unadopted Board presence, wake routing, and compatibility process rows.',
        canonical_owned_scope:
          'Durable AgentProfile identity and provider-native AgentSession lifecycle for adopted rows.',
        not_authoritative_for: [
          'managed profile identity',
          'managed session status',
          'job market assignment',
        ],
        read_boundary:
          'Adopted rows resolve through explicit legacy_agent_id/session links; unadopted rows remain visibly ambient.',
        write_boundary:
          'Managed commands mutate profile/session services first; compatibility mirrors cannot rewrite canonical identity.',
        cutover_gate:
          'Every supported presence and wake route resolves adopted rows canonically and restart replay preserves links.',
      }),
      projection({
        table: 'cards',
        inventory_class: 'legacy',
        current_mode: 'scope_partitioned_bridge',
        target_disposition: 'canonical_command_adapter',
        canonical_tables: [
          'job_market_assignments',
          'job_market_contracts',
          'jobs',
          'delivery_reports',
        ],
        legacy_owned_scope:
          'Board work-item identity, title, description, ordering, and path hints during migration.',
        canonical_owned_scope:
          'Published contract lifecycle, exclusive assignment, execution, and verified delivery state.',
        not_authoritative_for: [
          'active assignment',
          'frozen job identity',
          'delivery acceptance',
        ],
        read_boundary:
          'Managed views join canonical lifecycle by card_id; owner_agent_id and column_name are presentation only for canonically bound work.',
        write_boundary:
          'Compatibility card commands translate to canonical commands where a managed lifecycle exists, then refresh presentation fields.',
        cutover_gate:
          'All managed routes stop deriving assignment or completion from mutable card ownership/column fields.',
      }),
      projection({
        table: 'card_events',
        inventory_class: 'legacy',
        current_mode: 'legacy_event_ingress',
        target_disposition: 'read_only_projection',
        canonical_tables: [
          'os_events',
        ],
        legacy_owned_scope:
          'Original Board timeline entries for legacy card commands.',
        canonical_owned_scope:
          'Immutable causal Agent OS event identity, ordering, actor, scope, and provenance.',
        not_authoritative_for: [
          'canonical event identity',
          'causal ordering',
          'managed lifecycle state',
        ],
        read_boundary:
          'Canonical consumers read os_events; legacy timelines may retain or derive a compatibility presentation.',
        write_boundary:
          'LegacyEventProjection imports each legacy bus event once; canonical commands never rebuild truth from card_events.',
        cutover_gate:
          'Replay-safe import and timeline parity pass before legacy event writes become projection-only.',
      }),
      projection({
        table: 'messages',
        inventory_class: 'legacy',
        current_mode: 'isolated_legacy_domain',
        target_disposition: 'retain_distinct_semantics',
        canonical_tables: [],
        legacy_owned_scope:
          'Low-level ask/reply/task/notify/announce/swarm transport and wake payloads.',
        canonical_owned_scope: null,
        not_authoritative_for: [
          'Discussion',
          'DiscussionPost',
          'accepted answer',
        ],
        read_boundary:
          'Message reads remain transport reads and must not be labeled as a durable Discussion timeline.',
        write_boundary:
          'Message writes stay on the transport path until a separate Discussion command adapter exists.',
        cutover_gate:
          'Phase 8 defines whether transport remains distinct or becomes an implementation detail behind Discussions.',
      }),
      projection({
        table: 'message_targets',
        inventory_class: 'legacy',
        current_mode: 'isolated_legacy_domain',
        target_disposition: 'retain_distinct_semantics',
        canonical_tables: [],
        legacy_owned_scope:
          'Recipient snapshot for the low-level message transport.',
        canonical_owned_scope: null,
        not_authoritative_for: [
          'Discussion subscription',
          'team membership',
          'authorization grant',
        ],
        read_boundary:
          'Recipient rows describe one transport fan-out only; they cannot imply durable subscriptions or roles.',
        write_boundary:
          'Only the legacy transport command creates target snapshots.',
        cutover_gate:
          'Phase 8 and Phase 9 introduce explicit subscription and membership records before any reinterpretation.',
      }),
      projection({
        table: 'deliveries',
        inventory_class: 'legacy',
        current_mode: 'isolated_legacy_domain',
        target_disposition: 'retain_distinct_semantics',
        canonical_tables: [],
        legacy_owned_scope:
          'Per-recipient receipt for one low-level message.',
        canonical_owned_scope: null,
        not_authoritative_for: [
          'Delivery',
          'deliverable result',
          'criterion result',
        ],
        read_boundary:
          'A receipt proves transport delivery only and is never joined as accepted work evidence.',
        write_boundary:
          'Only message fan-out records receipts; DeliveryReportService never writes this table.',
        cutover_gate:
          'The transport receipt name remains explicitly disambiguated for the supported compatibility window.',
      }),
      projection({
        table: 'milestones',
        inventory_class: 'legacy',
        current_mode: 'isolated_legacy_domain',
        target_disposition: 'retire_after_replacement',
        canonical_tables: [],
        legacy_owned_scope:
          'Ordered Board planning steps.',
        canonical_owned_scope: null,
        not_authoritative_for: [
          'Team',
          'PlanningSession',
          'job dependency',
        ],
        read_boundary:
          'Milestone reads remain legacy planning reads until a canonical planning domain exists.',
        write_boundary:
          'No canonical planning state is fabricated from milestone mutations.',
        cutover_gate:
          'A later planning migration defines stable identity, backfill, validation, and rollback before retirement.',
      }),
      projection({
        table: 'ideas',
        inventory_class: 'legacy',
        current_mode: 'isolated_legacy_domain',
        target_disposition: 'retire_after_replacement',
        canonical_tables: [],
        legacy_owned_scope:
          'Roadmap idea text and ordering.',
        canonical_owned_scope: null,
        not_authoritative_for: [
          'WorkContract',
          'Discussion',
          'PlanningSession',
        ],
        read_boundary:
          'Roadmap reads remain legacy-only and cannot imply a published contract or accepted plan.',
        write_boundary:
          'Idea mutations do not create canonical work or discussion records.',
        cutover_gate:
          'A future roadmap/planning domain supplies an explicit import and compatibility-read plan.',
      }),
      projection({
        table: 'review_decisions',
        inventory_class: 'legacy',
        current_mode: 'scope_partitioned_bridge',
        target_disposition: 'read_only_projection',
        canonical_tables: [
          'delivery_reports',
          'os_events',
        ],
        legacy_owned_scope:
          'Board approve/send-back decisions for work without a canonical DeliveryReport lineage.',
        canonical_owned_scope:
          'Managed delivery revision, verification, acceptance/rejection, actor, and evidence history.',
        not_authoritative_for: [
          'managed delivery status',
          'verification result',
          'accepted evidence',
        ],
        read_boundary:
          'Managed jobs read DeliveryReport lineage; legacy cards read review_decisions without merging histories by time.',
        write_boundary:
          'Managed review commands use DeliveryReportService; legacy review writes stay limited to unbound work.',
        cutover_gate:
          'Every supported review route resolves one lineage and compatibility projections preserve actor and decision history.',
      }),
      projection({
        table: 'token_telemetry',
        inventory_class: 'legacy',
        current_mode: 'isolated_legacy_domain',
        target_disposition: 'retain_distinct_semantics',
        canonical_tables: [],
        legacy_owned_scope:
          'Estimated injected-context characters/tokens grouped by hook event and day.',
        canonical_owned_scope: null,
        not_authoritative_for: [
          'provider usage',
          'provider billing',
          'accepted-delivery outcome',
        ],
        read_boundary:
          'Injected-context estimates remain labeled separately from provider-native usage and outcome analytics.',
        write_boundary:
          'Hook accounting may update this estimate only; it cannot synthesize provider usage evidence.',
        cutover_gate:
          'Phase 12 either retains the distinct estimate or migrates it with explicit units and comparison telemetry.',
      }),
    ]),
  })
