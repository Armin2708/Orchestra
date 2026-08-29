import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { hubFixture, closeHubServers, type HubFixture } from './support/hub-fixture.js'
import { mintDeviceToken } from '../src/hub/devices.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'
import { saveOrgCredential, type OrgCredential } from '../src/org-sync/credentials.js'
import { HubClient, HubConflictError, type HubSyncEvent } from '../src/org-sync/hub-client.js'
import {
  startDaemonOrgSync,
  type DaemonOrgSyncHandle,
  type StartDaemonOrgSyncOptions,
} from '../src/org-sync/daemon-integration.js'

const homes: string[] = []
const handles: DaemonOrgSyncHandle[] = []
const localServers: FastifyInstance[] = []
const localDbs: Database.Database[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()))
  await Promise.all(localServers.splice(0).map((server) => server.close()))
  for (const db of localDbs.splice(0)) db.close()
  await closeHubServers()
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
})

const temporaryHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-sync-e2e-'))
  homes.push(home)
  return home
}

const waitUntil = async (condition: () => boolean) => {
  await vi.waitFor(() => expect(condition()).toBe(true), { timeout: 5_000, interval: 10 })
}

interface Pair {
  hub: HubFixture
  homeA: string
  homeB: string
  clientA: HubClient
  clientB: HubClient
}

async function pair(): Promise<Pair> {
  const hub = await hubFixture()
  await hub.server.listen({ host: '127.0.0.1', port: 0 })
  const base = `http://127.0.0.1:${(hub.server.server.address() as AddressInfo).port}`
  const second = await mintDeviceToken(hub.sql, { orgId: hub.orgId, name: 'daemon-b' })
  const homeA = temporaryHome()
  const homeB = temporaryHome()
  const credentialA: OrgCredential = {
    hubBaseUrl: base, orgId: hub.orgId, deviceToken: hub.token, deviceName: 'daemon-a',
  }
  const credentialB: OrgCredential = {
    hubBaseUrl: base, orgId: hub.orgId, deviceToken: second.token, deviceName: 'daemon-b',
  }
  await saveOrgCredential(credentialA, homeA)
  await saveOrgCredential(credentialB, homeB)
  return {
    hub, homeA, homeB,
    clientA: new HubClient(credentialA),
    clientB: new HubClient(credentialB),
  }
}

const startSimulatedDaemon = async (
  home: string,
  applyEvent?: (event: HubSyncEvent) => void | Promise<void>,
  extra: Partial<StartDaemonOrgSyncOptions> = {},
) => {
  const handle = await startDaemonOrgSync({
    ...extra,
    home,
    applyEvent,
    output: () => undefined,
    heartbeatMs: 60_000,
  })
  if (!handle) throw new Error('simulated daemon did not start org sync')
  handles.push(handle)
  return handle
}

