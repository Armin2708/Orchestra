import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { AGENT_DEFAULT_EFFORT_LEVELS, defaultsForRole } from '../agent-defaults.js'
import { DeliveryReportService, type DeliveryReport } from './delivery-reports.js'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import { parseJson, timestamp } from './json.js'
import {
  JobScheduler,
  type CreateJob,
  type Job,
  type SchedulerTick,
} from './scheduler.js'
import { TaskContractService, type TaskContract } from './task-contracts.js'
import { WorkspaceStore, type Workspace } from './workspace-store.js'
import { GitWorkspaceProvisioner, type WorkspaceProvisioner } from './workspace-provisioner.js'

export interface CreateCardJob {
  cardId: number
  expectedBoardId?: number
  requireLaunchable?: boolean
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
  idempotencyKey?: string
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
  delivery: DeliveryReport
  job: Job
  workspace: Workspace | null
  session: OrchestratedAgentSession | null
}

export interface LaunchCardJobResult extends CardJobSnapshot {
  dispatch: SchedulerTick
  dispatch_error: string | null
}

/**
 * Canonical command boundary for turning an existing card into durable Agent OS work.
 *
 * The service composes the contract, delivery, workspace, and scheduler services. It
 * reserves the complete durable launch identity atomically; the runtime executor then
 * materializes the reserved provider session and advances its lifecycle in place.
 */
export class OrchestrationService {
  private readonly contracts: TaskContractService
  private readonly deliveries: DeliveryReportService
  private readonly workspaces: WorkspaceStore
  private readonly events: EventStore
  private readonly provisioner: WorkspaceProvisioner

  constructor(
    private readonly db: Database.Database,
    private readonly scheduler: JobScheduler,
    provisioner?: WorkspaceProvisioner,
  ) {
    this.contracts = new TaskContractService(db)
    this.deliveries = new DeliveryReportService(db)
    this.workspaces = new WorkspaceStore(db)
    this.events = new EventStore(db)
    this.provisioner = provisioner ?? new GitWorkspaceProvisioner(this.workspaces)
  }

