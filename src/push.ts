import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import webpush from 'web-push'
import type { FastifyInstance } from 'fastify'
import {
  ProtectedCredentialVault,
  createPlatformCredentialStore,
  type PlatformCredentialStore,
  type ProtectedCredentialReference,
} from './operations/credentials.js'

// mirrors token.ts: no daemon import — push must stay import-cycle-free
const home = () => process.env.ORCHESTRA_HOME ?? path.join(os.homedir(), '.orchestra')
const port = () => Number(process.env.ORCHESTRA_PORT ?? 4750)
const legacyVapidPath = () => path.join(home(), 'vapid.json')
const vapidReferencePath = () => path.join(home(), 'vapid-reference.json')
const remotePath = () => path.join(home(), 'remote.json')

export interface VapidKeys { publicKey: string; privateKey: string }

interface VapidReferenceDocument {
  schema_version: 1
  public_key: string
  private_key: ProtectedCredentialReference
  retired_private_keys?: ProtectedCredentialReference[]
}

const validVapidKey = (value: unknown): value is string => (
  typeof value === 'string' && /^[A-Za-z0-9_-]{40,256}$/u.test(value)
)

const readVapidReference = (): VapidReferenceDocument | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(vapidReferencePath(), 'utf8')) as VapidReferenceDocument
    if (parsed.schema_version !== 1 || !validVapidKey(parsed.public_key)
      || !parsed.private_key || typeof parsed.private_key !== 'object') {
      throw new Error('VAPID reference document is invalid')
    }
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const persistVapidReference = (document: VapidReferenceDocument): void => {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 })
  const target = vapidReferencePath()
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  const serialized = `${JSON.stringify(document)}\n`
  try {
    fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, target)
    fs.chmodSync(target, 0o600)
    if (fs.readFileSync(target, 'utf8') !== serialized) {
      throw new Error('VAPID reference document was overwritten during persistence')
    }
  } finally {
    try { fs.unlinkSync(temporary) } catch { /* renamed or absent */ }
  }
}

