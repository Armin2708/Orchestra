import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
  AgentHomeForkOperation,
  AgentHomeRuntimeControl,
  RuntimeActionCapabilities,
} from './agent-home-lifecycle.js'
import {
  AgentHomeForkOutcomeUnknownError,
  forkTargetFromEffect,
  type AgentHomeForkTarget,
  type AgentHomeKnownForkChild,
  type AgentHomeNativeForkResult,
} from './agent-home-fork.js'
import { ConversationService, type AgentSessionRecord } from './conversations.js'
import { parseJson } from './json.js'
import { projectManagedDriverEvent } from './managed-driver-event-projection.js'
import { ManagedAgentSessionBinder, type ManagedAgentSessionBinding } from './managed-session-binding.js'
import {
  KnowledgeRuntimeIntegration,
  type ManagedKnowledgePrompt,
} from './knowledge-runtime-integration.js'
import { OpenWorkService } from './open-work.js'
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
import {
  ProviderAdapterRegistryV1,
  type DeclaredProviderAcceptanceMatrixV1,
} from '../provider-adapter-registry.js'
import type { ProviderExecutionAdapterV1 } from '../provider-contract.js'
import {
  ProviderAcceptanceEvidenceStoreV1,
  type ProviderAcceptanceArtifactV1,
  type ProviderAcceptanceEvidenceRecordV1,
} from '../provider-acceptance-evidence-store.js'

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
  providerAdapters: ProviderAdapterRegistryV1
  providerAcceptanceEvidence: ProviderAcceptanceEvidenceStoreV1
  jobExecutor: AgentOsJobExecutor
  scheduler: JobScheduler
  adapter: AgentOsRuntimeAdapter
  descriptors(): DriverDescriptor[]
  registerDriver(driver: AgentDriver): void
  registerProviderAdapter(adapter: ProviderExecutionAdapterV1): void
  recordProviderAcceptance(
    matrix: DeclaredProviderAcceptanceMatrixV1,
    artifact: ProviderAcceptanceArtifactV1,
  ): ProviderAcceptanceEvidenceRecordV1
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
    stopProcess: async (processId) => mapApiProcess(await layer.supervisor.stop(processId)),
    restartProcess: async (processId) => mapApiProcess(await layer.supervisor.restart(processId)),
    listProcessPorts: (workspaceId) => layer.supervisor.discoverPorts(workspaceId),
    captureCheckpoint,
    forkCheckpoint,
  }

  const jobExecutor = new AgentOsJobExecutor(db, layer.drivers, workspaceManager, bus)
  const scheduler = new JobScheduler(db, jobExecutor)
  const providerAdapters = new ProviderAdapterRegistryV1()
  const providerAcceptanceEvidence = new ProviderAcceptanceEvidenceStoreV1(db)
  providerAcceptanceEvidence.hydrate(providerAdapters)
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
    providerAdapters,
    providerAcceptanceEvidence,
    jobExecutor,
    scheduler,
    adapter,
    descriptors: () => layer.drivers.list().map(({ id, capabilities }) => ({
      id,
      available: true,
      capabilities: Object.entries(capabilities).filter(([, enabled]) => enabled).map(([name]) => name),
    })),
    registerDriver,
    registerProviderAdapter: (adapter) => {
      providerAdapters.register(adapter)
    },
    recordProviderAcceptance: (matrix, artifact) =>
      providerAcceptanceEvidence.record(providerAdapters, matrix, artifact),
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

type DriverNativeForkResult = {
  sourceExternalId: string
  externalId: string
  providerThreadId: string
  sourceProviderThreadId: string
  metadata: Record<string, unknown>
}

type NativeForkDriver = AgentDriver & {
  forkSession(
    sessionId: string,
    options: {
      sourceExternalId: string
      sourceWorkspaceId: string
      sourceCwd: string
      targetWorkspaceId: string
      targetCwd: string
      lastTurnId?: string
      // Backward-compatible aliases used only by the current Claude adapter.
      workspaceId: string
      cwd: string
    },
  ): Promise<DriverNativeForkResult>
  verifyForkSession?(
    options: {
      sourceExternalId: string
      childExternalId: string
      childProviderThreadId: string
      childProviderSessionId: string | null
      sourceWorkspaceId: string
      sourceCwd: string
      targetWorkspaceId: string
      targetCwd: string
      lastTurnId?: string
    },
  ): Promise<DriverNativeForkResult>
}

type DriverForkOutcomeUnknown = Error & {
  outcomeUnknown: true
  sourceExternalId: string
  sourceProviderThreadId: string
  knownChild?: {
    externalId: string
    providerThreadId: string
    forkedFromId: string | null
    childProviderSessionId: string | null
    subscriptionReleased: boolean
  } | null
}

function isNativeForkDriver(driver: AgentDriver): driver is NativeForkDriver {
  return typeof (driver as Partial<NativeForkDriver>).forkSession === 'function'
}

function safeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function safeIdentity(value: unknown, fallback: string): string {
  return safeOptionalString(value) ?? fallback
}

function samePath(value: unknown, expected: string): boolean {
  return typeof value === 'string'
    && value.trim().length > 0
    && path.resolve(value) === path.resolve(expected)
}

function hasOrchestratorWorkspaceAttestation(
  value: unknown,
  expectedWorkspaceId: string,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const attestation = value as Record<string, unknown>
  return attestation.authority === 'orchestrator'
    && attestation.value === expectedWorkspaceId
}

async function isolatedForkWorkspaces(
  source: WorkspaceRecord,
  target: WorkspaceRecord,
): Promise<boolean> {
  try {
    const [sourceRepo, targetRepo, sourceExecution, targetExecution] = await Promise.all([
      realpath(source.rootPath),
      realpath(target.rootPath),
      realpath(source.worktreePath ?? source.rootPath),
      realpath(target.worktreePath ?? target.rootPath),
    ])
    return sourceRepo === targetRepo && sourceExecution !== targetExecution
  } catch {
    return false
  }
}

function safeKnownForkChild(
  value: unknown,
): AgentHomeForkOutcomeUnknownError['knownChild'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const child = value as Record<string, unknown>
  const externalId = safeOptionalString(child.externalId)
  const providerThreadId = safeOptionalString(child.providerThreadId)
  if (!externalId || !providerThreadId || providerThreadId !== externalId) return null
  const forkedFromId = child.forkedFromId == null
    ? null
    : safeOptionalString(child.forkedFromId)
  const childProviderSessionId = child.childProviderSessionId == null
    ? null
    : safeOptionalString(child.childProviderSessionId)
  if ((child.forkedFromId != null && !forkedFromId)
    || (child.childProviderSessionId != null && !childProviderSessionId)
    || typeof child.subscriptionReleased !== 'boolean') {
    return null
  }
  return {
    externalId,
    providerThreadId,
    forkedFromId,
    childProviderSessionId,
    subscriptionReleased: child.subscriptionReleased,
  }
}

function isDriverForkOutcomeUnknown(error: unknown): error is DriverForkOutcomeUnknown {
  if (!(error instanceof Error)) return false
  const candidate = error as Partial<DriverForkOutcomeUnknown>
  if (candidate.outcomeUnknown !== true
    || !safeOptionalString(candidate.sourceExternalId)
    || !safeOptionalString(candidate.sourceProviderThreadId)) {
    return false
  }
  return candidate.knownChild == null || safeKnownForkChild(candidate.knownChild) !== null
}

/** Executes durable jobs through provider-neutral drivers and completes them from driver events. */
export class AgentOsJobExecutor implements JobExecutor, AgentHomeRuntimeControl {
  private readonly live = new Map<string, LiveJob>()
  /** Parked native-fork bindings are keyed only by their durable child session id. */
  private readonly forkLive = new Map<string, LiveJob>()
  private readonly forkAdoptions = new Map<string, Promise<void>>()
  private readonly forkStopIntents = new Set<string>()
  private readonly pausedJobs = new Set<string>()
  private readonly pendingApprovals = new Map<number, Map<string, Record<string, unknown>>>()
  private readonly managedSubagents = new Map<number, Map<string, string>>()
  private readonly deliveries: DeliveryLifecycleIntegration
  private readonly knowledge: KnowledgeRuntimeIntegration
  private scheduler?: JobScheduler
  private shuttingDown = false

