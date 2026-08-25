import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { loadSecureVapidKeys, publicBase, registerPush, PushPayload } from '../src/push.js'
import type { PlatformCredentialStore } from '../src/operations/credentials.js'

type Sent = { endpoint: string; payload: PushPayload }

function harness(opts: { failWith?: Record<string, number>; now?: () => number } = {}) {
  const db = openDb(':memory:')
  const server = buildServer(db)
  const sent: Sent[] = []
  const ntfy: { topic: string; payload: PushPayload }[] = []
  registerPush(server, {
    vapidKeys: { publicKey: 'A'.repeat(64), privateKey: 'B'.repeat(64) },
    now: opts.now,
    sendWebPush: async (sub, payload) => {
      const status = opts.failWith?.[sub.endpoint]
      if (status) { const e: any = new Error(`push ${status}`); e.statusCode = status; throw e }
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) })
    },
    sendNtfy: async (topic, payload) => { ntfy.push({ topic, payload }) },
  })
  return { db, server, sent, ntfy }
}

const flush = () => new Promise((r) => setImmediate(r))

async function seedBoard(server: any) {
  const b = (await server.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/tmp/p' , create: true } })).json()
  const a = (await server.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'test-fox' } })).json()
  const { card } = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: b.id, title: 'Ship the thing', agent: 'test-fox', column: 'in_progress' } })).json()
  return { b, a, card }
}

const subscribeDevice = (server: any, endpoint = 'https://push.example/dev1') =>
  server.inject({ method: 'POST', url: '/api/v1/push/subscribe', payload: { endpoint, keys: { p256dh: 'pk', auth: 'ak' } } })

beforeEach(() => { process.env.ORCHESTRA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-push-')) })
afterEach(() => { delete process.env.ORCHESTRA_HOME; vi.restoreAllMocks() })

class MemoryCredentialStore implements PlatformCredentialStore {
  readonly facility = 'memory-test'
  readonly values = new Map<string, Uint8Array>()
  async isAvailable() { return true }
  async put(reference: string, secret: Uint8Array) { this.values.set(reference, Uint8Array.from(secret)) }
  async get(reference: string) { return this.values.get(reference) ?? null }
  async replace(current: string, replacement: string, secret: Uint8Array) {
    if (!this.values.has(current)) throw new Error('missing')
    this.values.delete(current)
    this.values.set(replacement, Uint8Array.from(secret))
  }
  async delete(reference: string) { this.values.delete(reference) }
}

it('stores only an opaque VAPID reference on disk and reuses secure key material', async () => {
  const store = new MemoryCredentialStore()
  const k = await loadSecureVapidKeys({ store })
  expect(k.publicKey).toBeTruthy()
  const referencePath = path.join(process.env.ORCHESTRA_HOME!, 'vapid-reference.json')
  expect(fs.statSync(referencePath).mode & 0o777).toBe(0o600)
  const document = fs.readFileSync(referencePath, 'utf8')
  expect(document).not.toContain(k.privateKey)
  expect(document).toContain('credential_ref')
  expect(await loadSecureVapidKeys({ store })).toEqual(k)
  expect(fs.existsSync(path.join(process.env.ORCHESTRA_HOME!, 'vapid.json'))).toBe(false)
})

it('recovers a partial legacy migration by refusing push until plaintext cleanup succeeds', async () => {
  const store = new MemoryCredentialStore()
  const keys = await loadSecureVapidKeys({ store })
  const legacyPath = path.join(process.env.ORCHESTRA_HOME!, 'vapid.json')
  fs.writeFileSync(legacyPath, `${JSON.stringify(keys)}\n`, { mode: 0o600 })
  const unlink = fs.unlinkSync.bind(fs)
  const blocked = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
    if (String(target) === legacyPath) throw Object.assign(new Error('forced unlink failure'), { code: 'EACCES' })
    return unlink(target)
  })
  await expect(loadSecureVapidKeys({ store })).rejects.toThrow('forced unlink failure')
  expect(fs.existsSync(legacyPath)).toBe(true)
  blocked.mockRestore()
  expect(await loadSecureVapidKeys({ store })).toEqual(keys)
  expect(fs.existsSync(legacyPath)).toBe(false)
})

it('leaves the only legacy VAPID key intact when secure persistence fails', async () => {
  const legacyPath = path.join(process.env.ORCHESTRA_HOME!, 'vapid.json')
  const legacy = { publicKey: 'A'.repeat(64), privateKey: 'B'.repeat(64) }
  const serialized = `${JSON.stringify(legacy)}\n`
  fs.writeFileSync(legacyPath, serialized, { mode: 0o600 })
  const store = new MemoryCredentialStore()
  store.put = async () => { throw new Error('forced secure store failure') }
  await expect(loadSecureVapidKeys({ store })).rejects.toThrow('forced secure store failure')
  expect(fs.readFileSync(legacyPath, 'utf8')).toBe(serialized)
  expect(fs.existsSync(path.join(process.env.ORCHESTRA_HOME!, 'vapid-reference.json'))).toBe(false)
})

