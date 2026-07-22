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
  return { db, boardId, cardId, scheduler, orchestration: new OrchestrationService(db, scheduler) }
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

    const created = orchestration.createCardJob({ cardId })

    expect(created.contract).toMatchObject({ card_id: cardId, workspace_id: workspace.id, priority: 8 })
    expect(created.job).toMatchObject({
      board_id: boardId,
      card_id: cardId,
      workspace_id: workspace.id,
      provider: 'codex',
      model: 'gpt-5.4',
      priority: 8,
      budget_tokens: 12_000,
      budget_cents: 250,
      status: 'queued',
    })
    expect(created.workspace?.id).toBe(workspace.id)
    expect(created.session).toBeNull()
  })

  it('rolls back an implicit contract when job validation fails', () => {
    const { db, cardId, orchestration } = fixture()

    expect(() => orchestration.createCardJob({ cardId, provider: '   ' })).toThrow(/provider is required/)
    expect(db.prepare('SELECT 1 FROM task_contracts WHERE card_id=?').get(cardId)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })
  })

  it('rejects launch controls that the durable job model cannot preserve', () => {
    const { db, cardId, orchestration } = fixture()

    expect(() => orchestration.createCardJob({ cardId, effort: 'high' })).toThrow(/do not persist effort/)
    expect(() => orchestration.createCardJob({ cardId, accessProfile: 'full_access' })).toThrow(/accessProfile/)
    expect(db.prepare('SELECT 1 FROM task_contracts WHERE card_id=?').get(cardId)).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })
  })

  it('rejects a matching provider default effort unless the caller explicitly opts out', () => {
    const { db, cardId, orchestration } = fixture()
    writeAgentDefaults(db, {
      worker: { provider: 'codex', model: 'gpt-5.4', effort: 'high' },
      specialist: { provider: 'claude', model: null, effort: null },
    })

    expect(() => orchestration.createCardJob({ cardId })).toThrow(/do not persist effort/)
    expect(db.prepare('SELECT 1 FROM task_contracts WHERE card_id=?').get(cardId)).toBeUndefined()

    const created = orchestration.createCardJob({ cardId, effort: null })
    expect(created.job).toMatchObject({ provider: 'codex', model: 'gpt-5.4' })
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

  it('dispatches through the existing scheduler and returns durable workspace and session links', async () => {
    let db: ReturnType<typeof openDb>
    const executor: JobExecutor = {
      supportedProviders: () => ['codex'],
      execute: async (job) => {
        const workspace = new WorkspaceStore(db).create({
          boardId: job.board_id,
          cardId: job.card_id,
          name: 'runtime workspace',
          kind: 'worktree',
          rootPath: '/repo',
          worktreePath: '/repo-card',
        })
        db.prepare('UPDATE jobs SET workspace_id=? WHERE id=?').run(workspace.id, job.id)
        db.prepare(`INSERT INTO agent_sessions
          (id, workspace_id, agent_id, provider, external_id, model, status, context_json, created_at, updated_at)
          VALUES ('session-1', ?, NULL, ?, 'thread-1', ?, 'running', ?, datetime('now'), datetime('now'))`).run(
          workspace.id,
          job.provider,
          job.model,
          JSON.stringify({ job_id: job.id, source: 'test-runtime' }),
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
      id: 'session-1',
      workspace_id: launched.workspace?.id,
      provider: 'codex',
      model: 'gpt-5.4-mini',
      status: 'running',
      context: { job_id: launched.job.id, source: 'test-runtime' },
    })
  })

  it('keeps dependency-blocked work queued instead of claiming it launched', async () => {
    const executed: string[] = []
    const executor: JobExecutor = {
      supportedProviders: () => ['claude'],
      execute: async (job) => { executed.push(job.id); return { status: 'running' } },
    }
    const { db, boardId, cardId, orchestration } = fixture(executor)
    const dependencyId = Number(db.prepare("INSERT INTO cards (board_id, title) VALUES (?, 'Dependency')")
      .run(boardId).lastInsertRowid)
    new TaskContractService(db).put(cardId, { dependencies: [dependencyId] })

    const launched = await orchestration.launchCard({ cardId, provider: 'claude' })

    expect(executed).toEqual([])
    expect(launched.dispatch.deferred).toEqual([launched.job.id])
    expect(launched.job.status).toBe('queued')
    expect(launched.session).toBeNull()
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
    expect(created.session).toBeNull()
  })

  it('rejects invalid and missing card identifiers without creating jobs', () => {
    const { db, orchestration } = fixture()

    expect(() => orchestration.createCardJob({ cardId: 0 })).toThrow(/positive integer/)
    expect(() => orchestration.createCardJob({ cardId: 1, expectedBoardId: 0 })).toThrow(/expectedBoardId/)
    expect(() => orchestration.createCardJob({ cardId: 999 })).toThrow(/card not found/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 0 })
  })
})
