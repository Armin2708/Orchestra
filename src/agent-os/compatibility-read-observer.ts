import type { FastifyInstance, FastifyRequest } from 'fastify'
import type Database from 'better-sqlite3'
import {
  compatibilityProjectionMismatchDiagnostic,
} from './compatibility-forward-migration.js'
import {
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

const LEGACY_READS = Object.freeze(new Map<string, readonly CompatibilityTelemetrySubject[]>([
  ['/api/v1/boards', [subject('boards')]],
  ['/api/v1/boards/:id/snapshot', [
    subject('boards'), subject('cards'), subject('agents'), subject('task_contracts'),
    subject('milestones'), subject('ideas'),
  ]],
  ['/api/v1/boards/:id/telemetry', [subject('agent_usage'), subject('token_telemetry')]],
  ['/api/v1/boards/:id/timeline', [
    subject('card_events'), subject('review_decisions'), subject('messages'),
  ]],
  ['/api/v1/cards/:id/reviews', [subject('review_decisions')]],
  ['/api/v1/boards/:id/reviews', [subject('review_decisions')]],
  ['/api/v1/agents/:id/inbox', [
    subject('messages'), subject('message_targets'), subject('deliveries'),
  ]],
]))

const MISMATCH_TABLES = new Set<AgentOsLegacyCompatibilityTable>([
  'boards', 'task_contracts', 'agent_usage', 'agents', 'cards', 'card_events',
  'review_decisions',
])

/** Register production read telemetry after every successful compatibility-facing GET. */
export function registerCompatibilityReadObserver(
  server: FastifyInstance,
  db: Database.Database,
): void {
  server.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET' || reply.statusCode >= 400) return payload
    const read = compatibilityRead(request)
    if (!read) return payload
    for (const telemetrySubject of read.subjects) {
      const observations: CompatibilityMigrationSuccessObservation[] = [{
        operation: read.kind,
      }]
      if (MISMATCH_TABLES.has(telemetrySubject.table)) {
        const diagnostic = compatibilityProjectionMismatchDiagnostic(
          db,
          telemetrySubject.table,
        )
        if (diagnostic) observations.push({
          operation: 'mismatch',
          diagnostic_code: diagnostic,
        })
      }
      runBoundCompatibilityMigrationOperation(db, {
        subject: telemetrySubject,
        success_observations: observations,
        failure_diagnostic: 'unexpected_failure',
      }, () => undefined)
    }
    return payload
  })
}

function compatibilityRead(request: FastifyRequest): CompatibilityRead | null {
  const route = request.routeOptions.url
  if (!route) return null
  const legacy = LEGACY_READS.get(route)
  if (legacy) return { kind: 'legacy_read', subjects: legacy }
  if (!route.startsWith('/api/v1/os/')) return null

  const tables = new Set<AgentOsLegacyCompatibilityTable>()
  if (route.startsWith('/api/v1/os/boards/')) tables.add('boards')
  if (route.includes('/agent-profiles')) tables.add('agents')
  if (route === '/api/v1/os/open-work' || route.includes('/open-work')) {
    tables.add('cards')
    tables.add('task_contracts')
    tables.add('agents')
  }
  if (route.includes('/contract')) {
    tables.add('cards')
    tables.add('task_contracts')
  }
  if (route.includes('/deliveries')) {
    tables.add('cards')
    tables.add('review_decisions')
  }
  if (route.includes('/events')) tables.add('card_events')
  if (route.includes('/sessions/') && route.includes('/events')) {
    tables.add('agent_usage')
  }
  return tables.size
    ? { kind: 'canonical_read', subjects: [...tables].map(subject) }
    : null
}
