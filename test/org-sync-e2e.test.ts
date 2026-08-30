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
  listLocalPresenceAgents,
  startDaemonOrgSync,
  type DaemonOrgSyncHandle,
  type StartDaemonOrgSyncOptions,
} from '../src/org-sync/daemon-integration.js'
import { Outbox } from '../src/org-sync/outbox.js'

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
  it('applies a hosted card to a dedicated org board instead of either existing local board', async () => {
    const setup = await pair()
    const dbA = openDb(path.join(setup.homeA, 'orchestra.db'))
    const dbB = openDb(path.join(setup.homeB, 'orchestra.db'))
    localDbs.push(dbA, dbB)
    const boardA = Number(dbA.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/machine-a', 'Machine A')`).run().lastInsertRowid)
    const boardB = Number(dbB.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/machine-b', 'Machine B')`).run().lastInsertRowid)
    const otherBoardB = Number(dbB.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/machine-b-other', 'Machine B Other')`).run().lastInsertRowid)
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

    // Shared work happens on the org's own local board — a card on the personal
    // /machine-a board must never reach the organization (asserted below).
    const orgBoardA = (dbA.prepare(`SELECT local_board_id AS id FROM org_sync_boards
      WHERE org_id=?`).get(setup.hub.orgId) as { id: number }).id
    const created = await serverA.inject({ method: 'POST', url: '/api/v1/cards', payload: {
      board_id: orgBoardA,
      title: 'Created on daemon A',
      description: 'Visible on the actual machine B board',
      paths: ['src/shared.ts'],
    } })
    expect(created.statusCode).toBe(200)
    await waitUntil(() => Boolean(dbB.prepare(`SELECT 1 FROM cards WHERE title=?`)
      .get('Created on daemon A')))

    const orgBoardB = dbB.prepare(`SELECT board.id, board.project_path, board.name
      FROM org_sync_boards mapping JOIN boards board ON board.id=mapping.local_board_id
      WHERE mapping.org_id=?`).get(setup.hub.orgId) as {
        id: number
        project_path: string
        name: string
      }
    expect(orgBoardB.name).toBe(`Organization ${setup.hub.orgId}`)
    expect(path.dirname(orgBoardB.project_path)).toBe(path.join(setup.homeB, 'organizations'))
    expect(path.basename(orgBoardB.project_path)).toMatch(/^[0-9a-f]{16}$/)
    expect(orgBoardB.id).not.toBe(boardB)
    expect(orgBoardB.id).not.toBe(otherBoardB)

    const snapshot = await serverB.inject({
      method: 'GET', url: `/api/v1/boards/${orgBoardB.id}/snapshot`,
    })
    expect(snapshot.statusCode).toBe(200)
    expect(snapshot.json().cards).toContainEqual(expect.objectContaining({
      title: 'Created on daemon A',
      description: 'Visible on the actual machine B board',
      paths: ['src/shared.ts'],
    }))
    expect(dbB.prepare(`SELECT COUNT(*) AS count FROM cards
      WHERE board_id IN (?, ?)`).get(boardB, otherBoardB)).toEqual({ count: 0 })
    expect(dbA.prepare('SELECT COUNT(*) AS count FROM cards WHERE board_id=?').get(boardA)).toEqual({ count: 0 })
    expect(dbA.prepare('SELECT COUNT(*) AS count FROM cards WHERE board_id=?').get(orgBoardA)).toEqual({ count: 1 })
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

    // PGlite runs this fixture through one connection, so these calls are serialized.
    // This verifies the first-writer-wins protocol result and 409 payload, but it does
    // not prove production Postgres row-lock behavior under genuinely concurrent transactions.
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

describe('organization collaboration end to end', () => {
  /** Two full daemons wired like production: REST server, bus, SQLite, presence.
   * `seed` runs before the daemons start — the presence publisher ticks once at boot
   * and then only on the (long, test-disabled) heartbeat, so an agent that should be
   * announced must exist first, exactly like a real machine's agents at daemon boot. */
  async function twoDaemons(seed?: (dbA: Database.Database, dbB: Database.Database) => void) {
    const setup = await pair()
    const dbA = openDb(path.join(setup.homeA, 'orchestra.db'))
    const dbB = openDb(path.join(setup.homeB, 'orchestra.db'))
    localDbs.push(dbA, dbB)
    seed?.(dbA, dbB)
    const serverA = buildServer(dbA)
    const serverB = buildServer(dbB)
    localServers.push(serverA, serverB)
    const outboxA = new Outbox(setup.homeA)
    const outboxB = new Outbox(setup.homeB)
    for (const [home, db, server, outbox] of [
      [setup.homeA, dbA, serverA, outboxA],
      [setup.homeB, dbB, serverB, outboxB],
    ] as const) {
      await startSimulatedDaemon(home, undefined, {
        localDb: db,
        createOutbox: () => outbox,
        publishLocalChange: (event) => server.bus.emit('event', event),
        subscribeLocalChanges: (listener) => {
          server.bus.on('event', listener)
          return () => server.bus.off('event', listener)
        },
        listLocalAgents: () => listLocalPresenceAgents(db),
      })
    }
    await waitUntil(() => setup.hub.broadcast.listenerCount(setup.hub.orgId) === 2)
    // Both daemons' devices must show as connected while their streams are open —
    // this is what the cloud board's Machines panel reads.
    expect(setup.hub.broadcast.connectedDeviceIds(setup.hub.orgId).size).toBe(2)
    const orgBoard = (db: Database.Database) => (db.prepare(`SELECT local_board_id AS id
      FROM org_sync_boards WHERE org_id=?`).get(setup.hub.orgId) as { id: number }).id
    return { setup, dbA, dbB, serverA, serverB, outboxA, outboxB,
      orgBoardA: orgBoard(dbA), orgBoardB: orgBoard(dbB) }
  }

  const insertAgent = (db: Database.Database, boardId: number, name: string): number =>
    Number(db.prepare(`INSERT INTO agents (board_id, name, status, last_seen)
      VALUES (?, ?, 'active', datetime('now'))`).run(boardId, name).lastInsertRowid)

  it('moves, edits, and claims round-trip between machines without echo storms', async () => {
    const { setup, dbA, dbB, serverA, serverB, outboxA, outboxB, orgBoardA, orgBoardB }
      = await twoDaemons()

    const created = (await serverA.inject({ method: 'POST', url: '/api/v1/cards', payload: {
      board_id: orgBoardA, title: 'Shared work', description: 'v1', paths: ['src/x.ts'],
    } })).json().card
    await waitUntil(() => Boolean(dbB.prepare(`SELECT 1 FROM cards WHERE title='Shared work'`).get()))
    const onB = dbB.prepare(`SELECT * FROM cards WHERE title='Shared work'`).get() as any

    // A moves it — B must see the move, not a second card.
    await serverA.inject({ method: 'POST', url: `/api/v1/cards/${created.id}/move`,
      payload: { column: 'in_progress' } })
    await waitUntil(() => (dbB.prepare('SELECT column_name FROM cards WHERE id=?')
      .get(onB.id) as any)?.column_name === 'in_progress')

    // B edits the title — A must see the rename on the SAME local card.
    await serverB.inject({ method: 'PATCH', url: `/api/v1/cards/${onB.id}`,
      payload: { title: 'Shared work (renamed)' } })
    await waitUntil(() => (dbA.prepare('SELECT title FROM cards WHERE id=?')
      .get(created.id) as any)?.title === 'Shared work (renamed)')

    // B's agent claims it — the claim must reach the hub and A.
    insertAgent(dbB, orgBoardB, 'bob')
    const assigned = await serverB.inject({ method: 'POST', url: `/api/v1/cards/${onB.id}/assign`,
      payload: { agent: 'bob' } })
    expect(assigned.statusCode).toBe(200)
    await waitUntil(() => ownerName(dbA, created.id) === 'bob')
    expect((await setup.hub.sql.query(
      `SELECT owner_agent FROM cards WHERE org_id=$1`, [setup.hub.orgId])).rows)
      .toEqual([{ owner_agent: 'bob' }])

    // Quiescence: both outboxes drain and the hub version stops moving — the echo of
    // each op must not breed another op.
    await waitUntil(() => outboxA.size() === 0 && outboxB.size() === 0)
    const versionNow = Number((await setup.hub.sql.query(
      'SELECT version FROM cards WHERE org_id=$1', [setup.hub.orgId])).rows[0].version)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const versionLater = Number((await setup.hub.sql.query(
      'SELECT version FROM cards WHERE org_id=$1', [setup.hub.orgId])).rows[0].version)
    expect(versionLater).toBe(versionNow)
    expect(Number((await setup.hub.sql.query(
      'SELECT COUNT(*)::int AS count FROM cards WHERE org_id=$1', [setup.hub.orgId])).rows[0].count)).toBe(1)
  }, 20_000)

  it('delivers agent-to-agent mail across machines to the real recipient, once', async () => {
    let personalBoardB = 0
    let bobId = 0
    const { setup, dbA, dbB, serverA, orgBoardA } = await twoDaemons((_dbA, seededB) => {
      personalBoardB = Number(seededB.prepare(`INSERT INTO boards (project_path, name)
        VALUES ('/machine-b', 'Machine B')`).run().lastInsertRowid)
      bobId = insertAgent(seededB, personalBoardB, 'bob')
    })
    insertAgent(dbA, orgBoardA, 'alice')

    // B's presence publishes bob; A projects the shadow it can address mail to.
    await waitUntil(() => Boolean(dbA.prepare(`SELECT 1 FROM agents
      WHERE name='bob' AND board_id=? AND org_sync_remote_origin IS NOT NULL`).get(orgBoardA)))

    const sent = await serverA.inject({ method: 'POST', url: '/api/v1/messages', payload: {
      board_id: orgBoardA, from: 'alice', to: 'bob', body: 'can you review the login flow?',
    } })
    expect(sent.statusCode).toBe(200)

    // The real bob — on his own personal board — receives it.
    await waitUntil(() => Boolean(dbB.prepare(`SELECT 1 FROM messages
      WHERE to_agent_id=? AND body='can you review the login flow?'`).get(bobId)))
    const delivered = dbB.prepare(`SELECT * FROM messages
      WHERE body='can you review the login flow?'`).all() as any[]
    expect(delivered).toHaveLength(1)
    expect(delivered[0].board_id).toBe(personalBoardB)
    expect(delivered[0].mail_type).toBe('organization_sync')

    // The sender keeps exactly one copy — the echo from the hub must be recognized.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(dbA.prepare(`SELECT COUNT(*) AS count FROM messages
      WHERE body='can you review the login flow?'`).get()).toEqual({ count: 1 })
    expect(Number((await setup.hub.sql.query(
      'SELECT COUNT(*)::int AS count FROM mail WHERE org_id=$1', [setup.hub.orgId])).rows[0].count)).toBe(1)
  }, 20_000)

  it('syncs milestones both ways and never leaks personal boards', async () => {
    const { setup, dbA, dbB, serverA, orgBoardA, outboxA } = await twoDaemons()

    const milestone = (await serverA.inject({ method: 'POST', url: '/api/v1/milestones',
      payload: { board_id: orgBoardA, title: 'Launch', description: 'the big one' } })).json()
    await waitUntil(() => Boolean(dbB.prepare(`SELECT 1 FROM milestones WHERE title='Launch'`).get()))

    const card = (await serverA.inject({ method: 'POST', url: '/api/v1/cards', payload: {
      board_id: orgBoardA, title: 'Launch step',
    } })).json().card
    await serverA.inject({ method: 'PATCH', url: `/api/v1/cards/${card.id}/milestone`,
      payload: { milestone_id: milestone.id } })
    await waitUntil(() => {
      const onB = dbB.prepare(`SELECT milestone_id FROM cards WHERE title='Launch step'`).get() as any
      if (!onB?.milestone_id) return false
      const linked = dbB.prepare('SELECT title FROM milestones WHERE id=?').get(onB.milestone_id) as any
      return linked?.title === 'Launch'
    })

    // Personal boards stay personal: a milestone and a message there must never sync.
    const personalBoardA = Number(dbA.prepare(`INSERT INTO boards (project_path, name)
      VALUES ('/machine-a', 'Machine A')`).run().lastInsertRowid)
    await serverA.inject({ method: 'POST', url: '/api/v1/milestones',
      payload: { board_id: personalBoardA, title: 'Private plan' } })
    insertAgent(dbA, personalBoardA, 'diary')
    await serverA.inject({ method: 'POST', url: '/api/v1/messages', payload: {
      board_id: personalBoardA, from: 'diary', body: 'private note',
    } })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(Number((await setup.hub.sql.query(
      'SELECT COUNT(*)::int AS count FROM milestones WHERE org_id=$1', [setup.hub.orgId])).rows[0].count)).toBe(1)
    expect(Number((await setup.hub.sql.query(
      'SELECT COUNT(*)::int AS count FROM mail WHERE org_id=$1', [setup.hub.orgId])).rows[0].count)).toBe(0)
    expect(dbB.prepare(`SELECT COUNT(*) AS count FROM milestones WHERE title='Private plan'`).get())
      .toEqual({ count: 0 })

    // Deleting the shared milestone detaches everywhere.
    await serverA.inject({ method: 'DELETE', url: `/api/v1/milestones/${milestone.id}` })
    await waitUntil(() => !dbB.prepare(`SELECT 1 FROM milestones WHERE title='Launch'`).get())
    expect((dbB.prepare(`SELECT milestone_id FROM cards WHERE title='Launch step'`).get() as any)
      .milestone_id).toBeNull()
  }, 20_000)
})

const ownerName = (db: Database.Database, cardId: number): string | null => {
  const row = db.prepare(`SELECT agent.name AS owner FROM cards card
    LEFT JOIN agents agent ON agent.id=card.owner_agent_id WHERE card.id=?`).get(cardId) as
    { owner: string | null } | undefined
  return row?.owner ?? null
}
