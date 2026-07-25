import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { ArtifactStore } from './artifact-store.js'
import { AttentionService } from './attention.js'
import type { Checkpoint } from './checkpoints.js'
import { ContextStore } from './context-store.js'
import { DeliveryLifecycleIntegration } from './delivery-integration.js'
import type { DeliveryReport } from './delivery-reports.js'
import { ConflictError, UnsupportedError, ValidationError } from './errors.js'
import { EventStore } from './event-store.js'
import type {
  AgentHomeRuntimeControl,
  RuntimeActionCapabilities,
} from './agent-home-lifecycle.js'
import type { AgentSessionRecord } from './conversations.js'
import { parseJson } from './json.js'
import { projectManagedDriverEvent } from './managed-driver-event-projection.js'
import { ManagedAgentSessionBinder, type ManagedAgentSessionBinding } from './managed-session-binding.js'
import { JobScheduler, type Job, type JobExecutionResult, type JobExecutor } from './scheduler.js'
import { TaskContractService, type TaskContract } from './task-contracts.js'
import type { AgentOsRuntimeAdapter, DriverDescriptor, ProcessRecord as ApiProcessRecord } from './routes.js'
import {
  WorkspaceStore as DurableWorkspaceStore,
  type CreateWorkspace,
  type Workspace,
} from './workspace-store.js'
import {
  createRuntimeLayer,
  ClaudeAgentDriverAdapter,
  type ClaudeConductorPort,
  type AgentDriver,
  type DriverEvent,
  type DriverRegistry,
  type DriverSession,
  type NewProcessRecord,
  type NewWorkspaceRecord,
  type ProcessOutputChunk,
  type ProcessPatch,
  type ProcessRecord,
  type ProcessRestartRecipe,
  type RuntimeEvent,
  type RuntimePersistence,
  type RuntimeSupervisor,
  type WorkspaceFilter,
  type WorkspacePatch,
  type WorkspaceRecord,
  type WorkspaceStatus,
  type WorkspaceStore,
  WorkspaceManager,
} from '../runtime/index.js'
import { projectDriverTranscript } from '../runtime/transcript.js'
import { fromCodexUsage, recordProviderUsage, type ProviderUsageSplit } from '../usage.js'
import { readProviderModelCache } from '../agent-providers.js'
import { hasOpenReviewRequest } from '../review.js'

type BusRef = { current?: EventEmitter }

