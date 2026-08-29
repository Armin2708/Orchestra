import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { agentActivity } from '../../web/src/agentActivity.js'
import { loadOrgCredential, type OrgCredential } from './credentials.js'
import { HubClient, type HubSyncEvent, type OpResult } from './hub-client.js'
import { Outbox } from './outbox.js'
import { SyncLoop, type SyncLoopOptions, type SyncState } from './sync-loop.js'

export interface LocalSyncAgent {
  id: number
  board_id: number
  name: string
  status: string
  last_seen: string | null
}

export interface DaemonHubClient {
  get(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<unknown>
  postOp(op: string, payload: unknown, idempotencyKey?: string): Promise<OpResult>
  streamSince(
    seq: number,
    onEvent: (event: HubSyncEvent) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void>
}

export interface DaemonOrgSyncLoop {
  start(): void
  stop(): Promise<void>
  state(): SyncState
}

export interface DaemonOrgSyncHandle {
  state(): SyncState
  stop(): Promise<void>
}

export interface StartDaemonOrgSyncOptions {
  home?: string
  loadCredential?: () => Promise<OrgCredential | null>
  createClient?: (credential: OrgCredential) => DaemonHubClient
  createLoop?: (options: SyncLoopOptions) => DaemonOrgSyncLoop
  createOutbox?: (home: string) => Outbox
  applyEvent?: (event: HubSyncEvent) => void | Promise<void>
  listLocalAgents?: () => LocalSyncAgent[]
  output?: (line: string) => void
  heartbeatMs?: number
}

/**
 * Adds hosted-org sync as a strictly optional daemon sidecar. Every setup failure is
 * contained here so `serve()` can continue serving the local product unchanged.
 */
export async function startDaemonOrgSync(
  options: StartDaemonOrgSyncOptions = {},
): Promise<DaemonOrgSyncHandle | null> {
  const output = options.output ?? console.log
  const home = options.home ?? process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
  const load = options.loadCredential ?? (() => loadOrgCredential(home))
  const credential = await load().catch(() => null)
  if (!credential) {
    output('org-sync off (no organization joined)')
    return null
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let loop: DaemonOrgSyncLoop | undefined
  try {
    const client = options.createClient?.(credential) ?? new HubClient(credential)
    const outbox = options.createOutbox?.(home) ?? new Outbox(home)
    const mirror = options.applyEvent ? undefined : new OrgStateMirror(home)
    loop = options.createLoop?.({
      client,
      outbox,
      home,
      applyEvent: options.applyEvent ?? ((event) => mirror!.apply(event)),
      onStateChange: (state) => {
        if (state === 'offline') output(`org-sync offline (${credential.orgId}); local daemon remains available`)
      },
      onConflict: (error) => output(
        `org-sync conflict: shared card changed or was claimed by someone else; ask the current owner before retrying (${safeError(error)})`,
      ),
      onError: (error) => output(`org-sync degraded: ${safeError(error)}; local daemon remains available`),
    }) ?? new SyncLoop({
      client,
      outbox,
      home,
      applyEvent: options.applyEvent ?? ((event) => mirror!.apply(event)),
      onStateChange: (state) => {
        if (state === 'offline') output(`org-sync offline (${credential.orgId}); local daemon remains available`)
      },
      onConflict: (error) => output(
        `org-sync conflict: shared card changed or was claimed by someone else; ask the current owner before retrying (${safeError(error)})`,
      ),
      onError: (error) => output(`org-sync degraded: ${safeError(error)}; local daemon remains available`),
    })
    loop.start()

    const presence = new PresencePublisher(client, options.listLocalAgents ?? (() => []), output)
    void presence.tick()
    timer = setInterval(() => { void presence.tick() }, options.heartbeatMs ?? 15_000)
    timer.unref()
    output(`org-sync on: ${credential.orgId} at ${credential.hubBaseUrl} as ${credential.deviceName}`)

    let stopped = false
    return {
      state: () => loop!.state(),
      stop: async () => {
        if (stopped) return
        stopped = true
        if (timer) clearInterval(timer)
        timer = undefined
        await loop!.stop()
      },
    }
  } catch (error) {
    if (timer) clearInterval(timer)
    await loop?.stop().catch(() => undefined)
    output(`org-sync unavailable: ${safeError(error)}; local daemon remains available`)
    return null
  }
}

class PresencePublisher {
  readonly #agentIds = new Map<string, string>()
  #boardId?: string
  #running = false

  constructor(
    private readonly client: DaemonHubClient,
    private readonly listLocalAgents: () => LocalSyncAgent[],
    private readonly output: (line: string) => void,
  ) {}

  async tick(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      const boardId = await this.#hubBoardId()
      for (const agent of this.listLocalAgents()) {
        const activity = agentActivity(agent)
        if (activity === 'gone') continue
        let agentId = this.#agentIds.get(agent.name)
        if (!agentId) {
          const registered = await this.client.postOp('agent.register', {
            board_id: boardId,
            name: agent.name,
          })
          agentId = entityId(registered.result, 'agent.register')
          this.#agentIds.set(agent.name, agentId)
        }
        await this.client.postOp('agent.heartbeat', {
          agent_id: agentId,
          state: activity === 'working' ? 'working' : 'idle',
          current_card_id: null,
          activity,
        })
      }
    } catch (error) {
      this.output(`org-sync presence degraded: ${safeError(error)}`)
    } finally {
      this.#running = false
    }
  }

  async #hubBoardId(): Promise<string> {
    if (this.#boardId) return this.#boardId
    const response = await this.client.get('boards') as { boards?: unknown }
    if (!Array.isArray(response?.boards)) throw new Error('hub returned an invalid board listing')
    const boards = response.boards.filter(isBoardListing)
    const selected = boards.find((board) => board.project_name === 'Default project') ?? boards[0]
    if (!selected) throw new Error('the hosted organization has no board for daemon presence')
    this.#boardId = selected.id
    return selected.id
  }
}

interface MirrorState {
  version: 1
  lastSeq: number
  cards: Record<string, unknown>
  agents: Record<string, unknown>
  mail: Record<string, unknown>
}

class OrgStateMirror {
  readonly #path: string
  #state: MirrorState

  constructor(home: string) {
    this.#path = path.join(home, 'org-state.json')
    this.#state = this.#load()
  }

  apply(event: HubSyncEvent): void {
    if (event.seq <= this.#state.lastSeq) return
    const next = structuredClone(this.#state)
    const payload = event.payload
    const id = entityIdOrNull(payload)
    if (typeof event.kind === 'string' && event.kind.startsWith('card.') && id) next.cards[id] = payload
    else if (event.kind === 'agent.registered' && id) next.agents[id] = payload
    else if (event.kind === 'mail.sent' && id) next.mail[id] = payload
    next.lastSeq = event.seq
    this.#persist(next)
    this.#state = next
  }

  #load(): MirrorState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#path, 'utf8')) as Partial<MirrorState>
      if (parsed.version !== 1 || !Number.isInteger(parsed.lastSeq)
        || !isRecord(parsed.cards) || !isRecord(parsed.agents) || !isRecord(parsed.mail)) {
        throw new Error('invalid organization mirror')
      }
      return parsed as MirrorState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 1, lastSeq: 0, cards: {}, agents: {}, mail: {} }
    }
  }

  #persist(state: MirrorState): void {
    fs.mkdirSync(path.dirname(this.#path), { recursive: true, mode: 0o700 })
    const temporary = path.join(path.dirname(this.#path), `.org-state.json.${process.pid}.${randomUUID()}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      fs.renameSync(temporary, this.#path)
      fs.chmodSync(this.#path, 0o600)
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* retain original failure */ }
      }
      try { fs.rmSync(temporary, { force: true }) } catch { /* retain original failure */ }
      throw error
    }
  }
}

const isBoardListing = (value: unknown): value is { id: string; project_name?: string } =>
  Boolean(value && typeof value === 'object' && typeof (value as any).id === 'string')

const entityId = (value: unknown, operation: string): string => {
  const id = entityIdOrNull(value)
  if (!id) throw new Error(`${operation} returned an invalid entity`)
  return id
}

const entityIdOrNull = (value: unknown): string | null =>
  value && typeof value === 'object' && typeof (value as any).id === 'string' ? (value as any).id : null

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const safeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : 'unknown sync failure'
  return message.replace(/orchestra_device_v1\.[^\s"']+/g, '[redacted device token]')
}
