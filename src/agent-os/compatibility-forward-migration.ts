import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  AGENT_OS_LEGACY_PROJECTION_CONTRACT,
  type AgentOsLegacyCompatibilityTable,
} from './compatibility-projection-contract.js'
import { stableJson } from './agent-home-support.js'
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from './errors.js'
import { JobMarketService } from './job-market.js'

export const AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID =
  '022-legacy-projection-forward-plan'

export const AGENT_OS_COMPATIBILITY_FORWARD_PLAN_VERSION = 1

export type CompatibilityForwardAction =
  | 'retain_shared_scope'
  | 'backfill_canonical_adapter'
  | 'retain_projection_baseline'
  | 'validate_scope_partition'
  | 'import_legacy_events'
  | 'retain_distinct_semantics'
  | 'defer_until_replacement'

export type CompatibilityForwardState =
  | 'implemented'
  | 'no_data_move'
  | 'deferred'

export interface CompatibilityRollbackPlan {
  readonly checkpoint: string
  readonly actions: readonly string[]
  readonly verification: readonly string[]
  readonly data_policy: string
}

export interface CompatibilityForwardPlanEntry {
  readonly source_table: AgentOsLegacyCompatibilityTable
  readonly action: CompatibilityForwardAction
  readonly state: CompatibilityForwardState
  readonly prerequisites: readonly string[]
  readonly backfill: string
  readonly ambiguous_rows: string
  readonly validation_categories: readonly CompatibilityValidationCategory[]
  readonly command_order: string
  readonly compatibility_range: string
  readonly fail_closed: string
  readonly rollback: CompatibilityRollbackPlan
}

export type CompatibilityValidationCategory =
  | 'count'
  | 'key'
  | 'scope'
  | 'lifecycle'
  | 'hash'

export interface CompatibilityValidationQuery {
  readonly id: string
  readonly category: Exclude<CompatibilityValidationCategory, 'hash'>
  readonly sql: string
}

export interface CompatibilityValidationResult {
  readonly id: string
  readonly category: CompatibilityValidationCategory
  readonly issue_count: number
  readonly result_hash: string
}

interface StoredLink {
  source_table: AgentOsLegacyCompatibilityTable
  source_key: string
  source_hash: string
  target_table: string
  target_key: string
  target_hash: string
  disposition: string
}

interface QuarantineInput {
  sourceTable: AgentOsLegacyCompatibilityTable
  sourceKey: string
  sourceHash: string
  reasonCode: string
  safeDetail: string
}

class AmbiguousCompatibilityRowError extends Error {}

const rollback = Object.freeze({
  checkpoint:
    'Stop writers and create a verified SQLite backup plus exact application commit before applying migration 022.',
  actions: Object.freeze([
    'Disable the phase-1 canonical cutover control and retain the additive schema.',
    'Route only rows without a verified canonical link through the existing compatibility path.',
    'Keep canonical writes, imported events, links, quarantine evidence, and migration markers intact.',
  ]),
  verification: Object.freeze([
    'Run all five migration validation categories and PRAGMA foreign_key_check.',
    'Restart the prior compatible application commit against a copy of the migrated database.',
    'Restore the verified backup only as an explicit offline recovery operation.',
  ]),
  data_policy:
    'No automatic down migration may delete, rewrite, or promote a stale projection over canonical state.',
} satisfies CompatibilityRollbackPlan)

function planEntry(
  entry: Omit<CompatibilityForwardPlanEntry, 'rollback'>,
): CompatibilityForwardPlanEntry {
  return Object.freeze({
    ...entry,
    prerequisites: Object.freeze([...entry.prerequisites]),
    validation_categories: Object.freeze([...entry.validation_categories]),
    rollback,
  })
}

