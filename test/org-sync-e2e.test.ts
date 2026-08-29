import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { hubFixture, closeHubServers, type HubFixture } from './support/hub-fixture.js'
import { mintDeviceToken } from '../src/hub/devices.js'
import { saveOrgCredential, type OrgCredential } from '../src/org-sync/credentials.js'
import { HubClient, HubConflictError, type HubSyncEvent } from '../src/org-sync/hub-client.js'
import {
  startDaemonOrgSync,
  type DaemonOrgSyncHandle,
  type StartDaemonOrgSyncOptions,
} from '../src/org-sync/daemon-integration.js'

const homes: string[] = []
const handles: DaemonOrgSyncHandle[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()))
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
  applyEvent: (event: HubSyncEvent) => void | Promise<void>,
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
  it('delivers a card created by one joined daemon to the other over live SSE', async () => {
    const setup = await pair()
    const seenA: HubSyncEvent[] = []
    const seenB: HubSyncEvent[] = []
    let publishLocalChange: ((change: unknown) => void) | undefined
    await startSimulatedDaemon(setup.homeA, (event) => { seenA.push(event) }, {
      subscribeLocalChanges: (listener) => { publishLocalChange = listener; return () => { publishLocalChange = undefined } },
      mapLocalChange: (change: any, boardId) => ({
        op: 'card.create', payload: { board_id: boardId, title: change.title },
      }),
    })
    await startSimulatedDaemon(setup.homeB, (event) => { seenB.push(event) })
    await waitUntil(() => setup.hub.broadcast.listenerCount(setup.hub.orgId) === 2)

    publishLocalChange?.({ title: 'Created on daemon A' })
    await waitUntil(() => seenB.some((event: any) => event.payload?.title === 'Created on daemon A'))

    expect(seenA.filter((event) => event.kind === 'card.created')).toHaveLength(1)
    expect(seenB.filter((event) => event.kind === 'card.created')).toHaveLength(1)
    expect((seenB.find((event) => event.kind === 'card.created')!.payload as any).title).toBe('Created on daemon A')
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
