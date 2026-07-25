import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { AgentHomeTranscriptExporter } from '../src/agent-os/agent-home-export.js'
import {
  AgentHomeRetentionService,
  DEFAULT_AGENT_HOME_RETENTION_POLICY,
} from '../src/agent-os/agent-home-retention.js'
import { AgentHomeSearchService } from '../src/agent-os/agent-home-search.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { ArtifactStore } from '../src/agent-os/artifact-store.js'
import { ConversationService } from '../src/agent-os/conversations.js'
import { openDb } from '../src/db.js'

const actor = { type: 'operator' as const, id: 'retention-test' }
const AS_OF = '2026-07-25T00:00:00.000Z'
const OLD = '2026-01-01T00:00:00.000Z'
const RECENT = '2026-07-24T00:00:00.000Z'

describe('Agent Home retention and compaction', () => {
  it('configures a bounded policy idempotently while keeping audit and pinned forever', () => {
    const db = openDb(':memory:')
    const fixture = seedRetentionHome(db)
    const retention = new AgentHomeRetentionService(db)

    expect(retention.getPolicy(fixture.boardId)).toMatchObject({
      ...DEFAULT_AGENT_HOME_RETENTION_POLICY,
      source: 'default',
      updated_at: null,
    })
    const configured = retention.configure({
      boardId: fixture.boardId,
      transcriptDays: 120,
      ephemeralDays: 14,
      rawArtifactDays: 45,
      actor,
      idempotencyKey: 'retention:configure',
    })
    const replay = retention.configure({
      boardId: fixture.boardId,
      transcriptDays: 120,
      ephemeralDays: 14,
      rawArtifactDays: 45,
      actor,
      idempotencyKey: 'retention:configure',
    })

    expect(configured).toMatchObject({
      replayed: false,
      policy: {
        transcript_days: 120,
        ephemeral_days: 14,
        raw_artifact_days: 45,
        audit_retention: 'forever',
        pinned_retention: 'forever',
        source: 'configured',
      },
    })
    expect(replay).toEqual({ policy: configured.policy, replayed: true })
    expect(() => retention.configure({
      boardId: fixture.boardId,
      transcriptDays: 121,
      actor,
      idempotencyKey: 'retention:configure',
    })).toThrow(/idempotency key/)
    expect(() => retention.configure({
      boardId: fixture.boardId,
      transcriptDays: 0,
      actor,
      idempotencyKey: 'retention:invalid',
    })).toThrow(/between 1 and 36500/)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE kind='agent_home.retention_policy_updated'`).get() as { count: number }).count)
      .toBe(1)
    db.close()
  })

  it('soft-archives eligible events and compacts only unprotected inline raw payloads', () => {
    const db = openDb(':memory:')
    const fixture = seedRetentionHome(db)
    const conversations = new ConversationService(db)
    const search = new AgentHomeSearchService(db)
    const exporter = new AgentHomeTranscriptExporter(db)
    const retention = new AgentHomeRetentionService(db)
    const seeded = seedRetentionEvents(db, fixture)
    const legacyBundles = seedLegacyEvidenceBundles(db, fixture, seeded.rawSecret)
    stopRetentionSession(db, fixture.sessionId)
    const canonicalBefore = canonicalEventRows(db, seeded.allEventIds)
    const conflictBefore = db.prepare(`SELECT id, canonical_event_id, dedupe_key,
      received_content_hash, received_projected_text, received_metadata_json,
      raw_artifact_id, actor_type, actor_id, created_at
      FROM conversation_event_conflicts ORDER BY id`).all()

    const result = retention.run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: 'retention:run:one',
      asOf: AS_OF,
    })

    expect(result).toMatchObject({
      board_id: fixture.boardId,
      as_of: AS_OF,
      transcript_events_archived: 2,
      ephemeral_events_archived: 1,
      raw_artifacts_compacted: 1,
      legacy_evidence_bundles_sanitized: 2,
      batch_limit: 500,
      has_more: false,
      replayed: false,
      policy: {
        transcript_days: 90,
        ephemeral_days: 7,
        raw_artifact_days: 30,
        audit_retention: 'forever',
        pinned_retention: 'forever',
      },
    })
    expect(result.inline_raw_bytes_removed).toBe(Buffer.byteLength(seeded.rawSecret, 'utf8'))
    expect(result.created_at).not.toBe(AS_OF)

    const canonicalAfter = canonicalEventRows(db, seeded.allEventIds)
    expect(canonicalAfter.map(({ archived_at: _archivedAt, ...row }) => row))
      .toEqual(canonicalBefore.map(({ archived_at: _archivedAt, ...row }) => row))
    expect(canonicalAfter.find((event) => event.id === seeded.oldTranscriptId)?.archived_at)
      .toBe(result.created_at)
    expect(canonicalAfter.find((event) => event.id === seeded.sharedTranscriptId)?.archived_at)
      .toBe(result.created_at)
    expect(canonicalAfter.find((event) => event.id === seeded.oldEphemeralId)?.archived_at)
      .toBe(result.created_at)
    for (const id of [seeded.auditId, seeded.pinnedId, seeded.recentTranscriptId]) {
      expect(canonicalAfter.find((event) => event.id === id)?.archived_at).toBeNull()
    }
    expect(db.prepare('SELECT content, path FROM artifacts WHERE id=?')
      .get(fixture.rawArtifactId)).toEqual({
        content: null,
        path: '/provider/archive/raw-event.json',
      })
    expect(db.prepare('SELECT content, path FROM artifacts WHERE id=?')
      .get(fixture.protectedArtifactId)).toEqual({
        content: seeded.protectedSecret,
        path: '/provider/archive/protected-event.json',
      })
    expect(db.prepare(`SELECT content_sha256, content_bytes, archived_at
      FROM agent_home_raw_artifact_archives WHERE artifact_id=?`)
      .get(fixture.rawArtifactId)).toEqual({
        content_sha256: createHash('sha256').update(seeded.rawSecret).digest('hex'),
        content_bytes: Buffer.byteLength(seeded.rawSecret, 'utf8'),
        archived_at: result.created_at,
      })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM agent_home_raw_artifact_archives
      WHERE artifact_id=?`).get(fixture.protectedArtifactId)).toEqual({ count: 0 })
    const repairedBundle = db.prepare('SELECT content FROM artifacts WHERE id=?')
      .get(legacyBundles.compromisedId) as { content: string }
    expect(repairedBundle.content).not.toContain(seeded.rawSecret)
    expect(repairedBundle.content).not.toContain('RAW_PATH_SENTINEL')
    expect(repairedBundle.content).not.toContain('RAW_METADATA_SENTINEL')
    expect(JSON.parse(repairedBundle.content)).toMatchObject({
      format: 'agent-home-retention-repair',
      bundle_artifact_id: legacyBundles.compromisedId,
      repaired_at: result.created_at,
      raw_artifact_ids: [fixture.rawArtifactId],
      original_sha256: createHash('sha256').update(legacyBundles.compromisedContent).digest('hex'),
      original_bytes: Buffer.byteLength(legacyBundles.compromisedContent, 'utf8'),
    })
    expect(db.prepare('SELECT content FROM artifacts WHERE id=?')
      .get(legacyBundles.unrelatedId)).toEqual({ content: legacyBundles.unrelatedContent })
    const repairedMalformed = db.prepare('SELECT content FROM artifacts WHERE id=?')
      .get(legacyBundles.malformedId) as { content: string }
    expect(repairedMalformed.content).not.toContain(seeded.rawSecret)
    expect(JSON.parse(repairedMalformed.content)).toMatchObject({
      format: 'agent-home-retention-repair',
      bundle_artifact_id: legacyBundles.malformedId,
      raw_artifact_ids: [fixture.rawArtifactId],
    })
    expect(db.prepare(`SELECT original_sha256, original_bytes, repaired_sha256,
      repaired_bytes, raw_artifact_ids_json, repaired_at, retention_run_id
      FROM agent_home_evidence_bundle_repairs WHERE bundle_artifact_id=?`)
      .get(legacyBundles.compromisedId)).toEqual({
        original_sha256: createHash('sha256').update(legacyBundles.compromisedContent).digest('hex'),
        original_bytes: Buffer.byteLength(legacyBundles.compromisedContent, 'utf8'),
        repaired_sha256: createHash('sha256').update(repairedBundle.content).digest('hex'),
        repaired_bytes: Buffer.byteLength(repairedBundle.content, 'utf8'),
        raw_artifact_ids_json: JSON.stringify([fixture.rawArtifactId]),
        repaired_at: result.created_at,
        retention_run_id: result.id,
      })
    expect(db.prepare(`SELECT id, canonical_event_id, dedupe_key,
      received_content_hash, received_projected_text, received_metadata_json,
      raw_artifact_id, actor_type, actor_id, created_at
      FROM conversation_event_conflicts ORDER BY id`).all()).toEqual(conflictBefore)

    expect(search.search(fixture.conversationId).events.map((event) => event.id))
      .toEqual([seeded.auditId, seeded.pinnedId, seeded.recentTranscriptId])
    expect(search.search(fixture.conversationId, { includeArchived: true }).events
      .map((event) => event.id)).toEqual(seeded.allEventIds)
    const exported = exporter.document(fixture.conversationId, fixture.sessionId)
    expect(exported.provenance.event_ids).toEqual(seeded.allEventIds)
    expect(exported.provenance.source_content_hashes)
      .toEqual(canonicalBefore.map((event) => event.content_hash))
    expect(exported.events.find((event) => event.id === seeded.oldTranscriptId))
      .toMatchObject({
        raw_artifact_id: fixture.rawArtifactId,
        provider_event_id: 'provider-old-transcript',
        provider_cursor: 'cursor-old-transcript',
        projected_text: 'old transcript remains projected',
        archived_at: result.created_at,
      })

    const replayedProviderEvent = conversations.appendEvent(fixture.sessionId, {
      idempotencyKey: 'retention:event:old-transcript:replayed',
      dedupeKey: 'retention:provider:old-transcript',
      kind: 'assistant',
      provider: 'codex',
      providerEventId: 'provider-old-transcript',
      providerThreadId: 'thread-retention',
      providerCursor: 'cursor-old-transcript',
      projectedText: 'old transcript remains projected',
      metadata: { status: 'complete' },
      rawArtifactId: fixture.rawArtifactId,
      retentionClass: 'transcript',
      actor: { type: 'agent', id: 'codex-retention' },
    })
    expect(replayedProviderEvent).toMatchObject({
      replayed: true,
      event: {
        id: seeded.oldTranscriptId,
        content_hash: canonicalBefore[0].content_hash,
        archived_at: result.created_at,
      },
    })
    expect(() => conversations.appendEvent(fixture.sessionId, {
      idempotencyKey: 'retention:event:old-transcript:conflict-after',
      dedupeKey: 'retention:provider:old-transcript',
      kind: 'assistant',
      provider: 'codex',
      providerEventId: 'provider-old-transcript',
      providerThreadId: 'thread-retention',
      providerCursor: 'cursor-old-transcript',
      projectedText: 'different retained payload',
      metadata: { status: 'complete' },
      rawArtifactId: fixture.rawArtifactId,
      retentionClass: 'transcript',
      actor: { type: 'agent', id: 'codex-retention' },
    })).toThrow(/conflicts with an existing dedupe key/)
    expect((db.prepare(`SELECT COUNT(*) AS count FROM conversation_event_conflicts
      WHERE canonical_event_id=?`).get(seeded.oldTranscriptId) as { count: number }).count)
      .toBe(2)

    const serializedRetentionState = JSON.stringify({
      run: db.prepare('SELECT * FROM agent_home_retention_runs').all(),
      archives: db.prepare('SELECT * FROM agent_home_raw_artifact_archives').all(),
      repairs: db.prepare('SELECT * FROM agent_home_evidence_bundle_repairs').all(),
      audit: db.prepare(`SELECT payload FROM os_events
        WHERE kind='agent_home.retention_completed'`).all(),
    })
    expect(serializedRetentionState).not.toContain(seeded.rawSecret)
    expect(serializedRetentionState).not.toContain(seeded.protectedSecret)
    expect(db.prepare(`SELECT created_at FROM os_events
      WHERE kind='agent_home.retention_completed'`).get()).toEqual({
      created_at: result.created_at,
    })
    db.close()
  })

  it('replays across restart and never repairs a tombstone twice', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-home-retention-'))
    const file = join(directory, 'orchestra.db')
    try {
      const db = openDb(file)
      const fixture = seedRetentionHome(db)
      const seeded = seedRetentionEvents(db, fixture)
      const bundles = seedLegacyEvidenceBundles(db, fixture, seeded.rawSecret)
      stopRetentionSession(db, fixture.sessionId)
      const first = new AgentHomeRetentionService(db).run({
        boardId: fixture.boardId,
        actor,
        idempotencyKey: 'retention:run:idempotent',
        asOf: AS_OF,
      })
      const archiveState = JSON.stringify({
        archives: db.prepare(
          'SELECT * FROM agent_home_raw_artifact_archives ORDER BY artifact_id',
        ).all(),
        repairs: db.prepare(
          'SELECT * FROM agent_home_evidence_bundle_repairs ORDER BY bundle_artifact_id',
        ).all(),
        bundle: db.prepare('SELECT content FROM artifacts WHERE id=?')
          .get(bundles.compromisedId),
      })
      db.close()

      const reopened = openDb(file)
      const retention = new AgentHomeRetentionService(reopened)
      const replay = retention.run({
        boardId: fixture.boardId,
        actor,
        idempotencyKey: 'retention:run:idempotent',
        asOf: AS_OF,
      })
      const second = retention.run({
        boardId: fixture.boardId,
        actor,
        idempotencyKey: 'retention:run:later',
        asOf: AS_OF,
      })
      expect(replay).toEqual({ ...first, replayed: true })
      expect(second).toMatchObject({
        transcript_events_archived: 0,
        ephemeral_events_archived: 0,
        raw_artifacts_compacted: 0,
        inline_raw_bytes_removed: 0,
        legacy_evidence_bundles_sanitized: 0,
        replayed: false,
      })
      expect(JSON.stringify({
        archives: reopened.prepare(
          'SELECT * FROM agent_home_raw_artifact_archives ORDER BY artifact_id',
        ).all(),
        repairs: reopened.prepare(
          'SELECT * FROM agent_home_evidence_bundle_repairs ORDER BY bundle_artifact_id',
        ).all(),
        bundle: reopened.prepare('SELECT content FROM artifacts WHERE id=?')
          .get(bundles.compromisedId),
      })).toBe(archiveState)
      expect(archiveState).not.toContain(seeded.rawSecret)
      expect(() => retention.run({
        boardId: fixture.boardId,
        actor,
        idempotencyKey: 'retention:run:idempotent',
        asOf: '2026-07-26T12:00:00.000Z',
      })).toThrow(/different retention run/)
      expect((reopened.prepare(`SELECT COUNT(*) AS count FROM os_events
        WHERE kind='agent_home.retention_completed'`).get() as { count: number }).count).toBe(2)
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('protects active and attachable sessions, then expires audit raw bytes after detach', () => {
    const db = openDb(':memory:')
    const fixture = seedRetentionHome(db)
    const conversations = new ConversationService(db)
    const audit = conversations.appendEvent(fixture.sessionId, {
      idempotencyKey: 'retention:audit:event',
      dedupeKey: 'retention:audit:event',
      kind: 'approval',
      provider: 'codex',
      providerEventId: 'retention-audit-event',
      projectedText: 'durable audit projection',
      rawArtifactId: fixture.rawArtifactId,
      retentionClass: 'audit',
      actor: { type: 'agent', id: 'codex-retention' },
    }).event
    db.prepare('UPDATE conversation_events SET created_at=? WHERE id=?').run(OLD, audit.id)
    const retention = new AgentHomeRetentionService(db)

    expect(retention.run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: 'retention:active',
      asOf: AS_OF,
    }).raw_artifacts_compacted).toBe(0)
    expect(db.prepare('SELECT content FROM artifacts WHERE id=?').get(fixture.rawArtifactId))
      .toEqual({ content: 'RAW_PROVIDER_SECRET_MUST_BE_COMPACTED' })

    db.prepare(`UPDATE agent_sessions
      SET status='stopped', control_state='stopped', recovery_state='attachable'
      WHERE id=?`).run(fixture.sessionId)
    expect(retention.run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: 'retention:attachable',
      asOf: AS_OF,
    }).raw_artifacts_compacted).toBe(0)

    db.prepare("UPDATE agent_sessions SET recovery_state='detached' WHERE id=?")
      .run(fixture.sessionId)
    const artifacts = new ArtifactStore(db)
    const orphan = artifacts.create({
      boardId: fixture.boardId,
      workspaceId: fixture.workspaceId,
      cardId: fixture.cardId,
      kind: 'provider_event',
      name: 'orphan-provider.json',
      content: 'ORPHAN_PROVIDER_RAW',
    })
    const arbitrary = artifacts.create({
      boardId: fixture.boardId,
      workspaceId: fixture.workspaceId,
      cardId: fixture.cardId,
      kind: 'diff',
      name: 'not-owned.diff',
      content: 'ARBITRARY_KIND_MUST_REMAIN',
    })
    db.prepare('UPDATE artifacts SET created_at=? WHERE id IN (?, ?)')
      .run(OLD, orphan.id, arbitrary.id)
    const arbitraryEvent = conversations.appendEvent(fixture.sessionId, {
      idempotencyKey: 'retention:arbitrary:event',
      dedupeKey: 'retention:arbitrary:event',
      kind: 'assistant',
      provider: 'codex',
      projectedText: 'diff evidence remains',
      rawArtifactId: arbitrary.id,
      retentionClass: 'transcript',
      actor: { type: 'agent', id: 'codex-retention' },
    }).event
    db.prepare('UPDATE conversation_events SET created_at=? WHERE id=?')
      .run(OLD, arbitraryEvent.id)

    const detached = retention.run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: 'retention:detached',
      asOf: AS_OF,
    })
    expect(detached.raw_artifacts_compacted).toBe(2)
    expect(db.prepare('SELECT content FROM artifacts WHERE id=?').get(fixture.rawArtifactId))
      .toEqual({ content: null })
    expect(db.prepare('SELECT content FROM artifacts WHERE id=?').get(orphan.id))
      .toEqual({ content: null })
    expect(db.prepare('SELECT content FROM artifacts WHERE id=?').get(arbitrary.id))
      .toEqual({ content: 'ARBITRARY_KIND_MUST_REMAIN' })
    expect(db.prepare('SELECT archived_at FROM conversation_events WHERE id=?').get(audit.id))
      .toEqual({ archived_at: null })
    db.close()
  })

  it('preserves pinned, accepted-delivery, evidence, and checkpoint artifacts', () => {
    const db = openDb(':memory:')
    const fixture = seedRetentionHome(db)
    stopRetentionSession(db, fixture.sessionId)
    const artifacts = new ArtifactStore(db)
    const create = (name: string) => artifacts.create({
      boardId: fixture.boardId,
      workspaceId: fixture.workspaceId,
      cardId: fixture.cardId,
      kind: 'provider_raw_event',
      name,
      content: `protected:${name}`,
    })
    const acceptedArtifact = create('accepted-artifact')
    const deliverableEvidence = create('deliverable-evidence')
    const criterionEvidence = create('criterion-evidence')
    const checkpointArtifact = create('checkpoint-patch')
    const draftEvidence = create('draft-evidence')
    db.prepare(`UPDATE artifacts SET created_at=? WHERE id IN (?, ?, ?, ?, ?)`).run(
      OLD,
      acceptedArtifact.id,
      deliverableEvidence.id,
      criterionEvidence.id,
      checkpointArtifact.id,
      draftEvidence.id,
    )
    insertDeliveryReport(db, fixture, {
      id: 'accepted-retention-report',
      status: 'accepted',
      artifactIds: [acceptedArtifact.id],
    })
    db.prepare(`INSERT INTO delivery_deliverable_results
      (report_id, deliverable_id, outcome, evidence_refs, actor, created_at, updated_at)
      VALUES (?, 'deliverable', 'met', ?, 'reviewer', ?, ?)`).run(
      'accepted-retention-report',
      JSON.stringify([{ kind: 'artifact', ref: deliverableEvidence.id }]),
      OLD,
      OLD,
    )
    db.prepare(`INSERT INTO delivery_criterion_results
      (report_id, criterion_id, outcome, evidence_refs, actor, created_at, updated_at)
      VALUES (?, 'criterion', 'met', ?, 'reviewer', ?, ?)`).run(
      'accepted-retention-report',
      JSON.stringify([`artifact:${criterionEvidence.id}`]),
      OLD,
      OLD,
    )
    insertDeliveryReport(db, fixture, {
      id: 'draft-retention-report',
      status: 'draft',
      artifactIds: [],
    })
    db.prepare(`INSERT INTO delivery_deliverable_results
      (report_id, deliverable_id, outcome, evidence_refs, actor, created_at, updated_at)
      VALUES (?, 'draft', 'partial', ?, 'agent', ?, ?)`).run(
      'draft-retention-report',
      JSON.stringify([{ artifact_id: draftEvidence.id }]),
      OLD,
      OLD,
    )
    db.prepare(`INSERT INTO checkpoints
      (id, workspace_id, session_id, name, git_head, patch_artifact_id)
      VALUES ('retention-checkpoint', ?, ?, 'safe patch', 'abc123', ?)`).run(
      fixture.workspaceId,
      fixture.sessionId,
      checkpointArtifact.id,
    )

    new AgentHomeRetentionService(db).run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: 'retention:durable-references',
      asOf: AS_OF,
    })
    for (const artifact of [
      acceptedArtifact,
      deliverableEvidence,
      criterionEvidence,
      checkpointArtifact,
    ]) {
      expect(db.prepare('SELECT content FROM artifacts WHERE id=?').get(artifact.id))
        .toEqual({ content: `protected:${artifact.name}` })
    }
    expect(db.prepare('SELECT content FROM artifacts WHERE id=?').get(draftEvidence.id))
      .toEqual({ content: null })
    expect(db.prepare('SELECT content FROM artifacts WHERE id=?')
      .get(fixture.protectedArtifactId)).toEqual({
      content: 'AUDIT_PINNED_RAW_MUST_REMAIN',
    })
    db.close()
  })

  it.each([
    'afterRawArchiveRecord',
    'afterRawContentCompacted',
  ] as const)('rolls back the entire sweep when %s fails', (failurePoint) => {
    const db = openDb(':memory:')
    const fixture = seedRetentionHome(db)
    const seeded = seedRetentionEvents(db, fixture)
    const bundles = seedLegacyEvidenceBundles(db, fixture, seeded.rawSecret)
    stopRetentionSession(db, fixture.sessionId)
    const fail = () => {
      throw new Error(`injected ${failurePoint}`)
    }
    const hooks = failurePoint === 'afterRawArchiveRecord'
      ? { afterRawArchiveRecord: fail }
      : { afterRawContentCompacted: fail }
    expect(() => new AgentHomeRetentionService(db, hooks).run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: `retention:rollback:${failurePoint}`,
      asOf: AS_OF,
    })).toThrow(`injected ${failurePoint}`)
    expect(db.prepare('SELECT content FROM artifacts WHERE id=?').get(fixture.rawArtifactId))
      .toEqual({ content: seeded.rawSecret })
    expect(db.prepare('SELECT content FROM artifacts WHERE id=?')
      .get(bundles.compromisedId)).toEqual({ content: bundles.compromisedContent })
    expect(db.prepare('SELECT archived_at FROM conversation_events WHERE id=?')
      .get(seeded.oldTranscriptId)).toEqual({ archived_at: null })
    for (const table of [
      'agent_home_retention_runs',
      'agent_home_raw_artifact_archives',
      'agent_home_evidence_bundle_repairs',
    ]) {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)
        .toBe(0)
    }
    expect((db.prepare(`SELECT COUNT(*) AS count FROM os_events
      WHERE kind='agent_home.retention_completed'`).get() as { count: number }).count).toBe(0)

    expect(new AgentHomeRetentionService(db).run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: `retention:rollback:${failurePoint}`,
      asOf: AS_OF,
    })).toMatchObject({
      raw_artifacts_compacted: 1,
      legacy_evidence_bundles_sanitized: 2,
    })
    db.close()
  })

  it('bounds each sweep and reports when eligible events remain', () => {
    const db = openDb(':memory:')
    const fixture = seedRetentionHome(db)
    const insert = db.prepare(`INSERT INTO conversation_events (
      id, board_id, profile_id, conversation_id, session_id, sequence, kind,
      actor_type, dedupe_key, content_hash, retention_class, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'status', 'agent', ?, ?, 'ephemeral', ?)`)
    for (let index = 1; index <= 501; index += 1) {
      insert.run(
        `bounded-event-${index}`,
        fixture.boardId,
        fixture.profileId,
        fixture.conversationId,
        fixture.sessionId,
        index,
        `bounded-event-${index}`,
        createHash('sha256').update(`bounded-event-${index}`).digest('hex'),
        OLD,
      )
    }
    stopRetentionSession(db, fixture.sessionId)
    const retention = new AgentHomeRetentionService(db)
    expect(retention.run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: 'retention:bounded:first',
      asOf: AS_OF,
    })).toMatchObject({
      ephemeral_events_archived: 500,
      batch_limit: 500,
      has_more: true,
    })
    expect(retention.run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: 'retention:bounded:second',
      asOf: AS_OF,
    })).toMatchObject({
      ephemeral_events_archived: 1,
      batch_limit: 500,
      has_more: false,
    })
    db.close()
  })

  it('keeps raw detection material until the final malformed repair page completes', () => {
    const db = openDb(':memory:')
    const fixture = seedRetentionHome(db)
    stopRetentionSession(db, fixture.sessionId)
    const insert = db.prepare(`INSERT INTO artifacts (
      id, board_id, workspace_id, card_id, kind, name, mime_type, content, metadata, created_at
    ) VALUES (?, ?, ?, ?, 'evidence_bundle', ?, 'application/json', ?, '{}', ?)`)
    for (let index = 1; index <= 501; index += 1) {
      const id = `legacy-bundle-${String(index).padStart(4, '0')}`
      insert.run(
        id,
        fixture.boardId,
        fixture.workspaceId,
        fixture.cardId,
        `${id}.json`,
        'legacy malformed evidence=RAW_PROVIDER_SECRET_MUST_BE_COMPACTED',
        OLD,
      )
    }
    const retention = new AgentHomeRetentionService(db)
    expect(retention.run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: 'retention:legacy-page:first',
      asOf: AS_OF,
    })).toMatchObject({
      legacy_evidence_bundles_sanitized: 500,
      raw_artifacts_compacted: 0,
      inline_raw_bytes_removed: 0,
      batch_limit: 500,
      has_more: true,
    })
    expect(db.prepare('SELECT content FROM artifacts WHERE id=?').get(fixture.rawArtifactId))
      .toEqual({ content: 'RAW_PROVIDER_SECRET_MUST_BE_COMPACTED' })
    expect(retention.run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: 'retention:legacy-page:second',
      asOf: AS_OF,
    })).toMatchObject({
      legacy_evidence_bundles_sanitized: 1,
      raw_artifacts_compacted: 1,
      batch_limit: 500,
      has_more: false,
    })
    expect(db.prepare('SELECT content FROM artifacts WHERE id=?').get(fixture.rawArtifactId))
      .toEqual({ content: null })
    expect(retention.run({
      boardId: fixture.boardId,
      actor,
      idempotencyKey: 'retention:legacy-page:third',
      asOf: AS_OF,
    })).toMatchObject({
      legacy_evidence_bundles_sanitized: 0,
      raw_artifacts_compacted: 0,
      inline_raw_bytes_removed: 0,
      has_more: false,
    })
    expect((db.prepare(`SELECT COUNT(*) AS count
      FROM agent_home_evidence_bundle_repairs`).get() as { count: number }).count).toBe(501)
    for (const id of ['legacy-bundle-0001', 'legacy-bundle-0501']) {
      const row = db.prepare('SELECT content FROM artifacts WHERE id=?').get(id) as {
        content: string
      }
      expect(row.content).not.toContain('RAW_PROVIDER_SECRET_MUST_BE_COMPACTED')
      expect(JSON.parse(row.content)).toMatchObject({
        format: 'agent-home-retention-repair',
        bundle_artifact_id: id,
      })
    }
    db.close()
  })
})