describe('organization sync end to end', () => {
  it('applies a hosted card through the default path into the other daemon local board', async () => {
    const setup = await pair()
    const dbA = openDb(path.join(setup.homeA, 'orchestra.db'))
    const dbB = openDb(path.join(setup.homeB, 'orchestra.db'))
    localDbs.push(dbA, dbB)
    const boardA = Number(dbA.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/machine-a', 'Machine A')`).run().lastInsertRowid)
    const boardB = Number(dbB.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/machine-b', 'Machine B')`).run().lastInsertRowid)
    const serverA = buildServer(dbA)
    const serverB = buildServer(dbB)
    localServers.push(serverA, serverB)
    for (const [home, db, server] of [
      [setup.homeA, dbA, serverA],
      [setup.homeB, dbB, serverB],
    ] as const) {
      await startSimulatedDaemon(home, undefined, {
        localDb: db,
        publishLocalChange: (event) => server.bus.emit('event', event),
        subscribeLocalChanges: (listener) => {
          server.bus.on('event', listener)
          return () => server.bus.off('event', listener)
        },
        listLocalAgents: () => [],
      })
    }
    await waitUntil(() => setup.hub.broadcast.listenerCount(setup.hub.orgId) === 2)

    const created = await serverA.inject({ method: 'POST', url: '/api/v1/cards', payload: {
      board_id: boardA,
      title: 'Created on daemon A',
      description: 'Visible on the actual machine B board',
      paths: ['src/shared.ts'],
    } })
    expect(created.statusCode).toBe(200)
    await waitUntil(() => Boolean(dbB.prepare(`SELECT 1 FROM cards WHERE board_id=? AND title=?`)
      .get(boardB, 'Created on daemon A')))

    const snapshot = await serverB.inject({
      method: 'GET', url: `/api/v1/boards/${boardB}/snapshot`,
    })
    expect(snapshot.statusCode).toBe(200)
    expect(snapshot.json().cards).toContainEqual(expect.objectContaining({
      title: 'Created on daemon A',
      description: 'Visible on the actual machine B board',
      paths: ['src/shared.ts'],
    }))
    expect(dbA.prepare('SELECT COUNT(*) AS count FROM cards WHERE board_id=?').get(boardA)).toEqual({ count: 1 })
    expect((await setup.hub.sql.query('SELECT COUNT(*)::int AS count FROM cards WHERE org_id=$1', [setup.hub.orgId])).rows)
      .toEqual([{ count: 1 }])
    expect(fs.existsSync(path.join(setup.homeA, 'org-state.json'))).toBe(false)
    expect(fs.existsSync(path.join(setup.homeB, 'org-state.json'))).toBe(false)
  })

  it('allows exactly one claimant and gives the loser current state in a 409', async () => {
    const setup = await pair()
    const created = await setup.clientA.postOp('card.create', {
      board_id: setup.hub.boardId,
      title: 'Contested card',
    })
    const cardId = (created.result as any).id

    const attempts = await Promise.allSettled([
      setup.clientA.postOp('card.claim', { card_id: cardId, agent: 'alice' }),
      setup.clientB.postOp('card.claim', { card_id: cardId, agent: 'bob' }),
    ])
    const winners = attempts.filter((attempt) => attempt.status === 'fulfilled')
    const losers = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected')

    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0].reason).toBeInstanceOf(HubConflictError)
    expect((losers[0].reason as HubConflictError).current).toMatchObject({ id: cardId })
    expect(['alice', 'bob']).toContain(((losers[0].reason as HubConflictError).current as any).owner_agent)
  })

  it('catches up after disconnect with no gaps or duplicates', async () => {
    const setup = await pair()
    const seen: HubSyncEvent[] = []
    const first = await startSimulatedDaemon(setup.homeB, (event) => { seen.push(event) })
    await waitUntil(() => setup.hub.broadcast.listenerCount(setup.hub.orgId) === 1)

    await setup.clientA.postOp('card.create', { board_id: setup.hub.boardId, title: 'Before disconnect' })
    await waitUntil(() => seen.some((event: any) => event.payload?.title === 'Before disconnect'))
    await first.stop()
    handles.splice(handles.indexOf(first), 1)
    await waitUntil(() => setup.hub.broadcast.listenerCount(setup.hub.orgId) === 0)

    for (const title of ['While offline 1', 'While offline 2', 'While offline 3']) {
      await setup.clientA.postOp('card.create', { board_id: setup.hub.boardId, title })
    }

    await startSimulatedDaemon(setup.homeB, (event) => { seen.push(event) })
    await waitUntil(() => seen.some((event: any) => event.payload?.title === 'While offline 3'))

    const cardEvents = seen.filter((event) => event.kind === 'card.created')
    expect(cardEvents.map((event: any) => event.payload.title)).toEqual([
      'Before disconnect', 'While offline 1', 'While offline 2', 'While offline 3',
    ])
    expect(new Set(cardEvents.map((event) => event.seq)).size).toBe(cardEvents.length)
    for (let index = 1; index < cardEvents.length; index += 1) {
      expect(cardEvents[index].seq).toBeGreaterThan(cardEvents[index - 1].seq)
    }
  })
})
