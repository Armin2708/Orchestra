import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  startDaemonOrgSync,
  type DaemonOrgSyncLoop,
  type LocalSyncAgent,
} from '../src/org-sync/daemon-integration.js'
import type { OrgCredential } from '../src/org-sync/credentials.js'
import { Outbox } from '../src/org-sync/outbox.js'

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
    expect(output.join('\n')).toContain('org-sync on')
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
})
