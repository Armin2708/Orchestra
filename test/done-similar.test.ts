import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('warns when new work matches a recently-done card', async () => {
  const db = openDb(':memory:')
  const s = buildServer(db); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()

  const shipped = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Mobile-first installable PWA shell', description: 'manifest, icons, service worker' } })).json()
  await s.inject({ method: 'POST', url: `/api/v1/cards/${shipped.card.id}/move`, payload: { column: 'done' } })

  const dup = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Make the web UI an installable mobile PWA', description: 'manifest and service worker' } })).json()
  expect(dup.done_similar.map((c: any) => c.id)).toContain(shipped.card.id)

  const unrelated = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Rate limit the message endpoints' } })).json()
  expect(unrelated.done_similar).toEqual([])
})

it('applies the shipped check when an idea is promoted', async () => {
  const db = openDb(':memory:')
  const s = buildServer(db); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()

  const shipped = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Mobile-first installable PWA shell', description: 'manifest, icons, service worker' } })).json()
  await s.inject({ method: 'POST', url: `/api/v1/cards/${shipped.card.id}/move`, payload: { column: 'done' } })

  const idea = (await s.inject({ method: 'POST', url: '/api/v1/ideas', payload: {
    board_id: b.id, text: 'Installable mobile PWA\nmanifest and service worker for the web UI' } })).json()
  const promoted = (await s.inject({ method: 'POST', url: `/api/v1/ideas/${idea.id}/promote`, payload: {} })).json()
  expect(promoted.done_similar.map((c: any) => c.id)).toContain(shipped.card.id)
})

it('ignores done cards older than 30 days', async () => {
  const db = openDb(':memory:')
  const s = buildServer(db); await s.ready()
  const b = (await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })).json()

  const shipped = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Mobile-first installable PWA shell', description: 'manifest, icons, service worker' } })).json()
  await s.inject({ method: 'POST', url: `/api/v1/cards/${shipped.card.id}/move`, payload: { column: 'done' } })
  db.prepare(`UPDATE cards SET updated_at = datetime('now', '-40 days') WHERE id=?`).run(shipped.card.id)

  const dup = (await s.inject({ method: 'POST', url: '/api/v1/cards', payload: {
    board_id: b.id, title: 'Make the web UI an installable mobile PWA', description: 'manifest and service worker' } })).json()
  expect(dup.done_similar).toEqual([])
})