function mapWorkspace(row: Workspace): WorkspaceRecord {
  return {
    id: row.id,
    boardId: row.board_id,
    cardId: row.card_id,
    name: row.name,
    kind: row.kind as WorkspaceRecord['kind'],
    rootPath: row.root_path,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseRef: row.base_ref ?? 'HEAD',
    status: row.status as WorkspaceStatus,
    env: row.env,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapApiWorkspace(row: WorkspaceRecord): Workspace {
  return {
    id: row.id,
    board_id: row.boardId,
    card_id: row.cardId,
    name: row.name,
    kind: row.kind,
    root_path: row.rootPath,
    worktree_path: row.worktreePath,
    branch: row.branch,
    base_ref: row.baseRef,
    status: row.status,
    env: row.env,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function mapProcess(row: Record<string, unknown>): ProcessRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    command: String(row.command),
    cwd: String(row.cwd),
    status: String(row.status) as ProcessRecord['status'],
    pid: row.pid == null ? null : Number(row.pid),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    cols: Number(row.cols),
    rows: Number(row.rows),
    restartable: Number(row.restartable) === 1,
    startedAt: row.started_at == null ? null : String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
  }
}

function mapApiProcess(row: ProcessRecord): ApiProcessRecord {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    pid: row.pid,
    exit_code: row.exitCode,
    cols: row.cols,
    rows: row.rows,
    restartable: row.restartable,
    started_at: row.startedAt,
    ended_at: row.endedAt,
  }
}

/** Runtime WorkspaceStore backed by the Agent OS workspace table and validation service. */
export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly durable: DurableWorkspaceStore

  constructor(private readonly db: Database.Database) {
    this.durable = new DurableWorkspaceStore(db)
  }

  create(input: NewWorkspaceRecord): WorkspaceRecord {
    return mapWorkspace(this.durable.create({
      boardId: input.boardId,
      cardId: input.cardId,
      name: input.name,
      kind: input.kind,
      rootPath: input.rootPath,
      worktreePath: input.worktreePath,
      branch: input.branch,
      baseRef: input.baseRef,
      status: input.status,
      env: input.env,
    }))
  }

  get(id: string): WorkspaceRecord | undefined {
    const row = this.durable.get(id)
    return row ? mapWorkspace(row) : undefined
  }

  list(filter: WorkspaceFilter = {}): WorkspaceRecord[] {
    const where: string[] = []
    const params: Record<string, unknown> = {}
    if (filter.boardId !== undefined) { where.push('board_id=@board_id'); params.board_id = filter.boardId }
    if (filter.cardId !== undefined) { where.push('card_id IS @card_id'); params.card_id = filter.cardId }
    if (filter.status !== undefined) { where.push('status=@status'); params.status = filter.status }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT id FROM workspaces ${clause} ORDER BY updated_at DESC, rowid DESC`)
      .all(params) as Array<{ id: string }>
    return rows.map((row) => mapWorkspace(this.durable.get(row.id)!))
  }

  update(id: string, patch: WorkspacePatch): WorkspaceRecord {
    return mapWorkspace(this.durable.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.cardId !== undefined ? { card_id: patch.cardId } : {}),
      ...(patch.baseRef !== undefined ? { base_ref: patch.baseRef } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.env !== undefined ? { env: patch.env } : {}),
    }))
  }
}

/** Durable process/output/event persistence used by the real PTY supervisor. */
export class SqliteRuntimePersistence implements RuntimePersistence {
  private readonly events: EventStore
  private readonly attention: AttentionService

  constructor(private readonly db: Database.Database, private readonly bus: BusRef = {}) {
    this.events = new EventStore(db)
    this.attention = new AttentionService(db)
  }

  createProcess(input: NewProcessRecord): ProcessRecord {
    const record = { id: randomUUID(), ...input }
    this.db.prepare(`INSERT INTO processes
      (id, workspace_id, name, command, cwd, status, pid, exit_code, cols, rows, restartable, started_at, ended_at)
      VALUES (@id, @workspace_id, @name, @command, @cwd, @status, @pid, @exit_code, @cols, @rows, @restartable, @started_at, @ended_at)`)
      .run({
        id: record.id,
        workspace_id: record.workspaceId,
        name: record.name,
        command: record.command,
        cwd: record.cwd,
        status: record.status,
        pid: record.pid,
        exit_code: record.exitCode,
        cols: record.cols,
        rows: record.rows,
        restartable: record.restartable ? 1 : 0,
        started_at: record.startedAt,
        ended_at: record.endedAt,
      })
    return structuredClone(record)
  }

  updateProcess(id: string, patch: ProcessPatch): ProcessRecord {
    const current = this.getProcess(id)
    if (!current) throw new Error(`process ${id} not found`)
    const record = { ...current, ...structuredClone(patch) }
    this.db.prepare(`UPDATE processes SET
      name=@name, command=@command, cwd=@cwd, status=@status, pid=@pid, exit_code=@exit_code,
      cols=@cols, rows=@rows, restartable=@restartable, started_at=@started_at, ended_at=@ended_at
      WHERE id=@id`).run({
      id,
      name: record.name,
      command: record.command,
      cwd: record.cwd,
      status: record.status,
      pid: record.pid,
      exit_code: record.exitCode,
      cols: record.cols,
      rows: record.rows,
      restartable: record.restartable ? 1 : 0,
      started_at: record.startedAt,
      ended_at: record.endedAt,
    })
    return record
  }

  getProcess(id: string): ProcessRecord | undefined {
    const row = this.db.prepare('SELECT * FROM processes WHERE id=?').get(id) as Record<string, unknown> | undefined
    return row ? mapProcess(row) : undefined
  }

  listProcesses(workspaceId?: string): ProcessRecord[] {
    const rows = (workspaceId === undefined
      ? this.db.prepare('SELECT * FROM processes ORDER BY rowid DESC').all()
      : this.db.prepare('SELECT * FROM processes WHERE workspace_id=? ORDER BY rowid DESC').all(workspaceId)) as Record<string, unknown>[]
    return rows.map(mapProcess)
  }

  listRunningProcesses(): ProcessRecord[] {
    return (this.db.prepare("SELECT * FROM processes WHERE status IN ('starting','running','stopping') ORDER BY rowid")
      .all() as Record<string, unknown>[]).map(mapProcess)
  }

  appendOutput(chunk: ProcessOutputChunk): void {
    this.db.prepare(`INSERT INTO process_output (process_id, seq, stream, data, created_at)
      VALUES (@process_id, @seq, @stream, @data, @created_at)`).run({
      process_id: chunk.processId,
      seq: chunk.seq,
      stream: chunk.stream,
      data: chunk.data,
      created_at: chunk.createdAt,
    })
  }

  readOutput(processId: string, afterSeq: number, limit: number): ProcessOutputChunk[] {
    return (this.db.prepare(`SELECT process_id, seq, stream, data, created_at FROM process_output
      WHERE process_id=? AND seq>? ORDER BY seq LIMIT ?`).all(processId, afterSeq, limit) as Array<Record<string, unknown>>)
      .map((row) => ({
        processId: String(row.process_id),
        seq: Number(row.seq),
        stream: 'pty',
        data: String(row.data),
        createdAt: String(row.created_at),
      }))
  }

  pruneOutput(processId: string, beforeSeq: number): void {
    this.db.prepare('DELETE FROM process_output WHERE process_id=? AND seq<?').run(processId, beforeSeq)
  }

  saveRestartRecipe(processId: string, recipe: ProcessRestartRecipe): void {
    this.db.prepare('UPDATE processes SET recipe_json=? WHERE id=?').run(JSON.stringify(recipe), processId)
  }

  getRestartRecipe(processId: string): ProcessRestartRecipe | undefined {
    const row = this.db.prepare('SELECT recipe_json FROM processes WHERE id=?')
      .get(processId) as { recipe_json: string } | undefined
    if (!row?.recipe_json) return undefined
    try {
      const recipe = JSON.parse(row.recipe_json) as ProcessRestartRecipe
      return recipe && typeof recipe.command === 'string' && typeof recipe.cwd === 'string' ? recipe : undefined
    } catch {
      return undefined
    }
  }

  onEvent(event: RuntimeEvent): void {
    const workspace = this.db.prepare('SELECT board_id, card_id FROM workspaces WHERE id=?')
      .get(event.workspaceId) as { board_id: number; card_id: number | null } | undefined
    if (!workspace) return
    this.events.append({
      boardId: workspace.board_id,
      workspaceId: event.workspaceId,
      cardId: workspace.card_id,
      processId: event.processId,
      kind: event.kind,
      source: typeof event.payload.source === 'string' ? event.payload.source : 'runtime',
      payload: event.payload,
      createdAt: event.at,
    })
    if (event.kind === 'process.failed' || event.kind === 'process.lost') {
      const process = this.getProcess(event.processId)
      this.attention.create({
        boardId: workspace.board_id,
        workspaceId: event.workspaceId,
        cardId: workspace.card_id,
        kind: event.kind,
        severity: event.kind === 'process.lost' ? 'high' : 'critical',
        title: `${process?.name ?? 'Process'} ${event.kind === 'process.lost' ? 'was lost after restart' : 'failed'}`,
        detail: JSON.stringify(event.payload),
      })
    }
    this.bus.current?.emit('event', {
      board_id: workspace.board_id,
      type: 'os:runtime',
      data: {
        kind: event.kind,
        workspace_id: event.workspaceId,
        process_id: event.processId,
        ...event.payload,
      },
    })
  }
}

type GitResult = { stdout: string; stderr: string; code: number }

function git(cwd: string, args: string[], options: { input?: string; allowed?: number[] } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException | null)?.code === 'number'
        ? (error as unknown as { code: number }).code : error ? 1 : 0
      const result = { stdout: String(stdout), stderr: String(stderr), code }
      if (!error || options.allowed?.includes(code)) resolve(result)
      else reject(new Error(`git ${args[0]} failed: ${result.stderr.trim() || (error as Error).message}`))
    })
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

async function capturePatch(cwd: string): Promise<string> {
  const tracked = await git(cwd, ['diff', '--binary', 'HEAD', '--'])
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout
    .split('\0').filter(Boolean)
  const pieces = [tracked.stdout]
  for (const file of untracked) {
    const empty = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const diff = await git(cwd, ['diff', '--binary', '--no-index', '--', empty, file], { allowed: [1] })
    pieces.push(diff.stdout)
  }
  return pieces.filter(Boolean).join('\n')
}

export type AgentOsRuntime = {
  supervisor: RuntimeSupervisor
  workspaceManager: WorkspaceManager
  drivers: DriverRegistry
  jobExecutor: AgentOsJobExecutor
  scheduler: JobScheduler
  adapter: AgentOsRuntimeAdapter
  descriptors(): DriverDescriptor[]
  registerDriver(driver: AgentDriver): void
  registerClaude(conductor: ClaudeConductorPort): void
  setBus(bus: EventEmitter): void
  reconcileLost(): Promise<ProcessRecord[]>
  reconcileJobs(): Promise<{ resumed: string[]; recovered: string[] }>
  shutdown(): Promise<void>
}

/** Compose the durable stores, safe worktree manager, PTY supervisor, and driver scheduler. */
export function createAgentOsRuntime(db: Database.Database): AgentOsRuntime {
  const bus: BusRef = {}
  const persistence = new SqliteRuntimePersistence(db, bus)
  const layer = createRuntimeLayer({ persistence })
  const workspaceStore = new SqliteWorkspaceStore(db)
  const workspaceManager = new WorkspaceManager({
    store: workspaceStore,
    hasLiveProcesses: (workspaceId) => layer.supervisor.hasLiveProcesses(workspaceId),
    onEvent: (event) => {
      new EventStore(db).append({
        boardId: event.boardId,
        workspaceId: event.workspaceId,
        kind: event.kind,
        source: 'runtime',
        payload: event.payload,
        createdAt: event.at,
      })
      bus.current?.emit('event', {
        board_id: event.boardId,
        type: 'os:workspace',
        data: { kind: event.kind, workspace_id: event.workspaceId, ...event.payload },
      })
    },
  })
  const artifacts = new ArtifactStore(db)

  const captureCheckpoint: NonNullable<AgentOsRuntimeAdapter['captureCheckpoint']> = async (input) => {
    const cwd = input.workspace.worktree_path ?? input.workspace.root_path
    const head = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim()
    const patch = await capturePatch(cwd)
    const artifact = patch ? artifacts.create({
      boardId: input.workspace.board_id,
      workspaceId: input.workspace.id,
      cardId: input.workspace.card_id,
      kind: 'patch',
      name: `${input.name}.patch`,
      mimeType: 'text/x-diff',
      content: patch,
      metadata: { git_head: head, checkpoint: input.name },
    }) : null
    const processRecipes = (await layer.supervisor.list(input.workspace.id))
      .filter((process) => process.restartable)
      .map((process) => layer.supervisor.restartRecipe(process.id))
    return {
      gitHead: head,
      patchArtifactId: artifact?.id ?? null,
      processRecipes: (await Promise.all(processRecipes)).filter(Boolean),
      context: input.context && Object.keys(input.context).length > 0
        ? input.context
        : { items: new ContextStore(db).listWorkspace(input.workspace.id) },
    }
  }

  const forkCheckpoint = async (checkpoint: Checkpoint, request: { name: string; branch?: string; targetPath?: string }): Promise<Workspace> => {
    const source = new DurableWorkspaceStore(db).get(checkpoint.workspace_id)
    if (!source) throw new Error('checkpoint workspace not found')
    const created = await workspaceManager.create({
      boardId: source.board_id,
      cardId: source.card_id,
      name: request.name,
      kind: 'worktree',
      rootPath: source.root_path,
      baseRef: checkpoint.git_head,
      ...(request.branch ? { branch: request.branch } : {}),
      ...(request.targetPath ? { worktreePath: request.targetPath } : {}),
      reuseExisting: false,
    })
    try {
      if (checkpoint.patch_artifact_id) {
        const artifact = artifacts.get(checkpoint.patch_artifact_id)
        if (!artifact?.content) throw new Error('checkpoint patch artifact is missing its content')
        await git(workspaceManager.root(created), ['apply', '--binary', '--whitespace=nowarn', '-'], { input: artifact.content })
      }
      return mapApiWorkspace(created)
    } catch (error) {
      await workspaceManager.archive(created.id).catch(() => undefined)
      throw error
    }
  }

  const adapter: AgentOsRuntimeAdapter = {
    createWorkspace: async (input: CreateWorkspace) => {
      if (input.status && input.status !== 'active') throw new Error('new runtime workspaces must start active')
      if (input.kind && !['shared', 'worktree'].includes(input.kind)) throw new Error('workspace kind must be shared or worktree')
      return mapApiWorkspace(await workspaceManager.create({
        boardId: input.boardId,
        cardId: input.cardId,
        name: input.name,
        kind: (input.kind ?? 'shared') as 'shared' | 'worktree',
        rootPath: input.rootPath,
        ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        baseRef: input.baseRef ?? 'HEAD',
        env: input.env,
      }))
    },
    updateWorkspace: async (workspace, patch) => mapApiWorkspace(await workspaceManager.update(workspace.id, patch)),
    archiveWorkspace: async (workspace) => mapApiWorkspace(await workspaceManager.archive(workspace.id)),
    spawnProcess: async (input) => {
      const executionRoot = await realpath(path.resolve(input.workspace.worktree_path ?? input.workspace.root_path))
      const cwd = await realpath(path.resolve(input.cwd))
      const relative = path.relative(executionRoot, cwd)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new ValidationError(`process cwd must stay inside workspace execution root ${executionRoot}`)
      }
      const env = { ...input.workspace.env, ...input.env }
      const command = input.interactive
        ? process.platform === 'win32'
          ? env.ComSpec || env.COMSPEC || process.env.ComSpec || 'cmd.exe'
          : env.SHELL || process.env.SHELL || '/bin/sh'
        : input.command
      return mapApiProcess(await layer.supervisor.spawn({
        workspaceId: input.workspace.id,
        name: input.name,
        command,
        ...(input.interactive ? {
          args: process.platform === 'win32' ? [] : ['-l'],
          shell: false,
        } : {}),
        cwd,
        env,
        cols: input.cols,
        rows: input.rows,
        restartable: input.restartable,
      }))
    },
    writeProcessInput: (processId, data) => layer.supervisor.write(processId, data, 'human'),
    resizeProcess: async (processId, cols, rows) => { await layer.supervisor.resize(processId, cols, rows) },
    signalProcess: (processId, signal) => layer.supervisor.signal(processId, signal as NodeJS.Signals),
    restartProcess: async (processId) => mapApiProcess(await layer.supervisor.restart(processId)),
    listProcessPorts: (workspaceId) => layer.supervisor.discoverPorts(workspaceId),
    captureCheckpoint,
    forkCheckpoint,
  }

  const jobExecutor = new AgentOsJobExecutor(db, layer.drivers, workspaceManager, bus)
  const scheduler = new JobScheduler(db, jobExecutor)
  jobExecutor.bindScheduler(scheduler)
  const registeredProviders = new Set(layer.drivers.list().map(({ id }) => id))
  const registerDriver = (driver: AgentDriver): void => {
    if (registeredProviders.has(driver.id)) return
    layer.drivers.register(driver)
    registeredProviders.add(driver.id)
  }

  return {
    supervisor: layer.supervisor,
    workspaceManager,
    drivers: layer.drivers,
    jobExecutor,
    scheduler,
    adapter,
    descriptors: () => layer.drivers.list().map(({ id, capabilities }) => ({
      id,
      available: true,
      capabilities: Object.entries(capabilities).filter(([, enabled]) => enabled).map(([name]) => name),
    })),
    registerDriver,
    registerClaude: (conductor) => {
      registerDriver(new ClaudeAgentDriverAdapter({
        conductor,
        resolveAgent: (externalId) => {
          const row = /^\d+$/.test(externalId)
            ? db.prepare('SELECT * FROM agents WHERE id=?').get(Number(externalId))
            : db.prepare('SELECT * FROM agents WHERE sdk_session=?').get(externalId)
          return row as any ?? null
        },
        workspaceForAgent: (agentId) => (db.prepare(`SELECT workspace_id FROM agent_sessions
          WHERE agent_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(agentId) as { workspace_id: string } | undefined)?.workspace_id,
      }))
    },
    setBus: (nextBus) => { bus.current = nextBus },
    reconcileLost: () => layer.supervisor.reconcileLost(),
    reconcileJobs: () => jobExecutor.reconcileRunningJobs(),
    shutdown: async () => {
      jobExecutor.prepareShutdown()
      await layer.supervisor.shutdown()
    },
  }
}