function seedRetentionHome(db: Database.Database): {
  boardId: number
  cardId: number
  workspaceId: string
  sessionId: string
  profileId: string
  conversationId: string
  rawArtifactId: string
  protectedArtifactId: string
} {
  const boardId = Number(db.prepare(
    "INSERT INTO boards (project_path, name) VALUES ('/agent-home-retention', 'retention')",
  ).run().lastInsertRowid)
  const cardId = Number(db.prepare(
    "INSERT INTO cards (board_id, title, description) VALUES (?, 'Retention', '')",
  ).run(boardId).lastInsertRowid)
  const workspaceId = 'retention-workspace'
  db.prepare(`INSERT INTO workspaces
    (id, board_id, card_id, name, kind, root_path, status)
    VALUES (?, ?, ?, 'retention', 'shared', '/agent-home-retention', 'active')`)
    .run(workspaceId, boardId, cardId)
  const sessionId = 'retention-session'
  db.prepare(`INSERT INTO agent_sessions
    (id, workspace_id, provider, external_id, status, context_json)
    VALUES (?, ?, 'codex', 'thread-retention', 'running', '{}')`)
    .run(sessionId, workspaceId)
  const profile = new AgentProfileService(db).create({
    boardId,
    name: 'Retention agent',
    defaultProvider: 'codex',
    actor,
    idempotencyKey: 'retention:profile',
  })
  const conversations = new ConversationService(db)
  const conversation = conversations.listConversations(profile.id)[0]
  conversations.linkSession(sessionId, {
    profileId: profile.id,
    conversationId: conversation.id,
    mode: 'managed',
    driverId: 'codex',
    providerThreadId: 'thread-retention',
    recoveryState: 'attachable',
    historyState: 'complete',
    accessProfile: 'workspace_write',
    actor,
    idempotencyKey: 'retention:session:link',
  })
  const artifacts = new ArtifactStore(db)
  const rawArtifact = artifacts.create({
    boardId,
    workspaceId,
    cardId,
    kind: 'provider_raw_event',
    name: 'raw-event.json',
    mimeType: 'application/json',
    path: '/provider/archive/raw-event.json',
    content: 'RAW_PROVIDER_SECRET_MUST_BE_COMPACTED',
  })
  const protectedArtifact = artifacts.create({
    boardId,
    workspaceId,
    cardId,
    kind: 'provider_raw_event',
    name: 'protected-event.json',
    mimeType: 'application/json',
    path: '/provider/archive/protected-event.json',
    content: 'AUDIT_PINNED_RAW_MUST_REMAIN',
    metadata: { pinned: true },
  })
  db.prepare('UPDATE artifacts SET created_at=? WHERE id IN (?, ?)')
    .run(OLD, rawArtifact.id, protectedArtifact.id)
  return {
    boardId,
    cardId,
    workspaceId,
    sessionId,
    profileId: profile.id,
    conversationId: conversation.id,
    rawArtifactId: rawArtifact.id,
    protectedArtifactId: protectedArtifact.id,
  }
}

