import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

// Projects are curated by the operator: resolve is lookup-only unless the caller
// explicitly asks to create — sessions in unknown folders must not add boards.
it('boards/resolve without create is lookup-only', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  const miss = await s.inject({ method: 'POST', url: '/api/v1/boards/resolve',
    payload: { project_path: '/never-added' } })
  expect(miss.statusCode).toBe(404)
  expect((await s.inject({ method: 'GET', url: '/api/v1/boards' })).json()).toHaveLength(0)

  const made = await s.inject({ method: 'POST', url: '/api/v1/boards/resolve',
    payload: { project_path: '/added', create: true } })
  expect(made.statusCode).toBe(200)
  // once the operator added it, plain lookup resolves it for sessions
  const found = await s.inject({ method: 'POST', url: '/api/v1/boards/resolve',
    payload: { project_path: '/added' } })
  expect(found.json().id).toBe(made.json().id)
})

it('fs/dirs lists only directories for the operator', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-fsdirs-'))
  fs.mkdirSync(path.join(root, 'beta'))
  fs.mkdirSync(path.join(root, 'alpha'))
  fs.mkdirSync(path.join(root, '.hidden'))
  fs.writeFileSync(path.join(root, 'file.txt'), 'x')
  const s = buildServer(openDb(':memory:')); await s.ready()

  const res = await s.inject({ method: 'GET', url: `/api/v1/fs/dirs?path=${encodeURIComponent(root)}` })
  expect(res.statusCode).toBe(200)
  const listing = res.json()
  expect(listing.dirs.map((d: { name: string }) => d.name)).toEqual(['alpha', 'beta'])
  expect(listing.parent).toBe(path.dirname(fs.realpathSync(root)))

  expect((await s.inject({ method: 'GET', url: '/api/v1/fs/dirs?path=/definitely/missing' })).statusCode).toBe(404)
  expect((await s.inject({ method: 'GET',
    url: `/api/v1/fs/dirs?path=${encodeURIComponent(path.join(root, 'file.txt'))}` })).statusCode).toBe(400)
})

// The native Finder chooser opens on the daemon's own display, so the route only
// serves operators browsing from this machine; everyone else falls back to fs/dirs.
it('fs/pick-dir returns the natively chosen folder to a local operator', async () => {
  const s = buildServer(openDb(':memory:'), undefined, {
    pickNativeFolder: async () => ({ path: '/Users/op/project', cancelled: false }) })
  await s.ready()
  const res = await s.inject({ method: 'POST', url: '/api/v1/fs/pick-dir' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ path: '/Users/op/project', cancelled: false })
})

it('fs/pick-dir reports a dismissed chooser as cancelled', async () => {
  const s = buildServer(openDb(':memory:'), undefined, {
    pickNativeFolder: async () => ({ path: null, cancelled: true }) })
  await s.ready()
  const res = await s.inject({ method: 'POST', url: '/api/v1/fs/pick-dir' })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ path: null, cancelled: true })
})

it('fs/pick-dir never opens a dialog for non-local callers', async () => {
  let opened = 0
  const s = buildServer(openDb(':memory:'), undefined, {
    pickNativeFolder: async () => { opened += 1; return { path: '/x', cancelled: false } } })
  await s.ready()
  const res = await s.inject({ method: 'POST', url: '/api/v1/fs/pick-dir', remoteAddress: '203.0.113.9' })
  expect(res.statusCode).toBeGreaterThanOrEqual(400)
  expect(opened).toBe(0)
})

it('fs/pick-dir refuses a second chooser while one is open', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const s = buildServer(openDb(':memory:'), undefined, {
    pickNativeFolder: async () => { await gate; return { path: '/first', cancelled: false } } })
  await s.ready()
  const first = s.inject({ method: 'POST', url: '/api/v1/fs/pick-dir' })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = await s.inject({ method: 'POST', url: '/api/v1/fs/pick-dir' })
  expect(second.statusCode).toBe(409)
  expect(second.json().code).toBe('picker_busy')
  release()
  expect((await first).statusCode).toBe(200)
})

it('fs/pick-dir maps a chooser failure to picker_unavailable so the UI falls back', async () => {
  const s = buildServer(openDb(':memory:'), undefined, {
    pickNativeFolder: async () => { throw new Error('automation denied') } })
  await s.ready()
  const res = await s.inject({ method: 'POST', url: '/api/v1/fs/pick-dir' })
  expect(res.statusCode).toBe(409)
  expect(res.json().code).toBe('picker_unavailable')
})
