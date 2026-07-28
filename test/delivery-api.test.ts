import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { DeliveryReportService } from '../src/agent-os/delivery-reports.js'
import { JobScheduler } from '../src/agent-os/scheduler.js'
import { buildServer } from '../src/server.js'

const TOKEN = 'delivery-api-token'
const auth = { authorization: `Bearer ${TOKEN}` }
const servers: FastifyInstance[] = []
let commandSequence = 0

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
})

async function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/delivery-api', 'delivery')")
    .run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Delivery API', 'Return a complete delivery report')`).run(boardId).lastInsertRowid)
  const server = buildServer(db, undefined, { token: TOKEN })
  server.addHook('onRequest', async (request) => {
    if (request.method === 'POST' && !request.headers['idempotency-key']) {
      request.headers['idempotency-key'] = `delivery-api-${++commandSequence}`
    }
  })
  servers.push(server)
  await server.ready()
  return { db, boardId, cardId, server }
}

async function preparedReport(server: FastifyInstance, boardId: number, cardId: number) {
  const contract = await server.inject({
    method: 'PUT',
    url: `/api/v1/os/cards/${cardId}/contract`,
    headers: auth,
    payload: {
      deliverables: [{ id: 'deliverable-api', text: 'Expose the delivery API', required: true }],
      acceptance_criteria: [{
        id: 'criterion-api',
        text: 'The delivery can be reviewed',
        required: true,
        deliverable_ids: ['deliverable-api'],
      }],
      verify_commands: ['npm test'],
    },
  })
  expect(contract.statusCode).toBe(200)
  const response = await server.inject({
    method: 'POST',
    url: `/api/v1/os/boards/${boardId}/jobs`,
    headers: auth,
    payload: { card_id: cardId, provider: 'future-provider' },
  })
  expect(response.statusCode).toBe(201)
  expect(response.json().delivery).toMatchObject({ card_id: cardId, status: 'draft' })
  return response.json()
}