it('rotates an expiring secure VAPID reference and retires the old credential', async () => {
  const store = new MemoryCredentialStore()
  let now = new Date('2026-01-01T00:00:00.000Z')
  const first = await loadSecureVapidKeys({ store, clock: () => now })
  const initialReference = JSON.parse(fs.readFileSync(
    path.join(process.env.ORCHESTRA_HOME!, 'vapid-reference.json'), 'utf8',
  )).private_key.credential_ref as string
  now = new Date('2026-12-05T00:00:00.000Z')
  const rotated = await loadSecureVapidKeys({ store, clock: () => now })
  expect(rotated).toEqual(first)
  expect(store.values.has(initialReference)).toBe(false)
  const nextReference = JSON.parse(fs.readFileSync(
    path.join(process.env.ORCHESTRA_HOME!, 'vapid-reference.json'), 'utf8',
  )).private_key.credential_ref as string
  expect(nextReference).not.toBe(initialReference)
  const persisted = fs.readFileSync(path.join(process.env.ORCHESTRA_HOME!, 'vapid-reference.json'), 'utf8')
  expect(persisted).not.toContain(first.privateKey)
  expect(persisted).not.toContain('retired_private_keys')
})

it('serves the public key and stores/removes subscriptions', async () => {
  const { server } = harness()
  await server.ready()
  const key = (await server.inject({ method: 'GET', url: '/api/v1/push/vapid-key' })).json().key
  expect(key).toBeTruthy()
  expect((await subscribeDevice(server)).statusCode).toBe(200)
  expect((await server.inject({ method: 'GET', url: '/api/v1/push/status' })).json().subscriptions).toBe(1)
  await subscribeDevice(server) // idempotent upsert
  expect((await server.inject({ method: 'GET', url: '/api/v1/push/status' })).json().subscriptions).toBe(1)
  const un = await server.inject({ method: 'POST', url: '/api/v1/push/unsubscribe', payload: { endpoint: 'https://push.example/dev1' } })
  expect(un.json().removed).toBe(1)
  expect((await server.inject({ method: 'GET', url: '/api/v1/push/status' })).json().subscriptions).toBe(0)
})

it('rejects malformed subscriptions', async () => {
  const { server } = harness()
  await server.ready()
  const res = await server.inject({ method: 'POST', url: '/api/v1/push/subscribe', payload: { endpoint: 'x', keys: {} } })
  expect(res.statusCode).toBe(400)
})

it('pushes when an agent moves a card to review, with a deep link', async () => {
  const { server, sent } = harness()
  await server.ready()
  const { b, card } = await seedBoard(server)
  await subscribeDevice(server)
  await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/move`, payload: { column: 'review', agent: 'test-fox' } })
  await flush()
  expect(sent).toHaveLength(1)
  expect(sent[0].payload.title).toContain('Ship the thing')
  expect(sent[0].payload.url).toBe(`/?board=${b.id}&card=${card.id}`)
})

it('stays silent when a human (no agent) moves the card', async () => {
  const { server, sent } = harness()
  await server.ready()
  const { card } = await seedBoard(server)
  await subscribeDevice(server)
  await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/move`, payload: { column: 'review' } })
  await flush()
  expect(sent).toHaveLength(0)
})

