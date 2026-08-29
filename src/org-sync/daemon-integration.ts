import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { agentActivity } from '../../web/src/agentActivity.js'
import { openDb } from '../db.js'
import { loadOrgCredential, type OrgCredential } from './credentials.js'
import { HubClient, type HubSyncEvent, type OpResult } from './hub-client.js'
import { LocalBoardState, type LocalBoardEvent } from './local-board-state.js'
import { Outbox } from './outbox.js'
import { SyncLoop, type SyncLoopOptions, type SyncState } from './sync-loop.js'

export interface LocalSyncAgent {
  id: number
  board_id: number
  name: string
  status: string
  last_seen: string | null
}

export function listLocalPresenceAgents(db: Database.Database): LocalSyncAgent[] {
  return db.prepare(`SELECT id, board_id, name, status, last_seen
    FROM agents
    WHERE status <> 'gone' AND org_sync_remote_origin IS NULL
    ORDER BY board_id, name`).all() as LocalSyncAgent[]
}

export interface DaemonHubClient {
  get(path: string, query?: Record<string, string | number | boolean | undefined>, signal?: AbortSignal): Promise<unknown>
  postOp(op: string, payload: unknown, idempotencyKey?: string, signal?: AbortSignal): Promise<OpResult>
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
  flush?(): Promise<void>
}

export interface LocalHubOp {
  op: string
  payload: unknown
  localCardId?: number
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
  localDb?: Database.Database
  publishLocalChange?: (event: LocalBoardEvent) => void
  localBoardId?: number
  listLocalAgents?: () => LocalSyncAgent[]
  output?: (line: string) => void
  heartbeatMs?: number
  subscribeLocalChanges?: (listener: (change: unknown) => void) => () => void
  mapLocalChange?: (
    change: unknown,
    hubBoardId: string,
  ) => LocalHubOp | null | Promise<LocalHubOp | null>
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
  let unsubscribeLocalChanges: (() => void) | undefined
  let ownedLocalDb: Database.Database | undefined
  const sidecarController = new AbortController()
  let terminal = false
  try {
    const client = options.createClient?.(credential) ?? new HubClient(credential)
    const outbox = options.createOutbox?.(home) ?? new Outbox(home)
    const localDb = options.applyEvent ? undefined : options.localDb ?? (ownedLocalDb = openDb(path.join(home, 'orchestra.db')))
    const localState = localDb ? new LocalBoardState({
      db: localDb,
      orgId: credential.orgId,
      publish: options.publishLocalChange,
      localBoardId: options.localBoardId,
    }) : undefined
    const applyEvent = options.applyEvent ?? ((event: HubSyncEvent) => localState!.apply(event))
    localState?.reconcileOutbound(outbox.pending())
    const onStateChange = (state: SyncState) => {
      if (state === 'offline') {
        output(`org-sync offline (${credential.orgId}); local daemon remains available`)
        return
      }
      if (state !== 'auth-failed' && state !== 'terminal') return
      terminal = true
      if (timer) clearInterval(timer)
      timer = undefined
      sidecarController.abort()
      const reason = state === 'auth-failed'
        ? 'authorization failed; rejoin the organization with a valid device token'
        : 'stopped after a non-retryable hub failure'
      output(`org-sync ${state} (${credential.orgId}): ${reason}; local daemon remains available`)
    }
    loop = options.createLoop?.({
      client,
      outbox,
      home,
      applyEvent,
      onStateChange,
      onConflict: (error) => output(
        `org-sync conflict: shared card changed or was claimed by someone else; ask the current owner before retrying (${safeError(error)})`,
      ),
      onError: (error) => output(`org-sync degraded: ${safeError(error)}; local daemon remains available`),
    }) ?? new SyncLoop({
      client,
      outbox,
      home,
      applyEvent,
      onStateChange,
      onConflict: (error) => output(
        `org-sync conflict: shared card changed or was claimed by someone else; ask the current owner before retrying (${safeError(error)})`,
      ),
      onError: (error) => output(`org-sync degraded: ${safeError(error)}; local daemon remains available`),
    })
    loop.start()

    const board = new HubBoardResolver(client)
    const presence = new PresencePublisher(client, board, options.listLocalAgents ?? (() => []), output)
    const mapLocalChange = options.mapLocalChange
      ?? (localState ? ((change: unknown, hubBoardId: string) => localState.mapLocalChange(change, hubBoardId)) : undefined)
    if (options.subscribeLocalChanges && mapLocalChange) {
      unsubscribeLocalChanges = options.subscribeLocalChanges((change) => {
        void (async () => {
          localState?.reconcileOutbound(outbox.pending())
          const operation = await mapLocalChange(change, await board.id(sidecarController.signal))
          if (!operation) return
          const queuedId = outbox.enqueue(operation.op, operation.payload)
          if (operation.localCardId !== undefined && localState) {
            const queued = outbox.pending().find((item) => item.id === queuedId)
            if (!queued) throw new Error('organization sync could not read the operation it just queued')
            localState.recordOutboundEnqueued(operation.localCardId, queued.idempotencyKey)
          }
          await loop?.flush?.()
        })().catch((error) => output(`org-sync outbound degraded: ${safeError(error)}`))
      })
    }
    if (!terminal) {
      void presence.tick(sidecarController.signal)
      timer = setInterval(() => {
        void presence.tick(sidecarController.signal)
        void loop?.flush?.().catch((error) => output(`org-sync outbound degraded: ${safeError(error)}`))
      }, options.heartbeatMs ?? 15_000)
      timer.unref()
    }
    output(`org-sync on: ${credential.orgId} at ${credential.hubBaseUrl} as ${credential.deviceName}`)

    let stopped = false
    return {
      state: () => loop!.state(),
      stop: async () => {
        if (stopped) return
        stopped = true
        if (timer) clearInterval(timer)
        timer = undefined
        sidecarController.abort()
        unsubscribeLocalChanges?.()
        unsubscribeLocalChanges = undefined
        await loop!.stop()
        ownedLocalDb?.close()
        ownedLocalDb = undefined
      },
    }
  } catch (error) {
    if (timer) clearInterval(timer)
    sidecarController.abort()
    unsubscribeLocalChanges?.()
    await loop?.stop().catch(() => undefined)
    ownedLocalDb?.close()
    output(`org-sync unavailable: ${safeError(error)}; local daemon remains available`)
    return null
  }
}

