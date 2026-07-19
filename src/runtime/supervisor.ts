import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as nodePty from 'node-pty'
import { AsyncQueue } from './async-queue.js'
import { MemoryRuntimePersistence } from './memory.js'
import type {
  MaybePromise,
  OsId,
  OutputPage,
  ProcessOutputChunk,
  ProcessPatch,
  ProcessPort,
  ProcessRecord,
  ProcessRestartRecipe,
  ProcessStatus,
  RuntimeEvent,
  RuntimePersistence,
  RuntimeStreamItem,
  SpawnProcessRequest,
} from './types.js'

export type PtyHandle = Pick<nodePty.IPty, 'pid' | 'process' | 'onData' | 'onExit' | 'write' | 'resize' | 'kill'>

export interface PtyBackend {
  spawn(file: string, args: string[], options: nodePty.IPtyForkOptions | nodePty.IWindowsPtyForkOptions): PtyHandle
}

export class NodePtyBackend implements PtyBackend {
  spawn(file: string, args: string[], options: nodePty.IPtyForkOptions | nodePty.IWindowsPtyForkOptions): PtyHandle {
    return nodePty.spawn(file, args, options)
  }
}

export type RuntimeSupervisorOptions = {
  persistence?: RuntimePersistence
  pty?: PtyBackend
  maxOutputBytes?: number
  maxOutputChunks?: number
  discoverPorts?: (processes: ProcessRecord[]) => MaybePromise<ProcessPort[]>
}

type RuntimeState = {
  record: ProcessRecord
  pty: PtyHandle
  recipe: ProcessRestartRecipe
  seq: number
  output: ProcessOutputChunk[]
  outputBytes: number
  outputQueue: Promise<void>
  lifecycleQueue: Promise<void>
  lastPruneBefore: number
  stopRequested: boolean
  finalized: boolean
  exitPromise: Promise<ProcessRecord>
  resolveExit: (record: ProcessRecord) => void
  startBarrier: Promise<void>
  resolveStarted: () => void
  dataDisposable?: { dispose(): void }
  exitDisposable?: { dispose(): void }
}

const terminalStatuses = new Set<ProcessStatus>(['stopped', 'exited', 'failed', 'lost'])
const signalNames = new Set<NodeJS.Signals>([
  'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGTERM', 'SIGTSTP', 'SIGCONT', 'SIGWINCH',
])

const clone = <T>(value: T): T => structuredClone(value)

const positiveDimension = (value: number | undefined, fallback: number, name: string): number => {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 1_000)
    throw new Error(`${name} must be an integer between 1 and 1000`)
  return resolved
}