type LiveJob = { driver: AgentDriver; session: DriverSession }

/** Executes durable jobs through provider-neutral drivers and completes them from driver events. */
export class AgentOsJobExecutor implements JobExecutor, AgentHomeRuntimeControl {
  private readonly live = new Map<string, LiveJob>()
  private readonly pausedJobs = new Set<string>()
  private readonly pendingApprovals = new Map<number, Map<string, Record<string, unknown>>>()
  private readonly managedSubagents = new Map<number, Map<string, string>>()
  private readonly deliveries: DeliveryLifecycleIntegration
  private scheduler?: JobScheduler
  private shuttingDown = false

  constructor(
    private readonly db: Database.Database,
    private readonly drivers: DriverRegistry,
    private readonly workspaces: WorkspaceManager,
    private readonly bus: BusRef = {},
  ) {
    this.deliveries = new DeliveryLifecycleIntegration(db)
  }

  bindScheduler(scheduler: JobScheduler): void {
    this.scheduler = scheduler
  }

  supportedProviders(): readonly string[] {
    return this.drivers.list().map((driver) => driver.id)
  }

  agentHomeSessionCapabilities(session: AgentSessionRecord): RuntimeActionCapabilities {
    const driver = this.drivers.get(session.driver_id ?? session.provider)
    if (!driver) {
      const unavailable = (action: string) => ({
        supported: false,
        reason: `${session.provider} ${action} is unavailable because its driver is not registered`,
      })
      return {
        resume: unavailable('resume'),
        pause: unavailable('pause'),
        stop: unavailable('stop'),
        retry: unavailable('retry'),
        fork: unavailable('fork'),
      }
    }
    const capabilities = driver.capabilities()
    const control = this.controlForSession(session.id)
    const live = !!control?.live
    const activeJob = !!control && ['queued', 'running', 'cancelling'].includes(control.job.status)
    return {
      pause: capabilities.interrupt && live
        ? { supported: true, reason: null }
        : {
            supported: false,
            reason: capabilities.interrupt
              ? 'the provider session is not attached to this daemon'
              : `${session.provider} does not support interruption`,
          },
      resume: capabilities.resume && live
        ? { supported: true, reason: null }
        : {
            supported: false,
            reason: capabilities.resume
              ? 'the provider session is not attached to this daemon'
              : `${session.provider} does not support resumable sessions`,
          },
      stop: capabilities.stop && activeJob
        ? { supported: true, reason: null }
        : {
            supported: false,
            reason: capabilities.stop
              ? 'the canonical job is no longer active'
              : `${session.provider} does not support session stop`,
          },
      retry: control
        ? { supported: true, reason: null }
        : {
            supported: false,
            reason: 'retry requires a canonical Agent OS job',
          },
      fork: {
        supported: false,
        reason: `${session.provider} does not expose provenance-safe native session forking`,
      },
    }
  }

  async pauseAgentHomeSession(sessionId: string): Promise<void> {
    const control = this.controlForSession(sessionId)
    if (!control?.live) {
      throw new ConflictError('the provider session is not attached to this daemon')
    }
    if (!control.live.driver.capabilities().interrupt) {
      throw new UnsupportedError(`${control.job.provider} does not support interruption`)
    }
    this.pausedJobs.add(control.job.id)
    try {
      await control.live.driver.interrupt(control.live.session.id)
    } catch (error) {
      this.pausedJobs.delete(control.job.id)
      throw error
    }
  }

  async resumeAgentHomeSession(sessionId: string): Promise<void> {
    const control = this.controlForSession(sessionId)
    if (!control?.live) {
      throw new ConflictError('the provider session is not attached to this daemon')
    }
    if (!control.live.driver.capabilities().resume) {
      throw new UnsupportedError(`${control.job.provider} does not support resumable sessions`)
    }
    this.pausedJobs.delete(control.job.id)
    try {
      await control.live.driver.send(
        control.live.session.id,
        'Resume the current Orchestra assignment from the durable conversation and workspace state. Verify existing work before continuing.',
      )
    } catch (error) {
      this.pausedJobs.add(control.job.id)
      throw error
    }
  }

  async stopAgentHomeSession(sessionId: string): Promise<void> {
    const control = this.controlForSession(sessionId)
    if (!control || !this.scheduler) {
      throw new ConflictError('session is not attached to a canonical Agent OS job')
    }
    const driver = control.live?.driver
      ?? this.drivers.get(control.job.driver_id)
      ?? this.drivers.get(control.job.provider)
    if (!driver?.capabilities().stop && control.job.status === 'running') {
      throw new UnsupportedError(`${control.job.provider} does not support session stop`)
    }
    this.pausedJobs.delete(control.job.id)
    await this.scheduler.cancel(control.job.id)
  }

  prepareShutdown(): void {
    this.shuttingDown = true
  }

  ownsAgent(agentId: number): boolean {
    return !!this.controlForAgent(agentId)
  }

  isHiredAgent(agentId: number): boolean {
    const control = this.controlForAgent(agentId)
    return !!control?.live && ['running', 'cancelling'].includes(control.job.status)
  }