export const AGENT_OS_COMPATIBILITY_FORWARD_PLAN = Object.freeze({
  schema_version: 1 as const,
  backlog_item: 'DOM-017' as const,
  migration_id: AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
  prior_schema: '021-command-idempotency-coverage' as const,
  entries: Object.freeze([
    planEntry({
      source_table: 'boards',
      action: 'retain_shared_scope',
      state: 'no_data_move',
      prerequisites: ['boards.id'],
      backfill:
        'Record the existing board key as the shared canonical scope; no shadow board row is created.',
      ambiguous_rows:
        'A missing or invalid board key aborts the migration because every other scope depends on it.',
      validation_categories: ['count', 'key', 'scope', 'hash'],
      command_order:
        'Board administration writes the shared row before any scoped Agent OS command.',
      compatibility_range:
        'The same board key is readable by the pre-022 compatibility application and the 022 schema.',
      fail_closed:
        'A row without one stable board key cannot enter a canonical scope.',
    }),
    planEntry({
      source_table: 'task_contracts',
      action: 'backfill_canonical_adapter',
      state: 'implemented',
      prerequisites: [
        'task_contracts.card_id',
        'job_market_contracts.card_id',
        'job_market_criteria.criterion_id',
        'job_market_dependencies.dependency_card_id',
      ],
      backfill:
        'Run the existing TaskContract and JobMarket normalization path inside one row savepoint, then link the normalized contract, criterion, and dependency snapshot.',
      ambiguous_rows:
        'Malformed JSON, cross-board dependencies, duplicate identities, or conflicting typed rows are quarantined without a guessed canonical write.',
      validation_categories: ['count', 'key', 'scope', 'lifecycle', 'hash'],
      command_order:
        'Validate and write the TaskContract compatibility authority, then refresh typed Job Market extensions in the same transaction.',
      compatibility_range:
        'Legacy TaskContract reads remain supported through schema 022 while typed Job Market reads use the linked card identity.',
      fail_closed:
        'A quarantined contract remains on the compatibility path and cannot be selected as a validated canonical launch contract.',
    }),
    planEntry({
      source_table: 'agent_usage',
      action: 'retain_projection_baseline',
      state: 'implemented',
      prerequisites: ['agent_usage.board_id', 'agent_usage.agent_id', 'agents.id'],
      backfill:
        'Retain each scoped aggregate as a migration baseline; never fabricate canonical provider events from daily totals.',
      ambiguous_rows:
        'Orphan or cross-board aggregate keys are quarantined as hashes only.',
      validation_categories: ['count', 'key', 'scope', 'hash'],
      command_order:
        'Append canonical usage evidence before a materializer refreshes this aggregate.',
      compatibility_range:
        'Direct aggregate readers remain supported through the DOM-019 observation window.',
      fail_closed:
        'An aggregate without canonical evidence is labeled compatibility-only and cannot answer event-level or billing questions.',
    }),
    planEntry({
      source_table: 'agents',
      action: 'backfill_canonical_adapter',
      state: 'implemented',
      prerequisites: [
        'agents.id',
        'agent_profiles.legacy_agent_id',
        'agent_conversations.profile_id',
        'agent_sessions.agent_id',
      ],
      backfill:
        'Create deterministic profile and default-conversation identities only when name, board, and legacy identity are collision-free; attach same-board sessions.',
      ambiguous_rows:
        'Name, identity, conversation, or workspace-scope collisions stay unadopted and are quarantined.',
      validation_categories: ['count', 'key', 'scope', 'lifecycle', 'hash'],
      command_order:
        'Create or resolve AgentProfile and conversation identity before binding a managed session.',
      compatibility_range:
        'Unadopted rows remain ambient compatibility presence; adopted rows resolve through explicit links.',
      fail_closed:
        'No collision is resolved by update time, display name, or provider guess.',
    }),
    planEntry({
      source_table: 'cards',
      action: 'validate_scope_partition',
      state: 'implemented',
      prerequisites: [
        'cards.id',
        'job_market_assignments.card_id',
        'jobs.job_assignment_id',
        'agent_sessions.job_assignment_id',
      ],
      backfill:
        'Record legacy-only cards against their retained Board scope and canonical assignments against exact frozen assignment/runtime identity; do not synthesize assignments.',
      ambiguous_rows:
        'A non-null legacy owner that cannot be proven against one active canonical runtime is quarantined.',
      validation_categories: ['count', 'key', 'scope', 'lifecycle', 'hash'],
      command_order:
        'Canonical assignment and runtime commands commit before any optional legacy presentation refresh.',
      compatibility_range:
        'Card title, description, order, and path hints remain compatible while managed lifecycle reads use canonical joins.',
      fail_closed:
        'Mutable owner or column fields cannot create, replace, or complete a canonical assignment.',
    }),
    planEntry({
      source_table: 'card_events',
      action: 'import_legacy_events',
      state: 'implemented',
      prerequisites: ['card_events.id', 'cards.board_id', 'os_events.id'],
      backfill:
        'Import each structurally valid historical event once with deterministic event and idempotency identities while preserving the original JSON as nested legacy payload.',
      ambiguous_rows:
        'Invalid JSON, missing card scope, cross-board actor scope, or an unsafe event kind is quarantined.',
      validation_categories: ['count', 'key', 'scope', 'lifecycle', 'hash'],
      command_order:
        'New canonical commands append os_events first; this migration only imports historical legacy rows.',
      compatibility_range:
        'Legacy timelines remain readable while canonical consumers use the deterministic imported event identity.',
      fail_closed:
        'An invalid historical row is never rewritten into a plausible canonical event.',
    }),
    planEntry({
      source_table: 'review_decisions',
      action: 'validate_scope_partition',
      state: 'implemented',
      prerequisites: ['review_decisions.id', 'delivery_reports.id', 'os_events.id'],
      backfill:
        'Link a decision only when one delivery report on the same card has the matching terminal state; otherwise retain legacy-only lineage.',
      ambiguous_rows:
        'Multiple revisions, mismatched terminal state, or cross-board scope are quarantined rather than attached to a delivery.',
      validation_categories: ['count', 'key', 'scope', 'lifecycle', 'hash'],
      command_order:
        'Managed review writes DeliveryReportService first and appends the compatibility decision only after canonical success.',
      compatibility_range:
        'Unbound legacy reviews remain readable; managed delivery history resolves only through an exact link.',
      fail_closed:
        'A review row cannot accept or reject a canonical delivery without one exact lineage.',
    }),
    planEntry({
      source_table: 'messages',
      action: 'retain_distinct_semantics',
      state: 'no_data_move',
      prerequisites: ['messages.id'],
      backfill:
        'No Discussion record is fabricated from transport messages.',
      ambiguous_rows:
        'Not applicable until the Discussion domain defines stable import identity.',
      validation_categories: ['key', 'scope'],
      command_order:
        'Transport remains independent of future Discussion commands.',
      compatibility_range:
        'Supported as low-level transport for the current compatibility window.',
      fail_closed:
        'Messages cannot imply Discussion membership, subscription, or accepted answers.',
    }),
    planEntry({
      source_table: 'message_targets',
      action: 'retain_distinct_semantics',
      state: 'no_data_move',
      prerequisites: ['message_targets.message_id', 'message_targets.agent_id'],
      backfill:
        'No subscription, membership, or authorization row is fabricated from one fan-out snapshot.',
      ambiguous_rows:
        'Not applicable until the Discussion and Team domains exist.',
      validation_categories: ['key', 'scope'],
      command_order:
        'Legacy transport snapshots remain transport-only.',
      compatibility_range:
        'Supported with messages for the current compatibility window.',
      fail_closed:
        'A recipient snapshot grants no durable role or permission.',
    }),
    planEntry({
      source_table: 'deliveries',
      action: 'retain_distinct_semantics',
      state: 'no_data_move',
      prerequisites: ['deliveries.message_id', 'deliveries.agent_id'],
      backfill:
        'No work Delivery is fabricated from a transport receipt.',
      ambiguous_rows:
        'Not applicable because the two delivery concepts intentionally remain distinct.',
      validation_categories: ['key', 'scope'],
      command_order:
        'Message receipt writes never precede or replace DeliveryReportService state.',
      compatibility_range:
        'Transport receipts remain supported and explicitly named for the compatibility window.',
      fail_closed:
        'A receipt cannot satisfy contract criteria or accepted evidence.',
    }),
    planEntry({
      source_table: 'milestones',
      action: 'defer_until_replacement',
      state: 'deferred',
      prerequisites: ['milestones.id'],
      backfill:
        'Deferred until a canonical planning domain defines stable identity.',
      ambiguous_rows:
        'All rows remain legacy planning data; none are guessed into jobs or teams.',
      validation_categories: ['key', 'scope'],
      command_order:
        'A future planning command must exist before any import.',
      compatibility_range:
        'Legacy-only until the owning phase ships.',
      fail_closed:
        'Milestones cannot imply Team, PlanningSession, or dependency authority.',
    }),
    planEntry({
      source_table: 'ideas',
      action: 'defer_until_replacement',
      state: 'deferred',
      prerequisites: ['ideas.id'],
      backfill:
        'Deferred until a canonical roadmap or planning domain exists.',
      ambiguous_rows:
        'All rows remain legacy roadmap data.',
      validation_categories: ['key', 'scope'],
      command_order:
        'A future roadmap command must exist before any import.',
      compatibility_range:
        'Legacy-only until the owning phase ships.',
      fail_closed:
        'Idea text cannot become a WorkContract, Discussion, or accepted plan by inference.',
    }),
    planEntry({
      source_table: 'token_telemetry',
      action: 'retain_distinct_semantics',
      state: 'no_data_move',
      prerequisites: ['token_telemetry.board_id', 'token_telemetry.agent_id'],
      backfill:
        'Retain injected-context estimates in their original units.',
      ambiguous_rows:
        'Rows are not converted into provider usage or billing evidence.',
      validation_categories: ['key', 'scope'],
      command_order:
        'Provider-native usage remains an independent canonical evidence stream.',
      compatibility_range:
        'Retained as a separately labeled estimate through Phase 12.',
      fail_closed:
        'Estimated hook tokens cannot answer provider billing or accepted-outcome questions.',
    }),
    planEntry({
      source_table: 'agent_transcripts',
      action: 'retain_distinct_semantics',
      state: 'no_data_move',
      prerequisites: ['agent_transcripts.agent_id'],
      backfill:
        'Retain stored chat lines as UI continuity state for their agent.',
      ambiguous_rows:
        'Rows are not converted into canonical conversation history.',
      validation_categories: ['key', 'scope'],
      command_order:
        'Canonical conversation events remain the independent record of what was said.',
      compatibility_range:
        'Legacy-only for as long as the hired-agent drawer restores its own transcript.',
      fail_closed:
        'A restored transcript line cannot stand in for a conversation event or a delivery.',
    }),
    planEntry({
      source_table: 'teams',
      action: 'retain_distinct_semantics',
      state: 'no_data_move',
      prerequisites: ['teams.board_id'],
      backfill:
        'Deferred until a canonical organization or staffing domain exists.',
      ambiguous_rows:
        'All rows remain operator-approved team designs scoped to their board.',
      validation_categories: ['key', 'scope'],
      command_order:
        'A future organization command must exist before any import.',
      compatibility_range:
        'Legacy-only until the owning phase ships.',
      fail_closed:
        'An approved team spec cannot create assignments, profiles, or accepted work by inference.',
    }),
  ]),
})

const COVERED_SOURCE_KEYS_SQL = `
  SELECT 'boards' AS source_table, CAST(id AS TEXT) AS source_key FROM boards
  UNION ALL
  SELECT 'task_contracts', CAST(card_id AS TEXT) FROM task_contracts
  UNION ALL
  SELECT 'agent_usage',
    printf('%d:%d:%s', board_id, agent_id, day) FROM agent_usage
  UNION ALL
  SELECT 'agents', CAST(id AS TEXT) FROM agents
  UNION ALL
  SELECT 'cards', CAST(id AS TEXT) FROM cards
  UNION ALL
  SELECT 'card_events', CAST(id AS TEXT) FROM card_events
  UNION ALL
  SELECT 'review_decisions', CAST(id AS TEXT) FROM review_decisions
  UNION ALL
  SELECT 'agent_transcripts', CAST(agent_id AS TEXT) FROM agent_transcripts
  UNION ALL
  SELECT 'teams', CAST(id AS TEXT) FROM teams
`

