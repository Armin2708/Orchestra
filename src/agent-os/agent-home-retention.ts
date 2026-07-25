import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import {
  actorIdentity,
  boundedString,
  canonicalHash,
  commandReplay,
  stableJson,
  type ActorIdentity,
} from './agent-home-support.js'
import { parseJson, timestamp } from './json.js'

export const DEFAULT_AGENT_HOME_RETENTION_POLICY = Object.freeze({
  schema_version: 1 as const,
  transcript_days: 90,
  ephemeral_days: 7,
  raw_artifact_days: 30,
  audit_retention: 'forever' as const,
  pinned_retention: 'forever' as const,
})

export const AGENT_HOME_RETENTION_BATCH_LIMIT = 500

export interface AgentHomeRetentionPolicy {
  schema_version: 1
  transcript_days: number
  ephemeral_days: number
  raw_artifact_days: number
  audit_retention: 'forever'
  pinned_retention: 'forever'
  source: 'default' | 'configured'
  updated_by_actor_type: string | null
  updated_by_actor_id: string | null
  created_at: string | null
  updated_at: string | null
}

export interface AgentHomeRetentionCutoffs {
  transcript_before: string
  ephemeral_before: string
  raw_artifact_before: string
}

export interface AgentHomeRetentionRun {
  id: string
  board_id: number
  idempotency_key: string
  request_fingerprint: string
  as_of: string
  policy: AgentHomeRetentionPolicy
  cutoffs: AgentHomeRetentionCutoffs
  transcript_events_archived: number
  ephemeral_events_archived: number
  raw_artifacts_compacted: number
  inline_raw_bytes_removed: number
  legacy_evidence_bundles_sanitized: number
  batch_limit: number
  has_more: boolean
  actor_type: string
  actor_id: string | null
  created_at: string
  replayed: boolean
}

export interface ConfigureAgentHomeRetentionInput {
  boardId: number
  transcriptDays?: number
  ephemeralDays?: number
  rawArtifactDays?: number
  actor: ActorIdentity
  idempotencyKey: string
  correlationId?: string | null
}

export interface AgentHomeRetentionHooks {
  afterRawArchiveRecord?: (input: { artifactId: string; runId: string }) => void
  afterRawContentCompacted?: (input: { artifactId: string; runId: string }) => void
}

export interface RunAgentHomeRetentionInput {
  boardId: number
  actor: ActorIdentity
  idempotencyKey: string
  asOf?: string
  correlationId?: string | null
}

interface RetentionPolicyRow {
  board_id: number
  schema_version: number
  transcript_days: number
  ephemeral_days: number
  raw_artifact_days: number
  updated_by_actor_type: string
  updated_by_actor_id: string | null
  created_at: string
  updated_at: string
}

interface RetentionRunRow {
  id: string
  board_id: number
  idempotency_key: string
  request_fingerprint: string
  as_of: string
  policy_json: string
  cutoffs_json: string
  transcript_events_archived: number
  ephemeral_events_archived: number
  raw_artifacts_compacted: number
  inline_raw_bytes_removed: number
  legacy_evidence_bundles_sanitized: number
  batch_limit: number
  has_more: number
  actor_type: string
  actor_id: string | null
  created_at: string
}

interface RawArtifactCandidate {
  id: string
}

interface RawArtifactCandidatePage {
  artifacts: RawArtifactCandidate[]
  hasMore: boolean
}

interface EvidenceBundleRepair {
  artifactId: string
  originalSha256: string
  originalBytes: number
  repairedSha256: string
  repairedBytes: number
  rawArtifactIds: string[]
}

interface EvidenceBundleRepairPage {
  repairs: EvidenceBundleRepair[]
  hasMore: boolean
}

/**
 * Applies Agent Home retention without deleting canonical events or rewriting their fingerprints.
 * Archived events stay replayable/exportable; only eligible inline raw artifact content is compacted.
 */
export class AgentHomeRetentionService {
  private readonly events: EventStore

