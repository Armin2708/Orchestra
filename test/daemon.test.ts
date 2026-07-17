import { expect, it } from 'vitest'
import { dataDir, port } from '../src/daemon.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

it('resolves data dir and port from env', () => {
  process.env.ORCHESTRA_HOME = '/tmp/abtest'
  process.env.ORCHESTRA_PORT = '5999'
  expect(dataDir()).toBe('/tmp/abtest')
  expect(port()).toBe(5999)
  delete process.env.ORCHESTRA_HOME; delete process.env.ORCHESTRA_PORT
})

it('serves SSE with correct content type', async () => {
  const s = buildServer(openDb(':memory:')); await s.ready()
  await s.inject({ method: 'POST', url: '/api/v1/boards/resolve', payload: { project_path: '/p' } })
  const res = await s.inject({ method: 'GET', url: '/api/v1/boards/1/events',
    payloadAsStream: true })
  expect(res.headers['content-type']).toContain('text/event-stream')
})