function seedRetentionEvents(
  db: Database.Database,
  fixture: ReturnType<typeof seedRetentionHome>,
): {
  rawSecret: string
  protectedSecret: string
  oldTranscriptId: string
  sharedTranscriptId: string
  oldEphemeralId: string
  auditId: string
  pinnedId: string
  recentTranscriptId: string
  allEventIds: string[]
} {
  const conversations = new ConversationService(db)
  const append = (
    name: string,
    retentionClass: 'transcript' | 'audit' | 'ephemeral' | 'pinned',
    projectedText: string,
    rawArtifactId: string | null = null,
  ) => conversations.appendEvent(fixture.sessionId, {
    idempotencyKey: `retention:event:${name}`,
    dedupeKey: `retention:provider:${name}`,
    kind: retentionClass === 'audit' ? 'approval' : 'assistant',
    provider: 'codex',
    providerEventId: `provider-${name}`,
    providerThreadId: 'thread-retention',
    providerCursor: `cursor-${name}`,
    projectedText,
    metadata: { status: 'complete' },
    rawArtifactId,
    retentionClass,
    actor: { type: 'agent', id: 'codex-retention' },
  }).event
  const oldTranscript = append(
    'old-transcript',
    'transcript',
    'old transcript remains projected',
    fixture.rawArtifactId,
  )
  expect(() => conversations.appendEvent(fixture.sessionId, {
    idempotencyKey: 'retention:event:old-transcript:conflict-before',
    dedupeKey: 'retention:provider:old-transcript',
    kind: 'assistant',
    provider: 'codex',
    providerEventId: 'provider-old-transcript',
    providerThreadId: 'thread-retention',
    providerCursor: 'cursor-old-transcript',
    projectedText: 'conflicting provider replay',
    metadata: { status: 'complete' },
    rawArtifactId: fixture.rawArtifactId,
    retentionClass: 'transcript',
    actor: { type: 'agent', id: 'codex-retention' },
  })).toThrow(/conflicts with an existing dedupe key/)
  const sharedTranscript = append(
    'shared-transcript',
    'transcript',
    'shared raw transcript',
    fixture.protectedArtifactId,
  )
  const oldEphemeral = append('old-ephemeral', 'ephemeral', 'ephemeral projection')
  const audit = append(
    'audit',
    'audit',
    'approval audit projection',
    fixture.protectedArtifactId,
  )
  const pinned = append('pinned', 'pinned', 'pinned projection')
  const recentTranscript = append('recent-transcript', 'transcript', 'recent projection')
  for (const event of [oldTranscript, oldEphemeral, audit, pinned]) {
    db.prepare('UPDATE conversation_events SET created_at=? WHERE id=?').run(OLD, event.id)
  }
  db.prepare('UPDATE conversation_events SET created_at=? WHERE id=?')
    .run('2026-01-01 00:00:00', sharedTranscript.id)
  db.prepare('UPDATE conversation_events SET created_at=? WHERE id=?')
    .run(RECENT, recentTranscript.id)
  return {
    rawSecret: 'RAW_PROVIDER_SECRET_MUST_BE_COMPACTED',
    protectedSecret: 'AUDIT_PINNED_RAW_MUST_REMAIN',
    oldTranscriptId: oldTranscript.id,
    sharedTranscriptId: sharedTranscript.id,
    oldEphemeralId: oldEphemeral.id,
    auditId: audit.id,
    pinnedId: pinned.id,
    recentTranscriptId: recentTranscript.id,
    allEventIds: [
      oldTranscript.id,
      sharedTranscript.id,
      oldEphemeral.id,
      audit.id,
      pinned.id,
      recentTranscript.id,
    ],
  }
}