  constructor(
    private readonly db: Database.Database,
    private readonly hooks: AgentHomeRetentionHooks = {},
  ) {
    this.events = new EventStore(db)
  }

  getPolicy(boardId: number): AgentHomeRetentionPolicy {
    this.requireBoard(boardId)
    const row = this.db.prepare('SELECT * FROM agent_home_retention_policies WHERE board_id=?')
      .get(boardId) as RetentionPolicyRow | undefined
    return row ? mapPolicy(row) : defaultPolicy()
  }

  configure(input: ConfigureAgentHomeRetentionInput): {
    policy: AgentHomeRetentionPolicy
    replayed: boolean
  } {
    this.requireBoard(input.boardId)
    const actor = actorIdentity(input.actor)
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const patch = policyPatch(input)
    if (!Object.keys(patch).length) {
      throw new ValidationError('at least one retention duration is required')
    }
    const requestFingerprint = canonicalHash({
      command: 'agent_home.retention_policy.configure',
      boardId: input.boardId,
      patch,
    })
    const configure = this.db.transaction(() => {
      const replay = commandReplay(this.db, {
        boardId: input.boardId,
        idempotencyKey,
        kind: 'agent_home.retention_policy_updated',
        requestFingerprint,
      })
      if (replay) {
        return {
          policy: policyFromPayload(replay.retention_policy),
          replayed: true,
        }
      }

      const current = this.getPolicy(input.boardId)
      const at = timestamp()
      const next = {
        transcript_days: patch.transcript_days ?? current.transcript_days,
        ephemeral_days: patch.ephemeral_days ?? current.ephemeral_days,
        raw_artifact_days: patch.raw_artifact_days ?? current.raw_artifact_days,
      }
      this.db.prepare(`INSERT INTO agent_home_retention_policies (
        board_id, schema_version, transcript_days, ephemeral_days, raw_artifact_days,
        updated_by_actor_type, updated_by_actor_id, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(board_id) DO UPDATE SET
        transcript_days=excluded.transcript_days,
        ephemeral_days=excluded.ephemeral_days,
        raw_artifact_days=excluded.raw_artifact_days,
        updated_by_actor_type=excluded.updated_by_actor_type,
        updated_by_actor_id=excluded.updated_by_actor_id,
        updated_at=excluded.updated_at`)
        .run(
          input.boardId,
          next.transcript_days,
          next.ephemeral_days,
          next.raw_artifact_days,
          actor.type,
          actor.id,
          at,
          at,
        )
      const policy = this.getPolicy(input.boardId)
      this.events.append({
        boardId: input.boardId,
        correlationId: input.correlationId ?? idempotencyKey,
        idempotencyKey,
        kind: 'agent_home.retention_policy_updated',
        source: 'agent-home',
        payload: {
          request_fingerprint: requestFingerprint,
          retention_policy: policy,
          actor,
        },
      })
      return { policy, replayed: false }
    })
    return configure.immediate()
  }

