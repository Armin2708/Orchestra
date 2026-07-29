import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import {
  SERVER_COMPOSITION_CONTRACT,
  composeAgentOsRouteOptions,
  type AgentOsServerRouteOptions,
} from '../src/server-composition.js'

const servers: FastifyInstance[] = []
const databases: Database.Database[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const db of databases.splice(0)) db.close()
})

const resolveDrivers = (
  value: ReturnType<typeof composeAgentOsRouteOptions>['drivers'],
) => typeof value === 'function' ? value() : value ?? []

const resolveProviders = async (
  value: ReturnType<typeof composeAgentOsRouteOptions>['providers'],
) => typeof value === 'function' ? value() : value ?? []

describe('server composition boundary', () => {
  it('states the buildServer role without claiming canonical domain behavior', () => {
    expect(SERVER_COMPOSITION_CONTRACT).toEqual({
      role: 'composition_and_compatibility_routing',
      owns: [
        'Fastify lifecycle and authentication',
        'dependency injection',
        'focused route-plugin registration',
        'legacy compatibility route registration',
      ],
      excludes: [
        'canonical domain state transitions',
        'canonical service construction',
        'domain persistence and validation rules',
      ],
      canonical_route_registrar: 'registerAgentOsRoutes',
    })
    expect(Object.isFrozen(SERVER_COMPOSITION_CONTRACT)).toBe(true)
    expect(Object.isFrozen(SERVER_COMPOSITION_CONTRACT.owns)).toBe(true)
    expect(Object.isFrozen(SERVER_COMPOSITION_CONTRACT.excludes)).toBe(true)
  })

  it('composes the exact no-daemon provider and driver fallbacks', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const isOperator = vi.fn(() => true)
    const options = composeAgentOsRouteOptions({ db, isOperator })

    expect(options.db).toBe(db)
    expect(options.isOperator).toBe(isOperator)
    expect(resolveDrivers(options.drivers)).toEqual([
      {
        id: 'claude',
        available: false,
        capabilities: ['launch', 'attach', 'send', 'interrupt', 'events'],
        detail: 'requires the daemon Conductor',
      },
      {
        id: 'codex',
        available: false,
        capabilities: ['launch', 'attach', 'send', 'interrupt', 'events'],
        detail: 'requires the daemon Codex app-server runtime',
      },
      {
        id: 'shell',
        available: false,
        capabilities: ['launch', 'input', 'resize', 'signal', 'events'],
        detail: 'requires the PTY runtime',
      },
    ])
    expect((await resolveProviders(options.providers)).map((provider) => ({
      id: provider.id,
      available: provider.available,
      source: provider.source,
    }))).toEqual([
      { id: 'claude', available: false, source: 'unavailable' },
      { id: 'codex', available: false, source: 'unavailable' },
    ])
  })

  it('uses daemon discoveries and preserves explicit route overrides by identity', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const discovered = [{
      id: 'fixture',
      name: 'Fixture',
      available: true,
      models: [],
      source: 'live' as const,
      updated_at: '2026-07-29T00:00:00.000Z',
    }]
    const providerCatalog = vi.fn(async () => discovered)
    const runtime = {} as NonNullable<AgentOsServerRouteOptions['runtime']>
    const composed = composeAgentOsRouteOptions({
      db,
      host: { providerCatalog },
      agentOs: { runtime },
      isOperator: () => true,
    })

    expect(resolveDrivers(composed.drivers).map(({ id, available }) => ({ id, available })))
      .toEqual([
        { id: 'claude', available: true },
        { id: 'codex', available: false },
        { id: 'shell', available: true },
      ])
    expect(await resolveProviders(composed.providers)).toBe(discovered)
    expect(providerCatalog).toHaveBeenCalledOnce()

    const drivers = [{ id: 'custom', available: true, capabilities: ['events'] }]
    const providers = discovered
    const overridden = composeAgentOsRouteOptions({
      db,
      host: { providerCatalog },
      agentOs: { drivers, providers },
      isOperator: () => true,
    })
    expect(overridden.drivers).toBe(drivers)
    expect(overridden.providers).toBe(providers)
  })

  it('registers the canonical plugin through buildServer without changing public fallbacks', async () => {
    const db = openDb(':memory:')
    databases.push(db)
    const server = buildServer(db)
    servers.push(server)
    await server.ready()

    const drivers = (await server.inject({
      method: 'GET',
      url: '/api/v1/os/drivers',
    })).json().drivers
    const providers = (await server.inject({
      method: 'GET',
      url: '/api/v1/os/providers',
    })).json().providers

    expect(drivers.map(({ id, available }: { id: string; available: boolean }) => ({
      id,
      available,
    }))).toEqual([
      { id: 'claude', available: false },
      { id: 'codex', available: false },
      { id: 'shell', available: false },
    ])
    expect(providers.map(({ id, available }: { id: string; available: boolean }) => ({
      id,
      available,
    }))).toEqual([
      { id: 'claude', available: false },
      { id: 'codex', available: false },
    ])
  })

  it('guards the critical server hub against canonical domain logic and inline Agent OS routes', () => {
    const serverSource = fs.readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
    const compositionSource = fs.readFileSync(
      new URL('../src/server-composition.ts', import.meta.url),
      'utf8',
    )

    expect(serverSource).toContain('registerAgentOsServerComposition(server')
    expect(serverSource).not.toContain('registerAgentOsRoutes')
    expect(serverSource).not.toMatch(
      /from '.\/agent-os\/(?:orchestration-service|conversations|delivery-reports|knowledge-store|conflict-service|scheduler)\.js'/,
    )
    expect(serverSource).not.toMatch(
      /new (?:OrchestrationService|ConversationService|DeliveryReportService|KnowledgeStore|ComputedWorkspaceConflictService|JobScheduler)\b/,
    )
    expect(compositionSource.match(/registerAgentOsRoutes\(/g)).toHaveLength(1)
    expect(compositionSource).not.toMatch(/\bserver\.(?:get|post|put|patch|delete)\s*\(/)
    expect(compositionSource).not.toContain('.prepare(')
    expect(compositionSource).not.toMatch(
      /new (?:OrchestrationService|ConversationService|DeliveryReportService|KnowledgeStore|ComputedWorkspaceConflictService|JobScheduler)\b/,
    )
  })
})