  isLaunchedCard(cardId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM jobs
      WHERE card_id=? AND status IN ('queued','running','cancelling') LIMIT 1`).get(cardId)
  }

  taskAgent(agentId: number, text: string): boolean {
    const control = this.controlForAgent(agentId)
    if (!control?.live || !text) return false
    void control.live.driver.send(control.live.session.id, text).catch((error) => {
      this.recordDriverEvent(control.job, control.sessionId, {
        sessionId: control.live!.session.id,
        seq: Date.now(),
        type: 'error',
        at: new Date().toISOString(),
        data: error instanceof Error ? error.message : String(error),
        metadata: { control: 'task' },
      })
    })
    return true
  }

  deliverAgent(agentId: number, message: any): boolean {
    const from = message?.from_name ? ` from ${message.from_name}` : ''
    const kind = message?.kind === 'notify' ? 'notification' : message?.kind === 'task' ? 'task' : 'message'
    return this.taskAgent(agentId, `orchestra ${kind}${from}: ${String(message?.body ?? '')}`)
  }

  transcriptAgent(agentId: number): any {
    const control = this.controlForAgent(agentId)
    if (!control) return { lines: [], working: null, permissions: [] }
    const rows = this.db.prepare(`SELECT kind, payload, created_at FROM (
      SELECT rowid, kind, payload, created_at FROM os_events
      WHERE session_id=? AND kind LIKE 'driver.%' ORDER BY rowid DESC LIMIT 5000
    ) ORDER BY rowid`).all(control.sessionId) as Array<{ kind: string; payload: string; created_at: string }>
    const events = rows.flatMap((row, index): DriverEvent[] => {
      let payload: Record<string, unknown>
      try { payload = JSON.parse(row.payload) as Record<string, unknown> } catch { return [] }
      const text = typeof payload.data === 'string' ? payload.data : ''
      if (!text) return []
      const eventType = row.kind.slice('driver.'.length)
      if (!['output', 'status', 'tool', 'error', 'exit'].includes(eventType)) return []
      return [{
        sessionId: control.sessionId,
        seq: Number.isFinite(Number(payload.seq)) ? Number(payload.seq) : index + 1,
        type: eventType as DriverEvent['type'],
        at: row.created_at,
        data: text,
        metadata: payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
          ? payload.metadata as Record<string, unknown> : {},
      }]
    })
    const lines = projectDriverTranscript(events)
    const agent = this.db.prepare('SELECT model, effort, access_profile FROM agents WHERE id=?').get(agentId) as
      { model: string | null; effort: string | null; access_profile: string | null } | undefined
    const accessProfile = agent?.access_profile ?? 'workspace_write'
    const requestedModel = agent?.model ?? control.job.model
    const resolvedModel = typeof control.live?.session.metadata.resolvedModel === 'string'
      ? control.live.session.metadata.resolvedModel
      : requestedModel
    const requestedEffort = agent?.effort ?? null
    const resolvedEffort = typeof control.live?.session.metadata.resolvedEffort === 'string'
      ? control.live.session.metadata.resolvedEffort
      : requestedEffort
    return {
      lines,
      working: control.live ? { secs: 0, tokens: control.job.spent_tokens } : null,
      info: {
        provider: control.job.provider,
        model: requestedModel,
        requestedModel,
        resolvedModel,
        effort: requestedEffort,
        resolvedEffort,
        accessProfile,
        permissionMode: accessProfile === 'read_only' ? 'plan'
          : accessProfile === 'full_access' ? 'bypassPermissions' : 'acceptEdits',
        tokens: control.job.spent_tokens,
        models: readProviderModelCache(this.db, control.job.provider)?.models ?? [],
        capabilities: [
          'steering', 'approvals', 'model', 'effort', 'rate_limits', 'usage', 'diffs', 'plans',
          'subagents', 'access_profile', 'interrupt', 'stop',
        ],
      },
      permissions: [...(this.pendingApprovals.get(agentId)?.values() ?? [])],
    }
  }

  subagentsForAgent(agentId: number): { key: string; label: string }[] {
    return [...(this.managedSubagents.get(agentId)?.entries() ?? [])].map(([key, label]) => ({ key, label }))
  }

  async interruptManagedAgent(agentId: number): Promise<boolean> {
    const control = this.controlForAgent(agentId)
    if (!control?.live) return false
    await control.live.driver.interrupt(control.live.session.id)
    return true
  }

  async fireManagedAgent(agentId: number): Promise<boolean> {
    const control = this.controlForAgent(agentId)
    if (!control || !this.scheduler || !['queued', 'running', 'cancelling'].includes(control.job.status)) return false
    try { await this.scheduler.cancel(control.job.id); return true }
    catch { return false }
  }

  async setManagedAgentModel(agentId: number, model: string): Promise<boolean> {
    if (!model.trim()) return false
    const control = this.controlForAgent(agentId)
    const update = control?.live && (control.live.driver as AgentDriver & {
      updateSession?(sessionId: string, patch: { model: string }): Promise<void>
    }).updateSession
    if (!control?.live || !update) return false
    try { await update.call(control.live.driver, control.live.session.id, { model }) }
    catch { return false }
    this.db.prepare('UPDATE jobs SET model=? WHERE id=?').run(model, control.job.id)
    this.db.prepare('UPDATE agent_sessions SET model=?, updated_at=datetime(\'now\') WHERE id=?').run(model, control.sessionId)
    this.db.prepare('UPDATE agents SET model=?, last_seen=datetime(\'now\') WHERE id=?').run(model, agentId)
    return true
  }

  async setManagedAgentEffort(agentId: number, level: string): Promise<'ok' | 'busy' | 'not-found' | 'bad-level' | 'no-session'> {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(level)) return 'bad-level'
    const control = this.controlForAgent(agentId)
    if (!control) return 'not-found'
    const update = control.live && (control.live.driver as AgentDriver & {
      updateSession?(sessionId: string, patch: { effort: string }): Promise<void>
    }).updateSession
    if (!control.live || !update) return 'no-session'
    try { await update.call(control.live.driver, control.live.session.id, { effort: level }) }
    catch { return 'bad-level' }
    this.db.prepare('UPDATE agents SET effort=?, last_seen=datetime(\'now\') WHERE id=?').run(level, agentId)
    return 'ok'
  }

  async setManagedAgentAccess(
    agentId: number,
    profile: 'read_only' | 'workspace_write' | 'full_access',
  ): Promise<boolean> {
    if (!['read_only', 'workspace_write', 'full_access'].includes(profile)) return false
    const control = this.controlForAgent(agentId)
    const update = control?.live && (control.live.driver as AgentDriver & {
      updateSession?(sessionId: string, patch: { accessProfile: typeof profile }): Promise<void>
    }).updateSession
    if (!control?.live || !update) return false
    try { await update.call(control.live.driver, control.live.session.id, { accessProfile: profile }) }
    catch { return false }
    this.db.prepare('UPDATE agents SET access_profile=?, last_seen=datetime(\'now\') WHERE id=?').run(profile, agentId)
    return true
  }

  async resolveManagedApproval(
    agentId: number,
    requestId: string,
    decision: 'allow' | 'allow_session' | 'deny' | 'cancel',
    message?: string,
    answers?: Record<string, string[]>,
  ): Promise<boolean> {
    const control = this.controlForAgent(agentId)
    const resolve = control?.live && (control.live.driver as AgentDriver & {
      resolveApproval?(
        sessionId: string,
        id: string,
        choice: 'allow' | 'allow_session' | 'deny' | 'cancel',
        detail?: string,
        answers?: Record<string, string[]>,
      ): Promise<boolean>
    }).resolveApproval
    if (!control?.live || !resolve || !this.pendingApprovals.get(agentId)?.has(requestId)) return false
    const ok = await resolve.call(control.live.driver, control.live.session.id, requestId, decision, message, answers)
    if (ok) this.pendingApprovals.get(agentId)?.delete(requestId)
    return ok
  }

  async reconcileRunningJobs(): Promise<{ resumed: string[]; recovered: string[] }> {
    if (!this.scheduler) throw new Error('job executor is not bound to a scheduler')
    const resumed: string[] = []
    const recovered: string[] = []
    const rows = this.db.prepare("SELECT * FROM jobs WHERE status IN ('running','cancelling') ORDER BY started_at, rowid")
      .all() as Record<string, unknown>[]
    for (const row of rows) {
      const job = mapRuntimeJob(row)
      if (job.status === 'cancelling') {
        this.scheduler.recover(job.id, 'daemon restarted while cancellation was in progress')
        recovered.push(job.id)
        continue
      }
      const sessionRow = this.sessionForJob(job.id)
      const paused = sessionRow?.control_state === 'paused'
      if (paused) this.pausedJobs.add(job.id)
      const driver = sessionRow ? this.drivers.get(sessionRow.provider) : undefined
      if (!sessionRow?.external_id || !driver || !driver.capabilities().resume) {
        this.pausedJobs.delete(job.id)
        if (sessionRow) this.markSessionFailed(sessionRow.id)
        const reason = `daemon restarted; ${job.provider} session cannot be resumed`
        const recoveredJob = this.scheduler.recover(job.id, reason)
        if (sessionRow) this.finalizeManagedAgent(job, sessionRow.id, reason, recoveredJob.status)
        recovered.push(job.id)
        continue
      }
      let providerSessionLost = false
      try {
        const session = await driver.attach(sessionRow.external_id)
        if (!session) {
          providerSessionLost = true
          throw new Error('provider session is no longer live')
        }
        if (sessionRow.provider === 'codex') {
          const update = (driver as AgentDriver & {
            updateSession?(sessionId: string, patch: {
              model?: string
              effort?: string
              accessProfile?: 'read_only' | 'workspace_write' | 'full_access'
            }): Promise<void>
          }).updateSession
          const patch = {
            ...(sessionRow.model ? { model: sessionRow.model } : {}),
            ...(sessionRow.effort ? { effort: sessionRow.effort } : {}),
            ...(sessionRow.access_profile ? { accessProfile: sessionRow.access_profile } : {}),
          }
          if (!update) throw new Error('Codex driver cannot restore persisted session overrides')
          await update.call(driver, session.id, patch)
        }
        if (sessionRow.provider === 'claude' && !paused) {
          await driver.send(session.id,
            'The Orchestra daemon restarted while this durable job was active. Continue the existing job from the current workspace and conversation state; verify prior work before making further changes, then complete the assignment.')
        }
        this.db.prepare(`UPDATE agent_sessions SET status=?, control_state=?,
          updated_at=datetime('now') WHERE id=?`).run(
          paused ? 'idle' : 'running',
          paused ? 'paused' : 'active',
          sessionRow.id,
        )
        this.live.set(job.id, { driver, session })
        void this.watch(job, sessionRow.id, driver, session, job.spent_tokens, job.spent_cents)
        resumed.push(job.id)
      } catch (error) {
        this.pausedJobs.delete(job.id)
        if (providerSessionLost) this.markSessionLost(sessionRow.id)
        else this.markSessionFailed(sessionRow.id)
        const reason = `daemon restart recovery failed: ${error instanceof Error ? error.message : String(error)}`
        const recoveredJob = this.scheduler.recover(job.id, reason)
        if (providerSessionLost) this.markSessionLost(sessionRow.id)
        this.finalizeManagedAgent(job, sessionRow.id, reason, recoveredJob.status)
        recovered.push(job.id)
      }
    }
    return { resumed, recovered }
  }

  async execute(job: Job): Promise<JobExecutionResult> {
    const driver = this.drivers.require(job.driver_id)
    const capabilities = driver.capabilities()
    const contract = job.card_id ? new TaskContractService(this.db).getOrCreate(job.card_id) : null
    const delivery = job.card_id ? this.deliveries.reports.prepareForJob(job.id) : null
    const budgetTokens = job.budget_tokens ?? contract?.budget_tokens ?? null
    const budgetCents = job.budget_cents ?? contract?.budget_cents ?? null
    this.db.prepare(`UPDATE jobs SET budget_tokens=COALESCE(budget_tokens, ?), budget_cents=COALESCE(budget_cents, ?)
      WHERE id=?`).run(budgetTokens, budgetCents, job.id)
    const effectiveJob = { ...job, budget_tokens: budgetTokens, budget_cents: budgetCents }
    if ((budgetTokens !== null && job.spent_tokens >= budgetTokens) ||
        (budgetCents !== null && job.spent_cents >= budgetCents)) throw new Error('job budget is exhausted before launch')
    if (budgetTokens !== null && !capabilities.tokenBudget)
      throw new Error(`driver ${job.driver_id} does not expose an enforceable token budget`)
    if (budgetCents !== null && !capabilities.costBudget)
      throw new Error(`driver ${job.driver_id} does not expose an authoritative cost budget`)
    const workspace = await this.resolveWorkspace(effectiveJob, contract)
    if (job.card_id && contract?.workspace_id !== workspace.id) {
      new TaskContractService(this.db).put(job.card_id, { workspace_id: workspace.id })
    }
    this.assertCardClaimable(job)
    const cwd = this.workspaces.root(workspace)
    const managedAgentId = !capabilities.rawTerminal && capabilities.managesAgentIdentity !== true
      ? this.prepareManagedAgent(effectiveJob, cwd, job.access_profile)
      : null
    const agentName = job.card_id ? `job-${job.card_id}` : `job-${job.id.slice(0, 8)}`
    const profileName = job.card_id ? `job-${job.card_id}-${job.id}` : `job-${job.id}`
    const sessionContext = {
      job_id: job.id,
      card_id: job.card_id,
      managed_identity: managedAgentId !== null,
      driver_id: job.driver_id,
      effort: job.effort,
      access_profile: job.access_profile,
      usage_total: null,
    }
    let agentHome: ManagedAgentSessionBinding | null = null
    if (job.provider !== 'shell') {
      try {
        agentHome = new ManagedAgentSessionBinder(this.db).bind({
          jobId: job.id,
          boardId: job.board_id,
          workspaceId: workspace.id,
          provider: job.provider,
          driverId: job.driver_id,
          profileName,
          model: job.model,
          effort: job.effort,
          accessProfile: job.access_profile,
          context: sessionContext,
        })
      } catch (error) {
        if (managedAgentId) this.markManagedAgentGone(managedAgentId)
        throw error
      }
    }
    const request = job.provider === 'shell'
      ? this.shellRequest(effectiveJob, workspace, contract, cwd)
      : {
          workspaceId: workspace.id,
          boardId: job.board_id,
          cwd,
          name: agentName,
          prompt: this.prompt(job, contract, delivery),
          ...(job.model ? { model: job.model } : {}),
          ...(job.effort ? { effort: job.effort } : {}),
          accessProfile: job.access_profile,
          ...(job.provider === 'claude'
            ? { permissionMode: job.access_profile === 'read_only' ? 'plan'
              : job.access_profile === 'full_access' ? 'bypassPermissions' : 'default' }
            : {}),
          ...(budgetCents !== null ? { maxBudgetUsd: Math.max(0.01, (budgetCents - job.spent_cents) / 100) } : {}),
          ...(budgetTokens !== null ? { taskBudgetTokens: Math.max(1, budgetTokens - job.spent_tokens) } : {}),
          metadata: {
            jobId: job.id,
            cardId: job.card_id,
            budgetTokens,
            budgetCents,
            effort: job.effort,
            accessProfile: job.access_profile,
            driverId: job.driver_id,
            ...(managedAgentId ? { agentId: managedAgentId } : {}),
            agentHomeSessionId: agentHome!.agentHomeSessionId,
            agentProfileId: agentHome!.agentProfileId,
            agentConversationId: agentHome!.agentConversationId,
          },
        }
    let session: DriverSession
    try { session = await driver.launch(request) }
    catch (error) {
      if (managedAgentId) this.markManagedAgentGone(managedAgentId)
      throw error
    }
    const launchState = this.db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id) as { status: string } | undefined
    if (launchState?.status !== 'running') {
      await driver.stop(session.id).catch(() => undefined)
      if (managedAgentId) this.markManagedAgentGone(managedAgentId)
      throw new Error(`job ${job.id} left the running state while its provider was launching`)
    }
    const reservation = agentHome
      ? this.db.prepare('SELECT id, context_json FROM agent_sessions WHERE id=?')
          .get(agentHome.agentHomeSessionId) as { id: string; context_json: string } | undefined
      : this.db.prepare(`SELECT id, context_json FROM agent_sessions
          WHERE json_valid(context_json) AND json_extract(context_json, '$.job_id')=?
            AND status IN ('reserved','starting') ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
          .get(job.id) as { id: string; context_json: string } | undefined
    const sessionId = agentHome?.agentHomeSessionId ?? reservation?.id ?? randomUUID()
    const agentId = Number(session.metadata.agentId ?? managedAgentId)
    try {
      if (agentHome && !reservation) {
        throw new Error(`bound Agent Home session disappeared before provider launch completed: ${sessionId}`)
      }
      const context = {
        ...parseJson<Record<string, unknown>>(reservation?.context_json, {}),
        ...sessionContext,
      }
      if (reservation) {
        this.db.prepare(`UPDATE agent_sessions SET workspace_id=?, agent_id=?, provider=?, external_id=?, model=?,
          status='running', context_json=?, updated_at=datetime('now') WHERE id=?`).run(
          workspace.id,
          Number.isSafeInteger(agentId) && agentId > 0 ? agentId : null,
          job.provider,
          session.externalId,
          job.model,
          JSON.stringify(context),
          sessionId,
        )
      } else {
        this.db.prepare(`INSERT INTO agent_sessions
          (id, workspace_id, agent_id, provider, external_id, model, status, context_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'running', ?, datetime('now'), datetime('now'))`).run(
          sessionId,
          workspace.id,
          Number.isSafeInteger(agentId) && agentId > 0 ? agentId : null,
          job.provider,
          session.externalId,
          job.model,
          JSON.stringify(context),
        )
      }
      if (managedAgentId) this.db.prepare(`UPDATE agents SET status='active', external_session_id=?,
        provider_state_json=?, last_seen=datetime('now') WHERE id=?`).run(
          session.externalId,
          JSON.stringify({
            driver_session_id: session.id,
            external_session_id: session.externalId,
            workspace_id: workspace.id,
            job_id: job.id,
            cwd,
            lifecycle: 'active',
          }),
          managedAgentId,
        )
      this.db.prepare('UPDATE jobs SET workspace_id=? WHERE id=?').run(workspace.id, job.id)
      if (delivery) this.deliveries.reports.attachRuntimeScope(delivery.id, {
        workspaceId: workspace.id,
        sessionId,
      })
      const previous = this.db.prepare(`SELECT id, correlation_id FROM os_events
        WHERE job_id=? ORDER BY rowid DESC LIMIT 1`).get(job.id) as
        { id: string; correlation_id: string | null } | undefined
      new EventStore(this.db).append({
        boardId: job.board_id,
        cardId: job.card_id,
        workspaceId: workspace.id,
        sessionId,
        jobId: job.id,
        contractId: job.card_id && job.contract_version ? `card:${job.card_id}:v${job.contract_version}` : null,
        correlationId: previous?.correlation_id ?? job.id,
        causationId: previous?.id ?? null,
        idempotencyKey: `job:${job.id}:session-started:${job.attempts}`,
        kind: 'agent_session.started',
        source: job.driver_id,
        payload: { provider: job.provider, driver_id: job.driver_id, external_id: session.externalId },
      })
      if (job.card_id && Number.isSafeInteger(agentId) && agentId > 0) this.claimCard(job, agentId)
    } catch (error) {
      await driver.stop(session.id).catch(() => undefined)
      throw error
    }
    this.live.set(job.id, { driver, session })
    void this.watch(job, sessionId, driver, session)
    return { status: 'running', detail: { session_id: sessionId, driver_session_id: session.id, workspace_id: workspace.id } }
  }