const readLegacyVapidKeys = (): VapidKeys | null => {
  try {
    const legacy = fs.lstatSync(legacyVapidPath())
    if (!legacy.isFile() || legacy.isSymbolicLink()) throw new Error('legacy VAPID path is unsafe')
    const parsed = JSON.parse(fs.readFileSync(legacyVapidPath(), 'utf8')) as Partial<VapidKeys>
    if (!validVapidKey(parsed.publicKey) || !validVapidKey(parsed.privateKey)) {
      throw new Error('legacy VAPID key material is invalid')
    }
    return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Loads VAPID private material only from a platform credential facility. The application file
 * contains an opaque expiring reference and public key. A legacy plaintext file is migrated only
 * after secure persistence succeeds, then removed and verified absent.
 */
export async function loadSecureVapidKeys(input: {
  store?: PlatformCredentialStore
  clock?: () => Date
} = {}): Promise<VapidKeys> {
  const vault = new ProtectedCredentialVault(
    input.store ?? createPlatformCredentialStore(),
    'orchestra.vapid',
    input.clock,
  )
  const existing = readVapidReference()
  if (existing) {
    const now = (input.clock ?? (() => new Date()))().getTime()
    const expires = Date.parse(existing.private_key.expires_at)
    if (!Number.isFinite(now) || !Number.isFinite(expires)) throw new Error('VAPID credential clock is invalid')
    if (expires <= now) throw new Error('secure VAPID credential reference expired')
    let material: Uint8Array | undefined
    let currentKeys: VapidKeys | undefined
    material = await vault.resolve(existing.private_key)
    if (material) {
      try {
        const privateKey = Buffer.from(material).toString('utf8')
        if (!validVapidKey(privateKey)) throw new Error('VAPID private key material is invalid')
        currentKeys = { publicKey: existing.public_key, privateKey }
        const legacy = readLegacyVapidKeys()
        if (legacy) {
          if (legacy.publicKey !== existing.public_key || legacy.privateKey !== privateKey) {
            throw new Error('legacy VAPID plaintext does not match the secure reference')
          }
          fs.unlinkSync(legacyVapidPath())
          if (fs.existsSync(legacyVapidPath())) throw new Error('legacy VAPID plaintext removal failed')
        }
        if (expires - now > 30 * 24 * 60 * 60_000) {
          if (existing.retired_private_keys?.length) {
            for (const retired of existing.retired_private_keys) await vault.revoke(retired)
            persistVapidReference({
              schema_version: 1,
              public_key: existing.public_key,
              private_key: existing.private_key,
            })
          }
          return { publicKey: existing.public_key, privateKey }
        }
      } finally {
        material.fill(0)
      }
    }
    if (!currentKeys) throw new Error('secure VAPID credential is unavailable for rotation')
    const replacement = currentKeys
    const replacementBytes = Buffer.from(replacement.privateKey, 'utf8')
    let replacementReference: ProtectedCredentialReference
    try {
      replacementReference = await vault.protect(replacementBytes, 365 * 24 * 60 * 60_000)
    } finally {
      replacementBytes.fill(0)
    }
    const retired = [existing.private_key, ...(existing.retired_private_keys ?? [])]
    try {
      persistVapidReference({
        schema_version: 1,
        public_key: replacement.publicKey,
        private_key: replacementReference,
        retired_private_keys: retired,
      })
    } catch (error) {
      await vault.revoke(replacementReference).catch(() => undefined)
      throw error
    }
    if (fs.existsSync(legacyVapidPath())) {
      fs.unlinkSync(legacyVapidPath())
      if (fs.existsSync(legacyVapidPath())) throw new Error('legacy VAPID plaintext removal failed')
    }
    for (const reference of retired) await vault.revoke(reference)
    persistVapidReference({
      schema_version: 1,
      public_key: replacement.publicKey,
      private_key: replacementReference,
    })
    return replacement
  }

  const legacy = readLegacyVapidKeys()
  const generated = legacy ?? webpush.generateVAPIDKeys()
  const material = Buffer.from(generated.privateKey, 'utf8')
  let reference: ProtectedCredentialReference
  try {
    reference = await vault.protect(material, 365 * 24 * 60 * 60_000)
  } finally {
    material.fill(0)
  }
  try {
    persistVapidReference({
      schema_version: 1,
      public_key: generated.publicKey,
      private_key: reference,
    })
  } catch (error) {
    await vault.revoke(reference).catch(() => undefined)
    throw error
  }
  if (legacy) {
    fs.unlinkSync(legacyVapidPath())
    if (fs.existsSync(legacyVapidPath())) throw new Error('legacy VAPID plaintext removal failed')
  }
  return generated
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
  vapidKeys?: VapidKeys
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
  const keys = opts.vapidKeys
  const now = opts.now ?? Date.now
  const cooldownMs = opts.cooldownMs ?? 30_000
  const globalPerMinute = opts.globalPerMinute ?? 12

  const sendWebPush = opts.sendWebPush ?? ((sub, payload) => {
    if (!keys) throw new Error('secure VAPID credential is unavailable')
    return webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      payload,
      { vapidDetails: { subject: 'mailto:orchestra@localhost', publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 3600 },
    )
  })
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
    if (msg.kind !== 'ask' || !msg.from_agent_id || msg.to_agent_id || msg.reply_to) return
    const from = (db.prepare(`SELECT name FROM agents WHERE id=?`).get(msg.from_agent_id) as any)?.name ?? 'an agent'
    notify(`msg:${msg.id}`, {
      title: `${from} asked you a question`,
      body: String(msg.body ?? '').slice(0, 160),
      url: msg.card_id ? `/?board=${msg.board_id}&card=${msg.card_id}` : `/?board=${msg.board_id}`,
      tag: `msg-${msg.id}`,
    })
  }

  // the autowake timer resumed limit-paused agents (#62) — tell the phone the fleet is moving again
  const onAutowake = (data: any) => {
    const woke = data?.woke ?? 0
    const queued = data?.queued ?? 0
    if (woke + queued === 0) return
    notify('autowake', {
      title: 'Claude usage window reset',
      body: `${woke} agent${woke === 1 ? '' : 's'} resumed${queued ? `, ${queued} queued` : ''}`,
      url: '/',
      tag: 'autowake',
    })
  }

  server.bus.on('event', (e: { type: string; data: any }) => {
    if (e.type === 'card') onCard(e.data)
    else if (e.type === 'review') onReview(e.data)
    else if (e.type === 'message') onMessage(e.data)
    else if (e.type === 'autowake') onAutowake(e.data)
  })

  // ── routes ──────────────────────────────────────────────────────────────
  server.get('/api/v1/push/vapid-key', (_request, reply) => keys
    ? { key: keys.publicKey }
    : reply.code(503).send({ error: 'secure push credentials are unavailable' }))

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
