import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Outbox, OutboxFullError } from '../src/org-sync/outbox.js'

const homes: string[] = []
const temporaryHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-outbox-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

describe('Outbox', () => {
  it('persists queued ops and their enqueue-time idempotency keys across reloads', () => {
    const home = temporaryHome()
    const first = new Outbox(home)
    const id = first.enqueue('card.create', { title: 'Offline card' })
    const queued = first.pending()[0]

    expect(queued.id).toBe(id)
    expect(queued.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.pending()[0].idempotencyKey).toBe(queued.idempotencyKey)

    const reloaded = new Outbox(home)
    expect(reloaded.pending()).toEqual([queued])
    expect(reloaded.pending()[0].idempotencyKey).toBe(queued.idempotencyKey)
  })

  it('preserves FIFO order and removes only the sent op', () => {
    const home = temporaryHome()
    const outbox = new Outbox(home)
    const first = outbox.enqueue('card.create', { n: 1 })
    const second = outbox.enqueue('card.move', { n: 2 })
    const third = outbox.enqueue('mail.send', { n: 3 })

    expect(outbox.pending().map((item) => item.id)).toEqual([first, second, third])
    outbox.markSent(second)
    expect(outbox.pending().map((item) => item.id)).toEqual([first, third])
    expect(new Outbox(home).pending().map((item) => item.id)).toEqual([first, third])
  })

  it('rejects the new write when 500 ops are pending without dropping old work', () => {
    const home = temporaryHome()
    const outbox = new Outbox(home)
    for (let index = 0; index < 500; index += 1) outbox.enqueue('card.create', { index })
    const before = outbox.pending()

    expect(() => outbox.enqueue('card.create', { index: 500 })).toThrow(OutboxFullError)
    expect(() => outbox.enqueue('card.create', { index: 500 })).toThrow('500')
    expect(outbox.size()).toBe(500)
    expect(outbox.pending()).toEqual(before)
    expect(new Outbox(home).pending()).toEqual(before)
  })

  it('uses owner-only atomic storage and leaves no temporary file behind', () => {
    const home = temporaryHome()
    const outbox = new Outbox(home)
    outbox.enqueue('agent.register', { name: 'alice' })

    expect(fs.statSync(path.join(home, 'outbox.json')).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(home).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('marks terminal failures as removed so they cannot retry forever', () => {
    const home = temporaryHome()
    const outbox = new Outbox(home)
    const id = outbox.enqueue('card.claim', { card_id: 'card_1' })

    outbox.markFailed(id, 'already claimed')

    expect(outbox.size()).toBe(0)
    expect(new Outbox(home).size()).toBe(0)
  })
})
