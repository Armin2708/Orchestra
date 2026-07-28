import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { registerAgentOsRoutes } from '../src/agent-os/routes.js'

const servers: FastifyInstance[] = []
const databases: Array<ReturnType<typeof openDb>> = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.close()))
  for (const db of databases.splice(0)) db.close()
})

async function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  const boardId = Number(db.prepare(`
    INSERT INTO boards (project_path, name)
    VALUES ('/command-api', 'command api')
  `).run().lastInsertRowid)
  const cardId = Number(db.prepare(`
    INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Command API', 'Require replay identities')
  `).run(boardId).lastInsertRowid)
  const server = Fastify()
  registerAgentOsRoutes(server, { db })
  servers.push(server)
  await server.ready()
  return { db, boardId, cardId, server }
}

const commandHeader = (key: string) => ({ 'idempotency-key': key })

describe('DOM-013 public command boundary', () => {
  it('requires keys and replays create and launch commands by normalized request', async () => {
    const { boardId, cardId, server } = await fixture()
    const workspaceUrl = `/api/v1/os/boards/${boardId}/workspaces`
    const workspacePayload = {
      name: 'DOM-013 workspace',
      card_id: cardId,
      root_path: '/command-api',
    }
    const missing = await server.inject({
      method: 'POST',
      url: workspaceUrl,
      payload: workspacePayload,
    })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error).toMatch(/Idempotency-Key header is required/)

    const firstWorkspace = await server.inject({
      method: 'POST',
      url: workspaceUrl,
      headers: commandHeader('api-workspace-create-1'),
      payload: workspacePayload,
    })
    const replayWorkspace = await server.inject({
      method: 'POST',
      url: workspaceUrl,
      payload: {
        ...workspacePayload,
        idempotency_key: 'api-workspace-create-1',
      },
    })
    expect(firstWorkspace.statusCode).toBe(201)
    expect(replayWorkspace.json().workspace.id)
      .toBe(firstWorkspace.json().workspace.id)
    const changedWorkspace = await server.inject({
      method: 'POST',
      url: workspaceUrl,
      headers: commandHeader('api-workspace-create-1'),
      payload: { ...workspacePayload, name: 'changed workspace' },
    })
    expect(changedWorkspace.statusCode).toBe(409)

    const workspaceId = firstWorkspace.json().workspace.id as string
    const policy = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/policies`,
      headers: commandHeader('api-policy-create-1'),
      payload: { name: 'DOM-013 policy', file_globs: ['src/**'] },
    })
    expect(policy.statusCode).toBe(201)
    const checkpoint = await server.inject({
      method: 'POST',
      url: `/api/v1/os/workspaces/${workspaceId}/checkpoints`,
      headers: commandHeader('api-checkpoint-create-1'),
      payload: { name: 'DOM-013 checkpoint', git_head: '0123456789abcdef' },
    })
    expect(checkpoint.statusCode).toBe(201)

    const launchPayload = {
      card_id: cardId,
      workspace_id: workspaceId,
      provider: 'future-provider',
    }
    const launchUrl = `/api/v1/os/boards/${boardId}/jobs`
    const launched = await server.inject({
      method: 'POST',
      url: launchUrl,
      headers: commandHeader('api-card-launch-1'),
      payload: launchPayload,
    })
    const replayedLaunch = await server.inject({
      method: 'POST',
      url: launchUrl,
      payload: {
        ...launchPayload,
        idempotency_key: 'api-card-launch-1',
      },
    })
    expect(launched.statusCode).toBe(201)
    expect(replayedLaunch.json().job.id).toBe(launched.json().job.id)
    const changedLaunch = await server.inject({
      method: 'POST',
      url: launchUrl,
      headers: commandHeader('api-card-launch-1'),
      payload: { ...launchPayload, provider: 'changed-provider' },
    })
    expect(changedLaunch.statusCode).toBe(409)
  })

  it('requires and replays submit, accept, and cancel command keys', async () => {
    const { db, boardId, cardId, server } = await fixture()
    const launch = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/jobs`,
      headers: commandHeader('api-delivery-launch-1'),
      payload: { card_id: cardId, provider: 'future-provider' },
    })
    expect(launch.statusCode).toBe(201)
    const jobId = launch.json().job.id as string
    const delivery = launch.json().delivery
    const deliveryId = delivery.id as string
    const deliverableId = delivery.asked.deliverables[0].id as string
    const submitUrl = `/api/v1/os/jobs/${jobId}/deliveries/submit`
    const submitPayload = {
      actor: 'agent',
      summary: 'DOM-013 delivery is complete.',
      delivered_items: [{
        deliverableId,
        status: 'delivered',
      }],
    }
    expect((await server.inject({
      method: 'POST',
      url: submitUrl,
      payload: submitPayload,
    })).statusCode).toBe(400)
    const submitted = await server.inject({
      method: 'POST',
      url: submitUrl,
      headers: commandHeader('api-delivery-submit-1'),
      payload: submitPayload,
    })
    const replayedSubmit = await server.inject({
      method: 'POST',
      url: submitUrl,
      headers: commandHeader('api-delivery-submit-1'),
      payload: submitPayload,
    })
    expect(submitted.statusCode).toBe(200)
    expect(replayedSubmit.json().delivery.id).toBe(deliveryId)
    expect((await server.inject({
      method: 'POST',
      url: submitUrl,
      headers: commandHeader('api-delivery-submit-1'),
      payload: { ...submitPayload, summary: 'Changed delivery claim.' },
    })).statusCode).toBe(409)
    expect((await server.inject({
      method: 'POST',
      url: submitUrl,
      headers: commandHeader('api-delivery-submit-1'),
      payload: { ...submitPayload, criteria: [] },
    })).statusCode).toBe(409)

    const evidence = JSON.stringify([{
      kind: 'other',
      ref: 'dom-013-api',
      label: 'DOM-013 API evidence',
    }])
    db.prepare(`
      UPDATE delivery_deliverable_results
      SET outcome='met', evidence_refs=?
      WHERE report_id=?
    `).run(evidence, deliveryId)
    db.prepare(`
      UPDATE delivery_criterion_results
      SET outcome='met', evidence_refs=?
      WHERE report_id=?
    `).run(evidence, deliveryId)
    db.prepare(`
      UPDATE delivery_reports
      SET status='verified', verified_by='verifier',
        verified_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(deliveryId)

    const acceptUrl = `/api/v1/os/deliveries/${deliveryId}/accept`
    expect((await server.inject({
      method: 'POST',
      url: acceptUrl,
      payload: { note: 'Evidence checked.' },
    })).statusCode).toBe(400)
    const accepted = await server.inject({
      method: 'POST',
      url: acceptUrl,
      headers: commandHeader('api-delivery-accept-1'),
      payload: { note: 'Evidence checked.' },
    })
    const replayedAccept = await server.inject({
      method: 'POST',
      url: acceptUrl,
      headers: commandHeader('api-delivery-accept-1'),
      payload: { note: 'Evidence checked.' },
    })
    expect(accepted.statusCode).toBe(200)
    expect(replayedAccept.json().delivery.status).toBe('accepted')
    expect((await server.inject({
      method: 'POST',
      url: acceptUrl,
      headers: commandHeader('api-delivery-accept-1'),
      payload: { note: 'Changed approval.' },
    })).statusCode).toBe(409)

    const cardless = await server.inject({
      method: 'POST',
      url: `/api/v1/os/boards/${boardId}/jobs`,
      headers: commandHeader('api-cardless-launch-1'),
      payload: { provider: 'future-provider' },
    })
    const cardlessId = cardless.json().job.id as string
    const cancelUrl = `/api/v1/os/jobs/${cardlessId}/cancel`
    expect((await server.inject({
      method: 'POST',
      url: cancelUrl,
    })).statusCode).toBe(400)
    const cancelled = await server.inject({
      method: 'POST',
      url: cancelUrl,
      headers: commandHeader('api-job-cancel-1'),
    })
    const replayedCancel = await server.inject({
      method: 'POST',
      url: cancelUrl,
      payload: { idempotency_key: 'api-job-cancel-1' },
    })
    expect(cancelled.statusCode).toBe(200)
    expect(replayedCancel.json().job.id).toBe(cardlessId)
  })
})
