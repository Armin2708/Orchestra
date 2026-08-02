import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { VERSION } from '../version.js'
import { readRemoteState } from '../remote.js'
import { OperationsDiagnosticsBundle } from './diagnostics.js'
import { OperationsHealthService, type OperationsHealthProbe } from './health.js'
import { OperationsAlertEngine, OperationsMetrics } from './metrics.js'
import { StructuredOperationsLogger } from './structured-logger.js'
import type { OperationsRuntime } from './runtime.js'
import {
  createSupportCaseExport,
  type SupportCaseExportRequestV1,
} from '../support-case-export.js'

const scalar = (db: Database.Database, sql: string): number => {
  try { return Number((db.prepare(sql).get() as { value: number }).value) || 0 } catch { return 0 }
}
const optionalScalar = (db: Database.Database, sql: string): number | undefined => {
  try {
    const value = (db.prepare(sql).get() as { value: unknown }).value
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  } catch { return undefined }
}

const staleRemoteAuthorizedIntentCount = (db: Database.Database): number => scalar(db, `
  SELECT count(*) AS value FROM os_remote_mutation_audit authorized
  WHERE authorized.outcome='authorized'
    AND authorized.occurred_at<=datetime('now','-30 seconds')
    AND NOT EXISTS (
      SELECT 1 FROM os_remote_mutation_audit terminal
      WHERE terminal.request_id=authorized.request_id
        AND terminal.device_session_id=authorized.device_session_id
        AND terminal.operation=authorized.operation
        AND terminal.request_digest IS authorized.request_digest
        AND terminal.outcome IN ('succeeded','failed')
    )`)

function healthService(db: Database.Database): OperationsHealthService {
  const probes: OperationsHealthProbe[] = [
    {
      component: 'database', required: true,
      check: () => ({
        status: (db.pragma('quick_check', { simple: true }) === 'ok' ? 'ready' : 'unavailable'),
        reasonCode: 'sqlite_quick_check',
      }),
    },
    {
      component: 'daemon_lease', required: false,
      check: () => ({
        status: scalar(db, "SELECT count(*) AS value FROM daemon_leases WHERE name='orchestra-daemon'") === 1
          ? 'ready' : 'unavailable',
        reasonCode: 'single_writer_lease',
      }),
    },
    { component: 'drivers', required: false, check: () => ({ status: 'degraded', reasonCode: 'runtime_owned' }) },
    { component: 'providers', required: false, check: () => ({ status: 'degraded', reasonCode: 'runtime_owned' }) },
    { component: 'pty_supervisor', required: false, check: () => ({ status: 'degraded', reasonCode: 'runtime_owned' }) },
    { component: 'hooks', required: false, check: () => ({ status: 'ready', reasonCode: 'route_boundary_ready' }) },
    {
      component: 'tunnels', required: false,
      check: () => ({ status: readRemoteState() ? 'ready' : 'disabled', reasonCode: 'private_default' }),
    },
    { component: 'credentials', required: false, check: () => ({ status: 'degraded', reasonCode: 'runtime_owned' }) },
    {
      component: 'observability', required: false,
      check: () => {
        const stalled = staleRemoteAuthorizedIntentCount(db)
        return stalled > 0
          ? {
              status: 'degraded' as const,
              reasonCode: 'stale_remote_authorized_intent',
              details: { stale_remote_authorized_intents: stalled },
            }
          : { status: 'ready' as const, reasonCode: 'embedded_registry_ready' }
      },
    },
  ]
  return new OperationsHealthService(probes)
}

function requireLocalOwner(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): boolean {
  if (request.orchestraPrincipal === 'operator') return true
  reply.code(403).send({ error: 'local owner authorization is required' })
  return false
}

/** Registers local-owner-only operational detail; public health remains deliberately minimal. */
export interface OperationsIntegration {
  publicReadiness(): Promise<Readonly<{ live: true; ready: boolean }>>
}