  run(input: RunAgentHomeRetentionInput): AgentHomeRetentionRun {
    this.requireBoard(input.boardId)
    const actor = actorIdentity(input.actor)
    const idempotencyKey = boundedString(input.idempotencyKey, 'idempotency key', 200)
    const requestedAsOf = input.asOf === undefined ? null : isoTimestamp(input.asOf, 'as_of')
    const requestFingerprint = canonicalHash({
      command: 'agent_home.retention.run',
      boardId: input.boardId,
      asOf: requestedAsOf,
    })
    const execute = this.db.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM agent_home_retention_runs
        WHERE board_id=? AND idempotency_key=?`)
        .get(input.boardId, idempotencyKey) as RetentionRunRow | undefined
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          throw new ConflictError(
            'idempotency key was already used for a different retention run',
          )
        }
        return mapRun(existing, true)
      }

      const policy = this.getPolicy(input.boardId)
      const asOf = requestedAsOf ?? timestamp()
      const cutoffs = retentionCutoffs(asOf, policy)
      const runId = randomUUID()
      const appliedAt = timestamp()
      this.db.prepare(`INSERT INTO agent_home_retention_runs (
        id, board_id, idempotency_key, request_fingerprint, as_of, policy_json,
        cutoffs_json, transcript_events_archived, ephemeral_events_archived,
        raw_artifacts_compacted, inline_raw_bytes_removed,
        legacy_evidence_bundles_sanitized, batch_limit, has_more,
        actor_type, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, 0, ?, ?, ?)`)
        .run(
          runId,
          input.boardId,
          idempotencyKey,
          requestFingerprint,
          asOf,
          stableJson(policy),
          stableJson(cutoffs),
          AGENT_HOME_RETENTION_BATCH_LIMIT,
          actor.type,
          actor.id,
          appliedAt,
        )

      const eventPage = this.db.prepare(`SELECT id, retention_class
        FROM conversation_events
        WHERE board_id=? AND archived_at IS NULL AND (
          (retention_class='transcript'
            AND julianday(created_at)<=julianday(?))
          OR (retention_class='ephemeral'
            AND julianday(created_at)<=julianday(?))
        )
        ORDER BY conversation_id, sequence
        LIMIT ?`)
        .all(
          input.boardId,
          cutoffs.transcript_before,
          cutoffs.ephemeral_before,
          AGENT_HOME_RETENTION_BATCH_LIMIT + 1,
        ) as Array<{ id: string; retention_class: 'transcript' | 'ephemeral' }>
      const hasMoreEvents = eventPage.length > AGENT_HOME_RETENTION_BATCH_LIMIT
      const eventCandidates = eventPage.slice(0, AGENT_HOME_RETENTION_BATCH_LIMIT)
      const archiveEvent = this.db.prepare(`UPDATE conversation_events
        SET archived_at=? WHERE id=? AND archived_at IS NULL
          AND retention_class IN ('transcript','ephemeral')`)
      let transcriptEventsArchived = 0
      let ephemeralEventsArchived = 0
      for (const event of eventCandidates) {
        const result = archiveEvent.run(appliedAt, event.id)
        if (result.changes !== 1) {
          throw new ConflictError('conversation event changed during retention')
        }
        if (event.retention_class === 'transcript') transcriptEventsArchived += 1
        else ephemeralEventsArchived += 1
      }

      const rawPage = this.rawArtifactCandidates(
        input.boardId,
        cutoffs.raw_artifact_before,
      )
      const legacyEvidenceBundlePage = this.sanitizeLegacyEvidenceBundles(
        input.boardId,
        this.rawArtifactReferences(input.boardId),
        runId,
        appliedAt,
      )
      const legacyEvidenceBundleRepairs = legacyEvidenceBundlePage.repairs
      const legacyEvidenceBundlesSanitized = legacyEvidenceBundleRepairs.length
      const archiveRaw = this.db.prepare(`INSERT INTO agent_home_raw_artifact_archives (
        artifact_id, board_id, retention_run_id, content_sha256, content_bytes, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
      const compactRaw = this.db.prepare(
        'UPDATE artifacts SET content=NULL WHERE id=? AND content IS NOT NULL',
      )
      const readRaw = this.db.prepare('SELECT content FROM artifacts WHERE id=?')
      let rawArtifactsCompacted = 0
      let rawBytesRemoved = 0
      const rawCompactionDeferred = legacyEvidenceBundlePage.hasMore
      for (const artifact of rawCompactionDeferred ? [] : rawPage.artifacts) {
        const row = readRaw.get(artifact.id) as { content: string | null } | undefined
        if (!row || row.content === null) {
          throw new ConflictError('raw artifact changed during retention')
        }
        const contentBytes = Buffer.byteLength(row.content, 'utf8')
        const contentHash = createHash('sha256').update(row.content).digest('hex')
        archiveRaw.run(
          artifact.id,
          input.boardId,
          runId,
          contentHash,
          contentBytes,
          appliedAt,
        )
        this.hooks.afterRawArchiveRecord?.({ artifactId: artifact.id, runId })
        if (compactRaw.run(artifact.id).changes !== 1) {
          throw new ConflictError('raw artifact changed during retention')
        }
        this.hooks.afterRawContentCompacted?.({ artifactId: artifact.id, runId })
        rawArtifactsCompacted += 1
        rawBytesRemoved += contentBytes
      }

      this.db.prepare(`UPDATE agent_home_retention_runs SET
        transcript_events_archived=?,
        ephemeral_events_archived=?,
        raw_artifacts_compacted=?,
        inline_raw_bytes_removed=?,
        legacy_evidence_bundles_sanitized=?,
        has_more=?
        WHERE id=?`)
        .run(
          transcriptEventsArchived,
          ephemeralEventsArchived,
          rawArtifactsCompacted,
          rawBytesRemoved,
          legacyEvidenceBundlesSanitized,
          hasMoreEvents || rawPage.hasMore || legacyEvidenceBundlePage.hasMore ? 1 : 0,
          runId,
        )
      this.events.append({
        boardId: input.boardId,
        correlationId: input.correlationId ?? idempotencyKey,
        idempotencyKey,
        kind: 'agent_home.retention_completed',
        source: 'agent-home',
        payload: {
          retention_run_id: runId,
          request_fingerprint: requestFingerprint,
          as_of: asOf,
          applied_at: appliedAt,
          policy,
          cutoffs,
          transcript_events_archived: transcriptEventsArchived,
          ephemeral_events_archived: ephemeralEventsArchived,
          raw_artifacts_compacted: rawArtifactsCompacted,
          inline_raw_bytes_removed: rawBytesRemoved,
          legacy_evidence_bundles_sanitized: legacyEvidenceBundlesSanitized,
          legacy_evidence_bundle_repairs: legacyEvidenceBundleRepairs.map((repair) => ({
            artifact_id: repair.artifactId,
            original_sha256: repair.originalSha256,
            repaired_sha256: repair.repairedSha256,
          })),
          raw_compaction_deferred_for_legacy_repairs: rawCompactionDeferred,
          batch_limit: AGENT_HOME_RETENTION_BATCH_LIMIT,
          has_more: hasMoreEvents || rawPage.hasMore || legacyEvidenceBundlePage.hasMore,
          actor,
        },
        createdAt: appliedAt,
      })
      return mapRun(this.requireRun(runId), false)
    })
    return execute.immediate()
  }

  private rawArtifactCandidates(
    boardId: number,
    rawArtifactBefore: string,
  ): RawArtifactCandidatePage {
    const candidates = this.db.prepare(`SELECT artifact.id
      FROM artifacts artifact
      WHERE artifact.board_id=@boardId
        AND artifact.kind IN ('provider_event','provider_raw_event')
        AND artifact.content IS NOT NULL
        AND julianday(artifact.created_at)<=julianday(@rawArtifactBefore)
        AND NOT (
          coalesce(json_type(
            CASE WHEN json_valid(artifact.metadata) THEN artifact.metadata ELSE '{}' END,
            '$.pinned'
          )='true', 0)
          OR lower(coalesce(CAST(json_extract(
            CASE WHEN json_valid(artifact.metadata) THEN artifact.metadata ELSE '{}' END,
            '$.pinned'
          ) AS TEXT), '')) IN ('1','true')
          OR coalesce(json_extract(
            CASE WHEN json_valid(artifact.metadata) THEN artifact.metadata ELSE '{}' END,
            '$.retention_class'
          )='pinned', 0)
        )
        AND NOT EXISTS (
          SELECT 1 FROM conversation_events event
          JOIN agent_sessions session ON session.id=event.session_id
          WHERE event.board_id=@boardId
            AND event.raw_artifact_id=artifact.id
            AND session.archived_at IS NULL
            AND session.control_state!='archived'
            AND (
              session.status IN ('reserved','starting','running','idle','stopping')
              OR session.control_state IN ('active','paused')
              OR session.recovery_state='attachable'
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM conversation_event_conflicts conflict
          JOIN agent_sessions session ON session.id=conflict.session_id
          WHERE conflict.board_id=@boardId
            AND conflict.raw_artifact_id=artifact.id
            AND session.archived_at IS NULL
            AND session.control_state!='archived'
            AND (
              session.status IN ('reserved','starting','running','idle','stopping')
              OR session.control_state IN ('active','paused')
              OR session.recovery_state='attachable'
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM checkpoints checkpoint
          JOIN workspaces workspace ON workspace.id=checkpoint.workspace_id
          WHERE workspace.board_id=@boardId
            AND checkpoint.patch_artifact_id=artifact.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM delivery_reports report
          WHERE report.board_id=@boardId
            AND report.status='accepted'
            AND EXISTS (
              SELECT 1 FROM json_each(report.artifact_ids) item
              WHERE (item.type='text' AND item.value=artifact.id)
                OR (
                  item.type='object'
                  AND json_extract(item.value, '$.artifact_id')=artifact.id
                )
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM delivery_deliverable_results result
          JOIN delivery_reports report ON report.id=result.report_id
          WHERE report.board_id=@boardId
            AND report.status='accepted'
            AND ${artifactEvidenceReferenceSql('result.evidence_refs')}
        )
        AND NOT EXISTS (
          SELECT 1 FROM delivery_criterion_results result
          JOIN delivery_reports report ON report.id=result.report_id
          WHERE report.board_id=@boardId
            AND report.status='accepted'
            AND ${artifactEvidenceReferenceSql('result.evidence_refs')}
        )
      ORDER BY artifact.id
      LIMIT @candidateLimit`)
      .all({
        boardId,
        rawArtifactBefore,
        candidateLimit: AGENT_HOME_RETENTION_BATCH_LIMIT + 1,
      }) as RawArtifactCandidate[]
    return {
      artifacts: candidates.slice(0, AGENT_HOME_RETENTION_BATCH_LIMIT),
      hasMore: candidates.length > AGENT_HOME_RETENTION_BATCH_LIMIT,
    }
  }

  private rawArtifactReferences(boardId: number): Set<string> {
    const rows = this.db.prepare(`SELECT id
      FROM artifacts
      WHERE board_id=? AND kind IN ('provider_event','provider_raw_event')
      UNION
      SELECT raw_artifact_id AS id
      FROM conversation_events
      WHERE board_id=? AND raw_artifact_id IS NOT NULL
      UNION
      SELECT raw_artifact_id AS id
      FROM conversation_event_conflicts
      WHERE board_id=? AND raw_artifact_id IS NOT NULL
      ORDER BY id`).all(boardId, boardId, boardId) as Array<{ id: string }>
    return new Set(rows.map((row) => String(row.id)))
  }

  private sanitizeLegacyEvidenceBundles(
    boardId: number,
    rawArtifactIds: Set<string>,
    runId: string,
    repairedAt: string,
  ): EvidenceBundleRepairPage {
    if (!rawArtifactIds.size) return { repairs: [], hasMore: false }
    const bundlePage = this.db.prepare(`WITH sensitive_ids(id) AS (
        SELECT id FROM artifacts
        WHERE board_id=@boardId AND kind IN ('provider_event','provider_raw_event')
        UNION
        SELECT raw_artifact_id FROM conversation_events
        WHERE board_id=@boardId AND raw_artifact_id IS NOT NULL
        UNION
        SELECT raw_artifact_id FROM conversation_event_conflicts
        WHERE board_id=@boardId AND raw_artifact_id IS NOT NULL
      ),
      sensitive(id, content) AS (
        SELECT sensitive_ids.id, artifact.content
        FROM sensitive_ids
        LEFT JOIN artifacts artifact ON artifact.id=sensitive_ids.id
      )
      SELECT bundle.id, bundle.content FROM artifacts bundle
      WHERE bundle.board_id=@boardId
        AND bundle.kind='evidence_bundle'
        AND bundle.content IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agent_home_evidence_bundle_repairs repair
          WHERE repair.bundle_artifact_id=bundle.id
        )
        AND (
          (
            json_valid(bundle.content)
            AND EXISTS (
              SELECT 1
              FROM json_tree(
                CASE WHEN json_valid(bundle.content) THEN bundle.content ELSE 'null' END
              ) node
              JOIN sensitive
                ON node.type='text'
                AND (
                  CAST(node.atom AS TEXT)=sensitive.id
                  OR CAST(node.atom AS TEXT)='artifact:' || sensitive.id
                )
            )
          )
          OR (
            NOT json_valid(bundle.content)
            AND EXISTS (
              SELECT 1 FROM sensitive
              WHERE instr(bundle.content, sensitive.id)>0
                OR (
                  sensitive.content IS NOT NULL
                  AND sensitive.content!=''
                  AND (
                    instr(bundle.content, sensitive.content)>0
                    OR instr(
                      bundle.content,
                      substr(
                        json_quote(sensitive.content),
                        2,
                        length(json_quote(sensitive.content))-2
                      )
                    )>0
                  )
                )
            )
          )
        )
      ORDER BY bundle.id
      LIMIT @candidateLimit`).all({
        boardId,
        candidateLimit: AGENT_HOME_RETENTION_BATCH_LIMIT + 1,
      }) as Array<{ id: string; content: string }>
    const bundles = bundlePage.slice(0, AGENT_HOME_RETENTION_BATCH_LIMIT)
    const update = this.db.prepare('UPDATE artifacts SET content=? WHERE id=? AND content=?')
    const rawContent = this.db.prepare('SELECT content FROM artifacts WHERE id=?')
    const insertRepair = this.db.prepare(`INSERT INTO agent_home_evidence_bundle_repairs (
      id, board_id, bundle_artifact_id, retention_run_id,
      original_sha256, original_bytes, repaired_sha256, repaired_bytes,
      raw_artifact_ids_json, repaired_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const repairs: EvidenceBundleRepair[] = []
    for (const bundle of bundles) {
      const repaired = repairLegacyEvidenceBundle(
        bundle.id,
        bundle.content,
        rawArtifactIds,
        (artifactId) => {
          const row = rawContent.get(artifactId) as { content: string | null } | undefined
          return row?.content ?? null
        },
        repairedAt,
      )
      if (!repaired) continue
      const repair: EvidenceBundleRepair = {
        artifactId: bundle.id,
        originalSha256: sha256(bundle.content),
        originalBytes: Buffer.byteLength(bundle.content, 'utf8'),
        repairedSha256: sha256(repaired.content),
        repairedBytes: Buffer.byteLength(repaired.content, 'utf8'),
        rawArtifactIds: repaired.rawArtifactIds,
      }
      insertRepair.run(
        randomUUID(),
        boardId,
        bundle.id,
        runId,
        repair.originalSha256,
        repair.originalBytes,
        repair.repairedSha256,
        repair.repairedBytes,
        stableJson(repair.rawArtifactIds),
        repairedAt,
      )
      if (update.run(repaired.content, bundle.id, bundle.content).changes !== 1) {
        throw new ConflictError('legacy evidence bundle changed during retention')
      }
      repairs.push(repair)
    }
    return {
      repairs,
      hasMore: bundlePage.length > AGENT_HOME_RETENTION_BATCH_LIMIT,
    }
  }

  private requireRun(id: string): RetentionRunRow {
    const row = this.db.prepare('SELECT * FROM agent_home_retention_runs WHERE id=?')
      .get(id) as RetentionRunRow | undefined
    if (!row) throw new ConflictError('retention run was not persisted')
    return row
  }

  private requireBoard(boardId: number): void {
    if (!Number.isSafeInteger(boardId) || boardId <= 0) {
      throw new ValidationError('board id must be a positive integer')
    }
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(boardId)) {
      throw new NotFoundError('board not found')
    }
  }
}

function policyPatch(input: ConfigureAgentHomeRetentionInput): {
  transcript_days?: number
  ephemeral_days?: number
  raw_artifact_days?: number
} {
  return {
    ...(input.transcriptDays === undefined
      ? {}
      : { transcript_days: retentionDays(input.transcriptDays, 'transcript days') }),
    ...(input.ephemeralDays === undefined
      ? {}
      : { ephemeral_days: retentionDays(input.ephemeralDays, 'ephemeral days') }),
    ...(input.rawArtifactDays === undefined
      ? {}
      : { raw_artifact_days: retentionDays(input.rawArtifactDays, 'raw artifact days') }),
  }
}

function retentionDays(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 36500) {
    throw new ValidationError(`${field} must be an integer between 1 and 36500`)
  }
  return parsed
}

function defaultPolicy(): AgentHomeRetentionPolicy {
  return {
    ...DEFAULT_AGENT_HOME_RETENTION_POLICY,
    source: 'default',
    updated_by_actor_type: null,
    updated_by_actor_id: null,
    created_at: null,
    updated_at: null,
  }
}

function mapPolicy(row: RetentionPolicyRow): AgentHomeRetentionPolicy {
  return {
    schema_version: 1,
    transcript_days: Number(row.transcript_days),
    ephemeral_days: Number(row.ephemeral_days),
    raw_artifact_days: Number(row.raw_artifact_days),
    audit_retention: 'forever',
    pinned_retention: 'forever',
    source: 'configured',
    updated_by_actor_type: String(row.updated_by_actor_type),
    updated_by_actor_id: row.updated_by_actor_id == null
      ? null
      : String(row.updated_by_actor_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

function policyFromPayload(value: unknown): AgentHomeRetentionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConflictError('retention policy replay payload is invalid')
  }
  const policy = value as Record<string, unknown>
  return {
    schema_version: 1,
    transcript_days: retentionDays(policy.transcript_days, 'transcript days'),
    ephemeral_days: retentionDays(policy.ephemeral_days, 'ephemeral days'),
    raw_artifact_days: retentionDays(policy.raw_artifact_days, 'raw artifact days'),
    audit_retention: 'forever',
    pinned_retention: 'forever',
    source: policy.source === 'configured' ? 'configured' : 'default',
    updated_by_actor_type: nullableString(policy.updated_by_actor_type),
    updated_by_actor_id: nullableString(policy.updated_by_actor_id),
    created_at: nullableString(policy.created_at),
    updated_at: nullableString(policy.updated_at),
  }
}

function mapRun(row: RetentionRunRow, replayed: boolean): AgentHomeRetentionRun {
  return {
    id: String(row.id),
    board_id: Number(row.board_id),
    idempotency_key: String(row.idempotency_key),
    request_fingerprint: String(row.request_fingerprint),
    as_of: String(row.as_of),
    policy: policyFromPayload(parseJson(row.policy_json, {})),
    cutoffs: cutoffsFromPayload(parseJson(row.cutoffs_json, {})),
    transcript_events_archived: Number(row.transcript_events_archived),
    ephemeral_events_archived: Number(row.ephemeral_events_archived),
    raw_artifacts_compacted: Number(row.raw_artifacts_compacted),
    inline_raw_bytes_removed: Number(row.inline_raw_bytes_removed),
    legacy_evidence_bundles_sanitized: Number(row.legacy_evidence_bundles_sanitized),
    batch_limit: Number(row.batch_limit),
    has_more: Number(row.has_more) === 1,
    actor_type: String(row.actor_type),
    actor_id: row.actor_id == null ? null : String(row.actor_id),
    created_at: String(row.created_at),
    replayed,
  }
}

function retentionCutoffs(
  asOf: string,
  policy: AgentHomeRetentionPolicy,
): AgentHomeRetentionCutoffs {
  return {
    transcript_before: daysBefore(asOf, policy.transcript_days),
    ephemeral_before: daysBefore(asOf, policy.ephemeral_days),
    raw_artifact_before: daysBefore(asOf, policy.raw_artifact_days),
  }
}

function daysBefore(asOf: string, days: number): string {
  return new Date(new Date(asOf).getTime() - days * 86_400_000).toISOString()
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${field} must be an ISO timestamp`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${field} must be an ISO timestamp`)
  }
  return parsed.toISOString()
}

function cutoffsFromPayload(value: unknown): AgentHomeRetentionCutoffs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConflictError('retention cutoff payload is invalid')
  }
  const cutoffs = value as Record<string, unknown>
  return {
    transcript_before: isoTimestamp(cutoffs.transcript_before, 'transcript cutoff'),
    ephemeral_before: isoTimestamp(cutoffs.ephemeral_before, 'ephemeral cutoff'),
    raw_artifact_before: isoTimestamp(cutoffs.raw_artifact_before, 'raw artifact cutoff'),
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

const RAW_ARTIFACT_REFERENCE_KEYS = ['id', 'artifact_id', 'raw_artifact_id'] as const

function repairLegacyEvidenceBundle(
  bundleId: string,
  content: string,
  rawArtifactIds: Set<string>,
  rawContent: (artifactId: string) => string | null,
  repairedAt: string,
): { content: string; rawArtifactIds: string[] } | null {
  const implicated = new Set<string>()
  try {
    const parsed = JSON.parse(content) as unknown
    collectRawArtifactReferences(parsed, rawArtifactIds, implicated)
  } catch {
    for (const artifactId of rawArtifactIds) {
      if (content.includes(artifactId)) implicated.add(artifactId)
      const raw = rawContent(artifactId)
      if (raw === null || raw === '') continue
      const escaped = JSON.stringify(raw).slice(1, -1)
      if (content.includes(raw) || content.includes(escaped)) {
        implicated.add(artifactId)
      }
    }
  }
  if (!implicated.size) return null

  const sortedIds = [...implicated].sort()
  const originalSha256 = sha256(content)
  const originalBytes = Buffer.byteLength(content, 'utf8')
  const repairCore = {
    format: 'agent-home-retention-repair',
    schema_version: 1,
    bundle_artifact_id: bundleId,
    repaired_at: repairedAt,
    reason: 'legacy evidence bundle referenced raw provider artifacts',
    raw_artifact_ids: sortedIds,
    original_sha256: originalSha256,
    original_bytes: originalBytes,
  }
  const replacementSha256 = sha256(stableJson(repairCore))
  return {
    content: stableJson({
      ...repairCore,
      replacement_sha256: replacementSha256,
      replacement_hash_scope: 'canonical repair payload excluding replacement hash fields',
    }),
    rawArtifactIds: sortedIds,
  }
}

function collectRawArtifactReferences(
  value: unknown,
  rawArtifactIds: Set<string>,
  implicated: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRawArtifactReferences(item, rawArtifactIds, implicated)
    return
  }
  if (typeof value === 'string') {
    if (rawArtifactIds.has(value)) implicated.add(value)
    if (value.startsWith('artifact:') && rawArtifactIds.has(value.slice('artifact:'.length))) {
      implicated.add(value.slice('artifact:'.length))
    }
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as Record<string, unknown>
  for (const key of RAW_ARTIFACT_REFERENCE_KEYS) {
    const reference = record[key]
    if (typeof reference === 'string' && rawArtifactIds.has(reference)) {
      implicated.add(reference)
    }
  }
  if (record.kind === 'artifact' && typeof record.ref === 'string'
    && rawArtifactIds.has(record.ref)) {
    implicated.add(record.ref)
  }
  for (const item of Object.values(record)) {
    collectRawArtifactReferences(item, rawArtifactIds, implicated)
  }
}

function artifactEvidenceReferenceSql(column: string): string {
  return `EXISTS (
    SELECT 1 FROM json_each(${column}) evidence
    WHERE (
      evidence.type='text'
      AND (
        evidence.value=artifact.id
        OR evidence.value='artifact:' || artifact.id
      )
    )
    OR (
      evidence.type='object'
      AND (
        json_extract(evidence.value, '$.artifact_id')=artifact.id
        OR (
          json_extract(evidence.value, '$.kind')='artifact'
          AND json_extract(evidence.value, '$.ref')=artifact.id
        )
        OR json_extract(evidence.value, '$.ref')='artifact:' || artifact.id
      )
    )
  )`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
