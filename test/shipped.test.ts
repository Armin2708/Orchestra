import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-shipped-'))
const g = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim()
g('init')
g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'merge: ship the widget (#7)')
const fullSha = g('rev-parse', 'HEAD')

afterAll(() => fs.rmSync(repo, { recursive: true, force: true }))

async function boardWithCard() {
  const db = openDb(':memory:')
  const s = buildServer(db); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: repo } })).json()
  const card = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: { board_id: b.id, title: 'Widget' } })).json().card
  return { db, s, b, card }
}

it('resolves a short sha to the full sha + subject and stores a shipped event', async () => {
  const { s, card } = await boardWithCard()
  const r = (await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/shipped`,
    payload: { hash: fullSha.slice(0, 7), by: 'integrator' } })).json()
  expect(r.created).toBe(true)
  const payload = JSON.parse(r.event.payload)
  expect(payload).toEqual({ hash: fullSha, subject: 'merge: ship the widget (#7)', by: 'integrator' })

  const events = (await s.inject({ method: 'GET', url: `/api/v1/cards/${card.id}/events` })).json()
  const shipped = events.filter((e: any) => e.type === 'shipped')
  expect(shipped).toHaveLength(1)
  expect(JSON.parse(shipped[0].payload).hash).toBe(fullSha)
})

it('is idempotent per card+sha, but allows multi-commit ships', async () => {
  const { s, card } = await boardWithCard()
  const first = (await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/shipped`, payload: { hash: fullSha } })).json()
  const again = (await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/shipped`, payload: { hash: fullSha.slice(0, 10) } })).json()
  expect(again.created).toBe(false)
  expect(again.event.id).toBe(first.event.id)

  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'fix: widget follow-up'], { cwd: repo })
  const second = (await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/shipped`, payload: { hash: 'HEAD' } })).json()
  expect(second.created).toBe(true)

  const events = (await s.inject({ method: 'GET', url: `/api/v1/cards/${card.id}/events` })).json()
  expect(events.filter((e: any) => e.type === 'shipped')).toHaveLength(2)
})

it('rejects unresolvable hashes with the git error and unknown cards with 404', async () => {
  const { s, card } = await boardWithCard()
  const bad = await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/shipped`, payload: { hash: 'deadbeef' } })
  expect(bad.statusCode).toBe(400)
  expect(bad.json().error.length).toBeGreaterThan(0)

  const missing = await s.inject({ method: 'POST', url: '/api/v1/cards/99999/shipped', payload: { hash: fullSha } })
  expect(missing.statusCode).toBe(404)

  const noHash = await s.inject({ method: 'POST', url: `/api/v1/cards/${card.id}/shipped`, payload: {} })
  expect(noHash.statusCode).toBe(400)
})
