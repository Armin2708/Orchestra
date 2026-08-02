import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalHash, stableJson } from './agent-home-support.js'
import { applyCompatibilityForwardMigration } from './compatibility-forward-migration.js'
import {
  AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID,
  applyCompatibilityMigrationTelemetryMigration,
  refreshCompatibilityMigrationTelemetryCollectorEpoch,
} from './compatibility-migration-telemetry.js'
import {
  AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID,
  applyCompatibilityMigrationFailureJournalMigration,
} from './compatibility-migration-failure-journal.js'
import {
  AGENT_OS_KNOWLEDGE_RETRIEVAL_MIGRATION_ID,
  installKnowledgeRetrievalSchema,
} from './knowledge-retrieval.js'
import { conversationEventContentHash } from './conversation-event-integrity.js'
import { applyOutcomeAnalyticsMigration } from './outcome-analytics-migration.js'
import { projectManagedDriverEvent } from './managed-driver-event-projection.js'
import {
  isNativeProviderProjection,
  isWithheldProviderReasoning,
  normalizeProjectedText,
  redactProjectedText,
  type ProjectedTextRedactionState,
} from './projected-text-redaction.js'
import { redactSensitiveText, redactStructuredValue } from './structured-redaction.js'
import {
  AGENT_OS_ORGANIZATION_CORE_MIGRATION_ID,
  installOrganizationCoreSchema,
} from './organization-migration.js'
import {
  AGENT_OS_ORGANIZATION_COORDINATION_MIGRATION_ID,
  installOrganizationCoordinationSchema,
} from './organization-coordination-migration.js'
import {
  AGENT_OS_ORGANIZATION_ASSURANCE_MIGRATION_ID,
  installOrganizationAssuranceSchema,
} from './organization-assurance-migration.js'
import { TERMINAL_SESSION_STATE_SCHEMA_SQL } from './terminal-session-state.js'
import {
  AGENT_OS_DELIVERY_TRACKBOOK_MIGRATION_ID,
  installDeliveryTrackbookSchema,
} from './delivery-trackbook-migration.js'
import {
  AGENT_OS_KNOWLEDGE_MANAGEMENT_MIGRATION_ID,
  installKnowledgeManagementSchema,
} from './knowledge-management-migration.js'
import {
  AGENT_OS_DISCUSSION_MIGRATION_ID,
  installDiscussionSchema,
} from './discussion-migration.js'
import {
  AGENT_OS_TEAM_PLANNING_MIGRATION_ID,
  installTeamPlanningSchema,
} from './team-planning-migration.js'
import {
  AGENT_OS_TEAM_COLLABORATION_REVIEW_MIGRATION_ID,
  installTeamCollaborationReviewSchema,
} from './team-collaboration-review-migration.js'
import {
  AGENT_OS_DELIVERY_SHIPMENT_INTEGRITY_MIGRATION_ID,
  installDeliveryShipmentIntegritySchema,
} from './delivery-shipment-integrity-migration.js'
import {
  AGENT_OS_KNOWLEDGE_CONTEXT_USE_ACTUAL_MIGRATION_ID,
  KNOWLEDGE_CONTEXT_USE_ACTUAL_TABLE_SQL,
  installKnowledgeContextUseActualEvidenceSchema,
} from './knowledge-context-use-actual-migration.js'
import {
  AGENT_OS_DELIVERY_AUTOSHIP_INTENT_MIGRATION_ID,
  installDeliveryAutoshipIntentSchema,
} from './delivery-autoship-intent-migration.js'
import {
  AGENT_OS_DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_MIGRATION_ID,
  installDeliveryAutoshipWorktreeIdentitySchema,
} from './delivery-autoship-worktree-identity-migration.js'

export const AGENT_OS_TERMINAL_SESSION_STATE_MIGRATION_ID =
  '039-terminal-session-state' as const
const AGENT_OS_LEGACY_TERMINAL_SESSION_STATE_MIGRATION_ID =
  '030-terminal-session-state' as const
import {
  AGENT_OS_DEVICE_SESSION_MIGRATION_ID,
  AGENT_OS_LEGACY_DEVICE_SESSION_MIGRATION_ID,
  deviceSessionSchemaFingerprint,
  installDeviceSessionSchema,
} from './device-session-migration.js'
import {
  LEGACY_OPERATIONS_RECOVERY_SCHEMA_ID,
  OPERATIONS_RECOVERY_SCHEMA_ID,
  installOperationsRecoverySchema,
} from './operations-recovery.js'
import {
  attestRemoteDeviceProofSchema,
  installRemoteDeviceProofSchema,
} from '../remote-device-proof.js'
import {
  attestRemoteSecuritySchema,
  installRemoteSecuritySchema,
} from '../remote-security-schema.js'

interface Migration {
  id: string
  apply(db: Database.Database): void
}