  createCardJob(input: CreateCardJob): CardJobSnapshot {
    const create = this.db.transaction(() => {
      const card = this.cardForCommand(input)
      let contract = this.contracts.getOrCreate(input.cardId)
      const profile = this.resolveProfile(input, contract)
      this.assertSupportedOptions(input, profile)
      const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
      const fingerprint = requestFingerprint(card.boardId, input, profile)
      if (idempotencyKey) {
        const existing = this.db.prepare(`SELECT id, request_fingerprint FROM jobs
          WHERE board_id=? AND idempotency_key=?`).get(card.boardId, idempotencyKey) as
          { id: string; request_fingerprint: string | null } | undefined
        if (existing) {
          if (existing.request_fingerprint !== fingerprint) {
            throw new ConflictError('idempotency key was already used for a different launch request')
          }
          return existing.id
        }
      }

      this.assertPreflight(card.boardId, contract, input)
      const workspace = this.resolveWorkspace(card, contract, input, profile.accessProfile)
      if (contract.workspace_id !== workspace.id) {
        contract = this.contracts.put(input.cardId, { workspace_id: workspace.id })
      }
      const correlationId = randomUUID()
      const contractId = contractIdentity(contract)
      const requestEvent = this.events.append({
        boardId: card.boardId,
        cardId: input.cardId,
        workspaceId: workspace.id,
        contractId,
        correlationId,
        idempotencyKey: idempotencyKey ? `orchestration.request:${idempotencyKey}` : null,
        kind: 'orchestration.launch_requested',
        source: 'orchestration',
        payload: {
          provider: profile.provider,
          driver_id: profile.driverId,
          model: profile.model,
          effort: profile.effort,
          access_profile: profile.accessProfile,
          contract_version: contract.version,
        },
      })
      const workspaceEvent = workspace.status === 'reserved' ? this.events.append({
        boardId: card.boardId,
        cardId: input.cardId,
        workspaceId: workspace.id,
        contractId,
        correlationId,
        causationId: requestEvent.id,
        idempotencyKey: `workspace:${workspace.id}:reserved`,
        kind: 'workspace.reserved',
        source: 'orchestration',
        payload: { kind: workspace.kind, branch: workspace.branch, worktree_path: workspace.worktree_path },
      }) : requestEvent
      const jobInput: CreateJob = {
        boardId: card.boardId,
        cardId: input.cardId,
        workspaceId: workspace.id,
        provider: profile.provider,
        driverId: profile.driverId,
        model: profile.model,
        effort: profile.effort,
        accessProfile: profile.accessProfile,
        policyId: contract.policy_id,
        contractVersion: contract.version,
        idempotencyKey,
        requestFingerprint: fingerprint,
        correlationId,
        causationId: workspaceEvent.id,
        priority: input.priority ?? contract.priority,
        maxAttempts: input.maxAttempts,
        budgetTokens: input.budgetTokens === undefined ? contract.budget_tokens : input.budgetTokens,
        budgetCents: input.budgetCents === undefined ? contract.budget_cents : input.budgetCents,
        scheduledAt: input.scheduledAt,
      }
      const job = this.scheduler.create(jobInput)
      const queuedEvent = this.latestJobEvent(job.id)
      const assignmentId = randomUUID()
      const sessionId = randomUUID()
      const at = timestamp()
      const isolationMode = workspace.kind === 'shared' ? 'explicit_shared'
        : workspace.status === 'reserved' ? 'managed_worktree' : 'explicit_worktree'
      this.db.prepare(`INSERT INTO workspace_assignments
        (id, board_id, card_id, job_id, workspace_id, status, isolation_mode, access_profile,
         created_at, updated_at, released_at)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, NULL)`).run(
        assignmentId, card.boardId, input.cardId, job.id, workspace.id, isolationMode,
        profile.accessProfile, at, at,
      )
      const assignmentEvent = this.events.append({
        boardId: card.boardId,
        cardId: input.cardId,
        workspaceId: workspace.id,
        jobId: job.id,
        contractId,
        correlationId,
        causationId: queuedEvent?.id ?? workspaceEvent.id,
        idempotencyKey: `job:${job.id}:workspace-assignment-reserved`,
        kind: 'workspace.assignment_reserved',
        source: 'orchestration',
        payload: { assignment_id: assignmentId, isolation_mode: isolationMode,
          workspace_status: workspace.status, access_profile: profile.accessProfile },
      })
      this.db.prepare(`INSERT INTO agent_sessions
        (id, workspace_id, agent_id, provider, external_id, model, status, context_json, created_at, updated_at)
        VALUES (?, ?, NULL, ?, NULL, ?, 'reserved', ?, ?, ?)`).run(
        sessionId,
        workspace.id,
        profile.provider,
        profile.model,
        JSON.stringify({
          job_id: job.id,
          card_id: input.cardId,
          assignment_id: assignmentId,
          correlation_id: correlationId,
          driver_id: profile.driverId,
          effort: profile.effort,
          access_profile: profile.accessProfile,
          managed_identity: false,
          usage_total: null,
        }),
        at,
        at,
      )
      const delivery = this.deliveries.prepareForJob(job.id)
      this.deliveries.attachRuntimeScope(delivery.id, { workspaceId: workspace.id, sessionId })
      this.events.append({
        boardId: card.boardId,
        cardId: input.cardId,
        workspaceId: workspace.id,
        sessionId,
        jobId: job.id,
        contractId,
        correlationId,
        causationId: assignmentEvent.id,
        idempotencyKey: `job:${job.id}:session-reserved`,
        kind: 'agent_session.reserved',
        source: 'orchestration',
        payload: { assignment_id: assignmentId, provider: profile.provider, driver_id: profile.driverId },
      })
      return job.id
    })

    return this.getJobSnapshot(create.immediate())
  }

