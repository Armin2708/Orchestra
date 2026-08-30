import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listLocalPresenceAgents,
  startDaemonOrgSync,
  type DaemonOrgSyncLoop,
  type LocalSyncAgent,
} from '../src/org-sync/daemon-integration.js'
import type { OrgCredential } from '../src/org-sync/credentials.js'
import { Outbox } from '../src/org-sync/outbox.js'
import { LocalBoardState } from '../src/org-sync/local-board-state.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const homes: string[] = []
const temporaryHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-daemon-sync-'))
  homes.push(home)
  return home
}

afterEach(() => {
  vi.useRealTimers()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

const credential: OrgCredential = {
  hubBaseUrl: 'https://hub.example.test',
  orgId: 'org_example',
  deviceToken: 'orchestra_device_v1.secret-value',
  deviceName: 'workstation',
}

const fakeLoop = (): DaemonOrgSyncLoop => ({
  start: vi.fn(),
  stop: vi.fn(async () => undefined),
  state: vi.fn(() => 'live'),
  flush: vi.fn(async () => undefined),
})

describe('daemon organization sync integration', () => {
  it('leaves local mode unchanged and creates no sync loop without a credential', async () => {
    const output: string[] = []
    const createLoop = vi.fn(() => fakeLoop())

    const handle = await startDaemonOrgSync({
      home: temporaryHome(),
      loadCredential: async () => null,
      createLoop,
      output: (line) => output.push(line),
    })

    expect(handle).toBeNull()
    expect(createLoop).not.toHaveBeenCalled()
    expect(output).toEqual(['org-sync off (no organization joined)'])
  })

  it('starts one loop with a credential without logging its token', async () => {
    const output: string[] = []
    const loop = fakeLoop()

    const handle = await startDaemonOrgSync({
      home: temporaryHome(),
      loadCredential: async () => credential,
      createClient: () => ({ get: vi.fn(), postOp: vi.fn(), streamSince: vi.fn() }),
      createLoop: () => loop,
      output: (line) => output.push(line),
    })

    expect(handle).not.toBeNull()
    expect(loop.start).toHaveBeenCalledOnce()
    expect(output.join('\n')).toContain('org-sync · connecting')
    expect(output.join('\n')).toContain(credential.orgId)
    expect(output.join('\n')).not.toContain(credential.deviceToken)
    await handle?.stop()
  })

  it('isolates setup and loop-start failures from the local daemon', async () => {
    const output: string[] = []

    await expect(startDaemonOrgSync({
      home: temporaryHome(),
      loadCredential: async () => credential,
      createLoop: () => { throw new Error('sync setup failed') },
      output: (line) => output.push(line),
    })).resolves.toBeNull()

    expect(output.join('\n')).toContain('local daemon remains available')
    expect(output.join('\n')).not.toContain(credential.deviceToken)
  })

  it('registers and heartbeats live local agents using the existing activity states', async () => {
    const home = temporaryHome()
    const loop = fakeLoop()
    const posts: Array<{ op: string; payload: any }> = []
    const now = new Date().toISOString()
    const agents: LocalSyncAgent[] = [
      { id: 1, board_id: 1, name: 'alice', status: 'active', last_seen: now },
      { id: 2, board_id: 1, name: 'bob', status: 'idle', last_seen: now },
      { id: 3, board_id: 1, name: 'gone-agent', status: 'gone', last_seen: now },
    ]
    const client = {
      get: vi.fn(async () => ({ boards: [
        { id: 'board_other', project_name: 'Another project' },
        { id: 'board_default', project_name: 'Default project' },
      ] })),
      postOp: vi.fn(async (op: string, payload: any) => {
        posts.push({ op, payload })
        if (op === 'agent.register') return { result: { id: `hub_${payload.name}` }, seq: 0 }
        return { result: {}, seq: 0 }
      }),
      streamSince: vi.fn(),
    }

    const handle = await startDaemonOrgSync({
      home,
      loadCredential: async () => credential,
      createClient: () => client,
      createLoop: () => loop,
      listLocalAgents: () => agents,
      output: () => undefined,
      heartbeatMs: 60_000,
    })
    await vi.waitFor(() => expect(posts.filter((item) => item.op === 'agent.heartbeat')).toHaveLength(2))
    await handle?.stop()

    expect(posts.filter((item) => item.op === 'agent.register').map((item) => item.payload)).toEqual([
      { board_id: 'board_default', name: 'alice' },
      { board_id: 'board_default', name: 'bob' },
    ])
    expect(posts.filter((item) => item.op === 'agent.heartbeat').map((item) => item.payload)).toEqual([
      { agent_id: 'hub_alice', state: 'working', current_card_id: null, activity: 'working' },
      { agent_id: 'hub_bob', state: 'idle', current_card_id: null, activity: 'idle' },
    ])
  })

  it('does not heartbeat an agent mirrored from an inbound hub event', async () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/project', 'Project')`).run()
    db.prepare(`INSERT INTO agents (board_id, name, status) VALUES (1, 'local-agent', 'idle')`).run()
    const posts: Array<{ op: string; payload: any }> = []
    const client = {
      get: vi.fn(async () => ({ boards: [{ id: 'board_default', project_name: 'Default project' }] })),
      postOp: vi.fn(async (op: string, payload: any) => {
        posts.push({ op, payload })
        return { result: op === 'agent.register' ? { id: `hub_${payload.name}` } : {}, seq: 0 }
      }),
      streamSince: vi.fn(),
    }
    const handle = await startDaemonOrgSync({
      home: temporaryHome(),
      loadCredential: async () => credential,
      createClient: () => client,
      createLoop: (options) => ({
        ...fakeLoop(),
        start: () => {
          void options.applyEvent({
            id: 'evt_remote_agent',
            seq: 1,
            kind: 'agent.registered',
            payload: { id: 'agent_remote', name: 'remote-agent', state: 'working' },
          })
        },
      }),
      localDb: db,
      listLocalAgents: () => listLocalPresenceAgents(db),
      output: () => undefined,
      heartbeatMs: 60_000,
    })
    await vi.waitFor(() => expect(posts.some((item) => item.op === 'agent.heartbeat')).toBe(true))
    await handle?.stop()

    expect(db.prepare(`SELECT name, org_sync_remote_origin FROM agents ORDER BY name`).all()).toEqual([
      { name: 'local-agent', org_sync_remote_origin: null },
      { name: 'remote-agent', org_sync_remote_origin: credential.orgId },
    ])
    expect(posts.filter((item) => item.op === 'agent.register').map((item) => item.payload.name))
      .toEqual(['local-agent'])
    expect(posts.filter((item) => item.op === 'agent.heartbeat')).toHaveLength(1)
    db.close()
  })

  it('backfills remote origin for an agent mirrored before the origin column existed', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO boards (project_path, name) VALUES ('/project', 'Project')`).run()
    const agentId = Number(db.prepare(`INSERT INTO agents (board_id, name, status)
      VALUES (1, 'legacy-remote', 'idle')`).run().lastInsertRowid)
    db.exec(`CREATE TABLE org_sync_agent_mappings (
      org_id TEXT NOT NULL,
      hub_agent_id TEXT NOT NULL,
      local_agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY(org_id, hub_agent_id)
    )`)
    db.prepare(`INSERT INTO org_sync_agent_mappings (org_id, hub_agent_id, local_agent_id)
      VALUES (?, 'hub_legacy', ?)`).run(credential.orgId, agentId)

    new LocalBoardState({ db, orgId: credential.orgId })

    expect(db.prepare('SELECT org_sync_remote_origin FROM agents WHERE id=?').get(agentId))
      .toEqual({ org_sync_remote_origin: credential.orgId })
    expect(listLocalPresenceAgents(db)).toEqual([])
    db.close()
  })

  it('stops the loop and heartbeat timer cleanly', async () => {
    vi.useFakeTimers()
    const loop = fakeLoop()
    const client = {
      get: vi.fn(async () => ({ boards: [{ id: 'board_default', project_name: 'Default project' }] })),
      postOp: vi.fn(async (op: string) => ({ result: op === 'agent.register' ? { id: 'agent_1' } : {}, seq: 0 })),
      streamSince: vi.fn(),
    }
    const handle = await startDaemonOrgSync({
      home: temporaryHome(),
      loadCredential: async () => credential,
      createClient: () => client,
      createLoop: () => loop,
      listLocalAgents: () => [{ id: 1, board_id: 1, name: 'alice', status: 'idle', last_seen: new Date().toISOString() }],
      output: () => undefined,
      heartbeatMs: 15_000,
    })
    await vi.advanceTimersByTimeAsync(1)
    await handle?.stop()
    const callsAtStop = client.postOp.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)

    expect(loop.stop).toHaveBeenCalledOnce()
    expect(client.postOp).toHaveBeenCalledTimes(callsAtStop)
  })

  it('stops presence heartbeats when the sync loop reports terminal auth failure', async () => {
    vi.useFakeTimers()
    const output: string[] = []
    let onStateChange: ((state: 'auth-failed') => void) | undefined
    const loop = fakeLoop()
    const client = {
      get: vi.fn(async () => ({ boards: [{ id: 'board_default', project_name: 'Default project' }] })),
      postOp: vi.fn(async (op: string) => ({ result: op === 'agent.register' ? { id: 'agent_1' } : {}, seq: 0 })),
      streamSince: vi.fn(),
    }
    const handle = await startDaemonOrgSync({
      home: temporaryHome(),
      loadCredential: async () => credential,
      createClient: () => client,
      createLoop: (options) => {
        onStateChange = options.onStateChange as typeof onStateChange
        return loop
      },
      listLocalAgents: () => [{
        id: 1, board_id: 1, name: 'alice', status: 'idle', last_seen: new Date().toISOString(),
      }],
      output: (line) => output.push(line),
      heartbeatMs: 15_000,
    })
    await vi.advanceTimersByTimeAsync(1)
    expect(client.postOp).toHaveBeenCalled()

    onStateChange?.('auth-failed')
    const callsAtFailure = client.postOp.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)

    expect(client.postOp).toHaveBeenCalledTimes(callsAtFailure)
    expect(output.join('\n')).toContain('org-sync · stopped')
    await handle?.stop()
  })

  /**
   * Reported verbatim from a real terminal: an unsubscribed org produced six lines for one
   * fact — the hub's refusal printed twice, then three "outbound degraded: This operation
   * was aborted" from the aborts our own shutdown had just caused.
   */
  it('reports a terminal failure once, with no abort spam after it', async () => {
    vi.useFakeTimers()
    const output: string[] = []
    let onStateChange: ((state: string) => void) | undefined
    let onError: ((error: unknown) => void) | undefined
    const loop = fakeLoop()
    const client = {
      get: vi.fn(async () => ({ boards: [{ id: 'board_1' }] })),
      postOp: vi.fn(async () => ({ result: {}, seq: 0 })),
      streamSince: vi.fn(),
    }
    const refusal = Object.assign(
      new Error('this org has no subscription — writes are disabled until one is started.'),
      { retryable: false },
    )

    const handle = await startDaemonOrgSync({
      home: temporaryHome(),
      loadCredential: async () => credential,
      createClient: () => client as never,
      createLoop: (options) => {
        onStateChange = options.onStateChange as typeof onStateChange
        onError = options.onError as typeof onError
        return loop
      },
      listLocalAgents: () => [],
      output: (line) => output.push(line),
      heartbeatMs: 15_000,
    })

    // exactly the sequence the daemon produced: a non-retryable refusal, then terminal
    onError?.(refusal)
    onStateChange?.('auth-failed')
    await vi.advanceTimersByTimeAsync(60_000)

    const text = output.join('\n')
    const mentions = output.filter((line) => line.includes('no subscription')).length
    expect(mentions, `the refusal must be reported once, got:\n${text}`).toBe(1)
    expect(text).toContain('org-sync · stopped')
    expect(text).not.toMatch(/aborted/i)
    expect(text.split('\n').length).toBeLessThanOrEqual(4)
    await handle?.stop()
    vi.useRealTimers()
  })

  it('durably enqueues a local change and wakes the live sender', async () => {
    const home = temporaryHome()
    const loop = fakeLoop()
    const outbox = new Outbox(home)
    let listener: ((change: unknown) => void) | undefined
    const unsubscribe = vi.fn()
    const client = {
      get: vi.fn(async () => ({ boards: [{ id: 'board_default', project_name: 'Default project' }] })),
      postOp: vi.fn(),
      streamSince: vi.fn(),
    }
    const handle = await startDaemonOrgSync({
      home,
      loadCredential: async () => credential,
      createClient: () => client,
      createOutbox: () => outbox,
      createLoop: () => loop,
      output: () => undefined,
      subscribeLocalChanges: (next) => { listener = next; return unsubscribe },
      mapLocalChange: (_change, boardId) => ({
        op: 'card.create', payload: { board_id: boardId, title: 'Local card' },
      }),
    })

    listener?.({ type: 'card' })
    await vi.waitFor(() => expect(outbox.size()).toBe(1))
    await handle?.stop()

    expect(outbox.pending()[0]).toMatchObject({
      op: 'card.create', payload: { board_id: 'board_default', title: 'Local card' },
    })
    expect(loop.flush).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not open a board write transaction to reconcile an empty outbox', () => {
    const db = openDb(':memory:')
    const localState = new LocalBoardState({ db, orgId: credential.orgId })
    const transaction = vi.spyOn(db, 'transaction')

    localState.reconcileOutbound([])

    expect(transaction).not.toHaveBeenCalled()
    db.close()
  })

  /**
   * The local/cloud split, enforced: personal boards are private, and only the org's own
   * local board is shared. Before this, the daemon subscribed to the whole event bus and
   * mapped ANY card event outbound — a card created on any personal project board on the
   * machine was pushed to the shared org board every teammate can see.
   */
  it('never syncs a card from a personal board to the organization', async () => {
    const home = temporaryHome()
    const db = openDb(':memory:')
    const server = buildServer(db)
    await server.ready()
    const personalBoard = Number(db.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/personal-project', 'Personal')`).run().lastInsertRowid)
    const loop = fakeLoop()
    const outbox = new Outbox(home)
    const client = {
      get: vi.fn(async () => ({ boards: [{ id: 'board_default', project_name: 'Default project' }] })),
      postOp: vi.fn(),
      streamSince: vi.fn(),
    }
    const handle = await startDaemonOrgSync({
      home,
      loadCredential: async () => credential,
      createClient: () => client,
      createOutbox: () => outbox,
      createLoop: () => loop,
      localDb: db,
      publishLocalChange: (event) => server.bus.emit('event', event),
      subscribeLocalChanges: (listener) => {
        server.bus.on('event', listener)
        return () => server.bus.off('event', listener)
      },
      listLocalAgents: () => [],
      output: () => undefined,
      heartbeatMs: 60_000,
    })
    const orgBoard = (db.prepare(`SELECT local_board_id AS id FROM org_sync_boards
      WHERE org_id=?`).get(credential.orgId) as { id: number }).id

    await server.inject({ method: 'POST', url: '/api/v1/cards', payload: {
      board_id: personalBoard, title: 'Private card — must stay private',
    } })
    const shared = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: {
      board_id: orgBoard, title: 'Shared card',
    } })).json().card
    await vi.waitFor(() => expect(outbox.size()).toBe(1))
    await new Promise((resolve) => setImmediate(resolve))

    // exactly one operation queued, and it is the org-board card
    expect(outbox.size()).toBe(1)
    expect(outbox.pending().map((item: any) => item.payload._local_card_id)).toEqual([shared.id])
    expect(JSON.stringify(outbox.pending())).not.toContain('Private card')

    await handle?.stop()
    await server.close()
    db.close()
  })

  it('maps each local card once when milestone changes re-emit already-synced siblings', async () => {
    const home = temporaryHome()
    const db = openDb(':memory:')
    const server = buildServer(db)
    await server.ready()
    const loop = fakeLoop()
    const outbox = new Outbox(home)
    const client = {
      get: vi.fn(async () => ({ boards: [{ id: 'board_default', project_name: 'Default project' }] })),
      postOp: vi.fn(),
      streamSince: vi.fn(),
    }
    const handle = await startDaemonOrgSync({
      home,
      loadCredential: async () => credential,
      createClient: () => client,
      createOutbox: () => outbox,
      createLoop: () => loop,
      localDb: db,
      publishLocalChange: (event) => server.bus.emit('event', event),
      subscribeLocalChanges: (listener) => {
        server.bus.on('event', listener)
        return () => server.bus.off('event', listener)
      },
      listLocalAgents: () => [],
      output: () => undefined,
      heartbeatMs: 60_000,
    })

    // Cards shared with the org live on the org's own local board — the one
    // startDaemonOrgSync just ensured. Personal boards no longer sync (see below).
    const boardId = (db.prepare(`SELECT local_board_id AS id FROM org_sync_boards
      WHERE org_id=?`).get(credential.orgId) as { id: number }).id
    const first = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: {
      board_id: boardId, title: 'First card',
    } })).json().card
    const second = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: {
      board_id: boardId, title: 'Second card',
    } })).json().card
    await vi.waitFor(() => expect(outbox.size()).toBe(2))

    const milestone = (await server.inject({ method: 'POST', url: '/api/v1/milestones', payload: {
      board_id: boardId, title: 'Release',
    } })).json()
    await server.inject({ method: 'PATCH', url: `/api/v1/cards/${first.id}/milestone`, payload: {
      milestone_id: milestone.id,
    } })
    await server.inject({ method: 'PATCH', url: `/api/v1/cards/${second.id}/milestone`, payload: {
      milestone_id: milestone.id,
    } })
    await new Promise((resolve) => setImmediate(resolve))

    expect(outbox.pending().map((item: any) => item.payload._local_card_id).sort()).toEqual([
      first.id, second.id,
    ].sort())
    expect(db.prepare(`SELECT local_card_id, outbound_idempotency_key
      FROM org_sync_card_mappings WHERE org_id=? ORDER BY local_card_id`).all(credential.orgId))
      .toEqual([
        { local_card_id: first.id, outbound_idempotency_key: outbox.pending()[0].idempotencyKey },
        { local_card_id: second.id, outbound_idempotency_key: outbox.pending()[1].idempotencyKey },
      ])

    await handle?.stop()
    await server.close()
    db.close()
  })
})
