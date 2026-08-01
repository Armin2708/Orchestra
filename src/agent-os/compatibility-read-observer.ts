import type { FastifyInstance, FastifyRequest } from 'fastify'
import type Database from 'better-sqlite3'
import {
  AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
  compatibilityProjectionMismatchDiagnostic,
} from './compatibility-forward-migration.js'
import {
  resolveCompatibilityMigrationTelemetryCohort,
  runBoundCompatibilityMigrationOperation,
  type CompatibilityMigrationSuccessObservation,
  type CompatibilityTelemetrySubject,
} from './compatibility-migration-instrumentation.js'
import type {
  AgentOsLegacyCompatibilityTable,
} from './compatibility-projection-contract.js'

type ReadKind = 'legacy_read' | 'canonical_read'

interface CompatibilityRead {
  readonly kind: ReadKind
  readonly subjects: readonly CompatibilityTelemetrySubject[]
}

const subject = (
  table: AgentOsLegacyCompatibilityTable,
): CompatibilityTelemetrySubject => ({ table } as CompatibilityTelemetrySubject)

/** Register production telemetry against the rows each successful compatibility GET reads. */
export function registerCompatibilityReadObserver(
  server: FastifyInstance,
  db: Database.Database,
): void {
  server.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET' || reply.statusCode >= 400) return payload
    const reads = compatibilityReads(db, request, payload)
    if (!reads.length) return payload

    const groups = new Map<string, {
      kind: ReadKind
      subject: CompatibilityTelemetrySubject
      diagnostics: Set<'missing_legacy_row' | 'missing_canonical_row' | 'projection_stale'>
    }>()
    for (const read of reads) {
      for (const telemetrySubject of deduplicateSubjects(read.subjects)) {
        const cohort = resolveCompatibilityMigrationTelemetryCohort(db, telemetrySubject)
        const key = `${read.kind}:${telemetrySubject.table}:${cohort}`
        const group = groups.get(key) ?? {
          kind: read.kind,
          subject: telemetrySubject,
          diagnostics: new Set(),
        }
        const sourceKey = compatibilitySourceKey(telemetrySubject)
        if (sourceKey !== null) {
          const diagnostic = compatibilityProjectionMismatchDiagnostic(
            db,
            telemetrySubject.table,
            sourceKey,
          )
          if (diagnostic) group.diagnostics.add(diagnostic)
        }
        groups.set(key, group)
      }
    }

    for (const group of groups.values()) {
      const observations: CompatibilityMigrationSuccessObservation[] = [{
        operation: group.kind,
      }]
      for (const diagnostic of group.diagnostics) observations.push({
        operation: 'mismatch',
        diagnostic_code: diagnostic,
      })
      runBoundCompatibilityMigrationOperation(db, {
        subject: group.subject,
        success_observations: observations,
        failure_diagnostic: 'unexpected_failure',
      }, () => undefined)
    }
    return payload
  })
}

function compatibilityReads(
  db: Database.Database,
  request: FastifyRequest,
  payload: unknown,
): CompatibilityRead[] {
  const route = request.routeOptions.url
  if (!route) return []
  const id = routeId(request)
  const legacy = legacySubjects(db, route, id)
  if (legacy) return [{ kind: 'legacy_read', subjects: legacy }]
  const canonical = canonicalSubjects(db, route, id, request.params, payload)
  if (!canonical) return []
  const reads: CompatibilityRead[] = [{ kind: 'canonical_read', subjects: canonical }]
  const taskContracts = canonical.filter((value) => value.table === 'task_contracts')
  if (taskContracts.length) reads.push({ kind: 'legacy_read', subjects: taskContracts })
  return reads
}