export const AGENT_OS_COMPATIBILITY_VALIDATION_QUERIES =
  Object.freeze([
    Object.freeze({
      id: 'count.coverage',
      category: 'count',
      sql: `
        WITH source_keys AS (${COVERED_SOURCE_KEYS_SQL})
        SELECT source.source_table, source.source_key
        FROM source_keys source
        WHERE NOT EXISTS (
          SELECT 1 FROM os_compatibility_projection_links link
          WHERE link.migration_id='${AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID}'
            AND link.source_table=source.source_table
            AND link.source_key=source.source_key
        )
          AND NOT EXISTS (
            SELECT 1 FROM os_compatibility_projection_quarantine quarantine
            WHERE quarantine.migration_id='${AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID}'
              AND quarantine.source_table=source.source_table
              AND quarantine.source_key=source.source_key
          )
        ORDER BY source.source_table, source.source_key
      `,
    }),
    Object.freeze({
      id: 'key.exclusive_disposition',
      category: 'key',
      sql: `
        SELECT link.source_table, link.source_key
        FROM os_compatibility_projection_links link
        JOIN os_compatibility_projection_quarantine quarantine
          ON quarantine.migration_id=link.migration_id
          AND quarantine.source_table=link.source_table
          AND quarantine.source_key=link.source_key
        WHERE link.migration_id='${AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID}'
        ORDER BY link.source_table, link.source_key
      `,
    }),
    Object.freeze({
      id: 'scope.unquarantined_rows',
      category: 'scope',
      sql: `
        SELECT 'agent_usage' AS source_table,
          printf('%d:%d:%s', usage.board_id, usage.agent_id, usage.day) AS source_key
        FROM agent_usage usage
        LEFT JOIN agents agent ON agent.id=usage.agent_id
        WHERE (agent.id IS NULL OR agent.board_id!=usage.board_id)
          AND NOT EXISTS (
            SELECT 1 FROM os_compatibility_projection_quarantine quarantine
            WHERE quarantine.migration_id='${AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID}'
              AND quarantine.source_table='agent_usage'
              AND quarantine.source_key=printf(
                '%d:%d:%s', usage.board_id, usage.agent_id, usage.day
              )
          )
        UNION ALL
        SELECT 'review_decisions', CAST(review.id AS TEXT)
        FROM review_decisions review
        LEFT JOIN cards card ON card.id=review.card_id
        WHERE (card.id IS NULL OR card.board_id!=review.board_id)
          AND NOT EXISTS (
            SELECT 1 FROM os_compatibility_projection_quarantine quarantine
            WHERE quarantine.migration_id='${AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID}'
              AND quarantine.source_table='review_decisions'
              AND quarantine.source_key=CAST(review.id AS TEXT)
          )
        ORDER BY source_table, source_key
      `,
    }),
    Object.freeze({
      id: 'lifecycle.canonical_owner',
      category: 'lifecycle',
      sql: `
        SELECT 'cards' AS source_table, CAST(card.id AS TEXT) AS source_key
        FROM cards card
        WHERE card.owner_agent_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM job_market_assignments assignment
            WHERE assignment.card_id=card.id AND assignment.status='active'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jobs job
            JOIN agent_sessions session
              ON session.job_id=job.id
              AND session.job_assignment_id=job.job_assignment_id
              AND session.assigned_profile_id=job.assigned_profile_id
              AND session.assignment_market_version=job.assignment_market_version
            JOIN job_market_assignments assignment
              ON assignment.id=job.job_assignment_id
              AND assignment.card_id=card.id
              AND assignment.status='active'
            JOIN agents owner
              ON owner.id=card.owner_agent_id
              AND owner.id=session.agent_id
              AND owner.board_id=card.board_id
            WHERE job.status IN ('queued','running','cancelling')
              AND session.status IN ('reserved','starting','running','idle','stopping')
          )
          AND NOT EXISTS (
            SELECT 1 FROM os_compatibility_projection_quarantine quarantine
            WHERE quarantine.migration_id='${AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID}'
              AND quarantine.source_table='cards'
              AND quarantine.source_key=CAST(card.id AS TEXT)
          )
        ORDER BY card.id
      `,
    }),
  ] satisfies readonly CompatibilityValidationQuery[])

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    boards: ['id'],
    task_contracts: [
      'card_id',
      'objective',
      'deliverables',
      'acceptance_criteria',
      'dependencies',
      'base_ref',
      'verify_commands',
      'non_goals',
      'risks',
      'budget_tokens',
      'budget_cents',
      'priority',
      'policy_id',
      'workspace_id',
      'version',
      'updated_at',
    ],
    job_market_contracts: [
      'card_id',
      'status',
      'required_capabilities_json',
      'provider_constraints_json',
      'model_constraints_json',
      'access_needs_json',
      'budget_time_seconds',
      'budget_retries',
      'budget_coordination_tokens',
      'budget_coordination_messages',
      'version',
      'published_at',
      'archived_at',
      'created_at',
      'updated_at',
    ],
    job_market_criteria: [
      'card_id',
      'criterion_id',
      'description',
      'verifier_json',
      'required_artifacts_json',
      'priority',
      'owner',
      'updated_at',
    ],
    job_market_dependencies: [
      'card_id',
      'dependency_card_id',
      'blocking_reason',
      'completion_condition',
      'updated_at',
    ],
    agent_usage: ['board_id', 'agent_id', 'day'],
    agents: [
      'id',
      'board_id',
      'name',
      'role',
      'provider',
      'model',
      'effort',
      'access_profile',
      'kind',
      'status',
      'created_at',
      'last_seen',
    ],
    agent_profiles: [
      'id',
      'board_id',
      'legacy_agent_id',
      'name',
      'role',
      'default_provider',
      'default_model',
      'default_effort',
      'default_access_profile',
      'capabilities_json',
      'owner_actor_type',
      'owner_actor_id',
      'status',
      'provenance_json',
      'created_at',
      'updated_at',
      'archived_at',
    ],
    agent_conversations: [
      'id',
      'board_id',
      'profile_id',
      'title',
      'is_default',
      'status',
      'next_sequence',
      'created_by_actor_type',
      'created_by_actor_id',
      'created_at',
      'updated_at',
      'archived_at',
    ],
    agent_sessions: [
      'id',
      'agent_id',
      'workspace_id',
      'profile_id',
      'conversation_id',
      'job_id',
      'job_assignment_id',
      'assigned_profile_id',
      'assignment_market_version',
      'status',
    ],
    workspaces: ['id', 'board_id'],
    cards: ['id', 'board_id', 'owner_agent_id'],
    jobs: [
      'id',
      'board_id',
      'card_id',
      'workspace_id',
      'job_assignment_id',
      'assigned_profile_id',
      'assignment_market_version',
      'status',
    ],
    job_market_assignments: [
      'id',
      'board_id',
      'card_id',
      'profile_id',
      'workspace_id',
      'status',
      'assigned_market_version',
      'created_at',
    ],
    card_events: ['id', 'card_id', 'agent_id', 'type', 'payload', 'created_at'],
    os_events: [
      'id',
      'board_id',
      'actor_type',
      'actor_id',
      'workspace_id',
      'card_id',
      'session_id',
      'process_id',
      'job_id',
      'contract_id',
      'correlation_id',
      'causation_id',
      'idempotency_key',
      'event_version',
      'kind',
      'source',
      'payload',
      'created_at',
    ],
    review_decisions: ['id', 'board_id', 'card_id', 'decision', 'decided_at'],
    delivery_reports: [
      'id',
      'sequence',
      'board_id',
      'card_id',
      'status',
      'created_at',
    ],
  })