  async cancel(job: Job): Promise<void> {
    const current = this.live.get(job.id)
    if (current) {
      await current.driver.stop(current.session.id)
      this.live.delete(job.id)
    } else {
      const row = this.sessionForJob(job.id)
      if (row?.external_id) {
        const driver = this.drivers.get(row.provider)
        const attached = driver ? await driver.attach(row.external_id) : null
        if (driver && attached) await driver.stop(attached.id)
      }
    }
    const stopped = this.db.prepare(`UPDATE agent_sessions SET status='stopped', updated_at=datetime('now')
      WHERE json_valid(context_json) AND json_extract(context_json, '$.job_id')=?
        AND status NOT IN ('stopped','failed')`).run(job.id)
    if (stopped.changes > 0) {
      const session = this.sessionForJob(job.id)
      if (session) this.recordSessionTransition(job, session.id, 'stopped', job.driver_id)
    }
  }

  private async resolveWorkspace(job: Job, contract: TaskContract | null): Promise<WorkspaceRecord> {
    const requested = job.workspace_id ?? contract?.workspace_id
    if (requested) {
      const existing = await this.workspaces.get(requested)
      if (!existing) throw new Error(`workspace ${requested} not found`)
      if (existing.status !== 'active') throw new Error(`workspace ${requested} is ${existing.status}`)
      if (job.card_id && existing.cardId !== null && existing.cardId !== job.card_id) {
        throw new Error(`workspace ${requested} is linked to a different card`)
      }
      const assigned = this.db.prepare('SELECT 1 FROM workspace_assignments WHERE job_id=? AND workspace_id=?')
        .get(job.id, existing.id)
      if (job.card_id && existing.cardId === null && !assigned) {
        return this.workspaces.update(existing.id, { cardId: job.card_id })
      }
      return existing
    }
    if (job.card_id) {
      const linked = (await this.workspaces.list({ boardId: job.board_id, cardId: job.card_id, status: 'active' }))[0]
      if (linked) return linked
    }
    const board = this.db.prepare('SELECT project_path FROM boards WHERE id=?').get(job.board_id) as { project_path: string } | undefined
    if (!board) throw new Error('job board not found')
    const workspace = await this.workspaces.create({
      boardId: job.board_id,
      cardId: job.card_id,
      name: job.card_id ? `card-${job.card_id}` : `job-${job.id.slice(0, 8)}`,
      kind: job.card_id ? 'worktree' : 'shared',
      rootPath: board.project_path,
      baseRef: contract?.base_ref ?? 'HEAD',
      reuseExisting: !job.card_id,
    })
    return workspace
  }