function legacySubjects(
  db: Database.Database,
  route: string,
  id: number | null,
): CompatibilityTelemetrySubject[] | null {
  if (route === '/api/v1/boards') return [subject('boards')]
  if (route === '/api/v1/system') return [
    ...agents(db), ...usage(db), subject('token_telemetry'),
  ]
  if (id === null) return null
  if (route === '/api/v1/boards/:id/snapshot') return [
    subject('boards'), ...cards(db, id), ...agents(db, id),
    ...reviewVerificationEvents(db, id),
    subject('messages'), subject('message_targets'), subject('deliveries'),
    subject('milestones'), subject('ideas'),
  ]
  if (route === '/api/v1/boards/:id/telemetry') return [
    ...usage(db, id), subject('token_telemetry'),
  ]
  if (route === '/api/v1/boards/:id/timeline') return [
    ...cards(db, id), ...agents(db, id), ...events(db, id), ...reviews(db, id),
    subject('messages'), subject('milestones'),
  ]
  if (route === '/api/v1/boards/:id/shipped') return [
    subject('boards'), ...cards(db, id), ...agents(db, id), ...events(db, id),
    ...reviews(db, id),
  ]
  if (route === '/api/v1/boards/:id/reviews') return [
    ...cards(db, id), ...reviews(db, id),
  ]
  if (route === '/api/v1/cards/:id/reviews') return reviewsForCard(db, id)
  if (route === '/api/v1/cards/:id/events') return [
    ...eventsForCard(db, id), ...agentsForCardEvents(db, id),
  ]
  if (route === '/api/v1/agents/:id/inbox') return [
    agent(db, id), subject('messages'), subject('message_targets'),
  ]
  return null
}

function canonicalSubjects(
  db: Database.Database,
  route: string,
  id: number | null,
  rawParams: unknown,
  payload: unknown,
): CompatibilityTelemetrySubject[] | null {
  if (route === '/api/v1/os/open-work') return openWorkSubjects(db, payload)
  if (route === '/api/v1/os/boards/:id/events' && id !== null) return [
    subject('boards'), ...linkedCardEventsForBoard(db, id),
  ]
  if (route === '/api/v1/os/boards/:id/agent-profiles' && id !== null) {
    return agents(db, id)
  }
  if (route.startsWith('/api/v1/os/agent-profiles/:id')) {
    const profileId = stringParam(rawParams, 'id')
    return [profileAgent(db, profileId)]
  }
  const cardId = numericParam(rawParams, 'cardId') ?? id
  if ((route.includes('/contract') || route.includes('/open-work')) && cardId !== null) {
    return [
      { table: 'cards', card_id: cardId },
      { table: 'task_contracts', card_id: cardId },
    ]
  }
  if (route === '/api/v1/os/cards/:id/deliveries' && id !== null) return [
    { table: 'cards', card_id: id },
    ...linkedReviewsForCard(db, id),
  ]
  if (route.startsWith('/api/v1/os/deliveries/:id')) {
    return linkedReviewForDelivery(db, stringParam(rawParams, 'id'))
  }
  if (route === '/api/v1/os/sessions/:id/events') {
    return usageForSession(db, stringParam(rawParams, 'id'))
  }
  return null
}

function cards(db: Database.Database, boardId?: number): CompatibilityTelemetrySubject[] {
  const rows = boardId === undefined
    ? db.prepare('SELECT id FROM cards ORDER BY id').all()
    : db.prepare('SELECT id FROM cards WHERE board_id=? ORDER BY id').all(boardId)
  return identities('cards', rows, (row) => ({ card_id: Number(row.id) }))
}

function contracts(db: Database.Database): CompatibilityTelemetrySubject[] {
  const rows = db.prepare('SELECT card_id FROM task_contracts ORDER BY card_id').all()
  return identities('task_contracts', rows, (row) => ({ card_id: Number(row.card_id) }))
}

function agents(db: Database.Database, boardId?: number): CompatibilityTelemetrySubject[] {
  const rows = boardId === undefined
    ? db.prepare('SELECT id FROM agents ORDER BY id').all()
    : db.prepare('SELECT id FROM agents WHERE board_id=? ORDER BY id').all(boardId)
  return identities('agents', rows, (row) => ({ agent_id: Number(row.id) }))
}

function agent(db: Database.Database, agentId: number): CompatibilityTelemetrySubject {
  return db.prepare('SELECT 1 FROM agents WHERE id=?').get(agentId)
    ? { table: 'agents', agent_id: agentId }
    : subject('agents')
}

function events(db: Database.Database, boardId: number): CompatibilityTelemetrySubject[] {
  const rows = db.prepare(`SELECT event.id FROM card_events event
    JOIN cards card ON card.id=event.card_id WHERE card.board_id=? ORDER BY event.id`).all(boardId)
  return identities('card_events', rows, (row) => ({ source_id: Number(row.id) }))
}