function seedLegacyEvidenceBundles(
  db: Database.Database,
  fixture: ReturnType<typeof seedRetentionHome>,
  rawSecret: string,
): {
  compromisedId: string
  compromisedContent: string
  malformedId: string
  malformedContent: string
  unrelatedId: string
  unrelatedContent: string
} {
  const artifacts = new ArtifactStore(db)
  const compromisedContent = `${JSON.stringify({
    format: 'legacy-evidence-bundle',
    changed_files: [`RAW_PATH_SENTINEL/${rawSecret}`],
    diff: `diff:${rawSecret}`,
    verification: { output: `verified:${rawSecret}` },
    artifacts: [{
      id: fixture.rawArtifactId,
      artifact_id: fixture.rawArtifactId,
      raw_artifact_id: fixture.rawArtifactId,
      path: `RAW_PATH_SENTINEL/${rawSecret}`,
      metadata: { copied: `RAW_METADATA_SENTINEL/${rawSecret}` },
      content: rawSecret,
    }],
  }, null, 2)}\n`
  const unrelatedContent = '{\n  "safe": true,\n  "note": "byte-for-byte unchanged"\n}\n'
  const malformedContent = `legacy malformed evidence=${rawSecret}`
  const compromised = artifacts.create({
    boardId: fixture.boardId,
    workspaceId: fixture.workspaceId,
    cardId: fixture.cardId,
    kind: 'evidence_bundle',
    name: 'legacy-compromised.json',
    mimeType: 'application/json',
    content: compromisedContent,
  })
  const unrelated = artifacts.create({
    boardId: fixture.boardId,
    workspaceId: fixture.workspaceId,
    cardId: fixture.cardId,
    kind: 'evidence_bundle',
    name: 'legacy-unrelated.json',
    mimeType: 'application/json',
    content: unrelatedContent,
  })
  const malformed = artifacts.create({
    boardId: fixture.boardId,
    workspaceId: fixture.workspaceId,
    cardId: fixture.cardId,
    kind: 'evidence_bundle',
    name: 'legacy-malformed.txt',
    mimeType: 'text/plain',
    content: malformedContent,
  })
  return {
    compromisedId: compromised.id,
    compromisedContent,
    malformedId: malformed.id,
    malformedContent,
    unrelatedId: unrelated.id,
    unrelatedContent,
  }
}

