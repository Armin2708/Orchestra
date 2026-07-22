import type Database from 'better-sqlite3'
import { defaultsForRole } from '../agent-defaults.js'
import { NotFoundError, UnsupportedError, ValidationError } from './errors.js'
import { parseJson } from './json.js'
import {
  JobScheduler,
  type CreateJob,
  type Job,
  type SchedulerTick,
} from './scheduler.js'
import { TaskContractService, type TaskContract } from './task-contracts.js'
import { WorkspaceStore, type Workspace } from './workspace-store.js'

export interface CreateCardJob {
  cardId: number
  provider?: string
  model?: string | null
  effort?: string | null
  accessProfile?: 'read_only' | 'workspace_write' | 'full_access'
  workspaceId?: string | null
  priority?: number
  maxAttempts?: number
  budgetTokens?: number | null
  budgetCents?: number | null
  scheduledAt?: string
}

export interface OrchestratedAgentSession {
  id: string
  workspace_id: string
  agent_id: number | null
  provider: string
  external_id: string | null
  model: string | null
  status: string
  context: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface CardJobSnapshot {
  contract: TaskContract
  job: Job
  workspace: Workspace | null
  session: OrchestratedAgentSession | null
}

export interface LaunchCardJobResult extends CardJobSnapshot {
  dispatch: SchedulerTick
}

/**
 * Canonical command boundary for turning an existing card into durable Agent OS work.
 *
 * The service deliberately composes the existing contract and scheduler services. The
 * scheduler's executor remains responsible for runtime workspace creation, provider
 * launch, agent identity, and durable agent-session creation.
 */
export class OrchestrationService {
  private readonly contracts: TaskContractService
  private readonly workspaces: WorkspaceStore

  constructor(
    private readonly db: Database.Database,
    private readonly scheduler: JobScheduler,
  ) {
    this.contracts = new TaskContractService(db)
    this.workspaces = new WorkspaceStore(db)
  }

  createCardJob(input: CreateCardJob): CardJobSnapshot {
    const create = this.db.transaction(() => {
      const boardId = this.boardForCard(input.cardId)
      const defaults = defaultsForRole(this.db)
      const provider = input.provider ?? defaults.provider
      const matchingDefaults = provider.trim() === defaults.provider ? defaults : null
      const effort = input.effort === undefined ? matchingDefaults?.effort : input.effort
      this.assertSupportedOptions(input, effort)
      const contract = this.contracts.getOrCreate(input.cardId)
      const jobInput: CreateJob = {
        boardId,
        cardId: input.cardId,
        workspaceId: input.workspaceId ?? contract.workspace_id,
        provider,
        model: input.model === undefined ? matchingDefaults?.model : input.model,
        priority: input.priority ?? contract.priority,
        maxAttempts: input.maxAttempts,
        budgetTokens: input.budgetTokens === undefined ? contract.budget_tokens : input.budgetTokens,
        budgetCents: input.budgetCents === undefined ? contract.budget_cents : input.budgetCents,
        scheduledAt: input.scheduledAt,
      }
      return this.scheduler.create(jobInput)
    })

    const job = create.immediate()
    return this.snapshot(job.id)
  }

  async launchCard(input: CreateCardJob): Promise<LaunchCardJobResult> {
    const created = this.createCardJob(input)
    const dispatch = await this.scheduler.tick()
    return { ...this.snapshot(created.job.id), dispatch }
  }

  private assertSupportedOptions(input: CreateCardJob, effort: string | null | undefined): void {
    if (effort != null || input.accessProfile !== undefined) {
      throw new UnsupportedError(
        'canonical jobs do not persist effort or accessProfile yet; keep this launch on the compatibility path',
      )
    }
  }

  private boardForCard(cardId: number): number {
    if (!Number.isSafeInteger(cardId) || cardId <= 0) throw new ValidationError('cardId must be a positive integer')
    const row = this.db.prepare('SELECT board_id FROM cards WHERE id=?').get(cardId) as { board_id: number } | undefined
    if (!row) throw new NotFoundError('card not found')
    return row.board_id
  }

  private snapshot(jobId: string): CardJobSnapshot {
    const job = this.scheduler.get(jobId)
    if (!job?.card_id) throw new NotFoundError('card job not found')
    const contract = this.contracts.getOrCreate(job.card_id)
    const workspaceId = job.workspace_id ?? contract.workspace_id
    return {
      contract,
      job,
      workspace: workspaceId ? this.workspaces.get(workspaceId) : null,
      session: this.sessionForJob(job.id),
    }
  }

  private sessionForJob(jobId: string): OrchestratedAgentSession | null {
    const row = this.db.prepare(`SELECT * FROM agent_sessions
      WHERE json_extract(context_json, '$.job_id')=?
      ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(jobId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: String(row.id),
      workspace_id: String(row.workspace_id),
      agent_id: row.agent_id == null ? null : Number(row.agent_id),
      provider: String(row.provider),
      external_id: row.external_id == null ? null : String(row.external_id),
      model: row.model == null ? null : String(row.model),
      status: String(row.status),
      context: parseJson<Record<string, unknown>>(row.context_json, {}),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }
  }
}