const COMPATIBILITY_EVIDENCE_SCHEMA = Object.freeze([
  Object.freeze({
    type: 'table',
    name: 'os_compatibility_projection_links',
    sql: `CREATE TABLE os_compatibility_projection_links (
      migration_id TEXT NOT NULL,
      source_table TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
      target_table TEXT NOT NULL,
      target_key TEXT NOT NULL,
      target_hash TEXT NOT NULL CHECK(length(target_hash)=64),
      disposition TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(migration_id, source_table, source_key)
    )`,
  }),
  Object.freeze({
    type: 'table',
    name: 'os_compatibility_projection_quarantine',
    sql: `CREATE TABLE os_compatibility_projection_quarantine (
      migration_id TEXT NOT NULL,
      source_table TEXT NOT NULL,
      source_key TEXT NOT NULL,
      source_hash TEXT NOT NULL CHECK(length(source_hash)=64),
      reason_code TEXT NOT NULL,
      safe_detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(migration_id, source_table, source_key)
    )`,
  }),
  Object.freeze({
    type: 'table',
    name: 'os_compatibility_migration_checks',
    sql: `CREATE TABLE os_compatibility_migration_checks (
      migration_id TEXT NOT NULL,
      validation_id TEXT NOT NULL,
      category TEXT NOT NULL
        CHECK(category IN ('count','key','scope','lifecycle','hash')),
      issue_count INTEGER NOT NULL CHECK(issue_count>=0),
      result_hash TEXT NOT NULL CHECK(length(result_hash)=64),
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(migration_id, validation_id)
    )`,
  }),
  Object.freeze({
    type: 'index',
    name: 'idx_os_compatibility_links_target',
    sql: `CREATE INDEX idx_os_compatibility_links_target
      ON os_compatibility_projection_links(target_table, target_key)`,
  }),
  Object.freeze({
    type: 'index',
    name: 'idx_os_compatibility_quarantine_reason',
    sql: `CREATE INDEX idx_os_compatibility_quarantine_reason
      ON os_compatibility_projection_quarantine(source_table, reason_code)`,
  }),
] as const)

const OPTIONAL_HISTORICAL_SOURCE_TABLES = new Set([
  'agent_usage',
  'agents',
  'card_events',
  'review_decisions',
])

const HISTORICAL_SOURCE_TABLES = new Set([
  'boards',
  'task_contracts',
  'agent_usage',
  'agents',
  'cards',
  'card_events',
  'review_decisions',
])

const VALIDATION_REQUIRED_TABLES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    'count.coverage': [
      'boards',
      'task_contracts',
      'agent_usage',
      'agents',
      'cards',
      'card_events',
      'review_decisions',
      'agent_transcripts',
      'teams',
    ],
    'key.exclusive_disposition': [
      'os_compatibility_projection_links',
      'os_compatibility_projection_quarantine',
    ],
    'scope.unquarantined_rows': [
      'agent_usage',
      'agents',
      'review_decisions',
      'cards',
      'os_compatibility_projection_quarantine',
    ],
    'lifecycle.canonical_owner': [
      'cards',
      'agents',
      'jobs',
      'agent_sessions',
      'job_market_assignments',
      'os_compatibility_projection_quarantine',
    ],
  })

export function applyCompatibilityForwardMigration(
  db: Database.Database,
): void {
  assertCompatibilityPrerequisites(db)
  ensureCompatibilityEvidenceSchema(db)

  linkBoards(db)
  backfillTaskContracts(db)
  backfillLegacyAgents(db)
  validateCardAuthority(db)
  importCardEvents(db)
  baselineAgentUsage(db)
  linkReviewDecisions(db)

  const results = validateCompatibilityForwardMigration(db)
  recordValidationResults(db, results)
  const failed = results.filter((result) => result.issue_count > 0)
  if (failed.length) {
    throw new Error(
      `migration 022 legacy projection validation failed: ${
        failed.map((result) => `${result.id}=${result.issue_count}`).join(', ')
      }`,
    )
  }
  assertCompatibilityEvidenceSchemaCompatible(db)
}

export function validateCompatibilityForwardMigration(
  db: Database.Database,
): CompatibilityValidationResult[] {
  const results: CompatibilityValidationResult[] =
    AGENT_OS_COMPATIBILITY_VALIDATION_QUERIES.map((query) => {
      const rows = hasTables(
        db,
        VALIDATION_REQUIRED_TABLES[query.id] ?? [],
      )
        ? db.prepare(query.sql).all() as Record<string, unknown>[]
        : []
      return {
        id: query.id,
        category: query.category,
        issue_count: rows.length,
        result_hash: hash(rows),
      }
    })

  const mismatches: Array<Record<string, unknown>> = []
  const links = db.prepare(`
    SELECT source_table, source_key, source_hash, target_table, target_key,
      target_hash, disposition
    FROM os_compatibility_projection_links
    WHERE migration_id=?
    ORDER BY source_table, source_key
  `).all(AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID) as StoredLink[]
  for (const link of links) {
    const source = sourceSnapshot(db, link.source_table, link.source_key)
    const target = targetSnapshot(db, link.target_table, link.target_key)
    if (
      source === null
      || target === null
      || hash(source) !== link.source_hash
      || hash(target) !== link.target_hash
    ) {
      mismatches.push({
        source_table: link.source_table,
        source_key: link.source_key,
        target_table: link.target_table,
        target_key: link.target_key,
      })
    }
  }
  results.push({
    id: 'hash.linked_snapshots',
    category: 'hash',
    issue_count: mismatches.length,
    result_hash: hash(mismatches),
  })
  return results
}

/**
 * Compare retained migration links for one compatibility table without returning
 * source keys, target keys, payloads, or row content to the telemetry caller.
 */
export function compatibilityProjectionMismatchDiagnostic(
  db: Database.Database,
  table: AgentOsLegacyCompatibilityTable,
  sourceKey: string,
): 'missing_legacy_row' | 'missing_canonical_row' | 'projection_stale' | null {
  const link = db.prepare(`
    SELECT source_table, source_key, source_hash, target_table, target_key,
      target_hash, disposition
    FROM os_compatibility_projection_links
    WHERE migration_id=? AND source_table=? AND source_key=?
  `).get(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    table,
    sourceKey,
  ) as StoredLink | undefined
  if (!link) return null
  const source = sourceSnapshot(db, link.source_table, link.source_key)
  if (source === null) return 'missing_legacy_row'
  const target = targetSnapshot(db, link.target_table, link.target_key)
  if (target === null) return 'missing_canonical_row'
  if (link.source_table === link.target_table && link.source_key === link.target_key) {
    return hash(source) === hash(target) ? null : 'projection_stale'
  }
  return hash(source) === link.source_hash && hash(target) === link.target_hash
    ? null
    : 'projection_stale'
}

function assertCompatibilityPrerequisites(db: Database.Database): void {
  const prior = db.prepare(
    'SELECT 1 FROM os_schema_migrations WHERE id=?',
  ).get('021-command-idempotency-coverage')
  if (!prior) {
    throw new Error(
      'migration 022-legacy-projection-forward-plan requires 021-command-idempotency-coverage',
    )
  }
  const hasLegacyAgents = tableExists(db, 'agents')
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (table === 'agent_sessions' && !hasLegacyAgents) continue
    const tableInfo = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
        name: string
      }>
    if (!tableInfo.length && OPTIONAL_HISTORICAL_SOURCE_TABLES.has(table)) {
      continue
    }
    const columns = new Set(tableInfo.map((column) => column.name))
    if (required.some((column) => !columns.has(column))) {
      if (
        HISTORICAL_SOURCE_TABLES.has(table)
        && tableRowCount(db, table) === 0
      ) {
        continue
      }
      throw new Error(
        `migration 022-legacy-projection-forward-plan requires compatible ${table} columns`,
      )
    }
  }
}