function stopRetentionSession(db: Database.Database, sessionId: string): void {
  db.prepare(`UPDATE agent_sessions
    SET status='stopped', control_state='stopped', recovery_state='detached',
      ended_at='2026-07-24T23:00:00.000Z'
    WHERE id=?`).run(sessionId)
}

function insertDeliveryReport(
  db: Database.Database,
  fixture: ReturnType<typeof seedRetentionHome>,
  input: { id: string; status: 'draft' | 'accepted'; artifactIds: string[] },
): void {
  db.prepare(`INSERT INTO delivery_reports (
    id, lineage_id, sequence, board_id, card_id, session_id, workspace_id,
    status, asked_snapshot, artifact_ids, created_by, created_at, updated_at
  ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, '{}', ?, 'retention-test', ?, ?)`).run(
    input.id,
    input.id,
    fixture.boardId,
    fixture.cardId,
    fixture.sessionId,
    fixture.workspaceId,
    input.status,
    JSON.stringify(input.artifactIds),
    OLD,
    OLD,
  )
}

function canonicalEventRows(db: Database.Database, ids: string[]): Array<{
  id: string
  sequence: number
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
  redaction_state: string
  retention_class: string
  schema_version: number
  created_at: string
  archived_at: string | null
}> {
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(`SELECT
    id, sequence, provider, provider_event_id, provider_thread_id, provider_turn_id,
    provider_item_id, provider_cursor, kind, actor_type, actor_id, correlation_id,
    causation_id, projected_text, metadata_json, raw_artifact_id, dedupe_key,
    content_hash, redaction_state, retention_class, schema_version, created_at, archived_at
    FROM conversation_events WHERE id IN (${placeholders}) ORDER BY sequence`)
    .all(...ids) as ReturnType<typeof canonicalEventRows>
}