const metadataRecord = (serialized: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(serialized) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const KNOWLEDGE_SCHEMA_TABLES = Object.freeze([
  'knowledge_sources',
  'knowledge_chunks',
  'context_builds',
  'context_build_sources',
  'context_build_entries',
  'context_uses',
])
const KNOWLEDGE_SCHEMA_INDEXES = Object.freeze([
  'idx_context_build_entries_selected',
  'idx_context_build_sources_source',
  'idx_context_builds_status',
  'idx_context_uses_build',
  'idx_context_uses_job',
  'idx_knowledge_chunks_source',
  'idx_knowledge_sources_locator',
  'idx_knowledge_sources_state',
])
const KNOWLEDGE_SCHEMA_TRIGGERS = Object.freeze([
  'context_build_entries_delete',
  'context_build_entries_immutable',
  'context_build_entries_insert',
  'context_build_sources_delete',
  'context_build_sources_immutable',
  'context_build_sources_insert',
  'context_builds_delete',
  'context_builds_identity_immutable',
  'context_builds_scope_insert',
  'context_builds_status_transition',
  'context_uses_delete',
  'context_uses_finish',
  'context_uses_insert',
  'context_uses_mark_build_used',
  'knowledge_chunks_delete',
  'knowledge_chunks_immutable',
  'knowledge_chunks_insert',
  'knowledge_sources_delete',
  'knowledge_sources_immutable',
  'knowledge_sources_scope_insert',
])
const KNOWLEDGE_TABLE_SCHEMA_HASHES: Readonly<Record<string, string>> = Object.freeze({
  knowledge_sources: '369e581e96f74fd5003882f42c779e6c2fdaf8db70d39a9df6de6628466da6e7',
  knowledge_chunks: '704594fdb9c631461d55171fff7deb5286dc79fb30a3f41ddc5de1b7d9d9ceca',
  context_builds: '203184a78bbbe6501098caaea758b08f3e2aab7fa9ce5d940cdf90261d5a80c2',
  context_build_sources: '87b7e413a8fcc3f3621643e1a0c931b5da6f1d0518647282d538cf78102454e0',
  context_build_entries: 'a202e71e7d7391da4c17e6ce6e231ba176283f4a206cda03423806c28dc71d11',
  context_uses: '4539beb67a5e99e444fe5a6ff9c72d8f65457c875e968de8fdb45b14b9810563',
})
const PROVIDER_ACCEPTANCE_EVIDENCE_COLUMNS = Object.freeze([
  ['id', 'TEXT', 0, 1],
  ['contract_version', 'INTEGER', 1, 0],
  ['provider_id', 'TEXT', 1, 0],
  ['adapter_id', 'TEXT', 1, 0],
  ['adapter_version', 'TEXT', 1, 0],
  ['mode_id', 'TEXT', 1, 0],
  ['runtime_mode', 'TEXT', 1, 0],
  ['billing_mode', 'TEXT', 1, 0],
  ['credential_kind', 'TEXT', 1, 0],
  ['executable_version', 'TEXT', 1, 0],
  ['platform', 'TEXT', 1, 0],
  ['source_commit', 'TEXT', 1, 0],
  ['observed_at', 'TEXT', 1, 0],
  ['matrix_json', 'TEXT', 1, 0],
  ['matrix_sha256', 'TEXT', 1, 0],
  ['artifact_ref', 'TEXT', 1, 0],
  ['artifact_sha256', 'TEXT', 1, 0],
  ['recorded_at', 'TEXT', 1, 0],
] as const)
const PROVIDER_ACCEPTANCE_EVIDENCE_OBJECTS = Object.freeze([
  ['index', 'idx_provider_acceptance_evidence_tuple_latest'],
  ['table', 'provider_acceptance_evidence'],
  ['trigger', 'provider_acceptance_evidence_delete'],
  ['trigger', 'provider_acceptance_evidence_insert'],
  ['trigger', 'provider_acceptance_evidence_update'],
] as const)
const CAUSAL_EVENT_METADATA_COLUMNS = Object.freeze([
  ['actor_type', 'TEXT', 1, "'system'"],
  ['actor_id', 'TEXT', 0, null],
] as const)
const CAUSAL_EVENT_METADATA_INVALID = `
  NEW.actor_type IS NULL
  OR length(trim(NEW.actor_type)) NOT BETWEEN 1 AND 64
  OR trim(NEW.actor_type)!=NEW.actor_type
  OR (
    NEW.actor_id IS NOT NULL
    AND (
      length(trim(NEW.actor_id)) NOT BETWEEN 1 AND 256
      OR trim(NEW.actor_id)!=NEW.actor_id
    )
  )
  OR (
    NEW.correlation_id IS NOT NULL
    AND (
      length(trim(NEW.correlation_id)) NOT BETWEEN 1 AND 512
      OR trim(NEW.correlation_id)!=NEW.correlation_id
    )
  )
  OR (
    NEW.causation_id IS NOT NULL
    AND (
      length(trim(NEW.causation_id)) NOT BETWEEN 1 AND 512
      OR trim(NEW.causation_id)!=NEW.causation_id
    )
  )
  OR (
    NEW.workspace_id IS NOT NULL
    AND (
      length(trim(NEW.workspace_id)) NOT BETWEEN 1 AND 512
      OR trim(NEW.workspace_id)!=NEW.workspace_id
    )
  )
  OR (
    NEW.session_id IS NOT NULL
    AND (
      length(trim(NEW.session_id)) NOT BETWEEN 1 AND 512
      OR trim(NEW.session_id)!=NEW.session_id
    )
  )
  OR (
    NEW.job_id IS NOT NULL
    AND (
      length(trim(NEW.job_id)) NOT BETWEEN 1 AND 512
      OR trim(NEW.job_id)!=NEW.job_id
    )
  )
  OR (
    NEW.contract_id IS NOT NULL
    AND (
      length(trim(NEW.contract_id)) NOT BETWEEN 1 AND 512
      OR trim(NEW.contract_id)!=NEW.contract_id
    )
  )
`
const CAUSAL_EVENT_METADATA_OBJECTS = Object.freeze([
  {
    type: 'index',
    name: 'idx_os_events_actor',
    sql: `CREATE INDEX idx_os_events_actor
      ON os_events(board_id, actor_type, actor_id, created_at, id)`,
  },
  {
    type: 'index',
    name: 'idx_os_events_causation',
    sql: `CREATE INDEX idx_os_events_causation
      ON os_events(causation_id, created_at, id)`,
  },
  {
    type: 'index',
    name: 'idx_os_events_contract',
    sql: `CREATE INDEX idx_os_events_contract
      ON os_events(contract_id, created_at, id)`,
  },
  {
    type: 'index',
    name: 'idx_os_events_session',
    sql: `CREATE INDEX idx_os_events_session
      ON os_events(session_id, created_at, id)`,
  },
  {
    type: 'trigger',
    name: 'os_events_causal_metadata_insert',
    sql: `CREATE TRIGGER os_events_causal_metadata_insert
      BEFORE INSERT ON os_events
      BEGIN
        SELECT CASE WHEN ${CAUSAL_EVENT_METADATA_INVALID}
        THEN RAISE(ABORT, 'os event causal metadata is invalid') END;
      END`,
  },
  {
    type: 'trigger',
    name: 'os_events_causal_metadata_update',
    sql: `CREATE TRIGGER os_events_causal_metadata_update
      BEFORE UPDATE OF actor_type, actor_id, correlation_id, causation_id,
        workspace_id, session_id, job_id, contract_id
      ON os_events
      BEGIN
        SELECT CASE WHEN ${CAUSAL_EVENT_METADATA_INVALID}
        THEN RAISE(ABORT, 'os event causal metadata is invalid') END;
      END`,
  },
] as const)
const COMMAND_RECEIPT_COLUMNS = Object.freeze([
  ['board_id', 'INTEGER', 1, 1],
  ['idempotency_key', 'TEXT', 1, 2],
  ['command', 'TEXT', 1, 0],
  ['scope_id', 'TEXT', 1, 0],
  ['request_fingerprint', 'TEXT', 1, 0],
  ['status', 'TEXT', 1, 0],
  ['result_id', 'TEXT', 0, 0],
  ['error_message', 'TEXT', 0, 0],
  ['created_at', 'TEXT', 1, 0],
  ['completed_at', 'TEXT', 0, 0],
] as const)
const COMMAND_RECEIPT_TABLE_SQL = `CREATE TABLE os_command_receipts (
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL
    CHECK(length(idempotency_key) BETWEEN 1 AND 200
      AND trim(idempotency_key)=idempotency_key
      AND instr(CAST(idempotency_key AS BLOB), X'00')=0
      AND idempotency_key NOT GLOB (
        '*[' || char(1) || '-' || char(31) || char(127) || ']*'
      )),
  command TEXT NOT NULL
    CHECK(command IN (
      'workspace.create',
      'checkpoint.create',
      'policy.create',
      'delivery.submit',
      'delivery.accept',
      'job.cancel'
    )),
  scope_id TEXT NOT NULL
    CHECK(length(scope_id) BETWEEN 1 AND 512
      AND trim(scope_id)=scope_id),
  request_fingerprint TEXT NOT NULL
    CHECK(length(request_fingerprint)=64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL
    CHECK(status IN ('pending','succeeded','failed')),
  result_id TEXT
    CHECK(result_id IS NULL OR (
      length(result_id) BETWEEN 1 AND 512
      AND trim(result_id)=result_id
    )),
  error_message TEXT
    CHECK(error_message IS NULL OR length(error_message) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL
    CHECK(strftime('%s', created_at) IS NOT NULL),
  completed_at TEXT
    CHECK(completed_at IS NULL OR strftime('%s', completed_at) IS NOT NULL),
  PRIMARY KEY(board_id, idempotency_key),
  CHECK(
    (status='pending' AND result_id IS NULL
      AND completed_at IS NULL AND error_message IS NULL)
    OR
    (status='succeeded' AND result_id IS NOT NULL
      AND completed_at IS NOT NULL AND error_message IS NULL)
    OR
    (status='failed' AND result_id IS NULL AND completed_at IS NOT NULL
      AND error_message IS NOT NULL)
  )
) WITHOUT ROWID`
const COMMAND_RECEIPT_OBJECTS = Object.freeze([
  {
    type: 'index',
    name: 'idx_os_command_receipts_scope',
    sql: `CREATE INDEX idx_os_command_receipts_scope
      ON os_command_receipts(board_id, command, scope_id, created_at)`,
  },
  {
    type: 'trigger',
    name: 'os_command_receipts_update_lifecycle',
    sql: `CREATE TRIGGER os_command_receipts_update_lifecycle
      BEFORE UPDATE ON os_command_receipts
      BEGIN
        SELECT CASE WHEN
          NEW.board_id IS NOT OLD.board_id
          OR NEW.idempotency_key IS NOT OLD.idempotency_key
          OR NEW.command IS NOT OLD.command
          OR NEW.scope_id IS NOT OLD.scope_id
          OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
          OR NEW.created_at IS NOT OLD.created_at
          OR OLD.status!='pending'
          OR NEW.status NOT IN ('succeeded','failed')
        THEN RAISE(
          ABORT,
          'command receipt identity or lifecycle is immutable'
        ) END;
      END`,
  },
] as const)

const normalizedSchemaSql = (value: string): string => value.trim()
const normalizedObjectSql = (value: string): string =>
  value.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim()

const assertKnowledgeSchemaCompatible = (db: Database.Database): void => {
  const placeholders = KNOWLEDGE_SCHEMA_TABLES.map(() => '?').join(', ')
  const objects = db.prepare(`SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE tbl_name IN (${placeholders})
      AND type IN ('table', 'index', 'trigger')
    ORDER BY type, name`).all(...KNOWLEDGE_SCHEMA_TABLES) as Array<{
      type: 'table' | 'index' | 'trigger'
      name: string
      tbl_name: string
      sql: string | null
    }>
  const tableRows = objects.filter((object) => object.type === 'table')
  const tableNames = tableRows.map((object) => object.name)
  const indexes = objects
    .filter((object) => object.type === 'index' && object.sql !== null)
    .map((object) => object.name)
  const triggers = objects
    .filter((object) => object.type === 'trigger')
    .map((object) => object.name)
  const exactNames = (actual: readonly string[], expected: readonly string[]): boolean =>
    actual.length === expected.length
      && actual.every((name, index) => name === expected[index])
  if (
    !exactNames(tableNames, [...KNOWLEDGE_SCHEMA_TABLES].sort())
    || !exactNames(indexes, KNOWLEDGE_SCHEMA_INDEXES)
    || !exactNames(triggers, KNOWLEDGE_SCHEMA_TRIGGERS)
  ) {
    throw new Error(
      'migration 018-knowledge-persistence found an incompatible knowledge schema',
    )
  }
  for (const table of tableRows) {
    const actualHash = sha256(normalizedSchemaSql(table.sql ?? ''))
    const acceptedHashes = table.name === 'context_uses'
      ? [
          KNOWLEDGE_TABLE_SCHEMA_HASHES.context_uses,
          sha256(normalizedSchemaSql(KNOWLEDGE_CONTEXT_USE_ACTUAL_TABLE_SQL)),
        ]
      : [KNOWLEDGE_TABLE_SCHEMA_HASHES[table.name]]
    if (!acceptedHashes.includes(actualHash)) {
      throw new Error(
        'migration 018-knowledge-persistence found an incompatible knowledge schema',
      )
    }
  }
}

const assertProviderAcceptanceEvidenceSchemaCompatible = (
  db: Database.Database,
): void => {
  const columns = db.prepare(`SELECT name, type, "notnull" AS required, pk
    FROM pragma_table_info('provider_acceptance_evidence')
    ORDER BY cid`).all() as Array<{
      name: string
      type: string
      required: number
      pk: number
    }>
  const objects = db.prepare(`SELECT type, name
    FROM sqlite_master
    WHERE tbl_name='provider_acceptance_evidence'
      AND type IN ('table', 'index', 'trigger')
      AND (type!='index' OR sql IS NOT NULL)
    ORDER BY type, name`).all() as Array<{
      type: string
      name: string
    }>
  const columnsMatch = columns.length === PROVIDER_ACCEPTANCE_EVIDENCE_COLUMNS.length
    && columns.every((column, index) => {
      const expected = PROVIDER_ACCEPTANCE_EVIDENCE_COLUMNS[index]
      return expected !== undefined
        && column.name === expected[0]
        && column.type.toUpperCase() === expected[1]
        && column.required === expected[2]
        && column.pk === expected[3]
    })
  const objectsMatch = objects.length === PROVIDER_ACCEPTANCE_EVIDENCE_OBJECTS.length
    && objects.every((object, index) => {
      const expected = PROVIDER_ACCEPTANCE_EVIDENCE_OBJECTS[index]
      return expected !== undefined
        && object.type === expected[0]
        && object.name === expected[1]
    })
  if (!columnsMatch || !objectsMatch) {
    throw new Error(
      'migration 019-provider-acceptance-evidence found an incompatible evidence schema',
    )
  }
}

const assertCausalEventMetadataColumnsCompatible = (
  db: Database.Database,
): void => {
  const columns = db.prepare(`SELECT name, type, "notnull" AS required, dflt_value
    FROM pragma_table_info('os_events')
    WHERE name IN ('actor_type', 'actor_id')
    ORDER BY cid`).all() as Array<{
      name: string
      type: string
      required: number
      dflt_value: string | null
    }>
  const matches = columns.length === CAUSAL_EVENT_METADATA_COLUMNS.length
    && columns.every((column, index) => {
      const expected = CAUSAL_EVENT_METADATA_COLUMNS[index]
      return expected !== undefined
        && column.name === expected[0]
        && column.type.toUpperCase() === expected[1]
        && column.required === expected[2]
        && column.dflt_value === expected[3]
    })
  if (!matches) {
    throw new Error(
      'migration 020-causal-event-metadata found incompatible actor metadata columns',
    )
  }
}

const assertCausalEventMetadataSchemaCompatible = (
  db: Database.Database,
): void => {
  assertCausalEventMetadataColumnsCompatible(db)
  const objects = db.prepare(`SELECT type, name, sql
    FROM sqlite_master
    WHERE tbl_name='os_events'
      AND name IN (
        'idx_os_events_actor',
        'idx_os_events_causation',
        'idx_os_events_contract',
        'idx_os_events_session',
        'os_events_causal_metadata_insert',
        'os_events_causal_metadata_update'
      )
    ORDER BY type, name`).all() as Array<{
      type: string
      name: string
      sql: string | null
    }>
  const objectsMatch = objects.length === CAUSAL_EVENT_METADATA_OBJECTS.length
    && objects.every((object, index) => {
      const expected = CAUSAL_EVENT_METADATA_OBJECTS[index]
      return expected !== undefined
        && object.type === expected.type
        && object.name === expected.name
        && normalizedObjectSql(object.sql ?? '') === normalizedObjectSql(expected.sql)
    })
  const invalidRow = db.prepare(`SELECT id
    FROM os_events
    WHERE correlation_id IS NULL
      OR actor_type IS NULL
      OR length(trim(actor_type)) NOT BETWEEN 1 AND 64
      OR trim(actor_type)!=actor_type
      OR (
        actor_id IS NOT NULL
        AND (
          length(trim(actor_id)) NOT BETWEEN 1 AND 256
          OR trim(actor_id)!=actor_id
        )
      )
      OR (
        correlation_id IS NOT NULL
        AND (
          length(trim(correlation_id)) NOT BETWEEN 1 AND 512
          OR trim(correlation_id)!=correlation_id
        )
      )
      OR (
        causation_id IS NOT NULL
        AND (
          length(trim(causation_id)) NOT BETWEEN 1 AND 512
          OR trim(causation_id)!=causation_id
        )
      )
      OR (
        workspace_id IS NOT NULL
        AND (
          length(trim(workspace_id)) NOT BETWEEN 1 AND 512
          OR trim(workspace_id)!=workspace_id
        )
      )
      OR (
        session_id IS NOT NULL
        AND (
          length(trim(session_id)) NOT BETWEEN 1 AND 512
          OR trim(session_id)!=session_id
        )
      )
      OR (
        job_id IS NOT NULL
        AND (
          length(trim(job_id)) NOT BETWEEN 1 AND 512
          OR trim(job_id)!=job_id
        )
      )
      OR (
        contract_id IS NOT NULL
        AND (
          length(trim(contract_id)) NOT BETWEEN 1 AND 512
          OR trim(contract_id)!=contract_id
        )
      )
    LIMIT 1`).get()
  if (!objectsMatch || invalidRow) {
    throw new Error(
      'migration 020-causal-event-metadata found incompatible causal event metadata',
    )
  }
}
const assertCommandReceiptSchemaCompatible = (
  db: Database.Database,
): void => {
  const table = db.prepare(`SELECT sql
    FROM sqlite_master
    WHERE type='table' AND name='os_command_receipts'`).get() as
    { sql: string | null } | undefined
  const columns = db.prepare(`SELECT name, type, "notnull" AS required, pk
    FROM pragma_table_info('os_command_receipts')
    ORDER BY cid`).all() as Array<{
      name: string
      type: string
      required: number
      pk: number
    }>
  const objects = db.prepare(`SELECT type, name, sql
    FROM sqlite_master
    WHERE tbl_name='os_command_receipts'
      AND type IN ('index','trigger')
      AND sql IS NOT NULL
    ORDER BY type, name`).all() as Array<{
      type: string
      name: string
      sql: string | null
    }>
  const columnsMatch = columns.length === COMMAND_RECEIPT_COLUMNS.length
    && columns.every((column, index) => {
      const expected = COMMAND_RECEIPT_COLUMNS[index]
      return expected !== undefined
        && column.name === expected[0]
        && column.type.toUpperCase() === expected[1]
        && column.required === expected[2]
        && column.pk === expected[3]
    })
  const objectsMatch = objects.length === COMMAND_RECEIPT_OBJECTS.length
    && objects.every((object, index) => {
      const expected = COMMAND_RECEIPT_OBJECTS[index]
      return expected !== undefined
        && object.type === expected.type
        && object.name === expected.name
        && normalizedObjectSql(object.sql ?? '') === normalizedObjectSql(expected.sql)
    })
  const domainTables = new Set(
    (db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN (
        'workspaces','checkpoints','policies','delivery_reports','jobs'
      )`).all() as Array<{ name: string }>).map((row) => row.name),
  )
  const hasEveryDomainTable = [
    'workspaces',
    'checkpoints',
    'policies',
    'delivery_reports',
    'jobs',
  ].every((name) => domainTables.has(name))
  const receiptCount = (db.prepare(`SELECT COUNT(*) AS count
    FROM os_command_receipts`).get() as { count: number }).count
  const invalidRow = hasEveryDomainTable
    ? db.prepare(`SELECT idempotency_key
      FROM os_command_receipts receipt
      WHERE (
        receipt.status='succeeded'
        AND NOT (
        (
          receipt.command='workspace.create'
          AND receipt.scope_id=CAST(receipt.board_id AS TEXT)
          AND EXISTS (
            SELECT 1 FROM workspaces
            WHERE id=receipt.result_id AND board_id=receipt.board_id
          )
        )
        OR (
          receipt.command='checkpoint.create'
          AND receipt.scope_id=(
            SELECT workspace_id FROM checkpoints
            WHERE id=receipt.result_id
          )
          AND EXISTS (
            SELECT 1
            FROM checkpoints checkpoint
            JOIN workspaces workspace ON workspace.id=checkpoint.workspace_id
            WHERE checkpoint.id=receipt.result_id
              AND workspace.board_id=receipt.board_id
          )
        )
        OR (
          receipt.command='policy.create'
          AND receipt.scope_id=CAST(receipt.board_id AS TEXT)
          AND EXISTS (
            SELECT 1 FROM policies
            WHERE id=receipt.result_id AND board_id=receipt.board_id
          )
        )
        OR (
          receipt.command IN ('delivery.submit','delivery.accept')
          AND receipt.scope_id=receipt.result_id
          AND EXISTS (
            SELECT 1 FROM delivery_reports
            WHERE id=receipt.result_id AND board_id=receipt.board_id
          )
        )
        OR (
          receipt.command='job.cancel'
          AND receipt.scope_id=receipt.result_id
          AND EXISTS (
            SELECT 1 FROM jobs
            WHERE id=receipt.result_id AND board_id=receipt.board_id
          )
        )
        )
      )
      LIMIT 1`).get()
    : receiptCount > 0
  if (!table
    || normalizedObjectSql(table.sql ?? '') !== normalizedObjectSql(COMMAND_RECEIPT_TABLE_SQL)
    || !columnsMatch
    || !objectsMatch
    || invalidRow) {
    throw new Error(
      'migration 021-command-idempotency-coverage found an incompatible command receipt schema',
    )
  }
}
const MALFORMED_TRANSCRIPT_TOMBSTONE = `${JSON.stringify({
  redacted: true,
  reason: 'malformed_legacy_transcript',
}, null, 2)}\n`

const replaceEventHashes = (
  value: unknown,
  eventHashes: Map<string, string>,
): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const document = value as Record<string, unknown>
  let changed = false
  if (Array.isArray(document.events)) {
    for (const item of document.events) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const event = item as Record<string, unknown>
      if (typeof event.id !== 'string') continue
      const contentHash = eventHashes.get(event.id)
      if (contentHash && event.content_hash !== contentHash) {
        event.content_hash = contentHash
        changed = true
      }
    }
  }
  if (document.provenance && typeof document.provenance === 'object'
    && !Array.isArray(document.provenance)) {
    const provenance = document.provenance as Record<string, unknown>
    const eventIds = provenance.event_ids
    const sourceContentHashes = provenance.source_content_hashes
    if (Array.isArray(eventIds) && Array.isArray(sourceContentHashes)) {
      const next = sourceContentHashes.map((hash, index) => {
        const eventId = eventIds[index]
        const contentHash = typeof eventId === 'string' ? eventHashes.get(eventId) : undefined
        if (contentHash && hash !== contentHash) {
          changed = true
          return contentHash
        }
        return hash
      })
      provenance.source_content_hashes = next
    }
  }
  return changed
}

const repairTranscriptContent = (
  content: string,
  format: string,
  eventHashes: Map<string, string>,
): { content: string; redactions: number } => {
  if (format === 'json') {
    try {
      const parsed = JSON.parse(content) as unknown
      const hashesChanged = replaceEventHashes(parsed, eventHashes)
      const redacted = redactStructuredValue(parsed)
      if (!hashesChanged && !redacted.changed) {
        return { content, redactions: 0 }
      }
      if (redacted.value && typeof redacted.value === 'object'
        && !Array.isArray(redacted.value)) {
        const document = redacted.value as Record<string, unknown>
        if (document.redaction_policy && typeof document.redaction_policy === 'object'
          && !Array.isArray(document.redaction_policy)
          && redacted.redactions > 0) {
          const policy = document.redaction_policy as Record<string, unknown>
          const prior = Number(policy.redactions_applied)
          policy.redactions_applied = (Number.isSafeInteger(prior) && prior >= 0 ? prior : 0)
            + redacted.redactions
        }
      }
      return {
        content: `${JSON.stringify(redacted.value, null, 2)}\n`,
        redactions: redacted.redactions,
      }
    } catch {
      return { content: MALFORMED_TRANSCRIPT_TOMBSTONE, redactions: 1 }
    }
  }
  const withCurrentHashes = content.replace(
    /^event=(\S+)([^\r\n]*\shash=)([a-f0-9]{64})(?=\s*$)/gim,
    (line, eventId: string | undefined, suffix: string | undefined) => {
      const contentHash = eventId ? eventHashes.get(eventId) : undefined
      return contentHash ? `event=${eventId}${suffix ?? ' hash='}${contentHash}` : line
    },
  )
  const redacted = redactSensitiveText(withCurrentHashes)
  return {
    content: redacted.value ?? '',
    redactions: redacted.redactions,
  }
}

const migrations: Migration[] = [
  {
    id: '001-agent-os-kernel',
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id),
          card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          root_path TEXT NOT NULL,
          worktree_path TEXT,
          branch TEXT,
          base_ref TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          env_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
          provider TEXT NOT NULL,
          external_id TEXT,
          model TEXT,
          status TEXT NOT NULL DEFAULT 'starting',
          context_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS processes (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          command TEXT NOT NULL,
          cwd TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'starting',
          pid INTEGER,
          exit_code INTEGER,
          cols INTEGER NOT NULL DEFAULT 80,
          rows INTEGER NOT NULL DEFAULT 24,
          restartable INTEGER NOT NULL DEFAULT 0,
          started_at TEXT,
          ended_at TEXT
        );

        CREATE TABLE IF NOT EXISTS process_output (
          id INTEGER PRIMARY KEY,
          process_id TEXT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          stream TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(process_id, seq)
        );

        CREATE TABLE IF NOT EXISTS os_events (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL,
          workspace_id TEXT,
          card_id INTEGER,
          session_id TEXT,
          process_id TEXT,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL,
          workspace_id TEXT,
          card_id INTEGER,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
          path TEXT,
          content TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS policies (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id),
          name TEXT NOT NULL,
          file_globs TEXT NOT NULL DEFAULT '[]',
          command_globs TEXT NOT NULL DEFAULT '[]',
          network_hosts TEXT NOT NULL DEFAULT '[]',
          secret_names TEXT NOT NULL DEFAULT '[]',
          approval_scope TEXT NOT NULL DEFAULT 'advisory',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS task_contracts (
          card_id INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
          objective TEXT NOT NULL,
          acceptance_criteria TEXT NOT NULL DEFAULT '[]',
          dependencies TEXT NOT NULL DEFAULT '[]',
          base_ref TEXT,
          verify_commands TEXT NOT NULL DEFAULT '[]',
          budget_tokens INTEGER,
          budget_cents INTEGER,
          priority INTEGER NOT NULL DEFAULT 0,
          policy_id TEXT REFERENCES policies(id) ON DELETE SET NULL,
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS attention_items (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL,
          workspace_id TEXT,
          card_id INTEGER,
          agent_id INTEGER,
          kind TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'medium',
          title TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          session_id TEXT,
          name TEXT NOT NULL,
          git_head TEXT NOT NULL,
          patch_artifact_id TEXT REFERENCES artifacts(id),
          context_json TEXT NOT NULL DEFAULT '{}',
          process_recipes TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL,
          card_id INTEGER,
          workspace_id TEXT,
          provider TEXT NOT NULL,
          model TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 1,
          budget_tokens INTEGER,
          budget_cents INTEGER,
          scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          finished_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS context_items (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL,
          workspace_id TEXT,
          card_id INTEGER,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          content TEXT NOT NULL,
          tokens INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0,
          provenance TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_workspaces_board ON workspaces(board_id, status);
        CREATE INDEX IF NOT EXISTS idx_workspaces_card ON workspaces(card_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON agent_sessions(workspace_id, status);
        CREATE INDEX IF NOT EXISTS idx_processes_workspace ON processes(workspace_id, status);
        CREATE INDEX IF NOT EXISTS idx_process_output_cursor ON process_output(process_id, seq);
        CREATE INDEX IF NOT EXISTS idx_os_events_board ON os_events(board_id, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_os_events_workspace ON os_events(workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_os_events_card ON os_events(card_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_artifacts_card ON artifacts(card_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_artifacts_workspace ON artifacts(workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_attention_board ON attention_items(board_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_checkpoints_workspace ON checkpoints(workspace_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(status, priority, scheduled_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_board ON jobs(board_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_context_workspace ON context_items(workspace_id, pinned, updated_at);
      `)
    },
  },
  {
    id: '002-runtime-hardening',
    apply(db) {
      db.exec(`
        ALTER TABLE processes ADD COLUMN recipe_json TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE jobs ADD COLUMN spent_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE jobs ADD COLUMN spent_cents INTEGER NOT NULL DEFAULT 0;

        CREATE TABLE daemon_leases (
          name TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          acquired_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL
        );

        CREATE TRIGGER jobs_one_active_card_insert
        BEFORE INSERT ON jobs
        WHEN NEW.card_id IS NOT NULL AND NEW.status IN ('queued', 'running', 'cancelling')
        BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM jobs
            WHERE card_id = NEW.card_id AND status IN ('queued', 'running', 'cancelling')
          ) THEN RAISE(ABORT, 'card already has an active job') END;
        END;

        CREATE TRIGGER jobs_one_active_card_update
        BEFORE UPDATE OF card_id, status ON jobs
        WHEN NEW.card_id IS NOT NULL AND NEW.status IN ('queued', 'running', 'cancelling')
        BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM jobs
            WHERE card_id = NEW.card_id AND id != NEW.id AND status IN ('queued', 'running', 'cancelling')
          ) THEN RAISE(ABORT, 'card already has an active job') END;
        END;

        CREATE TRIGGER workspaces_unique_active_worktree_insert
        BEFORE INSERT ON workspaces
        WHEN NEW.kind = 'worktree' AND NEW.status = 'active'
        BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM workspaces
            WHERE kind = 'worktree' AND status = 'active'
              AND (worktree_path = NEW.worktree_path OR (root_path = NEW.root_path AND branch = NEW.branch))
          ) THEN RAISE(ABORT, 'active worktree path or branch already belongs to a workspace') END;
        END;

        CREATE TRIGGER workspaces_unique_active_worktree_update
        BEFORE UPDATE OF worktree_path, root_path, branch, kind, status ON workspaces
        WHEN NEW.kind = 'worktree' AND NEW.status = 'active'
        BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM workspaces
            WHERE id != NEW.id AND kind = 'worktree' AND status = 'active'
              AND (worktree_path = NEW.worktree_path OR (root_path = NEW.root_path AND branch = NEW.branch))
          ) THEN RAISE(ABORT, 'active worktree path or branch already belongs to a workspace') END;
        END;
      `)
    },
  },
  {
    id: '003-provider-session-ownership',
    apply(db) {
      db.exec(`
        UPDATE agent_sessions AS session
          SET status='failed', updated_at=datetime('now')
          WHERE session.status='running' AND session.external_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM agent_sessions newer
              WHERE newer.provider=session.provider
                AND newer.external_id=session.external_id
                AND newer.status='running'
                AND (newer.updated_at > session.updated_at
                  OR (newer.updated_at = session.updated_at AND newer.rowid > session.rowid))
            );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_provider_external
          ON agent_sessions(provider, external_id)
          WHERE external_id IS NOT NULL AND status='running';
      `)
    },
  },
  {
    id: '004-delivery-trackbook',
    apply(db) {
      db.exec(`
        ALTER TABLE task_contracts ADD COLUMN deliverables TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE task_contracts ADD COLUMN non_goals TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE task_contracts ADD COLUMN risks TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE task_contracts ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0);

        CREATE TRIGGER task_contract_version_monotonic
        BEFORE UPDATE OF version ON task_contracts
        WHEN NEW.version < OLD.version
        BEGIN
          SELECT RAISE(ABORT, 'task contract version must increase monotonically');
        END;

        CREATE TABLE delivery_reports (
          id TEXT PRIMARY KEY,
          lineage_id TEXT NOT NULL,
          parent_report_id TEXT REFERENCES delivery_reports(id) ON DELETE RESTRICT,
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
          card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK(status IN ('draft','submitted','verified','accepted','rejected')),
          asked_snapshot TEXT NOT NULL CHECK(json_valid(asked_snapshot)),
          summary TEXT NOT NULL DEFAULT '',
          delivered_items TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(delivered_items)),
          claims_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(claims_json)),
          changed_files TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(changed_files)),
          commits TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(commits)),
          artifact_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(artifact_ids)),
          gaps TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(gaps)),
          created_by TEXT NOT NULL,
          submitted_by TEXT,
          verified_by TEXT,
          accepted_by TEXT,
          rejected_by TEXT,
          acceptance_note TEXT,
          rejection_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          submitted_at TEXT,
          verified_at TEXT,
          accepted_at TEXT,
          rejected_at TEXT,
          CHECK((parent_report_id IS NULL AND sequence=1)
            OR (parent_report_id IS NOT NULL AND sequence>1))
        );

        CREATE TABLE delivery_deliverable_results (
          report_id TEXT NOT NULL REFERENCES delivery_reports(id) ON DELETE CASCADE,
          deliverable_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('met','partial','missed','unverifiable')),
          note TEXT,
          evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs)),
          override_actor TEXT,
          override_reason TEXT,
          override_at TEXT,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(report_id, deliverable_id),
          CHECK((override_actor IS NULL AND override_reason IS NULL AND override_at IS NULL)
            OR (override_actor IS NOT NULL AND override_reason IS NOT NULL AND override_at IS NOT NULL))
        );

        CREATE TABLE delivery_criterion_results (
          report_id TEXT NOT NULL REFERENCES delivery_reports(id) ON DELETE CASCADE,
          criterion_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('met','partial','missed','unverifiable')),
          note TEXT,
          evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs)),
          override_actor TEXT,
          override_reason TEXT,
          override_at TEXT,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(report_id, criterion_id),
          CHECK((override_actor IS NULL AND override_reason IS NULL AND override_at IS NULL)
            OR (override_actor IS NOT NULL AND override_reason IS NOT NULL AND override_at IS NOT NULL))
        );

        CREATE UNIQUE INDEX idx_delivery_reports_lineage_sequence
          ON delivery_reports(lineage_id, sequence);
        CREATE UNIQUE INDEX idx_delivery_reports_parent_revision
          ON delivery_reports(parent_report_id) WHERE parent_report_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_delivery_reports_job_root
          ON delivery_reports(job_id) WHERE job_id IS NOT NULL AND parent_report_id IS NULL;
        CREATE INDEX idx_delivery_reports_card
          ON delivery_reports(card_id, created_at, sequence);
        CREATE INDEX idx_delivery_reports_status
          ON delivery_reports(board_id, status, updated_at);

        CREATE TRIGGER delivery_reports_asked_immutable
        BEFORE UPDATE OF asked_snapshot, lineage_id, parent_report_id, sequence, board_id, card_id, job_id
          ON delivery_reports
        WHEN NEW.asked_snapshot IS NOT OLD.asked_snapshot
          OR NEW.lineage_id IS NOT OLD.lineage_id
          OR NEW.parent_report_id IS NOT OLD.parent_report_id
          OR NEW.sequence IS NOT OLD.sequence
          OR NEW.board_id IS NOT OLD.board_id
          OR NEW.card_id IS NOT OLD.card_id
          OR NEW.job_id IS NOT OLD.job_id
        BEGIN
          SELECT RAISE(ABORT, 'delivery asked snapshot and lineage are immutable');
        END;

        CREATE TRIGGER delivery_reports_status_transition
        BEFORE UPDATE OF status ON delivery_reports
        WHEN NEW.status != OLD.status AND NOT (
          (OLD.status='draft' AND NEW.status='submitted')
          OR (OLD.status='submitted' AND NEW.status='verified')
          OR (OLD.status='submitted' AND NEW.status='rejected')
          OR (OLD.status='verified' AND NEW.status IN ('accepted','rejected'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid delivery status transition');
        END;
      `)
    },
  },
  {
    id: '005-delivery-report-revision-cascade',
    apply(db) {
      const currentParentForeignKey = (db.prepare(
        "PRAGMA foreign_key_list('delivery_reports')",
      ).all() as Array<{ from: string; table: string; on_delete: string }>).find(
        (row) => row.from === 'parent_report_id',
      )
      // A removed marker must not rebuild the already-current report table underneath
      // later append-only shipment/autoship triggers. Re-recording the marker is enough.
      if (currentParentForeignKey?.table === 'delivery_reports'
        && currentParentForeignKey.on_delete === 'CASCADE') return
      const reinstallAutoshipIntentSchema = !!db.prepare(`SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='delivery_autoship_intents'`).get()
      if (reinstallAutoshipIntentSchema) {
        const intentCount = (db.prepare(`SELECT COUNT(*) AS count
          FROM delivery_autoship_intents`).get() as { count: number }).count
        if (intentCount > 0) {
          throw new Error('cannot replay delivery revision migration with durable autoship intents')
        }
        db.exec('DROP TRIGGER IF EXISTS delivery_autoship_intents_scope')
      }
      db.exec(`
        CREATE TABLE delivery_reports_v5 (
          id TEXT PRIMARY KEY,
          lineage_id TEXT NOT NULL,
          parent_report_id TEXT REFERENCES delivery_reports_v5(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK(status IN ('draft','submitted','verified','accepted','rejected')),
          asked_snapshot TEXT NOT NULL CHECK(json_valid(asked_snapshot)),
          summary TEXT NOT NULL DEFAULT '',
          delivered_items TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(delivered_items)),
          claims_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(claims_json)),
          changed_files TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(changed_files)),
          commits TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(commits)),
          artifact_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(artifact_ids)),
          gaps TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(gaps)),
          created_by TEXT NOT NULL,
          submitted_by TEXT,
          verified_by TEXT,
          accepted_by TEXT,
          rejected_by TEXT,
          acceptance_note TEXT,
          rejection_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          submitted_at TEXT,
          verified_at TEXT,
          accepted_at TEXT,
          rejected_at TEXT,
          CHECK((parent_report_id IS NULL AND sequence=1)
            OR (parent_report_id IS NOT NULL AND sequence>1))
        );

        CREATE TABLE delivery_deliverable_results_v5 (
          report_id TEXT NOT NULL REFERENCES delivery_reports_v5(id) ON DELETE CASCADE,
          deliverable_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('met','partial','missed','unverifiable')),
          note TEXT,
          evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs)),
          override_actor TEXT,
          override_reason TEXT,
          override_at TEXT,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(report_id, deliverable_id),
          CHECK((override_actor IS NULL AND override_reason IS NULL AND override_at IS NULL)
            OR (override_actor IS NOT NULL AND override_reason IS NOT NULL AND override_at IS NOT NULL))
        );

        CREATE TABLE delivery_criterion_results_v5 (
          report_id TEXT NOT NULL REFERENCES delivery_reports_v5(id) ON DELETE CASCADE,
          criterion_id TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK(outcome IN ('met','partial','missed','unverifiable')),
          note TEXT,
          evidence_refs TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_refs)),
          override_actor TEXT,
          override_reason TEXT,
          override_at TEXT,
          actor TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(report_id, criterion_id),
          CHECK((override_actor IS NULL AND override_reason IS NULL AND override_at IS NULL)
            OR (override_actor IS NOT NULL AND override_reason IS NOT NULL AND override_at IS NOT NULL))
        );

        INSERT INTO delivery_reports_v5
          (id, lineage_id, parent_report_id, sequence, board_id, card_id, job_id, session_id, workspace_id,
           status, asked_snapshot, summary, delivered_items, claims_json, changed_files, commits, artifact_ids,
           gaps, created_by, submitted_by, verified_by, accepted_by, rejected_by, acceptance_note,
           rejection_reason, created_at, updated_at, submitted_at, verified_at, accepted_at, rejected_at)
        SELECT id, lineage_id, parent_report_id, sequence, board_id, card_id, job_id, session_id, workspace_id,
          status, asked_snapshot, summary, delivered_items, claims_json, changed_files, commits, artifact_ids,
          gaps, created_by, submitted_by, verified_by, accepted_by, rejected_by, acceptance_note,
          rejection_reason, created_at, updated_at, submitted_at, verified_at, accepted_at, rejected_at
        FROM delivery_reports ORDER BY sequence, rowid;

        INSERT INTO delivery_deliverable_results_v5
          (report_id, deliverable_id, outcome, note, evidence_refs, override_actor, override_reason, override_at,
           actor, created_at, updated_at)
        SELECT report_id, deliverable_id, outcome, note, evidence_refs, override_actor, override_reason,
          override_at, actor, created_at, updated_at FROM delivery_deliverable_results;

        INSERT INTO delivery_criterion_results_v5
          (report_id, criterion_id, outcome, note, evidence_refs, override_actor, override_reason, override_at,
           actor, created_at, updated_at)
        SELECT report_id, criterion_id, outcome, note, evidence_refs, override_actor, override_reason,
          override_at, actor, created_at, updated_at FROM delivery_criterion_results;
      `)

      const deleteLeaves = db.prepare(`DELETE FROM delivery_reports
        WHERE NOT EXISTS (SELECT 1 FROM delivery_reports child WHERE child.parent_report_id=delivery_reports.id)`)
      while (deleteLeaves.run().changes > 0) { /* remove deepest revisions before RESTRICT parents */ }
      const remaining = (db.prepare('SELECT COUNT(*) AS count FROM delivery_reports').get() as { count: number }).count
      if (remaining) throw new Error('delivery report revision lineage contains a cycle')

      db.exec(`
        DROP TABLE delivery_deliverable_results;
        DROP TABLE delivery_criterion_results;
        DROP TABLE delivery_reports;
        ALTER TABLE delivery_reports_v5 RENAME TO delivery_reports;
        ALTER TABLE delivery_deliverable_results_v5 RENAME TO delivery_deliverable_results;
        ALTER TABLE delivery_criterion_results_v5 RENAME TO delivery_criterion_results;

        CREATE UNIQUE INDEX idx_delivery_reports_lineage_sequence
          ON delivery_reports(lineage_id, sequence);
        CREATE UNIQUE INDEX idx_delivery_reports_parent_revision
          ON delivery_reports(parent_report_id) WHERE parent_report_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_delivery_reports_job_root
          ON delivery_reports(job_id) WHERE job_id IS NOT NULL AND parent_report_id IS NULL;
        CREATE INDEX idx_delivery_reports_card
          ON delivery_reports(card_id, created_at, sequence);
        CREATE INDEX idx_delivery_reports_status
          ON delivery_reports(board_id, status, updated_at);

        CREATE TRIGGER delivery_reports_asked_immutable
        BEFORE UPDATE OF asked_snapshot, lineage_id, parent_report_id, sequence, board_id, card_id, job_id
          ON delivery_reports
        WHEN NEW.asked_snapshot IS NOT OLD.asked_snapshot
          OR NEW.lineage_id IS NOT OLD.lineage_id
          OR NEW.parent_report_id IS NOT OLD.parent_report_id
          OR NEW.sequence IS NOT OLD.sequence
          OR NEW.board_id IS NOT OLD.board_id
          OR NEW.card_id IS NOT OLD.card_id
          OR NEW.job_id IS NOT OLD.job_id
        BEGIN
          SELECT RAISE(ABORT, 'delivery asked snapshot and lineage are immutable');
        END;

        CREATE TRIGGER delivery_reports_status_transition
        BEFORE UPDATE OF status ON delivery_reports
        WHEN NEW.status != OLD.status AND NOT (
          (OLD.status='draft' AND NEW.status='submitted')
          OR (OLD.status='submitted' AND NEW.status='verified')
          OR (OLD.status='submitted' AND NEW.status='rejected')
          OR (OLD.status='verified' AND NEW.status IN ('accepted','rejected'))
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid delivery status transition');
        END;
      `)
      if (reinstallAutoshipIntentSchema) installDeliveryAutoshipIntentSchema(db)
    },
  },
  {
    id: '006-canonical-launch-reservations',
    apply(db) {
      db.exec(`
        ALTER TABLE jobs ADD COLUMN driver_id TEXT;
        ALTER TABLE jobs ADD COLUMN effort TEXT;
        ALTER TABLE jobs ADD COLUMN access_profile TEXT NOT NULL DEFAULT 'workspace_write';
        ALTER TABLE jobs ADD COLUMN policy_id TEXT REFERENCES policies(id) ON DELETE SET NULL;
        ALTER TABLE jobs ADD COLUMN contract_version INTEGER;
        ALTER TABLE jobs ADD COLUMN idempotency_key TEXT;
        ALTER TABLE jobs ADD COLUMN request_fingerprint TEXT;

        UPDATE jobs SET driver_id=provider WHERE driver_id IS NULL;

        CREATE UNIQUE INDEX idx_jobs_board_idempotency
          ON jobs(board_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

        CREATE TABLE workspace_assignments (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
          job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'reserved'
            CHECK(status IN ('reserved','active','released','failed')),
          isolation_mode TEXT NOT NULL
            CHECK(isolation_mode IN ('managed_worktree','explicit_worktree','explicit_shared')),
          access_profile TEXT NOT NULL
            CHECK(access_profile IN ('read_only','workspace_write','full_access')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          released_at TEXT
        );

        CREATE INDEX idx_workspace_assignments_workspace
          ON workspace_assignments(workspace_id, status, created_at);
        CREATE INDEX idx_workspace_assignments_board
          ON workspace_assignments(board_id, status, created_at);

        ALTER TABLE os_events ADD COLUMN job_id TEXT;
        ALTER TABLE os_events ADD COLUMN contract_id TEXT;
        ALTER TABLE os_events ADD COLUMN correlation_id TEXT;
        ALTER TABLE os_events ADD COLUMN causation_id TEXT;
        ALTER TABLE os_events ADD COLUMN idempotency_key TEXT;
        ALTER TABLE os_events ADD COLUMN event_version INTEGER NOT NULL DEFAULT 1;

        CREATE UNIQUE INDEX idx_os_events_board_idempotency
          ON os_events(board_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX idx_os_events_job ON os_events(job_id, created_at, id);
        CREATE INDEX idx_os_events_correlation ON os_events(correlation_id, created_at, id);
      `)
    },
  },
  {
    id: '007-agent-home-domain',
    apply(db) {
      db.exec(`
        CREATE TABLE agent_profiles (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          legacy_agent_id INTEGER UNIQUE REFERENCES agents(id) ON DELETE SET NULL,
          name TEXT NOT NULL,
          role TEXT,
          default_provider TEXT,
          default_model TEXT,
          default_effort TEXT,
          default_access_profile TEXT
            CHECK(default_access_profile IS NULL
              OR default_access_profile IN ('read_only','workspace_write','full_access')),
          capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(capabilities_json)),
          owner_actor_type TEXT NOT NULL,
          owner_actor_id TEXT,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active','archived')),
          provenance_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(provenance_json)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          UNIQUE(board_id, name)
        );

        CREATE TABLE agent_conversations (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active','archived')),
          is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
          next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence > 0),
          created_by_actor_type TEXT NOT NULL,
          created_by_actor_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT
        );

        CREATE UNIQUE INDEX idx_agent_conversations_default
          ON agent_conversations(profile_id)
          WHERE is_default=1 AND status='active';
        CREATE INDEX idx_agent_profiles_board
          ON agent_profiles(board_id, status, name);
        CREATE INDEX idx_agent_conversations_profile
          ON agent_conversations(profile_id, status, updated_at);

        ALTER TABLE agent_sessions
          ADD COLUMN profile_id TEXT REFERENCES agent_profiles(id) ON DELETE SET NULL;
        ALTER TABLE agent_sessions
          ADD COLUMN conversation_id TEXT REFERENCES agent_conversations(id) ON DELETE SET NULL;
        ALTER TABLE agent_sessions
          ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
        ALTER TABLE agent_sessions
          ADD COLUMN mode TEXT NOT NULL DEFAULT 'compatibility'
            CHECK(mode IN ('managed','ambient','compatibility'));
        ALTER TABLE agent_sessions ADD COLUMN driver_id TEXT;
        ALTER TABLE agent_sessions ADD COLUMN effort TEXT;
        ALTER TABLE agent_sessions
          ADD COLUMN access_profile TEXT
            CHECK(access_profile IS NULL
              OR access_profile IN ('read_only','workspace_write','full_access'));
        ALTER TABLE agent_sessions ADD COLUMN provider_thread_id TEXT;
        ALTER TABLE agent_sessions ADD COLUMN provider_cursor TEXT;
        ALTER TABLE agent_sessions
          ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'unknown'
            CHECK(recovery_state IN ('unknown','attachable','detached','lost','unsupported'));
        ALTER TABLE agent_sessions
          ADD COLUMN recovery_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(recovery_json));
        ALTER TABLE agent_sessions
          ADD COLUMN history_state TEXT NOT NULL DEFAULT 'unavailable'
            CHECK(history_state IN ('complete','partial','unavailable'));
        ALTER TABLE agent_sessions ADD COLUMN started_at TEXT;
        ALTER TABLE agent_sessions ADD COLUMN ended_at TEXT;
        ALTER TABLE agent_sessions ADD COLUMN archived_at TEXT;

        CREATE INDEX idx_agent_sessions_profile ON agent_sessions(profile_id);
        CREATE INDEX idx_agent_sessions_conversation ON agent_sessions(conversation_id);
        CREATE INDEX idx_agent_sessions_job ON agent_sessions(job_id);

        CREATE TABLE conversation_events (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          provider TEXT,
          provider_event_id TEXT,
          provider_thread_id TEXT,
          provider_turn_id TEXT,
          provider_item_id TEXT,
          provider_cursor TEXT,
          kind TEXT NOT NULL
            CHECK(kind IN ('user','assistant','system','tool','tool_result',
              'approval','usage','status','error')),
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          correlation_id TEXT,
          causation_id TEXT,
          projected_text TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
          raw_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
          dedupe_key TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          redaction_state TEXT NOT NULL DEFAULT 'none'
            CHECK(redaction_state IN ('none','redacted','withheld')),
          retention_class TEXT NOT NULL DEFAULT 'transcript'
            CHECK(retention_class IN ('transcript','audit','ephemeral','pinned')),
          schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version > 0),
          created_at TEXT NOT NULL,
          archived_at TEXT,
          UNIQUE(conversation_id, sequence),
          UNIQUE(conversation_id, dedupe_key)
        );

        CREATE TABLE conversation_event_conflicts (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          canonical_event_id TEXT NOT NULL REFERENCES conversation_events(id) ON DELETE CASCADE,
          dedupe_key TEXT NOT NULL,
          received_content_hash TEXT NOT NULL,
          received_projected_text TEXT,
          received_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(received_metadata_json)),
          raw_artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(canonical_event_id, received_content_hash)
        );

        CREATE INDEX idx_conversation_events_conversation
          ON conversation_events(conversation_id, sequence);
        CREATE INDEX idx_conversation_events_session
          ON conversation_events(session_id, sequence);
        CREATE INDEX idx_conversation_events_profile
          ON conversation_events(profile_id, created_at);
        CREATE INDEX idx_conversation_events_provider
          ON conversation_events(session_id, provider, provider_event_id)
          WHERE provider_event_id IS NOT NULL;
        CREATE INDEX idx_conversation_event_conflicts_event
          ON conversation_event_conflicts(canonical_event_id, created_at);

        CREATE TRIGGER agent_conversations_profile_scope_insert
        BEFORE INSERT ON agent_conversations
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM agent_profiles profile
            WHERE profile.id=NEW.profile_id AND profile.board_id=NEW.board_id
          ) THEN RAISE(ABORT, 'conversation profile belongs to a different board') END;
        END;

        CREATE TRIGGER agent_conversations_profile_scope_update
        BEFORE UPDATE OF board_id, profile_id ON agent_conversations
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM agent_profiles profile
            WHERE profile.id=NEW.profile_id AND profile.board_id=NEW.board_id
          ) THEN RAISE(ABORT, 'conversation profile belongs to a different board') END;
        END;

        CREATE TRIGGER agent_sessions_home_scope_insert
        BEFORE INSERT ON agent_sessions
        WHEN NEW.profile_id IS NOT NULL OR NEW.conversation_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NEW.profile_id IS NULL OR NEW.conversation_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM agent_conversations conversation
              JOIN agent_profiles profile ON profile.id=conversation.profile_id
              JOIN workspaces workspace ON workspace.id=NEW.workspace_id
              WHERE conversation.id=NEW.conversation_id
                AND profile.id=NEW.profile_id
                AND profile.board_id=workspace.board_id
            )
          THEN RAISE(ABORT, 'session Agent Home scope is inconsistent') END;
        END;

        CREATE TRIGGER agent_sessions_home_scope_update
        BEFORE UPDATE OF workspace_id, profile_id, conversation_id ON agent_sessions
        WHEN NEW.profile_id IS NOT NULL OR NEW.conversation_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NEW.profile_id IS NULL OR NEW.conversation_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM agent_conversations conversation
              JOIN agent_profiles profile ON profile.id=conversation.profile_id
              JOIN workspaces workspace ON workspace.id=NEW.workspace_id
              WHERE conversation.id=NEW.conversation_id
                AND profile.id=NEW.profile_id
                AND profile.board_id=workspace.board_id
            )
          THEN RAISE(ABORT, 'session Agent Home scope is inconsistent') END;
        END;

        CREATE TRIGGER agent_sessions_job_scope_insert
        BEFORE INSERT ON agent_sessions
        WHEN NEW.job_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM jobs job
            JOIN workspaces workspace ON workspace.id=NEW.workspace_id
            WHERE job.id=NEW.job_id
              AND job.board_id=workspace.board_id
              AND (job.workspace_id IS NULL OR job.workspace_id=NEW.workspace_id)
          ) THEN RAISE(ABORT, 'session job belongs to a different board or workspace') END;
        END;

        CREATE TRIGGER agent_sessions_job_scope_update
        BEFORE UPDATE OF workspace_id, job_id ON agent_sessions
        WHEN NEW.job_id IS NOT NULL
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM jobs job
            JOIN workspaces workspace ON workspace.id=NEW.workspace_id
            WHERE job.id=NEW.job_id
              AND job.board_id=workspace.board_id
              AND (job.workspace_id IS NULL OR job.workspace_id=NEW.workspace_id)
          ) THEN RAISE(ABORT, 'session job belongs to a different board or workspace') END;
        END;

        CREATE TRIGGER conversation_events_scope_insert
        BEFORE INSERT ON conversation_events
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM agent_conversations conversation
            JOIN agent_profiles profile ON profile.id=conversation.profile_id
            WHERE conversation.id=NEW.conversation_id
              AND conversation.board_id=NEW.board_id
              AND profile.id=NEW.profile_id
          ) THEN RAISE(ABORT, 'conversation event scope is inconsistent') END;
          SELECT CASE WHEN NEW.session_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM agent_sessions session
            WHERE session.id=NEW.session_id
              AND session.profile_id=NEW.profile_id
              AND session.conversation_id=NEW.conversation_id
          ) THEN RAISE(ABORT, 'conversation event session scope is inconsistent') END;
        END;

        CREATE TRIGGER conversation_event_conflicts_scope_insert
        BEFORE INSERT ON conversation_event_conflicts
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM conversation_events canonical
            WHERE canonical.id=NEW.canonical_event_id
              AND canonical.board_id=NEW.board_id
              AND canonical.profile_id=NEW.profile_id
              AND canonical.conversation_id=NEW.conversation_id
              AND canonical.dedupe_key=NEW.dedupe_key
          ) THEN RAISE(ABORT, 'conversation event conflict scope is inconsistent') END;
          SELECT CASE WHEN NEW.session_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM agent_sessions session
            WHERE session.id=NEW.session_id
              AND session.profile_id=NEW.profile_id
              AND session.conversation_id=NEW.conversation_id
          ) THEN RAISE(ABORT, 'conversation event conflict session scope is inconsistent') END;
        END;
      `)

      const hasArtifacts = !!db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'",
      ).get()
      if (hasArtifacts) {
        db.exec(`
          CREATE TRIGGER conversation_events_artifact_scope_insert
          BEFORE INSERT ON conversation_events
          WHEN NEW.raw_artifact_id IS NOT NULL
          BEGIN
            SELECT CASE WHEN NOT EXISTS (
              SELECT 1 FROM artifacts artifact
              WHERE artifact.id=NEW.raw_artifact_id
                AND artifact.board_id=NEW.board_id
                AND (
                  artifact.workspace_id IS NULL
                  OR EXISTS (
                    SELECT 1 FROM agent_sessions session
                    WHERE session.id=NEW.session_id
                      AND session.workspace_id=artifact.workspace_id
                  )
                )
            ) THEN RAISE(ABORT, 'conversation event artifact scope is inconsistent') END;
          END;

          CREATE TRIGGER conversation_event_conflicts_artifact_scope_insert
          BEFORE INSERT ON conversation_event_conflicts
          WHEN NEW.raw_artifact_id IS NOT NULL
          BEGIN
            SELECT CASE WHEN NOT EXISTS (
              SELECT 1 FROM artifacts artifact
              WHERE artifact.id=NEW.raw_artifact_id
                AND artifact.board_id=NEW.board_id
                AND (
                  artifact.workspace_id IS NULL
                  OR EXISTS (
                    SELECT 1 FROM agent_sessions session
                    WHERE session.id=NEW.session_id
                      AND session.workspace_id=artifact.workspace_id
                  )
                )
            ) THEN RAISE(ABORT, 'conversation event conflict artifact scope is inconsistent') END;
          END;
        `)
      }

      const hasLegacyAgents = !!db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'",
      ).get()
      const sessionColumns = new Set(
        (db.prepare("PRAGMA table_info('agent_sessions')").all() as Array<{ name: string }>)
          .map((column) => column.name),
      )
      if (!hasLegacyAgents || !sessionColumns.has('agent_id')) return

      db.exec(`
        INSERT OR IGNORE INTO agent_profiles (
          id, board_id, legacy_agent_id, name, role, default_provider, default_model,
          default_effort, default_access_profile, capabilities_json, owner_actor_type,
          owner_actor_id, status, provenance_json, created_at, updated_at, archived_at
        )
        SELECT
          'legacy-agent:' || agent.id,
          agent.board_id,
          agent.id,
          agent.name,
          agent.role,
          CASE WHEN trim(coalesce(agent.provider, ''))='' THEN NULL ELSE agent.provider END,
          agent.model,
          agent.effort,
          CASE WHEN agent.access_profile IN ('read_only','workspace_write','full_access')
            THEN agent.access_profile ELSE NULL END,
          '[]',
          'operator',
          NULL,
          'active',
          json_object(
            'source', 'legacy_agents',
            'legacy_kind', coalesce(agent.kind, 'session'),
            'legacy_status', coalesce(agent.status, 'unknown')
          ),
          agent.created_at,
          agent.last_seen,
          NULL
        FROM agents agent;

        INSERT OR IGNORE INTO agent_conversations (
          id, board_id, profile_id, title, status, is_default, next_sequence,
          created_by_actor_type, created_by_actor_id, created_at, updated_at, archived_at
        )
        SELECT
          'legacy-conversation:' || agent.id,
          agent.board_id,
          'legacy-agent:' || agent.id,
          agent.name || ' conversation',
          'active',
          1,
          1,
          'migration',
          '007-agent-home-domain',
          agent.created_at,
          agent.last_seen,
          NULL
        FROM agents agent
        JOIN agent_profiles profile ON profile.id='legacy-agent:' || agent.id;

        UPDATE agent_sessions
        SET profile_id='legacy-agent:' || agent_id,
            conversation_id='legacy-conversation:' || agent_id
        WHERE agent_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM agent_profiles profile
            JOIN workspaces workspace ON workspace.id=agent_sessions.workspace_id
            WHERE profile.id='legacy-agent:' || agent_sessions.agent_id
              AND profile.board_id=workspace.board_id
          );

        UPDATE agent_sessions
        SET status='lost',
            mode='compatibility',
            driver_id=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.driver_id')='text'
              THEN json_extract(context_json, '$.driver_id')
              ELSE coalesce(driver_id, provider)
            END,
            effort=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.effort')='text'
              THEN json_extract(context_json, '$.effort')
              ELSE effort
            END,
            access_profile=CASE
              WHEN json_valid(context_json)
                AND json_extract(context_json, '$.access_profile')
                  IN ('read_only','workspace_write','full_access')
              THEN json_extract(context_json, '$.access_profile')
              ELSE access_profile
            END,
            provider_thread_id=coalesce(provider_thread_id, external_id),
            provider_cursor=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.last_event_seq') IN ('integer','text')
              THEN CAST(json_extract(context_json, '$.last_event_seq') AS TEXT)
              ELSE provider_cursor
            END,
            recovery_state='lost',
            recovery_json=json_object(
              'source', 'legacy_backfill',
              'reason', 'agent_workspace_board_mismatch'
            ),
            history_state='unavailable',
            started_at=coalesce(started_at, created_at),
            ended_at=coalesce(ended_at, updated_at)
        WHERE agent_id IS NOT NULL
          AND profile_id IS NULL
          AND EXISTS (
            SELECT 1 FROM agents agent
            JOIN workspaces workspace ON workspace.id=agent_sessions.workspace_id
            WHERE agent.id=agent_sessions.agent_id
              AND agent.board_id!=workspace.board_id
          );

        UPDATE agent_sessions
        SET job_id=json_extract(context_json, '$.job_id')
        WHERE json_valid(context_json)
          AND json_type(context_json, '$.job_id')='text'
          AND EXISTS (
            SELECT 1 FROM jobs job
            JOIN workspaces workspace ON workspace.id=agent_sessions.workspace_id
            WHERE job.id=json_extract(agent_sessions.context_json, '$.job_id')
              AND job.board_id=workspace.board_id
              AND (job.workspace_id IS NULL OR job.workspace_id=agent_sessions.workspace_id)
          );

        UPDATE agent_sessions
        SET driver_id=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.driver_id')='text'
              THEN json_extract(context_json, '$.driver_id')
              ELSE provider
            END,
            effort=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.effort')='text'
              THEN json_extract(context_json, '$.effort')
              ELSE effort
            END,
            access_profile=CASE
              WHEN json_valid(context_json)
                AND json_extract(context_json, '$.access_profile')
                  IN ('read_only','workspace_write','full_access')
              THEN json_extract(context_json, '$.access_profile')
              ELSE access_profile
            END,
            provider_thread_id=external_id,
            provider_cursor=CASE
              WHEN json_valid(context_json)
                AND json_type(context_json, '$.last_event_seq') IN ('integer','text')
              THEN CAST(json_extract(context_json, '$.last_event_seq') AS TEXT)
              ELSE NULL
            END,
            mode=CASE
              WHEN job_id IS NOT NULL THEN 'managed'
              WHEN EXISTS (
                SELECT 1 FROM agents agent
                WHERE agent.id=agent_sessions.agent_id AND agent.kind='session'
              ) THEN 'ambient'
              ELSE 'compatibility'
            END,
            recovery_state=CASE
              WHEN status='lost' THEN 'lost'
              WHEN external_id IS NOT NULL THEN 'attachable'
              ELSE 'unknown'
            END,
            recovery_json=json_object('source', 'legacy_backfill'),
            history_state=CASE WHEN EXISTS (
              SELECT 1 FROM os_events event
              WHERE event.session_id=agent_sessions.id AND event.kind LIKE 'driver.%'
            ) THEN 'partial' ELSE 'unavailable' END,
            started_at=created_at,
            ended_at=CASE WHEN status IN ('stopped','failed','lost') THEN updated_at ELSE NULL END
        WHERE profile_id IS NOT NULL AND conversation_id IS NOT NULL;
      `)
    },
  },
  {
    id: '008-agent-home-controls',
    apply(db) {
      db.exec(`
        ALTER TABLE agent_sessions ADD COLUMN display_name TEXT;
        ALTER TABLE agent_sessions ADD COLUMN parent_session_id TEXT
          REFERENCES agent_sessions(id) ON DELETE SET NULL;
        ALTER TABLE agent_sessions ADD COLUMN lineage_type TEXT
          CHECK(lineage_type IS NULL OR lineage_type IN ('resume','retry','fork'));
        ALTER TABLE agent_sessions ADD COLUMN control_state TEXT NOT NULL DEFAULT 'active'
          CHECK(control_state IN ('active','paused','stopped','archived'));
      `)

      const sessionColumns = new Set(
        (db.prepare("PRAGMA table_info('agent_sessions')").all() as Array<{ name: string }>)
          .map((column) => column.name),
      )
      if (sessionColumns.has('archived_at') && sessionColumns.has('status')) {
        db.exec(`
        UPDATE agent_sessions
        SET control_state=CASE
          WHEN archived_at IS NOT NULL THEN 'archived'
          WHEN status IN ('stopped','failed','lost','exited') THEN 'stopped'
          ELSE 'active'
        END;
        `)
      } else if (sessionColumns.has('archived_at')) {
        db.exec(`UPDATE agent_sessions SET control_state=CASE
          WHEN archived_at IS NOT NULL THEN 'archived' ELSE 'active' END;`)
      } else if (sessionColumns.has('status')) {
        db.exec(`UPDATE agent_sessions SET control_state=CASE
          WHEN status IN ('stopped','failed','lost','exited') THEN 'stopped' ELSE 'active' END;`)
      }

      db.exec(`
        CREATE INDEX idx_agent_sessions_parent
          ON agent_sessions(parent_session_id);
        CREATE INDEX idx_agent_sessions_control
          ON agent_sessions(profile_id, control_state);

        CREATE TABLE agent_session_actions (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
          result_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          idempotency_key TEXT NOT NULL,
          action TEXT NOT NULL
            CHECK(action IN ('resume','pause','stop','retry','fork','rename','archive')),
          request_fingerprint TEXT NOT NULL,
          status TEXT NOT NULL
            CHECK(status IN ('pending','succeeded','failed')),
          lease_id TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(board_id, idempotency_key)
        );

        CREATE INDEX idx_agent_session_actions_session
          ON agent_session_actions(session_id, created_at, id);
        CREATE UNIQUE INDEX idx_agent_session_actions_pending
          ON agent_session_actions(session_id) WHERE status='pending';
      `)

      if (sessionColumns.has('status')) {
        db.exec(`
          CREATE TRIGGER agent_sessions_control_state_insert
          AFTER INSERT ON agent_sessions
          WHEN NEW.status IN ('stopped','failed','lost','exited','archived')
          BEGIN
            UPDATE agent_sessions
            SET control_state=CASE WHEN NEW.status='archived' THEN 'archived' ELSE 'stopped' END
            WHERE id=NEW.id;
          END;

          CREATE TRIGGER agent_sessions_control_state_update
          AFTER UPDATE OF status ON agent_sessions
          WHEN NEW.control_state!='archived'
            AND NEW.status IN (
              'reserved','starting','running','stopping',
              'stopped','failed','lost','exited','archived'
            )
          BEGIN
            UPDATE agent_sessions
            SET control_state=CASE
              WHEN NEW.status='archived' THEN 'archived'
              WHEN NEW.status IN ('stopped','failed','lost','exited') THEN 'stopped'
              ELSE 'active'
            END
            WHERE id=NEW.id;
          END;
        `)
      }
    },
  },
  {
    // 008 is intentionally reserved for Agent Home controls in the integration train.
    id: '009-job-market-domain',
    apply(db) {
      const prerequisites = (db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type='table' AND name IN ('cards','task_contracts')`).get() as { count: number }).count
      if (prerequisites !== 2) {
        throw new Error('migration 009-job-market-domain requires cards and task_contracts tables')
      }
      db.exec(`
        CREATE TABLE job_market_contracts (
          card_id INTEGER PRIMARY KEY REFERENCES task_contracts(card_id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'open'
            CHECK(status IN ('draft','open','assigned','running','submitted',
              'accepted','rejected','cancelled','archived')),
          required_capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_capabilities_json)),
          provider_constraints_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(provider_constraints_json)),
          model_constraints_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(model_constraints_json)),
          access_needs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(access_needs_json)),
          budget_time_seconds INTEGER CHECK(budget_time_seconds IS NULL OR budget_time_seconds > 0),
          budget_retries INTEGER CHECK(budget_retries IS NULL OR budget_retries >= 0),
          budget_coordination_tokens INTEGER
            CHECK(budget_coordination_tokens IS NULL OR budget_coordination_tokens > 0),
          budget_coordination_messages INTEGER
            CHECK(budget_coordination_messages IS NULL OR budget_coordination_messages > 0),
          version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
          published_at TEXT,
          archived_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE job_market_criteria (
          card_id INTEGER NOT NULL REFERENCES job_market_contracts(card_id) ON DELETE CASCADE,
          criterion_id TEXT NOT NULL,
          description TEXT NOT NULL,
          verifier_json TEXT NOT NULL CHECK(json_valid(verifier_json)),
          required_artifacts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(required_artifacts_json)),
          priority INTEGER NOT NULL DEFAULT 0,
          owner TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(card_id, criterion_id)
        );

        CREATE TABLE job_market_dependencies (
          card_id INTEGER NOT NULL REFERENCES job_market_contracts(card_id) ON DELETE CASCADE,
          dependency_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          blocking_reason TEXT NOT NULL,
          completion_condition TEXT NOT NULL DEFAULT 'card_done'
            CHECK(completion_condition IN ('card_done')),
          updated_at TEXT NOT NULL,
          PRIMARY KEY(card_id, dependency_card_id),
          CHECK(card_id != dependency_card_id)
        );

        CREATE INDEX idx_job_market_contracts_status
          ON job_market_contracts(status, updated_at, card_id);
        CREATE INDEX idx_job_market_dependencies_target
          ON job_market_dependencies(dependency_card_id, card_id);
        CREATE INDEX idx_job_market_criteria_owner
          ON job_market_criteria(owner, card_id) WHERE owner IS NOT NULL;

        CREATE TRIGGER job_market_dependency_scope_insert
        BEFORE INSERT ON job_market_dependencies
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM cards source
            JOIN cards dependency ON dependency.id=NEW.dependency_card_id
            WHERE source.id=NEW.card_id AND source.board_id=dependency.board_id
          ) THEN RAISE(ABORT, 'job market dependency belongs to a different board') END;
        END;

        CREATE TRIGGER job_market_dependency_scope_update
        BEFORE UPDATE OF card_id, dependency_card_id ON job_market_dependencies
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM cards source
            JOIN cards dependency ON dependency.id=NEW.dependency_card_id
            WHERE source.id=NEW.card_id AND source.board_id=dependency.board_id
          ) THEN RAISE(ABORT, 'job market dependency belongs to a different board') END;
        END;

        INSERT INTO job_market_contracts (
          card_id, status, required_capabilities_json, provider_constraints_json,
          model_constraints_json, access_needs_json, budget_time_seconds, budget_retries,
          budget_coordination_tokens, budget_coordination_messages, version,
          published_at, archived_at, created_at, updated_at
        )
        SELECT card_id, 'open', '[]', '[]', '[]', '[]', NULL, NULL, NULL, NULL, 1,
          updated_at, NULL, updated_at, updated_at
        FROM task_contracts;
      `)
    },
  },
  {
    id: '010-agent-home-projected-text-redaction',
    apply(db) {
      const rows = db.prepare(`SELECT
          id, provider, provider_event_id, provider_thread_id, provider_turn_id,
          provider_item_id, provider_cursor, kind, actor_type, actor_id,
          correlation_id, causation_id, projected_text, metadata_json,
          raw_artifact_id, dedupe_key, redaction_state, retention_class, schema_version
        FROM conversation_events`).all() as Array<{
          id: string
          provider: string | null
          provider_event_id: string | null
          provider_thread_id: string | null
          provider_turn_id: string | null
          provider_item_id: string | null
          provider_cursor: string | null
          kind: string
          actor_type: string
          actor_id: string | null
          correlation_id: string | null
          causation_id: string | null
          projected_text: string | null
          metadata_json: string
          raw_artifact_id: string | null
          dedupe_key: string
          redaction_state: ProjectedTextRedactionState
          retention_class: string
          schema_version: number
        }>
      const update = db.prepare(`UPDATE conversation_events
        SET projected_text=?, redaction_state=?, content_hash=? WHERE id=?`)
      const updateAuditHash = db.prepare(`UPDATE os_events
        SET payload=json_set(
          payload,
          '$.content_hash', ?,
          '$.request_fingerprint', ?
        )
        WHERE kind IN ('conversation.event_appended', 'conversation.event_replayed')
          AND json_valid(payload)
          AND json_extract(payload, '$.conversation_event_id')=?`)
      const updateConflictAuditHash = db.prepare(`UPDATE os_events
        SET payload=json_set(payload, '$.canonical_content_hash', ?)
        WHERE kind='conversation.event_conflict'
          AND json_valid(payload)
          AND json_extract(payload, '$.canonical_event_id')=?`)
      for (const row of rows) {
        const metadata = metadataRecord(row.metadata_json)
        const nativeProjection = isNativeProviderProjection(row.provider, metadata)
        const requestedState = isWithheldProviderReasoning(row.provider, metadata)
          ? 'withheld'
          : nativeProjection && row.redaction_state === 'withheld'
            ? 'none'
            : row.redaction_state
        const projected = normalizeProjectedText(row.projected_text, requestedState)
        if (projected.value === row.projected_text
          && projected.redactionState === row.redaction_state) continue
        const contentHash = canonicalHash({
          provider: row.provider,
          provider_event_id: row.provider_event_id,
          provider_thread_id: row.provider_thread_id,
          provider_turn_id: row.provider_turn_id,
          provider_item_id: row.provider_item_id,
          provider_cursor: row.provider_cursor,
          kind: row.kind,
          actor: { type: row.actor_type, id: row.actor_id },
          correlation_id: row.correlation_id,
          causation_id: row.causation_id,
          projected_text: projected.value,
          metadata,
          raw_artifact_id: row.raw_artifact_id,
          dedupe_key: row.dedupe_key,
          redaction_state: projected.redactionState,
          retention_class: row.retention_class,
          schema_version: row.schema_version,
        })
        update.run(projected.value, projected.redactionState, contentHash, row.id)
        updateAuditHash.run(contentHash, contentHash, row.id)
        updateConflictAuditHash.run(contentHash, row.id)
      }

      const conflicts = db.prepare(`SELECT conflict.id, conflict.received_projected_text,
          conflict.received_metadata_json, canonical.provider
        FROM conversation_event_conflicts conflict
        JOIN conversation_events canonical ON canonical.id=conflict.canonical_event_id`)
        .all() as Array<{
          id: string
          received_projected_text: string | null
          received_metadata_json: string
          provider: string | null
        }>
      const updateConflict = db.prepare(`UPDATE conversation_event_conflicts
        SET received_projected_text=? WHERE id=?`)
      for (const conflict of conflicts) {
        const metadata = metadataRecord(conflict.received_metadata_json)
        const projected = isWithheldProviderReasoning(conflict.provider, metadata)
          ? null
          : redactProjectedText(conflict.received_projected_text).value
        if (projected !== conflict.received_projected_text) {
          updateConflict.run(projected, conflict.id)
        }
      }
    },
  },
  {
    id: '011-managed-driver-event-redaction',
    apply(db) {
      const rows = db.prepare(`SELECT id, source, payload FROM os_events
        WHERE kind GLOB 'driver.*'`).all() as Array<{ id: string; source: string; payload: string }>
      const update = db.prepare('UPDATE os_events SET payload=? WHERE id=?')
      for (const row of rows) {
        const payload = metadataRecord(row.payload)
        const metadata = payload.metadata && typeof payload.metadata === 'object'
          && !Array.isArray(payload.metadata)
          ? payload.metadata as Record<string, unknown>
          : {}
        const projection = projectManagedDriverEvent({
          seq: Number(payload.seq),
          data: typeof payload.data === 'string' ? payload.data : '',
          metadata,
        }, row.source)
        update.run(JSON.stringify({
          data: projection.payload.data,
          metadata: projection.payload.metadata,
          seq: projection.payload.seq,
        }), row.id)
      }
    },
  },
  {
    id: '012-agent-home-retention',
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_home_retention_policies (
          board_id INTEGER PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
          schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
          transcript_days INTEGER NOT NULL CHECK(transcript_days BETWEEN 1 AND 36500),
          ephemeral_days INTEGER NOT NULL CHECK(ephemeral_days BETWEEN 1 AND 36500),
          raw_artifact_days INTEGER NOT NULL CHECK(raw_artifact_days BETWEEN 1 AND 36500),
          updated_by_actor_type TEXT NOT NULL,
          updated_by_actor_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_home_retention_runs (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          as_of TEXT NOT NULL,
          policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
          cutoffs_json TEXT NOT NULL CHECK(json_valid(cutoffs_json)),
          transcript_events_archived INTEGER NOT NULL DEFAULT 0
            CHECK(transcript_events_archived>=0),
          ephemeral_events_archived INTEGER NOT NULL DEFAULT 0
            CHECK(ephemeral_events_archived>=0),
          raw_artifacts_compacted INTEGER NOT NULL DEFAULT 0
            CHECK(raw_artifacts_compacted>=0),
          inline_raw_bytes_removed INTEGER NOT NULL DEFAULT 0
            CHECK(inline_raw_bytes_removed>=0),
          legacy_evidence_bundles_sanitized INTEGER NOT NULL DEFAULT 0
            CHECK(legacy_evidence_bundles_sanitized>=0),
          batch_limit INTEGER NOT NULL CHECK(batch_limit BETWEEN 1 AND 1000),
          has_more INTEGER NOT NULL DEFAULT 0 CHECK(has_more IN (0,1)),
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(board_id, idempotency_key)
        );

        CREATE TABLE IF NOT EXISTS agent_home_raw_artifact_archives (
          artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          retention_run_id TEXT NOT NULL REFERENCES agent_home_retention_runs(id)
            ON DELETE RESTRICT,
          content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
          content_bytes INTEGER NOT NULL CHECK(content_bytes>=0),
          archived_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_home_evidence_bundle_repairs (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          bundle_artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          retention_run_id TEXT NOT NULL REFERENCES agent_home_retention_runs(id)
            ON DELETE RESTRICT,
          original_sha256 TEXT NOT NULL CHECK(length(original_sha256)=64),
          original_bytes INTEGER NOT NULL CHECK(original_bytes>=0),
          repaired_sha256 TEXT NOT NULL CHECK(length(repaired_sha256)=64),
          repaired_bytes INTEGER NOT NULL CHECK(repaired_bytes>=0),
          raw_artifact_ids_json TEXT NOT NULL CHECK(json_valid(raw_artifact_ids_json)),
          repaired_at TEXT NOT NULL,
          UNIQUE(bundle_artifact_id, retention_run_id)
        );

        CREATE INDEX IF NOT EXISTS idx_agent_home_retention_runs_board
          ON agent_home_retention_runs(board_id, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_agent_home_raw_artifact_archives_board
          ON agent_home_raw_artifact_archives(board_id, archived_at, artifact_id);
        CREATE INDEX IF NOT EXISTS idx_agent_home_evidence_bundle_repairs_board
          ON agent_home_evidence_bundle_repairs(board_id, repaired_at, bundle_artifact_id);
        CREATE INDEX IF NOT EXISTS idx_agent_home_evidence_bundle_repairs_run
          ON agent_home_evidence_bundle_repairs(retention_run_id, bundle_artifact_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_events_retention
          ON conversation_events(board_id, archived_at, retention_class, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_conversation_events_raw_artifact
          ON conversation_events(raw_artifact_id) WHERE raw_artifact_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_conversation_event_conflicts_raw_artifact
          ON conversation_event_conflicts(raw_artifact_id) WHERE raw_artifact_id IS NOT NULL;
      `)
      const hasArtifacts = !!db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'",
      ).get()
      if (hasArtifacts) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_artifacts_agent_home_retention
            ON artifacts(board_id, kind, created_at, id) WHERE content IS NOT NULL;

          CREATE TRIGGER IF NOT EXISTS agent_home_raw_artifact_archives_scope_insert
          BEFORE INSERT ON agent_home_raw_artifact_archives
          BEGIN
            SELECT CASE WHEN NOT EXISTS (
              SELECT 1 FROM artifacts artifact
              JOIN agent_home_retention_runs run ON run.id=NEW.retention_run_id
              WHERE artifact.id=NEW.artifact_id
                AND artifact.board_id=NEW.board_id
                AND run.board_id=NEW.board_id
            ) THEN RAISE(ABORT, 'retention artifact archive scope is inconsistent') END;
          END;

          CREATE TRIGGER IF NOT EXISTS agent_home_evidence_bundle_repairs_scope_insert
          BEFORE INSERT ON agent_home_evidence_bundle_repairs
          BEGIN
            SELECT CASE WHEN NOT EXISTS (
              SELECT 1 FROM artifacts bundle
              JOIN agent_home_retention_runs run ON run.id=NEW.retention_run_id
              WHERE bundle.id=NEW.bundle_artifact_id
                AND bundle.board_id=NEW.board_id
                AND bundle.kind='evidence_bundle'
                AND run.board_id=NEW.board_id
            ) THEN RAISE(ABORT, 'retention evidence bundle repair scope is inconsistent') END;
          END;
        `)
      }
    },
  },
  {
    id: '013-agent-home-structured-metadata-redaction',
    apply(db) {
      const hasArtifacts = !!db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'",
      ).get()
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_home_transcript_repairs (
          artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          original_content_sha256 TEXT NOT NULL CHECK(length(original_content_sha256)=64),
          original_content_bytes INTEGER NOT NULL CHECK(original_content_bytes>=0),
          repaired_content_sha256 TEXT NOT NULL CHECK(length(repaired_content_sha256)=64),
          repaired_content_bytes INTEGER NOT NULL CHECK(repaired_content_bytes>=0),
          original_metadata_sha256 TEXT NOT NULL CHECK(length(original_metadata_sha256)=64),
          repaired_metadata_sha256 TEXT NOT NULL CHECK(length(repaired_metadata_sha256)=64),
          redactions_applied INTEGER NOT NULL CHECK(redactions_applied>=0),
          repaired_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_agent_home_transcript_repairs_board
          ON agent_home_transcript_repairs(board_id, repaired_at, artifact_id);
      `)
      if (hasArtifacts) {
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS agent_home_transcript_repairs_scope_insert
          BEFORE INSERT ON agent_home_transcript_repairs
          BEGIN
            SELECT CASE WHEN NOT EXISTS (
              SELECT 1 FROM artifacts
              WHERE artifacts.id=NEW.artifact_id
                AND artifacts.board_id=NEW.board_id
                AND artifacts.kind='agent_home_transcript'
            ) THEN RAISE(ABORT, 'transcript repair artifact scope is inconsistent') END;
          END;
        `)
      }

      const eventRows = db.prepare(`SELECT
          id, provider, provider_event_id, provider_thread_id, provider_turn_id,
          provider_item_id, provider_cursor, kind, actor_type, actor_id,
          correlation_id, causation_id, projected_text, metadata_json,
          raw_artifact_id, dedupe_key, content_hash, redaction_state,
          retention_class, schema_version
        FROM conversation_events`).all() as Array<{
          id: string
          provider: string | null
          provider_event_id: string | null
          provider_thread_id: string | null
          provider_turn_id: string | null
          provider_item_id: string | null
          provider_cursor: string | null
          kind: string
          actor_type: string
          actor_id: string | null
          correlation_id: string | null
          causation_id: string | null
          projected_text: string | null
          metadata_json: string
          raw_artifact_id: string | null
          dedupe_key: string
          content_hash: string
          redaction_state: ProjectedTextRedactionState
          retention_class: string
          schema_version: number
        }>
      const eventHashes = new Map<string, string>()
      const updateEvent = db.prepare(`UPDATE conversation_events
        SET projected_text=?, metadata_json=?, redaction_state=?, content_hash=? WHERE id=?`)
      const updateEventAudit = db.prepare(`UPDATE os_events
        SET payload=json_set(
          payload,
          '$.content_hash', ?,
          '$.request_fingerprint', ?
        )
        WHERE kind IN ('conversation.event_appended', 'conversation.event_replayed')
          AND json_valid(payload)
          AND json_extract(payload, '$.conversation_event_id')=?`)
      const updateConflictAudit = db.prepare(`UPDATE os_events
        SET payload=json_set(payload, '$.canonical_content_hash', ?)
        WHERE kind='conversation.event_conflict'
          AND json_valid(payload)
          AND json_extract(payload, '$.canonical_event_id')=?`)
      for (const row of eventRows) {
        const metadata = redactStructuredValue(metadataRecord(row.metadata_json))
        const projectedText = row.redaction_state === 'withheld'
          ? { value: null, changed: false }
          : redactSensitiveText(row.projected_text)
        const redactionState = row.redaction_state === 'withheld'
          ? 'withheld'
          : metadata.changed || projectedText.changed
            ? 'redacted'
            : row.redaction_state
        const contentHash = conversationEventContentHash({
          provider: row.provider,
          provider_event_id: row.provider_event_id,
          provider_thread_id: row.provider_thread_id,
          provider_turn_id: row.provider_turn_id,
          provider_item_id: row.provider_item_id,
          provider_cursor: row.provider_cursor,
          kind: row.kind,
          actor: { type: row.actor_type, id: row.actor_id },
          correlation_id: row.correlation_id,
          causation_id: row.causation_id,
          projected_text: projectedText.value,
          metadata: metadata.value as Record<string, unknown>,
          raw_artifact_id: row.raw_artifact_id,
          dedupe_key: row.dedupe_key,
          redaction_state: redactionState,
          retention_class: row.retention_class,
          schema_version: row.schema_version,
        })
        updateEvent.run(
          projectedText.value,
          stableJson(metadata.value),
          redactionState,
          contentHash,
          row.id,
        )
        updateEventAudit.run(contentHash, contentHash, row.id)
        updateConflictAudit.run(contentHash, row.id)
        eventHashes.set(row.id, contentHash)
      }

      const conflictRows = db.prepare(`SELECT
          conflict.id, conflict.received_projected_text,
          conflict.received_metadata_json, canonical.provider
        FROM conversation_event_conflicts conflict
        JOIN conversation_events canonical ON canonical.id=conflict.canonical_event_id`)
        .all() as Array<{
          id: string
          received_projected_text: string | null
          received_metadata_json: string
          provider: string | null
        }>
      const updateConflict = db.prepare(`UPDATE conversation_event_conflicts
        SET received_projected_text=?, received_metadata_json=? WHERE id=?`)
      for (const conflict of conflictRows) {
        const metadata = redactStructuredValue(metadataRecord(conflict.received_metadata_json))
        const projectedText = isWithheldProviderReasoning(
          conflict.provider,
          metadata.value as Record<string, unknown>,
        )
          ? null
          : redactSensitiveText(conflict.received_projected_text).value
        updateConflict.run(
          projectedText,
          stableJson(metadata.value),
          conflict.id,
        )
      }

      if (!hasArtifacts) return
      const artifacts = db.prepare(`SELECT
          id, board_id, mime_type, content, metadata
        FROM artifacts WHERE kind='agent_home_transcript'`).all() as Array<{
          id: string
          board_id: number
          mime_type: string
          content: string | null
          metadata: string
        }>
      const updateArtifact = db.prepare(
        'UPDATE artifacts SET content=?, metadata=? WHERE id=?',
      )
      const updateArtifactAudit = db.prepare(`UPDATE os_events
        SET payload=json_set(payload, '$.content_hash', ?)
        WHERE kind='agent_home.transcript_exported'
          AND json_valid(payload)
          AND json_extract(payload, '$.artifact_id')=?`)
      const recordRepair = db.prepare(`INSERT OR IGNORE INTO agent_home_transcript_repairs (
          artifact_id, board_id, original_content_sha256, original_content_bytes,
          repaired_content_sha256, repaired_content_bytes,
          original_metadata_sha256, repaired_metadata_sha256,
          redactions_applied, repaired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      for (const artifact of artifacts) {
        const originalContent = artifact.content ?? ''
        const originalMetadata = metadataRecord(artifact.metadata)
        const safeMetadata = redactStructuredValue(originalMetadata)
        const format = originalMetadata.format === 'json'
          || artifact.mime_type.toLowerCase().includes('json')
          ? 'json'
          : 'human'
        const repairedContent = artifact.content === null
          ? { content: '', redactions: 0 }
          : repairTranscriptContent(
              artifact.content,
              format,
              eventHashes,
            )
        const originalContentHash = sha256(originalContent)
        const repairedContentHash = sha256(repairedContent.content)
        const repairedMetadata: Record<string, unknown> = {
          ...(safeMetadata.value as Record<string, unknown>),
          content_hash: repairedContentHash,
        }
        const priorRedactions = Number(repairedMetadata.redactions_applied)
        const additionalRedactions = repairedContent.redactions + safeMetadata.redactions
        if (additionalRedactions > 0) {
          repairedMetadata.redactions_applied = (
            Number.isSafeInteger(priorRedactions) && priorRedactions >= 0
              ? priorRedactions
              : 0
          ) + additionalRedactions
        }
        const repairedMetadataJson = stableJson(repairedMetadata)
        const repairedMetadataHash = sha256(repairedMetadataJson)
        const contentValue = artifact.content === null ? null : repairedContent.content
        updateArtifactAudit.run(repairedContentHash, artifact.id)
        if (contentValue === artifact.content
          && repairedMetadataJson === artifact.metadata) continue

        updateArtifact.run(contentValue, repairedMetadataJson, artifact.id)
        recordRepair.run(
          artifact.id,
          artifact.board_id,
          originalContentHash,
          Buffer.byteLength(originalContent, 'utf8'),
          repairedContentHash,
          Buffer.byteLength(repairedContent.content, 'utf8'),
          sha256(artifact.metadata),
          repairedMetadataHash,
          additionalRedactions,
        )
      }
    },
  },
  {
    // 012 (retention) and 013 (structured transcript metadata) are supplied by the
    // integration train. This lifecycle ledger must remain ordered after both.
    id: '014-agent-home-native-fork-lifecycle',
    apply(db) {
      db.exec(`
        ALTER TABLE agent_session_actions ADD COLUMN reserved_session_id TEXT;
        ALTER TABLE agent_session_actions
          ADD COLUMN effect_state TEXT NOT NULL DEFAULT 'reserved'
            CHECK(effect_state IN (
              'reserved','invoking','applied','completed','outcome_unknown'
            ));
        ALTER TABLE agent_session_actions
          ADD COLUMN effect_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(effect_json));

        UPDATE agent_session_actions
        SET effect_state=CASE
          WHEN status='succeeded' THEN 'completed'
          WHEN result_session_id IS NOT NULL THEN 'applied'
          WHEN status='failed' THEN 'completed'
          ELSE 'reserved'
        END,
        reserved_session_id=CASE
          WHEN action='fork' AND result_session_id IS NOT NULL THEN result_session_id
          ELSE reserved_session_id
        END;

        CREATE INDEX idx_agent_session_actions_fork_outcome
          ON agent_session_actions(session_id, action, effect_state, updated_at);

        CREATE TABLE agent_session_action_reconciliations (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          action_id TEXT NOT NULL REFERENCES agent_session_actions(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          resolution TEXT NOT NULL
            CHECK(resolution IN ('verify_adopt','confirm_absent')),
          status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
          result_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          note TEXT,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(board_id, idempotency_key)
        );

        CREATE INDEX idx_agent_session_action_reconciliations_board
          ON agent_session_action_reconciliations(board_id, updated_at, id);
        CREATE UNIQUE INDEX idx_agent_session_action_reconciliations_pending
          ON agent_session_action_reconciliations(action_id)
          WHERE status='pending';
        CREATE UNIQUE INDEX idx_agent_session_action_reconciliations_succeeded
          ON agent_session_action_reconciliations(action_id)
          WHERE status='succeeded';

        CREATE TRIGGER agent_session_action_reconciliation_scope_insert
        BEFORE INSERT ON agent_session_action_reconciliations
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM agent_session_actions action
            WHERE action.id=NEW.action_id
              AND action.board_id=NEW.board_id
              AND action.action='fork'
          ) THEN RAISE(ABORT, 'fork reconciliation action scope is inconsistent') END;
        END;

        CREATE TRIGGER agent_session_action_reconciliation_scope_update
        BEFORE UPDATE OF board_id, action_id ON agent_session_action_reconciliations
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM agent_session_actions action
            WHERE action.id=NEW.action_id
              AND action.board_id=NEW.board_id
              AND action.action='fork'
          ) THEN RAISE(ABORT, 'fork reconciliation action scope is inconsistent') END;
        END;
      `)
    },
  },
  {
    // 014 is already deployed, so command identity and board-scope hardening must
    // remain a forward migration for existing databases as well as fresh installs.
    id: '015-agent-home-action-command-scope',
    apply(db) {
      const ambiguousAction = db.prepare(`SELECT session_id, action, idempotency_key
        FROM agent_session_actions
        GROUP BY session_id, action, idempotency_key
        HAVING COUNT(*) > 1
        LIMIT 1`).get()
      if (ambiguousAction) {
        throw new Error(
          'agent session action command identity is ambiguous; migration 015 cannot continue',
        )
      }

      const ambiguousActionRequestIdentity = db.prepare(`SELECT
          idempotency_key, request_fingerprint
        FROM agent_session_actions
        GROUP BY idempotency_key, request_fingerprint
        HAVING COUNT(*) > 1
        LIMIT 1`).get()
      if (ambiguousActionRequestIdentity) {
        throw new Error(
          'agent session action request identity is ambiguous; migration 015 cannot continue',
        )
      }

      const ambiguousAudit = db.prepare(`SELECT
          json_extract(payload, '$.session_id') AS session_id,
          json_extract(payload, '$.action') AS action,
          idempotency_key
        FROM os_events
        WHERE kind='agent_session.action_requested'
          AND idempotency_key IS NOT NULL
          AND json_valid(payload)
          AND json_type(payload, '$.session_id')='text'
          AND json_type(payload, '$.action')='text'
        GROUP BY
          json_extract(payload, '$.session_id'),
          json_extract(payload, '$.action'),
          idempotency_key
        HAVING COUNT(*) > 1
        LIMIT 1`).get()
      if (ambiguousAudit) {
        throw new Error(
          'agent session action request audit identity is ambiguous; migration 015 cannot continue',
        )
      }

      const ambiguousAuditRequestIdentity = db.prepare(`SELECT
          idempotency_key,
          json_extract(payload, '$.request_fingerprint') AS request_fingerprint
        FROM os_events
        WHERE kind='agent_session.action_requested'
          AND idempotency_key IS NOT NULL
          AND json_valid(payload)
          AND json_type(payload, '$.request_fingerprint')='text'
        GROUP BY
          idempotency_key,
          json_extract(payload, '$.request_fingerprint')
        HAVING COUNT(*) > 1
        LIMIT 1`).get()
      if (ambiguousAuditRequestIdentity) {
        throw new Error(
          'agent session action request audit fingerprint is ambiguous; migration 015 cannot continue',
        )
      }

      const displacedAudit = db.prepare(`SELECT event.id
        FROM os_events event
        JOIN agent_session_actions action
          ON action.id=CASE WHEN json_valid(event.payload)
            THEN json_extract(event.payload, '$.action_id') END
        WHERE event.kind='agent_session.action_requested'
          AND (
            event.board_id IS NOT action.board_id
            OR event.idempotency_key IS NOT action.idempotency_key
            OR event.session_id IS NOT action.session_id
            OR json_extract(event.payload, '$.session_id') IS NOT action.session_id
            OR json_extract(event.payload, '$.action') IS NOT action.action
            OR json_extract(event.payload, '$.request_fingerprint')
              IS NOT action.request_fingerprint
          )
        LIMIT 1`).get()
      if (displacedAudit) {
        throw new Error(
          'agent session action request audit scope is inconsistent; migration 015 cannot continue',
        )
      }

      const auditNames = new Map<string, string>()
      const auditedActionIds = new Set<string>()
      const requestAudits = db.prepare(`SELECT id, idempotency_key, payload
        FROM os_events
        WHERE kind='agent_session.action_requested'`).all() as Array<{
          id: string
          idempotency_key: string | null
          payload: string
        }>
      for (const audit of requestAudits) {
        const payload = metadataRecord(audit.payload)
        const actionId = payload.action_id
        const sessionId = payload.session_id
        const action = payload.action
        const requestFingerprint = payload.request_fingerprint
        const name = action === 'rename' ? payload.name : undefined
        if (audit.idempotency_key === null
          || typeof actionId !== 'string'
          || typeof sessionId !== 'string'
          || typeof action !== 'string'
          || typeof requestFingerprint !== 'string'
          || (action === 'rename'
            && (typeof name !== 'string'
              || name !== name.trim()
              || name.length === 0
              || name.length > 200))) {
          throw new Error(
            'agent session action request audit fingerprint cannot be verified; '
              + 'migration 015 cannot continue',
          )
        }
        const expectedFingerprint = canonicalHash({
          command: `agent_session.${action}`,
          sessionId,
          ...(typeof name === 'string' ? { name } : {}),
        })
        if (requestFingerprint !== expectedFingerprint) {
          throw new Error(
            'agent session action request audit fingerprint is inconsistent; '
              + 'migration 015 cannot continue',
          )
        }
        if (auditedActionIds.has(actionId)) {
          throw new Error(
            'agent session action request audit identity is ambiguous; '
              + 'migration 015 cannot continue',
          )
        }
        auditedActionIds.add(actionId)
        if (typeof name === 'string') auditNames.set(actionId, name)
      }

      const actions = db.prepare(`SELECT id, session_id, action, request_fingerprint
        FROM agent_session_actions`).all() as Array<{
          id: string
          session_id: string
          action: string
          request_fingerprint: string
        }>
      for (const action of actions) {
        const name = action.action === 'rename' ? auditNames.get(action.id) : undefined
        if (action.action === 'rename' && name === undefined) {
          throw new Error(
            'agent session action request fingerprint cannot be verified; '
              + 'migration 015 cannot continue',
          )
        }
        const expectedFingerprint = canonicalHash({
          command: `agent_session.${action.action}`,
          sessionId: action.session_id,
          ...(name === undefined ? {} : { name }),
        })
        if (action.request_fingerprint !== expectedFingerprint) {
          throw new Error(
            'agent session action request fingerprint is inconsistent; '
              + 'migration 015 cannot continue',
          )
        }
      }

      db.exec(`
        CREATE INDEX idx_os_events_idempotency_key_global
          ON os_events(idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE UNIQUE INDEX idx_agent_session_actions_command_identity
          ON agent_session_actions(session_id, action, idempotency_key);
        CREATE UNIQUE INDEX idx_agent_session_actions_request_identity
          ON agent_session_actions(idempotency_key, request_fingerprint);
        CREATE UNIQUE INDEX idx_os_events_action_request_command_identity
          ON os_events(
            json_extract(payload, '$.session_id'),
            json_extract(payload, '$.action'),
            idempotency_key
          )
          WHERE kind='agent_session.action_requested'
            AND idempotency_key IS NOT NULL
            AND json_valid(payload)
            AND json_type(payload, '$.session_id')='text'
            AND json_type(payload, '$.action')='text';
        CREATE UNIQUE INDEX idx_os_events_action_request_fingerprint_identity
          ON os_events(
            idempotency_key,
            json_extract(payload, '$.request_fingerprint')
          )
          WHERE kind='agent_session.action_requested'
            AND idempotency_key IS NOT NULL
            AND json_valid(payload)
            AND json_type(payload, '$.request_fingerprint')='text';

        CREATE TRIGGER agent_session_actions_command_identity_update
        BEFORE UPDATE OF
          id, board_id, session_id, action, idempotency_key, request_fingerprint
        ON agent_session_actions
        WHEN NEW.id IS NOT OLD.id
          OR NEW.board_id IS NOT OLD.board_id
          OR NEW.session_id IS NOT OLD.session_id
          OR NEW.action IS NOT OLD.action
          OR NEW.idempotency_key IS NOT OLD.idempotency_key
          OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
        BEGIN
          SELECT RAISE(
            ABORT,
            'agent session action command identity is immutable'
          );
        END;

        CREATE TRIGGER os_events_action_request_identity_update
        BEFORE UPDATE OF
          id, board_id, session_id, idempotency_key, kind, source, payload
        ON os_events
        WHEN OLD.kind='agent_session.action_requested'
          AND (
            NEW.id IS NOT OLD.id
            OR NEW.board_id IS NOT OLD.board_id
            OR NEW.session_id IS NOT OLD.session_id
            OR NEW.idempotency_key IS NOT OLD.idempotency_key
            OR NEW.kind IS NOT OLD.kind
            OR NEW.source IS NOT OLD.source
            OR NOT json_valid(NEW.payload)
            OR json_extract(NEW.payload, '$.action_id')
              IS NOT json_extract(OLD.payload, '$.action_id')
            OR json_extract(NEW.payload, '$.session_id')
              IS NOT json_extract(OLD.payload, '$.session_id')
            OR json_extract(NEW.payload, '$.action')
              IS NOT json_extract(OLD.payload, '$.action')
            OR json_extract(NEW.payload, '$.request_fingerprint')
              IS NOT json_extract(OLD.payload, '$.request_fingerprint')
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'agent session action request audit identity is immutable'
          );
        END;

        CREATE TRIGGER agent_session_actions_home_scope_insert
        BEFORE INSERT ON agent_session_actions
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM agent_sessions session
            JOIN workspaces workspace ON workspace.id=session.workspace_id
            JOIN agent_profiles profile ON profile.id=session.profile_id
            JOIN agent_conversations conversation
              ON conversation.id=session.conversation_id
            WHERE session.id=NEW.session_id
              AND workspace.board_id=NEW.board_id
              AND profile.board_id=NEW.board_id
              AND conversation.board_id=NEW.board_id
              AND conversation.profile_id=profile.id
          ) THEN RAISE(
            ABORT,
            'agent session action board scope is inconsistent'
          ) END;
        END;

        CREATE TRIGGER agent_session_actions_home_scope_update
        BEFORE UPDATE OF board_id, session_id ON agent_session_actions
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM agent_sessions session
            JOIN workspaces workspace ON workspace.id=session.workspace_id
            JOIN agent_profiles profile ON profile.id=session.profile_id
            JOIN agent_conversations conversation
              ON conversation.id=session.conversation_id
            WHERE session.id=NEW.session_id
              AND workspace.board_id=NEW.board_id
              AND profile.board_id=NEW.board_id
              AND conversation.board_id=NEW.board_id
              AND conversation.profile_id=profile.id
          ) THEN RAISE(
            ABORT,
            'agent session action board scope is inconsistent'
          ) END;
        END;

        CREATE TRIGGER agent_sessions_action_scope_update
        BEFORE UPDATE OF workspace_id, profile_id, conversation_id ON agent_sessions
        WHEN EXISTS (
          SELECT 1 FROM agent_session_actions action
          WHERE action.session_id=OLD.id
        )
        BEGIN
          SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM agent_session_actions action
            WHERE action.session_id=OLD.id
              AND NOT EXISTS (
                SELECT 1
                FROM workspaces workspace
                JOIN agent_profiles profile ON profile.id=NEW.profile_id
                JOIN agent_conversations conversation
                  ON conversation.id=NEW.conversation_id
                WHERE workspace.id=NEW.workspace_id
                  AND workspace.board_id=action.board_id
                  AND profile.board_id=action.board_id
                  AND conversation.board_id=action.board_id
                  AND conversation.profile_id=profile.id
              )
          ) THEN RAISE(
            ABORT,
            'agent session action board scope is inconsistent'
          ) END;
        END;

        CREATE TRIGGER workspaces_session_action_scope_update
        BEFORE UPDATE OF board_id ON workspaces
        WHEN EXISTS (
          SELECT 1
          FROM agent_sessions session
          JOIN agent_session_actions action ON action.session_id=session.id
          WHERE session.workspace_id=OLD.id
            AND action.board_id!=NEW.board_id
        )
        BEGIN
          SELECT RAISE(
            ABORT,
            'workspace board change would displace an agent session action'
          );
        END;

        CREATE TRIGGER agent_profiles_session_action_scope_update
        BEFORE UPDATE OF board_id ON agent_profiles
        WHEN EXISTS (
          SELECT 1
          FROM agent_sessions session
          JOIN agent_session_actions action ON action.session_id=session.id
          WHERE session.profile_id=OLD.id
            AND action.board_id!=NEW.board_id
        )
        BEGIN
          SELECT RAISE(
            ABORT,
            'profile board change would displace an agent session action'
          );
        END;

        CREATE TRIGGER agent_conversations_session_action_scope_update
        BEFORE UPDATE OF board_id, profile_id ON agent_conversations
        WHEN EXISTS (
          SELECT 1
          FROM agent_sessions session
          JOIN agent_session_actions action ON action.session_id=session.id
          WHERE session.conversation_id=OLD.id
            AND (
              action.board_id!=NEW.board_id
              OR session.profile_id!=NEW.profile_id
            )
        )
        BEGIN
          SELECT RAISE(
            ABORT,
            'conversation scope change would displace an agent session action'
          );
        END;

        UPDATE agent_session_actions
        SET board_id=board_id, session_id=session_id;

        UPDATE agent_session_action_reconciliations
        SET board_id=board_id, action_id=action_id;
      `)
    },
  },
  {
    id: '016-job-market-assignment-lifecycle',
    apply(db) {
      const hasMigration015 = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id='015-agent-home-action-command-scope'`).get()
      if (!hasMigration015) {
        throw new Error(
          'migration 016-job-market-assignment-lifecycle requires 015-agent-home-action-command-scope',
        )
      }
      const prerequisites = (db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type='table' AND name IN (
          'boards','cards','jobs','workspaces','agent_sessions','agent_profiles',
          'task_contracts','job_market_contracts','job_market_dependencies','os_events'
        )`).get() as { count: number }).count
      if (prerequisites !== 10) {
        throw new Error(
          'migration 016-job-market-assignment-lifecycle requires Agent Home, Job Market, and runtime tables',
        )
      }
      const cardColumns = new Set(
        (db.prepare(`PRAGMA table_info('cards')`).all() as Array<{ name: string }>)
          .map((column) => column.name),
      )
      if (!cardColumns.has('column_name')) {
        db.exec("ALTER TABLE cards ADD COLUMN column_name TEXT NOT NULL DEFAULT 'backlog'")
      }
      if (!cardColumns.has('owner_agent_id')) {
        db.exec('ALTER TABLE cards ADD COLUMN owner_agent_id INTEGER')
        cardColumns.add('owner_agent_id')
      }
      const jobColumns = new Set(
        (db.prepare(`PRAGMA table_info('jobs')`).all() as Array<{ name: string }>)
          .map((column) => column.name),
      )
      if (!jobColumns.has('status')) {
        db.exec("ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'")
      }
      const sessionColumns = new Set(
        (db.prepare(`PRAGMA table_info('agent_sessions')`).all() as Array<{ name: string }>)
          .map((column) => column.name),
      )
      if (!sessionColumns.has('status')) {
        db.exec("ALTER TABLE agent_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'starting'")
      }

      const legacyMarketStates = db.prepare(`
        SELECT market.card_id, card.board_id, market.status, market.version,
          CASE WHEN card.owner_agent_id IS NULL THEN 0 ELSE 1 END AS has_legacy_owner,
          CASE WHEN EXISTS (
            SELECT 1 FROM jobs job
            WHERE job.card_id=market.card_id
              AND job.status IN ('queued','running','cancelling')
          ) OR EXISTS (
            SELECT 1
            FROM agent_sessions session
            JOIN jobs job ON job.id=session.job_id
            WHERE job.card_id=market.card_id
              AND session.status IN ('reserved','starting','running','idle','stopping')
          ) THEN 1 ELSE 0 END AS has_active_execution
        FROM job_market_contracts market
        JOIN cards card ON card.id=market.card_id
        WHERE market.status IN ('assigned','running','submitted')
        ORDER BY market.card_id
      `).all() as Array<{
        card_id: number
        board_id: number
        status: 'assigned' | 'running' | 'submitted'
        version: number
        has_legacy_owner: 0 | 1
        has_active_execution: 0 | 1
      }>
      const normalizeLegacyAssigned = db.prepare(`
        UPDATE job_market_contracts
        SET status='open', version=version+1, updated_at=datetime('now')
        WHERE card_id=? AND status='assigned' AND version=?
      `)
      const recordLegacyState = db.prepare(`
        INSERT INTO os_events (
          id, board_id, card_id, kind, source, payload, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, 'migration-016', ?, ?, datetime('now'))
      `)
      for (const legacy of legacyMarketStates) {
        const retainedForLegacyOwner = legacy.status === 'assigned'
          && legacy.has_active_execution === 0
          && legacy.has_legacy_owner === 1
        const normalized = legacy.status === 'assigned'
          && legacy.has_active_execution === 0
          && legacy.has_legacy_owner === 0
        if (normalized) {
          const result = normalizeLegacyAssigned.run(legacy.card_id, legacy.version)
          if (result.changes !== 1) {
            throw new Error('migration 016 could not normalize a legacy assigned contract')
          }
        }
        const eventKey = `migration:016:legacy-market-state:${legacy.card_id}`
        recordLegacyState.run(
          eventKey,
          legacy.board_id,
          legacy.card_id,
          normalized
            ? 'job_market.legacy_assignment_state_normalized'
            : 'job_market.legacy_assignment_state_retained',
          JSON.stringify({
            card_id: legacy.card_id,
            previous_status: legacy.status,
            legacy_owner_present: legacy.has_legacy_owner === 1,
            disposition: normalized
              ? 'normalized_to_open'
              : retainedForLegacyOwner
                ? 'retained_for_legacy_owner'
                : 'retained_for_legacy_lifecycle',
            remediation: normalized
              ? 'use a canonical claim or assign command'
              : retainedForLegacyOwner
                ? 'finish or clear the legacy owner and return the contract to open before creating a canonical assignment'
                : 'finish the legacy lifecycle before creating a canonical assignment',
          }),
          eventKey,
        )
      }

      db.exec(`
        CREATE TABLE job_market_assignments (
          id TEXT PRIMARY KEY,
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
          card_id INTEGER NOT NULL
            REFERENCES job_market_contracts(card_id) ON DELETE RESTRICT,
          profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE RESTRICT,
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
          ownership_mode TEXT NOT NULL DEFAULT 'exclusive'
            CHECK(ownership_mode='exclusive'),
          origin TEXT NOT NULL
            CHECK(origin IN ('claim','assign','reassign')),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('pending','active','released','superseded')),
          assigned_market_version INTEGER NOT NULL CHECK(assigned_market_version > 0),
          version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
          predecessor_assignment_id TEXT UNIQUE
            REFERENCES job_market_assignments(id) ON DELETE RESTRICT,
          predecessor_version INTEGER
            CHECK(predecessor_version IS NULL OR predecessor_version > 0),
          created_actor_type TEXT NOT NULL,
          created_actor_id TEXT,
          idempotency_key TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          ended_at TEXT,
          ended_actor_type TEXT,
          ended_actor_id TEXT,
          end_reason TEXT,
          end_idempotency_key TEXT,
          end_request_fingerprint TEXT,
          ended_market_version INTEGER
            CHECK(ended_market_version IS NULL OR ended_market_version > 0),
          UNIQUE(board_id, idempotency_key),
          CHECK(
            (origin='reassign'
              AND predecessor_assignment_id IS NOT NULL
              AND predecessor_version IS NOT NULL)
            OR
            (origin IN ('claim','assign')
              AND predecessor_assignment_id IS NULL
              AND predecessor_version IS NULL)
          ),
          CHECK(
            (status IN ('pending','active')
              AND ended_at IS NULL
              AND ended_actor_type IS NULL
              AND ended_actor_id IS NULL
              AND end_reason IS NULL
              AND end_idempotency_key IS NULL
              AND end_request_fingerprint IS NULL
              AND ended_market_version IS NULL)
            OR
            (status IN ('released','superseded')
              AND ended_at IS NOT NULL
              AND ended_actor_type IS NOT NULL
              AND end_idempotency_key IS NOT NULL
              AND end_request_fingerprint IS NOT NULL
              AND ended_market_version IS NOT NULL)
          )
        );

        CREATE UNIQUE INDEX idx_job_market_assignments_active_exclusive
          ON job_market_assignments(card_id)
          WHERE status='active' AND ownership_mode='exclusive';
        CREATE INDEX idx_job_market_assignments_board
          ON job_market_assignments(board_id, status, updated_at, id);
        CREATE INDEX idx_job_market_assignments_profile
          ON job_market_assignments(profile_id, status, updated_at, id);
        CREATE INDEX idx_job_market_assignments_workspace
          ON job_market_assignments(workspace_id, status, updated_at, id)
          WHERE workspace_id IS NOT NULL;
        CREATE INDEX idx_job_market_assignments_history
          ON job_market_assignments(card_id, created_at, id);

        ALTER TABLE jobs ADD COLUMN job_assignment_id TEXT
          REFERENCES job_market_assignments(id) ON DELETE RESTRICT;
        ALTER TABLE jobs ADD COLUMN assigned_profile_id TEXT
          REFERENCES agent_profiles(id) ON DELETE RESTRICT;
        ALTER TABLE jobs ADD COLUMN assignment_market_version INTEGER
          CHECK(assignment_market_version IS NULL OR assignment_market_version > 0);

        ALTER TABLE agent_sessions ADD COLUMN job_assignment_id TEXT
          REFERENCES job_market_assignments(id) ON DELETE RESTRICT;
        ALTER TABLE agent_sessions ADD COLUMN assigned_profile_id TEXT
          REFERENCES agent_profiles(id) ON DELETE RESTRICT;
        ALTER TABLE agent_sessions ADD COLUMN assignment_market_version INTEGER
          CHECK(assignment_market_version IS NULL OR assignment_market_version > 0);

        CREATE INDEX idx_jobs_job_assignment
          ON jobs(job_assignment_id) WHERE job_assignment_id IS NOT NULL;
        CREATE INDEX idx_agent_sessions_job_assignment
          ON agent_sessions(job_assignment_id) WHERE job_assignment_id IS NOT NULL;

        CREATE TRIGGER job_market_assignment_insert_scope
        BEFORE INSERT ON job_market_assignments
        BEGIN
          SELECT CASE WHEN NEW.version!=1 OR NOT (
            (NEW.origin IN ('claim','assign') AND NEW.status='active')
            OR (NEW.origin='reassign' AND NEW.status='pending')
          ) THEN RAISE(
            ABORT,
            'job market assignment must begin at its canonical status and version'
          ) END;

          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM cards card
            JOIN job_market_contracts market ON market.card_id=card.id
            JOIN agent_profiles profile ON profile.id=NEW.profile_id
            WHERE card.id=NEW.card_id
              AND card.board_id=NEW.board_id
              AND profile.board_id=NEW.board_id
              AND profile.status='active'
          ) THEN RAISE(
            ABORT,
            'job market assignment card, board, and active profile scope is inconsistent'
          ) END;

          SELECT CASE WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
            SELECT 1
            FROM workspaces workspace
            WHERE workspace.id=NEW.workspace_id
              AND workspace.board_id=NEW.board_id
              AND workspace.status='active'
              AND (workspace.card_id IS NULL OR workspace.card_id=NEW.card_id)
          ) THEN RAISE(
            ABORT,
            'job market assignment workspace scope is inconsistent'
          ) END;

          SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM task_contracts contract
            WHERE contract.card_id=NEW.card_id
              AND contract.workspace_id IS NOT NULL
              AND contract.workspace_id IS NOT NEW.workspace_id
          ) THEN RAISE(
            ABORT,
            'job market assignment must use the contract workspace'
          ) END;

          SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM job_market_contracts market
            JOIN agent_profiles profile ON profile.id=NEW.profile_id
            JOIN json_each(market.required_capabilities_json) required
            WHERE market.card_id=NEW.card_id
              AND NOT EXISTS (
                SELECT 1
                FROM json_each(profile.capabilities_json) capability
                WHERE capability.value=required.value
              )
          ) THEN RAISE(
            ABORT,
            'agent profile does not satisfy required job capabilities'
          ) END;

          SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM job_market_dependencies dependency
            LEFT JOIN cards target ON target.id=dependency.dependency_card_id
            WHERE dependency.card_id=NEW.card_id
              AND (target.id IS NULL OR target.column_name!='done')
          ) THEN RAISE(
            ABORT,
            'job market assignment dependencies are not complete'
          ) END;

          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM jobs
            WHERE card_id=NEW.card_id
              AND status IN ('queued','running','cancelling')
          ) THEN RAISE(
            ABORT,
            'job market assignment cannot change while the card has an active job'
          ) END;

          SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM agent_sessions session
            JOIN jobs job ON job.id=session.job_id
            WHERE job.card_id=NEW.card_id
              AND session.status IN ('reserved','starting','running','idle','stopping')
          ) THEN RAISE(
            ABORT,
            'job market assignment cannot change while the card has an active agent session'
          ) END;

          SELECT CASE WHEN NEW.origin IN ('claim','assign') AND NOT EXISTS (
            SELECT 1
            FROM job_market_contracts market
            WHERE market.card_id=NEW.card_id
              AND market.status='open'
              AND market.version=NEW.assigned_market_version-1
          ) THEN RAISE(
            ABORT,
            'job market assignment requires the expected open market version'
          ) END;

          SELECT CASE WHEN NEW.origin='reassign' AND NOT EXISTS (
            SELECT 1
            FROM job_market_contracts market
            JOIN job_market_assignments predecessor
              ON predecessor.id=NEW.predecessor_assignment_id
            WHERE market.card_id=NEW.card_id
              AND market.status IN ('assigned','rejected')
              AND market.version=NEW.assigned_market_version-1
              AND predecessor.board_id=NEW.board_id
              AND predecessor.card_id=NEW.card_id
              AND predecessor.status='active'
              AND predecessor.version=NEW.predecessor_version
              AND (
                predecessor.profile_id!=NEW.profile_id
                OR (
                  NEW.reason IS NOT NULL
                  AND trim(NEW.reason)!=''
                  AND predecessor.assigned_market_version<market.version
                )
              )
          ) THEN RAISE(
            ABORT,
            'job market reassignment predecessor or market version is stale'
          ) END;

        END;

        CREATE TRIGGER job_market_assignment_insert_market_cas
        AFTER INSERT ON job_market_assignments
        BEGIN
          UPDATE job_market_assignments
          SET status='superseded',
              version=version+1,
              updated_at=NEW.created_at,
              ended_at=NEW.created_at,
              ended_actor_type=NEW.created_actor_type,
              ended_actor_id=NEW.created_actor_id,
              end_reason=NEW.reason,
              end_idempotency_key=NEW.idempotency_key,
              end_request_fingerprint=NEW.request_fingerprint,
              ended_market_version=NEW.assigned_market_version
          WHERE NEW.origin='reassign'
            AND id=NEW.predecessor_assignment_id
            AND status='active'
            AND version=NEW.predecessor_version;

          SELECT CASE WHEN NEW.origin='reassign' AND changes()!=1
            THEN RAISE(ABORT, 'job market reassignment lost its predecessor race') END;

          UPDATE job_market_assignments
          SET status='active'
          WHERE NEW.origin='reassign'
            AND id=NEW.id
            AND status='pending'
            AND version=1;

          SELECT CASE WHEN NEW.origin='reassign' AND changes()!=1
            THEN RAISE(ABORT, 'job market reassignment successor activation failed') END;

          UPDATE job_market_contracts
          SET status='assigned',
              version=version+1,
              updated_at=NEW.created_at,
              published_at=COALESCE(published_at, NEW.created_at),
              archived_at=NULL
          WHERE card_id=NEW.card_id
            AND version=NEW.assigned_market_version-1
            AND (
              (NEW.origin IN ('claim','assign') AND status='open')
              OR
              (NEW.origin='reassign' AND status IN ('assigned','rejected'))
            );

          SELECT CASE WHEN changes()!=1
            THEN RAISE(ABORT, 'job market assignment version changed concurrently') END;
        END;

        CREATE TRIGGER job_market_assignment_update
        BEFORE UPDATE ON job_market_assignments
        BEGIN
          SELECT CASE WHEN
            NEW.id IS NOT OLD.id
            OR NEW.board_id IS NOT OLD.board_id
            OR NEW.card_id IS NOT OLD.card_id
            OR NEW.profile_id IS NOT OLD.profile_id
            OR NEW.workspace_id IS NOT OLD.workspace_id
            OR NEW.ownership_mode IS NOT OLD.ownership_mode
            OR NEW.origin IS NOT OLD.origin
            OR NEW.assigned_market_version IS NOT OLD.assigned_market_version
            OR NEW.predecessor_assignment_id IS NOT OLD.predecessor_assignment_id
            OR NEW.predecessor_version IS NOT OLD.predecessor_version
            OR NEW.created_actor_type IS NOT OLD.created_actor_type
            OR NEW.created_actor_id IS NOT OLD.created_actor_id
            OR NEW.idempotency_key IS NOT OLD.idempotency_key
            OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
            OR NEW.reason IS NOT OLD.reason
            OR NEW.created_at IS NOT OLD.created_at
          THEN RAISE(
            ABORT,
            'job market assignment identity is immutable'
          ) END;

          SELECT CASE WHEN OLD.status NOT IN ('pending','active')
            THEN RAISE(ABORT, 'terminal job market assignments are immutable') END;
          SELECT CASE WHEN OLD.status='pending' AND (
            NEW.status!='active'
            OR NEW.version!=OLD.version
            OR NEW.ended_at IS NOT NULL
            OR NEW.ended_actor_type IS NOT NULL
            OR NEW.ended_actor_id IS NOT NULL
            OR NEW.end_reason IS NOT NULL
            OR NEW.end_idempotency_key IS NOT NULL
            OR NEW.end_request_fingerprint IS NOT NULL
            OR NEW.ended_market_version IS NOT NULL
          ) THEN RAISE(
            ABORT,
            'invalid job market reassignment successor activation'
          ) END;
          SELECT CASE WHEN OLD.status='active'
            AND NEW.status NOT IN ('released','superseded')
            THEN RAISE(ABORT, 'invalid job market assignment status transition') END;
          SELECT CASE WHEN OLD.status='active' AND NEW.version!=OLD.version+1
            THEN RAISE(ABORT, 'job market assignment version must increment exactly once') END;
          SELECT CASE WHEN OLD.status='active' AND (
            NEW.ended_at IS NULL
            OR NEW.ended_actor_type IS NULL
            OR NEW.end_idempotency_key IS NULL
            OR NEW.end_request_fingerprint IS NULL
            OR NEW.ended_market_version IS NULL
          ) THEN RAISE(ABORT, 'terminal job market assignment evidence is required') END;

          SELECT CASE WHEN OLD.status='active'
            AND NEW.status='superseded'
            AND NOT EXISTS (
              SELECT 1
              FROM job_market_assignments successor
              WHERE successor.status='pending'
                AND successor.origin='reassign'
                AND successor.predecessor_assignment_id=OLD.id
                AND successor.predecessor_version=OLD.version
                AND successor.idempotency_key=NEW.end_idempotency_key
                AND successor.request_fingerprint=NEW.end_request_fingerprint
                AND successor.assigned_market_version=NEW.ended_market_version
                AND successor.created_actor_type=NEW.ended_actor_type
                AND successor.created_actor_id IS NEW.ended_actor_id
                AND successor.reason IS NEW.end_reason
            )
          THEN RAISE(
            ABORT,
            'job market assignment can only be superseded by its pending successor'
          ) END;

          SELECT CASE WHEN EXISTS (
            SELECT 1 FROM jobs
            WHERE card_id=OLD.card_id
              AND status IN ('queued','running','cancelling')
          ) OR EXISTS (
            SELECT 1
            FROM agent_sessions session
            JOIN jobs job ON job.id=session.job_id
            WHERE job.card_id=OLD.card_id
              AND session.status IN ('reserved','starting','running','idle','stopping')
          ) THEN RAISE(
            ABORT,
            'job market assignment cannot end while the card has active execution'
          ) END;
        END;

        CREATE TRIGGER job_market_assignment_delete
        BEFORE DELETE ON job_market_assignments
        BEGIN
          SELECT RAISE(
            ABORT,
            'job market assignment history is immutable'
          );
        END;

        CREATE TRIGGER job_market_assignment_release_market_cas
        AFTER UPDATE OF status ON job_market_assignments
        WHEN OLD.status='active' AND NEW.status='released'
        BEGIN
          UPDATE job_market_contracts
          SET status=CASE
                WHEN status IN ('assigned','rejected','cancelled') THEN 'open'
                ELSE status
              END,
              version=version+1,
              updated_at=NEW.ended_at,
              archived_at=CASE WHEN status='archived' THEN archived_at ELSE NULL END
          WHERE card_id=NEW.card_id
            AND version=NEW.ended_market_version-1
            AND status IN ('assigned','rejected','cancelled','accepted','archived');

          SELECT CASE WHEN changes()!=1
            THEN RAISE(ABORT, 'job market assignment release version changed concurrently') END;
        END;

        CREATE TRIGGER job_market_contract_assignment_transition
        BEFORE UPDATE OF status ON job_market_contracts
        WHEN NEW.status!=OLD.status
        BEGIN
          SELECT CASE WHEN NEW.status='assigned' AND NOT EXISTS (
            SELECT 1
            FROM job_market_assignments assignment
            WHERE assignment.card_id=NEW.card_id
              AND assignment.status='active'
              AND assignment.assigned_market_version=NEW.version
          ) THEN RAISE(
            ABORT,
            'job market assigned status requires an active canonical assignment'
          ) END;

          SELECT CASE WHEN NEW.status IN ('open','draft') AND EXISTS (
            SELECT 1
            FROM job_market_assignments assignment
            WHERE assignment.card_id=NEW.card_id
              AND assignment.status='active'
          ) THEN RAISE(
            ABORT,
            'release the active job market assignment before reopening or drafting the contract'
          ) END;
        END;

        CREATE TRIGGER job_market_assignment_profile_archive
        BEFORE UPDATE OF status ON agent_profiles
        WHEN OLD.status='active' AND NEW.status='archived'
          AND EXISTS (
            SELECT 1 FROM job_market_assignments assignment
            WHERE assignment.profile_id=OLD.id AND assignment.status='active'
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'agent profile has an active job market assignment'
          );
        END;

        CREATE TRIGGER job_market_assignment_card_scope_update
        BEFORE UPDATE OF board_id ON cards
        WHEN EXISTS (
          SELECT 1 FROM job_market_assignments assignment
          WHERE assignment.card_id=OLD.id AND assignment.board_id!=NEW.board_id
        )
        BEGIN
          SELECT RAISE(
            ABORT,
            'card board change would displace job market assignment history'
          );
        END;

        CREATE TRIGGER job_market_assignment_profile_scope_update
        BEFORE UPDATE OF board_id ON agent_profiles
        WHEN EXISTS (
          SELECT 1 FROM job_market_assignments assignment
          WHERE assignment.profile_id=OLD.id AND assignment.board_id!=NEW.board_id
        )
        BEGIN
          SELECT RAISE(
            ABORT,
            'profile board change would displace job market assignment history'
          );
        END;

        CREATE TRIGGER job_market_assignment_workspace_scope_update
        BEFORE UPDATE OF board_id, card_id ON workspaces
        WHEN EXISTS (
          SELECT 1 FROM job_market_assignments assignment
          WHERE assignment.workspace_id=OLD.id
            AND (
              assignment.board_id!=NEW.board_id
              OR (NEW.card_id IS NOT NULL AND assignment.card_id!=NEW.card_id)
            )
        )
        BEGIN
          SELECT RAISE(
            ABORT,
            'workspace scope change would displace job market assignment history'
          );
        END;

        CREATE TRIGGER jobs_job_assignment_insert
        BEFORE INSERT ON jobs
        WHEN NEW.job_assignment_id IS NOT NULL
          OR NEW.assigned_profile_id IS NOT NULL
          OR NEW.assignment_market_version IS NOT NULL
        BEGIN
          SELECT CASE WHEN
            NEW.job_assignment_id IS NULL
            OR NEW.assigned_profile_id IS NULL
            OR NEW.assignment_market_version IS NULL
          THEN RAISE(ABORT, 'job assignment identity must be complete') END;

          SELECT CASE WHEN NEW.status!='queued' OR NOT EXISTS (
            SELECT 1
            FROM job_market_assignments assignment
            JOIN workspaces workspace ON workspace.id=NEW.workspace_id
            WHERE assignment.id=NEW.job_assignment_id
              AND assignment.board_id=NEW.board_id
              AND assignment.card_id=NEW.card_id
              AND assignment.profile_id=NEW.assigned_profile_id
              AND assignment.assigned_market_version=NEW.assignment_market_version
              AND assignment.status='active'
              AND workspace.board_id=assignment.board_id
              AND workspace.status='active'
              AND (workspace.card_id IS NULL
                OR workspace.card_id=assignment.card_id)
              AND (assignment.workspace_id IS NULL
                OR assignment.workspace_id=workspace.id)
          ) THEN RAISE(ABORT, 'job assignment identity or scope is inconsistent') END;
        END;

        CREATE TRIGGER jobs_job_assignment_update
        BEFORE UPDATE OF
          job_assignment_id, assigned_profile_id, assignment_market_version,
          board_id, card_id, workspace_id
        ON jobs
        BEGIN
          SELECT CASE WHEN
            (NEW.job_assignment_id IS NULL)
              != (NEW.assigned_profile_id IS NULL)
            OR (NEW.job_assignment_id IS NULL)
              != (NEW.assignment_market_version IS NULL)
          THEN RAISE(ABORT, 'job assignment identity must be complete') END;

          SELECT CASE WHEN OLD.job_assignment_id IS NOT NULL AND (
            NEW.job_assignment_id IS NOT OLD.job_assignment_id
            OR NEW.assigned_profile_id IS NOT OLD.assigned_profile_id
            OR NEW.assignment_market_version IS NOT OLD.assignment_market_version
            OR NEW.board_id IS NOT OLD.board_id
            OR NEW.card_id IS NOT OLD.card_id
            OR NEW.workspace_id IS NOT OLD.workspace_id
          ) THEN RAISE(ABORT, 'job assignment identity is immutable') END;

          SELECT CASE WHEN OLD.job_assignment_id IS NULL
            AND NEW.job_assignment_id IS NOT NULL
            AND (NEW.status!='queued' OR NOT EXISTS (
              SELECT 1
              FROM job_market_assignments assignment
              JOIN workspaces workspace ON workspace.id=NEW.workspace_id
              WHERE assignment.id=NEW.job_assignment_id
                AND assignment.board_id=NEW.board_id
                AND assignment.card_id=NEW.card_id
                AND assignment.profile_id=NEW.assigned_profile_id
                AND assignment.assigned_market_version=NEW.assignment_market_version
                AND assignment.status='active'
                AND workspace.board_id=assignment.board_id
                AND workspace.status='active'
                AND (workspace.card_id IS NULL
                  OR workspace.card_id=assignment.card_id)
                AND (assignment.workspace_id IS NULL
                  OR assignment.workspace_id=workspace.id)
            ))
          THEN RAISE(ABORT, 'job assignment identity or scope is inconsistent') END;
        END;

        CREATE TRIGGER jobs_job_assignment_status
        BEFORE UPDATE OF status ON jobs
        WHEN NEW.job_assignment_id IS NOT NULL
          AND NEW.status IN ('queued','running','cancelling')
          AND NOT EXISTS (
            SELECT 1
            FROM job_market_assignments assignment
            JOIN workspaces workspace ON workspace.id=NEW.workspace_id
            WHERE assignment.id=NEW.job_assignment_id
              AND assignment.board_id=NEW.board_id
              AND assignment.card_id=NEW.card_id
              AND assignment.profile_id=NEW.assigned_profile_id
              AND assignment.assigned_market_version=NEW.assignment_market_version
              AND assignment.status='active'
              AND workspace.board_id=assignment.board_id
              AND workspace.status='active'
              AND (workspace.card_id IS NULL
                OR workspace.card_id=assignment.card_id)
              AND (assignment.workspace_id IS NULL
                OR assignment.workspace_id=workspace.id)
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'active job status requires an active canonical assignment'
          );
        END;

        CREATE TRIGGER agent_sessions_job_assignment_insert
        BEFORE INSERT ON agent_sessions
        WHEN NEW.job_assignment_id IS NOT NULL
          OR NEW.assigned_profile_id IS NOT NULL
          OR NEW.assignment_market_version IS NOT NULL
        BEGIN
          SELECT CASE WHEN
            NEW.job_assignment_id IS NULL
            OR NEW.assigned_profile_id IS NULL
            OR NEW.assignment_market_version IS NULL
          THEN RAISE(ABORT, 'agent session assignment identity must be complete') END;

          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM jobs job
            JOIN job_market_assignments assignment
              ON assignment.id=job.job_assignment_id
            WHERE job.id=NEW.job_id
              AND job.status='queued'
              AND job.workspace_id=NEW.workspace_id
              AND job.job_assignment_id=NEW.job_assignment_id
              AND job.assigned_profile_id=NEW.assigned_profile_id
              AND job.assignment_market_version=NEW.assignment_market_version
              AND assignment.status='active'
              AND (NEW.profile_id IS NULL OR NEW.profile_id=NEW.assigned_profile_id)
          ) THEN RAISE(ABORT, 'agent session assignment identity or scope is inconsistent') END;
        END;

        CREATE TRIGGER agent_sessions_job_assignment_update
        BEFORE UPDATE OF
          job_assignment_id, assigned_profile_id, assignment_market_version,
          job_id, workspace_id, profile_id
        ON agent_sessions
        BEGIN
          SELECT CASE WHEN
            (NEW.job_assignment_id IS NULL)
              != (NEW.assigned_profile_id IS NULL)
            OR (NEW.job_assignment_id IS NULL)
              != (NEW.assignment_market_version IS NULL)
          THEN RAISE(ABORT, 'agent session assignment identity must be complete') END;

          SELECT CASE WHEN OLD.job_assignment_id IS NOT NULL AND (
            NEW.job_assignment_id IS NOT OLD.job_assignment_id
            OR NEW.assigned_profile_id IS NOT OLD.assigned_profile_id
            OR NEW.assignment_market_version IS NOT OLD.assignment_market_version
            OR NEW.job_id IS NOT OLD.job_id
            OR NEW.workspace_id IS NOT OLD.workspace_id
          ) THEN RAISE(ABORT, 'agent session assignment identity is immutable') END;

          SELECT CASE WHEN OLD.job_assignment_id IS NULL
            AND NEW.job_assignment_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM jobs job
              JOIN job_market_assignments assignment
                ON assignment.id=job.job_assignment_id
              WHERE job.id=NEW.job_id
                AND job.status='queued'
                AND job.workspace_id=NEW.workspace_id
                AND job.job_assignment_id=NEW.job_assignment_id
                AND job.assigned_profile_id=NEW.assigned_profile_id
                AND job.assignment_market_version=NEW.assignment_market_version
                AND assignment.status='active'
                AND (NEW.profile_id IS NULL OR NEW.profile_id=NEW.assigned_profile_id)
            )
          THEN RAISE(ABORT, 'agent session assignment identity or scope is inconsistent') END;

          SELECT CASE WHEN OLD.job_assignment_id IS NOT NULL
            AND NEW.job_assignment_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM jobs job
              JOIN job_market_assignments assignment
                ON assignment.id=job.job_assignment_id
              WHERE job.id=NEW.job_id
                AND job.status IN ('queued','running','cancelling')
                AND job.workspace_id=NEW.workspace_id
                AND job.job_assignment_id=NEW.job_assignment_id
                AND job.assigned_profile_id=NEW.assigned_profile_id
                AND job.assignment_market_version=NEW.assignment_market_version
                AND assignment.status='active'
                AND (NEW.profile_id IS NULL OR NEW.profile_id=NEW.assigned_profile_id)
            )
          THEN RAISE(ABORT, 'agent session assignment identity or scope is inconsistent') END;
        END;

        CREATE TRIGGER agent_sessions_job_assignment_status
        BEFORE UPDATE OF status ON agent_sessions
        WHEN NEW.job_assignment_id IS NOT NULL
          AND NEW.status IN ('reserved','starting','running','idle','stopping')
          AND NOT EXISTS (
            SELECT 1
            FROM jobs job
            JOIN job_market_assignments assignment
              ON assignment.id=job.job_assignment_id
            WHERE job.id=NEW.job_id
              AND job.status IN ('queued','running','cancelling')
              AND job.workspace_id=NEW.workspace_id
              AND job.job_assignment_id=NEW.job_assignment_id
              AND job.assigned_profile_id=NEW.assigned_profile_id
              AND job.assignment_market_version=NEW.assignment_market_version
              AND assignment.status='active'
              AND (NEW.profile_id IS NULL OR NEW.profile_id=NEW.assigned_profile_id)
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'active agent session status requires an active canonical assignment'
          );
        END;

        CREATE TRIGGER os_events_job_assignment_insert
        BEFORE INSERT ON os_events
        WHEN NEW.kind GLOB 'job_market.assignment_*'
        BEGIN
          SELECT CASE WHEN
            NEW.source!='job-market'
            OR NEW.idempotency_key IS NULL
            OR NEW.card_id IS NULL
            OR NOT json_valid(NEW.payload)
            OR NOT EXISTS (
              SELECT 1
              FROM job_market_assignments assignment
              WHERE assignment.id=json_extract(NEW.payload, '$.assignment_id')
                AND assignment.board_id=NEW.board_id
                AND assignment.card_id=NEW.card_id
                AND assignment.workspace_id IS NEW.workspace_id
                AND json_extract(
                  NEW.payload,
                  '$.result.assignment.id'
                )=assignment.id
                AND json_extract(
                  NEW.payload,
                  '$.result.assignment.board_id'
                )=assignment.board_id
                AND json_extract(
                  NEW.payload,
                  '$.result.assignment.card_id'
                )=assignment.card_id
                AND json_extract(
                  NEW.payload,
                  '$.result.assignment.profile_id'
                )=assignment.profile_id
                AND json_extract(
                  NEW.payload,
                  '$.result.assignment.workspace_id'
                ) IS assignment.workspace_id
                AND json_extract(
                  NEW.payload,
                  '$.result.assignment.origin'
                )=assignment.origin
                AND json_extract(
                  NEW.payload,
                  '$.result.assignment.status'
                )=assignment.status
                AND json_extract(
                  NEW.payload,
                  '$.result.assignment.assigned_market_version'
                )=assignment.assigned_market_version
                AND json_extract(
                  NEW.payload,
                  '$.result.assignment.version'
                )=assignment.version
                AND json_extract(
                  NEW.payload,
                  '$.result.assignment.idempotency_key'
                )=assignment.idempotency_key
                AND json_extract(
                  NEW.payload,
                  '$.result.assignment.request_fingerprint'
                )=assignment.request_fingerprint
                AND (
                  (
                    (
                      (NEW.kind='job_market.assignment_claimed'
                        AND assignment.origin='claim')
                      OR (NEW.kind='job_market.assignment_assigned'
                        AND assignment.origin='assign')
                      OR (NEW.kind='job_market.assignment_reassigned'
                        AND assignment.origin='reassign')
                    )
                    AND assignment.status='active'
                    AND assignment.idempotency_key=NEW.idempotency_key
                    AND assignment.request_fingerprint=
                      json_extract(NEW.payload, '$.request_fingerprint')
                    AND json_extract(
                      NEW.payload,
                      '$.result.market.status'
                    )='assigned'
                    AND json_extract(
                      NEW.payload,
                      '$.result.market.market_version'
                    )=assignment.assigned_market_version
                  )
                  OR
                  (
                    NEW.kind='job_market.assignment_released'
                    AND assignment.status='released'
                    AND assignment.end_idempotency_key=NEW.idempotency_key
                    AND assignment.end_request_fingerprint=
                      json_extract(NEW.payload, '$.request_fingerprint')
                    AND json_extract(
                      NEW.payload,
                      '$.result.assignment.end_idempotency_key'
                    )=assignment.end_idempotency_key
                    AND json_extract(
                      NEW.payload,
                      '$.result.assignment.end_request_fingerprint'
                    )=assignment.end_request_fingerprint
                    AND json_extract(
                      NEW.payload,
                      '$.result.assignment.updated_at'
                    )=assignment.updated_at
                    AND json_extract(
                      NEW.payload,
                      '$.result.assignment.ended_at'
                    )=assignment.ended_at
                    AND json_extract(
                      NEW.payload,
                      '$.result.assignment.ended_actor_type'
                    )=assignment.ended_actor_type
                    AND json_extract(
                      NEW.payload,
                      '$.result.assignment.ended_actor_id'
                    ) IS assignment.ended_actor_id
                    AND json_extract(
                      NEW.payload,
                      '$.result.assignment.end_reason'
                    ) IS assignment.end_reason
                    AND json_extract(
                      NEW.payload,
                      '$.result.assignment.ended_market_version'
                    )=assignment.ended_market_version
                    AND json_extract(
                      NEW.payload,
                      '$.result.market.status'
                    ) IN ('open','accepted','archived')
                    AND json_extract(
                      NEW.payload,
                      '$.result.market.market_version'
                    )=assignment.ended_market_version
                  )
                )
            )
          THEN RAISE(
            ABORT,
            'job market assignment audit scope or command identity is inconsistent'
          ) END;
        END;

        CREATE TRIGGER os_events_job_assignment_identity_update
        BEFORE UPDATE ON os_events
        WHEN OLD.kind GLOB 'job_market.assignment_*'
          OR NEW.kind GLOB 'job_market.assignment_*'
        BEGIN
          SELECT RAISE(
            ABORT,
            'job market assignment audit identity is immutable'
          );
        END;

        CREATE TRIGGER os_events_job_assignment_delete
        BEFORE DELETE ON os_events
        WHEN OLD.kind GLOB 'job_market.assignment_*'
        BEGIN
          SELECT RAISE(
            ABORT,
            'job market assignment audit history is immutable'
          );
        END;
      `)
      if (cardColumns.has('owner_agent_id')) {
        db.exec(`
          CREATE TRIGGER job_market_assignment_legacy_owner_insert
          BEFORE INSERT ON job_market_assignments
          WHEN EXISTS (
            SELECT 1 FROM cards
            WHERE id=NEW.card_id AND owner_agent_id IS NOT NULL
          )
          BEGIN
            SELECT RAISE(
              ABORT,
              'card has a legacy owner; clear it before canonical assignment'
            );
          END;

          CREATE TRIGGER job_market_assignment_legacy_owner_update
          BEFORE UPDATE OF owner_agent_id ON cards
          WHEN NEW.owner_agent_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM job_market_assignments assignment
              WHERE assignment.card_id=NEW.id AND assignment.status='active'
            )
          BEGIN
            SELECT RAISE(
              ABORT,
              'card has an active canonical job market assignment'
            );
          END;
        `)
      }
    },
  },
  {
    id: '017-job-assignment-runtime-binding',
    apply(db) {
      const hasMigration016 = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id='016-job-market-assignment-lifecycle'`).get()
      if (!hasMigration016) {
        throw new Error(
          'migration 017-job-assignment-runtime-binding requires 016-job-market-assignment-lifecycle',
        )
      }
      const requiredColumns: Record<string, string[]> = {
        cards: ['id', 'board_id', 'owner_agent_id'],
        jobs: [
          'id',
          'board_id',
          'card_id',
          'workspace_id',
          'status',
          'job_assignment_id',
          'assigned_profile_id',
          'assignment_market_version',
        ],
        agent_sessions: [
          'id',
          'job_id',
          'workspace_id',
          'profile_id',
          'status',
          'job_assignment_id',
          'assigned_profile_id',
          'assignment_market_version',
        ],
        job_market_assignments: [
          'id',
          'board_id',
          'card_id',
          'profile_id',
          'workspace_id',
          'status',
          'assigned_market_version',
          'version',
        ],
        job_market_contracts: [
          'card_id',
          'version',
        ],
        workspaces: [
          'id',
          'board_id',
          'status',
        ],
      }
      const columnsByTable = new Map<string, Set<string>>()
      for (const [table, columns] of Object.entries(requiredColumns)) {
        const available = new Set(
          (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>)
            .map((column) => column.name),
        )
        columnsByTable.set(table, available)
        if (columns.some((column) => !available.has(column))) {
          throw new Error(
            'migration 017-job-assignment-runtime-binding requires complete assignment runtime columns',
          )
        }
      }
      const workspaceHasCardId = columnsByTable.get('workspaces')?.has('card_id') === true
      const workspaceRuntimeUpdateColumns = workspaceHasCardId
        ? 'status, board_id, card_id'
        : 'status, board_id'
      const workspaceRuntimeScopeChange = workspaceHasCardId
        ? 'OR NEW.card_id IS NOT OLD.card_id'
        : ''

      db.exec(`
        CREATE TRIGGER jobs_job_assignment_required_insert
        BEFORE INSERT ON jobs
        WHEN NEW.card_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM job_market_assignments assignment
            WHERE assignment.card_id=NEW.card_id
              AND assignment.status='active'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM job_market_assignments assignment
            JOIN job_market_contracts market
              ON market.card_id=assignment.card_id
              AND market.version=assignment.assigned_market_version
            WHERE assignment.id=NEW.job_assignment_id
              AND assignment.board_id=NEW.board_id
              AND assignment.card_id=NEW.card_id
              AND assignment.profile_id=NEW.assigned_profile_id
              AND assignment.assigned_market_version=NEW.assignment_market_version
              AND assignment.status='active'
              AND assignment.version=1
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'job assignment identity must be complete: active job assignment requires exact frozen job identity'
          );
        END;

        CREATE TRIGGER jobs_job_assignment_required_activation
        BEFORE UPDATE OF status, board_id, card_id ON jobs
        WHEN NEW.card_id IS NOT NULL
          AND (
            NEW.status IN ('running','cancelling')
            OR NEW.board_id IS NOT OLD.board_id
            OR NEW.card_id IS NOT OLD.card_id
          )
          AND EXISTS (
            SELECT 1
            FROM job_market_assignments assignment
            WHERE assignment.card_id=NEW.card_id
              AND assignment.status='active'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM job_market_assignments assignment
            WHERE assignment.id=NEW.job_assignment_id
              AND assignment.board_id=NEW.board_id
              AND assignment.card_id=NEW.card_id
              AND assignment.profile_id=NEW.assigned_profile_id
              AND assignment.assigned_market_version=NEW.assignment_market_version
              AND assignment.status='active'
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'active job assignment requires exact frozen job identity before execution'
          );
        END;

        CREATE TRIGGER jobs_job_assignment_binding_current_guard
        BEFORE UPDATE OF
          workspace_id, job_assignment_id, assigned_profile_id, assignment_market_version
        ON jobs
        WHEN OLD.job_assignment_id IS NULL
          AND NEW.job_assignment_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM job_market_assignments assignment
            JOIN job_market_contracts market
              ON market.card_id=assignment.card_id
              AND market.version=assignment.assigned_market_version
            WHERE assignment.id=NEW.job_assignment_id
              AND assignment.board_id=NEW.board_id
              AND assignment.card_id=NEW.card_id
              AND assignment.profile_id=NEW.assigned_profile_id
              AND assignment.assigned_market_version=NEW.assignment_market_version
              AND assignment.status='active'
              AND assignment.version=1
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'new job assignment binding requires the current active market assignment'
          );
        END;

        CREATE TRIGGER jobs_job_assignment_session_binding_guard
        BEFORE UPDATE OF
          workspace_id, job_assignment_id, assigned_profile_id, assignment_market_version
        ON jobs
        WHEN OLD.job_assignment_id IS NULL
          AND NEW.job_assignment_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM agent_sessions session
            WHERE session.job_id=NEW.id
              AND (
                session.job_assignment_id IS NOT NEW.job_assignment_id
                OR session.assigned_profile_id IS NOT NEW.assigned_profile_id
                OR session.assignment_market_version IS NOT NEW.assignment_market_version
                OR session.workspace_id IS NOT NEW.workspace_id
                OR (
                  session.profile_id IS NOT NULL
                  AND session.profile_id IS NOT NEW.assigned_profile_id
                )
              )
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'job assignment binding would strand an unbound agent session'
          );
        END;

        CREATE TRIGGER agent_sessions_job_assignment_required_insert
        BEFORE INSERT ON agent_sessions
        WHEN NEW.job_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM jobs job
            WHERE job.id=NEW.job_id
              AND (
                job.job_assignment_id IS NOT NULL
                OR (
                  NEW.status IN ('reserved','starting','running','idle','stopping')
                  AND EXISTS (
                    SELECT 1
                    FROM job_market_assignments assignment
                    WHERE assignment.card_id=job.card_id
                      AND assignment.status='active'
                  )
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jobs job
            JOIN job_market_assignments assignment
              ON assignment.id=job.job_assignment_id
            JOIN job_market_contracts market
              ON market.card_id=assignment.card_id
              AND market.version=assignment.assigned_market_version
            WHERE job.id=NEW.job_id
              AND job.job_assignment_id=NEW.job_assignment_id
              AND job.assigned_profile_id=NEW.assigned_profile_id
              AND job.assignment_market_version=NEW.assignment_market_version
              AND job.workspace_id=NEW.workspace_id
              AND assignment.board_id=job.board_id
              AND assignment.card_id=job.card_id
              AND assignment.profile_id=job.assigned_profile_id
              AND assignment.assigned_market_version=job.assignment_market_version
              AND assignment.status='active'
              AND assignment.version=1
              AND (NEW.profile_id IS NULL
                OR NEW.profile_id=job.assigned_profile_id)
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'agent session assignment identity or scope is inconsistent; agent session assignment identity must be complete: bound job requires exact frozen agent session assignment identity'
          );
        END;

        CREATE TRIGGER agent_sessions_job_assignment_binding_current_guard
        BEFORE UPDATE OF
          job_id, workspace_id, job_assignment_id,
          assigned_profile_id, assignment_market_version
        ON agent_sessions
        WHEN OLD.job_assignment_id IS NULL
          AND NEW.job_assignment_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM jobs job
            JOIN job_market_assignments assignment
              ON assignment.id=job.job_assignment_id
            JOIN job_market_contracts market
              ON market.card_id=assignment.card_id
              AND market.version=assignment.assigned_market_version
            WHERE job.id=NEW.job_id
              AND job.job_assignment_id=NEW.job_assignment_id
              AND job.assigned_profile_id=NEW.assigned_profile_id
              AND job.assignment_market_version=NEW.assignment_market_version
              AND job.workspace_id=NEW.workspace_id
              AND assignment.board_id=job.board_id
              AND assignment.card_id=job.card_id
              AND assignment.profile_id=job.assigned_profile_id
              AND assignment.assigned_market_version=job.assignment_market_version
              AND assignment.status='active'
              AND assignment.version=1
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'new agent session assignment binding requires the current active market assignment'
          );
        END;

        CREATE TRIGGER agent_sessions_job_assignment_required_update
        BEFORE UPDATE OF
          job_id, workspace_id, profile_id,
          job_assignment_id, assigned_profile_id, assignment_market_version
        ON agent_sessions
        WHEN NEW.job_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM jobs job
            WHERE job.id=NEW.job_id
              AND (
                job.job_assignment_id IS NOT NULL
                OR (
                  NEW.status IN ('reserved','starting','running','idle','stopping')
                  AND EXISTS (
                    SELECT 1
                    FROM job_market_assignments assignment
                    WHERE assignment.card_id=job.card_id
                      AND assignment.status='active'
                  )
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jobs job
            JOIN job_market_assignments assignment
              ON assignment.id=job.job_assignment_id
            WHERE job.id=NEW.job_id
              AND job.job_assignment_id=NEW.job_assignment_id
              AND job.assigned_profile_id=NEW.assigned_profile_id
              AND job.assignment_market_version=NEW.assignment_market_version
              AND job.workspace_id=NEW.workspace_id
              AND assignment.board_id=job.board_id
              AND assignment.card_id=job.card_id
              AND assignment.profile_id=job.assigned_profile_id
              AND assignment.assigned_market_version=job.assignment_market_version
              AND assignment.status='active'
              AND (NEW.profile_id IS NULL
                OR NEW.profile_id=job.assigned_profile_id)
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'agent session assignment identity is immutable and its scope is inconsistent: bound job requires exact frozen agent session assignment identity'
          );
        END;

        CREATE TRIGGER agent_sessions_job_assignment_required_status
        BEFORE UPDATE OF status ON agent_sessions
        WHEN NEW.status IN ('reserved','starting','running','idle','stopping')
          AND NEW.job_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM jobs job
            WHERE job.id=NEW.job_id
              AND (
                job.job_assignment_id IS NOT NULL
                OR EXISTS (
                  SELECT 1
                  FROM job_market_assignments assignment
                  WHERE assignment.card_id=job.card_id
                    AND assignment.status='active'
                )
              )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jobs job
            JOIN job_market_assignments assignment
              ON assignment.id=job.job_assignment_id
            WHERE job.id=NEW.job_id
              AND job.status IN ('queued','running','cancelling')
              AND job.job_assignment_id=NEW.job_assignment_id
              AND job.assigned_profile_id=NEW.assigned_profile_id
              AND job.assignment_market_version=NEW.assignment_market_version
              AND job.workspace_id=NEW.workspace_id
              AND assignment.board_id=job.board_id
              AND assignment.card_id=job.card_id
              AND assignment.profile_id=job.assigned_profile_id
              AND assignment.assigned_market_version=job.assignment_market_version
              AND assignment.status='active'
              AND (NEW.profile_id IS NULL
                OR NEW.profile_id=job.assigned_profile_id)
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'active agent session status requires an active canonical assignment with exact frozen identity'
          );
        END;

        CREATE TRIGGER job_assignment_workspace_runtime_guard
        BEFORE UPDATE OF ${workspaceRuntimeUpdateColumns} ON workspaces
        WHEN (
            (OLD.status='active' AND NEW.status!='active')
            OR NEW.board_id IS NOT OLD.board_id
            ${workspaceRuntimeScopeChange}
          )
          AND EXISTS (
            SELECT 1
            FROM jobs job
            JOIN job_market_assignments assignment
              ON assignment.id=job.job_assignment_id
              AND assignment.board_id=job.board_id
              AND assignment.card_id=job.card_id
              AND assignment.profile_id=job.assigned_profile_id
              AND assignment.assigned_market_version=job.assignment_market_version
            WHERE job.workspace_id=OLD.id
              AND job.board_id=OLD.board_id
              AND job.status IN ('running','cancelling')
          )
        BEGIN
          SELECT RAISE(
            ABORT,
            'workspace has an active assignment runtime and cannot change status or scope'
          );
        END;
      `)

      db.exec('DROP TRIGGER IF EXISTS job_market_assignment_legacy_owner_update')
      const legacyAgentColumns = new Set(
        (db.prepare("PRAGMA table_info('agents')").all() as Array<{ name: string }>)
          .map((column) => column.name),
      )
      const canProjectLegacyOwner = (
        columnsByTable.get('agent_sessions')?.has('agent_id') === true
        && columnsByTable.get('agent_sessions')?.has('conversation_id') === true
        && columnsByTable.get('agent_sessions')?.has('external_id') === true
        && legacyAgentColumns.has('id')
        && legacyAgentColumns.has('board_id')
        && legacyAgentColumns.has('session_id')
      )
      if (canProjectLegacyOwner) {
        db.exec(`
          CREATE TRIGGER job_market_assignment_legacy_owner_update
          BEFORE UPDATE OF owner_agent_id ON cards
          WHEN NEW.owner_agent_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM job_market_assignments assignment
              WHERE assignment.card_id=NEW.id
                AND assignment.status='active'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM job_market_assignments assignment
              JOIN jobs job
                ON job.job_assignment_id=assignment.id
                AND job.board_id=assignment.board_id
                AND job.card_id=assignment.card_id
                AND job.assigned_profile_id=assignment.profile_id
                AND job.assignment_market_version=assignment.assigned_market_version
              JOIN agent_sessions session
                ON session.job_id=job.id
                AND session.job_assignment_id=job.job_assignment_id
                AND session.assigned_profile_id=job.assigned_profile_id
                AND session.assignment_market_version=job.assignment_market_version
                AND session.workspace_id=job.workspace_id
                AND session.agent_id=NEW.owner_agent_id
                AND session.profile_id=assignment.profile_id
                AND session.conversation_id IS NOT NULL
                AND session.external_id IS NOT NULL
              JOIN agent_conversations conversation
                ON conversation.id=session.conversation_id
                AND conversation.board_id=assignment.board_id
                AND conversation.profile_id=assignment.profile_id
                AND conversation.status='active'
              JOIN agents owner
                ON owner.id=NEW.owner_agent_id
                AND owner.board_id=assignment.board_id
                AND owner.session_id=('agent-os:' || job.id)
              WHERE assignment.card_id=NEW.id
                AND assignment.board_id=NEW.board_id
                AND assignment.status='active'
                AND job.status IN ('running','cancelling')
                AND session.status IN ('running','idle','stopping')
                AND (assignment.workspace_id IS NULL
                  OR assignment.workspace_id=job.workspace_id)
            )
          BEGIN
            SELECT RAISE(
              ABORT,
              'card has an active canonical job market assignment without a matching active assignment runtime'
            );
          END;
        `)
      } else {
        db.exec(`
          CREATE TRIGGER job_market_assignment_legacy_owner_update
          BEFORE UPDATE OF owner_agent_id ON cards
          WHEN NEW.owner_agent_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM job_market_assignments assignment
              WHERE assignment.card_id=NEW.id
                AND assignment.status='active'
            )
          BEGIN
            SELECT RAISE(
              ABORT,
              'card has an active canonical job market assignment'
            );
          END;
        `)
      }
    },
  },
  {
    id: '018-knowledge-persistence',
    apply(db) {
      const hasMigration017 = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id='017-job-assignment-runtime-binding'`).get()
      if (!hasMigration017) {
        throw new Error(
          'migration 018-knowledge-persistence requires 017-job-assignment-runtime-binding',
        )
      }
      const prerequisites = (db.prepare(`SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type='table' AND name IN (
          'boards', 'cards', 'workspaces', 'jobs', 'agent_sessions',
          'agent_profiles', 'task_contracts', 'delivery_reports'
        )`).get() as { count: number }).count
      if (prerequisites !== 8) {
        throw new Error(
          'migration 018-knowledge-persistence requires complete Agent OS scope tables',
        )
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_sources (
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
          id TEXT NOT NULL
            CHECK(length(id)=67
              AND substr(id, 1, 3)='ks_'
              AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
          source_kind TEXT NOT NULL
            CHECK(source_kind IN (
              'agents', 'readme', 'documentation', 'convention', 'architecture',
              'code_symbol', 'git_history', 'git_blame', 'discussion_answer',
              'decision', 'verified_delivery', 'gotcha', 'graphify', 'gitnexus',
              'manual'
            )),
          trust_class TEXT NOT NULL
            CHECK(trust_class IN ('instruction', 'reference', 'evidence', 'untrusted')),
          title TEXT NOT NULL CHECK(length(title)>0),
          locator TEXT NOT NULL CHECK(length(locator)>0),
          normalized_locator TEXT NOT NULL CHECK(length(normalized_locator)>0),
          source_revision TEXT NOT NULL CHECK(length(source_revision)>0),
          content_sha256 TEXT NOT NULL
            CHECK(length(content_sha256)=64
              AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
          freshness_policy TEXT NOT NULL
            CHECK(freshness_policy IN (
              'commit_exact', 'path_hash', 'external_revision', 'manual_until_superseded'
            )),
          freshness_state TEXT NOT NULL
            CHECK(freshness_state IN ('fresh', 'stale', 'unknown', 'contradicted')),
          redaction_state TEXT NOT NULL
            CHECK(redaction_state IN ('none', 'redacted', 'withheld')),
          content_state TEXT NOT NULL
            CHECK(content_state IN ('present', 'purged', 'withheld')),
          ingest_state TEXT NOT NULL
            CHECK(ingest_state IN ('active', 'excluded', 'failed', 'superseded', 'forgotten')),
          access_scope_json TEXT NOT NULL
            CHECK(json_valid(access_scope_json)
              AND json(access_scope_json)=access_scope_json
              AND json_type(access_scope_json)='object'
              AND length(CAST(access_scope_json AS BLOB))<=8000000
              AND (
                (
                  json_type(access_scope_json, '$.kind') IS 'text'
                  AND json_extract(access_scope_json, '$.kind')='board'
                  AND json_remove(access_scope_json, '$.kind')='{}'
                )
                OR (
                  json_type(access_scope_json, '$.kind') IS 'text'
                  AND json_extract(access_scope_json, '$.kind')='workspace'
                  AND json_type(access_scope_json, '$.workspace_id') IS 'text'
                  AND json_remove(
                    access_scope_json, '$.kind', '$.workspace_id'
                  )='{}'
                )
                OR (
                  json_type(access_scope_json, '$.kind') IS 'text'
                  AND json_extract(access_scope_json, '$.kind')='contract'
                  AND json_type(access_scope_json, '$.card_id') IS 'integer'
                  AND json_type(
                    access_scope_json, '$.contract_version'
                  ) IS 'integer'
                  AND json_remove(
                    access_scope_json,
                    '$.kind',
                    '$.card_id',
                    '$.contract_version'
                  )='{}'
                )
                OR (
                  json_type(access_scope_json, '$.kind') IS 'text'
                  AND json_extract(access_scope_json, '$.kind')='job'
                  AND json_type(access_scope_json, '$.job_id') IS 'text'
                  AND json_remove(
                    access_scope_json, '$.kind', '$.job_id'
                  )='{}'
                )
                OR (
                  json_type(access_scope_json, '$.kind') IS 'text'
                  AND json_extract(access_scope_json, '$.kind')='profile'
                  AND json_type(access_scope_json, '$.profile_id') IS 'text'
                  AND json_remove(
                    access_scope_json, '$.kind', '$.profile_id'
                  )='{}'
                )
                OR (
                  json_type(access_scope_json, '$.kind') IS 'text'
                  AND json_extract(access_scope_json, '$.kind')='session'
                  AND json_type(access_scope_json, '$.session_id') IS 'text'
                  AND json_remove(
                    access_scope_json, '$.kind', '$.session_id'
                  )='{}'
                )
              )),
          targets_json TEXT NOT NULL
            CHECK(json_valid(targets_json)
              AND json(targets_json)=targets_json
              AND json_type(targets_json)='object'
              AND length(CAST(targets_json AS BLOB))<=8000000
              AND json_remove(
                targets_json,
                '$.board_id',
                '$.workspace_id',
                '$.card_id',
                '$.contract_ref',
                '$.contract_version',
                '$.contract_snapshot_sha256',
                '$.job_id',
                '$.profile_id',
                '$.session_id',
                '$.delivery_report_id'
              )='{}'
              AND json_type(targets_json, '$.board_id') IS 'integer'
              AND (
                json_type(targets_json, '$.workspace_id') IS 'text'
                OR json_type(targets_json, '$.workspace_id') IS 'null'
              )
              AND (
                json_type(targets_json, '$.card_id') IS 'integer'
                OR json_type(targets_json, '$.card_id') IS 'null'
              )
              AND (
                json_type(targets_json, '$.contract_ref') IS 'text'
                OR json_type(targets_json, '$.contract_ref') IS 'null'
              )
              AND (
                json_type(targets_json, '$.contract_version') IS 'integer'
                OR json_type(targets_json, '$.contract_version') IS 'null'
              )
              AND (
                json_type(
                  targets_json, '$.contract_snapshot_sha256'
                ) IS 'text'
                OR json_type(
                  targets_json, '$.contract_snapshot_sha256'
                ) IS 'null'
              )
              AND (
                json_type(targets_json, '$.job_id') IS 'text'
                OR json_type(targets_json, '$.job_id') IS 'null'
              )
              AND (
                json_type(targets_json, '$.profile_id') IS 'text'
                OR json_type(targets_json, '$.profile_id') IS 'null'
              )
              AND (
                json_type(targets_json, '$.session_id') IS 'text'
                OR json_type(targets_json, '$.session_id') IS 'null'
              )
              AND (
                json_type(targets_json, '$.delivery_report_id') IS 'null'
                OR (
                  json_type(
                    targets_json, '$.delivery_report_id'
                  ) IS 'text'
                  AND length(json_extract(
                    targets_json, '$.delivery_report_id'
                  )) BETWEEN 1 AND 256
                  AND trim(json_extract(
                    targets_json, '$.delivery_report_id'
                  ))=json_extract(targets_json, '$.delivery_report_id')
                )
              )),
          provenance_json TEXT NOT NULL
            CHECK(json_valid(provenance_json)
              AND json(provenance_json)=provenance_json
              AND json_type(provenance_json)='object'
              AND length(CAST(provenance_json AS BLOB))<=8000000
              AND json_remove(
                provenance_json,
                '$.repository_key',
                '$.base_commit_sha',
                '$.worktree_state_hash',
                '$.relative_root',
                '$.adapter_id',
                '$.adapter_version',
                '$.adapter_index_commit_sha',
                '$.observed_at'
              )='{}'
              AND json_type(
                provenance_json, '$.repository_key'
              ) IS 'text'
              AND length(json_extract(
                provenance_json, '$.repository_key'
              )) BETWEEN 1 AND 256
              AND trim(json_extract(
                provenance_json, '$.repository_key'
              ))=json_extract(provenance_json, '$.repository_key')
              AND trim(
                json_extract(provenance_json, '$.repository_key'),
                ' ' || char(160) || char(5760)
                  || char(8192) || char(8193) || char(8194) || char(8195)
                  || char(8196) || char(8197) || char(8198) || char(8199)
                  || char(8200) || char(8201) || char(8202)
                  || char(8232) || char(8233) || char(8239) || char(8287)
                  || char(12288) || char(65279)
              )=json_extract(provenance_json, '$.repository_key')
              AND instr(json_extract(
                provenance_json, '$.repository_key'
              ), char(0))=0
              AND json_extract(
                provenance_json, '$.repository_key'
              ) NOT GLOB (
                '*[' || char(1) || '-' || char(31)
                || char(127) || '-' || char(159) || ']*'
              )
              AND json_type(
                provenance_json, '$.base_commit_sha'
              ) IS 'text'
              AND length(json_extract(
                provenance_json, '$.base_commit_sha'
              )) IN (40, 64)
              AND json_extract(
                provenance_json, '$.base_commit_sha'
              ) NOT GLOB '*[^0-9a-f]*'
              AND (
                json_type(
                  provenance_json, '$.worktree_state_hash'
                ) IS 'null'
                OR (
                  json_type(
                    provenance_json, '$.worktree_state_hash'
                  ) IS 'text'
                  AND length(json_extract(
                    provenance_json, '$.worktree_state_hash'
                  ))=64
                  AND json_extract(
                    provenance_json, '$.worktree_state_hash'
                  ) NOT GLOB '*[^0-9a-f]*'
                )
              )
              AND json_type(
                provenance_json, '$.relative_root'
              ) IS 'text'
              AND length(json_extract(
                provenance_json, '$.relative_root'
              )) BETWEEN 1 AND 4096
              AND trim(json_extract(
                provenance_json, '$.relative_root'
              ))=json_extract(provenance_json, '$.relative_root')
              AND trim(
                json_extract(provenance_json, '$.relative_root'),
                ' ' || char(160) || char(5760)
                  || char(8192) || char(8193) || char(8194) || char(8195)
                  || char(8196) || char(8197) || char(8198) || char(8199)
                  || char(8200) || char(8201) || char(8202)
                  || char(8232) || char(8233) || char(8239) || char(8287)
                  || char(12288) || char(65279)
              )=json_extract(provenance_json, '$.relative_root')
              AND instr(json_extract(
                provenance_json, '$.relative_root'
              ), char(0))=0
              AND json_extract(
                provenance_json, '$.relative_root'
              ) NOT GLOB (
                '*[' || char(1) || '-' || char(31)
                || char(127) || '-' || char(159) || ']*'
              )
              AND substr(json_extract(
                provenance_json, '$.relative_root'
              ), 1, 1)!='/'
              AND instr(json_extract(
                provenance_json, '$.relative_root'
              ), char(92))=0
              AND json_extract(
                provenance_json, '$.relative_root'
              ) NOT GLOB '[A-Za-z]:*'
              AND (
                json_extract(provenance_json, '$.relative_root')='.'
                OR (
                  json_extract(provenance_json, '$.relative_root')!='..'
                  AND instr(json_extract(
                    provenance_json, '$.relative_root'
                  ), '//')=0
                  AND substr(json_extract(
                    provenance_json, '$.relative_root'
                  ), -1, 1)!='/'
                  AND substr(json_extract(
                    provenance_json, '$.relative_root'
                  ), 1, 2)!='./'
                  AND substr(json_extract(
                    provenance_json, '$.relative_root'
                  ), 1, 3)!='../'
                  AND json_extract(
                    provenance_json, '$.relative_root'
                  ) NOT LIKE '%/.'
                  AND json_extract(
                    provenance_json, '$.relative_root'
                  ) NOT LIKE '%/..'
                  AND instr(json_extract(
                    provenance_json, '$.relative_root'
                  ), '/./')=0
                  AND instr(json_extract(
                    provenance_json, '$.relative_root'
                  ), '/../')=0
                )
              )
              AND json_type(provenance_json, '$.adapter_id') IS 'text'
              AND length(json_extract(
                provenance_json, '$.adapter_id'
              )) BETWEEN 1 AND 256
              AND trim(json_extract(
                provenance_json, '$.adapter_id'
              ))=json_extract(provenance_json, '$.adapter_id')
              AND trim(
                json_extract(provenance_json, '$.adapter_id'),
                ' ' || char(160) || char(5760)
                  || char(8192) || char(8193) || char(8194) || char(8195)
                  || char(8196) || char(8197) || char(8198) || char(8199)
                  || char(8200) || char(8201) || char(8202)
                  || char(8232) || char(8233) || char(8239) || char(8287)
                  || char(12288) || char(65279)
              )=json_extract(provenance_json, '$.adapter_id')
              AND instr(json_extract(
                provenance_json, '$.adapter_id'
              ), char(0))=0
              AND json_extract(
                provenance_json, '$.adapter_id'
              ) NOT GLOB (
                '*[' || char(1) || '-' || char(31)
                || char(127) || '-' || char(159) || ']*'
              )
              AND json_type(
                provenance_json, '$.adapter_version'
              ) IS 'text'
              AND length(json_extract(
                provenance_json, '$.adapter_version'
              )) BETWEEN 1 AND 256
              AND trim(json_extract(
                provenance_json, '$.adapter_version'
              ))=json_extract(provenance_json, '$.adapter_version')
              AND trim(
                json_extract(provenance_json, '$.adapter_version'),
                ' ' || char(160) || char(5760)
                  || char(8192) || char(8193) || char(8194) || char(8195)
                  || char(8196) || char(8197) || char(8198) || char(8199)
                  || char(8200) || char(8201) || char(8202)
                  || char(8232) || char(8233) || char(8239) || char(8287)
                  || char(12288) || char(65279)
              )=json_extract(provenance_json, '$.adapter_version')
              AND instr(json_extract(
                provenance_json, '$.adapter_version'
              ), char(0))=0
              AND json_extract(
                provenance_json, '$.adapter_version'
              ) NOT GLOB (
                '*[' || char(1) || '-' || char(31)
                || char(127) || '-' || char(159) || ']*'
              )
              AND (
                json_type(
                  provenance_json, '$.adapter_index_commit_sha'
                ) IS 'null'
                OR (
                  json_type(
                    provenance_json, '$.adapter_index_commit_sha'
                  ) IS 'text'
                  AND length(json_extract(
                    provenance_json, '$.adapter_index_commit_sha'
                  )) IN (40, 64)
                  AND json_extract(
                    provenance_json, '$.adapter_index_commit_sha'
                  ) NOT GLOB '*[^0-9a-f]*'
                )
              )
              AND json_type(
                provenance_json, '$.observed_at'
              ) IS 'text'
              AND length(json_extract(
                provenance_json, '$.observed_at'
              ))=24
              AND substr(json_extract(
                provenance_json, '$.observed_at'
              ), 5, 1)='-'
              AND substr(json_extract(
                provenance_json, '$.observed_at'
              ), 8, 1)='-'
              AND substr(json_extract(
                provenance_json, '$.observed_at'
              ), 11, 1)='T'
              AND substr(json_extract(
                provenance_json, '$.observed_at'
              ), 14, 1)=':'
              AND substr(json_extract(
                provenance_json, '$.observed_at'
              ), 17, 1)=':'
              AND substr(json_extract(
                provenance_json, '$.observed_at'
              ), 20, 1)='.'
              AND substr(json_extract(
                provenance_json, '$.observed_at'
              ), 24, 1)='Z'
              AND substr(json_extract(
                provenance_json, '$.observed_at'
              ), 12, 2) BETWEEN '00' AND '23'
              AND substr(json_extract(
                provenance_json, '$.observed_at'
              ), 15, 2) BETWEEN '00' AND '59'
              AND substr(json_extract(
                provenance_json, '$.observed_at'
              ), 18, 2) BETWEEN '00' AND '59'
              AND strftime(
                '%Y-%m-%dT%H:%M:%fZ',
                json_extract(provenance_json, '$.observed_at')
              )=json_extract(provenance_json, '$.observed_at')),
          created_at TEXT NOT NULL CHECK(length(created_at)>0),
          updated_at TEXT NOT NULL CHECK(length(updated_at)>0),
          PRIMARY KEY(board_id, id),
          CHECK(ingest_state!='forgotten' OR content_state='purged'),
          CHECK(
            (redaction_state='withheld' AND content_state='withheld')
            OR (redaction_state!='withheld' AND content_state!='withheld')
          )
        );

        CREATE TABLE IF NOT EXISTS knowledge_chunks (
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
          id TEXT NOT NULL
            CHECK(length(id)=67
              AND substr(id, 1, 3)='kc_'
              AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
          source_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK(ordinal>=0),
          content TEXT NOT NULL,
          content_sha256 TEXT NOT NULL
            CHECK(length(content_sha256)=64
              AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
          character_count INTEGER NOT NULL
            CHECK(character_count BETWEEN 0 AND 2000000),
          byte_count INTEGER NOT NULL
            CHECK(byte_count BETWEEN 0 AND 8000000
              AND byte_count=length(CAST(content AS BLOB))),
          estimated_tokens INTEGER NOT NULL
            CHECK(estimated_tokens BETWEEN 0 AND 10000000),
          source_range_json TEXT NOT NULL
            CHECK(json_valid(source_range_json)
              AND json(source_range_json)=source_range_json
              AND json_type(source_range_json)='object'
              AND length(CAST(source_range_json AS BLOB))<=8000000
              AND json_remove(
                source_range_json,
                '$.start_line',
                '$.end_line',
                '$.start_byte',
                '$.end_byte'
              )='{}'
              AND source_range_json -> '$.start_byte' IS NOT '-0'
              AND (
                (
                  json_type(source_range_json, '$.start_line') IS 'null'
                  AND json_type(source_range_json, '$.end_line') IS 'null'
                )
                OR (
                  json_type(
                    source_range_json, '$.start_line'
                  ) IS 'integer'
                  AND json_type(
                    source_range_json, '$.end_line'
                  ) IS 'integer'
                  AND json_extract(source_range_json, '$.start_line')
                    BETWEEN 1 AND 9007199254740991
                  AND json_extract(source_range_json, '$.end_line')
                    BETWEEN json_extract(source_range_json, '$.start_line')
                      AND 9007199254740991
                )
              )
              AND (
                (
                  json_type(source_range_json, '$.start_byte') IS 'null'
                  AND json_type(source_range_json, '$.end_byte') IS 'null'
                )
                OR (
                  json_type(
                    source_range_json, '$.start_byte'
                  ) IS 'integer'
                  AND json_type(
                    source_range_json, '$.end_byte'
                  ) IS 'integer'
                  AND json_extract(source_range_json, '$.start_byte')
                    BETWEEN 0 AND 9007199254740991
                  AND json_extract(source_range_json, '$.end_byte')
                    BETWEEN 1 AND 9007199254740991
                  AND json_extract(source_range_json, '$.end_byte')
                    > json_extract(source_range_json, '$.start_byte')
                )
              )),
          symbol_json TEXT
            CHECK(symbol_json IS NULL OR (
              json_valid(symbol_json)
              AND json(symbol_json)=symbol_json
              AND json_type(symbol_json)='object'
              AND length(CAST(symbol_json AS BLOB))<=8000000
              AND json_remove(
                symbol_json,
                '$.language',
                '$.qualified_name',
                '$.symbol_kind',
                '$.signature_sha256'
              )='{}'
              AND json_type(symbol_json, '$.language') IS 'text'
              AND length(json_extract(
                symbol_json, '$.language'
              )) BETWEEN 1 AND 256
              AND trim(json_extract(
                symbol_json, '$.language'
              ))=json_extract(symbol_json, '$.language')
              AND trim(
                json_extract(symbol_json, '$.language'),
                ' ' || char(160) || char(5760)
                  || char(8192) || char(8193) || char(8194) || char(8195)
                  || char(8196) || char(8197) || char(8198) || char(8199)
                  || char(8200) || char(8201) || char(8202)
                  || char(8232) || char(8233) || char(8239) || char(8287)
                  || char(12288) || char(65279)
              )=json_extract(symbol_json, '$.language')
              AND instr(json_extract(
                symbol_json, '$.language'
              ), char(0))=0
              AND json_extract(symbol_json, '$.language') NOT GLOB (
                '*[' || char(1) || '-' || char(31)
                || char(127) || '-' || char(159) || ']*'
              )
              AND json_type(symbol_json, '$.qualified_name') IS 'text'
              AND length(json_extract(
                symbol_json, '$.qualified_name'
              )) BETWEEN 1 AND 4096
              AND trim(json_extract(
                symbol_json, '$.qualified_name'
              ))=json_extract(symbol_json, '$.qualified_name')
              AND trim(
                json_extract(symbol_json, '$.qualified_name'),
                ' ' || char(160) || char(5760)
                  || char(8192) || char(8193) || char(8194) || char(8195)
                  || char(8196) || char(8197) || char(8198) || char(8199)
                  || char(8200) || char(8201) || char(8202)
                  || char(8232) || char(8233) || char(8239) || char(8287)
                  || char(12288) || char(65279)
              )=json_extract(symbol_json, '$.qualified_name')
              AND instr(json_extract(
                symbol_json, '$.qualified_name'
              ), char(0))=0
              AND json_extract(
                symbol_json, '$.qualified_name'
              ) NOT GLOB (
                '*[' || char(1) || '-' || char(31)
                || char(127) || '-' || char(159) || ']*'
              )
              AND json_type(symbol_json, '$.symbol_kind') IS 'text'
              AND length(json_extract(
                symbol_json, '$.symbol_kind'
              )) BETWEEN 1 AND 256
              AND trim(json_extract(
                symbol_json, '$.symbol_kind'
              ))=json_extract(symbol_json, '$.symbol_kind')
              AND trim(
                json_extract(symbol_json, '$.symbol_kind'),
                ' ' || char(160) || char(5760)
                  || char(8192) || char(8193) || char(8194) || char(8195)
                  || char(8196) || char(8197) || char(8198) || char(8199)
                  || char(8200) || char(8201) || char(8202)
                  || char(8232) || char(8233) || char(8239) || char(8287)
                  || char(12288) || char(65279)
              )=json_extract(symbol_json, '$.symbol_kind')
              AND instr(json_extract(
                symbol_json, '$.symbol_kind'
              ), char(0))=0
              AND json_extract(symbol_json, '$.symbol_kind') NOT GLOB (
                '*[' || char(1) || '-' || char(31)
                || char(127) || '-' || char(159) || ']*'
              )
              AND (
                json_type(symbol_json, '$.signature_sha256') IS 'null'
                OR (
                  json_type(
                    symbol_json, '$.signature_sha256'
                  ) IS 'text'
                  AND length(json_extract(
                    symbol_json, '$.signature_sha256'
                  ))=64
                  AND json_extract(
                    symbol_json, '$.signature_sha256'
                  ) NOT GLOB '*[^0-9a-f]*'
                )
              )
            )),
          created_at TEXT NOT NULL CHECK(length(created_at)>0),
          PRIMARY KEY(board_id, id),
          UNIQUE(board_id, source_id, ordinal),
          UNIQUE(board_id, source_id, id),
          FOREIGN KEY(board_id, source_id)
            REFERENCES knowledge_sources(board_id, id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS context_builds (
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
          id TEXT NOT NULL
            CHECK(length(id)=67
              AND substr(id, 1, 3)='cb_'
              AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
          request_json TEXT NOT NULL
            CHECK(json_valid(request_json)
              AND json(request_json)=request_json
              AND json_type(request_json)='object'
              AND length(CAST(request_json AS BLOB))<=8000000
              AND json_remove(
                request_json,
                '$.board_id',
                '$.access_scope',
                '$.targets',
                '$.budget',
                '$.selection_request_sha256'
              )='{}'
              AND json_type(request_json, '$.board_id') IS 'integer'
              AND json_type(request_json, '$.access_scope') IS 'object'
              AND json_type(request_json, '$.targets') IS 'object'
              AND json_type(request_json, '$.budget') IS 'object'
              AND json_type(
                request_json, '$.selection_request_sha256'
              ) IS 'text'
              AND length(json_extract(
                request_json, '$.selection_request_sha256'
              ))=64
              AND json_extract(
                request_json, '$.selection_request_sha256'
              ) NOT GLOB '*[^0-9a-f]*'
              AND (
                (
                  json_type(
                    request_json, '$.access_scope.kind'
                  ) IS 'text'
                  AND json_extract(
                    request_json, '$.access_scope.kind'
                  )='board'
                  AND json_remove(
                    json_extract(request_json, '$.access_scope'),
                    '$.kind'
                  )='{}'
                )
                OR (
                  json_type(
                    request_json, '$.access_scope.kind'
                  ) IS 'text'
                  AND json_extract(
                    request_json, '$.access_scope.kind'
                  )='workspace'
                  AND json_type(
                    request_json, '$.access_scope.workspace_id'
                  ) IS 'text'
                  AND json_remove(
                    json_extract(request_json, '$.access_scope'),
                    '$.kind',
                    '$.workspace_id'
                  )='{}'
                )
                OR (
                  json_type(
                    request_json, '$.access_scope.kind'
                  ) IS 'text'
                  AND json_extract(
                    request_json, '$.access_scope.kind'
                  )='contract'
                  AND json_type(
                    request_json, '$.access_scope.card_id'
                  ) IS 'integer'
                  AND json_type(
                    request_json, '$.access_scope.contract_version'
                  ) IS 'integer'
                  AND json_remove(
                    json_extract(request_json, '$.access_scope'),
                    '$.kind',
                    '$.card_id',
                    '$.contract_version'
                  )='{}'
                )
                OR (
                  json_type(
                    request_json, '$.access_scope.kind'
                  ) IS 'text'
                  AND json_extract(
                    request_json, '$.access_scope.kind'
                  )='job'
                  AND json_type(
                    request_json, '$.access_scope.job_id'
                  ) IS 'text'
                  AND json_remove(
                    json_extract(request_json, '$.access_scope'),
                    '$.kind',
                    '$.job_id'
                  )='{}'
                )
                OR (
                  json_type(
                    request_json, '$.access_scope.kind'
                  ) IS 'text'
                  AND json_extract(
                    request_json, '$.access_scope.kind'
                  )='profile'
                  AND json_type(
                    request_json, '$.access_scope.profile_id'
                  ) IS 'text'
                  AND json_remove(
                    json_extract(request_json, '$.access_scope'),
                    '$.kind',
                    '$.profile_id'
                  )='{}'
                )
                OR (
                  json_type(
                    request_json, '$.access_scope.kind'
                  ) IS 'text'
                  AND json_extract(
                    request_json, '$.access_scope.kind'
                  )='session'
                  AND json_type(
                    request_json, '$.access_scope.session_id'
                  ) IS 'text'
                  AND json_remove(
                    json_extract(request_json, '$.access_scope'),
                    '$.kind',
                    '$.session_id'
                  )='{}'
                )
              )
              AND json_remove(
                json_extract(request_json, '$.targets'),
                '$.board_id',
                '$.workspace_id',
                '$.card_id',
                '$.contract_ref',
                '$.contract_version',
                '$.contract_snapshot_sha256',
                '$.job_id',
                '$.profile_id',
                '$.session_id',
                '$.delivery_report_id'
              )='{}'
              AND json_type(
                request_json, '$.targets.board_id'
              ) IS 'integer'
              AND (
                json_type(
                  request_json, '$.targets.workspace_id'
                ) IS 'text'
                OR json_type(
                  request_json, '$.targets.workspace_id'
                ) IS 'null'
              )
              AND (
                json_type(request_json, '$.targets.card_id') IS 'integer'
                OR json_type(request_json, '$.targets.card_id') IS 'null'
              )
              AND (
                json_type(
                  request_json, '$.targets.contract_ref'
                ) IS 'text'
                OR json_type(
                  request_json, '$.targets.contract_ref'
                ) IS 'null'
              )
              AND (
                json_type(
                  request_json, '$.targets.contract_version'
                ) IS 'integer'
                OR json_type(
                  request_json, '$.targets.contract_version'
                ) IS 'null'
              )
              AND (
                json_type(
                  request_json, '$.targets.contract_snapshot_sha256'
                ) IS 'text'
                OR json_type(
                  request_json, '$.targets.contract_snapshot_sha256'
                ) IS 'null'
              )
              AND (
                json_type(request_json, '$.targets.job_id') IS 'text'
                OR json_type(request_json, '$.targets.job_id') IS 'null'
              )
              AND (
                json_type(
                  request_json, '$.targets.profile_id'
                ) IS 'text'
                OR json_type(
                  request_json, '$.targets.profile_id'
                ) IS 'null'
              )
              AND (
                json_type(
                  request_json, '$.targets.session_id'
                ) IS 'text'
                OR json_type(
                  request_json, '$.targets.session_id'
                ) IS 'null'
              )
              AND (
                json_type(
                  request_json, '$.targets.delivery_report_id'
                ) IS 'null'
                OR (
                  json_type(
                    request_json, '$.targets.delivery_report_id'
                  ) IS 'text'
                  AND length(json_extract(
                    request_json, '$.targets.delivery_report_id'
                  )) BETWEEN 1 AND 256
                  AND trim(json_extract(
                    request_json, '$.targets.delivery_report_id'
                  ))=json_extract(
                    request_json, '$.targets.delivery_report_id'
                  )
                )
              )
              AND json_remove(
                json_extract(request_json, '$.budget'),
                '$.max_tokens',
                '$.max_characters',
                '$.sections'
              )='{}'
              AND json_type(
                request_json, '$.budget.max_tokens'
              ) IS 'integer'
              AND json_type(
                request_json, '$.budget.max_characters'
              ) IS 'integer'
              AND request_json -> '$.budget.max_tokens' IS NOT '-0'
              AND request_json -> '$.budget.max_characters' IS NOT '-0'
              AND json_type(
                request_json, '$.budget.sections'
              ) IS 'object'
              AND json_remove(
                json_extract(request_json, '$.budget.sections'),
                '$.project_brief',
                '$.task_contract',
                '$.repository_instructions',
                '$.relevant_code',
                '$.recent_changes',
                '$.accepted_decisions',
                '$.verified_deliveries',
                '$.working_memory_delta'
              )='{}'),
          request_fingerprint TEXT NOT NULL
            CHECK(length(request_fingerprint)=64
              AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
          source_set_json TEXT NOT NULL
            CHECK(json_valid(source_set_json)
              AND json(source_set_json)=source_set_json
              AND json_type(source_set_json)='array'
              AND length(CAST(source_set_json AS BLOB))<=8000000),
          source_set_fingerprint TEXT NOT NULL
            CHECK(length(source_set_fingerprint)=64
              AND source_set_fingerprint NOT GLOB '*[^0-9a-f]*'),
          manifest_fingerprint TEXT NOT NULL
            CHECK(length(manifest_fingerprint)=64
              AND manifest_fingerprint NOT GLOB '*[^0-9a-f]*'),
          usage_json TEXT NOT NULL
            CHECK(json_valid(usage_json)
              AND json(usage_json)=usage_json
              AND json_type(usage_json)='object'
              AND length(CAST(usage_json AS BLOB))<=8000000
              AND json_remove(
                usage_json,
                '$.used_tokens',
                '$.used_characters',
                '$.sections'
              )='{}'
              AND json_type(usage_json, '$.used_tokens') IS 'integer'
              AND json_type(
                usage_json, '$.used_characters'
              ) IS 'integer'
              AND usage_json -> '$.used_tokens' IS NOT '-0'
              AND usage_json -> '$.used_characters' IS NOT '-0'
              AND json_type(usage_json, '$.sections') IS 'object'
              AND json_remove(
                json_extract(usage_json, '$.sections'),
                '$.project_brief',
                '$.task_contract',
                '$.repository_instructions',
                '$.relevant_code',
                '$.recent_changes',
                '$.accepted_decisions',
                '$.verified_deliveries',
                '$.working_memory_delta'
              )='{}'),
          source_count INTEGER NOT NULL CHECK(source_count BETWEEN 0 AND 512),
          entry_count INTEGER NOT NULL CHECK(entry_count BETWEEN 0 AND 512),
          status TEXT NOT NULL
            CHECK(status IN ('built', 'used', 'invalidated', 'failed')),
          created_at TEXT NOT NULL CHECK(length(created_at)>0),
          invalidated_at TEXT,
          PRIMARY KEY(board_id, id),
          CHECK(source_count=json_array_length(source_set_json)),
          CHECK(
            (status='invalidated' AND invalidated_at IS NOT NULL)
            OR (status!='invalidated' AND invalidated_at IS NULL)
          )
        );

        CREATE TABLE IF NOT EXISTS context_build_sources (
          board_id INTEGER NOT NULL,
          context_build_id TEXT NOT NULL,
          source_ordinal INTEGER NOT NULL CHECK(source_ordinal>=0),
          source_id TEXT NOT NULL
            CHECK(length(source_id)=67
              AND substr(source_id, 1, 3)='ks_'
              AND substr(source_id, 4) NOT GLOB '*[^0-9a-f]*'),
          source_revision TEXT NOT NULL CHECK(length(source_revision)>0),
          content_sha256 TEXT NOT NULL
            CHECK(length(content_sha256)=64
              AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
          freshness_state TEXT NOT NULL
            CHECK(freshness_state IN ('fresh', 'stale', 'unknown', 'contradicted')),
          redaction_state TEXT NOT NULL
            CHECK(redaction_state IN ('none', 'redacted', 'withheld')),
          PRIMARY KEY(board_id, context_build_id, source_ordinal),
          UNIQUE(board_id, context_build_id, source_id),
          FOREIGN KEY(board_id, context_build_id)
            REFERENCES context_builds(board_id, id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS context_build_entries (
          board_id INTEGER NOT NULL,
          context_build_id TEXT NOT NULL,
          candidate_ordinal INTEGER NOT NULL
            CHECK(candidate_ordinal BETWEEN 0 AND 511),
          source_id TEXT NOT NULL
            CHECK(length(source_id)=67
              AND substr(source_id, 1, 3)='ks_'
              AND substr(source_id, 4) NOT GLOB '*[^0-9a-f]*'),
          chunk_id TEXT NOT NULL
            CHECK(length(chunk_id)=67
              AND substr(chunk_id, 1, 3)='kc_'
              AND substr(chunk_id, 4) NOT GLOB '*[^0-9a-f]*'),
          section TEXT NOT NULL
            CHECK(section IN (
              'project_brief', 'task_contract', 'repository_instructions',
              'relevant_code', 'recent_changes', 'accepted_decisions',
              'verified_deliveries', 'working_memory_delta'
            )),
          selected_ordinal INTEGER
            CHECK(selected_ordinal IS NULL OR selected_ordinal BETWEEN 0 AND 511),
          decision TEXT NOT NULL CHECK(decision IN ('selected', 'omitted')),
          reason TEXT NOT NULL
            CHECK(reason IN (
              'within_budget', 'pinned', 'budget_exhausted',
              'section_budget_exhausted', 'stale', 'untrusted', 'superseded',
              'duplicate', 'policy_excluded', 'redacted', 'withheld', 'lower_rank'
            )),
          score_components_json TEXT NOT NULL
            CHECK(json_valid(score_components_json)
              AND json(score_components_json)=score_components_json
              AND json_type(score_components_json)='object'
              AND length(CAST(score_components_json AS BLOB))<=8000000
              AND json_remove(
                score_components_json,
                '$.authority_micros',
                '$.relevance_micros',
                '$.freshness_micros',
                '$.recency_micros',
                '$.contract_micros',
                '$.pin_micros'
              )='{}'
              AND score_components_json -> '$.authority_micros' IS NOT '-0'
              AND score_components_json -> '$.relevance_micros' IS NOT '-0'
              AND score_components_json -> '$.freshness_micros' IS NOT '-0'
              AND score_components_json -> '$.recency_micros' IS NOT '-0'
              AND score_components_json -> '$.contract_micros' IS NOT '-0'
              AND score_components_json -> '$.pin_micros' IS NOT '-0'),
          score_micros INTEGER NOT NULL,
          rendering TEXT NOT NULL
            CHECK(rendering IN ('full', 'truncated', 'summary', 'none')),
          estimated_tokens INTEGER NOT NULL
            CHECK(estimated_tokens BETWEEN 0 AND 10000000),
          character_count INTEGER NOT NULL CHECK(character_count>=0),
          source_kind TEXT NOT NULL
            CHECK(source_kind IN (
              'agents', 'readme', 'documentation', 'convention', 'architecture',
              'code_symbol', 'git_history', 'git_blame', 'discussion_answer',
              'decision', 'verified_delivery', 'gotcha', 'graphify', 'gitnexus',
              'manual'
            )),
          trust_class TEXT NOT NULL
            CHECK(trust_class IN ('instruction', 'reference', 'evidence', 'untrusted')),
          freshness_state TEXT NOT NULL
            CHECK(freshness_state IN ('fresh', 'stale', 'unknown', 'contradicted')),
          redaction_state TEXT NOT NULL
            CHECK(redaction_state IN ('none', 'redacted', 'withheld')),
          normalized_locator TEXT NOT NULL CHECK(length(normalized_locator)>0),
          source_range_json TEXT NOT NULL
            CHECK(json_valid(source_range_json)
              AND json(source_range_json)=source_range_json
              AND json_type(source_range_json)='object'
              AND length(CAST(source_range_json AS BLOB))<=8000000
              AND json_remove(
                source_range_json,
                '$.start_line',
                '$.end_line',
                '$.start_byte',
                '$.end_byte'
              )='{}'
              AND source_range_json -> '$.start_byte' IS NOT '-0'
              AND (
                (
                  json_type(source_range_json, '$.start_line') IS 'null'
                  AND json_type(source_range_json, '$.end_line') IS 'null'
                )
                OR (
                  json_type(
                    source_range_json, '$.start_line'
                  ) IS 'integer'
                  AND json_type(
                    source_range_json, '$.end_line'
                  ) IS 'integer'
                  AND json_extract(source_range_json, '$.start_line')
                    BETWEEN 1 AND 9007199254740991
                  AND json_extract(source_range_json, '$.end_line')
                    BETWEEN json_extract(source_range_json, '$.start_line')
                      AND 9007199254740991
                )
              )
              AND (
                (
                  json_type(source_range_json, '$.start_byte') IS 'null'
                  AND json_type(source_range_json, '$.end_byte') IS 'null'
                )
                OR (
                  json_type(
                    source_range_json, '$.start_byte'
                  ) IS 'integer'
                  AND json_type(
                    source_range_json, '$.end_byte'
                  ) IS 'integer'
                  AND json_extract(source_range_json, '$.start_byte')
                    BETWEEN 0 AND 9007199254740991
                  AND json_extract(source_range_json, '$.end_byte')
                    BETWEEN 1 AND 9007199254740991
                  AND json_extract(source_range_json, '$.end_byte')
                    > json_extract(source_range_json, '$.start_byte')
                )
              )),
          content_sha256 TEXT NOT NULL
            CHECK(length(content_sha256)=64
              AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
          PRIMARY KEY(board_id, context_build_id, candidate_ordinal),
          UNIQUE(board_id, context_build_id, chunk_id),
          FOREIGN KEY(board_id, context_build_id)
            REFERENCES context_builds(board_id, id) ON DELETE RESTRICT,
          CHECK(
            (
              decision='selected'
              AND selected_ordinal IS NOT NULL
              AND rendering!='none'
              AND estimated_tokens>0
              AND character_count>0
              AND reason IN ('within_budget', 'pinned')
            )
            OR (
              decision='omitted'
              AND selected_ordinal IS NULL
              AND rendering='none'
              AND estimated_tokens=0
              AND character_count=0
              AND reason NOT IN ('within_budget', 'pinned')
            )
          ),
          CHECK(
            (redaction_state='withheld' AND decision='omitted' AND reason='withheld')
            OR (redaction_state!='withheld' AND reason!='withheld')
          ),
          CHECK(
            score_micros BETWEEN -1000000000000 AND 1000000000000
            AND json_type(score_components_json, '$.authority_micros') IS 'integer'
            AND json_type(score_components_json, '$.relevance_micros') IS 'integer'
            AND json_type(score_components_json, '$.freshness_micros') IS 'integer'
            AND json_type(score_components_json, '$.recency_micros') IS 'integer'
            AND json_type(score_components_json, '$.contract_micros') IS 'integer'
            AND json_type(score_components_json, '$.pin_micros') IS 'integer'
            AND json_extract(score_components_json, '$.authority_micros')
              BETWEEN -1000000000000 AND 1000000000000
            AND json_extract(score_components_json, '$.relevance_micros')
              BETWEEN -1000000000000 AND 1000000000000
            AND json_extract(score_components_json, '$.freshness_micros')
              BETWEEN -1000000000000 AND 1000000000000
            AND json_extract(score_components_json, '$.recency_micros')
              BETWEEN -1000000000000 AND 1000000000000
            AND json_extract(score_components_json, '$.contract_micros')
              BETWEEN -1000000000000 AND 1000000000000
            AND json_extract(score_components_json, '$.pin_micros')
              BETWEEN -1000000000000 AND 1000000000000
            AND score_micros=(
              json_extract(score_components_json, '$.authority_micros')
              + json_extract(score_components_json, '$.relevance_micros')
              + json_extract(score_components_json, '$.freshness_micros')
              + json_extract(score_components_json, '$.recency_micros')
              + json_extract(score_components_json, '$.contract_micros')
              + json_extract(score_components_json, '$.pin_micros')
            )
          )
        );

        CREATE TABLE IF NOT EXISTS context_uses (
          board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE RESTRICT,
          id TEXT NOT NULL
            CHECK(length(id)=67
              AND substr(id, 1, 3)='cu_'
              AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
          context_build_id TEXT NOT NULL,
          job_id TEXT NOT NULL REFERENCES jobs(id),
          session_id TEXT NOT NULL REFERENCES agent_sessions(id),
          injection_ordinal INTEGER NOT NULL CHECK(injection_ordinal>=0),
          manifest_fingerprint TEXT NOT NULL
            CHECK(length(manifest_fingerprint)=64
              AND manifest_fingerprint NOT GLOB '*[^0-9a-f]*'),
          estimated_tokens INTEGER NOT NULL
            CHECK(estimated_tokens BETWEEN 0 AND 10000000),
          actual_tokens INTEGER
            CHECK(actual_tokens IS NULL OR actual_tokens BETWEEN 0 AND 10000000),
          cache_identity TEXT NOT NULL CHECK(length(cache_identity)>0),
          outcome TEXT NOT NULL
            CHECK(outcome IN ('running', 'completed', 'failed', 'cancelled')),
          injected_at TEXT NOT NULL CHECK(length(injected_at)>0),
          completed_at TEXT,
          PRIMARY KEY(board_id, id),
          UNIQUE(board_id, session_id, injection_ordinal),
          FOREIGN KEY(board_id, context_build_id)
            REFERENCES context_builds(board_id, id),
          CHECK(
            (outcome='running' AND actual_tokens IS NULL AND completed_at IS NULL)
            OR (
              outcome!='running'
              AND completed_at IS NOT NULL
              AND completed_at>=injected_at
            )
          ),
          CHECK(outcome!='completed' OR actual_tokens IS NOT NULL)
        );

        DROP INDEX IF EXISTS idx_knowledge_sources_locator;
        DROP INDEX IF EXISTS idx_knowledge_sources_state;
        DROP INDEX IF EXISTS idx_knowledge_chunks_source;
        DROP INDEX IF EXISTS idx_context_builds_status;
        DROP INDEX IF EXISTS idx_context_build_sources_source;
        DROP INDEX IF EXISTS idx_context_build_entries_selected;
        DROP INDEX IF EXISTS idx_context_uses_build;
        DROP INDEX IF EXISTS idx_context_uses_job;

        CREATE INDEX idx_knowledge_sources_locator
          ON knowledge_sources(board_id, normalized_locator, source_revision);
        CREATE INDEX idx_knowledge_sources_state
          ON knowledge_sources(board_id, ingest_state, freshness_state, updated_at);
        CREATE INDEX idx_knowledge_chunks_source
          ON knowledge_chunks(board_id, source_id, ordinal);
        CREATE INDEX idx_context_builds_status
          ON context_builds(board_id, status, created_at, id);
        CREATE INDEX idx_context_build_sources_source
          ON context_build_sources(board_id, source_id, context_build_id);
        CREATE UNIQUE INDEX idx_context_build_entries_selected
          ON context_build_entries(board_id, context_build_id, selected_ordinal)
          WHERE selected_ordinal IS NOT NULL;
        CREATE INDEX idx_context_uses_build
          ON context_uses(board_id, context_build_id, injected_at, id);
        CREATE INDEX idx_context_uses_job
          ON context_uses(board_id, job_id, session_id, injection_ordinal);

        DROP TRIGGER IF EXISTS knowledge_sources_scope_insert;
        DROP TRIGGER IF EXISTS knowledge_sources_immutable;
        DROP TRIGGER IF EXISTS knowledge_sources_delete;
        DROP TRIGGER IF EXISTS knowledge_chunks_immutable;
        DROP TRIGGER IF EXISTS knowledge_chunks_delete;
        DROP TRIGGER IF EXISTS knowledge_chunks_insert;
        DROP TRIGGER IF EXISTS context_builds_scope_insert;
        DROP TRIGGER IF EXISTS context_builds_identity_immutable;
        DROP TRIGGER IF EXISTS context_builds_status_transition;
        DROP TRIGGER IF EXISTS context_builds_delete;
        DROP TRIGGER IF EXISTS context_build_sources_insert;
        DROP TRIGGER IF EXISTS context_build_sources_immutable;
        DROP TRIGGER IF EXISTS context_build_sources_delete;
        DROP TRIGGER IF EXISTS context_build_entries_insert;
        DROP TRIGGER IF EXISTS context_build_entries_immutable;
        DROP TRIGGER IF EXISTS context_build_entries_delete;
        DROP TRIGGER IF EXISTS context_uses_insert;
        DROP TRIGGER IF EXISTS context_uses_mark_build_used;
        DROP TRIGGER IF EXISTS context_uses_finish;
        DROP TRIGGER IF EXISTS context_uses_delete;

        CREATE TRIGGER knowledge_sources_scope_insert
        BEFORE INSERT ON knowledge_sources
        BEGIN
          SELECT CASE WHEN
            NEW.board_id NOT BETWEEN 1 AND 9007199254740991
            OR json_extract(NEW.targets_json, '$.board_id')
              NOT BETWEEN 1 AND 9007199254740991
            OR (
              json_extract(NEW.access_scope_json, '$.kind')='contract'
              AND (
                json_extract(NEW.access_scope_json, '$.card_id')
                  NOT BETWEEN 1 AND 9007199254740991
                OR json_extract(
                  NEW.access_scope_json, '$.contract_version'
                ) NOT BETWEEN 1 AND 9007199254740991
              )
            )
            OR (
              json_type(NEW.targets_json, '$.card_id') IS 'integer'
              AND json_extract(NEW.targets_json, '$.card_id')
                NOT BETWEEN 1 AND 9007199254740991
            )
            OR (
              json_type(
                NEW.targets_json, '$.contract_version'
              ) IS 'integer'
              AND json_extract(
                NEW.targets_json, '$.contract_version'
              ) NOT BETWEEN 1 AND 9007199254740991
            )
            OR EXISTS (
              SELECT 1 FROM json_each(NEW.access_scope_json) scope_field
              WHERE scope_field.key IN (
                'workspace_id', 'job_id', 'profile_id', 'session_id'
              )
                AND (
                  length(scope_field.value) NOT BETWEEN 1 AND 256
                  OR trim(scope_field.value)!=scope_field.value
                  OR trim(
                    scope_field.value,
                    ' ' || char(160) || char(5760)
                      || char(8192) || char(8193) || char(8194) || char(8195)
                      || char(8196) || char(8197) || char(8198) || char(8199)
                      || char(8200) || char(8201) || char(8202)
                      || char(8232) || char(8233) || char(8239) || char(8287)
                      || char(12288) || char(65279)
                  )!=scope_field.value
                  OR instr(scope_field.value, char(0))!=0
                  OR scope_field.value GLOB (
                    '*[' || char(1) || '-' || char(31)
                    || char(127) || '-' || char(159) || ']*'
                  )
                )
            )
            OR EXISTS (
              SELECT 1 FROM json_each(NEW.targets_json) target_field
              WHERE target_field.key IN (
                'workspace_id', 'contract_ref', 'job_id', 'profile_id',
                'session_id', 'delivery_report_id'
              )
                AND target_field.type='text'
                AND (
                  length(target_field.value) NOT BETWEEN 1 AND 256
                  OR trim(target_field.value)!=target_field.value
                  OR trim(
                    target_field.value,
                    ' ' || char(160) || char(5760)
                      || char(8192) || char(8193) || char(8194) || char(8195)
                      || char(8196) || char(8197) || char(8198) || char(8199)
                      || char(8200) || char(8201) || char(8202)
                      || char(8232) || char(8233) || char(8239) || char(8287)
                      || char(12288) || char(65279)
                  )!=target_field.value
                  OR instr(target_field.value, char(0))!=0
                  OR target_field.value GLOB (
                    '*[' || char(1) || '-' || char(31)
                    || char(127) || '-' || char(159) || ']*'
                  )
                )
            )
          THEN RAISE(ABORT, 'knowledge source target scalar is inconsistent') END;

          SELECT CASE
            WHEN json_extract(NEW.access_scope_json, '$.kind')='board' THEN NULL
            WHEN json_extract(NEW.access_scope_json, '$.kind')='workspace'
              AND json_type(NEW.access_scope_json, '$.workspace_id')='text'
              AND json_extract(NEW.access_scope_json, '$.workspace_id')
                IS json_extract(NEW.targets_json, '$.workspace_id')
              AND EXISTS (
                SELECT 1 FROM workspaces
                WHERE id=json_extract(NEW.access_scope_json, '$.workspace_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            WHEN json_extract(NEW.access_scope_json, '$.kind')='contract'
              AND json_type(NEW.access_scope_json, '$.card_id')='integer'
              AND json_type(NEW.access_scope_json, '$.contract_version')='integer'
              AND json_extract(NEW.access_scope_json, '$.card_id')
                IS json_extract(NEW.targets_json, '$.card_id')
              AND json_extract(NEW.access_scope_json, '$.contract_version')
                IS json_extract(NEW.targets_json, '$.contract_version')
              AND EXISTS (
                SELECT 1 FROM task_contracts contract
                JOIN cards card ON card.id=contract.card_id
                WHERE contract.card_id=json_extract(NEW.access_scope_json, '$.card_id')
                  AND contract.version=json_extract(
                    NEW.access_scope_json, '$.contract_version'
                  )
                  AND card.board_id=NEW.board_id
              ) THEN NULL
            WHEN json_extract(NEW.access_scope_json, '$.kind')='job'
              AND json_type(NEW.access_scope_json, '$.job_id')='text'
              AND json_extract(NEW.access_scope_json, '$.job_id')
                IS json_extract(NEW.targets_json, '$.job_id')
              AND EXISTS (
                SELECT 1 FROM jobs
                WHERE id=json_extract(NEW.access_scope_json, '$.job_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            WHEN json_extract(NEW.access_scope_json, '$.kind')='profile'
              AND json_type(NEW.access_scope_json, '$.profile_id')='text'
              AND json_extract(NEW.access_scope_json, '$.profile_id')
                IS json_extract(NEW.targets_json, '$.profile_id')
              AND EXISTS (
                SELECT 1 FROM agent_profiles
                WHERE id=json_extract(NEW.access_scope_json, '$.profile_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            WHEN json_extract(NEW.access_scope_json, '$.kind')='session'
              AND json_type(NEW.access_scope_json, '$.session_id')='text'
              AND json_extract(NEW.access_scope_json, '$.session_id')
                IS json_extract(NEW.targets_json, '$.session_id')
              AND EXISTS (
                SELECT 1 FROM agent_sessions session
                JOIN workspaces workspace ON workspace.id=session.workspace_id
                WHERE session.id=json_extract(NEW.access_scope_json, '$.session_id')
                  AND workspace.board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'knowledge source access scope is inconsistent')
          END;

          SELECT CASE WHEN
            json_type(NEW.targets_json, '$.board_id') IS NOT 'integer'
            OR json_extract(NEW.targets_json, '$.board_id')!=NEW.board_id
          THEN RAISE(ABORT, 'knowledge source target board is inconsistent') END;

          SELECT CASE
            WHEN json_type(NEW.targets_json, '$.workspace_id') IS NULL
              OR json_type(NEW.targets_json, '$.workspace_id')='null' THEN NULL
            WHEN json_type(NEW.targets_json, '$.workspace_id')='text'
              AND EXISTS (
                SELECT 1 FROM workspaces
                WHERE id=json_extract(NEW.targets_json, '$.workspace_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'knowledge source workspace target is inconsistent')
          END;

          SELECT CASE
            WHEN json_type(NEW.targets_json, '$.card_id') IS NULL
              OR json_type(NEW.targets_json, '$.card_id')='null' THEN NULL
            WHEN json_type(NEW.targets_json, '$.card_id')='integer'
              AND EXISTS (
                SELECT 1 FROM cards
                WHERE id=json_extract(NEW.targets_json, '$.card_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'knowledge source card target is inconsistent')
          END;

          SELECT CASE
            WHEN json_type(NEW.targets_json, '$.contract_version') IS NULL
              OR json_type(NEW.targets_json, '$.contract_version')='null' THEN
              CASE WHEN
                json_extract(NEW.targets_json, '$.contract_ref') IS NULL
                AND json_extract(
                  NEW.targets_json, '$.contract_snapshot_sha256'
                ) IS NULL
              THEN NULL
              ELSE RAISE(ABORT, 'knowledge source contract target is inconsistent') END
            WHEN json_type(NEW.targets_json, '$.contract_version')='integer'
              AND json_type(NEW.targets_json, '$.card_id')='integer'
              AND json_type(NEW.targets_json, '$.contract_ref')='text'
              AND json_extract(NEW.targets_json, '$.contract_ref')=(
                'card:' || json_extract(NEW.targets_json, '$.card_id')
                || ':v' || json_extract(NEW.targets_json, '$.contract_version')
              )
              AND json_type(
                NEW.targets_json, '$.contract_snapshot_sha256'
              )='text'
              AND length(json_extract(
                NEW.targets_json, '$.contract_snapshot_sha256'
              ))=64
              AND json_extract(
                NEW.targets_json, '$.contract_snapshot_sha256'
              ) NOT GLOB '*[^0-9a-f]*'
              AND EXISTS (
                SELECT 1 FROM task_contracts contract
                JOIN cards card ON card.id=contract.card_id
                WHERE contract.card_id=json_extract(NEW.targets_json, '$.card_id')
                  AND contract.version=json_extract(
                    NEW.targets_json, '$.contract_version'
                  )
                  AND card.board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'knowledge source contract target is inconsistent')
          END;

          SELECT CASE
            WHEN json_type(NEW.targets_json, '$.job_id') IS NULL
              OR json_type(NEW.targets_json, '$.job_id')='null' THEN NULL
            WHEN json_type(NEW.targets_json, '$.job_id')='text'
              AND EXISTS (
                SELECT 1 FROM jobs
                WHERE id=json_extract(NEW.targets_json, '$.job_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'knowledge source job target is inconsistent')
          END;

          SELECT CASE
            WHEN json_type(NEW.targets_json, '$.profile_id') IS NULL
              OR json_type(NEW.targets_json, '$.profile_id')='null' THEN NULL
            WHEN json_type(NEW.targets_json, '$.profile_id')='text'
              AND EXISTS (
                SELECT 1 FROM agent_profiles
                WHERE id=json_extract(NEW.targets_json, '$.profile_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'knowledge source profile target is inconsistent')
          END;

          SELECT CASE
            WHEN json_type(NEW.targets_json, '$.session_id') IS NULL
              OR json_type(NEW.targets_json, '$.session_id')='null' THEN NULL
            WHEN json_type(NEW.targets_json, '$.session_id')='text'
              AND EXISTS (
                SELECT 1 FROM agent_sessions session
                JOIN workspaces workspace ON workspace.id=session.workspace_id
                WHERE session.id=json_extract(NEW.targets_json, '$.session_id')
                  AND workspace.board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'knowledge source session target is inconsistent')
          END;

          SELECT CASE WHEN
            (
              json_extract(NEW.targets_json, '$.workspace_id') IS NOT NULL
              AND json_extract(NEW.targets_json, '$.card_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM workspaces workspace
                WHERE workspace.id=json_extract(
                    NEW.targets_json, '$.workspace_id'
                  )
                  AND (
                    workspace.card_id IS NULL
                    OR workspace.card_id=json_extract(
                      NEW.targets_json, '$.card_id'
                    )
                  )
              )
            )
            OR (
              json_extract(NEW.targets_json, '$.job_id') IS NOT NULL
              AND json_extract(NEW.targets_json, '$.card_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs job
                WHERE job.id=json_extract(NEW.targets_json, '$.job_id')
                  AND job.card_id=json_extract(NEW.targets_json, '$.card_id')
              )
            )
            OR (
              json_extract(NEW.targets_json, '$.job_id') IS NOT NULL
              AND json_extract(NEW.targets_json, '$.workspace_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs job
                WHERE job.id=json_extract(NEW.targets_json, '$.job_id')
                  AND job.workspace_id=json_extract(
                    NEW.targets_json, '$.workspace_id'
                  )
              )
            )
            OR (
              json_extract(NEW.targets_json, '$.job_id') IS NOT NULL
              AND json_extract(
                NEW.targets_json, '$.contract_version'
              ) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs job
                WHERE job.id=json_extract(NEW.targets_json, '$.job_id')
                  AND job.contract_version=json_extract(
                    NEW.targets_json, '$.contract_version'
                  )
              )
            )
            OR (
              json_extract(NEW.targets_json, '$.job_id') IS NOT NULL
              AND json_extract(NEW.targets_json, '$.profile_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs job
                WHERE job.id=json_extract(NEW.targets_json, '$.job_id')
                  AND (
                    job.assigned_profile_id IS NULL
                    OR job.assigned_profile_id=json_extract(
                      NEW.targets_json, '$.profile_id'
                    )
                  )
              )
            )
            OR (
              json_extract(NEW.targets_json, '$.session_id') IS NOT NULL
              AND json_extract(NEW.targets_json, '$.card_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM agent_sessions session
                JOIN workspaces workspace ON workspace.id=session.workspace_id
                LEFT JOIN jobs job ON job.id=session.job_id
                WHERE session.id=json_extract(
                    NEW.targets_json, '$.session_id'
                  )
                  AND (
                    (
                      session.job_id IS NOT NULL
                      AND job.card_id=json_extract(
                        NEW.targets_json, '$.card_id'
                      )
                    )
                    OR (
                      session.job_id IS NULL
                      AND (
                        workspace.card_id IS NULL
                        OR workspace.card_id=json_extract(
                          NEW.targets_json, '$.card_id'
                        )
                      )
                    )
                  )
              )
            )
            OR (
              json_extract(NEW.targets_json, '$.session_id') IS NOT NULL
              AND json_extract(
                NEW.targets_json, '$.contract_version'
              ) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM agent_sessions session
                JOIN jobs job ON job.id=session.job_id
                WHERE session.id=json_extract(
                    NEW.targets_json, '$.session_id'
                  )
                  AND job.contract_version=json_extract(
                    NEW.targets_json, '$.contract_version'
                  )
              )
            )
            OR (
              json_extract(NEW.targets_json, '$.session_id') IS NOT NULL
              AND json_extract(NEW.targets_json, '$.job_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM agent_sessions session
                WHERE session.id=json_extract(NEW.targets_json, '$.session_id')
                  AND session.job_id=json_extract(NEW.targets_json, '$.job_id')
              )
            )
            OR (
              json_extract(NEW.targets_json, '$.session_id') IS NOT NULL
              AND json_extract(NEW.targets_json, '$.profile_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM agent_sessions session
                WHERE session.id=json_extract(NEW.targets_json, '$.session_id')
                  AND session.profile_id=json_extract(
                    NEW.targets_json, '$.profile_id'
                  )
              )
            )
            OR (
              json_extract(NEW.targets_json, '$.session_id') IS NOT NULL
              AND json_extract(NEW.targets_json, '$.workspace_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM agent_sessions session
                WHERE session.id=json_extract(NEW.targets_json, '$.session_id')
                  AND session.workspace_id=json_extract(
                    NEW.targets_json, '$.workspace_id'
                  )
              )
            )
          THEN RAISE(ABORT, 'knowledge source target links are inconsistent') END;

        END;

        CREATE TRIGGER knowledge_sources_immutable
        BEFORE UPDATE ON knowledge_sources
        BEGIN
          SELECT RAISE(ABORT, 'knowledge source evidence is immutable');
        END;

        CREATE TRIGGER knowledge_sources_delete
        BEFORE DELETE ON knowledge_sources
        BEGIN
          SELECT RAISE(ABORT, 'knowledge source evidence is immutable');
        END;

        CREATE TRIGGER knowledge_chunks_immutable
        BEFORE UPDATE ON knowledge_chunks
        BEGIN
          SELECT RAISE(ABORT, 'knowledge chunk evidence is immutable');
        END;

        CREATE TRIGGER knowledge_chunks_insert
        BEFORE INSERT ON knowledge_chunks
        WHEN NOT EXISTS (
          SELECT 1 FROM knowledge_sources source
          WHERE source.board_id=NEW.board_id
            AND source.id=NEW.source_id
            AND source.content_state='present'
            AND source.redaction_state!='withheld'
            AND source.ingest_state!='forgotten'
        )
        BEGIN
          SELECT RAISE(ABORT, 'knowledge chunk source state is inconsistent');
        END;

        CREATE TRIGGER knowledge_chunks_delete
        BEFORE DELETE ON knowledge_chunks
        BEGIN
          SELECT RAISE(ABORT, 'knowledge chunk evidence is immutable');
        END;

        CREATE TRIGGER context_builds_scope_insert
        BEFORE INSERT ON context_builds
        BEGIN
          SELECT CASE WHEN
            NEW.status NOT IN ('built', 'failed')
            OR
            json_type(NEW.request_json, '$.board_id') IS NOT 'integer'
            OR json_extract(NEW.request_json, '$.board_id')!=NEW.board_id
            OR json_type(NEW.request_json, '$.access_scope') IS NOT 'object'
            OR json_type(NEW.request_json, '$.targets') IS NOT 'object'
            OR json_type(NEW.request_json, '$.targets.board_id') IS NOT 'integer'
            OR json_extract(NEW.request_json, '$.targets.board_id')!=NEW.board_id
          THEN RAISE(ABORT, 'context build request scope is inconsistent') END;

          SELECT CASE WHEN
            NEW.board_id NOT BETWEEN 1 AND 9007199254740991
            OR json_extract(NEW.request_json, '$.board_id')
              NOT BETWEEN 1 AND 9007199254740991
            OR json_extract(NEW.request_json, '$.targets.board_id')
              NOT BETWEEN 1 AND 9007199254740991
            OR (
              json_extract(
                NEW.request_json, '$.access_scope.kind'
              )='contract'
              AND (
                json_extract(
                  NEW.request_json, '$.access_scope.card_id'
                ) NOT BETWEEN 1 AND 9007199254740991
                OR json_extract(
                  NEW.request_json, '$.access_scope.contract_version'
                ) NOT BETWEEN 1 AND 9007199254740991
              )
            )
            OR (
              json_type(
                NEW.request_json, '$.targets.card_id'
              ) IS 'integer'
              AND json_extract(
                NEW.request_json, '$.targets.card_id'
              ) NOT BETWEEN 1 AND 9007199254740991
            )
            OR (
              json_type(
                NEW.request_json, '$.targets.contract_version'
              ) IS 'integer'
              AND json_extract(
                NEW.request_json, '$.targets.contract_version'
              ) NOT BETWEEN 1 AND 9007199254740991
            )
            OR EXISTS (
              SELECT 1 FROM json_each(
                NEW.request_json, '$.access_scope'
              ) scope_field
              WHERE scope_field.key IN (
                'workspace_id', 'job_id', 'profile_id', 'session_id'
              )
                AND (
                  length(scope_field.value) NOT BETWEEN 1 AND 256
                  OR trim(scope_field.value)!=scope_field.value
                  OR trim(
                    scope_field.value,
                    ' ' || char(160) || char(5760)
                      || char(8192) || char(8193) || char(8194) || char(8195)
                      || char(8196) || char(8197) || char(8198) || char(8199)
                      || char(8200) || char(8201) || char(8202)
                      || char(8232) || char(8233) || char(8239) || char(8287)
                      || char(12288) || char(65279)
                  )!=scope_field.value
                  OR instr(scope_field.value, char(0))!=0
                  OR scope_field.value GLOB (
                    '*[' || char(1) || '-' || char(31)
                    || char(127) || '-' || char(159) || ']*'
                  )
                )
            )
            OR EXISTS (
              SELECT 1 FROM json_each(
                NEW.request_json, '$.targets'
              ) target_field
              WHERE target_field.key IN (
                'workspace_id', 'contract_ref', 'job_id', 'profile_id',
                'session_id', 'delivery_report_id'
              )
                AND target_field.type='text'
                AND (
                  length(target_field.value) NOT BETWEEN 1 AND 256
                  OR trim(target_field.value)!=target_field.value
                  OR trim(
                    target_field.value,
                    ' ' || char(160) || char(5760)
                      || char(8192) || char(8193) || char(8194) || char(8195)
                      || char(8196) || char(8197) || char(8198) || char(8199)
                      || char(8200) || char(8201) || char(8202)
                      || char(8232) || char(8233) || char(8239) || char(8287)
                      || char(12288) || char(65279)
                  )!=target_field.value
                  OR instr(target_field.value, char(0))!=0
                  OR target_field.value GLOB (
                    '*[' || char(1) || '-' || char(31)
                    || char(127) || '-' || char(159) || ']*'
                  )
                )
            )
          THEN RAISE(ABORT, 'context build target scalar is inconsistent') END;

          SELECT CASE WHEN
            EXISTS (
              SELECT 1 FROM json_each(NEW.source_set_json) source
              WHERE source.type IS NOT 'object'
                OR json_remove(
                  source.value,
                  '$.source_id',
                  '$.source_revision',
                  '$.content_sha256',
                  '$.freshness_state',
                  '$.redaction_state'
                )!='{}'
                OR json_type(source.value, '$.source_id') IS NOT 'text'
                OR length(json_extract(source.value, '$.source_id'))!=67
                OR substr(
                  json_extract(source.value, '$.source_id'), 1, 3
                )!='ks_'
                OR substr(
                  json_extract(source.value, '$.source_id'), 4
                ) GLOB '*[^0-9a-f]*'
                OR json_type(
                  source.value, '$.source_revision'
                ) IS NOT 'text'
                OR length(json_extract(
                  source.value, '$.source_revision'
                )) NOT BETWEEN 1 AND 512
                OR trim(json_extract(
                  source.value, '$.source_revision'
                ))!=json_extract(source.value, '$.source_revision')
                OR trim(
                  json_extract(source.value, '$.source_revision'),
                  ' ' || char(160) || char(5760)
                    || char(8192) || char(8193) || char(8194) || char(8195)
                    || char(8196) || char(8197) || char(8198) || char(8199)
                    || char(8200) || char(8201) || char(8202)
                    || char(8232) || char(8233) || char(8239) || char(8287)
                    || char(12288) || char(65279)
                )!=json_extract(source.value, '$.source_revision')
                OR instr(json_extract(
                  source.value, '$.source_revision'
                ), char(0))!=0
                OR json_extract(
                  source.value, '$.source_revision'
                ) GLOB (
                  '*[' || char(1) || '-' || char(31)
                  || char(127) || '-' || char(159) || ']*'
                )
                OR json_type(
                  source.value, '$.content_sha256'
                ) IS NOT 'text'
                OR length(json_extract(
                  source.value, '$.content_sha256'
                ))!=64
                OR json_extract(
                  source.value, '$.content_sha256'
                ) GLOB '*[^0-9a-f]*'
                OR json_type(
                  source.value, '$.freshness_state'
                ) IS NOT 'text'
                OR json_extract(
                  source.value, '$.freshness_state'
                ) NOT IN ('fresh', 'stale', 'unknown', 'contradicted')
                OR json_type(
                  source.value, '$.redaction_state'
                ) IS NOT 'text'
                OR json_extract(
                  source.value, '$.redaction_state'
                ) NOT IN ('none', 'redacted', 'withheld')
            )
            OR EXISTS (
              SELECT 1
              FROM json_each(NEW.source_set_json) source
              JOIN json_each(NEW.source_set_json) prior
                ON CAST(prior.key AS INTEGER)=CAST(source.key AS INTEGER)-1
              WHERE json_extract(prior.value, '$.source_id')
                >= json_extract(source.value, '$.source_id')
            )
          THEN RAISE(ABORT, 'context build source set is inconsistent') END;

          SELECT CASE WHEN
            json_type(NEW.request_json, '$.budget.max_tokens') IS NOT 'integer'
            OR json_extract(NEW.request_json, '$.budget.max_tokens') NOT BETWEEN 0 AND 10000000
            OR json_type(NEW.request_json, '$.budget.max_characters') IS NOT 'integer'
            OR json_extract(NEW.request_json, '$.budget.max_characters')
              NOT BETWEEN 0 AND 50000000
            OR json_type(NEW.request_json, '$.budget.sections') IS NOT 'object'
            OR EXISTS (
              SELECT 1 FROM json_each(
                NEW.request_json, '$.budget.sections'
              ) budget_section
              WHERE budget_section.key NOT IN (
                'project_brief', 'task_contract', 'repository_instructions',
                'relevant_code', 'recent_changes', 'accepted_decisions',
                'verified_deliveries', 'working_memory_delta'
              )
                OR budget_section.type IS NOT 'object'
                OR (
                  SELECT COUNT(*) FROM json_each(budget_section.value)
                )!=2
                OR EXISTS (
                  SELECT 1 FROM json_each(budget_section.value) field
                  WHERE field.key NOT IN ('max_tokens', 'max_characters')
                )
                OR json_type(budget_section.value, '$.max_tokens') IS NOT 'integer'
                OR budget_section.value -> '$.max_tokens' IS '-0'
                OR json_extract(budget_section.value, '$.max_tokens')
                  NOT BETWEEN 0 AND json_extract(
                    NEW.request_json, '$.budget.max_tokens'
                  )
                OR json_type(
                  budget_section.value, '$.max_characters'
                ) IS NOT 'integer'
                OR budget_section.value -> '$.max_characters' IS '-0'
                OR json_extract(budget_section.value, '$.max_characters')
                  NOT BETWEEN 0 AND json_extract(
                    NEW.request_json, '$.budget.max_characters'
                  )
            )
            OR json_type(NEW.usage_json, '$.used_tokens') IS NOT 'integer'
            OR json_extract(NEW.usage_json, '$.used_tokens') NOT BETWEEN 0 AND 10000000
            OR json_extract(NEW.usage_json, '$.used_tokens')
              > json_extract(NEW.request_json, '$.budget.max_tokens')
            OR json_type(NEW.usage_json, '$.used_characters') IS NOT 'integer'
            OR json_extract(NEW.usage_json, '$.used_characters')
              NOT BETWEEN 0 AND 50000000
            OR json_extract(NEW.usage_json, '$.used_characters')
              > json_extract(NEW.request_json, '$.budget.max_characters')
            OR json_type(NEW.usage_json, '$.sections') IS NOT 'object'
            OR EXISTS (
              SELECT 1 FROM json_each(NEW.usage_json, '$.sections') usage_section
              WHERE usage_section.key NOT IN (
                'project_brief', 'task_contract', 'repository_instructions',
                'relevant_code', 'recent_changes', 'accepted_decisions',
                'verified_deliveries', 'working_memory_delta'
              )
                OR usage_section.type IS NOT 'object'
                OR (
                  SELECT COUNT(*) FROM json_each(usage_section.value)
                )!=2
                OR EXISTS (
                  SELECT 1 FROM json_each(usage_section.value) field
                  WHERE field.key NOT IN ('used_tokens', 'used_characters')
                )
                OR json_type(usage_section.value, '$.used_tokens') IS NOT 'integer'
                OR usage_section.value -> '$.used_tokens' IS '-0'
                OR json_extract(usage_section.value, '$.used_tokens')
                  NOT BETWEEN 0 AND 10000000
                OR json_type(
                  usage_section.value, '$.used_characters'
                ) IS NOT 'integer'
                OR usage_section.value -> '$.used_characters' IS '-0'
                OR json_extract(usage_section.value, '$.used_characters')
                  NOT BETWEEN 0 AND 50000000
                OR EXISTS (
                  SELECT 1 FROM json_each(
                    NEW.request_json, '$.budget.sections'
                  ) budget_section
                  WHERE budget_section.key=usage_section.key
                    AND (
                      json_type(
                        budget_section.value, '$.max_tokens'
                      ) IS NOT 'integer'
                      OR json_extract(budget_section.value, '$.max_tokens')
                        NOT BETWEEN 0 AND json_extract(
                          NEW.request_json, '$.budget.max_tokens'
                        )
                      OR json_type(
                        budget_section.value, '$.max_characters'
                      ) IS NOT 'integer'
                      OR json_extract(budget_section.value, '$.max_characters')
                        NOT BETWEEN 0 AND json_extract(
                          NEW.request_json, '$.budget.max_characters'
                        )
                      OR json_extract(usage_section.value, '$.used_tokens')
                        > json_extract(budget_section.value, '$.max_tokens')
                      OR json_extract(usage_section.value, '$.used_characters')
                        > json_extract(budget_section.value, '$.max_characters')
                    )
                )
            )
            OR COALESCE((
              SELECT SUM(json_extract(value, '$.used_tokens'))
              FROM json_each(NEW.usage_json, '$.sections')
            ), 0) > json_extract(NEW.usage_json, '$.used_tokens')
            OR COALESCE((
              SELECT SUM(json_extract(value, '$.used_characters'))
              FROM json_each(NEW.usage_json, '$.sections')
            ), 0) > json_extract(NEW.usage_json, '$.used_characters')
            OR (
              NEW.status='failed'
              AND (
                NEW.source_count!=0
                OR NEW.entry_count!=0
                OR json_array_length(NEW.source_set_json)!=0
                OR json_extract(NEW.usage_json, '$.used_tokens')!=0
                OR json_extract(NEW.usage_json, '$.used_characters')!=0
                OR EXISTS (
                  SELECT 1 FROM json_each(NEW.usage_json, '$.sections')
                )
              )
            )
          THEN RAISE(ABORT, 'context build budget accounting is inconsistent') END;

          SELECT CASE
            WHEN json_extract(NEW.request_json, '$.access_scope.kind')='board' THEN NULL
            WHEN json_extract(NEW.request_json, '$.access_scope.kind')='workspace'
              AND json_extract(NEW.request_json, '$.access_scope.workspace_id')
                IS json_extract(NEW.request_json, '$.targets.workspace_id')
              AND EXISTS (
                SELECT 1 FROM workspaces
                WHERE id=json_extract(
                    NEW.request_json, '$.access_scope.workspace_id'
                  )
                  AND board_id=NEW.board_id
              ) THEN NULL
            WHEN json_extract(NEW.request_json, '$.access_scope.kind')='contract'
              AND json_extract(NEW.request_json, '$.access_scope.card_id')
                IS json_extract(NEW.request_json, '$.targets.card_id')
              AND json_extract(NEW.request_json, '$.access_scope.contract_version')
                IS json_extract(NEW.request_json, '$.targets.contract_version')
              AND EXISTS (
                SELECT 1 FROM task_contracts contract
                JOIN cards card ON card.id=contract.card_id
                WHERE contract.card_id=json_extract(
                    NEW.request_json, '$.access_scope.card_id'
                  )
                  AND contract.version=json_extract(
                    NEW.request_json, '$.access_scope.contract_version'
                  )
                  AND card.board_id=NEW.board_id
              ) THEN NULL
            WHEN json_extract(NEW.request_json, '$.access_scope.kind')='job'
              AND json_extract(NEW.request_json, '$.access_scope.job_id')
                IS json_extract(NEW.request_json, '$.targets.job_id')
              AND EXISTS (
                SELECT 1 FROM jobs
                WHERE id=json_extract(NEW.request_json, '$.access_scope.job_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            WHEN json_extract(NEW.request_json, '$.access_scope.kind')='profile'
              AND json_extract(NEW.request_json, '$.access_scope.profile_id')
                IS json_extract(NEW.request_json, '$.targets.profile_id')
              AND EXISTS (
                SELECT 1 FROM agent_profiles
                WHERE id=json_extract(NEW.request_json, '$.access_scope.profile_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            WHEN json_extract(NEW.request_json, '$.access_scope.kind')='session'
              AND json_extract(NEW.request_json, '$.access_scope.session_id')
                IS json_extract(NEW.request_json, '$.targets.session_id')
              AND EXISTS (
                SELECT 1 FROM agent_sessions session
                JOIN workspaces workspace ON workspace.id=session.workspace_id
                WHERE session.id=json_extract(
                    NEW.request_json, '$.access_scope.session_id'
                  )
                  AND workspace.board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'context build access scope is inconsistent')
          END;

          SELECT CASE
            WHEN json_type(NEW.request_json, '$.targets.workspace_id') IS NULL
              OR json_type(NEW.request_json, '$.targets.workspace_id')='null' THEN NULL
            WHEN json_type(NEW.request_json, '$.targets.workspace_id')='text'
              AND EXISTS (
                SELECT 1 FROM workspaces
                WHERE id=json_extract(NEW.request_json, '$.targets.workspace_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'context build workspace target is inconsistent')
          END;

          SELECT CASE
            WHEN json_type(NEW.request_json, '$.targets.card_id') IS NULL
              OR json_type(NEW.request_json, '$.targets.card_id')='null' THEN NULL
            WHEN json_type(NEW.request_json, '$.targets.card_id')='integer'
              AND EXISTS (
                SELECT 1 FROM cards
                WHERE id=json_extract(NEW.request_json, '$.targets.card_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'context build card target is inconsistent')
          END;

          SELECT CASE
            WHEN json_type(NEW.request_json, '$.targets.contract_version') IS NULL
              OR json_type(NEW.request_json, '$.targets.contract_version')='null' THEN
              CASE WHEN
                json_extract(NEW.request_json, '$.targets.contract_ref') IS NULL
                AND json_extract(
                  NEW.request_json, '$.targets.contract_snapshot_sha256'
                ) IS NULL
              THEN NULL
              ELSE RAISE(ABORT, 'context build contract target is inconsistent') END
            WHEN json_type(NEW.request_json, '$.targets.contract_version')='integer'
              AND json_type(NEW.request_json, '$.targets.card_id')='integer'
              AND json_type(NEW.request_json, '$.targets.contract_ref')='text'
              AND json_extract(NEW.request_json, '$.targets.contract_ref')=(
                'card:' || json_extract(NEW.request_json, '$.targets.card_id')
                || ':v' || json_extract(
                  NEW.request_json, '$.targets.contract_version'
                )
              )
              AND json_type(
                NEW.request_json, '$.targets.contract_snapshot_sha256'
              )='text'
              AND length(json_extract(
                NEW.request_json, '$.targets.contract_snapshot_sha256'
              ))=64
              AND json_extract(
                NEW.request_json, '$.targets.contract_snapshot_sha256'
              ) NOT GLOB '*[^0-9a-f]*'
              AND EXISTS (
                SELECT 1 FROM task_contracts contract
                JOIN cards card ON card.id=contract.card_id
                WHERE contract.card_id=json_extract(
                    NEW.request_json, '$.targets.card_id'
                  )
                  AND contract.version=json_extract(
                    NEW.request_json, '$.targets.contract_version'
                  )
                  AND card.board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'context build contract target is inconsistent')
          END;

          SELECT CASE
            WHEN json_type(NEW.request_json, '$.targets.job_id') IS NULL
              OR json_type(NEW.request_json, '$.targets.job_id')='null' THEN NULL
            WHEN json_type(NEW.request_json, '$.targets.job_id')='text'
              AND EXISTS (
                SELECT 1 FROM jobs
                WHERE id=json_extract(NEW.request_json, '$.targets.job_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'context build job target is inconsistent')
          END;

          SELECT CASE
            WHEN json_type(NEW.request_json, '$.targets.profile_id') IS NULL
              OR json_type(NEW.request_json, '$.targets.profile_id')='null' THEN NULL
            WHEN json_type(NEW.request_json, '$.targets.profile_id')='text'
              AND EXISTS (
                SELECT 1 FROM agent_profiles
                WHERE id=json_extract(NEW.request_json, '$.targets.profile_id')
                  AND board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'context build profile target is inconsistent')
          END;

          SELECT CASE
            WHEN json_type(NEW.request_json, '$.targets.session_id') IS NULL
              OR json_type(NEW.request_json, '$.targets.session_id')='null' THEN NULL
            WHEN json_type(NEW.request_json, '$.targets.session_id')='text'
              AND EXISTS (
                SELECT 1 FROM agent_sessions session
                JOIN workspaces workspace ON workspace.id=session.workspace_id
                WHERE session.id=json_extract(
                    NEW.request_json, '$.targets.session_id'
                  )
                  AND workspace.board_id=NEW.board_id
              ) THEN NULL
            ELSE RAISE(ABORT, 'context build session target is inconsistent')
          END;

          SELECT CASE WHEN
            (
              json_extract(NEW.request_json, '$.targets.workspace_id') IS NOT NULL
              AND json_extract(NEW.request_json, '$.targets.card_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM workspaces workspace
                WHERE workspace.id=json_extract(
                    NEW.request_json, '$.targets.workspace_id'
                  )
                  AND (
                    workspace.card_id IS NULL
                    OR workspace.card_id=json_extract(
                      NEW.request_json, '$.targets.card_id'
                    )
                  )
              )
            )
            OR (
              json_extract(NEW.request_json, '$.targets.job_id') IS NOT NULL
              AND json_extract(NEW.request_json, '$.targets.card_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs job
                WHERE job.id=json_extract(NEW.request_json, '$.targets.job_id')
                  AND job.card_id=json_extract(
                    NEW.request_json, '$.targets.card_id'
                  )
              )
            )
            OR (
              json_extract(NEW.request_json, '$.targets.job_id') IS NOT NULL
              AND json_extract(NEW.request_json, '$.targets.workspace_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs job
                WHERE job.id=json_extract(NEW.request_json, '$.targets.job_id')
                  AND job.workspace_id=json_extract(
                    NEW.request_json, '$.targets.workspace_id'
                  )
              )
            )
            OR (
              json_extract(NEW.request_json, '$.targets.job_id') IS NOT NULL
              AND json_extract(
                NEW.request_json, '$.targets.contract_version'
              ) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs job
                WHERE job.id=json_extract(
                    NEW.request_json, '$.targets.job_id'
                  )
                  AND job.contract_version=json_extract(
                    NEW.request_json, '$.targets.contract_version'
                  )
              )
            )
            OR (
              json_extract(NEW.request_json, '$.targets.job_id') IS NOT NULL
              AND json_extract(
                NEW.request_json, '$.targets.profile_id'
              ) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs job
                WHERE job.id=json_extract(
                    NEW.request_json, '$.targets.job_id'
                  )
                  AND (
                    job.assigned_profile_id IS NULL
                    OR job.assigned_profile_id=json_extract(
                      NEW.request_json, '$.targets.profile_id'
                    )
                  )
              )
            )
            OR (
              json_extract(
                NEW.request_json, '$.targets.session_id'
              ) IS NOT NULL
              AND json_extract(
                NEW.request_json, '$.targets.card_id'
              ) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM agent_sessions session
                JOIN workspaces workspace ON workspace.id=session.workspace_id
                LEFT JOIN jobs job ON job.id=session.job_id
                WHERE session.id=json_extract(
                    NEW.request_json, '$.targets.session_id'
                  )
                  AND (
                    (
                      session.job_id IS NOT NULL
                      AND job.card_id=json_extract(
                        NEW.request_json, '$.targets.card_id'
                      )
                    )
                    OR (
                      session.job_id IS NULL
                      AND (
                        workspace.card_id IS NULL
                        OR workspace.card_id=json_extract(
                          NEW.request_json, '$.targets.card_id'
                        )
                      )
                    )
                  )
              )
            )
            OR (
              json_extract(
                NEW.request_json, '$.targets.session_id'
              ) IS NOT NULL
              AND json_extract(
                NEW.request_json, '$.targets.contract_version'
              ) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM agent_sessions session
                JOIN jobs job ON job.id=session.job_id
                WHERE session.id=json_extract(
                    NEW.request_json, '$.targets.session_id'
                  )
                  AND job.contract_version=json_extract(
                    NEW.request_json, '$.targets.contract_version'
                  )
              )
            )
            OR (
              json_extract(NEW.request_json, '$.targets.session_id') IS NOT NULL
              AND json_extract(NEW.request_json, '$.targets.job_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM agent_sessions session
                WHERE session.id=json_extract(
                    NEW.request_json, '$.targets.session_id'
                  )
                  AND session.job_id=json_extract(
                    NEW.request_json, '$.targets.job_id'
                  )
              )
            )
            OR (
              json_extract(NEW.request_json, '$.targets.session_id') IS NOT NULL
              AND json_extract(NEW.request_json, '$.targets.profile_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM agent_sessions session
                WHERE session.id=json_extract(
                    NEW.request_json, '$.targets.session_id'
                  )
                  AND session.profile_id=json_extract(
                    NEW.request_json, '$.targets.profile_id'
                  )
              )
            )
            OR (
              json_extract(NEW.request_json, '$.targets.session_id') IS NOT NULL
              AND json_extract(NEW.request_json, '$.targets.workspace_id') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM agent_sessions session
                WHERE session.id=json_extract(
                    NEW.request_json, '$.targets.session_id'
                  )
                  AND session.workspace_id=json_extract(
                    NEW.request_json, '$.targets.workspace_id'
                  )
              )
            )
          THEN RAISE(ABORT, 'context build target links are inconsistent') END;

        END;

        CREATE TRIGGER context_builds_identity_immutable
        BEFORE UPDATE ON context_builds
        WHEN NEW.board_id IS NOT OLD.board_id
          OR NEW.id IS NOT OLD.id
          OR NEW.request_json IS NOT OLD.request_json
          OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
          OR NEW.source_set_json IS NOT OLD.source_set_json
          OR NEW.source_set_fingerprint IS NOT OLD.source_set_fingerprint
          OR NEW.manifest_fingerprint IS NOT OLD.manifest_fingerprint
          OR NEW.usage_json IS NOT OLD.usage_json
          OR NEW.source_count IS NOT OLD.source_count
          OR NEW.entry_count IS NOT OLD.entry_count
          OR NEW.created_at IS NOT OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'context build identity and evidence are immutable');
        END;

        CREATE TRIGGER context_builds_status_transition
        BEFORE UPDATE OF status, invalidated_at ON context_builds
        WHEN NOT (
          (NEW.status IS OLD.status AND NEW.invalidated_at IS OLD.invalidated_at)
          OR (
            OLD.status='built'
            AND NEW.status='used'
            AND NEW.invalidated_at IS NULL
            AND EXISTS (
              SELECT 1 FROM context_uses use
              WHERE use.board_id=OLD.board_id
                AND use.context_build_id=OLD.id
            )
          )
          OR (
            OLD.status='built'
            AND NEW.status='failed'
            AND NEW.invalidated_at IS NULL
          )
          OR (
            OLD.status IN ('built', 'used')
            AND NEW.status='invalidated'
            AND OLD.invalidated_at IS NULL
            AND NEW.invalidated_at IS NOT NULL
            AND NEW.invalidated_at>=OLD.created_at
          )
        )
        BEGIN
          SELECT RAISE(ABORT, 'invalid context build status transition');
        END;

        CREATE TRIGGER context_builds_delete
        BEFORE DELETE ON context_builds
        BEGIN
          SELECT RAISE(ABORT, 'context build evidence is immutable');
        END;

        CREATE TRIGGER context_build_sources_insert
        BEFORE INSERT ON context_build_sources
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM context_builds build
            WHERE build.board_id=NEW.board_id
              AND build.id=NEW.context_build_id
              AND build.status='built'
              AND NEW.source_ordinal<build.source_count
              AND NEW.source_ordinal=(
                SELECT COUNT(*) FROM context_build_sources prior
                WHERE prior.board_id=NEW.board_id
                  AND prior.context_build_id=NEW.context_build_id
              )
              AND json_extract(
                build.source_set_json,
                '$[' || NEW.source_ordinal || '].source_id'
              )=NEW.source_id
              AND json_extract(
                build.source_set_json,
                '$[' || NEW.source_ordinal || '].source_revision'
              )=NEW.source_revision
              AND json_extract(
                build.source_set_json,
                '$[' || NEW.source_ordinal || '].content_sha256'
              )=NEW.content_sha256
              AND json_extract(
                build.source_set_json,
                '$[' || NEW.source_ordinal || '].freshness_state'
              )=NEW.freshness_state
              AND json_extract(
                build.source_set_json,
                '$[' || NEW.source_ordinal || '].redaction_state'
              )=NEW.redaction_state
          ) THEN RAISE(ABORT, 'context build source order or evidence is inconsistent') END;

          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM knowledge_sources source
            WHERE source.board_id=NEW.board_id
              AND source.id=NEW.source_id
              AND source.source_revision=NEW.source_revision
              AND source.content_sha256=NEW.content_sha256
              AND source.freshness_state=NEW.freshness_state
              AND source.redaction_state=NEW.redaction_state
          ) THEN RAISE(ABORT, 'context build source snapshot is inconsistent') END;
        END;

        CREATE TRIGGER context_build_sources_immutable
        BEFORE UPDATE ON context_build_sources
        BEGIN
          SELECT RAISE(ABORT, 'context build source evidence is immutable');
        END;

        CREATE TRIGGER context_build_sources_delete
        BEFORE DELETE ON context_build_sources
        BEGIN
          SELECT RAISE(ABORT, 'context build source evidence is immutable');
        END;

        CREATE TRIGGER context_build_entries_insert
        BEFORE INSERT ON context_build_entries
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM context_builds build
            WHERE build.board_id=NEW.board_id
              AND build.id=NEW.context_build_id
              AND build.status='built'
              AND NEW.candidate_ordinal<build.entry_count
              AND NEW.candidate_ordinal=(
                SELECT COUNT(*) FROM context_build_entries prior
                WHERE prior.board_id=NEW.board_id
                  AND prior.context_build_id=NEW.context_build_id
              )
              AND (
                NEW.selected_ordinal IS NULL
                OR NEW.selected_ordinal=(
                  SELECT COUNT(*) FROM context_build_entries prior
                  WHERE prior.board_id=NEW.board_id
                    AND prior.context_build_id=NEW.context_build_id
                    AND prior.selected_ordinal IS NOT NULL
                )
              )
          ) THEN RAISE(ABORT, 'context build entry order is inconsistent') END;

          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM context_build_sources source
            WHERE source.board_id=NEW.board_id
              AND source.context_build_id=NEW.context_build_id
              AND source.source_id=NEW.source_id
          ) THEN RAISE(ABORT, 'context build entry source set is inconsistent') END;

          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM knowledge_sources source
            WHERE source.board_id=NEW.board_id
              AND source.id=NEW.source_id
              AND source.source_kind=NEW.source_kind
              AND source.trust_class=NEW.trust_class
              AND source.freshness_state=NEW.freshness_state
              AND source.redaction_state=NEW.redaction_state
              AND source.normalized_locator=NEW.normalized_locator
          ) THEN RAISE(ABORT, 'context build entry source snapshot is inconsistent') END;

          SELECT CASE WHEN NOT (
            (
              NEW.redaction_state='withheld'
              AND NEW.decision='omitted'
              AND NOT EXISTS (
                SELECT 1 FROM knowledge_chunks
                WHERE board_id=NEW.board_id AND id=NEW.chunk_id
              )
            )
            OR EXISTS (
              SELECT 1 FROM knowledge_chunks chunk
              WHERE chunk.board_id=NEW.board_id
                AND chunk.id=NEW.chunk_id
                AND chunk.source_id=NEW.source_id
                AND chunk.content_sha256=NEW.content_sha256
                AND chunk.source_range_json=NEW.source_range_json
            )
          ) THEN RAISE(ABORT, 'context build entry chunk snapshot is inconsistent') END;
        END;

        CREATE TRIGGER context_build_entries_immutable
        BEFORE UPDATE ON context_build_entries
        BEGIN
          SELECT RAISE(ABORT, 'context build entry evidence is immutable');
        END;

        CREATE TRIGGER context_build_entries_delete
        BEFORE DELETE ON context_build_entries
        BEGIN
          SELECT RAISE(ABORT, 'context build entry evidence is immutable');
        END;

        CREATE TRIGGER context_uses_insert
        BEFORE INSERT ON context_uses
        BEGIN
          SELECT CASE WHEN NEW.outcome!='running'
          THEN RAISE(ABORT, 'context use must begin running') END;

          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM context_builds build
            WHERE build.board_id=NEW.board_id
              AND build.id=NEW.context_build_id
              AND build.status IN ('built', 'used')
              AND build.manifest_fingerprint=NEW.manifest_fingerprint
              AND NEW.injected_at>=build.created_at
              AND json_type(build.usage_json, '$.used_tokens')='integer'
              AND json_extract(build.usage_json, '$.used_tokens')=NEW.estimated_tokens
              AND build.source_count=(
                SELECT COUNT(*) FROM context_build_sources source
                WHERE source.board_id=build.board_id
                  AND source.context_build_id=build.id
              )
              AND build.entry_count=(
                SELECT COUNT(*) FROM context_build_entries entry
                WHERE entry.board_id=build.board_id
                  AND entry.context_build_id=build.id
              )
              AND json_extract(build.usage_json, '$.used_tokens')>=(
                SELECT COALESCE(SUM(entry.estimated_tokens), 0)
                FROM context_build_entries entry
                WHERE entry.board_id=build.board_id
                  AND entry.context_build_id=build.id
                  AND entry.decision='selected'
              )
              AND json_extract(build.usage_json, '$.used_characters')>=(
                SELECT COALESCE(SUM(entry.character_count), 0)
                FROM context_build_entries entry
                WHERE entry.board_id=build.board_id
                  AND entry.context_build_id=build.id
                  AND entry.decision='selected'
              )
              AND NOT EXISTS (
                SELECT 1 FROM json_each(
                  build.usage_json, '$.sections'
                ) usage_section
                WHERE json_extract(
                    usage_section.value, '$.used_tokens'
                  )!=(
                    SELECT COALESCE(SUM(entry.estimated_tokens), 0)
                    FROM context_build_entries entry
                    WHERE entry.board_id=build.board_id
                      AND entry.context_build_id=build.id
                      AND entry.decision='selected'
                      AND entry.section=usage_section.key
                  )
                  OR json_extract(
                    usage_section.value, '$.used_characters'
                  )!=(
                    SELECT COALESCE(SUM(entry.character_count), 0)
                    FROM context_build_entries entry
                    WHERE entry.board_id=build.board_id
                      AND entry.context_build_id=build.id
                      AND entry.decision='selected'
                      AND entry.section=usage_section.key
                  )
              )
              AND NOT EXISTS (
                SELECT 1 FROM context_build_entries selected
                WHERE selected.board_id=build.board_id
                  AND selected.context_build_id=build.id
                  AND selected.decision='selected'
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(
                      build.usage_json, '$.sections'
                    ) usage_section
                    WHERE usage_section.key=selected.section
                  )
              )
          ) THEN RAISE(ABORT, 'context use build evidence is inconsistent') END;

          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM jobs job
            JOIN agent_sessions session ON session.id=NEW.session_id
            JOIN workspaces workspace ON workspace.id=session.workspace_id
            JOIN context_builds build
              ON build.board_id=NEW.board_id
              AND build.id=NEW.context_build_id
            WHERE job.id=NEW.job_id
              AND job.board_id=NEW.board_id
              AND workspace.board_id=NEW.board_id
              AND session.job_id=job.id
              AND (
                json_extract(build.request_json, '$.targets.workspace_id') IS NULL
                OR (
                  json_extract(build.request_json, '$.targets.workspace_id')=workspace.id
                  AND job.workspace_id=workspace.id
                )
              )
              AND (
                json_extract(build.request_json, '$.targets.card_id') IS NULL
                OR json_extract(build.request_json, '$.targets.card_id')=job.card_id
              )
              AND (
                json_extract(build.request_json, '$.targets.contract_version') IS NULL
                OR json_extract(
                  build.request_json, '$.targets.contract_version'
                )=job.contract_version
              )
              AND (
                json_extract(build.request_json, '$.targets.job_id') IS NULL
                OR json_extract(build.request_json, '$.targets.job_id')=job.id
              )
              AND (
                json_extract(build.request_json, '$.targets.profile_id') IS NULL
                OR json_extract(
                  build.request_json, '$.targets.profile_id'
                )=session.profile_id
                OR json_extract(
                  build.request_json, '$.targets.profile_id'
                )=job.assigned_profile_id
              )
              AND (
                json_extract(build.request_json, '$.targets.session_id') IS NULL
                OR json_extract(build.request_json, '$.targets.session_id')=session.id
              )
          ) THEN RAISE(ABORT, 'context use runtime scope is inconsistent') END;
        END;

        CREATE TRIGGER context_uses_mark_build_used
        AFTER INSERT ON context_uses
        WHEN EXISTS (
          SELECT 1 FROM context_builds
          WHERE board_id=NEW.board_id
            AND id=NEW.context_build_id
            AND status='built'
        )
        BEGIN
          UPDATE context_builds
          SET status='used'
          WHERE board_id=NEW.board_id AND id=NEW.context_build_id;
        END;

        CREATE TRIGGER context_uses_finish
        BEFORE UPDATE ON context_uses
        WHEN NEW.board_id IS NOT OLD.board_id
          OR NEW.id IS NOT OLD.id
          OR NEW.context_build_id IS NOT OLD.context_build_id
          OR NEW.job_id IS NOT OLD.job_id
          OR NEW.session_id IS NOT OLD.session_id
          OR NEW.injection_ordinal IS NOT OLD.injection_ordinal
          OR NEW.manifest_fingerprint IS NOT OLD.manifest_fingerprint
          OR NEW.estimated_tokens IS NOT OLD.estimated_tokens
          OR NEW.cache_identity IS NOT OLD.cache_identity
          OR NEW.injected_at IS NOT OLD.injected_at
          OR OLD.outcome!='running'
          OR NEW.outcome NOT IN ('completed', 'failed', 'cancelled')
          OR NEW.completed_at IS NULL
          OR NEW.completed_at<OLD.injected_at
          OR (NEW.outcome='completed' AND NEW.actual_tokens IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'context use identity or lifecycle is immutable');
        END;

        CREATE TRIGGER context_uses_delete
        BEFORE DELETE ON context_uses
        BEGIN
          SELECT RAISE(ABORT, 'context use evidence is immutable');
        END;
      `)

      assertKnowledgeSchemaCompatible(db)
    },
  },
  {
    id: '019-provider-acceptance-evidence',
    apply(db) {
      const hasMigration018 = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id='018-knowledge-persistence'`).get()
      if (!hasMigration018) {
        throw new Error(
          'migration 019-provider-acceptance-evidence requires 018-knowledge-persistence',
        )
      }
      const existing = db.prepare(`SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='provider_acceptance_evidence'`).get()
      if (existing) assertProviderAcceptanceEvidenceSchemaCompatible(db)

      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_acceptance_evidence (
          id TEXT PRIMARY KEY
            CHECK(length(id)=67
              AND substr(id, 1, 3)='pe_'
              AND substr(id, 4) NOT GLOB '*[^0-9a-f]*'),
          contract_version INTEGER NOT NULL
            CHECK(contract_version=1),
          provider_id TEXT NOT NULL
            CHECK(length(provider_id) BETWEEN 1 AND 128
              AND provider_id NOT GLOB '*[^a-z0-9_.-]*'),
          adapter_id TEXT NOT NULL
            CHECK(length(adapter_id) BETWEEN 1 AND 128
              AND adapter_id NOT GLOB '*[^a-z0-9_.-]*'),
          adapter_version TEXT NOT NULL
            CHECK(length(adapter_version) BETWEEN 1 AND 128),
          mode_id TEXT NOT NULL
            CHECK(length(mode_id) BETWEEN 1 AND 128
              AND mode_id NOT GLOB '*[^a-z0-9_.-]*'),
          runtime_mode TEXT NOT NULL
            CHECK(runtime_mode IN ('native_cli', 'provider_api')),
          billing_mode TEXT NOT NULL
            CHECK(billing_mode IN ('personal_subscription', 'usage_priced_api')),
          credential_kind TEXT NOT NULL
            CHECK(credential_kind IN (
              'provider_account_session', 'subscription_scoped_key',
              'subscription_access_token', 'usage_priced_api_key'
            )),
          executable_version TEXT NOT NULL
            CHECK(length(executable_version) BETWEEN 1 AND 128),
          platform TEXT NOT NULL
            CHECK(length(platform) BETWEEN 1 AND 128
              AND platform NOT GLOB '*[^a-z0-9_.-]*'),
          source_commit TEXT NOT NULL
            CHECK(length(source_commit) IN (40, 64)
              AND source_commit NOT GLOB '*[^0-9a-f]*'),
          observed_at TEXT NOT NULL
            CHECK(strftime('%s', observed_at) IS NOT NULL),
          matrix_json TEXT NOT NULL
            CHECK(json_valid(matrix_json)
              AND json_type(matrix_json)='object'
              AND json(matrix_json)=matrix_json
              AND length(CAST(matrix_json AS BLOB))<=1000000),
          matrix_sha256 TEXT NOT NULL
            CHECK(length(matrix_sha256)=64
              AND matrix_sha256 NOT GLOB '*[^0-9a-f]*'),
          artifact_ref TEXT NOT NULL
            CHECK(length(trim(artifact_ref)) BETWEEN 1 AND 2048
              AND trim(artifact_ref)=artifact_ref),
          artifact_sha256 TEXT NOT NULL
            CHECK(length(artifact_sha256)=64
              AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
          recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
            CHECK(strftime('%s', recorded_at) IS NOT NULL),
          UNIQUE(
            provider_id, adapter_id, mode_id, runtime_mode, billing_mode,
            credential_kind, executable_version, platform, source_commit,
            observed_at
          )
        );

        CREATE INDEX IF NOT EXISTS idx_provider_acceptance_evidence_tuple_latest
          ON provider_acceptance_evidence(
            provider_id, adapter_id, mode_id, runtime_mode, billing_mode,
            credential_kind, executable_version, platform, source_commit,
            observed_at DESC, recorded_at DESC
          );

        CREATE TRIGGER IF NOT EXISTS provider_acceptance_evidence_insert
        BEFORE INSERT ON provider_acceptance_evidence
        BEGIN
          SELECT CASE WHEN
            json_type(NEW.matrix_json) IS NOT 'object'
            OR (SELECT COUNT(*) FROM json_each(NEW.matrix_json))!=13
            OR json_type(NEW.matrix_json, '$.contract_version') IS NOT 'integer'
            OR json_extract(NEW.matrix_json, '$.contract_version') IS NOT NEW.contract_version
            OR json_extract(NEW.matrix_json, '$.provider_id') IS NOT NEW.provider_id
            OR json_extract(NEW.matrix_json, '$.adapter_id') IS NOT NEW.adapter_id
            OR json_extract(NEW.matrix_json, '$.adapter_version') IS NOT NEW.adapter_version
            OR json_extract(NEW.matrix_json, '$.mode_id') IS NOT NEW.mode_id
            OR json_extract(NEW.matrix_json, '$.runtime_mode') IS NOT NEW.runtime_mode
            OR json_extract(NEW.matrix_json, '$.billing_mode') IS NOT NEW.billing_mode
            OR json_extract(NEW.matrix_json, '$.credential_kind') IS NOT NEW.credential_kind
            OR json_extract(NEW.matrix_json, '$.executable_version') IS NOT NEW.executable_version
            OR json_extract(NEW.matrix_json, '$.platform') IS NOT NEW.platform
            OR json_extract(NEW.matrix_json, '$.source_commit') IS NOT NEW.source_commit
            OR json_extract(NEW.matrix_json, '$.observed_at') IS NOT NEW.observed_at
            OR json_type(NEW.matrix_json, '$.gates') IS NOT 'object'
            OR (SELECT COUNT(*) FROM json_each(NEW.matrix_json, '$.gates'))!=8
            OR EXISTS (
              SELECT 1 FROM json_each(NEW.matrix_json, '$.gates') gate
              WHERE gate.key NOT IN (
                'executable_provenance', 'subscription_billing',
                'credential_conflict', 'managed_lifecycle', 'restart_recovery',
                'raw_terminal_coexistence', 'failure_semantics',
                'credential_redaction'
              )
                OR json_type(gate.value) IS NOT 'object'
                OR (SELECT COUNT(*) FROM json_each(gate.value))!=2
                OR EXISTS (
                  SELECT 1 FROM json_each(gate.value) gate_field
                  WHERE gate_field.key NOT IN ('state', 'evidence_refs')
                )
                OR json_type(gate.value, '$.state') IS NOT 'text'
                OR json_extract(gate.value, '$.state')
                  NOT IN ('passed', 'failed', 'not_run')
                OR json_type(gate.value, '$.evidence_refs') IS NOT 'array'
                OR (
                  json_extract(gate.value, '$.state')='passed'
                  AND json_array_length(gate.value, '$.evidence_refs')=0
                )
                OR EXISTS (
                  SELECT 1 FROM json_each(gate.value, '$.evidence_refs') evidence
                  WHERE evidence.type!='text'
                    OR length(trim(evidence.value)) NOT BETWEEN 1 AND 2048
                    OR trim(evidence.value)!=evidence.value
                )
                OR (
                  SELECT COUNT(*) FROM json_each(gate.value, '$.evidence_refs')
                )!=(
                  SELECT COUNT(DISTINCT evidence.value)
                  FROM json_each(gate.value, '$.evidence_refs') evidence
                )
            )
          THEN RAISE(ABORT, 'provider acceptance matrix evidence is inconsistent') END;
        END;

        CREATE TRIGGER IF NOT EXISTS provider_acceptance_evidence_update
        BEFORE UPDATE ON provider_acceptance_evidence
        BEGIN
          SELECT RAISE(ABORT, 'provider acceptance evidence is immutable');
        END;

        CREATE TRIGGER IF NOT EXISTS provider_acceptance_evidence_delete
        BEFORE DELETE ON provider_acceptance_evidence
        BEGIN
          SELECT RAISE(ABORT, 'provider acceptance evidence is immutable');
        END;
      `)

      assertProviderAcceptanceEvidenceSchemaCompatible(db)
    },
  },
  {
    id: '020-causal-event-metadata',
    apply(db) {
      const hasMigration019 = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id='019-provider-acceptance-evidence'`).get()
      if (!hasMigration019) {
        throw new Error(
          'migration 020-causal-event-metadata requires 019-provider-acceptance-evidence',
        )
      }

      const columns = new Set(
        (db.prepare(`SELECT name FROM pragma_table_info('os_events')`).all() as Array<{
          name: string
        }>).map((column) => column.name),
      )
      const hasActorType = columns.has('actor_type')
      const hasActorId = columns.has('actor_id')
      if (hasActorType !== hasActorId) {
        throw new Error(
          'migration 020-causal-event-metadata found incompatible actor metadata columns',
        )
      }
      if (!hasActorType) {
        db.exec(`
          ALTER TABLE os_events
            ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'system';
          ALTER TABLE os_events
            ADD COLUMN actor_id TEXT;
        `)
      }
      assertCausalEventMetadataColumnsCompatible(db)

      const needsBackfill = db.prepare(`SELECT 1
        FROM os_events
        WHERE correlation_id IS NULL
          OR (
            actor_type='system'
            AND actor_id IS NULL
            AND length(trim(source)) BETWEEN 1 AND 256
          )
        LIMIT 1`).get()
      if (needsBackfill) {
        const assignmentUpdateTrigger = db.prepare(`SELECT sql
          FROM sqlite_master
          WHERE type='trigger'
            AND name='os_events_job_assignment_identity_update'`).get() as
          { sql: string } | undefined
        if (assignmentUpdateTrigger) {
          db.exec('DROP TRIGGER os_events_job_assignment_identity_update')
        }

        db.exec(`
          UPDATE os_events
          SET actor_type=CASE
                WHEN actor_type='system'
                  AND actor_id IS NULL
                  AND CASE WHEN json_valid(payload)
                    THEN json_type(payload, '$.actor.type')='text'
                      AND length(trim(json_extract(
                        payload, '$.actor.type'
                      ))) BETWEEN 1 AND 64
                    ELSE 0
                  END
                THEN trim(json_extract(payload, '$.actor.type'))
                ELSE actor_type
              END,
              actor_id=CASE
                WHEN actor_type='system'
                  AND actor_id IS NULL
                  AND CASE WHEN json_valid(payload)
                    THEN json_type(payload, '$.actor.type')='text'
                      AND length(trim(json_extract(
                        payload, '$.actor.type'
                      ))) BETWEEN 1 AND 64
                    ELSE 0
                  END
                THEN CASE
                  WHEN json_type(payload, '$.actor.id')='text'
                    AND length(trim(json_extract(
                      payload, '$.actor.id'
                    ))) BETWEEN 1 AND 256
                  THEN trim(json_extract(payload, '$.actor.id'))
                  WHEN trim(json_extract(payload, '$.actor.type'))='system'
                    AND length(trim(source)) BETWEEN 1 AND 256
                  THEN trim(source)
                  ELSE NULL
                END
                WHEN actor_type='system'
                  AND actor_id IS NULL
                  AND length(trim(source)) BETWEEN 1 AND 256
                THEN trim(source)
                ELSE actor_id
              END,
              correlation_id=coalesce(correlation_id, id)
          WHERE correlation_id IS NULL
            OR (
              actor_type='system'
              AND actor_id IS NULL
              AND length(trim(source)) BETWEEN 1 AND 256
            );
        `)

        if (assignmentUpdateTrigger) db.exec(assignmentUpdateTrigger.sql)
      }

      const objectExists = db.prepare(`SELECT 1 FROM sqlite_master
        WHERE type=? AND name=?`)
      for (const object of CAUSAL_EVENT_METADATA_OBJECTS) {
        if (!objectExists.get(object.type, object.name)) db.exec(object.sql)
      }

      assertCausalEventMetadataSchemaCompatible(db)
    },
  },
  {
    id: '021-command-idempotency-coverage',
    apply(db) {
      const hasMigration020 = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id='020-causal-event-metadata'`).get()
      if (!hasMigration020) {
        throw new Error(
          'migration 021-command-idempotency-coverage requires 020-causal-event-metadata',
        )
      }

      const existing = db.prepare(`SELECT 1 FROM sqlite_master
        WHERE type='table' AND name='os_command_receipts'`).get()
      if (existing) {
        assertCommandReceiptSchemaCompatible(db)
      } else {
        db.exec(`
          ${COMMAND_RECEIPT_TABLE_SQL};
          ${COMMAND_RECEIPT_OBJECTS.map((object) => `${object.sql};`).join('\n')}
        `)
      }

      assertCommandReceiptSchemaCompatible(db)
    },
  },
  {
    id: '022-legacy-projection-forward-plan',
    apply(db) {
      applyCompatibilityForwardMigration(db)
    },
  },
  {
    id: AGENT_OS_COMPATIBILITY_MIGRATION_TELEMETRY_ID,
    apply(db) {
      applyCompatibilityMigrationTelemetryMigration(db)
    },
  },
  {
    id: AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID,
    apply(db) {
      applyCompatibilityMigrationFailureJournalMigration(db)
    },
  },
  {
    id: AGENT_OS_KNOWLEDGE_RETRIEVAL_MIGRATION_ID,
    apply(db) {
      const hasFailureJournal = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID)
      if (!hasFailureJournal) {
        throw new Error(
          `migration ${AGENT_OS_KNOWLEDGE_RETRIEVAL_MIGRATION_ID}`
          + ` requires ${AGENT_OS_COMPATIBILITY_MIGRATION_FAILURE_JOURNAL_ID}`,
        )
      }
      installKnowledgeRetrievalSchema(db)
    },
  },
  {
    id: '026-job-agent-brief',
    apply(db) {
      const hasKnowledgeRetrieval = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_KNOWLEDGE_RETRIEVAL_MIGRATION_ID)
      if (!hasKnowledgeRetrieval) {
        throw new Error(
          'migration 026-job-agent-brief requires 025-knowledge-retrieval',
        )
      }
      const columns = new Set(
        (db.prepare(`SELECT name FROM pragma_table_info('jobs')`).all() as Array<{
          name: string
        }>).map((column) => column.name),
      )
      const hasBrief = columns.has('agent_brief')
      const hasDigest = columns.has('agent_brief_sha256')
      if (hasBrief !== hasDigest) {
        throw new Error(
          'migration 026-job-agent-brief found incomplete brief columns',
        )
      }
      if (!hasBrief) {
        db.exec(`
          ALTER TABLE jobs ADD COLUMN agent_brief TEXT;
          ALTER TABLE jobs ADD COLUMN agent_brief_sha256 TEXT;
        `)
      }
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS jobs_agent_brief_insert
        BEFORE INSERT ON jobs
        WHEN (NEW.agent_brief IS NULL) != (NEW.agent_brief_sha256 IS NULL)
          OR (NEW.agent_brief_sha256 IS NOT NULL AND (
            length(NEW.agent_brief_sha256) != 64
            OR NEW.agent_brief_sha256 GLOB '*[^0-9a-f]*'
          ))
        BEGIN
          SELECT RAISE(ABORT, 'job agent brief evidence is invalid');
        END;

        CREATE TRIGGER IF NOT EXISTS jobs_agent_brief_update
        BEFORE UPDATE OF agent_brief, agent_brief_sha256 ON jobs
        WHEN (NEW.agent_brief IS NULL) != (NEW.agent_brief_sha256 IS NULL)
          OR (NEW.agent_brief_sha256 IS NOT NULL AND (
            length(NEW.agent_brief_sha256) != 64
            OR NEW.agent_brief_sha256 GLOB '*[^0-9a-f]*'
          ))
          OR (OLD.agent_brief IS NOT NULL AND (
            NEW.agent_brief IS NOT OLD.agent_brief
            OR NEW.agent_brief_sha256 IS NOT OLD.agent_brief_sha256
          ))
        BEGIN
          SELECT RAISE(ABORT, 'job agent brief evidence is invalid or immutable');
        END;
      `)
    },
  },
  {
    id: AGENT_OS_ORGANIZATION_CORE_MIGRATION_ID,
    apply(db) {
      const hasAgentBrief = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id='026-job-agent-brief'`).get()
      if (!hasAgentBrief) {
        throw new Error(
          `migration ${AGENT_OS_ORGANIZATION_CORE_MIGRATION_ID}`
          + ' requires 026-job-agent-brief',
        )
      }
      installOrganizationCoreSchema(db)
    },
  },
  {
    id: AGENT_OS_ORGANIZATION_COORDINATION_MIGRATION_ID,
    apply(db) {
      const hasOrganizationCore = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_ORGANIZATION_CORE_MIGRATION_ID)
      if (!hasOrganizationCore) {
        throw new Error(
          `migration ${AGENT_OS_ORGANIZATION_COORDINATION_MIGRATION_ID}`
          + ` requires ${AGENT_OS_ORGANIZATION_CORE_MIGRATION_ID}`,
        )
      }
      installOrganizationCoordinationSchema(db)
    },
  },
  {
    id: AGENT_OS_ORGANIZATION_ASSURANCE_MIGRATION_ID,
    apply(db) {
      const hasCoordination = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_ORGANIZATION_COORDINATION_MIGRATION_ID)
      if (!hasCoordination) {
        throw new Error(
          `migration ${AGENT_OS_ORGANIZATION_ASSURANCE_MIGRATION_ID}`
          + ` requires ${AGENT_OS_ORGANIZATION_COORDINATION_MIGRATION_ID}`,
        )
      }
      installOrganizationAssuranceSchema(db)
    },
  },
  {
    id: AGENT_OS_DELIVERY_TRACKBOOK_MIGRATION_ID,
    apply(db) {
      const hasAssurance = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_ORGANIZATION_ASSURANCE_MIGRATION_ID)
      if (!hasAssurance) {
        throw new Error(
          `migration ${AGENT_OS_DELIVERY_TRACKBOOK_MIGRATION_ID}`
          + ` requires ${AGENT_OS_ORGANIZATION_ASSURANCE_MIGRATION_ID}`,
        )
      }
      installDeliveryTrackbookSchema(db)
    },
  },
  {
    id: AGENT_OS_KNOWLEDGE_MANAGEMENT_MIGRATION_ID,
    apply(db) {
      const hasDeliveryTrackbook = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_DELIVERY_TRACKBOOK_MIGRATION_ID)
      if (!hasDeliveryTrackbook) {
        throw new Error(
          `migration ${AGENT_OS_KNOWLEDGE_MANAGEMENT_MIGRATION_ID}`
          + ` requires ${AGENT_OS_DELIVERY_TRACKBOOK_MIGRATION_ID}`,
        )
      }
      installKnowledgeManagementSchema(db)
    },
  },
  {
    id: AGENT_OS_DISCUSSION_MIGRATION_ID,
    apply(db) {
      const hasKnowledgeManagement = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_KNOWLEDGE_MANAGEMENT_MIGRATION_ID)
      if (!hasKnowledgeManagement) {
        throw new Error(
          `migration ${AGENT_OS_DISCUSSION_MIGRATION_ID}`
          + ` requires ${AGENT_OS_KNOWLEDGE_MANAGEMENT_MIGRATION_ID}`,
        )
      }
      installDiscussionSchema(db)
    },
  },
  {
    id: AGENT_OS_TEAM_PLANNING_MIGRATION_ID,
    apply(db) {
      const hasDiscussions = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_DISCUSSION_MIGRATION_ID)
      if (!hasDiscussions) {
        throw new Error(
          `migration ${AGENT_OS_TEAM_PLANNING_MIGRATION_ID}`
          + ` requires ${AGENT_OS_DISCUSSION_MIGRATION_ID}`,
        )
      }
      installTeamPlanningSchema(db)
    },
  },
  {
    id: AGENT_OS_TEAM_COLLABORATION_REVIEW_MIGRATION_ID,
    apply(db) {
      const hasTeamPlanning = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_TEAM_PLANNING_MIGRATION_ID)
      if (!hasTeamPlanning) {
        throw new Error(
          `migration ${AGENT_OS_TEAM_COLLABORATION_REVIEW_MIGRATION_ID}`
          + ` requires ${AGENT_OS_TEAM_PLANNING_MIGRATION_ID}`,
        )
      }
      installTeamCollaborationReviewSchema(db)
    },
  },
  {
    id: AGENT_OS_DELIVERY_SHIPMENT_INTEGRITY_MIGRATION_ID,
    apply(db) {
      const hasTeamCollaborationReview = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_TEAM_COLLABORATION_REVIEW_MIGRATION_ID)
      if (!hasTeamCollaborationReview) {
        throw new Error(
          `migration ${AGENT_OS_DELIVERY_SHIPMENT_INTEGRITY_MIGRATION_ID}`
          + ` requires ${AGENT_OS_TEAM_COLLABORATION_REVIEW_MIGRATION_ID}`,
        )
      }
      installDeliveryShipmentIntegritySchema(db)
    },
  },
  {
    id: AGENT_OS_KNOWLEDGE_CONTEXT_USE_ACTUAL_MIGRATION_ID,
    apply(db) {
      const dependencies = db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
        WHERE id IN (?, ?)`).get(
        '018-knowledge-persistence',
        AGENT_OS_DELIVERY_SHIPMENT_INTEGRITY_MIGRATION_ID,
      ) as { count: number }
      if (dependencies.count !== 2) {
        throw new Error(
          `migration ${AGENT_OS_KNOWLEDGE_CONTEXT_USE_ACTUAL_MIGRATION_ID}`
          + ' requires 018-knowledge-persistence'
          + ` and ${AGENT_OS_DELIVERY_SHIPMENT_INTEGRITY_MIGRATION_ID}`,
        )
      }
      installKnowledgeContextUseActualEvidenceSchema(db)
    },
  },
  {
    id: AGENT_OS_DELIVERY_AUTOSHIP_INTENT_MIGRATION_ID,
    apply(db) {
      const dependencies = db.prepare(`SELECT COUNT(*) AS count FROM os_schema_migrations
        WHERE id IN (?, ?)`).get(
        AGENT_OS_DELIVERY_SHIPMENT_INTEGRITY_MIGRATION_ID,
        AGENT_OS_KNOWLEDGE_CONTEXT_USE_ACTUAL_MIGRATION_ID,
      ) as { count: number }
      if (dependencies.count !== 2) {
        throw new Error(
          `migration ${AGENT_OS_DELIVERY_AUTOSHIP_INTENT_MIGRATION_ID}`
          + ` requires ${AGENT_OS_DELIVERY_SHIPMENT_INTEGRITY_MIGRATION_ID}`
          + ` and ${AGENT_OS_KNOWLEDGE_CONTEXT_USE_ACTUAL_MIGRATION_ID}`,
        )
      }
      installDeliveryAutoshipIntentSchema(db)
    },
  },
  {
    id: AGENT_OS_DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_MIGRATION_ID,
    apply(db) {
      const dependency = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_DELIVERY_AUTOSHIP_INTENT_MIGRATION_ID)
      if (!dependency) {
        throw new Error(
          `migration ${AGENT_OS_DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_MIGRATION_ID}`
          + ` requires ${AGENT_OS_DELIVERY_AUTOSHIP_INTENT_MIGRATION_ID}`,
        )
      }
      installDeliveryAutoshipWorktreeIdentitySchema(db)
    },
  },
  {
    id: AGENT_OS_TERMINAL_SESSION_STATE_MIGRATION_ID,
    apply(db) {
      const hasDurableWorktreeIdentity = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_MIGRATION_ID)
      if (!hasDurableWorktreeIdentity) {
        throw new Error(
          `migration ${AGENT_OS_TERMINAL_SESSION_STATE_MIGRATION_ID}`
          + ` requires ${AGENT_OS_DELIVERY_AUTOSHIP_WORKTREE_IDENTITY_MIGRATION_ID}`,
        )
      }
      const hasLegacyTerminalState = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_LEGACY_TERMINAL_SESSION_STATE_MIGRATION_ID)
      if (hasLegacyTerminalState) {
        const legacySchemaObjects = db.prepare(`SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE name IN (
            'terminal_workspace_state',
            'terminal_command_history',
            'idx_terminal_command_history_process',
            'idx_terminal_command_history_session',
            'terminal_workspace_state_process_insert_guard',
            'terminal_workspace_state_process_update_guard',
            'terminal_command_history_scope_insert_guard',
            'terminal_command_history_immutable_guard'
          )`).get() as { count: number }
        if (legacySchemaObjects.count !== 8) {
          throw new Error(
            `migration ${AGENT_OS_TERMINAL_SESSION_STATE_MIGRATION_ID}`
            + ` found incomplete ${AGENT_OS_LEGACY_TERMINAL_SESSION_STATE_MIGRATION_ID} schema`,
          )
        }
      } else {
        db.exec(TERMINAL_SESSION_STATE_SCHEMA_SQL)
      }
    },
  },
  {
    id: AGENT_OS_DEVICE_SESSION_MIGRATION_ID,
    apply(db) {
      const hasTerminalState = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_TERMINAL_SESSION_STATE_MIGRATION_ID)
      if (!hasTerminalState) {
        throw new Error(
          `migration ${AGENT_OS_DEVICE_SESSION_MIGRATION_ID}`
          + ` requires ${AGENT_OS_TERMINAL_SESSION_STATE_MIGRATION_ID}`,
        )
      }
      const hasLegacyDeviceSessions = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_LEGACY_DEVICE_SESSION_MIGRATION_ID)
      try {
        if (hasLegacyDeviceSessions) {
          deviceSessionSchemaFingerprint(db)
          attestRemoteDeviceProofSchema(db)
          attestRemoteSecuritySchema(db)
        }
        installDeviceSessionSchema(db)
        installRemoteDeviceProofSchema(db)
        installRemoteSecuritySchema(db)
      } catch (error) {
        if (hasLegacyDeviceSessions) {
          throw new Error(
            `migration ${AGENT_OS_DEVICE_SESSION_MIGRATION_ID}`
            + ` found incomplete ${AGENT_OS_LEGACY_DEVICE_SESSION_MIGRATION_ID} schema`,
            { cause: error },
          )
        }
        throw error
      }
    },
  },
  {
    id: OPERATIONS_RECOVERY_SCHEMA_ID,
    apply(db) {
      const hasDeviceSessions = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(AGENT_OS_DEVICE_SESSION_MIGRATION_ID)
      if (!hasDeviceSessions) {
        throw new Error(
          `migration ${OPERATIONS_RECOVERY_SCHEMA_ID}`
          + ` requires ${AGENT_OS_DEVICE_SESSION_MIGRATION_ID}`,
        )
      }
      const hasLegacyOperations = db.prepare(`SELECT 1 FROM os_schema_migrations
        WHERE id=?`).get(LEGACY_OPERATIONS_RECOVERY_SCHEMA_ID)
      try {
        installOperationsRecoverySchema(db)
      } catch (error) {
        if (hasLegacyOperations) {
          throw new Error(
            `migration ${OPERATIONS_RECOVERY_SCHEMA_ID}`
            + ` found incomplete ${LEGACY_OPERATIONS_RECOVERY_SCHEMA_ID} schema`,
            { cause: error },
          )
        }
        throw error
      }
    },
  },
]

/** Apply each Agent OS migration exactly once and atomically without deleting legacy tables. */
export function applyAgentOsMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS os_schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const applied = db.prepare('SELECT 1 FROM os_schema_migrations WHERE id = ?')
  const record = db.prepare('INSERT INTO os_schema_migrations (id) VALUES (?)')
  const migrate = db.transaction(() => {
    for (const migration of migrations) {
      if (applied.get(migration.id)) continue
      migration.apply(db)
      record.run(migration.id)
    }
    applyOutcomeAnalyticsMigration(db)
  })
  migrate()
  refreshCompatibilityMigrationTelemetryCollectorEpoch(db, {
    now: new Date(),
  })
}
