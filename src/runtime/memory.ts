import type {
  NewProcessRecord,
  NewWorkspaceRecord,
  ProcessOutputChunk,
  ProcessPatch,
  ProcessRecord,
  ProcessRestartRecipe,
  RuntimeEvent,
  RuntimePersistence,
  OsId,
  WorkspaceFilter,
  WorkspacePatch,
  WorkspaceRecord,
  WorkspaceStore,
} from './types.js'

export class MemoryWorkspaceStore implements WorkspaceStore {
  private nextId = 1
  private records = new Map<OsId, WorkspaceRecord>()

  create(input: NewWorkspaceRecord): WorkspaceRecord {
    const now = new Date().toISOString()
    const record = { ...input, id: String(this.nextId++), createdAt: now, updatedAt: now }
    this.records.set(record.id, structuredClone(record))
    return structuredClone(record)
  }

  get(id: OsId): WorkspaceRecord | undefined {
    const record = this.records.get(id)
    return record ? structuredClone(record) : undefined
  }

  list(filter: WorkspaceFilter = {}): WorkspaceRecord[] {
    return [...this.records.values()].filter((record) =>
      (filter.boardId === undefined || record.boardId === filter.boardId) &&
      (filter.cardId === undefined || record.cardId === filter.cardId) &&
      (filter.status === undefined || record.status === filter.status),
    ).map((record) => structuredClone(record))
  }

  update(id: OsId, patch: WorkspacePatch): WorkspaceRecord {
    const existing = this.records.get(id)
    if (!existing) throw new Error(`workspace ${id} not found`)
    const record = { ...existing, ...structuredClone(patch), updatedAt: new Date().toISOString() }
    this.records.set(id, record)
    return structuredClone(record)
  }
}

export class MemoryRuntimePersistence implements RuntimePersistence {
  private nextId = 1
  readonly processes = new Map<OsId, ProcessRecord>()
  readonly output = new Map<OsId, ProcessOutputChunk[]>()
  readonly events: RuntimeEvent[] = []
  readonly recipes = new Map<OsId, ProcessRestartRecipe>()

  createProcess(input: NewProcessRecord): ProcessRecord {
    const record = { ...input, id: String(this.nextId++) }
    this.processes.set(record.id, structuredClone(record))
    return structuredClone(record)
  }

  updateProcess(id: OsId, patch: ProcessPatch): ProcessRecord {
    const existing = this.processes.get(id)
    if (!existing) throw new Error(`process ${id} not found`)
    const record = { ...existing, ...structuredClone(patch) }
    this.processes.set(id, record)
    return structuredClone(record)
  }

  getProcess(id: OsId): ProcessRecord | undefined {
    const record = this.processes.get(id)
    return record ? structuredClone(record) : undefined
  }

  listProcesses(workspaceId?: OsId): ProcessRecord[] {
    return [...this.processes.values()]
      .filter((record) => workspaceId === undefined || record.workspaceId === workspaceId)
      .map((record) => structuredClone(record))
  }

  listRunningProcesses(): ProcessRecord[] {
    return [...this.processes.values()]
      .filter((record) => ['starting', 'running', 'stopping'].includes(record.status))
      .map((record) => structuredClone(record))
  }

  appendOutput(chunk: ProcessOutputChunk): void {
    const chunks = this.output.get(chunk.processId) ?? []
    chunks.push(structuredClone(chunk))
    this.output.set(chunk.processId, chunks)
  }

  readOutput(processId: OsId, afterSeq: number, limit: number): ProcessOutputChunk[] {
    return (this.output.get(processId) ?? [])
      .filter((chunk) => chunk.seq > afterSeq)
      .slice(0, limit)
      .map((chunk) => structuredClone(chunk))
  }

  pruneOutput(processId: OsId, beforeSeq: number): void {
    this.output.set(processId, (this.output.get(processId) ?? []).filter((chunk) => chunk.seq >= beforeSeq))
  }

  saveRestartRecipe(processId: OsId, recipe: ProcessRestartRecipe): void {
    this.recipes.set(processId, structuredClone(recipe))
  }

  getRestartRecipe(processId: OsId): ProcessRestartRecipe | undefined {
    const recipe = this.recipes.get(processId)
    return recipe ? structuredClone(recipe) : undefined
  }

  onEvent(event: RuntimeEvent): void {
    this.events.push(structuredClone(event))
  }
}
