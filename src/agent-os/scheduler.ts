import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { AttentionService } from './attention.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { optionalInteger, parseJson, timestamp } from './json.js'

export type JobStatus = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'blocked' | 'cancelled'

export interface Job {
  id: string
  board_id: number
  card_id: number | null
  workspace_id: string | null
  provider: string
  driver_id: string
  model: string | null
  effort: string | null
  access_profile: 'read_only' | 'workspace_write' | 'full_access'
  policy_id: string | null
  contract_version: number | null
  idempotency_key: string | null
  priority: number
  status: JobStatus
  attempts: number
  max_attempts: number
  budget_tokens: number | null
  budget_cents: number | null
  spent_tokens: number
  spent_cents: number
  scheduled_at: string
  started_at: string | null
  finished_at: string | null
  error: string | null
  created_at: string
}

export interface CreateJob {
  boardId: number
  cardId?: number | null
  workspaceId?: string | null
  provider: string
  driverId?: string
  model?: string | null
  effort?: string | null
  accessProfile?: 'read_only' | 'workspace_write' | 'full_access'
  policyId?: string | null
  contractVersion?: number | null
  idempotencyKey?: string | null
  requestFingerprint?: string | null
  correlationId?: string | null
  causationId?: string | null
  priority?: number
  maxAttempts?: number
  budgetTokens?: number | null
  budgetCents?: number | null
  scheduledAt?: string
}

export interface JobExecutionResult {
  status?: 'running' | 'succeeded'
  detail?: Record<string, unknown>
}

export interface JobExecutor {
  supportedProviders(): readonly string[]
  execute(job: Job): Promise<JobExecutionResult | void>
  cancel?(job: Job): Promise<void>
}

export interface SchedulerTick {
  started: string[]
  completed: string[]
  blocked: string[]
  deferred: string[]
}

export class JobScheduler {
  private readonly events: EventStore
  private readonly attention: AttentionService
  private activeTick: Promise<SchedulerTick> | null = null

  constructor(private readonly db: Database.Database, private readonly executor?: JobExecutor) {
    this.events = new EventStore(db)
    this.attention = new AttentionService(db)
  }

  create(input: CreateJob): Job {
    this.assertScope(input.boardId, input.cardId, input.workspaceId)
    if (!input.provider?.trim()) throw new ValidationError('provider is required')
    const driverId = input.driverId?.trim() || input.provider.trim()
    if (!driverId) throw new ValidationError('driverId is required')
    const accessProfile = input.accessProfile ?? 'workspace_write'
    if (!['read_only', 'workspace_write', 'full_access'].includes(accessProfile)) {
      throw new ValidationError('accessProfile must be read_only, workspace_write, or full_access')
    }
    const priority = input.priority ?? 0
    if (!Number.isSafeInteger(priority)) throw new ValidationError('priority must be an integer')
    const maxAttempts = input.maxAttempts ?? 1
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new ValidationError('maxAttempts must be at least 1')
    const scheduledAt = input.scheduledAt ?? timestamp()
    if (Number.isNaN(Date.parse(scheduledAt))) throw new ValidationError('scheduledAt must be an ISO date')
    const row = {
      id: randomUUID(), board_id: input.boardId, card_id: input.cardId ?? null,
      workspace_id: input.workspaceId ?? null, provider: input.provider.trim(), driver_id: driverId,
      model: input.model ?? null, effort: input.effort ?? null, access_profile: accessProfile,
      policy_id: input.policyId ?? null, contract_version: input.contractVersion ?? null,
      idempotency_key: input.idempotencyKey ?? null, request_fingerprint: input.requestFingerprint ?? null,
      priority, status: 'queued', attempts: 0, max_attempts: maxAttempts,
      budget_tokens: input.budgetTokens ?? null, budget_cents: input.budgetCents ?? null,
      scheduled_at: scheduledAt, started_at: null, finished_at: null, error: null, created_at: timestamp(),
    }
    if (row.card_id && this.db.prepare(`SELECT 1 FROM jobs WHERE card_id=?
      AND status IN ('queued','running','cancelling')`).get(row.card_id)) {
      throw new ConflictError('card already has an active job')
    }
    try {
      this.db.prepare(`INSERT INTO jobs
        (id, board_id, card_id, workspace_id, provider, driver_id, model, effort, access_profile, policy_id,
         contract_version, idempotency_key, request_fingerprint, priority, status, attempts, max_attempts,
         budget_tokens, budget_cents, scheduled_at, started_at, finished_at, error, created_at)
        VALUES (@id, @board_id, @card_id, @workspace_id, @provider, @driver_id, @model, @effort,
         @access_profile, @policy_id, @contract_version, @idempotency_key, @request_fingerprint, @priority,
         @status, @attempts, @max_attempts, @budget_tokens, @budget_cents, @scheduled_at, @started_at,
         @finished_at, @error, @created_at)`)
        .run(row)
    } catch (error) {
      if (String(error).includes('card already has an active job')) throw new ConflictError('card already has an active job')
      throw error
    }
    this.events.append({ boardId: row.board_id, workspaceId: row.workspace_id, cardId: row.card_id,
      jobId: row.id, contractId: row.card_id && row.contract_version
        ? `card:${row.card_id}:v${row.contract_version}` : null,
      correlationId: input.correlationId ?? row.id, causationId: input.causationId ?? null,
      idempotencyKey: `job:${row.id}:queued`, kind: 'job.queued', source: 'scheduler',
      payload: { job_id: row.id, provider: row.provider, driver_id: row.driver_id,
        model: row.model, effort: row.effort, access_profile: row.access_profile, priority } })
    return mapJob(row)
  }