function ensureCompatibilityEvidenceSchema(db: Database.Database): void {
  const hasAnyObject = COMPATIBILITY_EVIDENCE_SCHEMA.some(({ name }) => (
    !!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name)
  ))
  if (hasAnyObject) {
    assertCompatibilityEvidenceSchemaCompatible(db)
    return
  }
  db.exec(COMPATIBILITY_EVIDENCE_SCHEMA
    .map(({ sql }) => `${sql};`)
    .join('\n'))
  assertCompatibilityEvidenceSchemaCompatible(db)
}

function assertCompatibilityEvidenceSchemaCompatible(
  db: Database.Database,
): void {
  for (const expected of COMPATIBILITY_EVIDENCE_SCHEMA) {
    const actual = db.prepare(`
      SELECT type, sql FROM sqlite_master WHERE name=?
    `).get(expected.name) as { type: string; sql: string | null } | undefined
    if (
      !actual
      || actual.type !== expected.type
      || normalizeSchemaSql(actual.sql ?? '') !== normalizeSchemaSql(expected.sql)
    ) {
      throw new Error(
        `migration 022-legacy-projection-forward-plan found incompatible ${expected.name} schema`,
      )
    }
  }
}

function linkBoards(db: Database.Database): void {
  const rows = db.prepare('SELECT * FROM boards ORDER BY id')
    .all() as Array<Record<string, unknown>>
  for (const row of rows) {
    const boardId = Number(row.id)
    if (!Number.isSafeInteger(boardId) || boardId <= 0) {
      throw new Error(
        'migration 022-legacy-projection-forward-plan found an invalid board key',
      )
    }
    const key = String(boardId)
    recordLink(db, {
      source_table: 'boards',
      source_key: key,
      source_hash: hash(row),
      target_table: 'boards',
      target_key: key,
      target_hash: hash(row),
      disposition: 'retained_shared_scope',
    })
  }
}

function backfillTaskContracts(db: Database.Database): void {
  const rows = db.prepare('SELECT * FROM task_contracts ORDER BY card_id')
    .all() as Array<Record<string, unknown>>
  const service = new JobMarketService(db)
  for (const original of rows) {
    const cardId = Number(original.card_id)
    const key = String(cardId)
    if (hasDisposition(db, 'task_contracts', key, hash(original))) continue
    try {
      assertContractInputSafe(db, original)
      const market = db.transaction(() => {
        const result = service.get(cardId)
        assertMarketExtensionSets(db, result.card_id, {
          criteria: result.contract.acceptance_criteria.map((item) => item.id),
          dependencies: result.contract.dependencies,
        })
        return result
      })()
      const normalized = db.prepare(
        'SELECT * FROM task_contracts WHERE card_id=?',
      ).get(cardId) as Record<string, unknown>
      recordLink(db, {
        source_table: 'task_contracts',
        source_key: key,
        source_hash: hash(normalized),
        target_table: 'job_market_contracts',
        target_key: key,
        target_hash: hash(jobMarketSnapshot(db, cardId)),
        disposition: `normalized_${market.status}`,
      })
    } catch (error) {
      if (!isAmbiguousDataError(error)) throw error
      recordQuarantine(db, {
        sourceTable: 'task_contracts',
        sourceKey: key,
        sourceHash: hash(original),
        reasonCode: 'ambiguous_contract_backfill',
        safeDetail:
          'Contract JSON, stable identities, dependency scope, or typed extensions require operator review.',
      })
    }
  }
}

function assertContractInputSafe(
  db: Database.Database,
  row: Record<string, unknown>,
): void {
  for (const column of [
    'deliverables',
    'acceptance_criteria',
    'dependencies',
    'verify_commands',
  ]) {
    const value = String(row[column] ?? '[]')
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new AmbiguousCompatibilityRowError(`${column} is not JSON`)
    }
    if (!Array.isArray(parsed)) {
      throw new AmbiguousCompatibilityRowError(`${column} is not an array`)
    }
  }
  const dependencies = JSON.parse(String(row.dependencies)) as unknown[]
  const cardId = Number(row.card_id)
  const board = db.prepare('SELECT board_id FROM cards WHERE id=?').get(cardId) as
    { board_id: number } | undefined
  if (!board) throw new AmbiguousCompatibilityRowError('contract card is missing')
  const seen = new Set<number>()
  for (const value of dependencies) {
    const dependency = Number(value)
    if (!Number.isSafeInteger(dependency) || dependency <= 0 || seen.has(dependency)) {
      throw new AmbiguousCompatibilityRowError(
        'dependency identity is invalid or duplicated',
      )
    }
    seen.add(dependency)
    const target = db.prepare('SELECT board_id FROM cards WHERE id=?')
      .get(dependency) as { board_id: number } | undefined
    if (!target || target.board_id !== board.board_id) {
      throw new AmbiguousCompatibilityRowError(
        'dependency scope is missing or cross-board',
      )
    }
  }
}

function assertMarketExtensionSets(
  db: Database.Database,
  cardId: number,
  expected: { criteria: string[]; dependencies: number[] },
): void {
  const criteria = (db.prepare(`
    SELECT criterion_id FROM job_market_criteria
    WHERE card_id=? ORDER BY criterion_id
  `).all(cardId) as Array<{ criterion_id: string }>)
    .map((row) => row.criterion_id)
  const dependencies = (db.prepare(`
    SELECT dependency_card_id FROM job_market_dependencies
    WHERE card_id=? ORDER BY dependency_card_id
  `).all(cardId) as Array<{ dependency_card_id: number }>)
    .map((row) => row.dependency_card_id)
  if (
    stableJson(criteria) !== stableJson([...expected.criteria].sort())
    || stableJson(dependencies) !== stableJson([...expected.dependencies].sort(
      (left, right) => left - right,
    ))
  ) {
    throw new AmbiguousCompatibilityRowError(
      'typed extension rows do not match compatibility identities',
    )
  }
}

function backfillLegacyAgents(db: Database.Database): void {
  if (!tableExists(db, 'agents')) return
  const rows = db.prepare('SELECT * FROM agents ORDER BY id')
    .all() as Array<Record<string, unknown>>
  for (const row of rows) {
    const agentId = Number(row.id)
    const key = String(agentId)
    if (hasDisposition(db, 'agents', key, hash(row))) continue
    try {
      const target = db.transaction(() => adoptLegacyAgent(db, row))()
      recordLink(db, {
        source_table: 'agents',
        source_key: key,
        source_hash: hash(row),
        target_table: 'agent_profiles',
        target_key: target.profileId,
        target_hash: hash(agentProfileSnapshot(
          db,
          target.profileId,
          target.conversationId,
        )),
        disposition: 'adopted_profile_and_conversation',
      })
    } catch (error) {
      if (!isAmbiguousDataError(error)) throw error
      recordQuarantine(db, {
        sourceTable: 'agents',
        sourceKey: key,
        sourceHash: hash(row),
        reasonCode: 'ambiguous_agent_identity',
        safeDetail:
          'Legacy name, board, profile, conversation, or session scope collides with canonical identity.',
      })
    }
  }
}