  async launchCard(input: CreateCardJob): Promise<LaunchCardJobResult> {
    const created = this.createCardJob(input)
    let dispatch: SchedulerTick = { started: [], completed: [], blocked: [], deferred: [] }
    let dispatchError: string | null = null
    if (created.job.status === 'queued' && created.workspace?.status === 'reserved') {
      try {
        const materialized = await this.provisioner.materialize(created.workspace)
        const previous = this.latestJobEvent(created.job.id)
        this.events.append({
          boardId: created.job.board_id,
          cardId: created.job.card_id,
          workspaceId: materialized.id,
          sessionId: created.session?.id,
          jobId: created.job.id,
          contractId: contractIdentity(created.contract),
          correlationId: previous?.correlation_id ?? created.job.id,
          causationId: previous?.id ?? null,
          idempotencyKey: `job:${created.job.id}:workspace-materialized`,
          kind: 'workspace.materialized',
          source: 'orchestration',
          payload: { kind: materialized.kind, branch: materialized.branch, worktree_path: materialized.worktree_path },
        })
      } catch (error) {
        dispatchError = error instanceof Error ? error.message : String(error)
        this.workspaces.update(created.workspace.id, { status: 'failed' })
        const previous = this.latestJobEvent(created.job.id)
        this.events.append({
          boardId: created.job.board_id,
          cardId: created.job.card_id,
          workspaceId: created.workspace.id,
          sessionId: created.session?.id,
          jobId: created.job.id,
          contractId: contractIdentity(created.contract),
          correlationId: previous?.correlation_id ?? created.job.id,
          causationId: previous?.id ?? null,
          idempotencyKey: `job:${created.job.id}:workspace-provisioning-failed`,
          kind: 'workspace.provisioning_failed',
          source: 'orchestration',
          payload: { error: dispatchError },
        })
        this.scheduler.failBeforeLaunch(created.job.id, `workspace provisioning failed: ${dispatchError}`)
        dispatch.blocked.push(created.job.id)
        return { ...this.getJobSnapshot(created.job.id), dispatch, dispatch_error: dispatchError }
      }
    }
    try {
      const globalDispatch = await this.scheduler.tick()
      dispatch = filterDispatch(globalDispatch, created.job.id)
    } catch (error) {
      dispatchError = error instanceof Error ? error.message : String(error)
    }
    return { ...this.getJobSnapshot(created.job.id), dispatch, dispatch_error: dispatchError }
  }