  get(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? mapJob(row) : null
  }

  listBoard(boardId: number, status?: string): Job[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM jobs WHERE board_id=? AND status=? ORDER BY priority DESC, scheduled_at, created_at').all(boardId, status)
      : this.db.prepare('SELECT * FROM jobs WHERE board_id=? ORDER BY created_at DESC, rowid DESC').all(boardId)
    return (rows as Record<string, unknown>[]).map(mapJob)
  }

  failBeforeLaunch(id: string, error: string): Job {
    const fail = this.db.transaction(() => {
      const job = this.get(id)
      if (!job) throw new NotFoundError('job not found')
      if (job.status !== 'queued') return job
      this.db.prepare("UPDATE jobs SET status='blocked', error=?, finished_at=? WHERE id=? AND status='queued'")
        .run(error, timestamp(), id)
      this.releaseLaunchState(job, 'failed')
      this.appendJobEvent(job, 'job.blocked', { error, before_launch: true })
      return this.get(id)!
    })
    const job = fail.immediate()
    if (job.status === 'blocked') this.attention.create({
      boardId: job.board_id, workspaceId: job.workspace_id, cardId: job.card_id,
      kind: 'job.blocked', severity: 'high', title: 'Job blocked', detail: error,
    })
    return job
  }

  async cancel(id: string): Promise<Job> {
    const job = this.get(id)
    if (!job) throw new NotFoundError('job not found')
    if (['succeeded', 'cancelled'].includes(job.status)) return job
    const beginCancellation = this.db.transaction(() => {
      const claimed = this.db.prepare(`UPDATE jobs SET status='cancelling', error=NULL
        WHERE id=? AND status IN ('queued','running','blocked','cancelling')`).run(id)
      if (claimed.changes === 1) this.appendJobEvent(job, 'job.cancelling', {})
      return claimed.changes
    })
    if (beginCancellation.immediate() !== 1) return this.get(id)!
    try {
      if (job.status === 'running' || job.status === 'cancelling') await this.executor?.cancel?.(job)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.db.prepare("UPDATE jobs SET error=? WHERE id=? AND status='cancelling'").run(`cancellation not confirmed: ${detail}`, id)
      this.attention.create({ boardId: job.board_id, workspaceId: job.workspace_id, cardId: job.card_id,
        kind: 'job.cancellation_failed', severity: 'critical', title: 'Job cancellation needs attention', detail })
      throw error
    }
    const at = timestamp()
    const finalize = this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status='cancelled', finished_at=?, error=NULL WHERE id=? AND status='cancelling'").run(at, id)
      this.releaseLaunchState(job, 'released')
      this.appendJobEvent(job, 'job.cancelled', {})
    })
    finalize.immediate()
    return this.get(id)!
  }

  async tick(): Promise<SchedulerTick> {
    if (this.activeTick) return this.activeTick
    const running = this.runTick()
    const wrapped = running.finally(() => {
      if (this.activeTick === wrapped) this.activeTick = null
    })
    this.activeTick = wrapped
    return wrapped
  }

  private async runTick(): Promise<SchedulerTick> {
    const result: SchedulerTick = { started: [], completed: [], blocked: [], deferred: [] }
    const queued = (this.db.prepare(`SELECT * FROM jobs WHERE status='queued' AND scheduled_at<=?
      ORDER BY priority DESC, scheduled_at ASC, created_at ASC`).all(timestamp()) as Record<string, unknown>[]).map(mapJob)

    for (const job of queued) {
      if (!this.supports(job.driver_id)) {
        const error = `provider ${job.provider} is unavailable; install or enable its driver`
        this.db.prepare('UPDATE jobs SET error=? WHERE id=?').run(error, job.id)
        this.attention.create({ boardId: job.board_id, workspaceId: job.workspace_id, cardId: job.card_id,
          kind: 'job.unsupported_provider', severity: 'high', title: `Job needs the ${job.provider} driver`, detail: error })
        result.deferred.push(job.id)
        continue
      }
      const dependency = this.dependencyState(job)
      if (dependency === 'waiting') { result.deferred.push(job.id); continue }
      if (dependency === 'invalid') { this.block(job, 'one or more dependencies no longer exist'); result.blocked.push(job.id); continue }
      if ((job.budget_tokens !== null && job.spent_tokens >= job.budget_tokens) ||
          (job.budget_cents !== null && job.spent_cents >= job.budget_cents)) {
        this.block(job, 'job budget is exhausted before launch'); result.blocked.push(job.id); continue
      }

      const claim = this.claim(job.id)
      if (claim === 'capacity') { result.deferred.push(job.id); break }
      if (claim === 'workspace') { result.deferred.push(job.id); continue }
      if (claim !== 'claimed') continue
      result.started.push(job.id)
      const active = this.get(job.id)!
      try {
        const execution = await this.executor!.execute(active)
        if (execution?.status === 'running') continue
        const completed = this.complete(active.id, undefined, execution?.detail)
        if (completed.status === 'succeeded') result.completed.push(active.id)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const current = this.get(active.id)
        if (current?.status !== 'running') continue
        const completed = this.complete(active.id, detail)
        if (completed.status === 'blocked') result.blocked.push(active.id)
        else if (completed.status === 'queued') result.deferred.push(active.id)
      }
    }
    return result
  }

  complete(id: string, error?: string, detail: Record<string, unknown> = {}): Job {
    const finish = this.db.transaction(() => {
      const job = this.get(id)
      if (!job) throw new NotFoundError('job not found')
      if (job.status !== 'running') throw new ConflictError('only a running job can be completed')
      const retry = Boolean(error) && job.attempts < job.max_attempts
      const status = retry ? 'queued' : error ? 'blocked' : 'succeeded'
      const updated = this.db.prepare(`UPDATE jobs SET status=?, error=?, finished_at=?
        WHERE id=? AND status='running'`).run(status, error ?? null, retry ? null : timestamp(), id)
      if (updated.changes !== 1) return this.get(id)!
      this.releaseLaunchState(job, retry ? 'reserved' : error ? 'failed' : 'released')
      this.appendJobEvent(job, retry ? 'job.retry_queued' : error ? 'job.blocked' : 'job.succeeded',
        { error, attempt: job.attempts, ...detail })
      return this.get(id)!
    })
    const completed = finish.immediate()
    const job = completed
    const retry = job.status === 'queued'
    if (error && !retry) this.attention.create({ boardId: job.board_id, workspaceId: job.workspace_id, cardId: job.card_id,
      kind: 'job.blocked', severity: 'high', title: 'Job blocked', detail: error })
    return completed
  }

  recover(id: string, error: string): Job {
    const job = this.get(id)
    if (!job) throw new NotFoundError('job not found')
    if (job.status === 'cancelling') {
      const recover = this.db.transaction(() => {
        this.db.prepare("UPDATE jobs SET status='cancelled', error=NULL, finished_at=? WHERE id=?").run(timestamp(), id)
        this.releaseLaunchState(job, 'released')
        this.appendJobEvent(job, 'job.cancelled', { recovered: true }, 'recovery')
      })
      recover.immediate()
      return this.get(id)!
    }
    if (job.status !== 'running') return job
    return this.complete(id, error, { recovered: true })
  }

  recordUsage(id: string, tokens: number, cents: number): Job {
    const safeTokens = Number.isFinite(tokens) ? Math.max(0, Math.floor(tokens)) : 0
    const safeCents = Number.isFinite(cents) ? Math.max(0, Math.ceil(cents)) : 0
    this.db.prepare(`UPDATE jobs SET spent_tokens=spent_tokens+?, spent_cents=spent_cents+? WHERE id=?`)
      .run(safeTokens, safeCents, id)
    const job = this.get(id)
    if (!job) throw new NotFoundError('job not found')
    return job
  }

  private supports(provider: string): boolean {
    return !!this.executor && this.executor.supportedProviders().includes(provider)
  }

  private claim(id: string): 'claimed' | 'capacity' | 'workspace' | 'stale' {
    const reserve = this.db.transaction(() => {
      const current = this.db.prepare(`SELECT j.status, j.workspace_id, w.status AS workspace_status,
        wa.isolation_mode FROM jobs j
        LEFT JOIN workspaces w ON w.id=j.workspace_id
        LEFT JOIN workspace_assignments wa ON wa.job_id=j.id WHERE j.id=?`).get(id) as {
          status: string
          workspace_id: string | null
          workspace_status: string | null
          isolation_mode: string | null
        } | undefined
      if (current?.status !== 'queued') return 'stale' as const
      if (current.isolation_mode && current.workspace_status !== 'active') return 'workspace' as const
      if (current.isolation_mode && current.workspace_id
        && this.db.prepare(`SELECT 1 FROM workspace_assignments
          WHERE workspace_id=? AND job_id!=? AND status='active' LIMIT 1`).get(current.workspace_id, id)) {
        return 'workspace' as const
      }
      const running = (this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('running','cancelling')")
        .get() as { count: number }).count
      const legacyLaunched = (this.db.prepare(`SELECT COUNT(DISTINCT a.id) AS count
        FROM agents a JOIN cards c ON c.owner_agent_id=a.id
        WHERE a.kind='hired' AND a.status NOT IN ('gone','paused_limit') AND c.column_name='in_progress'
          AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.agent_id=a.id AND s.status IN ('starting','running','idle'))`)
        .get() as { count: number }).count
      if (running + legacyLaunched >= this.maxLaunched()) return 'capacity' as const
      const claimed = this.db.prepare(`UPDATE jobs SET status='running', attempts=attempts+1,
        started_at=?, finished_at=NULL, error=NULL WHERE id=? AND status='queued'`).run(timestamp(), id)
      if (claimed.changes !== 1) return 'stale' as const
      const job = this.get(id)!
      this.db.prepare("UPDATE workspace_assignments SET status='active', updated_at=? WHERE job_id=? AND status='reserved'")
        .run(timestamp(), id)
      const assignment = this.db.prepare('SELECT id FROM workspace_assignments WHERE job_id=?').get(id) as
        { id: string } | undefined
      if (assignment) this.appendJobEvent(job, 'workspace.assignment_activated', { assignment_id: assignment.id })
      this.db.prepare(`UPDATE agent_sessions SET status='starting', updated_at=?
        WHERE json_valid(context_json) AND json_extract(context_json, '$.job_id')=? AND status='reserved'`)
        .run(timestamp(), id)
      const session = this.db.prepare(`SELECT id FROM agent_sessions
        WHERE json_valid(context_json) AND json_extract(context_json, '$.job_id')=?
        ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(id) as { id: string } | undefined
      if (session) this.appendJobEvent(job, 'agent_session.starting', { session_id: session.id })
      this.appendJobEvent(job, 'job.started', { attempt: job.attempts, provider: job.provider })
      return 'claimed' as const
    })
    return reserve.immediate()
  }

  private dependencyState(job: Job): 'ready' | 'waiting' | 'invalid' {
    if (!job.card_id) return 'ready'
    const report = this.db.prepare(`SELECT asked_snapshot FROM delivery_reports
      WHERE job_id=? AND parent_report_id IS NULL ORDER BY created_at, rowid LIMIT 1`).get(job.id) as
      { asked_snapshot: string } | undefined
    const asked = parseJson<{ dependencies?: unknown }>(report?.asked_snapshot, {})
    const frozen = Array.isArray(asked.dependencies)
      ? asked.dependencies.filter((value): value is number => Number.isSafeInteger(value) && Number(value) > 0)
      : null
    const contract = frozen === null
      ? this.db.prepare('SELECT dependencies FROM task_contracts WHERE card_id=?').get(job.card_id) as
        { dependencies: string } | undefined
      : undefined
    const ids = frozen ?? parseJson<number[]>(contract?.dependencies, [])
    if (!ids.length) return 'ready'
    const placeholders = ids.map(() => '?').join(',')
    const cards = this.db.prepare(`SELECT id, column_name FROM cards WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: number; column_name: string }>
    if (cards.length !== ids.length) return 'invalid'
    return cards.every((card) => card.column_name === 'done') ? 'ready' : 'waiting'
  }

  private block(job: Job, error: string): void {
    const block = this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET status='blocked', error=?, finished_at=? WHERE id=?").run(error, timestamp(), job.id)
      this.releaseLaunchState(job, 'failed')
      this.appendJobEvent(job, 'job.blocked', { error })
    })
    block.immediate()
    this.attention.create({ boardId: job.board_id, workspaceId: job.workspace_id, cardId: job.card_id,
      kind: 'job.blocked', severity: 'high', title: 'Job blocked', detail: error })
  }

  private releaseLaunchState(job: Job, status: 'reserved' | 'released' | 'failed'): void {
    const at = timestamp()
    const assignment = this.db.prepare('SELECT id, status FROM workspace_assignments WHERE job_id=?').get(job.id) as
      { id: string; status: string } | undefined
    this.db.prepare(`UPDATE workspace_assignments SET status=?, updated_at=?, released_at=? WHERE job_id=?`)
      .run(status, at, status === 'reserved' ? null : at, job.id)
    if (assignment && assignment.status !== status) {
      this.appendJobEvent(job, status === 'reserved' ? 'workspace.assignment_reserved'
        : status === 'released' ? 'workspace.assignment_released' : 'workspace.assignment_failed',
      { assignment_id: assignment.id })
    }
    const session = this.db.prepare(`SELECT id, status FROM agent_sessions
      WHERE json_valid(context_json) AND json_extract(context_json, '$.job_id')=?
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(job.id) as
      { id: string; status: string } | undefined
    const sessionStatus = status === 'reserved' ? 'reserved' : status === 'failed' ? 'failed' : 'stopped'
    if (session && session.status !== sessionStatus) {
      this.db.prepare('UPDATE agent_sessions SET status=?, updated_at=? WHERE id=?').run(sessionStatus, at, session.id)
      this.appendJobEvent(job, `agent_session.${sessionStatus}`, { session_id: session.id })
    }
  }

  private appendJobEvent(
    job: Job,
    kind: string,
    detail: Record<string, unknown>,
    source = 'scheduler',
  ): void {
    const previous = this.db.prepare(`SELECT id, correlation_id FROM os_events
      WHERE job_id=? ORDER BY rowid DESC LIMIT 1`).get(job.id) as
      { id: string; correlation_id: string | null } | undefined
    const repeatable = new Set([
      'job.started', 'job.retry_queued', 'workspace.assignment_activated', 'workspace.assignment_reserved',
      'agent_session.starting', 'agent_session.reserved',
    ])
    const suffix = repeatable.has(kind)
      ? `:${Math.max(1, job.attempts)}` : ''
    this.events.append({
      boardId: job.board_id,
      workspaceId: job.workspace_id,
      cardId: job.card_id,
      jobId: job.id,
      contractId: job.card_id && job.contract_version ? `card:${job.card_id}:v${job.contract_version}` : null,
      correlationId: previous?.correlation_id ?? job.id,
      causationId: previous?.id ?? null,
      idempotencyKey: `job:${job.id}:${kind}${suffix}`,
      kind,
      source,
      payload: { job_id: job.id, ...detail },
    })
  }

  private maxLaunched(): number {
    const configured = Number(process.env.ORCHESTRA_MAX_LAUNCHED ?? 3)
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3
  }

  private assertScope(boardId: number, cardId?: number | null, workspaceId?: string | null): void {
    if (!this.db.prepare('SELECT 1 FROM boards WHERE id=?').get(boardId)) throw new NotFoundError('board not found')
    if (cardId) {
      const card = this.db.prepare('SELECT board_id FROM cards WHERE id=?').get(cardId) as { board_id: number } | undefined
      if (!card) throw new NotFoundError('card not found')
      if (card.board_id !== boardId) throw new ValidationError('card belongs to a different board')
    }
    if (workspaceId) {
      const workspace = this.db.prepare('SELECT board_id FROM workspaces WHERE id=?').get(workspaceId) as { board_id: number } | undefined
      if (!workspace) throw new NotFoundError('workspace not found')
      if (workspace.board_id !== boardId) throw new ValidationError('workspace belongs to a different board')
    }
  }
}

function mapJob(row: Record<string, unknown>): Job {
  const access = String(row.access_profile ?? 'workspace_write')
  return {
    id: String(row.id), board_id: Number(row.board_id), card_id: row.card_id == null ? null : Number(row.card_id),
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id), provider: String(row.provider),
    driver_id: String(row.driver_id ?? row.provider), model: row.model == null ? null : String(row.model),
    effort: row.effort == null ? null : String(row.effort),
    access_profile: (['read_only', 'workspace_write', 'full_access'].includes(access)
      ? access : 'workspace_write') as Job['access_profile'],
    policy_id: row.policy_id == null ? null : String(row.policy_id),
    contract_version: row.contract_version == null ? null : Number(row.contract_version),
    idempotency_key: row.idempotency_key == null ? null : String(row.idempotency_key),
    priority: Number(row.priority), status: String(row.status) as JobStatus,
    attempts: Number(row.attempts), max_attempts: Number(row.max_attempts),
    budget_tokens: optionalInteger(row.budget_tokens, 'budget_tokens'), budget_cents: optionalInteger(row.budget_cents, 'budget_cents'),
    spent_tokens: Number(row.spent_tokens ?? 0), spent_cents: Number(row.spent_cents ?? 0),
    scheduled_at: String(row.scheduled_at), started_at: row.started_at == null ? null : String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at), error: row.error == null ? null : String(row.error),
    created_at: String(row.created_at),
  }
}
