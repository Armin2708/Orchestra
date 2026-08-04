import Fastify, { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { generateName } from './names.js'
import { pathsIntersect } from './overlap.js'
import { isSimilar, isShippedMatch } from './similar.js'
import { removeAgentCards, bounceDeadLetters } from './reaper.js'
import { diffStat, hasOpenReviewRequest, recordDecision, listCardDecisions, listBoardDecisions } from './review.js'
import { tokenEquals } from './token.js'
import { LocalOwnerAuthError, type LocalOwnerPasswordAuth } from './local-owner-auth.js'
import { hardware, claudeUsage } from './system.js'
import { ShipQueue, ShipHooks, shipGate, autoshipEnabled, cardWorktree } from './shipqueue.js'
import { recordTelemetry, boardTelemetry, injectedTotal, TelemetryEntry } from './telemetry.js'
import { ExternalTranscriptService } from './external-transcript.js'
import { boardUsage, providerUsageTotal, usageTotal } from './usage.js'
import { recordShipped } from './shipped.js'
import { shiplog } from './shiplog.js'
import { defaultsForRole } from './agent-defaults.js'
import { AgentOsError, UnsupportedError } from './agent-os/errors.js'
import { DeliveryLifecycleIntegration } from './agent-os/delivery-integration.js'
import {
  DeliveryTrackbookService,
  type DeliveryAutoshipIntent,
} from './agent-os/delivery-trackbook.js'
import { requireIdempotencyKey } from './agent-os/idempotency.js'
import { orchestrationIdentity } from './agent-os/orchestration-envelope.js'
import { CODEX_PROVIDER_ID, type AgentProviderCatalog } from './agent-providers.js'
import {
  ACCESS_PROFILES,
  ProviderUnavailableError,
  type AccessProfile,
} from './provider-agent-manager.js'
import { registerAgentSessionControlRoutes, type AgentSessionControlHost } from './agent-session-controls.js'
import {
  registerAgentOsServerComposition,
  type AgentOsServerRouteOptions,
} from './server-composition.js'
import { registerCompatibilityReadObserver } from './agent-os/compatibility-read-observer.js'
import {
  consumeManagedAgentLaunchBootstrap,
  managedAgentCredentialHash,
} from './agent-session-credential.js'
import { resolveAgentMutationPrincipal } from './agent-os/agent-mutation-principal.js'
import {
  registerRemoteSecurityIntegration,
  type RemoteAuthenticatedDevice,
} from './remote-security-integration.js'
import { registerOperationsIntegration } from './operations/integration.js'
import type { OperationsRuntime } from './operations/runtime.js'
import type { ActiveWorkRegistration } from './agent-os/operations-recovery.js'
import { OperationsRateLimiter } from './operations/capacity.js'
import { classifyOperationalFailure, OPERATIONS_FAILURE_POLICIES } from './operations/failure-policy.js'
import type { VapidKeys } from './push.js'
import { formatInjectedMessage, injectTerminalMessage, recordTerminalEndpoint } from './terminal-inject.js'

export type Bus = EventEmitter
// minimal surface the server needs from the conductor (injected by the daemon)
export interface ConductorLike extends AgentSessionControlHost {
  isHired(agentId: number): boolean
  hire(opts: { boardId: number; cwd: string; name?: string; provider?: string; model?: string; role?: 'strategist' | 'auditor' | 'verifier'; ephemeral?: boolean; resumeSession?: string; permissionMode?: string; accessProfile?: AccessProfile; effort?: string; cardId?: number; maxBudgetUsd?: number; taskBudgetTokens?: number }): any
  deliver(agentId: number, msg: any): boolean
  // optional: only the real Conductor resumes limit-paused agents (#62)
  wake?(boardId: number): { woke: string[]; queued: string[]; skipped: string[] }
  task(agentId: number, text: string): boolean
  transcript(agentId: number): any
  subagents(agentId: number): { key: string; label: string }[]
  interruptAgent(agentId: number): Promise<boolean>
  fire(agentId: number): Promise<boolean>
  launch(req: { boardId: number; cardId: number; cwd: string; brief: string; provider?: string; model?: string; effort?: string; accessProfile?: AccessProfile; permissionMode?: string }): any
  isLaunched(cardId: number): boolean
  // optional so existing test stubs stay valid; the real Conductor implements all of these
  setPermissionMode?(agentId: number, mode: string): Promise<boolean>
  resolvePermission?(agentId: number, requestId: string, behavior: 'allow' | 'deny', message?: string, answers?: Record<string, string[]>): boolean | Promise<boolean>
  resolveApproval?(agentId: number, requestId: string, decision: 'allow' | 'allow_session' | 'deny' | 'cancel', message?: string, answers?: Record<string, string[]>): boolean | Promise<boolean>
  setAccessProfile?(agentId: number, profile: AccessProfile): Promise<boolean>
  setModel?(agentId: number, model: string): Promise<boolean>
  setEffort?(agentId: number, level: string): Promise<'ok' | 'busy' | 'not-found' | 'bad-level' | 'no-session'>
  providerCatalog?(): Promise<AgentProviderCatalog[]>
  capabilities?(agentId: number): string[]
  adoptLaunch?(agentId: number): void
  detachAll?(): Promise<void>
  shutdown?(): Promise<void>
}
declare module 'fastify' {
  interface FastifyInstance { db: Database.Database; bus: Bus }
  interface FastifyRequest {
    orchestraPrincipal: 'operator' | 'agent' | 'device' | 'anonymous'
    orchestraRemoteDevice: RemoteAuthenticatedDevice | null
  }
}

export interface ServerOptions {
  token?: string
  agentToken?: string
  localOwnerAuth?: LocalOwnerPasswordAuth
  // test seam: replace the real ShipQueue (which runs git + the full suite)
  makeShipQueue?: (projectPath: string, hooks: ShipHooks) => Pick<ShipQueue, 'enqueue' | 'status'>
  // test seam: serve the web UI from this directory instead of ../web/dist
  webDist?: string
  // daemon opt-in: loopback browsers act as the operator without a password
  trustLoopbackBrowsers?: boolean
  // the daemon's autowake timer, read lazily — the meter shows when paused agents auto-resume
  autowakeAt?: () => string | null
  // daemon-only Agent OS runtime/driver seams; in-process tests keep the durable read APIs
  // while unsupported process mutations continue to fail explicitly.
  agentOs?: AgentOsServerRouteOptions
  operations?: OperationsRuntime
  vapidKeys?: VapidKeys
  stopRemoteTunnel?: () => unknown
  admitMutation?: () => void
  reconcileActiveWork?: () => void
  registerActiveWork?: (registration: ActiveWorkRegistration) => () => void
}

const MESSAGE_KINDS = new Set(['ask', 'reply', 'task', 'notify', 'announce', 'swarm'] as const)
// the operator has no agent row — these recipient names mean "no agent recipient", which an
// ask already renders as "to You" and surfaces in open_questions (the operator inbox)
const HUMAN_RECIPIENTS = new Set(['human', 'operator', 'owner', 'you'])
type MessageKind = 'ask' | 'reply' | 'task' | 'notify' | 'announce' | 'swarm'

export function buildServer(db: Database.Database, conductor?: (bus: Bus) => ConductorLike, opts: ServerOptions = {}): FastifyInstance {
  const server = Fastify()
  server.decorate('db', db)
  server.decorate('bus', new EventEmitter())
  server.decorateRequest('orchestraPrincipal', 'anonymous')
  server.decorateRequest('orchestraRemoteDevice', null)
  const maestro = conductor?.(server.bus)
  // conversation text for agents running in their own terminal (hooks-only sessions)
  const externalTranscripts = new ExternalTranscriptService()
  registerRemoteSecurityIntegration(server, {
    db,
    masterToken: opts.token,
    agentToken: opts.agentToken,
    authenticateLocalOwnerSession: (session) => opts.localOwnerAuth?.authenticate(session) ?? false,
    trustLoopbackBrowsers: opts.trustLoopbackBrowsers,
    verifyLocalOwnerPassword: (password, partition) => {
      if (!opts.localOwnerAuth?.isConfigured()) return 'not_configured'
      try {
        opts.localOwnerAuth.verify(password, partition)
        return 'ok'
      } catch (error) {
        if (error instanceof LocalOwnerAuthError) {
          if (error.code === 'rate_limited') return 'rate_limited'
          if (error.code === 'password_incorrect') return 'incorrect'
          return 'not_configured'
        }
        throw error
      }
    },
    operations: opts.operations,
    vapidKeys: opts.vapidKeys,
    stopRemoteTunnel: opts.stopRemoteTunnel,
    runtime: opts.agentOs?.runtime,
    controls: maestro,
    authenticateAgent: (request) => Boolean(resolveAgentMutationPrincipal(db, request)),
  })
  const operations = registerOperationsIntegration(server, db, opts.operations)
  const operationalRateLimiter = new OperationsRateLimiter({
    rules: [
      { family: 'request', limit: 1_000, windowMs: 60_000 },
      { family: 'command', limit: 240, windowMs: 60_000 },
      { family: 'provider', limit: 60, windowMs: 60_000 },
    ],
    partitionSalt: randomBytes(32).toString('hex'),
  })
  const capacityAdmissions = new Map<object, { requestId: string; provider: string }>()
  const activeRequestReleases = new WeakMap<object, () => void>()
  server.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      const rawPartition = request.orchestraRemoteDevice?.deviceSessionId
        ?? request.ip ?? request.raw.socket.remoteAddress ?? 'unknown'
      const requestLimit = operationalRateLimiter.consume('request', rawPartition)
      const commandFamily = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? null
        : /(?:\/agents\/hire|\/launch|\/dispatch|\/jobs(?:\/|$))/u.test(request.url)
          ? 'provider' as const : 'command' as const
      const commandLimit = commandFamily ? operationalRateLimiter.consume(commandFamily, rawPartition) : null
      const denied = !requestLimit.allowed ? requestLimit : commandLimit && !commandLimit.allowed ? commandLimit : null
      if (denied) {
        try {
          opts.operations?.recordRateLimitRejection(request.orchestraRemoteDevice?.deviceSessionId)
        } catch { /* rate-limit denial remains authoritative */ }
        return reply.code(429)
          .header('retry-after', String(Math.ceil(denied.retry_after_ms / 1_000)))
          .send({ error: 'operational rate limit exceeded', reason_code: denied.reason_code })
      }
    }
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
    try { opts.admitMutation?.() } catch {
      return reply.code(503).send({ error: 'daemon is draining; new mutations are disabled' })
    }
    const launchesWork = /(?:\/agents\/hire|\/launch|\/dispatch|\/jobs(?:\/|$))/u.test(request.url)
    if (launchesWork && opts.registerActiveWork) {
      let resolveSettled!: () => void
      const settled = new Promise<void>((resolve) => { resolveSettled = resolve })
      const unregister = opts.registerActiveWork({
        id: `http:${request.id}`,
        settle: () => settled,
        onDeadline: 'stop',
        stop: async () => { request.raw.destroy(); resolveSettled() },
      })
      activeRequestReleases.set(request, () => { resolveSettled(); unregister() })
    }
    if (!opts.operations || !launchesWork) return
  })
  server.addHook('preHandler', async (request, reply) => {
    const launchesWork = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
      && /(?:\/agents\/hire|\/launch|\/dispatch|\/jobs(?:\/|$))/u.test(request.url)
    if (!opts.operations || !launchesWork) return
    const durableActive = db.prepare(`SELECT 'session:' || session.id AS requestId,
      coalesce(job.provider, 'claude') AS provider
      FROM agent_sessions session LEFT JOIN jobs job ON job.id=session.job_id
      WHERE session.status IN ('starting','running','idle')
      UNION ALL
      SELECT 'agent:' || agent.id AS requestId, coalesce(agent.provider, 'claude') AS provider
      FROM agents agent WHERE agent.kind='hired' AND agent.status NOT IN ('gone','paused_limit')
        AND NOT EXISTS (SELECT 1 FROM agent_sessions session
          WHERE session.agent_id=agent.id AND session.status IN ('starting','running','idle'))`)
      .all() as Array<{ requestId: string; provider: string }>
    const inFlight = [...capacityAdmissions.values()].map((active) => ({
      ...active, priority: 'interactive' as const,
    }))
    opts.operations.capacity.reconcileActive([
      ...durableActive.map((active) => ({ ...active, priority: 'normal' as const })),
      ...inFlight,
    ])
    const body = request.body as { provider?: unknown } | undefined
    const provider = typeof body?.provider === 'string' && /^[a-z0-9_-]{1,64}$/u.test(body.provider)
      ? body.provider : 'claude'
    const capacityId = `http:${request.id}`
    const admission = opts.operations.capacity.admit({
      requestId: capacityId, provider, priority: 'interactive',
    })
    if (admission.decision !== 'start') {
      if (admission.decision === 'queue') opts.operations.capacity.cancelQueued(capacityId)
      return reply.code(429).header('retry-after', String(Math.ceil((admission.retry_after_ms ?? 1_000) / 1_000)))
        .send({ error: 'runtime capacity is unavailable', reason_code: admission.reason_code })
    }
    capacityAdmissions.set(request, { requestId: capacityId, provider })
  })
  server.addHook('onResponse', async (request, reply) => {
    const admission = capacityAdmissions.get(request)
    if (admission) {
      opts.operations?.capacity.release(admission.requestId)
      capacityAdmissions.delete(request)
    }
    if (reply.statusCode < 400
      && /(?:\/agents\/hire|\/launch|\/dispatch|\/jobs(?:\/|$))/u.test(request.url)) {
      try { opts.reconcileActiveWork?.() } catch { /* shutdown admission is already closed */ }
    }
    activeRequestReleases.get(request)?.()
  })
  server.setErrorHandler((error, request, reply) => {
    const source = String((error as NodeJS.ErrnoException).code ?? '').startsWith('SQLITE_')
      ? 'database' as const
      : /provider/u.test(request.url) ? 'provider' as const : undefined
    const failure = classifyOperationalFailure(error, source)
    const policy = OPERATIONS_FAILURE_POLICIES[failure]
    opts.operations?.logger.log({
      level: policy.alert_severity === 'critical' ? 'error' : 'warn',
      event: 'operations.request.failed',
      outcome: 'failed',
      component: source ?? 'request',
      reasonCode: policy.reason_code,
      correlationId: request.id,
      attributes: { disposition: policy.mutation },
    })
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      && typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode : 500
    const status = failure === 'database_locked' ? 503
      : failure === 'provider_unavailable' ? 503
        : failure === 'unknown' ? statusCode : 507
    return reply.code(status).send({ error: 'operation failed safely', reason_code: policy.reason_code })
  })
  registerAgentSessionControlRoutes(server, maestro)
  const emit = (board_id: number, type: string, data: unknown) =>
    server.bus.emit('event', { board_id, type, data })
  const deliveryLifecycle = new DeliveryLifecycleIntegration(db)
  const deliveryTrackbook = new DeliveryTrackbookService(db)
  const deliveryFailure = (error: unknown, reply: any) => {
    if (error instanceof AgentOsError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code })
    }
    throw error
  }
  const requireOperator = (req: import('fastify').FastifyRequest, reply: any): boolean => {
    if (req.orchestraPrincipal === 'operator') return true
    reply.code(403).send({ error: 'operator authorization is required for this action' })
    return false
  }

  server.get('/health', async () => {
    const status = await operations.publicReadiness()
    return { ok: status.ready, ...status }
  })

  const ownerAuthFailure = (error: unknown, reply: any) => {
    if (error instanceof LocalOwnerAuthError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code })
    }
    throw error
  }

  server.get('/api/v1/auth/status', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return { password_set: opts.localOwnerAuth?.isConfigured() ?? false }
  })

  server.post<{ Body: { password?: string } }>('/api/v1/auth/setup', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!opts.localOwnerAuth) return reply.code(503).send({ error: 'local password authentication is unavailable' })
    try {
      const result = opts.localOwnerAuth.setup(String(request.body?.password ?? ''))
      return { session: result.session, expires_at: result.expiresAt }
    } catch (error) {
      return ownerAuthFailure(error, reply)
    }
  })

  server.post<{ Body: { password?: string } }>('/api/v1/auth/login', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    if (!opts.localOwnerAuth) return reply.code(503).send({ error: 'local password authentication is unavailable' })
    try {
      const partition = request.ip || request.raw.socket.remoteAddress || 'loopback'
      const result = opts.localOwnerAuth.login(String(request.body?.password ?? ''), partition)
      return { session: result.session, expires_at: result.expiresAt }
    } catch (error) {
      return ownerAuthFailure(error, reply)
    }
  })

  server.get('/api/v1/system', async () => {
    const u = await claudeUsage(db)
    const providers = await maestro?.providerCatalog?.() ?? []
    return {
      hardware: hardware(),
      hired: (db.prepare(`SELECT COUNT(*) AS c FROM agents WHERE kind='hired' AND status != 'gone'`).get() as any).c,
      usage: u.usage,
      usage_error: u.usage_error,
      usage_error_since: u.usage_error_since,
      injected: injectedTotal(db),
      // real API tokens consumed by hired agents — not the injected-context estimate above
      agent_usage: usageTotal(db),
      provider_usage: providerUsageTotal(db),
      providers,
      // limit-paused agents + when the autowake timer resumes them (#62)
      paused_limit: (db.prepare(`SELECT COUNT(*) AS c FROM agents WHERE kind='hired' AND status='paused_limit'`).get() as any).c,
      autowake_at: opts.autowakeAt?.() ?? null,
      autowake_enabled: process.env.ORCHESTRA_AUTOWAKE !== '0',
    }
  })

  server.get<{ Params: { id: string } }>('/api/v1/boards/:id/telemetry', (req) => ({
    ...boardTelemetry(db, Number(req.params.id)),
    usage: boardUsage(db, Number(req.params.id)),
  }))

  // board-wide activity feed: card events, review decisions, messages, milestones merged
  // reverse-chronologically. Cursor pages on (ts, source, id) strictly-less-than, so rows
  // inserted mid-walk (always newer) can never duplicate or shift an older page.
  server.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string; agent?: string; card?: string; type?: string } }>(
    '/api/v1/boards/:id/timeline', (req, reply) => {
      const boardId = Number(req.params.id)
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
      let cur: { ts: string; source: string; id: number } | null = null
      if (req.query.cursor) {
        try {
          const [ts, source, id] = JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString('utf8'))
          cur = { ts, source, id: Number(id) }
        } catch { return reply.code(400).send({ error: 'bad cursor' }) }
      }
      const rows = db.prepare(`
        SELECT * FROM (
          SELECT e.created_at AS ts, 'card' AS source, e.id AS id, e.type AS type, a.name AS agent,
                 e.card_id AS card_id, c.title AS card_title, e.payload AS detail, NULL AS peer
          FROM card_events e JOIN cards c ON c.id = e.card_id LEFT JOIN agents a ON a.id = e.agent_id
          WHERE c.board_id = @board
          UNION ALL
          SELECT r.decided_at, 'review', r.id, r.decision, NULL, r.card_id, c.title, r.note, NULL
          FROM review_decisions r LEFT JOIN cards c ON c.id = r.card_id
          WHERE r.board_id = @board
          UNION ALL
          SELECT m.created_at, 'message', m.id, 'message', fa.name, m.card_id, mc.title, m.body, ta.name
          FROM messages m LEFT JOIN agents fa ON fa.id = m.from_agent_id
            LEFT JOIN agents ta ON ta.id = m.to_agent_id LEFT JOIN cards mc ON mc.id = m.card_id
          WHERE m.board_id = @board
          UNION ALL
          SELECT ms.created_at, 'milestone', ms.id, 'milestone', NULL, NULL, ms.title, ms.description, NULL
          FROM milestones ms WHERE ms.board_id = @board
        )
        WHERE (@curTs IS NULL OR ts < @curTs OR (ts = @curTs AND (source < @curSrc OR (source = @curSrc AND id < @curId))))
          AND (@agent IS NULL OR agent = @agent OR peer = @agent)
          AND (@card IS NULL OR card_id = @card)
          AND (@type IS NULL OR type = @type OR source = @type)
        ORDER BY ts DESC, source DESC, id DESC
        LIMIT @lim`).all({
        board: boardId,
        curTs: cur?.ts ?? null, curSrc: cur?.source ?? null, curId: cur?.id ?? null,
        agent: req.query.agent ?? null,
        card: req.query.card ? Number(req.query.card) : null,
        type: req.query.type ?? null,
        lim: limit + 1,
      }) as any[]
      const has_more = rows.length > limit
      const page = rows.slice(0, limit)
      const items = page.map((r) => ({
        ts: r.ts, source: r.source, id: r.id, type: r.type, agent: r.agent,
        card_id: r.card_id, card_title: r.card_title, summary: timelineSummary(r),
      }))
      const last = page[page.length - 1]
      const next_cursor = has_more && last
        ? Buffer.from(JSON.stringify([last.ts, last.source, last.id])).toString('base64url') : null
      return { items, next_cursor, has_more }
    })

  // annotated commit history: git log joined with the cards/agents that shipped each commit
  server.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>(
    '/api/v1/boards/:id/shipped', async (req, reply) => {
      const board = db.prepare(`SELECT * FROM boards WHERE id=?`).get(Number(req.params.id)) as any
      if (!board) return reply.code(404).send({ error: 'not found' })
      return shiplog(db, board, { offset: Number(req.query.offset ?? 0) || 0, limit: Number(req.query.limit ?? 50) || 50 })
    })

  // terminal sessions report their live subagents via hook pings; entries expire quickly
  const termSubs = new Map<number, Map<string, number>>()
  const liveTermSubs = (agentId: number): { key: string; label: string }[] => {
    const m = termSubs.get(agentId)
    if (!m) return []
    const now = Date.now()
    for (const [k, t] of m) if (now - t > 90_000) m.delete(k)
    return [...m.keys()].map((key) => ({ key, label: 'subagent' }))
  }
  const hookTokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
  const hookAgent = (agentId: number, body: Record<string, unknown> | null | undefined) => {
    const agent = db.prepare('SELECT * FROM agents WHERE id=?').get(agentId) as any
    if (!agent || agent.kind !== 'session') return null
    // Name-only legacy API registrations have no provider session to steal and keep
    // their historical bodyless lifecycle contract. Every real hook session is bound.
    if (!agent.hook_token_hash && !agent.external_session_id) return agent
    const provider = typeof body?.provider === 'string' ? body.provider.trim().toLowerCase() : ''
    const sessionId = typeof body?.session_id === 'string' ? body.session_id : ''
    const token = typeof body?.session_token === 'string' ? body.session_token : ''
    if (!provider || !sessionId || !token || provider !== agent.provider || sessionId !== agent.external_session_id)
      return null
    return tokenEquals(hookTokenHash(token), String(agent.hook_token_hash ?? '')) ? agent : null
  }

  server.post<{ Body: { project_path: string } }>('/api/v1/boards/resolve', (req) => {
    const p = req.body.project_path
    const inserted = db.prepare(`INSERT OR IGNORE INTO boards (project_path, name) VALUES (?, ?)`)
      .run(p, path.basename(p))
    const board = db.prepare(`SELECT * FROM boards WHERE project_path = ?`).get(p) as
      Record<string, unknown> & { id: number }
    if (inserted.changes === 1) emit(board.id, 'board', board)
    return board
  })

  server.get('/api/v1/boards', () => db.prepare(`SELECT * FROM boards ORDER BY id`).all())

  server.post<{ Body: { board_id: number; session_id?: string; external_session_id?: string; name?: string; provider?: string; agent_id?: number; bootstrap_nonce?: string; agent_home_session_id?: string; terminal?: unknown } }>(
    '/api/v1/agents/register', (req, reply) => {
      const { board_id, session_id } = req.body
      const requestedProvider = req.body.provider?.trim().toLowerCase()
      if (requestedProvider !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(requestedProvider))
        return reply.code(400).send({ error: 'invalid provider id' })
      const provider = requestedProvider ?? 'claude'
      const externalSessionId = req.body.external_session_id ?? session_id ?? null
      if (externalSessionId !== null && (typeof externalSessionId !== 'string' || !externalSessionId.trim() || externalSessionId.length > 512))
        return reply.code(400).send({ error: 'session_id must be a non-empty string of 512 characters or fewer' })
      if (req.body.bootstrap_nonce !== undefined) {
        const managed = consumeManagedAgentLaunchBootstrap(db, {
          agentId: Number(req.body.agent_id),
          boardId: Number(board_id),
          agentName: String(req.body.name ?? ''),
          provider,
          externalSessionId: String(externalSessionId ?? ''),
          bootstrapNonce: String(req.body.bootstrap_nonce),
          agentHomeSessionId: req.body.agent_home_session_id ?? null,
        })
        if (!managed) return reply.code(401).send({ error: 'invalid or expired managed launch bootstrap' })
        const stored = db.prepare('SELECT * FROM agents WHERE id=?').get(managed.agentId) as any
        const { hook_token_hash: _secretHash, ...agent } = stored
        emit(managed.boardId, 'agent', agent)
        return { ...agent, session_token: managed.sessionToken }
      }
      if (req.orchestraPrincipal === 'anonymous') {
        return reply.code(401).send({ error: 'registration requires transport authentication' })
      }
      let name = req.body.name
      const identity = externalSessionId ? db.prepare(`SELECT * FROM agents WHERE provider=? AND external_session_id=?`)
        .get(provider, externalSessionId) as any : undefined
      if (identity) {
        if (!['session', 'hired'].includes(identity.kind)
          || identity.board_id !== board_id || (name && name !== identity.name))
          return reply.code(409).send({ error: 'provider session identity is already bound to another agent' })
        name = identity.name
      }
      if (!name) {
        do { name = generateName() } while (
          db.prepare(`SELECT 1 FROM agents WHERE board_id=? AND name=?`).get(board_id, name))
      }
      const named = db.prepare('SELECT * FROM agents WHERE board_id=? AND name=?').get(board_id, name) as any
      const sameIdentity = !!named && identity?.id === named.id
      const legacyNameOnly = !!named && !externalSessionId && !named.external_session_id && named.kind === 'session'
      if (named && !sameIdentity && !legacyNameOnly)
        return reply.code(409).send({ error: `agent ${name} is already registered with another session` })
      const hired = identity?.kind === 'hired' ? identity : named?.kind === 'hired' ? named : null
      const exactPrincipal = req.orchestraPrincipal === 'agent'
        ? resolveAgentMutationPrincipal(db, req) : null
      if (req.orchestraPrincipal === 'agent' && !exactPrincipal) {
        return reply.code(403).send({ error: 'exact provider-session credential is required' })
      }
      if (hired && exactPrincipal?.agentId !== hired.id) {
        return reply.code(409).send({ error: 'managed agent identity requires its launch or current session credential' })
      }
      const sessionToken = externalSessionId ? randomBytes(32).toString('base64url') : null
      const tokenHash = sessionToken ? hookTokenHash(sessionToken) : null
      try {
        if (hired && sessionToken && tokenHash) {
          const oldToken = String(req.headers['x-orchestra-session-token'] ?? '')
          const rotated = db.prepare(`UPDATE agents SET hook_token_hash=?, status='active',
              last_seen=datetime('now')
            WHERE id=? AND board_id=? AND provider=? AND external_session_id=?
              AND hook_token_hash=?`)
            .run(tokenHash, hired.id, board_id, provider, externalSessionId,
              managedAgentCredentialHash(oldToken))
          if (rotated.changes !== 1) {
            return reply.code(409).send({ error: 'managed agent session credential rotation lost its compare-and-set' })
          }
        } else {
        db.prepare(`
          INSERT INTO agents (board_id, name, session_id, provider, external_session_id, hook_token_hash)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(board_id, name) DO UPDATE SET
            session_id=excluded.session_id, external_session_id=excluded.external_session_id,
            hook_token_hash=excluded.hook_token_hash, status='active', last_seen=datetime('now')
        `).run(board_id, name, session_id ?? null, provider, externalSessionId, tokenHash)
        }
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed'))
          return reply.code(409).send({ error: 'provider session identity is already registered' })
        throw error
      }
      const stored = db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(board_id, name) as any
      // terminal seat for instant message injection — hooks refresh it each SessionStart
      if (req.body.terminal) recordTerminalEndpoint(Number(stored.id), req.body.terminal)
      const { hook_token_hash: _secretHash, ...agent } = stored
      emit(board_id, 'agent', agent)
      return { ...agent, ...(sessionToken ? { session_token: sessionToken } : {}) }
    })

  server.get<{ Params: { id: string } }>('/api/v1/boards/:id/snapshot', (req) => {
    const id = Number(req.params.id)
    return {
      board: db.prepare(`SELECT * FROM boards WHERE id=?`).get(id),
      agents: (db.prepare(`SELECT * FROM agents WHERE board_id=? ORDER BY name`).all(id) as any[]).map((a) => ({
        ...a,
        capabilities: maestro?.capabilities?.(a.id) ?? [],
        subagents: maestro?.isHired(a.id) ? maestro.subagents(a.id) : liveTermSubs(a.id),
      })),
      // review cards carry their latest verification (#52); ship_status marks cards the
      // auto-ship queue currently holds (#59)
      cards: listCards(db, id).map((c: any) => ({
        ...(c.column === 'review' ? { ...c, verification: verificationFor(c.id) } : c),
        ship_status: ships.get(id)?.status(c.id) ?? null,
      })),
      ideas: db.prepare(`SELECT * FROM ideas WHERE board_id=? ORDER BY id`).all(id),
      milestones: db.prepare(`SELECT * FROM milestones WHERE board_id=? ORDER BY id`).all(id),
      open_questions: db.prepare(`
        SELECT m.*, fa.name AS from_name, ta.name AS to_name FROM messages m
        LEFT JOIN agents fa ON fa.id = m.from_agent_id
        LEFT JOIN agents ta ON ta.id = m.to_agent_id
        WHERE m.board_id=? AND m.kind='ask' AND m.reply_to IS NULL
          AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id)
        ORDER BY m.id`).all(id),
      // undelivered mail to agents who already left — actionable, not just history
      dead_letters: db.prepare(`
        SELECT m.*, fa.name AS from_name, ta.name AS to_name,
          EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id) AS bounced
        FROM messages m
        JOIN agents ta ON ta.id = m.to_agent_id AND ta.status='gone'
        LEFT JOIN agents fa ON fa.id = m.from_agent_id
        WHERE m.board_id=? AND m.delivered_at IS NULL
        ORDER BY m.id`).all(id),
      threads: listThreads(db, id),
    }
  })

  const COLUMNS = ['backlog', 'in_progress', 'blocked', 'review', 'done']
  const agentByName = (board_id: number, name?: string) =>
    name ? (db.prepare(`SELECT * FROM agents WHERE board_id=? AND name=?`).get(board_id, name) as any) : undefined
  const getCard = (id: number) => {
    const c = db.prepare(`SELECT c.*, a.name AS owner FROM cards c LEFT JOIN agents a ON a.id=c.owner_agent_id WHERE c.id=?`).get(id) as any
    return c && { ...c, column: c.column_name, paths: JSON.parse(c.paths) }
  }
  const overlapsFor = (card: any) =>
    listCards(db, card.board_id).filter((o) =>
      o.id !== card.id && o.column !== 'done' && o.owner !== card.owner &&
      pathsIntersect(card.paths, o.paths))
  const similarFor = (card: any, overlaps: any[]) => {
    const seen = new Set(overlaps.map((o) => o.id))
    const text = `${card.title} ${card.description}`
    return listCards(db, card.board_id).filter((o) =>
      o.id !== card.id && !seen.has(o.id) && o.column !== 'done' && o.owner !== card.owner &&
      isSimilar(text, `${o.title} ${o.description}`))
  }
  // done cards from the last 30 days that look like the same work already shipped
  const DONE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
  const doneSimilarFor = (card: any) => {
    const text = `${card.title} ${card.description}`
    return listCards(db, card.board_id).filter((o) =>
      o.id !== card.id && o.column === 'done' &&
      Date.now() - Date.parse(`${o.updated_at.replace(' ', 'T')}Z`) <= DONE_WINDOW_MS &&
      isShippedMatch(text, `${o.title} ${o.description}`))
  }
  // ── auto-ship (#59): one queue per board, integrating approved branches serially ──
  const ships = new Map<number, Pick<ShipQueue, 'enqueue' | 'status'>>()
  const shipFor = (board: { id: number; project_path: string }) => {
    let q = ships.get(board.id)
    if (q) return q
    const hooks: ShipHooks = {
      onEvent: (type, data) => {
        emit(board.id, 'ship', { status: type, ...data })
      },
      recordShipped: async (cardId, hash) => {
        await recordShipped(db, server.bus, { id: cardId, board_id: board.id }, board.project_path, { hash, by: 'autoship' })
        const intent = deliveryTrackbook.pendingAutoshipIntentForCard(board.id, cardId)
        if (!intent) throw new Error('accepted delivery autoship intent is missing')
        deliveryTrackbook.completeAutoshipIntent(intent.id, {
          actor: { type: 'operator', id: 'ship_queue' },
          observedHeadCommit: hash,
          idempotencyKey: `autoship-complete:${intent.id}:${hash}`,
        })
      },
      onSuccess: (c) => {
        emit(board.id, 'card', getCard(c.cardId))
      },
      onFailure: (c, reason, detail) => {
        db.prepare(`UPDATE cards SET column_name='blocked', updated_at=datetime('now') WHERE id=?`).run(c.cardId)
        logEvent(c.cardId, null, 'autoship_failed', { reason, detail: detail.slice(0, 4000) })
        emit(board.id, 'card', getCard(c.cardId))
      },
    }
    q = (opts.makeShipQueue ?? ((p, h) => new ShipQueue(p, h)))(board.project_path, hooks)
    ships.set(board.id, q)
    return q
  }

  const logEvent = (card_id: number, agent_id: number | null, type: string, payload: unknown = {}) =>
    db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, ?, ?)`)
      .run(card_id, agent_id, type, JSON.stringify(payload))

  // Reconcile already-merged intents first, then restore the bounded unmerged outbox.
  // This runs only when autoship is enabled and never fabricates evidence from card status.
  if (autoshipEnabled()) {
    const reconciliation = deliveryTrackbook.reconcilePendingAutoshipIntents({
      actor: { type: 'operator', id: 'ship_queue_recovery' },
      limit: 200,
    })
    // Consume this exact bounded snapshot. Pending-attempt events rotate attempted intents to the
    // back of later queries; re-querying here could starve all 200 candidates until another restart.
    for (const pending of reconciliation) {
      if (pending.status !== 'pending') continue
      const intent = pending.intent
      const candidate = db.prepare(`SELECT card.id, card.title, card.branch,
          card.column_name, board.id AS board_id, board.project_path,
          (SELECT event.type FROM card_events event WHERE event.card_id=card.id
            ORDER BY event.id DESC LIMIT 1) AS latest_event_type
        FROM cards card JOIN boards board ON board.id=card.board_id
        WHERE card.id=? AND card.board_id=?`).get(intent.card_id, intent.board_id) as any
      const recoverableState = candidate?.column_name === 'done'
        || (candidate?.column_name === 'blocked' && candidate.latest_event_type === 'autoship_failed')
      if (!candidate || !recoverableState || candidate.branch !== intent.source_branch) continue
      shipFor({ id: candidate.board_id, project_path: candidate.project_path }).enqueue({
        boardId: candidate.board_id,
        cardId: candidate.id,
        branch: candidate.branch,
        title: candidate.title,
        sourceCommit: intent.source_commit,
        worktree: cardWorktree(intent.source_repository, candidate.id),
      })
    }
  }

  server.post<{ Body: { board_id: number; title: string; description?: string; paths?: string[]; agent?: string; column?: string } }>(
    '/api/v1/cards', (req, reply) => {
      const { board_id, title, description = '', paths = [], agent, column = 'backlog' } = req.body
      if (!COLUMNS.includes(column)) return reply.code(400).send({ error: 'invalid column' })
      if (column === 'done' && !requireOperator(req, reply)) return
      const owner = agentByName(board_id, agent)
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO cards (board_id, title, description, column_name, owner_agent_id, paths)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(board_id, title, description, column, owner?.id ?? null, JSON.stringify(paths))
      const card = getCard(Number(lastInsertRowid))
      logEvent(card.id, owner?.id ?? null, 'created', { title })
      emit(board_id, 'card', card)
      const overlaps = overlapsFor(card)
      return { card, overlaps, similar: similarFor(card, overlaps), done_similar: doneSimilarFor(card) }
    })

  server.patch<{ Params: { id: string }; Body: { title?: string; description?: string; paths?: string[]; column?: string; agent?: string } }>(
    '/api/v1/cards/:id', async (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      const { title, description, paths, column, agent } = req.body
      if (column && !COLUMNS.includes(column)) return reply.code(400).send({ error: 'invalid column' })
      if (column === 'done' && !requireOperator(req, reply)) return
      const actor = agentByName(card.board_id, agent)
      try {
        if (column === 'review') deliveryLifecycle.ensureReviewReady({
          cardId: card.id,
          actor: actor?.name ?? agent ?? 'human',
        })
        if (column === 'done') deliveryLifecycle.assertDoneReady(card.id)
      } catch (error) {
        return deliveryFailure(error, reply)
      }
      db.prepare(`
        UPDATE cards SET title=coalesce(?, title), description=coalesce(?, description),
          paths=coalesce(?, paths), column_name=coalesce(?, column_name), updated_at=datetime('now')
        WHERE id=?`)
        .run(title ?? null, description ?? null, paths ? JSON.stringify(paths) : null, column ?? null, card.id)
      const updated = getCard(card.id)
      logEvent(card.id, actor?.id ?? null, 'updated', req.body)
      emit(card.board_id, 'card', updated)
      if (column === 'review') await requestReview(updated, null, actor?.name ?? agent ?? null)
      const overlaps = overlapsFor(updated)
      return { card: updated, overlaps, similar: similarFor(updated, overlaps), done_similar: doneSimilarFor(updated) }
    })

  server.post<{ Params: { id: string }; Body: { column: string; agent?: string } }>(
    '/api/v1/cards/:id/move', async (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      if (!COLUMNS.includes(req.body.column)) return reply.code(400).send({ error: 'invalid column' })
      if (req.body.column === 'done' && !requireOperator(req, reply)) return
      const actor = agentByName(card.board_id, req.body.agent)
      try {
        if (req.body.column === 'review') deliveryLifecycle.ensureReviewReady({
          cardId: card.id,
          actor: actor?.name ?? req.body.agent ?? 'human',
        })
        if (req.body.column === 'done') deliveryLifecycle.assertDoneReady(card.id)
      } catch (error) {
        return deliveryFailure(error, reply)
      }
      db.prepare(`UPDATE cards SET column_name=?, updated_at=datetime('now') WHERE id=?`)
        .run(req.body.column, card.id)
      const updated = getCard(card.id)
      logEvent(card.id, actor?.id ?? null, 'moved', { to: req.body.column })
      emit(card.board_id, 'card', updated)
      if (req.body.column === 'review') await requestReview(updated, null, updated.owner)
      return { card: updated }
    })

  // earlier milestone steps aren't hard blocks — they're context the assignee must coordinate on
  const prereqSteps = (card: any): any[] => {
    if (!card.milestone_id || card.step_order == null) return []
    return db.prepare(`
      SELECT c.id, c.title, c.column_name, a.name AS owner FROM cards c
      LEFT JOIN agents a ON a.id = c.owner_agent_id
      WHERE c.milestone_id=? AND c.step_order < ? AND c.column_name != 'done'
      ORDER BY c.step_order`).all(card.milestone_id, card.step_order)
  }

  // ── review gates: a finished step parks in review; a human approves or sends it back ──
  const boardPath = (board_id: number) =>
    (db.prepare(`SELECT project_path FROM boards WHERE id=?`).get(board_id) as any)?.project_path ?? ''

  // enrich a card entering review with the agent's summary + changed paths, once per review cycle
  const requestReview = async (card: any, summary: string | null, agentName: string | null) => {
    const delivery = deliveryLifecycle.ensureReviewReady({
      cardId: card.id,
      actor: agentName?.trim() || 'compatibility',
      summary,
    })
    if (hasOpenReviewRequest(db, card.id)) return
    const stat = await diffStat(boardPath(card.board_id), card.branch).catch(() => '')
    logEvent(card.id, null, 'review_request', {
      summary,
      diffstat: stat,
      branch: card.branch ?? null,
      delivery_id: delivery.id,
    })
    emit(card.board_id, 'review', {
      card_id: card.id, card_title: card.title,
      milestone_id: card.milestone_id ?? null, step_order: card.step_order ?? null,
      agent_name: agentName, status: 'awaiting_approval', summary, diffstat: stat,
      delivery_id: delivery.id,
      branch: card.branch ?? null,
    })
    // opt-in: every card entering review gets an independent verifier pass (default manual)
    if (process.env.ORCHESTRA_AUTO_VERIFY === '1') { try { startVerification(getCard(card.id)) } catch { /* manual verify still available */ } }
  }

  // ── delivery verification (#52): an ephemeral verifier checks DONE-WHEN before approval ──
  const lastEvent = (cardId: number, type: string): any =>
    db.prepare(`SELECT id, agent_id, payload, created_at FROM card_events WHERE card_id=? AND type=? ORDER BY id DESC LIMIT 1`)
      .get(cardId, type)

  // latest verdict + running state for badges; newest event wins, a newer request means re-running
  // a verifier that dies without reporting (crash, usage limit — see #62) must not pin the
  // card at "running" forever: after this window re-verify unblocks and the badge clears
  const VERIFY_STALE_MS = 15 * 60_000
  const verificationFor = (cardId: number): any => {
    const v = lastEvent(cardId, 'verification')
    const r = lastEvent(cardId, 'verify_requested')
    if (!v && !r) return undefined
    const fresh = !!r && Date.now() - new Date(r.created_at.replace(' ', 'T') + 'Z').getTime() < VERIFY_STALE_MS
    const running = fresh && (!v || r.id > v.id)
    if (!v) return { running, verdict: null }
    try {
      const p = JSON.parse(v.payload)
      return { running, verdict: p.verdict, tested: !!p.tested, criteria: p.criteria ?? [], at: v.created_at, by: p.by ?? null }
    } catch { return { running, verdict: null } }
  }

  // the brief hands the verifier everything location-dependent: criteria source, where the
  // delivery lives (shipped hash beats heuristics), and the exact report command
  const verifierBrief = (card: any) => {
    let hash: string | null = null
    try { hash = JSON.parse(lastEvent(card.id, 'shipped')?.payload ?? '{}').hash ?? null } catch { /* no shipped record */ }
    let review: any = null
    try { review = JSON.parse(lastEvent(card.id, 'review_request')?.payload ?? 'null') } catch { /* legacy */ }
    return `Verify the delivery of card #${card.id}: "${card.title}".\n` +
      `CARD DESCRIPTION (derive your criteria from its DONE WHEN, else REQUIREMENTS, else OBJECTIVE):\n${card.description || '(no description — verify the title as a single criterion)'}\n` +
      (hash ? `SHIPPED COMMIT (ground truth): ${hash} — inspect with: git show ${hash}\n`
        : card.branch
          ? `DELIVERY BRANCH (ground truth before merge): ${card.branch} — inspect with: git diff main...${card.branch} and git log main..${card.branch}\n`
          : `No shipped commit or delivery branch recorded — locate the delivery from recent merges mentioning the card (git log --oneline -20) or the diffstat below.\n`) +
      (review?.diffstat ? `REVIEW DIFFSTAT:\n${review.diffstat}\n` : '') +
      (review?.summary ? `CLAIMED SUMMARY (verify, do not trust): ${review.summary}\n` : '') +
      `REPORT exactly once with this command (fill in the JSON):\n` +
      `curl -s -X POST -H "authorization: Bearer $(orchestra token)" -H "content-type: application/json" ` +
      `http://127.0.0.1:$ORCHESTRA_PORT/api/v1/cards/${card.id}/verification ` +
      `-d '{"criteria":[{"text":"<criterion>","met":true,"evidence":"<one line>"}],"verdict":"pass","tested":true,"by":"<your agent name>"}'`
  }

  const startVerification = (card: any): any => {
    const board = db.prepare(`SELECT * FROM boards WHERE id=?`).get(card.board_id) as any
    const worktree = card.branch ? cardWorktree(board.project_path, card.id) : null
    const cwd = worktree && fs.existsSync(worktree) ? worktree : board.project_path
    const agent = maestro!.hire({ boardId: card.board_id, cwd, role: 'verifier', ephemeral: true })
    logEvent(card.id, agent?.id ?? null, 'verify_requested', { agent: agent?.name ?? null })
    emit(card.board_id, 'card', { ...getCard(card.id), verification: verificationFor(card.id) })
    maestro!.task(agent.id, verifierBrief(card))
    return agent
  }

  server.post<{ Params: { id: string } }>('/api/v1/cards/:id/verify', (req, reply) => {
    if (!maestro) return reply.code(501).send({ error: 'conductor not available (daemon-only feature)' })
    const card = getCard(Number(req.params.id))
    if (!card) return reply.code(404).send({ error: 'not found' })
    if (card.column !== 'review') return reply.code(409).send({ error: 'card is not in review' })
    const v = verificationFor(card.id)
    if (v?.running) return reply.code(409).send({ error: 'verification already running' })
    const agent = startVerification(card)
    return { ok: true, agent_id: agent.id, agent_name: agent.name }
  })

  const MET = new Set([true, false, 'unverifiable'])
  server.post<{ Params: { id: string }; Body: { criteria?: any[]; verdict?: string; tested?: boolean; by?: string } }>(
    '/api/v1/cards/:id/verification', (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      const { verdict, by } = req.body ?? {}
      if (!['pass', 'gaps', 'fail'].includes(verdict as string))
        return reply.code(400).send({ error: `verdict must be pass|gaps|fail, got "${verdict}"` })
      const raw = Array.isArray(req.body?.criteria) ? req.body.criteria : []
      const criteria = raw
        .filter((c) => c && typeof c.text === 'string' && MET.has(c.met))
        .map((c) => ({ text: String(c.text), met: c.met, evidence: String(c.evidence ?? '') }))
      if (raw.length > 0 && criteria.length === 0)
        return reply.code(400).send({ error: 'criteria entries need {text, met: true|false|"unverifiable"}' })
      const tested = req.body?.tested === true
      let delivery
      try {
        delivery = deliveryLifecycle.recordVerification({
          cardId: card.id,
          actor: typeof by === 'string' && by.trim() ? by.trim() : 'verifier',
          summary: `Legacy verifier verdict: ${verdict}`,
          results: criteria,
        })
      } catch (error) {
        return deliveryFailure(error, reply)
      }
      logEvent(card.id, null, 'verification', {
        criteria,
        verdict,
        tested,
        by: by ?? null,
        delivery_id: delivery.id,
      })
      const met = criteria.filter((c) => c.met === true).length
      // the human-readable trail survives the ephemeral verifier: a broadcast board note
      const noteBody = `verification of card #${card.id} "${card.title}": ${String(verdict).toUpperCase()} — ` +
        `${met}/${criteria.length} criteria met${tested ? ', test suite run' : ''}${by ? ` (by ${by})` : ''}`
      const { lastInsertRowid } = db.prepare(`INSERT INTO messages (board_id, card_id, kind, body) VALUES (?, ?, 'announce', ?)`)
        .run(card.board_id, card.id, noteBody)
      emit(card.board_id, 'message', db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(lastInsertRowid)))
      emit(card.board_id, 'card', { ...card, verification: verificationFor(card.id) })
      reviewEvent(card, 'verified', { verdict, delivery_id: delivery.id })
      return { ok: true, verdict, criteria_count: criteria.length, delivery }
    })

  // launched agents finishing a step already park the card in review (conductor exit) — enrich it here
  server.bus.on('event', (e: any) => {
    if (e?.type !== 'launch' || e?.data?.status !== 'finished' || e?.data?.to_column !== 'review') return
    const card = getCard(e.data.card_id)
    if (card) void requestReview(card, e.data.summary ?? null, e.data.agent_name ?? null)
      .catch((error) => logEvent(card.id, e.data.agent_id ?? null, 'review_delivery_error', {
        error: error instanceof Error ? error.message : String(error),
      }))
  })

  // the gate: a milestone step can't be launched while an earlier step awaits completion or approval
  server.addHook('onRequest', async (req, reply) => {
    const m = req.method === 'POST' && /^\/api\/(?:v1\/)?cards\/(\d+)\/launch$/.exec(req.url.split('?')[0])
    if (!m) return
    const card = getCard(Number(m[1]))
    if (!card) return
    const blocking = prereqSteps(card)
    if (blocking.length) {
      return reply.code(409).send({
        error: 'step locked — earlier milestone steps need approval first',
        blocking: blocking.map((b) => ({ id: b.id, title: b.title, column: b.column_name })),
      })
    }
  })

  const reviewEvent = (card: any, status: string, extra: Record<string, unknown> = {}) =>
    emit(card.board_id, 'review', {
      card_id: card.id, card_title: card.title,
      milestone_id: card.milestone_id ?? null, step_order: card.step_order ?? null,
      agent_name: card.owner ?? null, status, ...extra,
    })

  server.post<{ Params: { id: string }; Body: { note?: string; confirm?: boolean } }>(
    '/api/v1/cards/:id/approve', async (req, reply) => {
      if (!requireOperator(req, reply)) return
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      if (card.column !== 'review') return reply.code(409).send({ error: 'card is not in review' })
      const note = req.body?.note?.trim() || null
      // approving over a failed verification requires an explicit confirm (#52); the
      // auto-ship queue (#59) consumes it — an unconfirmed fail holds the card in review
      const confirmed = req.body?.confirm === true
      const wantShip = autoshipEnabled() && !!card.branch
      const gate = wantShip ? shipGate(db, card.id, { confirmed }) : { queue: false }
      if (wantShip && !gate.queue) {
        const decision = recordDecision(db, card, 'approve', note)
        logEvent(card.id, null, 'review_decision', { decision: 'approve', note, held: true })
        reviewEvent(card, 'approved', { note, held: true })
        emit(card.board_id, 'ship', { status: 'held', card_id: card.id, reason: gate.held })
        return { card: getCard(card.id), decision, held: true, reason: gate.held }
      }
      let delivery
      let autoshipIntent: DeliveryAutoshipIntent | null = null
      try {
        delivery = deliveryLifecycle.accept({
          cardId: card.id,
          actor: 'human',
          summary: note,
          confirmed,
        })
        if (!delivery) {
          return reply.code(409).send({ error: 'accepted delivery evidence is unavailable' })
        }
        deliveryLifecycle.assertDoneReady(card.id)
        if (wantShip) {
          autoshipIntent = deliveryTrackbook.prepareAutoshipIntent(delivery.id, {
            actor: { type: 'operator', id: 'autoship_approval' },
            branch: card.branch,
            idempotencyKey: `autoship-intent:${card.board_id}:${card.id}:${delivery.id}`,
          })
        }
      } catch (error) {
        return deliveryFailure(error, reply)
      }
      const decision = recordDecision(db, card, 'approve', note)
      logEvent(card.id, null, 'review_decision', {
        decision: 'approve',
        note,
        delivery_id: delivery?.id ?? null,
        ...(confirmed ? { confirmed: true } : {}),
      })
      db.prepare(`UPDATE cards SET column_name='done', updated_at=datetime('now') WHERE id=?`).run(card.id)
      const updated = getCard(card.id)
      emit(card.board_id, 'card', updated)
      reviewEvent(updated, 'approved', {
        note,
        delivery_id: delivery?.id ?? null,
        ...(confirmed ? { confirmed: true } : {}),
      })
      if (wantShip) {
        if (gate.warn) logEvent(card.id, null, 'autoship_note', { warn: gate.warn })
        const board = db.prepare(`SELECT * FROM boards WHERE id=?`).get(card.board_id) as any
        if (!autoshipIntent) throw new Error('accepted delivery autoship intent is missing')
        shipFor(board).enqueue({
          boardId: card.board_id,
          cardId: card.id,
          branch: card.branch,
          title: card.title,
          sourceCommit: autoshipIntent.source_commit,
          worktree: cardWorktree(autoshipIntent.source_repository, card.id),
        })
      }
      const unlocked = card.milestone_id != null && card.step_order != null
        ? db.prepare(`SELECT id, title, column_name FROM cards WHERE milestone_id=? AND step_order > ? ORDER BY step_order LIMIT 1`)
            .get(card.milestone_id, card.step_order) ?? null
        : null
      return { card: updated, decision, unlocked }
    })

  server.post<{ Params: { id: string }; Body: { note: string } }>(
    '/api/v1/cards/:id/send-back', async (req, reply) => {
      if (!requireOperator(req, reply)) return
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      if (card.column !== 'review') return reply.code(409).send({ error: 'card is not in review' })
      const note = req.body?.note?.trim()
      if (!note) return reply.code(400).send({ error: 'send-back requires a note for the agent' })
      let delivery
      try {
        delivery = deliveryLifecycle.reject({ cardId: card.id, actor: 'human', summary: note, reason: note })
      } catch (error) {
        return deliveryFailure(error, reply)
      }
      const decision = recordDecision(db, card, 'send_back', note)
      logEvent(card.id, null, 'review_decision', { decision: 'send_back', note, delivery_id: delivery?.id ?? null })
      db.prepare(`UPDATE cards SET column_name='in_progress', updated_at=datetime('now') WHERE id=?`).run(card.id)
      const updated = getCard(card.id)
      emit(card.board_id, 'card', updated)
      // the reviewer's note reaches the agent through the normal message flow
      if (updated.owner_agent_id) {
        const body = `Review feedback on card #${card.id} "${card.title}": ${note} — the card is back in in_progress; address the feedback and move it to review again when ready.`
        const { lastInsertRowid } = db.prepare(`
          INSERT INTO messages (board_id, to_agent_id, card_id, kind, body) VALUES (?, ?, ?, 'task', ?)`)
          .run(card.board_id, updated.owner_agent_id, card.id, body)
        let msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(lastInsertRowid)) as any
        if (maestro?.isHired(updated.owner_agent_id) && maestro.deliver(updated.owner_agent_id, { ...msg, from_name: null })) {
          db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`).run(msg.id, updated.owner_agent_id)
          db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`).run(msg.id)
          msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(msg.id)
        }
        emit(card.board_id, 'message', msg)
      }
      reviewEvent(updated, 'sent_back', { note, delivery_id: delivery?.id ?? null })
      return { card: updated, decision }
    })

  server.get<{ Params: { id: string } }>('/api/v1/cards/:id/reviews', (req) =>
    listCardDecisions(db, Number(req.params.id)))

  server.get<{ Params: { id: string } }>('/api/v1/boards/:id/reviews', (req) =>
    listBoardDecisions(db, Number(req.params.id)))

  server.post<{ Body: { board_id: number; title: string; description?: string } }>('/api/v1/milestones', (req) => {
    const { board_id, title, description = '' } = req.body
    const { lastInsertRowid } = db.prepare(`INSERT INTO milestones (board_id, title, description) VALUES (?, ?, ?)`)
      .run(board_id, title, description)
    const m = db.prepare(`SELECT * FROM milestones WHERE id=?`).get(Number(lastInsertRowid))
    emit(board_id, 'milestone', m)
    return m
  })

  server.delete<{ Params: { id: string } }>('/api/v1/milestones/:id', (req, reply) => {
    const m = db.prepare(`SELECT * FROM milestones WHERE id=?`).get(Number(req.params.id)) as any
    if (!m) return reply.code(404).send({ error: 'not found' })
    db.prepare(`UPDATE cards SET milestone_id=NULL, step_order=NULL WHERE milestone_id=?`).run(m.id)
    db.prepare(`DELETE FROM milestones WHERE id=?`).run(m.id)
    emit(m.board_id, 'milestone', { deleted: m.id })
    return { ok: true }
  })

  server.post<{ Params: { id: string }; Body: { title: string; description?: string } }>(
    '/api/v1/milestones/:id/steps', (req, reply) => {
      const m = db.prepare(`SELECT * FROM milestones WHERE id=?`).get(Number(req.params.id)) as any
      if (!m) return reply.code(404).send({ error: 'not found' })
      const next = (db.prepare(`SELECT COALESCE(MAX(step_order), 0) AS mx FROM cards WHERE milestone_id=?`).get(m.id) as any).mx + 1
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO cards (board_id, title, description, column_name, milestone_id, step_order)
        VALUES (?, ?, ?, 'backlog', ?, ?)`)
        .run(m.board_id, req.body.title, req.body.description ?? '', m.id, next)
      const card = getCard(Number(lastInsertRowid))
      logEvent(card.id, null, 'created', { milestone: m.title, step: next })
      emit(m.board_id, 'card', card)
      return { card }
    })

  // ── roadmap: ideas → tickets → assignment ─────────────────────────────
  const prereqNote = (card: any) => {
    const prereqs = prereqSteps(card)
    return prereqs.length
      ? ` Heads-up: earlier steps of this milestone are still open: ${prereqs.map((p) =>
          `#${p.id} "${p.title}" (${p.owner ?? 'unassigned'}, ${p.column_name})`).join('; ')}. ` +
        `They are prerequisites in spirit, not blockers — contact their owners first (orchestra ask <owner> "...") to agree boundaries and interfaces, then work in parallel where safe.`
      : ''
  }
  const assignmentBrief = (card: any) =>
    `You've been assigned card #${card.id}: "${card.title}".` +
    (card.description ? ` Scope: ${card.description}.` : '') + prereqNote(card) +
    ` Start now; keep the card updated (orchestra card update ${card.id} / orchestra card move ${card.id} <column>) and move it to done when finished.`

  // launched agents never self-report done — the daemon parks the card in review for a human
  const launchBrief = (card: any) =>
    `You've been launched on card #${card.id}: "${card.title}".` +
    (card.description ? ` Scope: ${card.description}.` : '') + prereqNote(card) +
    ` This card is already registered to you and in in_progress — do NOT create another card for this work.` +
    ` Work the ticket autonomously to completion; do not wait for human input.` +
    ` When you finish, do NOT move the card to done or review yourself — end your final message with concise "Delivery summary:" and "Evidence:" sections naming exactly what changed and the commands or artifacts that verify it; the daemon parks the card in review for human approval.` +
    ` If you cannot complete the ticket, state exactly what blocked you and stop.`

  const notifyAssignment = (card: any, agentRow: any) => {
    db.prepare(`UPDATE cards SET owner_agent_id=?, column_name='in_progress', updated_at=datetime('now') WHERE id=?`)
      .run(agentRow.id, card.id)
    const updated = getCard(card.id)
    logEvent(card.id, agentRow.id, 'updated', { assigned_to: agentRow.name })
    emit(card.board_id, 'card', updated)
    const brief = assignmentBrief(updated)
    // every assignment is a board message — the you→agent arrow shows for all agent kinds
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO messages (board_id, to_agent_id, card_id, kind, body) VALUES (?, ?, ?, 'task', ?)`)
      .run(card.board_id, agentRow.id, card.id, brief)
    let msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(lastInsertRowid)) as any
    if (maestro?.isHired(agentRow.id) && maestro.deliver(agentRow.id, { ...msg, from_name: null })) {
      db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`).run(msg.id, agentRow.id)
      db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`).run(msg.id)
      msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(msg.id)
    }
    emit(card.board_id, 'message', msg)
    return updated
  }

  server.post<{ Body: { board_id: number; text: string } }>('/api/v1/ideas', (req) => {
    const { board_id, text } = req.body
    const { lastInsertRowid } = db.prepare(`INSERT INTO ideas (board_id, text) VALUES (?, ?)`).run(board_id, text)
    const idea = db.prepare(`SELECT * FROM ideas WHERE id=?`).get(Number(lastInsertRowid))
    emit(board_id, 'idea', idea)
    return idea
  })

  server.delete<{ Params: { id: string } }>('/api/v1/ideas/:id', (req, reply) => {
    const idea = db.prepare(`SELECT * FROM ideas WHERE id=?`).get(Number(req.params.id)) as any
    if (!idea) return reply.code(404).send({ error: 'not found' })
    db.prepare(`DELETE FROM ideas WHERE id=?`).run(idea.id)
    emit(idea.board_id, 'idea', { deleted: idea.id })
    return { ok: true }
  })

  // idea becomes a ticket; optionally assigned (and briefed) in the same step
  server.post<{ Params: { id: string }; Body: { agent?: string } }>('/api/v1/ideas/:id/promote', (req, reply) => {
    const idea = db.prepare(`SELECT * FROM ideas WHERE id=?`).get(Number(req.params.id)) as any
    if (!idea) return reply.code(404).send({ error: 'not found' })
    const [title, ...rest] = idea.text.split('\n')
    const { lastInsertRowid } = db.prepare(`
      INSERT INTO cards (board_id, title, description, column_name) VALUES (?, ?, ?, 'backlog')`)
      .run(idea.board_id, title.slice(0, 200), rest.join('\n').trim())
    let card = getCard(Number(lastInsertRowid))
    logEvent(card.id, null, 'created', { from_idea: idea.id })
    db.prepare(`DELETE FROM ideas WHERE id=?`).run(idea.id)
    emit(idea.board_id, 'idea', { deleted: idea.id })
    emit(idea.board_id, 'card', card)
    const agentRow = agentByName(idea.board_id, req.body?.agent)
    if (req.body?.agent && !agentRow) return reply.code(400).send({ error: `no agent named "${req.body.agent}"` })
    if (agentRow?.name === 'strategist' || agentRow?.name.startsWith('auditor-')) return reply.code(400).send({ error: 'planner agents write tickets — they do not take them' })
    if (agentRow) card = notifyAssignment(card, agentRow)
    return { card, done_similar: doneSimilarFor(card) }
  })

  server.post<{ Params: { id: string }; Body: { agent: string } }>('/api/v1/cards/:id/assign', (req, reply) => {
    const card = getCard(Number(req.params.id))
    if (!card) return reply.code(404).send({ error: 'not found' })
    const agentRow = agentByName(card.board_id, req.body.agent)
    if (!agentRow) return reply.code(400).send({ error: `no agent named "${req.body.agent}"` })
    if (agentRow.name === 'strategist' || agentRow.name.startsWith('auditor-')) return reply.code(400).send({ error: 'planner agents write tickets — they do not take them' })
    return { card: notifyAssignment(card, agentRow) }
  })

  // launch a fresh autonomous agent directly on a ticket; queued past the concurrency cap
  server.post<{ Params: { id: string }; Body: {
    provider?: string
    model?: string
    effort?: string
    access_profile?: AccessProfile
    idempotency_key?: string
    idempotencyKey?: string
  } | null }>(
    '/api/v1/cards/:id/launch', async (req, reply) => {
    if (!requireOperator(req, reply)) return
    if (!maestro) return reply.code(501).send({ error: 'conductor not available (daemon-only feature)' })
    const card = getCard(Number(req.params.id))
    if (!card) return reply.code(404).send({ error: 'not found' })
    if (card.column === 'done') return reply.code(400).send({ error: 'card is already done' })
    if (maestro.isLaunched(card.id)) return reply.code(409).send({ error: 'card already launched or queued' })
    if (card.owner_agent_id) {
      const owner = db.prepare('SELECT name, kind, status FROM agents WHERE id=?').get(card.owner_agent_id) as
        { name: string; kind: string; status: string } | undefined
      if (maestro.isHired(card.owner_agent_id) || (owner?.kind === 'hired' && owner.status !== 'gone'))
        return reply.code(409).send({ error: `already being worked by ${owner?.name ?? card.owner}` })
    }
    if (req.body?.access_profile !== undefined && !ACCESS_PROFILES.includes(req.body.access_profile))
      return reply.code(400).send({ error: `access_profile must be one of: ${ACCESS_PROFILES.join(', ')}` })
    if (req.body?.effort !== undefined && !/^[a-zA-Z0-9_-]{1,40}$/.test(req.body.effort))
      return reply.code(400).send({ error: 'effort must be a provider effort identifier' })
    const board = db.prepare(`SELECT * FROM boards WHERE id=?`).get(card.board_id) as any
    try {
      if (process.env.ORCHESTRA_CANONICAL_LAUNCH === '1') {
        const orchestration = opts.agentOs?.orchestration
        if (!orchestration) throw new UnsupportedError('canonical orchestration service is not available')
        const provider = (req.body?.provider ?? defaultsForRole(db).provider).trim().toLowerCase()
        if (provider !== 'claude' && provider !== CODEX_PROVIDER_ID) {
          throw new ProviderUnavailableError(provider, 'no registered Agent OS agent provider driver')
        }
        const jobExecutor = opts.agentOs?.jobExecutor
        if (!jobExecutor) throw new UnsupportedError('canonical orchestration job executor is not available')
        if (!jobExecutor.supportedProviders().includes(provider)) {
          throw new ProviderUnavailableError(provider, 'no registered Agent OS provider driver')
        }
        const idempotencyKey = requireIdempotencyKey({
          header: req.headers['idempotency-key'],
          rawHeaders: req.raw.rawHeaders,
          snake: req.body?.idempotency_key,
          camel: req.body?.idempotencyKey,
        })
        const launchInput = {
          cardId: card.id,
          expectedBoardId: card.board_id,
          requireLaunchable: true,
          provider,
          model: req.body?.model,
          effort: req.body?.effort,
          accessProfile: req.body?.access_profile,
          idempotencyKey,
        }
        const launched = await orchestration.launchCard(launchInput)
        const agent = launched.session?.agent_id == null ? undefined
          : db.prepare('SELECT * FROM agents WHERE id=?').get(launched.session.agent_id)
        const orchestrationEnvelope = orchestrationIdentity('canonical', launched)
        return reply.code(200).send({
          ...launched,
          delivery: { ...launched.delivery, contract_id: orchestrationEnvelope.contract_id },
          mode: 'canonical',
          orchestration: orchestrationEnvelope,
          ...(agent ? { agent } : {}),
          card: getCard(card.id),
          queued: launched.job.status === 'queued',
          provider: launched.job.provider,
        })
      }
      const launched = maestro.launch({
        boardId: card.board_id,
        cardId: card.id,
        cwd: board.project_path,
        brief: launchBrief(card),
        provider: req.body?.provider,
        model: req.body?.model,
        effort: req.body?.effort,
        accessProfile: req.body?.access_profile,
      })
      return {
        ...launched,
        mode: 'legacy',
        orchestration: orchestrationIdentity('legacy'),
      }
    } catch (error) {
      if (error instanceof ProviderUnavailableError) return reply.code(503).send({ error: error.message, provider: error.provider })
      if (error instanceof AgentOsError) return reply.code(error.statusCode).send({ error: error.message, code: error.code })
      throw error
    }
  })

  // bring a completed card back to the backlog, unowned, ready to reassign
  server.post<{ Params: { id: string } }>('/api/v1/cards/:id/restore', (req, reply) => {
    const card = getCard(Number(req.params.id))
    if (!card) return reply.code(404).send({ error: 'not found' })
    db.prepare(`UPDATE cards SET column_name='backlog', owner_agent_id=NULL, updated_at=datetime('now') WHERE id=?`).run(card.id)
    const updated = getCard(card.id)
    logEvent(card.id, null, 'restored', { from: card.column })
    emit(card.board_id, 'card', updated)
    return { card: updated }
  })

  server.get<{ Params: { id: string } }>('/api/v1/cards/:id/events', (req) =>
    db.prepare(`SELECT e.*, a.name AS agent FROM card_events e LEFT JOIN agents a ON a.id=e.agent_id WHERE card_id=? ORDER BY e.id`)
      .all(Number(req.params.id)))

  // ground-truth merge record from the integrator; thin wrapper over recordShipped (#54)
  server.post<{ Params: { id: string }; Body: { hash: string; by?: string } }>(
    '/api/v1/cards/:id/shipped', async (req, reply) => {
      const card = getCard(Number(req.params.id))
      if (!card) return reply.code(404).send({ error: 'not found' })
      if (!req.body?.hash) return reply.code(400).send({ error: 'hash required' })
      const board = db.prepare(`SELECT * FROM boards WHERE id=?`).get(card.board_id) as any
      const by = req.body.by ?? null
      const r = await recordShipped(db, server.bus, card, board.project_path,
        { hash: req.body.hash, by, agentId: agentByName(card.board_id, by ?? undefined)?.id ?? null })
      if ('error' in r) return reply.code(400).send({ error: r.error })
      return r
    })

  server.post<{ Body: { board_id: number; from?: string; to?: string; card_id?: number; body: string; reply_to?: number; kind?: MessageKind; confirm?: boolean } }>(
    '/api/v1/messages', (req, reply) => {
      const { board_id, from, card_id, body, reply_to, confirm } = req.body
      const to = req.body.to && HUMAN_RECIPIENTS.has(req.body.to.trim().toLowerCase()) ? undefined : req.body.to
      const requestedKind = req.body.kind
      if (requestedKind && !MESSAGE_KINDS.has(requestedKind))
        return reply.code(400).send({ error: `kind must be one of: ${[...MESSAGE_KINDS].join(', ')}` })
      const kind: MessageKind = reply_to ? 'reply' : (requestedKind ?? (to ? 'ask' : 'announce'))
      if (reply_to && requestedKind && requestedKind !== 'reply')
        return reply.code(400).send({ error: 'a message with reply_to must have kind "reply"' })
      if (!reply_to && kind === 'reply')
        return reply.code(400).send({ error: 'kind "reply" requires reply_to' })
      if ((kind === 'notify' || kind === 'task') && !to)
        return reply.code(400).send({ error: `kind "${kind}" requires exactly one recipient` })
      if ((kind === 'announce' || kind === 'swarm') && to)
        return reply.code(400).send({ error: `kind "${kind}" cannot have a recipient` })
      const fromA = agentByName(board_id, from), toA = agentByName(board_id, to)
      // a typo'd recipient must fail loudly, not silently become a broadcast
      if (to && !toA) return reply.code(400).send({ error: `no agent named "${to}" on this board` })
      // a gone recipient would leave the message undelivered forever — refuse up front
      if (toA && toA.status === 'gone')
        return reply.code(409).send({ error: `agent "${to}" is gone — the message would never be delivered; ask a live agent or post to the board (no --to)` })
      // a reply without an explicit recipient targets the original sender, not the whole board
      let toId = toA?.id ?? null
      if (toId === null && reply_to) {
        const orig = db.prepare(`SELECT from_agent_id FROM messages WHERE id=?`).get(reply_to) as any
        toId = orig?.from_agent_id ?? null
        // human-rooted thread: route an *operator* follow-up to the latest agent
        // participant so it reaches whoever answered, not nobody (an agent replying
        // here must not be bounced back to itself)
        if (toId === null && !fromA) {
          const last = db.prepare(`
            SELECT from_agent_id FROM messages
            WHERE reply_to=? AND from_agent_id IS NOT NULL ORDER BY id DESC LIMIT 1`).get(reply_to) as any
          toId = last?.from_agent_id ?? null
        }
      }
      // A swarm is deliberate fan-out to the agents live at send time. Snapshotting the
      // recipients prevents agents that join later from consuming stale broadcast work.
      const swarmTargets = kind === 'swarm'
        ? (db.prepare(`SELECT id FROM agents WHERE board_id=? AND status NOT IN ('gone', 'paused_limit') ORDER BY id`).all(board_id) as any[])
            .map((a) => Number(a.id)).filter((id) => id !== fromA?.id)
        : []
      if (kind === 'swarm' && confirm !== true) {
        return reply.code(409).send({
          error: `swarm would wake ${swarmTargets.length} agent${swarmTargets.length === 1 ? '' : 's'}; resend with confirm=true`,
          recipient_count: swarmTargets.length,
        })
      }
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO messages (board_id, from_agent_id, to_agent_id, card_id, kind, body, reply_to)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(board_id, fromA?.id ?? null, toId, card_id ?? null, kind, body, reply_to ?? null)
      let msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(Number(lastInsertRowid)) as any
      const addSwarmTarget = db.prepare(`INSERT INTO message_targets (message_id, agent_id) VALUES (?, ?)`)
      db.transaction(() => swarmTargets.forEach((id) => addSwarmTarget.run(msg.id, id)))()
      // hired agents get instant delivery — no waiting for a hook to fire
      const targets = new Set<number>()
      if ((kind === 'ask' || kind === 'reply' || kind === 'task') && toId && maestro?.isHired(toId)) targets.add(toId)
      if (kind === 'swarm') for (const id of swarmTargets) if (maestro?.isHired(id)) targets.add(id)
      const markDelivered = db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`)
      for (const id of targets) {
        if (maestro!.deliver(id, { ...msg, from_name: fromA?.name ?? null })) {
          markDelivered.run(msg.id, id)
          db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`).run(msg.id)
        }
      }
      if (targets.size) msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(msg.id)
      // terminal sessions get their message typed into the terminal (fire-and-forget);
      // marking delivery keeps the next hook pulse from injecting a duplicate. Failure
      // leaves the message queued for ordinary hook delivery.
      if ((kind === 'ask' || kind === 'reply' || kind === 'task') && toId && !maestro?.isHired(toId)) {
        const messageId = Number(msg.id)
        // a human chatting types plain text; only agent-to-agent traffic needs the
        // reply-routing wrapper so protocol rules still apply
        const injected = fromA
          ? formatInjectedMessage(kind, messageId, fromA.name, body, reply_to ?? null)
          : body
        void injectTerminalMessage(toId, injected).then((ok) => {
          if (!ok) return
          db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`).run(messageId, toId)
          db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`).run(messageId)
          emit(board_id, 'message', db.prepare(`SELECT * FROM messages WHERE id=?`).get(messageId))
        }).catch(() => {})
      }
      msg.recipient_count = kind === 'swarm' ? swarmTargets.length : toId ? 1 : 0
      msg.delivered_count = (db.prepare(`SELECT COUNT(*) AS c FROM deliveries WHERE message_id=?`).get(msg.id) as any).c
      emit(board_id, 'message', msg)
      return msg
    })

  server.post<{ Params: { id: string }; Body: { name?: string; cwd?: string; provider?: string; model?: string; effort?: string; role?: 'strategist' | 'auditor' | 'verifier'; ephemeral?: boolean; resumeSession?: string; permissionMode?: string; access_profile?: AccessProfile } }>(
    '/api/v1/boards/:id/hire', (req, reply) => {
      if (!requireOperator(req, reply)) return
      if (!maestro) return reply.code(501).send({ error: 'conductor not available (daemon-only feature)' })
      const board = db.prepare(`SELECT * FROM boards WHERE id=?`).get(Number(req.params.id)) as any
      if (!board) return reply.code(404).send({ error: 'not found' })
      if (req.body?.access_profile !== undefined && !ACCESS_PROFILES.includes(req.body.access_profile))
        return reply.code(400).send({ error: `access_profile must be one of: ${ACCESS_PROFILES.join(', ')}` })
      if (req.body?.effort !== undefined && !/^[a-zA-Z0-9_-]{1,40}$/.test(req.body.effort))
        return reply.code(400).send({ error: 'effort must be a provider effort identifier' })
      try {
        const agent = maestro.hire({
          boardId: board.id,
          cwd: req.body?.cwd ?? board.project_path,
          name: req.body?.name,
          provider: req.body?.provider,
          model: req.body?.model,
          effort: req.body?.effort,
          role: req.body?.role,
          ephemeral: req.body?.ephemeral,
          // /resume revives a stopped agent with its provider-native memory intact (#44)
          resumeSession: req.body?.resumeSession,
          permissionMode: req.body?.permissionMode,
          accessProfile: req.body?.access_profile,
        })
        emit(board.id, 'agent', agent)
        return {
          ...agent,
          mode: 'ambient',
          orchestration: orchestrationIdentity('ambient'),
        }
      } catch (error) {
        if (error instanceof ProviderUnavailableError) return reply.code(503).send({ error: error.message, provider: error.provider })
        throw error
      }
    })

  // manual wake-all for limit-paused agents — same mechanics the autowake timer uses
  server.post<{ Params: { id: string } }>('/api/v1/boards/:id/wake', (req, reply) => {
    if (!maestro?.wake) return reply.code(501).send({ error: 'conductor not available (daemon-only feature)' })
    const board = db.prepare(`SELECT * FROM boards WHERE id=?`).get(Number(req.params.id)) as any
    if (!board) return reply.code(404).send({ error: 'not found' })
    return maestro.wake(board.id)
  })

  server.post<{ Params: { id: string }; Body: { text: string } }>(
    '/api/v1/agents/:id/task', (req, reply) => {
      if (!requireOperator(req, reply)) return
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const agentId = Number(req.params.id)
      const ok = maestro.task(agentId, req.body.text)
      const managed = ok ? db.prepare(`SELECT j.id AS job_id,
          COALESCE(s.workspace_id, j.workspace_id) AS workspace_id, s.id AS session_id,
          j.job_assignment_id, j.assigned_profile_id, j.assignment_market_version
        FROM agents a JOIN jobs j ON a.session_id=('agent-os:' || j.id)
        JOIN agent_sessions s ON s.agent_id=a.id
          AND j.id=coalesce(
            s.job_id,
            CASE WHEN json_valid(s.context_json) THEN json_extract(s.context_json, '$.job_id') END
          )
          AND (j.workspace_id IS NULL OR s.workspace_id=j.workspace_id)
          AND (
            (
              j.job_assignment_id IS NULL
              AND j.assigned_profile_id IS NULL
              AND j.assignment_market_version IS NULL
              AND s.job_assignment_id IS NULL
              AND s.assigned_profile_id IS NULL
              AND s.assignment_market_version IS NULL
            )
            OR
            (
              j.job_assignment_id IS NOT NULL
              AND s.job_id=j.id
              AND s.job_assignment_id=j.job_assignment_id
              AND s.assigned_profile_id=j.assigned_profile_id
              AND s.assignment_market_version=j.assignment_market_version
              AND s.workspace_id=j.workspace_id
              AND s.profile_id=j.assigned_profile_id
              AND s.conversation_id IS NOT NULL
              AND s.external_id IS NOT NULL
            )
          )
        WHERE a.id=? ORDER BY s.updated_at DESC, s.rowid DESC LIMIT 1`).get(agentId) as {
          job_id: string
          workspace_id: string | null
          session_id: string | null
          job_assignment_id: string | null
          assigned_profile_id: string | null
          assignment_market_version: number | null
        } | undefined : undefined
      const legacy = ok && !managed && db.prepare(`SELECT 1 FROM cards c
        JOIN card_events e ON e.card_id=c.id AND e.agent_id=? AND e.type='launched'
        WHERE c.owner_agent_id=? AND c.column_name='in_progress' LIMIT 1`).get(agentId, agentId)
      const mode = managed ? 'canonical' : legacy ? 'legacy' : 'ambient'
      return ok ? {
        ok: true,
        mode,
        orchestration: orchestrationIdentity(mode, managed ? {
          job: {
            id: managed.job_id,
            workspace_id: managed.workspace_id,
            job_assignment_id: managed.job_assignment_id,
            assigned_profile_id: managed.assigned_profile_id,
            assignment_market_version: managed.assignment_market_version,
          },
          session: managed.session_id ? { id: managed.session_id } : null,
        } : {}),
      } : reply.code(404).send({ error: 'not a hired agent' })
    })

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/interrupt', async (req, reply) => {
    if (!requireOperator(req, reply)) return
    if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
    const ok = await maestro.interruptAgent(Number(req.params.id))
    return ok ? { ok: true } : reply.code(404).send({ error: 'not a hired agent' })
  })

  server.post<{ Params: { id: string } }>('/api/v1/agents/:id/fire', async (req, reply) => {
    if (!requireOperator(req, reply)) return
    if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
    const ok = await maestro.fire(Number(req.params.id))
    return ok ? { ok: true } : reply.code(404).send({ error: 'not a hired agent' })
  })

  // live-switch a hired agent's permission mode (persisted for daemon-restart resume)
  const PERMISSION_MODES = ['default', 'bypassPermissions', 'acceptEdits', 'plan']
  server.post<{ Params: { id: string }; Body: { mode?: string } | null }>(
    '/api/v1/agents/:id/permission-mode', async (req, reply) => {
      if (!requireOperator(req, reply)) return
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const mode = req.body?.mode ?? ''
      if (!PERMISSION_MODES.includes(mode)) return reply.code(400).send({ error: `mode must be one of: ${PERMISSION_MODES.join(', ')}` })
      const ok = (await maestro.setPermissionMode?.(Number(req.params.id), mode)) ?? false
      return ok ? { ok: true, mode } : reply.code(404).send({ error: 'not a hired agent' })
    })

  server.post<{ Params: { id: string }; Body: { profile?: AccessProfile } | null }>(
    '/api/v1/agents/:id/access-profile', async (req, reply) => {
      if (!requireOperator(req, reply)) return
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const profile = req.body?.profile
      if (!profile || !ACCESS_PROFILES.includes(profile))
        return reply.code(400).send({ error: `profile must be one of: ${ACCESS_PROFILES.join(', ')}` })
      const ok = (await maestro.setAccessProfile?.(Number(req.params.id), profile)) ?? false
      return ok ? { ok: true, profile } : reply.code(404).send({ error: 'not a hired agent' })
    })

  // answer a pending canUseTool ask surfaced in the terminal
  server.post<{ Params: { id: string; requestId: string }; Body: { behavior?: string; message?: string; answers?: Record<string, unknown> } | null }>(
    '/api/v1/agents/:id/permissions/:requestId', async (req, reply) => {
      if (!requireOperator(req, reply)) return
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const behavior = req.body?.behavior
      if (behavior !== 'allow' && behavior !== 'deny') return reply.code(400).send({ error: `behavior must be 'allow' or 'deny'` })
      const rawAnswers = req.body?.answers
      if (rawAnswers !== undefined && (
        !rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)
        || Object.keys(rawAnswers).length > 50
        || Object.values(rawAnswers).some((value) => !Array.isArray(value)
          || value.length > 50
          || value.some((answer) => typeof answer !== 'string' || answer.length > 8_000))
      )) return reply.code(400).send({ error: 'answers must map question ids to bounded string arrays' })
      const ok = (await maestro.resolvePermission?.(
        Number(req.params.id),
        req.params.requestId,
        behavior,
        req.body?.message,
        rawAnswers as Record<string, string[]> | undefined,
      )) ?? false
      return ok ? { ok: true } : reply.code(404).send({ error: 'no pending permission request with that id' })
    })

  server.post<{ Params: { id: string; requestId: string }; Body: { decision?: string; message?: string; answers?: Record<string, unknown> } | null }>(
    '/api/v1/agents/:id/approvals/:requestId', async (req, reply) => {
      if (!requireOperator(req, reply)) return
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const decision = req.body?.decision
      const decisions = ['allow', 'allow_session', 'deny', 'cancel'] as const
      if (!decision || !decisions.includes(decision as (typeof decisions)[number]))
        return reply.code(400).send({ error: `decision must be one of: ${decisions.join(', ')}` })
      const rawAnswers = req.body?.answers
      if (rawAnswers !== undefined && (
        !rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)
        || Object.keys(rawAnswers).length > 50
        || Object.values(rawAnswers).some((value) => !Array.isArray(value)
          || value.length > 50
          || value.some((answer) => typeof answer !== 'string' || answer.length > 8_000))
      )) return reply.code(400).send({ error: 'answers must map question ids to bounded string arrays' })
      const ok = (await maestro.resolveApproval?.(
        Number(req.params.id),
        req.params.requestId,
        decision as (typeof decisions)[number],
        req.body?.message,
        rawAnswers as Record<string, string[]> | undefined,
      )) ?? false
      return ok ? { ok: true, decision } : reply.code(404).send({ error: 'no compatible pending approval request with that id' })
    })

  // live-switch a hired agent's model — applies from the next turn (persisted for restart resume)
  server.post<{ Params: { id: string }; Body: { model?: string } | null }>(
    '/api/v1/agents/:id/model', async (req, reply) => {
      if (!requireOperator(req, reply)) return
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const model = req.body?.model
      if (!model || typeof model !== 'string') return reply.code(400).send({ error: 'model is required' })
      const ok = (await maestro.setModel?.(Number(req.params.id), model)) ?? false
      return ok ? { ok: true, model } : reply.code(404).send({ error: 'not a hired agent' })
    })

  // change reasoning effort — a spawn param, so the daemon restarts the session with resume;
  // 409 while a turn is running, mirroring the launch gate
  server.post<{ Params: { id: string }; Body: { level?: string } | null }>(
    '/api/v1/agents/:id/effort', async (req, reply) => {
      if (!requireOperator(req, reply)) return
      if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
      const level = req.body?.level ?? ''
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(level)) return reply.code(400).send({ error: 'level must be a provider effort identifier' })
      const r = (await maestro.setEffort?.(Number(req.params.id), level)) ?? 'not-found'
      if (r === 'ok') return { ok: true, level }
      if (r === 'busy') return reply.code(409).send({ error: 'agent is mid-turn — wait or interrupt, then retry' })
      if (r === 'no-session') return reply.code(409).send({ error: 'agent has no resumable session yet — send a first prompt before changing effort' })
      if (r === 'bad-level') return reply.code(400).send({ error: `level ${level} is not supported by this provider` })
      return reply.code(404).send({ error: 'not a hired agent' })
    })

  server.get<{ Params: { id: string } }>('/api/v1/agents/:id/transcript', (req, reply) => {
    if (!requireOperator(req, reply)) return
    const id = Number(req.params.id)
    const hired = maestro?.transcript(id)
    // `info` only exists for live hired sessions; anything else falls back to the
    // read-only tail of the agent's own terminal transcript (hooks-reported path)
    if (hired && (hired as { info?: unknown }).info) return hired
    const external = externalTranscripts.transcript(id)
    if (external.lines.length > 0) return { lines: external.lines, working: null, external: true }
    if (!maestro) return reply.code(501).send({ error: 'conductor not available' })
    return hired ?? { lines: [], working: null }
  })

  const inboxSql = `
    SELECT m.*, fa.name AS from_name FROM messages m
    LEFT JOIN agents fa ON fa.id = m.from_agent_id
    WHERE m.board_id = ? AND (m.from_agent_id IS NULL OR m.from_agent_id != ?)
      AND (m.to_agent_id = ?
           OR m.reply_to IN (SELECT id FROM messages WHERE from_agent_id = ?)
           OR (m.kind = 'swarm' AND EXISTS (
             SELECT 1 FROM message_targets mt WHERE mt.message_id=m.id AND mt.agent_id=?)))`

  server.get<{ Params: { id: string } }>('/api/v1/agents/:id/inbox', (req) => {
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(Number(req.params.id)) as any
    return db.prepare(inboxSql + ' ORDER BY m.id').all(a.board_id, a.id, a.id, a.id, a.id)
  })

  server.delete<{ Params: { id: string } }>('/api/v1/messages/:id', (req, reply) => {
    const id = Number(req.params.id)
    const msg = db.prepare(`SELECT * FROM messages WHERE id=?`).get(id) as any
    if (!msg) return reply.code(404).send({ error: 'not found' })
    db.prepare(`DELETE FROM deliveries WHERE message_id=? OR message_id IN (SELECT id FROM messages WHERE reply_to=?)`).run(id, id)
    db.prepare(`DELETE FROM message_targets WHERE message_id=? OR message_id IN (SELECT id FROM messages WHERE reply_to=?)`).run(id, id)
    db.prepare(`DELETE FROM messages WHERE reply_to=?`).run(id)
    db.prepare(`DELETE FROM messages WHERE id=?`).run(id)
    emit(msg.board_id, 'message', { deleted: id })
    return { ok: true }
  })

  server.delete<{ Params: { id: string } }>('/api/v1/cards/:id', (req, reply) => {
    const card = db.prepare(`SELECT * FROM cards WHERE id=?`).get(Number(req.params.id)) as any
    if (!card) return reply.code(404).send({ error: 'not found' })
    db.prepare(`DELETE FROM card_events WHERE card_id=?`).run(card.id)
    db.prepare(`UPDATE messages SET card_id=NULL WHERE card_id=?`).run(card.id)
    db.prepare(`DELETE FROM cards WHERE id=?`).run(card.id)
    emit(card.board_id, 'card', { deleted: card.id })
    return { ok: true }
  })

  server.delete<{ Params: { id: string } }>('/api/v1/agents/:id', (req, reply) => {
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(Number(req.params.id)) as any
    if (!a) return reply.code(404).send({ error: 'not found' })
    db.prepare(`UPDATE cards SET owner_agent_id=NULL WHERE owner_agent_id=?`).run(a.id)
    db.prepare(`DELETE FROM agents WHERE id=?`).run(a.id)
    emit(a.board_id, 'agent', { deleted: a.id })
    return { ok: true }
  })

  server.delete<{ Params: { id: string } }>('/api/v1/boards/:id', (req, reply) => {
    const id = Number(req.params.id)
    if (!db.prepare(`SELECT 1 FROM boards WHERE id=?`).get(id)) return reply.code(404).send({ error: 'not found' })
    db.prepare(`DELETE FROM deliveries WHERE message_id IN (SELECT id FROM messages WHERE board_id=?)`).run(id)
    db.prepare(`DELETE FROM message_targets WHERE message_id IN (SELECT id FROM messages WHERE board_id=?)`).run(id)
    db.prepare(`DELETE FROM messages WHERE board_id=?`).run(id)
    db.prepare(`DELETE FROM card_events WHERE card_id IN (SELECT id FROM cards WHERE board_id=?)`).run(id)
    db.prepare(`DELETE FROM cards WHERE board_id=?`).run(id)
    db.prepare(`DELETE FROM agents WHERE board_id=?`).run(id)
    db.prepare(`DELETE FROM boards WHERE id=?`).run(id)
    emit(id, 'board', { deleted: id })
    return { ok: true }
  })

  server.post<{ Params: { id: string }; Body: { key?: string; state?: string; provider?: string; session_id?: string; session_token?: string } }>('/api/v1/agents/:id/subping', (req, reply) => {
    const id = Number(req.params.id)
    const a = hookAgent(id, req.body)
    if (!a) return reply.code(403).send({ error: 'hook session identity does not match this agent' })
    if (!termSubs.has(id)) termSubs.set(id, new Map())
    const key = String(req.body?.key ?? 'sub')
    if (req.body?.state === 'stopped') termSubs.get(id)!.delete(key)
    else termSubs.get(id)!.set(key, Date.now())
    emit(a.board_id, 'agent', { id, subs: termSubs.get(id)!.size > 0 })
    return { ok: true }
  })

  server.post<{ Params: { id: string }; Body: { telemetry?: TelemetryEntry[]; provider?: string; session_id?: string; session_token?: string; transcript_path?: string } | null }>('/api/v1/agents/:id/heartbeat', (req, reply) => {
    const id = Number(req.params.id)
    const a = hookAgent(id, req.body)
    if (!a) return reply.code(403).send({ error: 'hook session identity does not match this agent' })
    db.prepare(`UPDATE agents SET status='active', last_seen=datetime('now') WHERE id=?`).run(id)
    if (req.body?.telemetry) recordTelemetry(db, a.board_id, a.id, req.body.telemetry)
    if (req.body?.transcript_path) externalTranscripts.track(id, req.body.transcript_path)
    const updated = db.prepare(`SELECT * FROM agents WHERE id=?`).get(id)
    emit(a.board_id, 'agent', updated)
    return updated
  })

  server.post<{ Params: { id: string }; Body: { telemetry?: TelemetryEntry[]; provider?: string; session_id?: string; session_token?: string; transcript_path?: string } | null }>('/api/v1/agents/:id/pulse', (req, reply) => {
    const a = hookAgent(Number(req.params.id), req.body)
    if (!a) return reply.code(403).send({ error: 'hook session identity does not match this agent' })
    db.prepare(`UPDATE agents SET status='active', last_seen=datetime('now') WHERE id=?`).run(a.id)
    if (req.body?.telemetry) recordTelemetry(db, a.board_id, a.id, req.body.telemetry)
    if (req.body?.transcript_path) externalTranscripts.track(a.id, req.body.transcript_path)
    // per-recipient delivery: one agent consuming a broadcast must not hide it from the others
    const messages = db.prepare(inboxSql +
      ` AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.agent_id = ?) ORDER BY m.id`)
      .all(a.board_id, a.id, a.id, a.id, a.id, a.id) as any[]
    const mark = db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`)
    const stamp = db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`)
    db.transaction(() => messages.forEach((m) => { mark.run(m.id, a.id); stamp.run(m.id) }))()
    emit(a.board_id, 'agent', db.prepare(`SELECT * FROM agents WHERE id=?`).get(a.id))
    return { agent: a, messages }
  })

  server.post<{ Params: { id: string }; Body: { telemetry?: TelemetryEntry[]; provider?: string; session_id?: string; session_token?: string } | null }>('/api/v1/agents/:id/leave', (req, reply) => {
    const id = Number(req.params.id)
    const bound = hookAgent(id, req.body)
    if (!bound) return reply.code(403).send({ error: 'hook session identity does not match this agent' })
    if (req.body?.telemetry) recordTelemetry(db, bound.board_id, id, req.body.telemetry)
    removeAgentCards(db, id) // gone agents leave a clean board
    db.prepare(`UPDATE agents SET status='gone' WHERE id=?`).run(id)
    const a = db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as any
    for (const bounce of bounceDeadLetters(db, id) as any[]) {
      // hired senders hear the bounce immediately; session senders get it on next pulse
      const sender = bounce.to_agent_id
      if (sender && maestro?.isHired(sender) && maestro.deliver(sender, { ...bounce, from_name: null })) {
        db.prepare(`INSERT OR IGNORE INTO deliveries (message_id, agent_id) VALUES (?, ?)`).run(bounce.id, sender)
        db.prepare(`UPDATE messages SET delivered_at=coalesce(delivered_at, datetime('now')) WHERE id=?`).run(bounce.id)
      }
      emit(a.board_id, 'message', bounce)
    }
    emit(a.board_id, 'agent', a)
    emit(a.board_id, 'card', { pruned: id })
    return a
  })

  // one global stream — browsers cap per-host connections, so per-board streams starve the app
  server.get('/api/v1/events', (req, reply) => {
    if (!requireOperator(req, reply)) return
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache', connection: 'keep-alive',
    })
    const onEvent = (e: unknown) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    server.bus.on('event', onEvent)
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    req.raw.on('close', () => { server.bus.off('event', onEvent); clearInterval(ping) })
  })

  server.get<{ Params: { id: string } }>('/api/v1/boards/:id/events', (req, reply) => {
    if (!requireOperator(req, reply)) return
    const boardId = Number(req.params.id)
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache', connection: 'keep-alive',
    })
    const onEvent = (e: { board_id: number; type: string; data: unknown }) => {
      if (e.board_id === boardId) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`)
    }
    server.bus.on('event', onEvent)
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000)
    req.raw.on('close', () => { server.bus.off('event', onEvent); clearInterval(ping) })
  })

  registerAgentOsServerComposition(server, {
    db,
    host: maestro,
    agentOs: opts.agentOs,
    isOperator: (request) => request.orchestraPrincipal === 'operator',
  })
  registerCompatibilityReadObserver(server, db)

  // static web UI (built by Task 13; 404s harmlessly before that)
  const webDist = opts.webDist ?? fileURLToPath(new URL('../web/dist', import.meta.url))
  if (fs.existsSync(webDist)) {
    server.register(import('@fastify/static'), {
      root: webDist,
      // build precompresses .br/.gz siblings (web/scripts/compress-dist.mjs)
      preCompressed: true,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        // vite content-hashes everything under assets/, so those never change in place;
        // the shell (index.html, sw.js, manifest) must revalidate every load
        const immutable = /[\\/]assets[\\/]/.test(filePath)
        res.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    })
  }

  return server
}

