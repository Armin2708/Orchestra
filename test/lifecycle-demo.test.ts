import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createLifecycleDemoLaunchAuthorizer,
  runLifecycleDemo,
} from '../src/lifecycle-demo.js'
import { openDb } from '../src/db.js'
import { buildServer } from '../src/server.js'

describe('real lifecycle demo', () => {
  const project = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-lifecycle-demo-'))
    fs.writeFileSync(path.join(root, 'README.md'), '# Safe demo scope\n')
    return root
  }

  const launchAttestation = (provider: 'claude' | 'codex' = 'codex') => ({
    schema_version: 1 as const,
    provider_id: provider,
    doctor: { ready: true as const, checked_at: '2026-08-02T09:00:00.000Z' },
    acceptance: {
      accepted: true as const,
      runtime_mode: 'native_cli' as const,
      billing_mode: 'personal_subscription' as const,
      source_commit: 'a'.repeat(40),
      matrix_sha256: 'b'.repeat(64),
      executable_version: '0.144.6',
      platform: 'darwin-arm64',
    },
  })

  it('creates and publishes real lifecycle objects without launching by default', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ id: 9 })
      .mockResolvedValueOnce({ cards: [] })
      .mockResolvedValueOnce({ card: { id: 41 } })
      .mockResolvedValueOnce({ contract: {}, job_market: { market_version: 2 } })
      .mockResolvedValueOnce({ contract: { version: 3 }, job_market: { market_version: 3 } })
      .mockResolvedValueOnce({ contract: { status: 'open' } })

    const result = await runLifecycleDemo(api, {
      project_root: project(),
      provider: 'codex',
    })

    expect(result).toMatchObject({
      board_id: 9,
      card_id: 41,
      contract_version: 3,
      job_id: null,
      state: 'contract_published',
    })
    expect(api).toHaveBeenCalledTimes(6)
    expect(api).toHaveBeenNthCalledWith(5, 'PUT', '/os/cards/41/contract', expect.objectContaining({
      deliverables: [expect.objectContaining({ id: 'demo-report', text: 'Lifecycle demo report' })],
      acceptance_criteria: [expect.objectContaining({
        id: 'demo-evidence',
        deliverable_ids: ['demo-report'],
      })],
      provider_constraints: ['codex'],
      access_needs: ['read_only'],
      expected_market_version: 2,
    }))
    expect(api).toHaveBeenNthCalledWith(6, 'POST', '/os/cards/41/contract/publish', {
      actor: 'human',
      expected_market_version: 3,
    })
  })

  it('creates one idempotent job only after explicit launch', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ id: 9 })
      .mockResolvedValueOnce({ cards: [] })
      .mockResolvedValueOnce({ card: { id: 41 } })
      .mockResolvedValueOnce({ contract: {}, job_market: { market_version: 2 } })
      .mockResolvedValueOnce({ contract: { version: 3 }, job_market: { market_version: 3 } })
      .mockResolvedValueOnce({ contract: { status: 'open' } })
      .mockResolvedValueOnce({ jobs: [] })
      .mockResolvedValueOnce({ job: { id: 'job/demo' } })

    const result = await runLifecycleDemo(api, {
      project_root: project(),
      provider: 'codex',
      launch: true,
      idempotency_prefix: 'demo-test',
    }, {
      authorizeLaunch: async () => launchAttestation(),
      nowMs: () => Date.parse('2026-08-02T09:01:00.000Z'),
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

  it('refuses candidate launch before making any API request', async () => {
    const api = vi.fn()
    await expect(runLifecycleDemo(api, {
      project_root: project(),
      provider: 'codex',
      launch: true,
    })).rejects.toThrow('launch gate is not registered')
    expect(api).not.toHaveBeenCalled()

    await expect(runLifecycleDemo(api, {
      project_root: project(),
      provider: 'codex',
      launch: true,
    }, {
      authorizeLaunch: async () => launchAttestation('claude'),
      nowMs: () => Date.parse('2026-08-02T09:01:00.000Z'),
    })).rejects.toThrow('lacks exact doctor and provider-acceptance evidence')
    expect(api).not.toHaveBeenCalled()
  })

  it('builds launch authorization only from a ready doctor and exact acceptance reader', async () => {
    const requireExactAcceptance = vi.fn(async () => launchAttestation().acceptance)
    const blocked = createLifecycleDemoLaunchAuthorizer({
      runDoctor: () => ({
        mode: 'readiness', provider: 'codex', ready: false,
        checked_at: '2026-08-02T09:00:00.000Z',
      }),
      requireExactAcceptance,
    })
    await expect(blocked('codex', project())).rejects.toThrow('requires a current ready provider doctor')
    expect(requireExactAcceptance).not.toHaveBeenCalled()

    const ready = createLifecycleDemoLaunchAuthorizer({
      runDoctor: () => ({
        mode: 'readiness', provider: 'codex', ready: true,
        checked_at: '2026-08-02T09:00:00.000Z',
      }),
      requireExactAcceptance,
    })
    await expect(ready('codex', project())).resolves.toMatchObject({
      provider_id: 'codex', doctor: { ready: true }, acceptance: { accepted: true },
    })
    expect(requireExactAcceptance).toHaveBeenCalledOnce()
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
      const root = project()
      const result = await runLifecycleDemo(api, {
        project_root: root,
        provider: 'codex',
      })
      expect(result).toMatchObject({
        board_id: 1,
        card_id: 1,
        contract_version: 1,
        state: 'contract_published',
        job_id: null,
      })
      expect(db.prepare('SELECT status FROM job_market_contracts WHERE card_id=1').get())
        .toEqual({ status: 'open' })
      expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get())
        .toEqual({ count: 0 })

      const repeated = await runLifecycleDemo(api, {
        project_root: root,
        provider: 'codex',
      })
      expect(repeated.card_id).toBe(result.card_id)
      expect(db.prepare('SELECT COUNT(*) AS count FROM cards').get())
        .toEqual({ count: 1 })
    } finally {
      await server.close()
      db.close()
    }
  })
})
