import { expect, it, vi } from 'vitest'
import { openDb } from '../src/db.js'
import { buildServer, type Bus, type ConductorLike } from '../src/server.js'

const requiredHost = (): ConductorLike => ({
  isHired: () => true,
  hire: () => ({}),
  deliver: () => true,
  task: () => true,
  transcript: () => ({ lines: [], working: null }),
  subagents: () => [],
  interruptAgent: async () => true,
  fire: async () => true,
  launch: () => ({}),
  isLaunched: () => false,
})

it('exposes live MCP status, toggle, reconnect, and plugin reload controls', async () => {
  const connected = [{ name: 'github remote', status: 'connected', tools: [{ name: 'search' }] }]
  const disabled = [{ name: 'github remote', status: 'disabled', tools: [] }]
  const host: ConductorLike = {
    ...requiredHost(),
    mcpStatus: vi.fn(async () => connected),
    toggleMcpServer: vi.fn(async () => disabled),
    reconnectMcpServer: vi.fn(async () => connected),
    reloadPlugins: vi.fn(async () => ({ plugins: [{ name: 'review', path: '/plugins/review' }], error_count: 0 })),
  }
  const server = buildServer(openDb(':memory:'), (_bus: Bus) => host)
  await server.ready()

  const status = await server.inject({ method: 'GET', url: '/api/v1/agents/7/mcp' })
  expect(status.statusCode).toBe(200)
  expect(status.json()).toEqual({ servers: connected })

  const toggle = await server.inject({
    method: 'POST', url: '/api/v1/agents/7/mcp/github%20remote/toggle', payload: { enabled: false },
  })
  expect(toggle.json()).toEqual({ ok: true, servers: disabled })
  expect(host.toggleMcpServer).toHaveBeenCalledWith(7, 'github remote', false)

  const reconnect = await server.inject({ method: 'POST', url: '/api/v1/agents/7/mcp/github%20remote/reconnect' })
  expect(reconnect.json()).toEqual({ ok: true, servers: connected })
  expect(host.reconnectMcpServer).toHaveBeenCalledWith(7, 'github remote')

  const plugins = await server.inject({ method: 'POST', url: '/api/v1/agents/7/plugins/reload' })
  expect(plugins.json()).toEqual({ plugins: [{ name: 'review', path: '/plugins/review' }], error_count: 0 })
  expect(host.reloadPlugins).toHaveBeenCalledWith(7)

  await server.close()
})

it('validates control input and reports unavailable or missing live sessions', async () => {
  const host: ConductorLike = {
    ...requiredHost(),
    mcpStatus: async () => null,
    toggleMcpServer: async () => null,
  }
  const server = buildServer(openDb(':memory:'), () => host)
  await server.ready()

  expect((await server.inject({ method: 'GET', url: '/api/v1/agents/404/mcp' })).statusCode).toBe(404)
  expect((await server.inject({ method: 'POST', url: '/api/v1/agents/1/mcp/x/toggle', payload: { enabled: 'yes' } })).statusCode).toBe(400)
  expect((await server.inject({ method: 'POST', url: '/api/v1/agents/1/plugins/reload' })).statusCode).toBe(501)

  await server.close()
})

it('forwards SDK control failures as a gateway error', async () => {
  const host: ConductorLike = {
    ...requiredHost(),
    mcpStatus: vi.fn(async () => { throw new Error('session closed') }),
  }
  const server = buildServer(openDb(':memory:'), () => host)
  await server.ready()

  const response = await server.inject({ method: 'GET', url: '/api/v1/agents/1/mcp' })
  expect(response.statusCode).toBe(502)
  expect(response.json()).toEqual({ error: 'session closed' })

  await server.close()
})