// one human-readable line per feed item; payloads are stored as JSON strings
function timelineSummary(r: { source: string; type: string; agent: string | null; card_title: string | null; detail: string | null; peer: string | null }): string {
  const clip = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  if (r.source === 'message') return clip(`${r.agent ?? 'human'} → ${r.peer ?? 'all'}: ${r.detail ?? ''}`)
  if (r.source === 'review') return clip(`${r.type === 'approve' ? 'approved' : 'sent back'} "${r.card_title ?? '?'}"${r.detail ? ` — ${r.detail}` : ''}`)
  if (r.source === 'milestone') return clip(`milestone "${r.card_title ?? ''}"${r.detail ? ` — ${r.detail}` : ''}`)
  let p: any = {}
  try { p = JSON.parse(r.detail ?? '{}') } catch { /* raw payload stays out of the summary */ }
  const title = r.card_title ? `"${r.card_title}"` : ''
  if (r.type === 'created') return clip(`created ${title}`)
  if (r.type === 'moved') return clip(`moved ${title}${p.from ? ` ${p.from}` : ''}${p.to ? ` → ${p.to}` : ''}`)
  if (r.type === 'shipped') return clip(`shipped ${title}${p.hash ? ` @ ${String(p.hash).slice(0, 7)}` : ''}${p.subject ? ` — ${p.subject}` : ''}`)
  return clip(`${r.type} ${title}`)
}

