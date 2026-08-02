import { describe, expect, it, vi } from 'vitest'
import { runLifecycleDemo } from '../src/lifecycle-demo.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

describe('real lifecycle demo', () => {
  it('creates and publishes real lifecycle objects without launching by default', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ id: 9 })
      .mockResolvedValueOnce({ card: { id: 41 } })
      .mockResolvedValueOnce({ contract: {}, job_market: { market_version: 2 } })
      .mockResolvedValueOnce({ contract: { version: 3 }, job_market: { market_version: 3 } })
      .mockResolvedValueOnce({ contract: { status: 'open' } })

    const result = await runLifecycleDemo(api, {
      project_root: '/workspace/demo',
      provider: 'codex',
    })

    expect(result).toMatchObject({
      board_id: 9,
      card_id: 41,
      contract_version: 3,
      job_id: null,
      state: 'contract_published',
    })
    expect(api).toHaveBeenCalledTimes(5)
    expect(api).toHaveBeenNthCalledWith(4, 'PUT', '/os/cards/41/contract', expect.objectContaining({
      deliverables: [expect.objectContaining({ id: 'demo-report', text: 'Lifecycle demo report' })],
      acceptance_criteria: [expect.objectContaining({
        id: 'demo-evidence',
        deliverable_ids: ['demo-report'],
      })],
      provider_constraints: ['codex'],
      access_needs: ['read_only'],
      expected_market_version: 2,
    }))
    expect(api).toHaveBeenNthCalledWith(5, 'POST', '/os/cards/41/contract/publish', {
      actor: 'human',
      expected_market_version: 3,
    })
  })

  it('creates one idempotent job only after explicit launch', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ id: 9 })
      .mockResolvedValueOnce({ card: { id: 41 } })
      .mockResolvedValueOnce({ contract: {}, job_market: { market_version: 2 } })
      .mockResolvedValueOnce({ contract: { version: 3 }, job_market: { market_version: 3 } })
      .mockResolvedValueOnce({ contract: { status: 'open' } })
      .mockResolvedValueOnce({ job: { id: 'job/demo' } })

    const result = await runLifecycleDemo(api, {
      project_root: '/workspace/demo',
      provider: 'codex',
      launch: true,
      idempotency_prefix: 'demo-test',
    })

    expect(result).toMatchObject({ state: 'job_created', job_id: 'job/demo' })
    expect(api).toHaveBeenLastCalledWith('POST', '/os/boards/9/jobs', {
      card_id: 41,
      provider: 'codex',
      max_attempts: 1,
      budget_tokens: 8_000,
      idempotency_key: 'demo-test:job:9:41',
    })
  })

  it('runs the safe sample against the real HTTP and database contracts', async () => {
    const db = openDb(':memory:')
    const server = buildServer(db)
    await server.ready()
    const api = async (method: string, route: string, body?: unknown) => {
      const response = await server.inject({
        method,
        url: `/api/v1${route}`,
        payload: body,
      })
      if (response.statusCode >= 400) {
        throw new Error(`${method} ${route} -> ${response.statusCode}: ${response.body}`)
      }
      return response.json()
    }
    try {
      const result = await runLifecycleDemo(api, {
        project_root: '/workspace/real-demo',
        provider: 'codex',
      })
      expect(result).toMatchObject({
        board_id: 1,
        card_id: 1,
        contract_version: 2,
        state: 'contract_published',
        job_id: null,
      })
      expect(db.prepare('SELECT status FROM job_market_contracts WHERE card_id=1').get())
        .toEqual({ status: 'open' })
      expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get())
        .toEqual({ count: 0 })
    } finally {
      await server.close()
      db.close()
    }
  })
})