function eventsForCard(db: Database.Database, cardId: number): CompatibilityTelemetrySubject[] {
  const rows = db.prepare('SELECT id FROM card_events WHERE card_id=? ORDER BY id').all(cardId)
  return identities('card_events', rows, (row) => ({ source_id: Number(row.id) }))
}

function reviewVerificationEvents(
  db: Database.Database,
  boardId: number,
): CompatibilityTelemetrySubject[] {
  const rows = db.prepare(`SELECT event.id FROM card_events event
    JOIN cards card ON card.id=event.card_id
    WHERE card.board_id=? AND card.column_name='review'
      AND event.type IN ('verification', 'verify_requested')
    ORDER BY event.id`).all(boardId)
  return rows.map((row) => ({
    table: 'card_events',
    source_id: Number((row as { id: number }).id),
  }))
}

function agentsForCardEvents(db: Database.Database, cardId: number): CompatibilityTelemetrySubject[] {
  const rows = db.prepare(`SELECT DISTINCT agent_id AS id FROM card_events
    WHERE card_id=? AND agent_id IS NOT NULL ORDER BY agent_id`).all(cardId)
  return identities('agents', rows, (row) => ({ agent_id: Number(row.id) }))
}

function reviews(db: Database.Database, boardId: number): CompatibilityTelemetrySubject[] {
  const rows = db.prepare('SELECT id FROM review_decisions WHERE board_id=? ORDER BY id').all(boardId)
  return identities('review_decisions', rows, (row) => ({ decision_id: Number(row.id) }))
}

function reviewsForCard(db: Database.Database, cardId: number): CompatibilityTelemetrySubject[] {
  const rows = db.prepare('SELECT id FROM review_decisions WHERE card_id=? ORDER BY id').all(cardId)
  return identities('review_decisions', rows, (row) => ({ decision_id: Number(row.id) }))
}

function usage(db: Database.Database, boardId?: number): CompatibilityTelemetrySubject[] {
  const rows = boardId === undefined
    ? db.prepare('SELECT board_id, agent_id, day FROM agent_usage ORDER BY board_id, agent_id, day').all()
    : db.prepare(`SELECT board_id, agent_id, day FROM agent_usage
      WHERE board_id=? ORDER BY agent_id, day`).all(boardId)
  return identities('agent_usage', rows, (row) => ({
    board_id: Number(row.board_id),
    agent_id: Number(row.agent_id),
    day: String(row.day),
  }))
}

function profileAgent(db: Database.Database, profileId: string | null): CompatibilityTelemetrySubject {
  if (!profileId) return subject('agents')
  const row = db.prepare('SELECT legacy_agent_id FROM agent_profiles WHERE id=?').get(profileId) as
    { legacy_agent_id: number | null } | undefined
  return row?.legacy_agent_id
    ? { table: 'agents', agent_id: row.legacy_agent_id }
    : subject('agents')
}

function openWorkSubjects(
  db: Database.Database,
  payload: unknown,
): CompatibilityTelemetrySubject[] {
  const body = jsonPayload(payload)
  const items = body && Array.isArray(body.items) ? body.items : []
  const cardIds = [...new Set(items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const value = Number((item as Record<string, unknown>).card_id)
    return Number.isSafeInteger(value) && value > 0 ? [value] : []
  }))]
  if (!cardIds.length) return [subject('cards')]
  const output: CompatibilityTelemetrySubject[] = cardIds.flatMap((cardId) => [
    { table: 'cards', card_id: cardId },
    { table: 'task_contracts', card_id: cardId },
  ] as CompatibilityTelemetrySubject[])
  const placeholders = cardIds.map(() => '?').join(',')
  const profiles = db.prepare(`SELECT DISTINCT profile.legacy_agent_id AS id
    FROM agent_profiles profile JOIN cards card ON card.board_id=profile.board_id
    WHERE card.id IN (${placeholders}) AND profile.legacy_agent_id IS NOT NULL
    ORDER BY profile.legacy_agent_id`).all(...cardIds)
  output.push(...identities('agents', profiles, (row) => ({ agent_id: Number(row.id) })))
  return output
}