it('stays silent on moves to non-terminal columns', async () => {
  const { server, sent } = harness()
  await server.ready()
  const { card } = await seedBoard(server)
  await subscribeDevice(server)
  await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/move`, payload: { column: 'backlog', agent: 'test-fox' } })
  await flush()
  expect(sent).toHaveLength(0)
})

it('pushes a question addressed to the user but not replies or agent-to-agent mail', async () => {
  const { server, sent } = harness()
  await server.ready()
  const { b } = await seedBoard(server)
  await subscribeDevice(server)
  const q = (await server.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, from: 'test-fox', kind: 'ask', body: 'Which DB should I use?' } })).json()
  await server.inject({ method: 'POST', url: '/api/v1/agents/register', payload: { board_id: b.id, name: 'other-owl' } })
  await server.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, from: 'test-fox', to: 'other-owl', body: 'agent to agent' } })
  await server.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, body: 'human broadcast' } })
  await server.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, from: 'test-fox', kind: 'announce', body: 'agent board note' } })
  await server.inject({ method: 'POST', url: '/api/v1/messages', payload: { board_id: b.id, from: 'other-owl', body: 'answering', reply_to: q.id } })
  await flush()
  expect(sent).toHaveLength(1)
  expect(sent[0].payload.title).toBe('test-fox asked you a question')
  expect(sent[0].payload.body).toContain('Which DB')
})

it('pushes on review-gate events for agent-parked cards, once per burst', async () => {
  let t = 0
  const { server, sent } = harness({ now: () => t })
  await server.ready()
  const { card } = await seedBoard(server)
  await subscribeDevice(server)
  // an agent parking the card emits 'card' + 'review' back-to-back — one push, not two
  await server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/move`, payload: { column: 'review', agent: 'test-fox' } })
  await flush()
  expect(sent).toHaveLength(1)
  // a later gate event (e.g. conductor enrichment after agent exit) carries rich context
  t += 31_000
  server.bus.emit('event', { board_id: card.board_id, type: 'review', data: { card_id: card.id, card_title: 'Gate step', agent_name: 'test-fox', status: 'awaiting_approval', summary: 'built the thing' } })
  server.bus.emit('event', { board_id: card.board_id, type: 'review', data: { card_id: card.id, status: 'approved' } })
  await flush()
  expect(sent).toHaveLength(2)
  expect(sent[1].payload.title).toContain('Gate step')
  expect(sent[1].payload.url).toBe(`/?card=${card.id}`)
})

it('collapses bursts per card and enforces the global per-minute cap', async () => {
  let t = 0
  const { server, sent } = harness({ now: () => t })
  await server.ready()
  const { b, card } = await seedBoard(server)
  await subscribeDevice(server)
  const move = (column: string) =>
    server.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/move`, payload: { column, agent: 'test-fox' } })
  await move('review'); await move('blocked'); await move('done') // one card thrashing
  await flush()
  expect(sent).toHaveLength(1) // cooldown collapsed the burst

  // distinct cards spread over time still hit the global cap
  t += 31_000
  for (let i = 0; i < 20; i++) {
    const { card: c } = (await server.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: b.id, title: `c${i}`, agent: 'test-fox', column: 'in_progress' } })).json()
    await server.inject({ method: 'POST', url: `/api/v1/cards/${c.id}/move`, payload: { column: 'done', agent: 'test-fox' } })
  }
  await flush()
  expect(sent.length).toBeLessThanOrEqual(1 + 12) // 12/min global ceiling
  t += 61_000
  await move('review')
  await flush()
  expect(sent.length).toBeGreaterThan(13 - 1) // window reset lets fresh events through
})

it('drops subscriptions on 410 Gone and after repeated failures', async () => {
  const { server, sent } = harness({ failWith: { 'https://push.example/gone': 410, 'https://push.example/flaky': 500 } })
  await server.ready()
  await subscribeDevice(server, 'https://push.example/gone')
  await subscribeDevice(server, 'https://push.example/flaky')
  await subscribeDevice(server, 'https://push.example/ok')
  // /push/test bypasses the rate limiter, so five sends exercise failure accrual
  for (let i = 0; i < 5; i++) await server.inject({ method: 'POST', url: '/api/v1/push/test' })
  await flush()
  const status = (await server.inject({ method: 'GET', url: '/api/v1/push/status' })).json()
  expect(status.subscriptions).toBe(1) // gone dropped instantly, flaky after 5 strikes
  expect(sent.filter((s) => s.endpoint.endsWith('/ok')).length).toBe(5)
})

it('mirrors to ntfy when a topic is set and stops when cleared', async () => {
  const { server, ntfy } = harness()
  await server.ready()
  await server.inject({ method: 'POST', url: '/api/v1/push/ntfy', payload: { topic: 'my-phone' } })
  await server.inject({ method: 'POST', url: '/api/v1/push/test' })
  await flush()
  expect(ntfy).toHaveLength(1)
  expect(ntfy[0].topic).toBe('my-phone')
  await server.inject({ method: 'POST', url: '/api/v1/push/ntfy', payload: { topic: null } })
  await server.inject({ method: 'POST', url: '/api/v1/push/test' })
  await flush()
  expect(ntfy).toHaveLength(1)
})

it('builds deep-link bases from remote.json when the tunnel is up', () => {
  expect(publicBase()).toBe('http://localhost:4750')
  fs.writeFileSync(path.join(process.env.ORCHESTRA_HOME!, 'remote.json'), JSON.stringify({ url: 'https://orchestra.example.dev/' }))
  expect(publicBase()).toBe('https://orchestra.example.dev')
})
