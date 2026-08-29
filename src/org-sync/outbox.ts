import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from '../daemon.js'

export const OUTBOX_LIMIT = 500

export interface QueuedOp {
  id: string
  op: string
  payload: unknown
  idempotencyKey: string
  enqueuedAt: string
}

interface FailedOp extends QueuedOp {
  failureReason: string
  failedAt: string
}

interface StoredOutbox {
  version: 1
  pending: QueuedOp[]
  failed: FailedOp[]
}

export class OutboxFullError extends Error {
  constructor() {
    super(`organization sync outbox is full (${OUTBOX_LIMIT} pending operations); the new write was not queued`)
    this.name = 'OutboxFullError'
  }
}

export class OutboxCorruptError extends Error {
  constructor(options?: ErrorOptions) {
    super('organization sync outbox is corrupt; refusing to discard queued operations', options)
    this.name = 'OutboxCorruptError'
  }
}

export class Outbox {
  readonly #path: string
  #pending: QueuedOp[]
  #failed: FailedOp[]

  constructor(home = dataDir()) {
    this.#path = path.join(home, 'outbox.json')
    const stored = this.#load()
    this.#pending = stored.pending
    this.#failed = stored.failed
  }

  enqueue(op: string, payload: unknown): string {
    if (this.#pending.length >= OUTBOX_LIMIT) throw new OutboxFullError()
    if (!op.trim()) throw new Error('queued operation name must not be empty')
    const item: QueuedOp = {
      id: randomUUID(),
      op,
      payload: jsonClone(payload),
      idempotencyKey: randomUUID(),
      enqueuedAt: new Date().toISOString(),
    }
    const pending = [...this.#pending, item]
    this.#persist(pending, this.#failed)
    this.#pending = pending
    return item.id
  }

  pending(): QueuedOp[] {
    return jsonClone(this.#pending)
  }

  markSent(id: string): void {
    const pending = this.#pending.filter((item) => item.id !== id)
    if (pending.length === this.#pending.length) return
    this.#persist(pending, this.#failed)
    this.#pending = pending
  }

  markFailed(id: string, reason: string): void {
    const item = this.#pending.find((candidate) => candidate.id === id)
    if (!item) return
    const pending = this.#pending.filter((candidate) => candidate.id !== id)
    const failed = [...this.#failed, {
      ...item,
      failureReason: redactDeviceToken(reason).slice(0, 500),
      failedAt: new Date().toISOString(),
    }].slice(-OUTBOX_LIMIT)
    this.#persist(pending, failed)
    this.#pending = pending
    this.#failed = failed
  }

  size(): number {
    return this.#pending.length
  }

  #load(): StoredOutbox {
    let raw: string
    try { raw = fs.readFileSync(this.#path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, pending: [], failed: [] }
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isStoredOutbox(parsed)) throw new Error('invalid outbox schema')
      if (parsed.pending.length > OUTBOX_LIMIT) throw new Error('outbox exceeds its bound')
      return jsonClone(parsed)
    } catch (error) {
      throw new OutboxCorruptError({ cause: error })
    }
  }

  #persist(pending: QueuedOp[], failed: FailedOp[]): void {
    const directory = path.dirname(this.#path)
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(directory, `.outbox.json.${process.pid}.${randomUUID()}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(descriptor, `${JSON.stringify({ version: 1, pending, failed }, null, 2)}\n`, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      fs.renameSync(temporary, this.#path)
      fs.chmodSync(this.#path, 0o600)
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor) } catch { /* retain the original failure */ }
      }
      try { fs.rmSync(temporary, { force: true }) } catch { /* retain the original failure */ }
      throw error
    }
  }
}

const isQueuedOp = (value: unknown): value is QueuedOp => {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<QueuedOp>
  return typeof item.id === 'string' && item.id.length > 0
    && typeof item.op === 'string' && item.op.length > 0
    && typeof item.idempotencyKey === 'string' && item.idempotencyKey.length > 0
    && typeof item.enqueuedAt === 'string'
    && 'payload' in item
}

const isFailedOp = (value: unknown): value is FailedOp =>
  isQueuedOp(value)
  && typeof (value as FailedOp).failureReason === 'string'
  && typeof (value as FailedOp).failedAt === 'string'

const isStoredOutbox = (value: unknown): value is StoredOutbox => {
  if (!value || typeof value !== 'object') return false
  const stored = value as Partial<StoredOutbox>
  return stored.version === 1
    && Array.isArray(stored.pending) && stored.pending.every(isQueuedOp)
    && Array.isArray(stored.failed) && stored.failed.every(isFailedOp)
}

const jsonClone = <T>(value: T): T => {
  try { return JSON.parse(JSON.stringify(value)) as T } catch {
    throw new Error('queued operation payload must be JSON-serializable')
  }
}

const redactDeviceToken = (value: string): string =>
  value.replace(/orchestra_device_v1\.[^\s"']+/g, '[redacted device token]')