describe('Delivery Trackbook API', () => {
  it('prepares a frozen report, validates actors, submits evidence, verifies, accepts, and exports it', async () => {
    const { boardId, cardId, server } = await fixture()
    const launched = await preparedReport(server, boardId, cardId)
    const deliveryId = launched.delivery.id as string

    const listed = await server.inject({
      method: 'GET', url: `/api/v1/os/cards/${cardId}/deliveries`, headers: auth,
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject({
      deliveries: [{ id: deliveryId, job_id: launched.job.id }],
      current: { id: deliveryId, status: 'draft' },
    })
    const preparedAgain = await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${launched.job.id}/deliveries/prepare`, headers: auth,
    })
    expect(preparedAgain.statusCode).toBe(201)
    expect(preparedAgain.json().delivery.id).toBe(deliveryId)

    const missingActor = await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${launched.job.id}/deliveries/submit`, headers: auth,
      payload: { summary: 'missing actor' },
    })
    expect(missingActor.statusCode).toBe(400)

    const artifactResponse = await server.inject({
      method: 'POST', url: `/api/v1/os/cards/${cardId}/evidence`, headers: auth,
      payload: { kind: 'test_report', name: 'delivery-test.txt', content: 'npm test: pass' },
    })
    const artifactId = artifactResponse.json().artifact.id as string
    const submitted = await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${launched.job.id}/deliveries/submit`, headers: auth,
      payload: {
        actor: 'agent',
        summary: 'Implemented and exercised the delivery API.',
        items: [{ deliverableId: 'deliverable-api', status: 'delivered' }],
        evidence: { artifacts: [artifactId], changed_files: ['src/agent-os/routes.ts'] },
        criteria: [{ criterionId: 'criterion-api', outcome: 'met', evidence: [artifactId] }],
      },
    })
    expect(submitted.statusCode).toBe(200)
    expect(submitted.json().delivery).toMatchObject({ status: 'verified', artifact_ids: [artifactId] })

    const premature = await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${deliveryId}/accept`, headers: auth,
      payload: { actor: 'human' },
    })
    expect(premature.statusCode).toBe(409)
    expect(premature.json().error).toMatch(/deliverable-api/)

    const verified = await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${deliveryId}/verify`, headers: auth,
      payload: {
        actor: 'verifier',
        deliverable_results: [{ deliverableId: 'deliverable-api', outcome: 'met', evidence: [artifactId] }],
      },
    })
    expect(verified.statusCode).toBe(200)
    expect(verified.json().delivery.deliverable_results[0]).toMatchObject({ outcome: 'met' })

    const accepted = await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${deliveryId}/accept`, headers: auth,
      payload: { actor: 'human', note: 'Evidence checked.' },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().delivery).toMatchObject({ status: 'accepted', accepted_by: 'human' })

    const human = await server.inject({
      method: 'GET', url: `/api/v1/os/deliveries/${deliveryId}/export?format=human`, headers: auth,
    })
    expect(human.statusCode).toBe(200)
    expect(human.headers['content-type']).toContain('text/plain')
    expect(human.body).toContain(`# Delivery ${deliveryId}`)
    expect(human.body).toContain('Claims (not evidence)')

    const json = await server.inject({
      method: 'GET', url: `/api/v1/os/deliveries/${deliveryId}/export?format=json`, headers: auth,
    })
    expect(json.json().delivery.status).toBe('accepted')
  })

  it('rejects and creates one idempotent revision while preserving the frozen Asked snapshot', async () => {
    const { boardId, cardId, server } = await fixture()
    const launched = await preparedReport(server, boardId, cardId)
    const deliveryId = launched.delivery.id as string
    await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${launched.job.id}/deliveries/submit`, headers: auth,
      payload: { actor: 'agent', summary: 'Needs review.' },
    })

    const missingReason = await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${deliveryId}/reject`, headers: auth,
      payload: { actor: 'human' },
    })
    expect(missingReason.statusCode).toBe(400)

    const rejected = await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${deliveryId}/reject`, headers: auth,
      payload: { actor: 'human', reason: 'The evidence is incomplete.' },
    })
    expect(rejected.json().delivery.status).toBe('rejected')
    const firstRevision = await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${deliveryId}/revise`, headers: auth,
      payload: { actor: 'agent' },
    })
    const repeatedRevision = await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${deliveryId}/revise`, headers: auth,
      payload: { actor: 'agent' },
    })
    expect(firstRevision.json().delivery).toMatchObject({
      status: 'draft', parent_report_id: deliveryId, sequence: 2,
    })
    expect(repeatedRevision.json().delivery.id).toBe(firstRevision.json().delivery.id)
    expect(firstRevision.json().delivery.asked).toEqual(launched.delivery.asked)
  })

  it('retries compound submit and verification without mutating or accepting conflicting payloads', async () => {
    const { boardId, cardId, server } = await fixture()
    const launched = await preparedReport(server, boardId, cardId)
    const payload = {
      actor: 'agent',
      summary: 'Implemented the requested delivery API.',
      items: [{ deliverableId: 'deliverable-api', status: 'delivered' }],
      criteria: [{ criterionId: 'criterion-api', outcome: 'unverifiable', note: 'Independent evidence is pending.' }],
    }

    const first = await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${launched.job.id}/deliveries/submit`, headers: auth, payload,
    })
    const retry = await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${launched.job.id}/deliveries/submit`, headers: auth, payload,
    })

    expect(first.statusCode).toBe(200)
    expect(retry.statusCode).toBe(200)
    expect(retry.json().delivery).toMatchObject({ id: first.json().delivery.id, status: 'verified' })

    const changedSummary = await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${launched.job.id}/deliveries/submit`, headers: auth,
      payload: { ...payload, summary: 'A different claimed result.' },
    })
    expect(changedSummary.statusCode).toBe(409)
    expect(changedSummary.json().error).toMatch(/conflicts with the persisted submission/i)

    const changedVerification = await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${launched.job.id}/deliveries/submit`, headers: auth,
      payload: {
        ...payload,
        criteria: [{ criterionId: 'criterion-api', outcome: 'missed', note: 'Changed on retry.' }],
      },
    })
    expect(changedVerification.statusCode).toBe(409)
    expect(changedVerification.json().error).toMatch(/conflicts with the persisted verification/i)

    const persisted = await server.inject({
      method: 'GET', url: `/api/v1/os/cards/${cardId}/deliveries`, headers: auth,
    })
    expect(persisted.json().deliveries).toHaveLength(1)
    expect(persisted.json().current).toMatchObject({
      id: first.json().delivery.id,
      summary: payload.summary,
      criterion_results: [expect.objectContaining({ outcome: 'unverifiable', note: 'Independent evidence is pending.' })],
    })
  })

  it('gates review and approval on the latest managed job even when an older report sorts as current', async () => {
    const { db, boardId, cardId, server } = await fixture()
    const first = await preparedReport(server, boardId, cardId)
    await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${first.job.id}/deliveries/submit`, headers: auth,
      payload: { actor: 'first-agent', summary: 'First attempt.' },
    })
    await server.inject({
      method: 'POST', url: `/api/v1/os/deliveries/${first.delivery.id}/reject`, headers: auth,
      payload: { actor: 'human', reason: 'Run a newer job.' },
    })
    db.prepare(`UPDATE jobs SET status='succeeded', started_at=?, finished_at=? WHERE id=?`)
      .run(new Date().toISOString(), new Date().toISOString(), first.job.id)

    const second = await preparedReport(server, boardId, cardId)
    await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${second.job.id}/deliveries/submit`, headers: auth,
      payload: { actor: 'second-agent', summary: 'Second attempt is ready.' },
    })

    db.prepare("UPDATE delivery_reports SET created_at='2999-01-01T00:00:00.000Z' WHERE id=?").run(first.delivery.id)
    const reports = new DeliveryReportService(db)
    expect(reports.currentForCard(cardId)?.id).toBe(first.delivery.id)
    expect(() => reports.revise(first.delivery.id, { actor: 'first-agent' })).toThrow(/latest managed job/i)

    const review = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/move`, headers: auth, payload: { column: 'review' },
    })
    expect(review.statusCode).toBe(200)
    const approved = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/approve`, headers: auth, payload: { confirm: true },
    })
    expect(approved.statusCode).toBe(200)
    expect(approved.json().card.column).toBe('done')
    expect(reports.get(second.delivery.id).status).toBe('accepted')
    expect(reports.get(first.delivery.id).status).toBe('rejected')
  })

  it('lazily backfills an audited compatibility report for a terminal pre-Trackbook job', async () => {
    const { db, boardId, cardId, server } = await fixture()
    const job = new JobScheduler(db).create({ boardId, cardId, provider: 'historical-agent' })
    db.prepare(`UPDATE jobs SET status='succeeded', started_at=datetime('now'), finished_at=datetime('now')
      WHERE id=?`).run(job.id)
    db.prepare("UPDATE cards SET column_name='review' WHERE id=?").run(cardId)
    expect(new DeliveryReportService(db).currentForCard(cardId)).toBeNull()

    const approved = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/approve`, headers: auth,
      payload: { note: 'Approved historical delivery after upgrade.' },
    })

    expect(approved.statusCode).toBe(200)
    expect(approved.json().card.column).toBe('done')
    expect(new DeliveryReportService(db).currentForCard(cardId)).toMatchObject({
      job_id: job.id,
      created_by: 'compatibility-upgrade',
      status: 'accepted',
      accepted_by: 'human',
    })

    const activeCardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description, column_name)
      VALUES (?, 'Active corruption', 'Must not be auto-backfilled', 'review')`).run(boardId).lastInsertRowid)
    new JobScheduler(db).create({ boardId, cardId: activeCardId, provider: 'active-agent' })
    const blocked = await server.inject({
      method: 'POST', url: `/api/v1/cards/${activeCardId}/approve`, headers: auth,
      payload: {},
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().error).toMatch(/active canonical job is missing/i)
    expect(new DeliveryReportService(db).currentForCard(activeCardId)).toBeNull()
  })

  it('gates managed review/done moves while preserving direct manual-card compatibility', async () => {
    const { db, boardId, cardId, server } = await fixture()
    const manualPatchId = Number(db.prepare("INSERT INTO cards (board_id, title) VALUES (?, 'Manual patch')")
      .run(boardId).lastInsertRowid)
    const manualMoveId = Number(db.prepare("INSERT INTO cards (board_id, title) VALUES (?, 'Manual move')")
      .run(boardId).lastInsertRowid)
    expect((await server.inject({
      method: 'PATCH', url: `/api/v1/cards/${manualPatchId}`, headers: auth, payload: { column: 'done' },
    })).json().card.column).toBe('done')
    expect((await server.inject({
      method: 'POST', url: `/api/v1/cards/${manualMoveId}/move`, headers: auth, payload: { column: 'done' },
    })).json().card.column).toBe('done')

    const launched = await preparedReport(server, boardId, cardId)
    const deliveryId = launched.delivery.id as string
    const prematureReview = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/move`, headers: auth, payload: { column: 'review' },
    })
    expect(prematureReview.statusCode).toBe(409)
    expect(prematureReview.json().error).toMatch(/must be submitted/)
    const prematureDone = await server.inject({
      method: 'PATCH', url: `/api/v1/cards/${cardId}`, headers: auth, payload: { column: 'done' },
    })
    expect(prematureDone.statusCode).toBe(409)
    expect(prematureDone.json().error).toMatch(/accepted/)

    const artifact = (await server.inject({
      method: 'POST', url: `/api/v1/os/cards/${cardId}/evidence`, headers: auth,
      payload: { kind: 'test_report', name: 'gate.txt', content: 'observed pass' },
    })).json().artifact
    const submitted = await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${launched.job.id}/deliveries/submit`, headers: auth,
      payload: {
        actor: 'agent', summary: 'Ready for independent review.',
        items: [{ deliverableId: 'deliverable-api', status: 'delivered' }],
        evidence: { artifacts: [artifact.id] },
      },
    })
    expect(submitted.json().delivery.status).toBe('submitted')
    const review = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/move`, headers: auth, payload: { column: 'review' },
    })
    expect(review.statusCode).toBe(200)
    expect(review.json().card.column).toBe('review')

    const verification = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/verification`, headers: auth,
      payload: {
        verdict: 'pass', tested: true, by: 'legacy-verifier',
        criteria: [{ text: 'The delivery can be reviewed', met: true, evidence: artifact.id }],
      },
    })
    expect(verification.statusCode).toBe(200)
    expect(verification.json().delivery.criterion_results[0]).toMatchObject({ outcome: 'met', override: null })

    const normalApproval = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/approve`, headers: auth, payload: {},
    })
    expect(normalApproval.statusCode).toBe(409)
    expect(normalApproval.json().error).toMatch(/deliverable-api/)
    const confirmed = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/approve`, headers: auth, payload: { confirm: true },
    })
    expect(confirmed.statusCode).toBe(200)
    expect(confirmed.json().card.column).toBe('done')
    const accepted = new DeliveryReportService(db).get(deliveryId)
    expect(accepted.status).toBe('accepted')
    expect(accepted.criterion_results[0]).toMatchObject({ outcome: 'met', override: null })
    expect(accepted.deliverable_results[0]).toMatchObject({
      outcome: 'unverifiable',
      effective_outcome: 'overridden',
      override: { actor: 'human', reason: 'Explicit approval confirmation over failed verification' },
    })
  })

  it('rejects the current canonical delivery when review sends work back', async () => {
    const { db, boardId, cardId, server } = await fixture()
    const launched = await preparedReport(server, boardId, cardId)
    await server.inject({
      method: 'POST', url: `/api/v1/os/jobs/${launched.job.id}/deliveries/submit`, headers: auth,
      payload: { actor: 'agent', summary: 'Submitted for review.' },
    })
    await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/move`, headers: auth, payload: { column: 'review' },
    })

    const sentBack = await server.inject({
      method: 'POST', url: `/api/v1/cards/${cardId}/send-back`, headers: auth,
      payload: { note: 'Add the missing verification evidence.' },
    })

    expect(sentBack.statusCode).toBe(200)
    expect(sentBack.json().card.column).toBe('in_progress')
    expect(new DeliveryReportService(db).get(launched.delivery.id)).toMatchObject({
      status: 'rejected',
      rejected_by: 'human',
      rejection_reason: 'Add the missing verification evidence.',
    })
  })
})
