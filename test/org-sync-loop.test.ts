import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HubConflictError, HubRequestError, HubRetryableError, type HubSyncEvent } from '../src/org-sync/hub-client.js'
import { Outbox } from '../src/org-sync/outbox.js'
import { SyncLoop } from '../src/org-sync/sync-loop.js'

const homes: string[] = []
const temporaryHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-sync-loop-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

const event = (seq: number): HubSyncEvent => ({ seq, kind: 'card.created', payload: { id: `card_${seq}` } })

const untilAborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve()
  signal.addEventListener('abort', () => resolve(), { once: true })
})

const waitUntil = async (condition: () => boolean) => {
  await vi.waitFor(() => expect(condition()).toBe(true), { timeout: 2_000, interval: 5 })
}

describe('SyncLoop', () => {
  it('starts from the stored cursor and persists each seq only after apply succeeds', async () => {
    const home = temporaryHome()
    fs.writeFileSync(path.join(home, 'org-cursor.json'), JSON.stringify({ version: 1, seq: 2 }), { mode: 0o600 })
    const observedCursorDuringApply: number[] = []
    const starts: number[] = []
    const client = {
      postOp: vi.fn(),
      streamSince: vi.fn(async (since: number, onEvent: (event: HubSyncEvent) => Promise<void>, signal: AbortSignal) => {
        starts.push(since)
        for (const item of [event(3), event(4)]) await onEvent(item)
        await untilAborted(signal)
      }),
    }
    const loop = new SyncLoop({ client, outbox: new Outbox(home), home, applyEvent: async (item) => {
      observedCursorDuringApply.push(JSON.parse(fs.readFileSync(path.join(home, 'org-cursor.json'), 'utf8')).seq)
      expect(item.seq).toBeGreaterThan(2)
    }, backoff: { baseMs: 1, maxMs: 2, jitter: 0 } })

    loop.start()
    await waitUntil(() => JSON.parse(fs.readFileSync(path.join(home, 'org-cursor.json'), 'utf8')).seq === 4)
    await loop.stop()

    expect(starts).toEqual([2])
    expect(observedCursorDuringApply).toEqual([2, 3])
    expect(loop.state()).toBe('offline')
  })

  it('reconnects from the durable cursor with no gap or duplicate', async () => {
    const home = temporaryHome()
    const starts: number[] = []
    const applied: number[] = []
    let connection = 0
    const client = {
      postOp: vi.fn(),
      streamSince: vi.fn(async (since: number, onEvent: (event: HubSyncEvent) => Promise<void>, signal: AbortSignal) => {
        starts.push(since)
        connection += 1
        if (connection === 1) {
          await onEvent(event(1))
          throw new HubRetryableError('disconnected')
        }
        await onEvent(event(1))
        await onEvent(event(2))
        await untilAborted(signal)
      }),
    }
    const delays: number[] = []
    const loop = new SyncLoop({
      client, outbox: new Outbox(home), home,
      applyEvent: async (item) => { applied.push(item.seq) },
      sleep: async (ms) => { delays.push(ms) },
      backoff: { baseMs: 10, maxMs: 100, jitter: 0 },
    })

    loop.start()
    await waitUntil(() => applied.includes(2))
    await loop.stop()

    expect(starts).toEqual([0, 1])
    expect(applied).toEqual([1, 2])
    expect(delays).toEqual([10])
  })

  it('replays an event when local apply fails before cursor persistence', async () => {
    const home = temporaryHome()
    const starts: number[] = []
    const applied: number[] = []
    let applyAttempts = 0
    const client = {
      postOp: vi.fn(),
      streamSince: vi.fn(async (since: number, onEvent: (event: HubSyncEvent) => Promise<void>, signal: AbortSignal) => {
        starts.push(since)
        await onEvent(event(1))
        await untilAborted(signal)
      }),
    }
    const loop = new SyncLoop({
      client, outbox: new Outbox(home), home,
      applyEvent: async (item) => {
        applyAttempts += 1
        if (applyAttempts === 1) throw new Error('local database temporarily unavailable')
        applied.push(item.seq)
      },
      sleep: async () => undefined,
      onError: () => undefined,
      backoff: { baseMs: 1, maxMs: 2, jitter: 0 },
    })

    loop.start()
    await waitUntil(() => applied.length === 1)
    await loop.stop()

    expect(starts).toEqual([0, 0])
    expect(applyAttempts).toBe(2)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'org-cursor.json'), 'utf8')).seq).toBe(1)
  })

  it('uses capped exponential backoff after repeated disconnects', async () => {
    const home = temporaryHome()
    const delays: number[] = []
    let loop: SyncLoop
    const client = {
      postOp: vi.fn(),
      streamSince: vi.fn(async () => { throw new HubRetryableError('offline') }),
    }
    loop = new SyncLoop({
      client, outbox: new Outbox(home), home, applyEvent: vi.fn(),
      sleep: async (ms) => {
        delays.push(ms)
        if (delays.length === 4) queueMicrotask(() => { void loop.stop() })
      },
      backoff: { baseMs: 10, maxMs: 25, jitter: 0 },
    })

    loop.start()
    await waitUntil(() => delays.length === 4)
    await loop.stop()

    expect(delays).toEqual([10, 20, 25, 25])
  })

  it('flushes queued ops in order with their original idempotency keys', async () => {
    const home = temporaryHome()
    const outbox = new Outbox(home)
    outbox.enqueue('card.create', { n: 1 })
    outbox.enqueue('card.move', { n: 2 })
    const queued = outbox.pending()
    const sent: Array<{ op: string; key: string }> = []
    const client = {
      postOp: vi.fn(async (op: string, _payload: unknown, key: string) => {
        sent.push({ op, key })
        return { result: {}, seq: 0 }
      }),
      streamSince: vi.fn(async (_since: number, _onEvent: unknown, signal: AbortSignal) => untilAborted(signal)),
    }
    const loop = new SyncLoop({ client, outbox, home, applyEvent: vi.fn() })

    loop.start()
    await waitUntil(() => outbox.size() === 0)
    await loop.stop()

    expect(sent).toEqual(queued.map((item) => ({ op: item.op, key: item.idempotencyKey })))
  })

  it('surfaces and removes conflicts while continuing the queue', async () => {
    const home = temporaryHome()
    const outbox = new Outbox(home)
    outbox.enqueue('card.claim', { card_id: 'card_1', agent: 'alice' })
    outbox.enqueue('mail.send', { body: 'still send this' })
    const conflicts: HubConflictError[] = []
    const client = {
      postOp: vi.fn()
        .mockRejectedValueOnce(new HubConflictError('already claimed', { owner_agent: 'bob' }))
        .mockResolvedValueOnce({ result: {}, seq: 2 }),
      streamSince: vi.fn(async (_since: number, _onEvent: unknown, signal: AbortSignal) => untilAborted(signal)),
    }
    const loop = new SyncLoop({
      client, outbox, home, applyEvent: vi.fn(),
      onConflict: (failure) => { conflicts.push(failure) },
    })

    loop.start()
    await waitUntil(() => outbox.size() === 0)
    await loop.stop()

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].current).toEqual({ owner_agent: 'bob' })
    expect(client.postOp).toHaveBeenCalledTimes(2)
  })

  it('does not retry a terminal authorization failure forever', async () => {
    const home = temporaryHome()
    const errors: Error[] = []
    const client = {
      postOp: vi.fn(),
      streamSince: vi.fn(async () => { throw new HubRequestError('token revoked', 403) }),
    }
    const sleep = vi.fn(async () => undefined)
    const loop = new SyncLoop({ client, outbox: new Outbox(home), home, applyEvent: vi.fn(), sleep, onError: (error) => errors.push(error) })

    loop.start()
    await waitUntil(() => errors.length === 1)
    await loop.stop()

    expect(client.streamSince).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
  })
})
