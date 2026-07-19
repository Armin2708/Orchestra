import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { AttentionService } from './attention.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { optionalInteger, parseJson, timestamp } from './json.js'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'blocked' | 'cancelled'

export interface Job {
  id: string
  board_id: number
  card_id: number | null
  workspace_id: string | null
  provider: string
  model: string | null
  priority: number
  status: JobStatus
  attempts: number
  max_attempts: number
  budget_tokens: number | null
  budget_cents: number | null
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
  model?: string | null
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

  constructor(private readonly db: Database.Database, private readonly executor?: JobExecutor) {
    this.events = new EventStore(db)
    this.attention = new AttentionService(db)
  }

  create(input: CreateJob): Job {
    this.assertScope(input.boardId, input.cardId, input.workspaceId)
    if (!input.provider?.trim()) throw new ValidationError('provider is required')
    const priority = input.priority ?? 0
    if (!Number.isSafeInteger(priority)) throw new ValidationError('priority must be an integer')
    const maxAttempts = input.maxAttempts ?? 1
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new ValidationError('maxAttempts must be at least 1')
    const scheduledAt = input.scheduledAt ?? timestamp()
    if (Number.isNaN(Date.parse(scheduledAt))) throw new ValidationError('scheduledAt must be an ISO date')
    const row = {
      id: randomUUID(), board_id: input.boardId, card_id: input.cardId ?? null,
      workspace_id: input.workspaceId ?? null, provider: input.provider.trim(), model: input.model ?? null,
      priority, status: 'queued', attempts: 0, max_attempts: maxAttempts,
      budget_tokens: input.budgetTokens ?? null, budget_cents: input.budgetCents ?? null,
      scheduled_at: scheduledAt, started_at: null, finished_at: null, error: null, created_at: timestamp(),
    }
    this.db.prepare(`INSERT INTO jobs
      (id, board_id, card_id, workspace_id, provider, model, priority, status, attempts, max_attempts,
       budget_tokens, budget_cents, scheduled_at, started_at, finished_at, error, created_at)
      VALUES (@id, @board_id, @card_id, @workspace_id, @provider, @model, @priority, @status, @attempts,
       @max_attempts, @budget_tokens, @budget_cents, @scheduled_at, @started_at, @finished_at, @error, @created_at)`)
      .run(row)
    this.events.append({ boardId: row.board_id, workspaceId: row.workspace_id, cardId: row.card_id,
      kind: 'job.queued', source: 'scheduler', payload: { job_id: row.id, provider: row.provider, priority } })
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

  async cancel(id: string): Promise<Job> {
    const job = this.get(id)
    if (!job) throw new NotFoundError('job not found')
    if (['succeeded', 'cancelled'].includes(job.status)) return job
    await this.executor?.cancel?.(job)
    const at = timestamp()
    this.db.prepare("UPDATE jobs SET status='cancelled', finished_at=?, error=NULL WHERE id=?").run(at, id)
    this.events.append({ boardId: job.board_id, workspaceId: job.workspace_id, cardId: job.card_id,
      kind: 'job.cancelled', source: 'scheduler', payload: { job_id: id } })
    return this.get(id)!
  }

  async tick(): Promise<SchedulerTick> {
    const result: SchedulerTick = { started: [], completed: [], blocked: [], deferred: [] }
    const running = (this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status='running'").get() as { count: number }).count
    let capacity = Math.max(0, this.maxLaunched() - running)
    if (capacity === 0) return result
    const queued = (this.db.prepare(`SELECT * FROM jobs WHERE status='queued' AND scheduled_at<=?
      ORDER BY priority DESC, scheduled_at ASC, created_at ASC`).all(timestamp()) as Record<string, unknown>[]).map(mapJob)

    for (const job of queued) {
      if (capacity === 0) break
      if (!this.supports(job.provider)) {
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
      if (job.budget_tokens === 0 || job.budget_cents === 0) {
        this.block(job, 'job budget is exhausted before launch'); result.blocked.push(job.id); continue
      }

      const claimed = this.db.prepare(`UPDATE jobs SET status='running', attempts=attempts+1,
        started_at=?, finished_at=NULL, error=NULL WHERE id=? AND status='queued'`).run(timestamp(), job.id)
      if (claimed.changes !== 1) continue
      capacity--
      result.started.push(job.id)
      const active = this.get(job.id)!
      this.events.append({ boardId: active.board_id, workspaceId: active.workspace_id, cardId: active.card_id,
        kind: 'job.started', source: 'scheduler', payload: { job_id: active.id, attempt: active.attempts, provider: active.provider } })
      try {
        const execution = await this.executor!.execute(active)
        if (execution?.status === 'running') continue
        this.db.prepare("UPDATE jobs SET status='succeeded', finished_at=?, error=NULL WHERE id=?").run(timestamp(), active.id)
        this.events.append({ boardId: active.board_id, workspaceId: active.workspace_id, cardId: active.card_id,
          kind: 'job.succeeded', source: 'scheduler', payload: { job_id: active.id, ...(execution?.detail ?? {}) } })
        result.completed.push(active.id)
        capacity++
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const retry = active.attempts < active.max_attempts
        this.db.prepare(`UPDATE jobs SET status=?, error=?, finished_at=? WHERE id=?`)
          .run(retry ? 'queued' : 'blocked', detail, retry ? null : timestamp(), active.id)
        this.events.append({ boardId: active.board_id, workspaceId: active.workspace_id, cardId: active.card_id,
          kind: retry ? 'job.retry_queued' : 'job.blocked', source: 'scheduler',
          payload: { job_id: active.id, attempt: active.attempts, error: detail } })
        if (!retry) {
          this.attention.create({ boardId: active.board_id, workspaceId: active.workspace_id, cardId: active.card_id,
            kind: 'job.blocked', severity: 'high', title: `Job blocked after ${active.attempts} attempt${active.attempts === 1 ? '' : 's'}`, detail })
          result.blocked.push(active.id)
        } else result.deferred.push(active.id)
        capacity++
      }
    }
    return result
  }

  complete(id: string, error?: string): Job {
    const job = this.get(id)
    if (!job) throw new NotFoundError('job not found')
    if (job.status !== 'running') throw new ConflictError('only a running job can be completed')
    const status = error ? 'blocked' : 'succeeded'
    this.db.prepare('UPDATE jobs SET status=?, error=?, finished_at=? WHERE id=?').run(status, error ?? null, timestamp(), id)
    this.events.append({ boardId: job.board_id, workspaceId: job.workspace_id, cardId: job.card_id,
      kind: error ? 'job.blocked' : 'job.succeeded', source: 'scheduler', payload: { job_id: id, error } })
    if (error) this.attention.create({ boardId: job.board_id, workspaceId: job.workspace_id, cardId: job.card_id,
      kind: 'job.blocked', severity: 'high', title: 'Job blocked', detail: error })
    return this.get(id)!
  }

  private supports(provider: string): boolean {
    return !!this.executor && this.executor.supportedProviders().includes(provider)
  }

  private dependencyState(job: Job): 'ready' | 'waiting' | 'invalid' {
    if (!job.card_id) return 'ready'
    const contract = this.db.prepare('SELECT dependencies FROM task_contracts WHERE card_id=?').get(job.card_id) as { dependencies: string } | undefined
    const ids = parseJson<number[]>(contract?.dependencies, [])
    if (!ids.length) return 'ready'
    const placeholders = ids.map(() => '?').join(',')
    const cards = this.db.prepare(`SELECT id, column_name FROM cards WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: number; column_name: string }>
    if (cards.length !== ids.length) return 'invalid'
    return cards.every((card) => card.column_name === 'done') ? 'ready' : 'waiting'
  }

  private block(job: Job, error: string): void {
    this.db.prepare("UPDATE jobs SET status='blocked', error=?, finished_at=? WHERE id=?").run(error, timestamp(), job.id)
    this.events.append({ boardId: job.board_id, workspaceId: job.workspace_id, cardId: job.card_id,
      kind: 'job.blocked', source: 'scheduler', payload: { job_id: job.id, error } })
    this.attention.create({ boardId: job.board_id, workspaceId: job.workspace_id, cardId: job.card_id,
      kind: 'job.blocked', severity: 'high', title: 'Job blocked', detail: error })
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
  return {
    id: String(row.id), board_id: Number(row.board_id), card_id: row.card_id == null ? null : Number(row.card_id),
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id), provider: String(row.provider),
    model: row.model == null ? null : String(row.model), priority: Number(row.priority), status: String(row.status) as JobStatus,
    attempts: Number(row.attempts), max_attempts: Number(row.max_attempts),
    budget_tokens: optionalInteger(row.budget_tokens, 'budget_tokens'), budget_cents: optionalInteger(row.budget_cents, 'budget_cents'),
    scheduled_at: String(row.scheduled_at), started_at: row.started_at == null ? null : String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at), error: row.error == null ? null : String(row.error),
    created_at: String(row.created_at),
  }
}