function adoptLegacyAgent(
  db: Database.Database,
  agent: Record<string, unknown>,
): { profileId: string; conversationId: string } {
  const agentId = Number(agent.id)
  const boardId = Number(agent.board_id)
  const name = String(agent.name)
  const deterministicProfileId = `legacy-agent:${agentId}`
  const deterministicConversationId = `legacy-conversation:${agentId}`
  const byLegacy = db.prepare(
    'SELECT * FROM agent_profiles WHERE legacy_agent_id=?',
  ).get(agentId) as Record<string, unknown> | undefined
  const byName = db.prepare(
    'SELECT * FROM agent_profiles WHERE board_id=? AND name=?',
  ).get(boardId, name) as Record<string, unknown> | undefined
  const byId = db.prepare('SELECT * FROM agent_profiles WHERE id=?')
    .get(deterministicProfileId) as Record<string, unknown> | undefined

  if (
    byLegacy
    && (
      Number(byLegacy.board_id) !== boardId
      || String(byLegacy.name) !== name
    )
  ) {
    throw new AmbiguousCompatibilityRowError('legacy profile scope differs')
  }
  if (
    byName
    && Number(byName.legacy_agent_id) !== agentId
  ) {
    throw new AmbiguousCompatibilityRowError('profile name already has another identity')
  }
  if (
    byId
    && Number(byId.legacy_agent_id) !== agentId
  ) {
    throw new AmbiguousCompatibilityRowError(
      'deterministic profile id already has another identity',
    )
  }

  const existing = byLegacy ?? byName ?? byId
  if (existing && String(existing.status) !== 'active') {
    throw new AmbiguousCompatibilityRowError(
      'legacy profile resolves to a non-active canonical profile',
    )
  }
  const profileId = existing
    ? String(existing.id)
    : deterministicProfileId
  if (!existing) {
    db.prepare(`
      INSERT INTO agent_profiles (
        id, board_id, legacy_agent_id, name, role, default_provider,
        default_model, default_effort, default_access_profile,
        capabilities_json, owner_actor_type, owner_actor_id, status,
        provenance_json, created_at, updated_at, archived_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'migration',
        '022-legacy-projection-forward-plan', 'active', ?, ?, ?, NULL
      )
    `).run(
      profileId,
      boardId,
      agentId,
      name,
      nullableString(agent.role),
      nullableString(agent.provider),
      nullableString(agent.model),
      nullableString(agent.effort),
      ['read_only', 'workspace_write', 'full_access'].includes(
        String(agent.access_profile),
      )
        ? String(agent.access_profile)
        : null,
      stableJson({
        source: 'legacy_agents',
        legacy_kind: nullableString(agent.kind),
        legacy_status: nullableString(agent.status),
      }),
      String(agent.created_at),
      String(agent.last_seen),
    )
  }

  const deterministicConversation = db.prepare(
    'SELECT * FROM agent_conversations WHERE id=?',
  ).get(deterministicConversationId) as Record<string, unknown> | undefined
  const defaultConversation = db.prepare(`
    SELECT * FROM agent_conversations
    WHERE profile_id=? AND is_default=1 AND status='active'
    ORDER BY created_at, id LIMIT 1
  `).get(profileId) as Record<string, unknown> | undefined
  if (
    deterministicConversation
    && (
      String(deterministicConversation.profile_id) !== profileId
      || Number(deterministicConversation.board_id) !== boardId
      || String(deterministicConversation.status) !== 'active'
      || Number(deterministicConversation.is_default) !== 1
    )
  ) {
    throw new AmbiguousCompatibilityRowError(
      'deterministic conversation id already has another scope',
    )
  }
  if (
    deterministicConversation
    && defaultConversation
    && String(defaultConversation.id) !== deterministicConversationId
  ) {
    throw new AmbiguousCompatibilityRowError(
      'profile has competing default conversation identities',
    )
  }
  const conversationId = deterministicConversation
    ? deterministicConversationId
    : defaultConversation
      ? String(defaultConversation.id)
      : deterministicConversationId
  if (!deterministicConversation && !defaultConversation) {
    db.prepare(`
      INSERT INTO agent_conversations (
        id, board_id, profile_id, title, status, is_default,
        next_sequence, created_by_actor_type, created_by_actor_id,
        created_at, updated_at, archived_at
      ) VALUES (
        ?, ?, ?, ?, 'active', 1, 1, 'migration',
        '022-legacy-projection-forward-plan', ?, ?, NULL
      )
    `).run(
      conversationId,
      boardId,
      profileId,
      `${name} conversation`,
      String(agent.created_at),
      String(agent.last_seen),
    )
  }

  const sessions = db.prepare(`
    SELECT session.id, session.workspace_id, session.profile_id,
      session.conversation_id, workspace.board_id
    FROM agent_sessions session
    JOIN workspaces workspace ON workspace.id=session.workspace_id
    WHERE session.agent_id=?
    ORDER BY session.id
  `).all(agentId) as Array<Record<string, unknown>>
  for (const session of sessions) {
    if (Number(session.board_id) !== boardId) {
      throw new AmbiguousCompatibilityRowError(
        'legacy session belongs to a different board',
      )
    }
    if (
      session.profile_id !== null
      && String(session.profile_id) !== profileId
    ) {
      throw new AmbiguousCompatibilityRowError(
        'legacy session already has another profile',
      )
    }
    if (
      session.conversation_id !== null
      && String(session.conversation_id) !== conversationId
    ) {
      throw new AmbiguousCompatibilityRowError(
        'legacy session already has another conversation',
      )
    }
  }
  db.prepare(`
    UPDATE agent_sessions
    SET profile_id=coalesce(profile_id, ?),
        conversation_id=coalesce(conversation_id, ?)
    WHERE agent_id=?
  `).run(profileId, conversationId, agentId)
  return { profileId, conversationId }
}

function validateCardAuthority(db: Database.Database): void {
  const rows = db.prepare('SELECT * FROM cards ORDER BY id')
    .all() as Array<Record<string, unknown>>
  for (const row of rows) {
    const cardId = Number(row.id)
    const key = String(cardId)
    if (hasDisposition(db, 'cards', key, hash(row))) continue
    const assignment = db.prepare(`
      SELECT * FROM job_market_assignments
      WHERE card_id=? AND status='active'
      ORDER BY created_at, id
    `).all(cardId) as Array<Record<string, unknown>>
    if (!assignment.length) {
      recordLink(db, {
        source_table: 'cards',
        source_key: key,
        source_hash: hash(row),
        target_table: 'cards',
        target_key: key,
        target_hash: hash(row),
        disposition: 'retained_legacy_scope',
      })
      continue
    }
    if (assignment.length !== 1) {
      recordQuarantine(db, {
        sourceTable: 'cards',
        sourceKey: key,
        sourceHash: hash(row),
        reasonCode: 'ambiguous_active_assignment',
        safeDetail: 'Card does not resolve to exactly one active assignment.',
      })
      continue
    }
    if (row.owner_agent_id !== null && !hasExactOwnerRuntime(db, cardId)) {
      recordQuarantine(db, {
        sourceTable: 'cards',
        sourceKey: key,
        sourceHash: hash(row),
        reasonCode: 'legacy_owner_mismatch',
        safeDetail:
          'Legacy owner does not match one active canonical assignment runtime.',
      })
      continue
    }
    const target = assignment[0]
    recordLink(db, {
      source_table: 'cards',
      source_key: key,
      source_hash: hash(row),
      target_table: 'job_market_assignments',
      target_key: String(target.id),
      target_hash: hash(target),
      disposition: row.owner_agent_id === null
        ? 'canonical_assignment_without_legacy_owner'
        : 'verified_legacy_owner_projection',
    })
  }
}

function hasExactOwnerRuntime(
  db: Database.Database,
  cardId: number,
): boolean {
  return !!db.prepare(`
    SELECT 1
    FROM cards card
    JOIN job_market_assignments assignment
      ON assignment.card_id=card.id AND assignment.status='active'
    JOIN jobs job
      ON job.job_assignment_id=assignment.id
      AND job.board_id=assignment.board_id
      AND job.card_id=assignment.card_id
      AND job.assigned_profile_id=assignment.profile_id
      AND job.assignment_market_version=assignment.assigned_market_version
      AND job.status IN ('queued','running','cancelling')
    JOIN agent_sessions session
      ON session.job_id=job.id
      AND session.job_assignment_id=job.job_assignment_id
      AND session.assigned_profile_id=job.assigned_profile_id
      AND session.assignment_market_version=job.assignment_market_version
      AND session.workspace_id=job.workspace_id
      AND session.status IN ('reserved','starting','running','idle','stopping')
    JOIN agents owner
      ON owner.id=card.owner_agent_id
      AND owner.id=session.agent_id
      AND owner.board_id=card.board_id
    WHERE card.id=?
  `).get(cardId)
}

