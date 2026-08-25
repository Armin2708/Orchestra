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