export function listThreads(db: Database.Database, boardId: number) {
  const msgs = db.prepare(`
    SELECT m.*, fa.name AS from_name, ta.name AS to_name,
      CASE WHEN m.to_agent_id IS NOT NULL THEN 1 ELSE
        (SELECT COUNT(*) FROM message_targets mt WHERE mt.message_id=m.id) END AS recipient_count,
      (SELECT COUNT(*) FROM deliveries d WHERE d.message_id=m.id) AS delivered_count
    FROM messages m
    LEFT JOIN agents fa ON fa.id = m.from_agent_id
    LEFT JOIN agents ta ON ta.id = m.to_agent_id
    WHERE m.board_id=? ORDER BY m.id`).all(boardId) as any[]
  return msgs
    .filter((m) => !m.reply_to)
    .map((root) => {
      const replies = msgs.filter((r) => r.reply_to === root.id)
      return { ...root, replies, answered: replies.length > 0 }
    })
    .reverse() // newest thread first
}

export function listCards(db: Database.Database, boardId: number) {
  return (db.prepare(`
    SELECT c.*, a.name AS owner FROM cards c
    LEFT JOIN agents a ON a.id = c.owner_agent_id
    WHERE c.board_id=? ORDER BY c.updated_at DESC`).all(boardId) as any[])
    .map((c) => ({ ...c, column: c.column_name, paths: JSON.parse(c.paths) }))
}