const quoteArg = (arg: string): string => /^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)
  ? arg : `'${arg.replaceAll("'", `'\\''`)}'`

const statusForExit = (stopRequested: boolean, exitCode: number): Extract<ProcessStatus, 'stopped' | 'exited' | 'failed'> =>
  stopRequested ? 'stopped' : exitCode === 0 ? 'exited' : 'failed'

export class RuntimeSupervisor {
  readonly persistence: RuntimePersistence
  private readonly backend: PtyBackend
  private readonly maxOutputBytes: number
  private readonly maxOutputChunks: number
  private readonly states = new Map<OsId, RuntimeState>()
  private readonly subscribers = new Map<OsId, Set<(item: RuntimeStreamItem) => void>>()
  private eventQueue = Promise.resolve()

  constructor(private readonly options: RuntimeSupervisorOptions = {}) {
    this.persistence = options.persistence ?? new MemoryRuntimePersistence()
    this.backend = options.pty ?? new NodePtyBackend()
    this.maxOutputBytes = Math.max(1_024, options.maxOutputBytes ?? 4 * 1024 * 1024)
    this.maxOutputChunks = Math.max(10, options.maxOutputChunks ?? 10_000)
  }

  async spawn(request: SpawnProcessRequest): Promise<ProcessRecord> {
    if (!request.workspaceId.trim()) throw new Error('workspaceId is required')
    if (!request.command.trim()) throw new Error('command is required')
    const cwd = await realpath(path.resolve(request.cwd))
    if (!(await stat(cwd)).isDirectory()) throw new Error(`process cwd is not a directory: ${cwd}`)
    const cols = positiveDimension(request.cols, 120, 'cols')
    const rows = positiveDimension(request.rows, 32, 'rows')
    const shell = request.shell ?? request.args === undefined
    const restartable = request.restartable ?? true
    const explicitEnv = Object.fromEntries(Object.entries(request.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined))
    const env: Record<string, string | undefined> = { ...process.env, ...(request.env ?? {}) }
    env.TERM ||= 'xterm-256color'
    const shellPath = request.shellPath || (process.platform === 'win32'
      ? process.env.ComSpec || 'cmd.exe'
      : process.env.SHELL || '/bin/sh')
    const file = shell ? shellPath : request.command
    const args = shell
      ? process.platform === 'win32' ? ['/d', '/s', '/c', request.command] : ['-lc', request.command]
      : [...(request.args ?? [])]
    const command = shell ? request.command : [request.command, ...args].map(quoteArg).join(' ')
    const now = new Date().toISOString()
    const starting = await this.persistence.createProcess({
      workspaceId: request.workspaceId,
      name: request.name?.trim() || path.basename(request.command),
      command,
      cwd,
      status: 'starting',
      pid: null,
      exitCode: null,
      cols,
      rows,
      restartable,
      startedAt: null,
      endedAt: null,
    })

    const recipe: ProcessRestartRecipe = {
      workspaceId: request.workspaceId,
      name: starting.name,
      command: request.command,
      ...(request.args ? { args: [...request.args] } : {}),
      shell,
      ...(shell ? { shellPath } : {}),
      cwd,
      env: explicitEnv,
      cols,
      rows,
      restartable,
    }
    await this.persistence.saveRestartRecipe?.(starting.id, recipe)

    let pty: PtyHandle
    try {
      pty = this.backend.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      })
    } catch (error) {
      const failed = await this.persistence.updateProcess(starting.id, {
        status: 'failed', endedAt: new Date().toISOString(), exitCode: null,
      })
      await this.emit({
        kind: 'process.failed', processId: failed.id, workspaceId: failed.workspaceId,
        at: new Date().toISOString(), payload: { phase: 'spawn', error: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }

    let resolveExit!: (record: ProcessRecord) => void
    const exitPromise = new Promise<ProcessRecord>((resolve) => { resolveExit = resolve })
    let resolveStarted!: () => void
    const startBarrier = new Promise<void>((resolve) => { resolveStarted = resolve })
    const state: RuntimeState = {
      record: starting,
      pty,
      recipe,
      seq: 0,
      output: [],
      outputBytes: 0,
      outputQueue: Promise.resolve(),
      lifecycleQueue: Promise.resolve(),
      lastPruneBefore: 0,
      stopRequested: false,
      finalized: false,
      exitPromise,
      resolveExit,
      startBarrier,
      resolveStarted,
    }
    this.states.set(starting.id, state)
    state.dataDisposable = pty.onData((data) => this.capture(state, data))
    state.exitDisposable = pty.onExit((event) => { void this.finalizeExit(state, event.exitCode, event.signal) })

    try {
      await this.updateRecord(state, { status: 'running', pid: pty.pid, startedAt: now })
    } catch (error) {
      state.resolveStarted()
      try { pty.kill(process.platform === 'win32' ? undefined : 'SIGKILL') } catch { /* best effort */ }
      throw error
    }
    await this.emitFor(state, 'process.started', {
      pid: pty.pid,
      cols,
      rows,
      ...(request.restartedFrom !== undefined ? { restartedFrom: request.restartedFrom } : {}),
    })
    if (request.restartedFrom !== undefined)
      await this.emitFor(state, 'process.restarted', { previousProcessId: request.restartedFrom })
    state.resolveStarted()
    return clone(state.record)
  }

  async get(processId: OsId): Promise<ProcessRecord | undefined> {
    const state = this.states.get(processId)
    return state ? clone(state.record) : this.persistence.getProcess(processId)
  }

  async list(workspaceId?: OsId): Promise<ProcessRecord[]> {
    return (await this.persistence.listProcesses(workspaceId)).map(clone)
  }

  hasLiveProcesses(workspaceId: OsId): boolean {
    return [...this.states.values()].some((state) =>
      state.record.workspaceId === workspaceId && !terminalStatuses.has(state.record.status))
  }

  async write(processId: OsId, data: string | Buffer, source: 'human' | 'driver' = 'human'): Promise<void> {
    const state = this.live(processId)
    if (state.record.status !== 'running') throw new Error(`process ${processId} is not accepting input`)
    state.pty.write(data)
    await this.emitFor(state, 'process.input', { source, bytes: Buffer.byteLength(data) })
  }

  async resize(processId: OsId, cols: number, rows: number): Promise<ProcessRecord> {
    const state = this.live(processId)
    const nextCols = positiveDimension(cols, state.record.cols, 'cols')
    const nextRows = positiveDimension(rows, state.record.rows, 'rows')
    state.pty.resize(nextCols, nextRows)
    await this.updateRecord(state, { cols: nextCols, rows: nextRows })
    await this.emitFor(state, 'process.resized', { cols: nextCols, rows: nextRows })
    return clone(state.record)
  }

  async signal(processId: OsId, signal: NodeJS.Signals): Promise<void> {
    if (!signalNames.has(signal)) throw new Error(`unsupported signal: ${signal}`)
    const state = this.live(processId)
    this.sendSignal(state, signal)
    await this.emitFor(state, 'process.signal', { signal })
  }

  async stop(processId: OsId, graceMs = 3_000): Promise<ProcessRecord> {
    const known = await this.get(processId)
    if (!known) throw new Error(`process ${processId} not found`)
    if (terminalStatuses.has(known.status)) return known
    const state = this.live(processId)
    const grace = Math.min(30_000, Math.max(0, Math.floor(graceMs)))
    state.stopRequested = true
    await this.updateRecord(state, { status: 'stopping' })
    await this.emitFor(state, 'process.stopping', { graceMs: grace })
    this.sendSignal(state, 'SIGTERM')
    await this.emitFor(state, 'process.signal', { signal: 'SIGTERM', reason: 'stop' })
    if (await this.waitForExit(state, grace)) {
      await this.flush(processId)
      return clone(state.record)
    }
    this.sendSignal(state, 'SIGKILL')
    await this.emitFor(state, 'process.signal', { signal: 'SIGKILL', reason: 'stop-timeout' })
    if (!(await this.waitForExit(state, 2_000))) throw new Error(`process ${processId} did not exit after SIGKILL`)
    await this.flush(processId)
    return clone(state.record)
  }

  async restart(processId: OsId): Promise<ProcessRecord> {
    const record = await this.get(processId)
    if (!record) throw new Error(`process ${processId} not found`)
    if (!terminalStatuses.has(record.status)) throw new Error(`process ${processId} must stop before restart`)
    const recipe = await this.restartRecipe(processId)
    if (!recipe?.restartable) throw new Error(`process ${processId} is not restartable`)
    return this.spawn({ ...recipe, restartedFrom: processId })
  }

  async restartRecipe(processId: OsId): Promise<ProcessRestartRecipe | undefined> {
    const state = this.states.get(processId)
    if (state) return clone(state.recipe)
    const persisted = await this.persistence.getRestartRecipe?.(processId)
    if (persisted) return clone(persisted)
    const record = await this.persistence.getProcess(processId)
    if (!record?.restartable) return undefined
    return {
      workspaceId: record.workspaceId,
      name: record.name,
      command: record.command,
      shell: true,
      cwd: record.cwd,
      env: {},
      cols: record.cols,
      rows: record.rows,
      restartable: true,
    }
  }

  async readOutput(processId: OsId, afterSeq = 0, limit = 1_000): Promise<OutputPage> {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new Error('afterSeq must be a non-negative integer')
    const pageSize = Math.min(10_000, Math.max(1, Math.floor(limit)))
    const state = this.states.get(processId)
    if (!state && !(await this.persistence.getProcess(processId))) throw new Error(`process ${processId} not found`)
    if (state) await state.outputQueue
    let chunks: ProcessOutputChunk[]
    if (this.persistence.readOutput) {
      chunks = await this.persistence.readOutput(processId, afterSeq, pageSize)
    } else {
      chunks = (state?.output ?? []).filter((chunk) => chunk.seq > afterSeq).slice(0, pageSize)
    }
    chunks = chunks.filter((chunk) => chunk.seq > afterSeq).sort((a, b) => a.seq - b.seq).slice(0, pageSize)
    const first = chunks[0]?.seq
    return {
      chunks: chunks.map(clone),
      nextSeq: chunks.at(-1)?.seq ?? afterSeq,
      truncated: first !== undefined && first > afterSeq + 1,
    }
  }

  async *events(processId: OsId): AsyncIterable<RuntimeStreamItem> {
    const known = await this.get(processId)
    if (!known) throw new Error(`process ${processId} not found`)
    if (terminalStatuses.has(known.status)) {
      yield { type: 'event', event: this.terminalEvent(known) }
      return
    }
    const queue = new AsyncQueue<RuntimeStreamItem>()
    const listeners = this.subscribers.get(processId) ?? new Set()
    const listener = (item: RuntimeStreamItem) => {
      queue.push(item)
      if (item.type === 'event' && ['process.exited', 'process.failed', 'process.stopped', 'process.lost'].includes(item.event.kind))
        queue.close()
    }
    listeners.add(listener)
    this.subscribers.set(processId, listeners)
    const afterSubscribe = await this.get(processId)
    if (afterSubscribe && terminalStatuses.has(afterSubscribe.status))
      listener({ type: 'event', event: this.terminalEvent(afterSubscribe) })
    try {
      for await (const item of queue) yield item
    } finally {
      listeners.delete(listener)
      if (listeners.size === 0) this.subscribers.delete(processId)
      queue.close()
    }
  }

  async discoverPorts(workspaceId?: OsId): Promise<ProcessPort[]> {
    const processes = [...this.states.values()].map((state) => state.record)
      .filter((record) => record.pid !== null && ['running', 'stopping'].includes(record.status) &&
        (workspaceId === undefined || record.workspaceId === workspaceId))
    if (this.options.discoverPorts) return this.options.discoverPorts(processes.map(clone))
    if (process.platform === 'win32' || processes.length === 0) return []
    return this.discoverUnixPorts(processes)
  }

  async reconcileLost(): Promise<ProcessRecord[]> {
    const lost: ProcessRecord[] = []
    for (const record of await this.persistence.listRunningProcesses()) {
      const state = this.states.get(record.id)
      if (state && !terminalStatuses.has(state.record.status)) continue
      const updated = await this.persistence.updateProcess(record.id, {
        status: 'lost', pid: null, endedAt: new Date().toISOString(), exitCode: null,
      })
      lost.push(updated)
      await this.emit({
        kind: 'process.lost', processId: updated.id, workspaceId: updated.workspaceId,
        at: new Date().toISOString(), payload: { previousPid: record.pid, restartable: record.restartable },
      })
    }
    return lost.map(clone)
  }

  async flush(processId?: OsId): Promise<void> {
    const states = processId === undefined ? [...this.states.values()] : [this.states.get(processId)].filter(Boolean) as RuntimeState[]
    await Promise.all(states.flatMap((state) => [state.outputQueue, state.lifecycleQueue]))
    await this.eventQueue
  }

  async shutdown(graceMs = 1_000): Promise<void> {
    const ids = [...this.states.values()]
      .filter((state) => !terminalStatuses.has(state.record.status))
      .map((state) => state.record.id)
    await Promise.allSettled(ids.map((id) => this.stop(id, graceMs)))
    await this.flush()
  }

  private capture(state: RuntimeState, data: string): void {
    if (state.finalized) return
    const chunk: ProcessOutputChunk = {
      processId: state.record.id,
      seq: ++state.seq,
      stream: 'pty',
      data,
      createdAt: new Date().toISOString(),
    }
    state.output.push(chunk)
    state.outputBytes += Buffer.byteLength(data)
    while (state.output.length > 1 && (state.output.length > this.maxOutputChunks || state.outputBytes > this.maxOutputBytes)) {
      const removed = state.output.shift()!
      state.outputBytes -= Buffer.byteLength(removed.data)
    }
    const pruneBefore = state.output[0]?.seq ?? chunk.seq
    this.publish(state.record.id, { type: 'output', output: clone(chunk) })
    const operation = state.outputQueue.then(async () => {
      await this.persistence.appendOutput(chunk)
      if (this.persistence.pruneOutput && pruneBefore > state.lastPruneBefore) {
        await this.persistence.pruneOutput(state.record.id, pruneBefore)
        state.lastPruneBefore = pruneBefore
      }
    })
    state.outputQueue = operation.catch((error) => this.persistenceError(state, 'appendOutput', error))
  }

  private async finalizeExit(state: RuntimeState, exitCode: number, signal?: number): Promise<void> {
    if (state.finalized) return
    state.finalized = true
    await state.startBarrier
    await state.outputQueue
    const status = statusForExit(state.stopRequested, exitCode)
    try {
      await this.updateRecord(state, {
        status,
        pid: null,
        exitCode,
        endedAt: new Date().toISOString(),
      })
      await this.emitFor(state, status === 'stopped' ? 'process.stopped' : status === 'exited' ? 'process.exited' : 'process.failed', {
        exitCode,
        ...(signal !== undefined ? { signal } : {}),
      })
    } finally {
      state.dataDisposable?.dispose()
      state.exitDisposable?.dispose()
      state.resolveExit(clone(state.record))
      this.states.delete(state.record.id)
    }
  }

  private live(processId: OsId): RuntimeState {
    const state = this.states.get(processId)
    if (!state || terminalStatuses.has(state.record.status)) throw new Error(`process ${processId} is not running`)
    return state
  }

  private sendSignal(state: RuntimeState, signal: NodeJS.Signals): void {
    if (process.platform === 'win32') {
      if (signal === 'SIGINT') state.pty.write('\x03')
      else if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGHUP') state.pty.kill()
      else throw new Error(`${signal} is not supported on Windows PTYs`)
      return
    }
    state.pty.kill(signal)
  }

  private async waitForExit(state: RuntimeState, timeoutMs: number): Promise<boolean> {
    if (state.finalized) return true
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
    const exited = state.exitPromise.then(() => true as const)
    const result = await Promise.race([exited, timedOut])
    if (timer) clearTimeout(timer)
    return result
  }

  private updateRecord(state: RuntimeState, patch: ProcessPatch): Promise<void> {
    const operation = state.lifecycleQueue.then(async () => {
      try {
        state.record = await this.persistence.updateProcess(state.record.id, patch)
      } catch (error) {
        state.record = { ...state.record, ...patch }
        throw error
      }
    })
    state.lifecycleQueue = operation.catch((error) => this.persistenceError(state, 'updateProcess', error))
    return operation
  }

  private async emitFor(state: RuntimeState, kind: RuntimeEvent['kind'], payload: Record<string, unknown>): Promise<void> {
    await this.emit({ kind, processId: state.record.id, workspaceId: state.record.workspaceId, at: new Date().toISOString(), payload })
  }

  private emit(event: RuntimeEvent): Promise<void> {
    this.publish(event.processId, { type: 'event', event: clone(event) })
    if (!this.persistence.onEvent) return Promise.resolve()
    const operation = this.eventQueue.then(() => this.persistence.onEvent!(event))
    this.eventQueue = operation.catch((error) => {
      const persistenceEvent: RuntimeEvent = {
        kind: 'process.persistence_error',
        processId: event.processId,
        workspaceId: event.workspaceId,
        at: new Date().toISOString(),
        payload: { operation: 'onEvent', error: error instanceof Error ? error.message : String(error) },
      }
      this.publish(event.processId, { type: 'event', event: persistenceEvent })
    })
    return this.eventQueue
  }

  private persistenceError(state: RuntimeState, operation: string, error: unknown): void {
    const event: RuntimeEvent = {
      kind: 'process.persistence_error',
      processId: state.record.id,
      workspaceId: state.record.workspaceId,
      at: new Date().toISOString(),
      payload: { operation, error: error instanceof Error ? error.message : String(error) },
    }
    this.publish(event.processId, { type: 'event', event })
  }

  private publish(processId: OsId, item: RuntimeStreamItem): void {
    for (const listener of this.subscribers.get(processId) ?? []) listener(item)
  }

  private terminalEvent(record: ProcessRecord): RuntimeEvent {
    return {
      kind: record.status === 'lost' ? 'process.lost' : record.status === 'stopped' ? 'process.stopped'
        : record.status === 'failed' ? 'process.failed' : 'process.exited',
      processId: record.id,
      workspaceId: record.workspaceId,
      at: record.endedAt ?? new Date().toISOString(),
      payload: { exitCode: record.exitCode },
    }
  }

  private async discoverUnixPorts(processes: ProcessRecord[]): Promise<ProcessPort[]> {
    const roots = new Map(processes.map((record) => [record.pid!, record]))
    const owner = new Map<number, ProcessRecord>(roots)
    try {
      const ps = await this.command('ps', ['-axo', 'pid=,ppid='])
      const rows = ps.stdout.split('\n').map((line) => line.trim().split(/\s+/).map(Number))
        .filter((row) => row.length === 2 && row.every(Number.isFinite)) as [number, number][]
      let changed = true
      while (changed) {
        changed = false
        for (const [pid, ppid] of rows) {
          if (!owner.has(pid) && owner.has(ppid)) { owner.set(pid, owner.get(ppid)!); changed = true }
        }
      }
      const pids = [...owner.keys()]
      if (pids.length === 0) return []
      const lsof = await this.command('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fpn'])
      const ports: ProcessPort[] = []
      let pid: number | undefined
      for (const line of lsof.stdout.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1))
        if (!pid || !line.startsWith('n')) continue
        const match = line.slice(1).match(/^(?:TCP\s+)?(.+):(\d+)$/)
        if (!match) continue
        const record = owner.get(pid)
        if (!record) continue
        ports.push({
          processId: record.id,
          workspaceId: record.workspaceId,
          pid,
          host: match[1].replace(/^\[|\]$/g, ''),
          port: Number(match[2]),
          protocol: 'tcp',
        })
      }
      return ports.filter((entry, index, all) =>
        all.findIndex((other) => other.processId === entry.processId && other.pid === entry.pid && other.port === entry.port) === index)
    } catch {
      return []
    }
  }

  private command(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(error)
        else resolve({ stdout: String(stdout), stderr: String(stderr) })
      })
    })
  }
}
