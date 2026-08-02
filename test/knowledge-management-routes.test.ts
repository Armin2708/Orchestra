import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { knowledgeManagementPlugin } from '../src/agent-os/knowledge-management-routes.js'
import { openDb } from '../src/db.js'

const temporary: string[] = []
afterEach(() => { for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true }) })

describe('Knowledge management route module', () => {
  it('keeps reads available while operator-gating freshness and review mutations', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-kno-routes-'))
    temporary.push(directory)
    const db = openDb(path.join(directory, 'db.sqlite'))
    db.prepare('INSERT INTO boards (id, project_path, name) VALUES (1, ?, ?)').run(directory, 'Routes')
    const app = Fastify()
    await app.register(knowledgeManagementPlugin, { prefix: '/api/v1/os', db, isOperator: () => false })
    expect((await app.inject({ method: 'GET', url: '/api/v1/os/boards/1/knowledge' })).statusCode)
      .toBe(200)
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/os/boards/1/knowledge/refresh', payload: {} })
    expect(refresh.statusCode).toBe(403)
    expect(refresh.json()).toMatchObject({ code: 'forbidden' })
    await app.close(); db.close()
  })

  it('requires an exact operator identity and rejects the generic accepted-answer path', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-kno-promotion-routes-'))
    temporary.push(directory)
    const db = openDb(path.join(directory, 'db.sqlite'))
    db.prepare('INSERT INTO boards (id, project_path, name) VALUES (1, ?, ?)').run(directory, 'Routes')
    const app = Fastify()
    app.decorateRequest('orchestraPrincipal', null)
    app.addHook('onRequest', (request, _reply, done) => {
      const principal = request.headers['x-test-principal']
      request.orchestraPrincipal = Array.isArray(principal) ? principal[0] : principal ?? null
      done()
    })
    await app.register(knowledgeManagementPlugin, {
      prefix: '/api/v1/os',
      db,
      isOperator: (request) => request.headers['x-test-operator'] === 'yes',
    })
    const url = '/api/v1/os/boards/1/knowledge/promotions'
    const deliveryPayload = {
      kind: 'verified_delivery',
      payload: {
        repository_key: 'orchestra',
        base_commit_sha: 'a'.repeat(40),
        observed_at: '2026-08-02T08:00:00.000Z',
        report_id: 'report-1',
        source_commit_sha: 'b'.repeat(40),
      },
      idempotency_key: 'route-promotion',
    }
    const noIdentity = await app.inject({
      method: 'POST', url, headers: { 'x-test-operator': 'yes' }, payload: deliveryPayload,
    })
    expect(noIdentity.statusCode).toBe(403)

    const acceptedAnswer = await app.inject({
      method: 'POST', url,
      headers: { 'x-test-operator': 'yes', 'x-test-principal': 'operator:reviewer' },
      payload: {
        kind: 'accepted_answer',
        payload: { status: 'accepted', content: 'self-asserted arbitrary text' },
        idempotency_key: 'route-accepted-answer',
      },
    })
    expect(acceptedAnswer.statusCode).toBe(400)
    expect(acceptedAnswer.json()).toMatchObject({ code: 'invalid_request' })

    const created = await app.inject({
      method: 'POST', url,
      headers: { 'x-test-operator': 'yes', 'x-test-principal': 'operator:reviewer' },
      payload: deliveryPayload,
    })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json().result).toMatchObject({
      kind: 'verified_delivery',
      requested_by: 'operator:reviewer',
    })
    await app.close(); db.close()
  })
})