function importCardEvents(db: Database.Database): void {
  if (!tableExists(db, 'card_events')) return
  const rows = db.prepare(`
    SELECT event.*, card.board_id,
      agent.board_id AS agent_board_id
    FROM card_events event
    LEFT JOIN cards card ON card.id=event.card_id
    LEFT JOIN agents agent ON agent.id=event.agent_id
    ORDER BY event.id
  `).all() as Array<Record<string, unknown>>
  for (const row of rows) {
    const eventId = Number(row.id)
    const key = String(eventId)
    if (hasDisposition(db, 'card_events', key, hash(sourceCardEvent(row)))) {
      continue
    }
    const source = sourceCardEvent(row)
    const kind = String(row.type).trim()
    let payload: unknown
    try {
      payload = JSON.parse(String(row.payload))
    } catch {
      payload = undefined
    }
    const boardId = Number(row.board_id)
    const agentId = row.agent_id === null ? null : Number(row.agent_id)
    if (
      !Number.isSafeInteger(boardId)
      || boardId <= 0
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,77}$/.test(kind)
      || payload === undefined
      || (
        agentId !== null
        && Number(row.agent_board_id) !== boardId
      )
    ) {
      recordQuarantine(db, {
        sourceTable: 'card_events',
        sourceKey: key,
        sourceHash: hash(source),
        reasonCode: 'invalid_legacy_event',
        safeDetail:
          'Historical event JSON, kind, card scope, or actor scope is invalid.',
      })
      continue
    }
    const canonicalId = `legacy-card-event:${eventId}`
    const canonicalPayload = stableJson({
      legacy_card_event_id: eventId,
      legacy_agent_id: agentId,
      legacy_payload: payload,
    })
    db.prepare(`
      INSERT OR IGNORE INTO os_events (
        id, board_id, actor_type, actor_id, workspace_id, card_id,
        session_id, process_id, job_id, contract_id, correlation_id,
        causation_id, idempotency_key, event_version, kind, source,
        payload, created_at
      ) VALUES (
        ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, ?, NULL, ?,
        1, ?, 'legacy_card_events', ?, ?
      )
    `).run(
      canonicalId,
      boardId,
      agentId === null ? 'migration' : 'legacy_agent',
      agentId === null ? AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID : String(agentId),
      Number(row.card_id),
      canonicalId,
      `migration:022:card_event:${eventId}`,
      `legacy.card_event.${kind}`,
      canonicalPayload,
      String(row.created_at),
    )
    const target = db.prepare('SELECT * FROM os_events WHERE id=?')
      .get(canonicalId) as Record<string, unknown> | undefined
    if (!target || !sameImportedEvent(target, {
      boardId,
      cardId: Number(row.card_id),
      agentId,
      kind,
      payload: canonicalPayload,
      createdAt: String(row.created_at),
    })) {
      throw new Error(
        `migration 022 found conflicting canonical event ${canonicalId}`,
      )
    }
    recordLink(db, {
      source_table: 'card_events',
      source_key: key,
      source_hash: hash(source),
      target_table: 'os_events',
      target_key: canonicalId,
      target_hash: hash(target),
      disposition: 'imported_legacy_event',
    })
  }
}

function sourceCardEvent(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: row.id,
    card_id: row.card_id,
    agent_id: row.agent_id,
    type: row.type,
    payload: row.payload,
    created_at: row.created_at,
  }
}

function sameImportedEvent(
  row: Record<string, unknown>,
  expected: {
    boardId: number
    cardId: number
    agentId: number | null
    kind: string
    payload: string
    createdAt: string
  },
): boolean {
  return Number(row.board_id) === expected.boardId
    && Number(row.card_id) === expected.cardId
    && String(row.actor_type) === (
      expected.agentId === null ? 'migration' : 'legacy_agent'
    )
    && String(row.actor_id) === (
      expected.agentId === null
        ? AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID
        : String(expected.agentId)
    )
    && String(row.kind) === `legacy.card_event.${expected.kind}`
    && String(row.source) === 'legacy_card_events'
    && String(row.payload) === expected.payload
    && String(row.created_at) === expected.createdAt
}

function baselineAgentUsage(db: Database.Database): void {
  if (!tableExists(db, 'agent_usage')) return
  const rows = db.prepare('SELECT * FROM agent_usage ORDER BY board_id, agent_id, day')
    .all() as Array<Record<string, unknown>>
  for (const row of rows) {
    const key = `${row.board_id}:${row.agent_id}:${row.day}`
    const sourceHash = hash(row)
    if (hasDisposition(db, 'agent_usage', key, sourceHash)) continue
    const agent = db.prepare('SELECT board_id FROM agents WHERE id=?')
      .get(row.agent_id) as { board_id: number } | undefined
    if (!agent || agent.board_id !== Number(row.board_id)) {
      recordQuarantine(db, {
        sourceTable: 'agent_usage',
        sourceKey: key,
        sourceHash,
        reasonCode: 'invalid_usage_scope',
        safeDetail:
          'Aggregate agent identity is missing or belongs to another board.',
      })
      continue
    }
    recordLink(db, {
      source_table: 'agent_usage',
      source_key: key,
      source_hash: sourceHash,
      target_table: 'agent_usage',
      target_key: key,
      target_hash: sourceHash,
      disposition: 'retained_projection_baseline',
    })
  }
}

function linkReviewDecisions(db: Database.Database): void {
  if (!tableExists(db, 'review_decisions')) return
  const rows = db.prepare('SELECT * FROM review_decisions ORDER BY id')
    .all() as Array<Record<string, unknown>>
  for (const row of rows) {
    const key = String(row.id)
    const sourceHash = hash(row)
    if (hasDisposition(db, 'review_decisions', key, sourceHash)) continue
    const card = db.prepare('SELECT board_id FROM cards WHERE id=?')
      .get(row.card_id) as { board_id: number } | undefined
    if (!card || card.board_id !== Number(row.board_id)) {
      recordQuarantine(db, {
        sourceTable: 'review_decisions',
        sourceKey: key,
        sourceHash,
        reasonCode: 'invalid_review_scope',
        safeDetail: 'Review card identity is missing or cross-board.',
      })
      continue
    }
    const reports = db.prepare(`
      SELECT * FROM delivery_reports
      WHERE card_id=? AND board_id=?
      ORDER BY sequence, created_at, id
    `).all(row.card_id, row.board_id) as Array<Record<string, unknown>>
    if (!reports.length) {
      recordLink(db, {
        source_table: 'review_decisions',
        source_key: key,
        source_hash: sourceHash,
        target_table: 'review_decisions',
        target_key: key,
        target_hash: sourceHash,
        disposition: 'retained_legacy_lineage',
      })
      continue
    }
    const expectedStatus = String(row.decision) === 'approve'
      ? 'accepted'
      : String(row.decision) === 'send_back'
        ? 'rejected'
        : null
    if (
      reports.length !== 1
      || expectedStatus === null
      || String(reports[0].status) !== expectedStatus
    ) {
      recordQuarantine(db, {
        sourceTable: 'review_decisions',
        sourceKey: key,
        sourceHash,
        reasonCode: 'ambiguous_delivery_lineage',
        safeDetail:
          'Review does not resolve to one matching terminal delivery report.',
      })
      continue
    }
    recordLink(db, {
      source_table: 'review_decisions',
      source_key: key,
      source_hash: sourceHash,
      target_table: 'delivery_reports',
      target_key: String(reports[0].id),
      target_hash: hash(reports[0]),
      disposition: 'verified_delivery_lineage',
    })
  }
}