  private assertSupportedOptions(
    input: CreateCardJob,
    profile: { provider: string; model: string | null; effort: string | null; accessProfile: string },
  ): void {
    if (!profile.provider) throw new ValidationError('provider is required')
    if (profile.provider.length > 80 || !/^[a-zA-Z0-9._-]+$/.test(profile.provider)) {
      throw new ValidationError('provider must be a provider identifier')
    }
    if (profile.model !== null && (profile.model.length > 200 || !profile.model)) {
      throw new ValidationError('model must be a non-empty identifier or null')
    }
    if (profile.effort !== null && !/^[a-zA-Z0-9_-]{1,40}$/.test(profile.effort)) {
      throw new ValidationError('effort must be a provider effort identifier or null')
    }
    if (profile.provider === 'claude' && profile.effort !== null
      && !AGENT_DEFAULT_EFFORT_LEVELS.includes(profile.effort as typeof AGENT_DEFAULT_EFFORT_LEVELS[number])) {
      throw new ValidationError(`Claude effort must be one of: ${AGENT_DEFAULT_EFFORT_LEVELS.join(', ')}`)
    }
    if (!['read_only', 'workspace_write', 'full_access'].includes(profile.accessProfile)) {
      throw new ValidationError('accessProfile must be read_only, workspace_write, or full_access')
    }
    for (const [name, value] of [['budgetTokens', input.budgetTokens], ['budgetCents', input.budgetCents]] as const) {
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new ValidationError(`${name} must be a positive integer or null`)
      }
    }
  }

  private resolveProfile(input: CreateCardJob, contract: TaskContract): {
    provider: string
    driverId: string
    model: string | null
    effort: string | null
    accessProfile: 'read_only' | 'workspace_write' | 'full_access'
  } {
    const defaults = defaultsForRole(this.db)
    const provider = (input.provider ?? defaults.provider).trim()
    const matchingDefaults = provider === defaults.provider ? defaults : null
    const modelValue = input.model === undefined ? matchingDefaults?.model ?? null : input.model
    const effortValue = input.effort === undefined ? matchingDefaults?.effort ?? null : input.effort
    const selectedWorkspaceId = input.workspaceId ?? contract.workspace_id
    const selectedWorkspace = selectedWorkspaceId ? this.workspaces.get(selectedWorkspaceId) : null
    const usableWorkspace = selectedWorkspace && ['active', 'reserved'].includes(selectedWorkspace.status)
      ? selectedWorkspace : null
    const accessProfile = input.accessProfile
      ?? (usableWorkspace?.kind === 'shared' ? 'read_only' : 'workspace_write')
    return {
      provider,
      driverId: provider,
      model: typeof modelValue === 'string' ? modelValue.trim() : null,
      effort: typeof effortValue === 'string' ? effortValue.trim() : null,
      accessProfile,
    }
  }

  private assertPreflight(boardId: number, contract: TaskContract, input: CreateCardJob): void {
    for (const [name, value] of [
      ['budgetTokens', input.budgetTokens === undefined ? contract.budget_tokens : input.budgetTokens],
      ['budgetCents', input.budgetCents === undefined ? contract.budget_cents : input.budgetCents],
    ] as const) {
      if (value !== null && value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new ValidationError(`${name} must be a positive integer or null`)
      }
    }
    if (contract.policy_id) {
      const policy = this.db.prepare('SELECT board_id FROM policies WHERE id=?').get(contract.policy_id) as
        { board_id: number } | undefined
      if (!policy) throw new NotFoundError('contract policy not found')
      if (policy.board_id !== boardId) throw new ValidationError('contract policy belongs to a different board')
    }
    if (contract.dependencies.length) {
      const placeholders = contract.dependencies.map(() => '?').join(',')
      const dependencies = this.db.prepare(`SELECT id, board_id FROM cards WHERE id IN (${placeholders})`)
        .all(...contract.dependencies) as Array<{ id: number; board_id: number }>
      if (dependencies.length !== contract.dependencies.length) {
        throw new ValidationError('one or more contract dependencies no longer exist')
      }
      if (dependencies.some((dependency) => dependency.board_id !== boardId)) {
        throw new ValidationError('contract dependencies must belong to the same board')
      }
    }
  }

  private resolveWorkspace(
    card: { boardId: number; projectPath: string; title: string },
    contract: TaskContract,
    input: CreateCardJob,
    accessProfile: 'read_only' | 'workspace_write' | 'full_access',
  ): Workspace {
    const explicitlyRequested = input.workspaceId !== undefined && input.workspaceId !== null
    const requestedId = input.workspaceId ?? contract.workspace_id
    if (requestedId) {
      const workspace = this.workspaces.get(requestedId)
      if (!workspace) {
        if (explicitlyRequested) throw new NotFoundError('workspace not found')
      } else {
        if (workspace.board_id !== card.boardId) throw new ValidationError('workspace belongs to a different board')
        if (workspace.card_id !== null && workspace.card_id !== input.cardId) {
          throw new ValidationError('workspace is linked to a different card')
        }
        if (['active', 'reserved'].includes(workspace.status)) {
          if (workspace.kind === 'shared' && accessProfile !== 'read_only') {
            throw new ValidationError('writable managed jobs require an isolated worktree; shared workspaces are read-only')
          }
          return workspace
        }
        if (explicitlyRequested) throw new ValidationError(`workspace is ${workspace.status}`)
      }
    }

    const reusable = this.db.prepare(`SELECT id FROM workspaces
      WHERE board_id=? AND card_id=? AND kind='worktree' AND status IN ('active','reserved')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, rowid DESC LIMIT 1`)
      .get(card.boardId, input.cardId) as { id: string } | undefined
    if (reusable) return this.workspaces.get(reusable.id)!

    const root = path.resolve(card.projectPath)
    const safeCard = `card-${input.cardId}`
    return this.workspaces.create({
      boardId: card.boardId,
      cardId: input.cardId,
      name: card.title.trim() ? `${safeCard}-${slug(card.title)}` : safeCard,
      kind: 'worktree',
      rootPath: root,
      worktreePath: path.join(path.dirname(root), `${path.basename(root)}-workspaces`, safeCard),
      branch: `orchestra/${safeCard}`,
      baseRef: contract.base_ref ?? 'HEAD',
      status: 'reserved',
    })
  }

  private cardForCommand(input: CreateCardJob): { boardId: number; projectPath: string; title: string } {
    if (!Number.isSafeInteger(input.cardId) || input.cardId <= 0) {
      throw new ValidationError('cardId must be a positive integer')
    }
    if (input.expectedBoardId !== undefined
      && (!Number.isSafeInteger(input.expectedBoardId) || input.expectedBoardId <= 0)) {
      throw new ValidationError('expectedBoardId must be a positive integer')
    }
    const row = this.db.prepare(`SELECT c.board_id, c.column_name, c.owner_agent_id, c.title, b.project_path
      FROM cards c JOIN boards b ON b.id=c.board_id WHERE c.id=?`).get(input.cardId) as {
      board_id: number
      column_name: string
      owner_agent_id: number | null
      title: string
      project_path: string
    } | undefined
    if (!row) throw new NotFoundError('card not found')
    if (input.expectedBoardId !== undefined && row.board_id !== input.expectedBoardId) {
      throw new ValidationError('card belongs to a different board')
    }
    if (input.requireLaunchable && row.column_name === 'done') {
      throw new ValidationError('card is already done')
    }
    if (input.requireLaunchable && row.owner_agent_id !== null) {
      throw new ConflictError('card is already assigned')
    }
    return { boardId: row.board_id, projectPath: row.project_path, title: row.title }
  }

  getJobSnapshot(jobId: string): CardJobSnapshot {
    const job = this.scheduler.get(jobId)
    if (!job?.card_id) throw new NotFoundError('card job not found')
    const delivery = this.deliveries.currentForJob(job.id)
    if (!delivery) throw new ConflictError('canonical job has no durable delivery report')
    if (!job.contract_version || delivery.asked.contract_version !== job.contract_version) {
      throw new ConflictError('canonical job contract snapshot is missing or inconsistent')
    }
    if (delivery.card_id !== job.card_id || delivery.job_id !== job.id) {
      throw new ConflictError('canonical job delivery scope is inconsistent')
    }
    const workspaceId = job.workspace_id
    if (!workspaceId || delivery.workspace_id !== workspaceId) {
      throw new ConflictError('canonical job workspace scope is missing or inconsistent')
    }
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace || workspace.board_id !== job.board_id
      || (workspace.card_id !== null && workspace.card_id !== job.card_id)) {
      throw new ConflictError('canonical job workspace record is missing or inconsistent')
    }
    const session = this.sessionForJob(job.id)
    if (!session || session.workspace_id !== workspaceId || delivery.session_id !== session.id) {
      throw new ConflictError('canonical job session scope is missing or inconsistent')
    }
    if (session.context.job_id !== job.id) {
      throw new ConflictError('canonical job session identity is inconsistent')
    }
    if (typeof session.context.correlation_id !== 'string' || !session.context.correlation_id) {
      throw new ConflictError('canonical job correlation identity is missing')
    }
    const contract = frozenContract(delivery, workspaceId)
    return {
      contract,
      delivery,
      job,
      workspace,
      session,
    }
  }

  private sessionForJob(jobId: string): OrchestratedAgentSession | null {
    const row = this.db.prepare(`SELECT * FROM agent_sessions
      WHERE CASE WHEN json_valid(context_json)
        THEN json_extract(context_json, '$.job_id')=? ELSE 0 END
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

  private latestJobEvent(jobId: string): { id: string; correlation_id: string | null } | null {
    return (this.db.prepare(`SELECT id, correlation_id FROM os_events WHERE job_id=?
      ORDER BY rowid DESC LIMIT 1`).get(jobId) as
      { id: string; correlation_id: string | null } | undefined) ?? null
  }
}

function filterDispatch(dispatch: SchedulerTick, jobId: string): SchedulerTick {
  return {
    started: dispatch.started.filter((id) => id === jobId),
    completed: dispatch.completed.filter((id) => id === jobId),
    blocked: dispatch.blocked.filter((id) => id === jobId),
    deferred: dispatch.deferred.filter((id) => id === jobId),
  }
}

function normalizeIdempotencyKey(value: string | undefined): string | null {
  if (value === undefined) return null
  const key = value.trim()
  if (!key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new ValidationError('idempotencyKey must be 1-200 printable characters')
  }
  return key
}

function requestFingerprint(
  boardId: number,
  input: CreateCardJob,
  profile: {
    provider: string
    driverId: string
    model: string | null
    effort: string | null
    accessProfile: string
  },
): string {
  const request = {
    board_id: boardId,
    card_id: input.cardId,
    provider: profile.provider,
    driver_id: profile.driverId,
    model: profile.model,
    effort: profile.effort,
    access_profile: profile.accessProfile,
    workspace_id: input.workspaceId ?? null,
    priority: input.priority ?? null,
    max_attempts: input.maxAttempts ?? null,
    budget_tokens: input.budgetTokens ?? null,
    budget_cents: input.budgetCents ?? null,
    scheduled_at: input.scheduledAt ?? null,
  }
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

function contractIdentity(contract: TaskContract): string {
  return `card:${contract.card_id}:v${contract.version}`
}

function frozenContract(delivery: DeliveryReport, workspaceId: string): TaskContract {
  return {
    card_id: delivery.card_id,
    objective: delivery.asked.objective,
    deliverables: structuredClone(delivery.asked.deliverables),
    acceptance_criteria: structuredClone(delivery.asked.acceptance_criteria),
    dependencies: [...delivery.asked.dependencies],
    base_ref: delivery.asked.base_ref,
    verify_commands: [...delivery.asked.verify_commands],
    non_goals: [...delivery.asked.non_goals],
    risks: [...delivery.asked.risks],
    budget_tokens: delivery.asked.budget_tokens,
    budget_cents: delivery.asked.budget_cents,
    priority: delivery.asked.priority,
    policy_id: delivery.asked.policy_id,
    workspace_id: workspaceId,
    version: delivery.asked.contract_version,
    updated_at: delivery.asked.contract_updated_at,
  }
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
}
