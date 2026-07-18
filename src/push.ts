import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import webpush from 'web-push'
import type { FastifyInstance } from 'fastify'

// mirrors token.ts: no daemon import — push must stay import-cycle-free
const home = () => process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
const port = () => Number(process.env.ORCHESTRA_PORT ?? 4750)
const vapidPath = () => path.join(home(), 'vapid.json')
const remotePath = () => path.join(home(), 'remote.json')

export interface VapidKeys { publicKey: string; privateKey: string }

// first run mints the keypair; reusing it keeps existing phone subscriptions valid
export function ensureVapidKeys(): VapidKeys {
  try {
    const k = JSON.parse(fs.readFileSync(vapidPath(), 'utf8'))
    if (k.publicKey && k.privateKey) return k
  } catch { /* mint below */ }
  const k = webpush.generateVAPIDKeys()
  fs.mkdirSync(home(), { recursive: true })
  fs.writeFileSync(vapidPath(), JSON.stringify(k) + '\n', { mode: 0o600 })
  return k
}

// the tunnel (card #17) writes its public URL here; without it links only work locally
export function publicBase(): string {
  try {
    const r = JSON.parse(fs.readFileSync(remotePath(), 'utf8'))
    if (typeof r.url === 'string' && r.url) return r.url.replace(/\/$/, '')
  } catch { /* no tunnel */ }
  return `http://localhost:${port()}`
}

export interface PushPayload { title: string; body: string; url: string; tag?: string }
interface SubRow { id: number; endpoint: string; p256dh: string; auth: string; failures: number }

export interface PushOptions {
  // injectable transports so tests never hit real push services
  sendWebPush?: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<unknown>
  sendNtfy?: (topic: string, payload: PushPayload) => Promise<unknown>
  now?: () => number
  cooldownMs?: number
  globalPerMinute?: number
}

const NOTIFY_COLUMNS: Record<string, string> = {
  review: 'is ready for review',
  blocked: 'is blocked',
  done: 'is done',
}
const MAX_FAILURES = 5