function recordLink(db: Database.Database, link: StoredLink): void {
  const quarantine = db.prepare(`
    SELECT source_hash FROM os_compatibility_projection_quarantine
    WHERE migration_id=? AND source_table=? AND source_key=?
  `).get(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    link.source_table,
    link.source_key,
  )
  if (quarantine) {
    throw new Error(
      `migration 022 source ${link.source_table}:${link.source_key} is already quarantined`,
    )
  }
  const existing = db.prepare(`
    SELECT source_hash, target_table, target_key, target_hash, disposition
    FROM os_compatibility_projection_links
    WHERE migration_id=? AND source_table=? AND source_key=?
  `).get(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    link.source_table,
    link.source_key,
  ) as Omit<StoredLink, 'source_table' | 'source_key'> | undefined
  if (existing) {
    if (
      existing.source_hash !== link.source_hash
      || existing.target_table !== link.target_table
      || existing.target_key !== link.target_key
      || existing.target_hash !== link.target_hash
      || existing.disposition !== link.disposition
    ) {
      throw new Error(
        `migration 022 source ${link.source_table}:${link.source_key} changed after linking`,
      )
    }
    return
  }
  db.prepare(`
    INSERT INTO os_compatibility_projection_links (
      migration_id, source_table, source_key, source_hash,
      target_table, target_key, target_hash, disposition
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    link.source_table,
    link.source_key,
    link.source_hash,
    link.target_table,
    link.target_key,
    link.target_hash,
    link.disposition,
  )
}

function recordQuarantine(
  db: Database.Database,
  input: QuarantineInput,
): void {
  const link = db.prepare(`
    SELECT 1 FROM os_compatibility_projection_links
    WHERE migration_id=? AND source_table=? AND source_key=?
  `).get(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    input.sourceTable,
    input.sourceKey,
  )
  if (link) {
    throw new Error(
      `migration 022 source ${input.sourceTable}:${input.sourceKey} is already linked`,
    )
  }
  const existing = db.prepare(`
    SELECT source_hash, reason_code, safe_detail
    FROM os_compatibility_projection_quarantine
    WHERE migration_id=? AND source_table=? AND source_key=?
  `).get(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    input.sourceTable,
    input.sourceKey,
  ) as {
    source_hash: string
    reason_code: string
    safe_detail: string
  } | undefined
  if (existing) {
    if (
      existing.source_hash !== input.sourceHash
      || existing.reason_code !== input.reasonCode
      || existing.safe_detail !== input.safeDetail
    ) {
      throw new Error(
        `migration 022 quarantined source ${input.sourceTable}:${input.sourceKey} changed`,
      )
    }
    return
  }
  db.prepare(`
    INSERT INTO os_compatibility_projection_quarantine (
      migration_id, source_table, source_key, source_hash,
      reason_code, safe_detail
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    input.sourceTable,
    input.sourceKey,
    input.sourceHash,
    input.reasonCode,
    input.safeDetail,
  )
}

function hasDisposition(
  db: Database.Database,
  table: AgentOsLegacyCompatibilityTable,
  key: string,
  sourceHash: string,
): boolean {
  const linked = db.prepare(`
    SELECT source_hash FROM os_compatibility_projection_links
    WHERE migration_id=? AND source_table=? AND source_key=?
  `).get(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    table,
    key,
  ) as { source_hash: string } | undefined
  const quarantined = db.prepare(`
    SELECT source_hash FROM os_compatibility_projection_quarantine
    WHERE migration_id=? AND source_table=? AND source_key=?
  `).get(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    table,
    key,
  ) as { source_hash: string } | undefined
  if (linked && quarantined) {
    throw new Error(`migration 022 source ${table}:${key} has two dispositions`)
  }
  const existing = linked ?? quarantined
  if (!existing) return false
  if (existing.source_hash !== sourceHash) {
    throw new Error(`migration 022 source ${table}:${key} changed after disposition`)
  }
  return true
}

function recordValidationResults(
  db: Database.Database,
  results: CompatibilityValidationResult[],
): void {
  const upsert = db.prepare(`
    INSERT INTO os_compatibility_migration_checks (
      migration_id, validation_id, category, issue_count,
      result_hash, checked_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(migration_id, validation_id) DO UPDATE SET
      category=excluded.category,
      issue_count=excluded.issue_count,
      result_hash=excluded.result_hash,
      checked_at=excluded.checked_at
  `)
  for (const result of results) {
    upsert.run(
      AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
      result.id,
      result.category,
      result.issue_count,
      result.result_hash,
    )
  }
}

function sourceSnapshot(
  db: Database.Database,
  table: AgentOsLegacyCompatibilityTable,
  key: string,
): Record<string, unknown> | null {
  if (table === 'agent_usage') {
    const [boardId, agentId, day] = key.split(':')
    return db.prepare(`
      SELECT * FROM agent_usage
      WHERE board_id=? AND agent_id=? AND day=?
    `).get(Number(boardId), Number(agentId), day) as
      Record<string, unknown> | undefined ?? null
  }
  const keyColumn = table === 'task_contracts'
    ? 'card_id'
    : 'id'
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${keyColumn}=?`)
    .get(Number(key)) as Record<string, unknown> | undefined
  if (!row) return null
  return table === 'card_events' ? sourceCardEvent(row) : row
}

function targetSnapshot(
  db: Database.Database,
  table: string,
  key: string,
): Record<string, unknown> | null {
  if (table === 'job_market_contracts') {
    return jobMarketSnapshot(db, Number(key))
  }
  if (table === 'agent_profiles') {
    const conversation = db.prepare(`
      SELECT id FROM agent_conversations
      WHERE profile_id=? AND is_default=1 AND status='active'
      ORDER BY created_at, id LIMIT 1
    `).get(key) as { id: string } | undefined
    return conversation
      ? agentProfileSnapshot(db, key, conversation.id)
      : null
  }
  if (table === 'agent_usage') {
    const [boardId, agentId, day] = key.split(':')
    return db.prepare(`
      SELECT * FROM agent_usage
      WHERE board_id=? AND agent_id=? AND day=?
    `).get(Number(boardId), Number(agentId), day) as
      Record<string, unknown> | undefined ?? null
  }
  const keyColumns: Record<string, string> = {
    boards: 'id',
    cards: 'id',
    job_market_assignments: 'id',
    os_events: 'id',
    review_decisions: 'id',
    delivery_reports: 'id',
  }
  const column = keyColumns[table]
  if (!column) return null
  return db.prepare(`SELECT * FROM ${table} WHERE ${column}=?`)
    .get(table === 'boards' || table === 'cards'
      || table === 'review_decisions'
      ? Number(key)
      : key) as Record<string, unknown> | undefined ?? null
}

function jobMarketSnapshot(
  db: Database.Database,
  cardId: number,
): Record<string, unknown> {
  return {
    contract: db.prepare(
      'SELECT * FROM job_market_contracts WHERE card_id=?',
    ).get(cardId) ?? null,
    criteria: db.prepare(`
      SELECT * FROM job_market_criteria
      WHERE card_id=? ORDER BY criterion_id
    `).all(cardId),
    dependencies: db.prepare(`
      SELECT * FROM job_market_dependencies
      WHERE card_id=? ORDER BY dependency_card_id
    `).all(cardId),
  }
}

function agentProfileSnapshot(
  db: Database.Database,
  profileId: string,
  conversationId: string,
): Record<string, unknown> {
  return {
    profile: db.prepare('SELECT * FROM agent_profiles WHERE id=?')
      .get(profileId) ?? null,
    conversation: db.prepare('SELECT * FROM agent_conversations WHERE id=?')
      .get(conversationId) ?? null,
  }
}

function isAmbiguousDataError(error: unknown): boolean {
  return error instanceof AmbiguousCompatibilityRowError
    || error instanceof ValidationError
    || error instanceof ConflictError
    || error instanceof NotFoundError
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text || null
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
  `).get(table)
}

function tableRowCount(db: Database.Database, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number
  }).count)
}

function hasTables(
  db: Database.Database,
  tables: readonly string[],
): boolean {
  return tables.every((table) => tableExists(db, table))
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/;\s*$/, '')
    .trim()
    .toLowerCase()
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function compatibilityForwardPlanCoverage(): {
  expected: AgentOsLegacyCompatibilityTable[]
  actual: AgentOsLegacyCompatibilityTable[]
} {
  return {
    expected: AGENT_OS_LEGACY_PROJECTION_CONTRACT.tables
      .map((entry) => entry.table)
      .sort(),
    actual: AGENT_OS_COMPATIBILITY_FORWARD_PLAN.entries
      .map((entry) => entry.source_table)
      .sort(),
  }
}
