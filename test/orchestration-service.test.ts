import { describe, expect, it } from 'vitest'
import { writeAgentDefaults } from '../src/agent-defaults.js'
import { openDb } from '../src/db.js'
import { OrchestrationService } from '../src/agent-os/orchestration-service.js'
import { JobScheduler, type JobExecutor } from '../src/agent-os/scheduler.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'

function fixture(executor?: JobExecutor) {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/repo', 'repo')").run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description)
    VALUES (?, 'Canonical launch', 'Use the Agent OS lifecycle')`).run(boardId).lastInsertRowid)
  const scheduler = new JobScheduler(db, executor)
  const workspaceStore = new WorkspaceStore(db)
  const provisioner = {
    materialize: async (workspace: ReturnType<WorkspaceStore['create']>) =>
      workspaceStore.update(workspace.id, { status: 'active' }),
  }
  return { db, boardId, cardId, scheduler,
    orchestration: new OrchestrationService(db, scheduler, provisioner) }
}

describe('OrchestrationService', () => {
  it('atomically creates a contract-backed card job using canonical defaults', () => {
    const { db, boardId, cardId, orchestration } = fixture()
    writeAgentDefaults(db, {
      worker: { provider: 'codex', model: 'gpt-5.4', effort: null },
      specialist: { provider: 'claude', model: null, effort: null },
    })
    const workspace = new WorkspaceStore(db).create({ boardId, cardId, name: 'card workspace', rootPath: '/repo' })
    new TaskContractService(db).put(cardId, {
      workspace_id: workspace.id,
      priority: 8,
      budget_tokens: 12_000,
      budget_cents: 250,
    })

    const created = orchestration.createCardJob({ cardId, accessProfile: 'read_only' })

    expect(created.contract).toMatchObject({ card_id: cardId, workspace_id: workspace.id, priority: 8 })
    expect(created.delivery).toMatchObject({
      card_id: cardId,
      job_id: created.job.id,
      status: 'draft',
      asked: { objective: 'Use the Agent OS lifecycle', contract_version: created.contract.version },
    })
    expect(created.job).toMatchObject({
      board_id: boardId,
      card_id: cardId,
      workspace_id: workspace.id,
      provider: 'codex',
      driver_id: 'codex',
      model: 'gpt-5.4',
      effort: null,
      access_profile: 'read_only',
      priority: 8,
      budget_tokens: 12_000,
      budget_cents: 250,
      status: 'queued',
    })
    expect(created.workspace?.id).toBe(workspace.id)
    expect(created.session).toMatchObject({
      workspace_id: workspace.id,
      provider: 'codex',
      model: 'gpt-5.4',
      status: 'reserved',
      context: { job_id: created.job.id, access_profile: 'read_only' },
    })
    expect(db.prepare('SELECT job_id, workspace_id, status, isolation_mode FROM workspace_assignments').get())
      .toEqual({ job_id: created.job.id, workspace_id: workspace.id, status: 'reserved', isolation_mode: 'explicit_shared' })
    expect(created.delivery).toMatchObject({ workspace_id: workspace.id, session_id: created.session?.id })
  })

  it('rolls back an implicit contract when job validation fails', () => {
    const { db, cardId, orchestration } = fixture()

    expect(() => orchestration.createCardJob({ cardId, provider: '   ' })).toThrow(/provider is required/)
    expect(db.prepare('SELECT 1 FROM task_contracts WHERE card_id=?').get(cardId)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM delivery_reports').get()).toEqual({ count: 0 })
  })

  it('durably preserves explicit provider launch controls', () => {
    const { db, cardId, orchestration } = fixture()

    const created = orchestration.createCardJob({
      cardId,
      provider: 'codex',
      model: 'gpt-5.4-mini',
      effort: 'high',
      accessProfile: 'full_access',
    })

    expect(created.job).toMatchObject({
      provider: 'codex', driver_id: 'codex', model: 'gpt-5.4-mini', effort: 'high',
      access_profile: 'full_access', contract_version: created.contract.version,
    })
    expect(created.session?.context).toMatchObject({
      driver_id: 'codex', effort: 'high', access_profile: 'full_access',
    })
    expect(() => orchestration.createCardJob({
      cardId, provider: 'claude', effort: 'turbo',
    })).toThrow(/Claude effort must be one of/)
  })

  it('freezes matching provider defaults into the durable launch profile', () => {
    const { db, cardId, orchestration } = fixture()
    writeAgentDefaults(db, {
      worker: { provider: 'codex', model: 'gpt-5.4', effort: 'high' },
      specialist: { provider: 'claude', model: null, effort: null },
    })

    const created = orchestration.createCardJob({ cardId })
    expect(created.job).toMatchObject({ provider: 'codex', driver_id: 'codex', model: 'gpt-5.4', effort: 'high' })
  })

  it('does not apply a configured model to an explicitly different provider', () => {
    const { db, cardId, orchestration } = fixture()
    writeAgentDefaults(db, {
      worker: { provider: 'codex', model: 'gpt-5.4', effort: null },
      specialist: { provider: 'claude', model: null, effort: null },
    })

    const created = orchestration.createCardJob({ cardId, provider: 'claude' })

    expect(created.job).toMatchObject({ provider: 'claude', model: null })
  })

  it('uses the scheduler uniqueness invariant to reject duplicate active card jobs', () => {
    const { db, cardId, orchestration } = fixture()

    const first = orchestration.createCardJob({ cardId, provider: 'claude' })
    expect(() => orchestration.createCardJob({ cardId, provider: 'claude' })).toThrow(/active job/)

    expect(first.job.status).toBe('queued')
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_contracts WHERE card_id=?').get(cardId)).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE card_id=?').get(cardId)).toEqual({ count: 1 })
  })

  it('replays the same idempotent request and rejects key reuse with a different fingerprint', () => {
    const { db, cardId, orchestration } = fixture()

    const first = orchestration.createCardJob({ cardId, provider: 'codex', effort: 'high', idempotencyKey: 'launch-1' })
    const replay = orchestration.createCardJob({ cardId, provider: 'codex', effort: 'high', idempotencyKey: 'launch-1' })

    expect(replay.job.id).toBe(first.job.id)
    expect(replay.session?.id).toBe(first.session?.id)
    expect(replay.workspace?.id).toBe(first.workspace?.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_assignments').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get()).toEqual({ count: 1 })
    expect(() => orchestration.createCardJob({
      cardId, provider: 'codex', effort: 'low', idempotencyKey: 'launch-1',
    })).toThrow(/different launch request/)
  })

  it('rolls back every canonical reservation when preflight validation fails', () => {
    const { db, cardId, orchestration } = fixture()

    expect(() => orchestration.createCardJob({ cardId, budgetTokens: 0 })).toThrow(/positive integer/)
    for (const table of ['task_contracts', 'jobs', 'workspaces', 'workspace_assignments', 'agent_sessions',
      'delivery_reports', 'os_events']) {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, table).toBe(0)
    }
  })

  it('rolls back the complete launch graph when a late reservation write fails', () => {
    const { db, cardId, orchestration } = fixture()
    db.exec(`CREATE TRIGGER reject_reserved_session BEFORE INSERT ON agent_sessions
      BEGIN SELECT RAISE(ABORT, 'session reservation rejected'); END`)

    expect(() => orchestration.createCardJob({ cardId, provider: 'codex' }))
      .toThrow(/session reservation rejected/)
    for (const table of ['task_contracts', 'jobs', 'workspaces', 'workspace_assignments', 'agent_sessions',
      'delivery_reports', 'os_events']) {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, table).toBe(0)
    }
  })

  it('requires explicit shared workspaces to remain read-only', () => {
    const { db, boardId, cardId, scheduler } = fixture()
    const workspace = new WorkspaceStore(db).create({ boardId, name: 'shared', rootPath: '/repo' })
    const orchestration = new OrchestrationService(db, scheduler, { materialize: async (item) => item })

    expect(() => orchestration.createCardJob({
      cardId, workspaceId: workspace.id, accessProfile: 'workspace_write',
    })).toThrow(/isolated worktree/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })

    const readOnly = orchestration.createCardJob({ cardId, workspaceId: workspace.id, accessProfile: 'read_only' })
    expect(readOnly.job).toMatchObject({ workspace_id: workspace.id, access_profile: 'read_only' })
  })

  it('compensates a post-commit worktree provisioning failure into durable failed records', async () => {
    const { db, cardId, scheduler } = fixture()
    const orchestration = new OrchestrationService(db, scheduler, {
      materialize: async () => { throw new Error('git worktree refused the branch') },
    })

    const launched = await orchestration.launchCard({ cardId, provider: 'codex', idempotencyKey: 'provision-1' })

    expect(launched.job).toMatchObject({ status: 'blocked', error: expect.stringMatching(/worktree refused/) })
    expect(launched.workspace?.status).toBe('failed')
    expect(launched.session?.status).toBe('failed')
    expect(db.prepare('SELECT status FROM workspace_assignments WHERE job_id=?').get(launched.job.id))
      .toEqual({ status: 'failed' })
    const events = db.prepare(`SELECT kind, correlation_id, causation_id FROM os_events
      WHERE job_id=? ORDER BY rowid`).all(launched.job.id) as Array<Record<string, unknown>>
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'job.queued', 'workspace.assignment_reserved', 'agent_session.reserved',
      'workspace.provisioning_failed', 'workspace.assignment_failed', 'agent_session.failed', 'job.blocked',
    ]))
    expect(events.every((event) => event.correlation_id)).toBe(true)
    expect(events.slice(1).every((event) => event.causation_id)).toBe(true)
  })

  it('dispatches through the existing scheduler and returns durable workspace and session links', async () => {
    let db: ReturnType<typeof openDb>
    const executor: JobExecutor = {
      supportedProviders: () => ['codex'],
      execute: async (job) => {
        const reserved = db.prepare(`SELECT id, context_json FROM agent_sessions
          WHERE json_extract(context_json, '$.job_id')=?`).get(job.id) as { id: string; context_json: string }
        db.prepare(`UPDATE agent_sessions SET external_id='thread-1', provider=?, model=?, status='running',
          context_json=?, updated_at=datetime('now') WHERE id=?`).run(
          job.provider,
          job.model,
          JSON.stringify({ ...JSON.parse(reserved.context_json), source: 'test-runtime' }),
          reserved.id,
        )
        return { status: 'running' }
      },
    }
    const setup = fixture(executor)
    db = setup.db

    const launched = await setup.orchestration.launchCard({
      cardId: setup.cardId,
      provider: 'codex',
      model: 'gpt-5.4-mini',
    })

    expect(launched.dispatch.started).toEqual([launched.job.id])
    expect(launched.dispatch_error).toBeNull()
    expect(launched.job).toMatchObject({ status: 'running', workspace_id: launched.workspace?.id })
    expect(launched.workspace).toMatchObject({ card_id: setup.cardId, kind: 'worktree' })
    expect(launched.session).toMatchObject({
      id: launched.session?.id,
      workspace_id: launched.workspace?.id,
      provider: 'codex',
      model: 'gpt-5.4-mini',
      status: 'running',
      context: { job_id: launched.job.id, source: 'test-runtime' },
    })
  })

  it('serializes every active assignment that shares the same explicit workspace', async () => {
    const executed: string[] = []
    const executor: JobExecutor = {
      supportedProviders: () => ['codex'],
      execute: async (job) => { executed.push(job.id); return { status: 'running' } },
    }
    const setup = fixture(executor)
    const secondCardId = Number(setup.db.prepare(`INSERT INTO cards (board_id, title, description)
      VALUES (?, 'Second launch', 'Wait for the shared workspace')`).run(setup.boardId).lastInsertRowid)
    const workspace = new WorkspaceStore(setup.db).create({
      boardId: setup.boardId,
      name: 'explicit worktree',
      kind: 'worktree',
      rootPath: '/repo',
      worktreePath: '/repo-workspaces/explicit',
      branch: 'orchestra/explicit',
    })

    const first = await setup.orchestration.launchCard({
      cardId: setup.cardId, provider: 'codex', workspaceId: workspace.id,
    })
    const second = await setup.orchestration.launchCard({
      cardId: secondCardId, provider: 'codex', workspaceId: workspace.id,
    })

    expect(executed).toEqual([first.job.id])
    expect(second.dispatch.deferred).toEqual([second.job.id])
    expect(second.job.status).toBe('queued')
    expect(setup.db.prepare(`SELECT job_id, status FROM workspace_assignments
      WHERE workspace_id=? ORDER BY created_at, rowid`).all(workspace.id)).toEqual([
      { job_id: first.job.id, status: 'active' },
      { job_id: second.job.id, status: 'reserved' },
    ])
  })

  it('re-reserves a failed provider session before retrying the same durable job', async () => {
    let db: ReturnType<typeof openDb>
    let attempts = 0
    const executor: JobExecutor = {
      supportedProviders: () => ['codex'],
      execute: async (job) => {
        attempts += 1
        if (attempts === 1) {
          db.prepare(`UPDATE agent_sessions SET status='failed'
            WHERE json_extract(context_json, '$.job_id')=?`).run(job.id)
          throw new Error('provider launch failed')
        }
        return { status: 'running' }
      },
    }
    const setup = fixture(executor)
    db = setup.db

    const firstAttempt = await setup.orchestration.launchCard({
      cardId: setup.cardId, provider: 'codex', maxAttempts: 2,
    })

    expect(firstAttempt.job).toMatchObject({ status: 'queued', attempts: 1 })
    expect(firstAttempt.session?.status).toBe('reserved')
    expect(setup.db.prepare('SELECT status FROM workspace_assignments WHERE job_id=?').get(firstAttempt.job.id))
      .toEqual({ status: 'reserved' })

    const retried = await setup.scheduler.tick()
    expect(retried.started).toEqual([firstAttempt.job.id])
    expect(setup.scheduler.get(firstAttempt.job.id)).toMatchObject({ status: 'running', attempts: 2 })
    expect(setup.orchestration.getJobSnapshot(firstAttempt.job.id).session?.status).toBe('starting')
  })

  it('rejects dependency-blocked work before reserving a job or session', async () => {
    const executed: string[] = []
    const executor: JobExecutor = {
      supportedProviders: () => ['claude'],
      execute: async (job) => { executed.push(job.id); return { status: 'running' } },
    }
    const { db, boardId, cardId, orchestration } = fixture(executor)
    const dependencyId = Number(db.prepare("INSERT INTO cards (board_id, title) VALUES (?, 'Dependency')")
      .run(boardId).lastInsertRowid)
    new TaskContractService(db).put(cardId, { dependencies: [dependencyId] })

    await expect(orchestration.launchCard({ cardId, provider: 'claude' }))
      .rejects.toThrow(/dependency .* is not complete/)
    expect(executed).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM agent_sessions').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_assignments').get()).toEqual({ count: 0 })
  })

  it('validates board scope and launchable card state before contract or job writes', () => {
    const { db, boardId, cardId, orchestration } = fixture()
    const otherBoardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/other', 'other')")
      .run().lastInsertRowid)

    expect(() => orchestration.createCardJob({ cardId, expectedBoardId: otherBoardId })).toThrow(/different board/)
    db.prepare("UPDATE cards SET column_name='done' WHERE id=?").run(cardId)
    expect(() => orchestration.createCardJob({ cardId, expectedBoardId: boardId, requireLaunchable: true }))
      .toThrow(/already done/)
    db.prepare("UPDATE cards SET column_name='backlog' WHERE id=?").run(cardId)
    const ownerId = Number(db.prepare("INSERT INTO agents (board_id, name) VALUES (?, 'busy-agent')")
      .run(boardId).lastInsertRowid)
    db.prepare('UPDATE cards SET owner_agent_id=? WHERE id=?').run(ownerId, cardId)
    expect(() => orchestration.createCardJob({ cardId, expectedBoardId: boardId, requireLaunchable: true }))
      .toThrow(/already assigned/)

    expect(db.prepare('SELECT 1 FROM task_contracts WHERE card_id=?').get(cardId)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })
  })

  it('returns a committed queued job when the post-commit scheduler kick fails', async () => {
    const setup = fixture()
    setup.scheduler.tick = async () => { throw new Error('scheduler kick failed') }

    const launched = await setup.orchestration.launchCard({ cardId: setup.cardId, provider: 'claude' })

    expect(launched.job.status).toBe('queued')
    expect(launched.dispatch).toEqual({ started: [], completed: [], blocked: [], deferred: [] })
    expect(launched.dispatch_error).toBe('scheduler kick failed')
    expect(setup.scheduler.get(launched.job.id)?.status).toBe('queued')
    expect(setup.db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE card_id=?').get(setup.cardId)).toEqual({ count: 1 })
    expect(launched.workspace?.status).toBe('active')
    expect(launched.session?.status).toBe('reserved')
  })

  it('filters global scheduler results to the requested job', async () => {
    const setup = fixture()
    setup.scheduler.tick = async () => {
      const jobId = setup.scheduler.listBoard(setup.boardId)[0]!.id
      return {
        started: [jobId, 'other-started'],
        completed: ['other-completed'],
        blocked: [jobId, 'other-blocked'],
        deferred: ['other-deferred'],
      }
    }

    const launched = await setup.orchestration.launchCard({ cardId: setup.cardId, provider: 'claude' })

    expect(launched.dispatch).toEqual({
      started: [launched.job.id],
      completed: [],
      blocked: [launched.job.id],
      deferred: [],
    })
    expect(launched.dispatch_error).toBeNull()
  })

  it('ignores malformed legacy session context while building a snapshot', () => {
    const { db, boardId, cardId, orchestration } = fixture()
    const workspace = new WorkspaceStore(db).create({ boardId, name: 'legacy', rootPath: '/repo' })
    db.prepare(`INSERT INTO agent_sessions
      (id, workspace_id, provider, status, context_json, created_at, updated_at)
      VALUES ('legacy-session', ?, 'claude', 'stopped', 'not-json', datetime('now'), datetime('now'))`).run(workspace.id)

    const created = orchestration.createCardJob({ cardId, provider: 'claude' })

    expect(created.job.status).toBe('queued')
    expect(created.session).toMatchObject({ status: 'reserved', context: { job_id: created.job.id } })
  })

  it('rejects invalid and missing card identifiers without creating jobs', () => {
    const { db, orchestration } = fixture()

    expect(() => orchestration.createCardJob({ cardId: 0 })).toThrow(/positive integer/)
    expect(() => orchestration.createCardJob({ cardId: 1, expectedBoardId: 0 })).toThrow(/expectedBoardId/)
    expect(() => orchestration.createCardJob({ cardId: 999 })).toThrow(/card not found/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })
  })
})