  private shellRequest(job: Job, workspace: WorkspaceRecord, contract: TaskContract | null, cwd: string) {
    const command = contract?.verify_commands[0]?.trim()
    if (!command) throw new Error('shell jobs require at least one task-contract verify command')
    return {
      workspaceId: workspace.id,
      boardId: job.board_id,
      cwd,
      name: job.card_id ? `verify-${job.card_id}` : `job-${job.id.slice(0, 8)}`,
      command,
      env: workspace.env,
      metadata: { jobId: job.id, cardId: job.card_id },
    }
  }

  private prompt(job: Job, contract: TaskContract | null, delivery: DeliveryReport | null): string {
    if (!contract || !delivery) {
      return `Execute Agent OS job ${job.id} in this workspace. Finish with a concise Delivery summary and Evidence.`
    }
    const asked = delivery.asked as DeliveryReport['asked'] & {
      objective?: string
      deliverables?: Array<{ id: string; text?: string; description?: string; required?: boolean }>
      acceptance_criteria?: Array<{ id: string; text?: string; description?: string; required?: boolean }>
      verify_commands?: string[]
    }
    const row = (item: { id: string; text?: string; description?: string; required?: boolean }) =>
      `- [${item.id}] ${item.text ?? item.description ?? '(unspecified)'}${item.required === false ? ' (optional)' : ''}`
    const deliverables = (asked.deliverables ?? []).map(row).join('\n')
    const acceptance = (asked.acceptance_criteria ?? []).map(row).join('\n')
    const verification = (asked.verify_commands ?? contract.verify_commands).map((command) => `- ${command}`).join('\n')
    return [
      `Delivery ${delivery.id} for Agent OS job ${job.id}`,
      `Objective: ${asked.objective ?? contract.objective}`,
      deliverables ? `Promised deliverables (stable IDs):\n${deliverables}` : 'Promised deliverables: none recorded.',
      acceptance ? `Acceptance criteria (stable IDs):\n${acceptance}` : 'Acceptance criteria: none recorded.',
      verification ? `Required verification commands:\n${verification}` : 'Required verification commands: none recorded.',
      `Before stopping, submit the structured report with "orchestra delivery submit ${job.id}" when that command is available. Claims are not verification evidence.`,
      'Your final response MUST end with two concise sections: "Delivery summary:" describing what changed, and "Evidence:" listing the exact commands, artifacts, commits, or observed results. Do not move the card to done; the daemon parks a complete report in review.',
    ].filter(Boolean).join('\n\n')
  }