export function registerPush(server: FastifyInstance, opts: PushOptions = {}) {
  const db = server.db
  // push owns its schema — keeps db.ts free of cross-card merge traffic
  db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS push_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `)
  const keys = ensureVapidKeys()
  const now = opts.now ?? Date.now
  const cooldownMs = opts.cooldownMs ?? 30_000
  const globalPerMinute = opts.globalPerMinute ?? 12

  const sendWebPush = opts.sendWebPush ?? ((sub, payload) =>
    webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
      { vapidDetails: { subject: 'mailto:orchestra@localhost', publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600 },
    ))
  const sendNtfy = opts.sendNtfy ?? ((topic, p) =>
    fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { title: p.title, click: publicBase() + p.url, tags: 'clipboard' },
      body: p.body,
    }))

  const getSetting = (key: string): string | undefined =>
    (db.prepare(`SELECT value FROM push_settings WHERE key=?`).get(key) as any)?.value
  const setSetting = (key: string, value: string | null) => value === null
    ? db.prepare(`DELETE FROM push_settings WHERE key=?`).run(key)
    : db.prepare(`INSERT INTO push_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value)

  // ── rate limiting: collapse per-card bursts, cap the global stream ──────
  const lastSent = new Map<string, number>()
  let windowStart = 0
  let windowCount = 0
  const allowed = (key: string): boolean => {
    const t = now()
    const prev = lastSent.get(key)
    if (prev !== undefined && t - prev < cooldownMs) return false
    if (t - windowStart >= 60_000) { windowStart = t; windowCount = 0 }
    if (windowCount >= globalPerMinute) return false
    lastSent.set(key, t)
    windowCount++
    // the map only ever holds keys inside the cooldown horizon
    if (lastSent.size > 500) for (const [k, v] of lastSent) if (t - v >= cooldownMs) lastSent.delete(k)
    return true
  }

  const deliver = async (payload: PushPayload) => {
    const subs = db.prepare(`SELECT * FROM push_subscriptions`).all() as SubRow[]
    const body = JSON.stringify(payload)
    await Promise.all(subs.map(async (s) => {
      try {
        await sendWebPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body)
        if (s.failures) db.prepare(`UPDATE push_subscriptions SET failures=0 WHERE id=?`).run(s.id)
      } catch (e: any) {
        const status = e?.statusCode ?? e?.status
        // 404/410 means the phone unsubscribed or the endpoint expired — forget it
        if (status === 404 || status === 410 || s.failures + 1 >= MAX_FAILURES)
          db.prepare(`DELETE FROM push_subscriptions WHERE id=?`).run(s.id)
        else db.prepare(`UPDATE push_subscriptions SET failures=failures+1 WHERE id=?`).run(s.id)
      }
    }))
    const topic = getSetting('ntfy_topic')
    if (topic) await sendNtfy(topic, payload).catch(() => { /* ntfy is best-effort */ })
  }

  const notify = (key: string, payload: PushPayload) => {
    if (!allowed(key)) return
    void deliver(payload)
  }

  // ── triggers off the existing bus ───────────────────────────────────────
  // the 'card' event carries only the new row, so remember columns to spot transitions
  const columns = new Map<number, string>()
  for (const c of db.prepare(`SELECT id, column_name FROM cards`).all() as any[]) columns.set(c.id, c.column_name)

  const movedByAgent = (cardId: number): string | undefined => {
    // the latest move/update decides authorship — a human drag (agent_id null) must not
    // inherit the name from an older agent event
    const e = db.prepare(`
      SELECT a.name FROM card_events e LEFT JOIN agents a ON a.id = e.agent_id
      WHERE e.card_id=? AND e.type IN ('moved','updated','agent_exit') ORDER BY e.id DESC LIMIT 1`).get(cardId) as any
    return e?.name ?? undefined
  }

  const onCard = (card: any) => {
    if (card?.deleted) { columns.delete(card.deleted); return }
    if (!card?.id || !card.column_name) return
    const prev = columns.get(card.id)
    columns.set(card.id, card.column_name)
    const phrase = NOTIFY_COLUMNS[card.column_name]
    if (!phrase || prev === card.column_name || prev === undefined) return
    const agent = movedByAgent(card.id) // human drags on the board shouldn't ping the human
    if (!agent) return
    notify(`card:${card.id}`, {
      title: `${card.title} ${phrase}`,
      body: `${agent} moved #${card.id} to ${card.column_name}`,
      url: `/?board=${card.board_id}&card=${card.id}`,
      tag: `card-${card.id}`,
    })
  }

  // review gates (card #19) emit richer context than the bare column change
  const onReview = (data: any) => {
    if (data?.status !== 'awaiting_approval' || !data.card_id) return
    // the gate fires for any entry into review — including the human's own drag,
    // which shouldn't ping the human's phone
    if (!movedByAgent(data.card_id)) return
    notify(`card:${data.card_id}`, {
      title: `${data.card_title ?? `Card #${data.card_id}`} awaits your approval`,
      body: data.summary ?? `${data.agent_name ?? 'an agent'} finished this step`,
      url: `/?card=${data.card_id}`,
      tag: `card-${data.card_id}`,
    })
  }

  const onMessage = (msg: any) => {
    if (!msg?.id || msg.deleted) return
    // a question for the human: sent by an agent, addressed to no agent, not a reply
    if (!msg.from_agent_id || msg.to_agent_id || msg.reply_to) return
    const from = (db.prepare(`SELECT name FROM agents WHERE id=?`).get(msg.from_agent_id) as any)?.name ?? 'an agent'
    notify(`msg:${msg.id}`, {
      title: `${from} asked you a question`,
      body: String(msg.body ?? '').slice(0, 160),
      url: msg.card_id ? `/?board=${msg.board_id}&card=${msg.card_id}` : `/?board=${msg.board_id}`,
      tag: `msg-${msg.id}`,
    })
  }

  server.bus.on('event', (e: { type: string; data: any }) => {
    if (e.type === 'card') onCard(e.data)
    else if (e.type === 'review') onReview(e.data)
    else if (e.type === 'message') onMessage(e.data)
  })

  // ── routes ──────────────────────────────────────────────────────────────
  server.get('/api/v1/push/vapid-key', () => ({ key: keys.publicKey }))

  server.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>(
    '/api/v1/push/subscribe', (req, reply) => {
      const { endpoint, keys: k } = req.body ?? ({} as any)
      if (!endpoint || !k?.p256dh || !k?.auth) return reply.code(400).send({ error: 'endpoint and keys required' })
      db.prepare(`
        INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, failures=0`)
        .run(endpoint, k.p256dh, k.auth)
      return { ok: true }
    })

  server.post<{ Body: { endpoint: string } }>('/api/v1/push/unsubscribe', (req, reply) => {
    if (!req.body?.endpoint) return reply.code(400).send({ error: 'endpoint required' })
    const { changes } = db.prepare(`DELETE FROM push_subscriptions WHERE endpoint=?`).run(req.body.endpoint)
    return { ok: true, removed: changes }
  })

  server.get('/api/v1/push/status', () => ({
    subscriptions: (db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).get() as any).n,
    ntfy_topic: getSetting('ntfy_topic') ?? null,
    public_base: publicBase(),
  }))

  server.post<{ Body: { topic: string | null } }>('/api/v1/push/ntfy', (req) => {
    const topic = req.body?.topic?.trim() || null
    setSetting('ntfy_topic', topic)
    return { ok: true, ntfy_topic: topic }
  })

  server.post('/api/v1/push/test', async () => {
    await deliver({ title: 'Orchestra test notification', body: 'Push is working on this device.', url: '/' })
    return { ok: true }
  })
}
