export type MaybePromise<T> = T | Promise<T>
export type OsId = string

export type WorkspaceKind = 'shared' | 'worktree'
export type WorkspaceStatus = 'active' | 'archived' | 'missing'

export type WorkspaceRecord = {
  id: OsId
  boardId: number
  cardId: number | null
  name: string
  kind: WorkspaceKind
  rootPath: string
  worktreePath: string | null
  branch: string | null
  baseRef: string
  status: WorkspaceStatus
  env: Record<string, string>
  createdAt: string
  updatedAt: string
}

export type NewWorkspaceRecord = Omit<WorkspaceRecord, 'id' | 'createdAt' | 'updatedAt'>

export type WorkspaceFilter = {
  boardId?: number
  cardId?: number | null
  status?: WorkspaceStatus
}

export type WorkspacePatch = Partial<Pick<WorkspaceRecord, 'cardId' | 'name' | 'baseRef' | 'status' | 'env'>>

export interface WorkspaceStore {
  create(input: NewWorkspaceRecord): MaybePromise<WorkspaceRecord>
  get(id: OsId): MaybePromise<WorkspaceRecord | undefined>
  list(filter?: WorkspaceFilter): MaybePromise<WorkspaceRecord[]>
  update(id: OsId, patch: WorkspacePatch): MaybePromise<WorkspaceRecord>
}

export type WorkspaceEvent = {
  kind: 'workspace.created' | 'workspace.updated' | 'workspace.archived' | 'workspace.removed'
  workspaceId: OsId
  boardId: number
  at: string
  payload: Record<string, unknown>
}

export type ProcessStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'failed' | 'lost'
export type TerminalProcessStatus = Extract<ProcessStatus, 'stopped' | 'exited' | 'failed' | 'lost'>

export type ProcessRecord = {
  id: OsId
  workspaceId: OsId
  name: string
  command: string
  cwd: string
  status: ProcessStatus
  pid: number | null
  exitCode: number | null
  cols: number
  rows: number
  restartable: boolean
  startedAt: string | null
  endedAt: string | null
}

export type NewProcessRecord = Omit<ProcessRecord, 'id'>
export type ProcessPatch = Partial<Omit<ProcessRecord, 'id' | 'workspaceId'>>

export type ProcessOutputChunk = {
  processId: OsId
  seq: number
  stream: 'pty'
  data: string
  createdAt: string
}

export type OutputPage = {
  chunks: ProcessOutputChunk[]
  nextSeq: number
  truncated: boolean
}

export type ProcessRestartRecipe = {
  workspaceId: OsId
  name: string
  command: string
  args?: string[]
  shell: boolean
  shellPath?: string
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  restartable: boolean
}

export type SpawnProcessRequest = {
  workspaceId: OsId
  name?: string
  command: string
  args?: string[]
  cwd: string
  env?: Record<string, string | undefined>
  cols?: number
  rows?: number
  shell?: boolean
  shellPath?: string
  restartable?: boolean
  restartedFrom?: OsId
}

export type RuntimeEventKind =
  | 'process.started'
  | 'process.input'
  | 'process.resized'
  | 'process.signal'
  | 'process.stopping'
  | 'process.exited'
  | 'process.failed'
  | 'process.stopped'
  | 'process.lost'
  | 'process.restarted'
  | 'process.persistence_error'

export type RuntimeEvent = {
  kind: RuntimeEventKind
  processId: OsId
  workspaceId: OsId
  at: string
  payload: Record<string, unknown>
}

export type RuntimeStreamItem =
  | { type: 'output'; output: ProcessOutputChunk }
  | { type: 'event'; event: RuntimeEvent }

export type ProcessPort = {
  processId: OsId
  workspaceId: OsId
  pid: number
  host: string
  port: number
  protocol: 'tcp'
}

export interface RuntimePersistence {
  createProcess(input: NewProcessRecord): MaybePromise<ProcessRecord>
  updateProcess(id: OsId, patch: ProcessPatch): MaybePromise<ProcessRecord>
  getProcess(id: OsId): MaybePromise<ProcessRecord | undefined>
  listProcesses(workspaceId?: OsId): MaybePromise<ProcessRecord[]>
  listRunningProcesses(): MaybePromise<ProcessRecord[]>
  appendOutput(chunk: ProcessOutputChunk): MaybePromise<void>
  readOutput?(processId: OsId, afterSeq: number, limit: number): MaybePromise<ProcessOutputChunk[]>
  pruneOutput?(processId: OsId, beforeSeq: number): MaybePromise<void>
  onEvent?(event: RuntimeEvent): MaybePromise<void>
}

export type DriverCapabilities = {
  attach: boolean
  streaming: boolean
  interrupt: boolean
  stop: boolean
  rawTerminal: boolean
  resume: boolean
}

export type DriverLaunchRequest = {
  workspaceId: OsId
  boardId?: number
  cwd: string
  name?: string
  prompt?: string
  command?: string
  args?: string[]
  env?: Record<string, string | undefined>
  model?: string
  externalId?: string
  permissionMode?: string
  metadata?: Record<string, unknown>
}

export type DriverSessionStatus = 'starting' | 'running' | 'idle' | 'stopping' | 'stopped' | 'failed' | 'lost'

export type DriverSession = {
  id: string
  externalId: string
  driverId: string
  workspaceId: OsId
  status: DriverSessionStatus
  startedAt: string
  metadata: Record<string, unknown>
}

export type DriverEvent = {
  sessionId: string
  seq: number
  type: 'output' | 'status' | 'tool' | 'error' | 'exit'
  at: string
  data: string
  metadata?: Record<string, unknown>
}

export interface AgentDriver {
  readonly id: string
  capabilities(): DriverCapabilities
  launch(request: DriverLaunchRequest): Promise<DriverSession>
  attach(externalId: string): Promise<DriverSession | null>
  send(sessionId: string, text: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  stop(sessionId: string): Promise<void>
  events(sessionId: string): AsyncIterable<DriverEvent>
}