  constructor(
    private readonly db: Database.Database,
    private readonly drivers: DriverRegistry,
    private readonly workspaces: WorkspaceManager,
    private readonly bus: BusRef = {},
  ) {
    this.deliveries = new DeliveryLifecycleIntegration(db)
    this.knowledge = new KnowledgeRuntimeIntegration(db)
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
    const attached = this.forkLive.get(session.id) ?? control?.live
    const live = !!attached
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
      stop: capabilities.stop && (this.forkLive.has(session.id) || activeJob)
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
      fork: (session.provider === 'claude' || session.provider === 'codex')
        && isNativeForkDriver(driver) && live && !!session.external_id
        && !!session.provider_thread_id
        ? { supported: true, reason: null }
        : {
            supported: false,
            reason: session.provider !== 'claude' && session.provider !== 'codex'
              ? `${session.provider} does not expose a verified native session fork contract`
              : !isNativeForkDriver(driver)
              ? `${session.provider} does not expose provenance-safe native session forking`
              : !session.external_id || !session.provider_thread_id
                ? 'fork requires durable provider session provenance'
                : 'the provider session is not attached to this daemon',
          },
    }
  }

  async pauseAgentHomeSession(sessionId: string): Promise<void> {
    const fork = this.forkLive.get(sessionId)
    if (fork) {
      if (!fork.driver.capabilities().interrupt) {
        throw new UnsupportedError(`${fork.driver.id} does not support interruption`)
      }
      await fork.driver.interrupt(fork.session.id)
      return
    }
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
    const fork = this.forkLive.get(sessionId)
    if (fork) {
      if (!fork.driver.capabilities().resume) {
        throw new UnsupportedError(`${fork.driver.id} does not support resumable sessions`)
      }
      await fork.driver.send(
        fork.session.id,
        'Resume this independent Agent Home fork from its durable conversation and isolated workspace. Verify existing work before continuing.',
      )
      return
    }
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
    const fork = this.forkLive.get(sessionId)
    if (fork) {
      if (!fork.driver.capabilities().stop) {
        throw new UnsupportedError(`${fork.driver.id} does not support session stop`)
      }
      this.forkStopIntents.add(sessionId)
      try {
        await fork.driver.stop(fork.session.id)
      } catch (error) {
        this.forkStopIntents.delete(sessionId)
        throw error
      }
      if (this.forkLive.get(sessionId)?.session.id === fork.session.id) {
        this.forkLive.delete(sessionId)
      }
      this.db.prepare(`UPDATE agent_sessions SET status='stopped',
        control_state='stopped', ended_at=coalesce(ended_at, datetime('now')),
        updated_at=datetime('now')
        WHERE id=? AND external_id=? AND workspace_id=?`).run(
        sessionId,
        fork.session.externalId,
        fork.session.workspaceId,
      )
      return
    }
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

  async prepareAgentHomeForkSession(
    session: AgentSessionRecord,
    operation: AgentHomeForkOperation,
  ): Promise<AgentHomeForkTarget> {
    if (operation.reservedSessionId === session.id) {
      throw new ConflictError('fork child reservation cannot reuse the parent session')
    }
    const source = await this.workspaces.get(session.workspace_id)
    if (!source || source.status !== 'active') {
      throw new ConflictError('fork source workspace is unavailable')
    }
    const target = await this.workspaces.create({
      boardId: source.boardId,
      cardId: source.cardId,
      name: `fork-${operation.reservedSessionId}`,
      kind: 'worktree',
      rootPath: source.rootPath,
      branch: `orchestra/fork-${operation.reservedSessionId}`,
      baseRef: source.branch ?? source.baseRef ?? 'HEAD',
      reuseExisting: true,
    })
    if (target.id === source.id
      || target.boardId !== source.boardId
      || target.kind !== 'worktree'
      || target.status !== 'active'
      || !target.worktreePath
      || !(await isolatedForkWorkspaces(source, target))) {
      throw new ConflictError('fork target did not resolve to a distinct managed worktree')
    }
    return { workspaceId: target.id }
  }

  async forkAgentHomeSession(
    session: AgentSessionRecord,
    operation: AgentHomeForkOperation & AgentHomeForkTarget,
  ): Promise<AgentHomeNativeForkResult> {
    const attached = this.forkLive.get(session.id) ?? this.controlForSession(session.id)?.live
    if (!attached) {
      throw new ConflictError('the provider session is not attached to this daemon')
    }
    if (session.provider !== 'claude' && session.provider !== 'codex') {
      throw new UnsupportedError(
        `${session.provider} does not expose a verified native session fork contract`,
      )
    }
    if (!isNativeForkDriver(attached.driver)) {
      throw new UnsupportedError(
        `${session.provider} does not expose provenance-safe native session forking`,
      )
    }
    if (!session.external_id || !session.provider_thread_id) {
      throw new ConflictError('fork requires durable provider session provenance')
    }
    const expectedDriverId = session.driver_id ?? session.provider
    if (attached.driver.id !== expectedDriverId
      || attached.session.externalId !== session.external_id
      || attached.session.workspaceId !== session.workspace_id) {
      throw new ConflictError('fork runtime binding no longer matches the durable session')
    }
    if (operation.reservedSessionId === session.id
      || operation.workspaceId === session.workspace_id) {
      throw new ConflictError('fork target cannot reuse the parent live binding')
    }
    const sourceWorkspace = await this.workspaces.get(session.workspace_id)
    const targetWorkspace = await this.workspaces.get(operation.workspaceId)
    if (!sourceWorkspace || !targetWorkspace
      || targetWorkspace.boardId !== sourceWorkspace.boardId
      || targetWorkspace.kind !== 'worktree'
      || targetWorkspace.status !== 'active'
      || !targetWorkspace.worktreePath
      || !(await isolatedForkWorkspaces(sourceWorkspace, targetWorkspace))) {
      throw new ConflictError('fork target workspace binding is invalid')
    }
    const sourceCwd = this.workspaces.root(sourceWorkspace)
    const targetCwd = this.workspaces.root(targetWorkspace)
    if (path.resolve(sourceCwd) === path.resolve(targetCwd)) {
      throw new ConflictError('fork target execution root cannot reuse the parent cwd')
    }
    let result: DriverNativeForkResult
    try {
      result = await attached.driver.forkSession(attached.session.id, {
        sourceExternalId: session.external_id,
        sourceWorkspaceId: session.workspace_id,
        sourceCwd,
        targetWorkspaceId: operation.workspaceId,
        targetCwd,
        workspaceId: session.workspace_id,
        cwd: sourceCwd,
      })
    } catch (error) {
      if (isDriverForkOutcomeUnknown(error)) {
        throw new AgentHomeForkOutcomeUnknownError(
          'provider fork outcome is unknown',
          safeIdentity(error.sourceExternalId, session.external_id),
          safeIdentity(error.sourceProviderThreadId, session.provider_thread_id),
          safeKnownForkChild(error.knownChild),
        )
      }
      throw new AgentHomeForkOutcomeUnknownError(
        'provider fork outcome is unknown',
        session.external_id,
        session.provider_thread_id,
      )
    }
    if (result.sourceExternalId !== session.external_id
      || result.sourceProviderThreadId !== session.provider_thread_id
      || !result.externalId
      || result.externalId === session.external_id
      || result.providerThreadId !== result.externalId) {
      throw new AgentHomeForkOutcomeUnknownError(
        'provider fork returned inconsistent provenance',
        session.external_id,
        session.provider_thread_id,
        result.externalId && result.providerThreadId ? {
          externalId: result.externalId,
          providerThreadId: result.providerThreadId,
          forkedFromId: safeOptionalString(result.metadata.forkedFromId),
          childProviderSessionId: safeOptionalString(result.metadata.providerSessionId),
          subscriptionReleased: result.metadata.subscriptionReleased === true,
        } : null,
      )
    }

    if (session.provider === 'claude') {
      if (result.metadata.forkMethod !== 'sdk.forkSession'
        || result.metadata.fileHistoryCopied !== false
        || result.metadata.undoHistoryCopied !== false) {
        throw new AgentHomeForkOutcomeUnknownError(
          'Claude fork returned incomplete history provenance',
          session.external_id,
          session.provider_thread_id,
          {
            externalId: result.externalId,
            providerThreadId: result.providerThreadId,
            forkedFromId: null,
            childProviderSessionId: null,
            subscriptionReleased: false,
          },
        )
      }
      return {
        sourceExternalId: result.sourceExternalId,
        externalId: result.externalId,
        sourceProviderThreadId: result.sourceProviderThreadId,
        providerThreadId: result.providerThreadId,
        provenance: {
          fork_method: 'sdk.forkSession',
          history_boundary: 'full',
          file_history_copied: false,
          undo_history_copied: false,
        },
      }
    }
    if (session.provider === 'codex'
      && result.metadata.forkMethod === 'thread/fork'
      && result.metadata.forkedFromId === session.provider_thread_id
      && safeOptionalString(result.metadata.providerSessionId) !== null
      && hasOrchestratorWorkspaceAttestation(
        result.metadata.targetWorkspaceAttestation,
        operation.workspaceId,
      )
      && samePath(result.metadata.childCwd ?? result.metadata.targetCwd, targetCwd)
      && result.metadata.cwdVerified === true
      && result.metadata.threadReadVerified === true
      && result.metadata.childUnsubscribeVerified === true
      && result.metadata.readVerified === true
      && result.metadata.subscriptionReleased === true) {
      return {
        sourceExternalId: result.sourceExternalId,
        externalId: result.externalId,
        sourceProviderThreadId: result.sourceProviderThreadId,
        providerThreadId: result.providerThreadId,
        provenance: {
          fork_method: 'thread/fork',
          history_boundary: 'full',
          read_verified: result.metadata.readVerified === true,
          subscription_released: result.metadata.subscriptionReleased === true,
        },
      }
    }
    throw new AgentHomeForkOutcomeUnknownError(
      'provider fork returned an incomplete or unsupported provenance contract',
      session.external_id,
      session.provider_thread_id,
      {
        externalId: result.externalId,
        providerThreadId: result.providerThreadId,
        forkedFromId: safeOptionalString(result.metadata.forkedFromId),
        childProviderSessionId: safeOptionalString(result.metadata.providerSessionId),
        subscriptionReleased: result.metadata.subscriptionReleased === true,
      },
    )
  }

  async verifyAgentHomeForkChild(
    session: AgentSessionRecord,
    child: AgentHomeKnownForkChild,
    operation: AgentHomeForkOperation & AgentHomeForkTarget,
  ): Promise<AgentHomeNativeForkResult> {
    if (!session.external_id || !session.provider_thread_id) {
      throw new ConflictError('fork verification requires durable source provenance')
    }
    if (!child.externalId
      || child.providerThreadId !== child.externalId
      || child.externalId === session.external_id
      || child.subscriptionReleased !== true
      || (child.forkedFromId !== null
        && child.forkedFromId !== session.provider_thread_id)) {
      throw new ConflictError('fork verification child identity is inconsistent')
    }
    const driver = this.drivers.get(session.driver_id ?? session.provider)
    if (!driver || !isNativeForkDriver(driver) || !driver.verifyForkSession) {
      throw new UnsupportedError(
        `${session.provider} does not expose read-only exact-child fork verification`,
      )
    }
    const sourceWorkspace = await this.workspaces.get(session.workspace_id)
    const targetWorkspace = await this.workspaces.get(operation.workspaceId)
    if (!sourceWorkspace || !targetWorkspace
      || targetWorkspace.boardId !== sourceWorkspace.boardId
      || targetWorkspace.kind !== 'worktree'
      || targetWorkspace.status !== 'active'
      || !targetWorkspace.worktreePath
      || !(await isolatedForkWorkspaces(sourceWorkspace, targetWorkspace))) {
      throw new ConflictError('fork verification target workspace is invalid')
    }
    const sourceCwd = this.workspaces.root(sourceWorkspace)
    const targetCwd = this.workspaces.root(targetWorkspace)
    if (path.resolve(sourceCwd) === path.resolve(targetCwd)) {
      throw new ConflictError('fork verification target cannot reuse the parent cwd')
    }
    // This provider contract is intentionally verification-only. It receives no
    // prompt and no source driver session id, so it cannot resume, start, or fork.
    const verified = await driver.verifyForkSession({
      sourceExternalId: session.external_id,
      childExternalId: child.externalId,
      childProviderThreadId: child.providerThreadId,
      childProviderSessionId: child.childProviderSessionId,
      sourceWorkspaceId: session.workspace_id,
      sourceCwd,
      targetWorkspaceId: operation.workspaceId,
      targetCwd,
    })
    if (verified.sourceExternalId !== session.external_id
      || verified.sourceProviderThreadId !== session.provider_thread_id
      || verified.externalId !== child.externalId
      || verified.providerThreadId !== child.providerThreadId) {
      throw new ConflictError('read-only fork verification returned another child')
    }
    if (session.provider === 'codex') {
      const verifiedProviderSessionId = safeOptionalString(
        verified.metadata.providerSessionId,
      )
      if (verified.metadata.forkMethod !== 'thread/fork'
        || verified.metadata.forkedFromId !== session.provider_thread_id
        || verifiedProviderSessionId === null
        || (child.childProviderSessionId !== null
          && verifiedProviderSessionId !== child.childProviderSessionId)
        || !hasOrchestratorWorkspaceAttestation(
          verified.metadata.targetWorkspaceAttestation,
          operation.workspaceId,
        )
        || !samePath(
          verified.metadata.childCwd ?? verified.metadata.targetCwd,
          targetCwd,
        )
        || verified.metadata.cwdVerified !== true
        || verified.metadata.threadReadVerified !== true
        || verified.metadata.readVerified !== true) {
        throw new ConflictError('read-only Codex fork verification proof is incomplete')
      }
      return {
        sourceExternalId: verified.sourceExternalId,
        externalId: verified.externalId,
        sourceProviderThreadId: verified.sourceProviderThreadId,
        providerThreadId: verified.providerThreadId,
        provenance: {
          fork_method: 'thread/fork',
          history_boundary: 'full',
          read_verified: true,
          subscription_released: child.subscriptionReleased,
        },
      }
    }
    if (session.provider === 'claude'
      && verified.metadata.forkMethod === 'sdk.forkSession'
      && verified.metadata.fileHistoryCopied === false
      && verified.metadata.undoHistoryCopied === false) {
      return {
        sourceExternalId: verified.sourceExternalId,
        externalId: verified.externalId,
        sourceProviderThreadId: verified.sourceProviderThreadId,
        providerThreadId: verified.providerThreadId,
        provenance: {
          fork_method: 'sdk.forkSession',
          history_boundary: 'full',
          file_history_copied: false,
          undo_history_copied: false,
        },
      }
    }
    throw new ConflictError('provider read-only fork verification contract is unsupported')
  }

  async adoptAgentHomeForkSession(
    parent: AgentSessionRecord,
    child: AgentSessionRecord,
    operation: AgentHomeForkOperation,
  ): Promise<void> {
    const existing = this.forkLive.get(child.id)
    if (existing) {
      this.assertExactForkRuntimeBinding(parent, child, existing)
      return
    }
    const inFlight = this.forkAdoptions.get(child.id)
    if (inFlight) {
      await inFlight
      const adopted = this.forkLive.get(child.id)
      if (!adopted) throw new ConflictError('fork adoption did not retain its child binding')
      this.assertExactForkRuntimeBinding(parent, child, adopted)
      return
    }
    const adoption = this.adoptForkSessionNow(parent, child, operation)
    this.forkAdoptions.set(child.id, adoption)
    try {
      await adoption
    } finally {
      if (this.forkAdoptions.get(child.id) === adoption) {
        this.forkAdoptions.delete(child.id)
      }
    }
  }

  private async adoptForkSessionNow(
    parent: AgentSessionRecord,
    child: AgentSessionRecord,
    operation: AgentHomeForkOperation,
  ): Promise<void> {
    if (operation.reservedSessionId !== child.id
      || child.id === parent.id
      || child.parent_session_id !== parent.id
      || child.lineage_type !== 'fork'
      || child.provider !== parent.provider
      || child.workspace_id === parent.workspace_id
      || !child.external_id
      || child.external_id === parent.external_id
      || child.provider_thread_id !== child.external_id) {
      throw new ConflictError('fork adoption does not match the exact child reservation')
    }
    const action = this.db.prepare(`SELECT session_id, result_session_id,
      reserved_session_id, action, status, effect_state, effect_json
      FROM agent_session_actions WHERE id=?`).get(operation.actionId) as {
        session_id: string
        result_session_id: string | null
        reserved_session_id: string | null
        action: string
        status: string
        effect_state: string
        effect_json: string
      } | undefined
    const target = action
      ? forkTargetFromEffect(parseJson<Record<string, unknown>>(action.effect_json, {}))
      : null
    if (!action
      || action.action !== 'fork'
      || action.session_id !== parent.id
      || action.result_session_id !== child.id
      || action.reserved_session_id !== child.id
      || !['pending', 'succeeded'].includes(action.status)
      || !['applied', 'completed'].includes(action.effect_state)
      || target?.workspaceId !== child.workspace_id) {
      throw new ConflictError('fork adoption action ledger is inconsistent')
    }
    const sourceWorkspace = await this.workspaces.get(parent.workspace_id)
    const targetWorkspace = await this.workspaces.get(child.workspace_id)
    if (!sourceWorkspace || !targetWorkspace
      || targetWorkspace.boardId !== sourceWorkspace.boardId
      || targetWorkspace.kind !== 'worktree'
      || targetWorkspace.status !== 'active'
      || !targetWorkspace.worktreePath
      || !(await isolatedForkWorkspaces(sourceWorkspace, targetWorkspace))) {
      throw new ConflictError('fork adoption workspace isolation is invalid')
    }
    const driver = this.drivers.get(child.driver_id ?? child.provider)
    if (!driver) throw new UnsupportedError(`${child.provider} driver is not registered`)
    const parentLive = this.forkLive.get(parent.id) ?? this.controlForSession(parent.id)?.live
    const targetCwd = this.workspaces.root(targetWorkspace)
    let attached: DriverSession | null = null
    try {
      attached = child.provider === 'claude'
        ? await driver.launch({
            workspaceId: child.workspace_id,
            boardId: targetWorkspace.boardId,
            cwd: targetCwd,
            externalId: child.external_id,
            ...(child.model ? { model: child.model } : {}),
            ...(child.effort ? { effort: child.effort } : {}),
            ...(child.access_profile ? { accessProfile: child.access_profile } : {}),
            metadata: {
              agentHomeSessionId: child.id,
              agentProfileId: child.profile_id,
              agentConversationId: child.conversation_id,
              forkActionId: operation.actionId,
            },
          })
        : await driver.attach(child.external_id)
      if (!attached) throw new ConflictError('provider fork child is no longer attachable')
      const binding = { driver, session: attached }
      this.assertExactForkRuntimeBinding(parent, child, binding)
      if (parentLive
        && (attached.id === parentLive.session.id
          || attached.externalId === parentLive.session.externalId
          || attached.workspaceId === parentLive.session.workspaceId)) {
        throw new ConflictError('fork adoption attempted to reuse the parent live binding')
      }
      this.forkLive.set(child.id, binding)
      void this.watchForkSession(child.id, binding)
    } catch (error) {
      if (attached) await driver.detach?.(attached.id).catch(() => undefined)
      throw error
    }
  }

  private assertExactForkRuntimeBinding(
    parent: AgentSessionRecord,
    child: AgentSessionRecord,
    binding: LiveJob,
  ): void {
    const expectedDriverId = child.driver_id ?? child.provider
    if (binding.driver.id !== expectedDriverId
      || binding.session.driverId !== expectedDriverId
      || binding.session.externalId !== child.external_id
      || binding.session.externalId === parent.external_id
      || binding.session.workspaceId !== child.workspace_id
      || binding.session.workspaceId === parent.workspace_id) {
      throw new ConflictError('provider attached a different or non-isolated fork child')
    }
  }

  prepareShutdown(): void {
    this.shuttingDown = true
    for (const [sessionId, binding] of this.forkLive) {
      void binding.driver.detach?.(binding.session.id).catch(() => undefined)
      this.forkLive.delete(sessionId)
    }
    this.forkStopIntents.clear()
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
      const bindingError = this.recoveryBindingError(job, sessionRow)
      const driver = sessionRow
        ? this.drivers.get(sessionRow.driver_id ?? sessionRow.provider)
        : undefined
      if (bindingError || !sessionRow?.external_id || !driver || !driver.capabilities().resume) {
        this.pausedJobs.delete(job.id)
        if (sessionRow) this.markSessionFailed(sessionRow.id)
        const reason = bindingError
          ? `daemon restart recovery rejected: ${bindingError}`
          : `daemon restarted; ${job.provider} session cannot be resumed`
        const recoveredJob = this.scheduler.recover(job.id, reason)
        if (sessionRow) this.finalizeManagedAgent(job, sessionRow.id, reason, recoveredJob.status)
        recovered.push(job.id)
        continue
      }
      let providerSessionLost = false
      let attachedSession: DriverSession | null = null
      let attachedSessionTrusted = false
      let usedAuthorizedRecovery = false
      let recoveryHandleReleased = false
      const detachRecoveryHandle = async (): Promise<void> => {
        if (!attachedSession || recoveryHandleReleased || !attachedSession.id.trim()) return
        recoveryHandleReleased = true
        if (driver.detach) await driver.detach(attachedSession.id).catch(() => undefined)
      }
      const stopTrustedRecoveryHandle = async (): Promise<string | null> => {
        if (!attachedSession
          || !attachedSessionTrusted
          || recoveryHandleReleased
          || !attachedSession.id.trim()) return null
        recoveryHandleReleased = true
        try {
          await driver.stop(attachedSession.id)
          return null
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      }
      const revalidateDurableBinding = (): NonNullable<
        ReturnType<AgentOsJobExecutor['sessionForJob']>
      > => {
        const currentJob = this.scheduler!.get(job.id)
        if (!currentJob) throw new Error('durable job disappeared during provider recovery')
        if (currentJob.status !== 'running') {
          throw new Error(`durable job entered ${currentJob.status} during provider recovery`)
        }
        if (currentJob.board_id !== job.board_id
          || currentJob.card_id !== job.card_id
          || currentJob.workspace_id !== job.workspace_id
          || currentJob.provider !== job.provider
          || currentJob.driver_id !== job.driver_id
          || currentJob.job_assignment_id !== job.job_assignment_id
          || currentJob.assigned_profile_id !== job.assigned_profile_id
          || currentJob.assignment_market_version !== job.assignment_market_version) {
          throw new Error('durable job identity changed during provider recovery')
        }
        const currentSession = this.sessionForJob(job.id)
        if (!currentSession
          || currentSession.id !== sessionRow.id
          || currentSession.job_id !== sessionRow.job_id
          || currentSession.workspace_id !== sessionRow.workspace_id
          || currentSession.provider !== sessionRow.provider
          || currentSession.driver_id !== sessionRow.driver_id
          || currentSession.external_id !== sessionRow.external_id
          || currentSession.job_assignment_id !== sessionRow.job_assignment_id
          || currentSession.assigned_profile_id !== sessionRow.assigned_profile_id
          || currentSession.assignment_market_version !== sessionRow.assignment_market_version
          || currentSession.profile_id !== sessionRow.profile_id
          || currentSession.conversation_id !== sessionRow.conversation_id) {
          throw new Error('durable provider session identity changed during provider recovery')
        }
        if (!['starting', 'running', 'idle'].includes(currentSession.status)
          || !['active', 'paused'].includes(currentSession.control_state)) {
          throw new Error('durable provider session is no longer recoverable')
        }
        const durableBindingError = this.recoveryBindingError(currentJob, currentSession)
        if (durableBindingError) throw new Error(durableBindingError)
        if (!currentJob.workspace_id || !currentSession.external_id || !attachedSession) {
          throw new Error('durable provider session binding is incomplete')
        }
        const currentProviderBindingError = providerSessionBindingError({
          job: currentJob,
          driver,
          session: attachedSession,
          workspaceId: currentJob.workspace_id,
          externalId: currentSession.external_id,
        })
        if (currentProviderBindingError) {
          throw new Error(`attached ${currentProviderBindingError}`)
        }
        return currentSession
      }
      try {
        const durableWorkspace = await this.workspaces.get(job.workspace_id!)
        if (!durableWorkspace || durableWorkspace.status !== 'active') {
          throw new Error('durable recovery workspace is no longer active')
        }
        const recover = driver.recover
        usedAuthorizedRecovery = typeof recover === 'function'
        const session = recover
          ? await recover.call(driver, {
              externalId: sessionRow.external_id,
              workspaceId: job.workspace_id!,
              cwd: this.workspaces.root(durableWorkspace),
              ...(sessionRow.model ? { model: sessionRow.model } : {}),
              ...(sessionRow.effort ? { effort: sessionRow.effort } : {}),
              accessProfile: sessionRow.access_profile ?? job.access_profile,
              metadata: {
                jobId: job.id,
                agentHomeSessionId: sessionRow.id,
                ...(sessionRow.profile_id
                  ? { agentProfileId: sessionRow.profile_id }
                  : {}),
                ...(sessionRow.conversation_id
                  ? { agentConversationId: sessionRow.conversation_id }
                  : {}),
              },
            })
          : await driver.attach(sessionRow.external_id)
        if (!session) {
          providerSessionLost = true
          throw new Error('provider session is no longer live')
        }
        attachedSession = session
        const providerBindingError = providerSessionBindingError({
          job,
          driver,
          session,
          workspaceId: job.workspace_id!,
          externalId: sessionRow.external_id,
        })
        if (providerBindingError) {
          if (session.id.trim() && driver.detach) await detachRecoveryHandle()
          throw new Error(`attached ${providerBindingError}`)
        }
        attachedSessionTrusted = true
        let currentSession = revalidateDurableBinding()
        let currentlyPaused = currentSession.control_state === 'paused'
        if (currentlyPaused) this.pausedJobs.add(job.id)
        else this.pausedJobs.delete(job.id)
        if (sessionRow.provider === 'codex' && !usedAuthorizedRecovery) {
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
          currentSession = revalidateDurableBinding()
          currentlyPaused = currentSession.control_state === 'paused'
          if (currentlyPaused) this.pausedJobs.add(job.id)
          else this.pausedJobs.delete(job.id)
        }
        if (sessionRow.provider === 'claude' && !currentlyPaused) {
          await driver.send(session.id,
            'The Orchestra daemon restarted while this durable job was active. Continue the existing job from the current workspace and conversation state; verify prior work before making further changes, then complete the assignment.')
          currentSession = revalidateDurableBinding()
          currentlyPaused = currentSession.control_state === 'paused'
          if (currentlyPaused) this.pausedJobs.add(job.id)
          else this.pausedJobs.delete(job.id)
        }
        this.db.prepare(`UPDATE agent_sessions SET status=?, control_state=?,
          updated_at=datetime('now') WHERE id=?`).run(
          currentlyPaused ? 'idle' : 'running',
          currentlyPaused ? 'paused' : 'active',
          currentSession.id,
        )
        this.live.set(job.id, { driver, session })
        void this.watch(job, currentSession.id, driver, session, job.spent_tokens, job.spent_cents)
        resumed.push(job.id)
      } catch (error) {
        this.pausedJobs.delete(job.id)
        const currentJob = this.scheduler.get(job.id)
        if (!currentJob || currentJob.status !== 'running') {
          await detachRecoveryHandle()
          recovered.push(job.id)
          continue
        }
        const cleanupError = await stopTrustedRecoveryHandle()
        const retainedJob = this.scheduler.get(job.id)
        if (!retainedJob || retainedJob.status !== 'running') {
          recovered.push(job.id)
          continue
        }
        if (providerSessionLost) this.markSessionLost(sessionRow.id)
        else this.markSessionFailed(sessionRow.id)
        const reason = `daemon restart recovery failed: ${
          error instanceof Error ? error.message : String(error)
        }${cleanupError ? `; exact provider session cleanup failed: ${cleanupError}` : ''}`
        const recoveredJob = this.scheduler.recover(job.id, reason)
        if (providerSessionLost) this.markSessionLost(sessionRow.id)
        this.finalizeManagedAgent(job, sessionRow.id, reason, recoveredJob.status)
        recovered.push(job.id)
      }
    }
    const forks = await this.reconcileAdoptedForkSessions()
    resumed.push(...forks.resumed)
    recovered.push(...forks.recovered)
    return { resumed, recovered }
  }

  private async reconcileAdoptedForkSessions(): Promise<{
    resumed: string[]
    recovered: string[]
  }> {
    const resumed: string[] = []
    const recovered: string[] = []
    const rows = this.db.prepare(`SELECT session.id, session.parent_session_id,
        json_extract(session.context_json, '$.fork_action_id') AS action_id
      FROM agent_sessions session
      WHERE session.lineage_type='fork'
        AND session.parent_session_id IS NOT NULL
        AND session.external_id IS NOT NULL
        AND session.recovery_state='attachable'
        AND session.control_state IN ('active','paused')
        AND session.status IN ('running','idle')
        AND json_valid(session.context_json)
        AND json_extract(session.context_json, '$.adoption_state')='attached'
      ORDER BY session.created_at, session.rowid`).all() as Array<{
        id: string
        parent_session_id: string
        action_id: string | null
      }>
    const conversations = new ConversationService(this.db)
    for (const row of rows) {
      try {
        if (!row.action_id) throw new Error('fork action identity is missing')
        const parent = conversations.requireSession(row.parent_session_id)
        const child = conversations.requireSession(row.id)
        await this.adoptAgentHomeForkSession(parent, child, {
          actionId: row.action_id,
          reservedSessionId: child.id,
        })
        this.db.prepare(`UPDATE agent_sessions SET status=?,
          updated_at=datetime('now') WHERE id=?`).run(
          'idle',
          child.id,
        )
        resumed.push(child.id)
      } catch {
        this.forkLive.delete(row.id)
        this.db.prepare(`UPDATE agent_sessions SET status='lost',
          control_state='stopped', ended_at=coalesce(ended_at, datetime('now')),
          updated_at=datetime('now') WHERE id=?`).run(row.id)
        recovered.push(row.id)
      }
    }
    return { resumed, recovered }
  }

  async execute(job: Job): Promise<JobExecutionResult> {
    const driver = this.drivers.require(job.driver_id)
    const capabilities = driver.capabilities()
    const assignment = runtimeJobAssignment(job)
    const delivery = job.card_id
      ? assignment
        ? this.deliveries.reports.currentForJob(job.id)
        : this.deliveries.reports.prepareForJob(job.id)
      : null
    const contract = job.card_id
      ? assignment
        ? frozenRuntimeContract(job, delivery)
        : new TaskContractService(this.db).getOrCreate(job.card_id)
      : null
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
    if (!assignment && job.card_id && contract?.workspace_id !== workspace.id) {
      new TaskContractService(this.db).put(job.card_id, { workspace_id: workspace.id })
    }
    this.assertCardClaimable(job)
    const cwd = this.workspaces.root(workspace)
    const managedAgentId = !capabilities.rawTerminal && capabilities.managesAgentIdentity !== true
      ? this.prepareManagedAgent(effectiveJob, cwd, job.access_profile)
      : null
    const agentName = job.card_id ? `job-${job.card_id}` : `job-${job.id.slice(0, 8)}`
    const profileName = job.card_id ? `job-${job.card_id}-${job.id}` : `job-${job.id}`
    const sessionContext: Record<string, unknown> = {
      job_id: job.id,
      card_id: job.card_id,
      managed_identity: managedAgentId !== null,
      driver_id: job.driver_id,
      effort: job.effort,
      access_profile: job.access_profile,
      usage_total: null,
      ...runtimeAssignmentEventPayload(job),
    }
    let agentHome: ManagedAgentSessionBinding | null = null
    if (job.provider !== 'shell' || assignment) {
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
          jobAssignment: assignment,
          context: sessionContext,
        })
      } catch (error) {
        if (managedAgentId) this.markManagedAgentGone(managedAgentId)
        throw error
      }
    }
    const repositoryHead = job.provider !== 'shell' && this.knowledge.hasSources(job.board_id)
      ? (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim().toLowerCase()
      : null
    const agentBrief = job.provider === 'shell'
      ? null
      : this.prompt(
          job,
          contract,
          delivery,
          agentHome!.agentHomeSessionId,
          workspace.id,
          repositoryHead,
        )
    if (agentBrief?.knowledge) {
      sessionContext.knowledge_context_use_id = agentBrief.knowledge.context_use_id
      sessionContext.knowledge_context_build_id = agentBrief.knowledge.context_build_id
      sessionContext.knowledge_context_estimated_tokens = agentBrief.knowledge.estimated_tokens
      sessionContext.knowledge_context_manifest_fingerprint = agentBrief.knowledge.manifest_fingerprint
    }
    const request = job.provider === 'shell'
      ? this.shellRequest(effectiveJob, workspace, contract, cwd)
      : {
          workspaceId: workspace.id,
          boardId: job.board_id,
          cwd,
          name: agentName,
          prompt: agentBrief!.prompt,
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
            ...runtimeAssignmentEventPayload(job),
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
    const providerBindingError = providerSessionBindingError({
      job,
      driver,
      session,
      workspaceId: workspace.id,
    })
    if (providerBindingError) {
      if (session.id.trim()) await driver.stop(session.id).catch(() => undefined)
      if (managedAgentId) this.markManagedAgentGone(managedAgentId)
      throw new Error(providerBindingError)
    }
    if (assignment) {
      try {
        const retainedWorkspace = await this.resolveWorkspace(effectiveJob, contract)
        if (retainedWorkspace.id !== workspace.id) {
          throw new Error('assigned job resolved a different workspace after provider launch')
        }
      } catch (error) {
        await driver.stop(session.id).catch(() => undefined)
        if (managedAgentId) this.markManagedAgentGone(managedAgentId)
        throw new ConflictError(
          `assigned job workspace was revoked during provider launch: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
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
      : assignment
        ? this.db.prepare(`SELECT id, context_json FROM agent_sessions
            WHERE job_id=?
              AND job_assignment_id=?
              AND assigned_profile_id=?
              AND assignment_market_version=?
              AND status IN ('reserved','starting')
            ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
            .get(
              job.id,
              assignment.jobAssignmentId,
              assignment.assignedProfileId,
              assignment.assignmentMarketVersion,
            ) as { id: string; context_json: string } | undefined
      : this.db.prepare(`SELECT id, context_json FROM agent_sessions
          WHERE (
            job_id=? OR (
              job_id IS NULL
              AND json_valid(context_json)
              AND json_extract(context_json, '$.job_id')=?
            )
          )
            AND status IN ('reserved','starting') ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
          .get(job.id, job.id) as { id: string; context_json: string } | undefined
    const sessionId = agentHome?.agentHomeSessionId ?? reservation?.id ?? randomUUID()
    const agentId = Number(session.metadata.agentId ?? managedAgentId)
    try {
      if (agentHome && !reservation) {
        throw new Error(`bound Agent Home session disappeared before provider launch completed: ${sessionId}`)
      }
      if (assignment && !reservation) {
        throw new Error('assigned job reservation disappeared before provider launch completed')
      }
      const context = {
        ...parseJson<Record<string, unknown>>(reservation?.context_json, {}),
        ...sessionContext,
      }
      if (reservation) {
        const updated = this.db.prepare(`UPDATE agent_sessions
          SET workspace_id=?, agent_id=?, provider=?, external_id=?, model=?,
            status='running', context_json=?, updated_at=datetime('now')
          WHERE id=?
            AND (? IS NULL OR (
              job_id=?
              AND job_assignment_id=?
              AND assigned_profile_id=?
              AND assignment_market_version=?
            ))`).run(
          workspace.id,
          Number.isSafeInteger(agentId) && agentId > 0 ? agentId : null,
          job.provider,
          session.externalId,
          job.model,
          JSON.stringify(context),
          sessionId,
          assignment?.jobAssignmentId ?? null,
          job.id,
          assignment?.jobAssignmentId ?? null,
          assignment?.assignedProfileId ?? null,
          assignment?.assignmentMarketVersion ?? null,
        )
        if (updated.changes !== 1) {
          throw new Error('reserved provider session changed before launch completion')
        }
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
      if (!assignment) {
        this.db.prepare('UPDATE jobs SET workspace_id=? WHERE id=?').run(workspace.id, job.id)
      }
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
        payload: {
          provider: job.provider,
          driver_id: job.driver_id,
          external_id: session.externalId,
          ...runtimeAssignmentEventPayload(job),
        },
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
        if (runtimeJobAssignment(job)) {
          const bindingError = this.recoveryBindingError(job, row)
          if (bindingError) throw new ConflictError(`cancel rejected: ${bindingError}`)
        }
        const driver = this.drivers.get(row.driver_id ?? row.provider)
        const attached = driver ? await driver.attach(row.external_id) : null
        if (driver && attached) {
          const providerBindingError = providerSessionBindingError({
            job,
            driver,
            session: attached,
            workspaceId: job.workspace_id ?? row.workspace_id,
            externalId: row.external_id,
          })
          if (providerBindingError) {
            if (attached.id.trim() && driver.detach) {
              await driver.detach(attached.id).catch(() => undefined)
            }
            throw new ConflictError(`cancel rejected: attached ${providerBindingError}`)
          }
          await driver.stop(attached.id)
        }
      }
    }
    const session = this.sessionForJob(job.id)
    const stopped = session
      ? this.db.prepare(`UPDATE agent_sessions SET status='stopped', updated_at=datetime('now')
          WHERE id=? AND status NOT IN ('stopped','failed')`).run(session.id)
      : { changes: 0 }
    if (stopped.changes > 0) {
      if (session) this.recordSessionTransition(job, session.id, 'stopped', job.driver_id)
    }
  }

  private async resolveWorkspace(job: Job, contract: TaskContract | null): Promise<WorkspaceRecord> {
    const assignment = runtimeJobAssignment(job)
    if (assignment) {
      if (!job.workspace_id || !job.card_id || contract?.workspace_id !== job.workspace_id) {
        throw new Error('assigned job is missing its frozen card workspace scope')
      }
      const retained = this.db.prepare(`SELECT 1
        FROM job_market_assignments assignment
        WHERE assignment.id=?
          AND assignment.board_id=?
          AND assignment.card_id=?
          AND assignment.profile_id=?
          AND assignment.assigned_market_version=?
          AND assignment.status='active'
          AND (assignment.workspace_id IS NULL OR assignment.workspace_id=?)`).get(
        assignment.jobAssignmentId,
        job.board_id,
        job.card_id,
        assignment.assignedProfileId,
        assignment.assignmentMarketVersion,
        job.workspace_id,
      )
      if (!retained) throw new Error('assigned job no longer has its exact active assignment')
      const workspace = await this.workspaces.get(job.workspace_id)
      if (!workspace
        || workspace.status !== 'active'
        || workspace.boardId !== job.board_id
        || (workspace.cardId !== null && workspace.cardId !== job.card_id)) {
        throw new Error('assigned job workspace no longer matches its frozen runtime scope')
      }
      return workspace
    }
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
      metadata: {
        jobId: job.id,
        cardId: job.card_id,
        ...runtimeAssignmentEventPayload(job),
      },
    }
  }

  private prompt(
    job: Job,
    contract: TaskContract | null,
    delivery: DeliveryReport | null,
    sessionId: string,
    workspaceId: string,
    repositoryHead: string | null,
  ): { prompt: string; knowledge: ManagedKnowledgePrompt | null } {
    if (!contract || !delivery) {
      return {
        prompt: `Execute Agent OS job ${job.id} in this workspace. Finish with a concise Delivery summary and Evidence.`,
        knowledge: null,
      }
    }
    if (!job.card_id) {
      throw new Error('card-backed contract is required for an Agent OS delivery brief')
    }
    const stored = this.db.prepare(`SELECT agent_brief, agent_brief_sha256
      FROM jobs WHERE id=?`).get(job.id) as {
        agent_brief: string | null
        agent_brief_sha256: string | null
      } | undefined
    if (!stored) throw new Error('job disappeared before Agent OS brief persistence')
    if (stored.agent_brief !== null || stored.agent_brief_sha256 !== null) {
      if (stored.agent_brief === null || stored.agent_brief_sha256 === null
        || createHash('sha256').update(stored.agent_brief).digest('hex')
          !== stored.agent_brief_sha256) {
        throw new Error('persisted Agent OS brief evidence is invalid')
      }
      return { prompt: stored.agent_brief, knowledge: null }
    }
    const rendered = new OpenWorkService(this.db).renderBrief(job.card_id, {
      job_id: job.id,
      delivery_id: delivery.id,
      workspace_id: job.workspace_id,
      contract,
      selection: job.assigned_profile_id ? {
        profile_id: job.assigned_profile_id,
        provider: job.provider,
        model: job.model,
        access_profile: job.access_profile,
      } : null,
    })
    const knowledge = repositoryHead === null ? null : this.knowledge.prepareManagedJob({
      job,
      contract,
      delivery,
      session_id: sessionId,
      workspace_id: workspaceId,
      repository_head_sha: repositoryHead,
      created_at: durableJobTimestamp(job.created_at ?? job.scheduled_at),
    })
    const prompt = knowledge === null
      ? rendered.agent_brief
      : `${rendered.agent_brief}\n\n${knowledge.prompt}`
    const digest = createHash('sha256').update(prompt).digest('hex')
    if (knowledge === null && digest !== rendered.agent_brief_sha256) {
      throw new Error('rendered Agent OS brief digest is inconsistent')
    }
    const persisted = this.db.prepare(`UPDATE jobs
      SET agent_brief=?, agent_brief_sha256=?
      WHERE id=? AND agent_brief IS NULL AND agent_brief_sha256 IS NULL`)
      .run(prompt, digest, job.id)
    if (persisted.changes !== 1) {
      throw new Error('Agent OS brief persistence raced; retry from the stored job')
    }
    return { prompt, knowledge }
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

  private async watchForkSession(
    childSessionId: string,
    binding: LiveJob,
  ): Promise<void> {
    const scope = this.db.prepare(`SELECT workspace.board_id, workspace.card_id
      FROM agent_sessions session
      JOIN workspaces workspace ON workspace.id=session.workspace_id
      WHERE session.id=? AND session.workspace_id=?`).get(
      childSessionId,
      binding.session.workspaceId,
    ) as { board_id: number; card_id: number | null } | undefined
    if (!scope) {
      this.forkLive.delete(childSessionId)
      return
    }
    let terminal: 'stopped' | 'failed' | 'lost' | null = null
    let detachedByControl = false
    try {
      for await (const event of binding.driver.events(binding.session.id)) {
        const current = this.forkLive.get(childSessionId)
        if (!current || current.session.id !== binding.session.id) {
          detachedByControl = true
          return
        }
        const projection = projectManagedDriverEvent(event, binding.driver.id)
        const previous = this.db.prepare(`SELECT id, correlation_id FROM os_events
          WHERE session_id=? ORDER BY rowid DESC LIMIT 1`).get(childSessionId) as
          { id: string; correlation_id: string | null } | undefined
        new EventStore(this.db).append({
          boardId: scope.board_id,
          workspaceId: binding.session.workspaceId,
          cardId: scope.card_id,
          sessionId: childSessionId,
          correlationId: previous?.correlation_id ?? childSessionId,
          causationId: previous?.id ?? null,
          kind: `driver.${event.type}`,
          source: binding.driver.id,
          payload: projection.payload,
          createdAt: event.at,
        })
        if (event.type !== 'output') {
          this.bus.current?.emit('event', {
            board_id: scope.board_id,
            type: 'os:driver',
            data: {
              session_id: childSessionId,
              type: event.type,
              data: projection.payload.data,
              metadata: projection.payload.metadata,
            },
          })
        }
        if (event.type === 'exit') {
          const exitCode = Number(event.metadata?.exitCode)
          terminal = event.data.includes('lost')
            ? 'lost'
            : event.data.includes('failed')
              || (Number.isFinite(exitCode) && exitCode !== 0)
              ? 'failed'
              : 'stopped'
          break
        }
      }
      terminal ??= this.forkStopIntents.has(childSessionId)
        ? 'stopped'
        : 'lost'
    } catch {
      terminal = this.forkStopIntents.has(childSessionId)
        ? 'stopped'
        : 'lost'
    } finally {
      const intentionallyStopped = this.forkStopIntents.delete(childSessionId)
      if (this.forkLive.get(childSessionId)?.session.id === binding.session.id) {
        this.forkLive.delete(childSessionId)
      }
      if (this.shuttingDown || (detachedByControl && !intentionallyStopped)) return
      const finalStatus = intentionallyStopped ? 'stopped' : terminal ?? 'lost'
      this.db.prepare(`UPDATE agent_sessions SET status=?, control_state='stopped',
        ended_at=coalesce(ended_at, datetime('now')), updated_at=datetime('now')
        WHERE id=? AND external_id=? AND workspace_id=?`).run(
        finalStatus,
        childSessionId,
        binding.session.externalId,
        binding.session.workspaceId,
      )
      if (finalStatus === 'failed' || finalStatus === 'lost') {
        new AttentionService(this.db).create({
          boardId: scope.board_id,
          workspaceId: binding.session.workspaceId,
          cardId: scope.card_id,
          kind: `agent_session.${finalStatus}`,
          severity: finalStatus === 'lost' ? 'high' : 'critical',
          title: `Fork session ${childSessionId} ${finalStatus}`,
          detail: 'The independently adopted provider session is no longer attached.',
        })
      }
    }
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
      this.finishKnowledgeContextUse(
        job,
        sessionId,
        cancellationWon ? 'cancelled' : failure ? 'failed' : 'completed',
        accountedTokens,
      )
      this.finalizeManagedAgent(job, sessionId, failure, finalStatus)
    }
  }

  private finishKnowledgeContextUse(
    job: Job,
    sessionId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    actualTokens: number,
  ): void {
    const row = this.db.prepare('SELECT context_json FROM agent_sessions WHERE id=?').get(sessionId) as
      { context_json: string } | undefined
    const context = parseJson<Record<string, unknown>>(row?.context_json, {})
    if (typeof context.knowledge_context_use_id !== 'string') return
    try {
      this.knowledge.finishManagedJob({
        board_id: job.board_id,
        context_use_id: context.knowledge_context_use_id,
        outcome,
        actual_tokens: Number.isSafeInteger(actualTokens) ? actualTokens : null,
        completed_at: new Date().toISOString(),
      })
    } catch {
      new AttentionService(this.db).create({
        boardId: job.board_id,
        cardId: job.card_id,
        kind: `knowledge.context_use_receipt:${context.knowledge_context_use_id}`,
        severity: 'high',
        title: 'Knowledge context usage receipt needs repair',
        detail: `Session ${sessionId} finished without a valid actual-token receipt.`,
      })
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
    const idempotencyKey = `job:${job.id}:session-${status}:${Math.max(1, job.attempts)}`
    const existing = this.db.prepare(`SELECT correlation_id, causation_id FROM os_events
      WHERE board_id=? AND idempotency_key=?`).get(job.board_id, idempotencyKey) as
      { correlation_id: string | null; causation_id: string | null } | undefined
    const previous = existing ? undefined : this.db.prepare(`SELECT id, correlation_id FROM os_events
      WHERE job_id=? ORDER BY rowid DESC LIMIT 1`).get(job.id) as
      { id: string; correlation_id: string | null } | undefined
    new EventStore(this.db).append({
      boardId: job.board_id,
      workspaceId: job.workspace_id,
      cardId: job.card_id,
      sessionId,
      jobId: job.id,
      contractId: job.card_id && job.contract_version ? `card:${job.card_id}:v${job.contract_version}` : null,
      correlationId: existing ? existing.correlation_id : previous?.correlation_id ?? job.id,
      causationId: existing ? existing.causation_id : previous?.id ?? null,
      idempotencyKey,
      kind: `agent_session.${status}`,
      source,
      payload: { job_id: job.id, session_id: sessionId, attempt: job.attempts },
    })
  }

  private sessionForJob(jobId: string): {
    id: string
    workspace_id: string
    job_id: string | null
    job_assignment_id: string | null
    assigned_profile_id: string | null
    assignment_market_version: number | null
    profile_id: string | null
    conversation_id: string | null
    provider: string
    driver_id: string | null
    external_id: string | null
    model: string | null
    effort: string | null
    access_profile: 'read_only' | 'workspace_write' | 'full_access' | null
    status: AgentSessionRecord['status']
    control_state: AgentSessionRecord['control_state']
  } | undefined {
    return this.db.prepare(`SELECT s.id, s.workspace_id, s.job_id,
      s.job_assignment_id, s.assigned_profile_id, s.assignment_market_version,
      s.profile_id, s.conversation_id, s.provider, s.driver_id, s.external_id,
      COALESCE(a.model, s.model) AS model,
      COALESCE(a.effort, s.effort) AS effort,
      COALESCE(a.access_profile, s.access_profile) AS access_profile,
      s.status, s.control_state
      FROM agent_sessions s LEFT JOIN agents a ON a.id=s.agent_id
      WHERE s.job_id=? OR (
        s.job_id IS NULL
        AND json_valid(s.context_json)
        AND json_extract(s.context_json, '$.job_id')=?
      )
      ORDER BY CASE WHEN s.job_id=? THEN 0 ELSE 1 END,
        s.updated_at DESC, s.rowid DESC LIMIT 1`).get(jobId, jobId, jobId) as {
        id: string
        workspace_id: string
        job_id: string | null
        job_assignment_id: string | null
        assigned_profile_id: string | null
        assignment_market_version: number | null
        profile_id: string | null
        conversation_id: string | null
        provider: string
        driver_id: string | null
        external_id: string | null
        model: string | null
        effort: string | null
        access_profile: 'read_only' | 'workspace_write' | 'full_access' | null
        status: AgentSessionRecord['status']
        control_state: AgentSessionRecord['control_state']
      } | undefined
  }

  private recoveryBindingError(
    job: Job,
    session: ReturnType<AgentOsJobExecutor['sessionForJob']>,
  ): string | null {
    if (!session) return 'durable provider session is missing'
    if (!job.workspace_id
      || session.workspace_id !== job.workspace_id
      || session.provider !== job.provider
      || (session.driver_id ?? session.provider) !== job.driver_id
      || (session.job_id !== null && session.job_id !== job.id)) {
      return 'job, provider, or workspace identity is inconsistent'
    }
    const workspace = this.db.prepare(`SELECT 1
      FROM workspaces
      WHERE id=?
        AND board_id=?
        AND status='active'
        AND (? IS NULL OR card_id IS NULL OR card_id=?)`).get(
      job.workspace_id,
      job.board_id,
      job.card_id,
      job.card_id,
    )
    if (!workspace) return 'job workspace is no longer active or correctly scoped'
    let sessionAssignment: ReturnType<typeof runtimeAssignmentFromRow>
    try {
      sessionAssignment = runtimeAssignmentFromRow(session)
    } catch {
      return 'provider session assignment identity is incomplete'
    }
    const jobAssignment = runtimeJobAssignment(job)
    if (!jobAssignment) {
      return sessionAssignment
        ? 'an unassigned job cannot recover through an assigned provider session'
        : null
    }
    if (!sessionAssignment
      || session.job_id !== job.id
      || sessionAssignment.jobAssignmentId !== jobAssignment.jobAssignmentId
      || sessionAssignment.assignedProfileId !== jobAssignment.assignedProfileId
      || sessionAssignment.assignmentMarketVersion !== jobAssignment.assignmentMarketVersion
      || session.profile_id !== jobAssignment.assignedProfileId
      || !session.conversation_id) {
      return 'provider session does not retain the frozen job assignment'
    }
    const retained = this.db.prepare(`SELECT 1
      FROM job_market_assignments assignment
      JOIN agent_profiles profile ON profile.id=assignment.profile_id
      JOIN agent_conversations conversation ON conversation.id=?
      WHERE assignment.id=?
        AND assignment.board_id=?
        AND assignment.card_id=?
        AND assignment.profile_id=?
        AND assignment.assigned_market_version=?
        AND assignment.status='active'
        AND (assignment.workspace_id IS NULL OR assignment.workspace_id=?)
        AND profile.status='active'
        AND conversation.board_id=assignment.board_id
        AND conversation.profile_id=assignment.profile_id
        AND conversation.status='active'`).get(
      session.conversation_id,
      jobAssignment.jobAssignmentId,
      job.board_id,
      job.card_id,
      jobAssignment.assignedProfileId,
      jobAssignment.assignmentMarketVersion,
      job.workspace_id,
    )
    return retained ? null : 'frozen job assignment is no longer recoverable'
  }

  private controlForAgent(agentId: number): { job: Job; sessionId: string; live?: LiveJob } | undefined {
    const row = this.db.prepare(`SELECT s.id AS session_id, j.* FROM agent_sessions s
      JOIN jobs j ON j.id=coalesce(
        s.job_id,
        CASE WHEN json_valid(s.context_json) THEN json_extract(s.context_json, '$.job_id') END
      )
      JOIN agents a ON a.id=s.agent_id
      WHERE s.agent_id=? AND a.session_id=('agent-os:' || j.id)
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
      WHERE s.id=?
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
            AND (
              (
                s.profile_id IS NULL
                AND s.conversation_id IS NULL
              )
              OR
              (
                s.profile_id=j.assigned_profile_id
                AND s.conversation_id IS NOT NULL
              )
            )
          )
        )`).get(sessionId) as
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

function providerSessionBindingError(input: {
  job: Job
  driver: AgentDriver
  session: DriverSession
  workspaceId: string
  externalId?: string
}): string | null {
  if (!input.session.id.trim() || !input.session.externalId.trim()) {
    return 'provider session identity is empty'
  }
  if (input.driver.id !== input.job.driver_id
    || input.session.driverId !== input.job.driver_id) {
    return 'provider session driver does not match the frozen job'
  }
  if (input.session.workspaceId !== input.workspaceId) {
    return 'provider session workspace does not match the frozen managed launch'
  }
  if (!['starting', 'running', 'idle'].includes(input.session.status)) {
    return `provider session returned terminal or stopping status ${input.session.status}`
  }
  if (input.externalId !== undefined
    && input.session.externalId !== input.externalId) {
    return 'provider session external identity does not match the durable session'
  }
  return null
}

function runtimeAssignmentFromRow(row: {
  job_assignment_id?: unknown
  assigned_profile_id?: unknown
  assignment_market_version?: unknown
}): {
  jobAssignmentId: string
  assignedProfileId: string
  assignmentMarketVersion: number
} | null {
  const present = [
    row.job_assignment_id,
    row.assigned_profile_id,
    row.assignment_market_version,
  ].map((value) => value != null)
  if (!present.some(Boolean)) return null
  if (!present.every(Boolean)) {
    throw new ValidationError('stored runtime job assignment identity is incomplete')
  }
  const jobAssignmentId = String(row.job_assignment_id).trim()
  const assignedProfileId = String(row.assigned_profile_id).trim()
  const assignmentMarketVersion = Number(row.assignment_market_version)
  if (!jobAssignmentId || !assignedProfileId
    || !Number.isSafeInteger(assignmentMarketVersion)
    || assignmentMarketVersion <= 0) {
    throw new ValidationError('stored runtime job assignment identity is invalid')
  }
  return { jobAssignmentId, assignedProfileId, assignmentMarketVersion }
}

function runtimeJobAssignment(job: Pick<
  Job,
  'job_assignment_id' | 'assigned_profile_id' | 'assignment_market_version'
>): {
  jobAssignmentId: string
  assignedProfileId: string
  assignmentMarketVersion: number
} | null {
  return runtimeAssignmentFromRow(job)
}

function runtimeAssignmentEventPayload(job: Pick<
  Job,
  'job_assignment_id' | 'assigned_profile_id' | 'assignment_market_version'
>): Record<string, string | number> {
  const assignment = runtimeJobAssignment(job)
  return assignment ? {
    job_assignment_id: assignment.jobAssignmentId,
    assigned_profile_id: assignment.assignedProfileId,
    assignment_market_version: assignment.assignmentMarketVersion,
  } : {}
}

function frozenRuntimeContract(job: Job, delivery: DeliveryReport | null): TaskContract {
  if (!delivery
    || !job.card_id
    || !job.workspace_id
    || !job.contract_version
    || delivery.board_id !== job.board_id
    || delivery.card_id !== job.card_id
    || delivery.job_id !== job.id
    || delivery.workspace_id !== job.workspace_id
    || delivery.asked.contract_version !== job.contract_version) {
    throw new ConflictError('assigned job delivery snapshot is missing or inconsistent')
  }
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
    workspace_id: job.workspace_id,
    version: delivery.asked.contract_version,
    updated_at: delivery.asked.contract_updated_at,
  }
}

function durableJobTimestamp(value: string): string {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = new Date(normalized)
  if (!Number.isFinite(parsed.getTime())) throw new Error('job timestamp is invalid')
  return parsed.toISOString()
}

const mapRuntimeJob = (row: Record<string, unknown>): Job => {
  const access = String(row.access_profile ?? 'workspace_write')
  const assignment = runtimeAssignmentFromRow(row)
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
    job_assignment_id: assignment?.jobAssignmentId ?? null,
    assigned_profile_id: assignment?.assignedProfileId ?? null,
    assignment_market_version: assignment?.assignmentMarketVersion ?? null,
    agent_brief: row.agent_brief == null ? null : String(row.agent_brief),
    agent_brief_sha256: row.agent_brief_sha256 == null
      ? null
      : String(row.agent_brief_sha256),
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
