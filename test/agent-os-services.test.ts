import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.js'
import { AgentProfileService } from '../src/agent-os/agent-profiles.js'
import { ArtifactStore } from '../src/agent-os/artifact-store.js'
import { AttentionService } from '../src/agent-os/attention.js'
import { CheckpointService } from '../src/agent-os/checkpoints.js'
import { ConversationService } from '../src/agent-os/conversations.js'
import { EvidenceService } from '../src/agent-os/evidence.js'
import { EventStore } from '../src/agent-os/event-store.js'
import { evaluatePolicy, PolicyEngine } from '../src/agent-os/policy-engine.js'
import { Job, JobExecutor, JobScheduler } from '../src/agent-os/scheduler.js'
import { TaskContractService } from '../src/agent-os/task-contracts.js'
import { WorkspaceStore } from '../src/agent-os/workspace-store.js'

afterEach(() => { delete process.env.ORCHESTRA_MAX_LAUNCHED })

function fixture() {
  const db = openDb(':memory:')
  const boardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/repo', 'repo')").run().lastInsertRowid)
  const otherBoardId = Number(db.prepare("INSERT INTO boards (project_path, name) VALUES ('/other', 'other')").run().lastInsertRowid)
  const cardId = Number(db.prepare(`INSERT INTO cards (board_id, title, description, paths)
    VALUES (?, 'Build kernel', 'Durable services', '["src/**"]')`).run(boardId).lastInsertRowid)
  const dependencyId = Number(db.prepare(`INSERT INTO cards (board_id, title, paths) VALUES (?, 'Prerequisite', '["test/**"]')`)
    .run(boardId).lastInsertRowid)
  const foreignCardId = Number(db.prepare(`INSERT INTO cards (board_id, title) VALUES (?, 'Foreign')`).run(otherBoardId).lastInsertRowid)
  return { db, boardId, otherBoardId, cardId, dependencyId, foreignCardId }
}