export function registerOperationsIntegration(
  server: FastifyInstance,
  db: Database.Database,
  runtime?: OperationsRuntime,
): OperationsIntegration {
  const health = healthService(db)
  const logger = runtime?.logger ?? new StructuredOperationsLogger()
  const alerts = runtime?.alerts ?? new OperationsAlertEngine()
  const metrics = runtime?.metrics ?? new OperationsMetrics()
  metrics.increment('recovery_results_total', scalar(db, 'SELECT count(*) AS value FROM ops_recovery_runs'))

  const checkHealth = () => runtime?.checkHealth() ?? health.check()
  let cached: Readonly<{ live: true; ready: boolean }> = Object.freeze({ live: true, ready: false })
  let checkedAt = 0
  let inFlight: Promise<Readonly<{ live: true; ready: boolean }>> | undefined
  const refresh = (): Promise<Readonly<{ live: true; ready: boolean }>> => {
    if (inFlight) return inFlight
    const operation = checkHealth().then((snapshot) => {
      cached = health.publicStatus(snapshot)
      checkedAt = Date.now()
      return cached
    }, () => {
      cached = Object.freeze({ live: true as const, ready: false })
      checkedAt = Date.now()
      return cached
    })
    inFlight = operation
    void operation.finally(() => { if (inFlight === operation) inFlight = undefined })
    return operation
  }
  const refreshTimer = runtime ? undefined : setInterval(() => { void refresh() }, 5_000)
  refreshTimer?.unref()
  server.addHook('onClose', async () => {
    if (refreshTimer) clearInterval(refreshTimer)
    runtime?.close()
  })
  if (!runtime) void refresh()

  server.get('/api/v1/ops/health', async (request, reply) => {
    if (!requireLocalOwner(request, reply)) return
    return checkHealth()
  })

  server.get('/api/v1/ops/metrics', (request, reply) => {
    if (!requireLocalOwner(request, reply)) return
    metrics.set('queue_depth', scalar(db, "SELECT count(*) AS value FROM jobs WHERE status='queued'"))
    metrics.set('active_sessions', scalar(db, "SELECT count(*) AS value FROM agent_sessions WHERE status IN ('starting','running','idle')"))
    const launch = db.prepare(`SELECT avg(
      max(0, (julianday(started_at)-julianday(created_at))*86400000)
    ) AS value FROM jobs WHERE started_at IS NOT NULL AND created_at IS NOT NULL`).get() as
      { value: number | null }
    if (launch.value !== null && Number.isFinite(launch.value)) {
      metrics.set('launch_latency_ms', launch.value)
    }
    const projectionLag = optionalScalar(db, `SELECT coalesce(max(
      max(0, (julianday('now')-julianday(created_at))*86400000)
    ), 0) AS value FROM os_compatibility_projection_quarantine`)
    if (projectionLag !== undefined) metrics.set('projection_lag_ms', projectionLag)
    metrics.set('retry_attempts', scalar(db, `SELECT
      coalesce((SELECT sum(max(attempts-1,0)) FROM jobs),0)
      + coalesce((SELECT sum(max(attempts-1,0)) FROM ops_outbox),0) AS value`))
    metrics.set('outbox_lag_ms', scalar(db, `SELECT coalesce(max(
      max(0, (julianday('now')-julianday(created_at))*86400000)
    ),0) AS value FROM ops_outbox WHERE status IN ('pending','delivering')`))
    metrics.set('device_revoke_propagation_pending', scalar(db, `SELECT count(*) AS value
      FROM ops_outbox WHERE destination='remote-device-revocation'
        AND status IN ('pending','delivering')`))
    return {
      metrics: metrics.snapshot(),
      unavailable: projectionLag === undefined ? ['projection_lag_ms'] : [],
    }
  })

  server.get('/api/v1/ops/alerts', (request, reply) => {
    if (!requireLocalOwner(request, reply)) return
    const jobs = db.prepare(`SELECT id AS jobId, attempts, status,
      max(0, (julianday('now')-julianday(coalesce(started_at, scheduled_at, created_at)))*86400000) AS ageMs
      FROM jobs WHERE status IN ('queued','running','cancelling','blocked') ORDER BY id`).all() as Array<{
        jobId: string
        attempts: number
        status: 'queued' | 'running' | 'cancelling' | 'blocked'
        ageMs: number
      }>
    const lostProcesses = db.prepare(`SELECT
      coalesce((SELECT session_id FROM os_events
        WHERE process_id=processes.id AND session_id IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 1), processes.id) AS sessionId,
      (SELECT job_id FROM os_events
        WHERE process_id=processes.id AND job_id IS NOT NULL
        ORDER BY created_at DESC, id DESC LIMIT 1) AS jobId
      FROM processes WHERE status='lost' ORDER BY id`).all() as Array<{
        sessionId: string
        jobId?: string
      }>
    const projectionLagMs = optionalScalar(db, `SELECT coalesce(max(
      max(0, (julianday('now')-julianday(created_at))*86400000)
    ), 0) AS value FROM os_compatibility_projection_quarantine`)
    const tokensPerMinute = optionalScalar(db, `SELECT coalesce(sum(
      coalesce(json_extract(metadata_json, '$.total_tokens'),
        json_extract(metadata_json, '$.usage.total_tokens'),
        json_extract(metadata_json, '$.tokens'), 0)
    ), 0) AS value FROM conversation_events
      WHERE kind='usage' AND created_at>=datetime('now','-1 minute')`)
    const staleRemoteAuthorizedIntents = staleRemoteAuthorizedIntentCount(db)
    const authenticationDenials = scalar(db, `SELECT count(*) AS value
      FROM os_remote_security_events WHERE event_type='authentication_denied'
        AND occurred_at>=datetime('now','-5 minutes')`)
    const pairingReplays = scalar(db, `SELECT count(*) AS value
      FROM os_remote_security_events WHERE reason_code='pairing_ticket_replay'
        AND occurred_at>=datetime('now','-5 minutes')`)
    const stepUpReplays = scalar(db, `SELECT count(*) AS value
      FROM os_remote_mutation_audit WHERE denial_code='step_up_replayed'
        AND occurred_at>=datetime('now','-5 minutes')`)
    const failedLostDevicePurges = scalar(db, `SELECT
      (SELECT count(*) FROM ops_outbox WHERE destination='remote-device-revocation'
        AND status='dead')
      + (SELECT count(*) FROM os_device_sessions session
        WHERE session.state IN ('revoked','compromised') AND (
          EXISTS (SELECT 1 FROM os_device_credentials credential
            WHERE credential.device_session_id=session.id AND credential.state='active')
          OR EXISTS (SELECT 1 FROM os_remote_push_subscriptions subscription
            WHERE subscription.device_session_id=session.id)
          OR EXISTS (SELECT 1 FROM os_remote_resource_grants grant_row
            WHERE grant_row.device_session_id=session.id)
          OR EXISTS (SELECT 1 FROM os_remote_step_up_grants step_up
            WHERE step_up.device_session_id=session.id AND step_up.state IN ('pending','active'))
        )) AS value`)
    const securitySignals = {
      authenticationDenials, pairingReplays, stepUpReplays, failedLostDevicePurges,
    }
    return { alerts: runtime
      ? runtime.evaluateAlerts({
        jobs,
        lostProcesses,
        rateLimitRejections: runtime.currentRateLimitRejections(),
        projectionLagMs,
        tokensPerMinute,
        staleRemoteAuthorizedIntents,
        ...securitySignals,
      })
      : alerts.evaluate({
        jobs, lostProcesses, projectionLagMs, tokensPerMinute, staleRemoteAuthorizedIntents,
        ...securitySignals,
      }),
    coverage: {
      live: ['stuck_job', 'repeated_retries', 'lost_process', 'rate_limit_storm',
        'remote_intent_stalled', 'auth_flood', 'pairing_replay', 'step_up_replay',
        'lost_device_purge_failed',
        ...(projectionLagMs === undefined ? [] : ['projection_lag']),
        ...(tokensPerMinute === undefined ? [] : ['token_storm'])],
      unavailable: [
        ...(projectionLagMs === undefined ? ['projection_lag'] : []),
        ...(tokensPerMinute === undefined ? ['token_storm'] : []),
      ],
    } }
  })

  const createDiagnosticsArtifact = async () => {
    const snapshot = await checkHealth()
    metrics.set('queue_depth', scalar(db, "SELECT count(*) AS value FROM jobs WHERE status='queued'"))
    metrics.set('retry_attempts', scalar(db, `SELECT
      coalesce((SELECT sum(max(attempts-1,0)) FROM jobs),0)
      + coalesce((SELECT sum(max(attempts-1,0)) FROM ops_outbox),0) AS value`))
    metrics.set('outbox_lag_ms', scalar(db, `SELECT coalesce(max(
      max(0, (julianday('now')-julianday(created_at))*86400000)
    ),0) AS value FROM ops_outbox WHERE status IN ('pending','delivering')`))
    metrics.set('device_revoke_propagation_pending', scalar(db, `SELECT count(*) AS value
      FROM ops_outbox WHERE destination='remote-device-revocation'
        AND status IN ('pending','delivering')`))
    return new OperationsDiagnosticsBundle().create({
      generatedByVersion: VERSION,
      health: snapshot,
      metrics: metrics.snapshot(),
      recentLogs: logger.recent(),
      runtime: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        uptimeSeconds: process.uptime(),
      },
      configuration: {
        authentication: 'required_or_loopback_only',
        remote_exposure: readRemoteState()?.provider ?? 'disabled',
        stale_remote_authorized_intents: staleRemoteAuthorizedIntentCount(db),
      },
    })
  }

  server.get('/api/v1/ops/diagnostics', async (request, reply) => {
    if (!requireLocalOwner(request, reply)) return
    const artifact = await createDiagnosticsArtifact()
    reply.header('content-type', 'application/gzip')
    reply.header('content-disposition', `attachment; filename="${artifact.filename}"`)
    reply.header('x-content-sha256', artifact.sha256)
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
    return reply.send(artifact.bytes)
  })

  server.post('/api/v1/ops/support-case', async (request, reply) => {
    if (!requireLocalOwner(request, reply)) return
    try {
      const artifact = createSupportCaseExport({
        request: request.body as SupportCaseExportRequestV1,
        diagnostics: await createDiagnosticsArtifact(),
      })
      reply.header('content-type', 'application/json; charset=utf-8')
      reply.header('content-disposition', `attachment; filename="${artifact.filename}"`)
      reply.header('x-content-sha256', artifact.sha256)
      reply.header('cache-control', 'no-store')
      reply.header('x-content-type-options', 'nosniff')
      return reply.send(artifact.bytes)
    } catch {
      return reply.code(400).send({
        error: 'support-case export was rejected by consent, input, or diagnostics verification',
      })
    }
  })

  return {
    publicReadiness: async () => {
      if (runtime) return runtime.publicReadiness()
      if (checkedAt === 0) return refresh()
      if (!cached.ready && Date.now() - checkedAt > 1_000) return refresh()
      if (Date.now() - checkedAt > 15_000) {
        void refresh()
        return Object.freeze({ live: true, ready: false })
      }
      return cached
    },
  }
}