function jsonPayload(payload: unknown): Record<string, unknown> | null {
  const text = typeof payload === 'string'
    ? payload
    : Buffer.isBuffer(payload)
      ? payload.toString('utf8')
      : null
  if (!text) return null
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function linkedCardEventsForBoard(
  db: Database.Database,
  boardId: number,
): CompatibilityTelemetrySubject[] {
  const rows = db.prepare(`SELECT link.source_key AS id
    FROM os_compatibility_projection_links link
    JOIN os_events event ON event.id=link.target_key
    WHERE link.migration_id=? AND link.source_table='card_events'
      AND link.target_table='os_events' AND event.board_id=?
    ORDER BY CAST(link.source_key AS INTEGER)`).all(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    boardId,
  )
  return identities('card_events', rows, (row) => ({ source_id: Number(row.id) }))
}

function linkedReviewsForCard(
  db: Database.Database,
  cardId: number,
): CompatibilityTelemetrySubject[] {
  const rows = db.prepare(`SELECT link.source_key AS id
    FROM os_compatibility_projection_links link
    JOIN delivery_reports report ON report.id=link.target_key
    WHERE link.migration_id=? AND link.source_table='review_decisions'
      AND link.target_table='delivery_reports' AND report.card_id=?
    ORDER BY CAST(link.source_key AS INTEGER)`).all(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    cardId,
  )
  return identities('review_decisions', rows, (row) => ({ decision_id: Number(row.id) }))
}

function linkedReviewForDelivery(
  db: Database.Database,
  deliveryId: string | null,
): CompatibilityTelemetrySubject[] {
  if (!deliveryId) return [subject('review_decisions')]
  const row = db.prepare(`SELECT source_key AS id
    FROM os_compatibility_projection_links
    WHERE migration_id=? AND source_table='review_decisions'
      AND target_table='delivery_reports' AND target_key=?`).get(
    AGENT_OS_COMPATIBILITY_FORWARD_MIGRATION_ID,
    deliveryId,
  ) as { id: string } | undefined
  return row
    ? [{ table: 'review_decisions', decision_id: Number(row.id) }]
    : [subject('review_decisions')]
}

function usageForSession(
  db: Database.Database,
  sessionId: string | null,
): CompatibilityTelemetrySubject[] {
  if (!sessionId) return [subject('agent_usage')]
  const rows = db.prepare(`SELECT usage.board_id, usage.agent_id, usage.day
    FROM agent_sessions session
    JOIN agent_usage usage ON usage.agent_id=session.agent_id
    JOIN workspaces workspace ON workspace.id=session.workspace_id
      AND workspace.board_id=usage.board_id
    WHERE session.id=? ORDER BY usage.day`).all(sessionId)
  return identities('agent_usage', rows, (row) => ({
    board_id: Number(row.board_id), agent_id: Number(row.agent_id), day: String(row.day),
  }))
}

function identities(
  table: AgentOsLegacyCompatibilityTable,
  rows: readonly unknown[],
  fields: (row: Record<string, unknown>) => Record<string, unknown>,
): CompatibilityTelemetrySubject[] {
  return rows.length
    ? rows.map((row) => ({
        table,
        ...fields(row as Record<string, unknown>),
      } as CompatibilityTelemetrySubject))
    : [subject(table)]
}

function compatibilitySourceKey(subjectValue: CompatibilityTelemetrySubject): string | null {
  switch (subjectValue.table) {
    case 'task_contracts': return integerKey(subjectValue.card_id)
    case 'agent_usage': {
      const board = integerKey(subjectValue.board_id)
      const agentId = integerKey(subjectValue.agent_id)
      return board && agentId && subjectValue.day ? `${board}:${agentId}:${subjectValue.day}` : null
    }
    case 'agents': return integerKey(subjectValue.agent_id)
    case 'cards': return integerKey(subjectValue.card_id)
    case 'card_events': return integerKey(subjectValue.source_id)
    case 'review_decisions': return integerKey(subjectValue.decision_id)
    default: return null
  }
}

function integerKey(value: unknown): string | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? String(value) : null
}

function deduplicateSubjects(
  subjects: readonly CompatibilityTelemetrySubject[],
): CompatibilityTelemetrySubject[] {
  return [...new Map(subjects.map((value) => [
    `${value.table}:${compatibilitySourceKey(value) ?? 'aggregate'}`,
    value,
  ])).values()]
}

function routeId(request: FastifyRequest): number | null {
  return numericParam(request.params, 'id')
}

function numericParam(value: unknown, key: string): number | null {
  const raw = stringParam(value, key)
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function stringParam(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' && raw.length ? raw : null
}