describe('Agent OS core services', () => {
  it('stores artifacts durably, defaults task contracts deterministically, and isolates references', () => {
    const { db, boardId, cardId, dependencyId, foreignCardId } = fixture()
    const events = new EventStore(db)
    const workspaces = new WorkspaceStore(db)
    const workspace = workspaces.create({ boardId, cardId, name: 'kernel', rootPath: '/repo' })
    const contracts = new TaskContractService(db, events)
    const initial = contracts.getOrCreate(cardId)
    expect(initial.objective).toBe('Durable services')
    expect(initial.base_ref).toBe('HEAD')
    expect(initial.workspace_id).toBe(workspace.id)
    expect(contracts.getOrCreate(cardId)).toEqual(initial)
    expect(() => contracts.put(cardId, { dependencies: [foreignCardId] })).toThrow(/same board/)

    const updated = contracts.put(cardId, { acceptance_criteria: [{ text: 'persists', required: true }],
      dependencies: [dependencyId], verify_commands: ['npm test'], priority: 7, budget_tokens: 1000 })
    expect(updated.dependencies).toEqual([dependencyId])
    expect(updated.verify_commands).toEqual(['npm test'])
    expect(() => contracts.put(dependencyId, { dependencies: [cardId] })).toThrow(/cycle/)

    const artifacts = new ArtifactStore(db)
    const artifact = artifacts.create({ boardId, workspaceId: workspace.id, cardId, kind: 'patch', name: 'change.patch', content: 'patch' })
    workspaces.archive(workspace.id)
    expect(artifacts.get(artifact.id)?.content).toBe('patch')
    expect(events.listBoard(boardId).some((event) => event.kind === 'task_contract.updated')).toBe(true)
  })

  it('evaluates allow, deny, ask, and human-terminal policy outcomes', () => {
    const { db, boardId } = fixture()
    const engine = new PolicyEngine(db)
    const policy = engine.create({ boardId, name: 'safe', fileGlobs: ['src/**', '!src/secrets/**'],
      commandGlobs: ['npm test'], networkHosts: ['*.example.com'], secretNames: ['PUBLIC_*'] })
    expect(evaluatePolicy(db, policy.id, { kind: 'filesystem', value: './src/index.ts' }).decision).toBe('allow')
    expect(engine.evaluate(policy.id, { kind: 'filesystem', value: 'src/secrets/key.txt' }).decision).toBe('deny')
    expect(engine.evaluate(policy.id, { kind: 'network', value: 'https://api.example.com:443/path' }).decision).toBe('allow')
    expect(engine.evaluate(policy.id, { kind: 'secret', value: 'DATABASE_URL' }).decision).toBe('ask')
    expect(engine.evaluate(policy.id, { kind: 'command', value: 'rm -rf build', actor: 'human' }).decision).toBe('allow')
    expect(() => engine.create({ boardId, name: 'invalid', approvalScope: 'forever' })).toThrow(/advisory, ask, allow, or deny/)
  })

  it('orders attention by severity and resolves idempotently', () => {
    const { db, boardId } = fixture()
    const attention = new AttentionService(db)
    attention.create({ boardId, kind: 'low', severity: 'low', title: 'Later' })
    const urgent = attention.create({ boardId, kind: 'critical', severity: 'critical', title: 'Now' })
    expect(attention.listBoard(boardId).map((item) => item.title)).toEqual(['Now', 'Later'])
    expect(attention.resolve(urgent.id).status).toBe('resolved')
    expect(attention.resolve(urgent.id).status).toBe('resolved')
    expect(attention.listBoard(boardId, 'all')).toHaveLength(2)
    expect(attention.listBoard(boardId, 'resolved').map((item) => item.id)).toEqual([urgent.id])
    expect(() => attention.listBoard(boardId, 'unknown')).toThrow(/open, resolved, or all/)
  })

  it('requires a safe runtime for checkpoint forks and records mock-runtime forks as worktrees', async () => {
    const { db, boardId, cardId } = fixture()
    const workspace = new WorkspaceStore(db).create({ boardId, cardId, name: 'source', rootPath: '/repo' })
    const artifact = new ArtifactStore(db).create({ boardId, workspaceId: workspace.id, cardId,
      kind: 'patch', name: 'dirty.patch', content: 'diff' })
    const bare = new CheckpointService(db)
    const checkpoint = bare.create({ workspaceId: workspace.id, name: 'before refactor', gitHead: 'abc123', patchArtifactId: artifact.id })
    await expect(bare.fork(checkpoint.id, { name: 'fork' })).rejects.toThrow(/runtime/)

    const service = new CheckpointService(db, async (_checkpoint, request) => ({
      name: request.name, kind: 'worktree', rootPath: '/repo', worktreePath: '/repo-fork', branch: 'checkpoint-fork', status: 'active',
    }))
    const fork = await service.fork(checkpoint.id, { name: 'safe fork' })
    expect(fork).toMatchObject({ kind: 'worktree', worktree_path: '/repo-fork', status: 'active' })
  })

  it('schedules by priority, honors dependencies and global capacity, and keeps unsupported providers queued', async () => {
    process.env.ORCHESTRA_MAX_LAUNCHED = '1'
    const { db, boardId, cardId, dependencyId } = fixture()
    new TaskContractService(db).put(cardId, { dependencies: [dependencyId] })
    const executed: string[] = []
    const executor: JobExecutor = {
      supportedProviders: () => ['shell'],
      execute: async (job: Job) => { executed.push(job.id); return { status: 'running' } },
    }
    const scheduler = new JobScheduler(db, executor)
    const waiting = scheduler.create({ boardId, cardId, provider: 'shell', priority: 100 })
    const high = scheduler.create({ boardId, provider: 'shell', priority: 10 })
    const low = scheduler.create({ boardId, provider: 'shell', priority: 1 })
    await scheduler.tick()
    expect(executed).toEqual([high.id])
    expect(scheduler.get(waiting.id)?.status).toBe('queued')
    expect(scheduler.get(low.id)?.status).toBe('queued')

    scheduler.complete(high.id)
    db.prepare("UPDATE cards SET column_name='done' WHERE id=?").run(dependencyId)
    await scheduler.tick()
    expect(executed).toEqual([high.id, waiting.id])
    scheduler.complete(waiting.id)
    await scheduler.tick()
    expect(executed).toEqual([high.id, waiting.id, low.id])

    const unsupported = scheduler.create({ boardId, provider: 'future-provider' })
    scheduler.complete(low.id)
    await scheduler.tick()
    expect(scheduler.get(unsupported.id)).toMatchObject({ status: 'queued' })
    expect(scheduler.get(unsupported.id)?.error).toMatch(/unavailable/)
    expect(new AttentionService(db).listBoard(boardId).some((item) => item.kind === 'job.unsupported_provider')).toBe(true)
  })

  it('requeues asynchronous driver failures until the durable retry budget is exhausted', async () => {
    const { db, boardId } = fixture()
    const executor: JobExecutor = {
      supportedProviders: () => ['shell'],
      execute: async () => ({ status: 'running' }),
    }
    const scheduler = new JobScheduler(db, executor)
    const job = scheduler.create({ boardId, provider: 'shell', maxAttempts: 2 })

    await scheduler.tick()
    expect(scheduler.complete(job.id, 'first failure')).toMatchObject({ status: 'queued', attempts: 1 })
    expect(new AttentionService(db).listBoard(boardId)).toHaveLength(0)

    await scheduler.tick()
    expect(scheduler.complete(job.id, 'second failure')).toMatchObject({ status: 'blocked', attempts: 2 })
    expect(new AttentionService(db).listBoard(boardId).map((item) => item.kind)).toContain('job.blocked')
    expect(new EventStore(db).listBoard(boardId).map((event) => event.kind))
      .toEqual(expect.arrayContaining(['job.retry_queued', 'job.blocked']))
  })

  it('shares global launch capacity with legacy Conductor card launches', async () => {
    process.env.ORCHESTRA_MAX_LAUNCHED = '1'
    const { db, boardId, cardId } = fixture()
    const agentId = Number(db.prepare(`INSERT INTO agents (board_id, name, kind, status)
      VALUES (?, 'legacy-agent', 'hired', 'active')`).run(boardId).lastInsertRowid)
    db.prepare("UPDATE cards SET owner_agent_id=?, column_name='in_progress' WHERE id=?").run(agentId, cardId)
    const executed: string[] = []
    const executor: JobExecutor = {
      supportedProviders: () => ['shell'],
      execute: async (job) => { executed.push(job.id); return { status: 'running' } },
    }
    const scheduler = new JobScheduler(db, executor)
    const queued = scheduler.create({ boardId, provider: 'shell' })

    expect((await scheduler.tick()).started).toEqual([])
    expect(scheduler.get(queued.id)?.status).toBe('queued')
    expect(executed).toEqual([])
  })

  it('atomically shares launch capacity across scheduler instances', async () => {
    process.env.ORCHESTRA_MAX_LAUNCHED = '1'
    const { db, boardId } = fixture()
    const executed: string[] = []
    const executor: JobExecutor = {
      supportedProviders: () => ['shell'],
      execute: async (job) => { executed.push(job.id); return { status: 'running' } },
    }
    const first = new JobScheduler(db, executor)
    const second = new JobScheduler(db, executor)
    const high = first.create({ boardId, provider: 'shell', priority: 2 })
    const low = second.create({ boardId, provider: 'shell', priority: 1 })

    await Promise.all([first.tick(), second.tick()])

    expect(executed).toEqual([high.id])
    expect(first.get(high.id)?.status).toBe('running')
    expect(second.get(low.id)?.status).toBe('queued')
  })

  it('prevents duplicate active card jobs and makes cancellation win completion races', async () => {
    const { db, boardId, cardId } = fixture()
    let statusObservedByCancel: string | undefined
    let scheduler!: JobScheduler
    const executor: JobExecutor = {
      supportedProviders: () => ['shell'],
      execute: async () => ({ status: 'running' }),
      cancel: async (job) => { statusObservedByCancel = scheduler.get(job.id)?.status },
    }
    scheduler = new JobScheduler(db, executor)
    const job = scheduler.create({ boardId, cardId, provider: 'shell' })
    expect(() => scheduler.create({ boardId, cardId, provider: 'shell' })).toThrow(/active job/)
    await scheduler.tick()

    const cancelled = await scheduler.cancel(job.id)

    expect(statusObservedByCancel).toBe('cancelling')
    expect(cancelled.status).toBe('cancelled')
    expect(db.prepare(`SELECT kind FROM os_events WHERE job_id=? AND kind IN ('job.cancelling','job.cancelled')
      ORDER BY rowid`).all(job.id)).toEqual([{ kind: 'job.cancelling' }, { kind: 'job.cancelled' }])
    expect(() => scheduler.complete(job.id)).toThrow(/only a running job/)
  })

  it('records durable usage and blocks retries once their budget is exhausted', async () => {
    const { db, boardId } = fixture()
    const executed: string[] = []
    const executor: JobExecutor = {
      supportedProviders: () => ['shell'],
      execute: async (job) => { executed.push(job.id); return { status: 'running' } },
    }
    const scheduler = new JobScheduler(db, executor)
    const job = scheduler.create({ boardId, provider: 'shell', maxAttempts: 2, budgetTokens: 10 })

    await scheduler.tick()
    expect(scheduler.recordUsage(job.id, 10, 0).spent_tokens).toBe(10)
    expect(scheduler.complete(job.id, 'retry me').status).toBe('queued')
    await scheduler.tick()

    expect(executed).toEqual([job.id])
    expect(scheduler.get(job.id)).toMatchObject({ status: 'blocked', error: 'job budget is exhausted before launch' })
  })

  it('assembles evidence from records while keeping agent claims explicitly separate', () => {
    const { db, boardId, cardId } = fixture()
    const workspace = new WorkspaceStore(db).create({ boardId, cardId, name: 'delivery', rootPath: '/repo' })
    new TaskContractService(db).put(cardId, { workspace_id: workspace.id, verify_commands: ['npm test'] })
    const artifacts = new ArtifactStore(db)
    artifacts.create({ boardId, workspaceId: workspace.id, cardId, kind: 'diff', name: 'delivery.diff',
      content: 'diff --git a/src/core.ts b/src/core.ts\n--- a/src/core.ts\n+++ b/src/core.ts', metadata: { changed_files: ['src/core.ts'] } })
    artifacts.create({ boardId, workspaceId: workspace.id, cardId, kind: 'test_report', name: 'vitest.json',
      mimeType: 'application/json', content: '{"passed":true}' })
    artifacts.create({ boardId, workspaceId: workspace.id, cardId, kind: 'provider_event', name: 'raw-provider-event.json',
      mimeType: 'application/json', content: '{"credential":"provider-secret-sentinel"}' })
    const events = new EventStore(db)
    events.append({ boardId, workspaceId: workspace.id, cardId, kind: 'agent.claim', source: 'agent', payload: { claim: 'all tests pass' } })
    events.append({ boardId, workspaceId: workspace.id, cardId, kind: 'verification.completed', source: 'verifier', payload: { passed: true } })
    db.prepare("INSERT INTO review_decisions (board_id, card_id, decision, note) VALUES (?, ?, 'approve', 'lgtm')").run(boardId, cardId)
    db.prepare("INSERT INTO card_events (card_id, type, payload) VALUES (?, 'shipped', '{\"hash\":\"abc123\"}')").run(cardId)

    const service = new EvidenceService(db)
    const bundle = service.assemble(cardId)
    expect(bundle.changed_files).toEqual(['src/core.ts'])
    expect(bundle.claims).toEqual([expect.objectContaining({ claim: 'all tests pass' })])
    expect(bundle.verification.events).toHaveLength(1)
    expect(bundle.artifacts.some((artifact) => artifact.kind === 'provider_event')).toBe(false)
    expect(JSON.stringify(bundle)).not.toContain('provider-secret-sentinel')
    expect(bundle.delivery).toEqual({ current: null, history: [] })
    expect(bundle.gaps).toEqual(['No canonical delivery report has been recorded.'])
    const persisted = service.persist(cardId)
    expect(persisted.artifact.kind).toBe('evidence_bundle')
    expect(persisted.artifact.content).not.toContain('provider-secret-sentinel')
  })

  it('excludes every conversation raw artifact before applying the evidence limit', () => {
    const { db, boardId, cardId } = fixture()
    const workspace = new WorkspaceStore(db).create({
      boardId,
      cardId,
      name: 'raw-evidence-boundary',
      rootPath: '/repo',
    })
    const artifacts = new ArtifactStore(db)
    const diff = artifacts.create({
      boardId,
      workspaceId: workspace.id,
      cardId,
      kind: 'diff',
      name: 'delivery.diff',
      content: 'diff --git a/src/safe.ts b/src/safe.ts',
    })
    const canonicalRaw = artifacts.create({
      boardId,
      workspaceId: workspace.id,
      cardId,
      kind: 'provider_raw_event',
      name: 'canonical-raw.json',
      content: '{"credential":"canonical-raw-sentinel"}',
    })
    const conflictRaw = artifacts.create({
      boardId,
      workspaceId: workspace.id,
      cardId,
      kind: 'provider_conflict_blob',
      name: 'conflict-raw.json',
      content: '{"credential":"conflict-raw-sentinel"}',
    })
    const unreferenced = artifacts.create({
      boardId,
      workspaceId: workspace.id,
      cardId,
      kind: 'provider_raw_event',
      name: 'ordinary-unreferenced.json',
      content: '{"result":"ordinary-unreferenced-sentinel"}',
    })
    const actor = { type: 'human' as const, id: 'evidence-security-test' }
    const profile = new AgentProfileService(db).create({
      boardId,
      name: 'Evidence security',
      defaultProvider: 'codex',
      actor,
      idempotencyKey: 'evidence-security-profile',
    })
    const conversations = new ConversationService(db)
    const conversation = conversations.listConversations(profile.id)[0]
    const sessionId = 'evidence-security-session'
    db.prepare(`INSERT INTO agent_sessions (
      id, workspace_id, provider, external_id, status, context_json
    ) VALUES (?, ?, 'codex', 'evidence-security-thread', 'running', '{}')`)
      .run(sessionId, workspace.id)
    conversations.linkSession(sessionId, {
      profileId: profile.id,
      conversationId: conversation.id,
      mode: 'managed',
      actor,
      idempotencyKey: 'evidence-security-link',
    })
    conversations.appendEvent(sessionId, {
      kind: 'assistant',
      actor,
      projectedText: 'safe canonical text',
      rawArtifactId: canonicalRaw.id,
      dedupeKey: 'provider-event-1',
      idempotencyKey: 'evidence-security-event-1',
    })
    expect(() => conversations.appendEvent(sessionId, {
      kind: 'assistant',
      actor,
      projectedText: 'different safe text',
      rawArtifactId: conflictRaw.id,
      dedupeKey: 'provider-event-1',
      idempotencyKey: 'evidence-security-event-conflict',
    })).toThrow(/conflicts with an existing dedupe key/)
    for (let index = 0; index < 201; index += 1) {
      artifacts.create({
        boardId,
        workspaceId: workspace.id,
        cardId,
        kind: 'provider_event',
        name: `excluded-provider-event-${index}.json`,
        content: `{"secret":"excluded-provider-sentinel-${index}"}`,
      })
    }

    const evidence = new EvidenceService(db).assemble(cardId)
    expect(evidence.diff?.artifact_id).toBe(diff.id)
    expect(evidence.artifacts).toContainEqual(expect.objectContaining({ id: unreferenced.id }))
    expect(evidence.artifacts).not.toContainEqual(expect.objectContaining({ id: canonicalRaw.id }))
    expect(evidence.artifacts).not.toContainEqual(expect.objectContaining({ id: conflictRaw.id }))
    expect(evidence.artifacts).not.toContainEqual(expect.objectContaining({ kind: 'provider_event' }))
    const serialized = JSON.stringify(evidence)
    expect(serialized).toContain('ordinary-unreferenced-sentinel')
    expect(serialized).not.toContain('canonical-raw-sentinel')
    expect(serialized).not.toContain('conflict-raw-sentinel')
    expect(serialized).not.toContain('excluded-provider-sentinel')
  })
})