  private claimCard(job: Job, agentId: number): void {
    const current = this.db.prepare('SELECT owner_agent_id FROM cards WHERE id=? AND board_id=?')
      .get(job.card_id, job.board_id) as { owner_agent_id: number | null } | undefined
    if (!current) throw new Error('job card not found')
    if (current.owner_agent_id && current.owner_agent_id !== agentId) throw new Error('job card is already owned by another agent')
    this.db.prepare(`UPDATE cards SET owner_agent_id=?, column_name='in_progress', updated_at=datetime('now') WHERE id=?`)
      .run(agentId, job.card_id)
    this.db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload) VALUES (?, ?, 'agent_os_job_started', ?)`)
      .run(job.card_id, agentId, JSON.stringify({ job_id: job.id }))
    const card = this.db.prepare('SELECT * FROM cards WHERE id=?').get(job.card_id)
    this.bus.current?.emit('event', { board_id: job.board_id, type: 'card', data: card })
  }

  private assertCardClaimable(job: Job): void {
    if (!job.card_id) return
    const card = this.db.prepare('SELECT owner_agent_id FROM cards WHERE id=? AND board_id=?')
      .get(job.card_id, job.board_id) as { owner_agent_id: number | null } | undefined
    if (!card) throw new Error('job card not found')
    if (card.owner_agent_id) throw new Error('job card is already owned by another agent')
  }

  private async watch(
    job: Job,
    sessionId: string,
    driver: AgentDriver,
    session: DriverSession,
    initialAccountedTokens = 0,
    initialAccountedCents = 0,
  ): Promise<void> {
    let failure: string | undefined
    let detached = false
    let accountedTokens = Math.max(0, initialAccountedTokens)
    let accountedCents = Math.max(0, initialAccountedCents)
    let stopRequested = false
    try {
      for await (const event of driver.events(session.id)) {
        this.recordDriverEvent(job, sessionId, event)
        const pausedTurnCompleted = event.metadata?.turnCompleted === true
          && this.pausedJobs.has(job.id)
        if (event.type === 'error' && !pausedTurnCompleted) failure = event.data
        const breakdown = this.codexUsageBreakdown(event)
        if (breakdown) this.recordManagedProviderUsage(sessionId, breakdown)
        const reportedTokens = breakdown?.total_tokens ?? this.reportedTokens(event)
        const reportedCents = this.reportedCents(event)
        if (this.scheduler) {
          const tokenDelta = reportedTokens === null ? 0 : Math.max(0, reportedTokens - accountedTokens)
          const centsDelta = reportedCents === null ? 0 : Math.max(0, reportedCents - accountedCents)
          if (tokenDelta > 0 || centsDelta > 0) this.scheduler.recordUsage(job.id, tokenDelta, centsDelta)
          if (reportedTokens !== null) accountedTokens = Math.max(accountedTokens, reportedTokens)
          if (reportedCents !== null) accountedCents = Math.max(accountedCents, reportedCents)
          const current = this.scheduler.get(job.id)
          const exhausted = current && (
            (current.budget_tokens !== null && current.spent_tokens >= current.budget_tokens)
            || (current.budget_cents !== null && current.spent_cents >= current.budget_cents)
          )
          if (exhausted && !stopRequested) {
            failure = 'job budget exhausted during provider turn'
            stopRequested = true
            await driver.stop(session.id).catch((error) => {
              failure = `${failure}: ${error instanceof Error ? error.message : String(error)}`
            })
            continue
          }
        }
        if (event.metadata?.turnCompleted === true && !stopRequested) {
          if (pausedTurnCompleted) continue
          stopRequested = true
          await driver.stop(session.id).catch((error) => {
            failure ??= error instanceof Error ? error.message : String(error)
          })
          continue
        }
        if (event.type === 'exit') {
          const exitCode = Number(event.metadata?.exitCode)
          if (event.metadata?.detached === true || this.shuttingDown) {
            detached = true
          } else if (event.data.includes('process.stopped')) {
            failure = 'job interrupted by daemon shutdown or an explicit process stop'
          } else if (event.data.includes('failed') || event.data.includes('lost') || (Number.isFinite(exitCode) && exitCode !== 0)) {
            failure = event.data || `process exited with code ${exitCode}`
          }
          break
        }
      }
      if (!failure && job.card_id) {
        const card = this.db.prepare('SELECT column_name FROM cards WHERE id=?').get(job.card_id) as { column_name: string } | undefined
        if (card?.column_name === 'blocked') failure = 'agent stopped with the task blocked'
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      this.pausedJobs.delete(job.id)
      this.live.delete(job.id)
      if (detached || this.shuttingDown) return
      const current = this.db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id) as { status: string } | undefined
      const cancellationWon = current?.status === 'cancelling' || current?.status === 'cancelled'
      const sessionStatus = failure && !cancellationWon ? 'failed' : 'stopped'
      this.db.prepare(`UPDATE agent_sessions SET status=?, updated_at=datetime('now') WHERE id=?`)
        .run(sessionStatus, sessionId)
      this.recordSessionTransition(job, sessionId, sessionStatus, job.driver_id)
      let finalStatus = current?.status
      if (current?.status === 'running') {
        try { finalStatus = this.scheduler?.complete(job.id, failure).status }
        catch { /* cancellation or another completion won the race */ }
      }
      this.finalizeManagedAgent(job, sessionId, failure, finalStatus)
    }
  }

  private prepareManagedAgent(
    job: Job,
    cwd: string,
    accessProfile: 'read_only' | 'workspace_write' | 'full_access',
  ): number {
    const base = `${job.provider}-job-${job.card_id ?? job.id.slice(0, 8)}`
    let name = base
    const collision = this.db.prepare('SELECT provider FROM agents WHERE board_id=? AND name=?')
      .get(job.board_id, name) as { provider: string } | undefined
    if (collision && collision.provider !== job.provider) name = `${base}-${job.id.slice(0, 6)}`
    this.db.prepare(`INSERT INTO agents (
      board_id, name, session_id, kind, status, provider, provider_state_json,
      access_profile, model, effort
    ) VALUES (?, ?, ?, 'hired', 'starting', ?, ?, ?, ?, ?)
    ON CONFLICT(board_id, name) DO UPDATE SET
      session_id=excluded.session_id, kind='hired', status='starting', provider=excluded.provider,
      provider_state_json=excluded.provider_state_json, access_profile=excluded.access_profile,
      model=excluded.model, effort=excluded.effort, last_seen=datetime('now')`).run(
        job.board_id,
        name,
        `agent-os:${job.id}`,
        job.provider,
        JSON.stringify({ job_id: job.id, workspace_id: job.workspace_id, cwd, lifecycle: 'starting' }),
        accessProfile,
        job.model,
        job.effort,
      )
    return Number((this.db.prepare('SELECT id FROM agents WHERE board_id=? AND name=?')
      .get(job.board_id, name) as { id: number }).id)
  }

  private markManagedAgentGone(agentId: number): void {
    this.db.prepare("UPDATE agents SET status='gone', last_seen=datetime('now') WHERE id=?").run(agentId)
  }

  private finalizeManagedAgent(
    job: Job,
    sessionId: string,
    failure: string | undefined,
    finalStatus: string | undefined,
  ): void {
    const session = this.db.prepare('SELECT agent_id, context_json FROM agent_sessions WHERE id=?').get(sessionId) as
      { agent_id: number | null; context_json: string } | undefined
    let context: Record<string, unknown> = {}
    try { context = JSON.parse(session?.context_json ?? '{}') as Record<string, unknown> } catch { /* legacy */ }
    const agentId = session?.agent_id ?? null
    if (job.card_id) {
      const card = this.db.prepare('SELECT column_name FROM cards WHERE id=?').get(job.card_id) as
        { column_name: string } | undefined
      let to = finalStatus === 'queued' ? 'backlog' : 'blocked'
      let deliveryId: string | null = null
      let deliveryFailure: string | null = null
      const summary = this.completionSummary(sessionId)
      const workspace = this.db.prepare('SELECT workspace_id FROM jobs WHERE id=?').get(job.id) as
        { workspace_id: string | null } | undefined
      const workspaceId = workspace?.workspace_id ?? job.workspace_id
      if (!failure && finalStatus === 'succeeded') {
        try {
          const delivery = this.deliveries.completeRuntime({
            cardId: job.card_id,
            jobId: job.id,
            sessionId,
            workspaceId,
            provider: job.provider,
            actor: 'runtime',
            summary,
          })
          deliveryId = delivery.id
          to = delivery.status === 'accepted' && card?.column_name === 'done' ? 'done' : 'review'
        } catch (error) {
          deliveryFailure = error instanceof Error ? error.message : String(error)
          new AttentionService(this.db).create({
            boardId: job.board_id,
            workspaceId,
            cardId: job.card_id,
            agentId,
            kind: 'delivery.report_blocked',
            severity: 'high',
            title: `Delivery report blocked for card #${job.card_id}`,
            detail: deliveryFailure,
          })
        }
      }
      this.db.prepare(`UPDATE cards SET owner_agent_id=NULL, column_name=?, updated_at=datetime('now')
        WHERE id=? AND (owner_agent_id IS NULL OR owner_agent_id IS ?)`).run(to, job.card_id, agentId)
      const recorded = this.db.prepare(`SELECT 1 FROM card_events
        WHERE card_id=? AND type='agent_os_job_finished' AND json_valid(payload)
          AND json_extract(payload, '$.job_id')=? LIMIT 1`).get(job.card_id, job.id)
      if (!recorded) this.db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload)
        VALUES (?, ?, 'agent_os_job_finished', ?)`).run(
        job.card_id,
        agentId,
        JSON.stringify({
          job_id: job.id,
          delivery_id: deliveryId,
          provider: job.provider,
          status: finalStatus ?? null,
          failure: failure ?? deliveryFailure,
          to,
        }),
      )
      if (to === 'review') {
        if (!hasOpenReviewRequest(this.db, job.card_id)) {
          this.db.prepare(`INSERT INTO card_events (card_id, agent_id, type, payload)
            VALUES (?, ?, 'review_request', ?)`).run(job.card_id, agentId, JSON.stringify({
              summary,
              delivery_id: deliveryId,
              job_id: job.id,
              branch: null,
              diffstat: '',
            }))
        }
        const reviewCard = this.db.prepare('SELECT title, milestone_id, step_order FROM cards WHERE id=?').get(job.card_id) as
          { title: string; milestone_id: number | null; step_order: number | null }
        this.bus.current?.emit('event', {
          board_id: job.board_id,
          type: 'review',
          data: {
            card_id: job.card_id,
            card_title: reviewCard.title,
            milestone_id: reviewCard.milestone_id,
            step_order: reviewCard.step_order,
            agent_name: null,
            status: 'awaiting_approval',
            summary,
            delivery_id: deliveryId,
          },
        })
      }
      const updatedCard = this.db.prepare('SELECT * FROM cards WHERE id=?').get(job.card_id)
      this.bus.current?.emit('event', { board_id: job.board_id, type: 'card', data: updatedCard })
    }
    if (!agentId || context.managed_identity !== true) return
    this.db.prepare(`UPDATE agents SET status='gone', provider_state_json=?, last_seen=datetime('now') WHERE id=?`).run(
      JSON.stringify({
        ...context,
        job_id: job.id,
        lifecycle: 'stopped',
        final_status: finalStatus ?? null,
        failure: failure ?? null,
      }),
      agentId,
    )
    const agent = this.db.prepare('SELECT * FROM agents WHERE id=?').get(agentId)
    this.bus.current?.emit('event', { board_id: job.board_id, type: 'agent', data: agent })
  }

  private completionSummary(sessionId: string): string {
    const rows = this.db.prepare(`SELECT payload, created_at FROM (
      SELECT rowid, payload, created_at FROM os_events
      WHERE session_id=? AND kind='driver.output' ORDER BY rowid DESC LIMIT 5000
    ) ORDER BY rowid`).all(sessionId) as Array<{ payload: string; created_at: string }>
    const events = rows.flatMap((row, index): DriverEvent[] => {
      let payload: Record<string, unknown>
      try { payload = JSON.parse(row.payload) as Record<string, unknown> } catch { return [] }
      const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata as Record<string, unknown> : {}
      if (typeof metadata.transcriptKind === 'string' && metadata.transcriptKind !== 'text') return []
      const data = typeof payload.data === 'string' ? payload.data : ''
      if (!data.trim()) return []
      return [{
        sessionId,
        seq: Number.isFinite(Number(payload.seq)) ? Number(payload.seq) : index + 1,
        type: 'output',
        at: row.created_at,
        data,
        metadata,
      }]
    })
    const summary = [...projectDriverTranscript(events)].reverse()
      .find((line) => line.kind === 'text' && line.text.trim())?.text.trim()
    if (!summary) return 'Provider completed the job without a final textual report.'
    return summary.length > 4_000 ? `${summary.slice(0, 3_997)}...` : summary
  }

  private codexUsageBreakdown(event: DriverEvent): ProviderUsageSplit | null {
    const container = event.metadata?.tokenUsage ?? event.metadata?.usage
    if (!container || typeof container !== 'object') return null
    const total = (container as Record<string, unknown>).total
    return total && typeof total === 'object' ? fromCodexUsage(total) : null
  }

  private recordManagedProviderUsage(sessionId: string, total: ProviderUsageSplit): void {
    const row = this.db.prepare(`SELECT s.agent_id, s.provider, s.context_json, a.board_id
      FROM agent_sessions s LEFT JOIN agents a ON a.id=s.agent_id WHERE s.id=?`).get(sessionId) as
      { agent_id: number | null; provider: string; context_json: string; board_id: number | null } | undefined
    if (!row?.agent_id || row.provider !== 'codex') return
    let context: Record<string, unknown> = {}
    try { context = JSON.parse(row.context_json) as Record<string, unknown> } catch { /* legacy */ }
    const prior = context.usage_total && typeof context.usage_total === 'object'
      ? fromCodexUsage(context.usage_total)
      : fromCodexUsage({})
    const delta: ProviderUsageSplit = {
      provider: 'codex',
      total_tokens: Math.max(0, total.total_tokens - prior.total_tokens),
      input_tokens: Math.max(0, total.input_tokens - prior.input_tokens),
      cached_input_tokens: Math.max(0, total.cached_input_tokens - prior.cached_input_tokens),
      cache_creation_input_tokens: 0,
      output_tokens: Math.max(0, total.output_tokens - prior.output_tokens),
      reasoning_output_tokens: Math.max(0, total.reasoning_output_tokens - prior.reasoning_output_tokens),
      cost_cents: null,
    }
    if (delta.total_tokens > 0 && row.board_id) recordProviderUsage(this.db, row.board_id, row.agent_id, delta)
    context.usage_total = total
    this.db.prepare('UPDATE agent_sessions SET context_json=?, updated_at=datetime(\'now\') WHERE id=?')
      .run(JSON.stringify(context), sessionId)
  }

  private reportedTokens(event: DriverEvent): number | null {
    const value = Number(event.metadata?.tokens)
    return Number.isFinite(value) && value >= 0 ? value : null
  }

  private reportedCents(event: DriverEvent): number | null {
    const usd = Number(event.metadata?.costUsd)
    return Number.isFinite(usd) && usd >= 0 ? Math.ceil(usd * 100) : null
  }

  private recordDriverEvent(job: Job, sessionId: string, event: DriverEvent): void {
    this.trackManagedEvent(sessionId, event)
    const projection = projectManagedDriverEvent(event, job.driver_id)
    const durablePayload = projection.payload
    const current = this.db.prepare('SELECT workspace_id FROM jobs WHERE id=?').get(job.id) as { workspace_id: string | null } | undefined
    const previous = this.db.prepare(`SELECT id, correlation_id FROM os_events
      WHERE job_id=? ORDER BY rowid DESC LIMIT 1`).get(job.id) as
      { id: string; correlation_id: string | null } | undefined
    new EventStore(this.db).append({
      boardId: job.board_id,
      workspaceId: current?.workspace_id,
      cardId: job.card_id,
      sessionId,
      jobId: job.id,
      contractId: job.card_id && job.contract_version ? `card:${job.card_id}:v${job.contract_version}` : null,
      correlationId: previous?.correlation_id ?? job.id,
      causationId: previous?.id ?? null,
      kind: `driver.${event.type}`,
      source: job.driver_id,
      payload: durablePayload,
      createdAt: event.at,
    })
    if (event.type !== 'output') this.bus.current?.emit('event', {
      board_id: job.board_id,
      type: 'os:driver',
      data: {
        job_id: job.id,
        session_id: sessionId,
        type: event.type,
        data: projection.classification === 'approval' ? event.data : durablePayload.data,
        metadata: projection.classification === 'approval' ? event.metadata ?? {} : durablePayload.metadata,
      },
    })
  }

  private recordSessionTransition(
    job: Job,
    sessionId: string,
    status: 'stopped' | 'failed',
    source: string,
  ): void {
    const previous = this.db.prepare(`SELECT id, correlation_id FROM os_events
      WHERE job_id=? ORDER BY rowid DESC LIMIT 1`).get(job.id) as
      { id: string; correlation_id: string | null } | undefined
    new EventStore(this.db).append({
      boardId: job.board_id,
      workspaceId: job.workspace_id,
      cardId: job.card_id,
      sessionId,
      jobId: job.id,
      contractId: job.card_id && job.contract_version ? `card:${job.card_id}:v${job.contract_version}` : null,
      correlationId: previous?.correlation_id ?? job.id,
      causationId: previous?.id ?? null,
      idempotencyKey: `job:${job.id}:session-${status}:${Math.max(1, job.attempts)}`,
      kind: `agent_session.${status}`,
      source,
      payload: { job_id: job.id, session_id: sessionId, attempt: job.attempts },
    })
  }

  private sessionForJob(jobId: string): {
    id: string
    provider: string
    external_id: string | null
    model: string | null
    effort: string | null
    access_profile: 'read_only' | 'workspace_write' | 'full_access' | null
    control_state: AgentSessionRecord['control_state']
  } | undefined {
    return this.db.prepare(`SELECT s.id, s.provider, s.external_id,
      COALESCE(a.model, s.model) AS model, a.effort, a.access_profile, s.control_state
      FROM agent_sessions s LEFT JOIN agents a ON a.id=s.agent_id
      WHERE json_valid(s.context_json) AND json_extract(s.context_json, '$.job_id')=?
      ORDER BY s.updated_at DESC, s.rowid DESC LIMIT 1`).get(jobId) as {
        id: string
        provider: string
        external_id: string | null
        model: string | null
        effort: string | null
        access_profile: 'read_only' | 'workspace_write' | 'full_access' | null
        control_state: AgentSessionRecord['control_state']
      } | undefined
  }

  private controlForAgent(agentId: number): { job: Job; sessionId: string; live?: LiveJob } | undefined {
    const row = this.db.prepare(`SELECT s.id AS session_id, j.* FROM agent_sessions s
      JOIN jobs j ON j.id=json_extract(s.context_json, '$.job_id')
      JOIN agents a ON a.id=s.agent_id
      WHERE s.agent_id=? AND a.session_id=('agent-os:' || j.id)
      ORDER BY s.updated_at DESC, s.rowid DESC LIMIT 1`).get(agentId) as
      (Record<string, unknown> & { session_id: string }) | undefined
    if (!row) return undefined
    const job = mapRuntimeJob(row)
    return { job, sessionId: String(row.session_id), live: this.live.get(job.id) }
  }

  private controlForSession(sessionId: string): { job: Job; sessionId: string; live?: LiveJob } | undefined {
    const row = this.db.prepare(`SELECT s.id AS session_id, j.* FROM agent_sessions s
      JOIN jobs j ON j.id=coalesce(
        s.job_id,
        CASE WHEN json_valid(s.context_json) THEN json_extract(s.context_json, '$.job_id') END
      )
      WHERE s.id=?`).get(sessionId) as
      (Record<string, unknown> & { session_id: string }) | undefined
    if (!row) return undefined
    const job = mapRuntimeJob(row)
    return { job, sessionId: String(row.session_id), live: this.live.get(job.id) }
  }

  private trackManagedEvent(sessionId: string, event: DriverEvent): void {
    const row = this.db.prepare('SELECT agent_id FROM agent_sessions WHERE id=?').get(sessionId) as
      { agent_id: number | null } | undefined
    if (!row?.agent_id) return
    const agentId = row.agent_id
    const metadata = event.metadata ?? {}
    const requestId = typeof metadata.requestId === 'string' ? metadata.requestId : undefined
    if (requestId && (metadata.approval === true || metadata.kind === 'approval')) {
      const approvals = this.pendingApprovals.get(agentId) ?? new Map<string, Record<string, unknown>>()
      approvals.set(requestId, {
        id: requestId,
        at: event.at,
        title: `${String(metadata.approvalKind ?? 'tool').replaceAll('-', ' ')} approval`,
        summary: event.data,
        ...metadata,
      })
      this.pendingApprovals.set(agentId, approvals)
    }
    const subagentId = typeof metadata.subagentId === 'string' ? metadata.subagentId : undefined
    if (subagentId && metadata.subagentStatus === 'started') {
      const subagents = this.managedSubagents.get(agentId) ?? new Map<string, string>()
      subagents.set(subagentId, String(metadata.label ?? 'subagent'))
      this.managedSubagents.set(agentId, subagents)
    }
    if (subagentId && metadata.subagentStatus === 'stopped') this.managedSubagents.get(agentId)?.delete(subagentId)
    if (event.type === 'exit') {
      this.pendingApprovals.delete(agentId)
      this.managedSubagents.delete(agentId)
    }
  }

  private markSessionFailed(id: string): void {
    this.db.prepare("UPDATE agent_sessions SET status='failed', updated_at=datetime('now') WHERE id=?").run(id)
  }

  private markSessionLost(id: string): void {
    this.db.prepare(`UPDATE agent_sessions
      SET status='lost', control_state='stopped', recovery_state='lost',
        ended_at=coalesce(ended_at, datetime('now')), updated_at=datetime('now')
      WHERE id=?`).run(id)
  }
}

const mapRuntimeJob = (row: Record<string, unknown>): Job => {
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
    priority: Number(row.priority), status: String(row.status) as Job['status'],
    attempts: Number(row.attempts), max_attempts: Number(row.max_attempts),
    budget_tokens: row.budget_tokens == null ? null : Number(row.budget_tokens),
    budget_cents: row.budget_cents == null ? null : Number(row.budget_cents),
    spent_tokens: Number(row.spent_tokens ?? 0), spent_cents: Number(row.spent_cents ?? 0),
    scheduled_at: String(row.scheduled_at), started_at: row.started_at == null ? null : String(row.started_at),
    finished_at: row.finished_at == null ? null : String(row.finished_at), error: row.error == null ? null : String(row.error),
    created_at: String(row.created_at),
  }
}