class PresencePublisher {
  readonly #agentIds = new Map<string, string>()
  #running = false

  constructor(
    private readonly client: DaemonHubClient,
    private readonly board: HubBoardResolver,
    private readonly listLocalAgents: () => LocalSyncAgent[],
    private readonly output: (line: string) => void,
  ) {}

  async tick(signal?: AbortSignal): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      const boardId = await this.board.id(signal)
      for (const agent of this.listLocalAgents()) {
        const activity = agentActivity(agent)
        if (activity === 'gone') continue
        let agentId = this.#agentIds.get(agent.name)
        if (!agentId) {
          const registered = await this.client.postOp('agent.register', {
            board_id: boardId,
            name: agent.name,
          }, undefined, signal)
          agentId = entityId(registered.result, 'agent.register')
          this.#agentIds.set(agent.name, agentId)
        }
        await this.client.postOp('agent.heartbeat', {
          agent_id: agentId,
          state: activity === 'working' ? 'working' : 'idle',
          current_card_id: null,
          activity,
        }, undefined, signal)
      }
    } catch (error) {
      if (!isAbortError(error)) this.output(`org-sync presence degraded: ${safeError(error)}`)
    } finally {
      this.#running = false
    }
  }

}

class HubBoardResolver {
  #boardId?: string

  constructor(private readonly client: DaemonHubClient) {}

  async id(signal?: AbortSignal): Promise<string> {
    if (this.#boardId) return this.#boardId
    const response = await this.client.get('boards', {}, signal) as { boards?: unknown }
    if (!Array.isArray(response?.boards)) throw new Error('hub returned an invalid board listing')
    const boards = response.boards.filter(isBoardListing)
    const selected = boards.find((board) => board.project_name === 'Default project') ?? boards[0]
    if (!selected) throw new Error('the hosted organization has no board for daemon presence')
    this.#boardId = selected.id
    return selected.id
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

const safeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : 'unknown sync failure'
  return message.replace(/orchestra_device_v1\.[^\s"']+/g, '[redacted device token]')
}

const isAbortError = (error: unknown): error is Error =>
  error instanceof Error && error.name === 'AbortError'
