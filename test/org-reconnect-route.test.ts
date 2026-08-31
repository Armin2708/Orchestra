import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db.js'

let server: FastifyInstance

afterEach(async () => { await server?.close() })

describe('POST /api/v1/org/reconnect', () => {
  it('kicks the sync loop for the operator and returns the fresh status', async () => {
    let kicked = 0
    server = buildServer(openDb(':memory:'), undefined, {
      orgSyncReconnect: async () => { kicked += 1 },
      orgSyncStatus: () => ({ joined: true, orgId: 'org_x', orgName: 'X', boardId: 1, state: 'connecting', detail: null }),
    })
    const response = await server.inject({ method: 'POST', url: '/api/v1/org/reconnect' })
    expect(response.statusCode).toBe(200)
    expect(kicked).toBe(1)
    expect(response.json().state).toBe('connecting')
  })

  it('pauses the loop for the operator and refuses non-loopback callers', async () => {
    let paused = 0
    server = buildServer(openDb(':memory:'), undefined, {
      orgSyncPause: async () => { paused += 1 },
      orgSyncStatus: () => ({ joined: true, orgId: 'org_x', orgName: 'X', boardId: 1, state: 'paused', detail: null }),
    })
    const ok = await server.inject({ method: 'POST', url: '/api/v1/org/pause' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().state).toBe('paused')
    expect(paused).toBe(1)
    const remote = await server.inject({ method: 'POST', url: '/api/v1/org/pause', remoteAddress: '203.0.113.5' })
    expect(remote.statusCode).toBeGreaterThanOrEqual(401)
    expect(paused).toBe(1)
  })

  it('refuses non-operator principals — only the operator may bounce the org connection', async () => {
    let kicked = 0
    server = buildServer(openDb(':memory:'), undefined, {
      orgSyncReconnect: async () => { kicked += 1 },
      orgSyncStatus: () => ({ joined: true, orgId: 'org_x', orgName: 'X', boardId: 1, state: 'live', detail: null }),
    })
    // A non-loopback caller gets no loopback-trust promotion and stays anonymous.
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/org/reconnect',
      remoteAddress: '203.0.113.5',
    })
    expect(response.statusCode).toBeGreaterThanOrEqual(401)
    expect(kicked).toBe(0)
  })
})
